// Pictures the player attaches to a DESCRIBE IT request: check them, look at
// them, and cut frames out of them for the character the model builds.
//
// The motivating picture is the case every rule below was tuned on: a
// 1400x743 PNG on white with, on the left, a pixel-art fighter someone
// enlarged about 12x with SMOOTHING ON (every block edge is a one- or
// two-pixel blend of its neighbours) and, on the right, black ASCII-art text.
// "Use the ascii image (right) as projectile for Ryuda (left)" only works if
// the server can say "there are two things here, the left one is 58x63 pixel
// art at x11.8 and the right one is dark-on-light line art", and can then hand
// the packer a clean 58x63 sprite on transparency and a white-inked shot. The
// model sees the pictures too, but it cannot count pixels; this module does
// the counting and tells it what it found in plain words (describeUploads).
//
// Everything here is pure and synchronous apart from PNG decoding: no network,
// no catalog, nothing the route has to await but openUploads. art.ts imports
// cutUpload, so this file must never import art.ts back — CutFrame is the
// structural copy of its ResolvedFrame that keeps the two from forming a cycle.

import { decodeBase64 } from "@std/encoding/base64";
import {
  decodePng,
  newRaster,
  PNG_CHANNELS,
  PNG_DEPTHS,
} from "@shmupx/shmup-harbor/png";
import type { Bytes, Raster } from "@shmupx/shmup-harbor/png";
import { cut, type Rect } from "@shmupx/shmup-harbor/raster";

export const MAX_UPLOADS = 3;
/** Decoded PNG bytes per image. */
export const MAX_UPLOAD_BYTES = 4_000_000;
/**
 * Pixels, either side. The editor scales anything larger down before sending.
 * 2000 because that is the Messages API's limit on each image once a request
 * carries more than 20 of them — which an ask reaches on its own: every turn
 * resends the pictures, and every dry run adds a body and a shot PNG. Over
 * it, the whole ask dies with a 400 and every proposal so far is lost.
 */
export const MAX_UPLOAD_SIDE = 2000;
/** Pixels, a processed frame's longest side. */
export const MAX_FRAME_SIDE = 256;

/** A message meant for whoever sent the request — the player, or the model. */
export class UploadError extends Error {
  override name = "UploadError";
}

export interface UploadRegion {
  /** 0-based, the `region` a frame ref names. */
  index: number;
  /** In the image's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Detected upscale of pixel art (12 = each 12x12 block is one pixel); 1 when none. */
  pixelScale: number;
  /** Size after undoing pixelScale. */
  native: { w: number; h: number };
  /**
   * "pixel-art" (pixelScale ≥ 2), "monochrome" (foreground nearly grey —
   * text, line art, scans), or "image".
   */
  kind: "pixel-art" | "monochrome" | "image";
  /** Foreground is darker than the background on average (ink on paper). */
  darkOnLight: boolean;
}

export interface UploadAnalysis {
  width: number;
  height: number;
  /**
   * The colour most of the border is, when one colour is ≥ 40% of border
   * pixels; `transparent` when the border is alpha 0; null for a photo with no
   * plain field.
   */
  background: {
    r: number;
    g: number;
    b: number;
    hex: string;
    transparent: boolean;
  } | null;
  /**
   * Separate subjects on the background, left-to-right then top-to-bottom.
   * Specks are dropped and there are at most 12. With no background, one
   * region: the whole image.
   */
  regions: UploadRegion[];
}

export interface UploadedImage {
  /** Its position in the request, the `upload` a ref names. */
  index: number;
  /** Sanitized display name, [\w-] only, ≤ 32 chars, "upload" if empty. */
  name: string;
  raster: Raster;
  analysis: UploadAnalysis;
  /** The PNG bytes as received, bare base64 — what the model is shown. */
  png_base64: string;
}

/** A frame cut out of an upload: what resolveFrame hands to the packer. */
export interface UploadRef {
  upload: number;
  region?: number;
  crop?: { x: number; y: number; w: number; h: number };
  /** Default "remove". */
  background?: "remove" | "keep";
  /** CSS hex ("#fff", "#ffcc00") or one of the names in INKS. */
  ink?: string;
  /** Default "auto"; 1 leaves the pixels alone. */
  pixelScale?: number | "auto";
  /** Shrink so the longest side ≤ this (area average). */
  maxSize?: number;
  /** Integer 1–4, nearest-neighbour enlarge, applied last. */
  scale?: number;
  as?: string;
}

/** The shape of art.ts's ResolvedFrame, declared here to keep imports one-way. */
export interface CutFrame {
  name: string;
  raster: Raster;
  source: string;
  scope: string;
}

/**
 * What detectPixelScale found. `phaseX`/`phaseY` are where the first whole
 * block starts, in (−scale/2, scale/2]: a block that the picture's edge cut
 * short still counts when at least half of it is in frame, which is why the
 * phase can be negative. Both are 0 when `scale` is 1.
 */
export interface PixelScale {
  scale: number;
  phaseX: number;
  phaseY: number;
}

// ─── tuning ─────────────────────────────────────────────────────────────────

/** Max channel difference from the background that still counts as background. */
const BG_TOLERANCE = 40;
/** Below this alpha a pixel is not there at all. */
const ALPHA_FLOOR = 16;
/** Sum of |ΔR|+|ΔG|+|ΔB|+|ΔA| between neighbours that counts as a colour edge. */
const EDGE_THRESHOLD = 48;
const MIN_PERIOD = 2;
const MAX_PERIOD = 40;
const PERIOD_STEP = 0.05;
const PHASE_STEP = 0.25;
/** The best period must beat chance by this much before we call it pixel art. */
const ACCEPT_EXCESS = 0.35;
/** Grid lines that must carry edges before a period counts at all. */
const MIN_GRID_LINES = 3;
const MAX_REGIONS = 12;
/**
 * The most region width-plus-height analyzeUpload measures pixel scale over,
 * per picture: one whole 2000x2000 picture, or the motivating picture's two
 * regions (2858) with room to spare.
 */
const DETECT_BUDGET = 4096;
/** How many of the border's biggest colour buckets are tried as the field. */
const BACKGROUND_SEEDS = 8;
const MONOCHROME_SATURATION = 0.12;
/**
 * Channels within this of each other are grey, whatever HSL says. HSL
 * saturation divides by how far lightness is from the ends, so a JPEG-tinted
 * near-black like (5, 0, 10) scores 1.0 — fully saturated — and a scan of
 * black text would otherwise come out "image" instead of "monochrome".
 */
const GREY_CHROMA = 24;

const INKS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gold: [255, 215, 0],
  pink: [255, 192, 203],
  grey: [128, 128, 128],
  gray: [128, 128, 128],
};

// ─── decoding the request ───────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What checkUploads vouches for: the bytes of a PNG that is safe to open. */
export interface CheckedUpload {
  index: number;
  /** Sanitized display name, as UploadedImage carries it. */
  name: string;
  bytes: Uint8Array;
  /** The PNG bytes as received, bare base64. */
  png_base64: string;
  /** From the IHDR, already held to MAX_UPLOAD_SIDE. */
  width: number;
  height: number;
}

/**
 * Validate and decode the request's `uploads` field: checkUploads, then
 * openUploads. The route runs the two halves apart — the check before it
 * admits the request, the opening after — and anything else that wants a
 * picture in one step calls this. undefined/null → [].
 */
export async function decodeUploads(input: unknown): Promise<UploadedImage[]> {
  return await openUploads(checkUploads(input));
}

/**
 * The half of decoding that costs nothing: the list's shape, the base64, the
 * byte count, the PNG signature and the IHDR, all read straight off the
 * bytes with nothing inflated. Throws UploadError with a message the route
 * returns as a 400, so every one says what the player can do about it. The
 * checks run cheapest-and-most-dangerous first, and the header comes off the
 * bytes rather than out of decodePng because a few kilobytes of deflate can
 * claim 20000x20000 pixels, which decodePng would dutifully allocate 1.6 GB
 * for.
 *
 * The route runs this BEFORE it admits the request, so a broken or hostile
 * upload is turned away without spending one of the player's hourly asks —
 * and runs openUploads only AFTER, so a client already over its limit cannot
 * make the server inflate and analyse pictures for it either. That split only
 * works if nothing here does real work: no inflate, no allocation beyond the
 * decoded base64, which the byte cap bounds before it is allocated.
 */
export function checkUploads(input: unknown): CheckedUpload[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new UploadError(
      "uploads must be a list of pictures, each {name, png} with png the " +
        "base64 of a PNG — attach the pictures again.",
    );
  }
  if (input.length > MAX_UPLOADS) {
    throw new UploadError(
      `That is ${input.length} pictures; a request carries at most ` +
        `${MAX_UPLOADS} — remove ${input.length - MAX_UPLOADS} and ask again.`,
    );
  }
  const out: CheckedUpload[] = [];
  for (let index = 0; index < input.length; index++) {
    const entry = input[index] as { name?: unknown; png?: unknown } | null;
    if (
      entry == null || typeof entry !== "object" ||
      typeof entry.png !== "string"
    ) {
      throw new UploadError(
        `Picture ${index} has no png — each upload is {name, png} with png ` +
          "the base64 of a PNG. Attach it again.",
      );
    }
    // The editor sends bare base64, but a data URL is what a canvas hands
    // over and what someone scripting the endpoint will paste, so take the
    // prefix off rather than refuse it. Whitespace goes too: wrapped base64
    // is still base64, and the copy the model is shown must be clean.
    const png_base64 = entry.png
      .replace(/^data:[\w/+.-]*;base64,/i, "")
      .replace(/\s+/g, "");
    if (!png_base64) {
      throw new UploadError(
        `Picture ${index} is empty — attach it again.`,
      );
    }
    // Refuse an oversized body from its length alone, before decodeBase64
    // allocates the bytes it describes.
    const padding = png_base64.endsWith("==")
      ? 2
      : png_base64.endsWith("=")
      ? 1
      : 0;
    const estimate = Math.floor(png_base64.length * 3 / 4) - padding;
    if (estimate > MAX_UPLOAD_BYTES) {
      throw new UploadError(tooManyBytes(index, estimate));
    }
    let bytes: Bytes;
    try {
      bytes = decodeBase64(png_base64);
    } catch {
      throw new UploadError(
        `Picture ${index} is not base64 — the png field must be the base64 ` +
          "of the PNG's bytes. Attach the picture again.",
      );
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new UploadError(tooManyBytes(index, bytes.length));
    }
    if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
      throw new UploadError(
        `Picture ${index} is not a PNG. The editor turns every picture into ` +
          "a PNG before sending it; attach it again from the editor.",
      );
    }
    const header = readIhdr(bytes);
    if (typeof header === "string") {
      throw new UploadError(
        `Picture ${index} is a broken PNG (${header}) — save it again and ` +
          "attach the new copy.",
      );
    }
    if (header.width === 0 || header.height === 0) {
      throw new UploadError(
        `Picture ${index} is ${header.width}×${header.height} px — there is ` +
          "nothing in it. Attach a different picture.",
      );
    }
    if (header.width > MAX_UPLOAD_SIDE || header.height > MAX_UPLOAD_SIDE) {
      throw new UploadError(
        `Picture ${index} is ${header.width}×${header.height} px; pictures ` +
          `can be at most ${MAX_UPLOAD_SIDE} px on a side — shrink it and ` +
          "attach it again.",
      );
    }
    if (header.interlaced) {
      throw new UploadError(
        `Picture ${index} is an interlaced PNG, which cannot be read here — ` +
          "save it again as a plain PNG and attach the new copy.",
      );
    }
    out.push({
      index,
      // The editor drops the extension already; a scripted client sending
      // "ryuda.png" should still get frames called ryuda_r0, not
      // ryuda_png_r0.
      name: safeName(
        typeof entry.name === "string"
          ? entry.name.replace(/\.(png|jpe?g|gif|webp|bmp|avif)$/i, "")
          : "",
        "upload",
      ),
      bytes,
      png_base64,
      width: header.width,
      height: header.height,
    });
  }
  return out;
}

/**
 * The half of decoding that costs something: inflate each checked PNG and
 * look at it (analyzeUpload). The inflate is capped at exactly the bytes its
 * IHDR says the pixels take — a PNG's pixel data is height × (stride + 1)
 * bytes and not one more — because a few megabytes of deflate will happily
 * inflate to gigabytes under an honest 2000x2000 header, and a cap on the
 * header alone does nothing about that. decodePng is also held to
 * MAX_UPLOAD_SIDE on the header it really decodes, should the bytes have
 * changed since they were checked. Throws UploadError.
 */
export async function openUploads(
  checked: CheckedUpload[],
): Promise<UploadedImage[]> {
  const out: UploadedImage[] = [];
  for (const { index, name, bytes, png_base64 } of checked) {
    const header = readIhdr(bytes);
    if (typeof header === "string") {
      throw new UploadError(
        `Picture ${index} is a broken PNG (${header}) — save it again and ` +
          "attach the new copy.",
      );
    }
    let raster: Raster;
    try {
      raster = await decodePng(bytes as Bytes, {
        maxInflated: header.inflated,
        maxSide: MAX_UPLOAD_SIDE,
      });
    } catch (err) {
      throw new UploadError(
        `Picture ${index} could not be read as a PNG (${
          err instanceof Error ? err.message : String(err)
        }) — save it again as a plain PNG and attach the new copy.`,
      );
    }
    out.push({
      index,
      name,
      raster,
      analysis: analyzeUpload(raster),
      png_base64,
    });
  }
  return out;
}

function tooManyBytes(index: number, bytes: number): string {
  return `Picture ${index} is ${(bytes / 1e6).toFixed(1)} MB; a picture can ` +
    `be at most ${MAX_UPLOAD_BYTES / 1e6} MB as a PNG — crop or shrink it ` +
    "and attach it again.";
}

interface Ihdr {
  width: number;
  height: number;
  interlaced: boolean;
  /** The bytes the pixel data inflates to: height × (1 filter byte + stride). */
  inflated: number;
}

/**
 * The IHDR, read straight off the bytes — or what is wrong with it, in words
 * for the player. The spec puts it first, straight after the signature, and
 * allows exactly one. The rest of the chunk list is walked too (lengths only,
 * nothing inflated): a 1x1 header followed by an 8192x8192 one passes a side
 * check on the first, and decodePng used to decode the second — a 268 MB
 * raster out of an 8 KB file. decodePng refuses a second header itself now,
 * but this runs before the route admits the request, where nothing may be
 * decoded at all.
 */
function readIhdr(bytes: Uint8Array): Ihdr | string {
  if (bytes.length < 33) return "no IHDR header";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (at: number) =>
    String.fromCharCode(
      bytes[at + 4],
      bytes[at + 5],
      bytes[at + 6],
      bytes[at + 7],
    );
  if (typeAt(8) !== "IHDR" || view.getUint32(8) !== 13) {
    return "no IHDR header";
  }
  // Walk the chunks the way decodePng does — by their lengths, stopping at
  // IEND — so the two agree on what counts as a second header.
  for (let at = 8 + 12 + 13; at + 8 <= bytes.length;) {
    const type = typeAt(at);
    if (type === "IHDR") return "it has more than one IHDR header";
    if (type === "IEND") break;
    at += 12 + view.getUint32(at);
  }
  const width = view.getUint32(16), height = view.getUint32(20);
  const depth = bytes[24], colorType = bytes[25];
  const depths = PNG_DEPTHS[colorType];
  if (!depths) return `colour type ${colorType} is not one PNG has`;
  if (!depths.includes(depth)) {
    return `bit depth ${depth} is not one colour type ${colorType} allows`;
  }
  const stride = Math.ceil(width * PNG_CHANNELS[colorType] * depth / 8);
  return {
    width,
    height,
    interlaced: bytes[28] !== 0,
    inflated: height * (stride + 1),
  };
}

/**
 * [\w-] only, ≤ 32 chars. A frame name lands in the packed atlas and in the
 * record, both of which the runtime and the RTDB key rules are fussy about,
 * and the display name is the default stem of every frame cut from it.
 */
function safeName(value: unknown, fallback: string): string {
  const name = (typeof value === "string" ? value : "")
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return name || fallback;
}

// ─── looking at a picture ───────────────────────────────────────────────────

/**
 * Find the background and the separate subjects standing on it.
 *
 * The background is whatever colour most of the border is. The subjects are
 * the foreground pixels grouped by proximity: two pixels with at most `gap`
 * empty pixels between them belong together, where gap is 1% of the longer side
 * (14 px for 1400x743, at least 3). That is wide enough that ASCII art — a
 * few hundred glyphs with spaces between them — stays one subject, and narrow
 * enough that two pictures pasted side by side with a gutter come apart: the
 * motivating picture's gutter is 21 px. Grouping is done by growing every
 * foreground pixel into a (gap+1)-square and labelling what touches; each
 * region's rectangle is then the bounding box of the ORIGINAL foreground
 * pixels in its group, so the growth never leaks into the coordinates.
 *
 * Each region's pixel scale is measured too, but only up to DETECT_BUDGET:
 * the search costs in proportion to a region's width plus height, whatever
 * is in it — about 150 ms for a 2000x2000 one — so twelve picture-sized
 * regions (nested rings, stripes across the page) cost 1.7 s of CPU per
 * picture, synchronously, three pictures to a request. The biggest subjects
 * are measured first; the rest report pixelScale 1 and their own size as
 * native, and cutUpload's "auto" still measures the one region the model
 * actually cuts.
 */
export function analyzeUpload(raster: Raster): UploadAnalysis {
  const { width, height } = raster;
  const background = borderBackground(raster);
  if (!background) {
    const whole = { x: 0, y: 0, w: width, h: height };
    const stats = regionStats(raster, whole, null);
    return {
      width,
      height,
      background: null,
      regions: [describeRegion(raster, whole, stats, null, 0, true)],
    };
  }

  const mask = foregroundMask(raster, background);
  const gap = Math.max(3, Math.round(Math.max(width, height) / 100));
  const grown = grow(mask, width, height, gap);
  const { labels, count } = label8(grown, width, height);

  // One pass over the original foreground: bbox, pixel count and colour
  // sums per label. The stats are the group's own pixels, gathered here
  // rather than by re-reading each region's rectangle afterwards — twelve
  // nested regions as big as the picture would read it twelve times over.
  const { data } = raster;
  const minX = new Int32Array(count).fill(width);
  const minY = new Int32Array(count).fill(height);
  const maxX = new Int32Array(count).fill(-1);
  const maxY = new Int32Array(count).fill(-1);
  const pixels = new Int32Array(count);
  const lumaSum = new Float64Array(count);
  const satSum = new Float64Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const l = labels[i] - 1;
      pixels[l]++;
      if (x < minX[l]) minX[l] = x;
      if (x > maxX[l]) maxX[l] = x;
      if (y < minY[l]) minY[l] = y;
      if (y > maxY[l]) maxY[l] = y;
      const d = i * 4;
      lumaSum[l] += luma(data[d], data[d + 1], data[d + 2]);
      satSum[l] += saturation(data[d], data[d + 1], data[d + 2]);
    }
  }
  let found: { rect: Rect; pixels: number; stats: RegionStats }[] = [];
  for (let l = 0; l < count; l++) {
    if (!pixels[l]) continue;
    found.push({
      rect: {
        x: minX[l],
        y: minY[l],
        w: maxX[l] - minX[l] + 1,
        h: maxY[l] - minY[l] + 1,
      },
      pixels: pixels[l],
      stats: {
        luma: lumaSum[l] / pixels[l],
        saturation: satSum[l] / pixels[l],
      },
    });
  }

  // Specks are JPEG noise, a stray mark, the dot of a signature. But a tiny
  // picture's ONLY subject may be smaller than the cut-off — a bullet sprite
  // is often 4x4 — and dropping it would leave nothing to name, so the
  // biggest group survives whatever its size.
  const speck = Math.max(24, width * height / 1000);
  found.sort((a, b) => b.pixels - a.pixels);
  const kept = found.filter((f) => f.rect.w * f.rect.h >= speck);
  found = (kept.length ? kept : found.slice(0, 1)).slice(0, MAX_REGIONS);
  // Still biggest first: that is the order the detection budget is spent in.
  const measured = new Set<Rect>();
  let spent = 0;
  for (const { rect } of found) {
    if (spent + rect.w + rect.h > DETECT_BUDGET) continue;
    spent += rect.w + rect.h;
    measured.add(rect);
  }
  found.sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);

  return {
    width,
    height,
    background,
    regions: found.map(({ rect, stats }, index) =>
      describeRegion(
        raster,
        rect,
        stats,
        background,
        index,
        measured.has(rect),
      )
    ),
  };
}

type Background = NonNullable<UploadAnalysis["background"]>;

interface RegionStats {
  /** Mean luma of the foreground. */
  luma: number;
  /** Mean HSL saturation of the foreground, with greys counted as 0. */
  saturation: number;
}

function describeRegion(
  raster: Raster,
  rect: Rect,
  stats: RegionStats,
  background: Background | null,
  index: number,
  measure: boolean,
): UploadRegion {
  const fit = measure
    ? pixelScaleIn(raster, rect)
    : { scale: 1, phaseX: 0, phaseY: 0 };
  const native = fit.scale >= 2
    ? {
      w: Math.max(1, Math.round((rect.w - fit.phaseX) / fit.scale)),
      h: Math.max(1, Math.round((rect.h - fit.phaseY) / fit.scale)),
    }
    : { w: rect.w, h: rect.h };
  const kind = fit.scale >= 2
    ? "pixel-art"
    : stats.saturation < MONOCHROME_SATURATION
    ? "monochrome"
    : "image";
  return {
    index,
    ...rect,
    pixelScale: fit.scale,
    native,
    kind,
    darkOnLight: background != null && !background.transparent &&
      stats.luma < luma(background.r, background.g, background.b),
  };
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** The whole picture's stats, for the one region a picture with no background has. */
function regionStats(
  raster: Raster,
  rect: Rect,
  background: Background | null,
): RegionStats {
  const { width, data } = raster;
  let n = 0, lumaSum = 0, satSum = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * width + x) * 4;
      if (!isForeground(data, i, background)) continue;
      n++;
      lumaSum += luma(data[i], data[i + 1], data[i + 2]);
      satSum += saturation(data[i], data[i + 1], data[i + 2]);
    }
  }
  return n
    ? { luma: lumaSum / n, saturation: satSum / n }
    : { luma: 0, saturation: 0 };
}

/** HSL saturation, with near-greys (GREY_CHROMA) counted as 0. */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < GREY_CHROMA) return 0;
  const l = (max + min) / 510;
  return chroma / 255 / (1 - Math.abs(2 * l - 1));
}

function isForeground(
  data: Uint8Array,
  i: number,
  background: Background | null,
): boolean {
  if (data[i + 3] < ALPHA_FLOOR) return false;
  if (!background || background.transparent) return true;
  return Math.max(
    Math.abs(data[i] - background.r),
    Math.abs(data[i + 1] - background.g),
    Math.abs(data[i + 2] - background.b),
  ) > BG_TOLERANCE;
}

function foregroundMask(raster: Raster, background: Background): Uint8Array {
  const n = raster.width * raster.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (isForeground(raster.data, i * 4, background)) mask[i] = 1;
  }
  return mask;
}

/**
 * The colour most of the border is. Border pixels are bucketed at 4 bits a
 * channel, so the few levels of noise a JPEG (or a screenshot's dithering)
 * puts into a "white" field land in one bucket; each of the biggest buckets'
 * members are then widened to everything within 16 of their average, and the
 * widest of those groups is the field. Widening rescues a field that happens
 * to straddle a bucket boundary (128 vs 127) — and it has to start from more
 * than the single biggest bucket, because a noisy mid-grey straddles the
 * boundary on all three channels at once and lands in eight buckets of a
 * tenth each, where a solid strip along one edge, a third of the border,
 * would win the plurality and leave a picture that is two-thirds grey field
 * with "no plain background". A border that is mostly alpha 0 is a
 * transparent background whatever RGB the invisible pixels carry.
 */
function borderBackground(raster: Raster): Background | null {
  const { width, height, data } = raster;
  const border: number[] = [];
  for (let x = 0; x < width; x++) {
    border.push(x);
    if (height > 1) border.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    border.push(y * width);
    if (width > 1) border.push(y * width + width - 1);
  }
  // Key 0 is "alpha under the floor" and nothing else: an opaque pixel's
  // bucket always carries its alpha nibble.
  const bucket = (i: number) =>
    data[i + 3] < ALPHA_FLOOR
      ? 0
      : ((data[i] >> 4) << 12) | ((data[i + 1] >> 4) << 8) |
        ((data[i + 2] >> 4) << 4) | (data[i + 3] >> 4);
  const counts = new Uint32Array(1 << 16);
  const opaque: number[] = [];
  for (const p of border) {
    const key = bucket(p * 4);
    if (counts[key]++ === 0 && key !== 0) opaque.push(key);
  }
  const mean = (match: (i: number) => boolean) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const p of border) {
      const i = p * 4;
      if (!match(i)) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return { r: r / n, g: g / n, b: b / n, n };
  };
  let field: ReturnType<typeof mean> | null = null;
  opaque.sort((a, b) => counts[b] - counts[a]);
  for (const key of opaque.slice(0, BACKGROUND_SEEDS)) {
    const seed = mean((i) => bucket(i) === key);
    const wide = mean((i) =>
      data[i + 3] >= ALPHA_FLOOR &&
      Math.abs(data[i] - seed.r) <= 16 &&
      Math.abs(data[i + 1] - seed.g) <= 16 &&
      Math.abs(data[i + 2] - seed.b) <= 16
    );
    if (!field || wide.n > field.n) field = wide;
  }
  const needed = border.length * 0.4;
  if (counts[0] >= needed && counts[0] >= (field?.n ?? 0)) {
    return { r: 0, g: 0, b: 0, hex: "#000000", transparent: true };
  }
  if (!field || field.n < needed) return null;
  const r = Math.round(field.r), g = Math.round(field.g);
  const b = Math.round(field.b);
  return { r, g, b, hex: hex(r, g, b), transparent: false };
}

function hex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Grow every set pixel into the (gap+1)-square below and to the right of it.
 * One-sided on purpose: two pixels' squares then touch (8-connected) exactly
 * when at most `gap` empty pixels separate them along each axis, which is the
 * merge distance the caller means — a centred window of radius gap would
 * merge across 2·gap and swallow a 21 px gutter at gap 14. Separable, with a
 * running count per row and then per column, so it is O(W·H) whatever gap is.
 */
function grow(
  mask: Uint8Array,
  width: number,
  height: number,
  gap: number,
): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let run = 0;
    for (let x = 0; x < width; x++) {
      run += mask[row + x];
      if (x > gap) run -= mask[row + x - gap - 1];
      if (run) rows[row + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      run += rows[y * width + x];
      if (y > gap) run -= rows[(y - gap - 1) * width + x];
      if (run) out[y * width + x] = 1;
    }
  }
  return out;
}

/** 8-connected components of a mask, labelled 1..count (0 = unset). */
function label8(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = ++count;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const p = stack[--top];
      const px = p % width, py = (p - px) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack[top++] = q;
          }
        }
      }
    }
  }
  return { labels, count };
}

// ─── pixel scale ────────────────────────────────────────────────────────────

/**
 * How much a piece of pixel art was enlarged, and where its block grid sits.
 *
 * Per axis, an edge histogram: E[i] counts the rows (columns) where pixel i−1
 * and pixel i differ by more than EDGE_THRESHOLD. Enlarged pixel art puts all
 * of its edges on a grid of period p, so for the right p and phase φ almost
 * every edge lands within ±1 px of φ + k·p — the ±1 is what absorbs the
 * one- and two-pixel blends a smoothed enlargement smears each edge into.
 * Random edges would land there 3/p of the time, so the score is the hit
 * fraction minus that chance ("excess"), which stops small periods from
 * winning by covering everything. A fractional scale (x12.3 nearest gives
 * blocks of 12 and 13) is found the same way, since round(φ + k·12.3) walks
 * exactly the uneven grid such an enlargement produces.
 *
 * The ±1 window has a blind spot, though: at p ≤ 4 it covers 75% or more of
 * every period, so chance alone scores nearly what a perfect grid does and a
 * plain x2, x3 or x4 enlargement — the most common kind — could never clear
 * the bar. So every period is also scored with an exact window (the edge on
 * the grid line itself, chance 1/p), and the better of the two counts. A
 * crisp nearest-neighbour enlargement wins on the exact window at any scale;
 * a smoothed one wins on ±1, where its smeared edges need the slack.
 *
 * Candidates run over p ∈ [2, 40] in steps of 0.05 and φ in steps of 0.25,
 * which sounds expensive but is not: φ has 4p values and each tries n/p
 * grid lines, so every period costs about 4n window sums off a prefix array —
 * a few million additions for a 700x750 region.
 */
export function detectPixelScale(raster: Raster): PixelScale {
  return pixelScaleIn(raster, {
    x: 0,
    y: 0,
    w: raster.width,
    h: raster.height,
  });
}

function pixelScaleIn(raster: Raster, rect: Rect): PixelScale {
  const none = { scale: 1, phaseX: 0, phaseY: 0 };
  if (rect.w < 2 * MIN_PERIOD || rect.h < 2 * MIN_PERIOD) return none;
  const { ex, ey } = edgeHistograms(raster, rect);
  const ax = new Axis(ex), ay = new Axis(ey);
  const fx = ax.pick(), fy = ay.pick();
  if (!fx && !fy) return none;

  let lo: number, hi: number, reachX: Reach, reachY: Reach;
  if (fx && fy && Math.abs(fx.p - fy.p) <= 0.1 * Math.max(fx.p, fy.p)) {
    // They agree: settle below on the one period between the two estimates
    // that lines up the whole grid, so a picture stretched to x11.8 on one
    // axis and x11.75 on the other is read at one scale both ways.
    lo = Math.min(fx.p, fy.p);
    hi = Math.max(fx.p, fy.p);
    reachX = fx.reach;
    reachY = fy.reach;
  } else {
    // They disagree, or only one axis found a grid. Pixel art has block
    // edges both ways, so whichever period is used must clear the full bar
    // on BOTH axes: a grid on one axis alone is far more likely to be lines
    // of text (monospace type sits on a 12 px pitch one way and nothing the
    // other) or stripes, and calling those pixel art crushes them to mush —
    // at half the bar, a nine-line ASCII house came back as 5x7 pixels.
    //
    // When they disagree, one is often a multiple of the other, and then
    // the better-scoring period can be the wrong one: a 7x6 heart at crisp
    // x2 changes shape on only a few of its rows, most of them 4 px apart,
    // so its y axis prefers 4 — and reading the whole picture at x4 throws
    // away every other row and column. The finer period still lines up the
    // coarser axis's edges; the coarser one misses half of the finer axis's.
    // So the finer period is tried too, and the one the WORSE axis agrees
    // with most wins — but only when it really divides the other: two
    // unrelated periods (a narrow column of type at 2.75 one way and 2.15
    // the other) are two coincidences, and trying both just doubles the
    // chance one of them clears the bar.
    const xBetter = (fx?.excess ?? -1) >= (fy?.excess ?? -1);
    const better = (xBetter ? fx : fy)!, other = xBetter ? fy : fx;
    const tries = [better.p];
    if (other && other.p < better.p) {
      const k = Math.round(better.p / other.p);
      if (k >= 2 && Math.abs(better.p - k * other.p) <= 0.05 * better.p) {
        tries.push(other.p);
      }
    }
    let best: { p: number; x: Fit; y: Fit; score: number } | null = null;
    for (const p of tries) {
      const x = ax.fit(p), y = ay.fit(p);
      const score = Math.min(x.excess, y.excess);
      if (!best || score > best.score) best = { p, x, y, score };
    }
    if (!best || best.score < ACCEPT_EXCESS) return none;
    lo = hi = best.p;
    reachX = best.x.reach;
    reachY = best.y.reach;
  }

  // Refine to a hundredth, on both axes at once and with each axis's window
  // held fixed so the hit counts compare. The 0.05 search finds the peak;
  // this finds its middle. A stretch to 743 px from 63 rows is x11.79, and
  // the window lets every period from about 11.77 to 11.81 hit the same
  // edges, so the middle of that plateau is the honest answer, not its first
  // or last step.
  //
  // The plateau may run below MIN_PERIOD — a crisp x2 hits the same edges
  // from 1.97 to 2.03 — and clamping it there would pull its middle up to
  // 2.02. And when a whole number is on the plateau it wins outright: people
  // enlarge by whole numbers, and x2 is the answer the edges cannot tell
  // apart from x2.02 but the person who made the picture can.
  const tried: { q: number; hit: number }[] = [];
  const from = lo - PERIOD_STEP;
  for (let s = 0;; s++) {
    const q = Math.round((from + s * 0.01) * 100) / 100;
    if (q > hi + PERIOD_STEP + 1e-9) break;
    tried.push({ q, hit: ax.fit(q, reachX).hit + ay.fit(q, reachY).hit });
  }
  const top = Math.max(...tried.map((t) => t.hit));
  const whole = tried.find((t) => t.hit >= top - 1e-9 && Number.isInteger(t.q));
  // Never under MIN_PERIOD, though: a "pixel-art" region is one at x2 or more.
  const p = Math.max(
    MIN_PERIOD,
    whole?.q ?? middleOfBest(tried, (t) => t.hit).q,
  );
  return {
    scale: p,
    phaseX: centred(ax.fit(p, reachX).phase, p),
    phaseY: centred(ay.fit(p, reachY).phase, p),
  };
}

/**
 * The middle one of the entries that share the top score. Periods either
 * side of a true scale often hit exactly the same edges, and the first or
 * last of such a run is biased by a whole search step.
 */
function middleOfBest<T>(items: T[], score: (item: T) => number): T {
  const top = Math.max(...items.map(score));
  const best = items.filter((item) => score(item) >= top - 1e-9);
  return best[Math.floor((best.length - 1) / 2)];
}

/** A grid phase in [0, p) as the start of the first block at least half in frame. */
function centred(phase: number, p: number): number {
  return Math.round((phase > p / 2 ? phase - p : phase) * 100) / 100;
}

function edgeHistograms(
  raster: Raster,
  rect: Rect,
): { ex: Float64Array; ey: Float64Array } {
  const { width, data } = raster;
  const ex = new Float64Array(rect.w);
  const ey = new Float64Array(rect.h);
  const differs = (i: number, j: number) => {
    // Two invisible pixels are the same pixel, whatever RGB they carry.
    if (data[i + 3] < ALPHA_FLOOR && data[j + 3] < ALPHA_FLOOR) return false;
    return Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) +
        Math.abs(data[i + 2] - data[j + 2]) +
        Math.abs(data[i + 3] - data[j + 3]) > EDGE_THRESHOLD;
  };
  for (let y = 0; y < rect.h; y++) {
    const row = (rect.y + y) * width + rect.x;
    for (let x = 0; x < rect.w; x++) {
      const i = (row + x) * 4;
      if (x > 0 && differs(i - 4, i)) ex[x]++;
      if (y > 0 && differs(i - width * 4, i)) ey[y]++;
    }
  }
  return { ex, ey };
}

/** How far either side of a grid line an edge may sit and still count. */
type Reach = 0 | 1;

interface Fit {
  p: number;
  reach: Reach;
  phase: number;
  /** Fraction of the axis's edges within `reach` px of a grid line. */
  hit: number;
  /**
   * `hit` minus the fraction chance alone would give; −1 when the edges sit
   * on fewer than MIN_GRID_LINES lines, which is no grid at all.
   */
  excess: number;
}

/** One axis's edge histogram, and the grid fits scored against it. */
class Axis {
  readonly prefix: Float64Array;
  readonly total: number;
  readonly n: number;

  constructor(edges: Float64Array) {
    this.n = edges.length;
    this.prefix = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) {
      this.prefix[i + 1] = this.prefix[i] + edges[i];
    }
    this.total = this.prefix[this.n];
  }

  /**
   * The best phase for period p at a given reach — or, with no reach, at
   * whichever of the two scores higher above chance.
   */
  fit(p: number, reach?: Reach): Fit {
    if (reach === undefined) {
      const exact = this.fit(p, 0), loose = this.fit(p, 1);
      return exact.excess >= loose.excess ? exact : loose;
    }
    const { n, prefix, total } = this;
    const chance = Math.min(1, (2 * reach + 1) / p);
    if (!total) return { p, reach, phase: 0, hit: 0, excess: -1 };
    const phases: number[] = [];
    const hitsAt: number[] = [];
    const linesAt: number[] = [];
    for (let phase = 0; phase < p; phase += PHASE_STEP) {
      // k starts at −1 so a grid line just left of the picture still claims
      // the edges in its window that fall inside it; `last` keeps windows
      // from counting a position twice when p < 3 makes them overlap.
      let hits = 0, lines = 0, last = -1;
      for (let k = -1;; k++) {
        const c = Math.round(phase + k * p);
        if (c - reach >= n) break;
        const lo = Math.max(c - reach, last + 1, 0);
        const hi = Math.min(c + reach, n - 1);
        if (hi >= lo) {
          const sum = prefix[hi + 1] - prefix[lo];
          hits += sum;
          if (sum) lines++;
          last = hi;
        }
      }
      phases.push(phase);
      hitsAt.push(hits);
      linesAt.push(lines);
    }
    const most = Math.max(...hitsAt);
    // Any two edges sit on some grid — a plain box's left and right sides
    // are "periodic" at every divisor of its width — so a grid needs edges on
    // at least MIN_GRID_LINES of its lines before it is evidence of anything.
    let lines = 0;
    for (let i = 0; i < phases.length; i++) {
      if (hitsAt[i] === most) lines = Math.max(lines, linesAt[i]);
    }
    // Several phases tie whenever the window is wider than the rounding — a
    // crisp edge at 12 is within reach of every grid line that rounds to 11,
    // 12 or 13 — so take the circular mean of the tied ones (it wraps: at
    // p 12, phases 11.75 and 0.25 average to 0, not 6), which is where the
    // grid really sits.
    let sx = 0, sy = 0;
    for (let i = 0; i < phases.length; i++) {
      if (hitsAt[i] < most) continue;
      const angle = 2 * Math.PI * phases[i] / p;
      sx += Math.cos(angle);
      sy += Math.sin(angle);
    }
    let phase = Math.atan2(sy, sx) * p / (2 * Math.PI);
    if (phase < 0) phase += p;
    return {
      p,
      reach,
      phase: Math.round(phase * 100) / 100,
      hit: most / total,
      excess: lines < MIN_GRID_LINES ? -1 : most / total - chance,
    };
  }

  /**
   * The period this axis's edges sit on, or null when none beats chance by
   * ACCEPT_EXCESS. Of every period scoring within 90% of the best, the
   * LARGEST wins: a x12 grid also scores well at 6 and 4 (every 12th line is
   * a 6th line), and art drawn in 2x2 fat pixels at x6 really is x12. Periods
   * a step or two either side of a peak score nearly as well as the peak
   * itself, so "largest" is taken over peaks — each run of near-best periods
   * counts once, at the middle of its best hits — not over raw candidates,
   * which would always pick the peak's right shoulder (12.05 for an exact
   * 12, where the chance term shrinks a little faster than the hits do).
   */
  pick(): Fit | null {
    const maxP = Math.min(MAX_PERIOD, this.n / 2);
    const fits: Fit[] = [];
    for (let s = 0;; s++) {
      const p = Math.round((MIN_PERIOD + s * PERIOD_STEP) * 100) / 100;
      if (p > maxP) break;
      fits.push(this.fit(p));
    }
    if (!fits.length) return null;
    const best = Math.max(...fits.map((f) => f.excess));
    if (best < ACCEPT_EXCESS) return null;
    let chosen: Fit[] = [], run: Fit[] = [];
    for (const f of fits) {
      if (f.excess >= 0.9 * best) {
        run.push(f);
      } else if (run.length) {
        chosen = run;
        run = [];
      }
    }
    // Inside one run the hit fractions only compare at one reach.
    const peak = run.length ? run : chosen;
    const reach = peak.reduce((a, b) => b.excess > a.excess ? b : a).reach;
    return middleOfBest(peak.filter((f) => f.reach === reach), (f) => f.hit);
  }
}

// ─── cutting a frame ────────────────────────────────────────────────────────

/**
 * Cut, clean and size one frame, in this order:
 *
 *   1. the rectangle — a region, a crop, or the whole picture;
 *   2. cut it out;
 *   3. find its pixel scale, on the colour edges, while the background is
 *      still there to make them;
 *   4. lose the background — ink, flood-fill removal, or keep;
 *   5. undo the pixel scale by sampling each block's centre, which steps over
 *      the blended edges a smoothed enlargement leaves between blocks;
 *   6. shrink to maxSize;
 *   7–8. refuse anything too big for a frame once scale has had its way, or
 *      empty; then enlarge by scale.
 *
 * Every refusal is an UploadError the model reads, so each one says what to
 * send instead.
 */
export function cutUpload(
  uploads: UploadedImage[] | undefined,
  ref: UploadRef,
): CutFrame {
  if (!uploads?.length) {
    throw new UploadError(
      "No picture is attached to this request — {upload: n} only works " +
        "when the player attached one.",
    );
  }
  const n = ref.upload;
  const upload = Number.isInteger(n) ? uploads[n] : undefined;
  if (!upload) {
    throw new UploadError(
      `No picture ${JSON.stringify(n)} — this request has ${uploads.length} ` +
        `(upload ${
          uploads.length === 1 ? "0" : `0–${uploads.length - 1}`
        }). Name one of those.`,
    );
  }
  const { raster, analysis } = upload;
  const label = `Picture ${upload.index}`;

  // 1. The rectangle.
  if (ref.region != null && ref.crop != null) {
    throw new UploadError(
      `Pass region or crop, not both — region ${ref.region} already names a ` +
        "rectangle. Drop crop to use the region, or drop region to cut the " +
        "crop.",
    );
  }
  let rect: Rect = { x: 0, y: 0, w: raster.width, h: raster.height };
  let where = "";
  let what = label.toLowerCase();
  let stem = upload.name;
  if (ref.region != null) {
    const region = Number.isInteger(ref.region)
      ? analysis.regions[ref.region]
      : undefined;
    if (!region) {
      const have = analysis.regions.map((r) => r.index);
      throw new UploadError(
        have.length
          ? `${label} has ${have.length} region${
            have.length === 1 ? "" : "s"
          } (${have.join(", ")}); region ${
            JSON.stringify(ref.region)
          } is not one of them. Name one of those, or pass crop instead.`
          : `${label} has no regions — nothing stands out from its ` +
            "background. Leave region out to use the whole picture, or pass " +
            "crop.",
      );
    }
    rect = { x: region.x, y: region.y, w: region.w, h: region.h };
    where = `#region${region.index}`;
    what = `region ${region.index}`;
    stem = `${upload.name}_r${region.index}`;
  } else if (ref.crop != null) {
    const c = ref.crop;
    if (![c.x, c.y, c.w, c.h].every(Number.isFinite)) {
      throw new UploadError(
        "crop must be {x, y, w, h}, whole numbers in the picture's pixels.",
      );
    }
    const x0 = Math.max(0, Math.floor(c.x));
    const y0 = Math.max(0, Math.floor(c.y));
    const x1 = Math.min(raster.width, Math.floor(c.x + c.w));
    const y1 = Math.min(raster.height, Math.floor(c.y + c.h));
    if (x1 <= x0 || y1 <= y0) {
      throw new UploadError(
        `crop {x: ${c.x}, y: ${c.y}, w: ${c.w}, h: ${c.h}} holds none of ` +
          `${label.toLowerCase()} (${raster.width}×${raster.height} px) — ` +
          "pass a rectangle inside it with a positive w and h, or a region.",
      );
    }
    rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    where = `#crop ${rect.x},${rect.y},${rect.w},${rect.h}`;
    what = "the crop";
    stem = `${upload.name}_crop`;
  }

  // 2. Cut it out.
  let frame = cut(raster, rect);

  // 3. Pixel scale, on the colour edges while the background still makes them.
  const wanted = ref.pixelScale ?? "auto";
  let grid: PixelScale = { scale: 1, phaseX: 0, phaseY: 0 };
  if (wanted === "auto") {
    grid = detectPixelScale(frame);
  } else if (
    typeof wanted !== "number" || !Number.isFinite(wanted) || wanted < 1 ||
    wanted > 64
  ) {
    throw new UploadError(
      `pixelScale ${
        JSON.stringify(wanted)
      } is not one — pass "auto", 1 to keep every pixel, or the enlargement ` +
        "(2–64) the request reports for the region.",
    );
  } else if (wanted > 1) {
    grid = gridAt(frame, wanted);
  }

  // 4. The background.
  const bg = analysis.background;
  // Only the line-art conversion (ink over an opaque field) owns its alpha;
  // ink on transparency recolours and keeps the alpha the artist drew.
  const ink = ref.ink != null && bg != null && !bg.transparent;
  if (ref.ink != null) {
    const colour = parseInk(ref.ink);
    if (!bg) {
      throw new UploadError(
        `${label} has no plain background to lift the ink off — drop ink, ` +
          "or crop to a part of it on a plain field.",
      );
    }
    frame = inked(frame, bg, colour);
  } else if ((ref.background ?? "remove") === "remove") {
    if (bg && !bg.transparent) removeBackground(frame, bg);
  } else if (ref.background !== "keep") {
    throw new UploadError(
      `background ${
        JSON.stringify(ref.background)
      } is not one — pass "remove" (the default) or "keep".`,
    );
  }

  // 5. Back to the art's own pixels.
  if (grid.scale > 1) frame = unscale(frame, grid);

  // 6. maxSize.
  if (ref.maxSize != null) {
    const max = ref.maxSize;
    if (!Number.isFinite(max) || max < 1) {
      throw new UploadError(
        `maxSize ${
          JSON.stringify(max)
        } is not a size — pass the longest side in px (a shot is 8–48, a ` +
          "boss 48–128).",
      );
    }
    const before = frame;
    frame = shrinkToFit(frame, Math.floor(max));
    // Ink promises that the strongest stroke is fully opaque, and shrinking
    // breaks that promise: text is mostly paper, so a 694 px block of ASCII
    // art averaged down to a 48 px shot tops out near alpha 80 and reads as
    // a faint smudge on the starfield. Stretch the alpha again at the size
    // the game will draw, the same way the conversion did at full size.
    if (ink && frame !== before) stretchAlpha(frame);
  }

  // 7. scale — validated here, applied once the size is known to fit.
  if (
    ref.scale != null &&
    (!Number.isInteger(ref.scale) || ref.scale < 1 || ref.scale > 4)
  ) {
    throw new UploadError(
      `scale ${
        JSON.stringify(ref.scale)
      } is not one — pass a whole number 1–4, or leave it out.`,
    );
  }

  // 8. Refusals. The size is the one the frame WILL have after scale, checked
  // before scale enlarges anything: a whole 2000 px picture at scale 4 would
  // otherwise allocate a quarter of a gigabyte only to be refused.
  const by = ref.scale ?? 1;
  if (Math.max(frame.width, frame.height) * by > MAX_FRAME_SIDE) {
    throw new UploadError(
      `That frame is ${frame.width * by}×${frame.height * by} px; frames ` +
        `are at most ${MAX_FRAME_SIDE} — pass maxSize (a shot is 8–48 px, a ` +
        `boss 48–128)${by > 1 ? " or a smaller scale" : ""}.`,
    );
  }
  if (isEmpty(frame)) {
    throw new UploadError(
      `${what[0].toUpperCase()}${what.slice(1)}${
        what === "the crop" || what.startsWith("picture")
          ? ""
          : ` of ${label.toLowerCase()}`
      } came out empty — every pixel was background. Try background: ` +
        "'keep', or ink for text and line art.",
    );
  }

  if (by > 1) frame = enlarge(frame, by);

  return {
    name: safeName(ref.as ?? stem, "upload"),
    raster: frame,
    source: `upload:${upload.index}${where}`,
    scope: `upload${upload.index}`,
  };
}

/**
 * The grid for a scale the model named: its phase is still unknown, so score
 * just that one period on each axis. Cheap — one period instead of 761.
 */
function gridAt(raster: Raster, scale: number): PixelScale {
  const { ex, ey } = edgeHistograms(raster, {
    x: 0,
    y: 0,
    w: raster.width,
    h: raster.height,
  });
  return {
    scale,
    phaseX: centred(new Axis(ex).fit(scale).phase, scale),
    phaseY: centred(new Axis(ey).fit(scale).phase, scale),
  };
}

function parseInk(ink: string): [number, number, number] {
  const text = String(ink).trim().toLowerCase();
  if (INKS[text]) return INKS[text];
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) {
    return [1, 2, 3].map((i) => parseInt(short[i] + short[i], 16)) as [
      number,
      number,
      number,
    ];
  }
  const long = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(text);
  if (long) {
    return [1, 2, 3].map((i) => parseInt(long[i], 16)) as [
      number,
      number,
      number,
    ];
  }
  throw new UploadError(
    `ink ${JSON.stringify(ink)} is not a colour — pass a hex such as ` +
      `"#ffffff" or one of ${Object.keys(INKS).join(", ")}.`,
  );
}

/**
 * Line-art conversion: every pixel becomes the ink, as opaque as it was far
 * from the background. The farthest pixel in the cut is fully opaque and the
 * rest scale to it, so anti-aliased strokes keep their soft edges and a grey
 * pencil scan comes out as solid as a black marker. This is how dark text on
 * white paper becomes white text that shows on the game's dark starfield. On
 * a transparent background there is nothing to measure against, so the ink
 * only recolours and the alpha stays as drawn.
 */
function inked(
  src: Raster,
  bg: Background,
  [r, g, b]: [number, number, number],
): Raster {
  const out = newRaster(src.width, src.height);
  const n = src.width * src.height;
  const d = src.data;
  if (bg.transparent) {
    for (let i = 0; i < n * 4; i += 4) {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = d[i + 3];
    }
    return out;
  }
  const contrast = new Float64Array(n);
  let most = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const c = Math.max(
      Math.abs(d[i] - bg.r),
      Math.abs(d[i + 1] - bg.g),
      Math.abs(d[i + 2] - bg.b),
    ) * d[i + 3] / 255;
    contrast[p] = c;
    if (c > most) most = c;
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = most ? Math.round(255 * contrast[p] / most) : 0;
  }
  return out;
}

/**
 * Flood the background away from the cut's border, 4-connected, through
 * pixels within BG_TOLERANCE of it. A flood rather than a colour key because a
 * sprite's own highlights are often exactly the paper's white — the glint on a
 * fist, the whites of the eyes — and a key would punch holes through them;
 * the flood only reaches background that touches the outside.
 */
function removeBackground(raster: Raster, bg: Background): void {
  const { width, height, data } = raster;
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const matches = (p: number) => {
    const i = p * 4;
    return data[i + 3] < ALPHA_FLOOR ||
      Math.max(
          Math.abs(data[i] - bg.r),
          Math.abs(data[i + 1] - bg.g),
          Math.abs(data[i + 2] - bg.b),
        ) <= BG_TOLERANCE;
  };
  const push = (p: number) => {
    if (seen[p] || !matches(p)) return;
    seen[p] = 1;
    stack[top++] = p;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top) {
    const p = stack[--top];
    data[p * 4 + 3] = 0;
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < n - width) push(p + width);
  }
}

/** One pixel per block, read from the block's centre. */
function unscale(src: Raster, { scale, phaseX, phaseY }: PixelScale): Raster {
  const w = Math.max(1, Math.round((src.width - phaseX) / scale));
  const h = Math.max(1, Math.round((src.height - phaseY) / scale));
  const out = newRaster(w, h);
  const at = (phase: number, i: number, size: number) =>
    Math.min(size - 1, Math.max(0, Math.floor(phase + (i + 0.5) * scale)));
  for (let y = 0; y < h; y++) {
    const sy = at(phaseY, y, src.height);
    for (let x = 0; x < w; x++) {
      const s = (sy * src.width + at(phaseX, x, src.width)) * 4;
      out.data.set(src.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return out;
}

/**
 * Area-average down so the longest side is `max`, by any factor. Averages in
 * premultiplied alpha, as harbor's downscale does, so the transparent field
 * the background removal left cannot darken the subject's edge pixels. Never
 * enlarges.
 */
function shrinkToFit(src: Raster, max: number): Raster {
  const longest = Math.max(src.width, src.height);
  if (longest <= max) return src;
  const factor = longest / max;
  const w = Math.max(1, Math.min(max, Math.round(src.width / factor)));
  const h = Math.max(1, Math.min(max, Math.round(src.height / factor)));
  const spans = (from: number, to: number) => {
    const out: [number, number][][] = [];
    const step = from / to;
    for (let o = 0; o < to; o++) {
      const a = o * step, b = (o + 1) * step;
      const cells: [number, number][] = [];
      for (let i = Math.floor(a); i < Math.min(from, Math.ceil(b)); i++) {
        const weight = Math.min(b, i + 1) - Math.max(a, i);
        if (weight > 0) cells.push([i, weight]);
      }
      out.push(cells);
    }
    return out;
  };
  const xs = spans(src.width, w), ys = spans(src.height, h);
  const out = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (const [sy, wy] of ys[y]) {
        for (const [sx, wx] of xs[x]) {
          const weight = wx * wy;
          const s = (sy * src.width + sx) * 4;
          const alpha = src.data[s + 3] * weight;
          r += src.data[s] * alpha;
          g += src.data[s + 1] * alpha;
          b += src.data[s + 2] * alpha;
          a += alpha;
          area += weight;
        }
      }
      const d = (y * w + x) * 4;
      if (a > 0) {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
        out.data[d + 3] = Math.round(a / area);
      }
    }
  }
  return out;
}

function enlarge(src: Raster, by: number): Raster {
  const out = newRaster(src.width * by, src.height * by);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / by);
    for (let x = 0; x < out.width; x++) {
      const s = (sy * src.width + Math.floor(x / by)) * 4;
      out.data.set(src.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** Scale alpha so the most opaque pixel is fully opaque. */
function stretchAlpha(raster: Raster): void {
  let most = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] > most) most = raster.data[i];
  }
  if (!most || most === 255) return;
  for (let i = 3; i < raster.data.length; i += 4) {
    raster.data[i] = Math.round(raster.data[i] * 255 / most);
  }
}

function isEmpty(raster: Raster): boolean {
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i]) return false;
  }
  return true;
}

// ─── telling the model ──────────────────────────────────────────────────────

/**
 * The lines the first user message carries about the pictures, e.g.
 *
 *   Picture 0 "ryuda": 1400×743 px, background #ffffff.
 *     region 0: x 0 y 0, 684×743 — pixel art at ×11.8 (58×63 native)
 *     region 1: x 705 y 4, 694×737 — monochrome, dark on light (text or line art)
 *
 * The model can see the pictures, but it cannot measure them: these lines are
 * what lets it write {upload: 0, region: 1} with confidence, and the region
 * order is the order "left" and "right" mean.
 */
export function describeUploads(uploads: UploadedImage[]): string {
  const lines: string[] = [];
  for (const upload of uploads) {
    const { width, height, background, regions } = upload.analysis;
    const field = background == null
      ? "no plain background (a photo or a full scene) — one region, the whole picture"
      : background.transparent
      ? "transparent background"
      : `background ${background.hex}`;
    lines.push(
      `Picture ${upload.index} "${upload.name}": ${width}×${height} px, ${field}.`,
    );
    if (!regions.length) {
      lines.push(
        "  nothing stands out from the background — use crop to pick a part",
      );
    }
    for (const r of regions) {
      lines.push(
        `  region ${r.index}: x ${r.x} y ${r.y}, ${r.w}×${r.h} — ${
          looks(r, background)
        }`,
      );
    }
  }
  return lines.join("\n");
}

function looks(
  r: UploadRegion,
  background: UploadAnalysis["background"],
): string {
  if (r.kind === "pixel-art") {
    return `pixel art at ×${r.pixelScale} (${r.native.w}×${r.native.h} native)`;
  }
  const paper = background && !background.transparent
    ? r.darkOnLight ? ", dark on light" : ", light on dark"
    : "";
  return r.kind === "monochrome"
    ? `monochrome${paper} (text or line art)`
    : `colour image${paper}`;
}
