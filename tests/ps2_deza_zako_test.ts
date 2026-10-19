// A Dezaemon zako, on the PS2.
//
// gs's Clevin (scripts/gs/add-clevin.ts) moves by his cart record's
// appearance script and fires on the engine's fire pulse, as the browser has
// him: a zig-zag down the screen, and an aimed badge every half second or so.
// The port read neither and flew him straight down at its default speed,
// firing every 5 steps — the fire table's interval read as steps, a stream.
// The exporter patches the browser's script and gun in
// (packages/shmup-harbor/lib/ps2/runtime-patches.ts, DEZA_ZAKO_RUNTIME); this
// flies his real record through the patched port's own enemy code.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildRuntimeBundle } from "../packages/shmup-harbor/lib/ps2/build.ts";
import { CLEVIN } from "../scripts/gs/add-clevin.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const CACHE = join(ROOT, "build", "ps2", ".cache");
const decoder = new TextDecoder();

// deno-lint-ignore no-explicit-any
type Json = any;

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

interface Port {
  normalizeRecipe: (recipe: Json) => void;
  createEnemy: (ctx: Json, data: Json) => Json;
  enemyLoop: (ctx: Json, e: Json, player: Json) => number | string;
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

/** The patched port's enemies, or null when no runtime has been bundled. */
async function port(): Promise<Port | null> {
  if (!await exists(join(CACHE, "main.js"))) return null;
  const js = decoder.decode(await buildRuntimeBundle(ROOT, CACHE))
    .replaceAll("\r\n", "\n");
  return new Function(
    "GW",
    "GH",
    "GCX",
    functionSource(js, "normalizeRecipe") + moduleSource(js, "enemy.ts") +
      moduleSource(js, "boss.ts") + moduleSource(js, "projectile.ts") +
      "\nreturn { normalizeRecipe, createEnemy, enemyLoop };",
  )(256, 480, 128) as Port;
}

const SHIP = { x: 120, y: 400, width: 16, height: 16, dead: 0 };

function fakeCtx(recipe: Json) {
  const size = (_atlas: string, frame: string) =>
    frame === "clevin" ? { w: 30, h: 32 } : { w: 16, h: 16 };
  return {
    state: { turboMode: false, stageId: 1, recipe },
    sound: { playSfx: () => {} },
    atlas: {
      resolveFrameName: (_atlas: string, frame: string) => frame,
      getFrameSize: size,
    },
  };
}

/** Clevin spawned in wave column `col` of 8, flown for `steps` steps. */
function fly(p: Port, col: number, steps: number) {
  const recipe = {
    enemyData: {
      enemyH: { ...structuredClone(CLEVIN), atlas: "level_atlas" },
      enemyA: { name: "plain", texture: ["plain"], speed: 2, interval: 60 },
    },
  };
  const quiet = console.log;
  console.log = () => {};
  try {
    p.normalizeRecipe(recipe);
  } finally {
    console.log = quiet;
  }
  const ctx = fakeCtx(recipe);
  const gs = { player: SHIP, projectiles: [] as Json[], frameCnt: 0 };
  const g = globalThis as Json;
  const saved = { gs: g.__PS2_GS__, fps: g.__PS2_GAME_FPS__ };
  g.__PS2_GS__ = () => gs;
  g.__PS2_GAME_FPS__ = 120;
  const e = p.createEnemy(ctx, recipe.enemyData.enemyH);
  e.x = 32 * col + 16 - e.width / 2;
  e.y = -32;
  const spawnX = e.x;
  const track: { x: number; y: number }[] = [];
  const shots: {
    at: number;
    from: [number, number];
    rotX: number;
    rotY: number;
    speed: number;
    frames: string[];
  }[] = [];
  let ported = 0;
  try {
    for (let i = 0; i < steps && e.y < 480; i++) {
      gs.frameCnt++;
      const before = gs.projectiles.length;
      if (p.enemyLoop(ctx, e, SHIP) === "shoot") ported++;
      for (const s of gs.projectiles.slice(before)) {
        shots.push({
          at: i,
          from: [s.x, s.y],
          rotX: s.rotX,
          rotY: s.rotY,
          speed: s.speed,
          frames: s.frames,
        });
      }
      track.push({ x: e.x - spawnX, y: e.y });
    }
  } finally {
    g.__PS2_GS__ = saved.gs;
    g.__PS2_GAME_FPS__ = saved.fps;
  }
  const plain = p.createEnemy(ctx, recipe.enemyData.enemyA);
  return { e, track, shots, ported, plain };
}

/**
 * The browser's own appearance script (game.bundle.js: stepEntryScript),
 * run for `frames` Saturn frames: where it puts an enemy after each.
 */
async function browserPath(mirror: boolean, frames: number) {
  const js = (await Deno.readTextFile(
    join(ROOT, "static", "games", "2028-ai", "game.bundle.js"),
  )).replaceAll("\r\n", "\n");
  const consts = [...js.matchAll(/\n {2}var (ENTRY_\w+) = (\w+);/g)]
    .map((m) => `var ${m[1]} = ${m[2]};`).join("\n");
  const start = js.indexOf("\n  function stepEntryScript(");
  assert(start >= 0, "no stepEntryScript in game.bundle.js");
  const step = new Function(
    consts + js.slice(start, js.indexOf("\n  }\n", start) + 4) +
      "\nreturn stepEntryScript;",
  )() as (enemy: Json, st: Json) => boolean;
  const enemy = { x: 0, y: 0 };
  const st = {
    entry: {
      rows: CLEVIN.dezaemon.entry.rows,
      idx: 0,
      rowT: 0,
      angle: 0,
      turn: 0,
      amp: 0,
      flags: 0,
      rides: false,
      ridesNow: false,
      moverB: false,
      moveFlag: false,
      vx: 0,
      vy: 0,
      active: false,
      mirror,
      ground: false,
    },
  };
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < frames; k++) {
    step(enemy, st);
    out.push({ x: enemy.x, y: enemy.y });
  }
  return out;
}

/**
 * The PS2 path beside the browser's: Saturn frame k is serviced on step
 * 2k+2 and its velocity spread over that step and the next, so after step
 * 2k+3 (track index 2k+2) the ship is where the browser put it after frame k.
 */
async function assertBrowserPath(
  track: { x: number; y: number }[],
  mirror: boolean,
) {
  const frames = Math.floor((track.length - 3) / 2);
  const web = await browserPath(mirror, frames);
  for (let k = 0; k < frames; k++) {
    const ps2 = track[2 * k + 2];
    const at = `Saturn frame ${k}: PS2 (${ps2.x.toFixed(2)}, ${
      (ps2.y + 32).toFixed(2)
    }), browser (${web[k].x.toFixed(2)}, ${web[k].y.toFixed(2)})`;
    assert(Math.abs(ps2.x - web[k].x) < 1e-6, at + ` dx=${ps2.x - web[k].x}`);
    assert(
      Math.abs(ps2.y + 32 - web[k].y) < 1e-6,
      at + ` dy=${ps2.y + 32 - web[k].y}`,
    );
  }
  return web;
}

Deno.test("the patched port's Clevin flies his script, frame for frame the browser's", async () => {
  const p = await port();
  if (!p) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  // Column 1 of 8: the left half, so the script's lateral swings go right.
  const { track } = fly(p, 1, 400);
  const web = await assertBrowserPath(track, false);
  // A zig-zag, not a fall: two swings out past +80 px and back to the column.
  const xs = web.slice(0, 88).map((w) => w.x);
  assert(Math.max(...xs) > 80, `${Math.max(...xs)}`);
  assert(Math.min(...xs.slice(40)) < 5, `${Math.min(...xs.slice(40))}`);
  // Then the last row: straight down, 6 px a Saturn frame — 3 a step.
  const tail = track.slice(200, 210);
  assertEquals(new Set(tail.map((t) => t.x.toFixed(6))).size, 1);
  assert(Math.abs(tail[1].y - tail[0].y - 3) < 1e-9);
});

Deno.test("a right-half Clevin mirrors his swings, as the browser's does", async () => {
  const p = await port();
  if (!p) return;
  const { track } = fly(p, 6, 200);
  const web = await assertBrowserPath(track, true);
  assert(Math.min(...web.map((w) => w.x)) < -80);
});

Deno.test("the patched port's Clevin fires aimed badges on the pulse, not a stream", async () => {
  const p = await port();
  if (!p) return;
  const { e, shots, ported, plain } = fly(p, 1, 400);
  // The port's own gun stood down.
  assertEquals(ported, 0);
  assertEquals(e.interval, 0);
  // The browser's cadence: a volley every 4-7 pulses of 8 Saturn frames at
  // stage 2's opening rank, 64-112 steps — a handful in 400 steps, where the
  // port's stream fired ~80.
  assert(shots.length >= 2 && shots.length <= 6, `${shots.length} shots`);
  for (let i = 1; i < shots.length; i++) {
    const gap = shots[i].at - shots[i - 1].at;
    assert(gap >= 64 && gap <= 112, `shots ${i - 1}-${i} ${gap} steps apart`);
  }
  const ship = [SHIP.x + SHIP.width / 2, SHIP.y + SHIP.height / 2];
  for (const s of shots) {
    // Only from on the screen, at the ship, outside the point-blank box.
    assert(s.from[1] >= 8, `fired from above the screen (${s.from[1]})`);
    const dx = ship[0] - s.from[0];
    const dy = ship[1] - s.from[1];
    assert(!(Math.abs(dx) < 40 && Math.abs(dy) < 40), "point-blank");
    const d = Math.hypot(dx, dy);
    assert(
      Math.abs(s.rotX - dx / d) < 1e-6 && Math.abs(s.rotY - dy / d) < 1e-6,
    );
    // The badge, at the browser's zako speed: 1.35 px a Saturn frame.
    assertEquals(s.frames, ["geekBadge_0"]);
    assert(Math.abs(s.speed - 0.675) < 1e-9, `${s.speed}`);
  }
  // A plain enemy keeps the port's own mover and gun.
  assertEquals(plain.deza, undefined);
  assertEquals([plain.speed, plain.interval], [2, 60]);
});
