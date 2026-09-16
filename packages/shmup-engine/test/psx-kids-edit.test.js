// Editing a Dezaemon Kids! save in place: that an untouched section keeps the
// exact compressed stream the game wrote, that the three byte sums cover the
// sector-padded span and not the exact one, that the eleven directory words
// come out satisfying every relation parseKidsTable cross-checks, and that a
// card round-trips through placeKidsSave rather than through the copy
// locateSaves hands back.
//
// Kids! is the harder half of the pair, and every case here is shaped by the
// difference. A Dezaemon+ field sits at a fixed file offset, so an N-byte edit
// reseals to N + 2 bytes; a Kids! save stores its graphics and data LZSS-packed,
// so one map chip re-encodes 64,712 bytes, and because the sections lie end to
// end on 0x80 sector boundaries a section that changes size MOVES the ones after
// it and half the directory with them. "Few bytes move" is therefore not the
// contract and is not asserted anywhere below.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { compress } from "../src/compress.js";
import { decompress } from "../src/decompress.js";
import {
  BLOCK_SIZE,
  blockBytes,
  CARD_SIZE,
  DIRECTORY_OFFSET,
  FRAME_SIZE,
  frameChecksum,
  locateSaves,
  NO_NEXT,
  parseMemoryCard,
  PSV_HEADER_SIZE,
  STATUS,
} from "../src/psx/memcard.js";
import {
  byteSum,
  KIDS_BLOCK_SIZE,
  KIDS_CELL_COUNT,
  KIDS_DATA_SIZE,
  KIDS_FIRST_SECTION,
  KIDS_GRAPHICS_SIZE,
  KIDS_MAP_COLUMNS,
  KIDS_PRODUCT,
  KIDS_REGION,
  KIDS_SECTOR,
  KIDS_STAGES,
  KIDS_TABLE_OFFSET,
  KIDS_TABLE_WORDS,
  KIDS_TAIL_SIZE,
  parseKidsSave,
  parseKidsTable,
  roundUp,
  validateKidsTable,
} from "../src/psx/kids.js";
import * as kidsEdit from "../src/psx/kids-edit.js";
import {
  assertKidsBlock,
  editKidsSave,
  KIDS_HISCORE_NAME_BYTES,
  KIDS_SCROLL_NIBBLE_MAX,
  KIDS_TABLE_WORD_NAMES,
  KIDS_TITLE_CLOSE,
  KIDS_TITLE_NAME_BYTES,
  KIDS_TITLE_NAME_OFFSET,
  KIDS_TITLE_OPEN,
  kidsNameBytes,
  kidsScoreName,
  kidsUnsealedWords,
  placeKidsSave,
  sealKidsTable,
  setKidsGameName,
  setKidsHiScore,
  setKidsMapChip,
  setKidsScrollNibble,
} from "../src/psx/kids-edit.js";
import { identifyGame } from "../src/psx/index.js";
import {
  buildCard,
  buildKidsBlock,
  byteSumOf,
  patterned,
  SJIS,
  writeSaveHeader,
  writeU16,
  writeU32,
} from "./_psx-synthetic.js";

/**
 * Exactly the offsets at which two blocks differ.
 *
 * Deliberately not coalesceDiffRanges()/totalDiffBytes() (src/diff-ranges.js:7,
 * :26): their default minGap of 8 merges two runs separated by fewer than eight
 * identical bytes and then counts those identical bytes as differing. Every
 * count here is byte-exact, because "these four bytes of the directory and
 * nothing else" is the claim and 6 is not 4.
 */
function diffOffsets(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/**
 * A refused call throws AND writes nothing. The second half matters as much as
 * the first: a setter that validated after writing would leave a decompressed
 * section holding a value the game jumps through, and the next editKidsSave
 * would seal a perfectly consistent directory around it.
 */
function assertRefuses(bytes, fn, note) {
  const before = Uint8Array.from(bytes);
  assertThrows(fn, Error, "", note);
  assertEquals(
    diffOffsets(before, bytes),
    [],
    `${note}: a refused call wrote bytes`,
  );
}

/**
 * Rewrite one directory frame's status and link, then fix its XOR checksum.
 *
 * `size` rewrites frame 0's declared u32 at +4 (memcard.js:111), and a chain
 * cannot be shortened without it: parseMemoryCard's `complete` ANDs
 * `frame.size <= joined.length` with two more conditions (memcard.js:170), so a
 * card whose chain drops to fourteen blocks while frame 0 still declares 122880
 * bytes parses as INCOMPLETE rather than as short.
 */
function relink(card, index, status, next, size) {
  const at = DIRECTORY_OFFSET + index * FRAME_SIZE;
  const frame = card.subarray(at, at + FRAME_SIZE);
  frame[0] = status;
  writeU16(frame, 8, next);
  if (size !== undefined) writeU32(frame, 4, size);
  frame[FRAME_SIZE - 1] = frameChecksum(frame);
}

/** The compressed bytes of one section, exactly as the directory names them. */
function streamOf(block, name) {
  const s = parseKidsTable(block).sections[name];
  return block.subarray(s.offset, s.offset + s.size);
}

/** The span a checksum has to cover: the stream PLUS its sector padding. */
function paddedOf(block, name) {
  const s = parseKidsTable(block).sections[name];
  return block.subarray(s.offset, s.offset + s.padded);
}

/** One section's move record out of a KidsWrite. */
function moveOf(write, name) {
  const found = write.sections.find((s) => s.name === name);
  assert(found, `no ${name} section in the record`);
  return found;
}

// --- a save that looks like a real one ---------------------------------------

// buildKidsBlock() packs its two sections with src/compress.js, which makes them
// FIXED POINTS of that encoder: recompressing them reproduces them byte for
// byte, so on that block "copied the stream" and "recompressed the stream" are
// the same bytes and no assertion can tell them apart. Real saves are not fixed
// points — measured over the 77 Kids! saves in this checkout, 0 of 77 recompress
// identically, mean +796 bytes and worst +2,495 over the two sections. The
// helpers below reproduce that property synthetically, so the structural cases
// test the same thing the fixture-gated case at the end tests.

/** Split a stream into its tokens: [byte] for a literal, [b1, b2] for a match. */
function lzssTokens(stream) {
  const out = [];
  let i = 0, flags = 0, left = 0;
  while (i < stream.length) {
    if (left === 0) {
      flags = stream[i++];
      left = 8;
      if (i >= stream.length) break;
    }
    const literal = flags & 1;
    flags >>= 1;
    left--;
    if (literal) {
      if (i >= stream.length) break;
      out.push([stream[i++]]);
    } else {
      if (i + 1 >= stream.length) break;
      out.push([stream[i], stream[i + 1]]);
      i += 2;
    }
  }
  return out;
}

/** Re-emit a token list with fresh flag bytes (src/compress.js:63-73). */
function lzssEmit(tokens) {
  const out = [];
  let flagAt = -1, bits = 0, count = 0;
  for (const token of tokens) {
    if (count === 0) {
      flagAt = out.length;
      out.push(0);
      bits = 0;
    }
    if (token.length === 1) bits |= 1 << count;
    count++;
    out[flagAt] = bits;
    if (count === 8) count = 0;
    out.push(...token);
  }
  return Uint8Array.from(out);
}

/**
 * The same bytes, coded worse: every `every`-th match longer than the minimum is
 * re-emitted as a 3-byte match plus literals of the bytes it would have copied.
 *
 * Sound because the decoder's ring is a function of the OUTPUT bytes alone
 * (decompress.js:36-53) — it advances one slot per byte produced, whatever token
 * produced it — so every later match's absolute ring offset still points where
 * it did. Only the flag bits move, and lzssEmit lays those down fresh. The
 * result is a stream decompress() reads back to the identical input and
 * compress() would never emit: at `every: 16` the graphics section comes out
 * 57,908 bytes against the canonical 43,258 and the data section 21,975 against
 * 18,859, which is what a deliberately lazy encoder costs and still leaves
 * 42,240 bytes of the block free.
 */
function looser(stream, every = 16) {
  const raw = decompress(stream);
  const out = [];
  let produced = 0, matches = 0;
  for (const token of lzssTokens(stream)) {
    if (token.length === 1) {
      out.push(token);
      produced++;
      continue;
    }
    const length = (token[1] & 0x0f) + 3;
    if (length > 3 && matches++ % every === 0) {
      out.push([token[0], token[1] & 0xf0]); // same offset, length 3
      for (let k = 3; k < length; k++) out.push([raw[produced + k]]);
    } else out.push(token);
    produced += length;
  }
  return lzssEmit(out);
}

// ユーザーゲームデータ in Shift-JIS, the twenty title bytes between
// デザエモンＫｉｄｓ！ and 『 — verified through TextDecoder("shift_jis"), which
// is the decoder save-header.js reads titles with. _psx-synthetic.js's SJIS
// table has the other four pieces but not this one, and without it the name
// field does not land at KIDS_TITLE_NAME_OFFSET.
const SJIS_USER_GAME_DATA = Object.freeze([
  0x83,
  0x86,
  0x81,
  0x5b,
  0x83,
  0x55,
  0x81,
  0x5b,
  0x83,
  0x51,
  0x81,
  0x5b,
  0x83,
  0x80,
  0x83,
  0x66,
  0x81,
  0x5b,
  0x83,
  0x5e,
]);

/**
 * A Kids! block with three properties every real save has and
 * buildKidsBlock() has none of: streams no encoder in this package would
 * produce, NON-ZERO sector padding, and the full 64-byte title.
 *
 * The title matters because the name field is a FIXED window: all 77 community
 * saves carry the identical 42-byte prefix デザエモンＫｉｄｓ！ユーザーゲームデータ『
 * and then ten fullwidth characters, so the name sits at block offset 0x2E and
 * 』 at 0x42. buildKidsBlock() writes a shorter prefix and a two-character name,
 * which is fine for the directory tests it was written for and puts 『 at 0x18.
 *
 * The padding is stale staging-buffer content (FORMAT-PSX.md, "Section
 * directory") and is non-zero in 75 of the 77 Kids! saves here — both sections'
 * pads are zero in only two of them. Filling the whole block first reproduces
 * that everywhere at once: the pad after each stream, the 84 bytes at
 * 0x12C..0x180 between the directory and the first section, and everything past
 * `end`, which is whatever the card held before.
 */
function buildLooseKidsBlock({
  graphics = patterned(KIDS_GRAPHICS_SIZE, 7),
  data = patterned(KIDS_DATA_SIZE, 11),
  every = 16,
  fill = 0x5a,
} = {}) {
  const block = new Uint8Array(KIDS_BLOCK_SIZE).fill(fill);
  writeSaveHeader(
    block,
    Uint8Array.from([
      ...SJIS.dezaemon,
      ...SJIS.kids,
      ...SJIS_USER_GAME_DATA,
      ...SJIS.open,
      // Ten fullwidth characters, which is what every real name field holds.
      ...SJIS.A,
      ...Array.from({ length: 9 }, () => SJIS.space).flat(),
      ...SJIS.close,
    ]),
  );
  const gfx = looser(compress(graphics), every);
  const dat = looser(compress(data), every);
  const gfxOffset = KIDS_FIRST_SECTION;
  const dataOffset = gfxOffset + roundUp(gfx.length, KIDS_SECTOR);
  const tailOffset = dataOffset + roundUp(dat.length, KIDS_SECTOR);
  const end = tailOffset + KIDS_TAIL_SIZE;
  if (end > KIDS_BLOCK_SIZE) throw new Error("loose sections too large");
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
    byteSumOf(block, gfxOffset, gfxOffset + roundUp(gfx.length, KIDS_SECTOR)),
    dataOffset,
    byteSumOf(block, dataOffset, dataOffset + roundUp(dat.length, KIDS_SECTOR)),
    tailOffset,
    byteSumOf(block, tailOffset, end),
    roundUp(gfx.length, KIDS_SECTOR),
    roundUp(dat.length, KIDS_SECTOR),
  ];
  words.forEach((w, i) => writeU32(block, KIDS_TABLE_OFFSET + i * 4, w));
  return { block, graphics, data, tail, words, filename: KIDS_PRODUCT };
}

Deno.test("an edit that changes nothing leaves the very bytes it was handed", () => {
  // The contract the whole module rests on, and the reason it is a contract and
  // not an optimisation: src/compress.js is NOT the game's own encoder.
  // Measured over the 77 Kids! saves in this checkout, 0 of 77 recompress
  // byte-identically — mean +796 bytes over the two sections, worst +2,495. So
  // a pack that re-encoded an untouched section would move the section after
  // it, rewrite half the directory and change tens of thousands of bytes for an
  // edit of nothing. Copying an untouched stream verbatim is the only way an
  // edit-nothing round trip stays byte-identical, which is the property
  // psx-plus-edit.test.js's first case established for Dezaemon+.
  const { block, graphics, data } = buildLooseKidsBlock();
  const before = Uint8Array.from(block);

  // The pin. These streams are not what compress() emits, so byte-identity
  // below can only come from a copy. On buildKidsBlock()'s block it could not
  // be: that one packs with compress() itself, which makes its streams fixed
  // points of the encoder, and "copied" and "recompressed" are then the same
  // bytes — a green test that proves nothing.
  assert(
    compress(graphics).length !== streamOf(block, "graphics").length,
    "the graphics stream is canonical; this case cannot tell a copy from a recompress",
  );
  assert(
    compress(data).length !== streamOf(block, "data").length,
    "the data stream is canonical; this case cannot tell a copy from a recompress",
  );

  const write = editKidsSave(block, {});
  assertEquals(write.identical, true);
  assertEquals(write.changedBytes, 0);
  assertEquals(write.firstChange, null);
  assertEquals(diffOffsets(before, block), []);
  assertEquals(block, before);
  assertEquals(write.seal.words, []);
  assertEquals(write.seal.bytes, 0);
  assertEquals(write.seal.consistent, true);
  assertEquals(write.seal.checksums.ok, true);
  assertEquals(write.end, write.wasEnd);
  assertEquals(write.sourceChecksums.ok, true);

  // Stated on the compressed bytes, not on what they decompress to — two
  // different streams decompress to the same section, and that is exactly the
  // difference this case exists to catch — and the record says so in its own
  // words as well.
  assertEquals(streamOf(block, "graphics"), streamOf(before, "graphics"));
  assertEquals(streamOf(block, "data"), streamOf(before, "data"));
  for (const name of ["graphics", "data"]) {
    const move = moveOf(write, name);
    assertEquals(move.supplied, false, name);
    assertEquals(move.recompressed, false, name);
    assertEquals(move.moved, false, name);
    assertEquals(move.sizeDelta, 0, name);
    assertEquals(move.paddingKept, true, name);
  }
  assertEquals(moveOf(write, "tail").recompressed, false);

  // A second pass is the same no-op, and so is a third.
  assertEquals(editKidsSave(block, {}).changedBytes, 0);
  assertEquals(editKidsSave(block, {}).identical, true);
  assertEquals(diffOffsets(before, block), []);
  assertEquals(kidsUnsealedWords(block), []);

  // And the canonical fixture round-trips too, so the rule is not an artefact
  // of the loose streams.
  const plain = buildKidsBlock().block;
  const plainBefore = Uint8Array.from(plain);
  assertEquals(editKidsSave(plain, {}).identical, true);
  assertEquals(diffOffsets(plainBefore, plain), []);
});

Deno.test("an edit to one section leaves the other section's stream byte for byte where it was", () => {
  // The consequence of copy-verbatim a user sees. An edited section is
  // necessarily different bytes — a different encoder wrote it — but the other
  // one must survive unaltered, and "unaltered" has to mean its exact stream
  // bytes, which is a stronger statement than "it still decompresses the same".
  const { block, graphics } = buildLooseKidsBlock();
  const before = Uint8Array.from(block);
  const save = parseKidsSave(block, { filename: KIDS_PRODUCT });
  assertEquals(save.errors, []);
  const data = Uint8Array.from(save.data);

  // 0x24 is 2x2-aligned (bits 0 and 3 clear, kids.js:100) and KIDS_HFLIP is
  // 0x2000, so the word this writes is 0x2024.
  const chip = setKidsMapChip(data, 2, 3, 40, { cell: 0x24, hflip: true });
  assertEquals(chip.section, "data");
  assertEquals(chip.inBlock, false);
  assertEquals(chip.changed, true);
  assertEquals(chip.length, 2);
  assertEquals(chip.after, [0x24, 0x20]);

  const write = editKidsSave(block, { data });

  // The untouched section: stream, padding, offset and sum all as found.
  assertEquals(paddedOf(block, "graphics"), paddedOf(before, "graphics"));
  assertEquals(
    parseKidsTable(block).sections.graphics,
    parseKidsTable(before).sections.graphics,
  );
  assertEquals(parseKidsSave(block).graphics, graphics);
  const gfxMove = moveOf(write, "graphics");
  assertEquals(gfxMove.supplied, false);
  assertEquals(gfxMove.recompressed, false);
  assertEquals(gfxMove.moved, false);
  assertEquals(gfxMove.paddingKept, true);

  // The edited one: different bytes, and it decompresses to exactly what was
  // asked for. editKidsSave reads its own output back before writing it
  // (kids-edit.js:408-424), and parseKidsSave here is the second reading.
  const datMove = moveOf(write, "data");
  assertEquals(datMove.supplied, true);
  assertEquals(datMove.recompressed, true);
  assert(datMove.sizeDelta !== 0, "the data stream did not change size at all");
  const reparsed = parseKidsSave(block, { filename: KIDS_PRODUCT });
  assertEquals(reparsed.errors, []);
  assertEquals(reparsed.map[2].words[40 * KIDS_MAP_COLUMNS + 3], 0x2024);
  assertEquals(reparsed.data, data);
  assertEquals(validateKidsTable(block).ok, true);
  assert(
    write.warnings.some((w) => w.includes("re-encoded")),
    `a re-encoded section should say so: ${JSON.stringify(write.warnings)}`,
  );

  // The other direction, and the sharper half of the rule: re-encode GRAPHICS
  // and the data section is not supplied, so its stream is copied — but it now
  // lands 14,720 bytes earlier, because the canonical graphics stream is that
  // much shorter than the loose one. A copied stream survives a MOVE: the same
  // bytes at a different offset. Its stale padding does not, and the record
  // says which (`paddingKept`), because those bytes were in the file and are
  // now zero.
  const second = Uint8Array.from(before);
  const moved = editKidsSave(second, { graphics });
  const dat2 = moveOf(moved, "data");
  assertEquals(dat2.supplied, false);
  assertEquals(dat2.recompressed, false);
  assertEquals(dat2.moved, true);
  assertEquals(dat2.sizeDelta, 0);
  assertEquals(dat2.paddingKept, false);
  assertEquals(streamOf(second, "data"), streamOf(before, "data"));
  assertEquals(parseKidsSave(second).data, parseKidsSave(before).data);
  assertEquals(validateKidsTable(second).ok, true);
  // Its padding really is zero now, and the sum still verifies over it, which
  // is the whole point of sealing after the bytes are down.
  const d = parseKidsTable(second).sections.data;
  assertEquals(byteSum(second, d.offset + d.size, d.offset + d.padded), 0);
  assert(
    moved.warnings.some((w) => w.includes("sector-padding")),
    `a dropped padding should be named: ${JSON.stringify(moved.warnings)}`,
  );
});

Deno.test("the three byte sums cover the sector-padded span, and a padding byte moves them", () => {
  // THE trap in this format. Words 4, 6 and 8 are byte sums over word 9 / word
  // 10 / 0x100 bytes (FORMAT-PSX.md, "Section directory"), and the padding
  // inside a padded span is stale staging-buffer content, not zero: measured
  // here, 75 of the 77 Kids! saves have non-zero padding in at least one of the
  // two sections. A writer that sums the exact span passes every test over a
  // zeroed scratch buffer — zero padding adds zero — and corrupts the first
  // real save it touches.
  //
  // buildKidsBlock() IS that zeroed buffer, so this case uses the loose builder,
  // and asserts up front that the two spans really do disagree. Without that
  // the case would be green whichever span the seal summed.
  const { block } = buildLooseKidsBlock();
  for (const name of ["graphics", "data"]) {
    const s = parseKidsTable(block).sections[name];
    assert(s.padded > s.size, `${name}: no padding, so this case is vacuous`);
    assert(
      byteSum(block, s.offset + s.size, s.offset + s.padded) !== 0,
      `${name}: the padding is zero, so this case is vacuous`,
    );
    assert(
      byteSum(block, s.offset, s.offset + s.size) !== s.checksum,
      `${name}: the exact span and the padded span agree, so this case is vacuous`,
    );
  }

  // The seal on this block is a no-op. It can only be one if it sums the padded
  // span: over the exact span, words 4 and 6 would both move.
  const before = Uint8Array.from(block);
  const seal = sealKidsTable(block);
  assertEquals(seal.words, []);
  assertEquals(seal.bytes, 0);
  assertEquals(seal.checksums, {
    graphics: true,
    data: true,
    tail: true,
    ok: true,
  });
  assertEquals(seal.consistent, true);
  assertEquals(diffOffsets(before, block), []);
  assertEquals(seal.end, parseKidsTable(block).end);
  assertEquals(seal.slack, KIDS_BLOCK_SIZE - seal.end);

  // And the positive form: poke one byte of the stale padding — a byte no
  // decompressor will ever read, since word 1 stops the stream before it — and
  // the graphics sum moves by exactly that much. That is the padding being IN
  // the sum, stated as an equation rather than as an absence.
  const g = parseKidsTable(block).sections.graphics;
  const padAt = g.offset + g.size;
  assert(padAt < g.offset + g.padded, "there is no padding byte to poke");
  const was = block[padAt];
  block[padAt] = (was + 3) & 0xff;
  assertEquals(validateKidsTable(block).graphics, false);
  const unsealed = kidsUnsealedWords(block);
  assertEquals(unsealed.map((w) => w.name), ["graphicsSum"]);
  assertEquals(unsealed[0].index, 4);
  assertEquals(unsealed[0].computed - unsealed[0].stored, 3);
  const fixed = sealKidsTable(block);
  assertEquals(fixed.words.map((w) => w.name), ["graphicsSum"]);
  assertEquals(fixed.bytes, 4);
  assertEquals(fixed.checksums.ok, true);
  // The decompressed section is untouched by all of that, which is what makes
  // those bytes padding in the first place.
  assertEquals(parseKidsSave(block).errors, []);
  assertEquals(parseKidsSave(block).graphics.length, KIDS_GRAPHICS_SIZE);

  // A tail edit relays nothing — the tail is stored raw and is already its own
  // padded span — so it moves the tail's sixteen bytes and word 8, and nothing
  // else. Measured: only the LOW TWO bytes of word 8 differ for this edit, not
  // all four. Two rather than four is the same point PlusSeal.bytes makes for
  // Dezaemon+: a word's width is what a writer owes it, never a promise that
  // every byte of it moves.
  const { block: fresh } = buildLooseKidsBlock();
  const clean = Uint8Array.from(fresh);
  const tail = Uint8Array.from(parseKidsSave(fresh).tail);
  const entry = setKidsHiScore(tail, 1, {
    score: 1234567,
    stage: 3,
    level: 2,
    name: kidsScoreName("ZED"),
  });
  assertEquals(entry.section, "tail");
  assertEquals(entry.offset, 0);
  assertEquals(entry.length, 16);
  const write = editKidsSave(fresh, { tail });
  assertEquals(moveOf(write, "tail").supplied, true);
  assertEquals(moveOf(write, "tail").recompressed, false);
  assertEquals(moveOf(write, "graphics").paddingKept, true);
  assertEquals(moveOf(write, "data").paddingKept, true);
  const tailAt = parseKidsTable(clean).sections.tail.offset;
  assertEquals(
    diffOffsets(clean, fresh).filter((o) => o < tailAt),
    [0x120, 0x121],
  );
  assertEquals(validateKidsTable(fresh).ok, true);
  assertEquals(parseKidsSave(fresh).hiScores[0].score, 1234567);
  assertEquals(parseKidsSave(fresh).hiScores[0].stage, 3);
  assertEquals(parseKidsSave(fresh).hiScores[0].name, "ZED.....");
});

Deno.test("the eleven words come out satisfying every relation, checked by hand rather than through the reader", () => {
  // parseKidsTable's own cross-check is the obvious assertion and the weak one:
  // validateKidsTable is "the writer's other half verbatim" (kids.js:258), so a
  // seal that agreed with it and with nothing else would still be green. Every
  // relation is therefore restated here from FORMAT-PSX.md, "Section
  // directory", and read straight out of the eleven u32 at 0x100.
  const { block } = buildLooseKidsBlock();
  const data = Uint8Array.from(parseKidsSave(block).data);
  setKidsMapChip(data, 0, 0, 0, { cell: 0x10 });
  editKidsSave(block, { data });

  const w = [];
  for (let i = 0; i < KIDS_TABLE_WORDS; i++) {
    const at = KIDS_TABLE_OFFSET + i * 4;
    w.push(
      (block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) |
        (block[at + 3] << 24)) >>> 0,
    );
  }
  assertEquals(w.length, 11);
  assertEquals(KIDS_TABLE_WORD_NAMES.length, 11);
  assertEquals(w[3], KIDS_FIRST_SECTION); // 0x180 in all 98 saves
  assertEquals(w[9], roundUp(w[1], KIDS_SECTOR));
  assertEquals(w[10], roundUp(w[2], KIDS_SECTOR));
  assertEquals(w[5], w[3] + w[9]);
  assertEquals(w[7], w[5] + w[10]);
  assertEquals(w[0], w[7] + KIDS_TAIL_SIZE);
  assert(w[0] <= KIDS_BLOCK_SIZE, `end ${w[0]} is past the block`);
  assertEquals(w[4], byteSum(block, w[3], w[3] + w[9]));
  assertEquals(w[6], byteSum(block, w[5], w[5] + w[10]));
  assertEquals(w[8], byteSum(block, w[7], w[7] + KIDS_TAIL_SIZE));
  // Words 1 and 2 are the EXACT compressed lengths against 9 and 10's padded
  // ones, and a decompress of exactly w[1] bytes is what gives the section
  // back. It has to be exact: an LZSS stream carries no length, decompress()
  // stops when its input runs out (decompress.js:27), so handing it the padded
  // span decodes the stale padding as more tokens and returns something longer
  // rather than an error.
  assertEquals(
    decompress(block.subarray(w[3], w[3] + w[1])).length,
    KIDS_GRAPHICS_SIZE,
  );
  assertEquals(
    decompress(block.subarray(w[5], w[5] + w[2])).length,
    KIDS_DATA_SIZE,
  );

  // Then, and only then, through the reader.
  const table = parseKidsTable(block);
  assertEquals(table.problems, []);
  assertEquals(table.consistent, true);
  assertEquals(table.words, w);
  assertEquals(validateKidsTable(block).ok, true);
  assertEquals(parseKidsSave(block, { filename: KIDS_PRODUCT }).errors, []);
  assertEquals(kidsUnsealedWords(block), []);
});

Deno.test("a save whose sections no longer fit is refused, with the arithmetic in the message", () => {
  // Fitting is neither free nor guaranteed. All 77 Kids! saves here do fit after
  // both sections are re-encoded — 77 of 77, tightest slack 4,224 bytes on
  // "Cronos (Keroyon) (D25).sav" — but that is a measurement of this collection,
  // not a property of the format. The file is 0x1E000 bytes and nothing grows
  // it, while the graphics section alone is 0x40000 before compression, so art
  // with no runs in it cannot be stored at all: Okumura LZSS costs nine bytes
  // per eight incompressible ones (one flag bit each, decompress.js:6-7), so
  // 262,144 bytes of noise come out near 294,912 — more than twice the block.
  const { block } = buildLooseKidsBlock();
  const before = Uint8Array.from(block);
  const noise = new Uint8Array(KIDS_GRAPHICS_SIZE);
  // Math.imul, not `*`: x reaches 2^32 and x * 1103515245 is about 4.7e18, past
  // 2^53, so the low bits round off. Measured, that generator falls into a
  // 6,063-state cycle after 1,261 steps, which makes the buffer 43 copies of one
  // 6,063-byte stretch — compress() packs it to 273,518, a ratio of 1.04, which
  // is not the noise the paragraph above reasons about. The exact 32-bit
  // multiply showed no repeated state in 5,000,000 steps, longer than this
  // buffer is.
  let x = 12345;
  for (let i = 0; i < noise.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    noise[i] = (x >> 16) & 0xff;
  }
  // The fixture's whole job is to be art nothing can pack, so measure that here
  // rather than trust the generator. Two bounds, because the weaker one alone
  // would not have caught the multiply above: compression has to GROW this, and
  // it has to grow it by about the 9/8 the paragraph reasons from. Measured
  // 294,809 out of 262,144 in (ratio 1.125), which is where real
  // crypto.getRandomValues noise lands too (294,8xx); the degenerate generator
  // packed to 273,518, over the floor but only 1.04, and 1.1 separates them with
  // room to spare — an encoder can beat 9/8 slightly by finding chance 3-byte
  // matches in noise, which is why 294,809 is under 294,912. A buffer that went
  // quietly compressible would still exceed the 122,880-byte block, so the
  // refusal below would still fire and this case would keep passing while
  // testing something softer than it claims.
  const packed = compress(noise).length;
  assert(
    packed >= noise.length,
    `the fit case needs art nothing can pack: ${packed} < ${noise.length}`,
  );
  assert(
    packed > noise.length * 1.1,
    `the fit case needs the 9/8 cost, not just growth: ${packed} of ${noise.length}`,
  );

  let message = "";
  try {
    editKidsSave(block, { graphics: noise });
    throw new Error("the edit did not refuse");
  } catch (e) {
    message = e.message;
  }
  assert(
    message.includes(String(KIDS_BLOCK_SIZE)),
    `the refusal must name the ${KIDS_BLOCK_SIZE}-byte file: ${message}`,
  );
  assert(
    /\bover\b/.test(message) && /\d{4,}/.test(message),
    `the refusal must say by how much, in bytes: ${message}`,
  );
  // Refused before a byte was laid down, so the caller can retry with less art
  // rather than reload the file. editKidsSave mutates in place, which is
  // exactly why this has to be checked and not assumed.
  assertEquals(diffOffsets(before, block), []);
  assertEquals(validateKidsTable(block).ok, true);

  // The same guard from the other side: sealKidsTable refuses sizes that cannot
  // lie in a block, so a caller cannot write a directory describing a file that
  // does not exist.
  assertThrows(
    () => sealKidsTable(block, { graphics: 0x20000, data: 0x20000 }),
    Error,
  );
  assertEquals(diffOffsets(before, block), []);
});

Deno.test("each setter refuses the values its own region cannot hold", () => {
  // One case per rule, and every rule is one the corpus or a traced reader
  // states. Rejection, not clamping: a clamp silently substitutes a value
  // nobody asked for, which is what makes a surgical tool untrustworthy.
  const { block } = buildLooseKidsBlock();
  const save = parseKidsSave(block, { filename: KIDS_PRODUCT });
  const data = Uint8Array.from(save.data);
  const tail = Uint8Array.from(save.tail);

  // A map chip's cell number is 2x2-aligned in all 1,241,856 chips of the 77
  // saves (FORMAT-PSX.md, "MAP"): bits 0 and 3 are clear, because the chip draws
  // cells n, n+1, n+8, n+9 and so has to start on an even column and an even row
  // of the CG page. An unaligned n draws a group straddling two rows of eight.
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 0, { cell: 1 }),
    "cell 1",
  );
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 0, { cell: 8 }),
    "cell 8",
  );
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 0, { cell: KIDS_CELL_COUNT }),
    "cell 1024",
  );
  // Seven chips a row, 384 rows: 7 x 32 px = 224 of the 256-px screen.
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 7, 0, { cell: 0 }),
    "column 7",
  );
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 384, { cell: 0 }),
    "row 384",
  );
  assertRefuses(
    data,
    () => setKidsMapChip(data, KIDS_STAGES, 0, 0, {}),
    "stage 6",
  );
  assertRefuses(data, () => setKidsMapChip(data, -1, 0, 0, {}), "stage -1");
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 0, { cell: 0, hflip: 1 }),
    "hflip 1",
  );
  // The section itself is checked, so a caller who hands in the GRAPHICS buffer
  // by mistake is told rather than silently repainting art with chip words.
  assertRefuses(
    data,
    () => setKidsMapChip(new Uint8Array(KIDS_GRAPHICS_SIZE), 0, 0, 0, {}),
    "the wrong section",
  );

  // 192 scroll units a stage, one per 64 px, and the nibble is 0..3: the play
  // engine masks it with & 3 but the EDITOR reads the whole nibble to pick its
  // icon (KIDS.EXE 0x8008BD20), and no nibble above 3 occurs in any save.
  assertEquals(KIDS_SCROLL_NIBBLE_MAX, 3);
  assertRefuses(data, () => setKidsScrollNibble(data, 0, 0, 4), "nibble 4");
  assertRefuses(data, () => setKidsScrollNibble(data, 0, 192, 0), "unit 192");
  assertRefuses(data, () => setKidsScrollNibble(data, 0, -1, 0), "unit -1");
  assertRefuses(data, () => setKidsScrollNibble(data, 6, 0, 0), "stage 6");

  // Ten 16-byte entries. The name is BYTES, never a string: kids.js:291 decodes
  // it with latin1(), a raw byte -> charCode pass-through, so a string
  // parameter would invite text the game's font maps to garbage.
  const name = kidsScoreName("ACE");
  assertEquals(name.length, KIDS_HISCORE_NAME_BYTES);
  assertRefuses(tail, () => setKidsHiScore(tail, 0, { score: 1 }), "rank 0");
  assertRefuses(tail, () => setKidsHiScore(tail, 11, { score: 1 }), "rank 11");
  assertRefuses(
    tail,
    () => setKidsHiScore(tail, 1, { score: 0x100000000 }),
    "score overflow",
  );
  assertRefuses(tail, () => setKidsHiScore(tail, 1, { score: -1 }), "score -1");
  assertRefuses(
    tail,
    () => setKidsHiScore(tail, 1, { score: 1, name: "ABCDEFGH" }),
    "a string name",
  );
  assertRefuses(
    tail,
    () =>
      setKidsHiScore(tail, 1, {
        score: 1,
        name: Uint8Array.from([0x41, 0x42]),
      }),
    "a two-byte name",
  );
  assertRefuses(
    tail,
    () => setKidsHiScore(tail, 1, { score: 1, stage: 6 }),
    "stage 6",
  );
  assertRefuses(
    tail,
    () => setKidsHiScore(tail, 1, { score: 1, level: 5 }),
    "level 5",
  );
  // stage and allClear ARE the same byte (kids.js:280-281) — 0x80 marks an
  // all-clear instead of a stage number — so asking for both is a caller
  // contradiction, not a value out of range.
  assertRefuses(
    tail,
    () => setKidsHiScore(tail, 1, { score: 1, stage: 2, allClear: true }),
    "a stage and an all-clear at once",
  );
  assertRefuses(
    tail,
    () => setKidsHiScore(new Uint8Array(KIDS_DATA_SIZE), 1, { score: 1 }),
    "the data section as a tail",
  );

  // The two encoders refuse what they cannot represent rather than substituting
  // a glyph the player did not choose.
  assertThrows(() => kidsScoreName("TOO LONG NAME"), Error);
  assertThrows(() => kidsScoreName("café"), Error);
  assertThrows(() => kidsScoreName(7), Error);
  assertThrows(() => kidsNameBytes("ELEVEN CHAR"), Error);
  assertThrows(() => kidsNameBytes("カナ"), Error); // katakana has no ASCII key
  assertThrows(() => kidsNameBytes(7), Error);
  assertEquals(kidsNameBytes("A").length, KIDS_TITLE_NAME_BYTES);

  // Every section-taking setter checks the buffer it was handed, not just the
  // first one to be written: a caller who passes the wrong section is told
  // rather than quietly repainting art with chip words.
  const tiny = new Uint8Array(4);
  assertRefuses(
    tiny,
    () => setKidsScrollNibble(tiny, 0, 0, 0),
    "four bytes as a data section",
  );

  // editKidsSave checks the decompressed lengths, because a short section is a
  // caller bug that would otherwise be sealed into a consistent directory.
  assertRefuses(
    block,
    () => editKidsSave(block, { data: data.subarray(0, KIDS_DATA_SIZE - 1) }),
    "a short data section",
  );
  assertRefuses(
    block,
    () => editKidsSave(block, { tail: new Uint8Array(KIDS_TAIL_SIZE + 1) }),
    "a long tail",
  );
  assertRefuses(
    block,
    () => editKidsSave(block, { graphics: data }),
    "data as graphics",
  );

  // Nothing above refused for a reason that also applies to the legal value
  // beside it: each of these writes, and the result loads.
  assertEquals(setKidsMapChip(data, 5, 6, 383, { cell: 1014 }).changed, true);
  assertEquals(setKidsMapChip(data, 0, 1, 1, { blank: true }).after, [
    0x00,
    0x80,
  ]);
  // Against whatever the fixture happens to hold, so "changed" is a statement
  // about the write and not about the seed: patterned() already leaves a 3 in
  // this nibble often enough that a literal 3 here reported changed: false.
  const nibble = (save.scroll[5].steps[191].nibble + 1) & 3;
  assertEquals(setKidsScrollNibble(data, 5, 191, nibble).changed, true);
  assertEquals(
    setKidsHiScore(tail, 10, { score: 0xffffffff, allClear: true, name })
      .changed,
    true,
  );
  // Level 4 is the invincible test play's marker (kids.js:82) and its reader
  // masks it to two bits, so the table prints it as MANIAC. No community entry
  // carries it — all 770 are 0..3 — so it is written with a warning rather than
  // refused: a save may legitimately record a run started inside the editor.
  const muteki = setKidsHiScore(tail, 2, { score: 500, level: 4 });
  assert(
    muteki.warnings.length > 0,
    "a MUTEKI level should say it is the test play's marker",
  );
  editKidsSave(block, { data, tail });
  const reparsed = parseKidsSave(block, { filename: KIDS_PRODUCT });
  assertEquals(reparsed.errors, []);
  assertEquals(validateKidsTable(block).ok, true);
  assertEquals(reparsed.map[5].words[383 * KIDS_MAP_COLUMNS + 6], 1014);
  assertEquals(reparsed.map[0].words[1 * KIDS_MAP_COLUMNS + 1], 0x8000);
  assertEquals(reparsed.scroll[5].steps[191].nibble, nibble);
  assertEquals(reparsed.hiScores[9].score, 0xffffffff);
  assertEquals(reparsed.hiScores[9].allClear, true);
  assertEquals(reparsed.hiScores[9].name, "ACE.....");
});

Deno.test("a byte a setter refuses to write is one no real save contains", () => {
  // The rules above are only worth enforcing if they describe the corpus rather
  // than a reading of it, and two of them are checkable here without the
  // fixtures: the scroll nibble and the chip alignment both hold on every byte
  // of a save this package itself round-trips. A rule that the fixture-gated
  // case at the end would catch is still better caught with an argument.
  const { block } = buildLooseKidsBlock();
  const data = Uint8Array.from(parseKidsSave(block).data);
  setKidsScrollNibble(data, 0, 0, 3);
  setKidsScrollNibble(data, 0, 1, 2);
  // Low nibble first inside each byte (kids.js:365-366), so those two units
  // share byte 0 as 0x23 — the read-modify-write preserved the neighbour.
  assertEquals(data[KIDS_REGION.scroll.offset], 0x23);
  setKidsScrollNibble(data, 0, 1, 0);
  assertEquals(data[KIDS_REGION.scroll.offset], 0x03);

  // Alignment holds for a blank chip too, which is the case a reader might
  // think is exempt: bit 15 makes the renderer ignore the cell number, but all
  // fourteen blank words that occur in the corpus still carry an aligned one,
  // so refusing an unaligned blank keeps a decode/encode round trip exact.
  assertRefuses(
    data,
    () => setKidsMapChip(data, 0, 0, 0, { cell: 3, blank: true }),
    "an unaligned blank chip",
  );
});

Deno.test("the game name is written into the title frame and needs no seal", () => {
  // The one field that is not in a section at all: the "SC" title's 20-byte
  // name window at 0x2E, ahead of everything the directory describes. All three
  // Kids! sums cover 0x180 and up and the directory itself sits at 0x100, so
  // the write is final the moment it lands — no editKidsSave, no reseal.
  const { block } = buildLooseKidsBlock();
  const before = Uint8Array.from(block);
  assertEquals(KIDS_TITLE_NAME_OFFSET, 0x2e);
  assertEquals(
    (block[KIDS_TITLE_NAME_OFFSET - 2] << 8) |
      block[KIDS_TITLE_NAME_OFFSET - 1],
    KIDS_TITLE_OPEN,
  );

  const write = setKidsGameName(block, "SHMUPX");
  assertEquals(write.section, "block");
  assertEquals(write.inBlock, true);
  assertEquals(write.offset, KIDS_TITLE_NAME_OFFSET);
  assertEquals(write.length, KIDS_TITLE_NAME_BYTES);
  assertEquals(write.changed, true);
  // Only the name field moved: nothing at or past 0x100, so no sum and no
  // directory word can have gone stale.
  assertEquals(
    diffOffsets(before, block).every((o) =>
      o >= KIDS_TITLE_NAME_OFFSET &&
      o < KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES
    ),
    true,
  );
  assertEquals(validateKidsTable(block).ok, true);
  assertEquals(kidsUnsealedWords(block), []);
  assertEquals(editKidsSave(block, {}).identical, true);
  assertEquals(
    (block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES] << 8) |
      block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 1],
    KIDS_TITLE_CLOSE,
  );
  assert(
    parseKidsSave(block).header.title.includes("ＳＨＭＵＰＸ"),
    `the name did not read back: ${parseKidsSave(block).header.title}`,
  );

  // A block whose title is laid out differently is refused rather than having
  // twenty bytes overwritten in the middle of it. 77 of the 77 community saves
  // carry 『 at 0x2C and 』 at 0x42; a block that does not is not this format.
  const bare = new Uint8Array(KIDS_BLOCK_SIZE);
  bare.set(block.subarray(KIDS_TABLE_OFFSET), KIDS_TABLE_OFFSET);
  assertRefuses(bare, () => setKidsGameName(bare, "X"), "no title brackets");
  assertRefuses(
    block,
    () => setKidsGameName(block, new Uint8Array(21)),
    "21 name bytes",
  );
  assertRefuses(
    block,
    () => setKidsGameName(block, new Uint8Array(3)),
    "an odd byte count",
  );
  assertRefuses(block, () => setKidsGameName(block, 7), "a number");
});

Deno.test("a block that is not a Kids! save is refused before anything is decompressed", () => {
  const { block } = buildLooseKidsBlock();
  assertThrows(
    () => editKidsSave(block.subarray(0, KIDS_BLOCK_SIZE - 1)),
    Error,
  );
  assertThrows(
    () => editKidsSave(new Uint8Array(KIDS_BLOCK_SIZE + PSV_HEADER_SIZE)),
    Error,
  );
  assertThrows(
    () => assertKidsBlock(new Uint8Array(KIDS_BLOCK_SIZE - 1)),
    Error,
  );
  assertThrows(() => sealKidsTable(new Uint8Array(KIDS_BLOCK_SIZE - 1)), Error);
  const notBytes = /** @type {Uint8Array} */ (/** @type {unknown} */ (
    new Array(KIDS_BLOCK_SIZE).fill(0)
  ));
  assertThrows(() => assertKidsBlock(notBytes), Error);

  // A directory that does not cross-check is refused rather than followed. The
  // sizes are what say where the next section starts, so a wrong word 9 does
  // not corrupt a field, it desynchronises the whole file — and because an LZSS
  // stream carries no length, nothing downstream can notice.
  const bent = Uint8Array.from(block);
  writeU32(bent, KIDS_TABLE_OFFSET + 9 * 4, 0x100);
  assertEquals(parseKidsTable(bent).consistent, false);
  assertRefuses(
    bent,
    () => editKidsSave(bent, {}),
    "an inconsistent directory",
  );
  assertRefuses(
    bent,
    () => kidsUnsealedWords(bent),
    "unsealed words of a bent table",
  );
  assertRefuses(
    bent,
    () => sealKidsTable(bent),
    "a seal with no sizes to read back",
  );
  // With the sizes supplied it CAN be sealed, which is the difference between
  // "this file is damaged" and "I know what these streams are".
  const rebuilt = sealKidsTable(bent, {
    graphics: parseKidsTable(block).sections.graphics.size,
    data: parseKidsTable(block).sections.data.size,
  });
  assertEquals(rebuilt.consistent, true);
  assertEquals(rebuilt.checksums.ok, true);
  assertEquals(diffOffsets(bent, block), []);
});

Deno.test("a card edited through placeKidsSave reparses to the edited block, and every directory frame still checksums", () => {
  // The only derived bytes at card level are the XOR checksums on the 16
  // directory frames (memcard.js:71), and a frame covers only its own 128
  // directory bytes. The save length cannot change either — it is always
  // 0x1E000 — so frame 0's u32 size at +4 and the chain link at +8 stay correct
  // through an edit that relays every section inside those bytes.
  const { block, filename } = buildLooseKidsBlock();
  const card = buildCard(block, filename);
  const edited = Uint8Array.from(block);
  const data = Uint8Array.from(parseKidsSave(edited).data);
  setKidsMapChip(data, 1, 2, 3, { cell: 0x80, vflip: true });
  setKidsGameName(edited, "EDITED");
  const write = editKidsSave(edited, { data });
  assertEquals(write.seal.consistent, true);

  const placement = placeKidsSave(card, edited);
  assertEquals(placement.filename, filename);
  assertEquals(placement.blocks, Array.from({ length: 15 }, (_, i) => i + 1));
  assertEquals(placement.bytes, 15 * BLOCK_SIZE);
  assertEquals(placement.framesOk, true);
  assertEquals(placement.warnings, []);

  const parsed = parseMemoryCard(card);
  assertEquals(parsed.files.length, 1);
  assertEquals(parsed.files[0].data, edited);
  assertEquals(parsed.files[0].complete, true);
  assertEquals(parsed.files[0].size, KIDS_BLOCK_SIZE);
  assertEquals(parsed.frames.every((f) => f.checksumOk), true);
  assertEquals(parsed.headerChecksumOk, true);
  assertEquals(parsed.magicOk, true);
  assertEquals(validateKidsTable(parsed.files[0].data).ok, true);
  const back = parseKidsSave(parsed.files[0].data, { filename: KIDS_PRODUCT });
  assertEquals(back.errors, []);
  assertEquals(back.map[1].words[3 * KIDS_MAP_COLUMNS + 2], 0x4080);
  assertEquals(back.data, data);
});

Deno.test("mutating the save locateSaves hands back leaves a card untouched", () => {
  // The trap placeKidsSave exists for. parseMemoryCard allocates a fresh buffer
  // and copies the chained blocks into it (memcard.js:161-163), then hands out a
  // subarray of THAT (:172), so for a card and a .gme the bytes locateSaves
  // returns are a COPY. Only .mcs (:209), .psv (:218) and a bare block (:222)
  // alias the caller — and psx-fixtures.test.js:111 pins container === "card"
  // for every Kids! dump in the collection, so the copy is the case that matters.
  const { block, filename } = buildLooseKidsBlock();
  const card = buildCard(block, filename);
  const located = locateSaves(card);
  assertEquals(located.container, "card");
  assertEquals(located.saves[0].filename, KIDS_PRODUCT);
  assert(
    located.saves[0].data.buffer !== card.buffer,
    "the card's save aliases the card image",
  );

  const was = card[BLOCK_SIZE + KIDS_TABLE_OFFSET];
  editKidsSave(located.saves[0].data, {
    tail: new Uint8Array(KIDS_TAIL_SIZE).fill(0x11),
  });
  assertEquals(
    card[BLOCK_SIZE + KIDS_TABLE_OFFSET],
    was,
    "editing the copy edited the card",
  );
  assertEquals(parseMemoryCard(card).files[0].data, block);
  assertEquals(locateSaves(block).container, "bare");
  assert(locateSaves(block).saves[0].data.buffer === block.buffer);
});

Deno.test("a chain that is not contiguous still writes back in order", () => {
  // chainFrom (memcard.js:133-146) follows the links, and the links are not
  // required to be contiguous or ascending — psx-memcard.test.js:57-63 builds a
  // card whose chain is [1, 15] on purpose. So placeKidsSave must index by CHAIN
  // POSITION and never by 1 + k. It costs more here than for Dezaemon+: an edit
  // relays every section, so a save written to the wrong blocks is not a
  // corrupted field, it is a directory pointing confidently at another block's
  // bytes.
  const { block, filename } = buildLooseKidsBlock();
  const card = buildCard(block, filename);
  relink(card, 0, STATUS.FIRST, 14); // block 1 -> block 15
  relink(card, 14, STATUS.MIDDLE, 1); // block 15 -> block 2
  relink(card, 13, STATUS.LAST, NO_NEXT); // block 14 ends the chain
  const chain = [1, 15, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  assertEquals(parseMemoryCard(card).files[0].blocks, chain);
  assertEquals(parseMemoryCard(card).files[0].complete, true);

  const edited = Uint8Array.from(block);
  const graphics = Uint8Array.from(parseKidsSave(edited).graphics);
  graphics.fill(0x7f, 512 * 256, 513 * 256);
  editKidsSave(edited, { graphics });
  const placement = placeKidsSave(card, edited);
  assertEquals(placement.blocks, chain);
  assertEquals(placement.framesOk, true);

  assertEquals(
    blockBytes(card, 15),
    edited.subarray(BLOCK_SIZE, 2 * BLOCK_SIZE),
  );
  assertEquals(
    blockBytes(card, 2),
    edited.subarray(2 * BLOCK_SIZE, 3 * BLOCK_SIZE),
  );
  assertEquals(parseMemoryCard(card).files[0].data, edited);
  const back = parseKidsSave(parseMemoryCard(card).files[0].data);
  assertEquals(back.errors, []);
  assertEquals(back.graphics, graphics);
});

Deno.test("placeKidsSave refuses a .psv, and names a card it cannot place into", () => {
  // A PS3 .psv carries a cryptographic signature over the save in its 0x84-byte
  // header, keyed to the console. Nothing in src/psx/ reads, checks or can
  // regenerate it — locateSaves slices at PSV_HEADER_SIZE and reads the filename
  // at 0x64 (memcard.js:214-219), and that is all. An edited .psv is a file this
  // package reads back happily and a real PS3 rejects, which is the worst
  // failure mode a surgical tool has: nothing in the toolchain warns.
  const { block, filename } = buildLooseKidsBlock();
  const psv = new Uint8Array(PSV_HEADER_SIZE + KIDS_BLOCK_SIZE);
  psv.set([0x00, 0x56, 0x53, 0x50], 0);
  psv.set(new TextEncoder().encode(filename), 0x64);
  psv.set(block, PSV_HEADER_SIZE);
  assertEquals(locateSaves(psv).container, "psv");
  const before = Uint8Array.from(psv);
  assertThrows(() => placeKidsSave(psv, block), Error, "signature");
  assertEquals(diffOffsets(before, psv), []);

  const card = buildCard(block, filename);
  assertThrows(
    () => placeKidsSave(new Uint8Array(CARD_SIZE - 1), block),
    Error,
  );
  assertThrows(
    () => placeKidsSave(card, block, { filename: "BISLPS-00000NONE" }),
    Error,
  );
  assertThrows(() => placeKidsSave(card, block, { index: 3 }), Error);
  assertThrows(
    () => placeKidsSave(card, block.subarray(0, KIDS_BLOCK_SIZE - 1)),
    Error,
  );

  // A block whose directory does not cross-check is refused by default and
  // placed with a warning on the caller's word — the escape exists for a block
  // that has not been sealed yet, not for a damaged one. There is no Select 100
  // case to excuse here: that re-release is Dezaemon+'s, and Kids! has no
  // headerless edition.
  const bent = Uint8Array.from(block);
  writeU32(bent, KIDS_TABLE_OFFSET, 0);
  assertThrows(() => placeKidsSave(card, bent), Error);
  const forced = placeKidsSave(card, bent, { requireKids: false });
  assert(
    forced.warnings.some((w) => w.includes("cross-check")),
    `placing an unsealed block should warn: ${JSON.stringify(forced.warnings)}`,
  );
  assertEquals(parseMemoryCard(card).files[0].data, bent);
});

Deno.test("placeKidsSave refuses a chain it cannot fill", () => {
  // Two paths buildCard cannot reach, because it always hands back a healthy
  // fifteen-block card. A Kids! save is 0x1E000 like a Dezaemon+ one, so it
  // needs all fifteen; what differs is the cost of a short write. The section
  // directory lives at 0x100, in the FIRST block, and the tail at word 7 lives
  // in the last — so a save whose fifteenth block is dropped keeps a directory
  // that points confidently at a tail the card no longer holds.
  const { block, filename } = buildLooseKidsBlock();

  // 1. Fifteen blocks that no frame ever flags last. `complete` is three
  // conditions ANDed (memcard.js:170) and this trips only the third, so the
  // block count is still right and the count guard below cannot catch it.
  const unclosed = buildCard(block, filename);
  relink(unclosed, 14, STATUS.MIDDLE, NO_NEXT);
  assertEquals(parseMemoryCard(unclosed).files[0].blocks.length, 15);
  assertEquals(parseMemoryCard(unclosed).files[0].complete, false);
  const beforeUnclosed = Uint8Array.from(unclosed);
  assertThrows(
    () => placeKidsSave(unclosed, block),
    Error,
    "incomplete block chain",
  );
  assertEquals(diffOffsets(beforeUnclosed, unclosed), []);

  // 2. A chain that IS complete and still too short. The two guards are ordered
  // rather than parallel: fourteen blocks under a frame 0 that still declares
  // 122880 bytes is caught by the one above, so the declared size has to shrink
  // with the chain to reach this one at all.
  const short = buildCard(block, filename);
  relink(short, 13, STATUS.LAST, NO_NEXT);
  relink(short, 14, STATUS.FREE, NO_NEXT);
  relink(short, 0, STATUS.FIRST, 1, 14 * BLOCK_SIZE);
  assertEquals(parseMemoryCard(short).files[0].complete, true);
  assertEquals(parseMemoryCard(short).files[0].blocks.length, 14);
  const beforeShort = Uint8Array.from(short);
  assertThrows(() => placeKidsSave(short, block), Error, "needs 15");
  assertEquals(diffOffsets(beforeShort, short), []);

  // 3. framesOk reports the card as it ARRIVED, and is not a constant.
  // placeKidsSave writes data blocks only, so a frame that was already broken
  // stays broken and the caller is the only one who can be told.
  const bent = buildCard(block, filename);
  bent[DIRECTORY_OFFSET + 5 * FRAME_SIZE + FRAME_SIZE - 1] ^= 0xff;
  assertEquals(parseMemoryCard(bent).frames[5].checksumOk, false);
  assertEquals(parseMemoryCard(bent).files[0].complete, true);
  const placement = placeKidsSave(bent, block);
  assertEquals(placement.framesOk, false);
  assertEquals(placement.blocks.length, 15);
  assertEquals(parseMemoryCard(bent).files[0].data, block);
});

Deno.test("nothing here builds a save, and nothing here recompresses a section by itself", () => {
  // The scope line, made mechanical. This module edits a block that already
  // parses: there is no buildKidsSave, no game.json mapper and no per-field
  // graphics setter — a pixel setter taking the BLOCK would mean
  // decompress-edit-recompress per pixel, ten different streams for ten pixels.
  // The absence is the design (kids-edit.js:605-624), so it is asserted rather
  // than described.
  for (
    const absent of [
      "buildKidsSave",
      "createKidsSave",
      "kidsSaveFromGame",
      "setKidsPixel",
      "setKidsCell",
      "setKidsGraphicsCell",
      "compressKidsSection",
    ]
  ) {
    assertEquals(typeof kidsEdit[absent], "undefined", absent);
  }
});

// The community collection in the repo-root dev-fixtures/ is gitignored; the
// case below is skipped without it. The walker is psx-fixtures.test.js:35-58's,
// including the `._` AppleDouble filter — those sidecars end in .sav and hold no
// save.
const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);

function savesUnder(folder) {
  const root = new URL(`${encodeURIComponent(folder)}/`, DEV_FIXTURES);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const url = new URL(
        `${encodeURIComponent(e.name)}${e.isDirectory ? "/" : ""}`,
        dir,
      );
      if (e.isDirectory) walk(url);
      else if (
        !e.name.startsWith("._") && e.name.toLowerCase().endsWith(".sav")
      ) out.push(url);
    }
  };
  walk(root);
  return out.sort((a, b) => a.href.localeCompare(b.href));
}

/**
 * Which game a dump actually holds, by the cheap path psx-fixtures.test.js:64
 * takes: peel the container and read the directory entry's name. No
 * decompression, and the answer is the same.
 */
function gameOf(url) {
  const located = locateSaves(Deno.readFileSync(url));
  if (located.container === "unknown") return null;
  const save = located.saves[0];
  return save ? identifyGame(save.data, save.filename) : null;
}

// Partitioned BY CONTENT, never by the folder a dump sits in. 20 of the 97 dumps
// under "Dezaemon Kids!/" are Dezaemon+ saves — the collection files by game,
// but not reliably — and editKidsSave on one of those fails for a reason that is
// not about this module. The directory entry's own name,
// BISLPS-01503DEZAKIDS against BISLPS-00335DEZA, is the only thing that says
// which game a card holds, and it is what identifyGame reads.
const KIDS = [...savesUnder("Dezaemon Kids!"), ...savesUnder("Dezaemon+")]
  .filter((u) => gameOf(u) === "kids");

Deno.test({
  name:
    "every community Dezaemon Kids! save survives an edit of nothing, byte for byte",
  ignore: KIDS.length === 0,
  fn() {
    // The strongest case in the file, and the only one that fails for a reason
    // the synthetic fixtures cannot reach: every real save's streams were
    // written by KIDS.EXE's own encoder at 0x8006C904, and src/compress.js
    // reproduces none of them. A pack that re-encoded an untouched section
    // would turn this red on the first file rather than in some corner.
    //
    // It also measures what the module's header claims, rather than restating
    // it: how many recompress identically (none), and how much room a full
    // re-encode would leave. Both are reported, not asserted, because fitting
    // is a property of this collection and not of the format — which is exactly
    // why the fit guard exists.
    let tightest = Infinity;
    let tightestName = "";
    let worstDelta = -Infinity;
    let worstName = "";
    let identicalStreams = 0;
    for (const url of KIDS) {
      const label = fromFileUrl(url);
      const located = locateSaves(Deno.readFileSync(url));
      assertEquals(located.container, "card", label);
      const save = located.saves.find((s) => s.filename === KIDS_PRODUCT);
      assert(save, `${label}: no ${KIDS_PRODUCT}`);
      const block = Uint8Array.from(save.data);
      const before = Uint8Array.from(block);

      const write = editKidsSave(block, {});
      assertEquals(
        diffOffsets(before, block),
        [],
        `${label}: an edit of nothing changed a real save`,
      );
      assertEquals(write.identical, true, label);
      assertEquals(write.changedBytes, 0, label);
      assertEquals(write.seal.words, [], label);
      assertEquals(write.sourceChecksums.ok, true, label);
      assertEquals(write.seal.checksums.ok, true, label);
      assertEquals(write.seal.consistent, true, label);
      for (const name of ["graphics", "data"]) {
        assertEquals(moveOf(write, name).paddingKept, true, `${label} ${name}`);
        assertEquals(
          moveOf(write, name).recompressed,
          false,
          `${label} ${name}`,
        );
      }

      // What a needless re-encode would have cost, and whether it would still
      // have fitted.
      const table = parseKidsTable(block);
      const g = table.sections.graphics;
      const d = table.sections.data;
      const gfx = compress(
        decompress(block.subarray(g.offset, g.offset + g.size)),
      );
      const dat = compress(
        decompress(block.subarray(d.offset, d.offset + d.size)),
      );
      const same = gfx.length === g.size && dat.length === d.size &&
        gfx.every((b, i) => b === block[g.offset + i]) &&
        dat.every((b, i) => b === block[d.offset + i]);
      if (same) identicalStreams++;
      const delta = (gfx.length - g.size) + (dat.length - d.size);
      if (delta > worstDelta) {
        worstDelta = delta;
        worstName = label;
      }
      const need = KIDS_FIRST_SECTION + roundUp(gfx.length, KIDS_SECTOR) +
        roundUp(dat.length, KIDS_SECTOR) + KIDS_TAIL_SIZE;
      if (KIDS_BLOCK_SIZE - need < tightest) {
        tightest = KIDS_BLOCK_SIZE - need;
        tightestName = label;
      }
    }
    assertEquals(
      identicalStreams,
      0,
      "a real save recompressed to its own bytes, which would mean src/compress.js IS the game's encoder and " +
        "copy-verbatim is no longer the only way this case can pass",
    );
    console.log(
      `  ${KIDS.length} Kids! saves survive an edit of nothing; 0 recompress to their own bytes ` +
        `(worst +${worstDelta} on ${worstName}); tightest slack after a full re-encode is ${tightest} ` +
        `bytes on ${tightestName}`,
    );
  },
});
