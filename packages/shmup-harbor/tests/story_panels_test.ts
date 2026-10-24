// Story backdrops: the level's story — its pictures and words — drawn as the
// opening rows of each stage's background on a cart. The foo level is
// committed, so the end-to-end case runs without a fixture.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BACKDROP_H,
  BACKDROP_ROW,
  BACKDROP_W,
  composeBackdrop,
  containPicture,
  decodeStoryPicture,
  fitPanel,
  storyBackdrops,
  storyParts,
  storySpeaker,
} from "../lib/story-panels.ts";
import { loadAthenaFont } from "../lib/bitmap-font.ts";
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

Deno.test("decodeStoryPicture reads the animated GIFs a story is stored as", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const raw = level.storyData.customImages.stage1_part0 as string;
  assert(raw.startsWith("data:image/gif;base64,"), "stored as a GIF data URL");
  const pic = await decodeStoryPicture(raw);
  assert(pic.width > 0 && pic.height > 0);
  assertEquals(pic.data.length, pic.width * pic.height * 4);
});

Deno.test("containPicture keeps the picture's own shape", () => {
  const out = containPicture(solid(180, 240, 9, 9, 9), BACKDROP_W, 160);
  assertEquals([out.width, out.height], [120, 160]);
});

Deno.test("storyParts and storySpeaker read a story as the web scene does", () => {
  const sd = {
    speaker: " GS ",
    stage0: { part: [{ text: "one" }, { text: "" }, { text: "two" }] },
  };
  assertEquals(storyParts(sd, 0), ["one", "two"], "an empty part says nothing");
  assertEquals(storyParts(sd, 1), []);
  assertEquals(storySpeaker(sd), "GS");
  assertEquals(storySpeaker({}), "G", "2028.Ai's own story is G's");
});

Deno.test("composeBackdrop sets the words over the picture, in whole rows", async () => {
  const font = await loadAthenaFont(repoRoot());
  const pic = solid(100, 50, 200, 40, 40);
  const out = composeBackdrop(font, "GS", ["hello"], pic);
  assertEquals(out.width, BACKDROP_W);
  assertEquals(out.height % BACKDROP_ROW, 0);
  const at = (x: number, y: number) =>
    Array.from(
      out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 4),
    );
  // The plate's white edge at the top left; the picture centred lower down.
  assertEquals(at(4, 0), [255, 255, 255, 255]);
  let picTop = -1;
  for (let y = 0; y < out.height && picTop < 0; y++) {
    if (at(BACKDROP_W / 2, y)[0] === 200) picTop = y;
  }
  assert(picTop > 20, `the picture sits under the words (row ${picTop})`);
  assertEquals(at(62, picTop), [200, 40, 40, 255], "its left edge at x 62");
  assertEquals(at(61, picTop)[3], 0, "transparent beside it");
});

Deno.test("storyBackdrops returns nothing when a level has no story", async () => {
  assertEquals(await storyBackdrops(null), []);
  assertEquals(await storyBackdrops({}), []);
  assertEquals(await storyBackdrops({ customImages: {} }), []);
});

Deno.test("storyBackdrops keeps a stage's words past a picture it cannot decode", async () => {
  const warnings: string[] = [];
  const out = await storyBackdrops(
    {
      customImages: { stage0_part0: "data:image/gif;base64,bm90YWdpZg==" },
      stage0: { part: [{ text: "still told" }] },
    },
    { font: await loadAthenaFont(repoRoot()), onWarn: (m) => warnings.push(m) },
  );
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("stage 0"), warnings[0]);
  assertEquals(out.map((b) => [b.stage, b.sourceKey]), [[0, null]]);
  assertEquals(out[0].variants.map((v) => v.label), ["words"]);
});

Deno.test("storyBackdrops draws every stage of foo's story, largest first", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const warnings: string[] = [];
  const out = await storyBackdrops(level.storyData, {
    font: await loadAthenaFont(repoRoot()),
    onWarn: (m) => warnings.push(m),
  });
  assertEquals(warnings, []);
  // foo has pictures for stages 0-3 and words for 0-4.
  assertEquals(out.map((b) => [b.stage, b.sourceKey]), [
    [0, "stage0_part0"],
    [1, "stage1_part0"],
    [2, "stage2_part0"],
    [3, "stage3_part0"],
    [4, null],
  ]);
  for (const b of out) {
    assertEquals(b.speaker, "G");
    const labels = b.variants.map((v) => v.label);
    if (b.sourceKey) {
      assert(/^picture \d+x\d+ \+ words$/.test(labels[0]), labels[0]);
      assertEquals(b.variants[0].h, BACKDROP_H, "the opening screen, filled");
    }
    assert(labels.includes("words"), `stage ${b.stage}: ${labels}`);
    for (let i = 0; i < b.variants.length; i++) {
      const v = b.variants[i];
      assertEquals(v.w, BACKDROP_W);
      assertEquals(v.h % BACKDROP_ROW, 0);
      assertEquals(v.rgba.length, v.w * v.h * 4);
      if (i) assert(v.h <= b.variants[i - 1].h, `stage ${b.stage}: ${labels}`);
    }
  }
});

Deno.test("storyBackdrops fills a cart's own room: Dezaemon Kids! opens with 160 px", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const out = await storyBackdrops(level.storyData, {
    font: await loadAthenaFont(repoRoot()),
    height: 160,
  });
  for (const b of out.filter((b) => b.sourceKey)) {
    assertEquals(
      b.variants[0].h,
      160,
      `stage ${b.stage}: the opening screen, filled`,
    );
    assert(b.variants.every((v) => v.h <= 160), `stage ${b.stage}`);
  }
});
