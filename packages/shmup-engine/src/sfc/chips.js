// Chip words: what every GROUP table holds, and the sheets they point into.
//
// A group word is not a VRAM tile number. The chip assembler ($80:AC5D, ROM
// 0x2C5D) turns it into a SOURCE address through a five-entry sheet table at
// $00:AEB9 — bits 8-10 pick the sheet, bits 3-7 a chip row, bits 0-2 a chip
// column — and copies that 16x16 chip (four 8x8 4bpp tiles) into the slot the
// word occupies in its table; the slot, not the word, decides the VRAM tile.
// Bits 14 and 15 are horizontal and vertical flips; 11-13 are masked off.
//
// Sheets 0 and 1 are the save's own GRAPIC DATA (SRAM 0x10000 and 0x18000),
// 2 and 3 the factory art in the ROM (0x40000, 0x48000), 4 the editor's
// icons (ROM 0x60000). A sheet is 32 KB laid out 16 tiles (128 px) wide: 32
// chip rows of 8 chips, a chip row 0x400 bytes, a chip 0x40 bytes with its
// tiles at +0 (top-left), +0x20 (top-right), +0x200 (bottom-left), +0x220
// (bottom-right). 0xFFFF is the empty word; the assembler draws it as the
// ROM's blank chip at $89:FDC0, which is sheet 3, row 31, column 7 — the word
// 0x03FF, the other empty the tables use.
//
// So the factory sample's groups only ever name words 0x200-0x3FF (its art is
// the ROM's, which is why its SRAM graphics bank is zero and it still draws)
// and a user cart's name 0x000-0x1FF. A writer's chip index 0..511 into the
// two user sheets IS its word: sheet*256 + row*8 + col.
//
// The two ODR regions reference a stage's assembled 64-slot ENEMY sheet (or
// the ship's) by SLOT: a byte is [V:1][H:1][row:3][col:3], slot = row*8+col.
// FORMAT-SFC.md "The sprite sheets". Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { decodeTile4bpp, encodeTile4bpp, TILE_BYTES_4BPP, TILE_DIM } from "./tiles.js";

export const CHIP_DIM = 16;
export const CHIP_PIXELS = CHIP_DIM * CHIP_DIM;
export const CHIP_SHEET_BYTES = 0x8000;
export const CHIP_SHEET_COLS = 8;
export const CHIP_SHEET_ROWS = 32;
export const CHIPS_PER_SHEET = CHIP_SHEET_COLS * CHIP_SHEET_ROWS; // 256
export const CHIP_ROW_BYTES = 0x400;
export const CHIP_COL_BYTES = 0x40;
/** The chip's four tiles, as byte offsets from its top-left tile. */
export const CHIP_TILE_OFFSETS = Object.freeze([0x000, 0x020, 0x200, 0x220]);
export const CHIP_HFLIP = 0x4000;
export const CHIP_VFLIP = 0x8000;
export const CHIP_FLIP_MASK = CHIP_HFLIP | CHIP_VFLIP;
export const CHIP_WORD_MASK = 0x07ff;
/** The two empty words: 0xFFFF (the assembler's own) and the ROM blank chip it resolves to. */
export const CHIP_EMPTY_WORD = 0xffff;
export const CHIP_BLANK_WORD = 0x03ff;
/** How many chips the save's own two sheets hold. */
export const USER_CHIP_COUNT = 2 * CHIPS_PER_SHEET; // 512

/** The sheet table at $00:AEB9: where each of bits 8-10's values reads from. */
export const SFC_SHEETS = Object.freeze([
    Object.freeze({ sheet: 0, source: "sram", offset: REGION.graphics.offset, what: "GRAPIC DATA, first half" }),
    Object.freeze({ sheet: 1, source: "sram", offset: REGION.graphics.offset + CHIP_SHEET_BYTES, what: "GRAPIC DATA, second half" }),
    Object.freeze({ sheet: 2, source: "rom", offset: 0x40000, what: "factory art" }),
    Object.freeze({ sheet: 3, source: "rom", offset: 0x48000, what: "factory art" }),
    Object.freeze({ sheet: 4, source: "rom", offset: 0x60000, what: "editor icons" }),
]);

/** A chip word's fields. `index` is the user-sheet chip 0..511, null for a ROM sheet. */
export function decodeChipWord(word) {
    const sheet = (word >> 8) & 7;
    const row = (word >> 3) & 0x1f;
    const col = word & 7;
    const empty = word === CHIP_EMPTY_WORD || (word & CHIP_WORD_MASK) === CHIP_BLANK_WORD;
    return {
        word,
        sheet,
        row,
        col,
        hflip: (word & CHIP_HFLIP) !== 0,
        vflip: (word & CHIP_VFLIP) !== 0,
        empty,
        user: !empty && sheet < 2,
        rom: !empty && sheet >= 2 && sheet < SFC_SHEETS.length,
        index: !empty && sheet < 2 ? sheet * CHIPS_PER_SHEET + row * CHIP_SHEET_COLS + col : null,
    };
}

export function encodeChipWord({ sheet = 0, row = 0, col = 0, hflip = false, vflip = false } = {}) {
    return ((sheet & 7) << 8) | ((row & 0x1f) << 3) | (col & 7) | (hflip ? CHIP_HFLIP : 0) | (vflip ? CHIP_VFLIP : 0);
}

/** The word for user chip `index` (0..511), with flips. */
export function chipWordForIndex(index, { hflip = false, vflip = false } = {}) {
    if (index < 0 || index >= USER_CHIP_COUNT) throw new Error(`chip index ${index} is outside the two user sheets (0..${USER_CHIP_COUNT - 1})`);
    return index | (hflip ? CHIP_HFLIP : 0) | (vflip ? CHIP_VFLIP : 0);
}

/**
 * Where a chip's top-left tile lives: {source: "sram"|"rom", offset}, or null
 * for an empty word or a sheet past the table.
 */
export function chipSource(word) {
    const d = decodeChipWord(word);
    if (d.empty || d.sheet >= SFC_SHEETS.length) return null;
    const sheet = SFC_SHEETS[d.sheet];
    return { source: sheet.source, offset: sheet.offset + d.row * CHIP_ROW_BYTES + d.col * CHIP_COL_BYTES, sheet: d.sheet, row: d.row, col: d.col };
}

/** The SRAM offset of user chip `index`'s top-left tile. */
export function chipIndexOffset(index) {
    if (index < 0 || index >= USER_CHIP_COUNT) throw new Error(`chip index ${index} is outside the two user sheets`);
    return REGION.graphics.offset + (index >> 8) * CHIP_SHEET_BYTES + ((index >> 3) & 0x1f) * CHIP_ROW_BYTES + (index & 7) * CHIP_COL_BYTES;
}

/** The VRAM 8x8 tile number of slot `i` of an assembled sheet (the slot formula of $80:AE36). */
export function chipSlotTile(i) {
    return (i >> 3) * 32 + (i & 7) * 2;
}

/**
 * A chip's 256 colour indices (row-major, 16x16), flips applied, read from
 * the save (`sram`) or the ROM (`rom`, optional) as the word says; null when
 * the word is empty or its source is not there.
 */
export function decodeChipPixels(word, { sram, rom = null } = {}) {
    const src = chipSource(word);
    if (!src) return null;
    const bytes = src.source === "sram" ? sram : rom;
    if (!bytes || src.offset + CHIP_TILE_OFFSETS[3] + TILE_BYTES_4BPP > bytes.length) return null;
    const d = decodeChipWord(word);
    const out = new Uint8Array(CHIP_PIXELS);
    const tile = new Uint8Array(TILE_DIM * TILE_DIM);
    CHIP_TILE_OFFSETS.forEach((off, q) => {
        decodeTile4bpp(bytes, src.offset + off, tile);
        const ox = (q & 1) * TILE_DIM, oy = (q >> 1) * TILE_DIM;
        for (let y = 0; y < TILE_DIM; y++) {
            for (let x = 0; x < TILE_DIM; x++) {
                const px = ox + x, py = oy + y;
                const dx = d.hflip ? CHIP_DIM - 1 - px : px;
                const dy = d.vflip ? CHIP_DIM - 1 - py : py;
                out[dy * CHIP_DIM + dx] = tile[y * TILE_DIM + x];
            }
        }
    });
    return out;
}

/** Write a 16x16 raster of colour indices as user chip `index`'s four tiles. */
export function encodeChipPixels(sram, index, pixels) {
    const at = chipIndexOffset(index);
    const tile = new Uint8Array(TILE_DIM * TILE_DIM);
    CHIP_TILE_OFFSETS.forEach((off, q) => {
        const ox = (q & 1) * TILE_DIM, oy = (q >> 1) * TILE_DIM;
        for (let y = 0; y < TILE_DIM; y++) {
            for (let x = 0; x < TILE_DIM; x++) tile[y * TILE_DIM + x] = pixels[(oy + y) * CHIP_DIM + ox + x] & 0x0f;
        }
        encodeTile4bpp(tile, sram.subarray(at + off, at + off + TILE_BYTES_4BPP));
    });
    return sram;
}

/** A 16x16 raster mirrored (a copy). */
export function flipChip(pixels, hflip, vflip) {
    if (!hflip && !vflip) return pixels;
    const out = new Uint8Array(CHIP_PIXELS);
    for (let y = 0; y < CHIP_DIM; y++) {
        const sy = vflip ? CHIP_DIM - 1 - y : y;
        for (let x = 0; x < CHIP_DIM; x++) out[y * CHIP_DIM + x] = pixels[sy * CHIP_DIM + (hflip ? CHIP_DIM - 1 - x : x)];
    }
    return out;
}

// --- ODR bytes: slot references into an assembled sheet -----------------------

export const ODR_HFLIP = 0x40;
export const ODR_VFLIP = 0x80;
export const ODR_SLOT_MASK = 0x3f;

export function decodeOdrByte(b) {
    return { byte: b, slot: b & ODR_SLOT_MASK, row: (b >> 3) & 7, col: b & 7, hflip: (b & ODR_HFLIP) !== 0, vflip: (b & ODR_VFLIP) !== 0 };
}

export function encodeOdrByte({ slot = 0, hflip = false, vflip = false } = {}) {
    return (slot & ODR_SLOT_MASK) | (hflip ? ODR_HFLIP : 0) | (vflip ? ODR_VFLIP : 0);
}

/**
 * One of the save's two sheets as an indexed raster, 128 px wide by 512 tall
 * (32 chip rows of 8), for a probe to look at. Null when the dump stops short.
 */
export function userSheetIndexed(sram, sheet) {
    const base = SFC_SHEETS[sheet];
    if (!base || base.source !== "sram" || sram.length < base.offset + CHIP_SHEET_BYTES) return null;
    const width = CHIP_SHEET_COLS * CHIP_DIM, height = CHIP_SHEET_ROWS * CHIP_DIM;
    const indices = new Uint8Array(width * height);
    for (let row = 0; row < CHIP_SHEET_ROWS; row++) {
        for (let col = 0; col < CHIP_SHEET_COLS; col++) {
            const px = decodeChipPixels(encodeChipWord({ sheet, row, col }), { sram });
            if (!px) continue;
            for (let y = 0; y < CHIP_DIM; y++) {
                for (let x = 0; x < CHIP_DIM; x++) indices[(row * CHIP_DIM + y) * width + col * CHIP_DIM + x] = px[y * CHIP_DIM + x];
            }
        }
    }
    return { width, height, indices };
}
