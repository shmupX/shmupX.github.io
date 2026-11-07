/**
 * RonaGun (hellophaser v4), as data: the numbers the `hellophaser` cloud game
 * is converted from.
 *
 * The source is the Phaser 3 shooter at easierbycode.com/hellophaser/v4/: a
 * Cordova app built with Parcel. Its game code is the tail of
 * js.02c97bae.js, so everything here is ported from the module named beside
 * it. The frame sizes are from Scene1.preload, the animation table from
 * Scene1.create, the timetable from Scene2.create, the speeds from
 * Scene2.moveShip and each class's constructor, and the emitters from Lincoln
 * and Asteroid. The art lives beside this file in art/, copied byte for byte
 * from the site (the Parcel hash dropped from each name).
 *
 * The source plays on a 256x272 field; shmupX on 256x480. Nothing in this file
 * is scaled. The converter does that, in one place.
 */

/** Where every number below comes from. */
export const SOURCE = {
  site: "https://easierbycode.com/hellophaser/v4/",
  bundle: "https://easierbycode.com/hellophaser/v4/js.02c97bae.js",
  title: "RonaGun",
} as const;

// --- config.ts ---------------------------------------------------------------

export const GAME_WIDTH = 256;
export const GAME_HEIGHT = 272;
/** Phaser's game loop: one update, one moveShip step, a display frame. */
export const FPS = 60;

// --- Scene1.preload: the sheets ---------------------------------------------

export interface SheetArt {
  /** File in art/. */
  file: string;
  frameW: number;
  frameH: number;
  margin?: number;
}

export const SHEETS = {
  lincoln: { file: "lincoln.png", frameW: 27, frameH: 58 },
  lincolnFireball: { file: "lincoln-fireball.png", frameW: 9, frameH: 22 },
  blueAngel: { file: "blue-angel.png", frameW: 70, frameH: 55 },
  asteroid: { file: "asteroid-face.png", frameW: 33, frameH: 32 },
  uniblinky: { file: "uniblinky.png", frameW: 16, frameH: 16 },
  ufo: { file: "ufo.png", frameW: 32, frameH: 30 },
  mouthman: { file: "mouthman.png", frameW: 64, frameH: 64 },
  cheerleaderBlonde: {
    file: "cheerleader-blonde.png",
    frameW: 48,
    frameH: 35,
  },
  floppy: { file: "floppy.png", frameW: 38, frameH: 41 },
  eyeFly: { file: "eye-fly.png", frameW: 32, frameH: 16 },
  goblin: { file: "goblin.png", frameW: 16, frameH: 16 },
  alienSkull: { file: "alien-skull.png", frameW: 32, frameH: 32 },
  hatbotGunner: { file: "hatbot-gunner.png", frameW: 32, frameH: 42 },
  hatbot: { file: "hatbot.png", frameW: 15, frameH: 10 },
  hatbotJetpack: { file: "hatbot-jetpack.png", frameW: 27, frameH: 25 },
  virusV2: { file: "virus-v2.png", frameW: 21, frameH: 18 },
  cyBrain: { file: "cy-brain.png", frameW: 48, frameH: 48 },
  bombarossa: { file: "bombarossa.png", frameW: 20, frameH: 16 },
  botterfly: { file: "botterfly.png", frameW: 64, frameH: 32 },
  virus: { file: "virus.png", frameW: 29, frameH: 28 },
  sentinel: { file: "sentinel.png", frameW: 87, frameH: 35 },
  clownBalloons: { file: "clown-balloons.png", frameW: 32, frameH: 63 },
  marsDodo: { file: "mars-dodo.png", frameW: 41, frameH: 44 },
  monkeyFlyingCarpet: {
    file: "monkey-flying-carpet.png",
    frameW: 40,
    frameH: 29,
  },
  ronald: { file: "ronald.png", frameW: 38, frameH: 94 },
  seductress: { file: "seductress-flying.png", frameW: 271, frameH: 171 },
} as const satisfies Record<string, SheetArt>;

export type SheetKey = keyof typeof SHEETS;

/** Single images (Scene1.preload's load.image, Menu.preload's). */
export const IMAGES = {
  blue: "blue.png",
  red: "red.png",
  star: "star.png",
  fairyBullet: "fairy-bullet.png",
  logo: "RonaGun-logo.png",
  startBtn: "start-btn.png",
  starBg0: "star-bg-0.png",
} as const;

// --- Scene1.create: the animations ------------------------------------------

export interface AnimDef {
  sheet: SheetKey;
  frames: number[];
  fps: number;
}

export const ANIMS = {
  // Lincoln: "lincoln-fly" (frames 0, 1 at 2 fps); "lincoln-shoot" (2, 3).
  lincolnFly: { sheet: "lincoln", frames: [0, 1], fps: 2 },
  lincolnFireball: { sheet: "lincolnFireball", frames: [0, 1, 2, 3], fps: 30 },
  blueAngel: { sheet: "blueAngel", frames: [0, 1], fps: 4 },
  asteroid: { sheet: "asteroid", frames: [0, 1], fps: 20 },
  uniblinky: { sheet: "uniblinky", frames: [0, 1, 2, 3], fps: 20 },
  ufo: { sheet: "ufo", frames: [0, 1, 2, 3, 4, 5], fps: 4 },
  mouthman: { sheet: "mouthman", frames: [0, 1], fps: 20 },
  cheerleaderBlonde: { sheet: "cheerleaderBlonde", frames: [0, 1], fps: 4 },
  floppy: { sheet: "floppy", frames: [0, 1, 2, 3, 4, 5, 6, 7], fps: 12 },
  eyeFly: { sheet: "eyeFly", frames: [0, 1], fps: 15 },
  goblin: { sheet: "goblin", frames: [0, 1], fps: 4 },
  alienSkull: { sheet: "alienSkull", frames: [0, 1], fps: 4 },
  hatbotGunner: { sheet: "hatbotGunner", frames: [0, 1, 2, 3], fps: 4 },
  hatbot: { sheet: "hatbot", frames: [0, 1, 2, 3, 4, 5], fps: 4 },
  hatbotJetpack: { sheet: "hatbotJetpack", frames: [0, 1], fps: 20 },
  virusV2: { sheet: "virusV2", frames: [0, 1, 2, 3], fps: 20 },
  cyBrain: { sheet: "cyBrain", frames: [0, 1], fps: 4 },
  bombarossa: { sheet: "bombarossa", frames: [0, 1], fps: 4 },
  botterfly: { sheet: "botterfly", frames: [0, 1, 2], fps: 4 },
  virus: { sheet: "virus", frames: [0, 1], fps: 20 },
  // The sentinels play one frame each until shot ("drop_cargo" etc. on death).
  sentinel: { sheet: "sentinel", frames: [0], fps: 1 },
  clownBalloons: { sheet: "clownBalloons", frames: [0, 1], fps: 2 },
  marsDodo: { sheet: "marsDodo", frames: [0, 1, 2], fps: 20 },
  monkeyFlyingCarpet: { sheet: "monkeyFlyingCarpet", frames: [0, 1], fps: 4 },
  ronald: { sheet: "ronald", frames: [0], fps: 1 },
  // Seductress: "seductress.default" flies in on frame 0; shot down she plays
  // "seductress.morph" (0..9 at 4 fps) and stands up as the girl.
  seductressDefault: { sheet: "seductress", frames: [0], fps: 1 },
  seductressMorph: {
    sheet: "seductress",
    frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    fps: 4,
  },
  seductressStand: {
    sheet: "seductress",
    frames: [10, 11, 12, 13, 14, 15, 16, 15, 14, 13, 14, 15],
    fps: 8,
  },
} as const satisfies Record<string, AnimDef>;

export type AnimKey = keyof typeof ANIMS;

// --- Scene2.create / moveShip: the three lanes -------------------------------

/**
 * Scene2 keeps three enemies on the field at all times: ship1, ship2 and
 * virus. moveShip drops each one `lane` px per frame (1, 2 and 3), and once
 * it falls past the bottom, or is shot (hitEnemy), resetShipPos puts it back
 * at y 0 on a random x. Timers swap ship1's and virus's sprite for the next
 * one on the list (Scene2's `a(...)` and `p(...)` calls). ship2 stays the
 * Asteroid with its red particle trail.
 */
export interface LaneDef {
  /** px per frame, down. */
  speed: number;
  /** Which sprite the lane flies from `from` seconds on. */
  roster: { from: number; anim: AnimKey; scale?: number }[];
}

export const LANES: LaneDef[] = [
  {
    speed: 1,
    roster: [
      { from: 0, anim: "blueAngel" },
      { from: 10, anim: "ufo" },
      { from: 20, anim: "mouthman" },
      { from: 30, anim: "cheerleaderBlonde" },
      { from: 40, anim: "floppy" },
      { from: 50, anim: "eyeFly" },
      // "goblin" is the one the timer draws at setScale(2).
      { from: 60, anim: "goblin", scale: 2 },
      { from: 70, anim: "alienSkull" },
      { from: 80, anim: "hatbotGunner" },
    ],
  },
  { speed: 2, roster: [{ from: 0, anim: "asteroid" }] },
  {
    speed: 3,
    roster: [
      { from: 0, anim: "uniblinky" },
      { from: 18, anim: "hatbot" },
      { from: 27, anim: "hatbotJetpack" },
      { from: 36, anim: "virusV2" },
      { from: 45, anim: "cyBrain" },
      { from: 54, anim: "bombarossa" },
      { from: 63, anim: "botterfly" },
      { from: 72, anim: "virus" },
    ],
  },
];

/** Scene2.hitEnemy: anything in the enemies group dies to one shot, for 15. */
export const LANE_SCORE = 15;

// --- Scene2.create: the sentinels and the Seductress ------------------------

/**
 * The sentinels group: each one is placed off the left edge and crosses
 * right at body.velocity.x 50, with `health` 10 (Sentinel, ClownBalloons,
 * MarsDodo, MonkeyFlyingCarpet, Ronald). They do not hurt the ship.
 */
export interface CrosserDef {
  anim: AnimKey;
  /** Centre, source px (default origin 0.5). */
  x: number;
  y: number;
  health: number;
}

export const CROSSER_SPEED = 50;

export const CROSSERS: CrosserDef[] = [
  { anim: "sentinel", x: -587, y: 35, health: 10 },
  { anim: "clownBalloons", x: -900, y: 63, health: 10 },
  { anim: "marsDodo", x: -1200, y: 44, health: 10 },
  { anim: "monkeyFlyingCarpet", x: -1500, y: 29, health: 10 },
  { anim: "ronald", x: -1800, y: 47, health: 10 },
];

/**
 * new Seductress(this, -3850, 0): origin (1, 0), so her right edge is at
 * -3850 and she crosses right at 50 px/s like the sentinels, health 20.
 */
export const SEDUCTRESS = { right: -3850, top: 0, health: 20, speed: 50 };

// --- Lincoln -------------------------------------------------------------------

/** game-settings.ts: playerSpeed 200 px/s on the arrow keys. */
export const PLAYER_SPEED = 200;
/** Lincoln.shoot: nextShotAt = now + 100 ms. */
export const PLAYER_FIRE_RATE_MS = 100;
/** LincolnFireball: body.velocity.y -250. */
export const FIREBALL_SPEED = 250;

// --- the emitters ----------------------------------------------------------------

/**
 * A Phaser particle emitter hung on a sprite with startFollow, as the source
 * configures it. Ranges are [min, max]; `angle` in degrees, 0 to the right,
 * 90 down.
 */
export interface EmitterDef {
  image: keyof typeof IMAGES;
  speed: number;
  lifespan: [number, number];
  angle?: [number, number];
  scale: { start: number; end: number };
  blendMode: "ADD";
}

export const EMITTERS = {
  /**
   * Lincoln's thruster: add.particles("blue"), speed 125, lifespan
   * Between(200, 300), angle `this.angle - 270 + Between(-15, 15)`. The ship
   * never turns, so that is 90 ± 15, straight down. Scale .275 to 0, ADD.
   * boost() raises the speed to 375 for the spin; the record keeps the
   * cruising speed.
   */
  lincoln: {
    image: "blue",
    speed: 125,
    lifespan: [200, 300],
    angle: [75, 105],
    scale: { start: 0.275, end: 0 },
    blendMode: "ADD",
  },
  /** Asteroid: add.particles("red"), speed 5, lifespan Between(200, 300), scale .24 to 0, ADD. */
  asteroid: {
    image: "red",
    speed: 5,
    lifespan: [200, 300],
    scale: { start: 0.24, end: 0 },
    blendMode: "ADD",
  },
} as const satisfies Record<string, EmitterDef>;

/**
 * Scene2's starfield: add.particles("star"), one every 100 ms for 6 s,
 * falling at 60-100 px/s, alpha .75-.85, tinted at random from these.
 */
export const STAR_TINTS = [
  7500925,
  3948101,
  15067120,
  11514296,
  16711833,
  15987477,
  8647980,
  6491600,
];
export const STAR_FREQUENCY_MS = 100;
export const STAR_LIFESPAN_MS = 6000;

// --- the music ---------------------------------------------------------------------

/**
 * Scene2: this.sound.add("music", { loop: true, volume: 1 }).play(): the
 * title song loops from the first frame of play to the last.
 */
export const MUSIC_URL =
  "https://easierbycode.com/hellophaser/v4/title-song-vbr%20(Mastered%20with%20Thunder%20at%20100pct).7ab5d673.mp3";
