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
 *   deno task testdrive:parity gs
 *   deno task testdrive:parity gs -- --targets web,sfc --headed
 *   deno task testdrive:parity gs -- --from-hp 0.6 --max-mb 0
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

const ROOT = repoRoot();

const HELP = `deno task testdrive:parity "<level>" [-- flags]

Plays the level's boss on every target side by side, a tool-assisted pilot
fighting it, and records the boss from --from-hp of its bar through its second
stage into build/testdrive/parity/<slug>/ (parity.gif, grid.mp4, panes/,
report.json).

  <level>            a cloud level's name (default: gs)
  --targets <list>   web,ps2,sfc,saturn,kids,plus,n64dd, all (default), or
                     none — with --reuse, only the grid and the GIF again
  --stage <n>        the stage whose boss is recorded, 0-based (default: 1)
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
  --help`;

const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["headed", "keep-frames", "help"],
  string: ["targets", "origin", "chrome", "out", "reuse"],
  default: {
    stage: 1,
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
  },
});

if (flags.help) {
  console.log(HELP);
  Deno.exit(0);
}

const log: Log = (line) => console.log(line);
const LEVEL = String(flags._[0] ?? "gs");
const slug =
  LEVEL.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
  "level";
const OUT = resolve(
  flags.out ?? join(ROOT, "build", "testdrive", "parity", slug),
);
const STAGE = Number(flags.stage);
const FPS = Number(flags.fps);

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
 * The web runtime: 2028.Ai's own page with the rush served as its foo.json,
 * booted by the cheat URL straight into the first stage.
 */
const runWeb: PaneRunner = async (ctx) => {
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
    bossRush: STAGE,
    skipAudio: true,
    log: (m) => log(`  ${m.trim()}`),
  });
  if (!built.appDir) throw new Error("the PS2 build wrote no app folder");
  const webDir = join(OUT, "ps2-web");
  await writeWebBuild(built.appDir, webDir, { title: `${LEVEL} boss rush` });
  const site = serveFolder(webDir, Number(flags["serve-port"]) + 2);
  try {
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

const pending = (id: PaneId, reason: string): PaneRunner => () =>
  Promise.resolve({ id, status: "blocked", reason });

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
        if (e.isFile && test(e.name)) return path;
        if (e.isDirectory && depth > 0) {
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
  files: Record<string, { body: Uint8Array | string; type: string }>;
  /** From the loaded page to the stage's first frame; answers the RAM's heap offset. */
  boot: (cdp: Cdp) => Promise<number>;
  pilot: Omit<EmuPilotConfig, "ramBase">;
}

async function runEmuPane(
  pane: EmuPane,
  ctx: PaneContext,
): Promise<PaneResult> {
  const spec = PANES[pane.id];
  const cdp = ctx.rig.cdp;
  await setViewport(cdp, spec.width, spec.height);
  const served = await interceptFiles(cdp, pane.files);
  const unscript = await onNewDocument(cdp, [EJS_BARE]);
  const want = Number(flags["console-seconds"]) * 1000;
  const cap = Number(flags["console-wall"]) * 1000;
  try {
    await cdp.send("Page.navigate", { url: pane.url });
    const ramBase = await pane.boot(cdp);
    log(`${pane.id}: in the stage; its RAM is at heap ${ramBase}`);
    await cdp.eval(emuPilot({ ...pane.pilot, ramBase }));
    const cast = await screencast(cdp, join(OUT, "frames", pane.id), spec);
    await cdp.eval(`window.__emu.on = true`);
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
    return {
      id: pane.id,
      status: "captured",
      clip,
      seconds: picked.length / FPS,
      telemetry: {
        window: `the stage's first ${
          (Math.min(keptMs, want) / 1000).toFixed(1)
        } s of surviving play`,
        deathsCut: st.deaths,
        keptSpans: kept.length,
        wallSeconds: Math.round((Date.now() - t0) / 1000),
        reachedWanted: keptMs >= want,
      },
      modes: [],
    };
  } finally {
    await unscript();
    await served.stop();
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

const RUNNERS: Record<PaneId, PaneRunner> = {
  web: runWeb,
  ps2: runPs2,
  sfc: runSfc,
  saturn: pending(
    "saturn",
    "the Saturn pane needs the game injected into the disc (disc:inject), not in this checkout yet",
  ),
  kids: pending("kids", "the Kids! pane's boot is not written yet"),
  plus: pending("plus", "the Dezaemon+ pane's boot is not written yet"),
  n64dd: pending("n64dd", "the 64DD pane's boot is not written yet"),
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
const rush = structuredClone(record);
const summary = bossRushRecord(rush, { startStage: STAGE });
log(describeBossRush(summary));
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
const report = {
  level: LEVEL,
  stage: STAGE,
  boss: boss.name ?? bossKey,
  fromHp: Number(flags["from-hp"]),
  kinds,
  bossRush: summary,
  panes: results,
  grid: gif,
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
