// A boss's second stage.
//
// A `stage2` block on a boss record is laid over the record once the boss's
// hp falls below `hpBelow` of its bar (half by default): its stances and
// weapons replace the boss's own, key by key, and `anim.morph` plays once on
// the way in. The cloud game "gs" turns Daltonius into Liu Kang's dragon this
// way. The runtime (game.bundle.js, a vendored artifact patched by hand —
// README) makes the change between two moves, from bossShootStart.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One top-level `var` of the bundle's IIFE, by name, as source text. */
function varSource(js: string, name: string): string {
  const start = js.indexOf(`\n  var ${name} = `);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  return js.slice(start, js.indexOf(";\n", start) + 2);
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function stage2Fns() {
  const js = await read(BUNDLE);
  return new Function(
    varSource(js, "BOSS_STAGE2_HP_BELOW") +
      varSource(js, "BOSS_WEAPON_SUFFIXES") +
      functionSource(js, "bossStage2Record") +
      functionSource(js, "bossStage2Due") +
      "\nreturn { bossStage2Record, bossStage2Due };",
  )() as {
    bossStage2Record: (bossData: Json) => Json;
    bossStage2Due: (scene: Json) => boolean;
  };
}

// gs's Daltonius, cut down to what stage 2 touches.
const daltonius = {
  name: "Daltonius",
  hp: 3500,
  attackPattern: "bossExtra",
  anim: {
    idle: ["Daltonius_idle0", "Daltonius_idle1"],
    shootA: ["Daltonius_shootA0"],
    syngokuFinish: ["Daltonius_syungoku_finish"],
  },
  bulletDataA: { speed: 2.3, texture: ["RAM_0"] },
  bulletDataB: { speed: 1.5, texture: ["laptop0", "laptop1"] },
  stage2: {
    anim: {
      morph: ["liuKangDragon0", "liuKangDragon9"],
      idle: ["liuKangDragon9"],
      shootA: ["liuKangDragon10", "liuKangDragon11"],
    },
    bulletDataA: { speed: 2.3, texture: ["deza1_52_0.gif", "deza1_52_1.gif"] },
  },
};

Deno.test("stage 2 is the boss's record with its stage2 block laid over it", async () => {
  const { bossStage2Record } = await stage2Fns();
  const s2 = bossStage2Record(daltonius);
  // The stances the block names replace the boss's; the rest stay his.
  assertEquals(s2.anim.idle, ["liuKangDragon9"]);
  assertEquals(s2.anim.shootA, ["liuKangDragon10", "liuKangDragon11"]);
  assertEquals(s2.anim.morph, ["liuKangDragon0", "liuKangDragon9"]);
  assertEquals(s2.anim.syngokuFinish, ["Daltonius_syungoku_finish"]);
  // So do the weapons, slot by slot.
  assertEquals(s2.bulletDataA.texture, ["deza1_52_0.gif", "deza1_52_1.gif"]);
  assertEquals(s2.bulletDataB.texture, ["laptop0", "laptop1"]);
  // He keeps his routine, name and bar.
  assertEquals(s2.attackPattern, "bossExtra");
  assertEquals(s2.hp, 3500);
  assertEquals(s2.hpBelow, 0.5);
  assertStrictEquals(s2.stage2, undefined);
  // The record itself is left as it was.
  assertEquals(daltonius.anim.idle, ["Daltonius_idle0", "Daltonius_idle1"]);
  assert(daltonius.stage2);
});

Deno.test("a boss with no stage2 block has no second stage", async () => {
  const { bossStage2Record } = await stage2Fns();
  assertStrictEquals(
    bossStage2Record({ ...daltonius, stage2: undefined }),
    null,
  );
  assertStrictEquals(
    bossStage2Record({ ...daltonius, stage2: "dragon" }),
    null,
  );
  assertStrictEquals(bossStage2Record(null), null);
});

Deno.test("hpBelow moves the line, and nonsense falls back to half", async () => {
  const { bossStage2Record } = await stage2Fns();
  const at = (hpBelow: unknown) =>
    bossStage2Record({ ...daltonius, stage2: { ...daltonius.stage2, hpBelow } })
      .hpBelow;
  assertEquals(at(0.25), 0.25);
  assertEquals(at("0.75"), 0.75);
  for (const bad of [0, 1, 2, -0.5, "half", null]) assertEquals(at(bad), 0.5);
});

Deno.test("a stage 2 weapon replaces the slot under either spelling", async () => {
  const { bossStage2Record } = await stage2Fns();
  const s2 = bossStage2Record({
    ...daltonius,
    bulletDataA: undefined,
    projectileDataA: { texture: ["RAM_0"] },
  });
  // bossWeaponSlots reads bulletDataA first, but the boss's own
  // projectileDataA must not survive to be read where it is not.
  assertStrictEquals(s2.projectileDataA, undefined);
  assertEquals(s2.bulletDataA.texture, ["deza1_52_0.gif", "deza1_52_1.gif"]);
});

Deno.test("stage 2 is due below the line, once", async () => {
  const { bossStage2Record, bossStage2Due } = await stage2Fns();
  const scene = {
    bossStage2: bossStage2Record(daltonius),
    bossStage2Done: false,
    bossHp: 3500,
    bossMaxHp: 3500,
  };
  assertEquals(bossStage2Due(scene), false);
  scene.bossHp = 1750;
  assertEquals(bossStage2Due(scene), false, "half is still stage 1");
  scene.bossHp = 1749;
  assertEquals(bossStage2Due(scene), true);
  scene.bossStage2Done = true;
  assertEquals(bossStage2Due(scene), false);
  assertEquals(
    bossStage2Due({ bossStage2: null, bossHp: 1, bossMaxHp: 3500 }),
    false,
  );
});

Deno.test("bossShootStart makes the change between moves, before any routine", async () => {
  const js = await read(BUNDLE);
  const start = functionSource(js, "bossShootStart");
  const due = start.indexOf("bossStage2Due(scene)");
  assert(due >= 0, "bossShootStart never checks for stage 2");
  assert(
    due < start.indexOf("bossPatternGoki("),
    "stage 2 is checked after a routine",
  );
  // Once changed, the routine is the stage 2 record's.
  assert(
    start.includes(
      "scene.bossStage2Done && scene.bossStage2 ? scene.bossStage2",
    ),
  );
  // bossAdd arms it fresh for every boss; Akuma's entrance clears the boss
  // he threw out.
  const add = functionSource(js, "bossAdd");
  assert(add.includes("scene.bossStage2 = bossStage2Record(bossData);"));
  assert(add.includes("scene.bossStage2Done = false;"));
  assert(
    functionSource(js, "_startGokiSequence").includes(
      "scene.bossStage2 = null;",
    ),
  );
});
