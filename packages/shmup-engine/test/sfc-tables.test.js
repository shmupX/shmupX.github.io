// Stride arithmetic for every fixed table, on a zero-filled cart.

import { assertEquals, assertThrows } from "@std/assert";
import { decodeConfig, decodeHiScores, sliceSound } from "../src/sfc/tables.js";
import {
  decodeAppearByte,
  decodeAppearData,
  decodeEnemyData,
  encodeAppearByte,
  encodeEnemyEntry,
} from "../src/sfc/enemy.js";
import {
  decodeMapData,
  decodeMapRow,
  decodeScrollEffect,
  encodeMapRow,
  writeDefaultScroll,
} from "../src/sfc/map.js";
import { decodeGroups } from "../src/sfc/groups.js";
import { decodeGraphics } from "../src/sfc/graphics.js";
import { REGION } from "../src/sfc/regions.js";

const zero = () => new Uint8Array(0x20000);

Deno.test("decodeHiScores reads 20 entries of 16 bytes from 0x7E8E", () => {
  const bytes = zero();
  bytes.set([0xe8, 0x03, 0, 0, 1, 2, 3, 4], REGION.hiScore.offset);
  bytes.set(
    Array.from("ABCDEFGH", (c) => c.charCodeAt(0)),
    REGION.hiScore.offset + 8,
  );
  const entries = decodeHiScores(bytes);
  assertEquals(entries.length, 20);
  assertEquals(entries[0].rank, 1);
  assertEquals(entries[0].score, 1000);
  assertEquals(Array.from(entries[0].extra), [1, 2, 3, 4]);
  assertEquals(entries[0].name, "ABCDEFGH");
  assertEquals(entries[19].offset, 0x7e8e + 19 * 16);
  assertEquals(entries[19].offset + 16, REGION.keyConfig.offset);
  assertThrows(
    () => decodeHiScores(new Uint8Array(0x7000)),
    Error,
    "runs past the end",
  );
});

Deno.test("decodeConfig reads the words and byte fields around the checksum copy", () => {
  const bytes = zero();
  bytes.set([0x0a, 0x02], REGION.titleType.offset);
  bytes.set([0x34, 0x12], REGION.mouseSpeed.offset);
  bytes.set([0x05, 0x00], REGION.editBgm.offset);
  bytes[REGION.bgmPatch.offset + 15] = 0x1b;
  bytes.set([0x20, 0x08, 0x10, 0x20], REGION.keyConfig.offset);
  const config = decodeConfig(bytes);
  assertEquals(config.titleType, 0x020a);
  assertEquals(config.mouseSpeed, 0x1234);
  assertEquals(config.editBgm, 5);
  assertEquals(config.bgmPatch.length, 16);
  assertEquals(config.bgmPatch[15], 0x1b);
  assertEquals(Array.from(config.keyConfig), [0x20, 0x08, 0x10, 0x20]);
  assertEquals(config.reserved0.length, 32);
  assertEquals(config.reserved1.length, 38);
  assertEquals(sliceSound(bytes).length, 11776);
});

Deno.test("enemy, appearance, map and scroll tables use the ROM strides", () => {
  const bytes = zero();
  // stage 5, class 3, entry 2: pattern 9 speed 1, score byte 7
  const at = REGION.enemyData.offset + 5 * 0x200 + 0x180 + 2 * 8;
  bytes.set([0x49, 0, 0, 0, 0, 7], at);
  // the sample's straight-down popcorn, decoded and re-encoded
  assertEquals(
    encodeEnemyEntry({ family: 1, variant: 2, hp: 0, score: 0, anim: 0 }),
    [0x0a, 0, 0, 0, 0, 0, 0, 0],
  );
  const enemies = decodeEnemyData(bytes);
  assertEquals(enemies.length, 6);
  assertEquals(
    enemies.map((e) => e.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x8000 + s * 0x200),
  );
  assertEquals(enemies[5].offset + 0x200, REGION.appear.offset);
  assertEquals(enemies[5].classes.map((c) => c.entries.length), [
    16,
    16,
    16,
    8,
    4,
  ]);
  assertEquals(enemies[5].classes[3].entries[2].fields.family, 9);
  assertEquals(enemies[5].classes[3].entries[2].fields.variant, 1);
  assertEquals(enemies[5].classes[3].entries[2].fields.shotParam, 7);
  assertEquals(enemies[5].used, 1);
  assertEquals(
    enemies[5].boss.offset,
    REGION.enemyData.offset + 5 * 0x200 + 0x1e0,
  );
  assertEquals(enemies[5].boss.blank, true);
  assertEquals(enemies[0].used, 0);
  assertEquals(encodeEnemyEntry(enemies[5].classes[3].entries[2].fields), [
    0x49,
    0,
    0,
    0,
    0,
    7,
    0,
    0,
  ]);

  // appear: stage 1, record 2 spawns class 3 entry 5 in column 4; line 40 fires it
  const a1 = REGION.appear.offset + 0x1200;
  bytes[a1 + 2 * 14 + 3] = 0x80 | (3 << 4) | 5;
  bytes[a1 + 0xe00 + 40] = 2;
  const appear = decodeAppearData(bytes);
  assertEquals(
    appear.map((a) => a.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x8c00 + s * 0x1200),
  );
  assertEquals(appear[5].offset + 0x1200, REGION.enemyOdr.offset);
  assertEquals(appear[1].records[2].spawns, [{
    column: 4,
    klass: 3,
    entry: 5,
  }]);
  assertEquals(appear[1].lines[40], 2);
  assertEquals([appear[1].used, appear[1].spawns, appear[1].lastLine], [
    1,
    1,
    40,
  ]);
  assertEquals(appear[0].blank, true);
  assertEquals(decodeAppearByte(0x80 | (3 << 4) | 5), {
    byte: 0xb5,
    valid: true,
    klass: 3,
    entry: 5,
  });
  assertEquals(encodeAppearByte({ klass: 3, entry: 5 }), 0xb5);

  // map: stage 1, row 0, cell 3 names slot 0x1c h-flipped; the flag byte v-flips cell 0
  const maps = decodeMapData(bytes);
  assertEquals(maps.length, 6);
  assertEquals(
    maps.map((m) => m.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x340 + s * 0x900),
  );
  assertEquals([maps[0].columns, maps[0].rows, maps[0].slots.length], [
    16,
    128,
    2048,
  ]);
  bytes[REGION.map.offset + 0x900 + 3] = 0x9c;
  bytes[REGION.map.offset + 0x900 + 8] = 0x80;
  const stage1 = decodeMapData(bytes)[1];
  assertEquals([stage1.used, stage1.flipped, stage1.maxSlot], [1, 2, 0x1c]);
  assertEquals([stage1.slots[3], stage1.hflips[3], stage1.vflips[0]], [
    0x1c,
    1,
    1,
  ]);
  const row = decodeMapRow(bytes, REGION.map.offset + 0x900);
  assertEquals(row[3], { slot: 0x1c, hflip: true, vflip: false });
  const back = new Uint8Array(18);
  encodeMapRow(back, 0, row);
  assertEquals(
    Array.from(back),
    Array.from(
      bytes.subarray(REGION.map.offset + 0x900, REGION.map.offset + 0x900 + 18),
    ),
  );

  const scroll = decodeScrollEffect(bytes);
  assertEquals(
    scroll.map((s) => s.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x3940 + s * 0x200),
  );
  assertEquals(scroll[5].offset + 0x200, REGION.mapGroup.offset);
  assertEquals([scroll[0].effect.length, scroll[0].speed.length], [256, 256]);
  writeDefaultScroll(bytes, 2);
  const s2 = decodeScrollEffect(bytes)[2];
  assertEquals([s2.effect[0], s2.effect[33], s2.speed[0], s2.min, s2.max], [
    0,
    1,
    0x42,
    0x42,
    0x42,
  ]);
  assertThrows(
    () => decodeMapData(new Uint8Array(0x1000)),
    Error,
    "runs past the end",
  );
});

Deno.test("the group tables have the ROM's counts", () => {
  const groups = decodeGroups(zero());
  assertEquals(groups.map.length, 6);
  assertEquals(groups.map[0].chips.length, 128);
  assertEquals(groups.map[5].offset + 0x100, REGION.myShipOdr.offset);
  assertEquals(groups.enemy.length, 6);
  assertEquals(groups.enemy[0].chips.length, 64);
  assertEquals(groups.enemy[5].offset + 0x80, REGION.bossGroup.offset);
  assertEquals(groups.boss[0].chips.length, 32);
  assertEquals(groups.boss[5].offset + 0x40, REGION.titleGroup.offset);
  assertEquals(groups.title.length, 32);
  assertEquals(groups.ending.length, 12);
  assertEquals(groups.ending[11].offset + 2, REGION.sound.offset);
  assertEquals(groups.myShip.length, 64);
  assertEquals(groups.myShip[63].offset + 2, 0x10000);
  assertEquals(groups.enemyOdr.length, 6);
  assertEquals(groups.enemyOdr[0].quads.length, 80);
  assertEquals(
    groups.enemyOdr[5].quads[79].offset + 4,
    REGION.myShipGroup.offset,
  );
  assertEquals(groups.myShipOdr.length, 64);
  // a zero word is user chip 0, not an empty slot; the blank words are
  assertEquals(groups.map[0].chips[0].empty, false);
  assertEquals(groups.map[0].chips[0].index, 0);
  assertEquals(decodeGraphics(zero()).blank, true);
});
