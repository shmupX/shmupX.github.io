// static/emu-sw.js has to decide whether a path could belong to an emulator
// core SYNCHRONOUSLY: the request that starts a stopped worker cannot wait for
// the Cache Storage read that says which cores are installed, and a navigation
// the worker answers with a failed fetch is a network error the browser cannot
// retry. So the worker carries MIRRORABLE, the fixed set of paths the catalogue
// could ever hand it, and returns every other request to the browser untouched.
//
// That list is a copy of what emuStateFor (static/ps2-library.js) derives from
// static/emulators.json: each core's prefixes and icon, plus the catalogue's
// shared entries. Adding a core to the catalogue without adding its paths here
// would leave it permanently unmirrored — a 404 on this origin with nothing to
// explain it — so the copy is checked instead of trusted.

import { assertEquals } from "@std/assert";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../static/${p}`, import.meta.url));

function mirrorableList(worker: string): string[] {
  const block = worker.match(/const MIRRORABLE = \[([\s\S]*?)\];/);
  if (!block) throw new Error("no MIRRORABLE list in static/emu-sw.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// The worker's own matcher, so the test agrees with it by construction.
const matchPrefix = (list: string[], pathname: string) =>
  list.some((p) => pathname === p || pathname.startsWith(p));

Deno.test("MIRRORABLE covers every path the catalogue can install", async () => {
  const catalog = JSON.parse(await read("emulators.json"));
  const mirrorable = mirrorableList(await read("emu-sw.js"));

  const wanted = new Set<string>(catalog.shared ?? []);
  for (const core of catalog.cores ?? []) {
    for (const prefix of core.prefixes ?? []) wanted.add(prefix);
    if (core.icon) wanted.add(core.icon);
  }

  const uncovered = [...wanted].filter((p) => !matchPrefix(mirrorable, p));
  assertEquals(
    uncovered,
    [],
    "these static/emulators.json paths are missing from MIRRORABLE in " +
      "static/emu-sw.js, so they would never be mirrored",
  );
});

Deno.test("MIRRORABLE claims nothing the catalogue does not", async () => {
  const catalog = JSON.parse(await read("emulators.json"));
  const mirrorable = mirrorableList(await read("emu-sw.js"));

  const known = new Set<string>(catalog.shared ?? []);
  for (const core of catalog.cores ?? []) {
    for (const prefix of core.prefixes ?? []) known.add(prefix);
    if (core.icon) known.add(core.icon);
  }

  // An entry no core asks for widens the set of requests a cold worker holds
  // on to, which is the cost this list exists to avoid.
  const stale = mirrorable.filter((p) => !known.has(p));
  assertEquals(stale, [], "these MIRRORABLE entries are in no core's paths");
});

Deno.test("the site's own pages are outside MIRRORABLE", async () => {
  const mirrorable = mirrorableList(await read("emu-sw.js"));

  // The regression this guards: the launcher, the level editor and the game
  // the editor hands off to must never be answered by the worker. A worker
  // that owned them turned a transient failure into an unrecoverable one.
  for (
    const pathname of [
      "/",
      "/editor/",
      "/games/2028-ai",
      "/games/2028-ai?editorPlay=1&stage=0&god=1",
      "/api/build-artifact",
      "/dashboard.bundle.js",
      "/icons/2028-icon.png",
      "/phaser-plugins/level-loader.js",
      "/api/eshop/zip?repo=easierbycode/shmup-party-ps2&branch=main",
      "/api/dezaemon-disc?zip=1",
    ]
  ) {
    assertEquals(
      matchPrefix(mirrorable, new URL(pathname, "https://x").pathname),
      false,
      `${pathname} must not be claimed by MIRRORABLE`,
    );
  }
});

// The eShop's installed web games are served by the same worker, from their
// own cache (C3 of the redesign: "/eshop/<id>/<relpath>" keys in
// "shmupx-eshop-v1"). That is a separate branch of the fetch handler, not a
// MIRRORABLE prefix: MIRRORABLE gates the emulator mirror, which fetches
// misses from the cmg origin, and an eShop path must never be sent there.
// So the invariant has two halves — the prefix is outside MIRRORABLE, and the
// worker still handles it, ahead of the MIRRORABLE check.
Deno.test("/eshop/ is outside MIRRORABLE but handled by the eshop branch", async () => {
  const worker = await read("emu-sw.js");
  const mirrorable = mirrorableList(worker);

  const eshopPath = "/eshop/shmup-party-ps2/play/index.html";
  assertEquals(
    matchPrefix(mirrorable, eshopPath),
    false,
    "an installed eShop game must not be mirrored from the cmg origin",
  );

  // The names the library side (static/eshop-library.js) shares with the
  // worker: the cache it fills and the URL space the worker answers from it.
  assertEquals(
    /const ESHOP_CACHE = "shmupx-eshop-v1";/.test(worker),
    true,
    "emu-sw.js must read the eShop cache eshop-library.js writes",
  );
  assertEquals(
    /const ESHOP_PREFIX = "\/eshop\/";/.test(worker),
    true,
    "emu-sw.js must answer the /eshop/ prefix",
  );

  // Inside the fetch handler, the eShop branch has to come before the
  // MIRRORABLE check — that check returns without respondWith(), which would
  // hand every /eshop/ request to the browser (a 404 on this origin).
  const fetchHandler = worker.slice(worker.indexOf('addEventListener("fetch"'));
  const eshopAt = fetchHandler.indexOf("startsWith(ESHOP_PREFIX)");
  const mirrorableAt = fetchHandler.indexOf("matchPrefix(MIRRORABLE");
  assertEquals(eshopAt > 0, true, "the fetch handler must test ESHOP_PREFIX");
  assertEquals(
    eshopAt < mirrorableAt,
    true,
    "the eshop branch must run before the MIRRORABLE check",
  );
});
