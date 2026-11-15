// The ?atlasInfo=1 readout (armAtlasInfo) and the notes it reads
// (atlasInfoNote). Image Seal drew nothing from its sprite sheet in Chrome on
// a Pixel 9, and the cloud browser this is worked from has no WebGL, so the
// readout is how the phone reports what the GPU was handed and what it kept.
import { assert, assertEquals } from "jsr:@std/assert@1";

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

Deno.test("both copies note how a sheet was stacked, and keep the log short", async () => {
  for (const url of [LOADER, BUNDLE]) {
    const js = await read(url);
    const stack = functionSource(js, "stackedAtlasCanvas");
    assert(stack.includes('atlasInfoNote("stack"'), `${url}: stack note`);
    assert(stack.includes('result: "packed"'), `${url}: packed note`);
    assert(stack.includes('"repack failed, stacked"'), `${url}: fallback note`);
    const g = globalThis as { __atlasInfoLog?: unknown[] };
    delete g.__atlasInfoLog;
    const note = new Function(functionSource(js, "atlasInfoNote") + "\nreturn atlasInfoNote;")();
    for (let i = 0; i < 50; i++) note("stack", { i });
    assertEquals(g.__atlasInfoLog?.length, 40, `${url}: capped`);
    assertEquals((g.__atlasInfoLog?.[0] as { kind: string }).kind, "stack");
    delete g.__atlasInfoLog;
  }
});

Deno.test("the editor hand-off says what it found, including an image that did not decode", async () => {
  const js = await read(BUNDLE);
  assert(js.includes('atlasInfoNote("handoff", { atlas: "none stored" })'));
  assert(js.includes('atlas: "image did not decode"'));
  assert(js.includes('atlas: img.naturalWidth + "x" + img.naturalHeight'));
});

Deno.test("the readout runs only with atlasInfo=1 and is armed when the game starts", async () => {
  const js = await read(BUNDLE);
  const arm = functionSource(js, "armAtlasInfo");
  assert(arm.includes('.get("atlasInfo") === "1"'));
  assert(/if \(!wanted \|\| typeof document === "undefined"\) return;/.test(arm));
  assert(arm.includes("pointer-events:none"), "never takes a tap from the game");
  assert(arm.includes("gl.bindFramebuffer(gl.FRAMEBUFFER, prev)"), "puts the game's framebuffer back");
  const create = functionSource(js, "create2028Game");
  assert(create.includes("armAtlasInfo(game);"));

  // Without the parameter it touches nothing.
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  let created = 0;
  g.window = { location: { search: "?editorPlay=1" } };
  g.document = { createElement: () => (created++, {}) };
  try {
    new Function(arm + "\nreturn armAtlasInfo;")()({});
    assertEquals(created, 0);
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});

Deno.test("v2 measures how much of each sheet is drawn, only with the readout on", async () => {
  for (const url of [LOADER, BUNDLE]) {
    const js = await read(url);
    const opaque = functionSource(js, "atlasInfoOpaque");
    assert(opaque.includes('readParam("atlasInfo") !== "1"'), `${url}: gated`);
    const stack = functionSource(js, "stackedAtlasCanvas");
    assert(stack.includes("incomingOpaque: atlasInfoOpaque(image)"), `${url}: incoming measured`);
    assert(stack.includes("outOpaque: atlasInfoOpaque(packed.canvas)"), `${url}: packed measured`);
    assert(stack.includes("outOpaque: atlasInfoOpaque(canvas)"), `${url}: stacked measured`);
    const merge = js.slice(js.indexOf("mergeEditorAtlas(opts) {"), js.indexOf("mergeEditorAtlas(opts) {") + 1200);
    assert(merge.includes('atlasInfoNote("handoff"'), `${url}: loader hand-off noted`);
    assert(merge.includes("opaque: atlasInfoOpaque(img)"), `${url}: hand-off measured`);

    // Off: nothing is read back.
    const readParam = (name: string) => (name === "atlasInfo" ? on : null);
    let on: string | null = null;
    const fn = new Function("readParam", "document", opaque + "\nreturn atlasInfoOpaque;");
    let drawn = 0;
    const doc = {
      createElement: () => ({
        getContext: () => ({
          drawImage: () => drawn++,
          // A 256 x 256 reduction with a quarter of it drawn.
          getImageData: () => ({
            data: Uint8ClampedArray.from({ length: 256 * 256 * 4 }, (_, i) => (i % 4 === 3 && i < 256 * 256) ? 255 : 0),
          }),
        }),
      }),
    };
    assertEquals(fn(readParam, doc)({}), undefined);
    assertEquals(drawn, 0);
    on = "1";
    assertEquals(fn(readParam, doc)({}), "25.0%");
  }
  assert((await read(BUNDLE)).includes('"atlasInfo v2  "'));
});
