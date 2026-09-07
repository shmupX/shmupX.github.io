// The "GROUP" and "ODR" regions: how tiles are grouped into things.
//
// Every GROUP region is a table of quads — four tilemap words (tilemap.js),
// eight bytes — one quad per 16x16 object: the 192 background chips MAP DATA
// indexes, four per enemy, eight per boss, eight for the title, three for the
// ending, sixteen for the player's ship. The two ODR ("order") regions are the
// same idea in 8-bit: four tile numbers per quad, twenty quads per enemy and
// sixteen for the ship — animation frame lists by the look of the sample,
// which is as far as this file goes. Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { classifyQuad, decodeTilemapWord, readWords } from "./tilemap.js";

export const QUAD_BYTES = 8;
export const BYTE_QUAD_BYTES = 4;
export const MAP_GROUP_CHIPS = REGION.mapGroup.length / QUAD_BYTES; // 192
export const ENEMY_COUNT = 24;
export const ENEMY_GROUP_QUADS = REGION.enemyGroup.length / QUAD_BYTES / ENEMY_COUNT; // 4
export const BOSS_COUNT = 6;
export const BOSS_GROUP_QUADS = REGION.bossGroup.length / QUAD_BYTES / BOSS_COUNT; // 8
export const TITLE_GROUP_QUADS = REGION.titleGroup.length / QUAD_BYTES; // 8
export const ENDING_GROUP_QUADS = REGION.endingGroup.length / QUAD_BYTES; // 3
export const MY_SHIP_GROUP_QUADS = REGION.myShipGroup.length / QUAD_BYTES; // 16
export const ENEMY_ODR_QUADS = REGION.enemyOdr.length / BYTE_QUAD_BYTES / ENEMY_COUNT; // 20
export const MY_SHIP_ODR_QUADS = REGION.myShipOdr.length / BYTE_QUAD_BYTES; // 16

/** `count` quads of tilemap words at `offset`. */
export function decodeQuadTable(bytes, offset, count) {
    const quads = [];
    for (let i = 0; i < count; i++) {
        const at = offset + i * QUAD_BYTES;
        const words = readWords(bytes, at, 4);
        const entries = Array.from(words, decodeTilemapWord);
        quads.push({ index: i, offset: at, words, entries, kind: classifyQuad(words) });
    }
    return quads;
}

/** `count` quads of four 8-bit tile numbers at `offset`. */
export function decodeByteQuadTable(bytes, offset, count) {
    const quads = [];
    for (let i = 0; i < count; i++) {
        const at = offset + i * BYTE_QUAD_BYTES;
        if (at + BYTE_QUAD_BYTES > bytes.length) {
            throw new Error(`byte quad at 0x${at.toString(16)} runs past the end (${bytes.length})`);
        }
        const tiles = Array.from(bytes.subarray(at, at + BYTE_QUAD_BYTES));
        quads.push({ index: i, offset: at, tiles, blank: tiles.every((t) => t === 0) });
    }
    return quads;
}

function perOwner(bytes, region, owners, quadsEach, decode, quadBytes, key) {
    const out = [];
    for (let o = 0; o < owners; o++) {
        const offset = region.offset + o * quadsEach * quadBytes;
        out.push({ [key]: o, offset, quads: decode(bytes, offset, quadsEach) });
    }
    return out;
}

export function decodeMapGroup(bytes) {
    return decodeQuadTable(bytes, REGION.mapGroup.offset, MAP_GROUP_CHIPS);
}

export function decodeEnemyGroup(bytes) {
    return perOwner(bytes, REGION.enemyGroup, ENEMY_COUNT, ENEMY_GROUP_QUADS, decodeQuadTable, QUAD_BYTES, "enemy");
}

export function decodeBossGroup(bytes) {
    return perOwner(bytes, REGION.bossGroup, BOSS_COUNT, BOSS_GROUP_QUADS, decodeQuadTable, QUAD_BYTES, "boss");
}

export function decodeTitleGroup(bytes) {
    return decodeQuadTable(bytes, REGION.titleGroup.offset, TITLE_GROUP_QUADS);
}

export function decodeEndingGroup(bytes) {
    return decodeQuadTable(bytes, REGION.endingGroup.offset, ENDING_GROUP_QUADS);
}

export function decodeMyShipGroup(bytes) {
    return decodeQuadTable(bytes, REGION.myShipGroup.offset, MY_SHIP_GROUP_QUADS);
}

export function decodeEnemyOdr(bytes) {
    return perOwner(bytes, REGION.enemyOdr, ENEMY_COUNT, ENEMY_ODR_QUADS, decodeByteQuadTable, BYTE_QUAD_BYTES, "enemy");
}

export function decodeMyShipOdr(bytes) {
    return decodeByteQuadTable(bytes, REGION.myShipOdr.offset, MY_SHIP_ODR_QUADS);
}

/** Every group region at once. */
export function decodeGroups(bytes) {
    return {
        map: decodeMapGroup(bytes),
        enemy: decodeEnemyGroup(bytes),
        boss: decodeBossGroup(bytes),
        title: decodeTitleGroup(bytes),
        ending: decodeEndingGroup(bytes),
        myShip: decodeMyShipGroup(bytes),
        enemyOdr: decodeEnemyOdr(bytes),
        myShipOdr: decodeMyShipOdr(bytes),
    };
}
