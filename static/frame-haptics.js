// Haptic feedback for a game that has none of its own.
//
// The Guide's Haptics row (README-Technical.md, "Haptics") already governs the
// 2028-ai runtime, whose rumble is written into its events. Every other game
// the launcher frames — an eShop web build it did not write (Sh'M↑ Party), an
// arcade board, an emulator's cartridge — has no events to hang a rumble on
// and no source to add one to. What every one of them does have is sound: an
// explosion, a shot, a hit, a coin. So this module puts the feeling where the
// sound is: when the game plays something heavy, the pad (or the phone's
// motor) rumbles with it, harder for a louder sound, deeper for a bassier one,
// longer for a longer one.
//
// It is installed by the launcher into a SAME-ORIGIN game frame, when the
// frame has loaded (installFrameHaptics, from Dashboard.svelte), the way
// Twin-Stick Mode patches the frame's getGamepads: nothing in the game
// changes. That is late — the game's scripts have run — and what the game
// plays is reached in two ways, because games play sound in two ways:
//
//   - SAMPLES: a sound loaded once and played when something happens (Phaser's,
//     Howler's, Tone's: an AudioBufferSourceNode that is started and ends).
//     Each one is an event of the game's own, so each one is profiled once —
//     how loud, how much of it is bass, how long — and pulsed at the moment it
//     starts, with no delay and nothing to detect. The node's prototype is
//     shared by every context in the frame, so wrapping its start() reaches a
//     sound played after install even on a context the game made at boot.
//   - STREAMS: sound made as it plays, with the music in it (an emulator's
//     OpenAL, a ScriptProcessorNode, an AudioWorkletNode, a media element's
//     source), where nothing says when a thing happened. These are tapped — a
//     low-pass and a plain analyser per context, which hear what the game's
//     sources play and are connected to no speaker, so the game's own graph is
//     never rerouted — and listened to for ONSETS: a sound standing well clear of
//     how busy the soundtrack has been lately (createOnsetDetector). An
//     emulator streams its audio as buffers of a few milliseconds each, which
//     start() reports as chunks of a stream, not as samples.
//
// A looping or long sample (the music) is neither: a rumble that follows the
// soundtrack would never stop.
//
// A game that already has haptics (the 2028-ai runtime says so with
// window.__CMG_NATIVE_HAPTICS__) is left alone: it would be doubled.
//
// The same switch governs a game's OWN calls. A page that vibrates or rumbles
// by itself goes through navigator.vibrate or a pad's GamepadHapticActuator,
// both on shared prototypes, so wrapping them is how Haptics OFF reaches a game
// that never heard of the Guide.

const HAPTIC_DEFAULTS = Object.freeze({
  /** How often the stream tap is read, ms. A frame of the game. */
  tickMs: 16,
  /** The low band the strong motor follows in a stream, Hz. */
  lowpassHz: 240,
  /** Samples read per tick (a power of two): about 23 ms at 44.1 kHz. */
  fftSize: 1024,
  /** A sample longer than this is music, and is not heard, s. */
  maxSampleSeconds: 4,
  /** A buffer shorter than this is a piece of a stream, not a sound, s. */
  chunkSeconds: 0.05,
  /** How much of a sample is profiled (its start is where its weight is), s. */
  profileSeconds: 1.5,
  /** Below this a sample's low band is bass, Hz. */
  bassHz: 300,
  /** What makes a sample worth a pulse: see pulseFor. */
  sample: Object.freeze({}),
  /** What the stream detector wants to see: see createOnsetDetector. */
  detector: Object.freeze({}),
});

const clamp01 = (n) => (n > 1 ? 1 : n > 0 ? n : 0);

/**
 * The part that decides what is a hit and what is just a busy soundtrack.
 *
 * It is fed one onset strength a tick — the spectral flux below, which is
 * zero for a steady sound however loud and large for a new one — and smooths it
 * with a fast envelope (rises at once, lets go over a few tens of
 * milliseconds, so the gaps a stream of tiny buffers leaves do not split one
 * sound in two). What counts as a hit is relative to the game's own mix: the
 * 95th percentile of the last few seconds of that envelope is how busy the
 * music gets, and a hit is the envelope standing a good way clear of it. A
 * percentile, not an average or a maximum, because a hit is sparse: one
 * explosion among a hundred and eighty ticks does not move it, and so does not
 * make the next shot harder to feel; a soundtrack that is simply loud and
 * jumpy raises it, and stops triggering. A quiet game's explosion and a loud
 * game's are both hits, each against its own bed, above an absolute floor that
 * keeps noise out.
 *
 * One sound is one pulse: after a hit the envelope has to settle back before
 * another can fire — or, once `holdMs` has passed, swell well past the first, as
 * a long explosion that builds does — and a refractory period spaces them
 * regardless. The tail of a decaying sound is never a second hit.
 *
 * Returns, per push, null or { magnitude: 0..1, ms }.
 */
export function createOnsetDetector(cfg = {}) {
  const c = {
    // Weaker than this is never a hit, whatever the bed.
    floor: 0.06,
    // A hit stands this many times above the bed's 95th percentile...
    ratio: 2.4,
    // ...and at least this far above it.
    minRise: 0.05,
    // Which percentile of the recent envelope is "how busy the music gets".
    percentile: 0.95,
    // How far back the bed looks, and how few samples make it, ms.
    windowMs: 3000,
    minSamples: 24,
    // The fast envelope's time constants.
    attackMs: 2,
    releaseMs: 45,
    // Settled is back under this share of the threshold.
    settle: 0.6,
    // One sound, one pulse; after holdMs a sound that has swelled to this
    // many times its first hit counts as a second.
    refractoryMs: 70,
    holdMs: 320,
    swell: 1.35,
    // How far past the threshold, in thresholds, is a full-strength hit.
    span: 2,
    // A pulse's length at the weakest and at the strongest.
    minMs: 28,
    maxMs: 170,
    ...cfg,
  };
  let env = 0;
  let last = -Infinity;
  let lastEnv = 0;
  let armed = true;
  let at = null;
  let tick = 0;
  let bed = 0;
  const times = [];
  const values = [];
  const k = (dt, tau) => 1 - Math.exp(-dt / tau);
  /** The bed's percentile, recomputed every few ticks: it moves slowly. */
  function refreshBed(now) {
    while (times.length && now - times[0] > c.windowMs) {
      times.shift();
      values.shift();
    }
    if (values.length < c.minSamples) {
      bed = 0;
      return;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    bed = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * c.percentile))];
  }
  return {
    push(strength, now) {
      const x = strength > 0 ? strength : 0;
      const dt = at === null ? 16 : Math.max(1, Math.min(100, now - at));
      at = now;
      env += (x - env) * k(dt, x > env ? c.attackMs : c.releaseMs);
      if (tick++ % 4 === 0) refreshBed(now);
      const need = Math.max(c.floor, bed * c.ratio, bed + c.minRise);
      if (
        !armed &&
        (env <= need * c.settle || (now - last >= c.holdMs && env >= lastEnv * c.swell))
      ) armed = true;
      let hit = null;
      if (armed && env >= need && now - last >= c.refractoryMs) {
        const m = clamp01((env / need - 1) / (c.span - 1));
        hit = { magnitude: m, ms: Math.round(c.minMs + (c.maxMs - c.minMs) * m) };
        last = now;
        lastEnv = env;
        armed = false;
      }
      // A hit is not what the bed is made of: it would raise the very thing
      // the next one is measured against.
      if (!hit && armed) {
        times.push(now);
        values.push(env);
      }
      return hit;
    },
    reset() {
      env = 0;
      last = -Infinity;
      lastEnv = 0;
      armed = true;
      at = null;
      tick = 0;
      bed = 0;
      times.length = 0;
      values.length = 0;
    },
    /** How busy the music has been lately, for the tests and for tuning. */
    get baseline() {
      return bed;
    },
    /** The fast envelope, for the tests and for tuning. */
    get envelope() {
      return env;
    },
  };
}

/**
 * Spectral flux of one analyser read against the one before: the sum, over the
 * bins, of how much each rose. `db` is getFloatFrequencyData's decibels
 * (−Infinity for silence); `prev` holds the last read's linear magnitudes and
 * is updated in place. Bin 0 (DC) is skipped.
 */
export function spectralFlux(db, prev) {
  let sum = 0;
  for (let k = 1; k < db.length; k++) {
    const d = db[k];
    const m = d > -100 ? Math.pow(10, d / 20) : 0;
    const rise = m - prev[k];
    if (rise > 0) sum += rise;
    prev[k] = m;
  }
  return sum;
}

/**
 * What a sample is, as the motors care: its RMS over the part that is
 * profiled, the share of its energy that is bass (a one-pole low-pass at
 * `bassHz`), and its length. `buffer` is anything that looks like an
 * AudioBuffer: numberOfChannels, getChannelData, sampleRate, length, duration.
 */
export function profileBuffer(buffer, { profileSeconds = 1.5, bassHz = 300 } = {}) {
  const channels = Math.min(2, buffer.numberOfChannels || 1);
  const n = Math.min(buffer.length, Math.floor(profileSeconds * buffer.sampleRate));
  const k = 1 - Math.exp((-2 * Math.PI * bassHz) / buffer.sampleRate);
  let energy = 0;
  let bass = 0;
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const x = d[i];
      lp += k * (x - lp);
      energy += x * x;
      bass += lp * lp;
    }
  }
  const count = n * channels;
  return {
    rms: count ? Math.sqrt(energy / count) : 0,
    low: energy > 0 ? Math.min(1, bass / energy) : 0,
    duration: buffer.duration,
  };
}

/**
 * Whether a sample is worth a pulse, and which. Its weight is how loud it is,
 * leaning to the bassy, and held down for anything shorter than a third of a
 * second: a blip is a click, not a thump. Below `floor` nothing plays; above
 * it the pulse grows with the weight — strong motor for the bass in it, the
 * weak motor for the rest — and lasts about as long as the sound does, to
 * `maxMs`. Returns null or { magnitude, strong, weak, ms }.
 */
export function pulseFor(profile, cfg = {}) {
  const c = { floor: 0.05, span: 0.2, minMs: 40, maxMs: 300, ...cfg };
  const weight = profile.rms * (0.5 + profile.low) * Math.min(1, profile.duration / 0.3);
  if (!(weight >= c.floor)) return null;
  const m = clamp01(0.2 + (weight - c.floor) / c.span);
  const ms = Math.round(
    Math.min(profile.duration * 1000, c.minMs + (c.maxMs - c.minMs) * m),
  );
  return {
    magnitude: m,
    strong: clamp01(0.15 + 0.85 * m * (0.4 + 0.6 * clamp01(profile.low * 1.6))),
    weak: clamp01(0.1 + 0.9 * m * (1.1 - 0.6 * clamp01(profile.low))),
    ms: Math.max(c.minMs, ms),
  };
}

/**
 * Whether a frame's game has haptics of its own, and which kind:
 *   "own"    the 2028-ai runtime of today, which says so with
 *            window.__CMG_NATIVE_HAPTICS__ and answers the Guide's switch itself;
 *   "legacy" a copy of that runtime from before the flag — an eShop build
 *            installed earlier — which rumbles by itself (it has the switch,
 *            gameState.vibrateFlg) but has never heard of the Guide;
 *   null     a game with none.
 */
export function nativeHaptics(w) {
  try {
    if (w.__CMG_NATIVE_HAPTICS__) return "own";
    const g = w.__GAME_STATE__;
    return g && typeof g.vibrateFlg === "boolean" ? "legacy" : null;
  } catch (_) {
    return null;
  }
}

/** RMS of a block of samples. */
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Install the module into a same-origin game frame's window.
 *
 *   const h = installFrameHaptics(frame.contentWindow, { enabled, paused });
 *   h.setEnabled(false)   // the Guide's switch: silences, and keeps a game's
 *                         // own vibrate / rumble calls from reaching a motor
 *   h.setPaused(true)     // the Guide is open over the game
 *   h.dispose()           // the game is closed: every wrapper comes off
 *
 * Returns null when there is nothing to do: no window, a game that answers the
 * Guide itself (nativeHaptics "own"), or — the first one again — a window that
 * already carries it. A game with older haptics of its own (nativeHaptics
 * "legacy") gets the switch alone: its calls are gated and nothing is added.
 */
export function installFrameHaptics(w, options = {}) {
  if (!w) return null;
  const native = nativeHaptics(w);
  if (native === "own") return null;
  // A legacy runtime keeps its own rumble, which only the switch can reach: it
  // is gated, and not listened for (it would be doubled).
  const listening = native === null;
  if (w.__cmgFrameHaptics) return w.__cmgFrameHaptics;
  const o = { ...HAPTIC_DEFAULTS, ...options };
  const state = {
    enabled: options.enabled !== false,
    paused: !!options.paused,
    pulses: 0,
    samples: 0,
  };
  const detector = createOnsetDetector(o.detector);
  const restore = []; // undo steps, newest last

  // --- the motors ----------------------------------------------------------
  // The phone's motor is called by its original, taken before the wrapper
  // goes on, so this module's own output never loops back through it. A
  // pad's own is gated on the way through (the wrapper passes it when the
  // switch is on, which is the only time this module plays one).
  const nav = w.navigator;
  const NavProto = w.Navigator && w.Navigator.prototype;
  const origVibrate = NavProto && typeof NavProto.vibrate === "function"
    ? NavProto.vibrate
    : null;
  const Haptic = w.GamepadHapticActuator && w.GamepadHapticActuator.prototype;

  function wrap(proto, name, make) {
    if (!proto || typeof proto[name] !== "function") return;
    const had = Object.prototype.hasOwnProperty.call(proto, name);
    const orig = proto[name];
    proto[name] = make(orig);
    restore.push(() => {
      if (had) proto[name] = orig;
      else delete proto[name];
    });
  }

  // Haptics OFF has to hold for a page that rumbles by itself.
  wrap(NavProto, "vibrate", (orig) =>
    function vibrate(pattern) {
      if (!state.enabled || state.paused) return false;
      return orig.call(this, pattern);
    });
  wrap(Haptic, "playEffect", (orig) =>
    function playEffect(type, params) {
      if (!state.enabled || state.paused) return Promise.resolve("complete");
      return orig.call(this, type, params);
    });
  wrap(Haptic, "pulse", (orig) =>
    function gatedPulse(value, duration) {
      if (!state.enabled || state.paused) return Promise.resolve(false);
      return orig.call(this, value, duration);
    });

  /** Pads in this frame that can rumble, as the frame sees them. */
  function rumblePads() {
    let pads = [];
    try {
      pads = Array.from((nav && nav.getGamepads && nav.getGamepads()) || []);
    } catch (_) { /* no pads here */ }
    return pads.filter((p) =>
      p && p.connected && p.vibrationActuator &&
      typeof p.vibrationActuator.playEffect === "function"
    );
  }

  // A pad has one effect playing at a time and a new one preempts it, so a
  // stage's worth of small sounds must not cut a big one short: while a pulse
  // is playing only a heavier one (by a quarter) may take over.
  let busyUntil = 0;
  let busyMag = 0;
  function emit(magnitude, strong, weak, ms) {
    const t = now();
    if (t < busyUntil && magnitude < busyMag * 1.25) return false;
    if (!pulse(strong, weak, ms)) return false;
    busyUntil = t + ms;
    busyMag = magnitude;
    return true;
  }

  /** One pulse: the strong motor follows the bass, the weak one the whole. */
  function pulse(strong, weak, ms) {
    if (!state.enabled || state.paused) return false;
    const pads = rumblePads();
    if (pads.length) {
      for (const p of pads) {
        const act = p.vibrationActuator;
        try {
          const r = act.playEffect(act.type || "dual-rumble", {
            startDelay: 0,
            duration: ms,
            weakMagnitude: clamp01(weak),
            strongMagnitude: clamp01(strong),
          });
          if (r && r.catch) r.catch(() => {});
        } catch (_) { /* a pad that went away mid-pulse */ }
      }
      state.pulses++;
      return true;
    }
    // A phone: Chrome refuses, and logs an intervention, before the first tap.
    try {
      const active = !nav.userActivation || nav.userActivation.hasBeenActive !== false;
      if (origVibrate && active && origVibrate.call(nav, ms)) {
        state.pulses++;
        return true;
      }
    } catch (_) { /* no motor */ }
    return false;
  }

  /** Whatever is playing stops. */
  function silence() {
    busyUntil = 0;
    busyMag = 0;
    try {
      if (origVibrate) origVibrate.call(nav, 0);
    } catch (_) { /* ignore */ }
    for (const p of rumblePads()) {
      try {
        const r = p.vibrationActuator.reset && p.vibrationActuator.reset();
        if (r && r.catch) r.catch(() => {});
      } catch (_) { /* ignore */ }
    }
  }

  // --- the ear -------------------------------------------------------------
  const taps = new Map(); // AudioContext -> its tap (see tapFor)
  const own = new WeakSet(); // the nodes this module made: never tapped
  const AudioNodeProto = w.AudioNode && w.AudioNode.prototype;
  const rawConnect = AudioNodeProto && AudioNodeProto.connect;

  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    // Never an offline render: it has no speakers and no clock.
    if (w.OfflineAudioContext && ctx instanceof w.OfflineAudioContext) return null;
    try {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = o.lowpassHz;
      const low = ctx.createAnalyser();
      low.fftSize = o.fftSize;
      const full = ctx.createAnalyser();
      full.fftSize = o.fftSize;
      own.add(lowpass);
      own.add(low);
      own.add(full);
      rawConnect.call(lowpass, low);
      // No smoothing between reads: the flux below is the difference between
      // two of them, and the analyser's own averaging would be a third.
      full.smoothingTimeConstant = 0;
      t = {
        lowpass,
        low,
        full,
        lowBuf: new Float32Array(low.fftSize),
        fullBuf: new Float32Array(full.fftSize),
        freqBuf: new Float32Array(full.frequencyBinCount),
        prev: new Float32Array(full.frequencyBinCount),
      };
      taps.set(ctx, t);
      return t;
    } catch (_) {
      return null;
    }
  }

  /** Let the tap hear one source, as well as whatever the game connected it to. */
  function listenTo(node) {
    if (!rawConnect || own.has(node)) return;
    const ctx = node.context;
    if (!ctx) return;
    const t = tapFor(ctx);
    if (!t) return;
    try {
      rawConnect.call(node, t.lowpass);
      rawConnect.call(node, t.full);
    } catch (_) { /* a node that cannot be connected */ }
  }

  // A sample is an event: profiled once, pulsed as it starts. A piece of a
  // stream is tapped instead. Music (long, or looping) is neither.
  const profiles = new WeakMap(); // AudioBuffer -> its pulse plan, or null
  function planFor(buffer) {
    if (profiles.has(buffer)) return profiles.get(buffer);
    let plan = null;
    try {
      plan = pulseFor(profileBuffer(buffer, o), o.sample);
    } catch (_) { /* a buffer that cannot be read is a sound with no weight */ }
    profiles.set(buffer, plan);
    return plan;
  }
  function sampleStarted(node, buffer, when) {
    const plan = planFor(buffer);
    if (!plan) return;
    const ctx = node.context;
    // A sound scheduled ahead is felt when it is heard.
    const ahead = typeof when === "number" && ctx ? (when - ctx.currentTime) * 1000 : 0;
    const fire = () => {
      // A suspended context is a paused or muted game: nothing is heard.
      if (ctx && ctx.state !== "running") return;
      if (emit(plan.magnitude, plan.strong, plan.weak, plan.ms)) state.samples++;
    };
    if (ahead > 8) w.setTimeout(fire, ahead);
    else fire();
  }
  const BufferSource = listening && w.AudioBufferSourceNode &&
    w.AudioBufferSourceNode.prototype;
  wrap(BufferSource, "start", (orig) =>
    function start(...args) {
      try {
        const b = this.buffer;
        if (b && !this.loop && b.duration <= o.maxSampleSeconds) {
          if (b.duration < o.chunkSeconds) listenTo(this);
          else sampleStarted(this, b, args[0]);
        }
      } catch (_) { /* never let the ear break the game's sound */ }
      return orig.apply(this, args);
    });
  // A synthesised stream: tapped when it is connected on. Defined on the
  // subclass, so no other node pays for it, and removed again with delete.
  for (const name of ["ScriptProcessorNode", "AudioWorkletNode", "MediaElementAudioSourceNode"]) {
    const Ctor = w[name];
    const proto = Ctor && Ctor.prototype;
    if (!listening || !proto || !rawConnect) continue;
    const had = Object.prototype.hasOwnProperty.call(proto, "connect");
    const prior = proto.connect;
    proto.connect = function connect(...args) {
      try {
        if (!this.__cmgHeard) {
          this.__cmgHeard = true;
          listenTo(this);
        }
      } catch (_) { /* ignore */ }
      return rawConnect.apply(this, args);
    };
    restore.push(() => {
      if (had) proto.connect = prior;
      else delete proto.connect;
    });
  }

  /**
   * What the tap hears right now: the RMS of the bass band and of the whole,
   * and the spectral FLUX of the whole — how much energy has newly arrived,
   * across the spectrum, since the last read. A steady tone has none however
   * loud it is, a new sound has plenty, and that is what separates a shot
   * over a loud soundtrack from the soundtrack, where plain loudness cannot.
   * Each is the loudest over every context in the frame.
   */
  function listen() {
    let low = 0;
    let full = 0;
    let flux = 0;
    for (const [ctx, t] of taps) {
      if (ctx.state !== "running") {
        t.primed = false;
        continue;
      }
      t.low.getFloatTimeDomainData(t.lowBuf);
      t.full.getFloatTimeDomainData(t.fullBuf);
      low = Math.max(low, rms(t.lowBuf));
      full = Math.max(full, rms(t.fullBuf));
      t.full.getFloatFrequencyData(t.freqBuf);
      const f = spectralFlux(t.freqBuf, t.prev);
      // The first read after a start or a resume has nothing to be compared
      // with: all of the sound would look new.
      if (t.primed) flux = Math.max(flux, f);
      t.primed = true;
    }
    return { low, full, flux };
  }

  // The detector reads the flux; the motors read how loud it was.
  const loudness = ({ flux }) => flux;

  let last = { low: 0, full: 0, flux: 0 };
  function tick() {
    if (!state.enabled || state.paused || !taps.size) return;
    if (w.document && w.document.hidden) return;
    last = listen();
    const hit = detector.push(loudness(last), now());
    if (!hit) return;
    // The strong motor takes the bass as well as the hit, the weak one the
    // hit, each lifted so it is felt: a pad's motors do nothing under a tenth.
    const m = hit.magnitude;
    const strong = clamp01(0.15 + 0.85 * (0.55 * m + 0.45 * clamp01(last.low * 4)));
    const weak = clamp01(0.1 + 0.9 * m);
    emit(m, strong, weak, hit.ms);
  }
  const now = () => (w.performance && w.performance.now ? w.performance.now() : Date.now());
  if (listening) {
    const timer = w.setInterval(tick, o.tickMs);
    restore.push(() => w.clearInterval(timer));
  }

  const controller = {
    /** The Guide's switch. Off silences at once. */
    setEnabled(on) {
      state.enabled = !!on;
      if (!state.enabled) {
        detector.reset();
        silence();
      }
    },
    /** The Guide is open over the game: nothing runs under it. */
    setPaused(paused) {
      state.paused = !!paused;
      if (state.paused) {
        detector.reset();
        silence();
      }
    },
    /** Silence whatever is playing, without changing the switch. */
    stop: silence,
    /** For the tests and for tuning. */
    stats() {
      return {
        mode: listening ? "listening" : "gate",
        enabled: state.enabled,
        paused: state.paused,
        pulses: state.pulses,
        samples: state.samples,
        taps: taps.size,
        baseline: detector.baseline,
        ...last,
      };
    },
    /** Take every wrapper off and stop listening. */
    dispose() {
      silence();
      while (restore.length) {
        try {
          restore.pop()();
        } catch (_) { /* ignore */ }
      }
      taps.clear();
      delete w.__cmgFrameHaptics;
    },
  };
  w.__cmgFrameHaptics = controller;
  return controller;
}
