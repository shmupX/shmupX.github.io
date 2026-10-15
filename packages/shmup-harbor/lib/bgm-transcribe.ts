// lib/bgm-transcribe.ts — an MP3 heard as a Dezaemon 2 tone-bank song.
//
// ffmpeg decodes the file to mono 22.05 kHz floats; a self-written radix-2
// STFT listens; what comes out is note events for the engine's encodeDezaSong
// (packages/shmup-engine/src/audio/song-write.js), which says them in the
// cart's words. This file decides WHAT the four parts play and nothing about
// the bytes.
//
// The pipeline, each stage its own export so it can be tested alone:
//
//   decodeAudio       ffmpeg → Float32Array, normalised by the global peak (a
//                     hot master decodes above 1.0; thresholds need a scale)
//   analyseOnsets     Hann N=1024 / hop 256 (86 fps): log-compressed spectral
//                     flux, half-wave rectified, in three bands — the whole
//                     spectrum, 40–150 Hz (kick) and > 2 kHz (snare, hat)
//   estimateTempoPath per-window autocorrelation of the short-window flux only
//                     (the long window aliases 3:2), a log-Gaussian prior
//                     around 120 BPM, a comb over the lag's multiples, Viterbi
//                     across windows so only section boundaries jump, an
//                     octave tie-break read off the onsets, and a boundary
//                     refinement to the second
//   trackBeats        dynamic-programming beat tracking (Ellis) against the
//                     local period
//   buildStepGrid     sixteenths by interpolation between beats, extrapolated
//                     over the intro and the tail so no audio is lost
//   analysePitches    Hann N=4096 / hop 512, reduced PER STEP as the frames
//                     stream past (the whole spectrogram would be 428 MB):
//                     spectral whitening, parabolic peaks, harmonic-sum
//                     salience over the 59 pitches the cart can play, up to
//                     three voices per step by iterative subtraction
//   detectDrums       band flux peaks snapped to step starts → kick / snare /
//                     hat, one per step
//   assignParts       part 0 lead, 1 bass, 2 pad, 3 drums — four monophonic
//                     lines of cells, ties where a pitch continues without an
//                     onset, quiet notes dropped (the only dynamics the format
//                     has: there is no velocity)
//   planSlots         consecutive 512-step slots, each at its own tempo index,
//                     cut short where the tracked tempo changes so one slot
//                     never plays two tempi at one speed
//   encodeSlots       cells → events → bytes, through the engine
//   renderSlots / verifyTranscription
//                     an offline render from the bank's harmonic profiles, a
//                     per-beat chroma cosine against the source and an onset
//                     F-measure, so the output is judged, not assumed
//
// A slot's steps are the TRACKED sixteenths, not a fixed grid laid over the
// audio: step k of a slot holds what the source played in its k-th sixteenth
// after the slot's first beat, and the slot plays at the tempo index nearest
// the median step length. The rhythm survives intact; the playback runs a
// percent or two faster or slower than the record, which nobody hears.

import {
  bpmOfTempoIndex,
  buildDezaemonBgm,
  cellsToEvents,
  encodeDezaSong,
  foldMidiToPitch,
  SONG_STEPS,
  stepSecondsOf,
  tempoIndexForStepSeconds,
} from "@shmupx/shmup-engine";
import { join } from "@std/path";
import { repoRoot } from "./repo-root.ts";

// ── Audio in ────────────────────────────────────────────────────────────────

export interface DecodedAudio {
  /** Mono samples scaled so the loudest one is ±1. */
  samples: Float32Array;
  sampleRate: number;
  /** The decoder's own peak before scaling (a hot master is above 1). */
  peak: number;
  /** Seconds. */
  duration: number;
}

export interface DecodeOptions {
  /** The ffmpeg binary; default $FFMPEG, else Homebrew's, else the PATH's. */
  ffmpeg?: string;
  sampleRate?: number;
}

const HOMEBREW_FFMPEG = "/opt/homebrew/bin/ffmpeg";

/** The ffmpeg this machine has. */
export function ffmpegPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = Deno.env.get("FFMPEG");
  if (env) return env;
  try {
    if (Deno.statSync(HOMEBREW_FFMPEG).isFile) return HOMEBREW_FFMPEG;
  } catch {
    // not a Homebrew machine
  }
  return "ffmpeg";
}

/**
 * Decode a file or an http(s) URL — ffmpeg reads both — to normalised mono
 * floats. Nothing of the file is kept in the repo; a URL streams straight
 * through ffmpeg's own HTTP input.
 */
export async function decodeAudio(
  input: string,
  opts: DecodeOptions = {},
): Promise<DecodedAudio> {
  const sampleRate = opts.sampleRate ?? 22050;
  const ffmpeg = ffmpegPath(opts.ffmpeg);
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(ffmpeg, {
      args: [
        "-v",
        "error",
        "-nostdin",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "f32le",
        "-",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `ffmpeg not found at ${ffmpeg}; install it or pass --ffmpeg / set $FFMPEG`,
      );
    }
    throw e;
  }
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`ffmpeg failed (${out.code}) on ${input}: ${err}`);
  }
  const n = out.stdout.byteLength >> 2;
  const samples = new Float32Array(n);
  new Uint8Array(samples.buffer).set(out.stdout.subarray(0, n * 4));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) samples[i] *= g;
  }
  return { samples, sampleRate, peak, duration: n / sampleRate };
}

// ── FFT ─────────────────────────────────────────────────────────────────────

export type FftFn = (re: Float64Array, im: Float64Array) => void;

/** An in-place radix-2 FFT for one size: twiddles and bit-reversal cached. */
export function makeFft(n: number): FftFn {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new RangeError(`FFT size ${n} is not 2^k`);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k;
          const b = a + half;
          const wr = cos[w];
          const wi = -sin[w];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

/**
 * Frame-by-frame magnitude spectra of a signal. `magnitude(f, out)` fills
 * `out[0..n/2]` with 4|X|/n — a full-scale sine reads as 1 — so thresholds
 * mean the same thing at every frame size. Frame `f` starts at sample
 * `f·hop`; its centre is `centre(f)` seconds.
 */
export function makeSpectrumReader(
  samples: Float32Array,
  sampleRate: number,
  n: number,
  hop: number,
) {
  const fft = makeFft(n);
  const win = hannWindow(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const frames = samples.length >= n
    ? Math.floor((samples.length - n) / hop) + 1
    : 0;
  const scale = 4 / n;
  return {
    frames,
    bins: n / 2 + 1,
    binHz: sampleRate / n,
    fps: sampleRate / hop,
    centre: (f: number) => (f * hop + n / 2) / sampleRate,
    magnitude(f: number, out: Float64Array) {
      const off = f * hop;
      for (let i = 0; i < n; i++) {
        re[i] = samples[off + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k <= n / 2; k++) {
        out[k] = Math.hypot(re[k], im[k]) * scale;
      }
    },
  };
}

// ── Onsets ──────────────────────────────────────────────────────────────────

export interface OnsetAnalysis {
  /** Frames per second of the flux arrays. */
  fps: number;
  /** Seconds at the centre of frame 0; frame i is at t0 + i/fps. */
  t0: number;
  /** Half-wave rectified log-spectral flux over the whole spectrum. */
  flux: Float32Array;
  /** The same over 40–150 Hz. */
  lowFlux: Float32Array;
  /** The same above 2 kHz. */
  highFlux: Float32Array;
}

export interface OnsetOptions {
  n?: number;
  hop?: number;
  /** log1p(gamma · magnitude) compression. */
  gamma?: number;
  lowBand?: [number, number];
  highFrom?: number;
}

export function analyseOnsets(
  audio: DecodedAudio,
  opts: OnsetOptions = {},
): OnsetAnalysis {
  const n = opts.n ?? 1024;
  const hop = opts.hop ?? 256;
  const gamma = opts.gamma ?? 100;
  const [lowLo, lowHi] = opts.lowBand ?? [40, 150];
  const highFrom = opts.highFrom ?? 2000;
  const reader = makeSpectrumReader(audio.samples, audio.sampleRate, n, hop);
  const { frames, bins, binHz } = reader;
  const kLow0 = Math.max(1, Math.round(lowLo / binHz));
  const kLow1 = Math.round(lowHi / binHz);
  const kHigh = Math.round(highFrom / binHz);
  const mag = new Float64Array(bins);
  const prev = new Float64Array(bins);
  const cur = new Float64Array(bins);
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const highFlux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    reader.magnitude(f, mag);
    let all = 0;
    let low = 0;
    let high = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(gamma * mag[k]);
      const d = cur[k] - prev[k];
      if (d > 0) {
        all += d;
        if (k >= kLow0 && k <= kLow1) low += d;
        if (k >= kHigh) high += d;
      }
    }
    // Frame 0 has nothing before it: its difference against silence is
    // the whole spectrum, not an onset.
    flux[f] = f > 0 ? all : 0;
    lowFlux[f] = f > 0 ? low : 0;
    highFlux[f] = f > 0 ? high : 0;
    prev.set(cur);
  }
  return { fps: reader.fps, t0: reader.centre(0), flux, lowFlux, highFlux };
}

/** A moving mean over ±half frames (box, O(n)). */
export function movingMean(x: ArrayLike<number>, half: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const i = Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)));
  return sorted[i];
}

export interface PeakOptions {
  /** A peak is the max over ±pre/post frames. */
  pre?: number;
  post?: number;
  /** ... and above the local mean over ±avg frames by `delta`. */
  avg?: number;
  /** Absolute threshold over the local mean; default a fraction of P95. */
  delta?: number;
  deltaFrac?: number;
  /** Minimum frames between peaks. */
  wait?: number;
  /** With this set, the P95 the threshold scales from is taken over a
   * rolling window of this many frames rather than the whole curve, floored
   * at `localFloor` of the global P95 — a quiet passage keeps its onsets. */
  localFrames?: number;
  localFloor?: number;
}

/**
 * A rolling percentile: `p` of `x` over blocks of `block` frames hopped a
 * quarter block, read per frame, and never below `floorFrac` of the whole
 * curve's percentile.
 */
export function rollingPercentile(
  x: Float32Array | Float64Array,
  block: number,
  p: number,
  floorFrac: number,
): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const global = percentile(x, p);
  const floor = floorFrac * global;
  const len = Math.max(1, Math.min(n, Math.round(block)));
  const hop = Math.max(1, Math.round(len / 4));
  const values: number[] = [];
  for (let s = 0; s < n; s += hop) {
    const a = Math.max(0, Math.min(n - len, s - len / 2));
    values.push(Math.max(floor, percentile(x.subarray(a, a + len), p)));
    if (a + len >= n && s + hop >= n) break;
  }
  for (let i = 0; i < n; i++) {
    out[i] = values[Math.min(values.length - 1, Math.floor(i / hop))];
  }
  return out;
}

/** Frame indices of the peaks of a flux curve (librosa-style peak picking). */
export function pickFluxPeaks(
  x: Float32Array | Float64Array,
  opts: PeakOptions = {},
): number[] {
  const pre = opts.pre ?? 3;
  const post = opts.post ?? 3;
  const avg = opts.avg ?? 43;
  const wait = opts.wait ?? 3;
  const deltaFrac = opts.deltaFrac ?? 0.15;
  const reference = opts.delta === undefined && opts.localFrames
    ? rollingPercentile(x, opts.localFrames, 0.95, opts.localFloor ?? 0.25)
    : null;
  const delta = opts.delta ?? deltaFrac * percentile(x, 0.95);
  const mean = movingMean(x, avg);
  const peaks: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const threshold = reference ? deltaFrac * reference[i] : delta;
    if (v <= 0 || v < mean[i] + threshold) continue;
    let isMax = true;
    for (
      let j = Math.max(0, i - pre);
      j <= Math.min(x.length - 1, i + post);
      j++
    ) {
      if (x[j] > v || (x[j] === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax || i - last < wait) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}

// ── Tempo ───────────────────────────────────────────────────────────────────

export interface TempoWindow {
  /** Window centre, seconds. */
  time: number;
  /** Chosen lag (frames) after the path smoothing, and its refined BPM. */
  lag: number;
  bpm: number;
  /** The observation score of the chosen lag. */
  strength: number;
}

export interface TempoSection {
  start: number;
  end: number;
  bpm: number;
  lag: number;
}

export interface TempoPath {
  windows: TempoWindow[];
  sections: TempoSection[];
  bpmAt(time: number): number;
}

export interface TempoOptions {
  windowSec?: number;
  hopSec?: number;
  minBpm?: number;
  maxBpm?: number;
  priorBpm?: number;
  /** Width of the log-Gaussian prior, octaves. */
  priorSigma?: number;
  /** Viterbi cost of a tempo change; drift of a frame or two is nearly free. */
  changePenalty?: number;
  driftCost?: number;
  /** Weight of the comb (multiples of the lag) in the observation. */
  combWeight?: number;
  /** The octave tie-break's margin: the alias must score this fraction. */
  aliasMargin?: number;
  /** How an octave tie is broken: by what the onsets articulate (default),
   * or always the slower / faster reading when the alias scores within the
   * margin — slower halves the slots a section takes. */
  aliasPrefer?: "onsets" | "slow" | "fast";
  /** Sub-window length for boundary refinement, seconds. */
  refineSec?: number;
}

/** Autocorrelation of `x[start..start+len)` for lags 0..maxLag. */
export function autocorrelate(
  x: ArrayLike<number>,
  start: number,
  len: number,
  maxLag: number,
): Float64Array {
  const acf = new Float64Array(maxLag + 1);
  const end = start + len;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = start; i + lag < end; i++) s += x[i] * x[i + lag];
    acf[lag] = s;
  }
  return acf;
}

/** The flux as the tempo estimator sees it: local mean removed, rectified. */
export function prepareFluxForTempo(
  flux: Float32Array,
  fps: number,
): Float64Array {
  const mean = movingMean(flux, Math.round(fps));
  const out = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i++) {
    out[i] = Math.max(0, flux[i] - mean[i]);
  }
  return out;
}

function parabolicVertex(l: number, c: number, r: number): number {
  const d = l - 2 * c + r;
  if (d >= 0) return 0;
  return Math.max(-1, Math.min(1, (0.5 * (l - r)) / d));
}

function peakNear(acf: Float64Array, at: number): number {
  const k = Math.round(at);
  if (k - 1 < 0 || k + 1 >= acf.length) return 0;
  return Math.max(acf[k - 1], acf[k], acf[k + 1]);
}

interface TempoObservation {
  /** Normalised ACF of the window. */
  acfn: Float64Array;
  /** Observation score per lag (index = lag; 0 outside lagMin..lagMax). */
  obs: Float64Array;
  /** The score less the window's mean over all lags: a window with no beat
   * to speak of scores every lag alike and so says nothing to the path. */
  vote: Float64Array;
}

function observeWindow(
  prepared: Float64Array,
  start: number,
  len: number,
  lagMin: number,
  lagMax: number,
  prior: Float64Array,
  combWeight: number,
): TempoObservation {
  const acf = autocorrelate(prepared, start, len, lagMax * 4 + 2);
  const acfn = new Float64Array(acf.length);
  if (acf[0] > 0) {
    for (let i = 0; i < acf.length; i++) acfn[i] = acf[i] / acf[0];
  }
  const obs = new Float64Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const comb = (peakNear(acfn, 2 * lag) + peakNear(acfn, 3 * lag) +
      peakNear(acfn, 4 * lag)) /
      3;
    obs[lag] = (acfn[lag] + combWeight * comb) * prior[lag];
  }
  let mean = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) mean += obs[lag];
  mean /= lagMax - lagMin + 1;
  const vote = new Float64Array(lagMax + 1);
  let top = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    vote[lag] = obs[lag] - mean;
    if (vote[lag] > top) top = vote[lag];
  }
  // A window where no lag stands out (a pad, a fade, noise) has little to
  // say: its votes shrink towards nothing rather than nudging the path.
  const clarity = Math.max(0, Math.min(1, (top - 0.06) / 0.12));
  for (let lag = lagMin; lag <= lagMax; lag++) vote[lag] *= clarity;
  return { acfn, obs, vote };
}

/**
 * Does the music move at (fractional) lag `at` — a sixteenth of some
 * reading? A real bump in the ACF: above both shoulders, not just the tail
 * of the lag-0 lobe, and a fair fraction of the beat's own peak.
 */
export function articulatedAt(
  acfn: Float64Array,
  at: number,
  beatLag: number,
): boolean {
  const k = Math.round(at);
  if (k < 4 || k + 3 >= acfn.length) return false;
  const v = Math.max(acfn[k - 1], acfn[k], acfn[k + 1]);
  const left = (acfn[k - 3] + acfn[k - 2]) / 2;
  const right = (acfn[k + 2] + acfn[k + 3]) / 2;
  const beat = acfn[Math.min(acfn.length - 1, Math.round(beatLag))];
  return v >= 0.12 && v >= 0.25 * beat && v > 1.1 * left && v > 1.1 * right;
}

/**
 * The song's tempo over time: a smoothed path of per-window estimates.
 *
 * Only the SHORT-window flux is a fit input: the N=4096 flux of a 115 BPM
 * song autocorrelates at 171 BPM, a 3:2 alias (measured in the survey).
 */
export function estimateTempoPath(
  onsets: OnsetAnalysis,
  opts: TempoOptions = {},
): TempoPath {
  const fps = onsets.fps;
  const total = onsets.flux.length;
  const durationSec = total / fps;
  const windowSec = Math.min(opts.windowSec ?? 40, durationSec);
  const hopSec = Math.min(opts.hopSec ?? 5, windowSec);
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const priorBpm = opts.priorBpm ?? 120;
  const priorSigma = opts.priorSigma ?? 0.8;
  const changePenalty = opts.changePenalty ?? 0.4;
  const driftCost = opts.driftCost ?? 0.03;
  const combWeight = opts.combWeight ?? 0.5;
  const aliasMargin = opts.aliasMargin ?? 0.85;
  const aliasPrefer = opts.aliasPrefer ?? "onsets";
  const refineSec = opts.refineSec ?? 10;

  const lagMin = Math.max(2, Math.round((fps * 60) / maxBpm));
  const lagMax = Math.round((fps * 60) / minBpm);
  const prior = new Float64Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (fps * 60) / lag;
    const z = Math.log2(bpm / priorBpm) / priorSigma;
    prior[lag] = Math.exp(-0.5 * z * z);
  }

  const prepared = prepareFluxForTempo(onsets.flux, fps);
  const winLen = Math.max(lagMax * 4 + 3, Math.round(windowSec * fps));
  const hopLen = Math.max(1, Math.round(hopSec * fps));
  const starts: number[] = [];
  for (let s = 0; s + winLen <= total; s += hopLen) starts.push(s);
  if (!starts.length) starts.push(0);
  const effLen = Math.min(winLen, total);
  const observations = starts.map((s) =>
    observeWindow(prepared, s, effLen, lagMin, lagMax, prior, combWeight)
  );

  // Viterbi over lag states: staying is free, drifting a frame costs little,
  // a jump costs the same whatever its size — a section change is a section
  // change.
  const W = observations.length;
  const S = lagMax - lagMin + 1;
  const score = new Float64Array(W * S);
  const back = new Int32Array(W * S);
  for (let s = 0; s < S; s++) score[s] = observations[0].vote[lagMin + s];
  for (let w = 1; w < W; w++) {
    const o = observations[w].vote;
    // The best "jump from anywhere" candidate is one value per window.
    let bestPrev = -Infinity;
    let bestPrevIdx = 0;
    for (let s = 0; s < S; s++) {
      const v = score[(w - 1) * S + s];
      if (v > bestPrev) {
        bestPrev = v;
        bestPrevIdx = s;
      }
    }
    for (let s = 0; s < S; s++) {
      let best = bestPrev - changePenalty;
      let bestIdx = bestPrevIdx;
      for (let d = -2; d <= 2; d++) {
        const p = s + d;
        if (p < 0 || p >= S) continue;
        const v = score[(w - 1) * S + p] - driftCost * Math.abs(d);
        if (v > best) {
          best = v;
          bestIdx = p;
        }
      }
      score[w * S + s] = best + o[lagMin + s];
      back[w * S + s] = bestIdx;
    }
  }
  const path = new Int32Array(W);
  {
    let bestIdx = 0;
    for (let s = 1; s < S; s++) {
      if (score[(W - 1) * S + s] > score[(W - 1) * S + bestIdx]) bestIdx = s;
    }
    path[W - 1] = bestIdx;
    for (let w = W - 1; w > 0; w--) path[w - 1] = back[w * S + path[w]];
  }

  // Runs of one lag are sections. The octave tie-break per run: if the
  // double or half lag scores nearly as well, take the reading whose
  // sixteenth grid matches what the onsets articulate — the slower one when
  // nothing moves at the faster reading's sixteenths, the faster one when
  // something does.
  const runs: { from: number; to: number; lag: number }[] = [];
  let prevLag = -99;
  for (let w = 0; w < W; w++) {
    const lag = lagMin + path[w];
    const last = runs[runs.length - 1];
    // Drift of a frame or two per window is one run; a jump starts another.
    if (last && Math.abs(prevLag - lag) <= 2) last.to = w;
    else runs.push({ from: w, to: w, lag });
    prevLag = lag;
  }
  // A run's lag is the median of its windows' path lags.
  for (const run of runs) {
    const lags: number[] = [];
    for (let w = run.from; w <= run.to; w++) lags.push(lagMin + path[w]);
    run.lag = Math.round(medianOf(lags));
  }
  // A run's mean observation at a lag, taken over lag ± 1: twice an integer
  // lag lands beside the slow reading's true peak as often as on it.
  const meanObs = (run: { from: number; to: number }, lag: number) => {
    if (lag < lagMin || lag > lagMax) return -Infinity;
    let s = 0;
    for (let w = run.from; w <= run.to; w++) {
      const o = observations[w].obs;
      let best = o[lag];
      if (lag - 1 >= lagMin) best = Math.max(best, o[lag - 1]);
      if (lag + 1 <= lagMax) best = Math.max(best, o[lag + 1]);
      s += best;
    }
    return s / (run.to - run.from + 1);
  };
  const meanArticulated = (
    run: { from: number; to: number },
    lag: number,
    beatLag: number,
  ) => {
    let hits = 0;
    for (let w = run.from; w <= run.to; w++) {
      if (articulatedAt(observations[w].acfn, lag, beatLag)) hits++;
    }
    return hits / (run.to - run.from + 1) >= 0.5;
  };
  for (const run of runs) {
    // An explicit preference judges the alias without the 120 BPM prior:
    // the caller has said which octave they want when the evidence is close.
    const explicit = aliasPrefer !== "onsets";
    const fit = (lag: number) =>
      explicit ? meanObs(run, lag) / (prior[lag] || 1) : meanObs(run, lag);
    const own = fit(run.lag);
    const slower = run.lag * 2;
    const faster = Math.round(run.lag / 2);
    const slowerFits = slower <= lagMax && fit(slower) >= aliasMargin * own;
    const fasterFits = faster >= lagMin && fit(faster) >= aliasMargin * own;
    if (aliasPrefer === "slow") {
      if (slowerFits) run.lag = slower;
    } else if (aliasPrefer === "fast") {
      if (fasterFits) run.lag = faster;
    } else if (slowerFits && !meanArticulated(run, run.lag / 4, run.lag)) {
      run.lag = slower;
    } else if (fasterFits && meanArticulated(run, faster / 4, faster)) {
      run.lag = faster;
    }
  }

  // Refine each window's lag to a fraction of a frame.
  const windows: TempoWindow[] = [];
  for (const run of runs) {
    for (let w = run.from; w <= run.to; w++) {
      const { acfn, obs } = observations[w];
      let lag = run.lag;
      // Settle on the local maximum of the observation near the run's lag.
      for (let d = -2; d <= 2; d++) {
        const l = run.lag + d;
        if (l >= lagMin && l <= lagMax && obs[l] > obs[lag]) lag = l;
      }
      const frac = lag - 1 >= 0 && lag + 1 < acfn.length
        ? parabolicVertex(acfn[lag - 1], acfn[lag], acfn[lag + 1])
        : 0;
      const refined = lag + frac;
      windows.push({
        time: (starts[w] + effLen / 2) / fps + onsets.t0,
        lag: refined,
        bpm: (fps * 60) / refined,
        strength: obs[lag],
      });
    }
  }

  // Sections with boundaries placed to the second: between two runs with
  // different lags, slide a short sub-window and put the boundary where the
  // left side agrees with the left tempo and the right with the right.
  const sections: TempoSection[] = [];
  const median = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const bpms = windows.slice(run.from, run.to + 1).map((x) => x.bpm);
    const bpm = median(bpms);
    const lag = (fps * 60) / bpm;
    const start = r === 0 ? 0 : sections[r - 1].end;
    let end = durationSec;
    if (r + 1 < runs.length) {
      const next = runs[r + 1];
      const guess = (starts[next.from] + effLen / 2) / fps;
      const subLen = Math.round(refineSec * fps);
      const half = Math.round(windowSec * fps / 2);
      const lo = Math.max(start * fps + subLen, guess * fps - half);
      const hi = Math.min(total - subLen, guess * fps + half);
      const lagA = Math.round(lag);
      const lagB = Math.round(next.lag);
      // Each side is normalised by its own section's mean score: the faster
      // tempo's taller comb would otherwise drag the boundary a second into
      // the slower section.
      const norm = (v: number) => (Number.isFinite(v) && v > 1e-6 ? v : 1);
      const normA = norm(meanObs(run, lagA));
      const normB = norm(meanObs(next, lagB));
      const d: number[] = [];
      const centres: number[] = [];
      for (let s = lo; s + subLen <= hi; s += Math.round(fps)) {
        const o = observeWindow(
          prepared,
          Math.round(s),
          subLen,
          lagMin,
          lagMax,
          prior,
          combWeight,
        );
        d.push(o.obs[lagA] / normA - o.obs[lagB] / normB);
        centres.push((s + subLen / 2) / fps);
      }
      if (d.length >= 2) {
        let bestScore = -Infinity;
        let bestAt = guess;
        const totalD = d.reduce((a, b) => a + b, 0);
        let left = 0;
        for (let i = 0; i <= d.length; i++) {
          const sc = left - (totalD - left);
          if (sc > bestScore) {
            bestScore = sc;
            // The boundary falls between two sub-windows, not on one.
            bestAt = i === 0
              ? centres[0] - 0.5
              : i < d.length
              ? (centres[i - 1] + centres[i]) / 2
              : centres[d.length - 1] + 0.5;
          }
          if (i < d.length) left += d[i];
        }
        end = bestAt;
      } else {
        end = guess;
      }
    }
    sections.push({ start, end: Math.max(end, start), bpm, lag });
  }
  if (!sections.length) {
    sections.push({ start: 0, end: durationSec, bpm: 120, lag: fps / 2 });
  }

  const bpmAt = (time: number) => {
    for (const s of sections) if (time < s.end) return s.bpm;
    return sections[sections.length - 1].bpm;
  };
  return { windows, sections, bpmAt };
}

// ── Beats ───────────────────────────────────────────────────────────────────

export interface BeatOptions {
  /** How hard the tracker holds the local period (Ellis's alpha). */
  tightness?: number;
}

/** Beat times (seconds) by dynamic programming against the local period. */
export function trackBeats(
  onsets: OnsetAnalysis,
  tempo: TempoPath,
  opts: BeatOptions = {},
): Float64Array {
  // Ellis's default. The period comes from a sectional path that is right
  // to a fraction of a BPM, so holding it hard beats following every strong
  // off-beat: on the survey's song 100 kept 94 % of beats within 4 % of the
  // section tempo, 400 kept 99.5 %.
  const tightness = opts.tightness ?? 400;
  const { flux, fps, t0 } = onsets;
  const T = flux.length;
  if (!T) return new Float64Array(0);
  // Normalise to unit spread, smooth a little.
  let mean = 0;
  for (let i = 0; i < T; i++) mean += flux[i];
  mean /= T;
  let variance = 0;
  for (let i = 0; i < T; i++) variance += (flux[i] - mean) ** 2;
  const sd = Math.sqrt(variance / T) || 1;
  const local = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    const a = i > 0 ? flux[i - 1] : flux[i];
    const c = flux[i];
    const b = i + 1 < T ? flux[i + 1] : flux[i];
    local[i] = (0.25 * a + 0.5 * c + 0.25 * b) / sd;
  }
  const cum = new Float64Array(T);
  const back = new Int32Array(T).fill(-1);
  for (let t = 0; t < T; t++) {
    const period = (fps * 60) / tempo.bpmAt(t0 + t / fps);
    // Near a section boundary the previous beat may lie in the other
    // section: the candidates span both periods, each judged by the nearer,
    // so the tracker neither skips nor doubles a beat there.
    const prevPeriod = (fps * 60) /
      tempo.bpmAt(t0 + (t - 2 * period) / fps);
    const twoPeriods = Math.abs(Math.log(prevPeriod / period)) > 0.05;
    const pMax = Math.max(period, prevPeriod);
    const pMin = Math.min(period, prevPeriod);
    const lo = t - Math.round(2 * pMax);
    const hi = t - Math.round(pMin / 2);
    let best = -Infinity;
    let bestTau = -1;
    for (let tau = Math.max(0, lo); tau <= hi; tau++) {
      const d1 = Math.log((t - tau) / period);
      let dev = d1 * d1;
      if (twoPeriods) {
        const d2 = Math.log((t - tau) / prevPeriod);
        dev = Math.min(dev, d2 * d2);
      }
      const v = cum[tau] - tightness * dev;
      if (v > best) {
        best = v;
        bestTau = tau;
      }
    }
    cum[t] = local[t] + (bestTau >= 0 ? best : 0);
    back[t] = bestTau;
  }
  // The last beat: the best score within the final period and a half.
  const lastPeriod = (fps * 60) / tempo.bpmAt(t0 + (T - 1) / fps);
  let tail = T - 1;
  for (let t = Math.max(0, T - Math.round(1.5 * lastPeriod)); t < T; t++) {
    if (cum[t] > cum[tail]) tail = t;
  }
  const beats: number[] = [];
  for (let t = tail; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // Beats stay on the frame grid: a parabolic vertex of the onset curve
  // puts a few beats just after their onsets, which strikes those notes a
  // step early. The slot's tempo is read from the span of its steps, so the
  // 11.6 ms quantisation averages out there.
  return Float64Array.from(beats, (f) => t0 + f / fps);
}

// ── The step grid ───────────────────────────────────────────────────────────

export const STEPS_PER_BEAT = 4;

export interface StepGrid {
  /** Step start times; `bounds[i+1]` ends step i. May begin below 0. */
  bounds: Float64Array;
  /** Steps in the grid (bounds.length − 1). */
  steps: number;
  /** The beats the grid was built on, after extrapolation. */
  beats: Float64Array;
  /** Index into `beats` of the first beat the tracker actually found. */
  firstTrackedBeat: number;
}

/**
 * Sixteenths between beats. Beats are extrapolated backwards over the intro
 * (plus `leadBeats` virtual beats, for a downbeat to land on step 0) and
 * forwards over the tail, so every second of audio owns a step.
 */
export function buildStepGrid(
  beatTimes: Float64Array,
  duration: number,
  leadBeats = 0,
): StepGrid {
  if (beatTimes.length < 2) {
    // No beats to speak of: a flat 120 BPM grid.
    const period = 0.5;
    const count = Math.ceil(duration / period) + 1;
    const beats = Float64Array.from({ length: count }, (_, i) => i * period);
    return finishGrid(beats, 0);
  }
  const intervals: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) {
    intervals.push(beatTimes[i] - beatTimes[i - 1]);
  }
  const head = medianOf(intervals.slice(0, 8));
  const tailInt = medianOf(intervals.slice(-8));
  const before: number[] = [];
  let t = beatTimes[0] - head;
  while (t > -head * 0.5) {
    before.push(t);
    t -= head;
  }
  for (let i = 0; i < leadBeats; i++) {
    before.push(t);
    t -= head;
  }
  before.reverse();
  const after: number[] = [];
  t = beatTimes[beatTimes.length - 1] + tailInt;
  while (t < duration + tailInt) {
    after.push(t);
    t += tailInt;
  }
  const beats = Float64Array.from([...before, ...beatTimes, ...after]);
  return finishGrid(beats, before.length);
}

function finishGrid(beats: Float64Array, firstTrackedBeat: number): StepGrid {
  const steps = (beats.length - 1) * STEPS_PER_BEAT;
  const bounds = new Float64Array(steps + 1);
  for (let b = 0; b + 1 < beats.length; b++) {
    const a = beats[b];
    const d = (beats[b + 1] - a) / STEPS_PER_BEAT;
    for (let k = 0; k < STEPS_PER_BEAT; k++) {
      bounds[b * STEPS_PER_BEAT + k] = a + k * d;
    }
  }
  bounds[steps] = beats[beats.length - 1];
  return { bounds, steps, beats, firstTrackedBeat };
}

function medianOf(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0.5;
}

/** The step whose start is nearest `time`, or −1 when it is outside the grid. */
export function stepAt(grid: StepGrid, time: number): number {
  const { bounds, steps } = grid;
  if (time < bounds[0] || time >= bounds[steps]) return -1;
  let lo = 0;
  let hi = steps - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── Pitches ─────────────────────────────────────────────────────────────────

/** The 59 pitches a composed part can play: MIDI 36 (C2) .. 94 (Bb6). */
export const MIDI_LO = 36;
export const MIDI_HI = 94;

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface SpectralPeak {
  hz: number;
  /** Strength in 6 dB units above a 6 dB-over-envelope floor; 0 is noise. */
  strength: number;
}

/**
 * Spectral whitening: the magnitude in dB minus a median envelope ~300 Hz
 * wide, interpolated from band medians. Noise flattens to 0 dB; partials
 * stand up as dB above their surroundings. `magDb` is modified in place.
 */
export function whitenSpectrum(
  magDb: Float64Array,
  binHz: number,
  widthHz = 300,
): void {
  const bins = magDb.length;
  const band = Math.max(8, Math.round(widthHz / binHz));
  const count = Math.ceil(bins / band);
  const centres = new Float64Array(count);
  const medians = new Float64Array(count);
  const scratch = new Float64Array(band);
  for (let c = 0; c < count; c++) {
    const a = c * band;
    const b = Math.min(bins, a + band);
    const seg = scratch.subarray(0, b - a);
    for (let k = a; k < b; k++) seg[k - a] = magDb[k];
    seg.sort();
    medians[c] = seg[Math.floor(seg.length / 2)];
    centres[c] = (a + b - 1) / 2;
  }
  let c = 0;
  for (let k = 0; k < bins; k++) {
    while (c + 1 < count && centres[c + 1] <= k) c++;
    let env: number;
    if (c + 1 >= count || k <= centres[c]) env = medians[c];
    else {
      const f = (k - centres[c]) / (centres[c + 1] - centres[c]);
      env = medians[c] + f * (medians[c + 1] - medians[c]);
    }
    magDb[k] -= env;
  }
}

/**
 * Peaks of a whitened dB spectrum with parabolic interpolation; only those
 * at least `floorDb` above the envelope count, and their strength is how far
 * above that floor they stand, in 6 dB units.
 */
export function pickSpectralPeaks(
  whiteDb: Float64Array,
  binHz: number,
  minHz = 30,
  maxHz = 11000,
  floorDb = 6,
): SpectralPeak[] {
  const peaks: SpectralPeak[] = [];
  const k0 = Math.max(1, Math.floor(minHz / binHz));
  const k1 = Math.min(whiteDb.length - 2, Math.ceil(maxHz / binHz));
  for (let k = k0; k <= k1; k++) {
    const c = whiteDb[k];
    if (c < floorDb) continue;
    const l = whiteDb[k - 1];
    const r = whiteDb[k + 1];
    if (c < l || c <= r) continue;
    const d = parabolicVertex(l, c, r);
    const amp = c - 0.25 * (l - r) * d;
    peaks.push({ hz: (k + d) * binHz, strength: (amp - floorDb) / 6 });
  }
  return peaks;
}

/**
 * The strongest peak within ±¼ semitone (widened to 0.6 bin where a bin is
 * wider than that) of `hz`, or −1.
 */
export function findPeak(
  peaks: SpectralPeak[],
  hz: number,
  binHz: number,
): number {
  const tol = Math.max(hz * (2 ** (1 / 48) - 1), 0.6 * binHz);
  const lo = hz - tol;
  const hi = hz + tol;
  let a = 0;
  let b = peaks.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (peaks[mid].hz < lo) a = mid + 1;
    else b = mid;
  }
  let best = -1;
  for (let i = a; i < peaks.length && peaks[i].hz <= hi; i++) {
    if (best < 0 || peaks[i].strength > peaks[best].strength) best = i;
  }
  return best;
}

export const HARMONICS = 8;
export const HARMONIC_DECAY = 0.8;

/**
 * Harmonic-sum salience of one fundamental over the peak list, with how
 * many partials were found and how many lay below the Nyquist to be found.
 */
export function salienceDetail(
  peaks: SpectralPeak[],
  hz: number,
  binHz: number,
  nyquist: number,
): {
  salience: number;
  matched: number;
  possible: number;
  fundamental: number;
} {
  let salience = 0;
  let matched = 0;
  let possible = 0;
  let fundamental = 0;
  let w = 1;
  for (let h = 1; h <= HARMONICS; h++, w *= HARMONIC_DECAY) {
    const f = h * hz;
    if (f >= nyquist) break;
    possible++;
    const i = findPeak(peaks, f, binHz);
    if (i >= 0) {
      salience += w * peaks[i].strength;
      matched++;
      if (h === 1) fundamental = peaks[i].strength;
    }
  }
  return { salience, matched, possible, fundamental };
}

/** Harmonic-sum salience of one fundamental over the peak list. */
export function salienceOf(
  peaks: SpectralPeak[],
  hz: number,
  binHz: number,
  nyquist: number,
): number {
  return salienceDetail(peaks, hz, binHz, nyquist).salience;
}

export interface StepVoice {
  midi: number;
  salience: number;
}

/**
 * Up to `maxVoices` pitches in one step's peak list: take the most salient
 * candidate, attenuate the peaks its harmonic series claimed, repeat while
 * the next is at least `rel` of the first. The peak list is consumed.
 *
 * A candidate needs two of its partials present (one, when only one fits
 * under the Nyquist): a lone peak is as likely a cymbal's ring or another
 * note's overtone as a fundamental, and it used to hand the lead ghosts
 * around F6. A lone fundamental standing `loneStrength` (24 dB) over the
 * envelope is the exception — a sine lead is a note too.
 */
export function estimateVoices(
  peaks: SpectralPeak[],
  binHz: number,
  nyquist: number,
  maxVoices = 3,
  rel = 0.3,
  candidates: number[] = CANDIDATE_MIDI,
  minPartials = 2,
  loneStrength = 3,
): StepVoice[] {
  const voices: StepVoice[] = [];
  const hz = candidates.map(midiToHz);
  let first = 0;
  for (let v = 0; v < maxVoices && peaks.length; v++) {
    let best = -1;
    let bestS = 0;
    for (let i = 0; i < candidates.length; i++) {
      const d = salienceDetail(peaks, hz[i], binHz, nyquist);
      if (
        d.matched < Math.min(minPartials, d.possible) &&
        d.fundamental < loneStrength
      ) continue;
      if (d.salience > bestS) {
        bestS = d.salience;
        best = i;
      }
    }
    if (best < 0 || bestS <= 0) break;
    if (v === 0) first = bestS;
    else if (bestS < rel * first) break;
    voices.push({ midi: candidates[best], salience: bestS });
    for (let h = 1; h <= HARMONICS; h++) {
      const f = h * hz[best];
      if (f >= nyquist) break;
      const i = findPeak(peaks, f, binHz);
      if (i >= 0) peaks[i].strength *= 0.2;
    }
  }
  return voices;
}

export const CANDIDATE_MIDI: number[] = Array.from(
  { length: MIDI_HI - MIDI_LO + 1 },
  (_, i) => MIDI_LO + i,
);

/** 12-bin chroma of a magnitude spectrum over 100–2000 Hz, power-weighted. */
export function chromaOf(
  mag: Float64Array,
  binHz: number,
  out: Float32Array,
  minHz = 100,
  maxHz = 2000,
): void {
  out.fill(0);
  const k0 = Math.max(1, Math.ceil(minHz / binHz));
  const k1 = Math.min(mag.length - 1, Math.floor(maxHz / binHz));
  for (let k = k0; k <= k1; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] += mag[k] * mag[k];
  }
}

export interface StepPitch {
  /** Mean power of the step's frames (4|X|/n units squared, summed). */
  energy: number;
  voices: StepVoice[];
  chroma: Float32Array;
}

export interface PitchOptions {
  n?: number;
  hop?: number;
  /** Fraction of each step whose frames are averaged (from its start). */
  portion?: number;
  maxVoices?: number;
  /** A further voice must reach this fraction of the step's first. */
  rel?: number;
}

/**
 * Per-step chroma of any audio against any step grid — the source against
 * its tracked grid, or a render against its playback grid. The spectrogram
 * is never kept: frames are averaged into their step as they stream past.
 */
export function stepSpectra(
  audio: DecodedAudio,
  bounds: Float64Array,
  opts: PitchOptions,
  reduce: (step: number, mag: Float64Array, frames: number) => void,
): void {
  const n = opts.n ?? 4096;
  const hop = opts.hop ?? 512;
  const portion = opts.portion ?? 0.6;
  const reader = makeSpectrumReader(audio.samples, audio.sampleRate, n, hop);
  const steps = bounds.length - 1;
  const mag = new Float64Array(reader.bins);
  const acc = new Float64Array(reader.bins);
  const last = new Float64Array(reader.bins);
  let haveLast = false;
  let count = 0;
  let s = 0;
  const flush = () => {
    if (count > 0) {
      for (let k = 0; k < acc.length; k++) acc[k] /= count;
      reduce(s, acc, count);
    } else if (haveLast) {
      reduce(s, last, 0);
    }
    acc.fill(0);
    count = 0;
  };
  for (let f = 0; f < reader.frames && s < steps; f++) {
    const tc = reader.centre(f);
    if (tc < bounds[0]) continue;
    while (s < steps && tc >= bounds[s + 1]) {
      flush();
      s++;
    }
    if (s >= steps) break;
    const len = bounds[s + 1] - bounds[s];
    const within = tc - bounds[s];
    if (
      within <= Math.max(portion * len, 1.01 * hop / audio.sampleRate) ||
      count === 0
    ) {
      reader.magnitude(f, mag);
      for (let k = 0; k < acc.length; k++) acc[k] += mag[k];
      count++;
      last.set(mag);
      haveLast = true;
    }
  }
  if (s < steps) flush();
}

/** Multi-pitch analysis per step of the grid. */
export function analysePitches(
  audio: DecodedAudio,
  grid: StepGrid,
  opts: PitchOptions = {},
): StepPitch[] {
  const n = opts.n ?? 4096;
  const binHz = audio.sampleRate / n;
  const nyquist = audio.sampleRate / 2;
  const maxVoices = opts.maxVoices ?? 3;
  const rel = opts.rel ?? 0.3;
  const out: StepPitch[] = Array.from({ length: grid.steps }, () => ({
    energy: 0,
    voices: [],
    chroma: new Float32Array(12),
  }));
  const db = new Float64Array(n / 2 + 1);
  stepSpectra(audio, grid.bounds, { ...opts, n }, (step, mag) => {
    const sp = out[step];
    let e = 0;
    for (let k = 1; k < mag.length; k++) e += mag[k] * mag[k];
    sp.energy = e;
    chromaOf(mag, binHz, sp.chroma);
    for (let k = 0; k < mag.length; k++) db[k] = 20 * Math.log10(mag[k] + 1e-9);
    whitenSpectrum(db, binHz);
    const peaks = pickSpectralPeaks(db, binHz, 30, nyquist);
    sp.voices = estimateVoices(peaks, binHz, nyquist, maxVoices, rel);
  });
  return out;
}

// ── Drums ───────────────────────────────────────────────────────────────────

export interface StepDrums {
  kick: boolean;
  snare: boolean;
  hat: boolean;
  /** A broadband flux peak at this step's start: a re-strike, not a tie. */
  onset: boolean;
}

export interface DrumOptions {
  /** Peak thresholds as fractions of each band's 95th percentile. */
  lowDelta?: number;
  highDelta?: number;
  allDelta?: number;
  /** How far from a step start (fraction of the step) a peak may snap. */
  snap?: number;
  /** A kick's low band must carry this share of the frame's flux: the low
   * band is six bins of 513, so a noise burst or a chord barely shows there
   * while a kick lands most of its flux in it. */
  kickShare?: number;
  /** A high-band peak is a drum when the band carries this share ... */
  hatShare?: number;
  /** ... and a hat rather than a snare above this one (a snare has body). */
  hatOnlyShare?: number;
  /** Absolute floors, fractions of each band's 95th percentile over the
   * song: a quiet passage's wobble is not a drum part. */
  kickAbs?: number;
  hatAbs?: number;
  /** The broadband and high-band thresholds scale from a percentile over a
   * rolling window of this many seconds (default 25; 0 = the whole song),
   * never below `localFloor` (default 0.5) of the whole song's — so a
   * passage 6–14 dB under the loud sections keeps its onsets and hats. On
   * the survey's song this lifted the five quiet slots' onset agreement by
   * 0.06–0.16 against a locally thresholded truth and left the loud slots
   * within 0.01. The low band is never windowed (see detectDrums). */
  localSec?: number;
  localFloor?: number;
}

export function detectDrums(
  onsets: OnsetAnalysis,
  grid: StepGrid,
  opts: DrumOptions = {},
): StepDrums[] {
  const snap = opts.snap ?? 0.45;
  const kickShare = opts.kickShare ?? 0.12;
  const hatShare = opts.hatShare ?? 0.5;
  const hatOnlyShare = opts.hatOnlyShare ?? 0.72;
  const localSec = opts.localSec ?? 25;
  const localFrames = localSec > 0
    ? Math.round(localSec * onsets.fps)
    : undefined;
  const localFloor = opts.localFloor ?? 0.5;
  const whole = (band: Float32Array) =>
    new Float64Array(band.length).fill(percentile(band, 0.95));
  const reference = (band: Float32Array) =>
    localFrames
      ? rollingPercentile(band, localFrames, 0.95, localFloor)
      : whole(band);
  // The low band is judged against the whole song whatever the window: a
  // quiet passage's lows are a bass line breathing, and a local reference
  // that shrinks to them turns every breath into a kick (measured: 87 → 259
  // kicks over 512 steps, no gain in onset agreement).
  const lowRef = whole(onsets.lowFlux);
  const highRef = reference(onsets.highFlux);
  const kickAbsFrac = opts.kickAbs ?? 0.3;
  const hatAbsFrac = opts.hatAbs ?? 0.25;
  const out: StepDrums[] = Array.from({ length: grid.steps }, () => ({
    kick: false,
    snare: false,
    hat: false,
    onset: false,
  }));
  const share = (band: Float32Array, f: number) =>
    onsets.flux[f] > 0 ? band[f] / onsets.flux[f] : 0;
  const place = (peaks: number[], mark: (d: StepDrums, f: number) => void) => {
    for (const f of peaks) {
      const t = onsets.t0 + f / onsets.fps;
      let s = stepAt(grid, t);
      if (s < 0) continue;
      // Nearest start: this step's or the next one's.
      if (
        s + 1 < grid.steps &&
        grid.bounds[s + 1] - t < t - grid.bounds[s]
      ) {
        s++;
      }
      const len = grid.bounds[Math.min(s + 1, grid.steps)] -
        grid.bounds[Math.max(0, s)];
      if (Math.abs(t - grid.bounds[s]) <= snap * len) mark(out[s], f);
    }
  };
  const all = pickFluxPeaks(onsets.flux, {
    deltaFrac: opts.allDelta ?? 0.12,
    localFrames,
    localFloor,
  });
  const low = pickFluxPeaks(onsets.lowFlux, {
    deltaFrac: opts.lowDelta ?? 0.25,
  });
  const high = pickFluxPeaks(onsets.highFlux, {
    deltaFrac: opts.highDelta ?? 0.2,
    localFrames,
    localFloor,
  });
  place(all, (d) => (d.onset = true));
  place(low, (d, f) => {
    const v = onsets.lowFlux[f];
    const kickAbs = kickAbsFrac * lowRef[f];
    // A kick has a click: a low peak with no broadband onset is a bass
    // note breathing, unless it is one of the loudest lows around.
    const struck = d.onset || v >= 0.8 * lowRef[f];
    if (share(onsets.lowFlux, f) >= kickShare && v >= kickAbs && struck) {
      d.kick = true;
    }
  });
  place(high, (d, f) => {
    const v = onsets.highFlux[f];
    if (v < hatAbsFrac * highRef[f]) return;
    const hs = share(onsets.highFlux, f);
    if (hs >= hatOnlyShare) d.hat = true;
    else if (hs >= hatShare) d.snare = true;
  });
  return out;
}

// ── Parts ───────────────────────────────────────────────────────────────────

export type PartName = "lead" | "bass" | "pad" | "drums";
export const PART_NAMES: PartName[] = ["lead", "bass", "pad", "drums"];

export interface Cell {
  /** Pitch byte 1..59. */
  note: number;
  instrument: number;
  tie: boolean;
}

export interface InstrumentChoice {
  lead: number;
  bass: number;
  pad: number;
  kick: number;
  snare: number;
  hat: number;
  kickPitch: number;
  snarePitch: number;
  hatPitch: number;
}

/** The survey's defaults: 13 bright saw, 18 synth bass, 23 strings pad. */
export const DEFAULT_INSTRUMENTS: InstrumentChoice = {
  lead: 13,
  bass: 18,
  pad: 23,
  kick: 41,
  snare: 40,
  hat: 48,
  kickPitch: 3,
  snarePitch: 25,
  hatPitch: 50,
};

export interface AssignOptions {
  instruments?: Partial<InstrumentChoice>;
  parts?: PartName[];
  /** A step's lowest voice is bass only up to this MIDI note. */
  bassCeiling?: number;
  /** The quiet floor: a step's best voice must reach this fraction of the
   * song's median best salience, or the step is a rest. */
  floorFrac?: number;
  /** A pad voice must reach this fraction of the step's lead salience. */
  padFrac?: number;
  /** Continuity: a lead candidate loses this fraction per semitone of jump. */
  continuity?: number;
  /** The lead's own floor, a fraction of the median best salience: higher
   * than floorFrac, so the top line is made of notes that stand out. */
  leadFrac?: number;
  /** A step quieter than this fraction of the median step energy is a rest
   * whatever its spectrum says: whitening makes salience loudness-blind,
   * so fades and noise tails need an energy gate of their own. */
  energyFloor?: number;
  /** Hysteresis: the lead stays on its note unless a rival is this much
   * more salient. */
  stickiness?: number;
  /** A step whose energy jumps by this factor over the last is an attack:
   * its floors are halved, because a transient lifts the whitening
   * envelope and the new note's partials read low on the very step they
   * begin. Without it every note started a step late. */
  attackRatio?: number;
}

function resolveInstruments(
  partial?: Partial<InstrumentChoice>,
): InstrumentChoice {
  return { ...DEFAULT_INSTRUMENTS, ...(partial ?? {}) };
}

function pitchByte(midi: number): number {
  const p = foldMidiToPitch(midi) as number | null;
  if (p === null) throw new RangeError(`no pitch byte for MIDI ${midi}`);
  return p;
}

/**
 * Four monophonic lines of cells over the grid's steps. Index 0 lead, 1
 * bass, 2 pad, 3 drums — the runtime's gains are 1 / 0.8 / 1.2 / 0.5.
 */
export function assignParts(
  pitches: StepPitch[],
  drums: StepDrums[],
  opts: AssignOptions = {},
): (Cell | null)[][] {
  const inst = resolveInstruments(opts.instruments);
  const parts = new Set<PartName>(opts.parts ?? PART_NAMES);
  const bassCeiling = opts.bassCeiling ?? 55;
  const floorFrac = opts.floorFrac ?? 0.35;
  const padFrac = opts.padFrac ?? 0.45;
  const continuity = opts.continuity ?? 0.03;
  const leadFrac = opts.leadFrac ?? 0.6;
  const energyFloorFrac = opts.energyFloor ?? 0.03;
  const stickiness = opts.stickiness ?? 1.3;
  const attackRatio = opts.attackRatio ?? 1.5;
  const steps = pitches.length;
  const cells: (Cell | null)[][] = [0, 1, 2, 3].map(() =>
    new Array<Cell | null>(steps).fill(null)
  );

  const sounding = pitches.filter((p) => p.voices.length);
  const medianBest = percentile(
    sounding.map((p) => p.voices[0].salience),
    0.5,
  );
  const floor = floorFrac * medianBest;
  const leadFloor = leadFrac * medianBest;
  const energyFloor = energyFloorFrac *
    percentile(sounding.map((p) => p.energy), 0.5);

  const leadMidi = new Int16Array(steps).fill(-1);
  const bassMidi = new Int16Array(steps).fill(-1);
  const padMidi = new Int16Array(steps).fill(-1);
  let prevLead = -1;
  let prevLeadAge = 99;
  let prevBass = -1;
  for (let s = 0; s < steps; s++) {
    const attack = s > 0 &&
      pitches[s].energy >= attackRatio * pitches[s - 1].energy;
    const relax = attack ? 0.5 : 1;
    // A note already sounding is kept down to half its floor (a Schmitt
    // trigger): a decaying tail is still that note, not a new decision.
    const holding = (v: StepVoice) =>
      (v.midi === prevLead && prevLeadAge <= 2) || v.midi === prevBass;
    const voices = pitches[s].energy >= energyFloor
      ? pitches[s].voices.filter((v) =>
        v.salience >= floor * relax ||
        (holding(v) && v.salience >= 0.5 * floor)
      )
      : [];
    if (!voices.length) {
      prevLeadAge++;
      prevBass = -1;
      continue;
    }
    let rest = voices.slice();
    let lowest = rest[0];
    for (const v of rest) if (v.midi < lowest.midi) lowest = v;
    prevBass = -1;
    if (parts.has("bass") && lowest.midi <= bassCeiling) {
      prevBass = lowest.midi;
      bassMidi[s] = lowest.midi;
      // Below C3 the bass's semitone neighbour is the same note seen from
      // the next bin, not a second voice.
      rest = rest.filter((v) =>
        v !== lowest &&
        !(lowest.midi < 50 && Math.abs(v.midi - lowest.midi) <= 1)
      );
    }
    const leadable = parts.has("lead")
      ? rest.filter((v) =>
        v.salience >= leadFloor * relax ||
        (v.midi === prevLead && prevLeadAge <= 2 &&
          v.salience >= 0.5 * leadFloor)
      )
      : [];
    if (leadable.length) {
      let best = leadable[0];
      let bestScore = -Infinity;
      for (const v of leadable) {
        let score = v.salience;
        if (prevLead >= 0 && prevLeadAge <= 2) {
          score *= Math.max(0.3, 1 - continuity * Math.abs(v.midi - prevLead));
        }
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      // Hysteresis: between onsets the note already playing keeps the
      // line unless a rival clearly outweighs it. At an onset anything may
      // win — the old note still rings in the analysis window there, and
      // holding it would land every change a step late.
      const held = prevLeadAge <= 2 && !drums[s].onset
        ? leadable.find((v) => v.midi === prevLead)
        : undefined;
      if (held && best !== held && best.salience < stickiness * held.salience) {
        best = held;
      }
      leadMidi[s] = best.midi;
      prevLead = best.midi;
      prevLeadAge = 0;
      rest = rest.filter((v) => v !== best);
    } else {
      prevLeadAge++;
    }
    // The pad is an inner voice under a lead, never the lead's leavings.
    if (parts.has("pad") && rest.length && leadMidi[s] >= 0) {
      const leadSal = voices.find((v) => v.midi === leadMidi[s])!.salience;
      const v = rest[0];
      if (v.salience >= padFrac * leadSal) padMidi[s] = v.midi;
    }
  }

  // A re-strike of the pitch already sounding needs a flux onset AND an
  // energy attack: the onset flag alone fires on every hi-hat, and a held
  // note over a sixteenth-note hat pattern came out as a machine gun.
  const restrike = new Uint8Array(steps);
  for (let s = 1; s < steps; s++) {
    restrike[s] = drums[s].onset &&
        pitches[s].energy >= attackRatio * pitches[s - 1].energy
      ? 1
      : 0;
  }

  const lines: [Int16Array, number, number][] = [
    [leadMidi, 0, inst.lead],
    [bassMidi, 1, inst.bass],
    [padMidi, 2, inst.pad],
  ];
  for (const [midi, part, instrument] of lines) {
    // Below C3 a semitone is under a bin of the 4096-point spectrum, so a
    // held note's estimate wanders by one: a neighbour without an onset is
    // the same note.
    for (let s = 1; s < steps; s++) {
      if (
        midi[s] >= 0 && midi[s - 1] >= 0 && midi[s] !== midi[s - 1] &&
        Math.abs(midi[s] - midi[s - 1]) === 1 && midi[s] < 50 &&
        !restrike[s]
      ) {
        midi[s] = midi[s - 1];
      }
    }
    // Fill one-step holes where the same pitch resumes.
    for (let s = 1; s + 1 < steps; s++) {
      if (midi[s] < 0 && midi[s - 1] >= 0 && midi[s - 1] === midi[s + 1]) {
        midi[s] = midi[s - 1];
      }
    }
    // Drop one-step notes that are tracker jitter, not music: an excursion
    // out of a held note and back, or a weak blip between rests, with no
    // onset behind it. A run of sixteenths, each a new pitch, stays. The
    // pad is sustained by nature, so a lone pad step always goes.
    for (let s = 0; s < steps; s++) {
      if (midi[s] < 0) continue;
      const prev = s > 0 ? midi[s - 1] : -1;
      const next = s + 1 < steps ? midi[s + 1] : -1;
      const alone = prev !== midi[s] && next !== midi[s];
      if (!alone) continue;
      if (part === 2) {
        midi[s] = -1;
        continue;
      }
      // Any flux onset spares a one-step note here: gating this on the
      // stricter re-strike flag lost chroma and onset agreement alike.
      if (drums[s].onset) continue;
      const excursion = prev >= 0 && prev === next;
      const sal = pitches[s].voices.find((v) => v.midi === midi[s])?.salience ??
        0;
      const blip = prev < 0 && next < 0 && sal < medianBest;
      if (excursion || blip) midi[s] = -1;
    }
    for (let s = 0; s < steps; s++) {
      if (midi[s] < 0) continue;
      const tie = s > 0 && midi[s - 1] === midi[s] && !restrike[s];
      cells[part][s] = { note: pitchByte(midi[s]), instrument, tie };
    }
  }

  if (parts.has("drums")) {
    for (let s = 0; s < steps; s++) {
      const d = drums[s];
      let cell: Cell | null = null;
      if (d.kick) {
        cell = { note: inst.kickPitch, instrument: inst.kick, tie: false };
      } else if (d.snare) {
        cell = { note: inst.snarePitch, instrument: inst.snare, tie: false };
      } else if (d.hat) {
        cell = { note: inst.hatPitch, instrument: inst.hat, tie: false };
      }
      cells[3][s] = cell;
    }
  }
  return cells;
}

/**
 * Halve a line's resolution (sixteenths → eighths): each pair becomes one
 * cell — the first's, else the second's struck as the pair's onset.
 */
export function downsampleCells(
  cells: (Cell | null)[],
  factor: number,
  prefer?: (first: Cell, later: Cell) => Cell,
): (Cell | null)[] {
  const out: (Cell | null)[] = [];
  for (let i = 0; i < cells.length; i += factor) {
    let pick: Cell | null = null;
    for (let j = 0; j < factor && i + j < cells.length; j++) {
      const c = cells[i + j];
      if (!c) continue;
      if (!pick) {
        pick = { ...c, tie: j === 0 ? c.tie : false };
        continue;
      }
      // A continuation adds nothing to the pair.
      if (c.tie) continue;
      // A strike after a held note: the note changes.
      if (pick.tie) {
        pick = { ...c, tie: false };
        continue;
      }
      // Two strikes in one pair: the first (on the grid) unless the caller
      // ranks them — the drum part keeps a kick over a hat.
      if (prefer) pick = { ...prefer(pick, c), tie: false };
    }
    out.push(pick);
  }
  return out;
}

// ── Slots ───────────────────────────────────────────────────────────────────

export interface SlotPlan {
  /** First grid step (sixteenth) of the slot. */
  startStep: number;
  /** Grid steps the slot covers (≤ 512 · grid). */
  stepCount: number;
  /** Grid steps per song step: 1 for sixteenths, 2 for eighths. */
  grid: number;
  tempoIndex: number;
  /** The source's median song-step length and the index's. */
  sourceStepSeconds: number;
  stepSeconds: number;
  /** stepSeconds / sourceStepSeconds − 1: how much slower (+) or faster (−)
   * the slot plays than the record. Within ±3 % the table had a near
   * index; beyond ±5 % the step fell off the table's end (an eighth grid
   * below 109 BPM, say) and was pinned. */
  tempoError: number;
}

export interface PlanOptions {
  /** Song steps per beat: 16 (sixteenths) or 8 (eighths). */
  grid?: 16 | 8;
  /** A slot may end early at a tempo change this far in (sixteenths); at
   * least one song measure, which is also the default, so a change in a
   * slot's first bars is cut and not played at the wrong index. */
  minSplitSteps?: number;
  /** A tempo change is a beat-period ratio beyond this. */
  splitRatio?: number;
  /** The previous slot's index is kept while it is within this (log) ratio
   * of the new slot's step: a section whose step sits between two indices
   * would otherwise flip between them slot by slot. */
  stickyIndex?: number;
  startStep?: number;
}

/**
 * Consecutive slots over the grid: 512 song steps each at the tempo index
 * nearest its mean step, cut short where the beat period jumps so no slot
 * plays two tempi at one speed.
 *
 * A cut is snapped to whole measures from the slot's start (a slot's loop
 * end is measure-granular, and the sequence player and the cart both play
 * the measure out), so the ≤ 8 steps between the true change and the cut
 * play at the neighbouring tempo — a stretch of under half a second —
 * rather than as silence. The tempo of a slot is read off the steps that
 * are its own: from the last true change to the next, not the displaced
 * ones. The scan for a change looks back only over the slot's own beats, so
 * the cut just made is never re-detected as a change.
 */
export function planSlots(grid: StepGrid, opts: PlanOptions = {}): SlotPlan[] {
  const g = (opts.grid ?? 16) === 8 ? 2 : 1;
  const measure = 16 * g;
  const minSplit = Math.max(measure, opts.minSplitSteps ?? measure);
  const ratio = opts.splitRatio ?? 1.08;
  const sticky = opts.stickyIndex ?? 0.03;
  const beats = grid.beats;
  const period = (b: number) => beats[b + 1] - beats[b];
  const beatCount = beats.length - 1;
  const medianPeriod = (from: number, to: number) => {
    const xs: number[] = [];
    for (let b = Math.max(0, from); b < Math.min(beatCount, to); b++) {
      xs.push(period(b));
    }
    return xs.length ? medianOf(xs) : 0;
  };
  const plans: SlotPlan[] = [];
  let start = opts.startStep ?? 0;
  // Where the slot's own tempo begins: the last true change, which a snapped
  // cut may have left a few steps inside this slot.
  let ownFrom = start;
  while (start < grid.steps) {
    const full = SONG_STEPS * g;
    let end = Math.min(grid.steps, start + full);
    // A tempo break: up to eight of the slot's own beats before against
    // eight after, from a measure in and at least four own beats in.
    const ownBeat = Math.ceil(ownFrom / STEPS_PER_BEAT);
    const firstBeat = Math.max(
      ownBeat + 4,
      Math.ceil((start + minSplit) / STEPS_PER_BEAT),
    );
    let breakStep = -1;
    for (let b = firstBeat; b * STEPS_PER_BEAT < end && b < beatCount; b++) {
      const before = medianPeriod(Math.max(ownBeat, b - 8), b);
      const after = medianPeriod(b, b + 8);
      if (before > 0 && after > 0) {
        const r = after / before;
        // The change is the first beat that already moves at the new tempo.
        const own = period(b);
        const toAfter = Math.abs(Math.log(own / after));
        const toBefore = Math.abs(Math.log(own / before));
        if ((r > ratio || r < 1 / ratio) && toAfter < toBefore) {
          breakStep = b * STEPS_PER_BEAT;
          break;
        }
      }
    }
    if (breakStep >= 0) {
      const measures = Math.max(1, Math.round((breakStep - start) / measure));
      const cut = start + measures * measure;
      // A change inside the last measure of a full slot is not worth a cut:
      // the next slot starts within half a measure of it anyway.
      if (cut < end) end = cut;
    }
    // Whole song steps only.
    const count = Math.max(g, Math.floor((end - start) / g) * g);
    const slotEnd = Math.min(start + count, grid.steps);
    // The slot's own steps: from the last true change to the next.
    let ownTo = breakStep >= 0 && breakStep < slotEnd ? breakStep : slotEnd;
    let from = Math.min(ownFrom, slotEnd);
    if (ownTo - from < g) {
      from = start;
      ownTo = slotEnd;
    }
    const sourceStepSeconds = (grid.bounds[ownTo] - grid.bounds[from]) /
      ((ownTo - from) / g);
    let tempoIndex = tempoIndexForStepSeconds(sourceStepSeconds) as number;
    const prev = plans[plans.length - 1];
    if (
      prev &&
      Math.abs(Math.log(prev.stepSeconds / sourceStepSeconds)) <= sticky
    ) {
      tempoIndex = prev.tempoIndex;
    }
    const stepSeconds = stepSecondsOf(tempoIndex) as number;
    plans.push({
      startStep: start,
      stepCount: slotEnd - start,
      grid: g,
      tempoIndex,
      sourceStepSeconds,
      stepSeconds,
      tempoError: stepSeconds / sourceStepSeconds - 1,
    });
    ownFrom = Math.max(slotEnd, breakStep);
    start = slotEnd;
  }
  return plans;
}

export interface SongEvent {
  step: number;
  note: number;
  instrument: number;
  len: number;
}

export interface TranscribedSlot extends SlotPlan {
  index: number;
  bytes: Uint8Array;
  parts: SongEvent[][];
  loopEnd: number;
  /** Source seconds the slot covers. */
  startTime: number;
  endTime: number;
  bpm: number;
  /** Seconds the slot takes to play (512 or fewer steps at its index). */
  playSeconds: number;
}

export interface EncodeOptions {
  echo?: number;
  /** Kick, snare and hat instruments, in the order a pair's two strikes are
   * kept at an eighth grid (a kick over a snare over a hat). */
  drumInstruments?: number[];
}

/** The slots' bytes, through the engine's encoder. */
export function encodeSlots(
  cells: (Cell | null)[][],
  plans: SlotPlan[],
  grid: StepGrid,
  opts: EncodeOptions = {},
): TranscribedSlot[] {
  const echo = opts.echo ?? 3;
  const order = opts.drumInstruments ??
    [
      DEFAULT_INSTRUMENTS.kick,
      DEFAULT_INSTRUMENTS.snare,
      DEFAULT_INSTRUMENTS.hat,
    ];
  const rank = (c: Cell) => {
    const i = order.indexOf(c.instrument);
    return i < 0 ? order.length : i;
  };
  const preferDrum = (a: Cell, b: Cell) => (rank(b) < rank(a) ? b : a);
  return plans.map((plan, index) => {
    const songSteps = Math.floor(plan.stepCount / plan.grid);
    const parts = cells.map((line, part) => {
      let slice = line.slice(plan.startStep, plan.startStep + plan.stepCount);
      if (plan.grid > 1) {
        slice = downsampleCells(
          slice,
          plan.grid,
          part === 3 ? preferDrum : undefined,
        );
      }
      slice = slice.slice(0, songSteps);
      // A tie at the slot's first step has nothing to hold: strike it.
      if (slice[0]?.tie) slice[0] = { ...slice[0], tie: false };
      return cellsToEvents(slice) as SongEvent[];
    });
    const loopEnd = songSteps >= SONG_STEPS
      ? 31
      : Math.max(0, Math.ceil(songSteps / 16) - 1);
    const bytes = encodeDezaSong({
      tempoIndex: plan.tempoIndex,
      echo,
      loopStart: 0,
      loopEnd,
      parts,
    }) as Uint8Array;
    const endStep = Math.min(grid.steps, plan.startStep + plan.stepCount);
    return {
      ...plan,
      index,
      bytes,
      parts,
      loopEnd,
      startTime: grid.bounds[plan.startStep],
      endTime: grid.bounds[endStep],
      // A song step is `grid` sixteenths, so the beat is `grid` times the
      // index's own sixteenth-beat.
      bpm: (bpmOfTempoIndex(plan.tempoIndex) as number) * plan.grid,
      playSeconds: (loopEnd + 1) * 16 * plan.stepSeconds,
    };
  });
}

// ── Downbeats ───────────────────────────────────────────────────────────────

/**
 * Which of the four beat phases carries the downbeat: the one whose beats
 * take the most kick and broadband flux over the tracked beats.
 */
export function downbeatPhase(
  onsets: OnsetAnalysis,
  beats: Float64Array,
  firstTracked: number,
  maxBeats = 128,
): number {
  const sums = [0, 0, 0, 0];
  const at = (t: number) => {
    const f = Math.round((t - onsets.t0) * onsets.fps);
    if (f < 1 || f + 1 >= onsets.flux.length) return 0;
    const m = (x: Float32Array) => Math.max(x[f - 1], x[f], x[f + 1]);
    return m(onsets.lowFlux) * 2 + m(onsets.flux);
  };
  const end = Math.min(beats.length, firstTracked + maxBeats);
  for (let b = firstTracked; b < end; b++) {
    sums[(b - firstTracked) % 4] += at(beats[b]);
  }
  let best = 0;
  for (let p = 1; p < 4; p++) if (sums[p] > sums[best]) best = p;
  return best;
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface VoiceProfile {
  /** Harmonic amplitudes 0..1, h[0] the fundamental. */
  h: number[];
  a: number;
  d: number;
  s: number;
  r: number;
  /** Noisiness 0..1; the runtime plays ≥ 0.75 as pitched noise. */
  n: number;
  /** The bank's attenuation (volAdj), dB-ish steps; 0 is loudest. */
  vol: number;
}

interface VoiceJsonLayer {
  lo: number;
  hi: number;
  a: number;
  d: number;
  s: number;
  r: number;
  h: number[];
  n: number;
  vol: number;
}

/** The harmonic profiles the production runtime plays with, by instrument. */
export async function loadVoiceProfiles(
  path = join(
    repoRoot(),
    "packages",
    "shmup-engine",
    "data",
    "bgm-voices.json",
  ),
): Promise<Map<number, VoiceProfile>> {
  const json = JSON.parse(await Deno.readTextFile(path)) as {
    voices: { i: number; layers: VoiceJsonLayer[] }[];
  };
  const out = new Map<number, VoiceProfile>();
  for (const v of json.voices) {
    const layer = v.layers.find((l) => l.lo <= 60 && 60 <= l.hi) ?? v.layers[0];
    if (!layer) continue;
    const peak = Math.max(1, ...layer.h);
    out.set(v.i, {
      h: layer.h.map((x) => x / peak),
      a: layer.a,
      d: layer.d,
      s: layer.s,
      r: layer.r,
      n: layer.n,
      vol: layer.vol,
    });
  }
  return out;
}

/** The runtime's fixed part mix. */
export const PART_GAINS = [1, 0.8, 1.2, 0.5];
export const NOISE_THRESHOLD = 0.75;

/** Where the slots' steps fall in a render: start times of every song step. */
export function renderBounds(slots: TranscribedSlot[]): Float64Array[] {
  let at = 0;
  return slots.map((slot) => {
    const songSteps = Math.floor(slot.stepCount / slot.grid);
    const b = new Float64Array(songSteps + 1);
    for (let i = 0; i <= songSteps; i++) b[i] = at + i * slot.stepSeconds;
    at += slot.playSeconds;
    return b;
  });
}

/**
 * The slots as audio, from the bank's harmonic profiles: additive partials
 * under an ADSR for pitched voices, a filtered noise burst for the noise
 * instruments, the runtime's part gains. Mono, so a human can listen and a
 * chroma can be compared; not the Saturn's sound.
 */
export function renderSlots(
  slots: TranscribedSlot[],
  profiles: Map<number, VoiceProfile>,
  sampleRate = 22050,
): Float32Array {
  const total = slots.reduce((t, s) => t + s.playSeconds, 0);
  const out = new Float32Array(Math.ceil(total * sampleRate) + sampleRate);
  const bounds = renderBounds(slots);
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  slots.forEach((slot, si) => {
    const b = bounds[si];
    slot.parts.forEach((events, part) => {
      const gain = PART_GAINS[part] ?? 1;
      for (const e of events) {
        const prof = profiles.get(e.instrument) ??
          { h: [1], a: 0, d: 0.3, s: 0.5, r: 0.05, n: 0, vol: -50 };
        const level = gain * 10 ** (prof.vol * 0.375 / 20 * 0.5);
        const hz = midiToHz(e.note + 35);
        const t0 = b[e.step];
        const hold = e.len * slot.stepSeconds;
        const release = Math.max(0.02, Math.min(0.4, prof.r || 0.05));
        const dur = hold + release;
        const i0 = Math.floor(t0 * sampleRate);
        const count = Math.min(out.length - i0, Math.ceil(dur * sampleRate));
        const noise = prof.n >= NOISE_THRESHOLD;
        // One-pole low-pass for noise, cutoff following the pitch byte.
        const cutoff = Math.min(0.95, hz / 2000);
        let lp = 0;
        const partials: number[] = [];
        if (!noise) {
          for (let h = 0; h < prof.h.length; h++) {
            if (prof.h[h] > 0.02 && (h + 1) * hz < sampleRate / 2) {
              partials.push(h);
            }
          }
        }
        for (let i = 0; i < count; i++) {
          const t = i / sampleRate;
          let env: number;
          if (t < prof.a && prof.a > 0) env = t / prof.a;
          else if (t < hold) {
            const td = t - prof.a;
            env = prof.d > 0
              ? prof.s + (1 - prof.s) * Math.exp(-3 * td / prof.d)
              : prof.s;
          } else {
            const rel = (t - hold) / release;
            const atHold = prof.d > 0
              ? prof.s + (1 - prof.s) * Math.exp(-3 * (hold - prof.a) / prof.d)
              : prof.s;
            env = atHold * Math.max(0, 1 - rel);
          }
          let v = 0;
          if (noise) {
            lp += cutoff * (rand() - lp);
            v = lp * 2.5 * (noise ? Math.exp(-6 * t / Math.max(0.1, dur)) : 1);
          } else {
            for (const h of partials) {
              v += prof.h[h] * Math.sin(2 * Math.PI * (h + 1) * hz * t);
            }
            v *= 0.5;
          }
          out[i0 + i] += v * env * level;
        }
      }
    });
  });
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.9) {
    const g = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

/** A 16-bit mono WAV. */
export async function writeWav(
  path: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  await Deno.writeFile(path, bytes);
}

// ── Verification ────────────────────────────────────────────────────────────

export interface SlotScore {
  index: number;
  /** Mean per-beat chroma cosine, source against render. */
  chroma: number;
  beats: number;
  onsetF: number;
  onsetPrecision: number;
  onsetRecall: number;
  /** Against the locally thresholded source peaks. */
  onsetFLocal: number;
}

export interface Verification {
  chromaMean: number;
  /** Against the source's flux peaks over a whole-song threshold. */
  onsetF: number;
  onsetPrecision: number;
  onsetRecall: number;
  sourceOnsets: number;
  transcribedOnsets: number;
  /** The same against peaks over a 25 s rolling threshold (floored at half
   * the song's), which still counts a quiet passage's onsets. */
  onsetFLocal: number;
  sourceOnsetsLocal: number;
  slots: SlotScore[];
}

function cosine(
  a: Float32Array | Float64Array,
  b: Float32Array | Float64Array,
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return NaN;
  return dot / Math.sqrt(na * nb);
}

/** Precision, recall and F of `found` against `truth` (seconds, ±tolerance). */
export function onsetAgreement(
  truth: number[],
  found: number[],
  tolerance = 0.07,
): { f: number; precision: number; recall: number } {
  const a = truth.slice().sort((x, y) => x - y);
  const b = found.slice().sort((x, y) => x - y);
  let i = 0;
  let j = 0;
  let hits = 0;
  while (i < a.length && j < b.length) {
    const d = b[j] - a[i];
    if (Math.abs(d) <= tolerance) {
      hits++;
      i++;
      j++;
    } else if (d < 0) j++;
    else i++;
  }
  const precision = b.length ? hits / b.length : 0;
  const recall = a.length ? hits / a.length : 0;
  const f = precision + recall
    ? (2 * precision * recall) / (precision + recall)
    : 0;
  return { f, precision, recall };
}

/**
 * Judge the slots against the source: per-beat chroma cosine between the
 * source's tracked steps and the render's playback steps, and an onset
 * F-measure at ±70 ms between the lead and drum strikes (in source time)
 * and the source's own flux peaks.
 */
export function verifyTranscription(
  source: { pitches: StepPitch[]; grid: StepGrid; onsets: OnsetAnalysis },
  slots: TranscribedSlot[],
  rendered: Float32Array,
  sampleRate = 22050,
): Verification {
  const render: DecodedAudio = {
    samples: rendered,
    sampleRate,
    peak: 1,
    duration: rendered.length / sampleRate,
  };
  const rb = renderBounds(slots);
  const flat: number[] = [];
  const owner: { slot: number; songStep: number }[] = [];
  rb.forEach((b, si) => {
    for (let i = 0; i + 1 < b.length; i++) {
      flat.push(b[i]);
      owner.push({ slot: si, songStep: i });
    }
  });
  flat.push(rb.length ? rb[rb.length - 1][rb[rb.length - 1].length - 1] : 0);
  const renderChroma: Float32Array[] = owner.map(() => new Float32Array(12));
  const binHz = sampleRate / 4096;
  stepSpectra(
    render,
    Float64Array.from(flat),
    { n: 4096, hop: 512 },
    (step, mag) => {
      chromaOf(mag, binHz, renderChroma[step]);
    },
  );

  const frameTime = (f: number) => source.onsets.t0 + f / source.onsets.fps;
  const sourceOnsets = pickFluxPeaks(source.onsets.flux, { deltaFrac: 0.12 })
    .map(frameTime);
  const sourceOnsetsLocal = pickFluxPeaks(source.onsets.flux, {
    deltaFrac: 0.12,
    localFrames: Math.round(25 * source.onsets.fps),
    localFloor: 0.5,
  }).map(frameTime);

  const slotScores: SlotScore[] = [];
  let chromaSum = 0;
  let chromaN = 0;
  const allFound: number[] = [];
  let flatIndex = 0;
  for (const slot of slots) {
    const songSteps = Math.floor(slot.stepCount / slot.grid);
    let sum = 0;
    let n = 0;
    const perBeat = STEPS_PER_BEAT / slot.grid;
    for (let b = 0; b * perBeat < songSteps; b++) {
      const src = new Float32Array(12);
      const ren = new Float32Array(12);
      for (let k = 0; k < perBeat; k++) {
        const ss = b * perBeat + k;
        if (ss >= songSteps) break;
        const g = slot.startStep + ss * slot.grid;
        for (let j = 0; j < slot.grid; j++) {
          const p = source.pitches[g + j];
          if (p) { for (let c = 0; c < 12; c++) src[c] += p.chroma[c]; }
        }
        const r = renderChroma[flatIndex + ss];
        if (r) { for (let c = 0; c < 12; c++) ren[c] += r[c]; }
      }
      const cs = cosine(src, ren);
      if (!Number.isNaN(cs)) {
        sum += cs;
        n++;
      }
    }
    flatIndex += songSteps;
    const found: number[] = [];
    for (const part of [0, 3]) {
      for (const e of slot.parts[part] ?? []) {
        const g = slot.startStep + e.step * slot.grid;
        if (g < source.grid.steps) found.push(source.grid.bounds[g]);
      }
    }
    const uniq = [...new Set(found.map((t) => Math.round(t * 1000)))].map((t) =>
      t / 1000
    );
    const inSlot = (t: number) => t >= slot.startTime && t < slot.endTime;
    const ag = onsetAgreement(sourceOnsets.filter(inSlot), uniq);
    const agLocal = onsetAgreement(sourceOnsetsLocal.filter(inSlot), uniq);
    allFound.push(...uniq);
    slotScores.push({
      index: slot.index,
      chroma: n ? sum / n : NaN,
      beats: n,
      onsetF: ag.f,
      onsetPrecision: ag.precision,
      onsetRecall: ag.recall,
      onsetFLocal: agLocal.f,
    });
    chromaSum += sum;
    chromaN += n;
  }
  const ag = onsetAgreement(sourceOnsets, allFound);
  const agLocal = onsetAgreement(sourceOnsetsLocal, allFound);
  return {
    chromaMean: chromaN ? chromaSum / chromaN : NaN,
    onsetF: ag.f,
    onsetPrecision: ag.precision,
    onsetRecall: ag.recall,
    sourceOnsets: sourceOnsets.length,
    transcribedOnsets: allFound.length,
    onsetFLocal: agLocal.f,
    sourceOnsetsLocal: sourceOnsetsLocal.length,
    slots: slotScores,
  };
}

// ── The whole thing ─────────────────────────────────────────────────────────

export interface TranscribeOptions {
  ffmpeg?: string;
  sampleRate?: number;
  stageCount?: number;
  maxSlots?: number;
  grid?: 16 | 8;
  echo?: number;
  sfxSet?: number;
  instruments?: Partial<InstrumentChoice>;
  parts?: PartName[];
  tempo?: TempoOptions;
  beats?: BeatOptions;
  pitch?: PitchOptions;
  drums?: DrumOptions;
  assign?: AssignOptions;
  plan?: Omit<PlanOptions, "grid">;
  /** Skip the render and the scores (they cost a few seconds). */
  verify?: boolean;
  /** Where to write the render, if anywhere. */
  renderPath?: string;
  log?: (line: string) => void;
}

export interface TranscribeTimings {
  decodeMs: number;
  onsetMs: number;
  tempoMs: number;
  beatMs: number;
  pitchMs: number;
  drumMs: number;
  assignMs: number;
  encodeMs: number;
  renderMs: number;
  verifyMs: number;
  totalMs: number;
}

export interface TranscribeResult {
  audio: { duration: number; sampleRate: number; peak: number };
  grid: 16 | 8;
  /** Set when the sixteenth grid did not fit and eighths were used instead. */
  gridFallback: string | null;
  tempo: TempoPath;
  beats: Float64Array;
  stepGrid: StepGrid;
  downbeatPhase: number;
  /** The per-step analysis the slots were cut from, for inspection or a
   * second assignment without re-listening. */
  pitches: StepPitch[];
  drums: StepDrums[];
  cells: (Cell | null)[][];
  slots: TranscribedSlot[];
  dezaemonBgm: unknown;
  verification: Verification | null;
  timings: TranscribeTimings;
}

/** MP3 (or anything ffmpeg reads) in, `dezaemonBgm` and its evidence out. */
export async function transcribe(
  input: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const log = opts.log ?? (() => {});
  const maxSlots = opts.maxSlots ?? 24;
  const tAll = performance.now();
  let t = performance.now();
  const lap = () => {
    const now = performance.now();
    const ms = now - t;
    t = now;
    return ms;
  };

  const audio = await decodeAudio(input, {
    ffmpeg: opts.ffmpeg,
    sampleRate: opts.sampleRate,
  });
  const decodeMs = lap();
  log(
    `decoded ${audio.duration.toFixed(1)} s at ${audio.sampleRate} Hz (peak ${
      audio.peak.toFixed(3)
    }) in ${decodeMs.toFixed(0)} ms`,
  );

  const onsets = analyseOnsets(audio);
  const onsetMs = lap();
  const tempo = estimateTempoPath(onsets, opts.tempo);
  const tempoMs = lap();
  for (const s of tempo.sections) {
    log(
      `tempo ${fmtTime(s.start)}–${fmtTime(s.end)}: ${s.bpm.toFixed(1)} BPM`,
    );
  }
  const beats = trackBeats(onsets, tempo, opts.beats);
  const beatMs = lap();
  log(`${beats.length} beats tracked in ${beatMs.toFixed(0)} ms`);

  // A provisional grid finds the downbeat; the real one starts on it.
  const provisional = buildStepGrid(beats, audio.duration, 0);
  const phase = downbeatPhase(
    onsets,
    provisional.beats,
    provisional.firstTrackedBeat,
  );
  const lead = (4 - ((provisional.firstTrackedBeat + phase) % 4)) % 4;
  const stepGrid = buildStepGrid(beats, audio.duration, lead);

  const pitches = analysePitches(audio, stepGrid, opts.pitch);
  const pitchMs = lap();
  log(`${stepGrid.steps} steps of pitch in ${pitchMs.toFixed(0)} ms`);
  const drums = detectDrums(onsets, stepGrid, opts.drums);
  const drumMs = lap();

  const cells = assignParts(pitches, drums, {
    ...opts.assign,
    instruments: opts.instruments,
    parts: opts.parts,
  });
  const assignMs = lap();

  let gridChoice: 16 | 8 = opts.grid ?? 16;
  let gridFallback: string | null = null;
  let plans = planSlots(stepGrid, { ...opts.plan, grid: gridChoice });
  if (plans.length > maxSlots && gridChoice === 16) {
    gridFallback =
      `${plans.length} slots at a sixteenth grid exceed --max-slots ${maxSlots}; ` +
      `fell back to --grid 8 (one step = an eighth, half the rhythmic resolution)`;
    log(gridFallback);
    gridChoice = 8;
    plans = planSlots(stepGrid, { ...opts.plan, grid: 8 });
  }
  if (plans.length > maxSlots) {
    throw new Error(
      `${plans.length} slots even at an eighth grid; the bank holds ${maxSlots}. ` +
        `Nothing was truncated — cut the source or raise --max-slots (≤ 24).`,
    );
  }
  const inst = { ...DEFAULT_INSTRUMENTS, ...(opts.instruments ?? {}) };
  const slots = encodeSlots(cells, plans, stepGrid, {
    echo: opts.echo,
    drumInstruments: [inst.kick, inst.snare, inst.hat],
  });
  const dezaemonBgm = buildDezaemonBgm({
    songs: slots.map((s) => s.bytes),
    stageCount: opts.stageCount ?? 5,
    sfxSet: opts.sfxSet ?? 1,
  });
  const encodeMs = lap();

  let verification: Verification | null = null;
  let renderMs = 0;
  let verifyMs = 0;
  if (opts.verify !== false || opts.renderPath) {
    const profiles = await loadVoiceProfiles();
    const rendered = renderSlots(slots, profiles, 22050);
    renderMs = lap();
    if (opts.renderPath) await writeWav(opts.renderPath, rendered, 22050);
    if (opts.verify !== false) {
      verification = verifyTranscription(
        { pitches, grid: stepGrid, onsets },
        slots,
        rendered,
        22050,
      );
    }
    verifyMs = lap();
  }

  return {
    audio: {
      duration: audio.duration,
      sampleRate: audio.sampleRate,
      peak: audio.peak,
    },
    grid: gridChoice,
    gridFallback,
    tempo,
    beats,
    stepGrid,
    downbeatPhase: phase,
    pitches,
    drums,
    cells,
    slots,
    dezaemonBgm,
    verification,
    timings: {
      decodeMs,
      onsetMs,
      tempoMs,
      beatMs,
      pitchMs,
      drumMs,
      assignMs,
      encodeMs,
      renderMs,
      verifyMs,
      totalMs: performance.now() - tAll,
    },
  };
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}
