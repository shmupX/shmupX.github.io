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
    // entries per stage, classes 0-2 then 3 and 4; stage 0's class-0 entry 0
    assertEquals(parsed.enemies?.map((e) => e.used), [20, 21, 21, 19, 22, 27]);
    assertEquals(
      parsed.enemies?.[0].classes.map((c) =>
        c.entries.filter((e) => !e.blank).length
      ),
      [8, 1, 5, 5, 1],
    );
    assertEquals(parsed.enemies?.[0].classes[0].entries[0].bytes, [
      0x00,
      0x0d,
      0x00,
      0x80,
      0xa1,
      0x00,
      0x00,
      0x00,
    ]);
    assertEquals(parsed.enemies?.[0].boss.blank, false);
    const groups = parsed.groups;
    assert(groups);
    // the ship sheet's first chips are the ROM's (sheet 2, rows 0-1), the last three the forced 0x3FC-0x3FE
    assertEquals(groups.myShip.slice(0, 4).map((c) => c.word), [
      0x200,
      0x201,
      0x208,
      0x209,
    ]);
    assertEquals(groups.myShip[0].rom, true);
    assertEquals(groups.myShip.slice(61).map((c) => c.word), [
      0x3fc,
      0x3fd,
      0x3fe,
    ]);
    assertEquals(groups.boss[0].chips[0].word, 0x0244);
    assertEquals(
      groups.boss[0].chips[2].hflip,
      true,
      "the sample's bosses mirror their halves",
    );
    assertEquals(groups.title[0].word, 0x02a0);
    assertEquals(groups.ending.every((c) => c.empty), true);
    assertEquals(groups.myShipOdr.every((r) => r.byte === 0), true);
    // stage 0's ODR: class 0's first quad names four frames, class 3's first two quads mirror
    const odr0 = groups.enemyOdr[0].quads;
    assertEquals(odr0[0].refs.map((r) => r.slot), [0x12, 0x15, 0x2a, 0x2b]);
    assertEquals(odr0[48].refs.map((r) => [r.slot, r.hflip]), [
      [0x17, false],
      [0x17, true],
      [0x08, false],
      [0x08, true],
    ]);
    assertEquals(odr0.filter((q) => !q.blank).length, 26);
    // the map: row 0 cell 1 names slot 0x1c h-flipped (the old 0x9c); every slot is under 128
    assertEquals([parsed.maps?.[0].slots[1], parsed.maps?.[0].hflips[1]], [
      0x1c,
      1,
    ]);
    assertEquals(parsed.maps?.every((m) => m.maxSlot < 128), true);
    assertEquals(parsed.maps?.map((m) => m.used), [
      1736,
      1736,
      1792,
      1456,
      673,
      570,
    ]);
    assertEquals(parsed.appear?.map((a) => a.used), [
      136,
      100,
      133,
      181,
      177,
      161,
    ]);
    assertEquals(parsed.appear?.[0].lines[2], 66);
    assertEquals(parsed.appear?.[0].records[66].spawns, [{
      column: 9,
      klass: 3,
      entry: 0,
    }]);
    assertEquals(
      parsed.appear?.[0].records[1].blank,
      false,
      "record 1 is the END code",
    );
    assertEquals(
      Array.from(parsed.appear?.[0].records[1].bytes),
      new Array(14).fill(0xff),
    );
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
