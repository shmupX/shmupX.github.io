// CHECK SUM: the transcribed descriptor table reproduces every word of both
// known dumps, and sealing an edited image makes it verify again.

import { assert, assertEquals } from "@std/assert";
import {
  sealSfcChecksums,
  SFC_CHECKSUM_DESCRIPTORS,
  sfcChecksumWord,
  verifySfcChecksums,
} from "../src/sfc/checksum.js";
import { REGION } from "../src/sfc/regions.js";
import { readChecksumBlocks } from "../src/sfc/sram.js";
import {
  hasDevFixtures,
  hasFixtures,
  loadDevFixture,
  loadFixture,
} from "./_fixtures.js";

const SAMPLE = "dezaemon-sfc-sample.sav";
const ALDI =
  "SNES Dezaemon - Kaite Tsukutte Asoberu/ALDI Adventure (2026-08-22).srm";

Deno.test("seventeen descriptors: sixteen in the block, the copy's at 0x7E78, every segment inside the image and even", () => {
  assertEquals(SFC_CHECKSUM_DESCRIPTORS.length, 17);
  for (let i = 0; i < 16; i++) {
    assertEquals(SFC_CHECKSUM_DESCRIPTORS[i].at, i * 2);
  }
  assertEquals(
    SFC_CHECKSUM_DESCRIPTORS[16].at,
    REGION.checksumCopy.offset + 0x1e,
  );
  for (const d of SFC_CHECKSUM_DESCRIPTORS) {
    for (const s of d.segments) {
      assert(
        s.offset >= 0 && s.offset + s.length <= 0x20000,
        `${d.name}: 0x${s.offset.toString(16)}`,
      );
      assertEquals(s.length % 2, 0, `${d.name}: an odd segment`);
    }
  }
  // Nothing but word 15, the two RESERVED ranges and CHECK STRINGS is left uncovered.
  const covered = new Uint8Array(0x20000);
  for (let i = 0; i < 16; i++) {
    for (const s of SFC_CHECKSUM_DESCRIPTORS[i].segments) {
      covered.fill(1, s.offset, s.offset + s.length);
    }
  }
  const uncovered = [];
  for (let i = 0; i < covered.length; i++) if (!covered[i]) uncovered.push(i);
  const expected = [];
  for (let i = 0x1e; i < 0x20; i++) expected.push(i);
  for (let i = REGION.reserved0.offset; i < REGION.reserved0.end; i++) {
    expected.push(i);
  }
  for (let i = REGION.checksumCopy.offset; i < REGION.checksumCopy.end; i++) {
    expected.push(i);
  }
  for (let i = REGION.reserved1.offset; i < REGION.reserved1.end; i++) {
    expected.push(i);
  }
  for (let i = REGION.checkString.offset; i < REGION.checkString.end; i++) {
    expected.push(i);
  }
  assertEquals(uncovered, expected);
});

Deno.test("a word is the one's complement of a carry-free word sum", () => {
  const bytes = new Uint8Array(8);
  bytes.set([0xff, 0xff, 0x02, 0x00, 0x34, 0x12, 0x00, 0x80]);
  // 0xFFFF + 0x0002 = 0x0001 (carry dropped), + 0x1234 = 0x1235, + 0x8000 = 0x9235
  assertEquals(
    sfcChecksumWord(bytes, [{ offset: 0, length: 8 }]),
    0xffff - 0x9235,
  );
  assertEquals(
    sfcChecksumWord(bytes, [{ offset: 0, length: 2 }, {
      offset: 6,
      length: 2,
    }]),
    0xffff - 0x7fff,
  );
});

Deno.test("sealing a fresh image makes every word verify and the block total 0xFFFF", () => {
  const bytes = new Uint8Array(0x20000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 9)) & 0xff;
  assertEquals(verifySfcChecksums(bytes).ok, false);
  sealSfcChecksums(bytes);
  const v = verifySfcChecksums(bytes);
  assertEquals(
    v.ok,
    true,
    v.words.filter((w) => !w.ok).map((w) => w.name).join(", "),
  );
  const { words, equal } = readChecksumBlocks(bytes);
  assertEquals(equal, true);
  assertEquals(Array.from(words).reduce((a, b) => (a + b) & 0xffff, 0), 0xffff);
  // An edit anywhere covered breaks exactly the word that covers it; word 15
  // and the copy's word sum the STORED words, which an edit elsewhere leaves.
  bytes[REGION.sound.offset + 100] ^= 0x55;
  const after = verifySfcChecksums(bytes);
  assertEquals(after.words.filter((w) => !w.ok).map((w) => w.at), [0x1c]);
  assertEquals(after.blockOk, true);
  // Resealing repairs it, and an edited block word breaks the block's own.
  sealSfcChecksums(bytes);
  assertEquals(verifySfcChecksums(bytes).ok, true);
  bytes[4] ^= 1; // word 2, stage 1's
  assertEquals(
    verifySfcChecksums(bytes).words.filter((w) => !w.ok).map((w) => w.at),
    [0x04, 0x1e],
  );
});

Deno.test({
  name: "the factory sample's seventeen words are the table's",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const v = verifySfcChecksums(loadFixture(SAMPLE));
    assertEquals(
      v.words.filter((w) => !w.ok).map((w) =>
        `${w.name}: stored ${w.stored} computed ${w.computed}`
      ),
      [],
    );
    assertEquals(v.ok, true);
  },
});

Deno.test({
  name:
    "ALDI Adventure's seventeen words are the table's (a full graphics bank, every stage in use)",
  ignore: !hasDevFixtures(ALDI),
  fn() {
    const v = verifySfcChecksums(loadDevFixture(ALDI));
    assertEquals(
      v.words.filter((w) => !w.ok).map((w) =>
        `${w.name}: stored ${w.stored} computed ${w.computed}`
      ),
      [],
    );
  },
});
