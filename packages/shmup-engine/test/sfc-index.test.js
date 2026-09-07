// The sample save (the ROM's own default image) and the ROM that documents
// it. Both are gitignored: packages/shmup-engine/fixtures/dezaemon-sfc-sample.sav
// and dev-fixtures/<the ROM>.sfc. Everything here is gated on their presence.

import { assert, assertEquals } from "@std/assert";
import {
  compareWithRomDefault,
  isDezaemonRom,
  parseRomRegionTable,
  parseSfcSav,
  readRomHeader,
  regionTableMatches,
  rowContinuity,
  SFC_REGIONS,
  summarizeSfcSav,
} from "../src/sfc/index.js";
import {
  hasDevFixtures,
  hasFixtures,
  loadDevFixture,
  loadFixture,
} from "./_fixtures.js";

const SAMPLE = "dezaemon-sfc-sample.sav";
const ROM =
  "Kaite Tsukutte Asoberu - Dezaemon (EN) (1994) (Shoot Em Up) (Super Nintendo).sfc";

Deno.test({
  name:
    "the sample save parses cleanly: T.TABATA, checksum copy, blank graphics",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const parsed = parseSfcSav(loadFixture(SAMPLE));
    assertEquals(parsed.errors, []);
    assertEquals(parsed.size, 0x20000);
    assertEquals(parsed.isSfcSav, true);
    assertEquals(parsed.checkString, "T.TABATA");
    assertEquals(parsed.checksum?.equal, true);
    assertEquals(parsed.checksum?.words[0], 0xad52);
    assertEquals(parsed.segments.map((s) => s.blank), [
      false,
      false,
      true,
      true,
    ]);
    assertEquals(parsed.graphics?.present, true);
    assertEquals(parsed.graphics?.blank, true);
    assert(summarizeSfcSav(parsed).includes("checksum copy matches"));
  },
});

Deno.test({
  name:
    "the sample's palette rows: 22 colour rows, five identical defaults, a grey ramp",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const { palettes } = parseSfcSav(loadFixture(SAMPLE));
    assert(palettes);
    assertEquals(palettes.colorRowCount, 22);
    assertEquals(palettes.rows.slice(0, 22).every((r) => r.color), true);
    assertEquals(palettes.rows.slice(22).some((r) => r.color), false);
    assertEquals(palettes.rows[0].raw[0], 0x0017);
    const rowAt = (offset) => palettes.rows.find((r) => r.offset === offset);
    const first = rowAt(0x100);
    for (const offset of [0x120, 0x140, 0x160, 0x180]) {
      assertEquals(Array.from(rowAt(offset).raw), Array.from(first.raw));
    }
    // The blue-grey ramp at 0x2A0: every channel rises, blue on top.
    const ramp = rowAt(0x2a0).colors.slice(0, 9);
    assert(ramp.every((c) => c.b >= c.g && c.g >= c.r));
    for (let i = 1; i < ramp.length; i++) {
      const [a, b] = [ramp[i - 1], ramp[i]];
      assert(b.r >= a.r && b.g >= a.g && b.b >= a.b);
    }
  },
});

Deno.test({
  name:
    "the sample's tables: two factory hi-score tables, config words, 23 enemies, group shapes",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const parsed = parseSfcSav(loadFixture(SAMPLE));
    const scores = parsed.hiScores;
    assert(scores);
    const factory = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
    assertEquals(scores.map((h) => h.score), [...factory, ...factory]);
    assertEquals(scores.every((h) => h.name === "........"), true);
    const config = parsed.config;
    assert(config);
    assertEquals(config.titleType, 0x020a);
    assertEquals(config.mouseSpeed, 0);
    assertEquals(config.editBgm, 0);
    assertEquals(Array.from(config.bgmPatch), [
      0x11,
      0x12,
      0x13,
      0x14,
      0x15,
      0x16,
      0x16,
      0x17,
      0x18,
      0x16,
      0x19,
      0x1a,
      0x10,
      0x1c,
      0x1d,
      0x1b,
    ]);
    assertEquals(Array.from(config.keyConfig), [0x20, 0x08, 0x10, 0x20]);
    assertEquals(parsed.enemies?.filter((e) => !e.blank).length, 23);
    assertEquals(parsed.enemies?.[21].blank, true);
    const groups = parsed.groups;
    assert(groups);
    assertEquals(Array.from(groups.myShip[0].words), [
      0x0200,
      0x0201,
      0x0208,
      0x0209,
    ]);
    assertEquals(groups.myShip[0].kind, "chip");
    assertEquals(groups.boss[0].quads[0].kind, "strip");
    assertEquals(groups.title[0].entries[0].tile, 0x2a0);
    assertEquals(groups.ending.every((q) => q.kind === "empty"), true);
    assertEquals(groups.myShipOdr.every((q) => q.blank), true);
    assertEquals(parsed.maps?.[0].cells[1], 0x9c);
    assertEquals(parsed.maps?.every((m) => m.maxChip < 192), true);
    // The map width: 18 columns beats every other width in every stage.
    for (const m of parsed.maps ?? []) {
      const at18 = rowContinuity(m.cells, 18);
      for (const w of [8, 12, 16, 20, 24, 32, 64]) {
        assert(at18 > rowContinuity(m.cells, w), `stage ${m.stage}: ${w}`);
      }
    }
    assertEquals(parsed.appear?.every((a) => !a.blank), true);
  },
});

Deno.test({
  name:
    "the ROM's region table is what regions.js says, and its default image is the sample",
  ignore: !hasFixtures(SAMPLE) || !hasDevFixtures(ROM),
  fn() {
    const rom = loadDevFixture(ROM);
    const header = readRomHeader(rom);
    assertEquals(header.title, "DEZAEMON");
    assertEquals(header.sramSizeBytes, 0x20000);
    assertEquals(header.romSizeBytes, 0x80000);
    assertEquals(header.valid, true);
    assertEquals(isDezaemonRom(rom), true);
    const table = parseRomRegionTable(rom);
    assertEquals(table.length, SFC_REGIONS.length);
    assertEquals(regionTableMatches(table), {
      matches: true,
      missing: [],
      unexpected: [],
    });
    assertEquals(table[0].at, 0x66b8);
    const sav = loadFixture(SAMPLE);
    assertEquals(compareWithRomDefault(sav, rom).identical, true);
    const parsed = parseSfcSav(sav, { rom });
    assertEquals(parsed.errors, []);
    assertEquals(parsed.rom?.defaultImage.identical, true);
    assertEquals(parsed.rom?.regionTableMatches.matches, true);
  },
});
