// Dezaemon+: the program's own scatter/gather table, the group checksums it
// writes while gathering, and the per-stage pieces the table names.

import { assert, assertEquals } from "@std/assert";
import {
  decodePlusAppear,
  decodePlusAppearByte,
  decodePlusEnemyData,
  decodePlusGraphics,
  decodePlusGroupWord,
  decodePlusHiScores,
  decodePlusMapRow,
  decodePlusPalettes,
  decodePlusScroll,
  decodePlusStage,
  isPlusBlock,
  parsePlusSave,
  PLUS_BLOCK_SIZE,
  PLUS_CHECKED_GROUPS,
  PLUS_CHECKSUM_OFFSET,
  PLUS_ENEMY_COUNT,
  PLUS_GLOBAL_LAYOUT,
  PLUS_GLOBAL_SIZE,
  PLUS_MAP_COLUMNS,
  PLUS_REGIONS,
  PLUS_STAGE_LAYOUT,
  PLUS_STAGE_SIZE,
  PLUS_STAGES_OFFSET,
  PLUS_TABLE,
  plusChecksums,
  plusPaletteRow,
} from "../src/psx/plus.js";
import { identifyGame, parsePsxSav } from "../src/psx/index.js";
import { buildCard, buildPlusBlock } from "./_psx-synthetic.js";

Deno.test("the 74-entry table tiles the file exactly and its groups run in order", () => {
  assertEquals(PLUS_TABLE.length, 74);
  let at = 0;
  for (const row of PLUS_TABLE) {
    assertEquals(row.offset, at, `entry ${row.index}`);
    at = row.offset + row.length;
  }
  assertEquals(at, PLUS_BLOCK_SIZE);
  // A flag group is contiguous: once it ends it never comes back.
  const seen = new Set();
  let last = null;
  for (const row of PLUS_TABLE) {
    if (row.flag !== last) {
      assert(!seen.has(row.flag), `flag ${row.flag} reappears`);
      seen.add(row.flag);
      last = row.flag;
    }
  }
  assertEquals(seen.size, 20);
  assertEquals(PLUS_TABLE.at(-1).offset, PLUS_CHECKSUM_OFFSET);
  // The five stages are 0x223C apart, which is what the checksum pins.
  const maps = PLUS_TABLE.filter((r) => r.sub.startsWith("MAP ("));
  assertEquals(maps.length, 5);
  assertEquals(
    maps.map((r) => r.offset - PLUS_STAGES_OFFSET),
    [0, 1, 2, 3, 4].map((s) => s * PLUS_STAGE_SIZE),
  );
});

Deno.test("the group checksums round-trip, and a flipped byte lands in exactly one group", () => {
  const { block } = buildPlusBlock();
  const first = plusChecksums(block);
  assertEquals(first.ok, true);
  assertEquals(first.bad, []);
  assertEquals(first.checkedGroups, PLUS_CHECKED_GROUPS);
  assertEquals(first.computed.length, 20);

  // A byte inside stage 2's map belongs to flag group 8 (6 + stage). Its
  // offset within the entry must not be a multiple of 32 — see the next test.
  const at = PLUS_STAGES_OFFSET + 2 * PLUS_STAGE_SIZE + 0x41;
  block[at] ^= 0xff;
  const second = plusChecksums(block);
  assertEquals(second.ok, false);
  assertEquals(second.bad, [8]);
  block[at] ^= 0xff;
  assertEquals(plusChecksums(block).ok, true);
});

Deno.test("a byte multiplied by zero still moves its group, because every byte also adds the entry index", () => {
  const { block } = buildPlusBlock();
  // Offset 0x20 within an entry has (offset & 0x1F) === 0, so the byte's own
  // value drops out of the sum — the frame and index terms still cover it.
  const at = PLUS_STAGES_OFFSET + 0x20;
  block[at] ^= 0x55;
  const changed = plusChecksums(block);
  assertEquals(changed.bad, []);
  assertEquals(changed.ok, true);
});

Deno.test("palettes, graphics and the stage pieces decode from a synthetic block", () => {
  const { block } = buildPlusBlock();
  assertEquals(isPlusBlock(block), true);
  const palettes = decodePlusPalettes(block);
  assertEquals(palettes.length, 24);
  assertEquals(palettes[3].colors[0].empty, true);
  assertEquals(palettes[3].colors[5].raw, 0x8000 | (3 * 16 + 5));
  assertEquals(palettes[3].colors[5].stp, true);

  const graphics = decodePlusGraphics(block);
  assertEquals([graphics.width, graphics.height, graphics.pages], [
    256,
    512,
    2,
  ]);
  assertEquals(graphics.indexed[0], 0);
  assertEquals(graphics.indexed[2], 7); // byte 1 = 0x07, low nibble is the left pixel
  assertEquals(graphics.indexed[3], 0);

  const parsed = parsePlusSave(block, { filename: "BISLPS-00335DEZA" });
  assertEquals(parsed.errors, []);
  assertEquals(parsed.checksums.ok, true);
  assertEquals(parsed.stages.length, 5);
  assertEquals(parsed.stages[0].parts.appear.length, 0x1200);
  assertEquals(parsed.stages[0].parts.mapGroup.length, 0x100);
  assertEquals(parsed.sound.length, 16);
  assertEquals(parsed.sound[0].bytes.length, 0x2e0);
  assertEquals(parsed.settings.bytes.length, 8);
});

Deno.test("a map row is eight chips, a v-flip byte, eight chips, a v-flip byte", () => {
  const row = new Uint8Array(18);
  row[0] = 0x00; // column 0 is empty in every real save
  row[1] = 0x05;
  row[2] = 0x85; // bit 7 = horizontal flip
  row[9] = 0x11;
  row[16] = 0x00;
  row[8] = 0b0100_0000; // bit 6 -> the second chip of the first half (column 1)
  row[17] = 0b1000_0000; // bit 7 -> the first chip of the second half (column 8)
  const chips = decodePlusMapRow(row);
  assertEquals(chips.length, PLUS_MAP_COLUMNS);
  assertEquals(chips[0].blank, true);
  assertEquals(chips[1], {
    raw: 0x05,
    group: 5,
    hflip: false,
    vflip: true,
    blank: false,
  });
  assertEquals(chips[2], {
    raw: 0x85,
    group: 5,
    hflip: true,
    vflip: false,
    blank: false,
  });
  assertEquals(chips[8], {
    raw: 0x11,
    group: 0x11,
    hflip: false,
    vflip: true,
    blank: false,
  });
  assertEquals(chips[15].blank, true);
});

Deno.test("a MAP GROUP word is a clamped 10-bit tile number, and its buffer's low bit picks the half", () => {
  assertEquals(decodePlusGroupWord(0x0000), {
    raw: 0,
    tile: 0,
    column: 0,
    row: 0,
    page: 0,
    half: 0,
    x: 0,
    y: 0,
  });
  assertEquals(decodePlusGroupWord(0x0087).column, 15); // 7 | (0x80 >> 4)
  assertEquals(decodePlusGroupWord(0x0078).row, 15);
  // Buffers 0 and 2 are the save's first half, 1 and 3 its second.
  assertEquals(decodePlusGroupWord(0x0100).y, 256);
  assertEquals(decodePlusGroupWord(0x0200).y, 0);
  assertEquals(decodePlusGroupWord(0x0300).y, 256);
  assertEquals([
    decodePlusGroupWord(0x0300).page,
    decodePlusGroupWord(0x0300).half,
  ], [3, 1]);
  // The reader clamps anything above 1023, and 0xFFFF does occur.
  assertEquals(decodePlusGroupWord(0xffff).tile, 0x3ff);
  assertEquals(decodePlusGroupWord(0x03ff), {
    raw: 0x03ff,
    tile: 0x03ff,
    column: 15,
    row: 15,
    page: 3,
    half: 1,
    x: 240,
    y: 496,
  });
});

Deno.test("appear bytes name an enemy definition by class, and the stage pieces tile 0x223C", () => {
  assertEquals(decodePlusAppearByte(0x00), null);
  assertEquals(decodePlusAppearByte(0xff), null);
  assertEquals(decodePlusAppearByte(0x83), {
    raw: 0x83,
    boss: false,
    size: "16x16",
    definition: 3,
  });
  assertEquals(decodePlusAppearByte(0x93).definition, 19);
  assertEquals(decodePlusAppearByte(0xb9).definition, 48 + 1); // masked to 3 bits
  assertEquals(decodePlusAppearByte(0xc6).definition, 56 + 2); // masked to 2 bits
  assertEquals(decodePlusAppearByte(0xd0).boss, true);

  let at = 0;
  for (const p of PLUS_STAGE_LAYOUT) {
    assertEquals(p.offset, at, p.name);
    at = p.end;
  }
  assertEquals(at, PLUS_STAGE_SIZE);
  at = 0;
  for (const p of PLUS_GLOBAL_LAYOUT) {
    assertEquals(p.offset, at, p.name);
    at = p.end;
  }
  assertEquals(at, PLUS_GLOBAL_SIZE);
  let file = 0;
  for (const r of PLUS_REGIONS) {
    assertEquals(r.offset, file, r.name);
    file = r.end;
  }
  assertEquals(file, PLUS_BLOCK_SIZE);
});

Deno.test("appear records, enemy definitions and scroll slice the stage's own bytes", () => {
  const { block } = buildPlusBlock();
  const stage = decodePlusStage(block, 1);
  const appear = decodePlusAppear(stage);
  assertEquals(appear.records.length, 256);
  assertEquals(appear.records[0].bytes.length, 14);
  assertEquals(appear.rowTable.length, 0x400);
  const enemies = decodePlusEnemyData(stage);
  assertEquals(enemies.enemies.length, PLUS_ENEMY_COUNT);
  assertEquals(enemies.enemies[0].bytes.length, 8);
  assertEquals(enemies.boss.length, 0x20);
  const scroll = decodePlusScroll(stage);
  assertEquals([scroll.blocks.length, scroll.effects.length], [256, 256]);
});

Deno.test("the high-score ladder reads back as two tables of ten, and palette rows follow the stage", () => {
  const { block } = buildPlusBlock();
  const scores = decodePlusHiScores(block);
  assertEquals(scores.length, 20);
  assertEquals(scores[0], {
    rank: 1,
    table: 0,
    score: 1000,
    extra: [0, 0, 0, 0],
    name: "........",
  });
  assertEquals(scores[10].table, 1);
  assertEquals(scores[19].score, 100);
  assertEquals(plusPaletteRow("map", 3), 3);
  assertEquals(plusPaletteRow("enemy", 3), 9);
  assertEquals(plusPaletteRow("boss", 3), 15);
  assertEquals(plusPaletteRow("player"), 18);
  assertEquals(plusPaletteRow("nothing"), null);
});

Deno.test("a Dezaemon+ save is recognised by name, by title, and on a card", () => {
  const { block, filename } = buildPlusBlock();
  assertEquals(identifyGame(block, filename), "plus");
  assertEquals(identifyGame(block, ""), "plus");
  assertEquals(identifyGame(new Uint8Array(0x100), "BISLPS-99999OTHER"), null);
  const parsed = parsePsxSav(buildCard(block, filename));
  assertEquals(parsed.saves.length, 1);
  assertEquals(parsed.saves[0].game, "plus");
  assert(parsed.saves[0].header?.title.startsWith("デザエモン＋"));
});
