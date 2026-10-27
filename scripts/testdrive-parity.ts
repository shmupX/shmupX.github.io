#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:parity "<level>"` — play one level on every target this
 * repo exports to, a tool-assisted pilot actually fighting its boss on each,
 * and lay the seven recordings side by side in one GIF.
 *
 * The seven: the web runtime (2028.Ai), the PS2 build in the browser, and the
 * five originals the console exporters write for — Super Famicom Dezaemon,
 * Saturn Dezaemon 2, PlayStation Dezaemon Kids! and Dezaemon+, and the
 * Nintendo 64 Dezaemon 3D's 64DD disk — each in its emulator page.
 *
 * What is recorded is one boss: stage `--stage` (gs's second, Daltonius, by
 * default) from the moment its HP falls to `--from-hp` of its bar, through its
 * second stage (Daltonius into Liu Kang's dragon) until every projectile kind
 * it fires has been on screen, plus a short tail. Every target plays the same
 * game: the level cut down by lib/boss-rush.ts — its bosses from that stage on,
 * each stage opening on one showcase row of every enemy type the level has,
 * carrying its item drops — so nothing between the start and the boss is
 * left to chance or to a long wait. The web runtime is given that same record
 * in place of its own foo.json rather than its `?bossRush=1`, which would
 * empty the showcase row too.
 *
 * How it runs: one vite (or --origin) and one Chrome with a DevTools port,
 * the panes ONE AT A TIME — seven WebAssembly emulators and software WebGL in
 * one compositor would drop frames on any laptop — each screencast at its
 * own size, its window cut out by wall-clock time, resampled to a steady rate
 * and kept as an mp4 at full rate beside the pad log of the run
 * (panes/<id>.mp4, panes/<id>.inputs.json): the attract mode's sources. Then
 * the clips are stacked four to a row, each held on its last frame until the
 * longest ends, captioned, and written as grid.mp4 and parity.gif — the GIF
 * re-encoded at lower rates, then smaller, until it fits --max-mb (5 MB, a
 * README's and a download page's budget, unless told otherwise).
 *
 * A target that cannot run here (a fixture missing, a pane whose boot this
 * tool does not know yet) is said why in report.json, rather than failing the
 * run, and left out of the grid: it shows only the panes that have a clip.
 *
 * `--sav FILE` plays a Dezaemon 2 cart instead of a cloud level: the level is
 * the cart's fresh import (lib/shelf.ts levelRecordFromCart, the same code the
 * PS2 and desktop builds use), never a cloud record of the same name. With
 * `--full` the boss rush is off and every pane plays the game's FIRST STAGE
 * from its start — the console panes as they always have, the web pane under
 * god mode for `--console-seconds` — and the Saturn pane plays the ORIGINAL
 * cart, put on the disc as it is (disc:inject --sav), while every other target
 * plays the import written back out by its exporter. That is the parity
 * survey: the Saturn and web panes sample every object on screen as they
 * play (lib/parity-survey.ts — enemies by placement id, every bullet with
 * what it is drawn with and what fired it, the scroll position they came on
 * at) into panes/<id>.survey.json, so the two sides can be compared object by
 * object, not clip by clip. Without `--full`, a `--sav` run is the usual boss
 * rush, built from the import on every target, the Saturn included.
 *
 *   deno task testdrive:parity gs
 *   deno task testdrive:parity gs -- --targets web,sfc --headed
 *   deno task testdrive:parity gs -- --from-hp 0.6 --max-mb 0
 *   deno task testdrive:parity -- --sav "dev-fixtures/Saturn/Dez 2 - Ramsie.sav" --full --targets saturn,web
 *   deno task testdrive:parity -- --help
 *
 * Output: build/testdrive/parity/<slug>/ — parity.gif, grid.mp4, panes/,
 * report.json.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  bossRushRecord,
  describeBossRush,
} from "../packages/shmup-harbor/lib/boss-rush.ts";
import {
  buildPs2,
  fetchLevelRecord,
} from "../packages/shmup-harbor/lib/ps2/build.ts";
import { writeWebBuild } from "../packages/shmup-harbor/lib/ps2/web-build.ts";
import { PROBE } from "./lib/game-debug.ts";
import {
  BOT_STATUS,
  type BotConfig,
  type BotStatus,
  ps2Bot,
  webBot,
} from "./lib/parity-bot.ts";
import {
  clipArgs,
  clipFrames,
  clipStart,
  concatList,
  encodeInputs,
  type Frame,
  gifLadder,
  gridArgs,
  gridGifArgs,
  type GridInput,
  PANE_IDS,
  type PaneId,
  PANES,
  parseTargets,
  projectileKinds,
} from "./lib/parity.ts";
import {
  Abort,
  hasCommand,
  type Log,
  Rig,
  sleep,
  until,
} from "./lib/testdrive-rig.ts";
import type { Cdp } from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import {
  EMU_STATUS,
  emuPilot,
  type EmuPilotConfig,
  type EmuStatus,
  keptFrames,
  locateExpr,
} from "./lib/parity-emu.ts";
import { buildSfc } from "../packages/shmup-harbor/scripts/build-sfc.ts";
import {
  findSaturnDisc,
  injectDisc,
} from "../packages/shmup-harbor/scripts/inject-disc.ts";
import {
  DIALOG_YES,
  PLAY_U,
  SATURN,
  SATURN_RAM,
  saturnPage,
} from "./lib/parity-saturn.ts";
import {
  buildDdd,
  findDonorDisk,
} from "../packages/shmup-harbor/scripts/build-ddd.ts";
import {
  findDezaemonN64,
  readDezaemonN64Rom,
  readN64ddIpl,
} from "../lib/dezaemon-n64.ts";
import {
  listRow,
  N64DD,
  N64DD_BARE,
  n64ddRam,
  rdramNeedle,
} from "./lib/parity-n64dd.ts";
import { buildKids } from "../packages/shmup-harbor/scripts/build-kids.ts";
import { buildPlus } from "../packages/shmup-harbor/scripts/build-plus.ts";
import {
  findPsxDisc,
  type PsxDisc,
  psxDiscZipLength,
  psxDiscZipStream,
} from "../lib/dezaemon-psx.ts";
import { KIDS, KIDS_AT, PLUS, PSX_RAM, psxPage } from "./lib/parity-psx.ts";
import { levelRecordFromCart } from "../packages/shmup-harbor/lib/shelf.ts";
import {
  PS2_SURVEY_DUMP,
  ps2Survey,
  type SaturnBirth,
  type SaturnSample,
  saturnSurvey,
  SURVEY_DUMP,
  type SurveyDump,
  surveySummary,
  type WebBirth,
  type WebSample,
  webSurvey,
} from "./lib/parity-survey.ts";
import {
  type RushRecord,
  type SaturnSurveyFile,
  surveyReport,
  WEB_GATE_LEAD,
  type WebSurveyFile,
} from "./lib/parity-report.ts";

const ROOT = repoRoot();

const HELP = `deno task testdrive:parity "<level>" [-- flags]

Plays the level's boss on every target side by side, a tool-assisted pilot
fighting it, and records the boss from --from-hp of its bar through its second
stage into build/testdrive/parity/<slug>/ (parity.gif, grid.mp4, panes/,
report.json).

  <level>            a cloud level's name (default: gs)
  --sav <file>       play this Dezaemon 2 cart's fresh import instead (its
                     first game; --slot <1-5> picks another)
  --full             no boss rush: every pane plays the first stage from its
                     start, the Saturn pane the ORIGINAL cart (--sav only),
                     and the Saturn and web panes keep a per-object survey
                     (panes/<id>.survey.json); with both surveys the run
                     writes report-survey.md and exits 1 on its FAIL
  --saturn-export    with --sav --full: the Saturn plays the import written
                     back out (build:sav) rather than the cart itself
  --targets <list>   web,ps2,sfc,saturn,kids,plus,n64dd, all (default), or
                     none — with --reuse, only the grid and the GIF again
  --stage <n>        the stage whose boss is recorded, 0-based (default: 1;
                     with --full the web pane's stage, default 0)
  --from-hp <f>      open the window when the boss is down to this share (default: 0.55)
  --tail <s>         seconds kept after the last new projectile (default: 2)
  --max-window <s>   the longest a window may run (default: 60)
  --console-seconds <s>  the emulated originals' clip: the stage's first this many
                     seconds of surviving play (default: 40)
  --console-wall <s> the longest a console pane may take to survive that (default: 900)
  --attempts <n>     runs a pane may take to get its window (default: 3)
  --fps <n>          the clips' frame rate (default: 30)
  --gif-fps <n>      the GIF's frame rate before the budget ladder (default: 15)
  --max-mb <n>       the GIF's budget; 0 for none (default: 5)
  --origin <url>     a dev server already up (default: start vite here)
  --serve-port <n>   the port vite is started on (default: 5198)
  --cdp-port <n>     the DevTools port (default: 9336)
  --chrome <path>    the browser to drive
  --headed           a visible Chrome, to watch
  --out <dir>        output directory
  --keep-frames      keep the raw screencast frames
  --reuse <list>     panes NOT run this time that keep their earlier capture
                     in the grid (from report.json), or all
  --survey-report <dir>
                     no run: write report-survey.md for an earlier --full run's
                     out dir (its panes/*.survey.json and rush.json) and exit
                     0 on PASS, 1 on FAIL, 2 when a file is missing
  --survey-lead <px> the web's expected gate lead the report takes out before
                     judging a record's first-seen scroll (default ${WEB_GATE_LEAD};
                     a negative lead as --survey-lead=-N)
  --help`;

const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["headed", "keep-frames", "help", "full", "saturn-export"],
  string: [
    "targets",
    "origin",
    "chrome",
    "out",
    "reuse",
    "sav",
    "survey-report",
    "survey-lead",
  ],
  default: {
    "from-hp": 0.55,
    tail: 2,
    "max-window": 60,
    "console-seconds": 40,
    "console-wall": 900,
    attempts: 3,
    fps: 30,
    "gif-fps": 15,
    "max-mb": 5,
    "serve-port": 5198,
    "cdp-port": 9336,
    headed: false,
    "keep-frames": false,
    help: false,
    full: false,
  },
});

if (flags.help) {
  console.log(HELP);
  Deno.exit(0);
}

const log: Log = (line) => console.log(line);
/** The cart a --sav run plays, resolved; null for a cloud level. */
const SAV = flags.sav ? resolve(String(flags.sav)) : null;
const SAV_SLOT = flags.slot != null ? Number(flags.slot) : null;
/** No boss rush: the first stage from its start, surveyed. */
const FULL = !!flags.full;
if (FULL && !SAV && flags._[0] == null) {
  // A full run of a cloud level is allowed, but the default gs is a boss
  // showcase; say so rather than guess (not for a report-only run).
  if (flags["survey-report"] === undefined) {
    log("--full plays the level from its first stage; using gs");
  }
}
if (SAV && flags._[0] != null) {
  console.error("error: a level name or --sav, not both");
  Deno.exit(2);
}
/** A cart is named after its file, as disc:inject names it (cartGameName). */
const cartName = (path: string) =>
  path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/^Dez 2 - /, "")
    .replace(/^Dezaemon 2 \((.*)\)$/, "$1").trim() || "cart";
const LEVEL = SAV ? cartName(SAV) : String(flags._[0] ?? "gs");
const slug = (LEVEL.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
  /^-|-$/g,
  "",
) || "level") + (SAV ? "-sav" : "") + (FULL ? "-full" : "");
const OUT = resolve(
  flags.out ?? join(ROOT, "build", "testdrive", "parity", slug),
);
const STAGE = flags.stage != null ? Number(flags.stage) : FULL ? 0 : 1;
const FPS = Number(flags.fps);
// The web's gate lead report-survey.md takes out before judging a record's
// first-seen scroll; an unreadable value would judge nothing (NaN compares
// false), so it is refused up front.
const SURVEY_LEAD = flags["survey-lead"] == null
  ? WEB_GATE_LEAD
  : Number(String(flags["survey-lead"]).trim() || "NaN");
if (!Number.isFinite(SURVEY_LEAD)) {
  console.error(
    `error: --survey-lead must be a number of px, got ${
      JSON.stringify(flags["survey-lead"])
    }`,
  );
  Deno.exit(2);
}

// deno-lint-ignore no-explicit-any
type Json = any;

interface PaneResult {
  id: PaneId;
  status: "captured" | "blocked" | "failed";
  reason?: string;
  clip?: string;
  inputs?: string;
  seconds?: number;
  attempts?: number;
  /** What the pane's own telemetry saw, where it can be read. */
  telemetry?: Record<string, unknown>;
  /** The flags a viewer should know about: TURBO, GOD. */
  modes?: string[];
}

// ── The level ────────────────────────────────────────────────────────────────

async function loadRecord(): Promise<Json> {
  if (SAV) {
    // The cart's fresh import — never a cloud record that happens to share
    // its name: what the Saturn plays and what the web plays must come from
    // the same bytes.
    const bytes = await Deno.readFile(SAV);
    log(`cart: ${SAV} (${(bytes.length / 1024).toFixed(0)} KB)`);
    const { record, name, notes } = await levelRecordFromCart(bytes, {
      slot: SAV_SLOT,
      name: LEVEL,
      log,
    });
    for (const n of notes) log(`  ${n}`);
    log(`  imported as "${name}"`);
    return record;
  }
  const cacheDir = join(ROOT, "build", "ps2", ".cache");
  const record = await fetchLevelRecord(LEVEL, cacheDir, log);
  if (!record) throw new Error(`level "${LEVEL}" not found`);
  return record;
}

// ── Browser plumbing ─────────────────────────────────────────────────────────

async function setViewport(cdp: Cdp, width: number, height: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/**
 * Serve files to the page from here: every request whose PATH ends with one
 * of the keys is answered with its body, everything else goes to the network.
 * The path, not the URL: a player page names its file in its own query string
 * (`/snes/play.html?rom=/__parity/…`), and must not be answered with it.
 * Armed before the page navigates; stop() disarms it.
 */
async function interceptFiles(
  cdp: Cdp,
  files: Record<string, { body: Uint8Array | string; type: string }>,
): Promise<{ stop: () => Promise<void>; served: () => string[] }> {
  const served: string[] = [];
  const encoded = Object.entries(files).map(([match, f]) => {
    const bytes = typeof f.body === "string"
      ? new TextEncoder().encode(f.body)
      : f.body;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { match, type: f.type, body: btoa(bin) };
  });
  const onPaused = (params: Record<string, unknown>) => {
    const id = params.requestId as string;
    const url = ((params.request as { url?: string })?.url ?? "") as string;
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch { /* not a URL: match it whole */ }
    const hit = encoded.find((e) => path.endsWith(e.match));
    if (!hit) {
      cdp.send("Fetch.continueRequest", { requestId: id }).catch(() => {});
      return;
    }
    cdp.send("Fetch.fulfillRequest", {
      requestId: id,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: hit.type },
        { name: "cache-control", value: "no-store" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: hit.body,
    }).then(() => served.push(hit.match)).catch(() => {});
  };
  cdp.on("Fetch.requestPaused", onPaused);
  await cdp.send("Fetch.enable", {
    patterns: encoded.map((e) => ({
      urlPattern: `*${e.match}*`,
      requestStage: "Request",
    })),
  });
  return {
    served: () => served,
    stop: async () => {
      cdp.off("Fetch.requestPaused", onPaused);
      await cdp.send("Fetch.disable", {}).catch(() => {});
    },
  };
}

/** Scripts every new document runs before its own; removed when done. */
async function onNewDocument(cdp: Cdp, sources: string[]) {
  const ids: string[] = [];
  for (const source of sources) {
    const { identifier } = await cdp.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
    );
    ids.push(identifier);
  }
  return async () => {
    for (const identifier of ids) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier,
      }).catch(() => {});
    }
  };
}

/** A screencast into `dir`, every frame stamped with its wall-clock time. */
async function screencast(
  cdp: Cdp,
  dir: string,
  size: { width: number; height: number },
) {
  await ensureDir(dir);
  const frames: Frame[] = [];
  const writes: Promise<void>[] = [];
  let n = 0;
  const onFrame = (p: Record<string, unknown>) => {
    cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId as number })
      .catch(() => {});
    const meta = p.metadata as { timestamp?: number } | undefined;
    const t = (meta?.timestamp ?? Date.now() / 1000) * 1000;
    const file = join(dir, `f${String(n++).padStart(6, "0")}.png`);
    frames.push({ file, t });
    writes.push(
      Deno.writeFile(
        file,
        Uint8Array.from(atob(p.data as string), (c) => c.charCodeAt(0)),
      ).catch(() => {}),
    );
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: size.width,
    maxHeight: size.height,
    everyNthFrame: 1,
  });
  return {
    frames,
    stop: async () => {
      await cdp.send("Page.stopScreencast").catch(() => {});
      cdp.off("Page.screencastFrame", onFrame);
      await Promise.all(writes);
      return frames;
    },
  };
}

async function ffmpeg(args: string[]) {
  const out = await new Deno.Command("ffmpeg", {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`ffmpeg failed: ${new TextDecoder().decode(out.stderr)}`);
  }
}

/** Frames between two wall-clock times → panes/<id>.mp4 at FPS. */
async function writeClip(
  id: PaneId,
  frames: Frame[],
  from: number,
  to: number,
): Promise<{ clip: string; seconds: number }> {
  const panes = join(OUT, "panes");
  await ensureDir(panes);
  const picked = clipFrames(frames, from, to, FPS);
  if (!picked.length) throw new Error("no frames inside the window");
  const list = join(panes, `${id}.frames.txt`);
  await Deno.writeTextFile(list, concatList(picked, FPS));
  const clip = join(panes, `${id}.mp4`);
  await ffmpeg(clipArgs(list, FPS, clip, PANES[id].crop));
  await Deno.remove(list).catch(() => {});
  return { clip, seconds: picked.length / FPS };
}

// ── The panes ────────────────────────────────────────────────────────────────

interface PaneContext {
  rig: Rig;
  record: Json;
  rush: Json;
  kinds: Record<string, string[]>;
}

type PaneRunner = (ctx: PaneContext) => Promise<PaneResult>;

/** The shared bot settings, from the flags and the boss's projectile kinds. */
function botConfig(kinds: Record<string, string[]>): BotConfig {
  return {
    kinds,
    preMorphKinds: Object.keys(kinds).filter((k) => !k.startsWith("stage2:")),
    fromHp: Number(flags["from-hp"]),
    tailSteps: Math.round(Number(flags.tail) * 60),
    maxWindowSteps: Math.round(Number(flags["max-window"]) * 60),
    horizon: 28,
    needMorph: Object.keys(kinds).some((k) => k.startsWith("stage2:")),
  };
}

/**
 * A pane flown by the readable-state pilot (scripts/lib/parity-bot.ts): the
 * web runtime or the PS2 build. Each attempt loads `url` fresh with the PROBE
 * and the pilot installed, lets `start` bring the game into its stage, turns
 * the pilot on, screencasts from the boss's entry, and cuts the clip when the
 * pilot closes its window.
 */
interface PilotPane {
  id: PaneId;
  /** The page, per attempt. */
  url: (attempt: number) => string;
  /** The pilot's page code. */
  bot: string;
  /** Extra page code run on every new document (after the pilot). */
  extraScripts?: string[];
  /**
   * Bring the game from its loaded page into the stage, then answer the
   * modes the run plays under (TURBO, GOD) — `previous` is how the last
   * attempt ended, so a pane can change how it starts after a death.
   */
  start: (
    cdp: Cdp,
    attempt: number,
    previous: string | null,
  ) => Promise<string[]>;
}

async function runPilotPane(
  pane: PilotPane,
  ctx: PaneContext,
): Promise<PaneResult> {
  const spec = PANES[pane.id];
  const id = pane.id;
  const cdp = ctx.rig.cdp;
  const kinds = ctx.kinds;
  const preMorph = Object.keys(kinds).filter((k) => !k.startsWith("stage2:"));
  await setViewport(cdp, spec.width, spec.height);
  const unscript = await onNewDocument(cdp, [
    PROBE,
    pane.bot,
    ...(pane.extraScripts ?? []),
  ]);
  const attempts = Number(flags.attempts);
  let last: BotStatus | null = null;
  let previous: string | null = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      log(`${id}: attempt ${attempt} of ${attempts}`);
      await cdp.send("Page.navigate", { url: pane.url(attempt) });
      const modes = await pane.start(cdp, attempt, previous);
      await until(
        `the ${id} pilot to take the pad`,
        60_000,
        () => cdp.eval<boolean>(`!!(window.__bot && (window.__bot.on = true))`),
        250,
      );
      log(
        `${id}: in the stage${
          modes.length ? ` (${modes.join(", ")})` : ""
        }; pilot on`,
      );
      // The screencast starts with the boss: the clip may have to open on its
      // last pre-morph volley, which can come well before the window does.
      let cast: Awaited<ReturnType<typeof screencast>> | null = null;
      const deadline = Date.now() + 200_000;
      let lastLog = 0;
      while (Date.now() < deadline) {
        await sleep(250);
        last = await cdp.eval<BotStatus>(BOT_STATUS).catch(() => last);
        if (!last) continue;
        if (last.err) throw new Error(`pilot error: ${last.err}`);
        if (!cast && last.bossSeenStep !== null) {
          cast = await screencast(
            cdp,
            join(OUT, "frames", `${id}-${attempt}`),
            spec,
          );
        }
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          log(
            `  step ${last.step} boss ${last.hp ?? "-"}/${last.maxHp ?? "-"} ` +
              `shot ${last.shot ?? "-"} sp ${last.sp ?? "-"} ` +
              `window ${last.windowStart ?? "-"} morph ${
                last.morphStep ?? "-"
              } ` +
              `seen ${
                Object.keys(last.seen).join(",") || "-"
              } hits ${last.hits}` +
              (last.standOff ? " (standing off)" : "") + (cast ? " [rec]" : ""),
          );
        }
        if (last.windowEnd !== null || last.outcome) break;
      }
      const frames = cast ? await cast.stop() : [];
      if (
        last?.windowEnd != null && last.windowStartWall && last.windowEndWall
      ) {
        const masks = await cdp.eval<number[]>("window.__bot.masks");
        // Only a kind the window itself missed pulls the clip earlier.
        const opens = clipStart(
          last.windowStartWall,
          last.preMorph ?? {},
          preMorph.filter((k) => last!.seen[k] == null),
        );
        const hpLog = await cdp.eval<[number, number][]>("window.__bot.hpLog");
        const hpAt = hpLog.filter(([t]) => t <= opens.at).pop()?.[1] ??
          last.maxHp;
        if (opens.pulledBy.length) {
          log(
            `${id}: clip opens early for ${
              opens.pulledBy.join(", ")
            } — boss at ${Math.round((hpAt ?? 0) / (last.maxHp ?? 1) * 100)}%`,
          );
        }
        const { clip, seconds } = await writeClip(
          id,
          frames,
          opens.at,
          last.windowEndWall,
        );
        const inputs = join(OUT, "panes", `${id}.inputs.json`);
        await Deno.writeTextFile(
          inputs,
          JSON.stringify({
            pane: id,
            level: LEVEL,
            modes,
            framesPerSecond: 60,
            bits: "up 1, down 2, left 4, right 8, sp 32, start 64",
            window: { from: last.windowStart, to: last.windowEnd },
            log: encodeInputs(masks),
          }),
        );
        if (!flags["keep-frames"]) {
          await Deno.remove(join(OUT, "frames", `${id}-${attempt}`), {
            recursive: true,
          }).catch(() => {});
        }
        const missing = Object.keys(kinds).filter((k) =>
          last!.seen[k] == null &&
          !(preMorph.includes(k) && last!.preMorph?.[k])
        );
        return {
          id,
          status: "captured",
          clip,
          inputs,
          seconds,
          attempts: attempt,
          telemetry: {
            ...last,
            clipOpensAtHp: hpAt != null && last.maxHp
              ? +(hpAt / last.maxHp).toFixed(3)
              : null,
            clipPulledBy: opens.pulledBy,
            morphCaptured: last.morphWall != null && last.morphWall >= opens.at,
            missingKinds: missing,
          },
          modes,
        };
      }
      previous = last?.outcome ?? "timed out";
      log(`${id}: attempt ${attempt} ended without a window (${previous})`);
      if (!flags["keep-frames"]) {
        await Deno.remove(join(OUT, "frames", `${id}-${attempt}`), {
          recursive: true,
        }).catch(() => {});
      }
    }
    return {
      id,
      status: "failed",
      reason: `no complete window in ${attempts} attempts (last: ${previous})`,
      attempts,
      telemetry: last ? { ...last } : undefined,
    };
  } finally {
    await unscript();
  }
}

/**
 * A survey's dump, fetched as JSON text in pieces. Handed back by value, a
 * dump is first built into a protocol tree inside the renderer, and a big
 * one (the PS2 pane's, hundreds of objects a sample at TURBO) took the
 * renderer down: the page stopped answering for good and the rig waited on
 * it for hours. Stringifying in the page and reading the text in 2 MB
 * slices costs the renderer only the string; every step is time-boxed, and
 * a failure leaves the pane its clip, with no survey, instead of a hang.
 */
async function fetchSurvey<T>(
  cdp: Cdp,
  dumpCode: string,
  id: PaneId,
): Promise<T | null> {
  const PIECE = 2_000_000;
  const boxed = <V>(p: Promise<V>, ms: number, what: string): Promise<V> =>
    new Promise<V>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${what} did not answer in ${ms / 1000} s`)),
        ms,
      );
      p.then((v) => {
        clearTimeout(t);
        resolve(v);
      }, (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  try {
    const size = await boxed(
      cdp.eval<number>(
        `(function(){ var d = ${dumpCode}; window.__surveyJson = d === null ? "null" : JSON.stringify(d); return window.__surveyJson.length; })()`,
      ),
      60_000,
      `${id}: the survey dump`,
    );
    let text = "";
    for (let at = 0; at < size; at += PIECE) {
      text += await boxed(
        cdp.eval<string>(
          `window.__surveyJson.substring(${at}, ${at + PIECE})`,
        ),
        30_000,
        `${id}: survey piece at ${at}`,
      );
    }
    await cdp.eval(`delete window.__surveyJson, true`).catch(() => {});
    log(
      `  ${id}: survey ${(size / 1e6).toFixed(1)} MB in ${
        Math.max(1, Math.ceil(size / PIECE))
      } piece(s)`,
    );
    return JSON.parse(text) as T;
  } catch (e) {
    log(`  ${id}: survey lost — ${(e as Error).message}`);
    return null;
  }
}

/** The verdict report.json carries once report-survey.md is written. */
interface SurveyVerdict {
  file: string;
  ok: boolean;
  failures: string[];
  notJudged: string[];
}

/**
 * report-survey.md for an out dir that holds a Saturn and a web survey:
 * the two files set against each other by record (lib/parity-report.ts).
 * Returns null, having said why, when either survey is missing or unreadable.
 */
async function writeSurveyReport(
  dir: string,
  rush: RushRecord,
  files: { saturn: string | null; web: string | null },
): Promise<SurveyVerdict | null> {
  const read = async <T>(
    file: string | null,
    what: string,
  ): Promise<T | null> => {
    if (!file) {
      log(`survey report: no ${what} survey this run`);
      return null;
    }
    if (!await exists(file)) {
      log(`survey report: no ${what} survey at ${file}`);
      return null;
    }
    try {
      const parsed = JSON.parse(await Deno.readTextFile(file)) as T;
      const when = (await Deno.stat(file)).mtime;
      log(
        `survey report: ${what} survey ${file}${
          when
            ? ` (written ${when.toISOString().slice(0, 16).replace("T", " ")} UTC)`
            : ""
        }`,
      );
      return parsed;
    } catch (e) {
      log(`survey report: ${what} survey at ${file} is not readable JSON — ${(e as Error).message}`);
      return null;
    }
  };
  const saturn = await read<SaturnSurveyFile>(files.saturn, "Saturn");
  const web = await read<WebSurveyFile>(files.web, "web");
  if (!saturn || !web) return null;
  const report = surveyReport({ saturn, web, rush }, {
    expectedLead: SURVEY_LEAD,
  });
  const file = join(dir, "report-survey.md");
  await Deno.writeTextFile(file, report.markdown);
  log(
    `${file}: ${report.ok ? "PASS" : "FAIL"} — ${report.rows.length} records, ${report.kinds.length} bullet kinds, ${report.failures.length} finding(s)` +
      (report.notJudged.length ? `, ${report.notJudged.length} not judged` : ""),
  );
  for (const f of report.failures) log(`  FAIL ${f}`);
  return {
    file,
    ok: report.ok,
    failures: report.failures,
    notJudged: report.notJudged,
  };
}

/** --survey-report: the report alone, for a run already on disk. */
async function surveyReportOnly(dir: string): Promise<number> {
  const rushFile = join(dir, "rush.json");
  if (!await exists(rushFile)) {
    console.error(`error: no rush.json in ${dir} — is it a testdrive out dir?`);
    return 2;
  }
  let rush: RushRecord;
  try {
    rush = JSON.parse(await Deno.readTextFile(rushFile)) as RushRecord;
  } catch (e) {
    console.error(
      `error: ${rushFile} is not readable JSON — ${(e as Error).message}`,
    );
    return 2;
  }
  const verdict = await writeSurveyReport(dir, rush, {
    saturn: join(dir, "panes", "saturn.survey.json"),
    web: join(dir, "panes", "web.survey.json"),
  });
  if (!verdict) return 2;
  return verdict.ok ? 0 : 1;
}

/** Where a pane's survey goes, and its line in the log. */
async function writeSurvey(
  id: PaneId,
  dump: SurveyDump<unknown, { t: number }> | null,
  extra: Record<string, unknown>,
): Promise<{ file: string | null; summary: Record<string, unknown> | null }> {
  if (!dump) return { file: null, summary: null };
  const panes = join(OUT, "panes");
  await ensureDir(panes);
  const file = join(panes, `${id}.survey.json`);
  await Deno.writeTextFile(
    file,
    JSON.stringify({ pane: id, level: LEVEL, ...extra, ...dump }),
  );
  const summary = surveySummary(dump);
  log(
    `${id}: survey — ${dump.n} samples, ${dump.births.length} births, ${
      Object.keys(dump.kinds).length
    } kinds, up to ${dump.maxObjs} live objects${
      dump.err ? ` (error: ${dump.err})` : ""
    }`,
  );
  return { file, summary };
}

/**
 * The web runtime under --full: the level's first stage from its start, under
 * god mode, for --console-seconds, the survey sampling every object and
 * flying the ship. The record is served as foo.json as runWeb serves the
 * rush; the stage is --stage (0 by default), where the Saturn pane can only
 * play the cart's first.
 */
const runWebSurvey: PaneRunner = async (ctx) => {
  const spec = PANES.web;
  const cdp = ctx.rig.cdp;
  const served = await interceptFiles(cdp, {
    "/games/2028-ai/foo.json": {
      body: JSON.stringify(ctx.rush),
      type: "application/json",
    },
  });
  const unscript = await onNewDocument(cdp, [
    PROBE,
    `globalThis.__OFFLINE_LEVEL_NAME__ = ${JSON.stringify(LEVEL)};`,
  ]);
  const want = Number(flags["console-seconds"]) * 1000;
  try {
    await setViewport(cdp, spec.width, spec.height);
    await cdp.send("Page.navigate", {
      url: `${ctx.rig.origin}/games/2028-ai?stage=${STAGE}&story=0&god=1`,
    });
    await until(
      "the web stage to start",
      120_000,
      () =>
        cdp.eval<boolean>(`(function(){
        var g = window.__PHASER_GAME__;
        if (!g || !g.scene.isActive("PhaserGameScene")) return false;
        return !!g.scene.getScene("PhaserGameScene").gameStarted;
      })()`),
      250,
    );
    await cdp.eval(webSurvey({
      periodMs: 100,
      box: { x0: 40, x1: 216, y0: 300, y1: 440 },
      seed: 7,
    }));
    const cast = await screencast(cdp, join(OUT, "frames", "web"), spec);
    await cdp.eval(`window.__survey.on = true`);
    const t0 = Date.now();
    log(`web: in stage ${STAGE} (GOD); surveying for ${want / 1000} s`);
    let lastLog = 0;
    let ended: string | null = null;
    while (Date.now() - t0 < want + 2000) {
      await sleep(250);
      const st = await cdp.eval<
        { n: number; err: string | null; ended: string | null; t0: number }
      >(
        `(function(){ var S = window.__survey; return S ? { n: S.n, err: S.err, ended: S.ended, t0: S.t0 } : null; })()`,
      ).catch(() => null);
      if (!st) continue;
      if (st.err) throw new Error(`survey error: ${st.err}`);
      if (st.ended) {
        ended = st.ended;
        break;
      }
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        log(`  web: ${st.n} samples, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
    const dump = await fetchSurvey<SurveyDump<WebBirth, WebSample>>(
      cdp,
      SURVEY_DUMP,
      "web",
    );
    const frames = await cast.stop();
    const from = dump?.t0 ?? t0;
    const { clip, seconds } = await writeClip(
      "web",
      frames,
      from,
      Math.min(Date.now(), from + want),
    );
    if (!flags["keep-frames"]) {
      await Deno.remove(join(OUT, "frames", "web"), { recursive: true })
        .catch(() => {});
    }
    const survey = await writeSurvey("web", dump, {
      source: "import",
      stage: STAGE,
      modes: ["GOD"],
    });
    return {
      id: "web",
      status: "captured",
      clip,
      seconds,
      attempts: 1,
      telemetry: {
        window: `stage ${STAGE}'s first ${
          (seconds).toFixed(1)
        } s under god mode`,
        ended,
        survey: survey.summary,
        surveyFile: survey.file,
      },
      modes: ["GOD"],
    };
  } finally {
    await unscript();
    await served.stop();
  }
};

/**
 * The web runtime: 2028.Ai's own page with the rush served as its foo.json,
 * booted by the cheat URL straight into the first stage.
 */
const runWeb: PaneRunner = async (ctx) => {
  if (FULL) return await runWebSurvey(ctx);
  const served = await interceptFiles(ctx.rig.cdp, {
    "/games/2028-ai/foo.json": {
      body: JSON.stringify(ctx.rush),
      type: "application/json",
    },
  });
  try {
    return await runPilotPane({
      id: "web",
      url: () => `${ctx.rig.origin}/games/2028-ai?stage=0&story=0`,
      bot: webBot(botConfig(ctx.kinds)),
      // The rush is served as foo.json, which the runtime takes for its own
      // stock game unless told the offline level is a named one — an exported
      // app says so the same way. Without it a custom game plays the stock SP
      // cut-in where the web build (?level=) plays rando's (level-loader.js
      // applyCustomCutin).
      extraScripts: [
        `globalThis.__OFFLINE_LEVEL_NAME__ = ${JSON.stringify(LEVEL)};`,
      ],
      start: async (cdp) => {
        await until(
          "the web stage to start",
          120_000,
          () =>
            cdp.eval<boolean>(`(function(){
            var g = window.__PHASER_GAME__;
            if (!g || !g.scene.isActive("PhaserGameScene")) return false;
            return !!g.scene.getScene("PhaserGameScene").gameStarted;
          })()`),
          250,
        );
        return [];
      },
    }, ctx);
  } finally {
    await served.stop();
  }
};

/** Serve a folder over HTTP on 127.0.0.1; close() stops it. */
function serveFolder(dir: string, port: number) {
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".ini": "text/plain",
    ".wav": "audio/wav",
    ".adp": "application/octet-stream",
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    async (req) => {
      const path = decodeURIComponent(new URL(req.url).pathname).replace(
        /^\/+/,
        "",
      ) || "index.html";
      if (path.split("/").includes("..")) {
        return new Response("no", { status: 400 });
      }
      try {
        const body = await Deno.readFile(join(dir, path));
        const ext = path.slice(path.lastIndexOf("."));
        return new Response(body, {
          headers: {
            "content-type": TYPES[ext] ?? "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  );
  return { origin: `http://127.0.0.1:${port}`, close: () => server.shutdown() };
}

/** Serve bytes held here over HTTP on 127.0.0.1, by path; close() stops it. */
function serveFiles(
  files: Record<string, { body: Uint8Array | string; type: string }>,
  port: number,
) {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    (req) => {
      const f = files[new URL(req.url).pathname];
      if (!f) return new Response("not found", { status: 404 });
      return new Response(f.body as BodyInit, {
        headers: { "content-type": f.type, "cache-control": "no-store" },
      });
    },
  );
  return { origin: `http://127.0.0.1:${port}`, close: () => server.shutdown() };
}

/** Make the PS2 page all screen: the game canvas, nothing around it. */
const PS2_FULL_SCREEN = `(function () {
  // Runs before the document has an element to hang a style on, so it waits.
  function add() {
    if (document.getElementById("parity-full-screen")) return;
    var style = document.createElement("style");
    style.id = "parity-full-screen";
    style.textContent = "h1,.keys,.ps2-hud{display:none!important}" +
      "body{padding:0!important;gap:0!important;justify-content:flex-start!important;align-items:flex-start!important}" +
      "#ps2{width:640px!important;height:448px!important;border:0!important}" +
      "#ps2 canvas{width:640px!important;height:448px!important}";
    document.head.appendChild(style);
  }
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
})()`;

/**
 * The PS2 build in the browser: the level's rush built for the PS2
 * (silent — the GIF has no sound), written out as its web build
 * (lib/ps2/web-build.ts), served from here, started from its own title with
 * SELECT — TURBO. A run that died or timed out before its window is tried
 * again from the title with L1+R1 held as well: the god-mode secret.
 */
const runPs2: PaneRunner = async (ctx) => {
  const built = await buildPs2({
    root: ROOT,
    levelName: LEVEL,
    // A cart's import is read from the file every other pane builds from,
    // never from the cloud by the cart's name.
    levelFile: SAV ? join(OUT, "rush.json") : null,
    bossRush: FULL ? null : STAGE,
    skipAudio: true,
    log: (m) => log(`  ${m.trim()}`),
  });
  if (!built.appDir) throw new Error("the PS2 build wrote no app folder");
  const webDir = join(OUT, "ps2-web");
  await writeWebBuild(built.appDir, webDir, {
    title: FULL ? LEVEL : `${LEVEL} boss rush`,
  });
  const site = serveFolder(webDir, Number(flags["serve-port"]) + 2);
  try {
    if (FULL) return await runPs2Full(ctx, site.origin);
    return await runPilotPane({
      id: "ps2",
      url: () => `${site.origin}/index.html`,
      bot: ps2Bot(botConfig(ctx.kinds)),
      extraScripts: [PS2_FULL_SCREEN],
      start: async (cdp, attempt, previous) => {
        await until(
          "the PS2 title",
          120_000,
          () =>
            cdp.eval<boolean>(`!!(window.__PS2_HOST__ && __PS2_HOST__.ready &&
            window.__PS2_CTX__ && __PS2_CTX__.scenes.current === "title")`),
          250,
        );
        // Any attempt after one that came back without a window: died, or ran
        // out its time with the boss still too healthy — the cheat covers both.
        const god = attempt > 1 && previous !== null;
        // SELECT starts the run in turbo; L1+R1 held with it is god mode. The
        // title takes no press while it is still flying in, so the press is
        // made again every two seconds until the scene changes.
        const inStage = () =>
          cdp.eval<boolean>(
            `!!(window.__PS2_GS__ && __PS2_CTX__.scenes.current === "game" &&
            __PS2_GS__() && __PS2_GS__().player)`,
          );
        const buttons = `B.SELECT${god ? " | B.L1 | B.R1" : ""}`;
        await until("the PS2 stage", 60_000, async () => {
          if (await inStage()) return true;
          await cdp.eval(
            `(function(){ var B = __PS2_PADS__.BUTTONS; __PS2_PADS__.set(${buttons}); return true; })()`,
          );
          await sleep(300);
          await cdp.eval(`__PS2_PADS__.clear(), true`);
          await sleep(1700);
          return await inStage();
        }, 0);
        const state = await cdp.eval<{ turbo: number; god: number }>(
          `({ turbo: __PS2_CTX__.state.turboMode, god: __PS2_CTX__.state.godMode || 0 })`,
        );
        return [
          ...(state.turbo ? ["TURBO"] : []),
          ...(state.god ? ["GOD"] : []),
        ];
      },
    }, ctx);
  } finally {
    await site.close();
  }
};

/**
 * The PS2 build under --full: its one stage from the title, started with
 * SELECT + L1 + R1 (turbo and god mode: the port has no stage select and its
 * ship is mortal), surveyed for --console-seconds the way the web pane is.
 */
async function runPs2Full(
  ctx: PaneContext,
  origin: string,
): Promise<PaneResult> {
  const spec = PANES.ps2;
  const cdp = ctx.rig.cdp;
  const unscript = await onNewDocument(cdp, [PS2_FULL_SCREEN]);
  const want = Number(flags["console-seconds"]) * 1000;
  try {
    await setViewport(cdp, spec.width, spec.height);
    await cdp.send("Page.navigate", { url: `${origin}/index.html` });
    await until(
      "the PS2 title",
      120_000,
      () =>
        cdp.eval<boolean>(`!!(window.__PS2_HOST__ && __PS2_HOST__.ready &&
        window.__PS2_CTX__ && __PS2_CTX__.scenes.current === "title")`),
      250,
    );
    const inStage = () =>
      cdp.eval<boolean>(
        `!!(window.__PS2_GS__ && __PS2_CTX__.scenes.current === "game" &&
        __PS2_GS__() && __PS2_GS__().player)`,
      );
    await until("the PS2 stage", 60_000, async () => {
      if (await inStage()) return true;
      await cdp.eval(
        `(function(){ var B = __PS2_PADS__.BUTTONS; __PS2_PADS__.set(B.SELECT | B.L1 | B.R1); return true; })()`,
      );
      await sleep(300);
      await cdp.eval(`__PS2_PADS__.clear(), true`);
      await sleep(1700);
      return await inStage();
    }, 0);
    const state = await cdp.eval<{ turbo: number; god: number }>(
      `({ turbo: __PS2_CTX__.state.turboMode, god: __PS2_CTX__.state.godMode || 0 })`,
    );
    const modes = [
      ...(state.turbo ? ["TURBO"] : []),
      ...(state.god ? ["GOD"] : []),
    ];
    await cdp.eval(ps2Survey({
      periodMs: 100,
      box: { x0: 40, x1: 200, y0: 300, y1: 440 },
      seed: 7,
    }));
    const cast = await screencast(cdp, join(OUT, "frames", "ps2"), spec);
    await cdp.eval(`window.__survey.on = true`);
    const t0 = Date.now();
    log(`ps2: in the stage (${modes.join(", ")}); surveying for ${want / 1000} s`);
    let lastLog = 0;
    let ended: string | null = null;
    while (Date.now() - t0 < want + 2000) {
      await sleep(250);
      const st = await cdp.eval<
        { n: number; err: string | null; ended: string | null }
      >(
        `(function(){ var S = window.__survey; return S ? { n: S.n, err: S.err, ended: S.ended } : null; })()`,
      ).catch(() => null);
      if (!st) continue;
      if (st.err) throw new Error(`survey error: ${st.err}`);
      if (st.ended) {
        ended = st.ended;
        break;
      }
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        log(`  ps2: ${st.n} samples, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
    const dump = await fetchSurvey<SurveyDump<WebBirth, WebSample>>(
      cdp,
      PS2_SURVEY_DUMP,
      "ps2",
    );
    const frames = await cast.stop();
    const from = dump?.t0 ?? t0;
    const { clip, seconds } = await writeClip(
      "ps2",
      frames,
      from,
      Math.min(Date.now(), from + want),
    );
    if (!flags["keep-frames"]) {
      await Deno.remove(join(OUT, "frames", "ps2"), { recursive: true })
        .catch(() => {});
    }
    const survey = await writeSurvey("ps2", dump, {
      source: "export",
      modes,
    });
    return {
      id: "ps2",
      status: "captured",
      clip,
      seconds,
      attempts: 1,
      telemetry: {
        window: `the stage's first ${seconds.toFixed(1)} s`,
        source: "export",
        ended,
        survey: survey.summary,
        surveyFile: survey.file,
      },
      modes,
    };
  } finally {
    await unscript();
  }
}

/** EmulatorJS's own chrome — the menu bar, its button, the virtual pad — off. */
const EJS_BARE = `(function () {
  function add() {
    var style = document.createElement("style");
    style.textContent = "[class*=ejs_menu],[class*=ejs_virtualGamepad],[class*=ejs_context],[class*=ejs_settings],[class*=ejs_popup]{display:none!important}";
    document.head.appendChild(style);
  }
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
})()`;

/** The first file under dev-fixtures/ (two folders deep) a test accepts. */
async function findFixture(
  test: (name: string) => boolean,
): Promise<string | null> {
  const root = join(ROOT, "dev-fixtures");
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    try {
      for await (const e of Deno.readDir(dir)) {
        const path = join(dir, e.name);
        // A worktree junctions the main checkout's console folders in.
        const linked = e.isSymlink
          ? await Deno.stat(path).catch(() => null)
          : null;
        if ((e.isFile || linked?.isFile) && test(e.name)) return path;
        if ((e.isDirectory || linked?.isDirectory) && depth > 0) {
          const hit = await walk(path, depth - 1);
          if (hit) return hit;
        }
      }
    } catch { /* not there */ }
    return null;
  };
  return await walk(root, 2);
}

/**
 * A pane on an emulated original, flown by the rewind pilot
 * (scripts/lib/parity-emu.ts). Its RAM is found in the core's heap, the
 * pilot plays one continuous run cutting out every death, and the clip is the
 * kept run from the stage's first frame for `--console-seconds` — the
 * showcase row, then the boss: this pilot reads no boss state on these
 * targets, so the window is the stage, not the boss's half bar.
 */
interface EmuPane {
  id: PaneId;
  url: string;
  /** Files answered from here (interceptFiles); none when the page's own server has them. */
  files?: Record<string, { body: Uint8Array | string; type: string }>;
  /** Page code run on every new document, after EJS_BARE. */
  scripts?: string[];
  /** From the loaded page to the stage's first frame; answers the RAM's heap offset. */
  boot: (cdp: Cdp) => Promise<number>;
  pilot: Omit<EmuPilotConfig, "ramBase">;
  /** What the pane plays: the cart itself, or the record written back out. */
  source?: "cart" | "export";
  /** The survey's page code for this RAM, installed beside the pilot (--full). */
  survey?: (ramBase: number) => string;
}

async function runEmuPane(
  pane: EmuPane,
  ctx: PaneContext,
): Promise<PaneResult> {
  const spec = PANES[pane.id];
  const cdp = ctx.rig.cdp;
  await setViewport(cdp, spec.width, spec.height);
  const served = pane.files ? await interceptFiles(cdp, pane.files) : null;
  const unscript = await onNewDocument(cdp, [EJS_BARE, ...pane.scripts ?? []]);
  const want = Number(flags["console-seconds"]) * 1000;
  const cap = Number(flags["console-wall"]) * 1000;
  try {
    await cdp.send("Page.navigate", { url: pane.url });
    const ramBase = await pane.boot(cdp);
    log(`${pane.id}: in the stage; its RAM is at heap ${ramBase}`);
    await cdp.eval(emuPilot({ ...pane.pilot, ramBase }));
    if (pane.survey) await cdp.eval(pane.survey(ramBase));
    const cast = await screencast(cdp, join(OUT, "frames", pane.id), spec);
    await cdp.eval(
      `window.__emu.on = true, window.__survey && (window.__survey.on = true)`,
    );
    const t0 = Date.now();
    let st: EmuStatus | null = null;
    let lastLog = 0;
    const runMs = (s: EmuStatus) =>
      s.kept.reduce((n, [a, b]) => n + ((b ?? Date.now()) - a), 0);
    while (Date.now() - t0 < cap) {
      await sleep(500);
      st = await cdp.eval<EmuStatus>(EMU_STATUS).catch(() => st);
      if (!st) continue;
      if (st.err) throw new Error(`pilot error: ${st.err}`);
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        log(
          `  ${pane.id}: ${(runMs(st) / 1000).toFixed(1)} s kept of ${
            want / 1000
          }, ${st.deaths} deaths cut`,
        );
      }
      if (runMs(st) >= want) break;
    }
    await cdp.eval(`window.__emu.stop(), true`);
    st = await cdp.eval<EmuStatus>(EMU_STATUS);
    const dump = pane.survey
      ? await fetchSurvey<SurveyDump<SaturnBirth, SaturnSample>>(
        cdp,
        SURVEY_DUMP,
        pane.id,
      )
      : null;
    const frames = await cast.stop();
    const last = st.kept.filter((s): s is [number, number] => s[1] !== null);
    const lastMs = last.reduce((n, [a, b]) => n + (b - a), 0);
    // A late escalating rewind can leave less than the run once held; the
    // longer one's frames are still in the screencast.
    const kept = (st.bestMs ?? 0) > lastMs && st.best ? st.best : last;
    const keptMs = kept.reduce((n, [a, b]) => n + (b - a), 0);
    const panes = join(OUT, "panes");
    await ensureDir(panes);
    const picked = keptFrames(frames, kept, FPS, 0, want);
    if (!picked.length) throw new Error("no frames kept");
    const list = join(panes, `${pane.id}.frames.txt`);
    await Deno.writeTextFile(list, concatList(picked, FPS));
    const clip = join(panes, `${pane.id}.mp4`);
    await ffmpeg(clipArgs(list, FPS, clip, PANES[pane.id].crop));
    await Deno.remove(list).catch(() => {});
    if (!flags["keep-frames"]) {
      await Deno.remove(join(OUT, "frames", pane.id), { recursive: true })
        .catch(() => {});
    }
    // The survey's samples carry wall time; the kept spans say which of them
    // belong to the run the clip shows (a rewind cut the rest).
    const survey = await writeSurvey(pane.id, dump, {
      source: pane.source ?? "export",
      kept,
      deaths: st.deaths,
    });
    return {
      id: pane.id,
      status: "captured",
      clip,
      seconds: picked.length / FPS,
      telemetry: {
        window: `the stage's first ${
          (Math.min(keptMs, want) / 1000).toFixed(1)
        } s of surviving play`,
        source: pane.source ?? "export",
        deathsCut: st.deaths,
        keptSpans: kept.length,
        wallSeconds: Math.round((Date.now() - t0) / 1000),
        reachedWanted: keptMs >= want,
        ...(survey.summary
          ? { survey: survey.summary, surveyFile: survey.file }
          : {}),
      },
      modes: [],
    };
  } finally {
    await unscript();
    await served?.stop();
  }
}

/** Write an SRAM image into a running EmulatorJS core and reset it onto it. */
const installSaveExpr = (url: string) =>
  `(async function(){
  var gm = EJS_emulator.gameManager;
  var bytes = new Uint8Array(await (await fetch(${
    JSON.stringify(url)
  })).arrayBuffer());
  var path = gm.getSaveFilePath(); var parts = path.split('/'), at = '';
  for (var i = 0; i < parts.length - 1; i++) { if (!parts[i]) continue; at += '/' + parts[i]; if (!gm.FS.analyzePath(at).exists) gm.FS.mkdir(at); }
  if (gm.FS.analyzePath(path).exists) gm.FS.unlink(path);
  gm.FS.writeFile(path, bytes); gm.loadSaveFiles(); gm.restart();
  return path;
})()`;

const press = async (cdp: Cdp, index: number, ms = 150) => {
  await cdp.eval(
    `EJS_emulator.gameManager.simulateInput(0, ${index}, 1), true`,
  );
  await sleep(ms);
  await cdp.eval(
    `EJS_emulator.gameManager.simulateInput(0, ${index}, 0), true`,
  );
};

/**
 * Super Famicom Dezaemon: the rush as the cart's SRAM (build:sfc), the cart
 * from dev-fixtures/, /snes/play.html's EmulatorJS snes9x. Main menu → START
 * is GAME PLAY whatever the cursor says → the game's title → START is GAME
 * START (FORMAT-SFC.md "Running a save"). WRAM is the heap offset where the
 * three screens' state bytes all hold; lives are $19D2/$1D48, the ship
 * $0110/$0112, Y fires.
 */
const runSfc: PaneRunner = async (ctx) => {
  const rom = await findFixture((n) =>
    /dezaemon/i.test(n) && /\.sfc$/i.test(n)
  );
  if (!rom) {
    return {
      id: "sfc",
      status: "blocked",
      reason: "no Dezaemon .sfc in dev-fixtures/",
    };
  }
  const rushFile = join(OUT, "rush.json");
  const srmPath = join(OUT, "sfc", "rush.srm");
  await buildSfc({ level: rushFile, out: srmPath, log: (m) => log(`  ${m}`) });
  return await runEmuPane({
    id: "sfc",
    url: `${ctx.rig.origin}/snes/play.html?rom=/__parity/sfc/rom.sfc`,
    files: {
      "/__parity/sfc/rom.sfc": {
        body: await Deno.readFile(rom),
        type: "application/octet-stream",
      },
      "/__parity/sfc/game.srm": {
        body: await Deno.readFile(srmPath),
        type: "application/octet-stream",
      },
    },
    boot: async (cdp) => {
      await until("the snes9x core", 120_000, () =>
        cdp.eval<boolean>(
          `!!(window.EJS_emulator && EJS_emulator.gameManager && EJS_emulator.started)`,
        ), 500);
      await cdp.eval(installSaveExpr("/__parity/sfc/game.srm"));
      await sleep(30_000);
      await cdp.eval(locateExpr([[0x0d, 1], [0x3d6, 5]], true));
      await press(cdp, 3);
      await sleep(5000);
      await cdp.eval(locateExpr([[0xd8, 0x9c]], false));
      await press(cdp, 3);
      await sleep(2500);
      const base = await cdp.eval<number>(
        locateExpr([[0x3f4, 1], [0x406, 3]], false),
      );
      if (base < 0) {
        throw new Error(`WRAM not found (${-base} candidates left)`);
      }
      return base;
    },
    pilot: {
      lives: [0x19d2, 0x1d48],
      fire: 1,
      pad: { up: 4, down: 5, left: 6, right: 7 },
      checkpointMs: 1500,
      rewindCheckpoints: 2,
      maxTries: 6,
      seed: 7,
      ship: { x: 0x110, y: 0x112, box: { x0: 24, x1: 220, y0: 140, y1: 210 } },
    },
  }, ctx);
};

/**
 * `file` in cmg's static/bios/, in a cmg checkout next to this one — or next
 * to the checkout a worktree under .claude/worktrees/ belongs to, which is
 * where a sibling actually sits: every ancestor's neighbour is looked at.
 */
async function cmgBios(file: string): Promise<string | null> {
  let dir = ROOT;
  for (let up = 0; up < 5; up++) {
    const path = join(dir, "..", "cmg", "static", "bios", file);
    if (await exists(path, { isFile: true })) return path;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The Saturn's JP BIOS (Dezaemon 2 is a Japanese disc): $SATURN_BIOS, else
 * a sega_101.bin under dev-fixtures/, beside Mednafen, or in a cmg checkout
 * next to this one.
 */
async function findSaturnBios(): Promise<string | null> {
  const home = Deno.env.get(
    Deno.build.os === "windows" ? "USERPROFILE" : "HOME",
  );
  const candidates = [
    Deno.env.get("SATURN_BIOS"),
    await findFixture((n) => n.toLowerCase() === "sega_101.bin"),
    home && join(home, "saturn", "mednafen", "firmware", "sega_101.bin"),
    home && join(home, ".mednafen", "firmware", "sega_101.bin"),
    await cmgBios("sega_101.bin"),
  ];
  for (const path of candidates) {
    if (path && await exists(path, { isFile: true })) return path;
  }
  return null;
}

/**
 * Saturn Dezaemon 2 with no backup cartridge: the rush written onto the disc
 * as its boot image (disc:inject), its bring-your-own-disc zip and the JP
 * BIOS served to a page of EmulatorJS's yabause (lib/parity-saturn.ts).
 * Power-on → the no-cartridge dialog's はい → the title (START, or nothing is
 * clickable) → PLAY → U → the game's title → START → START is GAME START,
 * each step read off HWRAM, never timed. Lives are u8 0x06084354, the ship
 * object slot 2's px << 7 words, Saturn R (the game's rapid fire) fires.
 */
const runSaturn: PaneRunner = async (ctx) => {
  const bios = await findSaturnBios();
  if (!bios) {
    return {
      id: "saturn",
      status: "blocked",
      reason:
        "no Saturn JP BIOS (sega_101.bin) — set SATURN_BIOS or drop it under dev-fixtures/",
    };
  }
  if (!await findSaturnDisc(ROOT)) {
    return {
      id: "saturn",
      status: "blocked",
      reason: "no Dezaemon 2 disc in dev-fixtures/ (or $DEZAEMON_DISC)",
    };
  }
  // --sav --full: the cart itself goes on the disc, byte for byte, so the
  // Saturn plays the original and the web its import — the comparison the
  // survey is for. A rush, or a cloud level, is built from the record; so is
  // a --saturn-export run, which puts the import's round trip (build:sav) on
  // the Saturn instead, to tell what the writer loses from what the runtime
  // plays differently.
  const original = !!(SAV && FULL) && !flags["saturn-export"];
  const disc = await injectDisc(
    original
      ? {
        sav: SAV!,
        slot: SAV_SLOT,
        name: LEVEL,
        out: join(OUT, "saturn"),
        zip: true,
        log: (m) => log(`  ${m}`),
      }
      : {
        level: join(OUT, "rush.json"),
        out: join(OUT, "saturn"),
        zip: true,
        log: (m) => log(`  ${m}`),
      },
  );
  if (!disc.zipPath) throw new Error("disc:inject wrote no zip");
  log(
    `saturn: plays ${
      original ? "the ORIGINAL cart" : "the record written back out (build:sav)"
    }`,
  );
  const spec = PANES.saturn;
  const cdp = ctx.rig.cdp;
  const hwram = (a: number) => a - 0x06000000;
  const byte = (a: number) => cdp.eval<number>(`__sat.b(${a})`);
  const word = (a: number) => cdp.eval<number>(`__sat.w(${a})`);
  return await runEmuPane({
    id: "saturn",
    source: original ? "cart" : "export",
    survey: FULL
      ? (ramBase) => saturnSurvey({ ramBase, periodMs: 100, slots: 256 })
      : undefined,
    url: `${ctx.rig.origin}/__parity/saturn/play.html`,
    files: {
      "/__parity/saturn/play.html": {
        body: saturnPage({
          disc: "/__parity/saturn/disc.zip",
          bios: "/__parity/saturn/bios.bin",
          width: spec.width,
          height: spec.height,
        }),
        type: "text/html; charset=utf-8",
      },
      "/__parity/saturn/disc.zip": {
        body: await Deno.readFile(disc.zipPath),
        type: "application/zip",
      },
      "/__parity/saturn/bios.bin": {
        body: await Deno.readFile(bios),
        type: "application/octet-stream",
      },
    },
    boot: async () => {
      await until("the yabause core", 120_000, () =>
        cdp.eval<boolean>(
          `!!(window.EJS_emulator && EJS_emulator.gameManager && EJS_emulator.started)`,
        ), 500);
      await cdp.eval(SATURN_RAM);
      const { base } = await until(
        "HWRAM in the core's heap",
        120_000,
        async () => {
          const at = await cdp.eval<number>(`__sat.find()`);
          return at >= 0 ? { base: at } : null;
        },
        1000,
      );
      // The no-cartridge dialog: its pointer starts between はい and いいえ,
      // where a click lands on neither. The flag is stored once the title
      // has started, a few seconds after はい.
      await until("the no-cartridge dialog's はい", 120_000, async () => {
        if (await byte(SATURN.workFlag) === 1) return true;
        if (await word(SATURN.overlay) !== 0x2fe6) return false;
        await cdp.eval(
          `__sat.steer(${DIALOG_YES.x}, ${DIALOG_YES.y}, null, 4000)`,
        );
        await press(cdp, 0);
        const t = Date.now();
        while (Date.now() - t < 6000) {
          await sleep(500);
          if (await byte(SATURN.workFlag) === 1) return true;
        }
        return false;
      }, 500);
      log("saturn: past the no-cartridge dialog");
      await until("the title's menu", 60_000, async () => {
        if (await word(SATURN.menuState) === 1) return true;
        await press(cdp, 3);
        await sleep(1000);
        return await word(SATURN.menuState) === 1;
      }, 0);
      // PLAY → U: trusted by the hovered item, not by the picture — an icon
      // can look lit while the pointer is outside its hit box.
      await until("PLAY → U", 60_000, async () => {
        if (await word(SATURN.menuState) !== 1) return true;
        const at = await cdp.eval<{ hover: number }>(
          `__sat.steer(${PLAY_U.x}, ${PLAY_U.y}, ${PLAY_U.hover}, 6000)`,
        );
        if (at.hover !== PLAY_U.hover) return false;
        await press(cdp, 0);
        await sleep(2000);
        return await word(SATURN.menuState) !== 1;
      }, 0);
      log("saturn: the game is loading");
      // The game's title: START opens its menu (or leaves the high-score
      // page for the title), START again is GAME START. Pressed until the
      // play state says P1 is in a running game — no further, as START in
      // the stage is pause.
      await until("the game's first stage", 120_000, async () => {
        const inPlay = async () => (await byte(SATURN.playState) & 0x83) === 3;
        if (await inPlay()) return true;
        await press(cdp, 3, 120);
        await sleep(1400);
        return await inPlay();
      }, 0);
      return base;
    },
    pilot: {
      wordSwap: true,
      lives: [hwram(SATURN.lives)],
      fire: 13,
      pad: { up: 4, down: 5, left: 6, right: 7 },
      checkpointMs: 1500,
      rewindCheckpoints: 2,
      maxTries: 6,
      seed: 7,
      // The low word of each u32 slot: px << 7 fits in it.
      ship: {
        x: hwram(SATURN.shipX) + 2,
        y: hwram(SATURN.shipY) + 2,
        shift: 7,
        box: { x0: 72, x1: 248, y0: 120, y1: 200 },
      },
    },
  }, ctx);
};

/**
 * The PlayStation's JP BIOS (both Dezaemons are SLPS discs): $PSX_BIOS, else
 * a scph5500.bin under dev-fixtures/, in Mednafen's firmware folder, or in a
 * cmg checkout next to this one (cmg's PlayStation player boots it too).
 */
async function findPsxBios(): Promise<string | null> {
  const home = Deno.env.get(
    Deno.build.os === "windows" ? "USERPROFILE" : "HOME",
  );
  const candidates = [
    Deno.env.get("PSX_BIOS"),
    await findFixture((n) => n.toLowerCase() === "scph5500.bin"),
    home && join(home, "saturn", "mednafen", "firmware", "scph5500.bin"),
    home && join(home, ".mednafen", "firmware", "scph5500.bin"),
    await cmgBios("scph5500.bin"),
  ];
  for (const path of candidates) {
    if (path && await exists(path, { isFile: true })) return path;
  }
  return null;
}

/**
 * A PlayStation disc as the stored zip of its cue and track (the zip the
 * launcher hands its player) at /disc.zip, from a server of its own on
 * 127.0.0.1: a disc is 150-700 MB, no body for a DevTools message. The pane's
 * page is opened on this origin too — interceptFiles answers it by path — as
 * Chrome's Local Network Access refuses a page on one loopback port a fetch
 * from another.
 */
function serveDisc(disc: PsxDisc, port: number) {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    (req) => {
      const headers = { "cache-control": "no-store" };
      if (new URL(req.url).pathname !== "/disc.zip") {
        return new Response("not found", { status: 404, headers });
      }
      return new Response(psxDiscZipStream(disc), {
        headers: {
          ...headers,
          "content-type": "application/zip",
          "content-length": String(psxDiscZipLength(disc)),
        },
      });
    },
  );
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(),
  };
}

/**
 * The page, the card and the BIOS of a PlayStation pane, under
 * /__parity/<id>/ on serveDisc's origin.
 */
async function psxFiles(
  id: PaneId,
  disc: PsxDisc,
  card: string,
  bios: string,
) {
  const spec = PANES[id];
  const octet = "application/octet-stream";
  return {
    [`/__parity/${id}/play.html`]: {
      body: psxPage({
        disc: "/disc.zip",
        bios: `/__parity/${id}/scph5500.bin`,
        name: disc.content,
        width: spec.width,
        height: spec.height,
      }),
      type: "text/html; charset=utf-8",
    },
    [`/__parity/${id}/card.mcr`]: {
      body: await Deno.readFile(card),
      type: octet,
    },
    [`/__parity/${id}/scph5500.bin`]: {
      body: await Deno.readFile(bios),
      type: octet,
    },
  };
}

/**
 * Wait for the psx core to run. While it does not, the probe fails with what
 * EmulatorJS is showing (a download's progress, "Network Error"), so a
 * timeout says where the boot stopped.
 */
async function psxCore(cdp: Cdp) {
  await until("the psx core", 240_000, async () => {
    const state = await cdp.eval<string>(`(function () {
      var e = window.EJS_emulator;
      if (!e) return "no EmulatorJS yet";
      if (e.gameManager && e.started) return "ok";
      return (e.textElem && e.textElem.innerText) || "loading";
    })()`);
    if (state === "ok") return true;
    throw new Error(state);
  }, 500);
}

/** Wait out the core's start and find main RAM by the EXE's `needle`. */
async function psxRam(cdp: Cdp, needle: string, at: number): Promise<number> {
  await cdp.eval(PSX_RAM);
  const { base } = await until(
    "PS1 RAM in the core's heap",
    120_000,
    async () => {
      // Not `>= 0`: no hit at all is minus zero.
      const found = await cdp.eval<number>(
        `__psx.find(${JSON.stringify(needle)}, ${at})`,
      );
      return found > 0 ? { base: found } : null;
    },
    1000,
  );
  return base;
}

/**
 * Dezaemon Kids!: the rush as a memory card (build:kids) in slot 1, the disc
 * from dev-fixtures/, EmulatorJS's pcsx_rearmed (lib/parity-psx.ts). Power-on
 * → circle past Peron's welcome to the main menu → 作ろう! → Peron → ロード →
 * slot 1 → はい, the card loading → back out to the main menu → 遊ぼう! → the
 * ユーザーゲーム island → the game's title → START is GAME START. Every click
 * flies the pointer by its RAM and is pressed again until the screen it opens
 * reads back. Lives are two counters, the ship an object's px << 7 words,
 * square (held, the game's own rapid fire) fires.
 */
const runKids: PaneRunner = async (ctx) => {
  const bios = await findPsxBios();
  if (!bios) {
    return {
      id: "kids",
      status: "blocked",
      reason:
        "no PlayStation JP BIOS (scph5500.bin) — set PSX_BIOS or drop it under dev-fixtures/",
    };
  }
  const disc = await findPsxDisc(ROOT, "slps-01503");
  if (!disc) {
    return {
      id: "kids",
      status: "blocked",
      reason: "no Dezaemon Kids! disc (SLPS-01503) in dev-fixtures/",
    };
  }
  const card = join(OUT, "kids", "rush.mcr");
  await buildKids({
    level: join(OUT, "rush.json"),
    out: card,
    log: (m) => log(`  ${m}`),
  });
  const cdp = ctx.rig.cdp;
  const byte = (a: number) => cdp.eval<number>(`__psx.b(${a})`);
  const word = (a: number) => cdp.eval<number>(`__psx.w(${a})`);
  /** Fly the pointer to `at` and press circle until `opened` reads true. */
  const click = (
    what: string,
    at: { x: number; y: number },
    opened: () => Promise<boolean>,
    timeoutMs = 20_000,
  ) =>
    until(what, timeoutMs, async () => {
      if (await opened()) return true;
      await cdp.eval(`__psx.steer(${at.x}, ${at.y})`);
      await press(cdp, 8);
      const t = Date.now();
      while (Date.now() - t < 2000) {
        await sleep(150);
        if (await opened()) return true;
      }
      return false;
    }, 0);
  const site = serveDisc(disc, Number(flags["serve-port"]) + 3);
  try {
    return await runEmuPane({
      id: "kids",
      url: `${site.origin}/__parity/kids/play.html`,
      files: await psxFiles("kids", disc, card, bios),
      boot: async () => {
        await psxCore(cdp);
        // The card goes in before KIDS.EXE is in RAM, so nothing the RAM
        // holds next can be left from the boot before the reset.
        await cdp.eval(installSaveExpr("/__parity/kids/card.mcr"));
        const base = await psxRam(cdp, KIDS.needle, KIDS.needleAt);
        const atMain = async () =>
          await word(KIDS.gfx) === KIDS.gfxMain &&
          await byte(KIDS.layer) === 1 &&
          (await Promise.all(KIDS.mainButtons.map(byte))).every((b) => b === 1);
        await until("the main menu", 120_000, async () => {
          if (await atMain()) return true;
          // Circle skips the logo, Peron's welcome, and the title's はじまるよ
          // (under the pointer where it starts).
          await press(cdp, 8);
          await sleep(1000);
          return false;
        }, 0);
        log("kids: at the main menu");
        const gfx = (v: number) => async () => await word(KIDS.gfx) === v;
        const layer = (v: number) => async () => await byte(KIDS.layer) === v;
        await click("作ろう!", KIDS_AT.make, gfx(KIDS.gfxMake));
        await click("PERON MENU", KIDS_AT.peron, layer(2));
        await click("ロード", KIDS_AT.load, layer(3));
        // Slot 1 is pressed until its question is up; while the slots are
        // still being read, a press does nothing.
        await click(
          "slot 1",
          KIDS_AT.slot1,
          async () => await byte(KIDS.dialog) === 0,
        );
        // はい, then circle until the bubble closes: the question's はい
        // starts the load, the presses during it are dropped, and the one
        // after it closes the "done" bubble.
        await cdp.eval(`__psx.steer(${KIDS_AT.yes.x}, ${KIDS_AT.yes.y})`);
        await until("the card to load", 120_000, async () => {
          await press(cdp, 8);
          await sleep(1500);
          return await byte(KIDS.dialog) === 255;
        }, 0);
        log("kids: the card is loaded");
        await click("back", KIDS_AT.back, layer(2));
        await click("PERON MENU closed", KIDS_AT.peron, layer(1));
        await click("the exit", KIDS_AT.exit, atMain);
        await click("遊ぼう!", KIDS_AT.play, gfx(KIDS.gfxPlay));
        await click(
          "the user-game island",
          KIDS_AT.island,
          async () => await word(KIDS.runtime) === KIDS.runtimeWord,
          30_000,
        );
        log("kids: the game is loading");
        // The title card cycles with the item list and the high scores, and
        // START lands only on the card: pressed every second until the stock
        // is dealt, and no more, so no press reaches the stage itself.
        const inStage = async () =>
          (await Promise.all(KIDS.lives.map(byte))).every((n) => n === 2);
        await until("the game's first stage", 120_000, async () => {
          if (await inStage()) return true;
          await press(cdp, 3, 120);
          await sleep(900);
          return await inStage();
        }, 0);
        return base;
      },
      pilot: {
        lives: [...KIDS.lives],
        fire: 1,
        pad: { up: 4, down: 5, left: 6, right: 7 },
        checkpointMs: 1500,
        rewindCheckpoints: 2,
        maxTries: 6,
        seed: 7,
        ship: {
          x: KIDS.shipX,
          y: KIDS.shipY,
          shift: 7,
          littleEndian: true,
          box: { x0: 40, x1: 216, y0: 120, y1: 200 },
        },
      },
    }, ctx);
  } finally {
    await site.close();
  }
};

/**
 * Dezaemon Plus Select 100: the rush as a memory card (build:plus) written
 * into slot 2 — the one slot its GAME LOAD reads — the disc from
 * dev-fixtures/, EmulatorJS's pcsx_rearmed. Power-on → START at the title →
 * MEMORY CARD → GAME LOAD → the game's menu → START (held: a short one is
 * dropped) is GAME START. Each step is read off the menu record and the
 * runtime's state byte. Lives are REST, the ship its field position, square
 * fires.
 */
const runPlus: PaneRunner = async (ctx) => {
  const bios = await findPsxBios();
  if (!bios) {
    return {
      id: "plus",
      status: "blocked",
      reason:
        "no PlayStation JP BIOS (scph5500.bin) — set PSX_BIOS or drop it under dev-fixtures/",
    };
  }
  // The 1996 Dezaemon+ (SLPS-00335) reads the same cards, but its RAM is not
  // Select 100's: this pane knows only the re-release.
  const disc = await findPsxDisc(ROOT, "slps-01504");
  if (!disc) {
    return {
      id: "plus",
      status: "blocked",
      reason: "no Dezaemon Plus Select 100 disc (SLPS-01504) in dev-fixtures/",
    };
  }
  const card = join(OUT, "plus", "rush.mcr");
  await buildPlus({
    level: join(OUT, "rush.json"),
    out: card,
    log: (m) => log(`  ${m}`),
  });
  const cdp = ctx.rig.cdp;
  const byte = (a: number) => cdp.eval<number>(`__psx.b(${a})`);
  const screen = async () =>
    `${await byte(PLUS.screenA)}/${await byte(PLUS.screenB)}`;
  /** Cursor to item 2, circle until `opened` reads true. */
  const pick = (what: string, opened: () => Promise<boolean>) =>
    until(what, 30_000, async () => {
      if (await opened()) return true;
      const at = await byte(PLUS.cursor);
      if (at !== 2) {
        await press(cdp, at < 2 ? 5 : 4);
        await sleep(250);
        return false;
      }
      await press(cdp, 8);
      await sleep(800);
      return await opened();
    }, 0);
  const site = serveDisc(disc, Number(flags["serve-port"]) + 3);
  try {
    return await runEmuPane({
      id: "plus",
      url: `${site.origin}/__parity/plus/play.html`,
      files: await psxFiles("plus", disc, card, bios),
      boot: async () => {
        await psxCore(cdp);
        await cdp.eval(PSX_RAM);
        const slot2 = await cdp.eval<number>(
          `__psx.card2("/__parity/plus/card.mcr")`,
        );
        if (slot2 < 0) throw new Error("the core's slot-2 card was not found");
        await cdp.eval(`EJS_emulator.gameManager.restart(), true`);
        const base = await psxRam(cdp, PLUS.needle, PLUS.needleAt);
        await until("Select 100's menu", 120_000, async () => {
          if (await screen() === "255/255") return true;
          if (await byte(PLUS.screenA) === 1) await press(cdp, 3);
          await sleep(700);
          return await screen() === "255/255";
        }, 0);
        await pick("MEMORY CARD", async () => await screen() === "0/6");
        await pick("GAME LOAD", async () => await byte(PLUS.screenA) === 240);
        log("plus: GAME LOAD is reading slot 2");
        await until(
          "the game's menu",
          180_000,
          async () => await byte(PLUS.state) === 32,
          1000,
        );
        // START on the high scores goes back to the menu, on the menu it is
        // GAME START.
        await until("the game's first stage", 60_000, async () => {
          const inStage = async () =>
            await byte(PLUS.state) === 34 && await byte(PLUS.lives) === 2;
          if (await inStage()) return true;
          if (await byte(PLUS.state) === 32) await press(cdp, 3, 350);
          await sleep(1500);
          return await inStage();
        }, 0);
        return base;
      },
      pilot: {
        lives: [PLUS.lives],
        fire: 1,
        pad: { up: 4, down: 5, left: 6, right: 7 },
        checkpointMs: 1500,
        rewindCheckpoints: 2,
        maxTries: 6,
        seed: 7,
        ship: {
          x: PLUS.shipX,
          y: PLUS.shipY,
          box: { x0: 40, x1: 216, y0: 110, y1: 200 },
        },
      },
    }, ctx);
  } finally {
    await site.close();
  }
};

/**
 * The donor build:ddd lays the rush onto: the 64DD prototype data disk
 * (deza1.NDD), an image of 64DD size in dev-fixtures/ or a folder under it,
 * judged by size as build:ddd judges it. A disk built from nothing has no
 * boot program and no RAM area, and the cartridge does not go into disk mode
 * on it.
 */
async function findDdDonor(): Promise<string | null> {
  const root = join(ROOT, "dev-fixtures");
  const top = await findDonorDisk(root);
  if (top) return top;
  try {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      const hit = await findDonorDisk(join(root, e.name));
      if (hit) return hit;
    }
  } catch { /* no dev-fixtures/ */ }
  return null;
}

/**
 * Dezaemon 3D on the 64DD: the rush laid onto the prototype data disk as a
 * project (build:ddd), beside the English cartridge (lib/dezaemon-n64.ts) and
 * the IPL, in the launcher's player (static/n64dd/play.html) — served with the
 * three files from here, a 64 MB disk being more than one DevTools message
 * should carry. Power-on → the title's flight and then its logo title (START
 * on each) → the root menu's GAME → GAME SELECT → the project's row → its
 * title → A is GAME START, each step read off RDRAM (lib/parity-n64dd.ts),
 * never timed. Lives are u8 0x8023648D, the ship s16s at 0x80237050/54; the
 * analog stick flies it (the d-pad does not), N64 A fires.
 */
const runN64dd: PaneRunner = async (ctx) => {
  const blocked = (reason: string): PaneResult => ({
    id: "n64dd",
    status: "blocked",
    reason,
  });
  const found = await findDezaemonN64(ROOT, {
    extra: [
      Deno.env.get("DEZAEMON_N64_ROM") ?? "",
      Deno.env.get("N64DD_IPL") ?? "",
    ].filter(Boolean),
  });
  if (!found.rom || found.rom.edition === "unknown") {
    return blocked(
      "no Dezaemon 3D cartridge the translation takes in dev-fixtures/ (or $DEZAEMON_N64_ROM)",
    );
  }
  if (!found.ipl) {
    return blocked("no 64DD IPL in dev-fixtures/ (or $N64DD_IPL)");
  }
  const donor = await findDdDonor();
  if (!donor) {
    return blocked("no 64DD prototype disk (deza1.NDD) in dev-fixtures/");
  }
  const disk = await buildDdd({
    level: join(OUT, "rush.json"),
    disk: donor,
    out: join(OUT, "n64dd", "rush.ndd"),
    log: (m) => log(`  ${m}`),
  });
  // GAME SELECT lists DST, the donor's RAM-area project, then the pressed
  // projects in directory order.
  const pressed = (disk.report.projects as { name: string }[]).map((p) =>
    p.name
  );
  const row = 1 + pressed.indexOf(disk.name);
  if (row < 1 || row > 3) {
    throw new Error(
      `${disk.name} would be GAME SELECT's row ${row}, past the four it shows`,
    );
  }
  const rom = await readDezaemonN64Rom(found.rom, { root: ROOT });
  const needle = rdramNeedle(rom);
  const site = serveFiles({
    "/play.html": {
      body: await Deno.readTextFile(
        join(ROOT, "static", "n64dd", "play.html"),
      ),
      type: "text/html; charset=utf-8",
    },
    "/rom.z64": { body: rom, type: "application/octet-stream" },
    "/ipl.n64": {
      body: await readN64ddIpl(found.ipl),
      type: "application/octet-stream",
    },
    "/disk.ndd": {
      body: await Deno.readFile(disk.outPath),
      type: "application/octet-stream",
    },
  }, Number(flags["serve-port"]) + 3);
  const url =
    `${site.origin}/play.html?rom=/rom.z64&ipl=/ipl.n64&disk=/disk.ndd`;
  const cdp = ctx.rig.cdp;
  const dd = <T>(expr: string) => cdp.eval<T>(expr);
  const rdram = (a: number) => a & 0x7fffff;
  const target = listRow(row);
  const boot = async (): Promise<number> => {
    await until("the mupen64plus-next core", 120_000, () =>
      dd<boolean>(
        `!!(window.EJS_emulator && EJS_emulator.gameManager && EJS_emulator.started)`,
      ), 500);
    await dd(n64ddRam(needle));
    const { base } = await until(
      "RDRAM in the core's heap",
      60_000,
      async () => {
        const at = await dd<number>(`__dd.find()`);
        return at >= 0 ? { base: at } : null;
      },
      500,
    );
    // Nothing takes a press before the title, whose clock starts from 0
    // there: run to it fast.
    await dd(
      `(function () { var gm = EJS_emulator.gameManager; gm.setFastForwardRatio(0); gm.toggleFastForward(1); return true; })()`,
    );
    try {
      await until(
        "the title",
        120_000,
        () => dd<boolean>(`__dd.clock() >= 60`),
        100,
      );
    } finally {
      await dd(`EJS_emulator.gameManager.toggleFastForward(0), true`);
    }
    // START on the title's flight, then on the logo title it leads to, until
    // the root menu's pointer rests on GAME — and never on the root menu
    // itself, where START leads into the editor. The flight takes no press
    // in its first two seconds, and at 920 on its clock it gives way to the
    // editor's demo, so a boot that has not reached the logo title by then is
    // powered on again.
    await until("the root menu", 60_000, async () => {
      if (await dd<number>(`__dd.clock()`) >= 900) {
        throw new Abort("the title ran into its demo before it took START");
      }
      return await dd<boolean>(
        `__dd.step(3, __dd.title, __dd.rootMenu, 1500)`,
      );
    }, 0);
    // GAME: A while the pointer rests on it, until the page is GAME SELECT.
    await until("GAME SELECT", 60_000, () =>
      dd<boolean>(
        `__dd.step(0, __dd.rootMenu, function () { return __dd.menu() === 15; }, 3000)`,
      ), 0);
    // The project's row: the pointer flown there until the item under it is
    // that row — which also waits out GAME SELECT's settling, as the item
    // under a pointer that has not moved can stay what it was — then A,
    // until GAME SELECT is gone.
    // GAME SELECT can also come up without its list and never move its
    // pointer: two steers that leave it where it was are a power-on again.
    let unmoved = 0;
    await until(`GAME SELECT's row ${row}`, 60_000, async () => {
      if (await dd<number>(`__dd.menu()`) !== 15) return true;
      const from = await dd<{ x: number; y: number }>(`__dd.pointer()`);
      const at = await dd<{ x: number; y: number; item: number }>(
        `__dd.steer(${target.x}, ${target.y}, ${target.item}, 6000)`,
      );
      if (at.item !== target.item) {
        if (at.x === from.x && at.y === from.y && ++unmoved >= 2) {
          throw new Abort("GAME SELECT came up without its list");
        }
        return false;
      }
      return await dd<boolean>(
        `__dd.step(0, function () { return __dd.menu() === 15 && __dd.item() === ${target.item}; }, function () { return __dd.menu() !== 15; }, 3000)`,
      );
    }, 0);
    log(`n64dd: ${disk.name} picked from GAME SELECT; loading it`);
    // The project's title: A is GAME START — its cursor starts there, and A
    // on the high-score page is GAME START too — pressed until the clock
    // starts again from 0: the stage.
    const frozen = await dd<number>(`__dd.clock()`);
    await until("the project's first stage", 120_000, () =>
      dd<boolean>(
        `__dd.step(0, function () { return __dd.menu() === 2; }, function () { var c = __dd.clock(); return c !== ${frozen} && c < 30; }, 1500)`,
      ), 0);
    return base;
  };
  try {
    return await runEmuPane({
      id: "n64dd",
      url,
      scripts: [N64DD_BARE],
      // A press the menus did not take leaves them somewhere no further
      // press is safe from: a fresh power-on is the remedy.
      boot: async () => {
        for (let power = 1;; power++) {
          try {
            return await boot();
          } catch (e) {
            const where = await dd<string>(
              `window.__dd && __dd.base >= 0 ? "page " + __dd.menu() + ", item " + __dd.item() + ", clock " + __dd.clock() : "RDRAM not found"`,
            ).catch(() => "no page");
            const why = `${e instanceof Error ? e.message : e} (${where})`;
            if (power >= 3) throw new Error(why);
            log(`n64dd: ${why}; powering on again`);
            await cdp.send("Page.navigate", { url });
          }
        }
      },
      pilot: {
        longSwap: true,
        lives: [rdram(N64DD.lives)],
        fire: 0,
        pad: { up: 19, down: 18, left: 17, right: 16 },
        padValue: 0x7fff,
        checkpointMs: 1500,
        rewindCheckpoints: 2,
        maxTries: 6,
        seed: 7,
        // y 173, where the ship starts, is as low as it goes.
        ship: {
          x: rdram(N64DD.shipX),
          y: rdram(N64DD.shipY),
          signed: true,
          box: { x0: -170, x1: 170, y0: 40, y1: 170 },
        },
      },
    }, ctx);
  } finally {
    await site.close();
  }
};

const RUNNERS: Record<PaneId, PaneRunner> = {
  web: runWeb,
  ps2: runPs2,
  sfc: runSfc,
  saturn: runSaturn,
  kids: runKids,
  plus: runPlus,
  n64dd: runN64dd,
};

// ── The grid ─────────────────────────────────────────────────────────────────

const FONTS = [
  "C:\\Windows\\Fonts\\consola.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
];

async function captionFont(): Promise<string | null> {
  for (const f of FONTS) if (await exists(f)) return f;
  return null;
}

function caption(r: PaneResult): string {
  const spec = PANES[r.id];
  const modes = r.modes?.length ? ` ${r.modes.join(" ")}` : "";
  if (r.status === "captured") return `${spec.label}${modes}`;
  return `${spec.label} - ${r.status === "blocked" ? "PENDING" : "FAILED"}`;
}

async function writeGrid(results: PaneResult[]) {
  // Only the panes with a clip: a pending or failed target is a caption over
  // black, which the report already says. With none captured, every caption
  // still goes in, so the grid says why it is empty.
  const shown = results.filter((r) => r.clip);
  const left = results.filter((r) => !r.clip).map((r) => PANES[r.id].label);
  if (shown.length && left.length) {
    log(`  left out of the grid (no clip): ${left.join(", ")}`);
  }
  const inputs: GridInput[] = (shown.length ? shown : results).map((r) => ({
    id: r.id,
    clip: r.clip ?? null,
    caption: caption(r),
    seconds: r.seconds ?? 0,
  }));
  const grid = join(OUT, "grid.mp4");
  const font = await captionFont();
  const opts = {
    cellW: 300,
    cellH: 320,
    captionH: 22,
    fps: FPS,
    font,
    out: grid,
  };
  log(`writing ${grid}…`);
  await ffmpeg(gridArgs(inputs, opts));
  const gif = join(OUT, "parity.gif");
  // Decimal megabytes: under 5 MB is under 5,000,000 bytes by either count.
  const budget = Number(flags["max-mb"]) > 0
    ? Number(flags["max-mb"]) * 1e6
    : Infinity;
  let bytes = Infinity;
  let used = { fps: Number(flags["gif-fps"]), scale: 1 };
  for (const rung of gifLadder(Number(flags["gif-fps"]))) {
    used = rung;
    await ffmpeg(gridGifArgs(grid, rung.fps, rung.scale, gif));
    bytes = (await Deno.stat(gif)).size;
    log(
      `  parity.gif at ${rung.fps} fps, scale ${rung.scale}: ${
        (bytes / 1e6).toFixed(2)
      } MB`,
    );
    if (bytes <= budget) break;
  }
  return { grid, gif, bytes, ...used, overBudget: bytes > budget };
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (flags["survey-report"] !== undefined) {
  const dir = String(flags["survey-report"]).trim();
  if (!dir) {
    console.error("error: --survey-report needs an earlier run's out dir");
    Deno.exit(2);
  }
  Deno.exit(await surveyReportOnly(resolve(dir)));
}
if (!await hasCommand("ffmpeg", ["-version"])) {
  console.error("error: ffmpeg is not on PATH — it cuts the clips and the GIF");
  Deno.exit(2);
}
const targets = parseTargets(flags.targets);
await ensureDir(OUT);
const previousReport = await Deno.readTextFile(join(OUT, "report.json"))
  .then((t) => JSON.parse(t) as { panes?: PaneResult[] })
  .catch(() => null);
const record = await loadRecord();
const bossKey = `boss${STAGE}`;
const boss = record.bossData?.[bossKey];
if (!boss) throw new Error(`${LEVEL} has no ${bossKey}`);
const kinds = projectileKinds(boss);
log(
  `${LEVEL}: ${bossKey} "${boss.name ?? bossKey}", ${
    Object.keys(kinds).length
  } projectile kinds: ${
    Object.entries(kinds).map(([k, f]) => `${k}=${f.join("/")}`).join(", ")
  }`,
);
// Under --full the "rush" is the whole game: the file every exporter builds
// from keeps its name, so the panes need not know which they were given.
const rush = structuredClone(record);
const summary = FULL ? null : bossRushRecord(rush, { startStage: STAGE });
if (summary) log(describeBossRush(summary));
else {
  log(
    `full game: ${
      Object.keys(record.stages ?? {}).filter((k) => /^stage\d+$/.test(k))
        .length || 1
    } stage(s); every pane plays the first from its start` +
      (STAGE ? `, the web pane stage ${STAGE}` : ""),
  );
}
await Deno.writeTextFile(join(OUT, "rush.json"), JSON.stringify(rush));

const ran = new Map<PaneId, PaneResult>();
// `--targets none` captures nothing, so neither vite nor Chrome is started.
const rig = targets.length
  ? await Rig.start({
    origin: flags.origin,
    servePort: Number(flags["serve-port"]),
    cdpPort: Number(flags["cdp-port"]),
    chrome: flags.chrome ?? null,
    headed: flags.headed,
    viewport: { width: PANES.web.width, height: PANES.web.height },
    profileName: "parity",
    log,
  })
  : null;
try {
  for (const id of targets) {
    log(`\n── ${PANES[id].label} ──`);
    try {
      const r = await RUNNERS[id]({ rig: rig!, record, rush, kinds });
      log(`${id}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
      ran.set(id, r);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log(`${id}: failed — ${reason}`);
      ran.set(id, { id, status: "failed", reason });
    }
  }
} finally {
  await rig?.close();
}

// Every pane has a cell, in grid order: this run's, else — with --reuse — the
// capture an earlier run left (its clip still on disk), else "not run".
const reuse = new Set<PaneId>(
  !flags.reuse
    ? []
    : flags.reuse === "all"
    ? PANE_IDS
    : parseTargets(flags.reuse),
);
const earlier = new Map<PaneId, PaneResult>(
  (previousReport?.panes ?? []).map((p) => [p.id, p]),
);
const results: PaneResult[] = [];
for (const id of PANE_IDS) {
  const mine = ran.get(id);
  const old = earlier.get(id);
  if (mine) results.push(mine);
  else if (
    reuse.has(id) && old?.status === "captured" && old.clip &&
    await exists(old.clip)
  ) {
    log(`${id}: reusing the earlier capture (${old.clip})`);
    results.push(old);
  } else {
    results.push(
      old && !targets.includes(id) && old.status !== "captured"
        ? old
        : { id, status: "blocked", reason: "not run this time" },
    );
  }
}

const gif = results.some((r) => r.clip) ? await writeGrid(results) : null;
// Under --full, with a Saturn and a web survey (this run's, or a reused
// pane's by its report.json entry — never a stale file in the out dir), the
// two are set against each other as report-survey.md. The Saturn pane plays
// the cart's stage 0, so a web pane on another stage has nothing to meet.
const surveyFileOf = (id: PaneId): string | null => {
  const t = results.find((r) => r.id === id)?.telemetry;
  return t && typeof t.surveyFile === "string" ? t.surveyFile : null;
};
if (FULL && STAGE !== 0) {
  log(`survey report: skipped — the Saturn plays stage 0, the web stage ${STAGE}`);
}
const survey = FULL && STAGE === 0
  ? await writeSurveyReport(OUT, rush as RushRecord, {
    saturn: surveyFileOf("saturn"),
    web: surveyFileOf("web"),
  })
  : null;
const report = {
  level: LEVEL,
  source: SAV ? { cart: SAV, slot: SAV_SLOT } : { cloud: LEVEL },
  mode: FULL ? "full" : "boss rush",
  stage: STAGE,
  boss: boss.name ?? bossKey,
  fromHp: Number(flags["from-hp"]),
  kinds,
  bossRush: summary,
  panes: results,
  grid: gif,
  survey,
};
await Deno.writeTextFile(
  join(OUT, "report.json"),
  JSON.stringify(report, null, 2),
);
log(`\n${join(OUT, "report.json")}`);
for (const r of results) {
  log(
    `  ${PANES[r.id].label.padEnd(14)} ${r.status}${
      r.reason ? ` — ${r.reason}` : ""
    }${r.seconds ? ` (${r.seconds.toFixed(1)} s)` : ""}`,
  );
}
if (gif) {
  log(
    `  ${gif.gif} (${
      (gif.bytes / 1e6).toFixed(2)
    } MB, ${gif.fps} fps, scale ${gif.scale}${
      gif.overBudget ? ", OVER BUDGET" : ""
    })`,
  );
}
if (survey) {
  log(`  ${survey.file} (${survey.ok ? "PASS" : "FAIL"})`);
  // Last, with every artifact written: a failing survey verdict fails the run.
  if (!survey.ok) Deno.exit(1);
}
