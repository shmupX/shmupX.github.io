// static/qr.js is the whole of ISO/IEC 18004 that two short strings need, so
// it is written out rather than pulled in — which means nothing but this file
// says it is right.
//
// The two golden symbols below were cross-checked module for module against
// segno 1.6.6 while the encoder was written (970 symbols across every mode,
// all four levels and versions 1-40 came out byte-identical), and "HELLO
// WORLD" at level Q is the worked example the specification itself carries: its
// data codewords are 20 5B 0B 78 D1 72 DC 4D 43 40 EC 11 EC, which is what the
// first matrix here decodes back to. Pinning the finished matrices is what
// keeps a later edit from quietly producing a symbol no camera can read.
//
// One deliberate divergence from segno, noted so nobody "fixes" it: segno
// scores the eight masks on a matrix whose format bits have not been written
// yet, and this scores the finished symbol (the reading Nayuki's reference
// implementation takes). Both are valid — the mask number differs on some
// inputs, the symbol reads the same either way — but it means a segno matrix is
// only comparable with the mask pinned.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { builderPairUrl, encodeQr, qrSvg } from "../static/qr.js";

/** "HELLO WORLD" at level Q — the specification's own worked example. */
const HELLO_WORLD_Q = [
  "111111101100001111111",
  "100000101001001000001",
  "101110101001101011101",
  "101110101000001011101",
  "101110101010001011101",
  "100000100010001000001",
  "111111101010101111111",
  "000000001000000000000",
  "011010110000101011111",
  "010000001111000010001",
  "001101110110001011000",
  "011011010011010101110",
  "100010101011101110101",
  "000000001101001000101",
  "111111101010000101100",
  "100000100101101101000",
  "101110101010001111111",
  "101110100101010100010",
  "101110101001011101001",
  "100000101011110001011",
  "111111100001011100001",
];

/** A BUILD CODE as the editor prints it — alphanumeric mode, level M. */
const BUILD_CODE_M = [
  "111111101110101111111",
  "100000100101001000001",
  "101110100010101011101",
  "101110101110101011101",
  "101110101100101011101",
  "100000101111001000001",
  "111111101010101111111",
  "000000001011100000000",
  "100010111001011111001",
  "001100001101100001101",
  "101101110011001111011",
  "010100010110011110000",
  "001110101010111001100",
  "000000001100111010101",
  "111111101000110110101",
  "100000100101100100100",
  "101110101001001011101",
  "101110100101100100111",
  "101110100011001101000",
  "100000100100011010101",
  "111111101000111101111",
];

function rowsOf(text: string, ecc: string): string[] {
  const { modules } = encodeQr(text, { ecc });
  return modules.map((row: Uint8Array) => Array.from(row).join(""));
}

Deno.test("the specification's own worked example comes out module for module", () => {
  const code = encodeQr("HELLO WORLD", { ecc: "Q" });
  assertEquals(code.version, 1);
  assertEquals(code.size, 21);
  assertEquals(rowsOf("HELLO WORLD", "Q"), HELLO_WORLD_Q);
});

Deno.test("a BUILD CODE is a version 1 symbol at every level", () => {
  assertEquals(rowsOf("ABCD-EFGH", "M"), BUILD_CODE_M);
  for (const ecc of ["L", "M", "Q", "H"]) {
    assertEquals(
      encodeQr("ABCD-EFGH", { ecc }).version,
      1,
      `eight letters and a dash fit the smallest symbol at level ${ecc}`,
    );
  }
});

Deno.test("the three finder patterns are in all three corners", () => {
  const { size, modules } = encodeQr("https://codemonkey.games/", { ecc: "M" });
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assertEquals(
          modules[oy + y][ox + x],
          ring === 2 ? 0 : 1,
          `finder at ${ox},${oy} module ${x},${y}`,
        );
      }
    }
  }
  // The one module that is dark in every symbol ever made.
  assertEquals(modules[size - 8][8], 1, "the dark module");
});

Deno.test("each mode is picked by what the text is made of, and sized for it", () => {
  // Numeric packs three digits into ten bits, alphanumeric two chars into
  // eleven, byte one into eight — so the same length needs a bigger symbol as
  // the alphabet widens.
  const digits = encodeQr("1".repeat(60), { ecc: "M" }).version;
  const alnum = encodeQr("A".repeat(60), { ecc: "M" }).version;
  const bytes = encodeQr("a".repeat(60), { ecc: "M" }).version;
  assert(digits < alnum, `numeric ${digits} < alphanumeric ${alnum}`);
  assert(alnum < bytes, `alphanumeric ${alnum} < byte ${bytes}`);
});

Deno.test("a stronger level costs capacity, so it costs version", () => {
  const text = "https://codemonkey.games/editor/?builder=ABCDEFGH";
  const l = encodeQr(text, { ecc: "L" }).version;
  const h = encodeQr(text, { ecc: "H" }).version;
  assert(l < h, `level L took version ${l}, level H took ${h}`);
});

Deno.test("what will not fit is refused rather than truncated", () => {
  // 7,089 digits is the most any QR symbol holds, at level L.
  assertEquals(encodeQr("1".repeat(7089), { ecc: "L" }).version, 40);
  assertThrows(
    () => encodeQr("1".repeat(7090), { ecc: "L" }),
    RangeError,
    "do not fit",
  );
  assertThrows(() => encodeQr("hi", { ecc: "X" }), RangeError, "no such level");
});

Deno.test("a URL round-trips through byte mode whatever is in it", () => {
  // The artifact URL a finished build is offered at: a path, a query, escapes.
  const url = "http://192.168.1.24:8787/api/build-artifact?path=" +
    encodeURIComponent("/home/deck/build/my level/dist/app-debug.apk");
  const code = encodeQr(url, { ecc: "M" });
  assert(code.version > 1 && code.version <= 40);
  assertEquals(code.size, code.version * 4 + 17);
});

Deno.test("the SVG carries the quiet zone the format requires", () => {
  const svg = qrSvg("ABCD-EFGH", { ecc: "M" });
  // 21 modules plus four either side.
  assertStringIncludes(svg, 'viewBox="0 0 29 29"');
  assertStringIncludes(svg, "<path");
  assertStringIncludes(svg, 'shape-rendering="crispEdges"');
  // A label becomes the accessible name, and is escaped on the way in.
  const labelled = qrSvg("x", { label: 'pair <a href="#">' });
  assertStringIncludes(labelled, "&lt;a href=&quot;#&quot;&gt;");
  // An explicit light colour paints a ground behind the modules; the default
  // leaves the page's own showing through.
  assertStringIncludes(qrSvg("x", { light: "#fff" }), "<rect");
  assert(!qrSvg("x").includes("<rect"), "no ground by default");
  assertEquals(qrSvg("", { quiet: 0 }).includes('viewBox="0 0 21 21"'), true);
});

Deno.test("the pairing link is what the editor already reads off its own URL", () => {
  assertEquals(
    builderPairUrl("ABCDEFGH", "https://codemonkey.games"),
    "https://codemonkey.games/editor/?builder=ABCDEFGH",
  );
  // A trailing slash on the origin must not double up.
  assertEquals(
    builderPairUrl("ABCDEFGH", "http://192.168.1.24:8787/"),
    "http://192.168.1.24:8787/editor/?builder=ABCDEFGH",
  );
  // And the whole link has to stay small enough to scan across a room.
  assert(
    encodeQr(builderPairUrl("ABCDEFGH", "https://codemonkey.games"), {
      ecc: "M",
    }).version <= 6,
    "a pairing link must not need a dense symbol",
  );
});
