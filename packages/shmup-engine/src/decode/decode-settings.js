// Dezaemon 2 global settings decoder — the 0x60-byte block at sec5 +0x5A780.
//
// Field map (FORMAT.md "Settings byte map"): +0x00 game mode, +0x0C..+0x0F and
// +0x10..+0x13 the two player-ship config blocks, +0x1C..+0x23 the 8 item
// slots, +0x41..+0x58 the BGM assignment table, +0x59 the SFX set.
//
// The ship block's last byte carries the MAIN WEAPON in its low nibble:
//   - KUMITATE (the game-assembly editor overlay) edits +0x0F/+0x13 as one
//     paired P1/P2 menu item (its literal pools list both addresses side by
//     side with the menu's own UI data);
//   - across the 17-game corpus the nibble spans 0,3,4,5,6,7 — an 8-option
//     menu — while every other ship byte holds 2-4 distinct values;
//   - the factory-default game (SGM_INIT = Gust) stores 6 there, and the play
//     engine's fire dispatcher (GAME.CMP +0x1cebc) reads a per-player weapon
//     variable whose id 6 routes to a spawn that exists for every save;
//     ids 5/6/7 dispatch to three distinct traced spawn routines.
// The settings->engine copy itself runs through pointer indirection that has
// not been traced instruction-by-instruction, so the identification is
// congruence (editor + corpus + defaults), not a byte-for-byte copy trace —
// which is why decodeSettings marks it "heuristic" rather than "confirmed".

import { SEC5_REGIONS } from "./decode-stage.js";

// Full-power damage of the player's shot, per main-weapon id, in the shared
// hp/damage units enemies decode in. Both fire dispatchers are segmented
// (GAME.CMP): the autofire jump table at +0x15144 (mova +0x15150) routes
//   0 -> none (returns -1: a weapon-0 save fires no main shot at all)
//   1 -> +0xf498   2 -> +0xfcac   3 -> +0xfe08   4 -> +0x104cc
//   5 -> exit (charge-type: fires only through the release dispatcher)
//   6 -> +0x1110c  7 -> +0x11ea8
// and the charge/release dispatcher at +0x1cebc routes 5 -> +0x10a6c
// (damage = charge-level table +0x6085e14 = [9,12,15,18,21]), 6 -> +0x113fc
// (bursts of fixed-damage-4 bullets, +0x11fd0), 7 -> +0x1204c.
//
// Damage per id — every entry engine-grounded, none blank:
//   - 0: fires no main shot at all (the dispatcher returns -1).
//   - 1: zeroes its damage slot at spawn (+0xf046) and deals damage through
//     per-contact exchange, armed via the clone helper +0xb620's arguments.
//   - 2/3: beam/wave contact weapons (weapon 3's beam objects carry a
//     10-frame contact window, +0x10110); damage flows per contact tick.
//   - 4: twin bullets of 27 each — the wrapper passes r5=27 (+0x10500) into
//     the spawn at +0x1038c, which stores it to both durability slots.
//   - 5: 21 at full charge (charge-level table +0x6085e14 = [9,12,15,18,21]).
//   - 6: charge path bursts fixed-damage-4 bullets (+0x11fd0); the autofire
//     stream threads damage through helper arguments (+0x111f0).
//   - 7: autofire is a contact/homing weapon; the charge shot is a single
//     192-damage hit (w-literal 0xC0 at +0x12484).
// The DIVISOR the importer uses is full-power per-ACTION damage. Contact and
// stream weapons exchange durability every frame of contact, so their
// per-action value is bounded below by the normal shot's 21 — that floor is
// the mechanism, not a guess. Charge-only values ride along as data.
export const WEAPON_SHOT_DAMAGE = {
    0: { damage: 21, basis: "none", note: "fires no main shot (dispatcher returns -1)" },
    1: { damage: 21, basis: "contact", note: "spawn zeroes dmg (+0xf046); armed per contact (+0xb620 args)" },
    2: { damage: 21, basis: "contact", note: "beam; per-contact exchange" },
    3: { damage: 21, basis: "contact", note: "beam, 10-frame contact window (+0x10110)" },
    4: { damage: 27, basis: "traced", note: "twin missiles, 27 each (r5 arg into +0x1038c)" },
    5: { damage: 21, basis: "traced", note: "charge shot, table +0x6085e14 full power" },
    6: { damage: 21, basis: "traced-burst", note: "4/bullet bursts (+0x11fd0); volley ~21" },
    7: { damage: 21, basis: "contact", chargeDamage: 192, note: "homing contact; charge single hit 192 (+0x12484)" },
};
export const DEFAULT_SHOT_DAMAGE = 21;

export function weaponShotDamage(weapon) {
    const w = WEAPON_SHOT_DAMAGE[weapon];
    return w ? w.damage : DEFAULT_SHOT_DAMAGE;
}

function shipBlock(sec5, base) {
    return {
        // +0: 0x10 or 0x11 across the corpus — a two-value item (meaning open)
        a: sec5[base],
        // +1: two packed nibbles, both small enums (meaning open)
        b: sec5[base + 1],
        // +2: KUMITATE-edited (paired P1/P2); values 0x40/0x41/0x44 (open)
        c: sec5[base + 2],
        // +3: low nibble = MAIN WEAPON 0-7; high nibble = SUB-WEAPON 0-3
        // (its own dispatcher at GAME.CMP +0x1528c serves the three
        // sub-weapon damage tables [16..24]/[8..32]/[48..96])
        mainWeapon: sec5[base + 3] & 0x0f,
        subWeapon: (sec5[base + 3] >> 4) & 0x03,
        raw: [...sec5.subarray(base, base + 4)],
    };
}

// Decode the settings block out of a decompressed sec5.
export function decodeSettings(sec5) {
    const base = SEC5_REGIONS.settings.offset;
    const ships = [shipBlock(sec5, base + 0x0c), shipBlock(sec5, base + 0x10)];
    return {
        gameMode: sec5[base] & 0x03,
        ships,
        // per-save shot damage: player 1's main weapon decides the pace
        shotDamage: weaponShotDamage(ships[0].mainWeapon),
        itemSlots: [...sec5.subarray(base + 0x1c, base + 0x24)],
        bgmTable: [...sec5.subarray(base + 0x41, base + 0x59)],
        sfxSet: sec5[base + 0x59],
        confidence: {
            mainWeapon: "heuristic",
            bgmTable: "confirmed",
            sfxSet: "confirmed",
        },
    };
}
