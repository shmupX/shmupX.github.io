// Dezaemon 2 enemy attribute decoder — the 18-byte per-(stage,record) block.
//
// Field offsets and value tables are traced from the play engine itself
// (GAME.CMP, SH-2, loaded at 0x06064000): the zako spawn routine at file
// +0x153c8 computes record = 0x0029A7E0 + stage*0x478 + index*18 and reads
// every field below; the lookup tables live at +0x21ee8..+0x22034. See
// FORMAT.md "Enemy record (18 B)" for the annotated disassembly summary.
//
// The record is a 6-byte head plus four 3-byte "change" channels — the
// editor's start/end/rate/repeat interpolators that drive an enemy's zoom,
// rotation, per-axis scale and movement direction over its lifetime:
//
//   byte 0      appearance id (art class; redundant here — art comes from the
//               per-stage composition banks)
//   byte 1      bits0-2 ANIMATION-PERIOD index, bits4-6 score index,
//               bit7 ground flag
//   byte 2      bits0-2 HIT-POINT index, bit3 terrain-ride flag + bits4-5 the
//               hit attributes (bit4 = ARMOUR), bits6-7 DEATH MODE
//   byte 3      DEATH PARAMETER (item slot / child record / chain key).
//               NOT fire params: the firing path reads neither byte 3 nor
//               byte 2's top bits — see decodeDeathWord() below
//   byte 4      bits0-1 fire mode, bits2-3 death presentation,
//               bits4-6 fire rate index
//   byte 5      bits0-4 fire direction, bits5-7 extra
//   bytes 6-8   uniform zoom channel   (enable b6&1)
//   bytes 9-11  rotation channel       (mode b9&7, see ROTATION_MODE)
//   bytes 12-14 per-axis scale channel (mode b12&3, see SCALE_AXES)
//   bytes 15-17 direction channel      (enable b15&1)
//
// Channel layout (A = first byte, B = second, C = third):
//   A bits4-6 -> step table index      B bits0-3 -> start value index
//   B bits4-7 -> end value index       C bits4-5 -> repeat (see
//   C bits0-2 -> trigger mode                       CHANNEL_REPEAT)
// (rotation uses 3-bit value indices, B bits0-2 / bits4-6)
//
// TWO of these four are scale. Bytes 12-14 drive the pair of per-axis
// registers `0x06095930` and `0x06091A30`; bytes 6-8 drive `0x06094A40`,
// which is the third member of the same triple — every object initializer
// in the engine seeds all three to 0x1000 (x1.0) together, both channels
// index the same nine-entry factor table and the same step table, and the
// per-frame consumer at +0x11034 copies `0x06094A40` into BOTH hitbox
// half-extents where +0x13DC8 copies one axis register into each. So bytes
// 6-8 zoom the object uniformly; they are not the speed channel this file
// called them until 2026-09-12, and nothing in the engine multiplies a
// velocity by that register.
//
// Environment-neutral ESM (Node + browser).

// --- engine value tables (GAME.bin literal data, byte-exact) -----------

// b1&7 -> ANIMATION PERIOD, in frames per animation frame. The zako record
// initialiser (+0x15458) reads it out of u8 `+0x21EE8` and writes it to the
// per-slot pair 0x0608DDF0 / 0x06090630, which the enemy updaters step as an
// animation counter. It is NOT hit points — that reading had index 0 (the
// editor's default, and 63% of the corpus) as the TOUGHEST enemy, which is
// backwards for a LIFE slider. The same eight values serve elsewhere as the
// boss's fire-tick divider and as the global bullet configs' damage index.
export const ANIM_PERIOD_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];

// (b1>>4)&7 -> score awarded on kill.
export const SCORE_TABLE = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

// b2&7 -> HIT POINTS, in the engine's durability units — the same units a
// weapon's attack power is in, where a full-power weapon-1 bullet is 5120.
// Index 0 is the WEAKEST (one hit from anything), so the editor's LIFE slider
// runs the natural way. Traced from the zako initialiser +0x1546A: `b2 & 7`
// indexes u32 `+0x21F20`, the value goes through the difficulty scaler
// +0x15358 (x2/3 easy, x1 normal, x1.5 hard) and is stored to BOTH the
// current-HP array 0x06095040 — which the collision resolver subtracts damage
// from — and the max-HP array 0x06093E50. The decoder reports the NORMAL
// difficulty value, unscaled.
export const HP_TABLE = [256, 12800, 25600, 51200, 102400, 204800, 256000, 512000];

// (b4>>4)&7 -> fire interval in frames, by fire mode (b4&3). The engine
// keeps two pairs of tables; f81/f91 are the common reload intervals, f61
// is the randomization window added on top, f71 a slower base variant.
export const FIRE_WINDOW_TABLE = [29, 22, 16, 11, 7, 4, 2, 1];
export const FIRE_BASE_TABLE = [14, 12, 10, 8, 6, 4, 2, 1];
export const FIRE_INTERVAL_TABLE = [119, 59, 29, 19, 9, 5, 3, 1];
export const FIRE_INTERVAL_TABLE_ALT = [119, 59, 39, 19, 11, 7, 3, 1];

// Channel value tables, transcribed from GAME.bin. The two factor channels
// (uniform zoom, per-axis scale) share one domain where 16 = x1.0 (so
// 0..64 = x0..x4); rotation and direction are angles in the engine's
// 256-unit circle (x1.40625 for degrees).
//
// These are SIXTEEN entries long because the engine indexes them with a
// whole nibble and its tables are only nine bytes. `0x6085FD0` (scale) and
// `0x6086004` (zoom) are both nine factor bytes followed by a pad zero,
// and the very next bytes are the channel's own step table, read as u16be
// words — so index 9 reads the pad, and 10-15 read step-table bytes. The
// decoder reproduces the spill rather than clamping, because index 9 means
// FACTOR 0 and the engine deletes an object whose scale reaches zero: a
// clamp turned a self-erasing enemy into an x4 one. Rotation is the one
// channel with a 3-bit index, so its 8-entry table cannot overrun.
export const FACTOR_TABLE = [
    0, 4, 8, 12, 16, 24, 32, 48, 64, // the nine authored factors
    0, 0, 16, 0, 32, 0, 64, // the pad byte, then FACTOR_STEP_TABLE's bytes
];
export const ROTATION_TABLE = [0, 32, 64, 96, 128, 160, 192, 224];
export const DIRECTION_TABLE = [
    0, 16, 32, 48, 64, 80, 96, 112, 128, // the nine authored headings
    0, 0, 128, 1, 0, 2, 0, // pad, then DIRECTION_STEP_TABLE's bytes
];

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

/**
 * Bullet type 3 does not fire bullets at all: it spawns one object of class 99
 * drawn from the enemy art, and byte 5 stops being a geometry selector. Bits
 * 4-6 pick one of seven art bands (value 7 folds to 0) and the low bits pick a
 * character inside it — `base + index * frames`, the frame counts being the
 * 4/4/4/4/2/2/1 the seven spawn wrappers +0x16070..+0x165e0 use.
 * Dispatch: GAME.bin 0x0607CE7C, wrappers 0x0607A070/148/238/328/400/4F0/5E0.
 */
export const BIG_SHOT_BANDS = Object.freeze([
    { base: 0x43, frames: 4, mask: 0x0f },
    { base: 0x83, frames: 4, mask: 0x0f },
    { base: 0xa3, frames: 4, mask: 0x0f },
    { base: 0xc3, frames: 4, mask: 0x0f },
    { base: 0x103, frames: 2, mask: 0x03 },
    { base: 0x10b, frames: 2, mask: 0x03 },
    { base: 0x113, frames: 1, mask: 0x03 },
]);
/** The bullet type whose byte 5 is art, not geometry. */
export const BIG_SHOT_TYPE = 3;

/**
 * Record byte 5 read the way the engine reads it for bullet type 3.
 * @param {number} b5
 */
export function decodeBigShot(b5) {
    const band = ((b5 >> 4) & 7) % BIG_SHOT_BANDS.length; // 7 folds to 0
    const spec = BIG_SHOT_BANDS[band];
    const index = b5 & spec.mask;
    return { band, index, character: spec.base + index * spec.frames, frames: spec.frames };
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

// What a channel does when its ramp reaches the end value. Read off the
// four-entry jump table at `0x6069FFC`, the tail of every channel stepper:
//
//   0  HOLD      step := 0, accumulator := 0, start := end. Frozen at the end.
//   1  PING-PONG accumulator := 0, step negated, start and end swapped.
//   2  LOOP      accumulator := 0, the live value re-seeded from start.
//   3  unreachable from this field on rotation, whose stepper claims 3 and 4
//      for its two engine-special modes (see ROTATION_MODE below).
//
// This file and the runtime long had 1 and 2 the other way round.
export const CHANNEL_REPEAT = Object.freeze(["hold", "pingpong", "loop", "special"]);

// How far a ramp actually travels, and why a channel needs a `sweep` at all.
// The engine never compares the live value against the end value. It keeps a
// signed 8.8 accumulator, adds the step to it every frame, and compares the
// accumulator's whole part against the UNSIGNED BYTE distance between start
// and end taken in the direction of travel (+0x5F9C for a rising ramp,
// +0x5FC0 for a falling one). On the angle channels, where the live heading
// is that sum truncated to a byte, that is what lets a sweep run the long way
// round: counter-clockwise from 0 to 64 is 192 units of travel, not -64.
function sweepUnits(from, to, negative) {
    return (negative ? (from - to) & 0xff : (to - from) & 0xff);
}

// One interpolator channel in editor units: from/to are factors (x1.0 = 1)
// or degrees, step is per-frame in the same unit.
//
// `negative` forces the step's sign instead of deriving it from start > end;
// rotation needs it, because its direction is the mode, not the endpoints.
// `fullCircle` applies the engine's start == end nudge (see ROTATION_MODE).
function channel(a, b, c, { enabled, table, stepTable, angle, bits3, negative, fullCircle }) {
    // Only the ROTATION channel packs 3-bit value indices (its table has 8
    // angles); every other channel indexes with the whole nibble, and
    // FACTOR_TABLE and DIRECTION_TABLE carry all sixteen entries the engine
    // can reach — nine authored values and the documented spill past them.
    const rawFrom = bits3 ? (b & 7) : (b & 0x0f);
    const rawTo = bits3 ? ((b >> 4) & 7) : ((b >> 4) & 0x0f);
    const from = table[rawFrom];
    // The start == end nudge: one unit the other way, so the unsigned
    // distance becomes 255 and the sweep is very nearly a whole circle.
    const to = fullCircle && table[rawTo] === from
        ? (negative ? (from + 1) & 0xff : (from - 1) & 0xff)
        : table[rawTo];
    // sign follows the engine: unless the caller forces it, the step is
    // negated when start > end
    const down = negative === undefined ? from > to : negative;
    const step = stepTable[(a >> 4) & 7] / 256; // 8.8 -> value units/frame
    const scale = angle ? 360 / 256 : 1 / 16;   // engine units -> deg / factor
    const repeat = (c >> 4) & 3;
    return {
        enabled,
        from: from * scale,
        to: to * scale,
        sweep: (step === 0 ? 0 : sweepUnits(from, to, down)) * scale,
        step: (down ? -step : step) * scale,
        repeat,
        repeatName: CHANNEL_REPEAT[repeat],
        trigger: c & 7,
    };
}

// Which registers the scale mode arms. The spawn routine tests the mode
// twice: `+0x157B0` sets up the first axis for modes 1 and 2, `+0x158D8`
// the second for modes 1 and 3 — one authored ramp, armed onto one or both.
// The axis names come from the editor's own XY / X / Y list, in its order;
// the two registers are plainly distinct in the trace, but nothing there
// says outright which one is the horizontal.
export const SCALE_AXES = ["", "xy", "x", "y"];

// Rotation mode, record byte 9 bits 0-2.
//
//   0  off
//   1  clockwise, 2  counter-clockwise (the step is negated, +0x15A44)
//   3  and 4 are the engine specials. They do not merely preset an angle:
//      each OVERWRITES the channel's repeat byte at `0x06091910` with its own
//      number (+0x15A50, +0x15A74), which routes the per-frame stepper to a
//      target-tracking arm instead of the four repeat arms. Whatever the
//      record authored in the repeat field is dead on these two modes.
export const ROTATION_MODE = ["off", "cw", "ccw", "home", "track"];

function decodeRotationChannel(b, mode) {
    const ch = channel(b[9], b[10], b[11], {
        enabled: mode !== 0,
        table: ROTATION_TABLE,
        stepTable: ROTATION_STEP_TABLE,
        angle: true,
        bits3: true,
        negative: mode === 2,
        fullCircle: true,
    });
    if (mode < 3) return ch;
    return {
        ...ch,
        repeat: mode,
        repeatName: ROTATION_MODE[mode],
        // the authored bits, kept for anyone diffing records
        authoredRepeat: ch.repeat,
    };
}

// Decode one 18-byte record into named fields (all in editor/runtime units:
// hp in hits, score in points, speed in px/frame, angles in degrees,
// factors where 1 = 100%).
// How the ENGINE turns a placement cell byte into a record index. The cell byte
// is `1 bbb nnnn` — bit7 the OCCUPIED flag, bits4-6 the BAND, bits0-3 the index
// within it. Both producers (the placement walker and the death-word child
// spawner `+0x18E7C`) funnel into the same seven band wrappers
// `+0x16070/16148/16238/16328/16400/164F0/165E0`, and each wrapper hard-codes
// its own base byte from the 7-byte table at `0x0608603C`:
//
//     record index = BASE[band] | (cell & 15)        // e.g. +0x1A488: or r4,r5
//
// The index is OR-ed in **unmasked**. The per-band mask below is a separate
// thing — it shapes only the ART (char index = charBase + step*(cell & mask))
// and the hitbox, so a cell whose index overruns its band still selects a
// record, just not a matching sprite. Band 7 (cells 0xF0-0xFF) is unreachable
// on the death path: `+0x18E98` clamps band > 6 into the band-0 case.
export const ZAKO_BAND_BASE = [0x00, 0x10, 0x18, 0x20, 0x30, 0x34, 0x38];
export const ZAKO_BAND_ART_MASK = [15, 7, 7, 15, 3, 3, 3];

// Record index for a placement cell byte / formation key, the engine's way.
// May exceed the 60 defined records when the index overruns its band (the
// engine reads on into the block trailer); callers resolve it against the
// roster they actually have.
export function zakoRecordFromKey(key) {
    const band = (key >> 4) & 7;
    return ZAKO_BAND_BASE[band === 7 ? 0 : band] | (key & 15);
}

// The DEATH WORD — record byte 2's top two bits and the whole of byte 3, which
// this file long mis-read as a "fire type" and its parameters. Traced
// 2026-08-28: the spawn routine (`+0x153C8`) packs them into one per-slot u16
// at `0x06094240` as `mode<<8 | param`, and the ONLY code that ever reads
// either byte is that packing — the firing path never touches them. The death
// dispatcher (`+0x6448`) then switches on `word & 0x0300`:
//
//   0 nothing · 1 DROP an item · 2 SPAWN a child enemy · 3 CHAIN-kill a group
//
// Byte 4's bits 2-3 ride along in the same word as the death PRESENTATION
// (bit15 = vanish silently, bit14 = the small blast and no revenge shot).
function decodeDeathWord(b) {
    const mode = (b[2] >> 6) & 3;
    const param = b[3];
    const present = (b[4] >> 2) & 3;
    const death = {
        mode, // 0 none, 1 item, 2 child, 3 chain
        param,
        // The engine renders the death itself from byte 4: value 0 removes the
        // object with no explosion and no sound, value 2 picks the small blast
        // (and suppresses the rank-3 revenge shot); 1 and 3 are the full one.
        silent: present === 0,
        small: present === 2,
    };
    if (mode === 1) {
        // Item slot 1-8, or 9 = "cycle", the engine's own encoding of byte 3 —
        // NOT a shot count. Slot 0 means the drop is skipped.
        death.item = (param & 8) !== 0 ? 9 : (param & 7) + 1;
    } else if (mode >= 2) {
        // Modes 2 and 3 share one meaning for byte 3: a placement cell byte
        // with its occupied bit stripped. The engine ORs 0x80 back on, making
        // it both the child's FORMATION KEY and (mode 3) the key to sweep.
        death.key = param | 0x80;
        death.record = zakoRecordFromKey(death.key);
    }
    return death;
}

export function decodeEnemyRecord(bytes) {
    const b = Array.from(bytes);
    const rotationMode = b[9] & 7;
    const scaleMode = b[12] & 3;
    return {
        appearance: b[0],
        // Engine durability units. There is no `speed` field: byte 2's low
        // bits are hp, and a scripted zako's motion comes from its appearance
        // script's amplitude words and the change channels below. The one
        // per-record speed the engine does read is byte 0 bits0-2, and only
        // for the 48 hard-coded AI appearance ids (classes 0x31-0x36), which
        // remap it through [128,256,384,512,640,768,1152,1536] units/frame
        // (+0x20560) — it rides along inside `appearance`, and the runtime
        // already drives it from there.
        hp: HP_TABLE[b[2] & 7],
        animPeriod: ANIM_PERIOD_TABLE[b[1] & 7],
        score: SCORE_TABLE[(b[1] >> 4) & 7],
        ground: (b[1] & 0x80) !== 0,
        // The spawn packs b2 bits 4-5 and bit 3 into the per-object HIT
        // ATTRIBUTE byte 0x06091550, which the engine reads BITWISE. Named
        // (2026-08-31, FORMAT.md "Armour deflection"): bit 0 = ARMOUR — the
        // target is indestructible, ordinary shots die on it instead of
        // trading hp, the impact SFX changes, and sub weapon 6's ball bounces
        // off it; bit 1 = NO COLLISION AT ALL; bit 2 = the terrain-ride flag.
        // `mode` keeps the two-bit field the editor authors as a pair of
        // mutually exclusive checkboxes, so armour is `move.mode & 1`.
        movePattern: ((b[2] >> 4) & 3) | ((b[2] & 8) >> 1),
        move: {
            mode: (b[2] >> 4) & 3,          // bit0 = armour, bit1 = no collision
            flag: (b[2] & 8) !== 0,         // terrain-ride (&4 of the packed byte)
        },
        fire: {
            // Two gates silence an enemy outright: the appearance's no-fire
            // bit, and byte 5's low nibble being 0 — the geometry table's
            // entry 0 is an empty routine (FORMAT.md "Zako firing,
            // re-traced"). `enabled` carries only the appearance gate; the
            // runtime combines it with `direction`.
            enabled: appearanceFires(b[0]),
            // b4 & 3 = BULLET TYPE: which of the save's four global bullet
            // configs this enemy fires (settings +37..+40). Bullet types
            // 0-2 reload from the short table [14,12,10,8,6,4,2,1]
            // (0x6085f70); only type 3 uses the long tables kept here — the
            // runtime substitutes the short table for types 0-2.
            mode: b[4] & 3,
            interval: clampIndex((b[4] >> 4) & 7,
                (b[4] & 3) === 3 ? FIRE_INTERVAL_TABLE_ALT : FIRE_INTERVAL_TABLE),
            window: FIRE_WINDOW_TABLE[(b[4] >> 4) & 7],
            // Bullet type 3 is a different weapon entirely, and the two gates
            // that make it so are at 0x0607D828 and 0x0607D89A: both compare
            // the spawn-cached b4 & 3 against 2 and, when it is greater, jump
            // past the "low nibble 0 = never fires" early-out AND past the
            // whole 16-way geometry dispatcher. The shooter's own jump table
            // (0x0607CFE4) sends it to 0x0607D0AE, which spawns ONE object of
            // class 99 out of the enemy art. So for this type byte 5 is art,
            // there is no aim bit, the reload is deterministic (no random
            // window, and it ticks every serviced frame rather than on the
            // fire pulse), and a low nibble of 0 does not silence anything.
            bigShot: (b[4] & 3) === BIG_SHOT_TYPE ? decodeBigShot(b[5]) : null,
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
            geometry: (b[4] & 3) === BIG_SHOT_TYPE ? null : (b[5] & 0x0f),
            aimed: (b[4] & 3) === BIG_SHOT_TYPE ? false : (b[5] & 0x10) !== 0,
            pattern: (b[4] & 3) === BIG_SHOT_TYPE ? null : (SPECIAL_FIRE_PATTERNS[b[5] & 0x0f] ?? null),
            direction: (b[4] & 3) === BIG_SHOT_TYPE
                ? 0
                : (SPECIAL_FIRE_PATTERNS[b[5] & 0x0f] !== undefined ? 0 : (b[5] & 0x1f)),
            directionEx: (b[5] >> 5) & 7,
        },
        death: decodeDeathWord(b),
        zoom: channel(b[6], b[7], b[8], {
            enabled: (b[6] & 1) !== 0,
            table: FACTOR_TABLE,
            stepTable: FACTOR_STEP_TABLE,
            angle: false,
        }),
        rotation: {
            ...decodeRotationChannel(b, rotationMode),
            mode: rotationMode,
        },
        scale: {
            ...channel(b[12], b[13], b[14], {
                enabled: scaleMode !== 0,
                table: FACTOR_TABLE,
                stepTable: FACTOR_STEP_TABLE,
                angle: false,
            }),
            // The mode really does pick axes, exactly as the editor's
            // XY / X / Y list says. One ramp, armed onto one or both
            // registers (see SCALE_AXES).
            axes: SCALE_AXES[scaleMode],
            mode: scaleMode,
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
    return decoded.zoom.enabled || decoded.rotation.enabled ||
        decoded.scale.enabled || decoded.direction.enabled;
}
