// SNES planar tiles — the pixel format of GRAPIC DATA (and of any VRAM dump).
//
// An 8x8 4bpp tile is 32 bytes: rows 0-7 of bitplanes 0 and 1 interleaved
// (row y at bytes 2y and 2y+1), then rows 0-7 of bitplanes 2 and 3. Pixel x
// of a row is bit 7-x of each plane byte, so the leftmost pixel is the high
// bit. A 2bpp tile is the first 16 bytes of that scheme. Decoded tiles are
// Uint8Array(64) of colour indices 0-15, row-major.
//
// Nothing here knows about SRAM offsets; graphics.js and the group decoders
// pick the bytes, this file turns them into pixels (and back, for the writer
// that will eventually exist). Environment-neutral ESM (Node + browser).

export const TILE_DIM = 8;
export const TILE_PIXELS = TILE_DIM * TILE_DIM;
export const TILE_BYTES_4BPP = 32;
export const TILE_BYTES_2BPP = 16;

export function decodeTile4bpp(bytes, offset, out = new Uint8Array(TILE_PIXELS)) {
    for (let y = 0; y < TILE_DIM; y++) {
        const p0 = bytes[offset + y * 2];
        const p1 = bytes[offset + y * 2 + 1];
        const p2 = bytes[offset + 16 + y * 2];
        const p3 = bytes[offset + 16 + y * 2 + 1];
        for (let x = 0; x < TILE_DIM; x++) {
            const bit = 7 - x;
            out[y * TILE_DIM + x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        }
    }
    return out;
}

export function decodeTile2bpp(bytes, offset, out = new Uint8Array(TILE_PIXELS)) {
    for (let y = 0; y < TILE_DIM; y++) {
        const p0 = bytes[offset + y * 2];
        const p1 = bytes[offset + y * 2 + 1];
        for (let x = 0; x < TILE_DIM; x++) {
            const bit = 7 - x;
            out[y * TILE_DIM + x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
        }
    }
    return out;
}

export function encodeTile4bpp(indices, out = new Uint8Array(TILE_BYTES_4BPP)) {
    out.fill(0);
    for (let y = 0; y < TILE_DIM; y++) {
        for (let x = 0; x < TILE_DIM; x++) {
            const v = indices[y * TILE_DIM + x] & 0x0f;
            const bit = 7 - x;
            out[y * 2] |= (v & 1) << bit;
            out[y * 2 + 1] |= ((v >> 1) & 1) << bit;
            out[16 + y * 2] |= ((v >> 2) & 1) << bit;
            out[16 + y * 2 + 1] |= ((v >> 3) & 1) << bit;
        }
    }
    return out;
}

export function encodeTile2bpp(indices, out = new Uint8Array(TILE_BYTES_2BPP)) {
    out.fill(0);
    for (let y = 0; y < TILE_DIM; y++) {
        for (let x = 0; x < TILE_DIM; x++) {
            const v = indices[y * TILE_DIM + x] & 0x03;
            const bit = 7 - x;
            out[y * 2] |= (v & 1) << bit;
            out[y * 2 + 1] |= ((v >> 1) & 1) << bit;
        }
    }
    return out;
}

/** `count` consecutive tiles starting at `offset`. */
export function decodeTileSheet(bytes, offset, count, { bpp = 4 } = {}) {
    const stride = bpp === 2 ? TILE_BYTES_2BPP : TILE_BYTES_4BPP;
    const decode = bpp === 2 ? decodeTile2bpp : decodeTile4bpp;
    if (offset + count * stride > bytes.length) {
        throw new Error(`${count} ${bpp}bpp tiles at 0x${offset.toString(16)} run past the end (${bytes.length})`);
    }
    const tiles = [];
    for (let t = 0; t < count; t++) tiles.push(decode(bytes, offset + t * stride));
    return tiles;
}

export function tileIsBlank(tile) {
    for (let i = 0; i < tile.length; i++) if (tile[i] !== 0) return false;
    return true;
}

/** A tile mirrored horizontally and/or vertically (a copy; the input is untouched). */
export function flipTile(tile, hflip, vflip) {
    if (!hflip && !vflip) return tile;
    const out = new Uint8Array(TILE_PIXELS);
    for (let y = 0; y < TILE_DIM; y++) {
        const sy = vflip ? TILE_DIM - 1 - y : y;
        for (let x = 0; x < TILE_DIM; x++) {
            const sx = hflip ? TILE_DIM - 1 - x : x;
            out[y * TILE_DIM + x] = tile[sy * TILE_DIM + sx];
        }
    }
    return out;
}

/** Four tiles [top-left, top-right, bottom-left, bottom-right] -> one 16x16 raster. */
export function assemble2x2(tiles) {
    const out = new Uint8Array(256);
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const tile = tiles[(y >> 3) * 2 + (x >> 3)];
            out[y * 16 + x] = tile ? tile[(y & 7) * TILE_DIM + (x & 7)] : 0;
        }
    }
    return out;
}

/**
 * Lay tiles out as a sheet `cols` tiles wide: a linear indexed raster
 * (one colour index per pixel) the PNG writers and indexedToRgba() take.
 */
export function tilesToIndexed(tiles, cols = 16) {
    const rows = Math.ceil(tiles.length / cols);
    const width = cols * TILE_DIM;
    const height = rows * TILE_DIM;
    const indices = new Uint8Array(width * height);
    tiles.forEach((tile, t) => {
        const ox = (t % cols) * TILE_DIM;
        const oy = Math.floor(t / cols) * TILE_DIM;
        for (let y = 0; y < TILE_DIM; y++) {
            for (let x = 0; x < TILE_DIM; x++) indices[(oy + y) * width + ox + x] = tile[y * TILE_DIM + x];
        }
    });
    return { width, height, indices };
}

/**
 * Tag every opaque index with a palette row — (row << 4) | index — so
 * decode-cg.js indexedToRgba() colours the raster through that row. Index 0
 * stays 0: it is transparent whichever row a sprite uses.
 */
export function withPaletteRow(indices, row) {
    const out = new Uint8Array(indices.length);
    const tag = (row & 0x0f) << 4;
    for (let i = 0; i < indices.length; i++) out[i] = indices[i] ? tag | (indices[i] & 0x0f) : 0;
    return out;
}
