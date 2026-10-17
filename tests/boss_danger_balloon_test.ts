// A boss record's own danger balloon.
//
// The skull that pops over a boss once one bomb would finish it was always
// the stock boss_dengerous0..2.gif. `dangerBalloon` on a boss record now
// swaps it for the author's art and, optionally, places it — the cloud game
// "gs" has its stage-2 boss say "I'm Fired!!!" there. The runtime
// (game.bundle.js, a vendored artifact patched by hand — README) resolves the
// frames against the merged game_asset atlas and keeps the stock skull when
// none of them travelled, since the balloon is the one cue a bomb will finish
// the boss.

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

/** One top-level `var NAME = ...;` line of the bundle. */
function varSource(js: string, name: string): string {
  const m = js.match(new RegExp(`\\n  var ${name} = [^\\n]*;\\n`));
  assert(m, `no var ${name} in ${BUNDLE}`);
  return m[0];
}

// deno-lint-ignore no-explicit-any
type Json = any;

const STOCK = [
  "boss_dengerous0.gif",
  "boss_dengerous1.gif",
  "boss_dengerous2.gif",
];
const FIRED = ["lolBoss_fired0", "lolBoss_fired1", "lolBoss_fired2"];

/** A scene whose game_asset atlas carries exactly `frames`. */
function sceneWith(frames: string[], extra: Json = {}): Json {
  const have = new Set(frames);
  return {
    textures: { get: () => ({ has: (f: string) => have.has(f) }) },
    ...extra,
  };
}

async function dangerBalloon() {
  const js = await read(BUNDLE);
  return new Function(
    varSource(js, "DANGER_BALLOON_FRAMES") +
      functionSource(js, "resolveFrame") +
      functionSource(js, "bulletFramesInAtlas") +
      functionSource(js, "bossDangerBalloon") +
      "\nreturn bossDangerBalloon;",
  )() as (
    scene: Json,
    bossData: Json,
    stock: { x: number; y: number },
  ) => { frames: string[]; offset: { x: number; y: number } };
}

Deno.test("a boss with no balloon of its own keeps the stock skull where it was", async () => {
  const balloon = await dangerBalloon();
  const scene = sceneWith([...STOCK, ...FIRED]);
  const stock = { x: 30, y: 20 };
  for (const rec of [null, {}, { name: "barlog" }, { dangerBalloon: null }]) {
    assertEquals(balloon(scene, rec, stock), { frames: STOCK, offset: stock });
  }
});

Deno.test("dangerBalloon swaps the frames and places them", async () => {
  const balloon = await dangerBalloon();
  const scene = sceneWith([...STOCK, ...FIRED]);
  const stock = { x: 30, y: 20 };
  assertEquals(
    balloon(scene, { dangerBalloon: { frames: FIRED, x: 70, y: 30 } }, stock),
    { frames: FIRED, offset: { x: 70, y: 30 } },
  );
  // A bare array is the frames alone, at the slot's offset.
  assertEquals(balloon(scene, { dangerBalloon: FIRED }, stock), {
    frames: FIRED,
    offset: stock,
  });
  // Either coordinate alone moves only that one.
  assertEquals(
    balloon(scene, { dangerBalloon: { frames: FIRED, x: 64 } }, stock).offset,
    { x: 64, y: 20 },
  );
  // Zero is a place, not a missing value.
  assertEquals(
    balloon(scene, { dangerBalloon: { frames: FIRED, x: 0, y: 0 } }, stock)
      .offset,
    { x: 0, y: 0 },
  );
});

Deno.test("balloon art that did not travel brings back the stock skull and its offset", async () => {
  const balloon = await dangerBalloon();
  const stock = { x: 5, y: 20 };
  // None of the frames are in this level's atlas.
  assertEquals(
    balloon(
      sceneWith(STOCK),
      { dangerBalloon: { frames: FIRED, x: 70, y: 30 } },
      stock,
    ),
    { frames: STOCK, offset: stock },
  );
  // Some are: the ones that are play, the rest are dropped.
  assertEquals(
    balloon(
      sceneWith([...STOCK, FIRED[0], FIRED[2]]),
      { dangerBalloon: { frames: FIRED } },
      stock,
    ).frames,
    [FIRED[0], FIRED[2]],
  );
  // The runtime's .gif/.png forgiveness holds here as everywhere else.
  assertEquals(
    balloon(
      sceneWith(["mine0.png", "mine1.png"]),
      { dangerBalloon: ["mine0.gif", "mine1.gif"] },
      stock,
    ).frames,
    ["mine0.png", "mine1.png"],
  );
  // Not a list of frames at all.
  for (const bad of ["lolBoss_fired0", { frames: "lolBoss_fired0" }, 7]) {
    assertEquals(
      balloon(sceneWith([...STOCK, ...FIRED]), { dangerBalloon: bad }, stock),
      { frames: STOCK, offset: stock },
    );
  }
});

/**
 * checkBossDanger itself, against a scene that records the sprite it adds and
 * the timer it starts.
 */
async function checkBossDanger() {
  const js = await read(BUNDLE);
  return new Function(
    "scene",
    varSource(js, "DANGER_BALLOON_FRAMES") +
      "var GOKI_BALLOON_OFFSET = { x: 5, y: 20 };" +
      "var BOSS_BALLOON_OFFSETS = [{ x: 0, y: 20 }, { x: 30, y: 20 }];" +
      "function triggerHaptic() {}" +
      "function assetStageId(id) { return id % 5; }" +
      functionSource(js, "resolveFrame") +
      functionSource(js, "bulletFramesInAtlas") +
      functionSource(js, "bossDangerBalloon") +
      functionSource(js, "checkBossDanger") +
      "\ncheckBossDanger(scene);",
  ) as (scene: Json) => void;
}

function fightScene(atlas: string[], bossRecord: Json): Json {
  const made: Json = { sprite: null, tick: null, frames: [] as string[] };
  const sprite = (x: number, y: number, key: string, frame: string) => ({
    x,
    y,
    key,
    frame,
    active: true,
    data: {} as Record<string, unknown>,
    setOrigin() {},
    setDepth() {},
    setScale() {},
    setData(k: string, v: unknown) {
      this.data[k] = v;
    },
    setFrame(f: string) {
      made.frames.push(f);
    },
  });
  return {
    made,
    ...sceneWith(atlas),
    recipe: { playerData: { spDamage: 50 } },
    bossDangerShown: false,
    bossHp: 40,
    bossStageId: 1,
    bossIsGoki: false,
    bossRecord,
    bossSprite: { active: true, x: 128, y: 100, width: 96, height: 128 },
    add: {
      sprite(x: number, y: number, key: string, frame: string) {
        made.sprite = sprite(x, y, key, frame);
        return made.sprite;
      },
    },
    tweens: { add() {} },
    time: {
      addEvent(ev: Json) {
        made.tick = ev.callback;
      },
    },
  };
}

Deno.test("checkBossDanger pops the record's own balloon, where the record says", async () => {
  const check = await checkBossDanger();
  const scene = fightScene([...STOCK, ...FIRED], {
    name: "lolBoss",
    dangerBalloon: { frames: FIRED, x: 70, y: 30 },
  });
  check(scene);
  const b = scene.made.sprite;
  assertEquals(b.key, "game_asset");
  assertEquals(b.frame, FIRED[0]);
  // Bottom-left corner at the boss sprite's top-left + (70, 30).
  assertEquals(b.x, 128 - 48 + 70);
  assertEquals(b.y, 100 - 64 + 30);
  assertEquals(scene.bossSprite.dangerBalloon, b);
  for (let i = 0; i < 4; i++) scene.made.tick();
  assertEquals(scene.made.frames, [FIRED[1], FIRED[2], FIRED[0], FIRED[1]]);
});

Deno.test("checkBossDanger keeps the skull for a boss without one", async () => {
  const check = await checkBossDanger();
  const scene = fightScene([...STOCK], {
    name: "barlog",
    dangerBalloon: { frames: FIRED, x: 70, y: 30 },
  });
  check(scene);
  const b = scene.made.sprite;
  assertEquals(b.frame, STOCK[0]);
  // Stage 1's stock offset, (30, 20).
  assertEquals(b.x, 128 - 48 + 30);
  assertEquals(b.y, 100 - 64 + 20);
  for (let i = 0; i < 3; i++) scene.made.tick();
  assertEquals(scene.made.frames, [STOCK[1], STOCK[2], STOCK[0]]);
});

Deno.test("the fight keeps the record it was built from, for the balloon to read", async () => {
  const js = await read(BUNDLE);
  assert(
    functionSource(js, "bossAdd").includes("scene.bossRecord = bossData;"),
    "bossAdd does not keep its record",
  );
  // The hidden Akuma's takeover swaps the record with the sprite.
  assert(js.includes("scene.bossRecord = gokiData;"), "no takeover record");
  assert(
    functionSource(js, "checkBossDanger").includes(
      "bossDangerBalloon(scene, scene.bossRecord, stockOffset)",
    ),
  );
  assert(!js.includes('"boss_dengerous" + dangerFrame'), "stock names left");
});
