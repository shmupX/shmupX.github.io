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
import { decodeDataUrl, decodePng, type Raster } from "./png.ts";
import {
  buildToneBankPack,
  cacheSndpac,
  findSndpac,
} from "./tone-bank-pack.ts";
import { buildBgmPack, buildSfxPack } from "./sound-pack.ts";
import { loadSavLevel } from "./sav.ts";
import { buildZip } from "./zip.ts";
import type { FrameEntry } from "./atlas.ts";

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
   * Which of a save's stages to export — the console runs one. Default: the
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
  /** Cap on either dimension of a generated atlas (default 512). */
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

async function loadRecord(
  options: BuildPs2Options,
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
    const url = `${FIREBASE_DB}/levels/${
      encodeURIComponent(options.levelName)
    }.json`;
    log(`  level from Firebase: ${options.levelName}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not read the level (HTTP ${response.status})`);
    }
    const record = await response.json() as LevelRecord | null;
    if (!record || !record.enemylist) {
      throw new Error(`level "${options.levelName}" not found`);
    }
    return { record, fallbackName: options.levelName };
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
async function localGraph(entry: string): Promise<string[]> {
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
  const entry = join(root, "lib", "ps2", "runtime-entry.ts");
  const out = join(cacheDir, "main.js");
  const stamp = join(cacheDir, "main.js.key");
  const parts = [await Deno.readTextFile(join(root, "deno.json"))];
  for (const path of await localGraph(entry)) {
    parts.push(path, await Deno.readTextFile(path));
  }
  const key = parts.join("\n");

  try {
    if (await Deno.readTextFile(stamp) === key) {
      log("  runtime: reusing the cached bundle");
      return await Deno.readFile(out);
    }
  } catch {
    // No usable cache — fall through and bundle.
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
  return bytes;
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

  const { record, fallbackName, customAtlas } = await loadRecord(options, log);
  const name = safeName(options.levelName ?? fallbackName);
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

  // The base game's own audio: effects as SPU2 ADPCM, music as Ogg Vorbis.
  // Both need ffmpeg on the build host; without it there are no packs.
  const sfx = options.skipAudio
    ? null
    : await buildSfxPack(gameDir, { budgetBytes: options.sfxBudgetBytes });
  const bgm = options.skipAudio || options.skipMusic
    ? null
    : await buildBgmPack(gameDir);
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
  const preamble = [
    options.uncapped ? "globalThis.__PS2_UNCAPPED__ = true;" : "",
    gameFps === 30 ? "" : `globalThis.__PS2_GAME_FPS__ = ${gameFps};`,
    sfxKeys,
    audsrvFlag,
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
    await Deno.writeFile(isoPath, iso);
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
        "assets/sounds/*.ogg",
        "    The music, as Ogg Vorbis for audsrv's streamer. It is most of",
        "    the disc; rebuild with --no-music to leave it out.",
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
        "cut a tone bank from. See README.md.",
        "",
      ]),
    "Controls: D-pad or left stick to move, Cross to fire, Start to pause.",
    "",
    "Rebuild with:  " + rebuild,
    "",
  ].join("\n");
}
