// Dezaemon 2 boss record decode.
//
// The 0x40 trailer after each stage's 60 enemy records IS the boss record —
// traced from GAME.CMP's boss routines (spawn init +0x1AC20, pattern
// activation +0x1A878, HP-stage advance +0x1ABD4, per-frame dispatcher
// +0x1BDCC; engine base 0x06064000) and confirmed against the KUMITATE boss
// editor's field writers. Layout:
//
//   byte 0   bits0-1 core size class (F0-F3), bits4-5 HP-stage count - 1,
//            bit6 rotate-in-place, bit7 death-FX spin variant
//   byte 1   bits0-2 HP index, bit3 option flag (stored inverted),
//            bits4-6 score index
//   bytes 2-5  the pattern playlist: byte 2+k = HP stage k's loop of four
//            2-bit pattern ids, consumed LSB-first. HP stages split the HP
//            bar into equal bands; a band change advances to the next byte.
//            (The editor's "16-entry phase loop" = 4 bytes x 4 entries.)
//   bytes 6/7  arrival / death behavior nibble-pairs (velocity presets and
//            scroll-stop position selectors); carried raw
//   bytes 8+   4 pattern records x 14 bytes:
//            +0 bits3-7 movement script 0-31, bits0-2 speed 0-7
//            +1 bits0-2 fire-tick divider (frames per fire tick)
//            +2+i*4 (i=0..2) fire point i: [dx.s8, dy.s8, rate<<4|type, param]
//
// Fire point types: 0-2 = bullet weapon A/B/C (param bits0-3 shot function,
// bit4 aimed at player, bits5-7 extra arg); 3 = respawning mobile part;
// 4 = one-shot static part/turret; 5-6 = special attacks (beam / flame).
// Types 3/4 spawn a destructible object at (bossX + dx, bossY + dy) whose
// art is param: bits4-6 sprite group, bits0-3 piece —
//   group 0-3 = the zako banks (16x16 / 32x16 / 16x32 / 32x32),
//   group 4-6 = the large banks (64x32 / 32x64 / 64x64, i.e. records 48-59).
//
// Environment-neutral ESM (Node + browser).

import { SEC5_REGIONS } from "./decode-stage.js";
import { RECORD_ART } from "./decode-sprites.js";

export const BOSS_TRAILER_OFFSET = 0x438; // after the 60 x 18-byte records
export const BOSS_TRAILER_SIZE = 0x40;

// Engine value tables (GAME.bin literal pools).
export const BOSS_HP_TABLE = [1024000, 1536000, 2304000, 3328000, 4608000, 6144000, 7936000, 9984000];
export const BOSS_SCORE_TABLE = [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
export const BOSS_FIRE_TICK_FRAMES = [60, 30, 15, 10, 5, 3, 2, 1];
export const PART_GROUPS = ["zako16x16", "zako32x16", "zako16x32", "zako32x32", "part64x32", "part32x64", "part64x64"];

const s8 = (b) => (b >= 128 ? b - 256 : b);

// A part's (group, piece) names a zako/large enemy record: the group IS the
// art band index (RECORD_ART) and the piece its slot within the band. The
// piece field is 4 bits but the small bands hold 8 or 4 records, so overflow
// wraps — the editor never writes past the band size.
export function partRecord(group, piece) {
    const band = RECORD_ART[group];
    if (!band) return null;
    return band.first + (piece % band.count);
}

// Decode one fire point's 4 bytes.
function decodeFirePoint(f) {
    const type = f[2] & 7;
    const fp = {
        dx: s8(f[0]),
        dy: s8(f[1]),
        type,
        rate: (f[2] >> 4) & 7,
        param: f[3],
    };
    if (type === 3 || type === 4) {
        const group = (f[3] >> 4) & 7;
        fp.spawn = {
            group: PART_GROUPS[group],
            piece: f[3] & 15,
            record: partRecord(group, f[3] & 15),
            oneShot: type === 4,
        };
    } else if (type <= 2) {
        fp.shot = {
            weapon: type, // A/B/C
            fn: f[3] & 15,
            aimed: (f[3] & 0x10) !== 0,
            arg: f[3] >> 5,
        };
    }
    return fp;
}

// Boss entrance / death position presets (GAME.CMP +0x25264..+0x2529C),
// in pixels of the engine's 320x224 coordinate space. "lateral" is the
// 20-column axis (screen X in a vertical game, 160 = centre, playfield
// 48..272) and "scroll" the axis the stage scrolls along (screen Y; the
// boss parks at 56). Entries beyond those ranges are deliberately
// off-screen — that is where the boss flies in from, or drifts away to.
export const BOSS_ARRIVE_LATERAL = [160, -16, 160, 336];
export const BOSS_ARRIVE_SCROLL = [56, 280, 56, -56];
export const BOSS_DEATH_LATERAL = [160, 336, 160, -16];
export const BOSS_DEATH_SCROLL = [56, -56, 56, 280];
// Per size-class nudge applied to the entry's scroll coordinate.
const BOSS_CLASS_NUDGE = [0, 0, 32, 32];
export const BOSS_PARK_LATERAL = BOSS_ARRIVE_LATERAL[0];
export const BOSS_PARK_SCROLL = BOSS_ARRIVE_SCROLL[0];

// The low nibble of both bytes is the same FX pair: bit0 enables the ZOOM
// (the scale register 0x06094A40, neutral 0x1000) with bit1 choosing its
// direction, and bit2 the SPIN (the rotation register 0x06094440) with bit3
// choosing its direction. Both entrance flourishes run exactly 256 frames —
// the same length as the entry glide, by design: the zoom rides 4.0x -> 1.0x
// at -48/frame or 0.0x -> 1.0x at +16/frame, and the spin turns eight full
// revolutions with its rate ramping 22.5 deg/frame down to nothing, landing
// upright. On death the scale rate is CONSTANT (+24 grow / -16 shrink) while
// the spin rate ACCELERATES by 16/frame and never settles.
export const BOSS_FX_FRAMES = 256;

function fxSpec(b) {
    return {
        zoom: (b & 1) !== 0,
        zoomFromLarge: (b & 2) === 0, // clear = start at 4.0x, set = start at 0
        spin: (b & 4) !== 0,
        spinReverse: (b & 8) !== 0,
    };
}

function arriveSpec(b, sizeClass) {
    // The scroll preset is consulted when either bit4 or bit6 is set; with
    // neither, the boss uses the DEFAULT ENTRY — it starts just off the top
    // and rides in at the scroll speed.
    const usesScroll = (b & 0x50) !== 0;
    const nudge = BOSS_CLASS_NUDGE[sizeClass & 3];
    return {
        lateral: (b & 0x40) ? BOSS_ARRIVE_LATERAL[(b >> 6) & 3] : BOSS_PARK_LATERAL,
        scroll: (usesScroll ? BOSS_ARRIVE_SCROLL[(b >> 4) & 3] : -56) +
            ((b & 0x10) ? nudge : -nudge),
        defaultEntry: !usesScroll,
        ...fxSpec(b),
    };
}

function deathSpec(b, fadeOut) {
    return {
        // With neither gate bit set the boss dies where it stands.
        lateral: (b & 0x40) ? BOSS_DEATH_LATERAL[(b >> 6) & 3] : null,
        scroll: (b & 0x10) ? BOSS_DEATH_SCROLL[(b >> 4) & 3] : null,
        ...fxSpec(b),
        // record byte0 bit7: a 159-frame hold then a 64-frame level ramp to
        // nothing — the boss fades out rather than gaining a second spin.
        fadeOut,
    };
}

// Decode the 64-byte boss trailer. Returns null for an all-zero trailer
// (a stage that never had its boss edited).
export function decodeBossTrailer(t) {
    if (!t || t.length < BOSS_TRAILER_SIZE) return null;
    let any = false;
    for (let i = 0; i < BOSS_TRAILER_SIZE; i++) if (t[i]) { any = true; break; }
    if (!any) return null;
    const patterns = [];
    for (let p = 0; p < 4; p++) {
        const r = t.subarray ? t.subarray(8 + p * 14, 8 + p * 14 + 14) : t.slice(8 + p * 14, 8 + p * 14 + 14);
        patterns.push({
            moveScript: r[0] >> 3,
            moveSpeed: r[0] & 7,
            fireTickFrames: BOSS_FIRE_TICK_FRAMES[r[1] & 7],
            firePoints: [0, 1, 2].map((i) => decodeFirePoint(r.subarray
                ? r.subarray(2 + i * 4, 6 + i * 4)
                : r.slice(2 + i * 4, 6 + i * 4))),
        });
    }
    return {
        sizeClass: t[0] & 3,
        hpStages: ((t[0] >> 4) & 3) + 1,
        rotate: (t[0] & 0x40) !== 0,
        deathSpin: (t[0] & 0x80) !== 0,
        hp: BOSS_HP_TABLE[t[1] & 7],
        score: BOSS_SCORE_TABLE[(t[1] >> 4) & 7],
        optionFlag: ((t[1] >> 3) & 1) === 0, // stored inverted by the editor
        // per HP stage, the loop of four pattern ids (LSB-first)
        playlist: [t[2], t[3], t[4], t[5]].map((b) =>
            [b & 3, (b >> 2) & 3, (b >> 4) & 3, (b >> 6) & 3]),
        arrive: t[6],
        death: t[7],
        // Byte 6 / byte 7 decoded (2026-08-28): the off-screen start point
        // and the death-drift target, each picked out of two 4-entry
        // position preset tables, plus the spin/zoom flourishes.
        arrival: arriveSpec(t[6], t[0] & 3),
        dying: deathSpec(t[7], (t[0] & 0x80) !== 0),
        patterns,
    };
}

// Read stage `stage`'s boss trailer out of sec5.
export function readBossTrailer(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.enemies;
    const base = offset + stage * stride + BOSS_TRAILER_OFFSET;
    return decodeBossTrailer(sec5.subarray(base, base + BOSS_TRAILER_SIZE));
}
