// A level record -> a Dezaemon Kids! memory card: the PlayStation counterpart
// of src/write/game-to-save.js, which does the same for a Saturn cart.
//
// kids.js READS a save and kids-edit.js changes fields of one that already
// exists; this is the first thing under src/psx/ that builds one from nothing.
// The input is the level record the editor saves to the cloud — `enemylist` +
// `width` (or `stages.stageN`), `enemyData`, `bossData`, `playerData`, the
// scenery an import carried back (`backgroundCells` + `background.tiles`) —
// and the art as RGBA frames keyed by atlas frame name, exactly what
// buildSaveFromGame takes. The output is the 0x1E000-byte save block and the
// 128 KB card it sits on.
//
// What lands where (FORMAT-PSX.md, "Dezaemon Kids!"):
//
//   graphics   four CG pages of 16x16 cells, 8bpp through the disc's FIXED
//              256-colour bank (kids-palette.js) — every frame is reduced to
//              its nearest colour there, because a Kids! save carries no
//              palette of its own. Map chips take 2x2-aligned cell groups,
//              sprites single cells, and both share repeats and mirrors.
//   MAP        384 rows x 7 chips of 32x32 per stage, cut from the level's
//              16x16 scenery cells four at a time (14 Saturn columns are
//              exactly 7 chips; 768 Saturn rows are exactly 384)
//   SCROLL     1 px per frame to the boss, then a halt
//   APPEAR     one slot byte per 32 px: the zako anchors, the boss, and the
//              footprint marks the editor needs on every cell a bigger enemy
//              covers (it will not displace an enemy it cannot see)
//   CONFIG     a vertical game of N stages over Athena's own settings
//   RECORDS    five-byte zako records; the boss's fifteen from Athena's games
//   SHIP       the ship's poses and shot, the title logo, the item icons, the
//              blast and the seven enemy bullets
//   SPRITES    the cell strips each spawn class draws from, and the boss's 8x8
//   tail       the factory ladder and the factory options, from KIDS.EXE
//   header     the "SC" frame with the game name between 『 』, and an icon cut
//              from the ship
//
// Most of this is confirmed by the traced readers kids.js cites. Where the
// writer goes past what is traced it says so at the constant, with where the
// value was read from — thirteen sample games off the disc and two routines in
// KIDS.EXE and GAMES.bin — so the next reader knows what to re-check.
//
// Environment-neutral ESM (Node + browser).

import { compress } from "../compress.js";
import { CG_CELL, CG_CELL_BYTES } from "../palette/deza2-palette.js";
import { colorHistogram, medianCut } from "../palette/palette-target.js";
import { rgb555ToRgb } from "../decode/decode-cg.js";
import { decodePlayerArt } from "../player-art.js";
import { hflipRgba } from "../write/game-to-save.js";
import {
    blastFrames,
    decodeFrameKey,
    fitRgba,
    itemIcon,
    levelStages,
    rotateCcwRgba,
    shotSprite,
    spreadFrames,
} from "../write/game-to-save.js";
import { KIDS_PALETTE, KIDS_TRANSPARENT_INDEX } from "./kids-palette.js";
import {
    KIDS_APPEAR_BOSS_CLASS,
    KIDS_APPEAR_CELLS,
    KIDS_APPEAR_CLASSES,
    KIDS_APPEAR_COLUMNS,
    KIDS_APPEAR_FOOTPRINT_CLASS,
    KIDS_APPEAR_PRESENT,
    KIDS_APPEAR_ROWS,
    KIDS_APPEAR_STAGE_BYTES,
    KIDS_BLANK,
    KIDS_BLOCK_SIZE,
    KIDS_BOSS_OFFSET,
    KIDS_BOSS_SIZE,
    KIDS_CELL_ALIGN,
    KIDS_CELL_COUNT,
    KIDS_CLASS_BASE,
    KIDS_DATA_SIZE,
    KIDS_FIRST_SECTION,
    KIDS_GRAPHICS_SIZE,
    KIDS_HFLIP,
    KIDS_HISCORE_COUNT,
    KIDS_HISCORE_SIZE,
    KIDS_MAP_COLUMNS,
    KIDS_MAP_ROWS,
    KIDS_MAP_STAGE_BYTES,
    KIDS_OPTIONS_OFFSET,
    KIDS_PRODUCT,
    KIDS_RECORD_SIZE,
    KIDS_RECORDS_STAGE_BYTES,
    KIDS_REGION,
    KIDS_SCROLL_STAGE_BYTES,
    KIDS_SCROLL_UNIT_PIXELS,
    KIDS_SCROLL_UNITS,
    KIDS_SHIP_TABLE_BYTES,
    KIDS_SPRITE_BOSS_OFFSETS,
    KIDS_SPRITE_BOSS_WORDS,
    KIDS_SPRITE_CLASS_OFFSETS,
    KIDS_SPRITE_ENTRY_WORDS,
    KIDS_SPRITE_STAGE_BYTES,
    KIDS_STAGES,
    KIDS_TAIL_SIZE,
    KIDS_VFLIP,
    parseKidsSave,
    KIDS_ANIM_INTERVALS,
} from "./kids.js";
import {
    KIDS_HISCORE_NAME_PAD,
    KIDS_TITLE_CLOSE,
    KIDS_TITLE_NAME_BYTES,
    KIDS_TITLE_NAME_CHARS,
    KIDS_TITLE_NAME_OFFSET,
    KIDS_TITLE_OPEN,
    kidsNameBytes,
    sealKidsTable,
} from "./kids-edit.js";
import { CLUT_OFFSET, ICON_DIM, TITLE_FRAME_SIZE, TITLE_LENGTH, TITLE_OFFSET } from "./save-header.js";
import { buildMemoryCard } from "./memcard-write.js";
import { bossBodyFrames, bossWeapons, splitBossStage2, weaponTextures } from "../boss-stage2.js";

// --- the geometry the samples agree on -----------------------------------------
//
// Each constant below that is not in kids.js was read off the disc's thirteen
// SGM_*.CMP sample games (Athena's own, under \SAMPLE\ in KIDS_DAT.BIN) and
// rendered to check — the strips below draw as the games' own sprites under
// this reading and as halves of them under the alternatives.

/**
 * How a spawn class's 16-word sprite entry is laid out: a row-major strip
 * `stripW` cells wide and `stripH` tall, its frames side by side, frame f
 * occupying columns f*w .. f*w+w-1. Class 0 is four 2x2 frames in an 8x2 strip,
 * class 1 two 4x2 frames in the same 8x2, class 2 two 2x4 frames in a 4x4,
 * class 3 one 4x4 frame. (likely: the class 0 strip is the one FORMAT-PSX.md
 * names; the other three come out as the games' art only under this reading.)
 */
export const KIDS_SPRITE_STRIPS = Object.freeze([
    Object.freeze({ klass: 0, w: 2, h: 2, frames: 4, stripW: 8, stripH: 2 }),
    Object.freeze({ klass: 1, w: 4, h: 2, frames: 2, stripW: 8, stripH: 2 }),
    Object.freeze({ klass: 2, w: 2, h: 4, frames: 2, stripW: 4, stripH: 4 }),
    Object.freeze({ klass: 3, w: 4, h: 4, frames: 1, stripW: 4, stripH: 4 }),
]);

/**
 * A boss part's 64 words are an 8x8 cell grid (128x128 px), row-major, and the
 * art of a smaller boss sits in its top-left corner: a 128x64 boss paints rows
 * 0-3, a 64x128 one columns 0-3 (likely: every one of the 36 painted boss parts
 * in the samples fits this; the size class is the hit box, not the art).
 */
export const KIDS_BOSS_GRID = 8;
/** Art cells (w, h) per boss size class, matching KIDS_BOSS_SIZES. */
export const KIDS_BOSS_ART_CELLS = Object.freeze([[4, 4], [8, 4], [4, 8], [8, 8]]);
/** Footprint (w, h) in 32-px appear cells per boss size class. */
export const KIDS_BOSS_FOOTPRINT = Object.freeze([[2, 2], [4, 2], [2, 4], [4, 4]]);

/**
 * The common SHIP table, word by word, as KIDS.EXE composes it into VRAM
 * (confirmed — the composers 0x80076F04 poses, 0x80077020 shots, 0x80077260
 * bombs, 0x800775F0 titles, 0x80077338 items, 0x800773C4 blast through the
 * placement table 0x8006300C, 0x800774C8 bullets): the first ship's three
 * 2x2 poses stored [TL, TR, BL, BR] (pose 1, words 4-7, is the level pose),
 * its shot as FOUR 16x16 animation frames, its bomb as four 2x2 frames in an
 * 8x2 row-major strip, the second ship laid out the same from 32, two 8x6
 * title pictures (128x96) the title screen overlays, six 16x16 item icons in
 * the ITEM LIST's order (icon = the record's item value - 1), the blast as
 * six 2x2 frames in the interleaved order `blastWords` spells, and the seven
 * enemy bullets a record's bullet selector names, four frames each.
 */
export const KIDS_SHIP_LAYOUT = Object.freeze({
    ship1: Object.freeze({ poses: [0, 4, 8], shot: 12, bomb: 16 }),
    ship2: Object.freeze({ poses: [32, 36, 40], shot: 44, bomb: 48 }),
    title1: Object.freeze({ at: 64, w: 8, h: 6 }),
    title2: Object.freeze({ at: 112, w: 8, h: 6 }),
    items: Object.freeze({ at: 160, count: 6 }),
    blast: Object.freeze({ at: 166, frames: 6 }),
    bullets: Object.freeze({ at: 190, count: 7, frames: 4 }),
});
/** The blast's frame f, cell [TL, TR, BL, BR] -> SHIP word: two 3-frame 8x2 strips (0x8006300C). */
export function blastWords(f) {
    const base = f < 3 ? 166 + 2 * f : 178 + 2 * (f - 3);
    return [base, base + 1, base + 6, base + 7];
}
/** A bomb's frame f (an 8x2 strip of four 2x2 frames) -> the four words of `at`'s strip. */
export function bombWords(at, f) {
    return [at + f * 2, at + f * 2 + 1, at + 8 + f * 2, at + 8 + f * 2 + 1];
}
export const KIDS_SHIP_TABLE_WORDS = KIDS_SHIP_TABLE_BYTES / 2; // 218

/**
 * The six item icons, in the order the game's ITEM LIST screen names them:
 * POWER UP, SPEED UP, BOMB UP, 1UP, 1000PTS UP, 50000PTS UP (likely — the
 * screen lists them in this order with the icon each slot holds). Each slot
 * is painted from the first atlas frame named here that the art carries —
 * the web game's own power-up emblems, F for firepower, R (its speed-up art)
 * and B — else from what `fallback` says: the ship for the extra life, a
 * drawn coin for the point items.
 */
export const KIDS_ITEM_SLOTS = Object.freeze([
    Object.freeze({ name: "POWER UP", frames: ["powerupBig0.gif", "powerupBig0.png", "powerupBig1.gif"], fallback: "square", type: 7 }),
    Object.freeze({ name: "SPEED UP", frames: ["speedupItem0.gif", "speedupItem0.png", "speedupItem1.gif"], fallback: "square", type: 8 }),
    Object.freeze({ name: "BOMB UP", frames: ["barrierItem0.gif", "barrierItem0.png", "barrierItem1.gif"], fallback: "square", type: 5 }),
    Object.freeze({ name: "1UP", frames: ["1upItem0.gif", "1upItem0.png"], fallback: "ship", type: 4 }),
    Object.freeze({ name: "1000PTS", frames: ["scoreItem0.gif", "scoreItem0.png"], fallback: "coin", type: 6 }),
    Object.freeze({ name: "50000PTS", frames: ["scoreItem1.gif", "scoreItem1.png"], fallback: "bigCoin", type: 6 }),
]);
/** Every frame name an item slot may ask the art for — what a CLI pulls from the base atlas. */
export const KIDS_STOCK_ITEM_FRAMES = Object.freeze(KIDS_ITEM_SLOTS.flatMap((s) => s.frames));

// --- the records (confirmed — GAMES.bin spawner 0x801384F4 and its tables) ---
//
// A zako record's five bytes, as the spawner reads them: byte 0 = movement
// pattern (bits 0-4, GAMES.bin's pointer table 0x8014B4E8, three speed
// variants in bits 5-6, bit 7 = appear from behind); byte 1 = hardness
// (bits 0-2, the hit-point index), score tier (bits 3-4), opacity mark
// (bits 5-7); byte 2 = bullet type (bits 0-3, the SHIP table's seven quads,
// 7-8 the program's lasers), attack timing (bits 4-5, 0 = never fires),
// animation interval (bits 6-7, {30, 10, 2, 0} frames); byte 3 = shot
// pattern (bits 0-3), aim at the player (bit 4), item drop (bits 5-7,
// 1..6 = the six icons); byte 4 = rotation mark (bits 0-2), scale mark
// (bits 3-5), ground mark (bit 7).
//
// The movement scripts are ten-byte steps {duration, angle, angular
// velocity, speed | ride, flags} on a y-up sin table, so angle 192 is down
// the screen. Pattern 0 is one step {forever, 192, 0, speed 0 | ride}: it
// rides the map (the editor's STOP). Pattern 4 is {forever, 192, 0, 1.0 /
// 2.0 / 4.5 px per frame} by variant: straight down the screen.

/** Record byte 0 bits 0-4: the pattern that rides the scroll. */
export const KIDS_MOVE_STATIONARY = 0;
/** Record byte 0 bits 0-4: straight down the screen; bits 5-6 pick the speed. */
export const KIDS_MOVE_STRAIGHT = 4;
/** Pattern 4's three variants, in px per frame. */
export const KIDS_STRAIGHT_SPEEDS = Object.freeze([1, 2, 4.5]);
/** A Kids! px/frame is half a runtime px/frame, the Saturn writer's ratio. */
export const RUNTIME_TO_KIDS_SPEED = 0.5;
/** Record byte 4 bit 7: the editor's 地上物 (ground) mark — a draw and physics mark, independent of the pattern. */
export const KIDS_GROUND_MARK = 0x80;
/**
 * Hit points per hardness index, chosen by the spawn CLASS: the three
 * tables at GAMES.bin 0x8014A0D0 / 0x8014A0E0 / 0x8014A0F0 (class 0, classes
 * 1-2, class 3), scaled x2/3, x1, x1.5 by the difficulty. Index 3 is the
 * "max, not counted" hardness (0x7D000 in every table); hardness 4 is
 * untraced and not written.
 */
export const KIDS_HP_TABLES = Object.freeze([
    Object.freeze([0x100, 0x9600, 0x19000, 0x7d000]),
    Object.freeze([0x3200, 0x12c00, 0x32000, 0x7d000]),
    Object.freeze([0x3200, 0x12c00, 0x32000, 0x7d000]),
    Object.freeze([0x6400, 0x25800, 0x64000, 0x7d000]),
]);
/** A standard player shot's power, one of the weapons' (GAMES.bin 0x8013532C); others run 4608..9728. */
export const KIDS_SHOT_UNITS = 5120;
/** Score per tier by spawn class (GAMES.bin 0x8014A098 / A0A0 / A0A8); tier 3 is worth nothing. */
export const KIDS_SCORE_TABLES = Object.freeze([
    Object.freeze([50, 100, 200]),
    Object.freeze([500, 1000, 2000]),
    Object.freeze([500, 1000, 2000]),
    Object.freeze([2000, 5000, 10000]),
]);
/**
 * Record byte 3 bits 5-7: the item a death drops, 1..6 = the ITEM LIST's
 * POWER UP, SPEED UP, BOMB UP, 1UP, 1000PTS, 50000PTS. The web game's drop
 * digits (F big shot 1, S 3-way 2, R rapid 3, B barrier 9) become the
 * power-up, the power-up, the speed-up and the bomb.
 */
export const KIDS_ITEM_FOR_DROP = Object.freeze({ 1: 1, 2: 1, 3: 2, 9: 3 });
/**
 * Boss hit points per class (GAMES.bin 0x8014A100), per PHASE: a boss's two
 * 15-byte records are its two phases and its total is both. Score per
 * phase and class: phase 1 {0, 10000, 50000}, phase 2 {50000, 100000, 500000}.
 */
export const KIDS_BOSS_HP = Object.freeze([0x7d000, 0x232800, 0x465000, 0x753000]);
export const KIDS_BOSS_SCORE = Object.freeze([50000, 110000, 550000]);
/** Boss byte 0 bits 4-5: the move speed class, scale {2, 4, 10}. */
export const KIDS_BOSS_SPEEDS = 3;

/**
 * One five-byte zako record from named fields (the spawner's inverse).
 */
export function encodeKidsRecord({
    movement = KIDS_MOVE_STRAIGHT,
    variant = 0,
    fromBehind = false,
    hardness = 0,
    scoreTier = 0,
    opacity = 0,
    bullet = 0,
    timing = 0,
    animIndex = 1,
    shotPattern = 0,
    aim = false,
    item = 0,
    rotation = 0,
    scale = 0,
    ground = false,
} = {}) {
    return [
        (movement & 0x1f) | ((variant % 3) << 5) | (fromBehind ? 0x80 : 0),
        (hardness & 7) | ((scoreTier & 3) << 3) | ((opacity % 5) << 5),
        (bullet % 9) | ((timing & 3) << 4) | ((animIndex & 3) << 6),
        (shotPattern & 0x0f) | (aim ? 0x10 : 0) | ((item & 7) << 5),
        (rotation % 5) | ((scale % 5) << 3) | (ground ? KIDS_GROUND_MARK : 0),
    ];
}

/**
 * One fifteen-byte boss record (GAMES.bin 0x8013C1B8, 0x8013B984): the
 * pattern, speed class and size class, the hit-point and score classes and
 * the opacity mark, the rotation / scale / ground marks, then three weapons
 * {dx, dy, bullet | timing << 4, pattern | aim << 4}.
 */
export function encodeKidsBoss({
    pattern = 0,
    speed = 1,
    sizeClass = 3,
    hpClass = 1,
    scoreClass = 1,
    opacity = 0,
    rotation = 0,
    scale = 0,
    ground = false,
    weapons = [],
} = {}) {
    const b = new Uint8Array(KIDS_BOSS_SIZE);
    b[0] = (pattern & 0x0f) | ((speed % KIDS_BOSS_SPEEDS) << 4) | ((sizeClass & 3) << 6);
    b[1] = (hpClass & 3) | ((scoreClass & 3) << 3) | ((opacity % 5) << 5);
    b[2] = (rotation % 5) | ((scale % 5) << 3) | (ground ? 0x80 : 0);
    for (let w = 0; w < 3; w++) {
        const wp = weapons[w] || { dx: 0, dy: 0, bullet: 0, timing: 0, pattern: 0, aim: false };
        b[3 + w * 4] = wp.dx & 0xff;
        b[4 + w * 4] = wp.dy & 0xff;
        b[5 + w * 4] = (wp.bullet % 9) | ((wp.timing & 3) << 4);
        b[6 + w * 4] = (wp.pattern & 0x0f) | (wp.aim ? 0x10 : 0);
    }
    return b;
}

/**
 * The movement and weapons a boss of each size class wears, read off
 * Athena's sample bosses (ANGEL WING's stage 1 for 128x128, RAMSIE's stages
 * 0 and 1 for 128x64 and 64x128, MIYAKO's stage 0 for 64x64): their pattern
 * and speed class, and their three weapons' offsets, timings and patterns.
 * The boss scripts' shapes are not traced; a sample boss's are a real boss's.
 */
export const KIDS_BOSS_BEHAVIOUR = Object.freeze([
    Object.freeze({ pattern: 1, speed: 1, weapons: [{ dx: 0, dy: 27, bullet: 1, timing: 2, pattern: 6, aim: true }, { dx: 6, dy: 32, bullet: 1, timing: 1, pattern: 13, aim: false }, { dx: 6, dy: 16, bullet: 0, timing: 1, pattern: 0, aim: true }] }),
    Object.freeze({ pattern: 10, speed: 1, weapons: [{ dx: -26, dy: -1, bullet: 0, timing: 2, pattern: 3, aim: true }, { dx: 25, dy: -1, bullet: 0, timing: 2, pattern: 3, aim: true }, { dx: 0, dy: 0, bullet: 3, timing: 1, pattern: 6, aim: false }] }),
    Object.freeze({ pattern: 2, speed: 0, weapons: [{ dx: -6, dy: -12, bullet: 6, timing: 2, pattern: 9, aim: false }, { dx: -24, dy: -12, bullet: 4, timing: 1, pattern: 0, aim: true }, { dx: 12, dy: -13, bullet: 4, timing: 1, pattern: 0, aim: true }] }),
    Object.freeze({ pattern: 12, speed: 1, weapons: [{ dx: 0, dy: 53, bullet: 7, timing: 2, pattern: 0, aim: false }, { dx: 0, dy: -30, bullet: 3, timing: 0, pattern: 3, aim: true }, { dx: -1, dy: 2, bullet: 1, timing: 1, pattern: 3, aim: false }] }),
]);

/**
 * A boss phase's three weapons: the sample's offsets, timings and patterns
 * for its size, each shooting the quad the art of its own weapon slot (A, B,
 * C; a slot it lacks takes A's) landed in — quadOf(frame name) says which,
 * null for none. A weapon whose art has no quad keeps the sample's bullet,
 * the built-in lasers 7 and 8 among them.
 */
export function kidsBossWeapons(sample, rec, quadOf) {
    const slots = bossWeapons(rec);
    const quadOfSlot = (i) => {
        const hit = slots[i] || slots[0];
        const first = hit ? weaponTextures(hit.weapon)[0] : null;
        return first ? quadOf(first) : null;
    };
    return sample.map((w, i) => {
        const q = quadOfSlot(i);
        return q === null ? { ...w } : { ...w, bullet: q };
    });
}

/** The per-stage initialiser's boss record (`10 09 00 …`): pattern 0, speed 1, 64x64, hit-point and score class 1, no weapons. */
export const KIDS_BOSS_DEFAULT = Object.freeze(Array.from(encodeKidsBoss({ pattern: 0, speed: 1, sizeClass: 0, hpClass: 1, scoreClass: 1 })));

/**
 * The 0x70 CONFIG bytes of ANGEL WING (SGM_AWIN), a vertical one-player game,
 * as the template every exported game starts from: its font, sound bank, ship
 * records, point-item values, item records, player-shot records and sixteen
 * sound entries are kept, and the writer sets the scroll direction, the stage
 * flags, the per-stage motion and background bytes over it.
 */
export const KIDS_CONFIG_TEMPLATE = Object.freeze([
    0x00, 0xa2, 0x03, 0x01, 0x20, 0x01, 0x00, 0x01, 0x81, 0x80, 0x47, 0x01, 0x82, 0x46, 0x01, 0x02,
    0x02, 0x09, 0x09, 0x09, 0x09, 0x05, 0x05, 0x05, 0x01, 0x09, 0x05, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x00, 0x03, 0x00, 0x7f, 0x03, 0x00, 0x1f, 0x7f, 0x01, 0x00, 0x00, 0x7f, 0x06, 0x00, 0x20, 0x7f,
    0x05, 0x00, 0x20, 0x7f, 0x02, 0x00, 0x18, 0x7f, 0x00, 0x00, 0x18, 0x7f, 0x10, 0x00, 0x57, 0x7f,
    0x10, 0x00, 0x57, 0x7f, 0x12, 0x00, 0x18, 0x7f, 0x00, 0x00, 0x18, 0x7f, 0x00, 0x00, 0x55, 0x7f,
    0x20, 0x00, 0x3d, 0x7f, 0x58, 0x00, 0x3a, 0x7f, 0x00, 0x00, 0x18, 0x7f, 0x00, 0x00, 0x18, 0x7f,
    0x00, 0x00, 0x18, 0x07, 0x07, 0x01, 0x07, 0x11, 0x14, 0x06, 0x06, 0x16, 0x16, 0x03, 0x19, 0x00,
]);
export const KIDS_CONFIG_SOUND_OFFSET = 0x23;
export const KIDS_CONFIG_MOTION_OFFSET = 0x63;
export const KIDS_CONFIG_BACKGROUND_OFFSET = 0x69;
export const KIDS_CONFIG_LAST_STAGE = 0x80;
/** Motion byte: scroll speed index 2 (1 px/frame), the same table SCROLL uses. */
export const KIDS_MOTION_DEFAULT = 0x02;
/** Motion bits 4-5: background set speed index 2 (12 px) when a set is named. */
export const KIDS_MOTION_BACKGROUND = 0x20;
/** The last of the disc's 38 numbered backdrops (config +0x69..+0x6E). */
export const KIDS_BACKGROUND_SETS = 38;

/**
 * The 0x1C option bytes KIDS.EXE's factory initialiser (0x80065E94) writes,
 * confirmed byte for byte off its stores: screen position 1/1/0xA0/0x50 three
 * times over, the cursor at 8/2/1, stereo on, the backdrop byte 2 (bit 0
 * clear: black), volume 127. The same routine zeroes +0xBC..+0xD3 and leaves
 * the rest of the tail as it finds it; here it is zero.
 */
export const KIDS_FACTORY_OPTIONS = Object.freeze([
    0x01, 0x01, 0xa0, 0x50, 0x01, 0xa0, 0x50, 0x00, 0x01, 0xa0, 0x50, 0x08, 0x02, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x7f, 0x00,
]);
/** The factory ladder's level byte: 1, NORMAL (KIDS.EXE 0x80064B98). */
export const KIDS_FACTORY_LEVEL = 1;

// --- placement geometry -------------------------------------------------------------

/** The first wave's appear row when the level carries no `waveRows` (128 px in). */
export const KIDS_FIRST_SPAWN_ROW = 4;
/** Rows between waves without `waveRows`: 192 px, the Saturn writer's spacing. */
export const KIDS_ROW_STEP = 6;
/** The boss waits this many rows past the last wave (384 px). */
export const KIDS_BOSS_ROW_GAP = 12;
export const KIDS_MAX_SPAWN_ROW = KIDS_APPEAR_ROWS - 16;
/** Appear columns 1..7 are the 224-px playfield; 0 and 8 are off either edge. */
export const KIDS_FIRST_VISIBLE_COLUMN = 1;
export const KIDS_VISIBLE_COLUMNS = KIDS_MAP_COLUMNS; // 7
/** A 4-cell-wide boss centred on the 7 visible cells; a 2-cell one likewise. */
export const KIDS_BOSS_COLUMN = Object.freeze([3, 2, 3, 2]);
/** Scroll nibble 2 = 1 px/frame; 0 halts, which is how the samples hold a boss. */
export const KIDS_SCROLL_RUN = 2;
export const KIDS_SCROLL_HALT = 0;
/** The initialiser's blank chip word, the commonest blank in the collection. */
export const KIDS_MAP_FILL = 0x8080;

// --- small helpers -----------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nearestIndex(table, value) {
    let best = 0, bestD = Infinity;
    table.forEach((v, i) => {
        const d = Math.abs(v - value);
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}

function putU16le(bytes, at, v) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
}

function putU32le(bytes, at, v) {
    putU16le(bytes, at, v & 0xffff);
    putU16le(bytes, at + 2, (v >>> 16) & 0xffff);
}

function b64ToBytes(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** An RGBA frame mirrored left to right — game-to-save.js's, kept here for the callers that import it from the Kids! writer. */
export { hflipRgba };

/** Level column -> appear column 1..7; a two-cell-wide enemy stops at 6. */
export function mapKidsColumn(col, width, cellsWide = 1) {
    const last = KIDS_FIRST_VISIBLE_COLUMN + KIDS_VISIBLE_COLUMNS - cellsWide;
    if (width <= 1) return clamp(KIDS_FIRST_VISIBLE_COLUMN + Math.floor((KIDS_VISIBLE_COLUMNS - cellsWide) / 2), KIDS_FIRST_VISIBLE_COLUMN, last);
    const c = KIDS_FIRST_VISIBLE_COLUMN + Math.round((col * (KIDS_VISIBLE_COLUMNS - 1)) / (width - 1));
    return clamp(c, KIDS_FIRST_VISIBLE_COLUMN, last);
}

/** The spawn class whose box holds w x h px art: 0 32x32, 1 64x32, 2 32x64, 3 64x64. */
export function kidsClassFor(w, h) {
    if (w <= 32 && h <= 32) return 0;
    if (h <= 32) return 1;
    if (w <= 32) return 2;
    return 3;
}

/** The boss size class whose box holds w x h px art: 0 64x64, 1 128x64, 2 64x128, 3 128x128. */
export function kidsBossClassFor(w, h) {
    if (w <= 64 && h <= 64) return 0;
    if (h <= 64) return 1;
    if (w <= 64) return 2;
    return 3;
}

// --- the fixed palette ---------------------------------------------------------------

let paletteRgb = null;
const nearestCache = new Map();

/** The index of the bank colour nearest an opaque 8-bit colour, never 0. */
export function nearestKidsIndex(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    const hit = nearestCache.get(key);
    if (hit !== undefined) return hit;
    if (!paletteRgb) paletteRgb = KIDS_PALETTE.map((w) => rgb555ToRgb(w & 0x7fff));
    let best = 1, bestD = Infinity;
    for (let i = 1; i < paletteRgb.length; i++) {
        const p = paletteRgb[i];
        const dr = p.r - r, dg = p.g - g, db = p.b - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; }
    }
    nearestCache.set(key, best);
    return best;
}

/** Pixels with alpha below this are transparent (index 0), as the Saturn writer. */
export const KIDS_ALPHA_CUTOFF = 128;

/** An RGBA frame as w*h bank indices, transparent where the alpha says so. */
export function quantizeKidsFrame(frame) {
    const out = new Uint8Array(frame.w * frame.h);
    for (let i = 0; i < out.length; i++) {
        const o = i * 4;
        if (frame.rgba[o + 3] < KIDS_ALPHA_CUTOFF) { out[i] = KIDS_TRANSPARENT_INDEX; continue; }
        out[i] = nearestKidsIndex(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]);
    }
    return out;
}

// --- the cell bank ---------------------------------------------------------------------

export class KidsBankFullError extends Error {
    constructor(what) {
        super(`the four CG pages hold ${KIDS_CELL_COUNT} cells and every one is taken (${what})`);
        this.name = "KidsBankFullError";
    }
}

function cellKey(cell) {
    let s = "";
    for (let i = 0; i < cell.length; i++) s += String.fromCharCode(cell[i]);
    return s;
}

function flipCellH(cell, dim) {
    const out = new Uint8Array(cell.length);
    for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) out[y * dim + x] = cell[y * dim + (dim - 1 - x)];
    return out;
}

function flipCellV(cell, dim) {
    const out = new Uint8Array(cell.length);
    for (let y = 0; y < dim; y++) out.set(cell.subarray((dim - 1 - y) * dim, (dim - y) * dim), y * dim);
    return out;
}

function isBlank(bytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i]) return false;
    return true;
}

/**
 * The 1,024-cell graphics bank a Kids! save carries, filled two ways: map
 * chips take a 2x2-ALIGNED group of four cells (n, n+1, n+8, n+9 — the chip
 * word's rule, kids.js) and are handed out from the bottom of the bank up;
 * sprite cells take any single cell and come from the top down. A repeated
 * cell or chip, or one that is a mirror of a stored one, is shared through
 * the word's flip bits; a blank one costs nothing and is KIDS_BLANK.
 */
export class KidsCellBank {
    constructor() {
        this.graphics = new Uint8Array(KIDS_GRAPHICS_SIZE);
        this.taken = new Uint8Array(KIDS_CELL_COUNT);
        this.used = 0;
        this.chips = 0;
        this.sprites = 0;
        this.shared = 0;
        this.cellByKey = new Map();
        this.chipByKey = new Map();
        this.nextSingle = KIDS_CELL_COUNT - 1;
    }

    get free() {
        return KIDS_CELL_COUNT - this.used;
    }

    _store(index, cell) {
        this.graphics.set(cell, index * CG_CELL_BYTES);
        this.taken[index] = 1;
        this.used++;
    }

    /** One 16x16 cell -> its word (cell | flips), or KIDS_BLANK. */
    addCell(cell) {
        if (isBlank(cell)) return KIDS_BLANK;
        const key = cellKey(cell);
        const hit = this.cellByKey.get(key);
        if (hit) { this.shared++; return hit; }
        let index = this.nextSingle;
        while (index >= 0 && this.taken[index]) index--;
        if (index < 0) throw new KidsBankFullError("a sprite cell");
        this.nextSingle = index - 1;
        this._store(index, cell);
        this.sprites++;
        this.cellByKey.set(key, index);
        const h = flipCellH(cell, CG_CELL), v = flipCellV(cell, CG_CELL);
        for (const [bytes, flags] of [[h, KIDS_HFLIP], [v, KIDS_VFLIP], [flipCellV(h, CG_CELL), KIDS_HFLIP | KIDS_VFLIP]]) {
            const k = cellKey(bytes);
            if (!this.cellByKey.has(k)) this.cellByKey.set(k, index | flags);
        }
        return index;
    }

    /** A 32x32 indexed chip (row-major, 1,024 bytes) -> its map word. */
    addChip(chip) {
        if (isBlank(chip)) return KIDS_MAP_FILL;
        const key = cellKey(chip);
        const hit = this.chipByKey.get(key);
        if (hit !== undefined) { this.shared++; return hit; }
        let n = -1;
        for (let c = 0; c < KIDS_CELL_COUNT; c++) {
            if ((c & KIDS_CELL_ALIGN) !== 0) continue;
            if (this.taken[c] || this.taken[c + 1] || this.taken[c + 8] || this.taken[c + 9]) continue;
            n = c;
            break;
        }
        if (n < 0) throw new KidsBankFullError("a map chip");
        const dim = 2 * CG_CELL;
        for (const [cy, cx, index] of [[0, 0, n], [0, 1, n + 1], [1, 0, n + 8], [1, 1, n + 9]]) {
            const cell = new Uint8Array(CG_CELL_BYTES);
            for (let y = 0; y < CG_CELL; y++) {
                cell.set(chip.subarray((cy * CG_CELL + y) * dim + cx * CG_CELL, (cy * CG_CELL + y) * dim + cx * CG_CELL + CG_CELL), y * CG_CELL);
            }
            this._store(index, cell);
        }
        this.chips++;
        this.chipByKey.set(key, n);
        const h = flipCellH(chip, dim), v = flipCellV(chip, dim);
        for (const [bytes, flags] of [[h, KIDS_HFLIP], [v, KIDS_VFLIP], [flipCellV(h, dim), KIDS_HFLIP | KIDS_VFLIP]]) {
            const k = cellKey(bytes);
            if (!this.chipByKey.has(k)) this.chipByKey.set(k, n | flags);
        }
        return n;
    }

    /**
     * An indexed frame whose w and h are multiples of 16 -> one word per cell
     * in reading order. Throws KidsBankFullError with nothing stored when the
     * frame's new cells do not fit.
     */
    addFrame(indexed, w, h) {
        const cw = w / CG_CELL, ch = h / CG_CELL;
        const cells = [];
        let need = 0;
        const seen = new Set();
        for (let cy = 0; cy < ch; cy++) {
            for (let cx = 0; cx < cw; cx++) {
                const cell = new Uint8Array(CG_CELL_BYTES);
                for (let y = 0; y < CG_CELL; y++) {
                    cell.set(indexed.subarray((cy * CG_CELL + y) * w + cx * CG_CELL, (cy * CG_CELL + y) * w + cx * CG_CELL + CG_CELL), y * CG_CELL);
                }
                cells.push(cell);
                if (isBlank(cell)) continue;
                const k = cellKey(cell);
                if (this.cellByKey.has(k) || seen.has(k)) continue;
                seen.add(k);
                need++;
            }
        }
        if (need > this.free) throw new KidsBankFullError(`${need} new cells for a ${w}x${h} frame, ${this.free} free`);
        return Uint16Array.from(cells, (c) => this.addCell(c));
    }
}

// --- the icon -----------------------------------------------------------------------------

/**
 * A 16x16 RGBA frame as a PlayStation save icon: 16 RGB555 CLUT words (entry 0
 * transparent, pure black kept opaque with the STP bit) and 128 bytes of 4bpp
 * pixels, low nibble left. Colours are median-cut to fifteen.
 */
export function encodeKidsIcon(frame) {
    const fitted = fitRgba(frame, ICON_DIM, ICON_DIM);
    const hist = colorHistogram([fitted]);
    const words = medianCut(hist, 15);
    const clut = new Uint16Array(16);
    words.forEach((w, i) => { clut[i + 1] = w === 0 ? 0x8000 : w; });
    const pixels = new Uint8Array(ICON_DIM * ICON_DIM / 2);
    const to5 = (v) => v >> 3;
    for (let i = 0; i < ICON_DIM * ICON_DIM; i++) {
        const o = i * 4;
        let index = 0;
        if (fitted.rgba[o + 3] >= KIDS_ALPHA_CUTOFF && words.length) {
            const r = to5(fitted.rgba[o]), g = to5(fitted.rgba[o + 1]), b = to5(fitted.rgba[o + 2]);
            let best = 0, bestD = Infinity;
            words.forEach((w, k) => {
                const dr = (w & 31) - r, dg = ((w >> 5) & 31) - g, db = ((w >> 10) & 31) - b;
                const d = dr * dr + dg * dg + db * db;
                if (d < bestD) { bestD = d; best = k; }
            });
            index = best + 1;
        }
        if (i & 1) pixels[i >> 1] |= index << 4;
        else pixels[i >> 1] |= index;
    }
    return { clut, pixels };
}

/** A gold coin for a point item: a rimmed disc with a glint, `size` px across in a 16x16 cell. */
export function coinSprite(size = 12) {
    const dim = 16;
    const rgba = new Uint8Array(dim * dim * 4);
    const c = (dim - 1) / 2, r = size / 2;
    for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
            const d = Math.hypot(x - c, y - c);
            if (d > r) continue;
            const o = (y * dim + x) * 4;
            const rim = d > r - 1.6;
            const glint = x - c < -r * 0.25 && y - c < -r * 0.25 && d < r - 2;
            rgba[o] = rim ? 150 : glint ? 255 : 250;
            rgba[o + 1] = rim ? 95 : glint ? 250 : 200;
            rgba[o + 2] = rim ? 20 : glint ? 190 : 40;
            rgba[o + 3] = 255;
        }
    }
    return { w: dim, h: dim, rgba };
}

/** A plain icon for a game with no ship art: a "K" on a dark square. */
export function defaultKidsIcon() {
    const rgba = new Uint8Array(ICON_DIM * ICON_DIM * 4);
    const rows = [
        "................",
        ".##############.",
        ".#............#.",
        ".#.##....##...#.",
        ".#.##...##....#.",
        ".#.##..##.....#.",
        ".#.##.##......#.",
        ".#.####.......#.",
        ".#.####.......#.",
        ".#.##.##......#.",
        ".#.##..##.....#.",
        ".#.##...##....#.",
        ".#.##....##...#.",
        ".#............#.",
        ".##############.",
        "................",
    ];
    for (let y = 0; y < ICON_DIM; y++) {
        for (let x = 0; x < ICON_DIM; x++) {
            const o = (y * ICON_DIM + x) * 4;
            const ink = rows[y][x] === "#";
            rgba[o] = ink ? 255 : 40;
            rgba[o + 1] = ink ? 220 : 40;
            rgba[o + 2] = ink ? 80 : 60;
            rgba[o + 3] = 255;
        }
    }
    return { w: ICON_DIM, h: ICON_DIM, rgba };
}

// --- the name -----------------------------------------------------------------------------

/**
 * A level's name as the ten characters the title field holds: ASCII, with
 * anything kidsNameBytes cannot encode dropped and the rest cut to ten.
 * Returns {text, bytes, changed}.
 */
export function kidsGameNameFor(name) {
    const source = String(name ?? "").trim() || "my game";
    const kept = [];
    let dropped = false;
    for (const ch of source) {
        try {
            kidsNameBytes(ch);
            kept.push(ch);
        } catch {
            dropped = true;
        }
    }
    let text = kept.join("").replace(/\s+/g, " ").trim();
    const cut = [...text].length > KIDS_TITLE_NAME_CHARS;
    if (cut) text = [...text].slice(0, KIDS_TITLE_NAME_CHARS).join("");
    if (!text) text = "GAME";
    return { text, bytes: kidsNameBytes(text), changed: dropped || cut || text !== source };
}

/** The title bytes: the fixed 42-byte prefix, the 20-byte name, then 』. */
export const KIDS_TITLE_PREFIX_BYTES = Object.freeze([
    0x83, 0x66, 0x83, 0x55, 0x83, 0x47, 0x83, 0x82, 0x83, 0x93, // デザエモン
    0x82, 0x6a, 0x82, 0x89, 0x82, 0x84, 0x82, 0x93, 0x81, 0x49, // Ｋｉｄｓ！
    0x83, 0x86, 0x81, 0x5b, 0x83, 0x55, 0x81, 0x5b, 0x83, 0x51, 0x81, 0x5b, 0x83, 0x80, 0x83, 0x66, 0x81, 0x5b, 0x83, 0x5e, // ユーザーゲームデータ
    (KIDS_TITLE_OPEN >> 8) & 0xff, KIDS_TITLE_OPEN & 0xff, // 『
]);

// --- the block -------------------------------------------------------------------------------

/**
 * A 0x1E000 save block from its parts: the "SC" header around `name` (20 bytes
 * of Shift-JIS from kidsNameBytes) and `icon` ({clut, pixels}), then the two
 * sections LZSS-packed on 0x80 sector boundaries, the raw tail, and the
 * directory sealed over them. Read back through parseKidsSave() before it is
 * returned: the directory must cross-check, the three sums verify and both
 * streams decompress to the bytes given.
 *
 * @param {{graphics: Uint8Array, data: Uint8Array, tail: Uint8Array, name: Uint8Array, icon: {clut: Uint16Array, pixels: Uint8Array}}} parts
 * @returns {{block: Uint8Array, seal: object, sizes: {graphics: number, data: number}}}
 */
export function buildKidsBlock({ graphics, data, tail, name, icon }) {
    if (!(graphics instanceof Uint8Array) || graphics.length !== KIDS_GRAPHICS_SIZE) {
        throw new Error(`graphics must be ${KIDS_GRAPHICS_SIZE} bytes`);
    }
    if (!(data instanceof Uint8Array) || data.length !== KIDS_DATA_SIZE) throw new Error(`data must be ${KIDS_DATA_SIZE} bytes`);
    if (!(tail instanceof Uint8Array) || tail.length !== KIDS_TAIL_SIZE) throw new Error(`the tail must be ${KIDS_TAIL_SIZE} bytes`);
    if (!(name instanceof Uint8Array) || name.length !== KIDS_TITLE_NAME_BYTES) {
        throw new Error(`the name must be ${KIDS_TITLE_NAME_BYTES} bytes of Shift-JIS (kidsNameBytes)`);
    }
    const block = new Uint8Array(KIDS_BLOCK_SIZE);
    block[0] = 0x53; // S
    block[1] = 0x43; // C
    block[2] = 0x11; // one icon frame
    block[3] = KIDS_BLOCK_SIZE / 0x2000; // 15 blocks
    block.set(KIDS_TITLE_PREFIX_BYTES, TITLE_OFFSET);
    block.set(name, KIDS_TITLE_NAME_OFFSET);
    // Shift-JIS is big-endian in the stream: the lead byte of 』 comes first.
    block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES] = (KIDS_TITLE_CLOSE >> 8) & 0xff;
    block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 1] = KIDS_TITLE_CLOSE & 0xff;
    if (KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 2 !== TITLE_OFFSET + TITLE_LENGTH) {
        throw new Error("the title no longer ends flush with its 0x40 bytes");
    }
    for (let i = 0; i < 16; i++) putU16le(block, CLUT_OFFSET + i * 2, icon.clut[i] ?? 0);
    block.set(icon.pixels.subarray(0, 0x80), TITLE_FRAME_SIZE);

    const gfx = compress(graphics);
    const dat = compress(data);
    const round = (n) => Math.ceil(n / 0x80) * 0x80;
    const dataOffset = KIDS_FIRST_SECTION + round(gfx.length);
    const tailOffset = dataOffset + round(dat.length);
    const end = tailOffset + KIDS_TAIL_SIZE;
    if (end > KIDS_BLOCK_SIZE) {
        throw new Error(
            `the game does not fit a memory-card file: graphics pack to ${gfx.length} bytes and data to ${dat.length}, ` +
                `${end - KIDS_BLOCK_SIZE} bytes over the ${KIDS_BLOCK_SIZE} a Kids! save holds`,
        );
    }
    block.set(gfx, KIDS_FIRST_SECTION);
    block.set(dat, dataOffset);
    block.set(tail, tailOffset);
    const seal = sealKidsTable(block, { graphics: gfx.length, data: dat.length });
    if (!seal.consistent || !seal.checksums.ok) throw new Error("the block's own directory does not verify after sealing");
    const back = parseKidsSave(block);
    if (back.errors.length) throw new Error(`the block does not read back: ${back.errors.map((e) => e.message).join("; ")}`);
    for (const [label, want, got] of [["graphics", graphics, back.graphics], ["data", data, back.data]]) {
        if (!got || got.length !== want.length) throw new Error(`the ${label} section does not decompress to its size`);
        for (let i = 0; i < want.length; i++) {
            if (got[i] !== want[i]) throw new Error(`the ${label} section differs at 0x${i.toString(16)} after the round trip`);
        }
    }
    return { block, seal, sizes: { graphics: gfx.length, data: dat.length } };
}

/** The factory tail: the 1000..100 ladder with dotted names, then the options. */
export function factoryKidsTail() {
    const tail = new Uint8Array(KIDS_TAIL_SIZE);
    for (let i = 0; i < KIDS_HISCORE_COUNT; i++) {
        const at = i * KIDS_HISCORE_SIZE;
        putU32le(tail, at, (KIDS_HISCORE_COUNT - i) * 100);
        tail[at + 5] = KIDS_FACTORY_LEVEL;
        tail.fill(KIDS_HISCORE_NAME_PAD, at + 8, at + 16);
    }
    tail.set(KIDS_FACTORY_OPTIONS, KIDS_OPTIONS_OFFSET);
    return tail;
}

// --- the assembler --------------------------------------------------------------------

/**
 * Build the graphics, data and tail of a Kids! save from a level record and
 * its art.
 *
 * `art` maps atlas frame names to {w, h, rgba}. Options: `name` (the game's
 * name, over the level's), `title1` / `title2` ({w, h, rgba} logos for the two
 * title blocks), `backgroundSet` (1..38, one of the disc's backdrops behind
 * every stage; 0 or omitted for none), `horizontal` (refused: the writer lays
 * out vertical games and says so).
 *
 * Returns {graphics, data, tail, name, icon, warnings, report}.
 */
export function buildKidsGameFromLevel(level, art, options = {}) {
    const opts = { name: null, title1: null, title2: null, backgroundSet: 0, horizontal: false, ...options };
    const warnings = [];
    const warn = (m) => warnings.push(m);

    const artMap = new Map();
    for (const [k, v] of Object.entries(art || {})) {
        if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
    }
    const lookup = (n) => (n ? artMap.get(decodeFrameKey(n)) || null : null);

    let stages = levelStages(level);
    if (!stages.length) throw new Error("the level has no stage with an enemylist");
    if (stages.length > KIDS_STAGES) {
        warn(`level has ${stages.length} stages; a Kids! save holds ${KIDS_STAGES} — dropped the rest`);
        stages = stages.slice(0, KIDS_STAGES);
    }
    if (opts.horizontal) warn("the grid is horizontal; a Kids! game is written as a vertical one here — enemies come down the screen");
    const enemyData = level.enemyData || {};
    const bossData = level.bossData || {};
    const bank = new KidsCellBank();
    const fullWarned = new Set();
    const bankFrame = (indexed, w, h, what) => {
        try {
            return bank.addFrame(indexed, w, h);
        } catch (e) {
            if (!(e instanceof KidsBankFullError)) throw e;
            if (!fullWarned.has(what)) {
                fullWarned.add(what);
                warn(`CG pages full (${KIDS_CELL_COUNT} cells): ${what} art left unpainted`);
            }
            return null;
        }
    };
    const fitIndexed = (frame, w, h) => quantizeKidsFrame(fitRgba(frame, w, h));

    const data = new Uint8Array(KIDS_DATA_SIZE);
    const putWords = (at, list) => { for (let i = 0; i < list.length; i++) putU16le(data, at + i * 2, list[i]); };

    // MAP: the initialiser's blank everywhere a chip is not placed.
    for (let i = 0; i < KIDS_REGION.map.length; i += 2) putU16le(data, KIDS_REGION.map.offset + i, KIDS_MAP_FILL);

    // --- the ship, first: it is the one thing every game draws ---
    // The level's own frames, else Duke, who ships with the engine — the
    // Saturn writer's fallback, so a card is never flown by an invisible ship.
    let shipSource = "level";
    let shipFrames = ((level.playerData && level.playerData.texture) || []).map(lookup).filter(Boolean);
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }
    const shipWords = new Uint16Array(KIDS_SHIP_TABLE_WORDS).fill(KIDS_BLANK);
    const poseWords = (frame) => {
        if (!frame) return new Uint16Array(4).fill(KIDS_BLANK);
        return bankFrame(fitIndexed(frame, 32, 32), 32, 32, "player") || new Uint16Array(4).fill(KIDS_BLANK);
    };
    const centre = shipFrames[0] || null;
    const bank0 = shipFrames.length > 1 ? shipFrames[1] : centre;
    const poses = [poseWords(bank0), poseWords(centre), poseWords(bank0 ? hflipRgba(fitRgba(bank0, 32, 32)) : null)];
    for (const ship of [KIDS_SHIP_LAYOUT.ship1, KIDS_SHIP_LAYOUT.ship2]) {
        ship.poses.forEach((at, i) => shipWords.set(poses[i], at));
    }
    // The shot: the level's normal shot stood on end (the runtime draws it
    // travelling right), as four 16x16 animation frames; the bomb: the first
    // four blast rings in the 8x2 strip the composer reads.
    const pd = level.playerData || {};
    const shotArt = [];
    for (const mode of ["shootNormal", "shoot3way", "shootBig"]) {
        const tex = pd[mode] && Array.isArray(pd[mode].texture) ? pd[mode].texture : [];
        for (const f of tex.map(lookup).filter(Boolean)) {
            if (shotArt.some((s) => s.key === f.key)) continue;
            shotArt.push(f.w > f.h ? { ...rotateCcwRgba(f), key: f.key } : f);
        }
    }
    const shotFrames = spreadFrames(shotArt.length ? shotArt : [shotSprite(16, 16)], 4);
    const shotWords = shotFrames.map((f) => (bankFrame(fitIndexed(f, 16, 16), 16, 16, "player shot") || new Uint16Array([KIDS_BLANK]))[0]);
    const blastRings = blastFrames(32, KIDS_SHIP_LAYOUT.blast.frames);
    const blastCells = blastRings.map((f) => bankFrame(quantizeKidsFrame(f), 32, 32, "blast") || new Uint16Array(4).fill(KIDS_BLANK));
    for (const ship of [KIDS_SHIP_LAYOUT.ship1, KIDS_SHIP_LAYOUT.ship2]) {
        shotWords.forEach((w, i) => { shipWords[ship.shot + i] = w; });
        for (let f = 0; f < 4; f++) bombWords(ship.bomb, f).forEach((at, i) => { shipWords[at] = blastCells[f][i]; });
    }

    // --- bullets: the seven the records can name, from the level's zako shots ---
    const bulletArt = [];
    const usedLetters = new Set();
    for (const st of stages) for (const row of st.enemylist) for (const c of row) if (c !== "00") usedLetters.add(c.slice(0, -1));
    for (const letter of usedLetters) {
        const rec = enemyData[`enemy${letter}`];
        const tex = rec && rec.projectileData && Array.isArray(rec.projectileData.texture) ? rec.projectileData.texture : [];
        const frames = tex.map(lookup).filter(Boolean);
        if (frames.length && !bulletArt.some((b) => b[0].key === frames[0].key)) bulletArt.push(frames);
    }
    // A boss's second stage (its stage2 block) is its record 1, and the
    // weapons it brings are shot from the quads their art lands in, so they
    // join the pool after the boss's own.
    const bossSplits = new Map(); // stage index -> splitBossStage2(boss)
    for (let s = 0; s < stages.length; s++) {
        const b = bossData[`boss${s}`];
        if (!b) continue;
        for (const slot of ["bulletDataA", "projectileDataA", "bulletData", "projectileData", "bulletDataB", "projectileDataB", "bulletDataC", "projectileDataC"]) {
            const tex = b[slot] && Array.isArray(b[slot].texture) ? b[slot].texture : [];
            const frames = tex.map(lookup).filter(Boolean);
            if (frames.length && !bulletArt.some((x) => x[0].key === frames[0].key)) bulletArt.push(frames);
        }
        const split = splitBossStage2(b);
        if (!split) continue;
        bossSplits.set(s, split);
        for (const { weapon } of bossWeapons(split.second)) {
            const frames = weaponTextures(weapon).map(lookup).filter(Boolean);
            if (frames.length && !bulletArt.some((x) => x[0].key === frames[0].key)) bulletArt.push(frames);
        }
    }
    const bulletTints = [[255, 240, 120], [120, 200, 255], [255, 120, 200], [140, 255, 140], [255, 170, 60], [200, 200, 255], [255, 255, 255]];
    const bulletSlots = [];
    const quadOfArt = new Map(); // first frame key -> the quad that holds it
    for (let q = 0; q < KIDS_SHIP_LAYOUT.bullets.count; q++) {
        const frames = bulletArt.length ? bulletArt[q % bulletArt.length] : [shotSprite(16, 16, bulletTints[q])];
        if (bulletArt.length && !quadOfArt.has(frames[0].key)) quadOfArt.set(frames[0].key, q);
        const chosen = spreadFrames(frames, KIDS_SHIP_LAYOUT.bullets.frames);
        const out = chosen.map((f) => (bankFrame(fitIndexed(f, 16, 16), 16, 16, "enemy bullet") || new Uint16Array([KIDS_BLANK]))[0]);
        shipWords.set(out, KIDS_SHIP_LAYOUT.bullets.at + q * KIDS_SHIP_LAYOUT.bullets.frames);
        bulletSlots.push(frames[0].key || "procedural");
    }

    // --- the blast (its six frames in the composer's interleaved order) and the item icons ---
    blastCells.forEach((cells, f) => blastWords(f).forEach((at, i) => { shipWords[at] = cells[i]; }));
    // The item icons: the stock emblems where the art has them, the ship as
    // the extra life, coins for the points, and only then a coloured square.
    const itemSources = KIDS_ITEM_SLOTS.map((slot, i) => {
        let frame = null, source = null;
        for (const name of slot.frames) {
            const f = lookup(name);
            if (f) { frame = f; source = f.key; break; }
        }
        if (!frame && slot.fallback === "ship" && centre) { frame = centre; source = "ship"; }
        if (!frame && slot.fallback === "coin") { frame = coinSprite(11); source = "coin"; }
        if (!frame && slot.fallback === "bigCoin") { frame = coinSprite(14); source = "coin"; }
        if (!frame) { frame = itemIcon(slot.type); source = "square"; }
        const w = bankFrame(fitIndexed(frame, 16, 16), 16, 16, "items") || new Uint16Array([KIDS_BLANK]);
        shipWords[KIDS_SHIP_LAYOUT.items.at + i] = w[0];
        return source;
    });

    // --- per stage ---
    const built = stages.map((st, s) => {
        const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : (level.width || 8));
        const spawnRows = st.enemylist.slice().reverse();
        const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
        const appear = new Uint8Array(KIDS_APPEAR_STAGE_BYTES);
        const counts = KIDS_APPEAR_CLASSES.map(() => 0);
        // A record per enemy letter AND drop digit, as the Saturn writer does:
        // a Kids! record drops one item, and the grid's "B1" here and "B0"
        // there are two records sharing one strip. The most used letters,
        // and within a letter the most used digits, claim records first.
        const records = new Map(); // "A1" -> {klass, id, bytes, name, strip, item}
        const usage = new Map(); // letter -> {count, digits: Map digit -> count}
        for (const row of spawnRows) {
            for (const cell of row) {
                if (!cell || cell === "00") continue;
                const letter = cell.slice(0, -1), digit = cell.slice(-1);
                if (!usage.has(letter)) usage.set(letter, { count: 0, digits: new Map() });
                const u = usage.get(letter);
                u.count++;
                u.digits.set(digit, (u.digits.get(digit) || 0) + 1);
            }
        }
        const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) {
                warn(`${st.key}: grid names enemy${letter} but enemyData has no such record — cells left empty`);
                continue;
            }
            const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas — placed invisible`);
            const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
            const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
            if (frames.length && (maxW > 64 || maxH > 64)) {
                warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; zako art tops out at 64x64 — downscaled`);
            }
            const artClass = kidsClassFor(maxW, maxH);
            const strips = new Map(); // klass -> the strip words, banked once per class the letter lands in
            const stripFor = (klass) => {
                if (strips.has(klass)) return strips.get(klass);
                const strip = KIDS_SPRITE_STRIPS[klass];
                const bw = strip.w * CG_CELL, bh = strip.h * CG_CELL;
                const stripWords = new Uint16Array(KIDS_SPRITE_ENTRY_WORDS).fill(KIDS_BLANK);
                spreadFrames(frames, strip.frames).forEach((f, fi) => {
                    const cells = bankFrame(fitIndexed(f, bw, bh), bw, bh, `enemy${letter}`);
                    if (!cells) return;
                    for (let cy = 0; cy < strip.h; cy++) {
                        for (let cx = 0; cx < strip.w; cx++) stripWords[cy * strip.stripW + fi * strip.w + cx] = cells[cy * strip.w + cx];
                    }
                });
                strips.set(klass, stripWords);
                return stripWords;
            };
            const speed = (Number.isFinite(rec.speed) ? rec.speed : 1) * RUNTIME_TO_KIDS_SPEED;
            const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 1);
            const interval = Number(rec.interval);
            const fires = Number.isFinite(interval) && interval > 0;
            const timing = !fires ? 0 : interval >= 90 ? 1 : interval >= 45 ? 2 : 3;
            const proj = rec.projectileData && Array.isArray(rec.projectileData.texture) ? rec.projectileData.texture[0] : null;
            const bulletKey = proj ? (lookup(proj) || {}).key : null;
            const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
            let first = null; // the record the most common digit got
            for (const digit of digits) {
                let klass = artClass;
                while (klass < KIDS_APPEAR_CLASSES.length && counts[klass] >= KIDS_APPEAR_CLASSES[klass].count) klass++;
                const item = KIDS_ITEM_FOR_DROP[digit] || 0;
                if (klass >= KIDS_APPEAR_CLASSES.length) {
                    if (first) {
                        warn(`${st.key}: enemy${letter} carries several drop digits and the stage is out of records — its drop-${digit} cells drop ${first.item ? KIDS_ITEM_SLOTS[first.item - 1].name : "nothing"} instead`);
                        records.set(letter + digit, first);
                    } else {
                        warn(`${st.key}: no free record for enemy${letter} (${rec.name || "?"}) — a stage holds 16 + 8 + 8 + 8 — cells left empty`);
                    }
                    continue;
                }
                const id = counts[klass]++;
                // Hardness 3 is "max, not counted"; a finite hp picks among the
                // three counted ones of this class's table.
                const hardness = hits === Infinity ? 3 : nearestIndex(KIDS_HP_TABLES[klass].slice(0, 3), hits * KIDS_SHOT_UNITS);
                const scoreTier = nearestIndex(KIDS_SCORE_TABLES[klass], Number(rec.score) || KIDS_SCORE_TABLES[klass][1]);
                const bytes = encodeKidsRecord({
                    movement: KIDS_MOVE_STRAIGHT,
                    variant: nearestIndex(KIDS_STRAIGHT_SPEEDS, speed),
                    hardness,
                    scoreTier,
                    bullet: bulletKey && quadOfArt.has(bulletKey) ? quadOfArt.get(bulletKey) : 0,
                    timing,
                    animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex(KIDS_ANIM_INTERVALS, 60 / rec.frameRate) : 1,
                    aim: fires,
                    item,
                });
                const entry = { klass, id, bytes, name: rec.name || `enemy${letter}`, letter, digit, strip: stripFor(klass), frames: frames.length, item };
                records.set(letter + digit, entry);
                if (!first) first = entry;
            }
        }

        // Placement. The anchor is the top-left cell on screen; the rest of the
        // rectangle is stamped with the editor's footprint marks, which a
        // vertical game lays at `anchor + dx - 9*dy` (KIDS.EXE 0x8008A3D0).
        const cellAt = (row, col) => row * KIDS_APPEAR_COLUMNS + col;
        const rectFree = (row, col, w, h) => {
            for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) {
                    const r = row - dy, c = col + dx;
                    if (r < 0 || r >= KIDS_APPEAR_ROWS || c < 0 || c >= KIDS_APPEAR_COLUMNS) return false;
                    if (appear[cellAt(r, c)]) return false;
                }
            }
            return true;
        };
        const stamp = (row, col, w, h, byte) => {
            for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) {
                    appear[cellAt(row - dy, col + dx)] = dx === 0 && dy === 0
                        ? byte
                        : (KIDS_APPEAR_FOOTPRINT_CLASS << 4) | (dx << 2) | dy;
                }
            }
        };
        let placed = 0, dropped = 0, lastRow = KIDS_FIRST_SPAWN_ROW;
        spawnRows.forEach((row, k) => {
            const scrollRow = waveRows
                ? clamp(Math.round(waveRows[k] / 2), 0, KIDS_MAX_SPAWN_ROW)
                : Math.min(KIDS_MAX_SPAWN_ROW, KIDS_FIRST_SPAWN_ROW + k * KIDS_ROW_STEP);
            row.forEach((cell, c) => {
                if (!cell || cell === "00") return;
                const rec = records.get(cell);
                if (!rec) return;
                const [w, h] = KIDS_APPEAR_CELLS[rec.klass];
                const col = mapKidsColumn(c, width, w);
                const r = Math.max(scrollRow, h - 1);
                let at = null;
                for (const dc of [0, 1, -1, 2, -2]) {
                    const cc = col + dc;
                    if (cc < KIDS_FIRST_VISIBLE_COLUMN || cc + w - 1 > KIDS_FIRST_VISIBLE_COLUMN + KIDS_VISIBLE_COLUMNS - 1) continue;
                    if (rectFree(r, cc, w, h)) { at = cc; break; }
                }
                if (at === null) { dropped++; return; }
                stamp(r, at, w, h, KIDS_APPEAR_PRESENT | (rec.klass << 4) | rec.id);
                placed++;
                lastRow = Math.max(lastRow, r);
            });
        });
        if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} overlapped another enemy's cells and ${dropped === 1 ? "was" : "were"} left out`);

        // The boss: its art in the 8x8 grid for both phases (a boss is two
        // records, two phases, and its total hit points are both; an unpainted
        // second phase is an invisible one), the sample bosses' movement and
        // weapons for its size, the 0xC0 anchor a few rows past the last wave
        // with the scroll halted under it.
        //
        // A boss with a stage2 block is the format's own two phases, written
        // as the runtime flies them (FORMAT-PSX.md "A boss's second stage"):
        // record 0 and the sprite table at +0x500 are the boss, record 1 and
        // +0x580 its second stage — its own size class, art, score and
        // weapons — and the hit points split at the line, since the cart
        // changes phase when the total falls below record 1's. Each phase's
        // weapons shoot the quads their own art landed in.
        let boss = null;
        const bossWords = [new Uint16Array(KIDS_SPRITE_BOSS_WORDS).fill(KIDS_BLANK), new Uint16Array(KIDS_SPRITE_BOSS_WORDS).fill(KIDS_BLANK)];
        const bossRecords = [Uint8Array.from(KIDS_BOSS_DEFAULT), Uint8Array.from(KIDS_BOSS_DEFAULT)];
        const split = bossSplits.get(s) || null;
        const bossRec = split ? split.first : bossData[`boss${s}`];
        if (bossRec && split) {
            const phases = [split.first, split.second].map((rec, phase) => {
                const frames = bossBodyFrames(rec).map(lookup).filter(Boolean);
                const label = phase ? `${rec.name || "?"} stage 2` : rec.name || "?";
                const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
                const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
                const sizeClass = kidsBossClassFor(maxW, maxH);
                const [aw, ah] = KIDS_BOSS_ART_CELLS[sizeClass];
                if (frames.length && (maxW > aw * CG_CELL || maxH > ah * CG_CELL)) {
                    warn(`${st.key}: boss (${label}) is ${maxW}x${maxH}; its art is ${aw * CG_CELL}x${ah * CG_CELL} — downscaled`);
                }
                if (!frames.length) warn(`${st.key}: boss (${label}) has no art in the atlas — its sprite is unpainted`);
                if (frames.length) {
                    const cells = bankFrame(fitIndexed(frames[0], aw * CG_CELL, ah * CG_CELL), aw * CG_CELL, ah * CG_CELL, `boss${s}`);
                    if (cells) for (let cy = 0; cy < ah; cy++) for (let cx = 0; cx < aw; cx++) bossWords[phase][cy * KIDS_BOSS_GRID + cx] = cells[cy * aw + cx];
                }
                const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 50);
                const hpClass = hits === Infinity ? 3 : nearestIndex(KIDS_BOSS_HP, hits * KIDS_SHOT_UNITS);
                const scoreClass = nearestIndex(KIDS_BOSS_SCORE, Number(rec.score) || KIDS_BOSS_SCORE[1]);
                const behaviour = KIDS_BOSS_BEHAVIOUR[sizeClass];
                const weapons = kidsBossWeapons(behaviour.weapons, rec, (n) => {
                    const f = lookup(n);
                    return f && quadOfArt.has(f.key) ? quadOfArt.get(f.key) : null;
                });
                bossRecords[phase] = encodeKidsBoss({ ...behaviour, weapons, sizeClass, hpClass, scoreClass });
                return { sizeClass, frames: frames.length, hits, hpClass, bullets: weapons.map((w) => w.bullet) };
            });
            const sizeClass = Math.max(phases[0].sizeClass, phases[1].sizeClass);
            const [fw, fh] = KIDS_BOSS_FOOTPRINT[sizeClass];
            let row = Math.min(KIDS_APPEAR_ROWS - 1, Math.max(lastRow + KIDS_BOSS_ROW_GAP, fh - 1));
            const col = KIDS_BOSS_COLUMN[sizeClass];
            while (row < KIDS_APPEAR_ROWS && !rectFree(row, col, fw, fh)) row++;
            if (row >= KIDS_APPEAR_ROWS) {
                warn(`${st.key}: no room left for the boss past the last wave — it is left out`);
            } else {
                stamp(row, col, fw, fh, KIDS_APPEAR_PRESENT | (KIDS_APPEAR_BOSS_CLASS << 4));
                const [p1, p2] = phases;
                boss = {
                    name: bossRec.name || `boss${s}`,
                    sizeClass: p1.sizeClass,
                    row,
                    col,
                    frames: p1.frames,
                    hits: p1.hits,
                    hpClass: p1.hpClass,
                    bullets: p1.bullets,
                    stage2: { sizeClass: p2.sizeClass, frames: p2.frames, hits: p2.hits, hpClass: p2.hpClass, bullets: p2.bullets, hpBelow: split.hpBelow },
                };
                lastRow = Math.max(lastRow, row);
            }
        } else if (bossRec) {
            const names = bossRec.anim && Array.isArray(bossRec.anim.idle)
                ? [...bossRec.anim.idle, ...(Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : [])]
                : Array.isArray(bossRec.texture) ? bossRec.texture : [];
            const frames = names.map(lookup).filter(Boolean);
            const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
            const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
            const sizeClass = kidsBossClassFor(maxW, maxH);
            const [aw, ah] = KIDS_BOSS_ART_CELLS[sizeClass];
            if (frames.length && (maxW > aw * CG_CELL || maxH > ah * CG_CELL)) {
                warn(`${st.key}: boss (${bossRec.name || "?"}) is ${maxW}x${maxH}; its art is ${aw * CG_CELL}x${ah * CG_CELL} — downscaled`);
            }
            if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas — its sprite is unpainted`);
            // Phase 1 draws the first frame, phase 2 the second (or the first again).
            const phaseFrames = frames.length ? [frames[0], frames[1] || frames[0]] : [];
            phaseFrames.forEach((f, phase) => {
                const cells = bankFrame(fitIndexed(f, aw * CG_CELL, ah * CG_CELL), aw * CG_CELL, ah * CG_CELL, `boss${s}`);
                if (!cells) return;
                for (let cy = 0; cy < ah; cy++) for (let cx = 0; cx < aw; cx++) bossWords[phase][cy * KIDS_BOSS_GRID + cx] = cells[cy * aw + cx];
            });
            const hits = bossRec.hp === "infinity" ? Infinity : Math.max(1, Number(bossRec.hp) || 100);
            // Each phase takes half the hits; the class is the nearest per-phase value.
            const hpClass = hits === Infinity ? 3 : nearestIndex(KIDS_BOSS_HP, (hits / 2) * KIDS_SHOT_UNITS);
            const scoreClass = nearestIndex(KIDS_BOSS_SCORE, Number(bossRec.score) || KIDS_BOSS_SCORE[1]);
            const behaviour = KIDS_BOSS_BEHAVIOUR[sizeClass];
            for (let phase = 0; phase < 2; phase++) {
                bossRecords[phase] = encodeKidsBoss({ ...behaviour, sizeClass, hpClass, scoreClass });
            }
            const [fw, fh] = KIDS_BOSS_FOOTPRINT[sizeClass];
            let row = Math.min(KIDS_APPEAR_ROWS - 1, Math.max(lastRow + KIDS_BOSS_ROW_GAP, fh - 1));
            const col = KIDS_BOSS_COLUMN[sizeClass];
            while (row < KIDS_APPEAR_ROWS && !rectFree(row, col, fw, fh)) row++;
            if (row >= KIDS_APPEAR_ROWS) {
                warn(`${st.key}: no room left for the boss past the last wave — it is left out`);
            } else {
                stamp(row, col, fw, fh, KIDS_APPEAR_PRESENT | (KIDS_APPEAR_BOSS_CLASS << 4));
                boss = { name: bossRec.name || `boss${s}`, sizeClass, row, col, frames: frames.length, hits, hpClass };
                lastRow = Math.max(lastRow, row);
            }
        }

        // Scenery: 32x32 chips cut four cells at a time from the level's
        // scenery grid (BG_COLS = 14 cells of 16 px = 7 chips; rows pair up).
        let chips = 0;
        const mapWords = new Uint16Array(KIDS_MAP_COLUMNS * KIDS_MAP_ROWS).fill(KIDS_MAP_FILL);
        const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
        if (st.background && st.background.tiles && cellsList) {
            try {
                const bytes = b64ToBytes(st.background.tiles);
                const cols = st.background.cols || 14;
                const tiles = new Uint16Array(bytes.length >> 1);
                for (let i = 0; i < tiles.length; i++) tiles[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
                const rows = Math.floor(tiles.length / cols);
                const cellRgba = new Map(); // ordinal -> RGBA or null
                const cellOf = (ordinal) => {
                    if (!cellRgba.has(ordinal)) {
                        const f = lookup(cellsList[ordinal]);
                        cellRgba.set(ordinal, f ? fitRgba(f, CG_CELL, CG_CELL) : null);
                    }
                    return cellRgba.get(ordinal);
                };
                const chipRgba = new Uint8Array(32 * 32 * 4);
                const firstCol = Math.max(0, Math.floor((cols - KIDS_MAP_COLUMNS * 2) / 2));
                let chipsFull = false;
                for (let cr = 0; cr < Math.min(KIDS_MAP_ROWS, Math.ceil(rows / 2)) && !chipsFull; cr++) {
                    for (let cc = 0; cc < KIDS_MAP_COLUMNS; cc++) {
                        chipRgba.fill(0);
                        let any = false;
                        for (let dy = 0; dy < 2; dy++) {
                            for (let dx = 0; dx < 2; dx++) {
                                const r = cr * 2 + dy, c = firstCol + cc * 2 + dx;
                                if (r >= rows || c >= cols) continue;
                                const w = tiles[r * cols + c];
                                if (w === 0xffff) continue;
                                const f = cellOf(w & 0x3ff);
                                if (!f) continue;
                                const hf = (w & 0x8000) !== 0, vf = (w & 0x4000) !== 0;
                                for (let y = 0; y < CG_CELL; y++) {
                                    for (let x = 0; x < CG_CELL; x++) {
                                        const sx = hf ? CG_CELL - 1 - x : x, sy = vf ? CG_CELL - 1 - y : y;
                                        const si = (sy * CG_CELL + sx) * 4, di = ((dy * CG_CELL + y) * 32 + dx * CG_CELL + x) * 4;
                                        chipRgba[di] = f.rgba[si];
                                        chipRgba[di + 1] = f.rgba[si + 1];
                                        chipRgba[di + 2] = f.rgba[si + 2];
                                        chipRgba[di + 3] = f.rgba[si + 3];
                                        any = true;
                                    }
                                }
                            }
                        }
                        if (!any) continue;
                        try {
                            const word = bank.addChip(quantizeKidsFrame({ w: 32, h: 32, rgba: chipRgba }));
                            mapWords[cr * KIDS_MAP_COLUMNS + cc] = word;
                            if (word !== KIDS_MAP_FILL) chips++;
                        } catch (e) {
                            if (!(e instanceof KidsBankFullError)) throw e;
                            warn(`${st.key}: CG pages full (${KIDS_CELL_COUNT} cells) — scenery past chip row ${cr} left unpainted`);
                            chipsFull = true;
                            break;
                        }
                    }
                }
            } catch (e) {
                warn(`${st.key}: could not read the background grid (${e.message}) — scenery skipped`);
            }
        }

        // Scroll: run to the boss and halt under it — or, with no boss, halt a
        // screen past the last wave: a halted scroll with nothing left alive
        // on screen is what ends a stage (GAMES.bin 0x8011C2F4).
        const scroll = new Uint8Array(KIDS_SCROLL_STAGE_BYTES);
        const haltRow = boss ? boss.row : Math.min(KIDS_APPEAR_ROWS - 1, lastRow + KIDS_BOSS_ROW_GAP);
        const haltUnit = Math.floor((haltRow * 32) / KIDS_SCROLL_UNIT_PIXELS);
        for (let u = 0; u < KIDS_SCROLL_UNITS; u++) {
            const nibble = u < haltUnit ? KIDS_SCROLL_RUN : KIDS_SCROLL_HALT;
            if (u & 1) scroll[u >> 1] |= nibble << 4;
            else scroll[u >> 1] |= nibble;
        }
        return { key: st.key, appear, records, bossWords, bossRecords, boss, mapWords, chips, scroll, placed, dropped, lastRow };
    });

    // --- the two title pictures (the logo, then the subtitle) ---
    let title = "none";
    for (const [art, t] of [[opts.title1, KIDS_SHIP_LAYOUT.title1], [opts.title2, KIDS_SHIP_LAYOUT.title2]]) {
        if (!art || !art.rgba) continue;
        const w = bankFrame(fitIndexed(art, t.w * CG_CELL, t.h * CG_CELL), t.w * CG_CELL, t.h * CG_CELL, "title");
        if (w) { shipWords.set(w, t.at); title = "uploaded"; }
    }

    // --- lay the data section out ---
    const stageCount = built.length;
    built.forEach((b, s) => {
        putWords(KIDS_REGION.map.offset + s * KIDS_MAP_STAGE_BYTES, b.mapWords);
        data.set(b.scroll, KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES);
        data.set(b.appear, KIDS_REGION.appear.offset + s * KIDS_APPEAR_STAGE_BYTES);
        const recBase = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
        for (const r of new Set(b.records.values())) data.set(r.bytes, recBase + (KIDS_CLASS_BASE[r.klass] + r.id) * KIDS_RECORD_SIZE);
        b.bossRecords.forEach((rec, i) => data.set(rec, recBase + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE));
        const sprBase = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
        for (let i = 0; i < KIDS_SPRITE_STAGE_BYTES; i += 2) putU16le(data, sprBase + i, KIDS_BLANK);
        for (const r of new Set(b.records.values())) {
            putWords(sprBase + KIDS_SPRITE_CLASS_OFFSETS[r.klass] + r.id * KIDS_SPRITE_ENTRY_WORDS * 2, r.strip);
        }
        b.bossWords.forEach((w, i) => putWords(sprBase + KIDS_SPRITE_BOSS_OFFSETS[i], w));
    });
    // Stages past the last: blank sprite tables too, so nothing stale draws.
    for (let s = stageCount; s < KIDS_STAGES; s++) {
        const sprBase = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
        for (let i = 0; i < KIDS_SPRITE_STAGE_BYTES; i += 2) putU16le(data, sprBase + i, KIDS_BLANK);
        const recBase = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
        for (let i = 0; i < 2; i++) data.set(KIDS_BOSS_DEFAULT, recBase + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE);
        data.fill(KIDS_SCROLL_RUN | (KIDS_SCROLL_RUN << 4), KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES, KIDS_REGION.scroll.offset + (s + 1) * KIDS_SCROLL_STAGE_BYTES);
    }
    putWords(KIDS_REGION.ship.offset, shipWords);

    // CONFIG over the template.
    const config = Uint8Array.from(KIDS_CONFIG_TEMPLATE);
    config[0] = 0x00; // vertical
    const backgroundSet = Number.isInteger(opts.backgroundSet) ? clamp(opts.backgroundSet, 0, KIDS_BACKGROUND_SETS) : 0;
    for (let s = 0; s < KIDS_STAGES; s++) {
        config[3 + s] = s === stageCount - 1 ? KIDS_CONFIG_LAST_STAGE : 0;
        config[KIDS_CONFIG_MOTION_OFFSET + s] = s < stageCount ? KIDS_MOTION_DEFAULT | (backgroundSet ? KIDS_MOTION_BACKGROUND : 0) : 0;
        config[KIDS_CONFIG_BACKGROUND_OFFSET + s] = s < stageCount ? backgroundSet : 0;
    }
    // Sound: the template's game entries, then its stage pairs cycled over ours.
    const templateStagePairs = 6;
    for (let s = 0; s < KIDS_STAGES; s++) {
        for (let k = 0; k < 2; k++) {
            const at = KIDS_CONFIG_SOUND_OFFSET + (4 + s * 2 + k) * 4;
            if (s < stageCount) {
                const from = KIDS_CONFIG_SOUND_OFFSET + (4 + (s % templateStagePairs) * 2 + k) * 4;
                config.set(KIDS_CONFIG_TEMPLATE.slice(from, from + 4), at);
            } else config.fill(0, at, at + 4);
        }
    }
    config[0x6f] = 0;
    data.set(config, KIDS_REGION.config.offset);

    const tail = factoryKidsTail();
    const name = kidsGameNameFor(opts.name ?? level.name);
    if (name.changed) warn(`the game is named "${name.text}" on the card: the title field holds ten ASCII characters`);
    const icon = encodeKidsIcon(centre || defaultKidsIcon());

    return {
        graphics: bank.graphics,
        data,
        tail,
        name,
        icon,
        warnings,
        report: {
            name: name.text,
            stages: built.map((b) => ({
                key: b.key,
                placements: b.placed,
                dropped: b.dropped,
                records: [...new Set(b.records.values())].map((r) => ({ name: r.name, cell: r.letter + r.digit, klass: r.klass, id: r.id, frames: r.frames, ...(r.item ? { item: KIDS_ITEM_SLOTS[r.item - 1].name } : {}) })),
                boss: b.boss
                    ? {
                        name: b.boss.name,
                        sizeClass: b.boss.sizeClass,
                        row: b.boss.row,
                        col: b.boss.col,
                        frames: b.boss.frames,
                        hpClass: b.boss.hpClass,
                        // A second stage: record 1, its class and bullets.
                        ...(b.boss.stage2 ? { bullets: b.boss.bullets, stage2: b.boss.stage2 } : {}),
                    }
                    : null,
                chips: b.chips,
                lastRow: b.lastRow,
            })),
            ship: shipSource,
            items: itemSources,
            bullets: bulletSlots,
            // The format's own two boss phases carry a stage2 block (boss-stage2.js).
            transform: built.some((b) => b.boss && b.boss.stage2) ? "native" : "none",
            title,
            backgroundSet,
            cells: { used: bank.used, chips: bank.chips, sprites: bank.sprites, shared: bank.shared, free: bank.free },
        },
    };
}

/** The file a Kids! card is downloaded as: a raw 128 KB image, ".mcr" as Mednafen names them. */
export function kidsCardFileName(name) {
    const clean = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "game";
    return `Dezaemon Kids - ${clean}.mcr`;
}

/**
 * The one-call export: a level record and its art -> the 128 KB memory card
 * holding the game as BISLPS-01503DEZAKIDS, ready for an emulator's slot 1.
 *
 * Returns {card, block, fileName, name, warnings, report}; `report.sizes` is
 * what the two sections packed to and `report.slack` the bytes to spare.
 */
export function exportLevelToKidsCard(level, art, options = {}) {
    const game = buildKidsGameFromLevel(level, art, options);
    const { block, seal, sizes } = buildKidsBlock({
        graphics: game.graphics,
        data: game.data,
        tail: game.tail,
        name: game.name.bytes,
        icon: game.icon,
    });
    const card = buildMemoryCard([{ filename: KIDS_PRODUCT, data: block }]);
    return {
        card,
        block,
        fileName: kidsCardFileName(game.name.text),
        name: game.name.text,
        warnings: game.warnings,
        report: { ...game.report, sizes, slack: seal.slack, end: seal.end },
    };
}
