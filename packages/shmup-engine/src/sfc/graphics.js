// GRAPIC DATA: the upper 64 KB, 2,048 4bpp tiles by size.
//
// Which tile number in a group word maps to which 32 bytes here is open —
// 64 KB is more than VRAM shows at once, so the game must bank it — and the
// only fixture so far has the region zeroed. This decodes the bytes as a flat
// sheet and says when there is nothing to decode, which is all a probe needs
// to tell a complete dump from a half one. Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { isBlank } from "./sram.js";
import { decodeTileSheet, TILE_BYTES_4BPP, tileIsBlank } from "./tiles.js";

export const GRAPHICS_TILE_COUNT = REGION.graphics.length / TILE_BYTES_4BPP; // 2048

/**
 * {offset, present, blank, tiles, usedCount}: `present` is false for a 64 KB
 * dump; `tiles` is empty whenever the region is absent or all zero.
 */
export function decodeGraphics(bytes) {
    const { offset, end } = REGION.graphics;
    const present = bytes.length >= end;
    if (!present) return { offset, present, blank: true, tiles: [], usedCount: 0 };
    const view = bytes.subarray(offset, end);
    if (isBlank(view)) return { offset, present, blank: true, tiles: [], usedCount: 0 };
    const tiles = decodeTileSheet(bytes, offset, GRAPHICS_TILE_COUNT);
    let usedCount = 0;
    for (const tile of tiles) if (!tileIsBlank(tile)) usedCount++;
    return { offset, present, blank: false, tiles, usedCount };
}
