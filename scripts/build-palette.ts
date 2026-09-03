// scripts/build-palette.ts — Dezaemon 2's editor palette as a PNG.
//
//   deno task deza:palette                → static/palette.png (+ palette-sheet.png)
//   deno task deza:palette --out path.png
//
// DEZA2.PAL on the disc is 18 rows x 16 entries of u16be Saturn RGB555 — the
// 192 system colours every save shares, the 4 user palettes (empty on the
// disc) and 2 rows of editor-UI entries; see
// packages/shmup-engine/src/palette/deza2-palette.js for the layout and the
// pixel-byte contract. This writes them as a 1 x 288 RGBA PNG, one pixel per
// entry in file order, served at https://codemonkey.games/palette.png so any
// tool can load the palette as an image (5->8 bit replication is lossless, so
// `channel >> 3` recovers the exact 5-bit values).
//
// The engine carries the same table verbatim (DEZA2_PALETTE_WORDS), so the
// PNG builds identically with or without a disc image in dev-fixtures/; when
// a disc IS present its DEZA2.PAL is read and checked against the table, and a
// mismatch fails the build rather than silently shipping one or the other.
//
// A second, human-sized image goes beside it: palette-sheet.png lays the same
// entries out 16 across x 18 down at 12 px a swatch, for README.md — the
// 1-pixel-wide strip is the machine-readable one, not a picture.
//
// Both are COMMITTED and served from static/, like mesh-library.json.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { findDiscFile } from "../lib/disc-file.ts";
import { encodePng, newRaster } from "../lib/ps2/png.ts";
import {
  DEZA2_PALETTE_COLS,
  DEZA2_PALETTE_ROWS,
  DEZA2_PALETTE_SIZE,
  DEZA2_PALETTE_WORDS,
  deza2PaletteRaster,
  deza2PaletteRgb,
} from "../packages/shmup-engine/src/palette/deza2-palette.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "static", "palette.png");
const SWATCH = 12;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

let out = DEFAULT_OUT;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") {
    const value = Deno.args[++i];
    if (value === undefined) fail("--out needs a value");
    out = resolve(value);
  } else {
    fail(`unknown argument ${arg}`);
  }
}

// The disc's own file, when one is around, must agree with the committed
// table — that is the whole point of carrying the table.
const disc = await findDiscFile(ROOT, "DEZA2.PAL");
if (disc) {
  if (disc.bytes.length !== DEZA2_PALETTE_SIZE * 2) {
    fail(
      `DEZA2.PAL from ${disc.from} is ${disc.bytes.length} bytes, expected ${
        DEZA2_PALETTE_SIZE * 2
      }`,
    );
  }
  const view = new DataView(
    disc.bytes.buffer,
    disc.bytes.byteOffset,
    disc.bytes.byteLength,
  );
  const bad: number[] = [];
  for (let i = 0; i < DEZA2_PALETTE_SIZE; i++) {
    if (view.getUint16(i * 2, false) !== DEZA2_PALETTE_WORDS[i]) bad.push(i);
  }
  if (bad.length) {
    fail(
      `DEZA2.PAL from ${disc.from} differs from DEZA2_PALETTE_WORDS at ${bad.length} entries (first: ${
        bad[0]
      })`,
    );
  }
  console.log(
    `DEZA2.PAL: ${disc.from} matches the engine table (${DEZA2_PALETTE_SIZE} entries)`,
  );
} else {
  console.log(
    "no disc image in dev-fixtures/ — building from the engine's DEZA2_PALETTE_WORDS",
  );
}

// 1 x 288: the machine-readable strip.
const strip = deza2PaletteRaster();
await Deno.writeFile(
  out,
  await encodePng({
    width: strip.width,
    height: strip.height,
    data: strip.data,
  }),
);
console.log(`wrote ${relative(ROOT, out)} (${strip.width}x${strip.height})`);

// 16 x 18 swatches: the picture for the docs.
const rgb = deza2PaletteRgb();
const sheet = newRaster(
  DEZA2_PALETTE_COLS * SWATCH,
  DEZA2_PALETTE_ROWS * SWATCH,
);
for (let i = 0; i < rgb.length; i++) {
  const col = i % DEZA2_PALETTE_COLS;
  const row = Math.floor(i / DEZA2_PALETTE_COLS);
  for (let y = 0; y < SWATCH; y++) {
    for (let x = 0; x < SWATCH; x++) {
      const o = ((row * SWATCH + y) * sheet.width + col * SWATCH + x) * 4;
      sheet.data[o] = rgb[i].r;
      sheet.data[o + 1] = rgb[i].g;
      sheet.data[o + 2] = rgb[i].b;
      sheet.data[o + 3] = 255;
    }
  }
}
const sheetOut = join(dirname(out), "palette-sheet.png");
await Deno.writeFile(sheetOut, await encodePng(sheet));
console.log(
  `wrote ${relative(ROOT, sheetOut)} (${sheet.width}x${sheet.height})`,
);
