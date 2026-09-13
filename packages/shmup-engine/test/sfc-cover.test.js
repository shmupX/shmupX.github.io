// The Super Famicom shelf cover: which screenful it picks, and what it paints.
//
// Built from synthetic SRAM rather than a dump, because the one SNES save this
// repo can commit (dev-fixtures/debug-tools/Dez SNES.sav, the ROM's own default
// image) has a BLANK graphics bank — it is exactly the case composeSfcCover
// answers null for, so it can prove the refusal and nothing else. A hand-built
// cart writes the four regions a cover reads and can therefore state what each
// pixel should be.

import { assert, assertEquals } from "@std/assert";
import {
  chipRgba,
  composeSfcCover,
  MAP_COLUMNS,
  parseSfcSav,
  pickSfcCoverWindow,
  REGION,
  SFC_COVER_COLUMNS,
  SFC_COVER_H,
  SFC_COVER_ROWS,
  SFC_COVER_W,
  windowCells,
} from "../src/sfc/index.js";

const SRAM_BYTES = 0x20000;
const MAP_STAGE_BYTES = REGION.map.length / 6;
const TILE_BYTES = 32;

/** A 15-bit BGR colour word, little-endian, at a palette row's slot. */
function putColor(sram, row, index, r, g, b) {
  const word = (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
  const at = REGION.palette.offset + row * 32 + index * 2;
  sram[at] = word & 0xff;
  sram[at + 1] = word >> 8;
}

/** A solid 8x8 4bpp tile of one colour index, at tile number `tile`. */
function putSolidTile(sram, tile, index) {
  const at = REGION.graphics.offset + tile * TILE_BYTES;
  for (let y = 0; y < 8; y++) {
    // Every pixel of the row takes the same index, so each plane byte is
    // either 0x00 or 0xFF depending on that index's bit.
    sram[at + y * 2] = index & 1 ? 0xff : 0;
    sram[at + y * 2 + 1] = index & 2 ? 0xff : 0;
    sram[at + 16 + y * 2] = index & 4 ? 0xff : 0;
    sram[at + 16 + y * 2 + 1] = index & 8 ? 0xff : 0;
  }
}

/** MAP GROUP chip `chip` as four tilemap words on palette row `row`. */
function putChip(sram, chip, tiles, row) {
  const at = REGION.mapGroup.offset + chip * 8;
  tiles.forEach((tile, i) => {
    const word = (tile & 0x03ff) | ((row & 7) << 10);
    sram[at + i * 2] = word & 0xff;
    sram[at + i * 2 + 1] = word >> 8;
  });
}

function putCell(sram, stage, row, column, value) {
  sram[
    REGION.map.offset + stage * MAP_STAGE_BYTES + row * MAP_COLUMNS +
    column
  ] = value;
}

/**
 * A cart with a backdrop, one chip drawn in a named colour, and nothing else.
 * `cells` is a list of [stage, row, column, chipValue].
 */
function cart(cells, { graphics = true } = {}) {
  const sram = new Uint8Array(SRAM_BYTES);
  // "T.TABATA" — not read by the cover, but it keeps the parse honest.
  new TextEncoder().encodeInto(
    "T.TABATA",
    sram.subarray(REGION.checkString.offset),
  );
  // Row 0 colour 0 is the backdrop: a dark blue nothing else can be confused
  // with. Row 3 colour 1 is the chip's ink, on a row that is NOT row 0 so a
  // composer that ignored the quad's palette bits would paint the wrong thing.
  putColor(sram, 0, 0, 4, 4, 8);
  putColor(sram, 3, 1, 31, 0, 0);
  if (graphics) {
    putSolidTile(sram, 1, 1);
    putChip(sram, 7, [1, 1, 1, 1], 3);
  }
  for (const [stage, row, column, value] of cells) {
    putCell(sram, stage, row, column, value);
  }
  return parseSfcSav(sram);
}

function pixel(cover, x, y) {
  const at = (y * cover.w + x) * 4;
  return [
    cover.rgba[at],
    cover.rgba[at + 1],
    cover.rgba[at + 2],
    cover.rgba[at + 3],
  ];
}

Deno.test("the cover is 256x480: 16 map columns by 30 map rows", () => {
  assertEquals([SFC_COVER_W, SFC_COVER_H], [256, 480]);
  assertEquals([SFC_COVER_COLUMNS, SFC_COVER_ROWS], [16, 30]);
});

Deno.test("windowCells counts the cropped columns only, and masks bit 7", () => {
  const parsed = cart([
    [0, 0, 0, 0x09], // column 0: inside the crop
    [0, 0, 15, 0x89], // column 15 with bit 7 set: still a drawn cell
    [0, 0, 16, 0x09], // column 16: outside the crop, never counted
    [0, 0, 17, 0x09], // column 17: likewise
    [0, 29, 3, 0x09], // last row of the first window
    [0, 30, 3, 0x09], // one row past it
  ]);
  const map = parsed.maps[0];
  assertEquals(windowCells(map, 0), 3);
  assertEquals(windowCells(map, 1), 2); // rows 1..30: loses row 0's two, gains row 30
});

Deno.test("a cell whose low seven bits are zero is not a drawn cell", () => {
  const parsed = cart([[0, 4, 4, 0x80]]);
  assertEquals(windowCells(parsed.maps[0], 0), 0);
  assertEquals(pickSfcCoverWindow(parsed.maps), null);
  assertEquals(composeSfcCover(parsed), null);
});

Deno.test("pickSfcCoverWindow takes the busiest screenful across every stage", () => {
  const parsed = cart([
    [0, 0, 0, 0x07],
    [0, 1, 0, 0x07],
    // Stage 2 rows 40-42: three cells, so its window beats stage 0's two.
    [2, 40, 0, 0x07],
    [2, 41, 0, 0x07],
    [2, 42, 0, 0x07],
  ]);
  const pick = pickSfcCoverWindow(parsed.maps);
  assertEquals([pick.stage, pick.cells], [2, 3]);
  // Rows 40-42 are inside every window from 13 to 40; the lowest wins.
  assertEquals(pick.top, 13);
  // …and a pinned stage is obeyed even when another stage is busier.
  assertEquals(pickSfcCoverWindow(parsed.maps, { stage: 0 }).stage, 0);
});

Deno.test("ties go to the earliest stage and the lowest row", () => {
  const parsed = cart([[0, 50, 2, 0x07], [1, 50, 2, 0x07]]);
  const pick = pickSfcCoverWindow(parsed.maps);
  assertEquals([pick.stage, pick.top, pick.cells], [0, 21, 1]);
});

Deno.test("no graphics bank, no cover", () => {
  assertEquals(
    composeSfcCover(cart([[0, 0, 0, 0x07]], { graphics: false })),
    null,
  );
  // A 64 KB dump has no GRAPIC DATA region at all, which is the same answer.
  const short = new Uint8Array(0x10000);
  assertEquals(composeSfcCover(parseSfcSav(short)), null);
  assertEquals(composeSfcCover(null), null);
});

Deno.test("composeSfcCover paints the chip through its own palette row", () => {
  // rgb555 31 -> 8-bit: the decoder scales the 5-bit channel to 0-255.
  const parsed = cart([[0, 0, 0, 0x07]]);
  const cover = composeSfcCover(parsed);
  assert(cover);
  assertEquals([cover.w, cover.h, cover.stage, cover.top, cover.cells], [
    256,
    480,
    0,
    0,
    1,
  ]);
  assertEquals(cover.rgba.length, 256 * 480 * 4);
  const ink = pixel(cover, 0, 0);
  const backdrop = pixel(cover, 255, 479);
  // Red ink, from row 3 — a composer reading row 0 would find colour 1 unset
  // there and paint black instead.
  assertEquals([ink[0] > 200, ink[1], ink[2], ink[3]], [true, 0, 0, 255]);
  // The chip is 16x16 and stops there.
  assertEquals(pixel(cover, 15, 15), ink);
  assertEquals(pixel(cover, 16, 0), backdrop);
  assertEquals(pixel(cover, 0, 16), backdrop);
  // The backdrop is row 0 colour 0, opaque everywhere — never a transparent PNG.
  assert(backdrop[0] > 0 || backdrop[2] > 0);
  assertEquals(backdrop[3], 255);
  for (let i = 3; i < cover.rgba.length; i += 4) {
    assertEquals(cover.rgba[i], 255);
  }
});

Deno.test("the window offsets the rows it paints", () => {
  const parsed = cart([[1, 40, 2, 0x07]]);
  const cover = composeSfcCover(parsed);
  assertEquals([cover.stage, cover.top], [1, 11]);
  // Map row 40 is the 29th row of a window starting at 11 -> y 464.
  assertEquals(pixel(cover, 32, 464)[0] > 200, true);
  assertEquals(pixel(cover, 32, 448), pixel(cover, 0, 0));
});

Deno.test("chipRgba reads the palette off the quad, not off row 0", () => {
  const parsed = cart([]);
  const art = {
    tiles: parsed.graphics.tiles,
    chips: parsed.groups.map,
    palettes: parsed.palettes.palettes,
  };
  const rgba = chipRgba(art, parsed.groups.map[7].entries);
  assertEquals(rgba.length, 16 * 16 * 4);
  assertEquals([rgba[0] > 200, rgba[1], rgba[2], rgba[3]], [true, 0, 0, 255]);
});

Deno.test("the same cart always composes the same cover", () => {
  const cells = [[0, 3, 3, 0x07], [3, 3, 3, 0x07]];
  const a = composeSfcCover(cart(cells));
  const b = composeSfcCover(cart(cells));
  assertEquals([a.stage, a.top, a.cells], [b.stage, b.top, b.cells]);
  assertEquals(a.rgba, b.rgba);
});
