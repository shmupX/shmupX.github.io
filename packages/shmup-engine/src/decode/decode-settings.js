// Dezaemon 2 global settings decoder — the 0x60-byte block at sec5 +0x5A780.
//
// Field map (FORMAT.md "Settings byte map"): +0x00 game mode, +0x0C..+0x0F and
// +0x10..+0x13 the two player-ship config blocks, +0x14..+0x1B the four
// weapon LOADOUT presets, +0x1C..+0x23 the 8 item slots, +0x24 the score-item
// value, +0x25..+0x28 the bullet configs + blast byte, +0x2D..+0x40 the
// scroll extents, +0x41..+0x58 the BGM assignment table, +0x59 the SFX set.
//
// The weapon system (fully traced 2026-08-28, adversarially verified —
// REPLACING the earlier heuristic "ship byte +3 low nibble = main weapon"):
// the four selects live in the LOADOUT pairs at +0x14+2k/+0x15+2k, loaded at
// player init (+0x90EC) and by weapon-change items (+0x1CF3C):
//   byte0 bits0-2 = MAIN weapon 0-7 (autofire dispatcher +0x15128)
//   byte0 bits4-6 = SUB / option weapon 0-7 (dispatcher +0x1509C)
//   byte1 bits0-1 = CHARGE type 0-3 (dispatcher +0x1528C)
//   byte1 bits4-7 = BOMB type (bits4-6, bit7 a variant flag; 16-way
//                   dispatcher +0x151B0)
// Ship block (4 B per player at +0x0C / +0x10):
//   +0 = 0x10 | starting loadout index (engine reads only &3)
//   +1 = maxSpeedLevel<<4 | rapid-fire param (manual interval 8-v frames)
//   +2 = maxPowerLevel<<4 | initialPowerLevel (both <= 4)
//   +3 low nibble = AUTOFIRE RATE index -> [60,30,15,10,5,3,2,1] frames/volley

import { SEC5_REGIONS } from "./decode-stage.js";

// Full-power (level 4) per-bullet main-shot damage, in the engine's u32
// attack-power units (0x608C720; enemy LIFE stores as LIFE<<8, so a
// [60,30,..] zako has 15360..256 units). Read out of the spawn sites
// (per-level u32 tables; weapons 1/2/3/7 deliberately LOWER per-bullet
// damage as the power level rises while adding projectiles):
//   1: +0x21D6C [13312..5120]   2: +0x21D8C [19712..11520]
//   3: +0x21DAC [256..128] (homing, many contacts)
//   4: +0x21DCC [1024..1152]    5 tap: +0x21DEC [1024..1280]
//   6: 384 per bullet           7: +0x21C80 [7680..3584] per beam frame
export const WEAPON_FULL_POWER_DAMAGE = {
    0: 5120,   // fires no main shot; keep the anchor pace
    1: 5120,
    2: 11520,
    3: 5120,   // homing stream: 128/contact, many contacts/frame — floored
    4: 5120,   // twin 1152 missiles + sub coverage — floored
    5: 5120,   // 1280 tap + 7168/pellet charge — floored
    6: 5120,   // 384/bullet at 1-frame intervals — floored
    7: 5120,   // 3584..7680 per beam frame — floored
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
// stores (speed*sin)>>16 into 24.8 positions, so px/frame = units/512:
// 0.25/0.5/1.0/1.75 on top of the rank-driven base u16[0x608EF30] = 4*rank.
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

// The engine's 16 fixed staff-roll role labels (GAME.bin pointer table
// +0x20164); settings +0x5A..+0x5C pick three of them for the ending.
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
        main: b0 & 7,
        sub: (b0 >> 4) & 7,
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
        // per-save shot damage: player 1's starting main weapon sets the pace
        mainWeapon: startWeapons.main,
        shotDamage: weaponShotDamage(startWeapons.main),
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
