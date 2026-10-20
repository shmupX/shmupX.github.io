// MAP DATA and SCROLL EFECT: the six stages' scenery and scroll tables.
//
// MAP DATA is 6 stages x 0x900 bytes: 128 rows of 18 bytes, row 0 the stage
// start and row 127 its end (the stage loader $00:9B9C, ROM 0x1B9C; rendered
// through real chips in both dumps). A row is two 9-byte halves, each eight
// cells and a flag byte:
//
//     [cell0 .. cell7][flags] [cell8 .. cell15][flags]
//     cell:  bit 7 = horizontal flip, bits 0-6 = MAP GROUP slot (0-127)
//     flags: bit 7 = vertical flip of cell 0, bit 6 of cell 1 ... bit 0 of cell 7
//
// So the playfield is 16 chips = 256 px wide and 2,048 px tall; the earlier
// "18 columns" reading counted the two flag bytes as cells. A cell's slot
// names a MAP GROUP word (groups.js), and slot 0 is by the editor's
// convention the blank chip.
//
// SCROLL EFECT is 6 x 0x200: two 256-byte tables, one entry per 64 px of the
// stage. The first is the map-row-block sequencer (FORMAT-SFC.md "MAP DATA
// and SCROLL EFECT", traced): the streamer fetches block A[(scroll >> 6) + 4]
// and shows map rows A[i]*4 .. +3, so the clear routine's i & 0x1F plays the
// map in order and replays it every 2,048 px. The second (cleared to 0x42)
// has no reader in the play engine — the scroll runs at exactly 1 px/frame.
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";

export const STAGE_COUNT = 6;
export const MAP_STAGE_BYTES = REGION.map.length / STAGE_COUNT; // 0x900
export const MAP_ROW_BYTES = 18;
export const MAP_COLUMNS = 16;
export const MAP_ROWS = MAP_STAGE_BYTES / MAP_ROW_BYTES; // 128
export const MAP_CELL_SLOT_MASK = 0x7f;
export const MAP_CELL_HFLIP = 0x80;
export const SCROLL_STAGE_BYTES = REGION.scroll.length / STAGE_COUNT; // 0x200
export const SCROLL_BANDS = 256;
export const SCROLL_BAND_PX = 8;
export const SCROLL_SPEED_OFFSET = 0x100;
/** What the editor's clear writes: effect i & 0x1F, speed 0x42. */
export const SCROLL_DEFAULT_SPEED = 0x42;
export function scrollDefaultEffect(band) {
    return band & 0x1f;
}

function stageSlice(bytes, region, stage, size) {
    const offset = region.offset + stage * size;
    if (offset + size > bytes.length) {
        throw new Error(`${region.label} stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    return { offset, view: bytes.subarray(offset, offset + size) };
}

/** One 18-byte row -> 16 cells of {slot, hflip, vflip}. */
export function decodeMapRow(bytes, at) {
    const cells = [];
    for (let half = 0; half < 2; half++) {
        const base = at + half * 9;
        const flags = bytes[base + 8];
        for (let k = 0; k < 8; k++) {
            const b = bytes[base + k];
            cells.push({ slot: b & MAP_CELL_SLOT_MASK, hflip: (b & MAP_CELL_HFLIP) !== 0, vflip: ((flags >> (7 - k)) & 1) !== 0 });
        }
    }
    return cells;
}

/** The inverse: 16 cells of {slot, hflip, vflip} -> 18 bytes at `at`. */
export function encodeMapRow(bytes, at, cells) {
    for (let half = 0; half < 2; half++) {
        const base = at + half * 9;
        let flags = 0;
        for (let k = 0; k < 8; k++) {
            const c = cells[half * 8 + k] || { slot: 0 };
            bytes[base + k] = (c.slot & MAP_CELL_SLOT_MASK) | (c.hflip ? MAP_CELL_HFLIP : 0);
            if (c.vflip) flags |= 1 << (7 - k);
        }
        bytes[base + 8] = flags;
    }
    return bytes;
}

/**
 * A stage: {stage, offset, columns, rows, slots, hflips, vflips, used,
 * flipped, maxSlot} — the three arrays are row-major 16 x 128, `used` counts
 * cells naming a slot other than 0.
 */
export function decodeMapStage(bytes, stage) {
    const { offset, view } = stageSlice(bytes, REGION.map, stage, MAP_STAGE_BYTES);
    const n = MAP_COLUMNS * MAP_ROWS;
    const slots = new Uint8Array(n), hflips = new Uint8Array(n), vflips = new Uint8Array(n);
    let used = 0, flipped = 0, maxSlot = 0;
    for (let r = 0; r < MAP_ROWS; r++) {
        const cells = decodeMapRow(view, r * MAP_ROW_BYTES);
        cells.forEach((c, k) => {
            const i = r * MAP_COLUMNS + k;
            slots[i] = c.slot;
            hflips[i] = c.hflip ? 1 : 0;
            vflips[i] = c.vflip ? 1 : 0;
            if (c.slot) {
                used++;
                if (c.slot > maxSlot) maxSlot = c.slot;
            }
            if (c.hflip || c.vflip) flipped++;
        });
    }
    return { stage, offset, columns: MAP_COLUMNS, rows: MAP_ROWS, slots, hflips, vflips, used, flipped, maxSlot };
}

export function decodeMapData(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) stages.push(decodeMapStage(bytes, s));
    return stages;
}

/** A stage's two tables: {stage, offset, effect, speed, min, max} (min/max over the speed table). */
export function decodeScrollEffect(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
        const { offset, view } = stageSlice(bytes, REGION.scroll, s, SCROLL_STAGE_BYTES);
        const effect = view.subarray(0, SCROLL_BANDS);
        const speed = view.subarray(SCROLL_SPEED_OFFSET, SCROLL_SPEED_OFFSET + SCROLL_BANDS);
        let min = 255, max = 0;
        for (let i = 0; i < speed.length; i++) {
            if (speed[i] < min) min = speed[i];
            if (speed[i] > max) max = speed[i];
        }
        stages.push({ stage: s, offset, bytes: view, effect, speed, min, max });
    }
    return stages;
}

/** Map rows per sequencer block. */
export const MAP_BLOCK_ROWS = 4;

/**
 * The sequencer for a stage whose first `openingBlocks` blocks must never be
 * shown again — a story painted into its opening rows (sfc-write.js): the map
 * once in order, then blocks openingBlocks..31 round and round, where the
 * clear routine's i & 0x1F would bring the opening back every 2,048 px.
 */
export function storyScrollSequence(openingBlocks) {
    const blocks = MAP_ROWS / MAP_BLOCK_ROWS;
    const k = Math.max(0, Math.min(blocks - 1, openingBlocks));
    const seq = new Uint8Array(SCROLL_BANDS);
    for (let i = 0; i < SCROLL_BANDS; i++) seq[i] = i < blocks ? i : k + ((i - k) % (blocks - k));
    return seq;
}

/** A stage's block sequencer (the first of its two tables). */
export function writeScrollSequence(bytes, stage, seq) {
    bytes.set(seq.subarray(0, SCROLL_BANDS), REGION.scroll.offset + stage * SCROLL_STAGE_BYTES);
    return bytes;
}

/** The editor's clear image of a stage's two tables, written at `at`. */
export function writeDefaultScroll(bytes, stage) {
    const at = REGION.scroll.offset + stage * SCROLL_STAGE_BYTES;
    for (let i = 0; i < SCROLL_BANDS; i++) {
        bytes[at + i] = scrollDefaultEffect(i);
        bytes[at + SCROLL_SPEED_OFFSET + i] = SCROLL_DEFAULT_SPEED;
    }
    return bytes;
}
