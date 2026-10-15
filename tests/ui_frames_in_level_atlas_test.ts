// A UI frame an older save left in a game's level atlas.
//
// The cloud game "contra" replaced titleG.gif — the wordmark the title slides
// in — before the editor shipped uiAtlases, and its record carries the frame
// in `atlasFrames` beside the ship's: the editor of the day saved whichever
// atlas the Atlas Manager had open. A load folded it into the level atlas, so
// the Atlas Manager showed it, and the runtime stacked it onto game_asset —
// while the title draws titleG.gif from game_ui, so the title kept 2028.Ai's
// plate. The fix lifts such a frame onto its UI atlas in three places that
// must agree: the level loader, game.bundle.js's inlined copy of it (patched
// by hand, see stage_backgrounds_test.ts), and the editor's cloud load.

import { assert, assertEquals } from "@std/assert";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

type Rect = { x: number; y: number; w: number; h: number };
type FrameMap = Record<string, { frame: Rect }>;

// Just enough of a Phaser texture for the loader: its frames (cut rects), its
// source image's size, and `has`.
class FakeTexture {
  frames: Record<
    string,
    { cutX: number; cutY: number; cutWidth: number; cutHeight: number }
  > = {};
  source: { image: { width: number; height: number } }[];
  constructor(image: { width: number; height: number }, frames: FrameMap) {
    this.source = [{ image }];
    for (const [k, v] of Object.entries(frames)) {
      this.frames[k] = {
        cutX: v.frame.x,
        cutY: v.frame.y,
        cutWidth: v.frame.w,
        cutHeight: v.frame.h,
      };
    }
  }
  has(name: string) {
    return name in this.frames;
  }
}

class FakeTextures {
  map = new Map<string, FakeTexture>();
  exists(k: string) {
    return this.map.has(k);
  }
  get(k: string) {
    return this.map.get(k)!;
  }
  remove(k: string) {
    this.map.delete(k);
  }
  addAtlas(
    k: string,
    image: { width: number; height: number },
    data: { frames: FrameMap },
  ) {
    this.map.set(k, new FakeTexture(image, data.frames));
  }
}

// The level sheet the record carries decodes as a 64x32 image; canvases are
// sized but draw nothing.
function withFakeDom(fn: () => Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { Image: g.Image, document: g.document };
  g.Image = class {
    width = 64;
    height = 32;
    onload: ((this: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload && this.onload());
    }
  };
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
    }),
  };
  return fn().finally(() => {
    g.Image = saved.Image;
    g.document = saved.document;
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

function stockScene() {
  const textures = new FakeTextures();
  textures.addAtlas("game_asset", { width: 256, height: 256 }, {
    frames: { "player00.gif": { frame: { x: 0, y: 0, w: 32, h: 32 } } },
  });
  textures.addAtlas("game_ui", { width: 512, height: 100 }, {
    frames: {
      "titleG.gif": { frame: { x: 0, y: 0, w: 200, h: 40 } },
      "logo.gif": { frame: { x: 0, y: 40, w: 256, h: 60 } },
    },
  });
  return { textures };
}

// contra's shape: the ship's frames and the wordmark, in one level sheet.
function contraRecord(titleKey = "titleG․gif") {
  return {
    atlasImageDataURL: "data:image/png;base64,AAAA",
    atlasFrames: {
      "player00․gif": { frame: { x: 0, y: 0, w: 24, h: 24 } },
      [titleKey]: { frame: { x: 24, y: 0, w: 40, h: 12 } },
    } as FrameMap,
  };
}

Deno.test("a UI frame in a level's atlas goes up onto its UI atlas", () =>
  withFakeDom(async () => {
    const scene = stockScene();
    const loader = new Plugin(scene);
    assertEquals(await loader.applyUiAtlases(contraRecord()), true);
    const ui = scene.textures.get("game_ui");
    // Stacked under the 100px-tall stock sheet, at the size the record drew.
    assertEquals(ui.frames["titleG.gif"], {
      cutX: 0,
      cutY: 100,
      cutWidth: 40,
      cutHeight: 12,
    });
    assert(ui.has("logo.gif"), "the rest of game_ui went with it");
    assertEquals(ui.has("player00.gif"), false, "a ship frame went to the UI");
  }));

Deno.test("either spelling of the frame satisfies the title's lookup", () =>
  withFakeDom(async () => {
    const scene = stockScene();
    const loader = new Plugin(scene);
    await loader.applyUiAtlases(contraRecord("titleG․png"));
    const ui = scene.textures.get("game_ui");
    assertEquals(ui.frames["titleG.gif"].cutHeight, 12);
  }));

Deno.test("a level atlas with no UI frame leaves the UI atlases alone", () =>
  withFakeDom(async () => {
    const scene = stockScene();
    const before = scene.textures.get("game_ui");
    const loader = new Plugin(scene);
    const record = contraRecord();
    delete record.atlasFrames["titleG․gif"];
    assertEquals(await loader.applyUiAtlases(record), false);
    assert(scene.textures.get("game_ui") === before);
  }));

Deno.test("the record's own uiAtlases set wins over the level atlas's copy", () =>
  withFakeDom(async () => {
    const scene = stockScene();
    const loader = new Plugin(scene);
    const record = {
      ...contraRecord(),
      uiAtlases: {
        game_ui: {
          imageDataURL: "data:image/png;base64,BBBB",
          frames: { "titleG․gif": { frame: { x: 0, y: 0, w: 50, h: 9 } } },
        },
      },
    };
    assertEquals(await loader.applyUiAtlases(record), true);
    const ui = scene.textures.get("game_ui");
    assertEquals(ui.frames["titleG.gif"].cutWidth, 50);
    assertEquals(ui.frames["titleG.gif"].cutHeight, 9);
  }));

// The method as written, whitespace aside, from its signature to the next
// member's comment.
function liftMethod(js: string) {
  const start = js.indexOf("_liftUiFrames(levelData, sets, levelAtlasKey) {");
  const end = js.indexOf("// A level may ship its own atlas", start);
  assert(start > 0 && end > start, "no _liftUiFrames");
  return js.slice(start, end).replace(/\s+/g, " ").trim();
}

Deno.test("the bundle's inlined loader lifts the same frames the plugin does", async () => {
  const plugin = await read("static/phaser-plugins/level-loader.js");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  assertEquals(liftMethod(bundle), liftMethod(plugin));
  assert(
    bundle.includes(
      "jobs.push(this._liftUiFrames(levelData, sets, levelAtlasKey || DEFAULTS.atlasKey));",
    ),
    "the bundle's applyUiAtlases never lifts",
  );
  for (const helper of ["function altFrameName(", "function cutFrames("]) {
    assert(bundle.includes(helper), "the bundle lacks " + helper);
  }
  // Tree-shaken out of the bundle: the copy must not lean on it.
  assertEquals(liftMethod(plugin).includes("encodeFirebaseKey"), false);
});

Deno.test("the editor's cloud load moves such a frame into the record's uiAtlases", async () => {
  const editor = await read("static/editor/index.html");
  assert(editor.includes("async function liftUiFramesFromLevelAtlas(d) {"));
  // Before resetUiAtlases reads the record's sets, so the lifted one is among
  // them for the Atlas Manager, PLAY and the next save.
  assert(
    /await liftUiFramesFromLevelAtlas\(d\);\s*resetUiAtlases\(d\);/.test(
      editor,
    ),
    "the cloud load reads the record's UI sets before the lift",
  );
});
