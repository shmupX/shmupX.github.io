// Level subdomains (lib/level-subdomain.ts, wired in main.ts): the root of
// `<name>.codemonkey.games` goes to the game with that level, or to the
// editor's NEW GAME named for the label when no level has the name.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  cloudLevelKeys,
  hostnameOf,
  matchLevelKey,
  resetLevelKeysCache,
  subdomainOf,
  subdomainRedirect,
  subdomainTarget,
} from "../lib/level-subdomain.ts";

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
  assertEquals(calls, ["https://db.test/levels.json?shallow=true"]);
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
