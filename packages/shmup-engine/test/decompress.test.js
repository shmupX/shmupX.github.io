// The decompression gate: every fixture section must decode to the exact
// known region size — the sizes being identical across two DIFFERENT games is
// the smoking-gun proof that the LZSS variant is correct.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave, parseSectionTable } from "../src/payload-table.js";
import { decompress, decompressCmp, SECTION_SIZES } from "../src/decompress.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

function sectionsOf(name) {
  const [save] = bup.parse(deinterleave(loadFixture(name))).filter(isGameSave);
  const table = parseSectionTable(save.payload.buffer);
  return table.sections.map((s) =>
    save.payload.buffer.subarray(s.offset, s.offset + s.size)
  );
}

for (const fixture of ["ramsie.sav", "mucha-kucha.sav"]) {
  Deno.test({
    name:
      `all 8 sections of ${fixture} decompress to the exact known region sizes`,
    ignore: !hasFixtures(fixture),
    fn() {
      const sections = sectionsOf(fixture);
      const sizes = sections.map((s) => decompress(s).length);
      assertEquals(sizes, SECTION_SIZES);
    },
  });
}

Deno.test({
  name: "sec4 (settings) decompresses near-identically across different games",
  ignore: !hasFixtures("ramsie.sav", "mucha-kucha.sav"),
  fn() {
    const a = decompress(sectionsOf("ramsie.sav")[4]);
    const b = decompress(sectionsOf("mucha-kucha.sav")[4]);
    assertStrictEquals(a.length, b.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assert(diff <= 16, `expected <=16 differing bytes, got ${diff}`);
  },
});

Deno.test({
  name: "sec7 (engine table) is ~99.8% game-invariant",
  ignore: !hasFixtures("ramsie.sav", "mucha-kucha.sav"),
  fn() {
    const a = decompress(sectionsOf("ramsie.sav")[7]);
    const b = decompress(sectionsOf("mucha-kucha.sav")[7]);
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    assert(same / a.length > 0.99);
  },
});

Deno.test({
  name: "decompress golden spot-check: ramsie sec4 begins with the literal run",
  ignore: !hasFixtures("ramsie.sav"),
  fn() {
    const out = decompress(sectionsOf("ramsie.sav")[4]);
    // Compressed stream opens with flag 0xFF + these eight literals.
    assertEquals([...out.subarray(0, 8)], [
      0x80,
      0x00,
      0x53,
      0xde,
      0x3f,
      0xde,
      0x03,
      0xde,
    ]);
  },
});

// --- .CMP disc files: a u32le stream length, then the same LZSS -----------

Deno.test("decompressCmp honours the length header and rejects a short file", () => {
  // flag 0xff = eight literals
  const stream = [0xff, 1, 2, 3, 4, 5, 6, 7, 8];
  const cmp = new Uint8Array([stream.length, 0, 0, 0, ...stream, 0xee, 0xee]);
  assertEquals(Array.from(decompressCmp(cmp)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assertThrows(
    () => decompressCmp(new Uint8Array([20, 0, 0, 0, ...stream])),
    Error,
    "header says",
  );
  assertThrows(() => decompressCmp(new Uint8Array([1, 0])), Error);
});
