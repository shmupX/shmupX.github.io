// The PlayStation 2 section lists what this machine built and what the eShop
// installed on it — never the mirror's shelf.
//
// cmg's /PlayStation2/manifest.json lists three AthenaEnv discs beside browser
// builds of the same games. The discs come up black under Play!'s HLE kernel
// (README: AthenaEnv stalls in init_taskman), so a core installed from
// Settings → Emulators, or by the first export, used to put six rows on the
// shelf of which three could not play. The catalogue entry now reads no
// manifest, svelte-src/Dashboard.svelte's emuNote explains the empty shelf
// instead of "fetching undefined", and Sh'M↑ Party's browser build comes in
// through the eShop and is filed on the section by its `shelf`.

import { assert, assertEquals } from "@std/assert";
import { normalizePs2Web, ps2WebUrl } from "../static/ps2-library.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

Deno.test("the ps2 core reads no mirror shelf", async () => {
  const catalog = JSON.parse(await read("static/emulators.json"));
  const core = (catalog.cores ?? []).find((c: { id: string }) =>
    c.id === "ps2"
  );
  assert(core, "static/emulators.json lists no ps2 core");
  assertEquals(
    "manifest" in core,
    false,
    "a manifest would shelve the mirror's PS2 games on install",
  );
  // The browser builds that manifest pointed at are not mirrored either:
  // nothing asks the cmg origin for them any more.
  assertEquals(
    (core.prefixes ?? []).filter((p: string) => p.startsWith("/games/")),
    [],
  );
});

Deno.test("the dashboard explains the empty PS2 shelf and files eShop builds on it", async () => {
  const dashboard = await read("svelte-src/Dashboard.svelte");
  assert(
    dashboard.includes("if (core.id === 'ps2') {"),
    "emuNote has no ps2 branch, so an empty shelf would say 'fetching undefined'",
  );
  assert(
    dashboard.includes("...eshopShelfRows(core)"),
    "coreRows does not spread the eShop's shelved builds",
  );
  assert(
    dashboard.includes("if (row.kind === 'eshop-web') { launchEshopWeb(row.g); return; }"),
    "launchEmuRow cannot start a shelved eShop build",
  );
});

Deno.test("a filed disc names its web build by a key the launcher resolves itself", () => {
  assertEquals(
    ps2WebUrl({ kind: "level", level: "Foo's Game #2" }),
    "/games/2028-ai?level=Foo's%20Game%20%232",
  );
  assertEquals(
    ps2WebUrl({ kind: "shelf", shelfId: "import:test-cart" }),
    "/editor/?game=2028-ai&playExport=import%3Atest-cart",
  );
  assertEquals(ps2WebUrl({ kind: "slug", slug: "radiant" }), "/editor/?game=2028-ai&play=radiant");
  // A record from before the field, and a job somebody wrote a URL into: no row.
  assertEquals(ps2WebUrl(undefined), null);
  assertEquals(ps2WebUrl({ url: "https://example.com/" }), null);
  assertEquals(ps2WebUrl({ kind: "level", level: "" }), null);
  assertEquals(ps2WebUrl({ kind: "level", level: 42 }), null);
  assertEquals(
    normalizePs2Web({ kind: "level", level: " x ", url: "https://example.com/" }),
    { kind: "level", level: "x" },
  );
});

Deno.test("every surface that files a disc passes its web build along, and the launcher pairs them", async () => {
  const dashboard = await read("svelte-src/Dashboard.svelte");
  assert(dashboard.includes("key: 'local-web:' + g.id"), "localRows does not add the web row");
  assert(
    dashboard.includes("if (row.kind === 'ps2-web' && row.url) { launchGame('shmupx', row.url); return; }"),
    "launchEmuRow cannot start a disc's web build",
  );
  assert(dashboard.includes("web: job.web });"), "fileExportToPs2 drops the identity");
  assert(dashboard.includes("{:else if r.kind === 'ps2-web'}"), "the web row wears no WEB chip");
  const editor = await read("static/editor/index.html");
  assert(editor.includes('id="export-ps2-web"'), "the export panel has no PLAY WEB BUILD row");
  assert(editor.includes("web: ps2Export.web,"), "addPs2ExportToLibrary drops the identity");
  assert(editor.includes("web: job.web,"), "fileQueuedPs2 drops the identity");
  assert(editor.includes("const web = ps2WebIdentity(sav, name);"), "the export never settles an identity");
  const queue = await read("static/export-queue.js");
  assert(queue.includes("job.web = web"), "a queued job does not carry the identity");
});

Deno.test("the game page honours an explicit ?level= instead of baking foo.json over it", async () => {
  // The web row for a cloud level is /games/2028-ai?level=<name>. The bundle's
  // main() used to preload foo.json into globalThis.__OFFLINE_LEVEL__ for every
  // visit, and the level loader returns that record before it reads the name,
  // so the row would have played 2028.Ai for every level.
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const main = bundle.slice(bundle.indexOf("async function main() {"));
  const skip = main.indexOf('.get("level")');
  const bake = main.indexOf("__OFFLINE_LEVEL__ = await fetchLevel2(LEVEL_DATA_URL)");
  assert(skip >= 0, "main() never reads ?level=");
  assert(bake >= 0, "main() no longer bakes foo.json for a plain visit");
  assert(skip < bake, "main() bakes foo.json before it checks for an explicit level");
});

Deno.test("the Games tile wears the web globe, not the X", async () => {
  const dashboard = await read("svelte-src/Dashboard.svelte");
  assertEquals(dashboard.includes("/x-logo.png"), false);
  assert(dashboard.includes("glyph: 'globe'"));
  assert(dashboard.includes('<svg class="glyph"'));
});
