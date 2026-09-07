// Stride arithmetic for every fixed table, on a zero-filled cart.

import { assertEquals, assertThrows } from "@std/assert";
import { decodeConfig, decodeHiScores, sliceSound } from "../src/sfc/tables.js";
import { decodeAppearData, decodeEnemyData } from "../src/sfc/enemy.js";
import { decodeMapData, decodeScrollEffect } from "../src/sfc/map.js";
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
  bytes[REGION.enemyData.offset + 5 * 0x80] = 1;
  const enemies = decodeEnemyData(bytes);
  assertEquals(enemies.length, 24);
  assertEquals(
    enemies.map((e) => e.offset),
    enemies.map((_, i) => 0x8000 + i * 0x80),
  );
  assertEquals(enemies.filter((e) => !e.blank).map((e) => e.index), [5]);
  const appear = decodeAppearData(bytes);
  assertEquals(
    appear.map((a) => a.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x8c00 + s * 0x1200),
  );
  assertEquals(appear[5].offset + 0x1200, REGION.enemyOdr.offset);
  const maps = decodeMapData(bytes);
  assertEquals(maps.length, 6);
  assertEquals(
    maps.map((m) => m.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x340 + s * 0x900),
  );
  assertEquals([maps[0].columns, maps[0].rows, maps[0].cells.length], [
    18,
    128,
    0x900,
  ]);
  bytes[REGION.map.offset + 0x900 + 3] = 0x9c;
  const stage1 = decodeMapData(bytes)[1];
  assertEquals([stage1.used, stage1.flagged, stage1.maxChip], [1, 1, 0x1c]);
  const scroll = decodeScrollEffect(bytes);
  assertEquals(
    scroll.map((s) => s.offset),
    [0, 1, 2, 3, 4, 5].map((s) => 0x3940 + s * 0x200),
  );
  assertEquals(scroll[5].offset + 0x200, REGION.mapGroup.offset);
  assertThrows(
    () => decodeMapData(new Uint8Array(0x1000)),
    Error,
    "runs past the end",
  );
});

Deno.test("the group tables have the ROM's counts", () => {
  const groups = decodeGroups(zero());
  assertEquals(groups.map.length, 192);
  assertEquals(groups.map[191].offset + 8, REGION.myShipOdr.offset);
  assertEquals(groups.enemy.length, 24);
  assertEquals(groups.enemy[0].quads.length, 4);
  assertEquals(groups.enemy[23].quads[3].offset + 8, REGION.bossGroup.offset);
  assertEquals(groups.boss.length, 6);
  assertEquals(groups.boss[0].quads.length, 8);
  assertEquals(groups.boss[5].quads[7].offset + 8, REGION.titleGroup.offset);
  assertEquals(groups.title.length, 8);
  assertEquals(groups.ending.length, 3);
  assertEquals(groups.ending[2].offset + 8, REGION.sound.offset);
  assertEquals(groups.myShip.length, 16);
  assertEquals(groups.myShip[15].offset + 8, 0x10000);
  assertEquals(groups.enemyOdr.length, 24);
  assertEquals(groups.enemyOdr[0].quads.length, 20);
  assertEquals(
    groups.enemyOdr[23].quads[19].offset + 4,
    REGION.myShipGroup.offset,
  );
  assertEquals(groups.myShipOdr.length, 16);
  // Zero words are tile 0 in palette 0, not the empty marker.
  assertEquals(groups.map[0].kind, null);
});

Deno.test("decodeGraphics tells a half dump from a blank bank from real tiles", () => {
  assertEquals(decodeGraphics(new Uint8Array(0x10000)), {
    offset: 0x10000,
    present: false,
    blank: true,
    tiles: [],
    usedCount: 0,
  });
  const blank = decodeGraphics(zero());
  assertEquals([blank.present, blank.blank, blank.tiles.length], [
    true,
    true,
    0,
  ]);
  const bytes = zero();
  bytes[0x10000 + 32 * 7] = 0x80; // tile 7, one pixel
  const graphics = decodeGraphics(bytes);
  assertEquals([graphics.blank, graphics.tiles.length, graphics.usedCount], [
    false,
    2048,
    1,
  ]);
  assertEquals(graphics.tiles[7][0], 1);
});
