// tools/sav-profiler — play one Dezaemon 2 .sav in Mednafen and in the shmupX
// runtime at the same moment, and record a window of both.
//
//   deno task sav:profile <level.sav> [--from 44] [--for 5] [--fps 10]
//                         [--slot N] [--out build/profiler] [--disc PATH]
//                         [--bin PATH] [--chrome PATH] [--prepare] [--reset]
//                         [--no-god] [--keep-video] [--no-saturn] [--no-web]
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
  findChrome,
  fitViewport,
  Runtime,
  type Sample,
  startServer,
  WebError,
} from "./lib/web.ts";
import {
  grid,
  loadRaster,
  nearest,
  pair,
  scaledEnemies,
  summarizeSightings,
  type TimedFrame,
  writePng,
} from "./lib/report.ts";
import { KeyError } from "./lib/keys.ts";
import { newRaster } from "../../lib/ps2/png.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The checkout root: import.meta-relative in a checkout, the working
// directory when running out of the built server bundle (lib/engine-compare.ts
// passes its own `out`, but the disc probe below still needs the tree).
const REPO_ROOT = (() => {
  const here = new URL("../../", import.meta.url).pathname;
  try {
    if (Deno.statSync(`${here}static/games/2028-ai/game.bundle.js`).isFile) {
      return here;
    }
  } catch { /* not a checkout */ }
  return `${Deno.cwd()}/`;
})();

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
    if (sat) {
      log("saturn: launching and loading the armed state");
      saturn = await armRun(sat, mov, log);
      log("saturn: armed on GAME START");
    }
    if (runtime) await runtime.setSampling(true);

    // t = 0: one Start to both.
    await sleep(500);
    t0 = Date.now();
    await Promise.all([
      saturn ? saturn.kb.pad(saturn.startButton, 100) : Promise.resolve(),
      runtime ? runtime.pressStart() : Promise.resolve(),
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
    if (runtime) {
      const frames = await runtime.screencast(
        join(runDir, "web"),
        () => Date.now() < windowEnd + 200,
      );
      webFrames = frames
        .filter((f) => f.t >= windowStart && f.t <= windowEnd)
        .map((f) => ({ file: f.file, t: (f.t - t0!) / 1000 }));
      await runtime.setSampling(false);
      const got = await runtime.samples();
      samples = got.samples;
      gameStartedAt = got.gameStartedAt;
      log(
        `web: ${webFrames.length} frames in the window, ${samples.length} samples`,
      );
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
    JSON.stringify({ t0, samples }, null, 0),
  );

  // Pictures.
  let sheet: string | null = null;
  let moment: string | null = null;
  const times = saturnFrames.length
    ? saturnFrames.map((f) => f.t)
    : webFrames.map((f) => f.t);
  if (times.length) {
    const every = Math.max(1, Math.ceil(times.length / 24));
    const cells = [];
    for (let i = 0; i < times.length; i += every) {
      const t = times[i];
      const s = nearest(saturnFrames, t);
      const w = nearest(webFrames, t);
      const left = s ? await loadRaster(s.file) : blank(330, 240);
      const right = w ? await loadRaster(w.file) : blank(256, 480);
      cells.push(pair(left, right, 240));
    }
    sheet = join(runDir, "sheet.png");
    await writePng(sheet, grid(cells, 2));
    const focus = strongest ? strongest.t : times[Math.floor(times.length / 2)];
    const s = nearest(saturnFrames, focus);
    const w = nearest(webFrames, focus);
    if (s || w) {
      moment = join(runDir, "moment.png");
      await writePng(
        moment,
        pair(
          s ? await loadRaster(s.file) : blank(330, 240),
          w ? await loadRaster(w.file) : blank(256, 480),
          480,
        ),
      );
    }
  }

  // The split view as one clip: the Saturn's frames on the left, the
  // runtime's nearest frame on the right, at the extraction rate.
  let video: string | null = null;
  if (saturnFrames.length && webFrames.length) {
    video = await writeCompareVideo(runDir, saturnFrames, webFrames, opts.fps);
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
async function writeCompareVideo(
  runDir: string,
  saturn: TimedFrame[],
  web: TimedFrame[],
  fps: number,
): Promise<string | null> {
  const pairsDir = join(runDir, "pairs");
  await ensureDir(pairsDir);
  for (let i = 0; i < saturn.length; i++) {
    const w = nearest(web, saturn[i].t)!;
    const n = String(i).padStart(5, "0");
    await Deno.copyFile(saturn[i].file, join(pairsDir, `s${n}.png`));
    await Deno.copyFile(w.file, join(pairsDir, `w${n}.png`));
  }
  const out = join(runDir, "compare.mp4");
  const ff = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-y",
      "-framerate",
      String(fps),
      "-i",
      join(pairsDir, "s%05d.png"),
      "-framerate",
      String(fps),
      "-i",
      join(pairsDir, "w%05d.png"),
      "-filter_complex",
      "[0:v]scale=-2:480:flags=neighbor[l];[1:v]scale=-2:480:flags=neighbor[r];[l][r]hstack=inputs=2,format=yuv420p",
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
    ],
    boolean: [
      "prepare",
      "reset",
      "no-god",
      "keep-video",
      "no-saturn",
      "no-web",
      "help",
    ],
  });
  if (a.help || !a._[0]) {
    console.log(
      "usage: deno task sav:profile <level.sav> [--from 44] [--for 5] [--fps 10] [--slot N] [--out DIR] [--disc PATH] [--bin PATH] [--chrome PATH] [--prepare] [--reset] [--no-god] [--keep-video] [--no-saturn] [--no-web]",
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
