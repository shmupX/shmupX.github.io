// A game that flies its own item icons: 2019-PS2.
//
// Every web game's four drops flap the winged letters (F, S, R, B) from the
// powerups atlas. 2019-PS2 plays 2019's own icons instead — B SHOT, W SHOT,
// POW and G BARRIER, blinking between their 0 and 1 frames at 2019's 0.08 a
// tick — and those are 2028.Ai's game_asset frames pixel for pixel, so only
// the level's `ownItems` flag tells the runtime so. mergeRecipe carries it
// onto the recipe (the plugin and the bundle's inlined copy), and dropItem,
// which lives only in the bundle, reads it there.

import { assert, assertEquals } from "@std/assert";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

const Plugin = createLevelLoaderPlugin({
  Plugins: {
    ScenePlugin: class {
      scene: unknown;
      constructor(scene: unknown) {
        this.scene = scene;
      }
    },
  },
});

const BASE = {
  stage0: { enemylist: [["00"]] },
  playerData: { texture: ["player00.gif"] },
  enemyData: {},
  bossData: {},
};

const scene = {
  textures: { exists: () => false, get: () => null },
  cache: { json: { get: () => null, exists: () => false } },
};

Deno.test("mergeRecipe carries a level's ownItems onto the recipe", () => {
  const plugin = new Plugin(scene, null, "levelLoader");
  const own = plugin.mergeRecipe(
    BASE,
    { name: "2019-PS2", enemylist: [["00"]], ownItems: true },
    "game_asset",
  );
  assertEquals(own.ownItems, true);
  const stock = plugin.mergeRecipe(
    BASE,
    { name: "gs", enemylist: [["00"]] },
    "game_asset",
  );
  assertEquals("ownItems" in stock, false);
});

// From `from` to `to`, whitespace set aside.
function slice(js: string, from: string, to: string) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start > 0 && end > start, `no ${from}`);
  return js.slice(start, end).replace(/\s+/g, " ").trim();
}

Deno.test("the bundle's inlined mergeRecipe carries ownItems the way the plugin does", async () => {
  const plugin = (await read("static/phaser-plugins/level-loader.js"))
    .replace(/\r\n/g, "\n");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const pass = (js: string) =>
    slice(js, "// A game that flies its own item icons", "const atlasFrames");
  assertEquals(pass(bundle), pass(plugin));
});

Deno.test("dropItem flies a game's own icons, blinking, where ownItems says so", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const drop = slice(
    bundle,
    "dropItem(x, y, itemName, ownIcon) {",
    "collectItem(p, itemName) {",
  );
  for (
    const line of [
      "var ownItems = !!(this.recipe && this.recipe.ownItems);",
      "var letter = ownItems ? null : emblemByItem[itemName];",
      "if (usingOwn && !ownItems) {",
      'var blinkFrame = ownItems && !usingOwn ? frameKey.replace(/0\\.gif$/, "1.gif") : null;',
      "frameRate: 4.8,",
      "item.play(blinkAnim);",
    ]
  ) {
    assert(drop.includes(line), "dropItem lacks: " + line);
  }
});
