// CG page PACKER — indexed frames into the four 128x512 art pages a save
// carries (sec0-3), handing back the cell refs its sprite banks and tilemaps
// store.
//
// A page is 256 cells of 16x16 palette-index bytes, 256 bytes each, cell t at
// t*256 with byte y*16+x inside (decode-cg.js); the four pages form one
// 1024-cell space a composition word addresses in its low 10 bits, with
// bit14 = H-flip and bit15 = V-flip and 0xFFFF for an empty cell
// (decode-sprites.js / decode-stage.js — the SAME convention in the sprite
// banks and the background map).
//
// Cells are shared: a cell whose bytes already exist — or exist mirrored —
// is referenced (with the flip bits) rather than stored again, and a blank
// cell costs nothing. That is how a full game fits: Ramsie's 444 sprites
// share heavily, and so do a level's animation frames.
//
// Environment-neutral ESM (Node + browser).

import { EMPTY_REF } from "../decode/decode-sprites.js";
import { CG_CELL, CG_CELL_BYTES, indexedToCells } from "../palette/deza2-palette.js";

export const CG_PAGE_COUNT = 4;
export const CG_PAGE_BYTES = 65536;
export const CG_CELL_CAPACITY = CG_PAGE_COUNT * (CG_PAGE_BYTES / CG_CELL_BYTES); // 1024
export const REF_HFLIP = 0x4000;
export const REF_VFLIP = 0x8000;

export class CgFullError extends Error {
    constructor(need) {
        super(`the four CG pages hold ${CG_CELL_CAPACITY} cells and every one is taken (needed ${need} more)`);
        this.name = "CgFullError";
    }
}

function flipH(cell) {
    const out = new Uint8Array(CG_CELL_BYTES);
    for (let y = 0; y < CG_CELL; y++) {
        for (let x = 0; x < CG_CELL; x++) out[y * CG_CELL + x] = cell[y * CG_CELL + (CG_CELL - 1 - x)];
    }
    return out;
}

function flipV(cell) {
    const out = new Uint8Array(CG_CELL_BYTES);
    for (let y = 0; y < CG_CELL; y++) {
        out.set(cell.subarray((CG_CELL - 1 - y) * CG_CELL, (CG_CELL - y) * CG_CELL), y * CG_CELL);
    }
    return out;
}

function keyOf(cell) {
    // Cells are tiny; a string key is the simplest exact hash.
    let s = "";
    for (let i = 0; i < CG_CELL_BYTES; i++) s += String.fromCharCode(cell[i]);
    return s;
}

export class CgPacker {
    constructor({ capacity = CG_CELL_CAPACITY, reuseFlips = true } = {}) {
        this.capacity = Math.min(capacity, CG_CELL_CAPACITY);
        this.reuseFlips = reuseFlips;
        this.pages = Array.from({ length: CG_PAGE_COUNT }, () => new Uint8Array(CG_PAGE_BYTES));
        this.used = 0;
        this.byKey = new Map(); // cell bytes -> {index, flags}
        this.shared = 0;
    }

    get free() {
        return this.capacity - this.used;
    }

    /** Store (or find) one 256-byte cell; returns its composition ref. */
    addCell(cell) {
        let blank = true;
        for (let i = 0; i < CG_CELL_BYTES; i++) if (cell[i]) { blank = false; break; }
        if (blank) return EMPTY_REF;
        const key = keyOf(cell);
        const hit = this.byKey.get(key);
        if (hit) {
            this.shared++;
            return hit.index | hit.flags;
        }
        if (this.used >= this.capacity) throw new CgFullError(1);
        const index = this.used++;
        this.pages[index >> 8].set(cell, (index & 0xff) * CG_CELL_BYTES);
        this.byKey.set(key, { index, flags: 0 });
        if (this.reuseFlips) {
            const h = flipH(cell), v = flipV(cell), hv = flipV(h);
            for (const [bytes, flags] of [[h, REF_HFLIP], [v, REF_VFLIP], [hv, REF_HFLIP | REF_VFLIP]]) {
                const k = keyOf(bytes);
                if (!this.byKey.has(k)) this.byKey.set(k, { index, flags });
            }
        }
        return index;
    }

    /**
     * Store an indexed frame whose w and h are multiples of 16. Returns its
     * refs in reading order (cellsW * cellsH words). Throws CgFullError —
     * with nothing partially stored — when the frame does not fit.
     */
    addFrame(indexed, w, h) {
        const cells = indexedToCells(indexed, w, h);
        const count = cells.length / CG_CELL_BYTES;
        // Count the cells that would be new before touching the pages.
        let need = 0;
        const seen = new Set();
        for (let c = 0; c < count; c++) {
            const cell = cells.subarray(c * CG_CELL_BYTES, (c + 1) * CG_CELL_BYTES);
            let blank = true;
            for (let i = 0; i < CG_CELL_BYTES; i++) if (cell[i]) { blank = false; break; }
            if (blank) continue;
            const k = keyOf(cell);
            if (this.byKey.has(k) || seen.has(k)) continue;
            seen.add(k);
            need++;
        }
        if (need > this.free) throw new CgFullError(need - this.free);
        const refs = new Uint16Array(count);
        for (let c = 0; c < count; c++) {
            refs[c] = this.addCell(cells.subarray(c * CG_CELL_BYTES, (c + 1) * CG_CELL_BYTES));
        }
        return refs;
    }
}
