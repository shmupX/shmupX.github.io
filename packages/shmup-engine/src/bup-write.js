// Saturn BUP (backup RAM) image WRITER — the inverse of bup-parse.js and
// bup-source.js, producing the cart images the community collection is made
// of.
//
// Everything here mirrors what the parser confirmed against real dumps
// (FORMAT.md "Partitions and blocks", "Directory entry", "Data stream"):
//
//   - a partition opens with block 0 filled with copies of the ASCII magic
//     "BackUpRam Format" (32 copies for a 512-byte block, 4 for a 64-byte one)
//   - block 1 is never used by the Saturn's backup library — every fixture
//     (Ramsie, Mucha Kucha, the Mednafen internal-RAM baseline) puts its first
//     save's header block at block 2 — and unused blocks are zero
//   - a save = header block (tag 0x80000000, name, comment, language, u24
//     date in minutes since 1980, u32 datasize) whose data stream starts at
//     +0x22 and runs on through chained blocks (tag 0x00000000, 4 bytes) —
//     first the u16be block list terminated by 0x0000, then the payload
//   - the MiSTer / hardware-style .sav (1,114,112 bytes, what
//     `Dez 2 - *.sav` files are) is the 32 KB internal-RAM partition followed
//     by the 512 KB cart partition, every byte widened to a 16-bit word with
//     0xFF in the high (even) byte — bup-deinterleave.js in reverse
//
// The payload itself — the 0x6C section table over eight LZSS-compressed
// sections — is built here too (`buildPayload`), validated by the same
// parseSectionTable() that reads real saves.
//
// Environment-neutral ESM (Node + browser).

import { MAGIC } from "./bup-parse.js";
import { byteSum, parseSectionTable, SECTION_COUNT, TABLE_SIZE } from "./payload-table.js";
import { compress } from "./compress.js";
import { SECTION_SIZES } from "./decompress.js";

export const CART_PARTITION_SIZE = 0x80000; // 512 KB, 512-byte blocks
export const INTERNAL_PARTITION_SIZE = 0x8000; // 32 KB, 64-byte blocks
export const CART_BLOCK_SIZE = 512;
export const INTERNAL_BLOCK_SIZE = 64;
/** Header-block offset of the data stream (after the fixed directory fields). */
export const STREAM_OFFSET = 0x22;
/** The first block a save may occupy: block 0 is the magic, block 1 unused. */
export const FIRST_SAVE_BLOCK = 2;
/** The community .sav: (32 KB + 512 KB) x 2 for the 0xFF interleave. */
export const MISTER_SAV_SIZE = (INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE) * 2;
/** Where every real save stages its compressed image (payload-table.js). */
export const DEFAULT_TABLE_ADDR = 0x002c8a84;
/** Dezaemon 2's five game slots are DEZA2____01..05. */
export const GAME_SAVE_SLOTS = 5;

export const BUP_LANGUAGE = Object.freeze({
    japanese: 0,
    english: 1,
    french: 2,
    german: 3,
    spanish: 4,
    italian: 5,
});

// --- payload -----------------------------------------------------------------

/**
 * Compress eight raw sections into a game payload: the 0x6C table (total
 * checksum, staging address, end address, then (checksum, addr, size) per
 * section) followed by the compressed sections back to back.
 *
 * `sections` are the DECOMPRESSED regions in table order sec0..sec7 (the
 * sizes SECTION_SIZES); pass `precompressed: true` to hand in streams that
 * are already LZSS. The result validates under parseSectionTable().
 */
export function buildPayload(sections, { tableAddr = DEFAULT_TABLE_ADDR, precompressed = false } = {}) {
    if (!Array.isArray(sections) || sections.length !== SECTION_COUNT) {
        throw new Error(`a payload needs exactly ${SECTION_COUNT} sections, got ${sections ? sections.length : 0}`);
    }
    if (!precompressed) {
        sections.forEach((s, i) => {
            if (s.length !== SECTION_SIZES[i]) {
                throw new Error(`sec${i} is ${s.length} bytes, expected ${SECTION_SIZES[i]}`);
            }
        });
    }
    const streams = precompressed ? sections.map((s) => Uint8Array.from(s)) : sections.map((s) => compress(s));
    const total = streams.reduce((a, s) => a + s.length, TABLE_SIZE);
    const payload = new Uint8Array(total);
    const dv = new DataView(payload.buffer);
    let addr = tableAddr + TABLE_SIZE;
    let offset = TABLE_SIZE;
    let checksumTotal = 0;
    streams.forEach((s, i) => {
        payload.set(s, offset);
        const checksum = byteSum(s, 0, s.length);
        dv.setUint32(0x0c + i * 12, checksum);
        dv.setUint32(0x0c + i * 12 + 4, addr);
        dv.setUint32(0x0c + i * 12 + 8, s.length);
        checksumTotal = (checksumTotal + checksum) >>> 0;
        addr += s.length;
        offset += s.length;
    });
    dv.setUint32(0, checksumTotal);
    dv.setUint32(4, tableAddr);
    dv.setUint32(8, addr);
    // Read it back through the reader every real save goes through.
    parseSectionTable(payload);
    return payload;
}

// --- directory fields ----------------------------------------------------------

/** A JS Date (or ms) -> the BUP date, minutes since 1980-01-01 00:00 UTC (u24). */
export function bupDateFromDate(date = new Date()) {
    const ms = date instanceof Date ? date.getTime() : Number(date);
    const minutes = Math.floor((ms - Date.UTC(1980, 0, 1)) / 60_000);
    return Math.max(0, Math.min(0xffffff, minutes));
}

/** `DEZA2____01`..`05` — the game's own slot names. */
export function gameSaveFilename(slot = 1) {
    if (!Number.isInteger(slot) || slot < 1 || slot > GAME_SAVE_SLOTS) {
        throw new Error(`Dezaemon 2 has ${GAME_SAVE_SLOTS} game slots (1-${GAME_SAVE_SLOTS}), got ${slot}`);
    }
    return `DEZA2____${String(slot).padStart(2, "0")}`;
}

// Comments are Shift-JIS on the Saturn. There is no Shift-JIS ENCODER in the
// web platform, so this writes the ASCII subset — every byte a real cart
// comment shares with US-ASCII — and stands in an underscore for anything
// else. A Uint8Array passes through untouched for callers with real
// Shift-JIS bytes.
export function encodeComment(comment, max = 10) {
    const out = new Uint8Array(max);
    if (comment instanceof Uint8Array) {
        out.set(comment.subarray(0, max));
        return out;
    }
    const s = String(comment ?? "");
    let n = 0;
    for (const ch of s) {
        if (n >= max) break;
        const code = ch.codePointAt(0);
        out[n++] = code >= 0x20 && code < 0x7f ? code : 0x5f;
    }
    return out;
}

function encodeFilename(name) {
    const out = new Uint8Array(12);
    const s = String(name ?? "");
    if (!/^[\x21-\x7e]{1,11}$/.test(s)) {
        throw new Error(`BUP filename must be 1-11 printable ASCII characters, got ${JSON.stringify(s)}`);
    }
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

// --- partitions ------------------------------------------------------------------

/** A freshly formatted partition: the magic in block 0, everything else zero. */
export function formatPartition(size, blockSize) {
    const part = new Uint8Array(size);
    for (let off = 0; off + MAGIC.length <= blockSize; off += MAGIC.length) part.set(MAGIC, off);
    return part;
}

/** How many chained data blocks a payload needs after its header block. */
export function dataBlocksFor(datasize, blockSize) {
    const headerRoom = blockSize - STREAM_OFFSET;
    const blockRoom = blockSize - 4;
    let n = 0;
    // stream = block list (2 bytes per data block + terminator) + payload
    while (headerRoom + n * blockRoom < 2 * (n + 1) + datasize) n++;
    return n;
}

/**
 * Write one save into a formatted partition. `save` is {filename, comment,
 * language, date, payload}; blocks are taken contiguously from `firstBlock`.
 * Returns the header block number and the block after the last one used.
 */
export function writeSaveEntry(partition, blockSize, save, firstBlock = FIRST_SAVE_BLOCK) {
    const payload = save.payload;
    const numBlocks = Math.floor(partition.length / blockSize);
    const dataBlocks = dataBlocksFor(payload.length, blockSize);
    const header = firstBlock;
    const chain = [];
    for (let k = 0; k < dataBlocks; k++) chain.push(header + 1 + k);
    const last = header + dataBlocks;
    if (last >= numBlocks) {
        throw new Error(
            `save needs ${dataBlocks + 1} blocks from block ${header}, partition has ${numBlocks}`,
        );
    }
    const dv = new DataView(partition.buffer, partition.byteOffset, partition.byteLength);
    const h = header * blockSize;
    dv.setUint32(h, 0x80000000);
    partition.set(encodeFilename(save.filename), h + 0x04);
    partition.set(encodeComment(save.comment), h + 0x10);
    partition[h + 0x1a] = (save.language ?? BUP_LANGUAGE.english) & 0xff;
    const date = save.date === undefined ? bupDateFromDate() : save.date;
    partition[h + 0x1b] = (date >> 16) & 0xff;
    partition[h + 0x1c] = (date >> 8) & 0xff;
    partition[h + 0x1d] = date & 0xff;
    dv.setUint32(h + 0x1e, payload.length);

    // The stream cursor: rest of the header block, then each chained block
    // past its 4-byte continuation tag.
    let seg = -1;
    let pos = h + STREAM_OFFSET;
    let segEnd = h + blockSize;
    const put = (b) => {
        while (pos >= segEnd) {
            seg++;
            const n = chain[seg];
            if (n === undefined) throw new Error("block chain exhausted while writing the data stream");
            const start = n * blockSize;
            dv.setUint32(start, 0);
            pos = start + 4;
            segEnd = start + blockSize;
        }
        partition[pos++] = b;
    };
    for (const n of chain) {
        put((n >> 8) & 0xff);
        put(n & 0xff);
    }
    put(0);
    put(0);
    for (let i = 0; i < payload.length; i++) put(payload[i]);
    return { header, blocks: chain, next: last + 1 };
}

/** The 0xFF-interleaved form hardware dumps and MiSTer use: odd bytes carry data. */
export function interleave(logical) {
    const out = new Uint8Array(logical.length * 2);
    for (let i = 0, j = 0; i < logical.length; i++, j += 2) {
        out[j] = 0xff;
        out[j + 1] = logical[i];
    }
    return out;
}

/**
 * Build a backup-RAM image holding `saves` (each {filename, comment,
 * language, date, payload}).
 *
 *   layout "mister"   32 KB internal partition + 512 KB cart partition,
 *                     0xFF-interleaved — the 1,114,112-byte .sav the
 *                     community collection and MiSTer's Saturn core use
 *   layout "cart"     the bare 512 KB cart partition (a raw Mednafen .bcr —
 *                     Mednafen itself gzips the file; wrap it if you need to)
 *   layout "internal" the bare 32 KB partition (.bkr); only small saves fit
 *
 * Saves go into the largest partition, first save at block 2, contiguously.
 */
export function buildBupImage(saves, { layout = "mister" } = {}) {
    if (!Array.isArray(saves) || !saves.length) throw new Error("buildBupImage needs at least one save");
    const partSize = layout === "internal" ? INTERNAL_PARTITION_SIZE : CART_PARTITION_SIZE;
    const blockSize = layout === "internal" ? INTERNAL_BLOCK_SIZE : CART_BLOCK_SIZE;
    const part = formatPartition(partSize, blockSize);
    let next = FIRST_SAVE_BLOCK;
    const entries = [];
    for (const save of saves) {
        const placed = writeSaveEntry(part, blockSize, save, next);
        entries.push({ filename: save.filename, ...placed });
        next = placed.next;
    }
    if (layout === "cart" || layout === "internal") return { image: part, entries, layout };
    if (layout !== "mister") throw new Error(`unknown layout ${JSON.stringify(layout)}`);
    const logical = new Uint8Array(INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE);
    logical.set(formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE), 0);
    logical.set(part, INTERNAL_PARTITION_SIZE);
    // The cart partition's block numbers are partition-relative, so nothing
    // in `entries` moves when it is placed after the internal mirror.
    return { image: interleave(logical), logical, entries, layout };
}

/**
 * One Dezaemon 2 game as a MiSTer-style cart image: compress the eight raw
 * sections, wrap the payload in a DEZA2____NN entry, format the cart.
 * Returns {sav, payload, entry, logical}.
 */
export function buildGameSave(sections, {
    slot = 1,
    comment = "shmupX",
    language = BUP_LANGUAGE.english,
    date,
    layout = "mister",
    tableAddr = DEFAULT_TABLE_ADDR,
} = {}) {
    const payload = buildPayload(sections, { tableAddr });
    const filename = gameSaveFilename(slot);
    const built = buildBupImage([{ filename, comment, language, date, payload }], { layout });
    return { sav: built.image, logical: built.logical || built.image, payload, entry: built.entries[0], filename };
}
