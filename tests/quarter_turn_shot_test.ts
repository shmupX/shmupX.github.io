// A shot turned a quarter turn is snapped onto the pixel grid.
//
// `pixelArt: true` has Phaser 4 round a sprite's corners before it draws them,
// but only a sprite that is merely translated (vertexRoundMode "safeAuto");
// anything rotated keeps its corners wherever its position and its frame put
// them. The runtime fires every stock player shot a quarter turn from its art
// (shootBullets), so a shot whose frame is an odd number of pixels tall — the
// 95-demo dart is packed 12x5 — sits with both long edges on half pixels while
// the ship rests on an integer x, and every pixel centre across the shot's
// width lands exactly on a texel boundary. Nearest sampling on a boundary is
// the GPU's call, and a phone GPU that answers differently for the quad's two
// triangles drops the dart's 1 px stem and tail, leaving its 5 px band, until
// the ship moves to a fractional x. snapQuarterTurn (game.bundle.js, a vendored
// artifact patched by hand — README) gives an exact quarter turn at unit scale
// the full rounding straight sprites get — a quarter-turned quad is still an
// axis-aligned rectangle whose corners share one fractional part, so rounding
// keeps its size — and leaves every other angle, and any scaled shot, on the
// default, where rounding would make the quad flicker.

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

type Snap = (sprite: unknown) => void;

async function snapQuarterTurn(): Promise<Snap> {
  const js = await read(BUNDLE);
  return new Function(
    functionSource(js, "snapQuarterTurn") + "\nreturn snapQuarterTurn;",
  )() as Snap;
}

function sprite(rotation: number, scaleX = 1, scaleY = scaleX) {
  return {
    rotation,
    scaleX,
    scaleY,
    mode: null as string | null,
    setVertexRoundMode(mode: string) {
      this.mode = mode;
    },
  };
}

Deno.test("an exact quarter turn at unit scale gets full vertex rounding", async () => {
  const snap = await snapQuarterTurn();
  for (
    const r of [
      -Math.PI / 2, // the stock player shot (shootBullets)
      Math.PI / 2, // a boss beam fired straight down
      0,
      Math.PI,
      -Math.PI,
      2 * Math.PI,
      Math.atan2(-1, 0), // spawnDezaPlayerShot flying straight up
      90 * Math.PI / 180, // bossShootBeam(…, 90)
    ]
  ) {
    const s = sprite(r);
    snap(s);
    assertEquals(s.mode, "fullAuto", `rotation ${r}`);
  }
  // A mirrored shot is still on the grid.
  const flipped = sprite(-Math.PI / 2, -1, 1);
  snap(flipped);
  assertEquals(flipped.mode, "fullAuto");
});

Deno.test("any other angle, or a scaled shot, keeps Phaser's default rounding", async () => {
  const snap = await snapQuarterTurn();
  // The 3-way's side shots lean 0.2 rad off the quarter turn.
  for (const r of [-Math.PI / 2 + 0.2, -Math.PI / 2 - 0.2, 0.3, Math.PI / 4]) {
    const s = sprite(r);
    snap(s);
    assertEquals(s.mode, "safeAuto", `rotation ${r}`);
  }
  // The big shot is drawn at 1.5x; rounding its corners would not keep its
  // size. A growing charge shot likewise.
  for (const [sx, sy] of [[1.5, 1.5], [0.5, 0.5], [0.25, 0.25], [1, 1.5]]) {
    const s = sprite(-Math.PI / 2, sx, sy);
    snap(s);
    assertEquals(s.mode, "safeAuto", `scale ${sx}x${sy}`);
  }
});

Deno.test("a stand-in without the Phaser 4 setter is left alone", async () => {
  const snap = await snapQuarterTurn();
  snap(null);
  snap({ rotation: -Math.PI / 2, scaleX: 1, scaleY: 1 });
});

Deno.test("every shot spawner that turns a bullet snaps it", async () => {
  const js = await read(BUNDLE);
  // The stock player shots: the straight shot (after its size is settled,
  // since the big shot is scaled) and each of the 3-way's three.
  const shoot = functionSource(js, "shootBullets");
  assert(shoot.includes("b.setRotation(-Math.PI / 2 + a * 0.2);\n        snapQuarterTurn(b);"));
  assert(
    shoot.indexOf("bullet.setScale(1.5);") < shoot.indexOf("snapQuarterTurn(bullet);"),
    "the straight shot is snapped after it is scaled",
  );
  // A Dezaemon sub or charge shot, turned to its own velocity...
  assert(
    functionSource(js, "spawnDezaPlayerShot").includes(
      "b.setRotation(Math.atan2(vy, vx));\n    snapQuarterTurn(b);",
    ),
    "spawnDezaPlayerShot",
  );
  // ...and again whenever its flight turns or resizes it.
  assert(functionSource(js, "dezaStepHoming").includes("snapQuarterTurn(bullet);"), "homing");
  const step = functionSource(js, "dezaStepShot");
  assert(step.includes("bullet.setScale(grow.scale / 4096);\n      snapQuarterTurn(bullet);"), "grow");
  assert(step.includes("snapQuarterTurn(bullet);\n      return true;"), "deflect");
  // A boss's shots: the faced ones and the beam.
  assert(
    functionSource(js, "faceBulletHeading").includes(
      "bullet.setRotation(Math.atan2(dirY, dirX) - facing * Math.PI / 180);\n    snapQuarterTurn(bullet);",
    ),
    "faceBulletHeading",
  );
  assert(
    functionSource(js, "bossShootBeam").includes(
      "bullet.setRotation(rad);\n      snapQuarterTurn(bullet);",
    ),
    "bossShootBeam",
  );
});
