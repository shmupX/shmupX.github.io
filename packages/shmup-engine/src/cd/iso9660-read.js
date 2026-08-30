// Read-only ISO 9660 for Saturn/PlayStation disc images.
//
// lib/ps2/iso9660.ts is the WRITER (it builds the PS2 export's disc); this is
// the counterpart that reads one. It exists so the tone bank can pull
// SNDPAC.BIN straight out of a Dezaemon 2 disc image instead of asking anyone
// to carve the file out by hand — see src/audio/tone-bank.js.
//
// Everything a game disc needs and nothing more: the Primary Volume
// Descriptor at LBA 16, the root directory record inside it, and a flat walk
// of directory extents. No Joliet, no Rock Ridge, no path table (the root
// directory walk finds the same files and Saturn discs are flat anyway).
//
// Sector geometry is detected rather than assumed. A `.iso` is 2048-byte
// cooked sectors; a `.bin` from a CD ripper is usually MODE1/2352, where each
// sector carries a 12-byte sync pattern, a 4-byte header, the 2048 bytes of
// user data, then 288 bytes of EDC/ECC. The detector simply looks for the
// "CD001" standard identifier at the place each geometry would put it.
//
// Environment-neutral ESM (Deno + browser): takes and returns Uint8Array.

// [sector size, offset of the 2048-byte user area within the sector]
const GEOMETRIES = [
    [2048, 0], //  cooked .iso / .img
    [2352, 16], // MODE1/2352 raw rip (the common CD-ROM .bin)
    [2352, 24], // MODE2/2352 form 1
    [2336, 8], //  MODE2/2336
    [2448, 16], // MODE1/2352 + 96 bytes of subchannel
];

const PVD_LBA = 16;
const USER_SIZE = 2048;
const STANDARD_ID = [0x43, 0x44, 0x30, 0x30, 0x31]; // "CD001"

function hasVolumeDescriptor(bytes, sectorSize, dataOffset) {
    const at = PVD_LBA * sectorSize + dataOffset;
    if (at + USER_SIZE > bytes.length) return false;
    for (let i = 0; i < STANDARD_ID.length; i++) {
        if (bytes[at + 1 + i] !== STANDARD_ID[i]) return false;
    }
    // Descriptor type 1 = primary. Type 0 (boot) never lands at LBA 16 first.
    return bytes[at] === 1;
}

/**
 * Wrap a disc image. Returns null when no ISO 9660 filesystem is visible,
 * so callers can probe a directory of files without try/catch.
 */
export function openDisc(bytes) {
    const u8 = bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes.buffer ?? bytes);
    for (const [sectorSize, dataOffset] of GEOMETRIES) {
        if (hasVolumeDescriptor(u8, sectorSize, dataOffset)) {
            return { bytes: u8, sectorSize, dataOffset };
        }
    }
    return null;
}

/** The 2048-byte user area of one logical sector. */
function sector(disc, lba) {
    const at = lba * disc.sectorSize + disc.dataOffset;
    return disc.bytes.subarray(at, at + USER_SIZE);
}

/** Read `size` bytes starting at logical block `lba`, skipping sector overhead. */
export function readExtent(disc, lba, size) {
    const out = new Uint8Array(size);
    let written = 0;
    for (let i = 0; written < size; i++) {
        const chunk = sector(disc, lba + i);
        if (!chunk.length) break;
        const take = Math.min(USER_SIZE, size - written);
        out.set(chunk.subarray(0, take), written);
        written += take;
    }
    return written === size ? out : out.subarray(0, written);
}

function u32le(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) |
        (bytes[at + 3] << 24)) >>> 0;
}

// A directory record: length, extent LBA and data length in both-endian pairs
// (little-endian first), a flags byte whose bit1 marks a directory, then a
// length-prefixed name. Names 0x00 and 0x01 are "." and "..".
function parseDirectory(data) {
    const entries = [];
    let off = 0;
    while (off < data.length) {
        const len = data[off];
        if (len === 0) {
            // Records never straddle a sector, so a zero length means padding
            // to the end of this one.
            off = (Math.floor(off / USER_SIZE) + 1) * USER_SIZE;
            if (off >= data.length) break;
            continue;
        }
        const nameLen = data[off + 32];
        const raw = data.subarray(off + 33, off + 33 + nameLen);
        let name = "";
        for (let i = 0; i < raw.length; i++) name += String.fromCharCode(raw[i]);
        if (nameLen !== 1 || (raw[0] !== 0 && raw[0] !== 1)) {
            entries.push({
                name,
                lba: u32le(data, off + 2),
                size: u32le(data, off + 10),
                isDir: (data[off + 25] & 0x02) !== 0,
            });
        }
        off += len;
    }
    return entries;
}

/** The root directory record, straight out of the PVD. */
function rootRecord(disc) {
    const pvd = sector(disc, PVD_LBA);
    return { lba: u32le(pvd, 156 + 2), size: u32le(pvd, 156 + 10) };
}

/** Entries in one directory (the root by default). */
export function listFiles(disc, dir) {
    const at = dir ?? rootRecord(disc);
    return parseDirectory(readExtent(disc, at.lba, at.size));
}

// ISO 9660 level 1/2 names carry a ";1" version suffix and are upper-case;
// callers should be able to ask for "SNDPAC.BIN".
function sameName(entry, want) {
    const bare = entry.name.split(";")[0];
    return bare.toUpperCase() === want.toUpperCase();
}

/** Locate one entry by '/'-separated path. Returns null when absent. */
export function findEntry(disc, path) {
    const parts = String(path).split("/").filter(Boolean);
    let dir = rootRecord(disc);
    for (let i = 0; i < parts.length; i++) {
        const hit = listFiles(disc, dir).find((e) => sameName(e, parts[i]));
        if (!hit) return null;
        if (i === parts.length - 1) return hit;
        if (!hit.isDir) return null;
        dir = hit;
    }
    return null;
}

/** Read one file's bytes by path. Returns null when the file is not there. */
export function readFile(disc, path) {
    const entry = findEntry(disc, path);
    if (!entry || entry.isDir) return null;
    return readExtent(disc, entry.lba, entry.size);
}
