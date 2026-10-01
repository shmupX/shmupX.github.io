// The LIBRARY's two ideas, where three surfaces have to agree on them.
//
// LINEAGE. The editor files an opened cart on the shelf as it came ("import")
// and files what was changed beside it as a "mod" that names its parent; the
// launcher lays the shelf out as cards from those records. Nothing but the
// shape of a record connects the two, so the rules that read it — which kind a
// record is, how cards are ordered, what a parent counts — are pinned here.
//
// VERSION. A card plays OG or REBOOT. The launcher sends the word, the editor
// spells it out as boot flags, and game.bundle.js reads the flags: three files
// and one list (versionParams). A flag renamed in one of them is a switch that
// does nothing, with no error anywhere — which is why the runtime's half is
// checked against the list rather than trusted.
//
// And the editor's drawer: its FILE SYSTEM rows moved behind the IMPORT and
// EXPORT sheets with their ids and handlers intact, because the script that
// drives them was left alone. A duplicated or dropped id breaks that quietly.

import { assert, assertEquals } from "@std/assert";
import * as shelfModule from "../static/deza-shelf.js";

// deno-lint-ignore no-explicit-any
type Any = any;
const shelf = shelfModule as Any;

const read = async (path: string) =>
  await Deno.readTextFile(new URL("../" + path, import.meta.url));

Deno.test("an import and a mod get ids that cannot collide with an export's", () => {
  assertEquals(shelf.dezaShelfIdForImport("Test Cart"), "import:test-cart");
  // The parent half sheds the parent's own namespace and palette suffix, so
  // mods of one game sort together whichever way the parent reached the shelf.
  assertEquals(
    shelf.dezaShelfIdForMod("import:test-cart", "Test Cart // HARDTYPE"),
    "mod:test-cart:test-cart-hardtype",
  );
  assertEquals(
    shelf.dezaShelfIdForMod("my-game:saturn", "Harder"),
    "mod:my-game:harder",
  );
  assertEquals(
    shelf.dezaShelfIdForMod("eshop:space-thing", "Remix"),
    "mod:space-thing:remix",
  );
});

Deno.test("a record's kind comes from its source, never from its id's prefix", () => {
  // An export of a game called "Mod" is "mod:saturn". It must stay an export:
  // reading the prefix would give it a lineage ribbon naming no parent.
  const exportCalledMod = { id: "mod:saturn", source: "export" };
  assertEquals(shelf.shelfKindOf(exportCalledMod), "export");
  assertEquals(shelf.isModShelfEntry(exportCalledMod), false);
  assertEquals(
    shelf.shelfKindOf({ id: "import:saturn", source: "export" }),
    "export",
  );

  assertEquals(shelf.shelfKindOf({ id: "mod:a:b", source: "mod" }), "mod");
  assertEquals(
    shelf.shelfKindOf({ id: "import:a", source: "import" }),
    "import",
  );
  // The eShop's prefix rule predates this and is kept: records filed before
  // `source` existed are told apart by it.
  assertEquals(shelf.shelfKindOf({ id: "eshop:a" }), "eshop");
  assertEquals(shelf.shelfKindOf({ id: "a:saturn" }), "export");
});

Deno.test("the library lists each game, then its mods, and counts both", () => {
  const rows = [
    { id: "import:a", source: "import", title: "A", savedAt: 10 },
    {
      id: "mod:a:hard",
      source: "mod",
      title: "A // HARD",
      savedAt: 30,
      parent: { id: "import:a", title: "A" },
    },
    {
      id: "mod:a:easy",
      source: "mod",
      title: "A // EASY",
      savedAt: 20,
      parent: { id: "import:a", title: "A" },
    },
    { id: "b:saturn", source: "export", title: "B", savedAt: 40 },
    { id: "eshop:c", source: "eshop", title: "C", savedAt: 5 },
  ];
  const lib = shelf.libraryCards(rows);

  // Games newest first, each followed at once by its own mods, newest first.
  assertEquals(lib.cards.map((c: Any) => c.id), [
    "b:saturn",
    "import:a",
    "mod:a:hard",
    "mod:a:easy",
    "eshop:c",
  ]);
  assertEquals([lib.games, lib.mods], [3, 2]);

  const parent = lib.cards.find((c: Any) => c.id === "import:a");
  assertEquals(parent.mods, 2, "the parent card counts its mods");
  assertEquals(parent.isMod, false);

  const mod = lib.cards.find((c: Any) => c.id === "mod:a:hard");
  assertEquals(
    [mod.isMod, mod.kind, mod.parentId, mod.parentTitle, mod.parentOnShelf],
    [true, "mod", "import:a", "A", true],
  );
});

Deno.test("a mod whose parent has left the shelf is still listed, and says so", () => {
  const lib = shelf.libraryCards([
    {
      id: "mod:gone:x",
      source: "mod",
      title: "X",
      savedAt: 1,
      parent: { id: "import:gone", title: "Gone" },
    },
    { id: "a:saturn", source: "export", title: "A", savedAt: 2 },
  ]);
  assertEquals(lib.cards.map((c: Any) => c.id), ["a:saturn", "mod:gone:x"]);
  const orphan = lib.cards[1];
  // The ribbon still names the parent — from the copy of the title the mod
  // carries — but has nowhere to jump to.
  assertEquals([orphan.parentTitle, orphan.parentOnShelf], ["Gone", false]);
  assertEquals([lib.games, lib.mods], [1, 1]);
});

Deno.test("a lineage that loops is listed once, not walked forever", () => {
  // Two hand-edited records naming each other. Neither is a root, so the
  // sweep that catches whatever the walks missed has to list them — once.
  const lib = shelf.libraryCards([
    {
      id: "mod:p:a",
      source: "mod",
      title: "A",
      parent: { id: "mod:p:b", title: "B" },
    },
    {
      id: "mod:p:b",
      source: "mod",
      title: "B",
      parent: { id: "mod:p:a", title: "A" },
    },
    {
      id: "mod:p:self",
      source: "mod",
      title: "S",
      parent: { id: "mod:p:self", title: "S" },
    },
  ]);
  assertEquals(
    lib.cards.map((c: Any) => c.id).sort(),
    ["mod:p:a", "mod:p:b", "mod:p:self"],
  );
  assertEquals(shelf.libraryCards(null).cards, []);
});

Deno.test("a mod opens on REBOOT and everything else on OG", () => {
  assertEquals(
    shelf.defaultVersionFor({ id: "mod:a:b", source: "mod" }),
    "reboot",
  );
  assertEquals(
    shelf.defaultVersionFor({ id: "import:a", source: "import" }),
    "og",
  );
  assertEquals(
    shelf.defaultVersionFor({ id: "a:saturn", source: "export" }),
    "og",
  );
  assertEquals(shelf.defaultVersionFor(undefined), "og");
});

Deno.test("OG and REBOOT name every feature flag, both ways", () => {
  // Spelled out for OG as well as REBOOT, because the runtime's own defaults
  // differ per flag — continues are off for an imported cart, the combo
  // multiplier on — so "absent" would not mean the same thing for all three.
  assertEquals(shelf.versionParams("og"), {
    continues: "0",
    combo: "0",
    story: "0",
  });
  assertEquals(shelf.versionParams("reboot"), {
    continues: "1",
    combo: "1",
    story: "1",
  });
  assertEquals(
    shelf.LIBRARY_FEATURES.map((f: Any) => f.label),
    ["CONTINUES", "COMBO MULTIPLIER", "STORY MODE"],
  );
});

Deno.test("the runtime reads every flag a version sends", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  for (const f of shelf.LIBRARY_FEATURES) {
    assert(
      bundle.includes(`SearchParam("${f.param}"`),
      `game.bundle.js never reads ?${f.param}= — the ${f.label} chip would light and change nothing`,
    );
  }
  // The multiplier is applied in three places (a kill, a boss kill, a
  // cancelled bullet). All three go through the one function the flag gates;
  // a fourth site written the old way would ignore OG.
  assertEquals(
    bundle.match(/Math\.ceil\([a-z.]*comboCount \/ 10\)/gi)?.length ?? 0,
    0,
    "a combo multiplier is computed outside comboRatio()",
  );
  assertEquals(bundle.match(/= comboRatio\(/g)?.length, 3);
});

Deno.test("the editor hands a version on as the shelf's own flag list", async () => {
  const editor = await read("static/editor/index.html");
  // It asks deza-shelf.js rather than keeping a second copy of the list.
  assert(editor.includes(".versionParams(version)"));
  assert(editor.includes("${await versionPlayParams()}"));
  // Both hand-offs the launcher's cards make are answered.
  assert(editor.includes("params.get('playExport')"));
  assert(editor.includes("params.get('editExport')"));
});

Deno.test("every control moved into the IMPORT / EXPORT sheets exists exactly once", async () => {
  const editor = await read("static/editor/index.html");
  const ids = [
    "import-sheet",
    "export-sheet",
    "menu-save-row",
    "lineage-strip",
    // moved out of the drawer; the script finds each by id
    "firebase-level-name",
    "deza-url-input",
    "deza-url-btn",
    "deza-library-btn",
    "deza-website-btn",
    "snes-lib-note",
    "export-platform-segs",
    "export-apk-btn",
    "export-apk-status",
    "export-builder-code",
    "export-builder-status",
    "export-queue-panel",
    "export-ps2-actions",
    "eshop-publish-btn",
    "eshop-publish-note",
    "deza-sav-palette-segs",
    "deza-sav-download",
    "deza-sav-shelf",
    "deza-sav-emu",
    "deza-sav-mednafen",
    "deza-sav-note",
    "god-knob",
    "nostory-knob",
  ];
  for (const id of ids) {
    assertEquals(
      editor.split(`id="${id}"`).length - 1,
      1,
      `id="${id}" should appear exactly once in the editor`,
    );
  }
  // Every section an option opens is there to be opened.
  const sections = [...editor.matchAll(/data-sec="([a-z0-9-]+)"/g)].map((m) =>
    m[1]
  );
  assertEquals(sections.length, 7);
  for (const sec of sections) {
    assert(
      editor.includes(`id="sheet-sec-${sec}"`),
      `the sheet option "${sec}" opens a section that does not exist`,
    );
  }
});

Deno.test("the export sheet offers four consoles and builds for the one with a writer", async () => {
  const editor = await read("static/editor/index.html");
  const picked = [...editor.matchAll(/data-console="([a-z0-9]+)"/g)].map((m) =>
    m[1]
  );
  assertEquals(picked, ["sfc", "n64", "saturn", "ps"]);
  // Exactly one console claims a writer, and it is the one the engine has.
  assertEquals(editor.match(/writer: true/g)?.length, 1);
  assert(/saturn: \{[^}]*writer: true/.test(editor));
  const engine = await read("packages/shmup-engine/mod.js");
  assert(
    engine.includes("exportLevelToSav"),
    "the Saturn writer the sheet relies on",
  );
});

Deno.test("the committed dashboard bundle carries the LIBRARY screen", async () => {
  const bundle = await read("static/dashboard.bundle.js");
  for (
    const needle of [
      "lib-card",
      "cmg-library-versions",
      "editExport",
      "ORIGINAL RULES, AS SHIPPED",
    ]
  ) {
    assert(
      bundle.includes(needle),
      `stale bundle (${needle} missing): run \`deno task dashboard:build\``,
    );
  }
});
