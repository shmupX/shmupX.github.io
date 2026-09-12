// Minimal PNG codec for the PS2 export.
//
// The pipeline needs to slice sprite frames out of the editor's atlases and
// write new, smaller ones, and the only PNG the runtime ever sees is one this
// file wrote — so this decodes the shapes the editor and TexturePacker
// actually emit (8/16-bit greyscale, RGB, palette and RGBA, non-interlaced)
// and encodes exactly one: 8-bit RGBA.

import { type Bytes, deflate, inflate } from "./deflate.ts";
import type { Indexed } from "./palette.ts";

export type { Bytes };

/** An 8-bit RGBA image. `data` is width * height * 4 bytes, row-major. */
export interface Raster {
  width: number;
  height: number;
  data: Bytes;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Bytes per complete pixel per colour type, at 8 bits per channel.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function newRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) |
      bytes[at + 3]) >>> 0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Undo the per-scanline filter PNG applies before compression. Operates in
// place on `raw`, which holds `height` rows of (1 filter byte + `stride`).
function unfilter(
  raw: Uint8Array,
  height: number,
  stride: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= bpp ? out[row + x - bpp] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`png: unknown row filter ${filter}`);
      }
      out[row + x] = restored & 0xff;
    }
    src += stride;
  }
  return out;
}

// Read one sample of `depth` bits from a packed scanline. Sub-byte samples are
// packed high bits first, which is how palette and low-bit greyscale arrive.
function sampleAt(row: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return row[index];
  if (depth === 16) return row[index * 2]; // drop the low byte
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Decode a PNG into 8-bit RGBA. Throws on interlaced or truncated input. */
export async function decodePng(bytes: Bytes): Promise<Raster> {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("png: not a PNG file");
  }

  let width = 0, height = 0, depth = 0, colorType = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(
      bytes[at + 4],
      bytes[at + 5],
      bytes[at + 6],
      bytes[at + 7],
    );
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) {
        throw new Error("png: interlaced PNGs are not supported");
      }
    } else if (type === "PLTE") {
      palette = body.slice();
    } else if (type === "tRNS") {
      transparency = body.slice();
    } else if (type === "IDAT") {
      idat.push(body.slice());
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length; // length + type + body + CRC
  }

  if (!width || !height) throw new Error("png: missing or empty IHDR");
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`png: unsupported colour type ${colorType}`);
  }

  const merged = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of idat) {
    merged.set(part, offset);
    offset += part.length;
  }
  const inflated = await inflate(merged);

  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (inflated.length < height * (stride + 1)) {
    throw new Error("png: pixel data is shorter than the declared image");
  }
  const raw = unfilter(inflated, height, stride, bpp);

  const out = newRaster(width, height);
  const max = (1 << Math.min(depth, 8)) - 1;
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      if (colorType === 3) {
        const index = sampleAt(row, x, depth);
        const src = index * 3;
        out.data[dst] = palette ? palette[src] : 0;
        out.data[dst + 1] = palette ? palette[src + 1] : 0;
        out.data[dst + 2] = palette ? palette[src + 2] : 0;
        out.data[dst + 3] = transparency && index < transparency.length
          ? transparency[index]
          : 255;
        continue;
      }
      const base = x * channels;
      const scale = depth === 16 ? 1 : 255 / max;
      if (colorType === 0 || colorType === 4) {
        const grey = Math.round(sampleAt(row, base, depth) * scale);
        out.data[dst] = grey;
        out.data[dst + 1] = grey;
        out.data[dst + 2] = grey;
        out.data[dst + 3] = colorType === 4
          ? Math.round(sampleAt(row, base + 1, depth) * scale)
          : 255;
      } else {
        out.data[dst] = Math.round(sampleAt(row, base, depth) * scale);
        out.data[dst + 1] = Math.round(sampleAt(row, base + 1, depth) * scale);
        out.data[dst + 2] = Math.round(sampleAt(row, base + 2, depth) * scale);
        out.data[dst + 3] = colorType === 6
          ? Math.round(sampleAt(row, base + 3, depth) * scale)
          : 255;
      }
    }
  }
  return out;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Bytes {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

// Try all five filters per scanline and keep the one with the smallest sum of
// absolute deviations — the heuristic libpng uses. Sprite sheets are mostly
// flat colour and transparent padding, where this pays for itself several
// times over in ISO size.
function filterRows(raster: Raster): Bytes {
  const { width, height, data } = raster;
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  let dst = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let bestFilter = 0;
    let bestScore = Infinity;
    let best = new Uint8Array(0);
    for (let filter = 0; filter < 5; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const value = data[row + x];
        const left = x >= 4 ? data[row + x - 4] : 0;
        const up = y > 0 ? data[prev + x] : 0;
        const upLeft = y > 0 && x >= 4 ? data[prev + x - 4] : 0;
        let encoded: number;
        switch (filter) {
          case 0:
            encoded = value;
            break;
          case 1:
            encoded = value - left;
            break;
          case 2:
            encoded = value - up;
            break;
          case 3:
            encoded = value - ((left + up) >> 1);
            break;
          default:
            encoded = value - paeth(left, up, upLeft);
            break;
        }
        encoded &= 0xff;
        candidate[x] = encoded;
        score += encoded < 128 ? encoded : 256 - encoded;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best = candidate.slice();
      }
    }
    out[dst++] = bestFilter;
    out.set(best, dst);
    dst += stride;
  }
  return out;
}

/**
 * Encode an 8-bit indexed PNG — colour type 3, the form AthenaEnv uploads as
 * a GS_PSM_T8 texture at a quarter of the VRAM.
 *
 * tRNS is written only as long as the palette's non-opaque run, because
 * AthenaEnv defaults entries it does not cover to PS2-opaque 0x80 and
 * halves the ones it does (`trans[i] >> 1`) — an opaque 255 covered by tRNS
 * would come back as 127 and make solid pixels faintly see-through. See
 * palette.ts, which orders the palette to make that run contiguous.
 *
 * Rows are written unfiltered: the bytes are palette indices, and the
 * predictors PNG offers are arithmetic on neighbouring pixels, which turns
 * flat runs of one index into noise that deflate then has to carry.
 */
export async function encodeIndexedPng(image: Indexed): Promise<Bytes> {
  const { width, height, indices, palette } = image;

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed
  const plte = new Uint8Array(palette.count * 3);
  for (let i = 0; i < palette.count; i++) {
    plte[i * 3] = palette.colors[i * 4];
    plte[i * 3 + 1] = palette.colors[i * 4 + 1];
    plte[i * 3 + 2] = palette.colors[i * 4 + 2];
  }

  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
  ];
  if (palette.transparentCount > 0) {
    const trns = new Uint8Array(palette.transparentCount);
    for (let i = 0; i < palette.transparentCount; i++) {
      trns[i] = palette.colors[i * 4 + 3];
    }
    parts.push(chunk("tRNS", trns));
  }
  parts.push(chunk("IDAT", await deflate(raw)));
  parts.push(chunk("IEND", new Uint8Array(0)));

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Encode an 8-bit RGBA raster as a PNG. */
export async function encodePng(raster: Raster): Promise<Bytes> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, raster.width);
  view.setUint32(4, raster.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = await deflate(filterRows(raster));
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Decode a `data:image/png;base64,...` URL as produced by canvas.toDataURL. */
export function decodeDataUrl(dataUrl: string): Promise<Raster> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("png: not a data URL");
  const body = dataUrl.slice(comma + 1);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decodePng(bytes);
}
