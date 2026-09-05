// The image writer is read back through the same parser every real cart
// goes through, and its block arithmetic is pinned to the Ramsie dump.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { deinterleave, detect } from "../src/bup-deinterleave.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave, parseSectionTable } from "../src/payload-table.js";
import { decompress, SECTION_SIZES } from "../src/decompress.js";
import { decodeSave } from "../src/decode/index.js";
import {
  buildBupImage,
  buildGameSave,
  buildPayload,
  BUP_LANGUAGE,
  bupDateFromDate,
  CART_PARTITION_SIZE,
  dataBlocksFor,
  encodeComment,
  formatPartition,
  gameSaveFilename,
  interleave,
  INTERNAL_PARTITION_SIZE,
  MISTER_SAV_SIZE,
} from "../src/bup-write.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

function fakeSections() {
  return SECTION_SIZES.map((size, i) => {
    const s = new Uint8Array(size);
    for (let k = 0; k < size; k += 97) s[k] = (i + 1) * 3 + (k & 0x3f);
    return s;
  });
}

Deno.test("buildPayload writes a table parseSectionTable validates, sections chained", () => {
  const sections = fakeSections();
  const payload = buildPayload(sections);
  const table = parseSectionTable(payload);
  assertStrictEquals(table.tableAddr, 0x002c8a84);
  assertStrictEquals(table.sections[0].addr, 0x002c8a84 + 0x6c);
  for (const [i, s] of table.sections.entries()) {
    assertEquals(
      decompress(payload.subarray(s.offset, s.offset + s.size)),
      sections[i],
      `sec${i}`,
    );
  }
  assertStrictEquals(
    table.endAddr,
    table.sections[7].addr + table.sections[7].size,
  );
});

Deno.test("buildPayload refuses the wrong number or size of sections", () => {
  assertThrows(
    () => buildPayload(fakeSections().slice(0, 7)),
    Error,
    "exactly 8",
  );
  const bad = fakeSections();
  bad[4] = new Uint8Array(500);
  assertThrows(() => buildPayload(bad), Error, "sec4 is 500");
});

Deno.test("directory field encoders", () => {
  assertStrictEquals(gameSaveFilename(1), "DEZA2____01");
  assertStrictEquals(gameSaveFilename(5), "DEZA2____05");
  assertThrows(() => gameSaveFilename(6), Error, "5 game slots");
  assertEquals([...encodeComment("MuchaKucha")], [
    ...new TextEncoder().encode("MuchaKucha"),
  ]);
  assertEquals([...encodeComment("ab")].slice(0, 3), [0x61, 0x62, 0]);
  assertStrictEquals(encodeComment("a very long comment").length, 10);
  // non-ASCII becomes an underscore rather than a stray byte
  assertEquals([...encodeComment("デザ")].slice(0, 3), [0x5f, 0x5f, 0]);
  assertStrictEquals(bupDateFromDate(new Date(Date.UTC(1980, 0, 1))), 0);
  // Ramsie's header date, 2007-12-25 00:00 UTC, is 14,716,800 minutes on
  assertStrictEquals(
    bupDateFromDate(new Date(Date.UTC(2007, 11, 25))),
    14716800,
  );
});

Deno.test("dataBlocksFor reproduces Ramsie's chain: 331 blocks, payload at +0x6BE", () => {
  assertStrictEquals(dataBlocksFor(167511, 512), 331);
  assertStrictEquals(dataBlocksFor(154015, 512), 304); // Mucha Kucha
  assertStrictEquals(dataBlocksFor(17, 64), 0); // DEZA2___SYS fits its header block
  assertStrictEquals(dataBlocksFor(478, 512), 1); // one byte too many for the header alone...
  assertStrictEquals(dataBlocksFor(476, 512), 0); // 476 + 2-byte terminator = the 478 bytes of room
});

Deno.test("formatPartition fills block 0 with the magic and nothing else", () => {
  const part = formatPartition(CART_PARTITION_SIZE, 512);
  assertStrictEquals(part.length, CART_PARTITION_SIZE);
  const magic = new TextDecoder().decode(part.subarray(0, 16));
  assertStrictEquals(magic, "BackUpRam Format");
  assertStrictEquals(
    new TextDecoder().decode(part.subarray(496, 512)),
    "BackUpRam Format",
  );
  assert(part.subarray(512, 4096).every((b) => b === 0));
  assertEquals(bup.detectPartitions(part), [{
    base: 0,
    size: CART_PARTITION_SIZE,
    blockSize: 512,
  }]);
});

Deno.test("interleave is the inverse of deinterleave", () => {
  const logical = new Uint8Array(300);
  for (let i = 0; i < logical.length; i++) logical[i] = (i * 13) & 0xff;
  const wide = interleave(logical);
  assertStrictEquals(wide.length, 600);
  assert(detect(wide));
  assertEquals(deinterleave(wide), logical);
});

Deno.test("a MiSTer-layout image parses back to its saves, byte for byte", async () => {
  const payload = new Uint8Array(167511);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 7 + (i >> 9)) & 0xff;
  }
  const date = bupDateFromDate(new Date(Date.UTC(2026, 8, 5, 12, 0)));
  const { image, logical, entries } = buildBupImage([
    {
      filename: "DEZA2____01",
      comment: "DEZA2 SGM",
      language: BUP_LANGUAGE.japanese,
      date,
      payload,
    },
  ]);
  assertStrictEquals(image.length, MISTER_SAV_SIZE);
  assertStrictEquals(image.length, 1114112);
  for (let i = 0; i < image.length; i += 2) {
    if (image[i] !== 0xff) throw new Error(`even byte ${i} is ${image[i]}`);
  }
  assertEquals(entries, [{
    filename: "DEZA2____01",
    header: 2,
    blocks: Array.from({ length: 331 }, (_, k) => 3 + k),
    next: 334,
  }]);

  const norm = await normalize(image);
  assertStrictEquals(norm.kind, "interleaved");
  assertEquals(norm.data, logical);
  assertEquals(bup.detectPartitions(norm.data), [
    { base: 0, size: INTERNAL_PARTITION_SIZE, blockSize: 64 },
    {
      base: INTERNAL_PARTITION_SIZE,
      size: CART_PARTITION_SIZE,
      blockSize: 512,
    },
  ]);
  const saves = bup.parse(norm.data);
  assertStrictEquals(saves.length, 1);
  const s = saves[0];
  assertStrictEquals(s.filename, "DEZA2____01");
  assertStrictEquals(s.comment, "DEZA2 SGM");
  assertStrictEquals(s.language, 0);
  assertStrictEquals(s.date, date);
  assertStrictEquals(s.datasize, payload.length);
  // header block 2 of the cart partition, payload where Ramsie's is
  assertStrictEquals(s.offset, INTERNAL_PARTITION_SIZE + 2 * 512);
  assertStrictEquals(s.payload.start, 0x86be);
  assertStrictEquals(s.payloadError, null);
  assertEquals(s.payload.buffer, payload);
});

Deno.test("several saves chain contiguously and each reads back", async () => {
  const a = new Uint8Array(5000).fill(1);
  const b = new Uint8Array(70000).fill(2);
  const { image } = buildBupImage([
    { filename: "DEZA2____01", comment: "one", payload: a },
    { filename: "DEZA2____02", comment: "two", payload: b },
  ], { layout: "cart" });
  assertStrictEquals(image.length, CART_PARTITION_SIZE);
  const saves = bup.parse((await normalize(image)).data);
  assertEquals(saves.map((s) => s.filename), ["DEZA2____01", "DEZA2____02"]);
  assertEquals(saves[0].payload.buffer, a);
  assertEquals(saves[1].payload.buffer, b);
  // the second save's header is the block after the first's chain
  assertStrictEquals(
    saves[1].offset,
    (2 + 1 + dataBlocksFor(a.length, 512)) * 512,
  );
});

Deno.test("a save that does not fit its partition is refused", () => {
  const huge = new Uint8Array(600000);
  assertThrows(
    () =>
      buildBupImage(
        [{ filename: "DEZA2____01", comment: "x", payload: huge }],
        { layout: "cart" },
      ),
    Error,
    "blocks",
  );
  assertThrows(
    () =>
      buildBupImage([{
        filename: "bad name!",
        comment: "x",
        payload: new Uint8Array(10),
      }]),
    Error,
    "filename",
  );
});

Deno.test("buildGameSave: eight raw sections in, a DEZA2____NN cart out", async () => {
  const sections = fakeSections();
  const { sav, payload, filename, entry } = buildGameSave(sections, {
    slot: 3,
    comment: "shmupX",
  });
  assertStrictEquals(filename, "DEZA2____03");
  assertStrictEquals(entry.header, 2);
  assertStrictEquals(sav.length, MISTER_SAV_SIZE);
  const [save] = bup.parse((await normalize(sav)).data).filter(isGameSave);
  assertEquals(save.payload.buffer, payload);
  const decoded = decodeSave(save.payload.buffer);
  assert(decoded.sections.every((s) => s.sizeMatchesKnown));
  for (const [i, s] of decoded.sections.entries()) {
    assertEquals(s.decompressed, sections[i], `sec${i}`);
  }
});

Deno.test({
  name: "ramsie.sav rebuilt from its own sections decodes identically",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const [orig] = bup.parse(deinterleave(loadFixture("ramsie.sav"))).filter(
      isGameSave,
    );
    const before = decodeSave(orig.payload.buffer);
    const raws = before.sections.map((s) => s.decompressed);
    const { sav } = buildGameSave(raws, {
      comment: orig.comment,
      language: orig.language,
      date: orig.date,
    });
    const [again] = bup.parse((await normalize(sav)).data).filter(isGameSave);
    assertStrictEquals(again.comment, orig.comment);
    assertStrictEquals(again.date, orig.date);
    const after = decodeSave(again.payload.buffer);
    for (let i = 0; i < 8; i++) {
      assertEquals(
        after.sections[i].decompressed,
        before.sections[i].decompressed,
        `sec${i}`,
      );
    }
    assertStrictEquals(after.enemies.length, before.enemies.length);
    assertStrictEquals(after.sprites.length, before.sprites.length);
    assertStrictEquals(after.stageCount, before.stageCount);
  },
});
