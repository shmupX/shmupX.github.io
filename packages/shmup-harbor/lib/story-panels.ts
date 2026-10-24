// Story backdrops: a level's story — its pictures and its words — set as the
// opening scenery of each stage on a cart: the Saturn's Dezaemon 2, the Super
// Famicom's Dezaemon, and the PlayStation's Kids! and Dezaemon+.
//
// The composer is the engine's (src/story/story-panels.js — what is drawn,
// at which sizes, and why), because the level editor's exports compose the
// same backdrops in the page. This file is the command line's half: it
// decodes the story's GIF and PNG data URLs with this package's own decoders
// (the page uses the browser's) and gives the engine's functions types.

import { decodeGifFrames, isGif } from "./ps2/gif.ts";
import { decodePng, type Raster } from "./ps2/png.ts";
import type { BitmapFont } from "./bitmap-font.ts";
import * as panels from "@shmupx/shmup-engine/story-panels";

/** A stage's background map is 14 cells of 16 px across. */
export const BACKDROP_W: number = panels.BACKDROP_W;
/** One map row, and the unit a backdrop's height comes in. */
export const BACKDROP_ROW: number = panels.BACKDROP_ROW;
/**
 * The height a story aims to fit: what the screen shows between the score
 * and its bottom edge as the stage opens, 12 rows.
 */
export const BACKDROP_H: number = panels.BACKDROP_H;

/** One way of drawing a stage's story: a BACKDROP_W-wide raster, whole rows tall. */
export interface StoryVariant {
  /** What it shows, for the build log: "picture 123x164 + words", "words", … */
  label: string;
  w: number;
  h: number;
  rgba: Uint8Array;
}

export interface StoryBackdrop {
  /** Which stage it opens. */
  stage: number;
  /** The customImages key its picture came from, or null for words alone. */
  sourceKey: string | null;
  /** Who the plate names. */
  speaker: string;
  /** The stage's story parts, in order, as authored. */
  parts: string[];
  /** The sizes it can be drawn at, largest first; the writer takes one. */
  variants: StoryVariant[];
}

/** What a cart writer reports of a stage's story, if it drew one. */
export interface StoryStageReport {
  key: string;
  story?: { size: string; rows: number } | null;
}

/** The bytes behind a base64 data URL. */
function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("story picture: not a data URL");
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The picture behind a `customImages` entry, as RGBA.
 *
 * Story pictures are usually animated GIFs; a background holds ONE frame, so
 * the first is taken and the rest dropped. PNG is accepted too, since the
 * editor can store either — which is why this is async: the PNG decoder is.
 */
export async function decodeStoryPicture(dataUrl: string): Promise<Raster> {
  const bytes = dataUrlBytes(dataUrl);
  if (isGif(bytes)) {
    const gif = decodeGifFrames(bytes);
    if (!gif.frames.length) throw new Error("story picture: GIF has no frames");
    return gif.frames[0].raster;
  }
  return await decodePng(bytes);
}

/**
 * `src` fitted into `w` x `h` by area averaging, preserving aspect and
 * centring what is left over.
 */
export const fitPanel: (src: Raster, w: number, h: number) => Raster =
  panels.fitPanel;

/** `src` at its own aspect, as large as fits `w` x `h`. */
export const containPicture: (src: Raster, w: number, h: number) => Raster =
  panels.containPicture;

/** The parts of a stage's story, as authored. */
export const storyParts: (storyData: unknown, stage: number) => string[] =
  panels.storyParts;

/** Who the plate names: the story's own speaker, else G. */
export const storySpeaker: (storyData: unknown) => string = panels.storySpeaker;

/** The height of the plate and the box for `lines` lines of words. */
export const wordsHeight: (font: BitmapFont, lines: number) => number =
  panels.wordsHeight;

/**
 * One stage's story drawn BACKDROP_W wide: the speaker's plate and the words'
 * box on top, the picture centred below, in whole rows.
 */
export const composeBackdrop: (
  font: BitmapFont | null,
  speaker: string,
  lines: string[],
  picture: Raster | null,
) => Raster = panels.composeBackdrop;

/**
 * A build's "story:" log line: what each of the cart's stages opens on, and
 * which of the story's stages the cart has no stage for.
 */
export const storyLogLine: (
  backdrops: StoryBackdrop[],
  stages: StoryStageReport[],
) => string = panels.storyLogLine;

/**
 * Every stage's story backdrop, in the sizes it can be drawn at, its
 * pictures decoded by decodeStoryPicture. A picture that will not decode
 * costs only that picture; without a font a story is its picture alone.
 */
export function storyBackdrops(
  storyData: unknown,
  { font = null, onWarn = () => {} }: {
    /** The face to set the words in. */
    font?: BitmapFont | null;
    onWarn?: (message: string) => void;
  } = {},
): Promise<StoryBackdrop[]> {
  return panels.storyBackdrops(storyData, {
    font,
    decodePicture: decodeStoryPicture,
    onWarn,
  });
}
