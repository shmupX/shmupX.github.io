// The watch launch protocol's rules, without a database or a browser.
//
// These are the three things that decide whether a game starts on the desktop
// when somebody presses LAUNCH on their wrist, and each of them has a failure
// mode that is invisible rather than loud: a replayed launch starts the wrong
// game a day later, an unknown kind does nothing at all, and an unclamped URL
// puts somebody else's page inside the launcher's game frame.

import { assertEquals } from "@std/assert";
import {
  CONTROL_ACTIONS,
  isFreshControl,
  isFreshLaunch,
  LAUNCH_KINDS,
  sameOriginPath,
} from "../static/watch-launch.js";

const BOOT = 1_000_000;
const later = (ms = 1) => BOOT + ms;

function launch(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    kind: "game",
    game_id: "shmupx",
    created_at: later(),
    ...over,
  };
}

Deno.test("a well-formed launch is taken once", () => {
  const seen = new Set<string>();
  assertEquals(isFreshLaunch(launch(), seen, BOOT), true);
  seen.add("a1");
  // The stream's first frame after a reconnect is the whole node, so the same
  // record arrives again every time the page opens. Acting on it twice is how
  // you get last night's game starting itself at breakfast.
  assertEquals(isFreshLaunch(launch(), seen, BOOT), false);
});

Deno.test("a launch from before this page booted is history", () => {
  assertEquals(
    isFreshLaunch(launch({ created_at: BOOT - 1 }), new Set(), BOOT),
    false,
  );
});

Deno.test("a launch with no usable clock is still taken", () => {
  // A watch whose clock is wrong should not be silently ignored forever; only
  // a confidently old record is skipped.
  for (const created of [undefined, 0, "not a number"]) {
    assertEquals(
      isFreshLaunch(launch({ created_at: created }), new Set(), BOOT),
      true,
      `created_at=${String(created)}`,
    );
  }
});

Deno.test("an unknown kind is dropped, every known one is taken", () => {
  for (const kind of LAUNCH_KINDS) {
    assertEquals(isFreshLaunch(launch({ kind }), new Set(), BOOT), true, kind);
  }
  for (const kind of ["", "GAME", "exec", "eval", null, 7, {}]) {
    assertEquals(
      isFreshLaunch(launch({ kind }), new Set(), BOOT),
      false,
      JSON.stringify(kind),
    );
  }
});

Deno.test("a launch with no id is dropped", () => {
  // Without an id there is no way to tell a new press from a redelivery.
  assertEquals(isFreshLaunch(launch({ id: "" }), new Set(), BOOT), false);
  assertEquals(
    isFreshLaunch(launch({ id: undefined }), new Set(), BOOT),
    false,
  );
  assertEquals(isFreshLaunch(null, new Set(), BOOT), false);
  assertEquals(isFreshLaunch("nope", new Set(), BOOT), false);
});

Deno.test("a control is taken once per action and timestamp", () => {
  const seen = new Set<string>();
  const cmd = { action: "pause", created_at: later() };
  assertEquals(isFreshControl(cmd, seen, BOOT), true);
  assertEquals(isFreshControl(cmd, seen, BOOT), false);
  // A later press of the same button is a different command.
  assertEquals(
    isFreshControl({ action: "pause", created_at: later(2) }, seen, BOOT),
    true,
  );
});

Deno.test("only the four known control actions are taken", () => {
  for (const action of CONTROL_ACTIONS) {
    assertEquals(
      isFreshControl({ action, created_at: later() }, new Set(), BOOT),
      true,
      action,
    );
  }
  for (const action of ["quit", "", "PAUSE", null]) {
    assertEquals(
      isFreshControl({ action, created_at: later() }, new Set(), BOOT),
      false,
      JSON.stringify(action),
    );
  }
});

Deno.test("a control with no timestamp is dropped", () => {
  // Unlike a launch, a control has no id, so the timestamp IS its identity —
  // without one it would be re-applied on every frame of the stream.
  assertEquals(isFreshControl({ action: "stop" }, new Set(), BOOT), false);
});

Deno.test("sameOriginPath keeps this origin and nothing else", () => {
  const origin = "http://localhost:8000";
  assertEquals(
    sameOriginPath("/editor/?game=2028-ai", origin),
    "/editor/?game=2028-ai",
  );
  assertEquals(
    sameOriginPath("editor/index.html", origin),
    "/editor/index.html",
  );
  assertEquals(
    sameOriginPath("http://localhost:8000/a?b=c#d", origin),
    "/a?b=c#d",
  );
});

Deno.test("sameOriginPath refuses anything that leaves this origin", () => {
  const origin = "http://localhost:8000";
  // The database is open-write: whoever knows the build code can put a string
  // here, and this is the one field that would otherwise be followed.
  for (
    const hostile of [
      "https://evil.example/pwn",
      "//evil.example/pwn",
      "http://localhost:9999/other-port",
      "https://localhost:8000/other-scheme",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "",
      null,
      undefined,
      42,
    ]
  ) {
    assertEquals(
      sameOriginPath(hostile as string, origin),
      null,
      JSON.stringify(hostile),
    );
  }
});

Deno.test("the control seen-set does not grow without bound", () => {
  // The set exists to stop a redelivered record being acted on twice, and a
  // redelivery is always of the CURRENT node — so only recent keys can ever be
  // asked about. On a page left open for days, and an open-write database
  // anyone can drive, an unbounded set is a leak with no upside.
  const seen = new Set<string>();
  for (let i = 1; i <= 1000; i++) {
    isFreshControl({ action: "volume", created_at: BOOT + i }, seen, BOOT);
  }
  assertEquals(seen.size <= 256, true, `set grew to ${seen.size}`);
  // The most recent is still remembered, which is the whole job.
  assertEquals(
    isFreshControl({ action: "volume", created_at: BOOT + 1000 }, seen, BOOT),
    false,
  );
});
