// Pictures attached to the DESCRIBE IT box (mcp/lib/upload.ts): the checks
// that keep a hostile or broken upload from costing the server anything, the
// analysis that tells the model what is in a picture, and the cut that turns
// a region of one into a frame the packer can use.
//
// Every picture here is built in code, small and seeded, so each test states
// exactly what the answer must be: a gutter of 21 px splits two subjects,
// glyphs 2–6 px apart do not; an 8x6 sprite enlarged x7 with blended edges
// comes back pixel for pixel; ink turns darkness into alpha. The one real
// picture — the screenshot this feature was built for, a smoothed x12
// fighter beside ASCII art — runs only when UPLOAD_FIXTURE points at it,
// since it is not committed.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { deflate } from "@shmupx/shmup-harbor/deflate";
import { cut } from "@shmupx/shmup-harbor/raster";
import {
  analyzeUpload,
  checkUploads,
  cutUpload,
  decodeUploads,
  describeUploads,
  detectPixelScale,
  MAX_UPLOAD_SIDE,
  MAX_UPLOADS,
  openUploads,
  type UploadedImage,
  UploadError,
} from "../mcp/lib/upload.ts";

/** ─── building pictures ──────────────────────────────────────────────────── */

type RGBA = [number, number, number, number];

const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

/** mulberry32 — a seeded PRNG, so every "random" picture is the same picture. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function field(w: number, h: number, colour: RGBA): Raster {
  const r = newRaster(w, h);
  for (let i = 0; i < w * h; i++) r.data.set(colour, i * 4);
  return r;
}

function fill(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: RGBA,
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      r.data.set(colour, (yy * r.width + xx) * 4);
    }
  }
}

function px(r: Raster, x: number, y: number): RGBA {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
}

/** Colours far enough apart that even a half-and-half blend is an edge. */
const PALETTE: RGBA[] = [
  [200, 30, 30, 255],
  [30, 160, 40, 255],
  [40, 60, 200, 255],
  [220, 200, 40, 255],
  [20, 20, 20, 255],
  [150, 60, 180, 255],
];

/** Native pixel art: every pixel differs from its left and upper neighbour. */
function sprite(w: number, h: number, seed: number): Raster {
  const next = rng(seed);
  const r = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c: RGBA;
      do {
        c = PALETTE[Math.floor(next() * PALETTE.length)];
      } while (
        (x > 0 && px(r, x - 1, y)[0] === c[0]) ||
        (y > 0 && px(r, x, y - 1)[0] === c[0])
      );
      r.data.set(c, (y * w + x) * 4);
    }
  }
  return r;
}

/**
 * Enlarge `art` by `scale` onto `dst` at (ox, oy). Nearest-neighbour, with
 * `blend` making every block boundary inside the art a one-pixel average of
 * the blocks either side, the way a smoothed enlargement smears it.
 */
function enlargeOnto(
  dst: Raster,
  art: Raster,
  scale: number,
  ox: number,
  oy: number,
  blend = false,
): void {
  const w = Math.round(art.width * scale), h = Math.round(art.height * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.min(art.width - 1, Math.floor(x / scale));
      const by = Math.min(art.height - 1, Math.floor(y / scale));
      const xs = blend && x % scale === 0 && bx > 0 ? [bx - 1, bx] : [bx];
      const ys = blend && y % scale === 0 && by > 0 ? [by - 1, by] : [by];
      const sum = [0, 0, 0, 0];
      for (const sy of ys) {
        for (const sx of xs) {
          const c = px(art, sx, sy);
          for (let k = 0; k < 4; k++) sum[k] += c[k];
        }
      }
      const n = xs.length * ys.length;
      dst.data.set(
        sum.map((v) => Math.round(v / n)),
        ((oy + y) * dst.width + ox + x) * 4,
      );
    }
  }
}

function picture(raster: Raster, name = "pic", index = 0): UploadedImage {
  return {
    index,
    name,
    raster,
    analysis: analyzeUpload(raster),
    png_base64: "",
  };
}

async function pngBase64(raster: Raster): Promise<string> {
  return encodeBase64(await encodePng(raster));
}

/**
 * A white page with a solid red block on the left and, 21 px to its right,
 * a "text" blob: rows of black glyph boxes of random size, 2–6 px apart on
 * both axes, bottoms on a shared baseline the way type sits.
 *
 * 1400 px wide, the motivating picture's width, so the merge distance is 14
 * and the 21 px gutter sits between gap + 1 and 2 · gap: a page any narrower
 * would split at that gutter even with the centred growth grow() warns about,
 * which merges across twice the gap.
 */
function twoSubjects(): Raster {
  const next = rng(7);
  const r = field(1400, 400, WHITE);
  fill(r, 20, 50, 300, 300, [210, 40, 40, 255]); // x 20..319
  let y = 40;
  while (y < 330) {
    const lineH = 9;
    let x = 341; // 320..340 is the 21 px gutter
    while (x < 930) {
      const gw = 3 + Math.floor(next() * 5);
      const gh = 5 + Math.floor(next() * 5);
      fill(r, x, y + lineH - gh, gw, gh, BLACK);
      x += gw + 2 + Math.floor(next() * 5);
    }
    y += lineH + 2 + Math.floor(next() * 5);
  }
  return r;
}

/** ─── analysis ───────────────────────────────────────────────────────────── */

Deno.test("a 21 px gutter splits two subjects; glyphs 2–6 px apart stay one", () => {
  const a = analyzeUpload(twoSubjects());
  assertEquals(a.background?.hex, "#ffffff");
  assertEquals(a.background?.transparent, false);
  assertEquals(a.regions.length, 2);
  const [block, text] = a.regions;
  assertEquals([block.x, block.y, block.w, block.h], [20, 50, 300, 300]);
  assertEquals(block.kind, "image");
  assertEquals(text.index, 1);
  assertEquals(text.x, 341);
  assertEquals(text.kind, "monochrome");
  assertEquals(text.darkOnLight, true);
  assertEquals(text.pixelScale, 1, "aperiodic glyphs are not pixel art");
  assertEquals(text.native, { w: text.w, h: text.h });
});

Deno.test("regions run left to right, then top to bottom", () => {
  const r = field(800, 600, WHITE);
  fill(r, 500, 40, 60, 60, BLACK);
  fill(r, 100, 400, 60, 60, BLACK);
  fill(r, 100, 40, 60, 60, BLACK);
  const xy = analyzeUpload(r).regions.map((g) => [g.index, g.x, g.y]);
  assertEquals(xy, [[0, 100, 40], [1, 100, 400], [2, 500, 40]]);
});

Deno.test("a sheet of twenty subjects lists twelve of them", () => {
  // 20 boxes 19 px apart, well over the 8 px merge distance at this width.
  const r = field(800, 100, WHITE);
  for (let k = 0; k < 20; k++) fill(r, 10 + k * 39, 40, 20, 20, BLACK);
  assertEquals(analyzeUpload(r).regions.length, 12);
});

Deno.test("specks are dropped, but a tiny picture keeps its only subject", () => {
  const r = field(800, 600, WHITE);
  fill(r, 100, 100, 80, 80, BLACK);
  fill(r, 600, 500, 3, 3, BLACK); // 9 px² under max(24, 480)
  assertEquals(analyzeUpload(r).regions.length, 1);

  const bullet = field(12, 12, WHITE);
  fill(bullet, 4, 4, 4, 4, [255, 0, 0, 255]); // 16 px², still the subject
  const only = analyzeUpload(bullet).regions;
  assertEquals(only.map((g) => [g.x, g.y, g.w, g.h]), [[4, 4, 4, 4]]);
});

Deno.test("a transparent border is a transparent background; noise has none", () => {
  const r = newRaster(64, 64); // alpha 0 everywhere
  fill(r, 20, 20, 10, 12, [0, 200, 0, 255]);
  const a = analyzeUpload(r);
  assertEquals(a.background?.transparent, true);
  assertEquals(a.regions.map((g) => [g.x, g.y, g.w, g.h]), [[20, 20, 10, 12]]);
  assertEquals(a.regions[0].darkOnLight, false);

  const next = rng(3);
  const photo = newRaster(50, 40);
  for (let i = 0; i < photo.data.length; i++) {
    photo.data[i] = i % 4 === 3 ? 255 : Math.floor(next() * 256);
  }
  const b = analyzeUpload(photo);
  assertEquals(b.background, null);
  assertEquals(b.regions.map((g) => [g.x, g.y, g.w, g.h]), [[0, 0, 50, 40]]);
});

Deno.test("a noisy grey field is the background even when a solid strip outnumbers each of its buckets", () => {
  // Grey 127.5 ± 2 per channel straddles the 127/128 bucket edge on all
  // three channels, so it lands in eight buckets of about a tenth of the
  // border each; the blue strip along the bottom is a third of it in one.
  const next = rng(12);
  const r = field(400, 300, WHITE);
  for (let i = 0; i < 400 * 300; i++) {
    for (let c = 0; c < 3; c++) {
      r.data[i * 4 + c] = Math.round(127.5 + next() * 4 - 2);
    }
  }
  fill(r, 0, 280, 400, 20, [30, 60, 200, 255]);
  fill(r, 150, 100, 100, 100, [220, 30, 30, 255]);
  const a = analyzeUpload(r);
  assert(a.background, "the grey is two-thirds of the border");
  for (const c of [a.background.r, a.background.g, a.background.b]) {
    assert(Math.abs(c - 127.5) <= 1, a.background.hex);
  }
  assertEquals(a.regions.map((g) => [g.x, g.y, g.w, g.h]), [
    [0, 280, 400, 20],
    [150, 100, 100, 100],
  ]);
});

/** ─── pixel scale ────────────────────────────────────────────────────────── */

Deno.test("x7 pixel art with blended edges is found and comes back exact", () => {
  const art = sprite(8, 6, 11);
  const r = field(70, 60, WHITE);
  enlargeOnto(r, art, 7, 3, 5, true);
  const a = analyzeUpload(r);
  assertEquals(a.regions.length, 1);
  const region = a.regions[0];
  assertEquals([region.x, region.y, region.w, region.h], [3, 5, 56, 42]);
  assert(Math.abs(region.pixelScale - 7) <= 0.1, `${region.pixelScale}`);
  assertEquals(region.kind, "pixel-art");
  assertEquals(region.native, { w: 8, h: 6 });

  const frame = cutUpload([picture(r, "fighter")], { upload: 0, region: 0 });
  assertEquals([frame.raster.width, frame.raster.height], [8, 6]);
  assertEquals(Array.from(frame.raster.data), Array.from(art.data));
  assertEquals(frame.name, "fighter_r0");
  assertEquals(frame.source, "upload:0#region0");
  assertEquals(frame.scope, "upload0");
});

Deno.test("a fractional enlargement (x12.3 nearest) is found to within 0.1", () => {
  const art = sprite(10, 8, 5);
  const r = field(140, 110, WHITE);
  enlargeOnto(r, art, 12.3, 6, 4);
  const region = analyzeUpload(r).regions[0];
  assert(Math.abs(region.pixelScale - 12.3) <= 0.1, `${region.pixelScale}`);
  assert(Math.abs(region.native.w - 10) <= 1, JSON.stringify(region.native));
  assert(Math.abs(region.native.h - 8) <= 1, JSON.stringify(region.native));
  const frame = cutUpload([picture(r)], { upload: 0, region: 0 });
  assert(Math.abs(frame.raster.width - 10) <= 1);
  assert(Math.abs(frame.raster.height - 8) <= 1);
  // Block centres are pure colour, so what does come back is the art's own.
  assertEquals(px(frame.raster, 4, 3), px(art, 4, 3));
});

Deno.test("small crisp enlargements (x2, x3) are found too", () => {
  for (const scale of [2, 3]) {
    const art = sprite(16, 12, 20 + scale);
    const r = field(16 * scale + 10, 12 * scale + 10, WHITE);
    enlargeOnto(r, art, scale, 5, 5);
    const region = analyzeUpload(r).regions[0];
    assertEquals(region.pixelScale, scale, `x${scale}`);
    const frame = cutUpload([picture(r)], { upload: 0, region: 0 });
    assertEquals(Array.from(frame.raster.data), Array.from(art.data));
  }
});

Deno.test("a plain box is not a grid: two edges prove no period", () => {
  const r = field(40, 40, WHITE);
  fill(r, 8, 8, 24, 24, [200, 30, 30, 255]);
  assertEquals(detectPixelScale(r).scale, 1);
});

Deno.test("pixelScale 1 keeps every pixel; a named scale is used as given", () => {
  const art = sprite(8, 6, 11);
  const r = field(70, 60, WHITE);
  enlargeOnto(r, art, 7, 3, 5, true);
  const keep = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    pixelScale: 1,
  });
  assertEquals([keep.raster.width, keep.raster.height], [56, 42]);
  const named = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    pixelScale: 7,
  });
  assertEquals(Array.from(named.raster.data), Array.from(art.data));
});

/** The RGBA of every pixel that is not fully transparent, in reading order. */
function opaque(r: Raster): number[] {
  const out: number[] = [];
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3]) out.push(...r.data.subarray(i, i + 4));
  }
  return out;
}

Deno.test("a cut that does not start on a block boundary still samples block centres", () => {
  // A region's box always starts on a block, so phase 0 would do there.
  // The whole picture, a named scale and a crop all start 3 and 5 px (or 3
  // and 4) into the field, and only the grid's phase steps over the blended
  // block edges to the pure colour in the middle of each block.
  const art = sprite(8, 6, 11);
  const r = field(70, 60, WHITE);
  enlargeOnto(r, art, 7, 3, 5, true);
  const ups = [picture(r)];
  for (
    const ref of [
      { upload: 0 },
      { upload: 0, pixelScale: 7 },
      { upload: 0, crop: { x: 0, y: 1, w: 70, h: 59 } },
    ]
  ) {
    const frame = cutUpload(ups, ref);
    assertEquals(
      opaque(frame.raster),
      Array.from(art.data),
      JSON.stringify(ref),
    );
  }
});

Deno.test("when the axes disagree, the period that divides the other wins", () => {
  // A 7x6 heart at crisp x2: across, its edges fall every 2 px; down, the
  // shape changes on so few rows that most of its edges are 4 px apart, and
  // the y axis alone would read x4 — a 3x3 blob.
  const rows = [
    ".##.##.",
    "#######",
    "#######",
    ".#####.",
    "..###..",
    "...#...",
  ];
  const art = newRaster(7, 6);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) =>
      art.data.set(c === "#" ? [200, 30, 30, 255] : WHITE, (y * 7 + x) * 4)
    )
  );
  const r = field(34, 32, WHITE);
  enlargeOnto(r, art, 2, 10, 10);
  const region = analyzeUpload(r).regions[0];
  assertEquals(region.pixelScale, 2);
  assertEquals(region.native, { w: 7, h: 6 });
  const frame = cutUpload([picture(r)], { upload: 0, region: 0 });
  const drawn: string[] = [];
  for (let y = 0; y < frame.raster.height; y++) {
    let line = "";
    for (let x = 0; x < frame.raster.width; x++) {
      line += px(frame.raster, x, y)[3] ? "#" : ".";
    }
    drawn.push(line);
  }
  assertEquals(drawn, rows);
});

Deno.test("a grid on one axis only is type, not pixel art", () => {
  // Nine lines of glyphs 9 px tall on a 12 px pitch: every horizontal edge
  // sits on a 3 px grid. Across, more than half the glyphs are snapped to a
  // 12 px column the way monospace ASCII art lines up — enough for the x
  // axis to half agree with x3, not enough to be a grid. At half the bar
  // this read as x2.98 pixel art and came back a few pixels wide.
  const next = rng(4);
  const r = field(140, 140, WHITE);
  for (let line = 0; line < 9; line++) {
    const y = 20 + line * 12;
    let x = 20;
    while (x < 110) {
      const w = 2 + Math.floor(next() * 6);
      const at = next() < 0.55 ? Math.ceil(x / 12) * 12 : x;
      if (at + w > 120) break;
      fill(r, at, y, w, 9, BLACK);
      x = at + w + 2 + Math.floor(next() * 4);
    }
  }
  const [region] = analyzeUpload(r).regions;
  assertEquals(region.pixelScale, 1);
  assertEquals(region.kind, "monochrome");
  const frame = cutUpload([picture(r)], { upload: 0, region: 0, ink: "#fff" });
  assertEquals([frame.raster.width, frame.raster.height], [region.w, region.h]);
});

Deno.test("past the detection budget a region reports x1, and a cut still finds its scale", () => {
  // Three 550 px subjects and one 440 px one: 3 · 1100 + 880 is over the
  // 4096 px of width-plus-height a picture is measured for, so the smallest
  // goes unmeasured.
  const big = sprite(50, 50, 31), small = sprite(40, 40, 32);
  const r = field(1170, 1170, WHITE);
  enlargeOnto(r, big, 11, 10, 10);
  enlargeOnto(r, big, 11, 600, 10);
  enlargeOnto(r, big, 11, 10, 600);
  enlargeOnto(r, small, 11, 600, 600);
  const up = picture(r);
  const regions = up.analysis.regions;
  assertEquals(regions.length, 4);
  const unmeasured = regions.filter((g) => g.pixelScale === 1);
  assertEquals(unmeasured.map((g) => [g.x, g.y]), [[600, 600]]);
  assertEquals(unmeasured[0].native, { w: 440, h: 440 });
  assertEquals(regions.filter((g) => g.pixelScale === 11).length, 3);
  const frame = cutUpload([up], { upload: 0, region: unmeasured[0].index });
  assertEquals(Array.from(frame.raster.data), Array.from(small.data));
});

/** ─── background ─────────────────────────────────────────────────────────── */

Deno.test("ink turns darkness into alpha and every pixel into the ink", () => {
  const r = field(40, 20, WHITE);
  fill(r, 10, 5, 8, 2, BLACK);
  fill(r, 10, 9, 2, 6, BLACK);
  fill(r, 18, 5, 1, 2, [128, 128, 128, 255]); // anti-aliasing
  fill(r, 12, 9, 1, 1, [200, 200, 200, 255]);
  const up = picture(r, "text");
  const region = up.analysis.regions[0];
  const frame = cutUpload([up], {
    upload: 0,
    region: 0,
    ink: "#fff",
    pixelScale: 1,
  });
  assertEquals([frame.raster.width, frame.raster.height], [region.w, region.h]);
  const source = cut(r, region);
  for (let i = 0; i < source.data.length; i += 4) {
    assertEquals(
      Array.from(frame.raster.data.subarray(i, i + 3)),
      [255, 255, 255],
    );
    assertEquals(frame.raster.data[i + 3], 255 - source.data[i]);
  }
  // A named ink works the same way.
  const red = cutUpload([up], { upload: 0, region: 0, ink: "red" });
  assertEquals(px(red.raster, 0, 0), [255, 0, 0, 255]);
});

Deno.test("ink makes the strongest stroke opaque even when it is only grey", () => {
  // A pencil scan or grey line art: nothing in it is darker than #808080,
  // and alpha is darkness relative to the darkest pixel in the cut, not to
  // black — otherwise it would top out at half opacity on the starfield.
  const r = field(40, 20, WHITE);
  fill(r, 10, 5, 8, 6, [128, 128, 128, 255]);
  const frame = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    ink: "#fff",
    pixelScale: 1,
  });
  assertEquals(px(frame.raster, 0, 0), [255, 255, 255, 255]);
});

Deno.test("ink shrunk to a shot keeps its strongest stroke opaque", () => {
  const r = twoSubjects();
  const frame = cutUpload([picture(r)], {
    upload: 0,
    region: 1,
    ink: "#ffffff",
    maxSize: 24,
  });
  assertEquals(Math.max(frame.raster.width, frame.raster.height), 24);
  let most = 0;
  for (let i = 3; i < frame.raster.data.length; i += 4) {
    most = Math.max(most, frame.raster.data[i]);
  }
  assertEquals(most, 255);
});

Deno.test("remove drops the outer field and keeps an enclosed highlight", () => {
  const r = field(40, 40, WHITE);
  fill(r, 10, 10, 20, 20, [200, 30, 30, 255]);
  fill(r, 17, 17, 5, 5, WHITE); // a glint, enclosed by red
  const frame = cutUpload([picture(r)], { upload: 0, pixelScale: 1 });
  assertEquals(px(frame.raster, 0, 0)[3], 0, "outer field gone");
  assertEquals(px(frame.raster, 39, 20)[3], 0, "outer field gone");
  assertEquals(px(frame.raster, 19, 19), WHITE, "highlight kept");
  assertEquals(px(frame.raster, 12, 12), [200, 30, 30, 255]);
  const kept = cutUpload([picture(r)], {
    upload: 0,
    pixelScale: 1,
    background: "keep",
  });
  assertEquals(px(kept.raster, 0, 0), WHITE);
});

Deno.test("remove floods from every border pixel, so each corner pocket goes", () => {
  // A region's box is the subject's own bounds, so the subject touches all
  // four sides of the cut and splits the field into separate pockets — here
  // the four corners round a plus sign. A flood from any one seed would
  // clear one corner and leave three opaque white squares.
  const r = field(60, 60, WHITE);
  fill(r, 10, 25, 40, 10, [200, 30, 30, 255]);
  fill(r, 25, 10, 10, 40, [200, 30, 30, 255]);
  const frame = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    pixelScale: 1,
  });
  assertEquals([frame.raster.width, frame.raster.height], [40, 40]);
  for (const [x, y] of [[0, 0], [39, 0], [0, 39], [39, 39]]) {
    assertEquals(px(frame.raster, x, y)[3], 0, `corner ${x},${y}`);
  }
  assertEquals(px(frame.raster, 20, 20), [200, 30, 30, 255]);
});

/** ─── sizing ─────────────────────────────────────────────────────────────── */

Deno.test("maxSize shrinks to fit and never enlarges; scale enlarges last", () => {
  const r = field(300, 200, WHITE);
  fill(r, 50, 50, 200, 100, [30, 160, 40, 255]);
  const shot = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    maxSize: 40,
  });
  assertEquals([shot.raster.width, shot.raster.height], [40, 20]);
  assertEquals(px(shot.raster, 20, 10), [30, 160, 40, 255]);
  const same = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    maxSize: 250,
  });
  assertEquals([same.raster.width, same.raster.height], [200, 100]);
  const big = cutUpload([picture(r)], {
    upload: 0,
    region: 0,
    maxSize: 20,
    scale: 3,
    as: "my shot!",
  });
  assertEquals([big.raster.width, big.raster.height], [60, 30]);
  assertEquals(big.name, "my_shot");
});

Deno.test("crop cuts a rectangle, clamped to the picture", () => {
  const r = field(100, 80, WHITE);
  fill(r, 50, 40, 50, 40, [30, 160, 40, 255]);
  const frame = cutUpload([picture(r, "grass")], {
    upload: 0,
    crop: { x: 90, y: 70, w: 30, h: 30 },
  });
  assertEquals([frame.raster.width, frame.raster.height], [10, 10]);
  assertEquals(frame.name, "grass_crop");
  assertEquals(frame.source, "upload:0#crop 90,70,10,10");
});

/** ─── what the model is told when it gets something wrong ──────────────── */

Deno.test("every refusal says what to send instead", () => {
  const ups = [picture(twoSubjects())];
  const no = (ref: Parameters<typeof cutUpload>[1], text: string) =>
    assertStringIncludes(
      assertThrows(() => cutUpload(ups, ref), UploadError).message,
      text,
    );
  no({ upload: 2 }, "No picture 2 — this request has 1 (upload 0)");
  no({ upload: 0, region: 3 }, "has 2 regions (0, 1); region 3 is not one");
  no({ upload: 0, region: 0, crop: { x: 0, y: 0, w: 9, h: 9 } }, "not both");
  no({ upload: 0, region: 1, background: "keep" }, "pass maxSize");
  // 300 px shrunk to 100 fits; enlarged x3 afterwards it does not.
  no({ upload: 0, region: 0, maxSize: 100, scale: 3 }, "or a smaller scale");
  no(
    { upload: 0, crop: { x: 2000, y: 0, w: 9, h: 9 } },
    "holds none of picture 0",
  );
  no({ upload: 0, crop: { x: 960, y: 360, w: 30, h: 30 } }, "came out empty");
  no({ upload: 0, region: 1, ink: "chartreuse-ish" }, 'such as "#ffffff"');
  no({ upload: 0, region: 1, scale: 9 }, "whole number 1–4");
  assertStringIncludes(
    assertThrows(() => cutUpload(undefined, { upload: 0 }), UploadError)
      .message,
    "No picture is attached",
  );
});

Deno.test("describeUploads lists each picture's regions as the model needs them", () => {
  const art = sprite(8, 6, 11);
  const r = field(70, 60, WHITE);
  enlargeOnto(r, art, 7, 3, 5, true);
  const text = describeUploads([
    picture(r, "ryuda"),
    picture(twoSubjects(), "page", 1),
  ]);
  const lines = text.split("\n");
  assertEquals(lines[0], 'Picture 0 "ryuda": 70×60 px, background #ffffff.');
  assertEquals(
    lines[1],
    "  region 0: x 3 y 5, 56×42 — pixel art at ×7 (8×6 native)",
  );
  assertEquals(lines[2], 'Picture 1 "page": 1400×400 px, background #ffffff.');
  assertStringIncludes(lines[4], "  region 1: x 341 y ");
  assertStringIncludes(
    lines[4],
    "monochrome, dark on light (text or line art)",
  );
});

/** ─── decoding the request ───────────────────────────────────────────────── */

Deno.test("decodeUploads takes nothing, and a data: URL as well as bare base64", async () => {
  assertEquals(await decodeUploads(undefined), []);
  assertEquals(await decodeUploads(null), []);
  const r = field(30, 20, WHITE);
  fill(r, 5, 5, 10, 10, BLACK);
  const b64 = await pngBase64(r);
  const [a, b] = await decodeUploads([
    { name: "my pic.png", png: `data:image/png;base64,${b64}` },
    { png: b64 },
  ]);
  assertEquals(a.png_base64, b64, "the prefix is stripped");
  assertEquals(a.name, "my_pic");
  assertEquals([a.index, b.index], [0, 1]);
  assertEquals(b.name, "upload");
  assertEquals(Array.from(a.raster.data), Array.from(r.data));
  assertEquals(a.analysis.regions.map((g) => [g.x, g.y, g.w, g.h]), [[
    5,
    5,
    10,
    10,
  ]]);
});

Deno.test("decodeUploads refuses garbage with a message the player can act on", async () => {
  const refuses = async (input: unknown, text: string) =>
    assertStringIncludes(
      (await assertRejects(() => decodeUploads(input), UploadError)).message,
      text,
    );
  const ok = await pngBase64(field(4, 4, WHITE));
  await refuses({ png: ok }, "must be a list");
  await refuses([{ name: "x" }], "Picture 0 has no png");
  await refuses(
    [{ png: ok }, { png: "!!not base64!!" }],
    "Picture 1 is not base64",
  );
  await refuses(
    [{ png: encodeBase64(new TextEncoder().encode("GIF89a, not a png")) }],
    "is not a PNG",
  );
  await refuses(
    Array.from({ length: MAX_UPLOADS + 1 }, () => ({ png: ok })),
    `at most ${MAX_UPLOADS}`,
  );
  // 5.6 MB of something that is not even base64: refused from its length,
  // since decoding it would have said "not base64" instead.
  await refuses([{ png: "!!!!".repeat(1_400_000) }], "at most 4 MB");
});

/** ─── PNGs made by hand, to break the rules ────────────────────────────── */

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  let c = 0xffffffff;
  for (const byte of out.subarray(4, 8 + body.length)) {
    c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  view.setUint32(8 + body.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function ihdr(
  w: number,
  h: number,
  depth = 8,
  colorType = 6,
  interlace = 0,
): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  body[8] = depth;
  body[9] = colorType;
  body[12] = interlace;
  return chunk("IHDR", body);
}

/** Signature, the chunks given, IEND. */
function png(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * zlib of `mb` megabytes of zeros, compressed a megabyte at a time so the
 * test never holds the zeros themselves — about 1 KB of output per MB.
 */
async function zlibOfZeros(mb: number): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const zeros = new Uint8Array(1 << 20);
  const fed = (async () => {
    for (let i = 0; i < mb; i++) await writer.write(zeros);
    await writer.close();
  })();
  const parts: Uint8Array[] = [];
  for await (const part of stream.readable) parts.push(part);
  await fed;
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

Deno.test("an IHDR over the side limit is refused before anything inflates it", async () => {
  // A valid signature and header, and then no pixel data at all: decodePng
  // would try to allocate 3.6 GB for it, so the only way this test passes
  // with the side message is if the header was read off the bytes first.
  // Either side alone is enough — a 100x30000 strip is as much a bomb.
  for (const [w, h] of [[30000, 30000], [100, 30000], [30000, 100]]) {
    const err = await assertRejects(
      () => decodeUploads([{ png: encodeBase64(png(ihdr(w, h))) }]),
      UploadError,
    );
    assertStringIncludes(err.message, `${w}×${h}`);
    assertStringIncludes(err.message, `at most ${MAX_UPLOAD_SIDE} px`);
  }
});

Deno.test("pictures are held to the 2000 px the Messages API allows once a request has over 20 images", () => {
  // Every turn resends the pictures and every dry run adds a body and a shot
  // PNG, so a long ask passes 20 images on its own; one picture over 2000 px
  // on a side then fails the whole ask with a 400.
  assert(MAX_UPLOAD_SIDE <= 2000, `${MAX_UPLOAD_SIDE}`);
});

Deno.test("a second IHDR is refused, by the check and by decodePng itself", async () => {
  // 1x1 first, to pass the side check; 8192x8192 next, which decodePng used
  // to honour — a 268 MB raster out of an 8 KB file.
  const idat = chunk("IDAT", await deflate(new Uint8Array(5)));
  const bytes = png(ihdr(1, 1), ihdr(8192, 8192, 1, 0), idat);
  assertStringIncludes(
    assertThrows(
      () => checkUploads([{ png: encodeBase64(bytes) }]),
      UploadError,
    ).message,
    "more than one IHDR",
  );
  await assertRejects(() => decodePng(bytes), Error, "more than one IHDR");
});

Deno.test("decodePng holds a header to maxSide, and every caller without limits is unchanged", async () => {
  const r = field(30, 20, WHITE);
  fill(r, 5, 5, 10, 10, BLACK);
  const bytes = await encodePng(r);
  await assertRejects(
    () => decodePng(bytes, { maxSide: 25 }),
    Error,
    "30×20 is over the 25 px limit",
  );
  const exact = 20 * (30 * 4 + 1);
  for (const limits of [undefined, { maxSide: 30, maxInflated: exact }]) {
    const back = await decodePng(bytes, limits);
    assertEquals(Array.from(back.data), Array.from(r.data));
  }
  await assertRejects(
    () => decodePng(bytes, { maxInflated: exact - 1 }),
    Error,
    "longer than the declared image",
  );
});

Deno.test("an IDAT that inflates past what its IHDR declares is refused without inflating the rest", async () => {
  // 16x16 RGBA is 1040 bytes of pixel data. The IDAT is 32 MB of zeros,
  // compressed, with its closing checksum broken: an inflater that reads it
  // through ends in a corrupt-stream error, so the only way to get "longer
  // than the declared image" is to stop a few kilobytes in, as soon as the
  // output passes 1040 bytes — not after making 32 MB of it.
  const zeros = await zlibOfZeros(32);
  const body = zeros.slice();
  body[body.length - 1] ^= 0xff;
  const bytes = png(ihdr(16, 16), chunk("IDAT", body));
  await assertRejects(
    () => decodePng(bytes, { maxInflated: 16 * (16 * 4 + 1) }),
    Error,
    "longer than the declared image",
  );

  // And the whole 32 MB, well formed, through the request path: 32 KB of
  // PNG that is refused rather than inflated.
  const bomb = png(ihdr(16, 16), chunk("IDAT", zeros));
  assert(bomb.length < 40_000, `${bomb.length}`);
  const err = await assertRejects(
    () => decodeUploads([{ png: encodeBase64(bomb) }]),
    UploadError,
  );
  assertStringIncludes(err.message, "longer than the declared image");
});

Deno.test("checkUploads reads headers and never inflates", async () => {
  // Pixel data that is not zlib at all: anything that inflated it would
  // throw. checkUploads answers at once (synchronously), and only opening
  // the picture finds the damage.
  const bytes = png(ihdr(16, 12), chunk("IDAT", new Uint8Array(64).fill(7)));
  const checked = checkUploads([{ name: "x.png", png: encodeBase64(bytes) }]);
  assert(Array.isArray(checked));
  assertEquals(
    checked.map(({ index, name, width, height }) => ({
      index,
      name,
      width,
      height,
    })),
    [{ index: 0, name: "x", width: 16, height: 12 }],
  );
  assertStringIncludes(
    (await assertRejects(() => openUploads(checked), UploadError)).message,
    "Picture 0 could not be read as a PNG",
  );
  assertEquals(checkUploads(undefined), []);

  // A depth its colour type does not allow is refused off the header too:
  // greyscale at "depth 255" claims 32 bytes a pixel.
  const deep = png(ihdr(64, 64, 255, 0), chunk("IDAT", new Uint8Array(8)));
  assertStringIncludes(
    assertThrows(
      () => checkUploads([{ png: encodeBase64(deep) }]),
      UploadError,
    ).message,
    "bit depth 255 is not one colour type 0 allows",
  );
  // And so is interlacing, which decodePng cannot read.
  const laced = png(ihdr(16, 12, 8, 6, 1), chunk("IDAT", new Uint8Array(8)));
  assertStringIncludes(
    assertThrows(
      () => checkUploads([{ png: encodeBase64(laced) }]),
      UploadError,
    ).message,
    "interlaced",
  );
});

/** ─── the picture this was built for ─────────────────────────────────────── */

const FIXTURE = Deno.env.get("UPLOAD_FIXTURE");

Deno.test({
  name: "the motivating picture: a smoothed x12 fighter and ASCII art",
  ignore: !FIXTURE,
  async fn() {
    const bytes = await Deno.readFile(FIXTURE!);
    const [up] = await decodeUploads([{
      name: "ryuda",
      png: encodeBase64(bytes),
    }]);
    const { background, regions } = up.analysis;
    assertEquals(background?.hex, "#ffffff");
    assertEquals(regions.length, 2);
    const [fighter, ascii] = regions;

    assert(fighter.x <= 2 && Math.abs(fighter.x + fighter.w - 684) <= 3);
    assert(Math.abs(fighter.pixelScale - 12) <= 0.5, `${fighter.pixelScale}`);
    assertEquals(fighter.kind, "pixel-art");
    assert(Math.abs(ascii.x - 705) <= 3 && ascii.x + ascii.w >= 1396);
    assertEquals(ascii.kind, "monochrome");
    assertEquals(ascii.darkOnLight, true);
    assertEquals(ascii.pixelScale, 1);

    // The contract's budget for one region's detection is 300 ms.
    const started = performance.now();
    detectPixelScale(cut(up.raster, fighter));
    detectPixelScale(cut(up.raster, ascii));
    const took = (performance.now() - started) / 2;
    assert(took < 300, `detectPixelScale took ${took.toFixed(0)} ms`);

    const body = cutUpload([up], { upload: 0, region: 0 });
    assertEquals(
      [body.raster.width, body.raster.height],
      [fighter.native.w, fighter.native.h],
    );
    assert(body.raster.width >= 55 && body.raster.width <= 60);
    assertEquals(px(body.raster, 0, 0)[3], 0, "the white field is gone");

    const shot = cutUpload([up], {
      upload: 0,
      region: 1,
      ink: "#ffffff",
      maxSize: 48,
    });
    assertEquals(Math.max(shot.raster.width, shot.raster.height), 48);
    let most = 0;
    for (let i = 0; i < shot.raster.data.length; i += 4) {
      if (!shot.raster.data[i + 3]) continue;
      assertEquals(Array.from(shot.raster.data.subarray(i, i + 3)), [
        255,
        255,
        255,
      ]);
      most = Math.max(most, shot.raster.data[i + 3]);
    }
    assertEquals(most, 255);

    const told = describeUploads([up]).split("\n");
    assertEquals(told.length, 3);
    assertStringIncludes(told[1], "pixel art at ×");
    assertStringIncludes(told[2], "monochrome, dark on light");
  },
});
