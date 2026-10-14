// src/n64/xz.js: the XZ / LZMA2 / LZMA decoder under the xdelta3 applier.
//
// The streams here were written by liblzma (Python's lzma module, default
// preset) and are committed as base64; the bytes they were made from are
// regenerated below from the same recipe, so a decode is judged byte for
// byte. Beyond the complete-stream round trips, the cases that matter to the
// patch are covered: a stream cut at a chunk boundary (xdelta3 never
// finishes its streams), a decoder fed in pieces (window 1's sections
// continue window 0's streams), and a filter the decoder does not implement
// being refused by name.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { crc32, crc64, decodeXz, XZ_CHECKS, XzDecoder } from "../src/n64/xz.js";

// 40 text records then 256 bytes of a 37-step ramp: 1,530 bytes that LZMA
// compresses to one chunk of 2 KB of literals and matches.
function structuredBytes() {
  let text = "";
  for (let i = 0; i < 40; i++) {
    text += `record ${String(i).padStart(3, "0")} alpha beta gamma ${i * i}\n`;
  }
  const out = new Uint8Array(text.length + 256);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  for (let i = 0; i < 256; i++) out[text.length + i] = (i * 37) & 0xff;
  return out;
}

// lzma.compress(structured, FORMAT_XZ, check=CHECK_CRC64)
const STRUCTURED_CRC64 = [
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AX5AdBdADkZSJGxo7bIcN4IMJ7m7p9ixQ6B7Tq5mT3K",
  "QOST/7F839cotCvjL0280ce9vFhoOhA9B0fiq5FpBDc8DAm6LzBUx5rO31ySVhq8xltKHuqCCtTF",
  "W6lRFOYWvt6TxU5Q1lWxeWBmgtqmSe4TUcDwjGxzNMf862ZhrFOU62sp/xBm6Qy9hvoNJuWphHMt",
  "ZOdJG/kT23mrSFGEdvqFvXJT0eA7qbGw4x1C1GmceSfLr1lzX3fqGOT9+yzjJOp6HjJjZZCfVte7",
  "+4Yeb0iCi+KSzNhH3u8XQNpxUavjK3+vjj21auyqcSby2prS/d/chpbJrjx4AQLeU7fUacaTLTyt",
  "WNGvSwZ7QTiUuFRkptOnSIPjcYmTw1mVM7zYDhe5+Wr6LXCwJsFJwSFgKQrZIn2TabEorpkzoxbO",
  "MOUiHmpi33pcUmz4El/fIrYuGiI1OcP8rBAl0lUDaGlq25GeuUg2Ccdp3WpLwsdgdRqalFGNz6Ol",
  "9rC7urIMATFYn0jBB9Ve3qjt2urlkI1L8v6hespOADhYOM9VX/F7XjomWEynAQDYRtWvCuTq6A9p",
  "RvavvaFI6EAnU7kjQI1eWSf4qHuP3MI998lIytD5tkWh9y+A0rUpAHxoF32h794LAAHsA/oLAADW",
  "bP0AscRn+wIAAAAABFla",
].join("");

// The same input with check=CHECK_NONE, as xdelta3 writes its streams.
const STRUCTURED_NONE = [
  "/Td6WFoAAAD/EtlBAgAhARYAAAB0L+Wj4AX5AdBdADkZSJGxo7bIcN4IMJ7m7p9ixQ6B7Tq5mT3K",
  "QOST/7F839cotCvjL0280ce9vFhoOhA9B0fiq5FpBDc8DAm6LzBUx5rO31ySVhq8xltKHuqCCtTF",
  "W6lRFOYWvt6TxU5Q1lWxeWBmgtqmSe4TUcDwjGxzNMf862ZhrFOU62sp/xBm6Qy9hvoNJuWphHMt",
  "ZOdJG/kT23mrSFGEdvqFvXJT0eA7qbGw4x1C1GmceSfLr1lzX3fqGOT9+yzjJOp6HjJjZZCfVte7",
  "+4Yeb0iCi+KSzNhH3u8XQNpxUavjK3+vjj21auyqcSby2prS/d/chpbJrjx4AQLeU7fUacaTLTyt",
  "WNGvSwZ7QTiUuFRkptOnSIPjcYmTw1mVM7zYDhe5+Wr6LXCwJsFJwSFgKQrZIn2TabEorpkzoxbO",
  "MOUiHmpi33pcUmz4El/fIrYuGiI1OcP8rBAl0lUDaGlq25GeuUg2Ccdp3WpLwsdgdRqalFGNz6Ol",
  "9rC7urIMATFYn0jBB9Ve3qjt2urlkI1L8v6hespOADhYOM9VX/F7XjomWEynAQDYRtWvCuTq6A9p",
  "RvavvaFI6EAnU7kjQI1eWSf4qHuP3MI998lIytD5tkWh9y+A0rUpAAAB5AP6CwAAu+6u7KgACvwC",
  "AAAAAABZWg==",
].join("");

// 300 bytes of noise with check=CHECK_CRC32: liblzma stores what does not
// compress as an uncompressed chunk (control byte 0x01), the other LZMA2
// chunk kind. The bytes are random.Random(7)'s, so the test knows them by
// their first eight, their sum and the CRC32 the stream itself carries.
const NOISE_CRC32 = [
  "/Td6WFoAAAFpIt42AgAhARYAAAB0L+WjAQErpU3KGCUwux1tEyze1iN7LtkeP3IfyxlxF0SU1kk8",
  "nVw0YL4xIB5p/tqg7ui5mX9cfCmZ/a/lkyU81lSvTfrXFCegrrP+6SMvivIhH57kkcWxC+y1Vjv8",
  "Hm+TQn7LyP4pVeXNjkbcjtS3wnZNKlpNdncG+F2GkAJK1r2jQBvpyMvMyTX2zR9hImrhUziuGjQA",
  "TTO6DSRqwEyBsbryPjv57vX3nytJNK+H9VILablLDZguhbtVtnKocmN6zXRm/LYODo/xhGOw5LK6",
  "KXA0dPBkrGj3APWwKz3GZvRb3qosyu3NK1FXQQ5N7krys09DCgc0R95jbA6AbJV7poTWQx+16tdC",
  "TQnhXQJMWEjyPR+m9zYdf2GNFTLnDiDipmaN5/R+hGflRtU+yOKhJXvbABPeVy0AAcACrAIAANrr",
  "RKw+MA2LAgAAAAABWVo=",
].join("");

const structuredCrc64 = () => decodeBase64(STRUCTURED_CRC64);

Deno.test("decodeXz decodes a stream liblzma wrote, with its CRC64, to the bytes it was made from", () => {
  const out = decodeXz(structuredCrc64(), { complete: true });
  assertEquals(out, structuredBytes());
});

Deno.test("decodeXz takes a stream whose check type is none, as xdelta3 writes them", () => {
  const stream = decodeBase64(STRUCTURED_NONE);
  assertStrictEquals(stream[7], 0, "check type byte");
  assertEquals(decodeXz(stream, { complete: true }), structuredBytes());
});

Deno.test("decodeXz decodes an uncompressed LZMA2 chunk and verifies a CRC32 check", () => {
  const stream = decodeBase64(NOISE_CRC32);
  assertStrictEquals(stream[7], 1, "check type byte");
  const headerSize = (stream[12] + 1) * 4;
  assertStrictEquals(
    stream[12 + headerSize],
    0x01,
    "first chunk: uncompressed, dictionary reset",
  );
  const out = decodeXz(stream, { complete: true });
  assertStrictEquals(out.length, 300);
  assertEquals([...out.subarray(0, 8)], [165, 77, 202, 24, 37, 48, 187, 29]);
  assertStrictEquals(out.reduce((a, b) => a + b, 0), 38119);
});

Deno.test("XzDecoder takes a stream in pieces and keeps the partial unit for the next call", () => {
  const stream = structuredCrc64();
  const decoder = new XzDecoder();
  const pieces = [];
  for (let i = 0; i < stream.length; i++) {
    pieces.push(decoder.decode(stream.subarray(i, i + 1)));
  }
  decoder.end({ complete: true });
  assert(decoder.finished);
  assertStrictEquals(decoder.pendingLength, 0);
  assertEquals(decoder.output, structuredBytes());
  // Everything came out of the one call that completed the LZMA2 chunk.
  const produced = pieces.filter((p) => p.length > 0);
  assertStrictEquals(produced.length, 1);
  assertStrictEquals(produced[0].length, 1530);
});

Deno.test("decodeXz accepts a stream cut at a chunk boundary, as xdelta3 leaves them, and refuses it only with complete", () => {
  const stream = structuredCrc64();
  const probe = new XzDecoder();
  probe.decode(stream);
  const { headerSize, compressedSize } = probe.blocks[0];
  // Drop the LZMA2 end marker (the last compressed byte) and all after it:
  // no end marker, no check, no index, no footer.
  const cut = stream.subarray(0, 12 + headerSize + compressedSize - 1);
  assertEquals(decodeXz(cut), structuredBytes());
  const decoder = new XzDecoder();
  decoder.decode(cut);
  assert(!decoder.finished);
  assertStrictEquals(decoder.phase, "chunks");
  assertStrictEquals(decoder.pendingLength, 0);
  decoder.end();
  assertThrows(() => decoder.end({ complete: true }), Error, "no footer");
  assertThrows(() => decodeXz(cut, { complete: true }), Error, "no footer");
});

Deno.test("decodeXz refuses an input that ends inside a unit, and a corrupted stream", () => {
  const stream = structuredCrc64();
  assertThrows(() => decodeXz(stream.subarray(0, 40)), Error, "ends");
  const bad = stream.slice();
  bad[12 + (bad[12] + 1) * 4 + 20] ^= 0x55;
  assertThrows(() => decodeXz(bad));
  const badHeader = stream.slice();
  badHeader[9] ^= 1;
  assertThrows(() => decodeXz(badHeader), Error, "stream header CRC32");
});

Deno.test("decodeXz refuses a filter it does not implement, by name", () => {
  const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const flags = [0x00, 0x01];
  const header = [
    0xfd,
    0x37,
    0x7a,
    0x58,
    0x5a,
    0x00,
    ...flags,
    ...le32(crc32(Uint8Array.from(flags))),
  ];
  // size byte 2 (12 bytes), one filter: id 0x03 Delta, one property byte, then zero padding and the CRC.
  const block = [0x02, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00];
  block.push(...le32(crc32(Uint8Array.from(block))));
  const err = assertThrows(
    () => decodeXz(Uint8Array.from([...header, ...block])),
    Error,
  );
  assert(err.message.includes("Delta"), err.message);
  assert(err.message.includes("LZMA2"), err.message);
});

Deno.test("crc32 and crc64 are the ones .xz uses", () => {
  // zlib.crc32 of the structured bytes, and the CRC-64/XZ check value for "123456789".
  assertStrictEquals(crc32(structuredBytes()), 0x9c6527da);
  const digits = Uint8Array.from("123456789", (c) => c.charCodeAt(0));
  assertEquals(crc64(digits), { hi: 0x995dc9bb, lo: 0xdf1939fa });
  assertStrictEquals(XZ_CHECKS[4].name, "CRC64");
  assertStrictEquals(XZ_CHECKS[10].size, 32);
});
