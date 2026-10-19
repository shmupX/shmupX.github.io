// Running into an enemy, on the PS2.
//
// On gs's stage 2 a laptop that crossed the ship hit it three times — the
// port leaves an enemy the ship touches flying, and the ship's blink after a
// hit ran out every 31 steps at the build's 120 a second — and its hits came
// with the laptop off to the ship's right, by its frame's empty corner. The
// exporter patches the port (packages/shmup-harbor/lib/ps2/runtime-patches.ts):
// contact kills the enemy as the browser's does, the blink lasts the port's
// own second, and contact takes the body's frame less a tenth each side.
// And an enemy's shadow falls below it, black, where the browser casts it.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { patchRuntime } from "../packages/shmup-harbor/lib/ps2/runtime-patches.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const BUNDLE = join(ROOT, "build", "ps2", ".cache", "main.js");

async function patched(): Promise<string | null> {
  try {
    return patchRuntime(await Deno.readTextFile(BUNDLE)).replaceAll(
      "\r\n",
      "\n",
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** One top-level function of the bundle, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\nfunction ${name}(`);
  assert(start >= 0, `no ${name}`);
  return js.slice(start, js.indexOf("\n}\n", start) + 3);
}

Deno.test("an enemy the ship runs into dies of it, and hits by its inner box", async () => {
  const js = await patched();
  if (!js) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const at = js.indexOf("} else if (hitTestAABB(e.x + e.hitX + e.hitW * 0.1");
  assert(at >= 0, "the contact box is the whole frame");
  const branch = js.slice(at, js.indexOf("\n        }\n", at));
  assert(branch.includes("e.hitW * 0.8, e.hitH * 0.8, p.x + p.hitX"));
  const lines = branch.split("\n").slice(1).map((l) => l.trim());
  assertEquals(lines, [
    "gamePlayerDamage(1);",
    "enemyDead(ctx2, e);",
    "hudOnEnemyKill(ctx2.hud, e.score, e.spgage);",
  ]);
  // Shots still hit the whole frame.
  assert(
    js.includes(
      "hitTestAABB(e.x + e.hitX, e.y + e.hitY, e.hitW, e.hitH, b.x, b.y, b.width, b.height)",
    ),
  );
});

Deno.test("an enemy's shadow falls below it, black, as the browser casts it", async () => {
  const js = await patched();
  if (!js) return;
  const draw = new Function(
    "GW",
    "GH",
    functionSource(js, "enemyDraw") + "\nreturn enemyDraw;",
  )(256, 480) as (ctx: unknown, e: unknown) => void;
  const drawn: { y: number; sy: number; tint: unknown }[] = [];
  const ctx = {
    rt: {
      Color: {
        new: (r: number, g: number, b: number, a: number) => [r, g, b, a],
      },
    },
    vp: { toX: (x: number) => x, toY: (y: number) => y, scale: 1 },
    atlas: {
      resolveFrameName: (_atlas: string, frame: string) => frame,
      drawFrame: (
        _a: string,
        _f: string,
        _x: number,
        y: number,
        _sx: number,
        sy: number,
        _alpha: number,
        tint: unknown,
      ) => drawn.push({ y, sy, tint }),
    },
  };
  // gs's laptop: 58 high, a flipped shadow 10 px up from a body's height down.
  const laptop = {
    x: 100,
    y: 50,
    width: 74,
    height: 58,
    frames: ["laptop0"],
    animFrame: 0,
    atlas: "level_atlas",
    visible: 1,
    alpha: 1,
    shadowVisible: 1,
    shadowReverse: true,
    shadowOffsetY: 10,
  };
  draw(ctx, laptop);
  assertEquals(drawn[0], { y: 50 + 29 + 58 - 10, sy: -1, tint: [0, 0, 0, 64] });
  assertEquals(drawn[1].y, 50 + 29);
  // flirtyGirl's is upright, in the same place for her height and offset.
  drawn.length = 0;
  draw(ctx, { ...laptop, height: 40, shadowReverse: false, shadowOffsetY: 30 });
  assertEquals(drawn[0], { y: 50 + 20 + 40 - 30, sy: 1, tint: [0, 0, 0, 64] });
});

Deno.test("the ship's blink lasts the port's second at the build's game speed", async () => {
  const js = await patched();
  if (!js) return;
  const loop = functionSource(js, "playerLoop");
  const at = loop.indexOf("  if (p.damageAnimFlg) {");
  assert(at >= 0, "no blink in playerLoop");
  const blink = new Function(
    "p",
    loop.slice(at, loop.indexOf("\n  }\n", at) + 4),
  ) as (p: Record<string, number>) => void;
  const g = globalThis as { __PS2_GAME_FPS__?: number };
  const saved = g.__PS2_GAME_FPS__;
  const steps = (fps: number) => {
    g.__PS2_GAME_FPS__ = fps;
    const p = { damageAnimFlg: 1, damageAnimTimer: 0, tintFlash: 0, alpha: 1 };
    const alphas: number[] = [];
    let n = 0;
    while (p.damageAnimFlg && n < 1000) {
      blink(p);
      alphas.push(p.alpha);
      n++;
    }
    return { n, alphas };
  };
  try {
    // One second either way: 31 of the port's steps, 121 of the build's.
    assertEquals(steps(30).n, 31);
    const fast = steps(120);
    assertEquals(fast.n, 121);
    // And a blink every 4 of the port's steps — 16 of the build's, the
    // first 8 of them dimmed (the timer counts before it is read).
    const dim = (from: number, to: number) =>
      fast.alphas.slice(from, to).every((a) => a === 0.5);
    const lit = (from: number, to: number) =>
      fast.alphas.slice(from, to).every((a) => a === 1);
    assert(dim(0, 7) && lit(7, 15) && dim(15, 23) && lit(23, 31));
  } finally {
    g.__PS2_GAME_FPS__ = saved;
  }
});
