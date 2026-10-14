// The Nintendo 64DD player, and the copies it leans on.
//
// static/n64dd/play.html is the second core in static/emulators.json served
// by THIS origin instead of by the cmg mirror, and like the Super Famicom's
// (tests/snes_player_test.ts) it rests on facts spread across files that
// cannot import each other: the catalogue says the core is `local` with no
// prefixes, the worker's MIRRORABLE list leaves /n64dd/ alone, the page's
// RECIPE names the files the way static/n64dd-library.js, lib/dezaemon-n64.ts
// and scripts/stage-dezaemon-n64.ts name them, and the editor's → PLAY 64DD
// row imports that library. Any one drifting is a black screen in a player's
// browser, so they are checked against each other rather than trusted.
//
// It also pins what no code can: the staged cartridge and IPL are gitignored
// (neither is ours to ship) while the translation patch beside them is not.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEZAEMON_N64_PATCH_FILE,
  DEZAEMON_N64_PATCH_URL,
  DEZAEMON_N64_ROM_NAME,
  DEZAEMON_N64_TITLE,
  N64DD_IPL_NAME,
} from "../lib/dezaemon-n64.ts";
import { emuStateFor } from "../static/ps2-library.js";
import {
  N64DD_CORE_ID,
  N64DD_DISK_URL,
  N64DD_PLAYER,
  N64DD_ROM_TITLE,
  N64DD_ROM_URL,
  N64DD_STATIC_IPL,
  N64DD_STATIC_ROM,
  n64ddPlayerUrl,
} from "../static/n64dd-library.js";

// deno-lint-ignore no-explicit-any
type Any = any;

const repo = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => Deno.readTextFile(repo(p));

async function exists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(repo(p))).isFile;
  } catch {
    return false;
  }
}

const catalog = JSON.parse(await read("static/emulators.json"));
const core = (catalog.cores ?? []).find((c: Any) => c.id === N64DD_CORE_ID);
const player = await read("static/n64dd/play.html");
const recipe = (() => {
  const m = player.match(/var RECIPE = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error("no RECIPE object in static/n64dd/play.html");
  const out: Record<string, string> = {};
  for (const [, k, v] of m[1].matchAll(/^\s*(\w+): "([^"]*)",/gm)) out[k] = v;
  return out;
})();

Deno.test("the Nintendo 64DD core is local, says so, and claims no mirror paths", () => {
  assert(core, "static/emulators.json lists no n64dd core");
  assertEquals(
    core.local,
    true,
    "served from this origin; without `local` the installer would wait on a service worker",
  );
  assertEquals(
    core.prefixes,
    [],
    "a local core carries no prefixes — a mirrored /n64dd/ would shadow this origin's own page",
  );
  assertEquals(core.player, N64DD_PLAYER);
  assertEquals(core.player, "/n64dd/play.html");
  // The worker's state never includes a local core, so /n64dd/ is never mirrored.
  const state = emuStateFor(catalog, [N64DD_CORE_ID]);
  assertEquals(state.prefixes, []);
  assertEquals(state.isolated, []);
});

Deno.test("the dashboard's tile for the core explains its empty shelf", async () => {
  // Installing the core — from Settings, or by the editor's PLAY 64DD row —
  // gives the launcher a NINTENDO 64DD tile with nothing to list, and a core
  // without a manifest falls through emuNote to "READING SHELF… Fetching
  // undefined", a state nothing resolves (tests/ps2_shelf_test.ts pins the
  // same trap for ps2). The branch below is what keeps that off the screen.
  const dashboard = await read("svelte-src/Dashboard.svelte");
  assert(
    dashboard.includes("if (core.id === 'n64dd') {"),
    "emuNote has no n64dd branch, so an empty shelf would say 'fetching undefined'",
  );
  assertStringIncludes(dashboard, "PLAY 64DD");
});

Deno.test("the worker's MIRRORABLE list leaves /n64dd/ alone", async () => {
  const worker = await read("static/emu-sw.js");
  const block = worker.match(/const MIRRORABLE = \[([\s\S]*?)\];/);
  assert(block, "no MIRRORABLE list in static/emu-sw.js");
  const mirrorable = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert(
    !mirrorable.some((p) => "/n64dd/play.html".startsWith(p)),
    "/n64dd/ must not be mirrored from cmg",
  );
});

Deno.test("the player, the library, the route and the stage script name the same files", async () => {
  assert(await exists("static/n64dd/play.html"));
  assertEquals(
    recipe.romName,
    DEZAEMON_N64_ROM_NAME,
    "the cartridge's name inside the core is the route's file name",
  );
  assertEquals(
    N64DD_STATIC_ROM.split("/").pop(),
    DEZAEMON_N64_ROM_NAME,
    "and the staged copy's",
  );
  assertEquals(N64DD_STATIC_IPL.split("/").pop(), N64DD_IPL_NAME);
  assertEquals(
    recipe.diskName,
    recipe.romName + ".ndd",
    "the disk is the cartridge's full content name plus .ndd, what mupen64plus-next opens beside it",
  );
  assertEquals(
    recipe.diskSaveName,
    recipe.diskName + ".disk_save",
    "the core's full-copy save of the disk",
  );
  assertEquals(
    recipe.iplPath,
    "/Mupen64plus/IPL.n64",
    "the hard-coded IPL path under the core's system directory, which EmulatorJS resolves to /",
  );
  assertEquals(
    recipe.core,
    "n64",
    "EmulatorJS's n64 resolves to mupen64plus_next",
  );
  assertStringIncludes(
    player,
    "EJS_externalFiles",
    "the disk and the IPL are written through externalFiles, as bytes",
  );
  assert(
    !player.includes("EJS_biosUrl"),
    "not as a BIOS: 4.2.3's bios path cannot take a File and cannot write a subdirectory",
  );
  assertStringIncludes(
    recipe.pathtodata,
    recipe.ejsVersion,
    "loader and core move together",
  );
  const vendor = await read("scripts/vendor-emulatorjs.ts");
  assertStringIncludes(
    vendor,
    `const VERSION = "${recipe.ejsVersion}"`,
    "the CDN version is the one the vendored copy pins",
  );
  // the stage script writes the pair the library HEADs for
  const stage = await read("scripts/stage-dezaemon-n64.ts");
  assertStringIncludes(stage, 'join(ROOT, "static", "n64dd")');
  assertStringIncludes(stage, "DEZAEMON_N64_ROM_NAME");
  assertStringIncludes(stage, "N64DD_IPL_NAME");
  assertEquals(N64DD_ROM_TITLE, DEZAEMON_N64_TITLE);
  assertEquals(N64DD_ROM_URL, "/api/dezaemon-n64");
  assertEquals(N64DD_DISK_URL, "/api/n64dd-disk");
  assert(await exists("routes/api/dezaemon-n64.ts"));
  assert(await exists("routes/api/n64dd-disk.ts"));
  assert(
    await exists(`static/n64dd/${DEZAEMON_N64_PATCH_FILE}`),
    "the translation patch is in the repo",
  );
  assertEquals(DEZAEMON_N64_PATCH_URL, `/n64dd/${DEZAEMON_N64_PATCH_FILE}`);
});

Deno.test("the player's URL carries the three files as same-site paths, which is all the page accepts", () => {
  const url = n64ddPlayerUrl({
    rom: "/api/dezaemon-n64?rom=1",
    ipl: "/api/dezaemon-n64?ipl=1",
    disk: "/api/n64dd-disk?file=a%20b.ndd",
    name: "TINY",
  });
  const q = new URL(url, "http://localhost").searchParams;
  assertEquals(q.get("rom"), "/api/dezaemon-n64?rom=1");
  assertEquals(q.get("ipl"), "/api/dezaemon-n64?ipl=1");
  assertEquals(q.get("disk"), "/api/n64dd-disk?file=a%20b.ndd");
  assertEquals(q.get("name"), "TINY");
  assert(url.startsWith(N64DD_PLAYER + "?"));
  assertStringIncludes(
    player,
    "/^\\/[^/]/.test(",
    "the page refuses anything but a path on this site",
  );
});

Deno.test("the editor's PLAY 64DD row reaches the player through the library", async () => {
  const editor = await read("static/editor/index.html");
  assertStringIncludes(editor, "import('/n64dd-library.js')");
  assertStringIncludes(editor, 'id="n64-disk-play"');
  assertStringIncludes(editor, "storeN64ddDisk(");
  assertStringIncludes(editor, "n64ddPlayerUrl(");
  assertStringIncludes(editor, "ensureN64ddCore(");
});

Deno.test("the staged cartridge and IPL are gitignored; the patch is not", async () => {
  const check = async (path: string) => {
    const p = new Deno.Command("git", {
      args: ["check-ignore", "-q", path],
      cwd: repo(".").pathname,
      stdout: "null",
      stderr: "null",
    });
    return (await p.output()).code === 0;
  };
  assert(
    await check(N64DD_STATIC_ROM.replace(/^\//, "static/")),
    "static/n64dd/Dezaemon3D.z64 must be ignored: Athena's cartridge is not ours to ship",
  );
  assert(
    await check(N64DD_STATIC_IPL.replace(/^\//, "static/")),
    "static/n64dd/64DD_IPL.n64 must be ignored: Nintendo's IPL is not ours to ship",
  );
  assert(
    !(await check(`static/n64dd/${DEZAEMON_N64_PATCH_FILE}`)),
    "the translation patch is committed",
  );
  assert(!(await check("static/n64dd/play.html")));
});
