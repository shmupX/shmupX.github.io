// A level record as a Super Famicom Dezaemon SRAM image.
//
// The 1994 cart's counterpart of src/write/game-to-save.js (the Saturn) and
// src/psx/kids-write.js: exportLevelToSfcSram(level, art) takes the editor's
// level record and its RGBA frames and returns the 128 KB battery-SRAM image
// Kaite Tsukutte Asoberu Dezaemon (SHVC-66) boots into — the raw .srm an
// emulator keeps beside the ROM. Everything it lays out is what the ROM's
// loaders read (FORMAT-SFC.md, traced 2026-10-14):
//
//   - the art is quantised into 15-colour palette rows — row n for stage n's
//     scenery, 6+n its enemies, 12+n its boss, 18 the ship, 19 the title —
//     written with a sprite's first colour in word 0, because the console
//     lands a row one colour up (the game copies words 0..14 into colours
//     1..15 of the palette its layer owns, so pixel index k draws word k - 1;
//     FORMAT-SFC.md "Running a save") — and cut into
//     16x16 chips in the save's two GRAPIC DATA sheets, one copy per distinct
//     chip with mirrors shared through the flip bits;
//   - a stage's scenery is 128 rows of 16 chips naming MAP GROUP slots, the
//     first 128 rows of the level's grid, centred in the 256-px playfield;
//   - an enemy becomes an eight-byte entry of the class its art fits (16x16,
//     32x16, 16x32, 32x32, 64x64), its frames chips of the stage's 64-slot
//     enemy sheet named by ENEMY ODR, its waves spawn records of APPEAR
//     DATA fired by the line table, one line a map row;
//   - the boss is the BOSS GROUP sheet, 8x4 chips or 4x8 for tall art, with
//     the sample's stage-0 block for its behaviour, spawned by a class-5
//     byte after the last wave;
//   - the ship is the level's own frames (Duke when it has none) in the
//     three poses the player handler names — chips 0-3 of the ship sheet
//     banking left, 4-7 level, 8-11 banking right, drawn as four 16x16 OBJs
//     through OBJ palette 7 <- row 18, which nothing else draws through; the
//     rest of the sheet (shots, enemy bullets, items, explosions, through
//     rows 20 and 21) stays the factory's, the ROM's art read at play time;
//   - the title picture (TITLE GROUP, 8x4 chips) is the browser's title
//     scene as the cart can hold it: the title editor's backdrop with the
//     logo and subtitle over it, the window around them fitted to 128x64;
//   - the sound is the factory sample's (factory-data.js), and the CHECK SUM
//     block is sealed last. The image is read back through parseSfcSav
//     before it leaves.
//
// What is settled and what is still a template is in FORMAT-SFC.md "Writing
// a save". Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { SRAM_SIZE } from "./sram.js";
import { sealSfcChecksums, verifySfcChecksums } from "./checksum.js";
import { writeWords } from "./tilemap.js";
import {
    CHIP_BLANK_WORD,
    CHIP_DIM,
    CHIP_EMPTY_WORD,
    chipWordForIndex,
    encodeChipPixels,
    encodeOdrByte,
    flipChip,
    ODR_HFLIP,
    ODR_VFLIP,
    USER_CHIP_COUNT,
} from "./chips.js";
import {
    encodeMapRow,
    MAP_BLOCK_ROWS,
    MAP_COLUMNS,
    MAP_ROW_BYTES,
    MAP_ROWS,
    MAP_STAGE_BYTES,
    STAGE_COUNT,
    storyScrollSequence,
    writeScrollSequence,
} from "./map.js";
import {
    BOSS_GROUP_CHIPS,
    BOSS_GROUP_STAGE_BYTES,
    BOSS_SHEET_COLS,
    BOSS_SHEET_ROWS,
    ENEMY_GROUP_CHIPS,
    ENEMY_GROUP_STAGE_BYTES,
    ENEMY_ODR_STAGE_BYTES,
    MAP_GROUP_CHIPS,
    MAP_GROUP_STAGE_BYTES,
    bossSlotForCell,
    MY_SHIP_ODR_BYTES,
    TITLE_GROUP_CHIPS,
    titleSlotForCell,
} from "./groups.js";
import {
    APPEAR_BOSS_CLASS,
    APPEAR_COLUMNS,
    APPEAR_FIRST_COLUMN,
    APPEAR_LINES,
    APPEAR_RECORD_BYTES,
    APPEAR_RECORD_END,
    APPEAR_RECORDS,
    APPEAR_STAGE_BYTES,
    APPEAR_TABLE_B_OFFSET,
    BOSS_BLOCK_OFFSET,
    encodeAppearByte,
    encodeEnemyEntry,
    ENEMY_ENTRY_BYTES,
    ENEMY_STAGE_BYTES,
    SFC_ANIM_INTERVALS,
    SFC_BOSS_HP,
    SFC_ENEMY_CLASSES,
    SFC_ENEMY_HP,
    SFC_ENEMY_SCORE,
    SFC_MOVE_STRAIGHT,
    SFC_SHOT_RATES,
    SFC_STRAIGHT_SPEEDS,
} from "./enemy.js";
import { PALETTE_ROW_SHIP, PALETTE_ROW_STAGE_BG, PALETTE_ROW_STAGE_BOSS, PALETTE_ROW_STAGE_ENEMY, PALETTE_ROW_TITLE, writeCgramRow } from "./cgram.js";
import { formatSfcSram } from "./sfc-format.js";
import { SFC_FACTORY_BOSS_BLOCK, SFC_FACTORY_GLOBAL_ROWS, SFC_FACTORY_SHIP_WORDS } from "./factory-data.js";
import { parseSfcSav } from "./index.js";
import { quantizeFrames, USER_COLOR_FLAG } from "../palette/palette-target.js";
import { decodeFrameKey, fitRgba, hflipRgba, levelStages, spreadFrames } from "../write/game-to-save.js";
import { decodePlayerArt } from "../player-art.js";
import { bossBodyFrames, splitBossStage2 } from "../boss-stage2.js";

/** The playfield's spawn columns 1..14, and the map row a wave spawns on when the level says nothing. */
export const SFC_FIRST_SPAWN_LINE = 2;
export const SFC_LINE_STEP = 4;
/** The boss spawns this many rows past the last wave (the engine warns eight rows ahead of it). */
export const SFC_BOSS_LINE_GAP = 12;
/** The last line a spawn may use: the stage is 1,024 lines, the END goes one past the last spawn. */
export const SFC_LAST_SPAWN_LINE = APPEAR_LINES - 2;
/**
 * A stage's story (`storyBackdrops`) is painted into its map with its top on
 * this row. As a stage opens the screen shows map rows 0-13, row 0 at its
 * foot and row 13's top just above its top edge, under the score and the
 * REST counter (measured in snes9x, 2026-10-20), so a story topped at row 11
 * opens whole, just below them.
 */
export const SFC_STORY_TOP_ROW = 11;
/** Lines a story stage's waves wait past its top row, as the Saturn's do. */
export const SFC_STORY_LEAD_LINES = 8;
/**
 * The earliest line a story stage's boss may stand on: a living boss loops
 * the scroll inside a 1,024-px window, and one that started on the story's
 * blocks would bring them back.
 */
export const SFC_STORY_MIN_BOSS_LINE = 80;
/** The story's columns: the map's 16 less one each side, 224 px. */
export const SFC_STORY_FIRST_COL = 1;
/** What one web-game hit is worth against the ENEMY DATA hit-point table (a guess: the plain shot's damage is untraced). */
export const SFC_HIT_UNITS = 25;
/** The aim value the sample's firing enemies carry (byte 1 bits 0-4; its pattern is untraced). */
export const SFC_DEFAULT_AIM = 13;
/** The title picture's shape on screen: TITLE GROUP's 32 chips as 8 x 4 (titleSlotForCell places each). */
export const SFC_TITLE_COLS = 8;
export const SFC_TITLE_ROWS = 4;
/**
 * The ship's poses: 32x32 each, four 16x16 chips TL TR BL BR, at these MY
 * SHIP GROUP slots — what the player handler ($02:85D6) names in OAM while
 * level, banking left and banking right (traced 2026-10-16). Chips 12-15 are
 * never named in play and keep the factory's words.
 */
export const SFC_SHIP_POSE_PX = 32;
export const SFC_SHIP_POSE_SLOTS = Object.freeze({ left: 0, centre: 4, right: 8 });
/**
 * The browser's title scene, whose layout the title picture follows: a
 * 256x480 screen, the backdrop tiled from the top-left at its own size, the
 * logo plate at y 75 and the subtitle at y 130, both flush left (the PS2
 * exporter's titleUploadFrames reads the same numbers off the title scene).
 */
export const SFC_TITLE_SCENE = Object.freeze({ w: 256, h: 480, logoY: 75, subtitleY: 130 });

function nearestIndex(table, value) {
    let best = 0, bestD = Infinity;
    table.forEach((v, i) => {
        const d = Math.abs(v - value);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    });
    return best;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function b64ToBytes(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Whether a w x h boss is written tall (4x8 chips, 64x128) rather than wide
 * (8x4, 128x64): tall when the art fitted to it would draw larger, so a
 * boss taller than it is wide stands up; wide on a tie, art that fits either
 * box whole included.
 */
export function sfcBossIsTall(w, h) {
    const wideW = BOSS_SHEET_COLS * CHIP_DIM, wideH = BOSS_SHEET_ROWS * CHIP_DIM;
    const scaleWide = Math.min(1, wideW / w, wideH / h);
    const scaleTall = Math.min(1, wideH / w, wideW / h);
    return scaleTall > scaleWide;
}

/** A level column (0..width-1) -> a playfield column 1..14, the ends pinned. */
export function sfcSpawnColumn(col, width) {
    if (width <= 1) return APPEAR_FIRST_COLUMN + Math.floor(APPEAR_COLUMNS / 2);
    return APPEAR_FIRST_COLUMN + Math.round((clamp(col, 0, width - 1) * (APPEAR_COLUMNS - 1)) / (width - 1));
}

/** The class an enemy of w x h px takes: the smallest shape it fits, 64x64 for anything bigger. */
export function sfcClassFor(w, h) {
    if (w <= 16 && h <= 16) return 0;
    if (w <= 32 && h <= 16) return 1;
    if (w <= 16 && h <= 32) return 2;
    if (w <= 32 && h <= 32) return 3;
    return 4;
}

/** Where an entry of a class may fall back to when its class is full: the next shape that holds it. */
const CLASS_FALLBACKS = Object.freeze([[0, 1, 2, 3, 4], [1, 3, 4], [2, 3, 4], [3, 4], [4]]);

export function sfcSramFileName(name) {
    const safe = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").trim() || "game";
    return `Dezaemon SFC - ${safe}.srm`;
}

/**
 * The GRAPIC DATA allocator: 16x16 chips of colour indices, one copy per
 * distinct chip, its mirrors found through the flip bits. Chip indices are
 * user chips 0..511 (chips.js); the word for a chip is its index plus flips.
 */
export class SfcChipBank {
    constructor(capacity = USER_CHIP_COUNT) {
        this.capacity = capacity;
        this.chips = [];
        this.byKey = new Map();
        this.shared = 0;
    }

    get used() {
        return this.chips.length;
    }

    /** {chip, hflip, vflip} for a 256-index raster, null when the bank is full. */
    add(pixels) {
        const key = keyOf(pixels);
        const hit = this.byKey.get(key);
        if (hit) {
            if (hit.hflip || hit.vflip) this.shared++;
            return hit;
        }
        if (this.chips.length >= this.capacity) return null;
        const chip = this.chips.length;
        this.chips.push(Uint8Array.from(pixels));
        const plain = { chip, hflip: false, vflip: false };
        this.byKey.set(key, plain);
        for (const [h, v] of [[true, false], [false, true], [true, true]]) {
            const k = keyOf(flipChip(pixels, h, v));
            if (!this.byKey.has(k)) this.byKey.set(k, { chip, hflip: h, vflip: v });
        }
        return plain;
    }

    /** Every chip into the image's two sheets. */
    writeTo(bytes) {
        this.chips.forEach((px, i) => encodeChipPixels(bytes, i, px));
    }
}

function keyOf(pixels) {
    let s = "";
    for (let i = 0; i < pixels.length; i++) s += String.fromCharCode(pixels[i] & 0x0f);
    return s;
}

function isTransparent(pixels) {
    for (let i = 0; i < pixels.length; i++) if (pixels[i]) return false;
    return true;
}

/**
 * Reduce RGBA frames to one 15-colour row: {frames: [{key, w, h, indices}],
 * words: [15 colour words], colors}. Index 0 is transparent; the frames'
 * values are 1..15 of that row, and words[k - 1] is the colour of index k —
 * the order writeCgramRow takes, since the console lands a row one colour
 * up. Slots the quantiser did not fill are 0.
 */
export function quantizeToRow(frames) {
    if (!frames.length) return { frames: [], words: [], colors: 0 };
    const q = quantizeFrames(frames.map((f, i) => ({ ...f, key: f.key ?? `f${i}`, group: "row" })), "snes", { firstRow: 0, rows: 1 });
    const words = [];
    for (let k = 1; k < 16; k++) {
        const w = q.bank[k];
        words.push(w & USER_COLOR_FLAG ? w & 0x7fff : 0);
    }
    const out = q.frames.map((f) => {
        const indices = new Uint8Array(f.indexed.length);
        for (let i = 0; i < indices.length; i++) indices[i] = f.indexed[i] & 0x0f;
        return { key: f.key, w: f.w, h: f.h, indices };
    });
    return { frames: out, words, colors: q.report.rows[0] ? q.report.rows[0].colors : 0 };
}

/** The chip at (cx, cy) of a w x h indexed raster, as 256 indices. */
export function cutChip(indices, w, cx, cy) {
    const out = new Uint8Array(CHIP_DIM * CHIP_DIM);
    for (let y = 0; y < CHIP_DIM; y++) {
        for (let x = 0; x < CHIP_DIM; x++) out[y * CHIP_DIM + x] = indices[(cy * CHIP_DIM + y) * w + cx * CHIP_DIM + x];
    }
    return out;
}

/**
 * The title picture: the browser's title scene as the cart's 8x4-chip TITLE
 * GROUP (128x64). The scene is composed as the title scene draws it — the
 * backdrop tiled from the top-left at its own size, the logo at y 75 and the
 * subtitle at y 130, each flush left — and the window around the logo and
 * subtitle (the band the logo would sit in when there is only a backdrop) is
 * fitted to the picture, never upscaled, and box-filtered down. Where the
 * scene has nothing the picture is transparent, so a logo on its own sits on
 * the title's black as the sample's does. Null when there is no title art.
 *
 * `logo`, `subtitle` and `backdrop` are {w, h, rgba} or null; returns
 * {w: 128, h: 64, rgba} or null.
 */
export function composeTitlePicture({ logo = null, subtitle = null, backdrop = null } = {}) {
    const W = SFC_TITLE_COLS * CHIP_DIM, H = SFC_TITLE_ROWS * CHIP_DIM;
    const scene = SFC_TITLE_SCENE;
    const has = (f) => !!(f && f.rgba && f.w > 0 && f.h > 0);
    const plates = [];
    if (has(logo)) plates.push({ x: 0, y: scene.logoY, w: logo.w, h: logo.h, rgba: logo.rgba });
    if (has(subtitle)) plates.push({ x: 0, y: scene.subtitleY, w: subtitle.w, h: subtitle.h, rgba: subtitle.rgba });
    const bg = has(backdrop) ? backdrop : null;
    if (!plates.length && !bg) return null;

    // The window: around the plates, else the band the logo would sit in.
    let box = { x: 0, y: scene.logoY, w: scene.w, h: H };
    if (plates.length) {
        const x0 = Math.min(...plates.map((p) => p.x)), y0 = Math.min(...plates.map((p) => p.y));
        const x1 = Math.max(...plates.map((p) => p.x + p.w)), y1 = Math.max(...plates.map((p) => p.y + p.h));
        box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const scale = Math.min(1, W / box.w, H / box.h);
    const ww = W / scale, wh = H / scale;
    // Centred on the box — and, when a backdrop fills the screen, kept on the
    // screen where it fits, so the picture shows backdrop rather than the
    // black past the screen's edge; plates alone are simply centred.
    const within = (at, size, span) => (bg && size <= span ? Math.min(Math.max(at, 0), span - size) : at);
    const wx = Math.round(within(box.x + (box.w - ww) / 2, ww, scene.w));
    const wy = Math.round(within(box.y + (box.h - wh) / 2, wh, scene.h));

    // One scene pixel, premultiplied: the backdrop under the plates.
    const over = (dst, f, x, y) => {
        const s = (y * f.w + x) * 4;
        const a = f.rgba[s + 3] / 255;
        if (!a) return;
        const keep = 1 - a;
        dst[0] = f.rgba[s] * a + dst[0] * keep;
        dst[1] = f.rgba[s + 1] * a + dst[1] * keep;
        dst[2] = f.rgba[s + 2] * a + dst[2] * keep;
        dst[3] = 255 * a + dst[3] * keep;
    };
    const px = [0, 0, 0, 0];
    const sceneAt = (x, y) => {
        px[0] = px[1] = px[2] = px[3] = 0;
        if (x < 0 || y < 0 || x >= scene.w || y >= scene.h) return px;
        if (bg) over(px, bg, x % bg.w, y % bg.h);
        for (const p of plates) {
            if (x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) over(px, p, x - p.x, y - p.y);
        }
        return px;
    };
    // Box-filtered down: a picture pixel is the mean of the scene pixels it covers.
    const out = new Uint8Array(W * H * 4);
    const span = (from, to) => [Math.floor(from), Math.max(Math.ceil(to), Math.floor(from) + 1)];
    for (let oy = 0; oy < H; oy++) {
        const [y0, y1] = span(wy + oy / scale, wy + (oy + 1) / scale);
        for (let ox = 0; ox < W; ox++) {
            const [x0, x1] = span(wx + ox / scale, wx + (ox + 1) / scale);
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const p = sceneAt(x, y);
                    r += p[0];
                    g += p[1];
                    b += p[2];
                    a += p[3];
                    n++;
                }
            }
            if (!a) continue;
            const d = (oy * W + ox) * 4;
            out[d] = Math.round(r * 255 / a);
            out[d + 1] = Math.round(g * 255 / a);
            out[d + 2] = Math.round(b * 255 / a);
            out[d + 3] = Math.round(a / n);
        }
    }
    return { w: W, h: H, rgba: out };
}

/**
 * Build the image. `art` maps atlas frame names to {w, h, rgba}. Options:
 * `name` (the game's name, for the file; a Super Famicom save carries no
 * text name), `title1`, `title2` and `titleBg` ({w, h, rgba}: the title
 * editor's logo, subtitle and backdrop, composed into the title picture by
 * composeTitlePicture), `horizontal` (refused with a warning: the cart
 * scrolls vertically), `storyBackdrops` ([{stage, variants: [{label, w: 224,
 * h, rgba}]}], src/story/story-panels.js: each stage's story, painted into
 * its opening map rows at the largest size the sheets have room for — see
 * buildWithStory).
 *
 * Returns {bytes, name, warnings, report}.
 */
export function buildSfcGameFromLevel(level, art, options = {}) {
    const opts = { name: null, title1: null, title2: null, titleBg: null, horizontal: false, storyBackdrops: null, storyPicks: null, ...options };
    if (!opts.storyPicks && Array.isArray(opts.storyBackdrops) && opts.storyBackdrops.length) {
        return buildWithStory(level, art, opts);
    }
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const name = String(opts.name || level.name || "game").trim() || "game";

    const artMap = new Map();
    for (const [k, v] of Object.entries(art || {})) {
        if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
    }
    const lookup = (n) => (n ? artMap.get(decodeFrameKey(n)) || null : null);

    let stages = levelStages(level);
    if (!stages.length) throw new Error("the level has no stage with an enemylist");
    if (stages.length > STAGE_COUNT) {
        warn(`level has ${stages.length} stages; a Super Famicom save holds ${STAGE_COUNT} — dropped the rest`);
        stages = stages.slice(0, STAGE_COUNT);
    }
    if (opts.horizontal) warn("the grid is horizontal; the Super Famicom game scrolls vertically and is written as such — enemies come down the screen");
    const enemyData = level.enemyData || {};
    const bossData = level.bossData || {};

    // A boss's second stage. The cart's boss has one sheet, its three phases
    // cycle on a timer rather than on its hit points, and its death clears
    // the stage, so the form change cannot happen inside one stage: a boss
    // with a stage2 block becomes two bosses either side of a stage break —
    // its stage's boss is the first form with the top of the bar, and a stage
    // put in after it, the same scenery and no waves, has the second form for
    // its boss with the rest (FORMAT-SFC.md "A boss's second stage"). Stages
    // the level already fills come first: a split that has no stage left to
    // go in stays one boss, and says so.
    const plan = [];
    const splits = [];
    let spare = STAGE_COUNT - stages.length;
    stages.forEach((st, s) => {
        const rec = bossData[`boss${s}`] || (s === 0 && stages.length === 1 ? bossData.boss0 : null);
        const split = rec ? splitBossStage2(rec) : null;
        if (split && spare <= 0) {
            warn(`${st.key}: boss (${rec.name || "?"}) has a second stage, but the save's ${STAGE_COUNT} stages are full — it flies its first form alone, the whole bar`);
        }
        if (!split || spare <= 0) {
            plan.push({ st, bossRec: rec, form: 0 });
            return;
        }
        spare--;
        const key = `${st.key}:stage2`;
        plan.push({ st, bossRec: split.first, form: 1 });
        plan.push({ st: { key, enemylist: [], background: st.background, scroll: st.scroll }, bossRec: split.second, form: 2 });
        splits.push({ stage: st.key, into: key, name: rec.name || `boss${s}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
    });
    const transform = splits.length
        ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); the bullets stay the ROM's`
        : "none";

    const bytes = formatSfcSram({ seal: false });
    const bank = new SfcChipBank();
    const fullWarned = new Set();
    const bankChip = (pixels, what) => {
        const hit = bank.add(pixels);
        if (!hit && !fullWarned.has(what)) {
            fullWarned.add(what);
            warn(`the save's two sheets are full (${USER_CHIP_COUNT} chips): ${what} art left unpainted`);
        }
        return hit;
    };
    const rows = []; // report: palette rows written

    // --- the ship: the level's own poses on the factory sheet ---
    // MY SHIP GROUP stays the factory's — its shots, the enemy bullets, items
    // and explosions are the ROM's art, drawn through rows 20 and 21 — but
    // for the three poses the player handler names: chips 0-3 banking left,
    // 4-7 level, 8-11 banking right, each TL TR BL BR as the four 16x16 OBJs
    // the ship is drawn with, through OBJ palette 7 <- row 18, which nothing
    // else draws through, so the row is the ship's. Chips 12-15 are never
    // named in play and keep the factory's words. The level's first frame is
    // the level pose and its second (else the first) the bank, mirrored for
    // the right, as the Kids! writer lays its ship out; a level with no ship
    // frames flies Duke, who ships with the engine, so no cart is flown by an
    // invisible ship. Painted first: it is the one thing every stage draws.
    bytes.set(SFC_FACTORY_GLOBAL_ROWS, REGION.palette.offset + PALETTE_ROW_SHIP * 32);
    const shipWords = Uint16Array.from(SFC_FACTORY_SHIP_WORDS);
    let shipFrames = ((level.playerData && level.playerData.texture) || []).map(lookup).filter(Boolean);
    let shipSource = "level";
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }
    const shipLevel = fitRgba(shipFrames[0], SFC_SHIP_POSE_PX, SFC_SHIP_POSE_PX);
    const shipBank = shipFrames.length > 1 ? fitRgba(shipFrames[1], SFC_SHIP_POSE_PX, SFC_SHIP_POSE_PX) : shipLevel;
    const shipQuant = quantizeToRow([
        { key: "left", ...shipBank },
        { key: "centre", ...shipLevel },
        { key: "right", ...hflipRgba(shipBank) },
    ]);
    writeCgramRow(bytes, PALETTE_ROW_SHIP, shipQuant.words);
    rows.push({ row: PALETTE_ROW_SHIP, owner: "ship", colors: shipQuant.colors });
    // The ship sheet ignores a group word's own flip bits: a mirrored chip
    // written through them drew the right-bank pose with its halves swapped
    // and unmirrored (OpenEmu and Mesen, 2026-10-16). Its flips are MY SHIP
    // ODR's, one byte a slot with H in bit 6 and V in bit 7 ($00:9D8B), as
    // ENEMY ODR carries the enemies', so a shared mirror goes there and the
    // word stays plain.
    const shipOdr = new Uint8Array(MY_SHIP_ODR_BYTES);
    let shipChips = 0;
    const poseSlots = [SFC_SHIP_POSE_SLOTS.left, SFC_SHIP_POSE_SLOTS.centre, SFC_SHIP_POSE_SLOTS.right];
    shipQuant.frames.forEach((f, p) => {
        for (let cy = 0; cy < 2; cy++) {
            for (let cx = 0; cx < 2; cx++) {
                const px = cutChip(f.indices, SFC_SHIP_POSE_PX, cx, cy);
                const slot = poseSlots[p] + cy * 2 + cx;
                let word = CHIP_BLANK_WORD;
                if (!isTransparent(px)) {
                    const hit = bankChip(px, "ship");
                    if (hit) {
                        word = chipWordForIndex(hit.chip);
                        shipOdr[slot] = (hit.hflip ? ODR_HFLIP : 0) | (hit.vflip ? ODR_VFLIP : 0);
                        shipChips++;
                    }
                }
                shipWords[slot] = word;
            }
        }
    });
    writeWords(bytes, REGION.myShipGroup.offset, shipWords);
    bytes.set(shipOdr, REGION.myShipOdr.offset);

    // --- the title picture: the title editor's backdrop, logo and subtitle ---
    // Row 19 was set with the factory rows above; a level with no title art
    // keeps it and the blank group, as the sample's is.
    let title = "none";
    const titleParts = [["logo", opts.title1], ["subtitle", opts.title2], ["backdrop", opts.titleBg]]
        .filter(([, f]) => f && f.rgba).map(([what]) => what);
    const picture = composeTitlePicture({ logo: opts.title1, subtitle: opts.title2, backdrop: opts.titleBg });
    if (picture) {
        const q = quantizeToRow([{ key: "title", ...picture }]);
        writeCgramRow(bytes, PALETTE_ROW_TITLE, q.words);
        rows.push({ row: PALETTE_ROW_TITLE, owner: "title", colors: q.colors });
        // The group is not the 8x4 picture row-major: two 4-wide halves, the
        // left in slots 0-15 and the right in 16-31 (titleSlotForCell).
        const words = new Uint16Array(TITLE_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
        for (let cy = 0; cy < SFC_TITLE_ROWS; cy++) {
            for (let cx = 0; cx < SFC_TITLE_COLS; cx++) {
                const px = cutChip(q.frames[0].indices, picture.w, cx, cy);
                if (isTransparent(px)) continue;
                const hit = bankChip(px, "title");
                if (hit) words[titleSlotForCell(cx, cy)] = chipWordForIndex(hit.chip, hit);
            }
        }
        writeWords(bytes, REGION.titleGroup.offset, words);
        title = "uploaded";
    }

    // --- per stage ---
    const built = plan.map(({ st, bossRec, form }, s) => {
        const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : (level.width || 8));
        const stageReport = { key: st.key, placements: 0, records: 0, lines: 0, enemies: [], boss: null, mapChips: 0, cellsDrawn: 0, rowsDrawn: 0, story: null };

        // Scenery: the level's 16x16 cell grid, one chip a cell, centred.
        const mapGroup = new Uint16Array(MAP_GROUP_CHIPS).fill(CHIP_EMPTY_WORD);
        mapGroup[0] = CHIP_BLANK_WORD;
        const mapSlotOfChip = new Map(); // chip index -> slot
        const cells = []; // 128 rows x 16 of {slot, hflip, vflip}
        for (let r = 0; r < MAP_ROWS; r++) cells.push(Array.from({ length: MAP_COLUMNS }, () => ({ slot: 0, hflip: false, vflip: false })));
        const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
        if (st.background && st.background.tiles && cellsList) {
            try {
                const tileBytes = b64ToBytes(st.background.tiles);
                const cols = st.background.cols || 14;
                const tiles = new Uint16Array(tileBytes.length >> 1);
                for (let i = 0; i < tiles.length; i++) tiles[i] = (tileBytes[i * 2] << 8) | tileBytes[i * 2 + 1];
                const gridRows = Math.floor(tiles.length / cols);
                if (gridRows > MAP_ROWS) warn(`${st.key}: the scenery grid is ${gridRows} rows; a stage map holds ${MAP_ROWS} — the rest is left out`);
                // every distinct cell ordinal used, quantised together into row s
                const ordinals = new Set();
                for (let r = 0; r < Math.min(gridRows, MAP_ROWS); r++) {
                    for (let c = 0; c < cols; c++) {
                        const w = tiles[r * cols + c];
                        if (w !== 0xffff) ordinals.add(w & 0x3ff);
                    }
                }
                const frames = [];
                for (const o of ordinals) {
                    const f = lookup(cellsList[o]);
                    if (f) frames.push({ key: `cell${o}`, ...fitRgba(f, CHIP_DIM, CHIP_DIM) });
                }
                const q = quantizeToRow(frames);
                if (frames.length) {
                    writeCgramRow(bytes, PALETTE_ROW_STAGE_BG + s, q.words);
                    rows.push({ row: PALETTE_ROW_STAGE_BG + s, owner: `${st.key} scenery`, colors: q.colors });
                }
                const indexedOf = new Map(q.frames.map((f) => [f.key, f.indices]));
                const firstCol = Math.max(0, Math.floor((MAP_COLUMNS - cols) / 2));
                let slotsFull = false;
                for (let r = 0; r < Math.min(gridRows, MAP_ROWS); r++) {
                    for (let c = 0; c < cols; c++) {
                        const mc = firstCol + c;
                        if (mc >= MAP_COLUMNS) continue;
                        const w = tiles[r * cols + c];
                        if (w === 0xffff) continue;
                        const px = indexedOf.get(`cell${w & 0x3ff}`);
                        if (!px || isTransparent(px)) continue;
                        const hit = bankChip(px, `${st.key} scenery`);
                        if (!hit) continue;
                        let slot = mapSlotOfChip.get(hit.chip);
                        if (slot === undefined) {
                            if (mapSlotOfChip.size >= MAP_GROUP_CHIPS - 1) {
                                if (!slotsFull) warn(`${st.key}: more than ${MAP_GROUP_CHIPS - 1} distinct scenery chips; the rest are left blank`);
                                slotsFull = true;
                                continue;
                            }
                            slot = mapSlotOfChip.size + 1;
                            mapSlotOfChip.set(hit.chip, slot);
                            mapGroup[slot] = chipWordForIndex(hit.chip);
                        }
                        cells[r][mc] = { slot, hflip: ((w & 0x8000) !== 0) !== hit.hflip, vflip: ((w & 0x4000) !== 0) !== hit.vflip };
                        stageReport.cellsDrawn++;
                        stageReport.rowsDrawn = Math.max(stageReport.rowsDrawn, r + 1);
                    }
                }
                stageReport.mapChips = mapSlotOfChip.size;
            } catch (e) {
                warn(`${st.key}: could not read the background grid (${e.message}) — scenery skipped`);
            }
        }
        // The story (buildWithStory picked its size): the stage's opening
        // rows, in the scenery's palette row, which a stage with scenery of
        // its own was never given a story to share. Map rows count up the
        // screen, so the raster's top row of chips is the story's top row.
        const story = opts.storyPicks ? opts.storyPicks.get(s) : null;
        if (story && !stageReport.mapChips) {
            writeCgramRow(bytes, PALETTE_ROW_STAGE_BG + s, story.q.words);
            rows.push({ row: PALETTE_ROW_STAGE_BG + s, owner: `${st.key} story`, colors: story.q.colors });
            const before = bank.used;
            const cols = MAP_COLUMNS - 2 * SFC_STORY_FIRST_COL;
            for (let cy = 0; cy < story.rows; cy++) {
                for (let cx = 0; cx < cols; cx++) {
                    const px = cutChip(story.q.frames[0].indices, cols * CHIP_DIM, cx, cy);
                    if (isTransparent(px)) continue;
                    const hit = bankChip(px, `${st.key} story`);
                    if (!hit) continue;
                    let slot = mapSlotOfChip.get(hit.chip);
                    if (slot === undefined) {
                        if (mapSlotOfChip.size >= MAP_GROUP_CHIPS - 1) continue;
                        slot = mapSlotOfChip.size + 1;
                        mapSlotOfChip.set(hit.chip, slot);
                        mapGroup[slot] = chipWordForIndex(hit.chip);
                    }
                    cells[SFC_STORY_TOP_ROW - cy][SFC_STORY_FIRST_COL + cx] = { slot, hflip: hit.hflip, vflip: hit.vflip };
                }
            }
            stageReport.story = { size: story.label, rows: story.rows, chips: bank.used - before, top: SFC_STORY_TOP_ROW };
        }
        const mapAt = REGION.map.offset + s * MAP_STAGE_BYTES;
        for (let r = 0; r < MAP_ROWS; r++) encodeMapRow(bytes, mapAt + r * MAP_ROW_BYTES, cells[r]);
        writeWords(bytes, REGION.mapGroup.offset + s * MAP_GROUP_STAGE_BYTES, mapGroup);
        // Its blocks are shown once, as the stage opens, and never again.
        if (stageReport.story) {
            writeScrollSequence(bytes, s, storyScrollSequence(Math.ceil((SFC_STORY_TOP_ROW + 1) / MAP_BLOCK_ROWS)));
        }
        const storyShift = stageReport.story ? SFC_STORY_TOP_ROW + 1 + SFC_STORY_LEAD_LINES : 0;

        // Enemies: an entry a letter-and-drop, its frames in the stage's sheet.
        const spawnRows = st.enemylist.slice().reverse();
        const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
        const usage = new Map(); // letter -> {count, digits}
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
        const counts = SFC_ENEMY_CLASSES.map(() => 0);
        const enemyGroup = new Uint16Array(ENEMY_GROUP_CHIPS).fill(CHIP_EMPTY_WORD);
        enemyGroup[0] = CHIP_BLANK_WORD;
        const sheetSlotOfChip = new Map(); // chip index -> slot 1..63
        const odr = new Uint8Array(ENEMY_ODR_STAGE_BYTES);
        const entryData = new Uint8Array(ENEMY_STAGE_BYTES);
        const records = new Map(); // "A1" -> {klass, entry}
        let sheetFull = false;
        // all of a stage's enemy frames share palette row 6+s
        const enemyFrames = [];
        const framesOf = new Map();
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) continue;
            const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
            framesOf.set(letter, frames);
            for (const f of frames) if (!enemyFrames.some((e) => e.key === f.key)) enemyFrames.push(f);
        }
        const quant = quantizeToRow(enemyFrames.map((f) => ({ key: f.key, w: f.w, h: f.h, rgba: f.rgba })));
        if (enemyFrames.length) {
            writeCgramRow(bytes, PALETTE_ROW_STAGE_ENEMY + s, quant.words);
            rows.push({ row: PALETTE_ROW_STAGE_ENEMY + s, owner: `${st.key} enemies`, colors: quant.colors });
        }
        const indexedByKey = new Map(quant.frames.map((f) => [f.key, f]));
        const sheetSlot = (px) => {
            if (isTransparent(px)) return { slot: 0, hflip: false, vflip: false };
            const hit = bankChip(px, `${st.key} enemy`);
            if (!hit) return null;
            let slot = sheetSlotOfChip.get(hit.chip);
            if (slot === undefined) {
                if (sheetSlotOfChip.size >= ENEMY_GROUP_CHIPS - 1) {
                    if (!sheetFull) warn(`${st.key}: the enemy sheet is full (${ENEMY_GROUP_CHIPS - 1} chips); later enemies draw blank`);
                    sheetFull = true;
                    return null;
                }
                slot = sheetSlotOfChip.size + 1;
                sheetSlotOfChip.set(hit.chip, slot);
                enemyGroup[slot] = chipWordForIndex(hit.chip);
            }
            return { slot, hflip: hit.hflip, vflip: hit.vflip };
        };
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) {
                warn(`${st.key}: grid names enemy${letter} but enemyData has no such record — cells left empty`);
                continue;
            }
            const frames = framesOf.get(letter) || [];
            if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas — placed invisible`);
            const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
            const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
            if (frames.length && (maxW > 64 || maxH > 64)) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; a sprite tops out at 64x64 — downscaled`);
            const wanted = sfcClassFor(maxW, maxH);
            let klass = CLASS_FALLBACKS[wanted].find((k) => counts[k] < SFC_ENEMY_CLASSES[k].entries);
            if (klass === undefined) {
                warn(`${st.key}: no free entry for enemy${letter} (${rec.name || "?"}) — a stage holds 16 + 16 + 16 + 8 + 4 — cells left empty`);
                continue;
            }
            const spec = SFC_ENEMY_CLASSES[klass];
            // the drop digits: one entry per digit, as the Saturn writer, since an entry's drop is a bit
            const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
            const speed = Number.isFinite(rec.speed) ? Math.max(0.5, rec.speed) : 1;
            const interval = Number(rec.interval);
            const fires = Number.isFinite(interval) && interval > 0;
            const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 1);
            const fields = {
                family: SFC_MOVE_STRAIGHT,
                variant: nearestIndex(SFC_STRAIGHT_SPEEDS, speed),
                aim: fires ? SFC_DEFAULT_AIM : 0,
                rate: fires ? nearestIndex(SFC_SHOT_RATES, clamp(interval, 0, 31)) : 0,
                shotType: 0,
                hp: hits === Infinity ? SFC_ENEMY_HP.length - 1 : hits <= 1 ? 0 : nearestIndex(SFC_ENEMY_HP, hits * SFC_HIT_UNITS),
                flags: 0,
                score: nearestIndex(SFC_ENEMY_SCORE, Number(rec.score) || 100),
                anim: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex(SFC_ANIM_INTERVALS, 60 / rec.frameRate) : 3,
            };
            let first = null;
            for (const digit of digits) {
                const k = first ? CLASS_FALLBACKS[klass].find((c) => counts[c] < SFC_ENEMY_CLASSES[c].entries) : klass;
                if (k === undefined) {
                    warn(`${st.key}: enemy${letter} carries several drop digits and the stage is out of entries — its drop-${digit} cells ${first.itemDrop ? "drop an item" : "drop nothing"} too`);
                    records.set(letter + digit, first);
                    continue;
                }
                const kspec = SFC_ENEMY_CLASSES[k];
                const entry = counts[k]++;
                const itemDrop = digit !== "0";
                entryData.set(encodeEnemyEntry({ ...fields, itemDrop }), kspec.base + entry * ENEMY_ENTRY_BYTES);
                // frames: the class's count, each cut into cols x rows chips, frame-major
                const chipsPerFrame = kspec.cols * kspec.rows;
                spreadFrames(frames, kspec.frames).forEach((f, fi) => {
                    const q = indexedByKey.get(f.key);
                    if (!q) return;
                    const fitted = fitIndexed(q, kspec.w, kspec.h);
                    for (let cy = 0; cy < kspec.rows; cy++) {
                        for (let cx = 0; cx < kspec.cols; cx++) {
                            const ref = sheetSlot(cutChip(fitted, kspec.w, cx, cy));
                            if (!ref) continue;
                            odr[kspec.odrBase + entry * chipsPerFrame * kspec.frames + fi * chipsPerFrame + cy * kspec.cols + cx] = encodeOdrByte(ref);
                        }
                    }
                });
                const made = { klass: k, entry, itemDrop, name: rec.name || `enemy${letter}`, cell: letter + digit, frames: frames.length };
                records.set(letter + digit, made);
                if (!first) first = made;
                stageReport.enemies.push({ name: made.name, cell: made.cell, klass: k, entry, size: `${kspec.w}x${kspec.h}`, frames: Math.min(kspec.frames, Math.max(1, frames.length)), itemDrop });
            }
        }

        // The boss: its art in the 32-chip sheet, wide (8x4) or tall (4x8)
        // as the art draws larger, the sample's block with its hit points
        // and score.
        const bossWords = new Uint16Array(BOSS_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
        const bossBlock = Uint8Array.from(SFC_FACTORY_BOSS_BLOCK);
        let boss = null;
        if (bossRec) {
            const names = bossRec.anim && Array.isArray(bossRec.anim.idle)
                ? [...bossRec.anim.idle, ...(Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : [])]
                : Array.isArray(bossRec.texture) ? bossRec.texture : [];
            const frames = names.map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas — drawn blank`);
            const tall = frames.length > 0 && sfcBossIsTall(frames[0].w, frames[0].h);
            const cols = tall ? BOSS_SHEET_ROWS : BOSS_SHEET_COLS, rowsOf = tall ? BOSS_SHEET_COLS : BOSS_SHEET_ROWS;
            const boxW = cols * CHIP_DIM, boxH = rowsOf * CHIP_DIM;
            if (frames.length && (frames[0].w > boxW || frames[0].h > boxH)) {
                warn(`${st.key}: boss (${bossRec.name || "?"}) is ${frames[0].w}x${frames[0].h}; a ${tall ? "tall" : "wide"} Super Famicom boss is ${boxW}x${boxH} — downscaled`);
            }
            if (frames.length) {
                const fitted = fitRgba(frames[0], boxW, boxH);
                const q = quantizeToRow([{ key: "boss", ...fitted }]);
                writeCgramRow(bytes, PALETTE_ROW_STAGE_BOSS + s, q.words);
                rows.push({ row: PALETTE_ROW_STAGE_BOSS + s, owner: `${st.key} boss`, colors: q.colors });
                // The block's layout bit (byte 6 bit 6, below) says how the
                // 32 slots sit on screen (bossSlotForCell): wide, they are
                // not the 8x4 picture row-major but two 4-wide halves, the
                // left in slots 0-15 and the right in 16-31 (row-major
                // scattered rando's Ryu); tall, they are the 4x8 picture
                // row-major, 0-15 the top half.
                for (let cy = 0; cy < rowsOf; cy++) {
                    for (let cx = 0; cx < cols; cx++) {
                        const px = cutChip(q.frames[0].indices, fitted.w, cx, cy);
                        if (isTransparent(px)) continue;
                        const hit = bankChip(px, `${st.key} boss`);
                        if (hit) bossWords[bossSlotForCell(cx, cy, tall)] = chipWordForIndex(hit.chip, hit);
                    }
                }
            }
            const hits = bossRec.hp === "infinity" ? Infinity : Math.max(1, Number(bossRec.hp) || 100);
            bossBlock[0x0d] = (bossBlock[0x0d] & 0xf8) | (hits === Infinity ? SFC_BOSS_HP.length - 1 : nearestIndex(SFC_BOSS_HP, hits * SFC_HIT_UNITS));
            // The layout bit is also the body: wide a 96x48 box, tall 48x96.
            if (tall) bossBlock[6] |= 0x40;
            else bossBlock[6] &= ~0x40;
            boss = { name: bossRec.name || `boss${s}`, hits, hpIndex: bossBlock[0x0d] & 7, frames: frames.length, tall };
            if (form) boss.form = form;
        }
        writeWords(bytes, REGION.bossGroup.offset + s * BOSS_GROUP_STAGE_BYTES, bossWords);
        entryData.set(bossBlock, BOSS_BLOCK_OFFSET);

        // APPEAR: a record per wave (de-duplicated), fired by its line.
        const appear = new Uint8Array(APPEAR_STAGE_BYTES);
        appear.fill(0xff, APPEAR_RECORD_END * APPEAR_RECORD_BYTES, (APPEAR_RECORD_END + 1) * APPEAR_RECORD_BYTES);
        const lines = appear.subarray(APPEAR_TABLE_B_OFFSET, APPEAR_TABLE_B_OFFSET + APPEAR_LINES);
        const recordIndex = new Map(); // key -> index
        let nextRecord = APPEAR_RECORD_END + 1;
        let recordsFull = false;
        const addRecord = (record) => {
            const key = Array.from(record).join(",");
            if (recordIndex.has(key)) return recordIndex.get(key);
            if (nextRecord >= APPEAR_RECORDS) {
                if (!recordsFull) warn(`${st.key}: more than ${APPEAR_RECORDS - 2} distinct spawn lines; the rest are left out`);
                recordsFull = true;
                return null;
            }
            const index = nextRecord++;
            appear.set(record, index * APPEAR_RECORD_BYTES);
            recordIndex.set(key, index);
            return index;
        };
        let lastLine = -1, placed = 0, dropped = 0;
        spawnRows.forEach((row, k) => {
            const line = clamp((waveRows ? Math.round(waveRows[k]) : SFC_FIRST_SPAWN_LINE + k * SFC_LINE_STEP) + storyShift, 0, SFC_LAST_SPAWN_LINE);
            const record = new Uint8Array(APPEAR_RECORD_BYTES);
            let any = false;
            row.forEach((cell, c) => {
                if (!cell || cell === "00") return;
                const made = records.get(cell);
                if (!made) return;
                const column = sfcSpawnColumn(c, width);
                const at = column - APPEAR_FIRST_COLUMN;
                if (record[at]) {
                    dropped++;
                    return;
                }
                record[at] = encodeAppearByte({ klass: made.klass, entry: made.entry });
                any = true;
                placed++;
            });
            if (!any) return;
            if (lines[line]) {
                // two waves on one line: merge where the columns are free
                const prev = appear.subarray(lines[line] * APPEAR_RECORD_BYTES, (lines[line] + 1) * APPEAR_RECORD_BYTES);
                const merged = Uint8Array.from(prev);
                record.forEach((b, i) => {
                    if (!b) return;
                    if (merged[i]) dropped++;
                    else merged[i] = b;
                });
                const idx = addRecord(merged);
                if (idx !== null) lines[line] = idx;
                lastLine = Math.max(lastLine, line);
                return;
            }
            const idx = addRecord(record);
            if (idx === null) return;
            lines[line] = idx;
            lastLine = Math.max(lastLine, line);
        });
        if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} shared a column with another on the same line and ${dropped === 1 ? "was" : "were"} left out`);
        if (boss) {
            const line = clamp(
                Math.max(lastLine + SFC_BOSS_LINE_GAP, stageReport.story ? SFC_STORY_MIN_BOSS_LINE : 0),
                SFC_BOSS_LINE_GAP,
                SFC_LAST_SPAWN_LINE,
            );
            const record = new Uint8Array(APPEAR_RECORD_BYTES);
            record[Math.floor(APPEAR_COLUMNS / 2)] = encodeAppearByte({ klass: APPEAR_BOSS_CLASS, entry: 0 });
            const idx = addRecord(record);
            if (idx !== null) lines[line] = idx;
            boss.line = line;
            lastLine = Math.max(lastLine, line);
        }
        stageReport.placements = placed;
        stageReport.records = nextRecord - 2;
        stageReport.lines = lastLine + 1;
        stageReport.boss = boss;

        bytes.set(entryData, REGION.enemyData.offset + s * ENEMY_STAGE_BYTES);
        bytes.set(appear, REGION.appear.offset + s * APPEAR_STAGE_BYTES);
        bytes.set(odr, REGION.enemyOdr.offset + s * ENEMY_ODR_STAGE_BYTES);
        writeWords(bytes, REGION.enemyGroup.offset + s * ENEMY_GROUP_STAGE_BYTES, enemyGroup);
        return stageReport;
    });

    bank.writeTo(bytes);
    sealSfcChecksums(bytes);

    const report = {
        name,
        stages: built,
        chips: { used: bank.used, capacity: USER_CHIP_COUNT, shared: bank.shared, free: USER_CHIP_COUNT - bank.used },
        rows,
        ship: shipSource,
        shipChips,
        title,
        titleParts,
        sound: "factory",
        transform,
        splits,
    };
    return { bytes, name, warnings, report };
}

/**
 * The story pass. A cart has no cutscenes, but a stage opens on its first map
 * rows, so each stage's story (the Saturn's `storyBackdrops`) is painted
 * there, in the stage's scenery palette row, from SFC_STORY_TOP_ROW down.
 * The story is the last art on the cart: a build without it says how many of
 * the 512 chips the game leaves, then every stage's story is taken at the
 * largest size at which they all fit — each within a MAP GROUP's 127 distinct
 * chips and the map rows the opening screen shows — else each at its
 * smallest while chips last, and the image is built again with those painted
 * in. A stage with scenery of its own keeps it; a story with no room costs
 * its stage nothing.
 *
 * Unlike the Saturn, nothing slows the scroll — the cart advances it 1 px a
 * frame whatever SCROLL EFECT says — so a story stays about 224 frames: its
 * top on the screen's top row, its words first to be read.
 */
function buildWithStory(level, art, opts) {
    const dry = buildSfcGameFromLevel(level, art, { ...opts, storyBackdrops: null, storyPicks: null });
    const notes = [];
    const cols = MAP_COLUMNS - 2 * SFC_STORY_FIRST_COL;
    const candidates = [];
    for (const sb of opts.storyBackdrops) {
        const s = dry.report.stages.findIndex((st) => st.key === `stage${sb && sb.stage}`);
        if (s < 0) continue; // a story for a stage this cart does not have
        const key = dry.report.stages[s].key;
        if (dry.report.stages[s].mapChips > 0) {
            notes.push(`${key}: keeps its own scenery — its story is not drawn`);
            continue;
        }
        const variants = [];
        for (const v of Array.isArray(sb.variants) ? sb.variants : []) {
            if (!v || v.w !== cols * CHIP_DIM || !v.h || v.h % CHIP_DIM || !v.rgba) continue;
            const rows = v.h / CHIP_DIM;
            if (rows > SFC_STORY_TOP_ROW + 1) continue;
            const q = quantizeToRow([{ key: "story", w: v.w, h: v.h, rgba: v.rgba }]);
            const chips = new Set();
            for (let cy = 0; cy < rows; cy++) {
                for (let cx = 0; cx < cols; cx++) {
                    const px = cutChip(q.frames[0].indices, v.w, cx, cy);
                    if (!isTransparent(px)) chips.add(keyOf(px));
                }
            }
            if (chips.size > MAP_GROUP_CHIPS - 1) continue;
            variants.push({ label: v.label, rows, q, chips });
        }
        if (variants.length) candidates.push({ s, key, variants });
        else notes.push(`${key}: no size of its story fits a stage map (${cols * CHIP_DIM} px wide, ${SFC_STORY_TOP_ROW + 1} rows, ${MAP_GROUP_CHIPS - 1} distinct chips) — not drawn`);
    }
    const free = dry.report.chips.free;
    const cost = (picks) => new Set(picks.flatMap(({ v }) => [...v.chips])).size;
    const pickAt = (k) => candidates.map((c) => ({ c, v: c.variants[Math.min(k, c.variants.length - 1)] }));
    const sizes = Math.max(0, ...candidates.map((c) => c.variants.length));
    let picks = [];
    for (let k = 0; k < sizes && !picks.length; k++) {
        if (cost(pickAt(k)) <= free) picks = pickAt(k);
    }
    if (!picks.length && candidates.length) {
        for (const p of pickAt(sizes - 1)) {
            if (cost([...picks, p]) <= free) picks.push(p);
            else notes.push(`${p.c.key}: no chips left in the save's two sheets for its story — not drawn`);
        }
    }
    const built = buildSfcGameFromLevel(level, art, {
        ...opts,
        storyBackdrops: null,
        storyPicks: new Map(picks.map(({ c, v }) => [c.s, v])),
    });
    built.warnings.push(...notes);
    return built;
}

/** A frame's indices fitted to w x h (centred, never upscaled). */
function fitIndexed(frame, w, h) {
    if (frame.w === w && frame.h === h) return frame.indices;
    const out = new Uint8Array(w * h);
    const scale = Math.min(1, w / frame.w, h / frame.h);
    const fw = Math.max(1, Math.round(frame.w * scale)), fh = Math.max(1, Math.round(frame.h * scale));
    const ox = Math.floor((w - fw) / 2), oy = Math.floor((h - fh) / 2);
    for (let y = 0; y < fh; y++) {
        const sy = scale === 1 ? y : Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < fw; x++) {
            const sx = scale === 1 ? x : Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
            out[(oy + y) * w + ox + x] = frame.indices[sy * frame.w + sx];
        }
    }
    return out;
}

/**
 * Build the image and read it back: {sram, fileName, name, warnings, report}.
 * Throws when the parse disagrees with what was written — a checksum word
 * off, the magic missing — since such a file would be a cart the game
 * formats over on boot.
 */
export function exportLevelToSfcSram(level, art, options = {}) {
    const built = buildSfcGameFromLevel(level, art, options);
    const parsed = parseSfcSav(built.bytes);
    if (!parsed.isSfcSav) throw new Error("the built image does not read back as a Dezaemon save");
    if (parsed.errors.length) throw new Error(`the built image does not parse: ${parsed.errors.map((e) => `${e.block}: ${e.message}`).join("; ")}`);
    const v = verifySfcChecksums(built.bytes);
    if (!v.ok) throw new Error(`the built image's checksums do not verify: ${v.words.filter((w) => !w.ok).map((w) => w.name).join(", ")}`);
    if (built.bytes.length !== SRAM_SIZE) throw new Error(`the image is ${built.bytes.length} bytes, not ${SRAM_SIZE}`);
    return { sram: built.bytes, fileName: sfcSramFileName(built.name), name: built.name, warnings: built.warnings, report: built.report };
}
