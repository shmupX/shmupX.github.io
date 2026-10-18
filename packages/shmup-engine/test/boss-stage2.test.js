// A boss's second stage on the five console formats.
//
// The web runtime turns a boss with a `stage2` block into its second form
// once its hp falls below `hpBelow` of the bar (tests/boss_stage2_test.ts
// pins the bundle). No console format changes a boss's form on its hp, so
// each writer approximates it (src/boss-stage2.js, FORMAT-*.md "A boss's
// second stage") and says how in its report's `transform`:
//
//   Kids!     native: the boss's two records ARE its two phases
//   Saturn    the boss's own hp stages switch its patterns and bullets
//   SFC, Dezaemon+, 64DD
//             two chained bosses either side of an inserted stage
//
// Each case reads the built bytes back through the format's own parser.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  BOSS_STAGE2_HP_BELOW,
  bossProjectiles,
  bossStage2Record,
  bossWeapons,
  splitBossStage2,
} from "../src/boss-stage2.js";
import { exportLevelToSfcSram, parseSfcSav } from "../src/sfc/index.js";
import {
  buildSaveFromGame,
  saturnStage2Bands,
} from "../src/write/game-to-save.js";
import { decodeSave } from "../src/decode/index.js";
import { buildPayload } from "../src/bup-write.js";
import { exportLevelToKidsCard } from "../src/psx/kids-write.js";
import { exportLevelToPlusCard } from "../src/psx/plus-write.js";
import { decodePlusEnemyData } from "../src/psx/plus.js";
import { KIDS_BLANK } from "../src/psx/kids.js";
import { parsePsxSav } from "../src/psx/index.js";
import { buildN64ProjectFromLevel } from "../src/n64/project-write.js";
import { parseStageBl } from "../src/n64/records.js";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0; // a transparent corner, so no frame is a solid block
  return { w, h, rgba };
}

/** gs's Daltonius in miniature: two weapons, then the dragon spitting heads. */
function daltonius() {
  return {
    name: "Daltonius",
    hp: 3500,
    score: 8000,
    interval: 200,
    attackPattern: "bossExtra",
    anim: {
      idle: ["dal0.png", "dal1.png"],
      shootA: ["dal0.png"],
    },
    bulletDataA: { speed: 2.3, texture: ["ram0.png"] },
    bulletDataB: { speed: 1.5, texture: ["laptop0.png", "laptop1.png"] },
    stage2: {
      anim: {
        morph: ["drag0.png", "drag9.png"],
        idle: ["drag9.png"],
        shootA: ["drag9.png"],
      },
      bulletDataA: { speed: 2.3, texture: ["head0.png", "head1.png"] },
      bulletDataB: { speed: 1.5, texture: ["head0.png", "head1.png"] },
      hpBelow: 0.5,
    },
  };
}

function level(boss = daltonius()) {
  return {
    name: "dragon",
    width: 8,
    enemylist: [["00", "A0", "00", "00", "00", "00", "A0", "00"]],
    enemyData: {
      enemyA: {
        name: "dot",
        hp: 1,
        score: 100,
        speed: 1,
        interval: -1,
        texture: ["dot0.png"],
      },
    },
    bossData: { boss0: boss },
    playerData: { texture: ["ship0.png"] },
  };
}

function art() {
  return {
    "dot0.png": frame(14, 14, [255, 255, 0]),
    "dal0.png": frame(96, 128, [0, 255, 0]),
    "dal1.png": frame(96, 128, [0, 200, 0]),
    "drag0.png": frame(120, 120, [255, 0, 0]),
    "drag9.png": frame(120, 120, [255, 0, 0]),
    "ram0.png": frame(16, 9, [0, 0, 255]),
    "laptop0.png": frame(37, 29, [128, 128, 128]),
    "laptop1.png": frame(37, 29, [100, 100, 100]),
    "head0.png": frame(16, 32, [255, 128, 0]),
    "head1.png": frame(16, 32, [255, 100, 0]),
    "ship0.png": frame(24, 24, [255, 255, 255]),
  };
}

const noStage2 = () => {
  const b = daltonius();
  delete b.stage2;
  return level(b);
};

// --- the record ------------------------------------------------------------------

Deno.test("stage 2 is the boss's record with its block laid over it, as the runtime lays it", () => {
  const boss = daltonius();
  const s2 = bossStage2Record(boss);
  assertEquals(s2.anim.idle, ["drag9.png"]);
  assertEquals(s2.anim.morph, ["drag0.png", "drag9.png"]);
  assertEquals(s2.bulletDataA.texture, ["head0.png", "head1.png"]);
  assertEquals(s2.attackPattern, "bossExtra");
  assertStrictEquals(s2.hp, 3500, "the same bar");
  assertStrictEquals(s2.hpBelow, 0.5);
  assertStrictEquals(s2.stage2, undefined);
  assertEquals(boss.anim.idle, ["dal0.png", "dal1.png"], "left as it was");
  // a weapon slot is one weapon under either spelling
  const spelt = bossStage2Record({
    ...boss,
    bulletDataA: undefined,
    projectileDataA: { texture: ["ram0.png"] },
  });
  assertStrictEquals(spelt.projectileDataA, undefined);
  // nonsense moves the line back to half
  for (const bad of [0, 1, 2, -0.5, "half", null]) {
    const r = bossStage2Record({
      ...boss,
      stage2: { ...boss.stage2, hpBelow: bad },
    });
    assertStrictEquals(r.hpBelow, BOSS_STAGE2_HP_BELOW);
  }
  assertStrictEquals(bossStage2Record({ ...boss, stage2: "dragon" }), null);
  assertStrictEquals(bossStage2Record(null), null);
});

Deno.test("split in two, the forms share the bar: the first takes the top, the second the rest", () => {
  const half = splitBossStage2(daltonius());
  assertStrictEquals(half.first.hp + half.second.hp, 3500);
  assertEquals([half.first.hp, half.second.hp], [1750, 1750]);
  assertStrictEquals(half.first.stage2, undefined);
  assertEquals(half.first.anim.idle, ["dal0.png", "dal1.png"]);
  assertEquals(half.second.anim.idle, ["drag9.png"]);
  assertStrictEquals(half.second.hpBelow, undefined);
  const quarter = daltonius();
  quarter.stage2.hpBelow = 0.25;
  const q = splitBossStage2(quarter);
  assertEquals([q.first.hp, q.second.hp], [2625, 875]);
  assertStrictEquals(q.hpBelow, 0.25);
  const forever = splitBossStage2({ ...daltonius(), hp: "infinity" });
  assertEquals([forever.first.hp, forever.second.hp], ["infinity", "infinity"]);
  assertStrictEquals(splitBossStage2(noStage2().bossData.boss0), null);
});

Deno.test("a boss's projectiles over both stages, in the order the fight shows them", () => {
  assertEquals(
    bossProjectiles(daltonius()).map((p) => [p.form, p.slot, p.textures]),
    [
      [1, "A", ["ram0.png"]],
      [1, "B", ["laptop0.png", "laptop1.png"]],
      [2, "A", ["head0.png", "head1.png"]],
    ],
  );
  assertEquals(bossWeapons({ bulletData: { texture: "x" } }).length, 1);
});

// --- Super Famicom ---------------------------------------------------------------

Deno.test("SFC: the second form is the boss of a stage put in after the first's", () => {
  const out = exportLevelToSfcSram(level(), art());
  const r = out.report;
  assertEquals(r.stages.map((s) => s.key), ["stage0", "stage0:stage2"]);
  assertEquals(r.stages.map((s) => s.boss.form), [1, 2]);
  assertEquals(r.stages.map((s) => s.boss.hits), [1750, 1750]);
  assert(r.transform.startsWith("approximated: two chained bosses"));
  assert(r.transform.includes("drag9.png"));
  assertEquals(r.splits[0].hp, [1750, 1750]);
  const save = parseSfcSav(out.sram);
  assertEquals(save.errors, []);
  // both stages have a boss block and a painted sheet, each in its own colour
  for (const s of [0, 1]) {
    assertStrictEquals(save.enemies[s].boss.blank, false, `stage ${s}`);
    assert(save.groups.boss[s].chips.filter((c) => !c.empty).length >= 8);
  }
  assert(save.palettes.rows[12].colors[0].g > 150, "Daltonius's green");
  assert(save.palettes.rows[13].colors[0].r > 200, "the dragon's red");
  // the inserted stage has no waves: the boss byte is its one spawn
  assertStrictEquals(save.appear[1].spawns, 1);
  assertStrictEquals(r.stages[1].placements, 0);
});

Deno.test("SFC: a level without a second stage, or with no stage to spare, is one boss", () => {
  const plain = exportLevelToSfcSram(noStage2(), art());
  assertStrictEquals(plain.report.transform, "none");
  assertStrictEquals(plain.report.stages.length, 1);
  const full = level();
  full.stages = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`stage${i}`, {
      enemylist: full.enemylist,
    }]),
  );
  const out = exportLevelToSfcSram(full, art());
  assertStrictEquals(out.report.stages.length, 6);
  assertStrictEquals(out.report.transform, "none");
  assert(out.warnings.some((w) => /second stage.*stages are full/.test(w)));
  assertStrictEquals(out.report.stages[0].boss.hits, 3500, "the whole bar");
});

// --- Saturn ----------------------------------------------------------------------

Deno.test("Saturn: hpBelow is the cart's equal hp bands", () => {
  assertEquals(saturnStage2Bands(0.5), { hpStages: 2, bands: 1 });
  assertEquals(saturnStage2Bands(0.25), { hpStages: 4, bands: 1 });
  assertEquals(saturnStage2Bands(0.3), { hpStages: 3, bands: 1 });
  assertEquals(saturnStage2Bands(0.7), { hpStages: 3, bands: 2 });
  assertEquals(saturnStage2Bands(0.75), { hpStages: 4, bands: 3 });
});

// The weapons each pattern of a decoded trailer fires (FORMAT.md "Bosses").
function firedWeapons(behavior) {
  return behavior.patterns.map((p) =>
    p.firePoints.filter((fp) => fp.shot && fp.shot.fn !== 0).map((fp) =>
      fp.shot.weapon
    )
  );
}

Deno.test("Saturn: the boss's own hp stages carry the change, the bottom band firing the block's bullets", () => {
  const { sections, report } = buildSaveFromGame(level(), art());
  const boss = report.stages[0].boss;
  // RAM stick, laptop, then the heads: one bullet type each
  assertStrictEquals(report.bulletTypes, 3);
  assertEquals(boss.weapons, [0, 1, null]);
  assertEquals(boss.stage2, {
    hpStages: 2,
    bands: 1,
    hpBelow: 0.5,
    weapons: [2, 2, null],
  });
  assert(report.transform.startsWith("approximated: the boss's own hp stages"));
  assert(report.transform.includes("head0.png"));
  const decoded = decodeSave(buildPayload(sections));
  const b = decoded.bosses[0].behavior;
  assertStrictEquals(b.hpStages, 2);
  // the top band loops patterns 0 and 1, the bottom 2 and 3
  assertEquals(b.playlist.slice(0, 2), [[0, 0, 1, 1], [2, 2, 3, 3]]);
  assertEquals(firedWeapons(b), [[0], [1], [2, 2], [2]]);
  // one bar: the hp is the whole boss's, not half of it
  const plain = buildSaveFromGame(noStage2(), art());
  assertStrictEquals(plain.report.transform, "none");
  assertStrictEquals(
    decodeSave(buildPayload(plain.sections)).bosses[0].behavior.hp,
    b.hp,
  );
});

Deno.test("Saturn: with every bullet type taken, the bottom band fires the top's and says so", () => {
  const lv = level();
  lv.enemyData.enemyA.interval = 60;
  lv.enemyData.enemyA.projectileData = { texture: ["dot0.png"], speed: 2 };
  const { report, warnings } = buildSaveFromGame(lv, art());
  assertEquals(report.stages[0].boss.stage2.weapons, [null, null, null]);
  assert(report.transform.includes("no bullet type was left"));
  // the heads are named once, not once per slot that carries them
  assertStrictEquals(
    warnings.filter((w) => w.includes("head0.png")).length,
    1,
  );
});

// --- Dezaemon Kids! --------------------------------------------------------------

Deno.test("Kids!: the boss's two records are its two stages, each with its own art, bar and bullets", () => {
  const out = exportLevelToKidsCard(level(), art());
  assertStrictEquals(out.report.transform, "native");
  const boss = out.report.stages[0].boss;
  assertStrictEquals(boss.hpClass, 3, "1750 hits a phase: the top class");
  assertStrictEquals(boss.stage2.hpClass, 3, "an even split: the line at half");
  // phase 1 shoots the RAM stick and the laptop, phase 2 the heads, from
  // the quads their art landed in
  const quad = (name) => out.report.bullets.indexOf(name);
  assertEquals(boss.bullets, [
    quad("ram0.png"),
    quad("laptop0.png"),
    quad("ram0.png"),
  ]);
  assertEquals(boss.stage2.bullets, [1, 1, 1].map(() => quad("head0.png")));
  assert(quad("head0.png") >= 0);
  const save = parsePsxSav(out.card).saves[0];
  assertEquals(save.errors, []);
  const [p1, p2] = save.records[0].bosses;
  assertEquals(p1.weapons.map((w) => w.bullet), boss.bullets);
  assertEquals(p2.weapons.map((w) => w.bullet), boss.stage2.bullets);
  assertStrictEquals(p1.hpClass, 3);
  assertStrictEquals(p2.hpClass, 3);
  // the sprite tables: +0x500 Daltonius, +0x580 the dragon
  const [s1, s2] = save.sprites.stages[0].bosses.map((b) => b.words);
  assert(s1.filter((w) => !(w & KIDS_BLANK)).length >= 16);
  assert(s2.filter((w) => !(w & KIDS_BLANK)).length >= 16);
  assert(s2.some((w, i) => w !== s1[i]), "phase 2 draws the dragon");
  // a boss with no block keeps the writer's two equal records
  const plain = exportLevelToKidsCard(noStage2(), art());
  assertStrictEquals(plain.report.transform, "none");
  const recs = parsePsxSav(plain.card).saves[0].records[0].bosses;
  assertEquals([...recs[1].bytes], [...recs[0].bytes]);
});

// --- Dezaemon+ -------------------------------------------------------------------

Deno.test("Dezaemon+: the second form is the boss of a stage put in after the first's", () => {
  const out = exportLevelToPlusCard(level(), art());
  const r = out.report;
  assertEquals(r.stages.map((s) => s.key), ["stage0", "stage0:stage2"]);
  assertEquals(r.stages.map((s) => s.boss.form), [1, 2]);
  assertEquals(r.stages.map((s) => s.boss.hits), [1750, 1750]);
  assert(r.transform.startsWith("approximated: two chained bosses"));
  const save = parsePsxSav(out.card).saves[0];
  assertEquals(save.errors, []);
  assert(save.checksums.ok);
  assertStrictEquals(save.globals.stageCount, 2);
  for (const s of [0, 1]) {
    const boss = decodePlusEnemyData(save.stages[s]).boss;
    assertStrictEquals(
      boss[6] & 0x40,
      s ? 0 : 0x40,
      "Daltonius tall, the dragon square",
    );
  }
  const plain = exportLevelToPlusCard(noStage2(), art());
  assertStrictEquals(plain.report.transform, "none");
  assertStrictEquals(plain.report.stages.length, 1);
});

// --- 64DD ------------------------------------------------------------------------

Deno.test("64DD: the second form is the stage-clear entry of a stage put in after the first's, firing", () => {
  const p = buildN64ProjectFromLevel(level(), art());
  const r = p.report;
  assertEquals(r.stages.map((s) => s.key), ["stage0", "stage0:stage2"]);
  assertEquals(r.stages.map((s) => s.boss), ["boss0", "boss0:stage2"]);
  assertEquals(r.stages.map((s) => s.form), [1, 2]);
  assertStrictEquals(
    r.finalStage,
    1,
    "the project now ends on the dragon's stage",
  );
  assert(r.transform.startsWith("approximated: two chained bosses"));
  for (const ext of ["0BL", "1BL"]) {
    const bl = parseStageBl(p.files.find((f) => f.ext === ext).data);
    const s = r.stages[ext === "0BL" ? 0 : 1];
    const boss = bl.enemies[s.records.bossEntry];
    assert(boss.hit.stageClear && boss.hit.lockOn, ext);
    assertStrictEquals(boss.hp, 15, `${ext}: 1750 hits cap at 16`);
    // the boss fires its weapon A, the bulletData it is armed with
    assert(
      boss.shots.some((sh) => sh.timing > 0 || sh.aimAtPlayer),
      `${ext} fires`,
    );
  }
  assert(r.stages[1].textures.some((t) => t.key.includes("drag9.png")));
  const plain = buildN64ProjectFromLevel(noStage2(), art());
  assertStrictEquals(plain.report.transform, "none");
  assertStrictEquals(plain.report.stages.length, 1);
});
