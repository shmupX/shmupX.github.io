// The editor's atlas build and its hand-off to the game. On a Pixel 9 in
// Chrome the sheet the editor handed over for Image Seal (2048 x 2056, 1682
// frames) had nothing drawn on it, stock frames and cart sprites alike, while
// the same hand-off from a desktop browser was 62% drawn. The editor now
// draws the sheet on CPU-backed canvases, checks it and tries again when it
// is blank, and sends what it measured to the game's atlasInfo=1 readout.
import { assert, assertEquals } from "jsr:@std/assert@1";

const EDITOR = new URL("../static/editor/index.html", import.meta.url);
const BUNDLE = new URL("../static/games/2028-ai/game.bundle.js", import.meta.url);
const LOADER = new URL("../static/phaser-plugins/level-loader.js", import.meta.url);
const read = async (u: URL) => (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");

function functionSource(js: string, name: string): string {
  const start = js.search(new RegExp(`function ${name}\\(`));
  assert(start >= 0, `no function ${name}`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

Deno.test("the editor's atlas canvases are drawn by the CPU", async () => {
  const html = await read(EDITOR);
  const work = functionSource(html, "atlasWorkCanvas");
  assert(/getContext\('2d', \{ willReadFrequently: true \}\)/.test(work), "atlasWorkCanvas asks for a CPU canvas");
  const build = functionSource(html, "buildAtlasWithReplacements");
  assert(build.includes("atlasWorkCanvas(MW, fh)"), "the sheet is a work canvas");
  assertEquals(build.includes("document.createElement('canvas')"), false, "no canvas per stock frame");
  assert(build.includes("nc.drawImage(s.src, s.sx, s.sy, s.w, s.h, p.x, p.y, s.w, s.h)"), "stock frames copied by rect");
  const store = functionSource(html, "storeAtlasForViewers");
  assert(store.includes("atlasWorkCanvas(source.naturalWidth, source.naturalHeight)"), "the published copy is a work canvas");
  assert(store.includes("{ atlasKey, frames, blob, diag }"), "the record carries what the editor measured");
  assert(html.includes("const { canvas: c, ctx: cx } = atlasWorkCanvas(sp.w, sp.h);"), "imported sprites on work canvases");
});

Deno.test("a blank build is measured and built again", async () => {
  const html = await read(EDITOR);
  const merge = functionSource(html, "mergeExtraSpritesIntoAtlas");
  assert(merge.includes("atlasImage.decode()"), "waits for the stock atlas to decode");
  assert(/if \(built === 0\) \{[\s\S]*buildAtlasWithReplacements\(\)/.test(merge), "rebuilds a blank sheet");
  assert(merge.includes("editorAtlasDiag = {"), "records what it measured");
  const store = functionSource(html, "storeAtlasForViewers");
  assert(/stored === 0 && !diag\.redrawn/.test(store), "redraws a blank published copy once");
});

Deno.test("the game lists what the editor measured", async () => {
  for (const u of [LOADER, BUNDLE]) {
    const js = await read(u);
    assert(js.includes("diag: record.diag || null"), `${u}: the bridge passes diag on`);
    const notes = js.match(/atlasInfoNote\("editor", (record|bridge)\.diag\)/g) || [];
    assertEquals(notes.length, u === BUNDLE ? 2 : 1, `${u}: editor notes`);
  }
});
