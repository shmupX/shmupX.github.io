// The offline half of scripts/lib/game-debug.ts: the name tables that both the
// `deno task game:debug` prompt and the `shmupx_debug_*` MCP tools parse their
// arguments with, and the probe source itself.
//
// The probe is the part worth pinning. It is a string, so the type-checker
// never looks at it, and the only place it can actually run is a page inside a
// browser this test is not allowed to start — which leaves its standing
// invariants unguarded, and every one of them fails SILENTLY in the runtime:
// a version literal that drifts from the export is a client refusing to attach
// to a page that is in fact fine, owning requestAnimationFrame without
// cancelAnimationFrame is a cancel that removes somebody else's callback, and a
// pad id ending in "[R]" reads as the right half of a split controller and puts
// a second ship in the air. So they are asserted against the source text here,
// where they cost nothing.
//
// Nothing in this file touches the network, starts a browser or opens a
// DevTools port: every case is a literal or a substring of PROBE.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  KEY_SPECS,
  keySpec,
  PAD_BUTTONS,
  padButtonIndex,
  pngSize,
  PROBE,
  PROBE_VERSION,
} from "../scripts/lib/game-debug.ts";

/**
 * The W3C standard gamepad mapping, written out rather than derived from
 * PAD_BUTTONS — deriving it would only prove the table equals itself. These
 * indices are a contract with static/gamepad-support.js, which indexes straight
 * into `buttons[]`, so a shifted number does not fail: it presses the wrong
 * button.
 */
const STANDARD_MAPPING: Record<string, number> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  l: 4,
  r: 5,
  lt: 6,
  rt: 7,
  select: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};

/**
 * The keys the runtime reads, with the legacy keyCode each one has to carry.
 * `Input.dispatchKeyEvent` is believed whatever it is told, and Phaser's
 * keyboard plugin matches on keyCode — so a wrong `vk` delivers an event the
 * page dispatches happily and the game never answers.
 */
const EXPECTED_KEYS: Record<string, { key: string; code: string; vk: number }> =
  {
    enter: { key: "Enter", code: "Enter", vk: 13 },
    space: { key: " ", code: "Space", vk: 32 },
    shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
    up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    z: { key: "z", code: "KeyZ", vk: 90 },
    s: { key: "s", code: "KeyS", vk: 83 },
    w: { key: "w", code: "KeyW", vk: 87 },
  };

/** ─── the pad table ─────────────────────────────────────────────────────── */

Deno.test("padButtonIndex is the standard mapping under shmup names", () => {
  for (const [name, index] of Object.entries(STANDARD_MAPPING)) {
    assertEquals(padButtonIndex(name), index, `pad button "${name}"`);
  }
  // A name added to PAD_BUTTONS without a number pinned here would otherwise
  // sail through the loop above untested.
  assertEquals(
    Object.keys(PAD_BUTTONS).sort(),
    Object.keys(STANDARD_MAPPING).sort(),
  );
});

Deno.test("padButtonIndex does not care about case", () => {
  // The prompt's `b` command and the MCP tool both pass whatever was typed.
  assertEquals(padButtonIndex("A"), 0);
  assertEquals(padButtonIndex("Start"), 9);
  assertEquals(padButtonIndex("UP"), 12);
  assertEquals(padButtonIndex("rT"), 7);
});

Deno.test("an unknown pad button is refused with the list of known ones", () => {
  // The names are not guessable from a console ("triangle", "circle", "fire"),
  // so the error has to carry the whole vocabulary or the next attempt is
  // another guess.
  const err = assertThrows(() => padButtonIndex("triangle"), Error);
  assertStringIncludes(err.message, 'unknown pad button "triangle"');
  assertStringIncludes(err.message, Object.keys(PAD_BUTTONS).join(", "));
  for (const name of ["a", "select", "right"]) {
    assertStringIncludes(err.message, name);
  }
  // An empty argument is the same mistake, not a silent button 0.
  assertThrows(() => padButtonIndex(""), Error, "unknown pad button");
});

Deno.test("no two pad names share an index", () => {
  // A duplicate is invisible from either side: both names work, and one of them
  // quietly presses the other's button for the rest of the session.
  const seen = new Map<number, string>();
  for (const [name, index] of Object.entries(PAD_BUTTONS)) {
    const other = seen.get(index);
    assert(
      other === undefined,
      `"${name}" and "${other}" are both button ${index}`,
    );
    seen.set(index, name);
  }
  assertEquals(seen.size, Object.keys(PAD_BUTTONS).length);
});

Deno.test("every pad index exists on the pad the probe fabricates", () => {
  // dbg.setButtons() does `if (!b) continue`, so an index past the end of the
  // synthetic pad's buttons[] is not an error — it is a press that does
  // nothing, reported as a successful press.
  const blank = PROBE.match(/function blankButtons\(\)[\s\S]*?i < (\d+)/);
  assert(blank, "PROBE no longer builds its buttons with a counted loop");
  const buttons = Number(blank[1]);
  const highest = Math.max(...Object.values(PAD_BUTTONS));
  assert(
    buttons > highest,
    `the probe's pad has ${buttons} buttons but PAD_BUTTONS names ${highest}`,
  );
});

/** ─── the key table ─────────────────────────────────────────────────────── */

Deno.test("keySpec carries the key, code and keyCode the runtime reads", () => {
  for (const [name, spec] of Object.entries(EXPECTED_KEYS)) {
    assertEquals(keySpec(name), spec, `key "${name}"`);
  }
  assertEquals(
    Object.keys(KEY_SPECS).sort(),
    Object.keys(EXPECTED_KEYS).sort(),
  );
});

Deno.test("keySpec does not care about case", () => {
  assertEquals(keySpec("ENTER").code, "Enter");
  assertEquals(keySpec("Space").key, " ");
  assertEquals(keySpec("Z").vk, 90);
});

Deno.test("an unknown key is refused with the list of known ones", () => {
  const err = assertThrows(() => keySpec("escape"), Error);
  assertStringIncludes(err.message, 'unknown key "escape"');
  assertStringIncludes(err.message, Object.keys(KEY_SPECS).join(", "));
  for (const name of ["enter", "space", "shift"]) {
    assertStringIncludes(err.message, name);
  }
  assertThrows(() => keySpec(""), Error, "unknown key");
});

Deno.test("no two key names share a physical key", () => {
  // Same failure as a duplicate pad index, one layer up: two names that
  // dispatch the same `code` are one key wearing two hats.
  const seen = new Map<string, string>();
  for (const [name, spec] of Object.entries(KEY_SPECS)) {
    const other = seen.get(spec.code);
    assert(
      other === undefined,
      `"${name}" and "${other}" both dispatch ${spec.code}`,
    );
    seen.set(spec.code, name);
  }
});

/** ─── the probe source ──────────────────────────────────────────────────── */

Deno.test("the probe declares the version the module exports", () => {
  // Both the guard at the top of the probe and the version it publishes on
  // window.__dbg are interpolated today, which is exactly the state worth
  // pinning: the moment either is hand-edited to a literal, GameDebug.attach()
  // starts refusing a page that is running a perfectly good probe, and the
  // error blames the page.
  const declared = [
    ...PROBE.matchAll(/version(?:\s*:\s*|\s*===\s*)(\d+)/g),
  ].map((m) => Number(m[1]));
  assert(
    declared.length >= 2,
    "PROBE no longer states its version both as a guard and as a field",
  );
  for (const v of declared) assertEquals(v, PROBE_VERSION);
});

Deno.test("the probe owns both halves of the animation-frame id space", () => {
  // requestAnimationFrame hands out ids from the probe's own counter, so a
  // cancelAnimationFrame left pointing at the browser's implementation is
  // handed an id from a different space: it either cancels nothing or cancels
  // an unrelated callback, and both read as a frame that vanished.
  assertStringIncludes(PROBE, "window.requestAnimationFrame = function");
  assertStringIncludes(PROBE, "window.cancelAnimationFrame = function");

  // And the real one has to be captured BEFORE the replacement, or the pump
  // that drains a batch per tick re-enters the queue it is draining and the
  // page stops painting altogether.
  const captured = PROBE.indexOf("window.requestAnimationFrame.bind(window)");
  const replaced = PROBE.indexOf("window.requestAnimationFrame = function");
  assert(captured >= 0, "PROBE no longer keeps a handle on the real rAF");
  assert(
    captured < replaced,
    "PROBE replaces requestAnimationFrame before capturing the real one",
  );
});

Deno.test("the probe's pad cannot be read as half of a split pad", () => {
  // game.bundle.js's cmgSplitTwoPlayer() calls a connected pad the right half
  // of a split controller when its id ends in " [R]" (or when it carries
  // __cmgSplitHalf === "R"), and answers true — which sets playerCount to 2.
  // A second ship also puts x1.5 hp on everything that spawns, so a carelessly
  // named debug pad changes the game being debugged and says nothing about it.
  const id = PROBE.match(/id:\s*"([^"]*)"/);
  assert(id, "PROBE no longer gives its synthetic pad a string id");
  const padId = id[1];
  assert(padId.length > 0, "the synthetic pad needs a non-empty id");
  assert(
    !/\[R\]$/i.test(padId.trim()),
    `the synthetic pad id "${padId}" ends in [R] and starts two-player`,
  );
  assert(
    !PROBE.includes("__cmgSplitHalf"),
    "PROBE sets __cmgSplitHalf, which is the other half of the same trap",
  );
});

Deno.test("the probe's synthetic clock advances a fixed sixtieth", () => {
  // The fixed delta is the whole reason stepping is usable: a wall-clock
  // timestamp after a pause of any length arrives as one enormous delta and
  // Phaser lurches the world forward to catch up. Anything derived from
  // performance.now() inside stepOnce would bring that back.
  assertStringIncludes(PROBE, "dt: 1000 / 60");
  // Bounded by the next definition rather than by a brace at a known
  // indentation, so reformatting the probe does not fail this test for the
  // wrong reason.
  const step = PROBE.match(
    /dbg\.stepOnce = function[\s\S]*?dbg\.step = function/,
  );
  assert(step, "PROBE no longer defines stepOnce before step");
  assertStringIncludes(step[0], "dbg.t += dbg.dt");
  assert(
    !step[0].includes("performance.now"),
    "stepOnce reads the wall clock, which is what the synthetic clock replaces",
  );
});

Deno.test("pngSize reads the size a capture actually came out at", () => {
  // The first 24 bytes of a PNG are fixed: the 8-byte signature, IHDR's
  // 4-byte length, the tag, then width and height as big-endian u32s. Built
  // by hand here because the point of pngSize is to answer without a decoder.
  const header = (w: number, h: number) => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.set([0, 0, 0, 13], 8);
    b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  assertEquals(pngSize(header(GAME_WIDTH, GAME_HEIGHT)), {
    width: 256,
    height: 480,
  });
  // The size a debug capture came out at when the viewport was NOT fitted:
  // Chrome will not make a window narrower than 500, so the game arrived
  // letterboxed and scaled down. A caller has to be able to tell.
  assertEquals(pngSize(header(500, 340)), { width: 500, height: 340 });
});

Deno.test("pngSize refuses to guess about bytes that are not a PNG", () => {
  // 0x0 rather than a throw: a capture that came back as something else is
  // worth reporting alongside the frame it claims to be, not worth losing.
  assertEquals(pngSize(new Uint8Array(0)), { width: 0, height: 0 });
  assertEquals(pngSize(new Uint8Array(64)), { width: 0, height: 0 });
  const truncated = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  assertEquals(pngSize(truncated), { width: 0, height: 0 });
});
