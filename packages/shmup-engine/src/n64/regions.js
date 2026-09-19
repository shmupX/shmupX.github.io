// The map of a Dezaemon 3D 64DD data disk, as dumped to .ddd.
//
// The disk is dev-fixtures/dezaemon298.ddd: the user data area of a 64DD disk,
// the Dezaemon DD prototype data disk written 1998-02-23 from a Partner-N64
// unit for an expansion that was never released. It is not a ROM, and it does
// nothing without the DEZA64 cartridge — it says so itself, in romaji, inside
// the boot program.
//
// `confidence` is ours:
//   confirmed — the bytes decode as the label says and a fixture test locks it
//   likely    — the stride/shape matches the label; the semantics are unverified
//   open      — only the label is known
//
// Offsets are absolute image offsets; `end` is exclusive. Environment-neutral
// ESM (Node + browser).

import { DDD_IMAGE_BYTES } from "./geometry.js";

function region(name, label, offset, end, confidence, note) {
    return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}

export const N64_REGIONS = Object.freeze([
    region("boot", "IPL PROGRAM", 0x00000000, 0x00029420, "confirmed",
        "A complete libultra executable, load address 0x80000400, entry 0x80000560. The entry stub's bzero loop gives the BSS bounds (t0 = 0x80029820, length 0x48180) and the 0xFF filler begins on exactly the byte BSS starts, which pins both the load address and the image end. Holds ~3.9 KB of 64DD block-mode driver (ASIC registers 0x05000508/0x05000510, sector buffer 0x05000000) and the romaji 'KONO DISK WA DEZA64 DATA DISK DESU' notice at 0x28E80. It contains no filesystem code at all: no filename constant, no DEZA3D, no extension table, and all 274 'jr ra' instructions in the whole 64 MB fall inside it. The filesystem lives on the cartridge."),
    region("bootPad", "IPL PAD", 0x00029420, 0x0002B548, "open",
        "Between the end of the program image and the first file at LBA 9. Not read by anything here."),
    region("files", "SAMPLE FILES", 0x0002B548, 0x006C7188, "confirmed",
        "The 60 LZSS streams of the two pressed sample projects, laid end to end in directory order with no padding between them. Every one extracts, and 58 of the 60 decompress to exactly the size the published format documentation predicts."),
    region("blank", "UNWRITTEN", 0x006C7188, 0x018CA9C8, "confirmed",
        "18,888,768 bytes of 0xFF: unwritten media, not corruption, and the only 0xFF run of any size in the image. The ROM area ends flush against it — the last sample file's extent ends at 0x6C7187."),
    region("saveArea", "SAVE AREA", 0x018CA9C8, DDD_IMAGE_BYTES, "likely",
        "The writable half of the disk: the read-only directory and its two backup copies, the writable directory with its allocation map, and the DST user project. Note that 64dd.org labels this dump the old one — it differs from the current deza1.NDD in 175,897 bytes, every one of them inside this region. Read DST from deza1.NDD, not from this fixture."),
]);

/** The regions by short name: REGION.files.offset, REGION.blank.end, … */
export const REGION = Object.freeze(Object.fromEntries(N64_REGIONS.map((r) => [r.name, r])));

export const CONFIDENCES = Object.freeze(["confirmed", "likely", "open"]);

/** The region containing an image offset, or null. */
export function regionFor(offset) {
    for (const r of N64_REGIONS) if (offset >= r.offset && offset < r.end) return r;
    return null;
}

/**
 * How completely a region list tiles [0, size): the gaps between regions and
 * any overlaps, so a wrong edit to the table shows up in a test rather than as
 * a silently skipped range.
 */
export function coverage(regions = N64_REGIONS, size = DDD_IMAGE_BYTES) {
    const sorted = [...regions].sort((a, b) => a.offset - b.offset);
    const gaps = [];
    const overlaps = [];
    let at = 0;
    for (const r of sorted) {
        if (r.offset > at) gaps.push({ offset: at, end: r.offset });
        else if (r.offset < at) overlaps.push({ name: r.name, offset: r.offset, end: Math.min(at, r.end) });
        at = Math.max(at, r.end);
    }
    if (at < size) gaps.push({ offset: at, end: size });
    return { covered: gaps.length === 0 && overlaps.length === 0 && at >= size, gaps, overlaps, end: at };
}

function entropyOf(bytes) {
    if (!bytes.length) return 0;
    const hist = new Uint32Array(256);
    for (let i = 0; i < bytes.length; i++) hist[bytes[i]]++;
    let e = 0;
    for (let i = 0; i < 256; i++) {
        if (!hist[i]) continue;
        const p = hist[i] / bytes.length;
        e -= p * Math.log2(p);
    }
    return e;
}

/**
 * Per-region byte statistics — Shannon entropy in bits per byte, the share of
 * 0x00 and 0xFF bytes, and whether the image even reaches the region. The
 * save area reads at 6-7 bits per byte because it is LZSS output, not because
 * it is encrypted.
 */
export function regionStats(bytes, regions = N64_REGIONS) {
    return regions.map((r) => {
        const present = bytes.length >= r.end;
        const slice = bytes.subarray(r.offset, Math.min(r.end, bytes.length));
        let zeros = 0, ffs = 0;
        for (let i = 0; i < slice.length; i++) {
            if (slice[i] === 0) zeros++;
            else if (slice[i] === 0xff) ffs++;
        }
        return {
            name: r.name,
            label: r.label,
            offset: r.offset,
            end: r.end,
            length: r.length,
            confidence: r.confidence,
            present,
            entropy: entropyOf(slice),
            zeroRatio: slice.length ? zeros / slice.length : 1,
            ffRatio: slice.length ? ffs / slice.length : 0,
            blank: slice.length > 0 && ffs === slice.length,
        };
    });
}
