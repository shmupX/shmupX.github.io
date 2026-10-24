// Dezaemon 3D project records: typed codecs for what is INSIDE the files of
// a project — the enemy entries, the layout, the map, the layout effects, the
// models, the songs and the global settings — each an encode (object ->
// bytes, every field defaulted, every range checked by name) and a decode
// (bytes -> object) that round-trip.
//
// The record layouts are those of "file formats.txt" in the 2024 English
// translation of Dezaemon 3D (Zoinkity / whowasphone404), which its author
// marks "not complete". Everything is big-endian: the N64 is, and the only
// little-endian field that document names (key###.bin's size) is not a
// project record. Confidence, field by field:
//
//   CONFIRMED  the record sizes and where the regions start. Every size here
//              reproduces the file sizes in directory.js DOCUMENTED_SIZES
//              (the single source of those, imported, never restated), and
//              the cartridge's own initial save — the blank SRAM the
//              translation ships for its fileserver — decompresses bank by
//              bank to exactly GAM 0x559, CBL 0x9B4, CMD 0x7968 (the
//              cartridge variant), stage BL 0x8FC2 (the cartridge variant),
//              MUS 8 x 0x2C9A and DEZA3D.SYS 0x290. The things read off that
//              save and relied on here: the three layout layers each end in
//              an entry whose enemy number is -1 and the rest zero; the
//              tail's first-enemy indices count those terminators (a stage
//              with 120 map enemies has first-A 121 and first-B 123, and one
//              whose map layer is empty has first-A 1); a map entry that is
//              not set carries texture 150; the sample models' texturing
//              bytes use only the documented bits; the 46-entry sprite
//              position tables of GAM run 0x16C..0x1C8 and 0x1C8..0x224; a
//              blank song is 0x1A header bytes, then 32 score blocks each
//              headed FF 00 01 00 (accompaniment off) over zero pitches,
//              then 32 accompaniment blocks whose three drum lines carry
//              instrument 0x32 and the rest zero.
//   LIKELY     the meaning of every named field: it is the document's, and
//              the document is a reverse-engineering record, not Athena's.
//              Three places this file departs from it, each marked where it
//              happens: the sprite ypos table ends at 0x224 so the vibration
//              bytes are taken to start there, not 0x223; shot 2 and shot 3's
//              type bytes (0x25, 0x26) are packed like shot 1's (0x24), since
//              the sample stages put 0x20, 0x80, 0xA0 and 0x81 in them; the
//              player's initial altitude admits 9 and 10, since the
//              cartridge's own default is 9. Undocumented bits of each
//              packed byte are kept under an `unknownBits` field so that a
//              real file re-encodes byte for byte (the sample stages set bits
//              0x04 and 0x08 of the rotation byte 0x1B and bit 0x08 of the
//              shot setting bytes 0x27..0x29, which the document does not
//              name; bit 0x10 of the shot type bytes 0x24..0x26 is carried
//              the same way, under `unknownBits24`).
//   OPEN       the units of a face's UV pairs (the sample models run to 321 x
//              291 over 64 x 32 textures) and of a tile's offset; the tile
//              index base (the sample models' textured faces name tiles 1..9
//              and leave tile 0 at the editor's blank); the 0x8B2F..0x8B37
//              words of a disk-mode BL, which the cartridge variant lacks;
//              and whether any of this runs on hardware — no record this
//              writes has been put in front of the game.
//
// The defaults are the cartridge's where it has one (GAM is the initial game
// the cartridge writes, a blank song is its blank song, a blank model slot is
// its zeros) and the document's "initialized to" notes otherwise; an enemy
// entry's defaults are a plain enemy — every effect off, no shots, no item,
// SE off at volume 3 — chosen, not measured: the cartridge has no single
// blank entry (each sample stage duplicates a different template), and the
// values its stages use most differ field by field.
//
// Environment-neutral ESM (Node + browser).

import { DOCUMENTED_SIZES } from "./directory.js";
import { TILE_BYTES } from "./graphics.js";

// --- the small tools every record is built from ---------------------------------

/** Throw unless `v` is an integer in min..max; the message names the field. */
function check(name, v, min, max) {
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (!Number.isInteger(v) || v < min || v > max) {
        throw new Error(`${name} is ${v}; it must be an integer ${min}..${max}`);
    }
    return v;
}

const s8 = (b, at) => (b[at] << 24) >> 24;
const u16 = (b, at) => (b[at] << 8) | b[at + 1];
const s16 = (b, at) => (u16(b, at) << 16) >> 16;
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const s32 = (b, at) => u32(b, at) | 0;

function putU8(b, at, name, v) {
    b[at] = check(name, v, 0, 0xff);
}
function putS8(b, at, name, v) {
    b[at] = check(name, v, -0x80, 0x7f) & 0xff;
}
function putU16(b, at, name, v) {
    check(name, v, 0, 0xffff);
    b[at] = v >> 8;
    b[at + 1] = v & 0xff;
}
function putS16(b, at, name, v) {
    check(name, v, -0x8000, 0x7fff);
    b[at] = (v >> 8) & 0xff;
    b[at + 1] = v & 0xff;
}
function putU32(b, at, name, v) {
    check(name, v, 0, 0xffffffff);
    b[at] = (v >>> 24) & 0xff;
    b[at + 1] = (v >>> 16) & 0xff;
    b[at + 2] = (v >>> 8) & 0xff;
    b[at + 3] = v & 0xff;
}
function putS32(b, at, name, v) {
    check(name, v, -0x80000000, 0x7fffffff);
    putU32(b, at, name, v >>> 0);
}

/**
 * An index byte in the document's convention: an enemy, SE or model number,
 * or "-1 if disabled". 0xFF reads as -1; anything else is the number.
 */
function putIndex(b, at, name, v) {
    b[at] = check(name, v, -1, 0xfe) & 0xff;
}
const getIndex = (b, at) => (b[at] === 0xff ? -1 : b[at]);

function shiftOf(mask) {
    let s = 0;
    while (!((mask >> s) & 1)) s++;
    return s;
}

/**
 * Packed bit fields: [{name, mask, bool?, max?}]. pack() range-checks each
 * field against its width (or `max`, the document's smaller range) and names
 * it; unpack() returns {name: value}, booleans where the field is a flag.
 */
function pack(label, fields, values) {
    let out = 0;
    for (const f of fields) {
        const shift = shiftOf(f.mask);
        const v = check(`${label}.${f.name}`, values[f.name], 0, f.max ?? (f.mask >> shift));
        out |= v << shift;
    }
    return out >>> 0;
}
function unpack(fields, word) {
    const out = {};
    for (const f of fields) {
        const v = (word & f.mask) >>> shiftOf(f.mask);
        out[f.name] = f.bool ? v !== 0 : v;
    }
    return out;
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);

/**
 * `given` over `defaults`, field by field. A missing or null field takes its
 * default; a field the defaults do not have throws, so a misspelt one is
 * caught rather than dropped. An array default of fixed length (models[4],
 * tracks[4]) merges by index and refuses more entries than it holds; an
 * empty array default is a list the caller fills; a Uint8Array default is a
 * raw block that must be given at exactly its length.
 */
function merge(label, defaults, given) {
    if (given === undefined || given === null) return defaults;
    if (ArrayBuffer.isView(defaults)) {
        if (!ArrayBuffer.isView(given) && !Array.isArray(given)) throw new Error(`${label} is ${defaults.length} raw bytes`);
        if (given.length !== defaults.length) throw new Error(`${label} is ${defaults.length} raw bytes; ${given.length} were given`);
        return Uint8Array.from(given);
    }
    if (Array.isArray(defaults)) {
        if (!Array.isArray(given)) throw new Error(`${label} is a list`);
        if (defaults.length === 0) return given;
        if (given.length > defaults.length) throw new Error(`${label} holds ${defaults.length} entries; ${given.length} were given`);
        return defaults.map((d, i) => merge(`${label}[${i}]`, d, given[i]));
    }
    if (isPlain(defaults)) {
        if (!isPlain(given)) throw new Error(`${label} is an object`);
        for (const k of Object.keys(given)) {
            if (!(k in defaults)) throw new Error(`${label}.${k} is not a field of ${label}`);
        }
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = merge(`${label}.${k}`, defaults[k], given[k]);
        return out;
    }
    return given;
}

const fill = (n, v) => Array.from({ length: n }, () => (typeof v === "function" ? v() : v));

function needBytes(label, bytes, at, n) {
    if (!(bytes instanceof Uint8Array)) throw new Error(`${label}: bytes are a Uint8Array`);
    if (at + n > bytes.length) throw new Error(`${label}: ${n} bytes at 0x${at.toString(16)} run past the end of ${bytes.length}`);
}

function isZero(bytes, at, n) {
    for (let i = at; i < at + n; i++) if (bytes[i] !== 0) return false;
    return true;
}

// --- the 0x5C enemy entry (#BL, CBL) ------------------------------------------------

/** Bytes in one enemy entry. */
export const ENEMY_ENTRY_BYTES = 0x5c;

/** The score byte's table: 0..0xF -> points. The document prints 0xD as 1,000,000; read here as the 100,000 step between its neighbours. (likely) */
export const ENEMY_SCORE_TABLE = Object.freeze([
    0, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000, 100000, 500000, 1000000,
]);

const ENEMY_FLAGS = [
    { name: "rotationDisabled", mask: 0x80, bool: true },
    { name: "scalingDisabled", mask: 0x40, bool: true },
    { name: "transparencyDisabled", mask: 0x20, bool: true },
    { name: "unknownBits", mask: 0x1f },
];
const ALTITUDE_SETTINGS = [
    { name: "rate", mask: 0x03, max: 2 },
    { name: "loopType", mask: 0xe0, max: 4 },
    { name: "unknownBits", mask: 0x1c },
];
const ROTATION_1B = [
    { name: "clockwise", mask: 0x80, bool: true },
    { name: "axis", mask: 0x03, max: 2 },
    { name: "unknownBits1B", mask: 0x7c },
];
const ROTATION_1C = [
    { name: "look", mask: 0xc0 },
    { name: "loopType", mask: 0x03 },
    { name: "unknownBits1C", mask: 0x3c },
];
const SHOT_TYPE = [
    { name: "type", mask: 0xc0 },
    { name: "direction", mask: 0x20 },
    { name: "variant", mask: 0x0f },
    { name: "unknownBits24", mask: 0x10 }, // not `unknownBits`: the settings byte's is spread into the same object
];
const SHOT_SETTINGS = [
    { name: "speed", mask: 0xe0 },
    { name: "aimAtPlayer", mask: 0x10, bool: true },
    { name: "timing", mask: 0x07 },
    { name: "unknownBits", mask: 0x08 },
];
const HIT_SETTINGS = [
    { name: "lockOn", mask: 0x80, bool: true },
    { name: "stageClear", mask: 0x40, bool: true },
    { name: "hpMode", mask: 0x03 },
    { name: "unknownBits", mask: 0x3c },
];
const BLAST_SETTINGS = [
    { name: "pattern", mask: 0x30 },
    { name: "type", mask: 0x08 },
    { name: "particle", mask: 0x04, bool: true },
    { name: "scale", mask: 0x03 },
    { name: "unknownBits", mask: 0xc0 },
];
const flagged = (max) => [
    { name: "enabled", mask: 0x80, bool: true },
    { name: "value", mask: 0x7f, max },
];
const ITEM_FLAGGED = flagged(6);
const DEATH_FLAGGED = flagged(7);

function shotDefaults() {
    return {
        type: 0,
        direction: 0,
        variant: 0,
        speed: 0,
        aimAtPlayer: false,
        timing: 0,
        unknownBits: 0,
        unknownBits24: 0,
        launchedEnemy: 0,
        x: 0,
        y: 0,
        z: 0,
        se: -1,
        seVolume: 3,
    };
}

/**
 * A plain enemy: animation off ("initialized to -1", so the byte is 0xFF),
 * every effect disabled, scale 100, no shots, no item, SE off at volume 3.
 * The field names follow the document's rows; `unknownNN` is the byte at
 * that offset carried raw, `unknownBits` the bits of a packed byte it does
 * not name.
 */
export function enemyEntryDefaults() {
    return {
        score: 0,
        hp: 0,
        animation: { disabled: true, frameSpeed: 0x7f, models: [0xff, 0xff, 0xff, 0xff] },
        flags: { rotationDisabled: true, scalingDisabled: true, transparencyDisabled: true, unknownBits: 0 },
        altitude: { cue: 0, initial: 0, final: 0, speed: 0, rate: 0, loopType: 0, unknownBits: 0 },
        unknown11: 0,
        scale: 100,
        scaling: { cue: 0, initial: 3, final: 3, speed: 3, loopType: 1 },
        rotation: {
            cue: 0,
            start: 0,
            end: 0,
            speed: 0,
            clockwise: false,
            axis: 1,
            look: 0,
            loopType: 0,
            unknownBits1B: 0,
            unknownBits1C: 0,
        },
        motion: {
            birth: 0,
            in: 0,
            type: 0,
            orbit1: 0,
            orbit2: 0,
            orbit3: 0,
            speed1: 0,
            speed2: 0,
            speed3: 0,
            death: 7,
            deathEnabled: false,
        },
        shots: [shotDefaults(), shotDefaults(), shotDefaults()],
        unknown2D: 0,
        hit: { lockOn: false, stageClear: false, hpMode: 0, size: 0, x: 0, y: 0, z: 0, unknownBits: 0 },
        blast: { pattern: 0, type: 0, particle: false, scale: 1, se: -1, seVolume: 3, unknownBits: 0 },
        item: { enabled: false, value: 0 },
        enemySet: -1,
        enemyRise: -1,
        unknown47: 0,
        transparency: { cue: 0, initial: 0, final: 0, speed: 0, loopType: 1 },
        unknown5B: 0,
    };
}

/**
 * One enemy entry -> 0x5C bytes.
 * @param {object} [entry]  any subset of enemyEntryDefaults()
 * @param {string} [label]  what an error calls the record
 * @returns {Uint8Array}
 */
export function encodeEnemyEntry(entry = {}, label = "enemy") {
    const e = merge(label, enemyEntryDefaults(), entry);
    const b = new Uint8Array(ENEMY_ENTRY_BYTES);
    const m = e.motion;
    putU8(b, 0x0, `${label}.motion.birth`, check(`${label}.motion.birth`, m.birth, 0, 7));
    putU8(b, 0x1, `${label}.motion.in`, check(`${label}.motion.in`, m.in, 0, 1));
    putU8(b, 0x2, `${label}.score`, check(`${label}.score`, e.score, 0, 0xf));
    putU8(b, 0x3, `${label}.hp`, check(`${label}.hp`, e.hp, 0, 0xf));
    const a = e.animation;
    b[0x4] = (check(`${label}.animation.disabled`, a.disabled, 0, 1) << 7) | check(`${label}.animation.frameSpeed`, a.frameSpeed, 0, 0x7f);
    for (let i = 0; i < 4; i++) putU8(b, 0x5 + i, `${label}.animation.models[${i}]`, a.models[i]);
    b[0x9] = pack(`${label}.flags`, ENEMY_FLAGS, e.flags);
    const alt = e.altitude;
    putU8(b, 0xa, `${label}.altitude.cue`, check(`${label}.altitude.cue`, alt.cue, 0, 7));
    putU8(b, 0xb, `${label}.altitude.initial`, check(`${label}.altitude.initial`, alt.initial, 0, 8));
    putU8(b, 0xc, `${label}.altitude.final`, check(`${label}.altitude.final`, alt.final, 0, 8));
    putU8(b, 0xd, `${label}.altitude.speed`, check(`${label}.altitude.speed`, alt.speed, 0, 7));
    b[0xe] = pack(`${label}.altitude`, ALTITUDE_SETTINGS, alt);
    const sc = e.scaling;
    putU8(b, 0xf, `${label}.scaling.cue`, check(`${label}.scaling.cue`, sc.cue, 0, 7));
    const r = e.rotation;
    putU8(b, 0x10, `${label}.rotation.cue`, check(`${label}.rotation.cue`, r.cue, 0, 7));
    putU8(b, 0x11, `${label}.unknown11`, e.unknown11);
    putU16(b, 0x12, `${label}.scale`, check(`${label}.scale`, e.scale, 0, 9999));
    putU8(b, 0x14, `${label}.scaling.initial`, check(`${label}.scaling.initial`, sc.initial, 0, 7));
    putU8(b, 0x15, `${label}.scaling.final`, check(`${label}.scaling.final`, sc.final, 0, 7));
    putU8(b, 0x16, `${label}.scaling.speed`, check(`${label}.scaling.speed`, sc.speed, 0, 7));
    putU8(b, 0x17, `${label}.scaling.loopType`, check(`${label}.scaling.loopType`, sc.loopType, 0, 3));
    putU8(b, 0x18, `${label}.rotation.start`, r.start);
    putU8(b, 0x19, `${label}.rotation.end`, r.end);
    putU8(b, 0x1a, `${label}.rotation.speed`, check(`${label}.rotation.speed`, r.speed, 0, 7));
    b[0x1b] = pack(`${label}.rotation`, ROTATION_1B, r);
    b[0x1c] = pack(`${label}.rotation`, ROTATION_1C, r);
    putU8(b, 0x1d, `${label}.motion.type`, check(`${label}.motion.type`, m.type, 0, 1));
    putU8(b, 0x1e, `${label}.motion.orbit1`, check(`${label}.motion.orbit1`, m.orbit1, 0, 0x1d));
    putU8(b, 0x1f, `${label}.motion.orbit2`, check(`${label}.motion.orbit2`, m.orbit2, 0, 0x13));
    putU8(b, 0x20, `${label}.motion.orbit3`, check(`${label}.motion.orbit3`, m.orbit3, 0, 0x13));
    putU8(b, 0x21, `${label}.motion.speed1`, check(`${label}.motion.speed1`, m.speed1, 0, 7));
    putU8(b, 0x22, `${label}.motion.speed2`, check(`${label}.motion.speed2`, m.speed2, 0, 7));
    putU8(b, 0x23, `${label}.motion.speed3`, check(`${label}.motion.speed3`, m.speed3, 0, 7));
    e.shots.forEach((s, i) => {
        const sl = `${label}.shots[${i}]`;
        b[0x24 + i] = pack(sl, SHOT_TYPE, s);
        b[0x27 + i] = pack(sl, SHOT_SETTINGS, s);
        putIndex(b, 0x2a + i, `${sl}.launchedEnemy`, s.launchedEnemy);
        putS16(b, 0x2e + i * 2, `${sl}.x`, s.x);
        putS16(b, 0x34 + i * 2, `${sl}.y`, s.y);
        putS16(b, 0x3a + i * 2, `${sl}.z`, s.z);
        putS8(b, 0x53 + i, `${sl}.se`, s.se);
        putU8(b, 0x57 + i, `${sl}.seVolume`, check(`${sl}.seVolume`, s.seVolume, 0, 7));
    });
    putU8(b, 0x2d, `${label}.unknown2D`, e.unknown2D);
    const h = e.hit;
    b[0x40] = pack(`${label}.hit`, HIT_SETTINGS, h);
    putU8(b, 0x41, `${label}.hit.size`, check(`${label}.hit.size`, h.size, 0, 7));
    const bl = e.blast;
    b[0x42] = pack(`${label}.blast`, BLAST_SETTINGS, bl);
    b[0x43] = pack(`${label}.item`, ITEM_FLAGGED, e.item);
    putIndex(b, 0x44, `${label}.enemySet`, e.enemySet);
    putIndex(b, 0x45, `${label}.enemyRise`, e.enemyRise);
    b[0x46] = pack(`${label}.motion.death`, DEATH_FLAGGED, { enabled: m.deathEnabled, value: m.death });
    putU8(b, 0x47, `${label}.unknown47`, e.unknown47);
    putS16(b, 0x48, `${label}.hit.x`, h.x);
    putS16(b, 0x4a, `${label}.hit.y`, h.y);
    putS16(b, 0x4c, `${label}.hit.z`, h.z);
    const t = e.transparency;
    putU8(b, 0x4e, `${label}.transparency.cue`, check(`${label}.transparency.cue`, t.cue, 0, 7));
    putU8(b, 0x4f, `${label}.transparency.initial`, check(`${label}.transparency.initial`, t.initial, 0, 7));
    putU8(b, 0x50, `${label}.transparency.final`, check(`${label}.transparency.final`, t.final, 0, 7));
    putU8(b, 0x51, `${label}.transparency.speed`, check(`${label}.transparency.speed`, t.speed, 0, 7));
    putU8(b, 0x52, `${label}.transparency.loopType`, check(`${label}.transparency.loopType`, t.loopType, 0, 3));
    putS8(b, 0x56, `${label}.blast.se`, bl.se);
    putU8(b, 0x5a, `${label}.blast.seVolume`, check(`${label}.blast.seVolume`, bl.seVolume, 0, 7));
    putU8(b, 0x5b, `${label}.unknown5B`, e.unknown5B);
    return b;
}

/**
 * 0x5C bytes -> one enemy entry, the shape of enemyEntryDefaults().
 * @param {Uint8Array} bytes
 * @param {number} [at]
 */
export function decodeEnemyEntry(bytes, at = 0) {
    needBytes("enemy", bytes, at, ENEMY_ENTRY_BYTES);
    const b = bytes.subarray(at, at + ENEMY_ENTRY_BYTES);
    const death = unpack(DEATH_FLAGGED, b[0x46]);
    return {
        score: b[0x2],
        hp: b[0x3],
        animation: { disabled: (b[0x4] & 0x80) !== 0, frameSpeed: b[0x4] & 0x7f, models: [b[0x5], b[0x6], b[0x7], b[0x8]] },
        flags: unpack(ENEMY_FLAGS, b[0x9]),
        altitude: { cue: b[0xa], initial: b[0xb], final: b[0xc], speed: b[0xd], ...unpack(ALTITUDE_SETTINGS, b[0xe]) },
        unknown11: b[0x11],
        scale: u16(b, 0x12),
        scaling: { cue: b[0xf], initial: b[0x14], final: b[0x15], speed: b[0x16], loopType: b[0x17] },
        rotation: {
            cue: b[0x10],
            start: b[0x18],
            end: b[0x19],
            speed: b[0x1a],
            ...unpack(ROTATION_1B, b[0x1b]),
            ...unpack(ROTATION_1C, b[0x1c]),
        },
        motion: {
            birth: b[0x0],
            in: b[0x1],
            type: b[0x1d],
            orbit1: b[0x1e],
            orbit2: b[0x1f],
            orbit3: b[0x20],
            speed1: b[0x21],
            speed2: b[0x22],
            speed3: b[0x23],
            death: death.value,
            deathEnabled: death.enabled,
        },
        shots: [0, 1, 2].map((i) => ({
            ...unpack(SHOT_TYPE, b[0x24 + i]),
            ...unpack(SHOT_SETTINGS, b[0x27 + i]),
            launchedEnemy: getIndex(b, 0x2a + i),
            x: s16(b, 0x2e + i * 2),
            y: s16(b, 0x34 + i * 2),
            z: s16(b, 0x3a + i * 2),
            se: s8(b, 0x53 + i),
            seVolume: b[0x57 + i],
        })),
        unknown2D: b[0x2d],
        hit: { ...unpack(HIT_SETTINGS, b[0x40]), size: b[0x41], x: s16(b, 0x48), y: s16(b, 0x4a), z: s16(b, 0x4c) },
        blast: { ...unpack(BLAST_SETTINGS, b[0x42]), se: s8(b, 0x56), seVolume: b[0x5a] },
        item: unpack(ITEM_FLAGGED, b[0x43]),
        enemySet: getIndex(b, 0x44),
        enemyRise: getIndex(b, 0x45),
        unknown47: b[0x47],
        transparency: { cue: b[0x4e], initial: b[0x4f], final: b[0x50], speed: b[0x51], loopType: b[0x52] },
        unknown5B: b[0x5b],
    };
}

// --- the layout: three layers of 0xC positions -------------------------------------------

export const LAYOUT_ENTRY_BYTES = 0xc;

/** Enemies the three layers hold between them; each layer then ends in a terminator. */
export const LAYOUT_MAX_ENEMIES = 1000;

/** The whole layout region: 1000 enemies + 3 terminators, 0x2F04 bytes. */
export const LAYOUT_BYTES = (LAYOUT_MAX_ENEMIES + 3) * LAYOUT_ENTRY_BYTES;

/** The layers in file order. */
export const LAYOUT_LAYERS = Object.freeze(["map", "a", "b"]);

export function layoutEntryDefaults() {
    return { enemy: 0, unknown01: 0, x: 0, y: 0, unknown06: 0, frame: 0 };
}

/**
 * One position -> 0xC bytes: enemy number (-1 is a layer's terminator), the
 * unknown byte, x, y, the unknown u16, then the signed frame offset, which
 * the sample stages count down from the start frame (-218, -346, ...).
 */
export function encodeLayoutEntry(entry = {}, label = "layout entry") {
    const e = merge(label, layoutEntryDefaults(), entry);
    const b = new Uint8Array(LAYOUT_ENTRY_BYTES);
    putIndex(b, 0x0, `${label}.enemy`, e.enemy);
    putU8(b, 0x1, `${label}.unknown01`, e.unknown01);
    putS16(b, 0x2, `${label}.x`, e.x);
    putS16(b, 0x4, `${label}.y`, e.y);
    putU16(b, 0x6, `${label}.unknown06`, e.unknown06);
    putS32(b, 0x8, `${label}.frame`, e.frame);
    return b;
}

export function decodeLayoutEntry(bytes, at = 0) {
    needBytes("layout entry", bytes, at, LAYOUT_ENTRY_BYTES);
    return {
        enemy: getIndex(bytes, at),
        unknown01: bytes[at + 1],
        x: s16(bytes, at + 2),
        y: s16(bytes, at + 4),
        unknown06: u16(bytes, at + 6),
        frame: s32(bytes, at + 8),
    };
}

function layers(layout) {
    const l = merge("layout", { map: [], a: [], b: [] }, layout);
    for (const k of LAYOUT_LAYERS) if (!Array.isArray(l[k])) throw new Error(`layout.${k} is a list of positions`);
    return l;
}

/**
 * Where each layer's first entry lands, counting terminators the way the
 * tail does: map at 0, A one past the map layer's terminator, B one past
 * A's. Also the number of enemies and of slots (enemies + 3).
 * @param {{map?: object[], a?: object[], b?: object[]}} [layout]
 */
export function layoutIndices(layout = {}) {
    const l = layers(layout);
    const enemies = l.map.length + l.a.length + l.b.length;
    return {
        map: 0,
        a: l.map.length + 1,
        b: l.map.length + l.a.length + 2,
        enemies,
        slots: enemies + 3,
    };
}

/**
 * The three layers laid end to end, each closed by a terminator, the rest of
 * the 0x2F04 region zero. Throws past 1000 enemies.
 * @param {{map?: object[], a?: object[], b?: object[]}} [layout]
 * @returns {Uint8Array}
 */
export function encodeLayout(layout = {}) {
    const l = layers(layout);
    const idx = layoutIndices(l);
    if (idx.enemies > LAYOUT_MAX_ENEMIES) {
        throw new Error(`the layout holds ${LAYOUT_MAX_ENEMIES} enemies across its three layers; ${idx.enemies} were given`);
    }
    const out = new Uint8Array(LAYOUT_BYTES);
    let at = 0;
    for (const k of LAYOUT_LAYERS) {
        l[k].forEach((e, i) => {
            const entry = encodeLayoutEntry(e, `layout.${k}[${i}]`);
            if (entry[0] === 0xff) throw new Error(`layout.${k}[${i}].enemy is -1, which marks the end of a layer`);
            out.set(entry, at);
            at += LAYOUT_ENTRY_BYTES;
        });
        out[at] = 0xff; // the terminator: enemy -1, everything else zero
        at += LAYOUT_ENTRY_BYTES;
    }
    return out;
}

/**
 * The three layers back out of a layout region. A layer the region ends
 * before closing comes back with what it held; layers past that are empty.
 * A region with no terminator at all (a zero-filled #BL) would read as 1,003
 * enemies at the origin, more than encodeLayout() takes back, so reading
 * stops at the 1,000 the layout holds: the rest of such a region is
 * padding, not positions.
 * @param {Uint8Array} bytes
 * @param {number} [at]
 */
export function decodeLayout(bytes, at = 0) {
    const out = { map: [], a: [], b: [] };
    const end = Math.min(bytes.length, at + LAYOUT_BYTES);
    let layer = 0, enemies = 0;
    for (let p = at; p + LAYOUT_ENTRY_BYTES <= end && layer < LAYOUT_LAYERS.length; p += LAYOUT_ENTRY_BYTES) {
        const e = decodeLayoutEntry(bytes, p);
        if (e.enemy === -1) layer++;
        else if (enemies < LAYOUT_MAX_ENEMIES) {
            out[LAYOUT_LAYERS[layer]].push(e);
            enemies++;
        } else break;
    }
    return out;
}

// --- the map: global settings and 256 entries ---------------------------------------------

export const MAP_SETTINGS_BYTES = 3;
export const MAP_ENTRY_BYTES = 4;
export const MAP_ENTRIES = 256;
export const MAP_BYTES = MAP_ENTRIES * MAP_ENTRY_BYTES;

/** The texture byte of a map entry that is not set. */
export const MAP_TEXTURE_UNSET = 150;

/** Scale 5, loop 0..3: what two of the three sample stages carry. */
export function mapSettingsDefaults() {
    return { scale: 5, loopStart: 0, loopEnd: 3 };
}

export function encodeMapSettings(settings = {}) {
    const s = merge("map settings", mapSettingsDefaults(), settings);
    const b = new Uint8Array(MAP_SETTINGS_BYTES);
    putU8(b, 0, "map settings.scale", s.scale);
    putU8(b, 1, "map settings.loopStart", s.loopStart);
    putU8(b, 2, "map settings.loopEnd", s.loopEnd);
    return b;
}

export function decodeMapSettings(bytes, at = 0) {
    needBytes("map settings", bytes, at, MAP_SETTINGS_BYTES);
    return { scale: bytes[at], loopStart: bytes[at + 1], loopEnd: bytes[at + 2] };
}

const MAP_EFFECTS = [
    { name: "transparency", mask: 0xe000 },
    { name: "type", mask: 0x1c00 },
    { name: "speed", mask: 0x0380 },
    { name: "intensity", mask: 0x0070 },
    { name: "cycle", mask: 0x000c },
    { name: "noise", mask: 0x0003 },
];

/** An unset map entry as the cartridge leaves it: effects word 0xE3D4, no hit, texture 150. */
export function mapEntryDefaults() {
    return { transparency: 7, type: 0, speed: 7, intensity: 5, cycle: 1, noise: 0, hit: false, texture: MAP_TEXTURE_UNSET };
}

export function encodeMapEntry(entry = {}, label = "map entry") {
    const e = merge(label, mapEntryDefaults(), entry);
    const b = new Uint8Array(MAP_ENTRY_BYTES);
    putU16(b, 0, label, pack(label, MAP_EFFECTS, e));
    b[2] = check(`${label}.hit`, e.hit, 0, 1);
    putU8(b, 3, `${label}.texture`, e.texture);
    return b;
}

export function decodeMapEntry(bytes, at = 0) {
    needBytes("map entry", bytes, at, MAP_ENTRY_BYTES);
    return { ...unpack(MAP_EFFECTS, u16(bytes, at)), hit: bytes[at + 2] !== 0, texture: bytes[at + 3] };
}

/** Up to 256 entries -> the 0x400-byte table; the rest are unset entries. */
export function encodeMapEntries(entries = []) {
    if (!Array.isArray(entries)) throw new Error("map entries are a list");
    if (entries.length > MAP_ENTRIES) throw new Error(`the map holds ${MAP_ENTRIES} entries; ${entries.length} were given`);
    const out = new Uint8Array(MAP_BYTES);
    for (let i = 0; i < MAP_ENTRIES; i++) out.set(encodeMapEntry(entries[i] ?? {}, `map[${i}]`), i * MAP_ENTRY_BYTES);
    return out;
}

export function decodeMapEntries(bytes, at = 0) {
    needBytes("map", bytes, at, MAP_BYTES);
    return fill(MAP_ENTRIES, () => null).map((_, i) => decodeMapEntry(bytes, at + i * MAP_ENTRY_BYTES));
}

// --- the layout effects: 500 x 0xC ---------------------------------------------------------

export const EFFECT_ENTRY_BYTES = 0xc;
export const EFFECT_ENTRIES = 500;
export const EFFECT_BYTES = EFFECT_ENTRIES * EFFECT_ENTRY_BYTES;

/** The command byte's names, index = command. */
export const EFFECT_COMMANDS = Object.freeze([
    "soundEffect", // v1 SE, v2 volume, v3 loop start/end
    "portrait", // v1 set/clear, v2 texture, v3 position, v4 flags
    "fog", // v1..v3 RGB, v4 level
    "altitude", // v1 altitude 0..0xA, v2 speed
    "cameraAngle", // v2 position, v3 speed
    "cameraRotation", // v2 position, v3 speed
    "cameraZoom", // v2 position, v3 speed
    "backgroundTexture", // v2 texture
    "scrollBackground", // v1 x, v2 y, v3 free/zero
    "stageClear",
    "playerVisibility", // v1 on/off
    "playerHitDetection", // v1 on/off
    "playerSplash", // v1 off/constant/contact
    "song", // v1 song, v2 volume
    "demoMode", // v1 on/off
    "vibration", // v1 level
    "mapScrollRate", // v1 rate, v2 speed
    "layerAScrollRate", // v1 rate, v2 speed
    "layerBScrollRate", // v1 rate, v2 speed
]);

/** A command's number from its name or number; throws on an unknown name. */
export function effectCommand(command) {
    if (typeof command === "string") {
        const n = EFFECT_COMMANDS.indexOf(command);
        if (n < 0) throw new Error(`"${command}" is not a layout effect command; one of ${EFFECT_COMMANDS.join(", ")}`);
        return n;
    }
    return check("effect.command", command, 0, EFFECT_COMMANDS.length - 1);
}

/** A blank effect is all zero, which is how the cartridge leaves the 500 slots. */
export function layoutEffectDefaults() {
    return { frame: 0, values: [0, 0, 0, 0], command: 0, reserved: [0, 0, 0] };
}

/**
 * One effect -> 0xC bytes. Values are bytes; a -1 the document names (a
 * portrait clear, say) is written as 0xFF and reads back as 255. The
 * command may be given by name.
 */
export function encodeLayoutEffect(effect = {}, label = "effect") {
    const e = merge(label, layoutEffectDefaults(), effect);
    const b = new Uint8Array(EFFECT_ENTRY_BYTES);
    putU32(b, 0, `${label}.frame`, e.frame);
    e.values.forEach((v, i) => {
        b[4 + i] = check(`${label}.values[${i}]`, v, -0x80, 0xff) & 0xff;
    });
    b[8] = effectCommand(e.command);
    e.reserved.forEach((v, i) => putU8(b, 9 + i, `${label}.reserved[${i}]`, v));
    return b;
}

export function decodeLayoutEffect(bytes, at = 0) {
    needBytes("effect", bytes, at, EFFECT_ENTRY_BYTES);
    return {
        frame: u32(bytes, at),
        values: [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]],
        command: bytes[at + 8],
        reserved: [bytes[at + 9], bytes[at + 10], bytes[at + 11]],
    };
}

/** Up to 500 effects -> the 0x1770-byte table, the rest blank. */
export function encodeLayoutEffects(effects = []) {
    if (!Array.isArray(effects)) throw new Error("effects are a list");
    if (effects.length > EFFECT_ENTRIES) throw new Error(`a stage holds ${EFFECT_ENTRIES} layout effects; ${effects.length} were given`);
    const out = new Uint8Array(EFFECT_BYTES);
    effects.forEach((e, i) => out.set(encodeLayoutEffect(e, `effects[${i}]`), i * EFFECT_ENTRY_BYTES));
    return out;
}

/**
 * The effects table back out: `count` entries when given (the tail's total),
 * else every slot up to the last non-blank one.
 */
export function decodeLayoutEffects(bytes, at = 0, count = null) {
    needBytes("effects", bytes, at, EFFECT_BYTES);
    let n = EFFECT_ENTRIES;
    while (n > (count ?? 0) && isZero(bytes, at + (n - 1) * EFFECT_ENTRY_BYTES, EFFECT_ENTRY_BYTES)) n--;
    return fill(n, () => null).map((_, i) => decodeLayoutEffect(bytes, at + i * EFFECT_ENTRY_BYTES));
}

// --- the #BL tail and the whole stage file -------------------------------------------------

export const BL_TAIL_BYTES = 0x10;

/** Enemy entries a stage holds. */
export const BL_ENEMY_COUNT = 180;

/** Where each region of a disk-mode #BL starts. */
export const BL_OFFSETS = Object.freeze({
    enemies: 0,
    layout: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES, // 0x40B0
    mapSettings: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES, // 0x6FB4
    map: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES, // 0x6FB7
    effects: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES + MAP_BYTES, // 0x73B7
    tail: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES + MAP_BYTES + EFFECT_BYTES, // 0x8B27
});

/**
 * An empty stage's tail: no effects, the three layers each starting right
 * after the previous one's terminator, the 0x8B33 word at the 0x200 the
 * document says it always holds. (The cartridge variant stops after the
 * three indices, so the last three words are the document's alone.)
 */
export function blTailDefaults() {
    return { totalEffects: 0, firstMap: 0, firstA: 1, firstB: 2, unknown2F: 0, word33: 0x200, unknown35: 0 };
}

export function encodeBlTail(tail = {}) {
    const t = merge("tail", blTailDefaults(), tail);
    const b = new Uint8Array(BL_TAIL_BYTES);
    putU16(b, 0x0, "tail.totalEffects", t.totalEffects);
    putU16(b, 0x2, "tail.firstMap", t.firstMap);
    putU16(b, 0x4, "tail.firstA", t.firstA);
    putU16(b, 0x6, "tail.firstB", t.firstB);
    putU32(b, 0x8, "tail.unknown2F", t.unknown2F);
    putU16(b, 0xc, "tail.word33", t.word33);
    putU16(b, 0xe, "tail.unknown35", t.unknown35);
    return b;
}

export function decodeBlTail(bytes, at = 0) {
    needBytes("tail", bytes, at, BL_TAIL_BYTES);
    return {
        totalEffects: u16(bytes, at),
        firstMap: u16(bytes, at + 2),
        firstA: u16(bytes, at + 4),
        firstB: u16(bytes, at + 6),
        unknown2F: u32(bytes, at + 8),
        word33: u16(bytes, at + 0xc),
        unknown35: u16(bytes, at + 0xe),
    };
}

function enemyTable(list, count, label) {
    if (!Array.isArray(list)) throw new Error(`${label} is a list of enemy entries`);
    if (list.length > count) throw new Error(`${label} holds ${count} entries; ${list.length} were given`);
    const out = new Uint8Array(count * ENEMY_ENTRY_BYTES);
    for (let i = 0; i < count; i++) out.set(encodeEnemyEntry(list[i] ?? {}, `${label}[${i}]`), i * ENEMY_ENTRY_BYTES);
    return out;
}

function enemyList(bytes, at, count) {
    return fill(count, () => null).map((_, i) => decodeEnemyEntry(bytes, at + i * ENEMY_ENTRY_BYTES));
}

/**
 * A stage's build data -> the 0x8B37-byte #BL.
 *
 *   enemies      up to 180 entries (encodeEnemyEntry); the rest default
 *   layout       {map, a, b}: lists of positions (encodeLayout)
 *   mapSettings  {scale, loopStart, loopEnd}
 *   map          up to 256 entries; the rest unset
 *   effects      up to 500 (encodeLayoutEffect)
 *   tail         any field of blTailDefaults(); totalEffects and the two
 *                layer indices are computed from `effects` and `layout`
 *                unless given
 *
 * @returns {Uint8Array}
 */
export function buildStageBl({ enemies = [], layout = {}, mapSettings = {}, map = [], effects = [], tail = {} } = {}) {
    const out = new Uint8Array(DOCUMENTED_SIZES.BL);
    out.set(enemyTable(enemies, BL_ENEMY_COUNT, "enemies"), BL_OFFSETS.enemies);
    out.set(encodeLayout(layout), BL_OFFSETS.layout);
    out.set(encodeMapSettings(mapSettings), BL_OFFSETS.mapSettings);
    out.set(encodeMapEntries(map), BL_OFFSETS.map);
    out.set(encodeLayoutEffects(effects), BL_OFFSETS.effects);
    const idx = layoutIndices(layout);
    const t = merge("tail", blTailDefaults(), tail);
    const given = tail ?? {};
    const computed = {
        ...t,
        totalEffects: given.totalEffects ?? effects.length,
        firstA: given.firstA ?? idx.a,
        firstB: given.firstB ?? idx.b,
    };
    out.set(encodeBlTail(computed), BL_OFFSETS.tail);
    return out;
}

/**
 * A #BL back into its records: enemies[180], layout {map, a, b}, mapSettings,
 * map[256], effects (the tail's count, or up to the last non-blank slot) and
 * tail. Throws when the bytes are shorter than a #BL.
 * @param {Uint8Array} bytes
 */
export function parseStageBl(bytes) {
    needBytes("#BL", bytes, 0, DOCUMENTED_SIZES.BL);
    const tail = decodeBlTail(bytes, BL_OFFSETS.tail);
    return {
        enemies: enemyList(bytes, BL_OFFSETS.enemies, BL_ENEMY_COUNT),
        layout: decodeLayout(bytes, BL_OFFSETS.layout),
        mapSettings: decodeMapSettings(bytes, BL_OFFSETS.mapSettings),
        map: decodeMapEntries(bytes, BL_OFFSETS.map),
        effects: decodeLayoutEffects(bytes, BL_OFFSETS.effects, tail.totalEffects),
        tail,
    };
}

// --- CBL: 20 common enemies and the 7 items --------------------------------------------------

export const CBL_ENEMY_COUNT = 20;

/** The item entries after the enemies, in file order; each is an enemy entry. */
export const CBL_ITEMS = Object.freeze(["shot", "laser", "bomb", "shield", "oneUp", "bonus1", "bonus2"]);

export const CBL_ITEMS_OFFSET = CBL_ENEMY_COUNT * ENEMY_ENTRY_BYTES; // 0x730

/**
 * Common build data -> the 0x9B4-byte CBL. `items` is {shot, laser, bomb,
 * shield, oneUp, bonus1, bonus2} (any subset; each an enemy entry) or a
 * list of up to seven in that order.
 * @returns {Uint8Array}
 */
export function buildCbl({ enemies = [], items = {} } = {}) {
    const out = new Uint8Array(DOCUMENTED_SIZES.CBL);
    out.set(enemyTable(enemies, CBL_ENEMY_COUNT, "enemies"), 0);
    let byName;
    if (Array.isArray(items)) {
        if (items.length > CBL_ITEMS.length) throw new Error(`CBL holds ${CBL_ITEMS.length} items; ${items.length} were given`);
        byName = Object.fromEntries(items.map((it, i) => [CBL_ITEMS[i], it]));
    } else {
        if (!isPlain(items)) throw new Error("items are {shot, laser, bomb, shield, oneUp, bonus1, bonus2} or a list");
        for (const k of Object.keys(items)) {
            if (!CBL_ITEMS.includes(k)) throw new Error(`items.${k} is not an item; the items are ${CBL_ITEMS.join(", ")}`);
        }
        byName = items;
    }
    CBL_ITEMS.forEach((name, i) => {
        out.set(encodeEnemyEntry(byName[name] ?? {}, `items.${name}`), CBL_ITEMS_OFFSET + i * ENEMY_ENTRY_BYTES);
    });
    return out;
}

/** @param {Uint8Array} bytes */
export function parseCbl(bytes) {
    needBytes("CBL", bytes, 0, DOCUMENTED_SIZES.CBL);
    return {
        enemies: enemyList(bytes, 0, CBL_ENEMY_COUNT),
        items: Object.fromEntries(CBL_ITEMS.map((name, i) => [name, decodeEnemyEntry(bytes, CBL_ITEMS_OFFSET + i * ENEMY_ENTRY_BYTES)])),
    };
}

// --- the 0xC20 model record (#MD, CMD, ULB) -----------------------------------------------

export const MODEL_BYTES = 0xc20;
export const MODEL_MAX_VERTICES = 100;
export const MODEL_MAX_FACES = 100;
export const MODEL_TILES = 16;
export const VERTEX_BYTES = 6;
export const FACE_BYTES = 0x14;
export const MODEL_TILE_BYTES = 0x14;

/** Where each table of a model starts. */
export const MODEL_OFFSETS = Object.freeze({
    vertices: 0x2,
    faces: 0x25a,
    unknownA2A: 0xa2a,
    tiles: 0xa2c,
    hScale: 0xb6c,
    vScale: 0xb8c,
    groups: 0xbac,
    light: 0xc10,
    unknownC11: 0xc11,
});

/**
 * A tile's scales as the document gives them, 0x64..0x400 with 0x400 the
 * 1:1 the editor starts from. The cartridge's sample models hold 0x46F and
 * 0x42B as well, so the encoder admits the whole u16 (and 0, an empty slot)
 * and these two are the editor's range, not a check. (likely)
 */
export const TILE_SCALE_MIN = 0x64;
export const TILE_SCALE_MAX = 0x400;

/** A tile's offset: "0 to 0x1EF; pixel offset for 4x4 blocks, 0x20 per row". (as written) */
export const TILE_OFFSET_MAX = 0x1ef;

/** The light byte picks one of the 30 GAM light positions, 0..0x1D. */
export const LIGHT_POSITION_MAX = 0x1d;

/**
 * The pixels a tile's width power stands for, as the document puts it:
 * "power of 2 (4 = 32, 5 = 64, etc.)", so 1 << (power + 1). Booted
 * 2026-10-21: a width power of 5 spans the 64-px texture once. (confirmed)
 */
export function tilePixels(power) {
    return 1 << (check("tile power", power, 0, 7) + 1);
}

/**
 * The rows a tile's height power stands for: 1 << (power - 1), not the
 * width's rule. Booted 2026-10-21: a height power of 4 repeated the top 8
 * rows of a texture, and the editor's blank tile (width 5, height 6) is the
 * whole 64x32 texture. (confirmed)
 */
export function tileHeightPixels(power) {
    return 1 << (check("tile power", power, 1, 7) - 1);
}

const FACE_TEXTURING = [
    { name: "untextured", mask: 0x80, bool: true },
    { name: "lightMask", mask: 0x40, bool: true },
    { name: "tile", mask: 0x0f },
    { name: "unknownBits", mask: 0x30 },
];

export function vertexDefaults() {
    return { x: 0, y: 0, z: 0 };
}

/** A textured face on tile 0, lit white. */
export function faceDefaults() {
    return {
        vertices: [0, 0, 0],
        pad: 0,
        uv: [[0, 0], [0, 0], [0, 0]],
        light: [255, 255, 255],
        untextured: false,
        lightMask: false,
        tile: 0,
        unknownBits: 0,
    };
}

/** The editor's blank tile, as every unused slot of the cartridge's sample models holds it: offset 0, no mirroring, width power 5, height power 6. */
export function tileDefaults() {
    return { offset: 0, mirrorV: false, widthPower: 5, mirrorH: false, heightPower: 6 };
}

/**
 * A model with nothing in it but the editor's blank tiles at 1:1 scale.
 * `vertexCount` / `faceCount` null means the length of the lists; `groups`
 * null means -1 (ungrouped) for every vertex the model has and 0 for the
 * slots it does not, which is how the sample models are grouped.
 */
export function modelDefaults() {
    return {
        vertexCount: null,
        faceCount: null,
        vertices: [],
        faces: [],
        unknownA2A: 0,
        tiles: fill(MODEL_TILES, tileDefaults),
        hScale: fill(MODEL_TILES, TILE_SCALE_MAX),
        vScale: fill(MODEL_TILES, TILE_SCALE_MAX),
        groups: null,
        light: 0,
        unknownC11: new Uint8Array(MODEL_BYTES - 0xc11),
    };
}

export function encodeFace(face = {}, label = "face") {
    const f = merge(label, faceDefaults(), face);
    const b = new Uint8Array(FACE_BYTES);
    f.vertices.forEach((v, i) => putU8(b, i, `${label}.vertices[${i}]`, check(`${label}.vertices[${i}]`, v, 0, MODEL_MAX_VERTICES - 1)));
    putU8(b, 3, `${label}.pad`, f.pad);
    f.uv.forEach(([u, v], i) => {
        putS16(b, 4 + i * 4, `${label}.uv[${i}][0]`, u);
        putS16(b, 6 + i * 4, `${label}.uv[${i}][1]`, v);
    });
    f.light.forEach((c, i) => putU8(b, 0x10 + i, `${label}.light[${i}]`, c));
    b[0x13] = pack(label, FACE_TEXTURING, f);
    return b;
}

export function decodeFace(bytes, at = 0) {
    needBytes("face", bytes, at, FACE_BYTES);
    return {
        vertices: [bytes[at], bytes[at + 1], bytes[at + 2]],
        pad: bytes[at + 3],
        uv: [0, 1, 2].map((i) => [s16(bytes, at + 4 + i * 4), s16(bytes, at + 6 + i * 4)]),
        light: [bytes[at + 0x10], bytes[at + 0x11], bytes[at + 0x12]],
        ...unpack(FACE_TEXTURING, bytes[at + 0x13]),
    };
}

export function encodeTile(tile = {}, label = "tile") {
    const t = merge(label, tileDefaults(), tile);
    const b = new Uint8Array(MODEL_TILE_BYTES);
    putU32(b, 0x0, `${label}.offset`, check(`${label}.offset`, t.offset, 0, TILE_OFFSET_MAX));
    putU32(b, 0x4, `${label}.mirrorV`, check(`${label}.mirrorV`, t.mirrorV, 0, 1));
    putU32(b, 0x8, `${label}.widthPower`, check(`${label}.widthPower`, t.widthPower, 0, 7));
    putU32(b, 0xc, `${label}.mirrorH`, check(`${label}.mirrorH`, t.mirrorH, 0, 1));
    putU32(b, 0x10, `${label}.heightPower`, check(`${label}.heightPower`, t.heightPower, 0, 7));
    return b;
}

export function decodeTile(bytes, at = 0) {
    needBytes("tile", bytes, at, MODEL_TILE_BYTES);
    return {
        offset: u32(bytes, at),
        mirrorV: u32(bytes, at + 4) !== 0,
        widthPower: u32(bytes, at + 8),
        mirrorH: u32(bytes, at + 0xc) !== 0,
        heightPower: u32(bytes, at + 0x10),
    };
}

/**
 * One model -> 0xC20 bytes. See modelDefaults() for the shape; vertices and
 * faces are lists of up to 100.
 * @returns {Uint8Array}
 */
export function encodeModel(model = {}, label = "model") {
    const m = merge(label, modelDefaults(), model);
    if (m.vertices.length > MODEL_MAX_VERTICES) throw new Error(`${label}.vertices holds ${MODEL_MAX_VERTICES}; ${m.vertices.length} were given`);
    if (m.faces.length > MODEL_MAX_FACES) throw new Error(`${label}.faces holds ${MODEL_MAX_FACES}; ${m.faces.length} were given`);
    const b = new Uint8Array(MODEL_BYTES);
    putU8(b, 0, `${label}.vertexCount`, check(`${label}.vertexCount`, m.vertexCount ?? m.vertices.length, 0, MODEL_MAX_VERTICES));
    putU8(b, 1, `${label}.faceCount`, check(`${label}.faceCount`, m.faceCount ?? m.faces.length, 0, MODEL_MAX_FACES));
    m.vertices.forEach((v, i) => {
        const p = merge(`${label}.vertices[${i}]`, vertexDefaults(), v);
        const at = MODEL_OFFSETS.vertices + i * VERTEX_BYTES;
        putS16(b, at, `${label}.vertices[${i}].x`, p.x);
        putS16(b, at + 2, `${label}.vertices[${i}].y`, p.y);
        putS16(b, at + 4, `${label}.vertices[${i}].z`, p.z);
    });
    m.faces.forEach((f, i) => b.set(encodeFace(f, `${label}.faces[${i}]`), MODEL_OFFSETS.faces + i * FACE_BYTES));
    putU16(b, MODEL_OFFSETS.unknownA2A, `${label}.unknownA2A`, m.unknownA2A);
    m.tiles.forEach((t, i) => b.set(encodeTile(t, `${label}.tiles[${i}]`), MODEL_OFFSETS.tiles + i * MODEL_TILE_BYTES));
    m.hScale.forEach((v, i) => putU16(b, MODEL_OFFSETS.hScale + i * 2, `${label}.hScale[${i}]`, v));
    m.vScale.forEach((v, i) => putU16(b, MODEL_OFFSETS.vScale + i * 2, `${label}.vScale[${i}]`, v));
    const groups = m.groups ?? fill(MODEL_MAX_VERTICES, () => 0).map((_, i) => (i < m.vertices.length ? -1 : 0));
    if (!Array.isArray(groups) || groups.length !== MODEL_MAX_VERTICES) throw new Error(`${label}.groups is one byte per vertex slot, ${MODEL_MAX_VERTICES} of them`);
    groups.forEach((g, i) => putS8(b, MODEL_OFFSETS.groups + i, `${label}.groups[${i}]`, g));
    putU8(b, MODEL_OFFSETS.light, `${label}.light`, check(`${label}.light`, m.light, 0, LIGHT_POSITION_MAX));
    b.set(m.unknownC11, MODEL_OFFSETS.unknownC11);
    return b;
}

/**
 * 0xC20 bytes -> a model. The vertex and face lists run to the count byte
 * or to the last slot that holds anything, whichever is further, because
 * the cartridge's own sample has a model whose counts are 0 over eight
 * stored vertices; re-encoding what comes back reproduces the bytes.
 */
export function decodeModel(bytes, at = 0) {
    needBytes("model", bytes, at, MODEL_BYTES);
    const vertexCount = bytes[at];
    const faceCount = bytes[at + 1];
    let nv = MODEL_MAX_VERTICES;
    while (nv > vertexCount && isZero(bytes, at + MODEL_OFFSETS.vertices + (nv - 1) * VERTEX_BYTES, VERTEX_BYTES)) nv--;
    let nf = MODEL_MAX_FACES;
    while (nf > faceCount && isZero(bytes, at + MODEL_OFFSETS.faces + (nf - 1) * FACE_BYTES, FACE_BYTES)) nf--;
    return {
        vertexCount,
        faceCount,
        vertices: fill(nv, () => null).map((_, i) => {
            const p = at + MODEL_OFFSETS.vertices + i * VERTEX_BYTES;
            return { x: s16(bytes, p), y: s16(bytes, p + 2), z: s16(bytes, p + 4) };
        }),
        faces: fill(nf, () => null).map((_, i) => decodeFace(bytes, at + MODEL_OFFSETS.faces + i * FACE_BYTES)),
        unknownA2A: u16(bytes, at + MODEL_OFFSETS.unknownA2A),
        tiles: fill(MODEL_TILES, () => null).map((_, i) => decodeTile(bytes, at + MODEL_OFFSETS.tiles + i * MODEL_TILE_BYTES)),
        hScale: fill(MODEL_TILES, () => 0).map((_, i) => u16(bytes, at + MODEL_OFFSETS.hScale + i * 2)),
        vScale: fill(MODEL_TILES, () => 0).map((_, i) => u16(bytes, at + MODEL_OFFSETS.vScale + i * 2)),
        groups: fill(MODEL_MAX_VERTICES, () => 0).map((_, i) => s8(bytes, at + MODEL_OFFSETS.groups + i)),
        light: bytes[at + MODEL_OFFSETS.light],
        unknownC11: bytes.slice(at + MODEL_OFFSETS.unknownC11, at + MODEL_BYTES),
    };
}

export const MD_MODEL_COUNT = 130;
export const CMD_MODEL_COUNT = 20;
export const ULB_MODEL_COUNT = 8;
export const ULB_TEXTURE_COUNT = 8;

/** Where the texture index tables, or ULB's textures, start. */
export const MD_TEXTURE_INDEX_OFFSET = MD_MODEL_COUNT * MODEL_BYTES; // 0x62840
export const CMD_TEXTURE_INDEX_OFFSET = CMD_MODEL_COUNT * MODEL_BYTES; // 0xF280
export const ULB_TEXTURES_OFFSET = ULB_MODEL_COUNT * MODEL_BYTES; // 0x6100

/**
 * `count` model slots then `count` u16 texture indices. A slot given null
 * (or not given) is left zero, which is what the cartridge's empty slots
 * hold — not encodeModel({}), whose blank tiles would mark it used.
 */
function buildModelFile(label, models, textureIndices, count, size) {
    if (!Array.isArray(models)) throw new Error(`${label} models are a list`);
    if (!Array.isArray(textureIndices)) throw new Error(`${label} texture indices are a list`);
    if (models.length > count) throw new Error(`${label} holds ${count} models; ${models.length} were given`);
    if (textureIndices.length > count) throw new Error(`${label} holds ${count} texture indices; ${textureIndices.length} were given`);
    const out = new Uint8Array(size);
    models.forEach((m, i) => {
        if (m !== null && m !== undefined) out.set(encodeModel(m, `${label} models[${i}]`), i * MODEL_BYTES);
    });
    textureIndices.forEach((t, i) => putU16(out, count * MODEL_BYTES + i * 2, `${label} textureIndices[${i}]`, t ?? 0));
    return out;
}

function parseModelFile(label, bytes, count, size) {
    needBytes(label, bytes, 0, size);
    return {
        models: fill(count, () => null).map((_, i) => (isZero(bytes, i * MODEL_BYTES, MODEL_BYTES) ? null : decodeModel(bytes, i * MODEL_BYTES))),
        textureIndices: fill(count, () => 0).map((_, i) => u16(bytes, count * MODEL_BYTES + i * 2)),
    };
}

/** 130 models + 130 texture indices -> the 0x62944-byte #MD. */
export function buildMdFile(models = [], textureIndices = []) {
    return buildModelFile("#MD", models, textureIndices, MD_MODEL_COUNT, DOCUMENTED_SIZES.MD);
}

/** A #MD -> {models[130] (null for an empty slot), textureIndices[130]}. */
export function parseMdFile(bytes) {
    return parseModelFile("#MD", bytes, MD_MODEL_COUNT, DOCUMENTED_SIZES.MD);
}

/** 20 models + 20 texture indices -> the 0xF2A8-byte disk-mode CMD. */
export function buildCmdFile(models = [], textureIndices = []) {
    return buildModelFile("CMD", models, textureIndices, CMD_MODEL_COUNT, DOCUMENTED_SIZES.CMD);
}

/** A disk-mode CMD -> {models[20], textureIndices[20]}. */
export function parseCmdFile(bytes) {
    return parseModelFile("CMD", bytes, CMD_MODEL_COUNT, DOCUMENTED_SIZES.CMD);
}

/**
 * 8 models + 8 textures (each a 64x32 RGBA5551 tile of 0x1000 bytes, as
 * graphics.js reads them; null for a blank one) -> the 0xE100-byte ULB.
 */
export function buildUlbFile(models = [], textures = []) {
    if (!Array.isArray(textures)) throw new Error("ULB textures are a list");
    if (textures.length > ULB_TEXTURE_COUNT) throw new Error(`ULB holds ${ULB_TEXTURE_COUNT} textures; ${textures.length} were given`);
    const out = buildModelFile("ULB", models, [], ULB_MODEL_COUNT, DOCUMENTED_SIZES.ULB);
    textures.forEach((t, i) => {
        if (t === null || t === undefined) return;
        if (!(t instanceof Uint8Array) || t.length !== TILE_BYTES) throw new Error(`ULB textures[${i}] is a ${TILE_BYTES}-byte texture`);
        out.set(t, ULB_TEXTURES_OFFSET + i * TILE_BYTES);
    });
    return out;
}

/** A ULB -> {models[8] (null for an empty slot), textures[8] (Uint8Array each)}. */
export function parseUlbFile(bytes) {
    needBytes("ULB", bytes, 0, DOCUMENTED_SIZES.ULB);
    return {
        models: fill(ULB_MODEL_COUNT, () => null).map((_, i) => (isZero(bytes, i * MODEL_BYTES, MODEL_BYTES) ? null : decodeModel(bytes, i * MODEL_BYTES))),
        textures: fill(ULB_TEXTURE_COUNT, () => null).map((_, i) => bytes.slice(ULB_TEXTURES_OFFSET + i * TILE_BYTES, ULB_TEXTURES_OFFSET + (i + 1) * TILE_BYTES)),
    };
}

/**
 * A flat quad that shows one tile of a 64x32 texture the way the game draws
 * a sprite: four vertices lying in the XZ plane (the ground's, y = 0),
 * `width` model units across x and `height` along z about the origin, two
 * faces wound to face up, with UVs over the tile's pixel box set so the
 * texture's top row is the far edge (-z) and its left column -x — upright
 * and unmirrored to the player. The texturing byte names `tile`; textured,
 * unmasked. All booted 2026-10-21 (FORMAT-N64.md "A model's texture"): UVs
 * are texels, a tile is 1 << (width power + 1) by 1 << (height power - 1),
 * a quad in XY is edge-on and draws nothing, and the other winding is
 * culled. The sample models' textured faces name tiles 1..9 and leave tile 0
 * at the editor's blank, so a caller matching them passes tile: 1.
 *
 * @param {{width?: number, height?: number, tileWidthPower?: number, tileHeightPower?: number,
 *          tileOffset?: number, tile?: number, light?: number}} [options]
 * @returns {object}  a model record for encodeModel()
 */
export function billboardModel({ width = 64, height = 32, tileWidthPower = 5, tileHeightPower = 6, tileOffset = 0, tile = 0, light = 0 } = {}) {
    check("billboard.width", width, 1, 0x7fff);
    check("billboard.height", height, 1, 0x7fff);
    check("billboard.tile", tile, 0, MODEL_TILES - 1);
    const u = tilePixels(tileWidthPower);
    const v = tileHeightPixels(tileHeightPower);
    const x0 = -(width >> 1), x1 = width - (width >> 1);
    const zFar = -(height >> 1), zNear = height - (height >> 1);
    const tiles = fill(MODEL_TILES, tileDefaults);
    tiles[tile] = { offset: tileOffset, mirrorV: false, widthPower: tileWidthPower, mirrorH: false, heightPower: tileHeightPower };
    const face = (vertices, uv) => ({ ...faceDefaults(), vertices, uv, tile });
    return {
        // near-left, near-right, far-right, far-left
        vertices: [{ x: x0, y: 0, z: zNear }, { x: x1, y: 0, z: zNear }, { x: x1, y: 0, z: zFar }, { x: x0, y: 0, z: zFar }],
        faces: [face([0, 1, 2], [[0, v], [u, v], [u, 0]]), face([0, 2, 3], [[0, v], [u, 0], [0, 0]])],
        tiles,
        light,
    };
}

// --- GAM: the global game settings ---------------------------------------------------------

export const GAM_HIGH_SCORES_BYTES = 0xa0;
export const GAM_PALETTE_BYTES = 0x200;
export const GAM_LIGHTS = 30;

/** The 46 sprites whose upper-left x (0x16C..) and y (0x1C8..) the GAM tables hold, in table order. */
export const GAM_SPRITES = Object.freeze([
    "playerShot",
    "playerSplash",
    "playerLaser",
    "enemyLaser1",
    "enemyShot1Frame1",
    "enemyShot1Frame2",
    "enemyShot1Frame3",
    "enemyShot1Frame4",
    "playerLaserFlash",
    "enemyLaser1Flash",
    "enemyLaser2",
    "playerBomb",
    "enemyShot2Frame1",
    "enemyShot2Frame2",
    "enemyShot2Frame3",
    "enemyShot2Frame4",
    "blastParticleFrame1",
    "blastParticleFrame2",
    "blastParticleFrame3",
    "blastParticleFrame4",
    "playerDustFrame1",
    "playerDustFrame2",
    "playerDustFrame3",
    "playerDustFrame4",
    "playerMuzzleFlashFrame1",
    "playerMuzzleFlashFrame2",
    "playerMuzzleFlashFrame3",
    "playerMuzzleFlashFrame4",
    "playerMark",
    "playerSight",
    "playerSightClosed",
    "blast1Frame1",
    "blast1Frame2",
    "blast1Frame3",
    "blast1Frame4",
    "blast1Frame5",
    "blast1Frame6",
    "blast2Frame1",
    "blast2Frame2",
    "blast2Frame3",
    "blast2Frame4",
    "blast2Frame5",
    "blast2Frame6",
    "playerStockShip",
    "playerStockBomb",
    "playerBoost",
]);

/** The font colour byte's names. */
export const GAM_FONT_COLORS = Object.freeze(["gray", "green", "purple", "orange", "magenta", "blue", "yellow", "red"]);

/** The 26 light positions a light byte can name (0..0x19); models and GAM share them. */
export const GAM_LIGHT_POSITIONS = Object.freeze([
    "topDownRightFront",
    "topDownRightSide",
    "topDownRightRear",
    "topDownFront",
    "topDown",
    "topDownBack",
    "topDownLeftFront",
    "topDownLeftSide",
    "topDownLeftRear",
    "middleRightFront",
    "middleRightSide",
    "middleRightRear",
    "middleFront",
    "middleBack",
    "middleLeftFront",
    "middleLeftSide",
    "middleLeftRear",
    "bottomUpRightFront",
    "bottomUpRightSide",
    "bottomUpRightRear",
    "bottomUpFront",
    "bottomUp",
    "bottomUpBack",
    "bottomUpLeftFront",
    "bottomUpLeftSide",
    "bottomUpLeftRear",
]);

/** Where each field of a GAM starts; the vibration block is at 0x224, see the header. */
export const GAM_OFFSETS = Object.freeze({
    finalStage: 0x0,
    unknown01: 0x1,
    fontFace: 0x2,
    fontColor: 0x3,
    timeAttackStage: 0x4,
    timeAttackLimit: 0x5,
    highScores1: 0x6,
    item1Score: 0xa6,
    item2Score: 0xa7,
    unknownA8: 0xa8,
    loadout: 0xb2,
    initialAltitude: 0xb3,
    highScores2: 0xb4,
    playerScale: 0x154,
    shieldScale: 0x156,
    playerFrameSpeed: 0x158,
    shieldFrameSpeed: 0x159,
    playerModels: 0x15a,
    shieldModels: 0x15e,
    playerTransparency: 0x162,
    shieldTransparency: 0x163,
    spriteX: 0x16c,
    spriteY: 0x1c8,
    vibration: 0x224,
    title1Settings: 0x22e,
    title2Settings: 0x230,
    title1Y: 0x232,
    title2Y: 0x234,
    ending: 0x236,
    lightPositions: 0x239,
    lightColors: 0x257,
    modelToolBackground: 0x30b,
    layoutBackground: 0x30e,
    palette: 0x311,
    titleBackgroundTexture: 0x511,
    commonModelIndices: 0x513,
    commonTextureIndices: 0x527,
    bgm: 0x553,
    unknown557: 0x557,
    unknown558: 0x558,
});

const LOADOUT = [
    { name: "shotPower", mask: 0xc0, max: 2 },
    { name: "laserPower", mask: 0x30, max: 2 },
    { name: "bombs", mask: 0x03 },
    { name: "unknownBits", mask: 0x0c },
];
const TITLE_SETTINGS = [
    { name: "wave", mask: 0x6000 },
    { name: "blink", mask: 0x1000, bool: true },
    { name: "transparency", mask: 0x0c00 },
    { name: "inTop", mask: 0x0040, bool: true },
    { name: "inBottom", mask: 0x0080, bool: true },
    { name: "inLeft", mask: 0x0100, bool: true },
    { name: "inRight", mask: 0x0200, bool: true },
    { name: "width", mask: 0x0030, max: 2 },
    { name: "height", mask: 0x000c, max: 2 },
    { name: "roll", mask: 0x0003, max: 2 },
    { name: "unknownBits", mask: 0x8000 },
];

/**
 * A high-score block as the cartridge's initial game lays it out: ten
 * 16-byte entries of name[8] (eight '.' to begin with), four zero bytes,
 * then a u32 score, 10,000 down to 1,000. The document gives the block's
 * size only, so this is read off the save. (likely)
 */
export function defaultHighScores() {
    const out = new Uint8Array(GAM_HIGH_SCORES_BYTES);
    for (let i = 0; i < 10; i++) {
        out.fill(0x2e, i * 16, i * 16 + 8);
        putU32(out, i * 16 + 12, "score", 10000 - i * 1000);
    }
    return out;
}

// The cartridge's initial Paint Tool palette: 256 RGBA5551 words. Read off
// the save; the game writes it into every new GAM.
const DEFAULT_PALETTE_HEX =
    "0000f801fa81ffc107c107ff003f502b" + "e327fde9f7e1a7ebb4fff7bd84210843" +
    "00031087210b318f4213529763" + "1b739f8423" + "94a7a52bb5afc633d6b7e73bffff" +
    "f469fde3fea3ffe3dfa3b7279f2f9739" + "8eff963b9df9ad35d535dcf3f471f46d" +
    "637d73fd8cbda53db5bdc63dd6bdef7f" + "fc87fccdfd13fd99fde1fe67feadff35" +
    "f801f909fa11fb19fc21fd29fe31ff39" + "fa81fb09fbd1fc99fd61fe29fef1ffb9" +
    "f781f787f78ff797f79df7a5f7adfff5" + "0541258945d166598ea3af2bcf73f7fd" +
    "014b02d7056b07ff3fff7fffb7fff7ff" + "003f213f423f6b7f8c7fb5bfd6bfffff" +
    "502b612d7a2f9333a435bd39d63bef3f" + "502b606978e98969a1a7b227caa7e327" +
    "280151077a0da313d45bdd21ede7feef" + "620d728f8b539bd7b499c51ddde1f6a5" +
    "600180c1a981ca41f301f445f58bf711" + "f801f901fa01fb41fc41fd81fe81ffc1" +
    "ffc1d7c1b7c18fc16fc147c127c107c1" + "07c707cf07d707df07e707ef07f707ff" +
    "06ff05ff04ff03ff02ff01ff00ff003f" + "083b1039183728353031382f402d502b" +
    "6025702188" + "1d98" + "17a813c00fd009e005fb" + "41fbc3fc87fd0bfdcdfe51ff15ffd9" +
    "10013001500170019001b001d001f801" + "10013041" + "50c1710191" + "41b1c1d201fa81" +
    "1081314152417341" + "9c41bd41de41ff01" + "00810141020102c1038104" + "0104c10581" +
    "00030" + "00b0015001d0025002d0035003f" + "100b180f20132819301d382140255" + "02b";

function hexBytes(hex, n) {
    if (hex.length !== n * 2) throw new Error(`a ${n}-byte constant has ${hex.length / 2} bytes`);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const DEFAULT_SPRITE_X = [
    0, 16, 32, 32, 64, 80, 96, 112, 0, 16, 32, 48, 64, 80, 96, 112, 0, 16, 32, 48, 64, 80, 96, 112,
    0, 16, 32, 48, 64, 80, 96, 0, 32, 64, 96, 0, 32, 64, 96, 0, 32, 64, 96, 0, 16, 16,
];
const DEFAULT_SPRITE_Y = [
    0x1c0, 0x1c0, 0x1c0, 0x1c8, 0x1c0, 0x1c0, 0x1c0, 0x1c0, 0x1d0, 0x1d0, 0x1d0, 0x1d0, 0x1d0, 0x1d0, 0x1d0, 0x1d0,
    0x1e0, 0x1e0, 0x1e0, 0x1e0, 0x1e0, 0x1e0, 0x1e0, 0x1e0, 0x1f0, 0x1f0, 0x1f0, 0x1f0, 0x1f0, 0x1f0, 0x1f0,
    0x200, 0x200, 0x200, 0x200, 0x220, 0x220, 0x220, 0x220, 0x240, 0x240, 0x240, 0x240, 0x260, 0x260, 0x1d0,
];
const DEFAULT_LIGHT_POSITIONS = [0, 0, 0x13, 0x19, 0x19, 0, 0x13, 8, 0x10, 8, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const DEFAULT_LIGHT_COLORS = [
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xf8, 0xc0, 0x40], [0x45, 0x1c, 0x08]],
    [[0xf8, 0xa8, 0x38], [0x7b, 0x43, 0x17]],
    [[0xf0, 0xf8, 0xf8], [0x5d, 0x50, 0x83]],
    [[0xf8, 0x90, 0x68], [0x35, 0x1d, 0x0a]],
    [[0xf8, 0xa8, 0x70], [0x4c, 0x36, 0x16]],
    [[0xf8, 0xb8, 0x80], [0x2c, 0x2e, 0x21]],
    [[0xd8, 0xd8, 0xf8], [0x18, 0x18, 0x28]],
    [[0xf0, 0xf0, 0xf8], [0x18, 0x18, 0x48]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xdf, 0xdf, 0xff], [0x18, 0x18, 0x28]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
    [[0xff, 0xff, 0xff], [0x40, 0x40, 0x40]],
];

function transparencyDefaults(final) {
    return { enabled: false, initial: 0, final, speed: -1, loopType: 0 };
}

function titleDefaults(word, y) {
    return { ...unpack(TITLE_SETTINGS, word), y };
}

/**
 * The initial game the cartridge writes into a new GAM, field for field:
 * final stage 2, font colour magenta, time attack from stage 1, the two
 * score tables, a player ship of model 10 at scale 66 with a shield of
 * model 7 at 89 (frames 5 5 5), the sprite tables, the two title words
 * (0x2115, 0x3A16) over a title picture at y 0x3A0, an ending of textures
 * 29..41, sixteen lit light positions, a dark blue Model Tool, the palette,
 * the common model and texture tables, and BGM 37 / 28 / 40 / 11.
 */
export function gamDefaults() {
    const commonModels = new Uint8Array(0x14);
    [660, 661, 662, 663, 664, 665, 666, 667, 668, 270].forEach((v, i) => putU16(commonModels, i * 2, "model", v));
    const commonTextures = new Uint8Array(0x2c);
    [628, 629, 630, 631, 632, 633, 634, 635, 636, 560, 638, 639, 640, 641, 0x27f2, 643, 644, 645, 646, 647, 648, 649]
        .forEach((v, i) => putU16(commonTextures, i * 2, "texture", v));
    return {
        finalStage: 2,
        unknown01: 0,
        fontFace: 0,
        fontColor: 4,
        timeAttackStage: 1,
        timeAttackLimit: 0,
        highScores1: defaultHighScores(),
        item1Score: 1,
        item2Score: 2,
        unknownA8: new Uint8Array(10),
        loadout: { shotPower: 0, laserPower: 0, bombs: 0, unknownBits: 0 },
        initialAltitude: 9,
        highScores2: defaultHighScores(),
        player: { scale: 66, frameSpeed: -1, models: [10, 0, 0, 0], transparency: transparencyDefaults(0) },
        shield: { scale: 89, frameSpeed: -1, models: [7, 5, 5, 5], transparency: transparencyDefaults(3) },
        spriteX: DEFAULT_SPRITE_X.slice(),
        spriteY: DEFAULT_SPRITE_Y.slice(),
        vibration: { death: 4, bomb: 4, blast1: [0, 0, 0, 0], blast2: [0, 0, 0, 0] },
        title1: titleDefaults(0x2115, 0x3a0),
        title2: titleDefaults(0x3a16, 0x3a0),
        ending: { type: 0, startTexture: 29, endTexture: 41 },
        lightPositions: DEFAULT_LIGHT_POSITIONS.slice(),
        lightColors: fill(GAM_LIGHTS, () => null).map((_, i) => {
            const c = DEFAULT_LIGHT_COLORS[i];
            return c ? { directional: c[0].slice(), ambient: c[1].slice() } : { directional: [0, 0, 0], ambient: [0, 0, 0] };
        }),
        modelToolBackground: [0x00, 0x00, 0xb0],
        layoutBackground: [0x03, 0x03, 0x06],
        palette: hexBytes(DEFAULT_PALETTE_HEX, GAM_PALETTE_BYTES),
        titleBackgroundTexture: 20,
        commonModelIndices: commonModels,
        commonTextureIndices: commonTextures,
        bgm: { title: 37, ending: 28, gameOver: 40, stageClear: 11 },
        unknown557: 0x2e,
        unknown558: 0x2e,
    };
}

function putTransparency(b, at, label, t) {
    // the player's and the shield's bytes interleave: enabled at `at`, then
    // initial, final, speed and loop type each two bytes on
    b[at] = check(`${label}.enabled`, t.enabled, 0, 1);
    putU8(b, at + 2, `${label}.initial`, check(`${label}.initial`, t.initial, 0, 7));
    putU8(b, at + 4, `${label}.final`, check(`${label}.final`, t.final, 0, 7));
    putS8(b, at + 6, `${label}.speed`, check(`${label}.speed`, t.speed, -1, 7));
    putU8(b, at + 8, `${label}.loopType`, check(`${label}.loopType`, t.loopType, 0, 3));
}

/**
 * Global game settings -> the 0x559-byte GAM. See gamDefaults() for the
 * shape; `missing`, which decodeGam() adds, is ignored.
 * @returns {Uint8Array}
 */
export function encodeGam(gam = {}) {
    const { missing: _missing, ...given } = gam ?? {};
    const g = merge("gam", gamDefaults(), given);
    const b = new Uint8Array(DOCUMENTED_SIZES.GAM);
    const o = GAM_OFFSETS;
    putU8(b, o.finalStage, "gam.finalStage", g.finalStage);
    putU8(b, o.unknown01, "gam.unknown01", g.unknown01);
    putU8(b, o.fontFace, "gam.fontFace", check("gam.fontFace", g.fontFace, 0, 5));
    putU8(b, o.fontColor, "gam.fontColor", check("gam.fontColor", g.fontColor, 0, 7));
    putU8(b, o.timeAttackStage, "gam.timeAttackStage", g.timeAttackStage);
    putU8(b, o.timeAttackLimit, "gam.timeAttackLimit", g.timeAttackLimit);
    b.set(g.highScores1, o.highScores1);
    putU8(b, o.item1Score, "gam.item1Score", check("gam.item1Score", g.item1Score, 0, 7));
    putU8(b, o.item2Score, "gam.item2Score", check("gam.item2Score", g.item2Score, 0, 7));
    b.set(g.unknownA8, o.unknownA8);
    b[o.loadout] = pack("gam.loadout", LOADOUT, g.loadout);
    // the document says 0..8; the cartridge's own initial value is 9
    putU8(b, o.initialAltitude, "gam.initialAltitude", check("gam.initialAltitude", g.initialAltitude, 0, 10));
    b.set(g.highScores2, o.highScores2);
    putU16(b, o.playerScale, "gam.player.scale", g.player.scale);
    putU16(b, o.shieldScale, "gam.shield.scale", g.shield.scale);
    putS8(b, o.playerFrameSpeed, "gam.player.frameSpeed", check("gam.player.frameSpeed", g.player.frameSpeed, -1, 7));
    putS8(b, o.shieldFrameSpeed, "gam.shield.frameSpeed", check("gam.shield.frameSpeed", g.shield.frameSpeed, -1, 7));
    g.player.models.forEach((m, i) => putU8(b, o.playerModels + i, `gam.player.models[${i}]`, m));
    g.shield.models.forEach((m, i) => putU8(b, o.shieldModels + i, `gam.shield.models[${i}]`, m));
    putTransparency(b, o.playerTransparency, "gam.player.transparency", g.player.transparency);
    putTransparency(b, o.shieldTransparency, "gam.shield.transparency", g.shield.transparency);
    g.spriteX.forEach((v, i) => putU16(b, o.spriteX + i * 2, `gam.spriteX[${i}] (${GAM_SPRITES[i]})`, v));
    g.spriteY.forEach((v, i) => putU16(b, o.spriteY + i * 2, `gam.spriteY[${i}] (${GAM_SPRITES[i]})`, v));
    putU8(b, o.vibration, "gam.vibration.death", g.vibration.death);
    putU8(b, o.vibration + 1, "gam.vibration.bomb", g.vibration.bomb);
    g.vibration.blast1.forEach((v, i) => putU8(b, o.vibration + 2 + i, `gam.vibration.blast1[${i}]`, v));
    g.vibration.blast2.forEach((v, i) => putU8(b, o.vibration + 6 + i, `gam.vibration.blast2[${i}]`, v));
    putU16(b, o.title1Settings, "gam.title1", pack("gam.title1", TITLE_SETTINGS, g.title1));
    putU16(b, o.title2Settings, "gam.title2", pack("gam.title2", TITLE_SETTINGS, g.title2));
    putU16(b, o.title1Y, "gam.title1.y", g.title1.y);
    putU16(b, o.title2Y, "gam.title2.y", g.title2.y);
    putU8(b, o.ending, "gam.ending.type", check("gam.ending.type", g.ending.type, 0, 1));
    putU8(b, o.ending + 1, "gam.ending.startTexture", g.ending.startTexture);
    putU8(b, o.ending + 2, "gam.ending.endTexture", g.ending.endTexture);
    g.lightPositions.forEach((v, i) => putU8(b, o.lightPositions + i, `gam.lightPositions[${i}]`, check(`gam.lightPositions[${i}]`, v, 0, GAM_LIGHT_POSITIONS.length - 1)));
    g.lightColors.forEach((c, i) => {
        c.directional.forEach((v, k) => putU8(b, o.lightColors + i * 6 + k, `gam.lightColors[${i}].directional[${k}]`, v));
        c.ambient.forEach((v, k) => putU8(b, o.lightColors + i * 6 + 3 + k, `gam.lightColors[${i}].ambient[${k}]`, v));
    });
    g.modelToolBackground.forEach((v, k) => putU8(b, o.modelToolBackground + k, `gam.modelToolBackground[${k}]`, v));
    g.layoutBackground.forEach((v, k) => putU8(b, o.layoutBackground + k, `gam.layoutBackground[${k}]`, v));
    b.set(g.palette, o.palette);
    putS16(b, o.titleBackgroundTexture, "gam.titleBackgroundTexture", g.titleBackgroundTexture);
    b.set(g.commonModelIndices, o.commonModelIndices);
    b.set(g.commonTextureIndices, o.commonTextureIndices);
    putS8(b, o.bgm, "gam.bgm.title", g.bgm.title);
    putS8(b, o.bgm + 1, "gam.bgm.ending", g.bgm.ending);
    putS8(b, o.bgm + 2, "gam.bgm.gameOver", g.bgm.gameOver);
    putS8(b, o.bgm + 3, "gam.bgm.stageClear", g.bgm.stageClear);
    putU8(b, o.unknown557, "gam.unknown557", g.unknown557);
    putU8(b, o.unknown558, "gam.unknown558", g.unknown558);
    return b;
}

/**
 * A GAM -> its settings, the shape of gamDefaults() plus `missing`: the
 * names of the fields a short buffer did not reach, which read as null.
 * Never throws for length — the prototype disk's own GAM files are 1,360
 * bytes, nine short, and the translation notes their format differs — so a
 * caller sees what is there and what is not.
 * @param {Uint8Array} bytes
 */
export function decodeGam(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error("GAM: bytes are a Uint8Array");
    const missing = [];
    const o = GAM_OFFSETS;
    const has = (name, at, n) => {
        if (at + n <= bytes.length) return true;
        missing.push(name);
        return false;
    };
    const U8 = (name, at) => (has(name, at, 1) ? bytes[at] : null);
    const S8 = (name, at) => (has(name, at, 1) ? s8(bytes, at) : null);
    const U16 = (name, at) => (has(name, at, 2) ? u16(bytes, at) : null);
    const S16 = (name, at) => (has(name, at, 2) ? s16(bytes, at) : null);
    const raw = (name, at, n) => (has(name, at, n) ? bytes.slice(at, at + n) : null);
    const list = (name, at, n, stride, read) => (has(name, at, n * stride) ? fill(n, () => 0).map((_, i) => read(at + i * stride)) : null);
    const packed = (name, fields, at, width) => (has(name, at, width) ? unpack(fields, width === 2 ? u16(bytes, at) : bytes[at]) : null);
    const transparency = (name, at) => (has(name, at, 9)
        ? { enabled: bytes[at] !== 0, initial: bytes[at + 2], final: bytes[at + 4], speed: s8(bytes, at + 6), loopType: bytes[at + 8] }
        : null);
    const title = (name, at, yAt) => {
        const w = packed(name, TITLE_SETTINGS, at, 2);
        const y = U16(`${name}.y`, yAt);
        return w ? { ...w, y } : null;
    };
    const rgb = (name, at) => (has(name, at, 3) ? [bytes[at], bytes[at + 1], bytes[at + 2]] : null);
    return {
        finalStage: U8("finalStage", o.finalStage),
        unknown01: U8("unknown01", o.unknown01),
        fontFace: U8("fontFace", o.fontFace),
        fontColor: U8("fontColor", o.fontColor),
        timeAttackStage: U8("timeAttackStage", o.timeAttackStage),
        timeAttackLimit: U8("timeAttackLimit", o.timeAttackLimit),
        highScores1: raw("highScores1", o.highScores1, GAM_HIGH_SCORES_BYTES),
        item1Score: U8("item1Score", o.item1Score),
        item2Score: U8("item2Score", o.item2Score),
        unknownA8: raw("unknownA8", o.unknownA8, 10),
        loadout: packed("loadout", LOADOUT, o.loadout, 1),
        initialAltitude: U8("initialAltitude", o.initialAltitude),
        highScores2: raw("highScores2", o.highScores2, GAM_HIGH_SCORES_BYTES),
        player: {
            scale: U16("player.scale", o.playerScale),
            frameSpeed: S8("player.frameSpeed", o.playerFrameSpeed),
            models: list("player.models", o.playerModels, 4, 1, (at) => bytes[at]),
            transparency: transparency("player.transparency", o.playerTransparency),
        },
        shield: {
            scale: U16("shield.scale", o.shieldScale),
            frameSpeed: S8("shield.frameSpeed", o.shieldFrameSpeed),
            models: list("shield.models", o.shieldModels, 4, 1, (at) => bytes[at]),
            transparency: transparency("shield.transparency", o.shieldTransparency),
        },
        spriteX: list("spriteX", o.spriteX, GAM_SPRITES.length, 2, (at) => u16(bytes, at)),
        spriteY: list("spriteY", o.spriteY, GAM_SPRITES.length, 2, (at) => u16(bytes, at)),
        vibration: has("vibration", o.vibration, 10)
            ? {
                death: bytes[o.vibration],
                bomb: bytes[o.vibration + 1],
                blast1: [0, 1, 2, 3].map((i) => bytes[o.vibration + 2 + i]),
                blast2: [0, 1, 2, 3].map((i) => bytes[o.vibration + 6 + i]),
            }
            : null,
        title1: title("title1", o.title1Settings, o.title1Y),
        title2: title("title2", o.title2Settings, o.title2Y),
        ending: has("ending", o.ending, 3) ? { type: bytes[o.ending], startTexture: bytes[o.ending + 1], endTexture: bytes[o.ending + 2] } : null,
        lightPositions: list("lightPositions", o.lightPositions, GAM_LIGHTS, 1, (at) => bytes[at]),
        lightColors: list("lightColors", o.lightColors, GAM_LIGHTS, 6, (at) => ({
            directional: [bytes[at], bytes[at + 1], bytes[at + 2]],
            ambient: [bytes[at + 3], bytes[at + 4], bytes[at + 5]],
        })),
        modelToolBackground: rgb("modelToolBackground", o.modelToolBackground),
        layoutBackground: rgb("layoutBackground", o.layoutBackground),
        palette: raw("palette", o.palette, GAM_PALETTE_BYTES),
        titleBackgroundTexture: S16("titleBackgroundTexture", o.titleBackgroundTexture),
        commonModelIndices: raw("commonModelIndices", o.commonModelIndices, 0x14),
        commonTextureIndices: raw("commonTextureIndices", o.commonTextureIndices, 0x2c),
        bgm: {
            title: S8("bgm.title", o.bgm),
            ending: S8("bgm.ending", o.bgm + 1),
            gameOver: S8("bgm.gameOver", o.bgm + 2),
            stageClear: S8("bgm.stageClear", o.bgm + 3),
        },
        unknown557: U8("unknown557", o.unknown557),
        unknown558: U8("unknown558", o.unknown558),
        missing,
    };
}

// --- MUS: 24 songs of 0x2C9A --------------------------------------------------------------

export const SONG_BYTES = 0x2c9a;
export const SONG_HEADER_BYTES = 0x1a;
export const SONG_COUNT = 24;

/** A song is 32 blocks; each has a 0x84-byte score block and a 0xE0-byte accompaniment block. */
export const SONG_BLOCKS = 0x20;
export const SCORE_BLOCK_BYTES = 0x84;
export const SCORE_BYTES = SONG_BLOCKS * SCORE_BLOCK_BYTES; // 0x1080
export const ACCOMPANIMENT_BLOCK_BYTES = 0xe0;
export const ACCOMPANIMENT_BYTES = SONG_BLOCKS * ACCOMPANIMENT_BLOCK_BYTES; // 0x1C00
export const SCORE_OFFSET = SONG_HEADER_BYTES; // 0x1A
export const ACCOMPANIMENT_OFFSET = SONG_HEADER_BYTES + SCORE_BYTES; // 0x109A

/** The tempo byte indexes this table (the document says 0..0x20; the table it prints has 32 entries). */
export const MUS_TEMPO_TABLE = Object.freeze([
    0x42, 0x3c, 0x39, 0x36, 0x34, 0x31, 0x2f, 0x2d, 0x2b, 0x2a, 0x28, 0x27, 0x26, 0x24, 0x23, 0x22,
    0x21, 0x20, 0x1f, 0x1e, 0x1d, 0x1c, 0x1b, 0x1a, 0x19, 0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12,
]);

/** The echo byte indexes this table. */
export const MUS_ECHO_TABLE = Object.freeze([0x00, 0x14, 0x1e, 0x23, 0x28, 0x2d, 0x32, 0x40]);

/** Pitch bytes: 0 is silence (and stops the prior note), 0x37..0x60 are G3..C7, 0x80 ties. */
export const PITCH_SILENCE = 0x00;
export const PITCH_LOWEST = 0x37;
export const PITCH_MIDDLE_C = 0x3c;
export const PITCH_HIGHEST = 0x60;
export const PITCH_TIE = 0x80;

/** Pan byte for centre. */
export const PAN_CENTER = 0x40;

/** The instrument the blank song's three drum lines carry: the yellow drumkit. */
export const INSTRUMENT_YELLOW_DRUMKIT = 0x32;

const TRACK_VOLUME = [
    { name: "muted", mask: 0x80, bool: true },
    { name: "volume", mask: 0x7f },
];

/** The cartridge's blank song header: tempo index 0x10, echo 2, 32 blocks, every volume 0x5A, every pan centred. */
export function songHeaderDefaults() {
    return {
        tempo: 0x10,
        echo: 2,
        loopStart: 0,
        length: SONG_BLOCKS - 1,
        tracks: fill(4, () => ({ volume: 0x5a, muted: false })),
        instrumentVolumes: fill(7, 0x5a),
        trackPans: fill(4, PAN_CENTER),
        instrumentPans: fill(7, PAN_CENTER),
    };
}

export function encodeSongHeader(header = {}, label = "song") {
    const h = merge(label, songHeaderDefaults(), header);
    const b = new Uint8Array(SONG_HEADER_BYTES);
    putU8(b, 0x0, `${label}.tempo`, check(`${label}.tempo`, h.tempo, 0, 0x20));
    putU8(b, 0x1, `${label}.echo`, check(`${label}.echo`, h.echo, 0, MUS_ECHO_TABLE.length - 1));
    putU8(b, 0x2, `${label}.loopStart`, check(`${label}.loopStart`, h.loopStart, 0, SONG_BLOCKS - 1));
    putU8(b, 0x3, `${label}.length`, check(`${label}.length`, h.length, 0, SONG_BLOCKS - 1));
    h.tracks.forEach((t, i) => {
        b[0x4 + i] = pack(`${label}.tracks[${i}]`, TRACK_VOLUME, t);
    });
    h.instrumentVolumes.forEach((v, i) => putU8(b, 0x8 + i, `${label}.instrumentVolumes[${i}]`, v));
    h.trackPans.forEach((v, i) => putU8(b, 0xf + i, `${label}.trackPans[${i}]`, v));
    h.instrumentPans.forEach((v, i) => putU8(b, 0x13 + i, `${label}.instrumentPans[${i}]`, v));
    return b;
}

export function decodeSongHeader(bytes, at = 0) {
    needBytes("song header", bytes, at, SONG_HEADER_BYTES);
    return {
        tempo: bytes[at],
        echo: bytes[at + 1],
        loopStart: bytes[at + 2],
        length: bytes[at + 3],
        tracks: [0, 1, 2, 3].map((i) => unpack(TRACK_VOLUME, bytes[at + 4 + i])),
        instrumentVolumes: fill(7, 0).map((_, i) => bytes[at + 8 + i]),
        trackPans: fill(4, 0).map((_, i) => bytes[at + 0xf + i]),
        instrumentPans: fill(7, 0).map((_, i) => bytes[at + 0x13 + i]),
    };
}

/**
 * The 32 score blocks of a song with nothing in them: each is the four
 * accompaniment bytes FF 00 01 00 (automatic accompaniment off, pattern 0,
 * bass flag on with the major chord, key C) over 0x40 pitch bytes of
 * silence and 0x40 instrument bytes of 0. That is the cartridge's blank.
 */
export function blankScore() {
    const out = new Uint8Array(SCORE_BYTES);
    for (let i = 0; i < SONG_BLOCKS; i++) out.set([0xff, 0x00, 0x01, 0x00], i * SCORE_BLOCK_BYTES);
    return out;
}

/**
 * The 32 accompaniment blocks of a song with nothing in them: 0x70 pitch
 * bytes of silence, then the seven lines' 0x10 instrument bytes each —
 * chorus 1..3 and bass 0, drums 1..3 the yellow drumkit (0x32).
 */
export function blankAccompaniment() {
    const out = new Uint8Array(ACCOMPANIMENT_BYTES);
    for (let i = 0; i < SONG_BLOCKS; i++) {
        const drums = i * ACCOMPANIMENT_BLOCK_BYTES + 0x70 + 4 * 0x10;
        out.fill(INSTRUMENT_YELLOW_DRUMKIT, drums, drums + 3 * 0x10);
    }
    return out;
}

/** A whole blank song, 0x2C9A bytes, byte for byte the cartridge's. */
export function blankSong() {
    return encodeSong({});
}

export function songDefaults() {
    return { ...songHeaderDefaults(), score: blankScore(), accompaniment: blankAccompaniment() };
}

/**
 * One song -> 0x2C9A bytes: the header fields of songHeaderDefaults() plus
 * `score` (0x1080 raw bytes) and `accompaniment` (0x1C00 raw bytes), each
 * the blank one unless given.
 */
export function encodeSong(song = {}, label = "song") {
    const s = merge(label, songDefaults(), song);
    const { score, accompaniment, ...header } = s;
    const b = new Uint8Array(SONG_BYTES);
    b.set(encodeSongHeader(header, label), 0);
    b.set(score, SCORE_OFFSET);
    b.set(accompaniment, ACCOMPANIMENT_OFFSET);
    return b;
}

export function decodeSong(bytes, at = 0) {
    needBytes("song", bytes, at, SONG_BYTES);
    return {
        ...decodeSongHeader(bytes, at),
        score: bytes.slice(at + SCORE_OFFSET, at + SCORE_OFFSET + SCORE_BYTES),
        accompaniment: bytes.slice(at + ACCOMPANIMENT_OFFSET, at + SONG_BYTES),
    };
}

/** Up to 24 songs -> the 0x42E70-byte MUS; a slot not given is a blank song. */
export function buildMusFile(songs = []) {
    if (!Array.isArray(songs)) throw new Error("MUS songs are a list");
    if (songs.length > SONG_COUNT) throw new Error(`MUS holds ${SONG_COUNT} songs; ${songs.length} were given`);
    const out = new Uint8Array(DOCUMENTED_SIZES.MUS);
    for (let i = 0; i < SONG_COUNT; i++) out.set(encodeSong(songs[i] ?? {}, `songs[${i}]`), i * SONG_BYTES);
    return out;
}

/** A MUS -> its 24 songs. */
export function parseMusFile(bytes) {
    needBytes("MUS", bytes, 0, DOCUMENTED_SIZES.MUS);
    return fill(SONG_COUNT, () => null).map((_, i) => decodeSong(bytes, i * SONG_BYTES));
}
