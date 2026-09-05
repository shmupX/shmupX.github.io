// RGBA -> CG pixel bytes under the two palette targets, and the cell packer
// that puts the result on the art pages.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { DEZA2_PALETTE_WORDS } from "../src/palette/deza2-palette.js";
import {
  bankToPalettes,
  bankToSec4,
  colorHistogram,
  emptyBank,
  frameGroup,
  medianCut,
  PALETTE_TARGETS,
  quantizeFrames,
  snesCgramBytes,
  USER_ROW_FIRST,
} from "../src/palette/palette-target.js";
import {
  CG_CELL_CAPACITY,
  CgFullError,
  CgPacker,
  REF_HFLIP,
  REF_VFLIP,
} from "../src/write/cg-pack.js";
import { cellIndexed, decodePalettes } from "../src/decode/decode-cg.js";
import { EMPTY_REF } from "../src/decode/decode-sprites.js";

function solid(w, h, [r, g, b, a = 255], key = "f", group) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, a], i * 4);
  return { key, w, h, rgba, group };
}

// Left half one colour, right half another, top row transparent.
function twoTone(w, h, a, b, key, group) {
  const f = solid(w, h, a, key, group);
  for (let y = 0; y < h; y++) {
    for (let x = w / 2; x < w; x++) f.rgba.set(b, (y * w + x) * 4);
  }
  for (let x = 0; x < w; x++) f.rgba[x * 4 + 3] = 0;
  return f;
}

Deno.test("the empty bank is sec4-shaped: 0x8000 lead, system rows verbatim, user rows marked", () => {
  const bank = emptyBank();
  assertStrictEquals(bank[0], 0x8000);
  for (let i = 1; i < 192; i++) {
    assertStrictEquals(bank[i], DEZA2_PALETTE_WORDS[i]);
  }
  assertStrictEquals(bank[192], 0);
  assertStrictEquals(bank[207], 0x0021);
  assertStrictEquals(bank[255], 0x0021);
  const sec4 = bankToSec4(bank);
  assertStrictEquals(sec4.length, 512);
  assertEquals([...sec4.subarray(0, 4)], [0x80, 0x00, 0x53, 0xde]);
  assertEquals(decodePalettes(sec4)[4].colors[0], {
    raw: 0x7fff,
    r: 255,
    g: 255,
    b: 255,
    empty: false,
  });
});

Deno.test("saturn: system colours index exactly, transparency is index 0", () => {
  // white (row 4 col 0 = index 64) and pure green (row 1 col 7 = index 23)
  const f = twoTone(16, 16, [255, 255, 255], [0, 255, 0], "a");
  const q = quantizeFrames([f], "saturn");
  assertStrictEquals(q.target, PALETTE_TARGETS.saturn);
  const px = q.frames[0].indexed;
  assertStrictEquals(px[0], 0, "transparent top row");
  assertStrictEquals(px[16], 64);
  assertStrictEquals(px[16 + 8], 23);
  assertStrictEquals(q.report.userColors, 0, "nothing needed a user slot");
  assertStrictEquals(q.report.meanError, 0);
});

Deno.test("saturn: a colour the system ramps miss lands in a user slot, flagged 0x8000", () => {
  // A pink-violet no preset ramp comes near (the farthest 15-bit colour
  // from the whole system palette, squared 5-bit distance 166).
  const f = solid(16, 16, [248, 104, 248], "violet");
  const q = quantizeFrames([f], "saturn");
  assertStrictEquals(q.report.userColors, 1);
  const index = q.frames[0].indexed[0];
  assert(index >= USER_ROW_FIRST * 16, `index ${index} should be a user slot`);
  assertStrictEquals(q.bank[index] & 0x8000, 0x8000);
  assertStrictEquals(
    q.bank[index] & 0x7fff,
    (248 >> 3) | ((104 >> 3) << 5) | ((248 >> 3) << 10),
  );
  // rendered back, the colour is within 5-bit rounding
  const c = bankToPalettes(q.bank)[index >> 4].colors[index & 15];
  assert(
    Math.abs(c.r - 248) <= 8 && Math.abs(c.g - 104) <= 8 &&
      Math.abs(c.b - 248) <= 8,
  );
  // while a colour a system ramp already has takes no user slot at all
  assertStrictEquals(
    quantizeFrames([solid(8, 8, [255, 255, 255], "w")], "saturn").report
      .userColors,
    0,
  );
});

Deno.test("saturn: never more than 64 user colours, whatever the input", () => {
  const frames = [];
  for (let i = 0; i < 200; i++) {
    frames.push(
      solid(4, 4, [(i * 37) & 0xff, (i * 91) & 0xff, (i * 13) & 0xff], `c${i}`),
    );
  }
  const q = quantizeFrames(frames, "saturn");
  assert(q.report.userColors <= 64);
  let flagged = 0;
  for (let i = 192; i < 256; i++) if (q.bank[i] & 0x8000) flagged++;
  assertStrictEquals(flagged, q.report.userColors);
});

Deno.test("snes: one row per sprite, entry 0 of every row transparent, at most four rows", () => {
  const frames = [
    twoTone(16, 16, [255, 0, 0], [200, 0, 0], "red0.png"),
    twoTone(16, 16, [250, 10, 0], [180, 0, 10], "red1.png"),
    twoTone(16, 16, [0, 0, 255], [0, 0, 200], "blue0.png"),
    twoTone(16, 16, [0, 255, 0], [0, 200, 0], "green0.png"),
    twoTone(16, 16, [255, 255, 0], [200, 200, 0], "yellow0.png"),
    twoTone(16, 16, [255, 0, 255], [200, 0, 200], "purple0.png"),
    twoTone(16, 16, [0, 255, 255], [0, 200, 200], "cyan0.png"),
  ];
  const q = quantizeFrames(frames, "snes");
  assert(q.report.rows.length <= 4 && q.report.rows.length >= 1);
  for (const f of q.frames) {
    const rows = new Set();
    for (const v of f.indexed) if (v) rows.add(v >> 4);
    assertStrictEquals(rows.size, 1, `${f.key} draws from ${rows.size} rows`);
    const row = [...rows][0];
    assert(row >= 12 && row <= 15, `${f.key} row ${row}`);
    assertStrictEquals(row, f.row);
    for (const v of f.indexed) {
      if (v) {
        assert(
          (v & 15) !== 0,
          "colour 0 of a row is the SNES transparent slot",
        );
      }
    }
  }
  // red0 and red1 are one sprite ("red"): same row
  assertStrictEquals(q.frames[0].row, q.frames[1].row);
  for (let row = 12; row < 16; row++) {
    assertStrictEquals(q.bank[row * 16], 0, `row ${row} entry 0`);
  }
  // system rows untouched
  for (let i = 1; i < 192; i++) {
    assertStrictEquals(q.bank[i], DEZA2_PALETTE_WORDS[i]);
  }
});

Deno.test("snes: a 15-colour row reproduces up to 15 colours exactly", () => {
  const f = solid(16, 16, [0, 0, 0], "ramp0.png");
  for (let i = 0; i < 256; i++) {
    const c = i % 15;
    f.rgba.set([c * 17, 255 - c * 17, (c * 40) & 0xff, 255], i * 4);
  }
  const q = quantizeFrames([f], "snes");
  assertStrictEquals(q.report.rows.length, 1);
  assertStrictEquals(q.report.rows[0].colors, 15);
  assertStrictEquals(q.report.meanError, 0);
});

Deno.test("snesCgramBytes is 256 little-endian words with bit 15 clear", () => {
  const bank = emptyBank();
  bank[200] = 0x8000 | 0x7c1f;
  const pal = snesCgramBytes(bank);
  assertStrictEquals(pal.length, 512);
  assertEquals([...pal.subarray(0, 2)], [0, 0]);
  assertEquals([...pal.subarray(400, 402)], [0x1f, 0x7c]);
  // white at index 64 -> 0x7fff
  assertEquals([...pal.subarray(128, 130)], [0xff, 0x7f]);
});

Deno.test("medianCut and frameGroup helpers", () => {
  const hist = colorHistogram([twoTone(8, 8, [255, 0, 0], [0, 0, 255], "x")]);
  assertStrictEquals(hist.size, 2);
  assertStrictEquals(
    medianCut(hist, 4).length,
    2,
    "fewer colours than the budget come back as they are",
  );
  const many = new Map();
  for (let i = 0; i < 32; i++) many.set(i | (i << 5) | (i << 10), 1);
  assert(medianCut(many, 6).length <= 6);
  assertStrictEquals(frameGroup("redEyeOcto0.png"), "redEyeOcto");
  assertStrictEquals(frameGroup("pink-saw-ball12.png"), "pink-saw-ball");
  assertStrictEquals(frameGroup("deza0_12_3.gif"), "deza0");
  assertStrictEquals(frameGroup("launchpad.png"), "launchpad");
});

Deno.test("quantizeFrames rejects an unknown target and a short rgba", () => {
  assertThrows(
    () => quantizeFrames([], "genesis"),
    Error,
    "unknown palette target",
  );
  assertThrows(
    () => quantizeFrames([{ key: "x", w: 4, h: 4, rgba: new Uint8Array(3) }]),
    Error,
    "w*h*4",
  );
});

// --- the cell packer ---

function cellOf(fill) {
  const c = new Uint8Array(256);
  for (let i = 0; i < 256; i++) c[i] = fill(i % 16, i >> 4);
  return c;
}

Deno.test("CgPacker: blank cells are 0xFFFF, duplicates and mirrors are shared", () => {
  const p = new CgPacker();
  assertStrictEquals(p.addCell(new Uint8Array(256)), EMPTY_REF);
  const a = cellOf((x, y) => (x < 8 ? 5 : 0) + y);
  const r0 = p.addCell(a);
  assertStrictEquals(r0, 0);
  assertStrictEquals(p.addCell(a), 0);
  assertStrictEquals(p.shared, 1);
  const flipped = cellOf((x, y) => (x >= 8 ? 5 : 0) + y);
  assertStrictEquals(p.addCell(flipped), 0 | REF_HFLIP);
  const upside = cellOf((x, y) => (x < 8 ? 5 : 0) + (15 - y));
  assertStrictEquals(p.addCell(upside), 0 | REF_VFLIP);
  assertStrictEquals(p.used, 1);
  // the bytes land at cell 0 of page 0
  assertEquals(cellIndexed(p.pages, 0), a);
});

Deno.test("CgPacker: a frame comes back as reading-order refs on the right pages", () => {
  const p = new CgPacker();
  const indexed = new Uint8Array(32 * 16);
  for (let i = 0; i < indexed.length; i++) indexed[i] = i % 32 < 16 ? 1 : 2;
  const refs = p.addFrame(indexed, 32, 16);
  assertEquals([...refs], [0, 1]);
  assert(cellIndexed(p.pages, 0).every((v) => v === 1));
  assert(cellIndexed(p.pages, 1).every((v) => v === 2));
  // cell 256 is page 1
  for (let i = 0; i < 254; i++) {
    p.addCell(cellOf((x, y) => 3 + ((i + x + y) & 0xff) | 0x10));
  }
  const c = cellOf(() => 0x77);
  const ref = p.addCell(c);
  assertStrictEquals(ref, 256);
  assertEquals(cellIndexed(p.pages, 256), c);
});

Deno.test("CgPacker: capacity overflow throws and leaves nothing half-stored", () => {
  const p = new CgPacker({ capacity: 2 });
  assertStrictEquals(p.capacity, 2);
  assertStrictEquals(CG_CELL_CAPACITY, 1024);
  const big = new Uint8Array(48 * 16);
  for (let i = 0; i < big.length; i++) big[i] = 1 + Math.floor((i % 48) / 16);
  assertThrows(() => p.addFrame(big, 48, 16), CgFullError);
  assertStrictEquals(p.used, 0);
  const small = new Uint8Array(32 * 16).fill(9);
  assertEquals(
    [...p.addFrame(small, 32, 16)],
    [0, 0],
    "identical halves share a cell",
  );
});
