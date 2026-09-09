// Story panels: a level's cutscene pictures, cut down to art a Dezaemon cart
// can actually hold and show inside a stage.
//
// A .sav has nowhere to put a story: the format has no words for scenes, text
// or cutscenes, so exporting a level throws its `storyData` away and the
// import arrives with `noStory`. What the format DOES hold is enemies, and a
// stage can open on a quiet stretch with one large object descending through
// it. That is where a story picture can live.
//
// The size is fixed by the record art table (`RECORD_ART` in
// decode-sprites.js). The largest zako band is 4x4 cells — 64x64 pixels, one
// frame, and only four such records per stage. The boss core reaches 128x128
// but every stage spends that on its actual boss. So a panel is assembled
// from a BLOCK of band-6 records placed adjacently: 2x2 of them is 128x128,
// half the 256-pixel playfield, at a cost of 64 of the cart's 1024 shared
// cells per stage.
//
// The pictures themselves are GIFs held as data URLs in
// `storyData.customImages`, keyed `stage<N>_part<M>` — often large (foo's
// stage 0 is 642x547 across 16 frames), so they are area-averaged down rather
// than point-sampled; a nearest-neighbour reduction of a painted image at
// this ratio turns to noise.

import { decodeGifFrames, isGif } from "./ps2/gif.ts";
import { decodePng, newRaster, type Raster } from "./ps2/png.ts";

/** One 64x64 piece of a panel, and where it sits in the block. */
export interface PanelTile {
  /** Column and row within the block, 0-based. */
  col: number;
  row: number;
  w: number;
  h: number;
  rgba: Uint8Array;
}

export interface StoryPanel {
  /** Which stage this panel opens. */
  stage: number;
  /** The key it came from, e.g. "stage0_part0". */
  sourceKey: string;
  /** The assembled picture, panelW x panelH. */
  picture: Raster;
  /** The picture cut into band-sized tiles, reading order. */
  tiles: PanelTile[];
}

/** The side of one band-6 record's art, in pixels. */
export const TILE = 64;

/** The bytes behind a base64 data URL. */
function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("story panel: not a data URL");
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The picture behind a `customImages` entry, as RGBA.
 *
 * Story pictures are usually animated GIFs; a cart's record art in the band
 * that fits a panel holds ONE frame, so the first is taken and the rest
 * dropped. PNG is accepted too, since the editor can store either — which is
 * why this is async: the PNG decoder is.
 */
export async function decodeStoryPicture(dataUrl: string): Promise<Raster> {
  const bytes = dataUrlBytes(dataUrl);
  if (isGif(bytes)) {
    const gif = decodeGifFrames(bytes);
    if (!gif.frames.length) throw new Error("story panel: GIF has no frames");
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

/** A panel cut into `TILE`-sized pieces, reading order, left to right. */
export function splitIntoTiles(panel: Raster, tile = TILE): PanelTile[] {
  const cols = Math.ceil(panel.width / tile);
  const rows = Math.ceil(panel.height / tile);
  const out: PanelTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const rgba = new Uint8Array(tile * tile * 4);
      for (let y = 0; y < tile; y++) {
        const sy = row * tile + y;
        if (sy >= panel.height) break;
        for (let x = 0; x < tile; x++) {
          const sx = col * tile + x;
          if (sx >= panel.width) break;
          const s = (sy * panel.width + sx) * 4;
          const d = (y * tile + x) * 4;
          rgba[d] = panel.data[s];
          rgba[d + 1] = panel.data[s + 1];
          rgba[d + 2] = panel.data[s + 2];
          rgba[d + 3] = panel.data[s + 3];
        }
      }
      out.push({ col, row, w: tile, h: tile, rgba });
    }
  }
  return out;
}

/**
 * One panel per stage that has a story picture, at `cols` x `rows` tiles.
 *
 * Stages whose story carries no picture are skipped rather than given a blank
 * panel, and a picture that will not decode costs only its own stage — the
 * export must never fail over cutscene art.
 */
export async function storyPanels(
  storyData: unknown,
  { cols = 2, rows = 2, onWarn = () => {} }: {
    cols?: number;
    rows?: number;
    onWarn?: (message: string) => void;
  } = {},
): Promise<StoryPanel[]> {
  const sd = storyData as { customImages?: Record<string, unknown> } | null;
  const images = sd && sd.customImages;
  if (!images || typeof images !== "object") return [];

  const out: StoryPanel[] = [];
  for (let stage = 0; stage < 16; stage++) {
    // The first part of a stage's story is the one that opens it.
    const key = Object.keys(images)
      .filter((k) => new RegExp("^stage" + stage + "_part\\d+$").test(k))
      .sort()[0];
    if (!key) continue;
    const value = images[key];
    if (typeof value !== "string") continue;
    try {
      const picture = fitPanel(
        await decodeStoryPicture(value),
        cols * TILE,
        rows * TILE,
      );
      out.push({
        stage,
        sourceKey: key,
        picture,
        tiles: splitIntoTiles(picture),
      });
    } catch (e) {
      onWarn(
        `story panel for stage ${stage} (${key}): ${(e as Error).message}`,
      );
    }
  }
  return out;
}
