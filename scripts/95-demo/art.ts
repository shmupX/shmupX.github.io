/**
 * EVIL INVADERS '95's art, cut out of its sheets and drawn at the size the
 * source shows it, on shmupX's 256x480 field.
 *
 * The source draws every sprite at a display scale on a 540-wide field (an
 * eye-dude is its 48x36 frame at x0.8). The cloud game keeps those
 * proportions: each frame is resampled to (frame x drawScale x 256/540), so a
 * formation of them spans the same fraction of the screen it does in the
 * source. Shrinking averages the covered source pixels; sprites keep a hard
 * edge (alpha thresholded, as pixel art is drawn) and the fire effects keep
 * their glow. Growing (the boss's death poof is a 16x15 frame drawn x9) is
 * nearest-neighbour.
 *
 * The title art is new: the source's title is text in Press Start 2P, which
 * the CLI has no rasteriser for, so it is set in the repo's own 8x8 arcade
 * face (Dezaemon 2's, packages/shmup-harbor/lib/bitmap-font.ts) in the
 * source's colours.
 */

import { decodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import { loadAthenaFont, renderText } from "@shmupx/shmup-harbor/bitmap-font";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { GAME_WIDTH, type SheetArt } from "./source.ts";
import { seededRandom } from "./replay.ts";

/** The source's art, as copied into this directory. */
export const ART_DIR = new URL("./art/", import.meta.url);

/** Source field px to shmupX field px. */
export const FIELD_SCALE = 256 / GAME_WIDTH;

export async function loadArt(file: string): Promise<Raster> {
  return await decodePng(await Deno.readFile(new URL(file, ART_DIR)));
}

/** Frame `index` of a grid sheet, left to right, top to bottom. */
export function gridFrame(
  sheet: Raster,
  art: SheetArt,
  index: number,
): Raster {
  const cols = Math.floor(sheet.width / art.frameW);
  const x = (index % cols) * art.frameW;
  const y = Math.floor(index / cols) * art.frameH;
  return cut(sheet, { x, y, w: art.frameW, h: art.frameH });
}

interface PackedFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
}

/**
 * A frame of a TexturePacker atlas, back at its untrimmed source size. Reads
 * both the hash layout (`frames: {name: …}`) and the multiatlas one
 * (`textures[].frames[]` with `filename`).
 */
export async function atlasFrame(
  pngFile: string,
  jsonFile: string,
  name: string,
): Promise<Raster> {
  const sheet = await loadArt(pngFile);
  const json = JSON.parse(
    await Deno.readTextFile(new URL(jsonFile, ART_DIR)),
  );
  let entry: PackedFrame | undefined;
  if (json.frames && !Array.isArray(json.frames)) entry = json.frames[name];
  for (const tex of json.textures ?? []) {
    const hit = (tex.frames as (PackedFrame & { filename: string })[])
      .find((f) => f.filename === name);
    if (hit) entry = hit;
  }
  if (!entry) throw new Error(`${jsonFile} has no frame ${name}`);
  const { frame } = entry;
  const src = entry.sourceSize ?? { w: frame.w, h: frame.h };
  const off = entry.spriteSourceSize ?? { x: 0, y: 0 };
  const out = newRaster(src.w, src.h);
  blit(out, cut(sheet, frame), off.x, off.y);
  return out;
}

/**
 * `src` resampled to w x h. Shrinking averages the source area each output
 * pixel covers (colour weighted by alpha, so clear pixels add no colour);
 * `hardEdge` then snaps alpha to opaque or clear, the way pixel art draws.
 * Growing is nearest-neighbour.
 */
export function resample(
  src: Raster,
  w: number,
  h: number,
  hardEdge: boolean,
): Raster {
  const out = newRaster(w, h);
  const sx = src.width / w;
  const sy = src.height / h;
  if (sx <= 1 && sy <= 1) {
    for (let y = 0; y < h; y++) {
      const yy = Math.min(src.height - 1, Math.floor((y + 0.5) * sy));
      for (let x = 0; x < w; x++) {
        const xx = Math.min(src.width - 1, Math.floor((x + 0.5) * sx));
        const s = (yy * src.width + xx) * 4;
        const d = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0 || yy >= src.height) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0 || xx >= src.width) continue;
          const wgt = wx * wy;
          const s = (yy * src.width + xx) * 4;
          const al = src.data[s + 3] / 255;
          r += src.data[s] * al * wgt;
          g += src.data[s + 1] * al * wgt;
          b += src.data[s + 2] * al * wgt;
          a += al * wgt;
          area += wgt;
        }
      }
      const d = (y * w + x) * 4;
      const alpha = area > 0 ? a / area : 0;
      if (a <= 0 || (hardEdge && alpha < 0.5)) continue;
      out.data[d] = Math.round(r / a);
      out.data[d + 1] = Math.round(g / a);
      out.data[d + 2] = Math.round(b / a);
      out.data[d + 3] = hardEdge ? 255 : Math.round(alpha * 255);
    }
  }
  return out;
}

/** A frame drawn at `drawScale` on the source field, on the shmupX field. */
export function toFieldArt(
  src: Raster,
  drawScale: number,
  hardEdge: boolean,
): Raster {
  const k = drawScale * FIELD_SCALE;
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  return resample(src, w, h, hardEdge);
}

/** Several frames side by side on one canvas, each at its own offset. */
export function composite(
  w: number,
  h: number,
  parts: { art: Raster; x: number; y: number }[],
): Raster {
  const out = newRaster(w, h);
  for (const p of parts) {
    // alpha-over, so overlapping wings stack instead of punching holes
    for (let y = 0; y < p.art.height; y++) {
      for (let x = 0; x < p.art.width; x++) {
        const s = (y * p.art.width + x) * 4;
        const al = p.art.data[s + 3];
        if (!al) continue;
        const dx = p.x + x, dy = p.y + y;
        if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
        const d = (dy * w + dx) * 4;
        const k = al / 255;
        for (let c = 0; c < 3; c++) {
          out.data[d + c] = Math.round(
            p.art.data[s + c] * k + out.data[d + c] * (1 - k),
          );
        }
        out.data[d + 3] = Math.max(out.data[d + 3], al);
      }
    }
  }
  return out;
}

// --- the title --------------------------------------------------------------

type Rgb = [number, number, number];

const hex = (v: number): Rgb => [(v >> 16) & 255, (v >> 8) & 255, v & 255];

/** The source title's colours (src/UI.svelte). */
export const TITLE_COLOURS = {
  red: hex(0xff4444),
  yellow: hex(0xffee44),
  blue: hex(0x8888ff),
  white: hex(0xffffff),
};

/** Source starfield tints (src/Starfield.svelte). */
const STAR_TINTS = [0x72747d, 0x3c3e45, 0xe5e7f0, 0xafb1b8, 0x630dd0];

/** `text` in the 8x8 face, blown up `scale` times, with a 1 px drop shadow. */
async function textArt(text: string, colour: Rgb, scale: number) {
  const font = await loadAthenaFont(repoRoot());
  const w = text.length * font.glyphW + 1;
  const h = font.glyphH + 1;
  const small = renderText(font, text, w, h, {
    colour,
    align: "left",
    shadow: true,
  });
  return resample(small, w * scale, h * scale, true);
}

/** The logo plate (256x88): EVIL INVADERS in red over a yellow '95. */
export async function logoArt(): Promise<Raster> {
  const top = await textArt("EVIL INVADERS", TITLE_COLOURS.red, 2);
  const year = await textArt("'95", TITLE_COLOURS.yellow, 3);
  const out = newRaster(256, 88);
  const gap = 6;
  const y0 = Math.floor((88 - (top.height + gap + year.height)) / 2);
  blit(out, top, Math.floor((256 - top.width) / 2), y0);
  blit(
    out,
    year,
    Math.floor((256 - year.width) / 2),
    y0 + top.height + gap,
  );
  return out;
}

/** The subtitle plate (256x28): the source title's tag line, two lines. */
export async function subTitleArt(): Promise<Raster> {
  const a = await textArt("INVADERS x GALAGA", TITLE_COLOURS.blue, 1);
  const b = await textArt("2P COUCH SHOOTER", TITLE_COLOURS.blue, 1);
  const out = newRaster(256, 28);
  const y0 = Math.floor((28 - (a.height + 2 + b.height)) / 2);
  blit(out, a, Math.floor((256 - a.width) / 2), y0);
  blit(out, b, Math.floor((256 - b.width) / 2), y0 + a.height + 2);
  return out;
}

/** The start prompt (256x16), white as the source's. */
export async function startTextArt(): Promise<Raster> {
  const t = await textArt("TAP OR PRESS START", TITLE_COLOURS.white, 1);
  const out = newRaster(256, 16);
  blit(
    out,
    t,
    Math.floor((256 - t.width) / 2),
    Math.floor((16 - t.height) / 2),
  );
  return out;
}

/**
 * The title backdrop: the source's starfield, black with stars in its five
 * tints. The title scrolls it sideways as a tile, so no star straddles the
 * edge.
 */
export function titleBackdropArt(w = 512, h = 480): Raster {
  const out = newRaster(w, h);
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 255;
  const rand = seededRandom(0x95);
  for (let i = 0; i < 260; i++) {
    const size = rand() < 0.15 ? 2 : 1;
    const x = Math.floor(rand() * (w - size));
    const y = Math.floor(rand() * (h - size));
    const [r, g, b] = hex(STAR_TINTS[Math.floor(rand() * STAR_TINTS.length)]);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const d = ((y + dy) * w + x + dx) * 4;
        out.data[d] = r;
        out.data[d + 1] = g;
        out.data[d + 2] = b;
      }
    }
  }
  return out;
}
