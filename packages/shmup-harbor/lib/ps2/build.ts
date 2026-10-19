// deno task build:ps2 — package one level as a PlayStation 2 game.
//
// Two artifacts come out of a build, because there are two ways to run PS2
// homebrew: a folder you copy to a USB stick (athena.elf + main.js + assets,
// launched from wLaunchELF/OPL) and a bootable ISO of the same tree (for a
// disc, for PCSX2, or for the launcher's own in-browser PS2 player).
//
// The game code is 5velte-ps2's AthenaEnv port of this very shooter, bundled
// from JSR by `deno bundle` into the single main.js that AthenaEnv's QuickJS
// evaluates on boot. Everything else here is data: the level record becomes
// console-sized atlases and a level.json (lib/ps2/assets.ts).

import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { resolveAthenaElf } from "./athena.ts";
import { type LevelRecord, stageAssets, type StagedFile } from "./assets.ts";
import { buildIso } from "./iso9660.ts";
import { patchRuntime } from "./runtime-patches.ts";
import { decodeDataUrl, decodePng, type Raster } from "./png.ts";
import {
  buildToneBankPack,
  cacheSndpac,
  findSndpac,
} from "./tone-bank-pack.ts";
import {
  buildBgmPack,
  buildSfxPack,
  cachedSoundPack,
  SFX_BUDGET_BYTES,
} from "./sound-pack.ts";
import { loadSavLevel } from "./sav.ts";
import { bossRushRecord, describeBossRush } from "../boss-rush.ts";
import { buildZip } from "./zip.ts";
import type { FrameEntry } from "./atlas.ts";
import { harborRoot } from "../repo-root.ts";
import { cloudAliasUrl, cloudLevelUrl } from "../cloud-level.ts";
import { RTDB_ROOT } from "../rtdb-root.ts";

// The database base. A level is read from shmupX's own subtree of it
// (../cloud-level.ts); the Dezaemon shelf's covers stay at its root.
const FIREBASE_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/**
 * Logic steps per second for the export.
 *
 * The port's `FixedStep` runs at 30, which is the rate the browser build plays
 * at, and on a TV it reads as slow motion. This is the export's default; pass
 * `--game-fps 30` to get the original pace back. It is not a frame rate —
 * see runtime-entry.ts.
 */
const DEFAULT_GAME_FPS = 120;

/**
 * The timestamp every artifact is stamped with. Fixed rather than read from
 * the clock so rebuilding the same level twice produces the same disc and the
 * same archive, byte for byte.
 */
const BUILD_DATE = new Date("2000-03-04T00:00:00Z");

// AthenaEnv reads this beside the ELF (or as cdrom0:ATHENA.INI;1 on a disc).
// The boot logo is off so the game comes straight up. audsrv is the sound IRX:
// it is loaded only when the build actually carries audio, which today means
// the Dezaemon tone bank rendered out of a SNDPAC.BIN found in dev-fixtures/.
// Without it the export is silent exactly as it always was, and there is no
// point paying for the IOP module.
function athenaIni(audsrv: boolean): string {
  return [
    "boot_logo = false",
    "dark_mode = true",
    'default_script = "main.js"',
    `audsrv = ${audsrv}`,
    "",
  ].join("\n");
}

/**
 * The boot executable's name ON THE DISC — `SHMP-00001` once PCSX2 folds it
 * into a serial. It has to match `????_???.??`; anything else leaves the disc
 * serial empty, which makes the emulated mechacon's disc key all zeros and the
 * BIOS refuses the disc. The folder build keeps `athena.elf`.
 */
const DISC_BOOT = "SHMP_000.01";

// What the PS2 boot ROM reads off the disc to find the executable.
const SYSTEM_CNF = [
  `BOOT2 = cdrom0:\\${DISC_BOOT};1`,
  "VER = 1.00",
  "VMODE = NTSC",
  "",
].join("\r\n");

export interface BuildPs2Options {
  /** Repository root — where static/ and build/ live. */
  root: string;
  /** Firebase level to export. Omitted: the base game shipped in the repo. */
  levelName?: string | null;
  /** Read the level from this JSON file instead of Firebase. */
  levelFile?: string | null;
  /**
   * Build straight from a Dezaemon 2 cart image — no editor, no Firebase.
   * `levelName` then only names the artifact; the level itself comes out of
   * the save (lib/ps2/sav.ts).
   */
  savFile?: string | null;
  /** Which game in a cart image that holds more than one. Default: the first. */
  savSlot?: number | null;
  /**
   * Cut the level to its bosses from this stage on (lib/boss-rush.ts): no
   * waves, the stages before it dropped. The build lands in
   * "<name> boss rush <stage>" beside the level's own.
   */
  bossRush?: number | null;
  /**
   * Which of a save's stages to export — a .sav build exports one. Default: the
   * first stage that has anything placed on it.
   */
  stage?: string | null;
  /** Defaults to <root>/build/ps2. */
  outDir?: string | null;
  /**
   * Where the compiled runtime and the downloaded athena.elf are kept between
   * builds. Defaults to <root>/build/ps2/.cache — which a packaged desktop app
   * cannot write to, since its whole tree is a read-only deno-compile VFS, so
   * that caller points this at real disk.
   */
  cacheDir?: string | null;
  /**
   * An already-compiled main.js. Supplying it skips `deno bundle` entirely,
   * which is what lets a build run somewhere the Deno CLI and the sources are
   * not — see buildRuntimeBundle().
   */
  runtimeJs?: Uint8Array | null;
  /** Use this athena.elf rather than downloading the AthenaEnv release. */
  athenaElf?: string | null;
  /** Re-download AthenaEnv even if the cache has it. */
  refreshAthena?: boolean;
  /**
   * Cap on either dimension of a generated atlas (default 512). The level
   * atlas alone may go one doubling past it on one side — 512x1024 — when
   * five stages of sprites need it.
   */
  maxSheet?: number;
  /**
   * Also write a disc image. Off by default: the folder is what gets run,
   * from a USB stick or by pointing an emulator at athena.elf, and a burned
   * homebrew disc needs FMCB or a modchip anyway.
   */
  iso?: boolean;
  /**
   * Write the folder as one `.zip` instead of as a folder. Same tree, same
   * names, one file to hand to a browser download or copy onto a stick.
   */
  zip?: boolean;
  /** SNDPAC.BIN to render the tone bank from; default: search dev-fixtures/. */
  sndpac?: string | null;
  /**
   * The shelf entry whose title-screen shot becomes the title screen — a
   * Dezaemon slug (`mucha-kucha-fighter`) or a local PNG. A level saved under
   * a different name than its save has no link back to the shelf, so this
   * says which one.
   */
  cover?: string | null;
  /** Build without audio even when a sound bank is available. */
  skipAudio?: boolean;
  /** Keep the effects but leave the music off — it is most of the disc. */
  skipMusic?: boolean;
  /** Override how much IOP RAM the effects may use. See SFX_BUDGET_BYTES. */
  sfxBudgetBytes?: number;
  /** Take the flip off the vertical blank and show AthenaEnv's frame counter. */
  uncapped?: boolean;
  /**
   * The game's text face — the title's HI-SCORE / PRESS START and the HUD.
   * "orbitron" (the default) ships shmupX's own Orbitron, the face of its
   * pages and the editor, as a TrueType file beside main.js; "default" keeps
   * AthenaEnv's built-in font.
   */
  font?: "orbitron" | "default";
  /**
   * Logic steps per second. The port's own step is 30; the export defaults to
   * `DEFAULT_GAME_FPS` because 30 plays sluggishly on a TV. See
   * runtime-entry.ts — this scales the clock FixedStep reads, not the frame
   * rate.
   */
  gameFps?: number;
  log?: (message: string) => void;
}

export interface BuildPs2Result {
  /** The level's display name. */
  name: string;
  /** Folder holding both artifacts. */
  dir: string;
  /**
   * The athena.elf build — copy this whole folder to a USB stick. Null when
   * `--zip` asked for the archive instead of the folder.
   */
  appDir: string | null;
  /** The disc image, when --iso asked for one. */
  isoPath: string | null;
  /** The zipped folder, when --zip asked for one. */
  zipPath: string | null;
  artifacts: string[];
  notes: string[];
}

/** Strip what a filesystem (and the editor's own sanitiser) will not take. */
function safeName(name: string): string {
  return name.replace(/[.#$/\[\]]/g, "_").replace(/[^\w \-]/g, "").trim()
    .slice(0, 64) || "level";
}

/** CamelCase, alphanumeric: the folder and ISO basename inside the export. */
function appName(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "Level";
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("")
    .slice(0, 30);
}

interface LoadedLevel {
  record: LevelRecord;
  fallbackName: string;
  /** Set only by the .sav path — see StageOptions.customAtlas. */
  customAtlas?: { sheet: Raster; frames: Record<string, FrameEntry> } | null;
}

/**
 * A level as Firebase has it now, without downloading it again when nothing
 * has changed since the last build.
 *
 * A record is the level's whole art as data URLs, 186 KB for gs, and over a
 * slow connection that one GET was a quarter of a build. The Realtime
 * Database hands out an ETag for a location on request (`X-Firebase-ETag`)
 * and answers a GET that carries it back in `If-None-Match` with 304 and no
 * body while the data is the same, so the copy kept in `cacheDir` is checked
 * for one round trip and used only when it is still exactly what Firebase
 * holds. `savedAt` will not do for that: the editor's per-entry saves write
 * playerData or a boss straight to the level without touching it. And when
 * Firebase cannot be reached at all, the kept copy is used and said to be.
 */
export async function fetchLevelRecord(
  name: string,
  cacheDir: string,
  log: (message: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<LevelRecord | null> {
  // shmupX's own copy (../cloud-level.ts), never the root one, which is cmg's.
  const url = cloudLevelUrl(name, FIREBASE_DB);
  const keptPath = join(cacheDir, "levels", `${encodeURIComponent(name)}.json`);
  let kept: { etag: string; fetchedAt: string; record: LevelRecord } | null =
    null;
  try {
    kept = JSON.parse(await Deno.readTextFile(keptPath));
  } catch {
    // First build of this level here.
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        "X-Firebase-ETag": "true",
        ...(kept ? { "If-None-Match": kept.etag } : {}),
      },
    });
  } catch (error) {
    if (!kept) throw error;
    log(
      `  level from Firebase: ${name} — unreachable (${
        (error as Error).message
      }); using the copy from ${kept.fetchedAt}`,
    );
    return kept.record;
  }
  if (response.status === 304 && kept) {
    await response.body?.cancel();
    log(`  level from Firebase: ${name} (unchanged since the last build)`);
    return kept.record;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (kept) {
      log(
        `  level from Firebase: ${name} — HTTP ${response.status}; using ` +
          `the copy from ${kept.fetchedAt}`,
      );
      return kept.record;
    }
    throw new Error(`could not read the level (HTTP ${response.status})`);
  }
  const record = await response.json() as LevelRecord | null;
  log(`  level from Firebase: ${name}`);
  const etag = response.headers.get("ETag");
  if (record && etag) {
    await ensureDir(dirname(keptPath));
    await Deno.writeTextFile(
      keptPath,
      JSON.stringify({ etag, fetchedAt: new Date().toISOString(), record }),
    );
  }
  return record;
}

/** Where the disc keeps its text face, as main.js asks for it. */
export const PS2_FONT_PATH = "assets/fonts/orbitron.ttf";

/**
 * The scale Orbitron is drawn at, on top of the port's own (the viewport's).
 * AthenaEnv draws a TrueType face about 21 pixels to the em before scaling
 * (measured in PCSX2: "PRESS START" ran 203 pixels at scale 1), and the port
 * lays its title and HUD out for its built-in font's glyphs, about six
 * pixels wide — "PRESS START" is centred as 90 pixels, "SELECT = TURBO MODE"
 * as 110, and HI-SCORE has 78 before its number. At 0.5 the face keeps
 * HI-SCORE clear of its number and SELECT = TURBO MODE inside the field; at
 * 0.36 it centred better but its strokes fell between pixels. It is drawn
 * bold (runtime-patches.ts). The web host draws its canvas copy at the same
 * 21 pixels (web-host.ts), so this one number sizes both.
 */
export const PS2_FONT_SCALE = 0.5;

/**
 * The font files a build carries for `font`, or null for AthenaEnv's
 * built-in one. Orbitron is the editor's own copy (static/games/2028-ai/
 * assets/fonts), shipped with its SIL Open Font License beside it, as the
 * licence asks of any copy that travels.
 */
async function stageFont(
  root: string,
  font: "orbitron" | "default",
  log: (message: string) => void,
): Promise<{ path: string; scale: number; files: StagedFile[] } | null> {
  if (font === "default") return null;
  try {
    const ttf = await Deno.readFile(
      join(root, "static", "games", "2028-ai", "assets", "fonts", "Orbitron-Variable.ttf"),
    );
    const licence = await Deno.readFile(
      join(root, "static", "fonts", "OFL-Orbitron.txt"),
    );
    log(`  font: Orbitron (${(ttf.length / 1024).toFixed(0)}KB TrueType)`);
    return {
      path: PS2_FONT_PATH,
      scale: PS2_FONT_SCALE,
      files: [
        { path: PS2_FONT_PATH, data: ttf },
        { path: "assets/fonts/OFL-Orbitron.txt", data: licence },
      ],
    };
  } catch {
    log("  font: no Orbitron in this checkout — AthenaEnv's built-in font");
    return null;
  }
}

/**
 * The level key shmupX/levelAliases names for `name`, or null. An index that
 * cannot be read names nothing — the runtime's rule, and resolveCloudLevel's.
 */
async function levelAlias(name: string): Promise<string | null> {
  try {
    const response = await fetch(cloudAliasUrl(name, FIREBASE_DB));
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const key = await response.json();
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

async function loadRecord(
  options: BuildPs2Options,
  cacheDir: string,
  log: (message: string) => void,
): Promise<LoadedLevel> {
  if (options.savFile) {
    log(`  level from a Dezaemon save: ${options.savFile}`);
    const level = await loadSavLevel(options.savFile, {
      slot: options.savSlot,
      stage: options.stage,
      name: options.levelName,
    });
    for (const note of level.notes) log(`    ${note}`);
    return {
      record: level.record,
      fallbackName: level.name,
      customAtlas: level.atlas,
    };
  }
  if (options.levelFile) {
    log(`  level from file: ${options.levelFile}`);
    const record = JSON.parse(
      await Deno.readTextFile(options.levelFile),
    ) as LevelRecord;
    return { record, fallbackName: record.name?.trim() || "shmupX" };
  }
  if (options.levelName) {
    // shmupX/levels/<name>, revalidated against the copy the last build kept
    // (fetchLevelRecord); else the key shmupX/levelAliases names — so
    // `build:ps2 2019` builds 2019-PS2, as ?level=2019 plays it — and never
    // the root-level copy, which is cmg's.
    const name = options.levelName;
    const direct = await fetchLevelRecord(name, cacheDir, log);
    if (direct?.enemylist) return { record: direct, fallbackName: name };
    // Not a key: the alias index, then the key it names through the same
    // cache — resolveCloudLevel's steps 2 and 3 (../cloud-level.ts), without
    // asking for the name's own path a second time.
    const key = await levelAlias(name);
    const aliased = key && key !== name
      ? await fetchLevelRecord(key, cacheDir, log)
      : null;
    if (!aliased?.enemylist) {
      throw new Error(`level "${name}" not found in ${RTDB_ROOT}/levels`);
    }
    log(`    "${name}" is an alias of ${RTDB_ROOT}/levels/${key}`);
    return { record: aliased, fallbackName: name };
  }
  // No name: the game the repo already ships, so `deno task build:ps2` on a
  // fresh checkout produces something playable without touching the network.
  const path = join(options.root, "static", "games", "2028-ai", "foo.json");
  log(`  level from the bundled base game: ${path}`);
  // The bundled record's own name is an internal one ("foo"); the artifact
  // this produces is the launcher's game, so call it that.
  return {
    record: JSON.parse(await Deno.readTextFile(path)),
    fallbackName: "shmupX",
  };
}

/**
 * Every local module reachable from `entry` by relative import, entry first.
 *
 * The cache key below has to cover all of them. It used to be the entry's own
 * text, which was true only while runtime-entry.ts imported nothing local —
 * the moment it picked up ./runtime-sound.ts, editing the sound backend
 * stopped invalidating the cache and `build:ps2` would happily stage a stale
 * main.js. A silently stale runtime is about the worst thing this exporter
 * can ship, since the disc looks freshly built.
 */
export async function localGraph(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    for (const match of text.matchAll(/from\s+"(\.[^"]*)"/g)) {
      queue.push(resolve(dirname(path), match[1]));
    }
  }
  return [...seen].sort();
}

/**
 * The title-screen shot for a game, from the shelf or from disk.
 *
 * shmupX generates one for every Dezaemon save it holds, at 256x480, and
 * keeps it in the Realtime Database beside the save. `cover` is either that
 * entry's slug or a path to a PNG; anything that fails to load is reported
 * and the build carries on with the stock title screen rather than failing.
 */
async function loadCover(
  cover: string | null,
  log: (message: string) => void,
): Promise<Raster | null> {
  if (!cover) return null;
  try {
    if (cover.endsWith(".png")) {
      const raster = await decodePng(await Deno.readFile(cover));
      log(`  cover: ${cover} (${raster.width}x${raster.height})`);
      return raster;
    }
    const url = `${FIREBASE_DB}/dezaemon/covers/${
      encodeURIComponent(cover)
    }/png.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const dataUrl = await response.json() as string | null;
    if (!dataUrl) throw new Error("the shelf has no cover for that slug");
    const raster = await decodeDataUrl(dataUrl);
    log(`  cover: ${cover} (${raster.width}x${raster.height}) from the shelf`);
    return raster;
  } catch (error) {
    log(
      `  cover: ${cover} could not be read (${
        (error as Error).message
      }) — keeping the stock title screen`,
    );
    return null;
  }
}

/**
 * Bundle lib/ps2/runtime-entry.ts (and the JSR game it pulls in) into the
 * single main.js AthenaEnv evaluates. The result depends only on our own
 * sources and the pinned dependency, so it is cached and reused across level
 * builds — and, because it is level-independent, it can be compiled once ahead
 * of time and carried somewhere the sources are not. That is how the packaged
 * desktop app exports for the PS2 at all: scripts/build-desktop.ts calls this
 * and embeds the result, and the route hands it back as `runtimeJs`.
 *
 * Exported for that caller; `buildPs2` calls it itself when it has to.
 */
export async function buildRuntimeBundle(
  root: string,
  cacheDir: string,
  log: (message: string) => void = () => {},
): Promise<Uint8Array> {
  // The entry and the import map that resolves it are THIS package's, not the
  // checkout's — `root` is where the game and the build output live, which
  // stopped being the same directory when the port layer moved into
  // packages/shmup-harbor. harbor's deno.json is also the right cache key now:
  // it is where the @easierbycode/svelte-ps2 pin the bundle is built against
  // lives.
  const entry = join(harborRoot(), "lib", "ps2", "runtime-entry.ts");
  const out = join(cacheDir, "main.js");
  const stamp = join(cacheDir, "main.js.key");
  const parts = [await Deno.readTextFile(join(harborRoot(), "deno.json"))];
  for (const path of await localGraph(entry)) {
    parts.push(path, await Deno.readTextFile(path));
  }
  const key = parts.join("\n");

  // The cache holds the bundler's own output; the patches go on as it is
  // handed out, so editing one never needs a re-bundle.
  const patched = (bytes: Uint8Array) =>
    new TextEncoder().encode(patchRuntime(new TextDecoder().decode(bytes)));

  let cached: Uint8Array | null = null;
  try {
    if (await Deno.readTextFile(stamp) === key) {
      cached = await Deno.readFile(out);
    }
  } catch {
    // No usable cache — fall through and bundle.
  }
  if (cached) {
    log("  runtime: reusing the cached bundle");
    return patched(cached);
  }

  await ensureDir(cacheDir);
  log("  runtime: bundling 5velte-ps2 for QuickJS");
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--quiet",
      // The console has no Node built-ins; "browser" keeps the bundler from
      // resolving any away.
      "--platform=browser",
      "--format=esm",
      "--output",
      out,
      entry,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  });
  let result: Deno.CommandOutput;
  try {
    result = await command.output();
  } catch (error) {
    throw new Error(
      `could not run \`deno bundle\` (${(error as Error).message}). The PS2 ` +
        `export needs the Deno CLI on PATH the first time it runs; after that ` +
        `the bundle is cached in ${cacheDir}.`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `deno bundle failed:\n${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  const bytes = await Deno.readFile(out);
  await Deno.writeTextFile(stamp, key);
  return patched(bytes);
}

async function writeTree(dir: string, files: StagedFile[]): Promise<void> {
  for (const file of files) {
    const target = join(dir, file.path);
    await ensureDir(dirname(target));
    await Deno.writeFile(target, file.data);
  }
}

export async function buildPs2(
  options: BuildPs2Options,
): Promise<BuildPs2Result> {
  const log = options.log ?? ((message: string) => console.log(message));
  const root = resolve(options.root);
  const gameDir = join(root, "static", "games", "2028-ai");
  const cacheDir = options.cacheDir
    ? resolve(options.cacheDir)
    : join(root, "build", "ps2", ".cache");

  const { record, fallbackName, customAtlas } = await loadRecord(
    options,
    cacheDir,
    log,
  );
  // A boss-rush build is a different game from the level's own, so it goes in
  // a folder of its own rather than over the disc a player would download.
  let baseName = options.levelName ?? fallbackName;
  if (options.bossRush != null) {
    const rush = bossRushRecord(record as Record<string, unknown>, {
      startStage: options.bossRush,
    });
    log(`  ${describeBossRush(rush)}`);
    baseName += ` boss rush ${options.bossRush}`;
  }
  const name = safeName(baseName);
  const app = appName(name);
  const outRoot = options.outDir
    ? resolve(options.outDir)
    : join(root, "build", "ps2");
  const dir = join(outRoot, name);
  const appDir = join(dir, app);

  log(`Level  : ${name}`);
  log(`Output : ${dir}`);

  // A caller that already holds the compiled runtime hands it over rather than
  // making this shell out to `deno bundle` — see buildRuntimeBundle.
  const mainJs = options.runtimeJs ??
    await buildRuntimeBundle(root, cacheDir, log);
  if (options.runtimeJs) log("  runtime: using the bundle the caller supplied");
  log(`  runtime: main.js is ${(mainJs.length / 1024).toFixed(0)}KB`);

  const athena = await resolveAthenaElf({
    cacheDir,
    elfPath: options.athenaElf ?? null,
    refresh: options.refreshAthena,
  });
  log(
    `  athena.elf: ${
      (athena.bytes.length / 1048576).toFixed(1)
    }MB from ${athena.source}`,
  );

  const cover = await loadCover(options.cover ?? null, log);

  log("  staging assets…");
  const staged = await stageAssets({
    gameDir,
    record,
    cover,
    customAtlas,
    maxSheet: options.maxSheet,
  });
  for (const note of staged.notes) log(`    ${note}`);

  const notes = [...staged.notes];

  // The base game's own audio: effects as SPU2 ADPCM, music as WAV — only
  // the tracks this game's stages play (staged.bosses). Both need ffmpeg on
  // the build host; without it there are no packs. The last build's are
  // reused while the sound tree, the encoders and — for the music — the
  // stages' bosses are unchanged (cachedSoundPack): most of a build's time.
  const budgetBytes = options.sfxBudgetBytes ?? SFX_BUDGET_BYTES;
  const sfxRun = options.skipAudio ? null : await cachedSoundPack(
    cacheDir,
    "sfx",
    gameDir,
    { budgetBytes },
    () => buildSfxPack(gameDir, { budgetBytes }),
  );
  const bgmRun = options.skipAudio || options.skipMusic
    ? null
    : await cachedSoundPack(
      cacheDir,
      "bgm",
      gameDir,
      { bosses: staged.bosses },
      () => buildBgmPack(gameDir, { bosses: staged.bosses }),
    );
  const sfx = sfxRun?.pack ?? null;
  const bgm = bgmRun?.pack ?? null;
  const reused = [sfxRun?.reused && "effects", bgmRun?.reused && "music"]
    .filter(Boolean);
  if (reused.length) {
    log(
      `  sound: the ${reused.join(" and ")} from the last build ` +
        `(sources unchanged)`,
    );
  }
  if (sfx) {
    for (const note of sfx.notes) log(`    ${note}`);
    notes.push(...sfx.notes);
  } else if (!options.skipAudio) {
    log("  no ffmpeg on this host — game audio skipped");
  }
  if (bgm) {
    for (const note of bgm.notes) log(`    ${note}`);
    notes.push(...bgm.notes);
  }

  const audio = options.skipAudio
    ? null
    : await findSndpac(root, options.sndpac ?? null);
  const toneBank = audio ? buildToneBankPack(audio.bytes) : null;
  if (audio && toneBank) {
    log(`  sound bank: ${audio.from}`);
    for (const note of toneBank.notes) log(`    ${note}`);
    notes.push(...toneBank.notes);
    if (!options.sndpac) await cacheSndpac(root, audio.bytes);
  } else if (!options.skipAudio) {
    log("  no SNDPAC.BIN in dev-fixtures/ — no tone bank");
  }

  // audsrv costs an IOP module, so it is loaded only when something can use it.
  const hasAudio = !!toneBank || !!(sfx && sfx.files.length) ||
    !!(bgm && bgm.files.length);
  if (!hasAudio) log("  building silent");

  const encoder = new TextEncoder();

  // A one-line preamble rather than a second bundle: runtime-entry.ts reads
  // this global, so an uncapped build is the same compiled game with the
  // frame pacing turned off.
  const gameFps = options.gameFps ?? DEFAULT_GAME_FPS;
  // Which effects the disc actually carries. Without it the runtime has to
  // probe for every key the port asks for, and cdfs answers a miss with a full
  // directory scan plus a `CAN NOT FOUND` line — nine dropped voice lines cost
  // most of a second of boot and read like a broken disc. See SoundPack.keys.
  const sfxKeys = sfx && sfx.files.length
    ? `globalThis.__PS2_SFX__ = ${JSON.stringify(sfx.keys)};`
    : "";
  // A silent build has to say so. AthenaEnv defines the `Sound` global
  // whether or not athena.ini loaded audsrv (it is compiled in, ath_env.c);
  // only the IOP module behind it is optional. So `typeof Sound.Sfx` tells
  // the runtime nothing, and its first call into a module that was never
  // loaded — `Sound.setVolume` at init — waits on an RPC that never answers:
  // a `--no-audio` disc sat on a black screen forever. runtime-sound.ts reads
  // this and stays silent instead.
  const audsrvFlag = hasAudio ? "" : "globalThis.__PS2_AUDSRV__ = false;";
  // Which tracks the disc carries, and what a boss with no track of its own
  // plays instead. The port asks for all nine stock tracks and names a
  // stage's music after its boss, so without this a level's own boss
  // (`boss_Daltonius_bgm`) plays its stage in silence, and a track left off
  // the disc costs a cdfs miss. See `__PS2_BGM__` in runtime-sound.ts.
  const bgmPlan = bgm && bgm.files.length
    ? `globalThis.__PS2_BGM__ = ${
      JSON.stringify({ tracks: bgm.keys, alias: bgm.alias ?? {} })
    };`
    : "";
  // The text face (runtime-patches.ts "font: the build's own"): the port
  // makes one Font('default') for every line it prints; with these it makes
  // it from the TrueType file the disc carries, at a scale that keeps its
  // wider glyphs inside the layout the port drew for AthenaEnv's own.
  const font = await stageFont(options.root, options.font ?? "orbitron", log);
  const fontFlags = font
    ? `globalThis.__PS2_FONT__ = ${JSON.stringify(font.path)};` +
      ` globalThis.__PS2_FONT_SCALE__ = ${font.scale};` +
      " globalThis.__PS2_FONT_BOLD__ = true;"
    : "";
  const preamble = [
    options.uncapped ? "globalThis.__PS2_UNCAPPED__ = true;" : "",
    gameFps === 30 ? "" : `globalThis.__PS2_GAME_FPS__ = ${gameFps};`,
    sfxKeys,
    bgmPlan,
    audsrvFlag,
    fontFlags,
  ].filter(Boolean).join("\n");
  const uncappedMainJs = preamble
    ? new Uint8Array([...encoder.encode(preamble + "\n"), ...mainJs])
    : mainJs;
  if (options.uncapped) {
    log("  frame pacing: uncapped, with AthenaEnv's frame counter on");
  }
  log(
    `  game speed: ${gameFps} logic steps/sec` +
      (gameFps === 30
        ? " (the port's own pace)"
        : ` — ${(gameFps / 30).toFixed(gameFps % 30 ? 2 : 0)}x the port's 30`),
  );

  const payload: StagedFile[] = [
    { path: "SYSTEM.CNF", data: encoder.encode(SYSTEM_CNF) },
    { path: "athena.elf", data: athena.bytes },
    { path: "athena.ini", data: encoder.encode(athenaIni(hasAudio)) },
    { path: "main.js", data: uncappedMainJs },
    ...staged.files,
    ...(sfx?.files ?? []),
    ...(bgm?.files ?? []),
    ...(toneBank?.files ?? []),
    ...(font?.files ?? []),
  ];

  // The folder and the zip are the same tree; --zip asks for it as one file,
  // so the folder is not also left behind to go stale beside it.
  await Deno.remove(appDir, { recursive: true }).catch(() => {});
  const artifacts: string[] = [];
  let zipPath: string | null = null;
  if (options.zip) {
    // Entries are prefixed with the app folder, so unpacking anywhere
    // reproduces the folder wLaunchELF/OPL expects rather than spraying
    // athena.elf and assets/ into the current directory.
    const zip = await buildZip(
      payload.map((file) => ({ path: `${app}/${file.path}`, data: file.data })),
      BUILD_DATE,
    );
    zipPath = join(dir, `${app}.zip`);
    await ensureDir(dir);
    await Deno.writeFile(zipPath, zip);
    artifacts.push(zipPath);
    log(`  zip: ${(zip.length / 1048576).toFixed(1)}MB`);
  } else {
    await ensureDir(appDir);
    await writeTree(appDir, payload);
    artifacts.push(appDir);
  }

  let isoPath: string | null = null;
  if (options.iso) {
    log("  writing the disc image…");
    const iso = buildIso({
      volumeId: app,
      // Names on the disc are whatever each reader actually asks cdfs for,
      // because cdfs matches them literally. AthenaEnv looks for
      // `cdrom0:ATHENA.INI;1` in upper case when it boots from a disc, and
      // for plain `athena.ini` when it boots from a USB folder (its
      // `default_cfg`, src/main.c) — so the folder keeps the lower-case name
      // and the disc gets the upper-case one. Everything else already matches:
      // SYSTEM.CNF and the ELF are named in upper case by BOOT2, and
      // `default_script` and the game's own asset paths are lower case.
      files: payload.map((file) => {
        // The disc carries different names for two files, because different
        // readers ask cdfs for them literally:
        //
        //  athena.ini -> ATHENA.INI   AthenaEnv looks for `cdrom0:ATHENA.INI;1`
        //                             in upper case on a CD boot, and plain
        //                             `athena.ini` from a folder (default_cfg,
        //                             its src/main.c).
        //  athena.elf -> DISC_BOOT    the PS2 BIOS will not boot a disc whose
        //                             BOOT2 basename does not match the
        //                             licensed XXXX_NNN.NN shape. PCSX2's
        //                             ExecutablePathToSerial() clears the
        //                             serial otherwise, cdvdReadKey() then
        //                             builds an all-zero disc key from the
        //                             empty serial, and the BIOS drops to
        //                             "insert a PlayStation format disc".
        //                             A folder boot never consults SYSTEM.CNF,
        //                             so it keeps the readable name.
        if (file.path === "athena.ini") return { ...file, path: "ATHENA.INI" };
        if (file.path === "athena.elf") return { ...file, path: DISC_BOOT };
        return file;
      }),
      // Fixed, so rebuilding the same level yields the same image.
      date: BUILD_DATE,
    });
    isoPath = join(dir, `${app}.iso`);
    try {
      await Deno.writeFile(isoPath, iso);
    } catch (error) {
      // Windows will not overwrite a file another program holds open, and the
      // one that holds a disc image open is an emulator that has it loaded.
      if (!/os error 32|being used by another process/.test(String(error))) {
        throw error;
      }
      throw new Error(
        `${isoPath} is open in another program — an emulator with the disc ` +
          `loaded, most likely. Close it (or eject the disc) and build again.` +
          (options.zip ? "" : ` ${appDir} is already up to date.`),
      );
    }
    artifacts.push(isoPath);
    log(`  iso: ${(iso.length / 1048576).toFixed(1)}MB`);
  }

  // The exact command that produced this, so the folder is self-describing
  // once it is off the machine that built it.
  const task = options.zip
    ? "build:ps2:zip"
    : options.iso
    ? "build:ps2:iso"
    : "build:ps2";
  const rebuildCommand = [
    `deno task ${task}`,
    options.savFile && !options.levelName ? "" : JSON.stringify(name),
    options.savFile ? `--sav ${JSON.stringify(options.savFile)}` : "",
    options.stage ? `--stage ${options.stage}` : "",
    options.savSlot ? `--slot ${options.savSlot}` : "",
    // build:ps2:zip pre-sets only --zip, so a build that asked for both still
    // has to name the disc.
    options.zip && options.iso ? "--iso" : "",
  ].filter(Boolean).join(" ");

  await Deno.writeTextFile(
    join(dir, "README.txt"),
    readme(name, app, isoPath !== null, zipPath !== null, rebuildCommand, {
      sfx: !!(sfx && sfx.files.length),
      bgm: !!(bgm && bgm.files.length),
      toneBank: !!toneBank,
    }),
  );

  return {
    name,
    dir,
    appDir: options.zip ? null : appDir,
    isoPath,
    zipPath,
    artifacts,
    notes,
  };
}

function readme(
  name: string,
  app: string,
  hasIso: boolean,
  zipped: boolean,
  rebuild: string,
  audio: { sfx: boolean; bgm: boolean; toneBank: boolean },
): string {
  return [
    `${name} — PlayStation 2 build`,
    "",
    zipped ? `${app}.zip` : `${app}/`,
    ...(zipped
      ? [
        `    The AthenaEnv build, zipped. Unpack it and copy the ${app}/`,
        "    folder it holds onto a USB stick (or a memory card, or an",
        "    internal HDD partition), then launch",
      ]
      : [
        "    The AthenaEnv build. Copy the whole folder to a USB stick (or a",
        "    memory card, or an internal HDD partition) and launch",
      ]),
    `    ${app}/ATHENA.ELF from wLaunchELF, OPL or FMCB. ATHENA.ELF is the`,
    "    interpreter; main.js is the game; assets/ is this level. It is",
    "    upper case because SYSTEM.CNF's BOOT2 has to name it exactly.",
    "",
    "    Launch it from one of those. AthenaEnv finds its own boot path by",
    "    special-casing cdrom0:, mass: and hdd0:, so under an emulator the",
    '    .iso is the path it definitely handles — PCSX2\'s "Run ELF" goes',
    "    through host:, which is not one of them.",
    "",
    ...(hasIso
      ? [
        `${app}.iso`,
        "    The same tree as a bootable disc, and the way to run this under",
        "    an emulator. Boot it with FAST BOOT ON: this is a homebrew",
        "    disc, so a full BIOS boot authenticates it, fails, and shows",
        '    "Please insert a PlayStation or PlayStation 2 format disc".',
        "    Fast boot skips that and runs the ELF from SYSTEM.CNF. In",
        '    PCSX2 that is the default — just avoid "Boot Full (with',
        '    BIOS)". The log should say: ELF Loading: cdrom0:\\ATHENA.ELF;1',
        "    It also runs in the launcher's own in-browser PS2 player;",
        "    burning it for real hardware needs a modchip or FMCB, as with",
        "    any homebrew disc.",
        "",
      ]
      : []),
    ...(audio.sfx
      ? [
        "assets/sounds/*.adp",
        "    The game's own sound effects and voices, re-encoded as SPU2",
        "    ADPCM — the only one-shot format audsrv plays.",
        "",
      ]
      : []),
    ...(audio.bgm
      ? [
        "assets/sounds/*.wav",
        "    The music this game's stages play, as WAV for audsrv's",
        "    streamer. It is most of the disc; rebuild with --no-music to",
        "    leave it out.",
        "",
      ]
      : []),
    ...(audio.toneBank
      ? [
        "assets/sounds/tonebank/",
        "    The Dezaemon 2 tone bank as audsrv ADPCM: one .adp per distinct",
        "    sample, and tonebank.json saying which instrument layer uses",
        "    which, at what root pitch, level and pan.",
        "",
      ]
      : []),
    ...(audio.sfx || audio.bgm || audio.toneBank
      ? ["audsrv is enabled in athena.ini for these.", ""]
      : [
        "This build is silent: there was no ffmpeg on the build host to",
        "re-encode the game's audio, and no SNDPAC.BIN in dev-fixtures/ to",
        "cut a tone bank from. See README-Technical.md.",
        "",
      ]),
    "Controls: D-pad or left stick to move, Cross to fire, Start to pause.",
    "",
    "Rebuild with:  " + rebuild,
    "",
  ].join("\n");
}
