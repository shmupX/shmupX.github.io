// A level by name: which record a harbor build fetches.
//
// shmupX's games live under `shmupX/` in the database it shares with cmg.
// Every build that takes a level by NAME — the PS2 disc, the five cart
// writers, the shelf's cloud rung, and tools/build-level in Node — must read
// shmupX/levels/<name>, else the key shmupX/levelAliases/<name lowercased>
// names, and never the root-level levels/, which is cmg's catalog and still
// holds a same-named copy of most of shmupX's games. A build that fell back
// there would package cmg's version (or a game shmupX does not ship) and say
// nothing.
//
// Nothing here touches the real database (it is open-write): every read goes
// to an in-memory tree shaped like the live one, with the root copies laid
// out so that reading the wrong tree gives a visibly different record.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  CLOUD_DB,
  cloudAliasUrl,
  cloudLevelUrl,
  resolveCloudLevel,
} from "../lib/cloud-level.ts";
import { loadLevel } from "../scripts/build-sav.ts";
import { buildPs2 } from "../lib/ps2/build.ts";
import { resolveShelfName, SHELF_DB, ShelfError } from "../lib/shelf.ts";
import { harborRoot, repoRoot } from "../lib/repo-root.ts";

const HARBOR = harborRoot();

/**
 * The database, as far as these builds can see it. Each record says which
 * tree it came from in its first enemylist row, so a test can tell at a
 * glance whether a build read shmupX's copy or cmg's.
 */
const TREE = {
  // cmg's catalog, at the root. Never to be read by a name lookup.
  levels: {
    "2019-PS2": { name: "2019", enemylist: [["root"]] },
    Ramsie: { name: "Ramsie", enemylist: [["root"]] },
    ramsie: { name: "ramsie", enemylist: [["root"]] },
    hell: { name: "hell", enemylist: [["root"]] },
  },
  levelAliases: { "2019": "2019-PS2", streetfighter: "2019-PS2", hell: "hell" },
  shmupX: {
    levels: {
      "2019-PS2": { name: "2019", enemylist: [["shmupX"]] },
      Ramsie: { name: "Ramsie", enemylist: [["shmupX"]] },
      // Saved by a newer editor with stages and no flat enemylist: a cart
      // writer accepts it, the PS2 builder (which wants enemylist) does not.
      staged: { name: "staged", stages: { stage0: { enemylist: [] } } },
    },
    levelAliases: {
      "2019": "2019-PS2",
      streetfighter: "2019-PS2",
      // An alias whose level has gone: a miss, not an error.
      broken: "nowhere",
    },
  },
};

/**
 * One REST read of TREE, as `${base}/<path>.json[?shallow=true]` answers it.
 * Written as plain JS source so the Node half below runs the very same
 * lookup rather than a second hand-kept copy of it.
 */
const LOOKUP_JS = `
  if (!url.startsWith(base + "/")) throw new Error("wrong database: " + url);
  const [pathPart, query] = url.slice(base.length + 1).split("?");
  const path = pathPart.replace(/\\.json$/, "");
  let node = tree;
  for (const seg of path.split("/").filter(Boolean)) {
    node = node && typeof node === "object" ? node[decodeURIComponent(seg)] : undefined;
  }
  if (node === undefined) return null;
  if (query === "shallow=true" && node && typeof node === "object") {
    return Object.fromEntries(Object.keys(node).map((k) => [k, true]));
  }
  return JSON.parse(JSON.stringify(node));
`;
const lookup = new Function("tree", "base", "url", LOOKUP_JS) as (
  tree: unknown,
  base: string,
  url: string,
) => unknown;

/** A reader over TREE that remembers every URL it was asked for. */
function fakeGet(base = CLOUD_DB) {
  const calls: string[] = [];
  const get = (url: string) => {
    calls.push(url);
    return Promise.resolve(lookup(TREE, base, url));
  };
  return { calls, get };
}

/** globalThis.fetch over TREE, for the callers that use fetch() directly. */
function stubFetch(base = CLOUD_DB) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return Promise.resolve(Response.json(lookup(TREE, base, url)));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const firstRow = (value: unknown) =>
  (value as { enemylist?: string[][] } | null)?.enemylist?.[0]?.[0];

const hasEnemylist = (value: unknown) =>
  !!(value as { enemylist?: unknown } | null)?.enemylist;

/** No lookup may ever read the root-level levels/ or levelAliases/. */
function assertScoped(calls: string[], base = CLOUD_DB) {
  for (const url of calls) {
    assert(
      url.startsWith(`${base}/shmupX/levels/`) ||
        url.startsWith(`${base}/shmupX/levelAliases/`),
      `read outside shmupX/: ${url}`,
    );
  }
}

Deno.test("a key is read from shmupX/levels, and only from there", async () => {
  const { calls, get } = fakeGet();
  const hit = await resolveCloudLevel("2019-PS2", {
    get,
    accept: hasEnemylist,
  });
  assertEquals(hit?.key, "2019-PS2");
  assertEquals(hit?.alias, null);
  assertEquals(firstRow(hit?.value), "shmupX");
  assertEquals(calls, [`${CLOUD_DB}/shmupX/levels/2019-PS2.json`]);
  assertEquals(hit?.url, calls[0]);
});

Deno.test("an alias resolves through shmupX/levelAliases, lowercased", async () => {
  for (const typed of ["2019", "StreetFighter"]) {
    const { calls, get } = fakeGet();
    const hit = await resolveCloudLevel(typed, { get, accept: hasEnemylist });
    assertEquals(hit?.key, "2019-PS2", typed);
    assertEquals(hit?.alias, typed);
    assertEquals(firstRow(hit?.value), "shmupX");
    assertEquals(calls, [
      `${CLOUD_DB}/shmupX/levels/${typed}.json`,
      `${CLOUD_DB}/shmupX/levelAliases/${typed.toLowerCase()}.json`,
      `${CLOUD_DB}/shmupX/levels/2019-PS2.json`,
    ]);
  }
});

Deno.test("a level only cmg has is a miss, never the root copy", async () => {
  // "hell" is a root level with a root alias; "ramsie" (lowercase) is a
  // different root record from shmupX's "Ramsie", and a key is never
  // lowercased to find it.
  for (const typed of ["hell", "ramsie", "broken", "nobody"]) {
    const { calls, get } = fakeGet();
    assertEquals(
      await resolveCloudLevel(typed, { get, accept: hasEnemylist }),
      null,
      typed,
    );
    assertScoped(calls);
  }
  const { get } = fakeGet();
  const exact = await resolveCloudLevel("Ramsie", {
    get,
    accept: hasEnemylist,
  });
  assertEquals(exact?.key, "Ramsie");
  assertEquals(firstRow(exact?.value), "shmupX");
  assertEquals(await resolveCloudLevel("", { get }), null);
});

Deno.test("what counts as a level is the caller's to say", async () => {
  const { get } = fakeGet();
  // Any value by default (the shelf's "is it there?").
  assertEquals((await resolveCloudLevel("staged", { get }))?.key, "staged");
  // The PS2 builder wants a flat enemylist, so a stages-only record misses.
  assertEquals(
    await resolveCloudLevel("staged", { get, accept: hasEnemylist }),
    null,
  );
});

Deno.test("a shallow probe asks for keys, not the multi-megabyte record", async () => {
  const { calls, get } = fakeGet();
  const hit = await resolveCloudLevel("2019", {
    get,
    shallow: true,
    accept: (v) => !!v,
  });
  assertEquals(hit?.key, "2019-PS2");
  assertEquals(hit?.value, { name: true, enemylist: true });
  assertEquals(calls, [
    `${CLOUD_DB}/shmupX/levels/2019.json?shallow=true`,
    // The alias is one short string; there is nothing to make shallow.
    `${CLOUD_DB}/shmupX/levelAliases/2019.json`,
    `${CLOUD_DB}/shmupX/levels/2019-PS2.json?shallow=true`,
  ]);
});

Deno.test("a database that is down is an error; an unreadable alias index is a miss", async () => {
  await assertRejects(
    () =>
      resolveCloudLevel("gs", {
        get: () =>
          Promise.reject(new Error("could not read the level (HTTP 503)")),
      }),
    Error,
    "HTTP 503",
  );
  const calls: string[] = [];
  const hit = await resolveCloudLevel("2019", {
    get: (url) => {
      calls.push(url);
      return url.includes("/levelAliases/")
        ? Promise.reject(new Error("HTTP 401"))
        : Promise.resolve(null);
    },
  });
  assertEquals(hit, null);
  assertEquals(calls.length, 2);
});

Deno.test("names are encoded, the base is the database's root, not <db>/shmupX", () => {
  assertEquals(CLOUD_DB, "https://evil-invaders-default-rtdb.firebaseio.com");
  assertEquals(
    cloudLevelUrl("Daioh P!", "https://db.test"),
    "https://db.test/shmupX/levels/Daioh%20P!.json",
  );
  assertEquals(
    cloudLevelUrl("gs", "https://db.test", true),
    "https://db.test/shmupX/levels/gs.json?shallow=true",
  );
  assertEquals(
    cloudAliasUrl("Street Fighter", "https://db.test"),
    "https://db.test/shmupX/levelAliases/street%20fighter.json",
  );
});

// ── tools/build-level: the Node twin ────────────────────────────────────────

const NAMES = [
  "2019-PS2",
  "2019",
  "StreetFighter",
  "Ramsie",
  "ramsie",
  "hell",
  "broken",
  "staged",
  "nobody",
];

/** fetch-level.js's resolveLevel over TREE, run in a real Node. */
async function nodeResolve(names: string[]): Promise<{
  base: string;
  results: Array<{
    calls: string[];
    key?: string;
    alias?: string | null;
    row?: string;
    code?: string;
  }>;
}> {
  const script = `
    const fl = require(${
    JSON.stringify(
      join(HARBOR, "tools", "build-level", "lib", "fetch-level.js"),
    )
  });
    const tree = JSON.parse(process.argv[1]);
    const names = JSON.parse(process.argv[2]);
    const base = fl.FIREBASE_DB_URL;
    const lookup = new Function("tree", "base", "url", ${
    JSON.stringify(LOOKUP_JS)
  });
    (async () => {
      const results = [];
      for (const name of names) {
        const calls = [];
        const get = (url) => { calls.push(url); return Promise.resolve(lookup(tree, base, url)); };
        try {
          const hit = await fl.resolveLevel(name, get);
          results.push({ calls, key: hit.key, alias: hit.alias, row: hit.data.enemylist[0][0] });
        } catch (e) {
          results.push({ calls, code: e.code || String(e) });
        }
      }
      process.stdout.write(JSON.stringify({ base, results }));
    })();
  `;
  const out = await new Deno.Command("node", {
    args: ["-e", script, JSON.stringify(TREE), JSON.stringify(names)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

Deno.test("build-level's fetch-level.js asks for the same URLs and lands on the same key", async () => {
  const node = await nodeResolve(NAMES);
  assertEquals(node.base, CLOUD_DB);
  for (const [i, name] of NAMES.entries()) {
    const { calls, get } = fakeGet();
    const hit = await resolveCloudLevel(name, { get, accept: hasEnemylist });
    const theirs = node.results[i];
    assertEquals(theirs.calls, calls, name);
    assertScoped(theirs.calls);
    if (hit) {
      assertEquals(theirs.key, hit.key, name);
      assertEquals(theirs.alias, hit.alias, name);
      assertEquals(theirs.row, "shmupX", name);
    } else {
      // index.js exits 3 on this code, and 1 on anything else.
      assertEquals(theirs.code, "LEVEL_NOT_FOUND", name);
    }
  }
});

// ── The Deno builders that fetch() for themselves ───────────────────────────

Deno.test("the cart writers' loadLevel reads shmupX's copy, alias and all", async () => {
  const net = stubFetch();
  try {
    const lines: string[] = [];
    const { record, source } = await loadLevel("2019", (m) => lines.push(m));
    assertEquals(record.enemylist?.[0]?.[0], "shmupX");
    assertEquals(source, `${CLOUD_DB}/shmupX/levels/2019-PS2.json`);
    assert(lines.some((l) => l.includes("alias of shmupX/levels/2019-PS2")));
    // A stages-only record is a level to a cart writer.
    assertEquals(
      (await loadLevel("staged", () => {})).record.name,
      "staged",
    );
    await assertRejects(
      () => loadLevel("hell", () => {}),
      Error,
      'level "hell" not found in shmupX/levels',
    );
    assertScoped(net.calls);
  } finally {
    net.restore();
  }
});

Deno.test("the PS2 builder refuses a name shmupX does not have, before any work", async () => {
  const net = stubFetch();
  try {
    await assertRejects(
      () => buildPs2({ root: repoRoot(), levelName: "hell", log: () => {} }),
      Error,
      'level "hell" not found in shmupX/levels',
    );
    // "staged" has no enemylist, which the PS2 builder needs.
    await assertRejects(
      () => buildPs2({ root: repoRoot(), levelName: "staged", log: () => {} }),
      Error,
      "not found",
    );
    assertEquals(net.calls.slice(0, 3), [
      `${CLOUD_DB}/shmupX/levels/hell.json`,
      `${CLOUD_DB}/shmupX/levelAliases/hell.json`,
      `${CLOUD_DB}/shmupX/levels/staged.json`,
    ]);
    assertScoped(net.calls);
  } finally {
    net.restore();
  }
});

// ── The shelf's cloud rung ──────────────────────────────────────────────────

Deno.test("the shelf finds a shmupX level by alias and hands the typed name on", async () => {
  // An empty checkout: no repo games, no .sav collection, no eShop catalog,
  // so every name falls through to the network rungs.
  const root = await Deno.makeTempDir({ prefix: "shelf-cloud-" });
  const net = stubFetch(SHELF_DB);
  try {
    const hit = await resolveShelfName("StreetFighter", {
      root,
      log: () => {},
    });
    assertEquals(hit.kind, "level");
    assertEquals(hit.levelName, "StreetFighter");
    assertEquals(hit.levelFile, null);
    assertStringIncludes(hit.note, "shmupX/levels/2019-PS2");
    const levelReads = net.calls.filter((u) =>
      /\/levels|\/levelAliases/.test(u)
    );
    assertEquals(levelReads, [
      `${SHELF_DB}/shmupX/levels/StreetFighter.json?shallow=true`,
      `${SHELF_DB}/shmupX/levelAliases/streetfighter.json`,
      `${SHELF_DB}/shmupX/levels/2019-PS2.json?shallow=true`,
    ]);
    // The other shelves are still read at the database's root.
    assert(net.calls.includes(`${SHELF_DB}/eshop/index/streetfighter.json`));
    assert(
      net.calls.includes(`${SHELF_DB}/dezaemon/index/streetfighter.json`),
    );

    // A level only cmg's root holds is not on shmupX's shelf.
    net.calls.length = 0;
    let refused = "";
    try {
      await resolveShelfName("hell", { root, log: () => {} });
    } catch (e) {
      assert(e instanceof ShelfError, String(e));
      refused = e.message;
    }
    assertStringIncludes(refused, 'nothing on the shelf is called "hell"');
    assertScoped(
      net.calls.filter((u) => /\/levels|\/levelAliases/.test(u)),
      SHELF_DB,
    );
  } finally {
    net.restore();
    await Deno.remove(root, { recursive: true });
  }
});
