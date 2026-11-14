// A canvas texture the runtime paints once is handed to Phaser as an image.
//
// tests/gpu_reset_canvas_test.ts covers the canvas replay: a lost canvas keeps
// its recipe and is painted again. A phone still lost the playfield with it in
// place — Image Seal (a Dezaemon shelf cart, PLAYed from the editor) kept
// scoring with no ship, enemies, shots or scenery, while the score popups (cut
// from game_ui, an <img>) and the SP button's rim and ground came through. An
// image texture is one Phaser restores by itself, so the stacked atlases, the
// scenery strips, the SP faces and the zako bullet are each encoded to a PNG
// once they are finished and their texture source swapped to that image
// (bakeCanvasTexture). These pin the helper's behaviour in both copies of the
// level loader and every place that calls it.

import { assert, assertEquals } from "@std/assert";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

const LOADER = "static/phaser-plugins/level-loader.js";
const BUNDLE = "static/games/2028-ai/game.bundle.js";

/** The source of `function <name>(…) { … }`, braces matched. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`function ${name}(`);
  assert(start >= 0, `no function ${name}`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

/** The source of the `name(…) {` method inside a class body, braces matched. */
function methodSource(js: string, name: string): string {
  const start = js.search(new RegExp(`\\n\\s+${name}\\([^)]*\\) \\{`));
  assert(start >= 0, `no method ${name}`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unbalanced method ${name}`);
}

class FakeCanvas {
  constructor(public width: number, public height: number) {}
  toBlob(cb: (b: unknown) => void) {
    cb({ png: [this.width, this.height] });
  }
}

class FakeImage {
  constructor(
    public naturalWidth: number,
    public naturalHeight: number,
    public src = "blob:baked",
  ) {}
}

class FakeSource {
  updated: unknown[] = [];
  constructor(public image: unknown) {}
  updateSource(img: unknown) {
    this.updated.push(img);
    this.image = img;
  }
}

function textureManager(entries: Record<string, unknown>) {
  return {
    entries,
    exists: (k: string) => k in entries,
    get: (k: string) => entries[k],
  };
}

async function rig(path: string) {
  const js = await read(path);
  const revoked: string[] = [];
  let decoded: (blob: unknown) => FakeImage | null = (blob) => {
    const [w, h] = (blob as { png: number[] }).png;
    return new FakeImage(w, h);
  };
  const URL = { revokeObjectURL: (u: string) => revoked.push(u) };
  const loadImage = (blob: unknown) => Promise.resolve(decoded(blob));
  const bake = new Function(
    "HTMLCanvasElement",
    "loadImage",
    "URL",
    `${functionSource(js, "bakeCanvasTexture")}; return bakeCanvasTexture;`,
  )(FakeCanvas, loadImage, URL) as (
    t: ReturnType<typeof textureManager>,
    key: string,
  ) => Promise<boolean>;
  return {
    bake,
    revoked,
    decodeAs: (fn: typeof decoded) => {
      decoded = fn;
    },
  };
}

Deno.test("a finished canvas texture is swapped to its PNG, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const canvas = new FakeCanvas(2048, 4400);
    const source = new FakeSource(canvas);
    const textures = textureManager({ game_asset: { source: [source] } });
    assertEquals(await r.bake(textures, "game_asset"), true, path);
    assertEquals(source.updated.length, 1, `${path}: one swap`);
    const img = source.image as FakeImage;
    assert(img instanceof FakeImage, `${path}: the source is the image now`);
    assertEquals([img.naturalWidth, img.naturalHeight], [2048, 4400], path);
    assertEquals(r.revoked, [], `${path}: the image keeps its blob URL`);
  }
});

Deno.test("a texture re-stacked or removed while the PNG was made is left alone, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const canvas = new FakeCanvas(2048, 2128);
    const source = new FakeSource(canvas);
    const entries: Record<string, unknown> = {
      game_asset: { source: [source] },
    };
    const textures = textureManager(entries);
    const pending = r.bake(textures, "game_asset");
    // _stackAtlas removes the key and adds a new texture on another canvas.
    entries.game_asset = { source: [new FakeSource(new FakeCanvas(2048, 4400))] };
    assertEquals(await pending, false, path);
    assertEquals(source.updated, [], `${path}: the old source is not touched`);
    assertEquals(r.revoked, ["blob:baked"], `${path}: the unused PNG is let go`);

    const gone = textureManager({ dezaBg_stage0_0: { source: [new FakeSource(new FakeCanvas(320, 2048))] } });
    const later = r.bake(gone, "dezaBg_stage0_0");
    delete gone.entries.dezaBg_stage0_0;
    assertEquals(await later, false, `${path}: a removed strip is not baked`);
  }
});

Deno.test("where it cannot bake, nothing changes, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    // Already an image (the shipped game_asset.png).
    const img = new FakeImage(2048, 2128, "https://example/game_asset.png");
    const imageSource = new FakeSource(img);
    assertEquals(await r.bake(textureManager({ a: { source: [imageSource] } }), "a"), false, path);
    assertEquals(imageSource.updated, [], path);
    // No such texture.
    assertEquals(await r.bake(textureManager({}), "missing"), false, path);
    // A Phaser without TextureSource.updateSource.
    const old = { image: new FakeCanvas(8, 8) };
    assertEquals(await r.bake(textureManager({ b: { source: [old] } }), "b"), false, path);
    // The PNG failed to decode: the canvas stays.
    r.decodeAs(() => null);
    const kept = new FakeSource(new FakeCanvas(12, 12));
    assertEquals(await r.bake(textureManager({ c: { source: [kept] } }), "c"), false, path);
    assertEquals(kept.updated, [], `${path}: a failed decode keeps the canvas`);
  }
});

Deno.test("the level loader bakes every atlas it stacks or repaints, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const js = (await read(path)).replace(/\r\n/g, "\n");
    for (const name of ["_stackAtlas", "applyCustomCutin"]) {
      const body = methodSource(js, name);
      const add = body.indexOf("scene.textures.addAtlas(atlasKey");
      const bake = body.indexOf("bakeCanvasTexture(scene.textures, atlasKey)");
      assert(add >= 0 && bake > add, `${path}: ${name} bakes the atlas it adds`);
    }
  }
});

Deno.test("the bundle bakes game_asset, the scenery strips, the SP faces and the zako bullet", async () => {
  const js = await read(BUNDLE);
  const pins: [string, string][] = [
    ["mergeAtlasIntoGameAsset", 'bakeCanvasTexture(scene.textures, "game_asset")'],
    ["buildStageBackground", "bakeCanvasTexture(scene.textures, key)"],
    ["drawSpFace", "bakeCanvasTexture(scene.textures, key)"],
    ["ensureZakoBulletTexture", "bakeCanvasTexture(scene.textures, ZAKO_BULLET_KEY)"],
  ];
  for (const [fn, call] of pins) {
    const body = functionSource(js, fn);
    const refresh = Math.max(body.lastIndexOf("tex.refresh()"), body.lastIndexOf("addAtlas("));
    const at = body.indexOf(call);
    assert(at >= 0, `${fn} bakes its texture`);
    assert(at > refresh, `${fn} bakes only once the texture is painted`);
  }
});
