/**
 * Evil Invaders' art, cut out of its sheets and drawn at the size the source
 * shows it, on shmupX's 256x480 field.
 *
 * The source draws every sprite at a display scale on a 360-wide field (the
 * big Bowser is its 272x196 frame at x0.5). The cloud game keeps those
 * proportions: each frame is resampled to (frame x drawScale x 256/360), so
 * a sprite spans the same fraction of the screen it does in the source —
 * and the source is a mobile game, so some of them span a lot of it.
 * Shrinking averages the covered source pixels and keeps a hard edge, as
 * pixel art is drawn (the fire and the blast keep their glow); growing is
 * nearest-neighbour, the way Phaser draws an unsmoothed sprite scaled up.
 * The resampler, the tint and the compositor are 95-demo's (art.ts there):
 * EVIL INVADERS '95 is this game's descendant and its art is cut the same
 * way.
 *
 * The title art is new: the source has no title screen at all (it boots
 * straight into level 1), so one is set in the repo's 8x8 arcade face
 * (Dezaemon 2's, packages/shmup-harbor/lib/bitmap-font.ts), over the
 * source's starfield.
 */

import { decodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import { loadAthenaFont, renderText } from "@shmupx/shmup-harbor/bitmap-font";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { composite, resample, tinted } from "../95-demo/art.ts";
import { seededRandom } from "../95-demo/replay.ts";
import { GAME_WIDTH, type SheetArt, STAR_TINTS } from "./source.ts";

export { composite, resample, tinted };

/** The source's art, as copied into this directory. */
export const ART_DIR = new URL("./art/", import.meta.url);

/** Source field px to shmupX field px. */
export const FIELD_SCALE = 256 / GAME_WIDTH;

export async function loadArt(file: string): Promise<Raster> {
  return await decodePng(await Deno.readFile(new URL(file, ART_DIR)));
}

/**
 * Frame `index` of a grid sheet, left to right, top to bottom, as
 * Phaser.AnimationParser.spriteSheet cuts it: the first frame `margin` px
 * in, the next one frame along, and a new row once a frame would overhang
 * the right edge. A frame that overhangs the bottom (Bowser's, one pixel)
 * reads as transparent there, as the canvas draws it.
 */
export function gridFrame(
  sheet: Raster,
  art: SheetArt,
  index: number,
): Raster {
  const margin = art.margin ?? 0;
  let x = margin, y = margin;
  for (let i = 0; i < index; i++) {
    x += art.frameW;
    if (x + art.frameW > sheet.width) {
      x = margin;
      y += art.frameH;
    }
  }
  return cut(sheet, { x, y, w: art.frameW, h: art.frameH });
}

interface PackedFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
}

/** A frame of a TexturePacker hash atlas (`frames: {name: …}`), at its source size. */
export async function atlasFrame(
  pngFile: string,
  jsonFile: string,
  name: string,
): Promise<Raster> {
  const sheet = await loadArt(pngFile);
  const json = JSON.parse(await Deno.readTextFile(new URL(jsonFile, ART_DIR)));
  const entry: PackedFrame | undefined = json.frames?.[name];
  if (!entry) throw new Error(`${jsonFile} has no frame ${name}`);
  const { frame } = entry;
  const src = entry.sourceSize ?? { w: frame.w, h: frame.h };
  const off = entry.spriteSourceSize ?? { x: 0, y: 0 };
  const out = newRaster(src.w, src.h);
  blit(out, cut(sheet, frame), off.x, off.y);
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

/** `src` mirrored left to right, as a sprite at scale.x -1 is drawn. */
export function flipX(src: Raster): Raster {
  const out = newRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const d = (y * src.width + (src.width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
    }
  }
  return out;
}

// --- the title and the backdrop ---------------------------------------------

type Rgb = [number, number, number];

const hex = (v: number): Rgb => [(v >> 16) & 255, (v >> 8) & 255, v & 255];

/**
 * The title's colours: the red EVIL INVADERS '95 sets its logo in, Peach's
 * pink from the source's own rainbow tints, and white.
 */
export const TITLE_COLOURS = {
  red: hex(0xff4444),
  pink: hex(0xf69ef7),
  white: hex(0xffffff),
};

/** `text` in the 8x8 face, blown up `scale` times, with a 1 px drop shadow. */
export async function textArt(
  text: string,
  colour: Rgb,
  scale: number,
): Promise<Raster> {
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

/** `art` centred on a w x h plate. */
function plate(w: number, h: number, parts: Raster[], gap: number): Raster {
  const out = newRaster(w, h);
  const total = parts.reduce((s, p) => s + p.height, 0) +
    gap * (parts.length - 1);
  let y = Math.floor((h - total) / 2);
  for (const p of parts) {
    blit(out, p, Math.floor((w - p.width) / 2), y);
    y += p.height + gap;
  }
  return out;
}

/** The logo plate (256x88): EVIL INVADERS in red. */
export async function logoArt(): Promise<Raster> {
  return plate(
    256,
    88,
    [await textArt("EVIL INVADERS", TITLE_COLOURS.red, 2)],
    0,
  );
}

/** The subtitle plate (256x28): who fights whom, two lines in Peach's pink. */
export async function subTitleArt(): Promise<Raster> {
  return plate(256, 28, [
    await textArt("PEACH VS BOWSER", TITLE_COLOURS.pink, 1),
    await textArt("AND THE INVADERS", TITLE_COLOURS.pink, 1),
  ], 2);
}

/** The start prompt (256x16), white. */
export async function startTextArt(): Promise<Raster> {
  return plate(
    256,
    16,
    [await textArt("PRESS START", TITLE_COLOURS.white, 1)],
    0,
  );
}

/**
 * The source's starfield as a picture: black, with stars of one to three
 * pixels in its five tints, about as many to the screen as its emitter
 * keeps up. `seed` fixes where they fall, so a conversion repeats; no star
 * straddles an edge, so the picture tiles.
 */
export function starfieldArt(
  w: number,
  h: number,
  stars: number,
  seed: number,
): Raster {
  const out = newRaster(w, h);
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 255;
  const rand = seededRandom(seed);
  for (let i = 0; i < stars; i++) {
    const roll = rand();
    const size = roll < 0.1 ? 3 : roll < 0.4 ? 2 : 1;
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

/** The title backdrop, 512x480: the title scrolls it sideways as a tile. */
export function titleBackdropArt(w = 512, h = 480): Raster {
  return starfieldArt(w, h, 110, 0xe71);
}

/**
 * The stage backdrop, 256x256: the runtime scrolls it down the field as a
 * tile, the way the source's stars fall. Its stars are the emitter's share
 * of a screen — one every 50 ms for 1.8 s at 150-250 px/s works out at
 * about 36 on the source's 360x640 — on this tile's area.
 */
export function stageBackdropArt(w = 256, h = 256): Raster {
  return starfieldArt(w, h, 24, 0xe72);
}
