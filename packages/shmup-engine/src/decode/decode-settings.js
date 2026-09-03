// Dezaemon 2 global settings decoder — the 0x60-byte block at sec5 +0x5A780.
//
// Field map (FORMAT.md "Settings byte map"): +0x00 game mode, +0x0C..+0x0F and
// +0x10..+0x13 the two player-ship config blocks, +0x14..+0x1B the four
// weapon LOADOUT presets, +0x1C..+0x23 the 8 item slots, +0x24 the score-item
// value, +0x25..+0x28 the bullet configs + blast byte, +0x29..+0x2C the
// title screen's entrance program, +0x2D..+0x40 the scroll extents,
// +0x41..+0x58 the BGM assignment table (four special tracks, then a
// (main, boss) pair per stage row), +0x59 the SFX set, +0x5A..+0x5C the
// staff roll's three role labels.
//
// The weapon system (fully traced 2026-08-28, adversarially verified —
// REPLACING the earlier heuristic "ship byte +3 low nibble = main weapon"):
// the four selects live in the LOADOUT pairs at +0x14+2k/+0x15+2k, loaded at
// player init (+0x90EC) and by weapon-change items (+0x1CF3C):
//   byte0 bits4-6 = MAIN weapon 0-7 (dispatcher +0x1509C)
//   byte0 bits0-2 = SUB weapon 0-7 (autofire dispatcher +0x15128)
//   byte1 bits0-1 = CHARGE type 0-3 (dispatcher +0x1528C)
//   byte1 bits4-7 = BOMB type (bits4-6, bit7 a variant flag; 16-way
//                   dispatcher +0x151B0)
// The MAIN/SUB rows were transposed here until 2026-09-02, when the editor's
// own ARMS panel settled it (see FORMAT.md, settings +0x14). The bit-field to
// dispatcher wiring above was always right; only these two names were swapped.
// The editor's names for the values, read out of its option lists:
//   MAIN   1-7  VULCAN A, VULCAN B, MISSILE, HOMING, SHADOW, WAVE, BOUND
//   SUB    1-7  H-MISSILE, S-MISSILE, G-MISSILE, RF-LASER, OPTION A/B/C
//   BOMB   1-7  RED, BLUE, GREEN, EDIT A, EDIT B, BIG, WIPE
//   CHARGE 1-3  CANNON, LASER, FIRE
// Ship block (4 B per player at +0x0C / +0x10):
//   +0 = 0x10 | starting loadout index (engine reads only &3)
//   +1 = maxSpeedLevel<<4 | rapid-fire param (manual interval 8-v frames)
//   +2 = maxPowerLevel<<4 | initialPowerLevel (both <= 4)
//   +3 low nibble = AUTOFIRE RATE index -> [60,30,15,10,5,3,2,1] frames/volley

import { SEC5_REGIONS } from "./decode-stage.js";

// Full-power (level 4) per-bullet shot damage for the byte0 bits0-2 field —
// the one the editor calls SUB (renamed 2026-09-02; this table is keyed on
// the same bits it always was). Units are the engine's u32 attack power
// (0x608C720 — the same units enemy hp is in: record byte 2's
// [256,12800,..,512000], so 5120 kills the eight steps in
// 1/3/5/10/20/40/50/100 hits). Read out of the spawn sites (per-level u32
// tables; weapons 1/2/3 deliberately LOWER per-bullet damage as the power
// level rises while adding projectiles):
//   1: +0x21D6C [13312..5120]   2: +0x21D8C [19712..11520]
//   3: +0x21DAC [256..128] (homing, many contacts)
//   4: +0x21DCC [1024..1152]    5: +0x21DEC [1024..1280]
//   6: 384 per bullet           7: no table — see below
// The block runs +0x21D6C + 0x20*(w-1) and STOPS after weapon 5: +0x21E0C
// holds [5614080, 4227264, 150998016, ...], which is not a damage table.
// Entry 7 used to cite +0x21C80 [7680..3584]; that is the OTHER dispatcher's
// weapon 1 and the citation was wrong (removed 2026-09-02, while the two
// fields' names were being untangled). No value here moved: 7 was already at
// the floor, as 3, 4, 5 and 6 are. Values 5/6/7 of this field are the
// editor's OPTION A/B/C — option pods driven from GAME +0x1CEDE, not shots —
// so "per-bullet shot damage" is the wrong question for them and the floor is
// the honest answer until the pods themselves are traced.
export const WEAPON_FULL_POWER_DAMAGE = {
    0: 5120,   // fires no main shot; keep the anchor pace
    1: 5120,
    2: 11520,
    3: 5120,   // homing stream: 128/contact, many contacts/frame — floored
    4: 5120,   // twin 1152 missiles + sub coverage — floored
    5: 5120,   // OPTION A: 1280 tap, floored — the pods are untraced
    6: 5120,   // OPTION B: 384/bullet at 1-frame intervals — floored
    7: 5120,   // OPTION C: no traced table — floored
};
// The importer's divisor works in LIFE units (damage units >> 8): a save's
// full-power shot of D units kills LIFE L in ceil(L*256/D) hits. The floor
// of 5120 (= weapon 1's full-power bullet, 20 LIFE units) keeps stream and
// contact weapons — which hit many times per action — at the traced anchor
// pace: max-LIFE zako die in 3 anchored hits, exactly the capture-verified
// behavior the earlier heuristic calibrated to.
export const DEFAULT_SHOT_DAMAGE = 20;

export function weaponShotDamage(weapon) {
    const units = WEAPON_FULL_POWER_DAMAGE[weapon];
    return units ? Math.round(units / 256) : DEFAULT_SHOT_DAMAGE;
}

// The three global bullet configs (+0x25..+0x27) and the blast byte (+0x28).
// Engine-traced 2026-08-28: the shooter (GAME.CMP +0x19002) reads
// settings[0x25 + (enemy record byte4 & 3)] LIVE via the settings pointer —
// so bullet type 3 aliases the blast byte, an engine quirk that ships here
// as data (configs[3]). Config byte: bits0-2 damage index into
// [60,30,15,10,5,3,2,1] (the same durability units enemy LIFE decodes in),
// bits4-5 speed-add index into [128,256,512,896] engine units — the spawn
// stores (speed*sin)>>16 into 25.7 positions, and the draw path divides those
// by 128 (`if (p<0) p+=127; p>>=7`, +0x51B4 -> kernel 0x06010BF6), so
// px/frame = units/256: 0.5/1.0/2.0/3.5 on top of the rank-driven base
// u16[0x608EF30] = 4*rank. (Corrected 2026-08-31: the earlier /512 assumed
// 24.8 positions. See FORMAT.md "Player weapons".)
// Bit7 is an editor toggle with no traced play effect. Blast byte: bits0-2 /
// bits4-6 = explosion anim A/B tick-hold via [8,7,6,5,4,3,2,1] (+0x25A98).
export const BULLET_DAMAGE_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];
export const BULLET_SPEED_ADD_TABLE = [128, 256, 512, 896];
export const BLAST_HOLD_TABLE = [8, 7, 6, 5, 4, 3, 2, 1];

function bulletConfig(byte) {
    return {
        raw: byte,
        damage: BULLET_DAMAGE_TABLE[byte & 7],
        // px/frame at 60 Hz, before the rank-driven base
        speedAdd: BULLET_SPEED_ADD_TABLE[(byte >> 4) & 3] / 512,
        flag: (byte & 0x80) !== 0,
    };
}

export const AUTOFIRE_RATE_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];

// The title screen's ENTRANCE program (+0x29..+0x2C) — engine-traced
// 2026-09-01 from the play engine's title routine (GAME.CMP +0x1E78C) and
// the KUMITATE editor's effect page (+0x17E64 reader / +0x180B8 writer),
// adversarially verified. The four bytes are ten 2-bit tri-state fields,
// five per drawn logo: the editor shows them as two 5x3 icon grids — the
// "15 slots" per logo the GameFAQs guide describes — and the author picks
// one icon per column. Object 0 (TITLE 2, bank refs 176-207) reads
// +0x29/+0x2A; object 1 (TITLE 1, refs 144-175) reads +0x2B/+0x2C. Byte A
// bits 0-1 = vertical entry, bits 2-3 = horizontal entry, bits 4-5 = spin;
// byte B bits 0-1 = height scale, bits 2-3 = width scale. In every field 1
// and 2 are the two directions and 0 is static (3 is never written and takes
// the engine's static branch). Each animated field is a straight line over
// exactly 128 frames that lands on the shared rest pose — the 128x64 art
// drawn at 2.0x (256x128 px) centred on (160, 80) of the 320x224 screen,
// upright — so every combination arrives together; a new button press
// snaps both logos to the pose. Then a 32-frame white flash on the sprite
// layer (+248 fading by 8 a frame), and the title idles for 1200 frames
// blinking PRESS 1P START BUTTON (32 on / 32 off at tile 8,21 = px 64,168)
// before replaying the entrance. The title is drawn untransposed in
// horizontal games too (the engine clears the orientation flag for it).
export const TITLE_ENTRANCE_FRAMES = 128;
export const TITLE_ENTRANCE = {
    // vertical entry: start y (px) and per-frame step, landing on y = 80
    y: { 0: null, 1: { from: -64, step: 1.125 }, 2: { from: 304, step: -1.75 }, 3: null },
    // horizontal entry: start x (px) and per-frame step, landing on x = 160
    x: { 0: null, 1: { from: 448, step: -2.25 }, 2: { from: -128, step: 2.25 }, 3: null },
    // spin: whole turns over the 128 frames (+0x200 / -0x200 of 0x10000 a
    // frame); positive is clockwise on screen
    spin: { 0: 0, 1: 1, 2: -1, 3: 0 },
    // scale, as a multiple of the rest scale: from 2x shrinking (0x4000 ->
    // 0x2000 by -64 a frame) or from 0 growing (+64 a frame)
    scale: { 0: null, 1: { from: 2, step: -1 / 128 }, 2: { from: 0, step: 1 / 128 }, 3: null },
};
export const TITLE_ENTRANCE_NAMES = {
    y: ["none", "fromAbove", "fromBelow", "none"],
    x: ["none", "fromRight", "fromLeft", "none"],
    spin: ["none", "clockwise", "counterclockwise", "none"],
    scale: ["none", "shrink", "grow", "none"],
};

function titleEntranceFields(a, b) {
    return {
        y: a & 3,
        x: (a >> 2) & 3,
        spin: (a >> 4) & 3,
        scaleH: b & 3,
        scaleW: (b >> 2) & 3,
        raw: [a, b],
    };
}

export function decodeTitleEntrance(sec5, base) {
    return {
        // TITLE 1 is the front logo (sort byte 3 against TITLE 2's 4; the
        // engine's later layers sit further back)
        title1: titleEntranceFields(sec5[base + 0x2b], sec5[base + 0x2c]),
        title2: titleEntranceFields(sec5[base + 0x29], sec5[base + 0x2a]),
    };
}

// The engine's 16 fixed staff-roll role labels (GAME.bin pointer table
// +0x20164); settings +0x5A..+0x5C pick three of them for the ending's staff
// roll (GAME.CMP +0x19C4, traced 2026-09-01): label i is typed out one
// character every 4 frames at tick 600*i on the text layer, and the two
// 64x16 credit strips 2i / 2i+1 (bank refs 208+8i..) fly in under it 120 and
// 360 frames later. The roll runs after the final stage's ALL STAGE CLEARED
// card, never on game over. Index 0 draws a blank line.
export const STAFF_ROLE_LABELS = [
    "", "PLANNING", "PRODUCE", "SFX PLAY", "ENEMY DESIGN", "MAP DESIGN",
    "CHARACTER DESIGN", "TITLE LOGO", "2D GRAPHIC", "3D GRAPHIC", "DEBUG",
    "SPECIAL THANKS", "PRESENTED BY", "GRAPHIC", "MUSIC", "THANKS",
];

function shipBlock(sec5, base) {
    return {
        startLoadout: sec5[base] & 3,
        rapidParam: sec5[base + 1] & 7, // manual fire interval = 8 - v frames
        maxSpeed: (sec5[base + 1] >> 4) & 7,
        initialPower: sec5[base + 2] & 7,
        maxPower: Math.min(4, (sec5[base + 2] >> 4) & 7),
        // frames between autofire volleys
        autofireFrames: AUTOFIRE_RATE_TABLE[sec5[base + 3] & 7],
        raw: [...sec5.subarray(base, base + 4)],
    };
}

function loadout(sec5, base) {
    const b0 = sec5[base];
    const b1 = sec5[base + 1];
    return {
        main: (b0 >> 4) & 7,
        sub: b0 & 7,
        charge: b1 & 3,
        bomb: (b1 >> 4) & 7,
        bombVariant: (b1 & 0x80) !== 0,
        raw: [b0, b1],
    };
}

// Decode the settings block out of a decompressed sec5.
export function decodeSettings(sec5) {
    const base = SEC5_REGIONS.settings.offset;
    const ships = [shipBlock(sec5, base + 0x0c), shipBlock(sec5, base + 0x10)];
    const loadouts = [0, 1, 2, 3].map((k) => loadout(sec5, base + 0x14 + k * 2));
    // The weapons P1 actually starts with — the pace-setting config.
    const startWeapons = loadouts[ships[0].startLoadout];
    // +0x2D..+0x40: per-stage scroll extents, one (loop-start, end) byte pair
    // per stage in parts of 256 px (16 map rows) — the "20 always-even bytes".
    // The per-frame scroll routine (GAME.bin +0x1E04C, traced 2026-08-28)
    // compares scrollPos against end<<8: normal play STOPS the scroll one
    // screen short of it; a boss fight (and game modes >= 2) LOOPS the
    // background between loop<<8 and end<<8 instead.
    const stageExtents = [];
    for (let s = 0; s < 10; s++) {
        stageExtents.push({
            loopPart: sec5[base + 0x2d + s * 2],
            endPart: sec5[base + 0x2e + s * 2],
        });
    }
    return {
        gameMode: sec5[base] & 0x03,
        ships,
        loadouts,
        // Player 1's starting MAIN weapon (byte0 bits4-6). Metadata only —
        // nothing downstream branches on it.
        mainWeapon: startWeapons.main,
        // Shot damage stays keyed on byte0 bits0-2, the SUB field, because
        // that is the weapon the runtime's own autofire stands in for and the
        // field WEAPON_FULL_POWER_DAMAGE above was calibrated against. The
        // 2026-09-02 MAIN/SUB correction renamed the field under it and left
        // the value untouched; whether the pace should instead follow MAIN is
        // a separate question that would change every save's difficulty.
        shotDamage: weaponShotDamage(startWeapons.sub),
        // The 8 item slots (+0x1C..+0x23) — decoded 2026-08-28: each byte is
        // (movement << 4) | itemType. Types (effect pointer table +0x25ACC):
        // 0-3 = weapon change to loadout preset 0-3 (presets at +0x14..+0x1B),
        // 4 = barrier, 5 = bomb stock +1, 6 = score bonus (value picked by
        // byte +0x24 through the boss score table), 7 = power-up (shot level
        // +1), 8 = speed-up. Movement: 0 = launch-and-drift, 1 = bouncer,
        // 2 = scroll-anchored (rides the background).
        itemSlots: [...sec5.subarray(base + 0x1c, base + 0x24)].map((byte) => ({
            raw: byte,
            type: byte & 0x0f,
            movement: (byte >> 4) & 3,
        })),
        // +0x24: game-wide score-item value index into the boss score table
        // [5000,10000,20000,50000,100000,200000,500000,1000000] (+0x21F00).
        scoreItemValue: [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000][sec5[base + 0x24] & 7],
        bullets: {
            configs: [0x25, 0x26, 0x27, 0x28].map((o) => bulletConfig(sec5[base + o])),
            blast: {
                a: BLAST_HOLD_TABLE[sec5[base + 0x28] & 7],
                b: BLAST_HOLD_TABLE[(sec5[base + 0x28] >> 4) & 7],
            },
        },
        stageExtents,
        // +0x41..+0x58: the 24-entry BGM assignment table. Four special
        // tracks first — +0x41 title, +0x42 game over, +0x43 stage clear,
        // +0x44 all-clear (it keeps playing through the staff roll) — then a
        // (main, boss) pair per stage row from +0x45 (engine-traced
        // 2026-09-01: the stage start reads settings[+0x45 + 2*row], the boss
        // spawn +0x46 + 2*row; the earlier "three special tracks" reading
        // was off by one).
        bgmTable: [...sec5.subarray(base + 0x41, base + 0x59)],
        sfxSet: sec5[base + 0x59],
        // +0x01: HUD dressing — bits4-6 frame-graphic select (7 VDP2 tile
        // sets), bits0-2 HUD palette select (traced 2026-08-28).
        hudStyle: {
            frame: (sec5[base + 1] >> 4) & 7,
            palette: sec5[base + 1] & 7,
        },
        // +0x02..+0x0B: per-stage flag bytes. bit0 CLEAR = the row starts a
        // NEW numbered stage; SET = a continuation part (the stage number
        // holds and the music carries over — polarity adversarially
        // verified). bit6 = keep the scroll position on player death,
        // bit7 = the final stage (the game ends after it).
        stageFlags: [...sec5.subarray(base + 0x02, base + 0x0c)].map((b) => ({
            newStage: (b & 1) === 0,
            keepScrollOnDeath: (b & 0x40) !== 0,
            finalStage: (b & 0x80) !== 0,
        })),
        // +0x5A..+0x5C: the staff roll's three role labels — indices into the
        // engine's fixed 16-entry list (GAME.bin +0x20164).
        staffRoles: [0x5a, 0x5b, 0x5c].map((o) => STAFF_ROLE_LABELS[sec5[base + o] & 15]),
        staffRoleIndices: [0x5a, 0x5b, 0x5c].map((o) => sec5[base + o] & 15),
        // +0x29..+0x2C: the title screen's entrance program (TITLE_ENTRANCE).
        titleEntrance: decodeTitleEntrance(sec5, base),
        confidence: {
            mainWeapon: "confirmed",
            loadouts: "confirmed",
            itemSlots: "confirmed",
            bullets: "confirmed",
            stageExtents: "confirmed",
            bgmTable: "confirmed",
            sfxSet: "confirmed",
        },
    };
}
