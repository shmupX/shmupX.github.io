// Story backdrops: a level's story — its pictures and its words — set as the
// opening scenery of each stage on a cart: the Saturn's Dezaemon 2, the Super
// Famicom's Dezaemon, and the PlayStation's Kids! and Dezaemon+.
//
// A save has nowhere to put a story: the formats have no words for scenes,
// text or cutscenes, so exporting a level throws its `storyData` away and the
// import arrives with `noStory`. What every one of them DOES hold is a
// background map per stage, 224 px of it drawn across, whose first rows are
// what the screen shows as the stage starts. That is where the story goes:
// each writer (game-to-save.js's story section, sfc-write.js buildWithStory,
// plus-write.js and kids-write.js likewise) paints it there, slows the stage's
// scroll while it is on screen where the format can, and holds the waves back
// until it has gone. It costs the game nothing but the cells nobody else
// wanted.
//
// What is drawn follows the web runtime's story scene: the speaker's name on
// a plate, the stage's words in a black box under it (every part, in order —
// a cart cannot wait for a tap between them), and the stage's picture below.
// Each stage comes in several sizes, largest first, because the cells are
// shared with the whole game: the writer takes the largest size that leaves
// room for every stage's story, then smaller pictures, then the words alone,
// then only the opening part's words.
//
// The pictures are GIFs held as data URLs in `storyData.customImages`, keyed
// `stage<N>_part<M>` — often large (foo's stage 0 is 642x547 across 16
// frames), so they are area-averaged down rather than point-sampled; a
// nearest-neighbour reduction of a painted image at this ratio turns to noise.

import { decodeGifFrames, isGif } from "./ps2/gif.ts";
import { decodePng, newRaster, type Raster } from "./ps2/png.ts";
import { type BitmapFont, renderText, wrapText } from "./bitmap-font.ts";

/** A stage's background map is 14 cells of 16 px across. */
export const BACKDROP_W = 224;
/** One map row, and the unit a backdrop's height comes in. */
export const BACKDROP_ROW = 16;
/**
 * The height a story aims to fit: what the screen shows between the score
 * and its bottom edge as the stage opens, 12 rows (the writer starts it at
 * STORY_FIRST_ROW). Longer words make it taller, and its top then scrolls
 * into view.
 */
export const BACKDROP_H = 12 * BACKDROP_ROW;

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
 * centring what is left over. Transparent pixels contribute nothing but their
 * transparency, so a picture with an alpha border does not bleed grey.
 */
export function fitPanel(src: Raster, w: number, h: number): Raster {
  const out = newRaster(w, h);
  const scale = Math.min(src.width / w, src.height / h);
  // The source rectangle that maps onto the whole panel (centre crop).
  const cropW = Math.min(src.width, Math.round(w * scale));
  const cropH = Math.min(src.height, Math.round(h * scale));
  const cropX = Math.floor((src.width - cropW) / 2);
  const cropY = Math.floor((src.height - cropH) / 2);

  for (let y = 0; y < h; y++) {
    const sy0 = cropY + Math.floor((y * cropH) / h);
    const sy1 = Math.max(sy0 + 1, cropY + Math.floor(((y + 1) * cropH) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = cropX + Math.floor((x * cropW) / w);
      const sx1 = Math.max(sx0 + 1, cropX + Math.floor(((x + 1) * cropW) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const s = (sy * src.width + sx) * 4;
          const sa = src.data[s + 3];
          if (sa) {
            r += src.data[s] * sa;
            g += src.data[s + 1] * sa;
            b += src.data[s + 2] * sa;
          }
          a += sa;
          n++;
        }
      }
      if (!n) continue;
      const d = (y * w + x) * 4;
      const alpha = a / n;
      out.data[d + 3] = Math.round(alpha);
      if (a > 0) {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

/** `src` at its own aspect, as large as fits `w` x `h`. */
export function containPicture(src: Raster, w: number, h: number): Raster {
  const scale = Math.min(w / src.width, h / src.height);
  return fitPanel(
    src,
    Math.max(1, Math.round(src.width * scale)),
    Math.max(1, Math.round(src.height * scale)),
  );
}

/** The parts of a stage's story, as authored. */
export function storyParts(storyData: unknown, stage: number): string[] {
  const sd = storyData as Record<string, unknown> | null;
  const st = sd &&
    (sd[`stage${stage}`] as { part?: { text?: unknown }[] } | undefined);
  if (!st || !Array.isArray(st.part)) return [];
  return st.part
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.trim());
}

/**
 * Who the plate names: the story's own speaker (gs's is GS), else G, whose
 * story 2028.Ai's is — the web runtime's rule (storySpeaker in the bundle).
 */
export function storySpeaker(storyData: unknown): string {
  const own = (storyData as { speaker?: unknown } | null)?.speaker;
  return typeof own === "string" && own.trim() ? own.trim() : "G";
}

// The plate and the box, in the face's 8 px cells.
const BORDER = 1;
const PAD = 3;
const GAP = 4;
const WHITE: [number, number, number] = [255, 255, 255];

function fillRect(
  r: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
) {
  for (let y = Math.max(0, y0); y < Math.min(r.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x0 + w); x++) {
      r.data.set([rgb[0], rgb[1], rgb[2], 255], (y * r.width + x) * 4);
    }
  }
}

/** A white-edged black box. */
function frameBox(r: Raster, x: number, y: number, w: number, h: number) {
  fillRect(r, x, y, w, h, WHITE);
  fillRect(r, x + BORDER, y + BORDER, w - 2 * BORDER, h - 2 * BORDER, [
    0,
    0,
    0,
  ]);
}

/** `src` drawn over `dst` at (x, y), its transparent pixels left alone. */
function blit(dst: Raster, src: Raster, x0: number, y0: number) {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      if (!src.data[s + 3]) continue;
      dst.data.set(src.data.subarray(s, s + 4), (dy * dst.width + dx) * 4);
    }
  }
}

/**
 * The height of the plate and the box for `lines` lines of words. The box
 * shares the plate's bottom edge, the way the web scene sits its name plate
 * on the box.
 */
export function wordsHeight(font: BitmapFont, lines: number): number {
  const plateH = font.glyphH + 2 * (BORDER + PAD);
  const boxH = lines * (font.glyphH + 1) - 1 + 2 * (BORDER + PAD);
  return plateH - BORDER + boxH;
}

/**
 * One stage's story drawn BACKDROP_W wide: the speaker's plate and the words'
 * box on top, the picture centred below, the whole padded with transparency
 * to whole rows. Either half may be missing.
 */
export function composeBackdrop(
  font: BitmapFont | null,
  speaker: string,
  lines: string[],
  picture: Raster | null,
): Raster {
  const gw = font?.glyphW ?? 8, gh = font?.glyphH ?? 8;
  const lineGap = gh + 1;
  const words = font && lines.length > 0;
  const plateW = speaker.length * gw + 2 * (BORDER + PAD);
  const plateH = gh + 2 * (BORDER + PAD);
  const boxH = lines.length * lineGap - 1 + 2 * (BORDER + PAD);
  const wordsH = words ? wordsHeight(font!, lines.length) : 0;
  const pictureY = words && picture ? wordsH + GAP : wordsH;
  const contentH = pictureY + (picture ? picture.height : 0);
  const h = Math.max(
    BACKDROP_ROW,
    Math.ceil(contentH / BACKDROP_ROW) * BACKDROP_ROW,
  );
  const out = newRaster(BACKDROP_W, h);
  if (words) {
    const boxY = plateH - BORDER;
    frameBox(out, 0, boxY, BACKDROP_W, boxH);
    frameBox(out, 4, 0, plateW, plateH);
    blit(
      out,
      renderText(font!, speaker, speaker.length * gw, gh, { colour: WHITE }),
      4 + BORDER + PAD,
      BORDER + PAD,
    );
    const inner = BACKDROP_W - 2 * (BORDER + PAD);
    blit(
      out,
      renderText(font!, lines.join("\n"), inner, lines.length * lineGap - 1, {
        colour: WHITE,
        align: "left",
        lineGap,
      }),
      BORDER + PAD,
      boxY + BORDER + PAD,
    );
  }
  if (picture) {
    blit(
      out,
      picture,
      Math.floor((BACKDROP_W - picture.width) / 2),
      pictureY,
    );
  }
  return out;
}

/** The words' lines as the box sets them. */
function boxLines(font: BitmapFont, parts: string[]): string[] {
  const cols = Math.floor((BACKDROP_W - 2 * (BORDER + PAD)) / font.glyphW);
  return parts.flatMap((p) => wrapText(p, cols));
}

/**
 * What a writer reports of a stage's story, if it drew one: the map rows it
 * took on a cart, or the seconds it stays up on the 64DD, where it is a
 * full-screen briefing rather than scenery.
 */
export interface StoryStageReport {
  key: string;
  story?: { size: string; rows?: number; seconds?: number } | null;
}

/**
 * A build's "story:" log line: what each of the cart's stages opens on, and
 * which of the story's stages the cart has no stage for (a stage is matched
 * by its key, `stage<N>`, so a boss's split second stage is never one).
 */
export function storyLogLine(
  backdrops: StoryBackdrop[],
  stages: StoryStageReport[],
): string {
  if (!backdrops.length) {
    return "story: the level tells none — stages open as they are";
  }
  const keys = new Set(stages.map((s) => s.key));
  const drawn = stages.filter((s) => s.story).map((s) =>
    `${s.key} ${s.story!.size} (${
      s.story!.seconds !== undefined
        ? `${s.story!.seconds} s`
        : `${s.story!.rows} rows`
    })`
  );
  const beyond = backdrops.filter((b) => !keys.has(`stage${b.stage}`))
    .map((b) => b.stage);
  return `story: ${
    drawn.length ? `opens ${drawn.join(", ")}` : "no stage has room for it"
  }${
    beyond.length
      ? ` (stage${beyond.length === 1 ? "" : "s"} ${
        beyond.join(", ")
      } of the story ${
        beyond.length === 1 ? "has" : "have"
      } no stage on the cart)`
      : ""
  }`;
}

const variant = (label: string, r: Raster): StoryVariant => ({
  label,
  w: r.width,
  h: r.height,
  rgba: r.data,
});

/**
 * Every stage's story backdrop, in the sizes it can be drawn at.
 *
 * A stage whose story has neither a picture nor words is skipped, and a
 * picture that will not decode costs only that picture — the export must
 * never fail over cutscene art. Without a font a story is its picture alone.
 */
export async function storyBackdrops(
  storyData: unknown,
  { font = null, onWarn = () => {}, height = BACKDROP_H }: {
    /** The face to set the words in. */
    font?: BitmapFont | null;
    onWarn?: (message: string) => void;
    /**
     * The opening screen's room under the score, whole rows: a cart with less
     * than BACKDROP_H (Dezaemon Kids!, 160) asks for its own.
     */
    height?: number;
  } = {},
): Promise<StoryBackdrop[]> {
  const sd = storyData as { customImages?: Record<string, unknown> } | null;
  if (!sd || typeof sd !== "object") return [];
  const images = sd.customImages && typeof sd.customImages === "object"
    ? sd.customImages
    : {};
  const speaker = storySpeaker(sd);
  const out: StoryBackdrop[] = [];
  for (let stage = 0; stage < 16; stage++) {
    const parts = storyParts(sd, stage);
    // The first part with a picture is the one the stage opens on.
    const key = Object.keys(images)
      .filter((k) => new RegExp("^stage" + stage + "_part\\d+$").test(k))
      .sort((a, b) => Number(a.split("part")[1]) - Number(b.split("part")[1]))
      .find((k) => typeof images[k] === "string") ?? null;
    let source: Raster | null = null;
    if (key) {
      try {
        source = await decodeStoryPicture(images[key] as string);
      } catch (e) {
        onWarn(
          `story picture for stage ${stage} (${key}): ${(e as Error).message}`,
        );
      }
    }
    const lines = font ? boxLines(font, parts) : [];
    if (!source && !lines.length) continue;

    const variants: StoryVariant[] = [];
    const words = font && lines.length
      ? composeBackdrop(font, speaker, lines, null)
      : null;
    if (source) {
      // The picture takes what the words leave of the opening screen, then
      // two thirds of that, then two fifths; a story whose words fill the
      // screen still shows its picture, below them, at a third of it.
      const room = height -
        (words ? wordsHeight(font!, lines.length) + GAP : 0);
      const heights = room >= 48
        ? [room, Math.round(room * 2 / 3), Math.round(room * 2 / 5)]
        : [Math.round(height / 3)];
      const seen = new Set<string>();
      for (const h of heights) {
        const pic = containPicture(source, BACKDROP_W, h);
        const size = `${pic.width}x${pic.height}`;
        if (seen.has(size) || pic.height < 16) continue;
        seen.add(size);
        variants.push(
          variant(
            `picture ${size}${words ? " + words" : ""}`,
            composeBackdrop(font, speaker, words ? lines : [], pic),
          ),
        );
      }
    }
    if (words) {
      variants.push(variant("words", words));
      const opening = boxLines(font!, parts.slice(0, 1));
      if (parts.length > 1 && opening.length < lines.length) {
        variants.push(
          variant(
            "opening words",
            composeBackdrop(font, speaker, opening, null),
          ),
        );
      }
    }
    out.push({
      stage,
      sourceKey: source ? key : null,
      speaker,
      parts,
      variants,
    });
  }
  return out;
}
