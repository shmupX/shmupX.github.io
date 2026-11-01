#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Master Arena Mod: the community cart "Master Arena" (MA Project, Dezaemon
 * 2) as the shmupX cloud game `Master Arena Mod` — its ten stages exactly as
 * the cart plays them, with Mike Tyson as its first boss, fighting the way
 * the 2019 game's Barlog does, and Ryuda as its second.
 *
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts --serve
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts --apply
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts --revert
 *   deno run -A --node-modules-dir=none scripts/master-arena-mod/build-level.ts --sav "Dez 2 - Master Arena.sav"
 *
 * The parent is the library's cart, decoded the way every build by name
 * decodes one (the harbor's shelf: normalize → parse → decodeSave →
 * mapSaveToGame → levelRecordFromCart, as `deno task level:reimport` does),
 * so the mod is reproducible from any checkout; `--sav` reads a cart on
 * disk instead. Every stage, enemy, bullet, item, tune, title page and
 * credit strip of the cart goes into the record as the decode hands it
 * over. Two slots change:
 *
 * - `bossData/boss0`, tyson: the thirteen cells of monkey-kombat's
 *   assets/tyson.png (art/tyson.png here, 55x122 each), named by the
 *   animations src/sprites/tyson.js plays — shuffle, winkRight, winkLeft,
 *   bodyBlow, uppercut — as a boss record pinned to Barlog's routine
 *   (`attackPattern: "boss1"`: the slide across, the dash to the ship's x and
 *   the straight shot, the power dive, game.bundle.js bossPatternBarlog). The
 *   routine shows a boss's idle set and nothing else, so idle is the shuffle
 *   and the wink in Barlog's own rhythm (barlog_idle 0,1,2,0,3,4,3), and the
 *   wind-up, punch and uppercut ride on charge, shoot and attack for the
 *   Boss Lab and the cart. He throws Barlog's shot (the 2019 game's
 *   barlog_projectile0..2 out of the stock sheet, packed into the level's
 *   own) from the bare `bulletData` slot the routine fires, which the cart
 *   writer banks as weapon A. His bar, score and gauge are the slot's own —
 *   Master Arena's first boss, as the cart decodes it — so the stage costs
 *   what it cost; his shadow is Barlog's unflipped one.
 *   A Dezaemon 2 cart has no Barlog, so the record keeps the slot's
 *   `dezaemon` trailer — entrance, death, hp stages, the cart's hp and score
 *   — with its four patterns and playlist replaced by TYSON_PATTERNS: the
 *   cart's own movement scripts and fire points chosen to play Barlog's
 *   three moves on a Saturn (tysonTrailer). The web runtime never reads it
 *   (initDezaBoss opts out on `attackPattern`); the cart writer reads
 *   nothing else. Three things the cart cannot carry: Master Arena's own
 *   bullet bank fills all three of a cart's bullet types, so on the Saturn
 *   he throws the cart's first bullet rather than Barlog's (the writer says
 *   so: "a save holds three bullet types and they are all taken"); the
 *   routine's random choice of move is a fixed loop; and the cart's CG
 *   pages, 994 of 1024 cells full as the cart decodes and re-encodes, take
 *   his core (25 cells, two 64x128 frames of which most cells are the
 *   shared empty one) and Ryuda's (14) only by leaving the last 9 cells of
 *   the eighth stage's scenery unpainted (the writer's "CG pages full:
 *   background art left unpainted"; 585 scenery cells, 9 blank, only on
 *   that stage). A smaller Tyson would be a downscaled one; the web level
 *   has every cell.
 * - `bossData/boss1`, ryuda: the Character Library's `ryuda`
 *   (shmupX/characters/ryuda) exactly as `shmupx_place_character` would
 *   place her — her record, her atlas's frames packed under the level's
 *   sheet, the record renamed to the level's spelling — on her own Dezaemon
 *   record, hp and all, at the row and column the cart's second boss had.
 *   Her frames go in under a `ryuda_` prefix where the cart already spells
 *   the same name for other art (its dezaBullet2_* are the cart's bullets,
 *   not hers: not one pixel the same), and her stage-end backdrop is left
 *   off: every stage here has the cart's own scenery, which never shows one
 *   (README-Technical, "Stage-end backdrops"). On the Saturn her two parts
 *   are the records her fire points name, 37 and 38 of whatever stage she
 *   fights on — here Master Arena's stage 2 — as a placed Dezaemon boss's
 *   parts always are; the web runtime draws her own.
 *
 * Without --apply nothing is written. --out writes the record as it would
 * go up, for a play-through on `window.__OFFLINE_LEVEL__`; --serve plays it
 * on a local server the way mcp/lib/preview.ts previews a character —
 * `?stage=0&bossRush=1` opens on Tyson, `?stage=1&bossRush=1` on Ryuda.
 * --apply writes shmupX/levels/Master Arena Mod (shmupX's subtree, never
 * cmg's root; mcp/lib/rtdb.ts roots the path) under the ETag the slot was
 * read with, only into an empty slot (--force replaces it, keeping the
 * board its scores are on); --revert deletes it, only if it is this mod
 * (--force deletes whatever is there). The cart's own record in the library
 * (dezaemon/saves/master-arena) is read and never written.
 */

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
import {
  resolveShelfName,
  SHELF_DB,
  ShelfError,
} from "@shmupx/shmup-harbor/shelf";
import {
  decodeDataUrl,
  decodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import { encodeBossTrailer } from "@shmupx/shmup-engine";
import { validateGameJson } from "@shmupx/shmup-engine/game-schema";
import { decodeBossTrailer } from "../../packages/shmup-engine/src/decode/decode-boss.js";
import { gameIdForLevel } from "../../static/phaser-plugins/level-loader.js";
import {
  encodeFrameMap,
  type FrameRect,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "../../mcp/lib/art.ts";
import {
  type Character,
  getCharacter,
  referencedFrames,
  remapFrames,
} from "../../mcp/lib/character.ts";
import {
  dbPath,
  decodeFrameName,
  getWithEtag,
  put,
} from "../../mcp/lib/rtdb.ts";
import { badRtdbKey } from "../lib/rtdb-publish.ts";
import { creditsFromIndex } from "../reimport-cloud-level.ts";
import { packTo, PAD } from "../gs/build-stage2.ts";

// deno-lint-ignore no-explicit-any
export type Json = any;
export type Boss = Record<string, Json>;

/** The cloud level this writes: its key under shmupX/levels, and its name. */
export const LEVEL = "Master Arena Mod";
/** The cart it is a mod of: the library's title, and its slug there. */
export const PARENT = { name: "Master Arena", slug: "master-arena" };
/** The record's own account of what it is (meta.mod), which --revert checks. */
export const MOD_SCRIPT = "scripts/master-arena-mod/build-level.ts";

export const ART = new URL("./art/", import.meta.url);
/** The stock sheet Barlog's shot is cut out of. */
const STOCK_ASSETS = new URL(
  "../../static/games/2028-ai/assets/",
  import.meta.url,
);
/** The stock 2028.Ai recipe every cloud level is merged over. */
const STOCK_RECIPE = new URL("game.json", STOCK_ASSETS);
/**
 * The texture the runtime draws from is the stock atlas with the level's
 * sheet under it (_stackAtlas), and a phone's GPU takes only so tall a one.
 */
export const TEXTURE_LIMIT = 4096;

// ---- Tyson ------------------------------------------------------------------

export const TYSON = "tyson";
/** monkey-kombat's sheet: thirteen cells in a row. */
export const TYSON_SHEET = "tyson.png";
export const TYSON_CELL = { w: 55, h: 122 };
/**
 * The cells by the animation monkey-kombat plays them in
 * (src/sprites/tyson.js: shuffle 0-2, winkRight 3-4, winkLeft 5-6,
 * bodyBlow 7-8, uppercut 9-12), which is what the frames are named for.
 */
export const TYSON_CELLS: Record<string, number> = {
  tyson_shuffle0: 0,
  tyson_shuffle1: 1,
  tyson_shuffle2: 2,
  tyson_winkRight0: 3,
  tyson_winkRight1: 4,
  tyson_winkLeft0: 5,
  tyson_winkLeft1: 6,
  tyson_bodyBlow0: 7,
  tyson_bodyBlow1: 8,
  tyson_uppercut0: 9,
  tyson_uppercut1: 10,
  tyson_uppercut2: 11,
  tyson_uppercut3: 12,
};
/**
 * His stances. Barlog's routine shows idle and only idle, so idle is the
 * shuffle and the wink in the rhythm of Barlog's own idle list
 * (barlog_idle0,1,2,0,3,4,3). The wind-up, the punch and the uppercut are
 * the stances the other slots' routines switch between, and the cart's core
 * is drawn from idle and attack.
 */
export const TYSON_ANIM: Record<string, string[]> = {
  idle: [
    "tyson_shuffle0",
    "tyson_shuffle1",
    "tyson_shuffle2",
    "tyson_shuffle0",
    "tyson_winkRight0",
    "tyson_winkRight1",
    "tyson_winkRight0",
  ],
  charge: ["tyson_winkLeft0", "tyson_winkLeft1"],
  shoot: ["tyson_bodyBlow0", "tyson_bodyBlow1"],
  attack: [
    "tyson_uppercut0",
    "tyson_uppercut1",
    "tyson_uppercut2",
    "tyson_uppercut3",
  ],
};
/** Barlog's shot, as the 2019 game's boss1 fires it (game.json bulletData). */
export const BARLOG_SHOT = {
  damage: 1,
  hp: 8,
  score: 150,
  speed: 1.7,
  spgage: 5,
  texture: [
    "barlog_projectile0.gif",
    "barlog_projectile1.gif",
    "barlog_projectile2.gif",
  ],
};
/** The slot whose stock routine is Barlog's (bossPatternSlot). */
export const BARLOG_PATTERN = "boss1";
/** A 55x122 frame is the Saturn's F2 core, two 64x128 frames (bossClassFor). */
export const TYSON_SIZE_CLASS = 2;
/**
 * The Saturn's Tyson: the cart's own movement scripts and fire points
 * playing Barlog's three moves (packages/shmup-engine/FORMAT.md, "Boss
 * record — the 0x40 trailer"; the scripts are data/boss-move-scripts.json,
 * and a pattern runs its script to the end before the playlist moves on,
 * so a pattern is one of his moves). Every pattern runs at speed 7, the
 * fastest, which makes each 1.5-3 s long — Barlog's moves are 1.2-2.1 s —
 * and fires weapon A (his bulletData) from 20 px under his centre, where
 * bossShootStraight spawns a shot, on a 60-frame tick at rate 0: once a
 * move, as Barlog fires once a move, twice over the long dive.
 *
 * 0. REPOSITION SHOT — script 22: 48 px left, a 96 px swoop to the right
 *    dipping 48 px, 48 px back to the park. The widest reposition across
 *    the upper field that comes back; the shot is straight down (fn 1,
 *    unaimed), as Barlog's.
 * 1. TRACK + SHOT — script 31: the heading re-aims at the ship as he comes
 *    160 px toward it and he stays where it ends. No script follows the
 *    ship's x the way Barlog does (0x20 is EVADE on x), so this is his dash
 *    to the ship, and the shot is aimed because he is not left above it.
 * 2. POWER DIVE — script 28: up 32 px, a hold, 192 px straight down at three
 *    times the speed, 162 px back up to the rest line. Barlog's rise, dive
 *    and return, from the park to the foot of the screen.
 * 3. REPOSITION SHOT, mirrored — script 23, the swoop of 22 the other way.
 *
 * Shot function 1 is a single shot; bit 4 of the param aims it at the ship.
 * The second and third fire points stay empty (function 0 never fires).
 */
export const TYSON_PATTERNS: Json[] = [
  { moveScript: 22, moveSpeed: 7, fireTickFrames: 60, firePoints: [shot()] },
  {
    moveScript: 31,
    moveSpeed: 7,
    fireTickFrames: 60,
    firePoints: [shot({ aimed: true })],
  },
  { moveScript: 28, moveSpeed: 7, fireTickFrames: 60, firePoints: [shot()] },
  { moveScript: 23, moveSpeed: 7, fireTickFrames: 60, firePoints: [shot()] },
];
/**
 * The three hp bands the cart's first boss has (hpStages 3), each a
 * reposition, the dash, the other reposition and the dive, in Barlog's
 * 30/50/20 mix as near as a loop of four gets. The dive never follows the
 * dash: script 31 leaves him up to 160 px lower with no snap back to the
 * park, and a 192 px dive from there would leave the screen. The fourth
 * row is the unused fourth band, zero as the cart's is.
 */
export const TYSON_PLAYLIST = [[0, 1, 3, 2], [1, 0, 2, 3], [1, 3, 2, 1], [
  0,
  0,
  0,
  0,
]];

/** A weapon-A fire point, 20 px under the boss's centre, firing every tick. */
function shot({ aimed = false } = {}): Json {
  return { dx: 0, dy: 20, type: 0, rate: 0, param: 1 | (aimed ? 0x10 : 0) };
}

/**
 * The slot's Dezaemon trailer with Tyson's patterns and playlist in it, at
 * his size class, spelled as decode-boss.js spells a decoded one: it is
 * encoded as the writer will encode it and decoded again, so what the
 * record carries is what a reader of the written cart gets back, byte for
 * byte — the decoded `shot` of every fire point, the empty fire points,
 * and an `arrival.scroll` nudged for the larger core, included.
 */
export function tysonTrailer(trailer: Boss): Boss {
  return decodeBossTrailer(encodeBossTrailer({
    ...trailer,
    sizeClass: TYSON_SIZE_CLASS,
    patterns: TYSON_PATTERNS,
    playlist: TYSON_PLAYLIST,
  })) as Boss;
}

/**
 * Tyson's record, over the slot the cart's first boss held. The slot's bar,
 * score, gauge and Dezaemon trailer stay; the art, the routine, the shot
 * and the shadow are his.
 */
export function tysonRecord(slot: Boss): Boss {
  const deza = slot.dezaemon ?? {};
  return {
    name: TYSON,
    attackPattern: BARLOG_PATTERN,
    anim: structuredClone(TYSON_ANIM),
    bulletData: structuredClone(BARLOG_SHOT),
    hp: slot.hp,
    score: slot.score,
    spgage: slot.spgage,
    // Barlog's: the web runtime never reads it, the Boss Lab shows it.
    interval: 200,
    // Barlog's unflipped silhouette, 5 px under a frame's foot.
    shadowReverse: false,
    shadowOffsetY: TYSON_CELL.h - 5,
    dezaemon: {
      sizeClass: TYSON_SIZE_CLASS,
      ...(Number.isInteger(deza.row) ? { row: deza.row } : {}),
      ...(Number.isInteger(deza.col) ? { col: deza.col } : {}),
      boss: tysonTrailer(deza.boss ?? {}),
    },
  };
}

/** The thirteen cells, cut out of the sheet and named. */
export function tysonFrames(sheet: Raster): ResolvedFrame[] {
  const { w, h } = TYSON_CELL;
  const cells = Math.floor(sheet.width / w);
  if (sheet.height !== h || cells < Object.keys(TYSON_CELLS).length) {
    throw new Error(
      `${TYSON_SHEET} is ${sheet.width}x${sheet.height}; expected ` +
        `${Object.keys(TYSON_CELLS).length} cells of ${w}x${h} in a row`,
    );
  }
  return Object.entries(TYSON_CELLS).map(([name, cell]) => ({
    name,
    raster: cut(sheet, { x: cell * w, y: 0, w, h }),
    source: `${TYSON_SHEET}#${cell}`,
    scope: TYSON,
  }));
}

// ---- Ryuda ------------------------------------------------------------------

export const RYUDA = "ryuda";

/**
 * The name a frame of hers has in this level: her own where it is hers
 * alone, `ryuda_` in front of a name the cart spells too. Stage-end art is
 * left out: a stage with Dezaemon scenery never shows one.
 */
export function ryudaRename(
  character: Character,
): { rename: Record<string, string>; frames: string[] } {
  const bg = character.stageBgEnd;
  const backdrop = typeof bg === "string"
    ? bg
    : bg && typeof bg === "object"
    ? (bg as { frame?: unknown }).frame
    : null;
  const rename: Record<string, string> = {};
  const frames: string[] = [];
  for (const name of referencedFrames(character)) {
    if (name === backdrop) continue;
    const target = name.toLowerCase().startsWith(RYUDA)
      ? name
      : `${RYUDA}_${name}`;
    if (target !== name) rename[name] = target;
    frames.push(target);
  }
  return { rename, frames };
}

/**
 * Ryuda's record, placed into the slot the cart's second boss held: the
 * character as the library has her, renamed to this level's spelling, with
 * no stage-end backdrop, at the slot's row and column.
 */
export function ryudaRecord(character: Character, slot: Boss): Boss {
  const { rename } = ryudaRename(character);
  const { stageBgEnd: _bg, ...rest } = remapFrames(character, rename);
  const deza = slot.dezaemon ?? {};
  const own = (rest.dezaemon ?? {}) as Boss;
  return {
    ...rest,
    dezaemon: {
      ...own,
      ...(Number.isInteger(deza.row) ? { row: deza.row } : {}),
      ...(Number.isInteger(deza.col) ? { col: deza.col } : {}),
    },
  };
}

// ---- The record ---------------------------------------------------------------

export interface Sources {
  /** The cart as the shelf decodes it (plain frame names). */
  cart: Json;
  /** The library's index row for the cart, for its credits; null if none. */
  index?: Json | null;
  /** The catalog's ryuda. */
  ryuda: Character;
  /** Her frames, under the names ryudaRename gives them. */
  ryudaFrames: ResolvedFrame[];
  /** monkey-kombat's sheet. */
  tysonSheet: Raster;
  /** Barlog's three shot frames, under their stock names. */
  barlogShots: ResolvedFrame[];
  /** How tall the stock sheet is: the level's goes under it. */
  stockAtlasHeight: number;
  /**
   * The stock sheet's frame names: what the runtime and the cart writer
   * fall back to for a frame the level's own sheet lacks.
   */
  stockFrames: Set<string>;
  /** The stock recipe's playerData, for the schema check. */
  stockPlayer?: Json;
}

export interface Plan {
  record: Json;
  bosses: Record<string, { before: string; after: string }>;
  added: { frame: string; source: string }[];
  reused: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  warnings: string[];
}

/** Every frame name the record's casts name, by the record that names it. */
function namedFrames(record: Json): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (owner: string, name: string) => {
    const list = out.get(name) ?? [];
    list.push(owner);
    out.set(name, list);
  };
  for (const key of ["enemyData", "bossData"]) {
    for (const [k, rec] of Object.entries(record[key] ?? {})) {
      for (const name of referencedFrames(rec as Character)) {
        add(`${key}/${k}`, name);
      }
    }
  }
  for (const key of ["playerData", "playerData2"]) {
    const texture = record[key]?.texture;
    if (Array.isArray(texture)) {
      for (const name of texture) if (typeof name === "string") add(key, name);
    }
  }
  return out;
}

/** The record this writes, from its sources, and what changed. */
export async function plan(sources: Sources): Promise<Plan> {
  const { cart, ryuda, ryudaFrames, tysonSheet, barlogShots } = sources;
  const warnings: string[] = [];
  const bossData = cart.bossData ?? {};
  for (const slot of ["boss0", "boss1"]) {
    const b = bossData[slot];
    if (!b || typeof b !== "object" || !b.dezaemon?.boss) {
      throw new Error(
        `the cart's ${slot} is ${JSON.stringify(b?.name ?? null)}, not a ` +
          `Dezaemon boss — this is not ${PARENT.name} as the shelf decodes it`,
      );
    }
  }
  if (!cart.atlasImageDataURL || !cart.atlasFrames) {
    throw new Error("the cart's record has no atlas");
  }

  // The two records.
  const tyson = tysonRecord(bossData.boss0);
  const placed = ryudaRecord(ryuda, bossData.boss1);
  const { frames: wanted } = ryudaRename(ryuda);
  const brought = new Set(ryudaFrames.map((f) => f.name));
  const short = wanted.filter((n) => !brought.has(n));
  if (short.length) {
    throw new Error(`no art for ryuda's ${short.join(", ")}`);
  }

  // The art, under the cart's sheet. A name the cart already has is reused
  // — Tyson's and Ryuda's are new by construction, Barlog's stock names
  // would be too — and never repainted.
  const cartFrames: Record<string, FrameRect> = {};
  for (const [k, v] of Object.entries(cart.atlasFrames)) {
    cartFrames[decodeFrameName(k)] = v as FrameRect;
  }
  const pull: ResolvedFrame[] = [];
  const reused: string[] = [];
  const seen = new Set<string>();
  for (
    const f of [...tysonFrames(tysonSheet), ...barlogShots, ...ryudaFrames]
  ) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    if (cartFrames[f.name]) reused.push(f.name);
    else pull.push(f);
  }
  const before = await decodeDataUrl(cart.atlasImageDataURL);
  const { sheet, frames: packed } = packTo(before.width, pull);
  const after = newRaster(
    Math.max(before.width, sheet.width),
    before.height + PAD + sheet.height,
  );
  blit(after, before, 0, 0);
  blit(after, sheet, 0, before.height + PAD);
  const atlasFrames: Record<string, FrameRect> = { ...cartFrames };
  for (const [name, rect] of Object.entries(packed)) {
    atlasFrames[name] = {
      ...rect,
      frame: { ...rect.frame, y: rect.frame.y + before.height + PAD },
    };
  }
  const stacked = sources.stockAtlasHeight + after.height;
  if (stacked > TEXTURE_LIMIT) {
    throw new Error(
      `the stacked atlas is ${stacked} rows tall; phones take ${TEXTURE_LIMIT}`,
    );
  }

  // The record: the cart's decode, as the editor's SAVE lays a level out,
  // with the two slots replaced and what the shelf does not know filled in.
  const record: Json = {};
  for (const [k, v] of Object.entries(cart)) {
    if (v === undefined || v === null) continue;
    record[k] = v;
  }
  record.name = LEVEL;
  record.gameId = gameIdForLevel({ name: LEVEL });
  record.bossData = { ...bossData, boss0: tyson, boss1: placed };
  record.atlasImageDataURL = await sheetDataUrl(after);
  record.atlasFrames = encodeFrameMap(atlasFrames);
  record.dezaemonCredits = creditsFromIndex(sources.index) ??
    cart.dezaemonCredits ?? { title: PARENT.name };
  record.meta = {
    ...(cart.meta ?? { version: "1.0" }),
    mod: {
      parent: PARENT.name,
      slug: PARENT.slug,
      script: MOD_SCRIPT,
      bosses: { boss0: TYSON, boss1: RYUDA },
    },
  };
  delete record.frameThumbnails;

  // --- checks: a record the runtime would quietly mis-draw is not written.
  // The two slots this writes carry every frame they name; the cart's own
  // records may name the stock sheet's (its zako fire normalProjectile),
  // which both the runtime and the cart writer fall back to.
  for (const [name, owners] of namedFrames(record)) {
    if (atlasFrames[name]) continue;
    const ours = owners.filter((o) =>
      o === "bossData/boss0" || o === "bossData/boss1"
    );
    if (ours.length) {
      throw new Error(`${ours.join(", ")} names ${name}, which no sheet has`);
    }
    if (sources.stockFrames.has(name)) continue;
    warnings.push(
      `${name} is in neither the cart's sheet nor the stock one (${owners.length} record${
        owners.length === 1 ? "" : "s"
      }: ${owners[0]}${owners.length > 1 ? ", …" : ""})`,
    );
  }
  const bad = badRtdbKey(record);
  if (bad) throw new Error(`RTDB refuses the key at ${bad}`);
  const stockPlayer = sources.stockPlayer ??
    JSON.parse(await Deno.readTextFile(STOCK_RECIPE)).playerData;
  const stages: Json = {};
  for (const [k, v] of Object.entries(record.stages ?? {})) {
    if (/^stage\d+$/.test(k)) stages[k] = v;
  }
  const schema = validateGameJson({
    ...stages,
    enemyData: record.enemyData,
    bossData: record.bossData,
    playerData: { ...stockPlayer, ...record.playerData },
    ...(record.playerData2 ? { playerData2: record.playerData2 } : {}),
    // The cart's scenery: each stage's tile grid over the cells it names.
    ...(record.backgroundCells
      ? { backgroundCells: record.backgroundCells }
      : {}),
    meta: record.meta,
  });
  if (!schema.ok) throw new Error(`schema: ${schema.errors.join("; ")}`);
  warnings.push(...schema.warnings.map((w: string) => `schema: ${w}`));

  return {
    record,
    bosses: {
      boss0: { before: String(bossData.boss0.name), after: tyson.name },
      boss1: {
        before: String(bossData.boss1.name),
        after: String(placed.name),
      },
    },
    added: pull.map((f) => ({ frame: f.name, source: f.source })),
    reused,
    atlas: {
      before: { w: before.width, h: before.height },
      after: { w: after.width, h: after.height },
    },
    warnings,
  };
}

/** What a dry run prints. */
export function summary(p: Plan): Json {
  const bytes = (v: unknown) =>
    new TextEncoder().encode(JSON.stringify(v)).length;
  const r = p.record;
  const stages = Object.keys(r.stages ?? {}).filter((k) =>
    /^stage\d+$/.test(k)
  );
  return {
    level: dbPath(`levels/${LEVEL}`),
    gameId: r.gameId,
    parent: `${PARENT.name} (${PARENT.slug})`,
    credits: r.dezaemonCredits,
    stages: stages.length,
    enemies: Object.keys(r.enemyData ?? {}).length,
    bosses: Object.fromEntries(
      Object.entries(r.bossData).map(([k, b]: [string, Json]) => [
        k,
        `${b.name}${b.attackPattern ? ` (${b.attackPattern})` : ""} hp ${b.hp}`,
      ]),
    ),
    changed: p.bosses,
    added: p.added.length,
    reused: p.reused,
    atlas: p.atlas,
    bytes: { record: bytes(r), atlas: r.atlasImageDataURL.length },
    warnings: p.warnings,
  };
}

// ---- The sources ----------------------------------------------------------------

/** The cart, decoded by the shelf: the library's, or `--sav <file>`. */
export async function loadCart(
  savFile: string | null = null,
  log: (s: string) => void = () => {},
): Promise<Json> {
  let hit;
  try {
    hit = await resolveShelfName(
      savFile ? `sav:${savFile}` : `deza:${PARENT.name}`,
      { name: PARENT.name, refresh: true, log },
    );
  } catch (e) {
    if (e instanceof ShelfError) throw new Error(e.message);
    throw e;
  }
  if (!hit.levelFile) {
    throw new Error(`the shelf answered ${PARENT.name} with no record`);
  }
  return JSON.parse(await Deno.readTextFile(hit.levelFile));
}

/** The library's index row for the cart, or null when it is not listed. */
export async function loadIndexRow(): Promise<Json | null> {
  try {
    const res = await fetch(
      `${SHELF_DB}/dezaemon/index/${encodeURIComponent(PARENT.slug)}.json`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json();
  } catch (_e) {
    return null;
  }
}

/** The catalog's ryuda and her frames, cut from her atlas under her names here. */
export async function loadRyuda(): Promise<
  { character: Character; frames: ResolvedFrame[] }
> {
  const character = await getCharacter(RYUDA);
  const atlas = typeof character.textureKey === "string"
    ? character.textureKey
    : RYUDA;
  const { rename, frames } = ryudaRename(character);
  const back = Object.fromEntries(
    Object.entries(rename).map(([from, to]) => [to, from]),
  );
  const resolved: ResolvedFrame[] = [];
  for (const name of frames) {
    resolved.push(
      await resolveFrame({ atlas, frame: back[name] ?? name, as: name }),
    );
  }
  return { character, frames: resolved };
}

export async function loadTysonSheet(): Promise<Raster> {
  return await decodePng(
    await Deno.readFile(fromFileUrl(new URL(TYSON_SHEET, ART))),
  );
}

/**
 * The stock sheet: Barlog's shot frames cut out of it under their stock
 * names, and its height.
 */
export async function loadStockArt(): Promise<
  { barlogShots: ResolvedFrame[]; height: number; frames: Set<string> }
> {
  const atlas = JSON.parse(
    await Deno.readTextFile(
      fromFileUrl(new URL("game_asset.json", STOCK_ASSETS)),
    ),
  );
  const image = String(atlas.meta.image);
  const sheet = await decodePng(
    await Deno.readFile(fromFileUrl(new URL(image, STOCK_ASSETS))),
  );
  const barlogShots = BARLOG_SHOT.texture.map((name) => {
    const rect = atlas.frames[name]?.frame;
    if (!rect) throw new Error(`the stock sheet has no ${name}`);
    return {
      name,
      raster: cut(sheet, rect),
      source: `static/games/2028-ai/assets/${image}#${name}`,
      scope: "game_asset",
    };
  });
  return {
    barlogShots,
    height: Number(atlas.meta.size.h),
    frames: new Set(Object.keys(atlas.frames)),
  };
}

export async function loadSources(
  { savFile = null, log = () => {} }: {
    savFile?: string | null;
    log?: (s: string) => void;
  } = {},
): Promise<Sources> {
  const cart = await loadCart(savFile, log);
  const [index, ryuda, tysonSheet, stock] = await Promise.all([
    loadIndexRow(),
    loadRyuda(),
    loadTysonSheet(),
    loadStockArt(),
  ]);
  return {
    cart,
    index,
    ryuda: ryuda.character,
    ryudaFrames: ryuda.frames,
    tysonSheet,
    barlogShots: stock.barlogShots,
    stockAtlasHeight: stock.height,
    stockFrames: stock.frames,
  };
}

// ---- Writing ----------------------------------------------------------------

/** Is this record the mod this script writes? */
export function isThisMod(record: Json | null): boolean {
  return !!record && typeof record === "object" &&
    record.meta?.mod?.script === MOD_SCRIPT &&
    record.meta?.mod?.parent === PARENT.name;
}

/** Write the record, under the ETag its slot was read with. */
export async function apply(
  record: Json,
  { force = false } = {},
): Promise<string> {
  const path = `levels/${LEVEL}`;
  const { value, etag } = await getWithEtag<Json>(path, {
    timeoutMs: 120_000,
  });
  if (value != null) {
    if (!force) {
      throw new Error(
        `${dbPath(path)} already holds a level; --force replaces it`,
      );
    }
    // a replacement keeps the board the scores are on
    if (typeof value.gameId === "string") record.gameId = value.gameId;
  }
  await put(path, { ...record, savedAt: { ".sv": "timestamp" } }, {
    ifMatch: etag,
    timeoutMs: 180_000,
  });
  return dbPath(path);
}

/** Delete the record — only this mod's, unless forced. */
export async function revert({ force = false } = {}): Promise<string> {
  const path = `levels/${LEVEL}`;
  const { value, etag } = await getWithEtag<Json>(path, {
    timeoutMs: 120_000,
  });
  if (value == null) return `${dbPath(path)} is already empty`;
  if (!isThisMod(value) && !force) {
    throw new Error(
      `${dbPath(path)} is not the mod ${MOD_SCRIPT} writes; --force deletes it`,
    );
  }
  await put(path, null, { ifMatch: etag });
  return `${dbPath(path)} deleted`;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["apply", "revert", "force", "serve"],
    string: ["out", "port", "sav"],
    default: { port: "8823" },
  });
  if (args.revert) {
    console.log(await revert({ force: args.force }));
    Deno.exit(0);
  }
  const sources = await loadSources({
    savFile: args.sav ?? null,
    log: (s) => console.log(s),
  });
  const built = await plan(sources);
  console.log(JSON.stringify(summary(built), null, 2));
  if (args.out) {
    await Deno.writeTextFile(
      args.out,
      JSON.stringify({ ...built.record, savedAt: Date.now() }),
    );
    console.log(`wrote ${args.out}`);
  }
  if (args.apply) {
    console.log(`written: ${await apply(built.record, { force: args.force })}`);
  } else if (args.serve) {
    const { startServer } = await import(
      "../../packages/shmup-harbor/tools/sav-profiler/lib/web.ts"
    );
    const server = startServer(built.record, { port: Number(args.port) });
    console.log(
      `playing on ${server.url}/games/2028-ai ` +
        `(?stage=0&bossRush=1 opens on Tyson, ?stage=1&bossRush=1 on Ryuda)`,
    );
  } else {
    console.log("nothing written (--apply writes it, --revert takes it back)");
  }
  // The shelf libraries open a BroadcastChannel to tell the other tabs a
  // browser would have; under Deno it has nobody to tell and keeps the event
  // loop alive, so without this the process sits here after its last line.
  if (!args.serve) Deno.exit(0);
}
