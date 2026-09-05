// Dezaemon 2 section COMPRESSOR — the encoder half of src/decompress.js.
//
// The game's "COMPRESS POINT" screen runs classic Okumura LZSS over each of
// the eight save sections, and decompress.js pins the exact dialect: a flag
// byte governs the next 8 items LSB first, bit 1 = literal, bit 0 = match;
// a match is two bytes `b1 b2` with offset = b1 | ((b2 & 0xF0) << 4) — an
// ABSOLUTE index into the 4096-byte ring — and length = (b2 & 0x0F) + 3;
// the ring starts zero-filled with the write cursor at 0xFEE; the stream
// ends when the compressed input runs out.
//
// This encoder mirrors the decoder's ring byte for byte, so anything it
// emits decodes to its input through decompress() — and, because the
// grammar is exactly the one recovered from real saves, through the Saturn.
// Matches are found with a hash chain over the ring's contents, including
// the zero prefill (which is how the game's own encoder expresses the long
// zero runs every section opens with), and may overlap the bytes they are
// still producing, the usual LZSS run-length trick.
//
// Ratio is close to the game's: Ramsie's sec5 (396,640 B) comes out within a
// few percent of the 56,643 B the Saturn wrote. That is not a requirement —
// a cart holds ~520 KB of payload and a whole game is ~170 KB — but it keeps
// exports the same size the community's files are.
//
// Environment-neutral ESM (Node + browser).

const RING_SIZE = 0x1000;
const RING_MASK = RING_SIZE - 1;
const RING_INIT = 0xfee;
const MIN_MATCH = 3;
const MAX_MATCH = 18;
const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 128;

function hash3(a, b, c) {
    return ((a * 0x1f1f + b * 0x3d + c) ^ (a << 7) ^ (c << 3)) & (HASH_SIZE - 1);
}

export function compress(input) {
    const n = input.length;
    // The decoder's ring, kept in lockstep. Virtual position p (bytes written
    // so far, negative for the zero prefill) lives at ring[(RING_INIT + p) &
    // MASK]; the ring holds exactly the virtual positions [cur-4096, cur).
    const ring = new Uint8Array(RING_SIZE);
    const head = new Int32Array(HASH_SIZE).fill(-0x7fffffff);
    const prev = new Int32Array(RING_SIZE).fill(-0x7fffffff);
    const ringIndex = (p) => (RING_INIT + p) & RING_MASK;
    const insert = (p, h) => {
        prev[p & RING_MASK] = head[h];
        head[h] = p;
    };
    // Seed the chain with a few spots inside the zero prefill so a leading
    // zero run can be coded as matches from the very first byte.
    const zeroHash = hash3(0, 0, 0);
    for (const p of [-4096, -3584, -3072, -2560, -2048, -1536, -1024, -512, -256, -64, -MAX_MATCH]) {
        insert(p, zeroHash);
    }

    const out = [];
    let flagPos = -1;
    let flagBits = 0;
    let flagCount = 0;
    const item = (literal) => {
        if (flagCount === 0) {
            flagPos = out.length;
            out.push(0);
            flagBits = 0;
        }
        if (literal) flagBits |= 1 << flagCount;
        flagCount++;
        out[flagPos] = flagBits;
        if (flagCount === 8) flagCount = 0;
    };

    // Byte the decoder would produce at step k of a match from virtual source
    // p while the cursor is at cur: history until the copy catches up with
    // itself, then the input it is writing.
    const sourceByte = (p, k, cur, i) => {
        const d = cur - p;
        return k < d ? ring[ringIndex(p + k)] : input[i + k - d];
    };

    let i = 0;
    let cur = 0;
    while (i < n) {
        let bestLen = 0;
        let bestPos = 0;
        if (i + MIN_MATCH <= n) {
            const h = hash3(input[i], input[i + 1], input[i + 2]);
            const limit = Math.min(MAX_MATCH, n - i);
            const oldest = cur - RING_SIZE;
            let p = head[h];
            let steps = 0;
            while (p >= oldest && steps < MAX_CHAIN) {
                let k = 0;
                while (k < limit && sourceByte(p, k, cur, i) === input[i + k]) k++;
                if (k > bestLen) {
                    bestLen = k;
                    bestPos = p;
                    if (k === limit) break;
                }
                p = prev[p & RING_MASK];
                steps++;
            }
        }
        if (bestLen >= MIN_MATCH) {
            const off = ringIndex(bestPos);
            item(false);
            out.push(off & 0xff, ((off >> 8) & 0x0f) << 4 | (bestLen - MIN_MATCH));
            for (let k = 0; k < bestLen; k++) {
                const b = input[i + k];
                ring[ringIndex(cur)] = b;
                if (i + k + MIN_MATCH <= n) insert(cur, hash3(b, input[i + k + 1], input[i + k + 2]));
                cur++;
            }
            i += bestLen;
        } else {
            const b = input[i];
            item(true);
            out.push(b);
            ring[ringIndex(cur)] = b;
            if (i + MIN_MATCH <= n) insert(cur, hash3(b, input[i + 1], input[i + 2]));
            cur++;
            i++;
        }
    }
    return Uint8Array.from(out);
}

// A disc-style .CMP container around a stream: u32 LITTLE-endian stream
// length, then the stream (the inverse of decompress.js `decompressCmp`).
export function compressCmp(raw) {
    const stream = compress(raw);
    const out = new Uint8Array(4 + stream.length);
    out[0] = stream.length & 0xff;
    out[1] = (stream.length >> 8) & 0xff;
    out[2] = (stream.length >> 16) & 0xff;
    out[3] = (stream.length >>> 24) & 0xff;
    out.set(stream, 4);
    return out;
}
