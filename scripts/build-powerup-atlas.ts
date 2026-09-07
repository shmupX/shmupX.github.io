// scripts/build-powerup-atlas.ts — the animated powerup emblems as a texture
// atlas the runtime can play.
//
//   deno task powerups:atlas
//
// Source art is dev-fixtures/powerups/powerup-{s,b,f,r}.gif — winged letter
// emblems, four frames each (wings spread, wings folded, the letter cycling
// colour). That directory is gitignored; this atlas is the committed artefact,
// the same arrangement the tone bank and the mesh library use.
//
// It is deliberately NOT packed into game_asset: a Dezaemon import replaces
// that texture with the level's own atlas (`window.__editorAtlases`), which
// would take the emblems away exactly when a cart is playing. A separate
// `powerups` texture is always there.
//
// Every frame is written at the GIF's full logical screen rather than its own
// bounding box, so the wings can spread and fold without the sprite shifting
// on its anchor — and at NATIVE resolution: the art is stored as a 2x blowup,
// and the runtime's own pickups are 26x15, exactly the native size, so
// emitting the 52x30 blowup would drop items at twice the size of every other
// one. The factor is measured per file rather than assumed.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { encodePng, newRaster } from "../lib/ps2/png.ts";
import { decodeGifFrames } from "../lib/ps2/gif.ts";
import { EMBLEM_DIR, pixelScale } from "../lib/powerup-emblems.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const OUT_PNG = join(ROOT, "static/games/2028-ai/assets/img/powerups.png");
const OUT_JSON = join(ROOT, "static/games/2028-ai/assets/powerups.json");

/** The letters, in sheet row order. */
const LETTERS = ["s", "b", "f", "r"] as const;
/** Gap between cells, so no sampling can bleed across a frame edge. */
const PAD = 2;

interface FrameRect {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  sourceSize: { w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  trimmed: boolean;
}

export async function buildPowerupAtlas(
  log: (message: string) => void = console.log,
): Promise<{ png: string; json: string; frames: number } | null> {
  const dir = join(ROOT, EMBLEM_DIR);
  const sets: { letter: string; frames: { data: Uint8Array }[] }[] = [];
  let width = 0, height = 0;

  for (const letter of LETTERS) {
    const path = join(dir, `powerup-${letter}.gif`);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch {
      log(`powerup-${letter}.gif is not in ${EMBLEM_DIR} — nothing to build`);
      return null;
    }
    const gif = decodeGifFrames(bytes);
    if (!gif.frames.length) throw new Error(`powerup-${letter}.gif has no frames`);
    if (!width) {
      width = gif.width;
      height = gif.height;
    } else if (gif.width !== width || gif.height !== height) {
      throw new Error(
        `powerup-${letter}.gif is ${gif.width}x${gif.height}; the others are ${width}x${height} — ` +
          "every emblem must share one canvas so the animation registers",
      );
    }
    sets.push({
      letter,
      frames: gif.frames.map((f) => ({ data: f.raster.data as Uint8Array })),
    });
  }

  // The blowup factor, measured over the whole canvas of every frame — the
  // smallest any frame supports, so nothing is thinned that should not be.
  const whole = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  let scale = Infinity;
  for (const set of sets) {
    for (const frame of set.frames) {
      scale = Math.min(scale, pixelScale(frame.data, width, height, whole));
    }
  }
  if (!Number.isFinite(scale) || scale < 1) scale = 1;
  const cellW = Math.floor(width / scale);
  const cellH = Math.floor(height / scale);
  if (scale > 1) {
    log(`emblems are a ${scale}x blowup of ${cellW}x${cellH} — emitting native`);
  }

  const cols = Math.max(...sets.map((s) => s.frames.length));
  const sheet = newRaster(
    cols * (cellW + PAD) - PAD,
    sets.length * (cellH + PAD) - PAD,
  );
  const frames: Record<string, FrameRect> = {};

  sets.forEach((set, row) => {
    set.frames.forEach((frame, col) => {
      const ox = col * (cellW + PAD);
      const oy = row * (cellH + PAD);
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          const s = (y * scale * width + x * scale) * 4;
          if (!frame.data[s + 3]) continue;
          const d = ((oy + y) * sheet.width + ox + x) * 4;
          sheet.data[d] = frame.data[s];
          sheet.data[d + 1] = frame.data[s + 1];
          sheet.data[d + 2] = frame.data[s + 2];
          sheet.data[d + 3] = frame.data[s + 3];
        }
      }
      const key = `emblem${set.letter.toUpperCase()}${col}.gif`;
      frames[key] = {
        frame: { x: ox, y: oy, w: cellW, h: cellH },
        rotated: false,
        sourceSize: { w: cellW, h: cellH },
        spriteSourceSize: { x: 0, y: 0, w: cellW, h: cellH },
        trimmed: false,
      };
    });
  });

  const atlas = {
    frames,
    meta: {
      app: "scripts/build-powerup-atlas.ts",
      format: "RGBA8888",
      image: "img/powerups.png",
      scale: "1",
      size: { w: sheet.width, h: sheet.height },
      version: "1.0",
    },
  };

  await ensureDir(dirname(OUT_PNG));
  await ensureDir(dirname(OUT_JSON));
  await Deno.writeFile(OUT_PNG, await encodePng(sheet));
  await Deno.writeTextFile(OUT_JSON, JSON.stringify(atlas, null, 2) + "\n");
  log(
    `powerups atlas: ${Object.keys(frames).length} frames of ${cellW}x${cellH} ` +
      `-> ${relative(ROOT, OUT_PNG)} (${sheet.width}x${sheet.height}), ${relative(ROOT, OUT_JSON)}`,
  );
  return { png: OUT_PNG, json: OUT_JSON, frames: Object.keys(frames).length };
}

if (import.meta.main) {
  const built = await buildPowerupAtlas();
  if (!built) Deno.exit(0);
}
