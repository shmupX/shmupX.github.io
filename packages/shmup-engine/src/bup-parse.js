// Saturn BUP (backup RAM) filesystem parser.
//
// Confirmed layout (validated against two real Dezaemon 2 saves — Ramsie &
// Mucha Kucha Fighter — plus Mednafen baseline images; every claim below is
// locked by the checksum gate in test/payload-table.test.js):
//
// A BUP image contains one or more PARTITIONS, each starting with a run of
// the ASCII magic "BackUpRam Format". Hardware-style 4Mbit cart dumps carry a
// 32KB internal-RAM mirror partition at 0x0 followed by the 512KB cart
// partition at 0x8000; Mednafen .bcr images are the bare 512KB partition;
// internal-RAM .bkr images are the bare 32KB partition.
//
// Block size: 512 bytes for 512KB partitions, 64 bytes for 32KB ones.
// Block N lives at partition base + N*blockSize. Every allocated block begins
// with a 4-byte tag: 0x80000000 for a save's first (header/directory) block,
// 0x00000000 for continuation blocks.
//
// Directory entry == content of a save's header block:
//
//   +0x00  u32 BE   flag = 0x80000000  (this is also the block tag)
//   +0x04  char[12] filename, null-padded   e.g. "DEZA2____01\0"
//   +0x10  char[10] comment,  null-padded, Shift-JIS
//   +0x1A  u8       language (0 = Japanese, ...)
//   +0x1B  u24 BE   date (minutes since 1980-01-01 00:00) — 3 bytes
//   +0x1E  u32 BE   datasize (payload bytes)
//   +0x22  ...      save data stream (see below)
//
// The save's DATA STREAM begins at +0x22 of the header block, fills the rest
// of that block, then continues through the chained data blocks — skipping
// each block's 4-byte tag. The stream contains, in order:
//   1. the block list: u16 BE block numbers, one per chained data block,
//      terminated by 0x0000 (the list itself flows across block boundaries);
//   2. the payload: exactly `datasize` bytes.
// (Ramsie: 331 chained blocks, payload begins at 0x86BE; Mucha: 304 blocks,
// payload at 0x8688. Ramsie datasize 167511 dated 2007; Mucha datasize 154015
// dated 1997.)

export const MAGIC = new TextEncoder().encode("BackUpRam Format");
export const ENTRY_FLAG = 0x80000000;

function dataView(data) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function findBytes(hay, needle, from = 0) {
    const n = needle.length;
    outer: for (let i = from; i + n <= hay.length; i++) {
        if (hay[i] !== needle[0]) continue;
        for (let j = 1; j < n; j++) {
            if (hay[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

// Offsets where a run of MAGIC copies begins (magic present, none 16 bytes
// earlier). Each run marks the start of a partition.
function magicRunStarts(data) {
    const starts = [];
    let idx = findBytes(data, MAGIC, 0);
    let prev = -32;
    while (idx !== -1) {
        if (idx !== prev + 16) starts.push(idx);
        prev = idx;
        idx = findBytes(data, MAGIC, idx + 16);
    }
    return starts;
}

// Partition map of a normalized BUP image.
export function detectPartitions(data) {
    return magicRunStarts(data).map((base, i, starts) => {
        const end = i + 1 < starts.length ? starts[i + 1] : data.length;
        const size = end - base;
        return { base, size, blockSize: size >= 0x80000 ? 512 : 64 };
    });
}

function readAscii(data, off, max) {
    let end = off;
    const limit = Math.min(off + max, data.length);
    while (end < limit && data[end] !== 0x00) end++;
    let s = "";
    for (let i = off; i < end; i++) s += String.fromCharCode(data[i]);
    return s;
}

// Comments are Shift-JIS ("DEZA2___SYS" carries デザ2_ｼｽﾃﾑ). TextDecoder
// supports shift-jis in browsers and full-ICU Node builds; fall back to a
// byte-per-char string elsewhere.
function decodeComment(data, off, max) {
    let end = off;
    const limit = Math.min(off + max, data.length);
    while (end < limit && data[end] !== 0x00) end++;
    const bytes = data.subarray(off, end);
    try {
        return new TextDecoder("shift-jis").decode(bytes);
    } catch {
        return readAscii(data, off, max);
    }
}

// Fixed directory fields of the header block at `off`.
export function parseEntry(data, off) {
    const dv = dataView(data);
    if (dv.getUint32(off) !== ENTRY_FLAG) {
        throw new Error(`no BUP entry flag at 0x${off.toString(16)}`);
    }
    return {
        offset: off,
        filename: readAscii(data, off + 0x04, 12),
        comment: decodeComment(data, off + 0x10, 10),
        language: data[off + 0x1a],
        date: (data[off + 0x1b] << 16) | (data[off + 0x1c] << 8) | data[off + 0x1d],
        datasize: dv.getUint32(off + 0x1e),
    };
}

// Convert the BUP date (minutes since 1980-01-01) to a JS Date.
export function bupDateToDate(minutes) {
    const epoch1980 = Date.UTC(1980, 0, 1, 0, 0, 0);
    return new Date(epoch1980 + minutes * 60_000);
}

// Byte cursor over a save's data stream: rest of the header block, then each
// chained block minus its 4-byte tag. `chain` may grow while streaming (the
// block list describes blocks the stream hasn't reached yet).
function makeStream(data, base, blockSize, entryOff, chain) {
    let seg = -1; // -1 = header block segment
    let pos = entryOff + 0x22;
    let segEnd = entryOff + blockSize;
    return {
        readByte() {
            while (pos >= segEnd) {
                seg++;
                if (seg >= chain.length) {
                    throw new Error("save data stream exhausted before datasize bytes were read");
                }
                const n = chain[seg];
                pos = base + n * blockSize + 4;
                segEnd = base + (n + 1) * blockSize;
                if (segEnd > data.length) {
                    throw new Error(`block ${n} lies outside the image`);
                }
            }
            return data[pos++];
        },
        tell() {
            return pos;
        },
    };
}

// Block-accurate payload reassembly: walks the save's data stream, parsing
// the 0x0000-terminated block list, then reading exactly `datasize` payload
// bytes (following the chain, so fragmented saves reassemble correctly).
export function extractPayload(data, partition, entry) {
    const { base, blockSize } = partition;
    const chain = [];
    const stream = makeStream(data, base, blockSize, entry.offset, chain);
    for (;;) {
        const hi = stream.readByte();
        const lo = stream.readByte();
        const v = (hi << 8) | lo;
        if (v === 0) break;
        chain.push(v);
    }
    const start = stream.tell();
    const buffer = new Uint8Array(entry.datasize);
    for (let w = 0; w < entry.datasize; w++) buffer[w] = stream.readByte();
    return { start, blocks: chain, buffer };
}

// Header-block offsets of every save entry in the image.
export function findEntries(data) {
    const dv = dataView(data);
    const offs = [];
    for (const part of detectPartitions(data)) {
        const numBlocks = Math.floor(part.size / part.blockSize);
        for (let n = 1; n < numBlocks; n++) {
            const off = part.base + n * part.blockSize;
            if (off + 0x22 > data.length) break;
            if (dv.getUint32(off) !== ENTRY_FLAG) continue;
            const name = readAscii(data, off + 4, 12);
            if (name.length >= 1 && /^[\x20-\x7e]+$/.test(name)) offs.push(off);
        }
    }
    return offs;
}

// Top-level: parse a normalized BUP image into save records.
export function parse(data) {
    const partitions = detectPartitions(data);
    if (partitions.length === 0) {
        throw new Error('not a Saturn backup image ("BackUpRam Format" magic not found)');
    }
    const dv = dataView(data);
    const saves = [];
    for (const part of partitions) {
        const numBlocks = Math.floor(part.size / part.blockSize);
        for (let n = 1; n < numBlocks; n++) {
            const off = part.base + n * part.blockSize;
            if (off + 0x22 > data.length) break;
            if (dv.getUint32(off) !== ENTRY_FLAG) continue;
            const name = readAscii(data, off + 4, 12);
            if (name.length < 1 || !/^[\x20-\x7e]+$/.test(name)) continue;
            const entry = parseEntry(data, off);
            let payload = null;
            let payloadError = null;
            let blocks = [];
            try {
                const extracted = extractPayload(data, part, entry);
                blocks = extracted.blocks;
                payload = { start: extracted.start, buffer: extracted.buffer };
            } catch (err) {
                payloadError = err.message;
            }
            saves.push({
                ...entry,
                blocks,
                partition: { base: part.base, blockSize: part.blockSize },
                payload,
                payloadError,
            });
        }
    }
    return saves;
}
