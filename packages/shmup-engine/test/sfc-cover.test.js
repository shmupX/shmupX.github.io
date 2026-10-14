// The Super Famicom shelf cover: which screenful it picks, and what it paints.
//
// Built from synthetic SRAM: a hand-built cart writes the four regions a
// cover reads — a palette row, a chip in the save's own sheet, a MAP GROUP
// word naming it, map cells naming that slot — and can therefore state what
// each pixel should be. The committed sample's scenery lives in the ROM's
// sheets, which is the case the cover answers null for without the ROM.

import { assert, assertEquals } from "@std/assert";
import {
  chipIndexOffset,
  chipRgba,
  composeSfcCover,
  encodeMapRow,
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

/** A 15-bit BGR colour word, little-endian, at a palette row's slot. */
function putColor(sram, row, index, r, g, b) {
  const word = (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
  const at = REGION.palette.offset + row * 32 + index * 2;
  sram[at] = word & 0xff;
  sram[at + 1] = word >> 8;
}

/** User chip `index` painted solid with colour `color`: four tiles of one index. */
function putSolidChip(sram, index, color) {
  const at = chipIndexOffset(index);
  for (const off of [0, 0x20, 0x200, 0x220]) {
    for (let y = 0; y < 8; y++) {
      sram[at + off + y * 2] = color & 1 ? 0xff : 0;
      sram[at + off + y * 2 + 1] = color & 2 ? 0xff : 0;
      sram[at + off + 16 + y * 2] = color & 4 ? 0xff : 0;
      sram[at + off + 16 + y * 2 + 1] = color & 8 ? 0xff : 0;
    }
  }
}

/** Stage `stage`'s MAP GROUP slot `slot` = user chip `index`. */
function putGroupWord(sram, stage, slot, index) {
  const at = REGION.mapGroup.offset + stage * 0x100 + slot * 2;
  sram[at] = index & 0xff;
  sram[at + 1] = index >> 8;
}

/** Cell (row, column) of a stage names `slot`, with flips. */
function putCell(
  sram,
  stage,
  row,
  column,
  slot,
  { hflip = false, vflip = false } = {},
) {
  const at = REGION.map.offset + stage * MAP_STAGE_BYTES + row * 18;
  const half = column >> 3, k = column & 7;
  sram[at + half * 9 + k] = (slot & 0x7f) | (hflip ? 0x80 : 0);
  if (vflip) sram[at + half * 9 + 8] |= 1 << (7 - k);
}

/**
 * A cart with a backdrop, one red chip in slot 7 of every stage, and the
 * cells listed as [stage, row, column, slot].
 */
function cart(cells, { graphics = true } = {}) {
  const sram = new Uint8Array(SRAM_BYTES);
  new TextEncoder().encodeInto(
    "T.TABATA",
    sram.subarray(REGION.checkString.offset),
  );
  // Row 0 colour 0 is the backdrop, a dark blue; colour 1 of rows 0-5 is red
  // ink — every stage draws through its own row (row n), so each gets it.
  putColor(sram, 0, 0, 4, 4, 8);
  for (let r = 0; r < 6; r++) putColor(sram, r, 1, 31, 0, 0);
  if (graphics) putSolidChip(sram, 9, 1);
  for (let s = 0; s < 6; s++) putGroupWord(sram, s, 7, 9);
  for (const [stage, row, column, slot, flips] of cells) {
    putCell(sram, stage, row, column, slot, flips);
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

Deno.test("windowCells counts cells naming a slot, flipped or not", () => {
  const parsed = cart([
    [0, 0, 0, 7],
    [0, 0, 15, 7, { hflip: true }],
    [0, 29, 3, 7],
    [0, 30, 3, 7, { vflip: true }],
  ]);
  const map = parsed.maps[0];
  assertEquals(windowCells(map, 0), 3);
  assertEquals(windowCells(map, 1), 2); // rows 1..30: loses row 0's two, gains row 30
});

Deno.test("a cell naming slot 0 is not a drawn cell", () => {
  const parsed = cart([[0, 4, 4, 0, { hflip: true }]]);
  assertEquals(windowCells(parsed.maps[0], 0), 0);
  assertEquals(pickSfcCoverWindow(parsed.maps), null);
  assertEquals(composeSfcCover(parsed), null);
});

Deno.test("pickSfcCoverWindow takes the busiest screenful across every stage", () => {
  const parsed = cart([
    [0, 0, 0, 7],
    [0, 1, 0, 7],
    // Stage 2 rows 40-42: three cells, so its window beats stage 0's two.
    [2, 40, 0, 7],
    [2, 41, 0, 7],
    [2, 42, 0, 7],
  ]);
  const pick = pickSfcCoverWindow(parsed.maps);
  assertEquals([pick.stage, pick.cells], [2, 3]);
  assertEquals(pick.top, 13);
  assertEquals(pickSfcCoverWindow(parsed.maps, { stage: 0 }).stage, 0);
});

Deno.test("ties go to the earliest stage and the lowest row", () => {
  const parsed = cart([[0, 50, 2, 7], [1, 50, 2, 7]]);
  const pick = pickSfcCoverWindow(parsed.maps);
  assertEquals([pick.stage, pick.top, pick.cells], [0, 21, 1]);
});

Deno.test("no sheets, no cover", () => {
  // The chip's bytes are zero: every pixel transparent, nothing drawn.
  assertEquals(
    composeSfcCover(cart([[0, 0, 0, 7]], { graphics: false })),
    null,
  );
  // A 64 KB dump has no GRAPIC DATA region at all, which is the same answer.
  assertEquals(composeSfcCover(parseSfcSav(new Uint8Array(0x10000))), null);
  assertEquals(composeSfcCover(null), null);
});

Deno.test("composeSfcCover paints the chip through the stage's palette row", () => {
  const parsed = cart([[0, 0, 0, 7]]);
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
  assertEquals([ink[0] > 200, ink[1], ink[2], ink[3]], [true, 0, 0, 255]);
  assertEquals(pixel(cover, 15, 15), ink);
  assertEquals(pixel(cover, 16, 0), backdrop);
  assertEquals(pixel(cover, 0, 16), backdrop);
  assert(backdrop[0] > 0 || backdrop[2] > 0);
  for (let i = 3; i < cover.rgba.length; i += 4) {
    assertEquals(cover.rgba[i], 255);
  }
});

Deno.test("a stage draws through its own row: stage 3 with no ink in row 3 paints nothing", () => {
  const parsed = cart([[3, 2, 2, 7]]);
  // take row 3's ink away: the chip's colour 1 is unset there
  putColor(parsed.bytes, 3, 1, 0, 0, 0);
  const again = parseSfcSav(parsed.bytes);
  const cover = composeSfcCover(again);
  assert(cover);
  assertEquals(
    pixel(cover, 32, 32),
    [0, 0, 0, 255],
    "black ink from row 3's unset colour 1",
  );
});

Deno.test("the window offsets the rows it paints", () => {
  const parsed = cart([[1, 40, 2, 7]]);
  const cover = composeSfcCover(parsed);
  assertEquals([cover.stage, cover.top], [1, 11]);
  assertEquals(pixel(cover, 32, 464)[0] > 200, true);
  assertEquals(pixel(cover, 32, 448), pixel(cover, 0, 0));
});

Deno.test("chipRgba reads a chip word through a row, with flips", () => {
  const parsed = cart([]);
  const art = {
    sram: parsed.bytes,
    rom: null,
    palettes: parsed.palettes.palettes,
  };
  const rgba = chipRgba(art, 9, 2);
  assertEquals(rgba.length, 16 * 16 * 4);
  assertEquals([rgba[0] > 200, rgba[1], rgba[2], rgba[3]], [true, 0, 0, 255]);
  assertEquals(chipRgba(art, 0x02a0, 0), null, "a ROM chip with no ROM");
  assertEquals(chipRgba(art, 0xffff, 0), null, "the empty word");
});

Deno.test("the same cart always composes the same cover", () => {
  const cells = [[0, 3, 3, 7], [3, 3, 3, 7]];
  const a = composeSfcCover(cart(cells));
  const b = composeSfcCover(cart(cells));
  assertEquals([a.stage, a.top, a.cells], [b.stage, b.top, b.cells]);
  assertEquals(a.rgba, b.rgba);
});
