// The Super Famicom Dezaemon (SHVC-66, Athena 1994) battery-SRAM map.
//
// The cart carries 128 KB of SRAM: four 32 KB segments the LoROM mapping
// exposes in banks $70-$73, dumped by emulators and flash carts as one raw,
// headerless, little-endian 131,072-byte file. The ROM documents the layout
// itself — at ROM offset 0x66A5 a debug table ("ADDRESS       NAME") lists
// every region as "XXXXX-XXXXX   NAME" (rom.js parseRomRegionTable reads it) —
// and SFC_REGIONS below is that table verbatim, spelling included ("SCROLL
// EFECT", "GRAPIC DATA"), with our own confidence and observations attached.
//
// `confidence` is ours, not the ROM's:
//   confirmed — the bytes decode as the label says and a fixture test locks it
//   likely    — the stride/shape matches the label; the semantics are unverified
//   open      — only the label is known
//
// Offsets are absolute SRAM offsets; `end` is exclusive (the ROM prints
// inclusive last bytes). Environment-neutral ESM (Node + browser).

function region(name, label, offset, end, confidence, note) {
    return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}

export const SFC_REGIONS = Object.freeze([
    region("checksum", "CHECK SUM", 0x00000, 0x00020, "open",
        "16 words, copied verbatim at 0x7E5A. Algorithm unknown; word 0 read big-endian equals the 16-bit word sum of PALETTE DATA in the sample (a lead, not proof)."),
    region("reserved0", "RESERVED", 0x00020, 0x00040, "confirmed",
        "Zero apart from the word 0x3160 at 0x3E in the sample."),
    region("palette", "PALETTE DATA", 0x00040, 0x00340, "confirmed",
        "24 rows of 16 BGR555 little-endian words. Rows 0-21 are colour (bit 15 clear); rows 0x100-0x180 are five identical default rows in the sample. Rows 22-23 (0x300-0x33F) look like the editor's own R/G/B ramps and primaries and each ends in a bit-15 word — open."),
    region("map", "MAP DATA", 0x00340, 0x03940, "likely",
        "6 stages x 0x900 bytes of 8-bit chip indices into MAP GROUP, 18 columns x 128 rows (vertical continuity beats every non-multiple width in all six sample stages; its multiple 36 edges it by 0.002 in stage 4; columns 16-17 are sparse everywhere and may be per-row markers); bit 7 is set on some cells."),
    region("scroll", "SCROLL EFECT", 0x03940, 0x04540, "likely",
        "6 x 0x200 bytes by size. The sample opens with 0x100 bytes of small integers, then smooth curves around 0x40 padded with 0x1F/0x1D recur every 0x200 from +0x100; per-stage scroll tables, layout open."),
    region("mapGroup", "MAP GROUP", 0x04540, 0x04B40, "likely",
        "192 chips x 4 SNES tilemap words, free-form tile picks (tiles 0x2C0-0x373 in the sample); 0xFFFF and 0x03FF mean an empty slot, and 119 of the sample's chips are wholly empty, only 4 classifying as 2x2 chips."),
    region("myShipOdr", "MY SHIP ODR", 0x04B40, 0x04B80, "likely",
        "16 x 4-byte 8-bit tile quads; all zero in the sample."),
    region("enemyGroup", "ENEMY GROUP", 0x04B80, 0x04E80, "likely",
        "24 enemies x 32 bytes = 4 quads of tilemap words; the sample draws mostly on tiles 0x360-0x3FB, a few from 0x200 and 0x2B8."),
    region("bossGroup", "BOSS GROUP", 0x04E80, 0x05000, "likely",
        "6 bosses x 64 bytes = 8 quads; 16 of the sample's 48 are symmetric strips [n, n+1, n+1|H, n|H], the rest neither strip nor chip."),
    region("titleGroup", "TITLE GROUP", 0x05000, 0x05040, "likely",
        "8 quads of tilemap words (tiles 0x2A0-0x2BF in the sample)."),
    region("endingGroup", "ENDING GROUP", 0x05040, 0x05058, "likely",
        "3 quads; all empty in the sample."),
    region("sound", "SOUND DATA", 0x05058, 0x07E58, "open",
        "11,776 bytes of high-entropy bit-packed data. The composer holds 16 bars at 1/16 quantise, two voices; layout open."),
    region("titleType", "TITLE TYPE", 0x07E58, 0x07E5A, "confirmed", "u16; 0x020A in the sample."),
    region("checksumCopy", "CHECK SUM COPY", 0x07E5A, 0x07E7A, "confirmed", "Byte-identical to CHECK SUM."),
    region("mouseSpeed", "MOUSE SPEED", 0x07E7A, 0x07E7C, "confirmed",
        "u16. The cart supports the SNES Mouse; the anti-piracy SRAM-size probe writes $707E7B."),
    region("editBgm", "EDIT BGM", 0x07E7C, 0x07E7E, "confirmed", "u16."),
    region("bgmPatch", "BGM PATCH", 0x07E7E, 0x07E8E, "confirmed", "16 bytes, one instrument per BGM slot."),
    region("hiScore", "HIGH SCORE", 0x07E8E, 0x07FCE, "confirmed",
        "20 entries x 16 bytes: u32 score, 4 bytes, char[8] name — two tables of ten. The sample holds the factory ladder 1000..100 twice, with '........' names."),
    region("keyConfig", "KEY CONFIG", 0x07FCE, 0x07FD2, "confirmed", "4 bytes; 20 08 10 20 in the sample."),
    region("reserved1", "RESERVED", 0x07FD2, 0x07FF8, "confirmed", "38 bytes, 20 of them 0xFF in the sample."),
    region("checkString", "CHECK STRINGS", 0x07FF8, 0x08000, "confirmed",
        "ASCII 'T.TABATA' — the programmer's initials (ROM credits: TSUTOMU TABATA 94/01/27), used as the formatted-SRAM magic."),
    region("enemyData", "ENEMY DATA", 0x08000, 0x08C00, "likely", "24 records x 128 bytes."),
    region("appear", "APPEAR DATA", 0x08C00, 0x0F800, "likely",
        "6 stages x 0x1200 bytes of enemy appearance tables; each starts with 14 zero bytes then 14 x 0xFF in the sample."),
    region("enemyOdr", "ENEMY ODR", 0x0F800, 0x0FF80, "likely", "24 enemies x 80 bytes = 20 x 4-byte 8-bit tile quads."),
    region("myShipGroup", "MY SHIP GROUP", 0x0FF80, 0x10000, "likely",
        "16 quads of tilemap words (tiles 0x200-0x23C in the sample); 5 classify as 2x2 chips [n, n+1, n+8, n+9], the rest as neither shape."),
    region("graphics", "GRAPIC DATA", 0x10000, 0x20000, "open",
        "2,048 x 4bpp planar 8x8 tiles by size. All zero in the sample dump, so the bank layout (tile number -> offset) is unverified."),
]);

/** The regions by short name: REGION.palette.offset, REGION.hiScore.end, … */
export const REGION = Object.freeze(Object.fromEntries(SFC_REGIONS.map((r) => [r.name, r])));

export const CONFIDENCES = Object.freeze(["confirmed", "likely", "open"]);

/** The region containing an SRAM offset, or null. */
export function regionFor(offset) {
    for (const r of SFC_REGIONS) if (offset >= r.offset && offset < r.end) return r;
    return null;
}

/**
 * How completely a region list tiles [0, size): the gaps between regions and
 * any overlaps, so a wrong edit to the table shows up in a test rather than
 * as a silently skipped range.
 */
export function coverage(regions = SFC_REGIONS, size = 0x20000) {
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
 * Per-region byte statistics of a save — the shape of each range, for the
 * probe report and for eyeballing an unfamiliar dump: Shannon entropy in
 * bits per byte, the share of 0x00 and 0xFF bytes, and whether the file even
 * reaches the region (64 KB dumps stop before GRAPIC DATA).
 */
export function regionStats(bytes, regions = SFC_REGIONS) {
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
            blank: slice.length > 0 && zeros === slice.length,
        };
    });
}
