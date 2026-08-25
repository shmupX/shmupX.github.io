// Golden tests for the Dezaemon 2 payload section table (FORMAT.md "Payload").
// Passing 16/16 section checksums is the end-to-end proof that block-accurate
// payload reassembly is byte-exact for both reference saves.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import {
  isGameSave,
  parseSectionTable,
  TABLE_SIZE,
  validateSectionTable,
} from "../src/payload-table.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const payloadOf = (name) => {
  const [save] = bup.parse(deinterleave(loadFixture(name)));
  assert(isGameSave(save), `${name} should contain a game save`);
  return save.payload.buffer;
};

const GOLDEN = {
  "ramsie.sav": {
    checksumTotal: 0x121ac7c,
    tableAddr: 0x2c8a84,
    endAddr: 0x2f18db,
    sections: [
      { size: 21065, checksum: 0x21d447 },
      { size: 25320, checksum: 0x2bea96 },
      { size: 26710, checksum: 0x2bd4bb },
      { size: 21853, checksum: 0x255c0b },
      { size: 447, checksum: 0xb4b6 },
      { size: 56643, checksum: 0x67a29a },
      { size: 14676, checksum: 0x193422 },
      { size: 689, checksum: 0x13167 },
    ],
  },
  "mucha-kucha.sav": {
    checksumTotal: 0x108e8be,
    tableAddr: 0x2c8a84,
    endAddr: 0x2ee423,
    sections: [
      { size: 19310, checksum: 0x1f51c5 },
      { size: 24188, checksum: 0x25b3d5 },
      { size: 17909, checksum: 0x1e91d9 },
      { size: 21877, checksum: 0x24a43c },
      { size: 448, checksum: 0xb585 },
      { size: 53492, checksum: 0x634cf6 },
      { size: 15977, checksum: 0x1b73af },
      { size: 706, checksum: 0x136e5 },
    ],
  },
};

for (const [fixture, golden] of Object.entries(GOLDEN)) {
  Deno.test({
    name:
      `section table of ${fixture} parses and validates (checksums prove reassembly)`,
    ignore: !hasFixtures(fixture),
    fn() {
      const payload = payloadOf(fixture);
      const table = parseSectionTable(payload); // validates by default
      assertStrictEquals(table.checksumTotal, golden.checksumTotal);
      assertStrictEquals(table.tableAddr, golden.tableAddr);
      assertStrictEquals(table.endAddr, golden.endAddr);
      assertEquals(
        table.sections.map((s) => ({ size: s.size, checksum: s.checksum })),
        golden.sections,
      );
      // Sections consume the payload exactly.
      const total = table.sections.reduce((a, s) => a + s.size, TABLE_SIZE);
      assertStrictEquals(total, payload.length);
    },
  });
}

Deno.test({
  name: "validation catches a corrupted payload byte",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const payload = payloadOf("ramsie.sav").slice(); // copy before mutating
    const table = parseSectionTable(payload, { validate: false });
    payload[table.sections[5].offset] ^= 0xff; // flip a byte inside sec5
    assertThrows(
      () => validateSectionTable(payload, table),
      Error,
      "section 5 checksum mismatch",
    );
  },
});

Deno.test("section table rejects a too-small payload", () => {
  assertThrows(() => parseSectionTable(new Uint8Array(16)), Error, "too small");
});
