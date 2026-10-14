// A bank of 8x8 4bpp tiles for GRAPIC DATA, filled from indexed rasters.
//
// The writer's allocator: hand it a w x h raster of 4-bit colour indices
// (one palette row's worth — index 0 transparent) and it cuts the 8x8 tiles,
// stores each distinct one once, shares a tile with its horizontal and
// vertical mirrors through the tilemap flip bits, and returns one
// {tile, hflip, vflip} per cell, row-major. Tile 0 is kept blank so an empty
// cell has something to point at. How a tile index becomes a group word's
// tile number is the caller's business (sfc-write.js knows the banking);
// this only counts from 0. Environment-neutral ESM (Node + browser).

import { encodeTile4bpp, flipTile, TILE_BYTES_4BPP, TILE_DIM, tileIsBlank } from "./tiles.js";

export class SfcTileBank {
    /**
     * @param {number} capacity  how many tiles the bank may hold
     * @param {{reserveBlank?: boolean}} [options]  keep tile 0 blank (default true)
     */
    constructor(capacity, { reserveBlank = true } = {}) {
        this.capacity = capacity;
        this.tiles = [];
        this.byKey = new Map();
        this.shared = 0;
        this.blank = null;
        if (reserveBlank) this.blank = this.addTile(new Uint8Array(TILE_DIM * TILE_DIM)).tile;
    }

    get used() {
        return this.tiles.length;
    }

    get free() {
        return this.capacity - this.tiles.length;
    }

    /**
     * One 8x8 tile (64 indices, row-major) -> {tile, hflip, vflip}, reusing a
     * stored tile or one of its mirrors; null when the bank is full.
     */
    addTile(indices) {
        const key = keyOf(indices);
        const hit = this.byKey.get(key);
        if (hit) {
            if (hit.hflip || hit.vflip) this.shared++;
            return hit;
        }
        if (this.tiles.length >= this.capacity) return null;
        const tile = this.tiles.length;
        this.tiles.push(Uint8Array.from(indices));
        const plain = { tile, hflip: false, vflip: false };
        this.byKey.set(key, plain);
        // The three mirrors resolve to this tile with flip bits — unless a
        // mirror is the tile itself (symmetric art), where the plain entry stays.
        for (const [h, v] of [[true, false], [false, true], [true, true]]) {
            const k = keyOf(flipTile(indices, h, v));
            if (!this.byKey.has(k)) this.byKey.set(k, { tile, hflip: h, vflip: v });
        }
        return plain;
    }

    /**
     * A w x h indexed raster (w, h multiples of 8) as a row-major list of
     * cell entries, one per 8x8 cell: {tile, hflip, vflip}. Blank cells point
     * at the blank tile. Returns null when the bank runs out part way (the
     * tiles already stored stay; the caller decides what to drop).
     */
    addRaster(indices, w, h) {
        if (w % TILE_DIM || h % TILE_DIM) throw new Error(`a raster is cut into 8x8 tiles; got ${w}x${h}`);
        const cols = w / TILE_DIM, rows = h / TILE_DIM;
        const cells = [];
        const tile = new Uint8Array(TILE_DIM * TILE_DIM);
        for (let ty = 0; ty < rows; ty++) {
            for (let tx = 0; tx < cols; tx++) {
                for (let y = 0; y < TILE_DIM; y++) {
                    for (let x = 0; x < TILE_DIM; x++) tile[y * TILE_DIM + x] = indices[(ty * TILE_DIM + y) * w + tx * TILE_DIM + x] & 0x0f;
                }
                const entry = tileIsBlank(tile) && this.blank !== null ? { tile: this.blank, hflip: false, vflip: false } : this.addTile(tile);
                if (!entry) return null;
                cells.push(entry);
            }
        }
        return cells;
    }

    /** The bank as GRAPIC DATA bytes: `count` tiles (default the capacity), unused ones zero. */
    toBytes(count = this.capacity) {
        const out = new Uint8Array(count * TILE_BYTES_4BPP);
        this.tiles.slice(0, count).forEach((t, i) => encodeTile4bpp(t, out.subarray(i * TILE_BYTES_4BPP, (i + 1) * TILE_BYTES_4BPP)));
        return out;
    }
}

function keyOf(indices) {
    let s = "";
    for (let i = 0; i < indices.length; i++) s += String.fromCharCode(indices[i] & 0x0f);
    return s;
}
