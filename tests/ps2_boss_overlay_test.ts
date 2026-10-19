// A boss's overlay, on the PS2.
//
// The browser draws a boss record's `overlay` over the boss — gs's Geekstar
// wears his logo's G, E, E, K black over the white ones — and every few
// seconds a part's copy fades in flashing neon, lighting his mask's flame in
// its colour, and leaves as an aimed shot (tests/gs_geek_letters_test.ts).
// The PS2 port has none of it, so the exporter patches it in
// (packages/shmup-harbor/lib/ps2/runtime-patches.ts) and packs what it draws
// (lib/ps2/assets.ts: overlayFrames). The packing is checked on its own; the
// patch, when a compiled runtime is on hand, on the patched port's real boss
// and projectiles.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { overlayFrames } from "../packages/shmup-harbor/lib/ps2/assets.ts";
import { buildRuntimeBundle } from "../packages/shmup-harbor/lib/ps2/build.ts";
import { BOSS_RUNTIME } from "../packages/shmup-harbor/lib/ps2/runtime-patches.ts";
import { OVERLAY } from "../scripts/gs/geek-letters.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const CACHE = join(ROOT, "build", "ps2", ".cache");
const decoder = new TextDecoder();

// deno-lint-ignore no-explicit-any
type Json = any;

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

/** gs's Geekstar as the cloud has him, cut down to what the overlay touches. */
const geekstar = () => ({
  name: "geekstar",
  hp: 240,
  anim: {
    idle: ["geekstar0", "geekstar1"],
    attack: ["geekstar5", "geekstar4"],
  },
  bulletData: { speed: 2.5, texture: ["geek-bullet"] },
  overlay: {
    ...structuredClone(OVERLAY),
    glow: {
      x: 81,
      y: 16,
      frames: {
        geekstar0: "geekstar0-flame",
        geekstar1: "geekstar1-flame",
        geekstar5: "geekstar5-flame",
      },
    },
  },
});

Deno.test("the disc packs the parts and the glow of the frames the port draws", () => {
  assertEquals(overlayFrames(geekstar(), ["geekstar0", "geekstar1"]), [
    "geek-g",
    "geek-e",
    "geek-e",
    "geek-k",
    "geekstar0-flame",
    "geekstar1-flame",
  ]);
  assertEquals(overlayFrames({ name: "plain" }, ["x"]), []);
});

// --- the real port's boss and projectiles, patched ---

interface Port {
  normalizeRecipe: (recipe: Json) => void;
  createBoss: (ctx: Json, data: Json, stageId: number) => Json;
  bossEntry: (ctx: Json, b: Json) => void;
  bossLoop: (ctx: Json, b: Json) => void;
  bossDraw: (ctx: Json, b: Json) => void;
  createProjectile: (data: Json) => Json;
  projectileLoop: (ctx: Json, proj: Json, player: Json) => boolean;
  projectileDraw: (ctx: Json, proj: Json) => void;
}

/** One module of the bundle, by its source file's name. */
function moduleSource(js: string, file: string): string {
  const from = js.search(new RegExp(`// deno:[^\\n]*/ps2-sp/${file}\\n`));
  assert(from >= 0, `no ${file} in the bundle`);
  return js.slice(from, js.indexOf("\n// deno:", from + 1));
}

/** One top-level function of `js`, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\nfunction ${name}(`);
  assert(start >= 0, `no ${name}`);
  return js.slice(start, js.indexOf("\n}\n", start) + 3);
}

/**
 * The compiled port's boss and projectile modules, patched as a disc ships
 * them, with its normalizeRecipe — or null when no runtime has been bundled.
 */
async function port(): Promise<Port | null> {
  if (!await exists(join(CACHE, "main.js"))) return null;
  const js = decoder.decode(await buildRuntimeBundle(ROOT, CACHE))
    .replaceAll("\r\n", "\n");
  return new Function(
    "GW",
    "GH",
    "GCX",
    functionSource(js, "normalizeRecipe") + moduleSource(js, "boss.ts") +
      moduleSource(js, "projectile.ts") +
      "\nreturn { normalizeRecipe, createBoss, bossEntry, bossLoop, bossDraw, " +
      "createProjectile, projectileLoop, projectileDraw };",
  )(256, 480, 128) as Port;
}

const SIZES: Record<string, [number, number]> = {
  geekstar0: [170, 105],
  geekstar1: [170, 105],
  "geek-g": [34, 38],
  "geek-e": [30, 31],
  "geek-k": [29, 37],
  "geekstar0-flame": [17, 18],
  "geekstar1-flame": [17, 18],
  "geek-bullet": [15, 10],
};

interface Drawn {
  frame: string;
  x: number;
  y: number;
  tint: { r: number; g: number; b: number; a: number } | null;
}

function fakeCtx() {
  const drawn: Drawn[] = [];
  const size = (atlas: string, frame: string) =>
    atlas === "level_atlas" && SIZES[frame]
      ? { w: SIZES[frame][0], h: SIZES[frame][1] }
      : { w: 0, h: 0 };
  const ctx = {
    state: { turboMode: false },
    sound: { playSfx: () => {} },
    vp: { toX: (x: number) => x, toY: (y: number) => y, scale: 1 },
    rt: {
      Color: {
        new: (r: number, g: number, b: number, a = 128) => ({ r, g, b, a }),
      },
    },
    atlas: {
      hasFrame: (atlas: string, frame: string) => size(atlas, frame).w > 0,
      resolveFrameName: (_atlas: string, frame: string) => frame,
      getFrameSize: size,
      drawFrame: (
        _atlas: string,
        frame: string,
        x: number,
        y: number,
        _sx: number,
        sy: number,
        _alpha: number,
        tint: Drawn["tint"],
      ) => {
        if (sy > 0) drawn.push({ frame, x, y, tint });
      },
    },
  };
  return { ctx, drawn };
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

Deno.test("the patched port's Geekstar wears his letters black and throws them in neon", async () => {
  const p = await port();
  if (!p) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const recipe = {
    bossData: { boss0: { ...geekstar(), atlas: "level_atlas" } },
  };
  const quiet = console.log;
  console.log = () => {};
  try {
    p.normalizeRecipe(recipe);
  } finally {
    console.log = quiet;
  }
  const { ctx, drawn } = fakeCtx();
  const b = p.createBoss(ctx, recipe.bossData.boss0, 0);
  b.x = 128 - b.width / 2;
  b.moveTargetX = b.x;
  p.bossEntry(ctx, b);
  while (!b.entryDone) p.bossLoop(ctx, b);
  // Held in place: the port's boss drifts between three marks.
  const at = { x: b.x, y: b.y };
  const g = globalThis as { __PS2_GS__?: () => Json };
  g.__PS2_GS__ = () => ({ player: { x: 120, y: 400, width: 16, height: 16 } });
  const thrown: Json[] = [];
  const step = () => {
    drawn.length = 0;
    b.x = at.x;
    b.moveTargetX = at.x;
    p.bossLoop(ctx, b);
    for (const shot of b.pendingProjectiles.splice(0)) {
      if (shot.tints) thrown.push(shot);
    }
    p.bossDraw(ctx, b);
  };

  try {
    // Before anything charges: four black letters over the logo's, each at
    // its top-left in the frame plus half itself, and no glow.
    step();
    const covers = drawn.filter((d) => d.frame.startsWith("geek-"));
    assertEquals(covers.map((d) => d.frame), [
      "geek-g",
      "geek-e",
      "geek-e",
      "geek-k",
    ]);
    assertEquals(covers.map((d) => [d.x - at.x, d.y - at.y]), [
      [21 + 17, 24 + 19],
      [58 + 15, 31 + 15.5],
      [90 + 15, 31 + 15.5],
      [123 + 14.5, 25 + 18.5],
    ]);
    for (const d of covers) assertEquals(d.tint, { r: 0, g: 0, b: 0, a: 128 });
    assert(!drawn.some((d) => d.frame.endsWith("-flame")));

    // 2600 ms is 78 steps at 30 a second: then a letter starts to charge.
    while (!b.overlay.charge) step();
    assertEquals(b.overlay.shot.every, 78);
    const part = b.overlay.charge.part.frame;
    step();
    step();
    // Mid-charge: the letter over its cover in a neon at part strength, and
    // the flame of the frame he stands in, lit in the same neon.
    const lit = drawn.filter((d) => d.frame === part);
    assertEquals(lit.length, part === "geek-e" ? 3 : 2, "cover and charge");
    const charge = lit[lit.length - 1].tint!;
    assert(charge.a > 0 && charge.a < 128, `fading in: ${charge.a}`);
    const neon = OVERLAY.shot.colors.map(rgb);
    assert(
      neon.some((c) => c.join() === [charge.r, charge.g, charge.b].join()),
    );
    const flame = drawn.find((d) => d.frame.endsWith("-flame"));
    assert(flame, "the flame is not lit");
    assertEquals(flame.frame, `${b.frames[b.animFrame]}-flame`);
    assertEquals([flame.tint!.r, flame.tint!.g, flame.tint!.b], [
      charge.r,
      charge.g,
      charge.b,
    ]);
    assertEquals([flame.x - at.x, flame.y - at.y], [81 + 8.5, 16 + 9]);

    // 900 ms is 27 steps: at full strength it leaves, aimed at the ship, and
    // the flame goes back to the boss's own red.
    while (!thrown.length) step();
    const [shot] = thrown;
    assertEquals(shot.frames, [part]);
    assertEquals([shot.width, shot.height], SIZES[part]);
    const dx = 128 - shot.x, dy = 408 - shot.y;
    assertAlmostEquals(shot.rotX, dx / Math.hypot(dx, dy));
    assertAlmostEquals(shot.rotY, dy / Math.hypot(dx, dy));
    assertEquals(shot.speed, OVERLAY.shot.speed);
    step();
    assert(!drawn.some((d) => d.frame.endsWith("-flame")));
    assertEquals(
      drawn.filter((d) => d.frame.startsWith("geek-")).length,
      4,
      "the covers stay",
    );

    // In flight it keeps flashing: the scene's projectile carries the flash,
    // its clock runs as it flies, and it is drawn in its colour of the moment.
    const proj = p.createProjectile(shot);
    assertEquals(proj.tints, shot.tints);
    const before = proj.tintSteps;
    p.projectileLoop(ctx, proj, null);
    assertEquals(proj.tintSteps, before + 1);
    drawn.length = 0;
    p.projectileDraw(ctx, proj);
    const flying = drawn[0];
    assertEquals(flying.frame, part);
    assert(
      neon.some((c) =>
        c.join() === [flying.tint!.r, flying.tint!.g, flying.tint!.b].join()
      ),
    );
    assertEquals(flying.tint!.a, 128);

    // The letters follow a sequence, not chance: a second run throws the same.
    assertEquals(part, "geek-g", "the sequence's first");
  } finally {
    delete g.__PS2_GS__;
  }
});

Deno.test("the letters come as often on a disc as on the web, at the build's game speed", async () => {
  const p = await port();
  if (!p) return;
  const { ctx } = fakeCtx();
  const g = globalThis as { __PS2_GAME_FPS__?: number };
  const make = () =>
    p.createBoss(
      ctx,
      { ...geekstar(), texture: ["geekstar0"], atlas: "level_atlas" },
      0,
    ).overlay.shot;
  try {
    // A build runs the port at 120 steps a second (lib/ps2/build.ts): the
    // browser's 2600, 900 and 60 ms are 312, 108 and 7 of them.
    g.__PS2_GAME_FPS__ = 120;
    const fast = make();
    assertEquals([fast.every, fast.charge, fast.flash], [312, 108, 7]);
  } finally {
    delete g.__PS2_GAME_FPS__;
  }
  // Without the global, the port's own 30.
  const own = make();
  assertEquals([own.every, own.charge, own.flash], [78, 27, 2]);
});

Deno.test("a second stage's morph keeps the browser's pace at the build's game speed", () => {
  const { bossSteps } = new Function(
    BOSS_RUNTIME + "\nreturn { bossSteps };",
  )() as { bossSteps: (ms: number) => number };
  const g = globalThis as { __PS2_GAME_FPS__?: number };
  // The port's own 30: a 90 ms morph frame, a 360 ms fade, a 500 ms rest.
  assertEquals([90, 360, 500].map(bossSteps), [3, 11, 15]);
  try {
    g.__PS2_GAME_FPS__ = 120;
    assertEquals([90, 360, 500].map(bossSteps), [11, 43, 60]);
  } finally {
    delete g.__PS2_GAME_FPS__;
  }
});

Deno.test("a boss without an overlay, or whose atlas lacks a part, is drawn as it was", async () => {
  const p = await port();
  if (!p) return;
  const { ctx } = fakeCtx();
  const plain = p.createBoss(
    ctx,
    { name: "plain", texture: ["geekstar0"], atlas: "level_atlas" },
    0,
  );
  assertEquals(plain.overlay, null);
  const missing = geekstar();
  missing.overlay.parts[3].frame = "geek-q";
  const b = p.createBoss(
    ctx,
    { ...missing, texture: ["geekstar0"], atlas: "level_atlas" },
    0,
  );
  assertEquals(b.overlay, null);
});
