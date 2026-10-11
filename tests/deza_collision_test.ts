// Two Dezaemon collision rules of the runtime, pinned against the vendored
// game.bundle.js the way tests/cheat_boot_test.ts pins the cheat boot.
//
// A story panel exported by build:sav is four zako wearing the format's
// NO-COLLISION attribute (record byte 2 bit 5; the decoder's move.mode bit
// 1), and the player used to die on them: the runtime read the bit nowhere.
// It is now `dezaNoCollision` on the spawned object, and every contact test
// skips it. And a cart's bomb used to leave the bullets it passed through
// standing: dezaBombDamage now clears the ones inside it.

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

/** A Phaser-ish game object: position, frame size, a data bag, active. */
function obj(fields: Record<string, unknown>, data: Record<string, unknown>) {
  const bag = { ...data };
  return {
    active: true,
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    ...fields,
    getData: (k: string) => bag[k],
    setData(k: string, v: unknown) {
      bag[k] = v;
    },
    destroy() {
      this.active = false;
    },
  };
}

type Obj = ReturnType<typeof obj>;

async function bombDamage() {
  const src = functionSource(await read(BUNDLE), "dezaBombDamage");
  return new Function(
    "scene",
    "b",
    src + "\nreturn dezaBombDamage(scene, b);",
  ) as (scene: unknown, b: unknown) => void;
}

Deno.test("a cart's bomb clears the enemy bullets inside it and leaves the rest", async () => {
  const run = await bombDamage();
  const inside = obj({ x: 110, y: 90, width: 8, height: 8 }, {});
  const edge = obj({ x: 100 + 50 + 4, y: 100, width: 8, height: 8 }, {}); // just touching
  const outside = obj({ x: 300, y: 100, width: 8, height: 8 }, {});
  const dead = obj({ x: 100, y: 100, active: false }, {});
  const impacts: number[][] = [];
  const scene = {
    enemies: [],
    enemyBullets: [inside, edge, outside, dead],
    showHitImpact: (x: number, y: number) => impacts.push([x, y]),
    enemyDie: () => {},
    bossDie: () => {},
  };
  run(scene, {
    damaging: true,
    shape: "box",
    halfW: 50,
    halfH: 50,
    x: 100,
    y: 100,
    power: 1,
    type: 1,
  });
  assertEquals(scene.enemyBullets, [outside, dead]);
  assertStrictEquals(inside.active, false);
  assertStrictEquals(edge.active, false);
  assertStrictEquals(outside.active, true);
  assertEquals(impacts, [[154, 100], [110, 90]]);
});

Deno.test("a bomb that is not yet damaging clears nothing, and a strip reaches the whole column", async () => {
  const run = await bombDamage();
  const bullet = obj({ x: 100, y: 10 }, {});
  const scene = {
    enemies: [],
    enemyBullets: [bullet],
    showHitImpact: () => {},
  };
  run(scene, {
    damaging: false,
    shape: "box",
    halfW: 50,
    halfH: 50,
    x: 100,
    y: 100,
    power: 1,
  });
  assertStrictEquals(bullet.active, true);
  // A strip (type 5's column) is tested on x alone, like the enemies.
  run(scene, {
    damaging: true,
    shape: "strip",
    halfW: 20,
    x: 100,
    y: 400,
    power: 1,
  });
  assertStrictEquals(bullet.active, false);
  assertEquals(scene.enemyBullets, []);
});

Deno.test("the bomb skips an enemy wearing the NO-COLLISION attribute, and bills the rest", async () => {
  const run = await bombDamage();
  const zako = obj({ x: 100, y: 100 }, { hp: 10 });
  const ghost = obj({ x: 100, y: 100 }, { hp: 10, dezaNoCollision: true });
  const died: unknown[] = [];
  const scene = {
    enemies: [zako, ghost],
    enemyBullets: [],
    enemyDie: (e: Obj) => died.push(e),
    bossDie: () => {},
  };
  run(scene, {
    damaging: true,
    shape: "box",
    halfW: 50,
    halfH: 50,
    x: 100,
    y: 100,
    power: 4,
    type: 1,
  });
  assertStrictEquals(zako.getData("hp"), 6);
  assertStrictEquals(ghost.getData("hp"), 10);
  run(scene, {
    damaging: true,
    shape: "box",
    halfW: 50,
    halfH: 50,
    x: 100,
    y: 100,
    power: 10,
    type: 1,
  });
  assertEquals(died, [zako]);
  assertStrictEquals(ghost.getData("hp"), 10);
});

Deno.test("the runtime reads the attribute at spawn and every contact test honours it", async () => {
  const js = await read(BUNDLE);
  // Set once, from the decoder's move.mode bit 1, where the object is built.
  const init = functionSource(js, "initEnemyBehavior");
  assert(
    init.includes(
      'enemy.setData("dezaNoCollision", !!(dezaMove(behavior).mode & 2));',
    ),
    "initEnemyBehavior does not set dezaNoCollision from move.mode bit 1",
  );
  // The enemy sweep: shots, barrier and hull all sit behind this one gate.
  assert(
    js.includes(
      'if (enemy.getData("dezaNoContact") || enemy.getData("dezaNoCollision")) {',
    ),
    "the enemy sweep's contact gate ignores dezaNoCollision",
  );
  // The SP attack, the columns, the homing shot's and the tether's target
  // picks each walk the enemies on their own.
  assert(
    js.includes(
      'if (en.getData("dezaNoContact") || en.getData("dezaNoCollision")) continue;',
    ),
    "the SP attack ignores dezaNoCollision",
  );
  assertStrictEquals(
    js.split('if (en.getData("dezaNoCollision")) continue;').length - 1,
    1,
    "the column pass does not skip dezaNoCollision exactly once",
  );
  assert(
    js.split('if (e.getData("dezaNoCollision")) continue;').length - 1 >= 3,
    "the bomb, the homing pick and the tether pick do not all skip dezaNoCollision",
  );
});
