// Cutting an RGBA raster down to 256 colours, for the PS2's paletted textures.
//
// WHY. The GS has 4 MB of video RAM and the framebuffer already wants half of
// it (640x448, double-buffered, 32-bit = 2.19 MB). The export's three atlases
// at 32 bits per pixel come to 2.51 MB on top of that, so the working set does
// not fit and AthenaEnv's texture manager — which owns the whole 4 MB as one
// block pool — has to evict and re-upload sheets over DMA. As 8-bit indexed
// textures (GS_PSM_T8) the same atlases are a quarter of the size, 0.63 MB,
// and everything stays resident.
//
// AthenaEnv reads a plain indexed PNG and does the PS2-specific work itself:
// it builds the CLUT, and it applies the CSM1 "rotate clut" swizzle that
// swaps entries 8..15 with 16..23 in each block of 32 (src/image_loaders.c).
// So this writes an ordinary PLTE/tRNS palette and nothing PS2-shaped.
//
// ONE SHARP EDGE. That loader defaults every palette entry's alpha to 0x80 —
// PS2 "fully opaque", since the GS's alpha range is 0..128 — and then
// overwrites the first `num_trans` entries with `tRNS[i] >> 1`. An opaque
// entry covered by tRNS would come back as 255>>1 = 127, one short of opaque,
// which turns every solid sprite pixel very slightly transparent. So the
// palette is ordered with every non-opaque colour FIRST and tRNS is written
// only that long, leaving the opaque entries on the 0x80 default.

import type { Raster } from "./png.ts";

export interface Palette {
  /** `count` RGBA entries, every non-opaque one before every opaque one. */
  colors: Uint8Array;
  count: number;
  /** Leading entries with alpha < 255 — exactly the tRNS run length. */
  transparentCount: number;
}

export interface Indexed {
  width: number;
  height: number;
  /** One palette index per pixel. */
  indices: Uint8Array;
  palette: Palette;
}

export interface QuantizeResult extends Indexed {
  /** Distinct RGBA values in the source. */
  sourceColors: number;
  /** True when the palette reproduces the source exactly. */
  exact: boolean;
  /** Mean per-channel error across the image, 0..255. */
  meanError: number;
}

interface Box {
  /** Indexes into the unique-colour table. */
  members: number[];
  population: number;
}

const key = (r: number, g: number, b: number, a: number) =>
  ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

/**
 * Median cut over RGBA.
 *
 * Fully transparent pixels are pulled out first and given one reserved entry:
 * their RGB is meaningless (it is whatever the source happened to store under
 * a zero alpha) and letting it into the averages drags every nearby colour
 * toward it. Sprite sheets are mostly transparent, so this matters.
 */
export function quantize(raster: Raster, maxColors = 256): QuantizeResult {
  const { width, height, data } = raster;
  const pixels = width * height;

  // Histogram. Sprite art repeats colours heavily, so this collapses hard.
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const a = data[o + 3];
    // Every fully transparent pixel is the same colour as far as the GS is
    // concerned; normalising the RGB keeps them in one histogram bucket.
    const k = a === 0 ? 0 : key(data[o], data[o + 1], data[o + 2], a);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const hasTransparent = counts.has(0);
  counts.delete(0);

  const unique: number[] = [...counts.keys()];
  const sourceColors = unique.length + (hasTransparent ? 1 : 0);
  const budget = maxColors - (hasTransparent ? 1 : 0);

  const chan = (k: number, c: number) => (k >>> (24 - c * 8)) & 0xff;

  let reps: number[][];
  if (unique.length <= budget) {
    reps = unique.map((k) => [chan(k, 0), chan(k, 1), chan(k, 2), chan(k, 3)]);
  } else {
    let boxes: Box[] = [{
      members: unique,
      population: [...counts.values()].reduce((n, v) => n + v, 0),
    }];
    while (boxes.length < budget) {
      // Split whichever box spans the most colour, weighted by how many
      // pixels sit in it — a wide box nobody looks at is not worth an entry.
      let pick = -1;
      let pickScore = 0;
      let pickAxis = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.members.length < 2) continue;
        for (let c = 0; c < 4; c++) {
          let lo = 255;
          let hi = 0;
          for (const k of box.members) {
            const v = chan(k, c);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const score = (hi - lo) * Math.log2(box.population + 1);
          if (score > pickScore) {
            pickScore = score;
            pick = i;
            pickAxis = c;
          }
        }
      }
      if (pick < 0) break;

      const box = boxes[pick];
      const sorted = [...box.members].sort((x, y) =>
        chan(x, pickAxis) - chan(y, pickAxis)
      );
      // Split at the population median, not the midpoint of the list, so a
      // box holding one dominant colour and a long tail divides sensibly.
      const half = box.population / 2;
      let running = 0;
      let cut = 1;
      for (let i = 0; i < sorted.length - 1; i++) {
        running += counts.get(sorted[i]) ?? 0;
        cut = i + 1;
        if (running >= half) break;
      }
      const left = sorted.slice(0, cut);
      const right = sorted.slice(cut);
      const pop = (list: number[]) =>
        list.reduce((n, k) => n + (counts.get(k) ?? 0), 0);
      boxes = [
        ...boxes.slice(0, pick),
        { members: left, population: pop(left) },
        { members: right, population: pop(right) },
        ...boxes.slice(pick + 1),
      ];
    }

    reps = boxes.map((box) => {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (const k of box.members) {
        const w = counts.get(k) ?? 0;
        r += chan(k, 0) * w;
        g += chan(k, 1) * w;
        b += chan(k, 2) * w;
        a += chan(k, 3) * w;
        n += w;
      }
      if (n === 0) return [0, 0, 0, 255];
      return [
        Math.round(r / n),
        Math.round(g / n),
        Math.round(b / n),
        Math.round(a / n),
      ];
    });
  }

  // Non-opaque first, so tRNS covers exactly them. The reserved fully
  // transparent entry leads.
  const nonOpaque = reps.filter((c) => c[3] < 255);
  const opaque = reps.filter((c) => c[3] === 255);
  const ordered = hasTransparent
    ? [[0, 0, 0, 0], ...nonOpaque, ...opaque]
    : [...nonOpaque, ...opaque];

  const count = Math.min(ordered.length, maxColors);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) colors.set(ordered[i], i * 4);
  const transparentCount = ordered.slice(0, count)
    .findIndex((c) => c[3] === 255);
  const trns = transparentCount === -1 ? count : transparentCount;

  // Map every source colour once, then paint by lookup.
  const nearest = new Map<number, number>();
  const lookup = (r: number, g: number, b: number, a: number): number => {
    if (a === 0 && hasTransparent) return 0;
    const k = key(r, g, b, a);
    const hit = nearest.get(k);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = hasTransparent ? 1 : 0; i < count; i++) {
      const o = i * 4;
      const dr = r - colors[o];
      const dg = g - colors[o + 1];
      const db = b - colors[o + 2];
      const da = a - colors[o + 3];
      // Alpha is weighted heavily: a colour landing in the wrong opacity
      // bucket shows up as a halo, which reads far worse than a hue shift.
      const d = dr * dr + dg * dg + db * db + da * da * 4;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    nearest.set(k, best);
    return best;
  };

  const indices = new Uint8Array(pixels);
  let error = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const index = lookup(data[o], data[o + 1], data[o + 2], data[o + 3]);
    indices[i] = index;
    const p = index * 4;
    error += Math.abs(data[o] - colors[p]) +
      Math.abs(data[o + 1] - colors[p + 1]) +
      Math.abs(data[o + 2] - colors[p + 2]) +
      Math.abs(data[o + 3] - colors[p + 3]);
  }

  return {
    width,
    height,
    indices,
    palette: { colors, count, transparentCount: trns },
    sourceColors,
    exact: sourceColors <= maxColors,
    meanError: pixels === 0 ? 0 : error / (pixels * 4),
  };
}
