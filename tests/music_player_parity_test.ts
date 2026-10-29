// The editor's song player (packages/shmup-engine/src/audio/bgm-player.js)
// sounds like the game's (game.bundle.js, a vendored artifact patched by hand).
//
// Two things are held equal, against the bundle's own functions lifted out of
// it and run on a fake AudioContext that writes down every node, connection,
// parameter change and start/stop:
//
//   one note    playBgmNote with and without tone-bank samples: the same node
//               graph, the same envelope, the same playback rates
//   a schedule  every note scheduleBgm sends over a minute of play — loops
//               included — at the same time, pitch, length, instrument and mix
//
// so a change to the runtime's player that is not ported into the engine's
// (or the reverse) fails here.

import { assert, assertEquals } from "@std/assert";
import {
  __runtimePort,
  createBgmPlayer,
  PART_VOICES,
} from "../packages/shmup-engine/src/audio/bgm-player.js";
import {
  bytesToB64,
  emptySong,
} from "../packages/shmup-engine/src/audio/bgm-record.js";
import {
  placeNote,
  setHeader,
  setRhythm,
} from "../packages/shmup-engine/src/audio/song-edit.js";
import {
  hasPresetCorpus,
  presetSongs,
} from "../packages/shmup-engine/test/_song-corpus.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const js = (await Deno.readTextFile(new URL(`../${BUNDLE}`, import.meta.url)))
  .replaceAll("\r\n", "\n");

function functionSource(name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

function varSource(name: string): string {
  const start = js.indexOf(`\n  var ${name} = `);
  assert(start >= 0, `no var ${name} in ${BUNDLE}`);
  // A `var` that is an array of objects spans lines; it ends at the first
  // "];" or ";" that closes the statement at the IIFE's indent.
  const end = js.indexOf(";\n", start);
  return js.slice(start, end + 2);
}

// deno-lint-ignore no-explicit-any
type Any = any;
const r = (v: number) => Math.round(v * 1e6) / 1e6;

/** A Web Audio context that only writes down what is asked of it. */
function fakeCtx(log: string[], sampleRate = 48000) {
  const param = (owner: string, name: string, init = 0) => {
    let v = init;
    return {
      get value() {
        return v;
      },
      set value(x: number) {
        v = x;
        log.push(`${owner}.${name}=${r(x)}`);
      },
      setValueAtTime: (x: number, t: number) => log.push(`${owner}.${name}.set(${r(x)},${r(t)})`),
      linearRampToValueAtTime: (x: number, t: number) => log.push(`${owner}.${name}.ramp(${r(x)},${r(t)})`),
      setTargetAtTime: (x: number, t: number, c: number) =>
        log.push(`${owner}.${name}.target(${r(x)},${r(t)},${r(c)})`),
    };
  };
  const node = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    connect(to: { type: string }) {
      log.push(`${type}->${to.type}`);
      return to;
    },
    disconnect() {},
    ...extra,
  });
  const ctx: Any = {
    currentTime: 0,
    sampleRate,
    destination: node("Destination"),
    createGain: () => {
      log.push("createGain");
      const n: Any = node("Gain");
      n.gain = param("Gain", "gain", 1);
      return n;
    },
    createStereoPanner: () => {
      log.push("createStereoPanner");
      const n: Any = node("Panner");
      n.pan = param("Panner", "pan");
      return n;
    },
    createDelay: () => {
      const n: Any = node("Delay");
      n.delayTime = param("Delay", "delayTime");
      return n;
    },
    createBuffer: (ch: number, len: number, rate: number) => {
      log.push(`createBuffer(${ch},${len},${rate})`);
      const data = new Float32Array(len);
      return { length: len, sampleRate: rate, getChannelData: () => data };
    },
    createPeriodicWave: (real: Float32Array, imag: Float32Array) => {
      log.push(`createPeriodicWave(${real.length},${r(imag.reduce((a, b) => a + b, 0))})`);
      return { type: "Wave" };
    },
    createOscillator: () => {
      log.push("createOscillator");
      const n: Any = node("Osc");
      n.frequency = param("Osc", "frequency", 440);
      n.setPeriodicWave = () => log.push("setPeriodicWave");
      n.start = (t: number) => log.push(`Osc.start(${r(t)})`);
      n.stop = (t: number) => log.push(`Osc.stop(${r(t)})`);
      return n;
    },
    createBufferSource: () => {
      log.push("createBufferSource");
      const n: Any = node("Source");
      n.playbackRate = param("Source", "playbackRate", 1);
      n.start = (t: number) =>
        log.push(
          `Source.start(${r(t)}) buf=${n.buffer?.length}@${n.buffer?.sampleRate} loop=${!!n.loop} ${r(n.loopStart || 0)}-${
            r(n.loopEnd || 0)
          }`,
        );
      n.stop = (t: number) => log.push(`Source.stop(${r(t)})`);
      return n;
    },
  };
  return ctx;
}

/** The bundle's note player, with its tone bank settable from outside. */
function runtimeNotePlayer() {
  return new Function(
    [
      varSource("DEZA_NOTE_A"),
      functionSource("dezaNoteFreq"),
      varSource("DEZA_BGM_VOICES"),
      functionSource("dezaVoice"),
      "var DEZA_TONE_BANK = null;",
      functionSource("dezaSampleBuffer"),
      functionSource("dezaSamples"),
      functionSource("playBgmNote"),
      "return { playBgmNote, setBank: (b) => { DEZA_TONE_BANK = b; } };",
    ].join("\n"),
  )() as { playBgmNote: (...a: Any[]) => void; setBank: (b: Any) => void };
}

/** A small bank in the published shape: detune pairs, a one-shot, a split. */
function syntheticBank() {
  const slices = [
    { at: 0, samples: 400, loop: true, loopStart: 120 },
    { at: 400, samples: 300, loop: false, loopStart: 0 },
    { at: 700, samples: 900, loop: true, loopStart: 850 },
  ];
  const pcm = new Int16Array(1600).map((_, i) => ((i * 977) % 65536) - 32768);
  const instruments = Array.from({ length: 116 }, (_, i) => ({
    layers: [
      { slice: i % 3, noteLo: 0, noteHi: 80, rootPitch: 84, fineTune: -10, level: i % 7, pan: 0 },
      { slice: (i + 1) % 3, noteLo: 0, noteHi: 80, rootPitch: 84, fineTune: 10, level: 3, pan: 0 },
      { slice: (i + 2) % 3, noteLo: 81, noteHi: 127, rootPitch: 96, fineTune: 0, level: 0, pan: 0 },
    ],
  }));
  return { sampleRate: 14848, slices, instruments, pcm };
}

const NOTES: [number, number, number][] = [
  // [instrument, scale note, length in steps]
  [0, 79, 4],
  [13, 88, 1],
  [20, 70, 2], // a noisy voice: pitched noise without samples
  [41, 57, 8],
  [59, 112, 3],
  [63, 64, 2], // an accompaniment instrument
];

for (const withBank of [false, true]) {
  Deno.test(`one note: the editor's player builds the runtime's node graph (${withBank ? "tone-bank samples" : "periodic voices"})`, () => {
    const runtime = runtimeNotePlayer();
    const bank = withBank ? syntheticBank() : null;
    runtime.setBank(bank);
    for (const [inst, note, len] of NOTES) {
      for (const mix of PART_VOICES) {
        const a: string[] = [];
        const b: string[] = [];
        const ca = fakeCtx(a);
        const cb = fakeCtx(b);
        const sta = { ctx: ca, master: ca.createGain(), noise: { length: 1 }, stepSeconds: 0.125 };
        const stb = { ctx: cb, master: cb.createGain(), noise: { length: 1 }, stepSeconds: 0.125, bank };
        a.length = 0;
        b.length = 0;
        runtime.playBgmNote(sta, { gain: mix.gain, pan: mix.pan }, { len, inst }, 1.5, note);
        __runtimePort.playBgmNote(stb, { gain: mix.gain, pan: mix.pan }, { len, inst }, 1.5, note);
        assertEquals(b, a, `inst ${inst} note ${note} gain ${mix.gain}`);
      }
    }
  });
}

/** The bundle's scheduler, recording every note it would play. */
function runtimeSchedule(bytes: Uint8Array, seconds: number, tick: number) {
  const notes: string[] = [];
  const api = new Function(
    "record",
    [
      varSource("DEZA_TEMPO_TABLE"),
      functionSource("bgmStepSeconds"),
      varSource("BGM_LOOKAHEAD"),
      functionSource("b64ToBytes"),
      varSource("DEZA_ACCOMP_B64"),
      varSource("DEZA_ACCOMP_TRANSPOSE"),
      "var dezaAccompTable = null;",
      functionSource("accompTable"),
      functionSource("buildAccompParts"),
      functionSource("parseBgmSong"),
      varSource("PART_VOICES"),
      varSource("ACCOMP_VOICE"),
      varSource("ACCOMP_DELAY"),
      functionSource("loadBgmSlot"),
      functionSource("scheduleBgm"),
      "function playBgmNote(st, mix, e, t, scaleNote) { record(mix, e, t, scaleNote); }",
      "return { loadBgmSlot, scheduleBgm };",
    ].join("\n"),
  )((mix: Any, e: Any, t: number, n: number) =>
    notes.push(`${r(t)} n${n} i${e.inst} l${e.len} g${mix.gain} p${r(mix.pan)}`)
  ) as Any;
  const ctx = { currentTime: 0 };
  const st: Any = { ctx, bgm: { songs: { 0: bytesToB64(bytes) } }, cursor: [], startTime: 0.05, loop: 0, scheduled: 0 };
  api.loadBgmSlot(st, 0);
  for (let time = 0; time <= seconds; time += tick) {
    ctx.currentTime = time;
    api.scheduleBgm(null, st);
  }
  return notes.sort();
}

function engineSchedule(bytes: Uint8Array, seconds: number, tick: number) {
  const notes: string[] = [];
  const log: string[] = [];
  const ctx = fakeCtx(log);
  let pump: () => void = () => {};
  const timers = {
    setInterval: (fn: () => void) => {
      pump = fn;
      return 1;
    },
    clearInterval: () => {},
  };
  const player = createBgmPlayer(ctx, {
    timers,
    trace: ({ e, t, scaleNote, mix }: Any) =>
      notes.push(`${r(t)} n${scaleNote} i${e.inst} l${e.len} g${mix.gain} p${r(mix.pan)}`),
  });
  player.load(bytes).play();
  for (let time = 0; time <= seconds; time += tick) {
    ctx.currentTime = time;
    pump();
  }
  return notes.sort();
}

function song() {
  let s = emptySong();
  s = placeNote(s, { part: 0, step: 0, len: 6, pitch: 25, inst: 13 });
  s = placeNote(s, { part: 1, step: 8, len: 30, pitch: 10, inst: 18 });
  s = placeNote(s, { part: 2, step: 40, len: 2, pitch: 37, inst: 23 });
  s = placeNote(s, { part: 3, step: 63, len: 1, pitch: 50, inst: 48 });
  s = setRhythm(s, 1, { bank: 3, pattern: 2, chord: 1, key: 5 });
  s = setRhythm(s, 2, { bank: 6, pattern: 0, chord: 3, key: 10 });
  return setHeader(s, { loopStart: 1, loopEnd: 3, tempoIndex: 26, echo: 4 });
}

Deno.test("a schedule: the editor plays every note the runtime does, when it does, loops included", () => {
  const s = song();
  const a = runtimeSchedule(s, 60, 0.09);
  const b = engineSchedule(s, 60, 0.09);
  assert(a.length > 100, `only ${a.length} notes in a minute`);
  assertEquals(b, a);
});

Deno.test("a song whose loop holds no note plays once and then rests — the runtime used to spin forever", () => {
  // Everything before the loop: a play-once jingle (M_DATA12 and M_DATA68
  // are shaped like this, and 433 cart slots).
  let s = placeNote(emptySong(), { part: 0, step: 0, len: 8, pitch: 30, inst: 5 });
  s = setHeader(s, { loopStart: 2, loopEnd: 3, tempoIndex: 31 });
  const a = runtimeSchedule(s, 30, 0.09);
  assertEquals(a.length, 1);
  assertEquals(engineSchedule(s, 30, 0.09), a);
});

// The SET LIST's title, game over and stage clear rows reach the web game too
// (a cart plays them; the runtime used to start only stage, boss and a drawn
// title). Each falls back to the stock music when its tape does not sound.
Deno.test("the runtime plays the set list's title, game over and stage clear tapes", () => {
  const title = js.slice(js.indexOf("\n  var PhaserTitleScene = class"), js.indexOf("\n  var PhaserAdvScene = class"));
  assert(/if \(!gameState\.lowModeFlg\) \{\n\s+startDezaemonBgm\(this, "title"\);/.test(title), "title: any level with a title tape");
  const clear = js.slice(js.indexOf("\n    stageClear() {"), js.indexOf("\n    stageClear() {") + 900);
  assert(clear.includes('startDezaemonBgm(this, "clear")'), "stage clear starts the clear tape");
  assert(clear.includes("!dezaBgmSequence(this.recipe.dezaemonBgm)"), "a one-piece soundtrack keeps its pause");
  const cont = js.slice(js.indexOf("\n  var PhaserContinueScene = class"), js.indexOf("\n  var PhaserEndingScene = class"));
  assert(cont.includes('startDezaemonBgm(this, "gameover")'), "game over starts the game-over tape");
  assert(/startDezaemonBgm\(this, "gameover"\)\)\) \{\n\s+this\.playSound\("bgm_gameover", 0\.4\);/.test(cont), "the stock jingle is the fallback");
  assert(cont.includes('this.events.once("shutdown", () => stopDezaemonBgm(this))'), "the tape stops with the scene");
});

Deno.test({
  name: "a schedule: all 73 presets play the same in the editor and the runtime",
  ignore: !hasPresetCorpus(),
  fn() {
    for (const p of presetSongs()) {
      assertEquals(engineSchedule(p.bytes, 45, 0.09), runtimeSchedule(p.bytes, 45, 0.09), p.name);
    }
  },
});
