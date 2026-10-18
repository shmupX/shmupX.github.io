// The level editor's half of the shmupX/ subtree.
//
// The database is shared with cmg, which keeps every node at the root; shmupX
// keeps levels, levelAliases, characters and atlases under shmupX/ and
// everything else where it was (lib/rtdb-root.ts). The editor is one big
// classic script with an inline FIREBASE_CONFIG, so it gets neither
// /firebase-config.js nor lib/rtdb-root.ts: it spells the root itself, reads
// levels through LEVEL_LOADER_DEFAULTS.levelsPath (rooted in the plugin), and
// reads the character library under __CHARACTERS_DB__ — the base the deployed
// characters module and its <character-editor> use too.
//
// The behaviour tests below run the editor's own functions, cut out of the
// page, against a stand-in database: a typed "2019" opens 2019-PS2 and saves
// back to it, the record's gameId rides gameData into PLAY's recipe, and a
// game without one still mints on its first save.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { rtdbPath as libRtdbPath, SCOPED_NODES } from "../lib/rtdb-root.ts";

const EDITOR = "static/editor/index.html";
const DB_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
// What level-loader.js DEFAULTS hands the editor through the module bridge
// (pinned against the plugin and the bundle in level_subdomain_test.ts).
const LEVEL_LOADER_DEFAULTS = {
  levelsPath: "shmupX/levels",
  aliasesPath: "shmupX/levelAliases",
};

const html = (await Deno.readTextFile(new URL(`../${EDITOR}`, import.meta.url)))
  .replaceAll("\r\n", "\n");

/** One top-level function of the editor's script, by name, as source text. */
function editorFunction(name: string): string {
  const m = new RegExp(`\\n {8}(async )?function ${name}\\(`).exec(html);
  assert(m, `no ${name} in ${EDITOR}`);
  const start = m.index + 1;
  const end = html.indexOf("\n        }\n", start);
  assert(end > start, `${name} does not close`);
  return html.slice(start, end + 10);
}

type Scope = Record<string, unknown>;

/** Deno's own dialogs wait on stdin: a test must answer them or fail. */
const DIALOGS = new Set(["alert", "confirm", "prompt"]);

/**
 * The editor's functions as live code, their free names answered by `scope`
 * (writes land there too), then by the real globals, and anything else by a
 * no-op — the render calls, the toasts, the viewer bridge. A dialog the
 * scope does not answer throws instead of hanging the run.
 */
function live(names: string[], scope: Scope): Scope {
  const noop = () => undefined;
  const proxy = new Proxy(scope, {
    has: (t, k) =>
      typeof k === "string" &&
      (k in t || !(k in globalThis) || DIALOGS.has(k)),
    get: (t, k) => {
      if (typeof k !== "string") return undefined;
      if (k in t) return t[k];
      if (DIALOGS.has(k)) {
        return (m: unknown) => {
          throw new Error(`unexpected ${k}(): ${m}`);
        };
      }
      return k in globalThis ? (globalThis as Scope)[k] : noop;
    },
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  });
  const body = names.map((n) => editorFunction(n)).join("\n");
  const fns = new Function(
    "scope",
    `with (scope) { ${body}\nreturn { ${names.join(", ")} }; }`,
  )(proxy) as Scope;
  Object.assign(scope, fns);
  return scope;
}

/** A Realtime Database stand-in over a plain tree, for the SDK calls used. */
function fakeDb(
  tree: Scope,
  opts: { fail?: boolean; failWrites?: boolean } = {},
) {
  const writes: { path: string; value: unknown; op: "update" | "set" }[] = [];
  const at = (path: string) =>
    path.split("/").filter(Boolean).reduce<unknown>(
      (
        node,
        k,
      ) => (node && typeof node === "object" ? (node as Scope)[k] : undefined),
      tree,
    );
  const ref = (path: string) => {
    const write = (op: "update" | "set") => (value: unknown) => {
      if (opts.failWrites) {
        return Promise.reject(new Error("permission denied"));
      }
      writes.push({ path, value, op });
      return Promise.resolve();
    };
    const r = {
      once: () =>
        opts.fail ? Promise.reject(new Error("offline")) : Promise.resolve({
          val: () => at(path) ?? null,
          exists: () => at(path) != null,
        }),
      limitToFirst: () => r,
      update: write("update"),
      set: write("set"),
    };
    return r;
  };
  return { db: { ref }, writes };
}

/** The shmupX subtree as the migration seeds it, cut down to what is read. */
const seeded = (): Scope => ({
  shmupX: {
    levels: {
      "2019-PS2": {
        name: "2019",
        gameId: "2019-ps2-adb9fb3f",
        enemylist: [[0, 0, 0]],
        enemyData: { enemyA: { name: "zako" } },
      },
      foo: { name: "foo", gameId: "foo-a9f37ed7", enemylist: [[0]] },
      // A record from before gameId existed.
      legacy: { name: "legacy", enemylist: [[0]] },
    },
    levelAliases: { "2019": "2019-PS2", streetfighter: "2019-PS2" },
  },
  // cmg's copies at the root, which shmupX must never read.
  levels: {
    "2019": { name: "cmg's 2019", gameId: "cmg-2019", enemylist: [[1]] },
  },
});

type FakeEl = {
  value: string;
  textContent: string;
  disabled: boolean;
  style: Record<string, string>;
};

function fakeDocument(fields: Record<string, string>) {
  const el = (value = ""): FakeEl => ({
    value,
    textContent: "",
    disabled: false,
    style: {},
  });
  const els: Record<string, FakeEl> = {};
  for (const [id, value] of Object.entries(fields)) els[id] = el(value);
  return { getElementById: (id: string) => (els[id] ??= el()) };
}

const sanitizeLevelName = (name: string) =>
  name ? name.replace(/[.#$/\[\]]/g, "_").trim() : null;

/** The functions a cloud SAVE runs, in the order the page defines them. */
const SAVE_FNS = [
  "mintGameId",
  "ensureGameId",
  "levelAliasTarget",
  "levelKeyTaken",
  "cloudSaveTarget",
  "cloudSaveKey",
  "cloudRecordName",
  "saveToFirebase",
];

/**
 * A scope that runs the real SAVE GAME (plus `extra` functions) against a
 * fake of `tree`, the name box holding `nameBox`. Every confirm() is
 * recorded and answered by `answer`; alerts are recorded.
 */
function cloudSave(
  tree: Scope,
  nameBox: string,
  opts: {
    answer?: boolean;
    extra?: string[];
    scope?: Scope;
    db?: ReturnType<typeof fakeDb>;
  } = {},
) {
  const fake = opts.db ?? fakeDb(tree);
  const document = fakeDocument({ "firebase-level-name": nameBox });
  const alerts: string[] = [];
  const asked: string[] = [];
  const s = live([...SAVE_FNS, ...(opts.extra ?? [])], {
    firebaseDb: fake.db,
    firebaseStorage: null,
    firebase: { database: { ServerValue: { TIMESTAMP: 0 } } },
    LEVEL_LOADER_DEFAULTS,
    sanitizeLevelName,
    document,
    gameData: {},
    cloudGameKey: "",
    enemyData: {},
    bossData: {},
    playerData: {},
    audioURLs: {},
    console: { warn: () => {}, error: () => {} },
    confirm: (q: string) => (asked.push(q), opts.answer ?? true),
    alert: (m: string) => alerts.push(m),
    awaitCloudLoad: () => Promise.resolve(true),
    storyEditorOpen: () => false,
    initFirebase: () => {},
    normalizeGrid: (g: unknown) => g || [],
    gridWidth: () => 0,
    buildStagesForCloudSave: () => ({}),
    levelAtlasState: () => ({}),
    refreshShelfExports: () => Promise.resolve(0),
    ...opts.scope,
  });
  return {
    s,
    writes: fake.writes,
    alerts,
    asked,
    nameBox: () => document.getElementById("firebase-level-name").value,
    document,
    save: s.saveToFirebase as () => Promise<string | false | undefined>,
  };
}

// ---------------------------------------------------------------------------

Deno.test("the editor names shmupX's root beside its own Firebase config", () => {
  const cfg = html.indexOf("const FIREBASE_CONFIG = {");
  assert(cfg > 0, "no inline FIREBASE_CONFIG");
  const root = html.indexOf("window.__RTDB_ROOT__ = 'shmupX';", cfg);
  const chars = html.indexOf(
    "window.__CHARACTERS_DB__ = FIREBASE_CONFIG.databaseURL + '/' + window.__RTDB_ROOT__;",
    cfg,
  );
  assert(
    root > cfg && chars > root,
    "the root globals are not set after FIREBASE_CONFIG",
  );
  // ...and they come out as the contract spells them.
  const end = html.indexOf("};", cfg) + 2;
  const window: Scope = {};
  new Function(
    "window",
    html.slice(cfg, end) + "\n" + html.slice(root, html.indexOf("\n", chars)),
  )(window);
  assertEquals(window.__RTDB_ROOT__, "shmupX");
  assertEquals(window.__CHARACTERS_DB__, `${DB_URL}/shmupX`);
});

Deno.test("the editor's rtdbPath reads a path the way lib/rtdb-root.ts does", () => {
  const scope = live(["rtdbPath"], { window: { __RTDB_ROOT__: "shmupX" } });
  const rtdbPath = scope.rtdbPath as (p: string) => string;
  for (
    const p of [
      "levels",
      "levels/2019-PS2",
      "levelAliases/2019",
      "atlases",
      "atlases/dezaBoss0",
      "characters.json?shallow=true",
      "characters/Daltonius",
      "/atlases/foo",
      "sprites/RAM_0",
      "pixelSprites/abc",
      "leaderboards/foo-a9f37ed7/allTime",
      "spritePicker/inbox",
      "exportQueue",
      "shmupX/levels/gs",
      "levelsX/gs",
      "",
    ]
  ) assertEquals(rtdbPath(p), libRtdbPath(p), p);
  // The same four nodes, by name.
  const list = /const scoped = (\[[^\]]*\]);/.exec(editorFunction("rtdbPath"));
  assert(list, "rtdbPath keeps no node list");
  assertEquals(JSON.parse(list[1].replaceAll("'", '"')), [...SCOPED_NODES]);
  // A call that beats the assignment still lands under the root.
  const early = live(["rtdbPath"], { window: {} });
  assertEquals(
    (early.rtdbPath as (p: string) => string)("atlases"),
    "shmupX/atlases",
  );
});

Deno.test("no RTDB path in the editor names a scoped node at the root", () => {
  // SDK refs spelled as a bare node, and REST URLs on the database's base.
  const sdk = [
    ...html.matchAll(
      /\.ref\(\s*[`'"](levels|levelAliases|atlases|characters)\b/g,
    ),
  ];
  assertEquals(sdk.map((m) => m[0]), []);
  const rest = [
    ...html.matchAll(
      /databaseURL\}?\s*\+?\s*['"`]?\/(levels|levelAliases|atlases|characters)\b/g,
    ),
  ];
  assertEquals(rest.map((m) => m[0]), []);
  // Every SDK ref is built on the loader's rooted paths, or on rtdbPath.
  // (The capture stops at the first ")", which is enough to see the base.)
  const refs = [...html.matchAll(/firebaseDb\s*\.ref\(([^)]*)\)/g)].map((m) =>
    m[1].trim()
  );
  assert(refs.length >= 8, refs.join("\n"));
  for (const r of refs) {
    assert(
      r.includes("${LEVEL_LOADER_DEFAULTS.levelsPath}") ||
        r.includes("${LEVEL_LOADER_DEFAULTS.aliasesPath}") ||
        r === "LEVEL_LOADER_DEFAULTS.levelsPath" ||
        r.startsWith("rtdbPath("),
      "a firebaseDb ref off the rooted paths: " + r,
    );
  }
});

Deno.test("the library is shmupX's: '+ LIBRARY', the heal, the range, the LIBRARY EDITOR", () => {
  const db = live(["libraryDb"], {
    window: { __CHARACTERS_DB__: `${DB_URL}/shmupX/` },
    FIREBASE_CONFIG: { databaseURL: DB_URL },
  });
  assertEquals((db.libraryDb as () => string)(), `${DB_URL}/shmupX`);
  const fallback = live(["libraryDb"], {
    window: {},
    FIREBASE_CONFIG: { databaseURL: DB_URL },
  });
  assertEquals((fallback.libraryDb as () => string)(), `${DB_URL}/shmupX`);

  for (
    const fn of [
      "loadLibraryAtlas",
      "libraryRecords",
      "fillLibraryDemoPicker",
      "showLibraryDemo",
      "openCharacterLibrary",
    ]
  ) {
    assertMatch(
      editorFunction(fn),
      /\$\{libraryDb\(\)\}\/(characters|atlases)/,
      fn,
    );
  }
  // The element edits the same library, by its own attribute.
  assert(
    editorFunction("openLibraryEditor").includes(
      "el.setAttribute('db', libraryDb());",
    ),
  );
  // The Firebase Sprites browser lists shmupX's atlases.
  assert(
    editorFunction("openFirebaseSprites").includes(
      "firebaseDb.ref(rtdbPath('atlases'))",
    ),
  );
  // PUBLISH TO LIBRARY hands extract-mode.js the UNSCOPED base: it roots its
  // own existence check and PATCH, and a rooted base would be rooted twice.
  assert(
    editorFunction("publishEntryToLibrary").includes(
      "name, record: entry, db: FIREBASE_CONFIG.databaseURL,",
    ),
  );
});

Deno.test("a short name resolves through shmupX/levelAliases, lowercased", async () => {
  const { db } = fakeDb(seeded());
  const s = live(["levelAliasTarget"], {
    firebaseDb: db,
    LEVEL_LOADER_DEFAULTS,
    sanitizeLevelName,
  });
  const target = s.levelAliasTarget as (n: string) => Promise<string | null>;
  assertEquals(await target("2019"), "2019-PS2");
  assertEquals(await target("StreetFighter"), "2019-PS2");
  assertEquals(await target("foo"), null);
  // An alias of itself is no alias.
  assertEquals(await target("2019-PS2"), null);
});

Deno.test("SAVE under a short name goes to its game, once asked, and never shadows the alias", async () => {
  const asked: string[] = [];
  let answer = true;
  const tree = seeded();
  const { db } = fakeDb(tree);
  const s = live([
    "levelAliasTarget",
    "levelKeyTaken",
    "cloudSaveTarget",
    "cloudSaveKey",
  ], {
    firebaseDb: db,
    LEVEL_LOADER_DEFAULTS,
    sanitizeLevelName,
    confirm: (q: string) => (asked.push(q), answer),
  });
  const key = s.cloudSaveKey as (n: string) => Promise<string | null>;
  assertEquals(await key("2019"), "2019-PS2");
  assertEquals(asked.length, 1);
  assert(asked[0].includes('"2019-PS2"'), asked[0]);
  answer = false;
  assertEquals(await key("2019"), null, "Cancel must save nothing");
  // A plain name, new or old, is its own key and asks nothing.
  asked.length = 0;
  assertEquals(await key("foo"), "foo");
  assertEquals(await key("brand-new"), "brand-new");
  assertEquals(asked, []);
  // A game saved under the short name is that game's (the runtime opens it).
  ((tree.shmupX as Scope).levels as Scope)["2019"] = { enemylist: [[2]] };
  assertEquals(await key("2019"), "2019");
  assertEquals(asked, []);
  // An unreadable database is no alias: the save goes ahead as typed.
  const offline = live([
    "levelAliasTarget",
    "levelKeyTaken",
    "cloudSaveTarget",
    "cloudSaveKey",
  ], {
    firebaseDb: fakeDb(seeded(), { fail: true }).db,
    LEVEL_LOADER_DEFAULTS,
    sanitizeLevelName,
    console: { warn: () => {} },
    confirm: () => {
      throw new Error("asked while offline");
    },
  });
  assertEquals(
    await (offline.cloudSaveKey as (n: string) => Promise<string>)("2019"),
    "2019",
  );
});

Deno.test("a gameId is read from the record, kept on a failed read of its own key, minted otherwise", async () => {
  const names = ["mintGameId", "ensureGameId"];
  const s = live(names, {
    firebaseDb: fakeDb(seeded()).db,
    LEVEL_LOADER_DEFAULTS,
    gameData: {},
    cloudGameKey: "",
  });
  const ensure = s.ensureGameId as (n: string) => Promise<string>;
  assertEquals(await ensure("2019-PS2"), "2019-ps2-adb9fb3f");
  assertEquals(await ensure("foo"), "foo-a9f37ed7");
  assertMatch(await ensure("legacy"), /^legacy-[0-9a-f]{8}$/);
  assertMatch(await ensure("Brand New!"), /^brand-new-[0-9a-f]{8}$/);
  // Offline: the id the open game was LOADED from this key with is this
  // record's, so it is kept rather than minted over the board.
  const off = live(names, {
    firebaseDb: fakeDb(seeded(), { fail: true }).db,
    LEVEL_LOADER_DEFAULTS,
    console: { warn: () => {} },
    gameData: { gameId: "foo-a9f37ed7" },
    cloudGameKey: "foo",
  });
  const ensureOff = off.ensureGameId as (n: string) => Promise<string>;
  assertEquals(await ensureOff("foo"), "foo-a9f37ed7");
  // ...but a save under another name is another game's board.
  assertMatch(await ensureOff("foo2"), /^foo2-[0-9a-f]{8}$/);
});

/** The cloud LOAD, live, with every render and atlas step a no-op. */
function cloudLoad(tree: Scope, gameData: Scope, nameBox = "") {
  const alerts: string[] = [];
  const document = fakeDocument({ "firebase-level-name": nameBox });
  const s = live(["levelAliasTarget", "loadFromFirebaseRecord"], {
    firebaseDb: fakeDb(tree).db,
    LEVEL_LOADER_DEFAULTS,
    sanitizeLevelName,
    gameData,
    cloudGameKey: "",
    document,
    alert: (m: string) => alerts.push(m),
    initFirebase: () => {},
    normalizeGrid: (g: unknown) => g,
    decodeFirebaseKey: (k: string) => k,
  });
  return {
    s,
    alerts,
    nameBox: () => document.getElementById("firebase-level-name").value,
    load: s.loadFromFirebaseRecord as (n: string) => Promise<boolean>,
  };
}

Deno.test("LOAD of a short name opens its game, under the game's key, with its board", async () => {
  const gameData: Scope = { gameId: "previous-game-00000000" };
  const c = cloudLoad(seeded(), gameData, "2019");
  assertEquals(await c.load("2019"), true, c.alerts.join("\n"));
  assertEquals(c.alerts, []);
  // shmupX's 2019-PS2, not cmg's root "2019".
  assertEquals((c.s.enemyData as Scope).enemyA, { name: "zako" });
  assertEquals(
    c.nameBox(),
    "2019-PS2",
    "the next SAVE must write 2019-PS2 back",
  );
  assertEquals((c.s.gameData as Scope).gameId, "2019-ps2-adb9fb3f");
  assertEquals(c.s.cloudGameKey, "2019-PS2");
});

Deno.test("LOAD of a record with no gameId drops the previous game's", async () => {
  const gameData: Scope = { gameId: "foo-a9f37ed7" };
  const c = cloudLoad(seeded(), gameData);
  assertEquals(await c.load("legacy"), true, c.alerts.join("\n"));
  assertEquals("gameId" in (c.s.gameData as Scope), false);
  // ...and a name that is neither a key nor an alias is still not found.
  assertEquals(await c.load("nothing-here"), false);
  assertEquals(c.alerts, ['"nothing-here" not found']);
});

/** PLAY's recipe, built live from the open game, its cloud key and the name box. */
function playRecipe(
  gameData: Scope | null,
  cloudGameKey: string,
  nameBox: string,
): Scope {
  return (live(["buildRuntimeRecipe"], {
    gameData,
    cloudGameKey,
    sanitizeLevelName,
    enemyData: {},
    bossData: {},
    playerData: {},
    currentStageKey: "stage0",
    currentGrid: [],
    titleBgDataURL: null,
    logoDataURL: null,
    subTitleDataURL: null,
    titleStartTextDataURL: null,
    storyEditorOpen: () => false,
    ssEntriesPlain: () => null,
    uiAtlasesForSave: () => null,
    editorReturnUrl: () => "/editor/?game=2028-ai&fromPlay=1",
    document: fakeDocument({ "firebase-level-name": nameBox }),
  }).buildRuntimeRecipe as () => Scope)();
}

Deno.test("PLAY's recipe carries the open game's gameId at its top level", () => {
  const played = playRecipe(
    { gameId: "2019-ps2-adb9fb3f" },
    "2019-PS2",
    "2019-PS2",
  );
  assertEquals(played.gameId, "2019-ps2-adb9fb3f");
  // ...beside the key it belongs to, which the runtime names the board after.
  assertEquals((played.meta as Scope).editorGameKey, "2019-PS2");
  assertEquals((played.meta as Scope).editorLevelName, "2019-PS2");
  // A game with none yet (a fresh import, NEW GAME) sends none.
  for (const gameData of [{}, { gameId: "  " }, null]) {
    const r = playRecipe(gameData, "2019-PS2", "2019-PS2");
    assertEquals("gameId" in r, false);
    assertEquals("editorGameKey" in (r.meta as Scope), false);
  }
  // The ?editorPlay=1 hand-off stores exactly this recipe.
  assert(
    editorFunction("playCurrentStage").includes(
      "localStorage.setItem(LEVEL_LOADER_DEFAULTS.editorRecipeKey, JSON.stringify(buildRuntimeRecipe()));",
    ),
  );
});

Deno.test("PLAY under a name typed over the loaded key stays off that game's board", () => {
  // gs is open under its own key; the name box now says something else,
  // which SAVE would treat as a new game and mint a board for.
  for (const typed of ["gs-hard", "Ramsie", ""]) {
    const r = playRecipe({ gameId: "gs-710c41d3" }, "gs", typed);
    assertEquals("gameId" in r, false, typed);
    assertEquals("editorGameKey" in (r.meta as Scope), false, typed);
    assertEquals((r.meta as Scope).editorLevelName, typed || null);
  }
  // Typed back (spacing aside), it is that game again.
  assertEquals(
    playRecipe({ gameId: "gs-710c41d3" }, "gs", "  gs ").gameId,
    "gs-710c41d3",
  );
  // An id with no key it is known to belong to stays home as well.
  assertEquals(
    "gameId" in playRecipe({ gameId: "gs-710c41d3" }, "", "gs"),
    false,
  );
  // ...which is what a folder's game.json leaves: its loaders forget the
  // last cloud game's key.
  for (const fn of ["loadGameFilesFromFileList", "loadGameFiles"]) {
    assert(editorFunction(fn).includes("cloudGameKey = '';"), fn);
  }
  // An editorGameKey left on the game's own meta never rides along.
  const stale = playRecipe(
    { gameId: "gs-710c41d3", meta: { editorGameKey: "gs" } },
    "gs",
    "gs-hard",
  );
  assertEquals("editorGameKey" in (stale.meta as Scope), false);
});

/** ?fromPlay=1, live: the editor comes back from `recipe` as PLAY stored it. */
async function backFromPlay(recipe: unknown) {
  const store: Record<string, string> = {
    editorRecipe: JSON.stringify(recipe),
    editorStage: "0",
  };
  const document = fakeDocument({});
  const s = live(["restoreFromPlayRecipe"], {
    localStorage: { getItem: (k: string) => store[k] ?? null },
    LEVEL_LOADER_DEFAULTS: {
      ...LEVEL_LOADER_DEFAULTS,
      editorRecipeKey: "editorRecipe",
      editorStageKey: "editorStage",
    },
    openViewerBridge: () => Promise.resolve(null),
    ensureLevelAtlasOpen: () => Promise.resolve(),
    sanitizeLevelName,
    normalizeGrid: (g: unknown) => g || [],
    gameData: null,
    cloudGameKey: "",
    document,
  });
  assertEquals(
    await (s.restoreFromPlayRecipe as () => Promise<boolean>)(),
    true,
  );
  return { s, nameBox: document.getElementById("firebase-level-name").value };
}

Deno.test("Edit Levels after PLAY pairs the gameId with its own key again", async () => {
  // A PLAY of gs under its own key comes back as gs, board and all.
  const own = await backFromPlay(
    playRecipe({ gameId: "gs-710c41d3" }, "gs", "gs"),
  );
  assertEquals((own.s.gameData as Scope).gameId, "gs-710c41d3");
  assertEquals(own.s.cloudGameKey, "gs");
  assertEquals(own.nameBox, "gs");
  // The PLAY-only keys stay on the recipe, off the game a SAVE writes.
  assertEquals("meta" in (own.s.gameData as Scope), false);
  // A renamed PLAY carried no id, and comes back with none.
  const renamed = await backFromPlay(
    playRecipe({ gameId: "gs-710c41d3" }, "gs", "gs-hard"),
  );
  assertEquals("gameId" in (renamed.s.gameData as Scope), false);
  assertEquals(renamed.s.cloudGameKey, "");
  assertEquals(renamed.nameBox, "gs-hard");
  // The key is editorGameKey, not the name the run was played under.
  const keyed = await backFromPlay({
    gameId: "gs-710c41d3",
    meta: {
      editorLevelName: "gs-hard",
      editorGameKey: "gs",
      source: "dezaemon2",
    },
  });
  assertEquals(keyed.s.cloudGameKey, "gs");
  assertEquals((keyed.s.gameData as Scope).meta, { source: "dezaemon2" });
  // A recipe stored before editorGameKey has only that name to go on.
  const old = await backFromPlay({
    gameId: "foo-a9f37ed7",
    meta: { editorLevelName: "foo" },
  });
  assertEquals(old.s.cloudGameKey, "foo");
});

Deno.test("SAVE after a short-name LOAD writes the game's own key, name and board", async () => {
  const c = cloudSave(seeded(), "2019");
  assertEquals(await c.save(), "2019-PS2");
  assertEquals(c.writes.length, 1, c.alerts.join("\n"));
  assertEquals(c.writes[0].path, "shmupX/levels/2019-PS2");
  const payload = c.writes[0].value as Scope;
  assertEquals(payload.gameId, "2019-ps2-adb9fb3f");
  // The record keeps the name its title shows.
  assertEquals(payload.name, "2019");
  assertEquals(c.nameBox(), "2019-PS2");
  assertEquals((c.s.gameData as Scope).gameId, "2019-ps2-adb9fb3f");
  assertEquals(c.s.cloudGameKey, "2019-PS2");

  // A brand-new game: its key is its name, and its first save mints.
  c.document.getElementById("firebase-level-name").value = "Brand New";
  c.s.gameData = {};
  assertEquals(await c.save(), "Brand New");
  assertEquals(c.writes.length, 2, c.alerts.join("\n"));
  assertEquals(c.writes[1].path, "shmupX/levels/Brand New");
  const fresh = c.writes[1].value as Scope;
  assertEquals(fresh.name, "Brand New");
  assertMatch(String(fresh.gameId), /^brand-new-[0-9a-f]{8}$/);
});

Deno.test("SAVE says how it ended: the key it wrote, false when declined, undefined when it failed", async () => {
  // Declined on the short-name prompt: nothing written, the box untouched.
  const no = cloudSave(seeded(), "2019", { answer: false });
  assertEquals(await no.save(), false);
  assertEquals(no.writes, []);
  assertEquals(no.asked.length, 1);
  assertEquals(no.nameBox(), "2019");
  // ...or no name given at all.
  for (const typed of [null, "", "   "]) {
    const unnamed = cloudSave(seeded(), "", { scope: { prompt: () => typed } });
    assertEquals(await unnamed.save(), false, String(typed));
    assertEquals(unnamed.writes, []);
  }
  // Failed, and said so: undefined, the answer every save used to give.
  const denied = cloudSave(seeded(), "foo", {
    db: fakeDb(seeded(), { failWrites: true }),
  });
  assertEquals(await denied.save(), undefined);
  assertEquals(denied.writes, []);
  assertMatch(denied.alerts.join("\n"), /Save failed: permission denied/);
  const noDb = cloudSave(seeded(), "foo", { scope: { firebaseDb: null } });
  assertEquals(await noDb.save(), undefined);
  assertEquals(noDb.alerts, ["Firebase not available"]);
});

/** EXPORT > APK (a cloud game), live, after the real SAVE GAME; the build route is a fake. */
function appExport(
  tree: Scope,
  nameBox: string,
  opts: {
    answer?: boolean;
    status?: number;
    db?: ReturnType<typeof fakeDb>;
  } = {},
) {
  const posted: { url: string; body: Scope }[] = [];
  const queued: string[] = [];
  const c = cloudSave(tree, nameBox, {
    answer: opts.answer,
    db: opts.db,
    extra: ["exportGameToApk"],
    scope: {
      EXPORT_PLATFORMS: { android: { artifact: "APK" } },
      exportPlatform: "android",
      savModeLoaded: () => false,
      ps2WebIdentity: () => null,
      fetch: (url: string, init: { body: string }) => {
        posted.push({ url, body: JSON.parse(init.body) });
        const status = opts.status ?? 200;
        return Promise.resolve({
          ok: status === 200,
          status,
          json: () => Promise.resolve(status === 200 ? { ok: true } : {}),
        });
      },
      queueRemoteExport: (name: string) => {
        queued.push(name);
        return Promise.resolve();
      },
    },
  });
  return {
    ...c,
    posted,
    queued,
    status: () => c.document.getElementById("export-apk-status").textContent,
    run: c.s.exportGameToApk as () => Promise<void>,
  };
}

Deno.test("EXPORT stops when its save is declined, and builds the key the save wrote", async () => {
  // Cancel on '"2019" is another name for the game "2019-PS2"': nothing was
  // saved, so nothing is built — not 2019-PS2 as the cloud has it, without
  // the edits on screen — and nothing is queued on a desktop either.
  for (const status of [200, 403]) {
    const declined = appExport(seeded(), "2019", { answer: false, status });
    await declined.run();
    assertEquals(declined.writes, []);
    assertEquals(declined.posted, []);
    assertEquals(declined.queued, []);
    assertMatch(declined.status(), /^Export cancelled/);
  }
  // OK: saved over 2019-PS2, and 2019-PS2 is what is built...
  const ok = appExport(seeded(), "2019");
  await ok.run();
  assertEquals(ok.writes.map((w) => w.path), ["shmupX/levels/2019-PS2"]);
  assertEquals(ok.posted, [{
    url: "/api/build-apk",
    body: { level: "2019-PS2", platform: "android" },
  }]);
  // ...or queued, when this origin cannot build.
  const remote = appExport(seeded(), "2019", { status: 403 });
  await remote.run();
  assertEquals(remote.queued, ["2019-PS2"]);
  // A save that failed some other way has alerted already; the build goes
  // ahead from the name box, as it always has.
  const failed = appExport(seeded(), "foo", {
    db: fakeDb(seeded(), { failWrites: true }),
  });
  await failed.run();
  assertEquals(failed.writes, []);
  assertEquals(failed.posted.map((p) => p.body.level), ["foo"]);
});

/** An entry editor's SAVE (enemy, boss or player), live, with the real SAVE GAME behind it. */
function entrySave(
  tree: Scope,
  nameBox: string,
  opts: { tab?: string; answer?: boolean; db?: ReturnType<typeof fakeDb> } = {},
) {
  return cloudSave(tree, nameBox, {
    answer: opts.answer,
    db: opts.db,
    extra: ["saveCurrentEnemy"],
    scope: {
      syncEnemyEditorForm: () => true,
      currentEditorTab: opts.tab ?? "enemies",
      pullEntryArtFromLibrary: () => Promise.resolve(),
      entryFramesMissingFromAtlas: () => [],
      atlasAheadOfCloud: false,
      currentEnemyKey: "enemyA",
      enemyData: { enemyA: { name: "other-game-zako" } },
      bossData: { enemyA: { name: "other-game-boss" } },
      playerData: { name: "other-game-ship" },
    },
  });
}
const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("per-entry SAVE under a short name saves the whole game, never one table into the alias's", async () => {
  for (const tab of ["enemies", "bosses", "player"]) {
    const c = entrySave(seeded(), "2019", { tab });
    await (c.s.saveCurrentEnemy as () => Promise<void>)();
    await settle();
    // One write, the whole game, after SAVE GAME's own whole-game prompt.
    assertEquals(c.writes.map((w) => w.path), ["shmupX/levels/2019-PS2"], tab);
    assertEquals(c.asked.length, 1);
    assertMatch(c.asked[0], /OK saves this game over "2019-PS2"/);
    assertEquals(
      ((c.writes[0].value as Scope).enemyData as Scope).enemyA,
      { name: "other-game-zako" },
    );
    // ...and the box now names the game it went to, so the next one asks not.
    assertEquals(c.nameBox(), "2019-PS2");
  }
  // Cancel saves nothing at all.
  const no = entrySave(seeded(), "2019", { answer: false });
  await (no.s.saveCurrentEnemy as () => Promise<void>)();
  await settle();
  assertEquals(no.writes, []);
  assertEquals(no.nameBox(), "2019");
});

Deno.test("per-entry SAVE under a game's own name writes just that table, as it always has", async () => {
  const cases: [string, string, "update" | "set", unknown][] = [
    ["enemies", "enemyData", "update", { enemyA: { name: "other-game-zako" } }],
    ["bosses", "bossData", "update", { enemyA: { name: "other-game-boss" } }],
    ["player", "playerData", "set", { name: "other-game-ship" }],
  ];
  for (const [tab, table, op, value] of cases) {
    const c = entrySave(seeded(), "foo", { tab });
    await (c.s.saveCurrentEnemy as () => Promise<void>)();
    await settle();
    assertEquals(c.writes, [{ path: `shmupX/levels/foo/${table}`, op, value }]);
    assertEquals(c.asked, []);
    assertMatch(c.alerts.join("\n"), /saved to cloud!/);
  }
  // A short name with a game saved under it is that game's own name.
  const tree = seeded();
  ((tree.shmupX as Scope).levels as Scope)["2019"] = { enemylist: [[2]] };
  const taken = entrySave(tree, "2019");
  await (taken.s.saveCurrentEnemy as () => Promise<void>)();
  await settle();
  assertEquals(taken.writes.map((w) => w.path), [
    "shmupX/levels/2019/enemyData",
  ]);
  // An unreadable alias table is no alias: the table goes as typed.
  const offline = entrySave(seeded(), "2019", {
    db: fakeDb(seeded(), { fail: true }),
  });
  await (offline.s.saveCurrentEnemy as () => Promise<void>)();
  await settle();
  assertEquals(offline.writes.map((w) => w.path), [
    "shmupX/levels/2019/enemyData",
  ]);
});

Deno.test("a job waiting for a current desktop is cancellable, like a queued one", async () => {
  const el = (): Scope => {
    const children: Scope[] = [];
    return {
      style: {},
      children,
      textContent: "",
      appendChild: (c: Scope) => children.push(c),
    };
  };
  const s = live(["exportJobUnclaimed", "renderExportJob"], {
    document: { createElement: el },
    exportJobBusy: {},
    exportJobNotes: {},
  });
  // The module the editor imports, as it is now, and a cached copy from
  // before it wrote 'waiting' (no jobWaiting).
  const mod = await import("../static/export-queue.js");
  const shown = { jobTitle: () => "APK · foo", jobStatusText: () => "" };
  for (const q of [{ ...shown, jobWaiting: mod.jobWaiting }, shown]) {
    const buttons = (job: Scope) => {
      const box = (s.renderExportJob as (q: unknown, j: Scope) => Scope)(q, {
        id: "j1",
        ...job,
      });
      const row = (box.children as Scope[]).find((c) =>
        Array.isArray(c.children) && (c.children as Scope[]).length &&
        (c.children as Scope[]).every((b) => "onclick" in b)
      );
      return row ? (row.children as Scope[]).map((b) => b.textContent) : [];
    };
    const which = "jobWaiting" in q ? "module" : "fallback";
    assertEquals(buttons({ status: "queued" }), ["CANCEL", "DISMISS"], which);
    assertEquals(
      buttons({ status: mod.WAITING_STATUS, minWorker: 2 }),
      ["CANCEL", "DISMISS"],
      which,
    );
    assertEquals(buttons({ status: "building" }), [], which);
    assertEquals(buttons({ status: "cancelled" }), ["DISMISS"], which);
  }
  // A job just queued is remembered at the status it was written with.
  assert(
    editorFunction("queueRemoteExport").includes(
      "exportJobsSeen[job.id] = job.status;",
    ),
  );
});
