// Editing a Dezaemon+ save in place: that a seal changes exactly the two
// bytes an edit owes it, that every rule the API enforces is a refusal, and
// that a card round-trips through blockBytes rather than through the copy
// locateSaves hands back.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
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
  u16le,
} from "../src/psx/memcard.js";
import {
  decodePlusAppearByte,
  decodePlusEnemyData,
  decodePlusGlobals,
  decodePlusGraphics,
  decodePlusGroupWord,
  decodePlusHiScores,
  decodePlusPalettes,
  decodePlusSettings,
  decodePlusStage,
  parsePlusSave,
  PLUS_APPEAR_END_MARK,
  PLUS_BLOCK_SIZE,
  PLUS_CHECKED_GROUPS,
  PLUS_CHECKSUM_OFFSET,
  PLUS_GLOBAL_OFFSET,
  PLUS_GRAPHICS_OFFSET,
  PLUS_HISCORE_OFFSET,
  PLUS_HISCORE_TABLE_BYTES,
  PLUS_PALETTE_OFFSET,
  PLUS_PRODUCT,
  PLUS_SETTINGS_OFFSET,
  PLUS_SONG_SIZE,
  PLUS_SOUND_OFFSET,
  PLUS_STAGE_SIZE,
  PLUS_STAGES,
  PLUS_STAGES_OFFSET,
  plusChecksums,
  plusStageOffset,
} from "../src/psx/plus.js";
import * as plusEdit from "../src/psx/plus-edit.js";
import {
  assertPlusBlock,
  copyPlusSong,
  placePlusSave,
  PLUS_MENU_BGM_OFF,
  PLUS_SEALED_GROUPS,
  PLUS_UNSEALED_GROUP,
  PLUS_UNSEALED_OFFSET,
  plusAppearByte,
  plusColorWord,
  plusEntryAt,
  plusGroupAt,
  plusGroupsIn,
  plusUnsealedGroups,
  sealPlusChecksums,
  setPlusAppearByte,
  setPlusAppearRow,
  setPlusBgmSlot,
  setPlusChargeTime,
  setPlusCursorSpeed,
  setPlusEnemyByte,
  setPlusEnemyDefinition,
  setPlusGroupFlip,
  setPlusHiScore,
  setPlusItemSlot,
  setPlusKeyConfig,
  setPlusMapCell,
  setPlusMapGroupTile,
  setPlusMenuBgm,
  setPlusPaletteColor,
  setPlusPaletteRow,
  setPlusPixel,
  setPlusPixels,
  setPlusScoreBonus,
  setPlusScrollBlock,
  setPlusShipOdrBit,
  setPlusStageCount,
  setPlusStereo,
  setPlusTitleType,
  swapPlusGroupWords,
} from "../src/psx/plus-edit.js";
import {
  buildCard,
  buildPlusBlock,
  writeU16,
  writeU32,
} from "./_psx-synthetic.js";

/**
 * Exactly the offsets at which two blocks differ.
 *
 * Deliberately not coalesceDiffRanges()/totalDiffBytes() (src/diff-ranges.js:7,
 * :26): their default minGap of 8 merges two runs separated by fewer than
 * eight identical bytes and then counts those identical bytes as differing —
 * two differing bytes five apart report one range [[4, 9]] and a total of 6.
 * Every count in this file is byte-exact, because "N + 2 bytes per checksum
 * group it dirties" is the contract and 6 is not 3.
 */
function diffOffsets(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/**
 * A refused setter throws AND writes nothing. The second half matters as much
 * as the first: a setter that validated after writing would leave a block that
 * seals cleanly around a value the game jumps through.
 */
function assertRefuses(block, fn, note) {
  const before = Uint8Array.from(block);
  assertThrows(fn, Error, "", note);
  assertEquals(
    diffOffsets(before, block),
    [],
    `${note}: a refused setter wrote bytes`,
  );
}

/** `n` copies of one palette index, for the bulk pixel writes. */
function filled(n, v) {
  return Array.from({ length: n }, () => v);
}

/**
 * Rewrite one directory frame's status and link, then fix its XOR checksum.
 *
 * `size` rewrites frame 0's declared u32 at +4 (memcard.js:111), and a chain
 * cannot be shortened without it: parseMemoryCard's `complete` is
 * `frame.size <= joined.length` ANDed with two more conditions
 * (memcard.js:170), so a card whose chain drops to fourteen blocks while
 * frame 0 still declares 122880 bytes parses as INCOMPLETE, not as short.
 */
function relink(card, index, status, next, size) {
  const at = DIRECTORY_OFFSET + index * FRAME_SIZE;
  const frame = card.subarray(at, at + FRAME_SIZE);
  frame[0] = status;
  writeU16(frame, 8, next);
  if (size !== undefined) writeU32(frame, 4, size);
  frame[FRAME_SIZE - 1] = frameChecksum(frame);
}

// File offsets the tests name by hand, each derived from PLUS_GLOBAL_OFFSET
// (0x1AF2C) plus the running length of PLUS_GLOBAL_LAYOUT's pieces.
const TITLE_TYPE = 0x1af2c;
const SHIP_GROUP = 0x1af86;
const SHIP_ODR = 0x1b020;
const ITEM_TABLE = 0x1b06d;
const SCORE_BONUS = 0x1b07d;
const CHARGE_TIME = 0x1b07e;
const STAGE_COUNT = 0x1b07f;
const BGM_ASSIGNMENT = 0x1b080;
// Piece offsets inside a 0x223C stage block (PLUS_STAGE_LAYOUT).
const STAGE_SCROLL = 0x0900;
const STAGE_MAP_GROUP = 0x0b00;
const STAGE_ENEMY_DATA = 0x0c80;
const STAGE_APPEAR = 0x0fc0;
const STAGE_APPEAR_ROWS = STAGE_APPEAR + 0x0e00;

Deno.test("an edit that changes nothing reseals to the same bytes", () => {
  // Idempotence is the contract the whole editor rests on: buildPlusBlock
  // seals all twenty words on return (test/_psx-synthetic.js:175-176), so the
  // nineteen a seal writes already hold their own values and the seal must
  // write none of them. If this ever changes a byte, "seal, then diff" stops
  // meaning anything and the CLI's always-seal becomes a corrupter.
  const { block } = buildPlusBlock();
  const before = Uint8Array.from(block);
  const seal = sealPlusChecksums(block);
  assertEquals(diffOffsets(before, block), []);
  assertEquals(before, block);
  assertEquals(seal.words, []);
  assertEquals(seal.groups, []);
  assertEquals(seal.bytes, 0);
  assertEquals(seal.ok, true);
  assertEquals(seal.unsealedGroup, PLUS_UNSEALED_GROUP);
  // A second seal is the same no-op, and so is a third.
  assertEquals(sealPlusChecksums(block).bytes, 0);
  assertEquals(diffOffsets(before, block), []);
  assertEquals(plusUnsealedGroups(block), []);
});

Deno.test("one poked byte and its checksum word are the only three bytes that change", () => {
  // Measured, both pairs: 0x1041 sits in graphics quarter 0 (flag group 1,
  // plus.js:204) and 0x12345 in stage 0's APPEAR (flag group 6), and each
  // reseals to itself plus the two bytes of its own group's u16 at
  // PLUS_CHECKSUM_OFFSET + group * 2. Three bytes, not five, because group
  // 0x13 is never written.
  for (
    const [at, group, word] of [
      [0x1041, 1, 0x1dfda],
      [0x12345, 6, 0x1dfe4],
    ]
  ) {
    const { block } = buildPlusBlock();
    const before = Uint8Array.from(block);
    block[at] ^= 0xff;
    assertEquals(
      plusChecksums(block).bad,
      [group],
      `poke 0x${at.toString(16)}`,
    );
    assertEquals(plusUnsealedGroups(block), [group]);
    const seal = sealPlusChecksums(block);
    assertEquals(diffOffsets(before, block), [at, word, word + 1]);
    assertEquals(seal.groups, [group]);
    assertEquals(seal.bytes, 2);
    assertEquals(seal.words.length, 1);
    assertEquals(seal.words[0].group, group);
    assertEquals(seal.words[0].offset, word);
    assert(
      seal.words[0].before !== seal.words[0].after,
      "the word did not move",
    );
    assertEquals(seal.words[0].after, u16le(block, word));
    assertEquals(seal.ok, true);
  }
});

Deno.test("a resealed block parses clean and every verified group matches", () => {
  // The analogue of buildPayload ending in parseSectionTable (bup-write.js:100):
  // read the output back through the reader that real files go through, not
  // through the writer's own idea of what it wrote.
  const { block } = buildPlusBlock();
  block[0x1041] ^= 0xff;
  block[0x12345] ^= 0xff;
  assertEquals(plusChecksums(block).bad, [1, 6]);
  const seal = sealPlusChecksums(block);
  assertEquals(seal.groups, [1, 6]);
  assertEquals(seal.bytes, 4);
  const parsed = parsePlusSave(block, { filename: PLUS_PRODUCT });
  assertEquals(parsed.errors, []);
  assertEquals(parsed.checksums.ok, true);
  assertEquals(parsed.checksums.bad, []);
  assertEquals(parsed.checksums.checkedGroups, PLUS_CHECKED_GROUPS);
  assertEquals(parsed.sizeOk, true);
});

Deno.test("the last checksum word is never written, because it does not converge", () => {
  // Group 0x13 covers the checksum array itself (plus.js:79, :257 — the
  // comparison loop stops at PLUS_CHECKED_GROUPS), so writing it changes the
  // bytes it is computed over. Measured on this very block, four passes give
  // four values: stored 2920 -> 13002 -> 13863 -> 12913. Making it an option
  // would cost every seal two bytes of churn and destroy idempotence, so it
  // is not an option; it is an exported fact.
  assertEquals(PLUS_UNSEALED_GROUP, 0x13);
  assertEquals(PLUS_UNSEALED_OFFSET, 0x1dffe);
  assertEquals(
    PLUS_UNSEALED_OFFSET,
    PLUS_CHECKSUM_OFFSET + PLUS_UNSEALED_GROUP * 2,
  );
  assertEquals(PLUS_SEALED_GROUPS, PLUS_CHECKED_GROUPS);

  const { block } = buildPlusBlock();
  const tail = [block[0x1dffe], block[0x1dfff]];
  block[0x1041] ^= 0xff;
  const first = sealPlusChecksums(block);
  const second = sealPlusChecksums(block);
  assertEquals([block[0x1dffe], block[0x1dfff]], tail);
  assertEquals(first.unsealedGroup, 0x13);
  assertEquals(first.unsealedOffset, 0x1dffe);
  assert(
    first.groups.every((g) => g < PLUS_CHECKED_GROUPS),
    "a seal wrote a group it must not",
  );
  assertEquals(second.words, []);

  // The non-convergence itself, pinned so nobody adds { all: true } later.
  const { block: settle } = buildPlusBlock();
  const seen = [];
  for (let pass = 0; pass < 3; pass++) {
    const cs = plusChecksums(settle);
    assert(
      cs.computed[PLUS_UNSEALED_GROUP] !== cs.stored[PLUS_UNSEALED_GROUP],
      `pass ${pass}: group 0x13 settled, which would mean a second write pass exists`,
    );
    seen.push(cs.stored[PLUS_UNSEALED_GROUP]);
    writeU16(settle, PLUS_UNSEALED_OFFSET, cs.computed[PLUS_UNSEALED_GROUP]);
  }
  assertEquals(
    new Set(seen).size,
    3,
    "three passes should give three different stored values",
  );
});

Deno.test("a byte whose within-entry offset is a multiple of 32 never moves its group, so the checksums cannot prove an edit landed", () => {
  // Do not "fix" this. A byte at a within-entry offset that is a multiple
  // of 32 is multiplied by zero (plus.js:244, and FORMAT-PSX.md:439-441,
  // "Checksums"), so its value never reaches the sum — 3,850 of the file's
  // 122,880 bytes, 3.13%. Cursor speed, font bank, menu BGM and keys[0] are
  // all such bytes, and so are the score bonus at 0x1B07D and TITLE TYPE's
  // first byte at 0x1AF2C. Verify an edit by diffing bytes, never by
  // comparing checksums.
  const { block } = buildPlusBlock();
  const blind = setPlusCursorSpeed(block, 2);
  assertEquals(block[PLUS_SETTINGS_OFFSET], 2);
  assertEquals(decodePlusSettings(block).cursorSpeed, 2);
  assertEquals(plusChecksums(block).bad, []);
  assertEquals(blind.checksumBlind, true);
  assertEquals(blind.changed, true);
  assertEquals(blind.sealed, false);
  assertEquals(blind.offset, 0x1dfd0);
  assertEquals(blind.groups, [0x12]);

  const bonus = setPlusScoreBonus(block, 7);
  assertEquals(block[SCORE_BONUS], 7);
  assertEquals(bonus.checksumBlind, true);
  assertEquals(plusChecksums(block).bad, []);

  // The counter-case, so the property reads as a property and not as "the
  // checksums are broken": one byte further along the same settings entry
  // does move group 0x12.
  const loud = setPlusStereo(block, true);
  assertEquals(block[0x1dfd3], 1);
  assertEquals(decodePlusSettings(block).stereo, true);
  assertEquals(loud.checksumBlind, false);
  assertEquals(loud.offset, 0x1dfd3);
  assertEquals(plusChecksums(block).bad, [0x12]);
  // And the seal fixes the loud one while the blind ones ride along unnoticed.
  assertEquals(sealPlusChecksums(block).groups, [0x12]);
  assertEquals(plusChecksums(block).bad, []);

  // The three blind bytes above all sit at within-entry offset ZERO, where
  // the `& 0x1f` in plus-edit.js's checksumWeightAt cannot fire — drop
  // the mask and every assertion so far still passes. But zero is the rare
  // case: one byte per table entry, 74 of the 3,850 blind bytes. The other
  // 3,776 are at within-entry 32, 64, 96 …, and this is one of them.
  //
  // Stage 0's ENEMY DATA is one 0x200-byte table entry of 8-byte definitions
  // (plus.js:100-101), so definition 4's byte 0 — the movement-script index
  // decodePlusEnemy reads at plus.js:494 — is exactly 32 bytes into it, at
  // file offset 0x110A0. Measured: writing it leaves `bad` empty and a seal
  // writes nothing, so the byte really is blind and the record must say so.
  const script = setPlusEnemyByte(block, 0, 4, 0, 37);
  assertEquals(script.offset, 0x110a0);
  assertEquals(script.groups, [6]);
  assertEquals(script.changed, true);
  assertEquals(script.checksumBlind, true);
  assertEquals(
    decodePlusEnemyData(decodePlusStage(block, 0)).enemies[4].movement,
    37,
  );
  assertEquals(plusChecksums(block).bad, []);
  assertEquals(sealPlusChecksums(block).words, []);

  // Its neighbour one byte along is within-entry 33, weight 1, and loud —
  // the same counter-case as stereo above, one entry wide instead of one
  // byte, so "blind" reads as a property of the offset and not of the field.
  const shot = setPlusEnemyByte(block, 0, 4, 1, 3);
  assertEquals(shot.offset, 0x110a1);
  assertEquals(shot.checksumBlind, false);
  assertEquals(plusChecksums(block).bad, [6]);
});

Deno.test("a repaint that straddles a graphics quarter dirties two groups, and one seal fixes both", () => {
  // The bank is 256 px wide (PLUS_GRAPHICS_WIDTH, plus.js:46) at two pixels
  // per byte (plus.js:369-370), so the row pitch is 128 bytes and pixel row
  // 128 is file offset 0x100 + 0x4000 = 0x4100 — the boundary between
  // graphics quarters 0 and 1, which are checksum groups 1 and 2
  // (plus.js:204). The quarters are checksum boundaries, not picture
  // boundaries (FORMAT-PSX.md:447-448, "GRAPHICS and PALETTES"), which is
  // exactly why a seal is never partial.
  const { block } = buildPlusBlock();
  const write = setPlusPixels(block, {
    x: 0,
    y: 120,
    width: 16,
    height: 16,
    indices: filled(256, 5),
  });
  assertEquals(write.groups, [1, 2]);
  assertEquals(write.changed, true);
  assertEquals(write.checksumBlind, false);
  assertEquals(write.sealed, false);
  assertEquals(plusChecksums(block).bad, [1, 2]);
  const seal = sealPlusChecksums(block);
  assertEquals(seal.groups, [1, 2]);
  assertEquals(seal.bytes, 4);
  assertEquals(seal.ok, true);
  assertEquals(plusChecksums(block).bad, []);
  const pixels = decodePlusGraphics(block).indexed;
  assertEquals(pixels[120 * 256 + 0], 5);
  assertEquals(pixels[135 * 256 + 15], 5);
});

Deno.test("every write names the checksum group it dirtied", () => {
  // plusGroupRegions() (plus.js:262-264) goes group -> regions only; every
  // PlusWrite needs the other direction. It must come from PLUS_TABLE, not
  // from PLUS_REGIONS: graphics is four groups, stages five and sound four,
  // so a coarse-region guess is wrong for 13 of the 20.
  const spots = [
    {
      at: PLUS_GRAPHICS_OFFSET + 0 * 128,
      group: 0x01,
      label: "graphics row 0",
    },
    {
      at: PLUS_GRAPHICS_OFFSET + 128 * 128,
      group: 0x02,
      label: "graphics row 128",
    },
    {
      at: PLUS_GRAPHICS_OFFSET + 256 * 128,
      group: 0x03,
      label: "graphics row 256",
    },
    {
      at: PLUS_GRAPHICS_OFFSET + 384 * 128,
      group: 0x04,
      label: "graphics row 384",
    },
    { at: PLUS_PALETTE_OFFSET, group: 0x05, label: "palettes" },
    { at: PLUS_GLOBAL_OFFSET, group: 0x0b, label: "global" },
    { at: SCORE_BONUS, group: 0x0b, label: "score bonus" },
    {
      at: PLUS_SOUND_OFFSET + 0 * PLUS_SONG_SIZE,
      group: 0x0c,
      label: "song 0",
    },
    {
      at: PLUS_SOUND_OFFSET + 3 * PLUS_SONG_SIZE,
      group: 0x0c,
      label: "song 3",
    },
    {
      at: PLUS_SOUND_OFFSET + 4 * PLUS_SONG_SIZE,
      group: 0x0d,
      label: "song 4",
    },
    {
      at: PLUS_SOUND_OFFSET + 15 * PLUS_SONG_SIZE,
      group: 0x0f,
      label: "song 15",
    },
    { at: PLUS_HISCORE_OFFSET, group: 0x10, label: "hi-score table A" },
    {
      at: PLUS_HISCORE_OFFSET + PLUS_HISCORE_TABLE_BYTES,
      group: 0x11,
      label: "hi-score table B",
    },
    { at: PLUS_SETTINGS_OFFSET, group: 0x12, label: "settings" },
    { at: PLUS_CHECKSUM_OFFSET, group: 0x13, label: "checksums" },
  ];
  for (const { at, group, label } of spots) {
    assertEquals(plusGroupAt(at), group, label);
    assertEquals(plusGroupsIn(at, 1), [group], label);
  }
  for (let s = 0; s < PLUS_STAGES; s++) {
    assertEquals(plusGroupAt(plusStageOffset(s)), 0x06 + s, `stage ${s}`);
  }
  // A range that crosses the 0x4100 quarter boundary names both groups.
  assertEquals(plusGroupsIn(PLUS_GRAPHICS_OFFSET + 127 * 128, 256), [1, 2]);
  assertEquals(plusGroupsIn(PLUS_PALETTE_OFFSET, 32), [5]);

  const row = plusEntryAt(PLUS_PALETTE_OFFSET);
  assert(row, "the palette offset has no table row");
  assertEquals(row.group, "palettes");
  assertEquals(row.offset, PLUS_PALETTE_OFFSET);
  const stage2 = plusEntryAt(plusStageOffset(2));
  assert(stage2, "stage 2's base has no table row");
  assertEquals(stage2.group, "stage 2");
  assertEquals(plusEntryAt(PLUS_BLOCK_SIZE), null);
  assertEquals(plusEntryAt(-1), null);
  assertEquals(plusGroupAt(PLUS_BLOCK_SIZE), null);
});

Deno.test("a seal refuses a block that is not exactly 0x1E000 bytes, in both directions", () => {
  // The long case is the important one. plusChecksums tests `<` not `!==`
  // (plus.js:234), so handing it the 0x1E084 bytes of an unsliced .psv gets
  // ok:false with no complaint — it silently checksums the first 0x1E000,
  // which happen to be the header plus the block's first 0x1DF7C. An editor
  // that inherited that would write 38 bytes of "checksums" into the middle
  // of the save.
  assertThrows(
    () => sealPlusChecksums(new Uint8Array(PLUS_BLOCK_SIZE - 1)),
    Error,
  );
  assertThrows(
    () => assertPlusBlock(new Uint8Array(PLUS_BLOCK_SIZE - 1)),
    Error,
  );
  assertThrows(
    () => sealPlusChecksums(new Uint8Array(PLUS_BLOCK_SIZE + 0x84)),
    Error,
  );
  assertThrows(
    () => assertPlusBlock(new Uint8Array(PLUS_BLOCK_SIZE + 0x84)),
    Error,
  );
  assertThrows(
    () => plusUnsealedGroups(new Uint8Array(PLUS_BLOCK_SIZE + 0x84)),
    Error,
  );
  const notBytes = /** @type {Uint8Array} */ (/** @type {unknown} */ (
    new Array(PLUS_BLOCK_SIZE).fill(0)
  ));
  assertThrows(() => assertPlusBlock(notBytes), Error);

  const { block } = buildPlusBlock();
  const big = new Uint8Array(PLUS_BLOCK_SIZE + 0x84);
  big.set(block, 0x84);
  assertEquals(plusChecksums(big).ok, false);
  assertEquals(
    plusChecksums(big.subarray(0x84, 0x84 + PLUS_BLOCK_SIZE)).ok,
    true,
  );
  assertEquals(
    sealPlusChecksums(big.subarray(0x84, 0x84 + PLUS_BLOCK_SIZE)).bytes,
    0,
  );
});

Deno.test("the two enemy index fields that reach an indirect jump refuse an out-of-range value", () => {
  // FORMAT-PSX.md:598-599, "ENEMY DATA, field by field": byte 0 is a
  // movement script 0..159 into the pointer table 0x8007D760, and byte 1's
  // low five bits a shot pattern 0..19 into the spawner's function table
  // 0x8007DCA4. plus.js:494 reads byte 0 with no clamp at all and
  // plus.js:495 masks byte 1 to 0x1F and stops there, so 160 and 20 fetch a
  // word past the end of a table and the game jumps through it. These are
  // the only two fields in the whole save where an in-range-looking byte
  // reaches an indirect jump, which is why they are the only two that
  // refuse rather than warn.
  const { block } = buildPlusBlock();
  const base = plusStageOffset(0) + STAGE_ENEMY_DATA;
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 0, 0, 160),
    "movement 160",
  );
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 0, 0, 255),
    "movement 255",
  );
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 0, 1, 20),
    "shot pattern 20",
  );
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 0, 1, 0xf4),
    "shot pattern 20 under a fire rate",
  );
  assertRefuses(
    block,
    () => setPlusEnemyDefinition(block, 0, 0, [160, 0, 0, 0, 0, 0, 0, 0]),
    "definition movement 160",
  );
  assertRefuses(
    block,
    () => setPlusEnemyDefinition(block, 0, 0, [0, 20, 0, 0, 0, 0, 0, 0]),
    "definition shot pattern 20",
  );
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 60, 0, 0),
    "definition 60",
  );
  assertRefuses(block, () => setPlusEnemyByte(block, 0, 0, 8, 0), "byte 8");
  assertRefuses(
    block,
    () => setPlusEnemyByte(block, 0, 0, 0, 256),
    "value 256",
  );
  assertRefuses(
    block,
    () => setPlusEnemyDefinition(block, 0, 0, [0, 0, 0, 0, 0, 0, 0]),
    "seven bytes",
  );

  // The top legal value of each is written, not clamped away from.
  assertEquals(setPlusEnemyByte(block, 0, 0, 0, 159).changed, true);
  assertEquals(block[base], 159);
  assertEquals(setPlusEnemyByte(block, 0, 0, 1, 0xf3).changed, true); // 0xF3 & 0x1F === 19
  assertEquals(block[base + 1], 0xf3);
  const whole = setPlusEnemyDefinition(block, 0, 1, [
    159,
    19,
    0,
    1,
    2,
    3,
    4,
    5,
  ]);
  assertEquals(whole.length, 8);
  assertEquals(whole.offset, base + 8);
  assertEquals(whole.groups, [6]);
  assertEquals(Array.from(block.subarray(base + 8, base + 16)), [
    159,
    19,
    0,
    1,
    2,
    3,
    4,
    5,
  ]);
  assertEquals(sealPlusChecksums(block).groups, [6]);
});

Deno.test("a stage index above 4 is refused, because stage 5's offset is the global block", () => {
  // plusStageOffset has no bounds check (plus.js:384-386) and stage 5 lands
  // exactly on the global block, so an off-by-one stage index writes game-wide
  // tables, dirties group 0x0B instead of a stage group, and still verifies.
  // Stage 7 is worse: decodePlusStage hands back zero-length views and reports
  // no error at all. The bound belongs in the editor, not in the reader.
  assertEquals(plusStageOffset(5), PLUS_GLOBAL_OFFSET);
  assertEquals(
    PLUS_STAGES_OFFSET + PLUS_STAGES * PLUS_STAGE_SIZE,
    PLUS_GLOBAL_OFFSET,
  );
  const { block } = buildPlusBlock();
  assertEquals(decodePlusStage(block, 7).parts.map.length, 0);

  const scoped = [
    {
      name: "setPlusMapCell",
      at: (s) => setPlusMapCell(block, s, 1, 0, { group: 1 }),
    },
    {
      name: "setPlusMapGroupTile",
      at: (s) => setPlusMapGroupTile(block, s, 0, { column: 0, row: 0 }),
    },
    {
      name: "setPlusScrollBlock",
      at: (s) => setPlusScrollBlock(block, s, 0, 0),
    },
    {
      name: "setPlusAppearByte",
      at: (s) => setPlusAppearByte(block, s, 0, 0, 0x83),
    },
    { name: "setPlusAppearRow", at: (s) => setPlusAppearRow(block, s, 0, 0) },
    {
      name: "setPlusEnemyByte",
      at: (s) => setPlusEnemyByte(block, s, 0, 0, 0),
    },
    {
      name: "setPlusEnemyDefinition",
      at: (s) => setPlusEnemyDefinition(block, s, 0, [0, 0, 0, 0, 0, 0, 0, 0]),
    },
  ];
  for (const { name, at } of scoped) {
    assertRefuses(block, () => at(5), `${name} at stage 5`);
    assertRefuses(block, () => at(7), `${name} at stage 7`);
    assertRefuses(block, () => at(-1), `${name} at stage -1`);
  }
});

Deno.test("a chip in map column 0 or 15 is refused, because the playfield is 224 px wide", () => {
  // FORMAT-PSX.md:488-491, "MAP and MAP GROUP", and the corpus: columns 0
  // and 15 carry no chip in any known save, which is also the statistical
  // evidence the v-flip bit order rests on — refusing them keeps row byte
  // 8's bit 7 and byte 17's bit 0 clear by construction rather than by
  // convention.
  const { block } = buildPlusBlock();
  for (const column of [0, 15]) {
    assertRefuses(
      block,
      () => setPlusMapCell(block, 0, column, 10, { group: 3 }),
      `column ${column}`,
    );
    assertRefuses(
      block,
      () => setPlusMapCell(block, 0, column, 10, { group: 0, vflip: true }),
      `column ${column} v-flip`,
    );
  }
  assertRefuses(
    block,
    () => setPlusMapCell(block, 0, 16, 0, { group: 1 }),
    "column 16",
  );
  assertRefuses(
    block,
    () => setPlusMapCell(block, 0, 1, 128, { group: 1 }),
    "row 128",
  );
  assertRefuses(
    block,
    () => setPlusMapCell(block, 0, 1, 0, { group: 128 }),
    "group 128",
  );

  // Clearing a column-0 cell is not a chip, so it is allowed.
  setPlusMapCell(block, 0, 0, 10, { group: 0 });

  // A real chip round-trips through decodePlusMapRow, flip bits and all.
  const near = setPlusMapCell(block, 0, 1, 10, {
    group: 3,
    hflip: true,
    vflip: false,
  });
  const far = setPlusMapCell(block, 0, 8, 10, {
    group: 5,
    hflip: false,
    vflip: true,
  });
  assertEquals(near.groups, [6]);
  assertEquals(far.groups, [6]);
  const chips = decodePlusStage(block, 0).mapRows[10];
  assertEquals(chips[1], {
    raw: 0x83,
    group: 3,
    hflip: true,
    vflip: false,
    blank: false,
  });
  assertEquals(chips[8], {
    raw: 0x05,
    group: 5,
    hflip: false,
    vflip: true,
    blank: false,
  });
});

Deno.test("a MAP GROUP page the stage does not already use is refused, and an omitted page is preserved", () => {
  // "Preserve, never synthesize", made mechanical: which pair of tile
  // buffers a save names is edition-dependent (FORMAT-PSX.md:741-743,
  // "Unresolved"), so a page may only be written if this stage already uses
  // it somewhere. And bits above 9 are kept as found — decodePlusGroupWord
  // clamps to 0x3FF (plus.js:402) and 0xFFFF genuinely occurs
  // (psx-plus.test.js:182-183), so normalising it would change bytes,
  // change a checksum, and change nothing the game sees.
  const { block } = buildPlusBlock();
  const mg = plusStageOffset(0) + STAGE_MAP_GROUP;
  writeU16(block, mg + 7 * 2, 0x0200); // page 2 now occurs in this stage
  writeU16(block, mg + 5 * 2, 0x0200); // the word under edit is on page 2 too

  const kept = setPlusMapGroupTile(block, 0, 5, { column: 3, row: 4 });
  assertEquals(u16le(block, mg + 5 * 2), 0x0223);
  assertEquals(kept.groups, [6]);
  assertEquals(kept.length, 2);

  // Pages 1 and 3 appear in no word of this stage, so neither can be added.
  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 5, { column: 3, row: 4, page: 1 }),
    "page 1",
  );
  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 5, { column: 3, row: 4, page: 3 }),
    "page 3",
  );
  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 5, { column: 3, row: 4, page: 4 }),
    "page 4",
  );
  // Page 0 is what every other word names, so it is writable.
  const moved = setPlusMapGroupTile(block, 0, 5, {
    column: 3,
    row: 4,
    page: 0,
  });
  assertEquals(u16le(block, mg + 5 * 2), 0x0023);
  assertEquals(moved.changed, true);

  // A word above the reader's clamp keeps its six spare high bits AND its
  // literal page bits. This is the one place two house rules pull apart, so
  // the exact word is pinned rather than a property of it: an omitted `page`
  // preserves bits 8-9 AS THEY SIT, not as decodePlusGroupWord() reports them.
  // That decoder clamps to 0x3FF first (plus.js:402), so it calls 0xFC00 page
  // 3 — reading the page back through it would rewrite two bits the caller
  // never mentioned, which is exactly what an omitted argument must not do.
  // Measured: the literal reading writes 0xFC23, the clamped one 0xFF23.
  writeU16(block, mg + 6 * 2, 0xfc00);
  const spare = setPlusMapGroupTile(block, 0, 6, { column: 3, row: 4 });
  assertEquals(
    u16le(block, mg + 6 * 2),
    0xfc23,
    "an omitted page must keep bits 8-9 literally; 0xff23 means it was read back through the 0x3ff clamp",
  );
  assert(spare.warnings.length > 0, "a word above the 0x3FF clamp should warn");

  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 128, { column: 0, row: 0 }),
    "index 128",
  );
  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 0, { column: 16, row: 0 }),
    "column 16",
  );
  assertRefuses(
    block,
    () => setPlusMapGroupTile(block, 0, 0, { column: 0, row: 16 }),
    "row 16",
  );

  // The column bit that lives up at 0x80 is written where the reader looks.
  setPlusMapGroupTile(block, 0, 9, { column: 8, row: 15 });
  const word = decodePlusGroupWord(u16le(block, mg + 9 * 2));
  assertEquals([word.column, word.row, word.page], [8, 15, 0]);
});

Deno.test("an appear byte whose class nibble is not 8-D is refused", () => {
  // decodePlusAppearByte returns {unknown: true} for nibbles 1-7, E and F
  // (plus.js:537). That is the format's own don't-touch signal, and the
  // setter is where it becomes a refusal rather than a shrug.
  const { block } = buildPlusBlock();
  const ap = plusStageOffset(0) + STAGE_APPEAR;
  for (const byte of [0x10, 0x70, 0xe0, 0xf0]) {
    assertRefuses(
      block,
      () => setPlusAppearByte(block, 0, 3, 0, byte),
      `byte 0x${byte.toString(16)}`,
    );
  }
  assertRefuses(
    block,
    () => setPlusAppearByte(block, 0, 256, 0, 0x83),
    "record 256",
  );
  assertRefuses(
    block,
    () => setPlusAppearByte(block, 0, 0, 14, 0x83),
    "column 14",
  );
  assertRefuses(
    block,
    () => setPlusAppearByte(block, 0, 0, 0, 0x100),
    "byte 0x100",
  );

  for (
    const [column, byte] of [[0, 0x83], [1, 0xd0], [2, 0x00], [
      3,
      PLUS_APPEAR_END_MARK,
    ]]
  ) {
    const write = setPlusAppearByte(block, 0, 3, column, byte);
    assertEquals(block[ap + 3 * 14 + column], byte);
    assertEquals(write.offset, ap + 3 * 14 + column);
    assertEquals(write.groups, [6]);
  }

  // The canonical-byte builder, and the reason it is NOT the inverse of the
  // decoder: classes B and C mask to 3 and 2 bits (plus.js:109-110), so 0xB8
  // decodes to definition 48 and rebuilds as 0xB0 — the spare bits are gone.
  assertEquals(plusAppearByte("16x16", 3), 0x83);
  assertEquals(plusAppearByte("32x16", 19), 0x93);
  assertEquals(plusAppearByte("32x32", 49), 0xb1);
  assertEquals(plusAppearByte("64x64", 58), 0xc2);
  assertEquals(decodePlusAppearByte(0xb8).definition, 48);
  assertEquals(plusAppearByte("32x32", 48), 0xb0);
  assertThrows(() => plusAppearByte("16x16", 16), Error);
  assertThrows(() => plusAppearByte("32x32", 56), Error);
  assertThrows(() => plusAppearByte("8x8", 0), Error);

  // The row table: 1024 entries into 256 records, so no value is out of range.
  const rows = plusStageOffset(0) + STAGE_APPEAR_ROWS;
  const row = setPlusAppearRow(block, 0, 1023, 255);
  assertEquals(block[rows + 1023], 255);
  assertEquals(row.offset, rows + 1023);
  assert(row.warnings.length > 0, "the 0xFF-or-0x00 open item should warn");
  assertRefuses(block, () => setPlusAppearRow(block, 0, 1024, 0), "row 1024");
  assertRefuses(block, () => setPlusAppearRow(block, 0, 0, 256), "record 256");
});

Deno.test("a scroll block above 31 is refused, and an existing one above 31 only warns", () => {
  // The ceiling is geometric — 128 map rows / 4 rows per block
  // (FORMAT-PSX.md:507-509,
  // "SCROLL, APPEAR, ENEMY DATA, SPRITE LAYOUT, GROUPS") — not a traced
  // mask, so the setter refuses a new value above it but does not refuse a
  // file that already holds one. The consequence of exceeding it is traced:
  // the five stage maps are contiguous in RAM (0x80145C88 + s*0x900,
  // plus.js:163), so 32..159 reads another stage's scenery. It is a read,
  // so the failure is silent garbage.
  const { block } = buildPlusBlock();
  const sc = plusStageOffset(1) + STAGE_SCROLL;
  assertRefuses(
    block,
    () => setPlusScrollBlock(block, 1, 0, 32),
    "mapBlock 32",
  );
  assertRefuses(block, () => setPlusScrollBlock(block, 1, 256, 0), "step 256");
  assertRefuses(block, () => setPlusScrollBlock(block, 1, -1, 0), "step -1");

  const plain = setPlusScrollBlock(block, 1, 0, 31);
  assertEquals(block[sc], 31);
  assertEquals(plain.warnings, []);
  assertEquals(plain.groups, [7]);

  block[sc + 40] = 96;
  const warned = setPlusScrollBlock(block, 1, 40, 5);
  assertEquals(block[sc + 40], 5);
  assert(
    warned.warnings.some((w) => w.includes("96")),
    `an out-of-range existing byte should be named: ${
      JSON.stringify(warned.warnings)
    }`,
  );
});

Deno.test("a stage count of 6 is refused, although the fixture suite allows one", () => {
  // The save carries five stage blocks and the arithmetic is exact. Every
  // per-stage consumer in the PROGRAM is six wide (PLUS_BGM_SLOTS lists stage
  // 0-5 and boss 0-5, plus.js:132-136), and psx-fixtures.test.js:256-259
  // asserts stageCount <= 6 — so a UI built from either would offer six. Slot
  // 5 exists in RAM and the file never fills it: a 6-stage save plays zeros
  // after a cold boot and the previously loaded game after a warm one, and it
  // passes every checksum and every parser check.
  assertEquals(PLUS_STAGES, 5);
  assertEquals(
    PLUS_STAGES_OFFSET + PLUS_STAGES * PLUS_STAGE_SIZE,
    PLUS_GLOBAL_OFFSET,
  );
  const { block } = buildPlusBlock();
  assertRefuses(block, () => setPlusStageCount(block, 6), "count 6");
  assertRefuses(block, () => setPlusStageCount(block, 0), "count 0");

  const write = setPlusStageCount(block, 3);
  assertEquals(write.offset, STAGE_COUNT);
  assertEquals(block[STAGE_COUNT], 2);
  assertEquals(decodePlusGlobals(block).stageCount, 3);
  assertEquals(write.groups, [0x0b]);
  assertEquals(write.checksumBlind, false);
  assertEquals(plusChecksums(block).bad, [0x0b]);

  // Its two neighbours take the INDEX, never the decoded value: plus.js:592
  // masks the bonus with &7 and plus.js:594 does Math.min(v, 5), so neither
  // decoded field has an inverse.
  assertRefuses(block, () => setPlusScoreBonus(block, 8), "bonus index 8");
  assertRefuses(block, () => setPlusChargeTime(block, 6), "charge time 6");
  setPlusChargeTime(block, 5);
  assertEquals(block[CHARGE_TIME], 5);
  assertEquals(decodePlusGlobals(block).chargeFrames, 40);
});

Deno.test("item slot 0 refuses a non-weapon effect, because its id seeds the starting weapon", () => {
  // FORMAT-PSX.md:545, "GLOBAL, SOUND, HIGH SCORE, SETTINGS", and
  // plus.js:590: startingWeapon = slot 0's effect - 1, so effects 7-11
  // would index 6-10 against six weapons and whether the game clamps that
  // is untraced. And enableByte is preserve-by-default because
  // decodePlusGlobals collapses the high byte to a boolean (plus.js:582):
  // writing back from a decoded object would destroy whatever was there.
  const { block } = buildPlusBlock();
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 0, { effect: 7 }),
    "slot 0 bomb",
  );
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 0, { effect: 11 }),
    "slot 0 option",
  );
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 0, { effect: 0 }),
    "slot 0 nothing",
  );
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 1, { effect: 12 }),
    "effect 12",
  );
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 7, { effect: 1 }),
    "slot 7",
  );
  assertRefuses(
    block,
    () => setPlusItemSlot(block, 1, { effect: 1, enableByte: 256 }),
    "enable byte 256",
  );

  block[ITEM_TABLE + 2 * 2 + 1] = 0x42;
  const kept = setPlusItemSlot(block, 1, { effect: 8 });
  assertEquals(u16le(block, ITEM_TABLE + 2 * 2), 0x4208);
  assertEquals(kept.offset, ITEM_TABLE + 2 * 2);
  assertEquals(kept.length, 2);
  const given = setPlusItemSlot(block, 1, { effect: 8, enableByte: 1 });
  assertEquals(u16le(block, ITEM_TABLE + 2 * 2), 0x0108);
  assertEquals(given.changed, true);

  const weapon = setPlusItemSlot(block, 0, { effect: 6 });
  assertEquals(weapon.groups, [0x0b]);
  assertEquals(decodePlusGlobals(block).startingWeapon, 5);
  assertEquals(decodePlusGlobals(block).items[1].name, "score");
});

Deno.test("a BGM song above 50 is refused, and slots 5 and 11 warn", () => {
  // FORMAT-PSX.md:548-550, "GLOBAL, SOUND, HIGH SCORE, SETTINGS", and
  // psx-fixtures.test.js:267-269. Slots 5 and 11 address stage 5 and boss
  // 5, which the save has no block for; songs 16..31 name a bank the file
  // does not carry. Neither is a refusal, because a save may already hold
  // them.
  const { block } = buildPlusBlock();
  assertRefuses(block, () => setPlusBgmSlot(block, 0, 51), "song 51");
  assertRefuses(block, () => setPlusBgmSlot(block, 16, 0), "slot 16");
  assertRefuses(
    block,
    () => setPlusBgmSlot(block, "nowhere", 0),
    "unknown slot name",
  );

  const plain = setPlusBgmSlot(block, 0, 3);
  assertEquals(block[BGM_ASSIGNMENT], 3);
  assertEquals(plain.offset, BGM_ASSIGNMENT);
  assertEquals(plain.groups, [0x0b]);
  assertEquals(plain.warnings, []);
  for (const slot of [5, 11]) {
    const write = setPlusBgmSlot(block, slot, 3);
    assert(
      write.warnings.length > 0,
      `slot ${slot} has no stage block and should warn`,
    );
  }
  const unbanked = setPlusBgmSlot(block, 1, 20);
  assert(
    unbanked.warnings.length > 0,
    "songs 16..31 are not carried in the file",
  );

  const named = setPlusBgmSlot(block, "title", 7);
  assertEquals(named.offset, BGM_ASSIGNMENT + 12);
  assertEquals(block[BGM_ASSIGNMENT + 12], 7);
  assertEquals(decodePlusGlobals(block).bgm[12], { slot: "title", song: 7 });
});

Deno.test("a key config whose paired actions share a mask is refused", () => {
  // psx-fixtures.test.js:270-273 asserts masks[0] !== masks[1] and
  // masks[2] !== masks[3] across all 67 saves, as a rule the menu enforces.
  // Taking all four at once IS the enforcement: a per-key setter would have
  // to read the other key of the pair and could still leave a transient
  // violation between two calls. The constraint is WITHIN pairs only — the
  // factory value 02 01 08 02 has masks[1] === masks[3].
  const { block } = buildPlusBlock();
  assertRefuses(
    block,
    () => setPlusKeyConfig(block, [0x02, 0x02, 0x08, 0x04]),
    "pair 0 shared",
  );
  assertRefuses(
    block,
    () => setPlusKeyConfig(block, [0x02, 0x01, 0x08, 0x08]),
    "pair 1 shared",
  );
  assertRefuses(
    block,
    () => setPlusKeyConfig(block, [0x02, 0x01, 0x08]),
    "three masks",
  );
  assertRefuses(
    block,
    () => setPlusKeyConfig(block, [0x02, 0x01, 0x08, 256]),
    "mask 256",
  );

  const write = setPlusKeyConfig(block, [0x02, 0x01, 0x08, 0x02]);
  assertEquals(Array.from(block.subarray(0x1dfd4, 0x1dfd8)), [
    0x02,
    0x01,
    0x08,
    0x02,
  ]);
  assertEquals(write.offset, 0x1dfd4);
  assertEquals(write.length, 4);
  assertEquals(write.groups, [0x12]);
  // Byte 0x1DFD4 is checksum-blind on its own, but 0x1DFD5..7 are not, so the
  // write as a whole is not blind.
  assertEquals(write.checksumBlind, false);
  assertEquals(plusChecksums(block).bad, [0x12]);
  assertEquals(decodePlusSettings(block).keys[0].buttons, ["cross"]);
});

Deno.test("MY SHIP GROUP words 61-63 are refused, because the runtime overwrites them", () => {
  // FORMAT-PSX.md:536, "GLOBAL, SOUND, HIGH SCORE, SETTINGS": the runtime
  // forces those three words to 0x3FC..0x3FE. An edit there persists in the
  // file, moves a checksum, and does nothing — the tool would be lying to
  // its user.
  const { block } = buildPlusBlock();
  assertEquals([61, 62, 63].map((i) => SHIP_GROUP + i * 2), [
    0x1b000,
    0x1b002,
    0x1b004,
  ]);
  for (const i of [61, 62, 63]) {
    assertRefuses(
      block,
      () => setPlusGroupFlip(block, "ship", i, { hflip: true }),
      `flip ship ${i}`,
    );
    assertRefuses(
      block,
      () => swapPlusGroupWords(block, "ship", i, 0),
      `swap ship ${i},0`,
    );
    assertRefuses(
      block,
      () => swapPlusGroupWords(block, "ship", 0, i),
      `swap ship 0,${i}`,
    );
  }
  assertRefuses(
    block,
    () => setPlusGroupFlip(block, "title", 32, { hflip: true }),
    "title word 32",
  );
  assertRefuses(
    block,
    () => setPlusGroupFlip(block, "ending", 12, { hflip: true }),
    "ending word 12",
  );
  assertRefuses(
    block,
    () => setPlusGroupFlip(block, "ship", 77, { hflip: true }),
    "ship word 77",
  );
  assertRefuses(
    block,
    () => setPlusGroupFlip(block, "boss", 0, { hflip: true }),
    "no such table",
  );

  // Permute, do not synthesize: a flip touches only 0x4000/0x8000 and a swap
  // exchanges two words already in the save. There is no index setter at all,
  // because what 14-bit space these indices address is stated nowhere.
  writeU16(block, SHIP_GROUP, 0x1234);
  writeU16(block, SHIP_GROUP + 2, 0x0abc);
  const flipped = setPlusGroupFlip(block, "ship", 0, {
    hflip: true,
    vflip: false,
  });
  assertEquals(u16le(block, SHIP_GROUP), 0x5234);
  assertEquals(flipped.groups, [0x0b]);
  const swapped = swapPlusGroupWords(block, "ship", 0, 1);
  assertEquals([u16le(block, SHIP_GROUP), u16le(block, SHIP_GROUP + 2)], [
    0x0abc,
    0x5234,
  ]);
  assertEquals(swapped.length, 4);

  // An OMITTED hflip or vflip preserves that bit — the other half of
  // "permute, do not synthesize", and the half nothing above can see: the
  // 0x1234 seed carries neither flip bit, so preserving it and clearing it
  // write the same word, and the one call in this file that omits a flag
  // (the ENDING one below) asserts only that it warns. A reviewer rewrote
  // the hflip branch to CLEAR the bit when the flag is absent and all 31
  // tests stayed green; the same rewrite of the vflip branch did too. 0xC123
  // carries both bits, which is what makes the difference visible.
  writeU16(block, SHIP_GROUP, 0xc123);
  assertEquals(setPlusGroupFlip(block, "ship", 0, {}).changed, false);
  assertEquals(u16le(block, SHIP_GROUP), 0xc123);
  // Each flag owns its own bit and leaves the other one alone, so the two
  // branches are pinned apart rather than together.
  assertEquals(
    setPlusGroupFlip(block, "ship", 0, { hflip: false }).changed,
    true,
  );
  assertEquals(u16le(block, SHIP_GROUP), 0x8123);
  assertEquals(
    setPlusGroupFlip(block, "ship", 0, { vflip: false }).changed,
    true,
  );
  assertEquals(u16le(block, SHIP_GROUP), 0x0123);
  // And the 14-bit index half never moved, through all four calls.
  assertEquals(u16le(block, SHIP_GROUP) & 0x3fff, 0x0123);

  const ending = setPlusGroupFlip(block, "ending", 0, { vflip: true });
  assert(
    ending.warnings.length > 0,
    "an ending edit is invisible until the game is cleared",
  );
});

Deno.test("a high-score name must be eight bytes, not a string", () => {
  // plus.js:631 decodes the name with latin1(), a raw byte -> charCode
  // pass-through (memcard.js:49-53). It is not Shift-JIS, and the Dezaemon+
  // font is untraced, so a string parameter would invite typing text the
  // game's font maps to garbage. Table B (0x1DF30) only:
  // FORMAT-PSX.md:579-582, "GLOBAL, SOUND, HIGH SCORE, SETTINGS", says only
  // B is swapped in and out as games load, and there is no { table }
  // option, because an option would turn that rule into a comment.
  const { block } = buildPlusBlock();
  setPlusStageCount(block, 5);
  const b = PLUS_HISCORE_OFFSET + PLUS_HISCORE_TABLE_BYTES;
  assertEquals(b, 0x1df30);
  const name = Uint8Array.from([
    0x41,
    0x42,
    0x43,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
  ]);
  assertRefuses(
    block,
    () => setPlusHiScore(block, 1, { score: 1, stage: 0, name: "ABCDEFGH" }),
    "string name",
  );
  assertRefuses(
    block,
    () => setPlusHiScore(block, 1, { score: 1, stage: 0, name: [0x41, 0x42] }),
    "two bytes",
  );
  assertRefuses(
    block,
    () => setPlusHiScore(block, 0, { score: 1, stage: 0, name }),
    "rank 0",
  );
  assertRefuses(
    block,
    () => setPlusHiScore(block, 11, { score: 1, stage: 0, name }),
    "rank 11",
  );
  assertRefuses(
    block,
    () => setPlusHiScore(block, 1, { score: 0x100000000, stage: 0, name }),
    "score overflow",
  );
  assertRefuses(
    block,
    () => setPlusHiScore(block, 1, { score: 1, stage: 6, name }),
    "stage above the count",
  );

  // The three always-zero bytes (FORMAT-PSX.md:578,
  // "GLOBAL, SOUND, HIGH SCORE, SETTINGS") are forced, not preserved.
  block[b + 5] = 0xff;
  block[b + 6] = 0xff;
  block[b + 7] = 0xff;
  const write = setPlusHiScore(block, 1, { score: 123456, stage: 5, name });
  assertEquals(write.offset, b);
  assertEquals(write.length, 16);
  assertEquals(write.groups, [0x11]);
  assertEquals(Array.from(block.subarray(b + 5, b + 8)), [0, 0, 0]);
  const scores = decodePlusHiScores(block, { stageCount: 5 });
  assertEquals(scores[10].table, 1);
  assertEquals(scores[10].score, 123456);
  assertEquals(scores[10].name, "ABC.....");
  assertEquals(scores[10].allClear, true);
  // Table A is untouched, and reachable only by writing the block directly.
  assertEquals(scores[0].score, 1000);
  assertEquals(plusChecksums(block).bad, [0x0b, 0x11]);
});

Deno.test("a preserved stage byte is written back unvalidated, because lowering the stage count must not lock the ladder", () => {
  // setPlusHiScore rewrites the whole 16-byte entry, so a caller who only
  // wants to correct a score must still lay a stage byte and a name down.
  // Range-checking a byte that is ALREADY in the file buys nothing and costs
  // the edit: measured through the CLI, `--set hiscore.1=5000:4` on a
  // five-stage save, then `--set stage-count=1`, then `--set hiscore.1=6000`
  // was refused with "stage is 4; the range is 0..1" — a range over a value
  // nobody typed. Omitted therefore means preserve, unvalidated, the rule
  // setPlusItemSlot's enableByte and setPlusMapGroupTile's page already follow.
  // A SUPPLIED stage is still checked: that is the case just above, and the
  // "stage above the count" refusal there passes stage 6 explicitly.
  const { block } = buildPlusBlock();
  const b = PLUS_HISCORE_OFFSET + PLUS_HISCORE_TABLE_BYTES;
  const name = Uint8Array.from([
    0x41,
    0x42,
    0x43,
    0x44,
    0x45,
    0x46,
    0x47,
    0x48,
  ]);
  setPlusStageCount(block, 5);
  setPlusHiScore(block, 1, { score: 5000, stage: 4, name });
  assertEquals(block[b + 4], 4);
  setPlusStageCount(block, 1);
  assertEquals(decodePlusGlobals(block).stageCount, 1);

  // Score only: it writes, the stage byte 4 survives a save that now plays one
  // stage, and the name survives with it.
  const write = setPlusHiScore(block, 1, { score: 6000 });
  assertEquals(write.changed, true);
  assertEquals(write.offset, b);
  assertEquals(write.length, 16);
  assertEquals(block[b + 4], 4);
  assertEquals(Array.from(block.subarray(b + 8, b + 16)), Array.from(name));
  assertEquals(
    decodePlusHiScores(block, { stageCount: 1 })[10].score,
    6000,
  );
  // null reads the same as omitted — the CLI spreads the key away entirely,
  // but a JS caller writing `{ score, stage: parts[1] ?? null }` must not get
  // a different answer.
  assertEquals(
    setPlusHiScore(block, 1, { score: 6000, stage: null, name: null }).changed,
    false,
  );
  assertEquals(block[b + 4], 4);
  // And an explicit stage is still refused against the lowered count, so this
  // preserves rather than disables the check.
  assertRefuses(
    block,
    () => setPlusHiScore(block, 1, { score: 6000, stage: 4, name }),
    "explicit stage above the lowered count",
  );
});

Deno.test("a palette row above 23 is refused, and rows 22-23 write with a warning", () => {
  // plusPaletteRow() (plus.js:342-361) never returns 22 or 23, so nothing
  // traced draws with them; rows 5, 11 and 17 are the sixth stage's map,
  // enemy and boss rows, and the save has no sixth stage block. All five warn
  // and none refuse, because a save may already use them.
  const { block } = buildPlusBlock();
  assertEquals(plusColorWord({ r: 31, g: 0, b: 0 }), 0x001f);
  assertEquals(plusColorWord({ r: 0, g: 31, b: 0 }), 0x03e0);
  assertEquals(plusColorWord({ r: 0, g: 0, b: 31 }), 0x7c00);
  assertEquals(plusColorWord({ stp: true }), 0x8000);
  assertEquals(plusColorWord({ r: 1, g: 2, b: 3 }), 1 | (2 << 5) | (3 << 10));
  assertThrows(() => plusColorWord({ r: 32 }), Error);
  assertThrows(() => plusColorWord({ g: -1 }), Error);

  assertRefuses(
    block,
    () => setPlusPaletteColor(block, 24, 0, 0x1234),
    "row 24",
  );
  assertRefuses(
    block,
    () => setPlusPaletteColor(block, -1, 0, 0x1234),
    "row -1",
  );
  assertRefuses(
    block,
    () => setPlusPaletteColor(block, 0, 16, 0x1234),
    "index 16",
  );
  assertRefuses(
    block,
    () => setPlusPaletteColor(block, 0, 0, 0x10000),
    "word 0x10000",
  );

  const plain = setPlusPaletteColor(
    block,
    3,
    5,
    plusColorWord({ r: 31, stp: true }),
  );
  assertEquals(plain.offset, PLUS_PALETTE_OFFSET + 3 * 32 + 5 * 2);
  assertEquals(plain.groups, [0x05]);
  assertEquals(plain.warnings, []);
  const color = decodePlusPalettes(block)[3].colors[5];
  assertEquals(color.raw, 0x801f);
  assertEquals(color.stp, true);
  for (const row of [5, 11, 17, 22, 23]) {
    const write = setPlusPaletteColor(block, row, 1, 0x1234);
    assert(
      write.warnings.length > 0,
      `palette row ${row} has no named consumer and should warn`,
    );
  }

  assertRefuses(
    block,
    () => setPlusPaletteRow(block, 0, filled(15, 0)),
    "fifteen words",
  );
  assertRefuses(
    block,
    () => setPlusPaletteRow(block, 0, filled(17, 0)),
    "seventeen words",
  );
  const whole = setPlusPaletteRow(block, 0, filled(16, 0x7fff));
  assertEquals(whole.offset, PLUS_PALETTE_OFFSET);
  assertEquals(whole.length, 32);
  assertEquals(whole.groups, [0x05]);
});

Deno.test("a pixel writes the nibble decodePlusGraphics reads back, and one outside the bank is refused", () => {
  // Low nibble = left pixel (plus.js:369-370), 128-byte pitch. The five spots
  // are the measured ones: both halves of byte 0, the far end of a row, the
  // last row of the second texture page, and an odd x deep in page 1.
  const { block } = buildPlusBlock();
  const spots = [[0, 0], [1, 0], [255, 17], [254, 511], [3, 300]];
  spots.forEach(([x, y], k) => {
    const write = setPlusPixel(block, x, y, (k * 3 + 1) & 0x0f);
    assertEquals(
      write.offset,
      PLUS_GRAPHICS_OFFSET + y * 128 + (x >> 1),
      `${x},${y} offset`,
    );
    assertEquals(write.length, 1);
  });
  const pixels = decodePlusGraphics(block).indexed;
  spots.forEach(([x, y], k) => {
    assertEquals(pixels[y * 256 + x], (k * 3 + 1) & 0x0f, `${x},${y} readback`);
  });

  assertRefuses(block, () => setPlusPixel(block, 256, 0, 1), "x 256");
  assertRefuses(block, () => setPlusPixel(block, 0, 512, 1), "y 512");
  assertRefuses(block, () => setPlusPixel(block, -1, 0, 1), "x -1");
  assertRefuses(block, () => setPlusPixel(block, 0, 0, 16), "index 16");
  assertRefuses(
    block,
    () =>
      setPlusPixels(block, {
        x: 250,
        y: 0,
        width: 10,
        height: 1,
        indices: filled(10, 1),
      }),
    "rectangle off the right edge",
  );
  assertRefuses(
    block,
    () =>
      setPlusPixels(block, {
        x: 0,
        y: 508,
        width: 2,
        height: 8,
        indices: filled(16, 1),
      }),
    "rectangle off the bottom",
  );
  assertRefuses(
    block,
    () =>
      setPlusPixels(block, {
        x: 0,
        y: 0,
        width: 4,
        height: 2,
        indices: filled(7, 1),
      }),
    "seven indices for eight pixels",
  );

  // Repaint-in-place is safe but blind: SPRITE LAYOUT is undecoded
  // (FORMAT-PSX.md:720-721, "Unresolved"), so the editor cannot name the
  // sprite it just repainted — and there is no function anywhere that MOVES
  // art.
  const repaint = setPlusPixels(block, {
    x: 0,
    y: 0,
    width: 4,
    height: 2,
    indices: filled(8, 2),
  });
  assert(
    repaint.warnings.length > 0,
    "a graphics write should say the sprite cannot be named",
  );
  assertEquals(typeof plusEdit.movePlusPixels, "undefined");
  assertEquals(typeof plusEdit.setPlusSpriteLayout, "undefined");
});

Deno.test("a song copy needs a whole 0x2E0 slot", () => {
  // 0xB80 / 0x2E0 = 4, so every song lies wholly inside one checksum entry:
  // songs 0-3 are group 0x0C, 4-7 0x0D, and so on. The container is exact
  // but the interior is open (FORMAT-PSX.md:744-745, "Unresolved"), so
  // whole-slot copy is the only granularity there is — there is no
  // setPlusSongByte.
  const { block } = buildPlusBlock();
  assertRefuses(
    block,
    () => copyPlusSong(block, 0, new Uint8Array(PLUS_SONG_SIZE - 1)),
    "short source",
  );
  assertRefuses(
    block,
    () => copyPlusSong(block, 0, new Uint8Array(PLUS_SONG_SIZE + 1)),
    "long source",
  );
  assertRefuses(block, () => copyPlusSong(block, 16, 0), "slot 16");
  assertRefuses(block, () => copyPlusSong(block, 0, 16), "source slot 16");
  assertEquals(typeof plusEdit.setPlusSongByte, "undefined");

  const source = new Uint8Array(PLUS_SONG_SIZE).fill(0xab);
  const placed = copyPlusSong(block, 2, source);
  assertEquals(placed.offset, PLUS_SOUND_OFFSET + 2 * PLUS_SONG_SIZE);
  assertEquals(placed.length, PLUS_SONG_SIZE);
  assertEquals(placed.groups, [0x0c]);
  assert(
    placed.warnings.length > 0,
    "a copied song is only assumed self-contained",
  );

  const copied = copyPlusSong(block, 5, 2);
  assertEquals(copied.groups, [0x0d]);
  assertEquals(
    block.subarray(
      PLUS_SOUND_OFFSET + 5 * PLUS_SONG_SIZE,
      PLUS_SOUND_OFFSET + 6 * PLUS_SONG_SIZE,
    ),
    source,
  );
  assertEquals(plusChecksums(block).bad, [0x0c, 0x0d]);
  assertEquals(sealPlusChecksums(block).groups, [0x0c, 0x0d]);
});

Deno.test("TITLE TYPE writes two bits and leaves bits 6-7 as it found them", () => {
  // Six 2-bit selectors, three per byte (FORMAT-PSX.md:533,
  // "GLOBAL, SOUND, HIGH SCORE, SETTINGS"), so bits 6-7 of each byte are
  // unread. A whole-byte setter would clear them; a 2-bit read-modify-write
  // preserves them by construction. Value 3 is undefined.
  const { block } = buildPlusBlock();
  block[TITLE_TYPE] = 0xff;
  block[TITLE_TYPE + 1] = 0xff;
  assertEquals(setPlusTitleType(block, 0, 1).offset, TITLE_TYPE);
  assertEquals(block[TITLE_TYPE], 0xfd);
  setPlusTitleType(block, 1, 2);
  assertEquals(block[TITLE_TYPE], 0xf9);
  setPlusTitleType(block, 2, 0);
  assertEquals(block[TITLE_TYPE], 0xc9);
  const second = setPlusTitleType(block, 3, 1);
  assertEquals(second.offset, TITLE_TYPE + 1);
  assertEquals(block[TITLE_TYPE + 1], 0xfd);
  assertEquals(
    block[TITLE_TYPE] & 0xc0,
    0xc0,
    "bits 6-7 of byte 0 were not preserved",
  );

  assertRefuses(block, () => setPlusTitleType(block, 0, 3), "value 3");
  assertRefuses(block, () => setPlusTitleType(block, 6, 0), "index 6");
  assertRefuses(block, () => setPlusTitleType(block, -1, 0), "index -1");
});

Deno.test("MY SHIP ODR can only set bits", () => {
  // MY SHIP ODR is OR'd over the program's default sheet
  // (FORMAT-PSX.md:537, "GLOBAL, SOUND, HIGH SCORE, SETTINGS"), so writing
  // a 0 where the default holds a 1 is a no-op. A clear function would let
  // a user untick something, save, reload, see it unticked in the editor
  // and still see it in the game. The ABSENCE of the function is the
  // enforcement — do not add one.
  assertEquals(typeof plusEdit.clearPlusShipOdrBit, "undefined");
  assertEquals(typeof plusEdit.setPlusShipOdr, "undefined");

  const { block } = buildPlusBlock();
  block[SHIP_ODR + 3] = 0b0000_0001;
  const write = setPlusShipOdrBit(block, 3, 2);
  assertEquals(block[SHIP_ODR + 3], 0b0000_0101);
  assertEquals(write.offset, SHIP_ODR + 3);
  assertEquals(write.length, 1);
  assertEquals(write.groups, [0x0b]);
  // Setting a bit that is already set changes nothing, and says so.
  assertEquals(setPlusShipOdrBit(block, 3, 0).changed, false);
  assertRefuses(block, () => setPlusShipOdrBit(block, 77, 0), "index 77");
  assertRefuses(block, () => setPlusShipOdrBit(block, 0, 8), "bit 8");
});

Deno.test("each settings setter refuses a value outside its named range", () => {
  // setPlusMenuBgm takes an explicit constant for "off" rather than null,
  // because decodePlusSettings returns null for any byte >= 4 (plus.js:659)
  // and so has no inverse. Font bank (0x1DFD1) has no setter at all: no range
  // is stated anywhere, and a setter with no range is a setter with no rule.
  const { block } = buildPlusBlock();
  assertEquals(PLUS_MENU_BGM_OFF, 4);
  assertEquals(typeof plusEdit.setPlusFontBank, "undefined");
  assertRefuses(block, () => setPlusCursorSpeed(block, 3), "cursor speed 3");
  assertRefuses(block, () => setPlusCursorSpeed(block, -1), "cursor speed -1");
  assertRefuses(block, () => setPlusMenuBgm(block, 5), "menu bgm 5");

  setPlusMenuBgm(block, 2);
  assertEquals(block[0x1dfd2], 2);
  assertEquals(decodePlusSettings(block).menuBgm, 2);
  const off = setPlusMenuBgm(block, PLUS_MENU_BGM_OFF);
  assertEquals(block[0x1dfd2], 4);
  assertEquals(decodePlusSettings(block).menuBgm, null);
  assertEquals(off.checksumBlind, true);

  // setPlusStereo writes the canonical 1 or 0 while the reader only tests
  // !== 0 (plus.js:660), so the record's `before` is the only place a
  // non-canonical original byte survives.
  block[0x1dfd3] = 0x7f;
  const write = setPlusStereo(block, false);
  assertEquals(block[0x1dfd3], 0);
  assertEquals(write.before, [0x7f]);
  assertEquals(write.after, [0]);
});

Deno.test("a card edited through placePlusSave reparses to the edited block, and every directory frame still checksums", () => {
  // The only derived bytes at card level are the XOR checksums on the 16
  // directory frames (memcard.js:71), and a frame covers only its own 128
  // directory bytes — there is no checksum over data blocks anywhere in the
  // format. The length cannot change either, so frame 0's u32 size at +4 and
  // the chain link at +8 both stay correct.
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  const edited = Uint8Array.from(block);
  setPlusStageCount(edited, 3);
  edited[0x1041] ^= 0xff;
  sealPlusChecksums(edited);

  const placement = placePlusSave(card, edited);
  assertEquals(placement.filename, filename);
  assertEquals(placement.blocks, Array.from({ length: 15 }, (_, i) => i + 1));
  assertEquals(placement.bytes, 15 * BLOCK_SIZE);
  assertEquals(placement.framesOk, true);

  const parsed = parseMemoryCard(card);
  assertEquals(parsed.files.length, 1);
  assertEquals(parsed.files[0].data, edited);
  assertEquals(parsed.files[0].complete, true);
  assertEquals(parsed.files[0].size, PLUS_BLOCK_SIZE);
  assertEquals(parsed.frames.every((f) => f.checksumOk), true);
  assertEquals(parsed.headerChecksumOk, true);
  assertEquals(parsed.magicOk, true);
  assertEquals(plusChecksums(parsed.files[0].data).ok, true);
  // Measured: five bytes for a two-byte edit, not six. The stage count
  // dirtied group 0x0B and its word at 0x1DFEE moved in its LOW byte only —
  // "N + 2" is the ceiling a seal owes per dirtied group, not a promise that
  // both halves of every word move, which is why PlusSeal.bytes counts
  // 2 * words.length and the byte-exact number lives here.
  assertEquals(diffOffsets(block, edited), [
    0x1041,
    STAGE_COUNT,
    0x1dfda,
    0x1dfdb,
    0x1dfee,
  ]);
});

Deno.test("mutating the save locateSaves hands back leaves a card untouched", () => {
  // The trap placePlusSave exists for. parseMemoryCard allocates a fresh
  // buffer and copies the chained blocks into it (memcard.js:161-163), then
  // hands out a subarray of THAT (:172), so for a "card" and a ".gme" the
  // bytes locateSaves returns are a copy. Only .mcs (:209), .psv (:218) and
  // bare (:222) alias the caller. A card is the common case, not a guarantee
  // about any given fixture: psx-fixtures.test.js:73 pins container === "card"
  // only inside the Kids! loop it opens at :70, and the Dezaemon+ loops
  // (:229, :252, :283) go through parsePsxSav, which peels .gme/.mcs/.psv
  // without ever asserting what it peeled.
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  const located = locateSaves(card);
  assertEquals(located.container, "card");
  assert(
    located.saves[0].data.buffer !== card.buffer,
    "the card's save aliases the card image",
  );

  const before = card[BLOCK_SIZE + 0x1041];
  located.saves[0].data[0x1041] ^= 0xff;
  assertEquals(
    card[BLOCK_SIZE + 0x1041],
    before,
    "poking the copy edited the card",
  );
  assert(
    located.saves[0].data[0x1041] !== before,
    "the copy itself did not change",
  );
  assertEquals(parseMemoryCard(card).files[0].data[0x1041], before);

  // The containers that DO alias, for contrast: a bare block is the block.
  assertEquals(locateSaves(block).container, "bare");
  assert(locateSaves(block).saves[0].data.buffer === block.buffer);
});

Deno.test("a chain that is not contiguous still writes back in order", () => {
  // chainFrom (memcard.js:133-146) follows the links, and the links are not
  // required to be contiguous or ascending — psx-memcard.test.js:57-63 builds
  // a card whose chain is [1, 15] on purpose. So placePlusSave must index by
  // CHAIN POSITION and never by 1 + k: here the save's second 0x2000 belongs
  // in block 15, and block 2 holds the third.
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  relink(card, 0, STATUS.FIRST, 14); // block 1 -> block 15
  relink(card, 14, STATUS.MIDDLE, 1); // block 15 -> block 2
  relink(card, 13, STATUS.LAST, NO_NEXT); // block 14 ends the chain
  const chain = [1, 15, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  assertEquals(parseMemoryCard(card).files[0].blocks, chain);
  assertEquals(parseMemoryCard(card).files[0].complete, true);

  const edited = Uint8Array.from(block);
  edited[BLOCK_SIZE + 0x10] = 0x5a;
  edited[2 * BLOCK_SIZE + 0x10] = 0xa5;
  sealPlusChecksums(edited);
  const placement = placePlusSave(card, edited);
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
  assertEquals(card[15 * BLOCK_SIZE + 0x10], 0x5a);
  assertEquals(card[2 * BLOCK_SIZE + 0x10], 0xa5);
  assertEquals(parseMemoryCard(card).files[0].data, edited);
});

Deno.test("placePlusSave refuses a .psv, because its signature cannot be regenerated", () => {
  // A PS3 .psv carries a cryptographic signature over the save in its
  // 0x84-byte header, keyed to the console. Nothing in src/psx/ reads, checks
  // or can regenerate it — locateSaves slices at PSV_HEADER_SIZE and reads
  // the filename at 0x64 (memcard.js:214-219), and that is all. An edited
  // .psv would be a file this package reads back happily and a real PS3
  // rejects, which is the worst failure mode a surgical tool has. Refusal,
  // not a warning, and --force does not override it.
  const { block, filename } = buildPlusBlock();
  const psv = new Uint8Array(PSV_HEADER_SIZE + PLUS_BLOCK_SIZE);
  psv.set([0x00, 0x56, 0x53, 0x50], 0);
  psv.set(new TextEncoder().encode(filename), 0x64);
  psv.set(block, PSV_HEADER_SIZE);
  assertEquals(locateSaves(psv).container, "psv");
  const before = Uint8Array.from(psv);
  assertThrows(() => placePlusSave(psv, block), Error, "signature");
  assertEquals(diffOffsets(before, psv), []);
});

Deno.test("placePlusSave names a card it cannot place into, and waives the SC frame for a Select 100 block", () => {
  // The 106 Select 100 blocks have the "SC" frame stripped
  // (FORMAT-PSX.md:698-699, "Select 100"), so isPlusBlock rejects every one
  // of them although they are valid Dezaemon+ content. requirePlus is the
  // waiver; the structural gate never is.
  const { block, filename } = buildPlusBlock();
  const card = buildCard(block, filename);
  assertThrows(
    () => placePlusSave(new Uint8Array(CARD_SIZE - 1), block),
    Error,
  );
  assertThrows(
    () => placePlusSave(card, block, { filename: "BISLPS-00000NONE" }),
    Error,
  );
  assertThrows(
    () => placePlusSave(card, new Uint8Array(PLUS_BLOCK_SIZE - 1)),
    Error,
  );

  const stripped = Uint8Array.from(block);
  stripped[0] = 0;
  stripped[1] = 0;
  sealPlusChecksums(stripped);
  assertThrows(() => placePlusSave(card, stripped), Error);
  const placement = placePlusSave(card, stripped, { requirePlus: false });
  assertEquals(placement.framesOk, true);
  assertEquals(parseMemoryCard(card).files[0].data, stripped);
});

Deno.test("placePlusSave refuses a chain it cannot fill, and reports a directory frame that was already broken", () => {
  // Three paths the placement cases above cannot reach, because buildCard
  // always hands back a healthy fifteen-block card. Coverage says so outright:
  // with the suite green, both refusal bodies in placePlusSave take 0 hits
  // while the conditions above them are evaluated 8 times, and all three
  // existing framesOk assertions are `true` on intact cards, so a constant
  // `framesOk: true` passes them.
  const { block, filename } = buildPlusBlock();
  const edited = Uint8Array.from(block);
  edited[0x1041] ^= 0xff;
  sealPlusChecksums(edited);

  // 1. A chain fifteen blocks long that no frame ever flags last. `complete`
  // is three conditions ANDed (memcard.js:170) and this trips only the third,
  // so blocks.length * 0x2000 is still exactly PLUS_BLOCK_SIZE and the
  // block-count guard cannot catch it — the `!file.complete` refusal is the
  // only thing between a damaged card and 122,880 bytes scattered over it.
  const unclosed = buildCard(block, filename);
  relink(unclosed, 14, STATUS.MIDDLE, NO_NEXT);
  const damaged = parseMemoryCard(unclosed);
  assertEquals(damaged.files[0].blocks.length, 15);
  assertEquals(damaged.files[0].complete, false);
  assertEquals(damaged.frames.every((f) => f.checksumOk), true);
  const beforeUnclosed = Uint8Array.from(unclosed);
  assertThrows(
    () => placePlusSave(unclosed, edited),
    Error,
    "incomplete block chain",
  );
  assertEquals(diffOffsets(beforeUnclosed, unclosed), []);

  // 2. A chain that IS complete and still too short. The two guards are
  // ordered, not parallel: fourteen blocks under a frame 0 that still
  // declares 122880 bytes is caught by the one above, so the declared size
  // has to shrink with the chain to reach this one at all.
  //
  // What it holds back, measured with it removed: PLUS_CHECKSUM_OFFSET is
  // 0x1DFD8, which lives in the FIFTEENTH block — precisely the block a short
  // chain drops. The edit at 0x1041 lands in block 1 while its checksum word
  // falls off the end, so the save on the card reads stored against computed
  // for group 1 and the game rejects it — and framesOk still comes back true,
  // because the directory was never touched. A save the game will not load,
  // reported as a clean write.
  const short = buildCard(block, filename);
  relink(short, 13, STATUS.LAST, NO_NEXT);
  relink(short, 14, STATUS.FREE, NO_NEXT);
  relink(short, 0, STATUS.FIRST, 1, 14 * BLOCK_SIZE);
  assertEquals(parseMemoryCard(short).files[0].complete, true);
  assertEquals(parseMemoryCard(short).files[0].blocks.length, 14);
  const beforeShort = Uint8Array.from(short);
  assertThrows(
    () => placePlusSave(short, edited),
    Error,
    "a Dezaemon+ save needs 15",
  );
  assertEquals(diffOffsets(beforeShort, short), []);

  // 3. framesOk reports the card as it ARRIVED, and is not a constant.
  // placePlusSave writes data blocks only, so a frame that was already broken
  // stays broken, and "A DIRECTORY FRAME NO LONGER CHECKSUMS" in the CLI is
  // the only notice the user gets. Bend frame 5's XOR byte and nothing else:
  // status, size and links are untouched, so the placement itself succeeds.
  const bent = buildCard(block, filename);
  bent[DIRECTORY_OFFSET + 5 * FRAME_SIZE + FRAME_SIZE - 1] ^= 0xff;
  assertEquals(parseMemoryCard(bent).frames[5].checksumOk, false);
  assertEquals(parseMemoryCard(bent).files[0].complete, true);
  const placement = placePlusSave(bent, edited);
  assertEquals(placement.framesOk, false);
  assertEquals(placement.blocks.length, 15);
  assertEquals(parseMemoryCard(bent).files[0].data, edited);
});

// The community collection in the repo-root dev-fixtures/ is gitignored; this
// suite is skipped without it. The walker is psx-fixtures.test.js:35-58's,
// including the `._` AppleDouble filter — those sidecars end in .sav and hold
// no save.
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

const PLUS = savesUnder("Dezaemon+");

Deno.test({
  name: "every community Dezaemon+ save reseals to itself, byte for byte",
  ignore: PLUS.length === 0,
  fn() {
    // The strongest test in the file, and the only one that can settle two
    // open items: whether computed[0x13] === stored[0x13] on real saves —
    // FORMAT-PSX.md:435-436, "Checksums", grades the twentieth word "**open**:
    // nothing in the suite ever compares it", and this is the suite — and
    // whether any save carries a stage count of 6.
    //
    // The block is taken through parseMemoryCard + blockBytes rather than
    // locateSaves, which assumes every fixture is a RAW card. Nothing pins
    // that: psx-fixtures.test.js:73's container === "card" is inside the
    // Kids! loop at :70, and the Dezaemon+ loops (:229, :252, :283) go
    // through parsePsxSav, which peels .gme/.mcs/.psv silently. A wrapped
    // fixture saved under a .sav name therefore turns this red on the
    // `no BISLPS-00335DEZA` assert below rather than sealing — a loud
    // failure, not a wrong result, but the reason is the container and not
    // the save.
    let settledTwentieth = 0;
    let sixStages = 0;
    for (const url of PLUS) {
      const label = fromFileUrl(url);
      const card = Deno.readFileSync(url);
      const parsed = parseMemoryCard(card);
      const file = parsed.files.find((f) => f.filename === PLUS_PRODUCT);
      assert(file, `${label}: no ${PLUS_PRODUCT}`);
      assertEquals(file.complete, true, label);
      const block = new Uint8Array(PLUS_BLOCK_SIZE);
      file.blocks.forEach((b, k) =>
        block.set(blockBytes(card, b), k * BLOCK_SIZE)
      );
      const before = Uint8Array.from(block);
      const seal = sealPlusChecksums(block);
      assertEquals(
        diffOffsets(before, block),
        [],
        `${label}: a seal changed a real save`,
      );
      assertEquals(seal.words, [], label);
      assertEquals(seal.ok, true, label);
      const cs = plusChecksums(block);
      if (cs.computed[PLUS_UNSEALED_GROUP] === cs.stored[PLUS_UNSEALED_GROUP]) {
        settledTwentieth++;
      }
      if (decodePlusGlobals(block).stageCount === 6) sixStages++;
    }
    // Reported, not asserted: both are open items, and the corpus is the only
    // thing that can close them. A non-zero count for either means the spec's
    // reasoning needs reopening, not that this test is wrong.
    console.log(
      `  ${PLUS.length} Dezaemon+ saves: group 0x13 settles on ${settledTwentieth}, stage count 6 on ${sixStages}`,
    );
  },
});
