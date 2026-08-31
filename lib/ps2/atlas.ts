// Turn the editor's texture atlases into ones a PlayStation 2 can actually
// sample.
//
// The web atlases are 2048px sheets; the Graphics Synthesizer tops out at
// 1024x1024 and has 4MB of VRAM to hold the frame buffers as well, so the PS2
// port's convention (established by its own game_asset.json) is a small sheet
// plus a `meta.ps2DisplayScale` that tells the runtime how far to scale each
// frame back up when drawing. This repacks rather than merely shrinking the
// sheet: every frame is cut out, padded to a multiple of the scale factor so
// the downscale lands on exact texel boundaries, reduced, and shelf-packed
// into the smallest power-of-two sheet that holds the set.

import { type Raster } from "./png.ts";
import { blit, cut, downscale, type Rect, rotateCcw } from "./raster.ts";

/** One entry of a TexturePacker JSON-hash `frames` map. */
export interface FrameEntry {
  frame: Rect;
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: Rect;
  sourceSize?: { w: number; h: number };
}

export interface AtlasJson {
  frames: Record<string, FrameEntry>;
  meta: {
    image: string;
    format: "RGBA8888";
    size: { w: number; h: number };
    scale: string;
    ps2DisplayScale: number;
  };
}

/** A frame to include, named, with the sheet it is cut from. */
export interface SourceFrame {
  name: string;
  sheet: Raster;
  entry: FrameEntry;
  /**
   * Turn this frame a quarter turn anticlockwise as it is packed, so art drawn
   * pointing right ends up pointing up the screen. See rotateCcw().
   */
  rotate?: boolean;
}

export interface BuiltAtlas {
  image: Raster;
  json: AtlasJson;
  displayScale: number;
}

// Powers of two only: a box downscale by a non-power-of-two would not compose
// with the padding step, and the runtime multiplies every frame by this one
// number, so it has to be uniform across the sheet.
const SCALE_STEPS = [1, 2, 4, 8, 16];
const SHEET_STEPS = [64, 128, 256, 512, 1024];

// One transparent texel around every frame. The native runtime draws with
// bilinear filtering, which samples just past a frame's edge; without a gutter
// that reads the neighbouring sprite.
const GUTTER = 1;

interface Placement {
  name: string;
  w: number;
  h: number;
  x: number;
  y: number;
}

// Shelf packer: tallest first, filling rows left to right. Returns null when
// the set does not fit the given sheet.
function shelfPack(
  sizes: { name: string; w: number; h: number }[],
  sheetW: number,
  sheetH: number,
): Placement[] | null {
  const sorted = sizes.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const out: Placement[] = [];
  let x = GUTTER;
  let y = GUTTER;
  let rowH = 0;
  for (const item of sorted) {
    if (item.w + GUTTER * 2 > sheetW) return null;
    if (x + item.w + GUTTER > sheetW) {
      y += rowH + GUTTER;
      x = GUTTER;
      rowH = 0;
    }
    if (y + item.h + GUTTER > sheetH) return null;
    out.push({ name: item.name, w: item.w, h: item.h, x, y });
    x += item.w + GUTTER;
    rowH = Math.max(rowH, item.h);
  }
  return out;
}

// The untrimmed size a frame draws at, which is what the runtime scales by
// ps2DisplayScale. TexturePacker records this in sourceSize; frames without it
// draw at their packed size.
function displaySize(entry: FrameEntry): { w: number; h: number } {
  const source = entry.sourceSize;
  if (source && source.w > 0 && source.h > 0) {
    return { w: source.w, h: source.h };
  }
  return { w: entry.frame.w, h: entry.frame.h };
}

// Cut one frame out of its sheet at full display size, re-inserting the margin
// TexturePacker trimmed away so the sprite keeps its original registration.
function extract(frame: SourceFrame): Raster {
  const size = displaySize(frame.entry);
  const origin = frame.entry.trimmed && frame.entry.spriteSourceSize
    ? frame.entry.spriteSourceSize
    : { x: 0, y: 0 };
  return cut(
    frame.sheet,
    frame.entry.frame,
    size.w,
    size.h,
    origin.x,
    origin.y,
  );
}

/**
 * Repack `frames` into a single PS2-sized sheet.
 *
 * `maxSheet` caps both dimensions of the result (512 by default, matching the
 * PS2 port's own atlases — a 512x512 RGBA texture is 1MB of the console's 4MB
 * of VRAM). The scale factor is the smallest power of two that makes the set
 * fit; `imageName` only lands in the JSON metadata.
 */
export function buildPs2Atlas(
  frames: SourceFrame[],
  imageName: string,
  maxSheet = 512,
): BuiltAtlas {
  if (frames.length === 0) {
    throw new Error(`atlas ${imageName}: no frames to pack`);
  }
  const cutouts = new Map<string, Raster>();
  for (const frame of frames) {
    if (cutouts.has(frame.name)) continue;
    const cutout = extract(frame);
    cutouts.set(frame.name, frame.rotate ? rotateCcw(cutout) : cutout);
  }
  const sheetSteps = SHEET_STEPS.filter((size) => size <= maxSheet);
  if (sheetSteps.length === 0) {
    throw new Error(`atlas ${imageName}: maxSheet ${maxSheet} is below 64`);
  }

  for (const scale of SCALE_STEPS) {
    // Pad each frame out to a multiple of the scale so the box filter reads
    // whole blocks; the padding is symmetric so the sprite stays centred,
    // which is the origin the runtime draws frames around.
    const padded = new Map<string, Raster>();
    const sizes: { name: string; w: number; h: number }[] = [];
    for (const [name, raster] of cutouts) {
      const w = Math.ceil(raster.width / scale) * scale;
      const h = Math.ceil(raster.height / scale) * scale;
      let source = raster;
      if (w !== raster.width || h !== raster.height) {
        source = cut(
          raster,
          { x: 0, y: 0, w: raster.width, h: raster.height },
          w,
          h,
          Math.floor((w - raster.width) / 2),
          Math.floor((h - raster.height) / 2),
        );
      }
      const reduced = downscale(source, scale);
      padded.set(name, reduced);
      sizes.push({ name, w: reduced.width, h: reduced.height });
    }

    let best: { placements: Placement[]; w: number; h: number } | null = null;
    for (const sheetW of sheetSteps) {
      for (const sheetH of sheetSteps) {
        if (best && sheetW * sheetH >= best.w * best.h) continue;
        const placements = shelfPack(sizes, sheetW, sheetH);
        if (placements) best = { placements, w: sheetW, h: sheetH };
      }
    }
    if (!best) continue;

    const image: Raster = {
      width: best.w,
      height: best.h,
      data: new Uint8Array(best.w * best.h * 4),
    };
    const out: Record<string, FrameEntry> = {};
    for (const placement of best.placements) {
      const raster = padded.get(placement.name)!;
      blit(image, raster, placement.x, placement.y);
      out[placement.name] = {
        frame: {
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
        },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: placement.w, h: placement.h },
        sourceSize: { w: placement.w, h: placement.h },
      };
    }
    return {
      image,
      displayScale: scale,
      json: {
        frames: out,
        meta: {
          image: imageName,
          format: "RGBA8888",
          size: { w: best.w, h: best.h },
          scale: "1",
          ps2DisplayScale: scale,
        },
      },
    };
  }

  throw new Error(
    `atlas ${imageName}: ${cutouts.size} frames will not fit ${maxSheet}x${maxSheet} ` +
      `even at 1/${SCALE_STEPS[SCALE_STEPS.length - 1]} scale`,
  );
}
