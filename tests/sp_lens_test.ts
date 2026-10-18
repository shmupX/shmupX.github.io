// The X-ray lens on the SP button (game.bundle.js, from the Claude Design
// handoff "X-Ray effect for SP button"): the CA BOMB disc is a hologram window
// that redraws the ships, shots, enemies, enemy shots and pickups passing
// behind it in a cyan luminance ramp with a red/blue fringe. The ramp is the
// prototype's, pixel for pixel, and the hookup has to sit exactly where the
// design put it — its own object over the button, under the score popups,
// never taking the tap, painted once per rendered frame.
//
// It is also the one thing the game paints on the CPU every frame, so it is
// held to what it costs (an Android export stuttered, and the lens was
// suspected): the parts that never move are baked once, and a frame with
// nothing behind the disc whose scan line has not moved a row is not
// repainted or uploaded at all.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One method of a class in the bundle, by name, as source text. */
function methodSource(js: string, name: string, after: string): string {
  const from = js.indexOf(after);
  assert(from >= 0, `no ${after} in ${BUNDLE}`);
  const start = js.indexOf(`\n    ${name}(`, from);
  assert(start >= 0, `no ${name}() after ${after}`);
  const end = js.indexOf("\n    }\n", start);
  assert(end > start, `${name}() does not close`);
  return js.slice(start, end + 6);
}

type Tint = (
  src: Uint8ClampedArray,
  main: Uint8ClampedArray,
  red: Uint8ClampedArray,
  blue: Uint8ClampedArray,
) => void;

async function tintPixels(): Promise<Tint> {
  const src = functionSource(await read(BUNDLE), "spLensTintPixels");
  return new Function(
    "src",
    "main",
    "red",
    "blue",
    src + "\nreturn spLensTintPixels(src, main, red, blue);",
  ) as Tint;
}

Deno.test("the ramp is the prototype's: white to (210,255,255), black to (10,110,140), alpha kept", async () => {
  const tint = await tintPixels();
  // White, black, a mid grey at half alpha, and a transparent pixel.
  const src = new Uint8ClampedArray([
    255,
    255,
    255,
    255,
    0,
    0,
    0,
    255,
    128,
    128,
    128,
    128,
    99,
    99,
    99,
    0,
  ]);
  const main = new Uint8ClampedArray(16).fill(7);
  const red = new Uint8ClampedArray(16).fill(7);
  const blue = new Uint8ClampedArray(16).fill(7);
  tint(src, main, red, blue);
  // L = 1: R 10 + 200, G 110 + 145, B 140 + 115.
  assertEquals([...main.slice(0, 4)], [210, 255, 255, 255]);
  assertEquals([...red.slice(0, 4)], [255, 0, 24, 255]);
  assertEquals([...blue.slice(0, 4)], [0, 140, 255, 255]);
  // L = 0: the ramp's floor, still fully opaque.
  assertEquals([...main.slice(4, 8)], [10, 110, 140, 255]);
  assertEquals([...red.slice(4, 8)], [120, 0, 24, 255]);
  assertEquals([...blue.slice(4, 8)], [0, 70, 200, 255]);
  // L = 128/255: the red channel is quadratic, the others linear; alpha kept.
  const k = 128 * 256 / 65280;
  assertEquals([...main.slice(8, 12)], [
    Math.round(10 + 200 * k * k),
    Math.round(110 + 145 * k),
    Math.round(140 + 115 * k),
    128,
  ]);
  assertEquals(red[11], 128);
  assertEquals(blue[11], 128);
  // Transparent in: transparent out on all three plates.
  assertEquals(main[15], 0);
  assertEquals(red[15], 0);
  assertEquals(blue[15], 0);
});

Deno.test("the lens is the design's window: 28 px on the disc, 1.6 s scan, 12 % field, depth 104", async () => {
  const js = await read(BUNDLE);
  for (
    const line of [
      "var SP_LENS_SIZE = 64;",
      "var SP_LENS_R = 28;",
      "var SP_LENS_CENTRE = 33.5;",
      "var SP_LENS_SCAN_MS = 1600;",
      "var SP_LENS_FRINGE_PX = 1;",
      "var SP_LENS_FIELD_ALPHA = 0.12;",
      "var SP_LENS_GRID_PX = 8;",
      "var SP_LENS_DEPTH = 104;",
    ]
  ) assert(js.includes(line), `missing ${line}`);
  // The paint, and the strips and field it stamps (baked once, not per frame).
  const paint = functionSource(js, "paintSpLens") +
    functionSource(js, "spLensBakeStrips") +
    functionSource(js, "spLensBakeField");
  // The subjects, and only them: never the stage, the shadows or the HUD.
  assert(
    paint.includes(
      "[scene.enemies, scene.items, scene.enemyBullets, scene.playerBullets]",
    ),
  );
  assert(paint.includes("draw(scene.players[p] && scene.players[p].sprite)"));
  // Scanlines at 45 % on the hologram, a 5 px cyan bloom under it, the
  // white flare under the scan line, and the cyan trail on the field.
  assert(paint.includes('bc.fillStyle = "rgba(0,16,32,0.45)";'));
  assert(paint.includes("bc.drawImage(lens.scan.el, 0, 0);"));
  assert(paint.includes("bc.shadowBlur = 5;"));
  assert(paint.includes('flare.addColorStop(1, "rgba(255,255,255,0.65)");'));
  assert(paint.includes('trail.addColorStop(1, "rgba(120,255,255,0.35)");'));
  assert(
    paint.includes('ctx.strokeStyle = "rgba(120,255,255,0.35)";'),
    "no rim",
  );
});

Deno.test("the lens hooks where the design put it, and never takes the tap", async () => {
  const js = await read(BUNDLE);
  // createHUD: right after the button is assembled, as its own object.
  const hud = methodSource(js, "createHUD", "\n  var PhaserGameScene = class");
  const assembled = hud.indexOf(
    "this.spBtnWrap.setSize(this.spBtnBarBg.width, this.spBtnBarBg.height);",
  );
  const hooked = hud.indexOf("this.spLens = createSpLens(this);");
  assert(
    assembled >= 0 && hooked > assembled,
    "the lens is not created right after the button",
  );
  // It is an Image the pointer passes through: spBtnBarBg keeps its circle.
  const create = functionSource(js, "createSpLens");
  assert(create.includes("scene.add.image(lens.ox, lens.oy, SP_LENS_TEXTURE)"));
  assert(create.includes("lens.image.setDepth(SP_LENS_DEPTH);"));
  assert(!create.includes("setInteractive"), "the lens must not take input");
  // Painted once per rendered frame, after the fixed-step loop has run.
  const update = methodSource(js, "update", "    // Fixed-timestep game loop");
  const loop = update.indexOf("this.fixedUpdate(time, STEP);");
  const lens = update.indexOf(
    "if (this.spLens) updateSpLens(this, this.spLens, time);",
  );
  assert(
    loop >= 0 && lens > loop,
    "the lens is not painted after the fixed steps",
  );
  // A paint that throws retires the lens, not the frame.
  const tick = functionSource(js, "updateSpLens");
  assert(tick.includes("lens.broken = true;"));
});

// A stand-in 2D context: takes any property, records each call by name.
function fakeContext(calls: string[]) {
  const L = 64;
  return new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      return () => {
        calls.push(k);
        if (k === "getImageData") {
          return { data: new Uint8ClampedArray(L * L * 4) };
        }
        if (k === "createImageData") {
          return { data: new Uint8ClampedArray(L * L * 4) };
        }
        if (k === "createLinearGradient") return { addColorStop() {} };
        return undefined;
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
}

// deno-lint-ignore no-explicit-any
type Json = any;

// `HTMLCanvasElement` and `document` stand in for the browser's where a test
// gives them; Deno has neither, so by default no sheet counts as a canvas.
async function lensPainter(
  canvasClass?: unknown,
  doc?: unknown,
) {
  const js = await read(BUNDLE);
  const consts = js.slice(
    js.indexOf("  var SP_LENS_SIZE = 64;"),
    js.indexOf("  var SP_LENS_DEPTH = 104;"),
  );
  return new Function(
    "HTMLCanvasElement",
    "document",
    consts +
      functionSource(js, "spLensTintPixels") +
      functionSource(js, "spLensSheetPixels") +
      functionSource(js, "spLensFrameSource") +
      functionSource(js, "spLensDrawSprite") +
      functionSource(js, "spLensBakeStrips") +
      functionSource(js, "spLensBakeField") +
      functionSource(js, "paintSpLens") +
      "\nreturn { paint: paintSpLens, bake: spLensBakeStrips, source: spLensFrameSource };",
  )(canvasClass, doc) as {
    paint: (scene: Json, lens: Json, time: number) => void;
    bake: (lens: Json) => void;
    source: (lens: Json, frame: Json) => Json;
  };
}

Deno.test("a frame with nothing behind the disc is painted only when the scan line moves a row", async () => {
  const { paint, bake } = await lensPainter();
  const calls: string[] = [];
  const canvas = () => ({ el: {}, ctx: fakeContext(calls) });
  let uploads = 0;
  const tex = fakeContext(calls);
  const lens: Json = {
    cx: 221.5,
    cy: 290.5,
    ox: 190,
    oy: 259,
    broken: false,
    subjects: canvas(),
    holo: canvas(),
    holoR: canvas(),
    holoB: canvas(),
    body: canvas(),
    scratch: canvas(),
    field: canvas(),
    rim: canvas(),
    trail: canvas(),
    flare: canvas(),
    scan: canvas(),
    main: { data: new Uint8ClampedArray(64 * 64 * 4) },
    red: { data: new Uint8ClampedArray(64 * 64 * 4) },
    blue: { data: new Uint8ClampedArray(64 * 64 * 4) },
    tex: { getContext: () => tex, refresh: () => void uploads++ },
    fieldOx: NaN,
    fieldOy: NaN,
    row: null,
  };
  bake(lens);
  const empty = {
    enemies: [],
    items: [],
    enemyBullets: [],
    playerBullets: [],
    players: [],
  };
  // The sweep crosses 56 rows in 1600 ms from row 3.5: 0 ms and 10 ms share
  // row 3, and 60 ms is on row 5.
  paint(empty, lens, 0);
  assertEquals(uploads, 1);
  // The field and the rim were baked on the first paint, not every frame.
  const baked = calls.filter((c) => c === "stroke").length;
  assertEquals(baked, 1);
  calls.length = 0;
  paint(empty, lens, 10);
  assertEquals(uploads, 1, "an unchanged frame was repainted");
  // Nothing but emptying the subjects window before looking for subjects.
  assertEquals(calls, ["clearRect"], "an unchanged frame drew");
  paint(empty, lens, 60);
  assertEquals(uploads, 2, "the scan line moved and the lens did not");
  // Per frame: no gradient built, no field or rim drawn by hand.
  assert(!calls.includes("createLinearGradient"), "a gradient per frame");
  assert(!calls.includes("stroke"), "the rim per frame");
  assert(!calls.includes("fillRect"), "the field per frame");
  // A subject behind the disc repaints every frame, row or no row.
  const ship = {
    active: true,
    visible: true,
    alpha: 1,
    x: 221,
    y: 290,
    displayWidth: 16,
    displayHeight: 32,
    originX: 0.5,
    originY: 0.5,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    isTinted: false,
    frame: {
      source: { image: {} },
      x: 0,
      y: 0,
      cutX: 0,
      cutY: 0,
      cutWidth: 16,
      cutHeight: 32,
      realWidth: 16,
      realHeight: 32,
    },
  };
  const busy = { ...empty, players: [{ sprite: ship }] };
  paint(busy, lens, 60);
  paint(busy, lens, 61);
  assertEquals(uploads, 4);
  // And the first empty frame after it paints the hologram away.
  paint(empty, lens, 62);
  assertEquals(uploads, 5);
  paint(empty, lens, 63);
  assertEquals(uploads, 5);
  // The button moving re-bakes the field under it.
  lens.ox += 8;
  lens.cx += 8;
  paint(empty, lens, 63);
  assertEquals(uploads, 6);
});

Deno.test("a canvas sheet is read once per lens, each frame cut once, and the lens draws from the cut", async () => {
  // gs merges its art over game_asset at load, so the sheet is a 2048x2544
  // canvas, and every drawImage out of a canvas snapshots all of it: 35 ms a
  // paint on a Pixel 9 whenever anything crossed the disc. A frame-sized
  // canvas costs 0.1 ms.
  const reads: number[][] = [];
  const puts: number[][] = [];
  class FakeCanvas {
    width = 0;
    height = 0;
    opts: unknown = null;
    getContext(_type: string, opts: unknown) {
      this.opts = opts;
      return {
        getImageData: (x: number, y: number, w: number, h: number) => {
          reads.push([x, y, w, h]);
          return { width: w, height: h, data: new Uint8ClampedArray(0) };
        },
        putImageData: (_px: unknown, ...rect: number[]) => void puts.push(rect),
      };
    }
  }
  const made: FakeCanvas[] = [];
  const doc = {
    createElement: () => {
      const c = new FakeCanvas();
      made.push(c);
      return c;
    },
  };
  const { paint, bake, source } = await lensPainter(FakeCanvas, doc);
  const sheet = new FakeCanvas();
  sheet.width = 2048;
  sheet.height = 2544;
  const frame = (cutX: number, cutY: number, w: number, h: number) => ({
    source: { image: sheet },
    x: 0,
    y: 0,
    cutX,
    cutY,
    cutWidth: w,
    cutHeight: h,
    realWidth: w,
    realHeight: h,
  });
  const ship = frame(300, 1200, 31, 38);
  const shot = frame(40, 2400, 8, 16);

  const lens: Json = {};
  const cut = source(lens, ship);
  assertEquals(reads, [[0, 0, 2048, 2544]], "the sheet read once, whole");
  assertEquals(made.length, 1);
  assertEquals([cut.el.width, cut.el.height, cut.x, cut.y], [31, 38, 0, 0]);
  assertEquals(cut.el.opts, { willReadFrequently: true });
  assertEquals(puts, [[-300, -1200, 300, 1200, 31, 38]]);
  // The same frame again is the same cut; another frame is cut from the same
  // read.
  assertEquals(source(lens, ship), cut);
  source(lens, shot);
  assertEquals(reads.length, 1);
  assertEquals(made.length, 2);
  // A sheet grown since (art merged in again) is read and cut again.
  sheet.height = 2600;
  assert(source(lens, ship) !== cut);
  assertEquals(reads.length, 2);
  // A frame of an <img> sheet is drawn from the sheet, where it sits.
  const img = { width: 1024, height: 512 };
  const fromImg = source(lens, { ...ship, source: { image: img } });
  assertEquals([fromImg.el, fromImg.x, fromImg.y], [img, 300, 1200]);
  assertEquals(source(lens, { ...ship, source: null }), null);
  // A new lens (the next GameScene) reads the sheet afresh.
  source({}, ship);
  assertEquals(reads.length, 3);

  // And the paint draws the subject out of its cut, never the sheet.
  const calls: string[] = [];
  const subjects = fakeContext(calls);
  const drawnFrom: unknown[][] = [];
  subjects.drawImage = (...a: unknown[]) => void drawnFrom.push(a);
  const canvas = () => ({ el: {}, ctx: fakeContext(calls) });
  const painted: Json = {
    cx: 221.5,
    cy: 290.5,
    ox: 190,
    oy: 259,
    subjects: { el: {}, ctx: subjects },
    holo: canvas(),
    holoR: canvas(),
    holoB: canvas(),
    body: canvas(),
    scratch: canvas(),
    field: canvas(),
    rim: canvas(),
    trail: canvas(),
    flare: canvas(),
    scan: canvas(),
    main: { data: new Uint8ClampedArray(64 * 64 * 4) },
    red: { data: new Uint8ClampedArray(64 * 64 * 4) },
    blue: { data: new Uint8ClampedArray(64 * 64 * 4) },
    tex: { getContext: () => fakeContext(calls), refresh() {} },
    fieldOx: NaN,
    fieldOy: NaN,
    row: null,
  };
  bake(painted);
  const sprite = {
    active: true,
    visible: true,
    alpha: 1,
    x: 221,
    y: 290,
    displayWidth: 31,
    displayHeight: 38,
    originX: 0.5,
    originY: 0.5,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    isTinted: false,
    frame: ship,
  };
  const scene = {
    enemies: [],
    items: [],
    enemyBullets: [],
    playerBullets: [],
    players: [{ sprite }],
  };
  paint(scene, painted, 0);
  paint(scene, painted, 1);
  assertEquals(drawnFrom.length, 2);
  const shipCut = painted.cuts.get(ship);
  for (const args of drawnFrom) {
    assert(args[0] === shipCut.el, "the paint drew from the sheet");
    assertEquals(args.slice(1, 5), [0, 0, 31, 38]);
  }
});
