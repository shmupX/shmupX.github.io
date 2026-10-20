// scripts/inject-disc.ts — a level ON the Dezaemon 2 disc, for a Saturn that
// has no cartridge to load it from.
//
//   deno task disc:inject gs                          # the cloud level gs -> build/disc/Dezaemon 2 (gs)/
//   deno task disc:inject                             # the bundled base game (foo.json)
//   deno task disc:inject ./backups/mygame.json       # a level record on disk
//   deno task disc:inject --sav "Dez 2 - Ramsie.sav"  # the game on a cart you already have
//   deno task disc:inject gs --disc "D:/iso/Dezaemon 2 (Japan).cue" --zip
//
// Every other Saturn path in this repo hands the game over as a cart save
// (build:sav, sav:run, sav:inject): the console's backup cartridge is where
// Dezaemon 2 loads games from. The browser's Saturn — EmulatorJS around
// yabause, the launcher's player and the parity testdrive's pane — has no
// cartridge, and the 32 KB of internal memory it does have is too small for
// the smallest possible game. So this writes the game where the disc keeps its
// own: SGM_INIT.CMP, the boot image every power-on unpacks into the editor.
// The disc then boots holding the level, and the title's PLAY → U plays it.
// The engine does the writing (packages/shmup-engine/src/write/disc-inject.js,
// which says what was traced and why the menu is patched with it); this is the
// command line around it: build the level (the very same build:sav build, so
// the disc and the cart hold identical bytes), find the disc, write the new
// one, read it back.
//
// What comes out, in build/disc/Dezaemon 2 (<name>)/ unless --out says where:
//
//   Dezaemon 2 (<name>).cue             the disc's own cue, FILE lines renamed
//   Dezaemon 2 (<name>) (Track 1).bin   the data track, the game on it
//   Dezaemon 2 (<name>) (Track 2).bin   every other track, copied unchanged
//   Dez 2 - <name>.sav                  the same build as a cart save (not
//                                       written for --sav, which already is one)
//   Dezaemon 2 (<name>).zip             with --zip: the bring-your-own-disc zip
//                                       the browser player boots (lib/dezaemon-disc.ts)
//
// Only the data track changes, and every sector written gets a fresh EDC/ECC.
// A game that fits the boot image's 82 sectors — gs, and three carts in four of
// the community collection — is written over them in place, so the track keeps
// its length and the cue its timings. One that does not — Ramsie and A28 among
// them — goes to the end of the data track instead, which grows by that many
// sectors; each track being its own file, the cue still needs no change. A cue
// that keeps the data track and audio in one .bin is refused, since the data
// track would have to be cut out of it first.
//
// Finding the disc. The disc is community content and never in the repo: --disc
// names it (a .cue, or the data track itself), else $DEZAEMON_DISC, else the
// first Dezaemon 2 image under the gitignored dev-fixtures/ — two folders deep,
// because the collection keeps a console per folder (dev-fixtures/Saturn/
// Dezaemon 2 (Japan)/) — else ~/saturn/Dezaemon 2 (Japan)/, where `deno task
// sav:run` looks. A disc is recognised by its contents, never its name
// (lib/dezaemon-disc.ts).

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { ensureDir } from "@std/fs";
import {
  injectGameIntoDisc,
  readDiscGame,
} from "@shmupx/shmup-engine/disc-inject";
import {
  isValidMode1Sector,
  SECTOR_SIZE,
  USER_OFFSET,
} from "@shmupx/shmup-engine/cd-sector";
import { openDisc } from "@shmupx/shmup-engine/iso9660-read";
import { normalize } from "@shmupx/shmup-engine/bup-source";
import { parse } from "@shmupx/shmup-engine/bup-parse";
import {
  isGameSave,
  parseSectionTable,
} from "@shmupx/shmup-engine/payload-table";
import { decompress } from "@shmupx/shmup-engine/decompress";
import {
  buildStoredZip,
  cueForImage,
  DEZAEMON_CUE_NAME,
  dezaemonGeometry,
  parseCueFiles,
  readDiscPrefix,
  rewriteCueFiles,
} from "../../../lib/dezaemon-disc.ts";
import { repoRoot } from "../lib/repo-root.ts";
import { bossRushArg, buildSav } from "./build-sav.ts";

const ROOT = repoRoot();

export interface InjectDiscOptions {
  /** A level name in the cloud, or a path to a level JSON file. Omitted: foo.json. */
  level?: string | null;
  /** Inject the game on this cart save (.sav / .bcr / .bkr) instead of building one. */
  sav?: string | null;
  /** With `sav`: which of its games, by slot (DEZA2____01..05). Omitted: the first. */
  slot?: number | null;
  /** The disc: a .cue, or its data track. Omitted: found (see the header). */
  disc?: string | null;
  /** The output directory. Omitted: build/disc/Dezaemon 2 (<name>)/. */
  out?: string | null;
  /** The name the files carry, over the game's own. */
  name?: string | null;
  /** false leaves the menu as the source disc has it — a retail disc's is
   * stock, whose title's attract demo then replaces the game after 15 idle
   * seconds, and whose S1-S3 replace it without asking. */
  menu?: boolean;
  /** Also write the zip the browser's Saturn player boots. */
  zip?: boolean;
  /** Passed to build:sav when the game is built from a level. */
  palette?: "saturn" | "snes";
  author?: string | null;
  attribution?: unknown;
  noBaseAtlas?: boolean;
  bossRush?: number | null;
  log?: (message: string) => void;
}

/** A Dezaemon 2 disc as found on disk. */
export interface SaturnDisc {
  /** The cue it came with, or null for a bare data track. */
  cuePath: string | null;
  /** The cue text: the file's own, or one written for a bare data track. */
  cue: string;
  /** Every track file the cue names, absolute, in order; the first is the data track. */
  tracks: string[];
  /** Whether the data track's file holds more tracks after it (a one-.bin
   * rip), which the injection refuses. */
  dataTrackShared: boolean;
}

/** What the engine's injectGameIntoDisc() reports (disc-inject.js). */
export interface InjectReport {
  boot: {
    file: string;
    before: number;
    after: number;
    placement: "in-place" | "relocated";
    extent: number;
    sectors: number;
    allocation: number;
  };
  menu:
    | {
      file: string;
      state: "patched";
      before: number;
      after: number;
      placement: string;
      extent: number;
    }
    | { file: string; state: "already patched"; before: number; after: number }
    | null;
  /** Sectors the data track grew by (0 when everything fit in place). */
  grownBy: number;
  /** Every LBA rewritten, ascending. */
  touched: number[];
}

export interface InjectDiscResult {
  dir: string;
  name: string;
  cuePath: string;
  /** The written track files, in the cue's order; the first is the data track. */
  tracks: string[];
  savPath: string | null;
  zipPath: string | null;
  /** The disc the game was written onto. */
  source: SaturnDisc;
  report: InjectReport;
  warnings: string[];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

const IS_WINDOWS = Deno.build.os === "windows";
const samePath = (a: string, b: string) =>
  IS_WINDOWS
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** Whether `path` is a Dezaemon 2 data track (read from a prefix, by content). */
async function isDezaemon2Track(path: string): Promise<boolean> {
  const prefix = await readDiscPrefix(path);
  return !!prefix && !!dezaemonGeometry(prefix);
}

/**
 * `path` as a Dezaemon 2 disc, or null when it is not one: a .cue whose first
 * FILE is a Dezaemon 2 data track and whose every FILE exists, or the data
 * track itself — described by a .cue beside it that names it when there is
 * one, by a one-track cue written for it otherwise.
 */
export async function describeDisc(path: string): Promise<SaturnDisc | null> {
  const abs = resolve(path);
  if (abs.toLowerCase().endsWith(".cue")) {
    let text: string;
    try {
      text = await Deno.readTextFile(abs);
    } catch {
      return null;
    }
    const names = parseCueFiles(text);
    if (!names.length) return null;
    const tracks = names.map((n) => isAbsolute(n) ? n : join(dirname(abs), n));
    for (const t of tracks) if (!await isFile(t)) return null;
    if (!await isDezaemon2Track(tracks[0])) return null;
    return {
      cuePath: abs,
      cue: text,
      tracks,
      dataTrackShared: tracksInFirstFile(text) > 1,
    };
  }
  if (!await isFile(abs) || !await isDezaemon2Track(abs)) return null;
  try {
    for (const e of Deno.readDirSync(dirname(abs))) {
      if (!e.isFile || !e.name.toLowerCase().endsWith(".cue")) continue;
      const beside = await describeDisc(join(dirname(abs), e.name));
      if (beside && samePath(beside.tracks[0], abs)) return beside;
    }
  } catch { /* an unlistable folder: write the cue instead */ }
  const prefix = await readDiscPrefix(abs);
  const geometry = dezaemonGeometry(prefix!)!;
  return {
    cuePath: null,
    cue: cueForImage(basename(abs), geometry),
    tracks: [abs],
    // A whole-disc .bin with no cue: the data track runs on into audio.
    dataTrackShared: geometry.sectorSize === SECTOR_SIZE &&
      await endsInAudio(abs),
  };
}

const SYNC = [0x00, ...Array(10).fill(0xff), 0x00];

/** Whether a raw image's last sector lacks the 12-byte sync every data
 * sector opens with — what an audio track appended to the data track's .bin
 * looks like (a data track ends in a postgap of empty MODE1 sectors, synced). */
async function endsInAudio(path: string): Promise<boolean> {
  const file = await Deno.open(path, { read: true });
  try {
    const size = (await file.stat()).size;
    if (size < SECTOR_SIZE || size % SECTOR_SIZE) return false;
    await file.seek(size - SECTOR_SIZE, Deno.SeekMode.Start);
    const head = new Uint8Array(SYNC.length);
    let got = 0;
    while (got < head.length) {
      const n = await file.read(head.subarray(got));
      if (n === null) break;
      got += n;
    }
    return got === head.length && head.some((b, i) => b !== SYNC[i]);
  } finally {
    file.close();
  }
}

/** How many TRACKs a cue puts in its first FILE. */
function tracksInFirstFile(cue: string): number {
  let files = 0, tracks = 0;
  for (const line of cue.split(/\r?\n/)) {
    if (/^\s*FILE\s/i.test(line)) files++;
    else if (files === 1 && /^\s*TRACK\s/i.test(line)) tracks++;
  }
  return tracks;
}

/** Every .cue, then every disc image, under `dir` and up to `depth` folders
 * below it, each list in path order. Dot-folders and AppleDouble `._` files
 * are passed over. */
function fixtureCandidates(dir: string, depth: number): string[] {
  const cues: string[] = [];
  const images: string[] = [];
  const walk = (at: string, left: number) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(at)];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const path = join(at, e.name);
      const lower = e.name.toLowerCase();
      if (e.isDirectory && left > 0) walk(path, left - 1);
      else if (e.isFile && lower.endsWith(".cue")) cues.push(path);
      else if (e.isFile && /\.(bin|iso|img)$/.test(lower)) images.push(path);
    }
  };
  walk(dir, depth);
  const order = (a: string, b: string) => a.localeCompare(b);
  return [...cues.sort(order), ...images.sort(order)];
}

/** The Dezaemon 2 disc to write onto (see the header for the order), or null. */
export async function findSaturnDisc(
  root: string = ROOT,
  explicit: string | null = null,
): Promise<SaturnDisc | null> {
  if (explicit) {
    const named = await describeDisc(explicit);
    if (!named) {
      throw new Error(
        `${explicit}: not a Dezaemon 2 disc (a .cue naming its tracks, or the data track itself)`,
      );
    }
    return named;
  }
  const env = Deno.env.get("DEZAEMON_DISC");
  if (env) {
    const fromEnv = await describeDisc(env);
    if (fromEnv) return fromEnv;
  }
  for (const path of fixtureCandidates(join(root, "dev-fixtures"), 2)) {
    const found = await describeDisc(path);
    if (found) return found;
  }
  // Where `deno task sav:run` keeps it (lib/mednafen.ts findDisc): every cue
  // in ~/saturn/Dezaemon 2 (Japan)/, the usual name first. Walked here rather
  // than asked of findDisc, whose one answer is $DEZAEMON_DISC whenever that
  // exists — already rejected above when it is not a disc.
  const home = Deno.env.get(IS_WINDOWS ? "USERPROFILE" : "HOME");
  if (home) {
    const folder = join(home, "saturn", "Dezaemon 2 (Japan)");
    const cues = fixtureCandidates(folder, 0).filter((p) =>
      p.toLowerCase().endsWith(".cue")
    );
    cues.sort((a, b) =>
      Number(basename(b) === "Dezaemon 2 (Japan).cue") -
      Number(basename(a) === "Dezaemon 2 (Japan).cue")
    );
    for (const path of cues) {
      const found = await describeDisc(path);
      if (found) return found;
    }
  }
  return null;
}

/** One game on a cart save. */
export interface CartGame {
  /** 1-5 for DEZA2____01..05. */
  slot: number;
  comment: string;
  /** Decompressed, sec0..sec7; null when the save is damaged (`error` says how). */
  sections: Uint8Array[] | null;
  error: string | null;
}

/** Every Dezaemon 2 game on a cart save, in slot order. A damaged one is
 * listed with its error rather than failing the rest: the cart may hold a
 * healthy game beside it. */
export async function cartGames(bytes: Uint8Array): Promise<CartGame[]> {
  const { data } = await normalize(bytes);
  const games: CartGame[] = [];
  for (const entry of parse(data).filter(isGameSave)) {
    const game: CartGame = {
      slot: Number(entry.filename.slice(-2)),
      comment: String(entry.comment ?? "").trim(),
      sections: null,
      error: null,
    };
    try {
      if (!entry.payload) throw new Error(entry.payloadError ?? "no payload");
      const payload = entry.payload.buffer;
      game.sections = parseSectionTable(payload).sections.map((
        s: { offset: number; size: number },
      ) =>
        Uint8Array.from(
          decompress(payload.subarray(s.offset, s.offset + s.size)),
        )
      );
    } catch (e) {
      game.error = `${entry.filename}: ${(e as Error).message}`;
    }
    games.push(game);
  }
  return games.sort((a, b) => a.slot - b.slot);
}

/** The name a cart's game goes out under: the cart file's own ("Dez 2 -
 * Ramsie.sav" is Ramsie, "Dezaemon 2 (DAIOH).sav" DAIOH), since most carts'
 * header comment is an editor's stock label ("DEZA2 SGM", "D2SGM2") that would
 * put every one in the same folder; the comment only when the file says
 * nothing. A cart of several games names the slot too. */
export function cartGameName(
  savPath: string,
  game: CartGame,
  games: number,
): string {
  const file = basename(savPath).replace(/\.[^.]+$/, "").replace(
    /^Dez 2 - /,
    "",
  )
    .replace(/^Dezaemon 2 \((.*)\)$/, "$1").trim();
  const name = file || game.comment || `slot ${game.slot}`;
  return games > 1 ? `${name} (slot ${game.slot})` : name;
}

/** A name as it may appear in a file name on every OS. */
const fileSafe = (name: string) =>
  name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "game";

/** Inject the game and write the disc. Exported so the parity testdrive and the
 * tests drive the same code the task does. */
export async function injectDisc(
  options: InjectDiscOptions = {},
): Promise<InjectDiscResult> {
  const log = options.log ?? (() => {});
  const source = await findSaturnDisc(ROOT, options.disc ?? null);
  if (!source) {
    throw new Error(
      "no Dezaemon 2 disc found — pass --disc PATH (its .cue, or its data track), " +
        "set DEZAEMON_DISC, or drop it under dev-fixtures/. The disc is community content and is not in the repo.",
    );
  }
  log(`disc: ${source.cuePath ?? source.tracks[0]}`);
  if (source.dataTrackShared) {
    throw new Error(
      `${
        source.cuePath ?? source.tracks[0]
      }: the data track shares its .bin with the audio track after it. ` +
        "disc:inject needs a rip with one file per track (Track 1 and Track 2 .bin files) — " +
        "split this one with a cue-aware tool first.",
    );
  }
  // Everything is built in a scratch folder and the disc read back in memory
  // before anything reaches the output folder, so a run that fails leaves
  // that folder as it was — never a cart beside a disc of another game.
  const scratch = await Deno.makeTempDir({ prefix: "disc-inject-" });
  try {
    return await injectInto(scratch, source, options, log);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

async function injectInto(
  scratch: string,
  source: SaturnDisc,
  options: InjectDiscOptions,
  log: (message: string) => void,
): Promise<InjectDiscResult> {
  // The game: a cart's, or built from the level exactly as build:sav builds it.
  let sections: Uint8Array[];
  let name: string;
  /** The cart built from the level, in scratch until the disc is written. */
  let builtSav: { path: string; fileName: string } | null = null;
  const warnings: string[] = [];
  if (options.sav) {
    const games = await cartGames(await Deno.readFile(options.sav));
    if (!games.length) {
      throw new Error(`${options.sav}: no Dezaemon 2 game on this cart`);
    }
    const listing = games.map((g) =>
      `${g.slot} "${g.comment}"${g.error ? " (damaged)" : ""}`
    ).join(", ");
    const game = options.slot
      ? games.find((g) => g.slot === options.slot)
      : games.find((g) => !g.error) ?? games[0];
    if (!game) {
      throw new Error(
        `${options.sav}: nothing in slot ${options.slot} (it holds ${listing})`,
      );
    }
    if (!game.sections) {
      throw new Error(
        `${options.sav}: slot ${game.slot} is damaged — ${game.error}`,
      );
    }
    if (games.length > 1) {
      log(
        `cart: ${games.length} games (${listing}) — injecting slot ${game.slot}${
          options.slot ? "" : " (--slot picks another)"
        }`,
      );
    }
    sections = game.sections;
    name = options.name?.trim() ||
      cartGameName(options.sav, game, games.length);
    log(`game: slot ${game.slot} of ${options.sav} ("${game.comment}")`);
  } else {
    // The cart goes into the disc's own folder, so one build gives both; it
    // waits in scratch, since the folder is named after the game, which only
    // the build knows.
    const built = await buildSav({
      level: options.level,
      name: options.name,
      palette: options.palette,
      author: options.author,
      attribution: options.attribution,
      noBaseAtlas: options.noBaseAtlas,
      bossRush: options.bossRush,
      out: join(scratch, "game.sav"),
      // Its "wrote" line names the scratch file; where the cart ends up is
      // said below, once it is there.
      log: (m) => {
        if (!m.startsWith("wrote ")) log(m);
      },
    });
    sections = built.sections;
    name = built.name;
    warnings.push(...built.warnings);
    builtSav = { path: built.outPath, fileName: built.fileName };
  }
  const dir = resolve(
    options.out ||
      join(ROOT, "build", "disc", `Dezaemon 2 (${fileSafe(name)})`),
  );

  // The data track, the game on it.
  const track = await Deno.readFile(source.tracks[0]);
  const { image, report } = injectGameIntoDisc(track, sections, {
    menu: options.menu !== false,
  }) as { image: Uint8Array; report: InjectReport };
  const boot = report.boot;
  log(
    `boot image: ${boot.file} ${boot.before} -> ${boot.after} bytes, ${boot.sectors} of its ${boot.allocation} sectors` +
      (boot.placement === "relocated"
        ? `, moved to LBA ${boot.extent} (the track grew ${report.grownBy} sectors)`
        : `, in place at LBA ${boot.extent}`),
  );
  // Read it back the way the console will: the boot image's sections, and a
  // valid sector everywhere the engine wrote.
  const back = readDiscGame(image);
  if (report.menu) {
    log(
      `menu: ${report.menu.file} ${report.menu.state} — the title keeps the game: no attract demo, S1-S3 ask first`,
    );
  } else if (back.menu === "patched") {
    log(
      "menu: kept as the source disc has it (--keep-menu), which is already patched — the title keeps the game",
    );
  } else if (back.menu === "stock") {
    log(
      "menu: kept as the source disc has it (--keep-menu), stock — idling 15 s on the title, or S1-S3, replaces the game until a power cycle",
    );
  } else {
    const note =
      "menu: kept as the source disc has it (--keep-menu); its D2MENU.CMP is not an overlay this patch knows, so whether the title's attract demo or S1-S3 replace the game is unknown";
    log(note);
    warnings.push(note);
  }
  sections.forEach((s, i) => {
    const b = back.sections[i];
    if (b.length !== s.length || b.some((v: number, j: number) => v !== s[j])) {
      throw new Error(`read-back: sec${i} differs from the game written`);
    }
  });
  // Raw MODE1 sectors carry EDC/ECC to check; a cooked image has none. The
  // geometry is what the reader detects, not what the length suggests: a
  // cooked image of 147n sectors is a multiple of 2352 bytes too.
  const geometry = openDisc(image);
  if (
    geometry?.sectorSize === SECTOR_SIZE && geometry.dataOffset === USER_OFFSET
  ) {
    for (const lba of report.touched) {
      const sector = image.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
      if (!isValidMode1Sector(sector, lba)) {
        throw new Error(`read-back: sector ${lba} is not a valid MODE1 sector`);
      }
    }
  }

  // The files. Track 1 gets the game; the rest are copied; the cue renamed;
  // the cart last.
  await ensureDir(dir);
  const base = `Dezaemon 2 (${fileSafe(name)})`;
  const renamed = source.tracks.map((t, i) => {
    const ext = t.match(/\.[^.\\/]+$/)?.[0] ?? ".bin";
    return source.tracks.length === 1 && !source.cuePath
      ? `${base}${ext}`
      : `${base} (Track ${i + 1})${ext}`;
  });
  const written = renamed.map((n) => join(dir, n));
  await Deno.writeFile(written[0], image);
  for (let i = 1; i < source.tracks.length; i++) {
    if (!samePath(source.tracks[i], written[i])) {
      await Deno.copyFile(source.tracks[i], written[i]);
    }
  }
  // The cue's FILE lines are the tracks, in order, so the nth is renamed to
  // the nth new name.
  let index = 0;
  const cue = rewriteCueFiles(
    source.cue,
    () => renamed[Math.min(index++, renamed.length - 1)],
  );
  const cuePath = join(dir, `${base}.cue`);
  await Deno.writeTextFile(cuePath, cue.endsWith("\n") ? cue : cue + "\n");
  log(
    `wrote ${relative(ROOT, cuePath)} and ${written.length} track${
      written.length === 1 ? "" : "s"
    }`,
  );
  let savPath: string | null = null;
  if (builtSav) {
    savPath = join(dir, builtSav.fileName);
    // A copy, not a rename: scratch may be on another volume.
    await Deno.copyFile(builtSav.path, savPath);
    log(`wrote ${relative(ROOT, savPath)} (the same game as a cart save)`);
  }

  let zipPath: string | null = null;
  if (options.zip) {
    // The player's contract: the cue inside is always "Dezaemon 2.cue", its
    // base name being what EmulatorJS names the core's backup memory after.
    const entries: { path: string; data: Uint8Array }[] = [
      {
        path: DEZAEMON_CUE_NAME,
        data: new TextEncoder().encode(cue.endsWith("\n") ? cue : cue + "\n"),
      },
    ];
    for (let i = 0; i < written.length; i++) {
      entries.push({
        path: renamed[i],
        data: i === 0 ? image : await Deno.readFile(written[i]),
      });
    }
    zipPath = join(dir, `${base}.zip`);
    await Deno.writeFile(
      zipPath,
      buildStoredZip(entries, new Date("2000-03-04T00:00:00Z")),
    );
    log(
      `wrote ${
        relative(ROOT, zipPath)
      } (the browser player's bring-your-own-disc zip)`,
    );
  }

  return {
    dir,
    name,
    cuePath,
    tracks: written,
    savPath,
    zipPath,
    source,
    report,
    warnings,
  };
}

export const USAGE =
  `usage: deno task disc:inject [level] [--sav FILE [--slot 1-5]] [--disc PATH]
                             [--out DIR] [--name NAME] [--zip] [--keep-menu]
                             [build:sav flags...]

  level          a cloud level name, a path to a level .json, or nothing for the
                 bundled base game — whatever \`deno task build:sav\` accepts
  --sav FILE     put the game on this cart save on the disc instead of building
                 one (.sav, .bcr or .bkr); --slot picks one of several
  --disc PATH    the Dezaemon 2 disc: its .cue, or its data track. Default:
                 $DEZAEMON_DISC, then dev-fixtures/ two folders deep, then
                 ~/saturn/Dezaemon 2 (Japan)/, where \`deno task sav:run\` looks
  --out DIR      where to write (default build/disc/Dezaemon 2 (<name>)/)
  --name NAME    the name the files carry, over the game's own (for --sav,
                 the cart file's name)
  --zip          also write the zip the browser's Saturn player boots
  --keep-menu    leave the menu as the source disc has it: a retail disc's is
                 stock, whose title's attract demo replaces the game after 15
                 idle seconds and whose S1-S3 replace it unasked
  --palette, --author, --no-author, --no-base-atlas, --boss-rush[=STAGE]
                 as build:sav takes them, for a game built from a level

Boot the .cue with no cartridge; at the title, PLAY → U plays the game.`;

if (import.meta.main) {
  const opts: InjectDiscOptions = { log: (m) => console.log(m) };
  const args = Deno.args.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    const eq = (flag: string) =>
      arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : null;
    if (arg === "--sav") opts.sav = value();
    else if (eq("--sav") !== null) opts.sav = eq("--sav");
    else if (arg === "--slot" || eq("--slot") !== null) {
      const v = Number(eq("--slot") ?? value());
      if (!Number.isInteger(v) || v < 1 || v > 5) fail("--slot must be 1-5");
      opts.slot = v;
    } else if (arg === "--disc") opts.disc = value();
    else if (eq("--disc") !== null) opts.disc = eq("--disc");
    else if (arg === "--out") opts.out = value();
    else if (eq("--out") !== null) opts.out = eq("--out");
    else if (arg === "--name") opts.name = value();
    else if (eq("--name") !== null) opts.name = eq("--name");
    else if (arg === "--zip") opts.zip = true;
    else if (arg === "--keep-menu") opts.menu = false;
    else if (arg === "--palette" || eq("--palette") !== null) {
      const v = eq("--palette") ?? value();
      if (v !== "saturn" && v !== "snes") {
        fail(`--palette must be saturn or snes, got ${v}`);
      }
      opts.palette = v;
    } else if (arg === "--author") opts.attribution = value();
    else if (eq("--author") !== null) opts.attribution = eq("--author");
    else if (arg === "--no-author") opts.author = null;
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg.startsWith("--boss-rush")) opts.bossRush = bossRushArg(arg);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    } else if (arg.startsWith("-")) fail(`unknown argument ${arg}\n\n${USAGE}`);
    else if (opts.level) {
      fail(`only one level at a time (got ${opts.level} and ${arg})`);
    } else opts.level = arg;
  }
  if (opts.sav && opts.level) fail("a level or --sav, not both");
  if (opts.slot && !opts.sav) fail("--slot picks a game on a --sav cart");
  try {
    const result = await injectDisc(opts);
    console.log(
      `\n${result.name} is on the disc: ${relative(ROOT, result.cuePath)}\n` +
        "Boot it with no cartridge; at the title, PLAY → U plays it.",
    );
  } catch (e) {
    fail((e as Error).message);
  }
}
