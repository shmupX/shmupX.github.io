"use strict";

// Minimal PNG codec for the app icon (lib/app-icon.js).
//
// A Node port of lib/ps2/png.ts: this tool is plain Node with no build step
// and no dependencies, and the only PNGs it ever reads are the editor's atlas
// (a canvas.toDataURL, so 8-bit RGBA) and the base game's TexturePacker
// sheet, so it decodes 8/16-bit greyscale, RGB, palette and RGBA,
// non-interlaced, and encodes exactly one shape: 8-bit RGBA. Deflate is
// Node's own zlib.

const zlib = require("zlib");

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Bytes per complete pixel per colour type, at 8 bits per channel.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** An 8-bit RGBA image: `data` is width * height * 4 bytes, row-major. */
function newRaster(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function u32(bytes, at) {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) |
      bytes[at + 3]) >>> 0
  );
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Undo the per-scanline filter PNG applies before compression. `raw` holds
// `height` rows of (1 filter byte + `stride`).
function unfilter(raw, height, stride, bpp) {
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
      let restored;
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
          throw new Error("png: unknown row filter " + filter);
      }
      out[row + x] = restored & 0xff;
    }
    src += stride;
  }
  return out;
}

// One sample of `depth` bits from a packed scanline. Sub-byte samples are
// packed high bits first, which is how palette and low-bit greyscale arrive.
function sampleAt(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return row[index * 2]; // drop the low byte
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Decode a PNG (a Buffer or Uint8Array) into 8-bit RGBA. Throws on interlaced or truncated input. */
function decodePng(bytes) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("png: not a PNG file");
  }

  let width = 0, height = 0, depth = 0, colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

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
      palette = Uint8Array.from(body);
    } else if (type === "tRNS") {
      transparency = Uint8Array.from(body);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length; // length + type + body + CRC
  }

  if (!width || !height) throw new Error("png: missing or empty IHDR");
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error("png: unsupported colour type " + colorType);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idat));

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

// ------------------------------------------------------------------ encode

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([head, typed, crc]);
}

/** Encode an 8-bit RGBA raster as a PNG Buffer (no row filtering). */
function encodePng(raster) {
  const { width, height, data } = raster;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

module.exports = { decodePng, encodePng, newRaster };
