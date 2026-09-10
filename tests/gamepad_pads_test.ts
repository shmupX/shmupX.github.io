// The pad layer's controller recognition, as the launcher, the compatibility
// plugin and gamepad-support.js all apply it — pinned here because three
// copies of the same regexes have to agree, and because the committed
// dashboard bundle has to carry the launcher's copy.
//
// The Stadia controller is the case that motivated this file: Chrome reports
// it with a standard mapping plus two extra buttons (17 Capture, 18
// Assistant), and a machine with a DualShock still paired in the background
// has to pick the Stadia over it.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";

// The plugin is an IIFE that installs itself on globalThis; Deno has a
// `navigator` without getGamepads, so it exposes its API and patches nothing.
await import("../static/gamepad-compatibility-plugin.js");
// deno-lint-ignore no-explicit-any
const compat = (globalThis as any).CMGGamepadCompat;
// deno-lint-ignore no-explicit-any
const support = await import("../static/gamepad-support.js") as any;
const { GamepadManager, DEFAULT_MAPPING, STADIA_PAD_RE } = support;

const PADS = {
  stadiaChrome: {
    id:
      "Stadia Controller rev. A (STANDARD GAMEPAD Vendor: 18d1 Product: 9400)",
    mapping: "standard",
    connected: true,
  },
  stadiaFirefox: {
    id: "18d1-9400-Stadia Controller rev. A",
    mapping: "standard",
    connected: true,
  },
  ds4: {
    id: "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)",
    mapping: "standard",
    connected: true,
  },
  xbox: {
    id: "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
    mapping: "standard",
    connected: true,
  },
  snes: {
    id: "SNES Controller (Vendor: 057e Product: 2017)",
    mapping: "",
    connected: true,
  },
};

Deno.test("the Stadia controller is recognised under both browsers' id spellings", () => {
  assert(STADIA_PAD_RE.test(PADS.stadiaChrome.id));
  assert(STADIA_PAD_RE.test(PADS.stadiaFirefox.id));
  assert(!STADIA_PAD_RE.test(PADS.ds4.id));
  assert(!STADIA_PAD_RE.test(PADS.xbox.id));
  assert(compat.isStadiaPad(PADS.stadiaChrome));
  assert(compat.isStadiaPad(PADS.stadiaFirefox));
  assert(!compat.isStadiaPad(PADS.ds4));
  assert(!compat.isSnesPad(PADS.stadiaChrome));
  const proto = GamepadManager.prototype;
  assert(proto.isStadiaController.call(proto, PADS.stadiaChrome));
  assert(!proto.isStadiaController.call(proto, PADS.snes));
});

Deno.test("priority: SNES > Xbox = Stadia > everything else, in both implementations", () => {
  const proto = GamepadManager.prototype;
  const expect: Array<[keyof typeof PADS, number]> = [
    ["snes", 3],
    ["xbox", 2],
    ["stadiaChrome", 2],
    ["stadiaFirefox", 2],
    ["ds4", 1],
  ];
  for (const [name, priority] of expect) {
    assertStrictEquals(
      compat.padPriority(PADS[name]),
      priority,
      `plugin: ${name}`,
    );
    assertStrictEquals(
      proto.controllerPriority.call(proto, PADS[name]),
      priority,
      `support: ${name}`,
    );
  }
  // A Stadia pad beats the DualShock still paired in the background.
  assertStrictEquals(
    compat.selectPreferredPad([PADS.ds4, PADS.stadiaChrome]),
    PADS.stadiaChrome,
  );
  assertStrictEquals(
    compat.selectPreferredPad([PADS.stadiaChrome, PADS.snes]),
    PADS.snes,
  );
});

Deno.test("the default mapping carries Stadia's Capture and Assistant, every index once", () => {
  assertStrictEquals(DEFAULT_MAPPING.special.home.gamepadButton, 16);
  assertStrictEquals(DEFAULT_MAPPING.special.capture.gamepadButton, 17);
  assertStrictEquals(DEFAULT_MAPPING.special.assistant.gamepadButton, 18);
  assertStrictEquals(DEFAULT_MAPPING.special.capture.keyboardKey, "F9");
  assertStrictEquals(
    DEFAULT_MAPPING.special.assistant.keyboardKey,
    DEFAULT_MAPPING.special.home.keyboardKey,
  );
  const seen = new Map<number, string>();
  for (const [group, buttons] of Object.entries(DEFAULT_MAPPING)) {
    for (
      const [name, m] of Object.entries(
        buttons as Record<string, { gamepadButton: number }>,
      )
    ) {
      const prior = seen.get(m.gamepadButton);
      assertStrictEquals(
        prior,
        undefined,
        `${group}.${name} shares index ${m.gamepadButton} with ${prior}`,
      );
      seen.set(m.gamepadButton, `${group}.${name}`);
    }
  }
  assertStrictEquals(seen.size, 19);
});

Deno.test("a mapping saved before the extra buttons existed gains their defaults", () => {
  const old = {
    dpad: DEFAULT_MAPPING.dpad,
    face: DEFAULT_MAPPING.face,
    shoulder: DEFAULT_MAPPING.shoulder,
    special: { start: { gamepadButton: 9, keyboardKey: "Enter", keyCode: 13 } },
  };
  const store = new Map<string, string>([[
    "gamepadMapping_pad",
    JSON.stringify(old),
  ]]);
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const realStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeStorage,
    configurable: true,
  });
  try {
    const self = {
      defaultMapping: JSON.parse(JSON.stringify(DEFAULT_MAPPING)),
      setUseWASDForDpad() {},
    };
    const mapping = GamepadManager.prototype.loadMapping.call(self, "pad");
    assertEquals(mapping.special.start, old.special.start);
    assertEquals(mapping.special.capture, DEFAULT_MAPPING.special.capture);
    assertEquals(mapping.special.assistant, DEFAULT_MAPPING.special.assistant);
    assertEquals(mapping.special.select, DEFAULT_MAPPING.special.select);
  } finally {
    if (realStorage) {
      Object.defineProperty(globalThis, "localStorage", realStorage);
    } // deno-lint-ignore no-explicit-any
    else delete (globalThis as any).localStorage;
  }
});

Deno.test("the committed dashboard bundle carries the launcher's Stadia handling", async () => {
  const bundle = await Deno.readTextFile(
    new URL("../static/dashboard.bundle.js", import.meta.url),
  );
  assert(
    bundle.includes("Stadia"),
    "stale bundle: run `deno task dashboard:build`",
  );
  assert(
    bundle.includes("ASSISTANT, or OPTIONS"),
    "stale bundle: the Stadia Guide hint is missing",
  );
});

// ---- Lenovo Legion Go: recognition, and Split Controller mode ----
//
// The Legion Go's controller detaches into two halves that keep reporting as
// one pad; CMGGamepadCompat.splitPads re-expresses it as two, one per half,
// and gamepad-support.js stops synthesizing player 1's keys for the right
// half. Both are pinned here — against 2028-ai's own button tables, read out
// of its bundle below (Sh'M↑ Party's live in another repository, so its slot
// numbers are pinned as constants: L1 dash, R1 weapon cycle, R2 auto-aim,
// START/CROSS start and confirm, D-pad LEFT/RIGHT in the perk picker).

const LEGION_PADS = {
  chromeLinux: {
    id:
      "Lenovo Legion Controller for Windows (STANDARD GAMEPAD Vendor: 17ef Product: 6182)",
    mapping: "standard",
    connected: true,
  },
  firefox: {
    id: "17ef-6182-Lenovo Legion Controller for Windows",
    mapping: "standard",
    connected: true,
  },
  // The vendor/product hex alone, under both spellings — a pad whose name a
  // driver reports differently must still be found by its ids.
  chromeHex: {
    id: "Generic (STANDARD GAMEPAD Vendor: 17ef Product: 6182)",
    mapping: "standard",
    connected: true,
  },
  firefoxHex: { id: "17ef-6182-Generic", mapping: "standard", connected: true },
  // The Legion Go S: a Legion whose halves do not come off.
  goS: {
    id: "Lenovo Legion Go S (STANDARD GAMEPAD Vendor: 17ef Product: 61eb)",
    mapping: "standard",
    connected: true,
  },
};

type Btn = { pressed: boolean; touched: boolean; value: number };
interface FakePad {
  id: string;
  index: number;
  mapping: string;
  connected: boolean;
  timestamp: number;
  axes: number[];
  buttons: Btn[];
  vibrationActuator: unknown;
}
function fakePad(over: {
  id?: string;
  index?: number;
  mapping?: string;
  axes?: number[];
  pressed?: number[];
  buttons?: number;
  actuator?: unknown;
} = {}): FakePad {
  const down = new Set(over.pressed ?? []);
  return {
    id: over.id ?? LEGION_PADS.chromeLinux.id,
    index: over.index ?? 0,
    mapping: over.mapping ?? "standard",
    connected: true,
    timestamp: 1,
    axes: over.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: over.buttons ?? 17 }, (_, i) => ({
      pressed: down.has(i),
      touched: down.has(i),
      value: down.has(i) ? 1 : 0,
    })),
    vibrationActuator: over.actuator ?? null,
  };
}
const pressedSlots = (p: FakePad | null) =>
  p ? p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0) : [];
// Every fresh test starts with no right half claimed.
const split = (pads: unknown[] | null, opts: Record<string, unknown>) =>
  compat.splitPads(pads, opts);

Deno.test("the Legion Go's built-in pad is recognised under both browsers' spellings, in all three copies", async () => {
  const proto = GamepadManager.prototype;
  const legion = [
    LEGION_PADS.chromeLinux,
    LEGION_PADS.firefox,
    LEGION_PADS.chromeHex,
    LEGION_PADS.firefoxHex,
    LEGION_PADS.goS,
  ];
  for (const pad of legion) {
    assert(compat.isLegionPad(pad), pad.id);
    assert(proto.isLegionController.call(proto, pad), pad.id);
    assert(support.LEGION_PAD_RE.test(pad.id), pad.id);
    // It ranks with Xbox pads, above a generic pad left paired in the
    // background — in both implementations, under every spelling.
    assertStrictEquals(compat.padPriority(pad), 2, pad.id);
    assertStrictEquals(proto.controllerPriority.call(proto, pad), 2, pad.id);
  }
  for (const pad of [PADS.xbox, PADS.ds4, PADS.stadiaChrome, PADS.snes]) {
    assert(!compat.isLegionPad(pad), pad.id);
    assert(!proto.isLegionController.call(proto, pad), pad.id);
  }
  const bundle = await Deno.readTextFile(
    new URL("../static/dashboard.bundle.js", import.meta.url),
  );
  for (
    const [needle, what] of [
      ["Product:\\s*61[0-9a-f]{2}", "the launcher's Legion regex"],
      ["Legion Go S", "the Legion Go S exclusion"],
      ["Split Controller", "the Guide's Split Controller row"],
      ["cmg-splitpads-set", "the split-mode frame message"],
      ["cmg-splitpads", "the cmg-splitpads broadcast handler"],
      ["cmg-splitpads-ack", "the gate acknowledgement handler"],
      ["LEGION FPS MODE", "the FPS-mode hint"],
      ["/api/host", "the host-device fetch"],
    ] as const
  ) {
    assert(bundle.includes(needle), `stale bundle: ${what} is missing`);
  }
});

Deno.test("2028-ai's bundle reads the split view: the launcher's message opens its two-player gate, and the halves land in its button tables", async () => {
  const game = await Deno.readTextFile(
    new URL("../static/games/2028-ai/game.bundle.js", import.meta.url),
  );
  assert(
    game.includes('"cmg-splitpads-set"'),
    "the bundle no longer listens for cmg-splitpads-set",
  );
  assert(
    game.includes('"cmg-splitpads-ack"'),
    "the bundle no longer acknowledges the gate",
  );
  assert(
    /if \(gameState\.cmgSplitPads\) return true;/.test(game),
    "twoPlayerAllowed no longer honours split mode",
  );
  const table = (name: string): number[] => {
    const m = new RegExp("var " + name + " = \\[([^\\]]*)\\];").exec(game);
    assert(m, `${name} not found in the bundle`);
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    return names.map((n) => {
      const c = new RegExp("var " + n + " = (\\d+);").exec(game);
      assert(c, `${n} not found in the bundle`);
      return Number(c[1]);
    });
  };
  const sp = table("SP_BUTTONS");
  const enter = table("ENTER_BUTTONS");
  const option = table("OPTION_BUTTONS");
  // The results screen's return-to-title buttons are a literal in the scene.
  const title = /var btnIndices = \[([\d, ]+)\];/.exec(game);
  assert(title, "the results screen's btnIndices literal is gone");
  const toTitle = title[1].split(",").map((s) => Number(s.trim()));

  compat.splitReset();
  // LB, LT, View, Menu on the left; A, RB, RT, Menu on the right (claimed).
  const out = split([fakePad({ pressed: [0, 4, 5, 6, 7, 8, 9] })], { now: 0 });
  const left = out[0], right = out[4];
  // Player 1 bombs on LB — both slots LB lands in are bomb buttons.
  for (const s of [0, 4]) {
    assert(sp.includes(s) && left.buttons[s].pressed, `left slot ${s}`);
  }
  // ...pauses on Menu, and returns to the title on View.
  assert(enter.includes(9) && left.buttons[9].pressed);
  assert(toTitle.includes(8) && left.buttons[8].pressed);
  // ...and LT reaches the OPTION ring.
  assert(option.some((s) => left.buttons[s].pressed));
  // Player 2 bombs on RB and A, confirms and returns to the title on A, and
  // RT reaches its OPTION ring.
  for (const s of [0, 5]) {
    assert(sp.includes(s) && right.buttons[s].pressed, `right slot ${s}`);
  }
  assert(toTitle.includes(0));
  assert(option.some((s) => right.buttons[s].pressed));
  // Nothing on the left half is a bomb the right half could also be pressing
  // for player 1: the halves' bomb slots come from different physical
  // buttons (LB → 0/4 on the left; A, RB → 0/5 on the right).
  compat.splitReset();
  const only = split([fakePad({ pressed: [0, 5] })], { now: 0 });
  assertEquals(pressedSlots(only[0]), []);
  assertEquals(pressedSlots(only[4]), [0, 5]);
});

Deno.test("split: until the right half is claimed the left pad is the whole controller", () => {
  compat.splitReset();
  // Sticks, D-pad, LB, LT, View, Menu, L3: the one player's inputs.
  const raw = fakePad({
    axes: [-0.8, 0.2, 0.5, -0.4],
    pressed: [4, 6, 8, 9, 10, 13],
  });
  const out = split([raw, null, null, null], { now: 1000 });
  assert(out.length >= 8);
  const left = out[0];
  assertEquals(left.id, raw.id + " [L]");
  assertStrictEquals(left.index, 0);
  assertEquals(left.mapping, "standard");
  // The right stick rides along on axes 2/3 — Sh'M↑ Party's aim stick.
  assertEquals(left.axes, [-0.8, 0.2, 0.5, -0.4]);
  // LB as confirm (0) and LB (4); LT as both triggers; View; Menu; L3 as L3
  // and as R3 (2028-ai's editor button); D-pad down.
  assertEquals(pressedSlots(left), [0, 4, 6, 7, 8, 9, 10, 11, 13]);
  // No right half yet, and no stray pads.
  for (const i of [1, 2, 3, 4, 5, 6, 7]) assertStrictEquals(out[i], null);
});

Deno.test("split: a right-half button claims the right half — the sticks and Menu never do", () => {
  compat.splitReset();
  // The right stick alone: still one pad.
  let out = split([fakePad({ axes: [0, 0, 0.9, 0.9] })], { now: 0 });
  assertStrictEquals(out[4], null);
  // Menu alone: still one pad (it is player 1's pause).
  out = split([fakePad({ pressed: [9] })], { now: 16 });
  assertStrictEquals(out[4], null);
  // RB: claimed, with a fresh RB edge on the brand-new pad, the right stick
  // now its own, and the left pad's axes 2/3 gone quiet.
  out = split([fakePad({ axes: [0, 0, 0.5, -0.4], pressed: [5, 9] })], {
    now: 32,
  });
  const right = out[4];
  assertEquals(right.id, LEGION_PADS.chromeLinux.id + " [R]");
  assertStrictEquals(right.index, 4);
  assertEquals(right.axes, [0.5, -0.4, 0, 0]);
  assertEquals(pressedSlots(right), [5, 9]);
  assertEquals(out[0].axes, [0, 0, 0, 0]);
  // Menu on both halves in the generic profile.
  assertEquals(pressedSlots(out[0]), [9]);
  // Hands off: the right half stays.
  out = split([fakePad()], { now: 48 });
  assert(out[4], "the right half stays once claimed");
  assertEquals(compat.splitStatus(), [
    { key: "0:" + LEGION_PADS.chromeLinux.id, claimed: true },
  ]);
  // A different pad starts over.
  out = split([fakePad({ id: LEGION_PADS.firefox.id })], { now: 64 });
  assertStrictEquals(out[4], null);
  // Each face button claims too.
  for (const f of [0, 1, 2, 3]) {
    compat.splitReset();
    out = split([fakePad({ pressed: [f] })], { now: 0 });
    assertEquals(pressedSlots(out[4]), [f]);
    assertEquals(pressedSlots(out[0]), []);
  }
});

Deno.test("split: each half's trigger feeds only its own half, as both triggers", () => {
  compat.splitReset();
  let out = split([fakePad({ pressed: [6] })], { now: 0 });
  assertEquals(pressedSlots(out[0]), [6, 7]);
  assertStrictEquals(out[4], null);
  compat.splitReset();
  out = split([fakePad({ pressed: [7] })], { now: 0 });
  assertEquals(pressedSlots(out[0]), []);
  assertEquals(pressedSlots(out[4]), [6, 7]);
});

Deno.test("split, twinstick profile: dash on LB/RB, weapon cycle on LT/Y, auto-fire while at the controls", () => {
  const twin = { profile: "twinstick" };
  compat.splitReset();
  // Y, LB, RB, LT, Menu
  let out = split([fakePad({ pressed: [3, 4, 5, 6, 9] })], { ...twin, now: 0 });
  // left: dash (LB), weapon (LT), auto-fire — no Menu once the right half is
  // claimed (Sh'M↑ Party would pause twice in one frame), and LB is not a
  // confirm here (that is L3)
  assertEquals(pressedSlots(out[0]), [4, 5, 7]);
  // right: Y itself, dash (RB), weapon (Y), auto-fire, Menu
  assertEquals(pressedSlots(out[4]), [3, 4, 5, 7, 9]);
  // Hands off inside the idle window: both halves keep firing...
  out = split([fakePad()], { ...twin, now: 9_000 });
  assertEquals(pressedSlots(out[0]), [7]);
  assertEquals(pressedSlots(out[4]), [7]);
  // ...and let go once it closes, so the title can idle into attract mode.
  out = split([fakePad()], { ...twin, now: 11_000 });
  assertEquals(pressedSlots(out[0]), []);
  assertEquals(pressedSlots(out[4]), []);
  // A hand back on the right stick brings only that half's fire back — and
  // past the D-pad threshold the stick is a D-pad too, for the perk picker.
  out = split([fakePad({ axes: [0, 0, 0.9, 0] })], { ...twin, now: 20_000 });
  assertEquals(pressedSlots(out[0]), []);
  assertEquals(pressedSlots(out[4]), [7, 15]);
  out = split([fakePad({ axes: [0, 0, -0.5, -0.9] })], {
    ...twin,
    now: 20_016,
  });
  assertEquals(pressedSlots(out[4]), [7, 12]);
  // RT is R2 by hand as well.
  out = split([fakePad({ pressed: [7] })], { ...twin, now: 40_000 });
  assertEquals(pressedSlots(out[4]), [7]);
  // Unclaimed, the solo player keeps Menu on the left pad.
  compat.splitReset();
  out = split([fakePad({ pressed: [9] })], { ...twin, now: 0 });
  assertEquals(pressedSlots(out[0]), [7, 9]);
  assertStrictEquals(out[4], null);
  // The generic profile never invents a press.
  compat.splitReset();
  out = split([fakePad({ pressed: [0] })], { now: 0 });
  assertEquals(pressedSlots(out[0]), []);
  assertEquals(pressedSlots(out[4]), [0]);
  // The demo reel's L1+R1 join chord is a half's two shoulders: LB+LT on the
  // left, RB+RT on the right — RT alone is only R2.
  compat.splitReset();
  out = split([fakePad({ pressed: [4, 6] })], { ...twin, now: 0 });
  assertEquals(pressedSlots(out[0]), [4, 5, 7]);
  compat.splitReset();
  out = split([fakePad({ pressed: [7] })], { ...twin, now: 0 });
  assertEquals(pressedSlots(out[4]), [7]);
  out = split([fakePad({ pressed: [5, 7] })], { ...twin, now: 16 });
  assertEquals(pressedSlots(out[4]), [4, 5, 7]);
  // Confirm on the left half is L3 (also L3 and R3), so an LB pressed a frame
  // before LT cannot back out of the reel as CROSS.
  compat.splitReset();
  out = split([fakePad({ pressed: [10] })], { ...twin, now: 0 });
  assertEquals(pressedSlots(out[0]), [0, 7, 10, 11]);
});

Deno.test("split: rumble goes to the half's own motor, without cancelling the other half's", async () => {
  compat.splitReset();
  const calls: unknown[] = [];
  const actuator = {
    type: "dual-rumble",
    playEffect(type: string, params: Record<string, number>) {
      calls.push([type, params]);
      return Promise.resolve("complete");
    },
    reset() {
      calls.push(["reset"]);
      return Promise.resolve("complete");
    },
  };
  const out = split([fakePad({ pressed: [0], actuator })], { now: 0 });
  const effect = { duration: 0, strongMagnitude: 1, weakMagnitude: 1 };
  // Finished (zero-length) buzzes, one per half: each reaches only its own
  // motor, and neither lingers into the next.
  await out[0].vibrationActuator.playEffect("dual-rumble", effect);
  await out[4].vibrationActuator.playEffect("dual-rumble", effect);
  assertEquals(calls, [
    ["dual-rumble", { duration: 0, strongMagnitude: 1, weakMagnitude: 0 }],
    ["dual-rumble", { duration: 0, strongMagnitude: 0, weakMagnitude: 1 }],
  ]);
  // A game-wide buzz — both halves back to back while each is still live —
  // reaches both grips: the second call carries the first's magnitude.
  calls.length = 0;
  await out[0].vibrationActuator.playEffect("dual-rumble", {
    duration: 5000,
    strongMagnitude: 0.8,
    weakMagnitude: 0.8,
  });
  await out[4].vibrationActuator.playEffect("dual-rumble", {
    duration: 5000,
    strongMagnitude: 0.6,
    weakMagnitude: 0.6,
  });
  assertEquals(calls, [
    ["dual-rumble", { duration: 5000, strongMagnitude: 0.8, weakMagnitude: 0 }],
    ["dual-rumble", {
      duration: 5000,
      strongMagnitude: 0.8,
      weakMagnitude: 0.6,
    }],
  ]);
  // Resetting one half replays the other's remainder rather than silencing it.
  calls.length = 0;
  await out[0].vibrationActuator.reset();
  assertEquals(calls.length, 1);
  const [type, p] = calls[0] as [string, Record<string, number>];
  assertEquals(type, "dual-rumble");
  assertEquals(p.strongMagnitude, 0);
  assertEquals(p.weakMagnitude, 0.6);
  assert(p.duration > 0 && p.duration <= 5000);
  // ...and once both are done, a reset is a reset.
  calls.length = 0;
  await out[4].vibrationActuator.reset();
  assertEquals(calls, [["reset"]]);
  // The caller's own object is not written to.
  assertEquals(effect, { duration: 0, strongMagnitude: 1, weakMagnitude: 1 });
  assertStrictEquals(out[0].vibrationActuator.type, "dual-rumble");
  // No actuator on the pad, none on the halves.
  compat.splitReset();
  const bare = split([fakePad({ pressed: [0] })], { now: 0 });
  assertStrictEquals(bare[0].vibrationActuator, null);
  assertStrictEquals(bare[4].vibrationActuator, null);
});

Deno.test("split: Legion-id pads split; without one the lowest-index standard pad does; the rest pass through", () => {
  compat.splitReset();
  const ds4 = fakePad({ id: PADS.ds4.id, index: 0, pressed: [0] });
  const legion = fakePad({ index: 1, pressed: [0] });
  assertEquals(compat.splitTargets([ds4, legion]), [1]);
  let out = split([ds4, legion], { now: 0 });
  assertStrictEquals(out[0], ds4); // untouched, the same object
  assertEquals(out[1].id, legion.id + " [L]");
  assertEquals(out[5].id, legion.id + " [R]");
  // Two anonymous XInput pads (a Legion Go on Windows and a second pad): only
  // the first splits.
  compat.splitReset();
  const xbox0 = fakePad({ id: PADS.xbox.id, index: 0 });
  const xbox1 = fakePad({ id: PADS.xbox.id, index: 1 });
  assertEquals(compat.splitTargets([xbox0, xbox1]), [0]);
  out = split([xbox0, xbox1], { now: 0 });
  assertEquals(out[0].id, xbox0.id + " [L]");
  assertStrictEquals(out[1], xbox1);
  // A pad with no sticks (the SNES pad) is never split.
  compat.splitReset();
  const snes = fakePad({
    id: PADS.snes.id,
    mapping: "",
    axes: [0, 0],
    buttons: 12,
  });
  assertEquals(compat.splitTargets([snes]), []);
  out = split([snes], { now: 0 });
  assertStrictEquals(out[0], snes);
  assertStrictEquals(out[4], null);
  // No pads at all: an empty, well-formed list.
  assertEquals(split([], { now: 0 }).filter(Boolean), []);
  assertEquals(split(null, { now: 0 }).filter(Boolean), []);
  assertEquals(compat.splitTargets(null), []);
});

Deno.test("split: a real pad already at index + 4 keeps its slot; the right half takes the next", () => {
  compat.splitReset();
  const legion = fakePad({ index: 0, pressed: [0] });
  const other = fakePad({ id: PADS.ds4.id, index: 4 });
  const out = split([legion, null, null, null, other], { now: 0 });
  assertStrictEquals(out[4], other);
  assertEquals(out[5].id, legion.id + " [R]");
  assertStrictEquals(out[5].index, 5);
});

// gamepad-support.js's processButtonGroup, driven with a stand-in for the
// manager: no window in Deno, so the class cannot be constructed here.
function fakeManager() {
  const sent: string[] = [];
  const proto = GamepadManager.prototype;
  const state = proto.initialButtonState();
  let starts = 0;
  // deno-lint-ignore no-explicit-any
  const self: any = {
    splitPadsActive: false,
    _splitTargets: null,
    buttonState: { 0: state, 1: proto.initialButtonState() },
    ensureButtonState: (i: number) => self.buttonState[i],
    readDpad: proto.readDpad,
    decodeHat: proto.decodeHat,
    isSnesController: proto.isSnesController,
    isHeldBackSlot: proto.isHeldBackSlot,
    shouldSwallowFor: () => false,
    isConfiguratorOpen: () => false,
    isAnyOverlayOpen: () => false,
    getEffectiveMappingForLayout: proto.getEffectiveMappingForLayout,
    getKeyCode: proto.getKeyCode,
    getControllerId: proto.getControllerId,
    handleStartInGame: () => {
      starts++;
      return true;
    },
    handleSpecialActions() {},
    dispatchKeyboardEvent(type: string, m: { keyboardKey: string }) {
      sent.push(type + ":" + m.keyboardKey);
    },
    starts: () => starts,
  };
  return { self, sent, state };
}

Deno.test("split mode holds back the keys for the right half's buttons — and Start's tap — on the split pads only", () => {
  assertEquals([...support.SPLIT_RIGHT_HALF_SLOTS].sort((a, b) => a - b), [
    0,
    1,
    2,
    3,
    5,
    7,
    9,
    11,
  ]);
  // A, LB, RB, Menu, D-up
  const pressed = [0, 4, 5, 9, 12];
  const run = (split: boolean, targets: Set<number> | null, index = 0) => {
    const { self, sent } = fakeManager();
    self.splitPadsActive = split;
    self._splitTargets = targets;
    const controller = fakePad({ id: PADS.xbox.id, index, pressed });
    for (const group of ["dpad", "face", "shoulder", "special"]) {
      GamepadManager.prototype.processButtonGroup.call(
        self,
        group,
        controller,
        index,
        { ...self.buttonState[index] },
        DEFAULT_MAPPING,
        false,
      );
    }
    return { sent, starts: self.starts() as number };
  };
  // Off: everything goes, and Menu takes the in-game Start path (the tap).
  assertEquals(run(false, null), {
    sent: ["keydown:ArrowUp", "keydown: ", "keydown:q", "keydown:e"],
    starts: 1,
  });
  // On, for this pad: A (Space), RB (e) and Menu (its tap) stay home; the
  // D-pad and LB still go.
  assertEquals(run(true, new Set([0])), {
    sent: ["keydown:ArrowUp", "keydown:q"],
    starts: 0,
  });
  // On, but this pad is not one the split view splits: untouched.
  assertEquals(run(true, new Set([0]), 1), {
    sent: ["keydown:ArrowUp", "keydown: ", "keydown:q", "keydown:e"],
    starts: 1,
  });
  // On, with no compat plugin to name the targets: every pad is held back.
  assertEquals(run(true, null, 1), {
    sent: ["keydown:ArrowUp", "keydown:q"],
    starts: 0,
  });
});

Deno.test("switching split mode on releases a right-half key already held", () => {
  const { self, sent, state } = fakeManager();
  const controller = fakePad({ id: PADS.xbox.id });
  self.controllers = { 0: controller };
  self.controllerMappings = { [controller.id]: DEFAULT_MAPPING };
  self.readSplitTargets = () => new Set([0]);
  state.btnBottom = true; // A held: its Space keydown already went out
  state.leftShoulder = true; // LB held: player 1's, stays down
  GamepadManager.prototype.setSplitPadsActive.call(self, true);
  assertEquals(sent, ["keyup: "]);
  assert(self.splitPadsActive);
  assertEquals([...self._splitTargets], [0]);
  // Off again releases nothing — the keys were never sent.
  GamepadManager.prototype.setSplitPadsActive.call(self, false);
  assertEquals(sent, ["keyup: "]);
  assert(!self.splitPadsActive);
  assertStrictEquals(self._splitTargets, null);
});
