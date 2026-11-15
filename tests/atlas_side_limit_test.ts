// A stacked atlas is kept within what a phone's GPU will load.
//
// _stackAtlas (both copies of the level loader) and the bundle's
// mergeAtlasIntoGameAsset put a level's atlas under the local game_asset, one
// sheet below the other. For a Dezaemon shelf cart that sheet ran past what a
// Pixel 9 uploads, and a texture over the limit draws nothing: Image Seal
// played with no ship, enemies, shots, scenery or title art on the phone and
// normally on a MacBook. stackedAtlasCanvas keeps the old layout while it
// fits and otherwise repacks the frames (packStackedFrames) into a sheet no
// wider or taller than atlasSideLimit. These pin that in both copies.

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

type Draw = { src: unknown; args: number[] };
class FakeCanvas {
  draws: Draw[] = [];
  constructor(public width: number, public height: number) {}
  getContext() {
    return {
      drawImage: (src: unknown, ...args: number[]) =>
        this.draws.push({ src, args }),
    };
  }
}
type Frames = Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
type Packed = { canvas: FakeCanvas; frames: Frames };

async function rig(path: string) {
  const js = (await read(path)).replace(/\r\n/g, "\n");
  const limitDecl = js.match(/const ATLAS_SIDE_LIMIT = \d+;/);
  assert(limitDecl, `${path}: ATLAS_SIDE_LIMIT`);
  const body = [
    limitDecl[0],
    functionSource(js, "atlasSideLimit"),
    functionSource(js, "packStackedFrames"),
    functionSource(js, "atlasInfoNote"),
    functionSource(js, "stackedAtlasCanvas"),
    "return { atlasSideLimit, stackedAtlasCanvas };",
  ].join("\n");
  const stableCanvas = (w: number, h: number) => new FakeCanvas(w, h);
  return new Function("stableCanvas", body)(stableCanvas) as {
    atlasSideLimit: (scene: unknown) => number;
    stackedAtlasCanvas: (
      scene: unknown,
      local: FakeCanvas,
      image: FakeCanvas,
      frames: Frames,
    ) => Packed;
  };
}

const sceneWith = (max?: number) => ({
  sys: { game: { renderer: max === undefined ? {} : { getMaxTextureSize: () => max } } },
});

Deno.test("the limit is 4096, or less where the renderer says so, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    assertEquals(r.atlasSideLimit(sceneWith(16384)), 4096, path);
    assertEquals(r.atlasSideLimit(sceneWith(2048)), 2048, path);
    assertEquals(r.atlasSideLimit(sceneWith()), 4096, `${path}: canvas renderer`);
    assertEquals(r.atlasSideLimit(null), 4096, path);
  }
});

Deno.test("an atlas that fits is stacked exactly as before, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const local = new FakeCanvas(2048, 2128);
    const image = new FakeCanvas(512, 300);
    const frames: Frames = {
      "player00.gif": { frame: { x: 0, y: 0, w: 32, h: 32 } },
      "zako.gif": { frame: { x: 10, y: 2128 + 20, w: 16, h: 16 } },
    };
    const out = r.stackedAtlasCanvas(sceneWith(16384), local, image, frames);
    assertEquals([out.canvas.width, out.canvas.height], [2048, 2428], path);
    assertEquals(out.frames, frames, `${path}: the frame map is the stack's`);
    assertEquals(out.canvas.draws.map((d) => [d.src, ...d.args]), [[local, 0, 0], [image, 0, 2128]], path);
  }
});

Deno.test("a stack over the limit is repacked within it, every frame copied from its own sheet, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const local = new FakeCanvas(2048, 2128);
    // A shelf cart's atlas: the stock frames again, then the cart's own.
    const image = new FakeCanvas(2048, 3000);
    const frames: Frames = {};
    // Local frames: 20 rows of eight 200 x 100 cells.
    for (let i = 0; i < 160; i++) {
      frames[`stock${i}.gif`] = { frame: { x: (i % 8) * 256, y: Math.floor(i / 8) * 100, w: 200, h: 100 } };
    }
    // The incoming atlas takes stock0..79 over by name, adds 120 of its own.
    for (let i = 0; i < 80; i++) {
      frames[`stock${i}.gif`] = { frame: { x: (i % 8) * 256, y: 2128 + Math.floor(i / 8) * 100, w: 200, h: 100 } };
    }
    for (let i = 0; i < 120; i++) {
      frames[`cart${i}.gif`] = { frame: { x: (i % 8) * 256, y: 2128 + 1000 + Math.floor(i / 8) * 120, w: 240, h: 120 } };
    }
    // Two names on one rect stay on one copy.
    frames["cart0.png"] = frames["cart0.gif"];
    const out = r.stackedAtlasCanvas(sceneWith(4096), local, image, frames);
    assert(out.canvas.width <= 4096 && out.canvas.height <= 4096, `${path}: ${out.canvas.width}x${out.canvas.height}`);
    assertEquals(Object.keys(out.frames).sort(), Object.keys(frames).sort(), `${path}: every name kept`);
    // One draw per distinct rect: 80 local frames left, 80 taken-over copies, 120 cart frames.
    assertEquals(out.canvas.draws.length, 280, path);
    const drawAt = new Map(out.canvas.draws.map((d) => [`${d.args[4]},${d.args[5]}`, d]));
    for (const name in frames) {
      const want = frames[name].frame;
      const got = out.frames[name].frame;
      assertEquals([got.w, got.h], [want.w, want.h], `${path}: ${name} size`);
      const d = drawAt.get(`${got.x},${got.y}`);
      assert(d, `${path}: ${name} drawn`);
      const fromImage = want.y >= 2128;
      assertEquals(d.src, fromImage ? image : local, `${path}: ${name} source`);
      assertEquals(d.args.slice(0, 4), [want.x, fromImage ? want.y - 2128 : want.y, want.w, want.h], `${path}: ${name} cut`);
    }
    assertEquals(out.frames["cart0.png"], out.frames["cart0.gif"], path);
    // No two copies overlap.
    const boxes = Object.values(out.frames).map((f) => f.frame);
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b || (a.x === b.x && a.y === b.y)) continue;
        assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${path}: overlap`);
      }
    }
  }
});

Deno.test("frames that cannot fit the limit either are stacked as before, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const local = new FakeCanvas(2048, 2128);
    const image = new FakeCanvas(2048, 6000);
    const frames: Frames = { "huge.gif": { frame: { x: 0, y: 2128, w: 2048, h: 6000 } } };
    const out = r.stackedAtlasCanvas(sceneWith(4096), local, image, frames);
    assertEquals([out.canvas.width, out.canvas.height], [2048, 8128], path);
    assertEquals(out.frames, frames, path);
  }
});

Deno.test("both stacking paths go through stackedAtlasCanvas", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const js = (await read(path)).replace(/\r\n/g, "\n");
    const body = methodSource(js, "_stackAtlas");
    assert(body.includes("stackedAtlasCanvas(scene, localSource, image, mergedFrameMap)"), `${path}: _stackAtlas`);
    assert(!body.includes("localH + image.height"), `${path}: _stackAtlas no longer sizes its own canvas`);
  }
  const bundle = await read(BUNDLE);
  const merge = functionSource(bundle, "mergeAtlasIntoGameAsset");
  assert(merge.includes("stackedAtlasCanvas(scene, localSource, image, mergedFrameMap)"), "mergeAtlasIntoGameAsset");
  assert(!merge.includes("localH + image.height"), "mergeAtlasIntoGameAsset no longer sizes its own canvas");
});
