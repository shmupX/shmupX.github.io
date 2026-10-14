// Chip words and ODR bytes: the codec, the sheet geometry, and a chip's
// pixels read back from where the word points.

import { assertEquals, assertThrows } from "@std/assert";
import {
  CHIP_BLANK_WORD,
  CHIP_EMPTY_WORD,
  chipIndexOffset,
  chipSlotTile,
  chipSource,
  chipWordForIndex,
  decodeChipPixels,
  decodeChipWord,
  decodeOdrByte,
  encodeChipPixels,
  encodeChipWord,
  encodeOdrByte,
  flipChip,
  USER_CHIP_COUNT,
  userSheetIndexed,
} from "../src/sfc/chips.js";
import { readWords, writeWords } from "../src/sfc/tilemap.js";
import { REGION } from "../src/sfc/regions.js";

Deno.test("a chip word is sheet, row, column and flips; a user chip's index is its word", () => {
  assertEquals(decodeChipWord(0x0000), {
    word: 0,
    sheet: 0,
    row: 0,
    col: 0,
    hflip: false,
    vflip: false,
    empty: false,
    user: true,
    rom: false,
    index: 0,
  });
  const d = decodeChipWord(0x41f5); // sheet 1, row 30, col 5, h-flipped
  assertEquals([d.sheet, d.row, d.col, d.hflip, d.vflip, d.index], [
    1,
    30,
    5,
    true,
    false,
    256 + 30 * 8 + 5,
  ]);
  assertEquals(decodeChipWord(0x02a0).rom, true);
  assertEquals(decodeChipWord(0x02a0).index, null);
  assertEquals(decodeChipWord(CHIP_EMPTY_WORD).empty, true);
  assertEquals(decodeChipWord(CHIP_BLANK_WORD).empty, true);
  assertEquals(
    decodeChipWord(0x83ff).empty,
    true,
    "a flipped blank is still blank",
  );
  for (const w of [0, 0x1f7, 0x02a0, 0x03fe, 0x41f5, 0x81f5, 0xc1f5]) {
    assertEquals(encodeChipWord(decodeChipWord(w)), w);
  }
  for (let i = 0; i < USER_CHIP_COUNT; i += 37) {
    assertEquals(chipWordForIndex(i), i);
  }
  assertEquals(chipWordForIndex(5, { hflip: true, vflip: true }), 5 | 0xc000);
  assertThrows(() => chipWordForIndex(USER_CHIP_COUNT));
});

Deno.test("the sheet table: user words read the save, 0x200-0x3FF the ROM, and the blank chip is sheet 3's last", () => {
  assertEquals(chipSource(0x0000), {
    source: "sram",
    offset: 0x10000,
    sheet: 0,
    row: 0,
    col: 0,
  });
  assertEquals(chipSource(0x0100), {
    source: "sram",
    offset: 0x18000,
    sheet: 1,
    row: 0,
    col: 0,
  });
  assertEquals(chipSource(0x0009).offset, 0x10000 + 0x400 + 0x40);
  assertEquals(chipSource(0x02a0), {
    source: "rom",
    offset: 0x40000 + 20 * 0x400,
    sheet: 2,
    row: 20,
    col: 0,
  });
  assertEquals(chipSource(0x03fe).offset, 0x48000 + 31 * 0x400 + 6 * 0x40);
  assertEquals(chipSource(0x03ff), null, "the blank chip");
  assertEquals(chipSource(0xffff), null);
  assertEquals(chipSource(0x0500), null, "sheets past the table read code");
  assertEquals(chipIndexOffset(0), REGION.graphics.offset);
  assertEquals(
    chipIndexOffset(511),
    REGION.graphics.offset + 0x8000 + 31 * 0x400 + 7 * 0x40,
  );
  // slot i of an assembled sheet lands at tile (i>>3)*32 + (i&7)*2
  assertEquals([
    chipSlotTile(0),
    chipSlotTile(1),
    chipSlotTile(8),
    chipSlotTile(63),
  ], [0, 2, 32, 7 * 32 + 14]);
});

Deno.test("encodeChipPixels writes the four tiles a word reads back, flips included", () => {
  const sram = new Uint8Array(0x20000);
  const px = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) px[y * 16 + x] = (x + y) & 0x0f;
  }
  encodeChipPixels(sram, 300, px);
  const at = chipIndexOffset(300);
  assertEquals(
    sram[at] !== 0 || sram[at + 1] !== 0,
    true,
    "the top-left tile is written",
  );
  assertEquals(
    Array.from(decodeChipPixels(chipWordForIndex(300), { sram })),
    Array.from(px),
  );
  const h = decodeChipPixels(chipWordForIndex(300, { hflip: true }), { sram });
  assertEquals(Array.from(h), Array.from(flipChip(px, true, false)));
  const v = decodeChipPixels(chipWordForIndex(300, { vflip: true }), { sram });
  assertEquals(v[0], px[15 * 16]);
  assertEquals(
    decodeChipPixels(0x02a0, { sram }),
    null,
    "a ROM chip without the ROM",
  );
  assertEquals(
    decodeChipPixels(0x02a0, { sram, rom: new Uint8Array(0x80000) }).length,
    256,
  );
  assertEquals(
    decodeChipPixels(chipWordForIndex(300), { sram: new Uint8Array(0x10000) }),
    null,
    "a half dump has no sheets",
  );
  // the sheet raster puts chip 300 (sheet 1, row 5, col 4) at (64, 80)
  const sheet = userSheetIndexed(sram, 1);
  assertEquals([sheet.width, sheet.height], [128, 512]);
  assertEquals(sheet.indices[80 * 128 + 64 + 3], px[3]);
  assertEquals(userSheetIndexed(new Uint8Array(0x10000), 0), null);
});

Deno.test("an ODR byte is a slot with flips", () => {
  assertEquals(decodeOdrByte(0x00), {
    byte: 0,
    slot: 0,
    row: 0,
    col: 0,
    hflip: false,
    vflip: false,
  });
  assertEquals(decodeOdrByte(0x5b), {
    byte: 0x5b,
    slot: 27,
    row: 3,
    col: 3,
    hflip: true,
    vflip: false,
  });
  assertEquals(decodeOdrByte(0xd6).vflip, true);
  for (const b of [0, 0x12, 0x5b, 0x96, 0xff]) {
    assertEquals(encodeOdrByte(decodeOdrByte(b)), b);
  }
  assertEquals(encodeOdrByte({ slot: 63, hflip: true, vflip: true }), 0xff);
});

Deno.test("readWords and writeWords are little-endian inverses", () => {
  const bytes = new Uint8Array(8);
  writeWords(bytes, 2, [0x1234, 0xabcd]);
  assertEquals(Array.from(bytes), [0, 0, 0x34, 0x12, 0xcd, 0xab, 0, 0]);
  assertEquals(Array.from(readWords(bytes, 2, 2)), [0x1234, 0xabcd]);
  assertThrows(() => readWords(bytes, 6, 2), Error, "run past the end");
});
