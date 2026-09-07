// Saves placed into an occupied partition read back through the same parser
// every real cart goes through, other saves stay byte-identical, and the
// interleaved output is the image yabause keeps as its .srm.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { deinterleave, detect } from "../src/bup-deinterleave.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave } from "../src/payload-table.js";
import { SECTION_SIZES } from "../src/decompress.js";
import {
  buildBupImage,
  buildGameSave,
  buildPayload,
  bupDateFromDate,
  CART_BLOCK_SIZE,
  CART_PARTITION_SIZE,
  dataBlocksFor,
  formatPartition,
  INTERNAL_BLOCK_SIZE,
  INTERNAL_PARTITION_SIZE,
  MISTER_SAV_SIZE,
} from "../src/bup-write.js";
import {
  gamePayloadFromSav,
  INTERNAL_RAM_PAYLOAD_CAPACITY,
  INTERNAL_SRM_SIZE,
  internalRamFromImage,
  MIN_GAME_PAYLOAD_BYTES,
  MISTER_LOGICAL_SIZE,
  PartitionFullError,
  payloadCapacity,
  placeSaveInPartition,
  stageSaveInInternalRam,
} from "../src/bup-place.js";

function payloadOf(size, seed = 1) {
  const p = new Uint8Array(size);
  for (let i = 0; i < size; i++) p[i] = (i * seed + (i >> 7)) & 0xff;
  return p;
}

// The 32 KB partition has 512 blocks; 0 and 1 are reserved.
const INTERNAL_BLOCKS = INTERNAL_PARTITION_SIZE / INTERNAL_BLOCK_SIZE;
const INTERNAL_FREE_BLOCKS = INTERNAL_BLOCKS - 2;
const INTERNAL_CAPACITY = payloadCapacity(
  INTERNAL_FREE_BLOCKS,
  INTERNAL_BLOCK_SIZE,
);

// A yabause .srm as FormatBackupRam() leaves it: the 32-byte interleaved
// header four times over (128 bytes), then 0xFF,0x00 pairs to the end.
function yabauseFormattedSrm() {
  const header = [];
  for (const ch of "BackUpRam Format") header.push(0xff, ch.charCodeAt(0));
  const srm = new Uint8Array(INTERNAL_SRM_SIZE);
  for (let copy = 0; copy < 4; copy++) srm.set(header, copy * 32);
  for (let i = 0x80; i < srm.length; i += 2) {
    srm[i] = 0xff;
    srm[i + 1] = 0x00;
  }
  return srm;
}

function assertInterleaved(bytes) {
  assertStrictEquals(bytes.length % 2, 0);
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] !== 0xff) throw new Error(`even byte ${i} is ${bytes[i]}`);
  }
  assert(detect(bytes));
}

Deno.test("payloadCapacity is the inverse of dataBlocksFor", () => {
  for (const blockSize of [INTERNAL_BLOCK_SIZE, CART_BLOCK_SIZE]) {
    for (const blocks of [1, 2, 3, 10, 331, INTERNAL_FREE_BLOCKS]) {
      const cap = payloadCapacity(blocks, blockSize);
      assertStrictEquals(
        1 + dataBlocksFor(cap, blockSize),
        blocks,
        `${blocks}x${blockSize} fits`,
      );
      assertStrictEquals(
        1 + dataBlocksFor(cap + 1, blockSize),
        blocks + 1,
        `${blocks}x${blockSize} + 1`,
      );
    }
  }
  // the whole internal memory carries a shade under 29 KB of payload
  assertStrictEquals(INTERNAL_CAPACITY, 29550);
});

Deno.test("stageSaveInInternalRam: an empty memory, round trip through parse()", async () => {
  const payload = payloadOf(10_000);
  const date = bupDateFromDate(new Date(Date.UTC(2026, 8, 7)));
  const staged = stageSaveInInternalRam(null, {
    payload,
    comment: "shmupX",
    date,
  });
  assertStrictEquals(staged.filename, "DEZA2____01");
  assertStrictEquals(staged.replaced, null);
  assertStrictEquals(staged.image.length, INTERNAL_PARTITION_SIZE);
  assertStrictEquals(staged.interleaved.length, INTERNAL_SRM_SIZE);
  assertStrictEquals(staged.entry.header, 2);
  assertEquals(
    staged.entry.blocks,
    Array.from(
      { length: dataBlocksFor(payload.length, INTERNAL_BLOCK_SIZE) },
      (_, k) => 3 + k,
    ),
  );

  const saves = bup.parse(staged.image);
  assertStrictEquals(saves.length, 1);
  assertStrictEquals(saves[0].filename, "DEZA2____01");
  assertStrictEquals(saves[0].comment, "shmupX");
  assertStrictEquals(saves[0].date, date);
  assertStrictEquals(saves[0].payloadError, null);
  assertEquals(saves[0].payload.buffer, payload);
  assertEquals(saves[0].partition, { base: 0, blockSize: INTERNAL_BLOCK_SIZE });

  // the interleaved twin is what yabause reads back as its .srm
  assertInterleaved(staged.interleaved);
  assertEquals(deinterleave(staged.interleaved), staged.image);
  const norm = await normalize(staged.interleaved);
  assertStrictEquals(norm.kind, "interleaved");
  assertEquals(bup.parse(norm.data)[0].payload.buffer, payload);
});

Deno.test("staging into a yabause-formatted .srm built by hand", () => {
  const srm = yabauseFormattedSrm();
  // FormatBackupRam's layout is interleave() of formatPartition()
  assertEquals(
    deinterleave(srm),
    formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE),
  );
  const payload = payloadOf(2_000, 5);
  const staged = stageSaveInInternalRam(srm, { payload, comment: "FOO" });
  // the input is never touched
  assertEquals(srm, yabauseFormattedSrm());
  assertStrictEquals(staged.filename, "DEZA2____01");
  const [save] = bup.parse(staged.image);
  assertStrictEquals(save.offset, 2 * INTERNAL_BLOCK_SIZE);
  assertEquals(save.payload.buffer, payload);
  // block 0 is still the magic, four copies
  assertEquals(staged.interleaved.subarray(0, 128), srm.subarray(0, 128));
  assertInterleaved(staged.interleaved);
});

Deno.test("re-staging into the previous output replaces the slot and keeps the rest", () => {
  const a = payloadOf(5_000, 3);
  const b = payloadOf(8_000, 7);
  const one = stageSaveInInternalRam(null, { payload: a, comment: "GAME A" });
  const two = stageSaveInInternalRam(one.interleaved, {
    payload: b,
    comment: "GAME B",
  });
  assertStrictEquals(two.filename, "DEZA2____02");
  assertStrictEquals(two.replaced, null);
  let saves = bup.parse(two.image);
  assertEquals(saves.map((s) => s.filename), ["DEZA2____01", "DEZA2____02"]);
  const bBefore = { offset: saves[1].offset, blocks: [...saves[1].blocks] };

  // same comment → same slot, replaced; bigger than the hole → lands after B
  const a2 = payloadOf(6_000, 11);
  const three = stageSaveInInternalRam(two.interleaved, {
    payload: a2,
    comment: "GAME A",
  });
  assertStrictEquals(three.filename, "DEZA2____01");
  assertStrictEquals(three.replaced, "DEZA2____01");
  saves = bup.parse(three.image);
  assertEquals(saves.map((s) => s.filename).sort(), [
    "DEZA2____01",
    "DEZA2____02",
  ]);
  const bAfter = saves.find((s) => s.filename === "DEZA2____02");
  assertStrictEquals(bAfter.offset, bBefore.offset);
  assertEquals(bAfter.blocks, bBefore.blocks);
  assertEquals(bAfter.payload.buffer, b);
  const aAfter = saves.find((s) => s.filename === "DEZA2____01");
  assertEquals(aAfter.payload.buffer, a2);
  assert(
    aAfter.offset > bAfter.offset + bBefore.blocks.length * INTERNAL_BLOCK_SIZE,
  );
  // the old A's blocks were zeroed, not merely orphaned
  assert(
    three.image.subarray(2 * INTERNAL_BLOCK_SIZE, bBefore.offset).every((x) =>
      x === 0
    ),
  );

  // a smaller replacement takes the first hole again: block 2
  const four = stageSaveInInternalRam(three.image, {
    payload: payloadOf(1_000),
    comment: "GAME A",
  });
  assertStrictEquals(four.replaced, "DEZA2____01");
  assertStrictEquals(four.entry.header, 2);
  assertEquals(
    bup.parse(four.image).find((s) => s.filename === "DEZA2____02").payload
      .buffer,
    b,
  );
});

Deno.test("slot selection: explicit slot, explicit filename, first free slot, all taken", () => {
  const p = payloadOf(300);
  const s4 = stageSaveInInternalRam(null, { payload: p, slot: 4 });
  assertStrictEquals(s4.filename, "DEZA2____04");
  const custom = stageSaveInInternalRam(s4.image, {
    payload: p,
    filename: "MYSAVE_01",
  });
  assertStrictEquals(custom.filename, "MYSAVE_01");
  assertEquals(bup.parse(custom.image).map((s) => s.filename), [
    "DEZA2____04",
    "MYSAVE_01",
  ]);
  // no comment match → first absent slot, skipping the taken one
  let img = custom.image;
  for (
    const want of ["DEZA2____01", "DEZA2____02", "DEZA2____03", "DEZA2____05"]
  ) {
    const r = stageSaveInInternalRam(img, {
      payload: p,
      comment: want.slice(-2),
    });
    assertStrictEquals(r.filename, want);
    img = r.image;
  }
  assertThrows(
    () => stageSaveInInternalRam(img, { payload: p, comment: "NEW" }),
    Error,
    "slots are in use",
  );
  // ...unless the comment matches one of them
  assertStrictEquals(
    stageSaveInInternalRam(img, { payload: p, comment: "03" }).filename,
    "DEZA2____03",
  );
  // explicit slot always works, replacing
  assertStrictEquals(
    stageSaveInInternalRam(img, { payload: p, slot: 5 }).replaced,
    "DEZA2____05",
  );
  assertThrows(
    () => stageSaveInInternalRam(null, { payload: p, slot: 6 }),
    Error,
    "5 game slots",
  );
});

Deno.test("PartitionFullError for a 40 KB payload, with the numbers a message needs", () => {
  const err = assertThrows(
    () =>
      stageSaveInInternalRam(null, {
        payload: payloadOf(40 * 1024),
        comment: "big",
      }),
    Error,
  );
  assertStrictEquals(err.name, "PartitionFullError");
  assert(err instanceof PartitionFullError);
  assertStrictEquals(err.payloadBytes, 40960);
  assertStrictEquals(err.capacityBytes, INTERNAL_PARTITION_SIZE);
  assertStrictEquals(err.freeBytes, INTERNAL_CAPACITY);
  assertStrictEquals(err.freeBlocks, INTERNAL_FREE_BLOCKS);
  assertStrictEquals(
    err.neededBlocks,
    1 + dataBlocksFor(40960, INTERNAL_BLOCK_SIZE),
  );
  assertStrictEquals(err.blockSize, INTERNAL_BLOCK_SIZE);
  assert(err.message.includes("40960-byte save"));
});

Deno.test("the internal memory's exact capacity: 29,550 bytes fit, one more does not", () => {
  const full = stageSaveInInternalRam(null, {
    payload: payloadOf(INTERNAL_CAPACITY, 9),
  });
  assertStrictEquals(full.entry.next, INTERNAL_BLOCKS);
  assertEquals(
    bup.parse(full.image)[0].payload.buffer,
    payloadOf(INTERNAL_CAPACITY, 9),
  );
  const err = assertThrows(() =>
    stageSaveInInternalRam(null, { payload: payloadOf(INTERNAL_CAPACITY + 1) })
  );
  assertStrictEquals(err.name, "PartitionFullError");
  // once something is in there, the free figure shrinks accordingly
  const some = stageSaveInInternalRam(null, { payload: payloadOf(10_000) });
  const err2 = assertThrows(() =>
    stageSaveInInternalRam(some.image, { payload: payloadOf(20_000), slot: 2 })
  );
  const usedBlocks = 1 + dataBlocksFor(10_000, INTERNAL_BLOCK_SIZE);
  assertStrictEquals(err2.freeBlocks, INTERNAL_FREE_BLOCKS - usedBlocks);
  assertStrictEquals(
    err2.freeBytes,
    payloadCapacity(INTERNAL_FREE_BLOCKS - usedBlocks, INTERNAL_BLOCK_SIZE),
  );
});

Deno.test("placeSaveInPartition on a cart: placing A then B equals buildBupImage([A, B])", async () => {
  const a = {
    filename: "DEZA2____01",
    comment: "one",
    date: 100,
    payload: payloadOf(5_000, 3),
  };
  const b = {
    filename: "DEZA2____02",
    comment: "two",
    date: 200,
    payload: payloadOf(70_000, 5),
  };
  const part = formatPartition(CART_PARTITION_SIZE, CART_BLOCK_SIZE);
  const pa = placeSaveInPartition(part, CART_BLOCK_SIZE, a);
  const pb = placeSaveInPartition(part, CART_BLOCK_SIZE, b);
  assertEquals(pa, {
    header: 2,
    blocks: Array.from({ length: dataBlocksFor(5_000, 512) }, (_, k) => 3 + k),
    next: pa.next,
    replaced: null,
  });
  assertStrictEquals(pb.header, pa.next);
  assertStrictEquals(pb.replaced, null);
  const built = buildBupImage([a, b], { layout: "cart" });
  assertEquals(part, built.image);
  const saves = bup.parse((await normalize(part)).data);
  assertEquals(saves.map((s) => s.filename), ["DEZA2____01", "DEZA2____02"]);
});

Deno.test("placeSaveInPartition: `replace` frees a differently named entry, a duplicate name never survives", () => {
  const part = formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
  placeSaveInPartition(part, INTERNAL_BLOCK_SIZE, {
    filename: "OLD_NAME",
    comment: "x",
    payload: payloadOf(3_000),
  });
  placeSaveInPartition(part, INTERNAL_BLOCK_SIZE, {
    filename: "KEEP_ME",
    comment: "k",
    payload: payloadOf(2_000, 2),
  });
  const r = placeSaveInPartition(
    part,
    INTERNAL_BLOCK_SIZE,
    { filename: "NEW_NAME", comment: "y", payload: payloadOf(1_000, 3) },
    { replace: "OLD_NAME" },
  );
  assertStrictEquals(r.replaced, "OLD_NAME");
  assertStrictEquals(r.header, 2); // the freed hole is the first long enough
  assertEquals(bup.parse(part).map((s) => s.filename), ["NEW_NAME", "KEEP_ME"]);
  assertEquals(bup.parse(part)[1].payload.buffer, payloadOf(2_000, 2));

  // writing KEEP_ME again erases the existing KEEP_ME even without `replace`
  const r2 = placeSaveInPartition(part, INTERNAL_BLOCK_SIZE, {
    filename: "KEEP_ME",
    comment: "k2",
    payload: payloadOf(500, 4),
  });
  assertStrictEquals(r2.replaced, "KEEP_ME");
  const names = bup.parse(part).map((s) => s.filename);
  assertEquals(names.filter((n) => n === "KEEP_ME").length, 1);
});

Deno.test("placeSaveInPartition refuses an unformatted buffer and a mismatched block size", () => {
  const save = {
    filename: "DEZA2____01",
    comment: "x",
    payload: payloadOf(10),
  };
  assertThrows(
    () =>
      placeSaveInPartition(
        new Uint8Array(INTERNAL_PARTITION_SIZE),
        INTERNAL_BLOCK_SIZE,
        save,
      ),
    Error,
    "not formatted",
  );
  assertThrows(
    () =>
      placeSaveInPartition(
        formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE),
        CART_BLOCK_SIZE,
        save,
      ),
    Error,
    "do not match",
  );
  assertThrows(
    () =>
      placeSaveInPartition(
        formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE),
        INTERNAL_BLOCK_SIZE,
        { filename: "x", payload: [1, 2] },
      ),
    Error,
    "Uint8Array",
  );
});

Deno.test("internalRamFromImage: every accepted layout yields the same fresh 32 KB partition", () => {
  const fresh = formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
  assertEquals(internalRamFromImage(null), fresh);
  assertEquals(internalRamFromImage(undefined), fresh);
  assertEquals(internalRamFromImage(yabauseFormattedSrm()), fresh);
  assertEquals(internalRamFromImage(fresh), fresh);
  assert(
    internalRamFromImage(fresh).buffer !== fresh.buffer,
    "a copy, never the caller's buffer",
  );
  // a MiSTer .sav and its logical pair: the leading internal mirror
  const { sav, logical } = buildGameSave(
    SECTION_SIZES.map((n) => new Uint8Array(n)),
  );
  assertStrictEquals(sav.length, MISTER_SAV_SIZE);
  assertStrictEquals(logical.length, MISTER_LOGICAL_SIZE);
  assertEquals(internalRamFromImage(sav), fresh);
  assertEquals(internalRamFromImage(logical), fresh);
  assertEquals(internalRamFromImage(sav.buffer), fresh); // an ArrayBuffer is fine too
  // a memory the console never formatted is formatted here
  assertEquals(
    internalRamFromImage(new Uint8Array(INTERNAL_PARTITION_SIZE)),
    fresh,
  );
  assertEquals(
    internalRamFromImage(new Uint8Array(INTERNAL_SRM_SIZE).fill(0xff)),
    fresh,
  );
  // but a formatted image with content survives
  const staged = stageSaveInInternalRam(null, { payload: payloadOf(100) });
  assertEquals(internalRamFromImage(staged.interleaved), staged.image);
  assertEquals(internalRamFromImage(staged.image), staged.image);
  // sizes that are not a Saturn memory
  assertThrows(
    () => internalRamFromImage(new Uint8Array(1000)),
    Error,
    "not a Saturn internal memory image",
  );
  assertThrows(
    () => internalRamFromImage(new Uint8Array(INTERNAL_SRM_SIZE).fill(0x41)),
    Error,
    "interleaved",
  );
  assertThrows(() => internalRamFromImage("nope"), Error, "bytes");
});

Deno.test("gamePayloadFromSav finds the DEZA2 game in a .sav, interleaved or logical", () => {
  const sections = SECTION_SIZES.map((n, i) => new Uint8Array(n).fill(i + 1));
  const { sav, logical, payload } = buildGameSave(sections, {
    slot: 2,
    comment: "MYGAME",
    language: 0,
    date: 1234,
  });
  for (const input of [sav, logical, sav.buffer]) {
    const got = gamePayloadFromSav(input);
    assertEquals(got.payload, payload);
    assertStrictEquals(got.entry.filename, "DEZA2____02");
    assertStrictEquals(got.entry.comment, "MYGAME");
    assertStrictEquals(got.entry.language, 0);
    assertStrictEquals(got.entry.date, 1234);
    assert(isGameSave(got.entry));
  }
  assertEquals(
    gamePayloadFromSav(sav, { filename: "DEZA2____02" }).payload,
    payload,
  );
  assertThrows(
    () => gamePayloadFromSav(sav, { filename: "DEZA2____01" }),
    Error,
    "no DEZA2____01",
  );
  // an image with only the settings record has no game to take
  const sysOnly = buildBupImage(
    [{ filename: "DEZA2___SYS", comment: "sys", payload: new Uint8Array(17) }],
    { layout: "internal" },
  ).image;
  assertThrows(() => gamePayloadFromSav(sysOnly), Error, "no DEZA2____NN");
  assertThrows(
    () => gamePayloadFromSav(new Uint8Array([0x1f, 0x8b, 8, 0])),
    Error,
    "gzip",
  );
});

Deno.test("no Dezaemon 2 game ever fits the internal memory: the LZSS floor is 3x its capacity", () => {
  // the analytic floor is exactly what the compressor makes of empty sections
  const emptiest = buildPayload(SECTION_SIZES.map((n) => new Uint8Array(n)));
  assertStrictEquals(MIN_GAME_PAYLOAD_BYTES, 90619);
  assertStrictEquals(emptiest.length, MIN_GAME_PAYLOAD_BYTES);
  assertStrictEquals(INTERNAL_RAM_PAYLOAD_CAPACITY, INTERNAL_CAPACITY);
  assert(MIN_GAME_PAYLOAD_BYTES > 3 * INTERNAL_RAM_PAYLOAD_CAPACITY);

  // so a real built game, taken from its .sav, is refused with the numbers
  const { sav } = buildGameSave(
    SECTION_SIZES.map((n, i) => new Uint8Array(n).fill((i * 37) & 0xff)),
    { comment: "shmupX" },
  );
  const { payload } = gamePayloadFromSav(sav);
  assert(payload.length >= MIN_GAME_PAYLOAD_BYTES);
  const err = assertThrows(() =>
    stageSaveInInternalRam(yabauseFormattedSrm(), {
      payload,
      comment: "shmupX",
    })
  );
  assertStrictEquals(err.name, "PartitionFullError");
  assertStrictEquals(err.payloadBytes, payload.length);
  assertStrictEquals(err.freeBytes, INTERNAL_RAM_PAYLOAD_CAPACITY);
  assertStrictEquals(err.capacityBytes, INTERNAL_PARTITION_SIZE);
});

Deno.test("the whole path: a game entry out of a .sav, staged into a used internal memory, read back", async () => {
  // A DEZA2____01 entry small enough to fit (buildBupImage does not inspect
  // payloads), in the MiSTer layout gamePayloadFromSav gets in practice.
  const payload = payloadOf(12_000, 13);
  const { image: sav } = buildBupImage([{
    filename: "DEZA2____01",
    comment: "shmupX",
    language: 0,
    date: 4321,
    payload,
  }]);
  assertStrictEquals(sav.length, MISTER_SAV_SIZE);
  const taken = gamePayloadFromSav(sav);
  assertEquals(taken.payload, payload);
  // a memory that already carries the game's own settings record
  const memory = stageSaveInInternalRam(yabauseFormattedSrm(), {
    payload: new Uint8Array(17).fill(0xaa),
    filename: "DEZA2___SYS",
    comment: "sys",
  });
  const staged = stageSaveInInternalRam(memory.interleaved, {
    payload: taken.payload,
    comment: taken.entry.comment,
    language: taken.entry.language,
    date: taken.entry.date,
  });
  assertStrictEquals(staged.filename, "DEZA2____01");
  assertStrictEquals(staged.replaced, null);
  const saves = bup.parse((await normalize(staged.interleaved)).data);
  assertEquals(saves.map((s) => s.filename), ["DEZA2___SYS", "DEZA2____01"]);
  assertEquals(saves[0].payload.buffer, new Uint8Array(17).fill(0xaa));
  const game = saves.find(isGameSave);
  assertEquals(game.payload.buffer, payload);
  assertStrictEquals(game.comment, "shmupX");
  assertStrictEquals(game.language, 0);
  assertStrictEquals(game.date, 4321);
});
