// static/two-player-presence.js — two players at the launcher, and the eShop's
// 2P trim. Pure: pads and clocks in, verdicts and actions out.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  createFilterAuto,
  createPresence,
  filterPickedByHand,
  halvesActive,
  notePad,
  PAIR_QUIET_MS,
  PAIR_WINDOW_MS,
  REVEAL_FLIP_MS,
  REVEAL_HOLD_MS,
  stepFilterAuto,
  verdict,
} from "../static/two-player-presence.js";

// deno-lint-ignore no-explicit-any
type Any = any;

function pad(over: {
  index?: number;
  id?: string;
  axes?: number[];
  pressed?: number[];
  connected?: boolean;
} = {}) {
  const down = new Set(over.pressed ?? []);
  return {
    id: over.id ??
      "Lenovo Legion Controller for Windows (STANDARD GAMEPAD Vendor: 17ef Product: 6182)",
    index: over.index ?? 0,
    mapping: "standard",
    connected: over.connected ?? true,
    axes: over.axes ?? [0, 0, 0, 0],
    buttons: Array.from(
      { length: 17 },
      (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 }),
    ),
  };
}
const XBOX = "Xbox 360 Controller (XInput STANDARD GAMEPAD)";

Deno.test("halvesActive: each half is its own buttons and its own stick", () => {
  assertEquals(halvesActive(pad()), { left: false, right: false });
  for (const i of [4, 6, 8, 10, 12, 13, 14, 15]) {
    assertEquals(halvesActive(pad({ pressed: [i] })), {
      left: true,
      right: false,
    }, `slot ${i}`);
  }
  for (const i of [0, 1, 2, 3, 5, 7, 9, 11]) {
    assertEquals(halvesActive(pad({ pressed: [i] })), {
      left: false,
      right: true,
    }, `slot ${i}`);
  }
  assertEquals(halvesActive(pad({ axes: [0.8, 0, 0, 0] })), {
    left: true,
    right: false,
  });
  assertEquals(halvesActive(pad({ axes: [0, 0, 0, -0.8] })), {
    left: false,
    right: true,
  });
  // Inside the dead zone, and a "no input" sentinel past 1, are nothing.
  assertEquals(halvesActive(pad({ axes: [0.3, 0, 0, 1.28] })), {
    left: false,
    right: false,
  });
});

Deno.test("two pads count only once each has been used, and a pad gone is forgotten", () => {
  const st = createPresence();
  // Two pads plugged in (Firefox lists them at once): nobody has touched the second.
  notePad(st, [
    pad({ id: XBOX, index: 0, pressed: [0] }),
    pad({ id: XBOX, index: 1 }),
  ], 0);
  assertEquals(verdict(st, 0), { two: false, pads: 1, halves: false });
  // The second pad's first press makes two.
  notePad(st, [
    pad({ id: XBOX, index: 0 }),
    pad({ id: XBOX, index: 1, pressed: [9] }),
  ], 1000);
  assertEquals(verdict(st, 1000), { two: true, pads: 2, halves: false });
  // Both idle: still two — a pair reading a list is not holding buttons down.
  notePad(
    st,
    [pad({ id: XBOX, index: 0 }), pad({ id: XBOX, index: 1 })],
    60_000,
  );
  assertEquals(verdict(st, 60_000).two, true);
  // Unplug one: one again. Plug it back: it has to be used again.
  notePad(st, [pad({ id: XBOX, index: 0 }), null], 61_000);
  assertEquals(verdict(st, 61_000), { two: false, pads: 1, halves: false });
  notePad(
    st,
    [pad({ id: XBOX, index: 0 }), pad({ id: XBOX, index: 1 })],
    62_000,
  );
  assertEquals(verdict(st, 62_000).pads, 1);
  // A disconnected entry in the list is no pad.
  notePad(st, [
    pad({ id: XBOX, index: 0 }),
    pad({ id: XBOX, index: 1, pressed: [0], connected: false }),
  ], 63_000);
  assertEquals(verdict(st, 63_000).pads, 1);
});

Deno.test("a Legion's halves make two once both have been worked close together — and only on a Legion", () => {
  const legion = { legion: true };
  let st = createPresence();
  // The left half alone, for a long while: one player.
  notePad(st, [pad({ axes: [0.9, 0, 0, 0] })], 0, legion);
  notePad(st, [pad({ pressed: [4] })], 20_000, legion);
  assertEquals(verdict(st, 20_000), { two: false, pads: 1, halves: false });
  // The right half, within the window: a pair.
  notePad(st, [pad({ axes: [0, 0, 0, 0.9] })], 25_000, legion);
  assertEquals(verdict(st, 25_000), { two: true, pads: 1, halves: true });
  // Quiet for a good while: still a pair (nobody holds a stick while reading)...
  notePad(st, [pad()], 25_000 + PAIR_QUIET_MS - 1, legion);
  assertEquals(verdict(st, 25_000 + PAIR_QUIET_MS - 1).two, true);
  // ...until the halves have been quiet for PAIR_QUIET_MS.
  notePad(st, [pad()], 25_000 + PAIR_QUIET_MS + 1, legion);
  assertEquals(verdict(st, 25_000 + PAIR_QUIET_MS + 1).two, false);
  // Right then left, too far apart, is one player switching hands.
  st = createPresence();
  notePad(st, [pad({ pressed: [0] })], 0, legion);
  notePad(st, [pad({ pressed: [4] })], PAIR_WINDOW_MS + 1, legion);
  assertEquals(verdict(st, PAIR_WINDOW_MS + 1).two, false);
  // ...and close enough is a pair, whichever half went first.
  notePad(st, [pad({ pressed: [0] })], PAIR_WINDOW_MS + 100, legion);
  assertEquals(verdict(st, PAIR_WINDOW_MS + 100).two, true);
  // Not a Legion: the same pad's two halves are one player's two hands.
  st = createPresence();
  notePad(st, [pad({ pressed: [4, 0] })], 0);
  assertEquals(verdict(st, 0), { two: false, pads: 1, halves: false });
  // FPS mode: the right half is a mouse, so no pair — and a pair already
  // counted stops counting while it lasts.
  st = createPresence();
  notePad(st, [pad({ pressed: [4, 0] })], 0, legion);
  assertEquals(verdict(st, 0).two, true);
  assertEquals(verdict(st, 0, { fps: true }).two, false);
  notePad(st, [pad({ pressed: [4, 0] })], 1000, { ...legion, fps: true });
  assertEquals(verdict(st, 1000, { fps: true }).two, false);
  // The pad going away forgets the pair; a different pad starts over.
  st = createPresence();
  notePad(st, [pad({ pressed: [4, 0] })], 0, legion);
  notePad(st, [], 10);
  notePad(st, [pad()], 20, legion);
  assertEquals(verdict(st, 20).two, false);
  st = createPresence();
  notePad(st, [pad({ pressed: [4, 0] })], 0, legion);
  notePad(st, [pad({ id: XBOX })], 10, legion);
  assertEquals(verdict(st, 10).two, false);
  // Only the pad named as the Legion's is read for halves.
  st = createPresence();
  const opts = { ...legion, isLegionPad: (p: Any) => p.index === 1 };
  notePad(st, [pad({ index: 0, pressed: [4, 0] }), pad({ index: 1 })], 0, opts);
  assertEquals(verdict(st, 0), { two: false, pads: 1, halves: false });
  notePad(
    st,
    [pad({ index: 0 }), pad({ index: 1, pressed: [4, 0] })],
    10,
    opts,
  );
  assertEquals(verdict(st, 10), { two: true, pads: 2, halves: true });
});

// ── The 2P trim ──────────────────────────────────────────────────────────────

function run(
  state: Any,
  input: Record<string, unknown>,
): { state: Any; actions: Record<string, unknown> } {
  const r = stepFilterAuto(state, {
    two: true,
    has2P: true,
    onScreen: true,
    filter: "ALL",
    seen: true,
    now: 0,
    ...input,
  } as Any);
  return {
    state: r.state,
    actions: r.actions as unknown as Record<string, unknown>,
  };
}

Deno.test("the first time, the chips flip ALL → 2P in front of the player, then tuck away", () => {
  let s = createFilterAuto();
  // Two players, on the shop screen, never shown before: chips out, a beat.
  let r = run(s, { seen: false, now: 1000 });
  s = r.state;
  assertEquals(r.actions, { showChips: true });
  assertEquals(s.flipAt, 1000 + REVEAL_FLIP_MS);
  // Nothing until the beat is up.
  r = run(s, { seen: false, now: 1000 + REVEAL_FLIP_MS - 1 });
  s = r.state;
  assertEquals(r.actions, {});
  // The flip: 2P, and remembered.
  r = run(s, { seen: false, now: 1000 + REVEAL_FLIP_MS });
  s = r.state;
  assertEquals(r.actions, { setFilter: "2P", markSeen: true });
  // The list shows a while, then the chips go.
  r = run(s, { filter: "2P", now: 1000 + REVEAL_FLIP_MS + REVEAL_HOLD_MS - 1 });
  s = r.state;
  assertEquals(r.actions, {});
  r = run(s, { filter: "2P", now: 1000 + REVEAL_FLIP_MS + REVEAL_HOLD_MS });
  s = r.state;
  assertEquals(r.actions, { hideChips: true });
  // Settled: nothing more while the pair stays.
  r = run(s, { filter: "2P", now: 99_000 });
  assertEquals(r.actions, {});
  assertStrictEquals(r.state.auto, true);
});

Deno.test("once seen, the trim is silent; a hand-picked filter wins; one player again undoes it", () => {
  let s = createFilterAuto();
  let r = run(s, {});
  s = r.state;
  assertEquals(r.actions, { setFilter: "2P", hideChips: true });
  // Still two: quiet.
  r = run(s, { filter: "2P", now: 5000 });
  s = r.state;
  assertEquals(r.actions, {});
  // The second player leaves: back to ALL, chips out again.
  r = run(s, { two: false, filter: "2P", now: 6000 });
  s = r.state;
  assertEquals(r.actions, { setFilter: "ALL", showChips: true });
  assertStrictEquals(s.auto, false);
  // ...and back: trimmed again.
  r = run(s, { now: 7000 });
  s = r.state;
  assertEquals(r.actions, { setFilter: "2P", hideChips: true });
  // The player picks RELEASED by hand: hands off from now on...
  s = filterPickedByHand(s);
  r = run(s, { filter: "RELEASED", now: 8000 });
  s = r.state;
  assertEquals(r.actions, {});
  // ...including when they pick ALL again while the pair is still there.
  r = run(s, { filter: "ALL", now: 9000 });
  s = r.state;
  assertEquals(r.actions, {});
  // The pair leaving clears the hand pick (nothing to undo: not ours)...
  r = run(s, { two: false, filter: "ALL", now: 10_000 });
  s = r.state;
  assertEquals(r.actions, {});
  assertStrictEquals(s.manual, false);
  // ...so the next pair trims again.
  r = run(s, { now: 11_000 });
  assertEquals(r.actions, { setFilter: "2P", hideChips: true });
});

Deno.test("no 2P games, or off the shop screen: nothing happens; a reveal left mid-way is dropped", () => {
  let s = createFilterAuto();
  let r = run(s, { has2P: false });
  s = r.state;
  assertEquals(r.actions, {});
  assertStrictEquals(s.auto, false);
  // Off screen with two players: no trim yet — it waits for the screen.
  r = run(s, { onScreen: false, seen: false, now: 100 });
  s = r.state;
  assertEquals(r.actions, {});
  // On screen: the reveal starts...
  r = run(s, { seen: false, now: 200 });
  s = r.state;
  assertEquals(r.actions, { showChips: true });
  // ...and leaving the screen mid-beat abandons it; coming back with the
  // filter still ALL starts a fresh one rather than flipping late.
  r = run(s, { onScreen: false, seen: false, now: 300 });
  s = r.state;
  assertEquals(r.actions, {});
  assertEquals([s.flipAt, s.tuckAt], [0, 0]);
  assertStrictEquals(s.auto, true);
  r = run(s, { seen: false, now: 400 });
  assertEquals(r.actions, {});
  // The pair leaving resets, so a later pair reveals from the top.
  s = run(s, { two: false, now: 500 }).state;
  r = run(s, { seen: false, now: 600 });
  assertEquals(r.actions, { showChips: true });
  // A filter already 2P by hand when the pair arrives is left alone — and
  // stays when the pair leaves (it was never ours).
  s = createFilterAuto();
  r = run(s, { filter: "2P", now: 700 });
  s = r.state;
  assertEquals(r.actions, {});
  assertStrictEquals(s.auto, false);
  r = run(s, { two: false, filter: "2P", now: 800 });
  assertEquals(r.actions, {});
  assert(!r.state.auto);
});
