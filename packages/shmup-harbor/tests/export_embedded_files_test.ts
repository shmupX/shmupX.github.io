// The packaged desktop app exports games out of a read-only deno-compile VFS:
// `deno compile --include` decides what is IN the binary, and
// stageEmbeddedRuntime decides what is copied back OUT onto real disk for
// `node tools/build-level` to read. Those were two hand-kept lists of the same
// loose static/ files, and the tool's side reads every one of them through
// existsSync — so a name present in the tool and absent from the lists is not
// an error anywhere. The export succeeds and the feature is simply gone.
//
// That is exactly what happened to static/phaser-plugins/extract-mode.js: it
// was wired into tools/build-level and into neither list, so every app exported
// from inside the packaged app (android/ios/linux/windows/mac) shipped without
// EXTRACT MODE, silently. The two lists are now one exported constant, and
// these tests pin the three things that can still rot:
//
//   1. a name in the list that is not a real file in the checkout,
//   2. a loose file the tool reads that the list does not name (how this bug
//      got in — the tool grew a fourth read),
//   3. the embed side going back to hand-listing files instead of reading the
//      constant (how it would get in again).
//
// Note which root each half hangs off: the tool and the build script moved down
// into packages/shmup-harbor, but the files they name did not — those are the
// checkout's static/, which is why the list is repo-relative and the scans are
// harbor-relative.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { EMBEDDED_LOOSE_FILES } from "../lib/export-build.ts";
import { harborRoot, repoRoot } from "../lib/repo-root.ts";

/** The list as posix-ish paths, which is how both consumers name the files. */
const listed = EMBEDDED_LOOSE_FILES.map((rel) => rel.join("/"));

Deno.test("every embedded loose file exists in the checkout", async () => {
  for (const rel of EMBEDDED_LOOSE_FILES) {
    const path = join(repoRoot(), ...rel);
    const stat = await Deno.stat(path).catch(() => null);
    assert(stat?.isFile, `EMBEDDED_LOOSE_FILES names a missing file: ${path}`);
  }
});

Deno.test("EXTRACT MODE travels with the packaged export tool", () => {
  assert(
    listed.includes("static/phaser-plugins/extract-mode.js"),
    "extract-mode.js dropped out of EMBEDDED_LOOSE_FILES — apps exported from " +
      "inside the packaged app lose EXTRACT MODE with no error anywhere",
  );
});

Deno.test("the list names every loose file tools/build-level reads off CMG_ROOT", async () => {
  const src = await Deno.readTextFile(
    join(harborRoot(), "tools", "build-level", "index.js"),
  );
  // Each loose read is a `path.join(CMG_ROOT, "static", …, "<name>.js")` with
  // literal segments. Directory reads (static/games/2028-ai) are staged as
  // trees elsewhere, and the output dir joins an unquoted variable, so both
  // fall out: only all-literal joins ending in .js are what this covers.
  const wanted = new Set<string>();
  for (
    const m of src.matchAll(
      /path\.join\(\s*CMG_ROOT\s*,\s*((?:"[^"]+"\s*,\s*)*"[^"]+"\s*,?\s*)\)/g,
    )
  ) {
    const segs = [...m[1].matchAll(/"([^"]+)"/g)].map((s) => s[1]);
    if (segs.at(-1)?.endsWith(".js")) wanted.add(segs.join("/"));
  }

  // A scan that matched nothing would pass this test vacuously forever.
  assert(wanted.size >= 4, `source scan found only ${wanted.size} loose reads`);

  const missing = [...wanted].filter((p) => !listed.includes(p));
  assertEquals(
    missing,
    [],
    "tools/build-level reads these off CMG_ROOT but nothing embeds or stages " +
      "them, so they are absent inside the packaged app",
  );
});

Deno.test("build-desktop embeds the list instead of hand-listing files", async () => {
  const src = await Deno.readTextFile(
    join(harborRoot(), "scripts", "build-desktop.ts"),
  );
  assertStringIncludes(src, "EMBEDDED_LOOSE_FILES");
  // A hard-coded `--include "./static/….js"` here is the drift itself: it puts
  // a file in the binary that stageEmbeddedRuntime will never copy back out.
  const handListed = [...src.matchAll(/"\.\/static\/[^"]*\.js"/g)].map((m) =>
    m[0]
  );
  assertEquals(
    handListed,
    [],
    "loose static/ files belong in EMBEDDED_LOOSE_FILES (lib/export-build.ts), " +
      "which is what also stages them out of the VFS",
  );
});
