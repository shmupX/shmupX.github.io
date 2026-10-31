/**
 * Evil Invaders, as data: the numbers the evil-invaders cloud game is
 * converted from.
 *
 * The source is easierbycode/evil-invaders at the commit in SOURCE — the
 * Phaser CE 2.8.2 shooter at easierbycode.com/evil-invaders, Peach's ship
 * against Bowser, the flirty girls, two RedDevils and the Invaders. It ships
 * as a webpack bundle (docs/game.bundle.js, the file the site runs), so
 * everything here is ported verbatim from the class named beside it rather
 * than from a src/ tree: the level tables from assets/maps/level1.json and
 * level2.json, the physics from GenericEnemy and the devils, the weapons from
 * the Phaser.Weapon subclasses, the animation table from each sprite's
 * constructor and the loader's frame sizes from LoadingState.preload. The art
 * those animations cut lives beside this file in art/, copied byte for byte
 * from the source's assets/images.
 *
 * The source plays on a 360x640 portrait field; shmupX on 256x480. Nothing in
 * this file is scaled — the converter does that, in one place.
 */

/** Where every number below comes from. */
export const SOURCE = {
  repo: "https://github.com/easierbycode/evil-invaders",
  commit: "7945ada9317a7657de0c9ebeeb5f5ca29de80aaa",
  site: "https://easierbycode.com/evil-invaders",
} as const;

// --- game.js (module 2) and the Phaser loop ---------------------------------

export const GAME_WIDTH = 360;
export const GAME_HEIGHT = 640;
/** Phaser CE's fixed physics step: desiredFps 60, one update a frame. */
export const FPS = 60;

// --- assets/maps/level1.json, level2.json ----------------------------------

export type EnemyKind =
  | "bowser"
  | "flirtyGirl"
  | "coolInvader"
  | "rainbowInvader"
  | "redDevil";

/** One line of a level's `enemies` table. */
export interface SpawnDef {
  /** Seconds into the level. */
  time: number;
  /** Fraction of the world width. */
  x: number;
  health: number;
  /** px/s. */
  speedX: number;
  speedY: number;
  key: EnemyKind;
  /** The figure the table gives; each class draws itself at its own share. */
  scale: number;
}

export interface LevelDef {
  /** Seconds; the level restarts into the next on this timer. */
  duration: number;
  enemies: SpawnDef[];
}

const e = (
  time: number,
  x: number,
  health: number,
  speedX: number,
  speedY: number,
  key: EnemyKind,
  scale: number,
): SpawnDef => ({ time, x, health, speedX, speedY, key, scale });

/** The two levels, verbatim; GameState loops them (numLevels = 2). */
export const LEVELS: LevelDef[] = [
  {
    duration: 35,
    enemies: [
      e(1, 0.9, 25, -20, 50, "bowser", 1.5),
      e(2, 0.1, 24, 20, 50, "flirtyGirl", 3),
      e(5, 0.1, 10, 50, 50, "bowser", 0.5),
      e(6, 0.1, 10, 50, 50, "bowser", 0.5),
      e(7, 0.1, 10, 50, 50, "bowser", 0.5),
      e(8, 0.4, 12, 50, 50, "flirtyGirl", 1.5),
      e(9, 0.6, 12, 50, 50, "flirtyGirl", 1.5),
      e(10, 0.8, 12, 50, 50, "flirtyGirl", 1.5),
      e(15, 0.2, 50, 20, 50, "redDevil", 1),
      e(16, 0.75, 50, 20, 50, "redDevil", 1),
    ],
  },
  {
    duration: 15,
    enemies: [
      e(1, 0.9, 10, -20, 50, "coolInvader", 1.5),
      e(2, 0.1, 8, 40, 100, "rainbowInvader", 1.5),
      e(5, 0.1, 6, 50, 50, "coolInvader", 0.5),
      e(6, 0.1, 6, 50, 50, "coolInvader", 0.5),
      e(7, 0.1, 6, 50, 50, "coolInvader", 0.5),
      e(8, 0.4, 4, 100, 100, "rainbowInvader", 0.5),
      e(9, 0.6, 4, 100, 100, "rainbowInvader", 0.5),
      e(10, 0.8, 4, 100, 100, "rainbowInvader", 0.5),
    ],
  },
];

// --- GameState.scheduleNextEnemy, GenericEnemy ------------------------------

/** createEnemy(x * world.width, -100, …): every enemy starts here. */
export const SPAWN_Y = -100;
/** GenericEnemy.update: a bounce puts the sprite this far inside the wall. */
export const BOUNCE_INSET = 2;
/**
 * GenericEnemy, Bowser and LittleDevil fire on construction and then every
 * two seconds (scheduleShooting re-adds itself on the enemyTimer).
 */
export const ENEMY_FIRE_MS = 2000;

// --- the weapons (Phaser.Weapon subclasses) --------------------------------

/** Phaser.Weapon's default bulletSpeed, px/s: Fireballs, Lips, InvaderBullets, DevilFire. */
export const BULLET_SPEED = 200;
/** DevilBlast.bulletSpeed. */
export const DEVIL_BLAST_SPEED = 600;
/** PurpleBubbles: Peach's shot. */
export const PLAYER_BULLET_SPEED = 1800;
export const PLAYER_FIRE_RATE_MS = 60;

export type BulletKind =
  | "fireball"
  | "lips"
  | "invaderBullet"
  | "rainbowBullet"
  | "devilFire"
  | "devilBlast";

/**
 * Each weapon's fire() scales its bullet by the shooter's scale: Fireballs
 * x10, Lips x1/2, InvaderBullets and RainbowInvaderBullets x15. A LittleDevil
 * halves its DevilFire; the RedDevil's weapons fire at 1.
 */
export const BULLET_SCALE = {
  fireball: 10,
  lips: 0.5,
  invaderBullet: 15,
  rainbowBullet: 15,
  littleDevilFire: 0.5,
} as const;

/** RainbowInvaderBullet.update: a random tint from this list every frame. */
export const RAINBOW_BULLET_TINTS = [
  0xcf4242,
  0xf5972a,
  0xe39d4b,
  0xecf030,
  0x289e65,
  0x3f5cf2,
  0xa24dd6,
  0xf69ef7,
];

// --- the enemy classes ------------------------------------------------------

export interface EnemyClass {
  key: EnemyKind;
  /** Phaser anchor y: 1 means the sprite's y is its bottom edge, 0.5 its centre. */
  anchorY: number;
  /** reset() sets the sprite's scale to the table's figure over this. */
  scaleDivisor: number;
  /** Which weapon the group hands its enemies. */
  bullet: BulletKind;
  /** The bullet's scale, as a multiple of the shooter's. */
  bulletScale: number;
  /** fire(this, player.x, player.y) aims at the player; fire(this) drops straight down. */
  aimed: boolean;
  /**
   * The group's damageEnemy lands a hit only while the sprite's getHit
   * animation is not playing (CoolInvaders, RainbowInvaders); the others
   * take every bullet.
   */
  hitGate: boolean;
  /** emitDeath's particle burst, where the class has one (BURST). */
  burst: BurstKind | null;
}

export const ENEMY_CLASSES: Record<EnemyKind, EnemyClass> = {
  // Bowser: anchor (0.5, 1), scale / 3, Fireballs aimed at the player.
  bowser: {
    key: "bowser",
    anchorY: 1,
    scaleDivisor: 3,
    bullet: "fireball",
    bulletScale: BULLET_SCALE.fireball,
    aimed: true,
    hitGate: false,
    burst: null,
  },
  // FlirtyGirl: GenericEnemy's own anchor (0.5), the table's scale as is,
  // Lips straight down.
  flirtyGirl: {
    key: "flirtyGirl",
    anchorY: 0.5,
    scaleDivisor: 1,
    bullet: "lips",
    bulletScale: BULLET_SCALE.lips,
    aimed: false,
    hitGate: false,
    burst: null,
  },
  coolInvader: {
    key: "coolInvader",
    anchorY: 1,
    scaleDivisor: 3,
    bullet: "invaderBullet",
    bulletScale: BULLET_SCALE.invaderBullet,
    aimed: false,
    hitGate: true,
    burst: "coolInvader",
  },
  rainbowInvader: {
    key: "rainbowInvader",
    anchorY: 1,
    scaleDivisor: 3,
    bullet: "rainbowBullet",
    bulletScale: BULLET_SCALE.rainbowBullet,
    aimed: false,
    hitGate: true,
    burst: "rainbowInvader",
  },
  // RedDevil: its own class (below), not a GenericEnemy; DevilFire and
  // DevilBlast, both aimed. reset() ignores the table's scale.
  redDevil: {
    key: "redDevil",
    anchorY: 0.5,
    scaleDivisor: 1,
    bullet: "devilFire",
    bulletScale: 1,
    aimed: true,
    hitGate: false,
    burst: null,
  },
};

// --- CoolInvader.emitDeath, RainbowInvader.emitDeath ------------------------

export type BurstKind = "coolInvader" | "rainbowInvader";

/**
 * An Invader dies into a particle burst: `game.add.emitter(x, y, 100)` at
 * the sprite's anchor (its bottom centre), blend ADD, gravity 600,
 * `setAlpha(1, 0, 500, 'Cubic.easeIn')`, `setAngle(-180, 180, 0, 2400)`
 * (any heading, 0-2400 px/s; the minParticleSpeed set after it is never
 * read once angles are set), particles a quarter to the whole of
 * `scale.x / 3`, `makeParticles` from the class's voxel sheet, and
 * `start(true, 500, null, 100)`: all hundred at once, half a second each.
 * The sprite scale here is the drawn one (the table's over 3).
 */
export const BURST = {
  count: 100,
  lifespanMs: 500,
  gravity: 600,
  minSpeed: 0,
  maxSpeed: 2400,
  /** Particle scale = sprite scale * these. */
  minScale: 0.25,
  maxScale: 1,
  /** The emitter sits `anchorY` down the sprite: its bottom centre. */
  sheets: {
    coolInvader: {
      sheet: "coolInvaderParticles",
      frames: [0, 1, 2],
    },
    // Phaser.ArrayUtils.numberArray(0, 8) names nine frames of a sheet that
    // holds eight; the ninth is never drawn.
    rainbowInvader: {
      sheet: "rainbowInvaderParticles",
      frames: [0, 1, 2, 3, 4, 5, 6, 7],
    },
  },
} as const;

// --- RedDevil ----------------------------------------------------------------

/**
 * RedDevil.reset tweens the devil from its spawn point to y 150 over two
 * seconds (Sine.easeInOut) and never moves it again; it faces the centre
 * (scale.x -1 right of it). Its constructor fires DevilFire at the player at
 * once and every four seconds after, from (±16, 13), and two seconds into
 * each of those cycles plays releaseButtDevils and fires DevilBlast at the
 * player from (±35, 55), toots, and flaps again a second later.
 */
export const RED_DEVIL = {
  descendMs: 2000,
  restY: 150,
  fireMs: 4000,
  blastDelayMs: 2000,
  fireOffset: { x: 16, y: 13 },
  blastOffset: { x: 35, y: 55 },
} as const;

/**
 * RedDevil.emitDeath: a poof blown up x9, then three LittleDevils of 12 hp
 * at (x - 43, y - 39), (x - 43, y) and (x - 43, y + 39). A LittleDevil falls
 * under gravity 50 weaving `spread` px either side of where it started on a
 * sine of its y over `frequency`, shuffles its feet for 1.25 s (footShuffle,
 * five frames at 4 fps) and then flaps and fires DevilFire at the player at
 * half size every two seconds.
 */
export const LITTLE_DEVIL = {
  health: 12,
  count: 3,
  offsets: [{ x: -43, y: -39 }, { x: -43, y: 0 }, { x: -43, y: 39 }],
  gravity: 50,
  frequency: 70,
  spread: 60,
  bulletScale: BULLET_SCALE.littleDevilFire,
} as const;

/** Death poofs: a LittleDevil's x3, the RedDevil's x9. */
export const POOF_SCALE = { littleDevil: 3, redDevil: 9 } as const;

// --- Peach (GameState.create) ----------------------------------------------

/**
 * Peach's ship: the peachShip sheet turned to angle 270 (a quarter turn
 * anticlockwise, nose up), started at the centre 100 px above the bottom,
 * dragged by the pointer, firing PurpleBubbles while the pointer is down.
 * Nothing hurts it: an enemy bullet is killed on contact and shakes the
 * screen (juicy.shake, navigator.vibrate).
 */
export const PEACH = { angle: 270, startFromBottom: 100 } as const;

// --- LoadingState.preload (sheets) and the sprites' animations -------------

export interface SheetArt {
  /** File in art/. */
  file: string;
  frameW: number;
  frameH: number;
  /** load.spritesheet's margin: the first frame starts this far in. */
  margin?: number;
}

/** Grid spritesheets, with the frame size each is loaded at. */
export const SHEETS = {
  // load.spritesheet('bowser', 'bowser-voxel.png', 272, 196, 4, 1): frames
  // 1 px in, three across the 1088 px sheet (the fourth lands off it).
  bowser: { file: "bowser-voxel.png", frameW: 272, frameH: 196, margin: 1 },
  coolInvader: { file: "cool-invader.png", frameW: 431, frameH: 275 },
  coolInvaderParticles: {
    file: "cool-invader-voxel-particles.png",
    frameW: 45,
    frameH: 52,
  },
  rainbowInvader: { file: "rainbow-invader.png", frameW: 263, frameH: 174 },
  rainbowInvaderParticles: {
    file: "rainbow-invader-particles.png",
    frameW: 43,
    frameH: 52,
  },
  redDevil: { file: "red-devil.png", frameW: 160, frameH: 166 },
  littleDevil: { file: "butt-devils.png", frameW: 43, frameH: 39 },
  devilFire: { file: "devil-fire.png", frameW: 42, frameH: 35 },
  devilBlast: { file: "devil-blast.png", frameW: 123, frameH: 96 },
  fireball: { file: "fireball.png", frameW: 8, frameH: 8 },
  lips: { file: "lips.png", frameW: 25, frameH: 21 },
  invaderBullet: { file: "invader-bullet.png", frameW: 3, frameH: 7 },
  purpleBubble: { file: "purple-bubble.png", frameW: 14, frameH: 12 },
  peachShip: { file: "peach-ship.png", frameW: 52, frameH: 32 },
  poof: { file: "poof.png", frameW: 16, frameH: 15 },
} as const satisfies Record<string, SheetArt>;

/** load.atlasJSONHash('flirtyGirl', …): a TexturePacker hash atlas. */
export const FLIRTY_GIRL_ATLAS = {
  png: "flirty-girl.png",
  json: "flirty-girl.json",
  /** The frame a FlirtyGirl is constructed with. */
  idle: "1",
} as const;

/** Animations, as frame lists and frames per second. */
export const ANIMS = {
  bowserFlap: { frames: [0, 1], fps: 2 },
  bowserGetHit: { frames: [1, 2, 0], fps: 12 },
  flirtyGirlGetHit: { frames: ["2", "3", "4", "5", "4", "5", "2"], fps: 6 },
  coolInvaderFlap: { frames: [0, 1], fps: 2 },
  coolInvaderGetHit: { frames: [2, 3, 4, 5], fps: 12 },
  rainbowInvaderFlap: { frames: [0, 1], fps: 2 },
  rainbowInvaderGetHit: { frames: [2, 3, 4, 5], fps: 12 },
  redDevilFlap: { frames: [0, 1], fps: 2 },
  redDevilFlip: { frames: [2, 3, 4, 5, 6, 7, 8, 9], fps: 24 },
  redDevilRelease: { frames: [11, 12, 13, 14, 15, 14, 15, 14, 15], fps: 24 },
  redDevilToot: { frames: [14, 15], fps: 4 },
  littleDevilFootShuffle: { frames: [0, 1, 2, 1, 2], fps: 4 },
  littleDevilFlap: { frames: [3, 4, 5, 4], fps: 12 },
  lipsLick: { frames: [0, 1, 2, 3, 2, 1, 0], fps: 12 },
  fireballRotate: { frames: [0, 1, 2, 3], fps: 6 },
  invaderBulletGyrate: { frames: [0, 1], fps: 2 },
  devilFireBurning: {
    frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    fps: 30,
  },
  devilBlastBurning: { frames: [0, 1, 2, 3, 4, 5, 6, 7], fps: 12 },
  poof: { frames: [0, 1, 2], fps: 12 },
  purpleBubble: { frames: [0, 1], fps: 3 },
  peachBoosters: { frames: [0, 1, 2, 3], fps: 6 },
} as const;

// --- GameState.create: the starfield ----------------------------------------

/**
 * The backdrop is black with a particle emitter raining star-particle.png
 * (a soft white 32 px disc at 0.05-0.2 scale, so 2-6 px) from the top at
 * 150-250 px/s, one every 50 ms, each in one of these tints.
 */
export const STAR_TINTS = [0x72747d, 0x3c3e45, 0xe5e7f0, 0xafb1b8, 0x630dd0];
