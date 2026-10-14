// XZ decoding in pure JS: the .xz container, its LZMA2 filter and the LZMA
// range decoder under it, so an xdelta3 patch's secondary-compressed sections
// can be read in Deno and in a browser.
//
// WHY it exists. xdelta3's secondary compressor id 2 is liblzma, driven as
// lzma_stream_encoder(LZMA2, LZMA_CHECK_NONE) — an .xz stream — and the
// English translation patch for Dezaemon 3D (static/n64dd/*.xdelta) uses it
// for every section of every window. The web platform has no XZ or LZMA
// (DecompressionStream knows gzip, deflate and deflate-raw only), so the
// decoder has to be here, and vcdiff.js is its only caller in this repo.
//
// Three facts about how xdelta3 drives liblzma shape the API; all three are
// read from xdelta3's source (github.com/jmacd/xdelta: xdelta3-lzma.h,
// xdelta3-second.h) and confirmed on the patch itself with Python's lzma
// (an independent walker kept outside the repo; see the test):
//
//   - ONE lzma_stream per section TYPE (data, inst, addr) for the whole
//     patch, allocated on first use and never reset, so window 1's sections
//     continue window 0's streams: same block, same LZMA2 state, same
//     dictionary, and only the first window's section begins with the stream
//     and block headers (window 1's open with a bare chunk control byte,
//     0x80/0x81: "no state reset"). Hence XzDecoder, a decoder that is fed
//     in parts and keeps its state between calls.
//   - every section is ended with LZMA_SYNC_FLUSH and nothing is ever
//     LZMA_FINISHed: no LZMA2 end marker, no check, no index, no stream
//     footer. The decoder therefore accepts input that stops at a chunk
//     boundary — `finished` says whether a footer was seen — and
//     {complete: true} is how a caller refuses an unfinished stream.
//   - LZMA_CHECK_NONE on the encoder, LZMA_TELL_NO_CHECK on the decoder: the
//     check type is a stream property. This reader verifies CRC32 and CRC64
//     (cheap, and what xz itself writes by default) and skips over SHA-256.
//
// Layouts: the container as "The .xz File Format" (tukaani.org,
// xz-file-format.txt: stream header and footer, block header, index,
// multibyte integers, check ids); LZMA2 chunk framing and the LZMA decoder
// as the LZMA SDK's reference decoder (LzmaSpec.cpp, Igor Pavlov, public
// domain; Lzma2Dec.c for the chunk state rules) and xz's lzma2_decoder.c /
// lzma_decoder.c, which agree. Confidence: confirmed — the six sections of
// the patch decode byte for byte to what liblzma gives for the same bytes,
// and streams made by liblzma with each check type round-trip in the tests.
//
// Environment-neutral ESM (Node + browser).

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const XZ_FOOTER_MAGIC = [0x59, 0x5a];
const FILTER_LZMA2 = 0x21;

/** Filter ids the .xz format defines, for the refusal message. */
const FILTER_NAMES = {
    0x03: "Delta",
    0x04: "BCJ x86",
    0x05: "BCJ PowerPC",
    0x06: "BCJ IA-64",
    0x07: "BCJ ARM",
    0x08: "BCJ ARM-Thumb",
    0x09: "BCJ SPARC",
    0x0a: "BCJ ARM64",
    0x0b: "BCJ RISC-V",
    0x21: "LZMA2",
};

/** Check id -> {name, size}: 0 none, 1 CRC32, 4 CRC64, 10 SHA-256; the rest reserved. */
export const XZ_CHECKS = Object.freeze([
    { name: "none", size: 0 },
    { name: "CRC32", size: 4 },
    { name: "reserved", size: 4 },
    { name: "reserved", size: 4 },
    { name: "CRC64", size: 8 },
    { name: "reserved", size: 8 },
    { name: "reserved", size: 8 },
    { name: "reserved", size: 16 },
    { name: "reserved", size: 16 },
    { name: "reserved", size: 16 },
    { name: "SHA-256", size: 32 },
    { name: "reserved", size: 32 },
    { name: "reserved", size: 32 },
    { name: "reserved", size: 64 },
    { name: "reserved", size: 64 },
    { name: "reserved", size: 64 },
].map(Object.freeze));

// ---------------------------------------------------------------- checksums

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC32_TABLE[i] = c >>> 0;
}

/**
 * CRC-32 (IEEE, reflected) of a byte range, as .xz and zlib use it.
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number} unsigned
 */
export function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// CRC-64 (ECMA-182 polynomial, reflected, as .xz uses it) in two 32-bit
// halves, because a BigInt per byte is a hundred times slower.
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let lo = i, hi = 0;
    for (let k = 0; k < 8; k++) {
        const bit = lo & 1;
        lo = ((lo >>> 1) | (hi << 31)) >>> 0;
        hi = hi >>> 1;
        if (bit) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
    }
    CRC64_LO[i] = lo;
    CRC64_HI[i] = hi;
}

/**
 * CRC-64 of a byte range as the two halves .xz stores (little-endian: lo then hi).
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{lo: number, hi: number}} unsigned halves
 */
export function crc64(bytes, start = 0, end = bytes.length) {
    let lo = 0xffffffff, hi = 0xffffffff;
    for (let i = start; i < end; i++) {
        const idx = (lo ^ bytes[i]) & 0xff;
        lo = (((lo >>> 8) | (hi << 24)) ^ CRC64_LO[idx]) >>> 0;
        hi = ((hi >>> 8) ^ CRC64_HI[idx]) >>> 0;
    }
    return { lo: (lo ^ 0xffffffff) >>> 0, hi: (hi ^ 0xffffffff) >>> 0 };
}

function readU32LE(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * An .xz multibyte integer: 7 bits a byte, least significant first, bit 7
 * continues, at most 9 bytes. Returns null when the input ends inside it.
 */
function readVli(bytes, at, end) {
    let value = 0, scale = 1;
    for (let i = 0; i < 9; i++) {
        if (at + i >= end) return null;
        const b = bytes[at + i];
        value += (b & 0x7f) * scale;
        if ((b & 0x80) === 0) {
            if (i > 0 && b === 0) throw new Error("XZ: multibyte integer with a redundant trailing byte");
            return { value, next: at + i + 1 };
        }
        scale *= 128;
    }
    throw new Error("XZ: multibyte integer longer than 9 bytes");
}

// ------------------------------------------------------------ LZMA decoder
//
// Probabilities live in one Uint16Array laid out like LzmaDec.c, offsets
// below. kNumPosBitsMax is 4, so the per-position tables hold 16 slots a
// state whatever pb is.

const PROB_INIT = 1024;
const IS_MATCH = 0; // 12 states x 16 pos states
const IS_REP = IS_MATCH + 192; // 12
const IS_REP_G0 = IS_REP + 12;
const IS_REP_G1 = IS_REP_G0 + 12;
const IS_REP_G2 = IS_REP_G1 + 12;
const IS_REP0_LONG = IS_REP_G2 + 12; // 12 x 16
const POS_SLOT = IS_REP0_LONG + 192; // 4 len states x 64
const SPEC_POS = POS_SLOT + 256; // 1 + 128 - 14
const ALIGN = SPEC_POS + 115; // 16
const LEN_CODER = ALIGN + 16; // 514
const REP_LEN_CODER = LEN_CODER + 514;
const LITERAL = REP_LEN_CODER + 514; // 0x300 << (lc + lp)
// Inside a length coder: choice, choice2, low[16][8], mid[16][8], high[256].
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = 2 + 128;
const LEN_HIGH = 2 + 256;
const END_POS_MODEL_INDEX = 14;
const MATCH_MIN_LEN = 2;

/**
 * The LZMA decoder proper, one per XzDecoder: owns the output (which is also
 * the dictionary), the probabilities and the state LZMA2 chunks carry across
 * each other.
 */
class LzmaState {
    constructor() {
        this.out = new Uint8Array(1 << 16);
        this.outLength = 0;
        this.dictStart = 0; // output position of the last dictionary reset
        this.dictSize = 0;
        this.lc = 0;
        this.lp = 0;
        this.pb = 0;
        this.probs = null;
        this.state = 0;
        this.rep0 = 0;
        this.rep1 = 0;
        this.rep2 = 0;
        this.rep3 = 0;
        // Range decoder registers and its bounded input.
        this.range = 0;
        this.code = 0;
        this.input = null;
        this.inPos = 0;
        this.inEnd = 0;
    }

    reserve(extra) {
        const need = this.outLength + extra;
        if (need <= this.out.length) return;
        let size = this.out.length * 2;
        while (size < need) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.out.subarray(0, this.outLength));
        this.out = grown;
    }

    setProps(byte) {
        if (byte >= 9 * 5 * 5) throw new Error(`LZMA2: properties byte 0x${byte.toString(16)} is out of range`);
        const lc = byte % 9;
        const rest = (byte - lc) / 9;
        const lp = rest % 5;
        const pb = (rest - lp) / 5;
        if (lc + lp > 4) throw new Error(`LZMA2: lc + lp = ${lc + lp}, more than the 4 LZMA2 allows`);
        this.lc = lc;
        this.lp = lp;
        this.pb = pb;
        this.probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
    }

    resetState() {
        this.probs.fill(PROB_INIT);
        this.state = 0;
        this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    }

    resetDict() {
        this.dictStart = this.outLength;
    }

    appendPlain(bytes, start, end) {
        this.reserve(end - start);
        this.out.set(bytes.subarray(start, end), this.outLength);
        this.outLength += end - start;
    }

    // --- range decoder

    rcInit(input, at, end) {
        if (end - at < 5) throw new Error("LZMA: chunk shorter than the range coder's 5 initial bytes");
        if (input[at] !== 0) throw new Error("LZMA: the range coder's first byte is not zero");
        this.code = ((input[at + 1] << 24) | (input[at + 2] << 16) | (input[at + 3] << 8) | input[at + 4]) >>> 0;
        this.range = 0xffffffff;
        if (this.code === this.range) throw new Error("LZMA: corrupted range coder state");
        this.input = input;
        this.inPos = at + 5;
        this.inEnd = end;
    }

    rcByte() {
        if (this.inPos >= this.inEnd) throw new Error("LZMA: chunk's compressed data ends early");
        return this.input[this.inPos++];
    }

    bit(i) {
        const probs = this.probs;
        const prob = probs[i];
        const bound = (this.range >>> 11) * prob;
        let bit;
        if (this.code < bound) {
            probs[i] = prob + ((2048 - prob) >> 5);
            this.range = bound;
            bit = 0;
        } else {
            probs[i] = prob - (prob >> 5);
            this.code -= bound;
            this.range -= bound;
            bit = 1;
        }
        if (this.range < 0x1000000) {
            this.range = (this.range << 8) >>> 0;
            this.code = ((this.code << 8) | this.rcByte()) >>> 0;
        }
        return bit;
    }

    directBits(count) {
        let result = 0;
        for (let i = 0; i < count; i++) {
            this.range = this.range >>> 1;
            this.code -= this.range;
            let bit = 1;
            if (this.code < 0) {
                this.code += this.range;
                bit = 0;
            }
            if (this.code === this.range) throw new Error("LZMA: corrupted range coder state");
            if (this.range < 0x1000000) {
                this.range = (this.range << 8) >>> 0;
                this.code = ((this.code << 8) | this.rcByte()) >>> 0;
            }
            result = result * 2 + bit;
        }
        return result;
    }

    bitTree(base, numBits) {
        let m = 1;
        for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(base + m);
        return m - (1 << numBits);
    }

    bitTreeReverse(base, numBits) {
        let m = 1, symbol = 0;
        for (let i = 0; i < numBits; i++) {
            const b = this.bit(base + m);
            m = (m << 1) + b;
            symbol |= b << i;
        }
        return symbol;
    }

    decodeLen(base, posState) {
        if (this.bit(base + LEN_CHOICE) === 0) return this.bitTree(base + LEN_LOW + posState * 8, 3);
        if (this.bit(base + LEN_CHOICE2) === 0) return 8 + this.bitTree(base + LEN_MID + posState * 8, 3);
        return 16 + this.bitTree(base + LEN_HIGH, 8);
    }

    decodeDistance(len) {
        const lenState = len < 3 ? len : 3;
        const posSlot = this.bitTree(POS_SLOT + lenState * 64, 6);
        if (posSlot < 4) return posSlot;
        const numDirectBits = (posSlot >> 1) - 1;
        let dist = (2 | (posSlot & 1)) * Math.pow(2, numDirectBits);
        if (posSlot < END_POS_MODEL_INDEX) {
            dist += this.bitTreeReverse(SPEC_POS + dist - posSlot, numDirectBits);
        } else {
            dist += this.directBits(numDirectBits - 4) * 16;
            dist += this.bitTreeReverse(ALIGN, 4);
        }
        return dist;
    }

    /**
     * Decode one LZMA2 compressed chunk: exactly `unpacked` bytes out of
     * exactly `packed` bytes in, with no end marker, continuing the state.
     */
    decodeChunk(input, at, packed, unpacked) {
        this.rcInit(input, at, at + packed);
        this.reserve(unpacked);
        const out = this.out;
        const end = this.outLength + unpacked;
        const dictStart = this.dictStart;
        const dictSize = this.dictSize;
        const lc = this.lc;
        const lpMask = (1 << this.lp) - 1;
        const pbMask = (1 << this.pb) - 1;
        let outPos = this.outLength;
        let state = this.state;
        let rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;

        while (outPos < end) {
            const pos = outPos - dictStart;
            const posState = pos & pbMask;
            if (this.bit(IS_MATCH + (state << 4) + posState) === 0) {
                const prevByte = pos > 0 ? out[outPos - 1] : 0;
                const litBase = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prevByte >> (8 - lc)));
                let symbol = 1;
                if (state >= 7) {
                    let matchByte = out[outPos - rep0 - 1];
                    do {
                        const matchBit = (matchByte >> 7) & 1;
                        matchByte <<= 1;
                        const b = this.bit(litBase + ((1 + matchBit) << 8) + symbol);
                        symbol = (symbol << 1) | b;
                        if (matchBit !== b) break;
                    } while (symbol < 0x100);
                }
                while (symbol < 0x100) symbol = (symbol << 1) | this.bit(litBase + symbol);
                out[outPos++] = symbol & 0xff;
                state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
                continue;
            }

            let len;
            if (this.bit(IS_REP + state) !== 0) {
                if (pos === 0) throw new Error("LZMA: repeat match before any dictionary");
                if (this.bit(IS_REP_G0 + state) === 0) {
                    if (this.bit(IS_REP0_LONG + (state << 4) + posState) === 0) {
                        // A one-byte match at rep0.
                        if (rep0 >= pos) throw new Error("LZMA: match distance past the dictionary");
                        state = state < 7 ? 9 : 11;
                        out[outPos] = out[outPos - rep0 - 1];
                        outPos++;
                        continue;
                    }
                } else {
                    let dist;
                    if (this.bit(IS_REP_G1 + state) === 0) {
                        dist = rep1;
                    } else {
                        if (this.bit(IS_REP_G2 + state) === 0) {
                            dist = rep2;
                        } else {
                            dist = rep3;
                            rep3 = rep2;
                        }
                        rep2 = rep1;
                    }
                    rep1 = rep0;
                    rep0 = dist;
                }
                len = this.decodeLen(REP_LEN_CODER, posState);
                state = state < 7 ? 8 : 11;
            } else {
                rep3 = rep2;
                rep2 = rep1;
                rep1 = rep0;
                len = this.decodeLen(LEN_CODER, posState);
                state = state < 7 ? 7 : 10;
                rep0 = this.decodeDistance(len);
                if (rep0 === 0xffffffff) throw new Error("LZMA: end marker inside an LZMA2 chunk");
                if (rep0 >= dictSize) throw new Error("LZMA: match distance larger than the dictionary");
            }
            if (rep0 >= pos) throw new Error("LZMA: match distance past the dictionary");
            len += MATCH_MIN_LEN;
            if (outPos + len > end) throw new Error("LZMA: match runs past the end of its chunk");
            let src = outPos - rep0 - 1;
            for (let i = 0; i < len; i++) out[outPos++] = out[src++];
        }

        if (this.inPos !== this.inEnd) throw new Error(`LZMA: chunk left ${this.inEnd - this.inPos} compressed bytes unread`);
        if (this.code !== 0) throw new Error("LZMA: range coder did not finish cleanly");
        this.outLength = outPos;
        this.state = state;
        this.rep0 = rep0;
        this.rep1 = rep1;
        this.rep2 = rep2;
        this.rep3 = rep3;
    }
}

// ------------------------------------------------------------- XZ container

/**
 * @typedef {object} XzBlock
 * @property {number} headerSize       bytes, 4..1024
 * @property {number} compressedSize   LZMA2 payload bytes seen so far (final once the block ends)
 * @property {number} uncompressedSize bytes produced by this block so far
 * @property {number|null} declaredCompressedSize   from the header, if present
 * @property {number|null} declaredUncompressedSize from the header, if present
 * @property {number} dictSize
 */

/**
 * A resumable .xz decoder. Feed it a stream in as many pieces as you like
 * with decode(); each call returns the bytes it produced and keeps whatever
 * partial unit was at the end of the piece for the next call. A stream that
 * simply stops at an LZMA2 chunk boundary — as every stream in an xdelta3
 * patch does — leaves `finished` false and nothing pending.
 */
export class XzDecoder {
    /**
     * @param {{verify?: boolean}} [options]  verify: check header CRCs and
     *   CRC32/CRC64 block checks (default true)
     */
    constructor({ verify = true } = {}) {
        this.verify = verify;
        this.phase = "stream-header";
        this.pending = null;
        this.checkType = 0;
        this.streamFlags = null;
        /** @type {XzBlock[]} */
        this.blocks = [];
        this.block = null;
        this.blockOutStart = 0;
        this.indexStart = 0;
        this.indexSize = 0;
        this.needDictReset = true;
        this.needProps = true;
        this.needState = true;
        this.finished = false;
        this.lzma = new LzmaState();
    }

    /** Everything decoded so far, as a view. */
    get output() {
        return this.lzma.out.subarray(0, this.lzma.outLength);
    }

    /** Bytes of a partial unit waiting for more input. */
    get pendingLength() {
        return this.pending ? this.pending.length : 0;
    }

    /**
     * Feed the next piece of the stream.
     * @param {Uint8Array} bytes
     * @returns {Uint8Array} the bytes this piece produced (a view into the decoder's buffer)
     */
    decode(bytes) {
        let input = bytes;
        if (this.pending) {
            input = new Uint8Array(this.pending.length + bytes.length);
            input.set(this.pending);
            input.set(bytes, this.pending.length);
            this.pending = null;
        }
        const from = this.lzma.outLength;
        let at = 0;
        const end = input.length;
        while (at < end) {
            const next = this.step(input, at, end);
            if (next === null) {
                this.pending = input.slice(at);
                break;
            }
            at = next;
        }
        return this.lzma.out.subarray(from, this.lzma.outLength);
    }

    /**
     * Declare the input over. Throws if a unit was cut short, or, with
     * complete, if the stream never reached its footer.
     * @param {{complete?: boolean}} [options]
     */
    end({ complete = false } = {}) {
        if (this.pending) {
            throw new Error(`XZ: input ends ${this.pendingLength} bytes into an unfinished ${this.phase.replace("-", " ")} unit`);
        }
        if (complete && !this.finished) {
            throw new Error(`XZ: stream has no footer (stopped in its ${this.phase.replace("-", " ")})`);
        }
    }

    /** One unit at `at`; the position after it, or null when it is incomplete. */
    step(input, at, end) {
        switch (this.phase) {
            case "stream-header":
                return this.streamHeader(input, at, end);
            case "block-or-index":
                return input[at] === 0 ? this.index(input, at, end) : this.blockHeader(input, at, end);
            case "chunks":
                return this.chunk(input, at, end);
            case "block-check":
                return this.blockCheck(input, at, end);
            case "footer":
                return this.footer(input, at, end);
            case "done":
                return this.afterStream(input, at, end);
            default:
                throw new Error(`XZ: unknown phase ${this.phase}`);
        }
    }

    streamHeader(input, at, end) {
        if (end - at < 12) return null;
        for (let i = 0; i < 6; i++) {
            if (input[at + i] !== XZ_MAGIC[i]) throw new Error("XZ: not an .xz stream (bad magic)");
        }
        const flags0 = input[at + 6], flags1 = input[at + 7];
        if (flags0 !== 0 || (flags1 & 0xf0) !== 0) throw new Error("XZ: reserved stream flag bits are set");
        if (this.verify && crc32(input, at + 6, at + 8) !== readU32LE(input, at + 8)) {
            throw new Error("XZ: stream header CRC32 mismatch");
        }
        this.checkType = flags1 & 0x0f;
        this.streamFlags = [flags0, flags1];
        this.phase = "block-or-index";
        return at + 12;
    }

    blockHeader(input, at, end) {
        const size = (input[at] + 1) * 4;
        if (end - at < size) return null;
        const flags = input[at + 1];
        if ((flags & 0x3c) !== 0) throw new Error("XZ: reserved block flag bits are set");
        const filterCount = (flags & 3) + 1;
        let p = at + 2;
        const limit = at + size - 4;
        let declaredCompressed = null, declaredUncompressed = null;
        if (flags & 0x40) {
            const v = readVli(input, p, limit);
            if (!v) throw new Error("XZ: block header ends inside its compressed size");
            declaredCompressed = v.value;
            p = v.next;
        }
        if (flags & 0x80) {
            const v = readVli(input, p, limit);
            if (!v) throw new Error("XZ: block header ends inside its uncompressed size");
            declaredUncompressed = v.value;
            p = v.next;
        }
        let dictSize = 0;
        for (let f = 0; f < filterCount; f++) {
            const id = readVli(input, p, limit);
            if (!id) throw new Error("XZ: block header ends inside a filter id");
            const propsSize = readVli(input, id.next, limit);
            if (!propsSize) throw new Error("XZ: block header ends inside a filter's property size");
            p = propsSize.next + propsSize.value;
            if (p > limit) throw new Error("XZ: filter properties run past the block header");
            if (id.value !== FILTER_LZMA2 || filterCount !== 1) {
                const name = FILTER_NAMES[id.value] || "unknown";
                throw new Error(`XZ: filter 0x${id.value.toString(16)} (${name}) is not supported; only a lone LZMA2 filter is, which is all xdelta3 and xz write by default`);
            }
            if (propsSize.value !== 1) throw new Error("XZ: LZMA2 properties are not one byte");
            const bits = input[propsSize.next] & 0x3f;
            if (bits > 40) throw new Error("XZ: LZMA2 dictionary size code out of range");
            dictSize = bits === 40 ? 0xffffffff : (2 | (bits & 1)) * Math.pow(2, Math.floor(bits / 2) + 11);
        }
        for (; p < limit; p++) {
            if (input[p] !== 0) throw new Error("XZ: block header padding is not zero");
        }
        if (this.verify && crc32(input, at, limit) !== readU32LE(input, limit)) {
            throw new Error("XZ: block header CRC32 mismatch");
        }
        this.block = {
            headerSize: size,
            compressedSize: 0,
            uncompressedSize: 0,
            declaredCompressedSize: declaredCompressed,
            declaredUncompressedSize: declaredUncompressed,
            dictSize,
        };
        this.blocks.push(this.block);
        this.blockOutStart = this.lzma.outLength;
        this.lzma.dictSize = dictSize;
        this.needDictReset = true;
        this.needProps = true;
        this.needState = true;
        this.phase = "chunks";
        return at + size;
    }

    chunk(input, at, end) {
        const control = input[at];
        const lzma = this.lzma;
        if (control === 0) {
            this.block.compressedSize += 1;
            this.phase = "block-check";
            return at + 1;
        }
        if (control === 1 || control === 2) {
            if (end - at < 3) return null;
            const size = ((input[at + 1] << 8) | input[at + 2]) + 1;
            if (end - at < 3 + size) return null;
            if (control === 1) {
                lzma.resetDict();
                this.needDictReset = false;
                this.needProps = true;
                this.needState = true;
            } else if (this.needDictReset) {
                throw new Error("LZMA2: first chunk does not reset the dictionary");
            }
            lzma.appendPlain(input, at + 3, at + 3 + size);
            this.block.compressedSize += 3 + size;
            this.block.uncompressedSize += size;
            return at + 3 + size;
        }
        if (control < 0x80) throw new Error(`LZMA2: invalid chunk control byte 0x${control.toString(16)}`);
        const mode = (control >> 5) & 3;
        const headerSize = mode >= 2 ? 6 : 5;
        if (end - at < headerSize) return null;
        const unpacked = ((control & 0x1f) << 16) + ((input[at + 1] << 8) | input[at + 2]) + 1;
        const packed = ((input[at + 3] << 8) | input[at + 4]) + 1;
        if (end - at < headerSize + packed) return null;
        if (mode === 3) {
            lzma.resetDict();
            this.needDictReset = false;
        } else if (this.needDictReset) {
            throw new Error("LZMA2: first chunk does not reset the dictionary");
        }
        if (mode >= 2) {
            lzma.setProps(input[at + 5]);
            this.needProps = false;
        } else if (this.needProps) {
            throw new Error("LZMA2: chunk needs properties none was given");
        }
        if (mode >= 1) {
            lzma.resetState();
            this.needState = false;
        } else if (this.needState) {
            throw new Error("LZMA2: chunk continues a state that was never set");
        }
        lzma.decodeChunk(input, at + headerSize, packed, unpacked);
        this.block.compressedSize += headerSize + packed;
        this.block.uncompressedSize += unpacked;
        return at + headerSize + packed;
    }

    blockCheck(input, at, end) {
        const block = this.block;
        const padding = (4 - (block.compressedSize % 4)) % 4;
        const checkSize = XZ_CHECKS[this.checkType].size;
        if (end - at < padding + checkSize) return null;
        for (let i = 0; i < padding; i++) {
            if (input[at + i] !== 0) throw new Error("XZ: block padding is not zero");
        }
        if (block.declaredCompressedSize !== null && block.declaredCompressedSize !== block.compressedSize) {
            throw new Error(`XZ: block holds ${block.compressedSize} compressed bytes, header said ${block.declaredCompressedSize}`);
        }
        if (block.declaredUncompressedSize !== null && block.declaredUncompressedSize !== block.uncompressedSize) {
            throw new Error(`XZ: block decoded to ${block.uncompressedSize} bytes, header said ${block.declaredUncompressedSize}`);
        }
        if (this.verify) {
            const out = this.lzma.out, from = this.blockOutStart, to = this.lzma.outLength;
            const checkAt = at + padding;
            if (this.checkType === 1) {
                if (crc32(out, from, to) !== readU32LE(input, checkAt)) throw new Error("XZ: block CRC32 mismatch");
            } else if (this.checkType === 4) {
                const got = crc64(out, from, to);
                if (got.lo !== readU32LE(input, checkAt) || got.hi !== readU32LE(input, checkAt + 4)) {
                    throw new Error("XZ: block CRC64 mismatch");
                }
            }
            // SHA-256 and the reserved ids are skipped over, not verified.
        }
        this.block = null;
        this.phase = "block-or-index";
        return at + padding + checkSize;
    }

    index(input, at, end) {
        const count = readVli(input, at + 1, end);
        if (!count) return null;
        let p = count.next;
        const records = [];
        for (let i = 0; i < count.value; i++) {
            const unpadded = readVli(input, p, end);
            if (!unpadded) return null;
            const uncompressed = readVli(input, unpadded.next, end);
            if (!uncompressed) return null;
            records.push({ unpaddedSize: unpadded.value, uncompressedSize: uncompressed.value });
            p = uncompressed.next;
        }
        const padding = (4 - ((p - at) % 4)) % 4;
        if (end < p + padding + 4) return null;
        for (let i = 0; i < padding; i++) {
            if (input[p + i] !== 0) throw new Error("XZ: index padding is not zero");
        }
        if (this.verify && crc32(input, at, p + padding) !== readU32LE(input, p + padding)) {
            throw new Error("XZ: index CRC32 mismatch");
        }
        if (records.length !== this.blocks.length) {
            throw new Error(`XZ: index lists ${records.length} blocks, the stream had ${this.blocks.length}`);
        }
        const checkSize = XZ_CHECKS[this.checkType].size;
        records.forEach((record, i) => {
            const block = this.blocks[i];
            const unpadded = block.headerSize + block.compressedSize + checkSize;
            if (record.unpaddedSize !== unpadded || record.uncompressedSize !== block.uncompressedSize) {
                throw new Error(`XZ: index record ${i} disagrees with block ${i} (${record.unpaddedSize}/${record.uncompressedSize} vs ${unpadded}/${block.uncompressedSize})`);
            }
        });
        this.indexStart = at;
        this.indexSize = p + padding + 4 - at;
        this.phase = "footer";
        return p + padding + 4;
    }

    footer(input, at, end) {
        if (end - at < 12) return null;
        if (this.verify && crc32(input, at + 4, at + 10) !== readU32LE(input, at)) {
            throw new Error("XZ: stream footer CRC32 mismatch");
        }
        const backward = (readU32LE(input, at + 4) + 1) * 4;
        if (backward !== this.indexSize) {
            throw new Error(`XZ: footer's backward size ${backward} is not the index's ${this.indexSize}`);
        }
        if (input[at + 8] !== this.streamFlags[0] || input[at + 9] !== this.streamFlags[1]) {
            throw new Error("XZ: footer's stream flags differ from the header's");
        }
        if (input[at + 10] !== XZ_FOOTER_MAGIC[0] || input[at + 11] !== XZ_FOOTER_MAGIC[1]) {
            throw new Error("XZ: bad stream footer magic");
        }
        this.finished = true;
        this.phase = "done";
        return at + 12;
    }

    /** After a footer: zero padding in fours, or another stream. */
    afterStream(input, at, end) {
        if (input[at] === XZ_MAGIC[0]) {
            this.phase = "stream-header";
            this.finished = false;
            this.blocks = [];
            return at;
        }
        if (end - at < 4) return null;
        for (let i = 0; i < 4; i++) {
            if (input[at + i] !== 0) throw new Error("XZ: bytes after the stream footer are neither padding nor a stream");
        }
        return at + 4;
    }
}

/**
 * Decode a whole .xz stream in one call.
 *
 * @param {Uint8Array} bytes
 * @param {{verify?: boolean, complete?: boolean}} [options]
 *   verify (default true): header CRCs and CRC32/CRC64 block checks.
 *   complete (default false): refuse a stream that stops before its footer.
 *   The default accepts one that stops at an LZMA2 chunk boundary, which is
 *   every stream inside an xdelta3 patch.
 * @returns {Uint8Array}
 */
export function decodeXz(bytes, { verify = true, complete = false } = {}) {
    const decoder = new XzDecoder({ verify });
    decoder.decode(bytes);
    decoder.end({ complete });
    return decoder.output.slice();
}
