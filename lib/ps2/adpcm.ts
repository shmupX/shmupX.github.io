// SPU2 ADPCM and WAV encoding for the PS2 export.
//
// AthenaEnv plays sound effects through audsrv, which wants ps2sdk's `.adp`
// container: a 16-byte "APCM" header followed by 16-byte SPU2 ADPCM blocks of
// 28 samples each. This is a port of ps2sdk `tools/adpenc` — specifically of
// the working Python port in the sibling shmup-party-ps2 repo
// (scripts/prep-assets.py), whose output already plays on real hardware. It is
// deliberately a transliteration, quirks included, because the quirks are what
// make the output byte-identical to the encoder that is known to work:
//
//   * find_predict() carries `s_1`/`s_2` across blocks as C statics, and
//     stores whichever pair the LAST executed predictor iteration left behind
//     (including on the early `mn <= 7` break).
//   * pack() masks with 0x80000000 on a SIGNED 32-bit int and shifts
//     arithmetically. JS bitwise operators are 32-bit signed, so `&` and `>>`
//     reproduce it directly — `>>>` would not.
//
// The `.wav` twin is the canonical 44-byte-header mono s16 layout: AthenaEnv's
// Sound.Stream seeks past a fixed-size header, so a LIST/metadata chunk would
// be read as audio.

/** Samples per SPU2 ADPCM block. The whole loop-alignment story follows from this. */
export const ADPCM_BLOCK_SAMPLES = 28;

/** Bytes per encoded block: 1 predictor/shift byte, 1 flags byte, 14 of nibbles. */
export const ADPCM_BLOCK_BYTES = 16;

/**
 * Peak the encoder can represent. adpenc clamps its input to [-30720, 30719]
 * inside find_predict — the SPU's own headroom — so anything hotter is hard
 * clipped, and the clipping wrecks the predictor for the rest of the block.
 * The reference never noticed because its sources were mp3s well under full
 * scale; the Saturn tone bank has samples that touch -32768, and on the worst
 * of them clipping costs 20 dB of SNR.
 */
export const SPU_HEADROOM = 30719;

/**
 * Scale PCM down, and only down, so it fits the encoder's headroom. The
 * factor is never below 0.937, i.e. at most 0.6 dB — inaudible, and it
 * preserves the bank's relative levels because it only touches the few
 * samples that would otherwise clip.
 */
export function fitToHeadroom(
  pcm: Int16Array,
): { pcm: Int16Array; scale: number } {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak <= SPU_HEADROOM) return { pcm, scale: 1 };
  const scale = SPU_HEADROOM / peak;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.round(pcm[i] * scale);
  return { pcm: out, scale };
}

// SPU2 filter predictors, (0,0),(60,0),(115,-52),(98,-55),(122,-60) over 64,
// negated the way adpenc applies them.
const SPU_F: readonly (readonly [number, number])[] = [
  [0, 0],
  [-60 / 64, 0],
  [-115 / 64, 52 / 64],
  [-98 / 64, 55 / 64],
  [-122 / 64, 60 / 64],
];

interface EncoderState {
  fs1: number;
  fs2: number;
  ps1: number;
  ps2: number;
}

/** adpenc find_predict(): smallest peak residual over the block, then the shift. */
function findPredict(
  block: Int16Array | number[],
  state: EncoderState,
): { predictNr: number; shiftFactor: number; residuals: Float64Array } {
  const buf: Float64Array[] = [];
  for (let i = 0; i < 5; i++) buf.push(new Float64Array(ADPCM_BLOCK_SAMPLES));
  const mx = new Float64Array(5);
  let mn = 1e10;
  let predictNr = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < 5; i++) {
    s1 = state.fs1;
    s2 = state.fs2;
    for (let j = 0; j < ADPCM_BLOCK_SAMPLES; j++) {
      const s0 = Math.min(30719, Math.max(-30720, block[j]));
      const ds = s0 + s1 * SPU_F[i][0] + s2 * SPU_F[i][1];
      buf[i][j] = ds;
      if (Math.abs(ds) > mx[i]) mx[i] = Math.abs(ds);
      s2 = s1;
      s1 = s0;
    }
    if (mx[i] < mn) {
      mn = mx[i];
      predictNr = i;
    }
    if (mn <= 7) {
      predictNr = 0;
      break;
    }
  }
  state.fs1 = s1;
  state.fs2 = s2;

  const min2 = Math.trunc(mn);
  let shiftMask = 0x4000;
  let shiftFactor = 0;
  while (shiftFactor < 12) {
    if (shiftMask & (min2 + (shiftMask >> 3))) break;
    shiftFactor++;
    shiftMask >>= 1;
  }
  return { predictNr, shiftFactor, residuals: buf[predictNr] };
}

/** adpenc pack(): quantize to 4 bits with IIR feedback of the quantization error. */
function pack(
  residuals: Float64Array,
  predictNr: number,
  shiftFactor: number,
  state: EncoderState,
): Int32Array {
  let s1 = state.ps1;
  let s2 = state.ps2;
  const out = new Int32Array(ADPCM_BLOCK_SAMPLES);
  for (let i = 0; i < ADPCM_BLOCK_SAMPLES; i++) {
    const s0 = residuals[i] + s1 * SPU_F[predictNr][0] +
      s2 * SPU_F[predictNr][1];
    const ds = s0 * (1 << shiftFactor);
    // 32-bit signed truncate-and-round, exactly as the C does it.
    let di = (Math.trunc(ds) + 0x800) & 0xfffff000;
    di = Math.min(32767, Math.max(-32768, di));
    out[i] = di;
    const shifted = di >> shiftFactor; // arithmetic, like the C original
    s2 = s1;
    s1 = shifted - s0;
  }
  state.ps1 = s1;
  state.ps2 = s2;
  return out;
}

export interface AdpOptions {
  /** Sample rate of the PCM. Stored as `pitch = rate * 4096 / 48000`. */
  rate: number;
  /** Set the container's loop flag and mark the loop region in the blocks. */
  loop?: boolean;
  /**
   * First sample of the loop. Must be a multiple of ADPCM_BLOCK_SAMPLES —
   * run the PCM through `alignLoopForAdpcm()` first.
   */
  loopStartSample?: number;
}

// SPU ADPCM block flag bits.
const FLAG_END = 1;
const FLAG_REPEAT = 2;
const FLAG_LOOP_START = 4;

/** PCM s16 -> audsrv `.adp` bytes. */
export function encodeAdp(pcm: Int16Array, opts: AdpOptions): Uint8Array {
  const n = pcm.length;
  const groups = Math.ceil(n / ADPCM_BLOCK_SAMPLES) || 1;
  const padded = new Int16Array(groups * ADPCM_BLOCK_SAMPLES);
  padded.set(pcm);

  const loop = !!opts.loop;
  const loopBlock = loop
    ? Math.floor((opts.loopStartSample ?? 0) / ADPCM_BLOCK_SAMPLES)
    : -1;

  const out = new Uint8Array(16 + (groups + 1) * ADPCM_BLOCK_BYTES);
  const view = new DataView(out.buffer);
  out.set([0x41, 0x50, 0x43, 0x4d], 0); // "APCM"
  out[4] = 1; // version
  out[5] = 1; // channels
  out[6] = loop ? 1 : 0;
  out[7] = 0; // reserved
  view.setUint32(8, Math.floor(opts.rate * 4096 / 48000), true);
  view.setUint32(12, n, true);

  const state: EncoderState = { fs1: 0, fs2: 0, ps1: 0, ps2: 0 };
  let predictNr = 0;
  let shiftFactor = 0;
  let partialFlag = 0;
  let remaining = n;
  let at = 16;

  for (let j = 0; j < groups; j++) {
    const block = padded.subarray(
      j * ADPCM_BLOCK_SAMPLES,
      (j + 1) * ADPCM_BLOCK_SAMPLES,
    );
    const found = findPredict(block, state);
    predictNr = found.predictNr;
    shiftFactor = found.shiftFactor;
    const fourBit = pack(found.residuals, predictNr, shiftFactor, state);

    let flags = partialFlag;
    if (loop) {
      // The block that holds loopStart records the loop address; the last
      // data block ends the run and jumps back to it.
      if (j === loopBlock) flags |= FLAG_LOOP_START;
      if (j === groups - 1) flags |= FLAG_END | FLAG_REPEAT;
    }

    out[at++] = (predictNr << 4) | shiftFactor;
    out[at++] = flags;
    for (let k = 0; k < ADPCM_BLOCK_SAMPLES; k += 2) {
      out[at++] = ((fourBit[k + 1] >> 8) & 0xf0) | ((fourBit[k] >> 12) & 0x0f);
    }
    remaining -= ADPCM_BLOCK_SAMPLES;
    if (remaining < ADPCM_BLOCK_SAMPLES) partialFlag = FLAG_END;
  }

  // adpenc's terminator: a silent block that stops a one-shot voice. A looping
  // sample never reaches it, but keeping it makes every file the same shape.
  out[at++] = (predictNr << 4) | shiftFactor;
  out[at++] = FLAG_END | FLAG_REPEAT | FLAG_LOOP_START;
  return out;
}

/** PCM s16 -> the canonical 44-byte-header mono WAV AthenaEnv's streamer expects. */
export function encodeWav(pcm: Int16Array, rate: number): Uint8Array {
  const dataSize = pcm.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  out.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  out.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export interface AlignedLoop {
  pcm: Int16Array;
  loopStart: number;
  /** How the loop length was made a multiple of the block size. */
  method: "none" | "repeat" | "truncate";
}

/**
 * Make a tail loop land on ADPCM block boundaries.
 *
 * Every loop in the Dezaemon tone bank runs to the last sample, so alignment
 * is two independent nudges:
 *
 *  1. Prepend up to 27 samples of silence so `loopStart` is a multiple of 28.
 *     At the tone bank's ~14.8 kHz that delays the attack by under 2 ms.
 *  2. Make the loop length a multiple of 28. Repeating the loop
 *     `28 / gcd(loopLen, 28)` times is EXACT and is used whenever the result
 *     stays under `maxRepeatSamples`; otherwise the loop is shortened by up to
 *     27 samples, which on a loop long enough to hit that cap is well under a
 *     cent of pitch error.
 */
export function alignLoopForAdpcm(
  pcm: Int16Array,
  loopStart: number,
  maxRepeatSamples = 4096,
): AlignedLoop {
  const B = ADPCM_BLOCK_SAMPLES;
  const pad = (B - (loopStart % B)) % B;
  const loopLen = pcm.length - loopStart;
  if (loopLen <= 0) {
    return { pcm, loopStart: pcm.length, method: "none" };
  }

  const repeats = B / gcd(loopLen, B);
  if (loopLen * repeats <= maxRepeatSamples) {
    const out = new Int16Array(pad + loopStart + loopLen * repeats);
    out.set(pcm.subarray(0, loopStart), pad);
    for (let r = 0; r < repeats; r++) {
      out.set(pcm.subarray(loopStart), pad + loopStart + r * loopLen);
    }
    return {
      pcm: out,
      loopStart: pad + loopStart,
      method: repeats === 1 ? "none" : "repeat",
    };
  }

  const kept = Math.floor(loopLen / B) * B;
  const out = new Int16Array(pad + loopStart + kept);
  out.set(pcm.subarray(0, loopStart), pad);
  out.set(pcm.subarray(loopStart, loopStart + kept), pad + loopStart);
  return { pcm: out, loopStart: pad + loopStart, method: "truncate" };
}
