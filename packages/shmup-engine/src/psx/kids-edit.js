// Editing a Dezaemon Kids! save in place — the surgical counterpart to kids.js,
// and the Kids! half of what plus-edit.js does for Dezaemon+.
//
// Not a writer. Nothing here builds a save; everything takes a real 0x1E000
// block that already parses and changes what a field owns.
//
// But Kids! is NOT surgical the way Dezaemon+ is, and that difference is the
// whole design. A Dezaemon+ field sits at a fixed file offset, so an N-byte
// edit reseals to N + 2 bytes (FORMAT-PSX.md, "Editing"). A Kids! save stores
// its graphics and data LZSS-packed (FORMAT-PSX.md, "Compression"), so touching
// one map chip re-encodes 64,712 bytes; and because the sections lie end to end
// on 0x80 sector boundaries, a section that changes size MOVES the ones after
// it and moves half the eleven-word directory at 0x100 with them.
//
// So the contract is not "few bytes move". It is these four:
//
// 1. AN UNTOUCHED SECTION KEEPS ITS ORIGINAL STREAM, copied verbatim.
//    src/compress.js is NOT the game's own encoder. Measured over the 77 real
//    Kids! saves in dev-fixtures/ (the folder holds 97 dumps; 20 of them are
//    Dezaemon+ saves and are told apart by the card directory entry's name,
//    never by the folder): 0 of 77 recompress byte-identically. Mean +796 bytes
//    over the two sections, worst +2,495 ("Sample Blade III (IGK).sav"); per
//    section, graphics comes out -2,483..+2,088 and data +29..+407, so ours is
//    sometimes better and usually worse. Copying an untouched stream verbatim
//    is therefore the ONLY way an edit-nothing round trip comes back
//    byte-identical — the property plus-edit.js established, and the one this
//    module has to match. A section that IS edited necessarily changes bytes;
//    what it must do instead is decompress to exactly the bytes asked for, and
//    editKidsSave() proves that by reading its own output back.
//
// 2. THE SUMS RUN OVER THE SECTOR-PADDED SPAN, not the exact one. Words 4, 6
//    and 8 are byte sums over word 9 / word 10 / 0x100 bytes, and the padding
//    inside a padded span is stale staging-buffer content, not zero: measured
//    here, 68 of the 77 saves have non-zero graphics padding and 64 non-zero
//    data padding. A writer that sums the exact span passes every test in a
//    zeroed buffer — zero padding adds zero — and corrupts the first real save
//    it touches. sealKidsTable() sums the padded span, once, for all three.
//
// 3. IT MUST FIT, and fitting is not a given. The file is 0x1E000 bytes and
//    nothing grows it. Measured: all 77 saves still fit after both sections are
//    re-encoded, but the tightest has 4,224 bytes to spare ("Cronos (Keroyon)
//    (D25).sav", 4,864 before re-encoding) against an encoder that can cost
//    2,495. editKidsSave() refuses with the arithmetic rather than truncating.
//
// 4. EVERYTHING OUTSIDE [0x180, end) IS LEFT ALONE. That is the "SC" title
//    frame and icon at 0x00..0x100, the 84 stale staging bytes at 0x12C..0x180,
//    and whatever the card held past word 0 — non-zero in 71 of the 77 saves,
//    and in some of them the second half of a Dezaemon+ image. Only the eleven
//    directory words are rewritten in between.
//
// Environment-neutral ESM (Node + browser); no async, no I/O.

import { compress } from "../compress.js";
import { decompress } from "../decompress.js";
import { BLOCK_SIZE, blockBytes, CARD_SIZE, isPsvImage, parseMemoryCard, u32le } from "./memcard.js";
import { parseSaveHeader, TITLE_LENGTH, TITLE_OFFSET } from "./save-header.js";
import {
    byteSum,
    isKidsBlock,
    KIDS_ALL_CLEAR,
    KIDS_BLANK,
    KIDS_BLOCK_SIZE,
    KIDS_CELL_ALIGN,
    KIDS_CELL_COUNT,
    KIDS_CELL_MASK,
    KIDS_DATA_SIZE,
    KIDS_FIRST_SECTION,
    KIDS_GRAPHICS_SIZE,
    KIDS_HFLIP,
    KIDS_HISCORE_COUNT,
    KIDS_HISCORE_SIZE,
    KIDS_LEVELS,
    KIDS_MAP_COLUMNS,
    KIDS_MAP_ROWS,
    KIDS_MAP_STAGE_BYTES,
    KIDS_MUTEKI_LEVEL,
    KIDS_PRODUCT,
    KIDS_REGION,
    KIDS_SCROLL_STAGE_BYTES,
    KIDS_SCROLL_UNITS,
    KIDS_SECTOR,
    KIDS_STAGES,
    KIDS_TABLE_OFFSET,
    KIDS_TABLE_WORDS,
    KIDS_TAIL_SIZE,
    KIDS_TITLE_PREFIX,
    KIDS_VFLIP,
    parseKidsTable,
    roundUp,
    validateKidsTable,
} from "./kids.js";

// --- write primitives --------------------------------------------------------

// src/psx/ has readers only (u16le/u32le, memcard.js:62,:66); these are their
// inverses, LITTLE-endian to match, and identical to plus-edit.js:78-86. Not
// DataView.setUint16: its two-argument form writes big-endian and would corrupt
// every directory word silently.

function putU16le(bytes, at, v) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
}

function putU32le(bytes, at, v) {
    putU16le(bytes, at, v & 0xffff);
    putU16le(bytes, at + 2, (v >>> 16) & 0xffff);
}

function hex(n) {
    return "0x" + n.toString(16);
}

// --- shared guards -----------------------------------------------------------

// Setters throw; decoders do not, and that is not a contradiction — the house
// rule "nothing throws on content" governs DECODING untrusted bytes (a corrupt
// save lands in parseKidsSave's `errors` through attempt(), kids.js), never a
// caller's instruction. Rejection, not clamping: a clamp silently substitutes
// a value nobody asked for, which is exactly what makes a surgical tool
// untrustworthy.

function intIn(name, v, lo, hi) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
        throw new Error(`${name} is ${v}; the range is ${lo}..${hi}`);
    }
    return v;
}

function bool(name, v) {
    if (typeof v !== "boolean") throw new Error(`${name} is ${v}; it must be true or false`);
    return v;
}

function bytesOfLength(name, value, length) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${name} must be a Uint8Array of ${length} bytes; got ${typeof value}`);
    }
    if (value.length !== length) {
        throw new Error(`${name} is ${length} bytes; got ${value.length}`);
    }
    return value;
}

/**
 * @param {Uint8Array} block
 * @throws {Error} unless `block` is a byte view of exactly KIDS_BLOCK_SIZE
 */
export function assertKidsBlock(block) {
    if (!(block instanceof Uint8Array)) {
        throw new Error(`a Dezaemon Kids! block must be a Uint8Array; got ${typeof block}`);
    }
    if (block.length !== KIDS_BLOCK_SIZE) {
        throw new Error(`editing needs the whole ${KIDS_BLOCK_SIZE}-byte block; got ${block.length}`);
    }
}

// assertKidsBlock is deliberately stricter than parseKidsTable, which refuses
// NOTHING: it reads eleven words from wherever offset 0x100 happens to land,
// reads past a short buffer as zeros (u32le, memcard.js:66), and REPORTS into
// `problems` instead of throwing — an empty buffer comes back as a table of
// eleven zeros. A caller that never looks at `.consistent` walks on regardless.
//
// What it reads off a misaligned buffer is not a shifted directory. Hand it a
// .psv still wearing its 0x84 header and 0x100 lands on save offset 0x7C: the
// last two CLUT words, then the icon frame (CLUT_OFFSET 0x60, icon 0x80..0x100,
// save-header.js:25). Those bytes are art, not offsets. Measured over all 77
// community saves, which share one icon: 0 come back consistent, every one
// reports the same seven problems, from `graphics offset bb434343 != 0x180`
// down to the bounds check at kids.js:243. Loud here only because that icon
// does not happen to look like a directory — what makes the .psv a non-question
// is its LENGTH, which is this guard. The correct call is
// parseKidsTable(bytes.subarray(0x84, 0x84 + KIDS_BLOCK_SIZE)).

/** The eleven directory words, in order, as a record's `words` names them. */
export const KIDS_TABLE_WORD_NAMES = Object.freeze([
    "end",
    "graphicsSize",
    "dataSize",
    "graphicsOffset",
    "graphicsSum",
    "dataOffset",
    "dataSum",
    "tailOffset",
    "tailSum",
    "graphicsPadded",
    "dataPadded",
]);

// --- 1 the seal --------------------------------------------------------------

/**
 * The eleven words a block's own bytes imply, given the two compressed sizes.
 *
 * Nine of the eleven are pure arithmetic on the two sizes — the layout is
 * fixed: graphics at 0x180, data after it, tail after that, end 0x100 later,
 * each section padded to a 0x80 card sector. The other two inputs are the
 * sizes themselves, and they are the reason this takes an argument at all: an
 * LZSS stream carries no length, so where it ENDS cannot be recovered from the
 * bytes (decompress() stops when its input runs out, decompress.js:27, so a
 * stream followed by its own stale padding decodes to something longer, not to
 * an error). The caller who produced the stream is the only one who knows.
 */
function kidsLayout(graphicsSize, dataSize) {
    const graphicsPadded = roundUp(graphicsSize, KIDS_SECTOR);
    const dataPadded = roundUp(dataSize, KIDS_SECTOR);
    const graphicsOffset = KIDS_FIRST_SECTION;
    const dataOffset = graphicsOffset + graphicsPadded;
    const tailOffset = dataOffset + dataPadded;
    return {
        graphicsSize,
        dataSize,
        graphicsPadded,
        dataPadded,
        graphicsOffset,
        dataOffset,
        tailOffset,
        end: tailOffset + KIDS_TAIL_SIZE,
    };
}

function assertFits(layout, what) {
    if (layout.end <= KIDS_BLOCK_SIZE) return;
    throw new Error(
        `${what} needs ${layout.end} bytes — graphics ${layout.graphicsSize} padded to ${layout.graphicsPadded}, ` +
            `data ${layout.dataSize} padded to ${layout.dataPadded}, a ${KIDS_TAIL_SIZE}-byte tail, all after ` +
            `${hex(KIDS_FIRST_SECTION)} — and a memory-card file holds ${KIDS_BLOCK_SIZE} (${hex(KIDS_BLOCK_SIZE)}); ` +
            `it is ${layout.end - KIDS_BLOCK_SIZE} bytes over`,
    );
}

/**
 * @typedef {object} KidsSeal
 * @property {{index: number, name: string, offset: number, before: number, after: number}[]} words
 *   only the directory words that actually changed, in table order
 * @property {number[]} table        all eleven words as they now stand
 * @property {number} bytes          4 * words.length
 * @property {{graphics: boolean, data: boolean, tail: boolean, ok: boolean}} checksums
 *   read back through validateKidsTable() after writing
 * @property {boolean} consistent    read back through parseKidsTable() after writing
 * @property {number} end
 * @property {number} slack          KIDS_BLOCK_SIZE - end
 */

/**
 * Rewrite the eleven-word directory at 0x100 from the section streams actually
 * present in the block, so an edited block loads. The counterpart of
 * sealPlusChecksums (plus-edit.js:230).
 *
 * THE SUMS RUN OVER THE SECTOR-PADDED SPAN — words 4, 6 and 8 cover
 * `roundUp(size, 0x80)` bytes, not `size` (FORMAT-PSX.md, "Section directory").
 * The padding is stale staging-buffer content and is non-zero in 68 of the 77
 * community saves for graphics and 64 for data, so summing the exact span
 * produces a save the game rejects while every test over a zeroed scratch
 * buffer still passes. This is the single easiest thing in the format to get
 * wrong, and it is why validateKidsTable (kids.js:258) exists to read the
 * answer back rather than be trusted.
 *
 * Idempotent: on a block whose words already agree it writes nothing and
 * reports zero changed words. Unlike the Dezaemon+ seal there is no
 * self-referential word to leave alone — no directory word is summed by any
 * other, because every span starts at 0x180 and the directory sits at 0x100.
 *
 * The block is MUTATED, never copied, for the same reason plus-edit.js:213-218
 * gives: parseKidsSave hands back `tail` as a subarray VIEW of the caller's
 * block (kids.js:731), and a seal that returned a copy would strand it on a
 * stale buffer. A caller who wants a copy writes Uint8Array.from(block) itself.
 *
 * @param {Uint8Array} block  a whole 0x1E000 block, mutated in place
 * @param {{graphics?: number, data?: number}} [sizes]
 *   the EXACT compressed length of each stream now sitting in the block. Both
 *   default to the block's own current words 1 and 2, which is the call to make
 *   after an edit that changed bytes without changing any length.
 * @returns {KidsSeal}
 * @throws {Error} on a wrong-size block, a size that is not a positive integer,
 *   a layout that does not fit, or omitted sizes the current table cannot give
 */
export function sealKidsTable(block, { graphics, data } = {}) {
    assertKidsBlock(block);
    const current = parseKidsTable(block);
    if (graphics === undefined || graphics === null || data === undefined || data === null) {
        // Only the two sizes are taken from the old table, and only when the
        // caller did not supply them — never the offsets or the sums, which are
        // exactly what a seal is for. A table that does not parse cannot supply
        // even that much, and guessing is worse than refusing.
        if (!current.consistent) {
            throw new Error(
                `the block's own directory is inconsistent (${current.problems.join("; ")}), so the omitted ` +
                    `compressed size cannot be read back from it; pass {graphics, data} explicitly`,
            );
        }
        graphics ??= current.sections.graphics.size;
        data ??= current.sections.data.size;
    }
    intIn("graphics compressed size", graphics, 1, KIDS_BLOCK_SIZE);
    intIn("data compressed size", data, 1, KIDS_BLOCK_SIZE);
    const layout = kidsLayout(graphics, data);
    assertFits(layout, "the directory these sizes describe");

    const table = [
        layout.end,
        layout.graphicsSize,
        layout.dataSize,
        layout.graphicsOffset,
        byteSum(block, layout.graphicsOffset, layout.graphicsOffset + layout.graphicsPadded),
        layout.dataOffset,
        byteSum(block, layout.dataOffset, layout.dataOffset + layout.dataPadded),
        layout.tailOffset,
        byteSum(block, layout.tailOffset, layout.end),
        layout.graphicsPadded,
        layout.dataPadded,
    ];
    const words = [];
    for (let i = 0; i < KIDS_TABLE_WORDS; i++) {
        const offset = KIDS_TABLE_OFFSET + i * 4;
        const before = u32le(block, offset);
        const after = table[i] >>> 0;
        if (before === after) continue;
        putU32le(block, offset, after);
        words.push({ index: i, name: KIDS_TABLE_WORD_NAMES[i], offset, before, after });
    }
    // `checksums` and `consistent` are not decoration: buildPayload ends by
    // reading its own output back through parseSectionTable (bup-write.js:100),
    // and these two are the analogue. Reporting only the CHANGED words is what
    // makes the report agree with the bytes (src/write/game-to-save.js:1475-1478).
    const sealed = parseKidsTable(block);
    return {
        words,
        table,
        bytes: words.length * 4,
        checksums: validateKidsTable(block, sealed),
        consistent: sealed.consistent,
        end: layout.end,
        slack: KIDS_BLOCK_SIZE - layout.end,
    };
}

/**
 * The directory words whose stored value disagrees with the block's own bytes —
 * what a seal would fix. Names the state a UI has to show, and keeps callers
 * off parseKidsTable/validateKidsTable for the yes/no question. The parallel of
 * plusUnsealedGroups (plus-edit.js:293).
 *
 * Uses the block's own words 1 and 2 as the compressed sizes, so it answers
 * "are the derived words right for the sizes this file claims", which is the
 * question the game asks on load. It cannot detect a WRONG size — nothing can,
 * short of decompressing (see kidsLayout above).
 *
 * @param {Uint8Array} block
 * @returns {{index: number, name: string, stored: number, computed: number}[]}
 */
export function kidsUnsealedWords(block) {
    assertKidsBlock(block);
    const current = parseKidsTable(block);
    if (!current.consistent) {
        throw new Error(
            `the block's own directory is inconsistent (${current.problems.join("; ")}), so there is no size to ` +
                `compute the other words from`,
        );
    }
    const probe = Uint8Array.from(block);
    const seal = sealKidsTable(probe, {
        graphics: current.sections.graphics.size,
        data: current.sections.data.size,
    });
    return seal.words.map((w) => ({ index: w.index, name: w.name, stored: w.before, computed: w.after }));
}

// --- 2 the relay -------------------------------------------------------------

/**
 * @typedef {object} KidsSectionMove
 * @property {"graphics"|"data"|"tail"} name
 * @property {number} offset      where it lands now
 * @property {number} size        exact stream bytes
 * @property {number} padded      the sector-padded span the sum covers
 * @property {boolean} supplied   the caller handed in decompressed bytes for it
 * @property {boolean} recompressed  it went through compress(); false for the
 *   tail, which the format stores raw (FORMAT-PSX.md, "The tail")
 * @property {boolean} moved      its offset differs from the source table's
 * @property {number} sizeDelta   size minus the source table's size
 * @property {boolean} paddingKept
 *   true when the source's stale padding bytes were carried over verbatim
 * @property {{offset: number, size: number, padded: number}} was
 */

/**
 * @typedef {object} KidsWrite
 * @property {KidsSectionMove[]} sections  graphics, data, tail, in file order
 * @property {number} end                  the new word 0
 * @property {number} wasEnd               the source's word 0
 * @property {number} slack                KIDS_BLOCK_SIZE - end, bytes to spare
 * @property {KidsSeal} seal
 * @property {boolean} identical
 *   the block is byte-for-byte the one it was given — the edit-nothing contract
 * @property {number} changedBytes         how many of the 122,880 differ
 * @property {number|null} firstChange     the lowest offset that differs
 * @property {{graphics: boolean, data: boolean, tail: boolean, ok: boolean}} sourceChecksums
 *   what the block's three sums said BEFORE the edit; `ok: false` means this
 *   call healed a save that would not have loaded
 * @property {string[]} warnings
 */

function sectionSource(name, supplied, expected, before, was) {
    if (supplied === undefined || supplied === null) {
        return {
            name,
            stream: before.subarray(was.offset, was.offset + was.size),
            supplied: false,
            recompressed: false,
            was,
        };
    }
    bytesOfLength(`${name} bytes`, supplied, expected);
    const stream = compress(supplied);
    // Read our own output back. compress() mirrors the decoder's ring byte for
    // byte (compress.js:11-13), so this has never failed — which is the point:
    // an encoder bug would otherwise land as a save that parses, checksums and
    // draws garbage, the worst failure this package can produce. Cost is one
    // decompress of a section, ~3 ms for graphics, against a corrupt save.
    const back = decompress(stream);
    if (back.length !== supplied.length) {
        throw new Error(
            `the re-encoded ${name} section decompresses to ${back.length} bytes, not the ${supplied.length} it ` +
                `was given; src/compress.js produced a stream src/decompress.js does not read back`,
        );
    }
    for (let i = 0; i < back.length; i++) {
        if (back[i] !== supplied[i]) {
            throw new Error(
                `the re-encoded ${name} section decompresses to different bytes at ${hex(i)} (${back[i]} for ` +
                    `${supplied[i]}); src/compress.js and src/decompress.js disagree`,
            );
        }
    }
    return { name, stream, supplied: true, recompressed: true, was };
}

/**
 * Edit a Kids! save by section: hand in the DECOMPRESSED bytes for whatever
 * changed, leave the rest out, and get a block that loads.
 *
 * `graphics` is 0x40000 bytes (four CG pages), `data` is 0xFCC8 (the seven
 * regions of KIDS_REGIONS) and `tail` is 0x100 (ten high scores then the
 * options). An OMITTED section keeps its original compressed stream byte for
 * byte; a SUPPLIED one is re-encoded with compress() and read back through
 * decompress() before it is written. Then the three are relaid graphics ->
 * data -> tail on 0x80 sector boundaries and the directory is resealed.
 *
 * PASS ONLY WHAT YOU CHANGED. Handing back a section you merely decoded costs
 * bytes for nothing: 0 of the 77 community saves recompress byte-identically
 * and the mean cost of a needless re-encode is +796 bytes over the two
 * sections. Omission is not an optimisation here, it is the contract — it is
 * the only reason editKidsSave(block, {}) returns `identical: true`.
 *
 * THE PADDING. Each section's sum covers its sector padding, and the padding in
 * a real save is stale staging-buffer content rather than zero (68 of 77 saves
 * for graphics, 64 for data). So:
 *   - a section that is NOT supplied AND lands at the same offset keeps the
 *     source's padding bytes verbatim. That is what makes an edit-nothing round
 *     trip byte-identical, and it is the only case in which it can be;
 *   - a section that was re-encoded, or that merely MOVED because a section
 *     before it changed size, gets ZERO padding. Its stale bytes are lost. They
 *     are staging-buffer residue with no reader — nothing in KIDS.EXE forms an
 *     address inside them — but they are bytes the file used to hold, and a
 *     record's `paddingKept` says which sections lost theirs.
 * Either way the sums cover it, because sealKidsTable() sums the padded span
 * after the bytes are down.
 *
 * WHAT IS NEVER TOUCHED: 0x00..0x100 (the "SC" title frame and icon — the game
 * name lives there, see setKidsGameName), 0x12C..0x180 (84 stale staging
 * bytes), and everything at or past the NEW end. When an edit shrinks the file
 * the bytes between the new end and the old one keep their old content: past
 * word 0 is stale by definition (FORMAT-PSX.md, "Section directory"), the game
 * never reads it, and rewriting it would move bytes nobody asked about.
 *
 * The block is MUTATED in place, like sealKidsTable and like every plus-edit.js
 * setter. A caller who wants the original keeps Uint8Array.from(block).
 *
 * @param {Uint8Array} block  a whole 0x1E000 block whose directory parses
 * @param {{graphics?: Uint8Array, data?: Uint8Array, tail?: Uint8Array}} [sections]
 * @returns {KidsWrite}
 * @throws {Error} on a wrong-size block, a source directory that does not
 *   parse, a section of the wrong decompressed length, a stream that does not
 *   read back, or a result that does not fit in 0x1E000
 */
export function editKidsSave(block, { graphics, data, tail } = {}) {
    assertKidsBlock(block);
    const source = parseKidsTable(block);
    if (!source.consistent) {
        throw new Error(
            `this block's section directory does not parse (${source.problems.join("; ")}); editKidsSave edits a ` +
                `save that already loads and cannot invent the stream boundaries of one that does not`,
        );
    }
    const before = Uint8Array.from(block);
    const sourceChecksums = validateKidsTable(before, source);

    const gWas = { ...pick(source.sections.graphics) };
    const dWas = { ...pick(source.sections.data) };
    const tWas = { ...pick(source.sections.tail) };
    const gfx = sectionSource("graphics", graphics, KIDS_GRAPHICS_SIZE, before, gWas);
    const dat = sectionSource("data", data, KIDS_DATA_SIZE, before, dWas);
    // The tail is stored RAW — word 7's 0x100 bytes are not compressed
    // (FORMAT-PSX.md, "The tail") — so a supplied tail is written as given and
    // `recompressed` stays false. It is still a section: it is summed (word 8)
    // and it moves whenever the data section's padded size changes.
    let tailStream = before.subarray(tWas.offset, tWas.offset + KIDS_TAIL_SIZE);
    let tailSupplied = false;
    if (tail !== undefined && tail !== null) {
        tailStream = Uint8Array.from(bytesOfLength("tail bytes", tail, KIDS_TAIL_SIZE));
        tailSupplied = true;
    }

    const layout = kidsLayout(gfx.stream.length, dat.stream.length);
    assertFits(
        layout,
        `the edited save (it was ${source.end}, ${KIDS_BLOCK_SIZE - source.end} bytes to spare; src/compress.js ` +
            `costs up to 2,495 bytes more than the game's own encoder on the 77-save corpus)`,
    );

    const warnings = [];
    const sections = [];
    const place = (sec, offset, size, padded) => {
        const keepPadding = !sec.supplied && offset === sec.was.offset && padded === sec.was.padded;
        if (keepPadding) {
            // The whole padded span in one copy, stale bytes and all. Taken from
            // `before`, never from `block`, so an earlier section that grew into
            // this span cannot poison it.
            block.set(before.subarray(offset, offset + padded), offset);
        } else {
            block.set(sec.stream, offset);
            block.fill(0, offset + size, offset + padded);
        }
        sections.push({
            name: sec.name,
            offset,
            size,
            padded,
            supplied: sec.supplied,
            recompressed: sec.recompressed,
            moved: offset !== sec.was.offset,
            sizeDelta: size - sec.was.size,
            paddingKept: keepPadding,
            was: sec.was,
        });
    };
    place(gfx, layout.graphicsOffset, layout.graphicsSize, layout.graphicsPadded);
    place(dat, layout.dataOffset, layout.dataSize, layout.dataPadded);
    place(
        { name: "tail", stream: tailStream, supplied: tailSupplied, recompressed: false, was: tWas },
        layout.tailOffset,
        KIDS_TAIL_SIZE,
        KIDS_TAIL_SIZE,
    );

    const seal = sealKidsTable(block, { graphics: layout.graphicsSize, data: layout.dataSize });

    for (const s of sections) {
        if (s.recompressed) {
            warnings.push(
                `${s.name} was re-encoded by src/compress.js, which is not the game's own encoder — ${
                    s.sizeDelta >= 0 ? "+" : ""
                }${s.sizeDelta} bytes against the stream it replaced; the save still decompresses to exactly the ` +
                    `bytes given, but it will not match the file Athena would have written`,
            );
        }
        if (!s.paddingKept && s.padded > s.size) {
            warnings.push(
                `${s.name}'s ${s.padded - s.size} sector-padding bytes are now zero; the source's stale staging ` +
                    `content there is gone (nothing reads it, and the sum covers whatever is there)`,
            );
        }
    }
    if (seal.slack < 0x1000) {
        warnings.push(
            `${seal.slack} bytes to spare in the ${KIDS_BLOCK_SIZE}-byte file; a further edit may not fit`,
        );
    }
    if (!sourceChecksums.ok) {
        warnings.push(
            `the block's own sums did not verify before this edit (graphics ${sourceChecksums.graphics}, data ` +
                `${sourceChecksums.data}, tail ${sourceChecksums.tail}); the seal has now healed them`,
        );
    }

    let changedBytes = 0;
    let firstChange = null;
    for (let i = 0; i < block.length; i++) {
        if (block[i] === before[i]) continue;
        if (firstChange === null) firstChange = i;
        changedBytes++;
    }
    return {
        sections,
        end: layout.end,
        wasEnd: source.end,
        slack: seal.slack,
        seal,
        identical: changedBytes === 0,
        changedBytes,
        firstChange,
        sourceChecksums,
        warnings,
    };
}

function pick(section) {
    return { offset: section.offset, size: section.size, padded: section.padded };
}

// --- 3 the field setters -----------------------------------------------------

// THE SHAPE, and why it is not plus-edit.js's.
//
// A Dezaemon+ setter takes the BLOCK, because every field in that format sits
// at a fixed file offset. Two thirds of a Kids! save is behind LZSS, so the
// same signature would mean decompress-edit-recompress per field, and a
// ten-chip edit would re-encode the data section ten times and produce ten
// different streams. So a setter here takes the DECOMPRESSED SECTION it lives
// in, mutates it, and the caller passes that section to editKidsSave() once:
//
//   const save = parseKidsSave(block);
//   const data = Uint8Array.from(save.data);           // parse gives a fresh array
//   setKidsMapChip(data, 0, 3, 40, { cell: 128 });
//   setKidsScrollNibble(data, 0, 12, 2);
//   editKidsSave(block, { data });                     // one re-encode, one seal
//
// setKidsGameName is the exception and takes the block, because the game name
// is not in a section at all — it is in the "SC" title frame at 0x2E, ahead of
// everything the directory describes. It needs no seal: no Kids! checksum
// covers a byte below 0x180.
//
// Every record below carries `inBlock`, which is that distinction: false means
// the bytes are in a decompressed section that is not in the save yet.

/**
 * @typedef {object} KidsFieldWrite
 * @property {string} field       what was written, e.g. "map stage 0 (3,40)"
 * @property {"data"|"tail"|"block"} section  which buffer `offset` is inside
 * @property {number} offset      offset of the first byte written, within it
 * @property {number} length      bytes written
 * @property {number[]} before    the bytes as they were
 * @property {number[]} after     the bytes now
 * @property {boolean} changed    false when `after` equals `before`
 * @property {boolean} inBlock
 *   true when the write already landed in the save block (setKidsGameName);
 *   false when the caller must still pass this section to editKidsSave()
 * @property {string[]} warnings  prose, house style: "…; … — consequence"
 */

/**
 * Apply one write and build the record for it. Nothing is mutated until every
 * value has been validated, so a setter that throws leaves the buffer
 * byte-identical — the same rule as plus-edit.js:341-342.
 */
function applyWrite(buffer, section, field, at, bytes, { inBlock = false, warnings = [] } = {}) {
    const before = Array.from(buffer.subarray(at, at + bytes.length));
    for (let i = 0; i < bytes.length; i++) buffer[at + i] = bytes[i] & 0xff;
    const after = Array.from(buffer.subarray(at, at + bytes.length));
    return {
        field,
        section,
        offset: at,
        length: bytes.length,
        before,
        after,
        changed: before.some((b, i) => b !== after[i]),
        inBlock,
        warnings,
    };
}

function assertDataSection(data) {
    bytesOfLength("the decompressed data section", data, KIDS_DATA_SIZE);
    return data;
}

function assertTailSection(tail) {
    bytesOfLength("the tail", tail, KIDS_TAIL_SIZE);
    return tail;
}

function stageIn(stage) {
    return intIn("stage", stage, 0, KIDS_STAGES - 1);
}

// Six stage slots exist in every save; how many the game PLAYS is the config's
// per-stage "last stage" flag (kids.js:516-521, resolved :531-532). Editing a
// stage past it is legal — the editor writes all six — but the edit never runs,
// so say so.
function pastLastStageWarning(data, stage) {
    let last = -1;
    const flags = KIDS_REGION.config.offset + 3;
    for (let s = 0; s < KIDS_STAGES; s++) {
        if ((data[flags + s] & 0x80) !== 0) {
            last = s;
            break;
        }
    }
    if (last < 0 || stage <= last) return [];
    return [
        `stage ${stage} is past the game's last stage (${last}); CONFIG +0x03..+0x08 bit 7 marks it, so this ` +
            `edit is stored and never played`,
    ];
}

/**
 * One 32x32 map chip. A stage is 384 rows of 7 u16 chips, row-major
 * (FORMAT-PSX.md, "MAP"); a chip draws the 2x2 group of CG cells
 * `n, n+1, n+8, n+9`.
 *
 * ENFORCED, and both rules are measured here over the 77 real saves rather than
 * quoted — 1,241,856 chips, of which 837,807 are blank:
 *   - `cell` is 0..1023, inside the 1,024-cell bank kidsCell() indexes;
 *   - `(cell & KIDS_CELL_ALIGN) === 0`, the 2x2 alignment. Bits 0 and 3 of the
 *     cell number are clear in ALL 1,241,856 chips, blank ones included, so
 *     this refuses nothing any real save contains. The alignment is also what
 *     makes the bank check redundant rather than merely consistent: the largest
 *     aligned cell is 1,014, and 1,014 + 9 = 1,023, so an aligned group can
 *     never run off the end.
 *   - bits 10-12 are written as ZERO. FORMAT-PSX.md, "MAP", grades them "never
 *     read, never set", and measured they are clear in all 1,241,856 chips —
 *     so there is no bit here to preserve, and offering one would be offering
 *     a field with no reader.
 *
 * `blank` sets bit 15 and the renderer then ignores the cell number. The
 * commonest blank word is 0x8080 (707,393 of the 837,807) because that is the
 * initialiser's fill, and 0x8000 (116,459) is next; `{blank: true}` alone
 * writes 0x8000. All fourteen blank words that occur carry an ALIGNED cell
 * number, which is why alignment is enforced for a blank chip too: it costs a
 * caller nothing and it keeps a decode/encode round trip exact.
 *
 * @param {Uint8Array} data    the decompressed 0xFCC8 data section, mutated
 * @param {number} stage       0..5
 * @param {number} column      0..6
 * @param {number} row         0..383
 * @param {{cell?: number, hflip?: boolean, vflip?: boolean, blank?: boolean}} chip
 * @returns {KidsFieldWrite}
 */
export function setKidsMapChip(data, stage, column, row, { cell = 0, hflip = false, vflip = false, blank = false } = {}) {
    assertDataSection(data);
    stageIn(stage);
    intIn("column", column, 0, KIDS_MAP_COLUMNS - 1);
    intIn("row", row, 0, KIDS_MAP_ROWS - 1);
    intIn("cell", cell, 0, KIDS_CELL_COUNT - 1);
    bool("hflip", hflip);
    bool("vflip", vflip);
    bool("blank", blank);
    if ((cell & KIDS_CELL_ALIGN) !== 0) {
        throw new Error(
            `cell ${cell} is not 2x2-aligned; a chip draws cells n, n+1, n+8 and n+9, so bits 0 and 3 of n must ` +
                `be clear — ${cell & ~KIDS_CELL_ALIGN} is the aligned cell below it`,
        );
    }
    const word = (cell & KIDS_CELL_MASK) | (hflip ? KIDS_HFLIP : 0) | (vflip ? KIDS_VFLIP : 0) |
        (blank ? KIDS_BLANK : 0);
    const at = KIDS_REGION.map.offset + stage * KIDS_MAP_STAGE_BYTES + (row * KIDS_MAP_COLUMNS + column) * 2;
    return applyWrite(data, "data", `map stage ${stage} (${column},${row})`, at, [word & 0xff, (word >> 8) & 0xff], {
        warnings: pastLastStageWarning(data, stage),
    });
}

/** The scroll nibble's ceiling: no nibble above 3 occurs in any real save. */
export const KIDS_SCROLL_NIBBLE_MAX = 3;

/**
 * One SCROLL nibble: the scroll speed over one 64 px unit of a stage. 192
 * nibbles per stage, LOW NIBBLE FIRST inside each byte (kids.js:365-366,
 * FORMAT-PSX.md, "SCROLL").
 *
 * ENFORCED: 0..3. The play engine indexes GAMES.bin's four-entry table
 * `0x80148318` with `value & 3` — 0, 0.25, 1 and 4 px per frame — so a higher
 * nibble is not out of range for the ENGINE, which masks it away. It is out of
 * range for the EDITOR, which reads the whole nibble to pick a scroll icon
 * (KIDS.EXE 0x8008BD20 / 0x8008BD74). Measured over the 77 saves: 88,704
 * nibbles, values 0 (6,192), 1 (8,990), 2 (62,309) and 3 (11,213), and nothing
 * else. Writing 4..15 would produce a speed the game plays and the editor
 * cannot draw, so this refuses.
 *
 * This is a read-modify-write of half a byte: the other nibble is preserved.
 *
 * @param {Uint8Array} data   the decompressed 0xFCC8 data section, mutated
 * @param {number} stage      0..5
 * @param {number} unit       0..191, one per 64 px
 * @param {number} nibble     0..3
 * @returns {KidsFieldWrite}
 */
export function setKidsScrollNibble(data, stage, unit, nibble) {
    assertDataSection(data);
    stageIn(stage);
    intIn("scroll unit", unit, 0, KIDS_SCROLL_UNITS - 1);
    intIn("scroll nibble", nibble, 0, KIDS_SCROLL_NIBBLE_MAX);
    const at = KIDS_REGION.scroll.offset + stage * KIDS_SCROLL_STAGE_BYTES + (unit >> 1);
    const current = data[at];
    const byte = (unit & 1) ? ((current & 0x0f) | (nibble << 4)) : ((current & 0xf0) | nibble);
    return applyWrite(data, "data", `scroll stage ${stage} unit ${unit}`, at, [byte], {
        warnings: pastLastStageWarning(data, stage),
    });
}

/** A high-score name is eight bytes, and the editor pre-fills it with dots. */
export const KIDS_HISCORE_NAME_BYTES = 8;
export const KIDS_HISCORE_NAME_PAD = 0x2e; // "."

/**
 * Eight name bytes from ASCII text, dot-padded the way the editor's own entry
 * screen pre-fills them (kids.js:273-274, FORMAT-PSX.md, "The tail").
 *
 * The dots are a pre-fill and not padding — a player can type dots, commas and
 * spaces — so a caller who wants trailing spaces passes them and gets them.
 *
 * ENFORCED: 0x20..0x7E, printable ASCII. Measured over the 770 real entries,
 * the 39 distinct byte values that occur all lie in 0x20..0x5A: space,
 * punctuation, digits and UPPERCASE only, with no lowercase letter anywhere in
 * the corpus. Lowercase is accepted rather than refused because the constraint
 * is the entry screen's alphabet and not the font's, and nothing traced says
 * what the font does with 0x61..0x7A.
 *
 * @param {string} text  up to 8 characters
 * @returns {Uint8Array} exactly 8 bytes
 */
export function kidsScoreName(text) {
    if (typeof text !== "string") throw new Error(`a high-score name is a string; got ${typeof text}`);
    if (text.length > KIDS_HISCORE_NAME_BYTES) {
        throw new Error(`a high-score name is ${KIDS_HISCORE_NAME_BYTES} characters; "${text}" is ${text.length}`);
    }
    const out = new Uint8Array(KIDS_HISCORE_NAME_BYTES).fill(KIDS_HISCORE_NAME_PAD);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) {
            throw new Error(
                `"${text[i]}" (${hex(c)}) is not printable ASCII; the Kids! score table is latin1 bytes ` +
                    `(decodeKidsHiScores, kids.js:291) and the corpus uses only 0x20..0x5A`,
            );
        }
        out[i] = c;
    }
    return out;
}

/**
 * One of the ten high-score entries in the tail: u32le score, the stage
 * reached, the level the run started on, two always-zero bytes, an 8-byte name
 * (FORMAT-PSX.md, "The tail").
 *
 * `stage` / `allClear` / `level` / `name` OMITTED mean PRESERVE, unvalidated —
 * the rule plus-edit.js:1036-1045 arrived at the hard way: the entry goes out
 * as one 16-byte range, so a caller who only wants to correct a score would
 * otherwise have to hand back three fields it never asked about, and a byte
 * already in the file gains nothing from a range check. A SUPPLIED value is
 * still checked.
 *
 * ENFORCED:
 *   - `score` 0..0xFFFFFFFF, written little-endian;
 *   - `allClear: true` writes 0x80 into byte +4 and is exclusive with `stage`,
 *     because they are the same byte (kids.js:280-281). Measured over the 770
 *     real entries, byte +4 takes exactly the values 0, 1, 2, 3, 4 and 128 —
 *     0x80 never carries a stage number with it;
 *   - `stage` 0..5. The corpus tops out at 4, but six stage slots exist and a
 *     six-stage game clears on stage 5, so refusing 5 would refuse a legal run;
 *   - `level` 0..4, with 4 warned about: KIDS_MUTEKI_LEVEL is what the
 *     invincible test play writes (kids.js:82) and its reader masks it away
 *     (`KIDS_LEVELS[level & 3]`, kids.js:289), but no community entry has it —
 *     all 770 are 0..3;
 *   - bytes +6 and +7 are FORCED to zero, measured zero in all 770.
 *
 * `name` is EIGHT BYTES, never a string, for plus-edit.js:1025-1027's reason —
 * the field is decoded with latin1() and a string parameter invites text the
 * game's font does not have. kidsScoreName() is the encoder, and it is a
 * separate call so that its own rule is visible at the call site.
 *
 * @param {Uint8Array} tail  the 0x100-byte tail, mutated
 * @param {number} rank      1..10
 * @param {{score: number, stage?: number, allClear?: boolean, level?: number, name?: Uint8Array}} entry
 * @returns {KidsFieldWrite}
 */
export function setKidsHiScore(tail, rank, { score, stage, allClear, level, name } = {}) {
    assertTailSection(tail);
    intIn("rank", rank, 1, KIDS_HISCORE_COUNT);
    intIn("score", score, 0, 0xffffffff);
    const at = (rank - 1) * KIDS_HISCORE_SIZE;
    const warnings = [];

    let stageByte = tail[at + 4];
    const wantsAllClear = allClear !== undefined && allClear !== null;
    const wantsStage = stage !== undefined && stage !== null;
    if (wantsAllClear && wantsStage) {
        throw new Error(
            `stage ${stage} and allClear are the same byte (+4): 0x${KIDS_ALL_CLEAR.toString(16)} marks an ` +
                `all-clear INSTEAD of a stage number, so only one of them can be given`,
        );
    }
    if (wantsAllClear) stageByte = bool("allClear", allClear) ? KIDS_ALL_CLEAR : 0;
    else if (wantsStage) stageByte = stageIn(stage);

    let levelByte = tail[at + 5];
    if (level !== undefined && level !== null) {
        levelByte = intIn("level", level, 0, KIDS_MUTEKI_LEVEL);
        if (levelByte === KIDS_MUTEKI_LEVEL) {
            warnings.push(
                `level ${KIDS_MUTEKI_LEVEL} is the invincible test play's marker; the table prints it as ` +
                    `${KIDS_LEVELS[KIDS_MUTEKI_LEVEL & 3]} because the reader masks it to two bits, and no ` +
                    `community entry carries it`,
            );
        }
    }

    let nameBytes = tail.subarray(at + 8, at + 8 + KIDS_HISCORE_NAME_BYTES);
    if (name !== undefined && name !== null) {
        if (typeof name === "string") {
            throw new Error("a high-score name is eight bytes, not a string; kidsScoreName() is the encoder");
        }
        nameBytes = bytesOfLength("a high-score name", name, KIDS_HISCORE_NAME_BYTES);
    }

    // The whole 16-byte entry goes out as one range, so the u32 score is laid
    // down through putU32le into a scratch rather than into the tail twice.
    const head = new Uint8Array(4);
    putU32le(head, 0, score);
    const bytes = [head[0], head[1], head[2], head[3], stageByte, levelByte, 0, 0, ...nameBytes];
    return applyWrite(tail, "tail", `hi-score rank ${rank}`, at, bytes, { warnings });
}

// --- the game name -----------------------------------------------------------

// Kids! is the one of the two games that HAS a name in text. The "SC" title is
// a fixed 64 bytes of Shift-JIS and every one of the 77 community saves has the
// identical 42-byte prefix — デザエモンＫｉｄｓ！ユーザーゲームデータ『 — then a
// 20-byte name field, then 』 at bytes 62..63. Measured: 77 of 77 on both. So
// the name is a FIXED 20-byte window at block offset 0x2E, not a variable-length
// insert, and setting it neither moves a byte nor touches a checksum.
//
// (Dezaemon+ has no equivalent: its title is fixed and its game name is drawn
// into the graphics as a logo, save-header.js:11-12. bracketedName/narrow read
// this field; setKidsGameName writes it.)

/** Block offset of the 20-byte game-name field inside the "SC" title. */
export const KIDS_TITLE_NAME_OFFSET = TITLE_OFFSET + 42; // 0x2E
export const KIDS_TITLE_NAME_BYTES = 20;
/** Ten fullwidth characters; the field is two bytes each, and always full. */
export const KIDS_TITLE_NAME_CHARS = KIDS_TITLE_NAME_BYTES / 2;
/** 『 and 』, the brackets the name sits between, as Shift-JIS words. */
export const KIDS_TITLE_OPEN = 0x8177;
export const KIDS_TITLE_CLOSE = 0x8178;
/** 　, the ideographic space the editor pads a short name with. */
export const KIDS_TITLE_PAD = 0x8140;

// The fit is settled HERE, once, not per write: 42 + 20 + the two bytes of 』 is
// exactly TITLE_LENGTH, so the name field ends FLUSH with the 0x40-byte title
// and no write can push it past. setKidsGameName used to warn about an overrun
// instead, which measured 0 warnings over 77 of 77 community saves and could
// not have measured anything else — every operand was a module constant and
// none of them read the block, so the test was 68 < 68. The tripwire is still
// worth having, so it throws where the constants are: widen the field or move
// it and 』 lands past the title, where parseSaveHeader stops reading
// (save-header.js:84) and the game shows a truncated name.
if (KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 2 !== TITLE_OFFSET + TITLE_LENGTH) {
    throw new Error("the Kids! name field no longer ends flush with the 0x40-byte title");
}

// Shift-JIS for the ASCII the name field can hold. Three of the four groups are
// contiguous runs (fullwidth 0-9, A-Z, a-z); the punctuation is scattered and
// is listed. Every entry decodes to the fullwidth form of its ASCII key through
// TextDecoder("shift_jis") — measured, all 93 — and `narrow()` (save-header.js:47)
// maps every one of those back, which is what makes kidsNameBytes the inverse of
// the reader rather than a second opinion.
//
// TWO of the 95 printable ASCII characters are deliberately absent: " and '.
// JIS X 0208 has no fullwidth quote or apostrophe, only the curly ” (0x8168) and
// ’ (0x8166) — measured, TextDecoder returns those — and narrow() does not map
// U+201D or U+2019 back, so encoding them would break the round trip in the one
// direction a caller would never test. They go in as raw bytes if they are wanted.
//
// This is NOT the whole title alphabet either. 54 of the 77 community names use
// katakana or kanji, which have no ASCII key at all; those go in as raw
// Shift-JIS bytes. The helper refuses what it cannot encode instead of
// substituting, because a substituted glyph is a name the player did not choose.
const SJIS_PUNCTUATION = Object.freeze({
    " ": KIDS_TITLE_PAD,
    "!": 0x8149,
    "#": 0x8194,
    "$": 0x8190,
    "%": 0x8193,
    "&": 0x8195,
    "(": 0x8169,
    ")": 0x816a,
    "*": 0x8196,
    "+": 0x817b,
    ",": 0x8143,
    "-": 0x817c,
    ".": 0x8144,
    "/": 0x815e,
    ":": 0x8146,
    ";": 0x8147,
    "<": 0x8183,
    "=": 0x8181,
    ">": 0x8184,
    "?": 0x8148,
    "@": 0x8197,
    "[": 0x816d,
    "\\": 0x815f,
    "]": 0x816e,
    "^": 0x814f,
    "_": 0x8151,
    "`": 0x814d,
    "{": 0x816f,
    "|": 0x8162,
    "}": 0x8170,
    "~": 0x8160,
});

function sjisWord(ch) {
    // The ideographic space and the fullwidth forms go in unchanged, so a name
    // read back out of a save with narrow() OR without it both re-encode.
    if (ch === "　") return KIDS_TITLE_PAD;
    const code = ch.charCodeAt(0);
    const ascii = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
    if (ascii >= "0" && ascii <= "9") return 0x824f + (ascii.charCodeAt(0) - 0x30);
    if (ascii >= "A" && ascii <= "Z") return 0x8260 + (ascii.charCodeAt(0) - 0x41);
    if (ascii >= "a" && ascii <= "z") return 0x8281 + (ascii.charCodeAt(0) - 0x61);
    return SJIS_PUNCTUATION[ascii] ?? null;
}

/**
 * A game name as the 20 Shift-JIS bytes the title field holds, padded with 　.
 *
 * Takes ASCII or the fullwidth forms of it, and refuses everything else with
 * the character named. For a katakana or kanji name — 54 of the 77 community
 * saves — encode it elsewhere and pass the bytes to setKidsGameName directly;
 * that path has no alphabet at all.
 *
 * @param {string} text  up to 10 characters
 * @returns {Uint8Array} exactly KIDS_TITLE_NAME_BYTES bytes
 */
export function kidsNameBytes(text) {
    if (typeof text !== "string") throw new Error(`a game name is a string; got ${typeof text}`);
    const chars = [...text];
    if (chars.length > KIDS_TITLE_NAME_CHARS) {
        throw new Error(
            `the title's name field is ${KIDS_TITLE_NAME_CHARS} fullwidth characters (${KIDS_TITLE_NAME_BYTES} ` +
                `bytes, fixed); "${text}" is ${chars.length}`,
        );
    }
    const out = new Uint8Array(KIDS_TITLE_NAME_BYTES);
    for (let i = 0; i < KIDS_TITLE_NAME_CHARS; i++) {
        const word = i < chars.length ? sjisWord(chars[i]) : KIDS_TITLE_PAD;
        if (word === null) {
            throw new Error(
                `"${chars[i]}" has no ASCII Shift-JIS form; kidsNameBytes encodes 0x20..0x7E and their fullwidth ` +
                    `twins only, and 54 of the 77 community names are katakana — pass raw Shift-JIS bytes to ` +
                    `setKidsGameName for those`,
            );
        }
        // BIG-endian: a Shift-JIS lead byte comes first in the stream. The rest
        // of this module is little-endian because the DIRECTORY is; text is not.
        out[i * 2] = (word >> 8) & 0xff;
        out[i * 2 + 1] = word & 0xff;
    }
    return out;
}

/**
 * The user game's name, in the "SC" title frame at 0x2E.
 *
 * This is the one setter that takes the BLOCK, and the one that needs no seal:
 * the three Kids! sums cover 0x180 and up (FORMAT-PSX.md, "Section directory"),
 * the directory itself sits at 0x100, and a memory card's only other checksum
 * is the XOR each directory frame takes over its own 128 bytes
 * (frameChecksum, memcard.js:71), which never covers a data block. So the write
 * is final the moment it lands — call editKidsSave() only if you are also
 * changing a section.
 *
 * ENFORCED: the block must actually carry the Kids! title shape — 『 at 0x2C
 * and 』 at 0x42 — or this refuses. 77 of the 77 community saves have both, and
 * without the check a block whose title is laid out differently would have 20
 * bytes of its title overwritten in the middle with no error at all.
 *
 * The name is padded to the full 20 bytes with 　 (0x8140), which is what the
 * editor does: every one of the 77 name fields is exactly ten characters.
 *
 * @param {Uint8Array} block  a whole 0x1E000 block, mutated in place
 * @param {Uint8Array|string} name
 *   up to KIDS_TITLE_NAME_BYTES of Shift-JIS, or a string through kidsNameBytes
 * @returns {KidsFieldWrite}
 */
export function setKidsGameName(block, name) {
    assertKidsBlock(block);
    const open = (block[KIDS_TITLE_NAME_OFFSET - 2] << 8) | block[KIDS_TITLE_NAME_OFFSET - 1];
    const closeAt = KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES;
    const close = (block[closeAt] << 8) | block[closeAt + 1];
    if (open !== KIDS_TITLE_OPEN || close !== KIDS_TITLE_CLOSE) {
        throw new Error(
            `this block's title does not have the Kids! name field: expected ${hex(KIDS_TITLE_OPEN)} at ` +
                `${hex(KIDS_TITLE_NAME_OFFSET - 2)} and ${hex(KIDS_TITLE_CLOSE)} at ${hex(closeAt)}, found ` +
                `${hex(open)} and ${hex(close)}`,
        );
    }
    // A string is accepted here, unlike a high-score name, because this field
    // IS traced: the title is Shift-JIS, save-header.js decodes it with
    // TextDecoder and kidsNameBytes() refuses every character it cannot encode
    // rather than substituting one. There is still one meaning for the
    // parameter — the name — and one alphabet per path.
    const bytes = typeof name === "string" ? kidsNameBytes(name) : name;
    if (!(bytes instanceof Uint8Array)) {
        throw new Error(`a game name is Shift-JIS bytes or a string; got ${typeof name}`);
    }
    if (bytes.length > KIDS_TITLE_NAME_BYTES || (bytes.length & 1) !== 0) {
        throw new Error(
            `the title's name field is ${KIDS_TITLE_NAME_BYTES} bytes of two-byte Shift-JIS; got ${bytes.length}`,
        );
    }
    const field = new Uint8Array(KIDS_TITLE_NAME_BYTES);
    for (let i = 0; i < KIDS_TITLE_NAME_BYTES; i += 2) {
        field[i] = (KIDS_TITLE_PAD >> 8) & 0xff;
        field[i + 1] = KIDS_TITLE_PAD & 0xff;
    }
    field.set(bytes, 0);
    const warnings = [];
    const header = parseSaveHeader(block);
    if (!header.title.startsWith(KIDS_TITLE_PREFIX)) {
        warnings.push(
            `the title does not start with ${KIDS_TITLE_PREFIX}; the brackets are where they should be, so the ` +
                `name is written, but identifyGame() will not recognise this block by its title`,
        );
    }
    return applyWrite(block, "block", "game name", KIDS_TITLE_NAME_OFFSET, Array.from(field), {
        inBlock: true,
        warnings,
    });
}

// --- 4 the container ---------------------------------------------------------

/**
 * @typedef {object} KidsPlacement
 * @property {string} filename
 * @property {number[]} blocks    the 1-based chain, in order
 * @property {number} bytes       blocks.length * BLOCK_SIZE
 * @property {boolean} framesOk   every directory frame still checksums
 * @property {string[]} warnings
 */

/**
 * Write an edited 0x1E000 block back into the card image it came from, block by
 * block through blockBytes(). locateSaves() hands back a COPY for a card and a
 * .gme (parseMemoryCard allocates and copies, memcard.js:161-163), so mutating
 * that copy edits nothing — this function exists because of that.
 *
 * Nothing at card level goes stale. The only derived bytes are the XOR
 * checksums on the 16 directory frames (frameChecksum, memcard.js:71), and a
 * frame covers only its own 128 directory bytes; there is no checksum over data
 * blocks anywhere in the format. The length-dependent fields — frame 0's u32
 * size at +4 and the chain link at +8 (memcard.js:111-112) — cannot change,
 * because KIDS_BLOCK_SIZE is a constant, assertKidsBlock forbids any other
 * length, and an edit relays the sections INSIDE those 0x1E000 bytes.
 *
 * This is placePlusSave (plus-edit.js) with two substitutions, and the
 * duplication is deliberate rather than overlooked: the product code, and the
 * predicate that says the block is the right game. See the note below it.
 *
 * @param {Uint8Array} card   a RAW 128 KB card image — for a .gme pass
 *                            bytes.subarray(GME_HEADER_SIZE), which is a view
 * @param {Uint8Array} block  the edited block, sealed
 * @param {{filename?: string, index?: number|null, requireKids?: boolean}} [options]
 * @returns {KidsPlacement}
 * @throws {Error} on a .psv, a missing file, an incomplete chain, or a short card
 */
export function placeKidsSave(card, block, { filename = KIDS_PRODUCT, index = null, requireKids = true } = {}) {
    // A PS3 .psv carries a cryptographic signature over the save in its 0x84
    // header, keyed to the console. This package neither reads, checks nor can
    // regenerate it — locateSaves's .psv branch slices at PSV_HEADER_SIZE and
    // reads a filename (memcard.js:214-219). An edited .psv would be a file
    // this package reads back happily and a real PS3 rejects: the worst failure
    // mode for a surgical tool, because nothing in the toolchain warns. A
    // refusal, never a warning.
    if (isPsvImage(card)) {
        throw new Error(
            "a .psv carries a signature this package cannot regenerate; convert it to a card image or an .mcs first",
        );
    }
    assertKidsBlock(block);
    const warnings = [];
    // isKidsBlock is the DIRECTORY test (kids.js:222-226), not a title test,
    // and that is the right one here: a block whose eleven words do not
    // cross-check is a block whose sections are not where this says they are.
    // There is no Select 100 case to excuse — that re-release is Dezaemon+'s
    // (FORMAT-PSX.md, "Select 100") and Kids! has no headerless edition — so
    // `requireKids: false` exists only for a caller placing a block it built
    // itself and has not sealed yet.
    if (!isKidsBlock(block)) {
        const problems = parseKidsTable(block).problems.join("; ");
        if (requireKids) {
            throw new Error(
                `the block has no consistent Kids! section directory at ${hex(KIDS_TABLE_OFFSET)} (${problems}); ` +
                    `seal it first, or pass requireKids: false to place it as it stands`,
            );
        }
        warnings.push(`the block's section directory does not cross-check (${problems}) — placed anyway`);
    }
    if (!parseSaveHeader(block).magicOk) {
        warnings.push('the block has no "SC" title frame; the card will list it, and the game will not');
    }
    if (card.length < CARD_SIZE) {
        throw new Error(`a memory card image is ${CARD_SIZE} bytes; got ${card.length}`);
    }
    // Reparse here, so a caller cannot hand in a stale chain.
    const parsed = parseMemoryCard(card);
    const file = index === null || index === undefined
        ? parsed.files.find((f) => f.filename === filename)
        : parsed.files[index];
    if (!file) {
        const on = parsed.files.map((f) => f.filename || "(unnamed)").join(", ") || "nothing";
        throw new Error(
            index === null || index === undefined
                ? `no file named ${filename} on this card; it holds ${on}`
                : `no file at index ${index} on this card; it holds ${on}`,
        );
    }
    if (!file.complete) {
        throw new Error(
            `${file.filename || "(unnamed)"} has an incomplete block chain (${file.blocks.join(", ")} for ` +
                `${file.size} bytes); the card is damaged and a write would scatter the save`,
        );
    }
    if (file.blocks.length * BLOCK_SIZE < KIDS_BLOCK_SIZE) {
        throw new Error(
            `${file.filename || "(unnamed)"} owns ${file.blocks.length} blocks (${file.blocks.length * BLOCK_SIZE} ` +
                `bytes); a Dezaemon Kids! save needs ${KIDS_BLOCK_SIZE / BLOCK_SIZE}`,
        );
    }
    if (file.deleted) {
        warnings.push(`${file.filename} is flagged deleted on this card; the edit lands but the game will not list it`);
    }
    // BY CHAIN POSITION, never by 1 + k: the chain is not guaranteed contiguous
    // or ordered, and test/psx-memcard.test.js:57-63 deliberately builds a card
    // whose chain is [1, 15]. blockBytes (memcard.js:125-127) is a true view.
    for (const [k, b] of file.blocks.entries()) {
        const part = block.subarray(k * BLOCK_SIZE, (k + 1) * BLOCK_SIZE);
        if (part.length === 0) break;
        blockBytes(card, b).set(part);
    }
    return {
        filename: file.filename,
        blocks: [...file.blocks],
        bytes: file.blocks.length * BLOCK_SIZE,
        framesOk: parseMemoryCard(card).frames.every((f) => f.checksumOk),
        warnings,
    };
}

// placeKidsSave and placePlusSave are the same 60 lines apart from the product
// code and the "is this the right game" predicate — and the predicates are not
// interchangeable: isPlusBlock tests the "SC" frame and title prefix
// (plus.js:316-320) with a `requirePlus: false` escape for Select 100's
// headerless blocks, while isKidsBlock tests the section directory
// (kids.js:222-226) and Kids! has no headerless edition to excuse. Delegating
// to placePlusSave with requirePlus:false would put its Dezaemon+ prose in a
// Kids! record, so this is written out rather than wrapped.
//
// The shared form, for whoever owns both files: lift a
// placeDezaemonSave(card, block, {filename, blockSize, verify}) into
// memcard.js, where CARD_SIZE, BLOCK_SIZE and blockBytes already live, and
// leave these two as four-line wrappers passing KIDS_PRODUCT/PLUS_PRODUCT and
// their own verify(). Both block sizes are already 0x1E000, so `blockSize` is
// the same constant twice today and is a parameter only so the helper does not
// have to be edited when it is not. Not done here: plus-edit.js is another
// agent's file this session, and a shared helper that only one caller uses is
// worse than the duplication it replaces.
