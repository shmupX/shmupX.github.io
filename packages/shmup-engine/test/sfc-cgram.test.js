// PALETTE DATA rows (FORMAT-SFC.md "PALETTE DATA") — the reader half of
// palette-target.js's snesCgramBytes().

import { assertEquals, assertThrows } from "@std/assert";
import { snesCgramBytes } from "../src/palette/palette-target.js";
import {
  decodeCgramRow,
  decodeCgramRows,
  decodePaletteData,
  isColorRow,
  PALETTE_ROW_COUNT,
  rowsToPalettes,
} from "../src/sfc/cgram.js";
import { REGION } from "../src/sfc/regions.js";
import { indexedToRgba } from "../src/decode/decode-cg.js";

Deno.test("decodeCgramRow inverts snesCgramBytes", () => {
  const bank = new Uint16Array(256);
  for (let i = 0; i < 256; i++) bank[i] = (i * 2557) & 0x7fff;
  const bytes = snesCgramBytes(bank);
  const rows = decodeCgramRows(bytes, 0, 16);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const i = r * 16 + c;
      assertEquals(rows[r].raw[c], i === 0 ? 0 : bank[i] & 0x7fff);
    }
  }
  assertEquals(rows.every((row) => row.color), true);
});

Deno.test("colour words are little-endian BGR555 with bit replication", () => {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xff;
  bytes[1] = 0x7f; // white
  bytes[2] = 0x1f;
  bytes[3] = 0x00; // pure red (low bits)
  bytes[4] = 0x00;
  bytes[5] = 0x7c; // pure blue (bits 10-14)
  const row = decodeCgramRow(bytes, 0);
  assertEquals(row.colors[0], { raw: 0x7fff, r: 255, g: 255, b: 255 });
  assertEquals(row.colors[1], { raw: 0x001f, r: 255, g: 0, b: 0 });
  assertEquals(row.colors[2], { raw: 0x7c00, r: 0, g: 0, b: 255 });
  assertThrows(() => decodeCgramRow(bytes, 8), Error, "runs past the end");
});

Deno.test("isColorRow rejects a word with bit 15 set", () => {
  const bytes = new Uint8Array(64);
  assertEquals(isColorRow(bytes, 0), true);
  bytes[32 + 5] = 0x80; // word 2 of row 1
  assertEquals(isColorRow(bytes, 32), false);
  assertEquals(decodeCgramRow(bytes, 32).color, false);
  assertEquals(isColorRow(bytes, 40), false); // runs past the end
});

Deno.test("decodePaletteData reads 24 rows from 0x40 in the shape indexedToRgba takes", () => {
  const bytes = new Uint8Array(0x20000);
  bytes[REGION.palette.offset + 2] = 0x1f; // row 0 colour 1 = red
  bytes[REGION.palette.end - 1] = 0x80; // last word of the last row: not colour
  const data = decodePaletteData(bytes);
  assertEquals(PALETTE_ROW_COUNT, 24);
  assertEquals(data.rows.length, 24);
  assertEquals(data.rows[0].offset, 0x40);
  assertEquals(data.rows[23].offset, 0x320);
  assertEquals(data.colorRowCount, 23);
  assertEquals(data.allColor, false);
  const rgba = indexedToRgba(
    new Uint8Array([0x01, 0x00]),
    rowsToPalettes(data.rows),
  );
  assertEquals(Array.from(rgba), [255, 0, 0, 255, 0, 0, 0, 0]);
});
