// A GPU reset must not take a level's art with it.
//
// Chrome puts a plain 2D canvas on the GPU, and when the GPU process restarts
// — Android does it under memory pressure — every such canvas comes back
// blank; when the WebGL context is restored Phaser rebuilds each texture from
// its source canvas, now empty. The runtime stacks a level's atlas onto
// game_asset on a canvas, cuts the Dezaemon scenery strips, the SP faces and
// the kernel's HUD line out of it on more canvases, so a phone playing Master
// Arena Mod lost the ship, the enemies, their shots and the stage at once and
// kept only what is drawn from images (the HP / SCORE / COMBO band) or redrawn
// every frame (the SP lens, the score popups). Reproduced with CDP's
// Browser.crashGpuProcess: game_asset read 0 opaque pixels afterwards.
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

Deno.test("stableCanvas asks for willReadFrequently on the canvas's first getContext, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const src = functionSource(await read(path), "stableCanvas");
    const calls: unknown[][] = [];
    const made: Record<string, unknown>[] = [];
    const document = {
      createElement(tag: string) {
        assertEquals(tag, "canvas");
        const el: Record<string, unknown> = {
          width: 0,
          height: 0,
          getContext: (...args: unknown[]) => {
            calls.push(args);
            return {};
          },
        };
        made.push(el);
        return el;
      },
    };
    const stableCanvas = new Function(
      "document",
      `${src}; return stableCanvas;`,
    )(
      document,
    ) as (w: number, h: number) => Record<string, unknown>;
    const canvas = stableCanvas(224, 2048);
    assertEquals(made.length, 1, `${path}: one canvas per call`);
    assertEquals([canvas.width, canvas.height], [224, 2048], path);
    assertEquals(
      calls,
      [["2d", { willReadFrequently: true }]],
      `${path}: the first getContext decides where the canvas lives`,
    );
  }
});

Deno.test("the level loader stacks atlases and repaints the cut-in on stable canvases, in both copies", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const js = await read(path);
    for (
      const [what, body] of [
        ["_stackAtlas", methodSource(js, "_stackAtlas")],
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
      ["mergeAtlasIntoGameAsset", "stableCanvas("],
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
