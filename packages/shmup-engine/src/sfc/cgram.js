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

/** Rows in the shape decode-cg.js indexedToRgba() takes: [{colors}]. */
export function rowsToPalettes(rows) {
    return rows.map((row) => ({ colors: row.colors }));
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
        rows,
        palettes: rowsToPalettes(rows),
        colorRowCount,
        allColor: colorRowCount === rows.length,
    };
}
