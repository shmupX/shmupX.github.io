// The offline half of `deno task testdrive:pad`: the ViGEm bus protocol in
// scripts/lib/vigem.ts and the drive's own rules in scripts/lib/testdrive-pad.ts.
//
// The bus protocol is worth pinning byte for byte because the bus answers a
// wrong one the least helpful way there is. A request whose Size field is off
// by the padding is refused with a bare error code, and an IOCTL code with the
// wrong access bits is refused the same way, so a drift here reads as "ViGEm is
// broken on this machine". The values below are the ones the drive was proven
// with against ViGEmBus 1.21.442: a USB\VID_054C&PID_09CC device Chrome named
// "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)".
//
// Nothing here opens the bus or a browser; VirtualDs4 is the only FFI caller
// and no case constructs one.

import { assert, assertEquals } from "@std/assert";
import {
  ds4SubmitRequest,
  IOCTL_DS4_SUBMIT_REPORT,
  IOCTL_VIGEM_CHECK_VERSION,
  IOCTL_VIGEM_PLUGIN_TARGET,
  IOCTL_VIGEM_UNPLUG_TARGET,
  IOCTL_VIGEM_WAIT_DEVICE_READY,
  pluginRequest,
  sizedRequest,
  VIGEM_BUS_GUID,
} from "../scripts/lib/vigem.ts";
import {
  HELD_FRAMES,
  HELD_FRAMES_EXPR,
  judgeStep,
  MAIN_MENU_LABELS,
  MENU_STEPS,
  padIdMatches,
  TRACE_INSTALL,
  TRACE_TAKE,
  UNLOCK_PRESS,
} from "../scripts/lib/testdrive-pad.ts";

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

Deno.test("the bus IOCTL codes are ViGEm's", () => {
  assertEquals(IOCTL_VIGEM_PLUGIN_TARGET, 0x2AA004);
  assertEquals(IOCTL_VIGEM_UNPLUG_TARGET, 0x2AA008);
  assertEquals(IOCTL_VIGEM_CHECK_VERSION, 0x2AA00C);
  assertEquals(IOCTL_VIGEM_WAIT_DEVICE_READY, 0x2AA010);
  assertEquals(IOCTL_DS4_SUBMIT_REPORT, 0x2AA80C);
});

Deno.test("the bus interface GUID is laid out as Windows stores a GUID", () => {
  // {96E42B22-F5E9-42F8-B043-ED0F932F014F}: Data1-3 little-endian, Data4 as is.
  assertEquals(
    hex(VIGEM_BUS_GUID),
    "22 2b e4 96 e9 f5 f8 42 b0 43 ed 0f 93 2f 01 4f",
  );
});

Deno.test("a DS4 plug-in request names Sony and the product asked for", () => {
  assertEquals(
    hex(pluginRequest(3, 0x09CC)),
    "10 00 00 00 03 00 00 00 02 00 00 00 4c 05 cc 09",
  );
});

Deno.test("version, ready and unplug requests are a Size and one value", () => {
  assertEquals(hex(sizedRequest(1)), "08 00 00 00 01 00 00 00");
  assertEquals(hex(sizedRequest(7)), "08 00 00 00 07 00 00 00");
});

Deno.test("a neutral DS4 report centres the sticks and releases the D-pad", () => {
  const b = ds4SubmitRequest(1);
  // 20 bytes: the basic report's Size, which is how the bus tells it from the
  // 63-byte extended one. D-pad 8 = released; 0x80 = a centred stick.
  assertEquals(b.length, 20);
  assertEquals(
    hex(b),
    "14 00 00 00 01 00 00 00 80 80 80 80 08 00 00 00 00 00 00 00",
  );
});

Deno.test("the D-pad is a hat in the low nibble, with the face buttons above it", () => {
  assertEquals(ds4SubmitRequest(1, { dpad: "S" })[12], 0x04);
  assertEquals(ds4SubmitRequest(1, { dpad: "N" })[12], 0x00);
  const crossDown = ds4SubmitRequest(1, { dpad: "S", buttons: ["cross"] });
  assertEquals(new DataView(crossDown.buffer).getUint16(12, true), 0x0024);
  const options = ds4SubmitRequest(1, { buttons: ["options"] });
  assertEquals(
    new DataView(options.buffer).getUint16(12, true),
    (1 << 13) | 0x08,
  );
});

Deno.test("sticks, the PS button and the triggers land in their bytes", () => {
  const b = ds4SubmitRequest(2, {
    lx: 0xFF,
    ly: 0,
    ps: true,
    touchpad: true,
    l2: 9,
    r2: 200,
  });
  assertEquals([b[8], b[9], b[10], b[11]], [0xFF, 0x00, 0x80, 0x80]);
  assertEquals(b[14], 0x03);
  assertEquals([b[15], b[16]], [9, 200]);
});

Deno.test("the drive's pad matcher knows Chrome's and Firefox's spellings", () => {
  assert(
    padIdMatches(
      "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)",
      0x09CC,
    ),
  );
  assert(
    padIdMatches(
      "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
      0x0CE6,
    ),
  );
  assert(padIdMatches("54c-9cc-Wireless Controller", 0x09CC));
  assert(
    !padIdMatches(
      "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)",
      0x09CC,
    ),
  );
  assert(
    !padIdMatches(
      "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)",
      0x09CC,
    ),
  );
  // A product id that merely starts the same must not pass for it.
  assert(
    !padIdMatches(
      "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc1)",
      0x09CC,
    ),
  );
});

Deno.test("every scripted press is one row, inside the menu, never across an end", () => {
  let row = 0;
  for (const step of MENU_STEPS) {
    assertEquals(Math.abs(step.want - row), 1, step.label);
    assert(step.want >= 0 && step.want < MAIN_MENU_LABELS.length, step.label);
    row = step.want;
  }
  // Both the D-pad and the stick are exercised, both ways.
  const kinds = new Set(
    MENU_STEPS.map((s) =>
      `${s.press.dpad ? "dpad" : "stick"}:${s.label.split(" ").pop()}`
    ),
  );
  for (const k of ["dpad:down", "dpad:up", "stick:down", "stick:up"]) {
    assert(kinds.has(k), k);
  }
});

Deno.test("the unlocking press is horizontal only, so it cannot move the menu", () => {
  assertEquals(UNLOCK_PRESS.ly, undefined);
  assertEquals(UNLOCK_PRESS.dpad, undefined);
  assert((UNLOCK_PRESS.lx ?? 0x80) !== 0x80);
});

Deno.test("a press is held until the page has drawn frames with it down", () => {
  // One frame is a press the launcher's per-frame poll may still have missed
  // by a hair; two is the floor. The expression reads the counter the
  // sampler's frame callback bumps, under the same name.
  assert(HELD_FRAMES >= 2);
  assert(TRACE_INSTALL.includes("bump('heldFrames')"));
  assert(TRACE_INSTALL.includes("requestAnimationFrame(frame)"));
  assert(HELD_FRAMES_EXPR.includes("seen.heldFrames"));
  // A take hands back the counts and starts a fresh window.
  assert(TRACE_TAKE.includes("t.seen = {}"));
});

Deno.test("a press is judged on where it ended and on moving once", () => {
  const step = MENU_STEPS[0];
  assert(judgeStep(step, 0, [1]).ok);
  const none = judgeStep(step, 0, []);
  assert(!none.ok);
  assertEquals(none.got, 0);
  // Two rows for one press: wrong row, and caught as such.
  assert(!judgeStep(step, 0, [1, 2]).ok);
  // Right row in the end but by way of another: still one press, two moves.
  assert(!judgeStep(step, 0, [2, 1]).ok);
});
