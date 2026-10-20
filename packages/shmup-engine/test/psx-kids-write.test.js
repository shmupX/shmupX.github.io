// A level record -> a Dezaemon Kids! memory card -> back through the parsers
// that read the community collection: the writer is checked by the readers.
//
// Two layers. The structural tests build a small synthetic level and read the
// card back with parsePsxSav/parseKidsSave, asserting what the traced layouts
// predict — the directory cross-checks, the three sums verify, every sprite
// word names a painted cell, every map chip is 2x2-aligned, the footprint
// marks resolve to their owner under the vertical rule, the name round-trips.
// The fixture-gated tests at the end take the disc's own sample games (Athena's
// SGM_*.CMP, read straight off a Dezaemon Kids! image in dev-fixtures/) and
// wrap their sections with buildKidsBlock, which proves the block assembler on
// data this repo did not write; they skip without the disc.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  blastWords,
  bombWords,
  buildKidsBlock,
  buildKidsGameFromLevel,
  defaultKidsIcon,
  encodeKidsIcon,
  exportLevelToKidsCard,
  factoryKidsTail,
  hflipRgba,
  KIDS_BOSS_FOOTPRINT,
  KIDS_FACTORY_OPTIONS,
  KIDS_MOVE_STRAIGHT,
  KIDS_SHIP_LAYOUT,
  KIDS_SPRITE_STRIPS,
  KIDS_STORY_FIRST_ROW,
  KIDS_STORY_LEAD_ROWS,
  KIDS_STORY_SCROLL,
  KIDS_STORY_SLOW_UNITS,
  kidsBossClassFor,
  kidsCardFileName,
  KidsCellBank,
  kidsClassFor,
  kidsGameNameFor,
  mapKidsColumn,
  nearestKidsIndex,
  quantizeKidsFrame,
} from "../src/psx/kids-write.js";
import { buildMemoryCard, formatMemoryCard } from "../src/psx/memcard-write.js";
import {
  KIDS_APPEAR_COLUMNS,
  KIDS_BLANK,
  KIDS_CELL_ALIGN,
  KIDS_CELL_MASK,
  KIDS_DATA_SIZE,
  KIDS_GRAPHICS_SIZE,
  KIDS_PRODUCT,
  KIDS_STAGES,
  kidsFootprintOwner,
  parseKidsSave,
} from "../src/psx/kids.js";
import { kidsNameBytes } from "../src/psx/kids-edit.js";
import { KIDS_PALETTE } from "../src/psx/kids-palette.js";
import { CARD_SIZE, parseMemoryCard } from "../src/psx/memcard.js";
import { identifyGame, parsePsxSav } from "../src/psx/index.js";
import { openDisc, readFile } from "../src/cd/iso9660-read.js";
import { decompressCmp } from "../src/decompress.js";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0; // a transparent corner, so no frame is a solid block
  return { w, h, rgba };
}

function level() {
  return {
    name: "tiny kids",
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
        speed: 1,
        interval: 60,
        texture: ["dot0.png", "dot1.png"],
        projectileData: { texture: ["shot0.png"], speed: 2 },
      },
      enemyB: {
        name: "slab",
        hp: 20,
        score: 1000,
        speed: 2,
        interval: -1,
        texture: ["slab0.png"],
      },
      enemyC: {
        name: "tower",
        hp: 50,
        score: 5000,
        speed: 10,
        interval: 30,
        texture: ["tower0.png"],
      },
    },
    bossData: {
      boss0: {
        name: "big",
        hp: 300,
        score: 6000,
        texture: ["boss0.png", "boss1.png"],
      },
    },
    playerData: {
      texture: ["ship0.png", "ship1.png"],
      shootNormal: { texture: ["pshot.png"] },
    },
  };
}

function art() {
  return {
    "dot0.png": frame(12, 14, [255, 0, 0]),
    "dot1.png": frame(12, 14, [200, 0, 0]),
    "slab0.png": frame(40, 30, [0, 0, 255]),
    "tower0.png": frame(30, 60, [0, 200, 0]),
    "shot0.png": frame(6, 6, [255, 255, 0]),
    "boss0.png": frame(70, 70, [0, 255, 0]),
    "boss1.png": frame(70, 70, [0, 200, 0]),
    "ship0.png": frame(24, 24, [255, 255, 255]),
    "ship1.png": frame(24, 24, [220, 220, 255]),
    "pshot.png": frame(10, 4, [255, 255, 120]),
  };
}

Deno.test("geometry helpers", () => {
  assertStrictEquals(kidsClassFor(12, 14), 0);
  assertStrictEquals(kidsClassFor(40, 30), 1);
  assertStrictEquals(kidsClassFor(30, 60), 2);
  assertStrictEquals(kidsClassFor(64, 64), 3);
  assertStrictEquals(kidsClassFor(200, 200), 3);
  assertStrictEquals(kidsBossClassFor(64, 64), 0);
  assertStrictEquals(kidsBossClassFor(100, 40), 1);
  assertStrictEquals(kidsBossClassFor(40, 100), 2);
  assertStrictEquals(kidsBossClassFor(70, 70), 3);
  // eight level columns over the seven visible appear columns, ends pinned
  const cols8 = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => mapKidsColumn(c, 8));
  assertEquals(cols8, [1, 2, 3, 4, 4, 5, 6, 7]);
  // a two-cell-wide enemy never hangs past column 7
  assertStrictEquals(mapKidsColumn(7, 8, 2), 6);
  assertStrictEquals(mapKidsColumn(0, 1), 4);
  // the strips add up to sixteen words each
  for (const s of KIDS_SPRITE_STRIPS) {
    assertStrictEquals(s.stripW * s.stripH, 16, `class ${s.klass}`);
  }
  for (const s of KIDS_SPRITE_STRIPS) {
    assertStrictEquals(
      s.frames * s.w,
      s.stripW,
      `class ${s.klass} frames fill the strip`,
    );
  }
  // the ship table's regions tile its 218 words with no overlap
  const L = KIDS_SHIP_LAYOUT;
  assertStrictEquals(L.ship1.shot, 12);
  assertStrictEquals(L.ship1.bomb, 16);
  assertStrictEquals(L.ship2.poses[0], 32);
  assertStrictEquals(L.title1.at, 64);
  assertStrictEquals(L.title1.at + L.title1.w * L.title1.h, L.title2.at);
  assertStrictEquals(L.title2.at + L.title2.w * L.title2.h, L.items.at);
  assertStrictEquals(L.items.at + L.items.count, L.blast.at);
  assertStrictEquals(L.blast.at + L.blast.frames * 4, L.bullets.at);
  assertStrictEquals(L.bullets.at + L.bullets.count * L.bullets.frames, 218);
  // the blast's six 2x2 frames interleave two frames per 8-wide strip row pair
  assertEquals(blastWords(0), [166, 167, 172, 173]);
  assertEquals(blastWords(2), [170, 171, 176, 177]);
  assertEquals(blastWords(3), [178, 179, 184, 185]);
  assertEquals(blastWords(5), [182, 183, 188, 189]);
  const blastCells = new Set();
  for (let f = 0; f < 6; f++) for (const w of blastWords(f)) blastCells.add(w);
  assertStrictEquals(blastCells.size, 24, "no two blast frames share a word");
  // the bomb strip: four 2x2 frames in an 8x2 block from the ship's bomb word
  assertEquals(bombWords(16, 0), [16, 17, 24, 25]);
  assertEquals(bombWords(16, 3), [22, 23, 30, 31]);
});

Deno.test("the fixed palette: every opaque colour lands on a non-zero index of the bank", () => {
  assertStrictEquals(nearestKidsIndex(0, 0, 0) > 0, true);
  assertStrictEquals(KIDS_PALETTE[nearestKidsIndex(255, 255, 255)], 0x7fff);
  const q = quantizeKidsFrame(frame(4, 4, [255, 0, 0]));
  assertStrictEquals(q[0], 0, "the transparent corner is index 0");
  for (let i = 1; i < q.length; i++) assert(q[i] > 0 && q[i] < 256);
  const mirrored = hflipRgba(frame(4, 2, [1, 2, 3]));
  assertStrictEquals(
    mirrored.rgba[3 * 4 + 3],
    0,
    "the corner moved to the right edge",
  );
});

Deno.test("the cell bank: chips are 2x2-aligned groups, sprites single cells, mirrors are shared", () => {
  const bank = new KidsCellBank();
  const chip = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      chip[y * 32 + x] = x < 16 ? 1 + (y & 7) : 9 + (x & 7);
    }
  }
  const w = bank.addChip(chip);
  assertStrictEquals(w & KIDS_CELL_ALIGN, 0, "aligned");
  assertStrictEquals(bank.used, 4);
  assertStrictEquals(bank.addChip(chip), w, "the same chip is shared");
  const flipped = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      flipped[y * 32 + x] = chip[y * 32 + (31 - x)];
    }
  }
  const fw = bank.addChip(flipped);
  assertStrictEquals(
    fw & KIDS_CELL_MASK,
    w & KIDS_CELL_MASK,
    "the mirror names the same cells",
  );
  assert(fw & 0x2000, "with the h-flip bit");
  assertStrictEquals(bank.used, 4, "and costs nothing");
  // a single cell comes from the top of the bank
  const cell = new Uint8Array(256).fill(5);
  const c = bank.addCell(cell);
  assertStrictEquals(c, 1023);
  assertStrictEquals(
    bank.addCell(new Uint8Array(256)),
    KIDS_BLANK,
    "a blank cell is the blank word",
  );
  const refs = bank.addFrame(new Uint8Array(32 * 16).fill(7), 32, 16);
  assertStrictEquals(refs.length, 2);
  assertStrictEquals(refs[0], refs[1], "two identical cells are one");
});

Deno.test("the icon and the name", () => {
  const icon = encodeKidsIcon(frame(24, 24, [255, 0, 0]));
  assertStrictEquals(icon.clut.length, 16);
  assertStrictEquals(icon.clut[0], 0, "entry 0 is transparent");
  assertStrictEquals(icon.pixels.length, 128);
  assertStrictEquals(
    icon.pixels[0] & 0x0f,
    0,
    "the transparent corner is index 0",
  );
  assert(icon.pixels[1] !== 0, "the rest is painted");
  const plain = encodeKidsIcon(defaultKidsIcon());
  assert(plain.clut.some((w) => w !== 0));
  assertEquals(kidsGameNameFor("Air Story").bytes, kidsNameBytes("Air Story"));
  assertStrictEquals(kidsGameNameFor("Air Story").changed, false);
  const long = kidsGameNameFor("A Very Long Game Name Indeed");
  assertStrictEquals(long.text, "A Very Lon");
  assert(long.changed);
  const odd = kidsGameNameFor("Skyé Tale’s");
  assertStrictEquals(odd.text, "Sky Tales");
  assert(odd.changed);
  assertStrictEquals(kidsGameNameFor("").text, "my game");
  assertStrictEquals(
    kidsCardFileName("foo/bar: baz"),
    "Dezaemon Kids - foo bar baz.mcr",
  );
});

Deno.test("the factory tail is KIDS.EXE's: 1000..100, level 1, dotted names, the option bytes", () => {
  const tail = factoryKidsTail();
  for (let i = 0; i < 10; i++) {
    const at = i * 16;
    assertStrictEquals(tail[at] | (tail[at + 1] << 8), (10 - i) * 100);
    assertStrictEquals(tail[at + 4], 0);
    assertStrictEquals(tail[at + 5], 1);
    for (let k = 8; k < 16; k++) assertStrictEquals(tail[at + k], 0x2e);
  }
  assertEquals(
    Array.from(tail.subarray(0xa0, 0xbc)),
    Array.from(KIDS_FACTORY_OPTIONS),
  );
  assertStrictEquals(tail[0xba], 127, "volume");
  assertStrictEquals(tail[0xb8] & 1, 0, "black backdrop");
});

Deno.test("a formatted card is empty and a built card reads back", () => {
  const blank = formatMemoryCard();
  assertStrictEquals(blank.length, CARD_SIZE);
  const parsed = parseMemoryCard(blank);
  assert(parsed.magicOk && parsed.headerChecksumOk);
  assertStrictEquals(parsed.freeBlocks, 15);
  assert(parsed.frames.every((f) => f.checksumOk && f.free));
  assertStrictEquals(
    blank[63 * 128],
    0x4d,
    "the write-test frame is a copy of frame 0",
  );
  assertStrictEquals(blank[36 * 128], 0xff, "replacement data is 0xFF-filled");

  const data = new Uint8Array(0x1e000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  const card = buildMemoryCard([{ filename: KIDS_PRODUCT, data }]);
  const back = parseMemoryCard(card);
  assertStrictEquals(back.files.length, 1);
  assertStrictEquals(back.files[0].filename, KIDS_PRODUCT);
  assertEquals(back.files[0].blocks, [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
  ]);
  assert(back.files[0].complete);
  assertStrictEquals(back.freeBlocks, 0);
  assertEquals(back.files[0].data, data);
  assertThrows(
    () =>
      buildMemoryCard([{ filename: KIDS_PRODUCT, data }, {
        filename: "BISLPS-00335DEZA",
        data,
      }]),
    Error,
    "free",
  );
  assertThrows(
    () => buildMemoryCard([{ filename: "x".repeat(21), data }]),
    Error,
    "20",
  );
});

Deno.test("a level becomes a card the parsers read back as a Kids! game", () => {
  const out = exportLevelToKidsCard(level(), art());
  assertStrictEquals(out.card.length, CARD_SIZE);
  assertStrictEquals(out.fileName, "Dezaemon Kids - tiny kids.mcr");
  assertStrictEquals(out.name, "tiny kids");

  const parsed = parsePsxSav(out.card);
  assertStrictEquals(parsed.container, "card");
  assertStrictEquals(parsed.saves.length, 1);
  const save = parsed.saves[0];
  assertStrictEquals(save.game, "kids");
  assertStrictEquals(save.filename, KIDS_PRODUCT);
  assertStrictEquals(
    identifyGame(out.block, ""),
    "kids",
    "recognised by its title, not just its name",
  );
  assertEquals(save.errors, []);
  assert(save.table.consistent);
  assert(save.checksums.ok, "the three sums verify");
  assertStrictEquals(save.gameNameAscii, "tiny kids");
  assertStrictEquals(save.header.iconFrames, 1);
  assertStrictEquals(save.graphics.length, KIDS_GRAPHICS_SIZE);
  assertStrictEquals(save.data.length, KIDS_DATA_SIZE);

  // config: vertical, one stage, the last flag on it
  assertStrictEquals(save.config.horizontal, false);
  assertStrictEquals(save.config.stageCount, 1);
  assert(save.config.stages[0].last);
  assert(!save.config.stages[1].last);
  assertStrictEquals(save.config.stages[0].backgroundSet, 0);

  // appear: three records, the spawns the grid asked for, the boss at the end
  const st = save.appear[0];
  assertStrictEquals(
    st.orphanMarks,
    0,
    "every footprint mark resolves to an owner",
  );
  assertStrictEquals(st.spawns.length, 8);
  assert(st.boss, "the boss is placed");
  assert(
    st.boss.row > Math.max(...st.spawns.map((p) => p.row)),
    "past the last wave",
  );
  assertStrictEquals(
    st.boss.covers.length,
    15,
    "a 128x128 boss covers the other fifteen cells",
  );
  for (const p of st.spawns) {
    assert(p.col >= 1 && p.col <= 7, `column ${p.col} is on the playfield`);
    const [w, h] = [[1, 1], [2, 1], [1, 2], [2, 2]][p.klass];
    assertStrictEquals(
      p.covers.length,
      w * h - 1,
      `class ${p.klass} covers ${w * h - 1} more cells`,
    );
  }
  // the marks obey the vertical rule exactly as the reader inverts it
  for (const m of st.marks) {
    const owner = kidsFootprintOwner(m.index, m.dx, m.dy, false);
    assert(
      owner !== null && st.bytes[owner] & 0x80,
      "each mark points at a present owner",
    );
  }
  const classes = new Set(st.spawns.map((p) => p.klass));
  assertEquals(
    [...classes].sort(),
    [0, 1, 2],
    "dot, slab and tower took classes 0, 1 and 2",
  );
  // the first wave is the grid's last row, nearest the start
  const first = st.spawns.slice().sort((a, b) => a.row - b.row)[0];
  assertStrictEquals(first.klass, 0, "an A");
  // records: the straight-down pattern, hp and score mapped, the gunners firing
  const recs = save.records[0];
  const byClass = (k) => recs.enemies[[0, 16, 24, 32][k]];
  assertStrictEquals(byClass(0).movement, KIDS_MOVE_STRAIGHT);
  assertStrictEquals(
    byClass(0).movementVariant,
    0,
    "speed 1 -> the slow variant",
  );
  assertStrictEquals(
    byClass(2).movementVariant,
    2,
    "speed 10 -> the fast variant",
  );
  assert(byClass(0).fireTiming > 0, "the dot fires");
  assertStrictEquals(byClass(1).fireTiming, 0, "the slab does not");
  assert(
    byClass(2).hitPoints > byClass(0).hitPoints,
    "the tower is tougher than the dot",
  );
  assertStrictEquals(byClass(2).scoreClass, 2);
  assertStrictEquals(recs.bosses[0].sizeClass, 3);
  assertStrictEquals(recs.bosses[0].size, "128x128");
  assertEquals(
    [...recs.bosses[1].bytes],
    [...recs.bosses[0].bytes],
    "the second record is the boss's second phase: the same boss",
  );
  // 300 hits = 150 a phase = 768000 units: nearest the class-0 phase table entry
  assertStrictEquals(recs.bosses[0].hpClass, 0);
  assertStrictEquals(
    recs.bosses[0].scoreClass,
    0,
    "6000 points: the low class",
  );
  assertStrictEquals(recs.bosses[0].weapons.length, 3);
  assert(recs.bosses[0].weapons.some((w) => w.timing > 0), "the boss fires");
  // the dot is two records: its three "0" cells (first, dropping nothing) and
  // its two "1" cells (dropping the power-up)
  assertStrictEquals(byClass(0).item, 0, "the A0 record drops nothing");
  assertStrictEquals(
    recs.enemies[1].item,
    1,
    "the A1 record drops the power-up",
  );
  assertStrictEquals(recs.enemies[1].movement, KIDS_MOVE_STRAIGHT);
  assertEquals(
    out.report.stages[0].records.map((r) => r.cell).sort(),
    ["A0", "A1", "B0", "C0"],
  );
  assertStrictEquals(byClass(0).bullet, 0, "the dot's shot is bullet quad 0");

  // sprites: every non-blank word names a cell the bank painted
  const painted = new Set();
  for (let c = 0; c < 1024; c++) {
    const cell = save.graphics.subarray(c * 256, c * 256 + 256);
    if (cell.some((v) => v)) painted.add(c);
  }
  assertStrictEquals(painted.size, out.report.cells.used);
  const spr = save.sprites;
  const words = [...spr.ship];
  for (const cl of spr.stages[0].classes) {
    for (const e of cl.entries) words.push(...e);
  }
  for (const b of spr.stages[0].bosses) words.push(...b.words);
  let named = 0;
  for (const w of words) {
    if (w & KIDS_BLANK) continue;
    assert(
      painted.has(w & KIDS_CELL_MASK),
      `word 0x${w.toString(16)} names a painted cell`,
    );
    named++;
  }
  assert(named > 40, `${named} words name art`);
  // the first ship pose is painted, and the second ship is the first again
  assert(!(spr.ship[0] & KIDS_BLANK));
  assertStrictEquals(spr.ship[32], spr.ship[0]);
  // pose 2 is pose 0 mirrored: its top-left is the top-right's cell flipped
  assertStrictEquals(
    spr.ship[8] & KIDS_CELL_MASK,
    spr.ship[1] & KIDS_CELL_MASK,
  );
  // the class-0 strip has four frames of four cells
  const strip0 = spr.stages[0].classes[0].entries[0];
  assertStrictEquals(strip0.filter((w) => !(w & KIDS_BLANK)).length, 16);
  // the boss's 8x8 is fully painted (70x70 art fitted to 128x128 paints its middle)
  const bossWords = spr.stages[0].bosses[0].words;
  assert(bossWords.filter((w) => !(w & KIDS_BLANK)).length >= 16);
  const phase2 = spr.stages[0].bosses[1].words;
  assert(
    phase2.filter((w) => !(w & KIDS_BLANK)).length >= 16,
    "phase 2 draws the boss's second frame",
  );
  assert(
    phase2.some((w, i) => w !== bossWords[i]),
    "phase 2 is the second frame, not the first again",
  );
  // the shot is four 16x16 frames at words 12-15, the bomb an 8x2 strip from 16
  for (let i = 12; i < 16; i++) {
    assert(!(spr.ship[i] & KIDS_BLANK), `shot frame ${i - 12}`);
  }
  for (let f = 0; f < 4; f++) {
    for (const at of bombWords(16, f)) {
      assert(!(spr.ship[at] & KIDS_BLANK), `bomb frame ${f} word ${at}`);
    }
  }
  assertStrictEquals(spr.ship[44], spr.ship[12], "ship 2 shares the shot");
  for (let f = 0; f < 6; f++) {
    for (const at of blastWords(f)) {
      assert(!(spr.ship[at] & KIDS_BLANK), `blast frame ${f} word ${at}`);
    }
  }
  // the seven bullets are the dot's shot, four frames each
  for (let q = 0; q < 7; q++) {
    for (let f = 0; f < 4; f++) {
      assert(
        !(spr.ship[190 + q * 4 + f] & KIDS_BLANK),
        `bullet ${q} frame ${f}`,
      );
    }
  }
  // every map chip word is aligned (all blank here: no scenery)
  for (const w of save.map[0].words) assertStrictEquals(w & KIDS_CELL_ALIGN, 0);
  assertStrictEquals(save.map[0].used, 0);
  // scroll: 1 px/frame to the boss, halted from its unit on
  const bossUnit = Math.floor((st.boss.row * 32) / 64);
  assertStrictEquals(save.scroll[0].steps[0].nibble, 2);
  assertStrictEquals(save.scroll[0].steps[bossUnit].nibble, 0);
  assertStrictEquals(save.scroll[0].steps[191].nibble, 0);
  // tail
  assertStrictEquals(save.hiScores[0].score, 1000);
  assertStrictEquals(save.hiScores[9].score, 100);
  assertStrictEquals(save.options.bgmVolume, 127);
  // the report agrees with the bytes
  assertStrictEquals(out.report.stages.length, 1);
  assertStrictEquals(out.report.stages[0].placements, 8);
  assertStrictEquals(out.report.stages[0].boss.sizeClass, 3);
  assertStrictEquals(out.report.ship, "level");
  assert(out.report.slack > 0);
  assertStrictEquals(
    out.report.sizes.graphics + out.report.sizes.data < 0x1e000,
    true,
  );
  assertEquals(out.warnings, []);
});

Deno.test("scenery: a level's 16x16 cell grid becomes 32x32 chips on aligned cell groups", () => {
  const lv = level();
  const cells = ["bgA.png", "bgB.png"];
  const cols = 14, rows = 8;
  const tiles = new Uint8Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // the left half of the stage is cell A, mirrored on odd columns; the right half empty
      const w = c < 7 ? ((c & 1) ? 0x8000 : 0) | (r < 4 ? 0 : 1) : 0xffff;
      tiles[(r * cols + c) * 2] = w >> 8;
      tiles[(r * cols + c) * 2 + 1] = w & 0xff;
    }
  }
  lv.backgroundCells = cells;
  lv.background = { cols, tiles: btoa(String.fromCharCode(...tiles)) };
  const a = art();
  a["bgA.png"] = frame(16, 16, [90, 120, 40]);
  a["bgB.png"] = frame(16, 16, [40, 60, 160]);
  const out = exportLevelToKidsCard(lv, a);
  const save = parsePsxSav(out.card).saves[0];
  assert(save.checksums.ok);
  const map = save.map[0];
  // four chip rows (eight cell rows), the left four chip columns of seven painted
  assertStrictEquals(map.used, 4 * 4);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 7; c++) {
      const w = map.words[r * 7 + c];
      if (c < 4) {
        assertStrictEquals(w & KIDS_BLANK, 0, `chip ${c},${r} painted`);
      } else {assertStrictEquals(
          w & KIDS_BLANK,
          KIDS_BLANK,
          `chip ${c},${r} blank`,
        );}
      assertStrictEquals(w & KIDS_CELL_ALIGN, 0, "aligned");
    }
  }
  // rows 0-1 are one chip image, rows 2-3 another; chips in a row share one group
  const w00 = map.words[0], w10 = map.words[7 * 2];
  assert(
    (w00 & KIDS_CELL_MASK) !== (w10 & KIDS_CELL_MASK),
    "A chips and B chips are different groups",
  );
  assertStrictEquals(
    map.words[1] & KIDS_CELL_MASK,
    w00 & KIDS_CELL_MASK,
    "the same chip image shares its group",
  );
  assertStrictEquals(out.report.stages[0].chips, 16);
  // A|mirror(A) and B|mirror(B) for chip columns 0-2, A|blank and B|blank
  // for chip column 3, whose right cell is past the painted half.
  assertStrictEquals(out.report.cells.chips, 4, "four distinct chip images");
  assertEquals(out.warnings, []);
});

Deno.test("limits: stages past six, a record table that fills, a horizontal grid, a name that will not fit", () => {
  const lv = level();
  lv.stages = {};
  for (let s = 0; s < 8; s++) {
    lv.stages[`stage${s}`] = { enemylist: lv.enemylist };
  }
  lv.bossData = {};
  const out = buildKidsGameFromLevel(lv, art(), {
    horizontal: true,
    name: "Twelve Char Name",
  });
  assertStrictEquals(out.report.stages.length, KIDS_STAGES);
  assert(out.warnings.some((w) => /8 stages/.test(w)));
  assert(out.warnings.some((w) => /horizontal/.test(w)));
  assert(out.warnings.some((w) => /named "Twelve Cha"/.test(w)));
  assert(out.report.stages.every((s) => s.boss === null));

  // seventeen distinct 32x32 enemies on one stage: class 0 holds sixteen,
  // the seventeenth spills into class 1's box (64x32) rather than vanishing
  const many = {
    name: "many",
    width: 20,
    enemylist: [[]],
    enemyData: {},
    bossData: {},
  };
  const row = [];
  const a = {};
  for (let i = 0; i < 20; i++) {
    const letter = String.fromCharCode(65 + i);
    row.push(letter + "0");
    many.enemyData[`enemy${letter}`] = {
      name: letter,
      hp: 1,
      score: 100,
      speed: 1,
      interval: -1,
      texture: [`e${i}.png`],
    };
    a[`e${i}.png`] = frame(20, 20, [i * 10, 255 - i * 10, 128]);
  }
  many.enemylist = [row];
  const m = buildKidsGameFromLevel(many, a);
  const classes = m.report.stages[0].records.map((r) => r.klass);
  assertStrictEquals(classes.filter((k) => k === 0).length, 16);
  assertStrictEquals(classes.filter((k) => k === 1).length, 4);
});

Deno.test("a name is refused by the block builder unless it is the 20 Shift-JIS bytes", () => {
  const g = buildKidsGameFromLevel(level(), art());
  assertThrows(
    () => buildKidsBlock({ ...g, name: "tiny", icon: g.icon }),
    Error,
    "20 bytes",
  );
  assertThrows(
    () =>
      buildKidsBlock({
        ...g,
        name: g.name.bytes,
        icon: g.icon,
        tail: new Uint8Array(3),
      }),
    Error,
    "tail",
  );
});

// --- the disc's own games through the block assembler -------------------------------
//
// SGM_*.CMP decompress to a save's graphics and data sections back to back
// (FORMAT-PSX.md, "The disc's own games"); wrapped in a block here, parsed
// back, they must come out byte for byte with every checksum verifying.

const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);

function findKidsDisc() {
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return null;
    }
    for (const e of entries) {
      // A fixtures folder may be a symlink into another checkout: stat it.
      let isDir = e.isDirectory, isFile = e.isFile;
      if (e.isSymlink) {
        try {
          const st = Deno.statSync(new URL(encodeURIComponent(e.name), dir));
          isDir = st.isDirectory;
          isFile = st.isFile;
        } catch {
          continue;
        }
      }
      const url = new URL(
        `${encodeURIComponent(e.name)}${isDir ? "/" : ""}`,
        dir,
      );
      if (isDir && depth > 0 && /kids/i.test(e.name)) {
        const hit = walk(url, depth - 1);
        if (hit) return hit;
      } else if (
        isFile && /kids/i.test(e.name) && /\.(bin|iso|img)$/i.test(e.name) &&
        !e.name.startsWith("._")
      ) {
        return url;
      }
    }
    return null;
  };
  return walk(DEV_FIXTURES, 1);
}

const KIDS_DISC = findKidsDisc();

Deno.test({
  name:
    "the disc's sample games wrap into blocks the parser reads back byte for byte",
  ignore: !KIDS_DISC,
  fn() {
    const disc = openDisc(Deno.readFileSync(KIDS_DISC));
    assert(disc, "the image opens as ISO 9660");
    const exe = readFile(disc, "KIDS.EXE");
    const dat = readFile(disc, "KIDS_DAT.BIN");
    assert(exe && dat, "KIDS.EXE and KIDS_DAT.BIN are on the disc");
    // The archive's directory is in KIDS.EXE (FORMAT-PSX.md, "The disc's own
    // games"): 38 records of {char* dir, u8 count, entry*} at 0x800B0B78.
    const u32 = (b, at) =>
      (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
    const tAddr = u32(exe, 0x18);
    const file = (ram) => ram - tAddr + 0x800;
    const cstr = (ram) => {
      let s = "", p = file(ram);
      while (exe[p]) s += String.fromCharCode(exe[p++]);
      return s;
    };
    const samples = [];
    for (let i = 0; i < 38; i++) {
      const rec = 0x800b0b78 + i * 12;
      if (cstr(u32(exe, file(rec))) !== "\\SAMPLE\\") continue;
      const count = exe[file(rec) + 4], list = u32(exe, file(rec) + 8);
      for (let k = 0; k < count; k++) {
        const e = file(list + k * 8);
        const name = cstr(u32(exe, e));
        const start = exe[e + 4] | (exe[e + 5] << 8),
          sectors = exe[e + 6] | (exe[e + 7] << 8);
        samples.push({
          name,
          bytes: dat.subarray(start * 2048, (start + sectors) * 2048),
        });
      }
    }
    assert(samples.length >= 13, `${samples.length} sample games`);
    const tail = factoryKidsTail();
    const icon = encodeKidsIcon(defaultKidsIcon());
    for (const sample of samples.slice(0, 4)) {
      const raw = Uint8Array.from(decompressCmp(sample.bytes));
      assertStrictEquals(
        raw.length,
        KIDS_GRAPHICS_SIZE + KIDS_DATA_SIZE,
        sample.name,
      );
      const graphics = raw.subarray(0, KIDS_GRAPHICS_SIZE);
      const data = raw.subarray(KIDS_GRAPHICS_SIZE);
      const { block } = buildKidsBlock({
        graphics,
        data,
        tail,
        name: kidsNameBytes(sample.name.slice(4, 8)),
        icon,
      });
      const save = parseKidsSave(block, { filename: KIDS_PRODUCT });
      assertEquals(save.errors, [], sample.name);
      assert(save.checksums.ok, `${sample.name} sums`);
      assertEquals(save.graphics, graphics, `${sample.name} graphics`);
      assertEquals(save.data, data, `${sample.name} data`);
      assertStrictEquals(save.gameNameAscii, sample.name.slice(4, 8));
      // what the writer assumes about the layout holds on Athena's own data:
      // every chip aligned, every painted sprite word inside the bank, every
      // footprint mark owned
      for (const m of save.map) {
        for (const w of m.words) assertStrictEquals(w & KIDS_CELL_ALIGN, 0);
      }
      // The footprint marks are Athena's editor's and not this writer's — the
      // samples carry the orphans a resized boss leaves (FORMAT-PSX.md,
      // "APPEAR") — so they are read, not held to a count.
      for (const st of save.appear) assert(Array.isArray(st.marks));
      for (const b of save.records.flatMap((r) => r.bosses)) {
        assert(b.sizeClass >= 0 && b.sizeClass < KIDS_BOSS_FOOTPRINT.length);
      }
    }
    assertStrictEquals(KIDS_APPEAR_COLUMNS, 9);
  },
});

// --- a stage's story, as its opening map rows ---

/** A story backdrop: 224 wide, `h` px, one colour or (noise) a new chip every 32 px. */
function storyRaster(label, h, rgb, noise = false) {
  const w = 224;
  const rgba = new Uint8Array(w * h * 4);
  let seed = 13;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (let i = 0; i < w * h; i++) {
    rgba.set(noise ? [rnd(), rnd(), rnd(), 255] : [...rgb, 255], i * 4);
  }
  return { label, w, h, rgba };
}

Deno.test("a stage's story opens its map: chip rows from the first story row up, waves after it", () => {
  const plain = exportLevelToKidsCard(level(), art());
  const out = exportLevelToKidsCard(level(), art(), {
    storyBackdrops: [{ stage: 0, variants: [storyRaster("words", 64, [255, 255, 255])] }],
  });
  assertEquals(out.warnings.filter((w) => /story/.test(w)), []);
  const save = parsePsxSav(out.card).saves[0];
  assert(save.checksums.ok);
  const map = save.map[0];
  const painted = (r) => Array.from({ length: 7 }, (_, c) => map.words[r * 7 + c]).some((w) => (w & KIDS_BLANK) === 0);
  const first = KIDS_STORY_FIRST_ROW;
  assert(!painted(first - 1) && painted(first) && painted(first + 1) && !painted(first + 2));
  assertStrictEquals(
    out.report.stages[0].lastRow,
    plain.report.stages[0].lastRow + first + 2 + KIDS_STORY_LEAD_ROWS,
    "the waves and the boss wait for it",
  );
  assertStrictEquals(save.scroll[0].steps[0].nibble, KIDS_STORY_SCROLL, "its first 64 px crawl");
  assertStrictEquals(save.scroll[0].steps[KIDS_STORY_SLOW_UNITS].nibble, 2);
  assertEquals(out.report.stages[0].story, { size: "words", rows: 2, cells: 4, first });
});

Deno.test("a story the cells or the save cannot hold is drawn smaller, else not at all", () => {
  // 40 chip rows of noise want 1,120 cells: more than the bank holds.
  const smaller = exportLevelToKidsCard(level(), art(), {
    storyBackdrops: [{
      stage: 0,
      variants: [storyRaster("huge", 40 * 32, null, true), storyRaster("words", 32, [255, 255, 255])],
    }],
  });
  assertStrictEquals(smaller.report.stages[0].story.size, "words");
  // 32 chip rows of noise fit the cells but not the save's fifteen blocks.
  const packed = exportLevelToKidsCard(level(), art(), {
    storyBackdrops: [{
      stage: 0,
      variants: [storyRaster("big", 32 * 32, null, true), storyRaster("words", 32, [255, 255, 255])],
    }],
  });
  assertStrictEquals(packed.report.stages[0].story.size, "words");
  assert(packed.warnings.some((w) => /drawn smaller so the save fits/.test(w)));
  const none = exportLevelToKidsCard(level(), art(), {
    storyBackdrops: [{ stage: 0, variants: [storyRaster("big", 32 * 32, null, true)] }],
  });
  assertStrictEquals(none.report.stages[0].story, null);
});
