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
// The whole directory is replicated byte-identically at 0x18D3482 and
// 0x18DF3C2, 34,680 and then 48,960 bytes on. Those two gaps are exact sums
// of 64DD block sizes — 85x192 + 85x216, and 3 x 85x192 — which is how the
// block geometry first announced itself.
//
// Environment-neutral ESM (Node + browser).

import { blockSize, blocksFor, DEZAEMON_DISK_TYPE, extentBytes, lbaToOffset, romEndLba } from "./geometry.js";

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

/**
 * Where the directory repeats, verbatim, as byte offsets from the first
 * copy: the gaps between consecutive copies are 34,680 and 48,960.
 */
export const DIRECTORY_COPIES = Object.freeze([0, 34680, 83640]);

/**
 * Where those three copies are in LBA terms, which is what makes the
 * distances make sense: all three sit 834 bytes into a block — the last
 * block of the ROM area (18,360 bytes) and the second and fifth blocks of
 * the RAM area (16,320 each). 34,680 = (18,360 - 834) + 16,320 + 834 and
 * 48,960 = 3 x 16,320. Under geometry.js's zone table the three offsets come
 * out as 0x18CAD0A, 0x18D3482 and 0x18DF3C2 exactly, which is one of the
 * measurements that pins the table (directoryOffsets() derives them).
 */
export const DIRECTORY_LBA = 1417;
export const DIRECTORY_IN_BLOCK_OFFSET = 834;
export const DIRECTORY_COPY_LBAS = Object.freeze([1417, 1419, 1422]);

/** Bytes a slot takes across the five arrays: 11 + 2 + 2 + 2 + 4. */
export const SLOT_BYTES = 21;

/** The whole directory, every array of every slot: 834 x 21 = 17,514 bytes. */
export const DIRECTORY_BYTES = DIRECTORY_SLOTS * SLOT_BYTES;

/** Where the first file starts: the nine blocks before it hold the boot program. */
export const FIRST_FILE_LBA = 9;

/** A name is eight characters, an extension three. */
export const NAME_CHARS = 8;
export const EXT_CHARS = 3;

/** The six files every project carries, then three per stage. */
export const GLOBAL_EXTS = Object.freeze(["GAM", "CGR", "CMD", "CBL", "ULB", "MUS"]);

/** Stage suffixes present on this disk. Stage 7 is absent from the numbering. */
export const STAGES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8]);

/** The three files each stage carries, in directory order. */
export const STAGE_EXTS = Object.freeze(["BL", "MD", "GR"]);

/** Files in a project: 6 + 3 x 8 = 30. */
export const PROJECT_FILE_COUNT = GLOBAL_EXTS.length + STAGES.length * STAGE_EXTS.length;

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

// --- the writer half ------------------------------------------------------------

/**
 * The thirty extensions of a project in directory order: the six globals,
 * then BL, MD and GR for each stage.
 * @param {readonly number[]} [stages]
 * @returns {string[]}
 */
export function projectExts(stages = STAGES) {
    return [...GLOBAL_EXTS, ...stages.flatMap((s) => STAGE_EXTS.map((e) => `${s}${e}`))];
}

/** Where a file sorts within a project: its index in projectExts(), unknown extensions after all of them. */
export function extOrder(ext) {
    const i = projectExts().indexOf(String(ext).toUpperCase());
    return i < 0 ? PROJECT_FILE_COUNT : i;
}

/**
 * A project name the directory can hold: upper-case letters and digits
 * only, at most eight of them. Anything else in the given name is dropped
 * (an ATNFS name is matched byte for byte by the cartridge, and the two
 * sample projects and the user project on the prototype disk use nothing
 * but A-Z and 0-9). An empty result throws.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProjectName(name) {
    const clean = String(name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, NAME_CHARS);
    if (!clean) throw new Error(`"${name}" leaves no letters or digits for a project name`);
    return clean;
}

/**
 * The byte offsets of the three directory copies in a .ddd of a disk type.
 * @param {number} [type]
 * @returns {number[]}
 */
export function directoryOffsets(type = DEZAEMON_DISK_TYPE) {
    return DIRECTORY_COPY_LBAS.map((lba) => lbaToOffset(lba, type) + DIRECTORY_IN_BLOCK_OFFSET);
}

/**
 * One slot's eleven name bytes: NAME space-padded to eight, then the three
 * of EXT, no separator.
 * @param {string} name
 * @param {string} ext
 * @returns {Uint8Array}
 */
export function encodeSlotName(name, ext) {
    const n = String(name);
    const e = String(ext);
    if (n.length < 1 || n.length > NAME_CHARS) throw new Error(`a project name is 1..${NAME_CHARS} characters; "${n}" is not`);
    if (e.length !== EXT_CHARS) throw new Error(`an extension is ${EXT_CHARS} characters; "${e}" is not`);
    const out = new Uint8Array(NAME_CHARS + EXT_CHARS);
    const label = n.padEnd(NAME_CHARS) + e;
    for (let i = 0; i < label.length; i++) {
        const c = label.charCodeAt(i);
        if (c < 0x21 && i < n.length) throw new Error(`"${n}" has a blank in its name`);
        if (c < 0x20 || c > 0x7e) throw new Error(`"${label[i]}" is not printable ASCII; a directory name is`);
        out[i] = c;
    }
    return out;
}

/**
 * @typedef {object} DirectoryEntry
 * @property {string} name
 * @property {string} ext
 * @property {number} startLba
 * @property {number} blockCount
 * @property {number} storedSize
 * @property {number} [reserved]  the u16 that is zero on every slot of the prototype disk
 */

/**
 * The directory's five parallel arrays for a list of entries, unused slots
 * zero — which is how readDirectory() knows where the used ones end.
 * @param {DirectoryEntry[]} entries
 * @param {{slots?: number}} [options]  the array length; 834 on the prototype disk
 * @returns {Uint8Array}
 */
export function encodeDirectory(entries, { slots = DIRECTORY_SLOTS } = {}) {
    if (entries.length > slots) throw new Error(`the directory holds ${slots} files; ${entries.length} were given`);
    const out = new Uint8Array(slots * SLOT_BYTES);
    const names = 0;
    const startLba = names + slots * 11;
    const blockCount = startLba + slots * 2;
    const reserved = blockCount + slots * 2;
    const storedSize = reserved + slots * 2;
    entries.forEach((e, slot) => {
        out.set(encodeSlotName(e.name, e.ext), names + slot * 11);
        for (const [at, v, what] of [[startLba, e.startLba, "start LBA"], [blockCount, e.blockCount, "block count"], [reserved, e.reserved ?? 0, "reserved word"]]) {
            if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`${e.name}.${e.ext}: ${what} ${v} is not a u16`);
            out[at + slot * 2] = v >> 8;
            out[at + slot * 2 + 1] = v & 0xff;
        }
        if (!Number.isInteger(e.storedSize) || e.storedSize < 0 || e.storedSize > 0xffffffff) throw new Error(`${e.name}.${e.ext}: stored size ${e.storedSize} is not a u32`);
        const at = storedSize + slot * 4;
        out[at] = (e.storedSize >>> 24) & 0xff;
        out[at + 1] = (e.storedSize >>> 16) & 0xff;
        out[at + 2] = (e.storedSize >>> 8) & 0xff;
        out[at + 3] = e.storedSize & 0xff;
    });
    return out;
}

/**
 * Write the read-only directory into a .ddd, all three copies. Returns the
 * encoded bytes.
 * @param {Uint8Array} user  a .ddd (the user area)
 * @param {DirectoryEntry[]} entries
 * @param {number} [type]
 * @returns {Uint8Array}
 */
export function writeDirectory(user, entries, type = DEZAEMON_DISK_TYPE) {
    const bytes = encodeDirectory(entries);
    for (const at of directoryOffsets(type)) {
        if (at + bytes.length > user.length) throw new Error(`the image is ${user.length} bytes, too short for a directory copy at 0x${at.toString(16)}`);
        user.set(bytes, at);
    }
    return bytes;
}

/**
 * Lay compressed streams end to end from `firstLba`, the way the prototype
 * disk's are: each file's blockCount is the blocks its bytes span from where
 * it starts, which depends on the zone, and the next file starts on the
 * block after. Throws when the files would reach the directory's block.
 * @param {{name: string, ext: string, storedSize: number}[]} files
 * @param {{firstLba?: number, type?: number}} [options]
 * @returns {(DirectoryEntry & {offset: number, capacity: number})[]}
 */
export function layoutFiles(files, { firstLba = FIRST_FILE_LBA, type = DEZAEMON_DISK_TYPE } = {}) {
    const lastLba = romEndLba(type) - 1; // the ROM area's last block holds the directory
    const out = [];
    let lba = firstLba;
    for (const f of files) {
        const blocks = blocksFor(lba, f.storedSize, type);
        if (blocks === null || lba + blocks - 1 > lastLba) {
            const used = lbaToOffset(lba, type) - lbaToOffset(firstLba, type);
            const room = lbaToOffset(lastLba + 1, type) - lbaToOffset(firstLba, type);
            throw new Error(
                `the ROM area is full at ${f.name}.${f.ext}: ${used} bytes of files already laid out and ` +
                    `${room} available between LBA ${firstLba} and the directory at LBA ${lastLba + 1}`,
            );
        }
        out.push({
            name: f.name,
            ext: f.ext,
            startLba: lba,
            blockCount: blocks,
            storedSize: f.storedSize,
            offset: lbaToOffset(lba, type),
            capacity: extentBytes(lba, blocks, type) ?? 0,
        });
        lba += blocks;
    }
    return out;
}
