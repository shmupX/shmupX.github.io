// SNES BG tilemap words, which is what every "GROUP" region holds.
//
// A word is little-endian: bits 0-9 tile number, 10-12 palette row, 13
// priority, 14 horizontal flip, 15 vertical flip. Dezaemon's group tables use
// them in quads of four — a 16x16 object out of four 8x8 tiles — and mark an
// unused slot as 0xFFFF or 0x03FF (tile 0x3FF, the last one, drawn blank).
//
// Two quad shapes recur in the sample and are named here so a probe can say
// which it sees: a "chip" [n, n+1, n+8, n+9] (a 2x2 block cut from a sheet
// eight tiles wide) and a "strip" [n, n+1, n+1|H, n|H] (a 32-pixel-wide row
// mirrored about its centre, the boss tables' habit).
// Environment-neutral ESM (Node + browser).

export const TILEMAP_TILE_MASK = 0x03ff;
export const TILEMAP_PALETTE_SHIFT = 10;
export const TILEMAP_PALETTE_MASK = 0x07;
export const TILEMAP_PRIORITY = 0x2000;
export const TILEMAP_HFLIP = 0x4000;
export const TILEMAP_VFLIP = 0x8000;
export const EMPTY_WORDS = Object.freeze([0xffff, 0x03ff]);

export function decodeTilemapWord(word) {
    return {
        word,
        tile: word & TILEMAP_TILE_MASK,
        palette: (word >> TILEMAP_PALETTE_SHIFT) & TILEMAP_PALETTE_MASK,
        priority: (word & TILEMAP_PRIORITY) !== 0,
        hflip: (word & TILEMAP_HFLIP) !== 0,
        vflip: (word & TILEMAP_VFLIP) !== 0,
        empty: EMPTY_WORDS.includes(word),
    };
}

/** `count` little-endian u16 at `offset`. */
export function readWords(bytes, offset, count) {
    if (offset + count * 2 > bytes.length) {
        throw new Error(`${count} words at 0x${offset.toString(16)} run past the end (${bytes.length})`);
    }
    const words = new Uint16Array(count);
    for (let i = 0; i < count; i++) words[i] = bytes[offset + i * 2] | (bytes[offset + i * 2 + 1] << 8);
    return words;
}

export function decodeTilemapWords(bytes, offset, count) {
    return Array.from(readWords(bytes, offset, count), decodeTilemapWord);
}

/**
 * "chip" | "strip" | "empty" | null for four raw words. Flags other than the
 * mirroring a strip needs must agree across the quad for either name to apply.
 */
export function classifyQuad(words) {
    if (words.length !== 4) return null;
    const e = Array.from(words, decodeTilemapWord);
    if (e.every((x) => x.empty)) return "empty";
    if (e.some((x) => x.empty)) return null;
    const sameAttrs = (a, b) => a.palette === b.palette && a.priority === b.priority && a.vflip === b.vflip;
    if (!e.every((x) => sameAttrs(x, e[0]))) return null;
    const noH = e.every((x) => !x.hflip);
    if (noH && e[1].tile === e[0].tile + 1 && e[2].tile === e[0].tile + 8 && e[3].tile === e[0].tile + 9) return "chip";
    if (
        !e[0].hflip && !e[1].hflip && e[2].hflip && e[3].hflip &&
        e[1].tile === e[0].tile + 1 && e[2].tile === e[1].tile && e[3].tile === e[0].tile
    ) return "strip";
    return null;
}
