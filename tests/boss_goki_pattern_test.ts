// Akuma's routine for an Akuma who is not the hidden boss.
//
// An Akuma imported from the 2019 game and made a stage's boss (the cloud
// game "rando" fights him second) flew that slot's stock routine — boss1's is
// Barlog's — with his own bullets and in his idle pose throughout: his
// stances (SHOOT-A, SHOOT-B, the Ashura warp) were only built by the hidden
// boss's entrance, and his routine only ran for the hidden boss. The runtime
// (game.bundle.js, a vendored artifact patched by hand — README) now runs his
// routine for any record carrying his stances, and for `attackPattern:
// "bossExtra"`, the GOKI pattern the editor's Boss Lab writes; the lab and
// the editor say the same.

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

// deno-lint-ignore no-explicit-any
type Json = any;

async function stock(): Promise<Json> {
  return JSON.parse(await read("static/games/2028-ai/assets/game.json"))
    .bossData;
}

async function patternSlot() {
  const js = await read(BUNDLE);
  assert(js.includes('\n  var GOKI_PATTERN = "goki";\n'), "no GOKI_PATTERN");
  return new Function(
    'var GOKI_PATTERN = "goki";' + functionSource(js, "isGokiRecord") +
      functionSource(js, "bossPatternSlot") + "\nreturn bossPatternSlot;",
  )() as (bossData: unknown, stageId: number) => number | string;
}

Deno.test("Akuma's record runs his own routine in whatever slot it sits", async () => {
  const slot = await patternSlot();
  const bosses = await stock();
  // rando's shape: the stock Akuma, unpinned, as stage 1's boss.
  assertEquals(slot(bosses.bossExtra, 1), "goki");
  // Every other stock boss still runs the slot it sits in.
  for (const key of ["boss0", "boss1", "boss2", "boss3", "boss4"]) {
    assertEquals(slot(bosses[key], 1), 1, key);
  }
  assertEquals(slot(null, 2), 2);
  // He is known by his name, not his stances: the shipped game's boss2,
  // trump, is drawn on Akuma's stance set and flies his routine only
  // because he is pinned to it.
  const shipped = JSON.parse(await read("static/games/2028-ai/foo.json"));
  const trump = shipped.bossData.boss2;
  assert(trump.anim.syngoku, "boss2 no longer wears Akuma's set");
  assertEquals(trump.attackPattern, "bossExtra");
  assertEquals(slot(trump, 2), "goki");
  assertEquals(slot({ ...trump, attackPattern: undefined }, 2), 2);
});

Deno.test("attackPattern pins a routine, and bossExtra pins Akuma's", async () => {
  const slot = await patternSlot();
  const bosses = await stock();
  // The Boss Lab's GOKI pick fell through to the slot's routine before.
  assertEquals(
    slot({ ...bosses.boss3, attackPattern: "bossExtra" }, 1),
    "goki",
  );
  // An Akuma pinned elsewhere flies where he is pinned.
  assertEquals(slot({ ...bosses.bossExtra, attackPattern: "boss3" }, 1), 3);
  // An unknown pin is the slot's, as it always was.
  assertEquals(slot({ ...bosses.boss1, attackPattern: "nobody" }, 1), 1);
});

async function shootStart() {
  const js = await read(BUNDLE);
  const calls: string[] = [];
  const run = new Function(
    "calls",
    "scene",
    'var GOKI_PATTERN = "goki";' +
      functionSource(js, "isGokiRecord") +
      functionSource(js, "bossPatternSlot") +
      functionSource(js, "bossShootStart") +
      `
      function _bossAlive() { return true; }
      function startDezaBoss() { calls.push("deza"); }
      function bossPatternGoki() { calls.push("goki"); }
      function bossPatternPyramid() { calls.push("pyramid"); }
      function bossPatternBarlog() { calls.push("barlog"); }
      function bossPatternSagat() { calls.push("sagat"); }
      function bossPatternVega() { calls.push("vega"); }
      function bossPatternFang() { calls.push("fang"); }
      bossShootStart(scene);`,
  );
  return (scene: Json) => {
    calls.length = 0;
    run(calls, scene);
    return calls[0];
  };
}

Deno.test("bossShootStart flies Akuma's routine for his record and for a GOKI pin", async () => {
  const shoot = await shootStart();
  const bosses = await stock();
  const scene = (boss1: Json, bossIsGoki: boolean) => ({
    recipe: { bossData: { boss1 } },
    bossStageId: 1,
    bossIsGoki,
  });
  // bossAdd marks his own record bossIsGoki.
  assertEquals(shoot(scene(bosses.bossExtra, true)), "goki");
  // Someone else pinned to his routine reaches it through the switch.
  assertEquals(
    shoot(scene({ ...bosses.boss3, attackPattern: "bossExtra" }, false)),
    "goki",
  );
  assertEquals(shoot(scene(bosses.boss1, false)), "barlog");
});

Deno.test("bossAdd builds Akuma's stances for his routine and makes his record Akuma", async () => {
  const src = functionSource(await read(BUNDLE), "bossAdd");
  assert(
    src.includes("if (patternSlot === GOKI_PATTERN) {"),
    "no Goki stances",
  );
  for (
    const stance of [
      "gokiAnimIdle",
      "gokiAnimShootA",
      "gokiAnimShootB",
      "gokiAnimSyngoku",
      "gokiAnimSyngokuFinish",
      "gokiAnimSyngokuFinishTen",
    ]
  ) {
    assert(src.includes(`scene.${stance} = `), `${stance} is not built`);
  }
  assert(src.includes("scene.bossIsGoki = isGokiRecord(bossData);"));
  // His own entrance voice, not the slot's.
  assert(src.includes('(scene.bossIsGoki ? "goki" :'));
});

Deno.test("the Boss Lab and the editor name Akuma's own routine as the runtime runs it", async () => {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  g.window = globalThis;
  try {
    new Function(await read("static/editor/boss-lab.js"))();
    const lab = g.BossLab as {
      ownPattern: (key: string, rec: unknown) => string;
      PAT: Record<string, { label: string }>;
    };
    const bosses = await stock();
    assertEquals(lab.ownPattern("boss1", bosses.bossExtra), "bossExtra");
    assertEquals(
      lab.PAT[lab.ownPattern("boss1", bosses.bossExtra)].label,
      "GOKI",
    );
    assertEquals(lab.ownPattern("boss1", bosses.boss1), "boss1");
  } finally {
    delete g.BossLab;
    if (!had) delete g.window;
  }
  const labSrc = await read("static/editor/boss-lab.js");
  assert(labSrc.includes("return v || this.ownKey(k);"), "effKey ignores it");
  const editor = await read("static/editor/index.html");
  // The boss strip's DEFAULT label, and the mod overlay a cart export keeps.
  assert(editor.includes("BossLab.ownPattern(key, entry)"));
  assert(editor.includes("BossLab.ownPattern(k, b)"));
});
