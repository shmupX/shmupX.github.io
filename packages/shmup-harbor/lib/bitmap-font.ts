// Text drawn with Dezaemon 2's own 8x8 face, for art baked into a cart.
//
// The CLI has no canvas, so story text cannot be typeset the way the editor
// does it. What the repo does have is `athenaFont.png` — font 0 of the disc's
// GFONT.BIN, the face the Saturn kernel draws SCORE and PAUSE! in, lifted by
// `deza:disc` — as a single row of 95 glyphs, 8x8 each, in Phaser's
// RetroFont.TEXT_SET1 order. That is ASCII 32 through 126, so a glyph's index
// is its code point minus 32, and a cart's story ends up set in the cart's
// own lettering.
//
// The glyphs are used as a MASK: only their alpha is read, and the colour is
// the caller's, so the same face can be drawn in any ink over any picture.
//
// The typesetting itself is the engine's (src/story/bitmap-font.js), because
// the level editor sets a cart's story in the page with the very same face;
// this file reads the sheet off disk and gives the engine's functions types.

import { decodePng, type Raster } from "./ps2/png.ts";
import * as face from "@shmupx/shmup-engine/bitmap-font";

/** Where the face lives, relative to the repo root. */
export const ATHENA_FONT_PATH =
  "static/games/2028-ai/assets/fonts/athenaFont.png";

export interface BitmapFont {
  glyphW: number;
  glyphH: number;
  /** Alpha mask per glyph, indexed by code point minus 32. */
  glyphs: Uint8Array[];
}

export interface TextOptions {
  /** Ink, default white. */
  colour?: [number, number, number];
  /** "left" | "centre", default centre — a story caption reads centred. */
  align?: "left" | "centre";
  /** Pixels between baselines, default the glyph height plus one. */
  lineGap?: number;
  /** Drop shadow one pixel down-right, so light text survives a light picture. */
  shadow?: boolean;
}

/**
 * The face as glyph masks. Any pixel with alpha counts as ink, which is what
 * lets the sheet be recoloured; the sheet itself is white on transparent.
 */
export async function loadBitmapFont(
  path: string,
  glyphW = 8,
  glyphH = 8,
): Promise<BitmapFont> {
  const sheet = await decodePng(await Deno.readFile(path));
  try {
    return face.bitmapFontFromSheet(sheet, glyphW, glyphH);
  } catch (e) {
    throw new Error(`${(e as Error).message} (${path})`);
  }
}

/** The Dezaemon face, from a repo root. */
export function loadAthenaFont(root: string): Promise<BitmapFont> {
  return loadBitmapFont(`${root}/${ATHENA_FONT_PATH}`);
}

/**
 * `text` broken to `cols` characters a line, honouring the newlines the
 * author typed and breaking on spaces where it can. A word longer than the
 * line is cut rather than allowed to overrun.
 */
export const wrapText: (text: string, cols: number) => string[] = face.wrapText;

/**
 * `text` with the typographic characters an editor inserts silently (curly
 * quotes, dashes, an ellipsis) folded to the ASCII the sheet can draw.
 */
export const foldToAscii: (text: string) => string = face.foldToAscii;

/**
 * `text` drawn into a `w` x `h` raster, wrapped and vertically centred; lines
 * that do not fit the height are dropped from the bottom.
 */
export const renderText: (
  font: BitmapFont,
  text: string,
  w: number,
  h: number,
  opts?: TextOptions,
) => Raster = face.renderText;
