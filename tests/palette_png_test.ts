// static/palette.png — Dezaemon 2's 288-colour editor palette, served at
// https://codemonkey.games/palette.png, one pixel per entry (1 x 288). Nothing
// regenerates it in CI, so this guards the committed file against the engine
// table it is built from (`deno task deza:palette`), and the table against
// the one thing that pins it: rows 0-11 are the 12 preset palettes every save
// carries in its sec4, byte for byte.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { decodePng } from "../lib/ps2/png.ts";
import * as deza from "../packages/shmup-engine/mod.js";
import {
  cellsToIndexed,
  DEZA2_CG_COLORS,
  DEZA2_PALETTE_SIZE,
  DEZA2_PALETTE_WORDS,
  deza2PaletteBand,
  deza2PaletteRgb,
  indexedToCells,
  nearestPaletteIndex,
  paletteBankWords,
  paletteWordsFromRgba,
  rgb8ToRgb555,
} from "../packages/shmup-engine/src/palette/deza2-palette.js";

const PNG = new URL("../static/palette.png", import.meta.url);
const FIXTURE = new URL(
  "../dev-fixtures/Dez 2 - Chohsoku Stringer.sav",
  import.meta.url,
);

Deno.test("palette.png is 1 x 288 and round-trips to the engine table", async () => {
  const png = await decodePng(await Deno.readFile(PNG));
  assertStrictEquals(png.width, 1);
  assertStrictEquals(png.height, DEZA2_PALETTE_SIZE);
  const words = paletteWordsFromRgba(png.data);
  assertEquals(words, [...DEZA2_PALETTE_WORDS].map((w) => w & 0x7fff));
});

Deno.test("the table is 18 rows: 12 system, 4 user, 2 ui", () => {
  assertStrictEquals(DEZA2_PALETTE_WORDS.length, 288);
  assertStrictEquals(deza2PaletteBand(0), "system");
  assertStrictEquals(deza2PaletteBand(191), "system");
  assertStrictEquals(deza2PaletteBand(192), "user");
  assertStrictEquals(deza2PaletteBand(255), "user");
  assertStrictEquals(deza2PaletteBand(256), "ui");
  assertStrictEquals(deza2PaletteBand(287), "ui");
  assertStrictEquals(deza2PaletteBand(288), null);
  // Index 0 is the transparent slot; the gray ramp (row 4) opens on white.
  assertStrictEquals(DEZA2_PALETTE_WORDS[0], 0);
  assertStrictEquals(DEZA2_PALETTE_WORDS[64], 0x7fff);
  const rgb = deza2PaletteRgb();
  assertEquals([rgb[64].r, rgb[64].g, rgb[64].b], [255, 255, 255]);
});

Deno.test("5 -> 8 -> 5 bit replication is lossless for every entry", () => {
  const rgb = deza2PaletteRgb();
  for (let i = 0; i < rgb.length; i++) {
    assertStrictEquals(
      rgb8ToRgb555(rgb[i].r, rgb[i].g, rgb[i].b),
      DEZA2_PALETTE_WORDS[i] & 0x7fff,
      `entry ${i}`,
    );
  }
});

Deno.test("the palette bank is sec4-shaped: system rows raw, user rows flagged", () => {
  const bank = paletteBankWords();
  assertStrictEquals(bank.length, DEZA2_CG_COLORS);
  assertStrictEquals(bank[1], DEZA2_PALETTE_WORDS[1]);
  assertStrictEquals(bank[191], DEZA2_PALETTE_WORDS[191]);
  // Disc user rows are empty except the 0x0021 end marker, which is stored
  // 0x8000|0x0021 the way a save stores a user colour.
  assertStrictEquals(bank[192], 0);
  assertStrictEquals(bank[207], 0x8021);
});

Deno.test("a sprite round-trips through CG cell order", () => {
  const w = 32, h = 16;
  const indexed = new Uint8Array(w * h);
  for (let i = 0; i < indexed.length; i++) indexed[i] = (i * 7) & 0xff;
  const cells = indexedToCells(indexed, w, h);
  // Cell 1 (right half) starts at byte 256 with the first row's pixels 16..31.
  assertEquals([...cells.subarray(256, 272)], [...indexed.subarray(16, 32)]);
  assertEquals(cellsToIndexed(cells, w, h), indexed);
});

Deno.test("nearest colour never lands on the transparent slot, and stays in CG range", () => {
  const rgb = deza2PaletteRgb();
  const black = nearestPaletteIndex(0, 0, 0, rgb);
  assert(black > 0 && black < DEZA2_CG_COLORS);
  const white = nearestPaletteIndex(255, 255, 255, rgb);
  assertStrictEquals(white, 64);
  const uiOnly = nearestPaletteIndex(255, 255, 255, rgb, { cgOnly: false });
  assertStrictEquals(uiOnly, 64);
});

Deno.test("the engine's flat surface exports the palette", () => {
  assertStrictEquals(
    (deza as Record<string, unknown>).DEZA2_PALETTE_WORDS,
    DEZA2_PALETTE_WORDS,
  );
});

// The one external fact behind the table: a save's 12 preset palettes are
// these first 192 words. Needs the dev-fixtures collection, so it skips on a
// bare checkout rather than failing.
Deno.test({
  name: "rows 0-11 are a save's preset palettes",
  ignore: !(await Deno.stat(FIXTURE).then(() => true, () => false)),
  async fn() {
    const d = deza as unknown as Record<string, CallableFunction>;
    const norm = await d.normalize(await Deno.readFile(FIXTURE));
    const entry = d.parse(norm.data).find((e: unknown) => d.isGameSave(e));
    const decoded = d.decodeSave(entry.payload.buffer);
    const rgb = deza2PaletteRgb();
    for (let p = 0; p < 12; p++) {
      for (let c = 0; c < 16; c++) {
        const save = decoded.cg.palettes[p].colors[c];
        const ours = rgb[p * 16 + c];
        assertEquals(
          [save.r, save.g, save.b],
          [ours.r, ours.g, ours.b],
          `palette ${p} colour ${c}`,
        );
      }
    }
  },
});
