#!/usr/bin/env -S deno run -A
/**
 * `deno task refresh:compare` — the game at a display's full refresh rate,
 * against the stock game, measured, recorded, saved and compared.
 *
 * The game's logic steps at a fixed 120 Hz and Phaser draws once per display
 * frame. On a 240 Hz monitor the stock game therefore draws each step twice:
 * whatever the steps move stands still on every second frame. With
 * `?refresh=` at `max` (or `auto`, the default, once the display outruns the
 * logic) the runtime draws step-driven motion where it would be at each
 * frame's moment instead (refreshApply in game.bundle.js). This task proves
 * that, records it, and measures it on real machines.
 *
 *   deno task refresh:compare                        # emulated 240 Hz: record + result
 *   deno task refresh:compare -- --hz 500            # any display rate
 *   deno task refresh:compare -- --live --label "4080 Super 500 Hz"
 *                                                    # this machine's own display
 *   deno task refresh:compare -- --compare build/refresh-compare/results
 *                                                    # results side by side
 *
 * Every run saves a result file (build/refresh-compare/results/ by default,
 * `--save` names one): plain JSON, so it can be carried to any other machine
 * and compared there with the results made on it. scripts/lib/refresh-results.ts
 * has the format.
 *
 * ── Emulated (the default) ───────────────────────────────────────────────
 *
 * No real display is involved. The debug probe (scripts/lib/game-debug.ts)
 * takes over requestAnimationFrame before the bundle boots, and its clock
 * advances 1000/hz ms per frame, so the game sees exactly the frame timing a
 * monitor at that rate would give it, however long each frame takes to
 * capture. Date.now() follows the same clock (Phaser times tweens by it), and
 * the stage is entered on the pad from inside the page, with Math.random
 * reseeded the moment the stage scene starts — so a run is the same run every
 * time, frame for frame, on any machine; only the work each frame costs (and
 * so the result's timing section) is the machine's own.
 *
 * The two halves of the recording are the SAME simulation. The page runs as
 * players get it (`?refresh=` unset, so auto, which blends at this rate;
 * `--mode max` forces it). After each frame is drawn (the right half), the
 * positions refreshApply blended are put back to the logic's own, the scene is
 * drawn again (the left half: exactly what the stock game draws for that
 * state, since stock draws the logic positions), and the blended positions
 * are restored for the next frame. Every difference between the halves is the
 * refresh handling and nothing else. The extra draw runs on its own random
 * stream, so it cannot move the game's.
 *
 * Max refresh is only allowed to change what is drawn. So the same seed is
 * then played again with `?refresh=stock`, and every object's logic position
 * has to match the first run's on every frame (`--no-stock-run` skips it).
 *
 * ── Live (`--live`) ──────────────────────────────────────────────────────
 *
 * A real Chrome, fullscreen on this machine's display (`--window` keeps it a
 * window; `--chrome-arg` passes anything else, such as a window position on
 * the high-refresh monitor), running the game at whatever rate the display
 * gives it. The page drives itself — START through the title and the story,
 * the ship sweeping, `?god=1` so it cannot die — and once the stage is
 * `--warmup` seconds in, records stock and the mode under test in
 * `--slice`-second turns (stock, max, max, stock, …, so drift over the run
 * weighs on both alike) until each has `--seconds`, switching the scene's own
 * refresh state between them. Frame by frame it notes when
 * the frame came, the main-thread work it took, the fixed steps it ran and
 * where everything was drawn (scripts/lib/refresh-page.ts, meterSetup). No
 * video: nothing can capture a 500 Hz display from inside it.
 *
 * ── Compare (`--compare FILES|DIRS`) ─────────────────────────────────────
 *
 * Any number of result files (or directories of them), one column each:
 * machine, display, and for stock and max refresh how often and how evenly
 * motion was drawn, how frames were paced, how much of a frame the work took,
 * and what max refresh adds. Printed, and written as comparison.md and
 * comparison.html (with each result's frame-interval histogram) to `--out`.
 *
 * ── What it measures ─────────────────────────────────────────────────────
 *
 * For every object the fixed step is moving, frame by frame, in each mode:
 *
 *   moved      the share of frames on which it was drawn somewhere new
 *              (stock at 240 Hz: about half; max: all of them)
 *   drawnHz    moved × the display rate: how often motion is drawn
 *   evenness   1 when each frame moves it as far as the last (smooth), 0 when
 *              frames alternate between no move and a double move (judder)
 *
 * and per frame the interval since the last one, the work, and the steps run.
 * `--check` turns the cadence (and an emulated run's stock match) into
 * assertions and the exit code. A display no faster than 120 Hz has nothing
 * to judge: every frame already gets a step, and auto stays off.
 *
 * Output (build/refresh-compare by default, `--out`):
 *   results/<label>-<source>-<hz>hz-<time>.json   every run's result
 *   compare-<hz>fps.mp4       emulated: real time, one video frame per
 *                             display frame, for a monitor at that rate
 *   compare-slowmo-<n>x.mp4   emulated: the same at 60 fps, n times slower
 *   comparison.md / .html     --compare
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, join, relative } from "@std/path";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  Cdp,
  findChrome,
  startServer,
} from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import { PROBE } from "./lib/game-debug.ts";
import {
  cadence,
  firstDivergence,
  type FrameRecord,
  judge,
  type ObjectSample,
  type RawCadence,
  type RawRun,
  spread,
  stepSpan,
  viewCadence,
} from "./lib/refresh-metrics.ts";
import { meterSetup, pageSetup } from "./lib/refresh-page.ts";
import {
  hostMachine,
  keepRaw,
  loadResults,
  type Machine,
  type RefreshResult,
  renderHtml,
  renderMarkdown,
  renderText,
  RESULT_FORMAT,
  RESULT_VERSION,
  resultFileName,
  runResult,
  saveResult,
} from "./lib/refresh-results.ts";

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

/** A Chrome on a profile of its own, attached; `close` takes it all down. */
async function launch(bin: string, flags: string[]) {
  const cdpPort = freePort();
  const profile = await Deno.makeTempDir({ prefix: "refresh-compare-" });
  const chrome = new Deno.Command(bin, {
    args: [
      ...flags,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let cdp: Cdp | null = null;
  const close = async () => {
    // Asked first: a Flatpak's (or any wrapper's) process is not the browser,
    // and killing it alone leaves a fullscreen Chrome behind.
    if (cdp) {
      await Promise.race([
        cdp.send("Browser.close").catch(() => {}),
        sleep(2000),
      ]);
      cdp.close();
    }
    try {
      chrome.kill("SIGKILL");
    } catch { /* gone */ }
    await chrome.status;
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  };
  try {
    cdp = await attach(cdpPort);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return { cdp, close };
  } catch (e) {
    await close();
    throw e;
  }
}

type Screen = { width: number; height: number; dpr: number };

/** The machine, from the page's side and this host's. */
async function machineOf(cdp: Cdp): Promise<Machine & { screen: Screen }> {
  const page = await cdp.eval<
    Omit<Machine, "os" | "arch" | "hostname" | "cpu"> & {
      screen: Screen;
      platform: string | null;
    }
  >(`window.__rfMeter.machine()`);
  if (!page.browser) {
    try {
      const v = await cdp.send<{ product: string }>("Browser.getVersion");
      page.browser = v.product.replace("/", " ");
    } catch { /* unknown */ }
  }
  const { platform: _platform, ...rest } = page;
  return { ...(await hostMachine()), ...rest };
}

/** Whether ffmpeg runs from PATH: the recordings need it, nothing else does. */
async function haveFfmpeg(): Promise<boolean> {
  try {
    const out = await new Deno.Command("ffmpeg", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
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

/** What the page's meter hands back: per mode, every frame and the tallies. */
type MeterTake =
  & Record<
    "stock" | "max",
    RawRun & {
      /** Logic and drawn positions, then the same on the pixel grid. */
      cadence: [RawCadence, RawCadence, RawCadence, RawCadence];
    }
  >
  & {
    /** Display frames per logic step, as a live run measured it. */
    span: number | null;
  };

/** One emulated monitor: a headless Chrome on the game, paused in the stage. */
interface Session {
  /** Step one display frame, reporting at `level` (see pageSetup). */
  step(level?: 0 | 1 | 2): Promise<Step>;
  /** Have the meter record frames as `tag`, or stop. */
  record(tag: "stock" | "max" | null): Promise<void>;
  take(): Promise<MeterTake>;
  machine(): Promise<Machine & { screen: Screen }>;
  close(): Promise<void>;
}

/**
 * A browser on `url` with the probe in, driven through the title and the
 * story into the stage and `warmup` seconds into it, on a fresh random stream.
 */
async function openSession(
  { bin, url, hz, seed, mode, warmup, log }: {
    bin: string;
    url: string;
    hz: number;
    seed: number;
    mode: "auto" | "max";
    warmup: number;
    log: (line: string) => void;
  },
): Promise<Session> {
  const { cdp: page, close } = await launch(bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=256,480",
  ]);
  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: PROBE + ";\n" + pageSetup(hz, seed) + ";\n" +
        meterSetup({ live: false, mode, warmup, seconds: 0, slice: 0 }),
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
    return {
      step,
      record: async (tag) => {
        await page.eval(`window.__rfMeter.record(${JSON.stringify(tag)})`);
      },
      take: () => page.eval<MeterTake>(`window.__rfMeter.take()`),
      machine: () => machineOf(page),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

interface RunOptions {
  bin: string;
  serverUrl: string;
  level: string;
  label: string | null;
  mode: "auto" | "max";
  seconds: number;
  warmup: number;
  nominalHz: number | null;
  log: (line: string) => void;
}

/**
 * Emulated: the recording and its numbers, the stock replay, and — when the
 * recording ran — a replay of the mode under test for its timing alone, since
 * the side-by-side capture between frames (two draws, two readbacks and a PNG
 * a frame) leaves garbage that lands in the next frame's measured work.
 */
async function runEmulated(
  o: RunOptions & {
    hz: number;
    seed: number;
    slowmo: number;
    video: boolean;
    stockRun: boolean;
    outDir: string;
  },
): Promise<RefreshResult> {
  const { hz, seed, mode, warmup, log } = o;
  const total = Math.round(o.seconds * hz);
  // auto is what players get: no parameter at all.
  const testedUrl = `${o.serverUrl}/games/2028-ai` +
    (mode === "max" ? "?refresh=max" : "");
  const open = (url: string) =>
    openSession({ bin: o.bin, url, hz, seed, mode, warmup, log });

  /** The same frames again on `url`, at level 1: positions and timing. */
  const replay = async (url: string, tag: "stock" | "max") => {
    const frames: FrameRecord[] = [];
    const s = await open(url);
    try {
      await s.record(tag);
      for (let i = 0; i < total; i++) {
        const f = await s.step(1);
        if (!f.objs) throw new Error(`frame ${f.frame} captured nothing`);
        frames.push({
          frame: f.frame,
          scene: f.scene,
          on: !!f.on,
          objs: f.objs,
        });
      }
      await s.record(null);
      return { frames, raw: (await s.take())[tag] };
    } finally {
      await s.close();
    }
  };

  const max: FrameRecord[] = [];
  let rawMax: MeterTake["max"] | null = null;
  let machine: Machine & { screen: Screen };
  const session = await open(testedUrl);
  try {
    const realtime = o.video
      ? encoder(join(o.outDir, `compare-${hz}fps.mp4`), hz, hz)
      : null;
    const slow = o.video && o.slowmo > 0
      ? encoder(
        join(o.outDir, `compare-slowmo-${o.slowmo}x.mp4`),
        hz / o.slowmo,
        60,
      )
      : null;
    if (!o.video) await session.record("max");
    for (let i = 0; i < total; i++) {
      const f = await session.step(o.video ? 2 : 1);
      if ((o.video && !f.png) || !f.objs) {
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
      if (f.png) {
        const png = decodeDataUrl(f.png);
        await realtime?.write(png);
        await slow?.write(png);
      }
    }
    await realtime?.close();
    await slow?.close();
    if (!o.video) {
      await session.record(null);
      rawMax = (await session.take()).max;
    }
    machine = await session.machine();
  } finally {
    await session.close();
  }

  // The same seed again on the stock game: the logic has to match frame for
  // frame, or max refresh changed how the game plays.
  const problems: string[] = [];
  let rawStock: MeterTake["stock"] | null = null;
  let matches: boolean | null = null;
  if (o.stockRun) {
    const stock = await replay(
      `${o.serverUrl}/games/2028-ai?refresh=stock`,
      "stock",
    );
    if (stock.frames.some((f) => f.on)) {
      throw new Error("refresh=stock drew a frame blended");
    }
    rawStock = stock.raw;
    const divergence = firstDivergence(max, stock.frames);
    matches = divergence === null;
    if (divergence) {
      problems.push(
        `the game played differently under max refresh: ${divergence}`,
      );
    }
  }
  if (!rawMax) {
    const timed = await replay(testedUrl, "max");
    // Same mode, same seed: anything else would be a broken emulation.
    const drift = firstDivergence(max, timed.frames);
    if (drift) problems.push(`the timing replay drifted: ${drift}`);
    rawMax = timed.raw;
  }

  const c = cadence(max, hz);
  problems.unshift(...judge(c, hz));
  const { screen, ...rest } = machine;
  return {
    format: RESULT_FORMAT,
    version: RESULT_VERSION,
    label: o.label ?? `${rest.hostname ?? "this machine"} (emulated)`,
    createdAt: new Date().toISOString(),
    source: "emulated",
    level: o.level,
    machine: rest,
    display: {
      hz,
      source: "emulated",
      nominalHz: o.nominalHz,
      width: screen.width,
      height: screen.height,
      dpr: screen.dpr,
    },
    settings: {
      mode,
      seconds: o.seconds,
      warmup,
      seed,
      stockRun: o.stockRun,
      cadenceSpan: stepSpan(hz),
    },
    runs: {
      stock: runResult("stock", rawStock, {
        drawn: c.stock,
        logic: c.stock,
        pixels: c.pixels && { drawn: c.pixels.stock, logic: c.pixels.stock },
      }),
      refresh: runResult(mode, rawMax, {
        drawn: c.max,
        logic: c.stock,
        pixels: c.pixels && { drawn: c.pixels.max, logic: c.pixels.stock },
      }),
    },
    logicMatchesStock: matches,
    problems,
    raw: { stock: keepRaw(rawStock), refresh: keepRaw(rawMax) },
  };
}

/** Live: this machine's display, both modes in turns, as fast as it goes. */
async function runLive(
  o: RunOptions & {
    slice: number;
    window: boolean;
    headless: boolean;
    chromeArgs: string[];
  },
): Promise<RefreshResult> {
  const { mode, warmup, seconds, slice, log } = o;
  const flags = [
    // A hidden or covered window is throttled, and a throttled frame clock is
    // not the display's.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    ...(o.headless
      ? ["--headless=new", "--no-sandbox", "--window-size=600,900"]
      : o.window
      ? ["--window-size=600,1000"]
      : ["--start-fullscreen"]),
    ...o.chromeArgs,
  ];
  const { cdp, close } = await launch(o.bin, flags);
  try {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: meterSetup({ live: true, mode, warmup, seconds, slice }),
    });
    const url = `${o.serverUrl}/games/2028-ai?god=1` +
      (mode === "max" ? "&refresh=max" : "");
    await cdp.send("Page.navigate", { url });
    log(
      `ok    ${url} — hands off the keyboard and pad; Chrome closes itself ` +
        `when it is done (about ${Math.round(warmup + seconds * 2 + 30)} s)`,
    );
    type Status = {
      phase: string;
      error: string | null;
      stage: number | null;
      recorded: { stock: number; max: number };
    };
    let last = "";
    let stageBy = Date.now() + 180_000;
    let doneBy = Infinity;
    let st: Status | null = null;
    while (true) {
      await sleep(250);
      st = await cdp.eval<Status | null>(
        `window.__rfMeter ? window.__rfMeter.status() : null`,
      );
      if (!st) continue;
      if (st.phase !== last) {
        log(`      ${st.phase}`);
        last = st.phase;
        if (st.phase === "warmup") {
          stageBy = Infinity;
          doneBy = Date.now() + (warmup + seconds * 3 + 60) * 1000;
        }
      }
      if (st.phase === "done") break;
      if (Date.now() > stageBy) throw new Error("never reached the stage");
      if (Date.now() > doneBy) {
        throw new Error(
          `recording did not finish (stock ${
            st.recorded.stock.toFixed(1)
          } s, max ${st.recorded.max.toFixed(1)} s of ${seconds} s)`,
        );
      }
    }
    const take = await cdp.eval<MeterTake>(`window.__rfMeter.take()`);
    const { screen, ...machine } = await machineOf(cdp);
    const intervals = [...take.stock.interval, ...take.max.interval].filter(
      (x) => x > 0,
    );
    const hz = 1000 / spread(intervals).p50;
    const cad = (r: MeterTake["stock"]) => ({
      logic: viewCadence(r.cadence[0], hz),
      drawn: viewCadence(r.cadence[1], hz),
      pixels: r.cadence[2].samples
        ? {
          logic: viewCadence(r.cadence[2], hz),
          drawn: viewCadence(r.cadence[3], hz),
        }
        : null,
    });
    const stock = runResult("stock", take.stock, cad(take.stock));
    const refresh = runResult(mode, take.max, cad(take.max));
    const problems = judge({
      stock: stock.cadence.drawn,
      max: refresh.cadence.drawn,
      pixels: stock.cadence.pixels && refresh.cadence.pixels && {
        stock: stock.cadence.pixels.drawn,
        max: refresh.cadence.pixels.drawn,
      },
    }, Math.round(hz));
    if (st?.error) problems.unshift(st.error);
    return {
      format: RESULT_FORMAT,
      version: RESULT_VERSION,
      label: o.label ?? machine.hostname ?? "this machine",
      createdAt: new Date().toISOString(),
      source: "live",
      level: o.level,
      machine,
      display: {
        hz,
        source: "measured",
        nominalHz: o.nominalHz,
        width: screen.width,
        height: screen.height,
        dpr: screen.dpr,
      },
      settings: {
        mode,
        seconds,
        warmup,
        slice,
        window: o.headless ? "headless" : o.window ? "window" : "fullscreen",
        cadenceSpan: take.span,
        chromeArgs: o.chromeArgs.join(" ") || null,
      },
      runs: { stock, refresh },
      logicMatchesStock: null,
      problems,
      raw: { stock: keepRaw(take.stock), refresh: keepRaw(take.max) },
    };
  } finally {
    await close();
  }
}

async function compare(paths: string[], outDir: string): Promise<number> {
  if (!paths.length) {
    console.error("FAIL  --compare needs result files or directories of them");
    return 1;
  }
  const results = await loadResults(paths);
  if (!results.length) {
    console.error(`FAIL  no results in ${paths.join(", ")}`);
    return 1;
  }
  console.log(renderText(results));
  await Deno.mkdir(outDir, { recursive: true });
  const md = join(outDir, "comparison.md"),
    html = join(outDir, "comparison.html");
  await Deno.writeTextFile(md, renderMarkdown(results));
  await Deno.writeTextFile(html, renderHtml(results));
  console.log(`\nok    ${results.length} result(s): ${md}, ${html}`);
  return 0;
}

const HELP = `deno task refresh:compare [-- options]

  emulated (default)  --hz 240 --seconds 5 --warmup 6 --mode auto|max
                      --slowmo 4 --seed N --no-video --no-stock-run
  live                --live [--seconds 10 --warmup 6 --slice 1 --mode auto|max
                      --display-hz N --window --headless --chrome-arg=FLAG ...]
  compare             --compare FILE|DIR ...

  any run             --label NAME --save FILE --check --out DIR
                      --level foo.json --chrome BIN --port N`;

async function main(): Promise<number> {
  const argv = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const args = parseArgs(argv, {
    boolean: [
      "check",
      "video",
      "stock-run",
      "help",
      "live",
      "compare",
      "window",
      "headless",
    ],
    negatable: ["video", "stock-run"],
    string: [
      "hz",
      "seconds",
      "warmup",
      "slowmo",
      "slice",
      "seed",
      "out",
      "port",
      "chrome",
      "level",
      "mode",
      "label",
      "save",
      "display-hz",
      "chrome-arg",
    ],
    collect: ["chrome-arg"],
    default: {
      hz: "240",
      warmup: "6",
      slowmo: "4",
      slice: "1",
      seed: "20281024",
      mode: "auto",
      video: true,
      "stock-run": true,
    },
  });
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const outDir = args.out ?? join(repoRoot(), "build", "refresh-compare");
  if (args.compare) return await compare(args._.map(String), outDir);

  // Said before a minute of booting, not by a bare spawn error mid-run.
  if (!args.live && args.video && !(await haveFfmpeg())) {
    console.error(
      "FAIL  the recordings need ffmpeg, and there is none on PATH. Install " +
        "it (Windows: winget install Gyan.FFmpeg, then open a new terminal) " +
        "or pass --no-video; --live needs no ffmpeg.",
    );
    return 1;
  }
  const mode = args.mode === "max" ? "max" : "auto";
  const levelPath = args.level ??
    join(repoRoot(), "static/games/2028-ai/foo.json");
  const record = JSON.parse(await Deno.readTextFile(levelPath));
  const server = startServer(record, { port: Number(args.port ?? freePort()) });
  const common: RunOptions = {
    bin: await findChrome(args.chrome ?? null),
    serverUrl: server.url,
    level: relative(repoRoot(), levelPath),
    label: args.label ?? null,
    mode,
    seconds: Number(args.seconds ?? (args.live ? 10 : 5)),
    warmup: Number(args.warmup),
    nominalHz: args["display-hz"] ? Number(args["display-hz"]) : null,
    log: (line) => console.log(line),
  };
  await Deno.mkdir(outDir, { recursive: true });
  let result: RefreshResult;
  try {
    if (args.live) {
      console.log(`ok    measuring this machine's display (${mode})`);
      result = await runLive({
        ...common,
        slice: Number(args.slice),
        window: args.window,
        headless: args.headless,
        chromeArgs: args["chrome-arg"],
      });
    } else {
      const hz = Number(args.hz);
      console.log(`ok    emulating a ${hz} Hz display`);
      result = await runEmulated({
        ...common,
        hz,
        seed: Number(args.seed),
        slowmo: Number(args.slowmo),
        video: args.video,
        stockRun: args["stock-run"],
        outDir,
      });
      if (args.video) console.log(`ok    recordings in ${outDir}`);
    }
  } finally {
    await server.close();
  }

  const path = args.save ?? join(outDir, "results", resultFileName(result));
  await Deno.mkdir(dirname(path), { recursive: true });
  await saveResult(result, path);
  console.log(renderText([result]));
  console.log(`\nok    result saved: ${path}`);
  if (args.check) {
    for (const p of result.problems) console.error(`FAIL  ${p}`);
    if (result.problems.length) return 1;
    console.log("\nPASS");
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main());
