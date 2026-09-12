// Story panels: the level's cutscene pictures cut down to art a cart can hold.
// The foo level is committed, so the end-to-end case runs without a fixture.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  decodeStoryPicture,
  fitPanel,
  splitIntoTiles,
  storyPanels,
  TILE,
} from "../lib/story-panels.ts";
import { newRaster } from "../lib/ps2/png.ts";
import { repoRoot } from "../lib/repo-root.ts";

const FOO = join(repoRoot(), "static/games/2028-ai/foo.json");

function solid(w: number, h: number, r: number, g: number, b: number, a = 255) {
  const ras = newRaster(w, h);
  for (let i = 0; i < ras.data.length; i += 4) {
    ras.data[i] = r;
    ras.data[i + 1] = g;
    ras.data[i + 2] = b;
    ras.data[i + 3] = a;
  }
  return ras;
}

Deno.test("fitPanel reduces to the asked size", () => {
  const out = fitPanel(solid(642, 547, 10, 20, 30), 128, 128);
  assertEquals([out.width, out.height], [128, 128]);
});

Deno.test("fitPanel keeps a flat colour flat", () => {
  // Area averaging over one colour must not drift it, or a panel of sky
  // would come out banded.
  const out = fitPanel(solid(300, 300, 40, 90, 200), 64, 64);
  for (let i = 0; i < out.data.length; i += 4) {
    assertEquals(
      [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]],
      [40, 90, 200, 255],
    );
  }
});

Deno.test("fitPanel averages rather than point-samples", () => {
  // Half black, half white down the middle, reduced to 2 wide: the two
  // pixels must stay black and white, not both take one sample.
  const src = newRaster(64, 2);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 64; x++) {
      const d = (y * 64 + x) * 4;
      const v = x < 32 ? 0 : 255;
      src.data[d] = src.data[d + 1] = src.data[d + 2] = v;
      src.data[d + 3] = 255;
    }
  }
  const out = fitPanel(src, 2, 2);
  assertEquals(out.data[0], 0, "left half stays black");
  assertEquals(out.data[4], 255, "right half stays white");
});

Deno.test("fitPanel does not bleed colour out of transparent pixels", () => {
  // A fully transparent source must stay transparent, and its RGB must not
  // leak into the average — an alpha border would otherwise grey the edge.
  const out = fitPanel(solid(128, 128, 255, 0, 0, 0), 16, 16);
  for (let i = 3; i < out.data.length; i += 4) assertEquals(out.data[i], 0);
});

Deno.test("splitIntoTiles cuts a panel into band-sized pieces", () => {
  const tiles = splitIntoTiles(solid(TILE * 2, TILE * 2, 1, 2, 3));
  assertEquals(tiles.length, 4);
  assertEquals(tiles.map((t) => `${t.col},${t.row}`), [
    "0,0",
    "1,0",
    "0,1",
    "1,1",
  ]);
  for (const t of tiles) {
    assertEquals([t.w, t.h], [TILE, TILE]);
    assertEquals(t.rgba.length, TILE * TILE * 4);
  }
});

Deno.test("splitIntoTiles keeps each piece's own pixels", () => {
  // Left tile red, right tile green, so a mixed-up cut is visible.
  const panel = newRaster(TILE * 2, TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE * 2; x++) {
      const d = (y * TILE * 2 + x) * 4;
      panel.data[d] = x < TILE ? 255 : 0;
      panel.data[d + 1] = x < TILE ? 0 : 255;
      panel.data[d + 3] = 255;
    }
  }
  const [left, right] = splitIntoTiles(panel);
  assertEquals([left.rgba[0], left.rgba[1]], [255, 0]);
  assertEquals([right.rgba[0], right.rgba[1]], [0, 255]);
});

Deno.test("storyPanels returns nothing when a level has no story", async () => {
  assertEquals(await storyPanels(null), []);
  assertEquals(await storyPanels({}), []);
  assertEquals(await storyPanels({ customImages: {} }), []);
});

Deno.test("storyPanels warns past a picture it cannot decode", async () => {
  const warnings: string[] = [];
  const out = await storyPanels(
    { customImages: { stage0_part0: "data:image/gif;base64,bm90YWdpZg==" } },
    { onWarn: (m) => warnings.push(m) },
  );
  assertEquals(out, []);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("stage 0"), warnings[0]);
});

Deno.test("storyPanels takes the opening part of each stage", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const warnings: string[] = [];
  const panels = await storyPanels(level.storyData, {
    onWarn: (m) => warnings.push(m),
  });
  assertEquals(warnings, []);
  // foo tells its story over stages 0-3; stage 4 carries no picture.
  assertEquals(panels.map((p) => p.stage), [0, 1, 2, 3]);
  for (const p of panels) {
    assertEquals(p.sourceKey, `stage${p.stage}_part0`, "the opening part");
    assertEquals([p.picture.width, p.picture.height], [TILE * 2, TILE * 2]);
    assertEquals(p.tiles.length, 4, "a 2x2 block of band-6 records");
    // A panel that came out blank would export an invisible story.
    const opaque = p.tiles.reduce((n, t) => {
      let c = 0;
      for (let i = 3; i < t.rgba.length; i += 4) if (t.rgba[i]) c++;
      return n + c;
    }, 0);
    assert(opaque > 1000, `stage ${p.stage} panel has ${opaque} opaque pixels`);
  }
});

Deno.test("decodeStoryPicture reads the animated GIFs a story is stored as", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const raw = level.storyData.customImages.stage1_part0 as string;
  assert(raw.startsWith("data:image/gif;base64,"), "stored as a GIF data URL");
  const pic = await decodeStoryPicture(raw);
  assert(pic.width > 0 && pic.height > 0);
  assertEquals(pic.data.length, pic.width * pic.height * 4);
});
