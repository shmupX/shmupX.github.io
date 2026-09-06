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
