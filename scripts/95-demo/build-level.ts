#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Convert EVIL INVADERS '95 (easierbycode/95-demo-sp) into the shmupX cloud
 * game `95-demo`: its ten formation levels as ten stages, and the RedDevil
 * that ends its first cycle as the boss of the tenth.
 *
 *   deno run -A --node-modules-dir=none scripts/95-demo/build-level.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/95-demo/build-level.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/95-demo/build-level.ts --serve
 *   deno run -A --node-modules-dir=none scripts/95-demo/build-level.ts --apply
 *   deno run -A --node-modules-dir=none scripts/95-demo/build-level.ts --revert
 *
 * What it writes is one record, shmupX/levels/95-demo — shmupX's subtree of
 * the database it shares with cmg (mcp/lib/rtdb.ts roots every level path;
 * the root-level levels/ is never read or written):
 *
 * - `stages/stage0..stage9`, one per source level. The source flies Galaga
 *   squadrons into an Invaders formation that marches, fires and peels off
 *   into dives; replay.ts plays each level out frame by frame, and every
 *   enemy's flight is compiled into its own appearance script
 *   (entry-script.ts), so in the runtime the formation assembles, marches
 *   and dives as it does in the source. Each enemy spawns on the frame its
 *   flight starts, which the stage's `waveRows` + `waveInterval` (one Saturn
 *   frame per row value) encode: a 16-column grid, one row per spawn.
 * - `enemyData`, one record per enemy of every level — eye-dudes, pink
 *   bunnies and gold girls in their own art, with the source's hp and score —
 *   each carrying its script. The scripts open the record's fire gate only
 *   on the frames the source fires that enemy's gun, so the formation shoots
 *   one bullet per `fireDelay` from its bottom ranks, and divers fire twice.
 * - `bossData/boss9`, the RedDevil, on Fang's routine (`attackPattern:
 *   "boss4"`): its flap is the idle stance, its release the charge, its toot
 *   the shot; DevilBlast is the beam and DevilFire the aimed volley and the
 *   ring. Its death burst of three butt-devils is its `stage2`: below 36/86
 *   of its bar (the devils' 3 x 12 hp of the source's 86 in all) it bursts
 *   into the trio, on Barlog's routine, dropping DevilFire.
 * - `playerData`/`playerData2`, the source's two ships and the red/white
 *   shot; three hits, as the source's three lives.
 * - the art all of that names, packed into the level's own sheet, and a
 *   title — logo, tag line, prompt and starfield — set in the repo's arcade
 *   face (art.ts).
 * - `endsOnClear: true`: a stage ends the moment the field is empty, as a
 *   source level does when its last enemy dies (game.bundle.js reads it; a
 *   runtime without it ends each stage after its last enemy has flown off).
 *
 * The source's later cycles are not here: a cloud game has ten stages, and
 * those ten are the source's own ten levels, so its second and third bosses
 * (CoolInvader, RainbowInvader) and the foo raiders that only fly from its
 * second cycle on have no stage to be in.
 *
 * Without --apply nothing is written. --out writes the record to a file;
 * --serve plays it on a local server (the way mcp/lib/preview.ts previews a
 * character) without touching the database. --apply writes it under the
 * ETag the slot was read with, only into an empty slot (--force replaces a
 * 95-demo already there, keeping its gameId); --revert deletes it, only if
 * it is this game (--force deletes whatever is there).
 */

import { parseArgs } from "@std/cli/parse-args";
import type { Raster } from "@shmupx/shmup-harbor/png";
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
  ANIMS,
  BOSS_BLAST_SPEED,
  BOSS_FIRE_SPEED,
  BOSS_HP,
  BOSS_SCORE,
  BUTT_DEVIL_COUNT,
  BUTT_DEVIL_HP,
  BUTT_DEVIL_SCORE,
  DRAW_SCALE,
  ENEMY_TYPES,
  type EnemyKind,
  GAME_HEIGHT,
  SHEETS,
  SOURCE,
  STAGES,
  STARTING_LIVES,
} from "./source.ts";
import {
  FIELD_H,
  FIELD_W,
  type FlightRecord,
  type HalfSizes,
  hiddenAt,
  HIDE,
  replayLevel,
} from "./replay.ts";
import {
  angleFor,
  compileEntryScript,
  ENTRY_ADVANCE,
  ENTRY_NO_FIRE,
  type EntryRow,
  type Point,
  ROW_FOREVER,
  runEntryScript,
} from "./entry-script.ts";
import {
  atlasFrame,
  composite,
  gridFrame,
  loadArt,
  logoArt,
  startTextArt,
  subTitleArt,
  titleBackdropArt,
  toFieldArt,
} from "./art.ts";

export const LEVEL = "95-demo";
export const TITLE = "EVIL INVADERS '95";

/** How long after a wave locks its divers keep coming back (replay.ts). */
export const HORIZON_MS = 45_000;
/** The replay's Math.random seed; level n plays with SEED + n. */
export const SEED = 0x95de0000;

/** The runtime's wave grid with waveRows: 16 px columns, x = 16 + 16i. */
export const GRID_COLS = 16;
/** The spawn row the runtime places at y -16: every row value >= 30. */
const ROW_BASE = 30;
/** One row value per Saturn frame: two 120 Hz ticks. */
const WAVE_INTERVAL = 2;
/** The first enemy spawns this many frames into the stage. */
const FIRST_SPAWN = 30;
/** Spawned this far above the screen (game.bundle.js enemyWave). */
const SPAWN_Y = -16;
/**
 * A shadow this far above its sprite is off the screen: the source draws
 * none. (updateShadowPosition puts it at y + height - shadowOffsetY.)
 */
const SHADOW_PARK = 1000;
/** Hidden routes and pre-rolls travel this fast, px per frame. */
const HIDDEN_SPEED = 40;
/** Off-screen exits leave at this speed, px per frame. */
const EXIT_SPEED = 4;

/**
 * The zako fire gate. A Dezaemon-path zako fires on the first global fire
 * pulse it sees with its reload spent and its row's gate open
 * (game.bundle.js updateEnemyFire). Pulses come every
 * floor(255 / (28 + rank / 2)) + 1 frames, rank running 8 + 8s up to
 * 36 + 8s on stage s (dezaRank/dezaFirePulse; no item ever powers the shot
 * here). `window: 2` reloads in 2-3 pulses (zakoReload), so a gate as long
 * as the slowest pulse gap is sure to see a pulse and too short to see a
 * second shot: one bullet per gate, within a few frames of the source's.
 */
export function fireGateFrames(stage: number): number {
  return Math.floor(255 / (32 + 4 * stage)) + 1;
}
const FIRE_WINDOW = 2;
/** The runtime's fixed zako bullet speed, px per tick (ZAKO_BULLET_SPEED). */
const ZAKO_BULLET_SPEED = 1.35 / 2;

/** Source px/s to runtime px per 120 Hz tick, on the field's vertical. */
function tickSpeed(pxPerSecond: number): number {
  return Math.round((pxPerSecond * (FIELD_H / GAME_HEIGHT)) / 120 * 1000) /
    1000;
}

/** Frame names: no extension, so RTDB keys need no encoding. */
const F = {
  eyeDude: (i: number) => `ei95EyeDude${i}`,
  pinkBunny: (i: number) => `ei95PinkBunny${i}`,
  goldGirl: (i: number) => `ei95GoldGirl${i}`,
  invaderShot: (i: number) => `ei95InvaderShot${i}`,
  fighter: "ei95Fighter",
  fighterShot: "ei95FighterShot",
  kart: (i: number) => `ei95Kart${i}`,
  orb: (i: number) => `ei95Orb${i}`,
  redDevil: (i: number) => `ei95RedDevil${i}`,
  devilFire: (i: number) => `ei95DevilFire${i}`,
  devilBlast: (i: number) => `ei95DevilBlast${i}`,
  buttDevils: (i: number) => `ei95ButtDevils${i}`,
  poof: (i: number) => `ei95Poof${i}`,
};

const ENEMY_FRAMES: Record<EnemyKind, string[]> = {
  eyeDude: ANIMS.eyeDudeFlap.frames.map((_, i) => F.eyeDude(i)),
  pinkBunny: ANIMS.pinkBunnyFlap.frames.map((_, i) => F.pinkBunny(i)),
  goldGirl: ANIMS.goldGirlNormal.frames.map((_, i) => F.goldGirl(i)),
};

/** Animation fps as the runtime's animPeriod: 60 Hz frames per frame. */
const ANIM_PERIOD: Record<EnemyKind, number> = {
  eyeDude: Math.round(60 / ANIMS.eyeDudeFlap.fps),
  pinkBunny: Math.round(60 / ANIMS.pinkBunnyFlap.fps),
  goldGirl: Math.round(60 / ANIMS.goldGirlNormal.fps),
};

// deno-lint-ignore no-explicit-any
type Json = any;

// --- art --------------------------------------------------------------------

export interface LevelArt {
  frames: ResolvedFrame[];
  half: HalfSizes;
  title: {
    logo: Raster;
    subTitle: Raster;
    startText: Raster;
    backdrop: Raster;
  };
}

/** Every frame the record names, cut and sized for the shmupX field. */
export async function buildArt(): Promise<LevelArt> {
  const frames: ResolvedFrame[] = [];
  const add = (name: string, raster: Raster, source: string) =>
    frames.push({ name, raster, source, scope: LEVEL });

  const sheet = async (key: keyof typeof SHEETS) => ({
    art: SHEETS[key],
    raster: await loadArt(SHEETS[key].file),
  });

  const eye = await sheet("eyeDude");
  ANIMS.eyeDudeFlap.frames.forEach((fi, i) =>
    add(
      F.eyeDude(i),
      toFieldArt(
        gridFrame(eye.raster, eye.art, fi),
        ENEMY_TYPES.eyeDude.scale,
        true,
      ),
      `${eye.art.file}#${fi}`,
    )
  );
  for (const [i, name] of ANIMS.pinkBunnyFlap.frames.entries()) {
    const raw = await atlasFrame("pink-bunny.png", "pink-bunny.json", name);
    add(
      F.pinkBunny(i),
      toFieldArt(raw, ENEMY_TYPES.pinkBunny.scale, true),
      `pink-bunny.json#${name}`,
    );
  }
  const girl = await sheet("goldGirl");
  ANIMS.goldGirlNormal.frames.forEach((fi, i) =>
    add(
      F.goldGirl(i),
      toFieldArt(
        gridFrame(girl.raster, girl.art, fi),
        ENEMY_TYPES.goldGirl.scale,
        true,
      ),
      `${girl.art.file}#${fi}`,
    )
  );
  const shot = await sheet("invaderBullet");
  ANIMS.invaderBulletFlicker.frames.forEach((fi, i) =>
    add(
      F.invaderShot(i),
      toFieldArt(
        gridFrame(shot.raster, shot.art, fi),
        DRAW_SCALE.invaderBullet,
        true,
      ),
      `${shot.art.file}#${fi}`,
    )
  );

  add(
    F.fighter,
    toFieldArt(await loadArt("player1.png"), DRAW_SCALE.player1, true),
    "player1.png",
  );
  add(
    F.fighterShot,
    toFieldArt(
      await loadArt("player-bullet.png"),
      DRAW_SCALE.playerBullet,
      true,
    ),
    "player-bullet.png",
  );
  const kart = await sheet("player2");
  ANIMS.player2Thrust.frames.forEach((fi, i) =>
    add(
      F.kart(i),
      toFieldArt(
        gridFrame(kart.raster, kart.art, fi),
        DRAW_SCALE.player2,
        true,
      ),
      `${kart.art.file}#${fi}`,
    )
  );
  for (const [i, name] of ANIMS.purpleBubble.frames.entries()) {
    const raw = await atlasFrame("purpleOrb.png", "purpleOrb.json", name);
    add(
      F.orb(i),
      toFieldArt(raw, DRAW_SCALE.purpleOrb, true),
      `purpleOrb.json#${name}`,
    );
  }

  const devil = await sheet("redDevil");
  for (const fi of RED_DEVIL_FRAMES) {
    add(
      F.redDevil(fi),
      toFieldArt(
        gridFrame(devil.raster, devil.art, fi),
        DRAW_SCALE.redDevil,
        true,
      ),
      `${devil.art.file}#${fi}`,
    );
  }
  const fire = await sheet("devilFire");
  ANIMS.devilFireBurn.frames.forEach((fi, i) =>
    add(
      F.devilFire(i),
      toFieldArt(
        gridFrame(fire.raster, fire.art, fi),
        DRAW_SCALE.devilFire,
        false,
      ),
      `${fire.art.file}#${fi}`,
    )
  );
  const blast = await sheet("devilBlast");
  ANIMS.devilBlastBurn.frames.forEach((fi, i) =>
    add(
      F.devilBlast(i),
      toFieldArt(
        gridFrame(blast.raster, blast.art, fi),
        DRAW_SCALE.devilBlast,
        false,
      ),
      `${blast.art.file}#${fi}`,
    )
  );
  // The butt-devil trio: three devils side by side, the middle one a little
  // lower, each a beat further through the flap so they never flap in step.
  const butts = await sheet("buttDevils");
  const flap = ANIMS.buttDevilFlap.frames;
  const devilArt = flap.map((fi) =>
    toFieldArt(
      gridFrame(butts.raster, butts.art, fi),
      DRAW_SCALE.buttDevil,
      true,
    )
  );
  const dw = devilArt[0].width, dh = devilArt[0].height;
  const gap = 2, drop = 6;
  for (let k = 0; k < flap.length; k++) {
    add(
      F.buttDevils(k),
      composite(dw * 3 + gap * 2, dh + drop, [
        { art: devilArt[k % flap.length], x: 0, y: 0 },
        { art: devilArt[(k + 1) % flap.length], x: dw + gap, y: drop },
        { art: devilArt[(k + 2) % flap.length], x: (dw + gap) * 2, y: 0 },
      ]),
      `${butts.art.file}#${flap.join(",")}`,
    );
  }
  const poof = await sheet("poof");
  ANIMS.poof.frames.forEach((fi, i) =>
    add(
      F.poof(i),
      toFieldArt(
        gridFrame(poof.raster, poof.art, fi),
        DRAW_SCALE.bossPoof,
        true,
      ),
      `${poof.art.file}#${fi}`,
    )
  );

  const size = (name: string) => {
    const f = frames.find((x) => x.name === name)!;
    return { w: f.raster.width / 2, h: f.raster.height / 2 };
  };
  return {
    frames,
    half: {
      eyeDude: size(F.eyeDude(0)),
      pinkBunny: size(F.pinkBunny(0)),
      goldGirl: size(F.goldGirl(0)),
    },
    title: {
      logo: await logoArt(),
      subTitle: await subTitleArt(),
      startText: await startTextArt(),
      backdrop: titleBackdropArt(),
    },
  };
}

/** The RedDevil frames the boss record names: flap, release, toot. */
const RED_DEVIL_FRAMES = [
  ...new Set([
    ...ANIMS.redDevilFlap.frames,
    ...ANIMS.redDevilRelease.frames,
    ...ANIMS.redDevilToot.frames,
  ]),
];

// --- the stages ---------------------------------------------------------------

/** Letters for enemy n of stage s: stage letter, then two base-26 letters. */
export function enemyLetters(stage: number, n: number): string {
  const L = (v: number) => String.fromCharCode(65 + v);
  return L(stage) + L(Math.floor(n / 26)) + L(n % 26);
}

export interface CompiledEnemy {
  letters: string;
  kind: EnemyKind;
  /** Wave frame it spawns on (after the stage's shift). */
  spawnFrame: number;
  column: number;
  rows: EntryRow[];
  /** Frames from spawn until the runtime culls it, if never shot. */
  lifeFrames: number;
  maxVisibleError: number;
  shots: number;
}

export interface StageBuild {
  stage: number;
  enemies: CompiledEnemy[];
  enemylist: string[][];
  waveRows: number[];
  /** Wave frame the stage's last row is due: its end if nobody is shot. */
  endFrame: number;
  lockFrame: number;
}

/** Inside the box the runtime culls enemies outside of (and below the top). */
function inCullBox(p: Point): boolean {
  return p.x >= -39 && p.x <= FIELD_W + 39 && p.y <= FIELD_H + 19 &&
    p.y >= -60;
}

/** Positions from `from` to `to` at `speed`, one a frame, `to` last. */
function walk(pts: Point[], speed: number): Point[] {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const n = Math.max(1, Math.ceil(len / speed));
  const out: Point[] = [];
  for (let f = 1; f <= n; f++) {
    let d = (len * f) / n;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(
        pts[i].x - pts[i - 1].x,
        pts[i].y - pts[i - 1].y,
      );
      if (d <= seg + 1e-9 || i === pts.length - 1) {
        const u = seg === 0 ? 1 : Math.min(1, d / seg);
        out.push({
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u,
        });
        break;
      }
      d -= seg;
    }
  }
  return out;
}

/** Compile one replayed flight into an enemy record's script. */
export function compileFlight(
  flight: FlightRecord,
  stage: number,
  half: HalfSizes,
): Omit<CompiledEnemy, "letters"> {
  const size = half[flight.kind];
  const isHidden = (p: Point) => hiddenAt(p, size);
  const track = flight.track;
  const p0 = track[0].pos;

  // Spawn column: the grid x nearest where the flight starts.
  const column = Math.max(
    0,
    Math.min(
      GRID_COLS - 1,
      Math.round((Math.min(256, Math.max(16, p0.x)) - 16) / 16),
    ),
  );
  const spawn = { x: 16 + 16 * column, y: SPAWN_Y };
  const mirror = spawn.x > FIELD_W / 2;

  // Pre-roll from the spawn point onto the flight's first position.
  let pre: Point[];
  if (track[0].hidden) {
    const sideX = p0.x < FIELD_W / 2 ? HIDE.left : HIDE.right;
    pre = walk([
      spawn,
      { x: sideX, y: spawn.y },
      { x: sideX, y: p0.y },
      p0,
    ], HIDDEN_SPEED);
  } else {
    const p1 = track[1].pos;
    const v = Math.max(0.5, Math.hypot(p1.x - p0.x, p1.y - p0.y));
    pre = walk([spawn, p0], v);
  }
  const spawnFrame = flight.launchFrame - pre.length;

  const pos: Point[] = [spawn, ...pre];
  const hidden: boolean[] = [true, ...pre.map((p) => isHidden(p))];
  for (let i = 1; i < track.length; i++) {
    if (track[i].frame !== track[i - 1].frame + 1) {
      throw new Error(`flight ${flight.id}: track skips a frame`);
    }
    pos.push(track[i].pos);
    hidden.push(track[i].hidden);
  }
  const K = pos.length - 1;

  // Fire gates: open for one pulse gap from the frame the source fires.
  const gate = fireGateFrames(stage);
  const fire = new Array<boolean>(K).fill(false);
  for (const s of flight.shots) {
    const k0 = s.frame - spawnFrame - 1;
    for (let k = Math.max(0, k0); k < Math.min(K, k0 + gate); k++) {
      fire[k] = true;
    }
  }

  const compiled = compileEntryScript({ pos, hidden, fire }, {
    mirror,
    isHidden,
    inBounds: inCullBox,
  });

  // Leaving the screen by now: carry on the way it was flying if that heads
  // out, else take the nearest edge, until the runtime culls it.
  const last = compiled.sim[compiled.sim.length - 1];
  const prev = compiled.sim[Math.max(0, compiled.sim.length - 2)];
  let out: Point;
  if (last.y > FIELD_H) out = { x: 0, y: 1 };
  else if (last.x < 0) out = { x: -1, y: 0 };
  else if (last.x > FIELD_W) out = { x: 1, y: 0 };
  else out = { x: last.x < FIELD_W / 2 ? -1 : 1, y: 0 };
  const mv = { x: last.x - prev.x, y: last.y - prev.y };
  const mvLen = Math.hypot(mv.x, mv.y);
  const dir = mvLen > 0.5 && (mv.x * out.x + mv.y * out.y) / mvLen > 0.5
    ? { x: mv.x / mvLen, y: mv.y / mvLen }
    : out;
  const rows: EntryRow[] = [
    ...compiled.rows,
    [
      ROW_FOREVER,
      angleFor(dir.x, dir.y, mirror),
      0,
      EXIT_SPEED * 256,
      ENTRY_ADVANCE | ENTRY_NO_FIRE,
    ],
  ];

  // Check the whole script as the runtime will run it.
  const run = runEntryScript(rows, spawn, mirror, K + 200);
  let worst = 0;
  for (let k = 1; k <= K; k++) {
    if (hidden[k]) {
      if (!isHidden(run[k]) || !inCullBox(run[k])) {
        throw new Error(
          `flight ${flight.id}: frame ${k} shows on a hidden route`,
        );
      }
      continue;
    }
    worst = Math.max(
      worst,
      Math.hypot(run[k].x - pos[k].x, run[k].y - pos[k].y),
    );
  }
  let life = K;
  while (life < run.length) {
    const p = run[life];
    if (p.y > FIELD_H + 20 || p.x < -40 || p.x > FIELD_W + 40) break;
    life++;
  }
  if (life - K > 120) {
    throw new Error(`flight ${flight.id}: takes too long to leave the field`);
  }

  return {
    kind: flight.kind,
    spawnFrame,
    column,
    rows,
    lifeFrames: life,
    maxVisibleError: worst,
    shots: flight.shots.length,
  };
}

/** One source level as a shmupX stage. */
export function buildStage(stage: number, half: HalfSizes): StageBuild {
  const level = stage + 1;
  const replay = replayLevel({
    level,
    def: STAGES[stage],
    half,
    horizonMs: HORIZON_MS,
    seed: SEED + level,
    hiddenSpeed: HIDDEN_SPEED,
  });
  const compiled = replay.flights.map((f) => compileFlight(f, stage, half));
  const shift = Math.min(...compiled.map((c) => c.spawnFrame)) - FIRST_SPAWN;
  const enemies: CompiledEnemy[] = compiled.map((c, n) => ({
    ...c,
    letters: enemyLetters(stage, n),
    spawnFrame: c.spawnFrame - shift,
  }));

  // One grid row per spawn frame (two if two enemies share a column), in
  // spawn order, between an empty first row (frame 0, the row the rest are
  // counted from) and an empty last row once every enemy has gone.
  const spawnRows: { frame: number; cells: string[] }[] = [
    { frame: 0, cells: new Array(GRID_COLS).fill("00") },
  ];
  const sorted = [...enemies].sort((a, b) =>
    a.spawnFrame - b.spawnFrame || a.letters.localeCompare(b.letters)
  );
  for (const e of sorted) {
    let row = spawnRows.find((r) =>
      r.frame === e.spawnFrame && r.cells[e.column] === "00"
    );
    if (!row) {
      row = { frame: e.spawnFrame, cells: new Array(GRID_COLS).fill("00") };
      spawnRows.push(row);
    }
    row.cells[e.column] = `${e.letters}0`;
  }
  const endFrame =
    Math.max(...enemies.map((e) => e.spawnFrame + e.lifeFrames)) +
    30;
  spawnRows.push({ frame: endFrame, cells: new Array(GRID_COLS).fill("00") });

  // The runtime plays enemylist bottom-up.
  const ordered = spawnRows.slice().reverse();
  return {
    stage,
    enemies,
    enemylist: ordered.map((r) => r.cells),
    waveRows: ordered.map((r) => ROW_BASE + r.frame),
    endFrame,
    lockFrame: replay.lockFrame - shift,
  };
}

/** The record for one enemy: its art, its stats and its script. */
function enemyRecord(e: CompiledEnemy, stage: number): Json {
  const type = ENEMY_TYPES[e.kind];
  return {
    name: e.kind,
    texture: ENEMY_FRAMES[e.kind],
    hp: type.hp,
    score: type.score,
    spgage: 1,
    speed: 0.8,
    interval: -1,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    bulletData: {
      texture: ANIMS.invaderBulletFlicker.frames.map((_, i) =>
        F.invaderShot(i)
      ),
      damage: 1,
      hp: 1,
      score: 10,
      spgage: 1,
      speed: ZAKO_BULLET_SPEED,
    },
    dezaemon: {
      behavior: {
        animPeriod: ANIM_PERIOD[e.kind],
        ground: false,
        movePattern: 0,
        move: { mode: 0, flag: false },
        fire: {
          enabled: true,
          geometry: 1,
          aimed: STAGES[stage].aimedShots,
          mode: 0,
          window: FIRE_WINDOW,
        },
        rotation: { enabled: false },
        scale: { enabled: false },
        zoom: { enabled: false },
        direction: { enabled: false },
        death: { mode: 0, param: 0, silent: false, small: false },
      },
      entry: { rows: e.rows },
    },
  };
}

// --- the boss and the ships -------------------------------------------------

const repeatEach = (names: string[], n: number) =>
  names.flatMap((name) => new Array(n).fill(name));

/** The RedDevil and its butt-devils, as boss9. */
export function redDevilRecord(): Json {
  const totalHp = BOSS_HP + BUTT_DEVIL_COUNT * BUTT_DEVIL_HP;
  // The runtime turns a boss stance frame every 150 ms; the flap is 2 fps.
  const flap = repeatEach(ANIMS.redDevilFlap.frames.map(F.redDevil), 3);
  const fire = ANIMS.devilFireBurn.frames.map((_, i) => F.devilFire(i));
  const blast = ANIMS.devilBlastBurn.frames.map((_, i) => F.devilBlast(i));
  return {
    name: "redDevil",
    attackPattern: "boss4",
    hp: totalHp,
    score: BOSS_SCORE + BUTT_DEVIL_COUNT * BUTT_DEVIL_SCORE,
    spgage: 30,
    interval: 200,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    anim: {
      idle: flap,
      wait: flap,
      // the release, up to the pose it toots from
      charge: [11, 12, 13].map(F.redDevil),
      shoot: ANIMS.redDevilToot.frames.map(F.redDevil),
    },
    // Fang's beam: the art points right, as bossShootBeam wants it.
    bulletDataA: {
      texture: blast,
      speed: tickSpeed(BOSS_BLAST_SPEED),
      damage: 1,
      hp: 10,
      score: 100,
      spgage: 3,
    },
    // The aimed volley: DevilFire's art points down-right, so it turns to
    // its heading exactly as the source's `angle = heading - 45` turns it.
    bulletDataB: {
      texture: fire,
      frameRate: ANIMS.devilFireBurn.fps,
      facing: 45,
      speed: tickSpeed(BOSS_FIRE_SPEED),
      damage: 1,
      hp: 3,
      score: 50,
      spgage: 1,
    },
    bulletDataC: {
      texture: fire,
      speed: tickSpeed(BOSS_FIRE_SPEED),
      damage: 1,
      hp: 3,
      score: 50,
      spgage: 1,
    },
    stage2: {
      hpBelow: Math.round((BUTT_DEVIL_COUNT * BUTT_DEVIL_HP / totalHp) * 1e4) /
        1e4,
      attackPattern: "boss1",
      anim: {
        morph: [
          ...ANIMS.redDevilRelease.frames.slice(0, 5).map(F.redDevil),
          ...ANIMS.poof.frames.map((_, i) => F.poof(i)),
        ],
        idle: ANIMS.buttDevilFlap.frames.map((_, i) => F.buttDevils(i)),
      },
      bulletData: {
        texture: fire,
        frameRate: ANIMS.devilFireBurn.fps,
        facing: 45,
        speed: tickSpeed(210),
        damage: 1,
        hp: 3,
        score: 50,
        spgage: 1,
      },
    },
  };
}

export function playerRecords(): { playerData: Json; playerData2: Json } {
  return {
    playerData: {
      name: "ei95Fighter",
      texture: [F.fighter],
      maxHp: STARTING_LIVES,
      // The source has no bomb; shmupX's SP bomb stays, worth a butt-devil.
      spDamage: BUTT_DEVIL_HP,
      speed: 150,
      defaultShootName: "normal",
      defaultShootSpeed: "speed_normal",
      // 23 ticks is the source's 190 ms cooldown.
      shootNormal: {
        name: "normal",
        texture: [F.fighterShot],
        damage: 1,
        hp: 1,
        interval: 23,
      },
      shootBig: {
        name: "big",
        texture: ANIMS.purpleBubble.frames.map((_, i) => F.orb(i)),
        damage: 2,
        hp: 100,
        interval: 39,
      },
      shoot3way: {
        name: "3way",
        texture: [F.fighterShot],
        damage: 1,
        hp: 1,
        interval: 31,
      },
    },
    playerData2: {
      name: "ei95Kart",
      texture: ANIMS.player2Thrust.frames.map((_, i) => F.kart(i)),
    },
  };
}

// --- the record -------------------------------------------------------------

export interface Build {
  record: Json;
  stages: StageBuild[];
  frameCount: number;
  sheet: { w: number; h: number };
}

const pngUrl = (r: Raster) => sheetDataUrl(r);

/** The stock 2028.Ai recipe every cloud level is merged over. */
const STOCK_RECIPE = new URL(
  "../../static/games/2028-ai/assets/game.json",
  import.meta.url,
);

/** Every texture name a record carries, for the frame check. */
function namedFrames(record: Json): Set<string> {
  const out = new Set<string>();
  const walk = (v: Json, key = "") => {
    if (Array.isArray(v)) {
      if (
        (key === "texture" || key === "") &&
        v.every((x) => typeof x === "string")
      ) {
        v.forEach((x) => out.add(x));
      } else v.forEach((x) => walk(x, ""));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "rows") continue;
        walk(x, k === "texture" ? "texture" : "");
      }
    }
  };
  for (const key of ["enemyData", "bossData", "playerData", "playerData2"]) {
    walk(record[key]);
  }
  return out;
}

/** Build the whole cloud game. */
export async function buildLevel(): Promise<Build> {
  const art = await buildArt();
  const stages = STAGES.map((_, s) => buildStage(s, art.half));

  const enemyData: Json = {};
  for (const st of stages) {
    for (const e of st.enemies) {
      enemyData[`enemy${e.letters}`] = enemyRecord(e, st.stage);
    }
  }
  const stageRecords: Json = {};
  for (const st of stages) {
    stageRecords[`stage${st.stage}`] = {
      enemylist: st.enemylist,
      waveRows: st.waveRows,
      waveInterval: WAVE_INTERVAL,
    };
  }

  const packed = packFrames(art.frames);
  const { playerData, playerData2 } = playerRecords();
  const record: Json = {
    name: LEVEL,
    title: TITLE,
    gameId: gameIdForLevel({ name: LEVEL }),
    meta: { version: "1.0", source: "95-demo-sp", origin: SOURCE.repo },
    noStory: true,
    ownCutin: false,
    ownItems: false,
    godMode: false,
    endsOnClear: true,
    width: GRID_COLS,
    stageKey: "stage0",
    enemylist: stageRecords.stage0.enemylist,
    waveRows: stageRecords.stage0.waveRows,
    waveInterval: WAVE_INTERVAL,
    stages: stageRecords,
    enemyData,
    bossData: { boss9: redDevilRecord() },
    playerData,
    playerData2,
    atlasImageDataURL: await sheetDataUrl(packed.sheet),
    atlasFrames: encodeFrameMap(packed.json.frames),
    titleBgDataURL: await pngUrl(art.title.backdrop),
    logoDataURL: await pngUrl(art.title.logo),
    subTitleDataURL: await pngUrl(art.title.subTitle),
    titleStartTextDataURL: await pngUrl(art.title.startText),
  };

  // --- checks: a record the runtime would quietly mis-draw is not written
  const missing = [...namedFrames(record)].filter((n) =>
    !packed.json.frames[n]
  );
  if (missing.length) throw new Error(`frames not packed: ${missing}`);
  const bad = badRtdbKey(record);
  if (bad) throw new Error(`RTDB refuses the key at ${bad}`);
  // The runtime lays playerData over the stock ship's (mergeRecipe), so the
  // schema sees the barrier this record leaves to the stock game.
  const stock = JSON.parse(await Deno.readTextFile(STOCK_RECIPE));
  const recipe: Json = {
    ...stageRecords,
    enemyData,
    bossData: record.bossData,
    playerData: { ...stock.playerData, ...playerData },
    meta: record.meta,
  };
  const schema = validateGameJson(recipe);
  if (!schema.ok) throw new Error(`schema: ${schema.errors.join("; ")}`);

  return {
    record,
    stages,
    frameCount: art.frames.length,
    sheet: { w: packed.sheet.width, h: packed.sheet.height },
  };
}

/** What a dry run prints. */
export function summary(b: Build): Json {
  const bytes = (v: unknown) =>
    new TextEncoder().encode(JSON.stringify(v)).length;
  return {
    level: dbPath(`levels/${LEVEL}`),
    gameId: b.record.gameId,
    title: b.record.title,
    stages: b.stages.map((s) => ({
      stage: s.stage,
      enemies: s.enemies.length,
      rows: s.enemylist.length,
      scriptRows: s.enemies.reduce((n, e) => n + e.rows.length, 0),
      lockS: Math.round(s.lockFrame / 6) / 10,
      endS: Math.round(s.endFrame / 6) / 10,
      shots: s.enemies.reduce((n, e) => n + e.shots, 0),
      worstVisibleErrorPx: Math.round(
        Math.max(...s.enemies.map((e) => e.maxVisibleError)) * 100,
      ) / 100,
    })),
    boss: "boss9 redDevil (Fang), stage2 butt-devils (Barlog)",
    frames: b.frameCount,
    sheet: b.sheet,
    bytes: {
      record: bytes(b.record),
      enemyData: bytes(b.record.enemyData),
      atlas: b.record.atlasImageDataURL.length,
    },
  };
}

// --- writing ----------------------------------------------------------------

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

/** Delete the record — only this game's, unless forced. */
export async function revert({ force = false } = {}): Promise<string> {
  const path = `levels/${LEVEL}`;
  const { value, etag } = await getWithEtag<Json>(path, {
    timeoutMs: 120_000,
  });
  if (value == null) return `${dbPath(path)} is already empty`;
  if (value.meta?.source !== "95-demo-sp" && !force) {
    throw new Error(
      `${dbPath(path)} is not the 95-demo conversion; --force deletes it`,
    );
  }
  await put(path, null, { ifMatch: etag });
  return `${dbPath(path)} deleted`;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["apply", "revert", "force", "serve"],
    string: ["out", "port"],
    default: { port: "8823" },
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
