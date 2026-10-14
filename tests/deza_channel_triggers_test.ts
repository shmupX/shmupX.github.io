// The change-channel TRIGGERS of a Dezaemon 2 zako, pinned against the
// vendored game.bundle.js the way tests/deza_collision_test.ts pins the
// collision rules.
//
// The engine packs the four channels' C-byte triggers into the per-object
// status word 0x06093C50 as four independent 3-bit fields (FORMAT.md,
// "Change-channel triggers") and arms each on its own scroll-axis line:
// 62/112/164 px into the 224-px playfield, shifted by a per-band signed byte,
// subtracted for an air object and added for a ground one. An air object
// arms once it has reached its line, a ground one while it is still at or
// above it, a ground record has modes 0 and 4 swapped at spawn, and a zoom or
// scale channel still waiting on its line contributes x1.0. The runtime
// scales the lines to its 480-px playfield.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const S = 480 / 224;

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

interface Channel {
  value: number;
  from: number;
  progress: number;
  armAt: number | null;
  armBelow: boolean;
}

interface FakeEnemy {
  y: number;
  scale: [number, number];
  data: Record<string, unknown>;
  setScale(x: number, y: number): void;
  setData(k: string, v: unknown): void;
}

interface Sandbox {
  channelTrigger(
    ch: unknown,
    ground: boolean,
    horizontal: boolean,
    band: number | null,
  ): number | null;
  dezaBand(dezaemon: unknown): number;
  makeChannel(
    ch: unknown,
    extra: unknown,
    ground: boolean,
    horizontal: boolean,
    band: number | null,
  ): Channel;
  armChannels(st: unknown, enemy: { y: number }): void;
  stepChannel(st: Channel): number;
  applyDezaScale(enemy: FakeEnemy, st: unknown): void;
}

/** The trigger tables and the channel functions, lifted out of the bundle. */
async function sandbox(): Promise<Sandbox> {
  const js = await read(BUNDLE);
  const vars = js.match(/^ {2}var CHANNEL_TRIGGER_\w+ = .*;$/gm);
  assert(vars && vars.length >= 5, "the trigger tables are in the bundle");
  const fns = [
    "channelTrigger",
    "dezaBand",
    "makeChannel",
    "armChannels",
    "channelEnd",
    "stepChannel",
    "applyDezaScale",
  ].map((n) => functionSource(js, n)).join("\n");
  return new Function(
    vars.join("\n") + "\n" + fns +
      "\nreturn { channelTrigger, dezaBand, makeChannel, armChannels, stepChannel, applyDezaScale };",
  )() as Sandbox;
}

/** A decoded channel as decode-enemy.js hands it over, with one trigger mode. */
const decoded = (trigger: number, from = 1) => ({
  enabled: true,
  from,
  to: 2,
  sweep: 1,
  step: 0.01,
  repeat: 0,
  trigger,
});

const fakeEnemy = (): FakeEnemy => ({
  y: 0,
  scale: [1, 1],
  data: {},
  setScale(x, y) {
    this.scale = [x, y];
  },
  setData(k, v) {
    this.data[k] = v;
  },
});

Deno.test("one record, four channels, four trigger lines", async () => {
  const { makeChannel } = await sandbox();
  // Band 7's shift is 0, so these are the bare resolver bases.
  const lines = [0, 1, 2, 3].map((mode) =>
    makeChannel(decoded(mode), null, false, false, 7).armAt
  );
  assertEquals(lines, [null, 62 * S, 112 * S, 164 * S]);
  // Modes 4-7 never arm an air channel.
  for (const mode of [4, 5, 6, 7]) {
    assertStrictEquals(
      makeChannel(decoded(mode), null, false, false, 7).armAt,
      Infinity,
    );
  }
});

Deno.test("a ground record swaps 0 and 4, and arms from the other side", async () => {
  const { channelTrigger, makeChannel } = await sandbox();
  assertStrictEquals(channelTrigger(decoded(4), true, false, 7), null);
  assertStrictEquals(channelTrigger(decoded(0), true, false, 7), Infinity);
  assertStrictEquals(channelTrigger(decoded(2), true, false, 7), 112 * S);
  // A missing trigger reads as 0: air runs from spawn, ground never.
  assertStrictEquals(channelTrigger({ enabled: true }, false, false, 7), null);
  assertStrictEquals(
    channelTrigger({ enabled: true }, true, false, 7),
    Infinity,
  );
  // The side of the line rides on the channel itself.
  assertStrictEquals(makeChannel(decoded(1), null, true, false, 7).armBelow, true);
  assertStrictEquals(makeChannel(decoded(1), null, false, false, 7).armBelow, false);
});

Deno.test("the band term shifts the line: minus for air, plus for ground", async () => {
  const { channelTrigger, dezaBand } = await sandbox();
  // +0x22044: bands 0-1 carry -16, 2-4 carry -8, 5-6 carry +8, 7 carries 0.
  assertStrictEquals(
    channelTrigger(decoded(1), false, false, 0),
    (62 + 16) * S,
  );
  assertStrictEquals(channelTrigger(decoded(1), true, false, 0), (62 - 16) * S);
  assertStrictEquals(
    channelTrigger(decoded(3), false, false, 5),
    (164 - 8) * S,
  );
  assertStrictEquals(channelTrigger(decoded(3), true, false, 5), (164 + 8) * S);
  // +0x2204C, the horizontal table, over the horizontal bases 14/48/116.
  assertStrictEquals(channelTrigger(decoded(2), false, true, 1), (48 + 8) * S);
  assertStrictEquals(channelTrigger(decoded(3), true, true, 2), (116 - 16) * S);
  // A recipe with no formation key gets band 0's shift, like the engine's
  // zeroed tag byte would.
  assertStrictEquals(channelTrigger(decoded(1), false, false, null), (62 + 16) * S);
  // The band is bits 4-6 of the formation key: a grid cell byte or a
  // death-word child's tag, either way `1 bbb nnnn`.
  assertStrictEquals(dezaBand({ placementId: 0xb5 }), 3);
  assertStrictEquals(dezaBand({ placementId: 0x80 }), 0);
  assertStrictEquals(dezaBand(null), 0);
});

Deno.test("arming is per channel: crossing one line re-seeds that channel alone", async () => {
  const { makeChannel, armChannels, stepChannel } = await sandbox();
  const early = makeChannel(decoded(1), null, false, false, 7);
  const late = makeChannel(decoded(3), null, false, false, 7);
  // A pending channel holds its value: stepping it moves nothing.
  stepChannel(early);
  assertStrictEquals(early.value, 1);
  assertStrictEquals(early.progress, 0);
  // Pretend both ramps had drifted, to see which one the arming re-seeds.
  early.value = late.value = 9;
  early.progress = late.progress = 0.5;
  const st = { behavior: { ground: false }, pendingChannels: [early, late] };
  armChannels(st, { y: 62 * S - 1 });
  assertStrictEquals(early.armAt, 62 * S, "a pixel short of the line");
  armChannels(st, { y: 62 * S });
  assertStrictEquals(early.armAt, null);
  assertStrictEquals(early.value, 1);
  assertStrictEquals(early.progress, 0);
  assertStrictEquals(late.armAt, 164 * S, "the other channel keeps waiting");
  assertStrictEquals(late.value, 9);
  assert(st.pendingChannels, "still something pending");
  armChannels(st, { y: 164 * S });
  assertStrictEquals(late.armAt, null);
  assertStrictEquals(late.value, 1);
  assertStrictEquals(st.pendingChannels, null);
});

Deno.test("a ground object arms while at or above its line; a never stays never", async () => {
  const { makeChannel, armChannels } = await sandbox();
  const delayed = makeChannel(decoded(2), null, true, false, 7);
  const never = makeChannel(decoded(0), null, true, false, 7);
  const st = { behavior: { ground: true }, pendingChannels: [delayed, never] };
  // Entering from above the top edge, as every grid-spawned object does, the
  // mode-2 channel arms on the first serviced frame.
  armChannels(st, { y: -20 });
  assertStrictEquals(delayed.armAt, null);
  assertStrictEquals(never.armAt, Infinity);
  // Nothing left that can ever arm, so the pending list is let go.
  assertStrictEquals(st.pendingChannels, null);
  // Below its line a ground object is past it: no arming.
  const low = makeChannel(decoded(1), null, true, false, 7);
  const st2 = { behavior: { ground: true }, pendingChannels: [low] };
  armChannels(st2, { y: 62 * S + 1 });
  assertStrictEquals(low.armAt, 62 * S);
  // And an air never is unreachable from below.
  const airNever = makeChannel(decoded(5), null, false, false, 7);
  const st3 = { behavior: { ground: false }, pendingChannels: [airNever] };
  armChannels(st3, { y: 1e6 });
  assertStrictEquals(airNever.armAt, Infinity);
});

Deno.test("a zoom or scale channel waiting on its line draws the object at x1", async () => {
  const { makeChannel, armChannels, applyDezaScale } = await sandbox();
  // Authored to appear at x0 and grow once 62 px in: whole until then, and
  // not deleted on its first frame.
  const zoom = makeChannel(decoded(1, 0), null, false, false, 7);
  const st = { zoomCh: zoom, scaleCh: null, scaleAxes: "xy", pendingChannels: [zoom] };
  const enemy = fakeEnemy();
  applyDezaScale(enemy, st);
  assertEquals(enemy.scale, [1, 1]);
  assertStrictEquals(enemy.data.dezaNoContact, false);
  assertStrictEquals(enemy.data.dezaGone, undefined);
  // Past the line the channel's own value takes over: x0 removes it.
  enemy.y = 62 * S;
  armChannels(st, enemy);
  assertStrictEquals(zoom.armAt, null);
  applyDezaScale(enemy, st);
  assertEquals(enemy.scale, [0, 0]);
  assertStrictEquals(enemy.data.dezaNoContact, true);
  assertStrictEquals(enemy.data.dezaGone, true);
  // The per-axis channel follows the same rule on its own line.
  const axis = makeChannel(decoded(2, 3), null, false, false, 7);
  const st2 = { zoomCh: null, scaleCh: axis, scaleAxes: "x", pendingChannels: [axis] };
  const enemy2 = fakeEnemy();
  applyDezaScale(enemy2, st2);
  assertEquals(enemy2.scale, [1, 1]);
  enemy2.y = 112 * S;
  armChannels(st2, enemy2);
  applyDezaScale(enemy2, st2);
  assertEquals(enemy2.scale, [3, 1]);
});
