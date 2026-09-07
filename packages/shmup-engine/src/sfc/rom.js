// What the Dezaemon ROM can tell a save parser — read-only, and optional.
//
// Three things in the 512 KB LoROM image matter here. The internal header at
// 0x7FC0 declares the cart (title "DEZAEMON", 128 KB SRAM), which is how a
// caller can be sure the ROM beside a save is the right one. A debug table at
// 0x66A5 lists every SRAM region by address and name — the source of
// regions.js, and the test that keeps it honest. And 0x50000-0x5FFFF is the
// 64 KB image the game copies into fresh SRAM: the built-in sample game, so a
// save whose first half equals it has never been edited.
//
// A 512-byte copier header, when present, is skipped. Nothing here is needed
// to parse a save. Environment-neutral ESM (Node + browser).

import { SFC_REGIONS } from "./regions.js";

export const ROM_HEADER_OFFSET = 0x7fc0;
export const ROM_REGION_TABLE_OFFSET = 0x66a5;
export const ROM_DEFAULT_IMAGE_OFFSET = 0x50000;
export const ROM_DEFAULT_IMAGE_SIZE = 0x10000;
export const ROM_TITLE = "DEZAEMON";

/** Bytes before the ROM proper: 512 for a copier header, else 0. */
export function copierHeaderSize(rom) {
    return rom.length % 0x8000 === 512 ? 512 : 0;
}

function latin1(bytes, offset, length) {
    let s = "";
    for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
}

/** The SNES internal header, LoROM position. */
export function readRomHeader(rom) {
    const skip = copierHeaderSize(rom);
    const h = skip + ROM_HEADER_OFFSET;
    if (h + 0x20 > rom.length) throw new Error(`ROM too small for a LoROM header: ${rom.length} bytes`);
    const complement = rom[h + 0x1c] | (rom[h + 0x1d] << 8);
    const checksum = rom[h + 0x1e] | (rom[h + 0x1f] << 8);
    const romSizeCode = rom[h + 0x17];
    const sramSizeCode = rom[h + 0x18];
    return {
        copierHeader: skip,
        headerOffset: h,
        title: latin1(rom, h, 21).trimEnd(),
        mapMode: rom[h + 0x15],
        cartType: rom[h + 0x16],
        romSizeCode,
        romSizeBytes: romSizeCode ? 1024 << romSizeCode : 0,
        sramSizeCode,
        sramSizeBytes: sramSizeCode ? 1024 << sramSizeCode : 0,
        region: rom[h + 0x19],
        version: rom[h + 0x1b],
        complement,
        checksum,
        valid: (complement ^ checksum) === 0xffff,
    };
}

/** True when the header names Dezaemon with its 128 KB of SRAM. */
export function isDezaemonRom(rom) {
    try {
        const header = readRomHeader(rom);
        return header.title === ROM_TITLE && header.sramSizeBytes === 0x20000;
    } catch {
        return false;
    }
}

const TABLE_ROW = /([0-9A-F]{5})-([0-9A-F]{5})\s+([A-Z][A-Z ]*[A-Z])/g;

/**
 * The debug region table: [{offset, end, label, at}] with `end` exclusive.
 * Scans the whole ROM, so a build that moved the table still yields it.
 */
export function parseRomRegionTable(rom) {
    const text = latin1(rom, 0, rom.length);
    const rows = [];
    for (const m of text.matchAll(TABLE_ROW)) {
        rows.push({ offset: parseInt(m[1], 16), end: parseInt(m[2], 16) + 1, label: m[3], at: m.index });
    }
    return rows;
}

/**
 * Compare a parsed ROM table with our region list: every ROM row must have a
 * region with the same span and label, and vice versa.
 */
export function regionTableMatches(rows, regions = SFC_REGIONS) {
    const key = (r) => `${r.offset}:${r.end}:${r.label}`;
    const ours = new Set(regions.map(key));
    const theirs = new Set(rows.map(key));
    const missing = regions.filter((r) => !theirs.has(key(r))).map((r) => r.label);
    const unexpected = rows.filter((r) => !ours.has(key(r))).map((r) => r.label);
    return { matches: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

/** The 64 KB default SRAM image the ROM carries (a view). */
export function romDefaultImage(rom) {
    const at = copierHeaderSize(rom) + ROM_DEFAULT_IMAGE_OFFSET;
    if (at + ROM_DEFAULT_IMAGE_SIZE > rom.length) throw new Error(`ROM too small for the default image: ${rom.length} bytes`);
    return rom.subarray(at, at + ROM_DEFAULT_IMAGE_SIZE);
}

/** How much of a save's first 64 KB still equals the ROM's default image. */
export function compareWithRomDefault(sav, rom) {
    const image = romDefaultImage(rom);
    const total = Math.min(image.length, sav.length);
    let equal = 0;
    for (let i = 0; i < total; i++) if (sav[i] === image[i]) equal++;
    return { equal, total, identical: equal === image.length };
}
