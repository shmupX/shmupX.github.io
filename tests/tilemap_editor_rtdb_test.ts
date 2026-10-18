// The Tilemap Editor's LEVEL SCENERY reads and writes shmupX's levels.
//
// shmupX's games live under `shmupX/` in the database cmg shares, and the
// root-level levels/ is cmg's catalog — with a same-named copy of most of
// shmupX's games in it. The tilemap editor lists, opens and saves a level's
// scenery, so all three must go to shmupX/levels, a name like "2019" must
// resolve through shmupX/levelAliases to the key it stands for (2019-PS2),
// and its one multi-path update must move only the levels keys: tilemaps/*
// and pixelSprites/* are shared tool stores that stay at the root.
//
// static/tilemap-editor/tilemap-editor.js is a browser module with a DOM and
// a top-level await, so the path block is cut out of the source and run on
// its own against a fake compat SDK, and the write paths are pinned as text.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const SRC = await Deno.readTextFile(
  fromFileUrl(
    new URL("../static/tilemap-editor/tilemap-editor.js", import.meta.url),
  ),
);

/** The root constants and readCloudLevel, evaluated with `window` given. */
function pathBlock(window: Record<string, unknown>) {
  const start = SRC.indexOf("const RTDB_ROOT =");
  const end = SRC.indexOf("// level-loader.js's key encoding");
  assert(start > 0 && end > start, "the path block moved");
  const body = SRC.slice(start, end) +
    "\nreturn { RTDB_ROOT, LEVELS_PATH, ALIASES_PATH, readCloudLevel };";
  return new Function("window", body)(window) as {
    RTDB_ROOT: string;
    LEVELS_PATH: string;
    ALIASES_PATH: string;
    readCloudLevel: (
      d: unknown,
      name: string,
    ) => Promise<{ key: string; record: unknown }>;
  };
}

/** A compat-SDK database over a tree, remembering every ref() path. */
function fakeSdk(tree: Record<string, unknown>) {
  const refs: string[] = [];
  const at = (path: string) =>
    path.split("/").reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      tree,
    );
  return {
    refs,
    ref(path: string) {
      refs.push(path);
      return {
        once: () => Promise.resolve({ val: () => at(path) ?? null }),
      };
    },
  };
}

const TREE = {
  levels: {
    "2019-PS2": { name: "2019", from: "root" },
    hell: { name: "hell", from: "root" },
  },
  levelAliases: { "2019": "2019-PS2", hell: "hell" },
  shmupX: {
    levels: {
      "2019-PS2": { name: "2019", from: "shmupX" },
      Ramsie: { name: "Ramsie", from: "shmupX" },
    },
    levelAliases: { "2019": "2019-PS2", streetfighter: "2019-PS2" },
  },
};

Deno.test("the scenery paths are under shmupX/, the global's or the default", () => {
  const fromConfig = pathBlock({ __RTDB_ROOT__: "shmupX" });
  assertEquals(fromConfig.LEVELS_PATH, "shmupX/levels");
  assertEquals(fromConfig.ALIASES_PATH, "shmupX/levelAliases");
  // firebase-config.js not loaded (or older): still shmupX's tree.
  const fallback = pathBlock({});
  assertEquals(fallback.RTDB_ROOT, "shmupX");
  assertEquals(fallback.LEVELS_PATH, "shmupX/levels");
});

Deno.test("a name opens shmupX's record, through an alias when it is one", async () => {
  const { readCloudLevel } = pathBlock({ __RTDB_ROOT__: "shmupX" });
  const sdk = fakeSdk(TREE);
  const direct = await readCloudLevel(sdk, "Ramsie");
  assertEquals(direct.key, "Ramsie");
  assertEquals(sdk.refs, ["shmupX/levels/Ramsie"]);

  sdk.refs.length = 0;
  const aliased = await readCloudLevel(sdk, "StreetFighter");
  assertEquals(aliased.key, "2019-PS2");
  assertEquals((aliased.record as { from: string }).from, "shmupX");
  assertEquals(sdk.refs, [
    "shmupX/levels/StreetFighter",
    "shmupX/levelAliases/streetfighter",
    "shmupX/levels/2019-PS2",
  ]);

  // A level only cmg's root holds is a miss, never the root copy.
  sdk.refs.length = 0;
  const missing = await readCloudLevel(sdk, "hell");
  assertEquals(missing.record, null);
  assert(sdk.refs.every((p) => p.startsWith("shmupX/")), sdk.refs.join());
});

Deno.test("the list, the load and the save all name the scoped paths", () => {
  // The LEVEL SCENERY list is a shallow REST read of shmupX/levels...
  assert(SRC.includes("fetch(`${DB_URL}/${LEVELS_PATH}.json?shallow=true`)"));
  // ...the load and the save both go through the alias-aware reader...
  assertEquals(SRC.match(/await readCloudLevel\(d, name\)/g)?.length, 2);
  // ...and no level path is spelled out at the root any more.
  assert(!/[`'"]levels\//.test(SRC), "a root levels/ path is still spelled");
  assert(!/[`'"]levelAliases\//.test(SRC));
  assert(!SRC.includes("/levels.json"));

  // The save's one multi-path update writes nothing but the resolved
  // level's own keys, all under LEVELS_PATH.
  const save = SRC.slice(
    SRC.indexOf("async function saveLevelScenery"),
    SRC.indexOf("function broadcastApply"),
  );
  assert(save.includes("const at = `${LEVELS_PATH}/${key}`;"));
  const keys = [...save.matchAll(/updates\[`([^`]*)`\]/g)].map((m) => m[1]);
  assert(keys.length >= 6, keys.join());
  for (const k of keys) assert(k.startsWith("${at}/"), k);
});

Deno.test("the shared tool stores stay at the root", () => {
  assert(SRC.includes("fetch(`${DB_URL}/tilemaps.json?shallow=true`)"));
  assert(SRC.includes("d.ref(`tilemaps/${key}`)"));
  assert(/ref\(["']pixelSprites["']\)/.test(SRC));
  // DB_URL is still the database's base, not <db>/shmupX.
  assert(
    SRC.includes(
      'const DB_URL = (window.__FIREBASE_CONFIG__ && window.__FIREBASE_CONFIG__.databaseURL) || "https://evil-invaders-default-rtdb.firebaseio.com";',
    ),
  );
});
