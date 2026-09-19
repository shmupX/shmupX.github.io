// 64DD disk geometry: where a logical block lands inside a .ddd image.
//
// A 64DD disk is zoned. A block is 85 sectors, and the sector size steps down
// from the outer edge inwards through 232, 216, 208, 192, 176, 160, 144, 128
// and 112 bytes, so a block is 85x that — 19,720 bytes in the outermost zone,
// 9,520 in the innermost. A .ddd image is those blocks concatenated in libleo
// LBA order, which is why a fixed stride finds nothing in one.
//
// What is implemented here is the part this repo has measured against
// dev-fixtures/dezaemon298.ddd: LBA 0 through the end of the ROM area. Over
// that range the map is two zones:
//
//   LBA   0..267   block 19,720 bytes  (85 x 232)
//   LBA 268..369   block 18,360 bytes  (85 x 216)
//
// Three independent things agree. Every one of the 60 directory entries
// satisfies blockCount === ceil(storedSize / blockSize(startLba)) — the same
// file appears with 10 blocks at LBA 96 and 11 at LBA 272, which happens only
// if the block shrinks at 268. The entries are contiguous, so their offsets
// chain. And the last file's extent ends at 0x6C7187, flush against the
// 18.9 MB run of unwritten 0xFF where the save area begins.
//
// Past the ROM area the map needs the full table: the disk has two heads and
// sixteen physical zones, and LBA order walks them through a per-disk-type
// vzone->pzone permutation that is NOT a monotone descent. That table is
// published (LuigiBlood's 64dd wiki; leo64dd_python; leotools leogeo.c) and is
// deliberately not reproduced here, because nothing in this repo has checked
// it against a disk. lbaToOffset() returns null there rather than guess.
//
// Environment-neutral ESM (Node + browser).

/** Sectors in one 64DD block, every zone. */
export const SECTORS_PER_BLOCK = 85;

/** Sector size for each of the nine 64DD zones, outermost first. */
export const ZONE_SECTOR_SIZES = Object.freeze([232, 216, 208, 192, 176, 160, 144, 128, 112]);

/** A .ddd image: a full 64DD disk minus the 24-block system area. */
export const DDD_IMAGE_BYTES = 64458560;

/** The system area a .ddd omits and an .ndd carries: 24 blocks of 85 x 232. */
export const SYSTEM_AREA_BYTES = 24 * SECTORS_PER_BLOCK * 232;

/** First LBA of the second zone. Measured, not assumed — see the header. */
export const ZONE1_START_LBA = 268;

/** First LBA past the mapped ROM area. Beyond this the full table is needed. */
export const MAPPED_END_LBA = 370;

const ZONE0_BLOCK = SECTORS_PER_BLOCK * 232;
const ZONE1_BLOCK = SECTORS_PER_BLOCK * 216;

/**
 * Bytes in the block at `lba`, or null where the mapping is not established.
 * @param {number} lba
 * @returns {number | null}
 */
export function blockSize(lba) {
    if (!Number.isInteger(lba) || lba < 0 || lba >= MAPPED_END_LBA) return null;
    return lba < ZONE1_START_LBA ? ZONE0_BLOCK : ZONE1_BLOCK;
}

/**
 * Byte offset of `lba` within a .ddd image, or null where the mapping is not
 * established. The cumulative sum of every block before it, which is a closed
 * form only because the two zone sizes are constant over the mapped range.
 * @param {number} lba
 * @returns {number | null}
 */
export function lbaToOffset(lba) {
    if (!Number.isInteger(lba) || lba < 0 || lba > MAPPED_END_LBA) return null;
    if (lba <= ZONE1_START_LBA) return lba * ZONE0_BLOCK;
    return ZONE1_START_LBA * ZONE0_BLOCK + (lba - ZONE1_START_LBA) * ZONE1_BLOCK;
}

/**
 * Bytes spanned by `count` blocks starting at `lba`. Not `count * blockSize`:
 * an extent can straddle the zone boundary, and one on this disk does —
 * SAMP 3MD starts at LBA 266 and runs five blocks across 268.
 * @param {number} lba
 * @param {number} count
 * @returns {number | null}
 */
export function extentBytes(lba, count) {
    const from = lbaToOffset(lba);
    const to = lbaToOffset(lba + count);
    if (from === null || to === null) return null;
    return to - from;
}

/**
 * Whether a byte length looks like a whole 64DD disk dump with the system
 * area sliced off, which is what a .ddd is.
 * @param {number} size
 * @returns {boolean}
 */
export function isDddSize(size) {
    return size === DDD_IMAGE_BYTES;
}
