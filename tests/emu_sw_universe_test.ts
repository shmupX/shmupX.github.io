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
    ]
  ) {
    assertEquals(
      matchPrefix(mirrorable, new URL(pathname, "https://x").pathname),
      false,
      `${pathname} must not be claimed by MIRRORABLE`,
    );
  }
});
