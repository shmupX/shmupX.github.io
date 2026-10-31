// WORLD BEST and TODAY'S BEST are one game's, never another's.
//
// A hosted ?level=<name>, ?level=<alias> or <name>.<host> visit skips the
// bundle's foo.json preload, so the old resolveGameId() (a baked __GAME_ID__,
// else __OFFLINE_LEVEL__) answered null for every cloud game, and every one of
// them read and wrote the legacy leaderboards/globalHighScore with no daily
// board. The score init ran before the level loaded and was memoized for the
// page, the local cookie afc2019_highScore was one for the whole origin, and
// readRemoteHighScore pushed that merged local best up into whatever board was
// current: 2019-ps2-adb9fb3f, rando-b90175cc and ultra-bird-ea3a65d4 all hold
// the 68102600 foo-a9f37ed7 set first. The editor's PLAY bakes foo.json too,
// so any edited game scored onto 2028.Ai's board.
//
// Now the level loader's result names the game (loadLevel's gameId, off the
// record that loaded), the boot hands it to the scores (PluginBootScene ->
// startGameScores) before the title starts, the cookie is one per game, and
// no game id means no board at all. The cookie keeps only runs played on
// that device: it used to take the board's WORLD BEST on every visit, so a
// board cleaned of 68102600 was pushed straight back up by every browser
// that had seen it, onto today's board too. game.bundle.js is a vendored
// artifact patched by hand (README), so its score code is run here out of
// the bundle itself, under a fake Firebase, a cookie jar and a clock.

import { assert, assertEquals } from "@std/assert";
import { createRequire } from "node:module";
import {
  createLevelLoaderPlugin,
  gameIdForLevel as pluginGameIdForLevel,
} from "../static/phaser-plugins/level-loader.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const PLUGIN = "static/phaser-plugins/level-loader.js";

// The checkout may carry CRLF; every anchor below is written with LF.
const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

const bundle = await read(BUNDLE);

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** The bundle's text from one marker up to (not including) the next. */
function section(js: string, from: string, to: string): string {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start >= 0 && end > start, `no section ${from}`);
  return js.slice(start, end);
}

// ---- a cookie jar, a fake Firebase, a window ----------------------------------

class CookieJar {
  jar = new Map<string, string>();
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  set cookie(line: string) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    const expired = attrs.some((a) => a.trim() === "max-age=0");
    if (expired) this.jar.delete(name);
    else this.jar.set(name, value);
  }
}

type Deferred = { path: string; resolve: (v: unknown) => void };

/**
 * The compat SDK's surface the scores use: ref(path).once / transaction /
 * update. `hold` names paths whose reads stay out until released by hand;
 * they answer with the board as it was when they were made, as a slow read
 * does.
 */
function fakeFirebase(data: Record<string, unknown>, hold: string[] = []) {
  const reads: string[] = [];
  const writes: string[] = [];
  const held: Deferred[] = [];
  const db = {
    ref(path: string) {
      return {
        once() {
          reads.push(path);
          if (hold.includes(path)) {
            const then = data[path] ?? null;
            return new Promise((resolve) => {
              held.push({ path, resolve: () => resolve({ val: () => then }) });
            });
          }
          return Promise.resolve({ val: () => data[path] ?? null });
        },
        transaction(fn: (current: unknown) => unknown) {
          writes.push(path);
          const next = fn(data[path] ?? null);
          data[path] = next;
          return Promise.resolve({
            committed: true,
            snapshot: { val: () => next },
          });
        },
        update(value: Record<string, unknown>) {
          writes.push(path);
          data[path] = { ...(data[path] as object), ...value };
          return Promise.resolve();
        },
      };
    },
  };
  const database = Object.assign(() => db, {
    ServerValue: { TIMESTAMP: "TIMESTAMP" },
  });
  const ns = { apps: [{}], initializeApp() {}, database };
  return { ns, reads, writes, held, data };
}

// The score code of the bundle, as it is: the gameState helpers it uses, the
// whole gameIdentity + firebaseScores span, the labels, and the boot's
// gameForLevelResult. Everything it reaches for outside that span is a
// parameter, globalThis included, so each test gets a world of its own.
const SCORE_SRC = [
  "normalizeScore",
  "readCookie",
  "scoreCountsAsRecord",
  "setHighScore",
  "setDailyHighScore",
  "setScoreSyncStatus",
  "loadHighScore",
  "saveHighScore",
  "keepLocalBest",
].map((n) => functionSource(bundle, n)).join("\n") +
  section(
    bundle,
    "// ../2019-es7/src/gameIdentity.js",
    "// ../2019-es7/src/globals.js",
  ) +
  section(bundle, "var SYNC_COPY = {", "function getHighScoreSyncTint()") +
  functionSource(bundle, "gameForLevelResult");

const API = [
  "resolveGameId",
  "gameIdKnown",
  "getBoardPaths",
  "highScoreCookieKey",
  "expireLegacyHighScore",
  "initializeFirebaseScores",
  "setActiveGame",
  "startGameScores",
  "submitHighScore",
  "runWantsSubmit",
  "gameForLevelResult",
  "getDisplayedHighScore",
  "getDailyHighScore",
  "getHighScoreSyncText",
  "keepGodBest",
  "getGodHighScore",
  "getGodBestText",
] as const;

type Api = Record<typeof API[number], (...args: unknown[]) => unknown>;

interface World {
  api: Api;
  state: Record<string, unknown>;
  jar: CookieJar;
  global: Record<string, unknown>;
  events: { type: string; detail: unknown }[];
}

/** The Date the bundle's `new Date()` gets: the real one, read off `clock`. */
function clockedDate(clock: { at: number }) {
  return class extends Date {
    constructor(value?: number | string) {
      super(value ?? clock.at);
    }
  };
}

/**
 * One page load. `jar` carries a browser's cookies over from an earlier
 * visit; `clock` stands in for the wall clock (epoch ms, moved by hand).
 */
function world(opts: {
  firebase?: ReturnType<typeof fakeFirebase>;
  global?: Record<string, unknown>;
  exported?: boolean;
  jar?: CookieJar;
  clock?: { at: number };
} = {}): World {
  const state: Record<string, unknown> = {};
  const jar = opts.jar ?? new CookieJar();
  const events: { type: string; detail: unknown }[] = [];
  const global: Record<string, unknown> = {
    __FIREBASE_CONFIG__: { apiKey: "k", databaseURL: "https://db.test" },
    firebase: opts.firebase ? opts.firebase.ns : undefined,
    ...opts.global,
  };
  const window = {
    dispatchEvent(ev: { type: string; detail: unknown }) {
      events.push({ type: ev.type, detail: ev.detail });
      return true;
    },
  };
  class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const api = new Function(
    "globalThis",
    "gameState",
    "document",
    "window",
    "CustomEvent",
    "isExportedLevelApp",
    "Date",
    SCORE_SRC + "\nreturn { " + API.join(", ") + " };",
  )(
    global,
    state,
    jar,
    window,
    CustomEvent,
    () => !!opts.exported,
    opts.clock ? clockedDate(opts.clock) : Date,
  ) as Api;
  return { api, state, jar, global, events };
}

/** Let every queued promise reaction run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const today = new Date().toISOString().slice(0, 10);
const board = (id: string, day = today) => ({
  allTime: `leaderboards/${id}/allTime`,
  daily: `leaderboards/${id}/daily/${day}`,
  meta: `leaderboards/${id}/meta`,
});
const valueAt = (data: Record<string, unknown>, path: string) =>
  (data[path] as { value: number } | undefined)?.value;

// ---- the game identity ----------------------------------------------------------

Deno.test("the plugin, the bundle and build-level derive one game id per record", () => {
  const bundleId = new Function(
    section(
      bundle,
      "// ../2019-es7/src/gameIdentity.js",
      "  // The game this page is playing",
    ) + "\nreturn gameIdForLevel;",
  )() as (level: unknown) => string | null;
  const require = createRequire(import.meta.url);
  const harbor = require(
    "../packages/shmup-harbor/tools/build-level/lib/game-id.js",
  ) as { gameIdForLevel: (level: unknown) => string | null };
  const records = [
    { name: "foo" },
    { name: "Ramsie" },
    { name: "ramsie" },
    { name: "Ramsie!" },
    { name: "2019", gameId: "2019-ps2-adb9fb3f" },
    { name: "gs", gameId: " GS-710c41d3 " },
    { name: "  " },
    { gameId: "" },
    { name: "Ultra Bird" },
    { name: "日本語" },
    null,
    "foo",
  ];
  for (const r of records) {
    const want = pluginGameIdForLevel(r);
    assertEquals(bundleId(r), want, JSON.stringify(r));
    assertEquals(harbor.gameIdForLevel(r), want, JSON.stringify(r));
  }
  // The boards the five shmupX games already have, or are about to.
  assertEquals(pluginGameIdForLevel({ name: "foo" }), "foo-a9f37ed7");
  assertEquals(pluginGameIdForLevel({ name: "Ramsie" }), "ramsie-cae9647a");
  assert(
    pluginGameIdForLevel({ name: "ramsie" }) !== "ramsie-cae9647a",
    "Ramsie and ramsie are two games",
  );
  assertEquals(
    pluginGameIdForLevel({ name: "x", gameId: "rando-b90175cc" }),
    "rando-b90175cc",
  );
});

// ---- loadLevel says which game it loaded -----------------------------------------

const Plugin = createLevelLoaderPlugin({
  Plugins: {
    ScenePlugin: class {
      scene: unknown;
      constructor(scene: unknown) {
        this.scene = scene;
      }
    },
  },
});

/** A plugin whose texture and audio work is stubbed out: only flow is left. */
function quietPlugin() {
  const plugin = new Plugin(
    { cache: { json: { get: () => ({}) } } },
    null,
    "levelLoader",
  );
  Object.assign(plugin, {
    applyCustomCutin: () => false,
    applyUiAtlases: () => Promise.resolve(false),
    mergeAtlas: () => Promise.resolve(false),
    mergeEditorAtlas: () => Promise.resolve(false),
    applyStageBackgrounds: () => Promise.resolve(false),
    applyTitleImages: () => {},
    applyStoryImages: () => Promise.resolve(),
    mergeRecipe: (base: object) => ({ ...base }),
    _loadAudio: () => Promise.resolve({}),
  });
  return plugin;
}

async function onPage<T>(search: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const before = g.location;
  g.location = { search };
  try {
    return await fn();
  } finally {
    if (before === undefined) delete g.location;
    else g.location = before;
  }
}

Deno.test("an alias on the URL loads its key's record, and that record's game", () =>
  onPage("?level=2019", async () => {
    const records: Record<string, unknown> = {
      "shmupX/levels/2019-PS2": {
        name: "2019",
        gameId: "2019-ps2-adb9fb3f",
        enemylist: [["00"]],
      },
      "shmupX/levelAliases/2019": "2019-PS2",
    };
    const firebase = {
      apps: [{}],
      database: () => ({
        ref: (path: string) => ({
          once: () => Promise.resolve({ val: () => records[path] ?? null }),
        }),
      }),
    };
    const result = await quietPlugin().loadLevel({
      firebase,
      offlineLevel: null,
      audio: { enabled: false },
    });
    assertEquals(result.source, "firebase");
    assertEquals(result.levelName, "2019-PS2");
    assertEquals(result.gameId, "2019-ps2-adb9fb3f");
  }));

Deno.test("a cloud record with no gameId is named by its name, as an export names it", () =>
  onPage("?level=Ramsie", async () => {
    const plugin = quietPlugin();
    plugin.fetchLevel = () =>
      Promise.resolve({ name: "Ramsie", enemylist: [["00"]] });
    const result = await plugin.loadLevel({ audio: { enabled: false } });
    assertEquals(result.gameId, "ramsie-cae9647a");
  }));

Deno.test("the baked offline record is the game a plain visit plays", () =>
  onPage("", async () => {
    const result = await quietPlugin().loadLevel({
      offlineLevel: { name: "foo", enemylist: [["00"]] },
      audio: { enabled: false },
    });
    assertEquals(result.source, "offline");
    assertEquals(result.gameId, "foo-a9f37ed7");
  }));

Deno.test("the editor's PLAY is the game the editor saved, never the baked foo.json", () =>
  onPage("?editorPlay=1", async () => {
    const g = globalThis as Record<string, unknown>;
    // What main() bakes for any visit without ?level=, PLAY included.
    g.__OFFLINE_LEVEL__ = { name: "foo", enemylist: [["00"]] };
    try {
      const play = async (recipe: unknown) => {
        const plugin = quietPlugin();
        plugin.readEditorPlayRequest = () => ({ recipe, stageId: 0 });
        return await plugin.loadLevel({ audio: { enabled: false } });
      };
      const saved = await play({
        gameId: "gs-710c41d3",
        meta: { editorLevelName: "gs", editorGameKey: "gs" },
      });
      assertEquals(saved.source, "editor");
      assertEquals(saved.gameId, "gs-710c41d3");
      // The key the id belongs to rides through to the boot, which names the
      // board after it (gameForLevelResult).
      assertEquals(saved.recipe.meta.editorGameKey, "gs");
      // A game never saved has no id yet, so no board: not 2028.Ai's.
      const unsaved = await play({ meta: { editorLevelName: "draft" } });
      assertEquals(unsaved.gameId, null);
    } finally {
      delete g.__OFFLINE_LEVEL__;
    }
  }));

Deno.test("a level that did not load is no game", () =>
  onPage("?level=nobody", async () => {
    const plugin = quietPlugin();
    plugin.fetchLevel = () =>
      Promise.reject(new Error('Level "nobody" not found'));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await plugin.loadLevel({ audio: { enabled: false } });
      assertEquals(result.source, "fallback");
      assertEquals(result.gameId, null);
    } finally {
      console.warn = warn;
    }
  }));

Deno.test("the bundle's inlined loader names the game the way the plugin does", async () => {
  const plugin = await read(PLUGIN);
  for (
    const line of [
      'levelsPath: "shmupX/levels",',
      'aliasesPath: "shmupX/levelAliases",',
      "gameId: gameIdForLevel({ gameId: recipe.gameId }),",
      "gameId: gameIdForLevel(data),",
      "gameId: null,",
    ]
  ) {
    assert(plugin.includes(line), "the plugin lacks: " + line);
    assert(bundle.includes(line), "the bundle lacks: " + line);
  }
  // The bundle has the three identity functions once, in its gameIdentity
  // section, which the inlined loader shares; a second copy would be dead.
  assertEquals(bundle.split("function gameIdForLevel(").length, 2);
});

// ---- the scores wait for the game ----------------------------------------------

Deno.test("nothing reads or writes a board before the level names the game", async () => {
  const fb = fakeFirebase({});
  // A plain visit or a PLAY has foo.json baked; that is not yet the answer.
  const w = world({
    firebase: fb,
    global: { __OFFLINE_LEVEL__: { name: "foo" } },
  });
  assertEquals(w.api.resolveGameId(), null);
  assertEquals(w.api.gameIdKnown(), false);
  await w.api.initializeFirebaseScores();
  await w.api.submitHighScore(5000);
  await settle();
  assertEquals(fb.reads, []);
  assertEquals(fb.writes, []);
  assertEquals(w.jar.jar.size, 0, "no cookie is filed under no game");
});

Deno.test("a cloud game reads its own boards, never the legacy shared one", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({
    [gs.allTime]: { value: 1200 },
    [gs.daily]: { value: 300 },
    "leaderboards/globalHighScore": { value: 68102600 },
  });
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  assertEquals(fb.reads, [gs.allTime, gs.daily]);
  assertEquals(fb.writes, []);
  assertEquals(w.api.getDisplayedHighScore(), 1200);
  assertEquals(w.api.getDailyHighScore(), 300);
  assertEquals(w.api.getHighScoreSyncText(), "FIREBASE ONLINE");
  // The board's 1200 is the board's: this device never scored it.
  assertEquals(w.jar.jar.has("afc2019_highScore_gs-710c41d3"), false);
  // The lobby is told which game, and that it is settled.
  assertEquals(w.state.gameId, "gs-710c41d3");
  assertEquals(w.state.gameIdResolved, true);
  assertEquals(w.events, [{
    type: "shmupx:game-id",
    detail: { gameId: "gs-710c41d3" },
  }]);
});

Deno.test("one game's local best is not another's, and the legacy cookie is never read", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({ [gs.allTime]: { value: 100 } });
  const w = world({ firebase: fb });
  w.jar.jar.set("afc2019_highScore", "68102600");
  w.jar.jar.set("afc2019_highScore_foo-a9f37ed7", "500");
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  assertEquals(w.api.getDisplayedHighScore(), 100);
  // Nothing from another game was pushed up into this one's board.
  assertEquals(fb.writes, []);
  // The boot expires the shared cookie a stale bundle would push.
  w.api.expireLegacyHighScore();
  assertEquals(w.jar.jar.has("afc2019_highScore"), false);
  assertEquals(w.jar.jar.get("afc2019_highScore_foo-a9f37ed7"), "500");
});

Deno.test("this game's own offline best still goes up to its all-time board, not today's", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({ [gs.allTime]: { value: 100 } });
  const w = world({ firebase: fb });
  w.jar.jar.set("afc2019_highScore_gs-710c41d3", "900");
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  assertEquals(fb.writes, [gs.allTime, gs.meta]);
  assertEquals(valueAt(fb.data, gs.allTime), 900);
  assertEquals((fb.data[gs.meta] as { name: string }).name, "gs");
  assertEquals(w.api.getDisplayedHighScore(), 900);
  // The cookie keeps no date: the 900 may be any day's, so TODAY'S BEST,
  // with no run played today, stays empty.
  assertEquals(fb.data[gs.daily], undefined);
  assertEquals(w.api.getDailyHighScore(), 0);
  // A run played today does raise today's board, and leaves the best kept.
  fb.writes.length = 0;
  assertEquals(w.api.runWantsSubmit(300), true);
  await w.api.submitHighScore(300);
  await settle();
  assertEquals(fb.writes, [gs.allTime, gs.daily, gs.meta]);
  assertEquals(valueAt(fb.data, gs.daily), 300);
  assertEquals(valueAt(fb.data, gs.allTime), 900);
  assertEquals(w.api.getDailyHighScore(), 300);
  assertEquals(w.jar.jar.get("afc2019_highScore_gs-710c41d3"), "900");
});

Deno.test("the cookie keeps only runs played on this device, never the board's number", async () => {
  const foo = board("foo-a9f37ed7");
  const fb = fakeFirebase({ [foo.allTime]: { value: 68102600 } });
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "foo-a9f37ed7", name: "foo" });
  await settle();
  // WORLD BEST shows the board's, but the visit files none of it away.
  assertEquals(w.api.getDisplayedHighScore(), 68102600);
  assertEquals(w.jar.jar.has("afc2019_highScore_foo-a9f37ed7"), false);
  assertEquals(w.state.localHighScore, 0);
  assertEquals(fb.writes, []);
  // A run played here is kept, at what it scored.
  await w.api.submitHighScore(1500);
  await settle();
  assertEquals(w.jar.jar.get("afc2019_highScore_foo-a9f37ed7"), "1500");
  assertEquals(w.state.localHighScore, 1500);
  assertEquals(w.api.getDisplayedHighScore(), 68102600);
  // The board answering the submit with its own number does not change that.
  assertEquals(valueAt(fb.data, foo.allTime), 68102600);
  assertEquals(w.jar.jar.get("afc2019_highScore_foo-a9f37ed7"), "1500");
});

Deno.test("a cleaned board is not raised back by a device that only ever saw it", async () => {
  const foo = board("foo-a9f37ed7");
  const data: Record<string, unknown> = {
    [foo.allTime]: { value: 68102600 },
  };
  // Two browsers visit foo while its board holds the bogus 68102600: one
  // only looks, the other plays a 1500.
  const looker = world({ firebase: fakeFirebase(data) });
  await looker.api.startGameScores({ gameId: "foo-a9f37ed7", name: "foo" });
  const player = world({ firebase: fakeFirebase(data) });
  await player.api.startGameScores({ gameId: "foo-a9f37ed7", name: "foo" });
  await player.api.submitHighScore(1500);
  await settle();
  // The owner cleans the board.
  data[foo.allTime] = { value: 1000 };
  // The one that only looked raises nothing on its next visit.
  const back = fakeFirebase(data);
  const again = world({ firebase: back, jar: looker.jar });
  await again.api.startGameScores({ gameId: "foo-a9f37ed7", name: "foo" });
  await settle();
  assertEquals(back.writes, []);
  assertEquals(valueAt(data, foo.allTime), 1000);
  assertEquals(again.api.getDisplayedHighScore(), 1000);
  // The one that played puts up its own 1500, to the all-time board only.
  const mine = fakeFirebase(data);
  const replay = world({ firebase: mine, jar: player.jar });
  await replay.api.startGameScores({ gameId: "foo-a9f37ed7", name: "foo" });
  await settle();
  assertEquals(mine.writes, [foo.allTime, foo.meta]);
  assertEquals(valueAt(data, foo.allTime), 1500);
  assertEquals(replay.api.getDisplayedHighScore(), 1500);
  // Today's board has the 1500 from the run itself, and nothing from a boot.
  assertEquals(valueAt(data, foo.daily), 1500);
});

Deno.test("no game id is no board at all: local scores only, kept for the page", async () => {
  const fb = fakeFirebase({
    "leaderboards/globalHighScore": { value: 68102600 },
  });
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: null });
  assertEquals(w.api.getBoardPaths(), {
    allTime: null,
    daily: null,
    meta: null,
  });
  assertEquals(w.api.getHighScoreSyncText(), "LOCAL CACHE ONLY");
  await w.api.submitHighScore(5000);
  await settle();
  assertEquals(fb.reads, []);
  assertEquals(fb.writes, []);
  assertEquals(w.jar.jar.size, 0);
  assertEquals(w.api.getDisplayedHighScore(), 5000);
  assertEquals(w.state.gameId, null);
  assertEquals(w.state.gameIdResolved, true);
});

Deno.test("the __FIREBASE_DATABASE_PATH__ override still names the board", async () => {
  const fb = fakeFirebase({ "custom/board": { value: 42 } });
  const w = world({
    firebase: fb,
    global: { __FIREBASE_DATABASE_PATH__: "/custom/board/" },
  });
  await w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  assertEquals(fb.reads, ["custom/board"]);
  assertEquals(w.api.getDisplayedHighScore(), 42);
});

Deno.test("an exported app's baked id outranks the level's, and warms up once", async () => {
  const rando = board("rando-b90175cc");
  const fb = fakeFirebase({ [rando.allTime]: { value: 7 } });
  const w = world({ firebase: fb, global: { __GAME_ID__: "rando-b90175cc" } });
  // create2028Game's early warm-up, then the boot naming the game.
  assertEquals(w.api.resolveGameId(), "rando-b90175cc");
  const early = w.api.initializeFirebaseScores();
  w.api.startGameScores({ gameId: "something-else", name: "rando" });
  await early;
  await settle();
  assertEquals(fb.reads, [rando.allTime, rando.daily], "one load, not two");
  assertEquals(w.api.getDisplayedHighScore(), 7);
  assertEquals(w.state.gameId, "rando-b90175cc");
});

Deno.test("a read still out for the last game lands nowhere once the page changes games", async () => {
  const gs = board("gs-710c41d3");
  const rando = board("rando-b90175cc");
  const fb = fakeFirebase(
    { [gs.allTime]: { value: 999 }, [rando.allTime]: { value: 5 } },
    [gs.allTime],
  );
  const w = world({ firebase: fb });
  w.jar.jar.set("afc2019_highScore_gs-710c41d3", "999");
  w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  assertEquals(fb.held.length, 1);
  await w.api.startGameScores({ gameId: "rando-b90175cc" });
  await settle();
  assertEquals(w.api.getDisplayedHighScore(), 5);
  fb.held[0].resolve(null);
  await settle();
  // gs's answer did not overwrite rando's numbers, nor push anything up.
  assertEquals(w.api.getDisplayedHighScore(), 5);
  assertEquals(fb.writes, []);
  assertEquals(w.state.gameId, "rando-b90175cc");
});

Deno.test("a run that beats today's board, not the all-time one, still raises today's", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({
    [gs.allTime]: { value: 5000 },
    [gs.daily]: { value: 200 },
  });
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  assertEquals(w.api.runWantsSubmit(300), true);
  assertEquals(w.api.runWantsSubmit(100), false);
  assertEquals(w.api.runWantsSubmit(5000), true);
  await w.api.submitHighScore(300);
  await settle();
  assertEquals((fb.data[gs.daily] as { value: number }).value, 300);
  assertEquals((fb.data[gs.allTime] as { value: number }).value, 5000);
  assertEquals(w.api.getDailyHighScore(), 300);
  assertEquals(w.api.getDisplayedHighScore(), 5000);
  // The cookie has this device's 300, not the board's 5000, and a lower
  // run after it does not lower that.
  assertEquals(w.jar.jar.get("afc2019_highScore_gs-710c41d3"), "300");
  await w.api.submitHighScore(250);
  await settle();
  assertEquals(w.jar.jar.get("afc2019_highScore_gs-710c41d3"), "300");
  assertEquals(w.api.getDailyHighScore(), 300);
});

Deno.test("past UTC midnight TODAY'S BEST is the new day's board, never yesterday's", async () => {
  const clock = { at: Date.parse("2026-10-18T23:50:00Z") };
  const before = board("gs-710c41d3", "2026-10-18");
  const after = board("gs-710c41d3", "2026-10-19");
  const fb = fakeFirebase({
    [before.allTime]: { value: 10000 },
    [before.daily]: { value: 5000 },
  }, [after.daily]);
  const w = world({ firebase: fb, clock });
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  assertEquals(w.api.getDailyHighScore(), 5000);
  assertEquals(w.api.runWantsSubmit(3000), false);
  // The title is left open across midnight.
  clock.at = Date.parse("2026-10-19T00:30:00Z");
  assertEquals(
    w.api.getDailyHighScore(),
    0,
    "yesterday's 5000 shown as today's",
  );
  assertEquals(w.api.getDailyHighScore(), 0);
  // The new day's board is read once, however often the title asks.
  assertEquals(fb.reads, [before.allTime, before.daily, after.daily]);
  // The day's best run so far is submitted, though yesterday's was higher.
  assertEquals(w.api.runWantsSubmit(3000), true);
  await w.api.submitHighScore(3000);
  await settle();
  assertEquals(valueAt(fb.data, after.daily), 3000);
  assertEquals(valueAt(fb.data, before.daily), 5000);
  assertEquals(w.api.getDailyHighScore(), 3000);
  // The read still out answers with the board from before that run: it
  // does not take TODAY'S BEST back down.
  fb.held[0].resolve(null);
  await settle();
  assertEquals(w.api.getDailyHighScore(), 3000);
  assertEquals(w.api.runWantsSubmit(2000), false);
});

Deno.test("a page open past midnight shows the new day's board once it is read", async () => {
  const clock = { at: Date.parse("2026-10-18T23:50:00Z") };
  const before = board("gs-710c41d3", "2026-10-18");
  const after = board("gs-710c41d3", "2026-10-19");
  const fb = fakeFirebase({
    [before.allTime]: { value: 10000 },
    [before.daily]: { value: 5000 },
    [after.daily]: { value: 4000 },
  });
  const w = world({ firebase: fb, clock });
  await w.api.startGameScores({ gameId: "gs-710c41d3", name: "gs" });
  await settle();
  clock.at = Date.parse("2026-10-19T00:30:00Z");
  // A run ending just past midnight is measured against today's board, and
  // until that answers, any run is the day's best so far.
  assertEquals(w.api.runWantsSubmit(3000), true);
  await settle();
  assertEquals(w.api.getDailyHighScore(), 4000);
  assertEquals(w.api.runWantsSubmit(3000), false);
  assertEquals(w.api.runWantsSubmit(4500), true);
  assertEquals(fb.writes, []);
});

Deno.test("an editor PLAY names its board after the key its gameId belongs to", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({});
  const w = world({
    firebase: fb,
    global: { __OFFLINE_LEVEL__: { name: "foo" } },
  });
  // gs, loaded in the editor, with a copy's name typed over it in the name
  // box: the board is gs's, so its meta says gs, not the free text.
  const game = w.api.gameForLevelResult({
    source: "editor",
    gameId: "gs-710c41d3",
    recipe: { meta: { editorLevelName: "gs-hard", editorGameKey: "gs" } },
  });
  assertEquals(game, { gameId: "gs-710c41d3", name: "gs" });
  await w.api.startGameScores(game);
  await w.api.submitHighScore(100);
  await settle();
  assert(fb.writes.every((p) => p.startsWith("leaderboards/gs-710c41d3/")));
  assertEquals((fb.data[gs.meta] as { name: string }).name, "gs");
});

Deno.test("an editor PLAY with an id but no key leaves its board's name alone", async () => {
  const gs = board("gs-710c41d3");
  const fb = fakeFirebase({ [gs.meta]: { name: "gs" } });
  const w = world({
    firebase: fb,
    global: { __OFFLINE_LEVEL__: { name: "foo" } },
  });
  // A recipe from before the editor sent the key: the name box is no
  // evidence of which game the id is, so nothing is guessed from it.
  const game = w.api.gameForLevelResult({
    source: "editor",
    gameId: "gs-710c41d3",
    recipe: { meta: { editorLevelName: "Ramsie" } },
  });
  assertEquals(game, { gameId: "gs-710c41d3", name: null });
  await w.api.startGameScores(game);
  await w.api.submitHighScore(100);
  await settle();
  assertEquals(fb.writes, [gs.allTime, gs.daily]);
  assertEquals((fb.data[gs.meta] as { name: string }).name, "gs");
  // A PLAY with no id has no board; the name box is all it has to go by.
  assertEquals(
    w.api.gameForLevelResult({
      source: "editor",
      gameId: null,
      recipe: { meta: { editorLevelName: "draft", editorGameKey: "gs" } },
    }),
    { gameId: null, name: "draft" },
  );
});

Deno.test("each source names its board the way it names the game", () => {
  const w = world({ global: { __OFFLINE_LEVEL__: { name: "foo" } } });
  assertEquals(
    w.api.gameForLevelResult({
      source: "firebase",
      levelName: "2019-PS2",
      gameId: "2019-ps2-adb9fb3f",
    }),
    { gameId: "2019-ps2-adb9fb3f", name: "2019-PS2" },
  );
  assertEquals(
    w.api.gameForLevelResult({
      source: "offline",
      levelName: "foo",
      gameId: "foo-a9f37ed7",
    }),
    { gameId: "foo-a9f37ed7", name: "foo" },
  );
  assertEquals(
    w.api.gameForLevelResult({
      source: "fallback",
      levelName: "nobody",
      gameId: null,
    }),
    { gameId: null, name: null },
  );
});

Deno.test("a god run on the hosted page still submits nothing", async () => {
  const fb = fakeFirebase({});
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  w.state.godFlg = true;
  await w.api.submitHighScore(100);
  await settle();
  assertEquals(fb.writes, []);
});

// ---- the boot and the scenes ---------------------------------------------------------

Deno.test("the boot names the game from the loaded level before the title starts", () => {
  const boot = section(
    bundle,
    "var PluginBootScene = class extends BootScene {",
    "var ScriptedTitleScene",
  );
  const named = boot.indexOf("startGameScores(gameForLevelResult(result));");
  assert(named > 0, "PluginBootScene never names the game");
  assert(
    named < boot.indexOf("game.scene.start(nextScene);"),
    "named after the title starts",
  );
  const create = functionSource(bundle, "create2028Game");
  assert(
    create.includes("expireLegacyHighScore();"),
    "the shared cookie is not expired",
  );
  assert(
    /if \(resolveGameId\(\)\) \{\s*initializeFirebaseScores\(\)/.test(create),
    "create2028Game loads scores before the game is known",
  );
  // Both end-of-run scenes gate on the same rule, which knows about today.
  assertEquals(
    bundle.split("if (runWantsSubmit(gameState.score)) {").length,
    3,
  );
  // And keep a new record through keepLocalBest. They used to set the shown
  // best and call saveHighScore, which filed whatever was shown (the board's
  // WORLD BEST included) as this device's.
  assertEquals(
    bundle.split("keepLocalBest(Number(gameState.score || 0));").length,
    3,
  );
  assert(
    !bundle.includes("gameState.highScore = Number(gameState.score || 0);"),
    "a scene still files the shown best as the local one",
  );
  // Every setHighScore says which of the two it sets; nothing folds the
  // board's number into the local best any more.
  const calls = [...bundle.matchAll(/(?<!function )\bsetHighScore\(.*\);/g)];
  assert(calls.length >= 4, "setHighScore calls not found");
  for (const [call] of calls) {
    assert(/, "(local|remote)"\);$/.test(call), "unsourced: " + call);
  }
  assert(
    !bundle.includes('"leaderboards/globalHighScore"'),
    "the legacy board is still named",
  );
  assert(
    !bundle.includes('cookieKey = "afc2019_highScore"'),
    "the shared cookie is still the default",
  );
});

// ---- TODAY'S GOD BEST -------------------------------------------------------------
//
// A run under ?god=1 — the editor's GOD MODE, the Saturn TEST PLAY panel's
// MUTEKI — reaches no board and never the local best, so until now nothing it
// scored was shown anywhere. It has a best of its own: the highest score
// reached while the flag was on, this device's and this UTC day's, in a cookie
// of its own per game.

Deno.test("a god run keeps today's god best on this device, and moves nothing else", async () => {
  const fb = fakeFirebase({});
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  w.state.godFlg = true;
  // The HUD hands it the score as it climbs.
  assertEquals(w.api.keepGodBest(120), 120);
  assertEquals(w.api.keepGodBest(500), 500);
  // Never lowered.
  assertEquals(w.api.keepGodBest(300), 500);
  assertEquals(w.api.getGodHighScore(), 500);
  assertEquals(w.api.getGodBestText(), "TODAY'S GOD BEST 500");
  // Its own cookie, dated, and nothing on the boards or in the local best.
  assertEquals(
    w.jar.jar.get("afc2019_godHighScore_gs-710c41d3"),
    `${today}%3A500`,
  );
  assertEquals(w.jar.jar.has("afc2019_highScore_gs-710c41d3"), false);
  assertEquals(fb.writes, []);
  assertEquals(w.api.getDisplayedHighScore(), 0);
  assertEquals(w.api.getDailyHighScore(), 0);
  // The end of the run submits as before: nothing, for a god run.
  await w.api.submitHighScore(500);
  await settle();
  assertEquals(fb.writes, []);
  assertEquals(w.api.getDisplayedHighScore(), 0);
});

Deno.test("a mortal run never moves the god best", async () => {
  const fb = fakeFirebase({});
  const w = world({ firebase: fb });
  await w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  assertEquals(w.api.keepGodBest(900), 0);
  assertEquals(w.api.getGodHighScore(), 0);
  assertEquals(w.jar.jar.has("afc2019_godHighScore_gs-710c41d3"), false);
});

Deno.test("the god best is one game's, read back on the next visit, and gone with the UTC day", async () => {
  const jar = new CookieJar();
  const clock = { at: Date.UTC(2026, 9, 31, 20, 0, 0) };
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const first = world({ firebase: fakeFirebase({}), jar, clock });
  await first.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  first.state.godFlg = true;
  first.api.keepGodBest(500);
  assertEquals(
    jar.jar.get("afc2019_godHighScore_gs-710c41d3"),
    `${day(clock.at)}%3A500`,
  );
  // The same browser, back the same day: the best is read off the cookie
  // before any run, and shown.
  const again = world({ firebase: fakeFirebase({}), jar, clock });
  await again.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  again.state.godFlg = true;
  assertEquals(again.api.getGodHighScore(), 500);
  assertEquals(again.api.keepGodBest(400), 500);
  // Another game has a best of its own.
  const other = world({ firebase: fakeFirebase({}), jar, clock });
  await other.api.startGameScores({ gameId: "foo-a9f37ed7" });
  await settle();
  other.state.godFlg = true;
  assertEquals(other.api.getGodHighScore(), 0);
  other.api.keepGodBest(50);
  assertEquals(
    jar.jar.get("afc2019_godHighScore_foo-a9f37ed7"),
    `${day(clock.at)}%3A50`,
  );
  assertEquals(
    jar.jar.get("afc2019_godHighScore_gs-710c41d3"),
    `${day(clock.at)}%3A500`,
  );
  // Past UTC midnight the page left open shows the new day's: nothing yet.
  clock.at += 5 * 60 * 60 * 1000;
  assertEquals(again.api.getGodHighScore(), 0);
  assertEquals(again.api.getGodBestText(), "TODAY'S GOD BEST 0");
  // And the first god score of the new day writes yesterday's over.
  assertEquals(again.api.keepGodBest(70), 70);
  assertEquals(
    jar.jar.get("afc2019_godHighScore_gs-710c41d3"),
    `${day(clock.at)}%3A70`,
  );
  // A fresh visit the day after reads yesterday's cookie as 0.
  const tomorrow = world({
    firebase: fakeFirebase({}),
    jar,
    clock: { at: clock.at + 24 * 60 * 60 * 1000 },
  });
  await tomorrow.api.startGameScores({ gameId: "foo-a9f37ed7" });
  await settle();
  assertEquals(tomorrow.api.getGodHighScore(), 0);
});

Deno.test("a game with no id keeps its god best for the page alone", async () => {
  const w = world({ firebase: fakeFirebase({}) });
  await w.api.startGameScores({ gameId: null, name: null });
  await settle();
  w.state.godFlg = true;
  assertEquals(w.api.keepGodBest(500), 500);
  assertEquals(w.api.getGodHighScore(), 500);
  assertEquals(w.jar.cookie, "");
});

Deno.test("an exported app's god run keeps the god best beside the local best it already kept", async () => {
  const fb = fakeFirebase({});
  const w = world({ firebase: fb, exported: true });
  await w.api.startGameScores({ gameId: "gs-710c41d3" });
  await settle();
  w.state.godFlg = true;
  assertEquals(w.api.keepGodBest(500), 500);
  await w.api.submitHighScore(500);
  await settle();
  // GOD MODE rides alongside in an export (build_level_export_root_test): the
  // run is this device's best, as before, and still goes to no board.
  assertEquals(w.jar.jar.get("afc2019_highScore_gs-710c41d3"), "500");
  assertEquals(
    w.jar.jar.get("afc2019_godHighScore_gs-710c41d3"),
    `${today}%3A500`,
  );
  assertEquals(fb.writes, []);
  assertEquals(w.api.getDisplayedHighScore(), 500);
  assertEquals(w.api.getGodHighScore(), 500);
});
