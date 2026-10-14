// CHECK SUM: the sixteen words at 0, their copy at 0x7E5A, and how the ROM
// forms them — so a writer can seal a save and a reader can verify one.
//
// Traced in the ROM ($00:847B computes, $00:8482 verifies, one body at
// $00:848A; FORMAT-SFC.md "CHECK SUM"): a word is 0xFFFF minus the mod-2^16
// sum of the little-endian 16-bit words over a scatter/gather list of
// segments, the seventeen lists being the descriptor table at $80:8665.
// The CLC sits inside the add loop, so carry never propagates; the tail is a
// one's complement. Word 15 covers the block's own first fifteen words, and
// the copy's word at 0x7E78 covers the copy's first fifteen, which is why
// every valid block totals 0xFFFF. The table below is that descriptor table
// transcribed; the fixture test holds it to both known dumps, all seventeen
// words. Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";

const STAGES = 6;
const seg = (offset, length) => Object.freeze({ offset, length });

function stageSegments(n) {
    return [
        seg(REGION.map.offset + n * 0x900, 0x900),
        seg(REGION.scroll.offset + n * 0x200, 0x200),
        seg(REGION.mapGroup.offset + n * 0x100, 0x100),
    ];
}

function stageTables(n) {
    return [
        seg(REGION.enemyGroup.offset + n * 0x80, 0x80),
        seg(REGION.enemyOdr.offset + n * 0x140, 0x140),
        seg(REGION.bossGroup.offset + n * 0x40, 0x40),
        seg(REGION.enemyData.offset + n * 0x200, 0x200),
        seg(REGION.appear.offset + n * 0x1200, 0x1200),
    ];
}

/**
 * The seventeen descriptors of $80:8665, in the ROM's order: `at` is where
 * the word is stored, `segments` what it sums. Descriptors 0-15 are the
 * block's words; 16 is the copy's own word, stored inside the copy.
 */
export const SFC_CHECKSUM_DESCRIPTORS = Object.freeze([
    Object.freeze({ at: 0x00, name: "graphics + palettes", segments: Object.freeze([seg(REGION.graphics.offset, 0x8000), seg(REGION.graphics.offset + 0x8000, 0x8000), seg(REGION.palette.offset, REGION.palette.length)]) }),
    ...Array.from({ length: STAGES }, (_, n) => Object.freeze({ at: 0x02 + n * 2, name: `stage ${n} map, scroll, map group`, segments: Object.freeze(stageSegments(n)) })),
    ...Array.from({ length: STAGES }, (_, n) => Object.freeze({ at: 0x0e + n * 2, name: `stage ${n} enemies, appear`, segments: Object.freeze(stageTables(n)) })),
    Object.freeze({
        at: 0x1a,
        name: "ship, title, ending, config, hi-scores",
        segments: Object.freeze([
            seg(REGION.myShipOdr.offset, REGION.myShipOdr.length),
            seg(REGION.myShipGroup.offset, REGION.myShipGroup.length),
            seg(REGION.titleGroup.offset, REGION.titleGroup.length),
            seg(REGION.titleType.offset, REGION.titleType.length),
            seg(REGION.endingGroup.offset, REGION.endingGroup.length),
            seg(REGION.mouseSpeed.offset, REGION.mouseSpeed.length),
            seg(REGION.editBgm.offset, REGION.editBgm.length),
            seg(REGION.hiScore.offset, REGION.hiScore.length),
            seg(REGION.keyConfig.offset, REGION.keyConfig.length),
        ]),
    }),
    Object.freeze({ at: 0x1c, name: "sound + bgm patch", segments: Object.freeze([seg(REGION.sound.offset, REGION.sound.length), seg(REGION.bgmPatch.offset, REGION.bgmPatch.length)]) }),
    Object.freeze({ at: 0x1e, name: "the block's first fifteen words", segments: Object.freeze([seg(REGION.checksum.offset, 0x1e)]) }),
    Object.freeze({ at: REGION.checksumCopy.offset + 0x1e, name: "the copy's first fifteen words", segments: Object.freeze([seg(REGION.checksumCopy.offset, 0x1e)]) }),
]);

/** 0xFFFF minus the mod-2^16 sum of the little-endian words of `segments`. */
export function sfcChecksumWord(bytes, segments) {
    let sum = 0;
    for (const { offset, length } of segments) {
        if (offset + length > bytes.length) throw new Error(`checksum segment 0x${offset.toString(16)}+0x${length.toString(16)} runs past the end (${bytes.length})`);
        for (let i = offset; i < offset + length; i += 2) sum = (sum + (bytes[i] | (bytes[i + 1] << 8))) & 0xffff;
    }
    return (0xffff - sum) & 0xffff;
}

function putWord(bytes, at, word) {
    bytes[at] = word & 0xff;
    bytes[at + 1] = (word >> 8) & 0xff;
}

function getWord(bytes, at) {
    return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Seal a 128 KB image in place, as the game's save path does: words 0-14 in
 * order, word 15 over the fifteen just written, the 32-byte block copied to
 * 0x7E5A, then the copy's own word at 0x7E78. Returns `bytes`.
 */
export function sealSfcChecksums(bytes) {
    if (bytes.length < REGION.graphics.end) throw new Error(`a Dezaemon SRAM image is ${REGION.graphics.end} bytes; got ${bytes.length}`);
    for (let i = 0; i < 16; i++) {
        const d = SFC_CHECKSUM_DESCRIPTORS[i];
        putWord(bytes, d.at, sfcChecksumWord(bytes, d.segments));
    }
    bytes.set(bytes.subarray(REGION.checksum.offset, REGION.checksum.end), REGION.checksumCopy.offset);
    const copy = SFC_CHECKSUM_DESCRIPTORS[16];
    putWord(bytes, copy.at, sfcChecksumWord(bytes, copy.segments));
    return bytes;
}

/**
 * Every descriptor's stored word against a fresh computation:
 * {ok, words: [{name, at, stored, computed, ok}], blockOk, copyOk} — blockOk is
 * what the boot check asks of the block (descriptor 15), copyOk of the copy
 * (descriptor 16); the game repairs a failed block from a passing copy.
 */
export function verifySfcChecksums(bytes) {
    const words = SFC_CHECKSUM_DESCRIPTORS.map((d) => {
        let computed = null;
        try {
            computed = sfcChecksumWord(bytes, d.segments);
        } catch {
            computed = null;
        }
        const stored = d.at + 1 < bytes.length ? getWord(bytes, d.at) : null;
        return { name: d.name, at: d.at, stored, computed, ok: computed !== null && stored === computed };
    });
    return { ok: words.every((w) => w.ok), words, blockOk: words[15].ok, copyOk: words[16].ok };
}
