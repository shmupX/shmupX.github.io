// Dezaemon 3D on the Nintendo 64: reading a 64DD data disk (.ddd).
//
// The front door. parseDddImage() gives the regions, the ATNFS directory and
// the invariants that directory is meant to satisfy; extractFile() gives one
// file's bytes, decompressed. Nothing here throws on content: a stage that
// fails lands in `errors` and the rest still decodes.
//
// The read path is three layers and each is short. The container is published
// 64DD geometry (geometry.js). The filesystem is Athena's ATNFS, five parallel
// arrays rather than packed records (directory.js). The payloads are Okumura
// LZSS — this repo's own src/decompress.js, unmodified, the same codec the
// PlayStation Dezaemons use.
//
// One trap is worth stating where a caller will see it. The LZSS decoder
// cannot fail: hand it noise and it returns noise, at length. It is evidence
// only when the caller slices the stream to the directory's stored length AND
// the output length matches something predicted. There is no length prefix on
// these streams, so extractFile() always does both and reports `sizeOk`.
//
// Environment-neutral ESM (Node + browser).

import { decompress } from "../decompress.js";
import { DDD_IMAGE_BYTES, isDddSize } from "./geometry.js";
import { byProject, checkDirectory, readDirectory } from "./directory.js";
import { N64_REGIONS, regionStats } from "./regions.js";

export * from "./geometry.js";
export * from "./directory.js";
export * from "./graphics.js";
export * from "./regions.js";

function attempt(result, block, fn) {
    try {
        result[block] = fn();
    } catch (err) {
        result[block] = null;
        result.errors.push({ block, message: err.message });
    }
}

/**
 * Whether these bytes look like a Dezaemon 3D 64DD data disk: the exact size
 * of a system-area-less 64DD dump, and the boot program's own notice where the
 * IPL puts it.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isDddImage(bytes) {
    if (!isDddSize(bytes.length)) return false;
    const mark = "DEZA64 DATA DISK";
    for (let at = 0x28000; at < 0x2a000 - mark.length; at++) {
        let hit = true;
        for (let i = 0; i < mark.length; i++) {
            if (bytes[at + i] !== mark.charCodeAt(i)) { hit = false; break; }
        }
        if (hit) return true;
    }
    return false;
}

/**
 * @typedef {object} DddImage
 * @property {number} size
 * @property {boolean} sizeOk        exactly a 64DD disk minus the system area
 * @property {boolean} recognised    the boot program's DEZA64 notice is present
 * @property {typeof N64_REGIONS} regions
 * @property {ReturnType<typeof readDirectory> | null} directory
 * @property {ReturnType<typeof checkDirectory> | null} invariants
 * @property {ReturnType<typeof regionStats> | null} stats
 * @property {Record<string, string>} confidence
 * @property {{block: string, message: string}[]} errors
 */

/**
 * Read a .ddd image structurally. Never throws on content.
 * @param {Uint8Array} bytes  a whole .ddd image
 * @param {{stats?: boolean}} [options]  stats walk all 64 MB; off by default
 * @returns {DddImage}
 */
export function parseDddImage(bytes, { stats = false } = {}) {
    const result = {
        size: bytes.length,
        sizeOk: isDddSize(bytes.length),
        recognised: false,
        regions: N64_REGIONS,
        directory: null,
        invariants: null,
        stats: null,
        confidence: {},
        errors: [],
    };
    attempt(result, "recognised", () => isDddImage(bytes));
    attempt(result, "directory", () => readDirectory(bytes));
    if (result.directory) {
        attempt(result, "invariants", () => checkDirectory(result.directory));
    }
    if (stats) attempt(result, "stats", () => regionStats(bytes));
    for (const r of N64_REGIONS) result.confidence[r.name] = r.confidence;
    return result;
}

/**
 * One file's bytes, decompressed. The stored length comes from the directory
 * and the result is checked against what the format documentation predicts,
 * because the codec itself will not tell you when it is wrong.
 * @param {Uint8Array} bytes  a whole .ddd image
 * @param {import("./directory.js").DddEntry} entry
 * @returns {{data: Uint8Array, sizeOk: boolean, expected: number|null}}
 */
export function extractFile(bytes, entry) {
    if (entry.offset === null) throw new Error(`${entry.name}.${entry.ext} starts at LBA ${entry.startLba}, which is past the mapped range`);
    const end = entry.offset + entry.storedSize;
    if (end > bytes.length) throw new Error(`${entry.name}.${entry.ext} runs to 0x${end.toString(16)}, past the end of a ${bytes.length}-byte image`);
    const data = Uint8Array.from(decompress(bytes.subarray(entry.offset, end)));
    return {
        data,
        expected: entry.documentedSize,
        sizeOk: entry.documentedSize === null ? false : data.length === entry.documentedSize,
    };
}

/**
 * A one-screen account of an image, for the probe report.
 * @param {DddImage} parsed
 * @returns {string}
 */
export function summarizeDddImage(parsed) {
    const lines = [];
    lines.push(`size ${parsed.size} bytes${parsed.sizeOk ? "" : ` (expected ${DDD_IMAGE_BYTES})`}`);
    lines.push(`DEZA64 data disk: ${parsed.recognised ? "yes" : "no"}`);
    if (parsed.directory) {
        const projects = [...byProject(parsed.directory).entries()];
        lines.push(`directory: ${parsed.directory.length} files in ${projects.length} projects`);
        for (const [name, files] of projects) lines.push(`  ${name.padEnd(8)} ${files.length} files`);
    }
    const inv = parsed.invariants;
    if (inv) {
        lines.push(`contiguous: ${inv.contiguous}  blocksFit: ${inv.blocksFit}  withinCapacity: ${inv.withinCapacity}`);
        if (inv.end !== null) lines.push(`last file ends at 0x${inv.end.toString(16).toUpperCase()}`);
    }
    for (const e of parsed.errors) lines.push(`error in ${e.block}: ${e.message}`);
    return lines.join("\n");
}
