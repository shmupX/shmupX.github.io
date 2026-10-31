#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:pad` — prove a PlayStation controller moves the
 * launcher's main menu, with nobody holding one.
 *
 * The question it answers is the bug report "the PS controller does not move
 * the selection": is it the launcher, or the pad never reaching the browser?
 * A virtual DualShock 4 is plugged into the ViGEm bus (scripts/lib/vigem.ts)
 * under Sony's own vendor and product ids, so Windows enumerates a USB DS4 and
 * Chrome names it exactly as it names the hardware — "Wireless Controller
 * (STANDARD GAMEPAD Vendor: 054c Product: 09cc)" — with the standard mapping.
 * Then, against the launcher in a Chrome with a DevTools port: one stick-right
 * press to unlock the pad for the page (Chrome shows a page no pad until one
 * has been used; on the main menu left/right move nothing, and that is
 * checked), then D-pad down, down, up, left stick down, up, D-pad up — each
 * press asserted to land on exactly the next row, no further and not twice.
 * A press is held until the page has drawn two frames with it down, because
 * the launcher reads pads once a frame and headless Chrome draws this page at
 * a few frames a second (scripts/lib/testdrive-pad.ts, HELD_FRAMES_EXPR); a
 * sampler in the page logs what it read during each press, so a miss says
 * whether the press never arrived or arrived and was dropped.
 * The pad is unplugged when the drive ends, and by the bus itself if the
 * process dies first.
 *
 * How it runs (scripts/lib/testdrive-rig.ts): a vite dev server on this
 * checkout (or --origin for one that is already up, or the packaged
 * launcher's), and a Chrome on its own profile under build/testdrive/.cache.
 * Headless by default; --headed shows the window. The launcher under test is
 * this checkout's static/dashboard.bundle.js — what the packaged app embeds.
 *
 *   deno task testdrive:pad
 *   deno task testdrive:pad -- --headed
 *   deno task testdrive:pad -- --pid 05c4          # the first-model DS4
 *   deno task testdrive:pad -- --origin http://127.0.0.1:5173
 *   deno task testdrive:pad -- --help
 *
 * Output: build/testdrive/pad/ holding before.png, one step-<n>.png per press
 * and report.json; exit 1 when any press lands anywhere but its row.
 *
 * Needs Windows with ViGEmBus installed (DS4Windows brings it) and a Chromium.
 * A real controller plugged in at the same time is harmless: the launcher
 * follows whichever pad was used last (pickActivePad).
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { Rig, sleep, until } from "./lib/testdrive-rig.ts";
import { DS4_V2_PRODUCT_ID, VirtualDs4 } from "./lib/vigem.ts";
import {
  HELD_FRAMES,
  HELD_FRAMES_EXPR,
  judgeStep,
  MAIN_MENU_LABELS,
  MENU_EXPR,
  MENU_STEPS,
  type MenuRead,
  padIdMatches,
  type PadRead,
  PADS_EXPR,
  type StepResult,
  TRACE_INSTALL,
  TRACE_TAKE,
  UNLOCK_PRESS,
} from "./lib/testdrive-pad.ts";

const ROOT = repoRoot();
const DEFAULT_CDP_PORT = 9337;
const DEFAULT_SERVE_PORT = 5173;

const HELP = `deno task testdrive:pad [-- flags]

Plugs a virtual DualShock 4 into the ViGEm bus and drives the launcher's main
menu with it in Chrome: D-pad and left stick, down and up, each press asserted
to move the selection exactly one row. Screenshots and report.json land in
build/testdrive/pad/; exit 1 on any wrong row.

  --pid <hex>        the DS4's USB product id (default: ${
  DS4_V2_PRODUCT_ID.toString(16).padStart(4, "0")
}, the DS4 v2; 05c4 is the first model)
  --press-ms <n>     the shortest a press is held (default: 150); it stays down
                     until the launcher has drawn ${HELD_FRAMES} frames with it held
  --origin <url>     a launcher already being served (default: start vite here)
  --serve-port <n>   the port to start vite on (default: ${DEFAULT_SERVE_PORT}; a server already there is used)
  --cdp-port <n>     the DevTools port (default: ${DEFAULT_CDP_PORT})
  --chrome <path>    the browser to drive (default: $CHROME_BIN, then the usual installs)
  --headed           drive a visible Chrome instead of a headless one, to watch the run
  --out <dir>        output directory (default: build/testdrive/pad)
  --help`;

type Flags = {
  pid: string;
  "press-ms": number;
  origin?: string;
  "serve-port": number;
  "cdp-port": number;
  chrome?: string;
  headed: boolean;
  out?: string;
  help: boolean;
};

// `deno task … -- --flag` hands the script the bare `--` as well.
const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["headed", "help"],
  string: ["pid", "origin", "chrome", "out"],
  default: {
    pid: DS4_V2_PRODUCT_ID.toString(16),
    "press-ms": 150,
    headed: false,
    help: false,
    "serve-port": DEFAULT_SERVE_PORT,
    "cdp-port": DEFAULT_CDP_PORT,
  },
}) as unknown as Flags;

if (flags.help) {
  console.log(HELP);
  Deno.exit(0);
}

const log = (line: string) => console.log(`[pad] ${line}`);
let rig: Rig | null = null;
let pad: VirtualDs4 | null = null;
async function teardown(): Promise<void> {
  try {
    pad?.unplug();
  } catch { /* the bus drops it with the handle anyway */ }
  await rig?.close();
}
async function fail(msg: string): Promise<never> {
  console.error(`[pad] ${msg}`);
  await teardown();
  Deno.exit(1);
}
Deno.addSignalListener("SIGINT", () => {
  teardown().then(() => Deno.exit(130));
});

const productId = parseInt(flags.pid.replace(/^0x/i, ""), 16);
if (!Number.isInteger(productId) || productId <= 0 || productId > 0xFFFF) {
  await fail(`--pid ${flags.pid} is not a USB product id in hex`);
}
const outDir = resolve(ROOT, flags.out ?? join("build", "testdrive", "pad"));
await ensureDir(outDir);
for await (const e of Deno.readDir(outDir)) {
  if (/^(before|step-\d+)\.png$|^report\.json$/.test(e.name)) {
    await Deno.remove(join(outDir, e.name)).catch(() => {});
  }
}

const report: Record<string, unknown> = {
  pad: { vendor: "054c", product: productId.toString(16).padStart(4, "0") },
  startedAt: new Date().toISOString(),
};

try {
  rig = await Rig.start({
    origin: flags.origin,
    servePort: flags["serve-port"],
    cdpPort: flags["cdp-port"],
    chrome: flags.chrome,
    headed: flags.headed,
    viewport: { width: 1280, height: 720 },
    profileName: "pad",
    log,
  });
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
const { cdp, origin } = rig!;
report.origin = origin;
report.browser = rig!.browser;

const readMenu = () => cdp.eval<MenuRead>(MENU_EXPR);
async function shot(name: string): Promise<void> {
  const r = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Deno.writeFile(
    join(outDir, name),
    Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)),
  );
}

// ── The launcher, settled ────────────────────────────────────────────────────
// Settled means the menu is drawn AND the document under it has stopped being
// replaced: a first visit on a fresh profile is when vite finishes optimising
// the bundle's dependencies, and it reloads the page to do it. Read before
// that, the first press lands on a document that is about to be thrown away.
log(`opening the launcher at ${origin}/…`);
await cdp.send("Page.navigate", { url: `${origin}/` });
let lastDoc = 0;
let sameSince = 0;
try {
  await until("the launcher's main menu to draw and stay", 90_000, async () => {
    const m = await readMenu();
    if (m.rows !== MAIN_MENU_LABELS.length || m.sel < 0) return null;
    if (m.doc !== lastDoc) {
      lastDoc = m.doc;
      sameSince = Date.now();
      return null;
    }
    // The boot overlay is up for 1.6 s; past 2.5 s on one document is settled.
    return Date.now() - sameSince >= 2500 ? m : null;
  }, 250);
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
const start = await readMenu();
// menuSel starts on Games on every load; anything else is a finding of its own.
if (start.sel !== 0) {
  await fail(`the launcher opened on ${start.label}, not Games`);
}
await shot("before.png");

// ── The pad ──────────────────────────────────────────────────────────────────
try {
  pad = await VirtualDs4.plug({ productId });
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
log(
  `virtual DS4 054c:${
    productId.toString(16).padStart(4, "0")
  } plugged in (bus serial ${pad!.serial})`,
);

let seen: PadRead | null = null;
try {
  seen = await until("the page to see the virtual DS4", 20_000, async () => {
    await pad!.press(UNLOCK_PRESS, 200);
    const pads = await cdp.eval<PadRead[]>(PADS_EXPR);
    return pads.find((p) => padIdMatches(p.id, productId)) ?? null;
  }, 300);
} catch (e) {
  report.padsSeen = await cdp.eval<PadRead[]>(PADS_EXPR).catch(() => []);
  await Deno.writeTextFile(
    join(outDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await fail(
    `${
      e instanceof Error ? e.message : e
    }. The pad is on the bus but Chrome never ` +
      `listed it: look for it in Device Manager, and close any remapper (DS4Windows, ` +
      `Steam Input) that hides real pads behind its own.`,
  );
}
report.padSeen = seen;
log(
  `the page sees #${seen!.index} "${seen!.id}" (mapping=${
    seen!.mapping || "none"
  }, ${seen!.buttons} buttons, ${seen!.axes} axes)`,
);
if (seen!.mapping !== "standard") {
  log(
    `  not the standard mapping — the launcher falls back to its hat/axis sweeps for this pad`,
  );
}

await sleep(400);
const afterUnlock = await readMenu();
report.afterUnlock = afterUnlock.label;
const results: StepResult[] = [];
if (afterUnlock.sel !== 0) {
  log(
    `FAIL the unlocking stick-right left the menu on ${afterUnlock.label}, not Games`,
  );
}

// ── The presses ──────────────────────────────────────────────────────────────
await cdp.eval(TRACE_INSTALL);
const pageSaw: Record<string, number>[] = [];
let from = afterUnlock.sel;
for (const [i, step] of MENU_STEPS.entries()) {
  await cdp.eval(TRACE_TAKE);
  // Held for --press-ms at least, and on until the page has drawn
  // HELD_FRAMES frames with it down (see HELD_FRAMES_EXPR for why).
  pad!.set(step.press);
  const down = Date.now();
  try {
    await until(
      `the launcher to draw a frame with "${step.label}" held`,
      5000,
      async () =>
        Date.now() - down >= flags["press-ms"] &&
        await cdp.eval<number>(HELD_FRAMES_EXPR) >= HELD_FRAMES,
      10,
    );
  } catch {
    /* judged below: the trace says what the page read */
  } finally {
    pad!.set({});
  }
  // Watch long enough to see a second move if one press makes two (the
  // launcher's hold-to-repeat starts well after this window), and stop early
  // only once the row has changed and then held still for a while.
  const moves: number[] = [];
  let last = from;
  const t0 = Date.now();
  let stillSince = Date.now();
  while (Date.now() - t0 < 1500) {
    const m = await readMenu();
    if (m.sel !== last) {
      moves.push(m.sel);
      last = m.sel;
      stillSince = Date.now();
    } else if (moves.length && Date.now() - stillSince >= 450) break;
    await sleep(40);
  }
  const r = judgeStep(step, from, moves);
  results.push(r);
  const saw = await cdp.eval<Record<string, number> | null>(TRACE_TAKE) ?? {};
  pageSaw.push(saw);
  const name = (n: number) => MAIN_MENU_LABELS[n] ?? `row ${n}`;
  // In 4 ms samples: how long the page read each direction during this press.
  const held = Object.entries(saw)
    .filter(([k]) =>
      !["samples", "frames", "maxGapMs", "heldFrames"].includes(k)
    )
    .map(([k, n]) => `${k} ${n * 4}ms`).join(", ") || "no direction at all";
  const frames = `${saw.heldFrames ?? 0} frames with it held`;
  log(
    `${r.ok ? "ok  " : "FAIL"} ${step.label.padEnd(16)} ${name(from)} -> ${
      moves.length ? moves.map(name).join(" -> ") : "(did not move)"
    }${
      r.ok ? "" : `  (wanted ${name(step.want)})`
    }  [page read ${held}; ${frames}]`,
  );
  await shot(`step-${i + 1}.png`);
  from = r.got;
}

pad!.unplug();
log("virtual DS4 unplugged");
// The frame rate the launcher drew at: a slow one is worth knowing on its own,
// since the pad poll runs no faster and a real thumb's tap is 80-150 ms.
const gaps = pageSaw.map((s) => s.maxGapMs ?? 0);
const maxGapMs = Math.max(0, ...gaps);
report.longestFrameGapMs = maxGapMs;
log(
  `longest frame gap ${maxGapMs} ms${
    maxGapMs > 100
      ? ` — at this frame rate a quick real tap can fall between two of the launcher's pad polls${
        flags.headed
          ? ""
          : " (headless Chrome draws without a GPU; --headed draws at the display's rate)"
      }`
      : ""
  }`,
);
const passed = afterUnlock.sel === 0 && results.every((r) => r.ok);
report.steps = results.map((r, i) => ({ ...r, pageSaw: pageSaw[i] }));
report.passed = passed;
report.finishedAt = new Date().toISOString();
await Deno.writeTextFile(
  join(outDir, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
log(
  `${passed ? "PASS" : "FAIL"}: ${
    results.filter((r) => r.ok).length
  }/${results.length} presses on their row; ${outDir}`,
);
await rig!.close();
Deno.exit(passed ? 0 : 1);
