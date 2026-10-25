// The tool-assisted pilot for the emulator panes (SFC, Saturn, PSX, 64DD),
// as page code, and the pure helpers that turn what it kept into a clip.
//
// EmulatorJS can save and load a state but cannot step a frame — its main
// loop paces itself on the real clock, so a replayed input log would not land
// on the frames it was recorded on. So this pilot does not replay. It plays
// one continuous run with fire held and the ship swaying, saves a state every
// `checkpointMs`, and when the console's own lives counter drops it loads the
// state from `rewindCheckpoints` checkpoints back, reseeds its sway, and plays
// on. Every load cuts the run: the stretch from that checkpoint to the death
// is thrown away. What it keeps is a list of wall-clock spans whose frames,
// laid end to end, are one unbroken run that never died — the clip is cut from
// the screencast along those spans (keptFrames below).
//
// It reads the console's RAM straight out of the core's WebAssembly heap: the
// driver finds where the work RAM sits (locateExpr, by the screen-state bytes
// a format document names) and hands the offset in.

import type { Frame } from "./parity.ts";

export interface EmuPilotConfig {
  /** Heap offset of the console's work RAM. */
  ramBase: number;
  /**
   * The core keeps that RAM as little-endian 16-bit words (yabause's Saturn
   * work RAM), so the console's byte A sits at heap byte A ^ 1.
   */
  wordSwap?: boolean;
  /** Addresses (within that RAM) of the lives counter; a drop in any is a death. */
  lives: number[];
  /** RetroPad index held throughout to fire. */
  fire: number;
  /** RetroPad indices of the d-pad. */
  pad: { up: number; down: number; left: number; right: number };
  checkpointMs: number;
  /** How many checkpoints back a death rewinds to (2 = the one before last). */
  rewindCheckpoints: number;
  /** An address and value that mean "the boss is up", once known. */
  boss?: { addr: number; value: number } | null;
  /**
   * Where the ship's x and y bytes are, and the box it should keep to. With
   * them the pilot flies to random points in that box; without, it sways.
   * `shift` reads each as a big-endian 16-bit word in units of 2^shift
   * pixels instead of a byte (the Saturn's px << 7); with `littleEndian` the
   * word is a signed little-endian one (the PlayStation's).
   */
  ship?: {
    x: number;
    y: number;
    shift?: number;
    littleEndian?: boolean;
    box: { x0: number; x1: number; y0: number; y1: number };
  } | null;
  /** Fresh flights tried from one checkpoint before stepping further back. */
  maxTries?: number;
  /** Seed for the flight. */
  seed?: number;
}

/** The pilot as page code; `window.__emu` is its state, `.on` starts it. */
export function emuPilot(config: EmuPilotConfig): string {
  return `(function (cfg) {
  if (window.__emu) return "already";
  var gm = EJS_emulator.gameManager;
  var M = EJS_emulator.Module;
  var emu = window.__emu = {
    on: false, err: null, deaths: 0, rewinds: 0, checkpoints: 0,
    kept: [], ring: [], lives: null, bossWall: null, startWall: null,
    seed: cfg.seed || 1, held: {}, inputs: [], escalate: 0, lastRewindWall: 0,
    tries: 0, best: [], bestMs: 0,
  };
  var swap = cfg.wordSwap ? 1 : 0;
  function ram(a) { return M.HEAPU8[cfg.ramBase + (a ^ swap)]; }
  function pos(a) {
    var s = cfg.ship.shift;
    if (cfg.ship.littleEndian) return (((ram(a + 1) << 8) | ram(a)) << 16 >> 16) >> (s || 0);
    return s == null ? ram(a) : ((ram(a) << 8) | ram(a + 1)) >> s;
  }
  function livesNow() { return cfg.lives.map(ram); }
  function hold(idx, on) {
    if (!!emu.held[idx] === !!on) return;
    emu.held[idx] = !!on;
    gm.simulateInput(0, idx, on ? 1 : 0);
  }
  // A cheap deterministic generator, so a reseed changes the sway.
  function rnd() { emu.seed = (emu.seed * 1103515245 + 12345) & 0x7fffffff; return emu.seed / 0x7fffffff; }
  var phase = 0, period = 90, dir = 1, vdir = 0, vtimer = 0, t = 0;
  function reseed() { period = 50 + Math.floor(rnd() * 80); phase = Math.floor(rnd() * period); dir = rnd() < 0.5 ? -1 : 1; }
  reseed();
  function checkpoint(now) {
    var s = gm.getState();
    // keptLen: the index of the kept span this checkpoint sits in.
    emu.ring.push({ wall: now, state: s, keptLen: emu.kept.length - 1, lives: livesNow() });
    if (emu.ring.length > 16) emu.ring.shift();
    emu.checkpoints++;
  }
  function tick() {
    if (!emu.on) return;
    var now = Date.now();
    if (emu.startWall === null) {
      emu.startWall = now;
      emu.kept.push([now, null]);
      emu.lives = livesNow();
      checkpoint(now);
      hold(cfg.fire, true);
    }
    var l = livesNow();
    var died = false;
    for (var i = 0; i < l.length; i++) if (l[i] < emu.lives[i]) died = true;
    if (died) {
      emu.deaths++;
      // A console counts the life only once the explosion has played, so a
      // checkpoint a second or two back can already hold a ship that is going
      // to die. So: a fresh flight from the same checkpoint, up to maxTries
      // times, then one checkpoint further back; surviving a while resets it.
      if (now - emu.lastRewindWall > cfg.checkpointMs * 6) { emu.escalate = 0; emu.tries = 0; }
      else if (++emu.tries >= (cfg.maxTries || 5)) { emu.escalate++; emu.tries = 0; }
      var back = Math.min(emu.ring.length, cfg.rewindCheckpoints + emu.escalate);
      var ck = emu.ring[emu.ring.length - back];
      emu.ring.length = emu.ring.length - back + 1;
      // Close the kept timeline at the checkpoint, open a new span now.
      emu.kept.length = ck.keptLen + 1;
      emu.kept[ck.keptLen][1] = ck.wall;
      gm.loadState(ck.state);
      emu.kept.push([Date.now(), null]);
      ck.keptLen = emu.kept.length - 1;
      ck.wall = emu.kept[ck.keptLen][0];
      emu.lives = ck.lives.slice();
      emu.rewinds++;
      emu.lastRewindWall = Date.now();
      reseed();
      return;
    }
    emu.lives = l;
    // The longest run kept so far, closed at now: a rewind that escalates far
    // back can leave less at the end than there was before it, and the frames
    // of the longer run are still in the screencast.
    if (t % 30 === 0) {
      var ms = 0;
      for (var s = 0; s < emu.kept.length; s++) ms += (emu.kept[s][1] === null ? now : emu.kept[s][1]) - emu.kept[s][0];
      if (ms > emu.bestMs) {
        emu.bestMs = ms;
        emu.best = emu.kept.map(function (k) { return [k[0], k[1] === null ? now : k[1]]; });
      }
    }
    if (cfg.boss && emu.bossWall === null && ram(cfg.boss.addr) === cfg.boss.value) emu.bossWall = now;
    if (now - emu.ring[emu.ring.length - 1].wall >= cfg.checkpointMs) checkpoint(now);
    t++;
    if (cfg.ship) {
      // Fly to a random point in the box, a new one every half second or so.
      var b = cfg.ship.box;
      if (--vtimer <= 0) {
        emu.tx = b.x0 + rnd() * (b.x1 - b.x0);
        emu.ty = b.y0 + rnd() * (b.y1 - b.y0);
        vtimer = 20 + Math.floor(rnd() * 30);
      }
      var sx = pos(cfg.ship.x), sy = pos(cfg.ship.y);
      hold(cfg.pad.left, sx > emu.tx + 4);
      hold(cfg.pad.right, sx < emu.tx - 4);
      hold(cfg.pad.up, sy > emu.ty + 4);
      hold(cfg.pad.down, sy < emu.ty - 4);
      return;
    }
    // The sway: left and right on a reseedable period, now and then a short
    // dip up or down, fire held throughout.
    var x = Math.sin(((t + phase) / period) * Math.PI * 2) * dir;
    hold(cfg.pad.left, x < -0.25);
    hold(cfg.pad.right, x > 0.25);
    if (--vtimer <= 0) { vdir = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0; vtimer = 20 + Math.floor(rnd() * 40); }
    hold(cfg.pad.up, vdir < 0);
    hold(cfg.pad.down, vdir > 0);
  }
  emu.timer = setInterval(function () { try { tick(); } catch (e) { emu.err = String(e && e.stack || e); } }, 16);
  emu.stop = function () {
    clearInterval(emu.timer);
    var last = emu.kept[emu.kept.length - 1];
    if (last && last[1] === null) last[1] = Date.now();
    for (var k in emu.held) if (emu.held[k]) gm.simulateInput(0, Number(k), 0);
  };
  return "installed";
})(${JSON.stringify(config)})`;
}

export const EMU_STATUS = `(function () {
  var e = window.__emu;
  if (!e) return null;
  return { err: e.err, deaths: e.deaths, rewinds: e.rewinds, checkpoints: e.checkpoints,
    kept: e.kept, lives: e.lives, bossWall: e.bossWall, startWall: e.startWall,
    escalate: e.escalate, tries: e.tries, ring: e.ring.length,
    best: e.best, bestMs: e.bestMs };
})()`;

export interface EmuStatus {
  err: string | null;
  deaths: number;
  rewinds: number;
  checkpoints: number;
  kept: [number, number | null][];
  lives: number[] | null;
  bossWall: number | null;
  startWall: number | null;
  /** The longest run kept at any point, its spans closed. */
  best?: [number, number][];
  bestMs?: number;
}

/**
 * Candidate heap offsets for a console's work RAM where every `[address,
 * value]` pair holds — evaluated at each screen the format document names a
 * signature for, narrowing `window.__ram` each time (`first` starts afresh).
 * One candidate left is the RAM.
 */
export function locateExpr(
  pairs: [number, number][],
  first: boolean,
  span = 0x20000,
): string {
  return `(function (pairs, first) {
  var H = EJS_emulator.Module.HEAPU8;
  var prev = window.__ram, out = [];
  var test = function (o) { for (var i = 0; i < pairs.length; i++) if (H[o + pairs[i][0]] !== pairs[i][1]) return false; return true; };
  if (first || !prev) {
    var a0 = pairs[0][0], v0 = pairs[0][1], n = H.length - ${span};
    for (var o = 0; o < n; o++) if (H[o + a0] === v0 && test(o)) out.push(o);
  } else {
    for (var i = 0; i < prev.length; i++) if (test(prev[i])) out.push(prev[i]);
  }
  window.__ram = out;
  return out.length === 1 ? out[0] : -out.length;
})(${JSON.stringify(pairs)}, ${first})`;
}

/**
 * The frames of the kept run between `from` and `to` (wall ms of the RUN's
 * own clock — the kept spans laid end to end), resampled to `fps`: each kept
 * span contributes its own frames, so a rewind is a cut, not a jump back.
 */
export function keptFrames(
  frames: Frame[],
  kept: [number, number][],
  fps: number,
  skipMs = 0,
  maxMs = Infinity,
): string[] {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  // The last frame painted at or before `at`, by binary search.
  const latest = (at: number): Frame | undefined => {
    let lo = 0, hi = sorted.length - 1, pick = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t <= at) {
        pick = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return pick < 0 ? undefined : sorted[pick];
  };
  const out: string[] = [];
  let runClock = 0;
  const step = 1000 / fps;
  for (const [a, b] of kept) {
    for (let at = a; at < b; at += step) {
      if (runClock >= skipMs && runClock - skipMs < maxMs) {
        const pick = latest(at);
        if (pick) out.push(pick.file);
      }
      runClock += step;
    }
  }
  return out;
}

/** Where a wall-clock moment falls on the kept run's own clock, or null. */
export function runClockAt(
  kept: [number, number][],
  wall: number,
): number | null {
  let clock = 0;
  for (const [a, b] of kept) {
    if (wall >= a && wall < b) return clock + (wall - a);
    clock += b - a;
  }
  return null;
}
