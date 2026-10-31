#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Convert Evil Invaders (easierbycode/evil-invaders, the Phaser CE shooter at
 * easierbycode.com/evil-invaders) into the shmupX cloud game `evil-invaders`:
 * its two levels as two stages, the second RedDevil of the first as its boss.
 *
 *   deno run -A --node-modules-dir=none scripts/evil-invaders/build-level.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/evil-invaders/build-level.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/evil-invaders/build-level.ts --serve
 *   deno run -A --node-modules-dir=none scripts/evil-invaders/build-level.ts --apply
 *   deno run -A --node-modules-dir=none scripts/evil-invaders/build-level.ts --revert
 *
 * What it writes is one record, shmupX/levels/evil-invaders — shmupX's
 * subtree of the database it shares with cmg (mcp/lib/rtdb.ts roots every
 * level path; the root-level levels/ is never read or written). The shape is
 * 95-demo's (scripts/95-demo/build-level.ts): EVIL INVADERS '95 is this
 * game's descendant, and its converter's script compiler, fire gates and
 * art pipeline are reused here.
 *
 * - `stages/stage0` and `stage1`, one per source level. The source sends
 *   each enemy at a time on its level's clock, from 100 px above the world,
 *   at a straight-line velocity that bounces off the side walls and runs
 *   off the bottom; flight.ts plays each one out at 60 Hz as GenericEnemy
 *   does, and compileFlight turns the flight into that enemy's own Dezaemon
 *   appearance script (95-demo's entry-script.ts), fitted row by row against
 *   an exact port of the runtime's stepEntryScript. Each enemy spawns on the
 *   frame its flight starts, which the stage's `waveRows` + `waveInterval`
 *   (one Saturn frame per row value) encode on the 16-column grid; the last
 *   row is empty and due when the level ends — the source's level timer —
 *   or, on the first stage, when the source sends its second RedDevil.
 * - `enemyData`, one record per spawn: Bowser, the flirty girls, the cool
 *   and rainbow Invaders in their own art at the size each spawn draws it,
 *   with the table's hp, each carrying its script. The scripts open the
 *   record's fire gate only on the frames the source fires that enemy's
 *   gun — every two seconds from its spawn, except the first shot, which
 *   the source fires off the world and Phaser kills unseen — so Bowser's
 *   fireballs aim at the player and the girls' lips and the Invaders'
 *   bullets drop straight down, one a gate. The first RedDevil of level 1
 *   is a zako too: it descends to where the source parks it, holds, and
 *   fires DevilFire at the player through a gate every two seconds, where
 *   the source alternates its DevilFire and its DevilBlast.
 * - `bossData/boss0`, the second RedDevil, due when the source sends it, a
 *   second after the first. It flies Fang's routine (`attackPattern:
 *   "boss4"`), as 95-demo's does: its flap is the idle stance, its release
 *   the charge, its toot the shot; DevilBlast is the beam and DevilFire the
 *   aimed volley and the ring. Its death burst of three LittleDevils is its
 *   `stage2`: below the devils' share of its bar (3 x 12 hp of 86 in all)
 *   it bursts into the trio, on Barlog's routine, dropping half-size
 *   DevilFire. Level 2 has no boss and gets none: its stage ends on its
 *   timer, as the source's does.
 * - `playerData`, Peach's ship with its boosters and the purple bubbles.
 * - the art all of that names, packed into the level's own sheet; a title —
 *   logo, tag line, prompt and starfield — the source never had, set in the
 *   repo's arcade face (art.ts); and `stageBackgrounds`, the source's black
 *   sky with its falling stars, for every stage.
 * - `ownCutin: true` and, in the sheet, the SP bomb's cut-in: rando's nine
 *   frames under the stock names (CUTIN_SHEET), for the reason 95-demo
 *   carries them — the eShop's web build is a page the loader would not
 *   paint them onto.
 *
 * Without --apply nothing is written. --out writes the record to a file;
 * --serve plays it on a local server (the way mcp/lib/preview.ts previews a
 * character) without touching the database. --apply writes it under the
 * ETag the slot was read with, only into an empty slot (--force replaces an
 * evil-invaders already there, keeping its gameId); --revert deletes it,
 * only if it is this game (--force deletes whatever is there).
 */

import { parseArgs } from "@std/cli/parse-args";
import { decodePng, type Raster } from "@shmupx/shmup-harbor/png";
import { rotateCcw } from "@shmupx/shmup-harbor/raster";
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
  CUTIN,
  CUTIN_COUNT,
  enemyLetters,
  fireGateFrames,
  GRID_COLS,
  TEXTURE_LIMIT,
} from "../95-demo/build-level.ts";
import {
  angleFor,
  compileEntryScript,
  ENTRY_ADVANCE,
  ENTRY_NO_FIRE,
  type EntryRow,
  type Point,
  ROW_FOREVER,
  runEntryScript,
} from "../95-demo/entry-script.ts";
import {
  ANIMS,
  BULLET_SPEED,
  BURST,
  type BurstKind,
  DEVIL_BLAST_SPEED,
  ENEMY_CLASSES,
  type EnemyKind,
  FLIRTY_GIRL_ATLAS,
  FPS,
  LEVELS,
  LITTLE_DEVIL,
  PLAYER_FIRE_RATE_MS,
  POOF_SCALE,
  RAINBOW_BULLET_TINTS,
  SHEETS,
  SOURCE,
  type SpawnDef,
} from "./source.ts";
import {
  FIELD_H,
  FIELD_W,
  type FlightRecord,
  type HalfSize,
  hiddenAt,
  KY,
  replayEnemy,
  spriteScale,
} from "./flight.ts";
import {
  atlasFrame,
  blankArt,
  burstFrames,
  composite,
  gridFrame,
  loadArt,
  logoArt,
  stageBackdropArt,
  startTextArt,
  subTitleArt,
  tinted,
  titleBackdropArt,
  toFieldArt,
} from "./art.ts";

export const LEVEL = "evil-invaders";
export const TITLE = "EVIL INVADERS";

/** The spawn row the runtime places at y -16: every row value >= 30. */
const ROW_BASE = 30;
/** One row value per Saturn frame: two 120 Hz ticks. */
const WAVE_INTERVAL = 2;
/** No enemy spawns earlier than this many frames into a stage. */
const FIRST_SPAWN = 30;
/** Spawned this far above the screen (game.bundle.js enemyWave). */
const SPAWN_Y = -16;
/**
 * A flight is picked up from its first frame at or below this field y: the
 * runtime culls an enemy above -60, and the source's sprites start 100 px
 * above its world, well past that.
 */
export const ENTRY_Y = -56;
/**
 * A shadow this far above its sprite is off the screen: the source draws
 * none. (updateShadowPosition puts it at y + height - shadowOffsetY.)
 */
const SHADOW_PARK = 1000;
/** The pre-roll from the spawn point onto the flight travels this fast, px per frame. */
const HIDDEN_SPEED = 40;
/** Off-screen exits leave at this speed, px per frame. */
const EXIT_SPEED = 4;
/** The zako fire gate's reload: two or three pulses (see fireGateFrames). */
const FIRE_WINDOW = 2;
/** Peach's bubbles: 60 ms apart is 7 ticks at 120 Hz. */
export const PLAYER_SHOT_TICKS = Math.round(PLAYER_FIRE_RATE_MS / 1000 * 120);

/**
 * The Invaders' hit gate, as hp. CoolInvaders.damageEnemy and
 * RainbowInvaders.damageEnemy land a hit only while the sprite's getHit
 * animation is not playing — four frames at 12 fps, 333 ms — so under
 * Peach's stream of a bubble every 60 ms the next hit lands 360 ms after
 * the last, and the big CoolInvader's 10 hp are 3.6 s of fire. The runtime
 * has no such gate: every bubble that touches an enemy hits it, 7 ticks
 * apart. So an Invader's record hp is the table's times the bubbles that
 * land in one of the source's gates, and it stands under fire for as long
 * as it does in the source, instead of going down before it is well on the
 * screen.
 */
export function hitGateHits(): number {
  const anim = ANIMS.coolInvaderGetHit;
  const animMs = anim.frames.length / anim.fps * 1000;
  const gateMs = Math.ceil(animMs / PLAYER_FIRE_RATE_MS) * PLAYER_FIRE_RATE_MS;
  const bubbleMs = PLAYER_SHOT_TICKS * 1000 / 120;
  return Math.round(gateMs / bubbleMs);
}

/**
 * An Invader's death burst (BURST in source.ts) is a zako of its own: the
 * record's death word spawns it where the Invader died (mode 2, a
 * successor), and it plays the burst baked as BURST_FRAMES frames,
 * BURST_ANIM_PERIOD Saturn frames each — the source's half second — then
 * blank frames while it holds a little longer (BURST_HOLD, enough for the
 * runtime's animation clock to have shown the last frame) and leaves by the
 * top at full speed, where the runtime retires a successor at once. It is
 * drawn at BURST_ZOOM, a zoom off unity, which is what the runtime's
 * contact passes skip: the burst can neither be hit nor hit anything.
 */
export const BURST_FRAMES = 10;
export const BURST_ANIM_PERIOD = 3;
export const BURST_BLANKS = 6;
export const BURST_HOLD = 40;
export const BURST_ZOOM = 0.9;
/** The burst frame's size for a sprite this tall on the field: room to fly. */
export function burstSize(spriteHeight: number): number {
  return Math.max(80, Math.min(160, Math.round(spriteHeight * 1.6 / 16) * 16));
}
/**
 * The source keeps no score. Here an enemy is worth a hundred points an hp,
 * the stock game's rate for its zako (soliderA: 1 hp, 100 points), so the
 * big Bowser is 2,500 and a RedDevil 5,000 — EVIL INVADERS '95's figure
 * for the same devil.
 */
export const SCORE_PER_HP = 100;

/** Source px/s to runtime px per 120 Hz tick, on the field's vertical. */
export function tickSpeed(pxPerSecond: number): number {
  return Math.round((pxPerSecond * KY) / 120 * 1000) / 1000;
}

/** A frame's name carries its draw scale, since each spawn draws its own size. */
const pct = (scale: number) => String(Math.round(scale * 100));

/**
 * Frame names: no extension, so RTDB keys need no encoding — except the SP
 * bomb's cut-in, which takes the stock atlas's own names (cutin0.gif ..
 * cutin8.gif) because it replaces those frames (see 95-demo).
 */
const F = {
  enemy: (kind: EnemyKind, scale: number, i: number) =>
    `ei${kind[0].toUpperCase()}${kind.slice(1)}${pct(scale)}_${i}`,
  bullet: (name: string, scale: number, i: number) =>
    `ei${name}${pct(scale)}_${i}`,
  rainbowShot: (scale: number, tint: number, flicker: number) =>
    `eiRainbowShot${pct(scale)}_${tint}_${flicker}`,
  redDevil: (i: number) => `eiRedDevil${i}`,
  devilFire: (i: number) => `eiDevilFire${i}`,
  devilFireHalf: (i: number) => `eiDevilFireHalf${i}`,
  devilBlast: (i: number) => `eiDevilBlast${i}`,
  buttDevils: (i: number) => `eiButtDevils${i}`,
  poof: (i: number) => `eiPoof${i}`,
  peach: (i: number) => `eiPeach${i}`,
  bubble: (i: number) => `eiBubble${i}`,
  burst: (kind: BurstKind, scale: number, i: number) =>
    `eiBurst${kind[0].toUpperCase()}${kind.slice(1)}${pct(scale)}_${i}`,
  blank: "eiBlank",
  cutin: (i: number) => `cutin${i}.gif`,
};

/** The SP bomb's cut-in: rando's nine frames, as 95-demo carries them. */
const CUTIN_SHEET = new URL(
  "../../static/games/2028-ai/assets/img/cutinCustom.png",
  import.meta.url,
);

/** The stock atlas the level's sheet is stacked under, packed to its width. */
const STOCK_ATLAS = new URL(
  "../../static/games/2028-ai/assets/game_asset.json",
  import.meta.url,
);

/** The stock 2028.Ai recipe every cloud level is merged over. */
const STOCK_RECIPE = new URL(
  "../../static/games/2028-ai/assets/game.json",
  import.meta.url,
);

/**
 * The RainbowInvader's bullet picks one of eight tints at random every
 * frame and flickers between its two frames at 2 fps; the runtime cycles a
 * frame list instead, so the record names sixty frames a second — the
 * eight tints in turn over the flicker frame that is due — out of sixteen
 * baked ones.
 */
export const RAINBOW_SHOT_FPS = 60;
export const RAINBOW_SHOT_CYCLE = Array.from({ length: 60 }, (_, i) => ({
  tint: i % RAINBOW_BULLET_TINTS.length,
  flicker: ANIMS.invaderBulletGyrate.frames[
    Math.floor(i / (RAINBOW_SHOT_FPS / ANIMS.invaderBulletGyrate.fps)) %
    ANIMS.invaderBulletGyrate.frames.length
  ],
}));

// deno-lint-ignore no-explicit-any
type Json = any;

/** Every (kind, scale) a level draws, in spawn order, each once. */
export function spriteVariants(): { kind: EnemyKind; scale: number }[] {
  const seen = new Set<string>();
  const out: { kind: EnemyKind; scale: number }[] = [];
  for (const level of LEVELS) {
    for (const def of level.enemies) {
      const scale = spriteScale(def);
      const key = `${def.key}@${scale}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: def.key, scale });
    }
  }
  return out;
}

const variantKey = (kind: EnemyKind, scale: number) => `${kind}@${scale}`;

// --- art --------------------------------------------------------------------

export interface LevelArt {
  frames: ResolvedFrame[];
  /** Half the drawn size of each sprite variant, by variantKey. */
  half: Record<string, HalfSize>;
  title: {
    logo: Raster;
    subTitle: Raster;
    startText: Raster;
    backdrop: Raster;
  };
  stageBackdrop: Raster;
}

/** The frames an enemy variant's record names, for its idle animation. */
function enemyFrames(kind: EnemyKind, scale: number): string[] {
  const flap = kind === "flirtyGirl"
    ? [0]
    : kind === "bowser"
    ? ANIMS.bowserFlap.frames
    : kind === "coolInvader"
    ? ANIMS.coolInvaderFlap.frames
    : kind === "rainbowInvader"
    ? ANIMS.rainbowInvaderFlap.frames
    : ANIMS.redDevilFlap.frames;
  return flap.map((_, i) =>
    kind === "redDevil"
      ? F.redDevil(ANIMS.redDevilFlap.frames[i])
      : F.enemy(kind, scale, i)
  );
}

/** Animation fps as the runtime's animPeriod: 60 Hz frames per frame. */
function animPeriod(kind: EnemyKind): number {
  const fps = kind === "flirtyGirl"
    ? 1
    : kind === "bowser"
    ? ANIMS.bowserFlap.fps
    : kind === "coolInvader"
    ? ANIMS.coolInvaderFlap.fps
    : kind === "rainbowInvader"
    ? ANIMS.rainbowInvaderFlap.fps
    : ANIMS.redDevilFlap.fps;
  return Math.round(FPS / fps);
}

/** The RedDevil frames the records name: flap, release, toot. */
export const RED_DEVIL_FRAMES = [
  ...new Set([
    ...ANIMS.redDevilFlap.frames,
    ...ANIMS.redDevilRelease.frames,
    ...ANIMS.redDevilToot.frames,
  ]),
];

/** Every frame the record names, cut and sized for the shmupX field. */
export async function buildArt(): Promise<LevelArt> {
  const frames: ResolvedFrame[] = [];
  const add = (name: string, raster: Raster, source: string) =>
    frames.push({ name, raster, source, scope: LEVEL });
  const sheets = new Map<string, Raster>();
  const sheet = async (key: keyof typeof SHEETS) => {
    const art = SHEETS[key];
    let raster = sheets.get(art.file);
    if (!raster) {
      raster = await loadArt(art.file);
      sheets.set(art.file, raster);
    }
    return { art, raster };
  };
  const grid = async (key: keyof typeof SHEETS, index: number) => {
    const s = await sheet(key);
    return {
      raster: gridFrame(s.raster, s.art, index),
      from: `${s.art.file}#${index}`,
    };
  };

  // The enemies, each at every size a spawn draws it.
  const half: Record<string, HalfSize> = {};
  const bulletsDone = new Set<string>();
  for (const { kind, scale } of spriteVariants()) {
    if (kind === "redDevil") continue; // its frames are the boss's, below
    const cls = ENEMY_CLASSES[kind];
    if (kind === "flirtyGirl") {
      const raw = await atlasFrame(
        FLIRTY_GIRL_ATLAS.png,
        FLIRTY_GIRL_ATLAS.json,
        FLIRTY_GIRL_ATLAS.idle,
      );
      add(
        F.enemy(kind, scale, 0),
        toFieldArt(raw, scale, true),
        `${FLIRTY_GIRL_ATLAS.json}#${FLIRTY_GIRL_ATLAS.idle}`,
      );
    } else {
      const flap = kind === "bowser"
        ? ANIMS.bowserFlap.frames
        : kind === "coolInvader"
        ? ANIMS.coolInvaderFlap.frames
        : ANIMS.rainbowInvaderFlap.frames;
      for (const [i, fi] of flap.entries()) {
        const g = await grid(kind, fi);
        add(F.enemy(kind, scale, i), toFieldArt(g.raster, scale, true), g.from);
      }
    }
    // Its gun's bullet, at the shooter's scale times the weapon's factor.
    const bulletScale = scale * cls.bulletScale;
    const bulletKey = `${cls.bullet}@${bulletScale}`;
    if (bulletsDone.has(bulletKey)) continue;
    bulletsDone.add(bulletKey);
    if (cls.bullet === "fireball") {
      for (const fi of ANIMS.fireballRotate.frames) {
        const g = await grid("fireball", fi);
        add(
          F.bullet("Fireball", bulletScale, fi),
          toFieldArt(g.raster, bulletScale, false),
          g.from,
        );
      }
    } else if (cls.bullet === "lips") {
      for (const fi of new Set(ANIMS.lipsLick.frames)) {
        const g = await grid("lips", fi);
        add(
          F.bullet("Lips", bulletScale, fi),
          toFieldArt(g.raster, bulletScale, true),
          g.from,
        );
      }
    } else if (cls.bullet === "invaderBullet") {
      for (const fi of ANIMS.invaderBulletGyrate.frames) {
        const g = await grid("invaderBullet", fi);
        add(
          F.bullet("InvaderShot", bulletScale, fi),
          toFieldArt(g.raster, bulletScale, true),
          g.from,
        );
      }
    } else if (cls.bullet === "rainbowBullet") {
      for (const fi of ANIMS.invaderBulletGyrate.frames) {
        const g = await grid("invaderBullet", fi);
        RAINBOW_BULLET_TINTS.forEach((tint, t) =>
          add(
            F.rainbowShot(bulletScale, t, fi),
            tinted(toFieldArt(g.raster, bulletScale, true), tint),
            g.from,
          )
        );
      }
    }
  }

  // The Invaders' death bursts, one per size a bursting class is drawn at,
  // and the blank frame every burst ends on.
  const sprite = (name: string) => {
    const f = frames.find((x) => x.name === name);
    if (!f) throw new Error(`no frame ${name}`);
    return f.raster;
  };
  let burstSeed = 0x1e1;
  for (const { kind, scale } of spriteVariants()) {
    const burst = ENEMY_CLASSES[kind].burst;
    if (!burst) continue;
    const def = BURST.sheets[burst];
    const s = await sheet(def.sheet);
    const height = sprite(F.enemy(kind, scale, 0)).height;
    const baked = burstFrames(s.raster, s.art, def.frames, BURST, {
      spriteScale: scale,
      // the emitter sits at the sprite's anchor: its bottom centre
      anchorDrop: height * (ENEMY_CLASSES[kind].anchorY - 0.5),
      frames: BURST_FRAMES,
      periodMs: BURST_ANIM_PERIOD * 1000 / FPS,
      size: burstSize(height),
      zoom: BURST_ZOOM,
      seed: burstSeed++,
    });
    baked.forEach((r, i) =>
      add(F.burst(burst, scale, i), r, `${s.art.file}#${def.frames.join(",")}`)
    );
  }
  add(F.blank, blankArt(), "blank");

  // The RedDevil, DevilFire at both sizes, DevilBlast, the trio and the poof.
  for (const fi of RED_DEVIL_FRAMES) {
    const g = await grid("redDevil", fi);
    add(F.redDevil(fi), toFieldArt(g.raster, 1, true), g.from);
  }
  for (const fi of ANIMS.devilFireBurning.frames) {
    const g = await grid("devilFire", fi);
    add(F.devilFire(fi), toFieldArt(g.raster, 1, false), g.from);
    add(
      F.devilFireHalf(fi),
      toFieldArt(g.raster, LITTLE_DEVIL.bulletScale, false),
      g.from,
    );
  }
  for (const fi of ANIMS.devilBlastBurning.frames) {
    const g = await grid("devilBlast", fi);
    add(F.devilBlast(fi), toFieldArt(g.raster, 1, false), g.from);
  }
  // The LittleDevil trio: three side by side, the middle one a little
  // lower, each a beat further through the flap so they never flap in step
  // (95-demo's arrangement).
  const flap = ANIMS.littleDevilFlap.frames;
  const devilArt: Raster[] = [];
  for (const fi of flap) {
    devilArt.push(toFieldArt((await grid("littleDevil", fi)).raster, 1, true));
  }
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
      `${SHEETS.littleDevil.file}#${flap.join(",")}`,
    );
  }
  for (const fi of ANIMS.poof.frames) {
    const g = await grid("poof", fi);
    add(F.poof(fi), toFieldArt(g.raster, POOF_SCALE.redDevil, true), g.from);
  }

  // Peach's ship, turned nose-up as the source turns it (angle 270), and
  // the purple bubble as drawn: the source fires it at Phaser's angle 0,
  // pointing right, which is the way the runtime wants a shot drawn.
  for (const fi of ANIMS.peachBoosters.frames) {
    const g = await grid("peachShip", fi);
    add(F.peach(fi), rotateCcw(toFieldArt(g.raster, 1, true)), g.from);
  }
  for (const fi of ANIMS.purpleBubble.frames) {
    const g = await grid("purpleBubble", fi);
    add(F.bubble(fi), toFieldArt(g.raster, 1, true), g.from);
  }

  // rando's cut-in as it is: 256x142 on the 256-wide field, cut straight
  // off the sheet.
  const cutin = await decodePng(await Deno.readFile(CUTIN_SHEET));
  for (let i = 0; i < CUTIN_COUNT; i++) {
    add(F.cutin(i), gridFrame(cutin, CUTIN, i), `${CUTIN.file}#${i}`);
  }

  const size = (name: string): HalfSize => {
    const f = frames.find((x) => x.name === name);
    if (!f) throw new Error(`no frame ${name}`);
    return { w: f.raster.width / 2, h: f.raster.height / 2 };
  };
  for (const { kind, scale } of spriteVariants()) {
    half[variantKey(kind, scale)] = size(enemyFrames(kind, scale)[0]);
  }

  return {
    frames,
    half,
    title: {
      logo: await logoArt(),
      subTitle: await subTitleArt(),
      startText: await startTextArt(),
      backdrop: titleBackdropArt(),
    },
    stageBackdrop: stageBackdropArt(),
  };
}

// --- the stages ---------------------------------------------------------------

export interface CompiledEnemy {
  letters: string;
  kind: EnemyKind;
  def: SpawnDef;
  scale: number;
  /** Wave frame it spawns on (after the stage's shift). */
  spawnFrame: number;
  column: number;
  rows: EntryRow[];
  /** Frames from spawn until the runtime culls it, if never shot. */
  lifeFrames: number;
  maxVisibleError: number;
  shots: number;
  bounces: number;
  aimed: boolean;
}

/** A death burst's record: one per size a stage draws a bursting class at. */
export interface BurstSlot {
  letters: string;
  kind: BurstKind;
  scale: number;
}

export interface StageBuild {
  stage: number;
  enemies: CompiledEnemy[];
  bursts: BurstSlot[];
  enemylist: string[][];
  waveRows: number[];
  /** Wave frame the stage's last row is due: its end. */
  endFrame: number;
  /** Whether a boss follows the last row. */
  boss: boolean;
}

/** The burst record an enemy dies into, if its class has one. */
export function burstFor(
  st: Pick<StageBuild, "bursts">,
  e: Pick<CompiledEnemy, "kind" | "scale">,
): BurstSlot | null {
  const burst = ENEMY_CLASSES[e.kind].burst;
  if (!burst) return null;
  return st.bursts.find((b) => b.kind === burst && b.scale === e.scale) ??
    null;
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

/**
 * Compile one replayed flight into an enemy record's script. The flight is
 * picked up at its first frame at or below ENTRY_Y; the enemy spawns on the
 * grid column nearest that point and takes a pre-roll onto it at
 * HIDDEN_SPEED — straight up, then across — so it is above the screen
 * within a frame of spawning. A sprite taller than the spawn point is high
 * shows its bottom edge there for that one frame.
 */
export function compileFlight(
  flight: FlightRecord,
  stage: number,
  half: HalfSize,
): Omit<CompiledEnemy, "letters"> {
  const isHidden = (p: Point) => hiddenAt(p, half);
  const i0 = flight.track.findIndex((t) => t.pos.y >= ENTRY_Y);
  if (i0 < 0) throw new Error(`flight ${flight.id}: never reaches the field`);
  const track = flight.track.slice(i0);
  const p0 = track[0].pos;

  // Spawn column: the grid x nearest where the flight is picked up.
  const column = Math.max(
    0,
    Math.min(
      GRID_COLS - 1,
      Math.round((Math.min(256, Math.max(16, p0.x)) - 16) / 16),
    ),
  );
  const spawn = { x: 16 + 16 * column, y: SPAWN_Y };
  const mirror = spawn.x > FIELD_W / 2;

  const pre = walk([spawn, { x: spawn.x, y: p0.y }, p0], HIDDEN_SPEED);
  const spawnFrame = track[0].frame - pre.length;

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
  let shots = 0;
  for (const s of flight.shots) {
    const k0 = s.frame - spawnFrame - 1;
    if (k0 < 0 || k0 >= K) continue;
    shots++;
    for (let k = k0; k < Math.min(K, k0 + gate); k++) fire[k] = true;
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
    def: flight.def,
    scale: flight.scale,
    spawnFrame,
    column,
    rows,
    lifeFrames: life,
    maxVisibleError: worst,
    shots,
    bounces: flight.bounces,
    aimed: ENEMY_CLASSES[flight.kind].aimed,
  };
}

/**
 * The spawns of a source level that fly as zako, and the one that is the
 * stage's boss: level 1's second RedDevil. (The level's first stays a zako.)
 */
export function stagePlan(
  stage: number,
): { zako: { index: number; def: SpawnDef }[]; boss: SpawnDef | null } {
  const level = LEVELS[stage];
  const devils = level.enemies
    .map((def, index) => ({ def, index }))
    .filter((x) => x.def.key === "redDevil");
  const boss = devils.length >= 2 ? devils[1] : null;
  return {
    zako: level.enemies
      .map((def, index) => ({ index, def }))
      .filter((x) => x.index !== boss?.index),
    boss: boss?.def ?? null,
  };
}

/** One source level as a shmupX stage. */
export function buildStage(stage: number, half: LevelArt["half"]): StageBuild {
  const level = LEVELS[stage];
  const plan = stagePlan(stage);
  const levelFrames = Math.round(level.duration * FPS);
  const compiled = plan.zako.map(({ index, def }) =>
    compileFlight(
      replayEnemy(`${stage}:${index}`, def, {
        half: half[variantKey(def.key, spriteScale(def))],
        levelFrames,
      }),
      stage,
      half[variantKey(def.key, spriteScale(def))],
    )
  );
  // The stage ends when the source sends the boss, or when its level timer
  // runs out — never before the first spawn can be placed.
  const sourceEnd = plan.boss ? Math.round(plan.boss.time * FPS) : levelFrames;
  const shift = Math.max(
    0,
    FIRST_SPAWN - Math.min(...compiled.map((c) => c.spawnFrame)),
  );
  const enemies: CompiledEnemy[] = compiled.map((c, n) => ({
    ...c,
    letters: enemyLetters(stage, n),
    spawnFrame: c.spawnFrame + shift,
  }));
  const endFrame = Math.max(
    sourceEnd + shift,
    Math.max(...enemies.map((e) => e.spawnFrame)) + 1,
  );
  // The death bursts the stage's enemies die into, lettered after them.
  const bursts: BurstSlot[] = [];
  for (const e of enemies) {
    const burst = ENEMY_CLASSES[e.kind].burst;
    if (!burst || burstFor({ bursts }, e)) continue;
    bursts.push({
      letters: enemyLetters(stage, enemies.length + bursts.length),
      kind: burst,
      scale: e.scale,
    });
  }

  // One grid row per spawn frame (two if two enemies share a column), in
  // spawn order, between an empty first row (frame 0, the row the rest are
  // counted from) and an empty last row when the stage ends.
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
  spawnRows.push({ frame: endFrame, cells: new Array(GRID_COLS).fill("00") });

  // The runtime plays enemylist bottom-up.
  const ordered = spawnRows.slice().reverse();
  return {
    stage,
    enemies,
    bursts,
    enemylist: ordered.map((r) => r.cells),
    waveRows: ordered.map((r) => ROW_BASE + r.frame),
    endFrame,
    boss: !!plan.boss,
  };
}

// --- the records --------------------------------------------------------------

/** The bullet record an enemy variant's gun fires. */
export function bulletRecord(kind: EnemyKind, scale: number): Json {
  const cls = ENEMY_CLASSES[kind];
  const bulletScale = scale * cls.bulletScale;
  const base = {
    damage: 1,
    hp: 1,
    score: 10,
    spgage: 1,
    speed: tickSpeed(BULLET_SPEED),
  };
  switch (cls.bullet) {
    case "fireball":
      return {
        ...base,
        texture: ANIMS.fireballRotate.frames.map((fi) =>
          F.bullet("Fireball", bulletScale, fi)
        ),
        frameRate: ANIMS.fireballRotate.fps,
      };
    case "lips":
      return {
        ...base,
        texture: ANIMS.lipsLick.frames.map((fi) =>
          F.bullet("Lips", bulletScale, fi)
        ),
        frameRate: ANIMS.lipsLick.fps,
      };
    case "invaderBullet":
      return {
        ...base,
        texture: ANIMS.invaderBulletGyrate.frames.map((fi) =>
          F.bullet("InvaderShot", bulletScale, fi)
        ),
        frameRate: ANIMS.invaderBulletGyrate.fps,
      };
    case "rainbowBullet":
      return {
        ...base,
        texture: RAINBOW_SHOT_CYCLE.map(({ tint, flicker }) =>
          F.rainbowShot(bulletScale, tint, flicker)
        ),
        frameRate: RAINBOW_SHOT_FPS,
      };
    default:
      // The zako RedDevil: DevilFire, drawn flying down-right (the source
      // turns it by heading - 45), aimed at the player.
      return {
        ...base,
        texture: ANIMS.devilFireBurning.frames.map((fi) => F.devilFire(fi)),
        frameRate: ANIMS.devilFireBurning.fps,
        facing: 45,
      };
  }
}

/** The record for one enemy: its art, its stats and its script. */
export function enemyRecord(e: CompiledEnemy, burst: BurstSlot | null): Json {
  const cls = ENEMY_CLASSES[e.kind];
  return {
    name: e.kind,
    texture: enemyFrames(e.kind, e.scale),
    // The table's hp, times the bubbles one of the source's hit gates lets
    // through (hitGateHits) for a class that has the gate.
    hp: e.def.health * (cls.hitGate ? hitGateHits() : 1),
    score: e.def.health * SCORE_PER_HP,
    spgage: 1,
    interval: -1,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    bulletData: bulletRecord(e.kind, e.scale),
    dezaemon: {
      behavior: {
        animPeriod: animPeriod(e.kind),
        ground: false,
        movePattern: 0,
        move: { mode: 0, flag: false },
        fire: {
          enabled: true,
          geometry: 1,
          aimed: e.aimed,
          mode: 0,
          window: FIRE_WINDOW,
        },
        rotation: { enabled: false },
        scale: { enabled: false },
        zoom: { enabled: false },
        direction: { enabled: false },
        // An Invader vanishes into its particle burst, as the source's
        // does: no blast of the runtime's, and the burst record spawned in
        // its place (the death word's mode 2, the successor keyed 0x80 as
        // the engine keys one).
        death: burst
          ? { mode: 2, param: 0, key: 0x80, silent: true, small: false }
          : { mode: 0, param: 0, silent: false, small: false },
      },
      ...(burst ? { deathChild: `enemy${burst.letters}` } : {}),
      entry: { rows: e.rows },
    },
  };
}

/**
 * The record of a death burst: the baked frames once at BURST_ANIM_PERIOD,
 * then blanks; indestructible and, at BURST_ZOOM, out of every contact
 * pass; held for BURST_HOLD frames where it was spawned, then straight up
 * at the script's top speed, out of the field in four frames at most.
 */
export function burstRecord(kind: BurstKind, scale: number): Json {
  const frames = Array.from(
    { length: BURST_FRAMES },
    (_, i) => F.burst(kind, scale, i),
  );
  const flags = ENTRY_ADVANCE | ENTRY_NO_FIRE;
  const rows: EntryRow[] = [
    [BURST_HOLD - 1, 0, 0, 0, flags],
    [ROW_FOREVER, 0x4000, 0, 0x7fff, flags],
  ];
  return {
    name: "burst",
    texture: [...frames, ...new Array<string>(BURST_BLANKS).fill(F.blank)],
    hp: "infinity",
    score: 0,
    spgage: 0,
    interval: -1,
    shadowReverse: false,
    shadowOffsetY: SHADOW_PARK,
    dezaemon: {
      behavior: {
        animPeriod: BURST_ANIM_PERIOD,
        ground: false,
        movePattern: 0,
        move: { mode: 0, flag: false },
        fire: {
          enabled: false,
          geometry: 0,
          aimed: false,
          mode: 0,
          window: FIRE_WINDOW,
        },
        rotation: { enabled: false },
        scale: { enabled: false },
        zoom: {
          enabled: true,
          from: BURST_ZOOM,
          to: BURST_ZOOM,
          step: 0,
          repeat: 0,
          trigger: 0,
        },
        direction: { enabled: false },
        death: { mode: 0, param: 0, silent: true, small: false },
      },
      entry: { rows },
    },
  };
}

const repeatEach = (names: string[], n: number) =>
  names.flatMap((name) => new Array(n).fill(name));

/**
 * The RedDevil and its LittleDevils, as 95-demo's boss (redDevilRecord
 * there): Fang's routine, DevilBlast as the beam, DevilFire as the volley
 * and the ring, and the trio as its stage2 on Barlog's.
 */
export function redDevilRecord(def: SpawnDef): Json {
  const bossHp = def.health;
  const devilHp = LITTLE_DEVIL.health;
  const totalHp = bossHp + LITTLE_DEVIL.count * devilHp;
  // The runtime turns a boss stance frame every 150 ms; the flap is 2 fps.
  const flap = repeatEach(ANIMS.redDevilFlap.frames.map(F.redDevil), 3);
  const fire = ANIMS.devilFireBurning.frames.map(F.devilFire);
  const blast = ANIMS.devilBlastBurning.frames.map(F.devilBlast);
  return {
    name: "redDevil",
    attackPattern: "boss4",
    hp: totalHp,
    score: totalHp * SCORE_PER_HP,
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
      frameRate: ANIMS.devilBlastBurning.fps,
      speed: tickSpeed(DEVIL_BLAST_SPEED),
      damage: 1,
      hp: 10,
      score: 100,
      spgage: 3,
    },
    // The aimed volley: DevilFire's art points down-right, so it turns to
    // its heading exactly as the source's bulletAngleOffset 315 turns it.
    bulletDataB: {
      texture: fire,
      frameRate: ANIMS.devilFireBurning.fps,
      facing: 45,
      speed: tickSpeed(BULLET_SPEED),
      damage: 1,
      hp: 3,
      score: 50,
      spgage: 1,
    },
    bulletDataC: {
      texture: fire,
      frameRate: ANIMS.devilFireBurning.fps,
      speed: tickSpeed(BULLET_SPEED),
      damage: 1,
      hp: 3,
      score: 50,
      spgage: 1,
    },
    stage2: {
      hpBelow: Math.round((LITTLE_DEVIL.count * devilHp / totalHp) * 1e4) /
        1e4,
      attackPattern: "boss1",
      anim: {
        morph: [
          ...ANIMS.redDevilRelease.frames.slice(0, 5).map(F.redDevil),
          ...ANIMS.poof.frames.map(F.poof),
        ],
        idle: ANIMS.littleDevilFlap.frames.map((_, i) => F.buttDevils(i)),
      },
      // A LittleDevil's DevilFire: the same flame at half size.
      bulletData: {
        texture: ANIMS.devilFireBurning.frames.map(F.devilFireHalf),
        frameRate: ANIMS.devilFireBurning.fps,
        facing: 45,
        speed: tickSpeed(BULLET_SPEED),
        damage: 1,
        hp: 3,
        score: 50,
        spgage: 1,
      },
    },
  };
}

export function playerRecord(): Json {
  const bubbles = ANIMS.purpleBubble.frames.map(F.bubble);
  const interval = PLAYER_SHOT_TICKS;
  return {
    name: "eiPeach",
    texture: ANIMS.peachBoosters.frames.map(F.peach),
    // Nothing in the source hurts Peach; here she has the stock game's
    // three lives, and the SP bomb, worth a LittleDevil.
    maxHp: 3,
    spDamage: LITTLE_DEVIL.health,
    speed: 150,
    defaultShootName: "normal",
    defaultShootSpeed: "speed_normal",
    shootNormal: {
      name: "normal",
      texture: bubbles,
      frameRate: ANIMS.purpleBubble.fps,
      damage: 1,
      hp: 1,
      interval,
    },
    shootBig: {
      name: "big",
      texture: bubbles,
      frameRate: ANIMS.purpleBubble.fps,
      damage: 2,
      hp: 100,
      interval: 39,
    },
    shoot3way: {
      name: "3way",
      texture: bubbles,
      frameRate: ANIMS.purpleBubble.fps,
      damage: 1,
      hp: 1,
      interval: 31,
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
  for (const key of ["enemyData", "bossData", "playerData"]) {
    walk(record[key]);
  }
  return out;
}

/** Build the whole cloud game. */
export async function buildLevel(): Promise<Build> {
  const art = await buildArt();
  const stages = LEVELS.map((_, s) => buildStage(s, art.half));

  const enemyData: Json = {};
  for (const st of stages) {
    for (const e of st.enemies) {
      enemyData[`enemy${e.letters}`] = enemyRecord(e, burstFor(st, e));
    }
    for (const b of st.bursts) {
      enemyData[`enemy${b.letters}`] = burstRecord(b.kind, b.scale);
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
  const bossData: Json = {};
  for (const st of stages) {
    const plan = stagePlan(st.stage);
    if (plan.boss) bossData[`boss${st.stage}`] = redDevilRecord(plan.boss);
  }

  // As wide as the stock atlas the sheet is stacked under (STOCK_ATLAS).
  const stockAtlas = JSON.parse(await Deno.readTextFile(STOCK_ATLAS));
  const packed = packFrames(art.frames, stockAtlas.meta.size.w);
  const playerData = playerRecord();
  const backdrop = await pngUrl(art.stageBackdrop);
  const stageBackgrounds: Json = {};
  for (const st of stages) {
    stageBackgrounds[`stage${st.stage}`] = { loop: backdrop, end: backdrop };
  }
  const record: Json = {
    name: LEVEL,
    title: TITLE,
    gameId: gameIdForLevel({ name: LEVEL }),
    meta: { version: "1.0", source: "evil-invaders", origin: SOURCE.repo },
    noStory: true,
    ownCutin: true,
    ownItems: false,
    godMode: false,
    width: GRID_COLS,
    stageKey: "stage0",
    enemylist: stageRecords.stage0.enemylist,
    waveRows: stageRecords.stage0.waveRows,
    waveInterval: WAVE_INTERVAL,
    stages: stageRecords,
    enemyData,
    bossData,
    playerData,
    atlasImageDataURL: await sheetDataUrl(packed.sheet),
    atlasFrames: encodeFrameMap(packed.json.frames),
    stageBackgrounds,
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
  const stacked = stockAtlas.meta.size.h + packed.sheet.height;
  if (stacked > TEXTURE_LIMIT) {
    throw new Error(
      `the stacked atlas is ${stacked} rows tall; phones take ${TEXTURE_LIMIT}`,
    );
  }
  const bad = badRtdbKey(record);
  if (bad) throw new Error(`RTDB refuses the key at ${bad}`);
  // The runtime lays playerData over the stock ship's (mergeRecipe), so the
  // schema sees the barrier this record leaves to the stock game.
  const stock = JSON.parse(await Deno.readTextFile(STOCK_RECIPE));
  const recipe: Json = {
    ...stageRecords,
    enemyData,
    bossData,
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
      enemies: s.enemies.map((e) =>
        `${e.letters} ${e.kind} x${e.scale} hp ${
          b.record.enemyData[`enemy${e.letters}`].hp
        } @${
          Math.round(e.spawnFrame / 6) / 10
        }s rows ${e.rows.length} shots ${e.shots} bounces ${e.bounces}` +
        (burstFor(s, e) ? ` bursts into ${burstFor(s, e)!.letters}` : "")
      ),
      bursts: s.bursts.map((bu) =>
        `${bu.letters} ${bu.kind} x${bu.scale}: ${
          b.record.enemyData[`enemy${bu.letters}`].texture.length
        } frames`
      ),
      rows: s.enemylist.length,
      scriptRows: s.enemies.reduce((n, e) => n + e.rows.length, 0),
      endS: Math.round(s.endFrame / 6) / 10,
      boss: s.boss
        ? `${b.record.bossData[`boss${s.stage}`].name} (${
          b.record.bossData[`boss${s.stage}`].attackPattern
        }) hp ${b.record.bossData[`boss${s.stage}`].hp}, stage2 (${
          b.record.bossData[`boss${s.stage}`].stage2.attackPattern
        })`
        : "none: the stage ends on its timer",
      worstVisibleErrorPx: Math.round(
        Math.max(...s.enemies.map((e) => e.maxVisibleError)) * 100,
      ) / 100,
    })),
    frames: b.frameCount,
    sheet: b.sheet,
    bytes: {
      record: bytes(b.record),
      enemyData: bytes(b.record.enemyData),
      atlas: b.record.atlasImageDataURL.length,
      backdrop: b.record.stageBackgrounds.stage0.loop.length,
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
  if (value.meta?.source !== "evil-invaders" && !force) {
    throw new Error(
      `${dbPath(path)} is not the evil-invaders conversion; --force deletes it`,
    );
  }
  await put(path, null, { ifMatch: etag });
  return `${dbPath(path)} deleted`;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["apply", "revert", "force", "serve"],
    string: ["out", "port"],
    default: { port: "8824" },
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
