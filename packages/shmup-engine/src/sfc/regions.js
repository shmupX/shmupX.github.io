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
// inclusive last bytes). The notes are the 2026-10-14 ROM trace's
// (FORMAT-SFC.md). Environment-neutral ESM (Node + browser).

function region(name, label, offset, end, confidence, note) {
    return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}

export const SFC_REGIONS = Object.freeze([
    region("checksum", "CHECK SUM", 0x00000, 0x00020, "confirmed",
        "16 words, copied verbatim at 0x7E5A. Traced in the ROM ($00:847B computes, $00:8482 verifies): each word is 0xFFFF minus the mod-2^16 sum of the 16-bit little-endian words over a scatter/gather segment list, the descriptors being a 17-pointer table at $80:8665. Word 15 covers the first fifteen, so the block always totals 0xFFFF. See FORMAT-SFC.md for the segment map."),
    region("reserved0", "RESERVED", 0x00020, 0x00040, "confirmed",
        "Never read by the boot or load paths; zero but for the word 0x3160 at 0x3E in the ROM's default image."),
    region("palette", "PALETTE DATA", 0x00040, 0x00340, "confirmed",
        "24 rows of 16 BGR555 little-endian words. Rows 0-5 colour the stages' scenery, 6-11 their enemies, 12-17 their bosses, 18 the ship, 19 the title and ending, 20 items and weapons, 21 is free; 22-23 are the editor's own colour picker (bit-15 words, never copied to CGRAM)."),
    region("map", "MAP DATA", 0x00340, 0x03940, "confirmed",
        "6 stages x 0x900: 128 rows of 18 bytes, row 0 the stage start. A row is two halves of eight cells and a flag byte: cell bit 7 = H flip, bits 0-6 = MAP GROUP slot; flag bit 7-k = V flip of cell k. 16 chips (256 px) wide, 2,048 px tall ($00:9B9C; rendered)."),
    region("scroll", "SCROLL EFECT", 0x03940, 0x04540, "likely",
        "6 x 0x200: two 256-byte tables, one entry per 8-px band — +0x000 an effect index (cleared to i & 0x1F), +0x100 the band's scroll speed (cleared to 0x42; 0x40 reads as 1 px/frame). The play-time reader is untraced."),
    region("mapGroup", "MAP GROUP", 0x04540, 0x04B40, "confirmed",
        "6 stages x 128 chip words: word k is the chip copied into BG slot k, which a map cell names. 0xFFFF (or 0x03FF) is the blank chip; the editor clears a stage's table to 0xFF with word 0 = 0x03FF."),
    region("myShipOdr", "MY SHIP ODR", 0x04B40, 0x04B80, "confirmed",
        "64 bytes, 56 used: bits 6-7 are the V/H flips of the ship sheet's chips 0-55 ($00:9D8B); zero in both dumps."),
    region("enemyGroup", "ENEMY GROUP", 0x04B80, 0x04E80, "confirmed",
        "6 stages x 64 chip words: the stage's enemy sprite sheet, 8x8 chips, assembled into OBJ names 0x100-0x1FF; ENEMY ODR references its slots. Cleared to 0xFFFF/0x03FF."),
    region("bossGroup", "BOSS GROUP", 0x04E80, 0x05000, "confirmed",
        "6 stages x 32 chip words: the boss as an 8x4-chip BG sheet at tiles 0x20-0x9F. Cleared to 0x03FF."),
    region("titleGroup", "TITLE GROUP", 0x05000, 0x05040, "confirmed",
        "32 chip words: the title picture, assembled like a stage sheet (bits 11-13 masked on save)."),
    region("endingGroup", "ENDING GROUP", 0x05040, 0x05058, "confirmed",
        "12 chip words for the ending screen; 0x03FF when unused."),
    region("sound", "SOUND DATA", 0x05058, 0x07E58, "open",
        "16 songs x 0x2E0 bytes; the editor clears every slot to one ROM block ($80:8E46). The sample's BGM PATCH points at ROM songs, so its stream is never played. The note format is open."),
    region("titleType", "TITLE TYPE", 0x07E58, 0x07E5A, "confirmed",
        "u16: the title animation ($00:B182) — byte 0 bits 0-1 / 2-3 / 4-5 the X, Y and third motion of element 1, byte 1 of element 2; 0x020A in the sample."),
    region("checksumCopy", "CHECK SUM COPY", 0x07E5A, 0x07E7A, "confirmed", "Byte-identical to CHECK SUM."),
    region("mouseSpeed", "MOUSE SPEED", 0x07E7A, 0x07E7C, "confirmed",
        "u16: the low byte is the option; the boot writes its SRAM-size probe into the high byte every start, so only the low byte is the save's."),
    region("editBgm", "EDIT BGM", 0x07E7C, 0x07E7E, "confirmed",
        "u16: the song slot the composer was editing."),
    region("bgmPatch", "BGM PATCH", 0x07E7E, 0x07E8E, "confirmed",
        "16 bytes, each & 0x3F: slots 0-5 stage n's song, 6-11 stage n's boss song, 12 the title, 13-15 ending / clear / game over; 0-15 pick SOUND DATA songs, 0x10 and up the ROM's own."),
    region("hiScore", "HIGH SCORE", 0x07E8E, 0x07FCE, "confirmed",
        "20 entries x 16 bytes: u32 score, 4 bytes (the stage reached, likely), char[8] name — entries 0-9 are the sample game's table, 10-19 the user game's ($05:D087). The factory ladder 1000..100 with '........' names fills both."),
    region("keyConfig", "KEY CONFIG", 0x07FCE, 0x07FD2, "confirmed",
        "Two u16 button assignments ($03:C134); 20 08 10 20 is the default."),
    region("reserved1", "RESERVED", 0x07FD2, 0x07FF8, "confirmed",
        "38 bytes; never read. The ROM's default image leaves 20 of them 0xFF."),
    region("checkString", "CHECK STRINGS", 0x07FF8, 0x08000, "confirmed",
        "ASCII 'T.TABATA' — the programmer's initials (ROM credits: TSUTOMU TABATA 94/01/27), used as the formatted-SRAM magic."),
    region("enemyData", "ENEMY DATA", 0x08000, 0x08C00, "likely",
        "6 stages x 0x200: eight-byte entries in five classes — 0-2 sixteen each at +0/+0x80/+0x100, 3 eight at +0x180, 4 four at +0x1C0 — then a 32-byte boss block at +0x1E0. The entries' bit fields are the editor's ($04:E2F0); what each means to the play engine is read off ranges, not traced."),
    region("appear", "APPEAR DATA", 0x08C00, 0x0F800, "confirmed",
        "6 stages x 0x1200: 256 records of 14 spawn bytes (one per playfield column 1..14: valid bit 7, class bits 4-6, entry bits 0-3), then a 1,024-byte line table — one entry per 2 px of the stage, the record that fires there. Record 0 is empty and record 1 the END code the loader forces."),
    region("enemyOdr", "ENEMY ODR", 0x0F800, 0x0FF80, "confirmed",
        "6 stages x 320 bytes: 80 four-byte quads of slot references ([V][H][row:3][col:3]) into the stage's enemy sheet, 16 quads a class — classes 0-2 one quad (four 16x16 frames) an entry, class 3 two quads (a 32x32 sprite, two frames), class 4 four."),
    region("myShipGroup", "MY SHIP GROUP", 0x0FF80, 0x10000, "confirmed",
        "64 chip words: the ship sheet (8x8 chips) assembled into OBJ names 0x000-0x0FF — poses, shots, weapons, items; slots 61-63 are forced to 0x3FC-0x3FE."),
    region("graphics", "GRAPIC DATA", 0x10000, 0x20000, "confirmed",
        "Two 32 KB sheets of 4bpp tiles, each 16 tiles wide: 32 chip rows of 8 chips, a chip 0x40 bytes with its tiles at +0/+0x20/+0x200/+0x220. A group word's bits 8-10 pick the sheet (0/1 here; 2/3 the ROM's factory art), bits 3-7 the row, 0-2 the column."),
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
