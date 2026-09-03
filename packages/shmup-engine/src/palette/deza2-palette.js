// Dezaemon 2's colour palette — the 288 colours the Saturn editor paints with.
//
// DEZA2.PAL on the disc is 576 bytes: 18 rows x 16 entries of u16be Saturn
// RGB555 (R bits 0-4, G 5-9, B 10-14, bit 15 = the CRAM flag, ignored). Its
// rows line up with a save's palette bank (sec4, 16 rows x 16 colours — see
// decode-cg.js) and then run two rows past it:
//
//   rows  0-11  the 192 SYSTEM colours — byte-identical to rows 0-11 of every
//               save's sec4 (verified across the corpus; the editor never
//               lets them be changed)
//   rows 12-15  the 4 USER palettes (64 colours) — empty on the disc (0x0000
//               with an 0x0021 end marker); a save carries whatever the author
//               mixed, stored 0x8000|colour
//   rows 16-17  32 entries the editor UI itself draws with — NOT part of a
//               save and not addressable by a CG pixel
//
// A CG pixel byte is (palette << 4) | colour, i.e. row*16 + column, so for the
// first 256 entries the palette index IS the pixel byte, and index 0 (system
// row 0, colour 0) is the transparent background. That is the contract a
// future .sav writer needs: indexed cells whose bytes are palette indices
// 0..255, plus the 16x16 bank (system rows fixed, user rows authored).
//
// Served flat as /palette.png (1 x 288, one pixel per entry in this order —
// scripts/build-palette.ts) so a tool can load the palette as an image;
// 5->8 bit replication is lossless, so `r8 >> 3` recovers every 5-bit
// channel and the PNG round-trips to these exact words.
//
// Environment-neutral ESM (Node + browser).

import { rgb555ToRgb } from "../decode/decode-cg.js";

export const DEZA2_PALETTE_COLS = 16;
export const DEZA2_PALETTE_ROWS = 18;
export const DEZA2_PALETTE_SIZE = DEZA2_PALETTE_COLS * DEZA2_PALETTE_ROWS; // 288
export const DEZA2_SYSTEM_ROWS = 12;
export const DEZA2_USER_ROWS = 4;
export const DEZA2_UI_ROWS = 2;
/** Entries a CG pixel byte can address: rows 0-15. */
export const DEZA2_CG_COLORS = (DEZA2_SYSTEM_ROWS + DEZA2_USER_ROWS) * DEZA2_PALETTE_COLS; // 256
/** The served image, one pixel per palette entry, top to bottom. */
export const DEZA2_PALETTE_PNG = "/palette.png";

/** DEZA2.PAL verbatim: 288 u16 RGB555 words, row-major. */
export const DEZA2_PALETTE_WORDS = Object.freeze([
    // row  0 — system 0
    0x0000, 0x53de, 0x3fde, 0x03de, 0x233e, 0x1a9e, 0x11fe, 0x095e, 0x00be, 0x001e, 0x0019, 0x0014, 0x000f, 0x000a, 0x0006, 0x0003,
    // row  1 — system 1
    0x73fc, 0x63f8, 0x53f4, 0x43f0, 0x33ec, 0x23e8, 0x13e4, 0x03e0, 0x0340, 0x02e0, 0x0280, 0x0220, 0x01c0, 0x0160, 0x0100, 0x00a0,
    // row  2 — system 2
    0x7ff4, 0x7fe5, 0x7b84, 0x7343, 0x6b02, 0x62c1, 0x5a80, 0x5240, 0x4a00, 0x41c0, 0x3980, 0x3140, 0x2900, 0x20c0, 0x1880, 0x1040,
    // row  3 — system 3
    0x7ffc, 0x7f99, 0x7f37, 0x7ed4, 0x7e71, 0x7e2f, 0x7dcc, 0x7d6a, 0x7d07, 0x7ca4, 0x7c41, 0x7c00, 0x6400, 0x5000, 0x3c00, 0x2800,
    // row  4 — system 4
    0x7fff, 0x7bde, 0x739c, 0x6b5a, 0x6318, 0x5ad6, 0x5294, 0x4a52, 0x4210, 0x39ce, 0x318c, 0x294a, 0x2108, 0x18c6, 0x1084, 0x0842,
    // row  5 — system 5
    0x42db, 0x3a99, 0x3257, 0x2a15, 0x21d4, 0x1992, 0x1971, 0x1950, 0x152f, 0x150e, 0x150d, 0x10eb, 0x08ca, 0x0888, 0x0866, 0x0444,
    // row  6 — system 6
    0x025a, 0x01d6, 0x0152, 0x00ce, 0x004a, 0x0006, 0x0003, 0x239c, 0x1f39, 0x1ad6, 0x1673, 0x1210, 0x0dad, 0x094a, 0x04e7, 0x0084,
    // row  7 — system 7
    0x781e, 0x681a, 0x5816, 0x4812, 0x380e, 0x280a, 0x1806, 0x7c14, 0x7c10, 0x700e, 0x600c, 0x500a, 0x4008, 0x3006, 0x2004, 0x1002,
    // row  8 — system 8
    0x739f, 0x631e, 0x5add, 0x4a5c, 0x39db, 0x295a, 0x18d9, 0x5652, 0x4e10, 0x45ce, 0x3d8c, 0x354a, 0x2d08, 0x24c6, 0x1c84, 0x1442,
    // row  9 — system 9
    0x67be, 0x533a, 0x46d8, 0x3654, 0x19b0, 0x052c, 0x0088, 0x433f, 0x3afd, 0x3adb, 0x3aba, 0x3279, 0x2e57, 0x2a35, 0x1db1, 0x150a,
    // row 10 — system 10
    0x73ff, 0x6bde, 0x639c, 0x5b5a, 0x5318, 0x4ad6, 0x4294, 0x3a52, 0x3210, 0x29ce, 0x218c, 0x194a, 0x1108, 0x08c6, 0x0084, 0x0042,
    // row 11 — system 11
    0x77ff, 0x6fbd, 0x677b, 0x5f39, 0x56f7, 0x4eb5, 0x4673, 0x3e31, 0x35ef, 0x2dad, 0x256b, 0x1d29, 0x14e7, 0x0ca5, 0x0463, 0x0021,
    // row 12 — user 0
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0021,
    // row 13 — user 1
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0021,
    // row 14 — user 2
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0021,
    // row 15 — user 3
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0021,
    // row 16 — ui 0
    0x0039, 0x3900, 0x2120, 0x4040, 0x0039, 0x0000, 0x2120, 0x4040, 0x0000, 0x0039, 0x2121, 0x4040, 0x0000, 0x3937, 0x2140, 0x2140,
    // row 17 — ui 1
    0x0000, 0x3937, 0x2140, 0x4040, 0x0039, 0x3921, 0x2121, 0x4020, 0x0039, 0x0021, 0x4021, 0x4020, 0x0000, 0x0021, 0x3520, 0x4040,
]);

/** Which band of the palette an index falls in. */
export function deza2PaletteBand(index) {
    const row = index >> 4;
    if (index < 0 || index >= DEZA2_PALETTE_SIZE) return null;
    if (row < DEZA2_SYSTEM_ROWS) return "system";
    if (row < DEZA2_SYSTEM_ROWS + DEZA2_USER_ROWS) return "user";
    return "ui";
}

/** 8-bit channels -> Saturn RGB555 word (bit 15 clear). */
export function rgb8ToRgb555(r, g, b) {
    return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

/**
 * The palette as {r, g, b, raw, band} entries, `words` defaulting to the
 * disc table. A save's own bank can be passed to get its user rows.
 */
export function deza2PaletteRgb(words = DEZA2_PALETTE_WORDS) {
    const out = new Array(words.length);
    for (let i = 0; i < words.length; i++) {
        const raw = words[i] & 0x7fff;
        const { r, g, b } = rgb555ToRgb(raw);
        out[i] = { r, g, b, raw, band: deza2PaletteBand(i) };
    }
    return out;
}

/**
 * The palette as an RGBA raster, 1 pixel wide and one row per entry — exactly
 * what /palette.png holds. Alpha is 255 everywhere: the transparent slot is a
 * property of index 0 in a cell, not of the colour itself.
 */
export function deza2PaletteRaster(words = DEZA2_PALETTE_WORDS) {
    const data = new Uint8Array(words.length * 4);
    const rgb = deza2PaletteRgb(words);
    for (let i = 0; i < rgb.length; i++) {
        data[i * 4] = rgb[i].r;
        data[i * 4 + 1] = rgb[i].g;
        data[i * 4 + 2] = rgb[i].b;
        data[i * 4 + 3] = 255;
    }
    return { width: 1, height: words.length, data };
}

/**
 * Read the palette back out of the served PNG's pixels (RGBA, one entry per
 * pixel in order). Bit replication makes `>> 3` exact, so this returns the
 * original words.
 */
export function paletteWordsFromRgba(rgba, count = rgba.length >> 2) {
    const words = new Array(count);
    for (let i = 0; i < count; i++) {
        words[i] = rgb8ToRgb555(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
    return words;
}

/**
 * The index of the palette entry nearest an 8-bit colour, by squared RGB
 * distance. `cgOnly` restricts the search to the 256 entries a CG pixel can
 * carry (the default: an imported PNG has to land in a save). Index 0 is
 * skipped unless `allowTransparent`: it is the transparent slot, so an opaque
 * black pixel maps to the darkest real colour instead of vanishing.
 */
export function nearestPaletteIndex(r, g, b, palette, { cgOnly = true, allowTransparent = false } = {}) {
    const limit = cgOnly ? Math.min(palette.length, DEZA2_CG_COLORS) : palette.length;
    let best = -1;
    let bestD = Infinity;
    for (let i = allowTransparent ? 0 : 1; i < limit; i++) {
        const p = palette[i];
        const dr = p.r - r, dg = p.g - g, db = p.b - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

// --- sprite records: the pixel editor's Dezaemon-native form ---------------
//
// A sprite is w x h pixels of palette indices, stored the way the CG pages
// store them: as 16x16 cells of 256 bytes (byte = y*16+x inside the cell),
// cells in reading order across the sprite. That is the exact byte layout of
// sec0-3, so a writer places each cell at cellIndex*256 and composes the
// frame from cell refs — no re-encoding. `w` and `h` must be multiples of 16.

export const CG_CELL = 16;
export const CG_CELL_BYTES = CG_CELL * CG_CELL;

/** Row-major indexed pixels (w*h bytes) -> cell-major bytes (same length). */
export function indexedToCells(indexed, w, h) {
    const cw = w / CG_CELL, ch = h / CG_CELL;
    if (!Number.isInteger(cw) || !Number.isInteger(ch)) {
        throw new Error(`sprite ${w}x${h} is not a whole number of 16x16 cells`);
    }
    const out = new Uint8Array(w * h);
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            const base = (cy * cw + cx) * CG_CELL_BYTES;
            for (let y = 0; y < CG_CELL; y++) {
                const srcRow = (cy * CG_CELL + y) * w + cx * CG_CELL;
                out.set(indexed.subarray(srcRow, srcRow + CG_CELL), base + y * CG_CELL);
            }
        }
    }
    return out;
}

/** Cell-major bytes -> row-major indexed pixels. */
export function cellsToIndexed(cells, w, h) {
    const cw = w / CG_CELL, ch = h / CG_CELL;
    const out = new Uint8Array(w * h);
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            const base = (cy * cw + cx) * CG_CELL_BYTES;
            for (let y = 0; y < CG_CELL; y++) {
                const dstRow = (cy * CG_CELL + y) * w + cx * CG_CELL;
                out.set(cells.subarray(base + y * CG_CELL, base + (y + 1) * CG_CELL), dstRow);
            }
        }
    }
    return out;
}

/** Indexed pixels -> RGBA through a palette; index 0 stays transparent. */
export function indexedToRgbaWith(indexed, palette) {
    const rgba = new Uint8ClampedArray(indexed.length * 4);
    for (let i = 0; i < indexed.length; i++) {
        const v = indexed[i];
        if (v === 0) continue;
        const p = palette[v];
        if (!p) continue;
        const o = i * 4;
        rgba[o] = p.r; rgba[o + 1] = p.g; rgba[o + 2] = p.b; rgba[o + 3] = 255;
    }
    return rgba;
}

/**
 * The 16x16 palette bank a save would carry for a sprite drawn against this
 * palette: 256 words, system rows verbatim, user rows as authored, stored the
 * way sec4 stores user colours (0x8000 | colour, 0 = empty).
 */
export function paletteBankWords(words = DEZA2_PALETTE_WORDS) {
    const bank = new Array(DEZA2_CG_COLORS);
    for (let i = 0; i < DEZA2_CG_COLORS; i++) {
        const w = words[i] & 0x7fff;
        bank[i] = (i >> 4) < DEZA2_SYSTEM_ROWS ? w : (w ? 0x8000 | w : 0);
    }
    return bank;
}

/** Zako frame sizes (records 0-59 of the sprite bank, FORMAT.md) — w x h px. */
export const DEZA2_ZAKO_SIZES = Object.freeze([
    { w: 16, h: 16, frames: 4, label: "16×16" },
    { w: 32, h: 16, frames: 4, label: "32×16" },
    { w: 16, h: 32, frames: 4, label: "16×32" },
    { w: 32, h: 32, frames: 4, label: "32×32" },
    { w: 64, h: 32, frames: 2, label: "64×32" },
    { w: 32, h: 64, frames: 2, label: "32×64" },
    { w: 64, h: 64, frames: 1, label: "64×64" },
]);
