// The numbers `deno task refresh:compare` judges a run by.
//
// scripts/refresh-compare.ts plays the game on an emulated or a real display,
// stock and max refresh, and turns each object's per-frame positions into how
// often its motion is drawn and how evenly — by position, and on the game's
// pixel grid, which is what reaches the screen. These pin what those numbers
// say about motion whose shape is known in advance, so a pass from a real run
// means what it claims.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  cadence,
  firstDivergence,
  type FrameRecord,
  judge,
  type ObjectSample,
  stepSpan,
  type ViewCadence,
} from "../scripts/lib/refresh-metrics.ts";

/**
 * `frames` display frames at 240 Hz of bodies moving one pixel per 120 Hz
 * step: the logic moves on every second frame; max refresh draws half a
 * pixel a frame, one step behind.
 */
function at240(frames: number, bodies = 20): FrameRecord[] {
  const out: FrameRecord[] = [];
  for (let t = 0; t < frames; t++) {
    const logic = Math.floor((t + 1) / 2);
    const drawn = t / 2 - 0.5;
    const objs: ObjectSample[] = [];
    for (let b = 0; b < bodies; b++) {
      objs.push([String(b), drawn + b, 10, logic + b, 10, "enemy"]);
    }
    out.push({ frame: t, scene: "PhaserGameScene", on: true, objs });
  }
  return out;
}

Deno.test("stock at 240 Hz draws motion on half the frames, unevenly; max refresh on all of them, evenly", () => {
  const c = cadence(at240(60), 240);
  assertAlmostEquals(c.stock.moved, 0.5, 0.02);
  assertAlmostEquals(c.stock.drawnHz, 120, 5);
  assertEquals(c.stock.evenness, 0);
  assertEquals(c.max.moved, 1);
  assertEquals(c.max.drawnHz, 240);
  assertAlmostEquals(c.max.evenness, 1, 1e-9);
  assertEquals(c.stock.samples, c.max.samples);
  assertEquals(judge(c, 240), []);
});

Deno.test("only bodies the logic is moving count, and a warp is not motion", () => {
  const frames = at240(40, 1);
  for (const [t, f] of frames.entries()) {
    // One that stands still and one that warps 100 px every frame.
    f.objs.push(["still", 5, 5, 5, 5, "rock"]);
    const far = t * 100;
    f.objs.push(["warp", far, 0, far, 0, "ghost"]);
  }
  const c = cadence(frames, 240);
  // Only the one mover, over every frame that has two before it.
  assertEquals(c.max.samples, 38);
  assertEquals(c.max.moved, 1);
});

Deno.test("the check fails a max-refresh half that drops frames or judders", () => {
  const good = cadence(at240(60), 240);
  const view = (v: Partial<ViewCadence>): ViewCadence => ({
    ...good.max,
    ...v,
  });
  const fails = (max: Partial<ViewCadence>, stock?: Partial<ViewCadence>) =>
    judge({ max: view(max), stock: { ...good.stock, ...stock } }, 240);
  assertEquals(fails({}), []);
  assert(fails({ moved: 0.6, drawnHz: 144 })[0].includes("only 60.0%"));
  assert(fails({ evenness: 0.3 })[0].includes("uneven"));
  // The stock half is the control: smooth too means the display was not
  // outrunning the logic, and the comparison proves nothing.
  assert(fails({}, { moved: 1 })[0].includes("proves nothing"));
  // ...which at 120 Hz it would not be.
  assertEquals(
    judge({ max: view({}), stock: { ...good.stock, moved: 1 } }, 120),
    [],
  );
  assert(fails({ samples: 3 })[0].includes("nothing to judge"));
});

Deno.test("the stock run must match the logic frame for frame; what is drawn may differ", () => {
  const max = at240(30);
  const stock = at240(30).map((f) => ({
    ...f,
    on: false,
    // Stock draws the logic positions.
    objs: f.objs.map((o): ObjectSample => [o[0], o[3], o[4], o[3], o[4], o[5]]),
  }));
  assertEquals(firstDivergence(max, stock), null);

  const nudged = structuredClone(stock);
  nudged[17].objs[4][4] += 1e-9;
  assertEquals(
    firstDivergence(max, nudged),
    "frame 17: enemy #4 at (13, 10) under max refresh, enemy #4 at " +
      "(13, 10.000000001) stock",
  );

  const extra = structuredClone(stock);
  extra[9].objs.push(["99", 0, 0, 0, 0, "bullet"]);
  assertEquals(
    firstDivergence(max, extra),
    "frame 9: 20 objects under max refresh, 21 stock",
  );
  assertEquals(
    firstDivergence(max, stock.slice(1)),
    "30 frames against 29",
  );
});

const STEP = 8.333333;

/**
 * `seconds` of a display at `hz` the way the runtime drives one: a fixed
 * 120 Hz step whenever the accumulator holds one, each moving a body `speed`
 * px, and max refresh drawing it between the last two steps by how far the
 * clock has run into the next. Positions on the pixel grid are floored, as
 * the canvas renderer floors them.
 */
function display(hz: number, speed: number, seconds = 2): FrameRecord[] {
  const out: FrameRecord[] = [];
  const dt = Math.ceil((1000 / hz) * 1024) / 1024;
  let acc = 0, steps = 0;
  for (let t = 0; t < Math.round(seconds * hz); t++) {
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      steps++;
    }
    const logic = steps * speed;
    const drawn = steps ? (steps - 1 + acc / STEP) * speed : 0;
    out.push({
      frame: t,
      scene: "PhaserGameScene",
      on: true,
      objs: [[
        "ship",
        drawn,
        200,
        logic,
        200,
        "ship",
        Math.floor(drawn),
        200,
        Math.floor(logic),
        200,
      ]],
    });
  }
  return out;
}

Deno.test("the window spans a step at any display rate", () => {
  for (
    const [hz, span] of [[60, 2], [120, 2], [144, 2], [240, 2], [239.9, 2], [
      360,
      3,
    ], [500, 5]]
  ) {
    assertEquals(stepSpan(hz), span, `${hz} Hz`);
  }
  // At 500 Hz a step lands on one frame in four or five; stock draws a move
  // on exactly those, at the logic's own 120 a second, and max refresh on
  // every frame.
  const c = cadence(display(500, 1), 500);
  assertAlmostEquals(c.stock.moved, 0.24, 0.01);
  assertAlmostEquals(c.stock.drawnHz, 120, 4);
  assertEquals(c.max.moved, 1);
  assertAlmostEquals(c.max.evenness, 1, 0.02);
});

Deno.test("on screen a body moves a whole pixel at a time: fast movers gain, slow ones cannot", () => {
  const onScreen = (hz: number, speed: number) => {
    const c = cadence(display(hz, speed), hz);
    assert(c.pixels, "no pixel view");
    assertEquals(judge(c, hz), [], `${hz} Hz at ${speed} px/step`);
    return [c.pixels.stock.moved, c.pixels.max.moved];
  };
  // A pixel a step at 240 Hz: half a pixel a frame shows on every other
  // frame either way.
  const [s1, m1] = onScreen(240, 1);
  assertAlmostEquals(s1, 0.5, 0.02);
  assertAlmostEquals(m1, 0.5, 0.02);
  // Three a step: stock jumps 3 px every other frame; max refresh shows
  // 1 and 2 px on every frame.
  const [s3, m3] = onScreen(240, 3);
  assertAlmostEquals(s3, 0.5, 0.02);
  assertEquals(m3, 1);
  // Two a step at 500 Hz: stock on one frame in four, max refresh on one in
  // two, evenly spread.
  const [s2, m2] = onScreen(500, 2);
  assertAlmostEquals(s2, 0.24, 0.02);
  assertAlmostEquals(m2, 0.48, 0.03);
  // The background's 0.7 px a step: no better, and no worse.
  const [s07, m07] = onScreen(500, 0.7);
  assert(m07 + 0.01 >= s07, `${m07} < ${s07}`);
});

Deno.test("the check fails max refresh moving things on fewer frames on screen than stock", () => {
  const c = cadence(display(240, 3), 240);
  assert(c.pixels);
  const worse = {
    ...c,
    pixels: { stock: c.pixels.stock, max: { ...c.pixels.max, moved: 0.3 } },
  };
  assertEquals(
    judge(worse, 240),
    ["on screen, max refresh moved things on fewer frames than stock (30.0% against 50.0%)"],
  );
});
