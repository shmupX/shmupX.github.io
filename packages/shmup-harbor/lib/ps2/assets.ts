// Turn one level record into the file set the PS2 build boots with.
//
// The editor stores a level as its wave grid plus a custom sprite atlas
// stacked on top of the base game's, exactly as the browser player composites
// them (see the level-loader plugin). Here the same merge happens ahead of
// time and the result is repacked into console-sized sheets:
//
//   assets/game_asset.png|json   the base sprite atlas, repacked
//   assets/game_ui.png|json      the base HUD atlas, repacked
//   assets/cyber_liberty.png     the player, as the 32x32 grid sheet ps2-sp wants
//   assets/game.json             the base recipe (player/enemy/boss stats),
//                                with a whole-game record's own later stages
//                                laid over the base game's
//   assets/level.json            this stage's waves (one-character enemy codes)
//                                and the enemy/boss records the disc can spawn
//   assets/level_atlas.png|json  every frame the exported game can draw
//
// ps2-sp tags each of the level's own enemies with the `level_atlas` texture,
// so the level atlas has to be self-sufficient: a frame the level references
// but never customised is pulled from the base sheet rather than left dangling.
// It also has to stay small enough to keep its resolution: only the enemy
// types the console will actually spawn, and the frames of the bosses it will
// actually fight, go in (stageRecipes, bossFrames) — and that is more than the
// exported stage's, because the port plays on into the stages after it
// (laterStages). The bosses' own bullets are the one thing that goes on
// game_asset instead, because that is where the port looks for them.

import { join } from "@std/path";
import {
  decodeDataUrl,
  decodePng,
  encodeIndexedPng,
  newRaster,
  type Raster,
} from "./png.ts";
import {
  buildPs2Atlas,
  type BuiltAtlas,
  type FrameEntry,
  type SourceFrame,
} from "./atlas.ts";
import { quantize } from "./palette.ts";
import { blit, cut, fitInto, resizeTo } from "./raster.ts";

/** A Firebase `levels/{name}` record, as the editor saves it. */
export interface LevelRecord {
  name?: string;
  enemylist?: string[][];
  stageKey?: string;
  width?: number;
  waveRows?: number[];
  waveInterval?: number;
  enemyData?: Record<string, Record<string, unknown>>;
  bossData?: Record<string, Record<string, unknown>>;
  playerData?: Record<string, unknown>;
  /**
   * Every stage of the game, as the editor saves a whole-game record
   * (`stages.stageN.enemylist`). `enemylist` above is the one at `stageKey`;
   * the console plays on through the ones after it, so they ship too.
   */
  stages?: Record<string, { enemylist?: string[][] } & Record<string, unknown>>;
  atlasFrames?: Record<string, FrameEntry>;
  atlasImageDataURL?: string;
  /**
   * A Dezaemon save's own drawn title screen: role -> the atlas frame name
   * holding it. `mapSaveToGame` writes this from the save's TITLE 1/2 and
   * credit strips.
   */
  dezaemonTitle?: Record<string, string>;
  /**
   * Where the game came from — `{ source: "dezaemon2", … }` for an import.
   * The console has no use for it; it is here so this record cannot be handed
   * to a browser or app build looking like a stock level (see
   * lib/imported-level.ts).
   */
  meta?: Record<string, unknown>;
  /** No adventure interludes, which is every Dezaemon import. */
  noStory?: boolean;
}

export interface StagedFile {
  path: string;
  data: Uint8Array;
}

export interface StageResult {
  files: StagedFile[];
  /** Human-readable notes for the build log. */
  notes: string[];
}

/** One frame, and which sheet it must be cut from. */
export interface IndexedFrame {
  sheet: Raster;
  entry: FrameEntry;
}

// Firebase keys cannot contain '.', so the editor stores frame names with a
// one-dot-leader in its place. The browser player reverses this the same way.
const decodeKey = (key: string) => key.replace(/․/g, ".");

const textEncoder = new TextEncoder();
const json = (value: unknown) => textEncoder.encode(JSON.stringify(value));

/**
 * Build the name -> (sheet, rect) index the rest of the staging works from:
 * the base atlas, with the level's custom atlas laid over it. A custom frame
 * wins over a base frame of the same name, and also claims the opposite
 * .gif/.png spelling, which is how the browser player resolves them.
 */
function buildFrameIndex(
  baseSheet: Raster,
  baseFrames: Record<string, FrameEntry>,
  custom: { sheet: Raster; frames: Record<string, FrameEntry> } | null,
): Map<string, IndexedFrame> {
  const index = new Map<string, IndexedFrame>();
  for (const [name, entry] of Object.entries(baseFrames)) {
    index.set(name, { sheet: baseSheet, entry });
  }
  if (!custom) return index;
  for (const [rawName, data] of Object.entries(custom.frames)) {
    if (!data || !data.frame) continue;
    const name = decodeKey(rawName);
    const { w, h } = data.frame;
    const entry: FrameEntry = {
      frame: { x: data.frame.x, y: data.frame.y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
    };
    index.set(name, { sheet: custom.sheet, entry });
    const alt = name.endsWith(".png")
      ? name.slice(0, -4) + ".gif"
      : name.endsWith(".gif")
      ? name.slice(0, -4) + ".png"
      : null;
    if (alt) index.set(alt, { sheet: custom.sheet, entry });
  }
  return index;
}

/** Exact name first, then the other of .gif/.png — ps2-sp's own fallback. */
function resolve(
  index: Map<string, IndexedFrame>,
  name: string,
): IndexedFrame | null {
  const direct = index.get(name);
  if (direct) return direct;
  const alt = name.endsWith(".gif")
    ? name.slice(0, -4) + ".png"
    : name.endsWith(".png")
    ? name.slice(0, -4) + ".gif"
    : null;
  return alt ? index.get(alt) ?? null : null;
}

// Every texture array reachable from an entity record. The shapes differ
// between the web export (anim.idle / bulletData) and the PS2 port
// (texture / projectileData), and a record can carry either, so collect both.
function collectTextures(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (key === "texture" || key === "attackTexture" || key === "itemTexture") {
      if (Array.isArray(child)) {
        for (const frame of child) {
          if (typeof frame === "string" && frame) into.add(frame);
        }
      }
      continue;
    }
    if (key === "anim" && child && typeof child === "object") {
      for (const list of Object.values(child as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const frame of list) {
          if (typeof frame === "string" && frame) into.add(frame);
        }
      }
      continue;
    }
    if (child && typeof child === "object") collectTextures(child, into);
  }
}

/** `value.texture`, when it is a list that names at least one frame. */
function textureOf(value: unknown): string[] | null {
  const list = (value as { texture?: unknown } | null | undefined)?.texture;
  return Array.isArray(list) && list.length > 0 ? list as string[] : null;
}

/**
 * The frames the port draws a boss with: its `texture`, or `anim.idle` for a
 * web-shaped record — normalizeRecipe copies the one into the other at boot.
 *
 * Nothing else of a boss reaches the screen. `attackTexture` is filled in and
 * never read, and the other `anim` lists (charge, shoot, wait, …) drive attack
 * patterns only the browser engine has. Collecting all of them, the way an
 * enemy's textures are collected, put 43 frames on the sheet for the five
 * stock bosses where 16 are ever drawn — and with five bosses to carry, that
 * is the difference between the level atlas at full size and at 1/4.
 */
function bossFrames(boss: Record<string, unknown>): string[] {
  const anim = boss.anim as { idle?: unknown } | null | undefined;
  return textureOf(boss) ?? textureOf({ texture: anim?.idle }) ?? [];
}

/**
 * The frame lists a boss fires: `projectileData` — or `bulletData`, which
 * normalizeRecipe turns into it — and `projectileDataA`, the one further slot
 * a port attack pattern reads (the second boss's spread). The B and C slots
 * are the browser engine's.
 */
function bossShotLists(boss: Record<string, unknown>): string[][] {
  return [
    textureOf(boss.projectileData) ?? textureOf(boss.bulletData),
    textureOf(boss.projectileDataA),
  ].filter((list): list is string[] => list !== null);
}

/**
 * Pack the level's own atlas — a size up from the other sheets, when that is
 * what keeps it at full size.
 *
 * Five stages of sprites can outgrow the 512 sheet one stage fitted: the 2019
 * game's come out at 1/2 there, and half size is where a 32px enemy starts to
 * smear. When that happens this sheet may take one doubling more than
 * `maxSheet` — 512x1024 at the default, 0.5 MB paletted, which with the two
 * base sheets and the frame buffer is 3.19 MB of the GS's 4 (encodeSheet;
 * scripts/lib/testdrive-textures.ts counts it the same way) — and never past
 * the GS's 1024. Only when it buys the scale back, though: a set that fits
 * packs exactly as it always did. And not when a title cover has already
 * spent that margin on game_ui.
 */
export function buildLevelAtlas(
  frames: SourceFrame[],
  budget: { maxSheet?: number; cover?: boolean } = {},
): BuiltAtlas {
  const maxSheet = budget.maxSheet ?? 512;
  const built = buildPs2Atlas(frames, "level_atlas.png", maxSheet);
  if (built.displayScale === 1 || budget.cover || maxSheet >= 1024) {
    return built;
  }
  const roomier = buildPs2Atlas(
    frames,
    "level_atlas.png",
    Math.min(maxSheet * 2, 1024),
    maxSheet * maxSheet * 2,
  );
  return roomier.displayScale < built.displayScale ? roomier : built;
}

/** The wave grid and enemy table as the disc's level.json carries them. */
export interface DiscStage {
  enemylist: string[][];
  /** The stages after this one, re-coded the same way (see laterStages). */
  later: Record<string, string[][]>;
  enemyData: Record<string, Record<string, unknown>>;
  /** Multi-character type -> the single character it became on the disc. */
  renamed: Record<string, string>;
  /** For the build log; empty when there was nothing to rewrite. */
  note: string;
}

// Every character a type may become. Never `0`: `00` is the empty cell.
const CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz123456789";

/**
 * Rewrite the wave grid into enemy codes the port cannot misread.
 *
 * A grid cell is `<type><item>`, and the browser reads the type as everything
 * but the last character, so a Dezaemon import with more than 26 enemy types
 * spawns `CM0` as enemyCM. The PS2 port (svelte-ps2 1.1.0, spawnEnemyWave)
 * takes only the first character: `CM0` becomes enemyC, `BE0` enemyB, `AQ0`
 * enemyA — whatever the save's first records happen to be. In Master Arena
 * Mod those are single-pixel "star" sprites, which is exactly what the console
 * showed in place of every enemy on that stage: dots that could hit and be
 * hit, and nothing else.
 *
 * Rather than wait on the port, the disc gets a grid with one character per
 * type: a single-character type keeps its letter, every other type takes the
 * next unused one (upper case, then lower case, then 1-9), and enemyData is
 * re-keyed to match. Both readings agree on a one-character code, so this is
 * right whichever runtime opens it. Only the types some grid names ship, which
 * also takes level.json from hundreds of records to a few dozen. A game with
 * more types than there are characters keeps the leftovers as they were and
 * says so; a grid that names nothing the record knows ships unchanged.
 *
 * `later` is the grids of the stages the console plays after this one
 * (laterStages). They spawn from the same enemyData, so they are read for
 * types and re-coded with the very same map, and come back re-coded.
 */
export function discStage(
  record: LevelRecord,
  later: Record<string, string[][]> = {},
): DiscStage {
  const enemyData = record.enemyData ?? {};
  const grid = record.enemylist ?? [];
  const unchanged: DiscStage = {
    enemylist: grid,
    later,
    enemyData,
    renamed: {},
    note: "",
  };
  if (Object.keys(enemyData).length === 0) return unchanged;

  const typeOf = (cell: unknown): string | null => {
    const code = String(cell ?? "");
    if (!code || code === "00" || code.length < 2) return null;
    return code.slice(0, -1);
  };
  const types = new Set<string>();
  for (const rows of [grid, ...Object.values(later)]) {
    for (const row of rows) {
      for (const cell of row) {
        const type = typeOf(cell);
        if (type) types.add(type);
      }
    }
  }
  const known = [...types].filter((type) => `enemy${type}` in enemyData)
    .sort();
  if (known.length === 0) return unchanged;

  const taken = new Set(known.filter((type) => type.length === 1));
  const pool = [...CODE_CHARS].filter((c) => !taken.has(c));
  const renamed: Record<string, string> = {};
  const leftover: string[] = [];
  for (const type of known) {
    if (type.length === 1) continue;
    const next = pool.shift();
    if (next === undefined) leftover.push(type);
    else renamed[type] = next;
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const type of known) {
    out[`enemy${renamed[type] ?? type}`] = enemyData[`enemy${type}`];
  }
  const recode = (rows: string[][]) =>
    rows.map((row) =>
      row.map((cell) => {
        const type = typeOf(cell);
        const to = type ? renamed[type] : undefined;
        return to ? to + String(cell).slice(-1) : cell;
      })
    );
  const enemylist = recode(grid);
  const laterOut: Record<string, string[][]> = {};
  for (const [key, rows] of Object.entries(later)) laterOut[key] = recode(rows);

  const renames = Object.keys(renamed).length;
  const laterCount = Object.keys(later).length;
  const note = `level.json: ${known.length} enemy type(s) on the grid` +
    (laterCount ? ` and the ${laterCount} stage(s) after it` : "") +
    (renames
      ? `, ${renames} re-coded to one character for the port (${
        Object.entries(renamed).slice(0, 3).map(([from, to]) =>
          `${from}->${to}`
        ).join(", ")
      }${renames > 3 ? ", …" : ""})`
      : "") +
    (leftover.length
      ? `; ${leftover.length} more than there are codes, left as they were (${
        leftover.slice(0, 3).join(", ")
      }${leftover.length > 3 ? ", …" : ""})`
      : "");
  return { enemylist, later: laterOut, enemyData: out, renamed, note };
}

/** The port's last stage: `stageId` is clamped to it and the game ends after it. */
const LAST_STAGE = 4;

/** The exported stage's number, as the port reads it off `stageKey`. */
function stageNumberOf(record: LevelRecord): number {
  const stageKey = record.stageKey ?? "stage0";
  return Number(/^stage(\d+)$/.exec(stageKey)?.[1] ?? 0);
}

/** A stage record's wave grid, when it has one. */
function gridOf(stage: unknown): string[][] | null {
  const list = (stage as { enemylist?: unknown } | null | undefined)?.enemylist;
  return Array.isArray(list) ? list as string[][] : null;
}

/**
 * The stages the console plays AFTER the exported one, in the order it plays
 * them, with the grid each will run.
 *
 * level.json carries one stage, but the port does not stop when it ends: as
 * its boss falls, `stageId++`, and the next stage of game.json begins, on up
 * to the fifth. Those stages spawn from the same enemyData the level replaced
 * the base recipe's with, and draw from the level atlas — so whatever they
 * name has to be on the disc too. Cutting level.json to the exported stage's
 * own types left an export of the base game with no enemies at all on its
 * stage 2 (the first stage's four types were the only ones that shipped) and
 * no visible boss after the first (the other four had no frames to draw).
 *
 * Nor does it stop at the fifth. The ending resets the game (resetGameState:
 * `stageId = 0`) and the next one starts from stage0, still out of the tables
 * the level merged in at boot — loadFirebaseLevel runs once. So a disc
 * exported from stage2 plays stage0 and stage1 too, on its second game, and
 * they follow the stages after it here.
 *
 * A whole-game record — the editor's `stages` — supplies its own grid for
 * each of them; any other record plays the base game's, as the port did.
 */
export function laterStages(
  record: LevelRecord,
  base: Record<string, unknown>,
): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  const first = Math.min(stageNumberOf(record), LAST_STAGE);
  const order: number[] = [];
  for (let id = first + 1; id <= LAST_STAGE; id++) order.push(id);
  for (let id = 0; id < first; id++) order.push(id);
  for (const id of order) {
    const key = `stage${id}`;
    const grid = gridOf(record.stages?.[key]) ?? gridOf(base[key]);
    if (grid) out[key] = grid;
  }
  return out;
}

/** The enemy and boss records the exported stage can actually put on screen. */
export interface StageRecipes {
  enemies: Record<string, unknown>[];
  bosses: Record<string, unknown>[];
  /** For the build log; empty when the record carries no custom enemies. */
  note: string;
}

/**
 * Cut `enemyData`/`bossData` down to what the exported stage spawns.
 *
 * A Dezaemon import carries every enemy type of every stage of the save — the
 * Mucha Kucha Fighter save has 209, Master Arena Mod 443 — but the port spawns
 * only the types the grids it plays name: the exported stage's, and then each
 * later stage's as the game goes on (laterStages), plus `bossData["boss" +
 * stageId]` for each of those stages. Packing all of them made the level
 * atlas so crowded that buildPs2Atlas had to shrink it to 1/2 or 1/4 to fit a
 * 512 sheet, and a 16x16 Dezaemon sprite reduced to 4x4 texels is a smudge:
 * on the console the enemies came out as faint "stars", still able to hit and
 * be hit but with nothing recognisable drawn. With only the types the console
 * will spawn, the set fits at full size.
 *
 * A grid cell is `<type><item>`. The browser reads the type as everything but
 * the last character (`CM0` -> enemyCM); the PS2 port (svelte-ps2 1.1.0,
 * spawnEnemyWave) takes only the first (`CM0` -> enemyC). Both readings are
 * kept, so whichever the runtime does, its frames are on the sheet. A grid
 * that names nothing the record knows falls back to packing everything, as
 * before, rather than shipping an empty sheet.
 */
export function stageRecipes(
  record: LevelRecord,
  later: Record<string, string[][]> = {},
): StageRecipes {
  const enemyData = record.enemyData ?? {};
  const bossData = record.bossData ?? {};
  const enemyCount = Object.keys(enemyData).length;
  const bossCount = Object.keys(bossData).length;
  if (enemyCount === 0 && bossCount === 0) {
    return { enemies: [], bosses: [], note: "" };
  }

  const enemyKeys = new Set<string>();
  const unmatched = new Set<string>();
  for (const rows of [record.enemylist ?? [], ...Object.values(later)]) {
    for (const row of rows) {
      for (const cell of row) {
        const code = String(cell ?? "");
        if (!code || code === "00") continue;
        let matched = false;
        for (const type of new Set([code.slice(0, -1), code[0]])) {
          const key = `enemy${type}`;
          if (type && key in enemyData) {
            enemyKeys.add(key);
            matched = true;
          }
        }
        if (!matched) unmatched.add(code);
      }
    }
  }

  // The port plays `bossData["boss" + stageId]` for the exported stage and
  // then for every stage it reaches after that — on up to its fifth, and then
  // from stage0 again once the ending has reset the game (laterStages) — with
  // or without a grid to play first: an absent grid is an empty wave list and
  // the boss comes straight on. So every one of its five bosses ships. The id
  // is clamped to the port's five stages; the unclamped key is kept too in
  // case the runtime grows.
  const stageKey = record.stageKey ?? "stage0";
  const stageNumber = stageNumberOf(record);
  const bossKeys = new Set<string>();
  const ids = [stageNumber];
  for (let id = 0; id <= LAST_STAGE; id++) ids.push(id);
  for (const id of new Set(ids)) {
    if (`boss${id}` in bossData) bossKeys.add(`boss${id}`);
  }

  // What the note calls the stretch of stages that was read.
  const read = [stageKey, ...Object.keys(later)]
    .map((key) => Number(/^stage(\d+)$/.exec(key)?.[1] ?? 0));
  const span = read.length > 1
    ? `stage${Math.min(...read)}–stage${Math.max(...read)}`
    : stageKey;

  if (enemyKeys.size === 0 && enemyCount > 0) {
    return {
      enemies: Object.values(enemyData),
      bosses: Object.values(bossData),
      note: `level_atlas: no wave of ${span} names an enemy in enemyData` +
        ` — packing all ${enemyCount} enemy types and ${bossCount} bosses`,
    };
  }

  return {
    enemies: [...enemyKeys].map((key) => enemyData[key]),
    bosses: [...bossKeys].map((key) => bossData[key]),
    note: `level_atlas: ${span} spawns ${enemyKeys.size} of ${enemyCount}` +
      ` enemy types and ${bossKeys.size} of ${bossCount} bosses` +
      (unmatched.size
        ? `; ${unmatched.size} code(s) match no enemy (${
          [...unmatched].slice(0, 3).join(", ")
        }${unmatched.size > 3 ? ", …" : ""})`
        : ""),
  };
}

/**
 * Every sheet goes on the disc as an 8-bit indexed PNG.
 *
 * AthenaEnv uploads those as GS_PSM_T8, a quarter of the VRAM of the RGBA
 * form. That is the difference between the working set fitting in the GS's
 * 4 MB and not: the three sheets are 2.51 MB at 32bpp, and the framebuffer
 * alone (640x448, double-buffered, 32-bit) is 2.19 MB of the 4. Over-commit
 * and AthenaEnv's texture manager evicts and re-uploads sheets over DMA,
 * which costs far more than the colour ever could.
 *
 * The sheets hold 17k-32k distinct colours, so this is lossy — measured mean
 * error is under 3.2 of 255. `note` says so per sheet, and says EXACT when a
 * sheet fitted in 256 colours on its own.
 */
async function encodeSheet(
  raster: Raster,
  name: string,
): Promise<{ data: Uint8Array; note: string }> {
  const q = quantize(raster);
  return {
    data: await encodeIndexedPng(q),
    note: q.exact
      ? `${name}: ${q.sourceColors} colours, exact as 8-bit indexed`
      : `${name}: ${q.sourceColors} colours -> 256, mean error ` +
        `${q.meanError.toFixed(2)}/255`,
  };
}

/**
 * The player's shot frames, from the level's own recipe with the base game's
 * as the fallback — the same lookup the port does at draw time
 * (`p.shootNormalData.texture[0]` and friends).
 *
 * These are the frames that get turned upright. The art is drawn side-on —
 * `bigProjectile_0.png` is a 23x8 horizontal streak — because the browser
 * engine rotates a sprite to its heading. The PS2 port does not: its
 * `AtlasManager.drawFrame` takes no angle, and a bullet's `rotation` only ever
 * moves it. So shots flew up the screen lying on their side.
 */
function playerShotFrames(
  record: LevelRecord,
  fallback: { playerData?: Record<string, unknown> },
): Set<string> {
  const out = new Set<string>();
  for (const source of [record.playerData, fallback.playerData]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith("shoot")) continue;
      const texture = (value as { texture?: unknown })?.texture;
      if (!Array.isArray(texture)) continue;
      for (const frame of texture) {
        if (typeof frame === "string") out.add(frame);
      }
    }
  }
  return out;
}

async function repackBaseAtlas(
  gameDir: string,
  name: string,
  maxSheet: number,
  rotate: Set<string> = new Set(),
  /** Frames to pack under these names instead of the base sheet's own. */
  overrides: SourceFrame[] = [],
  /** Base frames to leave out entirely, so `hasFrame` reports false. */
  drop: Set<string> = new Set(),
): Promise<{ files: StagedFile[]; note: string }> {
  const sheet = await decodePng(
    await Deno.readFile(join(gameDir, "assets", "img", `${name}.png`)),
  );
  const source = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", `${name}.json`)),
  ) as { frames: Record<string, FrameEntry> };
  const replaced = new Set(overrides.map((frame) => frame.name));
  const frames: SourceFrame[] = Object.entries(source.frames)
    .filter(([frameName]) => !drop.has(frameName) && !replaced.has(frameName))
    .map((
      [frameName, entry],
    ) => ({ name: frameName, sheet, entry, rotate: rotate.has(frameName) }));
  frames.push(...overrides);
  const built = buildPs2Atlas(frames, `${name}.png`, maxSheet);
  const encoded = await encodeSheet(built.image, name);
  return {
    files: [
      { path: `assets/${name}.png`, data: encoded.data },
      { path: `assets/${name}.json`, data: json(built.json) },
    ],
    note: `${name}: ${frames.length} frames -> ${built.image.width}x` +
      `${built.image.height} at 1/${built.displayScale}; ${encoded.note}`,
  };
}

export interface StageOptions {
  /** static/games/2028-ai — the base game's asset tree. */
  gameDir: string;
  /**
   * The shelf's title-screen shot for this game, 256x480 — the port's own
   * logical screen. When it is here it becomes the whole title screen.
   */
  cover?: Raster | null;
  record: LevelRecord;
  /**
   * The level's custom sprite sheet, already decoded.
   *
   * A Firebase record carries its atlas as a PNG data URL, because that is what
   * a browser canvas produces. A build straight from a .sav has the sprites as
   * raw RGBA (lib/ps2/sav.ts) and hands the packed sheet over directly rather
   * than encoding a multi-megabyte base64 string only to decode it again.
   * When this is set it wins over `record.atlasImageDataURL`.
   */
  customAtlas?: { sheet: Raster; frames: Record<string, FrameEntry> } | null;
  /**
   * Cap on either dimension of a generated atlas — and the level atlas may
   * take one doubling more on one side, when that keeps it at full size
   * (buildLevelAtlas).
   */
  maxSheet?: number;
}

/**
 * A Dezaemon save's own title screen, mapped onto the frames the PS2 port's
 * title scene actually draws.
 *
 * `mapSaveToGame` records the save's drawn TITLE 1/2 and credit strips as
 * `dezaemonTitle`: role -> a frame name in the level's atlas. The browser
 * runtime keys off the same field and, when it is there, hides the stock
 * backdrop and the sliding "titleG" logo and puts the save's own art up
 * instead (game.bundle.js, `dezaTitle`). The port has no such branch — it
 * draws `title_bg`, `titleG.gif`, `logo.gif` and `subTitle.gif` from game_ui
 * and nothing else — so the same effect is arranged here, by packing the
 * save's art under those names and leaving the ones it should not draw out of
 * the sheet entirely. A frame that is not in the atlas fails the port's own
 * `hasFrame` check, which is exactly the `setVisible(false)` the browser does.
 *
 * The role pairing follows the browser: title1 is the logo, or title2 stands
 * in when a save drew only the lower strip; the subtitle is title2, and only
 * when title1 took the logo slot. `credit` has nowhere to go — the port draws
 * its copyright line as text — so it is reported and dropped.
 */
export function dezaemonTitleFrames(
  record: LevelRecord,
  index: Map<string, IndexedFrame>,
  notes: string[],
): { overrides: SourceFrame[]; drop: Set<string> } {
  const roles = record.dezaemonTitle;
  const overrides: SourceFrame[] = [];
  const drop = new Set<string>();
  if (!roles || !Object.keys(roles).length) return { overrides, drop };

  const frameFor = (role: string): SourceFrame | null => {
    const name = roles[role];
    if (!name) return null;
    const found = resolve(index, name);
    return found ? { name, sheet: found.sheet, entry: found.entry } : null;
  };

  const title1 = frameFor("title1");
  const title2 = frameFor("title2");
  const logo = title1 ?? title2;
  const subtitle = title1 ? title2 : null;

  // The save's title replaces the whole stock arrangement, not part of it.
  drop.add("titleG.gif");
  drop.add("title_bg");

  if (logo) overrides.push({ ...logo, name: "logo.gif" });
  else drop.add("logo.gif");
  if (subtitle) overrides.push({ ...subtitle, name: "subTitle.gif" });
  else drop.add("subTitle.gif");

  const missing = Object.entries(roles)
    .filter(([role, name]) => role !== "credit" && name && !frameFor(role))
    .map(([role]) => role);
  notes.push(
    `dezaemon title: ${
      logo ? `logo from ${roles.title1 ?? roles.title2}` : "no logo art"
    }${subtitle ? `, subtitle from ${roles.title2}` : ""}` +
      `${roles.credit ? " (credit strip has nowhere to go)" : ""}` +
      `${missing.length ? `; ${missing.join(", ")} not in the atlas` : ""}`,
  );
  return { overrides, drop };
}

// The port's own screen geometry, from ps2-sp/constants.ts. `title_bg` is the
// one thing the title scene draws in raw screen coordinates —
// `drawFrameTL("game_ui", "title_bg", 0, 0, SCREEN_W / GW, SCREEN_H / GH)` —
// rather than through the viewport the way `drawStageBg` does, and the
// letterbox is then painted over the top of it every frame. So the frame gets
// stretched 2.5x across the full 640 and the bars hide everything outside the
// centre ~239, which is why an untreated cover shows as the middle third of
// itself.
const GW = 256;
const GH = 480;
const SCREEN_W = 640;
const SCREEN_H = 448;
const VIEWPORT_SCALE = Math.min(SCREEN_W / GW, SCREEN_H / GH);
/** Columns of a `title_bg` frame that survive the letterbox: 96 of 256. */
const TITLE_VISIBLE_W = Math.round(
  (GW * VIEWPORT_SCALE) / (SCREEN_W / GW),
);
/** Where those columns start. */
const TITLE_VISIBLE_X = Math.round(
  ((SCREEN_W - GW * VIEWPORT_SCALE) / 2) / (SCREEN_W / GW),
);

/**
 * Pre-distort a cover so it lands square inside the visible window.
 *
 * The cover is squeezed into the columns the letterbox leaves and padded
 * either side. The port then stretches the whole frame 2.5x horizontally and
 * 0.933x vertically, which undoes the squeeze exactly: 96 columns become 240
 * screen pixels against the game area's 239, and 480 rows become 448. The
 * result is the whole title at its own proportions instead of a third of it.
 */
function frameForTitleBg(cover: Raster): Raster {
  const canvas = newRaster(GW, GH);
  blit(canvas, resizeTo(cover, TITLE_VISIBLE_W, GH), TITLE_VISIBLE_X, 0);
  return canvas;
}

/**
 * The shelf's title screenshot, as the whole title screen.
 *
 * shmupX's shelf renders a cover for every Dezaemon save from the save's own
 * title art, at 256x480 — which is exactly GW x GH, the logical screen the
 * port lays its title scene out in. The port draws `title_bg` full-screen
 * (`drawFrameTL("game_ui", "title_bg", 0, 0, SCREEN_W / 256, SCREEN_H / 480)`)
 * so the shot goes in there, and everything the stock screen would put on top
 * of it — the sliding titleG, the logo, the subtitle — is left out of the
 * sheet so nothing covers it. The port keeps drawing its own HI-SCORE and
 * PRESS START text, which is what you want.
 *
 * This is a better title than `dezaemonTitle` gives: that pulls the save's
 * two drawn strips out of the level atlas, while the cover is the whole
 * screen as the shelf shows it, already composed.
 */
export function coverTitleFrames(
  cover: Raster,
  notes: string[],
): { overrides: SourceFrame[]; drop: Set<string> } {
  const framed = frameForTitleBg(cover);
  notes.push(
    `title screen: the shelf's ${cover.width}x${cover.height} cover, ` +
      `letterboxed into the ${TITLE_VISIBLE_W}x${GH} the port actually shows`,
  );
  return {
    overrides: [{
      name: "title_bg",
      sheet: framed,
      entry: {
        frame: { x: 0, y: 0, w: framed.width, h: framed.height },
        rotated: false,
        trimmed: false,
      },
    }],
    // Nothing sits on top of the shot.
    drop: new Set(["titleG.gif", "logo.gif", "subTitle.gif"]),
  };
}

/** Produce every file the console reads, ready to hand to the ISO writer. */
export async function stageAssets(options: StageOptions): Promise<StageResult> {
  const { gameDir, record } = options;
  const maxSheet = options.maxSheet ?? 512;
  const files: StagedFile[] = [];
  const notes: string[] = [];

  const baseRecipe = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game.json")),
  ) as Record<string, unknown> & { playerData?: Record<string, unknown> };
  // Only game_asset: that is the sheet the port draws bullets from.
  const upright = playerShotFrames(record, baseRecipe);

  const baseSheet = await decodePng(
    await Deno.readFile(join(gameDir, "assets", "img", "game_asset.png")),
  );
  const baseJson = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game_asset.json")),
  ) as { frames: Record<string, FrameEntry> };

  let custom: { sheet: Raster; frames: Record<string, FrameEntry> } | null =
    null;
  if (options.customAtlas) {
    custom = options.customAtlas;
    notes.push(
      `custom atlas: ${Object.keys(custom.frames).length} frames, ` +
        `${custom.sheet.width}x${custom.sheet.height}`,
    );
  } else if (record.atlasImageDataURL && record.atlasFrames) {
    custom = {
      sheet: await decodeDataUrl(record.atlasImageDataURL),
      frames: record.atlasFrames,
    };
    notes.push(
      `custom atlas: ${Object.keys(record.atlasFrames).length} frames, ` +
        `${custom.sheet.width}x${custom.sheet.height}`,
    );
  } else {
    notes.push("custom atlas: none — the level uses the base sprites");
  }
  const index = buildFrameIndex(baseSheet, baseJson.frames, custom);

  const title = options.cover
    ? coverTitleFrames(options.cover, notes)
    : dezaemonTitleFrames(record, index, notes);

  // --- what the console will play ---
  //
  // Worked out before any sheet is packed, because it decides what goes on two
  // of them. From here on the game is described as the DISC carries it:
  // one-character enemy codes and only the records some grid names — this
  // stage's, and every stage the console plays after it (laterStages).
  const later = laterStages(record, baseRecipe);
  const disc = discStage(record, later);
  const recipes = stageRecipes({
    ...record,
    enemylist: disc.enemylist,
    enemyData: disc.enemyData,
  }, disc.later);

  // A boss's bullets are the exception to "a level's sprites are in the level
  // atlas". The port's boss queues its shots with frame names and no atlas
  // (bossShootStraight and friends), so createProjectile files every one of
  // them under `game_asset`, whatever loadFirebaseLevel tagged the record
  // with. Art the base sheet already has is found there; a level's OWN bullet
  // art has to be packed into that sheet under its name, or the boss fires
  // shots that hit and are never drawn — which the game this repo ships did,
  // on its second and fourth stages.
  const missing = new Set<string>();
  const bossShots = new Map<string, SourceFrame>();
  for (const boss of recipes.bosses) {
    for (const list of bossShotLists(boss)) {
      for (const name of list) {
        const found = resolve(index, name);
        if (!found) missing.add(name);
        else if (found.sheet !== baseSheet) {
          bossShots.set(name, { name, sheet: found.sheet, entry: found.entry });
        }
      }
    }
  }

  for (const name of ["game_asset", "game_ui"]) {
    // A cover lands in game_ui and the port magnifies it 2.5x, so that sheet
    // gets a bigger budget when one is present: at 512 it packs at 1/4 and
    // the title has 24 texels across the 239 pixels it is shown in, at 1024
    // it packs at 1/2 and has 48. The other sheets stay where they are, which
    // keeps the working set inside the GS's 4 MB — see the note in
    // encodeSheet().
    const budget = name === "game_ui" && options.cover
      ? Math.max(maxSheet, 1024)
      : maxSheet;
    const built = await repackBaseAtlas(
      gameDir,
      name,
      budget,
      name === "game_asset" ? upright : new Set(),
      name === "game_ui" ? title.overrides : [...bossShots.values()],
      name === "game_ui" ? title.drop : new Set(),
    );
    files.push(...built.files);
    notes.push(built.note);
  }
  if (upright.size) {
    notes.push(
      `player shots: ${upright.size} frame(s) turned upright — ` +
        `${[...upright].slice(0, 3).join(", ")}${
          upright.size > 3 ? ", …" : ""
        }`,
    );
  }
  if (bossShots.size) {
    notes.push(
      `boss shots: ${bossShots.size} of the level's own frame(s) packed into ` +
        `game_asset, where the port draws them — ` +
        `${[...bossShots.keys()].slice(0, 3).join(", ")}${
          bossShots.size > 3 ? ", …" : ""
        }`,
    );
  }

  // --- the level's own atlas ---
  if (disc.note) notes.push(disc.note);
  if (recipes.note) notes.push(recipes.note);

  // The recipe the port normalises into its own shape at boot. The stages
  // after the exported one are played out of this file, so a whole-game
  // record's own grids go in over the base game's — re-coded along with the
  // level's, since they spawn from the same re-keyed enemyData. A record with
  // nothing of its own leaves the file exactly as the base game ships it.
  const ownStages = Object.keys(disc.later).filter((key) =>
    JSON.stringify(disc.later[key]) !== JSON.stringify(gridOf(baseRecipe[key]))
  );
  if (ownStages.length) {
    const recipe: Record<string, unknown> = { ...baseRecipe };
    for (const key of ownStages) {
      recipe[key] = {
        ...(baseRecipe[key] as Record<string, unknown> | undefined ?? {}),
        enemylist: disc.later[key],
      };
    }
    files.push({ path: "assets/game.json", data: json(recipe) });
    notes.push(`game.json: ${ownStages.join(", ")} from the level`);
  } else {
    files.push({
      path: "assets/game.json",
      data: await Deno.readFile(join(gameDir, "assets", "game.json")),
    });
  }
  // Everything an enemy record names, and the frames each boss is drawn with.
  const wanted = new Set<string>();
  for (const recipe of recipes.enemies) collectTextures(recipe, wanted);
  for (const recipe of recipes.bosses) {
    for (const frame of bossFrames(recipe)) wanted.add(frame);
  }

  const levelFrames: SourceFrame[] = [];
  for (const name of wanted) {
    const found = resolve(index, name);
    if (!found) {
      missing.add(name);
      continue;
    }
    levelFrames.push({ name, sheet: found.sheet, entry: found.entry });
  }

  if (levelFrames.length > 0) {
    const built = buildLevelAtlas(levelFrames, {
      maxSheet,
      cover: !!options.cover,
    });
    const sheet = await encodeSheet(built.image, "level_atlas");
    files.push(
      { path: "assets/level_atlas.png", data: sheet.data },
      { path: "assets/level_atlas.json", data: json(built.json) },
    );
    notes.push(
      `level_atlas: ${levelFrames.length} frames -> ${built.image.width}x` +
        `${built.image.height} at 1/${built.displayScale}`,
      sheet.note,
    );
  } else {
    // ps2-sp opens both paths unconditionally, and AthenaEnv's image loader
    // does not survive a missing file, so an empty level still gets a sheet.
    files.push(
      {
        path: "assets/level_atlas.png",
        data: (await encodeSheet(newRaster(2, 2), "level_atlas")).data,
      },
      { path: "assets/level_atlas.json", data: json({ frames: {} }) },
    );
    notes.push("level_atlas: empty — the level names no custom sprites");
  }
  if (missing.size) {
    notes.push(
      `level_atlas: ${missing.size} frame(s) not found in either sheet ` +
        `(${[...missing].slice(0, 4).join(", ")}${
          missing.size > 4 ? ", …" : ""
        })`,
    );
  }

  // --- the player sheet ---
  const playerFrames = Array.isArray(record.playerData?.texture)
    ? record.playerData.texture as string[]
    : null;
  const fallback = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game.json")),
  ) as { playerData?: { texture?: string[] } };
  const wantedPlayer =
    (playerFrames && playerFrames.length
      ? playerFrames
      : fallback.playerData?.texture) ?? ["player00.gif", "player01.gif"];
  const player = await encodeSheet(
    buildPlayerSheet(index, wantedPlayer),
    "player sheet",
  );
  files.push({ path: "assets/cyber_liberty.png", data: player.data });
  notes.push(`player: ${wantedPlayer.slice(0, 2).join(", ")}`);

  // --- the level itself ---
  //
  // enemyData and bossData are omitted rather than emptied when the level does
  // not carry them: the port *replaces* the base recipe's entries with
  // whatever the level file has, so shipping `{}` would leave the waves
  // pointing at enemies that no longer exist and the stage would come up bare.
  const hasEnemyData = Object.keys(disc.enemyData).length > 0;
  const hasBossData = Object.keys(record.bossData ?? {}).length > 0;
  files.push({
    path: "assets/level.json",
    data: json({
      name: record.name ?? "",
      stageKey: record.stageKey ?? "stage0",
      width: record.width ?? 8,
      enemylist: disc.enemylist,
      ...(hasEnemyData ? { enemyData: disc.enemyData } : {}),
      ...(hasBossData ? { bossData: record.bossData } : {}),
    }),
  });
  notes.push(
    `level.json: ${disc.enemylist.length} waves` +
      (hasEnemyData ? ", custom enemies" : ", base enemies") +
      (hasBossData ? ", custom boss" : ""),
  );

  return { files, notes };
}

// ps2-sp loads the player from a uniform 32x32 grid sheet and animates cells
// '0' and '1', so the level's first two player frames are fitted into two
// cells — scaled to fit rather than stretched, since the source art is taller
// than it is wide.
function buildPlayerSheet(
  index: Map<string, IndexedFrame>,
  frameNames: string[],
): Raster {
  const cells: Raster[] = [];
  for (const name of frameNames) {
    const found = resolve(index, name);
    if (!found) continue;
    const size = found.entry.sourceSize ?? found.entry.frame;
    const origin = found.entry.trimmed && found.entry.spriteSourceSize
      ? found.entry.spriteSourceSize
      : { x: 0, y: 0 };
    const full = cut(
      found.sheet,
      found.entry.frame,
      size.w,
      size.h,
      origin.x,
      origin.y,
    );
    cells.push(fitInto(full, 32, 32));
    if (cells.length === 2) break;
  }
  const sheet = newRaster(64, 32);
  if (cells.length === 0) return sheet;
  blit(sheet, cells[0], 0, 0);
  blit(sheet, cells[1] ?? cells[0], 32, 0);
  return sheet;
}
