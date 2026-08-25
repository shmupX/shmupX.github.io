import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { deinterleave, detect } from "../src/bup-deinterleave.js";
import { isGzip, normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const load = loadFixture;

Deno.test({
  name: "detects interleaved cartridge dump",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const raw = load("ramsie.sav");
    assertStrictEquals(detect(raw), true);
    assertStrictEquals(raw.length, 1114112);
    const data = deinterleave(raw);
    assertStrictEquals(data.length, 557056);
  },
});

Deno.test({
  name: "deinterleave is idempotent on already-logical data",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const data = deinterleave(load("ramsie.sav"));
    assertStrictEquals(detect(data), false);
    assertStrictEquals(deinterleave(data).length, data.length);
  },
});

Deno.test({
  name: "detects the two partitions of a hardware-style cart dump",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const data = deinterleave(load("ramsie.sav"));
    const parts = bup.detectPartitions(data);
    assertEquals(parts, [
      { base: 0x0, size: 0x8000, blockSize: 64 },
      { base: 0x8000, size: 0x80000, blockSize: 512 },
    ]);
  },
});

Deno.test({
  name: "parses Ramsie directory entry with block-accurate payload",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const [save] = bup.parse(deinterleave(load("ramsie.sav")));
    assertStrictEquals(save.offset, 0x8400);
    assertStrictEquals(save.filename, "DEZA2____01");
    assertStrictEquals(save.comment, "DEZA2 SGM");
    assertStrictEquals(save.language, 0);
    assertStrictEquals(save.datasize, 167511);
    assertStrictEquals(bup.bupDateToDate(save.date).getUTCFullYear(), 2007);
    // Block chain: 331 sequential blocks 3..333 in the 0x8000 partition.
    assertStrictEquals(save.partition.base, 0x8000);
    assertStrictEquals(save.partition.blockSize, 512);
    assertStrictEquals(save.blocks.length, 331);
    assertStrictEquals(save.blocks[0], 3);
    assertStrictEquals(save.blocks[save.blocks.length - 1], 333);
    assertStrictEquals(save.payloadError, null);
    assertStrictEquals(save.payload.start, 0x86be);
    assertStrictEquals(save.payload.buffer.length, 167511);
  },
});

Deno.test({
  name: "parses Mucha Kucha Fighter directory entry",
  ignore: !hasFixtures("mucha-kucha.sav"),
  fn() {
    const [save] = bup.parse(deinterleave(load("mucha-kucha.sav")));
    assertStrictEquals(save.filename, "DEZA2____01");
    assertStrictEquals(save.comment, "MuchaKucha");
    assertStrictEquals(save.language, 5);
    assertStrictEquals(save.datasize, 154015);
    assertStrictEquals(save.blocks.length, 304);
    assertStrictEquals(save.payload.start, 0x8688);
    assertStrictEquals(save.payload.buffer.length, 154015);
  },
});

Deno.test("rejects non-Saturn data", () => {
  assertThrows(
    () => bup.parse(new Uint8Array(1024)),
    Error,
    "BackUpRam Format",
  );
});

Deno.test({
  name: "normalize gunzips Mednafen .bcr cart saves",
  ignore: !hasFixtures("baseline-cart.bcr"),
  async fn() {
    const raw = load("baseline-cart.bcr");
    assertStrictEquals(isGzip(raw), true);
    const { kind, data } = await normalize(raw);
    assertStrictEquals(kind, "gzip");
    assertStrictEquals(data.length, 524288); // 4Mbit cart = 512KB raw
  },
});

Deno.test({
  name: "empty cart yields no save entries",
  ignore: !hasFixtures("baseline-cart.bcr"),
  async fn() {
    const { data } = await normalize(load("baseline-cart.bcr"));
    const saves = bup.parse(data);
    assertEquals(saves, []);
  },
});

Deno.test({
  name: "parses DEZA2___SYS system save in internal RAM dump",
  ignore: !hasFixtures("baseline-internal.bkr"),
  async fn() {
    const raw = load("baseline-internal.bkr");
    const { kind, data } = await normalize(raw);
    assertStrictEquals(kind, "raw");
    assertStrictEquals(data.length, 32768);
    const [save] = bup.parse(data);
    assertStrictEquals(save.offset, 0x80);
    assertStrictEquals(save.filename, "DEZA2___SYS");
    assertStrictEquals(save.datasize, 17);
    assertStrictEquals(save.blocks.length, 0); // small enough to fit inline
    assertStrictEquals(save.payload.buffer.length, 17);
  },
});

Deno.test({
  name: "decodes the Shift-JIS system-save comment when ICU allows",
  ignore: !hasFixtures("baseline-internal.bkr"),
  fn() {
    let sjis;
    try {
      sjis = new TextDecoder("shift-jis");
    } catch {
      return; // small-ICU build — decodeComment falls back to bytes
    }
    void sjis;
    const [save] = bup.parse(new Uint8Array(load("baseline-internal.bkr")));
    assertStrictEquals(save.comment, "ﾃﾞｻﾞ2_ｼｽﾃﾑ"); // half-width kana, "Deza2 System"
  },
});
