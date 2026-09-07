// The container: a raw dump of the SHVC-66 cart's battery SRAM.
//
// Nothing wraps the bytes — no emulator header, no interleave, no
// compression. Recognition rests on two things the game itself checks: the
// size (the boot code refuses anything but exactly 128 KB of SRAM, which is
// why cartridge copiers with more SRAM fail its "S-RAM CHECK!") and the
// eight-byte CHECK STRINGS magic "T.TABATA" at the end of the first segment.
// A 64 KB file is accepted too: some dumpers stop at the second segment, and
// everything but GRAPIC DATA lives below 0x10000.
//
// The 32-byte CHECK SUM block at 0 is repeated verbatim at 0x7E5A (the ROM's
// "CHECK SUM COPY"); comparing the two is the only integrity check available
// until the algorithm is traced. Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";

export const SRAM_SIZE = 0x20000;
export const SEGMENT_SIZE = 0x8000;
export const SEGMENT_COUNT = 4;
/** File sizes accepted as a Dezaemon SRAM dump: a full cart, or its first half. */
export const ACCEPTED_SIZES = Object.freeze([0x10000, SRAM_SIZE]);
export const CHECK_STRING = "T.TABATA";
export const CHECK_STRING_OFFSET = REGION.checkString.offset;
export const CHECKSUM_OFFSET = REGION.checksum.offset;
export const CHECKSUM_SIZE = REGION.checksum.length;
export const CHECKSUM_COPY_OFFSET = REGION.checksumCopy.offset;

/** ASCII/latin1 of a byte range; non-printables are kept as-is. */
export function latin1(bytes, offset, length) {
    let s = "";
    for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
}

/** The 8-byte CHECK STRINGS field. */
export function readCheckString(bytes) {
    return latin1(bytes, CHECK_STRING_OFFSET, REGION.checkString.length);
}

export function hasCheckString(bytes) {
    return bytes.length >= CHECK_STRING_OFFSET + CHECK_STRING.length && readCheckString(bytes) === CHECK_STRING;
}

/** True for a 64 KB or 128 KB dump carrying the "T.TABATA" magic. */
export function isSfcSav(bytes) {
    return ACCEPTED_SIZES.includes(bytes.length) && hasCheckString(bytes);
}

export function isBlank(bytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

/**
 * The four 32 KB segments as views (no copies). Segments past the end of a
 * short file are reported `present: false` with an empty view.
 */
export function splitSegments(bytes) {
    const segments = [];
    for (let i = 0; i < SEGMENT_COUNT; i++) {
        const offset = i * SEGMENT_SIZE;
        const present = bytes.length >= offset + SEGMENT_SIZE;
        const view = present ? bytes.subarray(offset, offset + SEGMENT_SIZE) : bytes.subarray(0, 0);
        segments.push({ index: i, offset, bank: 0x70 + i, present, bytes: view, blank: !present || isBlank(view) });
    }
    return segments;
}

/** The CHECK SUM block, its copy, and whether they agree. */
export function readChecksumBlocks(bytes) {
    const primary = bytes.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_SIZE);
    const copy = bytes.subarray(CHECKSUM_COPY_OFFSET, CHECKSUM_COPY_OFFSET + CHECKSUM_SIZE);
    let equal = primary.length === CHECKSUM_SIZE && copy.length === CHECKSUM_SIZE;
    for (let i = 0; equal && i < CHECKSUM_SIZE; i++) if (primary[i] !== copy[i]) equal = false;
    const words = new Uint16Array(CHECKSUM_SIZE / 2);
    for (let i = 0; i < words.length; i++) words[i] = primary[i * 2] | (primary[i * 2 + 1] << 8);
    return { primary, copy, equal, words };
}
