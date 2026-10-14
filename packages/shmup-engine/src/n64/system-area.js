// The 64DD system area: the 24 blocks an .ndd carries before the user area
// and a .ddd leaves off.
//
// Two of its blocks matter, and each is one 232-byte sector written 85 times
// over so that any sector of the block reads the same:
//
//   system data   LBA 0, 1, 8 and 9 on a retail-format disk (LBA 2, 3, 10 and
//                 11, in 192-byte sectors, on a development one)
//   disk ID       LBA 14 and 15
//
// The layouts are the ones every published reader agrees on — LuigiBlood's
// 64dd wiki, jkbenaim/leotools (leogeo.c, LeoGeo_analyze_disk) and
// mupen64plus-core (src/device/dd/disk.h, struct dd_sys_data; disk.c,
// scan_and_expand_disk_format, which is also what an emulator checks before
// it will mount an image):
//
//   system data (0xE8 bytes)
//     +0x00 u32  region: E8 48 D3 16 Japan, 22 63 EE 56 USA, 0 development
//     +0x04 u8   format, 0x10 on a retail-format disk
//     +0x05 u8   bit 4 retail, bits 0-3 the disk type (0-6; see geometry.js)
//     +0x06 u16  IPL load size in blocks, from user LBA 0
//     +0x08 u8[16] defect-track table offsets per physical zone (cumulative)
//     +0x18 u32  unused
//     +0x1C u32  IPL load address (0x80000000..0x807FFFFF)
//     +0x20 u8[192] defect tracks, twelve per zone at most
//     +0xE0 u16  last ROM-area user LBA
//     +0xE2 u16  first RAM-area user LBA (0xFFFF: none)
//     +0xE4 u16  last RAM-area user LBA  (0xFFFF: none)
//     +0xE6 u16  unused
//   disk ID (0x20 bytes used of the sector)
//     +0x00 char[4] initial code — DEZA on the Dezaemon disk
//     +0x04 u8   game version
//     +0x05 u8   disk number
//     +0x06 u8   RAM use (1 when the RAM area is written)
//     +0x07 u8   disk use
//     +0x08 u8[9] unused here
//     +0x11 BCD  year (two bytes), month, day, hour, minute, second
//     +0x18 char[2] company code
//     +0x1A char[6] free area — ATNFS0 on the Dezaemon disk
//
// What the Dezaemon prototype's own system area holds, recovered from the
// canonical deza1.NDD and recorded on static/dezaemon-parity-n64.html: region
// Japan, format 0x10, disk type 0, disk ID DEZA, 1998-02-23 19:24:25, ATNFS0
// in the free area — and ROM-end / RAM-start / RAM-end fields that are filler
// (1016 / 1C22 / 282E, past the last LBA), so the cartridge cannot be
// reading them. This file writes the true values instead, because an
// emulator's D64 path does read them. The IPL fields describe the boot
// program the prototype carries (168,992 bytes loaded to 0x80000400: nine
// blocks, which is why the first file starts at LBA 9); they are kept even on
// a disk built without that program, since the cartridge never runs it.
//
// Environment-neutral ESM (Node + browser).

import {
    DISK_TYPE_COUNT,
    isNddSize,
    lbaToOffset,
    MAX_USER_LBA,
    ramEndLba,
    ramStartLba,
    romEndLba,
    SECTORS_PER_BLOCK,
    SYSTEM_AREA_BYTES,
    SYSTEM_AREA_LBAS,
    ZONE_SECTOR_SIZES,
} from "./geometry.js";

export const REGION_JAPAN = 0xe848d316;
export const REGION_USA = 0x2263ee56;
export const REGION_DEVELOPMENT = 0;

/** The format byte of a retail-format disk, and the retail bit of the type byte. */
export const FORMAT_RETAIL = 0x10;

/** Bytes of a system data record; the rest of its sector is zero. */
export const SYSTEM_DATA_BYTES = 0xe8;

/** Bytes of a disk ID record. */
export const DISK_ID_BYTES = 0x20;

/** System-area sector size: the outermost zone's. Development system data uses zone 3's. */
export const SYSTEM_SECTOR_BYTES = ZONE_SECTOR_SIZES[0];
export const SYSTEM_SECTOR_BYTES_DEV = ZONE_SECTOR_SIZES[3];

/** The blocks that carry the system data, retail and development, and the disk ID. */
export const SYSTEM_DATA_LBAS = Object.freeze([0, 1, 8, 9]);
export const SYSTEM_DATA_LBAS_DEV = Object.freeze([2, 3, 10, 11]);
export const DISK_ID_LBAS = Object.freeze([14, 15]);

/** A system block is 85 sectors of the outermost zone's size, whatever it holds. */
export const SYSTEM_BLOCK_BYTES = SECTORS_PER_BLOCK * SYSTEM_SECTOR_BYTES;

/** The IPL fields of the Dezaemon prototype: its boot program's nine blocks at 0x80000400. */
export const DEZAEMON_IPL_BLOCKS = 9;
export const DEZAEMON_IPL_ADDRESS = 0x80000400;

/** What the Dezaemon disk's ID says about itself. */
export const DEZAEMON_INITIAL_CODE = "DEZA";
export const DEZAEMON_FREE_AREA = "ATNFS0";

function u16(bytes, at) {
    return (bytes[at] << 8) | bytes[at + 1];
}
function u32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}
function putU16(bytes, at, v) {
    bytes[at] = (v >> 8) & 0xff;
    bytes[at + 1] = v & 0xff;
}
function putU32(bytes, at, v) {
    bytes[at] = (v >>> 24) & 0xff;
    bytes[at + 1] = (v >>> 16) & 0xff;
    bytes[at + 2] = (v >>> 8) & 0xff;
    bytes[at + 3] = v & 0xff;
}
function bcd(n) {
    return ((Math.floor(n / 10) % 10) << 4) | (n % 10);
}
function unbcd(b) {
    return (b >> 4) * 10 + (b & 0x0f);
}
function ascii(bytes, at, len) {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i]);
    return s;
}
function putAscii(bytes, at, len, text, what) {
    const s = String(text ?? "");
    if (s.length > len) throw new Error(`${what} is at most ${len} characters; "${s}" is ${s.length}`);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0x7e) throw new Error(`${what} is ASCII; "${s[i]}" is not`);
        bytes[at + i] = c;
    }
}

/**
 * @typedef {object} SystemData
 * @property {number} region
 * @property {number} format
 * @property {boolean} retail
 * @property {number} diskType
 * @property {number} iplLoadBlocks
 * @property {number} iplLoadAddress
 * @property {number[]} defectOffsets   sixteen cumulative counts
 * @property {number[]} defectTracks    the 192-byte table
 * @property {number} romEndLba
 * @property {number} ramStartLba       0xFFFF when there is no RAM area
 * @property {number} ramEndLba
 */

/**
 * One system data record, 0xE8 bytes. Every field has the Dezaemon disk's
 * value as its default except the three area LBAs, which default to the
 * true ones for the disk type.
 * @param {Partial<SystemData>} [fields]
 * @returns {Uint8Array}
 */
export function encodeSystemData(fields = {}) {
    const diskType = fields.diskType ?? 0;
    if (!Number.isInteger(diskType) || diskType < 0 || diskType >= DISK_TYPE_COUNT) {
        throw new Error(`disk type ${diskType} is not one of 0..${DISK_TYPE_COUNT - 1}`);
    }
    const retail = fields.retail ?? true;
    const out = new Uint8Array(SYSTEM_DATA_BYTES);
    putU32(out, 0x00, fields.region ?? REGION_JAPAN);
    out[0x04] = fields.format ?? (retail ? FORMAT_RETAIL : 0);
    out[0x05] = (retail ? FORMAT_RETAIL : 0) | diskType;
    const blocks = fields.iplLoadBlocks ?? DEZAEMON_IPL_BLOCKS;
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_USER_LBA) {
        throw new Error(`the IPL load size is 1..${MAX_USER_LBA} blocks; ${blocks} is not (an emulator refuses 0)`);
    }
    putU16(out, 0x06, blocks);
    const address = fields.iplLoadAddress ?? DEZAEMON_IPL_ADDRESS;
    if (!Number.isInteger(address) || address < 0x80000000 || address >= 0x80800000) {
        throw new Error(`the IPL load address is 0x80000000..0x807FFFFF; 0x${(address >>> 0).toString(16)} is not`);
    }
    putU32(out, 0x1c, address);
    const offsets = fields.defectOffsets ?? [];
    for (let i = 0; i < 16; i++) out[0x08 + i] = (offsets[i] ?? 0) & 0xff;
    const tracks = fields.defectTracks ?? [];
    for (let i = 0; i < 192; i++) out[0x20 + i] = (tracks[i] ?? 0) & 0xff;
    const ramStart = ramStartLba(diskType);
    putU16(out, 0xe0, fields.romEndLba ?? romEndLba(diskType));
    putU16(out, 0xe2, fields.ramStartLba ?? (ramStart === null ? 0xffff : ramStart));
    putU16(out, 0xe4, fields.ramEndLba ?? (ramStart === null ? 0xffff : ramEndLba(diskType)));
    return out;
}

/**
 * The fields of a system data record, read without judgement — see
 * checkSystemData() for what an emulator insists on.
 * @param {Uint8Array} bytes  at least 0xE8 bytes
 * @returns {SystemData}
 */
export function decodeSystemData(bytes) {
    if (bytes.length < SYSTEM_DATA_BYTES) throw new Error(`a system data record is ${SYSTEM_DATA_BYTES} bytes`);
    return {
        region: u32(bytes, 0x00),
        format: bytes[0x04],
        retail: (bytes[0x05] & FORMAT_RETAIL) !== 0,
        diskType: bytes[0x05] & 0x0f,
        iplLoadBlocks: u16(bytes, 0x06),
        iplLoadAddress: u32(bytes, 0x1c),
        defectOffsets: Array.from(bytes.subarray(0x08, 0x18)),
        defectTracks: Array.from(bytes.subarray(0x20, 0xe0)),
        romEndLba: u16(bytes, 0xe0),
        ramStartLba: u16(bytes, 0xe2),
        ramEndLba: u16(bytes, 0xe4),
    };
}

/**
 * The checks mupen64plus-core makes on a system data record before it mounts
 * the disk (scan_and_expand_disk_format): a known region, a disk type 0-6,
 * an IPL load size that is neither zero nor past the disk, and a load
 * address in the first 8 MB of KSEG0. Returns the reasons it would refuse.
 * @param {SystemData} sys
 * @returns {string[]}
 */
export function checkSystemData(sys) {
    const problems = [];
    if (![REGION_JAPAN, REGION_USA, REGION_DEVELOPMENT].includes(sys.region)) {
        problems.push(`region 0x${sys.region.toString(16)} is not Japan, USA or development`);
    }
    if (sys.diskType >= DISK_TYPE_COUNT) problems.push(`disk type ${sys.diskType} is past 6`);
    if (sys.iplLoadBlocks === 0 || sys.iplLoadBlocks > MAX_USER_LBA) {
        problems.push(`IPL load size ${sys.iplLoadBlocks} is zero or past the disk`);
    }
    if (sys.iplLoadAddress < 0x80000000 || sys.iplLoadAddress >= 0x80800000) {
        problems.push(`IPL load address 0x${sys.iplLoadAddress.toString(16)} is outside 0x80000000..0x807FFFFF`);
    }
    return problems;
}

/**
 * @typedef {object} DiskId
 * @property {string} initialCode   four characters
 * @property {number} version
 * @property {number} diskNumber
 * @property {number} ramUse
 * @property {number} diskUse
 * @property {Date|null} date       the manufacture timestamp, local time
 * @property {string} companyCode   two characters
 * @property {string} freeArea      six characters
 */

/**
 * One disk ID record, 0x20 bytes. Defaults are the Dezaemon disk's where the
 * prototype's are known (DEZA, RAM in use, ATNFS0); the company code is not
 * recorded anywhere this repo can read and defaults to two NULs.
 * @param {Partial<DiskId>} [fields]
 * @returns {Uint8Array}
 */
export function encodeDiskId(fields = {}) {
    const out = new Uint8Array(DISK_ID_BYTES);
    const code = fields.initialCode ?? DEZAEMON_INITIAL_CODE;
    if (String(code).length !== 4) throw new Error(`an initial code is four characters; "${code}" is not`);
    putAscii(out, 0x00, 4, code, "the initial code");
    out[0x04] = (fields.version ?? 0) & 0xff;
    out[0x05] = (fields.diskNumber ?? 0) & 0xff;
    out[0x06] = (fields.ramUse ?? 1) & 0xff;
    out[0x07] = (fields.diskUse ?? 0) & 0xff;
    const date = fields.date === undefined ? new Date() : fields.date;
    if (date) {
        const year = date.getFullYear();
        out[0x11] = bcd(Math.floor(year / 100));
        out[0x12] = bcd(year % 100);
        out[0x13] = bcd(date.getMonth() + 1);
        out[0x14] = bcd(date.getDate());
        out[0x15] = bcd(date.getHours());
        out[0x16] = bcd(date.getMinutes());
        out[0x17] = bcd(date.getSeconds());
    }
    putAscii(out, 0x18, 2, fields.companyCode ?? "", "the company code");
    putAscii(out, 0x1a, 6, fields.freeArea ?? DEZAEMON_FREE_AREA, "the free area");
    return out;
}

/**
 * The fields of a disk ID record. A timestamp that is not BCD reads as null.
 * @param {Uint8Array} bytes  at least 0x20 bytes
 * @returns {DiskId}
 */
export function decodeDiskId(bytes) {
    if (bytes.length < DISK_ID_BYTES) throw new Error(`a disk ID record is ${DISK_ID_BYTES} bytes`);
    const digits = Array.from(bytes.subarray(0x11, 0x18));
    const isBcd = digits.every((b) => (b & 0x0f) <= 9 && (b >> 4) <= 9);
    let date = null;
    if (isBcd && digits.some((b) => b !== 0)) {
        const [c, y, mo, d, h, mi, s] = digits.map(unbcd);
        date = new Date(c * 100 + y, mo - 1, d, h, mi, s);
    }
    return {
        initialCode: ascii(bytes, 0x00, 4),
        version: bytes[0x04],
        diskNumber: bytes[0x05],
        ramUse: bytes[0x06],
        diskUse: bytes[0x07],
        date,
        companyCode: ascii(bytes, 0x18, 2),
        freeArea: ascii(bytes, 0x1a, 6),
    };
}

/**
 * The timestamp bytes of a disk ID as text, "1998-02-23 19:24:25", or null.
 * @param {Uint8Array} bytes
 */
export function diskIdDateText(bytes) {
    const digits = Array.from(bytes.subarray(0x11, 0x18)).map((b) => b.toString(16).padStart(2, "0"));
    if (digits.every((d) => d === "00")) return null;
    return `${digits[0]}${digits[1]}-${digits[2]}-${digits[3]} ${digits[4]}:${digits[5]}:${digits[6]}`;
}

function fillBlock(area, lba, sector, sectorBytes) {
    const base = lba * SYSTEM_BLOCK_BYTES;
    for (let s = 0; s < SECTORS_PER_BLOCK; s++) area.set(sector.subarray(0, sectorBytes), base + s * sectorBytes);
}

/**
 * A whole system area, 473,280 bytes: the system data in LBA 0, 1, 8 and 9
 * and the disk ID in LBA 14 and 15, each sector of each block a copy of the
 * record; everything else zero. `systemData` and `diskId` are either the
 * encoded records or the fields to encode them from.
 * @param {{systemData?: Uint8Array | Partial<SystemData>, diskId?: Uint8Array | Partial<DiskId>}} [options]
 * @returns {Uint8Array}
 */
export function buildSystemArea({ systemData, diskId } = {}) {
    const sys = systemData instanceof Uint8Array ? systemData : encodeSystemData(systemData);
    const id = diskId instanceof Uint8Array ? diskId : encodeDiskId(diskId);
    const sysSector = new Uint8Array(SYSTEM_SECTOR_BYTES);
    sysSector.set(sys.subarray(0, Math.min(sys.length, SYSTEM_SECTOR_BYTES)));
    const idSector = new Uint8Array(SYSTEM_SECTOR_BYTES);
    idSector.set(id.subarray(0, Math.min(id.length, SYSTEM_SECTOR_BYTES)));
    const area = new Uint8Array(SYSTEM_AREA_BYTES);
    for (const lba of SYSTEM_DATA_LBAS) fillBlock(area, lba, sysSector, SYSTEM_SECTOR_BYTES);
    for (const lba of DISK_ID_LBAS) fillBlock(area, lba, idSector, SYSTEM_SECTOR_BYTES);
    return area;
}

function sectorsRepeat(area, lba, sectorBytes) {
    const base = lba * SYSTEM_BLOCK_BYTES;
    for (let s = 1; s < SECTORS_PER_BLOCK; s++) {
        for (let i = 0; i < sectorBytes; i++) {
            if (area[base + i] !== area[base + s * sectorBytes + i]) return false;
        }
    }
    return true;
}

/**
 * Read a system area the way an emulator does: the first of LBA 0, 1, 2, 3,
 * 8, 9, 10, 11 holding a record checkSystemData() accepts whose 85 sectors
 * all agree, then the first of LBA 14, 15 whose sectors agree, as the disk
 * ID. Takes a whole .ndd or a bare system area; never throws on content.
 * @param {Uint8Array} image
 * @returns {{systemData: SystemData|null, systemLba: number|null, development: boolean,
 *            diskId: DiskId|null, diskIdLba: number|null, errors: string[]}}
 */
export function readSystemArea(image) {
    const area = isNddSize(image.length) ? image.subarray(0, SYSTEM_AREA_BYTES) : image;
    const result = { systemData: null, systemLba: null, development: false, diskId: null, diskIdLba: null, errors: [] };
    if (area.length < SYSTEM_AREA_BYTES) {
        result.errors.push(`a system area is ${SYSTEM_AREA_BYTES} bytes; this is ${area.length}`);
        return result;
    }
    for (const lba of [0, 1, 2, 3, 8, 9, 10, 11]) {
        const dev = SYSTEM_DATA_LBAS_DEV.includes(lba);
        const sys = decodeSystemData(area.subarray(lba * SYSTEM_BLOCK_BYTES, lba * SYSTEM_BLOCK_BYTES + SYSTEM_DATA_BYTES));
        if (checkSystemData(sys).length) continue;
        if (!sectorsRepeat(area, lba, dev ? SYSTEM_SECTOR_BYTES_DEV : SYSTEM_SECTOR_BYTES)) continue;
        result.systemData = sys;
        result.systemLba = lba;
        result.development = dev;
        break;
    }
    if (result.systemData === null) result.errors.push("no system data block an emulator would accept in LBA 0-3 or 8-11");
    for (const lba of DISK_ID_LBAS) {
        if (!sectorsRepeat(area, lba, SYSTEM_SECTOR_BYTES)) continue;
        result.diskId = decodeDiskId(area.subarray(lba * SYSTEM_BLOCK_BYTES, lba * SYSTEM_BLOCK_BYTES + DISK_ID_BYTES));
        result.diskIdLba = lba;
        break;
    }
    if (result.diskId === null) result.errors.push("no disk ID block whose sectors agree in LBA 14 or 15");
    return result;
}

/** Byte offset of a system-area LBA within an .ndd (they are all outermost-zone blocks). */
export function systemLbaToOffset(lba) {
    if (!Number.isInteger(lba) || lba < 0 || lba >= SYSTEM_AREA_LBAS) return null;
    return lba * SYSTEM_BLOCK_BYTES;
}

/** Byte offset of a USER LBA within an .ndd: the system area, then the .ddd offset. */
export function nddLbaToOffset(lba, type = 0) {
    const at = lbaToOffset(lba, type);
    return at === null ? null : SYSTEM_AREA_BYTES + at;
}
