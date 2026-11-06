// Haptics for a game that has none of its own (static/frame-haptics.js).
//
// The launcher installs it into a same-origin game frame when the frame loads;
// it rumbles with the game's sounds and the Guide's Haptics row governs it, the
// game's own vibrate and rumble calls included. These tests run it against a
// fake window — a pad that logs every effect, a phone's motor, timers moved by
// hand, and just enough Web Audio — and pin how Dashboard.svelte wires it.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  createOnsetDetector,
  installFrameHaptics,
  nativeHaptics,
  profileBuffer,
  pulseFor,
  rms,
  spectralFlux,
} from "../static/frame-haptics.js";

// ---- signals ----------------------------------------------------------------------

const SR = 44100;

/** A deterministic stream in -1..1, so a test never depends on Math.random. */
function prng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x80000000) - 1;
  };
}

/** A fake AudioBuffer over some samples. */
function buffer(samples: Float32Array, sampleRate = SR) {
  return {
    numberOfChannels: 1,
    sampleRate,
    length: samples.length,
    duration: samples.length / sampleRate,
    getChannelData: () => samples,
  };
}

/** Decaying noise: an explosion's shape. `rmsTarget` is the whole buffer's RMS. */
function boom(seconds: number, rmsTarget: number, decay = 0.15) {
  const n = Math.floor(seconds * SR);
  const rand = prng(7);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = rand() * Math.exp(-i / (SR * decay));
  const scale = rmsTarget / rms(d);
  for (let i = 0; i < n; i++) d[i] *= scale;
  return buffer(d);
}

/** A steady low tone with a decaying envelope: bass. */
function thump(seconds: number, rmsTarget: number, hz = 70) {
  const n = Math.floor(seconds * SR);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = Math.sin((2 * Math.PI * hz * i) / SR) * Math.exp(-i / (SR * 0.3));
  }
  const scale = rmsTarget / rms(d);
  for (let i = 0; i < n; i++) d[i] *= scale;
  return buffer(d);
}

/** A short bright blip: a shot. */
function blip(seconds: number, rmsTarget: number, hz = 2400) {
  const n = Math.floor(seconds * SR);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * hz * i) / SR);
  const scale = rmsTarget / rms(d);
  for (let i = 0; i < n; i++) d[i] *= scale;
  return buffer(d);
}

// ---- the onset detector -----------------------------------------------------------

/** Feed `values` at 16 ms a tick from `t0`; the hits, with their times. */
function run(
  det: ReturnType<typeof createOnsetDetector>,
  values: number[],
  t0 = 0,
) {
  const hits: { at: number; magnitude: number; ms: number }[] = [];
  values.forEach((v, i) => {
    const at = t0 + i * 16;
    const h = det.push(v, at);
    if (h) hits.push({ at, ...h });
  });
  return hits;
}

Deno.test("detector: silence, and a steady sound however loud, are never a hit", () => {
  assertEquals(run(createOnsetDetector(), new Array(300).fill(0)), []);
  // A flux that never moves: the music holding a chord.
  assertEquals(run(createOnsetDetector(), new Array(600).fill(0.04)), []);
  // Under the floor: noise.
  const det = createOnsetDetector();
  const hush = Array.from(
    { length: 300 },
    (_, i) => (i % 7 === 0 ? 0.04 : 0.002),
  );
  assertEquals(run(det, hush), []);
});

Deno.test("detector: a sound out of quiet is one pulse, stronger and longer the harder it hits", () => {
  const quietThen = (peak: number) => {
    const v = new Array(80).fill(0.005);
    v.push(peak, peak, peak * 0.6, peak * 0.3, peak * 0.1, 0, 0, 0, 0, 0);
    return v.concat(new Array(40).fill(0.005));
  };
  const soft = run(createOnsetDetector(), quietThen(0.09));
  const loud = run(createOnsetDetector(), quietThen(0.6));
  assertEquals(soft.length, 1, "one sound, one pulse");
  assertEquals(loud.length, 1, "one sound, one pulse");
  assert(loud[0].magnitude > soft[0].magnitude, "louder hits harder");
  assert(loud[0].ms > soft[0].ms, "and longer");
  assert(loud[0].magnitude <= 1 && soft[0].magnitude > 0);
  // It lands on the tick the sound arrives, not after it has gone.
  assertEquals(loud[0].at, 80 * 16);
});

Deno.test("detector: a busy soundtrack's own peaks are not hits, a sound well clear of them is", () => {
  const rand = prng(99);
  // Drum-heavy music: mostly modest, with peaks up to about 0.25.
  const music = Array.from({ length: 400 }, () => {
    const r = (rand() + 1) / 2;
    return r > 0.93 ? 0.18 + 0.07 * rand() : 0.03 + 0.05 * r;
  });
  const det = createOnsetDetector();
  const beds = run(det, music);
  // A little of it may sneak by while the bed is first learnt, none after.
  assert(
    beds.filter((h) => h.at > 4000).length === 0,
    "the soundtrack alone never triggers",
  );
  const hits = run(det, [0.03, 0.04, 0.9, 0.9, 0.5, 0.2, 0.05], 400 * 16);
  assertEquals(hits.length, 1, "an explosion over it does");
});

Deno.test("detector: a quiet game's hit is a hit, against its own bed", () => {
  const det = createOnsetDetector();
  run(det, new Array(300).fill(0.004));
  const hits = run(det, [0.004, 0.2, 0.2, 0.1, 0.01], 300 * 16);
  assertEquals(hits.length, 1);
});

Deno.test("detector: the tail of a decaying sound is not a second hit, a swell is", () => {
  const det = createOnsetDetector();
  run(det, new Array(120).fill(0.003));
  // A long decay: 0.6 falling over 40 ticks (640 ms).
  const decay = Array.from({ length: 40 }, (_, i) => 0.6 * Math.exp(-i / 9));
  assertEquals(run(det, decay, 120 * 16).length, 1);
  // A sound that keeps building: the first push, then (past holdMs) a far
  // bigger one without ever having settled.
  const swell = createOnsetDetector();
  run(swell, new Array(120).fill(0.003));
  const grow = [...new Array(10).fill(0.3), ...new Array(30).fill(0.9)];
  assertEquals(run(swell, grow, 120 * 16).length, 2);
});

Deno.test("detector: a hit is not made part of the bed it is measured against", () => {
  const det = createOnsetDetector();
  run(det, new Array(120).fill(0.01));
  const base = det.baseline;
  // Explosions every half second for ten seconds, in a quiet game.
  let t = 120 * 16;
  let n = 0;
  for (let k = 0; k < 20; k++) {
    n += run(det, [0.5, 0.5, 0.3, 0.1, 0.01, ...new Array(27).fill(0.01)], t)
      .length;
    t += 32 * 16;
  }
  assertEquals(n, 20, "every one of them is felt");
  assert(det.baseline < base + 0.02, "and the bed never rose to meet them");
  det.reset();
  assertEquals(det.baseline, 0);
});

Deno.test("spectralFlux: a steady sound has none, a new one has plenty, bin 0 and silence count for nothing", () => {
  const bins = 64;
  const prev = new Float32Array(bins);
  const tone = new Float32Array(bins).fill(-100);
  tone[10] = -20;
  // First read: everything is new.
  assert(spectralFlux(tone, prev) > 0);
  // Same again: nothing is.
  assertEquals(spectralFlux(tone, prev), 0);
  // A second tone arrives: only it counts.
  const two = Float32Array.from(tone);
  two[30] = -20;
  const f = spectralFlux(two, prev);
  assert(Math.abs(f - 0.1) < 1e-6, `one bin at -20 dB is 0.1, got ${f}`);
  // It fades: a fall is not flux.
  assertEquals(spectralFlux(tone, prev), 0);
  // DC and -Infinity.
  const dc = new Float32Array(bins).fill(-Infinity);
  dc[0] = 0;
  assertEquals(spectralFlux(dc, new Float32Array(bins)), 0);
});

// ---- profiling a sample, and what it earns ------------------------------------------

Deno.test("a long, loud, bassy explosion earns a strong pulse; a shot's blip earns none", () => {
  const big = pulseFor(profileBuffer(thump(0.9, 0.24)))!;
  assert(big, "a thump is felt");
  assert(big.strong > big.weak, "the bass goes to the strong motor");
  assert(big.magnitude > 0.5);
  const kill = pulseFor(profileBuffer(boom(0.9, 0.15)))!;
  assert(kill, "and so is a decent noisy kill");
  assert(kill.magnitude < big.magnitude, "but it is lighter");
  // A quiet shot: the Phaser runtime's, 0.29 s at RMS 0.05.
  assertEquals(pulseFor(profileBuffer(blip(0.29, 0.05))), null);
  // A loud but tiny click is still a click.
  assertEquals(pulseFor(profileBuffer(blip(0.04, 0.3))), null);
});

Deno.test("a pulse is never longer than the sound, and louder is stronger", () => {
  const short = pulseFor(profileBuffer(thump(0.1, 0.5)), { minMs: 10 });
  if (short) assert(short.ms <= 100);
  const soft = pulseFor(profileBuffer(thump(0.8, 0.12)))!;
  const hard = pulseFor(profileBuffer(thump(0.8, 0.3)))!;
  assert(hard.magnitude > soft.magnitude && hard.strong > soft.strong);
  assert(hard.ms >= soft.ms && hard.ms <= 300);
  for (const p of [soft, hard]) {
    for (const v of [p.magnitude, p.strong, p.weak]) assert(v >= 0 && v <= 1);
  }
});

Deno.test("profileBuffer reads only the start of a long sample, and never past its end", () => {
  const long = thump(4, 0.2);
  const full = profileBuffer(long, { profileSeconds: 10 });
  const head = profileBuffer(long, { profileSeconds: 1 });
  assert(head.rms > full.rms, "the loud start outweighs the tail");
  assertEquals(profileBuffer(buffer(new Float32Array(0))), {
    rms: 0,
    low: 0,
    duration: 0,
  });
  const p = profileBuffer(thump(0.5, 0.2));
  assert(p.low > 0.8, "a 70 Hz tone is nearly all bass");
  assert(profileBuffer(blip(0.3, 0.2)).low < 0.05, "a 2.4 kHz tone has none");
});

// ---- a fake window ------------------------------------------------------------------

interface Effect {
  type: string;
  startDelay: number;
  duration: number;
  weakMagnitude: number;
  strongMagnitude: number;
}

/** A browser frame, in about the pieces installFrameHaptics touches. */
function fakeWindow(
  opts: { pads?: number; phone?: boolean; native?: boolean; active?: boolean } =
    {},
) {
  const log = {
    effects: [] as Effect[],
    resets: 0,
    pulses: [] as [number, number][],
    vibrations: [] as unknown[],
    timers: 0,
  };
  const clock = { now: 100_000 };

  class Actuator {
    type = "dual-rumble";
    playEffect(_type: string, params: Effect) {
      log.effects.push(params);
      return Promise.resolve("complete");
    }
    pulse(value: number, duration: number) {
      log.pulses.push([value, duration]);
      return Promise.resolve(true);
    }
    reset() {
      log.resets++;
      return Promise.resolve("complete");
    }
  }
  class Navigator {
    userActivation = { hasBeenActive: opts.active !== false };
    vibrate(pattern: unknown) {
      log.vibrations.push(pattern);
      return true;
    }
    getGamepads() {
      const out = [];
      for (let i = 0; i < (opts.pads ?? 1); i++) {
        out.push({
          index: i,
          connected: true,
          vibrationActuator: new Actuator(),
        });
      }
      return out;
    }
  }

  // --- a clock and its timers, moved by hand
  type Timer = { id: number; fn: () => void; every: number | null; at: number };
  let nextId = 1;
  let timers: Timer[] = [];
  const advance = (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      const due = timers.filter((t) =>
        t.at <= end
      ).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      if (due.every !== null) due.at += due.every;
      else timers = timers.filter((t) => t !== due);
      due.fn();
    }
    clock.now = end;
  };

  // --- just enough Web Audio
  class AudioNode {
    connections: unknown[] = [];
    constructor(public context: AudioContext) {}
    connect(dest: unknown) {
      this.connections.push(dest);
      return dest;
    }
  }
  class AudioBufferSourceNode extends AudioNode {
    buffer: ReturnType<typeof buffer> | null = null;
    loop = false;
    started: unknown[] = [];
    start(...args: unknown[]) {
      this.started.push(args);
    }
  }
  class ScriptProcessorNode extends AudioNode {}
  class AudioWorkletNode extends AudioNode {}
  class MediaElementAudioSourceNode extends AudioNode {}
  class Analyser extends AudioNode {
    fftSize = 2048;
    smoothingTimeConstant = 0.8;
    get frequencyBinCount() {
      return this.fftSize / 2;
    }
    /** What a test makes the tap hear. */
    sample: (out: Float32Array) => void = (out) => out.fill(0);
    spectrum: (out: Float32Array) => void = (out) => out.fill(-Infinity);
    getFloatTimeDomainData(out: Float32Array) {
      this.sample(out);
    }
    getFloatFrequencyData(out: Float32Array) {
      this.spectrum(out);
    }
  }
  class BiquadFilter extends AudioNode {
    type = "lowpass";
    frequency = { value: 350 };
  }
  class AudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    analysers: Analyser[] = [];
    createBiquadFilter() {
      return new BiquadFilter(this);
    }
    createAnalyser() {
      const a = new Analyser(this);
      this.analysers.push(a);
      return a;
    }
  }
  class OfflineAudioContext extends AudioContext {}

  const win: Record<string, unknown> = {
    navigator: new Navigator(),
    Navigator,
    GamepadHapticActuator: Actuator,
    AudioNode,
    AudioBufferSourceNode,
    ScriptProcessorNode,
    AudioWorkletNode,
    MediaElementAudioSourceNode,
    AudioContext,
    OfflineAudioContext,
    document: { hidden: false },
    performance: { now: () => clock.now },
    setInterval(fn: () => void, every: number) {
      const id = nextId++;
      timers.push({ id, fn, every, at: clock.now + every });
      log.timers++;
      return id;
    },
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      timers.push({ id, fn, every: null, at: clock.now + ms });
      return id;
    },
    clearInterval(id: number) {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  if (opts.native) win.__CMG_NATIVE_HAPTICS__ = true;
  if (opts.phone) {
    (win as { Navigator: typeof Navigator }).Navigator = Navigator;
  }
  const ctx = new AudioContext();
  return {
    w: win,
    log,
    clock,
    advance,
    ctx,
    Actuator,
    Navigator,
    AudioBufferSourceNode,
    ScriptProcessorNode,
    AudioWorkletNode,
    MediaElementAudioSourceNode,
    AudioContext,
    /** A sample the game starts on `ctx`. */
    play(
      b: ReturnType<typeof buffer>,
      opts: { loop?: boolean; when?: number } = {},
    ) {
      const src = new AudioBufferSourceNode(ctx);
      src.buffer = b;
      src.loop = !!opts.loop;
      src.connect(ctx.destination);
      (src.start as (when?: number) => void).call(src, opts.when);
      return src;
    },
  };
}

type Rig = ReturnType<typeof fakeWindow>;
const install = (rig: Rig, options = {}) =>
  installFrameHaptics(rig.w, options)!;
const explosion = () => thump(0.9, 0.24);

Deno.test("install: a game that answers the Guide itself is left alone, and a window takes it once", () => {
  assertEquals(installFrameHaptics(null), null);
  const native = fakeWindow({ native: true });
  assertEquals(install(native), null);
  assertEquals(native.log.timers, 0, "no timer, no wrapper");
  assertEquals(nativeHaptics(native.w), "own");
  assertEquals(nativeHaptics(fakeWindow().w), null);
  assertEquals(
    nativeHaptics({
      get __GAME_STATE__() {
        throw new Error("a frame in the middle of leaving");
      },
    }),
    null,
  );

  const rig = fakeWindow();
  const first = install(rig);
  assert(first);
  assertEquals(first.stats().mode, "listening");
  assertEquals(installFrameHaptics(rig.w), first, "twice is the same one");
  first.dispose();
  assert(installFrameHaptics(rig.w), "and a disposed window can take it again");
});

Deno.test("a runtime from before the flag keeps its own rumble, which the switch alone reaches", () => {
  const rig = fakeWindow();
  rig.w.__GAME_STATE__ = { vibrateFlg: true };
  assertEquals(nativeHaptics(rig.w), "legacy");
  const h = install(rig);
  assertEquals(h.stats().mode, "gate");
  // Nothing is added: no ear, no timer, its sounds are its own.
  assertEquals(rig.log.timers, 0);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 0);
  // But the Guide's switch governs what it plays.
  const nav = rig.w.navigator as InstanceType<typeof rig.Navigator>;
  const pad = nav.getGamepads()[0].vibrationActuator;
  pad.playEffect("dual-rumble", {} as Effect);
  assertEquals(rig.log.effects.length, 1);
  h.setEnabled(false);
  pad.playEffect("dual-rumble", {} as Effect);
  assertEquals(nav.vibrate(30), false);
  assertEquals(rig.log.effects.length, 1, "its own rumble is silenced");
  h.setEnabled(true);
  h.setPaused(true);
  assertEquals(nav.vibrate(30), false, "and the Guide holds it");
  h.dispose();
});

Deno.test("a sample the game starts is a pulse on the pad, at once, with the weight it earned", () => {
  const rig = fakeWindow();
  const h = install(rig);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 1);
  const e = rig.log.effects[0];
  assertEquals(e.startDelay, 0);
  assert(e.duration >= 40 && e.duration <= 300);
  assert(e.strongMagnitude > e.weakMagnitude, "bass: the strong motor");
  assertEquals(h.stats().samples, 1);
  // The same buffer again is profiled once, not again.
  rig.advance(400);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 2);
});

Deno.test("what is not a hit is not played: quiet blips, music, a looped sample, a stopped game", () => {
  const rig = fakeWindow();
  install(rig);
  rig.play(blip(0.29, 0.05));
  rig.play(thump(0.9, 0.24), { loop: true });
  rig.play(thump(8, 0.24)); // the soundtrack: longer than any sound
  assertEquals(rig.log.effects.length, 0);
  // A paused or muted game: its context is not running.
  rig.ctx.state = "suspended";
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 0);
  // A sample with no buffer, and one whose data cannot be read, never throw.
  const src = new rig.AudioBufferSourceNode(rig.ctx);
  (src.start as () => void).call(src);
  const bad = {
    ...explosion(),
    getChannelData: () => {
      throw new Error("detached");
    },
  };
  rig.ctx.state = "running";
  rig.play(bad);
  assertEquals(rig.log.effects.length, 0);
});

Deno.test("a sound scheduled ahead is felt when it is heard, not when it is queued", () => {
  const rig = fakeWindow();
  install(rig);
  rig.ctx.currentTime = 10;
  rig.play(explosion(), { when: 10.25 });
  assertEquals(rig.log.effects.length, 0, "not yet");
  rig.advance(240);
  assertEquals(rig.log.effects.length, 0);
  rig.advance(30);
  assertEquals(rig.log.effects.length, 1, "now");
  // And a sound that is already due is not delayed.
  rig.advance(500);
  rig.play(explosion(), { when: 0 });
  assertEquals(rig.log.effects.length, 2);
});

Deno.test("the game's own start() still runs, whatever the ear does", () => {
  const rig = fakeWindow();
  install(rig);
  const src = rig.play(explosion(), { when: 3 });
  assertEquals(src.started, [[3]]);
});

Deno.test("a pad that is playing is only taken over by something heavier", () => {
  const rig = fakeWindow();
  install(rig);
  rig.play(thump(0.9, 0.24)); // heavy
  rig.advance(20);
  rig.play(boom(0.6, 0.1)); // lighter, while it plays
  assertEquals(rig.log.effects.length, 1);
  rig.advance(400);
  rig.play(boom(0.6, 0.1)); // after it, anything goes
  assertEquals(rig.log.effects.length, 2);
  // Something heavier takes over at once.
  const rig2 = fakeWindow();
  install(rig2);
  rig2.play(boom(0.6, 0.1));
  rig2.advance(10);
  rig2.play(thump(0.9, 0.3));
  assertEquals(rig2.log.effects.length, 2);
});

Deno.test("every pad that rumbles gets it; none, and a phone's motor does", () => {
  const two = fakeWindow({ pads: 2 });
  install(two);
  two.play(explosion());
  assertEquals(two.log.effects.length, 2);

  const phone = fakeWindow({ pads: 0 });
  const h = install(phone);
  phone.play(explosion());
  assertEquals(phone.log.effects.length, 0);
  assertEquals(phone.log.vibrations.length, 1);
  assert((phone.log.vibrations[0] as number) >= 40);
  assertEquals(h.stats().pulses, 1);

  // Chrome refuses, and logs, a vibrate before the first tap on the page.
  const cold = fakeWindow({ pads: 0, active: false });
  install(cold);
  cold.play(explosion());
  assertEquals(cold.log.vibrations, []);
});

// ---- the switch -----------------------------------------------------------------------

Deno.test("Haptics OFF: nothing is played, the motors stop at once, and ON brings it back", () => {
  const rig = fakeWindow();
  const h = install(rig);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 1);
  h.setEnabled(false);
  assert(rig.log.resets >= 1, "the pad's effect is reset");
  assertEquals(rig.log.vibrations.at(-1), 0, "and a phone's motor stopped");
  rig.advance(400);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 1);
  assertEquals(h.stats().enabled, false);
  h.setEnabled(true);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 2);
  // Installed off, it starts off.
  const off = fakeWindow();
  install(off, { enabled: false });
  off.play(explosion());
  assertEquals(off.log.effects.length, 0);
});

Deno.test("the Guide open over the game: nothing runs under it, and it comes back with the game", () => {
  const rig = fakeWindow();
  const h = install(rig, { paused: true });
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 0, "installed under the Guide");
  h.setPaused(false);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 1);
  const resets = rig.log.resets;
  h.setPaused(true);
  assert(rig.log.resets > resets, "opening it stops what plays");
  rig.advance(400);
  rig.play(explosion());
  assertEquals(rig.log.effects.length, 1);
});

Deno.test("the switch reaches a game's OWN vibrate and rumble calls, and dispose gives the page its own back", () => {
  const rig = fakeWindow();
  const proto = (rig.w.Navigator as typeof rig.Navigator).prototype;
  const act = (rig.w.GamepadHapticActuator as typeof rig.Actuator).prototype;
  const originals = [proto.vibrate, act.playEffect, act.pulse];
  const h = install(rig);
  assertNotEquals(proto.vibrate, originals[0]);

  const nav = rig.w.navigator as InstanceType<typeof rig.Navigator>;
  const pad = nav.getGamepads()[0].vibrationActuator;
  // On: the page's calls go through.
  assertEquals(nav.vibrate(50), true);
  pad.playEffect("dual-rumble", {} as Effect);
  pad.pulse(1, 20);
  assertEquals(rig.log.vibrations, [50]);
  assertEquals(rig.log.effects.length, 1);
  assertEquals(rig.log.pulses.length, 1);
  // Off: they do not reach a motor, and still answer as a motor would.
  h.setEnabled(false);
  const before = [
    rig.log.vibrations.length,
    rig.log.effects.length,
    rig.log.pulses.length,
  ];
  assertEquals(nav.vibrate([10, 20]), false);
  assertEquals(rig.log.vibrations.length, before[0]);
  pad.playEffect("dual-rumble", {} as Effect).then((r: string) =>
    assertEquals(r, "complete")
  );
  pad.pulse(1, 20).then((r: boolean) => assertEquals(r, false));
  assertEquals(rig.log.effects.length, before[1]);
  assertEquals(rig.log.pulses.length, before[2]);
  // Under the Guide: the same.
  h.setEnabled(true);
  h.setPaused(true);
  assertEquals(nav.vibrate(5), false);

  h.dispose();
  assertEquals(
    [proto.vibrate, act.playEffect, act.pulse],
    originals,
    "prototypes are the page's again",
  );
  assertEquals(nav.vibrate(7), true);
  assertEquals(rig.w.__cmgFrameHaptics, undefined);
});

// ---- streams ----------------------------------------------------------------------------

Deno.test("a piece of a stream is tapped, not pulsed; a synthesised stream is tapped when connected on", () => {
  const rig = fakeWindow();
  const h = install(rig);
  // An emulator's 6 ms of buffer.
  const chunk = rig.play(blip(0.006, 0.3));
  assertEquals(rig.log.effects.length, 0, "not a sound of its own");
  assertEquals(h.stats().taps, 1);
  assertEquals(
    chunk.connections.length,
    3,
    "the game's connection, and the two taps",
  );
  // The tap is its own: nothing of it is tapped again, and the destination is
  // still wired to where the game wired it.
  assertEquals(chunk.connections[0], rig.ctx.destination);

  for (
    const Node of [
      rig.ScriptProcessorNode,
      rig.AudioWorkletNode,
      rig.MediaElementAudioSourceNode,
    ]
  ) {
    const n = new Node(new rig.AudioContext());
    n.connect({});
    n.connect({});
    assertEquals(n.connections.length, 4, "tapped once, the game's two kept");
  }
  assertEquals(h.stats().taps, 4, "one tap per context");
  // An offline render has no speakers: never tapped.
  const offline = new (rig.w.OfflineAudioContext as typeof rig.AudioContext)();
  const o = new rig.ScriptProcessorNode(offline);
  o.connect({});
  assertEquals(o.connections.length, 1);

  h.dispose();
  const after = new rig.ScriptProcessorNode(new rig.AudioContext());
  after.connect({});
  assertEquals(after.connections.length, 1, "dispose takes the wrapper off");
});

/** A stream's tap, made to hear `flux` tick by tick. */
function streamRig() {
  const rig = fakeWindow();
  const h = install(rig);
  rig.play(blip(0.006, 0.2)); // makes the tap
  // tapFor makes the bass analyser, then the whole-band one.
  const [low, full] = rig.ctx.analysers;
  assert(low && full);
  /** What the full analyser reports for this tick: nothing or a lit bin. */
  let level = 0;
  full.spectrum = (out) => {
    out.fill(-Infinity);
    // `level` is the sum of the bins' linear magnitudes: spread over 100.
    if (level > 0) out.fill(20 * Math.log10(level / 100), 1, 101);
  };
  full.sample = (out) => out.fill(0.1);
  low.sample = (out) => out.fill(0.2);
  const tick = (flux: number, ms = 16) => {
    level = flux;
    rig.advance(ms);
  };
  return { rig, h, tick };
}

Deno.test("a stream: a quiet bed, then a loud new sound, is one pulse", () => {
  const { rig, h, tick } = streamRig();
  for (let i = 0; i < 90; i++) tick(0.003);
  assertEquals(rig.log.effects.length, 0);
  tick(0.8);
  tick(0.8);
  tick(0.3);
  for (let i = 0; i < 40; i++) tick(0.003);
  assertEquals(rig.log.effects.length, 1);
  const e = rig.log.effects[0];
  assert(e.duration >= 28 && e.duration <= 170);
  assert(e.strongMagnitude > 0.15, "the bass it heard is in it");
  assert(h.stats().flux >= 0);
});

Deno.test("a stream that has only just started, or come back from a pause, is not a hit", () => {
  const { rig, tick } = streamRig();
  // The very first read has nothing to be compared with: all of it looks new.
  tick(0.9);
  for (let i = 0; i < 60; i++) tick(0.9);
  assertEquals(rig.log.effects.length, 0, "a constant roar is no hit");
  rig.ctx.state = "suspended";
  for (let i = 0; i < 10; i++) tick(0);
  rig.ctx.state = "running";
  // Resumed on loud: the first read primes, it does not fire.
  tick(0.9);
  assertEquals(rig.log.effects.length, 0);
});

Deno.test("a stream is not heard while the game is off, paused, or out of sight", () => {
  const { rig, h, tick } = streamRig();
  for (let i = 0; i < 60; i++) tick(0.003);
  h.setEnabled(false);
  tick(0.9);
  tick(0.9);
  assertEquals(rig.log.effects.length, 0);
  h.setEnabled(true);
  h.setPaused(true);
  tick(0.003);
  tick(0.9);
  assertEquals(rig.log.effects.length, 0);
  h.setPaused(false);
  (rig.w.document as { hidden: boolean }).hidden = true;
  for (let i = 0; i < 60; i++) tick(0.003);
  tick(0.9);
  assertEquals(rig.log.effects.length, 0, "a hidden tab");
});

// ---- the launcher wires it ----------------------------------------------------------------

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url))).replaceAll(
    "\r\n",
    "\n",
  );

Deno.test("Dashboard.svelte installs it on every frame load, tells the Guide, and drops it with the game", async () => {
  const src = await read("svelte-src/Dashboard.svelte");
  assert(
    src.includes(
      "import { installFrameHaptics } from '../static/frame-haptics.js';",
    ),
  );
  // On the frame's load, after the other injectors, before the pad patch.
  assert(
    src.includes(
      "injectArcadeFill(e); injectFrameHaptics(e); applyTwinStick();",
    ),
    "not on the frame's load",
  );
  const fn = src.slice(src.indexOf("function injectFrameHaptics(e) {"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert(body.includes("frameHaptics = null;"), "a reload is a new window");
  assert(
    body.includes("editorFrameActive || !frameIsSameOrigin(iframe)"),
    "not the editor, not a cross-origin frame",
  );
  assert(
    body.includes(
      "installFrameHaptics(iframe.contentWindow, { enabled: hapticsOn, paused: osdOpen })",
    ),
  );
  assert(
    body.includes("if (frameHaptics) hapticsAvail = true;"),
    "the Guide's row shows for it",
  );
  // The one switch governs it, and the Guide pauses it.
  const apply = src.slice(src.indexOf("function applyHaptics() {"));
  assert(
    apply.slice(0, apply.indexOf("\n  }\n")).includes(
      "frameHaptics?.setEnabled(hapticsOn);",
    ),
  );
  assert(src.includes("frameHaptics?.setPaused(open)"));
  // And it goes with the game, in both places the rest of its capabilities go.
  assertEquals(
    src.split("    hapticsAvail = false;\n    dropFrameHaptics();").length,
    3,
  );
  assert(src.includes("function dropFrameHaptics() {"));
});

Deno.test("the committed dashboard bundle was rebuilt with it, and the 2028-ai runtime says it has its own", async () => {
  const bundle = await read("static/dashboard.bundle.js");
  // Sentinels from the module as it is now (a minified bundle keeps its strings).
  for (const sentinel of ["__cmgFrameHaptics", '"listening"', '"legacy"']) {
    assert(
      bundle.includes(sentinel),
      `static/dashboard.bundle.js is stale (no ${sentinel}): deno task dashboard:build`,
    );
  }
  const game = await read("static/games/2028-ai/game.bundle.js");
  assert(game.includes("globalThis.__CMG_NATIVE_HAPTICS__ = true;"));
  // Before the haptics it governs, so it is set by the time the frame has loaded.
  assert(
    game.indexOf("globalThis.__CMG_NATIVE_HAPTICS__ = true;") <
      game.indexOf("function readStoredHaptics() {"),
  );
});
