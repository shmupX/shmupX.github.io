// Placing a save into a backup partition that ALREADY holds saves — the
// Saturn's own 32 KB internal memory in particular.
//
// bup-write.js builds fresh images: format a partition, write saves back to
// back from block 2. That is the right shape for a cart file that is nothing
// but our game. The browser Saturn core (yabause, via EmulatorJS) is a
// different situation: it has no backup cartridge at all, only the internal
// 32 KB, and that memory belongs to the player — DEZA2___SYS, whatever they
// saved from other games, their own earlier stagings. Exporting a level into
// it means doing what the BIOS's backup library does: find the directory
// entries that are there, free the one being replaced, and take the first
// hole big enough for the new save. Everything here reuses bup-parse.js for
// the walking, so a save this module places is by construction one the
// parser (and the console) reads back.
//
// BYTE LAYOUTS — every function says which it takes. Three appear:
//   logical      one byte per backup-RAM byte; bup-parse's shape. A bare 32 KB
//                partition (block 0 = magic) is what placeSaveInPartition and
//                stageSaveInInternalRam work on.
//   interleaved  0xFF in every even byte, data in the odd bytes: hardware
//                dumps, the 1,114,112-byte MiSTer .sav, and yabause's .srm
//                (FormatBackupRam writes 0xFF,'B',0xFF,'a',... — exactly
//                interleave() of a formatted partition). Twice the logical
//                length.
//   MiSTer/logical pair  32 KB internal partition followed by the 512 KB
//                cart partition, 557,056 bytes logical / 1,114,112 interleaved.
//
// Environment-neutral ESM (Node + browser); no async — gzip unwrapping is
// normalize()'s job, upstream.

import { detectPartitions, parse } from "./bup-parse.js";
import { deinterleave, detect } from "./bup-deinterleave.js";
import { isGameSave, TABLE_SIZE } from "./payload-table.js";
import { SECTION_SIZES } from "./decompress.js";
import {
    CART_PARTITION_SIZE,
    dataBlocksFor,
    encodeComment,
    FIRST_SAVE_BLOCK,
    formatPartition,
    GAME_SAVE_SLOTS,
    gameSaveFilename,
    interleave,
    INTERNAL_BLOCK_SIZE,
    INTERNAL_PARTITION_SIZE,
    MISTER_SAV_SIZE,
    STREAM_OFFSET,
    writeSaveEntry,
} from "./bup-write.js";

/** The 32 KB internal partition as yabause keeps it: interleaved, 65,536 bytes. */
export const INTERNAL_SRM_SIZE = INTERNAL_PARTITION_SIZE * 2;
/** The 32 KB + 512 KB pair before interleaving (what normalize() makes of a .sav). */
export const MISTER_LOGICAL_SIZE = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;

/**
 * Thrown when no run of free blocks is long enough for a save. Carries the
 * numbers a message needs; check `err.name` rather than instanceof — the
 * editor meets this class through the bundle, a separate module instance.
 *
 *   payloadBytes   the save that did not fit
 *   freeBytes      the largest payload that WOULD fit right now (the
 *                  longest contiguous free run, minus tags and block list)
 *   capacityBytes  the partition's size
 *   freeBlocks     unused blocks in total (they may be scattered)
 *   neededBlocks   header + data blocks the payload wants
 */
export class PartitionFullError extends Error {
    constructor({ payloadBytes, freeBytes, capacityBytes, freeBlocks, neededBlocks, blockSize }) {
        super(
            `a ${payloadBytes}-byte save needs ${neededBlocks} ${blockSize}-byte blocks; ` +
                `the ${capacityBytes}-byte partition has room for a ${freeBytes}-byte save at most`,
        );
        this.name = "PartitionFullError";
        this.payloadBytes = payloadBytes;
        this.freeBytes = freeBytes;
        this.capacityBytes = capacityBytes;
        this.freeBlocks = freeBlocks;
        this.neededBlocks = neededBlocks;
        this.blockSize = blockSize;
    }
}

/**
 * The biggest payload a run of `blocks` blocks (header + chained data) can
 * carry — the inverse of dataBlocksFor(): the header keeps blockSize-0x22
 * bytes of stream, each data block blockSize-4, and the stream spends two
 * bytes per data block plus a two-byte terminator on the block list.
 */
export function payloadCapacity(blocks, blockSize) {
    if (blocks < 1) return 0;
    return (blockSize - STREAM_OFFSET) - 2 + (blocks - 1) * (blockSize - 6);
}

/** The most payload an empty internal memory holds: 510 usable 64-byte blocks, 29,550 bytes. */
export const INTERNAL_RAM_PAYLOAD_CAPACITY = payloadCapacity(
    INTERNAL_PARTITION_SIZE / INTERNAL_BLOCK_SIZE - FIRST_SAVE_BLOCK,
    INTERNAL_BLOCK_SIZE,
);

/**
 * The smallest a Dezaemon 2 game payload can be: the 0x6C table plus the
 * eight sections (766,596 raw bytes, always all eight) at the LZSS floor —
 * every 18 raw bytes a 2-byte match, one flag byte per eight items
 * (compress.js's dialect, MAX_MATCH 18). 90,619 bytes: three times what the
 * internal memory holds even when empty. No game save fits the browser
 * core's memory, ever — game saves live on a cartridge (Mednafen, MiSTer).
 * Computed rather than quoted so a UI can say so with the real numbers.
 */
export const MIN_GAME_PAYLOAD_BYTES = SECTION_SIZES.reduce((sum, n) => {
    const items = Math.ceil(n / 18);
    return sum + items * 2 + Math.ceil(items / 8);
}, TABLE_SIZE);

// The single partition at the start of `partition`, checked against the
// caller's block size so that parse()'s block numbers and ours agree.
function partitionOf(partition, blockSize) {
    const parts = detectPartitions(partition);
    if (parts.length === 0 || parts[0].base !== 0) {
        throw new Error('partition is not formatted ("BackUpRam Format" magic missing from block 0)');
    }
    if (parts.length > 1) {
        throw new Error(`expected one partition, found ${parts.length}; pass a bare partition`);
    }
    if (parts[0].blockSize !== blockSize) {
        throw new Error(
            `${blockSize}-byte blocks do not match a ${partition.length}-byte partition (${parts[0].blockSize}-byte blocks)`,
        );
    }
    return parts[0];
}

/**
 * Write `save` ({filename, comment, language, date, payload}) into a
 * formatted LOGICAL partition (block 0 = magic) that may already hold saves,
 * leaving every other save where it is. Mutates `partition`.
 *
 * Entries are discovered with bup-parse; one whose filename equals
 * `replace` — or equals save.filename, so a name is never duplicated — is
 * erased first (header and chained blocks zeroed). Blocks 0 and 1 and every
 * block an entry owns count as used; the save takes the first run of
 * contiguous free blocks long enough, from block 2, exactly as writeSaveEntry
 * lays a save out. Throws PartitionFullError when no run is long enough.
 *
 * Returns {header, blocks, next, replaced}: the header block, the chained
 * data blocks, the block after the last one used, and the filename that was
 * erased (null when nothing was).
 */
export function placeSaveInPartition(partition, blockSize, save, { replace } = {}) {
    if (!(save?.payload instanceof Uint8Array)) throw new Error("save.payload must be a Uint8Array");
    partitionOf(partition, blockSize);
    const numBlocks = Math.floor(partition.length / blockSize);
    const entries = parse(partition);

    // Free the entry being replaced: the header block plus every block its
    // list names. A chain the parser could not follow (payloadError) only
    // yields its header, which is all that can safely be identified.
    let replaced = null;
    const doomed = new Set([save.filename, replace].filter((n) => typeof n === "string" && n));
    const kept = [];
    for (const entry of entries) {
        if (!doomed.has(entry.filename)) {
            kept.push(entry);
            continue;
        }
        const header = entry.offset / blockSize;
        for (const n of [header, ...entry.blocks]) {
            if (n < numBlocks) partition.fill(0, n * blockSize, (n + 1) * blockSize);
        }
        if (replaced === null || entry.filename === replace) replaced = entry.filename;
    }

    const used = new Uint8Array(numBlocks);
    used[0] = 1;
    used[1] = 1;
    for (const entry of kept) {
        used[entry.offset / blockSize] = 1;
        for (const n of entry.blocks) if (n < numBlocks) used[n] = 1;
    }

    const needed = 1 + dataBlocksFor(save.payload.length, blockSize);
    let start = -1;
    let run = 0;
    let longest = 0;
    let freeBlocks = 0;
    for (let n = FIRST_SAVE_BLOCK; n < numBlocks; n++) {
        if (used[n]) {
            run = 0;
            continue;
        }
        freeBlocks++;
        run++;
        if (run > longest) longest = run;
        if (run === needed && start === -1) start = n - needed + 1;
    }
    if (start === -1) {
        throw new PartitionFullError({
            payloadBytes: save.payload.length,
            freeBytes: payloadCapacity(longest, blockSize),
            capacityBytes: partition.length,
            freeBlocks,
            neededBlocks: needed,
            blockSize,
        });
    }
    // A hole left by an erased save is already zero; one the BIOS freed may
    // not be. Clear the run so the tail of the last block is deterministic.
    partition.fill(0, start * blockSize, (start + needed) * blockSize);
    const placed = writeSaveEntry(partition, blockSize, save, start);
    return { ...placed, replaced };
}

function bytesOf(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error("expected bytes (Uint8Array or ArrayBuffer)");
}

// A memory the console never formatted: nothing but 0x00 or nothing but 0xFF.
function isBlank(logical) {
    const first = logical[0];
    if (first !== 0x00 && first !== 0xff) return false;
    return logical.every((b) => b === first);
}

/**
 * The 32 KB LOGICAL internal partition out of whatever a caller has, always
 * a fresh copy:
 *   null / undefined            a newly formatted partition
 *   65,536 bytes, interleaved   yabause's .srm → deinterleaved
 *   32,768 bytes                a bare partition, as-is (.bkr)
 *   1,114,112 bytes             a MiSTer .sav → its first 32 KB, deinterleaved
 *   557,056 bytes               the same pair, logical → its first 32 KB
 * A 32 KB / 64 KB image that is entirely 0x00 or 0xFF is a memory that was
 * never formatted, so it is formatted here (there is nothing to preserve);
 * every other size throws.
 */
export function internalRamFromImage(bytes) {
    if (bytes == null) return formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
    const buf = bytesOf(bytes);
    let logical;
    if (buf.length === INTERNAL_SRM_SIZE) {
        if (detect(buf)) logical = deinterleave(buf);
        else if (isBlank(buf)) logical = buf.slice(0, INTERNAL_PARTITION_SIZE);
        else throw new Error("a 65,536-byte image should be 0xFF-interleaved (yabause .srm); this one is not");
    } else if (buf.length === INTERNAL_PARTITION_SIZE) {
        logical = buf.slice();
    } else if (buf.length === MISTER_SAV_SIZE) {
        if (!detect(buf)) throw new Error("a 1,114,112-byte .sav should be 0xFF-interleaved; this one is not");
        logical = deinterleave(buf.subarray(0, INTERNAL_SRM_SIZE));
    } else if (buf.length === MISTER_LOGICAL_SIZE) {
        logical = buf.slice(0, INTERNAL_PARTITION_SIZE);
    } else {
        throw new Error(
            `${buf.length} bytes is not a Saturn internal memory image ` +
                `(expected 32,768 logical, 65,536 interleaved, or a 557,056 / 1,114,112-byte .sav)`,
        );
    }
    if (isBlank(logical)) return formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
    return logical;
}

// What parse() will show for a comment we encode: the ASCII subset, anything
// else an underscore, cut to ten characters.
function commentKey(comment) {
    if (comment === undefined || comment === null) return null;
    let s = "";
    for (const b of encodeComment(comment)) {
        if (b === 0) break;
        s += String.fromCharCode(b);
    }
    return s;
}

/**
 * Stage one game save in the Saturn's internal memory. `existing` is anything
 * internalRamFromImage() accepts (null for an empty memory) and is not
 * modified. `payload` is the DEZA2 game payload (section table + sections);
 * `filename` wins over `slot`; with neither, the slot is chosen the way a
 * player re-saving would expect: an existing DEZA2____NN whose comment
 * matches `comment` is replaced, else the first of the five slots that is
 * absent. All five present and none matching throws — pass `slot`.
 *
 * Returns {image, interleaved, entry, filename, replaced}: the 32 KB LOGICAL
 * partition, the same 65,536-byte INTERLEAVED (yabause's .srm — drop it in as
 * the core's save file), the placement ({header, blocks, next}), the
 * directory name used, and the name erased to make room (null if none).
 * PartitionFullError propagates when the payload does not fit.
 */
export function stageSaveInInternalRam(existing, { payload, filename, comment, language, date, slot } = {}) {
    if (!(payload instanceof Uint8Array)) throw new Error("payload must be a Uint8Array");
    const image = internalRamFromImage(existing);
    let name = filename;
    if (!name && slot !== undefined && slot !== null) name = gameSaveFilename(slot);
    if (!name) {
        const games = parse(image).filter(isGameSave);
        const key = commentKey(comment);
        const same = key === null ? undefined : games.find((g) => g.comment === key);
        if (same) name = same.filename;
        else {
            const taken = new Set(games.map((g) => g.filename));
            for (let s = 1; s <= GAME_SAVE_SLOTS && !name; s++) {
                if (!taken.has(gameSaveFilename(s))) name = gameSaveFilename(s);
            }
        }
        if (!name) {
            throw new Error(
                `all ${GAME_SAVE_SLOTS} DEZA2____NN slots are in use and none carries the comment ` +
                    `${JSON.stringify(key ?? "")}; pass slot to replace one`,
            );
        }
    }
    const placed = placeSaveInPartition(
        image,
        INTERNAL_BLOCK_SIZE,
        { filename: name, comment, language, date, payload },
        { replace: name },
    );
    const { replaced, ...entry } = placed;
    return { image, interleaved: interleave(image), entry, filename: name, replaced };
}

/**
 * The first Dezaemon 2 game save (DEZA2____NN, per isGameSave) in a .sav:
 * `bytes` may be INTERLEAVED (a MiSTer .sav, a hardware dump, a .srm) or
 * LOGICAL; a gzip wrapper must already be gone (await normalize() first).
 * Pass `filename` to pick a slot other than the first. Returns {payload,
 * entry} — the payload bytes and the parsed directory record (comment,
 * language, date... the fields a re-staging should carry over).
 */
export function gamePayloadFromSav(bytes, { filename } = {}) {
    const buf = bytesOf(bytes);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        throw new Error("gzip-wrapped image: await normalize(bytes) and pass .data");
    }
    const data = detect(buf) ? deinterleave(buf) : buf;
    const games = parse(data).filter(isGameSave);
    const entry = filename ? games.find((g) => g.filename === filename) : games.find((g) => g.payload) ?? games[0];
    if (!entry) {
        throw new Error(
            filename ? `no ${filename} save in this image` : "no DEZA2____NN game save in this image",
        );
    }
    if (!entry.payload) throw new Error(`${entry.filename}: ${entry.payloadError}`);
    return { payload: entry.payload.buffer, entry };
}
