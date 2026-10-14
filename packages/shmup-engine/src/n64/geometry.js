// 64DD disk geometry: where a logical block lands inside a .ddd or .ndd image.
//
// A 64DD disk is zoned. A block is 85 sectors, and the sector size steps down
// from the outer edge inwards through 232, 216, 208, 192, 176, 160, 144, 128
// and 112 bytes, so a block is 85x that — 19,720 bytes in the outermost zone,
// 9,520 in the innermost. A .ndd image is those blocks concatenated in libleo
// LBA order, system area first; a .ddd is the same less the 24 system blocks.
// That is why a fixed stride finds nothing in either.
//
// The disk has two heads and eight zones a head: sixteen PHYSICAL zones, 0-7
// on head 0 and 8-15 on head 1, where head 1's zone k has the sector size of
// head 0's zone k+1. Each has 158, 149 or 114 tracks of two blocks, twelve of
// which every zone keeps spare for defects, so the usable blocks per physical
// zone are 292, 292, 274, 274, 274, 274, 274 and 204 on each head — 4,316 in
// all, 24 of them the system area. LBA order walks the physical zones through
// a per-disk-type permutation (the VIRTUAL zones): the ROM area takes the
// outer zones of both heads, the RAM area the inner ones, and a disk type
// moves the split. Disk type 0, the Dezaemon disk's, is
//
//   vzone  0  1  2  3  4 |  5  6  7  8  9 10 11 12 13 14 15
//   pzone  0  1  2  9  8 |  3  4  5  6  7 15 14 13 12 11 10
//   sector 232 216 208 208 216 | 192 176 160 144 128 112 128 144 160 176 192
//
// with the ROM area the five zones before the bar (user LBA 0..1417) and the
// RAM area the eleven after it (1418..4291).
//
// Three things pin this table to the disk this repo has measured
// (dev-fixtures/dezaemon298.ddd), beyond the published tables themselves
// (LuigiBlood's 64dd wiki; jkbenaim/leotools leogeo.c; mupen64plus-core
// src/device/dd/disk.h, which agree with each other and with this file):
//
//   - every one of the 60 directory entries satisfies
//     blockCount === ceil(storedSize / blockSize(startLba)) — the same file
//     appears with 10 blocks at LBA 96 and 11 at LBA 272, which happens only
//     if the block shrinks from 19,720 to 18,360 at LBA 268, where vzone 0
//     ends once the 24 system blocks are taken off the front of it;
//   - the read-only directory is replicated at three image offsets that are
//     exactly in-block offset 834 of LBA 1417, 1419 and 1422 under this table
//     and under no other ordering of the sector sizes — 1417 is the last ROM
//     block (18,360 bytes), 1419 and 1422 are RAM blocks (16,320 bytes);
//   - the sixteen zones sum to 64,458,560 bytes, the length of every .ddd.
//
// Environment-neutral ESM (Node + browser).

/** Sectors in one 64DD block, every zone. */
export const SECTORS_PER_BLOCK = 85;

/** Blocks on one track. */
export const BLOCKS_PER_TRACK = 2;

/** Sector size for each of the nine 64DD zones, outermost first. */
export const ZONE_SECTOR_SIZES = Object.freeze([232, 216, 208, 192, 176, 160, 144, 128, 112]);

/**
 * Sector size of each of the sixteen physical zones: head 0's eight, then
 * head 1's eight, which start one size smaller.
 */
export const PZONE_SECTOR_SIZES = Object.freeze([
    232, 216, 208, 192, 176, 160, 144, 128,
    216, 208, 192, 176, 160, 144, 128, 112,
]);

/** Tracks in each physical zone, spares included. */
export const PZONE_TRACKS = Object.freeze([
    158, 158, 149, 149, 149, 149, 149, 114,
    158, 158, 149, 149, 149, 149, 149, 114,
]);

/** Tracks every zone keeps aside for defects; they carry no LBA. */
export const SPARE_TRACKS_PER_ZONE = 12;

/**
 * The virtual-to-physical zone order of each disk type, 0 through 6. A
 * type's ROM area is the first 5 + 2 x type virtual zones; type 6 is all ROM.
 */
export const DISK_TYPE_ZONES = Object.freeze([
    Object.freeze([0, 1, 2, 9, 8, 3, 4, 5, 6, 7, 15, 14, 13, 12, 11, 10]),
    Object.freeze([0, 1, 2, 3, 10, 9, 8, 4, 5, 6, 7, 15, 14, 13, 12, 11]),
    Object.freeze([0, 1, 2, 3, 4, 11, 10, 9, 8, 5, 6, 7, 15, 14, 13, 12]),
    Object.freeze([0, 1, 2, 3, 4, 5, 12, 11, 10, 9, 8, 6, 7, 15, 14, 13]),
    Object.freeze([0, 1, 2, 3, 4, 5, 6, 13, 12, 11, 10, 9, 8, 7, 15, 14]),
    Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 14, 13, 12, 11, 10, 9, 8, 15]),
    Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 15, 14, 13, 12, 11, 10, 9, 8]),
]);

/** How many disk types the format defines. */
export const DISK_TYPE_COUNT = DISK_TYPE_ZONES.length;

/** The Dezaemon 3D data disk is disk type 0. */
export const DEZAEMON_DISK_TYPE = 0;

/** Physical LBAs on a disk, the system area included. */
export const TOTAL_LBAS = 4316;

/** The system area: the first 24 physical blocks, all in the outermost zone. */
export const SYSTEM_AREA_LBAS = 24;

/** User LBAs on a disk: what a .ddd holds and a .ndd holds after its system area. */
export const USER_LBA_COUNT = TOTAL_LBAS - SYSTEM_AREA_LBAS;

/** The last user LBA. */
export const MAX_USER_LBA = USER_LBA_COUNT - 1;

/** The system area a .ddd omits and an .ndd carries: 24 blocks of 85 x 232. */
export const SYSTEM_AREA_BYTES = SYSTEM_AREA_LBAS * SECTORS_PER_BLOCK * 232;

/** A .ddd image: a full 64DD disk minus the 24-block system area. */
export const DDD_IMAGE_BYTES = 64458560;

/** A .ndd image: the whole disk, system area first. */
export const NDD_IMAGE_BYTES = DDD_IMAGE_BYTES + SYSTEM_AREA_BYTES;

/** First user LBA of the second zone on a type-0 disk. Measured, not assumed — see the header. */
export const ZONE1_START_LBA = 268;

/** Bytes in a block of a physical zone. */
export function pzoneBlockSize(pzone) {
    return PZONE_SECTOR_SIZES[pzone] * SECTORS_PER_BLOCK;
}

/** Usable blocks in a physical zone: its tracks less the spares, two blocks each. */
export function pzoneBlocks(pzone) {
    return (PZONE_TRACKS[pzone] - SPARE_TRACKS_PER_ZONE) * BLOCKS_PER_TRACK;
}

function checkType(type) {
    if (!Number.isInteger(type) || type < 0 || type >= DISK_TYPE_COUNT) {
        throw new Error(`disk type ${type} is not one of 0..${DISK_TYPE_COUNT - 1}`);
    }
}

/**
 * How many virtual zones a disk type's ROM area spans; the rest are RAM.
 * @param {number} type
 */
export function romZoneCount(type) {
    checkType(type);
    return Math.min(16, 5 + 2 * type);
}

const tables = new Map();

/**
 * @typedef {object} Zone
 * @property {number} vzone       virtual zone, 0-15 in LBA order
 * @property {number} pzone       the physical zone it maps to
 * @property {number} sectorSize
 * @property {number} blockSize
 * @property {number} firstLba    first USER LBA of the zone (vzone 0 starts at 0)
 * @property {number} blockCount  user blocks in the zone (vzone 0 is short by the system area)
 * @property {number} offset      byte offset of the zone's first user block in a .ddd
 * @property {boolean} rom        whether the zone is in the ROM area
 */

/**
 * The sixteen virtual zones of a disk type in USER terms: LBA 0 is the first
 * block after the system area and offset 0 is the first byte of a .ddd.
 * @param {number} [type]
 * @returns {readonly Zone[]}
 */
export function zoneTable(type = DEZAEMON_DISK_TYPE) {
    checkType(type);
    if (tables.has(type)) return tables.get(type);
    const rom = romZoneCount(type);
    const zones = [];
    let lba = 0;
    let offset = 0;
    DISK_TYPE_ZONES[type].forEach((pzone, vzone) => {
        const blockSize = pzoneBlockSize(pzone);
        const blockCount = pzoneBlocks(pzone) - (vzone === 0 ? SYSTEM_AREA_LBAS : 0);
        zones.push(Object.freeze({
            vzone,
            pzone,
            sectorSize: PZONE_SECTOR_SIZES[pzone],
            blockSize,
            firstLba: lba,
            blockCount,
            offset,
            rom: vzone < rom,
        }));
        lba += blockCount;
        offset += blockCount * blockSize;
    });
    const table = Object.freeze(zones);
    tables.set(type, table);
    return table;
}

/**
 * The zone a user LBA falls in, or null off the disk.
 * @param {number} lba
 * @param {number} [type]
 * @returns {Zone | null}
 */
export function zoneOf(lba, type = DEZAEMON_DISK_TYPE) {
    if (!Number.isInteger(lba) || lba < 0 || lba > MAX_USER_LBA) return null;
    for (const z of zoneTable(type)) {
        if (lba < z.firstLba + z.blockCount) return z;
    }
    return null;
}

/**
 * Bytes in the block at user LBA `lba`, or null off the disk.
 * @param {number} lba
 * @param {number} [type]
 * @returns {number | null}
 */
export function blockSize(lba, type = DEZAEMON_DISK_TYPE) {
    const z = zoneOf(lba, type);
    return z ? z.blockSize : null;
}

/**
 * Byte offset of user LBA `lba` within a .ddd image, or null off the disk.
 * `lba` may be one past the last block, which gives the image length.
 * @param {number} lba
 * @param {number} [type]
 * @returns {number | null}
 */
export function lbaToOffset(lba, type = DEZAEMON_DISK_TYPE) {
    if (!Number.isInteger(lba) || lba < 0 || lba > USER_LBA_COUNT) return null;
    if (lba === USER_LBA_COUNT) return DDD_IMAGE_BYTES;
    const z = zoneOf(lba, type);
    return z.offset + (lba - z.firstLba) * z.blockSize;
}

/**
 * The user LBA whose block holds byte `offset` of a .ddd, or null past the end.
 * @param {number} offset
 * @param {number} [type]
 * @returns {number | null}
 */
export function offsetToLba(offset, type = DEZAEMON_DISK_TYPE) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= DDD_IMAGE_BYTES) return null;
    for (const z of zoneTable(type)) {
        const end = z.offset + z.blockCount * z.blockSize;
        if (offset < end) return z.firstLba + Math.floor((offset - z.offset) / z.blockSize);
    }
    return null;
}

/**
 * Bytes spanned by `count` blocks starting at `lba`. Not `count * blockSize`:
 * an extent can straddle a zone boundary, and one on the Dezaemon disk does —
 * SAMP 3MD starts at LBA 266 and runs five blocks across 268.
 * @param {number} lba
 * @param {number} count
 * @param {number} [type]
 * @returns {number | null}
 */
export function extentBytes(lba, count, type = DEZAEMON_DISK_TYPE) {
    if (!Number.isInteger(count) || count < 0) return null;
    const from = lbaToOffset(lba, type);
    const to = lbaToOffset(lba + count, type);
    if (from === null || to === null) return null;
    return to - from;
}

/**
 * Blocks needed for `bytes` starting at `lba`, walking the zone sizes block by
 * block — the inverse of extentBytes(), and what the directory's blockCount is.
 * @param {number} lba
 * @param {number} bytes
 * @param {number} [type]
 * @returns {number | null}  null when the bytes run off the disk
 */
export function blocksFor(lba, bytes, type = DEZAEMON_DISK_TYPE) {
    if (!Number.isInteger(bytes) || bytes < 0 || lbaToOffset(lba, type) === null) return null;
    let count = 0;
    let left = bytes;
    while (left > 0) {
        const size = blockSize(lba + count, type);
        if (size === null) return null;
        left -= size;
        count++;
    }
    return count;
}

/** The last user LBA of a disk type's ROM area. */
export function romEndLba(type = DEZAEMON_DISK_TYPE) {
    const zones = zoneTable(type);
    const last = zones[romZoneCount(type) - 1];
    return last.firstLba + last.blockCount - 1;
}

/** The first user LBA of a disk type's RAM area, or null for type 6, which has none. */
export function ramStartLba(type = DEZAEMON_DISK_TYPE) {
    const end = romEndLba(type);
    return end >= MAX_USER_LBA ? null : end + 1;
}

/** The last user LBA of a disk type's RAM area, or null for type 6. */
export function ramEndLba(type = DEZAEMON_DISK_TYPE) {
    return ramStartLba(type) === null ? null : MAX_USER_LBA;
}

/** The .ddd offset where a disk type's RAM area begins (its ROM area's length), or null for type 6. */
export function ramStartOffset(type = DEZAEMON_DISK_TYPE) {
    const lba = ramStartLba(type);
    return lba === null ? null : lbaToOffset(lba, type);
}

/** Whether a byte length is a whole 64DD disk dump with the system area sliced off, which is what a .ddd is. */
export function isDddSize(size) {
    return size === DDD_IMAGE_BYTES;
}

/** Whether a byte length is a whole 64DD disk dump, system area and all: an .ndd. */
export function isNddSize(size) {
    return size === NDD_IMAGE_BYTES;
}

/**
 * The user area of an .ndd as a .ddd: the same bytes less the 24 system
 * blocks. A .ddd passes through unchanged (as a copy); anything else throws.
 * @param {Uint8Array} image
 * @returns {Uint8Array}
 */
export function dddFromImage(image) {
    if (isNddSize(image.length)) return image.slice(SYSTEM_AREA_BYTES);
    if (isDddSize(image.length)) return image.slice();
    throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
}

/**
 * The user area of an image as a view (no copy): a .ddd is itself, an .ndd
 * is its tail. Throws on any other length.
 * @param {Uint8Array} image
 * @returns {Uint8Array}
 */
export function userArea(image) {
    if (isNddSize(image.length)) return image.subarray(SYSTEM_AREA_BYTES);
    if (isDddSize(image.length)) return image;
    throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
}

/**
 * The system area of an .ndd (a view), or null for a .ddd, which has none.
 * @param {Uint8Array} image
 * @returns {Uint8Array | null}
 */
export function systemAreaOf(image) {
    if (isNddSize(image.length)) return image.subarray(0, SYSTEM_AREA_BYTES);
    if (isDddSize(image.length)) return null;
    throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
}

/**
 * An .ndd from a .ddd and a 473,280-byte system area (see system-area.js for
 * building one). An .ndd passed as the user area has its own system area
 * replaced.
 * @param {Uint8Array} image      a .ddd or .ndd
 * @param {Uint8Array} systemArea
 * @returns {Uint8Array}
 */
export function nddFromDdd(image, systemArea) {
    if (!(systemArea instanceof Uint8Array) || systemArea.length !== SYSTEM_AREA_BYTES) {
        throw new Error(`a system area is ${SYSTEM_AREA_BYTES} bytes`);
    }
    const user = userArea(image);
    const out = new Uint8Array(NDD_IMAGE_BYTES);
    out.set(systemArea, 0);
    out.set(user, SYSTEM_AREA_BYTES);
    return out;
}
