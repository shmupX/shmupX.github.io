// lib/display-layout.ts — reading the screens and planning the controller
// screen, against fixtures shaped like a Legion Go docked to a monitor.

import { assert, assertEquals } from "@std/assert";
import {
  isInternalName,
  parseKscreenJson,
  parseXrandr,
  planExtend,
  unsupportedReason,
} from "../lib/display-layout.ts";
import { controllerOrigin } from "../routes/api/second-screen.ts";

// `kscreen-doctor -j` on a Legion Go set to "external only" while docked: the
// panel is connected but off, natively portrait and turned a quarter (8 =
// Right), at 150%.
const KSCREEN_EXTERNAL_ONLY = JSON.stringify({
  outputs: [
    {
      id: 1,
      name: "eDP-1",
      type: 7,
      connected: true,
      enabled: false,
      priority: 0,
      pos: { x: 0, y: 0 },
      rotation: 8,
      scale: 1.5,
      currentModeId: "",
      preferredModes: ["1"],
      modes: [
        { id: "1", size: { width: 1600, height: 2560 }, refreshRate: 144 },
        { id: "2", size: { width: 1200, height: 1920 }, refreshRate: 60 },
      ],
      size: { width: -1, height: -1 },
    },
    {
      id: 2,
      name: "DP-1",
      type: 14,
      connected: true,
      enabled: true,
      priority: 1,
      pos: { x: 0, y: 0 },
      rotation: 1,
      scale: 1,
      currentModeId: "7",
      modes: [{ id: "7", size: { width: 2560, height: 1440 } }],
    },
    { id: 3, name: "DP-2", connected: false, enabled: false, modes: [] },
  ],
});

Deno.test("internal panels are told from plugged-in ones by connector", () => {
  for (const n of ["eDP-1", "eDP1", "LVDS-1", "DSI-1"]) {
    assert(isInternalName(n), n);
  }
  for (const n of ["DP-1", "HDMI-A-1", "DVI-I-1", "VGA-1"]) {
    assert(!isInternalName(n), n);
  }
});

Deno.test("kscreen: a disabled panel reads its preferred mode, rotated and scaled", () => {
  const outs = parseKscreenJson(KSCREEN_EXTERNAL_ONLY);
  assertEquals(outs.length, 3);
  const panel = outs.find((o) => o.name === "eDP-1")!;
  assertEquals(panel.internal, true);
  assertEquals(panel.enabled, false);
  // 1600×2560 turned a quarter is 2560×1600, at 150% is 1707×1067.
  assertEquals([panel.width, panel.height], [1707, 1067]);
  const monitor = outs.find((o) => o.name === "DP-1")!;
  assertEquals(monitor.primary, true);
  assertEquals([monitor.width, monitor.height], [2560, 1440]);
  assertEquals(parseKscreenJson("not json"), []);
});

Deno.test("kscreen: the plan turns the panel on to the right of the monitor, and back off", () => {
  const plan = planExtend(parseKscreenJson(KSCREEN_EXTERNAL_ONLY), "kscreen");
  assert(!("error" in plan));
  assertEquals(plan.external.name, "DP-1");
  assertEquals([plan.internal.x, plan.internal.y], [2560, 0]);
  assertEquals(plan.apply, [[
    "kscreen-doctor",
    "output.eDP-1.enable",
    "output.eDP-1.position.2560,0",
    "output.DP-1.primary",
  ]]);
  assertEquals(plan.restore, [["kscreen-doctor", "output.eDP-1.disable"]]);
});

Deno.test("a panel that is already on is used where it is and left on", () => {
  const doc = JSON.parse(KSCREEN_EXTERNAL_ONLY);
  doc.outputs[0].enabled = true;
  doc.outputs[0].currentModeId = "1";
  doc.outputs[0].pos = { x: 2560, y: 200 };
  const plan = planExtend(parseKscreenJson(JSON.stringify(doc)), "kscreen");
  assert(!("error" in plan));
  assertEquals(plan.apply, []);
  assertEquals(plan.restore, []);
  assertEquals([plan.internal.x, plan.internal.y], [2560, 200]);
});

Deno.test("no monitor, or no panel, is a reason rather than a plan", () => {
  const doc = JSON.parse(KSCREEN_EXTERNAL_ONLY);
  const noMonitor = parseKscreenJson(
    JSON.stringify({ outputs: [doc.outputs[0]] }),
  );
  const a = planExtend(noMonitor, "kscreen");
  assert("error" in a && /external/.test(a.error));
  const noPanel = parseKscreenJson(
    JSON.stringify({ outputs: [doc.outputs[1]] }),
  );
  const b = planExtend(noPanel, "kscreen");
  assert("error" in b && /built-in/.test(b.error));
});

const XRANDR =
  `Screen 0: minimum 320 x 200, current 2560 x 1440, maximum 16384 x 16384
eDP-1 connected (normal left inverted right x axis y axis)
   1600x2560    144.00 +  60.00
   1200x1920     60.00
HDMI-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     59.95*+
   1920x1080     60.00
DP-1 disconnected (normal left inverted right x axis y axis)
`;

Deno.test("xrandr: geometry for the lit, the preferred mode for the dark", () => {
  const outs = parseXrandr(XRANDR);
  assertEquals(outs.map((o) => o.name), ["eDP-1", "HDMI-1", "DP-1"]);
  const panel = outs[0];
  assertEquals([panel.enabled, panel.width, panel.height], [false, 1600, 2560]);
  assertEquals(outs[1].primary, true);
  assertEquals([outs[1].x, outs[1].width], [0, 2560]);
  assertEquals(outs[2].connected, false);
  const plan = planExtend(outs, "xrandr");
  assert(!("error" in plan));
  assertEquals(plan.apply[0].slice(0, 6), [
    "xrandr",
    "--output",
    "eDP-1",
    "--auto",
    "--right-of",
    "HDMI-1",
  ]);
  assertEquals(plan.restore, [["xrandr", "--output", "eDP-1", "--off"]]);
});

Deno.test("Game Mode and other systems say why not", () => {
  assertEquals(
    unsupportedReason("linux", { XDG_CURRENT_DESKTOP: "KDE" }),
    null,
  );
  assert(
    /Game Mode/.test(
      unsupportedReason("linux", { GAMESCOPE_WAYLAND_DISPLAY: "gamescope-0" })!,
    ),
  );
  assert(
    /Game Mode/.test(
      unsupportedReason("linux", { XDG_CURRENT_DESKTOP: "gamescope" })!,
    ),
  );
  assert(unsupportedReason("windows", {}) !== null);
});

Deno.test("the controller page opens on the launcher page's own loopback origin only", () => {
  const req = "http://127.0.0.1:8787/api/second-screen";
  assertEquals(
    controllerOrigin("http://localhost:8787", req),
    "http://localhost:8787",
  );
  assertEquals(
    controllerOrigin("http://127.0.0.1:8787", req),
    "http://127.0.0.1:8787",
  );
  // Another port, another host, or nonsense: the request's own origin.
  assertEquals(
    controllerOrigin("http://localhost:9999", req),
    "http://127.0.0.1:8787",
  );
  assertEquals(
    controllerOrigin("https://evil.example:8787", req),
    "http://127.0.0.1:8787",
  );
  assertEquals(controllerOrigin(42, req), "http://127.0.0.1:8787");
});
