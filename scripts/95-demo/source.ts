/**
 * EVIL INVADERS '95, as data: the numbers the 95-demo cloud game is converted
 * from.
 *
 * The source is easierbycode/95-demo-sp (Svelte 5 + Phaser 4) at the commit in
 * SOURCE. Everything here is ported verbatim from the file named beside it,
 * so the converter (build-level.ts) never has to parse TypeScript or reach
 * the network: the stage table from src/game/levels.ts, the tuning constants
 * from src/consts.ts, the wave timing from src/Enemies.svelte, the animation
 * table from src/App.svelte's preload, and the CORE_GALAGA flight paths from
 * src/game/paths.ts. The art those animations cut lives beside this file in
 * art/, copied byte for byte from the source's public/assets.
 *
 * The source plays on a 540x960 portrait field; shmupX on 256x480. Nothing in
 * this file is scaled — the converter does that, in one place.
 */

/** Where every number below comes from. */
export const SOURCE = {
  repo: "https://github.com/easierbycode/95-demo-sp",
  commit: "865fab19306b43188ebd72a691f618f703b2ddee",
} as const;

// --- src/consts.ts ---------------------------------------------------------

export const GAME_WIDTH = 540;
export const GAME_HEIGHT = 960;
/** The Galaga paths were authored for an 820x896 field. */
export const PATH_SCALE_X = GAME_WIDTH / 820;
export const PATH_SCALE_Y = GAME_HEIGHT / 896;

export const FORMATION_TOP = 130;
export const FORMATION_CELL_W = 46;
export const FORMATION_CELL_H = 44;
export const FORMATION_STEP_PX = 9;
export const FORMATION_STEPS_PER_SIDE = 4;

export const PLAYER_FIRE_COOLDOWN = 190;
export const STARTING_LIVES = 3;

export const BOSS_HP = 50;
export const BOSS_SCALE = 0.7;
export const BOSS_Y = 180;
export const BOSS_FIRE_SPEED = 230;
export const BOSS_BLAST_SPEED = 480;
export const BOSS_SCORE = 5000;
export const BUTT_DEVIL_HP = 12;
export const BUTT_DEVIL_COUNT = 3;
export const BUTT_DEVIL_SCORE = 500;

/** The CoolInvader and RainbowInvader: horizontal drift px/s, bouncing off the walls. */
export const INVADER_BOSS_SPEED = 130;
/** GenericEnemy.scheduleShooting: fire immediately, then every 2 s. */
export const INVADER_BOSS_FIRE_INTERVAL = 2000;
export const INVADER_BOSS_BULLET_SPEED = 260;
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

export type InvaderBossKind = "cool" | "rainbow";

export interface InvaderBossDef {
  /** The sheet in SHEETS. */
  sheet: "coolInvader" | "rainbowInvader";
  /** Display scale on the 540-wide field. */
  scale: number;
  /** The invader bullet is drawn at this scale: `bullet.scale = sprite scale * 15`. */
  bulletScale: number;
  bulletTints?: number[];
}

/** src/consts.ts INVADER_BOSSES, minus the voxel particle bursts. */
export const INVADER_BOSSES: Record<InvaderBossKind, InvaderBossDef> = {
  cool: { sheet: "coolInvader", scale: 0.5, bulletScale: 7.5 },
  rainbow: {
    sheet: "rainbowInvader",
    scale: 0.8,
    bulletScale: 9,
    bulletTints: RAINBOW_BULLET_TINTS,
  },
};

/**
 * Stages 1..10 are formation waves; stage 11 of each cycle is the boss. The
 * boss roster rotates each cycle (src/GameRound.svelte): RedDevil, then
 * CoolInvader, then RainbowInvader.
 */
export const STAGES_PER_CYCLE = 11;
export const BOSS_ROSTER = ["redDevil", "cool", "rainbow"] as const;

export type EnemyKind = "eyeDude" | "pinkBunny" | "goldGirl";

export interface EnemyType {
  key: EnemyKind;
  /** Sprite scale on the 540-wide field. */
  scale: number;
  hp: number;
  score: number;
  diveScore: number;
}

export const ENEMY_TYPES: Record<EnemyKind, EnemyType> = {
  eyeDude: { key: "eyeDude", scale: 0.8, hp: 1, score: 80, diveScore: 160 },
  pinkBunny: {
    key: "pinkBunny",
    scale: 0.8,
    hp: 1,
    score: 100,
    diveScore: 200,
  },
  goldGirl: { key: "goldGirl", scale: 0.72, hp: 2, score: 150, diveScore: 400 },
};

// --- src/game/levels.ts ----------------------------------------------------

export interface StageDef {
  /** Formation rows, top first. */
  rows: { type: EnemyKind; count: number }[];
  /** px/s along fly-in paths. */
  entrySpeed: number;
  /** ms between dive launches. */
  diveDelay: number;
  /** ms between formation shots. */
  fireDelay: number;
  /** ms between formation march steps. */
  marchInterval: number;
  /** Enemy bullet px/s. */
  bulletSpeed: number;
  /** px the formation drops when the march reverses. */
  descendOnFlip: number;
  /** Formation bullets aim at a player instead of falling straight. */
  aimedShots: boolean;
}

const r = (type: EnemyKind, count: number) => ({ type, count });

/** Levels 1..10 of the first cycle, verbatim. */
export const STAGES: StageDef[] = [
  {
    rows: [r("eyeDude", 6), r("pinkBunny", 6), r("pinkBunny", 6)],
    entrySpeed: 300,
    diveDelay: 4200,
    fireDelay: 1700,
    marchInterval: 950,
    bulletSpeed: 150,
    descendOnFlip: 0,
    aimedShots: false,
  },
  {
    rows: [r("goldGirl", 2), r("eyeDude", 6), r("pinkBunny", 8)],
    entrySpeed: 310,
    diveDelay: 3800,
    fireDelay: 1550,
    marchInterval: 900,
    bulletSpeed: 160,
    descendOnFlip: 0,
    aimedShots: false,
  },
  {
    rows: [
      r("goldGirl", 3),
      r("eyeDude", 7),
      r("eyeDude", 7),
      r("pinkBunny", 8),
    ],
    entrySpeed: 320,
    diveDelay: 3400,
    fireDelay: 1400,
    marchInterval: 850,
    bulletSpeed: 170,
    descendOnFlip: 0,
    aimedShots: false,
  },
  {
    rows: [
      r("goldGirl", 4),
      r("eyeDude", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 330,
    diveDelay: 3000,
    fireDelay: 1300,
    marchInterval: 800,
    bulletSpeed: 180,
    descendOnFlip: 6,
    aimedShots: false,
  },
  {
    rows: [
      r("goldGirl", 4),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 340,
    diveDelay: 2700,
    fireDelay: 1200,
    marchInterval: 740,
    bulletSpeed: 190,
    descendOnFlip: 6,
    aimedShots: true,
  },
  {
    rows: [
      r("goldGirl", 4),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 350,
    diveDelay: 2400,
    fireDelay: 1100,
    marchInterval: 690,
    bulletSpeed: 200,
    descendOnFlip: 8,
    aimedShots: true,
  },
  {
    rows: [
      r("goldGirl", 5),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 360,
    diveDelay: 2100,
    fireDelay: 1000,
    marchInterval: 640,
    bulletSpeed: 215,
    descendOnFlip: 8,
    aimedShots: true,
  },
  {
    rows: [
      r("goldGirl", 6),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 375,
    diveDelay: 1800,
    fireDelay: 900,
    marchInterval: 590,
    bulletSpeed: 230,
    descendOnFlip: 10,
    aimedShots: true,
  },
  {
    rows: [
      r("goldGirl", 6),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 390,
    diveDelay: 1500,
    fireDelay: 780,
    marchInterval: 540,
    bulletSpeed: 245,
    descendOnFlip: 10,
    aimedShots: true,
  },
  {
    rows: [
      r("goldGirl", 6),
      r("eyeDude", 8),
      r("eyeDude", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
      r("pinkBunny", 8),
    ],
    entrySpeed: 400,
    diveDelay: 1250,
    fireDelay: 660,
    marchInterval: 480,
    bulletSpeed: 260,
    descendOnFlip: 12,
    aimedShots: true,
  },
];

/** Slots are dealt into squadrons of eight, which fly in one at a time. */
export const SQUADRON_SIZE = 8;

// --- src/Enemies.svelte ----------------------------------------------------

export const INTRO_DELAY = 2200;
export const SQUADRON_INTERVAL = 3200;
export const MEMBER_STAGGER = 220;
/** The wave locks (and starts firing and diving) on a 400 ms poll. */
export const LOCK_POLL_MS = 400;
/** Dive shots fire at these fractions of the dive path. */
export const DIVE_FIRE_AT = [0.3, 0.6];
/** A dive is flown this much faster than the stage's entry speed. */
export const DIVE_SPEED_BONUS = { boss: 40, single: 20 };
/** Bullets are spawned this far below the shooter. */
export const BULLET_DROP = 14;

// --- the foo raiders: src/consts.ts, src/game/fooRaid.ts, src/FooRaider.svelte

/**
 * From the second cycle on — once the first boss is down — a raid row drops
 * through every 7 s while the formation is locked: blobHeads and flyBrains
 * out of foo-v1-ground-shooter, on its 256-wide grid scaled up to the field.
 * Raiders never hold a level open.
 */
export const FOO_SCALE = GAME_WIDTH / 256;
export const FOO_SPAWN_Y = -64;
/** Descent, px/s. */
export const FOO_BLOBHEAD_SPEED = 96;
export const FOO_FLYBRAIN_SPEED = 144;
/** A blobHead below this drifts across, toward the far side. */
export const FOO_FUNNEL_Y = GAME_HEIGHT / 3;
/** A flyBrain below this homes on the nearest ship. */
export const FOO_HOMING_Y = GAME_HEIGHT / 1.5;
/** The blobHead's sideways drift, px/s. */
export const FOO_FUNNEL_DRIFT = 60 * FOO_SCALE;
/** Per 60 Hz frame: x += rate * (playerX - x). */
export const FOO_HOMING_RATE = 0.005;
/** A blobHead spawned at or right of this drifts left, else right. */
export const FOO_SIDE_SPLIT = 152 * FOO_SCALE;
/** A blobHead fires straight down every 5 s from its spawn. */
export const FOO_BLOBHEAD_FIRE_INTERVAL = 5000;
export const FOO_BULLET_SPEED = 120;
export const FOO_BLOBHEAD_HP = 1;
export const FOO_FLYBRAIN_HP = 2;
export const FOO_BLOBHEAD_SCORE = 100;
export const FOO_FLYBRAIN_SCORE = 200;
export const FOO_RAID_INTERVAL = 7000;
/** No row drops while this many raiders are alive. */
export const FOO_RAID_MAX = 12;
/** A level's raids start at row `levelNum * 7` and wrap. */
export const FOO_RAID_ROW_STRIDE = 7;

/**
 * foo's stage0 rows, in spawn order: A a blobHead at x = 24 + 32 col, B a
 * flyBrain at 16 + 32 col (foo px, x FOO_SCALE). R and S were never defined
 * and spawn nothing; the item digit did nothing. An empty or R/S row still
 * spends its raid.
 */
export const FOO_RAID_ROWS: string[][] = [
  ["00", "00", "00", "A0", "00", "00", "00", "00"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["A0", "00", "00", "A0", "00", "00", "00", "A0"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["00", "00", "00", "A3", "00", "00", "00", "00"],
  ["A0", "00", "00", "00", "A0", "00", "00", "A0"],
  ["00", "00", "00", "A0", "00", "00", "00", "00"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["00", "A0", "A0", "A0", "A0", "A0", "A0", "00"],
  ["B3", "00", "00", "A0", "00", "00", "00", "B9"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["R0", "S0", "00", "A0", "00", "00", "S0", "R0"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["S0", "R0", "00", "A0", "00", "00", "R0", "S0"],
  ["00", "00", "00", "00", "A1", "00", "00", "00"],
  ["00", "00", "00", "A0", "00", "00", "00", "00"],
  ["R0", "S0", "A0", "A3", "A0", "A0", "S0", "R0"],
  ["B9", "00", "00", "00", "00", "00", "00", "B3"],
  ["S0", "R0", "S0", "00", "00", "S0", "R0", "S0"],
  ["00", "00", "00", "A2", "A0", "00", "00", "00"],
  ["R0", "S0", "R0", "00", "00", "R0", "S0", "R0"],
  ["00", "00", "00", "A0", "A3", "00", "00", "00"],
  ["00", "00", "00", "A0", "A0", "00", "00", "00"],
  ["00", "00", "A0", "A0", "A0", "A0", "00", "00"],
  ["A0", "A0", "A0", "00", "00", "A0", "A0", "A0"],
  ["A0", "A0", "00", "00", "00", "00", "A0", "A0"],
  ["A0", "00", "00", "00", "00", "00", "00", "A0"],
  ["B0", "00", "00", "00", "00", "00", "00", "B0"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["A0", "00", "00", "00", "00", "00", "00", "A1"],
  ["S0", "R0", "S0", "A2", "A3", "S0", "R0", "S0"],
  ["00", "00", "00", "00", "A0", "00", "00", "00"],
  ["R0", "S0", "00", "A0", "00", "00", "S0", "R0"],
  ["B0", "00", "00", "00", "A0", "00", "00", "B0"],
  ["B0", "00", "00", "00", "00", "00", "00", "B0"],
  ["00", "00", "00", "00", "A3", "00", "00", "00"],
  ["B0", "00", "00", "00", "00", "00", "00", "B0"],
  ["00", "00", "A0", "A0", "A0", "A0", "00", "00"],
  ["A0", "A0", "A0", "00", "00", "A0", "A0", "A0"],
  ["B0", "00", "00", "00", "00", "00", "00", "B0"],
  ["B0", "00", "00", "00", "00", "00", "00", "B3"],
  ["B1", "00", "00", "00", "00", "00", "00", "00"],
  ["R0", "S0", "R0", "A0", "A0", "R0", "S0", "R0"],
];

export type FooKind = "blobHead" | "flyBrain";

/** A raider's x on foo's grid (foo px), for row cell `col`. */
export function fooRaiderX(kind: FooKind, col: number): number {
  return (kind === "blobHead" ? 24 : 16) + 32 * col;
}

// --- src/App.svelte (preload and animations) -------------------------------

export interface SheetArt {
  /** File in art/. */
  file: string;
  frameW: number;
  frameH: number;
}

/** Grid spritesheets, with the frame size each is loaded at. */
export const SHEETS = {
  eyeDude: { file: "eye-dude.png", frameW: 48, frameH: 36 },
  goldGirl: { file: "gold-girl.png", frameW: 62, frameH: 80 },
  invaderBullet: { file: "invader-bullet.png", frameW: 3, frameH: 7 },
  player2: { file: "player2.png", frameW: 52, frameH: 32 },
  redDevil: { file: "red-devil.png", frameW: 160, frameH: 166 },
  coolInvader: { file: "cool-invader.png", frameW: 431, frameH: 275 },
  rainbowInvader: { file: "rainbow-invader.png", frameW: 263, frameH: 174 },
  buttDevils: { file: "butt-devils.png", frameW: 43, frameH: 39 },
  devilFire: { file: "devil-fire.png", frameW: 42, frameH: 35 },
  devilBlast: { file: "devil-blast.png", frameW: 123, frameH: 96 },
  poof: { file: "poof.png", frameW: 16, frameH: 15 },
} as const satisfies Record<string, SheetArt>;

/** Animations, as frame lists and frames per second. */
export const ANIMS = {
  eyeDudeFlap: { frames: [0, 1], fps: 3 },
  pinkBunnyFlap: { frames: ["pink-bunny-0.png", "pink-bunny-1.png"], fps: 3 },
  goldGirlNormal: { frames: [0, 1], fps: 2 },
  invaderBulletFlicker: { frames: [0, 1], fps: 8 },
  player2Thrust: { frames: [0, 1, 2, 3], fps: 10 },
  purpleBubble: { frames: ["atlas_s0", "atlas_s1"], fps: 6 },
  redDevilFlap: { frames: [0, 1], fps: 2 },
  redDevilRelease: { frames: [11, 12, 13, 14, 15, 14, 15, 14, 15], fps: 24 },
  redDevilToot: { frames: [14, 15], fps: 4 },
  coolInvaderFlap: { frames: [0, 1], fps: 2 },
  coolInvaderHit: { frames: [2, 3, 4, 5], fps: 12 },
  rainbowInvaderFlap: { frames: [0, 1], fps: 2 },
  rainbowInvaderHit: { frames: [2, 3, 4, 5], fps: 12 },
  buttDevilFlap: { frames: [3, 4, 5, 4], fps: 12 },
  devilFireBurn: {
    frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    fps: 30,
  },
  devilBlastBurn: { frames: [0, 1, 2, 3, 4, 5, 6, 7], fps: 12 },
  poof: { frames: [0, 1, 2], fps: 12 },
  // the foo raiders, off the foo_asset multiatlas
  fooBlobHeadWalk: {
    frames: [
      "blobHead0.png",
      "blobHead1.png",
      "blobHead2.png",
      "blobHead3.png",
    ],
    fps: 8,
  },
  fooFlyBrainFly: {
    frames: [
      "flyBrain0.png",
      "flyBrain1.png",
      "flyBrain2.png",
      "flyBrain3.png",
    ],
    fps: 6,
  },
  fooBullet: { frames: ["blobHeadBullet0.png", "blobHeadBullet1.png"], fps: 6 },
} as const;

/** Display scales the source draws each piece of art at, on its own field. */
export const DRAW_SCALE = {
  invaderBullet: 2.4,
  player1: 0.9,
  player2: 1.1,
  playerBullet: 0.8,
  purpleOrb: 1.6,
  redDevil: BOSS_SCALE,
  coolInvader: INVADER_BOSSES.cool.scale,
  rainbowInvader: INVADER_BOSSES.rainbow.scale,
  buttDevil: 1,
  devilFire: 1,
  devilBlast: 0.8,
  /** The RedDevil's death poof, blown up x9. */
  bossPoof: 9,
  /** foo's art, its 256-wide field blown up to the source's. */
  foo: FOO_SCALE,
} as const;

// --- src/game/paths.ts -----------------------------------------------------

export type Point = { x: number; y: number };

/** One path command: a straight line or a cubic bezier to `to`. */
export type PathSeg =
  | { kind: "line"; to: Point }
  | { kind: "cubic"; c1: Point; c2: Point; to: Point };

export interface PathDef {
  start: Point;
  segs: PathSeg[];
}

export const FLY_IN_PATHS = [0, 1, 2, 3] as const;
export const DIVE_WASP = [4, 5] as const;
export const DIVE_BUTTERFLY = [6, 7] as const;
export const DIVE_BOSS = [8, 9] as const;

/**
 * The ten CORE_GALAGA paths, as paths.ts builds them. `cubicBezierTo(x, y,
 * c1x, c1y, c2x, c2y)` ends at (x, y) — Phaser's argument order.
 */
export function createPaths(): PathDef[] {
  const sx = (v: number) => v * PATH_SCALE_X;
  const sy = (v: number) => v * PATH_SCALE_Y;
  const P = (x: number, y: number): Point => ({ x: sx(x), y: sy(y) });
  const line = (x: number, y: number): PathSeg => ({
    kind: "line",
    to: P(x, y),
  });
  const cubic = (
    x: number,
    y: number,
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
  ): PathSeg => ({
    kind: "cubic",
    to: P(x, y),
    c1: P(c1x, c1y),
    c2: P(c2x, c2y),
  });
  const mid = 410;
  const full = mid * 2;
  const temp = mid - 100;
  const temp2 = mid + 100;
  return [
    {
      start: P(mid + 50, -10),
      segs: [
        line(mid + 50, 20),
        cubic(75, 425, mid + 50, 100, 75, 325),
        cubic(350, 425, 75, 650, 325, 650),
      ],
    },
    {
      start: P(mid - 50, -10),
      segs: [
        line(mid - 50, 20),
        cubic(full - 75, 425, mid - 50, 100, full - 75, 325),
        cubic(full - 350, 425, full - 75, 650, full - 325, 650),
      ],
    },
    {
      start: P(-40, 720),
      segs: [
        cubic(0, 720, -50, 720, 10, 720),
        cubic(temp, 400, 200, 720, temp, 500),
        cubic(40, 400, temp, 200, 40, 200),
        cubic(temp - 40, 440, 40, 500, temp - 120, 600),
      ],
    },
    {
      start: P(full + 40, 720),
      segs: [
        cubic(full, 720, full + 50, 720, full - 10, 720),
        cubic(temp2, 400, full - 200, 720, temp2, 500),
        cubic(full - 40, 400, temp2, 200, full - 40, 200),
        cubic(temp2 + 40, 440, full - 40, 500, temp2 + 120, 600),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(-60, 0, 0, -45, -60, -45),
        cubic(100, 150, -60, 80, 0, 150),
        cubic(350, 350, 250, 150, 350, 200),
        cubic(100, 350, 350, 575, 100, 575),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(60, 0, 0, -45, 60, -45),
        cubic(-100, 150, 60, 80, 0, 150),
        cubic(-350, 350, -250, 150, -350, 200),
        cubic(-100, 350, -350, 575, -100, 575),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(-60, 0, 0, -45, -60, -45),
        cubic(200, 200, -60, 80, 200, 125),
        cubic(175, 325, 200, 275, 175, 250),
        cubic(375, 525, 175, 425, 375, 425),
        cubic(300, 775, 375, 575, 300, 625),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(60, 0, 0, -45, 60, -45),
        cubic(-200, 200, 60, 80, -200, 125),
        cubic(-175, 325, -200, 275, -175, 250),
        cubic(-375, 525, -175, 425, -375, 425),
        cubic(-300, 775, -375, 575, -300, 625),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(-90, 0, 0, -60, -90, -60),
        cubic(-15, 275, -90, 60, -100, 272),
        cubic(-15, 125, 85, 275, 85, 125),
        cubic(120, 450, -175, 125, 0, 450),
        cubic(200, 550, 160, 450, 200, 500),
        cubic(200, 800, 200, 540, 200, 810),
      ],
    },
    {
      start: P(0, 0),
      segs: [
        cubic(90, 0, 0, -60, 90, -60),
        cubic(15, 275, 90, 60, 100, 272),
        cubic(15, 125, -85, 275, -85, 125),
        cubic(-120, 450, 175, 125, 0, 450),
        cubic(-200, 550, -160, 450, -200, 500),
        cubic(-200, 800, -200, 540, -200, 810),
      ],
    },
  ];
}
