// Dezaemon 2 section decompressor — classic Okumura LZSS, identified by
// brute-force over the variant space (dev/scan-compression.js) and locked by
// the fact that all 16 fixture sections decode to exact, game-invariant
// region sizes (see test/decompress.test.js):
//
//   - flag byte governs the next 8 items, LSB first
//   - flag bit 1 → literal (1 byte)
//   - flag bit 0 → match (2 bytes): offset = b1 | ((b2 & 0xF0) << 4)
//     (absolute index into the ring), length = (b2 & 0x0F) + 3
//   - ring buffer: 4096 bytes, zero-filled, write position starts at 0xFEE
//     (encoders reference the zero prefill to encode leading zero-runs)
//   - stream ends when the compressed input is exhausted
//
// Environment-neutral ESM (Node + browser).

const RING_SIZE = 0x1000;
const RING_MASK = RING_SIZE - 1;
const RING_INIT = 0xfee;

export function decompress(input) {
    const out = [];
    const ring = new Uint8Array(RING_SIZE);
    let rpos = RING_INIT;
    let i = 0;
    let flags = 0;
    let flagCount = 0;
    while (i < input.length) {
        if (flagCount === 0) {
            flags = input[i++];
            flagCount = 8;
            if (i >= input.length) break;
        }
        const literal = flags & 1;
        flags >>= 1;
        flagCount--;
        if (literal) {
            if (i >= input.length) break;
            const b = input[i++];
            out.push(b);
            ring[rpos] = b;
            rpos = (rpos + 1) & RING_MASK;
        } else {
            if (i + 1 >= input.length) break;
            const b1 = input[i++];
            const b2 = input[i++];
            const off = b1 | ((b2 & 0xf0) << 4);
            const len = (b2 & 0x0f) + 3;
            for (let k = 0; k < len; k++) {
                const b = ring[(off + k) & RING_MASK];
                out.push(b);
                ring[rpos] = b;
                rpos = (rpos + 1) & RING_MASK;
            }
        }
        if (out.length > 8_000_000) {
            throw new Error("LZSS runaway: output exceeded 8MB");
        }
    }
    return Uint8Array.from(out);
}

// Known decompressed sizes of the 8 payload sections — identical for every
// game seen so far because each section is a fixed-size memory region.
export const SECTION_SIZES = [65536, 65536, 65536, 65536, 512, 396640, 101472, 5828];

// What each section holds (see FORMAT.md "Section semantics" — established
// by 17-game corpus analysis + the disc image's SGM/M_DATA/MDLDT files).
export const SECTION_HINTS = [
    "CG art page 1 (128x512 8bpp, 16x16 cells, pixel=(pal<<4)|color)",
    "CG art page 2",
    "CG art page 3",
    "CG art page 4",
    "palettes: 16x16 u16be RGB555 (12 preset + 4 user)",
    "game assembly: backgrounds/placement/enemies/sprites/settings",
    "BGM: 24 song slots x 4228B (4 parts x 32 measures x 32 steps)",
    "3D models: magic + 16 slots x 328B part lists (poly-kichi editor)",
];
