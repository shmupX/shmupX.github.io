// ENEMY DATA and APPEAR DATA: what spawns, and where.
//
// ENEMY DATA is 6 stages x 0x200 bytes (the stage loader $00:A14D copies
// one stage's 0x200 to $7E:F9EE). Inside: five classes of eight-byte
// entries at the bases the editor's table $04:E6C8 gives — class 0, 1 and 2
// sixteen entries each at 0x000 / 0x080 / 0x100, class 3 eight at 0x180,
// class 4 four at 0x1C0 — then a 32-byte boss parameter block at 0x1E0. An
// entry is one placeable enemy variant; an APPEAR byte names it by (class,
// entry). The class is the sprite's shape — 16x16, 32x16, 16x32, 32x32,
// 64x64 — and fixes where its ENEMY ODR chips sit (groups.js): the object
// builder $80:A3EC-A573 reads them at 0x00 + entry*4 (four 16x16 frames),
// 0x40 + entry*4 (two frames of two chips), 0x80 + entry*4, 0xC0 + entry*8
// (two frames of four), 0x100 + entry*16 (one frame of sixteen).
//
// The entry's fields, as the object builder $00:A713 consumes them (section
// 13 of the trace): byte 0 the movement family (bits 3-7, 0-19) and its
// variant (bits 0-2: the path's speed), byte 1 the shot aim (bits 0-4) and
// rate (5-7), byte 2 the shot type (bits 0-1) and the item-drop bit (2),
// byte 3 the hit-point index (bits 0-2) and two flags (bits 5-7), byte 4 the
// score index (bits 0-2) and the animation interval (bits 5-7), byte 5 a
// parameter of shot type 2; bytes 6-7 are never read.
//
// APPEAR DATA is 6 stages x 0x1200: 256 records of 14 bytes (table A), then
// 1,024 bytes (table B). B is indexed by the stage LINE — one line per 16 px,
// one map row, line 0 the stage start, so a stage is 1,024 rows long with
// the 128-row map sequenced over it (map.js) — and holds the index of the A
// record that fires on that line, 0 for none. A record is one spawn byte per
// playfield column 1..14 (the 16-chip map's edge columns never spawn):
// [bit 7 valid][bits 6-4 class][bits 3-0 entry]; class 5 spawns the boss.
// Record 0 is the empty record and record 1 the END code (fourteen 0xFF the
// loader forces); the game writes an END line after the last spawn itself,
// so a save never stores one. FORMAT-SFC.md "ENEMY DATA and APPEAR DATA".
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { isBlank } from "./sram.js";

export const STAGE_COUNT = 6;
export const ENEMY_STAGE_BYTES = REGION.enemyData.length / STAGE_COUNT; // 0x200
export const ENEMY_ENTRY_BYTES = 8;
export const BOSS_BLOCK_OFFSET = 0x1e0;
export const BOSS_BLOCK_BYTES = 0x20;
/**
 * The five entry classes: where their entries sit in a stage's 0x200, how
 * many, the sprite they draw (in chips, columns x rows), its frames, and
 * where in ENEMY ODR their chips start (a byte per chip, frame-major).
 */
export const SFC_ENEMY_CLASSES = Object.freeze([
    Object.freeze({ klass: 0, base: 0x000, entries: 16, odrBase: 0x000, cols: 1, rows: 1, frames: 4, w: 16, h: 16 }),
    Object.freeze({ klass: 1, base: 0x080, entries: 16, odrBase: 0x040, cols: 2, rows: 1, frames: 2, w: 32, h: 16 }),
    Object.freeze({ klass: 2, base: 0x100, entries: 16, odrBase: 0x080, cols: 1, rows: 2, frames: 2, w: 16, h: 32 }),
    Object.freeze({ klass: 3, base: 0x180, entries: 8, odrBase: 0x0c0, cols: 2, rows: 2, frames: 2, w: 32, h: 32 }),
    Object.freeze({ klass: 4, base: 0x1c0, entries: 4, odrBase: 0x100, cols: 4, rows: 4, frames: 1, w: 64, h: 64 }),
]);
/** The APPEAR class that spawns the boss (byte 0xD0). */
export const APPEAR_BOSS_CLASS = 5;
/** Contact damage an enemy of each class deals ($80:AB9F). */
export const SFC_ENEMY_CONTACT = Object.freeze([1, 5, 5, 12, 24]);
/** Entry byte 3 bits 0-2 -> hit points ($80:AB8F). */
export const SFC_ENEMY_HP = Object.freeze([1, 50, 100, 200, 400, 800, 1000, 2000]);
/** Entry byte 4 bits 0-2 -> score ($80:AB5F). */
export const SFC_ENEMY_SCORE = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000, 10000]);
/** Entry byte 4 bits 5-7 -> frames between animation frames ($80:AB57). */
export const SFC_ANIM_INTERVALS = Object.freeze([59, 29, 14, 9, 5, 2, 1, 0]);
/** Entry byte 1 bits 5-7 -> frames between shots, as a mask ($80:ABB9), and the shot's speed ($80:ABC9). */
export const SFC_SHOT_RATES = Object.freeze([31, 31, 15, 15, 7, 3, 1, 0]);
export const SFC_SHOT_SPEEDS = Object.freeze([20, 18, 14, 10, 8, 4, 2, 1]);
/** Movement family 1's variants: straight down at this many px a frame ($82:A5F5). */
export const SFC_STRAIGHT_SPEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 9, 12]);
/** Families 17-19's variants: the homing speeds ($82:A508). */
export const SFC_HOMING_SPEEDS = Object.freeze([1.5, 2, 2.5, 3, 3.5, 4, 6, 8]);
/** The twenty movement families of byte 0 bits 3-7, as the scripts read. */
export const SFC_MOVE_FAMILIES = Object.freeze([
    "stationary on the ground",
    "straight down",
    "down, pause, down",
    "down, curve back up and leave",
    "U-turn",
    "U-turn (later)",
    "arc, exit sideways",
    "zig-zag, then sideways",
    "down, long turn, up",
    "ground vehicle",
    "square patrol",
    "down with weaving turns",
    "bobbing",
    "down, retreat, down",
    "stepwise",
    "down, then sweeps",
    "down, stop, exit up-right",
    "homing",
    "level with the player, dash",
    "wait, aim, dash",
]);
export const SFC_MOVE_STATIONARY = 0;
export const SFC_MOVE_STRAIGHT = 1;
export const SFC_MOVE_HOMING = 17;
/** Boss block byte 0xD bits 0-2 -> hit points ($80:ABA9). */
export const SFC_BOSS_HP = Object.freeze([24, 2000, 4000, 8000, 12000, 16000, 18000, 24000]);

/** An entry's bit fields, named by what the object builder does with them. */
export function decodeEnemyEntry(bytes, at) {
    const b = Array.from(bytes.subarray(at, at + ENEMY_ENTRY_BYTES));
    return {
        offset: at,
        bytes: b,
        blank: b.every((v) => v === 0),
        fields: {
            family: b[0] >> 3,
            variant: b[0] & 7,
            aim: b[1] & 0x1f,
            rate: b[1] >> 5,
            shotType: b[2] & 3,
            itemDrop: ((b[2] >> 2) & 1) !== 0,
            hp: b[3] & 7,
            flags: b[3] >> 5,
            score: b[4] & 7,
            anim: b[4] >> 5,
            shotParam: b[5],
        },
    };
}

/** The inverse of decodeEnemyEntry's fields -> 8 bytes (bytes 6-7 zero). */
export function encodeEnemyEntry({ family = 0, variant = 0, aim = 0, rate = 0, shotType = 0, itemDrop = false, hp = 0, flags = 0, score = 0, anim = 0, shotParam = 0 } = {}) {
    return [
        ((family & 0x1f) << 3) | (variant & 7),
        (aim & 0x1f) | ((rate & 7) << 5),
        (shotType & 3) | (itemDrop ? 4 : 0),
        (hp & 7) | ((flags & 7) << 5),
        (score & 7) | ((anim & 7) << 5),
        shotParam & 0xff,
        0,
        0,
    ];
}

/**
 * The boss block's fields ($00:A917-AAD0): bytes 0-2 the animation frame
 * count, timer and reload; 3-5 per phase the shot aim (bits 0-4) and rate
 * (5-7); 6 the three phases' shot types (bits 0-1, 2-3, 4-5) and the tall
 * layout bit (6); 7-12 three per-phase pairs; 13 the hit-point index (bits
 * 0-2) and a priority bit (6); 14 the score index (bits 0-2); 15-17 per phase
 * a type-2 shot parameter; 18-31 unused.
 */
export function decodeBossBlock(bytes, at) {
    const b = Array.from(bytes.subarray(at, at + BOSS_BLOCK_BYTES));
    return {
        offset: at,
        bytes: b,
        blank: b.every((v) => v === 0),
        anim: [b[0], b[1], b[2]],
        phases: [0, 1, 2].map((p) => ({
            aim: b[3 + p] & 0x1f,
            rate: b[3 + p] >> 5,
            shotType: (b[6] >> (p * 2)) & 3,
            pair: [b[7 + p * 2], b[8 + p * 2]],
            shotParam: b[0x0f + p] & 0x7f,
        })),
        tall: (b[6] & 0x40) !== 0,
        hp: b[0x0d] & 7,
        priority: (b[0x0d] & 0x40) !== 0,
        score: b[0x0e] & 7,
    };
}

/**
 * A stage's ENEMY DATA: {stage, offset, classes: [{klass, offset, entries:
 * [...]}], boss: {...decodeBossBlock}, used}.
 */
export function decodeEnemyStage(bytes, stage) {
    const offset = REGION.enemyData.offset + stage * ENEMY_STAGE_BYTES;
    if (offset + ENEMY_STAGE_BYTES > bytes.length) {
        throw new Error(`ENEMY DATA stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    let used = 0;
    const classes = SFC_ENEMY_CLASSES.map((spec) => {
        const entries = [];
        for (let e = 0; e < spec.entries; e++) {
            const entry = decodeEnemyEntry(bytes, offset + spec.base + e * ENEMY_ENTRY_BYTES);
            if (!entry.blank) used++;
            entries.push({ index: e, ...entry });
        }
        return { klass: spec.klass, offset: offset + spec.base, entries };
    });
    return { stage, offset, classes, boss: decodeBossBlock(bytes, offset + BOSS_BLOCK_OFFSET), used };
}

export function decodeEnemyData(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) stages.push(decodeEnemyStage(bytes, s));
    return stages;
}

// --- APPEAR DATA ----------------------------------------------------------------

export const APPEAR_STAGE_BYTES = REGION.appear.length / STAGE_COUNT; // 0x1200
export const APPEAR_RECORDS = 256;
export const APPEAR_RECORD_BYTES = 14;
export const APPEAR_COLUMNS = 14;
/** The map column a record's first spawn byte stands for. */
export const APPEAR_FIRST_COLUMN = 1;
export const APPEAR_TABLE_B_OFFSET = APPEAR_RECORDS * APPEAR_RECORD_BYTES; // 0xE00
export const APPEAR_LINES = APPEAR_STAGE_BYTES - APPEAR_TABLE_B_OFFSET; // 1024
/** A line is one map row: the scroll clock counts pixels and the spawner fires on each 16th. */
export const APPEAR_LINE_PX = 16;
export const APPEAR_RECORD_EMPTY = 0;
export const APPEAR_RECORD_END = 1;
export const APPEAR_VALID = 0x80;

export function decodeAppearByte(b) {
    return { byte: b, valid: (b & APPEAR_VALID) !== 0, klass: (b >> 4) & 7, entry: b & 0x0f };
}

export function encodeAppearByte({ klass, entry }) {
    return APPEAR_VALID | ((klass & 7) << 4) | (entry & 0x0f);
}

/**
 * A stage's APPEAR DATA: {stage, offset, records: [{index, offset, bytes,
 * spawns: [{column, klass, entry}]}], lines: Uint8Array(1024) (B), used:
 * lines that name a record, spawns: spawn bytes those lines fire}.
 */
export function decodeAppearStage(bytes, stage) {
    const offset = REGION.appear.offset + stage * APPEAR_STAGE_BYTES;
    if (offset + APPEAR_STAGE_BYTES > bytes.length) {
        throw new Error(`APPEAR DATA stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    const records = [];
    for (let r = 0; r < APPEAR_RECORDS; r++) {
        const at = offset + r * APPEAR_RECORD_BYTES;
        const view = bytes.subarray(at, at + APPEAR_RECORD_BYTES);
        const spawns = [];
        view.forEach((b, k) => {
            const d = decodeAppearByte(b);
            if (d.valid && r !== APPEAR_RECORD_END) spawns.push({ column: APPEAR_FIRST_COLUMN + k, klass: d.klass, entry: d.entry });
        });
        records.push({ index: r, offset: at, bytes: view, spawns, blank: isBlank(view) });
    }
    const lines = bytes.subarray(offset + APPEAR_TABLE_B_OFFSET, offset + APPEAR_STAGE_BYTES);
    let used = 0, spawns = 0, lastLine = -1;
    for (let l = 0; l < lines.length; l++) {
        if (!lines[l]) continue;
        used++;
        lastLine = l;
        spawns += records[lines[l]].spawns.length;
    }
    return { stage, offset, records, lines, used, spawns, lastLine, blank: used === 0 };
}

export function decodeAppearData(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) stages.push(decodeAppearStage(bytes, s));
    return stages;
}
