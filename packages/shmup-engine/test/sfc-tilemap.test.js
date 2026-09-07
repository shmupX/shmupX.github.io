// SNES tilemap words and the quad shapes the GROUP tables use.

import { assertEquals, assertThrows } from "@std/assert";
import {
  classifyQuad,
  decodeTilemapWord,
  decodeTilemapWords,
  readWords,
} from "../src/sfc/tilemap.js";

Deno.test("decodeTilemapWord splits tile, palette, priority and flips", () => {
  assertEquals(decodeTilemapWord(0x4263), {
    word: 0x4263,
    tile: 0x263,
    palette: 0,
    priority: false,
    hflip: true,
    vflip: false,
    empty: false,
  });
  const w = decodeTilemapWord(0xb7ff);
  assertEquals([w.tile, w.palette, w.priority, w.hflip, w.vflip], [
    0x3ff,
    5,
    true,
    false,
    true,
  ]);
  assertEquals(w.empty, false);
});

Deno.test("0xFFFF and 0x03FF decode as empty", () => {
  assertEquals(decodeTilemapWord(0xffff).empty, true);
  assertEquals(decodeTilemapWord(0x03ff).empty, true);
  assertEquals(decodeTilemapWord(0x03fe).empty, false);
});

Deno.test("readWords is little-endian and refuses to run past the end", () => {
  const bytes = new Uint8Array([0x63, 0x42, 0xff, 0x03]);
  assertEquals(Array.from(readWords(bytes, 0, 2)), [0x4263, 0x03ff]);
  assertEquals(decodeTilemapWords(bytes, 0, 2).map((e) => e.tile), [
    0x263,
    0x3ff,
  ]);
  assertThrows(() => readWords(bytes, 2, 2), Error, "run past the end");
});

Deno.test("classifyQuad recognises chips, strips and empty quads", () => {
  assertEquals(classifyQuad([0x0200, 0x0201, 0x0208, 0x0209]), "chip");
  assertEquals(classifyQuad([0x0244, 0x0245, 0x4245, 0x4244]), "strip");
  assertEquals(classifyQuad([0x03ff, 0x03ff, 0xffff, 0xffff]), "empty");
  assertEquals(classifyQuad([0x0200, 0x0201, 0x0202, 0x0203]), null);
  assertEquals(classifyQuad([0x0200, 0x0201, 0x0208, 0x03ff]), null);
  assertEquals(classifyQuad([0x0200, 0x0601, 0x0208, 0x0209]), null); // palette differs
  assertEquals(classifyQuad([0x0200, 0x0201]), null);
});
