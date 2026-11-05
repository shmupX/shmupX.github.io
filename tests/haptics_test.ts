// The 2028-ai runtime's haptics — the Guide's Haptics switch and the shaped,
// weighted feedback behind it.
//
// game.bundle.js is a vendored artifact patched by hand (README-Technical.md,
// "Haptics"), so these tests lift the haptics module and the switch's few
// functions out of the bundle and run them against a fake gamepad, clock and
// timers: what plays, when, how hard, on which pad, and what a toggle stops.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url)).then((s) =>
    s.replaceAll("\r\n", "\n")
  );

/** A top-level `function name(...) {...}` of the bundle's IIFE, as source. */
function lift(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start > 0, `no function ${name} in the bundle`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

/** The haptics module: from its header to the next module's. */
function hapticsModule(js: string): string {
  const a = js.indexOf("  // ../2019-es7/src/haptics.js");
  const b = js.indexOf("  // ../2019-es7/src/phaser/game-objects/Shadow.js");
  assert(a > 0 && b > a, "haptics module not found");
  return js.slice(a, b);
}

type Effect = { type: string; params: Record<string, number>; at: number };

/** A rumble pad that logs every playEffect / reset it is sent. */
function fakePad(index: number, log: Effect[], clock: { now: number }) {
  return {
    index,
    connected: true,
    vibrationActuator: {
      type: "dual-rumble",
      playEffect(type: string, params: Record<string, number>) {
        log.push({ type, params, at: clock.now });
        return Promise.resolve("complete");
      },
      reset() {
        log.push({ type: "reset", params: {}, at: clock.now });
        return Promise.resolve("complete");
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
type Rig = any;

/**
 * The module wired to a fake world. `timers` run only when `advance()` moves
 * the clock past them, in order, like a browser would.
 */
async function rig(pads = 1): Promise<Rig> {
  const bundle = await read(BUNDLE);
  const src = hapticsModule(bundle);
  const helpers = [
    "hapticKillScale",
    "hapticDamageScale",
    "hapticPadOf",
    "hapticsAmbient",
  ].map((n) => lift(bundle, n)).join("\n");
  // HAPTIC_LOW_HULL is the one var those helpers close over.
  const lowHull = bundle.match(/\n {2}var HAPTIC_LOW_HULL = [^\n]*;\n/);
  assert(lowHull, "no HAPTIC_LOW_HULL");

  // Well past every cooldown, which count from time 0 (a page is never 1 s old
  // when the player first gets hurt).
  const clock = { now: 100_000 };
  const log: Effect[] = [];
  const vibrations: unknown[] = [];
  const timers: { at: number; fn: () => void; id: number; live: boolean }[] =
    [];
  let nextId = 1;
  const state = { vibrateFlg: true };
  const gamepads = Array.from(
    { length: pads },
    (_, i) => fakePad(i, log, clock),
  );
  const navigator = {
    userAgent: "test",
    getGamepads: () => gamepads,
    vibrate: (p: unknown) => {
      vibrations.push(p);
      return true;
    },
    userActivation: { hasBeenActive: true },
  };
  const setTimeoutFake = (fn: () => void, ms: number) => {
    const t = { at: clock.now + ms, fn, id: nextId++, live: true };
    timers.push(t);
    return t.id;
  };
  const clearTimeoutFake = (id: number) => {
    for (const t of timers) if (t.id === id) t.live = false;
  };
  const api = new Function(
    "gameState",
    "navigator",
    "performance",
    "window",
    "setTimeout",
    "clearTimeout",
    "killer",
    `${src}\n${lowHull[0]}\n${helpers}
     return { triggerHaptic, hapticsStop, hapticsAmbient, hapticKillScale,
       hapticDamageScale, hapticPadOf, scaleHaptic, HAPTIC_PRESETS };`,
  )(
    state,
    navigator,
    { now: () => clock.now },
    {},
    setTimeoutFake,
    clearTimeoutFake,
    (scene: { players: unknown[] }, owner: number) =>
      scene.players[owner] || scene.players[0],
  );
  return {
    ...api,
    state,
    log,
    vibrations,
    clock,
    /** Move time on, firing the timers that come due. */
    advance(ms: number) {
      const end = clock.now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.live && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        clock.now = due.at;
        due.fn();
      }
      clock.now = end;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

Deno.test("a single-blip preset still plays once, on the pad and the phone", async () => {
  const h = await rig();
  assert(h.triggerHaptic("pickup"));
  assertEquals(h.log.length, 1);
  assertEquals(h.log[0].type, "dual-rumble");
  assertEquals(h.log[0].params.duration, 22);
  assertEquals(h.vibrations, [18]);
});

Deno.test("off means off: nothing plays, nothing is queued", async () => {
  const h = await rig();
  h.state.vibrateFlg = false;
  assertEquals(h.triggerHaptic("death"), false);
  assertEquals(h.log.length, 0);
  assertEquals(h.vibrations.length, 0);
  assertEquals(h.pending(), 0);
});

Deno.test("an envelope plays its first step now and the rest on time", async () => {
  const h = await rig();
  h.triggerHaptic("death");
  const steps = h.HAPTIC_PRESETS.death.envelope;
  assertEquals(h.log.length, 1, "only the first step is immediate");
  assertEquals(h.log[0].params.strongMagnitude, steps[0][3]);
  h.advance(10_000);
  assertEquals(h.log.length, steps.length);
  steps.forEach((st: number[], i: number) => {
    assertEquals(h.log[i].at, 100_000 + st[0], `step ${i} fires at its offset`);
    assertEquals(h.log[i].params.duration, st[1]);
    assertEquals(h.log[i].params.weakMagnitude, st[2]);
    assertEquals(h.log[i].params.strongMagnitude, st[3]);
  });
  // The phone gets the preset's whole pattern once, not step by step.
  assertEquals(h.vibrations, [h.HAPTIC_PRESETS.death.vibration]);
});

Deno.test("every envelope is ordered, in range, and stays inside its priority's reach", async () => {
  const h = await rig();
  for (const [name, p] of Object.entries(h.HAPTIC_PRESETS) as [string, Rig][]) {
    assert(typeof p.priority === "number", `${name} has no priority`);
    if (!p.envelope) continue;
    let last = -1;
    for (const [at, dur, weak, strong] of p.envelope as number[][]) {
      assert(at > last || at === 0, `${name}: steps out of order`);
      last = at;
      assert(dur > 0 && dur <= 500, `${name}: odd duration ${dur}`);
      assert(weak >= 0 && weak <= 1 && strong >= 0 && strong <= 1, name);
    }
  }
});

Deno.test("a heavier effect is not cut short by a lighter one", async () => {
  const h = await rig();
  h.triggerHaptic("death");
  const before = h.log.length;
  h.advance(20); // past the 16 ms global guard
  assertEquals(h.triggerHaptic("kill"), false, "a kill tick during a death");
  assertEquals(h.triggerHaptic("pickup"), false);
  assertEquals(h.log.length, before);
  // Once the rumble has run out, the ticks are back.
  h.advance(5_000);
  const after = h.log.length;
  assert(h.triggerHaptic("kill"));
  assertEquals(h.log.length, after + 1);
});

Deno.test("a heavier effect preempts, and the old one's queued tail never plays over it", async () => {
  const h = await rig();
  h.triggerHaptic("special"); // priority 3, 860 ms long
  h.advance(50);
  assert(h.triggerHaptic("bossDefeat"), "priority 4 takes over"); // the heavier
  h.advance(10_000);
  const special = h.HAPTIC_PRESETS.special.envelope as number[][];
  const wasSpecial = (e: Effect) =>
    special.some(([, d, w, s]) =>
      e.params.duration === d && e.params.weakMagnitude === w &&
      e.params.strongMagnitude === s
    );
  // Only special's first step (t+0) got out before it was taken over; the
  // rest were queued, and cancelled with the takeover.
  assertEquals(h.log.filter(wasSpecial).length, 1);
  assertEquals(
    h.log.length,
    1 + h.HAPTIC_PRESETS.bossDefeat.envelope.length,
  );
});

Deno.test("each pad has a lane: one player's death does not silence the other's kills", async () => {
  const h = await rig(2);
  h.triggerHaptic("death", 0);
  h.advance(20);
  assert(h.triggerHaptic("kill", 1), "pad 1 is not blocked by pad 0's death");
  assertEquals(h.triggerHaptic("kill", 0), false, "pad 0 is");
  // A game-wide event waits for the heaviest lane too.
  h.advance(20);
  assertEquals(h.triggerHaptic("bossEnter"), false);
  // Scoped: pad 1's effect reached pad 1's motors only.
  const forPad1 = h.log.filter((e: Effect) => e.params.duration === 10);
  assertEquals(forPad1.length, 1);
});

Deno.test("scaling: a bigger kill is stronger and a little longer, capped at 1", async () => {
  const h = await rig();
  assert(h.hapticKillScale(10) < 1 && h.hapticKillScale(1e4) > 1);
  assertEquals(Math.round(h.hapticKillScale(100) * 100) / 100, 1);
  assert(h.hapticKillScale(1e12) <= 1.65 && h.hapticKillScale(0) >= 0.65);
  assert(h.hapticDamageScale(1) === 1 && h.hapticDamageScale(100) === 1.6);
  const small = h.scaleHaptic(h.HAPTIC_PRESETS.kill, 0.7);
  const big = h.scaleHaptic(h.HAPTIC_PRESETS.kill, 1.6);
  assert(big.weakMagnitude > small.weakMagnitude);
  assert(big.duration > small.duration);
  const maxed = h.scaleHaptic(h.HAPTIC_PRESETS.death, 2);
  for (const st of maxed.envelope) assert(st[2] <= 1 && st[3] <= 1);
  // The preset table itself is never mutated by a scaled play.
  const was = h.HAPTIC_PRESETS.kill.weakMagnitude;
  h.triggerHaptic("kill", undefined, 1.6);
  assertEquals(h.HAPTIC_PRESETS.kill.weakMagnitude, was);
  assertEquals(h.log[0].params.weakMagnitude, was * 1.6);
});

Deno.test("hapticsStop cancels the queued steps and silences phone and pads", async () => {
  const h = await rig(2);
  h.triggerHaptic("bossDefeat");
  assert(h.pending() > 0);
  h.log.length = 0;
  h.vibrations.length = 0;
  h.hapticsStop();
  assertEquals(h.pending(), 0, "queued steps are cancelled");
  assertEquals(h.vibrations, [0], "the phone is told to stop");
  assertEquals(
    h.log.filter((e: Effect) => e.type === "reset").length,
    2,
    "every pad's motors are reset",
  );
  h.advance(10_000);
  assertEquals(h.log.filter((e: Effect) => e.type !== "reset").length, 0);
  // And the lane is free again: a light effect plays straight away.
  assert(h.triggerHaptic("kill"));
});

Deno.test("an envelope that outlives the switch does not rumble a disabled game", async () => {
  const h = await rig();
  h.triggerHaptic("special");
  h.state.vibrateFlg = false; // the switch flips without a stop
  h.log.length = 0;
  h.advance(5_000);
  assertEquals(h.log.length, 0);
});

Deno.test("hapticsAmbient: a heartbeat only at low hull, quicker as it drops", async () => {
  const h = await rig();
  const mk = (hp: number, extra = {}) => ({
    hp,
    maxHp: 6,
    dead: false,
    padIndex: 0,
    ...extra,
  });
  const beats = (p: Rig, steps: number) => {
    const scene = { players: [p] };
    h.log.length = 0;
    let n = 0;
    for (let i = 0; i < steps; i++) {
      h.advance(8.4); // one fixed step
      const before = h.log.length;
      h.hapticsAmbient(scene);
      if (h.log.length > before) n++;
      h.advance(300); // let the previous beat clear the lane
    }
    return n;
  };
  assertEquals(beats(mk(6), 400), 0, "full hull is silent");
  assertEquals(beats(mk(3), 400), 0, "half hull is silent");
  const two = beats(mk(2), 400); // 1/3: at the threshold
  const one = beats(mk(1), 400); // 1/6: nearly gone
  assert(two >= 2, `threshold hull beats (${two})`);
  assert(one > two, `quicker on the last hit point (${one} vs ${two})`);
  assertEquals(beats(mk(0), 400), 0, "a ship with no hp is dead, not beating");
  assertEquals(beats(mk(1, { dead: true }), 400), 0);
  assertEquals(beats(mk(1, { maxHp: 0 }), 400), 0, "no hull to measure");
  h.state.vibrateFlg = false;
  assertEquals(beats(mk(1), 400), 0, "off is off");
});

Deno.test("the heartbeat is a lub-dub in the strong motor", async () => {
  const h = await rig();
  h.triggerHaptic("heartbeat");
  h.advance(500);
  assertEquals(h.log.length, 2);
  assert(h.log[0].params.strongMagnitude > h.log[0].params.weakMagnitude);
  assert(h.log[1].params.strongMagnitude < h.log[0].params.strongMagnitude);
});

Deno.test("hapticPadOf: a shot or kill belongs to its owner's pad, else game-wide", async () => {
  const h = await rig();
  const scene = { players: [{ padIndex: 3 }, { padIndex: null }] };
  assertEquals(h.hapticPadOf(scene, 0), 3);
  assertEquals(h.hapticPadOf(scene, 1), null); // typeof !== number: game-wide
  assertEquals(h.hapticPadOf(scene, 9), 3); // unattributed → player 1
  assertEquals(h.hapticPadOf({ players: [] }, 0), undefined);
});

// ── the switch ──────────────────────────────────────────────────────────────

Deno.test("cmgSetHaptics: flips the flag, stops what plays, shows on the panel, saves when asked", async () => {
  const bundle = await read(BUNDLE);
  const src = lift(bundle, "cmgSetHaptics");
  const store = new Map<string, string>();
  const calls: string[] = [];
  const state: Record<string, unknown> = { vibrateFlg: true };
  const box = { checked: true };
  const make = () =>
    new Function(
      "gameState",
      "hapticsStop",
      "localStorage",
      "cmgHapticsInput",
      `${src}; return cmgSetHaptics;`,
    )(
      state,
      () => calls.push("stop"),
      {
        setItem: (k: string, v: string) => store.set(k, v),
      },
      box,
    );
  const set = make();
  set(false, false);
  assertEquals(state.vibrateFlg, false);
  assertEquals(calls, ["stop"]);
  assertEquals(box.checked, false);
  assertEquals(store.size, 0, "the launcher saves its own choice");
  set(true, true);
  assertEquals(state.vibrateFlg, true);
  assertEquals(calls, ["stop"], "turning it on stops nothing");
  assertEquals(store.get("cmg-haptics"), "1");
  set(0, true);
  assertEquals(store.get("cmg-haptics"), "0");
  assertEquals(state.vibrateFlg, false);
});

Deno.test("readStoredHaptics: 1, 0, or never set (and a locked-down storage is never set)", async () => {
  const bundle = await read(BUNDLE);
  const src = lift(bundle, "readStoredHaptics");
  const stored = (ls: unknown) =>
    new Function("localStorage", `${src}; return readStoredHaptics();`)(ls);
  assertEquals(stored({ getItem: () => "1" }), true);
  assertEquals(stored({ getItem: () => "0" }), false);
  assertEquals(stored({ getItem: () => null }), null);
  assertEquals(stored({ getItem: () => "banana" }), null);
  assertEquals(
    stored({
      getItem: () => {
        throw new Error("SecurityError");
      },
    }),
    null,
  );
});

Deno.test("boot order: ?vibrate= beats the stored switch, which beats on", async () => {
  const bundle = await read(BUNDLE);
  const sync = lift(bundle, "syncRuntimeFlagsFromLocation");
  // The line itself: the param's default is the stored choice when there is one.
  assertStringIncludes(
    sync,
    'readBooleanSearchParam("vibrate", storedHaptics != null ? storedHaptics : ',
  );
  assertStringIncludes(sync, "var storedHaptics = readStoredHaptics();");
});

Deno.test("the runtime wires the switch: message in, advert out, pause stops the motors", async () => {
  const bundle = await read(BUNDLE);
  assertStringIncludes(
    bundle,
    'else if (d.type === "cmg-haptics-set") cmgSetHaptics(!!d.value, false);',
  );
  // The advert rides beside Turbo's, only under a parent frame, after the
  // listener is up, and says whether ?vibrate= set the state.
  const advert = bundle.indexOf(
    'type: "cmg-haptics", value: isHapticsEnabled()',
  );
  const turbo = bundle.indexOf('type: "cmg-turbo", value: cmgTimeScale');
  const standalone = bundle.indexOf("// ESC toggles the PAUSE panel.");
  assert(turbo > 0 && advert > turbo && advert < standalone);
  assertStringIncludes(bundle, 'explicit: readSearchParam("vibrate") != null');
  // Pausing — the Guide opening over the game — silences the motors.
  const paused = lift(bundle, "cmgSetPaused");
  assertStringIncludes(paused, "if (p) hapticsStop();");
});

Deno.test("the standalone PAUSE panel carries HAPTICS after TURBO and before RESUME", async () => {
  const bundle = await read(BUNDLE);
  const panel = lift(bundle, "cmgEnsurePanel");
  const turbo = panel.indexOf('cmgToggleRow("TURBO"');
  const haptics = panel.indexOf('cmgToggleRow("HAPTICS", isHapticsEnabled()');
  const resume = panel.indexOf('btn.textContent = "RESUME"');
  assert(turbo > 0 && haptics > turbo && resume > haptics);
  assertStringIncludes(panel, "cmgSetHaptics(on, true);");
  assertStringIncludes(panel, 'return on ? "ON" : "OFF";');
  assertStringIncludes(
    panel,
    'cmgHapticsInput = haptics.querySelector("input");',
  );
});

Deno.test("the game feeds the layer: scaled kills and hits, boss thuds, the heartbeat", async () => {
  const bundle = await read(BUNDLE);
  assertStringIncludes(
    bundle,
    'triggerHaptic("kill", p.padIndex, hapticKillScale(score));',
  );
  assertStringIncludes(
    bundle,
    'triggerHaptic("damage", p.padIndex, hapticDamageScale(amount));',
  );
  // Both boss-damage paths (the Dezaemon pool and the stock hp) thud.
  const thuds = bundle.split(
    'triggerHaptic("bossHit", hapticPadOf(this, pb.getData("owner")));',
  )
    .length - 1;
  assertEquals(thuds, 2);
  // The heartbeat runs in the fixed step, only while a run is live.
  const fixed = bundle.indexOf("    fixedUpdate(time, step) {");
  const gate = bundle.indexOf(
    "if (!anyAlive || this.stageCleared) return;",
    fixed,
  );
  const beat = bundle.indexOf("hapticsAmbient(this);", fixed);
  assert(
    fixed > 0 && gate > fixed && beat > gate,
    "heartbeat is before the live-run gate",
  );
});
