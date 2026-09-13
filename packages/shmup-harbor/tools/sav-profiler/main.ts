// tools/sav-profiler — play one Dezaemon 2 .sav in Mednafen and in the shmupX
// runtime at the same moment, and record a window of both.
//
//   deno task sav:profile <level.sav> [--from 44] [--for 5] [--fps 10]
//                         [--slot N] [--out build/profiler] [--disc PATH]
//                         [--bin PATH] [--chrome PATH] [--prepare] [--reset]
//                         [--no-god] [--keep-video] [--no-saturn] [--no-web]
//                         [--live] [--live-url URL]
//
// The Saturn side is Mednafen on the user's own disc image, with the level in
// slot 1 of a cart the profiler builds for itself; the first run of a level
// walks the game's menus once and saves a state on its GAME START menu (see
// lib/saturn.ts), and every run after loads that state. The web side is a
// real Chrome on a local server that hands the runtime the same .sav, decoded
// headlessly, as the level it fetches (lib/web.ts) — the level editor is not
// involved. Both are armed on their title, one Start press goes to both at
// once, and that press is t = 0. From `--from` seconds on, for `--for`
// seconds, the Saturn's own video recording and the runtime's screencast are
// cut into frames and laid side by side; every enemy the runtime drew off
// unity scale or under full alpha in that window is listed with its numbers.
//
// Output: build/profiler/<level>-<sha>/runs/<stamp>/ holding sheet.png (the
// window as frame pairs), moment.png (the strongest scale/alpha sighting, 2x),
// saturn/ and web/ (every frame), samples.json, report.json and report.md.
//
// Needs: macOS with the Accessibility grant for the terminal (Mednafen only
// takes keys through its window), Mednafen (brew install mednafen) with the
// Saturn BIOS in ~/.mednafen/firmware, the disc (DEZAEMON_DISC or --disc, or
// dev-fixtures/Dezaemon 2 (Japan).cue), Chrome, ffmpeg/ffprobe, swiftc.

import { parseArgs } from "@std/cli/parse-args";
import { basename, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { levelRecordFromCart, shelfSlug } from "../../lib/shelf.ts";
import {
  binExists,
  findBin,
  findDisc,
  NO_DISC_MESSAGE,
} from "../../lib/mednafen.ts";
import {
  armRun,
  exists,
  extractFrames,
  findStartInMov,
  prepareProfile,
  prepareState,
  probeMov,
  type Saturn,
  SaturnError,
} from "./lib/saturn.ts";
import {
  Browser,
  clampWindowToScreen,
  findChrome,
  fitViewport,
  interceptLevel,
  LIVE_URL,
  Runtime,
  type Sample,
  startServer,
  WebError,
} from "./lib/web.ts";
import {
  grid,
  loadRaster,
  nearest,
  row,
  scaledEnemies,
  summarizeSightings,
  type TimedFrame,
  writePng,
} from "./lib/report.ts";
import { KeyError } from "./lib/keys.ts";
import { newRaster } from "../../lib/ps2/png.ts";
import { repoRoot } from "../../lib/repo-root.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The checkout root (lib/engine-compare.ts passes its own `out`, but the disc
// probe below still needs the tree).
const REPO_ROOT = repoRoot();

/**
 * How long the DEPLOYED pane gets to reach its title. Measured: the local
 * shell is up in 11-13 s, the live origin was still short of it at 61 s and
 * up by 137 s — Deploy serves everything `no-store` and the profiler runs
 * Chrome with a 1-byte disk cache, so ~127 loader items and the level record
 * are re-fetched every run.
 */
const LIVE_TITLE_TIMEOUT_MS = 240_000;

/** codemonkey.games and its subdomains — the deployment with a real board. */
function isProductionHost(url: string): boolean {
  try {
    return /(^|\.)codemonkey\.games$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ProfileOptions {
  sav: string;
  from: number;
  len: number;
  fps: number;
  slot: number | null;
  out: string;
  disc: string | null;
  bin: string | null;
  chrome: string | null;
  port: number;
  cdpPort: number;
  prepareOnly: boolean;
  reset: boolean;
  god: boolean;
  keepVideo: boolean;
  saturn: boolean;
  web: boolean;
  /** Also drive the DEPLOYED site, as a third pane. Off by default: it needs
   * the network, and a run without it is unchanged. */
  live: boolean;
  /** The deployed game page `--live` drives. */
  liveUrl: string;
  log: (line: string) => void;
}

export interface ProfileResult {
  runDir: string;
  profileDir: string;
  slug: string;
  name: string;
  t0: number | null;
  saturnStartSec: number | null;
  /** Seconds the emulator fell behind the wall clock over the run. */
  saturnLagSec: number;
  saturnFrames: TimedFrame[];
  webFrames: TimedFrame[];
  /** Frames from the deployed site — empty unless `--live`. */
  liveFrames: TimedFrame[];
  /** Whether the deployed page took the cart's level (vs whatever it serves). */
  liveLevelServed: boolean;
  /** Why the deployed pane was abandoned, when it was. */
  liveDropped: string | null;
  samples: Sample[];
  gameStartedAfterMs: number | null;
  sightings: ReturnType<typeof summarizeSightings>;
  strongest: ReturnType<typeof scaledEnemies>["strongest"];
  sheet: string | null;
  moment: string | null;
  /** compare.mp4 — the window as one side-by-side clip. */
  video: string | null;
}

export function defaults(): Omit<ProfileOptions, "sav"> {
  return {
    from: 44,
    len: 5,
    fps: 10,
    slot: null,
    out: join(REPO_ROOT, "build", "profiler"),
    disc: null,
    bin: null,
    chrome: null,
    port: 8823,
    cdpPort: 9333,
    prepareOnly: false,
    reset: false,
    god: true,
    keepVideo: false,
    saturn: true,
    web: true,
    live: false,
    liveUrl: LIVE_URL,
    log: (line) => console.log(line),
  };
}

async function sha6(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  return [...h.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(
    0,
    19,
  );
}

export async function profile(opts: ProfileOptions): Promise<ProfileResult> {
  const log = opts.log;
  // Checked before anything is read, built or booted: `?god=1` is the ONLY
  // thing keeping a live run out of the production leaderboard. The deployed
  // bundle counts a score as a record when godFlg is clear, and would stamp
  // the profiled cart's name onto the board for the injected level's own id.
  // The local shell cannot do this — it never loads the Firebase SDK — so the
  // hazard arrives with this pane. Refuse rather than write to production; a
  // staging --live-url is still free to run mortal.
  if (opts.live && !opts.god && isProductionHost(opts.liveUrl)) {
    throw new WebError(
      "--live --no-god would submit a score to the PRODUCTION leaderboard at " +
        `${opts.liveUrl} — drop --no-god, or point --live-url at a staging host`,
    );
  }
  const savPath = resolve(opts.sav);
  const sav = await Deno.readFile(savPath);
  const slug = `${
    shelfSlug(basename(savPath).replace(/\.[^.]+$/, ""))
  }-${await sha6(sav)}`;
  const profileDir = join(resolve(opts.out), slug);
  await ensureDir(profileDir);
  log(`level: ${savPath}`);
  log(`profile: ${profileDir}`);

  // The record the runtime will play, decoded here rather than in the editor.
  const { record, name, notes } = await levelRecordFromCart(sav, {
    slot: opts.slot,
    // A community save carries no title text; name it after its file.
    name: basename(savPath).replace(/\.[^.]+$/, "").replace(/^Dez 2 - /, ""),
    log: (m) => log(`  ${m}`),
  });
  for (const n of notes) log(`  ${n}`);
  if (!opts.god) delete record.godMode;

  // The Saturn side.
  const disc = opts.saturn
    ? await findDisc(opts.disc) ??
      (await exists(join(REPO_ROOT, "dev-fixtures", "Dezaemon 2 (Japan).cue"))
        ? join(REPO_ROOT, "dev-fixtures", "Dezaemon 2 (Japan).cue")
        : null)
    : null;
  if (opts.saturn && !disc) throw new SaturnError(NO_DISC_MESSAGE);
  const bin = findBin(opts.bin);
  if (opts.saturn && !(await binExists(bin))) {
    throw new SaturnError(
      `could not find "${bin}" — brew install mednafen, or set MEDNAFEN_BIN`,
    );
  }
  const sat = opts.saturn
    ? await prepareProfile({ dir: profileDir, sav, disc: disc!, bin, log })
    : null;
  if (sat && opts.reset) {
    try {
      await Deno.remove(sat.statePath);
    } catch { /* none */ }
  }
  if (sat && !(await exists(sat.statePath))) {
    log(
      "no armed state yet for this level — booting Dezaemon 2 and loading it once (about 90 s)",
    );
    await prepareState(sat, { log });
  }
  if (opts.prepareOnly) {
    log("prepared; not running");
    return emptyResult(profileDir, slug, name);
  }

  const runDir = join(profileDir, "runs", stamp());
  await ensureDir(runDir);
  const mov = join(runDir, "saturn.mov");

  let server: ReturnType<typeof startServer> | null = null;
  let browser: Browser | null = null;
  let runtime: Runtime | null = null;
  let saturn: Saturn | null = null;
  let t0: number | null = null;
  let samples: Sample[] = [];
  let gameStartedAt: number | null = null;
  let webFrames: TimedFrame[] = [];
  let liveBrowser: Browser | null = null;
  let liveRuntime: Runtime | null = null;
  let liveLevel: Awaited<ReturnType<typeof interceptLevel>> | null = null;
  let liveFrames: TimedFrame[] = [];
  let liveSamples: Sample[] = [];
  let liveDropped: string | null = null;
  try {
    if (opts.web) {
      server = startServer(record, { port: opts.port, log });
      const chromeBin = await findChrome(opts.chrome);
      const url = `${server.url}/games/2028-ai?level=foo${
        opts.god ? "&god=1" : ""
      }`;
      browser = await Browser.launch({
        bin: chromeBin,
        userDataDir: join(profileDir, "chrome"),
        url,
        port: opts.cdpPort,
        log,
      });
      runtime = new Runtime(browser.cdp, log);
      await fitViewport(browser.cdp);
      await runtime.install();
      log("web: waiting for the title to take input");
      await runtime.waitForTitle();
      log("web: armed on the title");
    }
    if (opts.live) {
      // Its own Chrome: a second profile, a second debugging port and a
      // window beside the first, so both panes are visible and neither
      // steals the other's input.
      const chromeBin = await findChrome(opts.chrome);
      liveBrowser = await Browser.launch({
        bin: chromeBin,
        userDataDir: join(profileDir, "chrome-live"),
        // Armed on a blank page: the level interception has to exist before
        // the deployed bundle asks for it, which it does as it boots.
        url: "about:blank",
        port: opts.cdpPort + 1,
        window: { x: 1250, y: 40, w: 300, h: 560 },
        log,
      });
      // The deployed pane is the OPTIONAL one. If it will not arm — a slow
      // deploy, a wedged loader, a cart whose title data did not decode —
      // that must cost its pane and nothing else, so the Saturn-vs-checkout
      // comparison the tool exists for still happens.
      try {
        liveRuntime = new Runtime(liveBrowser.cdp, log);
        await clampWindowToScreen(liveBrowser.cdp, { log });
        await fitViewport(liveBrowser.cdp);
        liveLevel = await interceptLevel(liveBrowser.cdp, record, { log });
        await liveRuntime.install();
        const liveUrl = `${opts.liveUrl}?level=foo${opts.god ? "&god=1" : ""}`;
        log(`live: ${liveUrl}`);
        await liveBrowser.cdp.send("Page.navigate", { url: liveUrl });
        // Deploy serves every asset no-store and Chrome runs with a 1-byte
        // disk cache, so the live pane re-fetches ~127 loader items and the
        // record on every run: measured still short of the title at 61 s
        // where the local shell took 11-13 s. 60 s is not enough here.
        log("live: waiting for the title to take input (this is the slow one)");
        await liveRuntime.waitForTitle(LIVE_TITLE_TIMEOUT_MS);
        log("live: armed on the title");
      } catch (e) {
        liveRuntime = null;
        liveDropped = e instanceof Error ? e.message : String(e);
        log(`live: DROPPED — ${liveDropped}; the run continues without it`);
      }
    }
    if (sat) {
      log("saturn: launching and loading the armed state");
      saturn = await armRun(sat, mov, log);
      log("saturn: armed on GAME START");
    }
    if (runtime) await runtime.setSampling(true);
    if (liveRuntime) await liveRuntime.setSampling(true);

    // t = 0: one Start to every pane.
    //
    // Re-confirm the browsers are still ON the idle title first. The Dezaemon
    // title loops — 20 s idle, a fade, then a 2.1 s entrance — and titleStart()
    // returns early during the entrance, so a press landing there only snaps
    // the logos and the level never starts. Arming a pane and pressing a
    // moment later was safe; arming the local pane and then waiting out the
    // live pane's boot (which can take minutes) is not, so both are checked
    // again here rather than trusted from when they were armed.
    for (
      const [what, r] of [["web", runtime], ["live", liveRuntime]] as const
    ) {
      if (!r) continue;
      const again = await r.waitForTitle(60_000).catch(() => null);
      if (again !== "ready") {
        log(`${what}: title drifted while arming — pressing anyway`);
      }
    }
    await sleep(500);
    t0 = Date.now();
    await Promise.all([
      saturn ? saturn.kb.pad(saturn.startButton, 100) : Promise.resolve(),
      runtime ? runtime.pressStart() : Promise.resolve(),
      liveRuntime ? liveRuntime.pressStart() : Promise.resolve(),
    ]);
    log(
      `t=0 at ${new Date(t0).toISOString()} — recording ${opts.from}s..${
        opts.from + opts.len
      }s`,
    );

    const windowStart = t0 + opts.from * 1000;
    const windowEnd = windowStart + opts.len * 1000;
    const untilWindow = windowStart - 1000 - Date.now();
    if (untilWindow > 0) await sleep(untilWindow);
    const active = () => Date.now() < windowEnd + 200;
    const capture = async (r: Runtime, dir: string): Promise<TimedFrame[]> =>
      (await r.screencast(join(runDir, dir), active))
        .filter((f) => f.t >= windowStart && f.t <= windowEnd)
        .map((f) => ({ file: f.file, t: (f.t - t0!) / 1000 }));
    if (runtime || liveRuntime) {
      // Both browsers record the SAME window, so they have to record it at
      // the same time — capturing one and then the other would leave the
      // second with nothing but the window's aftermath.
      const [w, l] = await Promise.all([
        runtime ? capture(runtime, "web") : Promise.resolve([] as TimedFrame[]),
        liveRuntime
          ? capture(liveRuntime, "live")
          : Promise.resolve([] as TimedFrame[]),
      ]);
      webFrames = w;
      liveFrames = l;
      if (runtime) {
        await runtime.setSampling(false);
        const got = await runtime.samples();
        samples = got.samples;
        gameStartedAt = got.gameStartedAt;
        log(
          `web: ${webFrames.length} frames in the window, ${samples.length} samples`,
        );
      }
      if (liveRuntime) {
        await liveRuntime.setSampling(false);
        // The deployed pane samples its own enemies exactly as the local one
        // does. Keeping them is the difference between a third pane you have
        // to eyeball and one you can diff: they land in samples.json beside
        // the local run's.
        liveSamples = (await liveRuntime.samples().catch(() =>
          null
        ))?.samples ?? [];
        log(
          `live: ${liveFrames.length} frames in the window, ${liveSamples.length} samples${
            liveLevel ? `, level served ${liveLevel.served()}x` : ""
          }`,
        );
      }
    } else {
      const wait = windowEnd + 500 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    // Insurance against an emulator that fell behind real time (a loaded
    // machine, a full disk): keep it recording a little past the window so
    // the window still exists in emulated time.
    if (saturn) {
      await sleep(Math.min(15_000, 2000 + (opts.from + opts.len) * 150));
    }
  } finally {
    if (saturn) await saturn.quit();
    if (liveLevel) await liveLevel.stop().catch(() => {});
    if (liveBrowser) await liveBrowser.close();
    if (browser) await browser.close();
    if (server) await server.close();
  }

  // The Saturn recording, cut to the window.
  let saturnFrames: TimedFrame[] = [];
  let saturnStartSec: number | null = null;
  let saturnLagSec = 0;
  if (saturn && t0 !== null) {
    const info = await probeMov(mov);
    // Emulated time against the wall clock: a recording shorter than the
    // run (less ~1 s of start-up) means Mednafen fell behind, and the two
    // sides drifted apart by that much.
    const wallSec = (saturn.exitedAt! - saturn.spawnedAt) / 1000 - 1;
    saturnLagSec = Math.max(0, wallSec - info.durationSec);
    log(
      `saturn: ${info.frames} frames, ${info.durationSec.toFixed(2)}s at ${
        info.fps.toFixed(2)
      } fps${
        saturnLagSec > 0.5
          ? ` — ran ${saturnLagSec.toFixed(1)}s SLOWER than real time`
          : ""
      }`,
    );
    const found = await findStartInMov(
      mov,
      info,
      saturn.armedFrame!,
      join(runDir, "saturn-start"),
    );
    saturnStartSec = found.sec;
    log(
      `saturn: Start took at ${found.sec.toFixed(3)}s (frame ${found.frame})`,
    );
    const files = await extractFrames(
      mov,
      join(runDir, "saturn"),
      found.sec + opts.from,
      opts.len,
      opts.fps,
    );
    if (!files.length) {
      throw new SaturnError(
        `the Saturn recording ends at ${
          info.durationSec.toFixed(1)
        }s but the window needs ${
          (found.sec + opts.from + opts.len).toFixed(1)
        }s — the emulator ran ${
          saturnLagSec.toFixed(1)
        }s slower than real time; free up the machine (disk, CPU) and rerun`,
      );
    }
    saturnFrames = files.map((file, i) => ({
      file,
      t: opts.from + i / opts.fps,
    }));
    try {
      await Deno.remove(join(runDir, "saturn-start"), { recursive: true });
    } catch { /* fine */ }
    if (!opts.keepVideo) {
      try {
        await Deno.remove(mov);
      } catch { /* fine */ }
    }
  }

  // Numbers.
  const { sightings, strongest } = t0 !== null
    ? scaledEnemies(samples, t0, opts.from, opts.len)
    : { sightings: [], strongest: null };
  const summary = summarizeSightings(sightings);
  await Deno.writeTextFile(
    join(runDir, "samples.json"),
    JSON.stringify(
      liveSamples.length ? { t0, samples, liveSamples } : { t0, samples },
      null,
      0,
    ),
  );

  // Pictures.
  let sheet: string | null = null;
  let moment: string | null = null;
  const times = saturnFrames.length
    ? saturnFrames.map((f) => f.t)
    : webFrames.length
    ? webFrames.map((f) => f.t)
    : liveFrames.map((f) => f.t);
  // One cell per moment: Saturn, this checkout, and — with --live — the
  // deployed site. A run without --live stacks two, exactly as before.
  const cellAt = async (t: number) => {
    const cells = [];
    const s = nearest(saturnFrames, t);
    cells.push(s ? await loadRaster(s.file) : blank(330, 240));
    const w = nearest(webFrames, t);
    cells.push(w ? await loadRaster(w.file) : blank(256, 480));
    if (opts.live) {
      const l = nearest(liveFrames, t);
      cells.push(l ? await loadRaster(l.file) : blank(256, 480));
    }
    return cells;
  };
  if (times.length) {
    const every = Math.max(1, Math.ceil(times.length / 24));
    const cells = [];
    for (let i = 0; i < times.length; i += every) {
      cells.push(row(await cellAt(times[i]), 240));
    }
    sheet = join(runDir, "sheet.png");
    await writePng(sheet, grid(cells, 2));
    const focus = strongest ? strongest.t : times[Math.floor(times.length / 2)];
    moment = join(runDir, "moment.png");
    await writePng(moment, row(await cellAt(focus), 480));
  }

  // The split view as one clip: the Saturn's frames on the left, the
  // runtime's nearest frame on the right, at the extraction rate.
  let video: string | null = null;
  {
    video = await writeCompareVideo(runDir, [
      { tag: "s", frames: saturnFrames },
      { tag: "w", frames: webFrames },
      ...(opts.live ? [{ tag: "l", frames: liveFrames }] : []),
    ], opts.fps);
    if (video) log(`video: ${video}`);
  }

  const result: ProfileResult = {
    runDir,
    profileDir,
    slug,
    name,
    t0,
    saturnStartSec,
    saturnLagSec,
    saturnFrames,
    webFrames,
    liveFrames,
    liveLevelServed: (liveLevel?.served() ?? 0) > 0,
    liveDropped,
    samples,
    gameStartedAfterMs: gameStartedAt !== null && t0 !== null
      ? gameStartedAt - t0
      : null,
    sightings: summary,
    strongest,
    sheet,
    moment,
    video,
  };
  await Deno.writeTextFile(
    join(runDir, "report.json"),
    JSON.stringify({ ...result, samples: undefined }, null, 2),
  );
  await Deno.writeTextFile(join(runDir, "report.md"), reportMd(result, opts));
  log(`report: ${join(runDir, "report.md")}`);
  return result;
}

/**
 * Side-by-side clip of the window: for each Saturn frame, the web frame
 * nearest in time, scaled to the same height and stacked left/right.
 */
/**
 * The window as one clip, one pane per stream that has frames. The FIRST
 * stream drives the timeline — every other pane shows its nearest frame to
 * that moment — so it must be the Saturn's, which is the recording the Start
 * press was located inside.
 *
 * With the Saturn and the runtime this is the two-pane clip it has always
 * been; `--live` adds a third pane, and a run with one side turned off still
 * gets a clip of whatever is left.
 */
async function writeCompareVideo(
  runDir: string,
  streams: { tag: string; frames: TimedFrame[] }[],
  fps: number,
): Promise<string | null> {
  const live = streams.filter((s) => s.frames.length);
  if (live.length < 2) return null;
  const [master, ...rest] = live;
  const pairsDir = join(runDir, "pairs");
  await ensureDir(pairsDir);
  for (let i = 0; i < master.frames.length; i++) {
    const n = String(i).padStart(5, "0");
    await Deno.copyFile(
      master.frames[i].file,
      join(pairsDir, `${master.tag}${n}.png`),
    );
    for (const s of rest) {
      const f = nearest(s.frames, master.frames[i].t)!;
      await Deno.copyFile(f.file, join(pairsDir, `${s.tag}${n}.png`));
    }
  }
  const out = join(runDir, "compare.mp4");
  const inputs = live.flatMap((s) => [
    "-framerate",
    String(fps),
    "-i",
    join(pairsDir, `${s.tag}%05d.png`),
  ]);
  // Every pane to a common 480 height, nearest-neighbour so the Saturn's
  // pixels stay pixels, then one hstack.
  const scales = live
    .map((_s, i) => `[${i}:v]scale=-2:480:flags=neighbor[p${i}]`)
    .join(";");
  const chain = live.map((_s, i) => `[p${i}]`).join("");
  const filter =
    `${scales};${chain}hstack=inputs=${live.length},format=yuv420p`;
  const ff = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-preset",
      "veryfast",
      out,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  try {
    await Deno.remove(pairsDir, { recursive: true });
  } catch { /* fine */ }
  return ff.success ? out : null;
}

function blank(w: number, h: number) {
  return newRaster(w, h);
}

function emptyResult(
  profileDir: string,
  slug: string,
  name: string,
): ProfileResult {
  return {
    runDir: "",
    profileDir,
    slug,
    name,
    t0: null,
    saturnStartSec: null,
    saturnLagSec: 0,
    saturnFrames: [],
    webFrames: [],
    liveFrames: [],
    liveLevelServed: false,
    liveDropped: null,
    samples: [],
    gameStartedAfterMs: null,
    sightings: [],
    strongest: null,
    sheet: null,
    moment: null,
    video: null,
  };
}

function reportMd(r: ProfileResult, o: ProfileOptions): string {
  const lines = [
    `# ${r.name} — ${o.from}s to ${o.from + o.len}s after Start`,
    "",
    `- level: ${o.sav}`,
    `- t = 0: ${
      r.t0 ? new Date(r.t0).toISOString() : "n/a"
    } (one Start press to both)`,
    `- Saturn: ${r.saturnFrames.length} frames at ${o.fps} fps${
      r.saturnStartSec !== null
        ? `, Start found ${r.saturnStartSec.toFixed(3)}s into the recording`
        : ""
    }${
      r.saturnLagSec > 0.5
        ? ` — the emulator ran ${
          r.saturnLagSec.toFixed(1)
        }s slower than real time, so the two sides drifted by that much`
        : ""
    }`,
    `- web: ${r.webFrames.length} screencast frames${
      r.gameStartedAfterMs !== null
        ? `, gameplay began ${
          (r.gameStartedAfterMs / 1000).toFixed(2)
        }s after Start`
        : ""
    }`,
    ...(o.live && r.liveDropped
      ? [
        `- live: **dropped** — ${r.liveDropped}; this run is Saturn vs this checkout only`,
      ]
      : []),
    ...(o.live && !r.liveDropped
      ? [
        `- live: ${r.liveFrames.length} screencast frames from ${o.liveUrl}${
          r.liveLevelServed
            ? " — playing this cart's level (the deployed page's own level fetch was answered with it)"
            : " — **the level was NOT injected**, so this pane is whatever the deployed page serves, not this cart"
        }`,
      ]
      : []),
    `- pictures: ${r.sheet ? "sheet.png" : "no sheet"}${
      r.moment ? ", moment.png" : ""
    }${r.video ? ", compare.mp4" : ""}`,
    "",
    "## Runtime enemies off unity scale or under full alpha in the window",
    "",
  ];
  if (!r.sightings.length) lines.push("none");
  else {
    lines.push(
      "| enemy | first (s) | last (s) | scale | alpha min | shadow | samples |",
      "|---|---|---|---|---|---|---|",
    );
    for (const s of r.sightings) {
      const shadow = s.shadowAlpha === null
        ? "none"
        : `${s.shadowOffsetMin}–${s.shadowOffsetMax} px at alpha ${
          s.shadowAlpha.toFixed(2)
        }`;
      lines.push(
        `| ${s.name} | ${s.first.toFixed(2)} | ${s.last.toFixed(2)} | ×${
          s.scaleMin.toFixed(2)
        }–×${s.scaleMax.toFixed(2)} | ${
          s.alphaMin.toFixed(2)
        } | ${shadow} | ${s.samples} |`,
      );
    }
  }
  if (r.strongest) {
    lines.push(
      "",
      `Strongest: ${r.strongest.name} at ${r.strongest.t.toFixed(2)}s — ×${
        r.strongest.sx.toFixed(2)
      }/×${r.strongest.sy.toFixed(2)}, alpha ${
        r.strongest.alpha.toFixed(2)
      }, at (${r.strongest.x}, ${r.strongest.y}); see moment.png.`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.main) {
  const a = parseArgs(Deno.args, {
    string: [
      "from",
      "for",
      "fps",
      "slot",
      "out",
      "disc",
      "bin",
      "chrome",
      "port",
      "cdp-port",
      "live-url",
    ],
    boolean: [
      "prepare",
      "reset",
      "no-god",
      "keep-video",
      "no-saturn",
      "no-web",
      "live",
      "help",
    ],
  });
  if (a.help || !a._[0]) {
    console.log(
      "usage: deno task sav:profile <level.sav> [--from 44] [--for 5] [--fps 10] [--slot N] [--out DIR] [--disc PATH] [--bin PATH] [--chrome PATH] [--prepare] [--reset] [--no-god] [--keep-video] [--no-saturn] [--no-web] [--live] [--live-url URL]",
    );
    Deno.exit(a.help ? 0 : 2);
  }
  const d = defaults();
  const opts: ProfileOptions = {
    ...d,
    sav: String(a._[0]),
    from: a.from !== undefined ? Number(a.from) : d.from,
    len: a.for !== undefined ? Number(a.for) : d.len,
    fps: a.fps !== undefined ? Number(a.fps) : d.fps,
    slot: a.slot !== undefined ? Number(a.slot) : null,
    out: a.out ?? d.out,
    disc: a.disc ?? null,
    bin: a.bin ?? null,
    chrome: a.chrome ?? null,
    port: a.port !== undefined ? Number(a.port) : d.port,
    cdpPort: a["cdp-port"] !== undefined ? Number(a["cdp-port"]) : d.cdpPort,
    prepareOnly: a.prepare,
    reset: a.reset,
    god: !a["no-god"],
    keepVideo: a["keep-video"],
    saturn: !a["no-saturn"],
    web: !a["no-web"],
    live: a.live,
    liveUrl: a["live-url"] ?? d.liveUrl,
  };
  try {
    const r = await profile(opts);
    if (r.runDir) {
      console.log("");
      console.log(await Deno.readTextFile(join(r.runDir, "report.md")));
    }
  } catch (e) {
    if (
      e instanceof SaturnError || e instanceof WebError || e instanceof KeyError
    ) {
      console.error(`sav-profiler: ${e.message}`);
      Deno.exit(1);
    }
    throw e;
  }
}
