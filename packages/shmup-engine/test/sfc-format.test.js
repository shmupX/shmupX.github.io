// A formatted image: the magic, the factory tables, the embedded sound, and
// the regions the sample shares with every other save.

import { assert, assertEquals } from "@std/assert";
import { formatSfcSram, writeHiScore } from "../src/sfc/sfc-format.js";
import { parseSfcSav } from "../src/sfc/index.js";
import { verifySfcChecksums } from "../src/sfc/checksum.js";
import { REGION } from "../src/sfc/regions.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const SAMPLE = "dezaemon-sfc-sample.sav";

Deno.test("a formatted image parses as an empty Dezaemon save whose checksums verify", () => {
  const bytes = formatSfcSram();
  assertEquals(bytes.length, 0x20000);
  const save = parseSfcSav(bytes);
  assertEquals(save.isSfcSav, true);
  assertEquals(save.errors, []);
  assertEquals(save.checksum.equal, true);
  assertEquals(verifySfcChecksums(bytes).ok, true);
  assertEquals(
    save.palettes.colorRowCount,
    22,
    "rows 22-23 are the picker rows, bit 15 set",
  );
  assertEquals(save.maps.map((m) => m.used), [0, 0, 0, 0, 0, 0]);
  assertEquals(save.hiScores[0].score, 1000);
  assertEquals(save.hiScores[9].score, 100);
  assertEquals(save.hiScores[10].score, 1000);
  assertEquals(save.hiScores[19].name, "........");
  assertEquals(save.config.titleType, 0x020a);
  assertEquals(Array.from(save.config.keyConfig), [0x20, 0x08, 0x10, 0x20]);
  assertEquals(save.groups.ending.every((c) => c.empty), true);
  assertEquals(
    save.groups.map.every((g) => g.chips.every((c) => c.empty)),
    true,
  );
  assertEquals(save.groups.map[0].chips[0].word, 0x03ff);
  assertEquals(save.groups.map[0].chips[1].word, 0xffff);
  assertEquals(save.groups.myShip.slice(61).map((c) => c.word), [
    0x3fc,
    0x3fd,
    0x3fe,
  ]);
  assertEquals(
    save.scroll.every((s) =>
      s.speed.every((v) => v === 0x42) && s.effect[31] === 31 &&
      s.effect[32] === 0
    ),
    true,
  );
  assertEquals(save.enemies.every((e) => e.used === 0 && e.boss.blank), true);
  for (const st of save.appear) {
    assertEquals(Array.from(st.records[0].bytes), new Array(14).fill(0));
    assertEquals(Array.from(st.records[1].bytes), new Array(14).fill(0xff));
    assertEquals([st.used, st.spawns, st.blank], [0, 0, true]);
  }
  assertEquals(save.graphics.blank, true);
  // a written hi-score reads back
  writeHiScore(bytes, 0, { score: 123456, name: "ABC" });
  assertEquals(parseSfcSav(bytes).hiScores[0], {
    ...parseSfcSav(bytes).hiScores[0],
    score: 123456,
    name: "ABC     ",
  });
});

Deno.test({
  name:
    "the formatted image's fixed regions are the factory sample's, byte for byte",
  ignore: !hasFixtures(SAMPLE),
  fn() {
    const sample = loadFixture(SAMPLE);
    const bytes = formatSfcSram();
    const same = (region) => {
      for (let i = region.offset; i < region.end; i++) {
        assert(
          bytes[i] === sample[i],
          `${region.label} differs at 0x${i.toString(16)}`,
        );
      }
    };
    for (
      const r of [
        REGION.sound,
        REGION.bgmPatch,
        REGION.reserved0,
        REGION.reserved1,
        REGION.titleType,
        REGION.mouseSpeed,
        REGION.editBgm,
        REGION.keyConfig,
        REGION.hiScore,
        REGION.endingGroup,
        REGION.checkString,
      ]
    ) same(r);
    for (let i = REGION.palette.offset + 22 * 32; i < REGION.palette.end; i++) {
      assert(bytes[i] === sample[i], `picker row byte 0x${i.toString(16)}`);
    }
  },
});
