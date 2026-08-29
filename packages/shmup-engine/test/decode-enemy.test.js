// Enemy attribute decoder tests — the 18-byte record.
//
// Field offsets and tables come from the play engine's own spawn routine
// (GAME.CMP +0x153c8); the golden records below are real bytes from the
// DAIOH and Gust saves whose in-game behavior is known.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  appearanceFires,
  decodeEnemyRecord,
  hasTransforms,
  HP_TABLE,
  SCORE_TABLE,
  SPEED_TABLE,
  ZAKO_BAND_BASE,
  zakoRecordFromKey,
} from "../src/decode/decode-enemy.js";
import {
  ZAKO_SLOT_COUNT,
  zakoPlacementId,
} from "../src/decode/decode-stage.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const rec = (hex) => {
  const b = new Uint8Array(18);
  for (let i = 0; i < hex.length / 2; i++) {
    b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return b;
};

Deno.test("engine tables are the GAME.bin literals, byte for byte", () => {
  assertEquals(HP_TABLE, [60, 30, 15, 10, 5, 3, 2, 1]);
  assertEquals(SCORE_TABLE, [50, 100, 200, 500, 1000, 2000, 5000, 10000]);
  assertEquals(SPEED_TABLE, [
    256,
    12800,
    25600,
    51200,
    102400,
    204800,
    256000,
    512000,
  ]);
});

Deno.test("head fields: hp, score, ground, speed, death mode", () => {
  // DAIOH stage 0 record 0 — the most-placed enemy: b1=0x15 -> hp idx 5,
  // score idx 1; b2=0 -> stationary, no fire.
  const d = decodeEnemyRecord(rec("6b1500002811004400000000000000000000"));
  assertStrictEquals(d.hp, 3);
  assertStrictEquals(d.score, 100);
  assertStrictEquals(d.ground, false);
  assertStrictEquals(d.speed, SPEED_TABLE[0] / 65536);
  assertStrictEquals(d.death.mode, 0);
  assertStrictEquals(hasTransforms(d), false);

  // b1 bit7 = ground, bits0-2 hp, bits4-6 score
  const g = decodeEnemyRecord(rec("00f7000000000000000000000000000000000"));
  assertStrictEquals(g.ground, true);
  assertStrictEquals(g.hp, 1); // idx 7 -> weakest (the editor default)
  assertStrictEquals(g.score, 10000); // idx 7 -> top score
});

Deno.test("channels: rotation, scale, direction decode to editor units", () => {
  // rotation: b9=0x21 -> mode 1, step idx 2 (64/256 units/f);
  // b10=0x04 -> from angle idx 4 (180deg), to idx 0 (0deg); b11=0x20 repeat 2
  const d = decodeEnemyRecord(rec("000000000000000000210420000000000000"));
  assertStrictEquals(d.rotation.enabled, true);
  assertStrictEquals(d.rotation.mode, 1);
  assertStrictEquals(d.rotation.from, 180);
  assertStrictEquals(d.rotation.to, 0);
  assert(d.rotation.step < 0, "start > end steps downward");
  assertStrictEquals(d.rotation.repeat, 2);

  // scale: b12=0x11 -> mode 1 (XY) step idx 1; b13=0x82 -> from idx 2
  // (x0.5) to idx 8 (x4); b14=0x10 repeat 1
  const sc = decodeEnemyRecord(rec("000000000000000000000000118210000000"));
  assertStrictEquals(sc.scale.enabled, true);
  assertStrictEquals(sc.scale.axes, "xy");
  assertStrictEquals(sc.scale.from, 0.5);
  assertStrictEquals(sc.scale.to, 4);
  assert(sc.scale.step > 0);
  assertStrictEquals(sc.scale.repeat, 1);

  // direction: b15=0x11 -> enabled, step idx 1; b16=0x40 -> from idx 0
  // (0deg = up) to idx 4 (90deg = right)
  const dir = decodeEnemyRecord(rec("000000000000000000000000000000114000"));
  assertStrictEquals(dir.direction.enabled, true);
  assertStrictEquals(dir.direction.from, 0);
  assertStrictEquals(dir.direction.to, 90);
  assert(hasTransforms(dir));
});

Deno.test("fire config: interval tables select on mode", () => {
  // b4 = mode 0 rate idx 2. (b2 bits6-7 and b3 belong to the DEATH WORD, not
  // to firing — the engine's fire path never reads either byte.)
  const d = decodeEnemyRecord(rec("0000400b2000000000000000000000000000"));
  assertStrictEquals(d.fire.interval, 29); // FIRE_INTERVAL_TABLE[2]
  // mode 3 swaps to the alternate table
  const alt = decodeEnemyRecord(rec("0000400b2300000000000000000000000000"));
  assertStrictEquals(alt.fire.interval, 39); // FIRE_INTERVAL_TABLE_ALT[2]
});

Deno.test({
  name: "every populated corpus record decodes without throwing, in range",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const save = bup.parse(data).find((s) => s.payload);
    const d = decodeSave(save.payload.buffer);
    assert(d.enemies.length > 100);
    for (const e of d.enemies) {
      assert(e.behavior, `${e.key} carries decoded behavior`);
      assert(HP_TABLE.includes(e.behavior.hp));
      assert(SCORE_TABLE.includes(e.behavior.score));
      assert(e.behavior.speed >= 0 && e.behavior.speed < 8);
      assert(e.behavior.death.mode >= 0 && e.behavior.death.mode <= 3);
      assert(e.behavior.fire.interval >= 1 && e.behavior.fire.interval <= 119);
      for (const ch of [e.behavior.speedChange, e.behavior.scale]) {
        assert(ch.from >= 0 && ch.from <= 4, "factor channels stay in x0..x4");
        assert(ch.to >= 0 && ch.to <= 4);
      }
      for (const ch of [e.behavior.rotation, e.behavior.direction]) {
        assert(ch.from >= 0 && ch.from < 360);
        assert(ch.to >= 0 && ch.to < 360);
      }
    }
  },
});

Deno.test("b5 10/11/12 are special fire patterns, not angles", () => {
  // The dispatcher routes b5 & 0xF of 10/11/12 to three special handlers;
  // everything else reaches the default handler, which uses b5 & 0x1F as
  // the shot angle. Reading 10-12 as angles aimed those enemies sideways.
  const withB5 = (v) => {
    const bytes = new Uint8Array(18);
    bytes[0] = 0x21;
    bytes[5] = v;
    return decodeEnemyRecord(bytes);
  };
  for (const [v, pattern] of [[10, 0], [11, 1], [12, 2]]) {
    const d = withB5(v);
    assertStrictEquals(
      d.fire.pattern,
      pattern,
      `b5=${v} is pattern ${pattern}`,
    );
    assertStrictEquals(d.fire.direction, 0, "a pattern carries no angle");
  }
  // neighbouring values stay angles
  assertStrictEquals(withB5(9).fire.pattern, null);
  assertStrictEquals(withB5(9).fire.direction, 9);
  assertStrictEquals(withB5(13).fire.pattern, null);
  assertStrictEquals(withB5(13).fire.direction, 13);
});

Deno.test("movement decodes as a 2-bit mode plus an independent flag", () => {
  // The engine reads the packed byte bitwise (masks 0x1/0x2/0x3 and 0x4),
  // so it is not an 8-way enum.
  const withB2 = (v) => {
    const bytes = new Uint8Array(18);
    bytes[0] = 0x21;
    bytes[2] = v;
    return decodeEnemyRecord(bytes);
  };
  assertEquals(withB2(0x00).move, { mode: 0, flag: false });
  assertEquals(withB2(0x10).move, { mode: 1, flag: false });
  assertEquals(withB2(0x20).move, { mode: 2, flag: false });
  assertEquals(withB2(0x28).move, { mode: 2, flag: true });
  // the packed value the engine actually stores stays available
  assertStrictEquals(withB2(0x28).movePattern, 2 | 4);
});

Deno.test("the fire gate is the appearance, straight from the engine's table", () => {
  // 48 of 256 appearance ids carry the no-fire bit (dispatcher +0x19882).
  let silent = 0;
  for (let a = 0; a < 256; a++) if (!appearanceFires(a)) silent++;
  assertStrictEquals(silent, 48);
  // Lemureal's turrets (0x21, 0xc6) fire; its 0x85 props do not.
  assertStrictEquals(appearanceFires(0x21), true);
  assertStrictEquals(appearanceFires(0xc6), true);
  assertStrictEquals(appearanceFires(0x85), false);
  // the decoded record carries it as fire.enabled
  const firing = decodeEnemyRecord(rec("210081310000000000000000000000000000"));
  assertStrictEquals(firing.fire.enabled, true);
  const silentRec = decodeEnemyRecord(
    rec("850081310000000000000000000000000000"),
  );
  assertStrictEquals(silentRec.fire.enabled, false);
});

Deno.test("the editor-default record (Gust) decodes to the weakest enemy", () => {
  // Gust's most-placed record bytes: hp idx 7, score idx 0, no fire.
  const d = decodeEnemyRecord(rec("270700000000000000000000000000000000"));
  assertStrictEquals(d.hp, 1);
  assertStrictEquals(d.score, 50);
  assertStrictEquals(d.death.mode, 0);
});

// --- the death word (record b2 bits6-7 + b3, presentation from b4) ---------

Deno.test("death word: mode, parameter and presentation", () => {
  // mode 0 — the record says nothing happens on death.
  assertEquals(
    decodeEnemyRecord(rec("000000000c0000000000000000000000000")).death.mode,
    0,
  );

  // mode 1 (b2 bit6) — b3 is an ITEM SLOT, encoded (b3&8) ? 9 : (b3&7)+1.
  // This is the field this file used to call fire "count"/"wide".
  assertStrictEquals(
    decodeEnemyRecord(rec("000040040c0000000000000000000000000")).death.item,
    5,
  );
  assertStrictEquals(
    decodeEnemyRecord(rec("0000400c0c0000000000000000000000000")).death.item,
    9,
  ); // bit3 = cycling
  assertStrictEquals(
    decodeEnemyRecord(rec("000040000c0000000000000000000000000")).death.item,
    1,
  );

  // modes 2/3 (b2 bits6-7) — b3 is a placement cell byte minus its occupied
  // bit; the engine ORs 0x80 back on for both the child and the chain key.
  const child =
    decodeEnemyRecord(rec("000080210c0000000000000000000000000")).death;
  assertStrictEquals(child.mode, 2);
  assertStrictEquals(child.key, 0xa1);
  assertStrictEquals(child.record, 25);
  const chain =
    decodeEnemyRecord(rec("0000c03e0c0000000000000000000000000")).death;
  assertStrictEquals(chain.mode, 3);
  assertStrictEquals(chain.key, 0xbe);

  // b4 bits2-3 select the death PRESENTATION: 0 = vanish silently,
  // 2 = the small blast, 1 and 3 = the full one.
  assertStrictEquals(
    decodeEnemyRecord(rec("000000000000000000000000000000000000")).death.silent,
    true,
  );
  assertStrictEquals(
    decodeEnemyRecord(rec("000000000800000000000000000000000000")).death.small,
    true,
  );
  const full =
    decodeEnemyRecord(rec("000000000400000000000000000000000000")).death;
  assertEquals([full.silent, full.small], [false, false]);
});

Deno.test("placement cell byte <-> record index is the engine's band math", () => {
  // record index = BASE[band] | (cell & 15), the low nibble OR-ed UNMASKED
  // (+0x1A488 `or r4,r5`); the per-band mask shapes only the art.
  assertEquals(ZAKO_BAND_BASE, [0x00, 0x10, 0x18, 0x20, 0x30, 0x34, 0x38]);
  for (let record = 0; record < ZAKO_SLOT_COUNT; record++) {
    assertStrictEquals(zakoRecordFromKey(zakoPlacementId(record)), record);
  }
  // An index that overruns its band still selects a record, just not a
  // matching sprite — the engine does not mask it back.
  assertStrictEquals(zakoRecordFromKey(0x9c), 0x1c);
  // Band 7 is unreachable on the death path: +0x18E98 clamps it to band 0.
  assertStrictEquals(zakoRecordFromKey(0xf5), 5);
});
