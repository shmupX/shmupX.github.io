// static/virtual-pad — the touch controller's wire form, and the shim that
// turns it into a gamepad inside a game page.

import { assert, assertEquals } from "@std/assert";
import {
  decodePadState,
  encodePadState,
  gamepadFromState,
  padIdFor,
  padStateActive,
} from "../static/virtual-pad/virtual-pad.js";

Deno.test("a pad state survives the wire, clamped and masked", () => {
  const msg = encodePadState({
    axes: [0.5, -2, 0.1234567, NaN],
    bits: (1 << 9) | (1 << 30),
  }, "twin");
  assertEquals(msg.t, "pad");
  assertEquals(msg.l, "twin");
  assertEquals(msg.a, [0.5, -1, 0.123, 0]);
  assertEquals(msg.b, 1 << 9); // bit 30 is not a standard button
  const back = decodePadState(JSON.parse(JSON.stringify(msg)))!;
  assertEquals(back.layout, "twin");
  assertEquals(back.axes, [0.5, -1, 0.123, 0]);
  assertEquals(back.bits, 1 << 9);
  assertEquals(decodePadState({ t: "close" }), null);
  assertEquals(decodePadState(null), null);
  assertEquals(
    decodePadState({ t: "pad", l: "weird", a: "x", b: 1.5 })!.layout,
    "classic",
  );
});

Deno.test("the gamepad a game reads is the standard mapping's shape", () => {
  const pad = gamepadFromState({
    axes: [1, 0, 0, -1],
    bits: (1 << 0) | (1 << 9),
  }, { layout: "twin", index: 2 });
  assertEquals(pad.mapping, "standard");
  assertEquals(pad.index, 2);
  assertEquals(pad.buttons.length, 17);
  assertEquals(pad.buttons[0].pressed, true);
  assertEquals(pad.buttons[9].value, 1);
  assertEquals(pad.buttons[1].pressed, false);
  assertEquals(pad.axes, [1, 0, 0, -1]);
  // Sh'M↑ Party treats a pad whose id says "touch twin-stick" as touch input.
  assert(/touch twin-?stick/i.test(pad.id));
  assert(!/twin/i.test(padIdFor("classic")));
  assert(padStateActive({ axes: [0, 0, 0.5, 0], bits: 0 }));
  assert(!padStateActive({ axes: [0, 0.01, 0, 0], bits: 0 }));
});

Deno.test("pad-shim adds the controller's pad to getGamepads and drops it when silent", async () => {
  const src = await Deno.readTextFile(
    new URL("../static/virtual-pad/pad-shim.js", import.meta.url),
  );
  const events: string[] = [];
  const intervals: Array<() => void> = [];
  let now = 1000;
  const fakeWindow: Record<string, unknown> = {
    navigator: { getGamepads: () => [null, null, null, null] },
    performance: { now: () => now },
    dispatchEvent: (e: Event) => events.push(e.type),
  };
  const run = new Function(
    "window",
    "navigator",
    "setInterval",
    "Date",
    "BroadcastChannel",
    "document",
    "performance",
    src,
  );
  run(
    fakeWindow,
    fakeWindow.navigator,
    (fn: () => void) => intervals.push(fn),
    { now: () => now },
    undefined,
    undefined,
    fakeWindow.performance,
  );
  const nav = fakeWindow.navigator as {
    getGamepads: () => Array<Record<string, unknown> | null>;
  };
  assertEquals(nav.getGamepads().filter(Boolean).length, 0);
  const push = fakeWindow.__cmgVirtualPadPush as (m: unknown) => void;
  push(JSON.stringify({ t: "pad", l: "twin", a: [0, 0, 1, 0], b: 1 << 9 }));
  assertEquals(events, ["gamepadconnected"]);
  const pads = nav.getGamepads();
  const pad = pads[0]!;
  assertEquals((pad.axes as number[])[2], 1);
  assertEquals((pad.buttons as Array<{ pressed: boolean }>)[9].pressed, true);
  assert(/Twin-Stick/.test(String(pad.id)));
  // Nothing for five seconds: the pad goes.
  now += 5000;
  for (const fn of intervals) fn();
  assertEquals(events, ["gamepadconnected", "gamepaddisconnected"]);
  assertEquals(nav.getGamepads().filter(Boolean).length, 0);
});
