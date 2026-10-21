// A game's own story pictures, on screen from the story's first frame.
//
// AdvScene put up 2028.Ai's stock portrait for each part and decoded the
// game's own picture (storyData.customImages) over it as the part came up, so
// the stock portrait showed until the decode finished — a flicker of the stock
// story before the game's own, long enough to see in an Android export
// (rando.apk). The level loader now decodes every story picture into the
// texture AdvScene looks for before the first scene starts, and AdvScene keeps
// its backdrop hidden rather than stock while one is still decoding. The
// loader is patched in two places that must agree: the plugin and
// game.bundle.js's inlined copy (README: a vendored artifact, patched by hand).

import { assert, assertEquals } from "@std/assert";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

function withFakeImage(fn: () => Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = g.Image;
  g.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      queueMicrotask(() =>
        v.startsWith("data:image/png") ? this.onload?.() : this.onerror?.()
      );
    }
  };
  return fn().finally(() => {
    g.Image = saved;
  });
}

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

function fakeScene(existing: string[] = []) {
  const keys = new Set(existing);
  return {
    keys,
    textures: {
      exists: (k: string) => keys.has(k),
      addImage: (k: string) => void keys.add(k),
    },
  };
}

Deno.test("every story picture is a texture before the first scene", () =>
  withFakeImage(async () => {
    const scene = fakeScene(["advCustom_stage1_part0"]);
    const loader = new Plugin(scene);
    const done = await loader.applyStoryImages({
      storyData: {
        customImages: {
          stage0_part0: "data:image/png;base64,AAAA",
          stage0_part1: "data:image/png;base64,BBBB",
          // Already in: left as it is.
          stage1_part0: "data:image/png;base64,CCCC",
          // Undecodable: left to AdvScene.
          stage1_part1: "data:text/plain,nope",
        },
      },
    });
    assertEquals(done, true);
    assertEquals([...scene.keys].sort(), [
      "advCustom_stage0_part0",
      "advCustom_stage0_part1",
      "advCustom_stage1_part0",
    ]);
  }));

Deno.test("a game with no story pictures has nothing to wait for", () =>
  withFakeImage(async () => {
    const loader = new Plugin(fakeScene());
    assertEquals(await loader.applyStoryImages({ storyData: {} }), false);
    assertEquals(await loader.applyStoryImages({}), false);
  }));

Deno.test("both loader copies wait for the pictures on both roads in", async () => {
  for (
    const path of [
      "static/phaser-plugins/level-loader.js",
      "static/games/2028-ai/game.bundle.js",
    ]
  ) {
    const js = (await read(path)).replace(/\s+/g, " ");
    assert(js.includes("applyStoryImages(levelData) {"), path);
    // The editor's hand-off, and the cloud / offline level beside its audio.
    assert(
      js.includes("return this.applyStoryImages(recipe).then(() => ({"),
      path + ": the editor road does not wait",
    );
    assert(
      js.includes(
        "return Promise.all([ this._loadAudio(data, o.audio, o.lowMode), this.applyStoryImages(data)",
      ),
      path + ": the cloud road does not wait",
    );
  }
});

Deno.test("AdvScene never shows the stock portrait under a part that has its own", async () => {
  const js = await read("static/games/2028-ai/game.bundle.js");
  const start = js.indexOf("    _applyCustomImage(stageKey, partNum) {");
  const end = js.indexOf("\n    onNextPress() {", start);
  assert(start > 0 && end > start, "no _applyCustomImage");
  const src = js.slice(start, end);
  assert(
    src.includes("this.bgSprite.setVisible(false);"),
    "stock shows while decoding",
  );
  // A late decode does not overwrite the part the player has moved on to.
  assert(src.includes("self._advCustomWant === texKey"));
});

Deno.test("a game's own story picture is fitted and centred above the story box", async () => {
  const js = await read("static/games/2028-ai/game.bundle.js");
  const start = js.indexOf("  function storyPictureFit(w, h, boxW, boxH) {");
  const end = js.indexOf(
    "\n  // Who the plate above the story box names",
    start,
  );
  assert(start > 0 && end > start, "no storyPictureFit");
  const fit = new Function(
    js.slice(start, end) + "\nreturn storyPictureFit;",
  )() as (
    w: number,
    h: number,
    boxW: number,
    boxH: number,
  ) => { x: number; y: number; scale: number };
  // gs's pictures are 180x240: centred, where they used to hang from x 0.
  assertEquals(fit(180, 240, 256, 240), { x: 38, y: 0, scale: 1 });
  // Too big for the box: scaled down at its own shape, centred both ways.
  assertEquals(fit(512, 480, 256, 240), { x: 0, y: 0, scale: 0.5 });
  assertEquals(fit(512, 128, 256, 240), { x: 0, y: 88, scale: 0.5 });
  // A stock-sized picture keeps its size.
  assertEquals(fit(256, 220, 256, 240), { x: 0, y: 10, scale: 1 });
  // Nothing measurable: left where it is.
  assertEquals(fit(0, 0, 256, 240), { x: 0, y: 0, scale: 1 });

  // AdvScene places the backdrop every time it changes it: a game's own
  // picture as it lands (decoded already, or late), the stock one as a part
  // without its own comes up — back at 0,0, unscaled.
  const scene = js.slice(
    js.indexOf("    _applyCustomImage(stageKey, partNum) {"),
    js.indexOf("\n    goToNextScene() {"),
  );
  assertEquals(scene.match(/_placeBackdrop\(\);/g)?.length, 3);
  assert(
    scene.includes(
      "storyPictureFit(s.frame.realWidth, s.frame.realHeight, GAME_DIMENSIONS.WIDTH, GAME_DIMENSIONS.CENTER_Y)",
    ),
  );
  assert(scene.includes('indexOf("advCustom_") !== 0'));
});
