// A minimal PNG writer, and the pixel formats the Dezaemon 2 disc draws in.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/**
 * Encode 8-bit samples as a PNG: one sample per pixel for greyscale, three for
 * RGB. `samples.length` decides which.
 */
export async function encodePng(
  width: number,
  height: number,
  samples: Uint8Array,
): Promise<Uint8Array> {
  const channels = samples.length / (width * height);
  if (channels !== 1 && channels !== 3) {
    throw new Error(`${samples.length} samples is neither grey nor RGB`);
  }
  const rowBytes = width * channels;
  // One filter byte (0 = none) per scanline, then the row's samples.
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    raw.set(
      samples.subarray(y * rowBytes, (y + 1) * rowBytes),
      y * (1 + rowBytes) + 1,
    );
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 3 ? 2 : 0; // colour type: truecolour or greyscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

export interface UnpackOptions {
  /** Pixels per row. Editor screens are 320; the label atlas is 64. */
  width: number;
  /** 8 for the editor screens and the atlas, 4 for the help overlays. */
  bpp: 4 | 8;
  /** Row range, half-open. Defaults to the whole image. */
  from?: number;
  to?: number;
}

export interface Raster {
  width: number;
  height: number;
  /** One palette index per pixel. */
  indices: Uint8Array;
  /** How many distinct indices occur — a sanity check on the format guess. */
  distinct: number;
}

/**
 * Unpack linear paletted pixels. Both of the disc's layouts are plain scanline
 * order with no tiling, which is why a wrong `width` shears the image
 * diagonally rather than scrambling it — a useful signal when probing an
 * unknown file.
 */
export function unpackPixels(bytes: Uint8Array, opts: UnpackOptions): Raster {
  const { width, bpp } = opts;
  const stride = (width * bpp) / 8;
  if (!Number.isInteger(stride)) {
    throw new Error(
      `width ${width} is not a whole number of bytes at ${bpp}bpp`,
    );
  }
  const rows = Math.floor(bytes.length / stride);
  const from = Math.max(0, Math.min(rows, opts.from ?? 0));
  const to = Math.max(from, Math.min(rows, opts.to ?? rows));
  const height = to - from;

  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (from + y) * stride;
    for (let x = 0; x < width; x++) {
      if (bpp === 8) {
        indices[y * width + x] = bytes[row + x];
      } else {
        const b = bytes[row + (x >> 1)];
        indices[y * width + x] = x & 1 ? b & 0x0f : b >> 4;
      }
    }
  }
  return { width, height, indices, distinct: new Set(indices).size };
}

/**
 * DEZA2.PAL is 288 u16 big-endian RGB555 entries with no header. An 8bpp pixel
 * is `(palette << 4) | colour` — the same convention the save's CG pages use
 * (see SECTION_HINTS in packages/shmup-engine/src/decompress.js) — so the
 * pixel value indexes this flat table directly.
 */
export function parsePalette(bytes: Uint8Array): Uint8Array {
  const entries = Math.floor(bytes.length / 2);
  const rgb = new Uint8Array(entries * 3);
  for (let i = 0; i < entries; i++) {
    const w = (bytes[2 * i] << 8) | bytes[2 * i + 1];
    rgb[3 * i] = ((w >> 10) & 31) * 8;
    rgb[3 * i + 1] = ((w >> 5) & 31) * 8;
    rgb[3 * i + 2] = (w & 31) * 8;
  }
  return rgb;
}

function upscale(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  scale: number,
): Uint8Array {
  if (scale <= 1) return src;
  const outW = width * scale;
  const out = new Uint8Array(outW * height * scale * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * channels;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const to = ((y * scale + dy) * outW + x * scale + dx) * channels;
          for (let c = 0; c < channels; c++) out[to + c] = src[from + c];
        }
      }
    }
  }
  return out;
}

/** Colour a raster through DEZA2.PAL. Out-of-range indices go magenta. */
export function toRgb(
  raster: Raster,
  palette: Uint8Array,
  scale = 1,
): Uint8Array {
  const { width, height, indices } = raster;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i] * 3;
    if (at + 2 < palette.length) {
      rgb[3 * i] = palette[at];
      rgb[3 * i + 1] = palette[at + 1];
      rgb[3 * i + 2] = palette[at + 2];
    } else {
      rgb[3 * i] = 255;
      rgb[3 * i + 2] = 255;
    }
  }
  return upscale(rgb, width, height, 3, scale);
}

/**
 * Grey a raster. With no palette to hand, the indices actually present are
 * spread over 0-255 — rendering them raw is near-black, because these screens
 * use indices in the teens and twenties.
 */
export function toGrey(raster: Raster, equalise = true, scale = 1): Uint8Array {
  const { width, height, indices } = raster;
  const seen = [...new Set(indices)].sort((a, b) => a - b);
  const lut = new Uint8Array(256);
  if (!equalise) {
    for (let i = 0; i < 256; i++) lut[i] = i;
  } else {
    seen.forEach((v, i) => {
      lut[v] = seen.length < 2
        ? 255
        : Math.round((255 * i) / (seen.length - 1));
    });
  }
  const grey = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) grey[i] = lut[indices[i]];
  return upscale(grey, width, height, 1, scale);
}
