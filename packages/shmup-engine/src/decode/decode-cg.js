// Dezaemon 2 CG decoder — the confirmed graphics layer of the save format.
//
// sec0..sec3 are the CG editor's four art pages: headerless 128x512-pixel
// 8bpp bitmaps stored as 256 consecutive 16x16-pixel cells of 256 bytes
// (cell t at t*256; within a cell, byte = y*16+x; 8 cells per page row).
// Each pixel byte is (paletteIndex << 4) | colorIndex.
//
// The 8-cell row width is measured, not assumed: horizontal edge continuity
// between cell c and cell c+1 collapses to ~4% whenever c%8 == 7 and sits at
// 18-43% everywhere else, across all four pages of all 17 corpus games.
//
// sec4 is the palette bank: 16 palettes x 16 colors, u16be Saturn RGB555
// with red in the LOW bits (R=bits0-4, G=5-9, B=10-14, bit15 = CRAM flag).
// Rows 0-11 are fixed engine presets ("192 system colors", byte-identical in
// every game observed); rows 12-15 are the 4 user palettes ("64 user
// colors", stored 0x8000|color, 0x0000 = empty slot).
//
// Established by cross-corpus analysis of 17 games + the retail disc's
// sample-game files; see FORMAT.md "Section semantics".
//
// Environment-neutral ESM (Node + browser).

export const CG_PAGE_SIZE = 65536;
export const CG_CELL_DIM = 16; // pixels per side
export const CG_CELLS_PER_PAGE = 256;
export const CG_CELLS_PER_ROW = 8;
export const CG_PAGE_WIDTH = CG_CELLS_PER_ROW * CG_CELL_DIM; // 128 px
export const CG_PAGE_HEIGHT = (CG_CELLS_PER_PAGE / CG_CELLS_PER_ROW) * CG_CELL_DIM; // 512 px
export const PALETTE_COUNT = 16;
export const COLORS_PER_PALETTE = 16;

// Saturn RGB555 (R bits 0-4, G 5-9, B 10-14; bit 15 is the CRAM/ATTR flag
// and is ignored) -> 8-bit channels, 5->8 with bit replication so pure white
// is 255,255,255. The same encoding is used by the palette bank, the sec7
// model colour and the MDLDT part library's polygon colours.
export function rgb555ToRgb(raw) {
    const r5 = raw & 0x1f;
    const g5 = (raw >> 5) & 0x1f;
    const b5 = (raw >> 10) & 0x1f;
    return {
        r: (r5 << 3) | (r5 >> 2),
        g: (g5 << 3) | (g5 >> 2),
        b: (b5 << 3) | (b5 >> 2),
    };
}

// RGB555 -> 0xRRGGBB.
export function rgb555ToHex(raw) {
    const { r, g, b } = rgb555ToRgb(raw);
    return (r << 16) | (g << 8) | b;
}

// sec4 -> [{colors: [{r,g,b,raw,empty}] x16}] x16 (8-bit channels).
export function decodePalettes(sec4) {
    if (sec4.length < PALETTE_COUNT * COLORS_PER_PALETTE * 2) {
        throw new Error(`palette bank too small: ${sec4.length}`);
    }
    const palettes = [];
    for (let p = 0; p < PALETTE_COUNT; p++) {
        const colors = [];
        for (let c = 0; c < COLORS_PER_PALETTE; c++) {
            const off = (p * COLORS_PER_PALETTE + c) * 2;
            const raw = (sec4[off] << 8) | sec4[off + 1];
            const { r, g, b } = rgb555ToRgb(raw);
            colors.push({
                raw,
                r,
                g,
                b,
                empty: raw === 0x0000,
            });
        }
        palettes.push({ colors });
    }
    return palettes;
}

// De-cell one CG page into a linear 128x512 indexed raster (one byte per
// pixel, value = (palette<<4)|colorIndex exactly as stored).
export function decodeCgPage(section) {
    if (section.length < CG_PAGE_SIZE) {
        throw new Error(`CG page too small: ${section.length}`);
    }
    const out = new Uint8Array(CG_PAGE_WIDTH * CG_PAGE_HEIGHT);
    for (let cell = 0; cell < CG_CELLS_PER_PAGE; cell++) {
        const cellX = (cell % CG_CELLS_PER_ROW) * CG_CELL_DIM;
        const cellY = ((cell / CG_CELLS_PER_ROW) | 0) * CG_CELL_DIM;
        const base = cell * 256;
        for (let y = 0; y < CG_CELL_DIM; y++) {
            for (let x = 0; x < CG_CELL_DIM; x++) {
                out[(cellY + y) * CG_PAGE_WIDTH + cellX + x] = section[base + y * CG_CELL_DIM + x];
            }
        }
    }
    return out;
}

// Indexed raster (+ palettes) -> RGBA. Pixel byte 0x00 is the transparent
// background (the editor's "palette 0 color 0 = 100% transparent").
export function indexedToRgba(indexed, palettes, { transparentZero = true } = {}) {
    const rgba = new Uint8ClampedArray(indexed.length * 4);
    for (let i = 0; i < indexed.length; i++) {
        const v = indexed[i];
        if (transparentZero && v === 0x00) continue; // leave 0,0,0,0
        const color = palettes[v >> 4].colors[v & 0x0f];
        const o = i * 4;
        rgba[o] = color.r;
        rgba[o + 1] = color.g;
        rgba[o + 2] = color.b;
        rgba[o + 3] = 255;
    }
    return rgba;
}

// Extract one 16x16 cell (global index 0..1023 across the four pages) as an
// indexed Uint8Array(256). `sections` = [sec0, sec1, sec2, sec3].
export function cellIndexed(sections, cellIndex) {
    const page = cellIndex >> 8;
    const cell = cellIndex & 0xff;
    const section = sections[page];
    if (!section) throw new Error(`cell ${cellIndex}: page ${page} missing`);
    return section.subarray(cell * 256, cell * 256 + 256);
}

export function cellIsBlank(sections, cellIndex) {
    const bytes = cellIndexed(sections, cellIndex);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

// Full CG decode used by decodeSave(): pages as indexed rasters + RGBA,
// per-page non-blank cell bitmap (Uint8Array(256), 1 = has pixels).
export function decodeCg(sections, sec4) {
    const palettes = decodePalettes(sec4);
    const pages = sections.map((section, p) => {
        const indexed = decodeCgPage(section);
        const usedCells = new Uint8Array(CG_CELLS_PER_PAGE);
        let usedCount = 0;
        for (let c = 0; c < CG_CELLS_PER_PAGE; c++) {
            if (!cellIsBlank(sections, p * 256 + c)) {
                usedCells[c] = 1;
                usedCount++;
            }
        }
        return {
            page: p,
            width: CG_PAGE_WIDTH,
            height: CG_PAGE_HEIGHT,
            indexed,
            rgba: indexedToRgba(indexed, palettes),
            usedCells,
            usedCount,
        };
    });
    return { palettes, pages };
}
