#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:ps2:compare "<level>"` — play a level's OG and MOD
 * versions side by side, ship invincible on both, and record the opening
 * seconds of the stage as one GIF small enough to post.
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
 * How it runs (scripts/lib/testdrive-rig.ts): a vite dev server on this
 * checkout (or --origin for one that is already up), a headless Chrome on a
 * page of two same-origin iframes — one per version, each the game's own
 * 256×480 — both booted straight into the stage with ?stage=, each frozen the
 * moment its stage begins and both woken on the same tick, an autopilot
 * swaying both ships through the same moves, and Page.startScreencast over
 * the whole page for the window. The screencast's uneven frames are resampled
 * onto a steady clock and ffmpeg writes the GIF. Ten seconds at 6 fps by
 * default, which is under 5 MB on this stage; a GIF that comes out over
 * --max-mb is re-encoded down the frame-rate ladder until it fits
 * (scripts/lib/testdrive-compare.ts says why those numbers). --headed opens a
 * visible Chrome so the run can be watched as it happens.
 *
 *   deno task testdrive:ps2:compare "2019-PS2"
 *   deno task testdrive:ps2:compare "2019-PS2" -- --headed
 *   deno task testdrive:ps2:compare "2019-PS2" -- --seconds 25 --fps 12 --max-mb 0
 *   deno task testdrive:ps2:compare "2019-PS2" -- --origin http://127.0.0.1:5173
 *   deno task testdrive:ps2:compare -- --help
 *
 * Output: build/testdrive/ps2-compare/<slug>/ holding compare.gif, first.png
 * and last.png (the first and last frames in the GIF) and report.json.
 *
 * Needs a Chromium (--chrome, $CHROME_BIN, the usual installs, or Google
 * Chrome from Flathub — the rig runs the Flatpak, since that is what this
 * Linux box has) and ffmpeg for the GIF. The level is read from the shared
 * level database, so it needs the network.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  compareUrls,
  DEFAULT_FPS,
  DEFAULT_MAX_MB,
  DEFAULT_SECONDS,
  harnessHtml,
  harnessSize,
  type Side,
  slugOf,
} from "./lib/testdrive-compare.ts";
import { gifLine, hasCommand, Rig, writeGif } from "./lib/testdrive-rig.ts";

const ROOT = repoRoot();
const DEFAULT_CDP_PORT = 9334;
const DEFAULT_SERVE_PORT = 5199;

const HELP = `deno task testdrive:ps2:compare "<level name>" [-- flags]

Plays the cloud level's OG and MOD versions side by side in a headless Chrome,
god mode on, and records the first seconds of the stage as one GIF in
build/testdrive/ps2-compare/<slug>/.

  <level>            a cloud level's name, e.g. "2019-PS2"
  --seconds <s>      how long to record (default: ${DEFAULT_SECONDS})
  --fps <n>          the GIF's frame rate (default: ${DEFAULT_FPS})
  --max-mb <n>       re-encode at a lower rate until the GIF is under this (default: ${DEFAULT_MAX_MB}; 0 for no limit)
  --stage <n>        the stage to boot into (default: 0, the first)
  --no-god           play mortal
  --origin <url>     a dev server already running (default: start vite here)
  --serve-port <n>   the port to start vite on (default: ${DEFAULT_SERVE_PORT})
  --cdp-port <n>     the DevTools port (default: ${DEFAULT_CDP_PORT})
  --chrome <path>    the browser to drive (default: $CHROME_BIN, then the usual installs, then Flatpak Chrome)
  --headed           drive a visible Chrome instead of a headless one, to watch the run
  --out <dir>        output directory (default: build/testdrive/ps2-compare/<slug>)
  --boot-wait <s>    how long each pane may take to reach the stage (default: 120)
  --keep-frames      leave the raw screencast frames beside the GIF
  --help`;

type Flags = {
  _: (string | number)[];
  seconds: number;
  fps: number;
  "max-mb": number;
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
    seconds: DEFAULT_SECONDS,
    fps: DEFAULT_FPS,
    "max-mb": DEFAULT_MAX_MB,
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
let rig: Rig | null = null;
async function fail(msg: string): Promise<never> {
  console.error(`[compare] ${msg}`);
  await rig?.close();
  Deno.exit(1);
}
Deno.addSignalListener("SIGINT", () => {
  (rig?.close() ?? Promise.resolve()).then(() => Deno.exit(130));
});

if (flags.help || flags._.length === 0) {
  console.log(HELP);
  Deno.exit(flags.help ? 0 : 2);
}
const level = String(flags._[0]);
const outDir = resolve(
  ROOT,
  flags.out ?? join("build", "testdrive", "ps2-compare", slugOf(level)),
);
const framesDir = join(outDir, "frames");
await ensureDir(outDir);
for (const stale of ["compare.gif", "first.png", "last.png", "report.json"]) {
  await Deno.remove(join(outDir, stale)).catch(() => {});
}
await Deno.remove(framesDir, { recursive: true }).catch(() => {});

const report: Record<string, unknown> = {
  level,
  seconds: flags.seconds,
  fps: flags.fps,
  maxMb: flags["max-mb"],
  stage: flags.stage,
  god: flags.god,
  startedAt: new Date().toISOString(),
  steps: {} as Record<string, unknown>,
};
const steps = report.steps as Record<string, unknown>;

// ffmpeg first: a capture with no encoder is a wasted wait.
if (!await hasCommand("ffmpeg", ["-version"])) {
  await fail("ffmpeg is needed to write the GIF and is not on the PATH");
}

const size = harnessSize(2);
try {
  rig = await Rig.start({
    origin: flags.origin,
    servePort: flags["serve-port"],
    cdpPort: flags["cdp-port"],
    chrome: flags.chrome,
    headed: flags.headed,
    viewport: size,
    profileName: "compare",
    log,
  });
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
report.origin = rig!.origin;
report.browser = rig!.browser;
const urls = compareUrls(rig!.origin, level, {
  stage: flags.stage,
  god: flags.god,
});
report.urls = urls;

// ── The harness: two panes, both booting ─────────────────────────────────────
log(`seating OG and MOD side by side…`);
const sides: Side[] = ["og", "mod"];
await rig!.seat(harnessHtml(
  sides.map((s) => ({ id: s, label: s.toUpperCase(), url: urls[s] })),
  `${level} — OG vs MOD`,
));
const bootT0 = Date.now();
const states = await rig!.bootPanes(sides, {
  timeoutMs: flags["boot-wait"] * 1000,
  log,
}).catch((e) => fail(e.message));
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

// ── Record, then the GIF ─────────────────────────────────────────────────────
log(`recording ${flags.seconds}s…`);
const rec = await rig!.record(sides, {
  seconds: flags.seconds,
  framesDir,
  viewport: size,
  log,
}).catch((e) => fail(e.message));
steps.record = { frames: rec.frames.length, after: rec.after };
const gif = await writeGif(rec.frames, {
  outDir,
  fps: flags.fps,
  seconds: flags.seconds,
  maxMb: flags["max-mb"],
  from: rec.t0,
  log,
}).catch((e) => fail(e.message));
await Deno.copyFile(gif.first, join(outDir, "first.png"));
await Deno.copyFile(gif.last, join(outDir, "last.png"));
steps.gif = gif;
if (!flags["keep-frames"]) {
  await Deno.remove(framesDir, { recursive: true }).catch(() => {});
}

// ── Done ─────────────────────────────────────────────────────────────────────
report.finishedAt = new Date().toISOString();
report.ok = true;
await Deno.writeTextFile(
  join(outDir, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await rig!.close();
console.log(`
compare ok — "${level}" OG vs MOD, ${flags.seconds}s${
  flags.god ? ", god mode" : ""
}
  og        ${urls.og}
  mod       ${urls.mod}
  gif       ${gifLine(gif)}
  frames    first.png, last.png${
  flags["keep-frames"] ? `, ${rec.frames.length} raw in frames/` : ""
}
  report    ${join(outDir, "report.json")}
`);
