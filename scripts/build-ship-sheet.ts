// scripts/build-ship-sheet.ts — the NEW GAME character roster as a texture
// atlas the level editor's CHOOSE YOUR CHARACTER step can draw from.
//
//   deno task ships:atlas
//
// Source art is dev-fixtures/ship-sheet/ships.png: a 393 x 2000 sheet of a
// couple of hundred top-down ships, painted on flat #404040 with a blurred drop
// shadow under each one. That directory is gitignored, the same arrangement
// as the powerup emblems — static/editor/assets/ships/ships.{png,json} are the
// committed artefacts, and this script is how they were made.
//
// Each ship is
//   1. FOUND: a pixel is "ink" when it is coloured, or a grey brighter than the
//      background (white and silver hulls), or a grey darker than the shadow
//      ever gets (black outlines — the blurred shadow bottoms out at 21/255,
//      measured). Ink forms 8-connected components; a ship's detached pods
//      and exhaust are small fragments that get rejoined to their nearest
//      neighbour, while two ships that merely sit close stay apart.
//   2. CROPPED, with the background AND the shadow removed: only the ship's
//      own pixels are kept, plus anything they enclose (the grey shading of a
//      silver jet) — the shadow is outside the hull, so it never qualifies.
//   3. HELD TO THE DEZAEMON 2 PALETTE: every opaque pixel snaps to the nearest
//      of the 192 system colours (palette/deza2-palette.js, the same
//      nearest-colour rule the .sav writer applies), so a ship chosen here
//      looks the same on a Saturn cart as it does in the editor.
//
// Frames are named ship_001.. in reading order (row by row, left to right),
// which is the order the chooser lists them in. The atlas JSON is the flat
// hash the editor's atlas loader reads (normalizeAtlasData's first branch).

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import {
  DEZA2_PALETTE_COLS,
  DEZA2_PALETTE_WORDS,
  DEZA2_SYSTEM_ROWS,
  deza2PaletteRgb,
  nearestPaletteIndex,
} from "../packages/shmup-engine/src/palette/deza2-palette.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
export const SHIP_SHEET_SOURCE = join(
  ROOT,
  "dev-fixtures",
  "ship-sheet",
  "ships.png",
);
export const SHIP_ATLAS_DIR = join(ROOT, "static", "editor", "assets", "ships");
export const SHIP_ATLAS_PNG = join(SHIP_ATLAS_DIR, "ships.png");
export const SHIP_ATLAS_JSON = join(SHIP_ATLAS_DIR, "ships.json");

// Measured on the sheet, not guessed: the background is (64,64,64) with lossy
// ringing a few levels either side, the shadow runs 21..63, and nothing in a
// hull that matters is a grey inside that band except shading the hull
// encloses (which step 2 keeps regardless).
const BACKGROUND_GREY = 64;
const NEUTRAL_SPREAD = 10; // max-min across RGB for a pixel to count as grey
const BRIGHT_GREY = 72; // a grey above this is hull, not shadow
const DARK_GREY = 10; // a grey below this is outline, not shadow (shadow floor: 21)
const NOISE_AREA = 3; // components smaller than this are compression dust
const SHIP_AREA = 20; // a finished group smaller than this is not a ship
const FRAGMENT_AREA = 60; // at most this big, a component may be a pod/exhaust
const FRAGMENT_X_OVERLAP = 0.4; // share of the narrower width, to rejoin vertically
const FRAGMENT_Y_OVERLAP = 0.5; // share of the shorter height, to rejoin sideways
const FRAGMENT_V_GAP = 4; // px between a hull and the pod under/over it
const FRAGMENT_H_GAP = 2; // px between a hull and the pod beside it
const BOX_OVERLAP = 0.25; // two boxes overlapping this much of the smaller are one ship
const RECLAIM_PASSES = 2; // edge passes that pull enclosed-looking shading back in
const ATLAS_WIDTH = 512;
const PAD = 1;

export const SHIP_KEY_PREFIX = "ship_";
export function shipKey(index: number): string {
  return SHIP_KEY_PREFIX + String(index).padStart(3, "0");
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

interface Ship {
  key: string;
  w: number;
  h: number;
  rgba: Uint8Array;
  sheet: { x: number; y: number };
}

function isNeutral(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= NEUTRAL_SPREAD;
}

function lum(r: number, g: number, b: number): number {
  return (r + g + b) / 3 | 0;
}

// Step 1a: the ink mask.
function inkMask(src: Raster): Uint8Array {
  const { width, height, data } = src;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (!isNeutral(r, g, b)) ink[i] = 1;
    else {
      const v = lum(r, g, b);
      if (v > BRIGHT_GREY || v < DARK_GREY) ink[i] = 1;
    }
  }
  return ink;
}

// Step 1b: 8-connected components of ink. Labels are 1-based, 0 = not ink.
function components(
  ink: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; boxes: Map<number, Box> } {
  const labels = new Int32Array(width * height);
  const boxes = new Map<number, Box>();
  const queue = new Int32Array(width * height);
  let next = 0;
  for (let start = 0; start < width * height; start++) {
    if (!ink[start] || labels[start]) continue;
    const id = ++next;
    const box: Box = { x0: width, y0: height, x1: -1, y1: -1, area: 0 };
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = (i / width) | 0;
      box.area++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (ink[j] && !labels[j]) {
            labels[j] = id;
            queue[tail++] = j;
          }
        }
      }
    }
    boxes.set(id, box);
  }
  return { labels, boxes };
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1);
}

// Two boxes that genuinely overlap are one ship whatever their sizes (a hull
// and the exhaust drawn across it).
function boxesOverlap(a: Box, b: Box): boolean {
  const ix = overlap(a.x0, a.x1, b.x0, b.x1);
  const iy = overlap(a.y0, a.y1, b.y0, b.y1);
  if (ix <= 0 || iy <= 0) return false;
  const areaA = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1);
  const areaB = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  return ix * iy >= BOX_OVERLAP * Math.min(areaA, areaB);
}

// How far a fragment sits from a neighbour it could belong to — null when it
// is not lined up with it closely enough to be its pod or its exhaust.
function fragmentGap(frag: Box, host: Box): number | null {
  const xo = overlap(frag.x0, frag.x1, host.x0, host.x1);
  const yo = overlap(frag.y0, frag.y1, host.y0, host.y1);
  const fw = frag.x1 - frag.x0 + 1, hw = host.x1 - host.x0 + 1;
  const fh = frag.y1 - frag.y0 + 1, hh = host.y1 - host.y0 + 1;
  const vgap = Math.max(host.y0 - frag.y1, frag.y0 - host.y1) - 1;
  const hgap = Math.max(host.x0 - frag.x1, frag.x0 - host.x1) - 1;
  if (xo >= FRAGMENT_X_OVERLAP * Math.min(fw, hw) && vgap <= FRAGMENT_V_GAP) {
    return Math.max(vgap, 0);
  }
  if (yo >= FRAGMENT_Y_OVERLAP * Math.min(fh, hh) && hgap <= FRAGMENT_H_GAP) {
    return Math.max(hgap, 0);
  }
  return null;
}

// Step 1c: group components into ships.
function groupShips(boxes: Map<number, Box>): { box: Box; ids: Set<number> }[] {
  const ids = [...boxes.keys()].sort((a, b) => a - b);
  const parent = new Map<number, number>(ids.map((id) => [id, id]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(i) !== r) {
      const n = parent.get(i)!;
      parent.set(i, r);
      i = n;
    }
    return r;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (boxesOverlap(boxes.get(ids[i])!, boxes.get(ids[j])!)) {
        union(ids[i], ids[j]);
      }
    }
  }
  // A fragment joins exactly ONE neighbour — the nearest, biggest first on a
  // tie — so a speck between two ships cannot bridge them.
  for (const id of ids) {
    const frag = boxes.get(id)!;
    if (frag.area > FRAGMENT_AREA) continue;
    let best: { gap: number; area: number; id: number } | null = null;
    for (const other of ids) {
      if (other === id) continue;
      const host = boxes.get(other)!;
      const gap = fragmentGap(frag, host);
      if (gap === null) continue;
      if (
        !best || gap < best.gap || (gap === best.gap && host.area > best.area)
      ) {
        best = { gap, area: host.area, id: other };
      }
    }
    if (best) union(id, best.id);
  }

  const groups = new Map<number, Set<number>>();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(id);
  }
  const ships: { box: Box; ids: Set<number> }[] = [];
  for (const members of groups.values()) {
    const box: Box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0 };
    for (const id of members) {
      const b = boxes.get(id)!;
      box.x0 = Math.min(box.x0, b.x0);
      box.y0 = Math.min(box.y0, b.y0);
      box.x1 = Math.max(box.x1, b.x1);
      box.y1 = Math.max(box.y1, b.y1);
      box.area += b.area;
    }
    if (box.area >= SHIP_AREA) ships.push({ box, ids: members });
  }
  return ships;
}

// Reading order: a ship belongs to the current row while its centre line
// falls inside the band the row has grown to; rows then read left to right.
function readingOrder<T extends { box: Box }>(ships: T[]): T[] {
  const byTop = [...ships].sort((a, b) =>
    a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0
  );
  const rows: { top: number; bottom: number; items: T[] }[] = [];
  for (const s of byTop) {
    const cy = (s.box.y0 + s.box.y1 + 1) / 2;
    const row = rows[rows.length - 1];
    if (row && cy >= row.top && cy <= row.bottom) {
      row.items.push(s);
      row.top = Math.min(row.top, s.box.y0);
      row.bottom = Math.max(row.bottom, s.box.y1 + 1);
    } else {
      rows.push({ top: s.box.y0, bottom: s.box.y1 + 1, items: [s] });
    }
  }
  const out: T[] = [];
  for (const row of rows) {
    out.push(...row.items.sort((a, b) => a.box.x0 - b.box.x0));
  }
  return out;
}

// The 192 system colours as the nearest-colour search sees them; index 0 is
// the transparent slot and nearestPaletteIndex never returns it.
const SYSTEM_PALETTE = deza2PaletteRgb(DEZA2_PALETTE_WORDS).slice(
  0,
  DEZA2_SYSTEM_ROWS * DEZA2_PALETTE_COLS,
);
const quantCache = new Map<number, number>();
function quantise(
  r: number,
  g: number,
  b: number,
): { r: number; g: number; b: number } {
  const packed = (r << 16) | (g << 8) | b;
  let idx = quantCache.get(packed);
  if (idx === undefined) {
    idx = nearestPaletteIndex(r, g, b, SYSTEM_PALETTE);
    quantCache.set(packed, idx);
  }
  return SYSTEM_PALETTE[idx];
}

// Steps 2 and 3 for one ship.
function extractShip(
  src: Raster,
  labels: Int32Array,
  ship: { box: Box; ids: Set<number> },
  key: string,
): Ship {
  const { x0, y0, x1, y1 } = ship.box;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const keep = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ship.ids.has(labels[(y0 + y) * src.width + x0 + x])) {
        keep[y * w + x] = 1;
      }
    }
  }
  // Anything not reachable from the crop's border through non-ship pixels is
  // enclosed by the hull: shading, canopy glass, a dark cockpit. Keep it.
  const reach = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const seed = (i: number) => {
    if (!keep[i] && !reach[i]) {
      reach[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!keep[i] && !reach[i]) keep[i] = 1;
  // A grey the shadow band could own counts as hull when the hull holds it
  // on both sides (left and right, or above and below): that is shading at
  // a hull's edge, never the shadow lying outside a convex corner.
  for (let pass = 0; pass < RECLAIM_PASSES; pass++) {
    const add: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (keep[i]) continue;
        const p = ((y0 + y) * src.width + x0 + x) * 4;
        const r = src.data[p], g = src.data[p + 1], b = src.data[p + 2];
        if (!isNeutral(r, g, b)) continue;
        const v = lum(r, g, b);
        if (v < DARK_GREY || v > BRIGHT_GREY) continue;
        const lr = x > 0 && keep[i - 1] && x < w - 1 && keep[i + 1];
        const ud = y > 0 && keep[i - w] && y < h - 1 && keep[i + w];
        if (lr || ud) add.push(i);
      }
    }
    for (const i of add) keep[i] = 1;
  }
  // Paint it, snapped to the system palette, then trim to what is left.
  let tx0 = w, ty0 = h, tx1 = -1, ty1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep[y * w + x]) continue;
      if (x < tx0) tx0 = x;
      if (x > tx1) tx1 = x;
      if (y < ty0) ty0 = y;
      if (y > ty1) ty1 = y;
    }
  }
  const tw = tx1 - tx0 + 1, th = ty1 - ty0 + 1;
  const rgba = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = tx0 + x, sy = ty0 + y;
      if (!keep[sy * w + sx]) continue;
      const p = ((y0 + sy) * src.width + x0 + sx) * 4;
      const c = quantise(src.data[p], src.data[p + 1], src.data[p + 2]);
      const o = (y * tw + x) * 4;
      rgba[o] = c.r;
      rgba[o + 1] = c.g;
      rgba[o + 2] = c.b;
      rgba[o + 3] = 255;
    }
  }
  return { key, w: tw, h: th, rgba, sheet: { x: x0 + tx0, y: y0 + ty0 } };
}

// Shelf packing, tallest first, into a fixed-width atlas.
function pack(
  ships: Ship[],
): { raster: Raster; frames: Record<string, unknown> } {
  const order = [...ships].sort((a, b) =>
    b.h - a.h || a.key.localeCompare(b.key)
  );
  const pos = new Map<string, { x: number; y: number }>();
  let x = PAD, y = PAD, rowH = 0;
  for (const s of order) {
    if (x + s.w + PAD > ATLAS_WIDTH) {
      x = PAD;
      y += rowH + PAD;
      rowH = 0;
    }
    pos.set(s.key, { x, y });
    x += s.w + PAD;
    rowH = Math.max(rowH, s.h);
  }
  const height = y + rowH + PAD;
  const raster = newRaster(ATLAS_WIDTH, height);
  const frames: Record<string, unknown> = {};
  for (const s of ships) {
    const { x: px, y: py } = pos.get(s.key)!;
    for (let yy = 0; yy < s.h; yy++) {
      raster.data.set(
        s.rgba.subarray(yy * s.w * 4, (yy + 1) * s.w * 4),
        ((py + yy) * ATLAS_WIDTH + px) * 4,
      );
    }
    frames[s.key] = {
      frame: { x: px, y: py, w: s.w, h: s.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
      sourceSize: { w: s.w, h: s.h },
      sheet: s.sheet,
    };
  }
  return { raster, frames };
}

export async function buildShipSheet(
  sourcePath = SHIP_SHEET_SOURCE,
): Promise<{ ships: Ship[]; raster: Raster; json: unknown }> {
  const src = await decodePng(await Deno.readFile(sourcePath));
  const ink = inkMask(src);
  const { labels, boxes } = components(ink, src.width, src.height);
  for (const [id, box] of boxes) if (box.area < NOISE_AREA) boxes.delete(id);
  const grouped = readingOrder(groupShips(boxes));
  const ships = grouped.map((g, i) =>
    extractShip(src, labels, g, shipKey(i + 1))
  );
  const { raster, frames } = pack(ships);
  const json = {
    frames,
    meta: {
      app: "scripts/build-ship-sheet.ts",
      image: "ships.png",
      format: "RGBA8888",
      size: { w: raster.width, h: raster.height },
      scale: "1",
      palette: "Dezaemon 2 system colours (deza2-palette.js rows 0-11)",
      source: relative(ROOT, sourcePath),
      background: BACKGROUND_GREY,
      count: ships.length,
    },
  };
  return { ships, raster, json };
}

if (import.meta.main) {
  let source = SHIP_SHEET_SOURCE;
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--source") source = resolve(Deno.args[++i] ?? "");
    else {
      console.error(`error: unknown argument ${Deno.args[i]}`);
      Deno.exit(2);
    }
  }
  try {
    await Deno.stat(source);
  } catch {
    console.error(
      `error: ${
        relative(ROOT, source)
      } is missing — the source sheet is local-only (dev-fixtures/)`,
    );
    Deno.exit(2);
  }
  const { ships, raster, json } = await buildShipSheet(source);
  await ensureDir(SHIP_ATLAS_DIR);
  const png = await encodePng(raster);
  await Deno.writeFile(SHIP_ATLAS_PNG, png);
  await Deno.writeTextFile(
    SHIP_ATLAS_JSON,
    JSON.stringify(json, null, 2) + "\n",
  );
  const widest = ships.reduce((m, s) => Math.max(m, s.w), 0);
  const tallest = ships.reduce((m, s) => Math.max(m, s.h), 0);
  console.log(
    `${ships.length} ships (up to ${widest}x${tallest}) -> ${
      relative(ROOT, SHIP_ATLAS_PNG)
    } ` +
      `${raster.width}x${raster.height}, ${png.length} bytes; ${
        relative(ROOT, SHIP_ATLAS_JSON)
      }`,
  );
}
