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
// The browser's command line is pinned here for the same reason as the probe,
// and it arrived here the same way — by failing silently in the runtime. A
// --user-data-dir missing from the argv costs nothing headless, which is the
// default and the CI path, and costs a headed run its DevTools port entirely:
// Chrome 136+ declines a debugging port on the user's default profile without
// declining anything else, so the window opens, the game runs in it, and the
// only symptom is a forty-second timeout blaming the port. Nothing about that
// is visible to the type-checker either.
//
// Nothing in this file touches the network, starts a browser or opens a
// DevTools port. Every case is a literal, a substring of PROBE, or a pure
// function fed a fixture — including the attachCdp case, which passes a
// timeout of zero so the polling loop's guard is false before its first fetch.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { basename, isAbsolute, join } from "@std/path";
import {
  attachCdp,
  debugChromeArgs,
  debugProfileDir,
  explainChromeLaunch,
  GAME_HEIGHT,
  GAME_WIDTH,
  KEY_SPECS,
  keySpec,
  makeCapture,
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

/** ─── the browser's command line ────────────────────────────────────────── */

Deno.test("the debug browser never runs on the default Chrome profile", () => {
  // Chrome 136+ silently declines to honour --remote-debugging-port when the
  // user-data-dir is the default profile: the window opens, the game loads,
  // and the port is simply never listening. Headless is exempt, and headless
  // is the default here, so a --user-data-dir dropped from this list breaks
  // exactly one mode — and breaks it as a forty-second timeout that blames the
  // DevTools port.
  const url = "http://127.0.0.1:8824/games/2028-ai?bossRush=1";
  for (const headless of [true, false]) {
    const args = debugChromeArgs({
      url,
      cdpPort: 9223,
      profileDir: "/tmp/profile-under-test",
      headless,
    });
    const profile = args.filter((a) => a.startsWith("--user-data-dir="));
    assertEquals(
      profile.length,
      1,
      `headless=${headless} passes ${profile.length} --user-data-dir flags`,
    );
    assertEquals(profile[0], "--user-data-dir=/tmp/profile-under-test");
    assert(args.includes("--remote-debugging-port=9223"));
    // The URL goes last, or a valueless flag before it swallows it.
    assertEquals(args[args.length - 1], url);
  }
});

Deno.test("headed means headed, and headless keeps its container flags", () => {
  // The two halves of the same mistake: a --headless that survives into the
  // headed argv is a window that never appears, and a container flag lost from
  // the headless argv is a CI job that fails on a sandbox or on /dev/shm
  // rather than on the game.
  const common = {
    url: "http://127.0.0.1:8824/games/2028-ai",
    cdpPort: 9223,
    profileDir: "/tmp/p",
  };
  const headed = debugChromeArgs({ ...common, headless: false });
  assert(
    !headed.some((a) => a.startsWith("--headless")),
    `headed argv still carries ${
      headed.find((a) => a.startsWith("--headless"))
    }`,
  );
  const headless = debugChromeArgs({ ...common, headless: true });
  for (
    const flag of [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ]
  ) {
    assert(headless.includes(flag), `headless argv lost ${flag}`);
  }
});

Deno.test("each DevTools port gets a profile directory of its own", () => {
  // --cdp-port exists so two sessions can run side by side, and a Chromium
  // profile takes a singleton lock: a second Chrome on a directory the first
  // one holds hands over its URL and exits rather than starting a browser, so
  // one shared directory would trade the bug above for a subtler one — a tab
  // in the wrong window, and a port belonging to somebody else's game.
  //
  // The root is passed in rather than left to repoRoot(), which caches per
  // process and reads $SHMUPX_ROOT: this asks about the shape of the path, not
  // about where this checkout happens to be.
  const a = debugProfileDir(9223, "/r");
  const b = debugProfileDir(9224, "/r");
  assert(a !== b, `ports 9223 and 9224 share a profile directory (${a})`);
  assert(isAbsolute(a), `${a} is not absolute`);
  // Under build/, which is gitignored — the same place debug-shots land.
  assertEquals(a, join("/r", "build", "debug-profile", "9223"));
  assertEquals(basename(b), "9224");
});

/** ─── what the failure says ─────────────────────────────────────────────── */

// Chrome's own wording, lifted out of the installed binary's string table
// rather than remembered, plus one real capture of the IPv6 fallback.
const CHROME_SAYS = {
  defaultProfile:
    "DevTools remote debugging requires a non-default data directory. " +
    "Specify this using --user-data-dir.",
  policy: "DevTools remote debugging is disallowed by the system admin.",
  portTaken: "[98110:1271797:0918/224335.067619:ERROR:net/socket/" +
    "socket_posix.cc:175] bind() failed: Address already in use (48)\n" +
    "DevTools listening on ws://[::1]:9223/devtools/browser/abc",
  listening: "DevTools listening on ws://127.0.0.1:9223/devtools/browser/abc",
};

function explain(
  said: string,
  exitCode: number | null,
  lastErr = "fetch failed",
): string[] {
  return explainChromeLaunch({
    cdpPort: 9223,
    profileDir: "/r/build/debug-profile/9223",
    said,
    exitCode,
    lastErr,
    logPath: "/r/build/debug-logs/chrome-9223.log",
  });
}

Deno.test("the launch path never advises running the command that failed", () => {
  // The defect this whole function exists to retire. attachCdp is shared
  // between attaching to somebody else's browser — where "start one with
  // `deno task game:debug`" is the entire fix — and launching one, where it
  // tells a person to re-run the command that is failing in front of them.
  // Everything explainChromeLaunch produces is on the launch side.
  const fixtures: [string, number | null][] = [
    [CHROME_SAYS.defaultProfile, 0],
    [CHROME_SAYS.policy, 0],
    [CHROME_SAYS.portTaken, null],
    [CHROME_SAYS.listening, null],
    ["", 0],
    ["", null],
  ];
  for (const [said, exitCode] of fixtures) {
    const lines = explain(said, exitCode);
    assert(
      lines.length > 0,
      `no explanation at all for ${JSON.stringify(said)}`,
    );
    for (const line of lines) {
      assert(
        !line.includes("game:debug"),
        `explanation tells the caller to run the failing command: ${line}`,
      );
    }
  }
});

Deno.test("each refusal Chrome has a word for is named by that word", () => {
  const profile = explain(CHROME_SAYS.defaultProfile, 0).join(" ");
  assertStringIncludes(profile, "/r/build/debug-profile/9223");
  assertStringIncludes(profile, "136");

  // Policy is the failure mode that SURVIVES the profile fix, so the answer
  // must not be the profile fix: a reader who tries --user-data-dir here
  // spends an hour proving it makes no difference.
  const policy = explain(CHROME_SAYS.policy, 0).join(" ");
  assertStringIncludes(policy, "policy");
  assert(
    !policy.includes("--user-data-dir"),
    `policy failure offers the flag that cannot help it: ${policy}`,
  );

  // Both halves: the port is taken, AND the cheerful "DevTools listening" line
  // underneath it is on [::1] while everything here fetches 127.0.0.1.
  const taken = explain(CHROME_SAYS.portTaken, null).join(" ");
  assertStringIncludes(taken, "lsof -iTCP:9223");
  assertStringIncludes(taken, "[::1]");

  // A port that opened and a page that never appeared is a different bug from
  // a port that never opened, and saying so is the difference between looking
  // at the browser and looking at the bundle.
  const noPage = explain(CHROME_SAYS.listening, null, "no page target").join(
    " ",
  );
  assertStringIncludes(noPage, "no page target ever appeared");

  // Exited with nothing to say: the profile singleton handed the URL over.
  const exited = explain("", 0).join(" ");
  assertStringIncludes(exited, "/r/build/debug-profile/9223");
  assertStringIncludes(exited, "--cdp-port");
});

Deno.test("every explanation points at Chrome's own words", () => {
  // Each branch above is an INFERENCE from the capture, and the next refusal
  // Chrome invents will match none of them — so the raw text, or the file it
  // was written to, is always the last thing said.
  assertStringIncludes(
    explain(CHROME_SAYS.defaultProfile, 0).at(-1)!,
    "/r/build/debug-logs/chrome-9223.log",
  );
  assertStringIncludes(explain("", null).at(-1)!, "Chrome wrote nothing");
});

Deno.test("the advice sentence belongs to attachCdp's caller", async () => {
  // A timeout of zero makes `Date.now() < Date.now() + 0` false on its first
  // evaluation, so this composes the message and throws without opening a
  // single connection. If anyone turns that loop into a do/while, this test
  // starts making one real (refused) fetch — still harmless, no longer pure.
  const bare = await assertRejects(() => attachCdp(9999, 0), Error);
  assertStringIncludes(bare.message, "no debug browser on DevTools port 9999");
  assertStringIncludes(bare.message, "Start one with: deno task game:debug");

  const launched = await assertRejects(
    () => attachCdp(9999, 0, { advice: () => "Chrome exited (code 0)." }),
    Error,
  );
  assertStringIncludes(launched.message, "Chrome exited (code 0).");
  assert(
    !launched.message.includes("game:debug"),
    `a caller's own advice did not replace the default: ${launched.message}`,
  );
});

Deno.test("the captured browser log keeps both of its ends", () => {
  // The refusal is at the head — Chrome declines the port in the first two
  // seconds — and a renderer crash three hours into a stepping session is at
  // the tail. A plain tail ring answers only the second, and silently discards
  // the one this capture was added for.
  const capture = makeCapture(64);
  capture.push(`${CHROME_SAYS.defaultProfile}\n`);
  for (let i = 0; i < 40; i++) capture.push(`component update chatter ${i}\n`);
  capture.push("[ERROR] the renderer went away\n");
  const text = capture.text();
  assertStringIncludes(text, "non-default data directory");
  assertStringIncludes(text, "the renderer went away");
  assertStringIncludes(text, "elided");
  // Not a transcript with holes patched over: the elision is announced, and
  // the middle really is gone.
  assert(!text.includes("component update chatter 20"), text);
});

Deno.test("a capture that fits is handed back whole", () => {
  const capture = makeCapture(64);
  capture.push("one line\n");
  assertEquals(capture.text(), "one line");
});
