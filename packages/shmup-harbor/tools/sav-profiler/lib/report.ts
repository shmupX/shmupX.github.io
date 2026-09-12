// The profiler's output: frame pairs the eye can compare, and the numbers
// behind them.
//
// Every captured instant becomes one row — the Saturn's frame on the left,
// the runtime's on the right, both brought to the same height — and the rows
// are stacked into a contact sheet. The runtime's per-tick samples (every
// enemy's position, scale and alpha) go out as JSON beside it, so a claim
// like "the rock came in at ×3 and 45% alpha" can be checked without a
// frame at all.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "../../../lib/ps2/png.ts";
import { blit } from "../../../lib/ps2/raster.ts";
import type { Sample } from "./web.ts";

export async function loadRaster(path: string): Promise<Raster> {
  return await decodePng(await Deno.readFile(path));
}

/** Nearest-neighbour resize: pixel art stays pixel art. */
export function resizeNearest(
  src: Raster,
  width: number,
  height: number,
): Raster {
  const out = newRaster(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

export function fitHeight(src: Raster, height: number): Raster {
  const width = Math.max(1, Math.round(src.width * height / src.height));
  return resizeNearest(src, width, height);
}

function fill(r: Raster, rgb: [number, number, number]): void {
  for (let i = 0; i < r.data.length; i += 4) {
    r.data[i] = rgb[0];
    r.data[i + 1] = rgb[1];
    r.data[i + 2] = rgb[2];
    r.data[i + 3] = 255;
  }
}

/** Left and right, same height, a gap between. */
export function pair(
  left: Raster,
  right: Raster,
  height: number,
  gap = 8,
): Raster {
  const l = fitHeight(left, height);
  const r = fitHeight(right, height);
  const out = newRaster(l.width + gap + r.width, height);
  fill(out, [24, 24, 24]);
  blit(out, l, 0, 0);
  blit(out, r, l.width + gap, 0);
  return out;
}

/** Rows stacked, with a gutter. */
export function stack(rows: Raster[], gap = 6): Raster {
  const width = Math.max(...rows.map((r) => r.width));
  const height = rows.reduce((a, r) => a + r.height, 0) +
    gap * Math.max(0, rows.length - 1);
  const out = newRaster(width, height);
  fill(out, [24, 24, 24]);
  let y = 0;
  for (const r of rows) {
    blit(out, r, 0, y);
    y += r.height + gap;
  }
  return out;
}

/** Rows laid out in a grid of `cols`. */
export function grid(cells: Raster[], cols: number, gap = 6): Raster {
  const rows: Raster[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const slice = cells.slice(i, i + cols);
    const width = slice.reduce((a, r) => a + r.width, 0) +
      gap * (slice.length - 1);
    const height = Math.max(...slice.map((r) => r.height));
    const row = newRaster(width, height);
    fill(row, [24, 24, 24]);
    let x = 0;
    for (const c of slice) {
      blit(row, c, x, 0);
      x += c.width + gap;
    }
    rows.push(row);
  }
  return stack(rows, gap);
}

export async function writePng(path: string, r: Raster): Promise<void> {
  await ensureDir(join(path, ".."));
  await Deno.writeFile(path, await encodePng(r));
}

export interface TimedFrame {
  file: string;
  /** Seconds since the level start (the Start press). */
  t: number;
}

/** The frame whose time is nearest `t`. */
export function nearest(frames: TimedFrame[], t: number): TimedFrame | null {
  let best: TimedFrame | null = null;
  for (const f of frames) {
    if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  }
  return best;
}

export interface ScaledSighting {
  t: number;
  name: string;
  sx: number;
  sy: number;
  alpha: number;
  x: number;
  y: number;
  /** The shadow drawn under it at that instant, if any. */
  shadow: { dx: number; dy: number; sx: number; alpha: number } | null;
}

/**
 * Every enemy the runtime drew off unity scale or under full alpha inside
 * the window, and the single strongest sighting: the frame to look at.
 */
export function scaledEnemies(
  samples: Sample[],
  t0: number,
  from: number,
  len: number,
): { sightings: ScaledSighting[]; strongest: ScaledSighting | null } {
  const sightings: ScaledSighting[] = [];
  let strongest: ScaledSighting | null = null;
  let strength = 0;
  for (const s of samples) {
    const t = (s.t - t0) / 1000;
    if (t < from || t > from + len) continue;
    for (const e of s.enemies) {
      const off = Math.max(Math.abs(e.sx - 1), Math.abs(e.sy - 1));
      if (off < 0.01 && e.alpha >= 0.999) continue;
      const sighting = {
        t,
        name: e.name,
        sx: e.sx,
        sy: e.sy,
        alpha: e.alpha,
        x: e.x,
        y: e.y,
        shadow: e.shadow ?? null,
      };
      sightings.push(sighting);
      const k = off + (1 - e.alpha);
      if (k > strength) {
        strength = k;
        strongest = sighting;
      }
    }
  }
  return { sightings, strongest };
}

export function summarizeSightings(
  sightings: ScaledSighting[],
): {
  name: string;
  first: number;
  last: number;
  scaleMin: number;
  scaleMax: number;
  alphaMin: number;
  samples: number;
  shadowOffsetMin: number | null;
  shadowOffsetMax: number | null;
  shadowAlpha: number | null;
}[] {
  const by = new Map<
    string,
    {
      name: string;
      first: number;
      last: number;
      scaleMin: number;
      scaleMax: number;
      alphaMin: number;
      samples: number;
      /** Shadow offset range (px) and its alpha, when a shadow was drawn. */
      shadowOffsetMin: number | null;
      shadowOffsetMax: number | null;
      shadowAlpha: number | null;
    }
  >();
  for (const s of sightings) {
    const cur = by.get(s.name) ??
      {
        name: s.name,
        first: s.t,
        last: s.t,
        scaleMin: s.sx,
        scaleMax: s.sx,
        alphaMin: s.alpha,
        samples: 0,
        shadowOffsetMin: null,
        shadowOffsetMax: null,
        shadowAlpha: null,
      };
    cur.first = Math.min(cur.first, s.t);
    cur.last = Math.max(cur.last, s.t);
    cur.scaleMin = Math.min(cur.scaleMin, s.sx, s.sy);
    cur.scaleMax = Math.max(cur.scaleMax, s.sx, s.sy);
    cur.alphaMin = Math.min(cur.alphaMin, s.alpha);
    cur.samples++;
    if (s.shadow) {
      const off = Math.round(Math.hypot(s.shadow.dx, s.shadow.dy) * 10) / 10;
      cur.shadowOffsetMin = cur.shadowOffsetMin === null
        ? off
        : Math.min(cur.shadowOffsetMin, off);
      cur.shadowOffsetMax = cur.shadowOffsetMax === null
        ? off
        : Math.max(cur.shadowOffsetMax, off);
      cur.shadowAlpha = s.shadow.alpha;
    }
    by.set(s.name, cur);
  }
  return [...by.values()].sort((a, b) => a.first - b.first);
}
