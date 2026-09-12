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
// A part is not a bespoke object: the fire-point spawner +0x18FAC hands the
// resolved record index to the SAME initialiser +0x153C8 that grid-placed
// zako go through, so score, the death word, the hit attributes and the fire
// configuration all come from that 18-byte record (see "Boss parts" in
// FORMAT.md). HP is where the two types part company — and the RATE nibble
// means something different on each arm:
//
//   type 3  hp = the record's own zako hp (0x06085F20[b2 & 7]); the rate
//           nibble is a RESPAWN PERIOD, indexing 0x06085F80 (or 0x06085F90
//           when the boss core is size class F0).
//   type 4  hp is OVERWRITTEN right after the shared spawn (+0x1916E..
//           +0x19190) from the BOSS table 0x06085F40 at the rate nibble,
//           shifted >>2. The record's hp field is not read at all, and the
//           rate nibble is never consumed as a period because the executor
//           skips the countdown for type 4.
//
// Environment-neutral ESM (Node + browser).

import { ENEMY_RECORD_SIZE, SEC5_REGIONS } from "./decode-stage.js";
import { decodeEnemyRecord } from "./decode-enemy.js";
import { RECORD_ART } from "./decode-sprites.js";

export const BOSS_TRAILER_OFFSET = 0x438; // after the 60 x 18-byte records
export const BOSS_TRAILER_SIZE = 0x40;

// Engine value tables (GAME.bin literal pools).
export const BOSS_HP_TABLE = [1024000, 1536000, 2304000, 3328000, 4608000, 6144000, 7936000, 9984000];
export const BOSS_SCORE_TABLE = [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
export const BOSS_FIRE_TICK_FRAMES = [60, 30, 15, 10, 5, 3, 2, 1];
export const PART_GROUPS = ["zako16x16", "zako32x16", "zako16x32", "zako32x32", "part64x32", "part32x64", "part64x64"];

// Type-3 respawn period in frames, indexed by the fire point's rate nibble.
// The engine keeps two tables (0x06085F80 / 0x06085F90) and picks the second
// only when the boss core's size class is F0. The part respawns on this fixed
// cadence with no check that the previous one is still alive.
export const PART_RESPAWN_FRAMES = [119, 59, 29, 19, 9, 5, 3, 1];
export const PART_RESPAWN_FRAMES_F0 = [119, 59, 39, 19, 11, 7, 3, 1];

const s8 = (b) => (b >= 128 ? b - 256 : b);

// The engine's band-base table 0x0608603C — the same seven bytes the
// death-word mode-2 successor spawn uses.
const RECORD_BAND_BASE = RECORD_ART.map((band) => band.first);

// A part's (group, piece) names a zako/large enemy record: the group IS the
// art band index (RECORD_ART) and the piece its slot within the band.
//
// The engine ORs the piece in UNMASKED (`or r4,r5` in each of the seven
// per-band constructors), so a piece past the band's size runs on into the
// next band rather than wrapping: group 1 piece 8 is record 24, not 16. This
// used to be modelled as `first + piece % count`, which differs on exactly 2
// of the 10,895 part references in the 268-game corpus — both in one author's
// game — but the engine's arithmetic is the one to reproduce.
export function partRecord(group, piece) {
    const base = RECORD_BAND_BASE[group];
    if (base === undefined) return null;
    return base | piece;
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
            // Where this part's hp comes from. A turret's is decided here,
            // by the rate nibble off the BOSS table; a mobile part's needs
            // the record, so it is filled in by readBossTrailer.
            hpSource: type === 4 ? "boss" : "record",
        };
        if (type === 4) fp.spawn.hp = BOSS_HP_TABLE[fp.rate] >> 2;
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
    // The type-3 respawn period needs the core's size class, which is only
    // known once the whole trailer is read.
    const respawn = (t[0] & 3) === 0 ? PART_RESPAWN_FRAMES_F0 : PART_RESPAWN_FRAMES;
    for (const pattern of patterns) {
        for (const fp of pattern.firePoints) {
            if (fp.type === 3 && fp.spawn) fp.spawn.respawnFrames = respawn[fp.rate];
        }
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

// The 60 zako records that precede the trailer in a stage's enemy block.
const RECORDS_PER_STAGE = BOSS_TRAILER_OFFSET / ENEMY_RECORD_SIZE;

// Fill in what each type-3/4 part inherits from the 18-byte record its
// (group, piece) names — the record the shared spawn +0x153C8 builds it from.
//
// Score and the armour attribute come off that record for BOTH types; hp only
// for type 3, since a type-4 turret's is overwritten from the boss table
// before the object ever runs a frame.
//
// The part record is usually NOT in the editor roster — 91% of the corpus's
// part references name a record the stage never places — so this reads sec5
// directly rather than going through the projected enemy list, exactly as
// `extractBossPartSprites` does for part art.
function resolvePartRecords(sec5, stage, boss) {
    const { offset, stride } = SEC5_REGIONS.enemies;
    const recordBase = offset + stage * stride;
    const cache = new Map();
    const readRecord = (record) => {
        if (!Number.isInteger(record) || record < 0 || record >= RECORDS_PER_STAGE) return null;
        if (!cache.has(record)) {
            const at = recordBase + record * ENEMY_RECORD_SIZE;
            cache.set(record, decodeEnemyRecord(sec5.subarray(at, at + ENEMY_RECORD_SIZE)));
        }
        return cache.get(record);
    };
    for (const pattern of boss.patterns) {
        for (const fp of pattern.firePoints) {
            const spawn = fp.spawn;
            if (!spawn) continue;
            const rec = readRecord(spawn.record);
            if (!rec) continue;
            spawn.score = rec.score;
            // Hit attributes are set by the shared spawn and never overridden
            // on either arm, so an armoured part is indestructible whatever
            // its hp word says.
            spawn.armour = (rec.move.mode & 1) !== 0;
            if (spawn.hpSource === "record") spawn.hp = rec.hp;
        }
    }
}

// Read stage `stage`'s boss trailer out of sec5.
export function readBossTrailer(sec5, stage) {
    const { offset, stride } = SEC5_REGIONS.enemies;
    const base = offset + stage * stride + BOSS_TRAILER_OFFSET;
    const boss = decodeBossTrailer(sec5.subarray(base, base + BOSS_TRAILER_SIZE));
    if (boss) resolvePartRecords(sec5, stage, boss);
    return boss;
}
