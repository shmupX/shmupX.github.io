// A GPU reset must not take a level's art with it.
//
// Chrome puts a plain 2D canvas on the GPU, and when the GPU process restarts
// — Android does it under memory pressure — every such canvas comes back
// blank; when the WebGL context is restored Phaser rebuilds each texture from
// its source canvas, now empty. The runtime stacks a level's atlas onto
// game_asset on a canvas, cuts the Dezaemon scenery strips, the SP faces and
// the kernel's HUD line out of it on more canvases, so a phone playing Ramsie
// in MOD off the LIBRARY lost the ship, the enemies, their shots and the stage
// at once and kept only what is drawn from images (the HP / SCORE / COMBO
// band) or redrawn every frame (the SP lens, the score popups). Reproduced
// with CDP's Browser.crashGpuProcess on Master Arena Mod (game_asset read 0
// opaque pixels afterwards) and on Ramsie through the editor's hand-off (its
// stone scenery and the SP face gone).
//
// The fix is a canvas whose first getContext asks for willReadFrequently,
// which keeps it in CPU memory where a reset cannot reach it, for every canvas
// that becomes a texture's source — in the level loader (both copies: the
// plugin and the bundle's inlined one, README: a vendored artifact patched by
// hand) and in the bundle's own texture builders — and a re-type of Phaser's
// own Text objects once the context is back.

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

/** The canvas-recipe block as source: from its first constant to the end of `armCanvasRepaint`. */
function recorderSource(js: string): string {
  const start = js.indexOf("const CANVAS_LOG_LIMIT");
  assert(start >= 0, "no canvas log in this copy");
  const arm = functionSource(js, "armCanvasRepaint");
  return js.slice(start, js.indexOf(arm, start) + arm.length);
}

// A canvas, a 2D context and timers, just enough for the recipe to run on.
// `clear()` is what the browser does to a lost canvas: the bitmap is gone, so
// whatever was painted is no longer there.
class FakeCtx {
  painted: string[] = [];
  lost = false;
  #fill = "";
  constructor(readonly id: string, readonly sequence: string[]) {}
  get fillStyle() {
    return this.#fill;
  }
  set fillStyle(v: string) {
    this.#fill = v;
    this.painted.push(`fillStyle=${v}`);
  }
  fillRect(...a: number[]) {
    this.painted.push(`fillRect(${a})`);
  }
  drawImage(src: { name: string }, ...a: number[]) {
    this.painted.push(`drawImage(${src.name},${a})`);
  }
  reset() {
    this.sequence.push(`${this.id}:reset`);
    this.painted.push("reset");
  }
  isContextLost() {
    return this.lost;
  }
  clear() {
    this.painted.length = 0;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  ctx: FakeCtx;
  asked: unknown[][] = [];
  handlers: Record<string, (() => void)[]> = {};
  constructor(id: string, sequence: string[]) {
    this.ctx = new FakeCtx(id, sequence);
  }
  getContext(...args: unknown[]) {
    this.asked.push(args);
    return args[0] === "2d" ? this.ctx : null;
  }
  addEventListener(name: string, fn: () => void) {
    (this.handlers[name] ??= []).push(fn);
  }
  fire(name: string) {
    for (const fn of this.handlers[name] ?? []) fn();
  }
}

function rig(path: string) {
  return read(path).then((js) => {
    const sequence: string[] = [];
    const made: FakeCanvas[] = [];
    const timers: (() => void)[] = [];
    const document = {
      createElement(tag: string) {
        assertEquals(tag, "canvas");
        const canvas = new FakeCanvas(
          String.fromCharCode(65 + made.length),
          sequence,
        );
        made.push(canvas);
        return canvas;
      },
    };
    const setTimeout = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    const api = new Function(
      "document",
      "setTimeout",
      `${recorderSource(js)}; return { stableCanvas, armCanvasRepaint };`,
    )(document, setTimeout) as {
      stableCanvas: (w: number, h: number) => FakeCanvas;
      armCanvasRepaint: (game: unknown) => void;
    };
    return {
      ...api,
      made,
      sequence,
      /** Run the next queued timer; false when none is waiting. */
      step: () => {
        const fn = timers.shift();
        fn?.();
        return !!fn;
      },
      /** Run timers until none is left. */
      settle: () => {
        for (let i = 0; i < 200 && timers.shift()?.() !== undefined; i++);
        for (let i = 0; i < 200 && timers.length; i++) timers.shift()!();
      },
    };
  });
}

/** What the browser does when the GPU restarts: every 2D canvas is lost, then restored empty. */
function gpuReset(canvases: FakeCanvas[]) {
  for (const c of canvases) {
    c.fire("contextlost");
    c.ctx.clear();
  }
  for (const c of canvases) c.fire("contextrestored");
}

Deno.test("stableCanvas asks for willReadFrequently first and hands out a context that logs, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const canvas = r.stableCanvas(224, 2048);
    assertEquals(r.made.length, 1, `${path}: one canvas per call`);
    assertEquals([canvas.width, canvas.height], [224, 2048], path);
    assertEquals(
      canvas.asked,
      [["2d", { willReadFrequently: true }]],
      `${path}: the first getContext decides where the canvas lives`,
    );
    const ctx = canvas.getContext("2d") as unknown as FakeCtx;
    assert(
      ctx !== canvas.ctx,
      `${path}: the context handed out must be the logging one`,
    );
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 4, 4);
    assertEquals(
      canvas.ctx.painted,
      ["fillStyle=red", "fillRect(0,0,4,4)"],
      `${path}: a call must still reach the real context`,
    );
    assertEquals(
      canvas.getContext("webgl"),
      null,
      `${path}: only 2d is wrapped`,
    );
  }
});

Deno.test("a canvas the GPU reset cleared is painted again from its log, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const canvas = r.stableCanvas(64, 64);
    const ctx = canvas.getContext("2d") as unknown as FakeCtx;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 4, 4);
    ctx.drawImage({ name: "atlas" }, 0, 8);
    r.settle();
    gpuReset([canvas]);
    assertEquals(canvas.ctx.painted, [], `${path}: the reset cleared it`);
    r.settle();
    assertEquals(
      canvas.ctx.painted,
      ["reset", "fillStyle=red", "fillRect(0,0,4,4)", "drawImage(atlas,0,8)"],
      `${path}: the recipe is played back onto a cleared, default-state canvas`,
    );
  }
});

Deno.test("canvases are repainted oldest first, and not until every lost one is back, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const a = r.stableCanvas(8, 8);
    const b = r.stableCanvas(8, 8); // drawn from a, so it must be painted after it
    (a.getContext("2d") as unknown as FakeCtx).fillRect(0, 0, 1, 1);
    (b.getContext("2d") as unknown as FakeCtx).drawImage({ name: "A" }, 0, 0);
    r.settle();
    for (const c of [a, b]) {
      c.fire("contextlost");
      c.ctx.clear();
    }
    a.ctx.lost = true; // a is still waiting for its own contextrestored
    b.fire("contextrestored");
    for (let i = 0; i < 5; i++) r.step();
    assertEquals(
      r.sequence,
      [],
      `${path}: b must not be painted while a is still lost`,
    );
    a.ctx.lost = false;
    a.fire("contextrestored");
    r.settle();
    assertEquals(
      r.sequence,
      ["A:reset", "B:reset"],
      `${path}: oldest canvas first`,
    );
    assertEquals(b.ctx.painted, ["reset", "drawImage(A,0,0)"], path);
  }
});

Deno.test("a canvas the reset never touched is left alone, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const canvas = r.stableCanvas(8, 8);
    (canvas.getContext("2d") as unknown as FakeCtx).fillRect(0, 0, 1, 1);
    r.settle();
    canvas.fire("contextrestored"); // e.g. only the WebGL context was lost
    r.settle();
    assertEquals(
      canvas.ctx.painted,
      ["fillRect(0,0,1,1)"],
      `${path}: no replay onto live pixels`,
    );
  }
});

Deno.test("a canvas repainted every frame stops logging, but a big one-off build keeps its log, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const built = r.stableCanvas(8, 8);
    const hot = r.stableCanvas(8, 8);
    const bctx = built.getContext("2d") as unknown as FakeCtx;
    for (let i = 0; i < 5000; i++) bctx.fillRect(i, 0, 1, 1); // a scenery strip: tile by tile
    r.settle(); // the turn that built them is over
    const hctx = hot.getContext("2d") as unknown as FakeCtx;
    for (let i = 0; i < 2500; i++) hctx.fillRect(0, 0, 8, 8); // the SP lens, frame after frame
    assertEquals(
      hot.ctx.painted.length,
      2500,
      `${path}: drawing still reaches the canvas`,
    );
    gpuReset([built, hot]);
    r.settle();
    assertEquals(
      built.ctx.painted.length,
      1 + 5000,
      `${path}: the strip is painted again whole`,
    );
    assertEquals(
      hot.ctx.painted,
      [],
      `${path}: the game repaints its own per-frame canvas`,
    );
  }
});

Deno.test("canvas textures are uploaded again once canvases are repainted and WebGL is live, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    const updates: string[] = [];
    const handlers: Record<string, () => void> = {};
    const renderer = {
      gl: { isContextLost: () => false },
      contextLost: false,
      on: (name: string, fn: () => void) => (handlers[name] = fn),
    };
    const game = {
      renderer,
      textures: {
        getTextureKeys: () => ["atlas", "image", "strip"],
        get: (key: string) => ({
          source: [{
            isCanvas: key !== "image",
            glTexture: {},
            update: () => updates.push(key),
          }],
        }),
      },
      events: {
        once: () => assert(false, "a booted game has a renderer already"),
      },
    };
    r.armCanvasRepaint(game);
    r.armCanvasRepaint(game); // safe to call twice
    const canvas = r.stableCanvas(8, 8);
    (canvas.getContext("2d") as unknown as FakeCtx).fillRect(0, 0, 1, 1);
    r.settle();

    gpuReset([canvas]);
    r.settle();
    assertEquals(
      updates,
      ["atlas", "strip"],
      `${path}: every canvas texture, once, and no image`,
    );

    updates.length = 0;
    renderer.contextLost = true; // WebGL is not back yet: Phaser's own restore will read the repainted canvases
    gpuReset([canvas]);
    r.settle();
    assertEquals(updates, [], `${path}: nothing to upload to`);

    renderer.contextLost = false;
    canvas.fire("contextlost");
    canvas.ctx.clear();
    handlers["restorewebgl"](); // WebGL came back before the 2D canvas did
    canvas.fire("contextrestored");
    r.settle();
    assertEquals(
      updates,
      ["atlas", "strip"],
      `${path}: restorewebgl then canvas restored`,
    );
  }
});

Deno.test("a game that has not booted yet is armed when it is ready, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const r = await rig(path);
    let ready: (() => void) | null = null;
    const game: Record<string, unknown> = {
      renderer: undefined,
      events: { once: (_name: string, fn: () => void) => (ready = fn) },
    };
    r.armCanvasRepaint(game);
    assert(ready, `${path}: waits for the game's ready event`);
    const handlers: Record<string, () => void> = {};
    game.renderer = {
      on: (name: string, fn: () => void) => (handlers[name] = fn),
    };
    (ready as unknown as () => void)();
    assert(
      handlers["restorewebgl"],
      `${path}: listens for the WebGL restore once booted`,
    );
  }
});

Deno.test("the game and the loader plugin both arm the repaint", async () => {
  const bundle = await read(BUNDLE);
  assert(
    functionSource(bundle, "create2028Game").includes(
      "armCanvasRepaint(game);",
    ),
    "the game never arms the repaint",
  );
  for (const path of [LOADER, BUNDLE]) {
    const js = await read(path);
    assert(
      js.includes("armCanvasRepaint(pluginManager && pluginManager.game);"),
      `${path}: the plugin does not arm the game it runs in`,
    );
  }
});

Deno.test("the level loader stacks atlases and repaints the cut-in on stable canvases, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const js = await read(path);
    for (
      const [what, body] of [
        // _stackAtlas lays its sheet out in stackedAtlasCanvas, which
        // repacks it in packStackedFrames when it is over the size limit.
        ["stackedAtlasCanvas", functionSource(js, "stackedAtlasCanvas")],
        ["packStackedFrames", functionSource(js, "packStackedFrames")],
        ["applyCustomCutin", methodSource(js, "applyCustomCutin")],
        ["cutFrames", functionSource(js, "cutFrames")],
      ]
    ) {
      assert(
        body.includes("stableCanvas("),
        `${path}: ${what} not on a stableCanvas`,
      );
      assert(
        !body.includes('document.createElement("canvas")'),
        `${path}: ${what} still builds a GPU canvas`,
      );
    }
  }
});

Deno.test("every canvas texture the bundle paints once is built off the GPU", async () => {
  const js = await read(BUNDLE);
  // The pool's canvases are claimed on the GPU in a pixelArt game.
  assert(
    !js.includes("textures.createCanvas("),
    "a texture still comes from Phaser's canvas pool",
  );
  const helper = functionSource(js, "stableCanvasTexture");
  assert(helper.includes("stableCanvas(width, height)"));
  assert(helper.includes("scene.textures.addCanvas(key, canvas)"));
  assert(
    helper.includes("imageSmoothingEnabled = false"),
    "the pool's pixelArt canvases had smoothing off",
  );
  for (
    const [name, uses] of [
      // Through stackedAtlasCanvas, held to stableCanvas above.
      ["mergeAtlasIntoGameAsset", "stackedAtlasCanvas("],
      ["nameLogoTexture", "stableCanvas("],
      ["shipTitleGTexture", "stableCanvas("],
      ["ensureZakoBulletTexture", "stableCanvasTexture(scene,"],
      ["drawSpFace", "stableCanvasTexture(scene,"],
      ["createSpLens", "stableCanvasTexture(scene,"],
      ["dezaHudSheet", "stableCanvasTexture(scene,"],
      ["dezaHudLine", "stableCanvasTexture(scene,"],
    ]
  ) {
    const body = functionSource(js, name);
    assert(body.includes(uses), `${name} does not build on ${uses}`);
    assert(
      !body.includes('document.createElement("canvas")'),
      `${name} still builds a GPU canvas`,
    );
  }
  // The lit SP face was lost through its scratch even on a stable canvas.
  assert(
    functionSource(js, "drawSpFace").includes(
      "var scratch = stableCanvas(w, h);",
    ),
  );
  // The scenery strips (no function of their own to name).
  assert(
    js.includes(
      "var tex = stableCanvasTexture(scene, key, bg.cols * TILE, rowCount * TILE);",
    ),
  );
});

Deno.test("Phaser's own Text is typed again once the WebGL context is restored", async () => {
  const js = await read(BUNDLE);
  assert(
    functionSource(js, "create2028Game").includes(
      "retypeTextsAfterGpuReset(game);",
    ),
    "the game never arms the re-type",
  );
  const hook = functionSource(js, "retypeTextsAfterGpuReset");
  assert(hook.includes('renderer.on("restorewebgl"'));
  assert(hook.includes("t.updateText()"));
  assert(
    hook.includes('addEventListener("contextrestored"'),
    "a canvas still lost is typed when it comes back",
  );
  assert(
    hook.includes('game.events.once("ready", hook)'),
    "a game not booted yet has no renderer to listen on",
  );
});
