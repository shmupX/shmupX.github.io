// The small fixed tables at the top of the second 32 KB: HIGH SCORE, the
// configuration words around it, and the SOUND DATA slice.
//
// HIGH SCORE is 20 entries of 16 bytes: a little-endian u32 score, four
// bytes not yet understood, then an 8-character name. The factory table in
// the sample runs 1000, 900, 800 … 300 with "........" names, which is what
// the game shows on a fresh cart. Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { latin1 } from "./sram.js";

export const HI_SCORE_ENTRY_BYTES = 16;
export const HI_SCORE_COUNT = REGION.hiScore.length / HI_SCORE_ENTRY_BYTES; // 20
export const HI_SCORE_NAME_LENGTH = 8;
/** Entries 0-9 are the SAMPLE game's table, 10-19 the USER game's ($05:D087 picks by the data-source flag). */
export const HI_SCORE_TABLE_SIZE = 10;
export const HI_SCORE_USER_TABLE = 10;
export const BGM_PATCH_COUNT = REGION.bgmPatch.length; // 16
/**
 * BGM PATCH slots ($04:C1DF reads each & 0x3F): 0-5 stage n's song, 6-11
 * stage n's boss song, 12 the title, 13-15 ending / stage clear / game over
 * (that order likely). Values 0-15 are the save's own SOUND DATA songs;
 * 0x10 and up pick the ROM's built-in songs, which is all the sample uses.
 */
export const BGM_PATCH_STAGE = 0;
export const BGM_PATCH_BOSS = 6;
export const BGM_PATCH_TITLE = 12;
export const BGM_PATCH_ROM_SONGS = 0x10;
export function bgmPatchRole(slot) {
    if (slot < 6) return `stage ${slot}`;
    if (slot < 12) return `stage ${slot - 6} boss`;
    return ["title", "ending", "stage clear", "game over"][slot - 12] ?? `slot ${slot}`;
}
export const KEY_CONFIG_BYTES = REGION.keyConfig.length; // 4
/** SOUND DATA: 16 songs of 0x2E0 bytes (the clear routine $00:89DD copies one ROM block to all 16). */
export const SOUND_SONG_COUNT = 16;
export const SOUND_SONG_BYTES = REGION.sound.length / SOUND_SONG_COUNT; // 0x2E0

function u16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function need(bytes, region) {
    if (bytes.length < region.end) {
        throw new Error(`${region.label} at 0x${region.offset.toString(16)} runs past the end (${bytes.length})`);
    }
}

export function decodeHiScores(bytes) {
    need(bytes, REGION.hiScore);
    const entries = [];
    for (let i = 0; i < HI_SCORE_COUNT; i++) {
        const offset = REGION.hiScore.offset + i * HI_SCORE_ENTRY_BYTES;
        entries.push({
            rank: (i % HI_SCORE_TABLE_SIZE) + 1,
            table: i < HI_SCORE_USER_TABLE ? "sample" : "user",
            offset,
            score: u32(bytes, offset),
            extra: bytes.subarray(offset + 4, offset + 8),
            name: latin1(bytes, offset + 8, HI_SCORE_NAME_LENGTH),
        });
    }
    return entries;
}

/** TITLE TYPE, MOUSE SPEED, EDIT BGM, BGM PATCH, KEY CONFIG and the two RESERVED ranges. */
export function decodeConfig(bytes) {
    for (const r of [REGION.titleType, REGION.mouseSpeed, REGION.editBgm, REGION.bgmPatch, REGION.keyConfig, REGION.reserved1]) {
        need(bytes, r);
    }
    return {
        titleType: u16(bytes, REGION.titleType.offset),
        mouseSpeed: u16(bytes, REGION.mouseSpeed.offset),
        editBgm: u16(bytes, REGION.editBgm.offset),
        bgmPatch: bytes.subarray(REGION.bgmPatch.offset, REGION.bgmPatch.end),
        keyConfig: bytes.subarray(REGION.keyConfig.offset, REGION.keyConfig.end),
        reserved0: bytes.subarray(REGION.reserved0.offset, REGION.reserved0.end),
        reserved1: bytes.subarray(REGION.reserved1.offset, REGION.reserved1.end),
    };
}

/** SOUND DATA as stored, and its 16 song slots; the note format is still open. */
export function sliceSound(bytes) {
    need(bytes, REGION.sound);
    const songs = [];
    for (let i = 0; i < SOUND_SONG_COUNT; i++) {
        const at = REGION.sound.offset + i * SOUND_SONG_BYTES;
        songs.push({ index: i, offset: at, bytes: bytes.subarray(at, at + SOUND_SONG_BYTES) });
    }
    return { offset: REGION.sound.offset, length: REGION.sound.length, bytes: bytes.subarray(REGION.sound.offset, REGION.sound.end), songs };
}
