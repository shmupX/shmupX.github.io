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
//     scenery, 6+n its enemies, 12+n its boss, 19 the title — and cut into
//     16x16 chips in the save's two GRAPIC DATA sheets, one copy per distinct
//     chip with mirrors shared through the flip bits;
//   - a stage's scenery is 128 rows of 16 chips naming MAP GROUP slots, the
//     first 128 rows of the level's grid, centred in the 256-px playfield;
//   - an enemy becomes an eight-byte entry of the class its art fits (16x16,
//     32x16, 16x32, 32x32, 64x64), its frames chips of the stage's 64-slot
//     enemy sheet named by ENEMY ODR, its waves spawn records of APPEAR
//     DATA fired by the line table, one line a map row;
//   - the boss is the 8x4-chip BOSS GROUP sheet with the sample's stage-0
//     block for its behaviour, spawned by a class-5 byte after the last wave;
//   - the ship, its shots, the enemy bullets, items and explosions are the
//     factory ship sheet (the ROM's art, read at play time), the sound is the
//     factory sample's (factory-data.js), and the CHECK SUM block is sealed
//     last. The image is read back through parseSfcSav before it leaves.
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
    USER_CHIP_COUNT,
} from "./chips.js";
import { encodeMapRow, MAP_COLUMNS, MAP_ROW_BYTES, MAP_ROWS, MAP_STAGE_BYTES, STAGE_COUNT } from "./map.js";
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
    TITLE_GROUP_CHIPS,
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
import { quantizeFrames } from "../palette/palette-target.js";
import { decodeFrameKey, fitRgba, levelStages, spreadFrames } from "../write/game-to-save.js";

/** The playfield's spawn columns 1..14, and the map row a wave spawns on when the level says nothing. */
export const SFC_FIRST_SPAWN_LINE = 2;
export const SFC_LINE_STEP = 4;
/** The boss spawns this many rows past the last wave (the engine warns eight rows ahead of it). */
export const SFC_BOSS_LINE_GAP = 12;
/** The last line a spawn may use: the stage is 1,024 lines, the END goes one past the last spawn. */
export const SFC_LAST_SPAWN_LINE = APPEAR_LINES - 2;
/** What one web-game hit is worth against the ENEMY DATA hit-point table (a guess: the plain shot's damage is untraced). */
export const SFC_HIT_UNITS = 25;
/** The aim value the sample's firing enemies carry (byte 1 bits 0-4; its pattern is untraced). */
export const SFC_DEFAULT_AIM = 13;
/** The title picture's shape: TITLE GROUP is 32 chips as 8 x 4. */
export const SFC_TITLE_COLS = 8;
export const SFC_TITLE_ROWS = 4;

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
 * values are 1..15 of that row.
 */
export function quantizeToRow(frames) {
    if (!frames.length) return { frames: [], words: [], colors: 0 };
    const q = quantizeFrames(frames.map((f, i) => ({ ...f, key: f.key ?? `f${i}`, group: "row" })), "snes", { firstRow: 0, rows: 1 });
    const words = [];
    for (let k = 1; k < 16; k++) {
        const w = q.bank[k];
        words.push(w ? w & 0x7fff : 0);
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
 * Build the image. `art` maps atlas frame names to {w, h, rgba}. Options:
 * `name` (the game's name, for the file; a Super Famicom save carries no
 * text name), `title1` ({w, h, rgba}, the title picture), `horizontal`
 * (refused with a warning: the cart scrolls vertically).
 *
 * Returns {bytes, name, warnings, report}.
 */
export function buildSfcGameFromLevel(level, art, options = {}) {
    const opts = { name: null, title1: null, horizontal: false, ...options };
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

    // --- the ship, items, bullets, explosions: the factory sheet and its rows ---
    writeWords(bytes, REGION.myShipGroup.offset, SFC_FACTORY_SHIP_WORDS);
    bytes.set(SFC_FACTORY_GLOBAL_ROWS, REGION.palette.offset + PALETTE_ROW_SHIP * 32);

    // --- the title picture ---
    let title = "none";
    if (opts.title1 && opts.title1.rgba) {
        const fitted = fitRgba(opts.title1, SFC_TITLE_COLS * CHIP_DIM, SFC_TITLE_ROWS * CHIP_DIM);
        const q = quantizeToRow([{ key: "title", ...fitted }]);
        writeCgramRow(bytes, PALETTE_ROW_TITLE, [0, ...q.words]);
        rows.push({ row: PALETTE_ROW_TITLE, owner: "title", colors: q.colors });
        const words = new Uint16Array(TITLE_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
        for (let cy = 0; cy < SFC_TITLE_ROWS; cy++) {
            for (let cx = 0; cx < SFC_TITLE_COLS; cx++) {
                const px = cutChip(q.frames[0].indices, fitted.w, cx, cy);
                if (isTransparent(px)) continue;
                const hit = bankChip(px, "title");
                if (hit) words[cy * SFC_TITLE_COLS + cx] = chipWordForIndex(hit.chip, hit);
            }
        }
        writeWords(bytes, REGION.titleGroup.offset, words);
        title = "uploaded";
    } else {
        // the title row still needs colours for the factory title words a
        // blank group would not draw anyway; leave the row as the sample's
        bytes.set(SFC_FACTORY_GLOBAL_ROWS.slice(32, 64), REGION.palette.offset + PALETTE_ROW_TITLE * 32);
    }

    // --- per stage ---
    const built = stages.map((st, s) => {
        const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : (level.width || 8));
        const stageReport = { key: st.key, placements: 0, records: 0, lines: 0, enemies: [], boss: null, mapChips: 0, cellsDrawn: 0, rowsDrawn: 0 };

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
                    writeCgramRow(bytes, PALETTE_ROW_STAGE_BG + s, [0, ...q.words]);
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
        const mapAt = REGION.map.offset + s * MAP_STAGE_BYTES;
        for (let r = 0; r < MAP_ROWS; r++) encodeMapRow(bytes, mapAt + r * MAP_ROW_BYTES, cells[r]);
        writeWords(bytes, REGION.mapGroup.offset + s * MAP_GROUP_STAGE_BYTES, mapGroup);

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
            writeCgramRow(bytes, PALETTE_ROW_STAGE_ENEMY + s, [0, ...quant.words]);
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

        // The boss: its art in the 8x4 sheet, the sample's block with its hit points and score.
        const bossRec = bossData[`boss${s}`] || (s === 0 && stages.length === 1 ? bossData.boss0 : null);
        const bossWords = new Uint16Array(BOSS_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
        const bossBlock = Uint8Array.from(SFC_FACTORY_BOSS_BLOCK);
        let boss = null;
        if (bossRec) {
            const names = bossRec.anim && Array.isArray(bossRec.anim.idle)
                ? [...bossRec.anim.idle, ...(Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : [])]
                : Array.isArray(bossRec.texture) ? bossRec.texture : [];
            const frames = names.map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas — drawn blank`);
            if (frames.length && (frames[0].w > BOSS_SHEET_COLS * CHIP_DIM || frames[0].h > BOSS_SHEET_ROWS * CHIP_DIM)) {
                warn(`${st.key}: boss (${bossRec.name || "?"}) is ${frames[0].w}x${frames[0].h}; a Super Famicom boss is 128x64 — downscaled`);
            }
            if (frames.length) {
                const fitted = fitRgba(frames[0], BOSS_SHEET_COLS * CHIP_DIM, BOSS_SHEET_ROWS * CHIP_DIM);
                const q = quantizeToRow([{ key: "boss", ...fitted }]);
                writeCgramRow(bytes, PALETTE_ROW_STAGE_BOSS + s, [0, ...q.words]);
                rows.push({ row: PALETTE_ROW_STAGE_BOSS + s, owner: `${st.key} boss`, colors: q.colors });
                for (let cy = 0; cy < BOSS_SHEET_ROWS; cy++) {
                    for (let cx = 0; cx < BOSS_SHEET_COLS; cx++) {
                        const px = cutChip(q.frames[0].indices, fitted.w, cx, cy);
                        if (isTransparent(px)) continue;
                        const hit = bankChip(px, `${st.key} boss`);
                        if (hit) bossWords[cy * BOSS_SHEET_COLS + cx] = chipWordForIndex(hit.chip, hit);
                    }
                }
            }
            const hits = bossRec.hp === "infinity" ? Infinity : Math.max(1, Number(bossRec.hp) || 100);
            bossBlock[0x0d] = (bossBlock[0x0d] & 0xf8) | (hits === Infinity ? SFC_BOSS_HP.length - 1 : nearestIndex(SFC_BOSS_HP, hits * SFC_HIT_UNITS));
            bossBlock[6] &= ~0x40; // wide: the sheet as drawn, 128x64
            boss = { name: bossRec.name || `boss${s}`, hits, hpIndex: bossBlock[0x0d] & 7, frames: frames.length };
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
            const line = clamp(waveRows ? Math.round(waveRows[k]) : SFC_FIRST_SPAWN_LINE + k * SFC_LINE_STEP, 0, SFC_LAST_SPAWN_LINE);
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
            const line = clamp(lastLine + SFC_BOSS_LINE_GAP, SFC_BOSS_LINE_GAP, SFC_LAST_SPAWN_LINE);
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
        ship: "factory",
        title,
        sound: "factory",
    };
    return { bytes, name, warnings, report };
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
