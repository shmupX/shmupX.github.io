// scripts/build-sav.ts — a level record as a Dezaemon 2 cart save.
//
//   deno task build:sav                                  # the bundled base game (foo.json) -> "Dez 2 - foo.sav"
//   deno task build:sav foo                              # the cloud level levels/foo
//   deno task build:sav ./backups/mygame.json            # a level record on disk
//   deno task build:sav foo --palette snes               # reduce the art the Super Famicom way
//   deno task build:sav foo --out build/sav/foo.sav --snes-pal build/sav/foo.pal --report
//
// The export is the inverse of the .sav import the editor does: the record's
// atlas (`atlasImageDataURL` + `atlasFrames`, the level's custom frames) is
// decoded, every frame the game needs is reduced to a console palette,
// packed into the four CG pages, the stages are assembled into the game
// section, the eight sections are LZSS-compressed behind their table, and
// the payload is written into a formatted 32 KB + 512 KB BackUpRam image,
// 0xFF-interleaved — the 1,114,112-byte layout of the community collection,
// which MiSTer's Saturn core (and a real cart dumper) reads. See
// packages/shmup-engine/src/write/ and FORMAT.md "Writing a save".
//
// --palette saturn (default) keeps Dezaemon 2's 192 system colours and fills
// the 64 user slots from the atlas; --palette snes builds up to four
// 15-colour rows and confines each sprite to one, the Super Famicom's 4bpp
// rule. Both produce a Saturn save; the palette decides how the art is cut.
// --snes-pal also writes the bank as a 512-byte little-endian CGRAM file.
//
// Frames the level names but its own atlas lacks come from the base game's
// sheet (static/games/2028-ai/assets/game_asset.png) — the same fallback the
// runtime uses — so a level built on stock enemies exports with their art.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { decodeDataUrl, decodePng, type Raster } from "../lib/ps2/png.ts";
import { cut } from "../lib/ps2/raster.ts";
import {
  exportLevelToSav,
  PALETTE_TARGETS,
  savFileName,
  snesCgramBytes,
} from "../packages/shmup-engine/mod.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const FIREBASE_DB = "https://evil-invaders-default-rtdb.firebaseio.com";
const BASE_GAME = join(ROOT, "static", "games", "2028-ai");
const BASE_ATLAS_JSON = join(BASE_GAME, "assets", "game_asset.json");
const BASE_ATLAS_PNG = join(BASE_GAME, "assets", "img", "game_asset.png");

interface FrameRect {
  frame: { x: number; y: number; w: number; h: number };
}

/** A level record as the editor saves it (the fields this script reads). */
export interface LevelRecord {
  name?: string;
  enemylist?: string[][];
  stages?: Record<string, unknown>;
  enemyData?: Record<string, { texture?: string[] }>;
  bossData?: Record<
    string,
    { texture?: string[]; anim?: Record<string, string[]> }
  >;
  playerData?: { texture?: string[] };
  backgroundCells?: string[];
  atlasImageDataURL?: string | null;
  atlasFrames?: Record<string, FrameRect> | null;
  logoDataURL?: string | null;
  subTitleDataURL?: string | null;
  [key: string]: unknown;
}

/** An RGBA frame as the engine takes it. */
export interface ArtFrame {
  w: number;
  h: number;
  rgba: Uint8Array;
}

export interface BuildSavOptions {
  /** A level name in the cloud, or a path to a level JSON file. Omitted: foo.json. */
  level?: string | null;
  palette?: "saturn" | "snes";
  out?: string | null;
  snesPal?: string | null;
  slot?: number;
  comment?: string | null;
  /** Skip the base game's atlas for missing frames. */
  noBaseAtlas?: boolean;
  gameMode?: number;
  log?: (message: string) => void;
}

export interface BuildSavResult {
  outPath: string;
  palPath: string | null;
  bytes: number;
  fileName: string;
  warnings: string[];
  report: Record<string, unknown>;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

function toFrame(r: Raster): ArtFrame {
  return { w: r.width, h: r.height, rgba: r.data as Uint8Array };
}

/** Frame name -> RGBA, from an atlas PNG raster and its TexturePacker frames. */
export function sliceAtlas(
  sheet: Raster,
  frames: Record<string, FrameRect>,
  into: Record<string, ArtFrame> = {},
): Record<string, ArtFrame> {
  for (const [key, entry] of Object.entries(frames)) {
    if (!entry || !entry.frame) continue;
    const name = key.replace(/․/g, ".");
    if (into[name]) continue; // the level's own frame wins over a base one
    into[name] = toFrame(cut(sheet, entry.frame));
  }
  return into;
}

async function loadLevel(
  level: string | null | undefined,
  log: (m: string) => void,
): Promise<{ record: LevelRecord; source: string }> {
  if (!level) {
    const path = join(BASE_GAME, "foo.json");
    log(`level: the bundled base game (${relative(ROOT, path)})`);
    return { record: JSON.parse(await Deno.readTextFile(path)), source: path };
  }
  const isFile = /[\\/]|\.json$/i.test(level) &&
    await Deno.stat(level).then((s) => s.isFile, () => false);
  if (isFile) {
    log(`level: ${level}`);
    return {
      record: JSON.parse(await Deno.readTextFile(level)),
      source: level,
    };
  }
  const url = `${FIREBASE_DB}/levels/${encodeURIComponent(level)}.json`;
  log(`level: ${level} (cloud)`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not read the level (HTTP ${response.status})`);
  }
  const record = await response.json() as LevelRecord | null;
  if (!record || (!record.enemylist && !record.stages)) {
    throw new Error(`level "${level}" not found`);
  }
  if (!record.name) record.name = level;
  return { record, source: url };
}

/** Every frame name a level's records mention. */
function namedFrames(record: LevelRecord): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        typeof item === "string" ? names.add(item) : walk(item);
      }
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(record.enemyData);
  walk(record.bossData);
  walk(record.playerData);
  walk(record.backgroundCells);
  return names;
}

/** Build the .sav. Exported so the E2E test drives the same code the task does. */
export async function buildSav(
  options: BuildSavOptions = {},
): Promise<BuildSavResult> {
  const log = options.log ?? (() => {});
  const palette = options.palette ?? "saturn";
  if (!(palette in PALETTE_TARGETS)) {
    throw new Error(`unknown palette "${palette}" (saturn | snes)`);
  }
  const { record } = await loadLevel(options.level, log);

  // The level's own atlas first, then the base game's sheet for whatever the
  // records still name — a level of stock enemies has an empty custom atlas.
  const art: Record<string, ArtFrame> = {};
  if (record.atlasImageDataURL && record.atlasFrames) {
    const sheet = await decodeDataUrl(record.atlasImageDataURL);
    sliceAtlas(sheet, record.atlasFrames, art);
    log(
      `atlas: ${
        Object.keys(art).length
      } custom frames (${sheet.width}x${sheet.height})`,
    );
  }
  const missing = [...namedFrames(record)].filter((n) =>
    !art[n.replace(/․/g, ".")]
  );
  if (missing.length && !options.noBaseAtlas) {
    try {
      const json = JSON.parse(await Deno.readTextFile(BASE_ATLAS_JSON));
      const sheet = await decodePng(await Deno.readFile(BASE_ATLAS_PNG));
      const wanted: Record<string, FrameRect> = {};
      for (const name of missing) {
        if (json.frames[name]) wanted[name] = json.frames[name];
      }
      const before = Object.keys(art).length;
      sliceAtlas(sheet, wanted, art);
      log(
        `atlas: ${
          Object.keys(art).length - before
        } frames from the base game's sheet`,
      );
    } catch (e) {
      log(`atlas: base sheet unavailable (${(e as Error).message})`);
    }
  }

  // The drawn title screen: the level's logo and subtitle images, if any.
  // Only PNG data URLs decode here; a JPEG logo leaves the title unpainted.
  const titleArt = async (dataUrl: string | null | undefined, what: string) => {
    if (!dataUrl) return null;
    if (!/^data:image\/png[;,]/i.test(dataUrl)) {
      log(`title: ${what} is not a PNG data URL — left unpainted`);
      return null;
    }
    try {
      return toFrame(await decodeDataUrl(dataUrl));
    } catch (e) {
      log(`title: ${what} could not be decoded (${(e as Error).message})`);
      return null;
    }
  };
  const title1 = await titleArt(record.logoDataURL, "logo");
  const title2 = await titleArt(record.subTitleDataURL, "subtitle");

  const result = exportLevelToSav(record, art, {
    palette,
    slot: options.slot ?? 1,
    comment: options.comment ?? undefined,
    gameMode: options.gameMode ?? 0,
    title1,
    title2,
  });
  for (const w of result.warnings) log(`warning: ${w}`);

  const fileName = savFileName(record.name || options.level || "game");
  const outPath = resolve(options.out || join(ROOT, "build", "sav", fileName));
  await ensureDir(dirname(outPath));
  await Deno.writeFile(outPath, result.sav);
  log(
    `wrote ${
      relative(ROOT, outPath)
    } (${result.sav.length} bytes, payload ${result.payload.length})`,
  );

  let palPath: string | null = null;
  if (options.snesPal) {
    palPath = resolve(options.snesPal);
    await ensureDir(dirname(palPath));
    await Deno.writeFile(palPath, snesCgramBytes(result.bank));
    log(`wrote ${relative(ROOT, palPath)} (SNES CGRAM, 512 bytes)`);
  }
  return {
    outPath,
    palPath,
    bytes: result.sav.length,
    fileName,
    warnings: result.warnings,
    report: result.report as Record<string, unknown>,
  };
}

if (import.meta.main) {
  const opts: BuildSavOptions = { log: (m) => console.log(m) };
  let report = false;
  const args = Deno.args.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--palette") {
      const v = value();
      if (v !== "saturn" && v !== "snes") {
        fail(`--palette must be saturn or snes, got ${v}`);
      }
      opts.palette = v;
    } else if (arg.startsWith("--palette=")) {
      const v = arg.slice("--palette=".length);
      if (v !== "saturn" && v !== "snes") {
        fail(`--palette must be saturn or snes, got ${v}`);
      }
      opts.palette = v;
    } else if (arg === "--out") opts.out = value();
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--snes-pal") opts.snesPal = value();
    else if (arg.startsWith("--snes-pal=")) opts.snesPal = arg.slice(11);
    else if (arg === "--slot") opts.slot = Number(value());
    else if (arg === "--comment") opts.comment = value();
    else if (arg === "--horizontal") opts.gameMode = (opts.gameMode ?? 0) | 1;
    else if (arg === "--two-player") opts.gameMode = (opts.gameMode ?? 0) | 2;
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg === "--report") report = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: deno task build:sav [level-name | level.json] [--palette saturn|snes] [--out file.sav]\n" +
          "       [--snes-pal file.pal] [--slot 1-5] [--comment TEXT] [--horizontal] [--two-player]\n" +
          "       [--no-base-atlas] [--report]",
      );
      Deno.exit(0);
    } else if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
    else if (opts.level) {
      fail(`only one level at a time (got ${opts.level} and ${arg})`);
    } else opts.level = arg;
  }
  try {
    const result = await buildSav(opts);
    if (report) console.log(JSON.stringify(result.report, null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}
