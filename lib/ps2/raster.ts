// Pixel operations the atlas repacker needs: cut a frame out of a sheet, blit
// one raster into another, and box-downscale by an integer factor.
//
// Everything is 8-bit straight-alpha RGBA. Downscaling averages in premultiplied
// space and un-premultiplies afterwards, so the transparent black that pads a
// sprite sheet cannot darken the halo around a sprite the way a naive average
// would.

import { newRaster, type Raster } from "./png.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Copy `rect` out of `src` into a new raster of size `outW` x `outH`, placing
 * it at (`offsetX`, `offsetY`). Anything outside `src` reads as transparent, so
 * a frame rect that overhangs its sheet yields padding rather than an error.
 */
export function cut(
  src: Raster,
  rect: Rect,
  outW = rect.w,
  outH = rect.h,
  offsetX = 0,
  offsetY = 0,
): Raster {
  const out = newRaster(outW, outH);
  for (let y = 0; y < rect.h; y++) {
    const sy = rect.y + y;
    const dy = offsetY + y;
    if (sy < 0 || sy >= src.height || dy < 0 || dy >= outH) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + x;
      const dx = offsetX + x;
      if (sx < 0 || sx >= src.width || dx < 0 || dx >= outW) continue;
      const s = (sy * src.width + sx) * 4;
      const d = (dy * outW + dx) * 4;
      out.data[d] = src.data[s];
      out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2];
      out.data[d + 3] = src.data[s + 3];
    }
  }
  return out;
}

/** Blit `src` into `dst` with its top-left corner at (`x`, `y`). */
export function blit(dst: Raster, src: Raster, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (sy * src.width + sx) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
}

/**
 * Box-downscale by an exact integer factor. `src` dimensions must already be
 * multiples of `factor` — the atlas builder pads frames to guarantee that, so
 * every output texel averages a full factor x factor block.
 */
export function downscale(src: Raster, factor: number): Raster {
  if (factor <= 1) return src;
  const w = Math.floor(src.width / factor);
  const h = Math.floor(src.height / factor);
  const out = newRaster(w, h);
  const area = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let by = 0; by < factor; by++) {
        const row = (y * factor + by) * src.width;
        for (let bx = 0; bx < factor; bx++) {
          const s = (row + x * factor + bx) * 4;
          const alpha = src.data[s + 3];
          // Premultiply so fully transparent texels contribute no colour.
          r += src.data[s] * alpha;
          g += src.data[s + 1] * alpha;
          b += src.data[s + 2] * alpha;
          a += alpha;
        }
      }
      const d = (y * w + x) * 4;
      if (a === 0) {
        out.data[d] = 0;
        out.data[d + 1] = 0;
        out.data[d + 2] = 0;
        out.data[d + 3] = 0;
      } else {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
        out.data[d + 3] = Math.round(a / area);
      }
    }
  }
  return out;
}

/**
 * Scale `src` to fit inside `boxW` x `boxH` without distorting it, centred, on
 * a transparent field. Used for the fixed-size cells of a grid spritesheet.
 */
export function fitInto(src: Raster, boxW: number, boxH: number): Raster {
  const out = newRaster(boxW, boxH);
  if (src.width === 0 || src.height === 0) return out;
  const scale = Math.min(boxW / src.width, boxH / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const originX = Math.floor((boxW - w) / 2);
  const originY = Math.floor((boxH - h) / 2);
  for (let y = 0; y < h; y++) {
    // Nearest-neighbour: these cells are already small and the source is
    // pixel art, so a box filter here would only smear it.
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) / scale));
      const s = (sy * src.width + sx) * 4;
      const d = ((originY + y) * boxW + originX + x) * 4;
      out.data[d] = src.data[s];
      out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2];
      out.data[d + 3] = src.data[s + 3];
    }
  }
  return out;
}

/**
 * Turn a raster a quarter turn anticlockwise: what pointed right now points up.
 *
 * The PS2 port draws every frame axis-aligned — `AtlasManager.drawFrame` takes
 * no angle and the bullet's `rotation` is only ever used to move it
 * (`x += cos`, `y += sin`) — so a sprite drawn from side-on source art comes
 * out side-on however the shot is travelling. The exporter turns that art at
 * pack time instead, which is what authoring for a renderer without rotation
 * means.
 */
export function rotateCcw(src: Raster): Raster {
  const { width, height, data } = src;
  const out: Raster = {
    width: height,
    height: width,
    data: new Uint8Array(width * height * 4),
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // (x, y) -> (y, width - 1 - x)
      const from = (y * width + x) * 4;
      const to = ((width - 1 - x) * height + y) * 4;
      out.data[to] = data[from];
      out.data[to + 1] = data[from + 1];
      out.data[to + 2] = data[from + 2];
      out.data[to + 3] = data[from + 3];
    }
  }
  return out;
}
