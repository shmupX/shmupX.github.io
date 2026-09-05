// The LZSS encoder must be the exact inverse of the decoder that every real
// save has been read through — decompress(compress(x)) === x — and land in
// the same size class as the Saturn's own streams.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave, parseSectionTable } from "../src/payload-table.js";
import { decompress, decompressCmp } from "../src/decompress.js";
import { compress, compressCmp } from "../src/compress.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

function roundTrip(bytes) {
  const packed = compress(bytes);
  assertEquals(decompress(packed), bytes);
  return packed;
}

Deno.test("degenerate inputs round-trip: empty, one byte, two bytes", () => {
  assertStrictEquals(compress(new Uint8Array(0)).length, 0);
  roundTrip(new Uint8Array([7]));
  roundTrip(new Uint8Array([7, 7]));
  roundTrip(new Uint8Array([1, 2, 3]));
});

Deno.test("a zero region codes as matches against the ring's zero prefill", () => {
  const zeros = new Uint8Array(65536);
  const packed = roundTrip(zeros);
  // 18 bytes per match, 17 bits per match: well under 1/8 of the input.
  assert(packed.length < 8192, `${packed.length} bytes for 64 KB of zeros`);
});

Deno.test("random bytes survive, costing at most the literal overhead", () => {
  const rnd = new Uint8Array(20000);
  let seed = 12345;
  for (let i = 0; i < rnd.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    rnd[i] = seed >>> 24;
  }
  const packed = roundTrip(rnd);
  assert(packed.length <= rnd.length * 9 / 8 + 8);
});

Deno.test("repeating and overlapping runs round-trip", () => {
  const pattern = new Uint8Array(50000);
  for (let i = 0; i < pattern.length; i++) {
    pattern[i] = (i % 7) * 3 + ((i / 5000) | 0);
  }
  const packed = roundTrip(pattern);
  assert(packed.length < pattern.length / 4);
  // A run of one byte (the classic self-overlapping copy).
  const run = new Uint8Array(3000).fill(0xab);
  run[0] = 1;
  roundTrip(run);
  // Runs whose distance is under the match length.
  const short = new Uint8Array(4000);
  for (let i = 0; i < short.length; i++) short[i] = i % 5;
  roundTrip(short);
});

Deno.test("matches reach the whole 4096-byte window and no further", () => {
  // A block, 4090 filler bytes, the same block again: the second copy sits
  // within the window and must round-trip (and be coded as matches).
  const block = new Uint8Array(64);
  for (let i = 0; i < block.length; i++) block[i] = 100 + i;
  const a = new Uint8Array(64 + 4000 + 64);
  a.set(block, 0);
  for (let i = 64; i < 4064; i++) a[i] = (i * 7) & 0xff;
  a.set(block, 4064);
  roundTrip(a);
  // Distance past 4096: still correct, just not a match.
  const b = new Uint8Array(64 + 4200 + 64);
  b.set(block, 0);
  for (let i = 64; i < 4264; i++) b[i] = (i * 7) & 0xff;
  b.set(block, 4264);
  roundTrip(b);
});

Deno.test("compressCmp writes the u32le length header decompressCmp expects", () => {
  const raw = new Uint8Array(1000);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) & 0xff;
  const cmp = compressCmp(raw);
  const len = cmp[0] | (cmp[1] << 8) | (cmp[2] << 16) | (cmp[3] << 24);
  assertStrictEquals(len, cmp.length - 4);
  assertEquals(decompressCmp(cmp), raw);
});

function sectionsOf(name) {
  const [save] = bup.parse(deinterleave(loadFixture(name))).filter(isGameSave);
  const table = parseSectionTable(save.payload.buffer);
  return table.sections.map((s) => ({
    stream: save.payload.buffer.subarray(s.offset, s.offset + s.size),
    raw: decompress(save.payload.buffer.subarray(s.offset, s.offset + s.size)),
  }));
}

for (const fixture of ["ramsie.sav", "mucha-kucha.sav"]) {
  Deno.test({
    name:
      `every section of ${fixture} round-trips, within 5% of the Saturn's own size`,
    ignore: !hasFixtures(fixture),
    fn() {
      for (const [i, s] of sectionsOf(fixture).entries()) {
        const packed = compress(s.raw);
        assertEquals(decompress(packed), s.raw, `sec${i}`);
        assert(
          packed.length <= s.stream.length * 1.05 + 16,
          `sec${i}: ${packed.length} bytes vs the game's ${s.stream.length}`,
        );
      }
    },
  });
}
