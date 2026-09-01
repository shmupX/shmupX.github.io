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
        death: decodeDeathWord(b),
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
