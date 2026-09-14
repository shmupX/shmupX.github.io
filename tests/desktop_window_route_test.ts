// routes/api/desktop-window.ts opens a second window of the packaged desktop
// app, because window.open() cannot: under `deno desktop --backend cef` it
// returns null to the page and whatever appears is outside the app's storage
// jar, so the level editor's recipe (localStorage) and atlas (IndexedDB) never
// reach the game and it plays the shipped foo.json instead.
//
// The window is chromeless and the caller is a page, so the address it may be
// pointed at is the security question here.

import { assert, assertEquals } from "@std/assert";
import {
  launcherWindowsAvailable,
  sameOriginTarget,
} from "../routes/api/desktop-window.ts";

const HERE = "http://127.0.0.1:53161/api/desktop-window";

Deno.test("the editor's own relative play URLs resolve against this origin", () => {
  const target = sameOriginTarget("/games/2028-ai?editorPlay=1&stage=0", HERE);
  assert(target);
  assertEquals(target.origin, "http://127.0.0.1:53161");
  assertEquals(target.pathname, "/games/2028-ai");
  // The query is the whole point: ?editorPlay=1 is what tells the game to look
  // for the editor's recipe rather than fetch a level.
  assertEquals(target.searchParams.get("editorPlay"), "1");
  assertEquals(target.searchParams.get("stage"), "0");
});

Deno.test("an absolute URL on this origin is accepted", () => {
  const target = sameOriginTarget(
    "http://127.0.0.1:53161/games/2028-ai?editorPlay=1",
    HERE,
  );
  assert(target);
  assertEquals(target.pathname, "/games/2028-ai");
});

Deno.test("a foreign origin is refused, not clamped", () => {
  for (
    const url of [
      "https://example.com/phish",
      "http://127.0.0.1:9999/other-port",
      "http://localhost:53161/other-host",
      "//example.com/protocol-relative",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<h1>hi",
    ]
  ) {
    assertEquals(sameOriginTarget(url, HERE), null, url);
  }
});

Deno.test("a missing or non-string url is refused", () => {
  for (const url of [undefined, null, "", "   ", 42, {}, ["/games/2028-ai"]]) {
    assertEquals(sameOriginTarget(url, HERE), null, String(url));
  }
});

Deno.test("the test runner is not a launcher, so no window can be opened", () => {
  // `deno test` is plain Deno: no Deno.BrowserWindow, so the route reports
  // itself unavailable and the editor keeps using window.open. The same answer
  // the hosted deploy and a source checkout in a browser get.
  assertEquals(
    typeof (Deno as { BrowserWindow?: unknown }).BrowserWindow,
    "undefined",
  );
  assertEquals(launcherWindowsAvailable(), false);
});
