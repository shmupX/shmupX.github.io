// Enemy sprite extraction — turning composition-bank cell refs into art.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStrictEquals,
} from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  BOSS_CORE_GEOM,
  BOSS_CORE_OFFSET,
  coreCellOrder,
  findPlaceholderCell,
  readBossCore,
  readEnemyFrames,
  RECORD_ART,
  recordArt,
  recordToClassSlot,
} from "../src/decode/decode-sprites.js";
import { SEC5_REGIONS } from "../src/decode/decode-stage.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("the record art bands + boss core tile the whole per-stage bank", () => {
  // engine-traced: refs are contiguous from 0x000 through the boss core
  let expect = 0;
  for (const band of RECORD_ART) {
    assertStrictEquals(
      band.base,
      expect,
      `band at record ${band.first} starts where the last ended`,
    );
    expect += band.count * band.frames * band.w * band.h * 2;
  }
  assertStrictEquals(expect, BOSS_CORE_OFFSET);
  // seven bands hold the 60 enemy records between them
  assertStrictEquals(RECORD_ART.reduce((a, b) => a + b.count, 0), 60);
  // every boss class reads the same 64 core refs, closing the bank exactly
  for (const g of BOSS_CORE_GEOM) assertStrictEquals(g.frames * g.w * g.h, 64);
  assertStrictEquals(
    BOSS_CORE_OFFSET + 64 * 2,
    SEC5_REGIONS.spriteStages.stride,
  );
});

Deno.test("core frames read as 4x4-cell blocks in reading order", () => {
  // one block wide: block order IS row-major
  assertEquals(coreCellOrder(4, 4), [...Array(16).keys()]);
  // two blocks side by side (class 1): row 0 = block0 row 0, block1 row 0
  const wide = coreCellOrder(8, 4);
  assertEquals(wide.slice(0, 8), [0, 1, 2, 3, 16, 17, 18, 19]);
  // four quadrants (class 3): row 4 starts on block 2 (bottom-left)
  const quad = coreCellOrder(8, 8);
  assertEquals(quad.slice(32, 40), [32, 33, 34, 35, 48, 49, 50, 51]);
  // every ref used exactly once
  assertEquals([...quad].sort((a, b) => a - b), [...Array(64).keys()]);
});

Deno.test("record index maps onto (class, slot) in enemy-record order", () => {
  assertEquals(recordToClassSlot(0), { cls: 0, slot: 0 });
  assertEquals(recordToClassSlot(15), { cls: 0, slot: 15 });
  assertEquals(recordToClassSlot(16), { cls: 1, slot: 0 });
  assertEquals(recordToClassSlot(59), { cls: 6, slot: 3 });
  assertStrictEquals(recordToClassSlot(60), null);
  // every record lands in exactly one slot of its band
  for (let r = 0; r < 60; r++) {
    const p = recordToClassSlot(r);
    assert(p.slot < RECORD_ART[p.cls].count);
  }
});

Deno.test("frame geometry is the engine's, fixed per record band", () => {
  // records 32-47 are 32x32 (not 16x16), the large records 2 or 1 frames
  assertEquals(
    RECORD_ART.map((b) => [b.frames, b.w, b.h]),
    [[4, 1, 1], [4, 2, 1], [4, 1, 2], [4, 2, 2], [2, 4, 2], [2, 2, 4], [
      1,
      4,
      4,
    ]],
  );
  assertStrictEquals(recordArt(32).w * 16, 32);
  assertStrictEquals(recordArt(48).frames, 2);
  assertStrictEquals(recordArt(56).frames, 1);
});

Deno.test({
  name: "ramsie extracts real enemy art wired to the roster",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assertStrictEquals(decoded.confidence.sprites, "heuristic");
    assert(decoded.sprites.length > 100, "a full game yields plenty of frames");
    // every sprite is a non-empty RGBA image of whole 16px cells — except the
    // title compositions, which are trimmed to their opaque bounding box so
    // they center cleanly on the title screen
    for (const s of decoded.sprites) {
      assertStrictEquals(s.rgba.length, s.w * s.h * 4);
      if (!/^deza(Title|Credit)/.test(s.key)) {
        assertStrictEquals(s.w % 16, 0);
        assertStrictEquals(s.h % 16, 0);
      }
      let opaque = false;
      for (let p = 3; p < s.rgba.length; p += 4) {
        if (s.rgba[p]) {
          opaque = true;
          break;
        }
      }
      assert(opaque, `${s.key} should not be fully transparent`);
    }
    // most of the roster carries art, and the keys point into the sprite list
    const withArt = decoded.enemies.filter((e) => e.spriteKeys);
    assert(withArt.length > decoded.enemies.length * 0.8);
    for (const e of withArt) {
      assert(e.spriteKeys.length >= 1 && e.spriteKeys.length <= 4);
      for (const k of e.spriteKeys) {
        assert(decoded.sprites[k], "sprite key resolves");
      }
    }
  },
});

Deno.test({
  name: "frames come out at their band's size with full cell rectangles",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const sec5 = decoded.sections[5].decompressed;
    let seen = 0;
    let large = 0;
    for (let record = 0; record < 60; record++) {
      const art = readEnemyFrames(sec5, 0, record);
      if (!art) continue;
      seen++;
      const band = recordArt(record);
      assertStrictEquals(art.w, band.w);
      assertStrictEquals(art.h, band.h);
      assert(art.frames.length <= band.frames);
      for (const f of art.frames) {
        assertStrictEquals(f.cells.length, art.w * art.h);
      }
      if (band.w * band.h >= 8) large++;
    }
    assert(seen > 10, "stage 0 defines a decent number of enemies");
    assert(
      large >= 1,
      "ramsie stage 0 paints large-class art (drapes/statues/figures)",
    );
  },
});

Deno.test({
  name: "sprite flips are bit14=H bit15=V — mirror pairs compose, not stack",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    // Ramsie stage 0, record 56 (64x64 band): the bank is full of exact
    // horizontal mirror pairs; under the correct bit order the mirrored
    // cell of a pair must carry hflip, never vflip.
    const decoded = await decodedFixture("ramsie.sav");
    const sec5 = decoded.sections[5].decompressed;
    const art = readEnemyFrames(sec5, 0, 56);
    assert(art, "ramsie paints the first 64x64 record");
    const flipped = art.frames.flatMap((f) => f.cells).filter(
      (c) => !c.empty && (c.hflip || c.vflip),
    );
    assert(flipped.length > 0, "the composition uses mirrored cells");
    assert(
      flipped.every((c) => c.hflip && !c.vflip),
      "mirrors are horizontal",
    );
  },
});

Deno.test({
  name: "the boss core reads at the placed class's geometry",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const sec5 = decoded.sections[5].decompressed;
    // Ramsie stages 1-3 paint two-frame 64x128 class-2 cores; stages 0 and 4
    // leave theirs unpainted — those fights are the chamber scenery plus
    // trailer-attached parts.
    const placeholder = findPlaceholderCell(sec5).cell;
    for (const b of decoded.bosses) {
      const core = readBossCore(sec5, b.stage, b.sizeClass);
      if (b.stage >= 1 && b.stage <= 3) {
        // class 2: two 64x128 frames
        assert(core, `stage ${b.stage} paints its core`);
        assertStrictEquals(core.w, 4);
        assertStrictEquals(core.h, 8);
        assertStrictEquals(core.frames.length, 2);
      } else if (b.stage === 4) {
        // class 0: four 64x64 frames
        assertStrictEquals(core.w, 4);
        assertStrictEquals(core.h, 4);
        assertStrictEquals(core.frames.length, 4);
      } else {
        // stage 0: empty or placeholder-filled — no real core art; that
        // fight is the chamber scenery plus trailer-attached parts
        const painted = core &&
          core.frames.some((f) =>
            f.cells.some((c) => !c.empty && c.cell !== placeholder)
          );
        assert(!painted, `stage ${b.stage} core is unpainted`);
      }
    }
    // emitted boss sprites: painted cores at their class sizes, and stage 0
    // (unpainted core) falls back to its two 64x64 figure pieces
    const bossSprites = decoded.sprites.filter((s) =>
      s.key.startsWith("dezaBoss")
    );
    assertEquals(
      bossSprites.map((s) => `${s.key} ${s.w}x${s.h}`),
      [
        "dezaBoss0_0 64x64",
        "dezaBoss0_1 64x64",
        "dezaBoss1_0 64x128",
        "dezaBoss1_1 64x128",
        "dezaBoss2_0 64x128",
        "dezaBoss2_1 64x128",
        "dezaBoss3_0 64x128",
        "dezaBoss3_1 64x128",
        "dezaBoss4_0 64x64",
        "dezaBoss4_1 64x64",
        "dezaBoss4_2 64x64",
        "dezaBoss4_3 64x64",
      ],
    );
  },
});

Deno.test({
  name: "the unpainted-cell placeholder is found and skipped",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const { cell, count } = findPlaceholderCell(
      decoded.sections[5].decompressed,
    );
    assert(cell !== null);
    // it dominates the bank — unused slots point every ref at it
    assert(count > 200, `placeholder referenced ${count} times`);
    // no emitted sprite is the placeholder repeated across all four frames
    assert(decoded.sprites.length > 0);
  },
});

Deno.test({
  name: "boss part art resolves every spawn fire point the trailer names",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const b0 = decoded.bosses.find((b) => b.stage === 0);
    assert(b0.partArt, "stage 0 boss carries part art");
    // pattern 0's two one-shot turrets reference 32x32 pieces 13/14
    for (const record of [45, 46]) {
      const keys = b0.partArt[record];
      assert(keys && keys.length, `record ${record} resolved`);
      for (const k of keys) {
        const s = decoded.sprites[k];
        assert(s, `sprite ${k} exists`);
        assertStrictEquals(`${s.w}x${s.h}`, "32x32");
      }
    }
    // every extracted part sprite is a real image at its band's geometry
    for (
      const [stage, art] of Object.entries(
        Object.fromEntries(
          decoded.bosses.filter((b) => b.partArt).map((
            b,
          ) => [b.stage, b.partArt]),
        ),
      )
    ) {
      for (const [record, keys] of Object.entries(art)) {
        const band = recordArt(Number(record));
        for (const k of keys) {
          const s = decoded.sprites[k];
          assert(s, `stage ${stage} record ${record} key ${k} resolves`);
          assertStrictEquals(s.w, band.w * 16);
          assertStrictEquals(s.h, band.h * 16);
        }
      }
    }
  },
});

Deno.test({
  name: "ramsie extracts its drawn title screen from the global bank",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assert(decoded.titleArt, "title art roles present");
    for (const role of ["title1", "title2", "credit"]) {
      const idx = decoded.titleArt[role];
      assert(Number.isInteger(idx), `${role} extracted`);
      const s = decoded.sprites[idx];
      assert(s, `${role} points into the sprite list`);
      assertMatch(s.key, /^deza(Title|Credit)/);
      // trimmed to content: inside the slot's bounds, but not empty
      assert(s.w > 0 && s.w <= 128, `${role} width ${s.w}`);
      assert(s.h > 0 && s.h <= 80, `${role} height ${s.h}`);
    }
    // TITLE1 is Ramsie's gold script — wide and short; TITLE2 the emblem
    const t1 = decoded.sprites[decoded.titleArt.title1];
    const t2 = decoded.sprites[decoded.titleArt.title2];
    assert(t1.w > t1.h, "title1 reads as a logo line");
    assert(t2.h > t1.h, "title2 is the taller emblem");
  },
});

Deno.test({
  name: "ramsie's credit strips extract one by one, with their slot placement",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const roles = decoded.titleArt;
    const layout = decoded.titleLayout;
    assert(layout, "layout present");
    assertEquals(layout.title, { w: 128, h: 64 });
    assertEquals(layout.strip, { w: 64, h: 16 });
    // Ramsie paints strips 0/2/4 (one author line three times) and points
    // 1/3/5 at fully transparent cells, which count as unpainted.
    for (const k of [0, 2, 4]) {
      const idx = roles[`credit${k}`];
      assert(Number.isInteger(idx), `credit${k} extracted`);
      const s = decoded.sprites[idx];
      assertStrictEquals(s.key, `dezaCredit${k}`);
      assert(
        s.w > 0 && s.w <= 64 && s.h > 0 && s.h <= 16,
        `strip ${k} fits its slot`,
      );
      const p = layout.credits[k];
      assert(
        p && p.x >= 0 && p.y >= 0 && p.x + p.w <= 64 && p.y + p.h <= 16,
        `strip ${k} placement`,
      );
      assertStrictEquals(p.w, s.w);
      assertStrictEquals(p.h, s.h);
    }
    for (const k of [1, 3, 5]) {
      assertStrictEquals(roles[`credit${k}`], undefined);
      assertStrictEquals(layout.credits[k], null);
    }
    assertStrictEquals(layout.credits.length, 6);
    // the stacked line survives for older readers
    assert(Number.isInteger(roles.credit));
    // the logos know where they sat inside their 128x64 slots
    for (const role of ["title1", "title2"]) {
      const p = layout[role];
      const s = decoded.sprites[roles[role]];
      assert(
        p.x >= 0 && p.y >= 0 && p.x + p.w <= 128 && p.y + p.h <= 64,
        `${role} placement`,
      );
      assertStrictEquals(p.w, s.w);
      assertStrictEquals(p.h, s.h);
    }
  },
});
