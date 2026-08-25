// Settings-block decoder: the two ship configs, the per-save main weapon and
// the shot damage the mapper divides enemy LIFE by.
import { assert, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeSettings,
  DEFAULT_SHOT_DAMAGE,
  WEAPON_SHOT_DAMAGE,
  weaponShotDamage,
} from "../src/decode/decode-settings.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test({
  name: "ramsie's settings decode to its authored config",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    assertStrictEquals(d.settings.ships[0].mainWeapon, 7);
    assertStrictEquals(d.settings.ships[1].mainWeapon, 7);
    assertStrictEquals(d.settings.gameMode, 2);
    assertStrictEquals(d.settings.sfxSet, 3); // SF bank
    assertStrictEquals(d.settings.shotDamage, 21);
    // BGM table entries always index the 24 song slots
    assert(d.settings.bgmTable.every((v) => v >= 0 && v <= 23));
    assertStrictEquals(d.confidence.settings, "heuristic");
  },
});

Deno.test({
  name: "mucha-kucha's two ships carry different weapons",
  ignore: !hasFixtures("mucha-kucha.sav"),
  async fn() {
    const d = await decodedFixture("mucha-kucha.sav");
    assertStrictEquals(d.settings.ships[0].mainWeapon, 4);
    assertStrictEquals(d.settings.ships[1].mainWeapon, 6);
    assertStrictEquals(d.settings.sfxSet, 1); // REAL bank
    // weapon 4's traced twin-missile damage drives its divisor
    assertStrictEquals(d.settings.shotDamage, 27);
  },
});

Deno.test({
  name: "ramsie's sub-weapons decode alongside the mains",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    // ramsie ships: +0x0F = 0x07 both -> main 7, sub 0
    assertStrictEquals(d.settings.ships[0].subWeapon, 0);
    assertStrictEquals(d.settings.ships[1].subWeapon, 0);
  },
});

Deno.test("shot damage lookup: traced weapons and the safe fallback", () => {
  // weapon 5's normal shot is the fully traced table; every other id falls
  // back to the traced minimum so an untraced weapon can only make enemies
  // slightly tankier, never unkillable.
  assertStrictEquals(WEAPON_SHOT_DAMAGE[5].basis, "traced");
  for (let w = 0; w < 8; w++) {
    const dmg = weaponShotDamage(w);
    assert(dmg >= DEFAULT_SHOT_DAMAGE, `weapon ${w} -> ${dmg}`);
  }
  assertStrictEquals(weaponShotDamage(99), DEFAULT_SHOT_DAMAGE);
});

Deno.test("every weapon id has an engine-grounded damage entry", () => {
  for (let w = 0; w < 8; w++) {
    const e = WEAPON_SHOT_DAMAGE[w];
    assert(e && e.damage >= DEFAULT_SHOT_DAMAGE, `weapon ${w}`);
    assert(e.basis, `weapon ${w} carries its basis`);
  }
  // the two constants that were traced outright
  assertStrictEquals(WEAPON_SHOT_DAMAGE[4].damage, 27);
  assertStrictEquals(WEAPON_SHOT_DAMAGE[7].chargeDamage, 192);
});

Deno.test("decodeSettings reads the block at sec5 +0x5A780", () => {
  const sec5 = new Uint8Array(396640);
  const S = 0x5a780;
  sec5[S] = 0x02; // game mode
  sec5.set([0x10, 0x72, 0x40, 0x35], S + 0x0c); // ship 1: weapon 5, alt 3
  sec5.set([0x11, 0x72, 0x41, 0x06], S + 0x10); // ship 2: weapon 6, alt 0
  sec5[S + 0x59] = 2; // COMIC sfx
  const st = decodeSettings(sec5);
  assertStrictEquals(st.gameMode, 2);
  assertStrictEquals(st.ships[0].mainWeapon, 5);
  assertStrictEquals(st.ships[0].subWeapon, 3);
  assertStrictEquals(st.ships[1].mainWeapon, 6);
  assertStrictEquals(st.shotDamage, 21);
  assertStrictEquals(st.sfxSet, 2);
});
