// Settings → VERSION: the row that says which copy of shmupX this is.
//
// It reads three values from two sources, and neither source knows the row
// exists. The release comes from /api/update (`Deno.desktopVersion`, which only
// a packaged launcher has); the commit and the build time come from the stamp
// scripts/build-games-manifest.ts writes into static/games.manifest.json, which
// every copy refetches on load. Drop either half of that stamp and the row
// still renders — it just quietly stops identifying anything, which is the one
// failure a version row cannot have.
//
// So the stamp's shape is pinned here, and the committed bundle is checked for
// the row itself: svelte-src/Dashboard.svelte is only ever served through
// static/dashboard.bundle.js, so an unbuilt edit ships nothing.

import { assert, assertEquals, assertMatch } from "@std/assert";

const read = async (path: string) =>
  await Deno.readTextFile(new URL("../" + path, import.meta.url));

Deno.test("the manifest carries the commit and the time the row reads", async () => {
  const manifest = JSON.parse(await read("static/games.manifest.json"));

  // A git short SHA, or the content hash gitShortSha() falls back to where git
  // is not available — both hex, and both what the row prints after "build".
  assertEquals(typeof manifest.version, "string");
  assertMatch(
    manifest.version,
    /^[0-9a-f]{7,40}$/,
    "the manifest's version is what VERSION shows as the commit",
  );

  // An ISO instant, because the row formats it with `new Date(...)` and an
  // unparseable one renders as nothing rather than as an error.
  assertEquals(typeof manifest.generatedAt, "string");
  const at = new Date(manifest.generatedAt);
  assert(
    !Number.isNaN(at.getTime()),
    `generatedAt must parse as a date; got ${manifest.generatedAt}`,
  );
  assertEquals(
    at.toISOString(),
    manifest.generatedAt,
    "generatedAt is written by new Date().toISOString()",
  );
});

Deno.test("the committed dashboard bundle carries the VERSION row", async () => {
  const bundle = await read("static/dashboard.bundle.js");
  assert(
    bundle.includes("VERSION"),
    "stale bundle: run `deno task dashboard:build`",
  );
  // The row's own fallback line, which is the half of it that only appears
  // when the manifest did not load — and therefore the half a partial rebuild
  // would drop without the label above noticing.
  assert(
    bundle.includes("the manifest did not load"),
    "stale bundle: the VERSION row's offline wording is missing",
  );
});
