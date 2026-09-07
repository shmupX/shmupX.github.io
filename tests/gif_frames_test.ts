// The multi-frame GIF decoder in lib/ps2/gif.ts, against synthetic files.
//
// Every fixture here is hand-assembled bytes — header, logical screen
// descriptor, colour table, and per frame an optional graphic control
// extension plus an image descriptor whose pixels go through the small LZW
// writer below. Nothing in this file decodes: `decodeGifFrames` is the only
// thing that reads a GIF back, so a decoder bug cannot be cancelled out by a
// matching bug in the fixtures.

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { decodeGif, decodeGifFrames } from "../lib/ps2/gif.ts";
import type { Raster } from "../lib/ps2/png.ts";

type RGB = [number, number, number];

const PALETTE4: RGB[] = [
  [255, 0, 0], // 0 red
  [0, 255, 0], // 1 green
  [0, 0, 255], // 2 blue
  [255, 255, 255], // 3 white
];

// Eight distinguishable entries, so an eight-row interlaced frame can say
// exactly which storage row landed on which screen row.
const PALETTE8: RGB[] = Array.from(
  { length: 8 },
  (_, i) => [8 + i * 16, 0, 0] as RGB,
);

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function px(raster: Raster, x: number, y: number): number[] {
  const at = (y * raster.width + x) * 4;
  return Array.from(raster.data.slice(at, at + 4));
}

/** The whole raster as one row of RGBA quads, for a height-1 screen. */
function row(raster: Raster, y = 0): number[][] {
  return Array.from({ length: raster.width }, (_, x) => px(raster, x, y));
}

/**
 * LZW-encode `indices` as literals only: a clear code, one code per pixel,
 * then end-of-information. No multi-pixel strings are ever emitted, but the
 * dictionary still grows one entry per code, so the code width widens on
 * exactly the pixel a decoder expects it to.
 */
function lzwEncode(indices: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const put = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  put(clear);
  let next = eoi + 1;
  let first = true;
  for (const index of indices) {
    put(index);
    if (first) {
      first = false;
      continue;
    }
    next++;
    if (next === 1 << codeSize && codeSize < 12) codeSize++;
  }
  put(eoi);
  if (bitCount > 0) out.push(bitBuf & 0xff);
  return out;
}

/** Wrap `data` in GIF data sub-blocks, terminated by a zero-length block. */
function subBlocks(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

interface FrameSpec {
  indices: number[];
  width: number;
  height: number;
  left?: number;
  top?: number;
  /** Delay in hundredths of a second, the unit the GIF stores. */
  delay?: number;
  disposal?: number;
  /** Palette index to treat as transparent. */
  transparent?: number;
  interlaced?: boolean;
  /** A local colour table, used instead of the global one. */
  palette?: RGB[];
}

interface GifSpec {
  width: number;
  height: number;
  palette?: RGB[];
  /** NETSCAPE2.0 loop count; the extension is omitted when undefined. */
  loop?: number;
  frames: FrameSpec[];
}

function tableBits(palette: RGB[]): number {
  let bits = 0;
  while (1 << (bits + 1) < palette.length) bits++;
  return bits;
}

function pushTable(out: number[], palette: RGB[], bits: number): void {
  for (let i = 0; i < 1 << (bits + 1); i++) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    out.push(r, g, b);
  }
}

function u16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

function ascii(out: number[], text: string): void {
  for (const ch of text) out.push(ch.charCodeAt(0));
}

function buildGif(spec: GifSpec): Uint8Array {
  const out: number[] = [];
  ascii(out, "GIF89a");
  u16(out, spec.width);
  u16(out, spec.height);
  const global = spec.palette;
  const globalBits = global ? tableBits(global) : 0;
  out.push(global ? 0x80 | globalBits : 0, 0, 0); // packed, background, aspect
  if (global) pushTable(out, global, globalBits);

  if (spec.loop !== undefined) {
    out.push(0x21, 0xff, 0x0b);
    ascii(out, "NETSCAPE2.0");
    out.push(3, 1);
    u16(out, spec.loop);
    out.push(0);
  }

  for (const frame of spec.frames) {
    const { transparent } = frame;
    if (
      frame.delay !== undefined || frame.disposal !== undefined ||
      transparent !== undefined
    ) {
      const flags = ((frame.disposal ?? 0) << 2) |
        (transparent === undefined ? 0 : 1);
      out.push(0x21, 0xf9, 4, flags);
      u16(out, frame.delay ?? 0);
      out.push(transparent ?? 0, 0);
    }
    out.push(0x2c);
    u16(out, frame.left ?? 0);
    u16(out, frame.top ?? 0);
    u16(out, frame.width);
    u16(out, frame.height);
    const local = frame.palette;
    const localBits = local ? tableBits(local) : 0;
    out.push((local ? 0x80 | localBits : 0) | (frame.interlaced ? 0x40 : 0));
    if (local) pushTable(out, local, localBits);
    const minCodeSize = Math.max(2, (local ? localBits : globalBits) + 1);
    out.push(minCodeSize);
    out.push(...subBlocks(lzwEncode(frame.indices, minCodeSize)));
  }

  out.push(0x3b);
  return new Uint8Array(out);
}

Deno.test("a one-frame GIF decodes to its pixels, and decodeGif agrees", () => {
  const bytes = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE4,
    frames: [{ width: 2, height: 2, indices: [0, 1, 2, 3] }],
  });
  const img = decodeGifFrames(bytes);
  assertStrictEquals(img.width, 2);
  assertStrictEquals(img.height, 2);
  assertStrictEquals(img.frames.length, 1);

  const frame = img.frames[0];
  assertEquals(px(frame.raster, 0, 0), RED);
  assertEquals(px(frame.raster, 1, 0), GREEN);
  assertEquals(px(frame.raster, 0, 1), BLUE);
  assertEquals(px(frame.raster, 1, 1), WHITE);
  assertEquals(
    [frame.left, frame.top, frame.width, frame.height],
    [0, 0, 2, 2],
  );
  assertStrictEquals(frame.delayMs, 0);
  assertStrictEquals(frame.disposal, 0);

  // decodeGif is the old single-frame entry point; it must still hand back
  // this very raster for the callers that only ever wanted a still.
  const still = decodeGif(bytes);
  assertStrictEquals(still.width, 2);
  assertStrictEquals(still.height, 2);
  assertEquals(Array.from(still.data), Array.from(frame.raster.data));
});

Deno.test("two frames each composite onto the logical screen", () => {
  const bytes = buildGif({
    width: 3,
    height: 1,
    palette: PALETTE4,
    frames: [
      { width: 3, height: 1, indices: [3, 3, 3], disposal: 1 },
      { left: 1, top: 0, width: 1, height: 1, indices: [1], disposal: 1 },
    ],
  });
  const { frames } = decodeGifFrames(bytes);
  assertStrictEquals(frames.length, 2);

  // Both rasters are the whole logical screen, not just the frame's rect.
  assertStrictEquals(frames[1].raster.width, 3);
  assertStrictEquals(frames[1].raster.height, 1);
  assertEquals(row(frames[0].raster), [WHITE, WHITE, WHITE]);
  assertEquals(row(frames[1].raster), [WHITE, GREEN, WHITE]);

  // The second frame's own rect is reported, and frame 0 is a snapshot the
  // later composite did not write through.
  assertEquals(
    [frames[1].left, frames[1].top, frames[1].width, frames[1].height],
    [1, 0, 1, 1],
  );
  assertEquals(px(frames[0].raster, 1, 0), WHITE);

  // Backwards compatibility again: the first frame, never the last composite.
  assertEquals(Array.from(decodeGif(bytes).data), [
    ...WHITE,
    ...WHITE,
    ...WHITE,
  ]);
});

Deno.test("delayMs comes from the graphic control extension, in ms", () => {
  const bytes = buildGif({
    width: 1,
    height: 1,
    palette: PALETTE4,
    frames: [
      { width: 1, height: 1, indices: [0], delay: 20 },
      { width: 1, height: 1, indices: [1], delay: 5 },
      // no control block at all: the previous frame's delay must not stick
      { width: 1, height: 1, indices: [2] },
    ],
  });
  const { frames } = decodeGifFrames(bytes);
  assertEquals(frames.map((f) => f.delayMs), [200, 50, 0]);
});

Deno.test("a transparent index lets the canvas below show through", () => {
  const bytes = buildGif({
    width: 3,
    height: 1,
    palette: PALETTE4,
    frames: [
      // index 0 is transparent, so the middle pixel is never painted at all
      { width: 3, height: 1, indices: [3, 0, 3], transparent: 0, disposal: 1 },
      // a full-width frame whose right pixel is transparent: it must leave the
      // white underneath standing rather than punching a hole in it
      { width: 3, height: 1, indices: [1, 1, 0], transparent: 0, disposal: 1 },
    ],
  });
  const { frames } = decodeGifFrames(bytes);
  assertEquals(row(frames[0].raster), [WHITE, CLEAR, WHITE]);
  assertEquals(row(frames[1].raster), [GREEN, GREEN, WHITE]);
});

Deno.test("disposal 2 clears only that frame's rect before the next", () => {
  const bytes = buildGif({
    width: 4,
    height: 1,
    palette: PALETTE4,
    frames: [
      { width: 4, height: 1, indices: [3, 3, 3, 3], disposal: 1 },
      { left: 1, top: 0, width: 2, height: 1, indices: [1, 1], disposal: 2 },
      { left: 0, top: 0, width: 1, height: 1, indices: [0], disposal: 0 },
    ],
  });
  const { frames } = decodeGifFrames(bytes);
  assertStrictEquals(frames[1].disposal, 2);
  // The frame itself still shows its own pixels...
  assertEquals(row(frames[1].raster), [WHITE, GREEN, GREEN, WHITE]);
  // ...and only afterwards is its rect wiped to transparent, leaving the white
  // outside it alone.
  assertEquals(row(frames[2].raster), [RED, CLEAR, CLEAR, WHITE]);
});

Deno.test("disposal 3 restores the canvas from before the frame", () => {
  const bytes = buildGif({
    width: 4,
    height: 1,
    palette: PALETTE4,
    frames: [
      { width: 4, height: 1, indices: [3, 3, 3, 3], disposal: 1 },
      { left: 1, top: 0, width: 2, height: 1, indices: [1, 1], disposal: 3 },
      { left: 0, top: 0, width: 1, height: 1, indices: [0], disposal: 0 },
    ],
  });
  const { frames } = decodeGifFrames(bytes);
  assertStrictEquals(frames[1].disposal, 3);
  assertEquals(row(frames[1].raster), [WHITE, GREEN, GREEN, WHITE]);
  // The green is undone — the white it covered comes back, not transparency.
  assertEquals(row(frames[2].raster), [RED, WHITE, WHITE, WHITE]);
});

Deno.test("the NETSCAPE2.0 loop count is read, and is -1 when absent", () => {
  const frames: FrameSpec[] = [{ width: 1, height: 1, indices: [0] }];
  const looping = decodeGifFrames(
    buildGif({ width: 1, height: 1, palette: PALETTE4, loop: 3, frames }),
  );
  assertStrictEquals(looping.loopCount, 3);

  // 0 is "forever", and must not be confused with "the file said nothing".
  const forever = decodeGifFrames(
    buildGif({ width: 1, height: 1, palette: PALETTE4, loop: 0, frames }),
  );
  assertStrictEquals(forever.loopCount, 0);

  const plain = decodeGifFrames(
    buildGif({ width: 1, height: 1, palette: PALETTE4, frames }),
  );
  assertStrictEquals(plain.loopCount, -1);
  assertStrictEquals(plain.frames.length, 1);
});

Deno.test("a local colour table wins over the global one", () => {
  const bytes = buildGif({
    width: 2,
    height: 1,
    palette: PALETTE4,
    frames: [{
      width: 2,
      height: 1,
      indices: [0, 1],
      palette: [[1, 2, 3], [4, 5, 6]],
    }],
  });
  const { frames } = decodeGifFrames(bytes);
  assertEquals(row(frames[0].raster), [[1, 2, 3, 255], [4, 5, 6, 255]]);
});

Deno.test("an interlaced frame lands its rows in screen order", () => {
  // Storage rows 0..7 hold palette indices 0..7; the four interlace passes
  // put them on screen rows 0,4,2,6 then 1,3,5,7.
  const bytes = buildGif({
    width: 1,
    height: 8,
    palette: PALETTE8,
    frames: [{
      width: 1,
      height: 8,
      indices: [0, 1, 2, 3, 4, 5, 6, 7],
      interlaced: true,
    }],
  });
  const { frames } = decodeGifFrames(bytes);
  const seen = Array.from({ length: 8 }, (_, y) => px(frames[0].raster, 0, y));
  const want = [0, 4, 2, 5, 1, 6, 3, 7].map((i) => [...PALETTE8[i], 255]);
  assertEquals(seen, want);
});

Deno.test("a frame overhanging the logical screen is clipped", () => {
  const bytes = buildGif({
    width: 2,
    height: 1,
    palette: PALETTE4,
    frames: [{ left: 1, top: 0, width: 2, height: 2, indices: [1, 2, 3, 0] }],
  });
  const { frames } = decodeGifFrames(bytes);
  assertStrictEquals(frames[0].raster.data.length, 2 * 1 * 4);
  assertEquals(row(frames[0].raster), [CLEAR, GREEN]);
});

Deno.test("a non-GIF input throws", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assertThrows(() => decodeGifFrames(png), Error, "not a GIF");
  assertThrows(() => decodeGif(png), Error, "not a GIF");
  assertThrows(() => decodeGifFrames(new Uint8Array(0)), Error, "not a GIF");
  // "GIF" but not a version this decoder claims
  assertThrows(
    () => decodeGifFrames(new TextEncoder().encode("GIF7a...")),
    Error,
    "not a GIF",
  );
});
