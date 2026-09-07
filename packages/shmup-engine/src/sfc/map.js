// MAP DATA and SCROLL EFECT: the six stages' scenery.
//
// MAP DATA is 0x3600 bytes, one byte per 16x16 chip: 6 stages x 0x900. A
// stage is 18 chips across and 128 down — 288 x 2048 pixels, a playfield two
// chips wider than the 256-pixel screen. The width is measured, not assumed:
// vertical continuity (cell == cell one row down) beats every non-multiple
// width in all six sample stages, its multiples 36 and 54 trailing as
// harmonics (36 edges 18 by 0.002 in stage 4, the one stage where 18 is not
// the outright peak), while 16 scores no better than noise; 0x900 / 18 is
// exactly 128. Rendered at 18 the scenery stands upright
// Columns 0 and 16 hold no non-zero cell in any stage and columns 8 and 17 are
// sparse, roughly a third as full as the rest, so the drawn field is narrower
// than the stride — per-row markers rather than scenery, possibly, which is
// open. Cell values index MAP GROUP; bit 7 is set on some cells in the sample
// and is left uninterpreted.
//
// SCROLL EFECT is 6 x 0x200 bytes of per-stage scroll tables by size. In the
// sample the region opens with 0x100 bytes of small integers, and smooth
// curves around 0x40 (padded with 0x1F/0x1D) recur every 0x200 from +0x100 —
// so the six-way split here is a placeholder until the tables are traced.
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";

export const STAGE_COUNT = 6;
export const MAP_STAGE_BYTES = REGION.map.length / STAGE_COUNT; // 0x900
export const MAP_COLUMNS = 18;
export const MAP_ROWS = MAP_STAGE_BYTES / MAP_COLUMNS; // 128
export const SCROLL_STAGE_BYTES = REGION.scroll.length / STAGE_COUNT; // 0x200
export const MAP_CHIP_MASK = 0x7f;
export const MAP_CELL_FLAG = 0x80;

function stageSlice(bytes, region, stage, size) {
    const offset = region.offset + stage * size;
    if (offset + size > bytes.length) {
        throw new Error(`${region.label} stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
    }
    return { offset, view: bytes.subarray(offset, offset + size) };
}

export function decodeMapStage(bytes, stage) {
    const { offset, view } = stageSlice(bytes, REGION.map, stage, MAP_STAGE_BYTES);
    let used = 0, flagged = 0, maxChip = 0;
    for (let i = 0; i < view.length; i++) {
        const v = view[i];
        if (!v) continue;
        used++;
        if (v & MAP_CELL_FLAG) flagged++;
        if ((v & MAP_CHIP_MASK) > maxChip) maxChip = v & MAP_CHIP_MASK;
    }
    return { stage, offset, cells: view, columns: MAP_COLUMNS, rows: MAP_ROWS, used, flagged, maxChip };
}

export function decodeMapData(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) stages.push(decodeMapStage(bytes, s));
    return stages;
}

/**
 * Vertical continuity of a stage's cells at a candidate row width: the share
 * of cell pairs one row apart that hold the same non-zero chip. The width
 * that maximises it is the map's — the measurement behind MAP_COLUMNS.
 */
export function rowContinuity(cells, width) {
    let same = 0, pairs = 0;
    for (let i = 0; i + width < cells.length; i++) {
        if (!cells[i] && !cells[i + width]) continue;
        pairs++;
        if (cells[i] === cells[i + width]) same++;
    }
    return pairs ? same / pairs : 0;
}

export function decodeScrollEffect(bytes) {
    const stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
        const { offset, view } = stageSlice(bytes, REGION.scroll, s, SCROLL_STAGE_BYTES);
        let min = 255, max = 0;
        for (let i = 0; i < view.length; i++) {
            if (view[i] < min) min = view[i];
            if (view[i] > max) max = view[i];
        }
        stages.push({ stage: s, offset, bytes: view, min, max });
    }
    return stages;
}
