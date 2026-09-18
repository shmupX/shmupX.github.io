// Pixel arithmetic for the object tools: recolour a frame, resample it, and
// hand it back as the bare base64 PNG the watch draws.
//
// Nothing here knows about characters or atlases — a function takes a Raster
// and returns one — so every rule below is testable with a literal. The two
// transforms are the ones a spoken edit asks for: "make it red" is a hue move
// that leaves the shading alone, and "bulkier" is a nearest-neighbour
// resample, because a box filter on pixel art only smears it.

import { encodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";
import { resizeTo } from "@shmupx/shmup-harbor/raster";

export class PixelError extends Error {
  override name = "PixelError";
}

/**
 * One palette edit. Every field is optional and they compose in this order:
 * hue rotation, then the pull toward a colour, then saturation, then
 * lightness. Pixels with alpha 0 are never touched, so the transparent field a
 * sprite sits on stays transparent black.
 */
export interface PaletteEdit {
  /** Degrees to rotate every hue by. 120 turns red into green. */
  hue?: number;
  /** -1..1. -1 is greyscale, +1 doubles saturation (clamped). */
  saturation?: number;
  /** -1..1. -1 is black, +1 is white; 0.3 lifts every tone 30% of the way. */
  lightness?: number;
  /** A colour to pull every hue toward: "#f00", "#00ff00", "red", "blue"... */
  toward?: string;
  /** 0..1, how far toward it (default 1). Only meaningful with `toward`. */
  amount?: number;
}

/**
 * The names a spoken colour arrives as. Small on purpose: an agent that wants
 * a precise colour passes hex, and a list this size is one a test can hold.
 */
export const COLOR_NAMES: Record<string, string> = {
  red: "#ff0000",
  orange: "#ff8000",
  yellow: "#ffff00",
  lime: "#80ff00",
  green: "#00c000",
  teal: "#008080",
  cyan: "#00ffff",
  blue: "#0000ff",
  navy: "#000080",
  purple: "#8000ff",
  violet: "#8000ff",
  magenta: "#ff00ff",
  pink: "#ff80c0",
  brown: "#8b4513",
  gold: "#ffd700",
  white: "#ffffff",
  black: "#000000",
  grey: "#808080",
  gray: "#808080",
  silver: "#c0c0c0",
};

/** "#rgb", "#rrggbb" or a name from COLOR_NAMES, as [r, g, b] in 0..255. */
export function parseColor(spec: string): [number, number, number] {
  const trimmed = spec.trim().toLowerCase();
  const named = COLOR_NAMES[trimmed];
  const hex = (named ?? trimmed).replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  throw new PixelError(
    `Unknown colour ${JSON.stringify(spec)}. Use #rgb, #rrggbb, or one of: ${
      Object.keys(COLOR_NAMES).join(", ")
    }.`,
  );
}

/** RGB in 0..255 to [hue in degrees 0..360, saturation 0..1, lightness 0..1]. */
export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rf) h = ((gf - bf) / d) % 6;
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** The inverse of rgbToHsl, rounded back to bytes. */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const byte = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return [byte(r), byte(g), byte(b)];
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Move `from` toward `to` around the hue circle by `t` of the shortest arc. */
export function lerpHue(from: number, to: number, t: number): number {
  let delta = ((to - from) % 360 + 540) % 360 - 180;
  if (delta === -180) delta = 180;
  return ((from + delta * t) % 360 + 360) % 360;
}

/** Is there anything in this edit that would change a pixel? */
export function paletteEditIsEmpty(edit: PaletteEdit): boolean {
  return !edit.hue && !edit.saturation && !edit.lightness && !edit.toward;
}

/**
 * Apply a palette edit to every opaque pixel, returning a new raster.
 *
 * Hue and saturation are edited and lightness is kept, so the shading an
 * artist drew survives a recolour: a black outline stays black, a white
 * highlight stays white, and the mid-tones between them change colour rather
 * than flattening to one. `toward` pulls each pixel's hue along the shortest
 * arc to the target's, and lifts saturation toward the target's too, so a grey
 * sprite told to be red actually turns red instead of staying grey with an
 * invisible hue.
 */
export function recolor(src: Raster, edit: PaletteEdit): Raster {
  const out = newRaster(src.width, src.height);
  out.data.set(src.data);
  if (paletteEditIsEmpty(edit)) return out;

  const target = edit.toward ? parseColor(edit.toward) : null;
  const targetHsl = target ? rgbToHsl(...target) : null;
  const amount = clamp(edit.amount ?? 1, 0, 1);
  const hue = edit.hue ?? 0;
  const saturation = clamp(edit.saturation ?? 0, -1, 1);
  const lightness = clamp(edit.lightness ?? 0, -1, 1);

  // A grey, white or black target has no hue to travel to — rgbToHsl answers
  // hue 0 for it, which is red — so it is a saturation move instead.
  const achromatic = targetHsl !== null && targetHsl[1] < 0.02;

  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    let [h, s, l] = rgbToHsl(out.data[i], out.data[i + 1], out.data[i + 2]);
    if (hue) h = ((h + hue) % 360 + 360) % 360;
    if (targetHsl) {
      if (achromatic) {
        // Toward grey drains the colour; toward white or black also moves
        // the tone part of the way, so the shading is kept rather than
        // flattened into one flat field.
        s = s * (1 - amount);
        l = l + (targetHsl[2] - l) * amount * 0.5;
      } else {
        // A grey pixel has no hue of its own to move from, so it takes the
        // target's outright; a coloured one travels the arc.
        h = s < 0.02 ? targetHsl[0] : lerpHue(h, targetHsl[0], amount);
        s = s + (Math.max(s, targetHsl[1]) - s) * amount;
      }
    }
    if (saturation) s = clamp(s * (1 + saturation), 0, 1);
    if (lightness > 0) l = l + (1 - l) * lightness;
    else if (lightness < 0) l = l * (1 + lightness);
    const [r, g, b] = hslToRgb(h, s, l);
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
  }
  return out;
}

/**
 * Resample by `factor` with nearest-neighbour sampling. Dimensions round to
 * the nearest pixel and never fall below 1, so a 64x64 frame at 1.5 is 96x96
 * and a 16x16 one at 0.5 is 8x8.
 */
export function scaleNearest(src: Raster, factor: number): Raster {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new PixelError(`Scale factor must be positive, got ${factor}.`);
  }
  if (factor === 1) {
    const copy = newRaster(src.width, src.height);
    copy.data.set(src.data);
    return copy;
  }
  const w = Math.max(1, Math.round(src.width * factor));
  const h = Math.max(1, Math.round(src.height * factor));
  return resizeTo(src, w, h);
}

/**
 * The most common opaque colours in a raster, as "#rrggbb", most common first.
 * What an agent needs to answer "what colour is it" before changing it.
 * Pixels under half alpha — anti-aliased fringes, a shadow's halo — are not
 * what a sprite looks like and are left out of the count.
 */
export function dominantColors(src: Raster, count = 5): string[] {
  const tally = new Map<number, number>();
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] < 128) continue;
    const key = (src.data[i] << 16) | (src.data[i + 1] << 8) | src.data[i + 2];
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, count)
    .map(([key]) => `#${key.toString(16).padStart(6, "0")}`);
}

/**
 * A raster as bare base64 PNG — no `data:` prefix, which is the shape the
 * watch's PreviewFrame carries and its SpriteCanvas decodes.
 */
export async function pngBase64(raster: Raster): Promise<string> {
  const png = await encodePng(raster);
  let binary = "";
  for (let i = 0; i < png.length; i++) binary += String.fromCharCode(png[i]);
  return btoa(binary);
}
