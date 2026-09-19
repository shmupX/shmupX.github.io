// ATNFS: Athena's own directory on a Dezaemon 3D 64DD data disk.
//
// Not Nintendo's MFS — the disk ID's free area reads "ATNFS0" — so leotools
// mfsextract and mfs_manager do not read it. It is also not a table of
// records: it is a STRUCTURE OF ARRAYS, five parallel arrays of 834 slots
// each, laid end to end. That is why a reader that looks for a name followed
// by a size finds names and nothing else.
//
// Base 0x18CAD0A, and each array's length is exactly 834 entries, which is
// what the three equal 0x684 strides between the three u16 arrays establish:
//
//   names        834 x char[11]   NAME(8, space-padded) + EXT(3), no separator
//   startLba     834 x u16 big-endian
//   blockCount   834 x u16 big-endian
//   reserved     834 x u16 big-endian   all zero across all 60 used slots
//   storedSize   834 x u32 big-endian   the compressed length, and the field
//                                       that makes extraction possible at all
//
// 60 slots are used: two projects of 30 files, SAMPLEZ1 and SAMP, whose stored
// bytes are byte-identical to each other file for file. Allocation is
// contiguous — startLba[i] + blockCount[i] === startLba[i+1] for all 59 pairs,
// LBA 9 through 369.
//
// The whole directory is replicated byte-identically at +34,680 and +48,960
// (0x18D3482 and 0x18DF3C2). Those two distances are exact sums of 64DD block
// sizes — 85x192 + 85x216, and 3 x 85x192 — which is how the block geometry
// first announced itself.
//
// Environment-neutral ESM (Node + browser).

import { blockSize, extentBytes, lbaToOffset } from "./geometry.js";

/** Where the read-only directory's first array starts. */
export const DIRECTORY_OFFSET = 0x018cad0a;

/** Entries in each parallel array. Measured from the strides between them. */
export const DIRECTORY_SLOTS = 834;

/** Byte offsets of the five arrays, derived so the strides stay visible. */
const NAMES = DIRECTORY_OFFSET;
const START_LBA = NAMES + DIRECTORY_SLOTS * 11;
const BLOCK_COUNT = START_LBA + DIRECTORY_SLOTS * 2;
const RESERVED = BLOCK_COUNT + DIRECTORY_SLOTS * 2;
const STORED_SIZE = RESERVED + DIRECTORY_SLOTS * 2;

/** One past the last byte of the directory. */
export const DIRECTORY_END = STORED_SIZE + DIRECTORY_SLOTS * 4;

/** The two byte distances at which the directory repeats, verbatim. */
export const DIRECTORY_COPIES = Object.freeze([0, 34680, 48960]);

/** The six files every project carries, then three per stage. */
export const GLOBAL_EXTS = Object.freeze(["GAM", "CGR", "CMD", "CBL", "ULB", "MUS"]);

/** Stage suffixes present on this disk. Stage 7 is absent from the numbering. */
export const STAGES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8]);

/** Uncompressed sizes the published format documentation predicts, by ext. */
export const DOCUMENTED_SIZES = Object.freeze({
    GAM: 0x559,
    CGR: 0x28000,
    CMD: 0xf2a8,
    CBL: 0x9b4,
    ULB: 0xe100,
    MUS: 0x42e70,
    BL: 0x8b37,
    GR: 0x104000,
    MD: 0x62944,
});

function u16(bytes, at) {
    return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * The extension as the size table keys it: a stage file's leading digit is
 * the stage, so "0GR" and "8GR" are both GR.
 * @param {string} ext
 * @returns {string}
 */
export function sizeKey(ext) {
    return /^[0-9]/.test(ext) ? ext.slice(1) : ext;
}

/**
 * @typedef {object} DddEntry
 * @property {number} slot          index into the parallel arrays
 * @property {string} name          the project name, trailing spaces trimmed
 * @property {string} ext           three characters, e.g. "CGR" or "0GR"
 * @property {number|null} stage    the stage a per-stage file belongs to
 * @property {number} startLba
 * @property {number} blockCount
 * @property {number} storedSize    compressed length, from the directory
 * @property {number|null} offset   byte offset in the image, or null if unmapped
 * @property {number|null} capacity bytes the blocks span, which straddles zones
 * @property {number|null} documentedSize  what the format docs predict, or null
 */

/**
 * Read the read-only directory. Returns the used entries in slot order.
 * Stops at the first slot whose name is not printable ASCII, which is how the
 * unused tail of the array reads.
 * @param {Uint8Array} bytes  a whole .ddd image
 * @returns {DddEntry[]}
 */
export function readDirectory(bytes) {
    if (bytes.length < DIRECTORY_END) throw new Error(`image is ${bytes.length} bytes, too short for the directory at 0x${DIRECTORY_OFFSET.toString(16)}`);
    const entries = [];
    for (let slot = 0; slot < DIRECTORY_SLOTS; slot++) {
        const at = NAMES + slot * 11;
        let raw = "";
        let printable = true;
        for (let i = 0; i < 11; i++) {
            const c = bytes[at + i];
            if (c < 0x20 || c > 0x7e) { printable = false; break; }
            raw += String.fromCharCode(c);
        }
        if (!printable || raw.trim() === "") break;
        const ext = raw.slice(8);
        const startLba = u16(bytes, START_LBA + slot * 2);
        const blockCount = u16(bytes, BLOCK_COUNT + slot * 2);
        const storedSize = u32(bytes, STORED_SIZE + slot * 4);
        const key = sizeKey(ext);
        entries.push(Object.freeze({
            slot,
            name: raw.slice(0, 8).trimEnd(),
            ext,
            stage: /^[0-9]/.test(ext) ? Number(ext[0]) : null,
            startLba,
            blockCount,
            storedSize,
            offset: lbaToOffset(startLba),
            capacity: extentBytes(startLba, blockCount),
            documentedSize: key in DOCUMENTED_SIZES ? DOCUMENTED_SIZES[key] : null,
        }));
    }
    return entries;
}

/**
 * The invariants this directory is supposed to satisfy, checked rather than
 * assumed. `blocksFit` is the one that proves the zone boundary: it only holds
 * if the block shrinks from 19,720 to 18,360 bytes at LBA 268.
 * @param {DddEntry[]} entries
 */
export function checkDirectory(entries) {
    const contiguous = entries.every((e, i) => i === 0 || entries[i - 1].startLba + entries[i - 1].blockCount === e.startLba);
    const blocksFit = entries.every((e) => {
        const bs = blockSize(e.startLba);
        return bs !== null && Math.ceil(e.storedSize / bs) === e.blockCount;
    });
    const withinCapacity = entries.every((e) => e.capacity !== null && e.storedSize <= e.capacity);
    const last = entries[entries.length - 1];
    return {
        contiguous,
        blocksFit,
        withinCapacity,
        end: last && last.offset !== null ? last.offset + last.storedSize : null,
    };
}

/**
 * Group entries by project name, preserving directory order.
 * @param {DddEntry[]} entries
 * @returns {Map<string, DddEntry[]>}
 */
export function byProject(entries) {
    const out = new Map();
    for (const e of entries) {
        const list = out.get(e.name);
        if (list) list.push(e);
        else out.set(e.name, [e]);
    }
    return out;
}
