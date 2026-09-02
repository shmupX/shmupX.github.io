// Settings-block decoder: the two ship configs, the per-save main weapon and
// the shot damage the mapper divides enemy LIFE by.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeSettings,
  decodeTitleEntrance,
  DEFAULT_SHOT_DAMAGE,
  TITLE_ENTRANCE,
  TITLE_ENTRANCE_FRAMES,
  TITLE_ENTRANCE_NAMES,
  WEAPON_FULL_POWER_DAMAGE,
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
    // Ship blocks (weapon-system trace 2026-08-28): starting loadout 0
    // whose pair 0x21/0xD1 = main 1, sub 2, charge 1, bomb 5 + variant.
    assertStrictEquals(d.settings.ships[0].startLoadout, 0);
    assertStrictEquals(d.settings.ships[0].autofireFrames, 1); // rate idx 7
    assertStrictEquals(d.settings.ships[0].maxPower, 4);
    assertStrictEquals(d.settings.mainWeapon, 1);
    assertEquals(d.settings.loadouts[0], {
      main: 1,
      sub: 2,
      charge: 1,
      bomb: 5,
      bombVariant: true,
      raw: [0x21, 0xd1],
    });
    assertStrictEquals(d.settings.gameMode, 2);
    assertStrictEquals(d.settings.sfxSet, 3); // SF bank
    // full-power weapon-1 bullet = 5120 units = 20 LIFE units/hit
    assertStrictEquals(d.settings.shotDamage, 20);
    // BGM table entries always index the 24 song slots
    assert(d.settings.bgmTable.every((v) => v >= 0 && v <= 23));
    assertStrictEquals(d.confidence.settings, "confirmed");
  },
});

Deno.test({
  name: "mucha-kucha's loadouts decode with their own weapons",
  ignore: !hasFixtures("mucha-kucha.sav"),
  async fn() {
    const d = await decodedFixture("mucha-kucha.sav");
    // start loadout 0 = pair 0x13/0x61 -> main 3, sub 1, charge 1, bomb 6
    assertStrictEquals(d.settings.mainWeapon, 3);
    assertStrictEquals(d.settings.loadouts[0].sub, 1);
    assertStrictEquals(d.settings.loadouts[0].bomb, 6);
    assertStrictEquals(d.settings.sfxSet, 1); // REAL bank
    assertStrictEquals(d.settings.shotDamage, 20);
  },
});

Deno.test({
  name: "ramsie's item slots decode as movement/type pairs",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    for (const slot of d.settings.itemSlots) {
      assert(slot.type >= 0 && slot.type <= 8, `type ${slot.type}`);
      assert(
        slot.movement >= 0 && slot.movement <= 2,
        `movement ${slot.movement}`,
      );
    }
    assert(d.settings.scoreItemValue >= 5000);
  },
});

Deno.test("shot damage lookup: traced tables with the anchored floor", () => {
  // Weapon damages are the traced full-power per-bullet u32 tables; stream
  // and contact weapons floor at weapon 1's 5120 units (20 LIFE units), so
  // no save's enemies become unkillable under the runtime's 1-damage shots.
  for (let w = 0; w < 8; w++) {
    assert(WEAPON_FULL_POWER_DAMAGE[w] >= 5120, `weapon ${w}`);
    assert(weaponShotDamage(w) >= DEFAULT_SHOT_DAMAGE, `weapon ${w} divisor`);
  }
  // weapon 2's full-power bullet is genuinely heavier: 11520 units
  assertStrictEquals(weaponShotDamage(2), 45);
  assertStrictEquals(weaponShotDamage(99), DEFAULT_SHOT_DAMAGE);
});

Deno.test("decodeSettings reads the block at sec5 +0x5A780", () => {
  const sec5 = new Uint8Array(396640);
  const S = 0x5a780;
  sec5[S] = 0x02; // game mode
  sec5.set([0x11, 0x72, 0x41, 0x06], S + 0x0c); // ship 1: loadout 1, autofire idx 6
  sec5.set([0x10, 0x72, 0x41, 0x06], S + 0x10); // ship 2: loadout 0
  sec5.set([0x15, 0x11, 0x52, 0x22], S + 0x14); // loadouts 0/1
  sec5[S + 0x59] = 2; // COMIC sfx
  const st = decodeSettings(sec5);
  assertStrictEquals(st.gameMode, 2);
  assertStrictEquals(st.ships[0].startLoadout, 1);
  assertStrictEquals(st.ships[0].autofireFrames, 2); // rate idx 6
  // P1 starts on loadout 1 = pair 0x52/0x22 -> main 2, sub 5, charge 2, bomb 2
  assertStrictEquals(st.mainWeapon, 2);
  assertStrictEquals(st.loadouts[1].sub, 5);
  assertStrictEquals(st.loadouts[1].bomb, 2);
  assertStrictEquals(st.shotDamage, 45);
  assertStrictEquals(st.sfxSet, 2);
});

// --- Title entrance (+0x29..+0x2C) and staff-roll labels (+0x5A..+0x5C) ---

Deno.test("the title entrance decodes ten tri-state fields out of +0x29..+0x2C", () => {
  const base = 0x5a780;
  const sec5 = new Uint8Array(base + 0x60);
  sec5[base + 0x29] = 0x19; // bits 0-1 = 1, 2-3 = 2, 4-5 = 1  (TITLE 2, byte A)
  sec5[base + 0x2a] = 0x0a; // bits 0-1 = 2, 2-3 = 2            (TITLE 2, byte B)
  sec5[base + 0x2b] = 0x24; // bits 0-1 = 0, 2-3 = 1, 4-5 = 2  (TITLE 1, byte A)
  sec5[base + 0x2c] = 0x05; // bits 0-1 = 1, 2-3 = 1            (TITLE 1, byte B)
  const t = decodeTitleEntrance(sec5, base);
  assertEquals(t.title2, {
    y: 1,
    x: 2,
    spin: 1,
    scaleH: 2,
    scaleW: 2,
    raw: [0x19, 0x0a],
  });
  assertEquals(t.title1, {
    y: 0,
    x: 1,
    spin: 2,
    scaleH: 1,
    scaleW: 1,
    raw: [0x24, 0x05],
  });
  // decodeSettings carries the same object
  assertEquals(decodeSettings(sec5).titleEntrance, t);
  // the names the editor's icons stand for
  assertStrictEquals(TITLE_ENTRANCE_NAMES.y[1], "fromAbove");
  assertStrictEquals(TITLE_ENTRANCE_NAMES.x[2], "fromLeft");
  assertStrictEquals(TITLE_ENTRANCE_NAMES.spin[1], "clockwise");
  assertStrictEquals(TITLE_ENTRANCE_NAMES.scale[2], "grow");
});

Deno.test("every animated entrance field lands on the rest pose after exactly 128 frames", () => {
  assertStrictEquals(TITLE_ENTRANCE_FRAMES, 128);
  for (const v of [1, 2]) {
    assertStrictEquals(
      TITLE_ENTRANCE.y[v].from + 128 * TITLE_ENTRANCE.y[v].step,
      80,
    );
    assertStrictEquals(
      TITLE_ENTRANCE.x[v].from + 128 * TITLE_ENTRANCE.x[v].step,
      160,
    );
    assertStrictEquals(
      TITLE_ENTRANCE.scale[v].from + 128 * TITLE_ENTRANCE.scale[v].step,
      1,
    );
    assertStrictEquals(Math.abs(TITLE_ENTRANCE.spin[v]), 1);
  }
  // 0 and the never-written 3 are the engine's static branch
  for (const v of [0, 3]) {
    assertStrictEquals(TITLE_ENTRANCE.y[v], null);
    assertStrictEquals(TITLE_ENTRANCE.x[v], null);
    assertStrictEquals(TITLE_ENTRANCE.scale[v], null);
    assertStrictEquals(TITLE_ENTRANCE.spin[v], 0);
  }
});

Deno.test("staff-role labels come with their raw indices", () => {
  const base = 0x5a780;
  const sec5 = new Uint8Array(base + 0x60);
  sec5[base + 0x5a] = 13;
  sec5[base + 0x5b] = 0;
  sec5[base + 0x5c] = 0x1f; // only the low nibble indexes the 16-label list
  const s = decodeSettings(sec5);
  assertEquals(s.staffRoleIndices, [13, 0, 15]);
  assertEquals(s.staffRoles, ["GRAPHIC", "", "THANKS"]);
});

Deno.test({
  name: "ramsie's title entrance and staff labels decode as authored",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    // +0x29..+0x2C = 00 08 10 06: TITLE 2 grows its width from nothing,
    // TITLE 1 spins once clockwise while its height grows and its width
    // shrinks from double
    assertEquals(d.settings.titleEntrance.title2, {
      y: 0,
      x: 0,
      spin: 0,
      scaleH: 0,
      scaleW: 2,
      raw: [0x00, 0x08],
    });
    assertEquals(d.settings.titleEntrance.title1, {
      y: 0,
      x: 0,
      spin: 1,
      scaleH: 2,
      scaleW: 1,
      raw: [0x10, 0x06],
    });
    assertEquals(d.settings.staffRoleIndices, [13, 2, 12]);
    assertEquals(d.settings.staffRoles, ["GRAPHIC", "PRODUCE", "PRESENTED BY"]);
  },
});
