import { assert, assertEquals } from "@std/assert";
import { validateGameJson } from "../src/game-schema.js";
import { hasFixtures, loadFixtureText } from "./_fixtures.js";

// The upstream repo keeps its shipped assets/game.json as the canary; here it
// runs only when a local fixtures/game.json copy is present (gitignored, like
// the .sav fixtures).
Deno.test({
  name: "canary: the shipped assets/game.json validates",
  ignore: !hasFixtures("game.json"),
  fn() {
    const g = JSON.parse(loadFixtureText("game.json"));
    const { ok, errors } = validateGameJson(g);
    assertEquals(errors, []);
    assert(ok);
  },
});

Deno.test("rejects missing playerData and stage0", () => {
  const { ok, errors } = validateGameJson({
    enemyData: {},
    bossData: {},
    meta: { version: "1.0" },
  });
  assert(!ok);
  assert(errors.some((e) => e.includes("stage0")));
  assert(errors.some((e) => e.includes("playerData")));
});

Deno.test("rejects malformed grid cells and dangling enemy references", () => {
  const g = {
    stage0: { enemylist: [["a5", "Z1", "00", "00", "00", "00", "00", "00"]] },
    playerData: null,
    enemyData: { enemyA: { hp: 1, score: 1, texture: ["x.gif"] } },
    bossData: {},
    meta: { version: "1.0" },
  };
  const { errors } = validateGameJson(g);
  assert(errors.some((e) => e.includes('"a5"')));
  assert(errors.some((e) => e.includes("enemyZ")));
});

Deno.test("warns about stages beyond stage9 and missing per-stage bosses", () => {
  const g = {
    stage0: { enemylist: [new Array(8).fill("00")] },
    stage9: { enemylist: [new Array(8).fill("00")] },
    stage10: { enemylist: [new Array(8).fill("00")] },
    playerData: {
      maxHp: 3,
      texture: ["p.gif"],
      shootNormal: { texture: ["s.gif"] },
      shootBig: { texture: ["s.gif"] },
      shoot3way: { texture: ["s.gif"] },
      barrier: { texture: ["b.gif"] },
    },
    enemyData: { enemyA: { hp: 1, score: 1, texture: ["x.gif"] } },
    bossData: {},
    meta: { version: "1.0" },
  };
  const { ok, warnings } = validateGameJson(g);
  assert(ok, "these are warnings, not errors");
  assert(
    warnings.some((w) => w.includes("stage10") && w.includes("unreachable")),
  );
  // stage9 is inside the playable range, so it is not flagged as unreachable
  assert(
    !warnings.some((w) => w.includes("stage9") && w.includes("unreachable")),
  );
  assert(warnings.some((w) => w.includes("boss0")));
});

Deno.test("accepts multi-letter enemy keys and the wide grids that use them", () => {
  const wide = (cells) => {
    const row = new Array(14).fill("00");
    for (const [i, c] of Object.entries(cells)) row[i] = c;
    return row;
  };
  const g = {
    stage0: {
      enemylist: [wide({ 0: "A0", 13: "AB9" }), wide({ 7: "BZ1" })],
      waveRows: [12, 40],
      waveInterval: 8,
    },
    playerData: {
      maxHp: 3,
      texture: ["p.gif"],
      shootNormal: { texture: ["s.gif"] },
      shootBig: { texture: ["s.gif"] },
      shoot3way: { texture: ["s.gif"] },
      barrier: { texture: ["b.gif"] },
    },
    enemyData: {
      enemyA: { hp: 1, score: 1, texture: ["x.gif"] },
      enemyAB: { hp: 1, score: 1, texture: ["y.gif"] },
      enemyBZ: { hp: 1, score: 1, texture: ["z.gif"] },
    },
    bossData: { boss0: { hp: 10, anim: { idle: ["b0.gif"] } } },
    meta: { version: "1.0" },
  };
  const { ok, errors } = validateGameJson(g);
  assertEquals(errors, []);
  assert(ok);
});

Deno.test("rejects ragged rows, dangling multi-letter keys and mismatched waveRows", () => {
  const base = {
    playerData: {
      maxHp: 3,
      texture: ["p.gif"],
      shootNormal: { texture: ["s.gif"] },
      shootBig: { texture: ["s.gif"] },
      shoot3way: { texture: ["s.gif"] },
      barrier: { texture: ["b.gif"] },
    },
    enemyData: { enemyA: { hp: 1, score: 1, texture: ["x.gif"] } },
    bossData: { boss0: { hp: 10, anim: { idle: ["b0.gif"] } } },
    meta: { version: "1.0" },
  };
  const ragged = validateGameJson({
    ...base,
    stage0: { enemylist: [new Array(14).fill("00"), new Array(8).fill("00")] },
  });
  assert(ragged.errors.some((e) => e.includes("exactly 14 cells")));

  const dangling = validateGameJson({
    ...base,
    stage0: { enemylist: [["AB0", "00", "00", "00", "00", "00", "00", "00"]] },
  });
  assert(dangling.errors.some((e) => e.includes("enemyAB")));

  const badRows = validateGameJson({
    ...base,
    stage0: { enemylist: [new Array(8).fill("00")], waveRows: [1, 2] },
  });
  assert(badRows.errors.some((e) => e.includes("waveRows")));
});
