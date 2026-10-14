// The Super Famicom writer: a synthetic level becomes an image the reader
// decodes back — entries in the classes their art fits, frames in the
// stage's sheet, waves on their lines, the boss and its byte, scenery in
// map rows and group slots, palettes on the rows the game copies, and the
// checksums sealed.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  APPEAR_BOSS_CLASS,
  buildSfcGameFromLevel,
  cutChip,
  decodeChipPixels,
  exportLevelToSfcSram,
  parseSfcSav,
  quantizeToRow,
  SFC_ENEMY_CLASSES,
  SfcChipBank,
  sfcClassFor,
  sfcSpawnColumn,
  sfcSramFileName,
  verifySfcChecksums,
} from "../src/sfc/index.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const SAMPLE = "dezaemon-sfc-sample.sav";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0; // a transparent corner, so no frame is a solid block
  return { w, h, rgba };
}

function level() {
  return {
    name: "tiny sfc",
    width: 8,
    enemylist: [
      ["00", "00", "B0", "00", "00", "B0", "00", "00"], // spawns last
      ["A1", "00", "00", "A0", "00", "00", "00", "A1"],
      ["00", "A0", "00", "00", "C0", "00", "A0", "00"], // spawns first
    ],
    enemyData: {
      enemyA: {
        name: "dot",
        hp: 3,
        score: 200,
        speed: 2,
        interval: 60,
        texture: ["dot0.png", "dot1.png"],
      },
      enemyB: {
        name: "slab",
        hp: 20,
        score: 1000,
        speed: 1,
        interval: -1,
        texture: ["slab0.png"],
      },
      enemyC: {
        name: "tower",
        hp: 50,
        score: 5000,
        speed: 4,
        interval: 30,
        texture: ["tower0.png"],
      },
    },
    bossData: {
      boss0: { name: "big", hp: 300, score: 6000, texture: ["boss0.png"] },
    },
    playerData: { texture: ["ship0.png"] },
  };
}

function art() {
  return {
    "dot0.png": frame(12, 14, [255, 0, 0]),
    "dot1.png": frame(12, 14, [200, 0, 0]),
    "slab0.png": frame(30, 14, [0, 0, 255]),
    "tower0.png": frame(14, 30, [0, 200, 0]),
    "boss0.png": frame(100, 60, [0, 255, 0]),
    "ship0.png": frame(24, 24, [255, 255, 255]),
  };
}

Deno.test("geometry helpers", () => {
  assertStrictEquals(sfcClassFor(16, 16), 0);
  assertStrictEquals(sfcClassFor(32, 16), 1);
  assertStrictEquals(sfcClassFor(16, 32), 2);
  assertStrictEquals(sfcClassFor(32, 32), 3);
  assertStrictEquals(sfcClassFor(33, 8), 4);
  assertStrictEquals(sfcClassFor(64, 64), 4);
  assertEquals([0, 1, 2, 3, 4, 5, 6, 7].map((c) => sfcSpawnColumn(c, 8)), [
    1,
    3,
    5,
    7,
    8,
    10,
    12,
    14,
  ]);
  assertStrictEquals(sfcSpawnColumn(0, 1), 8);
  assertStrictEquals(
    sfcSramFileName("my: game"),
    "Dezaemon SFC - my  game.srm",
  );
  // the classes' ODR bytes tile 0x000-0x13F exactly
  let at = 0;
  for (const c of SFC_ENEMY_CLASSES) {
    assertStrictEquals(c.odrBase, at);
    at += c.entries * c.frames * c.cols * c.rows;
  }
  assertStrictEquals(at, 0x140);
});

Deno.test("the chip bank keeps one copy of a chip and finds its mirrors", () => {
  const bank = new SfcChipBank(4);
  const px = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) px[y * 16 + x] = x < 8 ? 1 : 2;
  }
  const a = bank.add(px);
  assertEquals(a, { chip: 0, hflip: false, vflip: false });
  const mirrored = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) mirrored[y * 16 + x] = x < 8 ? 2 : 1;
  }
  assertEquals(bank.add(mirrored), { chip: 0, hflip: true, vflip: false });
  assertStrictEquals(bank.used, 1);
  assertStrictEquals(bank.shared, 1);
  for (let i = 0; i < 3; i++) assert(bank.add(new Uint8Array(256).fill(3 + i)));
  assertStrictEquals(bank.add(new Uint8Array(256).fill(9)), null, "full");
  const bytes = new Uint8Array(0x20000);
  bank.writeTo(bytes);
  assertEquals(
    Array.from(decodeChipPixels(0, { sram: bytes })),
    Array.from(px),
  );
});

Deno.test("quantizeToRow gives index 0 to transparency and 1..15 to the row's colours", () => {
  const q = quantizeToRow([{ key: "a", ...frame(16, 16, [255, 0, 0]) }, {
    key: "b",
    ...frame(16, 16, [0, 0, 255]),
  }]);
  assertStrictEquals(q.words.length, 15);
  assert(q.colors >= 2);
  assertStrictEquals(q.frames[0].indices[0], 0, "the transparent corner");
  assert(q.frames[0].indices[1] >= 1 && q.frames[0].indices[1] <= 15);
  assert(
    q.frames[0].indices[1] !== q.frames[1].indices[1],
    "red and blue take different slots",
  );
  const chip = cutChip(q.frames[0].indices, 16, 0, 0);
  assertStrictEquals(chip.length, 256);
  assertStrictEquals(chip[17], q.frames[0].indices[17]);
});

Deno.test("a level becomes an image the reader decodes back as the same game", () => {
  const out = exportLevelToSfcSram(level(), art(), {
    title1: frame(120, 50, [255, 255, 0]),
  });
  assertStrictEquals(out.sram.length, 0x20000);
  assertStrictEquals(out.fileName, "Dezaemon SFC - tiny sfc.srm");
  assertEquals(out.warnings, []);
  const save = parseSfcSav(out.sram);
  assert(save.isSfcSav);
  assertEquals(save.errors, []);
  assert(verifySfcChecksums(out.sram).ok);
  const st = save.enemies[0];
  // the dot (12x14) is class 0 twice (A0, A1 with the drop bit), the slab 32x16 class 1, the tower 16x32 class 2
  assertEquals(
    st.classes.map((c) => c.entries.filter((e) => !e.blank).length),
    [2, 1, 1, 0, 0],
  );
  const dot = st.classes[0].entries[0].fields;
  assertStrictEquals(dot.family, 1, "straight down");
  assertStrictEquals(dot.variant, 1, "2 px a frame");
  assertStrictEquals(dot.aim > 0, true, "the dot fires");
  assertStrictEquals(dot.hp, 1, "3 hits -> 75 units -> the 50 slot");
  assertStrictEquals(dot.score, 2, "200");
  assertStrictEquals(dot.itemDrop, false);
  assertStrictEquals(
    st.classes[0].entries[1].fields.itemDrop,
    true,
    "the A1 cells drop",
  );
  const slab = st.classes[1].entries[0].fields;
  assertStrictEquals(slab.aim, 0, "the slab does not fire");
  assertStrictEquals(slab.hp, 4, "20 hits -> 500 units -> the 400 slot");
  assertStrictEquals(save.enemies[0].boss.blank, false);
  assertStrictEquals(
    save.enemies[0].boss.hp,
    3,
    "300 hits -> 7500 units -> the 8000 slot",
  );
  assertStrictEquals(save.enemies[0].boss.tall, false);
  // frames: class 0 entry 0 has four ODR bytes naming sheet slots; the sheet's slot 0 stays blank
  const odr = save.groups.enemyOdr[0].quads;
  assert(odr[0].refs.every((r) => r.slot > 0), "four frames of the dot");
  assertStrictEquals(save.groups.enemy[0].chips[0].empty, true);
  assert(save.groups.enemy[0].chips.filter((c) => !c.empty).length >= 3);
  // every sheet slot names a chip the bank painted
  const painted = (word) =>
    decodeChipPixels(word, { sram: out.sram }).some((v) => v);
  for (const c of save.groups.enemy[0].chips) {
    if (!c.empty) assert(painted(c.word), `slot ${c.slot}`);
  }
  // spawns: three waves on lines 2, 6 and 10, the boss twelve past the last
  const ap = save.appear[0];
  assertEquals([ap.lines[2] > 1, ap.lines[6] > 1, ap.lines[10] > 1], [
    true,
    true,
    true,
  ]);
  assertStrictEquals(ap.spawns, 9, "eight enemies and the boss byte");
  assertStrictEquals(ap.lines[22] > 1, true, "the boss line");
  assertEquals(ap.records[ap.lines[22]].spawns, [{
    column: 8,
    klass: APPEAR_BOSS_CLASS,
    entry: 0,
  }]);
  assertStrictEquals(
    ap.records[ap.lines[2]].spawns.length,
    3,
    "the first wave: two dots and the tower",
  );
  assertStrictEquals(
    ap.records[ap.lines[10]].spawns.length,
    2,
    "the last wave: two slabs",
  );
  assertStrictEquals(ap.records[1].blank, false, "the END record is kept");
  // the boss sheet is painted and its palette row is stage 0's boss row
  assert(save.groups.boss[0].chips.filter((c) => !c.empty).length >= 16);
  assert(
    save.palettes.rows[12].colors[1].g > 200,
    "the boss's green on row 12",
  );
  assert(
    save.palettes.rows[6].colors.some((c) => c.r > 200),
    "the enemies' red on row 6",
  );
  // the title: 8x4 chips on row 19; the ship sheet is the factory's
  assert(save.groups.title.filter((c) => !c.empty).length >= 20);
  assertStrictEquals(save.groups.myShip[0].word, 0x0200);
  assertStrictEquals(save.groups.myShip[63].word, 0x03fe);
  // the report
  assertStrictEquals(out.report.stages.length, 1);
  assertStrictEquals(out.report.stages[0].placements, 8);
  assertStrictEquals(out.report.stages[0].boss.line, 22);
  assertEquals(out.report.stages[0].enemies.map((e) => e.cell).sort(), [
    "A0",
    "A1",
    "B0",
    "C0",
  ]);
  assert(out.report.chips.used > 4 && out.report.chips.used < 100);
  assertStrictEquals(out.report.title, "uploaded");
});

Deno.test("scenery: the level's 16x16 cell grid becomes map rows naming group slots, flips in the cells", () => {
  const lv = level();
  const cells = ["bgA.png", "bgB.png"];
  const cols = 14, rows = 8;
  const tiles = new Uint8Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // the left half is cell A, mirrored on odd columns; the right half empty
      const w = c < 7 ? ((c & 1) ? 0x8000 : 0) | (r < 4 ? 0 : 1) : 0xffff;
      tiles[(r * cols + c) * 2] = w >> 8;
      tiles[(r * cols + c) * 2 + 1] = w & 0xff;
    }
  }
  lv.backgroundCells = cells;
  lv.background = { cols, tiles: btoa(String.fromCharCode(...tiles)) };
  const a = art();
  // asymmetric cells, so a mirror is a different picture
  a["bgA.png"] = frame(16, 16, [90, 120, 40]);
  a["bgA.png"].rgba.fill(0, 0, 16 * 4 * 2); // the top two rows transparent... and a hole on the left
  for (let y = 0; y < 16; y++) a["bgA.png"].rgba[(y * 16 + 1) * 4 + 3] = 0;
  a["bgB.png"] = frame(16, 16, [40, 60, 160]);
  for (let y = 0; y < 16; y++) a["bgB.png"].rgba[(y * 16 + 14) * 4 + 3] = 0;
  const out = exportLevelToSfcSram(lv, a);
  const save = parseSfcSav(out.sram);
  assert(verifySfcChecksums(out.sram).ok);
  const map = save.maps[0];
  // 14 columns centred in 16: column 1 is the grid's column 0
  assertStrictEquals(map.used, 7 * rows);
  assertStrictEquals(map.slots[0], 0, "the margin column is blank");
  assertStrictEquals(map.slots[1] > 0, true);
  assertStrictEquals(
    map.slots[1],
    map.slots[2],
    "A and its mirror share a slot",
  );
  assertStrictEquals(
    map.hflips[1] !== map.hflips[2],
    true,
    "the mirror is in the cell's flip",
  );
  assertStrictEquals(
    map.slots[4 * 16 + 1] !== map.slots[1],
    true,
    "B is another slot",
  );
  assertStrictEquals(
    out.report.stages[0].mapChips,
    2,
    "two distinct scenery chips",
  );
  assertStrictEquals(out.report.stages[0].rowsDrawn, 8);
  assertEquals(out.warnings, []);
  // the group slot's chip is in the save's own sheet
  const slot = save.groups.map[0].chips[map.slots[1]];
  assertStrictEquals(slot.user, true);
});

Deno.test("limits: stages past six, a horizontal grid, too many entries", () => {
  const lv = level();
  lv.stages = {};
  for (let s = 0; s < 7; s++) {
    lv.stages[`stage${s}`] = { enemylist: lv.enemylist };
  }
  const out = buildSfcGameFromLevel(lv, art(), { horizontal: true });
  assert(out.warnings.some((w) => /7 stages/.test(w)));
  assert(out.warnings.some((w) => /horizontal/.test(w)));
  assertStrictEquals(out.report.stages.length, 6);
  // 17 distinct small enemies: class 0 fills at 16, the 17th falls to class 1
  const many = level();
  many.enemylist = [[]];
  const letters = "ABCDEFGHIJKLMNOPQ".split("");
  many.enemylist = [letters.map((l) => `${l}0`)];
  many.width = letters.length;
  many.enemyData = {};
  const a = art();
  for (const l of letters) {
    many.enemyData[`enemy${l}`] = {
      name: l,
      hp: 1,
      score: 50,
      speed: 1,
      interval: -1,
      texture: [`e${l}.png`],
    };
    a[`e${l}.png`] = frame(8, 8, [l.charCodeAt(0) * 3 & 255, 0, 0]);
  }
  const big = buildSfcGameFromLevel(many, a);
  const classes = big.report.stages[0].enemies.map((e) => e.klass);
  assertStrictEquals(classes.filter((k) => k === 0).length, 16);
  assertStrictEquals(classes.filter((k) => k === 1).length, 1);
  assertThrows(
    () => buildSfcGameFromLevel({ name: "x" }, {}),
    Error,
    "no stage",
  );
});

Deno.test({
  name:
    "the factory sample re-seals to itself, and the writer's fixed regions are the sample's",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const sample = loadFixture(SAMPLE);
    const out = exportLevelToSfcSram(level(), art());
    const same = (offset, end, what) => {
      for (let i = offset; i < end; i++) {
        assert(
          out.sram[i] === sample[i],
          `${what} differs at 0x${i.toString(16)}`,
        );
      }
    };
    const save = parseSfcSav(out.sram);
    same(
      save.regions.find((r) => r.name === "sound").offset,
      save.regions.find((r) => r.name === "sound").end,
      "SOUND DATA",
    );
    same(
      save.regions.find((r) => r.name === "myShipGroup").offset,
      save.regions.find((r) => r.name === "myShipGroup").end,
      "MY SHIP GROUP",
    );
    same(0x40 + 18 * 32, 0x40 + 19 * 32, "palette row 18");
    same(0x40 + 20 * 32, 0x40 + 22 * 32, "palette rows 20-21");
  },
});
