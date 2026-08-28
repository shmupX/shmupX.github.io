// Dezaemon 2 enemy attribute decoder — the 18-byte per-(stage,record) block.
//
// Field offsets and value tables are traced from the play engine itself
// (GAME.CMP, SH-2, loaded at 0x06064000): the zako spawn routine at file
// +0x153c8 computes record = 0x0029A7E0 + stage*0x478 + index*18 and reads
// every field below; the lookup tables live at +0x21ee8..+0x22034. See
// FORMAT.md "Enemy record (18 B)" for the annotated disassembly summary.
//
// The record is a 6-byte head plus four 3-byte "change" channels — the
// editor's start/end/rate/repeat interpolators that drive an enemy's speed,
// rotation, scale and movement direction over its lifetime:
//
//   byte 0      appearance id (art class; redundant here — art comes from the
//               per-stage composition banks)
//   byte 1      bits0-2 hp index, bits4-6 score index, bit7 ground flag
//   byte 2      bits0-2 speed index, bit3+bits4-5 movement pattern (0-7),
//               bits6-7 fire type
//   byte 3      fire parameters (type 1: bits0-2 count-1, bit3 wide)
//   byte 4      bits0-1 fire mode, bits4-6 fire rate index
//   byte 5      bits0-4 fire direction, bits5-7 extra
//   bytes 6-8   speed-change channel   (enable b6&1)
//   bytes 9-11  rotation channel       (mode b9&7: 0 off, 1 cw, 2 ccw,
//                                       3/4 engine-special)
//   bytes 12-14 scale channel          (mode b12&3: 0 off, 1 XY, 2 X, 3 Y)
//   bytes 15-17 direction channel      (enable b15&1)
//
// Channel layout (A = first byte, B = second, C = third):
//   A bits4-6 -> step table index      B bits0-3 -> start value index
//   B bits4-7 -> end value index       C bits4-5 -> repeat (0 once, 1 loop,
//   C bits0-2 -> trigger mode                       2 ping-pong)
// (rotation uses 3-bit value indices, B bits0-2 / bits4-6)
//
// Environment-neutral ESM (Node + browser).

// --- engine value tables (GAME.bin literal data, byte-exact) -----------

// b1&7 -> hit points. Index 0 is the TOUGHEST (the editor's LIFE slider
// runs the other way).
export const HP_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];

// (b1>>4)&7 -> score awarded on kill.
export const SCORE_TABLE = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

// b2&7 -> own movement speed, 16.16 fixed point px/frame (0.004..7.8).
// Index 0 is effectively stationary — the enemy rides the map scroll.
export const SPEED_TABLE = [256, 12800, 25600, 51200, 102400, 204800, 256000, 512000];

// (b4>>4)&7 -> fire interval in frames, by fire mode (b4&3). The engine
// keeps two pairs of tables; f81/f91 are the common reload intervals, f61
// is the randomization window added on top, f71 a slower base variant.
export const FIRE_WINDOW_TABLE = [29, 22, 16, 11, 7, 4, 2, 1];
export const FIRE_BASE_TABLE = [14, 12, 10, 8, 6, 4, 2, 1];
export const FIRE_INTERVAL_TABLE = [119, 59, 29, 19, 9, 5, 3, 1];
export const FIRE_INTERVAL_TABLE_ALT = [119, 59, 39, 19, 11, 7, 3, 1];

// Channel value tables. Scale and speed-change share one domain where
// 16 = x1.0 (so 0..64 = x0..x4); rotation and direction are angles in the
// engine's 256-unit circle (x1.40625 for degrees).
export const FACTOR_TABLE = [0, 4, 8, 12, 16, 24, 32, 48, 64];
export const ROTATION_TABLE = [0, 32, 64, 96, 128, 160, 192, 224];
export const DIRECTION_TABLE = [0, 16, 32, 48, 64, 80, 96, 112, 128];

// Whether an appearance (byte 0) can fire at all. The engine's fire
// dispatcher (+0x19882) tests bit 4 of the appearance definition word — the
// u16 at +8 of the 256-entry pointer table at 0x6088e5c — and skips firing
// when it is set. Extracted verbatim from GAME.bin: bit i of byte i>>3, LSB
// first, set = that appearance never fires (48 of 256).
const APPEARANCE_NOFIRE_HEX =
    "0000000000ffff00000000ff000000ffff000000ff0000000000000000000000";
export function appearanceFires(appearance) {
    const byte = parseInt(
        APPEARANCE_NOFIRE_HEX.slice((appearance >> 3) * 2, (appearance >> 3) * 2 + 2),
        16,
    );
    return (byte & (1 << (appearance & 7))) === 0;
}

// `b5 & 0xF` values the fire dispatcher routes away from the angle path.
// Their handlers are three variants of one routine; which shape each draws is
// still open, so they are numbered rather than named.
export const SPECIAL_FIRE_PATTERNS = { 10: 0, 11: 1, 12: 2 };

// Per-channel step tables, 8.8 fixed point value-units per frame.
export const FACTOR_STEP_TABLE = [16, 32, 64, 128, 256, 384, 512, 1024];
export const ROTATION_STEP_TABLE = [16, 32, 64, 128, 256, 512, 1024, 2048];
export const DIRECTION_STEP_TABLE = [128, 256, 512, 768, 1024, 1536, 2048, 32767];

const clampIndex = (v, table) => table[Math.min(v, table.length - 1)];

// One interpolator channel in editor units: from/to are factors (x1.0 = 1)
// or degrees, step is per-frame in the same unit.
function channel(a, b, c, { enabled, table, stepTable, angle }) {
    const rawFrom = angle ? (b & 7) : (b & 0x0f);
    const rawTo = angle ? ((b >> 4) & 7) : ((b >> 4) & 0x0f);
    const from = clampIndex(rawFrom, table);
    const to = clampIndex(rawTo, table);
    const step = stepTable[(a >> 4) & 7] / 256; // 8.8 -> value units/frame
    const scale = angle ? 360 / 256 : 1 / 16;   // engine units -> deg / factor
    return {
        enabled,
        from: from * scale,
        to: to * scale,
        // sign follows the engine: it negates the step when start > end
        step: (from > to ? -step : step) * scale,
        repeat: (c >> 4) & 3, // 0 once, 1 loop, 2 ping-pong
        trigger: c & 7,
    };
}

// Decode one 18-byte record into named fields (all in editor/runtime units:
// hp in hits, score in points, speed in px/frame, angles in degrees,
// factors where 1 = 100%).
export function decodeEnemyRecord(bytes) {
    const b = Array.from(bytes);
    const rotationMode = b[9] & 7;
    const scaleMode = b[12] & 3;
    return {
        appearance: b[0],
        hp: HP_TABLE[b[1] & 7],
        score: SCORE_TABLE[(b[1] >> 4) & 7],
        ground: (b[1] & 0x80) !== 0,
        speed: SPEED_TABLE[b[2] & 7] / 65536,
        // The spawn packs b2 bits 4-5 and bit 3 into one byte (0x6091550), and
        // the engine reads that byte BITWISE — masks 0x1/0x2/0x3 (the low
        // two-bit mode) and 0x4 (an independent flag) across its 56 read
        // sites. So this is a 2-bit mode plus a flag, not an 8-way enum;
        // movePattern keeps the packed value for continuity.
        movePattern: ((b[2] >> 4) & 3) | ((b[2] & 8) >> 1),
        move: {
            mode: (b[2] >> 4) & 3,          // engine tests &1, &2, &3
            flag: (b[2] & 8) !== 0,         // engine tests &4 of the packed byte
        },
        fire: {
            // Two gates silence an enemy outright: the appearance's no-fire
            // bit, and byte 5's low nibble being 0 — the geometry table's
            // entry 0 is an empty routine (FORMAT.md "Zako firing,
            // re-traced"). `enabled` carries only the appearance gate; the
            // runtime combines it with `direction`.
            enabled: appearanceFires(b[0]),
            type: (b[2] >> 6) & 3,          // b2 bits 6-7 (semantics open)
            count: (b[3] & 7) + 1,
            wide: (b[3] & 8) !== 0,
            param: b[3],                     // raw
            // b4 & 3 = BULLET TYPE: which of the save's four global bullet
            // configs this enemy fires (settings +37..+40). Bullet types
            // 0-2 reload from the short table [14,12,10,8,6,4,2,1]
            // (0x6085f70); only type 3 uses the long tables kept here — the
            // runtime substitutes the short table for types 0-2.
            mode: b[4] & 3,
            interval: clampIndex((b[4] >> 4) & 7,
                (b[4] & 3) === 3 ? FIRE_INTERVAL_TABLE_ALT : FIRE_INTERVAL_TABLE),
            window: FIRE_WINDOW_TABLE[(b[4] >> 4) & 7],
            // Byte 5's low nibble picks a bullet-geometry function from the
            // 16-pointer table at 0x6086074 — all 16 traced (2026-08-28):
            // 0 silent, 1/10 single, 2 = ±8-unit pair, 3 = 0,±8 fan,
            // 4 = 0,±16, 5 = ±8,±24 (no center), 6 = 0,±8,±16,
            // 7 = 0,±16,±32, 8 = same as 7 with curving bullets, 9 = homing
            // single, 11 = single with (rand&31)−16 unit jitter, 12 = single
            // stepping +16 units (22.5°) per shot through a full circle,
            // 13 = ±64 perpendicular pair, 14 = 0,±64,128 cross, 15 = 8-way
            // star (angle units = 1/256 circle). Values 10/11/12 ALSO route
            // the fire routine to burst handlers (+0x193d0/+0x19538/+0x196a8):
            // 10 = 4 volleys one fire-tick apart, 11 = 5 jittered volleys,
            // 12 = 16 shots on consecutive frames — the rotating spiral.
            // Bit 4 (0x10) aims the volley at the player (re-aimed every
            // shot); otherwise shots leave along the enemy's facing.
            geometry: b[5] & 0x0f,
            aimed: (b[5] & 0x10) !== 0,
            pattern: SPECIAL_FIRE_PATTERNS[b[5] & 0x0f] ?? null,
            direction: SPECIAL_FIRE_PATTERNS[b[5] & 0x0f] !== undefined ? 0 : (b[5] & 0x1f),
            directionEx: (b[5] >> 5) & 7,
        },
        speedChange: channel(b[6], b[7], b[8], {
            enabled: (b[6] & 1) !== 0,
            table: FACTOR_TABLE,
            stepTable: FACTOR_STEP_TABLE,
            angle: false,
        }),
        rotation: {
            ...channel(b[9], b[10], b[11], {
                enabled: rotationMode !== 0,
                table: ROTATION_TABLE,
                stepTable: ROTATION_STEP_TABLE,
                angle: true,
            }),
            mode: rotationMode,
        },
        scale: {
            ...channel(b[12], b[13], b[14], {
                enabled: scaleMode !== 0,
                table: FACTOR_TABLE,
                stepTable: FACTOR_STEP_TABLE,
                angle: false,
            }),
            // which axes the channel drives
            axes: scaleMode === 1 ? "xy" : scaleMode === 2 ? "x" : scaleMode === 3 ? "y" : "",
            repeatY: (b[14] >> 2) & 3,
        },
        direction: channel(b[15], b[16], b[17], {
            enabled: (b[15] & 1) !== 0,
            table: DIRECTION_TABLE,
            stepTable: DIRECTION_STEP_TABLE,
            angle: true,
        }),
    };
}

// True when a record drives any visual transform — used by the editor to
// report how much of a save's behavior data is in play.
export function hasTransforms(decoded) {
    return decoded.speedChange.enabled || decoded.rotation.enabled ||
        decoded.scale.enabled || decoded.direction.enabled;
}
