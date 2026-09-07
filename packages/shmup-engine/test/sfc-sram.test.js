// The SRAM container: size gate, the T.TABATA magic, segments, checksum copy.

import { assertEquals } from "@std/assert";
import {
  CHECK_STRING,
  CHECK_STRING_OFFSET,
  CHECKSUM_COPY_OFFSET,
  isSfcSav,
  readCheckString,
  readChecksumBlocks,
  splitSegments,
  SRAM_SIZE,
} from "../src/sfc/sram.js";

function withMagic(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < CHECK_STRING.length; i++) {
    bytes[CHECK_STRING_OFFSET + i] = CHECK_STRING.charCodeAt(i);
  }
  return bytes;
}

Deno.test("isSfcSav wants a 64 KB or 128 KB file carrying T.TABATA", () => {
  assertEquals(isSfcSav(withMagic(SRAM_SIZE)), true);
  assertEquals(isSfcSav(withMagic(0x10000)), true);
  assertEquals(isSfcSav(withMagic(0x8000)), false);
  assertEquals(isSfcSav(withMagic(SRAM_SIZE + 512)), false);
  assertEquals(isSfcSav(new Uint8Array(SRAM_SIZE)), false);
  assertEquals(readCheckString(withMagic(SRAM_SIZE)), "T.TABATA");
});

Deno.test("splitSegments yields four 32 KB views and marks blank or absent ones", () => {
  const bytes = withMagic(SRAM_SIZE);
  bytes[0x10000] = 1;
  const segments = splitSegments(bytes);
  assertEquals(segments.length, 4);
  assertEquals(segments.map((s) => s.bank), [0x70, 0x71, 0x72, 0x73]);
  assertEquals(segments.map((s) => s.offset), [0, 0x8000, 0x10000, 0x18000]);
  assertEquals(segments.map((s) => s.blank), [false, true, false, true]);
  assertEquals(
    segments.every((s) => s.present && s.bytes.length === 0x8000),
    true,
  );
  bytes[0x10000] = 2;
  assertEquals(segments[2].bytes[0], 2); // a view, not a copy

  const half = splitSegments(withMagic(0x10000));
  assertEquals(half.map((s) => s.present), [true, true, false, false]);
  assertEquals(half[3].bytes.length, 0);
  assertEquals(half[3].blank, true);
});

Deno.test("readChecksumBlocks compares the block with its copy at 0x7E5A", () => {
  const bytes = withMagic(SRAM_SIZE);
  for (let i = 0; i < 32; i++) {
    bytes[i] = i * 3;
    bytes[CHECKSUM_COPY_OFFSET + i] = i * 3;
  }
  let blocks = readChecksumBlocks(bytes);
  assertEquals(blocks.equal, true);
  assertEquals(blocks.words.length, 16);
  assertEquals(blocks.words[1], (9 << 8) | 6);
  bytes[CHECKSUM_COPY_OFFSET + 7] ^= 1;
  blocks = readChecksumBlocks(bytes);
  assertEquals(blocks.equal, false);
});
