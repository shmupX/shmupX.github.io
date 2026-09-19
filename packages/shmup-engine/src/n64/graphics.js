// Dezaemon 3D graphics: N64 RGBA5551, and why the other consoles' unpack
// does not apply here.
//
// A CGR or a per-stage GR file decompresses to a flat sheet of 64-pixel-wide
// scanlines, two bytes per pixel, no palette — the Saturn and PlayStation
// Dezaemons index a colour bank, this one does not. The word is big-endian
// RRRRRGGG GGBBBBBA: five bits each of red, green and blue, then ONE bit of
// alpha in bit 0. That is the difference that matters. rgb555ToRgb in
// src/psx/decode-cg.js reads bit 15 as the flag and the low fifteen as colour;
// run it on this and every channel comes out shifted.
//
// The format was settled by counting rather than by assertion: of the 432,506
// nonzero big-endian words in SAMPLEZ1.0GR, every single one has bit 0 set,
// and so do all 29,180 in CGR. Nothing but an alpha bit produces a ratio of
// exactly 1. It also corrects the published documentation's image count —
// 0x104000 / 2 / (64 x 32) is 260 tiles per stage, not the 520 it claims.
//
// Environment-neutral ESM (Node + browser).

/** Every graphics sheet on this disk is 64 pixels wide. */
export const SHEET_WIDTH = 64;

/** A tile as the editor deals them out. */
export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;

/** Bytes in one tile: 64 x 32 pixels at two bytes each. */
export const TILE_BYTES = TILE_WIDTH * TILE_HEIGHT * 2;

/**
 * Expand RGBA5551 to straight RGBA8888. Five-bit channels are scaled by
 * x * 255 / 31 rather than by a left shift, so 31 lands on 255 and not 248.
 * @param {Uint8Array} bytes  a decompressed CGR or GR payload
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodeRgba5551(bytes) {
    const pixels = bytes.length >> 1;
    const width = SHEET_WIDTH;
    const height = Math.ceil(pixels / width);
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels; i++) {
        const v = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
        const o = i * 4;
        data[o] = (((v >> 11) & 31) * 255 / 31) | 0;
        data[o + 1] = (((v >> 6) & 31) * 255 / 31) | 0;
        data[o + 2] = (((v >> 1) & 31) * 255 / 31) | 0;
        data[o + 3] = (v & 1) ? 255 : 0;
    }
    return { width, height, data };
}

/**
 * The same sheet dealt into its tiles and laid out as a contact sheet, which
 * is how a stage's 260 tiles become one look-at-able picture.
 * @param {Uint8Array} bytes  a decompressed CGR or GR payload
 * @param {{columns?: number}} [options]
 * @returns {{width: number, height: number, data: Uint8Array, tiles: number}}
 */
export function decodeTileSheet(bytes, { columns = 20 } = {}) {
    const tiles = Math.floor(bytes.length / TILE_BYTES);
    if (tiles === 0) return { ...decodeRgba5551(bytes), tiles: 0 };
    const cols = Math.max(1, Math.min(columns, tiles));
    const rows = Math.ceil(tiles / cols);
    const width = cols * TILE_WIDTH;
    const height = rows * TILE_HEIGHT;
    const data = new Uint8Array(width * height * 4);
    for (let t = 0; t < tiles; t++) {
        const cx = (t % cols) * TILE_WIDTH;
        const cy = Math.floor(t / cols) * TILE_HEIGHT;
        const base = t * TILE_BYTES;
        for (let y = 0; y < TILE_HEIGHT; y++) {
            for (let x = 0; x < TILE_WIDTH; x++) {
                const at = base + (y * TILE_WIDTH + x) * 2;
                const v = (bytes[at] << 8) | bytes[at + 1];
                const o = ((cy + y) * width + (cx + x)) * 4;
                data[o] = (((v >> 11) & 31) * 255 / 31) | 0;
                data[o + 1] = (((v >> 6) & 31) * 255 / 31) | 0;
                data[o + 2] = (((v >> 1) & 31) * 255 / 31) | 0;
                data[o + 3] = (v & 1) ? 255 : 0;
            }
        }
    }
    return { width, height, data, tiles };
}

/**
 * The share of nonzero words carrying the alpha bit. The test that identified
 * the format, kept so a fixture can re-run it: anything below 1 means the
 * payload is not RGBA5551 and should not be rendered as if it were.
 * @param {Uint8Array} bytes
 * @returns {{words: number, nonzero: number, alphaSet: number, ratio: number}}
 */
export function alphaBitRatio(bytes) {
    const words = bytes.length >> 1;
    let nonzero = 0, alphaSet = 0;
    for (let i = 0; i < words; i++) {
        const v = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
        if (!v) continue;
        nonzero++;
        if (v & 1) alphaSet++;
    }
    return { words, nonzero, alphaSet, ratio: nonzero ? alphaSet / nonzero : 0 };
}
