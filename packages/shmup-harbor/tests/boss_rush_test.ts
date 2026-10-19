// lib/boss-rush.ts — a level cut down to its bosses for the console exporters.
//
// The shapes here are the three a level record comes in (a `stages` map, the
// flat single-stage fields, the oldest top-level stageN blocks) and the parts
// of gs that matter to the seven-target capture: two stages of eight-column
// rows, seven enemy types of known toughness, a second boss with a `stage2`
// form, an import's cart boss row. The last test runs the result through the
// Saturn writer's own stage reader, which is what every console writer pairs
// with `boss<i>`.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { levelStages } from "@shmupx/shmup-engine/game-to-save";
import {
  bossRushRecord,
  describeBossRush,
  hangDrops,
  levelDrops,
  levelEnemyTypes,
  parseBossRushFlag,
  showcaseRows,
} from "../lib/boss-rush.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const EMPTY = ["00", "00", "00", "00", "00", "00", "00", "00"];

/** gs, cut down: its enemies, its row width, two stages, two bosses. */
function gsLike(): Json {
  return {
    name: "gs",
    width: 8,
    stageKey: "stage0",
    enemylist: [EMPTY, ["00", "E0", "00", "00", "00", "00", "00", "E0"]],
    enemyData: {
      enemyA: { hp: 3 },
      enemyB: { hp: 10 },
      enemyC: { hp: 4 },
      enemyD: { hp: 4 },
      enemyE: { hp: 20 },
      enemyF: { hp: 20 },
      enemyG: { hp: 1 },
    },
    stages: {
      stage0: {
        enemylist: [
          EMPTY,
          ["00", "E0", "00", "00", "00", "00", "00", "E0"],
          ["00", "00", "00", "F0", "00", "00", "00", "00"],
          ["B9", "00", "00", "00", "00", "00", "00", "00"],
          ["D0", "00", "00", "00", "D0", "00", "00", "00"],
          ["00", "A0", "00", "A0", "00", "A0", "00", "00"],
        ],
        waveRows: [{ row: 0 }],
        background: { cols: 8 },
      },
      stage1: {
        enemylist: [
          EMPTY,
          EMPTY,
          ["G0", "00", "C0", "00", "C9", "C0", "00", "G0"],
          ["00", "G0", "00", "00", "00", "00", "G2", "00"],
          ["00", "00", "C0", "C0", "C1", "C0", "00", "00"],
          ["00", "00", "00", "G3", "00", "00", "00", "00"],
        ],
        background: { cols: 10 },
      },
    },
    bossData: {
      boss0: { name: "geekstar", hp: 240 },
      boss1: {
        name: "Daltonius",
        hp: 3500,
        dezaemon: { row: 180, size: 2 },
        stage2: { hpBelow: 0.5, anim: { morph: ["liuKangDragon0"] } },
      },
    },
    storyData: { stage0: [{ text: "hello" }] },
    dezaemonBgm: { stages: [[1, 2], [3, 4]], songs: {} },
  };
}

/** gs's showcase formation: toughest in the middle, the weakest on both wings. */
const ARCH = ["G0", "D0", "B0", "E0", "F0", "C0", "A0", "G0"];

/**
 * …carrying gs's four drops, each on an enemy that drops it in the level:
 * the barrier (9) on the car, the 3-way (2) and the shot speed (3) on the two
 * flirty girls, the big shot (1) on the laptop.
 */
const GS_ROW = ["G2", "D0", "B9", "E0", "F0", "C1", "A0", "G3"];

Deno.test("parseBossRushFlag reads both spellings and refuses junk", () => {
  assertEquals(parseBossRushFlag("--boss-rush"), 0);
  assertEquals(parseBossRushFlag("--boss-rush=1"), 1);
  assertEquals(parseBossRushFlag("--boss"), undefined);
  assertEquals(parseBossRushFlag("--out=x"), undefined);
  assertThrows(() => parseBossRushFlag("--boss-rush=two"), Error, "two");
  assertThrows(() => parseBossRushFlag("--boss-rush=-1"), Error);
});

Deno.test("the level's enemy types come strongest first, from every stage", () => {
  // E and F (hp 20) tie and sort by letter; C and D (hp 4) likewise.
  assertEquals(levelEnemyTypes(gsLike()), ["E", "F", "B", "C", "D", "A", "G"]);
});

Deno.test("the showcase is an arch by toughness, mirrored into spare columns", () => {
  assertEquals(
    showcaseRows(["E", "F", "B", "C", "D", "A", "G"], 8),
    [ARCH],
  );
  // An odd width has a true middle column.
  assertEquals(showcaseRows(["X", "Y", "Z"], 5), [[
    "00",
    "Y0",
    "X0",
    "Z0",
    "00",
  ]]);
  // Two types in eight columns leave the wings empty rather than inventing
  // enemies the mirror has nothing to copy.
  assertEquals(showcaseRows(["X", "Y"], 8), [[
    "00",
    "00",
    "00",
    "X0",
    "Y0",
    "00",
    "00",
    "00",
  ]]);
  // More types than columns spill into a second row.
  assertEquals(showcaseRows(["A", "B", "C", "D", "E"], 4).length, 2);
  assertEquals(showcaseRows([], 8), []);
});

Deno.test("the level's drops ride the showcase once each, on enemies that drop them", () => {
  assertEquals(levelDrops(gsLike()), [
    ["9", ["B", "C"]],
    ["2", ["G"]],
    ["1", ["C"]],
    ["3", ["G"]],
  ]);
  const rows = [ARCH.slice()];
  hangDrops(rows, levelDrops(gsLike()));
  assertEquals(rows, [GS_ROW]);
  // A drop no showcased enemy carries goes on the first free cell, middle out.
  const lone = [["00", "X0", "Y0", "00"]];
  hangDrops(lone, [["5", ["Q"]], ["1", ["Y"]], ["2", ["Q"]]]);
  assertEquals(lone, [["00", "X5", "Y1", "00"]]);
});

Deno.test("every stage keeps its scenery and boss and trades its waves for the showcase", () => {
  const record = gsLike();
  const summary = bossRushRecord(record);
  assertEquals(summary.stages, ["stage0", "stage1"]);
  assertEquals(summary.dropped, []);
  assertEquals(summary.bosses, ["boss0", "boss1"]);
  assertEquals(summary.waveRowsCleared, 12);
  assertEquals(summary.showcase, [GS_ROW]);
  // Each stage keeps its own opening beat of empty rows ahead of the row.
  assertEquals(record.stages.stage0.enemylist, [EMPTY, GS_ROW]);
  assertEquals(record.stages.stage1.enemylist, [EMPTY, EMPTY, GS_ROW]);
  assertEquals(record.stages.stage0.background, { cols: 8 });
  assertEquals("waveRows" in record.stages.stage0, false);
  // The flat fields are the first stage's copy; lib/export-build.ts refuses
  // a record without them.
  assertEquals(record.enemylist, [EMPTY, GS_ROW]);
  assertEquals(record.noStory, true);
  assertEquals("storyData" in record, false);
});

Deno.test("a start stage cuts the stages before it and renumbers the rest with their bosses", () => {
  const record = gsLike();
  const summary = bossRushRecord(record, { startStage: 1 });
  assertEquals(summary.stages, ["stage1"]);
  assertEquals(summary.dropped, ["stage0"]);
  assertEquals(Object.keys(record.stages), ["stage0"]);
  assertEquals(record.stages.stage0.background, { cols: 10 });
  // The cut stage's enemies still make the showcase: it is the LEVEL's.
  assertEquals(record.stages.stage0.enemylist, [EMPTY, EMPTY, GS_ROW]);
  assertEquals(Object.keys(record.bossData), ["boss0"]);
  assertEquals(record.bossData.boss0.name, "Daltonius");
  // The morph rides along untouched — the boss is the same boss.
  assertEquals(record.bossData.boss0.stage2.hpBelow, 0.5);
  // The cart's own boss row would hold the boss back on a Saturn stage.
  assertEquals(record.bossData.boss0.dezaemon, { size: 2 });
  assertEquals(record.dezaemonBgm.stages, [[3, 4]]);
  assertEquals(record.stageKey, "stage0");
  const line = describeBossRush(summary);
  assert(line.includes("from stage1 (stage0 cut)"), line);
  assert(line.includes(GS_ROW.join(" ")), line);
});

Deno.test("a start stage past the last one is refused, naming the count", () => {
  assertThrows(
    () => bossRushRecord(gsLike(), { startStage: 2 }),
    Error,
    "2 stages",
  );
});

Deno.test("a flat single-stage record is its one stage", () => {
  const record: Json = {
    width: 4,
    enemylist: [["00", "00", "00", "00"], ["A1", "00", "B0", "00"]],
    waveRows: [1],
    enemyData: { enemyA: { hp: 1 }, enemyB: { hp: 5 } },
    bossData: { boss0: { name: "x" } },
  };
  const summary = bossRushRecord(record);
  assertEquals(summary.stages, ["stage0"]);
  assertEquals(summary.waveRowsCleared, 2);
  // B (hp 5) in the middle, A beside it still carrying its power-up.
  assertEquals(record.enemylist, [["00", "00", "00", "00"], [
    "00",
    "B0",
    "A1",
    "00",
  ]]);
  assertEquals("waveRows" in record, false);
  assertThrows(() => bossRushRecord(record, { startStage: 1 }), Error);
});

Deno.test("a level with no enemies rushes straight to its bosses", () => {
  const record: Json = {
    enemylist: [],
    stages: { stage0: { enemylist: [["00", "00"]] } },
    bossData: { boss0: {} },
  };
  const summary = bossRushRecord(record);
  assertEquals(summary.showcase, []);
  assertEquals(record.stages.stage0.enemylist, []);
  assert(describeBossRush(summary).includes("no enemies to showcase"));
});

Deno.test("the oldest records' top-level stageN blocks are renumbered in place", () => {
  const record: Json = {
    stage0: { enemylist: [["A1"]] },
    stage1: { enemylist: [["B1"], ["B2"]] },
    stage2: { enemylist: [["C1"]] },
    bossData: { boss0: { n: 0 }, boss1: { n: 1 }, boss2: { n: 2 } },
  };
  const summary = bossRushRecord(record, { startStage: 1 });
  assertEquals(summary.stages, ["stage1", "stage2"]);
  assertEquals(Object.keys(record).filter((k) => /^stage\d$/.test(k)), [
    "stage0",
    "stage1",
  ]);
  // One column wide: the three types stack into three one-cell rows, the
  // power-up (1) on the first that drops it and the 3-way (2) on B.
  assertEquals(record.stage0.enemylist, [["A1"], ["B2"], ["C0"]]);
  assertEquals(record.bossData, { boss0: { n: 1 }, boss1: { n: 2 } });
});

Deno.test("the console writers' stage reader sees the rush the way it is meant", () => {
  const record = gsLike();
  bossRushRecord(record, { startStage: 1 });
  const stages = levelStages(record);
  assertEquals(stages.map((s: Json) => s.key), ["stage0"]);
  assertEquals(stages[0].enemylist, [EMPTY, EMPTY, GS_ROW]);
  assertEquals(record.bossData.boss0.name, "Daltonius");
});
