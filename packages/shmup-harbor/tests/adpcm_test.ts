// The SPU2 ADPCM encoder the PS2 export writes its audio with.
//
// lib/ps2/adpcm.ts is a transliteration of ps2sdk's tools/adpenc (by way of
// the Python port in the sibling shmup-party-ps2 repo, whose .adp output is
// known to play on real hardware). The golden vector below was produced by
// running that Python over the deterministic all-integer PCM in GOLDEN_PCM;
// if the port ever drifts — a >>> where the C shifts arithmetically, a
// truncation that rounds — these bytes stop matching.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ADPCM_BLOCK_SAMPLES,
  alignLoopForAdpcm,
  decodeAdp,
  encodeAdp,
  encodeWav,
} from "../lib/ps2/adpcm.ts";

// Sawtooth plus LCG dither: structured enough to exercise all five predictors,
// reproducible in any language with 32-bit integer arithmetic.
const GOLDEN_PCM = Int16Array.from([
  -16315,
  -15915,
  -15968,
  -15556,
  -15040,
  -14918,
  -14585,
  -14389,
  -13835,
  -13628,
  -13444,
  -13360,
  -12890,
  -12618,
  -12342,
  -11811,
  -11713,
  -11129,
  -11191,
  -10692,
  -10686,
  -10275,
  -10077,
  -9521,
  -9354,
  -9142,
  -8604,
  -8536,
  -8113,
  -7607,
  -7613,
  -7320,
  -7140,
  -6665,
  -6094,
  -6056,
  -5645,
  -5231,
  -5081,
  -4791,
  -4516,
  -4175,
  -4184,
  -3796,
  -3136,
  -3256,
  -2535,
  -2448,
  -2160,
  -1702,
  -1595,
  -1249,
  -971,
  -899,
  -594,
  -329,
  442,
  527,
  533,
  969,
  1339,
  1850,
  1992,
  2387,
  2317,
  2985,
  3118,
  3550,
  3498,
  4103,
  4115,
  4696,
  4963,
  5180,
  5428,
  5807,
  6340,
  6502,
  6794,
  7217,
  7110,
  7577,
  8023,
  8102,
  8632,
  8535,
  8945,
  9515,
  9706,
  9934,
  10065,
  10701,
  11038,
  10964,
  11355,
  11497,
  12207,
  12195,
  12779,
  13126,
  13439,
  13652,
  13987,
  14319,
  14498,
  14877,
  15223,
  15057,
  15820,
  15946,
  16373,
  -16103,
  -16006,
  -15876,
  -15531,
  -15029,
  -14621,
  -14683,
  -14267,
  -14045,
  -13411,
  -13249,
  -12943,
  -12500,
  -12528,
  -12209,
  -12076,
  -11743,
  -11109,
  -11107,
  -10815,
  -10233,
  -10104,
  -9808,
  -9296,
  -8954,
  -8784,
  -8437,
  -8247,
  -8181,
  -7698,
  -7382,
  -7374,
  -6880,
  -6332,
  -6341,
  -6119,
  -5754,
  -5169,
  -4963,
  -4736,
  -4712,
  -3987,
  -4071,
  -3637,
  -3489,
  -3032,
  -2845,
  -2549,
  -2316,
  -1943,
  -1713,
  -1016,
  -1127,
  -547,
  -173,
  -239,
  150,
  550,
  704,
  1411,
  1237,
  1602,
  1855,
  2330,
  2620,
  3004,
  3086,
  3578,
  4046,
  4244,
  4472,
  4732,
  4993,
  5103,
  5654,
  6073,
  6109,
  6527,
  6599,
  6873,
  7513,
  7600,
  7792,
  8473,
  8565,
  8856,
  9332,
  9373,
  9622,
  10140,
  10482,
  10747,
  11174,
  11233,
  11714,
  11907,
  11880,
  12665,
  12589,
  13136,
  13212,
  13642,
  13678,
  14096,
  14294,
  14782,
  14828,
  15507,
  15902,
  15917,
  16437,
  -16364,
  -16056,
  -15606,
  -15174,
  -15030,
  -14574,
  -14641,
  -14003,
  -13778,
  -13569,
  -13399,
  -12965,
  -12661,
  -12554,
  -12317,
  -11799,
  -11705,
  -11367,
  -10988,
  -10417,
  -10125,
  -10137,
  -9719,
  -9545,
  -8940,
  -8816,
  -8336,
  -8363,
  -7761,
  -7781,
  -7351,
  -6812,
  -6506,
  -6470,
  -6388,
  -5916,
  -5387,
  -5143,
  -4965,
  -4587,
  -4196,
  -4151,
  -3610,
  -3663,
  -2934,
  -2754,
  -2720,
  -2323,
  -2243,
  -1590,
  -1243,
  -1234,
  -580,
  -601,
  -280,
  -117,
  608,
  423,
  1182,
  1031,
  1638,
  1740,
  2028,
  2187,
  2870,
  2983,
  3153,
  3493,
  3697,
  4465,
  4627,
  4867,
  5309,
  5354,
  5611,
  6062,
  6480,
  6389,
]);

const GOLDEN_ADP =
  "4150434d01010000590700002c0100000000ccccccccddddddddddddddeeeeee15000dec0ed2100e001ed404212002222500c44f203e7c2d6e5c1f2102215e01000022222232333333333333444444c41400ddeecedeefeeedeed00efeffffef1500f00cd10ff1e0d3f2021111e5343f2500e1b503f3e2141f1140e1e4431ed6000022223233333333333333444444cc2500d41c3bfc1ede101c1fddd2c3c2c315001fdf0ef20fe1d3042f4f020412f63201011001111121112231215c00000032070000000000000000000000000000";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("encodeAdp matches the ps2sdk adpenc golden byte for byte", () => {
  assertEquals(hex(encodeAdp(GOLDEN_PCM, { rate: 22050 })), GOLDEN_ADP);
});

Deno.test("encodeAdp writes the APCM header audsrv reads", () => {
  const adp = encodeAdp(GOLDEN_PCM, { rate: 44100 });
  const view = new DataView(adp.buffer);
  assertEquals(new TextDecoder().decode(adp.subarray(0, 4)), "APCM");
  assertEquals(adp[4], 1, "version");
  assertEquals(adp[5], 1, "channels");
  assertEquals(adp[6], 0, "loop off");
  assertEquals(view.getUint32(8, true), Math.floor(44100 * 4096 / 48000));
  assertEquals(view.getUint32(12, true), GOLDEN_PCM.length);
  // 300 samples = 11 blocks (the last zero-padded) plus the terminator.
  assertEquals(adp.length, 16 + (11 + 1) * 16);
});

Deno.test("a looping .adp marks the loop region in the block flags", () => {
  const loopStart = 2 * ADPCM_BLOCK_SAMPLES;
  const adp = encodeAdp(GOLDEN_PCM, {
    rate: 44100,
    loop: true,
    loopStartSample: loopStart,
  });
  assertEquals(adp[6], 1, "header loop flag");
  const flagsOf = (block: number) => adp[16 + block * 16 + 1];
  assertEquals(flagsOf(0) & 4, 0, "block 0 is not the loop start");
  assertEquals(flagsOf(2) & 4, 4, "block 2 records the loop address");
  const last = Math.ceil(GOLDEN_PCM.length / ADPCM_BLOCK_SAMPLES) - 1;
  assertEquals(flagsOf(last) & 3, 3, "last data block ends and repeats");
});

// decodeAdp is the SPU2's decoder, so the encoder is checked against what a
// console would actually hear rather than only against itself — and the
// browser build, which plays a build's effects through it, is checked too.

function snrDb(source: Int16Array, decoded: Int16Array): number {
  let err = 0;
  let signal = 0;
  for (let i = 0; i < source.length; i++) {
    const d = decoded[i] - source[i];
    err += d * d;
    signal += source[i] * source[i];
  }
  return 10 * Math.log10(signal / err);
}

Deno.test("encodeAdp round-trips within ADPCM's error budget", () => {
  const decoded = decodeAdp(encodeAdp(GOLDEN_PCM, { rate: 44100 })).pcm;
  assertEquals(decoded.length, GOLDEN_PCM.length);
  const snr = snrDb(GOLDEN_PCM, decoded);
  assert(snr > 20, `4-bit ADPCM should clear 20 dB SNR, got ${snr.toFixed(1)}`);
});

Deno.test("decodeAdp gets a sweep and a tone back out of encodeAdp", () => {
  const rate = 22050;
  // A second of 220 Hz rising to 2 kHz, and a steady 440 Hz: the sweep makes
  // every block pick its predictor afresh, the tone lets the filters settle.
  const sweep = Int16Array.from({ length: rate }, (_, i) =>
    Math.round(
      12000 * Math.sin(2 * Math.PI * (220 + 1800 * i / rate) * i / rate),
    ));
  const tone = Int16Array.from(
    { length: 5000 },
    (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / rate)),
  );

  const decoded = decodeAdp(encodeAdp(sweep, { rate }));
  assertEquals(decoded.pcm.length, sweep.length, "padding left out");
  // The header stores floor(rate * 4096 / 48000); that is what plays.
  assertEquals(decoded.rate, Math.floor(rate * 4096 / 48000) * 48000 / 4096);
  assert(Math.abs(decoded.rate - rate) < 10);
  assertEquals(decoded.loop, false);
  assertEquals(decoded.loopStartSample, 0);
  // A sign slip or a nibble-order swap is noise, far under these.
  const sweepSnr = snrDb(sweep, decoded.pcm);
  assert(sweepSnr > 28, `sweep came back at ${sweepSnr.toFixed(1)} dB`);
  const toneSnr = snrDb(tone, decodeAdp(encodeAdp(tone, { rate })).pcm);
  assert(toneSnr > 38, `tone came back at ${toneSnr.toFixed(1)} dB`);
});

Deno.test("decodeAdp reads the loop back from a looping .adp", () => {
  const tone = Int16Array.from(
    { length: 4999 },
    (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / 22050)),
  );
  const aligned = alignLoopForAdpcm(tone, 61);
  const decoded = decodeAdp(
    encodeAdp(aligned.pcm, {
      rate: 22050,
      loop: true,
      loopStartSample: aligned.loopStart,
    }),
  );
  assertEquals(decoded.loop, true);
  assertEquals(decoded.loopStartSample, aligned.loopStart);
  assertEquals(decoded.pcm.length, aligned.pcm.length);
});

Deno.test("decodeAdp turns silence into silence and refuses what is not an .adp", () => {
  const silent = decodeAdp(encodeAdp(new Int16Array(100), { rate: 22050 }));
  assertEquals(silent.pcm.length, 100);
  assert(silent.pcm.every((s) => s === 0));
  assertThrows(() => decodeAdp(encodeWav(GOLDEN_PCM, 22050)), Error, "APCM");
  const stereo = encodeAdp(GOLDEN_PCM, { rate: 22050 });
  stereo[5] = 2;
  assertThrows(() => decodeAdp(stereo), Error, "only mono");
});

Deno.test("alignLoopForAdpcm repeats short loops exactly", () => {
  // 39 samples is the shortest loop in the tone bank; gcd(39, 28) = 1, so it
  // takes 28 repeats to land on a block boundary.
  const pcm = Int16Array.from({ length: 100 }, (_, i) => i * 100 - 5000);
  const a = alignLoopForAdpcm(pcm, 61);
  assertEquals(a.method, "repeat");
  assertEquals(a.loopStart % ADPCM_BLOCK_SAMPLES, 0);
  assertEquals((a.pcm.length - a.loopStart) % ADPCM_BLOCK_SAMPLES, 0);
  assertEquals(a.pcm.length - a.loopStart, 39 * 28);
  // The prepended silence is the only thing before the original attack.
  const pad = a.loopStart - 61;
  assert(pad < ADPCM_BLOCK_SAMPLES);
  for (let i = 0; i < pad; i++) assertEquals(a.pcm[i], 0);
  assertEquals(a.pcm[pad], pcm[0]);
});

Deno.test("alignLoopForAdpcm truncates loops too long to repeat", () => {
  const pcm = Int16Array.from({ length: 9000 }, (_, i) => (i % 200) - 100);
  const a = alignLoopForAdpcm(pcm, 101);
  assertEquals(a.method, "truncate");
  assertEquals(a.loopStart % ADPCM_BLOCK_SAMPLES, 0);
  assertEquals((a.pcm.length - a.loopStart) % ADPCM_BLOCK_SAMPLES, 0);
  // At most one block's worth of the loop is dropped.
  assert(9000 - 101 - (a.pcm.length - a.loopStart) < ADPCM_BLOCK_SAMPLES);
});

Deno.test("encodeWav emits the canonical 44-byte header", () => {
  const wav = encodeWav(GOLDEN_PCM, 44100);
  const view = new DataView(wav.buffer);
  const tag = (at: number) =>
    new TextDecoder().decode(wav.subarray(at, at + 4));
  assertEquals(tag(0), "RIFF");
  assertEquals(view.getUint32(4, true), wav.length - 8);
  assertEquals(tag(8), "WAVE");
  assertEquals(tag(12), "fmt ");
  assertEquals(view.getUint32(16, true), 16);
  assertEquals(view.getUint16(20, true), 1, "PCM");
  assertEquals(view.getUint16(22, true), 1, "mono");
  assertEquals(view.getUint32(24, true), 44100);
  assertEquals(view.getUint16(34, true), 16, "bit depth");
  // Sound.Stream seeks a fixed 44 bytes: the data chunk must start at 36.
  assertEquals(tag(36), "data");
  assertEquals(view.getUint32(40, true), GOLDEN_PCM.length * 2);
  assertEquals(wav.length, 44 + GOLDEN_PCM.length * 2);
});
