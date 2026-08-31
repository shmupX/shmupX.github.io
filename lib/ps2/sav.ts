// A Dezaemon 2 cart image, as the level record the PS2 export stages from.
//
// `deno task build:ps2 --sav <file>` is the offline half of the exporter: the
// Firebase path needs a level somebody already saved from the editor, while a
// .sav is the raw Saturn artefact sitting in dev-fixtures/. This module runs
// the same pipeline the editor's importer does — normalize → parse →
// decodeSave → mapSaveToGame (packages/shmup-engine) — and lands on the same
// `LevelRecord` shape the Firebase reader produces, so everything downstream
// of loadRecord() is identical whichever source the build came from.
//
// The one place the two differ is the custom atlas. The editor uploads it as a
// PNG data URL because that is what a browser canvas hands it; here the sprites
// arrive as raw RGBA, so the sheet is packed into a Raster and passed through
// directly rather than round-tripping a multi-megabyte base64 string.

import { basename } from "@std/path";
import * as deza from "../../packages/shmup-engine/mod.js";
import type { LevelRecord } from "./assets.ts";
import type { FrameEntry } from "./atlas.ts";
import { newRaster, type Raster } from "./png.ts";
import { blit } from "./raster.ts";

// --- a typed view of the engine's JavaScript ---------------------------------
// packages/shmup-engine is plain JS, so TypeScript infers each function's shape
// from one sample of the data it happened to be written against — `enemyData`
// comes back as `{ enemyA }`, `dezaemonTitle` as `{}`. Naming the contract here
// keeps those inferences from leaking into this module, and is the single place
// to look when the engine's surface moves.

/** One backup-RAM directory entry, as `parse()` returns it. */
interface SaveEntry {
  filename: string;
  comment: string;
  payload: { buffer: ArrayBufferLike } | null;
}

/** One decoded sprite: raw RGBA, ready to blit. */
interface Sprite {
  key: string;
  w: number;
  h: number;
  rgba: ArrayLike<number>;
}

/** One stage of a mapped game — the only part the console stages. */
interface StageRecord {
  enemylist?: string[][];
  waveRows?: number[];
  waveInterval?: number;
}

/** `mapSaveToGame`'s game.json, narrowed to the fields a level record needs. */
interface GameJson {
  enemyData?: Record<string, Record<string, unknown>>;
  bossData?: Record<string, Record<string, unknown>>;
  playerData?: Record<string, unknown>;
  dezaemonTitle?: Record<string, string>;
  [stage: string]: unknown;
}

const normalize = deza.normalize as (
  bytes: Uint8Array,
) => Promise<{ kind: string; data: Uint8Array }>;
const parse = deza.parse as (data: Uint8Array) => SaveEntry[];
const isGameSave = deza.isGameSave as (entry: SaveEntry) => boolean;
const decodeSave = deza.decodeSave as (buffer: ArrayBufferLike) => unknown;
const mapSaveToGame = deza.mapSaveToGame as unknown as (
  decoded: unknown,
  options?: { sourceEntry?: SaveEntry; importedAt?: string | null },
) => { gameJson: GameJson; sprites: Sprite[]; warnings: string[] };
const packShelf = deza.packShelf as (
  items: Sprite[],
  options?: { maxWidth?: number; pad?: number },
) => {
  width: number;
  height: number;
  placements: Record<string, { x: number; y: number }>;
  frames: Record<string, FrameEntry>;
  order: string[];
};

/** How the editor's own repacks lay a sheet out (packShelf's defaults). */
const ATLAS_MAX_WIDTH = 2048;
const ATLAS_PAD = 4;

/** The port stages exactly one stage; this is Dezaemon's first. */
const DEFAULT_STAGE = "stage0";

export interface SavLevelOptions {
  /** `stage0`..`stage9`, or the number on its own. Default: the first with waves. */
  stage?: string | null;
  /**
   * Which game in the cart image, when it holds more than one. Zero-based over
   * the DEZA2____NN entries that actually carry a payload.
   */
  slot?: number | null;
  /** Overrides the name derived from the filename. */
  name?: string | null;
}

export interface SavLevel {
  record: LevelRecord;
  /**
   * The save's sprites as one sheet — what `atlasImageDataURL` would decode to
   * if this had come from Firebase.
   */
  atlas: { sheet: Raster; frames: Record<string, FrameEntry> } | null;
  /** The display name: the caller's, else the one the filename implies. */
  name: string;
  notes: string[];
}

/**
 * "Dez 2 - Air Streamer -Ver.A-.sav" -> "Air Streamer -Ver.A-".
 *
 * The shelf's filename convention, mirrored from `fileTitleOf` in
 * scripts/upload-deza-saves.ts so a build names a save the same thing the
 * library does.
 */
export function savTitle(file: string): string {
  return basename(file).replace(/\.(sav|bcr|bkr)$/i, "").replace(
    /^Dez 2 - /,
    "",
  );
}

/**
 * The shelf slug for a save file, mirroring `slugOf` in
 * scripts/upload-deza-saves.ts — which is what `--cover <slug>` wants when the
 * title-screen shot for this very save is the one to put on the title screen.
 */
export function savSlug(file: string): string {
  const s = savTitle(file).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "save";
}

/** `stage3`, `3` and `stage03` all mean the same stage. */
function stageKeyOf(stage: string): string {
  const trimmed = stage.trim();
  const digits = /^(?:stage)?0*(\d+)$/i.exec(trimmed);
  if (!digits) throw new Error(`--stage takes stage0..stage9, got "${stage}"`);
  return `stage${Number(digits[1])}`;
}

/** Waves actually placed on a stage — an untouched stage decodes to a grid of "00". */
function spawnCount(enemylist: string[][] | undefined): number {
  let n = 0;
  for (const row of enemylist ?? []) {
    for (const cell of row) if (cell && cell !== "00") n++;
  }
  return n;
}

/** Blit each decoded sprite into one sheet, laid out exactly as the editor packs it. */
function packSprites(
  sprites: Sprite[],
): { sheet: Raster; frames: Record<string, FrameEntry> } | null {
  if (!sprites.length) return null;
  const packed = packShelf(sprites, {
    maxWidth: ATLAS_MAX_WIDTH,
    pad: ATLAS_PAD,
  });
  const sheet = newRaster(packed.width, packed.height);
  const byKey = new Map(sprites.map((sprite) => [sprite.key, sprite]));
  for (const key of packed.order) {
    const sprite = byKey.get(key);
    const at = packed.placements[key];
    if (!sprite || !at) continue;
    const src: Raster = {
      width: sprite.w,
      height: sprite.h,
      data: new Uint8Array(sprite.rgba) as Raster["data"],
    };
    blit(sheet, src, at.x, at.y);
  }
  return { sheet, frames: packed.frames };
}

/**
 * Read a Dezaemon 2 save and hand back one of its stages as a level record.
 *
 * Throws with the reason rather than half-building: an image with no game in
 * it, a slot that isn't there, or a stage nobody placed anything on are all
 * things the caller should say out loud rather than export as an empty disc.
 */
export async function loadSavLevel(
  path: string,
  options: SavLevelOptions = {},
): Promise<SavLevel> {
  const notes: string[] = [];
  const normalized = await normalize(await Deno.readFile(path));
  const entries = parse(normalized.data);
  const games = entries.filter((entry) => isGameSave(entry) && entry.payload);
  if (games.length === 0) {
    throw new Error(
      `${basename(path)} holds no Dezaemon 2 game save (looked for ` +
        `DEZA2____NN across ${entries.length} backup entries)`,
    );
  }
  const slot = options.slot ?? 0;
  if (slot < 0 || slot >= games.length) {
    throw new Error(
      `--slot ${slot} is out of range: ${
        basename(path)
      } holds ${games.length} ` +
        `game save(s) (0..${games.length - 1})`,
    );
  }
  const save = games[slot];
  if (games.length > 1) {
    notes.push(
      `slot ${slot} of ${games.length} (${save.filename}, "${save.comment}")`,
    );
  }

  const decoded = decodeSave(save.payload!.buffer);
  const { gameJson, sprites, warnings } = mapSaveToGame(decoded, {
    sourceEntry: save,
  });
  for (const warning of warnings ?? []) notes.push(String(warning));

  // Which stage. An explicit --stage is taken at its word (an empty one is an
  // error, not a silent substitution); without one, the first stage that has
  // anything on it — which is stage0 for every save that is not a demo.
  const wanted = options.stage ? stageKeyOf(options.stage) : null;
  const stageOf = (key: string) => gameJson[key] as StageRecord | undefined;
  const populated = Object.keys(gameJson)
    .filter((key) => /^stage\d+$/.test(key))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .filter((key) => spawnCount(stageOf(key)?.enemylist) > 0);
  const stageKey = wanted ?? populated[0] ?? DEFAULT_STAGE;
  const stage = stageOf(stageKey);
  if (!stage || !Array.isArray(stage.enemylist)) {
    throw new Error(`${basename(path)} has no ${stageKey}`);
  }
  if (spawnCount(stage.enemylist) === 0) {
    throw new Error(
      `${stageKey} of ${basename(path)} places no enemies` +
        (populated.length
          ? ` — try --stage ${populated.join(" / --stage ")}`
          : " (nor does any other stage)"),
    );
  }
  if (!wanted && stageKey !== DEFAULT_STAGE) {
    notes.push(`${DEFAULT_STAGE} is empty — exporting ${stageKey}`);
  }
  if (populated.length > 1) {
    notes.push(
      `the save has ${populated.length} stages; the console runs one — ` +
        `exporting ${stageKey}`,
    );
  }

  const enemylist = stage.enemylist;
  const atlas = packSprites(sprites);
  if (atlas) {
    notes.push(
      `${sprites.length} sprites from the save packed into ` +
        `${atlas.sheet.width}x${atlas.sheet.height}`,
    );
  }

  const name = options.name?.trim() || savTitle(path);
  const record: LevelRecord = {
    name,
    stageKey,
    enemylist,
    width: enemylist[0]?.length ?? 8,
    enemyData: gameJson.enemyData ?? {},
    bossData: gameJson.bossData ?? {},
    playerData: gameJson.playerData ?? {},
    dezaemonTitle: gameJson.dezaemonTitle,
  };
  // The editor only carries these when they line up with the grid, and the
  // runtime pairs them by index — a mismatch would silently re-time the stage.
  if (
    Array.isArray(stage.waveRows) && stage.waveRows.length === enemylist.length
  ) {
    record.waveRows = stage.waveRows;
    record.waveInterval = stage.waveInterval;
  }

  notes.push(
    `${enemylist.length} waves, ${enemylist[0]?.length ?? 0} columns, ` +
      `${Object.keys(record.enemyData ?? {}).length} enemy types, ` +
      `${Object.keys(record.bossData ?? {}).length} bosses`,
  );
  return { record, atlas, name, notes };
}
