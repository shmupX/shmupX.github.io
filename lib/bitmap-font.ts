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

import { decodePng, newRaster, type Raster } from "./ps2/png.ts";

/** Where the face lives, relative to the repo root. */
export const ATHENA_FONT_PATH =
  "static/games/2028-ai/assets/fonts/athenaFont.png";

/** The first code point the sheet carries. TEXT_SET1 starts at a space. */
const FIRST_CODE = 32;

export interface BitmapFont {
  glyphW: number;
  glyphH: number;
  /** Alpha mask per glyph, indexed by code point minus FIRST_CODE. */
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
  if (sheet.height < glyphH) {
    throw new Error(
      `font ${path}: ${sheet.height} rows cannot hold a ${glyphH}px glyph`,
    );
  }
  const count = Math.floor(sheet.width / glyphW);
  const glyphs: Uint8Array[] = [];
  for (let g = 0; g < count; g++) {
    const mask = new Uint8Array(glyphW * glyphH);
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < glyphW; x++) {
        const s = (y * sheet.width + g * glyphW + x) * 4;
        mask[y * glyphW + x] = sheet.data[s + 3] ? 1 : 0;
      }
    }
    glyphs.push(mask);
  }
  return { glyphW, glyphH, glyphs };
}

/** The Dezaemon face, from a repo root. */
export function loadAthenaFont(root: string): Promise<BitmapFont> {
  return loadBitmapFont(`${root}/${ATHENA_FONT_PATH}`);
}

/**
 * `text` broken to `cols` characters a line, honouring the newlines the
 * author typed and breaking on spaces where it can.
 *
 * A word longer than the line is cut rather than allowed to overrun, because
 * a panel has no margin to spill into.
 */
export function wrapText(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const paragraph of foldToAscii(text).split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > cols) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cols));
        word = word.slice(cols);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Typographic characters an editor inserts silently, folded to the ASCII the
 * sheet can draw. Without this a curly apostrophe drops out and the text
 * reads "humanity s last hope".
 */
const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  "´": "'",
  "`": "'",
};

/** `text` with those foldings applied. */
export function foldToAscii(text: string): string {
  let out = "";
  for (const ch of String(text ?? "")) out += FOLD[ch] ?? ch;
  return out;
}

/**
 * A code point the sheet can draw. Anything outside it — the story text
 * carries mis-decoded Greek in places — becomes a space rather than a wrong
 * glyph or a crash.
 */
function glyphIndex(font: BitmapFont, ch: string): number {
  const code = ch.codePointAt(0) ?? 32;
  const index = code - FIRST_CODE;
  return index >= 0 && index < font.glyphs.length ? index : -1;
}

/**
 * `text` drawn into a `w` x `h` raster, wrapped and vertically centred.
 *
 * Lines that do not fit the height are dropped from the bottom: a story
 * caption that overruns its strip is better short than spilling over the
 * picture below it.
 */
export function renderText(
  font: BitmapFont,
  text: string,
  w: number,
  h: number,
  opts: TextOptions = {},
): Raster {
  const colour = opts.colour ?? [255, 255, 255];
  const align = opts.align ?? "centre";
  const lineGap = opts.lineGap ?? font.glyphH + 1;
  const out = newRaster(w, h);

  const cols = Math.max(1, Math.floor(w / font.glyphW));
  const rows = Math.max(1, Math.floor((h + (lineGap - font.glyphH)) / lineGap));
  const lines = wrapText(text, cols).slice(0, rows);
  if (!lines.length) return out;

  const blockH = lines.length * lineGap - (lineGap - font.glyphH);
  const top = Math.max(0, Math.floor((h - blockH) / 2));

  const plot = (px: number, py: number, r: number, g: number, b: number) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const d = (py * w + px) * 4;
    out.data[d] = r;
    out.data[d + 1] = g;
    out.data[d + 2] = b;
    out.data[d + 3] = 255;
  };

  lines.forEach((line, row) => {
    const lineW = line.length * font.glyphW;
    const left = align === "centre" ? Math.floor((w - lineW) / 2) : 0;
    const y0 = top + row * lineGap;
    for (let i = 0; i < line.length; i++) {
      const gi = glyphIndex(font, line[i]);
      if (gi < 0) continue;
      const mask = font.glyphs[gi];
      const x0 = left + i * font.glyphW;
      // Shadow first, so the ink lands on top of it.
      if (opts.shadow) {
        for (let y = 0; y < font.glyphH; y++) {
          for (let x = 0; x < font.glyphW; x++) {
            if (mask[y * font.glyphW + x]) {
              plot(x0 + x + 1, y0 + y + 1, 0, 0, 0);
            }
          }
        }
      }
      for (let y = 0; y < font.glyphH; y++) {
        for (let x = 0; x < font.glyphW; x++) {
          if (mask[y * font.glyphW + x]) {
            plot(x0 + x, y0 + y, colour[0], colour[1], colour[2]);
          }
        }
      }
    }
  });
  return out;
}
