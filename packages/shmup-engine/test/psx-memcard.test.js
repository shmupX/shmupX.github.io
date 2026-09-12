// The PlayStation memory card container: directory frames, block chains,
// the wrappings a dump arrives in.

import { assert, assertEquals } from "@std/assert";
import {
  BLOCK_SIZE,
  CARD_SIZE,
  frameChecksum,
  GME_HEADER_SIZE,
  locateSaves,
  parseDirectoryFrame,
  parseMemoryCard,
  STATUS,
} from "../src/psx/memcard.js";
import {
  buildCard,
  buildKidsBlock,
  buildPlusBlock,
  writeU16,
} from "./_psx-synthetic.js";

Deno.test("a card with one 15-block file: chain, size, checksums", () => {
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  const parsed = parseMemoryCard(card);
  assertEquals(parsed.magicOk, true);
  assertEquals(parsed.headerChecksumOk, true);
  assertEquals(parsed.frames.length, 15);
  assertEquals(parsed.frames.every((f) => f.checksumOk), true);
  assertEquals(parsed.files.length, 1);
  const file = parsed.files[0];
  assertEquals(file.filename, filename);
  assertEquals(file.blocks, Array.from({ length: 15 }, (_, i) => i + 1));
  assertEquals(file.size, block.length);
  assertEquals(file.complete, true);
  assertEquals(file.data.length, block.length);
  assertEquals(file.data, block);
  assertEquals(parsed.freeBlocks, 0);
});

Deno.test("a short file and free blocks: the chain stops at the last frame", () => {
  const block = new Uint8Array(3 * BLOCK_SIZE);
  block[0] = 0x53;
  block[1] = 0x43;
  const card = buildCard(block, "BISLPS-00000TEST");
  const parsed = parseMemoryCard(card);
  assertEquals(parsed.files[0].blocks, [1, 2, 3]);
  assertEquals(parsed.files[0].complete, true);
  assertEquals(parsed.freeBlocks, 12);
  assertEquals(parseDirectoryFrame(card, 3).status, STATUS.FREE);
});

Deno.test("a broken directory frame checksum and a dangling link are reported, not thrown", () => {
  const { block, filename } = buildKidsBlock();
  const card = buildCard(block, filename);
  const frame = card.subarray(0x80, 0x100);
  writeU16(frame, 8, 0x0e); // block 1 -> block 15, skipping the middle
  const parsed = parseMemoryCard(card);
  assertEquals(parsed.frames[0].checksumOk, false);
  assertEquals(parsed.files[0].blocks, [1, 15]);
  assertEquals(parsed.files[0].complete, false);
  frame[0x7f] = frameChecksum(frame);
  assertEquals(parseMemoryCard(card).frames[0].checksumOk, true);
});

Deno.test("locateSaves peels a raw card, a DexDrive .gme, an .mcs, a .psv and a bare block", () => {
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  assertEquals(locateSaves(card).container, "card");
  assertEquals(locateSaves(card).saves[0].filename, filename);

  const gme = new Uint8Array(GME_HEADER_SIZE + CARD_SIZE);
  gme.set(new TextEncoder().encode("123-456-STD"), 0);
  gme.set(card, GME_HEADER_SIZE);
  const fromGme = locateSaves(gme);
  assertEquals(fromGme.container, "gme");
  assertEquals(fromGme.saves[0].data, block);

  const mcs = new Uint8Array(0x80 + block.length);
  mcs.set(card.subarray(0x80, 0x100), 0);
  mcs.set(block, 0x80);
  const fromMcs = locateSaves(mcs);
  assertEquals(fromMcs.container, "mcs");
  assertEquals(fromMcs.saves[0].filename, filename);
  assertEquals(fromMcs.saves[0].data.length, block.length);

  const psv = new Uint8Array(0x84 + block.length);
  psv.set([0x00, 0x56, 0x53, 0x50], 0);
  psv.set(new TextEncoder().encode(filename), 0x64);
  psv.set(block, 0x84);
  const fromPsv = locateSaves(psv);
  assertEquals(fromPsv.container, "psv");
  assertEquals(fromPsv.saves[0].filename, filename);
  assertEquals(fromPsv.saves[0].data, block);

  assertEquals(locateSaves(block).container, "bare");
  assertEquals(locateSaves(block).saves[0].data, block);
  assertEquals(locateSaves(new Uint8Array(100)).container, "unknown");
  assert(locateSaves(new Uint8Array(100)).saves.length === 0);
});
