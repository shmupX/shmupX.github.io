// Drawing the game at the display's own refresh rate.
//
// The game and title scenes step their logic at a fixed 120 Hz and Phaser
// draws once per display frame, so on a 240 Hz monitor the stock game drew
// every step twice and motion read as 120 Hz. The runtime (game.bundle.js, a
// vendored artifact patched by hand — README-Technical.md) now draws
// step-driven motion where it would be at each frame's moment, and puts the
// logic's own positions back before anything reads them. These run the game
// scene's real update() and the refresh helpers out of the bundle against a
// scene of plain objects; scripts/refresh-compare.ts does it in the real game
// on an emulated 240 Hz display, and records the two side by side.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

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

/** One method of a class in the bundle, by name, as source text. */
function methodSource(js: string, name: string, after: string): string {
  const from = js.indexOf(after);
  assert(from >= 0, `no ${after} in ${BUNDLE}`);
  const start = js.indexOf(`\n    ${name}(`, from);
  assert(start >= 0, `no ${name}() after ${after}`);
  const end = js.indexOf("\n    }\n", start);
  assert(end > start, `${name}() does not close`);
  return js.slice(start, end + 6);
}

// deno-lint-ignore no-explicit-any
type Json = any;

const STEP = 8.333333;
const HELPERS = [
  "refreshModeFromLocation",
  "refreshInterpolator",
  "refreshFrame",
  "refreshRestore",
  "refreshCapture",
  "refreshSettle",
  "refreshBlend",
  "refreshApply",
];
const VARS = ["REFRESH_TELEPORT_PX", "REFRESH_ON_BELOW", "REFRESH_OFF_ABOVE"];

/** The refresh helpers and PhaserGameScene.update, for a page at `search`. */
async function runtime(search: string) {
  const js = await read(BUNDLE);
  const src = VARS.map((n) => varSource(js, n)).join("") +
    HELPERS.map((n) => functionSource(js, n)).join("") +
    "\nfunction updateSpLens() {}" +
    "\nvar update = function " +
    methodSource(js, "update", "// Fixed-timestep game loop").trim() + ";" +
    `\nreturn { update: update, ${
      HELPERS.map((n) => `${n}: ${n}`).join(", ")
    } };`;
  return new Function("window", src)({ location: { search } }) as Json;
}

interface Body {
  x: number;
  y: number;
  visible: boolean;
  /** What one fixed step does to it. */
  move?: (o: Body, step: number) => void;
  tilePositionX?: number;
  tilePositionY?: number;
}

/**
 * A scene the way update() sees one: a display list, events, and a
 * fixedUpdate that moves every body by its own rule and counts the steps.
 */
function scene(bodies: Body[], onStep?: (s: Json, step: number) => void) {
  const handlers: Record<string, (() => void)[]> = {};
  const s: Json = {
    steps: 0,
    children: { list: bodies },
    events: {
      on(name: string, fn: () => void) {
        (handlers[name] ??= []).push(fn);
      },
      emit(name: string) {
        for (const fn of handlers[name] ?? []) fn();
      },
    },
    fixedUpdate() {
      s.steps++;
      for (const o of s.children.list as Body[]) o.move?.(o, s.steps);
      onStep?.(s, s.steps);
    },
  };
  return s;
}

/** Where the logic has each body right now: what the draw moved, put back. */
function logicNow(s: Json): [number, number][] {
  const back = new Map<Body, [number, number]>();
  const d = s._refresh?.drawn ?? [];
  for (let i = 0; i < d.length; i += 6) {
    if (!d[i + 1]) back.set(d[i], [d[i + 2], d[i + 3]]);
  }
  return (s.children.list as Body[]).map((o) => back.get(o) ?? [o.x, o.y]);
}

/** The bodies this frame's draw moved off their logic. */
function blended(s: Json): Body[] {
  const d = s._refresh?.drawn ?? [];
  const out: Body[] = [];
  for (let i = 0; i < d.length; i += 6) out.push(d[i]);
  return out;
}

const snap = (bodies: Body[]) =>
  bodies.map((
    o,
  ) => [o.x, o.y, o.tilePositionX ?? null, o.tilePositionY ?? null]);

/**
 * One display frame as Phaser runs it: 'preupdate', then 'update' (where the
 * clock's timers and the tweens act), then the scene's update(); the return
 * is what is drawn. `logic` is where everything stood once 'preupdate' had
 * put the logic back, which is what every timer, tween and step reads.
 */
function frame(
  rt: Json,
  s: Json,
  delta: number,
  onUpdate?: () => void,
) {
  s.events.emit("preupdate");
  const logic = snap(s.children.list);
  s.events.emit("update");
  onUpdate?.();
  rt.update.call(s, 0, delta);
  return { logic, drawn: snap(s.children.list) };
}

const mover = (vx: number, vy = 0): Body => ({
  x: 100,
  y: 100,
  visible: true,
  move: (o) => {
    o.x += vx;
    o.y += vy;
  },
});

Deno.test("at 240 Hz the stock game draws each step twice; max refresh draws motion on every frame, evenly", async () => {
  const at240 = 1000 / 240;
  const drawnX = async (search: string) => {
    const rt = await runtime(search);
    const ship = mover(1);
    const s = scene([ship]);
    const xs: number[] = [];
    for (let i = 0; i < 96; i++) xs.push(frame(rt, s, at240).drawn[0][0]!);
    return { xs, steps: s.steps };
  };
  const stock = await drawnX("?refresh=stock");
  const max = await drawnX("?refresh=max");
  // The same 48 steps either way.
  assertEquals(stock.steps, max.steps);
  assertEquals(stock.steps, 48);
  const moves = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
  // Stock: a whole step's travel, then nothing.
  const sm = moves(stock.xs);
  assertEquals(sm.filter((d) => d === 1).length, 48);
  assertEquals(sm.filter((d) => d === 0).length, 47);
  // Max refresh: half a step's travel on every frame, once a step has run.
  for (const d of moves(max.xs.slice(2))) assertAlmostEquals(d, 0.5, 1e-3);
  // Drawn one step behind the logic, never ahead of it.
  assert(max.xs.every((x, i) => x <= stock.xs[i] && x >= stock.xs[i] - 1));
});

Deno.test("max refresh never changes the logic: every frame starts where the stock game's does, bit for bit", async () => {
  // A mix of display rates, a dropped frame and a stall.
  const deltas = [1000 / 240, 1000 / 144, 1000 / 60, 3.1, 40, 1000 / 165];
  const world = () => {
    const bodies: Body[] = [
      mover(0.7, -1.3),
      mover(-2.25, 0.4),
      // Warps every 30 steps.
      {
        x: 10,
        y: 10,
        visible: true,
        move: (o, n) => {
          o.x = n % 30 === 0 ? 10 : o.x + 3;
        },
      },
      // The scrolling background: tile offsets, not x/y.
      {
        x: 0,
        y: 0,
        visible: true,
        tilePositionX: 0,
        tilePositionY: 0,
        move: (o) => {
          o.tilePositionY! -= 0.7;
        },
      },
      // Hidden: not drawn, so not blended, but still stepped.
      { ...mover(5, 5), visible: false },
    ];
    return bodies;
  };
  const run = async (search: string) => {
    const rt = await runtime(search);
    const bodies = world();
    // A tween-like nudge on 'update' and a body the steps spawn.
    const s = scene(bodies, (sc, n) => {
      if (n % 17 === 0) sc.children.list.push(mover(-1, 2));
    });
    const logic: unknown[] = [];
    for (let i = 0; i < 600; i++) {
      const f = frame(rt, s, deltas[i % deltas.length], () => {
        bodies[1].y += 0.25;
      });
      logic.push(f.logic);
    }
    return logic;
  };
  assertEquals(await run("?refresh=max"), await run("?refresh=stock"));
  assertEquals(await run(""), await run("?refresh=stock"));
});

Deno.test("only the step's own travel is blended: a warp, a newcomer and a hidden body are drawn where they are", async () => {
  const rt = await runtime("?refresh=max");
  const ship = mover(1);
  const warp: Body = {
    x: 0,
    y: 0,
    visible: true,
    move: (o, n) => {
      o.x = n === 5 ? 200 : o.x + 1;
    },
  };
  const hidden: Body = { ...mover(1), visible: false };
  let newcomer: Body | null = null;
  const s = scene([ship, warp, hidden], (sc, n) => {
    if (n === 5) sc.children.list.push(newcomer = mover(1));
  });
  let sawWarp = false;
  for (let i = 0; i < 40; i++) {
    const before = s.steps;
    frame(rt, s, 1000 / 240);
    const drawn = blended(s);
    if (s.steps === before) continue;
    // A body the step moved its usual way is blended...
    assert(drawn.includes(ship), `step ${s.steps}: ship not blended`);
    // ...one never drawn is not...
    assert(!drawn.includes(hidden));
    if (s.steps === 5) {
      sawWarp = true;
      // ...nor a warp, drawn where it landed rather than slid across...
      assert(!drawn.includes(warp));
      assertEquals(warp.x, 200);
      assertEquals(logicNow(s)[1], [200, 0]);
      // ...nor a body the step spawned, drawn where it was born.
      assert(newcomer && !drawn.includes(newcomer));
    } else if (s.steps === 6) {
      // From the next step on, both move the usual way again.
      assert(drawn.includes(warp) && drawn.includes(newcomer!));
    }
  }
  assert(sawWarp);
});

Deno.test("a body something else moved since the draw keeps the new position", async () => {
  const rt = await runtime("?refresh=max");
  const ship = mover(1);
  const s = scene([ship]);
  for (let i = 0; i < 9; i++) frame(rt, s, 1000 / 240);
  assert(blended(s).includes(ship), "not drawn off its logic");
  // A pointer drag between frames puts it somewhere.
  ship.x = 42;
  const { logic } = frame(rt, s, 1000 / 240);
  assertEquals(logic[0][0], 42);
});

Deno.test("the background's tile scroll is drawn at every frame too", async () => {
  const rt = await runtime("?refresh=max");
  const bg: Body = {
    x: 0,
    y: 0,
    visible: true,
    tilePositionX: 0,
    tilePositionY: 0,
    move: (o) => {
      o.tilePositionY! -= 0.7;
    },
  };
  const s = scene([bg]);
  const ys: number[] = [];
  for (let i = 0; i < 40; i++) ys.push(frame(rt, s, 1000 / 240).drawn[0][3]!);
  // Once a step has run: half a step's scroll on every frame.
  for (let i = 3; i < ys.length; i++) {
    assertAlmostEquals(ys[i] - ys[i - 1], -0.35, 1e-3);
  }
  // x and y of the sprite itself were never touched.
  assertEquals([bg.x, bg.y], [0, 0]);
});

Deno.test("refresh=auto blends once the display outruns the 120 Hz logic, with hysteresis", async () => {
  const rt = await runtime("");
  const ri = () => rt.refreshInterpolator(scene([]), STEP);
  const settle = (r: Json, delta: number, n = 120) => {
    for (let i = 0; i < n; i++) rt.refreshFrame(r, delta);
    return r.on;
  };
  // 60 and 120 Hz: every frame gets whole steps already.
  assertEquals(settle(ri(), 1000 / 60), false);
  assertEquals(settle(ri(), 1000 / 120), false);
  // 144, 165, 240, 360 Hz: steps land on only some frames.
  for (const hz of [144, 165, 240, 360]) {
    assertEquals(settle(ri(), 1000 / hz), true, `${hz} Hz`);
  }
  // Between the thresholds, it stays as it was: a 120 Hz display running a
  // touch fast does not flicker it on and off.
  const between = STEP * 0.95;
  const on = ri();
  settle(on, 1000 / 240);
  assertEquals(settle(on, between), true);
  assertEquals(settle(ri(), between), false);
  // And a display that slows to 60 turns it back off.
  assertEquals(settle(on, 1000 / 60), false);
});

Deno.test("?refresh= picks the mode; anything else is auto", async () => {
  for (
    const [search, mode] of [
      ["", "auto"],
      ["?refresh=auto", "auto"],
      ["?refresh=max", "max"],
      ["?refresh=stock", "stock"],
      ["?refresh=MAX", "auto"],
      ["?level=gs&refresh=max", "max"],
    ]
  ) {
    const rt = await runtime(search);
    const r = rt.refreshInterpolator(scene([]), STEP);
    assertEquals(r.mode, mode, search);
    // max is on from the first frame and at any rate; stock never is.
    for (let i = 0; i < 60; i++) rt.refreshFrame(r, 1000 / 60);
    assertEquals(r.on, mode === "max", search);
    for (let i = 0; i < 60; i++) rt.refreshFrame(r, 1000 / 240);
    assertEquals(r.on, mode !== "stock", search);
  }
});

Deno.test("a scene restart starts the refresh state over", async () => {
  const rt = await runtime("");
  const s = scene([mover(1)]);
  for (let i = 0; i < 60; i++) frame(rt, s, 1000 / 240);
  assertEquals(s._refresh.on, true);
  assert(s._refresh.drawn.length > 0);
  s.events.emit("shutdown");
  assertEquals(s._refresh.on, false);
  assertEquals(s._refresh.avg, 0);
  assertEquals(s._refresh.drawn, []);
  // The same state object, so its 'preupdate' listener is not added twice.
  assertEquals(rt.refreshInterpolator(s, STEP), s._refresh);
});

Deno.test("both stepped scenes capture before their last step and draw after it", async () => {
  const js = await read(BUNDLE);
  for (
    const after of [
      'super({ key: "PhaserTitleScene" });',
      "// Fixed-timestep game loop",
    ]
  ) {
    const src = methodSource(js, "update", after);
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      assert(i >= 0, `${after}: no ${needle}`);
      return i;
    };
    assert(at("refreshInterpolator(this, STEP)") < at("refreshFrame("));
    assert(
      at("if (this._accumulator < STEP) refreshCapture(refresh, this);") <
        at("if (steps) refreshSettle(refresh, this);"),
    );
    assert(
      at("if (steps) refreshSettle(refresh, this);") <
        at("refreshApply(refresh, this, this._accumulator);"),
    );
  }
  // The logic goes back on 'preupdate', ahead of the clock and the tweens.
  assert(
    functionSource(js, "refreshInterpolator").includes(
      'scene.events.on("preupdate"',
    ),
  );
});

/**
 * The refresh helpers and PhaserTitleScene.update, for a page at `search`,
 * with the score board and the pad it also reads stubbed out.
 */
async function titleRuntime(search: string) {
  const js = await read(BUNDLE);
  const src = VARS.map((n) => varSource(js, n)).join("") +
    HELPERS.map((n) => functionSource(js, n)).join("") +
    functionSource(js, "wrapTilePositionX") +
    "\nvar none = function () { return 0; };" +
    "\nvar getDailyBestLabel = none, getWorldBestLabel = none," +
    " getDailyHighScore = none, getDisplayedHighScore = none," +
    " getHighScoreSyncText = none, getHighScoreSyncTint = none;" +
    "\nfunction pollGamepads() { return {}; }" +
    "\nvar update = function " +
    methodSource(js, "update", 'super({ key: "PhaserTitleScene" });')
      .trim() +
    ";" +
    "\nreturn { update: update, wrapTilePositionX: wrapTilePositionX };";
  return new Function("window", src)({ location: { search } }) as Json;
}

Deno.test("a tile offset folds into one width of its texture", async () => {
  const { wrapTilePositionX } = await titleRuntime("");
  const tile = { frame: { width: 845 }, tilePositionX: -0.5 };
  wrapTilePositionX(tile);
  assertEquals(tile.tilePositionX, 844.5);
  tile.tilePositionX = 845 * 3 + 2;
  wrapTilePositionX(tile);
  assertEquals(tile.tilePositionX, 2);
  tile.tilePositionX = 0;
  wrapTilePositionX(tile);
  assertEquals(tile.tilePositionX, 0);
  // No frame to measure, no fold.
  const bare = { tilePositionX: -900 };
  wrapTilePositionX(bare);
  assertEquals(bare.tilePositionX, -900);
});

Deno.test("the title's backdrop scrolls without end, drawn the same distance every frame through each fold", async () => {
  const W = 845;
  for (
    const [search, hz, travel] of [["?refresh=max", 240, 0.25], [
      "?refresh=stock",
      120,
      0.5,
    ]] as const
  ) {
    const rt = await titleRuntime(search);
    const bg = {
      x: 0,
      y: 0,
      visible: true,
      tilePositionX: 0,
      tilePositionY: 0,
      frame: { width: W },
    };
    const s = scene([bg]);
    Object.assign(s, {
      bg,
      // Past the START check, which reads the keyboard.
      transitioning: true,
      _stepBoardCycle() {},
      _boardOnShow: () => "allTime",
    });
    let folds = 0;
    let last: number | null = null;
    // Four times round the texture.
    const frames = Math.ceil((4 * W) / travel) + 8;
    for (let i = 0; i < frames; i++) {
      const { logic, drawn } = frame(rt, s, 1000 / hz);
      const x = drawn[0][2]!;
      // The logic never strays more than a frame's steps out of one width.
      assert(
        logic[0][2]! > -1 && logic[0][2]! < W,
        `${search}: ${logic[0][2]}`,
      );
      if (last !== null && i > 2) {
        let moved = last - x;
        if (moved < 0) {
          moved += W;
          folds++;
        }
        assertAlmostEquals(moved, travel, 1e-3, `${search} frame ${i}`);
      }
      last = x;
    }
    assert(folds >= 4, `${search}: folded ${folds} times`);
  }
});
