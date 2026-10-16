// PALETTE DATA: SNES CGRAM rows as stored in SRAM.
//
// The SNES colour word is the same 15-bit layout the Saturn uses (R bits 0-4,
// G 5-9, B 10-14) — only the byte order differs, little-endian here — so the
// Saturn decoder's rgb555ToRgb() converts SNES colours unchanged. Bit 15 is
// never set in a colour word, which is what tells a palette row from data:
// of the region's 24 rows, the first 22 are colour in the sample and the last
// two (0x300-0x33F) carry bit-15 words, so they are something else the editor
// keeps beside its colours (open).
//
// A row is 16 colours = 32 bytes, one 4bpp palette; colour 0 of a row is
// transparent for sprites and BG tiles alike. This is the reader half of
// palette-target.js's snesCgramBytes(). Environment-neutral ESM (Node + browser).

import { rgb555ToRgb } from "../decode/decode-cg.js";
import { REGION } from "./regions.js";

export const CGRAM_ROW_COLORS = 16;
export const CGRAM_ROW_BYTES = CGRAM_ROW_COLORS * 2;
export const PALETTE_ROW_COUNT = REGION.palette.length / CGRAM_ROW_BYTES; // 24
/**
 * What each row colours (the stage copy $03:C790 moves rows n, 6+n and 12+n
 * for stage n, the global copy $03:C731 rows 18-21; the editor's PALETTE
 * screen names them): 0-5 the stages' scenery, 6-11 their enemies, 12-17
 * their bosses, 18 the ship, 19 the title and ending, 20 items and weapons,
 * 21 a free row, 22-23 the editor's own colour picker (never copied to CGRAM).
 */
export const PALETTE_ROW_STAGE_BG = 0;
export const PALETTE_ROW_STAGE_ENEMY = 6;
export const PALETTE_ROW_STAGE_BOSS = 12;
export const PALETTE_ROW_SHIP = 18;
export const PALETTE_ROW_TITLE = 19;
export const PALETTE_ROW_ITEMS = 20;
export const PALETTE_ROW_FREE = 21;
export const PALETTE_ROW_PICKER = 22;
export function paletteRowRole(row) {
    if (row < 6) return `stage ${row} scenery`;
    if (row < 12) return `stage ${row - 6} enemies`;
    if (row < 18) return `stage ${row - 12} boss`;
    return ["ship", "title and ending", "items and weapons", "free", "editor picker", "editor picker"][row - 18] ?? `row ${row}`;
}

export function readColorWord(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

/** True when all 16 words at `offset` have bit 15 clear. */
export function isColorRow(bytes, offset) {
    if (offset + CGRAM_ROW_BYTES > bytes.length) return false;
    for (let i = 0; i < CGRAM_ROW_COLORS; i++) {
        if (readColorWord(bytes, offset + i * 2) & 0x8000) return false;
    }
    return true;
}

/** 8-bit r, g, b -> the 15-bit colour word (R bits 0-4, G 5-9, B 10-14). */
export function encodeColorWord(r, g, b) {
    return ((r >> 3) & 0x1f) | (((g >> 3) & 0x1f) << 5) | (((b >> 3) & 0x1f) << 10);
}

/**
 * Write one PALETTE DATA row: up to 16 colour words (missing ones 0). The
 * game copies a row into colours 1..15 of the CGRAM palette its layer owns
 * (colour 0 is transparent, word 15 is never copied — FORMAT-SFC.md "Running
 * a save"), so word k is the colour a pixel of index k + 1 draws: a sprite
 * whose pixels are 1..n wants its n colours in words 0..n-1.
 */
export function writeCgramRow(bytes, row, words) {
    if (row < 0 || row >= PALETTE_ROW_COUNT) throw new Error(`palette row ${row} is outside 0..${PALETTE_ROW_COUNT - 1}`);
    const at = REGION.palette.offset + row * CGRAM_ROW_BYTES;
    for (let i = 0; i < CGRAM_ROW_COLORS; i++) {
        const w = (words[i] ?? 0) & 0x7fff;
        bytes[at + i * 2] = w & 0xff;
        bytes[at + i * 2 + 1] = w >> 8;
    }
    return bytes;
}

/** One 16-colour row -> {offset, raw: Uint16Array(16), colors: [{raw, r, g, b}], color}. */
export function decodeCgramRow(bytes, offset) {
    if (offset + CGRAM_ROW_BYTES > bytes.length) {
        throw new Error(`palette row at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    const raw = new Uint16Array(CGRAM_ROW_COLORS);
    const colors = [];
    let color = true;
    for (let i = 0; i < CGRAM_ROW_COLORS; i++) {
        const word = readColorWord(bytes, offset + i * 2);
        raw[i] = word;
        if (word & 0x8000) color = false;
        const { r, g, b } = rgb555ToRgb(word & 0x7fff);
        colors.push({ raw: word, r, g, b });
    }
    return { offset, raw, colors, color };
}

export function decodeCgramRows(bytes, offset, count) {
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(decodeCgramRow(bytes, offset + i * CGRAM_ROW_BYTES));
    return rows;
}

const TRANSPARENT_COLOR = Object.freeze({ raw: 0, r: 0, g: 0, b: 0 });

/**
 * Rows in the shape decode-cg.js indexedToRgba() takes, [{colors}], laid out
 * as the console draws them: the game copies a row into colours 1..15 of its
 * CGRAM palette, so a pixel of index k shows row word k - 1 and word 15 is
 * never seen. Colour 0 is the transparent slot (never read: index 0 is left
 * clear).
 */
export function rowsToPalettes(rows) {
    return rows.map((row) => ({ colors: [TRANSPARENT_COLOR, ...row.colors.slice(0, CGRAM_ROW_COLORS - 1)] }));
}

/**
 * The whole PALETTE DATA region: 24 rows, how many of them are colour words,
 * and the rows as palettes for indexedToRgba().
 */
export function decodePaletteData(bytes) {
    const rows = decodeCgramRows(bytes, REGION.palette.offset, PALETTE_ROW_COUNT);
    const colorRowCount = rows.filter((row) => row.color).length;
    return {
        offset: REGION.palette.offset,
        rows: rows.map((row, i) => ({ ...row, row: i, role: paletteRowRole(i) })),
        palettes: rowsToPalettes(rows),
        colorRowCount,
        allColor: colorRowCount === rows.length,
    };
}
