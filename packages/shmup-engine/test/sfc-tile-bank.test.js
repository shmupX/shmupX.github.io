// The tile allocator: distinct tiles once, mirrors shared through flips, a
// blank tile 0, a full bank refused.

import { assertEquals } from "@std/assert";
import { SfcTileBank } from "../src/sfc/tile-bank.js";
import { decodeTile4bpp, flipTile } from "../src/sfc/tiles.js";

function raster(w, h, fn) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = fn(x, y) & 0x0f;
  }
  return out;
}

Deno.test("a 16x16 raster of two distinct tiles and their mirrors takes three tiles", () => {
  // top-left: a diagonal; top-right: its horizontal mirror; bottom-left: its
  // vertical mirror; bottom-right: a solid block.
  const diag = raster(8, 8, (x, y) => (x === y ? 3 : x < y ? 1 : 0));
  const art = new Uint8Array(16 * 16);
  const put = (tile, ox, oy) => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        art[(oy + y) * 16 + ox + x] = tile[y * 8 + x];
      }
    }
  };
  put(diag, 0, 0);
  put(flipTile(diag, true, false), 8, 0);
  put(flipTile(diag, false, true), 0, 8);
  put(raster(8, 8, () => 7), 8, 8);
  const bank = new SfcTileBank(64);
  const cells = bank.addRaster(art, 16, 16);
  assertEquals(bank.used, 3, "blank + diagonal + block");
  assertEquals(cells.map((c) => c.tile), [1, 1, 1, 2]);
  assertEquals(cells.map((c) => [c.hflip, c.vflip]), [
    [false, false],
    [true, false],
    [false, true],
    [false, false],
  ]);
  assertEquals(bank.shared, 2);
  // the bytes decode back to the stored tiles
  const bytes = bank.toBytes(4);
  assertEquals(bytes.length, 4 * 32);
  assertEquals(Array.from(decodeTile4bpp(bytes, 32)), Array.from(diag));
  assertEquals(Array.from(decodeTile4bpp(bytes, 0)), new Array(64).fill(0));
  // a blank 8x8 points at tile 0 and costs nothing
  assertEquals(bank.addRaster(new Uint8Array(64), 8, 8)[0].tile, 0);
  assertEquals(bank.used, 3);
});

Deno.test("a full bank returns null and keeps what it has", () => {
  const bank = new SfcTileBank(2);
  const a = raster(8, 8, (x) => x);
  const b = raster(8, 8, (x, y) => y);
  assertEquals(bank.addTile(a).tile, 1);
  assertEquals(bank.addTile(b), null);
  assertEquals(bank.used, 2);
  assertEquals(bank.free, 0);
  const art = new Uint8Array(16 * 8);
  art.set(a.subarray(0, 8), 0);
  assertEquals(bank.addRaster(art, 16, 8), null, "runs out on the second cell");
});
