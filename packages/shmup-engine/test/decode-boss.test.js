// Boss record (the enemy block's 0x40 trailer) — engine-traced decode.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  BOSS_HP_TABLE,
  decodeBossTrailer,
  PART_RESPAWN_FRAMES,
  PART_RESPAWN_FRAMES_F0,
  partRecord,
  readBossTrailer,
} from "../src/decode/decode-boss.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("an untouched (all-zero) trailer decodes to null", () => {
  assertStrictEquals(decodeBossTrailer(new Uint8Array(0x40)), null);
});

Deno.test({
  name: "ramsie stage 0's boss record decodes to the engine-verified values",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const b = readBossTrailer(decoded.sections[5].decompressed, 0);
    assertStrictEquals(b.sizeClass, 2);
    assertStrictEquals(b.hpStages, 4);
    assertStrictEquals(b.hp, 4608000);
    assertStrictEquals(b.score, 20000);
    assertStrictEquals(b.rotate, false);
    // HP band 1 cycles patterns 0,0,1,1; the last band pins pattern 3
    assertEquals(b.playlist[0], [0, 0, 1, 1]);
    assertEquals(b.playlist[3], [3, 3, 3, 3]);
    // pattern 0: two one-shot turret parts flanking the boss low, plus the
    // full-width special attack above it
    const p0 = b.patterns[0];
    assertStrictEquals(p0.moveScript, 0);
    assertStrictEquals(p0.moveSpeed, 2);
    assertStrictEquals(p0.fireTickFrames, 60);
    assertEquals(
      p0.firePoints.map((f) => [f.dx, f.dy, f.type]),
      [[-32, 28, 4], [30, 28, 4], [0, -25, 5]],
    );
    // record = the art band's base OR the piece (group 3 = records 32-47).
    // Both turrets are type 4, so their hp is the BOSS table at the fire
    // point's rate nibble shifted >>2 — not the record's own zako hp — while
    // score and the armour attribute still come off that record. Ramsie's are
    // armoured, i.e. indestructible contact hazards on hardware.
    assertEquals(p0.firePoints[0].spawn, {
      group: "zako32x32",
      piece: 14,
      record: 46,
      oneShot: true,
      hpSource: "boss",
      hp: 2496000,
      score: 500,
      armour: true,
    });
    assertEquals(p0.firePoints[1].spawn, {
      group: "zako32x32",
      piece: 13,
      record: 45,
      oneShot: true,
      hpSource: "boss",
      hp: 2496000,
      score: 500,
      armour: true,
    });
    // The rate nibble is the hp index on a type-4 arm, so it must agree with
    // the table it indexes rather than reading as a fire rate.
    assertStrictEquals(p0.firePoints[0].rate, 7);
    assertStrictEquals(BOSS_HP_TABLE[7] >> 2, 2496000);
  },
});

Deno.test("a type-4 turret takes the boss hp table >>2 at its rate nibble", () => {
  // One pattern, one type-4 fire point, rate nibble walked 0-7. Trailer byte 1
  // pins the CORE's hp index at 0 so a wrong table would be obvious.
  for (let rate = 0; rate < 8; rate++) {
    const t = new Uint8Array(0x40);
    t[0] = 0x01; // size class F1, one hp stage
    t[1] = 0x00; // core hp index 0
    t[8 + 2] = 0; // fire point 0: dx
    t[8 + 3] = 0; // dy
    t[8 + 4] = (rate << 4) | 4; // rate nibble | type 4
    t[8 + 5] = 0x00; // param: group 0, piece 0
    const boss = decodeBossTrailer(t);
    const spawn = boss.patterns[0].firePoints[0].spawn;
    assertStrictEquals(spawn.hpSource, "boss");
    assertStrictEquals(spawn.hp, BOSS_HP_TABLE[rate] >> 2);
    // The core's own hp is untouched by it.
    assertStrictEquals(boss.hp, BOSS_HP_TABLE[0]);
  }
});

Deno.test("a type-3 part reads its rate nibble as a respawn period, not hp", () => {
  const build = (sizeClass, rate) => {
    const t = new Uint8Array(0x40);
    t[0] = sizeClass;
    t[8 + 4] = (rate << 4) | 3; // type 3
    t[8 + 5] = 0x00;
    return decodeBossTrailer(t).patterns[0].firePoints[0].spawn;
  };
  for (let rate = 0; rate < 8; rate++) {
    // F1 and up take the common table; an F0 core takes the second one.
    assertStrictEquals(build(1, rate).respawnFrames, PART_RESPAWN_FRAMES[rate]);
    assertStrictEquals(
      build(0, rate).respawnFrames,
      PART_RESPAWN_FRAMES_F0[rate],
    );
    // Nothing on this arm reaches the boss hp table.
    assertStrictEquals(build(1, rate).hpSource, "record");
    assertStrictEquals(build(1, rate).hp, undefined);
  }
});

Deno.test("partRecord ORs the piece into the band base, as the engine does", () => {
  // The seven per-band constructors do `BASE[group] | piece` unmasked, so a
  // piece past its band's size runs on into the next band instead of wrapping.
  assertStrictEquals(partRecord(0, 0), 0);
  assertStrictEquals(partRecord(3, 14), 46); // Ramsie's turret
  assertStrictEquals(partRecord(1, 8), 24); // 16 | 8 — NOT 16 + (8 % 8)
  assertStrictEquals(partRecord(6, 3), 59); // 56 | 3, the last record
  assertStrictEquals(partRecord(7, 0), null); // no eighth band
});

Deno.test({
  name: "every placed boss carries a decoded behavior record",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assertStrictEquals(decoded.bosses.length, 5);
    for (const b of decoded.bosses) {
      assert(b.behavior, `stage ${b.stage} has a boss record`);
      // the trailer's own class matches the placement id's
      assertStrictEquals(b.behavior.sizeClass, b.sizeClass);
      assertStrictEquals(b.behavior.patterns.length, 4);
    }
  },
});
