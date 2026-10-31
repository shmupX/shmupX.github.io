/**
 * One Evil Invaders enemy, played out frame by frame as the source plays it,
 * with nobody shooting back — the flight it would take.
 *
 * This is GenericEnemy (Bowser, FlirtyGirl, CoolInvader, RainbowInvader) and
 * RedDevil run at Phaser CE's fixed 60 Hz: the arcade body's straight-line
 * velocity, the wall bounce that puts a sprite two pixels inside the edge
 * and flips it, the kill once the sprite's top is below the world, and the
 * two-second gun. The converter (build-level.ts) compiles each flight into
 * an appearance script, so in the shmupX runtime the enemy moves the way the
 * source moves it.
 *
 * What the source does that the replay only notes:
 *
 * - The first shot of every enemy is fired as it is constructed, at the
 *   spawn point 100 px above the world; Phaser's Weapon kills a bullet that
 *   does not touch the world bounds on its first update, so that shot never
 *   exists. The replay records a shot only where its bullet would live.
 * - An enemy's gun is a Weapon shared by its group with a pool of sixteen
 *   bullets; the pool never runs dry in either level, so every scheduled
 *   shot that reaches the world is fired.
 * - The RedDevil's two weapons both aim at the player: DevilFire every four
 *   seconds and DevilBlast two seconds into each cycle. A zako has one gun,
 *   so the replay records a shot at each of those moments and the converter
 *   fires DevilFire at all of them.
 */

import {
  BOUNCE_INSET,
  BULLET_SPEED,
  DEVIL_BLAST_SPEED,
  ENEMY_CLASSES,
  ENEMY_FIRE_MS,
  type EnemyKind,
  FPS,
  GAME_HEIGHT,
  GAME_WIDTH,
  RED_DEVIL,
  SHEETS,
  SPAWN_Y,
  type SpawnDef,
} from "./source.ts";

export const FRAME_MS = 1000 / FPS;
/** The two-second gun, in frames. */
export const FIRE_FRAMES = Math.round(ENEMY_FIRE_MS / FRAME_MS);

// --- the playfield shmupX draws on ----------------------------------------

/** shmupX's playfield (game.bundle.js GAME_DIMENSIONS). */
export const FIELD_W = 256;
export const FIELD_H = 480;
export const KX = FIELD_W / GAME_WIDTH;
export const KY = FIELD_H / GAME_HEIGHT;

export type Point = { x: number; y: number };

/** A source position on the shmupX field. */
export function toField(p: Point): Point {
  return { x: p.x * KX, y: p.y * KY };
}

/** Half the drawn size of a sprite on the shmupX field. */
export interface HalfSize {
  w: number;
  h: number;
}

/** Whether a sprite of this half-size at `p` draws nothing on the screen. */
export function hiddenAt(p: Point, half: HalfSize): boolean {
  return p.x + half.w < -1 || p.x - half.w > FIELD_W + 1 ||
    p.y + half.h < -1 || p.y - half.h > FIELD_H + 1;
}

// --- the source's sprites -----------------------------------------------------

/** A sprite's frame size in source pixels, as its sheet is cut. */
export interface SpriteDims {
  w: number;
  h: number;
}

/** The frame each enemy class is drawn from, in source pixels. */
export const SPRITE_DIMS: Record<EnemyKind, SpriteDims> = {
  bowser: { w: SHEETS.bowser.frameW, h: SHEETS.bowser.frameH },
  // flirty-girl.json's frame "1"
  flirtyGirl: { w: 22, h: 24 },
  coolInvader: { w: SHEETS.coolInvader.frameW, h: SHEETS.coolInvader.frameH },
  rainbowInvader: {
    w: SHEETS.rainbowInvader.frameW,
    h: SHEETS.rainbowInvader.frameH,
  },
  redDevil: { w: SHEETS.redDevil.frameW, h: SHEETS.redDevil.frameH },
};

/** The scale a spawn draws its sprite at: the table's figure over the class's divisor. */
export function spriteScale(def: SpawnDef): number {
  return def.key === "redDevil"
    ? 1
    : def.scale / ENEMY_CLASSES[def.key].scaleDivisor;
}

/** The bullet frame each gun fires, in source pixels. */
const BULLET_DIMS = {
  fireball: { w: SHEETS.fireball.frameW, h: SHEETS.fireball.frameH },
  lips: { w: SHEETS.lips.frameW, h: SHEETS.lips.frameH },
  invaderBullet: {
    w: SHEETS.invaderBullet.frameW,
    h: SHEETS.invaderBullet.frameH,
  },
  rainbowBullet: {
    w: SHEETS.invaderBullet.frameW,
    h: SHEETS.invaderBullet.frameH,
  },
  devilFire: { w: SHEETS.devilFire.frameW, h: SHEETS.devilFire.frameH },
  devilBlast: { w: SHEETS.devilBlast.frameW, h: SHEETS.devilBlast.frameH },
} as const;

// --- the flight ---------------------------------------------------------------

/** One frame of an enemy's flight. */
export interface TrackPoint {
  /** Source frames since the level began. */
  frame: number;
  /** The sprite's centre on the shmupX field. */
  pos: Point;
  /** Whether it draws nothing on the screen there. */
  hidden: boolean;
  /** The sprite's anchor point in source pixels, for the tests. */
  src: Point;
}

/** A shot the source fires: the frame, and whether it is aimed at the player. */
export interface Shot {
  frame: number;
  aimed: boolean;
  /** Bullet speed, source px/s. */
  speed: number;
}

export interface FlightRecord {
  id: string;
  kind: EnemyKind;
  def: SpawnDef;
  /** The sprite's scale, as drawn. */
  scale: number;
  /** Source frame it spawns on. */
  launchFrame: number;
  /** Frame by frame from launchFrame, on the shmupX field. */
  track: TrackPoint[];
  shots: Shot[];
  /** Wall bounces along the way. */
  bounces: number;
  /** Whether the source killed it below the world before the level ended. */
  leftTheWorld: boolean;
}

export interface ReplayOptions {
  /** Half the sprite's drawn size on the field, for the hidden flag. */
  half: HalfSize;
  /** The level ends on this source frame; nothing outlives it. */
  levelFrames: number;
  /**
   * The runtime culls an enemy this far below the field's bottom; the track
   * stops there, since the sprite is gone whatever the source would do next.
   */
  cullBelow?: number;
}

/** Phaser.Easing.Sinusoidal.InOut. */
export function sineInOut(k: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * k));
}

/**
 * Whether a bullet of `dims` at `scale` fired from the anchor point `at`
 * touches the world: Phaser.Weapon kills one that does not on its first
 * update (bulletKillType KILL_WORLD_BOUNDS), so it is never seen.
 */
export function bulletLives(
  at: Point,
  dims: SpriteDims,
  scale: number,
): boolean {
  const hw = dims.w * scale / 2, hh = dims.h * scale / 2;
  return at.x + hw > 0 && at.x - hw < GAME_WIDTH && at.y + hh > 0 &&
    at.y - hh < GAME_HEIGHT;
}

/** The spawn `def` of a level, flown as the source flies it. */
export function replayEnemy(
  id: string,
  def: SpawnDef,
  opts: ReplayOptions,
): FlightRecord {
  const cls = ENEMY_CLASSES[def.key];
  const dims = SPRITE_DIMS[def.key];
  const scale = spriteScale(def);
  const cullBelow = opts.cullBelow ?? 20;
  const launchFrame = Math.round(def.time * FPS);
  const frames = Math.max(0, opts.levelFrames - launchFrame);

  // The anchor point: the sprite's bottom centre for a bottom-anchored
  // class, its centre otherwise. The field tracks the centre.
  const centreOf = (p: Point): Point =>
    toField({ x: p.x, y: p.y - dims.h * scale * (cls.anchorY - 0.5) });
  const point = (frame: number, src: Point): TrackPoint => {
    const pos = centreOf(src);
    return { frame, pos, hidden: hiddenAt(pos, opts.half), src };
  };

  const track: TrackPoint[] = [];
  const shots: Shot[] = [];
  let bounces = 0;
  let leftTheWorld = false;

  if (def.key === "redDevil") {
    // RedDevil.reset: a tween to restY over descendMs, then it holds.
    const x0 = def.x * GAME_WIDTH;
    for (let f = 0; f <= frames; f++) {
      const t = Math.min(1, f * FRAME_MS / RED_DEVIL.descendMs);
      const y = SPAWN_Y + (RED_DEVIL.restY - SPAWN_Y) * sineInOut(t);
      track.push(point(launchFrame + f, { x: x0, y }));
    }
    // DevilFire on construction and every fireMs; DevilBlast blastDelayMs
    // into each cycle. Both aimed; each from its own offset (the sign
    // faces the centre, as the sprite does), and only where it would live.
    const sign = x0 > GAME_WIDTH / 2 ? -1 : 1;
    for (let ms = 0; ms <= frames * FRAME_MS; ms += RED_DEVIL.fireMs) {
      const fireF = Math.round(ms / FRAME_MS);
      const blastF = Math.round((ms + RED_DEVIL.blastDelayMs) / FRAME_MS);
      const at = (f: number, off: { x: number; y: number }) => ({
        x: track[f].src.x + sign * off.x,
        y: track[f].src.y + off.y,
      });
      if (
        fireF <= frames &&
        bulletLives(at(fireF, RED_DEVIL.fireOffset), BULLET_DIMS.devilFire, 1)
      ) {
        shots.push({
          frame: launchFrame + fireF,
          aimed: true,
          speed: BULLET_SPEED,
        });
      }
      if (
        blastF <= frames &&
        bulletLives(
          at(blastF, RED_DEVIL.blastOffset),
          BULLET_DIMS.devilBlast,
          1,
        )
      ) {
        shots.push({
          frame: launchFrame + blastF,
          aimed: true,
          speed: DEVIL_BLAST_SPEED,
        });
      }
    }
    shots.sort((a, b) => a.frame - b.frame);
  } else {
    // GenericEnemy: the arcade body integrates the velocity, then update()
    // bounces off the side walls and kills the sprite below the world.
    const hw = dims.w * scale / 2;
    const top = (y: number) => y - dims.h * scale * cls.anchorY;
    let x = def.x * GAME_WIDTH, y = SPAWN_Y;
    let vx = def.speedX;
    const vy = def.speedY;
    const bullet = BULLET_DIMS[cls.bullet];
    const bulletScale = scale * cls.bulletScale;
    track.push(point(launchFrame, { x, y }));
    for (let f = 0; f <= frames; f++) {
      // scheduleShooting: on construction (f 0), then every ENEMY_FIRE_MS.
      if (
        f % FIRE_FRAMES === 0 &&
        bulletLives({ x, y }, bullet, bulletScale)
      ) {
        shots.push({
          frame: launchFrame + f,
          aimed: cls.aimed,
          speed: BULLET_SPEED,
        });
      }
      if (f === frames) break;
      x += vx / FPS;
      y += vy / FPS;
      if (x < hw) {
        x = hw + BOUNCE_INSET;
        vx = -vx;
        bounces++;
      } else if (x > GAME_WIDTH - hw) {
        x = GAME_WIDTH - hw - BOUNCE_INSET;
        vx = -vx;
        bounces++;
      }
      if (top(y) > GAME_HEIGHT) {
        leftTheWorld = true;
        break;
      }
      const tp = point(launchFrame + f + 1, { x, y });
      track.push(tp);
      if (tp.pos.y > FIELD_H + cullBelow) break;
    }
  }

  return {
    id,
    kind: def.key,
    def,
    scale,
    launchFrame,
    track,
    shots,
    bounces,
    leftTheWorld,
  };
}
