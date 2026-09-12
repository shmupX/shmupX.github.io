// Dezaemon Kids! (Athena, 1998, SLPS-01503) — the save block.
//
// The file is one 15-block, 0x1E000-byte memory-card save named
// BISLPS-01503DEZAKIDS. After the "SC" title frame and one icon frame comes,
// at 0x100, an eleven-word little-endian directory, and the game is stored in
// the same Okumura LZSS the Saturn Dezaemon 2 uses for its save sections
// (src/decompress.js). Everything below is traced from KIDS.EXE and its
// play-mode overlay GAMES.bin off the disc (see FORMAT-PSX.md); the strides
// were then checked against all 98 community saves.
//
// The directory, from the saver at 0x80071884:
//
//   word  meaning
//    0    end of the last section = word 7 + 0x100; only this many bytes are
//         written, so everything past it is stale card content
//    1    graphics section, compressed size (exact)
//    2    data section, compressed size (exact)
//    3    graphics section offset — always 0x180
//    4    byte sum of the graphics section over its 0x80-padded length
//    5    data section offset = 0x180 + padded graphics size
//    6    byte sum of the data section over its 0x80-padded length
//    7    tail offset = data offset + padded data size (0x100 bytes, raw)
//    8    byte sum of the tail
//    9    graphics section size padded to 0x80 (one card sector)
//   10    data section size padded to 0x80
//
// The padding inside a padded span is stale staging-buffer content, not zero
// (96 of the 98 saves have non-zero padding), which is why the checksums are
// taken over the padded span and not the exact one.
//
// The two sections are the game's live RAM, which is also how the disc's own
// sample games are stored (SGM_*.CMP in KIDS_DAT.BIN decompress to exactly
// these two blocks concatenated):
//
//   graphics -> 262,144 B at RAM 0x80010000: four 64 KB Dezaemon 2 CG pages,
//               256 cells of 16x16 at 8 bits per pixel, eight cells to a row.
//               The colours are NOT in the save — see kids-palette.js.
//   data     -> 64,712 B (0xFCC8) at RAM 0x80050000: the seven regions below.
//   tail     -> 0x100 B at RAM 0x8005FCC8, raw: ten high scores, then options.
//
// Environment-neutral ESM (Node + browser).

import { decompress } from "../decompress.js";
import { CG_PAGE_SIZE, decodeCgPage } from "../decode/decode-cg.js";
import { kidsPaletteRgb } from "./kids-palette.js";
import { latin1, u16le, u32le } from "./memcard.js";
import { bracketedName, narrow, parseSaveHeader } from "./save-header.js";

export const KIDS_PRODUCT = "BISLPS-01503DEZAKIDS";
export const KIDS_TITLE_PREFIX = "デザエモンＫｉｄｓ！";
export const KIDS_BLOCK_SIZE = 0x1e000;
export const KIDS_SECTOR = 0x80;
export const KIDS_TABLE_OFFSET = 0x100;
export const KIDS_TABLE_WORDS = 11;
export const KIDS_FIRST_SECTION = 0x180;
export const KIDS_TAIL_SIZE = 0x100;
export const KIDS_GRAPHICS_SIZE = 4 * CG_PAGE_SIZE; // 0x40000
export const KIDS_DATA_SIZE = 0xfcc8;
export const KIDS_CELL_COUNT = KIDS_GRAPHICS_SIZE / 256; // 1024
export const KIDS_STAGES = 6;

/** RAM the two sections and the tail decompress to (KIDS.EXE 0x80071884). */
export const KIDS_GRAPHICS_RAM = 0x80010000;
export const KIDS_DATA_RAM = 0x80050000;
export const KIDS_TAIL_RAM = 0x8005fcc8;

export const KIDS_HISCORE_COUNT = 10;
export const KIDS_HISCORE_SIZE = 16;
export const KIDS_OPTIONS_OFFSET = KIDS_HISCORE_COUNT * KIDS_HISCORE_SIZE; // 0xA0
/**
 * The settings really are 0x1C bytes: the factory initialiser stops at
 * +0xBB and no routine in KIDS.EXE or its overlays forms an address past it,
 * so +0xBC..+0xFF is uninitialised RAM the saver copies out with the rest.
 */
export const KIDS_OPTIONS_SIZE = 0x1c;
export const KIDS_TAIL_UNUSED_OFFSET = KIDS_OPTIONS_OFFSET + KIDS_OPTIONS_SIZE; // 0xBC
/** A high score's stage byte marks an all-clear with bit 7 (the writer stores 0x80). */
export const KIDS_ALL_CLEAR = 0x80;
/** Difficulty names, as the score table prints them for byte +5 (masked to 2 bits). */
export const KIDS_LEVELS = Object.freeze(["EASY", "NORMAL", "HARD", "MANIAC"]);
/** The level byte the invincible mode writes; its reader masks it away. */
export const KIDS_MUTEKI_LEVEL = 4;

// --- map ---------------------------------------------------------------------

/** A stage's map: 384 rows of 7 chips, one u16 each (14 bytes per row). */
export const KIDS_MAP_COLUMNS = 7;
export const KIDS_MAP_ROWS = 384;
export const KIDS_MAP_STAGE_BYTES = KIDS_MAP_COLUMNS * KIDS_MAP_ROWS * 2; // 0x1500
/** A map chip is 32x32 px: a 2x2 group of CG cells. */
export const KIDS_CHIP_DIM = 32;
export const KIDS_CELL_DIM = 16;
/**
 * Chip word bits. Bits 10-12 are never read by the engine and never set; nor
 * are bits 0 and 3 of the cell number, because a 2x2 group has to start on an
 * even column and an even row of the CG page (no exception in 530,520 chips).
 */
export const KIDS_CELL_MASK = 0x03ff;
/** A chip's top-left cell is 2x2-aligned: `(cell & KIDS_CELL_ALIGN) === 0`. */
export const KIDS_CELL_ALIGN = 0x9;
export const KIDS_HFLIP = 0x2000;
export const KIDS_VFLIP = 0x4000;
export const KIDS_BLANK = 0x8000;

// --- scroll ------------------------------------------------------------------

export const KIDS_SCROLL_STAGE_BYTES = 0x60;
/** Two 64-px units per byte, low nibble first: 192 units = 12,288 px. */
export const KIDS_SCROLL_UNITS = KIDS_SCROLL_STAGE_BYTES * 2;
export const KIDS_SCROLL_UNIT_PIXELS = 64;
/**
 * value & 3 -> px per frame, for a vertically scrolling game (GAMES.bin table
 * 0x80148318, read as 8.8 fixed point). A horizontal game scales the same
 * table differently. The editor reads the whole nibble, not just bits 0-1.
 */
export const KIDS_SCROLL_SPEEDS = Object.freeze([0, 0.25, 1, 4]);

// --- appear ------------------------------------------------------------------

export const KIDS_APPEAR_STAGE_BYTES = 0xd80;
export const KIDS_APPEAR_COLUMNS = 9;
export const KIDS_APPEAR_ROWS = 384;
export const KIDS_APPEAR_ROW_PIXELS = 32;
/**
 * A slot byte is `present(bit 7) | class(bits 4-6) | id(bits 0-3)`. The engine
 * masks the id to four bits for every class, but only class 0 ever uses more
 * than three of them: `count` is how many records the class's base reserves,
 * and no id above it occurs in any of the 98 saves.
 */
export const KIDS_APPEAR_CLASSES = Object.freeze([
    { klass: 0, size: "32x32", count: 16 },
    { klass: 1, size: "64x32", count: 8 },
    { klass: 2, size: "32x64", count: 8 },
    { klass: 3, size: "64x64", count: 8 },
]);
/** Cell sizes per class, from the editor's own table 0x800B2FBC. */
export const KIDS_APPEAR_CELLS = Object.freeze([[1, 1], [2, 1], [1, 2], [2, 2]]);
export const KIDS_APPEAR_PRESENT = 0x80;
export const KIDS_APPEAR_CLASS_MASK = 0x70;
export const KIDS_APPEAR_ID_MASK = 0x0f;
/** The class a footprint mark carries: a cell covered by a bigger neighbour. */
export const KIDS_APPEAR_FOOTPRINT_CLASS = 5;
/** The class the boss uses; only 0xC0 itself occurs in the collection. */
export const KIDS_APPEAR_BOSS_CLASS = 4;

// --- records -----------------------------------------------------------------

export const KIDS_RECORDS_STAGE_BYTES = 0xe6;
export const KIDS_RECORD_SIZE = 5;
export const KIDS_RECORD_COUNT = 40;
/** Record index = KIDS_CLASS_BASE[class] + id (GAMES.bin table 0x8014a274). */
export const KIDS_CLASS_BASE = Object.freeze([0x00, 0x10, 0x18, 0x20]);
export const KIDS_BOSS_OFFSET = 0xc8;
export const KIDS_BOSS_SIZE = 15;
export const KIDS_BOSS_COUNT = 2;
/** Boss byte 0 bits 6-7 = size class. */
export const KIDS_BOSS_SIZES = Object.freeze(["64x64", "128x64", "64x128", "128x128"]);

// --- sprite tables -----------------------------------------------------------

export const KIDS_SHIP_TABLE_BYTES = 0x1b4;
export const KIDS_SPRITE_STAGE_BYTES = 0x600;
/** Where each spawn class's cell entries start inside a stage's sprite table. */
export const KIDS_SPRITE_CLASS_OFFSETS = Object.freeze([0x000, 0x200, 0x300, 0x400]);
export const KIDS_SPRITE_ENTRY_WORDS = 16;
export const KIDS_SPRITE_BOSS_OFFSETS = Object.freeze([0x500, 0x580]);
export const KIDS_SPRITE_BOSS_WORDS = 64;

// --- config ------------------------------------------------------------------

/** Point-item values the config indexes (GAMES.bin 0x80149BFC / 0x80149C0C). */
export const KIDS_POINT_SMALL = Object.freeze([100, 500, 1000, 0]);
export const KIDS_POINT_LARGE = Object.freeze([5000, 10000, 50000, 0]);
/** Background-motion speeds bits 4-5 of the per-stage byte pick; 0 is static. */
export const KIDS_BG_SPEEDS = Object.freeze([0, 4, 12, 24]);
/** The four glyph files, which are also the glyph cell sizes. */
export const KIDS_FONT_FILES = Object.freeze(["FN1", "FN2", "FN3", "FN4"]);
/** A sound entry plays a BGM file unless bit 7 of its first byte is set. */
export const KIDS_BGM_BANKS = Object.freeze(["G_BGM1", "G_BGM2", "G_BGM3", "G_BGM4"]);

export const CONFIDENCES = Object.freeze(["confirmed", "likely", "open"]);

function region(name, label, offset, end, stride, confidence, note) {
    return Object.freeze({ name, label, offset, end, length: end - offset, stride, confidence, note });
}

/**
 * The data section's layout — offsets inside the decompressed 0xFCC8 bytes,
 * every boundary read off KIDS.EXE's per-stage initialiser 0x80075e30 and the
 * play-init pointer routine 0x80080958, then checked on all 98 saves.
 */
export const KIDS_REGIONS = Object.freeze([
    region("map", "MAP", 0x0000, 0x7e00, KIDS_MAP_STAGE_BYTES, "confirmed",
        "6 stages x 0x1500: 384 rows of 7 u16 chips. A chip is 32x32 px drawn from the CG cells n, n+1, n+8, n+9, so n is always 2x2-aligned; bits 0-9 name n, bit 13 h-flip, bit 14 v-flip, bit 15 blank (0x8080 and 0x8000 are the commonest of 14 blank words)."),
    region("scroll", "SCROLL", 0x7e00, 0x8040, KIDS_SCROLL_STAGE_BYTES, "confirmed",
        "6 x 0x60: one nibble per 64 px of map, low nibble first. value & 3 picks 0, 0.25, 1 or 4 px per frame; 0x22 is the fill."),
    region("appear", "APPEAR", 0x8040, 0xd140, KIDS_APPEAR_STAGE_BYTES, "confirmed",
        "6 x 0xD80: 384 rows of 9 slot bytes, one per 32 px across and down. A byte is present(bit 7) | class(bits 4-6) | id(bits 0-3); classes 0-3 are the enemy sizes, 4 the boss, and 5 a footprint mark (0x50 | dx << 2 | dy) giving the cell offset inside the owning enemy rectangle."),
    region("config", "CONFIG", 0xd140, 0xd1b0, 0, "confirmed",
        "0x70 bytes of game-wide settings (RAM 0x8005D140): scroll direction, the last stage, sixteen 4-byte sound entries, per-stage ship speed and background set."),
    region("records", "RECORDS", 0xd1b0, 0xd714, KIDS_RECORDS_STAGE_BYTES, "confirmed",
        "6 x 0xE6: 40 five-byte enemy records indexed by class base 0/16/24/32 plus id, then two 15-byte boss records at +0xC8."),
    region("ship", "SHIP", 0xd714, 0xd8c8, 0, "confirmed",
        "0x1B4 bytes of u16 cell words in the map's encoding: the two ships' three poses each, their shots, the item icons and the title blocks."),
    region("sprites", "SPRITES", 0xd8c8, 0xfcc8, KIDS_SPRITE_STAGE_BYTES, "confirmed",
        "6 x 0x600 of u16 cell words: 16 entries of 16 cells for class 0 at +0, 8 each for classes 1-3 at +0x200/+0x300/+0x400, and two 64-cell boss parts at +0x500 and +0x580. Ends exactly at 0xFCC8 — there is no trailer."),
]);

export const KIDS_REGION = Object.freeze(Object.fromEntries(KIDS_REGIONS.map((r) => [r.name, r])));

export function roundUp(n, to) {
    return Math.ceil(n / to) * to;
}

/** Plain 32-bit byte sum of bytes[start, end). */
export function byteSum(bytes, start, end) {
    let sum = 0;
    for (let i = start; i < end && i < bytes.length; i++) sum += bytes[i];
    return sum >>> 0;
}

/** True when the block carries the Kids! directory shape (checksums aside). */
export function isKidsBlock(block) {
    if (block.length < KIDS_TABLE_OFFSET + KIDS_TABLE_WORDS * 4) return false;
    return parseKidsTable(block).consistent;
}

/**
 * Read and cross-check the eleven-word directory.
 * @param {Uint8Array} block  the save file's bytes (from "SC")
 */
export function parseKidsTable(block) {
    const words = [];
    for (let i = 0; i < KIDS_TABLE_WORDS; i++) words.push(u32le(block, KIDS_TABLE_OFFSET + i * 4));
    const [end, gfxSize, dataSize, gfxOffset, gfxSum, dataOffset, dataSum, tailOffset, tailSum, gfxPadded, dataPadded] = words;
    const problems = [];
    if (gfxOffset !== KIDS_FIRST_SECTION) problems.push(`graphics offset ${gfxOffset.toString(16)} != 0x180`);
    if (gfxPadded !== roundUp(gfxSize, KIDS_SECTOR)) problems.push("graphics padded size != roundUp(size, 0x80)");
    if (dataOffset !== gfxOffset + gfxPadded) problems.push("data offset != graphics offset + padded size");
    if (dataPadded !== roundUp(dataSize, KIDS_SECTOR)) problems.push("data padded size != roundUp(size, 0x80)");
    if (tailOffset !== dataOffset + dataPadded) problems.push("tail offset != data offset + padded size");
    if (end !== tailOffset + KIDS_TAIL_SIZE) problems.push("end != tail offset + 0x100");
    if (end > block.length) problems.push(`end ${end.toString(16)} past the block (${block.length.toString(16)})`);
    return {
        words,
        end,
        sections: {
            graphics: { offset: gfxOffset, size: gfxSize, padded: gfxPadded, checksum: gfxSum },
            data: { offset: dataOffset, size: dataSize, padded: dataPadded, checksum: dataSum },
            tail: { offset: tailOffset, size: KIDS_TAIL_SIZE, padded: KIDS_TAIL_SIZE, checksum: tailSum },
        },
        problems,
        consistent: problems.length === 0,
    };
}

/** Recompute the three checksums; each is the byte sum over the padded span. */
export function validateKidsTable(block, table = parseKidsTable(block)) {
    const check = (s) => byteSum(block, s.offset, s.offset + s.padded) === s.checksum;
    const graphics = check(table.sections.graphics);
    const data = check(table.sections.data);
    const tail = check(table.sections.tail);
    return { graphics, data, tail, ok: graphics && data && tail };
}

// --- the tail ----------------------------------------------------------------

/**
 * Ten 16-byte high-score entries: u32le score, the stage reached, the level
 * the run was started on, two zero bytes, an 8-character name. The insert is
 * GAMES.bin 0x80116098; the factory ladder is 1000..100 with stage 0 level 1.
 *
 * The name's dots are a pre-fill the editor writes before the player types,
 * not padding — a player can type dots, commas and spaces — so they are kept.
 */
export function decodeKidsHiScores(tail, offset = 0) {
    const entries = [];
    for (let i = 0; i < KIDS_HISCORE_COUNT; i++) {
        const at = offset + i * KIDS_HISCORE_SIZE;
        const stage = tail[at + 4];
        const allClear = (stage & KIDS_ALL_CLEAR) !== 0;
        const level = tail[at + 5];
        entries.push({
            rank: i + 1,
            score: u32le(tail, at),
            stage: allClear ? null : stage,
            allClear,
            level,
            levelName: KIDS_LEVELS[level & 3],
            muteki: level === KIDS_MUTEKI_LEVEL,
            name: latin1(tail, at + 8, 8),
        });
    }
    return entries;
}

/**
 * The game's settings, 0x1C bytes at tail +0xA0. Only the readers that were
 * traced are named; the rest come back raw (see FORMAT-PSX.md). `unused` is
 * the 0x44 bytes past them, which nothing initialises or reads.
 */
export function decodeKidsOptions(tail) {
    const at = (i) => tail[KIDS_OPTIONS_OFFSET + i];
    return {
        bytes: tail.subarray(KIDS_OPTIONS_OFFSET, KIDS_OPTIONS_OFFSET + KIDS_OPTIONS_SIZE),
        unused: tail.subarray(KIDS_TAIL_UNUSED_OFFSET, KIDS_TAIL_SIZE),
        screenWidth: at(0x00), //  tail+0xA0
        stereo: at(0x0e), //       tail+0xAE
        presetBgm: at(0x16), //    tail+0xB6
        seMuted: at(0x17) !== 0, // tail+0xB7
        backdropWhite: (at(0x18) & 1) !== 0, // tail+0xB8 bit 0
        bgmFile: at(0x19), //      tail+0xB9
        bgmVolume: at(0x1a), //    tail+0xBA
    };
}

// --- the data section --------------------------------------------------------

/** A map chip word -> the four CG cells it draws and its flags. */
export function decodeKidsChip(word) {
    const cell = word & KIDS_CELL_MASK;
    return {
        raw: word,
        cell,
        cells: [cell, cell + 1, cell + 8, cell + 9],
        hflip: (word & KIDS_HFLIP) !== 0,
        vflip: (word & KIDS_VFLIP) !== 0,
        blank: (word & KIDS_BLANK) !== 0,
    };
}

/** The six stage maps: per stage 384 x 7 chip words, row-major. */
export function decodeKidsMap(data) {
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const base = KIDS_REGION.map.offset + s * KIDS_MAP_STAGE_BYTES;
        const words = new Uint16Array(KIDS_MAP_COLUMNS * KIDS_MAP_ROWS);
        let used = 0;
        for (let i = 0; i < words.length; i++) {
            const w = u16le(data, base + i * 2);
            words[i] = w;
            if ((w & KIDS_BLANK) === 0) used++;
        }
        stages.push({
            stage: s,
            columns: KIDS_MAP_COLUMNS,
            rows: KIDS_MAP_ROWS,
            chipDim: KIDS_CHIP_DIM,
            width: KIDS_MAP_COLUMNS * KIDS_CHIP_DIM,
            height: KIDS_MAP_ROWS * KIDS_CHIP_DIM,
            words,
            used,
        });
    }
    return stages;
}

/** Per stage, 192 scroll steps of 64 px: the nibble and its px per frame. */
export function decodeKidsScroll(data) {
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const base = KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES;
        const steps = [];
        for (let i = 0; i < KIDS_SCROLL_UNITS; i++) {
            const b = data[base + (i >> 1)];
            const nibble = i & 1 ? b >> 4 : b & 0x0f;
            steps.push({ nibble, speed: KIDS_SCROLL_SPEEDS[nibble & 3] });
        }
        stages.push({ stage: s, unitPixels: KIDS_SCROLL_UNIT_PIXELS, steps });
    }
    return stages;
}

/**
 * One APPEAR slot byte -> what it places. A byte whose class is 5 and whose
 * present bit is clear is an editor footprint: a cell covered by a bigger
 * enemy placed elsewhere, stamped `0x50 | (dx << 2) | dy` with the cell's
 * offset inside the owner's rectangle (KIDS.EXE 0x8008A3D0). Which way that
 * offset runs depends on the game's scroll direction, so `decodeKidsAppear`
 * resolves the owner and this only splits the byte.
 */
export function decodeKidsAppearSlot(byte) {
    if (byte === 0) return null;
    const klass = (byte & KIDS_APPEAR_CLASS_MASK) >> 4;
    const id = byte & KIDS_APPEAR_ID_MASK;
    if (klass === KIDS_APPEAR_BOSS_CLASS && (byte & KIDS_APPEAR_PRESENT)) {
        return { raw: byte, boss: true, klass: null, id: null };
    }
    if ((byte & KIDS_APPEAR_PRESENT) === 0) {
        const footprint = klass === KIDS_APPEAR_FOOTPRINT_CLASS;
        return { raw: byte, boss: false, klass: null, id: null, footprint, dx: (id >> 2) & 3, dy: id & 3 };
    }
    const spec = KIDS_APPEAR_CLASSES[klass];
    if (!spec) return { raw: byte, boss: false, klass: null, id: null, unknown: true };
    return { raw: byte, boss: false, klass, id, size: spec.size };
}

/**
 * The cell a footprint mark belongs to. The editor stamps a mark at
 * `anchor + dx - 9*dy` in a vertically scrolling game and `anchor + 9*dx + dy`
 * in a horizontal one (KIDS.EXE 0x8008A3D0 branches on the config's bit 0), so
 * inverting it needs the same flag. Returns null when the owner falls outside
 * the block — 0.13% of marks in the collection are orphans a resized boss left.
 */
export function kidsFootprintOwner(index, dx, dy, horizontal) {
    const owner = horizontal ? index - 9 * dx - dy : index + 9 * dy - dx;
    return owner >= 0 && owner < KIDS_APPEAR_STAGE_BYTES ? owner : null;
}

/**
 * The six placement grids: per stage 384 rows of 9 slots, its spawns, and the
 * footprint marks each spawn covers. Footprints never become spawns.
 * @param {Uint8Array} data
 * @param {{horizontal?: boolean}} [options] the config's scroll direction,
 *   which decides which way a footprint's offset runs.
 */
export function decodeKidsAppear(data, { horizontal = false } = {}) {
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const base = KIDS_REGION.appear.offset + s * KIDS_APPEAR_STAGE_BYTES;
        const bytes = data.subarray(base, base + KIDS_APPEAR_STAGE_BYTES);
        const spawns = [];
        const byIndex = new Map();
        const marks = [];
        let boss = null;
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            if (byte === 0) continue;
            const row = (i / KIDS_APPEAR_COLUMNS) | 0;
            const col = i % KIDS_APPEAR_COLUMNS;
            const slot = decodeKidsAppearSlot(byte);
            if (!slot) continue;
            if ((byte & KIDS_APPEAR_PRESENT) === 0) {
                if (slot.footprint) marks.push({ ...slot, index: i, row, col });
                continue;
            }
            const placed = {
                ...slot,
                row,
                col,
                x: col * KIDS_APPEAR_ROW_PIXELS,
                y: row * KIDS_APPEAR_ROW_PIXELS,
                covers: [],
            };
            byIndex.set(i, placed);
            if (slot.boss) boss = placed;
            else spawns.push(placed);
        }
        let orphans = 0;
        for (const mark of marks) {
            const at = kidsFootprintOwner(mark.index, mark.dx, mark.dy, horizontal);
            const owner = at === null ? undefined : byIndex.get(at);
            if (!owner) {
                orphans++;
                continue;
            }
            mark.owner = { row: owner.row, col: owner.col };
            owner.covers.push({ row: mark.row, col: mark.col });
        }
        stages.push({
            stage: s,
            columns: KIDS_APPEAR_COLUMNS,
            rows: KIDS_APPEAR_ROWS,
            bytes,
            spawns,
            boss,
            marks,
            orphanMarks: orphans,
        });
    }
    return stages;
}

/** The disc file a stage's background-set byte names, or null for none. */
export function kidsBackgroundFile(set, horizontal) {
    const value = set & 0x7f;
    if (value === 0 || value > 38) return null;
    const second = value > 16;
    const dir = `${horizontal ? "SIDE" : "LENGTH"}${second ? 2 : 1}`;
    const name = horizontal ? "BGY" : "BGT";
    const number = second ? value + 34 : value;
    return `GAME\\${dir}\\${name}${String(number).padStart(2, "0")}.CMP`;
}

function kidsSoundEntry(bytes, at) {
    const b0 = bytes[at];
    return {
        preset: (b0 & 0x80) !== 0,
        sequenceVolume: b0 & 0x7f,
        bgm: bytes[at + 1],
        presetNumber: bytes[at + 2] & 0x7f,
        volume: bytes[at + 3] & 0x7f,
    };
}

/** The BGM file a sound entry's number names, or null when it plays nothing. */
export function kidsBgmFile(number) {
    if (number === 0 || number > 99) return null;
    const bank = number < 30 ? 0 : number < 60 ? 1 : number < 90 ? 2 : 3;
    return `SOUND\\${KIDS_BGM_BANKS[bank]}\\BGM${String(number).padStart(2, "0")}.CMP`;
}

/**
 * The 0x70 config header: the game's own settings, written by KIDS.EXE's two
 * initialisers (0x800760E8 global, 0x80075E30 per stage). Every field below
 * has a traced reader; the ones whose *meaning* is still open come back as
 * raw byte groups (`ships`, `items`, `shots`, `unknown1A`). The last byte is
 * an always-zero pad no routine forms.
 */
export function decodeKidsConfig(data) {
    const r = KIDS_REGION.config;
    const bytes = data.subarray(r.offset, r.end);
    const horizontal = (bytes[0] & 1) !== 0;
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const flags = bytes[3 + s];
        const motion = bytes[0x63 + s];
        const set = bytes[0x69 + s];
        stages.push({
            stage: s,
            last: (flags & 0x80) !== 0,
            chained: (flags & 0x01) !== 0,
            flags,
            scrollSpeed: KIDS_SCROLL_SPEEDS[motion & 3],
            scrollReverse: (motion & 4) !== 0,
            backgroundSpeed: KIDS_BG_SPEEDS[(motion >> 4) & 3],
            backgroundSet: set & 0x7f,
            backgroundFile: kidsBackgroundFile(set, horizontal),
        });
    }
    const lastStage = stages.findIndex((st) => st.last);
    const stageCount = (lastStage + 1) || KIDS_STAGES;
    const sound = [];
    for (let i = 0; i < 16; i++) {
        const entry = kidsSoundEntry(bytes, 0x23 + i * 4);
        // Entries 0-3 belong to the game, then two per stage.
        entry.scope = i < 4 ? "game" : `stage ${(i - 4) >> 1}`;
        entry.file = entry.preset ? null : kidsBgmFile(entry.bgm);
        sound.push(entry);
    }
    return {
        bytes,
        horizontal,
        font: {
            typeface: bytes[1] & 7,
            colour: (bytes[1] >> 3) & 7,
            file: KIDS_FONT_FILES[bytes[1] >> 6],
        },
        soundBank: bytes[2],
        stages,
        stageCount,
        pointItems: {
            small: KIDS_POINT_SMALL[bytes[0x0f] & 3],
            large: KIDS_POINT_LARGE[bytes[0x10] & 3],
        },
        /** Two three-byte player-ship records; only byte 2 has a play-mode reader. */
        ships: [bytes.subarray(0x09, 0x0c), bytes.subarray(0x0c, 0x0f)],
        /** Seven item records and two more of the same shape. */
        items: Array.from({ length: 9 }, (_, i) => ({
            a: bytes[0x11 + i] & 3,
            b: (bytes[0x11 + i] >> 2) & 3,
        })),
        unknown1A: bytes[0x1a],
        /** Two four-byte player-shot records, one per ship. */
        shots: [bytes.subarray(0x1b, 0x1f), bytes.subarray(0x1f, 0x23)],
        sound,
        /** Sound entries past this are zeroed when the game loads. */
        liveSoundEntries: 2 * stageCount + 4,
    };
}

/** One five-byte enemy record, raw plus the fields whose readers were traced. */
export function decodeKidsRecord(bytes, at, index) {
    const b = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4]];
    return {
        index,
        bytes: b,
        movement: b[0] & 0x1f,
        movementVariant: (b[0] >> 5) & 3,
        spawnFlag: (b[0] & 0x80) !== 0,
        hitPoints: b[1] & 7,
        scoreClass: (b[1] >> 3) & 3,
        fireTiming: (b[2] >> 4) & 3,
        fireInterval: (b[2] >> 6) & 3,
        shotPattern: (b[3] & 0x0f) + 1,
    };
}

/** Per stage: 40 enemy records and the two boss records at +0xC8. */
export function decodeKidsRecords(data) {
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const base = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
        const enemies = [];
        for (let i = 0; i < KIDS_RECORD_COUNT; i++) enemies.push(decodeKidsRecord(data, base + i * KIDS_RECORD_SIZE, i));
        const bosses = [];
        for (let i = 0; i < KIDS_BOSS_COUNT; i++) {
            const at = base + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE;
            const head = data[at];
            bosses.push({
                index: i,
                bytes: data.subarray(at, at + KIDS_BOSS_SIZE),
                sizeClass: head >> 6,
                size: KIDS_BOSS_SIZES[head >> 6],
            });
        }
        stages.push({ stage: s, enemies, bosses });
    }
    return stages;
}

/** The record a spawn class and id name (class base 0/16/24/32 plus id). */
export function kidsRecordFor(records, stage, klass, id) {
    const table = records[stage];
    if (!table) return null;
    return table.enemies[KIDS_CLASS_BASE[klass] + id] ?? null;
}

function cellWords(data, at, count) {
    const words = new Uint16Array(count);
    for (let i = 0; i < count; i++) words[i] = u16le(data, at + i * 2);
    return words;
}

/** The common 0x1B4-byte sprite table and the six per-stage 0x600-byte ones. */
export function decodeKidsSprites(data) {
    const ship = cellWords(data, KIDS_REGION.ship.offset, KIDS_SHIP_TABLE_BYTES / 2);
    const stages = [];
    for (let s = 0; s < KIDS_STAGES; s++) {
        const base = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
        const classes = KIDS_APPEAR_CLASSES.map((spec, k) => {
            const at = base + KIDS_SPRITE_CLASS_OFFSETS[k];
            const entries = [];
            for (let i = 0; i < spec.count; i++) {
                entries.push(cellWords(data, at + i * KIDS_SPRITE_ENTRY_WORDS * 2, KIDS_SPRITE_ENTRY_WORDS));
            }
            return { klass: k, size: spec.size, entries };
        });
        const bosses = KIDS_SPRITE_BOSS_OFFSETS.map((off, i) => ({
            part: i,
            words: cellWords(data, base + off, KIDS_SPRITE_BOSS_WORDS),
        }));
        stages.push({ stage: s, classes, bosses });
    }
    return { ship, stages };
}

/** The decompressed graphics as four CG pages of 128x512 indexed pixels. */
export function kidsCgPages(graphics) {
    const pages = [];
    for (let p = 0; p < 4; p++) pages.push(decodeCgPage(graphics.subarray(p * CG_PAGE_SIZE, (p + 1) * CG_PAGE_SIZE)));
    return pages;
}

/** One 16x16 CG cell (0..1023 across the four pages) as 256 palette indices. */
export function kidsCell(graphics, cell) {
    return graphics.subarray(cell * 256, cell * 256 + 256);
}

/**
 * The colours a Kids! game draws with: the fixed disc bank, not the save.
 * @param {{backdrop?: boolean}} [options] map/background form (index 0 white)
 */
export function kidsPalette(options) {
    return kidsPaletteRgb(options);
}

function attempt(result, block, fn) {
    try {
        result[block] = fn();
    } catch (err) {
        result[block] = null;
        result.errors.push({ block, message: err.message });
    }
}

/**
 * Decode a Kids! save block. Never throws on content: each stage lands in
 * `errors` and the rest still decodes.
 * @param {Uint8Array} block
 * @param {{filename?: string}} [options]
 */
export function parseKidsSave(block, { filename = "" } = {}) {
    const result = {
        game: "kids",
        filename,
        productOk: filename === "" || filename === KIDS_PRODUCT,
        size: block.length,
        sizeOk: block.length === KIDS_BLOCK_SIZE,
        header: null,
        gameName: null,
        gameNameAscii: null,
        table: null,
        checksums: null,
        graphics: null,
        data: null,
        tail: null,
        hiScores: null,
        options: null,
        map: null,
        scroll: null,
        appear: null,
        config: null,
        records: null,
        sprites: null,
        pages: null,
        regions: KIDS_REGIONS,
        errors: [],
    };
    attempt(result, "header", () => parseSaveHeader(block));
    if (result.header) {
        result.gameName = bracketedName(result.header.title);
        result.gameNameAscii = result.gameName === null ? null : narrow(result.gameName).replace(/\s+/g, " ").trim();
    }
    attempt(result, "table", () => parseKidsTable(block));
    const table = result.table;
    if (!table) return result;
    if (!table.consistent) result.errors.push({ block: "table", message: table.problems.join("; ") });
    attempt(result, "checksums", () => validateKidsTable(block, table));
    const section = (s) => block.subarray(s.offset, Math.min(s.offset + s.size, block.length));
    attempt(result, "graphics", () => {
        const out = Uint8Array.from(decompress(section(table.sections.graphics)));
        if (out.length !== KIDS_GRAPHICS_SIZE) throw new Error(`graphics decompress to ${out.length}, expected ${KIDS_GRAPHICS_SIZE}`);
        return out;
    });
    attempt(result, "data", () => {
        const out = Uint8Array.from(decompress(section(table.sections.data)));
        if (out.length !== KIDS_DATA_SIZE) throw new Error(`data decompress to ${out.length}, expected ${KIDS_DATA_SIZE}`);
        return out;
    });
    attempt(result, "tail", () => section(table.sections.tail));
    if (result.tail) {
        attempt(result, "hiScores", () => decodeKidsHiScores(result.tail));
        attempt(result, "options", () => decodeKidsOptions(result.tail));
    }
    if (result.data) {
        attempt(result, "map", () => decodeKidsMap(result.data));
        attempt(result, "scroll", () => decodeKidsScroll(result.data));
        attempt(result, "config", () => decodeKidsConfig(result.data));
        attempt(result, "appear", () => decodeKidsAppear(result.data, { horizontal: result.config?.horizontal ?? false }));
        attempt(result, "records", () => decodeKidsRecords(result.data));
        attempt(result, "sprites", () => decodeKidsSprites(result.data));
    }
    if (result.graphics) attempt(result, "pages", () => kidsCgPages(result.graphics));
    return result;
}

/** The game name a Kids! save announces, ASCII-narrowed, or the product code. */
export function kidsDisplayName(parsed) {
    if (parsed.gameNameAscii) return parsed.gameNameAscii;
    return parsed.header?.titleAscii ?? KIDS_PRODUCT;
}
