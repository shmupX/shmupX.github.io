#!/usr/bin/env -S deno run -A
/**
 * `deno task refresh:compare` — the game at a display's full refresh rate,
 * side by side with the stock game, on an emulated high-refresh monitor.
 *
 * The game's logic steps at a fixed 120 Hz and Phaser draws once per display
 * frame. On a 240 Hz monitor the stock game therefore draws each step twice:
 * whatever the steps move stands still on every second frame. With
 * `?refresh=` at `max` (or `auto`, the default, once the display outruns the
 * logic) the runtime draws step-driven motion where it would be at each
 * frame's moment instead (refreshApply in game.bundle.js). This task proves
 * that and records it.
 *
 *   deno task refresh:compare                      # 240 Hz, record + report
 *   deno task refresh:compare -- --hz 144          # any display rate
 *   deno task refresh:compare -- --check --no-video   # the assertions only
 *
 * ── How the monitor is emulated ──────────────────────────────────────────
 *
 * No real display is involved. The debug probe (scripts/lib/game-debug.ts)
 * takes over requestAnimationFrame before the bundle boots, and its clock
 * advances 1000/hz ms per frame, so the game sees exactly the frame timing a
 * monitor at that rate would give it, however long each frame takes to
 * capture. Date.now() follows the same clock (Phaser times tweens by it), and
 * the stage is entered on the pad from inside the page, with Math.random
 * reseeded the moment the stage scene starts — so a run is the same run every
 * time, frame for frame.
 *
 * ── Why one game, drawn twice ────────────────────────────────────────────
 *
 * The two halves are the SAME simulation. The page runs as players get it
 * (`?refresh=` unset, so auto, which blends at this rate; `--mode max`
 * forces it). After each frame is drawn (the right half), the positions
 * refreshApply blended are put back to the logic's own, the scene is drawn
 * again (the left half: exactly what the stock game draws for that state,
 * since stock draws the logic positions), and the blended positions are
 * restored for the next frame. Every difference between the halves is the
 * refresh handling and nothing else. The extra draw runs on its own random
 * stream, so it cannot move the game's.
 *
 * ── Does it play the same? ───────────────────────────────────────────────
 *
 * Max refresh is only allowed to change what is drawn. So the same seed is
 * then played again with `?refresh=stock`, and every object's logic position
 * has to match the first run's on every frame (`--no-stock-run` skips it).
 *
 * ── What it measures ─────────────────────────────────────────────────────
 *
 * For every object the fixed step is moving, frame by frame, in each half:
 *
 *   moved      the share of frames on which it was drawn somewhere new
 *              (stock at 240 Hz: about half; max: all of them)
 *   drawnHz    moved × the display rate: how often motion is drawn
 *   evenness   1 when each frame moves it as far as the last (smooth), 0 when
 *              frames alternate between no move and a double move (judder)
 *
 * and, for the pixels, the share of frames that differ from the one before.
 * `--check` turns the first three, and the stock run's match, into
 * assertions and the exit code.
 *
 * Output (build/refresh-compare by default):
 *   compare-<hz>fps.mp4       real time, one video frame per display frame —
 *                             play it on a monitor at that rate to see it
 *   compare-slowmo-<n>x.mp4   the same frames at 60 fps, n times slower, so
 *                             the difference shows on any screen
 *   metrics.json              the numbers above
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  Cdp,
  findChrome,
  startServer,
} from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import { PROBE } from "./lib/game-debug.ts";

/**
 * One tracked object on one frame: [id, drawnX, drawnY, logicX, logicY,
 * what it shows]. On a stock page the drawn and logic positions are one.
 */
export type ObjectSample = [string, number, number, number, number, string];

export interface FrameRecord {
  frame: number;
  scene: string | null;
  on: boolean;
  objs: ObjectSample[];
  /** Whether each half's pixels differ from its previous frame: [stock, max]. */
  changed?: [boolean, boolean];
}

export interface ViewCadence {
  /** Frames on which a moving object was drawn somewhere new, as a share. */
  moved: number;
  /** moved × hz: how many times a second its motion is drawn. */
  drawnHz: number;
  /** 1 = every frame moves it as far as the last; 0 = 0/2× alternation. */
  evenness: number;
  /** Share of frames whose pixels differ from the frame before. */
  pixelsChanged: number;
  samples: number;
}

/**
 * How often each half draws motion. An object counts on a frame when the
 * LOGIC moved it over the last two frames (so it is in motion, whatever the
 * step cadence) and it was on both neighbouring frames; the half's own
 * positions then say whether it was drawn somewhere new, and how evenly.
 */
export function cadence(
  frames: FrameRecord[],
  hz: number,
): { stock: ViewCadence; max: ViewCadence } {
  const view = (pick: 0 | 1): ViewCadence => {
    // pick 0 = stock (logic positions), 1 = max (drawn positions)
    const pos = (o: ObjectSample): [number, number] =>
      pick === 1 ? [o[1], o[2]] : [o[3], o[4]];
    const travel = (from: ObjectSample, to: ObjectSample) => {
      const [x0, y0] = pos(from), [x1, y1] = pos(to);
      return Math.hypot(x1 - x0, y1 - y0);
    };
    let samples = 0, moved = 0, evenSum = 0, evenN = 0;
    for (let t = 2; t < frames.length; t++) {
      const a = new Map(frames[t - 2].objs.map((o) => [o[0], o]));
      const b = new Map(frames[t - 1].objs.map((o) => [o[0], o]));
      for (const o of frames[t].objs) {
        const p = b.get(o[0]);
        const q = a.get(o[0]);
        if (!p || !q) continue;
        // In motion by the logic's own account, over a full step at most.
        const logicTravel = Math.hypot(o[3] - q[3], o[4] - q[4]);
        if (logicTravel === 0 || logicTravel > 48) continue;
        const d1 = travel(p, o);
        const d0 = travel(q, p);
        samples++;
        if (d1 > 1e-6) moved++;
        const hi = Math.max(d0, d1);
        if (hi > 1e-6) {
          evenSum += Math.min(d0, d1) / hi;
          evenN++;
        }
      }
    }
    const share = samples ? moved / samples : 0;
    const changed = frames.length > 1
      ? frames.slice(1).filter((f) => f.changed?.[pick]).length /
        (frames.length - 1)
      : 0;
    return {
      moved: share,
      drawnHz: share * hz,
      evenness: evenN ? evenSum / evenN : 0,
      pixelsChanged: changed,
      samples,
    };
  };
  return { stock: view(0), max: view(1) };
}

/** The assertions `--check` makes, as messages; empty means it passed. */
export function judge(
  c: { stock: ViewCadence; max: ViewCadence },
  hz: number,
): string[] {
  const out: string[] = [];
  if (c.max.samples < 200) {
    out.push(`only ${c.max.samples} moving-object samples; nothing to judge`);
    return out;
  }
  // The stock half is the control: it proves the display really is outrunning
  // the 120 Hz logic, or the max half's numbers would mean nothing.
  if (hz > 130 && c.stock.moved > 0.75) {
    out.push(
      `stock drew motion on ${pct(c.stock.moved)} of frames at ${hz} Hz; ` +
        `the display is not outrunning the logic, so this proves nothing`,
    );
  }
  if (c.max.moved < 0.9) {
    out.push(
      `max refresh drew motion on only ${pct(c.max.moved)} of frames ` +
        `(${c.max.drawnHz.toFixed(0)} of ${hz} per second)`,
    );
  }
  if (c.max.evenness < 0.75) {
    out.push(
      `max refresh motion is uneven frame to frame (evenness ` +
        `${c.max.evenness.toFixed(2)}, stock ${c.stock.evenness.toFixed(2)})`,
    );
  }
  return out;
}

/**
 * Where a stock run and a max-refresh run of the same seed first part ways,
 * by the logic's own positions; null when every frame agrees. Max refresh
 * only moves what is drawn, so they never should.
 */
export function firstDivergence(
  max: FrameRecord[],
  stock: FrameRecord[],
): string | null {
  if (max.length !== stock.length) {
    return `${max.length} frames against ${stock.length}`;
  }
  for (let i = 0; i < max.length; i++) {
    const a = max[i].objs, b = stock[i].objs;
    if (a.length !== b.length) {
      return `frame ${i}: ${a.length} objects under max refresh, ` +
        `${b.length} stock`;
    }
    for (let j = 0; j < a.length; j++) {
      const [ida, , , ax, ay, wa] = a[j];
      const [idb, , , bx, by, wb] = b[j];
      if (ida !== idb || ax !== bx || ay !== by || wa !== wb) {
        return `frame ${i}: ${wa} #${ida} at (${ax}, ${ay}) under max ` +
          `refresh, ${wb} #${idb} at (${bx}, ${by}) stock`;
      }
    }
  }
  return null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * The in-page half: seeds Math.random, parks the probe's clock at the
 * display rate, and defines __rfFrame(level), which steps one display frame
 * and reports on it — level 0 nothing, 1 every object's drawn and logic
 * positions, 2 that plus both halves composited.
 */
export function pageSetup(hz: number, seed: number): string {
  return `
(function () {
  function prng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Math.random = prng(${seed});
  var dbg = window.__dbg;
  dbg.paused = true;
  // The emulated display's clock, exact in binary: a whole-millisecond start
  // and 1000/hz rounded up to 2^-10 ms (240 Hz becomes 239.98). Phaser takes
  // each frame's delta as this time minus the last; with an arbitrary start
  // that subtraction rounds differently on every run, and a timer due on
  // exactly a frame boundary (the stage card's 2500 ms is frame 600 at
  // 240 Hz) lands a frame early on some runs and on time on others.
  dbg.t = Math.round(dbg.t);
  dbg.dt = Math.ceil((1000 / ${hz}) * 1024) / 1024;
  // Phaser's tweens are timed by Date.now(), not by the frame's delta, so the
  // wall clock has to be the display's too: otherwise every tween runs at the
  // speed this page happens to be stepped at. Epoch plus display time stays
  // exact at 2^-10 ms granularity until the year 2248.
  var epoch = Math.round(Date.now() - dbg.t);
  Date.now = function () { return epoch + dbg.t; };
  var c = window.__rfCompare = {
    hz: ${hz}, ids: new WeakMap(), next: 1, side: prng(${seed} ^ 0x5bd1e995),
    canvas: null, ctx: null, scratch: null, prev: [null, null],
    drive: false, driveFrame: 0, hooked: false, stage: null,
    // The ship sweeps side to side on the pad once the stage is up, so the
    // player's own motion is in the comparison too, not only the waves'.
    sweep: false, sweepFrame: 0,
  };
  // Into the stage. While driving, START is tapped on the pad four times a
  // second, which steps through the title and the story. Everything after is
  // timed from the stage scene's own start, not from when the harness saw it:
  // the random stream is reseeded the moment the scene starts (before its
  // create), START comes up, and stage frames are counted from its create.
  // The handoff runs on a real-time setTimeout, so this is what lets two runs
  // line up frame for frame.
  var BTN_START = 9;
  window.__rfDrive = function () { c.drive = true; c.driveFrame = 0; };
  function hookStage(g) {
    if (c.hooked) return;
    var gs = g.scene.getScene("PhaserGameScene");
    if (!gs) return;
    c.hooked = true;
    gs.events.on("start", function () {
      if (!c.drive) return;
      c.drive = false;
      dbg.setButtons([BTN_START], false);
      Math.random = prng(${seed});
    });
    gs.events.on("create", function () {
      if (c.stage !== null) return;
      c.stage = 0;
      c.sweep = true;
      c.sweepFrame = 0;
    });
  }
  function idOf(o) {
    var id = c.ids.get(o);
    if (!id) { id = String(c.next++); c.ids.set(o, id); }
    return id;
  }
  function steppedScene(g) {
    var keys = ["PhaserGameScene", "PhaserTitleScene"];
    for (var i = 0; i < keys.length; i++) {
      var s = g.scene.getScene(keys[i]);
      if (s && s.sys.settings.active) return s;
    }
    return null;
  }
  function differs(a, b) {
    if (!b) return true;
    for (var i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return true;
    }
    return false;
  }
  window.__rfFrame = function (level) {
    if (c.drive) {
      var beat = c.driveFrame++ % Math.round(c.hz / 4);
      if (beat === 0) dbg.setButtons([BTN_START], true);
      if (beat === 3) dbg.setButtons([BTN_START], false);
    }
    if (c.sweep) {
      var leg = Math.floor(c.sweepFrame++ / Math.round(c.hz * 0.6));
      dbg.setAxes([leg % 2 ? -1 : 1, 0]);
    }
    dbg.stepOnce();
    if (c.stage !== null) c.stage++;
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.canvas) return { frame: dbg.frame, scene: null, stage: null };
    hookStage(g);
    var scene = steppedScene(g);
    var ri = scene && scene._refresh;
    var key = scene ? scene.sys.settings.key : null;
    var on = !!(ri && ri.on);
    if (!level) return { frame: dbg.frame, scene: key, on: on, stage: c.stage };
    // What the blend moved, and where the logic has it.
    var d = ri ? ri.drawn : [];
    var logic = new Map(), tiles = new Map();
    for (var i = 0; i < d.length; i += 6) {
      (d[i + 1] ? tiles : logic).set(d[i], [d[i + 2], d[i + 3]]);
    }
    var objs = [];
    var list = scene ? scene.children.list : [];
    for (var j = 0; j < list.length; j++) {
      var o = list[j];
      if (!o.visible || typeof o.x !== "number") continue;
      var id = idOf(o);
      var l = logic.get(o);
      var what = (o.texture ? o.texture.key : o.type) +
        (o.frame && o.frame.name != null ? ":" + o.frame.name : "");
      objs.push([id, o.x, o.y, l ? l[0] : o.x, l ? l[1] : o.y, what]);
      if (typeof o.tilePositionX === "number") {
        var lt = tiles.get(o);
        objs.push(["t" + id, o.tilePositionX, o.tilePositionY,
          lt ? lt[0] : o.tilePositionX, lt ? lt[1] : o.tilePositionY, what + " (tile)"]);
      }
    }
    var gc = g.canvas, W = gc.width, H = gc.height, HEAD = 46, GAP = 8;
    if (level === 1) {
      return { frame: dbg.frame, scene: key, on: on, stage: c.stage, objs: objs };
    }
    if (!c.canvas) {
      c.canvas = document.createElement("canvas");
      c.canvas.width = W * 2 + GAP;
      c.canvas.height = H + HEAD;
      c.ctx = c.canvas.getContext("2d", { willReadFrequently: true });
      c.ctx.imageSmoothingEnabled = false;
    }
    var ctx = c.ctx;
    // The right half: this frame as max refresh drew it.
    ctx.drawImage(gc, W + GAP, HEAD);
    // The left half: the same state drawn the stock way, at the logic's
    // positions, on a random stream of its own.
    function put(which) {
      for (var k = 0; k < d.length; k += 6) {
        var ob = d[k], vx = d[k + which], vy = d[k + which + 1];
        if (d[k + 1]) { ob.tilePositionX = vx; ob.tilePositionY = vy; }
        else { ob.x = vx; ob.y = vy; }
      }
    }
    put(2);
    var r = g.renderer, rand = Math.random;
    Math.random = c.side;
    try { r.preRender(); g.scene.render(r); r.postRender(); }
    finally { Math.random = rand; }
    ctx.drawImage(gc, 0, HEAD);
    put(4);
    var halves = [ctx.getImageData(0, HEAD, W, H).data, ctx.getImageData(W + GAP, HEAD, W, H).data];
    var changed = [differs(halves[0], c.prev[0]), differs(halves[1], c.prev[1])];
    c.prev = halves;
    // Labels.
    ctx.fillStyle = "#101018";
    ctx.fillRect(0, 0, c.canvas.width, HEAD);
    ctx.fillRect(W, HEAD, GAP, H);
    ctx.textBaseline = "top";
    var hz = c.hz;
    var label = function (x, title, line, color) {
      ctx.fillStyle = color;
      ctx.font = "bold 15px sans-serif";
      ctx.fillText(title, x + 6, 5);
      ctx.fillStyle = "#c8c8d8";
      ctx.font = "11px sans-serif";
      ctx.fillText(line, x + 6, 26);
    };
    label(0, "STOCK", "each 120 Hz step drawn " + (hz / 120).toFixed(1) + "x", "#ffb000");
    label(W + GAP, "MAX REFRESH", "motion drawn every " + hz + " Hz frame", "#38e070");
    ctx.fillStyle = "#6a6a80";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText(hz + " Hz  f" + dbg.frame, c.canvas.width - 6, 8);
    ctx.textAlign = "left";
    return {
      frame: dbg.frame, scene: key, on: on, stage: c.stage, objs: objs, changed: changed,
      png: c.canvas.toDataURL("image/png"),
    };
  };
  return "ok";
})();
`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function attach(port: number): Promise<Cdp> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`))
        .json() as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === "page");
      if (page) return await Cdp.connect(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome never exposed a page over DevTools");
}

/** A video encoder fed PNG frames on stdin. */
function encoder(out: string, inputFps: number, outputFps: number) {
  const child = new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(inputFps),
      "-i",
      "-",
      "-vf",
      "scale=iw*2:ih*2:flags=neighbor",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "14",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(outputFps),
      "-movflags",
      "+faststart",
      out,
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  return {
    write: (png: Uint8Array) => writer.write(png),
    close: async () => {
      await writer.close();
      const status = await child.status;
      if (!status.success) throw new Error(`ffmpeg failed writing ${out}`);
    },
  };
}

function decodeDataUrl(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Step = {
  frame: number;
  scene: string | null;
  /** Frames since the stage scene's create; null before it. */
  stage: number | null;
  on?: boolean;
  objs?: ObjectSample[];
  changed?: [boolean, boolean];
  png?: string;
};

/** One emulated monitor: a headless Chrome on the game, paused in the stage. */
interface Session {
  /** Step one display frame, reporting at `level` (see pageSetup). */
  step(level?: 0 | 1 | 2): Promise<Step>;
  close(): Promise<void>;
}

/**
 * A browser on `url` with the probe in, driven through the title and the
 * story into the stage and `warmup` seconds into it, on a fresh random stream.
 */
async function openSession(
  { bin, url, hz, seed, warmup, log }: {
    bin: string;
    url: string;
    hz: number;
    seed: number;
    warmup: number;
    log: (line: string) => void;
  },
): Promise<Session> {
  const cdpPort = freePort();
  const profile = await Deno.makeTempDir({ prefix: "refresh-compare-" });
  const chrome = new Deno.Command(bin, {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=256,480",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let cdp: Cdp | null = null;
  const close = async () => {
    cdp?.close();
    try {
      chrome.kill("SIGKILL");
    } catch { /* gone */ }
    await chrome.status;
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  };
  try {
    cdp = await attach(cdpPort);
    const page = cdp;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: PROBE + ";\n" + pageSetup(hz, seed),
    });
    await page.send("Page.navigate", { url });
    const step = (level: 0 | 1 | 2 = 0) =>
      page.eval<Step>(`window.__rfFrame ? window.__rfFrame(${level}) : null`);

    // Boot: asset loads run on real time, so frames are given a little each.
    const bootBy = Date.now() + 120_000;
    let s: Step | null = null;
    while (Date.now() < bootBy) {
      s = await step();
      if (s?.scene === "PhaserTitleScene") break;
      await sleep(5);
    }
    if (s?.scene !== "PhaserTitleScene") {
      throw new Error(`the title never came up on ${url}`);
    }
    // Through the title and the story into the stage (see __rfDrive).
    await page.eval(`window.__rfDrive()`);
    const inBy = Date.now() + 180_000;
    while (Date.now() < inBy) {
      s = await step();
      if (s.stage !== null) break;
      await sleep(2);
    }
    if (s?.stage === null) throw new Error(`never reached the stage on ${url}`);
    // Far enough into the stage for the waves to be on screen.
    while (s!.stage! < warmup * hz) s = await step();
    log(`ok    ${url}: in the stage, ${warmup}s in`);
    return { step, close };
  } catch (e) {
    await close();
    throw e;
  }
}

async function main(): Promise<number> {
  const argv = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const args = parseArgs(argv, {
    boolean: ["check", "video", "stock-run", "help"],
    negatable: ["video", "stock-run"],
    string: [
      "hz",
      "seconds",
      "warmup",
      "slowmo",
      "seed",
      "out",
      "port",
      "chrome",
      "level",
      "mode",
    ],
    default: {
      hz: "240",
      seconds: "5",
      warmup: "6",
      mode: "auto",
      slowmo: "4",
      seed: "20281024",
      video: true,
      "stock-run": true,
    },
  });
  if (args.help) {
    console.log(
      "deno task refresh:compare [-- --hz 240 --seconds 5 --warmup 6 " +
        "--mode auto|max --slowmo 4 --check --no-video --no-stock-run --out DIR " +
        "--level foo.json --chrome BIN]",
    );
    return 0;
  }
  const hz = Number(args.hz);
  const seconds = Number(args.seconds);
  const warmup = Number(args.warmup);
  const slowmo = Number(args.slowmo);
  const seed = Number(args.seed);
  const mode = args.mode === "max" ? "max" : "auto";
  const outDir = args.out ?? join(repoRoot(), "build", "refresh-compare");
  await Deno.mkdir(outDir, { recursive: true });

  const levelPath = args.level ??
    join(repoRoot(), "static/games/2028-ai/foo.json");
  const record = JSON.parse(await Deno.readTextFile(levelPath));
  const server = startServer(record, { port: Number(args.port ?? freePort()) });
  const bin = await findChrome(args.chrome ?? null);
  const total = Math.round(seconds * hz);
  const log = (line: string) => console.log(line);
  console.log(`ok    emulating a ${hz} Hz display`);

  try {
    // The recorded run, under max refresh.
    const max: FrameRecord[] = [];
    const session = await openSession({
      bin,
      // auto is what players get: no parameter at all.
      url: `${server.url}/games/2028-ai${mode === "max" ? "?refresh=max" : ""}`,
      hz,
      seed,
      warmup,
      log,
    });
    try {
      const realtime = args.video
        ? encoder(join(outDir, `compare-${hz}fps.mp4`), hz, hz)
        : null;
      const slow = args.video && slowmo > 0
        ? encoder(
          join(outDir, `compare-slowmo-${slowmo}x.mp4`),
          hz / slowmo,
          60,
        )
        : null;
      for (let i = 0; i < total; i++) {
        const f = await session.step(2);
        if (!f.png || !f.objs) {
          throw new Error(`frame ${f.frame} captured nothing`);
        }
        if (!f.on) {
          throw new Error(
            `max refresh was off on frame ${f.frame}` +
              (mode === "auto"
                ? ` (auto only blends on a display faster than the 120 Hz ` +
                  `logic; --mode max forces it at ${hz} Hz)`
                : ""),
          );
        }
        max.push({
          frame: f.frame,
          scene: f.scene,
          on: true,
          objs: f.objs,
          changed: f.changed,
        });
        if (realtime || slow) {
          const png = decodeDataUrl(f.png);
          await realtime?.write(png);
          await slow?.write(png);
        }
      }
      await realtime?.close();
      await slow?.close();
    } finally {
      await session.close();
    }

    // The same seed again on the stock game: the logic has to match frame for
    // frame, or max refresh changed how the game plays.
    let divergence: string | null = null;
    if (args["stock-run"]) {
      const stock: FrameRecord[] = [];
      const twin = await openSession({
        bin,
        url: `${server.url}/games/2028-ai?refresh=stock`,
        hz,
        seed,
        warmup,
        log,
      });
      try {
        for (let i = 0; i < total; i++) {
          const f = await twin.step(1);
          if (!f.objs) throw new Error(`frame ${f.frame} captured nothing`);
          if (f.on) throw new Error(`refresh=stock blended frame ${f.frame}`);
          stock.push({
            frame: f.frame,
            scene: f.scene,
            on: false,
            objs: f.objs,
          });
        }
      } finally {
        await twin.close();
      }
      divergence = firstDivergence(max, stock);
    }

    const c = cadence(max, hz);
    const problems = judge(c, hz);
    if (divergence) {
      problems.push(
        `the game played differently under max refresh: ${divergence}`,
      );
    }
    await Deno.writeTextFile(
      join(outDir, "metrics.json"),
      JSON.stringify(
        {
          hz,
          seconds,
          warmup,
          seed,
          ...c,
          logicMatchesStock: args["stock-run"] ? divergence === null : null,
          problems,
        },
        null,
        2,
      ),
    );
    const row = (name: string, v: ViewCadence) =>
      `${name.padEnd(12)} motion drawn on ${pct(v.moved).padStart(6)} of ` +
      `frames (${v.drawnHz.toFixed(0).padStart(3)}/s), evenness ` +
      `${v.evenness.toFixed(2)}, pixels changed on ${pct(v.pixelsChanged)}`;
    console.log(row("stock", c.stock));
    console.log(row("max refresh", c.max));
    if (args["stock-run"]) {
      console.log(
        divergence
          ? `FAIL  the logic parted from the stock game's: ${divergence}`
          : `ok    the logic matched the stock game's on all ${total} frames`,
      );
    }
    if (args.video) console.log(`ok    recordings in ${outDir}`);
    if (args.check) {
      for (const p of problems) console.error(`FAIL  ${p}`);
      if (problems.length) return 1;
      console.log("\nPASS");
    }
    return 0;
  } finally {
    await server.close();
  }
}

if (import.meta.main) Deno.exit(await main());
