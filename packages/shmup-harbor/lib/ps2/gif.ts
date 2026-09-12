// A GIF decoder: GIF87a and GIF89a, global and local colour tables,
// interlacing, and the graphic control extension's transparent index
// (alpha 0), as RGBA.
//
// `decodeGif` returns the first frame, which is all a still logo stored as a
// `data:image/gif` URL needs. `decodeGifFrames` walks the whole file and
// composites every frame — honouring the three disposal methods and carrying
// each frame's delay — which is what an animated sprite needs.
//
// Output rasters have the logical screen size, with each frame composited at
// its own offset and everything outside it transparent.

import { newRaster, type Raster } from "./png.ts";

const MAX_CODE_BITS = 12;

function u16le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

/** Concatenate the data sub-blocks starting at `at`; returns [bytes, next]. */
function subBlocks(b: Uint8Array, at: number): [Uint8Array, number] {
  const parts: Uint8Array[] = [];
  let total = 0;
  let p = at;
  for (;;) {
    if (p >= b.length) throw new Error("gif: truncated sub-blocks");
    const n = b[p++];
    if (n === 0) break;
    parts.push(b.subarray(p, p + n));
    total += n;
    p += n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return [out, p];
}

/** LZW-decode `data` with the given minimum code size into `count` indices. */
function lzwDecode(
  data: Uint8Array,
  minCodeSize: number,
  count: number,
): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  // dictionary as (prefix, suffix) pairs; entry lengths let us write
  // backwards without materialising strings
  const prefix = new Int32Array(1 << MAX_CODE_BITS);
  const suffix = new Uint8Array(1 << MAX_CODE_BITS);
  const length = new Uint16Array(1 << MAX_CODE_BITS);
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  let bitBuf = 0, bitCount = 0, pos = 0, written = 0;
  let prev = -1;
  const emit = (code: number): number => {
    // write the string for `code` at `written`, return its first byte
    const len = length[code];
    let c = code;
    let at = written + len - 1;
    let first = 0;
    for (let k = 0; k < len; k++) {
      first = suffix[c];
      if (at < count) out[at] = first;
      at--;
      c = prefix[c];
    }
    written += len;
    return first;
  };
  while (written < count) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return out; // truncated stream: keep what we have
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev < 0) {
      emit(code);
      prev = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = emit(code);
    } else if (code === next) {
      // KwKwK: prev's string + its own first byte
      let c = prev;
      while (prefix[c] >= 0) c = prefix[c];
      first = suffix[c];
      if (next < (1 << MAX_CODE_BITS)) {
        prefix[next] = prev;
        suffix[next] = first;
        length[next] = length[prev] + 1;
      }
      emit(code);
      prev = code;
      next++;
      if (next === (1 << codeSize) && codeSize < MAX_CODE_BITS) codeSize++;
      continue;
    } else {
      throw new Error("gif: bad LZW code");
    }
    if (next < (1 << MAX_CODE_BITS)) {
      prefix[next] = prev;
      suffix[next] = first;
      length[next] = length[prev] + 1;
      next++;
      if (next === (1 << codeSize) && codeSize < MAX_CODE_BITS) codeSize++;
    }
    prev = code;
  }
  return out;
}

export function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x38;
}

/** One composited frame of an animated GIF. */
export interface GifFrame {
  /** The logical screen after this frame is drawn, RGBA. */
  raster: Raster;
  /** Delay before the next frame, in milliseconds. */
  delayMs: number;
  /** The frame's own rectangle inside the logical screen. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** GIF disposal method: 0 unspecified, 1 keep, 2 background, 3 previous. */
  disposal: number;
}

export interface GifImage {
  width: number;
  height: number;
  frames: GifFrame[];
  /** Netscape loop count; 0 means forever, -1 when the file says nothing. */
  loopCount: number;
}

/**
 * Every frame of a GIF, composited onto the logical screen in order.
 *
 * Disposal is honoured between frames: method 2 clears the frame's own
 * rectangle to transparent before the next one draws, method 3 restores the
 * canvas as it stood before the frame, and 0/1 leave it in place. A frame's
 * transparent index leaves the canvas showing through rather than punching a
 * hole, which is what makes partial-update GIFs composite correctly.
 */
export function decodeGifFrames(bytes: Uint8Array): GifImage {
  if (!isGif(bytes)) throw new Error("gif: not a GIF");
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  const packed = bytes[10];
  let p = 13;
  let globalTable: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 3 * (1 << ((packed & 7) + 1));
    globalTable = bytes.subarray(p, p + n);
    p += n;
  }

  const frames: GifFrame[] = [];
  let loopCount = -1;
  // The running canvas every frame composites onto.
  const canvas = newRaster(width, height);
  // Graphic control state, which applies to the next image block only.
  let transparent = -1;
  let delayMs = 0;
  let disposal = 0;

  while (p < bytes.length) {
    const tag = bytes[p++];
    if (tag === 0x3b) break; // trailer
    if (tag === 0x21) { // extension
      const label = bytes[p++];
      if (label === 0xf9) {
        const size = bytes[p];
        const flags = bytes[p + 1];
        transparent = flags & 1 ? bytes[p + 4] : -1;
        disposal = (flags >> 2) & 7;
        delayMs = u16le(bytes, p + 2) * 10;
        p += size + 1;
        if (bytes[p] !== 0) {
          throw new Error("gif: bad graphic control extension");
        }
        p++;
      } else if (label === 0xff) {
        const nameLen = bytes[p];
        let name = "";
        for (let i = 1; i <= nameLen; i++) {
          name += String.fromCharCode(bytes[p + i]);
        }
        const [app, next] = subBlocks(bytes, p + nameLen + 1);
        // NETSCAPE2.0's sub-block 1 is [1, loop lo, loop hi].
        if (name.startsWith("NETSCAPE") && app.length >= 3 && app[0] === 1) {
          loopCount = app[1] | (app[2] << 8);
        }
        p = next;
      } else {
        [, p] = subBlocks(bytes, p);
      }
      continue;
    }
    if (tag !== 0x2c) {
      throw new Error(`gif: unexpected block 0x${tag.toString(16)}`);
    }
    const left = u16le(bytes, p), top = u16le(bytes, p + 2);
    const w = u16le(bytes, p + 4), h = u16le(bytes, p + 6);
    const flags = bytes[p + 8];
    p += 9;
    let table = globalTable;
    if (flags & 0x80) {
      const n = 3 * (1 << ((flags & 7) + 1));
      table = bytes.subarray(p, p + n);
      p += n;
    }
    if (!table) throw new Error("gif: frame has no colour table");
    const minCodeSize = bytes[p++];
    const [data, next] = subBlocks(bytes, p);
    p = next;
    const indices = lzwDecode(data, minCodeSize, w * h);
    const interlaced = (flags & 0x40) !== 0;
    // interlace passes: rows 0,8,16.. then 4,12.. then 2,6,10.. then 1,3,5..
    const rowOrder: number[] = [];
    if (interlaced) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = start; y < h; y += step) rowOrder.push(y);
      }
    } else {
      for (let y = 0; y < h; y++) rowOrder.push(y);
    }

    // Disposal 3 restores what stood here before this frame drew.
    const saved = disposal === 3 ? canvas.data.slice() : null;

    for (let r = 0; r < h; r++) {
      const y = rowOrder[r];
      const ty = top + y;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < w; x++) {
        const tx = left + x;
        if (tx < 0 || tx >= width) continue;
        const idx = indices[r * w + x];
        if (idx === transparent || idx * 3 + 2 >= table.length) continue;
        const d = (ty * width + tx) * 4;
        canvas.data[d] = table[idx * 3];
        canvas.data[d + 1] = table[idx * 3 + 1];
        canvas.data[d + 2] = table[idx * 3 + 2];
        canvas.data[d + 3] = 255;
      }
    }

    const shot = newRaster(width, height);
    shot.data.set(canvas.data);
    frames.push({
      raster: shot,
      delayMs,
      left,
      top,
      width: w,
      height: h,
      disposal,
    });

    if (disposal === 2) {
      for (let y = top; y < top + h && y < height; y++) {
        for (let x = left; x < left + w && x < width; x++) {
          const d = (y * width + x) * 4;
          canvas.data[d] =
            canvas.data[d + 1] =
            canvas.data[d + 2] =
            canvas.data[d + 3] =
              0;
        }
      }
    } else if (disposal === 3 && saved) {
      canvas.data.set(saved);
    }
    // The control block applies to one image; reset until the next one.
    transparent = -1;
    delayMs = 0;
    disposal = 0;
  }
  return { width, height, frames, loopCount };
}

/** Decode the first frame of a GIF to an RGBA raster of the logical screen. */
export function decodeGif(bytes: Uint8Array): Raster {
  const { width, height, frames } = decodeGifFrames(bytes);
  return frames.length ? frames[0].raster : newRaster(width, height);
}
