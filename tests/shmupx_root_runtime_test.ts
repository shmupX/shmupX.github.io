// The runtime side of shmupX's own subtree of the database it shares with cmg.
//
// shmupX's games (levels/, levelAliases/) and its character library
// (characters/, atlases/) live under shmupX/ (lib/rtdb-root.ts); the
// root-level copies are cmg's, and every other node (leaderboards, sprites,
// the export queue...) stays at the root. Each surface spells that root its
// own way: the level loader in its ref() paths (tests/level_subdomain_test.ts
// pins those), the game pages as two globals next to their Firebase config,
// EXTRACT MODE on the database URL its callers pass it, the Android forge and
// the eShop 2019 archive on their REST paths. These are the ones the runtime
// owns. Nothing here touches the network.

import { assert, assertEquals } from "@std/assert";
import { CHARACTERS_MODULE } from "../lib/game-page.ts";
import { cloudLevel } from "../scripts/2019/build-zip.ts";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

type Rec = Record<string, unknown>;
const DB = "https://evil-invaders-default-rtdb.firebaseio.com";

// ---- the game pages' globals ----------------------------------------------------

Deno.test("firebase-config.js keeps the database URL at the root and names the subtree", async () => {
  const window: Rec = {};
  new Function("window", await read("static/firebase-config.js"))(window);
  const config = window.__FIREBASE_CONFIG__ as { databaseURL: string };
  // The SDK refuses a databaseURL with a path: the root goes on the paths.
  assertEquals(config.databaseURL, DB);
  assertEquals(window.__RTDB_ROOT__, "shmupX");
  assertEquals(window.__CHARACTERS_DB__, `${DB}/shmupX`);
});

Deno.test("the game page names shmupX's characters even where the config did not load", () => {
  const run = (g: Rec) => {
    new Function("globalThis", "location", CHARACTERS_MODULE)(g, {
      origin: "https://shmupx.test",
    });
    return g;
  };
  const bare = run({});
  assertEquals(bare.__CHARACTERS_MODULE__, "https://shmupx.test/characters");
  assertEquals(bare.__CHARACTERS_DB__, `${DB}/shmupX`);
  // A config that loaded, with a trailing slash on its URL.
  assertEquals(
    run({ __FIREBASE_CONFIG__: { databaseURL: "https://db.test/" } })
      .__CHARACTERS_DB__,
    "https://db.test/shmupX",
  );
  // What firebase-config.js (or a test page) already set is left alone.
  assertEquals(
    run({ __CHARACTERS_DB__: "https://elsewhere.test/x" }).__CHARACTERS_DB__,
    "https://elsewhere.test/x",
  );
});

// ---- EXTRACT MODE --------------------------------------------------------------

interface Extract {
  dbURL(): string;
  libraryURL(db?: string): string;
  publishRecord(opts: Rec): Promise<string | null>;
}

/** extract-mode.js under a window just real enough for its load-time arming. */
async function loadExtract(win: Rec, fetch: unknown): Promise<Extract> {
  const src = await read("static/phaser-plugins/extract-mode.js");
  const noop = () => {};
  const document = {
    getElementById: () => null,
    body: { appendChild: noop },
    readyState: "complete",
    addEventListener: noop,
    createElement: () => ({
      style: {},
      appendChild: noop,
      addEventListener: noop,
    }),
  };
  Object.assign(win, {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    document,
    location: {
      pathname: "/games/2028-ai/",
      search: "",
      origin: "http://localhost",
    },
    navigator: { onLine: true },
  });
  win.parent = win;
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  new Function(
    "window",
    "document",
    "MutationObserver",
    "navigator",
    "localStorage",
    "fetch",
    src,
  )(win, document, MutationObserver, win.navigator, {}, fetch);
  return win.ShmupExtract as Extract;
}

Deno.test("EXTRACT MODE publishes into shmupX's library from the plain database URL", async () => {
  const calls: { url: string; method: string; body?: Rec }[] = [];
  const fetch = (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    // GET: no character of that name yet. PATCH: accepted.
    return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
  };
  const EX = await loadExtract(
    { __FIREBASE_CONFIG__: { databaseURL: DB } },
    fetch,
  );
  assertEquals(EX.dbURL(), DB, "the database itself is still the root");
  const saved = await EX.publishRecord({
    name: "akuma",
    // The editor's call, which passes FIREBASE_CONFIG.databaseURL as it always did.
    db: DB,
    record: { name: "akuma", texture: ["akuma0.png"] },
    atlasJson: { frames: { "akuma0.png": {} } },
    canvas: { toDataURL: () => "data:image/png;base64,AA==" },
    confirmOverwrite: () => true,
  });
  assertEquals(saved, "akuma");
  assertEquals(calls.map((c) => [c.method, c.url]), [
    ["GET", `${DB}/shmupX/characters/akuma.json`],
    ["PATCH", `${DB}/shmupX/.json`],
  ]);
  // One atomic update at the subtree, so its keys stay relative.
  assertEquals(Object.keys(calls[1].body!).sort(), [
    "atlases/akuma",
    "characters/akuma",
  ]);
});

Deno.test("EXTRACT MODE's library URL takes its root once, whatever it was handed", async () => {
  const EX = await loadExtract({}, () => Promise.reject(new Error("offline")));
  // An export with no leaderboard stages no config: the default database.
  assertEquals(EX.libraryURL(), `${DB}/shmupX`);
  assertEquals(EX.libraryURL("https://db.test/"), "https://db.test/shmupX");
  assertEquals(
    EX.libraryURL("https://db.test/shmupX"),
    "https://db.test/shmupX",
  );
  const rooted = await loadExtract(
    { __RTDB_ROOT__: "shmupX" },
    () => Promise.reject(new Error("offline")),
  );
  assertEquals(rooted.libraryURL("https://db.test"), "https://db.test/shmupX");
});

// ---- the Android forge ----------------------------------------------------------

Deno.test("the in-app forge reads shmupX's levels, and a typed alias builds its key", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const start = bundle.indexOf("// ../2019-es7/src/forge/fetch-level.js");
  const end = bundle.indexOf("// ../2019-es7/src/forge/merge-atlas.js", start);
  assert(start > 0 && end > start, "no forge fetch-level in the bundle");
  const tree: Record<string, unknown> = {
    [`${DB}/shmupX/levels/2019-PS2.json`]: {
      name: "2019",
      enemylist: [["00"]],
    },
    [`${DB}/shmupX/levelAliases/2019.json`]: "2019-PS2",
    // cmg's root copy, which the forge must never build.
    [`${DB}/levels/2019.json`]: { name: "cmg's", enemylist: [["00"]] },
  };
  const urls: string[] = [];
  const fetch = (url: string) => {
    urls.push(url);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(tree[url] ?? null),
    });
  };
  const fetchLevel = new Function(
    "fetch",
    bundle.slice(start, end) + "\nreturn fetchLevel;",
  )(fetch) as (name: string) => Promise<Rec>;
  assertEquals((await fetchLevel("2019")).name, "2019");
  assertEquals(urls, [
    `${DB}/shmupX/levels/2019.json`,
    `${DB}/shmupX/levelAliases/2019.json`,
    `${DB}/shmupX/levels/2019-PS2.json`,
  ]);
  let code = "";
  await fetchLevel("nobody").catch((
    err: { code: string },
  ) => (code = err.code));
  assertEquals(code, "LEVEL_NOT_FOUND");
});

// ---- the eShop 2019 archive ------------------------------------------------------

Deno.test("the 2019 archive refreshes from shmupX's 2019-PS2, by key or by alias", async () => {
  const tree: Record<string, unknown> = {
    [`${DB}/shmupX/levels/2019-PS2.json`]: {
      name: "2019",
      enemylist: [["00"]],
    },
    [`${DB}/shmupX/levelAliases/2019.json`]: "2019-PS2",
    [`${DB}/levels/2019-PS2.json`]: { name: "cmg's", enemylist: [["00"]] },
  };
  const urls: string[] = [];
  const get = (url: string) => {
    urls.push(url);
    return Promise.resolve(tree[url] ?? null);
  };
  const direct = await cloudLevel("2019-PS2", get);
  assertEquals([direct.key, direct.record.name], ["2019-PS2", "2019"]);
  assertEquals(urls, [`${DB}/shmupX/levels/2019-PS2.json`]);
  urls.length = 0;
  const aliased = await cloudLevel("2019", get);
  assertEquals([aliased.key, aliased.record.name], ["2019-PS2", "2019"]);
  assertEquals(urls, [
    `${DB}/shmupX/levels/2019.json`,
    `${DB}/shmupX/levelAliases/2019.json`,
    `${DB}/shmupX/levels/2019-PS2.json`,
  ]);
  let missing = "";
  await cloudLevel("nobody", get).catch((
    err: Error,
  ) => (missing = err.message));
  assert(missing.includes("shmupX/levels/nobody"), missing);
});

// ---- the netplay lobby ------------------------------------------------------------

Deno.test("the netplay lobby lists runs only once the boot has named the game", async () => {
  let src = await read("static/phaser-plugins/netplay-lobby.js");
  const seen: Rec[] = [];
  const g = globalThis as Rec;
  g.__lobbyTestSeen = seen;
  const mod = "data:text/javascript," + encodeURIComponent(
    "export function netplay(opts) { globalThis.__lobbyTestSeen.push(opts); return Promise.resolve(null); }",
  );
  src = src.replace("'/netplay/shmupx-netplay.js'", JSON.stringify(mod));
  const state: Rec = {};
  const win = Object.assign(new EventTarget(), { __GAME_STATE__: state });
  try {
    new Function("window", "location", "document", src)(
      win,
      { search: "?online=1" },
      { body: {}, addEventListener() {} },
    );
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(seen, [], "the lobby opened before the game was known");
    // What the bundle's setActiveGame does once the level resolves.
    state.gameId = "gs-710c41d3";
    state.gameIdResolved = true;
    win.dispatchEvent(
      new CustomEvent("shmupx:game-id", { detail: { gameId: "gs-710c41d3" } }),
    );
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(seen.map((o) => o.gameId), ["gs-710c41d3"]);
  } finally {
    delete g.__lobbyTestSeen;
  }
});
