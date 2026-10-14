// Writing a Dezaemon 3D 64DD data disk: the ROM area's files and the ATNFS
// directory over them, on a disk that already exists or on a new one.
//
// What a disk holds, in the order the bytes go (geometry.js, directory.js):
//
//   LBA 0..8        the boot program — the "insert the DEZA64 cartridge"
//                   screen on the prototype — and the pad after it
//   LBA 9..         the files, one LZSS stream each, laid end to end in
//                   directory order with no padding between them, then 0xFF
//                   (unwritten media) up to the directory's block
//   LBA 1417        the last ROM block: 834 bytes, then the read-only
//                   directory (five parallel arrays of 834 slots)
//   LBA 1418..4291  the RAM area: the writable directory with its allocation
//                   map and the cartridge's own files (DEZA3D.SYS, DEZA3D.HSC,
//                   the user projects it saves), plus two more copies of the
//                   read-only directory at 834 bytes into LBA 1419 and 1422
//
// This module writes the files, the three directory copies, the 0xFF run and
// — on a disk built from nothing — the boot program's notice. It writes
// NOTHING ELSE: the RAM area of a base disk is carried byte for byte, because
// the writable directory's layout is only partly known (the allocation map,
// fragmentation; static/dezaemon-parity-n64.html section 03) and there is no
// checksum to tell a wrong guess from a right one. A project on the disk this
// writes is a pressed one, beside the two samples, not a saved one.
//
// Every disk is read back through readDirectory()/checkDirectory() and every
// new file decompressed and compared before it is returned: the reader this
// repo already trusts is the judge of the writer.
//
// Environment-neutral ESM (Node + browser); no I/O.

import { compress } from "../compress.js";
import { decompress } from "../decompress.js";
import {
    DDD_IMAGE_BYTES,
    DEZAEMON_DISK_TYPE,
    isDddSize,
    isNddSize,
    lbaToOffset,
    nddFromDdd,
    NDD_IMAGE_BYTES,
    romEndLba,
    systemAreaOf,
    userArea,
} from "./geometry.js";
import {
    checkDirectory,
    DIRECTORY_IN_BLOCK_OFFSET,
    DIRECTORY_LBA,
    directoryOffsets,
    extOrder,
    FIRST_FILE_LBA,
    layoutFiles,
    normalizeProjectName,
    readDirectory,
    writeDirectory,
} from "./directory.js";
import { buildSystemArea } from "./system-area.js";

/** Where the boot program keeps its notice, and what it says — see index.js isDddImage(). */
export const DEZA64_NOTICE_OFFSET = 0x28e80;
export const DEZA64_NOTICE = Object.freeze([
    "KONO DISK WA DEZA64 DATA DISK DESU",
    "ICHIDO DENGEN WO KIRI DEZA64 NO",
    "ROMCARTRIDGE WO SOUNYUUSHITE",
    "DENGEN WO IRENAOSHITE KUDASAI",
]);

/** What unwritten media reads as. */
export const BLANK_BYTE = 0xff;

/** The two image formats this writes. */
export const DISK_FORMATS = Object.freeze(["ddd", "ndd"]);

/**
 * @typedef {object} ProjectFile
 * @property {string} ext        three characters, e.g. "CGR" or "0GR"
 * @property {Uint8Array} data   the file's bytes, decompressed
 */

/**
 * @typedef {object} Project
 * @property {string} name        1..8 letters and digits (normalizeProjectName)
 * @property {ProjectFile[]} files
 */

/** The format of an image by its length, or null. */
export function imageFormat(image) {
    if (isNddSize(image.length)) return "ndd";
    if (isDddSize(image.length)) return "ddd";
    return null;
}

/**
 * The boot program's notice, as four NUL-terminated lines at 0x28E80. The
 * prototype's exact separators were not recorded; the words are its own and
 * the first of them is what isDddImage() looks for.
 * @param {Uint8Array} user  a .ddd
 */
export function writeNotice(user) {
    let at = DEZA64_NOTICE_OFFSET;
    for (const line of DEZA64_NOTICE) {
        for (let i = 0; i < line.length; i++) user[at++] = line.charCodeAt(i);
        user[at++] = 0;
    }
}

/**
 * The projects a disk holds, each file as a VIEW of its compressed stream.
 * Throws when the directory contradicts the geometry, since a disk whose
 * directory cannot be trusted cannot be re-laid either.
 * @param {Uint8Array} image  a .ddd or .ndd
 * @returns {{name: string, files: {ext: string, stream: Uint8Array, storedSize: number, startLba: number, blockCount: number}[]}[]}
 */
export function readProjects(image) {
    const user = userArea(image);
    const entries = readDirectory(user);
    const inv = checkDirectory(entries);
    if (entries.length && (!inv.blocksFit || !inv.withinCapacity)) {
        throw new Error("the disk's directory does not agree with the 64DD geometry; refusing to rewrite it");
    }
    const projects = new Map();
    for (const e of entries) {
        if (e.offset === null) throw new Error(`${e.name}.${e.ext} starts at LBA ${e.startLba}, off the disk`);
        if (e.offset + e.storedSize > user.length) throw new Error(`${e.name}.${e.ext} runs past the end of the image`);
        if (!projects.has(e.name)) projects.set(e.name, { name: e.name, files: [] });
        projects.get(e.name).files.push({
            ext: e.ext,
            stream: user.subarray(e.offset, e.offset + e.storedSize),
            storedSize: e.storedSize,
            startLba: e.startLba,
            blockCount: e.blockCount,
        });
    }
    return [...projects.values()];
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * A project's files compressed, in directory order (the six globals, then
 * BL, MD, GR per stage; an extension the format does not name sorts last, in
 * the order given). Duplicate extensions throw.
 * @param {Project} project
 * @returns {{name: string, ext: string, raw: Uint8Array, stream: Uint8Array}[]}
 */
export function packProject(project) {
    const name = normalizeProjectName(project.name);
    const files = (project.files || []).map((f, i) => {
        const ext = String(f.ext || "").toUpperCase();
        if (ext.length !== 3) throw new Error(`${name}: "${f.ext}" is not a three-character extension`);
        if (!(f.data instanceof Uint8Array) || !f.data.length) throw new Error(`${name}.${ext}: a file is a non-empty Uint8Array`);
        return { ext, data: f.data, i };
    });
    if (!files.length) throw new Error(`${name}: a project has at least one file`);
    const seen = new Set();
    for (const f of files) {
        if (seen.has(f.ext)) throw new Error(`${name}: ${f.ext} is given twice`);
        seen.add(f.ext);
    }
    files.sort((a, b) => (extOrder(a.ext) - extOrder(b.ext)) || (a.i - b.i));
    return files.map((f) => ({ name, ext: f.ext, raw: f.data, stream: compress(f.data) }));
}

/**
 * @typedef {object} BuildDiskOptions
 * @property {Uint8Array|null} [base]      a .ddd or .ndd to start from; omitted, a disk is built from nothing
 * @property {Project[]} [projects]        projects to write; one named like a project on the base replaces it
 * @property {string[]} [remove]           projects on the base to drop
 * @property {"ddd"|"ndd"|null} [format]   the image to return; omitted, the base's, else "ddd"
 * @property {Uint8Array|null} [systemArea] for an .ndd: the 473,280 bytes to put first; omitted, the base's, else buildSystemArea()
 * @property {Uint8Array|null} [boot]      for a disk built from nothing: the boot program (at most nine blocks)
 * @property {number} [type]               disk type; 0 is the Dezaemon disk's and the only one with a measured directory
 */

/**
 * Build a disk: the given projects laid out from LBA 9 beside those the base
 * already has (byte for byte, their streams untouched — nothing is
 * recompressed), the directory written three times, and the RAM area of the
 * base carried verbatim. Read back before it is returned.
 *
 * Returns {image, format, directory, report, warnings}: the image, which
 * format it is, the directory as the reader read it back, a report whose
 * shape is the literal at the end of this function, and warnings.
 *
 * @param {BuildDiskOptions} [options]
 */
export function buildDisk(options = {}) {
    const { base = null, projects = [], remove = [], boot = null, type = DEZAEMON_DISK_TYPE } = options;
    const warnings = [];
    if (type !== DEZAEMON_DISK_TYPE) {
        warnings.push(`disk type ${type}: only type 0's directory block has been measured; the directory is written where type 0 keeps it`);
    }
    let baseFormat = null;
    if (base !== null) {
        baseFormat = imageFormat(base);
        if (!baseFormat) throw new Error(`a base disk is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${base.length}`);
    }
    const format = options.format ?? baseFormat ?? "ddd";
    if (!DISK_FORMATS.includes(format)) throw new Error(`format is "ddd" or "ndd", not "${format}"`);

    // --- what goes on the disk, in order ---
    const dropped = new Set(remove.map((n) => normalizeProjectName(n)));
    const fresh = new Map();
    for (const p of projects) {
        const packed = packProject(p);
        const name = packed[0].name;
        if (fresh.has(name)) throw new Error(`project ${name} is given twice`);
        fresh.set(name, packed);
    }
    const laid = []; // {name, ext, stream, raw|null, kept}
    const order = []; // project names in directory order
    const kept = [];
    const baseUser = base === null ? null : userArea(base);
    if (baseUser !== null) {
        for (const p of readProjects(baseUser)) {
            if (dropped.has(p.name)) continue;
            if (fresh.has(p.name)) {
                order.push(p.name);
                continue;
            }
            order.push(p.name);
            kept.push(p.name);
            for (const f of p.files) laid.push({ name: p.name, ext: f.ext, stream: f.stream, raw: null, kept: true });
        }
    }
    for (const name of fresh.keys()) if (!order.includes(name)) order.push(name);
    const byName = new Map(order.map((n) => [n, []]));
    for (const f of laid) byName.get(f.name).push(f);
    for (const [name, packed] of fresh) byName.set(name, packed.map((f) => ({ ...f, kept: false })));
    const files = order.flatMap((n) => byName.get(n));
    for (const name of dropped) {
        if (baseUser === null || !readProjects(baseUser).some((p) => p.name === name)) warnings.push(`${name} is not on the disk, so there was nothing to remove`);
    }

    // --- the layout ---
    const entries = layoutFiles(files.map((f) => ({ name: f.name, ext: f.ext, storedSize: f.stream.length })), { type });

    // --- the bytes ---
    const user = new Uint8Array(DDD_IMAGE_BYTES);
    const firstFile = lbaToOffset(FIRST_FILE_LBA, type);
    const directoryBlock = lbaToOffset(DIRECTORY_LBA, type);
    if (baseUser !== null) {
        user.set(baseUser);
    } else {
        if (boot) {
            if (!(boot instanceof Uint8Array) || boot.length > firstFile) throw new Error(`a boot program is at most ${firstFile} bytes (nine blocks); this one is ${boot ? boot.length : "not bytes"}`);
            user.set(boot, 0);
        } else {
            writeNotice(user);
        }
    }
    user.fill(BLANK_BYTE, firstFile, directoryBlock);
    entries.forEach((e, i) => user.set(files[i].stream, e.offset));
    const directoryBytes = writeDirectory(user, entries, type);

    // --- read back: the reader is the judge ---
    const back = readDirectory(user);
    if (back.length !== entries.length) throw new Error(`the directory read back with ${back.length} files, not ${entries.length}`);
    back.forEach((b, i) => {
        const e = entries[i];
        if (b.name !== e.name || b.ext !== e.ext || b.startLba !== e.startLba || b.blockCount !== e.blockCount || b.storedSize !== e.storedSize) {
            throw new Error(`${e.name}.${e.ext} read back differently from the directory it was written to`);
        }
    });
    const inv = checkDirectory(back);
    if (back.length && !(inv.contiguous && inv.blocksFit && inv.withinCapacity)) {
        throw new Error("the directory this wrote fails its own invariants (contiguous, blocksFit, withinCapacity)");
    }
    back.forEach((b, i) => {
        const f = files[i];
        const stream = user.subarray(b.offset, b.offset + b.storedSize);
        if (!sameBytes(stream, f.stream)) throw new Error(`${b.name}.${b.ext}: the stream on the disk is not the one written`);
        if (f.raw) {
            const out = decompress(stream);
            if (!sameBytes(out, f.raw)) throw new Error(`${b.name}.${b.ext}: does not decompress to the bytes given`);
        }
    });
    for (const at of directoryOffsets(type)) {
        if (!sameBytes(user.subarray(at, at + directoryBytes.length), directoryBytes)) throw new Error(`the directory copy at 0x${at.toString(16)} did not land`);
    }

    // --- the image ---
    let image = user;
    if (format === "ndd") {
        const systemArea = options.systemArea ?? (baseFormat === "ndd" ? systemAreaOf(base) : buildSystemArea({ systemData: { diskType: type }, diskId: { diskType: type } }));
        image = nddFromDdd(user, systemArea);
    }

    const last = entries[entries.length - 1];
    const nextLba = last ? last.startLba + last.blockCount : FIRST_FILE_LBA;
    const report = {
        format,
        type,
        base: baseFormat,
        projects: order.map((name) => {
            const own = entries.filter((e) => e.name === name);
            return {
                name,
                kept: kept.includes(name),
                files: own.map((e) => {
                    const f = files[entries.indexOf(e)];
                    return {
                        ext: e.ext,
                        raw: f.raw ? f.raw.length : null,
                        stored: e.storedSize,
                        startLba: e.startLba,
                        blockCount: e.blockCount,
                        ratio: f.raw ? Number((e.storedSize / f.raw.length).toFixed(3)) : null,
                    };
                }),
                stored: own.reduce((a, e) => a + e.storedSize, 0),
                firstLba: own.length ? own[0].startLba : null,
                blockCount: own.reduce((a, e) => a + e.blockCount, 0),
            };
        }),
        removed: [...dropped],
        files: entries.length,
        firstLba: FIRST_FILE_LBA,
        nextLba,
        romEnd: last ? last.offset + last.storedSize : firstFile,
        romBytes: directoryBlock - firstFile,
        romFree: directoryBlock - lbaToOffset(nextLba, type),
        directoryLba: DIRECTORY_LBA,
        directoryOffsets: directoryOffsets(type),
        romEndLba: romEndLba(type),
    };
    return { image, format, directory: back, report, warnings };
}

/**
 * One project onto a disk, replacing a project of the same name.
 * @param {Uint8Array} image  a .ddd or .ndd
 * @param {Project} project
 * @param {Omit<BuildDiskOptions, "base"|"projects">} [options]
 */
export function putProject(image, project, options = {}) {
    return buildDisk({ ...options, base: image, projects: [project] });
}

/**
 * A disk less one project.
 * @param {Uint8Array} image  a .ddd or .ndd
 * @param {string} name
 * @param {Omit<BuildDiskOptions, "base"|"remove">} [options]
 */
export function removeProject(image, name, options = {}) {
    return buildDisk({ ...options, base: image, remove: [name] });
}

/**
 * The same disk in the other format: an .ndd from a .ddd (with the given or
 * a built system area) or a .ddd from an .ndd. Nothing in the user area is
 * touched.
 * @param {Uint8Array} image
 * @param {"ddd"|"ndd"} format
 * @param {{systemArea?: Uint8Array, type?: number}} [options]
 * @returns {Uint8Array}
 */
export function convertDisk(image, format, { systemArea, type = DEZAEMON_DISK_TYPE } = {}) {
    const have = imageFormat(image);
    if (!have) throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
    if (format === "ddd") return userArea(image).slice();
    if (format !== "ndd") throw new Error(`format is "ddd" or "ndd", not "${format}"`);
    return nddFromDdd(image, systemArea ?? (have === "ndd" ? systemAreaOf(image) : buildSystemArea({ systemData: { diskType: type }, diskId: { diskType: type } })));
}

/** Where the read-only directory's block begins, for a probe to name. */
export function directoryBlockOffset(type = DEZAEMON_DISK_TYPE) {
    return lbaToOffset(DIRECTORY_LBA, type);
}

/** How far into that block the arrays start. */
export const DIRECTORY_BLOCK_LEAD = DIRECTORY_IN_BLOCK_OFFSET;
