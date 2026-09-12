// The disc's own sample games against the community saves of the same games.
//
// Dezaemon 2 ships six complete games as `SGM_*.CMP`, and each decompresses to
// 766,596 bytes = the eight sections raw, in the order they sit in memory
// (sec0-3, then 5, 4, 6, 7) with no table and no per-section compression —
// that happens at save time. Two of those games are also in the community
// collection, because the carts were dumped with the built-in samples still on
// them, so the same bytes can be reached two completely different ways:
//
//   disc:  ISO 9660 -> .CMP (u32le length + Okumura LZSS) -> slice by size
//   save:  cart dump -> de-interleave -> BUP directory -> block chain ->
//          0x6C section table -> eight LZSS streams
//
// Holding the two equal end to end is the strongest check either path has: it
// exercises the container, the block-chain reassembly, the section table, the
// decompressor over 766 KB, and the memory-order slicing all at once, and a
// single wrong bit anywhere shows up. Both the disc and the saves are
// community content and gitignored, so this skips when they are absent.

import { assert, assertEquals } from "@std/assert";
import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave, parseSectionTable } from "../src/payload-table.js";
import { decompress, decompressCmp, SECTION_SIZES } from "../src/decompress.js";
import {
  hasDevFixtures,
  hasDiscFile,
  loadDevFixture,
  loadDiscFile,
} from "./_fixtures.js";

/** The order the eight sections sit in on the disc, which is memory order. */
const MEMORY_ORDER = [0, 1, 2, 3, 5, 4, 6, 7];
const SGM_SIZE = SECTION_SIZES.reduce((a, b) => a + b, 0); // 766,596

/** A disc sample game, sliced into its eight sections by section index. */
function discSections(name) {
  const raw = Uint8Array.from(decompressCmp(loadDiscFile(name)));
  assertEquals(raw.length, SGM_SIZE, `${name} decompressed size`);
  const out = [];
  let at = 0;
  for (const index of MEMORY_ORDER) {
    out[index] = raw.subarray(at, at + SECTION_SIZES[index]);
    at += SECTION_SIZES[index];
  }
  return out;
}

/** A cart dump's eight sections, the whole way through the save pipeline. */
function saveSections(name) {
  const [save] = bup.parse(deinterleave(loadDevFixture(name))).filter(
    isGameSave,
  );
  assert(save, `${name}: no game save in the image`);
  const payload = save.payload.buffer;
  const table = parseSectionTable(payload);
  return table.sections.map((s) =>
    Uint8Array.from(decompress(payload.subarray(s.offset, s.offset + s.size)))
  );
}

const PAIRS = [
  ["SGM_RAMS.CMP", "Dez 2 - Ramsie.sav"],
  ["SGM_GUST.CMP", "Dez 2 - Biometal Gust.sav"],
];

for (const [cmp, sav] of PAIRS) {
  Deno.test({
    name:
      `${cmp} and ${sav} are the same game: all eight sections byte for byte`,
    ignore: !hasDiscFile(cmp) || !hasDevFixtures(sav),
    fn() {
      const disc = discSections(cmp);
      const save = saveSections(sav);
      assertEquals(save.length, 8, "section count");
      for (let i = 0; i < 8; i++) {
        assertEquals(save[i].length, SECTION_SIZES[i], `sec${i} size`);
        // Compare as strings of bytes so a mismatch reports where, not a
        // 400 KB diff.
        const at = save[i].findIndex((v, k) => v !== disc[i][k]);
        assertEquals(at, -1, `sec${i} differs first at offset ${at}`);
      }
    },
  });
}

Deno.test({
  name:
    "the factory New Game image is the Bio Metal Gust sample, byte for byte",
  ignore: !hasDiscFile("SGM_INIT.CMP") || !hasDiscFile("SGM_GUST.CMP"),
  fn() {
    const init = Uint8Array.from(decompressCmp(loadDiscFile("SGM_INIT.CMP")));
    const gust = Uint8Array.from(decompressCmp(loadDiscFile("SGM_GUST.CMP")));
    assertEquals(init.length, SGM_SIZE);
    assertEquals(init.findIndex((v, i) => v !== gust[i]), -1);
  },
});

Deno.test({
  name: "every disc sample game decompresses to the eight sections exactly",
  ignore: !hasDiscFile("SGM_DAIO.CMP"),
  fn() {
    for (
      const name of [
        "SGM_DAIO",
        "SGM_RAMS",
        "SGM_ELFI",
        "SGM_MIYA",
        "SGM_GUST",
        "SGM_INIT",
      ]
    ) {
      const raw = loadDiscFile(`${name}.CMP`);
      assert(raw, `${name}.CMP missing from the disc`);
      assertEquals(Uint8Array.from(decompressCmp(raw)).length, SGM_SIZE, name);
    }
  },
});

Deno.test({
  name:
    "SMP_BGM.BIN is sec6's size, and a save's songs are drawn from the disc's presets",
  ignore: !hasDiscFile("SMP_BGM.BIN") || !hasDevFixtures("Dez 2 - Ramsie.sav"),
  fn() {
    const bank = loadDiscFile("SMP_BGM.BIN");
    assertEquals(
      bank.length,
      SECTION_SIZES[6],
      "SMP_BGM.BIN is 24 songs of 4,228",
    );
    const SONG = 4228;
    assertEquals(bank.length / SONG, 24);
    const presets = new Set();
    for (let i = 1; i <= 73; i++) {
      const song = loadDiscFile(`M_DATA${String(i).padStart(2, "0")}.BIN`);
      if (song) presets.add(song.join(","));
    }
    assert(presets.size > 60, `only ${presets.size} preset songs found`);
    const sec6 = saveSections("Dez 2 - Ramsie.sav")[6];
    let matched = 0;
    for (let i = 0; i < 24; i++) {
      if (presets.has(sec6.subarray(i * SONG, (i + 1) * SONG).join(","))) {
        matched++;
      }
    }
    // Ramsie's author wrote some songs and took the rest off the shelf.
    assert(matched >= 10, `only ${matched} of 24 songs came from a preset`);
  },
});
