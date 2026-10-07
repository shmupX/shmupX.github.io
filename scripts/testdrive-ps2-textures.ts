#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:ps2:textures "<level>"` — the same level in the same
 * version side by side, drawn with the textures its PS2 disc gets at the
 * export's default sheet budget on the left and at the sharpest budget that
 * still fits the console's VRAM on the right, recorded as one GIF.
 *
 * The export repacks the editor's 2048px sheets into small power-of-two
 * atlases (README: "Everything else in the export is data"): 512 by default,
 * and the console scales every frame back up, so sprites keep their size and
 * lose texture. `--atlas-max 1024` trades VRAM for sharpness, and whether the
 * trade is worth making for a given level is a thing to look at, not to read
 * about. Play! cannot boot the disc, so the look happens in the web runtime:
 * each pane's sheets are reduced to the texel density that disc would carry
 * (scripts/lib/testdrive-textures.ts, `degrade`) and handed to that pane
 * alone: the level record, atlas included, planted as __OFFLINE_LEVEL__ by a
 * script every document runs first, and the two base sheets served through
 * DevTools request interception — both keyed on a `tex=` marker in the
 * pane's URL.
 *
 * "Within threshold" is the Graphics Synthesizer's 4 MB (--vram-mb): every
 * sheet goes up as one byte a texel and the frame buffer takes 2.19 MB first,
 * so a budget is in when its sheets fit in what is left. The disc is actually
 * staged at each budget (lib/ps2/assets.ts, the export's own code) to know
 * the sheet sizes and scales; the report carries the table. A whole disc at
 * 1024 is usually over, so the right pane is then the sharpest MIX of sheets
 * that fits — game_asset first, then the level's atlas, then the UI — which
 * the export cannot build yet (one --atlas-max for every sheet) but the GS
 * would take; the caption and the report say which sheets went up.
 *
 *   deno task testdrive:ps2:textures "2019-PS2"
 *   deno task testdrive:ps2:textures "2019-PS2" -- --version mod --headed
 *   deno task testdrive:ps2:textures -- --help
 *
 * Output: build/testdrive/ps2-textures/<slug>/ holding compare.gif, first.png,
 * last.png and report.json. Needs a Chromium (or the Chrome Flatpak), ffmpeg,
 * and the network for the level.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { stageAssets } from "../packages/shmup-harbor/lib/ps2/assets.ts";
import {
  decodeDataUrl,
  decodePng,
  encodePng,
  type Raster,
} from "../packages/shmup-harbor/lib/ps2/png.ts";
import {
  DEFAULT_FPS,
  DEFAULT_MAX_MB,
  DEFAULT_SECONDS,
  GAME_PATH,
  harnessHtml,
  harnessSize,
  slugOf,
} from "./lib/testdrive-compare.ts";
import { gifLine, hasCommand, Rig, writeGif } from "./lib/testdrive-rig.ts";
import {
  type Budget,
  budgetOf,
  cloudLevelUrl,
  DEFAULT_SHEET,
  degrade,
  GS_VRAM_BYTES,
  offlineInjector,
  paneLabel,
  paneOfRequest,
  paneUrl,
  pickPair,
  pngSize,
  type Sheet,
  SHEET_BUDGETS,
  sheetScales,
} from "./lib/testdrive-textures.ts";

const ROOT = repoRoot();
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");
const DEFAULT_CDP_PORT = 9335;
const DEFAULT_SERVE_PORT = 5199;

const HELP = `deno task testdrive:ps2:textures "<level name>" [-- flags]

Plays the cloud level twice in the same version, side by side: on the left
with the textures its PS2 disc gets at the default ${DEFAULT_SHEET} sheet, on the right
at the sharpest sheet that still fits the console's 4 MB of VRAM. Records the
first seconds of the stage as one GIF in build/testdrive/ps2-textures/<slug>/.

  <level>            a cloud level's name, e.g. "2019-PS2"
  --version og|mod   the version both panes play (default: og)
  --baseline <px>    the left pane's sheet budget (default: ${DEFAULT_SHEET}, the export's)
  --vram-mb <n>      the threshold the sheets and the frame buffer must fit (default: 4, the GS)
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
  --out <dir>        output directory (default: build/testdrive/ps2-textures/<slug>)
  --boot-wait <s>    how long each pane may take to reach the stage (default: 120)
  --keep-frames      leave the raw screencast frames beside the GIF
  --help`;

type Flags = {
  _: (string | number)[];
  version: string;
  baseline: number;
  "vram-mb": number;
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

const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["god", "headed", "keep-frames", "help"],
  string: ["origin", "chrome", "out", "version"],
  default: {
    version: "og",
    baseline: DEFAULT_SHEET,
    "vram-mb": 4,
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

const log = (line: string) => console.log(`[textures] ${line}`);
let rig: Rig | null = null;
async function fail(msg: string): Promise<never> {
  console.error(`[textures] ${msg}`);
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
const version = String(flags.version).toLowerCase();
if (version !== "og" && version !== "mod") {
  await fail(`--version must be og or mod, not "${flags.version}"`);
}
const outDir = resolve(
  ROOT,
  flags.out ?? join("build", "testdrive", "ps2-textures", slugOf(level)),
);
const framesDir = join(outDir, "frames");
await ensureDir(outDir);
for (const stale of ["compare.gif", "first.png", "last.png", "report.json"]) {
  await Deno.remove(join(outDir, stale)).catch(() => {});
}
await Deno.remove(framesDir, { recursive: true }).catch(() => {});

const report: Record<string, unknown> = {
  level,
  version,
  seconds: flags.seconds,
  fps: flags.fps,
  maxMb: flags["max-mb"],
  stage: flags.stage,
  god: flags.god,
  vramMb: flags["vram-mb"],
  startedAt: new Date().toISOString(),
  steps: {} as Record<string, unknown>,
};
const steps = report.steps as Record<string, unknown>;
const vram = flags["vram-mb"] > 0 ? flags["vram-mb"] * 1048576 : GS_VRAM_BYTES;

if (!await hasCommand("ffmpeg", ["-version"])) {
  await fail("ffmpeg is needed to write the GIF and is not on the PATH");
}

// ── The level, as the runtime would fetch it ─────────────────────────────────
log(`fetching "${level}" from the level database…`);
const levelUrl = cloudLevelUrl(level);
const record = await fetch(levelUrl).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${levelUrl}`);
  return r.json() as Promise<Record<string, unknown> | null>;
}).catch((e) => fail(`could not fetch the level: ${e.message}`));
if (!record) await fail(`there is no cloud level named "${level}"`);
const recordJson = JSON.stringify(record);
log(
  `level: ${(recordJson.length / 1048576).toFixed(2)} MB${
    record!.atlasImageDataURL ? ", custom atlas" : ", base sprites only"
  }`,
);

// ── Every budget, staged as the export would stage it ────────────────────────
const budgets: Budget[] = [];
for (const maxSheet of new Set([flags.baseline, ...SHEET_BUDGETS])) {
  const staged = await stageAssets({
    gameDir: GAME_DIR,
    record: record!,
    maxSheet,
  }).catch((e) => fail(`staging the disc at ${maxSheet} failed: ${e.message}`));
  const sheets: Sheet[] = staged.files
    .filter((f) => f.path.startsWith("assets/") && f.path.endsWith(".png"))
    .map((f) => ({
      name: f.path.slice("assets/".length, -".png".length),
      ...pngSize(f.data),
    }));
  const b = budgetOf(maxSheet, sheets, sheetScales(staged.notes), vram);
  budgets.push(b);
  log(
    `${maxSheet}: ${
      sheets.map((s) => `${s.name} ${s.w}x${s.h}`).join(", ")
    } → ${(b.vramBytes / 1048576).toFixed(2)} MB of ${flags["vram-mb"]} ${
      b.fits ? "(fits)" : "(OVER)"
    }; scales ${JSON.stringify(b.scales)}`,
  );
}
budgets.sort((a, b) => a.maxSheet! - b.maxSheet!);
const pair = pickPair(budgets, flags.baseline, vram);
if (pair.sharp && pair.sharp.label === "mixed") {
  budgets.push(pair.sharp);
  log(
    `no whole disc above ${flags.baseline} fits; the sharpest mix that does: ${
      pair.sharp.sheets.map((s) => `${s.name} ${s.w}x${s.h}`).join(", ")
    } → ${(pair.sharp.vramBytes / 1048576).toFixed(2)} MB; scales ${
      JSON.stringify(pair.sharp.scales)
    } (a per-sheet --atlas-max would build this)`,
  );
}
report.budgets = budgets.map((b) => ({ ...b }));
if (!pair.sharp) {
  report.finishedAt = new Date().toISOString();
  report.ok = true;
  report.sharper = null;
  await Deno.writeTextFile(
    join(outDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `\ntextures: the ${flags.baseline} sheet is already the sharpest that fits ${
      flags["vram-mb"]
    } MB for "${level}" — not one sheet can go up; nothing sharper to show.\n  report    ${
      join(outDir, "report.json")
    }\n`,
  );
  Deno.exit(0);
}
const { base, sharp } = pair;
const same = Object.keys(base.scales).every((k) =>
  base.scales[k] === sharp.scales[k]
);
if (same) {
  log(
    `note: every sheet packs at the same scale at ${base.label} and ${sharp.label}; the panes will look alike`,
  );
}
log(`comparing ${base.label} (left) against ${sharp.label} (right)`);

// ── Each pane's sheets, at its disc's texel density ──────────────────────────
// The runtime loads game_asset and game_ui from assets/img and the level's
// own atlas out of the record; those three carry every sprite the stage
// draws. Each is reduced by the scale that budget packed it at.
type Fed = {
  record: string; // the level, JSON, its atlas degraded
  sheets: Record<string, Uint8Array>; // "game_asset" | "game_ui" → PNG bytes
};
const baseSheets: Record<string, Raster> = {};
for (const name of ["game_asset", "game_ui"]) {
  baseSheets[name] = await decodePng(
    await Deno.readFile(join(GAME_DIR, "assets", "img", `${name}.png`)),
  );
}
const customAtlas = record!.atlasImageDataURL
  ? await decodeDataUrl(String(record!.atlasImageDataURL))
  : null;
const toDataUrl = (png: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < png.length; i += 0x8000) {
    bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return "data:image/png;base64," + btoa(bin);
};
async function feed(b: Budget): Promise<Fed> {
  const sheets: Record<string, Uint8Array> = {};
  for (const name of ["game_asset", "game_ui"]) {
    const scale = b.scales[name] ?? 1;
    sheets[name] = await encodePng(degrade(baseSheets[name], scale));
    log(`  ${b.label}/${name}: 1/${scale}`);
  }
  const rec = { ...record! };
  if (customAtlas) {
    const scale = b.scales.level_atlas ?? 1;
    rec.atlasImageDataURL = toDataUrl(
      await encodePng(degrade(customAtlas, scale)),
    );
    log(`  ${b.label}/level atlas: 1/${scale}`);
  }
  return { record: JSON.stringify(rec), sheets };
}
log(`reducing the sheets…`);
const fed = new Map<string, Fed>();
fed.set("base", await feed(base));
fed.set("sharp", await feed(sharp));

// ── The browser, with the panes' requests answered here ──────────────────────
const size = harnessSize(2);
try {
  rig = await Rig.start({
    origin: flags.origin,
    servePort: flags["serve-port"],
    cdpPort: flags["cdp-port"],
    chrome: flags.chrome,
    headed: flags.headed,
    viewport: size,
    profileName: "textures",
    log,
  });
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
report.origin = rig!.origin;
report.browser = rig!.browser;
const cdp = rig!.cdp;

// Both armed before the harness is seated, since the bundle takes its level
// and asks for its sheets as it boots. The record goes in by script: every
// new document runs offlineInjector first and, if its URL names a pane,
// finds that pane's record as __OFFLINE_LEVEL__, which the runtime's loader
// answers with before it looks at the level's name. The sheets go in by
// interception: a request is matched to its pane by the marker in its
// document's URL (the Referer, else the frame tree) and answered with that
// pane's bytes; anything else goes to the server untouched.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: offlineInjector(
    Object.fromEntries([...fed].map(([pane, f]) => [pane, f.record])),
  ),
});
const b64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};
const served: Record<string, number> = {};
const unmatched: string[] = [];
async function frameUrl(frameId: string): Promise<string | undefined> {
  type Node = { frame: { id: string; url: string }; childFrames?: Node[] };
  const { frameTree } = await cdp.send<{ frameTree: Node }>(
    "Page.getFrameTree",
  );
  const walk = (n: Node): string | undefined =>
    n.frame.id === frameId
      ? n.frame.url
      : n.childFrames?.map(walk).find(Boolean);
  return walk(frameTree);
}
cdp.on("Fetch.requestPaused", (p) => {
  const requestId = p.requestId as string;
  const request = p.request as { url: string; headers: Record<string, string> };
  const url = new URL(request.url);
  (async () => {
    const pane = paneOfRequest(
      request.headers,
      await frameUrl(p.frameId as string),
    );
    const f = pane === null ? undefined : fed.get(pane);
    let body: Uint8Array | null = null;
    const type = "image/png";
    if (f) {
      const m = /\/assets\/img\/(game_asset|game_ui)\.png$/.exec(url.pathname);
      if (m) body = f.sheets[m[1]];
    }
    if (!body) {
      unmatched.push(`${pane ?? "?"} ${url.pathname}`);
      await cdp.send("Fetch.continueRequest", { requestId });
      return;
    }
    const key = `${pane}:${url.pathname.split("/").pop()}`;
    served[key] = (served[key] ?? 0) + 1;
    await cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: type },
        { name: "cache-control", value: "no-store" },
      ],
      body: b64(body),
    });
  })().catch((e) => {
    log(`could not answer ${url.pathname}: ${e.message}`);
    cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
});
await cdp.send("Fetch.enable", {
  patterns: [
    { urlPattern: "*/assets/img/game_asset.png*", requestStage: "Request" },
    { urlPattern: "*/assets/img/game_ui.png*", requestStage: "Request" },
  ],
});

// ── The harness ──────────────────────────────────────────────────────────────
const panes = [
  { id: "base", budget: base },
  { id: "sharp", budget: sharp },
];
const urls = Object.fromEntries(panes.map((p) => [
  p.id,
  paneUrl(rig!.origin, GAME_PATH, {
    level,
    version,
    stage: flags.stage,
    god: flags.god,
    pane: p.id,
  }),
]));
report.urls = urls;
log(`seating ${base.label} and ${sharp.label} side by side…`);
await rig!.seat(harnessHtml(
  panes.map((p) => ({ id: p.id, label: paneLabel(p.budget), url: urls[p.id] })),
  `${level} — ${version.toUpperCase()} textures at ${base.label} vs ${sharp.label}`,
));
const ids = panes.map((p) => p.id);
const bootT0 = Date.now();
const states = await rig!.bootPanes(ids, {
  timeoutMs: flags["boot-wait"] * 1000,
  log,
}).catch((e) => fail(e.message));
for (const p of panes) {
  const s = states[p.id];
  if (flags.god && s.god !== true) {
    await fail(`${p.id} is not in god mode (godFlg ${s.god}); ${s.href}`);
  }
  if (s.version !== version) {
    await fail(`${p.id} pane is playing version ${s.version}`);
  }
  // Each pane must have been handed ITS level and ITS sheets; a pane that
  // fetched the level itself, or the stock sheets, would be comparing
  // nothing.
  const planted = await cdp.eval<string | null>(
    `(function () { var w = document.getElementById(${
      JSON.stringify(p.id)
    }).contentWindow; return w.__OFFLINE_LEVEL__ ? (w.__OFFLINE_LEVEL__.__tex || "unmarked") : null; })()`,
  );
  if (planted !== p.id) {
    await fail(
      `${p.id} (${p.budget.label}) is not playing its planted level (__OFFLINE_LEVEL__ ${
        JSON.stringify(planted)
      })`,
    );
  }
  for (const file of ["game_asset.png", "game_ui.png"]) {
    if (!served[`${p.id}:${file}`]) {
      await fail(
        `${p.id} (${p.budget.label}) was never served ${file}; served ${
          JSON.stringify(served)
        }, passed through ${JSON.stringify(unmatched)}`,
      );
    }
  }
}
steps.boot = { ...states, served, waitedMs: Date.now() - bootT0 };

// ── Record, then the GIF ─────────────────────────────────────────────────────
log(`recording ${flags.seconds}s…`);
const rec = await rig!.record(ids, {
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
report.sharper = {
  label: sharp.label,
  scales: sharp.scales,
  sheets: sharp.sheets,
  vramBytes: sharp.vramBytes,
};
report.finishedAt = new Date().toISOString();
report.ok = true;
await Deno.writeTextFile(
  join(outDir, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await rig!.close();
const mb = (n: number) => (n / 1048576).toFixed(2);
console.log(`
textures ok — "${level}" ${version.toUpperCase()}, ${base.label} vs ${sharp.label} sheets, ${flags.seconds}s${
  flags.god ? ", god mode" : ""
}
${
  budgets.map((b) =>
    `  ${b.label.padEnd(9)} ${mb(b.vramBytes)} MB of ${flags["vram-mb"]} ${
      b.fits ? "fits" : "OVER"
    }  ${Object.entries(b.scales).map(([k, v]) => `${k} 1/${v}`).join(", ")}`
  ).join("\n")
}
  left      ${urls.base}
  right     ${urls.sharp}
  gif       ${gifLine(gif)}
  frames    first.png, last.png${
  flags["keep-frames"] ? `, ${rec.frames.length} raw in frames/` : ""
}
  report    ${join(outDir, "report.json")}
`);
