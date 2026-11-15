// Art that is only a dot or a line, on a PlayStation 2.
//
// Master Arena Mod's first stage opens on a starfield made of enemies: a few
// hundred zako whose whole picture is one grey pixel in a 16x16 cell, falling
// at four speeds, worth 50 points each. On the console they could not be seen
// — the ship scored off nothing. Two things took them away. The level's sheet
// went on at half size, which averaged the pixel to a quarter of a texel; and
// at any size the port draws through the GS's bilinear filter at 448/480,
// which blends a lone texel's colour with its transparent neighbours and then
// its alpha again.
//
// So the exporter names such frames in the sheet's `meta.ps2Exact`
// (lib/ps2/atlas.ts) and keeps them whole when a sheet is reduced, and the
// port draws them texel for pixel (lib/ps2/runtime-patches.ts, "pinpoint
// frames"). Checked here against a stand-in for the port's atlas manager, and
// against the real bundle when a build has cached one; the picture itself was
// checked in PCSX2, where each star reads back as the grey it was painted.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  buildPs2Atlas,
  isPinpoint,
  type SourceFrame,
} from "../lib/ps2/atlas.ts";
import { newRaster, type Raster } from "../lib/ps2/png.ts";
import { patchRuntime } from "../lib/ps2/runtime-patches.ts";
import { repoRoot } from "../lib/repo-root.ts";
import { ATLAS_ANCHORS, ENEMY_ANCHORS } from "./support/port_anchors.ts";

const STAR = [107, 107, 110, 255];

/** A transparent `w` x `h` cell with `texels` painted the star's grey. */
function cell(w: number, h: number, texels: [number, number][]): Raster {
  const raster = newRaster(w, h);
  for (const [x, y] of texels) raster.data.set(STAR, (y * w + x) * 4);
  return raster;
}

function block(x0: number, y0: number, w: number, h: number) {
  const texels: [number, number][] = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) texels.push([x, y]);
  }
  return texels;
}

function frame(name: string, sheet: Raster): SourceFrame {
  return {
    name,
    sheet,
    entry: { frame: { x: 0, y: 0, w: sheet.width, h: sheet.height } },
  };
}

function pixel(r: Raster, x: number, y: number) {
  const o = (y * r.width + x) * 4;
  return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]];
}

// ---------------------------------------------------------------------------
// The exporter
// ---------------------------------------------------------------------------

Deno.test("a dot or a hairline is a pinpoint, and art with a body is not", () => {
  // Master Arena's star: one texel at (8,7).
  assert(isPinpoint(cell(16, 16, [[8, 7]])));
  assert(isPinpoint(cell(16, 16, block(7, 7, 2, 2))), "a 2x2 dot");
  assert(isPinpoint(cell(32, 16, block(0, 8, 32, 1))), "a hairline");
  assert(isPinpoint(cell(16, 32, block(7, 0, 2, 32))), "a beam two wide");
  // Three texels each way is a body: the filter leaves its middle alone.
  assert(!isPinpoint(cell(16, 16, block(6, 6, 3, 3))));
  // Two dots apart are not one dot: the box they span has an inside.
  assert(!isPinpoint(cell(16, 16, [[2, 2], [12, 12]])));
  assert(!isPinpoint(cell(16, 16, [])), "an empty frame");
});

Deno.test("the sheet names its pinpoints, every frame that draws one", () => {
  const star = cell(16, 16, [[8, 7]]);
  const body = cell(16, 16, block(2, 2, 12, 12));
  const built = buildPs2Atlas(
    [
      frame("star_1.gif", star),
      frame("body_0.gif", body),
      // The second cell of the star's animation: the same picture.
      frame("star_0.gif", star),
    ],
    "level_atlas.png",
    512,
  );
  assertEquals(built.json.meta.ps2Exact, ["star_0.gif", "star_1.gif"]);
  // A sheet with none says nothing: the base game's sheets are as they were.
  const plain = buildPs2Atlas([frame("body_0.gif", body)], "game_asset.png");
  assert(!("ps2Exact" in plain.json.meta));
});

Deno.test("a pinpoint is whole on a sheet at half size", () => {
  // Two 96px bodies will not go on a 128 sheet at full size, so the set is
  // halved.
  const built = buildPs2Atlas(
    [
      frame("star_0.gif", cell(16, 16, [[8, 7]])),
      frame("body_0.gif", cell(96, 96, block(0, 0, 96, 96))),
      // A body's own edge is still averaged: its lone corner texel is not
      // kept whole, because the body does not need it to be seen.
      frame("body_1.gif", cell(96, 96, [[0, 0], ...block(1, 1, 95, 95)])),
    ],
    "level_atlas.png",
    128,
  );
  assertEquals(built.displayScale, 2);
  const star = built.json.frames["star_0.gif"].frame;
  assertEquals([star.w, star.h], [8, 8]);
  // The star's texel, in its own colour and opaque — averaged it was a
  // quarter of that, 64 of 255.
  assertEquals(pixel(built.image, star.x + 4, star.y + 3), STAR);
  let lit = 0;
  for (let y = 0; y < star.h; y++) {
    for (let x = 0; x < star.w; x++) {
      if (pixel(built.image, star.x + x, star.y + y)[3] > 0) lit++;
    }
  }
  assertEquals(lit, 1);
  const edged = built.json.frames["body_1.gif"].frame;
  assertEquals(pixel(built.image, edged.x, edged.y)[3], 128);
  assertEquals(built.json.meta.ps2Exact, ["star_0.gif"]);
});

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Enough of the port for every patch's anchor, as the bundler writes it. */
const STAND_IN = [
  "function playerOnDamage(ctx2, p, amount) {",
  "  p.hp -= amount;",
  "}",
  "function createBoss(ctx2, data, stageId) {",
  "}",
  "function bossLoop(ctx2, b) {",
  "  const bMul = ctx2.state.turboMode ? 2 : 1;",
  "  b.moveTimer += bMul;",
  "  if (b.attackCooldown <= 0) {",
  "    bossAttack(ctx2, b);",
  "  }",
  "}",
  "function bossDraw(ctx2, b) {",
  "}",
  "function createProjectile(data) {",
  "}",
  "function projectileLoop(ctx2, proj, player) {",
  "}",
  "function projectileDraw(ctx2, proj) {",
  "}",
  ...ENEMY_ANCHORS,
  ...ATLAS_ANCHORS,
  "function createGameFont(rt, vp) {",
  '  const font = new rt.Font("default");',
  "  font.scale = vp.scale;",
  "}",
  "function createGameScene(ctx2, net = null) {",
  "  const gs = {",
  "    waveInterval: 80,",
  "  };",
  "}",
].join("\n");

const LINEAR = 0;
const NEAREST = 1;

interface Drawn {
  x: number;
  y: number;
  w: number;
  h: number;
  filter: number;
  crop: number[];
}

/** The patched atlas manager over a stand-in runtime, with `json` loaded. */
function loaded(json: unknown) {
  const patched = patchRuntime(STAND_IN);
  const start = patched.indexOf("var AtlasManager = class {");
  const AtlasManager = new Function(
    patched.slice(start, patched.indexOf("function createGameFont")) +
      "\nreturn AtlasManager;",
  )() as new (rt: unknown) => {
    loadAtlas(name: string, png: string, json: string): boolean;
    drawFrame(
      name: string,
      frame: string,
      x: number,
      y: number,
      scaleX: number,
      scaleY: number,
      alpha?: number,
      tint?: unknown,
    ): void;
  };
  const drawn: Drawn[] = [];
  const sheets: { filter: number }[] = [];
  class Image {
    width = 0;
    height = 0;
    startx = 0;
    starty = 0;
    endx = 0;
    endy = 0;
    color: unknown = null;
    filter = LINEAR;
    constructor() {
      sheets.push(this);
    }
    draw(x: number, y: number) {
      drawn.push({
        x,
        y,
        w: this.width,
        h: this.height,
        filter: this.filter,
        crop: [this.startx, this.starty, this.endx, this.endy],
      });
    }
  }
  const atlas = new AtlasManager({
    std: { loadFile: () => JSON.stringify(json) },
    Image,
    Color: { new: (...rgba: number[]) => rgba },
    NEAREST,
    LINEAR,
  });
  const say = console.log;
  console.log = () => {};
  try {
    atlas.loadAtlas("level_atlas", "level_atlas.png", "level_atlas.json");
  } finally {
    console.log = say;
  }
  return { atlas, drawn, filter: () => sheets[0].filter };
}

const SHEET = {
  frames: {
    "star_0.gif": { frame: { x: 1, y: 1, w: 16, h: 16 } },
    "body_0.gif": { frame: { x: 18, y: 1, w: 32, h: 32 } },
  },
  meta: { ps2DisplayScale: 1, ps2Exact: ["star_0.gif"] },
};

// 448 lines for a 480-line field: the scale every frame is drawn at.
const VP = 448 / 480;

Deno.test("a pinpoint is drawn texel for pixel, unfiltered, on whole pixels", () => {
  const { atlas, drawn, filter } = loaded(SHEET);
  atlas.drawFrame("level_atlas", "star_0.gif", 300, 200, VP, VP, 1, null);
  assertEquals(drawn.pop(), {
    x: 292,
    y: 192,
    w: 16,
    h: 16,
    filter: NEAREST,
    crop: [1, 1, 17, 17],
  });
  // The sheet's own filter is back for the next frame off it.
  assertEquals(filter(), LINEAR);

  // A centre between pixels still lands on them.
  atlas.drawFrame("level_atlas", "star_0.gif", 300.4, 200.6, VP, VP, 1, null);
  const off = drawn.pop()!;
  assertEquals([off.x, off.y, off.w, off.h], [292, 193, 16, 16]);

  // Its shadow is the same frame upside down: the crop flips, the size holds.
  atlas.drawFrame("level_atlas", "star_0.gif", 300, 222, VP, -VP, 0.3, [0]);
  const shadow = drawn.pop()!;
  assertEquals([shadow.w, shadow.h, shadow.filter], [16, 16, NEAREST]);
  assertEquals(shadow.crop, [1, 17, 17, 1]);

  // Drawn large on purpose, it is the nearest whole number of times its size.
  atlas.drawFrame("level_atlas", "star_0.gif", 300, 200, VP * 3, VP * 3);
  const big = drawn.pop()!;
  assertEquals([big.x, big.y, big.w, big.h], [276, 176, 48, 48]);
});

Deno.test("every other frame is drawn as the port always drew it", () => {
  const { atlas, drawn, filter } = loaded(SHEET);
  atlas.drawFrame("level_atlas", "body_0.gif", 300, 200, VP, VP, 1, null);
  const body = drawn.pop()!;
  assertEquals(body.filter, LINEAR);
  assertEquals([body.w, body.h], [32 * VP, 32 * VP]);
  assertEquals([body.x, body.y], [300 - 16 * VP, 200 - 16 * VP]);
  assertEquals(filter(), LINEAR);

  // A sheet that names none — the base game's — marks none.
  const stock = loaded({ frames: SHEET.frames, meta: { ps2DisplayScale: 1 } });
  stock.atlas.drawFrame("level_atlas", "star_0.gif", 300, 200, VP, VP);
  const smeared = stock.drawn.pop()!;
  assertEquals([smeared.w, smeared.filter], [16 * VP, LINEAR]);
});

Deno.test("on a half-size sheet a pinpoint's texel is two pixels, whole", () => {
  const { atlas, drawn } = loaded({
    frames: { "star_0.gif": { frame: { x: 1, y: 1, w: 8, h: 8 } } },
    meta: { ps2DisplayScale: 2, ps2Exact: ["star_0.gif"] },
  });
  atlas.drawFrame("level_atlas", "star_0.gif", 300, 200, VP, VP, 1, null);
  const star = drawn.pop()!;
  assertEquals([star.x, star.y, star.w, star.h], [292, 192, 16, 16]);
  assertEquals(star.crop, [1, 1, 9, 9]);
});

Deno.test("a port that moved its atlas manager fails the build", () => {
  assertThrows(
    () =>
      patchRuntime(STAND_IN.replace('"[Atlas] Loaded "', '"[Atlas] Read "')),
    Error,
    'patch "pinpoint frames: marked"',
  );
  assertThrows(
    () => patchRuntime(STAND_IN.replace("displayH / 2);", "displayH * 0.5);")),
    Error,
    'patch "pinpoint frames: drawn texel for pixel"',
  );
});

Deno.test("the real bundle takes both patches, when a build has cached one", async () => {
  const cached = join(repoRoot(), "build", "ps2", ".cache", "main.js");
  let js: string;
  try {
    js = await Deno.readTextFile(cached);
  } catch {
    return; // no PS2 build on this checkout
  }
  const patched = patchRuntime(js);
  assert(patched.includes("[exactName].exact = true;"));
  assert(patched.includes(".filter = this.#rt.NEAREST;"));
  // The port's two sheet loaders: only the atlas one, which has a JSON to
  // name pinpoints in, is marked.
  assertEquals(
    patched.match(/Array\.isArray\(\w+\.meta\.ps2Exact\)/g)?.length,
    1,
  );
});
