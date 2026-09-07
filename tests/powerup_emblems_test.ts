// Cutting a 16x16 item emblem out of an animated powerup GIF.
//
// The art itself lives in dev-fixtures/powerups/ and is deliberately NOT in
// the repo, so everything load-bearing is asserted against GIFs this file
// builds: a tiny writer emits a real GIF89a — global colour table, a
// transparent index, one full-screen frame per pose with disposal 2 between
// them — so the decoder, the scale detection and the cut are all exercised
// end to end without a fixture. The assertions that need the real letters
// (that each of the four fits the cell) are gated and report as ignored when
// the directory is absent.
//
// The shapes are written as character rows and then blown up by a known
// factor, which is the whole point: `pixelScale()` has to measure that factor
// back out of the pixels, and `emblemFromGif()` has to undo it by sampling
// rather than resampling, so the output must be the character rows again,
// colour for colour.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  EMBLEM_BY_TYPE,
  EMBLEM_CELL,
  EMBLEM_DIR,
  emblemFromGif,
  loadItemEmblems,
  pixelScale,
} from "../lib/powerup-emblems.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Shapes: character rows, one char per NATIVE pixel.
// ---------------------------------------------------------------------------

/** Palette index per character; "." is the transparent index 0. */
const INDEX: Record<string, number> = { ".": 0, o: 1, w: 2, r: 3, b: 4 };

/** RGB per palette index. Index 0 is never painted (it is the transparency). */
const PALETTE: number[][] = [
  [0, 0, 0],
  [0x20, 0x20, 0x20],
  [0xf0, 0xf0, 0xf0],
  [0xe0, 0x20, 0x30],
  [0x20, 0x40, 0xe0],
];

/** The folded pose: 12x14 native, so it drops into the 16x16 cell centred. */
const FOLDED = [
  "oooooooooooo",
  "owwwwwwwwwwo",
  "owrrrrrrrrwo",
  "owr......rwo",
  "owr.bbbb.rwo",
  "owr.b....rwo",
  "owr.bbb..rwo",
  "owr.b....rwo",
  "owr.b....rwo",
  "owr......rwo",
  "owrrrrrrrrwo",
  "owwwwwwwwwwo",
  "oooooooooooo",
  "o.o.o.o.o.o.",
];

/** A checkerboard `w` by `h` native pixels — never uniform at 2x2 or larger. */
function checker(w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) row += (x + y) % 2 ? "w" : "o";
    rows.push(row);
  }
  return rows;
}

/** The spread pose: 20x8 native, too wide for the cell at native scale. */
const SPREAD = checker(20, 8);

/** A third pose that fits exactly, with no room to centre. */
const TIGHT = checker(8, 8);

// ---------------------------------------------------------------------------
// A GIF writer, so the always-run tests need no fixture.
// ---------------------------------------------------------------------------

/** Paint `rows` into a logical-screen index buffer, blown up by `scale`. */
function paint(
  indices: Uint8Array,
  screenW: number,
  rows: string[],
  ox: number,
  oy: number,
  scale: number,
): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const idx = INDEX[rows[y][x]];
      if (!idx) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          indices[(oy + y * scale + dy) * screenW + ox + x * scale + dx] = idx;
        }
      }
    }
  }
}

/**
 * LZW that never compresses: a clear code, then one literal per pixel, with
 * another clear every 100 codes so the dictionary can never grow the code
 * size past 8 bits. Every code is then exactly one byte.
 */
function lzwLiterals(indices: Uint8Array): Uint8Array {
  const CLEAR = 128, EOI = 129;
  const out: number[] = [CLEAR];
  let since = 0;
  for (const idx of indices) {
    if (since >= 100) {
      out.push(CLEAR);
      since = 0;
    }
    out.push(idx);
    since++;
  }
  out.push(EOI);
  return new Uint8Array(out);
}

/** Wrap bytes in GIF data sub-blocks, terminator included. */
function subBlocks(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

interface SynthFrame {
  rows: string[];
  ox: number;
  oy: number;
  scale: number;
  delayMs?: number;
}

/**
 * A GIF89a of one full-screen frame per pose, each disposed to background so
 * the next frame composites onto a clean canvas — the way the real powerup
 * art alternates its two poses.
 */
function buildGif(
  width: number,
  height: number,
  frames: SynthFrame[],
  loopCount = 0,
): Uint8Array {
  const bytes: number[] = [];
  for (const ch of "GIF89a") bytes.push(ch.charCodeAt(0));
  bytes.push(width & 255, width >> 8, height & 255, height >> 8);
  bytes.push(0x86, 0, 0); // global table of 128 entries, background 0, aspect 0
  for (let i = 0; i < 128; i++) {
    const rgb = PALETTE[i] ?? [0, 0, 0];
    bytes.push(rgb[0], rgb[1], rgb[2]);
  }

  // NETSCAPE2.0 loop count.
  bytes.push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") bytes.push(ch.charCodeAt(0));
  bytes.push(3, 1, loopCount & 255, loopCount >> 8, 0);

  for (const frame of frames) {
    const indices = new Uint8Array(width * height);
    paint(indices, width, frame.rows, frame.ox, frame.oy, frame.scale);
    const delay = Math.round((frame.delayMs ?? 200) / 10);
    // disposal 2 (restore to background) with transparent index 0
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | 1, delay & 255, delay >> 8, 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0);
    bytes.push(width & 255, width >> 8, height & 255, height >> 8, 0);
    bytes.push(7, ...subBlocks(lzwLiterals(indices)));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** An RGBA raster of `rows` blown up by `scale`, plus its opaque bounds. */
function raster(rows: string[], scale: number) {
  const width = rows[0].length * scale, height = rows.length * scale;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const idx = INDEX[rows[y][x]];
      if (!idx) continue;
      const rgb = PALETTE[idx];
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const d = ((y * scale + dy) * width + x * scale + dx) * 4;
          data[d] = rgb[0];
          data[d + 1] = rgb[1];
          data[d + 2] = rgb[2];
          data[d + 3] = 255;
        }
      }
    }
  }
  return {
    data,
    width,
    height,
    box: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
  };
}

/** The colour of one emblem pixel as [r, g, b, a]. */
function px(rgba: Uint8Array, x: number, y: number): number[] {
  const d = (y * EMBLEM_CELL + x) * 4;
  return [rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]];
}

/** The bounding box of the opaque pixels of a 16x16 emblem. */
function opaqueBox(rgba: Uint8Array) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < EMBLEM_CELL; y++) {
    for (let x = 0; x < EMBLEM_CELL; x++) {
      if (!rgba[(y * EMBLEM_CELL + x) * 4 + 3]) continue;
      count++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1, count, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// pixelScale
// ---------------------------------------------------------------------------

Deno.test("pixelScale measures a 2x blowup back out of the pixels", () => {
  const { data, width, height, box } = raster(FOLDED, 2);
  assertEquals(width, 24);
  assertEquals(height, 28);
  assertEquals(pixelScale(data, width, height, box), 2);
});

Deno.test("pixelScale measures a 4x blowup", () => {
  const { data, width, height, box } = raster(["ow.", "wro", ".br"], 4);
  assertEquals(width, 12);
  assertEquals(pixelScale(data, width, height, box), 4);
});

Deno.test("pixelScale reports 1 for art that was never blown up", () => {
  const { data, width, height, box } = raster(FOLDED, 1);
  assertEquals(width, 12);
  assertEquals(height, 14);
  assertEquals(pixelScale(data, width, height, box), 1);
});

Deno.test("pixelScale does not claim a scale one broken block denies", () => {
  const { data, width, height, box } = raster(FOLDED, 2);
  assertEquals(pixelScale(data, width, height, box), 2);
  // Recolour a single pixel inside an otherwise uniform 2x2 block.
  const d = (1 * width + 1) * 4;
  data[d] = 0xe0;
  data[d + 1] = 0x20;
  data[d + 2] = 0x30;
  assertEquals(pixelScale(data, width, height, box), 1);
});

Deno.test("pixelScale does not claim a scale that punches a hole", () => {
  const { data, width, height, box } = raster(FOLDED, 2);
  // Alpha is part of the block's colour: clearing one pixel breaks 2x too.
  data[(3 * width + 2) * 4 + 3] = 0;
  assertEquals(pixelScale(data, width, height, box), 1);
});

Deno.test("pixelScale reports 1 when the box does not divide", () => {
  // A 2x blowup with an odd column of its own on the right: 25 is not even,
  // so 2 cannot be the factor however uniform the rest looks.
  const wide = raster(FOLDED, 2);
  const width = wide.width + 1, height = wide.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    data.set(
      wide.data.subarray(y * wide.width * 4, (y + 1) * wide.width * 4),
      y * width * 4,
    );
  }
  const d = (0 * width + width - 1) * 4;
  data[d] = 0xf0;
  data[d + 1] = 0xf0;
  data[d + 2] = 0xf0;
  data[d + 3] = 255;
  const box = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  assertEquals(pixelScale(data, width, height, box), 1);
});

// ---------------------------------------------------------------------------
// emblemFromGif
// ---------------------------------------------------------------------------

/** The three-pose GIF: the tight pose first, so the folded one replaces it. */
function posesGif(): Uint8Array {
  return buildGif(48, 32, [
    { rows: TIGHT, ox: 0, oy: 0, scale: 2 },
    { rows: SPREAD, ox: 2, oy: 2, scale: 2 },
    { rows: FOLDED, ox: 4, oy: 2, scale: 2 },
  ]);
}

Deno.test("emblemFromGif cuts a 16x16 cell", () => {
  const emblem = emblemFromGif(posesGif());
  assertEquals(emblem.w, EMBLEM_CELL);
  assertEquals(emblem.h, EMBLEM_CELL);
  assertEquals(emblem.rgba.length, EMBLEM_CELL * EMBLEM_CELL * 4);
});

Deno.test("emblemFromGif picks the largest pose that fits at native scale", () => {
  // SPREAD is 20 native columns and cannot fit; FOLDED is 12x14 and beats
  // the 8x8 TIGHT pose on area, so the cut is FOLDED.
  const box = opaqueBox(emblemFromGif(posesGif()).rgba);
  assertEquals(box.w, 12);
  assertEquals(box.h, 14);
});

Deno.test("emblemFromGif centres the pose in the cell", () => {
  const box = opaqueBox(emblemFromGif(posesGif()).rgba);
  // floor((16 - 12) / 2) = 2 columns of margin, floor((16 - 14) / 2) = 1 row.
  assertEquals(box.x0, 2);
  assertEquals(box.y0, 1);
  assertEquals(box.x1, 13);
  assertEquals(box.y1, 14);
});

Deno.test("emblemFromGif reproduces the source colours pixel for pixel", () => {
  const { rgba } = emblemFromGif(posesGif());
  let painted = 0;
  for (let y = 0; y < FOLDED.length; y++) {
    for (let x = 0; x < FOLDED[y].length; x++) {
      const idx = INDEX[FOLDED[y][x]];
      const got = px(rgba, 2 + x, 1 + y);
      if (!idx) {
        assertEquals(got, [0, 0, 0, 0], `native ${x},${y} stays transparent`);
        continue;
      }
      painted++;
      const rgb = PALETTE[idx];
      assertEquals(got, [rgb[0], rgb[1], rgb[2], 255], `native ${x},${y}`);
    }
  }
  // Nothing invented: only the pose is opaque, and every colour came through.
  assertEquals(opaqueBox(rgba).count, painted);
});

Deno.test("emblemFromGif blends nothing — the cell holds only source colours", () => {
  const { rgba } = emblemFromGif(posesGif());
  const allowed = new Set(
    PALETTE.slice(1).map((c) => (c[0] << 16) | (c[1] << 8) | c[2]),
  );
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    assertEquals(rgba[i + 3], 255, "no partial alpha is ever written");
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    assert(allowed.has(key), `0x${key.toString(16)} is a source colour`);
  }
});

Deno.test("emblemFromGif fills the cell when the pose is exactly 16x16", () => {
  // 16x16 native, so there is no margin to centre into and nothing to shrink.
  const emblem = emblemFromGif(buildGif(20, 20, [
    { rows: checker(16, 16), ox: 2, oy: 2, scale: 1 },
  ]));
  const box = opaqueBox(emblem.rgba);
  assertEquals([box.x0, box.y0, box.w, box.h], [0, 0, 16, 16]);
  assertEquals(box.count, EMBLEM_CELL * EMBLEM_CELL);
});

Deno.test("emblemFromGif centres a small pose rather than stretching it", () => {
  // 8x8 native at 2x fills 16x16 pixels, but the emblem is the NATIVE 8x8
  // with a four-pixel margin all round — the blowup is undone, not kept.
  const emblem = emblemFromGif(buildGif(24, 24, [
    { rows: TIGHT, ox: 4, oy: 4, scale: 2 },
  ]));
  const box = opaqueBox(emblem.rgba);
  assertEquals([box.x0, box.y0, box.w, box.h], [4, 4, 8, 8]);
  assertEquals(box.count, 64);
});

Deno.test("emblemFromGif takes art that was never blown up", () => {
  const emblem = emblemFromGif(buildGif(20, 20, [
    { rows: FOLDED, ox: 3, oy: 3, scale: 1 },
  ]));
  const box = opaqueBox(emblem.rgba);
  assertEquals([box.x0, box.y0, box.w, box.h], [2, 1, 12, 14]);
});

Deno.test("emblemFromGif throws rather than resampling art too big to fit", () => {
  // 20x20 native at 2x: shrinking it to the cell would mean throwing pixels
  // away, which is exactly what this refuses to do.
  const bytes = buildGif(48, 48, [{
    rows: checker(20, 20),
    ox: 2,
    oy: 2,
    scale: 2,
  }]);
  assertThrows(
    () => emblemFromGif(bytes),
    Error,
    "no frame fits 16x16 at native scale",
  );
});

Deno.test("emblemFromGif throws when every frame is blank", () => {
  const blank = ["....", "....", "....", "...."];
  assertThrows(
    () =>
      emblemFromGif(buildGif(8, 8, [{ rows: blank, ox: 0, oy: 0, scale: 2 }])),
    Error,
    "no frame fits",
  );
});

Deno.test("emblemFromGif throws on a GIF with no image blocks", () => {
  assertThrows(
    () => emblemFromGif(buildGif(8, 8, [])),
    Error,
    "GIF has no frames",
  );
});

Deno.test("emblemFromGif throws on bytes that are not a GIF", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assertThrows(() => emblemFromGif(png), Error, "not a GIF");
});

// ---------------------------------------------------------------------------
// EMBLEM_BY_TYPE
// ---------------------------------------------------------------------------

Deno.test("EMBLEM_BY_TYPE letters the item types that have a letter", () => {
  assertEquals(EMBLEM_BY_TYPE, {
    0: "r",
    1: "r",
    2: "r",
    3: "r",
    5: "b",
    7: "f",
    8: "s",
  });
});

Deno.test("EMBLEM_BY_TYPE leaves barrier and score their coloured squares", () => {
  // Types 4 (barrier) and 6 (score) wear no letter, and the writer falls back
  // to itemIcon() for them. Their absence is the contract, not an oversight.
  assert(!(4 in EMBLEM_BY_TYPE), "barrier has no emblem");
  assert(!(6 in EMBLEM_BY_TYPE), "score has no emblem");
  assertEquals(Object.keys(EMBLEM_BY_TYPE).length, 7);
  // All four weapon-change slots share the one R emblem.
  assertEquals([0, 1, 2, 3].map((t) => EMBLEM_BY_TYPE[t]), [
    "r",
    "r",
    "r",
    "r",
  ]);
});

Deno.test("EMBLEM_BY_TYPE is frozen, and the cell is the cart's 16x16", () => {
  assert(Object.isFrozen(EMBLEM_BY_TYPE));
  assertEquals(EMBLEM_CELL, 16);
  assertEquals(EMBLEM_DIR, "dev-fixtures/powerups");
});

// ---------------------------------------------------------------------------
// loadItemEmblems
// ---------------------------------------------------------------------------

/** Run `fn` against a scratch directory that is cleaned up afterwards. */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "powerup-emblems-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadItemEmblems returns null for a directory with no art", async () => {
  await withDir(async (dir) => {
    const warnings: string[] = [];
    assertEquals(await loadItemEmblems(dir, (m) => warnings.push(m)), null);
    assertEquals(warnings, [], "a missing file is not a warning");
  });
});

Deno.test("loadItemEmblems returns null for a directory that is not there", async () => {
  assertEquals(await loadItemEmblems(join(ROOT, "no-such-dir-here")), null);
});

Deno.test("loadItemEmblems gives all four weapon slots the one R emblem", async () => {
  await withDir(async (dir) => {
    await Deno.writeFile(join(dir, "powerup-r.gif"), posesGif());
    const out = await loadItemEmblems(dir);
    assert(out);
    assertEquals(Object.keys(out).map(Number).sort((a, b) => a - b), [
      0,
      1,
      2,
      3,
    ]);
    // Decoded once and shared, not re-cut per slot.
    assert(out[0] === out[1] && out[1] === out[2] && out[2] === out[3]);
    assertEquals(out[0].w, EMBLEM_CELL);
  });
});

Deno.test("loadItemEmblems warns past a corrupt GIF instead of throwing", async () => {
  await withDir(async (dir) => {
    // A file that passes the GIF magic but stops making sense after the
    // header: the decoder throws, and one bad letter must not cost the rest.
    const broken = new Uint8Array(14);
    broken.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 4, 0, 0, 0, 0]);
    broken[13] = 0x99;
    await Deno.writeFile(join(dir, "powerup-b.gif"), broken);
    await Deno.writeFile(join(dir, "powerup-s.gif"), posesGif());

    const warnings: string[] = [];
    const out = await loadItemEmblems(dir, (m) => warnings.push(m));
    assert(out);
    assertEquals(Object.keys(out), ["8"], "speed keeps its emblem");
    assertEquals(warnings.length, 1);
    assert(
      warnings[0].startsWith("powerup-b.gif:"),
      `names the bad file: ${warnings[0]}`,
    );
  });
});

Deno.test("loadItemEmblems warns past art too big for the cell", async () => {
  await withDir(async (dir) => {
    const big = buildGif(48, 48, [{
      rows: checker(20, 20),
      ox: 2,
      oy: 2,
      scale: 2,
    }]);
    await Deno.writeFile(join(dir, "powerup-f.gif"), big);
    const warnings: string[] = [];
    assertEquals(await loadItemEmblems(dir, (m) => warnings.push(m)), null);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes("no frame fits"), warnings[0]);
  });
});

Deno.test("loadItemEmblems defaults its warner, so a bad file is survivable", async () => {
  await withDir(async (dir) => {
    await Deno.writeFile(join(dir, "powerup-s.gif"), new Uint8Array([1, 2, 3]));
    // Not a GIF at all, and no onWarn passed: this must still resolve.
    assertEquals(await loadItemEmblems(dir), null);
  });
});

// ---------------------------------------------------------------------------
// The real art, when it is on the machine.
// ---------------------------------------------------------------------------

const ART = join(ROOT, EMBLEM_DIR);
const haveArt = await Deno.stat(ART).then((s) => s.isDirectory, () => false);
const gated = { ignore: !haveArt };
if (!haveArt) {
  console.log(`  (powerup emblems: skipped — no ${EMBLEM_DIR}/)`);
}

Deno.test(
  "every powerup GIF cuts to a 16x16 emblem inside 14x15",
  gated,
  async () => {
    for (const letter of ["s", "b", "f", "r"]) {
      const bytes = await Deno.readFile(join(ART, `powerup-${letter}.gif`));
      const emblem = emblemFromGif(bytes);
      assertEquals(emblem.w, EMBLEM_CELL, letter);
      assertEquals(emblem.h, EMBLEM_CELL, letter);
      assertEquals(emblem.rgba.length, EMBLEM_CELL * EMBLEM_CELL * 4, letter);
      const box = opaqueBox(emblem.rgba);
      assert(
        box.count > 40,
        `${letter}: the emblem is painted (${box.count} px)`,
      );
      assert(box.w <= 14, `${letter}: ${box.w} columns fit the folded pose`);
      assert(box.h <= 15, `${letter}: ${box.h} rows fit the folded pose`);
      assert(box.x0 >= 0 && box.x1 < EMBLEM_CELL, `${letter}: inside the cell`);
      assert(box.y0 >= 0 && box.y1 < EMBLEM_CELL, `${letter}: inside the cell`);
    }
  },
);

Deno.test(
  "the real art dresses seven of the nine item types",
  gated,
  async () => {
    const warnings: string[] = [];
    const out = await loadItemEmblems(ART, (m) => warnings.push(m));
    assert(out);
    assertEquals(warnings, []);
    assertEquals(
      Object.keys(out).map(Number).sort((a, b) => a - b),
      [0, 1, 2, 3, 5, 7, 8],
    );
    assert(!(4 in out) && !(6 in out), "barrier and score keep their squares");
    for (const frame of Object.values(out)) {
      assertEquals(frame.rgba.length, EMBLEM_CELL * EMBLEM_CELL * 4);
    }
  },
);
