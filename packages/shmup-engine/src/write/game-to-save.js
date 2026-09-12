// game.json -> the eight raw sections of a Dezaemon 2 save: the inverse of
// map-to-game.js, as far as the format is decoded (FORMAT.md).
//
// Input is a level record as the editor saves it to the cloud (levels/<name>)
// or as static/games/2028-ai/foo.json ships it: `enemylist` + `width` for the
// open stage (and `stages.stageN` for the rest), `enemyData`, `bossData`,
// `playerData`, plus whatever an import carried back (`dezaemon.*` blocks,
// `background`/`backgroundCells`, `scroll`, `items`, `dezaemonBgm`). The art
// arrives separately as RGBA frames keyed by atlas frame name — this module
// has no canvas, so the caller slices the atlas (lib/ps2/png.ts in Deno, a
// canvas in the editor).
//
// What lands where:
//
//   sec0-3  CG pages: every frame the game needs, reduced to a palette
//           target (palette-target.js: "saturn" or "snes") and packed into
//           shared 16x16 cells (cg-pack.js)
//   sec4    the palette bank that target produced
//   sec5    per stage: placement grid (20 x 768 bytes), the 60 enemy records
//           + boss trailer, the sprite composition bank, the scroll curve
//           and the background tilemap; the global bank (ship, the player's
//           weapon art — refs 48-93, every shot/beam/pod/bomb the engine
//           draws for the player, invisible when left empty — item icons,
//           blast anims, bullet anims, title logos); the settings block
//   sec6    24 song slots — the level's own Dezaemon soundtrack when it has
//           one, else the engine's empty-song template
//   sec7    all zero: no 3D models (the decoder treats a missing magic as
//           "the 3D editor was never opened", the way Ramsie's save reads)
//
// Grid geometry: a stage's json rows spawn LAST ROW FIRST (the runtime
// reverses them), so they are reversed here into scroll order; `waveRows`
// (an import's scroll row per wave) places waves exactly where the save had
// them, otherwise waves go every ROW_STEP rows from FIRST_SPAWN_ROW. Columns
// map the level's width onto the 20-column placement grid — the 14-column
// playfield (columns 3-16) for the editor's 8/14-wide levels, the identity
// for 20-wide imports.
//
// Enemy records: an import's own 18 bytes go back verbatim (`dezaemon.
// attributes`), preferring the record slot they came from so death-word
// children still resolve; an authored enemy is encoded from its hp, score,
// interval and speed with a straight-down flier appearance (ids 0x20-0x27,
// which the appearance table shows as "fly down at 0.5..6 px/frame, may
// fire"). Sprite art picks the smallest band whose frame size holds the
// sprite, downscaling only what exceeds 64x64.
//
// Environment-neutral ESM (Node + browser).

import {
    BG_COLS,
    BG_ROWS,
    ITEM_TYPE_DROPS,
    MAX_STAGES,
    PLACEMENT_COLS,
    PLACEMENT_ROWS,
    SEC5_REGIONS,
    zakoPlacementId,
} from "../decode/decode-stage.js";
import {
    BOSS_CORE_GEOM,
    BOSS_CORE_OFFSET,
    coreCellOrder,
    EMPTY_REF,
    GLOBAL_WEAPON_SLOTS,
    RECORD_ART,
    TITLE_SLOTS,
} from "../decode/decode-sprites.js";
import {
    BOSS_FIRE_TICK_FRAMES,
    BOSS_HP_TABLE,
    BOSS_SCORE_TABLE,
    BOSS_TRAILER_OFFSET,
    BOSS_TRAILER_SIZE,
} from "../decode/decode-boss.js";
import { ANIM_PERIOD_TABLE, FIRE_INTERVAL_TABLE, HP_TABLE, SCORE_TABLE } from "../decode/decode-enemy.js";
import { MEASURE_SIZE, MEASURES, SONG_SIZE, SONG_SLOTS } from "../decode/decode-song.js";
import { SECTION_SIZES } from "../decompress.js";
import { decodePlayerArt } from "../player-art.js";
import { bankToSec4, frameGroup, quantizeFrames } from "../palette/palette-target.js";
import { CG_CELL } from "../palette/deza2-palette.js";
import { CgFullError, CgPacker, REF_HFLIP, REF_VFLIP } from "./cg-pack.js";

// --- layout constants ------------------------------------------------------------

/** Scroll row of the first wave when the level carries no `waveRows`. */
export const FIRST_SPAWN_ROW = 8;
/** Rows between waves without `waveRows` (16 px each; ~3 s at 1 px/frame). */
export const ROW_STEP = 12;
/** The boss waits this many rows past the last wave. */
export const BOSS_ROW_GAP = 24;
export const MAX_SPAWN_ROW = PLACEMENT_ROWS - 32;
export const PLAYFIELD_FIRST_COL = 3;
export const PLAYFIELD_COLS = 14;
export const BOSS_COL = 9;

/** The eight item slots (settings +0x1C..): item TYPE per slot. */
export const DEFAULT_ITEM_TYPES = [7, 0, 8, 6, 5, 4, 1, 2];
/** Items bounce (movement 1), the way most community games set them. */
export const DEFAULT_ITEM_MOVEMENT = 1;
/** Runtime drop digit -> item slot under DEFAULT_ITEM_TYPES. */
export const DROP_TO_SLOT = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 9: 5 };

/** Appearance ids 0x20-0x27: straight-down fliers at these speeds (units/frame, 256 = 1 px). */
export const STRAIGHT_APPEARANCE_BASE = 0x20;
/** Band 6 (4x4 cells, 64x64) carries a story picture's quarters. */
export const STORY_PICTURE_BAND = 6;
/** Band 4 (4x2 cells, 64x32) carries the story strip's quarters. */
export const STORY_TEXT_BAND = 4;
/**
 * Scroll rows the stage's own waves are pushed back by, so the story has the
 * opening to itself. At 16 px a row this is a little over a screen and a half
 * of scroll — time to read the line before anything is shooting.
 */
export const STORY_QUIET_ROWS = 48;
export const STRAIGHT_SPEEDS = [128, 256, 384, 512, 640, 768, 1152, 1536];
/** One full-power weapon-1 bullet, the unit the importer sizes hp in. */
export const SHOT_UNITS = 5120;
/** The importer's boss divisor. Bosses and zako share one unit space and one
 *  divisor: the engine spawns a boss core through the same scaler into the
 *  same hp words as a zako, so this is SHOT_UNITS. It was 20480 (a 4x
 *  discount) while map-to-game.js divided boss hp by shotDamage*1024. */
export const BOSS_UNITS_PER_HIT = SHOT_UNITS;
/** A Saturn px/frame is half a runtime px/frame (the playfield is 2x). */
export const RUNTIME_TO_SATURN_SPEED = 0.5;

export const DEFAULT_SCROLL_BYTE = 0x04; // speed 1.0 px/frame, no wave
export const DEFAULT_BULLET_CONFIG = 0x13; // damage index 3, speed add 1.0 px/f
export const DEFAULT_BLAST_BYTE = 0x33;
export const DEFAULT_LOADOUTS = [[0x11, 0x11], [0x22, 0x11], [0x33, 0x21], [0x44, 0x31]];
export const DEFAULT_SHIP_BLOCK = [0x10, 0x41, 0x21, 0x04];
export const DEFAULT_TITLE_ENTRANCE = [0x05, 0x00, 0x0a, 0x00];
export const DEFAULT_STAFF_ROLES = [12, 0, 0]; // PRESENTED BY

// Enemy bullets are drawn from char slots 55/59/63 (by bullet type 0/1/2), traced in
// GAME.CMP: the shot spawn's setup 0x0607C520 stores that char group into the object
// sprite-index array 0x0608EA90, the renderer resolves it through 0x0608B1FC, and the
// global-art upload 0x06067EEC fills VRAM from these global-bank refs. Per type the four
// animation frames and their cell geometry (w,h in 16px cells): type 0 is four 16x16 at
// refs 104-107, type 1 four 32x32 at 108/112/116/120, type 2 two 32x32 then two 16x16.
// This is where a visible enemy bullet's art MUST live; refs 132-143 (what the decoder
// labels "bullets") are not what the engine draws for shots.
export const BULLET_ENGINE_SLOTS = [
    [{ ref: 104, w: 1, h: 1 }, { ref: 105, w: 1, h: 1 }, { ref: 106, w: 1, h: 1 }, { ref: 107, w: 1, h: 1 }],
    [{ ref: 108, w: 2, h: 2 }, { ref: 112, w: 2, h: 2 }, { ref: 116, w: 2, h: 2 }, { ref: 120, w: 2, h: 2 }],
    [{ ref: 124, w: 2, h: 2 }, { ref: 128, w: 2, h: 2 }, { ref: 132, w: 1, h: 1 }, { ref: 136, w: 1, h: 1 }],
];

// The player's OWN shots draw from a different set of global-bank refs, one per
// equipped weapon (0x0608410C & 7). The MAIN weapon dispatcher GAME 0x060790C4
// hands each weapon handler a hardcoded sprite index (invariant across power
// level) that its shot setup 0x0606F080 writes to the same object sprite-index
// array 0x0608EA90 the enemy path uses; the renderer resolves it through
// 0x0608B1FC to these refs (traced 2026-09-07, FORMAT.md "Player shot sprites").
// Index here = weapon - 1. The slot table (GLOBAL_WEAPON_SLOTS) assigns 57/59/68
// beam/missile roles, so the player's bolt is painted here LAST to own its cell.
export const PLAYER_SHOT_SLOTS = [
    { ref: 53, w: 1, h: 1 }, // weapon 1 (VULCAN A) — the default
    { ref: 54, w: 1, h: 1 }, // weapon 2
    { ref: 55, w: 1, h: 1 }, // weapon 3
    { ref: 57, w: 1, h: 2 }, // weapon 4 (16x32)
    { ref: 59, w: 2, h: 1 }, // weapon 5 (32x16)
    { ref: 61, w: 1, h: 1 }, // weapon 6
    { ref: 68, w: 1, h: 1 }, // weapon 7
];

const GLOBAL_SLOTS = {
    shipBankA: 0,
    shipIdle: 8,
    shipBankB: 16,
    ship2BankA: 24,
    ship2Idle: 32,
    ship2BankB: 40,
    items: 94,
    blastA: 102,
    blastB: 108,
    bullets: 132,
};

// --- small helpers ------------------------------------------------------------

export function decodeFrameKey(key) {
    return String(key).replace(/․/g, ".");
}

function nearestIndex(table, value) {
    let best = 0, bestD = Infinity;
    table.forEach((v, i) => {
        const d = Math.abs(v - value);
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function b64ToBytes(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function hexToBytes(hex, len) {
    const s = String(hex || "").replace(/[^0-9a-f]/gi, "");
    if (s.length !== len * 2) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/**
 * Fit an RGBA frame into a boxW x boxH box: 1:1 and centred when it fits,
 * nearest-neighbour downscale (aspect kept) when it does not.
 */
export function fitRgba(frame, boxW, boxH) {
    const out = new Uint8Array(boxW * boxH * 4);
    const scale = Math.min(1, boxW / frame.w, boxH / frame.h);
    const w = Math.max(1, Math.round(frame.w * scale));
    const h = Math.max(1, Math.round(frame.h * scale));
    const ox = Math.floor((boxW - w) / 2);
    const oy = Math.floor((boxH - h) / 2);
    for (let y = 0; y < h; y++) {
        const sy = scale === 1 ? y : Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < w; x++) {
            const sx = scale === 1 ? x : Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
            const s = (sy * frame.w + sx) * 4;
            const d = ((oy + y) * boxW + ox + x) * 4;
            out[d] = frame.rgba[s];
            out[d + 1] = frame.rgba[s + 1];
            out[d + 2] = frame.rgba[s + 2];
            out[d + 3] = frame.rgba[s + 3];
        }
    }
    return { w: boxW, h: boxH, rgba: out, scaled: scale < 1 };
}

/** The art band for a frame of w x h px: the smallest that holds it, else the largest. */
export function bandFor(w, h) {
    for (let i = 0; i < RECORD_ART.length; i++) {
        const b = RECORD_ART[i];
        if (b.w * CG_CELL >= w && b.h * CG_CELL >= h) return i;
    }
    return RECORD_ART.length - 1;
}

/** Which band a record index belongs to, or -1. */
export function bandOfRecord(record) {
    return RECORD_ART.findIndex((b) => record >= b.first && record < b.first + b.count);
}

/** Boss core class for a frame of w x h px (F0 64x64 x4 ... F3 128x128 x1). */
export function bossClassFor(w, h) {
    if (w <= 64 && h <= 64) return 0;
    if (h <= 64) return 1;
    if (w <= 64) return 2;
    return 3;
}

/** Level column -> placement column (0-19). */
export function mapColumn(col, width) {
    if (width >= PLACEMENT_COLS) return clamp(col, 0, PLACEMENT_COLS - 1);
    if (width <= PLAYFIELD_COLS) {
        if (width <= 1) return PLAYFIELD_FIRST_COL + Math.floor(PLAYFIELD_COLS / 2);
        return PLAYFIELD_FIRST_COL + Math.round((col * (PLAYFIELD_COLS - 1)) / (width - 1));
    }
    return Math.round((col * (PLACEMENT_COLS - 1)) / (width - 1));
}

/** Pick `count` frames spread evenly over `list` (cycling when short). */
export function spreadFrames(list, count) {
    if (!list.length) return [];
    if (list.length === count) return list.slice();
    if (list.length < count) return Array.from({ length: count }, (_, i) => list[i % list.length]);
    return Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]);
}

// --- stages out of a level record ------------------------------------------------

/**
 * The stages of a level record, in stage order: [{key, enemylist, waveRows,
 * waveInterval, items, background, scroll}]. A record saved with `stages`
 * is the whole game; older records carry one stage in the flat fields.
 */
export function levelStages(level) {
    const out = [];
    const stageMap = level.stages && typeof level.stages === "object" ? level.stages : null;
    const keys = stageMap
        ? Object.keys(stageMap).filter((k) => /^stage\d+$/.test(k) && stageMap[k] && Array.isArray(stageMap[k].enemylist))
            .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        : [];
    if (keys.length) {
        for (const k of keys) out.push({ key: k, ...stageMap[k] });
    } else if (Array.isArray(level.enemylist)) {
        out.push({
            key: level.stageKey || "stage0",
            enemylist: level.enemylist,
            waveRows: level.waveRows,
            waveInterval: level.waveInterval,
            items: level.items,
            background: level.background,
            scroll: level.scroll,
        });
    } else {
        for (let s = 0; s < MAX_STAGES; s++) {
            const st = level[`stage${s}`];
            if (st && Array.isArray(st.enemylist)) out.push({ key: `stage${s}`, ...st });
        }
    }
    return out.map((st) => ({
        ...st,
        enemylist: st.enemylist.map((row) => (Array.isArray(row) ? row.map((c) => (typeof c === "string" && c ? c : "00")) : [])),
    }));
}

// --- encoders -----------------------------------------------------------------------

/** One 18-byte enemy record from editor-unit fields. */
export function encodeEnemyRecord({
    appearance = STRAIGHT_APPEARANCE_BASE,
    animIndex = 3,
    scoreIndex = 1,
    ground = false,
    hpIndex = 0,
    armour = false,
    deathMode = 0,
    deathParam = 0,
    bulletType = 0,
    deathPresentation = 1,
    fireRateIndex = 0,
    fireGeometry = 0,
    aimed = true,
} = {}) {
    const b = new Uint8Array(18);
    b[0] = appearance & 0xff;
    b[1] = (animIndex & 7) | ((scoreIndex & 7) << 4) | (ground ? 0x80 : 0);
    b[2] = (hpIndex & 7) | (armour ? 0x10 : 0) | ((deathMode & 3) << 6);
    b[3] = deathParam & 0xff;
    b[4] = (bulletType & 3) | ((deathPresentation & 3) << 2) | ((fireRateIndex & 7) << 4);
    b[5] = (fireGeometry & 0x0f) | (aimed && fireGeometry ? 0x10 : 0);
    return b;
}

/** An enemy record for an authored (non-imported) enemyData entry. */
export function enemyRecordFromEditor(rec, { bulletType = 0, dropSlot = null } = {}) {
    const speed = Number.isFinite(rec.speed) ? rec.speed : 1;
    const hits = rec.hp === "infinity" ? 1 : Math.max(1, Number(rec.hp) || 1);
    const interval = Number(rec.interval);
    const fires = Number.isFinite(interval) && interval > 0;
    return encodeEnemyRecord({
        appearance: STRAIGHT_APPEARANCE_BASE + nearestIndex(STRAIGHT_SPEEDS, speed * RUNTIME_TO_SATURN_SPEED * 256),
        animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex(ANIM_PERIOD_TABLE, 60 / rec.frameRate) : 3,
        scoreIndex: nearestIndex(SCORE_TABLE, Number(rec.score) || 100),
        hpIndex: nearestIndex(HP_TABLE, hits * SHOT_UNITS),
        armour: rec.hp === "infinity",
        deathMode: dropSlot === null ? 0 : 1,
        deathParam: dropSlot === null ? 0 : dropSlot & 7,
        bulletType,
        fireRateIndex: fires ? nearestIndex(FIRE_INTERVAL_TABLE, interval) : 0,
        fireGeometry: fires ? 1 : 0,
        aimed: true,
    });
}

/** The 64-byte boss trailer from a spec (decode-boss.js's shape, or the defaults). */
export function encodeBossTrailer(spec = {}) {
    const t = new Uint8Array(BOSS_TRAILER_SIZE);
    const sizeClass = spec.sizeClass & 3;
    const hpStages = clamp(spec.hpStages || 2, 1, 4);
    t[0] = sizeClass | ((hpStages - 1) << 4) | (spec.rotate ? 0x40 : 0) | (spec.deathSpin ? 0x80 : 0);
    const hpIndex = Number.isInteger(spec.hpIndex)
        ? spec.hpIndex
        : nearestIndex(BOSS_HP_TABLE, Number(spec.hp) || BOSS_HP_TABLE[2]);
    const scoreIndex = Number.isInteger(spec.scoreIndex)
        ? spec.scoreIndex
        : nearestIndex(BOSS_SCORE_TABLE, Number(spec.score) || BOSS_SCORE_TABLE[2]);
    // bit3 is the option flag stored INVERTED by the editor.
    t[1] = (hpIndex & 7) | (spec.optionFlag ? 0 : 0x08) | ((scoreIndex & 7) << 4);
    const playlist = spec.playlist || [[0, 0, 1, 1], [1, 1, 2, 2], [2, 3, 2, 3], [3, 3, 3, 3]];
    for (let k = 0; k < 4; k++) {
        const ids = playlist[k] || playlist[playlist.length - 1] || [0, 0, 0, 0];
        t[2 + k] = (ids[0] & 3) | ((ids[1] & 3) << 2) | ((ids[2] & 3) << 4) | ((ids[3] & 3) << 6);
    }
    t[6] = (spec.arrive || 0) & 0xff;
    t[7] = (spec.death || 0) & 0xff;
    const patterns = spec.patterns || DEFAULT_BOSS_PATTERNS;
    for (let p = 0; p < 4; p++) {
        const pat = patterns[p] || patterns[patterns.length - 1];
        const base = 8 + p * 14;
        t[base] = ((pat.moveScript & 31) << 3) | (pat.moveSpeed & 7);
        t[base + 1] = Number.isInteger(pat.fireTickIndex)
            ? pat.fireTickIndex & 7
            : nearestIndex(BOSS_FIRE_TICK_FRAMES, pat.fireTickFrames || 15);
        for (let i = 0; i < 3; i++) {
            const fp = (pat.firePoints || [])[i] || { dx: 0, dy: 0, type: 0, rate: 0, param: 0 };
            t[base + 2 + i * 4] = fp.dx & 0xff;
            t[base + 3 + i * 4] = fp.dy & 0xff;
            t[base + 4 + i * 4] = ((fp.rate & 7) << 4) | (fp.type & 7);
            t[base + 5 + i * 4] = fp.param & 0xff;
        }
    }
    return t;
}

/** Four patterns a boss with no record of its own fights with. */
export const DEFAULT_BOSS_PATTERNS = [
    { moveScript: 1, moveSpeed: 3, fireTickIndex: 2, firePoints: [{ dx: 0, dy: 24, type: 0, rate: 2, param: 0x11 }] },
    {
        moveScript: 3,
        moveSpeed: 3,
        fireTickIndex: 2,
        firePoints: [{ dx: -24, dy: 16, type: 0, rate: 2, param: 0x13 }, { dx: 24, dy: 16, type: 0, rate: 2, param: 0x13 }],
    },
    { moveScript: 9, moveSpeed: 4, fireTickIndex: 1, firePoints: [{ dx: 0, dy: 0, type: 1, rate: 3, param: 0x1f }] },
    { moveScript: 0, moveSpeed: 3, fireTickIndex: 3, firePoints: [{ dx: 0, dy: 24, type: 0, rate: 4, param: 0x11 }] },
];

/** The 0x60-byte settings block. */
export function encodeSettings({
    gameMode = 0,
    hud = 0,
    stageCount = 1,
    ships = [DEFAULT_SHIP_BLOCK, DEFAULT_SHIP_BLOCK],
    loadouts = DEFAULT_LOADOUTS,
    itemSlots = DEFAULT_ITEM_TYPES.map((t) => (DEFAULT_ITEM_MOVEMENT << 4) | t),
    scoreItemIndex = 1,
    bullets = [DEFAULT_BULLET_CONFIG, DEFAULT_BULLET_CONFIG, DEFAULT_BULLET_CONFIG],
    blast = DEFAULT_BLAST_BYTE,
    titleEntrance = DEFAULT_TITLE_ENTRANCE,
    extents = [],
    bgmTable = new Array(24).fill(0),
    sfxSet = 1,
    staffRoles = DEFAULT_STAFF_ROLES,
    shadow = false,
} = {}) {
    const s = new Uint8Array(SEC5_REGIONS.settings.stride);
    s[0] = gameMode & 3;
    s[1] = hud & 0x77;
    for (let i = 0; i < MAX_STAGES; i++) {
        // bit0 clear = a new numbered stage; bit7 = the final one; bit5 =
        // the drop-shadow pass. Rows past the last stage stay 0.
        if (i < stageCount) s[2 + i] = (i === stageCount - 1 ? 0x80 : 0) | (shadow ? 0x20 : 0);
    }
    s.set(ships[0].slice(0, 4), 0x0c);
    s.set((ships[1] || ships[0]).slice(0, 4), 0x10);
    for (let k = 0; k < 4; k++) {
        const l = loadouts[k] || DEFAULT_LOADOUTS[k];
        s[0x14 + k * 2] = l[0];
        s[0x15 + k * 2] = l[1];
    }
    for (let i = 0; i < 8; i++) s[0x1c + i] = itemSlots[i] ?? 0;
    s[0x24] = scoreItemIndex & 7;
    for (let i = 0; i < 3; i++) s[0x25 + i] = bullets[i] ?? DEFAULT_BULLET_CONFIG;
    s[0x28] = blast;
    for (let i = 0; i < 4; i++) s[0x29 + i] = titleEntrance[i] ?? 0;
    for (let i = 0; i < MAX_STAGES; i++) {
        const [loop, end] = extents[i] || [0, 0x30];
        s[0x2d + i * 2] = loop & 0xff;
        s[0x2e + i * 2] = end & 0xff;
    }
    for (let i = 0; i < 24; i++) s[0x41 + i] = clamp(bgmTable[i] ?? 0, 0, 23);
    s[0x59] = sfxSet;
    for (let i = 0; i < 3; i++) s[0x5a + i] = (staffRoles[i] ?? 0) & 15;
    return s;
}

/** An unused 音まろ song slot: the header and per-measure control bytes every save carries. */
export function emptySong() {
    const song = new Uint8Array(SONG_SIZE);
    song.set([0x00, 0x1f, 0x03, 0x0f], 0);
    for (let m = 0; m < MEASURES; m++) song.set([0x00, 0x00, 0x80, 0x03], 4 + m * MEASURE_SIZE);
    return song;
}

/** sec6 with every slot empty. */
export function emptySongBank() {
    const sec6 = new Uint8Array(SECTION_SIZES[6]);
    const song = emptySong();
    for (let s = 0; s < SONG_SLOTS; s++) sec6.set(song, s * SONG_SIZE);
    return sec6;
}

// --- procedural art -----------------------------------------------------------------

function rgbaFrame(w, h) {
    return { w, h, rgba: new Uint8Array(w * h * 4) };
}

function plot(frame, x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return;
    const o = (y * frame.w + x) * 4;
    frame.rgba[o] = r;
    frame.rgba[o + 1] = g;
    frame.rgba[o + 2] = b;
    frame.rgba[o + 3] = 255;
}

/** A six-frame expanding blast ring, `size` px square. */
export function blastFrames(size, count = 6) {
    const ramp = [[255, 255, 255], [255, 240, 120], [255, 170, 40], [230, 90, 30], [150, 50, 40], [80, 60, 70]];
    const frames = [];
    const c = size / 2 - 0.5;
    for (let f = 0; f < count; f++) {
        const fr = rgbaFrame(size, size);
        const radius = ((f + 1) / count) * (size / 2 - 1);
        const thick = Math.max(1.5, size / 10);
        const [r, g, b] = ramp[Math.min(ramp.length - 1, f)];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const d = Math.hypot(x - c, y - c);
                if (Math.abs(d - radius) <= thick / 2 || (f === 0 && d <= radius)) plot(fr, x, y, r, g, b);
            }
        }
        frames.push(fr);
    }
    return frames;
}

/** A 16x16 icon for an item type (0-3 weapon change, 4 barrier, 5 bomb, 6 score, 7 power, 8 speed). */
export function itemIcon(type) {
    const tints = {
        0: [70, 120, 255], 1: [70, 200, 120], 2: [190, 90, 240], 3: [60, 200, 220],
        4: [120, 200, 255], 5: [255, 140, 40], 6: [255, 220, 60], 7: [255, 70, 70], 8: [90, 230, 90],
    };
    const [r, g, b] = tints[type] || [200, 200, 200];
    const fr = rgbaFrame(16, 16);
    for (let y = 2; y < 14; y++) {
        for (let x = 2; x < 14; x++) {
            const edge = x === 2 || y === 2 || x === 13 || y === 13;
            const corner = (x === 2 || x === 13) && (y === 2 || y === 13);
            if (corner) continue;
            if (edge) plot(fr, x, y, r >> 2, g >> 2, b >> 2);
            else plot(fr, x, y, r, g, b);
        }
    }
    // a light glint so the icon reads as a pickup
    for (let i = 4; i < 8; i++) plot(fr, i, 4, 255, 255, 255);
    plot(fr, 4, 5, 255, 255, 255);
    return fr;
}

/** `frame` turned a quarter turn anticlockwise: its right edge becomes the top. */
export function rotateCcwRgba(frame) {
    const w = frame.h, h = frame.w;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            // destination (x, y) <- source (sx, sy) = (h - 1 - y, x)
            const s = (x * frame.w + (h - 1 - y)) * 4;
            const d = (y * w + x) * 4;
            out[d] = frame.rgba[s];
            out[d + 1] = frame.rgba[s + 1];
            out[d + 2] = frame.rgba[s + 2];
            out[d + 3] = frame.rgba[s + 3];
        }
    }
    return { w, h, rgba: out };
}

/**
 * Fit `frame` into a boxW x boxH box (fitRgba) and paste that box into a
 * slotW x slotH frame at (ox, oy) — art placed inside a bigger bank slot.
 */
export function placeRgba(frame, boxW, boxH, slotW, slotH, ox, oy) {
    const fitted = fitRgba(frame, boxW, boxH);
    const out = new Uint8Array(slotW * slotH * 4);
    for (let y = 0; y < boxH; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= slotH) continue;
        for (let x = 0; x < boxW; x++) {
            const tx = ox + x;
            if (tx < 0 || tx >= slotW) continue;
            const s = (y * boxW + x) * 4;
            const d = (ty * slotW + tx) * 4;
            out[d] = fitted.rgba[s];
            out[d + 1] = fitted.rgba[s + 1];
            out[d + 2] = fitted.rgba[s + 2];
            out[d + 3] = fitted.rgba[s + 3];
        }
    }
    return { w: slotW, h: slotH, rgba: out, scaled: fitted.scaled };
}

// Procedural player-weapon art, for the bank slots a level has no frames
// for. Every one is a bright shape on transparency in the slot's own size.
export const SHOT_TINTS = [[255, 240, 120], [120, 200, 255], [255, 120, 200], [140, 255, 140], [255, 170, 60]];

/** A bolt pointing up: white core, tinted edge, tapering to the nose. */
export function shotSprite(w = 16, h = 16, tint = SHOT_TINTS[0]) {
    const fr = rgbaFrame(w, h);
    const cx = (w - 1) / 2;
    const [r, g, b] = tint;
    for (let y = 1; y < h - 1; y++) {
        const t = (y - 1) / Math.max(1, h - 3);
        const half = Math.max(0.5, (w / 6) * (0.3 + 0.7 * t));
        for (let x = 0; x < w; x++) {
            const d = Math.abs(x - cx);
            if (d > half) continue;
            if (d <= half / 2 && y > 2) plot(fr, x, y, 255, 255, 255);
            else plot(fr, x, y, r, g, b);
        }
    }
    return fr;
}

/** A beam segment along the long axis: tinted bar with a white centre line. */
export function beamSprite(w, h, tint = SHOT_TINTS[1]) {
    const fr = rgbaFrame(w, h);
    const vertical = h >= w;
    const [r, g, b] = tint;
    const span = vertical ? w : h;
    const c = (span - 1) / 2;
    const half = Math.max(1, span / 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const d = Math.abs((vertical ? x : y) - c);
            if (d > half) continue;
            if (d <= half / 2) plot(fr, x, y, 255, 255, 255);
            else plot(fr, x, y, r, g, b);
        }
    }
    return fr;
}

/** A small rocket: grey body, dark nose cone, tinted fins and exhaust. */
export function missileSprite(w = 16, h = 16, tint = SHOT_TINTS[4]) {
    const fr = rgbaFrame(w, h);
    const cx = Math.floor(w / 2) - 1;
    const bodyW = Math.max(2, Math.round(w / 5));
    const nose = Math.max(2, Math.round(h / 5));
    const tail = h - Math.max(2, Math.round(h / 6));
    const [r, g, b] = tint;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            if (y < nose) {
                if (Math.abs(dx - 0.5) <= (bodyW / 2) * (y / nose) + 0.5) plot(fr, x, y, 90, 90, 110);
            } else if (y < tail) {
                if (dx >= -Math.floor(bodyW / 2) && dx <= Math.ceil(bodyW / 2)) plot(fr, x, y, 200, 200, 215);
                // fins on the last body rows
                if (y >= tail - 3 && Math.abs(dx) <= bodyW + 1 && Math.abs(dx) > bodyW / 2) plot(fr, x, y, r, g, b);
            } else if (Math.abs(dx - 0.5) <= 1) {
                plot(fr, x, y, 255, 255, 200);
            }
        }
    }
    return fr;
}

/** A radial glow `size` px square: white heart, tinted halo fading out. */
export function glowSprite(size = 32, tint = SHOT_TINTS[1]) {
    const fr = rgbaFrame(size, size);
    const c = size / 2 - 0.5;
    const [r, g, b] = tint;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - c, y - c) / (size / 2);
            if (d > 0.95) continue;
            if (d < 0.35) plot(fr, x, y, 255, 255, 255);
            else if (d < 0.7) plot(fr, x, y, r, g, b);
            else if (((x + y) & 1) === 0) plot(fr, x, y, r >> 1, g >> 1, b >> 1);
        }
    }
    return fr;
}

/** An arc filling the top of a w x h slot — a bomb dome. */
export function domeSprite(w = 32, h = 16, tint = SHOT_TINTS[1]) {
    const fr = rgbaFrame(w, h);
    const cx = (w - 1) / 2;
    const [r, g, b] = tint;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const nx = (x - cx) / (w / 2), ny = (h - 1 - y) / h;
            const d = Math.hypot(nx, ny);
            if (d > 1) continue;
            if (d > 0.8) plot(fr, x, y, 255, 255, 255);
            else if (d > 0.6) plot(fr, x, y, r, g, b);
            else if (((x + y) & 1) === 0) plot(fr, x, y, r >> 1, g >> 1, b >> 1);
        }
    }
    return fr;
}

/** A soft grey puff — missile smoke. */
export function puffSprite(size = 16) {
    const fr = rgbaFrame(size, size);
    const c = size / 2 - 0.5;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - c, y - c) / (size / 2);
            if (d < 0.45) plot(fr, x, y, 200, 200, 200);
            else if (d < 0.8 && ((x + y) & 1) === 0) plot(fr, x, y, 140, 140, 150);
        }
    }
    return fr;
}

// --- the assembler -----------------------------------------------------------------

/**
 * Build the eight raw sections of a save from a level record and its art.
 *
 * `art` maps atlas frame names (Firebase-encoded or not) to {w, h, rgba}.
 * Options: `palette` ("saturn" | "snes"), `gameMode` (settings +0x00),
 * `title1` / `title2` ({w, h, rgba} logos for the drawn title screen),
 * `useBackground` (pack imported scenery; default true).
 *
 * With no `title1`/`title2` the title screen is taken from the level's own
 * `dezaemonTitle` (role -> atlas frame name) and `dezaemonTitleScreen.layout`,
 * which is what lets a cart imported from a .sav keep its title and credits
 * when it is written back out.
 *
 * Returns {sections, bank, warnings, report}.
 */
export function buildSaveFromGame(level, art, options = {}) {
    const opts = { palette: "saturn", gameMode: 0, title1: null, title2: null, itemEmblems: null, storyPanels: null, useBackground: true, ...options };
    const warnings = [];
    const warn = (m) => warnings.push(m);

    const artMap = new Map();
    for (const [k, v] of Object.entries(art || {})) {
        if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
    }
    const lookup = (name) => (name ? artMap.get(decodeFrameKey(name)) || null : null);

    let stages = levelStages(level);
    if (!stages.length) throw new Error("the level has no stage with an enemylist");
    if (stages.length > MAX_STAGES) {
        warn(`level has ${stages.length} stages; a save holds ${MAX_STAGES} — dropped the rest`);
        stages = stages.slice(0, MAX_STAGES);
    }
    const enemyData = level.enemyData || {};
    const bossData = level.bossData || {};

    // Item slots: an import's own table, else the defaults.
    const importedSlots = level.dezaemonItems && Array.isArray(level.dezaemonItems.slots) && level.dezaemonItems.slots.length === 8
        ? level.dezaemonItems.slots
        : null;
    const itemSlotBytes = importedSlots
        ? importedSlots.map((s) => (Number.isInteger(s.raw) ? s.raw : ((s.movement & 3) << 4) | (s.type & 15)))
        : DEFAULT_ITEM_TYPES.map((t) => (DEFAULT_ITEM_MOVEMENT << 4) | t);
    const dropToSlot = (drop) => {
        if (!drop) return null;
        if (importedSlots) {
            const i = importedSlots.findIndex((s) => ITEM_TYPE_DROPS[s.type & 15] === drop);
            return i >= 0 ? i : null;
        }
        return DROP_TO_SLOT[drop] ?? null;
    };

    // --- the frame plan: every RGBA the save needs, fitted to its box ---
    const plan = new Map(); // planKey -> {key, w, h, rgba, group, priority}
    const planFrame = (planKey, frame, boxW, boxH, group, priority) => {
        if (!plan.has(planKey)) {
            const fitted = fitRgba(frame, boxW, boxH);
            plan.set(planKey, { key: planKey, w: boxW, h: boxH, rgba: fitted.rgba, group, priority, scaled: fitted.scaled });
        }
        return planKey;
    };

    // Player ship: the level's own frames, else Duke (who ships with the engine).
    let shipSource = "level";
    let shipFrames = ((level.playerData && level.playerData.texture) || []).map(lookup).filter(Boolean);
    if (!shipFrames.length) {
        shipSource = "duke";
        const duke = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key));
        shipFrames = duke.slice(0, 2);
    }
    const shipIdle = spreadFrames(shipFrames, 2).map((f, i) => planFrame(`ship:${i}:${f.key}`, f, 32, 32, "player", 0));
    // The second ship (refs 24-47) only for a 2P join-in game: its own
    // frames when the level carries them, else P1's. Painting it in a 1P
    // save would make a re-import read the game as 2P.
    const ship2Frames = ((level.playerData2 && level.playerData2.texture) || []).map(lookup).filter(Boolean);
    const ship2Idle = (opts.gameMode & 2)
        ? (ship2Frames.length
            ? spreadFrames(ship2Frames, 2).map((f, i) => planFrame(`ship2:${i}:${f.key}`, f, 32, 32, "player2", 0))
            : shipIdle)
        : [];

    // Global bullet types: the first three distinct projectile textures.
    const bulletTypes = []; // [{first, frames: planKeys}]
    const bulletTypeOf = new Map(); // enemy key -> type index
    const usedLetters = new Set();
    for (const st of stages) for (const row of st.enemylist) for (const c of row) if (c !== "00") usedLetters.add(c.slice(0, -1));
    for (const letter of usedLetters) {
        const rec = enemyData[`enemy${letter}`];
        const tex = rec && rec.projectileData && Array.isArray(rec.projectileData.texture) ? rec.projectileData.texture : null;
        if (!tex || !tex.length) continue;
        let t = bulletTypes.findIndex((b) => b.first === tex[0]);
        if (t < 0 && bulletTypes.length < 3) {
            const frames = spreadFrames(tex.map(lookup).filter(Boolean), 4);
            if (!frames.length) continue;
            t = bulletTypes.length;
            bulletTypes.push({
                first: tex[0],
                speed: Number(rec.projectileData.speed) || 1,
                src: frames,
                frames: frames.map((f, i) => planFrame(`bullet:${t}:${i}:${f.key}`, f, 16, 16, `bullet${t}`, 1)),
                // The same projectile, fitted to each engine char-slot frame's geometry, so
                // the bullet the hardware actually draws (char slots 55/59/63) shows it.
                engine: BULLET_ENGINE_SLOTS[t].map((slot, i) =>
                    planFrame(`bulletE:${t}:${i}:${frames[i % frames.length].key}`, frames[i % frames.length], slot.w * CG_CELL, slot.h * CG_CELL, `bulletE${t}`, 1)),
            });
        }
        if (t >= 0) bulletTypeOf.set(letter, t);
    }

    // Per stage: placements, records, boss, items, scenery.
    const built = stages.map((st, s) => {
        const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : (level.width || 8));
        const spawnRows = st.enemylist.slice().reverse();
        const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length
            ? st.waveRows.slice().reverse()
            : null;
        const placements = [];
        const usage = new Map(); // letter -> {count, drops: Map}
        let lastRow = FIRST_SPAWN_ROW;
        spawnRows.forEach((row, k) => {
            const scrollRow = waveRows
                ? clamp(Math.round(waveRows[k]), 0, PLACEMENT_ROWS - 1)
                : Math.min(MAX_SPAWN_ROW, FIRST_SPAWN_ROW + k * ROW_STEP);
            row.forEach((cell, c) => {
                if (!cell || cell === "00") return;
                const letter = cell.slice(0, -1);
                const drop = Number(cell.slice(-1)) || 0;
                placements.push({ row: scrollRow, col: mapColumn(c, width), letter, drop });
                if (!usage.has(letter)) usage.set(letter, { count: 0, drops: new Map() });
                const u = usage.get(letter);
                u.count++;
                if (drop) u.drops.set(drop, (u.drops.get(drop) || 0) + 1);
                lastRow = Math.max(lastRow, scrollRow);
            });
        });

        // Records: most-placed enemies first, each in the smallest band that
        // holds its art, an import's own slot when it is free.
        const taken = new Set();
        const records = new Map(); // letter -> {index, band, frames, bytes}
        const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) {
                warn(`${st.key}: grid names enemy${letter} but enemyData has no such record — cells left empty`);
                continue;
            }
            const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas — placed invisible`);
            const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
            const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
            let band = bandFor(maxW, maxH);
            if (frames.length && (maxW > 64 || maxH > 64)) {
                warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; zako art tops out at 64x64 — downscaled`);
            }
            let index = -1;
            const preferred = rec.dezaemon && Number.isInteger(rec.dezaemon.record) ? rec.dezaemon.record : -1;
            for (let b = band; b < RECORD_ART.length && index < 0; b++) {
                const def = RECORD_ART[b];
                if (preferred >= def.first && preferred < def.first + def.count && !taken.has(preferred)) {
                    index = preferred;
                } else {
                    for (let i = def.first; i < def.first + def.count; i++) {
                        if (!taken.has(i)) { index = i; break; }
                    }
                }
                if (index >= 0) band = b;
            }
            if (index < 0) {
                warn(`${st.key}: no free enemy record for enemy${letter} — a stage holds 60 — cells left empty`);
                continue;
            }
            taken.add(index);
            const def = RECORD_ART[band];
            const bw = def.w * CG_CELL, bh = def.h * CG_CELL;
            const chosen = spreadFrames(frames, def.frames);
            const planKeys = chosen.map((f) => planFrame(`e:${f.key}:${bw}x${bh}`, f, bw, bh, frameGroup(f.key), 2));
            // The record's drop: the most common non-zero digit on its cells.
            let drop = 0, dropN = 0;
            for (const [d, n] of usage.get(letter).drops) if (n > dropN) { drop = d; dropN = n; }
            if (usage.get(letter).drops.size > 1) {
                warn(`${st.key}: enemy${letter} carries several drop digits; a Dezaemon record has one — kept ${drop}`);
            }
            let bytes = rec.dezaemon ? hexToBytes(rec.dezaemon.attributes, 18) : null;
            if (!bytes) {
                bytes = enemyRecordFromEditor(rec, { bulletType: bulletTypeOf.get(letter) || 0, dropSlot: dropToSlot(drop) });
            }
            records.set(letter, { index, band, frames: planKeys, bytes, name: rec.name || `enemy${letter}` });
        }

        // The story panel: a stage's opening picture and its words, placed as
        // objects the stage opens on. A .sav has no words for a cutscene, but
        // it has enemies and a scroll, so the story becomes something that
        // hangs in the playfield and descends through it.
        //
        // The geometry is the runtime's: a Dezaemon cart spawns a placement
        // at `gridLeft + col * 16 + 16` across and `-(row * 16 + 8)` down, so
        // a cell is 16 px each way and a 64 px tile is four of them. An
        // imported grid is PLACEMENT_COLS wide, which puts column c at
        // x = c * 16 - 16; columns 7 and 11 therefore centre a 128-wide
        // picture on the 256-wide playfield, and 3/7/11/15 lay a 256-wide
        // strip across it. Rows count UP the screen, so the top half of the
        // picture takes the HIGHER row.
        const panel = opts.storyPanels
            ? opts.storyPanels.find((p) => p.stage === s)
            : null;
        if (panel) {
            // A piece never fires and never drops. Its hit points are the
            // reading time: a player holding the fire button puts five
            // full-power shots into a quarter in well under a second, which
            // tore the picture up before it could be read, so this is the
            // table's 102,400 — about twenty — and the panel still comes
            // apart for anyone who wants to shoot it.
            const storyBytes = encodeEnemyRecord({
                appearance: STRAIGHT_APPEARANCE_BASE,
                animIndex: 3,
                scoreIndex: 1,
                hpIndex: 4,
                deathMode: 0,
                fireGeometry: 0,
                aimed: false,
            });
            const place = (tiles, band, cols, colBase, rowBase, what) => {
                const def = RECORD_ART[band];
                const stepCol = def.w, stepRow = def.h;
                const rows = Math.max(1, Math.ceil(tiles.length / cols));
                // All of a picture or none of it: half a panel reads as a bug,
                // where none at all just reads as a stage without a story.
                const free = [];
                for (let i = def.first; i < def.first + def.count; i++) {
                    if (!taken.has(i)) free.push(i);
                }
                if (free.length < tiles.length) {
                    warn(
                        `${st.key}: the story ${what} needs ${tiles.length} ${def.w * CG_CELL}x${def.h * CG_CELL} records and the stage has ${free.length} free — panel dropped`,
                    );
                    return;
                }
                for (const tile of tiles) {
                    const index = free.shift();
                    taken.add(index);
                    const key = `story:${s}:${what}:${tile.col},${tile.row}`;
                    const frame = { key, w: tile.w, h: tile.h, rgba: tile.rgba };
                    const planKeys = Array.from(
                        { length: def.frames },
                        (_, f) => planFrame(`${key}:${f}`, frame, def.w * CG_CELL, def.h * CG_CELL, "story", 2),
                    );
                    const letter = `\x00${key}`;
                    records.set(letter, { index, band, frames: planKeys, bytes: storyBytes, name: key });
                    placements.push({
                        row: rowBase + (rows - 1 - tile.row) * stepRow,
                        col: colBase + tile.col * stepCol,
                        letter,
                        drop: 0,
                    });
                }
            };
            // Everything the stage already spawns moves down, so the opening
            // belongs to the story rather than to the first wave.
            for (const p of placements) {
                p.row = Math.min(PLACEMENT_ROWS - 1, p.row + STORY_QUIET_ROWS);
            }
            lastRow = Math.min(PLACEMENT_ROWS - 1, lastRow + STORY_QUIET_ROWS);
            // Text lowest, then the picture stacked above it (see the table
            // in the panel builder): rows 8, 12 and 16 put the block between
            // y 184 and y 360 of a 480-tall screen at stage start.
            if (panel.text && panel.text.length) {
                place(panel.text, STORY_TEXT_BAND, panel.text.length, 3, FIRST_SPAWN_ROW, "text");
            }
            if (panel.picture && panel.picture.length) {
                place(panel.picture, STORY_PICTURE_BAND, 2, 7, FIRST_SPAWN_ROW + 4, "picture");
            }
            lastRow = Math.max(lastRow, FIRST_SPAWN_ROW + 16);
        }

        // The boss: this stage's bossData entry, if any.
        let boss = null;
        const bossRec = bossData[`boss${s}`] || (s === 0 && !bossData.boss0 ? null : null);
        if (bossRec) {
            const names = bossRec.anim && Array.isArray(bossRec.anim.idle)
                ? [...bossRec.anim.idle, ...(Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : [])]
                : Array.isArray(bossRec.texture) ? bossRec.texture : [];
            const frames = names.map(lookup).filter(Boolean);
            const dz = bossRec.dezaemon || {};
            const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
            const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
            const sizeClass = Number.isInteger(dz.sizeClass) ? dz.sizeClass & 3 : bossClassFor(maxW, maxH);
            const geom = BOSS_CORE_GEOM[sizeClass];
            const bw = geom.w * CG_CELL, bh = geom.h * CG_CELL;
            if (frames.length && (maxW > bw || maxH > bh)) {
                warn(`${st.key}: boss (${bossRec.name || "?"}) is ${maxW}x${maxH}; class F${sizeClass} art is ${bw}x${bh} — downscaled`);
            }
            if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas — its core is unpainted`);
            const chosen = spreadFrames(frames, geom.frames);
            const planKeys = chosen.map((f) => planFrame(`boss:${f.key}:${bw}x${bh}`, f, bw, bh, `boss${s}`, 2));
            const row = Number.isInteger(dz.row) ? clamp(dz.row, 0, PLACEMENT_ROWS - 1) : Math.min(PLACEMENT_ROWS - 8, lastRow + BOSS_ROW_GAP);
            const col = Number.isInteger(dz.col) ? clamp(dz.col, 0, PLACEMENT_COLS - 1) : BOSS_COL;
            const decoded = dz.boss || null;
            const trailer = encodeBossTrailer(decoded
                ? {
                    sizeClass,
                    hpStages: decoded.hpStages,
                    rotate: decoded.rotate,
                    deathSpin: decoded.deathSpin,
                    hp: decoded.hp,
                    score: decoded.score,
                    optionFlag: decoded.optionFlag,
                    playlist: decoded.playlist,
                    arrive: decoded.arrive,
                    death: decoded.death,
                    patterns: (decoded.patterns || []).map((p) => ({
                        moveScript: p.moveScript,
                        moveSpeed: p.moveSpeed,
                        fireTickFrames: p.fireTickFrames,
                        firePoints: (p.firePoints || []).map((fp) => ({ dx: fp.dx, dy: fp.dy, type: fp.type, rate: fp.rate, param: fp.param })),
                    })),
                }
                : {
                    sizeClass,
                    hpStages: 2,
                    hp: (Math.max(1, Number(bossRec.hp) || 100)) * BOSS_UNITS_PER_HIT,
                    score: Number(bossRec.score) || BOSS_SCORE_TABLE[2],
                    optionFlag: false,
                });
            boss = { sizeClass, row, col, frames: planKeys, trailer, name: bossRec.name || `boss${s}` };
            lastRow = Math.max(lastRow, row);
        }

        // Stand-alone item pickups (an import's `items`).
        const items = [];
        for (const it of Array.isArray(st.items) ? st.items : []) {
            if (!Number.isInteger(it.row) || !Number.isInteger(it.col)) continue;
            items.push({ row: clamp(it.row, 0, PLACEMENT_ROWS - 1), col: mapColumn(it.col, PLACEMENT_COLS), slot: (it.slot ?? 0) & 7 });
        }

        // Scenery: the stage's tile grid over the level's shared cell list.
        let background = null;
        const cells = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
        if (opts.useBackground && st.background && st.background.tiles && cells) {
            try {
                const bytes = b64ToBytes(st.background.tiles);
                const cols = st.background.cols || BG_COLS;
                const words = new Uint16Array(bytes.length >> 1);
                for (let i = 0; i < words.length; i++) words[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
                const planKeys = new Map(); // ordinal -> planKey
                for (const w of words) {
                    if (w === 0xffff) continue;
                    const ordinal = w & 0x3ff;
                    if (planKeys.has(ordinal)) continue;
                    const frame = lookup(cells[ordinal]);
                    if (!frame) { planKeys.set(ordinal, null); continue; }
                    planKeys.set(ordinal, planFrame(`bg:${frame.key}`, frame, 16, 16, "background", 5));
                }
                background = { cols, words, planKeys };
            } catch (e) {
                warn(`${st.key}: could not read the background grid (${e.message}) — scenery skipped`);
            }
        }

        // Scroll: the import's curve and extents, else a steady 1 px/frame.
        let curve = null;
        let extent = null;
        if (st.scroll && typeof st.scroll === "object") {
            if (st.scroll.curve) {
                try {
                    const c = b64ToBytes(st.scroll.curve);
                    if (c.length === SEC5_REGIONS.scrollCurves.stride) curve = c;
                } catch (_e) { /* fall through to the default curve */ }
            }
            if (Number.isInteger(st.scroll.loopPart) && Number.isInteger(st.scroll.endPart)) {
                extent = [st.scroll.loopPart, st.scroll.endPart];
            }
        }
        if (!extent) {
            const end = clamp(Math.ceil((lastRow + 32) / 16 / 2) * 2, 2, 48);
            extent = [Math.max(0, end - 4), end];
        }
        return { key: st.key, placements, records, boss, items, background, curve, extent, lastRow };
    });

    // Item icons and blasts (procedural), and the drawn title screen.
    //
    // An item slot draws the emblem the caller supplied for its type when
    // there is one (lib/powerup-emblems.ts cuts those out of the powerup
    // GIFs) and the procedural coloured square otherwise, so a caller with no
    // art beside it exports exactly what it always did.
    const itemKeys = itemSlotBytes.map((b, i) => {
        const type = b & 15;
        const supplied = opts.itemEmblems ? opts.itemEmblems[type] : null;
        const frame = supplied && supplied.rgba && supplied.w > 0 && supplied.h > 0
            ? supplied
            : itemIcon(type);
        return planFrame(`item:${i}:${type}`, frame, 16, 16, "items", 3);
    });
    const blastAKeys = blastFrames(16).map((f, i) => planFrame(`blastA:${i}`, f, 16, 16, "blast", 3));
    const blastBKeys = blastFrames(32).map((f, i) => planFrame(`blastB:${i}`, f, 32, 32, "blast", 3));
    // THE DRAWN TITLE SCREEN.
    //
    // Two sources, in this order:
    //
    //   1. `opts.title1` / `opts.title2` — an image the author put in the
    //      TITLE EDITOR (or a cloud level's logoDataURL / subTitleDataURL).
    //   2. `level.dezaemonTitle` — the title a save this game was IMPORTED
    //      from already had, as atlas frame names ("dezaTitle1.gif") that
    //      `art` carries the pixels for.
    //
    // (2) is why a cart survives the round trip. Without it, a Dezaemon save
    // opened in the editor and written back out came away with an empty title
    // page — the author never uploaded a logo, so both options were null — and
    // the runtime, finding no `dezaemonTitle` when it read that cart back,
    // fell through to 2028-AI's own logo and title background. The game showed
    // the base game's title screen instead of its own.
    //
    // The credit strips (refs 208-231, six 64x16 lines under the logo) come
    // from the same place and were never written at all, so KUMITATE's credits
    // vanished on the first re-export too. `dezaemonTitleScreen.layout` records
    // where each trimmed piece sat inside its slot, so the art goes back where
    // its author put it rather than centred.
    const titleLayout = (level.dezaemonTitleScreen && level.dezaemonTitleScreen.layout) || {};
    const drawnTitle = (role) => lookup(level.dezaemonTitle && level.dezaemonTitle[role]);
    // The two title logos share one anchor on the Saturn — both 128x64 slots
    // are drawn at 2x centred on (160,80) — so a level with both gets the
    // logo in the top 48 rows of its slot and the subtitle in the bottom 16,
    // stacked the way the runtime's title scene shows them, instead of the
    // two landing centred on top of each other. Art that comes back from a
    // cart keeps its recorded placement instead, which is that stacking as its
    // author actually drew it.
    const titleW = TITLE_SLOTS.title1.w * CG_CELL, titleH = TITLE_SLOTS.title1.h * CG_CELL;
    const subtitleH = CG_CELL;
    const uploaded1 = opts.title1 && opts.title1.rgba ? opts.title1 : null;
    const uploaded2 = opts.title2 && opts.title2.rgba ? opts.title2 : null;
    const title1Art = uploaded1 || drawnTitle("title1");
    const title2Art = uploaded2 || drawnTitle("title2");
    const hasTitle1 = !!title1Art;
    const hasTitle2 = !!title2Art;
    // Trimmed art with a recorded home goes back at those coordinates; an
    // uploaded image (no placement to honour) keeps the stacking rule above.
    const placed = (art, role, box) => {
        const at = !uploaded1 && !uploaded2 ? titleLayout[role] : null;
        if (at && Number.isInteger(at.x) && Number.isInteger(at.y)) {
            return placeRgba(art, Math.min(art.w, titleW), Math.min(art.h, titleH), titleW, titleH, at.x, at.y);
        }
        return box ? placeRgba(art, titleW, box.h, titleW, titleH, 0, box.y) : art;
    };
    const title1Key = hasTitle1
        ? planFrame(
            "title1",
            placed(title1Art, "title1", hasTitle2 ? { h: titleH - subtitleH, y: 0 } : null),
            titleW,
            titleH,
            "title1",
            4,
        )
        : null;
    const title2Key = hasTitle2
        ? planFrame(
            "title2",
            placed(title2Art, "title2", hasTitle1 ? { h: subtitleH, y: titleH - subtitleH } : null),
            titleW,
            titleH,
            "title2",
            4,
        )
        : null;
    // The six credit strips, each 4x1 cells. Only the ones the game actually
    // carries: an unpainted slot must stay unpainted or a re-import reads six
    // blank lines as credits.
    const stripW = TITLE_SLOTS.credits[0].w * CG_CELL, stripH = TITLE_SLOTS.credits[0].h * CG_CELL;
    const creditKeys = TITLE_SLOTS.credits.map((_slot, i) => {
        const art = drawnTitle(`credit${i}`);
        if (!art) return null;
        const at = titleLayout.credits && titleLayout.credits[i];
        const frame = at && Number.isInteger(at.x) && Number.isInteger(at.y)
            ? placeRgba(art, Math.min(art.w, stripW), Math.min(art.h, stripH), stripW, stripH, at.x, at.y)
            : art;
        // Their own group, and the same lowest priority as the logos: on a cart
        // dense enough to fill the 1024 CG cells these are what the packer gives
        // up first, and the warning should name them rather than the title.
        return planFrame(`credit${i}`, frame, stripW, stripH, "credits", 4);
    });

    // The player's weapon art (refs 48-93, GLOBAL_WEAPON_SLOTS): the level's
    // own projectile frames where it has them — shootNormal / shoot3way /
    // shootBig, the runtime's three shot modes — cycled over the shot-sized
    // slots; procedural bolts, beams, missiles, glow, dome and smoke
    // otherwise. Option pods are the ship shrunk to one cell, bombs reuse
    // the blast rings. The engine draws every player shot out of these cells,
    // so an empty slot is an invisible weapon.
    const pd = level.playerData || {};
    const shotFrames = [];
    const seenShots = new Set();
    for (const mode of ["shootNormal", "shoot3way", "shootBig"]) {
        const tex = pd[mode] && Array.isArray(pd[mode].texture) ? pd[mode].texture : [];
        for (const f of tex.map(lookup).filter(Boolean)) {
            if (seenShots.has(f.key)) continue;
            seenShots.add(f.key);
            // The runtime's shots are drawn travelling to the right and
            // rotated in flight; the Saturn fires them straight up, so a
            // sideways bolt is stood on end.
            shotFrames.push(f.w > f.h ? { ...rotateCcwRgba(f), key: f.key } : f);
        }
    }
    let shotN = 0, bombN = 0, sparkN = 0;
    const weaponKeys = GLOBAL_WEAPON_SLOTS.map((slot, i) => {
        const w = slot.w * CG_CELL, h = slot.h * CG_CELL;
        const tint = SHOT_TINTS[i % SHOT_TINTS.length];
        switch (slot.role) {
            case "shot": {
                const f = shotFrames.length ? shotFrames[shotN++ % shotFrames.length] : null;
                return f
                    ? planFrame(`weapon:${f.key}:${w}x${h}`, f, w, h, "weapon", 3)
                    : planFrame(`weapon:shot:${i}`, shotSprite(w, h, tint), w, h, "weapon", 3);
            }
            case "missile":
            case "missileTall":
                return planFrame(`weapon:missile:${w}x${h}`, missileSprite(w, h), w, h, "weapon", 3);
            case "beamV":
            case "beamH":
                return planFrame(`weapon:beam:${w}x${h}`, beamSprite(w, h), w, h, "weapon", 3);
            case "charge":
                return planFrame("weapon:charge", glowSprite(w), w, h, "weapon", 3);
            case "dome":
                return planFrame("weapon:dome", domeSprite(w, h), w, h, "weapon", 3);
            case "smoke":
                return planFrame("weapon:smoke", puffSprite(w), w, h, "weapon", 3);
            case "option":
                return planFrame(`weapon:option:${shipFrames[0].key}`, shipFrames[0], w, h, "player", 3);
            case "bomb":
                return blastBKeys[bombN++ % 2 ? 4 : 2];
            case "spark":
                return blastAKeys[sparkN++ % 2 ? 2 : 0];
            default:
                return null;
        }
    });

    // The player's own shot, planned for the exact refs the weapon dispatcher
    // reads (PLAYER_SHOT_SLOTS = 53/54/55/57/59/61/68 for weapons 1-7). Weapon 1
    // — the weapon the player starts with — takes the primary bolt; the rest
    // cycle any further shot frames the level supplies, falling back to a
    // procedural bolt so no weapon fires an empty cell.
    const playerShotKeys = PLAYER_SHOT_SLOTS.map((slot, i) => {
        const w = slot.w * CG_CELL, h = slot.h * CG_CELL;
        const f = shotFrames.length ? shotFrames[i % shotFrames.length] : null;
        const tint = SHOT_TINTS[i % SHOT_TINTS.length];
        return f
            ? planFrame(`pshot:${i}:${f.key}:${w}x${h}`, f, w, h, "weapon", 3)
            : planFrame(`pshot:${i}:${w}x${h}`, shotSprite(w, h, tint), w, h, "weapon", 3);
    });

    // --- reduce to the palette target, pack the cells ---
    const planned = [...plan.values()];
    const q = quantizeFrames(planned, opts.palette);
    const indexedByKey = new Map(q.frames.map((f) => [f.key, f]));
    const packer = new CgPacker();
    const refsByKey = new Map();
    const fullWarned = new Set();
    for (const f of planned.slice().sort((a, b) => a.priority - b.priority)) {
        const idx = indexedByKey.get(f.key);
        try {
            refsByKey.set(f.key, packer.addFrame(idx.indexed, f.w, f.h));
        } catch (e) {
            if (!(e instanceof CgFullError)) throw e;
            if (!fullWarned.has(f.group)) {
                fullWarned.add(f.group);
                warn(`CG pages full (1024 cells): ${f.group} art left unpainted`);
            }
            refsByKey.set(f.key, null);
        }
    }
    const refsOf = (key, count) => {
        const r = key ? refsByKey.get(key) : null;
        return r || new Uint16Array(count).fill(EMPTY_REF);
    };
    /** True when a planned frame really got cells — the CG pages can fill up. */
    const painted = (key) => !!(key && refsByKey.get(key));

    // --- sec5 ---
    const sec5 = new Uint8Array(SECTION_SIZES[5]);
    const putWord = (at, w) => { sec5[at] = w >> 8; sec5[at + 1] = w & 0xff; };
    // Empty tiles and empty composition refs are 0xFFFF words.
    sec5.fill(0xff, SEC5_REGIONS.stageBanks.offset, SEC5_REGIONS.stageBanks.offset + SEC5_REGIONS.stageBanks.count * SEC5_REGIONS.stageBanks.stride);
    sec5.fill(0xff, SEC5_REGIONS.spriteBank.offset, SEC5_REGIONS.spriteStages.offset + SEC5_REGIONS.spriteStages.count * SEC5_REGIONS.spriteStages.stride);
    sec5.fill(DEFAULT_SCROLL_BYTE, SEC5_REGIONS.scrollCurves.offset, SEC5_REGIONS.scrollCurves.offset + SEC5_REGIONS.scrollCurves.count * SEC5_REGIONS.scrollCurves.stride);

    const extents = [];
    built.forEach((b, s) => {
        const placeBase = SEC5_REGIONS.placement.offset + s * SEC5_REGIONS.placement.stride;
        for (const p of b.placements) {
            const rec = b.records.get(p.letter);
            if (!rec) continue;
            sec5[placeBase + p.row * PLACEMENT_COLS + p.col] = zakoPlacementId(rec.index);
        }
        for (const it of b.items) {
            const at = placeBase + it.row * PLACEMENT_COLS + it.col;
            if (!sec5[at]) sec5[at] = 0xe8 | it.slot;
        }
        const enemyBase = SEC5_REGIONS.enemies.offset + s * SEC5_REGIONS.enemies.stride;
        const bankBase = SEC5_REGIONS.spriteStages.offset + s * SEC5_REGIONS.spriteStages.stride;
        for (const rec of b.records.values()) {
            sec5.set(rec.bytes, enemyBase + rec.index * 18);
            const def = RECORD_ART[rec.band];
            const cellsPerFrame = def.w * def.h;
            const slot = bankBase + def.base + (rec.index - def.first) * def.frames * cellsPerFrame * 2;
            rec.frames.forEach((key, f) => {
                const refs = refsOf(key, cellsPerFrame);
                for (let c = 0; c < cellsPerFrame; c++) putWord(slot + (f * cellsPerFrame + c) * 2, refs[c]);
            });
        }
        if (b.boss) {
            sec5[placeBase + b.boss.row * PLACEMENT_COLS + b.boss.col] = 0xf0 | b.boss.sizeClass;
            sec5.set(b.boss.trailer, enemyBase + BOSS_TRAILER_OFFSET);
            const geom = BOSS_CORE_GEOM[b.boss.sizeClass];
            const cellsPerFrame = geom.w * geom.h;
            const order = coreCellOrder(geom.w, geom.h);
            b.boss.frames.forEach((key, f) => {
                const refs = refsOf(key, cellsPerFrame);
                for (let c = 0; c < cellsPerFrame; c++) {
                    putWord(bankBase + BOSS_CORE_OFFSET + (f * cellsPerFrame + order[c]) * 2, refs[c]);
                }
            });
        }
        if (b.curve) sec5.set(b.curve, SEC5_REGIONS.scrollCurves.offset + s * SEC5_REGIONS.scrollCurves.stride);
        extents.push(b.extent);
        if (b.background) {
            const bgBase = SEC5_REGIONS.stageBanks.offset + s * SEC5_REGIONS.stageBanks.stride;
            const cols = b.background.cols;
            const rows = Math.min(BG_ROWS, Math.floor(b.background.words.length / cols));
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < Math.min(cols, BG_COLS); c++) {
                    const w = b.background.words[r * cols + c];
                    if (w === 0xffff) continue;
                    const key = b.background.planKeys.get(w & 0x3ff);
                    const refs = key ? refsByKey.get(key) : null;
                    if (!refs || refs[0] === EMPTY_REF) continue;
                    // runtime word: bit15 = h-flip, bit14 = v-flip; the save
                    // stores bit14 = H, bit15 = V.
                    const h = (w & 0x8000) !== 0, v = (w & 0x4000) !== 0;
                    let ref = refs[0];
                    if (h) ref ^= REF_HFLIP;
                    if (v) ref ^= REF_VFLIP;
                    putWord(bgBase + (r * BG_COLS + c) * 2, ref);
                }
            }
        }
    });

    // The global bank: ship (three poses, all the idle pair), items, blasts,
    // bullets, title logos.
    const gb = SEC5_REGIONS.spriteBank.offset;
    const putRefs = (slot, refs) => refs.forEach((r, i) => putWord(gb + (slot + i) * 2, r));
    for (const pose of [GLOBAL_SLOTS.shipBankA, GLOBAL_SLOTS.shipIdle, GLOBAL_SLOTS.shipBankB]) {
        shipIdle.forEach((key, f) => putRefs(pose + f * 4, refsOf(key, 4)));
    }
    itemKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.items + i, refsOf(key, 1)));
    blastAKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.blastA + i, refsOf(key, 1)));
    blastBKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.blastB + i * 4, refsOf(key, 4)));
    bulletTypes.forEach((b, t) => b.frames.forEach((key, f) => putRefs(GLOBAL_SLOTS.bullets + t * 4 + f, refsOf(key, 1))));
    // The refs the engine's shot renderer actually reads (char slots 55/59/63), painted
    // LAST so they own their cells over the procedural blast anim that shares this region.
    bulletTypes.forEach((b, t) => {
        if (!b.engine) return;
        BULLET_ENGINE_SLOTS[t].forEach((slot, f) => putRefs(slot.ref, refsOf(b.engine[f], slot.w * slot.h)));
    });
    weaponKeys.forEach((key, i) => {
        const slot = GLOBAL_WEAPON_SLOTS[i];
        putRefs(slot.first, refsOf(key, slot.w * slot.h));
    });
    // The player's shot at the refs the weapon dispatcher actually reads,
    // painted LAST so it owns 57/59/68 over the beam/missile role art and
    // re-affirms 53/54/55/61 with the primary bolt (the same "own the cell
    // last" trick BULLET_ENGINE_SLOTS uses for enemy bullets above).
    playerShotKeys.forEach((key, i) => {
        const slot = PLAYER_SHOT_SLOTS[i];
        putRefs(slot.ref, refsOf(key, slot.w * slot.h));
    });
    for (const pose of [GLOBAL_SLOTS.ship2BankA, GLOBAL_SLOTS.ship2Idle, GLOBAL_SLOTS.ship2BankB]) {
        ship2Idle.forEach((key, f) => putRefs(pose + f * 4, refsOf(key, 4)));
    }
    if (title1Key) putRefs(TITLE_SLOTS.title1.first, refsOf(title1Key, 32));
    if (title2Key) putRefs(TITLE_SLOTS.title2.first, refsOf(title2Key, 32));
    creditKeys.forEach((key, i) => {
        if (!key) return;
        const slot = TITLE_SLOTS.credits[i];
        putRefs(slot.first, refsOf(key, slot.w * slot.h));
    });

    // Settings.
    const bgm = level.dezaemonBgm && typeof level.dezaemonBgm === "object" ? level.dezaemonBgm : null;
    const bgmTable = new Array(24).fill(0);
    if (bgm) {
        (bgm.special || []).slice(0, 4).forEach((v, i) => { bgmTable[i] = v; });
        (bgm.stages || []).slice(0, 10).forEach((pair, s) => {
            if (Array.isArray(pair)) { bgmTable[4 + s * 2] = pair[0] ?? 0; bgmTable[5 + s * 2] = pair[1] ?? 0; }
        });
    }
    const bulletBytes = [0, 1, 2].map((t) => {
        const cfg = level.dezaemonBullets && level.dezaemonBullets.configs && level.dezaemonBullets.configs[t];
        if (cfg && Number.isInteger(cfg.raw)) return cfg.raw;
        const b = bulletTypes[t];
        if (!b) return DEFAULT_BULLET_CONFIG;
        // speed add index over [0.5, 1, 2, 3.5] px/frame
        const add = nearestIndex([0.5, 1, 2, 3.5], b.speed * RUNTIME_TO_SATURN_SPEED);
        return 3 | (add << 4);
    });
    const ts = level.dezaemonTitleScreen || {};
    const entrance = ts.entrance && ts.entrance.title2 && ts.entrance.title1
        ? [...(ts.entrance.title2.raw || [0, 0]), ...(ts.entrance.title1.raw || [0, 0])]
        : DEFAULT_TITLE_ENTRANCE;
    const settings = encodeSettings({
        gameMode: opts.gameMode,
        stageCount: built.length,
        itemSlots: itemSlotBytes,
        bullets: bulletBytes,
        titleEntrance: entrance,
        extents,
        bgmTable,
        sfxSet: bgm && Number.isInteger(bgm.sfxSet) ? bgm.sfxSet : 1,
        staffRoles: Array.isArray(ts.staffRoles) && ts.staffRoles.length === 3 ? ts.staffRoles : DEFAULT_STAFF_ROLES,
    });
    sec5.set(settings, SEC5_REGIONS.settings.offset);

    // --- sec6: the level's soundtrack, or silence ---
    const sec6 = emptySongBank();
    if (bgm && bgm.songs && typeof bgm.songs === "object") {
        for (const [idx, b64] of Object.entries(bgm.songs)) {
            const slot = Number(idx);
            if (!Number.isInteger(slot) || slot < 0 || slot >= SONG_SLOTS) continue;
            try {
                const bytes = b64ToBytes(b64);
                if (bytes.length === SONG_SIZE) sec6.set(bytes, slot * SONG_SIZE);
                else warn(`song slot ${slot} is ${bytes.length} bytes, not ${SONG_SIZE} — skipped`);
            } catch (e) {
                warn(`song slot ${slot} could not be read (${e.message})`);
            }
        }
    }

    const sections = [
        ...packer.pages,
        bankToSec4(q.bank),
        sec5,
        sec6,
        new Uint8Array(SECTION_SIZES[7]),
    ];
    return {
        sections,
        bank: q.bank,
        warnings,
        report: {
            palette: q.report,
            stages: built.map((b) => ({
                key: b.key,
                placements: b.placements.length,
                records: [...b.records.values()].map((r) => ({ name: r.name, record: r.index, band: r.band })),
                boss: b.boss ? { name: b.boss.name, sizeClass: b.boss.sizeClass, row: b.boss.row, col: b.boss.col } : null,
                items: b.items.length,
                background: !!b.background,
                extent: b.extent,
            })),
            ship: shipSource,
            player2: ship2Idle.length > 0,
            bulletTypes: bulletTypes.length,
            weaponArt: { slots: weaponKeys.filter(Boolean).length, levelShotFrames: shotFrames.length },
            frames: planned.length,
            cells: packer.used,
            sharedCells: packer.shared,
            title: {
                // What actually landed on the cart, not what was planned: on a
                // save dense enough to fill the CG pages the packer drops these
                // last and says so, and the report must agree with the bytes.
                title1: painted(title1Key),
                title2: painted(title2Key),
                credits: creditKeys.filter(painted).length,
                // Where the art came from, so a caller can say whether the cart
                // kept its own title screen or wears an uploaded one.
                source: (uploaded1 || uploaded2)
                    ? "uploaded"
                    : (painted(title1Key) || painted(title2Key) ? "cart" : "none"),
            },
        },
    };
}
