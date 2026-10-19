// Level subdomains (lib/level-subdomain.ts, wired in main.ts): the root of
// `<name>.codemonkey.games` goes to the game with that level, or to the
// editor's NEW GAME named for the label when no level has the name.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  cloudLevelAliases,
  cloudLevelKeys,
  hostnameOf,
  isAliasName,
  matchLevelKey,
  planAliases,
  resetLevelKeysCache,
  subdomainOf,
  subdomainRedirect,
  subdomainTarget,
} from "../lib/level-subdomain.ts";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";

const KEYS = [
  "2019-PS2",
  "2028",
  "Ramsie",
  "ramsie",
  "Choh Parody Spirit Twin Ex_Sound ver",
];

Deno.test("the label is read off the Host, without port, case or a www", () => {
  assertEquals(
    hostnameOf("2019-PS2.codemonkey.games:443"),
    "2019-ps2.codemonkey.games",
  );
  assertEquals(hostnameOf("[::1]:5173"), "::1");
  assertEquals(hostnameOf("a.codemonkey.games, proxy"), "a.codemonkey.games");
  assertEquals(subdomainOf("2019-ps2.codemonkey.games"), "2019-ps2");
  assertEquals(subdomainOf("2019-PS2.codemonkey.games:443"), "2019-ps2");
  assertEquals(subdomainOf("daioh.localhost:5173"), "daioh");
  assertStrictEquals(subdomainOf("codemonkey.games"), null);
  assertStrictEquals(subdomainOf("www.codemonkey.games"), null);
  assertStrictEquals(subdomainOf("a.b.codemonkey.games"), null);
  assertStrictEquals(subdomainOf("shmupx.easierbycode.deno.net"), null);
  assertStrictEquals(subdomainOf("192.168.1.20:8000"), null);
  assertStrictEquals(subdomainOf("-bad.codemonkey.games"), null);
  assertStrictEquals(subdomainOf(null), null);
  assertEquals(subdomainOf("x.example.test", ["example.test"]), "x");
});

Deno.test("a label finds its level exactly, then by case, ties resolved the same way every time", () => {
  assertEquals(matchLevelKey("2028", KEYS), "2028");
  assertEquals(matchLevelKey("2019-ps2", KEYS), "2019-PS2");
  assertEquals(matchLevelKey("ramsie", KEYS), "ramsie");
  assertEquals(matchLevelKey("RAMSIE", KEYS), "Ramsie");
  assertStrictEquals(matchLevelKey("nobody", KEYS), null);
});

Deno.test("a known level goes to the game, an unknown one to NEW GAME under its name, no listing to the game", () => {
  assertEquals(
    subdomainTarget("2019-ps2", KEYS),
    "/games/2028-ai?level=2019-PS2",
  );
  assertEquals(
    subdomainTarget("my-first-level", KEYS),
    "/editor/?new=my-first-level",
  );
  assertEquals(
    subdomainTarget("2019-ps2", null),
    "/games/2028-ai?level=2019-ps2",
  );
});

Deno.test("the visitor's own query rides along — all of it but the level the label decides", () => {
  assertEquals(
    subdomainTarget("2019-ps2", KEYS, {}, "?god=1&stage=1"),
    "/games/2028-ai?level=2019-PS2&god=1&stage=1",
  );
  assertEquals(
    subdomainTarget("2019-ps2", KEYS, {}, "?level=other&god=1"),
    "/games/2028-ai?level=2019-PS2&god=1",
  );
  assertEquals(
    subdomainTarget("my-first-level", KEYS, {}, "?new=x&theme=dark"),
    "/editor/?new=my-first-level&theme=dark",
  );
  assertEquals(
    subdomainTarget("2019-ps2", null, {}, "?god=1"),
    "/games/2028-ai?level=2019-ps2&god=1",
  );
  const r = subdomainRedirect(
    new Request("http://x/?god=1", {
      headers: { host: "2019-ps2.codemonkey.games" },
    }),
    KEYS,
  )!;
  assertEquals(r.headers.get("location"), "/games/2028-ai?level=2019-PS2&god=1");
});

Deno.test("only a subdomain's root is redirected, on GET and HEAD, honouring X-Forwarded-Host", () => {
  const req = (
    url: string,
    host: string,
    extra: Record<string, string> = {},
    method = "GET",
  ) => new Request(url, { method, headers: { host, ...extra } });
  const r = subdomainRedirect(
    req("http://x/", "2019-ps2.codemonkey.games"),
    KEYS,
  )!;
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), "/games/2028-ai?level=2019-PS2");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(
    subdomainRedirect(
      req("http://x/index.html", "new-one.codemonkey.games"),
      KEYS,
    )!.headers.get("location"),
    "/editor/?new=new-one",
  );
  assertEquals(
    subdomainRedirect(req("http://x/", "x.codemonkey.games", {}, "HEAD"), KEYS)!
      .status,
    302,
  );
  assertStrictEquals(
    subdomainRedirect(req("http://x/", "x.codemonkey.games", {}, "POST"), KEYS),
    null,
  );
  assertStrictEquals(
    subdomainRedirect(req("http://x/editor/", "x.codemonkey.games"), KEYS),
    null,
  );
  assertStrictEquals(
    subdomainRedirect(
      req("http://x/games/2028-ai", "x.codemonkey.games"),
      KEYS,
    ),
    null,
  );
  assertStrictEquals(
    subdomainRedirect(req("http://x/", "codemonkey.games"), KEYS),
    null,
  );
  assertStrictEquals(
    subdomainRedirect(req("http://x/", "www.codemonkey.games"), KEYS),
    null,
  );
  // The dev tunnel rewrites Host and keeps the browser's in X-Forwarded-Host.
  assertEquals(
    subdomainRedirect(
      req("http://x/", "127.0.0.1:5173", {
        "x-forwarded-host": "2028.codemonkey.games",
      }),
      KEYS,
    )!
      .headers.get("location"),
    "/games/2028-ai?level=2028",
  );
});

Deno.test("the level listing is one shallow read, cached for a minute, and survives an outage once warm", async () => {
  resetLevelKeysCache();
  const calls: string[] = [];
  let clock = 1_000;
  let fail = false;
  const fetcher = ((input: string | URL | Request) => {
    calls.push(String(input));
    if (fail) return Promise.resolve(new Response("boom", { status: 500 }));
    return Promise.resolve(
      new Response(JSON.stringify({ "2019-PS2": true, Daioh: true })),
    );
  }) as typeof fetch;
  const now = () => clock;
  assertEquals(await cloudLevelKeys("https://db.test", fetcher, now), [
    "2019-PS2",
    "Daioh",
  ]);
  // The db is the database's base; shmupX's levels are a subtree of it.
  assertEquals(calls, ["https://db.test/shmupX/levels.json?shallow=true"]);
  clock += 30_000;
  await cloudLevelKeys("https://db.test", fetcher, now);
  assertEquals(calls.length, 1, "served from the cache inside a minute");
  clock += 31_000;
  fail = true;
  assertEquals(await cloudLevelKeys("https://db.test", fetcher, now), [
    "2019-PS2",
    "Daioh",
  ]);
  assertEquals(
    calls.length,
    2,
    "re-read after a minute, stale copy kept on failure",
  );
  resetLevelKeysCache();
  assertStrictEquals(
    await cloudLevelKeys("https://db.test", fetcher, now),
    null,
  );
});

// ---- aliases ------------------------------------------------------------------

const ALIASES = { "2019": "2019-PS2", streetfighter: "2019-PS2", gone: "Nope" };

const req = (url: string, host: string) =>
  new Request(url, { headers: { host } });

Deno.test("an alias names its level after every key has had its chance", () => {
  assertEquals(matchLevelKey("2019", KEYS, ALIASES), "2019-PS2");
  assertEquals(matchLevelKey("StreetFighter", KEYS, ALIASES), "2019-PS2");
  // A level's own name always wins over an alias spelled the same.
  assertEquals(matchLevelKey("2028", KEYS, { "2028": "2019-PS2" }), "2028");
  // An alias whose level is gone names nothing.
  assertStrictEquals(matchLevelKey("gone", KEYS, ALIASES), null);
  assertStrictEquals(matchLevelKey("toString", KEYS, ALIASES), null);
});

Deno.test("an alias subdomain opens its level, even with the listing down", () => {
  assertEquals(
    subdomainTarget("streetfighter", KEYS, ALIASES),
    "/games/2028-ai?level=2019-PS2",
  );
  assertEquals(
    subdomainTarget("2019", null, ALIASES),
    "/games/2028-ai?level=2019-PS2",
  );
  assertEquals(
    subdomainRedirect(req("http://x/", "2019.codemonkey.games"), KEYS, ALIASES)!
      .headers.get("location"),
    "/games/2028-ai?level=2019-PS2",
  );
});

Deno.test("the alias index is one read, cached, and keeps only well-formed names", async () => {
  resetLevelKeysCache();
  const calls: string[] = [];
  let clock = 0;
  const fetcher = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          "2019": "2019-PS2",
          "Bad Name": "2019-PS2",
          numeric: 7,
          streetfighter: "2019-PS2",
        }),
      ),
    );
  }) as typeof fetch;
  const now = () => clock;
  assertEquals(await cloudLevelAliases("https://db.test", fetcher, now), {
    "2019": "2019-PS2",
    streetfighter: "2019-PS2",
  });
  assertEquals(calls, ["https://db.test/shmupX/levelAliases.json"]);
  clock += 30_000;
  await cloudLevelAliases("https://db.test", fetcher, now);
  assertEquals(calls.length, 1, "served from the cache inside a minute");
  resetLevelKeysCache();
});

Deno.test("planAliases adds labels no level owns and refuses the rest", () => {
  assertEquals(isAliasName("2019"), true);
  assertEquals(isAliasName("www"), false);
  assertEquals(isAliasName("street fighter"), false);
  const ok = planAliases("2019-ps2", ["2019", "StreetFighter"], KEYS, {});
  assertEquals(ok, {
    key: "2019-PS2",
    set: { "2019": "2019-PS2", streetfighter: "2019-PS2" },
    errors: [],
  });
  // Already its own: nothing to write, nothing wrong.
  assertEquals(planAliases("2019-PS2", ["2019"], KEYS, ALIASES).set, {});
  const bad = planAliases("2019-PS2", ["2028", "gone", "a_b"], KEYS, ALIASES);
  assertEquals(bad.set, {});
  assertEquals(bad.errors.length, 3);
  assertEquals(planAliases("nobody", ["x"], KEYS, {}).errors, [
    'no level is called "nobody"',
  ]);
});

// The browser SDK cannot take a databaseURL with a path in it, so the
// loader spells the shmupX root into its ref() paths: shmupX/levels and
// shmupX/levelAliases, never the root-level copies cmg keeps.
Deno.test("?level=<alias> loads the level the alias names, by its key", async () => {
  const records: Record<string, unknown> = {
    "shmupX/levels/2019-PS2": { name: "2019", enemylist: [["00"]] },
    "shmupX/levelAliases/streetfighter": "2019-PS2",
    // cmg's root copies: a loader that read these would be reading cmg's game.
    "levels/StreetFighter": { name: "cmg's", enemylist: [["00"]] },
    "levelAliases/nobody": "2019-PS2",
  };
  const reads: string[] = [];
  const firebase = {
    apps: [{}],
    database: () => ({
      ref: (path: string) => ({
        once: () => {
          reads.push(path);
          return Promise.resolve({ val: () => records[path] ?? null });
        },
      }),
    }),
  };
  const Plugin = createLevelLoaderPlugin({
    Plugins: { ScenePlugin: class {} },
  });
  const plugin = new Plugin({}, null, "levelLoader");
  const data = await plugin.fetchLevel("StreetFighter", {
    firebase,
    offlineLevel: null,
  });
  assertEquals(data.name, "2019");
  assertEquals(plugin.resolvedLevelName, "2019-PS2");
  assertEquals(reads, [
    "shmupX/levels/StreetFighter",
    "shmupX/levelAliases/streetfighter",
    "shmupX/levels/2019-PS2",
  ]);
  // A name that is neither a key nor an alias is still "not found".
  let missing = "";
  await plugin.fetchLevel("nobody", { firebase, offlineLevel: null })
    .catch((err: Error) => (missing = err.message));
  assertEquals(missing, 'Level "nobody" not found');
});

Deno.test("the bundle's inlined loader looks aliases up the way the plugin does", async () => {
  const read = (p: string) =>
    Deno.readTextFile(new URL(`../${p}`, import.meta.url));
  const plugin = await read("static/phaser-plugins/level-loader.js");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const fetchLevel = (js: string) => {
    // From the lookup on: esbuild respells the lines above it (void 0).
    const start = js.indexOf(
      "const levelsPath = o.levelsPath || DEFAULTS.levelsPath;",
    );
    const end = js.indexOf("// ---- Atlas merge", start);
    assertEquals(start > 0 && end > start, true, "no fetchLevel");
    return js.slice(start, end).replace(/\s+/g, " ").trim();
  };
  assertEquals(fetchLevel(bundle), fetchLevel(plugin));
  for (
    const line of [
      'levelsPath: "shmupX/levels",',
      'aliasesPath: "shmupX/levelAliases",',
      "const levelKey = this.resolvedLevelName || levelName;",
      "levelName: levelKey,",
    ]
  ) {
    assertEquals(plugin.includes(line), true, "the plugin lacks: " + line);
    assertEquals(bundle.includes(line), true, "the bundle lacks: " + line);
  }
});
