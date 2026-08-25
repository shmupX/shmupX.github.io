// Stage decoder tests — sec5 region map + background tilemaps.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  BG_COLS,
  BG_PARTS,
  BG_ROWS,
  decodeStageBackground,
  decodeStages,
  describePlacementId,
  PLACEMENT_COLS,
  placementColumn,
  placementColumnToEditor,
  SEC5_REGIONS,
} from "../src/decode/decode-stage.js";
import { SECTION_SIZES } from "../src/decompress.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("sec5 regions tile the section exactly, with no gaps", () => {
  const ordered = Object.values(SEC5_REGIONS).sort((a, b) =>
    a.offset - b.offset
  );
  let cursor = 0;
  for (const r of ordered) {
    assertStrictEquals(
      r.offset,
      cursor,
      "region must start where the previous one ended",
    );
    cursor = r.offset + r.count * r.stride;
  }
  assertStrictEquals(cursor, SECTION_SIZES[5]);
});

Deno.test("background map geometry: 14 x 768 = 48 parts of 16 rows per stage bank", () => {
  assertStrictEquals(BG_COLS * BG_ROWS * 2, SEC5_REGIONS.stageBanks.stride);
  assertStrictEquals(BG_PARTS, 48);
});

Deno.test({
  name: "ramsie decodes 5 stages of background art",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assertStrictEquals(decoded.confidence.backgrounds, "confirmed");
    assertStrictEquals(decoded.stageCount, 5);
    // parts used per stage, measured from the corpus (stages 5-9 unused)
    assertEquals(
      decoded.backgrounds.map((b) => b.partCount),
      [31, 29, 46, 32, 12, 0, 0, 0, 0, 0],
    );
    assert(decoded.regions.find((r) => r.name.startsWith("sec5")).decoded);
  },
});

Deno.test("tile words: 0xFFFF is empty, bit15/bit14 are flips, bits 0-9 the cell", () => {
  const sec5 = new Uint8Array(SECTION_SIZES[5]).fill(0xff);
  const put = (i, word) => {
    sec5[i * 2] = word >> 8;
    sec5[i * 2 + 1] = word & 0xff;
  };
  put(0, 0x0123); // plain cell 0x123
  put(1, 0x8123); // h-flipped
  put(2, 0x4123); // v-flipped
  put(3, 0xffff); // empty
  const bg = decodeStageBackground(sec5, 0);
  assertEquals(bg.tiles[0], { cell: 0x123, hflip: false, vflip: false });
  assertEquals(bg.tiles[1], { cell: 0x123, hflip: true, vflip: false });
  assertEquals(bg.tiles[2], { cell: 0x123, hflip: false, vflip: true });
  assertStrictEquals(bg.tiles[3], null);
  assertStrictEquals(bg.usedTiles, 3);
  assertStrictEquals(bg.partCount, 1); // all three live in part 0
});

Deno.test("placement ids map to 60 zako records, 8 items and 4 bosses", () => {
  // the 60 zako ids run 0x80-0x97, 0xA0-0xA7, 0xB0-0xBF, 0xC0-0xC3, 0xD0-0xD3, 0xE0-0xE3
  assertStrictEquals(describePlacementId(0x80).record, 0);
  assertStrictEquals(describePlacementId(0x97).record, 23);
  assertStrictEquals(describePlacementId(0xa0).record, 24);
  assertStrictEquals(describePlacementId(0xb0).record, 32);
  assertStrictEquals(describePlacementId(0xe3).record, 59);
  // every zako id maps to a distinct record, covering 0..59 exactly
  const records = new Set();
  for (let id = 0x80; id <= 0xff; id++) {
    const d = describePlacementId(id);
    if (d.kind === "zako") records.add(d.record);
  }
  assertStrictEquals(records.size, 60);
  assertEquals([...records].sort((a, b) => a - b), [...Array(60).keys()]);
  // items and bosses are not enemies
  assertEquals(describePlacementId(0xe8), {
    id: 0xe8,
    kind: "item",
    slot: 0,
    record: -1,
  });
  assertEquals(describePlacementId(0xf3), {
    id: 0xf3,
    kind: "boss",
    sizeClass: 3,
    record: -1,
  });
  // gaps between the ranges are unknown, not silently mapped
  assertStrictEquals(describePlacementId(0x98).kind, "unknown");
  assertStrictEquals(describePlacementId(0x30).kind, "unknown");
});

Deno.test({
  name: "ramsie stage 0: placed enemies plus exactly one boss",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const s0 = decoded.backgrounds[0].placement;
    assertStrictEquals(s0.cols, 20);
    assertStrictEquals(s0.rows, 768);
    assertStrictEquals(s0.objects.length, 270);
    assertStrictEquals(s0.boss.kind, "boss");
    assertStrictEquals(s0.boss.sizeClass, 2);
    assertStrictEquals(s0.boss.row, 423);
    // one boss per stage, and it appears late in the level
    for (const st of decoded.backgrounds.slice(0, decoded.stageCount)) {
      const bosses = st.placement.objects.filter((o) => o.kind === "boss");
      assert(bosses.length <= 1, "a stage never has more than one boss marker");
      if (bosses.length) assert(bosses[0].row > 200);
    }
    // objects come out in scroll order
    const rows = s0.objects.map((o) => o.row);
    assertEquals(rows, [...rows].sort((a, b) => a - b));
  },
});

Deno.test({
  name: "ramsie projects into an editor-ready roster and spawn rows",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    // One roster entry per placed (stage, record) pair, in stage-then-record
    // order, each carrying its own 18-byte definition.
    assert(
      decoded.enemies.length > 26,
      "ramsie uses more enemy types than one letter allows",
    );
    const order = decoded.enemies.map((e) => e.stage * 100 + e.record);
    assertEquals(order, [...order].sort((a, b) => a - b));
    for (const e of decoded.enemies) {
      assert(e.stage >= 0 && e.stage < decoded.stageCount);
      assert(e.record >= 0 && e.record < 60);
      assertStrictEquals(e.key, `${e.stage}:${e.record}`);
      assertStrictEquals(e.bytes.length, 18);
      assert(e.placements > 0);
    }
    assertStrictEquals(decoded.stages.length, decoded.stageCount);
    // stage 0 yields real spawn rows, earliest first, the save's own width
    const rows = decoded.stages[0].rows;
    assert(rows.length > 50);
    assertStrictEquals(decoded.stages[0].cols, PLACEMENT_COLS);
    for (const row of rows) {
      assertStrictEquals(row.length, PLACEMENT_COLS);
      assert(
        row.some((c) => c !== null),
        "a row is only emitted when it holds something",
      );
      for (const cell of row) {
        if (!cell) continue;
        assert(cell.enemy >= 0 && cell.enemy < decoded.enemies.length);
        // every spawn resolves to an enemy defined by ITS OWN stage
        assertStrictEquals(decoded.enemies[cell.enemy].stage, 0);
      }
    }
  },
});

Deno.test({
  name:
    "every placed enemy survives the projection — none collide, none vanish",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const { stages, stageCount } = decodeStages(
      decoded.sections[5].decompressed,
    );
    let placed = 0;
    for (let s = 0; s < stageCount; s++) {
      placed += stages[s].placement.objects.filter((o) =>
        o.kind === "zako"
      ).length;
    }
    const projected = decoded.stages.reduce(
      (n, st) =>
        n + st.rows.reduce((m, row) => m + row.filter(Boolean).length, 0),
      0,
    );
    assertStrictEquals(projected, placed);
  },
});

Deno.test({
  name: "each wave records the scroll row it came from, so pacing survives",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    for (const st of decoded.stages) {
      assertStrictEquals(st.waveRows.length, st.rows.length);
      assertEquals(st.waveRows, [...st.waveRows].sort((a, b) => a - b));
      assertStrictEquals(new Set(st.waveRows).size, st.waveRows.length);
    }
    // a stage's waves are genuinely unevenly spaced — the reason to keep them
    const gaps = new Set();
    const rows = decoded.stages[0].waveRows;
    for (let i = 1; i < rows.length; i++) gaps.add(rows[i] - rows[i - 1]);
    assert(gaps.size > 1, "stage 0 does not deal its waves on a fixed beat");
  },
});

Deno.test("a grid column IS the save's placement column", () => {
  // Nothing is folded, so two enemies can never share a cell — which is
  // exactly what the old 8-column binning could not promise.
  const seen = new Set();
  for (let col = 0; col < PLACEMENT_COLS; col++) {
    const e = placementColumn(col);
    assertStrictEquals(e, col);
    seen.add(e);
  }
  assertStrictEquals(seen.size, PLACEMENT_COLS);
  // and a byte outside the grid cannot index off the row
  assertStrictEquals(placementColumn(-1), 0);
  assertStrictEquals(placementColumn(99), PLACEMENT_COLS - 1);
});

Deno.test("the legacy 8-column binning is still available and unchanged", () => {
  for (let col = 0; col < 20; col++) {
    const e = placementColumnToEditor(col);
    assert(e >= 0 && e <= 7, `column ${col} -> ${e}`);
  }
  assertStrictEquals(placementColumnToEditor(3), 0);
  assertStrictEquals(placementColumnToEditor(16), 7);
  let prev = -1;
  for (let col = 3; col <= 16; col++) {
    const e = placementColumnToEditor(col);
    assert(e >= prev);
    prev = e;
  }
});

Deno.test("a save with no placed objects reports zero stages", () => {
  // 0xFF fills the background banks (0xFFFF = empty tile); the placement
  // grid is byte-valued, so an empty grid is zero-filled.
  const sec5 = new Uint8Array(SECTION_SIZES[5]).fill(0xff);
  const pl = SEC5_REGIONS.placement;
  sec5.fill(0, pl.offset, pl.offset + pl.count * pl.stride);
  const { stages, stageCount } = decodeStages(sec5);
  assertStrictEquals(stageCount, 0);
  assert(stages.every((s) => s.empty && s.usedTiles === 0));
  assert(stages.every((s) => s.placement.objects.length === 0));
});
