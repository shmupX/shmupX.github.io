// The numbers `deno task refresh:compare` judges a recording by.
//
// scripts/refresh-compare.ts records the game on an emulated 240 Hz display,
// stock and max refresh side by side, and turns each object's per-frame
// positions into how often its motion is drawn and how evenly. These pin what
// those numbers say about motion whose shape is known in advance, so a pass
// from the real recording means what it claims.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  cadence,
  firstDivergence,
  type FrameRecord,
  judge,
  type ObjectSample,
  type ViewCadence,
} from "../scripts/refresh-compare.ts";

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
