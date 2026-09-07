// ENEMY DATA and APPEAR DATA: the second segment's behaviour tables.
//
// ENEMY DATA is 24 records of 128 bytes, one per enemy type; the sample fills
// 23 of them. APPEAR DATA is 6 stages x 0x1200 bytes — where and when those
// enemies turn up — and every stage in the sample opens with fourteen zero
// bytes and fourteen 0xFF. Both are handed out as raw views with the strides
// applied; the fields inside await the tracing in FORMAT-SFC.md.
// Environment-neutral ESM (Node + browser).

import { REGION } from "./regions.js";
import { isBlank } from "./sram.js";

export const ENEMY_COUNT = 24;
export const ENEMY_RECORD_BYTES = REGION.enemyData.length / ENEMY_COUNT; // 0x80
export const APPEAR_STAGE_COUNT = 6;
export const APPEAR_STAGE_BYTES = REGION.appear.length / APPEAR_STAGE_COUNT; // 0x1200

function need(bytes, region) {
    if (bytes.length < region.end) {
        throw new Error(`${region.label} at 0x${region.offset.toString(16)} runs past the end (${bytes.length})`);
    }
}

export function decodeEnemyData(bytes) {
    need(bytes, REGION.enemyData);
    const records = [];
    for (let i = 0; i < ENEMY_COUNT; i++) {
        const offset = REGION.enemyData.offset + i * ENEMY_RECORD_BYTES;
        const view = bytes.subarray(offset, offset + ENEMY_RECORD_BYTES);
        records.push({ index: i, offset, bytes: view, blank: isBlank(view) });
    }
    return records;
}

export function decodeAppearData(bytes) {
    need(bytes, REGION.appear);
    const stages = [];
    for (let s = 0; s < APPEAR_STAGE_COUNT; s++) {
        const offset = REGION.appear.offset + s * APPEAR_STAGE_BYTES;
        const view = bytes.subarray(offset, offset + APPEAR_STAGE_BYTES);
        let used = 0;
        for (let i = 0; i < view.length; i++) if (view[i]) used++;
        stages.push({ stage: s, offset, bytes: view, used, blank: used === 0 });
    }
    return stages;
}
