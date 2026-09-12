// Dezaemon+ (Dezaemon Plus!, Athena, 1996, SLPS-00335) — the save block.
//
// The PlayStation port of the Super Famicom Dezaemon writes one 15-block,
// 0x1E000-byte memory-card file named BISLPS-00335DEZA, raw: no directory in
// the file itself, no compression. The directory lives in the program, as a
// 74-entry scatter/gather table (MAIN.EXE 0x8005A380, entries
// {u32 destRAM, u32 length, u8 flag, u8 kind}) that the save routine
// 0x80035CF8 walks to gather the file and the load routine 0x80036334 walks to
// scatter it back into the live arrays. PLUS_TABLE below is that table; its
// lengths sum to exactly 0x1E000.
//
// Because every region is named by the RAM array it loads into, the layout is
// exact rather than inferred — and the file's last 0x28 bytes are twenty u16
// checksums, one per flag group, which `plusChecksums()` recomputes. That
// makes the table self-proving: the checksum of a group depends on each byte's
// offset within its entry and on the entry's index, so a table with even one
// boundary wrong reproduces none of the community saves (a 0x2240 stage stride
// reproduces 0 of 67; the table below reproduces all 67 byte for byte).
//
// Coarse layout:
//
//   0x00000  SC header (0x100)      the title frame and one icon frame
//   0x00100  GRAPHICS (0x10000)     two 256x256 4bpp texture pages
//   0x10100  PALETTES (0x300)       24 rows of 16 RGB555 words
//   0x10400  five STAGE blocks of 0x223C (not 0x2240)
//   0x1AF2C  GLOBAL (0x164)         title, ending, ship and BGM tables
//   0x1B090  SOUND (0x2E00)         16 songs of 0x2E0, bit-packed
//   0x1DE90  HIGH SCORES (2 x 0xA0) ten entries each, two tables
//   0x1DFD0  SETTINGS (8)
//   0x1DFD8  CHECKSUMS (0x28)       twenty u16, indexed by flag group
//
// The region names come from the Super Famicom original (FORMAT-SFC.md) by way
// of the RAM arrays MAIN.EXE scatters into; the sub-region semantics were
// traced in the play code. Environment-neutral ESM (Node + browser).

import { rgb555ToRgb } from "../decode/decode-cg.js";
import { latin1, u16le, u32le } from "./memcard.js";
import { parseSaveHeader } from "./save-header.js";

export const PLUS_PRODUCT = "BISLPS-00335DEZA";
export const PLUS_TITLE_PREFIX = "デザエモン＋";
export const PLUS_BLOCK_SIZE = 0x1e000;

export const PLUS_GRAPHICS_OFFSET = 0x100;
export const PLUS_GRAPHICS_SIZE = 0x10000;
export const PLUS_GRAPHICS_WIDTH = 256;
export const PLUS_GRAPHICS_HEIGHT = 512;
/** Two PlayStation 256x256 4bpp texture pages, stacked in the bitmap above. */
export const PLUS_GRAPHICS_PAGES = 2;
export const PLUS_PAGE_HEIGHT = 256;

export const PLUS_PALETTE_OFFSET = 0x10100;
export const PLUS_PALETTE_ROWS = 24;
export const PLUS_PALETTE_ROW_BYTES = 32;

export const PLUS_STAGES_OFFSET = 0x10400;
export const PLUS_STAGE_SIZE = 0x223c;
export const PLUS_STAGES = 5;

export const PLUS_GLOBAL_OFFSET = 0x1af2c;
export const PLUS_GLOBAL_SIZE = 0x164;
export const PLUS_SOUND_OFFSET = 0x1b090;
export const PLUS_SOUND_SIZE = 0x2e00;
export const PLUS_SONG_SIZE = 0x2e0;
export const PLUS_SONG_COUNT = PLUS_SOUND_SIZE / PLUS_SONG_SIZE; // 16

export const PLUS_HISCORE_OFFSET = 0x1de90;
export const PLUS_HISCORE_TABLE_BYTES = 0xa0;
export const PLUS_HISCORE_TABLES = 2;
export const PLUS_HISCORE_COUNT = 10;
export const PLUS_HISCORE_SIZE = 16;

export const PLUS_SETTINGS_OFFSET = 0x1dfd0;
export const PLUS_SETTINGS_SIZE = 8;
export const PLUS_CHECKSUM_OFFSET = 0x1dfd8;
export const PLUS_CHECKSUM_COUNT = 20;
export const PLUS_CHECKSUM_SIZE = PLUS_CHECKSUM_COUNT * 2; // 0x28
/** The load routine verifies groups 0..0x12; group 0x13 covers the array itself. */
export const PLUS_CHECKED_GROUPS = 0x13;

// --- the stage block ---------------------------------------------------------

export const PLUS_MAP_ROW_BYTES = 18;
export const PLUS_MAP_ROWS = 128;
/** Sixteen 16x16 chips per row; the two remaining bytes carry v-flip bits. */
export const PLUS_MAP_COLUMNS = 16;
export const PLUS_CHIP_DIM = 16;
/** Byte positions inside a map row: chips, then the v-flip byte for them. */
export const PLUS_MAP_HALVES = Object.freeze([
    { chips: [0, 1, 2, 3, 4, 5, 6, 7], flags: 8 },
    { chips: [9, 10, 11, 12, 13, 14, 15, 16], flags: 17 },
]);

/** MAP GROUP words are clamped to this by the reader: a 10-bit tile number. */
export const PLUS_TILE_MAX = 0x3ff;
export const PLUS_APPEAR_RECORDS = 256;
export const PLUS_APPEAR_RECORD_SIZE = 14;
export const PLUS_APPEAR_ROW_TABLE = 0x400;
export const PLUS_APPEAR_END_MARK = 0xff;
export const PLUS_ENEMY_COUNT = 60;
export const PLUS_ENEMY_SIZE = 8;
export const PLUS_BOSS_OFFSET = 0x1e0;
export const PLUS_BOSS_SIZE = 0x20;
/** Appear class nibble -> sprite size and the definitions it indexes. */
export const PLUS_APPEAR_CLASSES = Object.freeze([
    { nibble: 0x8, size: "16x16", base: 0, mask: 0x0f },
    { nibble: 0x9, size: "32x16", base: 16, mask: 0x0f },
    { nibble: 0xa, size: "16x32", base: 32, mask: 0x0f },
    { nibble: 0xb, size: "32x32", base: 48, mask: 0x07 },
    { nibble: 0xc, size: "64x64", base: 56, mask: 0x03 },
]);
export const PLUS_APPEAR_BOSS_NIBBLE = 0xd;

export const CONFIDENCES = Object.freeze(["confirmed", "likely", "open"]);

function region(name, label, offset, end, confidence, note) {
    return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}

// --- the scatter/gather table ------------------------------------------------

function tableEntry(index, offset, length, ram, flag, kind, group, sub) {
    return Object.freeze({ index, offset, length, ram, flag, kind, group, sub });
}

/** The five per-stage pieces, in file order, with their RAM array bases. */
const STAGE_PIECES = [
    ["map", "MAP", 0x900, 0x80145c88],
    ["scroll", "SCROLL", 0x200, 0x80149288],
    ["mapGroup", "MAP GROUP", 0x100, 0x8018c2b0],
    ["enemyGroup", "ENEMY GROUP", 0x80, 0x801212e0],
    ["enemyData", "ENEMY DATA", 0x200, 0x80115b50],
    ["spriteLayout", "SPRITE LAYOUT", 0x140, 0x8018d668],
    ["appear", "APPEAR", 0x1200, 0x8011a050],
    ["config", "STAGE CONFIG", 0x3c, 0x80120ec0],
    ["bossGroup", "BOSS GROUP", 0x40, 0x80119828],
];

/** The eight global pieces that follow the stages, in file order. */
const GLOBAL_PIECES = [
    ["titleType", "TITLE TYPE", 0x02, 0x80112a30],
    ["titleGroup", "TITLE GROUP", 0x40, 0x801215e0],
    ["endingGroup", "ENDING GROUP", 0x18, 0x8014a0e8],
    ["shipGroup", "MY SHIP GROUP", 0x9a, 0x8018c9e8],
    ["shipOdr", "MY SHIP ODR", 0x4d, 0x801211c0],
    ["stageList", "STAGE LIST", 0x10, 0x8014a740],
    ["gameConfig", "GAME CONFIG", 0x03, 0x80112a52],
    ["bgmPatch", "BGM PATCH", 0x10, 0x8018cc18],
];

const HEADER_PIECES = [
    [0x04, 0x8011288c],
    [0x40, 0x8005a284],
    [0x1c, 0x8005a2c4],
    [0x20, 0x8005a2e0],
    [0x80, 0x8005a300],
];

const SETTINGS_PIECES = [[1, 0x80112a5c], [1, 0x80112a5d], [2, 0x80112aac], [4, 0x80112a24]];

function buildTable() {
    const rows = [];
    let offset = 0;
    const push = (length, ram, flag, kind, group, sub = "") => {
        rows.push(tableEntry(rows.length, offset, length, ram, flag, kind, group, sub));
        offset += length;
    };
    for (const [length, ram] of HEADER_PIECES) push(length, ram, 0, 0, "header");
    for (let q = 0; q < 4; q++) push(0x4000, 0x8006b228 + q * 0x4000, 1 + q, 1, "graphics", `quarter ${q}`);
    push(0x300, 0x8014a7b8, 5, 1, "palettes");
    for (let s = 0; s < PLUS_STAGES; s++) {
        for (const [name, label, length, ram] of STAGE_PIECES) {
            push(length, ram + s * length, 6 + s, 2, `stage ${s}`, `${label} (${name})`);
        }
    }
    for (const [name, label, length, ram] of GLOBAL_PIECES) push(length, ram, 0x0b, 2, "global", `${label} (${name})`);
    for (let q = 0; q < 4; q++) push(0xb80, 0x80116988 + q * 0xb80, 0x0c + q, 3, "sound", `quarter ${q}`);
    push(PLUS_HISCORE_TABLE_BYTES, 0x8014a048, 0x10, 4, "hiScores", "table A");
    push(PLUS_HISCORE_TABLE_BYTES, 0x80119788, 0x11, 4, "hiScores", "table B");
    for (const [length, ram] of SETTINGS_PIECES) push(length, ram, 0x12, 4, "settings");
    push(PLUS_CHECKSUM_SIZE, 0x80112bf0, 0x13, 5, "checksums");
    return Object.freeze(rows);
}

/** MAIN.EXE's 74-entry scatter/gather table, as {offset, length, ram, flag, kind}. */
export const PLUS_TABLE = buildTable();

/**
 * Recompute the twenty u16 checksums the save routine accumulates while it
 * gathers the file, and compare them with the ones stored at 0x1DFD8.
 *
 * For every byte: cs[flag] += byte * (offsetWithinEntry & 0x1F) + entryIndex,
 * with a further += entryIndex at the start of each 128-byte frame, and the
 * next group's accumulator cleared when an entry ends a group. Group 0x13
 * covers the checksum array itself and is self-referential, so — like the
 * game's own load routine — only groups 0x00..0x12 are verified.
 */
export function plusChecksums(block) {
    if (block.length < PLUS_BLOCK_SIZE) {
        throw new Error(`a checksum needs the whole ${PLUS_BLOCK_SIZE}-byte block; got ${block.length}`);
    }
    const cs = new Uint16Array(PLUS_CHECKSUM_COUNT + 1);
    let entry = 0;
    let within = 0;
    for (let pos = 0; pos < PLUS_BLOCK_SIZE; pos++) {
        const row = PLUS_TABLE[entry];
        if (!row) break;
        if ((pos & 0x7f) === 0) cs[row.flag] += entry;
        cs[row.flag] += block[pos] * (within & 0x1f) + entry;
        within++;
        if (within >= row.length) {
            const next = PLUS_TABLE[entry + 1];
            if (next && next.flag !== row.flag && row.kind !== 5) cs[row.flag + 1] = 0;
            entry++;
            within = 0;
        }
    }
    const computed = Array.from(cs.subarray(0, PLUS_CHECKSUM_COUNT));
    const stored = [];
    for (let i = 0; i < PLUS_CHECKSUM_COUNT; i++) stored.push(u16le(block, PLUS_CHECKSUM_OFFSET + i * 2));
    const bad = [];
    for (let i = 0; i < PLUS_CHECKED_GROUPS; i++) if (computed[i] !== stored[i]) bad.push(i);
    return { computed, stored, bad, ok: bad.length === 0, checkedGroups: PLUS_CHECKED_GROUPS };
}

/** The file regions a group flag covers, for reporting a checksum mismatch. */
export function plusGroupRegions(flag) {
    return PLUS_TABLE.filter((r) => r.flag === flag);
}

// --- the coarse region map ---------------------------------------------------

/** The save file's layout. `end` is exclusive. */
export const PLUS_REGIONS = Object.freeze([
    region("header", "SC HEADER", 0x0000, PLUS_GRAPHICS_OFFSET, "confirmed",
        "Title frame and one icon frame, built from five pieces of the program's own template; the title text is fixed."),
    region("graphics", "GRAPHICS", PLUS_GRAPHICS_OFFSET, PLUS_GRAPHICS_OFFSET + PLUS_GRAPHICS_SIZE, "confirmed",
        "Two 256x256 4bpp PlayStation texture pages, a 128-byte row pitch, low nibble = left pixel. The four 0x4000 quarters are checksum groups, not picture boundaries."),
    region("palettes", "PALETTES", PLUS_PALETTE_OFFSET, PLUS_STAGES_OFFSET, "confirmed",
        "24 rows x 16 RGB555 words, little-endian, bit 15 = STP, colour 0 transparent. LoadImage'd to VRAM (0, 480+row); the map draws with row = stage."),
    region("stages", "STAGES", PLUS_STAGES_OFFSET, PLUS_GLOBAL_OFFSET, "confirmed",
        "5 x 0x223C, each nine pieces (PLUS_STAGE_LAYOUT). The stride is exact: the checksum reproduces every community save under it and none under 0x2240."),
    region("global", "GLOBAL", PLUS_GLOBAL_OFFSET, PLUS_SOUND_OFFSET, "confirmed",
        "0x164 of game-wide tables: title type and group, ending, the ship's group and ODR, the stage list, game config and the BGM patch list."),
    region("sound", "SOUND", PLUS_SOUND_OFFSET, PLUS_HISCORE_OFFSET, "confirmed",
        "16 songs of 0x2E0 bytes, bit-packed: 16 bars of a 14-bit header and 32 steps of 11 bits, then a 16-bit tail."),
    region("hiScores", "HIGH SCORE", PLUS_HISCORE_OFFSET, PLUS_SETTINGS_OFFSET, "confirmed",
        "Two tables of ten 16-byte entries: u32le score, four bytes, an 8-character name. The factory ladder is 1000..100 in both."),
    region("settings", "SETTINGS", PLUS_SETTINGS_OFFSET, PLUS_CHECKSUM_OFFSET, "likely",
        "Eight bytes from four separate variables (u8, u8, u16, u32); which option each is has not been traced."),
    region("checksums", "CHECKSUMS", PLUS_CHECKSUM_OFFSET, PLUS_BLOCK_SIZE, "confirmed",
        "Twenty u16 checksums, one per flag group; the game verifies groups 0x00..0x12 on load."),
]);

export const PLUS_REGION = Object.freeze(Object.fromEntries(PLUS_REGIONS.map((r) => [r.name, r])));

/** The nine pieces of a 0x223C stage block, in file order. */
export const PLUS_STAGE_LAYOUT = Object.freeze((() => {
    const out = [];
    let at = 0;
    for (const [name, label, length] of STAGE_PIECES) {
        out.push(Object.freeze({ name, label, offset: at, end: at + length, length }));
        at += length;
    }
    return out;
})());

export const PLUS_STAGE_PIECE = Object.freeze(Object.fromEntries(PLUS_STAGE_LAYOUT.map((p) => [p.name, p])));

/** The eight pieces of the 0x164 global block, in file order. */
export const PLUS_GLOBAL_LAYOUT = Object.freeze((() => {
    const out = [];
    let at = 0;
    for (const [name, label, length] of GLOBAL_PIECES) {
        out.push(Object.freeze({ name, label, offset: at, end: at + length, length }));
        at += length;
    }
    return out;
})());

export function isPlusBlock(block) {
    if (block.length < PLUS_BLOCK_SIZE) return false;
    const header = parseSaveHeader(block);
    return header.magicOk && header.title.startsWith(PLUS_TITLE_PREFIX);
}

// --- decoders ----------------------------------------------------------------

/** The 24 palette rows. Each colour: raw word, r/g/b, stp (bit 15), empty. */
export function decodePlusPalettes(block) {
    const rows = [];
    for (let r = 0; r < PLUS_PALETTE_ROWS; r++) {
        const colors = [];
        for (let c = 0; c < 16; c++) {
            const raw = u16le(block, PLUS_PALETTE_OFFSET + r * PLUS_PALETTE_ROW_BYTES + c * 2);
            colors.push({ raw, ...rgb555ToRgb(raw), stp: (raw & 0x8000) !== 0, empty: raw === 0 });
        }
        rows.push({ row: r, colors, blank: colors.every((c) => c.empty) });
    }
    return rows;
}

/**
 * Which palette row an object draws with (MAIN.EXE, CLUT ids at 0x8018d180):
 * the map takes the stage's own row, enemies 6+stage, the boss 12+stage.
 */
export function plusPaletteRow(what, stage = 0) {
    switch (what) {
        case "map":
            return stage;
        case "enemy":
            return 6 + stage;
        case "boss":
            return 12 + stage;
        case "player":
            return 18;
        case "title":
            return 19;
        case "shot":
            return 20;
        case "effect":
            return 21;
        default:
            return null;
    }
}

/** The graphics bank as one index per pixel, 256 x 512 (two texture pages). */
export function decodePlusGraphics(block) {
    const indexed = new Uint8Array(PLUS_GRAPHICS_WIDTH * PLUS_GRAPHICS_HEIGHT);
    let used = 0;
    for (let i = 0; i < PLUS_GRAPHICS_SIZE; i++) {
        const b = block[PLUS_GRAPHICS_OFFSET + i];
        indexed[i * 2] = b & 0x0f;
        indexed[i * 2 + 1] = b >> 4;
        if (b) used++;
    }
    return {
        width: PLUS_GRAPHICS_WIDTH,
        height: PLUS_GRAPHICS_HEIGHT,
        pages: PLUS_GRAPHICS_PAGES,
        pageHeight: PLUS_PAGE_HEIGHT,
        indexed,
        usedBytes: used,
        blank: used === 0,
    };
}

export function plusStageOffset(stage) {
    return PLUS_STAGES_OFFSET + stage * PLUS_STAGE_SIZE;
}

/**
 * A MAP GROUP word -> the 16x16 px tile it names in the graphics bank.
 *
 * The reader (MAIN.EXE 0x8001AE60) clamps the word to 1023, so it is a 10-bit
 * tile number over the program's FOUR 256x256 tile buffers: bits 0-2 with
 * bit 7 give the column 0..15, bits 3-6 the row 0..15, bits 8-9 the buffer.
 * The four buffers are two pairs, one per load path: a save read from the
 * memory card goes into the first pair and a game loaded from the disc into
 * the second, which is why the community saves name buffers 0 and 1 while the
 * disc's own sample game names 2 and 3. Either way the buffer's LOW BIT picks
 * the half of the save's own 512-row bitmap, and both populations render
 * correctly under it. That is `half`; `page` keeps the raw field.
 */
export function decodePlusGroupWord(word) {
    const tile = Math.min(word, PLUS_TILE_MAX);
    const column = (tile & 0x07) | ((tile & 0x80) >> 4);
    const row = (tile >> 3) & 0x0f;
    const page = (tile >> 8) & 3;
    const half = page & 1;
    return {
        raw: word,
        tile,
        column,
        row,
        page,
        half,
        x: column * PLUS_CHIP_DIM,
        y: row * PLUS_CHIP_DIM + half * PLUS_PAGE_HEIGHT,
    };
}

/**
 * One stage map: 128 rows of 16 chips. A row is eight chip bytes, a byte of
 * v-flip bits for them (bit 7 = the leftmost of the eight), then the same
 * again. A chip byte's bit 7 is the horizontal flip and its low seven bits
 * index MAP GROUP. Columns 0 and 15 carry no chip in any known save.
 */
export function decodePlusMapRow(row) {
    const chips = [];
    for (const half of PLUS_MAP_HALVES) {
        const flags = row[half.flags];
        half.chips.forEach((at, i) => {
            const b = row[at];
            chips.push({
                raw: b,
                group: b & 0x7f,
                hflip: (b & 0x80) !== 0,
                vflip: ((flags >> (7 - i)) & 1) !== 0,
                blank: (b & 0x7f) === 0,
            });
        });
    }
    return chips;
}

/** One stage block: every piece as a view, plus the decoded map. */
export function decodePlusStage(block, stage) {
    const base = plusStageOffset(stage);
    const parts = {};
    for (const p of PLUS_STAGE_LAYOUT) parts[p.name] = block.subarray(base + p.offset, base + p.end);
    const rows = [];
    let used = 0;
    for (let r = 0; r < PLUS_MAP_ROWS; r++) {
        const chips = decodePlusMapRow(parts.map.subarray(r * PLUS_MAP_ROW_BYTES, (r + 1) * PLUS_MAP_ROW_BYTES));
        for (const c of chips) if (!c.blank) used++;
        rows.push(chips);
    }
    return {
        stage,
        offset: base,
        columns: PLUS_MAP_COLUMNS,
        rows: PLUS_MAP_ROWS,
        chipDim: PLUS_CHIP_DIM,
        map: parts.map,
        mapRows: rows,
        used,
        parts,
    };
}

export function decodePlusStages(block) {
    const stages = [];
    for (let s = 0; s < PLUS_STAGES; s++) stages.push(decodePlusStage(block, s));
    return stages;
}

/** A stage's MAP GROUP: 128 u16 tile words. */
export function decodePlusMapGroup(stage) {
    const words = [];
    const bytes = stage.parts.mapGroup;
    for (let i = 0; i < bytes.length / 2; i++) words.push(decodePlusGroupWord(u16le(bytes, i * 2)));
    return words;
}

/** A stage's ENEMY DATA: 60 definitions of 8 bytes, then a 32-byte boss. */
export function decodePlusEnemyData(stage) {
    const bytes = stage.parts.enemyData;
    const config = stage.parts.config;
    const enemies = [];
    for (let i = 0; i < PLUS_ENEMY_COUNT; i++) {
        enemies.push({
            index: i,
            bytes: bytes.subarray(i * PLUS_ENEMY_SIZE, (i + 1) * PLUS_ENEMY_SIZE),
            config: config[i],
        });
    }
    return { enemies, boss: bytes.subarray(PLUS_BOSS_OFFSET, PLUS_BOSS_OFFSET + PLUS_BOSS_SIZE) };
}

/** An APPEAR record byte -> which enemy definition it spawns. */
export function decodePlusAppearByte(byte) {
    if (byte === 0 || byte === PLUS_APPEAR_END_MARK) return null;
    const nibble = byte >> 4;
    if (nibble === PLUS_APPEAR_BOSS_NIBBLE) return { raw: byte, boss: true, definition: null };
    const spec = PLUS_APPEAR_CLASSES.find((c) => c.nibble === nibble);
    if (!spec) return { raw: byte, boss: false, definition: null, unknown: true };
    return { raw: byte, boss: false, size: spec.size, definition: spec.base + (byte & spec.mask) };
}

/**
 * A stage's APPEAR: 256 records of 14 bytes (record 1 is the 0xFF end mark),
 * then a 0x400 table mapping each 16 px of scroll to a record.
 */
export function decodePlusAppear(stage) {
    const bytes = stage.parts.appear;
    const records = [];
    for (let i = 0; i < PLUS_APPEAR_RECORDS; i++) {
        const at = i * PLUS_APPEAR_RECORD_SIZE;
        const raw = bytes.subarray(at, at + PLUS_APPEAR_RECORD_SIZE);
        const spawns = [];
        for (let col = 0; col < PLUS_APPEAR_RECORD_SIZE; col++) {
            const slot = decodePlusAppearByte(raw[col]);
            if (slot) spawns.push({ ...slot, column: col, x: (col + 1) * PLUS_CHIP_DIM });
        }
        records.push({ index: i, bytes: raw, spawns, end: raw[0] === PLUS_APPEAR_END_MARK });
    }
    const tableAt = PLUS_APPEAR_RECORDS * PLUS_APPEAR_RECORD_SIZE;
    return { records, rowTable: bytes.subarray(tableAt, tableAt + PLUS_APPEAR_ROW_TABLE) };
}

/** A stage's SCROLL EFECT: 256 steps of 64 px naming a map block, then 256 effect bytes. */
export function decodePlusScroll(stage) {
    const bytes = stage.parts.scroll;
    return { blocks: bytes.subarray(0, 256), effects: bytes.subarray(256, 512) };
}

/** The 0x164 global block, piece by piece. */
export function decodePlusGlobals(block) {
    const out = {};
    for (const p of PLUS_GLOBAL_LAYOUT) {
        out[p.name] = block.subarray(PLUS_GLOBAL_OFFSET + p.offset, PLUS_GLOBAL_OFFSET + p.end);
    }
    return out;
}

/** The sixteen 0x2E0-byte songs, as views. */
export function decodePlusSound(block) {
    const songs = [];
    for (let i = 0; i < PLUS_SONG_COUNT; i++) {
        const at = PLUS_SOUND_OFFSET + i * PLUS_SONG_SIZE;
        songs.push({ index: i, bytes: block.subarray(at, at + PLUS_SONG_SIZE) });
    }
    return songs;
}

/** Two tables of ten entries: u32le score, four bytes, an 8-character name. */
export function decodePlusHiScores(block) {
    const entries = [];
    for (let t = 0; t < PLUS_HISCORE_TABLES; t++) {
        for (let i = 0; i < PLUS_HISCORE_COUNT; i++) {
            const at = PLUS_HISCORE_OFFSET + t * PLUS_HISCORE_TABLE_BYTES + i * PLUS_HISCORE_SIZE;
            entries.push({
                rank: i + 1,
                table: t,
                score: u32le(block, at),
                extra: Array.from(block.subarray(at + 4, at + 8)),
                name: latin1(block, at + 8, 8),
            });
        }
    }
    return entries;
}

/** The eight settings bytes, as the four variables the table names. */
export function decodePlusSettings(block) {
    const at = PLUS_SETTINGS_OFFSET;
    return {
        bytes: block.subarray(at, at + PLUS_SETTINGS_SIZE),
        a: block[at],
        b: block[at + 1],
        c: u16le(block, at + 2),
        d: u32le(block, at + 4),
    };
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
 * Decode a Dezaemon+ save block. Never throws on content.
 * @param {Uint8Array} block
 * @param {{filename?: string}} [options]
 */
export function parsePlusSave(block, { filename = "" } = {}) {
    const result = {
        game: "plus",
        filename,
        productOk: filename === "" || filename === PLUS_PRODUCT,
        size: block.length,
        sizeOk: block.length === PLUS_BLOCK_SIZE,
        header: null,
        checksums: null,
        palettes: null,
        graphics: null,
        stages: null,
        globals: null,
        sound: null,
        hiScores: null,
        settings: null,
        table: PLUS_TABLE,
        regions: PLUS_REGIONS,
        stageLayout: PLUS_STAGE_LAYOUT,
        globalLayout: PLUS_GLOBAL_LAYOUT,
        errors: [],
    };
    attempt(result, "header", () => parseSaveHeader(block));
    if (block.length < PLUS_BLOCK_SIZE) {
        result.errors.push({ block: "size", message: `${block.length} bytes; a Dezaemon+ save is ${PLUS_BLOCK_SIZE}` });
        return result;
    }
    attempt(result, "checksums", () => plusChecksums(block));
    attempt(result, "palettes", () => decodePlusPalettes(block));
    attempt(result, "graphics", () => decodePlusGraphics(block));
    attempt(result, "stages", () => decodePlusStages(block));
    attempt(result, "globals", () => decodePlusGlobals(block));
    attempt(result, "sound", () => decodePlusSound(block));
    attempt(result, "hiScores", () => decodePlusHiScores(block));
    attempt(result, "settings", () => decodePlusSettings(block));
    return result;
}
