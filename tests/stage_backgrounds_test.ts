// A web game's stage backdrops, and the eShop archive of the 2019 game's PS2
// web build, which is the first level to need them.
//
// Importing dev-fixtures/2019-web and exporting it for the PS2 produced a web
// build that played every stage over the runtime's starfield: the import never
// read img/stage/, and the runtime draws `stage_loop_c<N>` (space_stars.png,
// under the space_corridor.png overlay) for any level with custom enemies,
// which every cloud level has. The fix is spread over three files that must
// agree — the editor reads and saves `stageBackgrounds`, the level loader
// applies them, and game.bundle.js carries its own inlined copy of that loader
// (README: a vendored artifact, patched by hand) — so this pins each half.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  gameEntries,
  LEVEL,
  LEVEL_PATCH,
  patchBundle,
  slimRecord,
} from "../scripts/2019/build-zip.ts";
import { LAUNCHER_MARKER } from "../lib/launcher-inject.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

Deno.test("the editor reads a folder's stage art and carries it through the cloud save", async () => {
  const editor = await read("static/editor/index.html");
  assert(
    editor.includes("async function readStageBackgrounds(readBlob)"),
    "the import does not read img/stage/",
  );
  // Both import paths: the directory picker and the FileList fallback.
  assertEquals(
    editor.split("setStageBackgrounds(await readStageBackgrounds(").length - 1,
    2,
    "one of the two directory imports skips the stage art",
  );
  assert(
    editor.includes(
      "payload.stageBackgrounds = (gameData && gameData.stageBackgrounds &&",
    ),
    "the cloud save drops the stage art",
  );
  assert(
    editor.includes(
      "setStageBackgrounds((d.stageBackgrounds && typeof d.stageBackgrounds === 'object') ? d.stageBackgrounds : null);",
    ),
    "a cloud load keeps the previous level's stage art",
  );
});

Deno.test("the level loader — the plugin and the bundle's inlined copy — puts the level's backdrops over the runtime's", async () => {
  for (
    const path of [
      "static/phaser-plugins/level-loader.js",
      "static/games/2028-ai/game.bundle.js",
    ]
  ) {
    const js = await read(path);
    assert(
      js.includes("applyStageBackgrounds(levelData) {"),
      path + ": no applyStageBackgrounds",
    );
    // Awaited, on both roads in: a ?level= visit goes straight into the stage.
    assert(
      js.includes(
        "this.mergeAtlas(data, o.atlasKey).then(() => this.applyStageBackgrounds(data)).then(() => {",
      ),
      path + ": the cloud path does not await the backdrops",
    );
    assert(
      js.includes(
        "this.mergeEditorAtlas(o).then(() => this.applyStageBackgrounds(recipe)).then(() => {",
      ),
      path + ": the editor-play path does not await the backdrops",
    );
    // Both the plain and the custom-enemy keys, and the overlay goes.
    assert(
      js.includes('["stage_" + part + n, "stage_" + part + "_c" + n]'),
      path + ": only one key family replaced",
    );
    assert(
      js.includes('scene.textures.remove("stage_over_c")'),
      path + ": the corridor overlay stays",
    );
  }
});

Deno.test("the 2019 archive is the game page, the bundle pointed at its own level, and the level", async () => {
  const entries = await gameEntries();
  assertEquals(entries.map((e) => e.path), [
    "foo.json",
    "game.bundle.js",
    "index.html",
  ]);
  const text = new TextDecoder();
  const byPath = Object.fromEntries(
    entries.map((e) => [e.path, text.decode(e.data)]),
  );

  const record = JSON.parse(byPath["foo.json"]);
  assertEquals(record.name, LEVEL);
  assertEquals(
    "frameThumbnails" in record,
    false,
    "the editor's thumbnail cache rode along",
  );
  const bgs = record.stageBackgrounds;
  assertEquals(Object.keys(bgs).sort(), [
    "stage0",
    "stage1",
    "stage2",
    "stage3",
    "stage4",
  ]);
  for (const key of Object.keys(bgs)) {
    for (const part of ["loop", "end"]) {
      assert(
        String(bgs[key][part]).startsWith("data:image/png;base64,"),
        `${key}.${part} is not a PNG data URL`,
      );
    }
  }

  const bundle = byPath["game.bundle.js"];
  assert(
    bundle.includes(LEVEL_PATCH.to),
    "the bundle still reads 2028.Ai's own foo.json",
  );
  assertEquals(bundle.includes(LEVEL_PATCH.from), false);
  assert(
    bundle.includes('var ASSET_BASE = "/games/2028-ai/";'),
    "the assets are fetched off this origin",
  );
  assert(
    bundle.includes("applyStageBackgrounds(levelData) {"),
    "the archive carries a bundle without the backdrops",
  );

  const html = byPath["index.html"];
  assert(
    html.includes(LAUNCHER_MARKER.trim()),
    "no launcher marker: an install serves bytes main.ts never sees",
  );
  assert(
    html.includes('<script src="game.bundle.js" defer></script>'),
    "the page loads the site's bundle, not the archive's",
  );
  assert(
    html.includes(
      '<script src="/games/2028-ai/lib/phaser.min.js" defer></script>',
    ),
  );
  assertEquals(
    html.includes("cmg-level-editor"),
    false,
    "the archive claims to ship the level editor",
  );
});

Deno.test("the bundle patch refuses a bundle whose level line moved", () => {
  assertThrows(
    () => patchBundle("var LEVEL_DATA_URL = 'elsewhere';"),
    Error,
    "LEVEL_PATCH",
  );
  assertEquals(
    patchBundle("a;\n" + LEVEL_PATCH.from + "\nb;"),
    "a;\n" + LEVEL_PATCH.to + "\nb;",
  );
  assertEquals(slimRecord({ name: "x", frameThumbnails: { a: 1 } }), {
    name: "x",
  });
});

Deno.test("2019 is listed as a web build on the PS2 shelf, installed from this origin", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  const row = eshop.find((e: { id: string }) => e.id === "2019");
  assert(row, "data/eshop.json has no 2019 entry");
  assertEquals(row.kind, "web");
  assertEquals(row.shelf, "ps2");
  assertEquals(row.source, "url");
  assertEquals(row.downloadUrl, "/games/2019-web.zip");
  assertEquals(row.entry, "index.html");
  // The archive is a build artifact (deno task 2019:zip), not a committed file.
  const ignore = await read(".gitignore");
  assert(ignore.includes("static/games/2019-web.zip"));
  const tasks = JSON.parse(await read("deno.json")).tasks;
  assert(tasks["2019:zip"], "no 2019:zip task");
  assert(
    tasks.build.includes("deno task 2019:zip"),
    "deno task build does not pack the archive",
  );
});
