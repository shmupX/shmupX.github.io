// The X-ray lens on the SP button (game.bundle.js, from the Claude Design
// handoff "X-Ray effect for SP button"): the CA BOMB disc is a hologram window
// that redraws the ships, shots, enemies, enemy shots and pickups passing
// behind it in a cyan luminance ramp with a red/blue fringe. The ramp is the
// prototype's, pixel for pixel, and the hookup has to sit exactly where the
// design put it — its own object over the button, under the score popups,
// never taking the tap, painted once per rendered frame.

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
  const paint = functionSource(js, "paintSpLens");
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
