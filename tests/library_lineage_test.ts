// The LIBRARY's two ideas, where three surfaces have to agree on them.
//
// LINEAGE. The editor files an opened cart on the shelf as it came ("import")
// and files what was changed beside it as a "mod" that names its parent; the
// launcher lays the shelf out as cards from those records. Nothing but the
// shape of a record connects the two, so the rules that read it — which kind a
// record is, how cards are ordered, what a parent counts — are pinned here.
//
// VERSION. A card plays OG or MOD. The launcher sends the word, the editor
// passes it on, and game.bundle.js decides which parts it turns on — a cart's
// own side in OG, every part in MOD: three files, one word (versionParams) and
// one table of parts (LIBRARY_FEATURES here, CROSSOVER in the runtime). A part
// renamed in one of them is a chip that lights and changes nothing, with no
// error anywhere — which is why the runtime's half is checked against the
// list rather than trusted.
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

Deno.test("a mod opens on MOD and everything else on OG", () => {
  assertEquals(
    shelf.defaultVersionFor({ id: "mod:a:b", source: "mod" }),
    "mod",
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

Deno.test("a version travels as one word, and REBOOT still reads as MOD", () => {
  assertEquals(shelf.LIBRARY_VERSIONS, ["og", "mod"]);
  assertEquals(shelf.versionParams("og"), { version: "og" });
  assertEquals(shelf.versionParams("mod"), { version: "mod" });
  // What MOD was called until 2026-10-05: a stored pick or a kept link.
  assertEquals(shelf.normalizeVersion("reboot"), "mod");
  assertEquals(shelf.normalizeVersion("REBOOT"), "mod");
  assertEquals(shelf.versionParams("reboot"), { version: "mod" });
  // Anything else names no version and sends nothing — the runtime's OG.
  assertEquals(shelf.normalizeVersion("remix"), "");
  assertEquals(shelf.normalizeVersion(undefined), "");
  assertEquals(shelf.versionParams("remix"), {});
});

Deno.test("OG plays a game's own parts and MOD plays every part", () => {
  const on = (version: string, side?: string) =>
    shelf.versionFeatures(version, side).filter((f: Any) => f.on).map((
      f: Any,
    ) => f.id);
  const all = shelf.LIBRARY_FEATURES.map((f: Any) => f.id);
  assertEquals(all, [
    "continues",
    "combo",
    "hud",
    "armor",
    "story",
    "dezaWeapons",
  ]);
  // A cart as the Saturn played it: its weapons, and nothing of the web's —
  // no hit points, no HUD, no combo multiplier, no continue, no story.
  assertEquals(on("og"), ["dezaWeapons"]);
  assertEquals(on("og", "deza"), ["dezaWeapons"]);
  // A web game by its own rules: everything but the Dezaemon weapons.
  assertEquals(on("og", "web"), [
    "continues",
    "combo",
    "hud",
    "armor",
    "story",
  ]);
  // MOD is the same on both sides: everything crosses over.
  assertEquals(on("mod", "deza"), all);
  assertEquals(on("mod", "web"), all);
  assertEquals(on("reboot", "web"), all);
});

Deno.test("the runtime knows every part by the same name and the same side", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  assert(
    bundle.includes('readSearchParam("version")'),
    "game.bundle.js never reads ?version= — OG and MOD would play the same game",
  );
  const table = bundle.match(/var CROSSOVER = \{([^}]*)\}/);
  assert(table, "game.bundle.js has no CROSSOVER table");
  const runtime = Object.fromEntries(
    [...table[1].matchAll(/(\w+): "(web|deza)"/g)].map((m) => [m[1], m[2]]),
  );
  assertEquals(
    runtime,
    Object.fromEntries(
      shelf.LIBRARY_FEATURES.map((f: Any) => [f.param, f.from]),
    ),
    "LIBRARY_FEATURES (deza-shelf.js) and CROSSOVER (game.bundle.js) disagree",
  );
  // And every part in the table is actually consulted somewhere: a row nothing
  // asks about is a chip that lights and changes nothing.
  for (const f of shelf.LIBRARY_FEATURES) {
    assert(
      bundle.includes(`componentOn("${f.param}")`),
      `game.bundle.js never asks componentOn("${f.param}") — the ${f.label} chip would light and change nothing`,
    );
  }
  // The multiplier is applied in three places (a kill, a boss kill, a
  // cancelled bullet). All three go through the one function the part gates;
  // a fourth site written the old way would ignore OG.
  assertEquals(
    bundle.match(/Math\.ceil\([a-z.]*comboCount \/ 10\)/gi)?.length ?? 0,
    0,
    "a combo multiplier is computed outside comboRatio()",
  );
  assertEquals(bundle.match(/= comboRatio\(/g)?.length, 3);
});

Deno.test("OG is a one-hit ship under no HUD, and a web game gets the weapons only in MOD", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  // One hit: the unarmoured branch kills before any hp is subtracted.
  const damage = bundle.slice(
    bundle.indexOf("function playerDamage(scene, p, amount)"),
    bundle.indexOf("function playerDie(scene, p, gone)"),
  );
  assert(
    damage.indexOf('if (!componentOn("armor"))') > 0 &&
      damage.indexOf('if (!componentOn("armor"))') <
        damage.indexOf("p.hp -= amount"),
    "playerDamage no longer destroys an unarmoured ship outright",
  );
  // The spare is flown in the same call, so no tick sees every ship down.
  assert(bundle.includes("if (!gone && dezaNextShip(scene, p)) return;"));
  // Each place a run starts or continues refills the stock.
  assertEquals(bundle.match(/^\s+resetShipStock\(\);$/gm)?.length, 4);
  // No HUD: built, then switched off, for the first player's bars and again
  // when the second player's arrive.
  assertEquals(bundle.match(/^\s+this\.applyTopHud\(\);$/gm)?.length, 2);
  // The weapon code reads its ship and loadout through dezaKit, which is the
  // only door a web game's crossover kit comes through.
  assertEquals(bundle.match(/var m = dezaKit\(scene\);/g)?.length, 2);
  assert(
    bundle.includes(
      'levelSide() === "web" && componentOn("dezaWeapons") ? DEZA_CROSSOVER_KIT : null',
    ),
  );
  // And a game with no LIBRARY card can still be switched: the Guide's cheat.
  assert(
    bundle.includes(
      '{ param: "version", kind: "toggle", label: "Mod Mode", on: "mod" }',
    ),
  );
});

Deno.test("OG types the score and the bomb stock where the Saturn does, in the kernel's own glyphs", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  // Measured off two Mednafen captures and fitted to the 8 px tile grid:
  // SCORE at tile (6, 1), the number right-aligned in the eight tiles after
  // one blank. "SCORE " + 8 is 14 tiles from x 48, so the last digit ends at
  // x 160 — the middle of the 320 px screen, and of this runtime's 256.
  assert(bundle.includes("var DEZA_HUD_SCORE = { x: 48, y: 8, digits: 8 };"));
  assertEquals(48 + ("SCORE ".length + 8) * 8, 320 / 2);
  assert(bundle.includes("dezaSatX(DEZA_HUD_SCORE.x),"));
  // BOMB at tile (27, 27) — the bottom row of 224 lines, counted from the
  // bottom edge — with its two-digit count ending at x 272: the mirror of
  // the score's 48 px inset.
  assert(
    bundle.includes(
      "var DEZA_HUD_BOMB = { x: 216, y: DEZA_SCREEN_H - 216, digits: 2 };",
    ),
  );
  assertEquals(216 + ("BOMB ".length + 2) * 8, 320 - 48);
  assert(bundle.includes("GH11 - DEZA_HUD_BOMB.y,"));
  // Only a ship with a bomb to count gets the line; one on the SP gauge does not.
  assert(
    bundle.includes(
      'if (!componentOn("hud") && dezaBombArmed(this, this.players[0])) {',
    ),
  );
  // The line exists only where the web band does not.
  assert(
    /if \(!componentOn\("hud"\)\) \{\s+this\.dezaScoreLine = dezaHudLine\(/
      .test(
        bundle,
      ),
  );
  assert(
    bundle.includes(
      "if (this.dezaScoreLine) this.dezaScoreLine.setText(dezaHudScoreText(this.scoreCount));",
    ),
  );
  // The glyphs come off the sheet the game already ships: 95 ASCII cells of
  // 8x8, which is what `glyph * DEZA_CELL` indexes. A PNG's size is the two
  // big-endian words after its IHDR tag.
  assert(
    bundle.includes(
      'this.load.image("athenaFont", "assets/fonts/athenaFont.png");',
    ),
  );
  const png = await Deno.readFile(
    new URL(
      "../static/games/2028-ai/assets/fonts/athenaFont.png",
      import.meta.url,
    ),
  );
  const size = new DataView(png.buffer, png.byteOffset + 16, 8);
  assertEquals([size.getUint32(0), size.getUint32(4)], [95 * 8, 8]);
  // The gradient and the shadow the sheet does not carry, as measured.
  assert(
    bundle.includes(
      'var DEZA_HUD_INK = ["#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#e7ffff", "#d6ffff", "#d6ffff"];',
    ),
  );
  assert(bundle.includes('var DEZA_HUD_SHADOW = "#484848";'));
  assert(
    bundle.includes(
      "body(cell, x - 1, y) || body(cell, x, y - 1) || body(cell, x - 1, y - 1)",
    ),
    "the shadow is the body shifted right, down and both — not the diagonal alone",
  );
});

Deno.test("the editor hands a version on as the shelf's own word", async () => {
  const editor = await read("static/editor/index.html");
  // It asks deza-shelf.js rather than keeping a second copy of the rule, and
  // plays a mod as MOD when no card chose for it.
  assert(
    editor.includes(
      "shelf.versionParams(shelf.normalizeVersion(version) || (lineageForked() ? 'mod' : ''))",
    ),
  );
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
      "AS THE SATURN PLAYED IT",
      "EVERY PART CROSSES OVER",
    ]
  ) {
    assert(
      bundle.includes(needle),
      `stale bundle (${needle} missing): run \`deno task dashboard:build\``,
    );
  }
});
