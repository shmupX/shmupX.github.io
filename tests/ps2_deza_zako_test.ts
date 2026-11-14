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
  // stepEntryScript asks the enemy whether it is a successor (a long row runs
  // 1.5x longer for one); Clevin here is a stage's own, and the port does not
  // model successors.
  const enemy = { x: 0, y: 0, getData: (_key: string) => undefined };
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

// Master Arena Mod's stage-0 shooter (deza0_54, `enemyc`): a type-3 big shot,
// interval 3, window 2. On the hardware its shot is a zako out of the 150-slot
// enemy pool, every interval + 1 Saturn frames, spawned where it stands. This
// record names no child, so the port fires a stand-in bullet for it instead.
const BIG_SHOOTER: Json = {
  ...structuredClone(CLEVIN),
  speed: 0,
  interval: 3,
  dezaemon: {
    behavior: {
      appearance: 221,
      death: { mode: 0, param: 0, silent: false, small: false },
      fire: {
        aimed: false,
        bigShot: {
          band: 1,
          character: 147,
          frames: 4,
          index: 4,
          key: 148,
          record: 20,
        },
        direction: 0,
        directionEx: 0,
        enabled: true,
        interval: 3,
        mode: 3,
        window: 2,
      },
    },
  },
};

/**
 * A shooter standing at (x, y) in a scene that already holds `held` other
 * shots, run for `steps` steps with no shot ever leaving the field — so what
 * it has made is what the pool let it make. `records` joins the recipe's
 * enemyData (the records a big shot may name); `loopAll` runs every enemy the
 * scene holds through the port's enemyLoop each step, as the port does, and
 * removes the ones it retires, where otherwise only the shooter is run.
 */
function standAndFire(
  p: Port,
  data: Json,
  steps: number,
  held = 0,
  { records = {}, loopAll = false }: { records?: Json; loopAll?: boolean } = {},
) {
  const recipe = {
    enemyData: {
      enemyH: { ...structuredClone(data), atlas: "level_atlas" },
      ...Object.fromEntries(
        Object.entries(structuredClone(records)).map((
          [key, rec],
        ) => [key, { ...(rec as Json), atlas: "level_atlas" }]),
      ),
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
  const e = p.createEnemy(ctx, recipe.enemyData.enemyH);
  // createEnemy reads a speed of 0 as 1; stand the shooter still on screen.
  e.speed = 0;
  e.x = 100;
  e.y = 100;
  const gs = {
    player: SHIP,
    enemies: [e] as Json[],
    projectiles: Array.from({ length: held }, () => ({ held: true })) as Json[],
    frameCnt: 0,
  };
  const g = globalThis as Json;
  const saved = { gs: g.__PS2_GS__, fps: g.__PS2_GAME_FPS__ };
  g.__PS2_GS__ = () => gs;
  g.__PS2_GAME_FPS__ = 120;
  const at: number[] = [];
  // Every enemy the shooter's shots have added to the scene, in order, with
  // the step it came in on and where it stood the moment it did.
  const kids: { en: Json; at: number; centre: [number, number] }[] = [];
  const seen = new Set<Json>(gs.enemies);
  // The first of them, followed: its y after each step it is alive for.
  const firstY: number[] = [];
  try {
    for (let i = 0; i < steps; i++) {
      gs.frameCnt++;
      const before = gs.projectiles.length;
      if (loopAll) {
        for (let k = gs.enemies.length - 1; k >= 0; k--) {
          if (p.enemyLoop(ctx, gs.enemies[k], SHIP) === 0) {
            gs.enemies.splice(k, 1);
          }
          // Where a spawn stood is only meaningful before its own first step.
          for (const en of gs.enemies) {
            if (!seen.has(en)) {
              seen.add(en);
              kids.push({
                en,
                at: i,
                centre: [en.x + en.width / 2, en.y + en.height / 2],
              });
            }
          }
        }
      } else {
        p.enemyLoop(ctx, e, SHIP);
        for (const en of gs.enemies) {
          if (!seen.has(en)) {
            seen.add(en);
            kids.push({
              en,
              at: i,
              centre: [en.x + en.width / 2, en.y + en.height / 2],
            });
          }
        }
      }
      for (let k = before; k < gs.projectiles.length; k++) at.push(i);
      if (kids.length && gs.enemies.includes(kids[0].en)) {
        firstY.push(kids[0].en.y);
      }
    }
  } finally {
    g.__PS2_GS__ = saved.gs;
    g.__PS2_GAME_FPS__ = saved.fps;
  }
  return { gs, e, at, kids, firstY };
}

Deno.test("a type-3 big shooter fires every interval + 1 Saturn frames, one bullet each", async () => {
  const p = await port();
  if (!p) return;
  const { at } = standAndFire(p, BIG_SHOOTER, 120);
  // 4 Saturn frames = 8 steps at 120 a second, and the first of them after
  // the reload has counted its 3 down.
  assert(at.length >= 10, `${at.length} shots in 120 steps`);
  for (let i = 1; i < at.length; i++) {
    assertEquals(at[i] - at[i - 1], 8, `shots ${i - 1}-${i}`);
  }
});

Deno.test("the shots in flight and the enemies together never pass the hardware's 150-object pool", async () => {
  const p = await port();
  if (!p) return;
  // Master Arena's shooter left standing for a minute of play, its shots
  // never leaving the field: before the pool, 7,200 steps made ~900 bullets.
  const { gs, at } = standAndFire(p, BIG_SHOOTER, 7200);
  assertEquals(gs.enemies.length + gs.projectiles.length, 150);
  assertEquals(gs.projectiles.length, 149);
  // It filled the pool at its own cadence and then stopped, not before.
  assertEquals(at.length, 149);
  assertEquals(at.at(-1)! - at[0], 8 * 148);
});

Deno.test("a volley wider than the pool's room fires only what fits", async () => {
  const p = await port();
  if (!p) return;
  // gs's 15-way spread (geometry 15: eight bullets a volley), interval 1,
  // window 1 — the widest, fastest gun a cart has. 146 shots already in
  // flight and the shooter itself leave room for three of its eight.
  const spread = structuredClone(BIG_SHOOTER);
  spread.dezaemon.behavior.fire = {
    aimed: false,
    direction: 15,
    directionEx: 0,
    enabled: true,
    geometry: 15,
    interval: 1,
    mode: 0,
    window: 1,
  };
  const { gs } = standAndFire(p, spread, 600, 146);
  assertEquals(gs.enemies.length + gs.projectiles.length, 150);
  assertEquals(gs.projectiles.filter((s: Json) => !s.held).length, 3);
});

// The record Master Arena Mod's stage-0 shooter spawns (deza0_49, `enemyP`): a
// 1-hp zako whose script drops it 110 px, holds it 65 Saturn frames, and flies
// it back up and off the top. It is not a bullet.
const BIG_CHILD: Json = {
  ...structuredClone(CLEVIN),
  speed: 0,
  interval: -1,
  hp: 1,
  dezaemon: {
    behavior: {
      appearance: 51,
      death: { mode: 0, param: 0, silent: true, small: false },
      fire: {
        aimed: false,
        direction: 0,
        directionEx: 0,
        enabled: false,
        geometry: 0,
        interval: 119,
        mode: 0,
        window: 29,
      },
    },
    entry: {
      rows: [[55, 49152, 0, 512, 4113], [65, 49152, 0, 0, 1], [
        32767,
        16384,
        0,
        512,
        1,
      ]],
    },
  },
};

/** The shooter, now naming `enemyP` as the record its big shot spawns. */
function shooterOf(child: string | null): Json {
  const data = structuredClone(BIG_SHOOTER);
  if (child) data.dezaemon.bigShotChild = child;
  return data;
}

Deno.test("a big shot spawns the record it names, as a zako, where the shooter stands", async () => {
  const p = await port();
  if (!p) return;
  const { gs, e, at, kids } = standAndFire(p, shooterOf("enemyP"), 120, 0, {
    records: { enemyP: BIG_CHILD },
  });
  // No stand-in bullet: the shots are enemies.
  assertEquals(at.length, 0);
  assertEquals(gs.projectiles.length, 0);
  assert(kids.length >= 10, `${kids.length} shots in 120 steps`);
  // The hardware's cadence, interval + 1 Saturn frames: 8 steps.
  for (let i = 1; i < kids.length; i++) {
    assertEquals(kids[i].at - kids[i - 1].at, 8, `shots ${i - 1}-${i}`);
  }
  const shooter = [e.x + e.width / 2, e.y + e.height / 2];
  for (const { en, centre } of kids) {
    // Centred on the shooter, armed with its own script and hp.
    assertEquals(centre, shooter);
    assertEquals(en.deza.rows.length, 3);
    assertEquals(en.hp, 1);
    assertEquals(en.deza.fire, null);
  }
});

Deno.test("the spawned record flies its own script, and leaves", async () => {
  const p = await port();
  if (!p) return;
  const { gs, kids, firstY } = standAndFire(p, shooterOf("enemyP"), 900, 0, {
    records: { enemyP: BIG_CHILD },
    loopAll: true,
  });
  const first = kids[0];
  const start = first.centre[1] - first.en.height / 2;
  // Down 2 px a Saturn frame for ~55 of them, then held, then up and gone.
  const dip = Math.max(...firstY) - start;
  assert(dip > 100 && dip < 125, `dipped ${dip} px`);
  const held = firstY.slice(
    firstY.indexOf(Math.max(...firstY)),
  ).filter((y) => y === Math.max(...firstY)).length;
  assert(held >= 100, `held ${held} steps at the foot`);
  assert(!gs.enemies.includes(first.en), "the first shot never left the field");
  // Shots that leave make room: a steady few dozen live, and no bullets —
  // where the stand-in's lived the length of the field and piled up.
  assert(gs.enemies.length < 100, `${gs.enemies.length} enemies live`);
  assertEquals(gs.projectiles.length, 0);
});

Deno.test("a big shot whose record the recipe lacks falls back to a bullet", async () => {
  const p = await port();
  if (!p) return;
  const { gs, at, kids } = standAndFire(p, shooterOf("enemyNope"), 120);
  assertEquals(kids.length, 0);
  assert(at.length >= 10 && gs.projectiles.length === at.length);
});

Deno.test("spawned shots stop at 48 live, however long the shooter stands", async () => {
  const p = await port();
  if (!p) return;
  // Nothing retires them here, so what it has made is what the budget allowed:
  // each one is a hit test against every shot of the player's, every step.
  const { gs, kids } = standAndFire(p, shooterOf("enemyP"), 7200, 0, {
    records: { enemyP: BIG_CHILD },
  });
  assertEquals(kids.length, 48);
  assertEquals(gs.enemies.length, 49); // and the shooter
  assertEquals(gs.projectiles.length, 0);
  // Under it, the cadence is the hardware's: one every 8 steps.
  assertEquals(kids.at(-1)!.at - kids[0].at, 8 * 47);
});

Deno.test("a spawn is refused when the 150-object pool has no room, shot budget or not", async () => {
  const p = await port();
  if (!p) return;
  // 120 shots of other guns in flight and the shooter leave room for 29.
  const { gs, kids } = standAndFire(p, shooterOf("enemyP"), 7200, 120, {
    records: { enemyP: BIG_CHILD },
  });
  assertEquals(kids.length, 29);
  assertEquals(gs.enemies.length + gs.projectiles.length, 150);
});

Deno.test("shots that are retired free the budget for the next", async () => {
  const p = await port();
  if (!p) return;
  // Run for 3,000 steps with the port's own loop retiring them off the top:
  // the count peaks at the budget and holds, rather than stopping for good.
  const { kids, gs } = standAndFire(p, shooterOf("enemyP"), 3000, 0, {
    records: { enemyP: BIG_CHILD },
    loopAll: true,
  });
  assert(kids.length > 100, `${kids.length} spawned in 3,000 steps`);
  assert(gs.enemies.length <= 49, `${gs.enemies.length} live`);
});
