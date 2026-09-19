// Editing a Dezaemon+ save in place — the surgical counterpart to plus.js.
//
// Not a writer. Nothing here builds a save; everything takes a real 0x1E000
// block, changes the bytes a field owns, and leaves every other byte alone.
// The only derived bytes in the whole format are the twenty u16 at 0x1DFD8
// (FORMAT-PSX.md "Checksums"), of which the game verifies nineteen, so
// "surgical" is achievable exactly: an N-byte edit reseals to N + 2 bytes PER
// GROUP it dirties. That is N + 2 for the ordinary edit, which lands inside one
// group, and more for one that straddles a group boundary: a 16x16 repaint at
// pixel row 120 crosses the graphics quarter at 0x100 + 0x4000, dirties groups
// 1 and 2, and costs N + 4. Measured, and pinned by psx-plus-edit.test.js's "a
// repaint that straddles a graphics quarter dirties two groups, and one seal
// fixes both", which asserts seal.bytes === 4 over a 128-byte write.
//
// This is the first mutation under src/psx/, which is otherwise a pure
// reader — the break is deliberate and mirrors src/bup-place.js on the
// Saturn side, which does the same thing to a backup partition.
//
// Every setter refuses a value the traced tables cannot hold, because the
// two ENEMY DATA index fields reach an indirect jump (FORMAT-PSX.md
// "ENEMY DATA, field by field") and nothing else in the save does.
// Environment-neutral ESM (Node + browser); no async, no I/O.

import { BLOCK_SIZE, blockBytes, CARD_SIZE, isPsvImage, parseMemoryCard, u16le } from "./memcard.js";
import {
    decodePlusGlobals,
    isPlusBlock,
    PLUS_APPEAR_BOSS_NIBBLE,
    PLUS_APPEAR_CLASSES,
    PLUS_APPEAR_END_MARK,
    PLUS_APPEAR_RECORD_SIZE,
    PLUS_APPEAR_RECORDS,
    PLUS_APPEAR_ROW_TABLE,
    PLUS_BGM_SLOTS,
    PLUS_BLOCK_SIZE,
    PLUS_CHECKED_GROUPS,
    PLUS_CHECKSUM_OFFSET,
    PLUS_ENEMY_COUNT,
    PLUS_ENEMY_SIZE,
    PLUS_GLOBAL_LAYOUT,
    PLUS_GLOBAL_OFFSET,
    PLUS_GRAPHICS_HEIGHT,
    PLUS_GRAPHICS_OFFSET,
    PLUS_GRAPHICS_WIDTH,
    PLUS_HISCORE_COUNT,
    PLUS_HISCORE_OFFSET,
    PLUS_HISCORE_SIZE,
    PLUS_HISCORE_TABLE_BYTES,
    PLUS_ITEM_EFFECTS,
    PLUS_MAP_COLUMNS,
    PLUS_MAP_HALVES,
    PLUS_MAP_ROW_BYTES,
    PLUS_MAP_ROWS,
    PLUS_PALETTE_OFFSET,
    PLUS_PALETTE_ROW_BYTES,
    PLUS_PALETTE_ROWS,
    PLUS_PRODUCT,
    PLUS_SCORE_BONUS,
    PLUS_SETTINGS_OFFSET,
    PLUS_SONG_COUNT,
    PLUS_SONG_SIZE,
    PLUS_SOUND_OFFSET,
    PLUS_STAGE_PIECE,
    PLUS_STAGES,
    PLUS_TABLE,
    PLUS_TILE_MAX,
    plusChecksums,
    plusStageOffset,
} from "./plus.js";

// --- write primitives --------------------------------------------------------

// src/psx/ has readers only (u16le/u32le, memcard.js:62,:66); these are their
// inverses, LITTLE-endian to match. Not DataView.setUint16: its two-argument
// form writes big-endian and would corrupt all twenty checksum words silently,
// and src/write/encode-model.js:62's putU16 is big-endian for the Saturn.

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

// --- the offset -> checksum group resolver -----------------------------------

/**
 * The PLUS_TABLE row an absolute file offset falls in, or null.
 *
 * Binary search: the table is ordered and gapless and its lengths sum to
 * exactly PLUS_BLOCK_SIZE (plus.js:9-10), which test/psx-plus.test.js:36-63
 * pins. Do NOT derive a group from PLUS_REGIONS instead — graphics is four
 * groups, stages five and sound four, so a coarse-region guess is wrong for
 * 13 of the 20 — and do not parse `row.sub`, which is a display string.
 *
 * @param {number} offset  absolute offset into a 0x1E000 block
 * @returns {(typeof PLUS_TABLE)[number] | null}
 */
export function plusEntryAt(offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= PLUS_BLOCK_SIZE) return null;
    let lo = 0;
    let hi = PLUS_TABLE.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const row = PLUS_TABLE[mid];
        if (offset < row.offset) hi = mid - 1;
        else if (offset >= row.offset + row.length) lo = mid + 1;
        else return row;
    }
    return null;
}

/**
 * The checksum flag group an absolute offset belongs to, or null.
 * @param {number} offset
 * @returns {number | null}
 */
export function plusGroupAt(offset) {
    const row = plusEntryAt(offset);
    return row ? row.flag : null;
}

/**
 * The distinct checksum groups a half-open [offset, offset+length) range
 * touches, ascending.
 * @param {number} offset
 * @param {number} length
 * @returns {number[]}
 */
export function plusGroupsIn(offset, length) {
    const groups = new Set();
    let at = offset;
    const end = offset + length;
    while (at < end) {
        const row = plusEntryAt(at);
        if (!row) break;
        groups.add(row.flag);
        at = row.offset + row.length;
    }
    return [...groups].sort((a, b) => a - b);
}

// The multiplier a byte's value gets in its group's sum: the save routine
// accumulates `byte * (offsetWithinEntry & 0x1F) + entryIndex` (plus.js:244).
// A weight of 0 means the byte's VALUE never reaches the sum — one byte in 32,
// 3,850 of the file's 122,880. null when the offset is outside the table.
function checksumWeightAt(offset) {
    const row = plusEntryAt(offset);
    return row ? (offset - row.offset) & 0x1f : null;
}

// --- the seal ----------------------------------------------------------------

/** The one checksum word a seal must not touch: it covers the array itself. */
export const PLUS_UNSEALED_GROUP = 0x13;
export const PLUS_UNSEALED_OFFSET = PLUS_CHECKSUM_OFFSET + PLUS_UNSEALED_GROUP * 2; // 0x1dffe
/** Groups a seal writes: 0x00..0x12, bytes 0x1DFD8..0x1DFFD. */
export const PLUS_SEALED_GROUPS = PLUS_CHECKED_GROUPS; // plus.js:79

/**
 * @param {Uint8Array} block
 * @throws {Error} unless `block` is a byte view of exactly PLUS_BLOCK_SIZE
 */
export function assertPlusBlock(block) {
    if (!(block instanceof Uint8Array)) {
        throw new Error(`a Dezaemon+ block must be a Uint8Array; got ${typeof block}`);
    }
    if (block.length !== PLUS_BLOCK_SIZE) {
        throw new Error(`editing needs the whole ${PLUS_BLOCK_SIZE}-byte block; got ${block.length}`);
    }
}

// assertPlusBlock is deliberately stricter than plusChecksums, which tests `<`
// rather than `!==` (plus.js:234). Hand plusChecksums a 0x1E084-byte buffer
// with the block at offset 0x84 — a .psv still wearing its header — and it
// checksums the FIRST 0x1E000 bytes and reports ok:false without complaining.
// An editor must not inherit that: the correct call is
// plusChecksums(bytes.subarray(0x84, 0x84 + PLUS_BLOCK_SIZE)).
//
// It does NOT check the SC header or the title prefix. isPlusBlock()
// (plus.js:316-320) is that test, it already exists, and it belongs one level
// up — in placePlusSave and in the CLI — because the 106 Select 100 blocks have
// the SC frame stripped (FORMAT-PSX.md "Select 100") and isPlusBlock rejects
// every one of them, yet they are valid Dezaemon+ content that must still seal.
// A seal is arithmetic over 0x1E000 bytes; only a wrong length makes it
// impossible.

/**
 * @typedef {object} PlusSeal
 * @property {{group: number, offset: number, before: number, after: number}[]} words
 *   only the words that actually changed, in group order
 * @property {number[]} groups        the flag groups resealed (subset of 0x00..0x12)
 * @property {number} bytes           2 * words.length
 * @property {number} unsealedGroup   always PLUS_UNSEALED_GROUP (0x13)
 * @property {number} unsealedOffset  always 0x1dffe
 * @property {boolean} ok             read back through plusChecksums() after writing
 */

/**
 * Rewrite the nineteen verified group checksums in place, so a block that has
 * been edited loads. Idempotent: on a block whose checksums already agree it
 * writes nothing and reports zero changed words.
 *
 * Group 0x13 at 0x1DFFE is never written. See PLUS_UNSEALED_GROUP.
 *
 * The block is MUTATED, never copied. The reader's whole discipline is that
 * raw access is a subarray view of the caller's block — decodePlusStage().parts
 * (plus.js:447), decodePlusAppear().rowTable (:559), decodePlusSound()[i].bytes
 * (:604), decodePlusSettings().bytes (:656) — and a seal that returned a copy
 * would strand every one of those views on a stale buffer. A caller who wants a
 * copy writes Uint8Array.from(block) itself.
 *
 * `ok` is not decoration: buildPayload ends by reading its own output back
 * through parseSectionTable (bup-write.js:100), and one plusChecksums(block)
 * after the write is the analogue. Reporting only the CHANGED words, not all
 * nineteen, is what makes the report agree with the bytes — the rule
 * src/write/game-to-save.js:1475-1478 states: the report describes what landed.
 *
 * @param {Uint8Array} block  a whole 0x1E000 block, mutated in place
 * @returns {PlusSeal}
 * @throws {Error} unless `block` is a byte view of exactly PLUS_BLOCK_SIZE
 */
export function sealPlusChecksums(block) {
    assertPlusBlock(block);
    const { computed } = plusChecksums(block);
    const words = [];
    const groups = [];
    // Writing a checksum word only moves group 0x13's own accumulator (the
    // array is one table entry of kind 5, flag 0x13, plus.js:216), so one pass
    // of `computed` is enough: nothing written here invalidates anything else
    // written here. The plusChecksums() below proves it rather than asserting it.
    for (let group = 0; group < PLUS_SEALED_GROUPS; group++) {
        const offset = PLUS_CHECKSUM_OFFSET + group * 2;
        const before = u16le(block, offset);
        const after = computed[group];
        if (before === after) continue;
        putU16le(block, offset, after);
        words.push({ group, offset, before, after });
        groups.push(group);
    }
    return {
        words,
        groups,
        bytes: words.length * 2,
        unsealedGroup: PLUS_UNSEALED_GROUP,
        unsealedOffset: PLUS_UNSEALED_OFFSET,
        ok: plusChecksums(block).ok,
    };
}

// Why group 0x13 is never written, and is not an option:
//
// 1. It is not a fixed point, so writing it destroys idempotence. Measured on
//    the synthetic block of test/_psx-synthetic.js: seal all twenty and the
//    stored word is 2920 while the next pass computes 13002; write that and
//    the pass after computes 13863, then 12913. Three passes, three values. A
//    second seal would keep changing bytes forever, and idempotence is the
//    editor's core contract.
// 2. Nothing reads it. PLUS_CHECKED_GROUPS is 0x13 (plus.js:79) and the
//    comparison loop stops there (plus.js:257); FORMAT-PSX.md:425-426 says the
//    group "covers the array itself and is self-referential, so nothing checks
//    it."
// 3. It costs two bytes of diff per edit for nothing. This is exactly why a
//    one-byte poke reseals to three bytes and not five.
// 4. Nothing measured says what a real save holds there, and the notes no
//    longer imply otherwise. FORMAT-PSX.md:430-436, "Checksums", scopes the
//    corpus result to "the **verified** 0x26 bytes — groups `0x00..0x12`, the
//    nineteen words the load routine actually compares", names
//    test/psx-fixtures.test.js:239 as the evidence (that assertion is that
//    `bad` is empty, which is the nineteen), and grades the twentieth
//    "**open**: nothing in the suite ever compares it". An option to write it
//    would be an option nothing backs.
//
// If a fixture run ever shows real saves satisfy computed[0x13] === stored[0x13],
// that proves the program writes the array in a SECOND pass — a different
// algorithm, not a flag on this one. Reopen then.

/**
 * The verified groups whose stored word disagrees with the file — what a seal
 * would fix. Names the state a UI has to show, and keeps callers off
 * plusChecksums() for the yes/no question.
 *
 * @param {Uint8Array} block
 * @returns {number[]}
 */
export function plusUnsealedGroups(block) {
    assertPlusBlock(block);
    return plusChecksums(block).bad;
}

// --- the shared write record -------------------------------------------------

/**
 * @typedef {object} PlusWrite
 * @property {string} field      what was written, e.g. "map stage 2 (7,40)"
 * @property {number} offset     absolute file offset of the first byte written
 * @property {number} length     bytes written
 * @property {number[]} before   the bytes as they were
 * @property {number[]} after    the bytes now
 * @property {number[]} groups
 *   the checksum groups the written bytes BELONG to — NOT the groups whose
 *   stored word this write moved. It is plusGroupAt() over every written byte,
 *   which is the region locator a caller wants; whether anything moved is
 *   `checksumBlind` and `changed` below, and it takes BOTH. Measured on a fresh
 *   buildPlusBlock(): setPlusScoreBonus(block, 3) reports groups [0x0b] with
 *   checksumBlind true and plusChecksums(block).bad stays [] — that byte sits
 *   at a within-entry offset that is a multiple of 32, so it is multiplied by
 *   zero. A write that lays down the byte already there, setPlusStereo(block,
 *   false) on a fresh block, names group 0x12 with changed false and leaves it
 *   clean as well. Contrast PlusSeal.groups above, which really is only the
 *   words that moved — sealPlusChecksums() skips a word it did not change.
 * @property {boolean} changed   false when `after` equals `before`
 * @property {boolean} checksumBlind
 *   true when NO written byte can move a checksum, because every one of them
 *   sits at a within-entry offset that is a multiple of 32 and is therefore
 *   multiplied by zero (FORMAT-PSX.md:439-441, "Checksums"). A caller must not
 *   use the checksums to confirm this write landed; diff the bytes.
 * @property {boolean} sealed    always false — sealPlusChecksums() is a separate call
 * @property {string[]} warnings prose, house style: "…; … — consequence"
 */

/**
 * Apply one write and build the record for it. `ranges` are {at, bytes} in
 * ascending offset order and must not overlap; most setters pass exactly one.
 *
 * A few setters own bytes that are not contiguous — a map cell is a chip byte
 * and a flip byte up to nine bytes apart (plus.js:89-92), a group-word swap is
 * two words anywhere in the table, a pixel rectangle is one run per scanline.
 * For those, `before`/`after` are the WRITTEN bytes in ascending offset order
 * and are not one run; `offset` is the first and `length` counts only bytes
 * actually written. Every other setter's before/after is block[offset,
 * offset+length).
 *
 * Nothing is mutated until every value has been validated: a setter that
 * throws leaves the block byte-identical, which test case 9 pins.
 */
function applyWrite(block, field, ranges, warnings = []) {
    const before = [];
    const after = [];
    const groups = new Set();
    let blind = true;
    for (const { at, bytes } of ranges) {
        for (let i = 0; i < bytes.length; i++) {
            const offset = at + i;
            before.push(block[offset]);
            const group = plusGroupAt(offset);
            if (group !== null) groups.add(group);
            if (checksumWeightAt(offset) !== 0) blind = false;
        }
    }
    for (const { at, bytes } of ranges) {
        for (let i = 0; i < bytes.length; i++) block[at + i] = bytes[i] & 0xff;
    }
    for (const { at, bytes } of ranges) {
        for (let i = 0; i < bytes.length; i++) after.push(block[at + i]);
    }
    return {
        field,
        offset: ranges[0].at,
        length: before.length,
        before,
        after,
        groups: [...groups].sort((a, b) => a - b),
        changed: before.some((b, i) => b !== after[i]),
        checksumBlind: blind,
        sealed: false,
        warnings,
    };
}

// --- shared guards -----------------------------------------------------------

// Setters throw; decoders do not, and that is not a contradiction. The house
// rule "nothing throws on content" governs DECODING untrusted bytes — a corrupt
// save lands in result.errors (plus.js:665-672), never in an exception. A
// setter's argument is not content, it is a caller's instruction, and
// `movement: 200` is a programming error of exactly the kind buildPayload
// throws on when handed nine sections (bup-write.js:71-73).
//
// Rejection, not clamping. FORMAT-PSX.md:598, "ENEMY DATA, field by field",
// gives movement as 0..159 into the pointer table 0x8007D760; a clamp would
// silently substitute 159 and the caller would never learn. Clamping is what
// the READER does defensively (Math.min(settings[1], 5), plus.js:594); an
// editor that clamps writes bytes nobody asked for.

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

/**
 * The file offset of a stage block, with the bounds check the reader does not
 * have. plusStageOffset (plus.js:384-386) has NO guard, and plusStageOffset(5)
 * returns 0x1af2c, which IS PLUS_GLOBAL_OFFSET: an off-by-one stage index
 * writes into the global block, dirties group 0x0b instead of a stage group,
 * and the save still verifies. plusStageOffset(7) returns 0x1f3a4 and
 * decodePlusStage then hands back zero-length views with no error at all.
 * Every stage-scoped setter goes through here.
 */
function stageBase(stage) {
    if (!Number.isInteger(stage) || stage < 0 || stage >= PLUS_STAGES) {
        throw new Error(
            `stage is ${stage}; the range is 0..${PLUS_STAGES - 1} — plusStageOffset(${PLUS_STAGES}) is ` +
                `${hex(PLUS_GLOBAL_OFFSET)}, which is the global block, not a sixth stage`,
        );
    }
    return plusStageOffset(stage);
}

// The eight global pieces by name, so no offset below is a magic number:
// titleType 0x1af2c, titleGroup 0x1af2e, endingGroup 0x1af6e, shipGroup
// 0x1af86, shipOdr 0x1b020, itemTable 0x1b06d, gameSettings 0x1b07d,
// bgmAssignment 0x1b080 (plus.js:175-184, and FORMAT-PSX.md:533-540,
// "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
const GLOBAL_PIECE = Object.freeze(Object.fromEntries(PLUS_GLOBAL_LAYOUT.map((p) => [p.name, p])));

function globalAt(name, within = 0) {
    return PLUS_GLOBAL_OFFSET + GLOBAL_PIECE[name].offset + within;
}

// --- 3.1 graphics and palettes -----------------------------------------------

const GRAPHICS_ROW_BYTES = PLUS_GRAPHICS_WIDTH / 2; // 128: a 4bpp row of 256 px

// SPRITE LAYOUT (stage+0x0E80, 0x140) is the blit geometry that binds sheet
// positions to source chips, and not one of its bytes is named
// (FORMAT-PSX.md:720-721, "Unresolved"). So repaint-in-place is safe but
// BLIND: the editor cannot tell the user which sprite they just repainted.
// Every graphics write says so, and there is no function anywhere in this
// module that changes WHERE a tile lives — relocating art rescrambles enemy
// sprites with a still-valid checksum.
const SPRITE_LAYOUT_WARNING = "the sprite this repaints cannot be named; SPRITE LAYOUT is untraced";

/**
 * A PlayStation RGB555 word from 5-bit components. Colour 0 is transparent
 * whatever this returns.
 *
 * The inverse of rgb555ToRgb (src/decode/decode-cg.js:36-45), which reads
 * `r = raw & 0x1F` in PSX order. Do NOT reuse decodePalettes() from that file:
 * it is big-endian for the Super Famicom (decode-cg.js:63).
 *
 * @param {{r?: number, g?: number, b?: number, stp?: boolean}} colour
 * @returns {number} 0..0xffff
 */
export function plusColorWord({ r = 0, g = 0, b = 0, stp = false } = {}) {
    intIn("r", r, 0, 31);
    intIn("g", g, 0, 31);
    intIn("b", b, 0, 31);
    bool("stp", stp);
    return ((stp ? 0x8000 : 0) | (b << 10) | (g << 5) | r) >>> 0;
}

// plusPaletteRow() (plus.js:342-361) never returns 22 or 23, so no traced
// consumer reads those rows; and rows 5, 11 and 17 are the sixth stage's map,
// enemy and boss rows, which the save has no block for (PLUS_STAGES is 5).
function paletteRowWarnings(row) {
    const warnings = [];
    if (row > 21) warnings.push(`palette row ${row} has no named consumer; nothing in the program draws with it`);
    else if (row === 5 || row === 11 || row === 17) {
        warnings.push(
            `palette row ${row} belongs to a sixth stage; the save carries ${PLUS_STAGES} stage blocks, ` +
                `so nothing loads it`,
        );
    }
    return warnings;
}

/**
 * One RGB555 colour of one palette row.
 * @param {Uint8Array} block
 * @param {number} row    0..23
 * @param {number} index  0..15
 * @param {number} word   0..0xffff (see plusColorWord)
 * @returns {PlusWrite}
 */
export function setPlusPaletteColor(block, row, index, word) {
    assertPlusBlock(block);
    intIn("palette row", row, 0, PLUS_PALETTE_ROWS - 1);
    intIn("colour index", index, 0, 15);
    intIn("colour word", word, 0, 0xffff);
    const at = PLUS_PALETTE_OFFSET + row * PLUS_PALETTE_ROW_BYTES + index * 2;
    const bytes = [word & 0xff, (word >> 8) & 0xff];
    return applyWrite(block, `palette row ${row} colour ${index}`, [{ at, bytes }], paletteRowWarnings(row));
}

/**
 * A whole palette row: sixteen RGB555 words, one 32-byte write.
 * @param {Uint8Array} block
 * @param {number} row              0..23
 * @param {ArrayLike<number>} words exactly 16 values 0..0xffff
 * @returns {PlusWrite}
 */
export function setPlusPaletteRow(block, row, words) {
    assertPlusBlock(block);
    intIn("palette row", row, 0, PLUS_PALETTE_ROWS - 1);
    if (!words || words.length !== 16) {
        throw new Error(`a palette row is 16 words; got ${words ? words.length : words}`);
    }
    const bytes = [];
    for (let i = 0; i < 16; i++) {
        intIn(`colour ${i}`, words[i], 0, 0xffff);
        bytes.push(words[i] & 0xff, (words[i] >> 8) & 0xff);
    }
    const at = PLUS_PALETTE_OFFSET + row * PLUS_PALETTE_ROW_BYTES;
    return applyWrite(block, `palette row ${row}`, [{ at, bytes }], paletteRowWarnings(row));
}

/**
 * One pixel of the 256 x 512 graphics bank: a read-modify-write of one nibble,
 * low nibble for an even x (decodePlusGraphics, plus.js:369-370).
 *
 * @param {Uint8Array} block
 * @param {number} x      0..255
 * @param {number} y      0..511
 * @param {number} index  0..15, a colour index into the row the sprite draws with
 * @returns {PlusWrite}
 */
export function setPlusPixel(block, x, y, index) {
    assertPlusBlock(block);
    intIn("x", x, 0, PLUS_GRAPHICS_WIDTH - 1);
    intIn("y", y, 0, PLUS_GRAPHICS_HEIGHT - 1);
    intIn("colour index", index, 0, 15);
    const at = PLUS_GRAPHICS_OFFSET + y * GRAPHICS_ROW_BYTES + (x >> 1);
    const current = block[at];
    const byte = (x & 1) ? ((current & 0x0f) | (index << 4)) : ((current & 0xf0) | index);
    return applyWrite(block, `pixel (${x},${y})`, [{ at, bytes: [byte] }], [SPRITE_LAYOUT_WARNING]);
}

/**
 * Repaint a rectangle of the graphics bank in place. `indices` is
 * width * height values 0..15, row-major.
 *
 * This is a repaint, not a move: it takes an ABSOLUTE rectangle in the existing
 * bank and has no relocating form, because SPRITE LAYOUT is undecoded (see
 * SPRITE_LAYOUT_WARNING). The record's `groups` holds two or three entries when
 * the rectangle crosses pixel row 128, 256 or 384 — the four 0x4000 graphics
 * quarters are checksum boundaries, not picture boundaries
 * (FORMAT-PSX.md:447-448, "GRAPHICS and PALETTES"), and one seal fixes every
 * group it dirtied.
 *
 * @param {Uint8Array} block
 * @param {{x: number, y: number, width: number, height: number, indices: ArrayLike<number>}} rect
 * @returns {PlusWrite}
 */
export function setPlusPixels(block, { x, y, width, height, indices }) {
    assertPlusBlock(block);
    intIn("x", x, 0, PLUS_GRAPHICS_WIDTH - 1);
    intIn("y", y, 0, PLUS_GRAPHICS_HEIGHT - 1);
    intIn("width", width, 1, PLUS_GRAPHICS_WIDTH - x);
    intIn("height", height, 1, PLUS_GRAPHICS_HEIGHT - y);
    if (!indices || indices.length !== width * height) {
        throw new Error(
            `a ${width}x${height} repaint needs ${width * height} indices; got ${indices ? indices.length : indices}`,
        );
    }
    for (let i = 0; i < indices.length; i++) intIn(`index ${i}`, indices[i], 0, 15);
    const first = x >> 1;
    const last = (x + width - 1) >> 1;
    const ranges = [];
    for (let row = 0; row < height; row++) {
        const at = PLUS_GRAPHICS_OFFSET + (y + row) * GRAPHICS_ROW_BYTES + first;
        const bytes = Array.from(block.subarray(at, at + (last - first + 1)));
        for (let col = 0; col < width; col++) {
            const px = x + col;
            const b = (px >> 1) - first;
            const v = indices[row * width + col];
            bytes[b] = (px & 1) ? ((bytes[b] & 0x0f) | (v << 4)) : ((bytes[b] & 0xf0) | v);
        }
        ranges.push({ at, bytes });
    }
    return applyWrite(block, `pixels ${width}x${height} at (${x},${y})`, ranges, [SPRITE_LAYOUT_WARNING]);
}

// --- 3.2 map -----------------------------------------------------------------

/**
 * One 16x16 chip of a stage map. A row is eight chip bytes, a byte of v-flip
 * bits for them (bit 7 = the leftmost of the eight), then the same again
 * (plus.js:89-92, and FORMAT-PSX.md:481-486, "MAP and MAP GROUP"); a chip
 * byte's bit 7 is the horizontal flip and its low seven bits index MAP GROUP.
 *
 * ENFORCED: a non-zero `group` or a set `vflip` in column 0 or 15 throws.
 * Those two columns carry no chip in any known save — 16 chips of 16 px is
 * 256 px and the playfield is 224 (FORMAT-PSX.md:488-491, "MAP and MAP GROUP")
 * — and refusing them also keeps byte 8 bit 7 and byte 17 bit 0 clear,
 * which is the statistical evidence the flip-bit order itself rests on.
 *
 * `group` needs no clamp beyond 0..127: the low seven bits index MAP GROUP,
 * which is 0x100 bytes = exactly 128 words. Field width equals table size.
 *
 * @param {Uint8Array} block
 * @param {number} stage   0..4
 * @param {number} column  0..15
 * @param {number} row     0..127
 * @param {{group: number, hflip?: boolean, vflip?: boolean}} cell
 * @returns {PlusWrite}
 */
export function setPlusMapCell(block, stage, column, row, { group, hflip = false, vflip = false }) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("column", column, 0, PLUS_MAP_COLUMNS - 1);
    intIn("row", row, 0, PLUS_MAP_ROWS - 1);
    intIn("group", group, 0, 0x7f);
    bool("hflip", hflip);
    bool("vflip", vflip);
    if ((column === 0 || column === PLUS_MAP_COLUMNS - 1) && (group !== 0 || vflip)) {
        throw new Error(
            `column ${column} carries no chip in any known save; the playfield is 224 px wide, ` +
                `so columns 0 and ${PLUS_MAP_COLUMNS - 1} of the 256 px row are always empty`,
        );
    }
    const half = PLUS_MAP_HALVES[column < 8 ? 0 : 1];
    const within = column & 7;
    const rowAt = base + PLUS_STAGE_PIECE.map.offset + row * PLUS_MAP_ROW_BYTES;
    const chipAt = rowAt + half.chips[within];
    const flagAt = rowAt + half.flags;
    const bit = 1 << (7 - within);
    const flags = vflip ? (block[flagAt] | bit) : (block[flagAt] & ~bit & 0xff);
    return applyWrite(block, `map stage ${stage} (${column},${row})`, [
        { at: chipAt, bytes: [group | (hflip ? 0x80 : 0)] },
        { at: flagAt, bytes: [flags] },
    ]);
}

/**
 * One MAP GROUP word: which 16x16 tile of the graphics bank a chip id draws.
 * Bits 0-2 and 7 are the tile column, bits 3-6 the row, bits 8-9 the texture
 * page (decodePlusGroupWord, plus.js:401-417).
 *
 * ENFORCED, "preserve, never synthesize": `page` omitted keeps the existing
 * word's bits 8-9 exactly as they sit. Given, it must be 0..3 AND must already
 * occur in this stage's MAP GROUP, or it throws — which pair of the program's
 * four tile buffers a save uses is edition-dependent (FORMAT-PSX.md:741-743,
 * "Unresolved"), so a page the stage has never named is a page nothing proves
 * is loaded.
 *
 * Bits above 9 in the existing word are PRESERVED, not normalised.
 * decodePlusGroupWord clamps to 0x3FF (plus.js:402) and 0xFFFF genuinely occurs
 * (test/psx-plus.test.js:182-183); rewriting it to 0x03FF changes bytes,
 * changes a checksum, and changes nothing the game sees.
 *
 * @param {Uint8Array} block
 * @param {number} stage  0..4
 * @param {number} index  0..127
 * @param {{column: number, row: number, page?: number}} tile
 * @returns {PlusWrite}
 */
export function setPlusMapGroupTile(block, stage, index, { column, row, page }) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    const piece = PLUS_STAGE_PIECE.mapGroup;
    const words = piece.length / 2; // 0x100 bytes = 128 words, one per chip id
    intIn("index", index, 0, words - 1);
    intIn("column", column, 0, 15);
    intIn("row", row, 0, 15);
    const at = base + piece.offset + index * 2;
    const current = u16le(block, at);
    // The page is bits 8-9 AS THEY LITERALLY SIT, not decodePlusGroupWord().page:
    // that decoder clamps to 0x3FF first (plus.js:402), so it reports page 3 for
    // any word above the clamp — 0xFC00's page field is 0, and reading it as 3
    // would rewrite two bits the caller never mentioned, which is the one thing
    // an omitted argument must not do. Same reading for the occurrence scan
    // below, so a single out-of-range word cannot authorise a page.
    let pageBits = (current >> 8) & 3;
    if (page !== undefined && page !== null) {
        intIn("page", page, 0, 3);
        let seen = false;
        for (let i = 0; i < words && !seen; i++) {
            if (((u16le(block, base + piece.offset + i * 2) >> 8) & 3) === page) seen = true;
        }
        if (!seen) {
            throw new Error(
                `page ${page} does not occur in stage ${stage}; which pair of tile buffers a save uses is ` +
                    `edition-dependent (FORMAT-PSX.md:741-743, "Unresolved"), so a page the save never ` +
                    `names is not a page to add`,
            );
        }
        pageBits = page;
    }
    const low = (column & 7) | ((column & 8) << 4) | ((row & 0x0f) << 3);
    const next = (current & 0xfc00) | (pageBits << 8) | low;
    const warnings = [];
    if (current > PLUS_TILE_MAX) {
        warnings.push(
            `word ${index} was ${hex(current)}, above the reader's ${hex(PLUS_TILE_MAX)} clamp (plus.js:402); ` +
                `its bits above 9 are preserved, so the game still reads tile ${hex(PLUS_TILE_MAX)}`,
        );
    }
    return applyWrite(block, `map group stage ${stage} word ${index}`, [{
        at,
        bytes: [next & 0xff, (next >> 8) & 0xff],
    }], warnings);
}

// --- 3.3 scroll --------------------------------------------------------------

/** Four map rows per block, 128 rows: the 32 blocks a scroll step can name. */
export const PLUS_SCROLL_BLOCKS = 32;

/**
 * One SCROLL step: which of the 32 four-row map blocks the stage shows at that
 * 64 px of scroll
 * (FORMAT-PSX.md:507-509, "SCROLL, APPEAR, ENEMY DATA, SPRITE LAYOUT, GROUPS").
 *
 * The 0..31 ceiling is GEOMETRIC — 128 map rows / 4 rows per block — not a
 * traced mask, so it is graded `likely`. An existing byte already above it only
 * warns rather than making the file unopenable. What exceeding it does is
 * traced: the five stage maps are contiguous in RAM (0x80145C88 + s*0x900,
 * plus.js:163), so 32..159 reads another stage's scenery and 160+ reads past
 * the array. It is a read, so the failure is silent garbage, not a crash.
 *
 * SCROLL's 256 effect bytes are deliberately not exposed:
 * FORMAT-PSX.md:508, "SCROLL, APPEAR, ENEMY DATA, SPRITE LAYOUT, GROUPS",
 * says only "then 256 effect bytes" — no meaning, no range, no reader.
 *
 * @param {Uint8Array} block
 * @param {number} stage     0..4
 * @param {number} step      0..255
 * @param {number} mapBlock  0..31
 * @returns {PlusWrite}
 */
export function setPlusScrollBlock(block, stage, step, mapBlock) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("step", step, 0, 255);
    intIn("map block", mapBlock, 0, PLUS_SCROLL_BLOCKS - 1);
    const at = base + PLUS_STAGE_PIECE.scroll.offset + step;
    const warnings = [];
    if (block[at] > PLUS_SCROLL_BLOCKS - 1) {
        warnings.push(
            `step ${step} already held ${block[at]}; the 0..${PLUS_SCROLL_BLOCKS - 1} ceiling is geometric ` +
                `(128 map rows / 4 rows a block), not a traced mask`,
        );
    }
    return applyWrite(block, `scroll stage ${stage} step ${step}`, [{ at, bytes: [mapBlock] }], warnings);
}

// --- 3.4 appear --------------------------------------------------------------

/**
 * A canonical APPEAR record byte for a size class and a definition.
 *
 * NOT the inverse of decodePlusAppearByte for classes B and C: their masks are
 * 0x07 and 0x03 (plus.js:109-110), so 0xB0 and 0xB8 both decode to definition
 * 48 and 0xC0 and 0xC4 both to 56. Round-tripping a real byte through
 * {size, definition} silently rewrites the spare bits — which is why
 * setPlusAppearByte takes a RAW byte instead.
 *
 * @param {string} size        one of PLUS_APPEAR_CLASSES[].size
 * @param {number} definition  inside that class's span
 * @returns {number} 0..0xff
 */
export function plusAppearByte(size, definition) {
    const spec = PLUS_APPEAR_CLASSES.find((c) => c.size === size);
    if (!spec) {
        throw new Error(
            `${size} is not an appear size class; the classes are ${PLUS_APPEAR_CLASSES.map((c) => c.size).join(", ")}`,
        );
    }
    intIn(`a ${size} definition`, definition, spec.base, spec.base + spec.mask);
    return (spec.nibble << 4) | (definition - spec.base);
}

/**
 * One byte of one APPEAR record: 256 records of 14 bytes, a byte per 16 px
 * column, spawning at x = 16(column+1) px (plus.js:552-554).
 *
 * ENFORCED: the byte must be 0x00, PLUS_APPEAR_END_MARK (0xFF), or carry a
 * class nibble in 8..D. decodePlusAppearByte returns {unknown: true} for
 * nibbles 1-7, E and F (plus.js:537) — that is the format's own don't-touch
 * signal, and this is where it becomes a refusal.
 *
 * No range check on the definition is needed: every class's base + mask lands
 * inside 0..59 against 60 definitions (56 + 3 = 59), the one multi-class index
 * in the format that cannot go out of range (test/psx-plus.test.js:199-208).
 *
 * @param {Uint8Array} block
 * @param {number} stage   0..4
 * @param {number} record  0..255
 * @param {number} column  0..13
 * @param {number} byte    0x00, 0xFF, or a class byte
 * @returns {PlusWrite}
 */
export function setPlusAppearByte(block, stage, record, column, byte) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("record", record, 0, PLUS_APPEAR_RECORDS - 1);
    intIn("column", column, 0, PLUS_APPEAR_RECORD_SIZE - 1);
    intIn("byte", byte, 0, 0xff);
    if (byte !== 0 && byte !== PLUS_APPEAR_END_MARK) {
        const nibble = byte >> 4;
        const known = PLUS_APPEAR_CLASSES.some((c) => c.nibble === nibble) || nibble === PLUS_APPEAR_BOSS_NIBBLE;
        if (!known) {
            throw new Error(
                `${hex(byte)} has class nibble ${hex(nibble)}; only 8-D name a definition, and the reader ` +
                    `returns {unknown: true} for the rest (plus.js:537)`,
            );
        }
    }
    const at = base + PLUS_STAGE_PIECE.appear.offset + record * PLUS_APPEAR_RECORD_SIZE + column;
    return applyWrite(block, `appear stage ${stage} record ${record} column ${column}`, [{ at, bytes: [byte] }]);
}

/**
 * One entry of the APPEAR row table: which record the stage plays at that
 * 16 px of scroll. 1,024 entries x 16 px = 16,384 px, the stage length the
 * scroll table also gives
 * (FORMAT-PSX.md:511-515, "SCROLL, APPEAR, ENEMY DATA, SPRITE LAYOUT, GROUPS").
 *
 * Field width equals table size exactly — 1,024 entries naming 256 records in
 * 0x400 bytes — so no value is out of range and nothing here can be refused.
 *
 * @param {Uint8Array} block
 * @param {number} stage   0..4
 * @param {number} row     0..1023
 * @param {number} record  0..255
 * @returns {PlusWrite}
 */
export function setPlusAppearRow(block, stage, row, record) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("row", row, 0, PLUS_APPEAR_ROW_TABLE - 1);
    intIn("record", record, 0, PLUS_APPEAR_RECORDS - 1);
    const tableAt = PLUS_APPEAR_RECORDS * PLUS_APPEAR_RECORD_SIZE; // 0xE00
    const at = base + PLUS_STAGE_PIECE.appear.offset + tableAt + row;
    return applyWrite(block, `appear stage ${stage} row ${row}`, [{ at, bytes: [record] }], [
        "whether 0xFF or 0x00 means 'no record' here is not stated — open",
    ]);
}

// --- 3.5 enemy data ----------------------------------------------------------

/** The movement-script pointer table at 0x8007D760 has this many entries. */
export const PLUS_MOVEMENT_SCRIPTS = 160;
/** The spawner's shot-pattern function table at 0x8007DCA4 has this many. */
export const PLUS_SHOT_PATTERNS = 20;

// The two rules below are the ONLY two places in the whole save where a
// legal-looking value reaches an indirect jump. plus.js:494 reads byte 0 with
// no clamp at all and plus.js:495 masks byte 1 to 0x1F and stops, so both
// escape the reader; 160..255 fetches a word past the movement table's end and
// the game jumps through it.
function assertMovementScript(value) {
    if (value > PLUS_MOVEMENT_SCRIPTS - 1) {
        throw new Error(
            `movement script ${value}; the pointer table at 0x8007D760 has ${PLUS_MOVEMENT_SCRIPTS} entries ` +
                `(FORMAT-PSX.md:598, "ENEMY DATA, field by field")`,
        );
    }
}

function assertShotPattern(value) {
    if ((value & 0x1f) > PLUS_SHOT_PATTERNS - 1) {
        throw new Error(
            `shot pattern ${value & 0x1f}; the spawner's function table at 0x8007DCA4 has ${PLUS_SHOT_PATTERNS} ` +
                `entries (FORMAT-PSX.md:599, "ENEMY DATA, field by field")`,
        );
    }
}

// Advisory only: refusing these would refuse saves that already contain them.
// Byte 4 bits 3-4 and byte 7 bits 0-1 each have THREE named values in a 2-bit
// field (FORMAT-PSX.md:609, :615, "ENEMY DATA, field by field"), so 3 is
// undefined; byte 1 bits 5-7 is a 3-bit field into two tables whose lengths
// FORMAT-PSX.md:600, in the same table, does not give.
function enemyByteWarnings(byte, value) {
    const warnings = [];
    if (byte === 1 && (value >> 5) !== 0) {
        warnings.push(
            `fire rate ${value >> 5}; byte 1 bits 5-7 index 0x8007B374 / 0x8007B384, whose lengths are ` +
                `not stated (FORMAT-PSX.md:600, "ENEMY DATA, field by field") — the value is written ` +
                `as given`,
        );
    }
    if (byte === 4 && ((value >> 3) & 3) === 3) {
        warnings.push(
            "turn-end action 3; byte 4 bits 3-4 name only stop, sweep back and restart " +
                `(FORMAT-PSX.md:609, "ENEMY DATA, field by field") — what the fourth does is undefined`,
        );
    }
    if (byte === 7 && (value & 3) === 3) {
        warnings.push(
            "start trigger 3; byte 7 bits 0-1 name only immediately, y = 31 and y = 70 px " +
                `(FORMAT-PSX.md:615, "ENEMY DATA, field by field") — what the fourth does is undefined`,
        );
    }
    return warnings;
}

function enemyAt(base, definition, byte = 0) {
    return base + PLUS_STAGE_PIECE.enemyData.offset + definition * PLUS_ENEMY_SIZE + byte;
}

/**
 * One byte of one enemy definition. Round-trip through BYTES, never through
 * decodePlusEnemy's named fields: that decoder double-counts bit 6 of byte 3
 * (hitFlags is b[3] >> 5 AND immuneToShots is b[3] & 0x40, plus.js:504-505),
 * eight of its fields decode to TABLE VALUES rather than indices
 * (hitPoints: PLUS_ENEMY_HP[b[3] & 7], plus.js:502) and so have no inverse at
 * all, and byte 5's shot parameter is "split 3 + 4 bits (halves unnamed)"
 * (FORMAT-PSX.md:611, "ENEMY DATA, field by field"). There is deliberately no
 * setPlusEnemy({movement, ...}).
 *
 * @param {Uint8Array} block
 * @param {number} stage       0..4
 * @param {number} definition  0..59
 * @param {number} byte        0..7
 * @param {number} value       0..255
 * @returns {PlusWrite}
 */
export function setPlusEnemyByte(block, stage, definition, byte, value) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("definition", definition, 0, PLUS_ENEMY_COUNT - 1);
    intIn("byte", byte, 0, PLUS_ENEMY_SIZE - 1);
    intIn("value", value, 0, 0xff);
    if (byte === 0) assertMovementScript(value);
    if (byte === 1) assertShotPattern(value);
    return applyWrite(
        block,
        `enemy stage ${stage} definition ${definition} byte ${byte}`,
        [{ at: enemyAt(base, definition, byte), bytes: [value] }],
        enemyByteWarnings(byte, value),
    );
}

/**
 * A whole 8-byte enemy definition. The same two index rules apply to bytes[0]
 * and bytes[1] as to setPlusEnemyByte.
 *
 * @param {Uint8Array} block
 * @param {number} stage             0..4
 * @param {number} definition        0..59
 * @param {ArrayLike<number>} bytes  exactly 8 values 0..255
 * @returns {PlusWrite}
 */
export function setPlusEnemyDefinition(block, stage, definition, bytes) {
    assertPlusBlock(block);
    const base = stageBase(stage);
    intIn("definition", definition, 0, PLUS_ENEMY_COUNT - 1);
    if (!bytes || bytes.length !== PLUS_ENEMY_SIZE) {
        throw new Error(`an enemy definition is ${PLUS_ENEMY_SIZE} bytes; got ${bytes ? bytes.length : bytes}`);
    }
    const values = [];
    for (let i = 0; i < PLUS_ENEMY_SIZE; i++) values.push(intIn(`byte ${i}`, bytes[i], 0, 0xff));
    assertMovementScript(values[0]);
    assertShotPattern(values[1]);
    const warnings = [];
    for (let i = 0; i < PLUS_ENEMY_SIZE; i++) warnings.push(...enemyByteWarnings(i, values[i]));
    return applyWrite(
        block,
        `enemy stage ${stage} definition ${definition}`,
        [{ at: enemyAt(base, definition), bytes: values }],
        warnings,
    );
}

// --- 3.6 sound ---------------------------------------------------------------

/**
 * Replace one whole song slot. `from` is a slot index in this block, or 0x2E0
 * bytes.
 *
 * Whole-slot is the ONLY granularity, and there is no setPlusSongByte. The
 * container is exact — 0xB80 / 0x2E0 = 4, so every song lies wholly inside one
 * checksum entry (songs 0-3 are group 0x0c, 4-7 0x0d, 8-11 0x0e, 12-15 0x0f) —
 * and 2 of each 736 bytes are slack (734 used).
 *
 * The interior IS traced now, in src/psx/plus-song.js and FORMAT-PSX.md's
 * "SOUND, the song format": the bar header's 4/2/4/4 bits are a backing-pattern
 * index, the tail's 3/5/4/4 are volume, tempo and the two loop bars, and the
 * note table is DEZA.EXE (SLPS-00335) 0x800F03BA. A whole-slot copy still needs
 * nothing from that, so this stays byte-level; use decodePlusSongs and
 * encodePlusSong to build a slot from anything but another slot.
 *
 * @param {Uint8Array} block
 * @param {number} to                        0..15
 * @param {number|Uint8Array} from           a slot 0..15, or exactly PLUS_SONG_SIZE bytes
 * @returns {PlusWrite}
 */
export function copyPlusSong(block, to, from) {
    assertPlusBlock(block);
    intIn("destination song", to, 0, PLUS_SONG_COUNT - 1);
    let source;
    let what;
    if (from instanceof Uint8Array) {
        if (from.length !== PLUS_SONG_SIZE) {
            throw new Error(`a song is ${PLUS_SONG_SIZE} bytes; got ${from.length}`);
        }
        source = Array.from(from);
        what = `${PLUS_SONG_SIZE} bytes`;
    } else {
        intIn("source song", from, 0, PLUS_SONG_COUNT - 1);
        const at = PLUS_SOUND_OFFSET + from * PLUS_SONG_SIZE;
        source = Array.from(block.subarray(at, at + PLUS_SONG_SIZE));
        what = `song ${from}`;
    }
    return applyWrite(block, `song ${to} from ${what}`, [{
        at: PLUS_SOUND_OFFSET + to * PLUS_SONG_SIZE,
        bytes: source,
    }], [
        "a copied song is assumed self-contained; the bar header's fields are untraced, so a field that " +
        "indexes something save-side cannot be ruled out",
    ]);
}

// --- 3.7 high scores ---------------------------------------------------------

/**
 * One entry of high-score TABLE B (0x1DF30), the user game's ladder: u32le
 * score, the 0-based stage reached, three always-zero bytes, an 8-byte name
 * (FORMAT-PSX.md:577-578, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 *
 * `name` is EIGHT BYTES, never a JS string. plus.js:631 decodes it with
 * latin1(), a raw byte -> charCode pass-through (memcard.js:49-53); it is not
 * Shift-JIS and the Dezaemon+ font is untraced, so a string parameter would
 * invite typing text the game's font maps to garbage.
 *
 * Table A (0x1DE90) is deliberately not reachable from here, and there is no
 * {table} option: only B is swapped in and out as games load, so a tool that
 * rewrites scores should touch B — a claim graded `likely` and resting on
 * 53-vs-8 variation across the corpus (FORMAT-PSX.md:579-582, "GLOBAL, SOUND,
 * HIGH SCORE, SETTINGS"; the grading itself is FORMAT-PSX.md:746-748,
 * "Unresolved"). An option would turn that rule into a comment.
 *
 * `stage` and `name` OMITTED mean preserve, unvalidated — the same rule as
 * setPlusItemSlot's `enableByte` and setPlusMapGroupTile's `page`, and for the
 * same reason: the entry goes out as one 16-byte range, so a caller who only
 * wants to correct a score would otherwise have to hand back two fields it
 * never asked about, and a byte already in the file gains nothing from a range
 * check. Measured, before this rule existed: `psx:probe edit --set
 * hiscore.1=5000:4` on a five-stage save, then `--set stage-count=1`, then
 * `--set hiscore.1=6000` was REFUSED with "stage is 4; the range is 0..1" —
 * naming a value nobody typed, about a field nobody asked to change, and
 * leaving that ladder's scores uneditable without also clobbering the stage
 * byte. A SUPPLIED stage is still checked; the game verifies neither byte.
 *
 * @param {Uint8Array} block
 * @param {number} rank  1..10
 * @param {{score: number, stage?: number, name?: Uint8Array|number[]}} entry
 * @returns {PlusWrite}
 */
export function setPlusHiScore(block, rank, { score, stage, name }) {
    assertPlusBlock(block);
    intIn("rank", rank, 1, PLUS_HISCORE_COUNT);
    intIn("score", score, 0, 0xffffffff);
    // Resolved here and not at the write, because the preserve arms below read
    // the entry: rank is validated one line up, so `at` cannot run off the table.
    const at = PLUS_HISCORE_OFFSET + PLUS_HISCORE_TABLE_BYTES + (rank - 1) * PLUS_HISCORE_SIZE;
    if (stage === undefined || stage === null) stage = block[at + 4];
    else {
        // A stage equal to the count prints as ALL (FORMAT-PSX.md:578-579,
        // "GLOBAL, SOUND, HIGH SCORE, SETTINGS"). stageCount is settings[2] + 1
        // (plus.js:595) so it can reach 256; the field is a byte.
        const ceiling = Math.min(decodePlusGlobals(block).stageCount, 0xff);
        intIn("stage", stage, 0, ceiling);
    }
    if (name === undefined || name === null) name = block.slice(at + 8, at + 16);
    if (typeof name === "string") {
        throw new Error("a high-score name is eight bytes, not a string; the Dezaemon+ font is untraced");
    }
    if (name.length !== 8) {
        throw new Error(`a high-score name is eight bytes; got ${name.length}`);
    }
    // The whole 16-byte entry goes out as one range, so the u32 score is laid
    // down through putU32le into a scratch rather than written into the block
    // twice. Bytes +5..+7 are forced to zero: "three always-zero bytes"
    // (FORMAT-PSX.md:578).
    const head = new Uint8Array(4);
    putU32le(head, 0, score);
    const bytes = [head[0], head[1], head[2], head[3], stage, 0, 0, 0];
    for (let i = 0; i < 8; i++) bytes.push(intIn(`name byte ${i}`, name[i], 0, 0xff));
    return applyWrite(block, `hi-score rank ${rank} (table B)`, [{ at, bytes }]);
}

// --- 3.8 globals -------------------------------------------------------------

/**
 * How many stages the game plays. The byte at 0x1B07F is the count MINUS ONE
 * (FORMAT-PSX.md:546-548, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 *
 * ENFORCED: 1..5, and 6 throws. This contradicts every per-stage consumer in
 * the PROGRAM, which is six wide — PLUS_BGM_SLOTS lists stage 0-5 and boss 0-5
 * (plus.js:132-136), the palette assignment runs 12 + stage over 24 rows
 * (plus.js:342-361) — and it contradicts test/psx-fixtures.test.js:256-259,
 * which asserts stageCount <= 6. The FILE is what settles it: PLUS_STAGES is 5
 * (plus.js:58) and 5 * 0x223C = 0xAB2C lands exactly on PLUS_GLOBAL_OFFSET, so
 * there is no sixth block to load. The RAM depth is 6 exactly, derived from the
 * scatter table's own addresses (MAP 0x80145C88 + 6*0x900 = 0x80149288 =
 * SCROLL's base, plus.js:163-164; ENEMY GROUP 0x801212E0 + 6*0x80 = 0x801215E0
 * = TITLE GROUP's base, plus.js:166, :177) — neither adjacency is exact at
 * depth 5 or 7. So slot 5 is real and never filled: a 6-stage save plays a
 * stage that is zeros after a cold boot and the previously loaded game after a
 * warm one, and it passes every checksum and every parser check.
 *
 * This REFUSES to write 6; it never rewrites a save that already holds one.
 *
 * @param {Uint8Array} block
 * @param {number} count  1..5
 * @returns {PlusWrite}
 */
export function setPlusStageCount(block, count) {
    assertPlusBlock(block);
    if (!Number.isInteger(count) || count < 1 || count > PLUS_STAGES) {
        throw new Error(
            `stage count is ${count}; a save holds ${PLUS_STAGES} stage blocks (${PLUS_STAGES} * ` +
                `${hex(0x223c)} = ${hex(PLUS_STAGES * 0x223c)} ends exactly at ${hex(PLUS_GLOBAL_OFFSET)}) — ` +
                `stage 5's slot exists in RAM but the file never fills it`,
        );
    }
    return applyWrite(block, "stage count", [{ at: globalAt("gameSettings", 2), bytes: [count - 1] }]);
}

/**
 * The SCORE item's bonus, as an INDEX into PLUS_SCORE_BONUS (plus.js:130), not
 * as a bonus. plus.js:592 masks the byte with &7, so the decoded value has no
 * inverse.
 *
 * @param {Uint8Array} block
 * @param {number} index  0..7
 * @returns {PlusWrite}
 */
export function setPlusScoreBonus(block, index) {
    assertPlusBlock(block);
    intIn("score bonus index", index, 0, PLUS_SCORE_BONUS.length - 1);
    return applyWrite(block, "score bonus", [{ at: globalAt("gameSettings", 0), bytes: [index] }]);
}

/**
 * The charge weapon's hold time, as the raw 0..5 byte. plus.js:594 reads it as
 * (5 - Math.min(v, 5)) * 45 + 40 frames — it CLAMPS because the arithmetic goes
 * negative above 5. This setter refuses instead, and takes the byte rather than
 * the frame count for the same reason the clamp exists: the decoded value is
 * non-invertible.
 *
 * @param {Uint8Array} block
 * @param {number} value  0..5
 * @returns {PlusWrite}
 */
export function setPlusChargeTime(block, value) {
    assertPlusBlock(block);
    intIn("charge time", value, 0, 5);
    return applyWrite(block, "charge time", [{ at: globalAt("gameSettings", 1), bytes: [value] }]);
}

/**
 * One of the seven item slots: a u16 whose low byte is an effect id through the
 * handler table 0x8007DC54 and whose high byte is an enable flag
 * (FORMAT-PSX.md:542-545, "GLOBAL, SOUND, HIGH SCORE, SETTINGS"). The leading
 * word of ITEM TABLE is unused — the reader loops i = 1..7 (plus.js:579) — so
 * slot k is word k + 1.
 *
 * ENFORCED: slot 0 restricts `effect` to 1..6. "Slot 0's id also seeds the
 * weapon a new game starts with" (FORMAT-PSX.md:545) and plus.js:590 computes
 * startingWeapon = effect - 1, so effects 7-11 would yield a starting-weapon
 * index of 6-10 against six weapons, and whether the game clamps that is
 * untraced.
 *
 * `enableByte` OMITTED means preserve the existing high byte. decodePlusGlobals
 * collapses it to a boolean (enabled: (word >> 8) !== 0, plus.js:582), so
 * writing back from a decoded object would destroy whatever value was there.
 * One meaning per parameter; no boolean overload.
 *
 * @param {Uint8Array} block
 * @param {number} slot  0..6
 * @param {{effect: number, enableByte?: number}} item
 * @returns {PlusWrite}
 */
export function setPlusItemSlot(block, slot, { effect, enableByte }) {
    assertPlusBlock(block);
    intIn("slot", slot, 0, 6);
    intIn("effect", effect, 0, PLUS_ITEM_EFFECTS.length - 1);
    if (slot === 0 && (effect < 1 || effect > 6)) {
        throw new Error(
            `item slot 0's effect is ${effect}; slot 0's id also seeds the weapon a new game starts with ` +
                `(FORMAT-PSX.md:545, "GLOBAL, SOUND, HIGH SCORE, SETTINGS"; startingWeapon = effect - 1 ` +
                `at plus.js:590), so it must be a weapon, 1..6`,
        );
    }
    const at = globalAt("itemTable", (slot + 1) * 2);
    let high = block[at + 1];
    if (enableByte !== undefined && enableByte !== null) high = intIn("enable byte", enableByte, 0, 0xff);
    return applyWrite(block, `item slot ${slot}`, [{ at, bytes: [effect, high] }]);
}

/**
 * BGM ASSIGNMENT song numbers run 0..50
 * (FORMAT-PSX.md:548-550, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 */
export const PLUS_BGM_SONG_MAX = 50;

/**
 * One of the sixteen BGM assignments: which song plays for a stage, a boss, the
 * title, game over, the ending or the session-start preload.
 *
 * @param {Uint8Array} block
 * @param {number|string} slot  0..15, or a name from PLUS_BGM_SLOTS
 * @param {number} song         0..50
 * @returns {PlusWrite}
 */
export function setPlusBgmSlot(block, slot, song) {
    assertPlusBlock(block);
    let index = slot;
    if (typeof slot === "string") {
        index = PLUS_BGM_SLOTS.indexOf(slot);
        if (index < 0) throw new Error(`${slot} is not a BGM slot; the slots are ${PLUS_BGM_SLOTS.join(", ")}`);
    }
    intIn("bgm slot", index, 0, PLUS_BGM_SLOTS.length - 1);
    intIn("song", song, 0, PLUS_BGM_SONG_MAX);
    const warnings = [];
    if (index === 5 || index === 11) {
        warnings.push(
            `slot ${index} is "${PLUS_BGM_SLOTS[index]}"; the save carries ${PLUS_STAGES} stage blocks, ` +
                `so nothing ever plays it`,
        );
    }
    if (song >= 16 && song <= 31) {
        warnings.push(
            `song ${song} is in the second bank (16-31), which the file does not carry — only 0-15 are this ` +
                `save's own songs and 32-50 live inside the program`,
        );
    }
    return applyWrite(block, `bgm slot ${index} (${PLUS_BGM_SLOTS[index]})`, [{
        at: globalAt("bgmAssignment", index),
        bytes: [song],
    }], warnings);
}

/**
 * One of the six TITLE TYPE entry-animation selectors: a 2-bit field, three per
 * byte, values 0..2 (FORMAT-PSX.md:533, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 *
 * ENFORCED: this is a 2-bit write, never a whole-byte write, so bits 6-7 of
 * each byte — unread, since only three selectors fit — are preserved by
 * construction. Value 3 is undefined and throws.
 *
 * @param {Uint8Array} block
 * @param {number} index  0..5
 * @param {number} value  0..2
 * @returns {PlusWrite}
 */
export function setPlusTitleType(block, index, value) {
    assertPlusBlock(block);
    intIn("title type index", index, 0, 5);
    intIn("title type value", value, 0, 2);
    const at = globalAt("titleType", (index / 3) | 0);
    const shift = (index % 3) * 2;
    const byte = (block[at] & ~(3 << shift) & 0xff) | (value << shift);
    return applyWrite(block, `title type ${index}`, [{ at, bytes: [byte] }]);
}

/**
 * OR one bit into MY SHIP ODR. SETS ONLY.
 *
 * There is deliberately no clearPlusShipOdrBit and no setPlusShipOdr(bytes).
 * MY SHIP ODR is "OR'd over the program's default sheet"
 * (FORMAT-PSX.md:537, "GLOBAL, SOUND, HIGH SCORE, SETTINGS"),
 * so writing a 0 where the default has a 1 is a no-op — a clear function would
 * let a user untick something, save, reload, see it unticked in the editor and
 * still see it in the game. The absence of the function IS the enforcement.
 *
 * @param {Uint8Array} block
 * @param {number} index  0..76
 * @param {number} bit    0..7
 * @returns {PlusWrite}
 */
export function setPlusShipOdrBit(block, index, bit) {
    assertPlusBlock(block);
    intIn("odr index", index, 0, GLOBAL_PIECE.shipOdr.length - 1);
    intIn("bit", bit, 0, 7);
    const at = globalAt("shipOdr", index);
    return applyWrite(block, `my ship odr ${index} bit ${bit}`, [{ at, bytes: [block[at] | (1 << bit)] }]);
}

// The three global tile-word tables, by the name a caller passes. Lengths come
// from PLUS_GLOBAL_LAYOUT: titleGroup 0x40 = 32 words, endingGroup 0x18 = 12,
// shipGroup 0x9A = 77 (FORMAT-PSX.md:534-536, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
const GROUP_TABLES = Object.freeze({
    title: "titleGroup",
    ending: "endingGroup",
    ship: "shipGroup",
});

/** MY SHIP GROUP words the runtime overwrites: file offsets 0x1b000/2/4. */
export const PLUS_SHIP_GROUP_FORCED = Object.freeze([61, 62, 63]);

function groupTable(which) {
    const name = GROUP_TABLES[which];
    if (!name) {
        throw new Error(`${which} is not a group table; the tables are ${Object.keys(GROUP_TABLES).join(", ")}`);
    }
    const piece = GLOBAL_PIECE[name];
    return { name, which, at: PLUS_GLOBAL_OFFSET + piece.offset, words: piece.length >> 1 };
}

function assertGroupIndex(table, index, label = "index") {
    intIn(label, index, 0, table.words - 1);
    if (table.which === "ship" && PLUS_SHIP_GROUP_FORCED.includes(index)) {
        const at = table.at + index * 2;
        throw new Error(
            `the runtime forces MY SHIP GROUP words ${PLUS_SHIP_GROUP_FORCED[0]}-` +
                `${PLUS_SHIP_GROUP_FORCED[PLUS_SHIP_GROUP_FORCED.length - 1]} to 0x3FC..0x3FE ` +
                `(FORMAT-PSX.md:536, "GLOBAL, SOUND, HIGH SCORE, SETTINGS"); an edit at ${hex(at)} ` +
                `persists, moves a checksum, and does nothing`,
        );
    }
}

function groupTableWarnings(table) {
    if (table.which !== "ending") return [];
    return ["ENDING GROUP is drawn only on the user game's ending; the edit is invisible until the game is cleared"];
}

/**
 * Flip one word of TITLE GROUP, ENDING GROUP or MY SHIP GROUP, without
 * touching its index. The encoding is `w & 0x3FFF` index, 0x4000 h-flip,
 * 0x8000 v-flip (FORMAT-PSX.md:534, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 *
 * ENFORCED, "permute, do not synthesize": this touches only bits 0x4000 and
 * 0x8000, and THERE IS NO SETTER THAT WRITES AN INDEX HALF, because what 14-bit
 * space those indices address is stated nowhere for any of the three tables.
 * An omitted `hflip` or `vflip` preserves that bit.
 *
 * @param {Uint8Array} block
 * @param {"title"|"ending"|"ship"} which
 * @param {number} index
 * @param {{hflip?: boolean, vflip?: boolean}} flips
 * @returns {PlusWrite}
 */
export function setPlusGroupFlip(block, which, index, { hflip, vflip } = {}) {
    assertPlusBlock(block);
    const table = groupTable(which);
    assertGroupIndex(table, index);
    const at = table.at + index * 2;
    let word = u16le(block, at);
    if (hflip !== undefined && hflip !== null) word = bool("hflip", hflip) ? (word | 0x4000) : (word & ~0x4000);
    if (vflip !== undefined && vflip !== null) word = bool("vflip", vflip) ? (word | 0x8000) : (word & ~0x8000);
    word &= 0xffff;
    return applyWrite(block, `${which} group word ${index} flips`, [{
        at,
        bytes: [word & 0xff, (word >> 8) & 0xff],
    }], groupTableWarnings(table));
}

/**
 * Exchange two words that are already in one of the three group tables — the
 * other half of "permute, do not synthesize".
 *
 * @param {Uint8Array} block
 * @param {"title"|"ending"|"ship"} which
 * @param {number} a
 * @param {number} b
 * @returns {PlusWrite}
 */
export function swapPlusGroupWords(block, which, a, b) {
    assertPlusBlock(block);
    const table = groupTable(which);
    assertGroupIndex(table, a, "a");
    assertGroupIndex(table, b, "b");
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const loAt = table.at + lo * 2;
    const hiAt = table.at + hi * 2;
    const loWord = u16le(block, loAt);
    const hiWord = u16le(block, hiAt);
    const ranges = lo === hi ? [{ at: loAt, bytes: [loWord & 0xff, (loWord >> 8) & 0xff] }] : [
        { at: loAt, bytes: [hiWord & 0xff, (hiWord >> 8) & 0xff] },
        { at: hiAt, bytes: [loWord & 0xff, (loWord >> 8) & 0xff] },
    ];
    return applyWrite(block, `${which} group words ${a} and ${b} swapped`, ranges, groupTableWarnings(table));
}

// --- 3.9 settings ------------------------------------------------------------

/** The menu BGM byte's "off": decodePlusSettings returns null for anything >= 4. */
export const PLUS_MENU_BGM_OFF = 4;

/**
 * All four key-config bitmasks at once, 0x1DFD4..0x1DFD7. These are BUTTON
 * BITMASKS, not indices: 0x01 circle ... 0x80 R2 (PLUS_BUTTONS, plus.js:138,
 * FORMAT-PSX.md:586-589, "GLOBAL, SOUND, HIGH SCORE, SETTINGS").
 *
 * ENFORCED PAIR RULE: masks[0] !== masks[1] and masks[2] !== masks[3].
 * test/psx-fixtures.test.js:270-273 asserts both across all 67 community saves
 * as a rule the menu enforces. TAKING ALL FOUR AT ONCE IS THE ENFORCEMENT — a
 * per-key setter would have to read the other key of the pair and could still
 * leave a transient violation between two calls. The constraint is WITHIN pairs
 * only: the factory value 00 00 00 00 02 01 08 02 has masks[1] === masks[3].
 *
 * @param {Uint8Array} block
 * @param {ArrayLike<number>} masks  exactly four values 0..255
 * @returns {PlusWrite}
 */
export function setPlusKeyConfig(block, masks) {
    assertPlusBlock(block);
    if (!masks || masks.length !== 4) {
        throw new Error(`a key config is four button bitmasks; got ${masks ? masks.length : masks}`);
    }
    const values = [];
    for (let i = 0; i < 4; i++) values.push(intIn(`mask ${i}`, masks[i], 0, 0xff));
    for (const [x, y] of [[0, 1], [2, 3]]) {
        if (values[x] === values[y]) {
            throw new Error(
                `key ${x} and key ${y} are both ${hex(values[x])}; the menu will not let a pair share a ` +
                    `button, and all 67 community saves obey it (test/psx-fixtures.test.js:270-273)`,
            );
        }
    }
    return applyWrite(block, "key config", [{ at: PLUS_SETTINGS_OFFSET + 4, bytes: values }]);
}

/**
 * The menu cursor speed, 0x1DFD0.
 *
 * This byte is CHECKSUM-BLIND: its offset within its table entry is 0, so its
 * value is multiplied by zero (plus.js:244) and never reaches any sum. The
 * record says so. Verify it by diffing bytes, never by comparing checksums.
 *
 * @param {Uint8Array} block
 * @param {number} value  0..2
 * @returns {PlusWrite}
 */
export function setPlusCursorSpeed(block, value) {
    assertPlusBlock(block);
    intIn("cursor speed", value, 0, 2);
    return applyWrite(block, "cursor speed", [{ at: PLUS_SETTINGS_OFFSET, bytes: [value] }]);
}

/**
 * The menu BGM track, 0x1DFD2: 0-3 are BGM01..04.SEQ and PLUS_MENU_BGM_OFF is
 * off. The constant is explicit rather than `null` because decodePlusSettings
 * returns null for ANY byte >= 4 (plus.js:659) and so has no inverse.
 *
 * Also checksum-blind (within-entry offset 0).
 *
 * @param {Uint8Array} block
 * @param {number} track  0..3, or PLUS_MENU_BGM_OFF
 * @returns {PlusWrite}
 */
export function setPlusMenuBgm(block, track) {
    assertPlusBlock(block);
    intIn("menu bgm track", track, 0, PLUS_MENU_BGM_OFF);
    return applyWrite(block, "menu bgm", [{ at: PLUS_SETTINGS_OFFSET + 2, bytes: [track] }]);
}

/**
 * The stereo flag, 0x1DFD3. Writes the canonical 1 or 0; decodePlusSettings
 * reads `!== 0` (plus.js:660), so the record's `before` is the only place the
 * original byte survives — which is why the record carries it.
 *
 * Unlike its three neighbours this byte is NOT checksum-blind: its within-entry
 * offset is 1, so it moves group 0x12.
 *
 * @param {Uint8Array} block
 * @param {boolean} on
 * @returns {PlusWrite}
 */
export function setPlusStereo(block, on) {
    assertPlusBlock(block);
    bool("stereo", on);
    return applyWrite(block, "stereo", [{ at: PLUS_SETTINGS_OFFSET + 3, bytes: [on ? 1 : 0] }]);
}

// The settings font bank (0x1DFD1) is deliberately not exposed:
// FORMAT-PSX.md:585, "GLOBAL, SOUND, HIGH SCORE, SETTINGS", names it and no
// range is stated anywhere. A setter with no range is a setter with no rule.
//
// And note for any UI built on this module: do NOT render PLUS_REGIONS[].note
// or .confidence as help text. plus.js:284-285 still grades the settings region
// "likely" with "which option each is has not been traced", while
// FORMAT-PSX.md:584-589, decodePlusSettings's own docstring (plus.js:643-647)
// and the fixture assertion above all name the eight bytes; plus.js:279 still
// describes the global block as holding "the stage list, game config and the
// BGM patch list", all three of which FORMAT-PSX.md:531-540 records as
// corrected misreadings. Fixing those strings is a reader change, out of scope
// here; not rendering them is this module's constraint.

// --- 4 the container ---------------------------------------------------------

/**
 * @typedef {object} PlusPlacement
 * @property {string} filename
 * @property {number[]} blocks    the 1-based chain, in order
 * @property {number} bytes       blocks.length * BLOCK_SIZE
 * @property {boolean} framesOk   every directory frame still checksums
 * @property {string[]} warnings
 */

/**
 * Write an edited 0x1E000 block back into the card image it came from, block
 * by block through blockBytes(). locateSaves() hands back a COPY for a card
 * and a .gme (parseMemoryCard allocates and copies, memcard.js:161-163), so
 * mutating that copy edits nothing — this function exists because of that.
 *
 * Nothing at card level goes stale. The only derived bytes are the XOR
 * checksums on the 16 directory frames (frameChecksum, memcard.js:71), and a
 * frame covers only its own 128 directory bytes; there is no checksum over data
 * blocks anywhere in the format. The length-dependent fields — frame 0's u32
 * size at +4 and the chain link at +8 (memcard.js:111-112) — cannot change,
 * because PLUS_BLOCK_SIZE is a constant, assertPlusBlock forbids any other
 * length, and a seal rewrites 38 bytes in place.
 *
 * @param {Uint8Array} card   a RAW 128 KB card image — for a .gme pass
 *                            bytes.subarray(GME_HEADER_SIZE), which is a view
 * @param {Uint8Array} block  the edited block, sealed
 * @param {{filename?: string, index?: number|null, requirePlus?: boolean}} [options]
 * @returns {PlusPlacement}
 * @throws {Error} on a .psv, a missing file, an incomplete chain, or a short card
 */
export function placePlusSave(card, block, { filename = PLUS_PRODUCT, index = null, requirePlus = true } = {}) {
    // A PS3 .psv carries a cryptographic signature over the save in its 0x84
    // header, keyed to the console. This package neither reads, checks nor can
    // regenerate it — locateSaves's .psv branch slices at PSV_HEADER_SIZE and
    // reads a filename (memcard.js:214-219), isPsvImage checks a four-byte
    // magic (memcard.js:85-87), and nothing else in src/psx/ touches the
    // header. An edited .psv would be a file this package reads back happily
    // and a real PS3 rejects: the worst failure mode for a surgical tool,
    // because nothing in the toolchain warns. A refusal, never a warning.
    if (isPsvImage(card)) {
        throw new Error(
            "a .psv carries a signature this package cannot regenerate; convert it to a card image or an .mcs first",
        );
    }
    assertPlusBlock(block);
    const warnings = [];
    if (!isPlusBlock(block)) {
        if (requirePlus) {
            throw new Error(
                'the block has no "SC" Dezaemon+ frame; pass requirePlus: false for a Select 100 block, ' +
                    "whose frame the disc strips",
            );
        }
        warnings.push('the block has no "SC" Dezaemon+ frame — placed on the caller\'s word that it is Dezaemon+');
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
    if (file.blocks.length * BLOCK_SIZE < PLUS_BLOCK_SIZE) {
        throw new Error(
            `${file.filename || "(unnamed)"} owns ${file.blocks.length} blocks (${file.blocks.length * BLOCK_SIZE} ` +
                `bytes); a Dezaemon+ save needs ${PLUS_BLOCK_SIZE / BLOCK_SIZE}`,
        );
    }
    if (file.deleted) warnings.push(`${file.filename} is flagged deleted on this card; the edit lands but the game will not list it`);
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
