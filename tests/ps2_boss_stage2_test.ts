// A boss's second stage, on the PS2.
//
// The browser lays a boss record's `stage2` block over it once its hp falls
// below `hpBelow` of the bar, between two moves, and plays `anim.morph` once
// on the way in (tests/boss_stage2_test.ts). The PS2 port has no notion of
// it, so the exporter patches it in (packages/shmup-harbor/lib/ps2/
// runtime-patches.ts) and packs what it draws and fires (lib/ps2/assets.ts:
// stage2Frames, stage2ShotLists) — the disc otherwise carries only the frames
// a boss draws in stage 1. gs's Daltonius turns into Liu Kang's dragon this
// way, spitting deza1_52 dragon heads.
//
// The record is checked against the browser's own code; the patch against a
// stand-in port, and then, when a compiled runtime is on hand, the patched
// port's real boss is flown through the change; the packing on a staged disc.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  type LevelRecord,
  stage2Frames,
  stage2ShotLists,
  stageAssets,
  type StagedFile,
} from "../packages/shmup-harbor/lib/ps2/assets.ts";
import type { FrameEntry } from "../packages/shmup-harbor/lib/ps2/atlas.ts";
import { buildRuntimeBundle } from "../packages/shmup-harbor/lib/ps2/build.ts";
import { newRaster } from "../packages/shmup-harbor/lib/ps2/png.ts";
import {
  BOSS_STAGE2_RUNTIME,
  patchRuntime,
} from "../packages/shmup-harbor/lib/ps2/runtime-patches.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");
const CACHE = join(ROOT, "build", "ps2", ".cache");
const BUNDLE = "static/games/2028-ai/game.bundle.js";
const decoder = new TextDecoder();

// deno-lint-ignore no-explicit-any
type Json = any;

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

/** One function of `js` declared at `indent`, by name, as source text. */
function functionSource(js: string, name: string, indent = ""): string {
  const start = js.indexOf(`\n${indent}function ${name}(`);
  assert(start >= 0, `no ${name}`);
  const end = js.indexOf(`\n${indent}}\n`, start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + indent.length + 3);
}

/** One `var` of `js` declared at `indent`, by name, as source text. */
function varSource(js: string, name: string, indent = ""): string {
  const start = js.indexOf(`\n${indent}var ${name} = `);
  assert(start >= 0, `no ${name}`);
  return js.slice(start, js.indexOf(";\n", start) + 2);
}

const dedent = (text: string) => text.replaceAll("\n  ", "\n");

/** The patch's helpers on their own, as a module of functions. */
function stage2Fns() {
  return new Function(
    BOSS_STAGE2_RUNTIME +
      "\nreturn { bossStage2Record, bossStage2Due, bossStage2Arm, " +
      "bossStage2Weapons };",
  )() as {
    bossStage2Record: (bossData: Json) => Json;
    bossStage2Due: (b: Json) => boolean;
    bossStage2Arm: (b: Json, data: Json) => Json;
    bossStage2Weapons: (b: Json, record: Json) => void;
  };
}

// gs's Daltonius as its record has him, stances and weapons and all.
const daltonius = () => ({
  name: "Daltonius",
  hp: 3500,
  score: 8000,
  spgage: 30,
  attackPattern: "bossExtra",
  anim: {
    idle: ["Daltonius_idle0", "Daltonius_idle1"],
    shootA: ["Daltonius_shootA0", "Daltonius_shootA1", "Daltonius_shootA2"],
    syngokuFinish: ["Daltonius_syungoku_finish"],
  },
  bulletDataA: { damage: 1, hp: 5, speed: 2.3, texture: ["RAM_0"] },
  bulletDataB: {
    damage: 1,
    hp: 20,
    speed: 1.5,
    texture: ["laptop0", "laptop1"],
  },
  stage2: {
    anim: {
      idle: ["liuKangDragon9"],
      morph: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `liuKangDragon${n}`),
      shootA: ["liuKangDragon10", "liuKangDragon11", "liuKangDragon12"],
    },
    bulletDataA: {
      damage: 1,
      hp: 5,
      speed: 2.3,
      texture: ["deza1_52_0.gif", "deza1_52_1.gif"],
    },
    bulletDataB: {
      damage: 1,
      hp: 20,
      speed: 1.5,
      texture: ["deza1_52_0.gif", "deza1_52_1.gif"],
    },
    hpBelow: 0.5,
  },
});

const DRAGON = ["deza1_52_0.gif", "deza1_52_1.gif"];

/** A queued shot that is a dragon head. */
const isDragon = (shot: Json) => shot.frames.join() === DRAGON.join();

// --- the record ---

Deno.test("the console lays stage 2 over a boss exactly as the browser does", async () => {
  const web = (await Deno.readTextFile(join(ROOT, BUNDLE)))
    .replaceAll("\r\n", "\n");
  const ps2 = "\n" + BOSS_STAGE2_RUNTIME;
  for (const name of ["BOSS_STAGE2_HP_BELOW", "BOSS_WEAPON_SUFFIXES"]) {
    assertEquals(varSource(ps2, name), dedent(varSource(web, name, "  ")));
  }
  assertEquals(
    functionSource(ps2, "bossStage2Record"),
    dedent(functionSource(web, "bossStage2Record", "  ")),
    "bossStage2Record has drifted from the browser's",
  );
});

Deno.test("stage 2 is the boss's record with its stage2 block laid over it", () => {
  const { bossStage2Record } = stage2Fns();
  const boss = daltonius();
  const s2 = bossStage2Record(boss);
  assertEquals(s2.anim.idle, ["liuKangDragon9"]);
  assertEquals(s2.anim.morph[0], "liuKangDragon0");
  assertEquals(s2.anim.syngokuFinish, ["Daltonius_syungoku_finish"]);
  assertEquals(s2.bulletDataA.texture, DRAGON);
  assertEquals(s2.hp, 3500);
  assertEquals(s2.hpBelow, 0.5);
  assertStrictEquals(s2.stage2, undefined);
  assertEquals(boss.anim.idle, ["Daltonius_idle0", "Daltonius_idle1"]);
  assertStrictEquals(bossStage2Record({ ...boss, stage2: undefined }), null);
  assertStrictEquals(bossStage2Record({ ...boss, stage2: "dragon" }), null);
  const at = (hpBelow: unknown) =>
    bossStage2Record({ ...boss, stage2: { ...boss.stage2, hpBelow } }).hpBelow;
  assertEquals(at(0.25), 0.25);
  for (const bad of [0, 1, 2, "half", null]) assertEquals(at(bad), 0.5);
});

Deno.test("stage 2 is due below the line, once", () => {
  const { bossStage2Arm, bossStage2Due } = stage2Fns();
  const b = bossStage2Arm(
    { frames: ["Daltonius_idle0"], hp: 3500, maxHp: 3500 },
    daltonius(),
  );
  assertEquals(bossStage2Due(b), false);
  b.hp = 1750;
  assertEquals(bossStage2Due(b), false, "half is still stage 1");
  b.hp = 1749;
  assertEquals(bossStage2Due(b), true);
  b.stage2Done = 1;
  assertEquals(bossStage2Due(b), false);
  const plain = bossStage2Arm({ frames: [], hp: 1, maxHp: 3500 }, {
    ...daltonius(),
    stage2: undefined,
  });
  assertStrictEquals(plain.stage2, null);
  assertEquals(bossStage2Due(plain), false);
});

/** A boss record as the port's normalizeRecipe leaves it. */
function normalized(boss: Json): Json {
  const out = structuredClone(boss);
  out.atlas = "level_atlas";
  out.texture = out.anim?.idle ?? [];
  out.projectileData = out.bulletData?.texture
    ? { ...out.bulletData, name: "bullet" }
    : { texture: [], speed: 2, damage: 1, hp: 1, name: "bullet" };
  return out;
}

Deno.test("the dragon arms the slots its block names, and what the disc packs is what it fires", () => {
  const { bossStage2Arm, bossStage2Weapons } = stage2Fns();
  const fired = (boss: Json) => {
    const b = bossStage2Arm({ frames: ["Daltonius_idle0"] }, normalized(boss));
    bossStage2Weapons(b, b.stage2);
    return [b.projectileData, b.projectileDataA]
      .filter((shot) => shot && shot.texture.length)
      .map((shot) => shot.texture);
  };
  const base = daltonius();
  const anim = base.stage2.anim;
  const cases: [string, Json, string[][]][] = [
    // Every routine's one weapon is slot A's when the record has none of its
    // own — not normalizeRecipe's empty stand-in, which drew red squares.
    ["gs", base, [DRAGON, DRAGON]],
    // A slot the block does not name stays the boss's.
    [
      "a block naming only the one weapon",
      { ...base, stage2: { anim, bulletData: { texture: DRAGON } } },
      [DRAGON, ["RAM_0"]],
    ],
    // Either spelling is the one slot: the boss's bulletDataA, read first,
    // does not outlive a block's projectileDataA.
    [
      "a block's projectileDataA over the boss's bulletDataA",
      {
        ...base,
        stage2: { anim, projectileDataA: { texture: ["fang_bullet"] } },
      },
      [["fang_bullet"], ["fang_bullet"]],
    ],
    [
      "a block with no weapons",
      { ...base, stage2: { anim } },
      [["RAM_0"], ["RAM_0"]],
    ],
  ];
  for (const [what, boss, want] of cases) {
    assertEquals(fired(boss), want, what);
    assertEquals(stage2ShotLists(boss), want, `${what}: the disc's packing`);
  }
  // A shot is in the shape normalizeRecipe gives a boss's bulletData: a
  // homing name never comes along with it.
  const b = bossStage2Arm({ frames: [] }, normalized(base));
  bossStage2Weapons(b, {
    ...b.stage2,
    bulletDataA: { texture: DRAGON, name: "meka" },
  });
  assertEquals(b.projectileDataA, {
    texture: DRAGON,
    speed: 2,
    damage: 1,
    hp: 1,
    name: "bullet",
  });
});

Deno.test("the frames stage 2 draws: the morph, then its stance", () => {
  const morph = daltonius().stage2.anim.morph;
  assertEquals(stage2Frames(daltonius()), [...morph, "liuKangDragon9"]);
  // A block's own texture is what the port draws, over its anim.idle.
  assertEquals(
    stage2Frames({
      ...daltonius(),
      stage2: { anim: { morph: ["m"], idle: ["i"] }, texture: ["t"] },
    }),
    ["m", "t"],
  );
  assertEquals(stage2Frames({ ...daltonius(), stage2: undefined }), []);
});

// --- the patch ---

/** Enough of the port for every anchor, shaped as the bundler writes it. */
const STAND_IN = [
  "function playerOnDamage(ctx2, p, amount) {",
  "  p.hp -= amount;",
  "}",
  "function createBoss(ctx2, data, stageId) {",
  "  const b = { frames: data.texture || [] };",
  "  return b;",
  "}",
  "function bossLoop(ctx2, b) {",
  "  const bMul = ctx2.state.turboMode ? 2 : 1;",
  "  b.moveTimer += bMul;",
  "  if (b.shootFlg) {",
  "    if (b.attackCooldown <= 0) {",
  "      bossAttack(ctx2, b);",
  "    }",
  "  }",
  "}",
  "function bossDraw(ctx2, b) {",
  "  if (!b.visible) return;",
  "}",
  "",
].join("\n");

Deno.test("the patch wraps createBoss and bossDraw and hooks bossLoop between moves", () => {
  const patched = patchRuntime(STAND_IN);
  assert(BOSS_STAGE2_RUNTIME.indexOf("$") < 0, "a `$` in a replacement");
  assert(patched.includes(BOSS_STAGE2_RUNTIME));
  assert(patched.includes(
    "function createBoss(ctx2, data, stageId) {\n" +
      "  return bossStage2Arm(createBossBody(ctx2, data, stageId), data);\n" +
      "}\nfunction createBossBody(ctx2, data, stageId) {\n" +
      "  const b = { frames: data.texture || [] };",
  ));
  assert(patched.includes(
    "  if (bossStage2Step(ctx2, b)) return;\n" +
      "  const bMul = ctx2.state.turboMode ? 2 : 1;\n" +
      "  b.moveTimer += bMul;",
  ));
  assert(patched.includes(
    "      (bossStage2Due(b) ? bossStage2Start : bossAttack)(ctx2, b);",
  ));
  assert(patched.includes(
    "function bossDraw(ctx2, b) {\n  bossDrawBody(ctx2, b);\n" +
      "  bossStage2Ghost(ctx2, b);\n}\nfunction bossDrawBody(ctx2, b) {",
  ));
  // The god-mode guard still goes on beside them.
  assert(patched.includes("  if (ctx2.state.godMode) return;\n"));

  // Each anchor the pin moves out from under fails the build by name.
  for (
    const [cut, name] of [
      ["function createBoss(ctx2, data, stageId)", "boss stage 2: armed"],
      ["      bossAttack(ctx2, b);", "boss stage 2: between moves"],
      ["  b.moveTimer += bMul;", "boss stage 2: the morph"],
      ["function bossDraw(ctx2, b)", "boss stage 2: the ghost"],
    ]
  ) {
    assertThrows(
      () => patchRuntime(STAND_IN.replace(cut, "")),
      Error,
      `patch "${name}"`,
    );
  }
  // So does a port that grew a name the patch declares.
  assertThrows(
    () => patchRuntime(STAND_IN + "function bossStage2Due(b) {\n}\n"),
    Error,
    "already declares bossStage2Due",
  );
});

// --- the real port's boss, patched ---

interface Port {
  normalizeRecipe: (recipe: Json) => void;
  createBoss: (ctx: Json, data: Json, stageId: number) => Json;
  bossEntry: (ctx: Json, b: Json) => void;
  bossLoop: (ctx: Json, b: Json) => void;
  bossOnDamage: (ctx: Json, b: Json, damage: number) => void;
  bossDraw: (ctx: Json, b: Json) => void;
}

/**
 * The compiled port's boss module, patched as a disc ships it, with the
 * port's normalizeRecipe — or null when no runtime has been bundled yet.
 */
async function portBoss(): Promise<Port | null> {
  if (!await exists(join(CACHE, "main.js"))) return null;
  const js = decoder.decode(await buildRuntimeBundle(ROOT, CACHE))
    .replaceAll("\r\n", "\n");
  const from = js.search(/\/\/ deno:[^\n]*\/ps2-sp\/boss\.ts\n/);
  assert(from >= 0, "no boss.ts in the bundle");
  const to = js.indexOf("\n// deno:", from + 1);
  return new Function(
    "GW",
    "GH",
    "GCX",
    functionSource(js, "normalizeRecipe") + js.slice(from, to) +
      "\nreturn { normalizeRecipe, createBoss, bossEntry, bossLoop, " +
      "bossOnDamage, bossDraw };",
  )(256, 480, 128) as Port;
}

const SIZES: Record<string, [number, number]> = {
  Daltonius_idle0: [96, 128],
  Daltonius_idle1: [96, 128],
  ...Object.fromEntries(
    Array.from({ length: 13 }, (_, n) => [`liuKangDragon${n}`, [129, 169]]),
  ),
};

interface Drawn {
  atlas: string;
  frame: string;
  x: number;
  y: number;
  alpha: number;
}

/** A stand-in for the port's ctx: the level atlas, and what was played. */
function fakeCtx() {
  const drawn: Drawn[] = [];
  const sfx: string[] = [];
  const size = (atlas: string, frame: string) =>
    atlas === "level_atlas" && SIZES[frame]
      ? { w: SIZES[frame][0], h: SIZES[frame][1] }
      : { w: 0, h: 0 };
  const ctx = {
    state: { turboMode: false },
    sound: { playSfx: (key: string) => sfx.push(key) },
    vp: { toX: (x: number) => x, toY: (y: number) => y, scale: 1 },
    rt: { Color: { new: () => ({}) } },
    atlas: {
      hasFrame: (atlas: string, frame: string) => size(atlas, frame).w > 0,
      resolveFrameName: (_atlas: string, frame: string) => frame,
      getFrameSize: size,
      drawFrame: (
        atlas: string,
        frame: string,
        x: number,
        y: number,
        _sx: number,
        sy: number,
        alpha: number,
      ) => {
        // The shadow is the flipped draw.
        if (sy > 0) drawn.push({ atlas, frame, x, y, alpha });
      },
    },
  };
  return { ctx, drawn, sfx };
}

/** Daltonius, made by the patched port and flown in. */
function flyIn(port: Port, boss: Json = daltonius()) {
  const recipe = {
    bossData: { boss1: { ...structuredClone(boss), atlas: "level_atlas" } },
  };
  const quiet = console.log;
  console.log = () => {};
  try {
    port.normalizeRecipe(recipe);
  } finally {
    console.log = quiet;
  }
  const rig = fakeCtx();
  const b = port.createBoss(rig.ctx, recipe.bossData.boss1, 1);
  b.x = 128 - b.width / 2;
  b.moveTargetX = b.x;
  port.bossEntry(rig.ctx, b);
  while (!b.entryDone) port.bossLoop(rig.ctx, b);
  // One step as the game scene runs it: the boss, its queued shots, a draw.
  const shots: Json[][] = [];
  const step = () => {
    rig.drawn.length = 0;
    port.bossLoop(rig.ctx, b);
    shots.push(b.pendingProjectiles.splice(0));
    port.bossDraw(rig.ctx, b);
  };
  return { ...rig, b, step, shots };
}

Deno.test("the patched port's Daltonius turns into the dragon below half, between moves", async () => {
  const port = await portBoss();
  if (!port) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const { b, step, shots, drawn, sfx, ctx } = flyIn(port);

  // Just above the line he is himself, however long he fights.
  port.bossOnDamage(ctx, b, 1749);
  for (let i = 0; i < 200; i++) step();
  assertEquals(b.stage2Done, 0);
  assertEquals(b.frames, ["Daltonius_idle0", "Daltonius_idle1"]);
  assert(shots.flat().length > 0, "stage 1 never fired");
  assert(!shots.flat().some(isDragon));

  // Below it, the change waits for the move in flight: it comes on the step
  // the attack would have, and no earlier.
  port.bossOnDamage(ctx, b, 2);
  while (b.attackCooldown > 1) {
    step();
    assertEquals(b.stage2Done, 0, "changed in the middle of a move");
  }
  const top = b.y;
  const fired = shots.flat().length;
  step();
  assertEquals(b.stage2Done, 1);
  assertEquals(shots.flat().length, fired, "it attacked as it changed");
  assert(sfx.includes("se_sp"));

  // Its first frame hangs from the top edge stage 1 had, about the centre
  // stage 1's last pose had, and is hit where it is drawn.
  const last = b.stage2Ghost;
  assert(last.frame.startsWith("Daltonius_idle"), last.frame);
  assertEquals(b.frames, ["liuKangDragon0"]);
  assertEquals(b.y, top);
  assertEquals(last.y - 128 / 2, top);
  assert(Math.abs(b.x + b.width / 2 - last.x) < 1e-9, "moved sideways");
  assertEquals([b.width, b.height, b.hitW, b.hitH], [129, 169, 129, 169]);

  // The morph: each frame three steps, the boss holding still and holding
  // fire, still hittable, and stage 1's pose fading out over it.
  const seen: string[] = [b.frames[0]];
  const ghost: number[] = [];
  const ghostOf = () =>
    drawn.find((d) => d.frame.startsWith("Daltonius_"))?.alpha;
  ghost.push(ghostOf()!);
  const x = b.x;
  for (let i = 0; i < 29; i++) {
    step();
    seen.push(b.frames[0]);
    const alpha = ghostOf();
    if (alpha !== undefined) {
      ghost.push(alpha);
      // Over the body, not under it.
      assert(
        drawn.findIndex((d) => d.frame.startsWith("liuKang")) <
          drawn.findIndex((d) => d.frame.startsWith("Daltonius_")),
      );
    }
  }
  assertEquals(
    seen,
    daltonius().stage2.anim.morph.flatMap((frame) => [frame, frame, frame]),
  );
  assertEquals(b.x, x, "moved while it changed");
  assertEquals(shots.flat().length, fired, "fired while it changed");
  assertEquals(ghost.length, 11, `the ghost lasted ${ghost.length} steps`);
  assertEquals(ghost[0], 1);
  for (let i = 1; i < ghost.length; i++) assert(ghost[i] < ghost[i - 1]);
  const hp = b.hp;
  port.bossOnDamage(ctx, b, 10);
  assertEquals(b.hp, hp - 10);

  // Then it stands in its stance, and after a breath spits dragon heads:
  // every shot is one, the spread out of slot A included.
  step();
  assertEquals(b.frames, ["liuKangDragon9"]);
  assertStrictEquals(b.stage2Morph, null);
  for (let i = 0; i < 14; i++) step();
  assertEquals(shots.flat().length, fired, "fired before the breath was out");
  step();
  assert(shots.flat().length > fired, "the dragon never fired");
  for (let i = 0; i < 200; i++) step();
  const own = shots.flat().slice(fired);
  assert(own.every(isDragon));
  assert(own.some((shot) => shot.rotX !== 0), "no spread out of slot A");
  assertEquals(b.frames, ["liuKangDragon9"]);
  assertEquals(b.stage2Done, 1);
});

Deno.test("a boss killed mid-morph stays dead, and one without a block never changes", async () => {
  const port = await portBoss();
  if (!port) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const dying = flyIn(port);
  port.bossOnDamage(dying.ctx, dying.b, 1751);
  while (!dying.b.stage2Done) dying.step();
  port.bossOnDamage(dying.ctx, dying.b, 99_999);
  for (let i = 0; i < 100; i++) dying.step();
  assertEquals(dying.b.deadFlg, 1);
  assertEquals(dying.b.shootFlg, 0);
  assertEquals(dying.shots.flat().filter(isDragon), []);

  const plain = flyIn(port, { ...daltonius(), stage2: undefined });
  port.bossOnDamage(plain.ctx, plain.b, 3000);
  for (let i = 0; i < 200; i++) plain.step();
  assertStrictEquals(plain.b.stage2, null);
  assertEquals(plain.b.frames, ["Daltonius_idle0", "Daltonius_idle1"]);
  assert(plain.shots.flat().length > 0);

  // A block's own attackPattern swaps the routine for one the port has; the
  // boss's own does nothing here, in either stage.
  const boss = daltonius();
  const vega = flyIn(port, {
    ...boss,
    stage2: { ...boss.stage2, attackPattern: "boss3" },
  });
  port.bossOnDamage(vega.ctx, vega.b, 1751);
  assertEquals(vega.b.stageId, 1);
  while (!vega.b.stage2Done) vega.step();
  assertEquals(vega.b.stageId, 3);
  const extra = flyIn(port);
  port.bossOnDamage(extra.ctx, extra.b, 1751);
  while (!extra.b.stage2Done) extra.step();
  assertEquals(extra.b.stageId, 1);
});

// --- the disc ---

function sheet(files: StagedFile[], name: string): Json {
  const file = files.find((entry) => entry.path === `assets/${name}.json`);
  assert(file, `the export did not stage ${name}`);
  return JSON.parse(decoder.decode(file.data));
}

Deno.test("the disc packs every frame stage 2 draws and every shot it fires", async () => {
  // Daltonius's own art, laid out on a sheet of the level's as gs's is —
  // the dragon heads under the one-dot-leader key the editor saves.
  const names = [
    "Daltonius_idle0",
    "Daltonius_idle1",
    "Daltonius_shootA0",
    ...Array.from({ length: 13 }, (_, n) => `liuKangDragon${n}`),
  ];
  const frames: Record<string, FrameEntry> = {};
  names.forEach((name, i) => {
    frames[name] = {
      frame: { x: (i % 8) * 130, y: Math.floor(i / 8) * 170, w: 129, h: 169 },
    } as FrameEntry;
  });
  frames["deza1_52_0․gif"] = {
    frame: { x: 0, y: 340, w: 32, h: 64 },
  } as FrameEntry;
  frames["deza1_52_1․gif"] = {
    frame: { x: 34, y: 340, w: 32, h: 64 },
  } as FrameEntry;
  const raster = newRaster(1040, 404);
  raster.data.fill(255);
  const record: LevelRecord = {
    stageKey: "stage1",
    enemylist: [["00"]],
    bossData: { boss1: daltonius() },
  };
  const { files } = await stageAssets({
    gameDir: GAME_DIR,
    record,
    customAtlas: { sheet: raster, frames },
  });

  const level = new Set(Object.keys(sheet(files, "level_atlas").frames));
  for (const frame of stage2Frames(daltonius())) {
    assert(level.has(frame), `${frame} is not on the level atlas`);
  }
  assert(level.has("Daltonius_idle0"), "stage 1 lost its own frames");
  // What neither stage ever draws stays off, as it always has.
  for (const frame of ["liuKangDragon10", "Daltonius_shootA0"]) {
    assertEquals(level.has(frame), false, `${frame} was packed`);
  }
  // The port files every boss shot under game_asset, the dragon's too.
  const asset = new Set(Object.keys(sheet(files, "game_asset").frames));
  for (const frame of DRAGON) {
    assert(asset.has(frame), `${frame} is not on game_asset`);
  }
});

Deno.test("gs's own disc carries the dragon", async () => {
  const cached = join(CACHE, "levels", "gs.json");
  if (!await exists(cached)) {
    console.log("  (skipped: no cached gs record — `deno task build:ps2 gs`)");
    return;
  }
  const { record } = JSON.parse(await Deno.readTextFile(cached));
  const boss = record.bossData.boss1;
  assert(boss.stage2, "gs's boss1 has no stage2 block any more");
  const { files } = await stageAssets({ gameDir: GAME_DIR, record });
  const atlas = sheet(files, "level_atlas");
  const level = new Set(Object.keys(atlas.frames));
  for (const frame of stage2Frames(boss)) {
    assert(level.has(frame), `${frame} is not on the level atlas`);
  }
  assertEquals(atlas.meta.ps2DisplayScale, 1, "the dragon cost resolution");
  const asset = new Set(Object.keys(sheet(files, "game_asset").frames));
  for (const frame of stage2ShotLists(boss).flat()) {
    assert(asset.has(frame), `${frame} is not on game_asset`);
  }
});
