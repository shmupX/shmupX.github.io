// Dezaemon 2 stage decoder — sec5 region map and the background tilemap.
//
// sec5 is the 組み子さん (game assembly) section. Its region boundaries come
// from explicit multiplications in the engine's own code (KUMITATE/GAME
// literal pools) and tile the 396,640 bytes exactly; see FORMAT.md.
//
// The background tilemap is fully decoded: each stage owns a 0x5400-byte
// bank holding 14 columns x 768 rows of u16be words, which the editor
// presents as 48 "parts" (screens) of 16 rows each. A word of 0xFFFF is an
// empty tile; otherwise bit15 = vertical flip, bit14 = horizontal flip, and
// bits 0-9 index the 1024-cell CG space (4 pages x 256 cells of 16x16 px).
// The flip bits are the SAME convention as the sprite composition banks
// (FORMAT.md) — an earlier revision had them swapped here, which garbled
// every mirror-symmetric background (e.g. Ramsie's boss chambers).
//
// Environment-neutral ESM (Node + browser).

import { decodeEnemyRecord, zakoRecordFromKey } from "./decode-enemy.js";

export const SEC5_REGIONS = {
    stageBanks: { offset: 0x00000, count: 10, stride: 0x5400 },
    scrollCurves: { offset: 0x34800, count: 10, stride: 0x00c0 },
    placement: { offset: 0x34f80, count: 10, stride: 0x3c00 },
    settings: { offset: 0x5a780, count: 1, stride: 0x0060 },
    enemies: { offset: 0x5a7e0, count: 10, stride: 0x0478 },
    spriteBank: { offset: 0x5d490, count: 1, stride: 0x01d0 },
    spriteStages: { offset: 0x5d660, count: 10, stride: 0x0580 },
};

export const MAX_STAGES = 10;
export const BG_COLS = 14;
export const BG_ROWS = 768;
export const BG_ROWS_PER_PART = 16;
export const BG_PARTS = BG_ROWS / BG_ROWS_PER_PART; // 48
export const BG_EMPTY = 0xffff;

// Decode one stage's background map into {cell, hflip, vflip} entries, plus
// which of the 48 parts hold anything.
export function decodeStageBackground(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.stageBanks;
    const base = offset + stage * stride;
    const tiles = new Array(BG_COLS * BG_ROWS);
    const partUsed = new Uint8Array(BG_PARTS);
    let usedTiles = 0;
    for (let i = 0; i < tiles.length; i++) {
        const o = base + i * 2;
        const word = (sec5[o] << 8) | sec5[o + 1];
        if (word === BG_EMPTY) {
            tiles[i] = null;
            continue;
        }
        tiles[i] = {
            cell: word & 0x3ff,
            hflip: (word & 0x4000) !== 0,
            vflip: (word & 0x8000) !== 0,
        };
        usedTiles++;
        partUsed[(i / (BG_COLS * BG_ROWS_PER_PART)) | 0] = 1;
    }
    let partCount = 0;
    for (const u of partUsed) partCount += u;
    return {
        stage,
        cols: BG_COLS,
        rows: BG_ROWS,
        tiles,
        partUsed,
        partCount,
        usedTiles,
        empty: partCount === 0,
    };
}

// All stages; `stageCount` = highest non-empty stage + 1 (a game's real
// stage count — cross-checked against the disc's per-stage demo recordings).
export function decodeStages(sec5) {
    const stages = [];
    for (let s = 0; s < MAX_STAGES; s++) {
        const bg = decodeStageBackground(sec5, s);
        stages.push({
            ...bg,
            placement: decodeStagePlacement(sec5, s),
            enemies: decodeStageEnemies(sec5, s),
            scrollCurve: scrollCurveBytes(sec5, s),
        });
    }
    // Stage count comes from the placement grid rather than the background
    // map: the two disagree in 6 of 17 corpus games (a stage can carry
    // objects with an unpainted background, e.g. cut-scene stages), and
    // placement agrees with the enemy blocks everywhere.
    let stageCount = 0;
    stages.forEach((s, i) => {
        if (s.placement.objects.length) stageCount = i + 1;
    });
    return { stages, stageCount };
}

// --- Scroll curve ----------------------------------------------------
//
// Each stage owns 192 bytes at sec5 +0x34800 + stage*0xC0 — one byte per
// 64 px of map (4 rows), indexed live as stage*0xC0 + scrollPos>>6 and
// re-read every frame (GAME.bin +0x1DF44 stage init / +0x1E04C per-frame,
// traced 2026-08-28). The byte packs two settings:
//
//   bits 0-2  background scroll speed: u16 table +0x25B14
//             [0,64,128,192,256,384,512,1024] in 1/256 px per frame
//             (0 / 0.25 / 0.5 / 0.75 / 1.0 / 1.5 / 2.0 / 4.0 px/f); the
//             engine EASES toward it at ±(12 + gap/16) units per frame,
//             so curve plateaus are targets, not steps. Horizontal games
//             scroll the same units x365/256 (~320/224).
//   bits 3-5  raster-wave amplitude: u16 table +0x25B24 = px<<8 of
//             [0,1,3,5,9,15,22,30] (ramped +-32/frame toward the target)
//   bits 6-7  raster-wave type: 0 vertical ripple (VDP2 line-scroll Y),
//             1 traveling horizontal sine (line-scroll X), 2 per-line
//             random shake (X), 3 line-zoom bulge centered mid-screen
//
// (The engine substitutes a constant 0x02 byte when its play-STATE byte
// 0x060840C5 equals 2 — a demo/attract state, not the settings game mode;
// normal play always consumes the authored curve.)
export const SCROLL_SPEED_TABLE = [0, 64, 128, 192, 256, 384, 512, 1024];
export const SCROLL_WAVE_AMP_TABLE = [0, 1, 3, 5, 9, 15, 22, 30];
export const SCROLL_WAVE_TYPES = ["ripple", "sine", "shake", "zoom"];

// One stage's raw curve bytes (the compact form the mapper ships).
export function scrollCurveBytes(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.scrollCurves;
    const base = offset + stage * stride;
    return sec5.subarray(base, base + stride);
}

// Decoded view: one entry per 4 map rows, in engine units.
export function decodeScrollCurve(sec5, stage) {
    return Array.from(scrollCurveBytes(sec5, stage), (b) => ({
        speed: SCROLL_SPEED_TABLE[b & 7] / 256, // px per frame at 60 Hz
        waveType: SCROLL_WAVE_TYPES[(b >> 6) & 3],
        waveAmp: SCROLL_WAVE_AMP_TABLE[(b >> 3) & 7], // px
    }));
}

// --- Enemy placement -------------------------------------------------
//
// Each stage owns a 0x3C00-byte grid of BYTES: 20 columns x 768 rows, the
// same 768 rows / 48 parts as the background map (so placement row N sits on
// background row N). The grid spans the 320px screen; the 224px playfield
// (the background's 14 columns) sits at columns 3..16. 0 means "nothing
// here"; every other byte is an object id drawn from exactly 72 values in
// eight disjoint ranges, measured over all 17 games:
//
//   0x80-0x97, 0xA0-0xA7, 0xB0-0xBF, 0xC0-0xC3, 0xD0-0xD3, 0xE0-0xE3
//       -> 60 zako slots, in the same order as the 60 enemy records
//   0xE8-0xEF -> the editor's 8 item slots
//   0xF0-0xF3 -> boss, one of 4 size classes (at most one per stage)
//
// The zako ranges map onto the per-stage enemy records at 99.9% agreement:
// of 7740 (stage, record) pairs checked, a placed id had an all-zero record
// only 8 times.

export const PLACEMENT_COLS = 20;
export const PLACEMENT_ROWS = 768;
export const PLAYFIELD_COL_START = 3;
export const PLAYFIELD_COL_END = 16;

// Zako id ranges, in record order: [firstId, count].
export const ZAKO_GROUPS = [[0x80, 24], [0xa0, 8], [0xb0, 16], [0xc0, 4], [0xd0, 4], [0xe0, 4]];
export const ZAKO_SLOT_COUNT = 60;

export function isBoss(id) {
    return id >= 0xf0 && id <= 0xf3;
}

// Map an id to its index in the 60-entry enemy record table, or -1.
export function zakoRecordIndex(id) {
    let base = 0;
    for (const [first, count] of ZAKO_GROUPS) {
        if (id >= first && id < first + count) return base + (id - first);
        base += count;
    }
    return -1;
}

// The engine's own placement-cell-byte -> record-index math lives next to the
// record decoder (this module already depends on it); re-exported here because
// it is a placement concept too.
export { ZAKO_BAND_ART_MASK, ZAKO_BAND_BASE, zakoRecordFromKey } from "./decode-enemy.js";

// The inverse: the placement id a record index is placed as. The mapping is a
// bijection over the 60 zako slots, which is what lets an enemy's FORMATION KEY
// (the engine's per-slot `0x06090530[slot]` = the placement cell byte) be
// recovered from its record index alone — no extra per-object data to carry.
export function zakoPlacementId(record) {
    let base = 0;
    for (const [first, count] of ZAKO_GROUPS) {
        if (record >= base && record < base + count) return first + (record - base);
        base += count;
    }
    return -1;
}

export function describePlacementId(id) {
    if (isBoss(id)) return { id, kind: "boss", sizeClass: id & 0x0f, record: -1 };
    if (id >= 0xe8 && id <= 0xef) return { id, kind: "item", slot: id & 0x07, record: -1 };
    const record = zakoRecordIndex(id);
    if (record >= 0) return { id, kind: "zako", record, group: id >> 4, slot: id & 0x0f };
    // Anything else is outside the 72 observed values (two stray bytes in the
    // whole corpus); surface it rather than inventing a class.
    return { id, kind: "unknown", record: -1 };
}

// Decode one stage's placement grid into a list of placed objects, in the
// order the stage scrolls (row 0 first).
export function decodeStagePlacement(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.placement;
    const base = offset + stage * stride;
    const objects = [];
    let boss = null;
    for (let row = 0; row < PLACEMENT_ROWS; row++) {
        for (let col = 0; col < PLACEMENT_COLS; col++) {
            const id = sec5[base + row * PLACEMENT_COLS + col];
            if (!id) continue;
            const obj = { ...describePlacementId(id), row, col, part: (row / BG_ROWS_PER_PART) | 0 };
            objects.push(obj);
            if (obj.kind === "boss") boss = obj;
        }
    }
    return { stage, cols: PLACEMENT_COLS, rows: PLACEMENT_ROWS, objects, boss };
}

// --- Enemy records ----------------------------------------------------
//
// Each stage owns a 0x478 block: 60 enemy records of 18 bytes (0x438) plus a
// 0x40 trailer the play engine indexes separately. Record N defines the zako
// whose placement ids are the Nth entry of ZAKO_GROUPS order.
//
// The record is field-specialised but not yet fully mapped. Measured over
// 6799 populated records across all 17 games, 96.5% of nibbles are <= 8 and
// the per-nibble cardinalities are tight (several booleans, several 0-4
// enums, several 1-8 sliders) — matching the editor's attribute model, where
// LIFE / speed / fire timing / anim speed are 1-8 sliders and fire type is a
// 5-way choice. Per-byte distinct-value counts across the corpus are
// 200,108,138,68,94,79,16,65,14,40,51,14,33,77,12,16,72,15; the layout falls
// into a 6-byte head plus four 3-byte groups.

export const ENEMY_RECORD_SIZE = 18;
export const ENEMY_BLOCK_TRAILER = 0x40;

export function decodeStageEnemies(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.enemies;
    const base = offset + stage * stride;
    const records = [];
    for (let i = 0; i < ZAKO_SLOT_COUNT; i++) {
        const at = base + i * ENEMY_RECORD_SIZE;
        const bytes = sec5.subarray(at, at + ENEMY_RECORD_SIZE);
        let defined = false;
        for (const b of bytes) if (b) { defined = true; break; }
        records.push({ index: i, defined, bytes });
    }
    return {
        stage,
        records,
        definedCount: records.filter((r) => r.defined).length,
        trailer: sec5.subarray(base + ZAKO_SLOT_COUNT * ENEMY_RECORD_SIZE, base + stride),
    };
}

// --- Editor-facing projection -----------------------------------------
//
// Turn the decoded stages into the shape lib/map-to-game.js consumes:
// an enemy roster plus per-stage spawn rows in scroll order.
//
// The projection is lossless by construction — every placed object survives:
//
//   * Enemy identity is the (stage, record) PAIR, not the record. A save
//     carries its own 60 enemy definitions per stage, and the same record
//     index holds different bytes — and different art — in almost every
//     stage that uses it (DAIOH's record 0 has nine distinct definitions
//     across its nine stages, and 56 of its 60 records vary by stage).
//     Keying on the record alone silently merged them into one enemy.
//   * The grid is the placement grid's own 20 columns, so a cell holds
//     exactly what the save's cell held and no two placements ever share
//     one. The old 8-column binning collided 14% of DAIOH's spawns onto
//     cells already taken, dropping them. Twenty rather than the 14-column
//     playfield because games really do use the full width: 342 of Ramsie's
//     2,308 placements sit outside columns 3..16, spread evenly enough that
//     they are level design, not stray bytes.
//   * Rows that hold nothing are still skipped, but each emitted row records
//     the scroll row it came from (`waveRows`), so the stage's pacing — gaps
//     of up to 177 rows between waves — survives the round trip.

export const PLAYFIELD_COLS = PLAYFIELD_COL_END - PLAYFIELD_COL_START + 1; // 14
const EDITOR_COLS = 8; // legacy width, kept for placementColumnToEditor()

// Legacy 8-column binning. Superseded by the save's own column index for
// imports; still exported because it defines the historical mapping.
export function placementColumnToEditor(col) {
    const rel = Math.min(PLAYFIELD_COLS - 1, Math.max(0, col - PLAYFIELD_COL_START));
    return Math.min(EDITOR_COLS - 1, Math.floor((rel * EDITOR_COLS) / PLAYFIELD_COLS));
}

// A grid column is the placement column, unchanged — the whole point is that
// the projection does not move anything. Clamped only so a corrupt byte
// cannot index off the row.
export function placementColumn(col) {
    return Math.min(PLACEMENT_COLS - 1, Math.max(0, col));
}

// Identity key for a (stage, record) enemy.
export function enemyPairKey(stage, record) {
    return `${stage}:${record}`;
}

// stages -> {enemies, stages, stagesUsing} for mapSaveToGame().
// Records a stage can spawn through mode-2 death words but never places on its
// grid, found by walking parent -> child until nothing new turns up. The engine
// has no depth limit here (a child's own record supplies its own death word),
// so the walk is bounded only by the 60-record table.
function deathChildClosure(stage, placed) {
    const found = new Set();
    const queue = [...placed];
    const seen = new Set(queue);
    while (queue.length) {
        const record = queue.pop();
        const entry = stage.enemies.records[record];
        if (!entry || !entry.defined) continue;
        const bytes = entry.bytes;
        if (((bytes[2] >> 6) & 3) !== 2) continue;
        const child = zakoRecordFromKey(bytes[3] | 0x80);
        if (child < 0 || child >= ZAKO_SLOT_COUNT || seen.has(child)) continue;
        seen.add(child);
        // Only a record with content is worth carrying — an all-zero one would
        // land in the roster as an invisible do-nothing enemy.
        if (!stage.enemies.records[child] || !stage.enemies.records[child].defined) continue;
        found.add(child);
        queue.push(child);
    }
    return found;
}

// `itemSlots` is decode-settings' slot table; with it each placed item drops
// as its authored TYPE instead of the legacy even spread.
export function projectForEditor(stages, { cols = PLACEMENT_COLS, itemSlots = null } = {}) {
    // Roster: every (stage, record) pair placed anywhere, in stage-then-record
    // order. There is no cap to ration any more, and stage order is what makes
    // a 340-entry roster readable in the editor's enemy picker.
    const uses = new Map(); // "stage:record" -> placement count
    stages.forEach((st, s) => {
        for (const o of st.placement.objects) {
            if (o.kind !== "zako") continue;
            const key = enemyPairKey(s, o.record);
            uses.set(key, (uses.get(key) || 0) + 1);
        }
    });

    const enemies = [];
    const indexOf = new Map(); // "stage:record" -> roster index
    stages.forEach((st, s) => {
        const placed = new Set(
            st.placement.objects.filter((o) => o.kind === "zako").map((o) => o.record),
        );
        // A record the map never places can still reach the screen: the death
        // word's child mode spawns one from the same stage's table when its
        // parent dies, and that child may spawn a child of its own. Follow that
        // chain so the roster holds everything the stage can actually put in
        // front of the player, not just what the grid seeds.
        for (const record of deathChildClosure(st, placed)) placed.add(record);
        for (const record of [...placed].sort((a, b) => a - b)) {
            const key = enemyPairKey(s, record);
            indexOf.set(key, enemies.length);
            const bytes = st.enemies.records[record] ? st.enemies.records[record].bytes : null;
            enemies.push({
                // stage-qualified so two stages' record 7 stay distinct
                name: `deza${s}_${String(record).padStart(2, "0")}`,
                stage: s,
                record,
                key,
                // 0 for a record the grid never places — it reaches the
                // screen only as another record's death-word child.
                placements: uses.get(key) || 0,
                // The 18-byte definition decoded into named fields — hp, score,
                // speed, fire config and the four change channels. Engine-traced
                // (see decode-enemy.js); this is what makes imported enemies
                // play with their own stats instead of defaults.
                behavior: bytes ? decodeEnemyRecord(bytes) : null,
                // The raw 18 bytes still ride along for auditability.
                bytes,
            });
        }
    });

    // Every stage that places a record — art is per stage, so an enemy whose
    // own stage left the sprite slot unpainted can still fall back to another.
    const stagesUsing = new Map();
    stages.forEach((st, i) => {
        for (const o of st.placement.objects) {
            if (o.kind !== "zako") continue;
            if (!stagesUsing.has(o.record)) stagesUsing.set(o.record, []);
            const list = stagesUsing.get(o.record);
            if (!list.includes(i)) list.push(i);
        }
    });

    const projected = stages.map((st, s) => {
        const byRow = new Map();
        const rowOf = (row) => {
            if (!byRow.has(row)) byRow.set(row, new Array(cols).fill(null));
            return byRow.get(row);
        };
        for (const o of st.placement.objects) {
            if (o.kind !== "zako") continue;
            const idx = indexOf.get(enemyPairKey(s, o.record));
            if (idx === undefined) continue;
            rowOf(o.row)[placementColumn(o.col)] = { enemy: idx, drop: 0 };
        }
        // Item pickups stand alone on the Dezaemon grid, but the Phaser runtime
        // only drops items from a killed enemy. Hang each one on the nearest
        // enemy in its own column so the pickup still exists in play; the raw
        // slot and position are kept in `items` either way.
        const items = st.placement.objects
            .filter((o) => o.kind === "item")
            .map((o) => {
                const def = itemSlots && itemSlots[o.slot & 7];
                return {
                    slot: o.slot,
                    row: o.row,
                    col: placementColumn(o.col),
                    ...(def ? { type: def.type, movement: def.movement } : {}),
                };
            });
        const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
        for (const item of items) {
            const host = nearestSpawn(byRow, sortedRows, item.row, item.col);
            if (!host) continue;
            host.drop = item.type !== undefined
                ? (ITEM_TYPE_DROPS[item.type] ?? 0)
                : ITEM_SLOT_DROPS[item.slot % ITEM_SLOT_DROPS.length];
        }
        return {
            rows: sortedRows.map((r) => byRow.get(r)),
            // Scroll row each wave came from, same order as `rows`.
            waveRows: sortedRows,
            cols,
            boss: st.placement.boss || null,
            items,
            // The stage's own scroll curve (192 raw bytes — see the region
            // decoder above), so the mapper can ship the save's pacing.
            scrollCurve: st.scrollCurve || null,
        };
    });
    return { enemies, stages: projected, stagesUsing };
}

// Runtime drop codes by item TYPE (slot byte & 15, decode-settings.js):
// 0-3 weapon change -> 2 (the runtime's weapon-change pickup), 4 barrier ->
// 9, 5 bomb stock -> 5 (SP-gauge charge), 6 score bonus -> 4, 7 power-up ->
// 1 (shot upgrade), 8 speed-up -> 3.
export const ITEM_TYPE_DROPS = [2, 2, 2, 2, 9, 5, 4, 1, 3];
// Legacy spread for saves whose settings block did not decode: keeps every
// placed item in the level at the cost of arbitrary identities.
export const ITEM_SLOT_DROPS = [1, 1, 2, 2, 3, 3, 9, 9];

function nearestSpawn(byRow, sortedRows, row, col) {
    let best = null;
    let bestDist = Infinity;
    for (const r of sortedRows) {
        const d = Math.abs(r - row);
        if (d >= bestDist) continue;
        const cell = byRow.get(r)[col];
        if (!cell) continue;
        best = cell;
        bestDist = d;
    }
    return best;
}

// Raw slices of the still-undecoded regions, so callers can surface them
// (and so the region math stays in one place).
export function sec5Regions(sec5) {
    return Object.entries(SEC5_REGIONS).map(([name, r]) => ({
        name,
        offset: r.offset,
        count: r.count,
        stride: r.stride,
        length: r.count * r.stride,
    }));
}
