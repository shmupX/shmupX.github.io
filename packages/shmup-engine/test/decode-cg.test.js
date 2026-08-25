// CG decoder tests — the confirmed graphics layer (art pages sec0-3 +
// palette bank sec4), locked against the two fixture games.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  cellIndexed,
  cellIsBlank,
  CG_PAGE_HEIGHT,
  CG_PAGE_WIDTH,
  decodeCgPage,
  decodePalettes,
  indexedToRgba,
} from "../src/decode/decode-cg.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test({
  name: "decodeSave exposes the CG layer with confirmed confidence",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assertStrictEquals(decoded.confidence.cg, "confirmed");
    assertStrictEquals(decoded.cg.pages.length, 4);
    assertStrictEquals(decoded.cg.palettes.length, 16);
    for (const page of decoded.cg.pages) {
      assertStrictEquals(page.width, CG_PAGE_WIDTH);
      assertStrictEquals(page.height, CG_PAGE_HEIGHT);
      assertStrictEquals(page.indexed.length, 65536);
      assertStrictEquals(page.rgba.length, 65536 * 4);
    }
    // the CG layer marks sec0-4 decoded in the region list
    for (const i of [0, 1, 2, 3, 4]) {
      assert(decoded.regions[i].decoded, `sec${i} should be decoded`);
    }
    // sec7 (3D models) is the only section with no decoder yet
    assertStrictEquals(decoded.regions[7].decoded, false);
  },
});

Deno.test({
  name: "palette bank: 16x16 u16be RGB555, preset rows shared across games",
  ignore: !hasFixtures("ramsie.sav", "mucha-kucha.sav"),
  async fn() {
    const ramsie = await decodedFixture("ramsie.sav");
    const mucha = await decodedFixture("mucha-kucha.sav");
    // preset palette 4 is the engine's grayscale ramp, white first
    const gray = ramsie.cg.palettes[4].colors;
    assertEquals(gray.slice(0, 4).map((c) => c.raw), [
      0x7fff,
      0x7bde,
      0x739c,
      0x6b5a,
    ]);
    assertEquals([gray[0].r, gray[0].g, gray[0].b], [255, 255, 255]);
    // rows 0-11 (the "192 system colors") are identical between the two games
    // apart from the per-game word at offset 0
    for (let p = 0; p < 12; p++) {
      for (let c = 0; c < 16; c++) {
        if (p === 0 && c === 0) continue;
        assertStrictEquals(
          ramsie.cg.palettes[p].colors[c].raw,
          mucha.cg.palettes[p].colors[c].raw,
          `preset color ${p}/${c} differs between games`,
        );
      }
    }
  },
});

Deno.test("RGB555 decodes red from the LOW bits", () => {
  const bank = new Uint8Array(512);
  bank[0] = 0x00;
  bank[1] = 0x1f; // pure red
  bank[2] = 0x03;
  bank[3] = 0xe0; // pure green
  bank[4] = 0x7c;
  bank[5] = 0x00; // pure blue
  const [pal0] = decodePalettes(bank);
  assertEquals([pal0.colors[0].r, pal0.colors[0].g, pal0.colors[0].b], [
    255,
    0,
    0,
  ]);
  assertEquals([pal0.colors[1].r, pal0.colors[1].g, pal0.colors[1].b], [
    0,
    255,
    0,
  ]);
  assertEquals([pal0.colors[2].r, pal0.colors[2].g, pal0.colors[2].b], [
    0,
    0,
    255,
  ]);
});

Deno.test("page de-celling puts cell N at the right pixels (8 cells per row)", () => {
  const section = new Uint8Array(65536);
  // cell 17 sits at page row 2, col 1; mark its local pixel (3, 2)
  section[17 * 256 + 2 * 16 + 3] = 0xab;
  const indexed = decodeCgPage(section);
  assertStrictEquals(
    indexed[(2 * 16 + 2) * CG_PAGE_WIDTH + (1 * 16 + 3)],
    0xab,
  );
  // exactly one nonzero pixel total
  assertStrictEquals(indexed.reduce((n, v) => n + (v !== 0), 0), 1);
});

Deno.test("indexedToRgba: byte 0x00 transparent, others opaque via palette", () => {
  const bank = new Uint8Array(512);
  bank[(0x10 + 0x02) * 2] = 0x00; // palette 1 color 2 = pure red
  bank[(0x10 + 0x02) * 2 + 1] = 0x1f;
  const palettes = decodePalettes(bank);
  const rgba = indexedToRgba(Uint8Array.from([0x00, 0x12]), palettes);
  assertEquals([...rgba.slice(0, 4)], [0, 0, 0, 0]);
  assertEquals([...rgba.slice(4, 8)], [255, 0, 0, 255]);
});

Deno.test({
  name: "cell helpers address the 1024-cell space across four pages",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const sections = decoded.sections.slice(0, 4).map((s) => s.decompressed);
    // ramsie page usage measured from the corpus: 248/252/252/243 cells
    const used = [0, 1, 2, 3].map((p) => {
      let n = 0;
      for (let c = 0; c < 256; c++) {
        if (!cellIsBlank(sections, p * 256 + c)) n++;
      }
      return n;
    });
    assertEquals(used, [248, 252, 252, 243]);
    assertStrictEquals(
      cellIndexed(sections, 256).byteOffset,
      sections[1].byteOffset,
    );
  },
});
