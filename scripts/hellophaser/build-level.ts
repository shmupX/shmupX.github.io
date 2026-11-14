#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Convert RonaGun (hellophaser v4, the Phaser 3 shooter at
 * easierbycode.com/hellophaser/v4/) into the shmupX cloud game `hellophaser`,
 * with its music and its particle trails.
 *
 *   deno run -A --node-modules-dir=none scripts/hellophaser/build-level.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/hellophaser/build-level.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/hellophaser/build-level.ts --serve
 *   deno run -A --node-modules-dir=none scripts/hellophaser/build-level.ts --apply
 *   deno run -A --node-modules-dir=none scripts/hellophaser/build-level.ts --revert
 *
 * The shape is evil-invaders' (scripts/evil-invaders/build-level.ts):
 *
 * - `stages/stage0`: the source is a single endless scene, so it becomes one
 *   stage. Its three lanes (source.ts LANES) send each lane's current enemy
 *   down the field once per crossing, from a random column, for as long as
 *   the source keeps that sprite on the lane. Its five sentinels cross from
 *   left to right at 50 px/s on the row the source flies them. The stage
 *   ends when the Seductress arrives, at 77 s.
 * - `enemyData`: one record per sprite, each flying a Dezaemon appearance
 *   script (95-demo's entry-script.ts): straight down at its lane's speed, or
 *   a hidden pre-roll to the left edge and then straight right. Nothing in the
 *   source fires, so no record does. The Asteroid carries the source's red
 *   particle trail as `trail`.
 * - `bossData/boss0`: the Seductress, 20 hp as in the source.
 * - `playerData`: Lincoln, his fireballs every 100 ms, and his blue thruster
 *   trail as `trail`.
 * - `customAudioURLs.boss_bison_bgm`: the source's title song. The runtime
 *   plays stage 0's music under that key (playBossBgm), through the boss, as
 *   the source loops it through the whole scene.
 * - the art, packed into the level's own sheet, the source's starfield as
 *   the stage backdrop, and a title made from the source's own logo.
 */

import { parseArgs } from "@std/cli/parse-args";
import { decodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut, rotateCcw } from "@shmupx/shmup-harbor/raster";
import { validateGameJson } from "@shmupx/shmup-engine/game-schema";
import { gameIdForLevel } from "../../static/phaser-plugins/level-loader.js";
import {
  encodeFrameMap,
  packFrames,
  type ResolvedFrame,
  sheetDataUrl,
} from "../../mcp/lib/art.ts";
import { dbPath, getWithEtag, put } from "../../mcp/lib/rtdb.ts";
import { badRtdbKey } from "../lib/rtdb-publish.ts";
import {
  enemyLetters,
  GRID_COLS,
  TEXTURE_LIMIT,
} from "../95-demo/build-level.ts";
import {
  angleFor,
  ENTRY_ADVANCE,
  ENTRY_NO_FIRE,
  type EntryRow,
  ROW_FOREVER,
} from "../95-demo/entry-script.ts";
import { resample, tinted } from "../95-demo/art.ts";
import { seededRandom } from "../95-demo/replay.ts";
import { textArt } from "../evil-invaders/art.ts";
import {
  type AnimKey,
  ANIMS,
  CROSSER_SPEED,
  CROSSERS,
  type EmitterDef,
  EMITTERS,
  FPS,
  GAME_HEIGHT,
  IMAGES,
  LANE_SCORE,
  LANES,
  MUSIC_URL,
  PLAYER_FIRE_RATE_MS,
  SEDUCTRESS,
  type SheetKey,
  SHEETS,
  SOURCE,
  STAR_FREQUENCY_MS,
  STAR_TINTS,
} from "./source.ts";

export const LEVEL = "hellophaser";
export const TITLE = "RONAGUN";

// deno-lint-ignore no-explicit-any
type Json = any;

/** shmupX's field is 256x480; the source's 256x272. x is 1:1, y stretches. */
export const FIELD_H = 480;
export const KY = FIELD_H / GAME_HEIGHT;
/** The spawn row the runtime places at y -16: every row value >= 30. */
const ROW_BASE = 30;
/** One row value per Saturn frame: two 120 Hz ticks. */
const WAVE_INTERVAL = 2;
/** No enemy spawns earlier than this many frames into a stage. */
const FIRST_SPAWN = 30;
/** Where enemyWave puts column c of a 16-wide row, and its spawn y. */
const colX = (c: number) => c * 16 + 16;
const SPAWN_Y = -16;
/** A pre-roll off the screen travels this fast, px per frame. */
const HIDDEN_SPEED = 40;
/** The source's shadows: none. updateShadowPosition parks this one off the screen. */
const SHADOW_PARK = 1000;
/** A runtime-tick count from milliseconds (the runtime steps at 120 Hz). */
const ticks = (ms: number) => Math.round(ms / 1000 * 120);

export const ART_DIR = new URL("./art/", import.meta.url);
const STOCK_ATLAS = new URL(
  "../../static/games/2028-ai/assets/game_asset.json",
  import.meta.url,
);
const STOCK_RECIPE = new URL(
  "../../static/games/2028-ai/assets/game.json",
  import.meta.url,
);

async function loadArt(file: string): Promise<Raster> {
  return await decodePng(await Deno.readFile(new URL(file, ART_DIR)));
}

// --- art ---------------------------------------------------------------------

/** Frame names: `hp` + the sheet + the frame index (and the draw scale). */
const F = {
  sheet: (k: SheetKey, i: number, scale = 1) =>
    `hp${k[0].toUpperCase()}${k.slice(1)}${
      scale === 1 ? "" : `x${scale}`
    }_${i}`,
  image: (k: keyof typeof IMAGES) => `hp${k[0].toUpperCase()}${k.slice(1)}`,
};

/** The frames an animation shows, at a draw scale. */
const animFrames = (key: AnimKey, scale = 1) =>
  ANIMS[key].frames.map((i) => F.sheet(ANIMS[key].sheet, i, scale));

/** Frame `i` of a grid sheet, left to right, top to bottom, as Phaser cuts it. */
function gridFrame(sheet: Raster, w: number, h: number, i: number): Raster {
  const cols = Math.floor(sheet.width / w);
  return cut(sheet, { x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
}

/** The Dezaemon animation period, in Saturn frames, for a source frame rate. */
const animPeriod = (fps: number) => Math.max(2, Math.round(FPS / fps));

interface Art {
  frames: ResolvedFrame[];
  size: Record<string, { w: number; h: number }>;
}

/** Every frame a record names, cut out of art/. */
export async function buildArt(): Promise<Art> {
  const frames: ResolvedFrame[] = [];
  const size: Art["size"] = {};
  const seen = new Set<string>();
  const add = (name: string, raster: Raster, source: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    size[name] = { w: raster.width, h: raster.height };
    frames.push({ name, raster, source } as ResolvedFrame);
  };
  const want: { key: AnimKey; scale: number }[] = [
    ...LANES.flatMap((l) =>
      l.roster.map((r) => ({ key: r.anim, scale: r.scale ?? 1 }))
    ),
    ...CROSSERS.map((c) => ({ key: c.anim, scale: 1 })),
    { key: "seductressDefault", scale: 1 },
    { key: "lincolnFly", scale: 1 },
    { key: "lincolnFireball", scale: 1 },
  ];
  const sheets = new Map<SheetKey, Raster>();
  for (const { key, scale } of want) {
    const sk = ANIMS[key].sheet;
    const def = SHEETS[sk];
    if (!sheets.has(sk)) sheets.set(sk, await loadArt(def.file));
    for (const i of ANIMS[key].frames) {
      let r = gridFrame(sheets.get(sk)!, def.frameW, def.frameH, i);
      if (scale !== 1) r = resample(r, r.width * scale, r.height * scale, true);
      // The runtime draws a player shot pointing right and turns it to fly
      // up; the source's fireball is drawn pointing up.
      if (key === "lincolnFireball") r = rotateCcw(rotateCcw(rotateCcw(r)));
      add(F.sheet(sk, i, scale), r, def.file);
    }
  }
  for (const k of ["blue", "red", "fairyBullet"] as const) {
    add(F.image(k), await loadArt(IMAGES[k]), IMAGES[k]);
  }
  return { frames, size };
}

/**
 * The source's starfield as a 256x256 tile the runtime scrolls: its 7 px star
 * tinted at random from its eight tints, at the emitter's alpha. Stars fall
 * at 60-100 px/s for 272 px, one every 100 ms: about 34 on the source's
 * screen, so this tile (145 source px tall once stretched) holds 18.
 */
export async function stageBackdropArt(): Promise<Raster> {
  const star = await loadArt(IMAGES.star);
  const out = newRaster(256, 256);
  for (let i = 0; i < 256 * 256; i++) out.data[i * 4 + 3] = 255;
  const rand = seededRandom(0x4e110);
  const onScreen = Math.round(GAME_HEIGHT / 80 * 1000 / STAR_FREQUENCY_MS);
  const count = Math.round(onScreen * 256 / (GAME_HEIGHT * KY));
  for (let n = 0; n < count; n++) {
    const t = tinted(star, STAR_TINTS[Math.floor(rand() * STAR_TINTS.length)]);
    const alpha = 0.75 + rand() * 0.1;
    const x = Math.floor(rand() * (256 - t.width));
    const y = Math.floor(rand() * (256 - t.height));
    for (let yy = 0; yy < t.height; yy++) {
      for (let xx = 0; xx < t.width; xx++) {
        const s = (yy * t.width + xx) * 4;
        const k = t.data[s + 3] / 255 * alpha;
        if (!k) continue;
        const d = ((y + yy) * 256 + x + xx) * 4;
        for (let c = 0; c < 3; c++) {
          out.data[d + c] = Math.round(
            t.data[s + c] * k + out.data[d + c] * (1 - k),
          );
        }
      }
    }
  }
  return out;
}

/** `parts` centred on a w x h plate. */
function plate(w: number, h: number, parts: Raster[], gap = 0): Raster {
  const out = newRaster(w, h);
  const total = parts.reduce((s, p) => s + p.height, 0) +
    gap * (parts.length - 1);
  let y = Math.floor((h - total) / 2);
  for (const p of parts) {
    blit(out, p, Math.floor((w - p.width) / 2), y);
    y += p.height + gap;
  }
  return out;
}

/** The title: the source's logo, its menu's star backdrop, its start button. */
export async function titleArt() {
  const logo = await loadArt(IMAGES.logo);
  const lw = 248;
  const logoSmall = resample(
    logo,
    lw,
    Math.round(logo.height * lw / logo.width),
    false,
  );
  const bg = await loadArt(IMAGES.starBg0);
  // Menu's ScrollingBackground draws its stars at setScale(2).
  const backdrop = resample(
    cut(bg, { x: 0, y: 0, w: 256, h: 240 }),
    512,
    480,
    true,
  );
  const btn = await loadArt(IMAGES.startBtn);
  return {
    backdrop,
    logo: plate(256, 88, [logoSmall]),
    subTitle: plate(256, 28, [
      await textArt("HELLO PHASER V4", [0x72, 0x75, 0x7d], 1),
    ]),
    startText: plate(256, 28, [btn]),
  };
}

// --- the stage ---------------------------------------------------------------

/** Rows that fly straight down at `pxPerFrame` field px a Saturn frame. */
export function descendRows(pxPerFrame: number): EntryRow[] {
  return [[
    ROW_FOREVER,
    0xc000,
    0,
    Math.round(pxPerFrame * 256),
    ENTRY_NO_FIRE,
  ]];
}

/**
 * Rows for a sentinel: from column 0's spawn point to just off the left edge
 * at `y`, hidden and fast, then right at the source's 50 px/s for good.
 * Answers the rows and how many frames the pre-roll takes.
 */
export function crosserRows(
  halfW: number,
  y: number,
): { rows: EntryRow[]; preRoll: number } {
  const from = { x: colX(0), y: SPAWN_Y };
  const to = { x: parkX(halfW), y };
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / HIDDEN_SPEED));
  const amp = Math.round(dist / n * 256);
  return {
    rows: [
      [n - 1, angleFor(dx, dy, false), 0, amp, ENTRY_ADVANCE | ENTRY_NO_FIRE],
      [ROW_FOREVER, 0, 0, Math.round(CROSSER_SPEED / FPS * 256), ENTRY_NO_FIRE],
    ],
    preRoll: n,
  };
}

/**
 * Where a sentinel waits to cross: just off the left edge, but inside the
 * runtime's cull line (an enemy left of x -40 is retired at once), so the
 * wide Sentinel shows a sliver of itself there for its first frames.
 */
export const parkX = (halfW: number) => Math.max(-halfW - 1, -39);

/** A zako record: art, stats, script; never fires, no shadow. */
function zakoRecord(
  name: string,
  texture: string[],
  fps: number,
  hp: number,
  score: number,
  rows: EntryRow[],
): Json {
  return {
    name,
    texture,
    hp,
    score,
    spgage: 1,
    interval: -1,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    bulletData: {},
    dezaemon: {
      behavior: {
        animPeriod: animPeriod(fps),
        ground: false,
        movePattern: 0,
        move: { mode: 0, flag: false },
        fire: { enabled: false, geometry: 0, aimed: false, mode: 0, window: 0 },
        rotation: { enabled: false },
        scale: { enabled: false },
        zoom: { enabled: false },
        direction: { enabled: false },
        death: { mode: 0, param: 0, silent: false, small: false },
      },
      entry: { rows },
    },
  };
}

/** A source emitter as a record's `trail`. */
export function trailRecord(e: EmitterDef): Json {
  return {
    texture: [F.image(e.image)],
    speed: e.speed,
    lifespan: [...e.lifespan],
    ...(e.angle ? { angle: [...e.angle] } : {}),
    scale: { ...e.scale },
    blendMode: e.blendMode,
  };
}

interface Spawn {
  frame: number;
  column: number;
  letters: string;
}

export interface StageBuild {
  enemyData: Json;
  enemylist: string[][];
  waveRows: number[];
  spawns: Spawn[];
  endFrame: number;
}

export function buildStage(): StageBuild {
  const rand = seededRandom(0x4e11);
  const endFrame = Math.round(
    ((-SEDUCTRESS.right) / SEDUCTRESS.speed) * FPS,
  );
  const enemyData: Json = {};
  const letterOf = new Map<string, string>();
  const letterFor = (id: string, make: () => Json) => {
    let l = letterOf.get(id);
    if (!l) {
      l = enemyLetters(0, letterOf.size);
      letterOf.set(id, l);
      enemyData[`enemy${l}`] = make();
    }
    return l;
  };
  const spawns: Spawn[] = [];

  // The lanes: one pass per crossing of the source's 272 px.
  LANES.forEach((lane, li) => {
    const period = GAME_HEIGHT / lane.speed;
    for (let f = 0; f < endFrame; f += period) {
      const t = f / FPS;
      const r = [...lane.roster].reverse().find((x) => x.from <= t)!;
      const scale = r.scale ?? 1;
      const letters = letterFor(`${r.anim}x${scale}`, () => {
        const rec = zakoRecord(
          r.anim,
          animFrames(r.anim, scale),
          ANIMS[r.anim].fps,
          1,
          LANE_SCORE,
          descendRows(lane.speed * KY),
        );
        if (r.anim === "asteroid") rec.trail = trailRecord(EMITTERS.asteroid);
        return rec;
      });
      spawns.push({
        frame: Math.round(f) + FIRST_SPAWN + li,
        column: Math.floor(rand() * GRID_COLS),
        letters,
      });
    }
  });

  // The sentinels, timed so each leaves its pre-roll where the source's is.
  for (const c of CROSSERS) {
    const def = SHEETS[ANIMS[c.anim].sheet];
    const halfW = def.frameW / 2;
    const { rows, preRoll } = crosserRows(halfW, c.y * KY);
    const enter = (parkX(halfW) - c.x) / CROSSER_SPEED * FPS;
    const letters = letterFor(c.anim, () =>
      zakoRecord(
        c.anim,
        animFrames(c.anim),
        ANIMS[c.anim].fps,
        c.health,
        c.health * LANE_SCORE,
        rows,
      ));
    spawns.push({
      frame: Math.max(FIRST_SPAWN, Math.round(enter - preRoll) + FIRST_SPAWN),
      column: 0,
      letters,
    });
  }

  // One grid row per spawn frame (more if two share a column), between an
  // empty first row and an empty last row, when the Seductress arrives.
  const rows: { frame: number; cells: string[] }[] = [
    { frame: 0, cells: new Array(GRID_COLS).fill("00") },
  ];
  for (const s of [...spawns].sort((a, b) => a.frame - b.frame)) {
    let row = rows.find((r) =>
      r.frame === s.frame && r.cells[s.column] === "00"
    );
    if (!row) {
      row = { frame: s.frame, cells: new Array(GRID_COLS).fill("00") };
      rows.push(row);
    }
    row.cells[s.column] = `${s.letters}0`;
  }
  const end = endFrame + FIRST_SPAWN;
  rows.push({ frame: end, cells: new Array(GRID_COLS).fill("00") });
  // The runtime plays enemylist bottom-up.
  const ordered = rows.slice().reverse();
  return {
    enemyData,
    enemylist: ordered.map((r) => r.cells),
    waveRows: ordered.map((r) => ROW_BASE + r.frame),
    spawns,
    endFrame: end,
  };
}

// --- the boss and the player -------------------------------------------------

/**
 * The Seductress. She fires nothing in the source; a shmupX boss runs a stock
 * routine, so hers (Bison's, stage 0's) shoots the fairy bullet the source
 * loads and never uses.
 */
export function seductressRecord(): Json {
  const fairy = {
    texture: [F.image("fairyBullet")],
    speed: 1,
    damage: 1,
    hp: 1,
    score: 10,
    spgage: 1,
  };
  return {
    name: "seductress",
    hp: SEDUCTRESS.health,
    score: SEDUCTRESS.health * LANE_SCORE,
    spgage: 30,
    interval: 100,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    anim: { idle: animFrames("seductressDefault") },
    bulletData: fairy,
    bulletDataA: fairy,
    bulletDataB: fairy,
    bulletDataC: fairy,
  };
}

export function playerRecord(): Json {
  // The runtime plays a ship at 6 fps; lincoln-fly is 2 fps.
  const fly = animFrames("lincolnFly").flatMap((f) => [f, f, f]);
  const shot = {
    texture: animFrames("lincolnFireball"),
    frameRate: ANIMS.lincolnFireball.fps,
  };
  const interval = ticks(PLAYER_FIRE_RATE_MS);
  return {
    name: "lincoln",
    texture: fly,
    maxHp: 3,
    spDamage: 10,
    speed: 150,
    defaultShootName: "normal",
    defaultShootSpeed: "speed_normal",
    shootNormal: { name: "normal", ...shot, damage: 1, hp: 1, interval },
    shootBig: { name: "big", ...shot, damage: 2, hp: 100, interval },
    shoot3way: { name: "3way", ...shot, damage: 1, hp: 1, interval },
    trail: trailRecord(EMITTERS.lincoln),
  };
}

// --- the record ---------------------------------------------------------------

export interface Build {
  record: Json;
  stage: StageBuild;
  frameCount: number;
  sheet: { w: number; h: number };
}

/** Every texture name a record carries, trails included. */
function namedFrames(record: Json): Set<string> {
  const out = new Set<string>();
  const walk = (v: Json) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "rows") continue;
        if ((k === "texture" || k === "idle") && Array.isArray(x)) {
          x.forEach((n) => out.add(n as string));
        } else walk(x);
      }
    }
  };
  for (const key of ["enemyData", "bossData", "playerData"]) walk(record[key]);
  return out;
}

export async function buildLevel(): Promise<Build> {
  const art = await buildArt();
  const stage = buildStage();
  const stockAtlas = JSON.parse(await Deno.readTextFile(STOCK_ATLAS));
  const packed = packFrames(art.frames, stockAtlas.meta.size.w);
  const title = await titleArt();
  const backdrop = await sheetDataUrl(await stageBackdropArt());
  const playerData = playerRecord();
  const bossData = { boss0: seductressRecord() };
  const stages = {
    stage0: {
      enemylist: stage.enemylist,
      waveRows: stage.waveRows,
      waveInterval: WAVE_INTERVAL,
    },
  };
  const record: Json = {
    name: LEVEL,
    title: TITLE,
    gameId: gameIdForLevel({ name: LEVEL }),
    meta: { version: "1.0", source: "hellophaser", origin: SOURCE.site },
    noStory: true,
    ownItems: false,
    godMode: false,
    width: GRID_COLS,
    stageKey: "stage0",
    enemylist: stages.stage0.enemylist,
    waveRows: stages.stage0.waveRows,
    waveInterval: WAVE_INTERVAL,
    stages,
    enemyData: stage.enemyData,
    bossData,
    playerData,
    customAudioURLs: { boss_bison_bgm: MUSIC_URL },
    atlasImageDataURL: await sheetDataUrl(packed.sheet),
    atlasFrames: encodeFrameMap(packed.json.frames),
    stageBackgrounds: { stage0: { loop: backdrop, end: backdrop } },
    titleBgDataURL: await sheetDataUrl(title.backdrop),
    logoDataURL: await sheetDataUrl(title.logo),
    subTitleDataURL: await sheetDataUrl(title.subTitle),
    titleStartTextDataURL: await sheetDataUrl(title.startText),
  };

  // --- checks: a record the runtime would quietly mis-draw is not written
  const missing = [...namedFrames(record)].filter((n) =>
    !packed.json.frames[n]
  );
  if (missing.length) throw new Error(`frames not packed: ${missing}`);
  const stacked = stockAtlas.meta.size.h + packed.sheet.height;
  if (stacked > TEXTURE_LIMIT) {
    throw new Error(
      `the stacked atlas is ${stacked} rows tall; phones take ${TEXTURE_LIMIT}`,
    );
  }
  const bad = badRtdbKey(record);
  if (bad) throw new Error(`RTDB refuses the key at ${bad}`);
  const stock = JSON.parse(await Deno.readTextFile(STOCK_RECIPE));
  const schema = validateGameJson({
    ...stages,
    enemyData: stage.enemyData,
    bossData,
    playerData: { ...stock.playerData, ...playerData },
    meta: record.meta,
  });
  if (!schema.ok) throw new Error(`schema: ${schema.errors.join("; ")}`);

  return {
    record,
    stage,
    frameCount: art.frames.length,
    sheet: { w: packed.sheet.width, h: packed.sheet.height },
  };
}

export function summary(b: Build): Json {
  const bytes = (v: unknown) =>
    new TextEncoder().encode(JSON.stringify(v)).length;
  const count = new Map<string, number>();
  for (const s of b.stage.spawns) {
    const n = b.record.enemyData[`enemy${s.letters}`].name;
    count.set(n, (count.get(n) ?? 0) + 1);
  }
  return {
    level: dbPath(`levels/${LEVEL}`),
    gameId: b.record.gameId,
    title: b.record.title,
    spawns: Object.fromEntries(count),
    rows: b.stage.enemylist.length,
    endS: Math.round(b.stage.endFrame / 6) / 10,
    boss: `${b.record.bossData.boss0.name} hp ${b.record.bossData.boss0.hp}`,
    music: b.record.customAudioURLs,
    trails: {
      player: b.record.playerData.trail,
      ...Object.fromEntries(
        Object.values(b.record.enemyData).filter((e: Json) => e.trail).map((
          e: Json,
        ) => [e.name, e.trail]),
      ),
    },
    frames: b.frameCount,
    sheet: b.sheet,
    bytes: {
      record: bytes(b.record),
      atlas: b.record.atlasImageDataURL.length,
    },
  };
}

// --- writing ----------------------------------------------------------------

export async function apply(
  record: Json,
  { force = false } = {},
): Promise<string> {
  const path = `levels/${LEVEL}`;
  const { value, etag } = await getWithEtag<Json>(path, { timeoutMs: 120_000 });
  if (value != null) {
    if (!force) {
      throw new Error(
        `${dbPath(path)} already holds a level; --force replaces it`,
      );
    }
    if (typeof value.gameId === "string") record.gameId = value.gameId;
  }
  await put(path, { ...record, savedAt: { ".sv": "timestamp" } }, {
    ifMatch: etag,
    timeoutMs: 180_000,
  });
  return dbPath(path);
}

export async function revert({ force = false } = {}): Promise<string> {
  const path = `levels/${LEVEL}`;
  const { value, etag } = await getWithEtag<Json>(path, { timeoutMs: 120_000 });
  if (value == null) return `${dbPath(path)} is already empty`;
  if (value.meta?.source !== "hellophaser" && !force) {
    throw new Error(
      `${dbPath(path)} is not the hellophaser conversion; --force deletes it`,
    );
  }
  await put(path, null, { ifMatch: etag });
  return `${dbPath(path)} deleted`;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["apply", "revert", "force", "serve"],
    string: ["out", "port"],
    default: { port: "8825" },
  });
  if (args.revert) {
    console.log(await revert({ force: args.force }));
    Deno.exit(0);
  }
  const build = await buildLevel();
  console.log(JSON.stringify(summary(build), null, 2));
  if (args.out) {
    await Deno.writeTextFile(
      args.out,
      JSON.stringify({ ...build.record, savedAt: Date.now() }),
    );
    console.log(`wrote ${args.out}`);
  }
  if (args.apply) {
    console.log(`written: ${await apply(build.record, { force: args.force })}`);
  } else if (args.serve) {
    const { startServer } = await import(
      "../../packages/shmup-harbor/tools/sav-profiler/lib/web.ts"
    );
    const server = startServer(build.record, { port: Number(args.port) });
    console.log(
      `playing on ${server.url}/games/2028-ai (add ?stage=N to skip the title)`,
    );
  } else {
    console.log("nothing written (--apply writes it, --revert takes it back)");
  }
}
