// What the editor's EXPORT sheet hands the cart writers, against what the
// CLI builds hand them (tests/editor_story_export_test.ts does the story).
//
// ITEM EMBLEMS. `build:sav` dresses the Saturn cart's F, S, R and B item
// cells in the runtime's winged power-up letters, cut from the committed
// powerups atlas (packages/shmup-harbor/lib/powerup-emblems.ts
// loadAtlasEmblems); the editor cuts the same stills out of the atlas it
// serves. Without them the writer draws coloured squares and nothing errors.
//
// THE SFC NOTE. The Super Famicom writer counts its art in chips
// (report.chips, of 512); a note reading any other field says 0 forever.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  EMBLEM_ATLAS,
  EMBLEM_CELL,
  EMBLEM_LETTERS,
  loadAtlasEmblems,
} from "../packages/shmup-harbor/lib/powerup-emblems.ts";
import { repoRoot } from "../packages/shmup-harbor/lib/repo-root.ts";

const editor = async () =>
  (await Deno.readTextFile(join(repoRoot(), "static/editor/index.html")))
    .replaceAll("\r\n", "\n");

Deno.test("the editor's Saturn export wears the emblems build:sav does", async () => {
  const html = await editor();
  const url = html.match(/const DEZA_EMBLEM_ATLAS_URL = '([^']+)'/)?.[1];
  assertEquals(url, "/" + EMBLEM_ATLAS.replace(/^static\//, ""));
  assertEquals(
    html.match(/const DEZA_EMBLEM_CELL = (\d+);/)?.[1],
    String(EMBLEM_CELL),
  );
  const letters = html.match(
    /for \(const letter of \[([^\]]+)\]\) \{\n\s+const name = 'emblemStill'/,
  )?.[1];
  assertEquals(
    letters?.split(",").map((l) => l.trim().replaceAll("'", "")),
    [...EMBLEM_LETTERS],
  );
  // Every Saturn build reads its options from dezaSavOptions, which hands
  // the emblems on.
  const options = html.slice(
    html.indexOf("async function dezaSavOptions()"),
    html.indexOf("async function dezaUiPlate("),
  );
  assert(options.includes("dezaItemEmblems(),"), "the emblems are not loaded");
  assert(/titleG, author, itemEmblems,/.test(options), "nor passed on");

  // The atlas the page cuts them from holds all four stills, cell-sized.
  const warnings: string[] = [];
  const emblems = await loadAtlasEmblems(
    join(repoRoot(), EMBLEM_ATLAS),
    (m) => warnings.push(m),
  );
  assertEquals(warnings, []);
  assertEquals(Object.keys(emblems ?? {}).sort(), [...EMBLEM_LETTERS].sort());
});

Deno.test("the editor's SFC note counts the chips the writer reports", async () => {
  const html = await editor();
  const note = html.slice(
    html.indexOf("async function exportSfcSram("),
    html.indexOf(
      "if (action === 'mednafen')",
      html.indexOf("async function exportSfcSram("),
    ),
  );
  assert(
    note.includes("rep.chips.used"),
    "the note does not read report.chips",
  );
  assert(!note.includes("rep.tiles"), "the note still reads report.tiles");
  const writer = await Deno.readTextFile(
    join(repoRoot(), "packages/shmup-engine/src/sfc/sfc-write.js"),
  );
  assert(
    /chips: \{ used: bank\.used, capacity: USER_CHIP_COUNT/.test(writer),
    "sfc-write.js no longer reports chips as { used, capacity }",
  );
});
