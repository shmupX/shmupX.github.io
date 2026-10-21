// A dying enemy's successor is drawn from a pool of its own.
//
// A Dezaemon record whose death word spawns a child (mode 2: rando's
// motorcycle throws its rider, record 35) gets that child from the engine's
// separate pool, which the runtime stands in for with one cap,
// DEZA_MAX_LIVE_ZAKO. spawnDeathChild counted everything in the air against
// it — the zako, a boss's parts (spawnDezaPart, up to the same cap), the
// successors themselves — so once rando's first boss had its parts out, a
// shot bike died without throwing its rider. It counts the successors alone
// now, tagged as they spawn. game.bundle.js is a vendored artifact, patched
// by hand (README).

import { assert, assertEquals } from "@std/assert";

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

Deno.test("spawnDeathChild caps the successors in the air, not everything", async () => {
  const js = await read(BUNDLE);
  const spawn = functionSource(js, "spawnDeathChild");
  assert(
    !spawn.includes("if (scene.enemies.length >= DEZA_MAX_LIVE_ZAKO) return;"),
    "the successor is still capped by everything in the air",
  );
  assert(
    spawn.includes(
      'if (live && live.active && live.getData("dezaSuccessor")) successors++;',
    ),
  );
  assert(spawn.includes("if (successors >= DEZA_MAX_LIVE_ZAKO) return;"));
  // Tagged as it spawns, so the next count sees it.
  assert(
    spawn.indexOf(
      "var child = createEnemy(scene, data, enemy.x, enemy.y, null);",
    ) <
      spawn.indexOf('child.setData("dezaSuccessor", true);'),
  );
  // The parts and the waves keep the shared cap they had.
  assertEquals(
    js.split("scene.enemies.length < DEZA_MAX_LIVE_ZAKO").length - 1,
    1,
    "the part spawner's cap",
  );
  assertEquals(
    js.split("scene.enemies.length >= DEZA_MAX_LIVE_ZAKO").length - 1,
    1,
    "the wave spawner's cap",
  );
});

Deno.test("the successor count is live: a counted child's death frees its slot", () => {
  // The count walks scene.enemies, which enemyDie splices the dead out of,
  // so nothing is kept to go stale. Modelled here on the same loop.
  const enemies = [
    { active: true, tag: true },
    { active: true, tag: false },
    { active: false, tag: true },
  ];
  let successors = 0;
  for (const e of enemies) if (e && e.active && e.tag) successors++;
  assertEquals(successors, 1);
});
