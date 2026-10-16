// A custom game's SP cut-in: rando's, where it drew none of its own.
//
// The cut-in doSpFire plays is cutin0.gif..cutin8.gif in game_asset. The cloud
// game rando drew its own nine (a Liberty-crowned pilot over POWER TO THE
// EARTH), and those are now what every custom game — a level named on the
// URL, an exported app's record, the editor's PLAY of a saved game — plays
// where it brought no cut-in: assets/img/cutinCustom.png, a 3x3 spritesheet of
// rando's frames, which the loader paints over the stock frames in place
// (applyCustomCutin) before the game's own atlas stacks on top, so a cut-in
// the game did draw still wins. The default visit is 2028.Ai itself and keeps
// its own. Two copies must agree: the loader and the bundle's inlined copy of
// it (patched by hand, see stage_backgrounds_test.ts).

import { assert, assertEquals } from "@std/assert";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

type Rect = { x: number; y: number; w: number; h: number };
type FrameMap = Record<string, { frame: Rect }>;
type Op = [string, ...unknown[]];
// An image's picture is a name for what any rect of it shows, which is all a
// pixel fingerprint needs to tell a copy from new art.
type Img = {
  width: number;
  height: number;
  ops?: Op[];
  px?: (r: Rect) => string;
};

class FakeTexture {
  frames: Record<
    string,
    { cutX: number; cutY: number; cutWidth: number; cutHeight: number }
  > = {};
  source: { image: Img }[];
  constructor(image: Img, frames: FrameMap) {
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
  rect(name: string): Rect {
    const f = this.frames[name];
    return { x: f.cutX, y: f.cutY, w: f.cutWidth, h: f.cutHeight };
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
  addImage() {}
  addAtlas(k: string, image: Img, data: { frames: FrameMap }) {
    this.map.set(k, new FakeTexture(image, data.frames));
  }
}

// What a data URL's image shows, by URL; one not listed shows nothing.
const PICTURES = new Map<string, (r: Rect) => string>();

// What `img` shows in rect `r`: a canvas looks back through what was drawn on
// it, last first.
function pictureOf(img: Img, r: Rect): string {
  if (!img.ops) return img.px ? img.px(r) : "blank";
  for (let k = img.ops.length - 1; k >= 0; k--) {
    const [op, ...a] = img.ops[k] as [string, ...number[]];
    const src = a[0] as unknown as Img;
    const [sx, sy, dx, dy, dw, dh] = op === "clearRect"
      ? [0, 0, a[0], a[1], a[2], a[3]]
      : a.length === 3
      ? [0, 0, a[1], a[2], src.width, src.height]
      : [a[1], a[2], a[5], a[6], a[7], a[8]];
    if (r.x < dx || r.y < dy || r.x + r.w > dx + dw || r.y + r.h > dy + dh) {
      continue;
    }
    if (op === "clearRect") return "clear";
    return pictureOf(src, { ...r, x: sx + r.x - dx, y: sy + r.y - dy });
  }
  return "blank";
}

// A data URL decodes as a 768x400 image; a canvas keeps a log of what was
// drawn on it, and reads back by that log.
function withFakeDom(search: string | null, fn: () => Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { Image: g.Image, document: g.document, location: g.location };
  g.Image = class {
    width = 768;
    height = 400;
    px?: (r: Rect) => string;
    onload: ((this: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      this.px = PICTURES.get(v);
      queueMicrotask(() => this.onload && this.onload());
    }
  };
  g.document = {
    createElement: () => {
      const canvas: Img = { width: 0, height: 0, ops: [] };
      return Object.assign(canvas, {
        getContext: () => ({
          drawImage: (...a: unknown[]) => canvas.ops!.push(["drawImage", ...a]),
          clearRect: (...a: unknown[]) => canvas.ops!.push(["clearRect", ...a]),
          getImageData: (x: number, y: number, w: number, h: number) => ({
            data: new TextEncoder().encode(pictureOf(canvas, { x, y, w, h })),
          }),
        }),
      });
    },
  };
  if (search === null) delete g.location;
  else g.location = { search };
  return fn().finally(() => {
    g.Image = saved.Image;
    g.document = saved.document;
    if (saved.location === undefined) delete g.location;
    else g.location = saved.location;
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

// game_asset.json's own rects: two rows across y 1700 and 1842.
const STOCK: Rect[] = Array.from({ length: 9 }, (_, i) => ({
  x: (i % 5) * 256,
  y: i < 5 ? 1700 : 1842,
  w: 256,
  h: 142,
}));
// cutinCustom.png: rando's nine, three to a row.
const SHEET: Rect[] = Array.from({ length: 9 }, (_, i) => ({
  x: (i % 3) * 256,
  y: Math.floor(i / 3) * 142,
  w: 256,
  h: 142,
}));

const at = (name: string) => (r: Rect) => `${name}@${r.x},${r.y}`;
const STOCK_IMAGE: Img = { width: 2048, height: 2128, px: at("stock") };
const SHEET_IMAGE: Img = { width: 768, height: 426, px: at("rando") };

function stockScene({ sheet = true } = {}) {
  const textures = new FakeTextures();
  const frames: FrameMap = {
    "player00.gif": { frame: { x: 0, y: 0, w: 32, h: 32 } },
  };
  STOCK.forEach((frame, i) => (frames[`cutin${i}.gif`] = { frame }));
  textures.addAtlas("game_asset", STOCK_IMAGE, { frames });
  textures.addAtlas("game_ui", { width: 512, height: 100 }, {
    frames: { "titleG.gif": { frame: { x: 0, y: 0, w: 200, h: 40 } } },
  });
  if (sheet) {
    // A Phaser spritesheet names its frames 0, 1, 2...
    const cells: FrameMap = {};
    SHEET.forEach((frame, i) => (cells[i] = { frame }));
    textures.addAtlas("cutin_custom", SHEET_IMAGE, { frames: cells });
  }
  return { textures };
}

const BASE = {
  stage0: { enemylist: [["00"]] },
  playerData: { texture: ["player00.gif"] },
  enemyData: {},
  bossData: {},
};

// A cloud game with an atlas of its own but no cut-in in it, as gs is.
const GS = {
  name: "gs",
  enemylist: [["A0"]],
  atlasImageDataURL: "data:image/png;base64,AAAA",
  atlasFrames: {
    "cyber-octopus0․png": { frame: { x: 0, y: 0, w: 48, h: 48 } },
  },
};

const ops = (scene: ReturnType<typeof stockScene>) =>
  scene.textures.get("game_asset").source[0].image.ops ?? [];

Deno.test("rando's frames go over cutin0..cutin8 in order, in place", () =>
  withFakeDom(null, () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    assertEquals(plugin.applyCustomCutin("game_asset", "cutin_custom"), true);
    const atlas = scene.textures.get("game_asset");
    const canvas = atlas.source[0].image;
    // The atlas keeps its size and every frame where it was.
    assertEquals([canvas.width, canvas.height], [2048, 2128]);
    assertEquals(atlas.rect("player00.gif"), { x: 0, y: 0, w: 32, h: 32 });
    STOCK.forEach((r, i) => assertEquals(atlas.rect(`cutin${i}.gif`), r));
    // The stock atlas first, then each stock frame cleared and repainted.
    const want: Op[] = [["drawImage", STOCK_IMAGE, 0, 0]];
    for (let i = 0; i < 9; i++) {
      const s = SHEET[i], t = STOCK[i];
      want.push(["clearRect", t.x, t.y, t.w, t.h]);
      want.push([
        "drawImage",
        SHEET_IMAGE,
        s.x,
        s.y,
        s.w,
        s.h,
        t.x,
        t.y,
        t.w,
        t.h,
      ]);
    }
    assertEquals(canvas.ops, want);
    // What was painted over is remembered by its pixels, to know a copy of it.
    const prints = (plugin as unknown as { _stockCutin: object })._stockCutin;
    assertEquals(
      Object.keys(prints),
      STOCK.map((_, i) => `cutin${i}.gif`),
    );
    return Promise.resolve();
  }));

Deno.test("without the sheet the stock cut-in stays", () =>
  withFakeDom(null, () => {
    const scene = stockScene({ sheet: false });
    const before = scene.textures.get("game_asset");
    const plugin = new Plugin(scene, null, "levelLoader");
    assertEquals(plugin.applyCustomCutin("game_asset", "cutin_custom"), false);
    assertEquals(scene.textures.get("game_asset") === before, true);
    return Promise.resolve();
  }));

Deno.test("a level named on the URL plays rando's cut-in under its own atlas", () =>
  withFakeDom("?level=gs", async () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () => Promise.resolve(GS);
    await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
    const atlas = scene.textures.get("game_asset");
    // The level atlas stacked under a canvas that already held rando's.
    const merged = atlas.source[0].image;
    const painted = merged.ops![0][1] as Img;
    assertEquals(merged.ops![1].slice(2), [0, 2128]);
    assert(
      painted.ops!.some((op) => op[0] === "drawImage" && op[1] === SHEET_IMAGE),
      "rando's sheet was never painted",
    );
    STOCK.forEach((r, i) => assertEquals(atlas.rect(`cutin${i}.gif`), r));
    assertEquals(atlas.rect("cyber-octopus0.png"), {
      x: 0,
      y: 2128,
      w: 48,
      h: 48,
    });
  }));

Deno.test("a cut-in the game drew wins over rando's", () =>
  withFakeDom("?level=own", async () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () =>
      Promise.resolve({
        ...GS,
        name: "own",
        atlasFrames: {
          "cutin0․gif": { frame: { x: 4, y: 8, w: 256, h: 142 } },
        },
      });
    await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
    const atlas = scene.textures.get("game_asset");
    assertEquals(atlas.rect("cutin0.gif"), { x: 4, y: 2136, w: 256, h: 142 });
    assertEquals(atlas.rect("cutin1.gif"), STOCK[1]);
  }));

Deno.test("a copy of the stock cut-in in a game's atlas leaves rando's in place", () =>
  withFakeDom("?level=akuma", async () => {
    // akuma's atlas, as the editor saved it: cutin0 is 2028.Ai's own frame
    // copied back, cutin1 is art of its own.
    const url = "data:image/png;base64,QUtVTUE=";
    PICTURES.set(
      url,
      (r) => r.x === 4 && r.y === 8 ? "stock@0,1700" : `akuma@${r.x},${r.y}`,
    );
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () =>
      Promise.resolve({
        name: "akuma",
        enemylist: [["A0"]],
        atlasImageDataURL: url,
        atlasFrames: {
          "cutin0․gif": { frame: { x: 4, y: 8, w: 256, h: 142 } },
          "cutin1․gif": { frame: { x: 264, y: 8, w: 256, h: 142 } },
          "akuma_0․png": { frame: { x: 0, y: 200, w: 64, h: 64 } },
        },
      });
    await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
    const atlas = scene.textures.get("game_asset");
    const canvas = atlas.source[0].image;
    // The copy is left out: cutin0 is still rando's, where the stock one was.
    assertEquals(atlas.rect("cutin0.gif"), STOCK[0]);
    assertEquals(pictureOf(canvas, STOCK[0]), "rando@0,0");
    // Art of its own still wins, and the rest of the atlas lands as ever.
    assertEquals(atlas.rect("cutin1.gif"), { x: 264, y: 2136, w: 256, h: 142 });
    assertEquals(pictureOf(canvas, atlas.rect("cutin1.gif")), "akuma@264,8");
    assertEquals(atlas.rect("akuma_0.png"), { x: 0, y: 2328, w: 64, h: 64 });
  }));

Deno.test("the stock game stacks a level's cut-in frames untouched", () =>
  withFakeDom(null, async () => {
    const url = "data:image/png;base64,Rk9P";
    PICTURES.set(url, () => "stock@0,1700");
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () =>
      Promise.resolve({
        name: "foo",
        enemylist: [["00"]],
        atlasImageDataURL: url,
        atlasFrames: {
          "cutin0․gif": { frame: { x: 4, y: 8, w: 256, h: 142 } },
        },
      });
    await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
    // Nothing was painted, so nothing is a copy of what was painted over.
    assertEquals(
      scene.textures.get("game_asset").rect("cutin0.gif"),
      { x: 4, y: 2136, w: 256, h: 142 },
    );
  }));

// The export's shell marks the page; the in-game forge's names the level.
for (const mark of ["__EXPORTED_LEVEL_APP__", "__OFFLINE_LEVEL_NAME__"]) {
  Deno.test(`an exported app's baked record is a custom game too (${mark})`, () =>
    withFakeDom(null, async () => {
      const g = globalThis as Record<string, unknown>;
      g[mark] = mark === "__EXPORTED_LEVEL_APP__" ? true : "gs";
      try {
        const scene = stockScene();
        const plugin = new Plugin(scene, null, "levelLoader");
        await plugin.loadLevel({
          baseRecipe: BASE,
          offlineLevel: { name: "gs", enemylist: [["A0"]] },
          audio: { enabled: false },
        });
        assert(
          ops(scene).some((op) =>
            op[0] === "drawImage" && op[1] === SHEET_IMAGE
          ),
          "the exported app plays the stock cut-in",
        );
      } finally {
        delete g[mark];
      }
    }));
}

Deno.test("a plain visit bakes 2028.Ai's own foo.json in offline, and keeps the stock cut-in", () =>
  withFakeDom(null, async () => {
    const scene = stockScene();
    const stock = scene.textures.get("game_asset");
    const plugin = new Plugin(scene, null, "levelLoader");
    // What the bundle's main() fetches for a visit with no ?level=: the stock
    // game's record, which brings its own title plates but no cut-in.
    await plugin.loadLevel({
      baseRecipe: BASE,
      offlineLevel: { name: "foo", enemylist: [["00"]], logoDataURL: "data:," },
      audio: { enabled: false },
    });
    assertEquals(scene.textures.get("game_asset") === stock, true);
  }));

Deno.test("the default visit is 2028.Ai itself and keeps its own cut-in", () =>
  withFakeDom(null, async () => {
    const scene = stockScene();
    const stock = scene.textures.get("game_asset");
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () =>
      Promise.resolve({ name: "foo", enemylist: [["00"]], enemyData: {} });
    await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
    assertEquals(scene.textures.get("game_asset") === stock, true);
    assertEquals(stock.source[0].image, STOCK_IMAGE);
  }));

Deno.test("the editor's PLAY of a saved game plays rando's; an unsaved one, the stock cut-in", () =>
  withFakeDom("?editorPlay=1", async () => {
    const play = async (recipe: unknown) => {
      const scene = stockScene();
      const plugin = new Plugin(scene, null, "levelLoader");
      plugin.readEditorPlayRequest = () => ({ recipe, stageId: 0 });
      // The editor's own atlas lands after the paint, as the level's does.
      let paintedFirst = false;
      plugin.mergeEditorAtlas = () => {
        paintedFirst = ops(scene).length > 0;
        return Promise.resolve(false);
      };
      await plugin.loadLevel({ baseRecipe: BASE, audio: { enabled: false } });
      return { scene, paintedFirst };
    };
    const saved = await play({
      ...BASE,
      meta: { version: "1.0", editorLevelName: "gs" },
    });
    assertEquals(saved.paintedFirst, true);
    const unsaved = await play({ ...BASE, meta: { version: "1.0" } });
    assertEquals(unsaved.paintedFirst, false);
    assertEquals(ops(unsaved.scene), []);
  }));

// ---- two copies, one rule ----------------------------------------------------

// A function as written, from its signature to `to`, with the whitespace and
// the spellings esbuild changes (void 0, trailing commas) set aside.
function slice(js: string, from: string, to: string) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start > 0 && end > start, `no ${from}`);
  return js.slice(start, end).replace(/\bvoid 0\b/g, "undefined")
    .replace(/,(\s*[)\]}])/g, "$1").replace(/\s+/g, " ").trim();
}

Deno.test("the bundle's inlined loader paints the cut-in the way the plugin does", async () => {
  const plugin = await read("static/phaser-plugins/level-loader.js");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const paint = (js: string) =>
    slice(
      js,
      "applyCustomCutin(atlasKey, sheetKey) {",
      "// A game's atlas often carries",
    );
  assertEquals(paint(bundle), paint(plugin));
  const frameMap = (js: string) =>
    slice(js, "function frameMapOf(texture) {", "return map;");
  assertEquals(frameMap(bundle), frameMap(plugin));
  const exported = (js: string) =>
    slice(js, "function isExportedApp() {", "// A fingerprint");
  assertEquals(exported(bundle), exported(plugin));
  const print = (js: string) =>
    slice(js, "function pixelPrint(ctx, x, y, w, h) {", "// The frame map");
  assertEquals(print(bundle), print(plugin));
  const copies = (js: string) =>
    slice(js, "_withoutStockCutins(image, frames) {", "// The level EDITOR's");
  assertEquals(copies(bundle), copies(plugin));
  for (
    const line of [
      'customCutinKey: "cutin_custom",',
      "const mergedFrameMap = frameMapOf(localAtlas);",
      "if (explicitLevel || exportedApp) this.applyCustomCutin(o.atlasKey, o.customCutinKey);",
      "return this._stackAtlas(img, this._withoutStockCutins(img, levelData.atlasFrames), atlasKey);",
      "this._stackAtlas(img, this._withoutStockCutins(img, record.frames), atlasKey) : false",
      "this._stockCutin = null;",
      "if (editorName) this.applyCustomCutin(o.atlasKey, o.customCutinKey);",
    ]
  ) {
    assert(plugin.includes(line), "the plugin lacks: " + line);
    assert(bundle.includes(line), "the bundle lacks: " + line);
  }
});

Deno.test("the game loads rando's sheet and the SP fire draws from game_asset", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  for (
    const needle of [
      'this.load.spritesheet("cutin_custom", "assets/img/cutinCustom.png", { frameWidth: 256, frameHeight: 142 });',
      'var cutinSprite = this.add.sprite(0, GCY3 - 71, "game_asset", "cutin0.gif");',
      '{ frame: "cutin8.gif", delay: 900 }',
    ]
  ) {
    assert(bundle.includes(needle), "the bundle lacks: " + needle);
  }
  const keep = slice(bundle, "var KEEP_FILES = [", "];");
  assert(
    keep.includes('"assets/img/cutinCustom.png"'),
    "the forge drops the cut-in",
  );
});

Deno.test("the sheet is nine 256x142 frames, three to a row", async () => {
  const png = await Deno.readFile(
    new URL(
      "../static/games/2028-ai/assets/img/cutinCustom.png",
      import.meta.url,
    ),
  );
  // IHDR, the first chunk, holds width then height.
  const view = new DataView(png.buffer, png.byteOffset);
  assertEquals([view.getUint32(16), view.getUint32(20)], [3 * 256, 3 * 142]);
});
