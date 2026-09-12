// Dezaemon Kids!: the eleven-word directory, the LZSS sections and their
// byte-sum checksums, the seven regions of the data section, the high-score
// tail, and the palette bank the save does not carry.

import { assert, assertEquals } from "@std/assert";
import {
  decodeKidsAppearSlot,
  decodeKidsChip,
  decodeKidsHiScores,
  KIDS_ALL_CLEAR,
  KIDS_CLASS_BASE,
  KIDS_DATA_SIZE,
  KIDS_GRAPHICS_SIZE,
  KIDS_MAP_COLUMNS,
  KIDS_MAP_ROWS,
  KIDS_MAP_STAGE_BYTES,
  KIDS_MUTEKI_LEVEL,
  KIDS_REGIONS,
  KIDS_SCROLL_SPEEDS,
  KIDS_TABLE_OFFSET,
  kidsDisplayName,
  kidsRecordFor,
  parseKidsSave,
  parseKidsTable,
  validateKidsTable,
} from "../src/psx/kids.js";
import {
  KIDS_BACKDROP_WORD,
  KIDS_PALETTE,
  kidsPaletteRgb,
} from "../src/psx/kids-palette.js";
import { parsePsxSav, summarizePsxSav } from "../src/psx/index.js";
import { buildCard, buildKidsBlock, writeU32 } from "./_psx-synthetic.js";

Deno.test("the directory cross-checks and the sections round-trip through the LZSS", () => {
  const { block, graphics, data, tail, words } = buildKidsBlock();
  const table = parseKidsTable(block);
  assertEquals(table.words, words);
  assertEquals(table.consistent, true, table.problems.join("; "));
  assertEquals(table.sections.graphics.offset, 0x180);
  assertEquals(validateKidsTable(block, table).ok, true);

  const parsed = parseKidsSave(block, { filename: "BISLPS-01503DEZAKIDS" });
  assertEquals(parsed.errors, []);
  assertEquals(parsed.productOk, true);
  assertEquals(parsed.graphics?.length, KIDS_GRAPHICS_SIZE);
  assertEquals(parsed.data?.length, KIDS_DATA_SIZE);
  assertEquals(parsed.graphics, graphics);
  assertEquals(parsed.data, data);
  assertEquals(parsed.tail, tail);
  assertEquals(parsed.pages?.length, 4);
});

Deno.test("the data section's seven regions tile it exactly and decode per stage", () => {
  let at = 0;
  for (const r of KIDS_REGIONS) {
    assertEquals(r.offset, at, r.name);
    at = r.end;
  }
  assertEquals(at, KIDS_DATA_SIZE);

  const { block } = buildKidsBlock();
  const parsed = parseKidsSave(block);
  assertEquals(parsed.map?.length, 6);
  assertEquals(parsed.map[0].columns, KIDS_MAP_COLUMNS);
  assertEquals(parsed.map[0].rows, KIDS_MAP_ROWS);
  assertEquals(parsed.map[0].words.length, KIDS_MAP_STAGE_BYTES / 2);
  assertEquals(parsed.map[0].width, 224);
  assertEquals(parsed.scroll?.length, 6);
  assertEquals(parsed.scroll[0].steps.length, 192);
  assertEquals(parsed.appear?.length, 6);
  assertEquals(parsed.appear[0].rows, 384);
  assertEquals(parsed.records?.length, 6);
  assertEquals(parsed.records[0].enemies.length, 40);
  assertEquals(parsed.records[0].bosses.length, 2);
  assertEquals(parsed.sprites?.ship.length, 0x1b4 / 2);
  assertEquals(parsed.sprites?.stages.length, 6);
  assertEquals(parsed.sprites.stages[0].classes[0].entries.length, 16);
  assertEquals(parsed.sprites.stages[0].classes[1].entries.length, 8);
  assertEquals(parsed.sprites.stages[0].bosses[0].words.length, 64);
});

Deno.test("a map chip is four CG cells with flips, and a blank word draws nothing", () => {
  assertEquals(decodeKidsChip(0x0010), {
    raw: 0x0010,
    cell: 16,
    cells: [16, 17, 24, 25],
    hflip: false,
    vflip: false,
    blank: false,
  });
  assertEquals(decodeKidsChip(0x2214).hflip, true);
  assertEquals(decodeKidsChip(0x4214).vflip, true);
  assertEquals(
    decodeKidsChip(0x6214).vflip && decodeKidsChip(0x6214).hflip,
    true,
  );
  assertEquals(decodeKidsChip(0x8080).blank, true);
  assertEquals(decodeKidsChip(0x8000).blank, true);
  // Bits 10-12 are not part of the cell number.
  assertEquals(decodeKidsChip(0x1c14).cell, 0x14);
});

Deno.test("an appear slot names a class and an id; a bit-7-clear byte is an editor footprint", () => {
  assertEquals(decodeKidsAppearSlot(0x00), null);
  assertEquals(decodeKidsAppearSlot(0x8f), {
    raw: 0x8f,
    boss: false,
    klass: 0,
    id: 15,
    size: "32x32",
  });
  assertEquals(decodeKidsAppearSlot(0x9f).id, 15); // the engine masks four bits for every class
  assertEquals(decodeKidsAppearSlot(0xa3), {
    raw: 0xa3,
    boss: false,
    klass: 2,
    id: 3,
    size: "32x64",
  });
  assertEquals(decodeKidsAppearSlot(0xb9).klass, 3);
  assertEquals(decodeKidsAppearSlot(0xc0).boss, true);
  // A footprint mark carries the cell's offset inside its owner's rectangle.
  assertEquals(decodeKidsAppearSlot(0x51).footprint, true);
  assertEquals([decodeKidsAppearSlot(0x51).dx, decodeKidsAppearSlot(0x51).dy], [
    0,
    1,
  ]);
  assertEquals([decodeKidsAppearSlot(0x5e).dx, decodeKidsAppearSlot(0x5e).dy], [
    3,
    2,
  ]);
  assertEquals(decodeKidsAppearSlot(0xc0), {
    raw: 0xc0,
    boss: true,
    klass: null,
    id: null,
  });
  assertEquals(KIDS_SCROLL_SPEEDS, [0, 0.25, 1, 4]);
  assertEquals(KIDS_CLASS_BASE, [0, 16, 24, 32]);
});

Deno.test("a spawn's class and id pick its five-byte record", () => {
  const { block } = buildKidsBlock();
  const { records } = parseKidsSave(block);
  assertEquals(kidsRecordFor(records, 0, 0, 3).index, 3);
  assertEquals(kidsRecordFor(records, 0, 1, 0).index, 16);
  assertEquals(kidsRecordFor(records, 0, 2, 5).index, 29);
  assertEquals(kidsRecordFor(records, 0, 3, 7).index, 39);
  assertEquals(kidsRecordFor(records, 9, 0, 0), null);
});

Deno.test("the high-score tail carries the stage reached and the level played", () => {
  const tail = new Uint8Array(0x100);
  const put = (i, score, stage, level, name) => {
    writeU32(tail, i * 16, score);
    tail[i * 16 + 4] = stage;
    tail[i * 16 + 5] = level;
    for (let k = 0; k < 8; k++) {
      tail[i * 16 + 8 + k] = name.charCodeAt(k) || 0x2e;
    }
  };
  put(0, 123456, KIDS_ALL_CLEAR, 2, "ACE");
  put(1, 1000, 3, KIDS_MUTEKI_LEVEL, "DEV");
  const scores = decodeKidsHiScores(tail);
  assertEquals(scores.length, 10);
  assertEquals(scores[0].score, 123456);
  assertEquals(scores[0].allClear, true);
  assertEquals(scores[0].stage, null);
  assertEquals(scores[0].level, 2);
  assertEquals(scores[0].name, "ACE.....");
  assertEquals(scores[1].allClear, false);
  assertEquals(scores[1].stage, 3);
  assertEquals(scores[1].muteki, true);
  assertEquals(scores[0].levelName, "HARD");
});

Deno.test("the options and the bracketed game name decode", () => {
  const { block } = buildKidsBlock();
  const parsed = parseKidsSave(block);
  assertEquals(parsed.hiScores[0].score, 10000);
  assertEquals(parsed.hiScores[9].score, 1000);
  assertEquals(parsed.options.bytes.length, 0x1c);
  assertEquals(parsed.options.unused.length, 0x44);
  assertEquals(parsed.header?.title, "デザエモンＫｉｄｓ！『Ａ　』");
  assertEquals(parsed.gameName, "Ａ");
  assertEquals(kidsDisplayName(parsed), "A");
});

Deno.test("the palette bank is the disc's, not the save's: 256 words, index 0 transparent or the backdrop", () => {
  assertEquals(KIDS_PALETTE.length, 256);
  assertEquals(KIDS_PALETTE[0], 0x0000);
  assertEquals(KIDS_BACKDROP_WORD, 0xffff);
  const sprite = kidsPaletteRgb();
  const map = kidsPaletteRgb({ backdrop: true });
  assertEquals(sprite[0].raw, 0x0000);
  assertEquals(map[0].raw, 0xffff);
  assertEquals(map[0], {
    raw: 0xffff,
    r: 255,
    g: 255,
    b: 255,
    stp: true,
    empty: false,
  });
  // Every other entry is the same in both forms.
  for (let i = 1; i < 256; i++) assertEquals(sprite[i].raw, map[i].raw);
  assertEquals(sprite[1], {
    raw: 0x03bf,
    r: 255,
    g: 239,
    b: 0,
    stp: false,
    empty: false,
  });
});

Deno.test("a flipped byte fails exactly the checksum it lands in; a bent word breaks consistency", () => {
  const { block } = buildKidsBlock();
  const table = parseKidsTable(block);
  block[table.sections.data.offset + 5] ^= 0xff;
  const checks = validateKidsTable(block, table);
  assertEquals(checks.graphics, true);
  assertEquals(checks.data, false);
  assertEquals(checks.tail, true);
  assertEquals(checks.ok, false);
  const parsed = parseKidsSave(block);
  assertEquals(parsed.checksums?.data, false);
  assert(parsed.errors.every((e) => e.block === "data"));

  writeU32(block, KIDS_TABLE_OFFSET + 3 * 4, 0x200);
  const bent = parseKidsTable(block);
  assertEquals(bent.consistent, false);
  assert(bent.problems.some((p) => p.includes("0x180")));
});

Deno.test("a Kids! save on a card is found by its file name and summarised", () => {
  const { block, filename } = buildKidsBlock();
  const parsed = parsePsxSav(buildCard(block, filename));
  assertEquals(parsed.container, "card");
  assertEquals(parsed.saves.length, 1);
  assertEquals(parsed.saves[0].game, "kids");
  assertEquals(parsed.saves[0].filename, filename);
  const summary = summarizePsxSav(parsed);
  assert(summary.includes("Dezaemon Kids!"));
  assert(summary.includes("checksums: graphics ok, data ok, tail ok"));
  assert(summary.includes("map chips used per stage"));
});
