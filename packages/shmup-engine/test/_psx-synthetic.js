// Builders for synthetic PlayStation Dezaemon saves: a Kids! block packed
// with the engine's own LZSS encoder, a Dezaemon+ block, and a memory card
// around either. Community saves never ship with the repo, so the
// structural tests run on these; the fixture-gated suite runs on the real
// collection in dev-fixtures/ when a checkout has it.

import { compress } from "../src/compress.js";
import {
  BLOCK_COUNT,
  BLOCK_SIZE,
  CARD_SIZE,
  DIRECTORY_OFFSET,
  FRAME_SIZE,
  frameChecksum,
  NO_NEXT,
  STATUS,
} from "../src/psx/memcard.js";
import {
  KIDS_BLOCK_SIZE,
  KIDS_DATA_SIZE,
  KIDS_FIRST_SECTION,
  KIDS_GRAPHICS_SIZE,
  KIDS_PRODUCT,
  KIDS_SECTOR,
  KIDS_TABLE_OFFSET,
  KIDS_TAIL_SIZE,
} from "../src/psx/kids.js";
import {
  PLUS_BLOCK_SIZE,
  PLUS_CHECKSUM_OFFSET,
  PLUS_GRAPHICS_OFFSET,
  PLUS_HISCORE_OFFSET,
  PLUS_MAP_ROW_BYTES,
  PLUS_PALETTE_OFFSET,
  PLUS_PRODUCT,
  PLUS_STAGE_SIZE,
  PLUS_STAGES,
  PLUS_STAGES_OFFSET,
  plusChecksums,
} from "../src/psx/plus.js";

// Shift-JIS bytes, as the games write them (TextEncoder has no SJIS).
export const SJIS = Object.freeze({
  dezaemon: [0x83, 0x66, 0x83, 0x55, 0x83, 0x47, 0x83, 0x82, 0x83, 0x93], // デザエモン
  kids: [0x82, 0x6a, 0x82, 0x89, 0x82, 0x84, 0x82, 0x93, 0x81, 0x49], // Ｋｉｄｓ！
  plus: [0x81, 0x7b], // ＋
  open: [0x81, 0x77], // 『
  close: [0x81, 0x78], // 』
  A: [0x82, 0x60], // Ａ
  space: [0x81, 0x40], //
});

export function writeU16(bytes, at, v) {
  bytes[at] = v & 0xff;
  bytes[at + 1] = (v >> 8) & 0xff;
}

export function writeU32(bytes, at, v) {
  writeU16(bytes, at, v & 0xffff);
  writeU16(bytes, at + 2, (v >>> 16) & 0xffff);
}

export function byteSumOf(bytes, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s += bytes[i];
  return s >>> 0;
}

/** An "SC" title frame + one icon frame at the head of `block`. */
export function writeSaveHeader(block, titleBytes) {
  block[0] = 0x53;
  block[1] = 0x43;
  block[2] = 0x11;
  block[3] = 15;
  block.set(titleBytes.slice(0, 0x40), 4);
  for (let i = 0; i < 16; i++) {
    writeU16(block, 0x60 + i * 2, 0x8000 | (i * 0x0421));
  }
  for (let i = 0; i < 0x80; i++) block[0x80 + i] = 0x10 | (i & 0x0f);
}

/**
 * A Kids! save block around the given raw graphics (0x40000) and data
 * (0xFCC8), with ten high-score entries. Returns the block and the parts.
 */
export function buildKidsBlock(
  { graphics, data, name = [...SJIS.A, ...SJIS.space] } = {},
) {
  graphics ??= patterned(KIDS_GRAPHICS_SIZE, 7);
  data ??= patterned(KIDS_DATA_SIZE, 11);
  const block = new Uint8Array(KIDS_BLOCK_SIZE);
  writeSaveHeader(
    block,
    Uint8Array.from([
      ...SJIS.dezaemon,
      ...SJIS.kids,
      ...SJIS.open,
      ...name,
      ...SJIS.close,
    ]),
  );
  const gfx = compress(graphics);
  const dat = compress(data);
  const round = (n) => Math.ceil(n / KIDS_SECTOR) * KIDS_SECTOR;
  const gfxOffset = KIDS_FIRST_SECTION;
  const dataOffset = gfxOffset + round(gfx.length);
  const tailOffset = dataOffset + round(dat.length);
  const end = tailOffset + KIDS_TAIL_SIZE;
  if (end > KIDS_BLOCK_SIZE) throw new Error("synthetic sections too large");
  block.set(gfx, gfxOffset);
  block.set(dat, dataOffset);
  const tail = new Uint8Array(KIDS_TAIL_SIZE);
  for (let i = 0; i < 10; i++) {
    writeU32(tail, i * 16, (10 - i) * 1000);
    tail[i * 16 + 4] = 0x80;
    tail[i * 16 + 5] = 1;
    for (let k = 0; k < 8; k++) tail[i * 16 + 8 + k] = k < 3 ? 0x41 + i : 0x2e;
  }
  block.set(tail, tailOffset);
  const words = [
    end,
    gfx.length,
    dat.length,
    gfxOffset,
    byteSumOf(block, gfxOffset, gfxOffset + round(gfx.length)),
    dataOffset,
    byteSumOf(block, dataOffset, dataOffset + round(dat.length)),
    tailOffset,
    byteSumOf(block, tailOffset, end),
    round(gfx.length),
    round(dat.length),
  ];
  words.forEach((w, i) => writeU32(block, KIDS_TABLE_OFFSET + i * 4, w));
  return { block, graphics, data, tail, words, filename: KIDS_PRODUCT };
}

/**
 * A Dezaemon+ block: palettes, a graphics bitmap, stage maps with their
 * v-flip bytes, the factory ladder — and the twenty group checksums the game
 * writes last, so the block verifies the way a real one does.
 */
export function buildPlusBlock() {
  const block = new Uint8Array(PLUS_BLOCK_SIZE);
  writeSaveHeader(block, Uint8Array.from([...SJIS.dezaemon, ...SJIS.plus]));
  for (let i = 0; i < 0x10000; i++) {
    block[PLUS_GRAPHICS_OFFSET + i] = (i * 7) & 0xff;
  }
  for (let r = 0; r < 24; r++) {
    for (let c = 0; c < 16; c++) {
      writeU16(
        block,
        PLUS_PALETTE_OFFSET + r * 32 + c * 2,
        c === 0 ? 0 : 0x8000 | (r * 16 + c),
      );
    }
  }
  for (let s = 0; s < PLUS_STAGES; s++) {
    const base = PLUS_STAGES_OFFSET + s * PLUS_STAGE_SIZE;
    for (let r = 0; r < 128; r++) {
      const row = base + r * PLUS_MAP_ROW_BYTES;
      // Columns 0 and 15 (row bytes 0 and 16) stay empty, as they are in
      // every real save; the v-flip byte flips the second chip of each half.
      for (let i = 1; i < 8; i++) block[row + i] = ((r + i + s) % 0x7f) + 1;
      for (let i = 9; i < 16; i++) block[row + i] = ((r + i + s) % 0x7f) + 1;
      block[row + 8] = 0x40;
      block[row + 17] = 0x40;
    }
  }
  const ladder = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
  for (let i = 0; i < 20; i++) {
    const at = PLUS_HISCORE_OFFSET + i * 16;
    writeU32(block, at, ladder[i % 10]);
    for (let k = 0; k < 8; k++) block[at + 8 + k] = 0x2e;
  }
  const { computed } = plusChecksums(block);
  computed.forEach((v, i) => writeU16(block, PLUS_CHECKSUM_OFFSET + i * 2, v));
  return { block, filename: PLUS_PRODUCT };
}

/** A 128 KB card holding one 15-block file. */
export function buildCard(block, filename) {
  const card = new Uint8Array(CARD_SIZE);
  card[0] = 0x4d;
  card[1] = 0x43;
  card[FRAME_SIZE - 1] = frameChecksum(card.subarray(0, FRAME_SIZE));
  const blocks = Math.ceil(block.length / BLOCK_SIZE);
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const at = DIRECTORY_OFFSET + i * FRAME_SIZE;
    const frame = card.subarray(at, at + FRAME_SIZE);
    if (i < blocks) {
      frame[0] = i === 0
        ? STATUS.FIRST
        : i === blocks - 1
        ? STATUS.LAST
        : STATUS.MIDDLE;
      if (i === 0) writeU32(frame, 4, block.length);
      writeU16(frame, 8, i === blocks - 1 ? NO_NEXT : i + 1);
      if (i === 0) {
        for (let k = 0; k < filename.length; k++) {
          frame[10 + k] = filename.charCodeAt(k);
        }
      }
    } else {
      frame[0] = STATUS.FREE;
      writeU16(frame, 8, NO_NEXT);
    }
    frame[FRAME_SIZE - 1] = frameChecksum(frame);
  }
  card.set(block, BLOCK_SIZE);
  return card;
}

/** Deterministic non-trivial bytes: runs and noise, so LZSS has work to do. */
export function patterned(size, seed) {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    if ((i >> 6) % 3 === 0) out[i] = (i >> 8) & 0xff;
    else {
      x = (x * 1103515245 + 12345) >>> 0;
      out[i] = (x >> 16) & 0xff;
    }
  }
  return out;
}
