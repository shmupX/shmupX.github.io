// Item emblems for the cart writer, cut out of the animated powerup GIFs.
//
// A Dezaemon 2 save gives each of its eight item slots exactly one 16x16 cell
// (global sprite bank refs 94-101, FORMAT.md "Global sprite composition
// bank"), so a pickup in an exported cart is a still — there is nowhere to put
// a second frame. Without art the writer draws a coloured square
// (`itemIcon()` in game-to-save.js); with a set of powerup GIFs beside it, it
// draws the real emblem instead.
//
// The GIFs are winged letter emblems, four frames each: two of the wings
// spread and two folded, with the letter cycling colour. They are stored at
// 2x, so the art is really 26x15, and the FOLDED pose is 14x15 — which drops
// into a 16x16 cell at native resolution with a pixel to spare. That is the
// frame this cuts, so nothing is ever resampled: the spread pose is 26 wide
// and could only reach 16 by throwing pixels away.
//
// The art is not in the repo. `loadItemEmblems()` returns null when the
// directory is absent, and every caller then falls back to the squares, the
// same way the engine's fixture-gated tests degrade.

import { decodeGifFrames, isGif } from "./ps2/gif.ts";

/** An RGBA frame in the shape the engine's writer takes. */
export interface EmblemFrame {
  w: number;
  h: number;
  rgba: Uint8Array;
}

/** Where the GIFs live, relative to the repo root. Gitignored. */
export const EMBLEM_DIR = "dev-fixtures/powerups";

/** The cell an item icon occupies in the cart. */
export const EMBLEM_CELL = 16;

/**
 * Which emblem each item type wears.
 *
 * Item types are 0-3 weapon change, 4 barrier, 5 bomb, 6 score, 7 power,
 * 8 speed (`itemIcon()`), and the letters read S=speed, B=barrier,
 * F=firepower, R=rapid — so R covers all four weapon-change slots. Bomb and
 * score have no letter and keep their coloured squares.
 */
export const EMBLEM_BY_TYPE: Readonly<Record<number, string>> = Object.freeze({
  0: "r",
  1: "r",
  2: "r",
  3: "r",
  4: "b",
  7: "f",
  8: "s",
});

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function opaqueBounds(
  data: Uint8Array,
  width: number,
  height: number,
): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * The integer factor the image is blown up by: the largest n in 1..4 for
 * which every n-by-n block of pixels is one colour. Measured rather than
 * assumed, so art saved at 1x still cuts correctly.
 */
export function pixelScale(
  data: Uint8Array,
  width: number,
  height: number,
  box: Box,
): number {
  if (
    box.x0 < 0 || box.y0 < 0 || box.x1 >= width || box.y1 >= height ||
    box.x1 < box.x0 || box.y1 < box.y0
  ) {
    throw new Error("powerup emblem: bounding box is outside the image");
  }
  const at = (x: number, y: number): number => {
    const d = (y * width + x) * 4;
    return data[d + 3]
      ? (data[d] << 16) | (data[d + 1] << 8) | data[d + 2]
      : -1;
  };
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  for (let n = 4; n >= 2; n--) {
    if (bw % n || bh % n) continue;
    let uniform = true;
    for (let y = box.y0; y <= box.y1 && uniform; y += n) {
      for (let x = box.x0; x <= box.x1 && uniform; x += n) {
        const c = at(x, y);
        for (let dy = 0; dy < n && uniform; dy++) {
          for (let dx = 0; dx < n; dx++) {
            if (at(x + dx, y + dy) !== c) {
              uniform = false;
              break;
            }
          }
        }
      }
    }
    if (uniform) return n;
  }
  return 1;
}

/**
 * One 16x16 RGBA emblem out of a powerup GIF: the narrowest frame — the
 * folded pose — at native resolution, centred in the cell.
 *
 * Throws when the art cannot fit 16x16 at native scale rather than
 * resampling it, because a letter this small does not survive resampling.
 */
export function emblemFromGif(bytes: Uint8Array): EmblemFrame {
  if (!isGif(bytes)) throw new Error("powerup emblem: not a GIF");
  const { width, height, frames } = decodeGifFrames(bytes);
  if (!frames.length) throw new Error("powerup emblem: GIF has no frames");

  let best: { data: Uint8Array; box: Box; scale: number } | null = null;
  for (const frame of frames) {
    const box = opaqueBounds(frame.raster.data, width, height);
    if (!box) continue;
    const scale = pixelScale(frame.raster.data, width, height, box);
    const w = (box.x1 - box.x0 + 1) / scale;
    const h = (box.y1 - box.y0 + 1) / scale;
    if (w > EMBLEM_CELL || h > EMBLEM_CELL) continue;
    const area = w * h;
    if (!best) {
      best = { data: frame.raster.data, box, scale };
      continue;
    }
    const bw = (best.box.x1 - best.box.x0 + 1) / best.scale;
    const bh = (best.box.y1 - best.box.y0 + 1) / best.scale;
    // The widest pose that still fits shows the most of the emblem.
    if (area > bw * bh) best = { data: frame.raster.data, box, scale };
  }
  if (!best) {
    throw new Error(
      `powerup emblem: no frame fits ${EMBLEM_CELL}x${EMBLEM_CELL} at native scale`,
    );
  }

  const { data, box, scale } = best;
  const nw = (box.x1 - box.x0 + 1) / scale;
  const nh = (box.y1 - box.y0 + 1) / scale;
  const rgba = new Uint8Array(EMBLEM_CELL * EMBLEM_CELL * 4);
  const ox = Math.floor((EMBLEM_CELL - nw) / 2);
  const oy = Math.floor((EMBLEM_CELL - nh) / 2);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const s = ((box.y0 + y * scale) * width + box.x0 + x * scale) * 4;
      if (!data[s + 3]) continue;
      const d = ((oy + y) * EMBLEM_CELL + ox + x) * 4;
      rgba[d] = data[s];
      rgba[d + 1] = data[s + 1];
      rgba[d + 2] = data[s + 2];
      rgba[d + 3] = 255;
    }
  }
  return { w: EMBLEM_CELL, h: EMBLEM_CELL, rgba };
}

/**
 * The emblem for every item type that has one, keyed by type, ready for the
 * writer's `itemEmblems` option — or null when the directory holds none, in
 * which case the writer draws its coloured squares.
 *
 * A GIF that fails to decode is reported through `onWarn` and skipped; one
 * bad file does not cost the others their art.
 */
export async function loadItemEmblems(
  dir: string,
  onWarn: (message: string) => void = () => {},
): Promise<Record<number, EmblemFrame> | null> {
  const cache = new Map<string, EmblemFrame>();
  const out: Record<number, EmblemFrame> = {};
  for (const [type, letter] of Object.entries(EMBLEM_BY_TYPE)) {
    let frame = cache.get(letter);
    if (!frame) {
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(`${dir}/powerup-${letter}.gif`);
      } catch {
        continue; // no art for this letter; the square stands
      }
      try {
        frame = emblemFromGif(bytes);
      } catch (e) {
        onWarn(`powerup-${letter}.gif: ${(e as Error).message}`);
        continue;
      }
      cache.set(letter, frame);
    }
    out[Number(type)] = frame;
  }
  return Object.keys(out).length ? out : null;
}
