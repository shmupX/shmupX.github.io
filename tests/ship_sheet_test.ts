// The NEW GAME character roster (static/editor/assets/ships, cut by
// scripts/build-ship-sheet.ts): the atlas the level editor's CHOOSE YOUR
// CHARACTER step draws from. These pin what the chooser and the .sav writer
// rely on — frames in reading order under predictable keys, every frame a
// real cut-out with no background or shadow left on it, and every opaque
// pixel already one of Dezaemon 2's 192 system colours.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { decodePng } from "@shmupx/shmup-harbor/png";
import {
  DEZA2_PALETTE_COLS,
  DEZA2_PALETTE_WORDS,
  DEZA2_SYSTEM_ROWS,
  deza2PaletteRgb,
} from "../packages/shmup-engine/src/palette/deza2-palette.js";

const DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "static",
  "editor",
  "assets",
  "ships",
);

interface Frame {
  frame: { x: number; y: number; w: number; h: number };
  sheet: { x: number; y: number };
}

async function loadAtlas() {
  const json = JSON.parse(await Deno.readTextFile(join(DIR, "ships.json"))) as {
    frames: Record<string, Frame>;
    meta: { image: string; size: { w: number; h: number }; count: number };
  };
  const png = await decodePng(await Deno.readFile(join(DIR, "ships.png")));
  return { json, png };
}

Deno.test("the roster is a couple of hundred ships, keyed ship_001.. in order", async () => {
  const { json, png } = await loadAtlas();
  const keys = Object.keys(json.frames);
  assert(keys.length >= 200, `only ${keys.length} ships`);
  keys.forEach((k, i) =>
    assertEquals(k, "ship_" + String(i + 1).padStart(3, "0"))
  );
  assertEquals(json.meta.count, keys.length);
  assertEquals(json.meta.image, "ships.png");
  assertEquals(json.meta.size, { w: png.width, h: png.height });
  // Reading order on the source sheet: the next ship is either to the right
  // on the same row, or on a row that starts below the one before it.
  for (let i = 1; i < keys.length; i++) {
    const prev = json.frames[keys[i - 1]], next = json.frames[keys[i]];
    assert(
      next.sheet.x > prev.sheet.x ||
        next.sheet.y + next.frame.h / 2 > prev.sheet.y,
      `${keys[i]} is out of reading order`,
    );
  }
});

Deno.test("every frame fits the atlas, overlaps no other, and is trimmed to its pixels", async () => {
  const { json, png } = await loadAtlas();
  const taken = new Uint8Array(png.width * png.height);
  for (const [k, f] of Object.entries(json.frames)) {
    const { x, y, w, h } = f.frame;
    assertMatch(k, /^ship_\d{3}$/);
    assert(
      w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= png.width &&
        y + h <= png.height,
      `${k} out of bounds`,
    );
    let top = false, bottom = false, left = false, right = false;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (y + yy) * png.width + x + xx;
        assertEquals(
          taken[i],
          0,
          `${k} overlaps another frame at ${x + xx},${y + yy}`,
        );
        taken[i] = 1;
        if (png.data[i * 4 + 3]) {
          if (yy === 0) top = true;
          if (yy === h - 1) bottom = true;
          if (xx === 0) left = true;
          if (xx === w - 1) right = true;
        }
      }
    }
    assert(
      top && bottom && left && right,
      `${k} has an empty edge — it was not trimmed`,
    );
  }
});

Deno.test("every opaque pixel is a Dezaemon 2 system colour and alpha is binary", async () => {
  const { png } = await loadAtlas();
  const system = new Set(
    deza2PaletteRgb(DEZA2_PALETTE_WORDS)
      .slice(0, DEZA2_SYSTEM_ROWS * DEZA2_PALETTE_COLS)
      .map((c) => (c.r << 16) | (c.g << 8) | c.b),
  );
  let opaque = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const a = png.data[i * 4 + 3];
    assert(a === 0 || a === 255, `soft alpha ${a} at pixel ${i}`);
    if (!a) continue;
    opaque++;
    const packed = (png.data[i * 4] << 16) | (png.data[i * 4 + 1] << 8) |
      png.data[i * 4 + 2];
    assert(
      system.has(packed),
      `off-palette colour #${
        packed.toString(16).padStart(6, "0")
      } at pixel ${i}`,
    );
  }
  assert(opaque > 50_000, `only ${opaque} opaque pixels`);
});
