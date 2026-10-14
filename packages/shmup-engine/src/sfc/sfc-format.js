// A formatted Super Famicom Dezaemon SRAM image: what a writer starts from.
//
// formatSfcSram() returns the 128 KB image the game would call formatted and
// empty — every region zero but the ones the game insists on: the "T.TABATA"
// magic, the two RESERVED ranges as the game writes them, the factory
// configuration words, the factory hi-score ladders (1000..100 twice, dotted
// names), the editor's colour-picker rows 22-23 of PALETTE DATA, the empty
// ENDING GROUP (0x03FF words), the editor's clear images of the sheet tables
// and scroll tables, every APPEAR DATA stage's fourteen 0x00 and
// fourteen 0xFF header, and — because its format is open and the sample's
// songs play — the factory sample's SOUND DATA and BGM PATCH
// (factory-data.js). The CHECK SUM block and its copy are sealed last. The
// level writer (sfc-write.js) lays its own regions over this.
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { CHECK_STRING, CHECK_STRING_OFFSET, SRAM_SIZE } from "./sram.js";
import { sealSfcChecksums } from "./checksum.js";
import { writeWords } from "./tilemap.js";
import { CHIP_BLANK_WORD } from "./chips.js";
import { HI_SCORE_COUNT, HI_SCORE_ENTRY_BYTES, HI_SCORE_NAME_LENGTH } from "./tables.js";
import { APPEAR_STAGE_BYTES, STAGE_COUNT } from "./enemy.js";
import { writeDefaultScroll } from "./map.js";
import { ENEMY_GROUP_STAGE_BYTES, MAP_GROUP_STAGE_BYTES, MY_SHIP_FORCED_SLOTS } from "./groups.js";
import {
    SFC_FACTORY_BGM_PATCH,
    SFC_FACTORY_EDIT_BGM,
    SFC_FACTORY_KEY_CONFIG,
    SFC_FACTORY_MOUSE_SPEED,
    SFC_FACTORY_PICKER_ROWS,
    SFC_FACTORY_RESERVED0,
    SFC_FACTORY_RESERVED1,
    SFC_FACTORY_TITLE_TYPE,
    sfcFactorySound,
} from "./factory-data.js";

/** The blank chip word a writer leaves in an unused slot (the editor's clear image for most tables). */
export const SFC_EMPTY_WORD = CHIP_BLANK_WORD; // 0x03FF
/** Each APPEAR DATA stage opens with this many zero bytes, then as many 0xFF. */
export const APPEAR_HEADER_ZEROS = 14;
export const APPEAR_HEADER_FFS = 14;
/** The factory ladder: 1000, 900 … 100, in both tables. */
export const FACTORY_HI_SCORES = Object.freeze([1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
export const FACTORY_HI_SCORE_NAME = "........";

function putU16(bytes, at, v) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
}

function putU32(bytes, at, v) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
    bytes[at + 2] = (v >> 16) & 0xff;
    bytes[at + 3] = (v >>> 24) & 0xff;
}

/** Write one hi-score entry: u32 score, four zero bytes, an 8-character name (space-padded, cut). */
export function writeHiScore(bytes, index, { score, name = FACTORY_HI_SCORE_NAME }) {
    const at = REGION.hiScore.offset + index * HI_SCORE_ENTRY_BYTES;
    putU32(bytes, at, score >>> 0);
    bytes.fill(0, at + 4, at + 8);
    const text = String(name).padEnd(HI_SCORE_NAME_LENGTH, " ").slice(0, HI_SCORE_NAME_LENGTH);
    for (let i = 0; i < HI_SCORE_NAME_LENGTH; i++) bytes[at + 8 + i] = text.charCodeAt(i) & 0xff;
}

/** The two factory ladders. */
export function writeFactoryHiScores(bytes) {
    for (let t = 0; t < HI_SCORE_COUNT / FACTORY_HI_SCORES.length; t++) {
        FACTORY_HI_SCORES.forEach((score, i) => writeHiScore(bytes, t * FACTORY_HI_SCORES.length + i, { score }));
    }
}

/** Every word of a GROUP region set to `word` (the blank chip by default). */
export function blankQuadRegion(bytes, region, word = SFC_EMPTY_WORD) {
    const words = new Uint16Array(region.length / 2).fill(word);
    writeWords(bytes, region.offset, words);
}

/**
 * The editor's clear images of the per-stage sheet tables: MAP GROUP all
 * 0xFFFF but word 0 = 0x03FF ($00:8B45, $03:C94C), ENEMY GROUP 0xFFFF, BOSS
 * GROUP 0x03FF; SCROLL EFECT its defaults; the ship sheet's forced last slots.
 */
export function writeClearedTables(bytes) {
    for (let s = 0; s < STAGE_COUNT; s++) {
        const mapAt = REGION.mapGroup.offset + s * MAP_GROUP_STAGE_BYTES;
        bytes.fill(0xff, mapAt, mapAt + MAP_GROUP_STAGE_BYTES);
        writeWords(bytes, mapAt, [CHIP_BLANK_WORD]);
        const enemyAt = REGION.enemyGroup.offset + s * ENEMY_GROUP_STAGE_BYTES;
        bytes.fill(0xff, enemyAt, enemyAt + ENEMY_GROUP_STAGE_BYTES);
        writeDefaultScroll(bytes, s);
    }
    blankQuadRegion(bytes, REGION.bossGroup);
    blankQuadRegion(bytes, REGION.titleGroup);
    blankQuadRegion(bytes, REGION.myShipGroup);
    for (const [slot, word] of MY_SHIP_FORCED_SLOTS) writeWords(bytes, REGION.myShipGroup.offset + slot * 2, [word]);
    return bytes;
}

/** The fourteen zeros and fourteen 0xFF every APPEAR DATA stage opens with, the rest zero. */
export function writeAppearHeaders(bytes) {
    for (let s = 0; s < STAGE_COUNT; s++) {
        const at = REGION.appear.offset + s * APPEAR_STAGE_BYTES;
        bytes.fill(0, at, at + APPEAR_STAGE_BYTES);
        bytes.fill(0xff, at + APPEAR_HEADER_ZEROS, at + APPEAR_HEADER_ZEROS + APPEAR_HEADER_FFS);
    }
}

/**
 * A formatted, sealed, empty 128 KB image. `seal: false` leaves the CHECK SUM
 * block zero for a caller that will write more and seal itself.
 */
export function formatSfcSram({ seal = true } = {}) {
    const bytes = new Uint8Array(SRAM_SIZE);
    for (let i = 0; i < CHECK_STRING.length; i++) bytes[CHECK_STRING_OFFSET + i] = CHECK_STRING.charCodeAt(i);
    bytes.set(SFC_FACTORY_RESERVED0, REGION.reserved0.offset);
    bytes.set(SFC_FACTORY_RESERVED1, REGION.reserved1.offset);
    bytes.set(SFC_FACTORY_PICKER_ROWS, REGION.palette.offset + 22 * 32);
    putU16(bytes, REGION.titleType.offset, SFC_FACTORY_TITLE_TYPE);
    putU16(bytes, REGION.mouseSpeed.offset, SFC_FACTORY_MOUSE_SPEED);
    putU16(bytes, REGION.editBgm.offset, SFC_FACTORY_EDIT_BGM);
    bytes.set(SFC_FACTORY_BGM_PATCH, REGION.bgmPatch.offset);
    bytes.set(SFC_FACTORY_KEY_CONFIG, REGION.keyConfig.offset);
    bytes.set(sfcFactorySound(), REGION.sound.offset);
    writeFactoryHiScores(bytes);
    blankQuadRegion(bytes, REGION.endingGroup);
    writeClearedTables(bytes);
    writeAppearHeaders(bytes);
    if (seal) sealSfcChecksums(bytes);
    return bytes;
}
