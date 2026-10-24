// The story composer every cart writer's `storyBackdrops` come from, run by
// the CLI builds and by the editor in the page. Self-contained: the face is a
// synthetic sheet and the pictures come from a stub `decodePicture`, because
// decoding is the caller's (packages/shmup-harbor/tests/story_panels_test.ts
// covers the CLI's decoders and the real face; tests/engine_bundle_test.ts
// checks the bundle the page runs against the CLI on foo's story).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  bitmapFontFromSheet,
  foldToAscii,
  renderText,
  wrapText,
} from "../src/story/bitmap-font.js";
import {
  BACKDROP_H,
  BACKDROP_ROW,
  BACKDROP_W,
  storyBackdrops,
  storyLogLine,
} from "../src/story/story-panels.js";

/** A 95-glyph sheet in which every glyph is a solid 8x8 block of ink. */
function solidSheet(glyphs = 95) {
  const width = glyphs * 8, height = 8;
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

function solid(width, height, rgb) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width, height, data };
}

Deno.test("bitmapFontFromSheet reads the sheet's alpha as ink", () => {
  const sheet = solidSheet(3);
  // Glyph 1's top-left pixel left clear.
  sheet.data[8 * 4 + 3] = 0;
  const font = bitmapFontFromSheet(sheet);
  assertEquals([font.glyphW, font.glyphH, font.glyphs.length], [8, 8, 3]);
  assertEquals(font.glyphs[0][0], 1);
  assertEquals(font.glyphs[1][0], 0);
  assertEquals(font.glyphs[1][1], 1);
  assertThrows(
    () =>
      bitmapFontFromSheet({
        width: 64,
        height: 4,
        data: new Uint8Array(64 * 16),
      }),
    Error,
    "4 rows",
  );
});

Deno.test("wrapText folds an editor's typography and never overruns a line", () => {
  assertEquals(
    foldToAscii("humanity’s “last” hope…"),
    'humanity\'s "last" hope...',
  );
  assertEquals(wrapText("one two three", 7), ["one two", "three"]);
  assertEquals(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assertEquals(wrapText("a\n\nb", 9), ["a", "", "b"]);
});

Deno.test("renderText inks the glyphs in the caller's colour", () => {
  const font = bitmapFontFromSheet(solidSheet());
  const r = renderText(font, "A", 8, 8, { colour: [10, 20, 30] });
  assertEquals(Array.from(r.data.subarray(0, 4)), [10, 20, 30, 255]);
});

Deno.test("storyBackdrops hands decodePicture each stage's opening picture", async () => {
  const font = bitmapFontFromSheet(solidSheet());
  const asked = [];
  const out = await storyBackdrops(
    {
      speaker: "GS",
      customImages: {
        stage0_part10: "data:image/gif;base64,LATER",
        stage0_part2: "data:image/gif;base64,FIRST",
        stage1_part0: "data:image/gif;base64,ONE",
      },
      stage0: { part: [{ text: "first words" }, { text: "second words" }] },
      stage1: { part: [{ text: "" }] },
    },
    {
      font,
      decodePicture: (url) => {
        asked.push(url);
        return Promise.resolve(solid(180, 240, [200, 40, 40]));
      },
    },
  );
  // part2 opens stage 0, not part10: the parts sort by number, not by text.
  assertEquals(asked, [
    "data:image/gif;base64,FIRST",
    "data:image/gif;base64,ONE",
  ]);
  assertEquals(out.map((b) => [b.stage, b.sourceKey, b.speaker]), [[
    0,
    "stage0_part2",
    "GS",
  ], [1, "stage1_part0", "GS"]]);

  const [zero, one] = out;
  assertEquals(zero.variants.map((v) => v.label.replace(/\d+x\d+/, "WxH")), [
    "picture WxH + words",
    "picture WxH + words",
    "picture WxH + words",
    "words",
    "opening words",
  ]);
  assertEquals(
    zero.variants[0].h,
    BACKDROP_H,
    "the largest fills the opening screen",
  );
  // Stage 1 says nothing, so it is its picture alone, at the full height.
  assertEquals(one.variants[0].label, "picture 144x192");
  for (const b of out) {
    for (let i = 0; i < b.variants.length; i++) {
      const v = b.variants[i];
      assertEquals(v.w, BACKDROP_W);
      assertEquals(v.h % BACKDROP_ROW, 0);
      assertEquals(v.rgba.length, v.w * v.h * 4);
      if (i) {
        assert(v.h <= b.variants[i - 1].h, `stage ${b.stage}: largest first`);
      }
    }
  }
});

Deno.test("storyBackdrops keeps the words when a picture cannot be decoded, or no decoder is given", async () => {
  const font = bitmapFontFromSheet(solidSheet());
  const story = {
    customImages: { stage0_part0: "data:image/png;base64,AAAA" },
    stage0: { part: [{ text: "still told" }] },
  };
  const warnings = [];
  const failed = await storyBackdrops(story, {
    font,
    decodePicture: () =>
      Promise.reject(new Error("the source image could not be decoded")),
    onWarn: (m) => warnings.push(m),
  });
  assertEquals(warnings, [
    "story picture for stage 0 (stage0_part0): the source image could not be decoded",
  ]);
  assertEquals(
    failed.map((b) => [b.stage, b.sourceKey, b.variants.map((v) => v.label)]),
    [[0, null, ["words"]]],
  );

  const wordsOnly = await storyBackdrops(story, { font });
  assertEquals(wordsOnly.map((b) => b.variants.map((v) => v.label)), [[
    "words",
  ]]);
  assertEquals(
    await storyBackdrops(story),
    [],
    "no face and no decoder: nothing to draw",
  );
  assertEquals(await storyBackdrops(null), []);
});

Deno.test("storyLogLine says what each cart stage opens on and what the cart cannot hold", () => {
  const backdrops = [{ stage: 0 }, { stage: 1 }, { stage: 4 }];
  assertEquals(
    storyLogLine(backdrops, [
      { key: "stage0", story: { size: "words", rows: 3 } },
      { key: "stage1", story: null },
      { key: "stage1:stage2", story: null },
    ]),
    "story: opens stage0 words (3 rows) (stage 4 of the story has no stage on the cart)",
  );
  assertEquals(
    storyLogLine(backdrops.slice(0, 1), [{ key: "stage0" }]),
    "story: no stage has room for it",
  );
  assertEquals(
    storyLogLine([], []),
    "story: the level tells none — stages open as they are",
  );
});
