// SNES planar tile codec (FORMAT-SFC.md "GRAPIC DATA"). Synthetic bytes only —
// the sample fixture's graphics bank is blank, so these lock the bit layout.

import { assertEquals, assertThrows } from "@std/assert";
import {
  assemble2x2,
  decodeTile2bpp,
  decodeTile4bpp,
  decodeTileSheet,
  encodeTile2bpp,
  encodeTile4bpp,
  flipTile,
  TILE_BYTES_4BPP,
  tileIsBlank,
  tilesToIndexed,
  withPaletteRow,
} from "../src/sfc/tiles.js";

Deno.test("decodeTile4bpp reads bitplanes 0-3 from the two 16-byte halves", () => {
  const bytes = new Uint8Array(TILE_BYTES_4BPP);
  // Row 0: bit 7 set in every plane -> pixel 0 = 15; bit 0 set in planes 0
  // and 2 only -> pixel 7 = 5.
  bytes[0] = 0x81;
  bytes[1] = 0x80;
  bytes[16] = 0x81;
  bytes[17] = 0x80;
  // Row 3: plane 3 only, every bit -> the whole row is 8.
  bytes[16 + 3 * 2 + 1] = 0xff;
  const px = decodeTile4bpp(bytes, 0);
  assertEquals(px[0], 15);
  assertEquals(px[1], 0);
  assertEquals(px[7], 5);
  for (let x = 0; x < 8; x++) assertEquals(px[3 * 8 + x], 8);
  assertEquals(px.length, 64);
});

Deno.test("encodeTile4bpp round-trips every index 0-15", () => {
  const indices = new Uint8Array(64);
  for (let i = 0; i < 64; i++) indices[i] = (i * 7 + (i >> 2)) & 15;
  assertEquals(new Set(indices).size, 16);
  assertEquals(decodeTile4bpp(encodeTile4bpp(indices), 0), indices);
});

Deno.test("2bpp tiles use only the first two planes and round-trip", () => {
  const bytes = new Uint8Array(16);
  bytes[0] = 0x80; // row 0 pixel 0: plane 0
  bytes[1] = 0x81; // row 0 pixels 0 and 7: plane 1
  const px = decodeTile2bpp(bytes, 0);
  assertEquals(px[0], 3);
  assertEquals(px[7], 2);
  const indices = new Uint8Array(64);
  for (let i = 0; i < 64; i++) indices[i] = i & 3;
  assertEquals(decodeTile2bpp(encodeTile2bpp(indices), 0), indices);
});

Deno.test("decodeTileSheet takes consecutive tiles and rejects an overrun", () => {
  const bytes = new Uint8Array(TILE_BYTES_4BPP * 3);
  bytes[TILE_BYTES_4BPP * 2] = 0xff; // tile 2, row 0, plane 0
  const tiles = decodeTileSheet(bytes, 0, 3);
  assertEquals(tiles.length, 3);
  assertEquals(tileIsBlank(tiles[0]), true);
  assertEquals(tileIsBlank(tiles[2]), false);
  assertEquals(Array.from(tiles[2].subarray(0, 8)), [1, 1, 1, 1, 1, 1, 1, 1]);
  assertThrows(() => decodeTileSheet(bytes, 0, 4), Error, "run past the end");
});

Deno.test("tilesToIndexed lays 16 tiles per row", () => {
  const tiles = [];
  for (let t = 0; t < 17; t++) tiles.push(new Uint8Array(64).fill(t + 1));
  const sheet = tilesToIndexed(tiles, 16);
  assertEquals(sheet.width, 128);
  assertEquals(sheet.height, 16);
  assertEquals(sheet.indices[0], 1);
  assertEquals(sheet.indices[8 * 15], 16); // tile 15, first pixel
  assertEquals(sheet.indices[8 * 128], 17); // tile 16 wraps to row 2
});

Deno.test("withPaletteRow tags opaque pixels and leaves index 0 transparent", () => {
  const tagged = withPaletteRow(new Uint8Array([0, 1, 15, 0]), 3);
  assertEquals(Array.from(tagged), [0, 0x31, 0x3f, 0]);
});

Deno.test("flipTile mirrors and assemble2x2 builds a 16x16 raster", () => {
  const tile = new Uint8Array(64);
  tile[0] = 1; // top-left pixel
  assertEquals(flipTile(tile, true, false)[7], 1);
  assertEquals(flipTile(tile, false, true)[7 * 8], 1);
  assertEquals(flipTile(tile, true, true)[63], 1);
  assertEquals(flipTile(tile, false, false), tile);
  const br = new Uint8Array(64).fill(9);
  const quad = assemble2x2([tile, tile, new Uint8Array(64), br]);
  assertEquals(quad.length, 256);
  assertEquals(quad[0], 1);
  assertEquals(quad[8], 1); // top-right tile's first pixel
  assertEquals(quad[8 * 16 + 8], 9); // bottom-right
  assertEquals(quad[8 * 16], 0); // bottom-left, blank
});
