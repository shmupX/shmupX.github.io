// A level record -> a Dezaemon+ memory card -> back through plus.js: the
// writer is checked by the reader that reads the community collection, and
// by the program's own group checksums, which pin every table boundary.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  buildPlusBlock,
  buildPlusGameFromLevel,
  encodePlusEnemy,
  exportLevelToPlusCard,
  layoutTitle,
  mapPlusColumn,
  PLUS_DEF_CLASSES,
  PLUS_EMPTY_TILE,
  PLUS_STORY_MIN_BOSS_ROW,
  PLUS_STORY_SCROLL_EFFECT,
  PLUS_STORY_TOP_ROW,
  PLUS_FACTORY_SETTINGS,
  PLUS_GROUP_HFLIP,
  PLUS_LAYOUT_HFLIP,
  PLUS_LAYOUT_VFLIP,
  PLUS_OPAQUE,
  PLUS_TILE_CAPACITY,
  PLUS_TILE_COUNT,
  plusCardFileName,
  plusClassFor,
  plusFrameRect,
  plusLayoutIndexFor,
  PlusPaletteRow,
  plusSheetCellFor,
  PlusTileBank,
  plusTileIndex,
  plusTileWord,
} from "../src/psx/plus-write.js";
import {
  decodePlusAppear,
  decodePlusEnemy,
  decodePlusEnemyData,
  decodePlusGroupWord,
  decodePlusMapGroup,
  PLUS_BLOCK_SIZE,
  PLUS_PRODUCT,
  plusChecksums,
} from "../src/psx/plus.js";
import { parsePsxSav } from "../src/psx/index.js";
import { CARD_SIZE } from "../src/psx/memcard.js";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0;
  return { w, h, rgba };
}

function level() {
  return {
    name: "tiny plus",
    width: 8,
    enemylist: [
      ["00", "00", "B0", "00", "00", "B0", "00", "00"],
      ["A1", "00", "00", "A0", "00", "00", "00", "A1"],
      ["00", "A0", "00", "00", "C0", "00", "A0", "00"],
    ],
    enemyData: {
      enemyA: {
        name: "dot",
        hp: 3,
        score: 200,
        speed: 1,
        interval: 60,
        texture: ["dot0.png", "dot1.png"],
        frameRate: 8,
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
    playerData: { texture: ["ship0.png", "ship1.png"] },
  };
}

function art() {
  return {
    "dot0.png": frame(12, 14, [255, 0, 0]),
    "dot1.png": frame(12, 14, [200, 0, 0]),
    "slab0.png": frame(28, 14, [0, 0, 255]),
    "tower0.png": frame(14, 30, [0, 200, 0]),
    "boss0.png": frame(70, 70, [0, 255, 0]),
    "boss1.png": frame(70, 70, [0, 200, 0]),
    "ship0.png": frame(24, 24, [255, 255, 255]),
    "ship1.png": frame(24, 24, [220, 220, 255]),
  };
}

Deno.test("tile words round-trip and name the save's two pages", () => {
  for (const n of [0, 1, 7, 8, 15, 16, 255, 256, 511]) {
    const w = plusTileWord(n);
    assert(w <= 0x1ff, `tile ${n} stays in pages 0-1`);
    assertStrictEquals(plusTileIndex(w), n);
    const d = decodePlusGroupWord(w);
    assertStrictEquals(d.column, n % 16);
    assertStrictEquals(d.row, Math.floor(n / 16) % 16);
    assertStrictEquals(d.half, n >= 256 ? 1 : 0);
  }
  assertStrictEquals(
    plusTileIndex(0x2a0),
    null,
    "a page-2 word is not in the save",
  );
  assertStrictEquals(plusClassFor(12, 14), 0);
  assertStrictEquals(plusClassFor(28, 14), 1);
  assertStrictEquals(plusClassFor(14, 30), 2);
  assertStrictEquals(plusClassFor(32, 32), 3);
  assertStrictEquals(plusClassFor(70, 70), 4);
  assertEquals([0, 7].map((c) => mapPlusColumn(c, 8)), [0, 13]);
  assertStrictEquals(mapPlusColumn(7, 8, 2), 12);
  assertStrictEquals(mapPlusColumn(0, 1), 6);
  assertStrictEquals(PLUS_DEF_CLASSES.reduce((a, c) => a + c.count, 0), 60);
  assertStrictEquals(plusCardFileName("a/b"), "Dezaemon Plus - a b.mcr");
});

Deno.test("the tile bank shares tiles and mirrors; a palette row quantises to fifteen opaque colours", () => {
  const bank = new PlusTileBank();
  const t = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) t[y * 16 + x] = x < 8 ? 1 : 2;
  }
  const a = bank.add(t);
  assertStrictEquals(a, 0);
  assertStrictEquals(bank.add(t), 0, "shared");
  const h = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) h[y * 16 + x] = t[y * 16 + 15 - x];
  }
  const m = bank.addFlippable(h);
  assertEquals(m, { tile: 0, hflip: true, vflip: false });
  assertStrictEquals(bank.used, 1);
  assertStrictEquals(
    bank.add(new Uint8Array(256)),
    null,
    "a blank tile is no tile",
  );
  const bitmap = bank.toBitmap();
  assertStrictEquals(bitmap[0], 0x11, "two index-1 pixels, low nibble left");
  assertStrictEquals(bitmap[4], 0x22);
  assertStrictEquals(bank.free, PLUS_TILE_CAPACITY - 1);

  const row = new PlusPaletteRow(6);
  const f = frame(16, 16, [250, 10, 10]);
  row.consider(f);
  row.build();
  assertStrictEquals(row.count, 1);
  assertStrictEquals(row.words[0], 0, "colour 0 transparent");
  assert(row.words[1] & PLUS_OPAQUE, "an opaque colour carries the STP bit");
  const idx = row.index(f);
  assertStrictEquals(idx[0], 0, "the transparent corner");
  assertStrictEquals(idx[1], 1);
});

Deno.test("encodePlusEnemy is decodePlusEnemy's inverse", () => {
  const bytes = encodePlusEnemy({
    movement: 83,
    shotPattern: 13,
    fireRate: 5,
    shotMode: 2,
    dropsItem: true,
    scaleRateIndex: 3,
    hpIndex: 6,
    hitFlags: 4,
    scoreIndex: 7,
    turnEndAction: 1,
    animIndex: 5,
    rotation: 3,
    endScaleIndex: 2,
    startScaleIndex: 1,
    startTrigger: 2,
    headingIndex: 4,
    turnRateIndex: 7,
  });
  const d = decodePlusEnemy(bytes, 0, 0, 0);
  assertStrictEquals(d.movement, 83);
  assertStrictEquals(d.shotPattern, 13);
  assertStrictEquals(d.fireRate, 5);
  assertStrictEquals(d.shotMode, 2);
  assertStrictEquals(d.dropsItem, true);
  assertStrictEquals(d.hitPoints, 1000);
  assertStrictEquals(d.score, 10000);
  assertStrictEquals(d.animationInterval, 2);
  assertStrictEquals(d.rotation, 3);
  assertStrictEquals(d.endScale, 8);
  assertStrictEquals(d.startScale, 6);
  assertStrictEquals(d.startTrigger, 2);
  assertStrictEquals(d.startAngle, 0x80);
  assertStrictEquals(d.turnRate, 2048);
  assertStrictEquals(d.hitFlags, 4);
});

Deno.test("the sheet geometry: layout bytes and cells are inverses, frames sit where the spawners look", () => {
  for (let i = 0; i < 0x140; i++) {
    const { cx, cy } = plusSheetCellFor(i);
    assert(
      cx >= 0 && cx < 16 && cy >= 0 && cy < 20,
      `byte ${i} -> ${cx},${cy}`,
    );
    assertStrictEquals(plusLayoutIndexFor(cx, cy), i);
  }
  const seen = new Set();
  for (let i = 0; i < 0x140; i++) {
    const { cx, cy } = plusSheetCellFor(i);
    seen.add(cy * 16 + cx);
  }
  assertStrictEquals(
    seen.size,
    320,
    "every cell of the 256x320 sheet is reached once",
  );
  assertEquals(plusFrameRect(0, 5, 2), { x: 64 + 32, y: 16, w: 16, h: 16 });
  assertEquals(plusFrameRect(1, 3, 1), { x: 192 + 32, y: 64, w: 32, h: 16 });
  assertEquals(plusFrameRect(2, 9, 0), { x: 32, y: 160, w: 16, h: 32 });
  assertEquals(plusFrameRect(3, 7, 1), { x: 192 + 32, y: 224, w: 32, h: 32 });
  assertEquals(plusFrameRect(4, 2, 0), { x: 128, y: 256, w: 64, h: 64 });
});

Deno.test("layoutTitle puts the 8x4 block down as two 4x4 blocks, the boss's grid", () => {
  const tiles = Array.from({ length: 32 }, (_, i) => i + 1);
  const words = layoutTitle(tiles);
  // word i: block i>>4, row (i>>2)&3, column i&3 -> cell (block*4+col, row) of the 8x4
  assertEquals(Array.from(words.slice(0, 4)).map((w) => plusTileIndex(w)), [
    1,
    2,
    3,
    4,
  ]);
  assertEquals(Array.from(words.slice(4, 8)).map((w) => plusTileIndex(w)), [
    9,
    10,
    11,
    12,
  ]);
  assertEquals(Array.from(words.slice(16, 20)).map((w) => plusTileIndex(w)), [
    5,
    6,
    7,
    8,
  ]);
  assertStrictEquals(plusTileIndex(words[31]), 32);
  assertStrictEquals(layoutTitle([])[0], PLUS_EMPTY_TILE);
});

Deno.test("a level becomes a card plus.js reads back as a Dezaemon+ game whose checksums verify", () => {
  const out = exportLevelToPlusCard(level(), art(), {
    title1: frame(100, 40, [255, 255, 0]),
  });
  assertStrictEquals(out.card.length, CARD_SIZE);
  assertStrictEquals(out.fileName, "Dezaemon Plus - tiny plus.mcr");
  const parsed = parsePsxSav(out.card);
  assertStrictEquals(parsed.container, "card");
  const save = parsed.saves[0];
  assertStrictEquals(save.game, "plus");
  assertStrictEquals(save.filename, PLUS_PRODUCT);
  assertEquals(save.errors, []);
  assert(save.checksums.ok, `groups ${save.checksums.bad.join(",")} verify`);
  assertStrictEquals(plusChecksums(out.block).bad.length, 0);
  assertStrictEquals(save.globals.stageCount, 1);
  assertEquals(
    Array.from(save.settings.bytes),
    Array.from(PLUS_FACTORY_SETTINGS),
  );
  assertStrictEquals(save.hiScores[0].score, 1000);
  assertStrictEquals(save.hiScores[19].score, 100);
  assertStrictEquals(save.hiScores[0].name, "........");
  // the stage: spawns the grid asked for, the boss past the last wave
  const st = save.stages[0];
  const ap = decodePlusAppear(st);
  const spawns = ap.records.flatMap((r) => r.spawns);
  assertStrictEquals(spawns.filter((p) => !p.boss).length, 8);
  const boss = spawns.find((p) => p.boss);
  assert(boss, "the boss is placed");
  assert(ap.records[1].end, "record 1 is the end mark");
  const bands = Array.from(ap.rowTable).map((r, i) => (r ? i : -1)).filter((
    i,
  ) => i >= 0);
  assert(bands.length >= 4, `${bands.length} bands spawn`);
  assertStrictEquals(
    Math.max(...bands),
    out.report.stages[0].boss.band,
    "the boss is the last band",
  );
  // definitions: dot 16x16, slab 32x16, tower 16x32, decoded as encoded
  const ed = decodePlusEnemyData(st);
  const defs = out.report.stages[0].definitions;
  assertEquals(defs.map((d) => d.klass).sort(), [0, 1, 2]);
  const dot = ed.enemies[defs.find((d) => d.name === "dot").index];
  assertStrictEquals(dot.movement, 8, "speed 1 -> 0.5 px/frame, script 8");
  assertStrictEquals(
    ed.enemies[defs.find((d) => d.name === "tower").index].movement,
    14,
    "speed 10 -> 4.5 px/frame",
  );
  assertStrictEquals(dot.score, 200);
  assertStrictEquals(dot.animationInterval, 9, "8 fps -> 7.5 frames -> 9");
  assert(dot.fireRate > 0, "the dot fires");
  const slab = ed.enemies[defs.find((d) => d.name === "slab").index];
  assertStrictEquals(slab.fireRate, 0);
  assertStrictEquals(slab.score, 1000);
  assert(slab.hitPoints > dot.hitPoints);
  // the boss: a horizontal 128x64 picture (70x70 art fits a 64x64 middle),
  // the sample's behaviour with the level's hit points and score
  const bossWords = [];
  for (let i = 0; i < 32; i++) {
    bossWords.push(
      st.parts.bossGroup[i * 2] | (st.parts.bossGroup[i * 2 + 1] << 8),
    );
  }
  const painted = bossWords.filter((w) => w !== PLUS_EMPTY_TILE);
  assert(painted.length >= 16, `${painted.length} boss tiles painted`);
  for (const w of painted) {
    assert(plusTileIndex(w & ~(PLUS_GROUP_HFLIP | 0x8000)) !== null);
  }
  const bossRec = ed.boss;
  assertEquals(
    Array.from(bossRec.subarray(0, 3)),
    [0x1c, 0x20, 0x14],
    "the sample's phase scripts",
  );
  assertStrictEquals(bossRec[6] & 0x40, 0, "horizontal");
  assertStrictEquals(bossRec[13] & 7, 2, "300 hits x 24 -> 8000 hp");
  assertStrictEquals(bossRec[14] & 7, 0, "6000 points -> the 5000 tier");
  assertStrictEquals(bossRec[31], 1);
  assertStrictEquals(out.report.stages[0].boss.vertical, false);
  // the enemy sheet: every frame cell of every definition names a painted
  // group entry, with the flips a mirrored tile asked for
  const eg = [];
  for (let i = 0; i < 64; i++) {
    eg.push(st.parts.enemyGroup[i * 2] | (st.parts.enemyGroup[i * 2 + 1] << 8));
  }
  assertStrictEquals(eg[0], PLUS_EMPTY_TILE, "entry 0 is the blank cell");
  assert(
    out.report.stages[0].enemyEntries >= 3,
    `${out.report.stages[0].enemyEntries} entries`,
  );
  for (let e = 1; e <= out.report.stages[0].enemyEntries; e++) {
    assert(plusTileIndex(eg[e]) !== null, `entry ${e} names a tile`);
  }
  const layout = st.parts.spriteLayout;
  let cells = 0;
  for (const d of defs) {
    const frames = [4, 2, 2, 2, 1][d.klass];
    for (let k = 0; k < frames; k++) {
      const r = plusFrameRect(d.klass, d.id, k);
      for (let cy = r.y / 16; cy < (r.y + r.h) / 16; cy++) {
        for (let cx = r.x / 16; cx < (r.x + r.w) / 16; cx++) {
          const b = layout[plusLayoutIndexFor(cx, cy)];
          const entry = b & 0x3f;
          assert(
            entry === 0 || plusTileIndex(eg[entry]) !== null,
            `${d.name} frame ${k} cell ${cx},${cy}`,
          );
          if (entry) cells++;
          assertStrictEquals(
            b & ~(0x3f | PLUS_LAYOUT_HFLIP | PLUS_LAYOUT_VFLIP),
            0,
          );
        }
      }
    }
  }
  assertStrictEquals(cells, out.report.stages[0].enemyTiles);
  assert(cells >= 8, `${cells} enemy cells painted`);
  // the ship: three 2x2 poses in words 0-11, the forced words, the dead ones
  const sg = save.globals.parts.shipGroup;
  const shipWords = [];
  for (let i = 0; i < 77; i++) shipWords.push(sg[i * 2] | (sg[i * 2 + 1] << 8));
  assert(
    shipWords.slice(0, 12).every((w) => w !== PLUS_EMPTY_TILE),
    "poses painted",
  );
  assertEquals(shipWords.slice(61, 64), [0x3fc, 0x3fd, 0x3fe]);
  assertEquals(shipWords.slice(64, 72), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert(save.globals.parts.shipOdr.every((b) => b === 0));
  // the title: 32 words, painted
  assertStrictEquals(out.report.title, "uploaded");
  const tg = save.globals.parts.titleGroup;
  const titleWords = [];
  for (let i = 0; i < 32; i++) {
    titleWords.push(tg[i * 2] | (tg[i * 2 + 1] << 8));
  }
  assert(titleWords.filter((w) => w !== PLUS_EMPTY_TILE).length >= 20);
  // palettes: the rows the art drew with are in use, each 1..15 colours
  const inUse = save.palettes.filter((r) => !r.blank).map((r) => r.row);
  assert(
    inUse.includes(6) && inUse.includes(12) && inUse.includes(18) &&
      inUse.includes(19),
    `rows ${inUse}`,
  );
  for (const r of save.palettes) {
    assertStrictEquals(r.colors[0].raw, 0, "colour 0 transparent");
  }
  // no scenery: the map is blank and MAP GROUP empty past the blank group
  assertStrictEquals(st.used, 0);
  assertStrictEquals(
    decodePlusMapGroup(st).filter((w) => w.raw !== PLUS_EMPTY_TILE).length,
    0,
  );
  assert(
    out.report.tiles.used >= 8 && out.report.tiles.used < PLUS_TILE_CAPACITY,
    `${out.report.tiles.used} tiles used`,
  );
});

Deno.test("scenery lands 1:1 as chips over MAP GROUP tiles, with the flips a cell asked for", () => {
  const lv = level();
  const cols = 14, rows = 6;
  const tiles = new Uint8Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = c < 7
        ? ((c & 1) ? 0x8000 : 0) | ((r & 1) ? 0x4000 : 0) | (r < 3 ? 0 : 1)
        : 0xffff;
      tiles[(r * cols + c) * 2] = w >> 8;
      tiles[(r * cols + c) * 2 + 1] = w & 0xff;
    }
  }
  lv.backgroundCells = ["bgA.png", "bgB.png"];
  lv.background = { cols, tiles: btoa(String.fromCharCode(...tiles)) };
  const a = art();
  // asymmetric cells, so a flip is a different picture
  const cell = (rgb) => {
    const f = frame(16, 16, rgb);
    for (let i = 0; i < 16 * 8; i++) f.rgba[i * 4 + 3] = 0; // top half transparent
    f.rgba[3] = 0;
    return f;
  };
  a["bgA.png"] = cell([90, 120, 40]);
  a["bgB.png"] = cell([40, 60, 160]);
  const out = exportLevelToPlusCard(lv, a);
  const save = parsePsxSav(out.card).saves[0];
  assert(save.checksums.ok);
  const st = save.stages[0];
  assertStrictEquals(st.used, 7 * 6, "seven painted columns over six rows");
  assertStrictEquals(
    out.report.stages[0].groups,
    2,
    "two tiles, one per cell image",
  );
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 7; c++) {
      const chip = st.mapRows[r][c + 1];
      assert(!chip.blank);
      assertStrictEquals(chip.hflip, (c & 1) === 1, `chip ${c},${r} h-flip`);
      assertStrictEquals(chip.vflip, (r & 1) === 1, `chip ${c},${r} v-flip`);
    }
    assert(
      st.mapRows[r][0].blank && st.mapRows[r][15].blank,
      "columns 0 and 15 stay empty",
    );
  }
  const mg = decodePlusMapGroup(st);
  assertStrictEquals(mg[0].raw, PLUS_EMPTY_TILE, "group 0 is the blank chip");
  assert(mg[1].raw !== PLUS_EMPTY_TILE && mg[2].raw !== PLUS_EMPTY_TILE);
  assertStrictEquals(st.parts.scroll[33], 1, "the scroll loops the 32 blocks");
});

Deno.test("limits and refusals", () => {
  const lv = level();
  lv.stages = {};
  for (let s = 0; s < 7; s++) {
    lv.stages[`stage${s}`] = { enemylist: lv.enemylist };
  }
  const g = buildPlusGameFromLevel(lv, art(), { horizontal: true });
  assertStrictEquals(g.report.stages.length, 5);
  assert(g.warnings.some((w) => /7 stages/.test(w)));
  assert(g.warnings.some((w) => /horizontal/.test(w)));
  assertThrows(
    () => buildPlusBlock(new Uint8Array(10)),
    Error,
    String(PLUS_BLOCK_SIZE),
  );
});

// --- a stage's story, as its opening map rows ---

/** A story backdrop: 224 wide, `rows` map rows, one colour or (noise) a new tile every 16 px. */
function storyRaster(label, rows, rgb, noise = false) {
  const w = 224, h = rows * 16;
  const rgba = new Uint8Array(w * h * 4);
  let seed = 17;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (let i = 0; i < w * h; i++) {
    rgba.set(noise ? [rnd(), rnd(), rnd(), 255] : [...rgb, 255], i * 4);
  }
  return { label, w, h, rgba };
}

Deno.test("a stage's story opens the map: its top on the top row, columns 1-14, played once, slowly", () => {
  const out = exportLevelToPlusCard(level(), art(), {
    storyBackdrops: [{ stage: 0, variants: [storyRaster("words", 3, [255, 255, 255])] }],
  });
  assertEquals(out.warnings.filter((w) => /story/.test(w)), []);
  const save = parsePsxSav(out.card).saves[0];
  assert(save.checksums.ok);
  const st = save.stages[0];
  const top = PLUS_STORY_TOP_ROW;
  const painted = (r) => st.mapRows[r].some((chip) => !chip.blank);
  for (let r = top - 2; r <= top; r++) {
    assert(painted(r), `row ${r} carries the story`);
    for (let c = 1; c <= 14; c++) assert(!st.mapRows[r][c].blank, `row ${r} column ${c}`);
    assert(st.mapRows[r][0].blank && st.mapRows[r][15].blank, "columns 0 and 15 stay empty");
  }
  assert(!painted(top - 3) && !painted(top + 1));
  const k = Math.ceil((top + 1) / 4);
  const scroll = st.parts.scroll;
  assertEquals([...scroll.subarray(0, 32)], Array.from({ length: 32 }, (_, i) => i));
  assert([...scroll.subarray(32, 256)].every((b) => b >= k && b < 32), "its blocks never come back");
  assertEquals([...scroll.subarray(256, 256 + k)], new Array(k).fill(PLUS_STORY_SCROLL_EFFECT));
  assertStrictEquals(scroll[256 + k], 0x42);
  assert(out.report.stages[0].boss.band >= PLUS_STORY_MIN_BOSS_ROW);
  assertEquals(out.report.stages[0].story, { size: "words", rows: 3, chips: 42, top });
});

Deno.test("a Dezaemon+ story past a stage map's 127 tiles is drawn smaller, else not at all", () => {
  const huge = storyRaster("huge", 12, null, true);
  const smaller = exportLevelToPlusCard(level(), art(), {
    storyBackdrops: [{ stage: 0, variants: [huge, storyRaster("small", 2, [0, 0, 255])] }],
  });
  assertStrictEquals(smaller.report.stages[0].story.size, "small");
  const none = exportLevelToPlusCard(level(), art(), {
    storyBackdrops: [{ stage: 0, variants: [huge] }],
  });
  assert(none.warnings.some((w) => /no size of its story fits a stage map/.test(w)));
  assertStrictEquals(none.report.stages[0].story, null);
});
