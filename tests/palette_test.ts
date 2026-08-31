// Quantising sheets to 256 colours, and writing them as indexed PNGs.
//
// The PS2 reason for all of this is VRAM: the GS has 4 MB, the framebuffer
// takes 2.19 MB of it, and the export's sheets are 2.51 MB as RGBA. As
// GS_PSM_T8 they are 0.63 MB and the working set fits. See lib/ps2/palette.ts.

import { assert, assertEquals } from "@std/assert";
import { quantize } from "../lib/ps2/palette.ts";
import { decodePng, encodeIndexedPng, newRaster } from "../lib/ps2/png.ts";

function raster(width: number, height: number, fill: (i: number) => number[]) {
  const r = newRaster(width, height);
  for (let i = 0; i < width * height; i++) r.data.set(fill(i), i * 4);
  return r;
}

Deno.test("a sheet that already fits 256 colours is reproduced exactly", () => {
  // 200 distinct opaque colours plus transparency.
  const r = raster(
    16,
    16,
    (i) => i < 56 ? [0, 0, 0, 0] : [i, 255 - i, (i * 7) & 0xff, 255],
  );
  const q = quantize(r);
  assert(q.exact, "should not have needed to quantise");
  assertEquals(q.meanError, 0);
  for (let i = 0; i < 256; i++) {
    const p = q.indices[i] * 4;
    for (let c = 0; c < 4; c++) {
      assertEquals(q.palette.colors[p + c], r.data[i * 4 + c], `pixel ${i}`);
    }
  }
});

Deno.test("a sheet with more colours than entries still lands close", () => {
  // ~4000 distinct colours.
  const r = raster(
    64,
    64,
    (i) => [i & 0xff, (i >> 2) & 0xff, (i >> 4) & 0xff, 255],
  );
  const q = quantize(r);
  assert(!q.exact);
  assert(q.palette.count <= 256, `${q.palette.count} entries`);
  assert(q.meanError < 12, `mean error ${q.meanError} is too high`);
});

Deno.test("every non-opaque entry precedes every opaque one", () => {
  // This is the whole reason the palette is ordered at all: AthenaEnv sets
  // palette alpha to PS2-opaque 0x80 by default and overwrites the first
  // `num_trans` entries with `tRNS[i] >> 1`. An opaque 255 inside that run
  // would come back as 127 and make solid pixels faintly transparent.
  const r = raster(
    32,
    32,
    (i) =>
      i % 3 === 0
        ? [0, 0, 0, 0]
        : i % 3 === 1
        ? [200, 10, 10, 128]
        : [10, 200, 10, 255],
  );
  const q = quantize(r);
  const { colors, count, transparentCount } = q.palette;
  for (let i = 0; i < count; i++) {
    const alpha = colors[i * 4 + 3];
    if (i < transparentCount) assert(alpha < 255, `entry ${i} is opaque`);
    else assertEquals(alpha, 255, `entry ${i} should be opaque`);
  }
  // Fully transparent pixels get the reserved leading entry.
  assertEquals(q.indices[0], 0);
  assertEquals([...colors.subarray(0, 4)], [0, 0, 0, 0]);
});

Deno.test("an indexed PNG round-trips to the quantised pixels", async () => {
  const r = raster(
    24,
    8,
    (i) => i % 5 === 0 ? [0, 0, 0, 0] : [(i * 11) & 0xff, 64, 200, 255],
  );
  const q = quantize(r);
  const png = await encodeIndexedPng(q);

  assertEquals([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(png.buffer, png.byteOffset);
  assertEquals(view.getUint32(16), 24);
  assertEquals(view.getUint32(20), 8);
  assertEquals(png[24], 8, "bit depth");
  assertEquals(png[25], 3, "colour type: indexed");

  const back = await decodePng(png);
  assertEquals(back.width, 24);
  assertEquals(back.height, 8);
  for (let i = 0; i < 24 * 8; i++) {
    const p = q.indices[i] * 4;
    for (let c = 0; c < 4; c++) {
      assertEquals(back.data[i * 4 + c], q.palette.colors[p + c], `px ${i}`);
    }
  }
});

Deno.test("tRNS is exactly as long as the non-opaque run", async () => {
  const r = raster(8, 8, (i) => (i < 32 ? [0, 0, 0, 0] : [5, 6, 7, 255]));
  const q = quantize(r);
  const png = await encodeIndexedPng(q);

  let trns: Uint8Array | null = null;
  let plte = 0;
  let at = 8;
  while (at < png.length) {
    const len = new DataView(png.buffer, png.byteOffset).getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "tRNS") trns = png.subarray(at + 8, at + 8 + len);
    if (type === "PLTE") plte = len;
    at += 12 + len;
  }
  assert(trns, "no tRNS chunk");
  assertEquals(trns.length, q.palette.transparentCount);
  assertEquals(plte, q.palette.count * 3);
  for (const alpha of trns) assert(alpha < 255, "an opaque entry is in tRNS");
});
