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
  titleCellForSlot,
  titleSlotForCell,
  verifySfcChecksums,
} from "../src/sfc/index.js";
import { composeTitlePicture } from "../src/sfc/sfc-write.js";
import { decodePaletteData, writeCgramRow } from "../src/sfc/cgram.js";
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
    save.palettes.rows[12].colors[0].g > 200,
    "the boss's green in row 12's first word (what index 1 draws: a row lands one colour up)",
  );
  assert(
    save.palettes.rows[6].colors.some((c) => c.r > 200),
    "the enemies' red on row 6",
  );
  // the title: 8x4 chips on row 19, the logo's yellow in its first word
  assert(save.groups.title.filter((c) => !c.empty).length >= 20);
  const titleInk = save.palettes.rows[19].colors[0];
  assert(
    titleInk.r > 200 && titleInk.g > 200 && titleInk.b < 50,
    "the logo's yellow on row 19",
  );
  // the ship: the level's white 24x24 frame in the three pose slots (chips
  // 0-3, 4-7, 8-11, each TL TR BL BR) as the save's own chips, its white in
  // row 18's first word; the rest of the sheet — the dome at 12-15, the
  // shots from 16, the forced 61-63 — stays the factory's
  const ship = save.groups.myShip;
  for (const base of [0, 4, 8]) {
    assert(
      ship.slice(base, base + 4).every((c) => c.user && painted(c.word)),
      `the pose at slot ${base}`,
    );
  }
  assertStrictEquals(ship[12].word, 0x0206);
  assertStrictEquals(ship[16].word, 0x0210);
  assertStrictEquals(ship[63].word, 0x03fe);
  assertStrictEquals(save.palettes.rows[18].colors[0].raw, 0x7fff);
  assertStrictEquals(out.report.ship, "level");
  assertStrictEquals(out.report.shipChips, 12);
  assertEquals(out.report.titleParts, ["logo"]);
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
    // MY SHIP GROUP past the three pose slots (0-11), which are the level's
    same(
      save.regions.find((r) => r.name === "myShipGroup").offset + 12 * 2,
      save.regions.find((r) => r.name === "myShipGroup").end,
      "MY SHIP GROUP from slot 12",
    );
    same(0x40 + 20 * 32, 0x40 + 22 * 32, "palette rows 20-21");
  },
});

Deno.test("a palette row is written one colour down: index 1 draws word 0", () => {
  // one red frame: every opaque pixel is index 1, and the row's word 0 is red
  const q = quantizeToRow([{ key: "red", ...frame(16, 16, [255, 0, 0]) }]);
  assertStrictEquals(q.colors, 1);
  assertStrictEquals(q.frames[0].indices[1], 1);
  assertStrictEquals(q.words[0], 0x001f);
  assertEquals(q.words.slice(1), new Array(14).fill(0), "unfilled slots are 0");
  const bytes = new Uint8Array(0x20000);
  writeCgramRow(bytes, 6, q.words);
  const row = decodePaletteData(bytes).rows[6];
  assertStrictEquals(
    row.raw[0],
    0x001f,
    "word 0, which the console lands at colour 1",
  );
  assertStrictEquals(row.raw[1], 0);
});

Deno.test("the ship: a level with no ship frames flies Duke; a second frame banks, mirrored for the right", () => {
  const lv = level();
  delete lv.playerData;
  const duke = exportLevelToSfcSram(lv, art());
  assertStrictEquals(duke.report.ship, "duke");
  assert(duke.report.shipChips >= 4);
  const dukeSave = parseSfcSav(duke.sram);
  assert(
    dukeSave.groups.myShip.slice(4, 8).every((c) => c.user),
    "Duke's level pose",
  );

  // an asymmetric bank frame: its left half red with a green mark in the
  // top-left corner, its right half blue
  const bank = frame(32, 32, [255, 0, 0]);
  for (let y = 0; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      bank.rgba.set([0, 0, 255, 255], (y * 32 + x) * 4);
    }
  }
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      bank.rgba.set([0, 255, 0, 255], (y * 32 + x) * 4);
    }
  }
  const lv2 = level();
  lv2.playerData = { texture: ["ship0.png", "bank.png"] };
  const a = { ...art(), "bank.png": bank };
  const out = exportLevelToSfcSram(lv2, a);
  const save = parseSfcSav(out.sram);
  const ship = save.groups.myShip;
  const odr = save.groups.myShipOdr;
  const px = (slot) => decodeChipPixels(ship[slot].word, { sram: out.sram });
  const row = save.palettes.rows[18];
  const colourAt = (slot, x, y) => row.colors[px(slot)[y * 16 + x] - 1];
  // left pose, slot 0 (TL): red; slot 1 (TR): blue — the right pose mirrors it
  assert(colourAt(0, 8, 8).r > 200, "left pose, top-left chip is red");
  assert(colourAt(1, 8, 8).b > 200, "left pose, top-right chip is blue");
  assert(colourAt(8, 8, 8).b > 200, "right pose, top-left chip is blue");
  assert(colourAt(9, 8, 8).r > 200, "right pose, top-right chip is red");
  // the level pose is the first frame, white
  assert(
    colourAt(4, 8, 8).r > 200 && colourAt(4, 8, 8).g > 200 &&
      colourAt(4, 8, 8).b > 200,
  );
  // the right pose's top-right chip is the left pose's top-left chip
  // mirrored: the same chip, no flip in the word, H in MY SHIP ODR — the
  // ship sheet reads its flips there and ignores the word's
  assertStrictEquals(ship[9].word, ship[0].word);
  assert(
    ship.every((c) => !c.hflip && !c.vflip),
    "no flip bits in the ship words",
  );
  assertEquals([odr[0].hflip, odr[0].vflip], [false, false]);
  assertEquals([odr[9].hflip, odr[9].vflip], [true, false]);
  assert(
    colourAt(0, 1, 1).g > 200,
    "the mark sits top-left in the chip the two slots share",
  );
});

Deno.test("the title picture: the backdrop under the logo and subtitle, the window fitted to 128x64", () => {
  // a 256x88 logo, white on transparent but for its corner; a 64x64 red backdrop
  const logo = frame(256, 88, [255, 255, 255]);
  const backdrop = frame(64, 64, [255, 0, 0]);
  backdrop.rgba[3] = 255;
  const pic = composeTitlePicture({ logo, backdrop });
  assertEquals([pic.w, pic.h], [128, 64]);
  // the window is 256x128 around the logo (y 75..163), scaled by half: every
  // pixel is opaque (the backdrop tiles everywhere), the logo's white covers
  // the middle rows and the backdrop's red shows above and below it
  const at = (p, x, y) =>
    Array.from(p.rgba.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
  assertEquals(
    at(pic, 64, 32),
    [255, 255, 255, 255],
    "the logo's white at the centre",
  );
  assertEquals(at(pic, 64, 2), [255, 0, 0, 255], "the backdrop above the logo");
  assertEquals(
    at(pic, 64, 62),
    [255, 0, 0, 255],
    "the backdrop below the logo",
  );
  assert(pic.rgba.every((v, i) => i % 4 !== 3 || v === 255), "all opaque");

  // a logo alone sits on nothing: transparent where the logo is not
  const alone = composeTitlePicture({ logo });
  assertEquals(at(alone, 64, 32), [255, 255, 255, 255]);
  assertStrictEquals(at(alone, 64, 2)[3], 0, "transparent above the logo");

  // a small logo is not blown up: 60x20 stays 60x20 in the middle of the picture
  const small = composeTitlePicture({ logo: frame(60, 20, [0, 255, 0]) });
  assertStrictEquals(
    small.rgba[(32 * 128 + 64) * 4 + 1],
    255,
    "green at the centre",
  );
  assertStrictEquals(
    small.rgba[(32 * 128 + 100) * 4 + 3],
    0,
    "nothing 36 px right of centre",
  );
  assertStrictEquals(
    small.rgba[(32 * 128 + 36) * 4 + 3],
    255,
    "green 28 px left of centre",
  );

  // a subtitle lands under the logo; a backdrop alone shows the band the logo would sit in
  const both = composeTitlePicture({
    logo: frame(256, 40, [255, 255, 255]),
    subtitle: frame(256, 20, [0, 0, 255]),
  });
  assert(
    both.rgba.some((v, i) =>
      i % 4 === 2 && v === 255 && both.rgba[i - 2] === 0
    ),
    "the subtitle's blue is in the picture",
  );
  assertStrictEquals(composeTitlePicture({ backdrop }).rgba[3], 255);
  assertStrictEquals(composeTitlePicture({}), null);
});

Deno.test("the title group is two 4-wide halves: a picture cell lands in its slot", () => {
  assertStrictEquals(titleSlotForCell(0, 0), 0);
  assertStrictEquals(titleSlotForCell(3, 0), 3);
  assertStrictEquals(titleSlotForCell(0, 1), 4);
  assertStrictEquals(titleSlotForCell(4, 0), 16);
  assertStrictEquals(titleSlotForCell(7, 3), 31);
  for (let s = 0; s < 32; s++) {
    const { cx, cy } = titleCellForSlot(s);
    assertStrictEquals(titleSlotForCell(cx, cy), s);
  }
  // a 128x64 logo with one opaque cell, (5, 2): only slot 16 + 2 * 4 + 1 = 25 is painted
  const logo = { w: 128, h: 64, rgba: new Uint8Array(128 * 64 * 4) };
  for (let y = 32; y < 48; y++) {
    for (let x = 80; x < 96; x++) {
      logo.rgba.set([255, 0, 0, 255], (y * 128 + x) * 4);
    }
  }
  const out = exportLevelToSfcSram(level(), art(), { title1: logo });
  const title = parseSfcSav(out.sram).groups.title;
  assertEquals(title.filter((c) => !c.empty).map((c) => c.slot), [25]);
});

Deno.test("the report says what the title was made of, and what flies", () => {
  const out = exportLevelToSfcSram(level(), art(), {
    title1: frame(120, 50, [255, 255, 0]),
    title2: frame(100, 20, [0, 0, 255]),
    titleBg: frame(32, 32, [0, 255, 0]),
  });
  assertEquals(out.report.titleParts, ["logo", "subtitle", "backdrop"]);
  assertStrictEquals(out.report.title, "uploaded");
  const save = parseSfcSav(out.sram);
  // the backdrop fills the picture: all 32 chips are painted
  assertStrictEquals(save.groups.title.filter((c) => !c.empty).length, 32);
  const none = exportLevelToSfcSram(level(), art());
  assertStrictEquals(none.report.title, "none");
  assertEquals(none.report.titleParts, []);
  assertStrictEquals(
    parseSfcSav(none.sram).groups.title.filter((c) => !c.empty).length,
    0,
  );
});
