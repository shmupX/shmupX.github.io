#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:ps2:compare "<level>"` — play a level's OG and MOD
 * versions side by side, ship invincible on both, and record 25 seconds of
 * it as one GIF.
 *
 * The question it answers is the one the launcher's VERSION switch raises:
 * what does MOD actually lay over this game? For a level saved from a PS2
 * export — "2019-PS2" — OG is the 2019 game as it always was and MOD adds the
 * Dezaemon weapons on top of its own shot (README: "The launcher's LIBRARY").
 * Reading the CROSSOVER table says which parts; watching the two run on the
 * same stage from the same frame says what that looks like. God mode is on so
 * neither side dies into a GAME OVER half way through the window and the
 * comparison stays a comparison of play.
 *
 * How it runs: a vite dev server on this checkout (or --origin for one that is
 * already up), a headless Chrome on a page of two same-origin iframes — one per
 * version, each the game's own 256×480 — both booted straight into the stage
 * with ?stage=, each frozen the moment its stage begins and both woken on the
 * same tick, an autopilot swaying both ships through the same moves, and
 * Page.startScreencast over the whole page for the window. The screencast's
 * uneven frames are resampled onto a steady clock and ffmpeg writes the GIF.
 *
 *   deno task testdrive:ps2:compare "2019-PS2"
 *   deno task testdrive:ps2:compare "2019-PS2" -- --seconds 10 --fps 15
 *   deno task testdrive:ps2:compare "2019-PS2" -- --origin http://127.0.0.1:5173
 *   deno task testdrive:ps2:compare -- --help
 *
 * Output: build/testdrive/ps2-compare/<slug>/ holding compare.gif, first.png
 * and last.png (the first and last frames in the GIF) and report.json.
 *
 * Needs a Chromium (--chrome, $CHROME_BIN, the usual installs, or Google
 * Chrome from Flathub — this is the one script here that runs the Flatpak,
 * since that is what this Linux box has) and ffmpeg for the GIF. The level is
 * read from the shared level database, so it needs the network.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  Cdp,
  findChrome,
} from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import { debugChromeArgs } from "./lib/game-debug.ts";
import {
  AUTOPILOT,
  compareUrls,
  concatList,
  FLATPAK_CHROME_IDS,
  flatpakChrome,
  type Frame,
  freezeExpr,
  GAME_PATH,
  gifArgs,
  harnessHtml,
  harnessSize,
  type PaneState,
  paneStateExpr,
  resample,
  type Side,
} from "./lib/testdrive-compare.ts";

const ROOT = repoRoot();
const DEFAULT_CDP_PORT = 9334;
const DEFAULT_SERVE_PORT = 5199;

const HELP = `deno task testdrive:ps2:compare "<level name>" [-- flags]

Plays the cloud level's OG and MOD versions side by side in a headless Chrome,
god mode on, and records the first seconds of the stage as one GIF in
build/testdrive/ps2-compare/<slug>/.

  <level>            a cloud level's name, e.g. "2019-PS2"
  --seconds <s>      how long to record (default: 25)
  --fps <n>          the GIF's frame rate (default: 12)
  --stage <n>        the stage to boot into (default: 0, the first)
  --no-god           play mortal
  --origin <url>     a dev server already running (default: start vite here)
  --serve-port <n>   the port to start vite on (default: ${DEFAULT_SERVE_PORT})
  --cdp-port <n>     the DevTools port (default: ${DEFAULT_CDP_PORT})
  --chrome <path>    the browser to drive (default: $CHROME_BIN, then the usual installs, then Flatpak Chrome)
  --headed           show the browser instead of running it headless
  --out <dir>        output directory (default: build/testdrive/ps2-compare/<slug>)
  --boot-wait <s>    how long each pane may take to reach the stage (default: 120)
  --keep-frames      leave the raw screencast frames beside the GIF
  --help`;

type Flags = {
  _: (string | number)[];
  seconds: number;
  fps: number;
  stage: number;
  god: boolean;
  origin?: string;
  "serve-port": number;
  "cdp-port": number;
  chrome?: string;
  headed: boolean;
  out?: string;
  "boot-wait": number;
  "keep-frames": boolean;
  help: boolean;
};

// `deno task … -- --flag` hands the script the bare `--` as well.
const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["god", "headed", "keep-frames", "help"],
  string: ["origin", "chrome", "out"],
  default: {
    seconds: 25,
    fps: 12,
    stage: 0,
    god: true,
    headed: false,
    "keep-frames": false,
    help: false,
    "serve-port": DEFAULT_SERVE_PORT,
    "cdp-port": DEFAULT_CDP_PORT,
    "boot-wait": 120,
  },
  negatable: ["god"],
}) as unknown as Flags;

const log = (line: string) => console.log(`[compare] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Everything this run started and must not outlive it.
const children: Deno.ChildProcess[] = [];
let cdp: Cdp | null = null;
async function putDown(): Promise<void> {
  if (cdp) {
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    cdp = null;
  }
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch { /* gone */ }
  }
  await sleep(500);
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch { /* gone */ }
  }
  children.length = 0;
}
async function fail(msg: string): Promise<never> {
  console.error(`[compare] ${msg}`);
  await putDown();
  Deno.exit(1);
}
Deno.addSignalListener("SIGINT", () => {
  putDown().then(() => Deno.exit(130));
});

class Abort extends Error {}
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | false | undefined>,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      if (e instanceof Abort) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(everyMs);
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${
      lastErr ? ` (last error: ${lastErr})` : ""
    }`,
  );
}

if (flags.help || flags._.length === 0) {
  console.log(HELP);
  Deno.exit(flags.help ? 0 : 2);
}
const level = String(flags._[0]);
const slug =
  level.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
  "level";
const outDir = resolve(
  ROOT,
  flags.out ?? join("build", "testdrive", "ps2-compare", slug),
);
const framesDir = join(outDir, "frames");
await ensureDir(outDir);
for (
  const stale of [
    "compare.gif",
    "first.png",
    "last.png",
    "report.json",
    "frames.txt",
  ]
) {
  await Deno.remove(join(outDir, stale)).catch(() => {});
}
await Deno.remove(framesDir, { recursive: true }).catch(() => {});
await ensureDir(framesDir);

const report: Record<string, unknown> = {
  level,
  seconds: flags.seconds,
  fps: flags.fps,
  stage: flags.stage,
  god: flags.god,
  startedAt: new Date().toISOString(),
  steps: {} as Record<string, unknown>,
};
const steps = report.steps as Record<string, unknown>;

// ── ffmpeg, checked first: a 25 s capture with no encoder is a wasted wait ──
async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}
if (!await has("ffmpeg", ["-version"])) {
  await fail("ffmpeg is needed to write the GIF and is not on the PATH");
}

// ── The browser ──────────────────────────────────────────────────────────────
// findChrome knows the usual places; this box has Chrome only as a Flatpak,
// which no path search finds, so that is the last resort.
let browser: string[] | null = null;
try {
  browser = [await findChrome(flags.chrome ?? null)];
} catch (e) {
  if (flags.chrome) await fail(e instanceof Error ? e.message : String(e));
  for (const id of FLATPAK_CHROME_IDS) {
    if (await has("flatpak", ["info", id])) {
      browser = flatpakChrome(id, [ROOT]);
      break;
    }
  }
  if (!browser) {
    await fail(
      `${e instanceof Error ? e.message : e}; nor is a Chrome Flatpak (${
        FLATPAK_CHROME_IDS.join(", ")
      }) installed`,
    );
  }
}
report.browser = browser!.join(" ");

// ── The server ───────────────────────────────────────────────────────────────
async function serving(origin: string): Promise<boolean> {
  try {
    const res = await fetch(new URL(GAME_PATH, origin), {
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
let origin: string;
if (flags.origin) {
  origin = flags.origin.replace(/\/$/, "");
  if (!await serving(origin)) {
    await fail(`${origin}${GAME_PATH} does not answer; is the dev server up?`);
  }
  log(`using the dev server at ${origin}`);
} else {
  origin = `http://127.0.0.1:${flags["serve-port"]}`;
  if (await serving(origin)) {
    log(`a server already answers at ${origin}; using it`);
  } else {
    log(`starting vite on ${origin}…`);
    const vite = new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        "npm:vite",
        "--port",
        String(flags["serve-port"]),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      cwd: ROOT,
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();
    children.push(vite);
    await until(
      "vite to serve the game route",
      90_000,
      () => serving(origin),
      1000,
    )
      .catch((e) => fail(`${e.message}; try \`deno task dev:vite\` by hand`));
    steps.vite = { port: flags["serve-port"] };
  }
}
report.origin = origin;
const urls = compareUrls(origin, level, { stage: flags.stage, god: flags.god });
report.urls = urls;

// ── Chrome on a blank same-origin page ──────────────────────────────────────
const size = harnessSize();
const profileDir = join(
  ROOT,
  "build",
  "testdrive",
  ".cache",
  `chrome-compare-${flags["cdp-port"]}`,
);
await ensureDir(profileDir);
// Any same-origin document will do as the seat for the harness; the game route
// with no level is not it (it would boot 2028.Ai), so a path nothing serves is
// opened and its 404 page replaced.
const seatUrl = `${origin}/__testdrive-compare`;
const chromeArgs = debugChromeArgs({
  url: seatUrl,
  cdpPort: flags["cdp-port"],
  profileDir,
  headless: !flags.headed,
});
// The debug script's window is one game; this page is two and a caption.
const sized = chromeArgs.map((a) =>
  a.startsWith("--window-size=")
    ? `--window-size=${size.width},${size.height}`
    : a
);
log(
  `launching ${browser![0]} ${
    flags.headed ? "(headed)" : "(headless)"
  } with DevTools on :${flags["cdp-port"]}…`,
);
const chrome = new Deno.Command(browser![0], {
  args: [...browser!.slice(1), ...sized],
  stdout: "null",
  stderr: "null",
  stdin: "null",
}).spawn();
children.push(chrome);

type Target = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};
const target = await until<Target>(
  "the page on the DevTools port",
  30_000,
  async () => {
    const res = await fetch(`http://127.0.0.1:${flags["cdp-port"]}/json/list`);
    const list = await res.json() as Target[];
    return list.find((t) =>
      t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(origin)
    ) ?? null;
  },
  250,
).catch((e) => fail(`Chrome did not come up: ${e.message}`));
cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
const dt = cdp;
await dt.send("Page.enable");
await dt.send("Runtime.enable");
await dt.send("Emulation.setDeviceMetricsOverride", {
  width: size.width,
  height: size.height,
  deviceScaleFactor: 1,
  mobile: false,
});

// ── The harness: two panes, both booting ─────────────────────────────────────
log(`seating OG and MOD side by side…`);
const { frameTree } = await dt.send<{ frameTree: { frame: { id: string } } }>(
  "Page.getFrameTree",
);
await dt.send("Page.setDocumentContent", {
  frameId: frameTree.frame.id,
  html: harnessHtml(urls, level),
});
await dt.eval(AUTOPILOT);

const sides: Side[] = ["og", "mod"];
const frozen = new Set<Side>();
const bootT0 = Date.now();
const states = await until<Record<Side, PaneState>>(
  "both panes to reach the stage",
  flags["boot-wait"] * 1000,
  async () => {
    const out = {} as Record<Side, PaneState>;
    for (const side of sides) {
      const s = await dt.eval<PaneState>(paneStateExpr(side));
      out[side] = s;
      // Each pane is stopped on the first frame of its stage, so the one that
      // boots first waits for the other and both start the window together.
      if (s.started && !frozen.has(side)) {
        if (await dt.eval<boolean>(freezeExpr(side, true))) {
          frozen.add(side);
          log(
            `${side.toUpperCase()} reached the stage after ${
              ((Date.now() - bootT0) / 1000).toFixed(1)
            }s; held`,
          );
        }
      }
    }
    return frozen.size === sides.length ? out : null;
  },
  250,
).catch(async (e) => {
  const seen = await Promise.all(
    sides.map((s) => dt.eval<PaneState>(paneStateExpr(s)).catch(() => null)),
  );
  return fail(`${e.message}: ${JSON.stringify(seen)}`);
});
for (const side of sides) {
  const s = states[side];
  if (flags.god && s.god !== true) {
    await fail(
      `${side.toUpperCase()} is not in god mode (godFlg ${s.god}); ${s.href}`,
    );
  }
  if (s.version !== side) {
    await fail(`${side.toUpperCase()} pane is playing version ${s.version}`);
  }
}
steps.boot = { ...states, waitedMs: Date.now() - bootT0 };

// ── Record ───────────────────────────────────────────────────────────────────
log(`recording ${flags.seconds}s…`);
const frames: Frame[] = [];
let n = 0;
let recording = false;
const onFrame = (p: Record<string, unknown>) => {
  dt.send("Page.screencastFrameAck", { sessionId: p.sessionId as number })
    .catch(() => {});
  if (!recording) return;
  const meta = p.metadata as { timestamp?: number } | undefined;
  const t = (meta?.timestamp ?? Date.now() / 1000) * 1000;
  const file = join(framesDir, `f${String(n++).padStart(5, "0")}.png`);
  frames.push({ file, t });
  Deno.writeFile(
    file,
    Uint8Array.from(atob(p.data as string), (c) => c.charCodeAt(0)),
  ).catch(() => {});
};
dt.on("Page.screencastFrame", onFrame);
await dt.send("Page.startScreencast", {
  format: "png",
  maxWidth: size.width,
  maxHeight: size.height,
  everyNthFrame: 1,
});
// Woken on the same tick, the autopilot on, the clock started.
recording = true;
const recT0 = Date.now();
await dt.eval(
  `(() => { ${
    sides.map((s) => freezeExpr(s, false)).join(";")
  }; window.__autopilot.on = true; return true; })()`,
);
let lastReport = 0;
while (Date.now() - recT0 < flags.seconds * 1000) {
  await sleep(100);
  const elapsed = Date.now() - recT0;
  if (elapsed - lastReport >= 5000) {
    lastReport = elapsed;
    log(`  ${(elapsed / 1000).toFixed(0)}s, ${frames.length} frames`);
  }
}
recording = false;
await dt.eval(`window.__autopilot.on = false; true`).catch(() => {});
await dt.send("Page.stopScreencast").catch(() => {});
dt.off("Page.screencastFrame", onFrame);
await sleep(300);
const after = await Promise.all(
  sides.map((s) => dt.eval<PaneState>(paneStateExpr(s)).catch(() => null)),
);
steps.record = { frames: frames.length, ms: Date.now() - recT0, after };
if (frames.length < flags.seconds) {
  await fail(
    `the screencast delivered only ${frames.length} frames in ${flags.seconds}s; the panes were not drawing`,
  );
}
log(
  `captured ${frames.length} frames (${
    (frames.length / flags.seconds).toFixed(1)
  }/s)`,
);

// ── The GIF ──────────────────────────────────────────────────────────────────
const picked = resample(frames, flags.fps, flags.seconds, recT0);
const listFile = join(outDir, "frames.txt");
await Deno.writeTextFile(listFile, concatList(picked, flags.fps));
const gifPath = join(outDir, "compare.gif");
log(`writing ${gifPath} (${picked.length} frames at ${flags.fps} fps)…`);
const ff = await new Deno.Command("ffmpeg", {
  args: gifArgs(listFile, flags.fps, gifPath),
  stdout: "null",
  stderr: "piped",
}).output();
if (!ff.success) {
  await fail(`ffmpeg failed: ${new TextDecoder().decode(ff.stderr)}`);
}
await Deno.copyFile(picked[0], join(outDir, "first.png"));
await Deno.copyFile(picked[picked.length - 1], join(outDir, "last.png"));
const gifSize = (await Deno.stat(gifPath)).size;
steps.gif = {
  path: gifPath,
  bytes: gifSize,
  frames: picked.length,
  distinct: new Set(picked).size,
};
if (!flags["keep-frames"]) {
  await Deno.remove(framesDir, { recursive: true }).catch(() => {});
  await Deno.remove(listFile).catch(() => {});
}

// ── Done ─────────────────────────────────────────────────────────────────────
report.finishedAt = new Date().toISOString();
report.ok = true;
await Deno.writeTextFile(
  join(outDir, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await putDown();
console.log(`
compare ok — "${level}" OG vs MOD, ${flags.seconds}s${
  flags.god ? ", god mode" : ""
}
  og        ${urls.og}
  mod       ${urls.mod}
  gif       ${gifPath}  (${
  (gifSize / 1048576).toFixed(1)
} MB, ${picked.length} frames @ ${flags.fps} fps, ${
  new Set(picked).size
} distinct)
  frames    first.png, last.png${
  flags["keep-frames"] ? `, ${frames.length} raw in frames/` : ""
}
  report    ${join(outDir, "report.json")}
`);
