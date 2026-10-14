// The GROUP and ODR regions: the chip sheets a stage, the ship and the title
// screen are assembled from.
//
// Every GROUP table is a list of chip words (chips.js), one per SLOT of the
// sheet the stage assembly builds ($04:F979 / $05:AFD0): MAP GROUP 128 words a
// stage (the BG chips a map cell can name), ENEMY GROUP 64 a stage (the
// enemy sprite sheet, 8x8 chips), BOSS GROUP 32 a stage (an 8x4 sheet of BG
// chips), TITLE GROUP 32, ENDING GROUP 12, MY SHIP GROUP 64 (the ship sheet:
// poses, shots, weapons, items). The two ODR regions reference those sheets
// by slot: ENEMY ODR is 80 four-byte quads a stage — a quad is four slot
// references with flips (chips.js decodeOdrByte) — and MY SHIP ODR 64 bytes
// of flips for the ship sheet's chips. FORMAT-SFC.md "The sprite sheets".
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { decodeChipWord, decodeOdrByte } from "./chips.js";
import { readWords } from "./tilemap.js";

export const STAGE_COUNT = 6;
export const MAP_GROUP_CHIPS = REGION.mapGroup.length / STAGE_COUNT / 2; // 128
export const MAP_GROUP_STAGE_BYTES = MAP_GROUP_CHIPS * 2; // 0x100
export const ENEMY_GROUP_CHIPS = REGION.enemyGroup.length / STAGE_COUNT / 2; // 64
export const ENEMY_GROUP_STAGE_BYTES = ENEMY_GROUP_CHIPS * 2; // 0x80
export const BOSS_GROUP_CHIPS = REGION.bossGroup.length / STAGE_COUNT / 2; // 32
export const BOSS_GROUP_STAGE_BYTES = BOSS_GROUP_CHIPS * 2; // 0x40
export const TITLE_GROUP_CHIPS = REGION.titleGroup.length / 2; // 32
export const ENDING_GROUP_CHIPS = REGION.endingGroup.length / 2; // 12
export const MY_SHIP_GROUP_CHIPS = REGION.myShipGroup.length / 2; // 64
/** The ship sheet's last three slots, which the editor forces to 0x3FC-0x3FE. */
export const MY_SHIP_FORCED_SLOTS = Object.freeze([[61, 0x03fc], [62, 0x03fd], [63, 0x03fe]]);
export const ENEMY_ODR_STAGE_BYTES = REGION.enemyOdr.length / STAGE_COUNT; // 0x140
export const ENEMY_ODR_QUADS = ENEMY_ODR_STAGE_BYTES / 4; // 80
export const MY_SHIP_ODR_BYTES = REGION.myShipOdr.length; // 64
export const MY_SHIP_ODR_USED = 56;
/** The boss sheet's shape, in chips. */
export const BOSS_SHEET_COLS = 8;
export const BOSS_SHEET_ROWS = 4;
export const SHEET_COLS = 8;

/** `count` chip words at `offset`, decoded, with their slot numbers. */
export function decodeChipTable(bytes, offset, count) {
    const words = readWords(bytes, offset, count);
    return Array.from(words, (word, slot) => ({ slot, offset: offset + slot * 2, ...decodeChipWord(word) }));
}

export function decodeMapGroup(bytes, stage) {
    const offset = REGION.mapGroup.offset + stage * MAP_GROUP_STAGE_BYTES;
    return { stage, offset, chips: decodeChipTable(bytes, offset, MAP_GROUP_CHIPS) };
}

export function decodeEnemyGroup(bytes, stage) {
    const offset = REGION.enemyGroup.offset + stage * ENEMY_GROUP_STAGE_BYTES;
    return { stage, offset, chips: decodeChipTable(bytes, offset, ENEMY_GROUP_CHIPS) };
}

export function decodeBossGroup(bytes, stage) {
    const offset = REGION.bossGroup.offset + stage * BOSS_GROUP_STAGE_BYTES;
    return { stage, offset, chips: decodeChipTable(bytes, offset, BOSS_GROUP_CHIPS) };
}

export function decodeTitleGroup(bytes) {
    return decodeChipTable(bytes, REGION.titleGroup.offset, TITLE_GROUP_CHIPS);
}

export function decodeEndingGroup(bytes) {
    return decodeChipTable(bytes, REGION.endingGroup.offset, ENDING_GROUP_CHIPS);
}

export function decodeMyShipGroup(bytes) {
    return decodeChipTable(bytes, REGION.myShipGroup.offset, MY_SHIP_GROUP_CHIPS);
}

/** A stage's 80 ODR quads: {quad, offset, refs: [4 slot refs], blank}. */
export function decodeEnemyOdr(bytes, stage) {
    const offset = REGION.enemyOdr.offset + stage * ENEMY_ODR_STAGE_BYTES;
    if (offset + ENEMY_ODR_STAGE_BYTES > bytes.length) {
        throw new Error(`ENEMY ODR stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    const quads = [];
    for (let q = 0; q < ENEMY_ODR_QUADS; q++) {
        const at = offset + q * 4;
        const refs = Array.from(bytes.subarray(at, at + 4), decodeOdrByte);
        quads.push({ quad: q, offset: at, refs, blank: refs.every((r) => r.byte === 0) });
    }
    return { stage, offset, quads };
}

/** The ship sheet's 64 flip bytes (56 used). */
export function decodeMyShipOdr(bytes) {
    const { offset, end } = REGION.myShipOdr;
    if (end > bytes.length) throw new Error(`MY SHIP ODR at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    return Array.from(bytes.subarray(offset, end), decodeOdrByte);
}

/** Every group region at once, per stage where the ROM strides them. */
export function decodeGroups(bytes) {
    const stages = Array.from({ length: STAGE_COUNT }, (_, s) => s);
    return {
        map: stages.map((s) => decodeMapGroup(bytes, s)),
        enemy: stages.map((s) => decodeEnemyGroup(bytes, s)),
        boss: stages.map((s) => decodeBossGroup(bytes, s)),
        enemyOdr: stages.map((s) => decodeEnemyOdr(bytes, s)),
        title: decodeTitleGroup(bytes),
        ending: decodeEndingGroup(bytes),
        myShip: decodeMyShipGroup(bytes),
        myShipOdr: decodeMyShipOdr(bytes),
    };
}
