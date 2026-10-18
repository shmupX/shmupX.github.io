// A level record -> a Dezaemon+ memory card: the raw-format counterpart of
// kids-write.js, for the 1996 PlayStation port of the Super Famicom Dezaemon.
//
// plus.js READS a save and plus-edit.js changes fields of one; this builds
// one from nothing. Dezaemon+ has no compression and no directory in the
// file — the 74-entry scatter/gather table in the program (PLUS_TABLE) says
// where everything sits — so the whole job is to fill fixed offsets and seal
// the nineteen group checksums the load routine verifies (sealPlusChecksums).
//
// What lands where (FORMAT-PSX.md, "Dezaemon+"):
//
//   GRAPHICS   two 256x256 4bpp texture pages, 512 tiles of 16x16, every tile
//              indexing ONE of the 24 palette rows — the map its stage's row,
//              enemies 6+stage, the boss 12+stage, the player 18, the title
//              19, shots 20. Each row is quantised to fifteen colours from
//              the art that will draw with it.
//   MAP        128 rows x 16 chips per stage (columns 0 and 15 empty, the
//              224-px playfield between), each chip a MAP GROUP index with
//              its own h-flip and a row-wide v-flip byte; MAP GROUP names the
//              tiles. The level's 16x16 scenery cells land 1:1; SCROLL
//              sequences the 32 four-row blocks over the 16,384-px stage.
//   APPEAR     256 records of 14 columns (16 px each) and a 1,024-entry table
//              mapping each 16 px of scroll to a record; a byte 0x80|n in
//              column k spawns definition n (by class nibble) at x = 16(k+1).
//   ENEMY DATA 60 eight-byte definitions, field for field as the reader
//              splits them (decodePlusEnemy's inverse), then the boss's 32.
//   GLOBAL     the title block (two 4x4 halves of an 8x4 tile block), the
//              item table, the three settings, the BGM assignment.
//   SOUND      sixteen empty songs; the BGM assignment names the disc's own.
//   HIGH SCORE the factory ladders; SETTINGS the factory bytes.
//   header     the program's own title text (there is no game name in a
//              Dezaemon+ save — the name is whatever the title logo says)
//              and an icon cut from the ship.
//
// The sprite sheets — the per-stage SPRITE LAYOUT + ENEMY GROUP the five
// spawn classes draw from, the boss's two 4x4 blocks, the title's, and the
// player's MY SHIP GROUP — follow MAIN.EXE's own blit and spawner routines,
// traced on the Select 100 disc and checked against its 106-game corpus
// (FORMAT-PSX.md "The sprite sheets"); every geometry constant below names
// the routine it came from.
//
// Environment-neutral ESM (Node + browser).

import { CG_CELL } from "../palette/deza2-palette.js";
import { colorHistogram, medianCut } from "../palette/palette-target.js";
import { decodeFrameKey, fitRgba, levelStages, spreadFrames } from "../write/game-to-save.js";
import { decodePlayerArt } from "../player-art.js";
import { bossBodyFrames, splitBossStage2 } from "../boss-stage2.js";
import {
    PLUS_ANIM_INTERVALS,
    PLUS_APPEAR_BOSS_NIBBLE,
    PLUS_APPEAR_END_MARK,
    PLUS_APPEAR_RECORD_SIZE,
    PLUS_APPEAR_RECORDS,
    PLUS_APPEAR_ROW_TABLE,
    PLUS_BLOCK_SIZE,
    PLUS_BOSS_OFFSET,
    PLUS_BOSS_SIZE,
    PLUS_ENEMY_HP,
    PLUS_ENEMY_SCORE,
    PLUS_ENEMY_SIZE,
    PLUS_GLOBAL_LAYOUT,
    PLUS_GLOBAL_OFFSET,
    PLUS_GRAPHICS_OFFSET,
    PLUS_GRAPHICS_SIZE,
    PLUS_HISCORE_COUNT,
    PLUS_HISCORE_OFFSET,
    PLUS_HISCORE_SIZE,
    PLUS_HISCORE_TABLE_BYTES,
    PLUS_HISCORE_TABLES,
    PLUS_MAP_HALVES,
    PLUS_MAP_ROW_BYTES,
    PLUS_MAP_ROWS,
    PLUS_PALETTE_OFFSET,
    PLUS_PALETTE_ROW_BYTES,
    PLUS_PALETTE_ROWS,
    PLUS_PRODUCT,
    PLUS_SETTINGS_OFFSET,
    PLUS_SONG_COUNT,
    PLUS_SONG_SIZE,
    PLUS_SOUND_OFFSET,
    PLUS_STAGE_PIECE,
    PLUS_STAGE_SIZE,
    PLUS_STAGES,
    PLUS_STAGES_OFFSET,
    PLUS_TILE_MAX,
    parsePlusSave,
    plusPaletteRow,
} from "./plus.js";
import { sealPlusChecksums } from "./plus-edit.js";
import { CLUT_OFFSET, TITLE_FRAME_SIZE, TITLE_OFFSET } from "./save-header.js";
import { buildMemoryCard } from "./memcard-write.js";
import { defaultKidsIcon, encodeKidsIcon, KIDS_ALPHA_CUTOFF } from "./kids-write.js";

// --- the tile bank -----------------------------------------------------------------------

/** The save's bitmap as tiles: 16 across, 32 down (two 256x256 pages). */
export const PLUS_TILE_COLS = 16;
export const PLUS_TILE_ROWS = 32;
export const PLUS_TILE_COUNT = PLUS_TILE_COLS * PLUS_TILE_ROWS; // 512
/**
 * Tiles a writer may fill: the last four of page 1 (words 0x1FC..0x1FF) stay
 * transparent, because the program forces the ship's words 61-63 to
 * 0x3FC..0x3FE and every blank cell is 0x3FF, and under the card-load pages
 * those alias to page 1's corner (MAIN.EXE 0x8001AF7C; FORMAT-PSX.md).
 */
export const PLUS_TILE_CAPACITY = PLUS_TILE_COUNT - 4; // 508
export const PLUS_ROW_PITCH = 128;
/**
 * The blank cell: tile 0x3FF, the convention of all 3,844 page-3 boss words
 * and 436 title words in the corpus. Also what an unused group slot holds
 * here (the corpus's 0xFFFF reaches a tile copier that leaves its source
 * pointer unset; the games tolerate it, a writer need not).
 */
export const PLUS_EMPTY_TILE = 0x3ff;
/** Global group words: bit 14 h-flip, bit 15 v-flip over a 10-bit tile. */
export const PLUS_GROUP_HFLIP = 0x4000;
export const PLUS_GROUP_VFLIP = 0x8000;
/** A SPRITE LAYOUT byte: bits 0-5 an ENEMY GROUP index, bit 6 h-flip, bit 7 v-flip (likely — the sample's mirrored pairs). */
export const PLUS_LAYOUT_HFLIP = 0x40;
export const PLUS_LAYOUT_VFLIP = 0x80;

/**
 * Tile n (0..511) as the 10-bit word MAP GROUP and the global groups carry:
 * bits 0-2 and 7 the column, 3-6 the row, 8 the page — the save's two pages
 * are the LOW page bit's two values on the memory-card load path.
 */
export function plusTileWord(n) {
    const col = n % PLUS_TILE_COLS;
    const row = Math.floor(n / PLUS_TILE_COLS) % 16;
    const half = n >= 256 ? 1 : 0;
    return (col & 7) | ((col & 8) << 4) | (row << 3) | (half << 8);
}

/** The tile number a 10-bit word names inside the save's own 512 (null past them). */
export function plusTileIndex(word) {
    const tile = Math.min(word & 0x3fff, PLUS_TILE_MAX);
    const col = (tile & 7) | ((tile & 0x80) >> 4);
    const row = (tile >> 3) & 0x0f;
    const page = (tile >> 8) & 3;
    if (page & 2) return null;
    return (page & 1) * 256 + row * PLUS_TILE_COLS + col;
}

export class PlusBankFullError extends Error {
    constructor(what) {
        super(`the graphics bank holds ${PLUS_TILE_CAPACITY} tiles and every one is taken (${what})`);
        this.name = "PlusBankFullError";
    }
}

function tileKey(t) {
    let s = "";
    for (let i = 0; i < t.length; i++) s += String.fromCharCode(t[i]);
    return s;
}

function flipTileH(t) {
    const out = new Uint8Array(256);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + x] = t[y * 16 + 15 - x];
    return out;
}

function flipTileV(t) {
    const out = new Uint8Array(256);
    for (let y = 0; y < 16; y++) out.set(t.subarray((15 - y) * 16, (16 - y) * 16), y * 16);
    return out;
}

/**
 * The 512-tile bank, each tile 256 palette indices 0..15 that mean colours
 * only through the row it was quantised for. Tiles are shared on identical
 * bytes; callers whose word has flip bits (`addFlippable`) share mirrors too.
 */
export class PlusTileBank {
    constructor() {
        this.tiles = [];
        this.byKey = new Map();
        this.shared = 0;
    }

    get used() {
        return this.tiles.length;
    }

    get free() {
        return PLUS_TILE_CAPACITY - this.tiles.length;
    }

    /** An all-zero tile is the empty word; otherwise the tile's number. */
    add(indices) {
        let blank = true;
        for (let i = 0; i < indices.length; i++) if (indices[i]) { blank = false; break; }
        if (blank) return null;
        const key = tileKey(indices);
        const hit = this.byKey.get(key);
        if (hit !== undefined) { this.shared++; return hit; }
        if (this.tiles.length >= PLUS_TILE_CAPACITY) throw new PlusBankFullError("a tile");
        const n = this.tiles.length;
        this.tiles.push(Uint8Array.from(indices));
        this.byKey.set(key, n);
        return n;
    }

    /** As add(), but a stored mirror serves: returns {tile, hflip, vflip} or null for blank. */
    addFlippable(indices) {
        let blank = true;
        for (let i = 0; i < indices.length; i++) if (indices[i]) { blank = false; break; }
        if (blank) return null;
        const hit = this.byKey.get(tileKey(indices));
        if (hit !== undefined) { this.shared++; return { tile: hit, hflip: false, vflip: false }; }
        const h = flipTileH(indices);
        const hv = flipTileV(h);
        const v = flipTileV(indices);
        for (const [bytes, hflip, vflip] of [[h, true, false], [v, false, true], [hv, true, true]]) {
            const m = this.byKey.get(tileKey(bytes));
            if (m !== undefined) { this.shared++; return { tile: m, hflip, vflip }; }
        }
        return { tile: this.add(indices), hflip: false, vflip: false };
    }

    /** The 0x10000-byte 4bpp bitmap, low nibble = left pixel. */
    toBitmap() {
        const out = new Uint8Array(PLUS_GRAPHICS_SIZE);
        this.tiles.forEach((t, n) => {
            const col = n % PLUS_TILE_COLS, row = Math.floor(n / PLUS_TILE_COLS);
            for (let y = 0; y < 16; y++) {
                const base = (row * 16 + y) * PLUS_ROW_PITCH + col * 8;
                for (let x = 0; x < 16; x += 2) out[base + (x >> 1)] = (t[y * 16 + x] & 15) | ((t[y * 16 + x + 1] & 15) << 4);
            }
        });
        return out;
    }
}

// --- palette rows ---------------------------------------------------------------------------

/** An opaque colour is stored with the STP bit set — every opaque entry of every sample row is. */
export const PLUS_OPAQUE = 0x8000;
export const PLUS_COLORS_PER_ROW = 15;

/**
 * One 16-entry palette row: colour 0 transparent, up to fifteen colours
 * median-cut from the frames that will draw with it. Build it from every
 * frame first (`consider`), then `index` each frame against the result.
 */
export class PlusPaletteRow {
    constructor(row) {
        this.row = row;
        this.frames = [];
        this.words = null;
        this.cands = null;
        this.cache = new Map();
    }

    consider(frame) {
        this.frames.push(frame);
    }

    build() {
        const hist = colorHistogram(this.frames);
        const chosen = medianCut(hist, PLUS_COLORS_PER_ROW);
        this.words = new Uint16Array(16);
        chosen.forEach((w, i) => { this.words[i + 1] = PLUS_OPAQUE | w; });
        this.cands = chosen.map((w, i) => ({ index: i + 1, r: w & 31, g: (w >> 5) & 31, b: (w >> 10) & 31 }));
        this.count = chosen.length;
        return this;
    }

    nearest(r8, g8, b8) {
        const key = ((r8 >> 3) << 10) | ((g8 >> 3) << 5) | (b8 >> 3);
        const hit = this.cache.get(key);
        if (hit !== undefined) return hit;
        const r = r8 >> 3, g = g8 >> 3, b = b8 >> 3;
        let best = 1, bestD = Infinity;
        for (const c of this.cands) {
            const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
            if (d < bestD) { bestD = d; best = c.index; }
        }
        if (!this.cands.length) best = 0;
        this.cache.set(key, best);
        return best;
    }

    /** An RGBA frame as w*h indices into this row (0 where transparent). */
    index(frame) {
        if (!this.words) this.build();
        const out = new Uint8Array(frame.w * frame.h);
        for (let i = 0; i < out.length; i++) {
            const o = i * 4;
            if (frame.rgba[o + 3] < KIDS_ALPHA_CUTOFF) continue;
            out[i] = this.nearest(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]);
        }
        return out;
    }
}

/** An indexed w x h frame (multiples of 16) as its 16x16 tiles, reading order. */
export function indexedTiles(indexed, w, h) {
    const cw = w / CG_CELL, ch = h / CG_CELL;
    const tiles = [];
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            const t = new Uint8Array(256);
            for (let y = 0; y < 16; y++) t.set(indexed.subarray((cy * 16 + y) * w + cx * 16, (cy * 16 + y) * w + cx * 16 + 16), y * 16);
            tiles.push(t);
        }
    }
    return tiles;
}

// --- the fixed pieces ------------------------------------------------------------------------

/**
 * The 64-byte title MAIN.EXE's template writes (table entry 1, RAM
 * 0x8005A284): デザエモン＋（プラス）　ユーザーゲームデータ in Shift-JIS, NUL
 * padded. plus.js identifies a save by this prefix, so it is written as is.
 */
export const PLUS_TITLE_BYTES = Object.freeze([
    0x83, 0x66, 0x83, 0x55, 0x83, 0x47, 0x83, 0x82, 0x83, 0x93, 0x81, 0x7b, 0x81, 0x69, 0x83, 0x76,
    0x83, 0x89, 0x83, 0x58, 0x81, 0x6a, 0x81, 0x40, 0x83, 0x86, 0x81, 0x5b, 0x83, 0x55, 0x81, 0x5b,
    0x83, 0x51, 0x81, 0x5b, 0x83, 0x80, 0x83, 0x66, 0x81, 0x5b, 0x83, 0x5e,
]);
/** The factory SETTINGS bytes (FORMAT-PSX.md; Athena's UPLOAD sample carries them too). */
export const PLUS_FACTORY_SETTINGS = Object.freeze([0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x08, 0x02]);
/** The factory ladder's name: eight dots, as the sample's two tables hold. */
export const PLUS_FACTORY_NAME = 0x2e;
/**
 * The global block's fixed pieces, as Athena's UPLOAD sample game sets them
 * (the disc's own game, split by section under UPLOAD/): the six title
 * entry animations, the seven item slots (weapon 5, option, power up,
 * weapon 1, speed up, weapon 2, bomb — all enabled), the score bonus index
 * and charge time, and the sixteen BGM assignments, which all name songs of
 * the disc's second bank (16..31) so a card with empty songs still has music.
 */
export const PLUS_TITLE_TYPE = Object.freeze([0x0a, 0x02]);
export const PLUS_ITEM_TABLE = Object.freeze([0x00, 0x00, 0x06, 0x01, 0x0b, 0x01, 0x09, 0x01, 0x02, 0x01, 0x0a, 0x01, 0x03, 0x01, 0x07, 0x01]);
export const PLUS_SCORE_BONUS_INDEX = 4;
export const PLUS_CHARGE_TIME = 2;
export const PLUS_BGM_ASSIGNMENT = Object.freeze([0x11, 0x12, 0x13, 0x14, 0x16, 0x16, 0x16, 0x17, 0x18, 0x16, 0x18, 0x1a, 0x10, 0x1c, 0x1d, 0x1b]);
/** The boss spawns from APPEAR column 5, as the sample does; the program ignores the column and starts it at x = 128. */
export const PLUS_BOSS_COLUMN = 5;
/** STAGE CONFIG's per-definition byte: rotation end angle (bits 5-7) and trigger (bits 3-4), moot for a definition that does not rotate. */
export const PLUS_STAGE_CONFIG_DEFAULT = 0x00;
/** SCROLL's effect byte: speed index 2 (1 px/frame) in bits 0-2, no wave, type 1 (the plain stage of the corpus). */
export const PLUS_SCROLL_EFFECT_DEFAULT = 0x42;

// --- definitions ---------------------------------------------------------------------------

/**
 * The five definition classes: APPEAR nibble, definition base and count, and
 * the art size (FORMAT-PSX.md "SCROLL, APPEAR, ENEMY DATA ...").
 */
export const PLUS_DEF_CLASSES = Object.freeze([
    Object.freeze({ nibble: 0x8, base: 0, count: 16, w: 16, h: 16, frames: 4 }),
    Object.freeze({ nibble: 0x9, base: 16, count: 16, w: 32, h: 16, frames: 2 }),
    Object.freeze({ nibble: 0xa, base: 32, count: 16, w: 16, h: 32, frames: 2 }),
    Object.freeze({ nibble: 0xb, base: 48, count: 8, w: 32, h: 32, frames: 2 }),
    Object.freeze({ nibble: 0xc, base: 56, count: 4, w: 64, h: 64, frames: 1 }),
]);
/**
 * The boss's picture: BOSS GROUP's two 4x4 blocks side by side (128x64) or,
 * with definition byte 6 bit 6 set, the left block above the right (64x128)
 * — MAIN.EXE 0x80030708 and 0x80030BCC.
 */
export const PLUS_BOSS_ART = Object.freeze({ horizontal: { w: 128, h: 64 }, vertical: { w: 64, h: 128 } });
/** Boss hit points per byte-13 index (MAIN.EXE table 0x8007B364) and score per byte-14 index (0x8007B328). */
export const PLUS_BOSS_HP = Object.freeze([2000, 4000, 8000, 12000, 16000, 18000, 24000, 32000]);
export const PLUS_BOSS_SCORE = Object.freeze([5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000]);
/** The 80-entry boss script table's bound and the 160-entry enemy one's (MAIN.EXE 0x80081864, 0x8007D760). */
export const PLUS_BOSS_SCRIPTS = 80;
export const PLUS_ENEMY_SCRIPTS = 160;
/** Scroll rows (16 px) a stage runs: 1,024 bands of the row table. */
export const PLUS_SCROLL_BANDS = PLUS_APPEAR_ROW_TABLE;
export const PLUS_FIRST_SPAWN_ROW = 8;
export const PLUS_ROW_STEP = 12;
export const PLUS_BOSS_ROW_GAP = 24;
export const PLUS_MAX_SPAWN_ROW = PLUS_SCROLL_BANDS - 64;
/** The fourteen spawn columns are the fourteen visible chip columns. */
export const PLUS_SPAWN_COLUMNS = PLUS_APPEAR_RECORD_SIZE; // 14
/** A Dezaemon+ px/frame against a runtime px/frame, the Saturn writer's ratio. */
export const RUNTIME_TO_PLUS_SPEED = 0.5;
/**
 * One basic shot's damage at the lowest power: 24 hit points (MAIN.EXE
 * 0x800253F4 -> 0x800250E4, collision 0x8001D2F8), so the enemy table
 * {1, 50, 100, 200, 400, 800, 1000, 2000} is 1 / 3 / 5 / 9 / 17 / 34 / 42 / 84
 * hits and the boss table 84 .. 1,334.
 */
export const PLUS_SHOT_DAMAGE = 24;
/**
 * Movement scripts 8..15 (MAIN.EXE 0x8007D760 -> 0x8007B3F4..) are a single
 * {forever, heading 0xC0 = down, no turn, speed} step at these px per frame;
 * scripts 0..7 ride the scroll (speed 0 with the ride bit). A script is the
 * whole of an enemy's path: the heading and turn fields of its definition
 * only rotate the picture (0x8001E9B0), never the velocity.
 */
export const PLUS_MOVE_STATIONARY = 0;
export const PLUS_MOVE_STRAIGHT_BASE = 8;
export const PLUS_STRAIGHT_SPEEDS = Object.freeze([0.5, 1, 1.5, 2, 2.5, 3, 4.5, 6]);

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

/** The definition class whose box holds w x h px art. */
export function plusClassFor(w, h) {
    for (let k = 0; k < PLUS_DEF_CLASSES.length; k++) {
        const c = PLUS_DEF_CLASSES[k];
        if (w <= c.w && h <= c.h) return k;
    }
    return PLUS_DEF_CLASSES.length - 1;
}

/** Level column -> spawn column 0..13; a wide enemy stops short of the right edge. */
export function mapPlusColumn(col, width, cellsWide = 1) {
    const last = PLUS_SPAWN_COLUMNS - cellsWide;
    if (width <= 1) return clamp(Math.floor((PLUS_SPAWN_COLUMNS - cellsWide) / 2), 0, last);
    return clamp(Math.round((col * (PLUS_SPAWN_COLUMNS - 1)) / (width - 1)), 0, last);
}

/**
 * One 8-byte enemy definition from named fields: the exact inverse of
 * decodePlusEnemy (plus.js), every index into the reader's own tables.
 */
export function encodePlusEnemy({
    movement = 0,
    shotPattern = 0,
    fireRate = 0,
    shotMode = 0,
    dropsItem = false,
    scaleRateIndex = 0,
    scalesX = false,
    scalesY = false,
    hpIndex = 0,
    scaleLimitAction = 0,
    hitFlags = 0,
    scoreIndex = 0,
    turnEndAction = 0,
    animIndex = 0,
    shotParameter = 0,
    depthGate = false,
    rotation = 0,
    endScaleIndex = 0,
    startScaleIndex = 0,
    startTrigger = 0,
    headingIndex = 0,
    turnRateIndex = 0,
} = {}) {
    const b = new Uint8Array(PLUS_ENEMY_SIZE);
    b[0] = movement & 0xff;
    b[1] = (shotPattern & 0x1f) | ((fireRate & 7) << 5);
    b[2] = (shotMode & 3) | (dropsItem ? 4 : 0) | ((scaleRateIndex & 7) << 3) | (scalesX ? 0x40 : 0) | (scalesY ? 0x80 : 0);
    b[3] = (hpIndex & 7) | ((scaleLimitAction & 3) << 3) | ((hitFlags & 7) << 5);
    b[4] = (scoreIndex & 7) | ((turnEndAction & 3) << 3) | ((animIndex & 7) << 5);
    b[5] = (shotParameter & 0x7f) | (depthGate ? 0x80 : 0);
    b[6] = (rotation & 3) | ((endScaleIndex & 7) << 2) | ((startScaleIndex & 7) << 5);
    b[7] = (startTrigger & 3) | ((headingIndex & 7) << 2) | ((turnRateIndex & 7) << 5);
    return b;
}

/** The 32-byte boss definition from named fields (MAIN.EXE reader 0x8003082C). */
export function encodePlusBoss({
    scripts = [0, 0, 0],
    guns = [{ pattern: 0, rate: 0 }, { pattern: 0, rate: 0 }, { pattern: 0, rate: 0 }],
    modes = [0, 0, 0],
    vertical = false,
    offsets = [[0, 0], [0, 0], [0, 0]],
    hpIndex = 0,
    armour = false,
    scoreIndex = 0,
    parameters = [0, 0, 0],
    music = true,
} = {}) {
    const b = new Uint8Array(PLUS_BOSS_SIZE);
    for (let i = 0; i < 3; i++) {
        b[i] = clamp(scripts[i] ?? 0, 0, PLUS_BOSS_SCRIPTS - 1);
        const g = guns[i] || { pattern: 0, rate: 0 };
        b[3 + i] = (clamp(g.pattern ?? 0, 0, 19)) | ((g.rate ?? 0) & 7) << 5;
        b[7 + i * 2] = (offsets[i]?.[0] ?? 0) & 0xff;
        b[8 + i * 2] = (offsets[i]?.[1] ?? 0) & 0xff;
        b[15 + i] = (parameters[i] ?? 0) & 0x7f;
    }
    b[6] = (modes[0] & 3) | ((modes[1] & 3) << 2) | ((modes[2] & 3) << 4) | (vertical ? 0x40 : 0);
    b[13] = (hpIndex & 7) | (armour ? 0x40 : 0);
    b[14] = scoreIndex & 7;
    b[31] = music ? 1 : 0;
    return b;
}

/**
 * The boss's behaviour a web boss wears: Athena's UPLOAD sample stage-0
 * boss — its three phase scripts (28, 32, 20), its guns (gun 1 fires pattern
 * 16 at rate 3), their offsets — with the level's own hit points, score, art
 * and orientation over it. Scripts and patterns are indices into tables
 * whose shapes are not traced; the sample's are a real boss's.
 */
export const PLUS_BOSS_BEHAVIOUR = Object.freeze({
    scripts: Object.freeze([0x1c, 0x20, 0x14]),
    guns: Object.freeze([Object.freeze({ pattern: 0, rate: 0 }), Object.freeze({ pattern: 16, rate: 3 }), Object.freeze({ pattern: 0, rate: 0 })]),
    modes: Object.freeze([0, 0, 3]),
    offsets: Object.freeze([Object.freeze([-33, -12]), Object.freeze([-33, 15]), Object.freeze([31, 17])]),
});

// --- the sprite sheets (MAIN.EXE 0x8001C82C, 0x80030708, 0x800318E8, 0x8002378C) ---

/**
 * SPRITE LAYOUT byte index (0..0x13F) -> the 16x16 cell it fills on the
 * 256x320 sheet, in cell units: rows 0-7 a plain 16-wide grid, rows 8-11
 * vertical pairs, rows 12-15 2x2 blocks, rows 16-19 4x4 blocks — the four
 * sub-blocks the blit copies (0x8001C860, 0x8001C924, 0x8001CA10, 0x8001CB10).
 */
export function plusSheetCellFor(i) {
    if (i < 0x80) return { cx: i & 15, cy: i >> 4 };
    if (i < 0xc0) {
        const k = i - 0x80;
        return { cx: (k & 31) >> 1, cy: 8 + (k >> 5) * 2 + (k & 1) };
    }
    if (i < 0x100) {
        const k = i - 0xc0;
        return { cx: ((k >> 2) & 7) * 2 + (k & 1), cy: 12 + (k >> 5) * 2 + ((k >> 1) & 1) };
    }
    const k = i - 0x100;
    return { cx: (k >> 4) * 4 + (k & 3), cy: 16 + ((k >> 2) & 3) };
}

/** The inverse: a sheet cell -> its SPRITE LAYOUT byte index. */
export function plusLayoutIndexFor(cx, cy) {
    if (cy < 8) return cy * 16 + cx;
    if (cy < 12) {
        const r = cy - 8;
        return 0x80 + (r >> 1) * 32 + cx * 2 + (r & 1);
    }
    if (cy < 16) {
        const r = cy - 12;
        return 0xc0 + (r >> 1) * 32 + (cx >> 1) * 4 + (r & 1) * 2 + (cx & 1);
    }
    const r = cy - 16;
    return 0x100 + (cx >> 2) * 16 + r * 4 + (cx & 3);
}

/**
 * Where frame k of definition id n of class `klass` sits on the sheet, in
 * pixels: the u/v each spawner sets (0x8001BC8C .. 0x8001C2B4) and the
 * draw's `u + k * w` (0x8002A24C).
 */
export function plusFrameRect(klass, n, k) {
    const c = PLUS_DEF_CLASSES[klass];
    let u = 0, v = 0;
    switch (klass) {
        case 0: u = (n & 3) * 64; v = (n >> 2) * 16; break;
        case 1: u = (n & 3) * 64; v = (n >> 2) * 16 + 64; break;
        case 2: u = (n & 7) * 32; v = (n >> 3) * 32 + 128; break;
        case 3: u = (n & 3) * 64; v = (n >> 2) * 32 + 192; break;
        default: u = (n & 3) * 64; v = 256; break;
    }
    return { x: u + k * c.w, y: v, w: c.w, h: c.h };
}

/**
 * The per-stage enemy sheet: ENEMY GROUP's 64 tile words and the 320 SPRITE
 * LAYOUT bytes (group index | 0x40 h-flip | 0x80 v-flip). Entry 0 is the
 * blank cell; every definition's frames are laid at their rects, sharing a
 * group entry per tile. More than 63 distinct tiles on one stage is the
 * format's ceiling, and what does not fit is left blank and reported.
 *
 * `defs` is [{klass, id, tiles: [frame][cell] of {tile, hflip, vflip} | null}].
 */
export function layoutEnemySheet(defs) {
    const enemyGroup = new Uint16Array(64).fill(PLUS_EMPTY_TILE);
    const spriteLayout = new Uint8Array(PLUS_STAGE_PIECE.spriteLayout.length);
    const entryOfTile = new Map();
    let entries = 1;
    let painted = 0, dropped = 0;
    for (const d of defs) {
        const c = PLUS_DEF_CLASSES[d.klass];
        const cw = c.w / CG_CELL, ch = c.h / CG_CELL;
        d.tiles.forEach((cells, k) => {
            if (k >= c.frames) return;
            const r = plusFrameRect(d.klass, d.id, k);
            for (let cy = 0; cy < ch; cy++) {
                for (let cx = 0; cx < cw; cx++) {
                    const t = cells[cy * cw + cx];
                    const at = plusLayoutIndexFor(r.x / CG_CELL + cx, r.y / CG_CELL + cy);
                    if (!t) { spriteLayout[at] = 0; continue; }
                    let e = entryOfTile.get(t.tile);
                    if (e === undefined) {
                        if (entries >= 64) { dropped++; spriteLayout[at] = 0; continue; }
                        e = entries++;
                        entryOfTile.set(t.tile, e);
                        enemyGroup[e] = plusTileWord(t.tile);
                    }
                    spriteLayout[at] = e | (t.hflip ? PLUS_LAYOUT_HFLIP : 0) | (t.vflip ? PLUS_LAYOUT_VFLIP : 0);
                    painted++;
                }
            }
        });
    }
    return { enemyGroup, spriteLayout, painted, entries: entries - 1, dropped };
}

/**
 * The boss's 32 BOSS GROUP words over an 8x4 (or, vertical, 4x8) cell
 * picture: word i is block i >> 4, row (i >> 2) & 3, column i & 3 of a 4x4
 * block (0x80030754), with 0x4000 / 0x8000 as the flips.
 */
export function layoutBoss(tiles, vertical = false) {
    const words = new Uint16Array(32).fill(PLUS_EMPTY_TILE);
    const cols = vertical ? 4 : 8;
    for (let i = 0; i < 32; i++) {
        const block = i >> 4, row = (i >> 2) & 3, col = i & 3;
        const x = vertical ? col : block * 4 + col;
        const y = vertical ? block * 4 + row : row;
        const t = tiles[y * cols + x];
        if (!t) continue;
        words[i] = plusTileWord(t.tile) | (t.hflip ? PLUS_GROUP_HFLIP : 0) | (t.vflip ? PLUS_GROUP_VFLIP : 0);
    }
    return words;
}

/** The title's 32 words: the boss's grid one block to the right (0x800318E8), over an 8x4 cell logo. */
export function layoutTitle(tiles) {
    return layoutBoss(tiles.map((t) => (t === null || t === undefined ? null : typeof t === "number" ? { tile: t } : t)), false);
}

/**
 * The player's sheet: MY SHIP GROUP's 77 words and MY SHIP ODR's 77 bytes.
 * The program lays the first sixteen words out as four 2x2 blocks — words
 * 0-3, 4-7, 8-11 the ship's three attitudes (0x8002378C; the player draws
 * block 0), stored [TL, TR, BL, BR] — forces words 61-63 to 0x3FC..0x3FE,
 * never reads 64-71, and ORs the ODR bytes, which carry flips only, over
 * its own default cell table. So: three poses, every other word the blank
 * cell, every ODR byte zero.
 */
export function layoutShip(poses) {
    const group = PLUS_GLOBAL_LAYOUT.find((p) => p.name === "shipGroup").length / 2;
    const shipGroup = new Uint16Array(group).fill(PLUS_EMPTY_TILE);
    const shipOdr = new Uint8Array(PLUS_GLOBAL_LAYOUT.find((p) => p.name === "shipOdr").length);
    let painted = 0;
    poses.slice(0, 3).forEach((tiles, p) => {
        tiles.forEach((t, i) => {
            if (!t || i >= 4) return;
            shipGroup[p * 4 + i] = plusTileWord(t.tile) | (t.hflip ? PLUS_GROUP_HFLIP : 0) | (t.vflip ? PLUS_GROUP_VFLIP : 0);
            painted++;
        });
    });
    [0x3fc, 0x3fd, 0x3fe].forEach((w, i) => { shipGroup[61 + i] = w; });
    for (let i = 64; i < 72; i++) shipGroup[i] = 0;
    return { shipGroup, shipOdr, painted };
}

// --- the assembler --------------------------------------------------------------------------

/**
 * Build the parts of a Dezaemon+ save from a level record and its art.
 *
 * Options: `name` (names the card file only — the save carries no text name),
 * `title1` ({w, h, rgba} logo for the 128x64 title block), `horizontal`
 * (refused with a warning: the map is laid out for a vertical game).
 *
 * Returns {block, warnings, report} with the block UNSEALED; buildPlusBlock
 * seals it and reads it back.
 */
export function buildPlusGameFromLevel(level, art, options = {}) {
    const opts = { name: null, title1: null, horizontal: false, ...options };
    const warnings = [];
    const warn = (m) => warnings.push(m);

    const artMap = new Map();
    for (const [k, v] of Object.entries(art || {})) {
        if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
    }
    const lookup = (n) => (n ? artMap.get(decodeFrameKey(n)) || null : null);

    let stages = levelStages(level);
    if (!stages.length) throw new Error("the level has no stage with an enemylist");
    if (stages.length > PLUS_STAGES) {
        warn(`level has ${stages.length} stages; a Dezaemon+ save holds ${PLUS_STAGES} — dropped the rest`);
        stages = stages.slice(0, PLUS_STAGES);
    }
    if (opts.horizontal) warn("the grid is horizontal; a Dezaemon+ game is written as a vertical one here");
    const enemyData = level.enemyData || {};
    const bossData = level.bossData || {};

    const bank = new PlusTileBank();
    const rows = Array.from({ length: PLUS_PALETTE_ROWS }, (_, r) => new PlusPaletteRow(r));
    const fullWarned = new Set();
    const tilesOf = (row, frame, w, h, what) => {
        const fitted = fitRgba(frame, w, h);
        rows[row].consider(fitted);
        return { row, fitted, w, h, what };
    };

    // --- plan every frame first, so each palette row sees all of its art ---
    const plans = [];
    const plan = (row, frame, w, h, what) => {
        const p = tilesOf(row, frame, w, h, what);
        plans.push(p);
        return p;
    };

    // The ship: the level's own frames, else Duke.
    let shipSource = "level";
    let shipFrames = ((level.playerData && level.playerData.texture) || []).map(lookup).filter(Boolean);
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }
    // Three attitudes: centre, then the level's second frame (or the first
    // again) for the two banks.
    const shipPlans = [shipFrames[0], shipFrames[1] || shipFrames[0], shipFrames[1] || shipFrames[0]]
        .map((f, i) => plan(plusPaletteRow("player"), f, 32, 32, `ship ${i}`));

    // The title logo.
    const titlePlan = opts.title1 && opts.title1.rgba ? plan(plusPaletteRow("title"), opts.title1, 128, 64, "title") : null;

    // A boss's second stage. A Dezaemon+ boss is one picture and one
    // definition a stage, its movement phases end on their scripts rather
    // than on its hit points, and its guns are the same three throughout, so
    // the form change cannot happen inside a stage: a boss with a stage2
    // block becomes two bosses either side of a stage break — its stage's
    // boss is the first form with the top of the bar, and a stage put in
    // after it, the same scenery and no waves, has the second form for its
    // boss with the rest (FORMAT-PSX.md "A boss's second stage"). The level's
    // own stages come first: a split with no stage left to go in stays one
    // boss, and says so.
    const stagePlan = [];
    const splits = [];
    let spare = PLUS_STAGES - stages.length;
    stages.forEach((st, s) => {
        const rec = bossData[`boss${s}`];
        const split = rec ? splitBossStage2(rec) : null;
        if (split && spare <= 0) {
            warn(`${st.key}: boss (${rec.name || "?"}) has a second stage, but the save's ${PLUS_STAGES} stages are full — it flies its first form alone, the whole bar`);
        }
        if (!split || spare <= 0) {
            stagePlan.push({ st, bossRec: rec, form: 0 });
            return;
        }
        spare--;
        const key = `${st.key}:stage2`;
        stagePlan.push({ st, bossRec: split.first, form: 1 });
        stagePlan.push({ st: { key, enemylist: [], background: st.background, scroll: st.scroll }, bossRec: split.second, form: 2 });
        splits.push({ stage: st.key, into: key, name: rec.name || `boss${s}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
    });

    // Per stage: definitions, placements, the boss, the scenery.
    const built = stagePlan.map(({ st, bossRec, form }, s) => {
        const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : (level.width || 8));
        const spawnRows = st.enemylist.slice().reverse();
        const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
        const usage = new Map();
        for (const row of spawnRows) for (const cell of row) if (cell && cell !== "00") usage.set(cell.slice(0, -1), (usage.get(cell.slice(0, -1)) || 0) + 1);
        const letters = [...usage.keys()].sort((a, b) => usage.get(b) - usage.get(a));
        const counts = PLUS_DEF_CLASSES.map(() => 0);
        const defs = new Map(); // letter -> {klass, id, index, bytes, frames: plans, name}
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
            let klass = plusClassFor(maxW, maxH);
            while (klass < PLUS_DEF_CLASSES.length && counts[klass] >= PLUS_DEF_CLASSES[klass].count) klass++;
            if (klass >= PLUS_DEF_CLASSES.length) {
                warn(`${st.key}: no free definition for enemy${letter} (${rec.name || "?"}) — a stage holds 60 — cells left empty`);
                continue;
            }
            const c = PLUS_DEF_CLASSES[klass];
            const id = counts[klass]++;
            const hits = rec.hp === "infinity" ? 2000 / PLUS_SHOT_DAMAGE : Math.max(1, Number(rec.hp) || 1);
            const interval = Number(rec.interval);
            const fires = Number.isFinite(interval) && interval > 0;
            const speed = (Number.isFinite(rec.speed) ? rec.speed : 1) * RUNTIME_TO_PLUS_SPEED;
            const bytes = encodePlusEnemy({
                movement: PLUS_MOVE_STRAIGHT_BASE + nearestIndex(PLUS_STRAIGHT_SPEEDS, speed),
                shotPattern: fires ? 1 : 0,
                fireRate: fires ? clamp(Math.round(7 - Math.min(6, interval / 30)), 1, 7) : 0,
                hpIndex: nearestIndex(PLUS_ENEMY_HP, hits * PLUS_SHOT_DAMAGE),
                scoreIndex: nearestIndex(PLUS_ENEMY_SCORE, Number(rec.score) || 100),
                animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex(PLUS_ANIM_INTERVALS, 60 / rec.frameRate) : 3,
            });
            const framePlans = spreadFrames(frames, c.frames).map((f, i) => plan(plusPaletteRow("enemy", s), f, c.w, c.h, `${st.key} enemy${letter} ${i}`));
            defs.set(letter, { klass, id, index: c.base + id, bytes, frames: framePlans, name: rec.name || `enemy${letter}` });
        }

        // Placements: a record per 16-px band that spawns something.
        const bands = new Map(); // band -> Uint8Array(14)
        let placed = 0, dropped = 0, lastRow = PLUS_FIRST_SPAWN_ROW;
        spawnRows.forEach((row, k) => {
            const band = waveRows
                ? clamp(Math.round(waveRows[k]), 0, PLUS_MAX_SPAWN_ROW)
                : Math.min(PLUS_MAX_SPAWN_ROW, PLUS_FIRST_SPAWN_ROW + k * PLUS_ROW_STEP);
            row.forEach((cell, col) => {
                if (!cell || cell === "00") return;
                const def = defs.get(cell.slice(0, -1));
                if (!def) return;
                const c = PLUS_DEF_CLASSES[def.klass];
                const column = mapPlusColumn(col, width, c.w / 16);
                if (!bands.has(band)) bands.set(band, new Uint8Array(PLUS_APPEAR_RECORD_SIZE));
                const rec = bands.get(band);
                let at = null;
                for (const dc of [0, 1, -1, 2, -2]) {
                    const cc = column + dc;
                    if (cc < 0 || cc >= PLUS_SPAWN_COLUMNS || rec[cc]) continue;
                    at = cc;
                    break;
                }
                if (at === null) { dropped++; return; }
                rec[at] = 0x80 | (c.nibble << 4) | (def.id & 15);
                placed++;
                lastRow = Math.max(lastRow, band);
            });
        });
        if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} overlapped another in the same band and ${dropped === 1 ? "was" : "were"} left out`);

        // The boss: one picture, 128x64 or 64x128 by the art's shape, the
        // sample boss's behaviour with the level's hit points and score, and
        // a 0xD0 byte a few bands past the last wave.
        let boss = null;
        if (bossRec) {
            const names = bossRec.anim && Array.isArray(bossRec.anim.idle)
                ? [...bossRec.anim.idle, ...(Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : [])]
                : Array.isArray(bossRec.texture) ? bossRec.texture : [];
            const frames = names.map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas — its picture is unpainted`);
            const first = frames[0] || { w: 128, h: 64 };
            const vertical = first.h > first.w;
            const box = vertical ? PLUS_BOSS_ART.vertical : PLUS_BOSS_ART.horizontal;
            if (frames.length && (first.w > box.w || first.h > box.h)) {
                warn(`${st.key}: boss (${bossRec.name || "?"}) is ${first.w}x${first.h}; a Dezaemon+ boss is ${box.w}x${box.h} — downscaled`);
            }
            const picture = frames.length ? plan(plusPaletteRow("boss", s), first, box.w, box.h, `${st.key} boss`) : null;
            const hits = bossRec.hp === "infinity" ? PLUS_BOSS_HP[7] / PLUS_SHOT_DAMAGE : Math.max(1, Number(bossRec.hp) || 100);
            const record = encodePlusBoss({
                ...PLUS_BOSS_BEHAVIOUR,
                vertical,
                hpIndex: nearestIndex(PLUS_BOSS_HP, hits * PLUS_SHOT_DAMAGE),
                scoreIndex: nearestIndex(PLUS_BOSS_SCORE, Number(bossRec.score) || PLUS_BOSS_SCORE[1]),
            });
            const band = Math.min(PLUS_SCROLL_BANDS - 8, lastRow + PLUS_BOSS_ROW_GAP);
            if (!bands.has(band)) bands.set(band, new Uint8Array(PLUS_APPEAR_RECORD_SIZE));
            bands.get(band)[PLUS_BOSS_COLUMN] = 0x80 | (PLUS_APPEAR_BOSS_NIBBLE << 4);
            boss = { name: bossRec.name || `boss${s}`, band, picture, vertical, record, frameCount: frames.length, hits };
            if (form) boss.form = form;
            lastRow = Math.max(lastRow, band);
        }

        // Scenery: the level's 16x16 cells, columns 0..13 -> chip columns
        // 1..14, the first 128 rows (the map holds 2,048 px; SCROLL loops it).
        const scenery = [];
        const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
        if (st.background && st.background.tiles && cellsList) {
            try {
                const bytes = b64ToBytes(st.background.tiles);
                const cols = st.background.cols || 14;
                const tiles = new Uint16Array(bytes.length >> 1);
                for (let i = 0; i < tiles.length; i++) tiles[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
                const rowsIn = Math.floor(tiles.length / cols);
                if (rowsIn > PLUS_MAP_ROWS) warn(`${st.key}: the scenery is ${rowsIn} rows and the map holds ${PLUS_MAP_ROWS}; the first ${PLUS_MAP_ROWS} loop`);
                const firstCol = Math.max(0, Math.floor((cols - 14) / 2));
                const planByOrdinal = new Map();
                for (let r = 0; r < Math.min(rowsIn, PLUS_MAP_ROWS); r++) {
                    for (let c = 0; c < 14; c++) {
                        const w = tiles[r * cols + firstCol + c];
                        if (w === 0xffff || firstCol + c >= cols) continue;
                        const ordinal = w & 0x3ff;
                        if (!planByOrdinal.has(ordinal)) {
                            const f = lookup(cellsList[ordinal]);
                            planByOrdinal.set(ordinal, f ? plan(plusPaletteRow("map", s), f, 16, 16, `${st.key} scenery`) : null);
                        }
                        const p = planByOrdinal.get(ordinal);
                        if (!p) continue;
                        scenery.push({ row: r, col: c + 1, plan: p, hflip: (w & 0x8000) !== 0, vflip: (w & 0x4000) !== 0 });
                    }
                }
            } catch (e) {
                warn(`${st.key}: could not read the background grid (${e.message}) — scenery skipped`);
            }
        }
        return { key: st.key, defs, bands, boss, scenery, placed, dropped, lastRow };
    });

    // --- quantise every row, then index and bank the planned art ---
    for (const r of rows) if (r.frames.length) r.build();
    const indexedOf = (p) => rows[p.row].index(p.fitted);
    const bankTiles = (p, flippable = false) => {
        const tiles = indexedTiles(indexedOf(p), p.w, p.h);
        try {
            return tiles.map((t) => (flippable ? bank.addFlippable(t) : bank.add(t)));
        } catch (e) {
            if (!(e instanceof PlusBankFullError)) throw e;
            const group = p.what.replace(/ \d+$/, "");
            if (!fullWarned.has(group)) {
                fullWarned.add(group);
                warn(`graphics bank full (${PLUS_TILE_COUNT} tiles): ${group} art left unpainted`);
            }
            return tiles.map(() => null);
        }
    };

    const block = new Uint8Array(PLUS_BLOCK_SIZE);

    // Per stage: map + MAP GROUP, scroll, appear, definitions, config, boss, sheet.
    const stageReports = built.map((b, s) => {
        const base = PLUS_STAGES_OFFSET + s * PLUS_STAGE_SIZE;
        const piece = (name) => block.subarray(base + PLUS_STAGE_PIECE[name].offset, base + PLUS_STAGE_PIECE[name].end);
        // MAP + MAP GROUP: group 0 is the blank chip; tiles get groups 1..127.
        const map = piece("map");
        const mapGroup = piece("mapGroup");
        for (let i = 0; i < mapGroup.length; i += 2) putU16le(mapGroup, i, PLUS_EMPTY_TILE);
        const groupOfTile = new Map();
        let groups = 1, chips = 0, sceneryDropped = 0;
        const tileOfPlan = new Map();
        for (const sc of b.scenery) {
            if (!tileOfPlan.has(sc.plan)) tileOfPlan.set(sc.plan, bankTiles(sc.plan, true)[0]);
            const t = tileOfPlan.get(sc.plan);
            if (!t) continue;
            let g = groupOfTile.get(t.tile);
            if (g === undefined) {
                if (groups >= 128) { sceneryDropped++; continue; }
                g = groups++;
                groupOfTile.set(t.tile, g);
                putU16le(mapGroup, g * 2, plusTileWord(t.tile));
            }
            const half = PLUS_MAP_HALVES[sc.col < 8 ? 0 : 1];
            const k = sc.col < 8 ? sc.col : sc.col - 9;
            const at = sc.row * PLUS_MAP_ROW_BYTES;
            const hflip = sc.hflip !== t.hflip, vflip = sc.vflip !== t.vflip;
            map[at + half.chips[k]] = g | (hflip ? 0x80 : 0);
            if (vflip) map[at + half.flags] |= 1 << (7 - k);
            chips++;
        }
        if (sceneryDropped) warn(`${b.key}: the scenery needs more than 127 distinct tiles; ${sceneryDropped} chips left blank`);
        // SCROLL: the 32 blocks in order, looping; the effect byte the sample's.
        const scroll = piece("scroll");
        for (let i = 0; i < 256; i++) scroll[i] = i % 32;
        scroll.fill(PLUS_SCROLL_EFFECT_DEFAULT, 256, 512);
        // APPEAR: record 0 empty, 1 the end mark, then one per band.
        const appear = piece("appear");
        appear.fill(PLUS_APPEAR_END_MARK, PLUS_APPEAR_RECORD_SIZE, 2 * PLUS_APPEAR_RECORD_SIZE);
        let next = 2;
        const rowTable = appear.subarray(PLUS_APPEAR_RECORDS * PLUS_APPEAR_RECORD_SIZE);
        let bandsDropped = 0;
        for (const [band, rec] of [...b.bands.entries()].sort((x, y) => x[0] - y[0])) {
            if (next >= PLUS_APPEAR_RECORDS) { bandsDropped++; continue; }
            appear.set(rec, next * PLUS_APPEAR_RECORD_SIZE);
            rowTable[band] = next++;
        }
        if (bandsDropped) warn(`${b.key}: more than 254 bands spawn something; ${bandsDropped} left empty`);
        // ENEMY DATA + STAGE CONFIG.
        const enemyData = piece("enemyData");
        const config = piece("config");
        config.fill(PLUS_STAGE_CONFIG_DEFAULT);
        for (const d of b.defs.values()) enemyData.set(d.bytes, d.index * PLUS_ENEMY_SIZE);
        // The boss: its record and its picture.
        const bossGroup = piece("bossGroup");
        let bossPainted = 0;
        if (b.boss) {
            enemyData.set(b.boss.record, PLUS_BOSS_OFFSET);
            const tiles = b.boss.picture ? bankTiles(b.boss.picture, true) : [];
            const words = layoutBoss(tiles, b.boss.vertical);
            for (let i = 0; i < words.length; i++) putU16le(bossGroup, i * 2, words[i]);
            bossPainted = words.filter((w) => w !== PLUS_EMPTY_TILE).length;
        } else {
            for (let i = 0; i < bossGroup.length; i += 2) putU16le(bossGroup, i, PLUS_EMPTY_TILE);
        }
        // The enemy sheet.
        const sheet = layoutEnemySheet([...b.defs.values()].map((d) => ({ ...d, tiles: d.frames.map((p) => bankTiles(p, true)) })));
        if (sheet.dropped) warn(`${b.key}: the enemies need more than 63 distinct tiles; ${sheet.dropped} cells left blank`);
        const enemyGroup = piece("enemyGroup");
        for (let i = 0; i < 64; i++) putU16le(enemyGroup, i * 2, sheet.enemyGroup[i]);
        piece("spriteLayout").set(sheet.spriteLayout);
        return {
            key: b.key,
            placements: b.placed,
            dropped: b.dropped,
            definitions: [...b.defs.values()].map((d) => ({ name: d.name, klass: d.klass, id: d.id, index: d.index })),
            boss: b.boss
                ? { name: b.boss.name, band: b.boss.band, frames: b.boss.frameCount, vertical: b.boss.vertical, tiles: bossPainted, hits: b.boss.hits, ...(b.boss.form ? { form: b.boss.form } : {}) }
                : null,
            chips,
            groups: groups - 1,
            enemyTiles: sheet.painted,
            enemyEntries: sheet.entries,
        };
    });
    // Stages past the last: empty tiles in their groups too.
    for (let s = built.length; s < PLUS_STAGES; s++) {
        const base = PLUS_STAGES_OFFSET + s * PLUS_STAGE_SIZE;
        for (const name of ["mapGroup", "enemyGroup", "bossGroup"]) {
            const p = block.subarray(base + PLUS_STAGE_PIECE[name].offset, base + PLUS_STAGE_PIECE[name].end);
            for (let i = 0; i < p.length; i += 2) putU16le(p, i, PLUS_EMPTY_TILE);
        }
        block.subarray(base + PLUS_STAGE_PIECE.appear.offset + PLUS_APPEAR_RECORD_SIZE, base + PLUS_STAGE_PIECE.appear.offset + 2 * PLUS_APPEAR_RECORD_SIZE).fill(PLUS_APPEAR_END_MARK);
        block.subarray(base + PLUS_STAGE_PIECE.scroll.offset + 256, base + PLUS_STAGE_PIECE.scroll.end).fill(PLUS_SCROLL_EFFECT_DEFAULT);
        block.subarray(base + PLUS_STAGE_PIECE.config.offset, base + PLUS_STAGE_PIECE.config.end).fill(PLUS_STAGE_CONFIG_DEFAULT);
    }

    // The global block.
    const global = (name) => {
        const p = PLUS_GLOBAL_LAYOUT.find((x) => x.name === name);
        return block.subarray(PLUS_GLOBAL_OFFSET + p.offset, PLUS_GLOBAL_OFFSET + p.end);
    };
    global("titleType").set(PLUS_TITLE_TYPE);
    const titleGroup = global("titleGroup");
    let titlePainted = 0;
    {
        const words = layoutTitle(titlePlan ? bankTiles(titlePlan, true) : []);
        for (let i = 0; i < 32; i++) putU16le(titleGroup, i * 2, words[i]);
        titlePainted = words.filter((w) => w !== PLUS_EMPTY_TILE).length;
    }
    const ending = global("endingGroup");
    for (let i = 0; i < ending.length; i += 2) putU16le(ending, i, PLUS_EMPTY_TILE);
    const ship = layoutShip(shipPlans.map((p) => bankTiles(p, true)));
    const shipGroup = global("shipGroup");
    for (let i = 0; i < ship.shipGroup.length; i++) putU16le(shipGroup, i * 2, ship.shipGroup[i]);
    global("shipOdr").set(ship.shipOdr);
    global("itemTable").set(PLUS_ITEM_TABLE);
    global("gameSettings").set([PLUS_SCORE_BONUS_INDEX, PLUS_CHARGE_TIME, built.length - 1]);
    global("bgmAssignment").set(PLUS_BGM_ASSIGNMENT);

    // SOUND: sixteen silent songs (all zero) — the BGM assignment names the
    // disc's own; HIGH SCORE: the factory ladders; SETTINGS: the factory bytes.
    block.fill(0, PLUS_SOUND_OFFSET, PLUS_SOUND_OFFSET + PLUS_SONG_COUNT * PLUS_SONG_SIZE);
    for (let t = 0; t < PLUS_HISCORE_TABLES; t++) {
        for (let i = 0; i < PLUS_HISCORE_COUNT; i++) {
            const at = PLUS_HISCORE_OFFSET + t * PLUS_HISCORE_TABLE_BYTES + i * PLUS_HISCORE_SIZE;
            putU32le(block, at, (PLUS_HISCORE_COUNT - i) * 100);
            block.fill(PLUS_FACTORY_NAME, at + 8, at + 16);
        }
    }
    block.set(PLUS_FACTORY_SETTINGS, PLUS_SETTINGS_OFFSET);

    // GRAPHICS + PALETTES.
    block.set(bank.toBitmap(), PLUS_GRAPHICS_OFFSET);
    rows.forEach((r, i) => {
        const words = r.words || new Uint16Array(16);
        for (let c = 0; c < 16; c++) putU16le(block, PLUS_PALETTE_OFFSET + i * PLUS_PALETTE_ROW_BYTES + c * 2, words[c]);
    });

    // The header: the program's title, an icon from the ship.
    block[0] = 0x53;
    block[1] = 0x43;
    block[2] = 0x11;
    block[3] = PLUS_BLOCK_SIZE / 0x2000;
    block.set(PLUS_TITLE_BYTES, TITLE_OFFSET);
    const icon = encodeKidsIcon(shipFrames[0] || defaultKidsIcon());
    for (let i = 0; i < 16; i++) putU16le(block, CLUT_OFFSET + i * 2, icon.clut[i] ?? 0);
    block.set(icon.pixels.subarray(0, 0x80), TITLE_FRAME_SIZE);

    const name = String(opts.name ?? level.name ?? "game").trim() || "game";
    return {
        block,
        warnings,
        report: {
            name,
            stages: stageReports,
            ship: shipSource,
            shipTiles: ship.painted,
            title: titlePainted ? "uploaded" : "none",
            rows: rows.map((r) => ({ row: r.row, colors: r.count || 0 })).filter((r) => r.colors),
            tiles: { used: bank.used, shared: bank.shared, free: bank.free },
            // How the save's bosses carry their second stages (boss-stage2.js).
            transform: splits.length
                ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); a Dezaemon+ save has no bullet art, so the guns keep the sample's`
                : "none",
            splits,
        },
    };
}

/**
 * Seal a built block's checksums and read it back through parsePlusSave:
 * the nineteen verified groups must agree and the parser must find a
 * Dezaemon+ save with no errors.
 */
export function buildPlusBlock(block) {
    if (!(block instanceof Uint8Array) || block.length !== PLUS_BLOCK_SIZE) throw new Error(`a Dezaemon+ block is ${PLUS_BLOCK_SIZE} bytes`);
    const seal = sealPlusChecksums(block);
    const back = parsePlusSave(block, { filename: PLUS_PRODUCT });
    if (back.errors.length) throw new Error(`the block does not read back: ${back.errors.map((e) => e.message).join("; ")}`);
    if (!back.checksums || !back.checksums.ok) throw new Error("the block's group checksums do not verify after sealing");
    return { block, seal, parsed: back };
}

/** The file a Dezaemon+ card is downloaded as. */
export function plusCardFileName(name) {
    const clean = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "game";
    return `Dezaemon Plus - ${clean}.mcr`;
}

/**
 * The one-call export: a level record and its art -> the 128 KB memory card
 * holding the game as BISLPS-00335DEZA, the file both Dezaemon+ editions load.
 */
export function exportLevelToPlusCard(level, art, options = {}) {
    const game = buildPlusGameFromLevel(level, art, options);
    const { block, seal } = buildPlusBlock(game.block);
    const card = buildMemoryCard([{ filename: PLUS_PRODUCT, data: block }]);
    return {
        card,
        block,
        fileName: plusCardFileName(game.report.name),
        name: game.report.name,
        warnings: game.warnings,
        report: { ...game.report, sealedGroups: seal.groups ? seal.groups.length : undefined, checksumBytes: seal.bytes },
    };
}
