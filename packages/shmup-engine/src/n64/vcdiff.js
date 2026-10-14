// VCDIFF (RFC 3284) as xdelta3 writes it: parse a patch, dry-run it, apply
// it to a source — so the English translation of Dezaemon 3D, shipped as
// static/n64dd/dezaemon-3d-usa-2024.09.12.xdelta, can be applied to the
// Japanese ROM in Deno and in a browser, with no xdelta3 binary.
//
// What the format is (RFC 3284, sections 4-7, and draft-korn-vcdiff.txt in
// xdelta3's tree): a header, then windows. Each window names a SEGMENT of the
// source (or of the target decoded so far) and carries three sections —
// data for ADDs and RUNs, instruction codes with their sizes, and COPY
// addresses — that the standard code table (section 7: 256 entries, each
// one or two of RUN / ADD / COPY in nine address modes) is read against.
// Addresses live in one space: [0, segment length) is the segment, from
// there on the window's own output, so a COPY can repeat what it just wrote.
// Modes 0 and 1 are absolute and "here"-relative; 2-5 add to one of four
// recent addresses; 6-8 pick one of 768 by a single byte (the near and same
// caches, reset per window). Integers are base 128, high bit first, with bit
// 7 as the continuation bit.
//
// What xdelta3 adds to it (xdelta3.h, xdelta3-decode.h, xdelta3-second.h,
// xdelta3-lzma.h, read from github.com/jmacd/xdelta), all of which the
// translation patch uses:
//   - hdr_indicator bit 2 (VCD_APPHEADER): an integer length and an
//     application header after the secondary compressor id; the patch's is
//     the author's two file paths, 125 bytes;
//   - win_indicator bit 2 (VCD_ADLER32): four big-endian bytes right after
//     the three section lengths, the Adler-32 of the window's output;
//   - secondary compressor id 2 is liblzma. A compressed section is stored
//     as an integer (its decoded length, never 0) followed by the compressed
//     bytes, and the three section types each continue ONE liblzma stream
//     through the whole patch (see xz.js for why that matters). The ids 1
//     (DJW) and 16 (FGK) are refused here, as is a custom code table; xdelta3
//     writes neither by default and the patch has neither.
//   - xdelta3 itself does not decode VCD_TARGET windows ("not implemented");
//     this reader does, as the RFC describes them, untested against anything
//     because nothing writes them.
//
// Measured on the patch (parseVcdiff, and an independent Python walker over
// liblzma, kept outside the repo, which agrees): 2 windows of 8,388,608
// target bytes each, both
// VCD_SOURCE | VCD_ADLER32 with every section compressed (del_indicator 7);
// window 0 reads source [0, 16,256,035), window 1 [470,487, 16,719,088), so
// a 16 MiB .z64 of the Japanese ROM covers both and `sourceLengthNeeded` is
// 16,719,088. Confidence: confirmed for the structure (two independent
// parsers consume every section exactly and land on the target length);
// the apply itself is confirmed only against hand-made patches, because no
// ROM is in this checkout — the Adler-32 of each window is the check that
// will tell a user whether their ROM was the right one.
//
// Environment-neutral ESM (Node + browser).

import { XzDecoder } from "./xz.js";

const VCDIFF_MAGIC = [0xd6, 0xc3, 0xc4, 0x00];

/** hdr_indicator bits. */
export const VCD_DECOMPRESS = 0x01;
export const VCD_CODETABLE = 0x02;
export const VCD_APPHEADER = 0x04; // xdelta3

/** win_indicator bits. */
export const VCD_SOURCE = 0x01;
export const VCD_TARGET = 0x02;
export const VCD_ADLER32 = 0x04; // xdelta3

/** del_indicator bits: which sections are secondary-compressed. */
export const VCD_DATACOMP = 0x01;
export const VCD_INSTCOMP = 0x02;
export const VCD_ADDRCOMP = 0x04;

/** xdelta3's secondary compressor ids (not IANA-assigned). */
export const VCD_SECONDARY_NAMES = Object.freeze({ 1: "DJW", 2: "LZMA", 16: "FGK" });

const NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
const NEAR_SLOTS = 4;
const SAME_SLOTS = 3;

/**
 * The standard code table of RFC 3284 section 7 as 256 x [type1, size1,
 * mode1, type2, size2, mode2]; a size of 0 means "read it from the
 * instruction stream". Checked against xdelta3's xd3_choose_instruction,
 * which hard-codes the same indexes (1 + size for ADD, 19 + 16 x mode for
 * COPY, 163.. and 235.. for the pairs, 247 + mode for COPY-then-ADD).
 */
export const VCDIFF_CODE_TABLE = (() => {
    const table = [];
    const put = (t1, s1, m1, t2 = NOOP, s2 = 0, m2 = 0) => table.push(Object.freeze([t1, s1, m1, t2, s2, m2]));
    put(RUN, 0, 0);
    for (let size = 0; size <= 17; size++) put(ADD, size, 0);
    for (let mode = 0; mode < 9; mode++) {
        put(COPY, 0, mode);
        for (let size = 4; size <= 18; size++) put(COPY, size, mode);
    }
    for (let mode = 0; mode < 9; mode++) {
        for (let addSize = 1; addSize <= 4; addSize++) {
            const copySizes = mode < 6 ? [4, 5, 6] : [4];
            for (const copySize of copySizes) put(ADD, addSize, 0, COPY, copySize, mode);
        }
    }
    for (let mode = 0; mode < 9; mode++) put(COPY, 4, mode, ADD, 1, 0);
    if (table.length !== 256) throw new Error(`code table has ${table.length} entries`);
    return Object.freeze(table);
})();

/**
 * Adler-32 of a byte range, as zlib and xdelta3 compute it.
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number} unsigned
 */
export function adler32(bytes, start = 0, end = bytes.length) {
    let a = 1, b = 0;
    let at = start;
    while (at < end) {
        // 5552 is the most bytes before b can overflow 32 bits; well within a double.
        const stop = Math.min(end, at + 5552);
        for (; at < stop; at++) {
            a += bytes[at];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function hex8(n) {
    return n.toString(16).padStart(8, "0");
}

/** A bounds-checked reader over the patch, with VCDIFF integers. */
class Reader {
    constructor(bytes, at = 0, end = bytes.length, what = "patch") {
        this.bytes = bytes;
        this.at = at;
        this.end = end;
        this.what = what;
    }

    byte(field) {
        if (this.at >= this.end) throw new Error(`${this.what} ends at byte ${this.at}, inside ${field}`);
        return this.bytes[this.at++];
    }

    int(field) {
        let value = 0;
        for (let i = 0; i < 9; i++) {
            const b = this.byte(field);
            value = value * 128 + (b & 0x7f);
            if ((b & 0x80) === 0) return value;
        }
        throw new Error(`${this.what}: ${field} is an integer longer than 9 bytes`);
    }

    take(count, field) {
        if (this.at + count > this.end) throw new Error(`${this.what} ends at byte ${this.end}, inside ${field} (${count} bytes from ${this.at})`);
        const slice = this.bytes.subarray(this.at, this.at + count);
        this.at += count;
        return slice;
    }
}

/**
 * @typedef {object} VcdiffSection
 * @property {number} offset       where the section starts in the patch
 * @property {number} length       its stored length
 * @property {boolean} compressed  del_indicator says it is secondary-compressed
 * @property {number} decodedLength  what it decodes to (the stored length when not compressed)
 * @property {number} payloadOffset  the compressed bytes (after the length integer), or `offset`
 */

/**
 * @typedef {object} VcdiffWindow
 * @property {number} index
 * @property {number} offset           where the window starts in the patch
 * @property {number} winIndicator
 * @property {{from: "source"|"target", position: number, length: number}|null} segment
 * @property {number} deltaLength
 * @property {number} targetLength     bytes this window produces
 * @property {number} targetOffset     where they land in the target
 * @property {number} deltaIndicator
 * @property {number|null} adler32     of the window's output, when VCD_ADLER32 is set
 * @property {VcdiffSection} data
 * @property {VcdiffSection} inst
 * @property {VcdiffSection} addr
 */

/**
 * @typedef {object} VcdiffPatch
 * @property {number} hdrIndicator
 * @property {number|null} secondaryId    xdelta3's compressor id, when VCD_DECOMPRESS
 * @property {string|null} secondaryName
 * @property {Uint8Array|null} appHeader
 * @property {string|null} appHeaderText  the app header as Latin-1 text
 * @property {VcdiffWindow[]} windows
 * @property {number} targetLength        the sum of the windows
 * @property {number} sourceLengthNeeded  one past the last source byte any window reads
 * @property {boolean} usesSource
 * @property {boolean} usesTarget
 */

/**
 * Read a patch's header and every window header, without decompressing or
 * decoding anything. Throws on a malformed patch and on the xdelta3 features
 * this reader does not implement (custom code tables, DJW and FGK).
 * @param {Uint8Array} patch
 * @returns {VcdiffPatch}
 */
export function parseVcdiff(patch) {
    const r = new Reader(patch);
    for (let i = 0; i < 4; i++) {
        if (r.byte("the magic") !== VCDIFF_MAGIC[i]) throw new Error("not a VCDIFF patch (bad magic)");
    }
    const hdrIndicator = r.byte("hdr_indicator");
    if (hdrIndicator & ~(VCD_DECOMPRESS | VCD_CODETABLE | VCD_APPHEADER)) {
        throw new Error(`hdr_indicator 0x${hdrIndicator.toString(16)} has reserved bits set`);
    }
    let secondaryId = null;
    if (hdrIndicator & VCD_DECOMPRESS) {
        secondaryId = r.byte("the secondary compressor id");
        if (secondaryId !== 2) {
            const name = VCD_SECONDARY_NAMES[secondaryId] || "unknown";
            throw new Error(`secondary compressor ${secondaryId} (${name}) is not supported; only xdelta3's LZMA (2) is`);
        }
    }
    if (hdrIndicator & VCD_CODETABLE) {
        throw new Error("the patch carries a custom code table, which is not supported (xdelta3 never writes one)");
    }
    let appHeader = null;
    if (hdrIndicator & VCD_APPHEADER) {
        const length = r.int("the application header length");
        appHeader = r.take(length, "the application header");
    }

    const windows = [];
    let targetLength = 0;
    let sourceLengthNeeded = 0;
    let usesSource = false, usesTarget = false;
    while (r.at < r.end) {
        const index = windows.length;
        const w = new Reader(patch, r.at, r.end, `window ${index}`);
        const offset = w.at;
        const winIndicator = w.byte("win_indicator");
        if (winIndicator & ~(VCD_SOURCE | VCD_TARGET | VCD_ADLER32)) {
            throw new Error(`window ${index}: win_indicator 0x${winIndicator.toString(16)} has reserved bits set`);
        }
        if ((winIndicator & VCD_SOURCE) && (winIndicator & VCD_TARGET)) {
            throw new Error(`window ${index}: both VCD_SOURCE and VCD_TARGET are set`);
        }
        let segment = null;
        if (winIndicator & (VCD_SOURCE | VCD_TARGET)) {
            const length = w.int("the segment length");
            const position = w.int("the segment position");
            segment = { from: (winIndicator & VCD_SOURCE) ? "source" : "target", position, length };
        }
        const deltaLength = w.int("the delta encoding length");
        const deltaStart = w.at;
        const windowTarget = w.int("the target window length");
        const deltaIndicator = w.byte("del_indicator");
        if (deltaIndicator & ~(VCD_DATACOMP | VCD_INSTCOMP | VCD_ADDRCOMP)) {
            throw new Error(`window ${index}: del_indicator 0x${deltaIndicator.toString(16)} has reserved bits set`);
        }
        if (deltaIndicator !== 0 && secondaryId === null) {
            throw new Error(`window ${index}: sections are marked compressed but the header names no secondary compressor`);
        }
        const dataLength = w.int("the data section length");
        const instLength = w.int("the instruction section length");
        const addrLength = w.int("the address section length");
        let checksum = null;
        if (winIndicator & VCD_ADLER32) {
            const b = w.take(4, "the Adler-32");
            checksum = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        }
        const section = (name, length, bit) => {
            const compressed = (deltaIndicator & bit) !== 0;
            const start = w.at;
            const bytes = w.take(length, `the ${name} section`);
            if (!compressed) return { offset: start, length, compressed, decodedLength: length, payloadOffset: start };
            const s = new Reader(bytes, 0, bytes.length, `window ${index}'s ${name} section`);
            const decodedLength = s.int("the decoded length");
            if (decodedLength === 0) throw new Error(`window ${index}: the ${name} section decodes to 0 bytes`);
            return { offset: start, length, compressed, decodedLength, payloadOffset: start + s.at };
        };
        const data = section("data", dataLength, VCD_DATACOMP);
        const inst = section("inst", instLength, VCD_INSTCOMP);
        const addr = section("addr", addrLength, VCD_ADDRCOMP);
        if (w.at - deltaStart !== deltaLength) {
            throw new Error(`window ${index}: the delta encoding length says ${deltaLength} bytes, the sections add up to ${w.at - deltaStart}`);
        }
        if (segment) {
            if (segment.from === "source") {
                usesSource = true;
                sourceLengthNeeded = Math.max(sourceLengthNeeded, segment.position + segment.length);
            } else {
                usesTarget = true;
                if (segment.position + segment.length > targetLength) {
                    throw new Error(`window ${index}: its target segment [${segment.position}, ${segment.position + segment.length}) is not decoded yet`);
                }
            }
        }
        windows.push({
            index,
            offset,
            winIndicator,
            segment,
            deltaLength,
            targetLength: windowTarget,
            targetOffset: targetLength,
            deltaIndicator,
            adler32: checksum,
            data,
            inst,
            addr,
        });
        targetLength += windowTarget;
        r.at = w.at;
    }

    return {
        hdrIndicator,
        secondaryId,
        secondaryName: secondaryId === null ? null : VCD_SECONDARY_NAMES[secondaryId],
        appHeader,
        appHeaderText: appHeader ? String.fromCharCode(...appHeader) : null,
        windows,
        targetLength,
        sourceLengthNeeded,
        usesSource,
        usesTarget,
    };
}

/**
 * The three section types each continue one secondary stream through the
 * patch; this holds the three decoders between windows.
 */
function makeDecoders() {
    return { data: null, inst: null, addr: null };
}

/** A window's section as plain bytes, decompressing through its type's decoder. */
function sectionBytes(patch, window, name, decoders) {
    const section = window[name];
    if (!section.compressed) return patch.subarray(section.offset, section.offset + section.length);
    if (!decoders[name]) decoders[name] = new XzDecoder();
    const decoder = decoders[name];
    const out = decoder.decode(patch.subarray(section.payloadOffset, section.offset + section.length));
    if (decoder.pendingLength !== 0) {
        throw new Error(`window ${window.index}: the ${name} section ends inside a compressed unit`);
    }
    if (out.length !== section.decodedLength) {
        throw new Error(`window ${window.index}: the ${name} section decoded to ${out.length} bytes, not the ${section.decodedLength} it declares`);
    }
    return out;
}

/**
 * Decode one window's instruction stream, handing each instruction to the
 * sink, with the address cache and every bounds check xdelta3's decoder
 * makes. Returns what it counted.
 *
 * sink.add(data, from, size) / sink.run(byte, size) / sink.copy(address,
 * size, fromSegment) are called with the window's output position in
 * sink.position (the sink keeps it); copy's address is relative to the
 * segment when fromSegment, else to the window's output.
 */
function walkWindow(window, data, inst, addr, sink) {
    const segmentLength = window.segment ? window.segment.length : 0;
    const targetLength = window.targetLength;
    const instReader = new Reader(inst, 0, inst.length, `window ${window.index}'s instruction section`);
    const addrReader = new Reader(addr, 0, addr.length, `window ${window.index}'s address section`);
    const near = new Array(NEAR_SLOTS).fill(0);
    const same = new Array(SAME_SLOTS * 256).fill(0);
    let nextNear = 0;
    let dataAt = 0;
    let out = 0;
    const counts = { instructions: 0, add: 0, run: 0, copySource: 0, copyTarget: 0, addBytes: 0, runBytes: 0, copySourceBytes: 0, copyTargetBytes: 0, sourceLow: Infinity, sourceHigh: 0 };

    const decodeAddress = (mode, here) => {
        let address;
        if (mode === 0) {
            address = addrReader.int("an address");
        } else if (mode === 1) {
            address = here - addrReader.int("an address");
        } else if (mode < 2 + NEAR_SLOTS) {
            address = near[mode - 2] + addrReader.int("an address");
        } else {
            address = same[(mode - 2 - NEAR_SLOTS) * 256 + addrReader.byte("an address")];
        }
        near[nextNear] = address;
        nextNear = (nextNear + 1) % NEAR_SLOTS;
        same[address % (SAME_SLOTS * 256)] = address;
        return address;
    };

    const run = (type, size, mode) => {
        if (size === 0) size = instReader.int("an instruction size");
        if (out + size > targetLength) {
            throw new Error(`window ${window.index}: an instruction at output byte ${out} runs ${out + size - targetLength} bytes past the window`);
        }
        counts.instructions++;
        if (type === ADD) {
            if (dataAt + size > data.length) throw new Error(`window ${window.index}: ADD at output byte ${out} reads past the data section`);
            sink.add(data, dataAt, size);
            dataAt += size;
            counts.add++;
            counts.addBytes += size;
        } else if (type === RUN) {
            if (dataAt >= data.length) throw new Error(`window ${window.index}: RUN at output byte ${out} reads past the data section`);
            sink.run(data[dataAt++], size);
            counts.run++;
            counts.runBytes += size;
        } else {
            const here = segmentLength + out;
            const address = decodeAddress(mode, here);
            if (address >= here) {
                throw new Error(`window ${window.index}: COPY at output byte ${out} reads address ${address}, which is not written yet`);
            }
            if (address < segmentLength) {
                if (address + size > segmentLength) {
                    throw new Error(`window ${window.index}: COPY at output byte ${out} runs past the ${window.segment.from} segment`);
                }
                sink.copy(address, size, true);
                counts.copySource++;
                counts.copySourceBytes += size;
                const low = window.segment.position + address;
                if (low < counts.sourceLow) counts.sourceLow = low;
                if (low + size > counts.sourceHigh) counts.sourceHigh = low + size;
            } else {
                sink.copy(address - segmentLength, size, false);
                counts.copyTarget++;
                counts.copyTargetBytes += size;
            }
        }
        out += size;
    };

    while (instReader.at < instReader.end) {
        const entry = VCDIFF_CODE_TABLE[instReader.byte("an instruction code")];
        run(entry[0], entry[1], entry[2]);
        if (entry[3] !== NOOP) run(entry[3], entry[4], entry[5]);
    }
    if (out !== targetLength) {
        throw new Error(`window ${window.index}: its instructions produce ${out} bytes, the header says ${targetLength}`);
    }
    if (dataAt !== data.length) {
        throw new Error(`window ${window.index}: ${data.length - dataAt} bytes of the data section are left over`);
    }
    if (addrReader.at !== addrReader.end) {
        throw new Error(`window ${window.index}: ${addrReader.end - addrReader.at} bytes of the address section are left over`);
    }
    if (counts.sourceLow === Infinity) counts.sourceLow = null;
    return counts;
}

/**
 * Apply a patch.
 *
 * The source may be longer than the patch needs (xdelta3 reads only what
 * it addresses); shorter is refused. With verify, every window's Adler-32
 * is checked and a mismatch names the window, which with this patch means
 * the source is not the unmodified Japanese ROM in big-endian (.z64) order.
 *
 * @param {Uint8Array} source
 * @param {Uint8Array} patch
 * @param {{verify?: boolean}} [options]
 * @returns {Uint8Array} the target
 */
export function applyVcdiff(source, patch, { verify = true } = {}) {
    const parsed = parseVcdiff(patch);
    if (parsed.usesSource && source.length < parsed.sourceLengthNeeded) {
        throw new Error(`the source is ${source.length} bytes but the patch reads its first ${parsed.sourceLengthNeeded}`);
    }
    const target = new Uint8Array(parsed.targetLength);
    const decoders = makeDecoders();
    for (const window of parsed.windows) {
        const data = sectionBytes(patch, window, "data", decoders);
        const inst = sectionBytes(patch, window, "inst", decoders);
        const addr = sectionBytes(patch, window, "addr", decoders);
        const out = target.subarray(window.targetOffset, window.targetOffset + window.targetLength);
        let segment = null;
        if (window.segment) {
            const { from, position, length } = window.segment;
            segment = (from === "source" ? source : target).subarray(position, position + length);
        }
        let position = 0;
        walkWindow(window, data, inst, addr, {
            add(bytes, from, size) {
                out.set(bytes.subarray(from, from + size), position);
                position += size;
            },
            run(byte, size) {
                out.fill(byte, position, position + size);
                position += size;
            },
            copy(address, size, fromSegment) {
                if (fromSegment) {
                    out.set(segment.subarray(address, address + size), position);
                } else if (address + size <= position) {
                    out.set(out.subarray(address, address + size), position);
                } else {
                    // Overlapping: repeat what is being written, byte by byte.
                    for (let i = 0; i < size; i++) out[position + i] = out[address + i];
                }
                position += size;
            },
        });
        if (verify && window.adler32 !== null) {
            const got = adler32(out);
            if (got !== window.adler32) {
                throw new Error(
                    `window ${window.index} (target bytes ${window.targetOffset}..${window.targetOffset + window.targetLength}) ` +
                        `checksum mismatch: the patch expects Adler-32 ${hex8(window.adler32)}, the output has ${hex8(got)}; ` +
                        `the source is not the file this patch was made for`,
                );
            }
        }
    }
    return target;
}

/**
 * @typedef {object} VcdiffDryRun
 * @property {number} windows
 * @property {number} targetLength
 * @property {number} sourceLengthNeeded
 * @property {object[]} perWindow  one entry per window: instruction and byte counts by kind, and the
 *   absolute source range [sourceLow, sourceHigh) its COPYs read
 */

/**
 * Run a patch's instruction streams without a source: decompresses every
 * section, decodes every instruction with the same bounds checks the apply
 * makes, and demands that each window consume its sections exactly and
 * produce exactly its stated length. The strongest check available when the
 * source is not at hand; it reports what it counted.
 * @param {Uint8Array} patch
 * @returns {VcdiffDryRun}
 */
export function dryRunVcdiff(patch) {
    const parsed = parseVcdiff(patch);
    const decoders = makeDecoders();
    const perWindow = [];
    for (const window of parsed.windows) {
        const data = sectionBytes(patch, window, "data", decoders);
        const inst = sectionBytes(patch, window, "inst", decoders);
        const addr = sectionBytes(patch, window, "addr", decoders);
        const counts = walkWindow(window, data, inst, addr, { add() {}, run() {}, copy() {} });
        perWindow.push({
            index: window.index,
            targetLength: window.targetLength,
            segment: window.segment,
            sections: { data: data.length, inst: inst.length, addr: addr.length },
            ...counts,
        });
    }
    return {
        windows: parsed.windows.length,
        targetLength: parsed.targetLength,
        sourceLengthNeeded: parsed.sourceLengthNeeded,
        perWindow,
    };
}
