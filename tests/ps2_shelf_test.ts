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

Deno.test("the Games tile wears the web globe, not the X", async () => {
  const dashboard = await read("svelte-src/Dashboard.svelte");
  assertEquals(dashboard.includes("/x-logo.png"), false);
  assert(dashboard.includes("glyph: 'globe'"));
  assert(dashboard.includes('<svg class="glyph"'));
});
