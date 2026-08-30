// Bake player 2's ship — the trooper — into
// packages/shmup-engine/src/player2-art.js.
//
// The trooper is shmup-party-phaser4's foot soldier
// (`assets/trooper.png` + `trooper.json`, a TexturePacker atlas). Its
// `move-legs-*` / `move-torso-*` bands are a 64-frame walk cycle drawn from
// directly above, facing UP the whole way — measured, not assumed: every
// torso frame's barrel points within a few degrees of 90°. That is exactly
// the pose a vertical shmup wants, so no rotation or direction picking is
// needed; the two layers are composited and every eighth frame is kept.
//
// Why bake instead of ship the atlas: a Dezaemon import RESETS the game_asset
// atlas to make room for the save's own sprites, so anything the player
// references has to travel with the player. Duke does this already
// (src/player-art.js, generated the same way), and the runtime, the offline
// export and the PS2 build all get the trooper for free by consuming the same
// `sprites` list.
//
// The output format matches player-art.js exactly: a shared palette of packed
// big-endian RGBA u32s with index 0 transparent, and per-frame runs of
// (paletteIndex, length 1..255) byte pairs, row-major, base64'd.
//
//   deno run -A scripts/build-player2-art.ts [path-to-shmup-party-phaser4]
//
// Defaults to ../shmup-party-phaser4 next to this checkout.

import { decodePng, encodePng, type Raster } from "../lib/ps2/png.ts";
import { fromFileUrl } from "@std/path";

// Every 8th frame of the 64-frame cycle: eight phases is a readable stride at
// the runtime's 6fps and keeps the baked payload near Duke's.
const FRAME_STRIDE = 8;
const FRAME_COUNT = 8;
// Anti-aliased edges are thresholded rather than kept: Phaser renders this
// atlas with NEAREST filtering (pixelArt), and Duke's baked frames are binary
// alpha too, so a soft edge costs palette entries and buys nothing.
const ALPHA_CUTOFF = 128;
// Index 0 is reserved for "transparent", leaving 255 for real colours.
const MAX_COLOURS = 255;

type Frame = { key: string; w: number; h: number; rgba: Uint8ClampedArray };

interface PackerFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  rotated?: boolean;
}

const root = fromFileUrl(new URL("..", import.meta.url));
const partyDir = Deno.args[0] ?? `${root}../shmup-party-phaser4`;
const atlasJson = `${partyDir}/assets/trooper.json`;
const atlasPng = `${partyDir}/assets/trooper.png`;

for (const p of [atlasJson, atlasPng]) {
  try {
    Deno.statSync(p);
  } catch {
    console.error(
      `Missing ${p}\n` +
        `Pass the path to a shmup-party-phaser4 checkout:\n` +
        `  deno run -A scripts/build-player2-art.ts ../shmup-party-phaser4`,
    );
    Deno.exit(1);
  }
}

const packer = JSON.parse(await Deno.readTextFile(atlasJson));
const texture = packer.textures[0];
const byName = new Map<string, PackerFrame>(
  texture.frames.map((f: PackerFrame) => [f.filename, f]),
);
const sheet = await decodePng(await Deno.readFile(atlasPng));

/** One atlas frame, expanded back onto its full untrimmed canvas. */
function cut(name: string): Frame {
  const f = byName.get(name);
  if (!f) throw new Error(`no frame ${name} in ${atlasJson}`);
  if (f.rotated) {
    throw new Error(`frame ${name} is rotated; unpacking not implemented`);
  }
  const { w, h } = f.sourceSize;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < f.frame.h; y++) {
    for (let x = 0; x < f.frame.w; x++) {
      const src = ((f.frame.y + y) * sheet.width + (f.frame.x + x)) * 4;
      const dst =
        ((f.spriteSourceSize.y + y) * w + (f.spriteSourceSize.x + x)) * 4;
      rgba[dst] = sheet.data[src];
      rgba[dst + 1] = sheet.data[src + 1];
      rgba[dst + 2] = sheet.data[src + 2];
      rgba[dst + 3] = sheet.data[src + 3];
    }
  }
  return { key: name, w, h, rgba };
}

/** Lay `over` on top of `under`, both the same size. Source-over, thresholded. */
function composite(under: Frame, over: Frame): Frame {
  const out = new Uint8ClampedArray(under.rgba);
  for (let i = 0; i < over.rgba.length; i += 4) {
    if (over.rgba[i + 3] >= ALPHA_CUTOFF) {
      out[i] = over.rgba[i];
      out[i + 1] = over.rgba[i + 1];
      out[i + 2] = over.rgba[i + 2];
      out[i + 3] = 255;
    }
  }
  return { key: under.key, w: under.w, h: under.h, rgba: out };
}

const composites: Frame[] = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  const n = String(1 + i * FRAME_STRIDE).padStart(4, "0");
  composites.push(composite(cut(`move-legs-${n}`), cut(`move-torso-${n}`)));
}

// One bounding box for the whole cycle, so the frames stay registered to each
// other — cropping each to its own box would make the trooper jitter.
let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
for (const f of composites) {
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (f.rgba[(y * f.w + x) * 4 + 3] < ALPHA_CUTOFF) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
}
const W = x1 - x0 + 1;
const H = y1 - y0 + 1;

const cropped = composites.map((f) => {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((y + y0) * f.w + (x + x0)) * 4;
      const dst = (y * W + x) * 4;
      const opaque = f.rgba[src + 3] >= ALPHA_CUTOFF;
      rgba[dst] = opaque ? f.rgba[src] : 0;
      rgba[dst + 1] = opaque ? f.rgba[src + 1] : 0;
      rgba[dst + 2] = opaque ? f.rgba[src + 2] : 0;
      rgba[dst + 3] = opaque ? 255 : 0;
    }
  }
  return rgba;
});

// --- palette -------------------------------------------------------------
//
// Median cut over the opaque pixels. The trooper is a rendered sprite with a
// few thousand distinct colours; 255 is plenty for a 29x41 figure and the
// error is invisible at this size.
type RGB = [number, number, number];
const pixels: RGB[] = [];
for (const rgba of cropped) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]) pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
}

function medianCut(box: RGB[], depth: number): RGB[] {
  if (!box.length) return [];
  if (depth === 0 || box.length === 1) {
    let r = 0, g = 0, b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    return [[
      Math.round(r / box.length),
      Math.round(g / box.length),
      Math.round(b / box.length),
    ]];
  }
  // split on the channel with the widest spread
  let widest = 0, widestSpan = -1;
  for (let c = 0; c < 3; c++) {
    let lo = 255, hi = 0;
    for (const p of box) {
      if (p[c] < lo) lo = p[c];
      if (p[c] > hi) hi = p[c];
    }
    if (hi - lo > widestSpan) {
      widestSpan = hi - lo;
      widest = c;
    }
  }
  if (widestSpan === 0) return medianCut(box, 0);
  const sorted = box.slice().sort((a, b) => a[widest] - b[widest]);
  const mid = sorted.length >> 1;
  return [
    ...medianCut(sorted.slice(0, mid), depth - 1),
    ...medianCut(sorted.slice(mid), depth - 1),
  ];
}

// depth 8 => up to 256 boxes; dedupe and trim to the 255 the format allows
let palette: RGB[] = medianCut(pixels, 8);
const seen = new Set<string>();
palette = palette.filter((p) => {
  const k = p.join(",");
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}).slice(0, MAX_COLOURS);

const nearestCache = new Map<number, number>();
function nearest(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const hit = nearestCache.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = palette[i][0] - r,
      dg = palette[i][1] - g,
      db = palette[i][2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // +1: index 0 of the emitted palette is the transparent slot
  nearestCache.set(key, best + 1);
  return best + 1;
}

// --- encode --------------------------------------------------------------
function toBase64(bytes: number[]): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

let maxError = 0;
const out: { key: string; w: number; h: number; rle: string }[] = [];
cropped.forEach((rgba, i) => {
  const runs: number[] = [];
  let cur = -1, len = 0;
  const flush = () => {
    while (len > 0) {
      const n = Math.min(255, len);
      runs.push(cur, n);
      len -= n;
    }
  };
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    let idx = 0;
    if (rgba[o + 3]) {
      idx = nearest(rgba[o], rgba[o + 1], rgba[o + 2]);
      const q = palette[idx - 1];
      const err = Math.max(
        Math.abs(q[0] - rgba[o]),
        Math.abs(q[1] - rgba[o + 1]),
        Math.abs(q[2] - rgba[o + 2]),
      );
      if (err > maxError) maxError = err;
    }
    if (idx === cur) len++;
    else {
      flush();
      cur = idx;
      len = 1;
    }
  }
  flush();
  out.push({ key: `trooper_${i}`, w: W, h: H, rle: toBase64(runs) });
});

const paletteLiteral = [
  "0x00000000",
  ...palette.map(([r, g, b]) =>
    "0x" + [r, g, b, 255].map((v) => v.toString(16).padStart(2, "0")).join("")
  ),
].join(", ");

const framesLiteral = out
  .map((f) => `    { key: "${f.key}", w: ${f.w}, h: ${f.h}, rle: "${f.rle}" },`)
  .join("\n");

const source =
  `// GENERATED by scripts/build-player2-art.ts — do not edit by hand.
//
// Player 2's ship: the trooper from shmup-party-phaser4
// (\`assets/trooper.png\`), whose walk cycle is drawn from above facing UP —
// the pose a vertical shmup needs, with no rotation applied here or at
// runtime. Legs and torso are composited, every ${FRAME_STRIDE}th frame of the
// 64-frame cycle kept, and the ${FRAME_COUNT} results cropped to one shared
// bounding box so the figure does not jitter as it animates.
//
// Baked rather than referenced for the same reason Duke is (see
// player-art.js): a Dezaemon import resets the game_asset atlas to make room
// for the save's own sprites, so a player's frames have to travel with the
// player. A save that carries its OWN second ship (global sprite bank refs
// 24-47) overrides these — see \`playerData2\` in map-to-game.js.
//
// Frames are palette + run-length encoded, exactly as player-art.js does it.

// RGBA, packed big-endian into a 32-bit int. Index 0 is transparent.
export const TROOPER_PALETTE = [
    ${paletteLiteral},
];

// Runs are (paletteIndex, length 1..255) byte pairs, row-major.
export const TROOPER_FRAMES = [
${framesLiteral}
];

// The record player 2 flies. Everything but the art and the name is player
// 1's — Dezaemon gives each ship a config block, not its own bullets, and the
// runtime merges this over \`playerData\` (see \`playerRecord\` in the runtime's
// Player module).
export const TROOPER_PLAYER = {
    name: "trooper",
    texture: [${out.map((f) => `"${f.key}"`).join(", ")}],
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// atob/Buffer-free so this stays environment-neutral (Node + browser + any
// bundler) exactly like the rest of src/. Carried here rather than imported
// from player-art.js because both files are generated and each has to stand
// on its own.
function fromBase64(s) {
    const clean = s.replace(/=+$/, "");
    const out = new Uint8Array((clean.length * 3) >> 2);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (let i = 0; i < clean.length; i++) {
        acc = (acc << 6) | B64.indexOf(clean[i]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >> bits) & 0xff;
        }
    }
    return out;
}

// Decode to the {key, w, h, rgba} shape the sprite pipeline uses, so the
// trooper can be handed to the atlas alongside a save's own art.
export function decodePlayer2Art() {
    return TROOPER_FRAMES.map(({ key, w, h, rle }) => {
        const runs = fromBase64(rle);
        const rgba = new Uint8ClampedArray(w * h * 4);
        let p = 0;
        for (let i = 0; i + 1 < runs.length; i += 2) {
            const colour = TROOPER_PALETTE[runs[i]];
            const r = (colour >>> 24) & 0xff;
            const g = (colour >>> 16) & 0xff;
            const b = (colour >>> 8) & 0xff;
            const a = colour & 0xff;
            for (let n = runs[i + 1]; n > 0; n--) {
                const o = p++ * 4;
                rgba[o] = r;
                rgba[o + 1] = g;
                rgba[o + 2] = b;
                rgba[o + 3] = a;
            }
        }
        return { key, w, h, rgba };
    });
}
`;

const target = `${root}packages/shmup-engine/src/player2-art.js`;
// src/** is CRLF in this package — keep it that way or the diff is the file.
await Deno.writeTextFile(target, source.replace(/\n/g, "\r\n"));

const bytes = out.reduce((n, f) => n + f.rle.length, 0);
console.log(
  `${FRAME_COUNT} frames of ${W}x${H}, ${palette.length} colours, ` +
    `${(bytes / 1024).toFixed(1)}KB of base64, max channel error ${maxError}`,
);
console.log(`wrote ${target}`);

// --- the stock atlas ------------------------------------------------------
//
// An IMPORT carries the trooper in its own `sprites` list (map-to-game.js
// appends the frames the same way it appends Duke's), but the shipped
// 2028-ai game plays off the committed game_asset atlas and never goes
// through that path. Duke is already baked in there — `duke_0..3` sit at
// y=1988 — so the trooper goes in beside him rather than inventing a second
// atlas the PS2 export and the offline stager would each have to learn about.
//
// Idempotent: a re-run reuses the strip it wrote last time instead of
// growing the sheet on every invocation.
const atlasJsonPath = `${root}static/games/2028-ai/assets/game_asset.json`;
const atlasPngPath = `${root}static/games/2028-ai/assets/img/game_asset.png`;

const atlas = JSON.parse(await Deno.readTextFile(atlasJsonPath));
const sheetPng = await decodePng(await Deno.readFile(atlasPngPath));

const existing = atlas.frames[out[0].key];
if (existing && (existing.frame.w !== W || existing.frame.h !== H)) {
  console.error(
    `game_asset already has ${
      out[0].key
    } at ${existing.frame.w}x${existing.frame.h}, ` +
      `but this bake is ${W}x${H}. Revert the atlas and re-run.`,
  );
  Deno.exit(1);
}
// A fresh bake lands on a new strip below everything else; a re-bake overwrites
// the strip already there.
const stripX = existing ? existing.frame.x : 0;
const stripY = existing ? existing.frame.y : sheetPng.height;
const newHeight = Math.max(sheetPng.height, stripY + H);

// A Raster, so encodePng takes it as-is: plain Uint8Array, not clamped —
// every byte written below is copied from an already-decoded sheet or frame,
// so there is nothing for the clamping to do.
const merged: Raster = {
  width: sheetPng.width,
  height: newHeight,
  data: new Uint8Array(sheetPng.width * newHeight * 4),
};
merged.data.set(
  sheetPng.data.subarray(0, sheetPng.width * sheetPng.height * 4),
);

cropped.forEach((rgba, i) => {
  const fx = stripX + i * W;
  if (fx + W > merged.width) {
    console.error(`trooper strip runs past the atlas width at frame ${i}`);
    Deno.exit(1);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = (y * W + x) * 4;
      const dst = ((stripY + y) * merged.width + fx + x) * 4;
      merged.data[dst] = rgba[src];
      merged.data[dst + 1] = rgba[src + 1];
      merged.data[dst + 2] = rgba[src + 2];
      merged.data[dst + 3] = rgba[src + 3];
    }
  }
  atlas.frames[out[i].key] = {
    frame: { h: H, w: W, x: fx, y: stripY },
    rotated: false,
    sourceSize: { h: H, w: W },
    spriteSourceSize: { h: H, w: W, x: 0, y: 0 },
    trimmed: false,
  };
});

atlas.meta.size = { w: merged.width, h: merged.height };
await Deno.writeFile(atlasPngPath, await encodePng(merged));
await Deno.writeTextFile(atlasJsonPath, JSON.stringify(atlas, null, 2) + "\n");
console.log(
  `merged into game_asset at (${stripX}, ${stripY}); sheet is now ` +
    `${merged.width}x${merged.height}`,
);
