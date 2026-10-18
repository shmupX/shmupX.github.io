// Which tree of the shared database an exported app writes to.
//
// shmupX's characters and atlases live under `shmupX/` in the database cmg
// also uses, and an exported app's PAUSE panel can publish into that library
// through EXTRACT MODE (static/phaser-plugins/extract-mode.js, staged into
// every export). The app learns the tree from two globals the shell bakes,
// window.__RTDB_ROOT__ and window.__CHARACTERS_DB__ — the same two
// static/firebase-config.js sets on the hosted pages. That file is staged
// only when the level has a leaderboard id, so the shell must bake them
// itself, for every export: an app without them would publish its sprites
// into cmg's root-level library. These pin that, and that the leaderboard's
// __GAME_ID__ baking is untouched by it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRequire } from "node:module";
import { fromFileUrl, join } from "@std/path";

const require = createRequire(import.meta.url);
const lib = (name: string) =>
  fromFileUrl(new URL(`../tools/build-level/lib/${name}`, import.meta.url));
const { renderShell } = require(lib("shell-template.js"));
const { stageWww } = require(lib("stage.js"));
const { FIREBASE_DB_URL } = require(lib("fetch-level.js"));
const { RTDB_ROOT } = require(lib("rtdb-root.js"));

const BUNDLE = fromFileUrl(
  new URL("../../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** The globals the shell's first inline <script> leaves on `window`. */
function flagsOf(html: string): Record<string, unknown> {
  const m = /<script>(window\.__EXPORTED_LEVEL_APP__[^<]*)<\/script>/.exec(
    html,
  );
  assert(m, "no flags script in the shell");
  const window: Record<string, unknown> = {};
  new Function("window", m[1])(window);
  return window;
}

Deno.test("every export bakes shmupX's tree, with or without a leaderboard", () => {
  assertEquals(RTDB_ROOT, "shmupX");
  assertEquals(FIREBASE_DB_URL, DB);
  for (const gameId of ["foo-a9f37ed7", null]) {
    const html = renderShell({ levelName: "foo", gameId, hasExtract: true });
    const flags = flagsOf(html);
    assertEquals(flags.__RTDB_ROOT__, "shmupX", String(gameId));
    assertEquals(flags.__CHARACTERS_DB__, `${DB}/shmupX`, String(gameId));
    assertEquals(flags.__EXPORTED_LEVEL_APP__, true);
    // Before anything that reads them: firebase-config.js (which sets the
    // same values), the bundle, and EXTRACT MODE.
    const at = html.indexOf("__RTDB_ROOT__");
    for (const later of ["game.bundle.js", "extract-mode.js"]) {
      assert(html.indexOf(later) > at, later + " loads before the root");
    }
    if (gameId) {
      assert(html.indexOf("firebase-config.js") > at);
    } else {
      assert(!html.includes("firebase-config.js"));
    }
  }
});

Deno.test("the leaderboard id is baked exactly as it was", () => {
  const html = renderShell({ levelName: "foo", gameId: "foo-a9f37ed7" });
  assertStringIncludes(html, 'window.__GAME_ID__ = "foo-a9f37ed7";');
  assertEquals(flagsOf(html).__GAME_ID__, "foo-a9f37ed7");
  const none = renderShell({ levelName: "foo", gameId: null });
  assert(!none.includes("__GAME_ID__"));
  // GOD MODE still rides alongside.
  const god = flagsOf(renderShell({ levelName: "foo", godMode: true }));
  assertEquals(god.__GAME_STATE__, { godFlg: true });
});

Deno.test("an explicit database is a base; the root goes on top", () => {
  const flags = flagsOf(renderShell({
    levelName: "x",
    databaseURL: "https://db.test/",
    rtdbRoot: "shmupX",
  }));
  assertEquals(flags.__CHARACTERS_DB__, "https://db.test/shmupX");
  assertEquals(flags.__RTDB_ROOT__, "shmupX");
});

Deno.test("a staged export with no leaderboard still names shmupX's tree", async () => {
  const root = await Deno.makeTempDir();
  try {
    const gameDir = join(root, "game");
    const www = join(root, "www");
    const extract = join(root, "extract-mode.js");
    const config = join(root, "firebase-config.js");
    await Deno.mkdir(join(gameDir, "assets"), { recursive: true });
    await Deno.mkdir(join(gameDir, "lib"), { recursive: true });
    await Deno.copyFile(BUNDLE, join(gameDir, "game.bundle.js"));
    await Deno.writeTextFile(join(gameDir, "lib", "phaser.min.js"), "");
    await Deno.writeTextFile(extract, "/* extract */");
    await Deno.writeTextFile(config, "/* config */");
    const log = console.log;
    console.log = () => {};
    try {
      stageWww({
        gameDir,
        wwwRoot: www,
        extractPlugin: extract,
        firebaseConfig: config,
        databaseURL: FIREBASE_DB_URL,
        rtdbRoot: RTDB_ROOT,
        levelName: "gs",
        levelData: { name: "gs", enemylist: [["00"]] },
        gameId: null,
      });
    } finally {
      console.log = log;
    }
    const exists = (p: string) => Deno.stat(p).then(() => true, () => false);
    // No board, so no config file — which is exactly why the shell carries
    // the root itself.
    assert(!(await exists(join(www, "firebase-config.js"))));
    assert(await exists(join(www, "extract-mode.js")));
    const html = await Deno.readTextFile(join(www, "phaser-game.html"));
    const flags = flagsOf(html);
    assertEquals(flags.__RTDB_ROOT__, "shmupX");
    assertEquals(flags.__CHARACTERS_DB__, `${DB}/shmupX`);
    assertEquals(flags.__GAME_ID__, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
