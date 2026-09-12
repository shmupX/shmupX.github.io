// The community collection in the repo-root dev-fixtures/ — "Dezaemon Kids!/"
// and "Dezaemon+/" — is gitignored; every test here is skipped without it.
//
// What is asserted is what the traced layouts predict and what held on all
// 165 saves: for Dezaemon+ that the program's own group checksums verify (the
// strongest single check either format offers, because it pins every boundary
// in the 74-entry table at once), and for Dezaemon Kids! that the three
// byte-sum checksums verify and that the map, scroll and appear regions obey
// the constraints the play engine reads them under.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  KIDS_APPEAR_COLUMNS,
  KIDS_BLANK,
  KIDS_CELL_ALIGN,
  KIDS_CELL_COUNT,
  KIDS_CELL_MASK,
  KIDS_DATA_SIZE,
  KIDS_GRAPHICS_SIZE,
  KIDS_MAP_COLUMNS,
  KIDS_MAP_ROWS,
  KIDS_PRODUCT,
} from "../src/psx/kids.js";
import {
  PLUS_MAP_COLUMNS,
  PLUS_MAP_ROWS,
  PLUS_PRODUCT,
  PLUS_STAGES,
} from "../src/psx/plus.js";
import { parsePsxSav } from "../src/psx/index.js";

const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);

function savesUnder(folder) {
  const root = new URL(`${encodeURIComponent(folder)}/`, DEV_FIXTURES);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const url = new URL(
        `${encodeURIComponent(e.name)}${e.isDirectory ? "/" : ""}`,
        dir,
      );
      if (e.isDirectory) walk(url);
      else if (e.name.toLowerCase().endsWith(".sav")) out.push(url);
    }
  };
  walk(root);
  return out.sort((a, b) => a.href.localeCompare(b.href));
}

const KIDS = savesUnder("Dezaemon Kids!");
const PLUS = savesUnder("Dezaemon+");

Deno.test({
  name:
    "every Dezaemon Kids! card: one save, consistent directory, three checksums, sections at their fixed sizes",
  ignore: KIDS.length === 0,
  fn() {
    for (const url of KIDS) {
      const parsed = parsePsxSav(Deno.readFileSync(url));
      const label = fromFileUrl(url);
      assertEquals(parsed.container, "card", label);
      assertEquals(parsed.saves.length, 1, label);
      const save = parsed.saves[0];
      assertEquals(save.game, "kids", label);
      assertEquals(save.filename, KIDS_PRODUCT, label);
      assertEquals(save.errors, [], label);
      assertEquals(save.table?.consistent, true, label);
      assertEquals(save.checksums?.ok, true, label);
      assertEquals(save.graphics?.length, KIDS_GRAPHICS_SIZE, label);
      assertEquals(save.data?.length, KIDS_DATA_SIZE, label);
      assert(save.header?.title.startsWith("デザエモンＫｉｄｓ！"), label);
      assert(save.gameName !== null, label);
      assertEquals(save.hiScores?.length, 10, label);
    }
  },
});

Deno.test({
  name:
    "Kids! map chips never straddle a CG row or the cell bank, and the unread bits stay clear",
  ignore: KIDS.length === 0,
  fn() {
    let chips = 0;
    for (const url of KIDS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      const label = fromFileUrl(url);
      assertEquals(save.map.length, 6, label);
      for (const stage of save.map) {
        assertEquals(
          stage.words.length,
          KIDS_MAP_COLUMNS * KIDS_MAP_ROWS,
          label,
        );
        for (const word of stage.words) {
          if (word & KIDS_BLANK) continue;
          chips++;
          const cell = word & KIDS_CELL_MASK;
          // A chip draws cells n, n+1, n+8, n+9, so n starts a 2x2 group: even
          // column (bit 0 clear) and even row (bit 3 clear) of the CG page.
          // That also keeps the group inside its row of eight and inside the
          // 1024-cell bank.
          assertEquals(
            cell & KIDS_CELL_ALIGN,
            0,
            `${label}: chip ${cell} is not 2x2-aligned`,
          );
          assert(
            cell + 9 < KIDS_CELL_COUNT,
            `${label}: chip ${cell} runs off the bank`,
          );
          assertEquals(
            word & 0x1c00,
            0,
            `${label}: bits 10-12 set in ${word.toString(16)}`,
          );
        }
      }
    }
    assert(chips > 100_000, `only ${chips} chips seen`);
  },
});

Deno.test({
  name:
    "Kids! scroll nibbles stay inside the four speeds, and a stage places at most one boss",
  ignore: KIDS.length === 0,
  fn() {
    for (const url of KIDS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      const label = fromFileUrl(url);
      for (const stage of save.scroll) {
        assertEquals(stage.steps.length, 192, label);
        for (const step of stage.steps) {
          assert(step.nibble <= 3, `${label}: scroll nibble ${step.nibble}`);
        }
      }
      for (const stage of save.appear) {
        assertEquals(stage.bytes.length, KIDS_APPEAR_COLUMNS * 384, label);
        let bosses = 0;
        for (const b of stage.bytes) if ((b & 0xc0) === 0xc0) bosses++;
        assert(
          bosses <= 1,
          `${label}: stage ${stage.stage} places ${bosses} bosses`,
        );
        assertEquals(stage.boss === null, bosses === 0, label);
      }
    }
  },
});

Deno.test({
  name:
    "Kids! footprint marks resolve to the enemy that covers them, once the scroll direction is honoured",
  ignore: KIDS.length === 0,
  fn() {
    let marks = 0, resolved = 0;
    for (const url of KIDS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      for (const stage of save.appear) {
        marks += stage.marks.length;
        resolved += stage.marks.length - stage.orphanMarks;
      }
    }
    assert(marks > 100_000, `only ${marks} marks seen`);
    // The stragglers are cells a resized boss left behind: the editor erases
    // the old rectangle from a size it caches in RAM, which no save carries.
    const rate = resolved / marks;
    assert(
      rate > 0.995,
      `only ${(rate * 100).toFixed(2)}% of marks found an owner`,
    );
  },
});

Deno.test({
  name:
    "Kids! config names a background set and a BGM file that exist on the disc",
  ignore: KIDS.length === 0,
  fn() {
    for (const url of KIDS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      const label = fromFileUrl(url);
      const config = save.config;
      assertEquals(config.stages.length, 6, label);
      assert(config.stageCount >= 1 && config.stageCount <= 6, label);
      assert(config.soundBank <= 4, `${label}: sound bank ${config.soundBank}`);
      for (const stage of config.stages) {
        assert(
          stage.backgroundSet <= 38,
          `${label}: background set ${stage.backgroundSet}`,
        );
        assertEquals(
          stage.backgroundFile === null,
          stage.backgroundSet === 0,
          `${label}: stage ${stage.stage} background`,
        );
        assert([0, 0.25, 1, 4].includes(stage.scrollSpeed), label);
      }
      for (const entry of config.sound.slice(0, config.liveSoundEntries)) {
        if (entry.preset) continue;
        assertEquals(
          entry.file === null,
          entry.bgm === 0,
          `${label}: bgm ${entry.bgm}`,
        );
        assert(entry.bgm <= 99, `${label}: bgm number ${entry.bgm}`);
      }
    }
  },
});

Deno.test({
  name:
    "every Dezaemon+ card: one raw save whose twenty group checksums verify",
  ignore: PLUS.length === 0,
  fn() {
    for (const url of PLUS) {
      const parsed = parsePsxSav(Deno.readFileSync(url));
      const label = fromFileUrl(url);
      assertEquals(parsed.saves.length, 1, label);
      const save = parsed.saves[0];
      assertEquals(save.game, "plus", label);
      assertEquals(save.filename, PLUS_PRODUCT, label);
      assertEquals(save.errors, [], label);
      assertEquals(save.sizeOk, true, label);
      assert(save.header?.title.startsWith("デザエモン＋"), label);
      assertEquals(save.checksums?.bad, [], `${label}: checksum groups differ`);
      assertEquals(save.palettes?.length, 24, label);
      assertEquals(save.hiScores?.length, 20, label);
      assertEquals(save.stages?.length, PLUS_STAGES, label);
      assertEquals(save.sound?.length, 16, label);
    }
  },
});

Deno.test({
  name: "Dezaemon+ globals name real items, songs and buttons",
  ignore: PLUS.length === 0,
  fn() {
    for (const url of PLUS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      const label = fromFileUrl(url);
      const g = save.globals;
      assert(
        g.stageCount >= 1 && g.stageCount <= 6,
        `${label}: ${g.stageCount} stages`,
      );
      assertEquals(g.items.length, 7, label);
      for (const item of g.items) {
        assert(item.effect <= 11, `${label}: item effect ${item.effect}`);
        assertEquals(item.name === null, item.effect === 0, label);
      }
      assertEquals(g.bgm.length, 16, label);
      for (const slot of g.bgm) {
        assert(slot.song <= 50, `${label}: song ${slot.song}`);
      }
      // The two paired key-config actions must differ, as the menu enforces.
      const keys = save.settings.keys.map((k) => k.mask);
      assert(keys[0] !== keys[1], `${label}: keys 0 and 1 both ${keys[0]}`);
      assert(keys[2] !== keys[3], `${label}: keys 2 and 3 both ${keys[2]}`);
    }
  },
});

Deno.test({
  name:
    "Dezaemon+ map rows keep their first and last column empty, as the 256-px playfield needs",
  ignore: PLUS.length === 0,
  fn() {
    let rows = 0;
    for (const url of PLUS) {
      const save = parsePsxSav(Deno.readFileSync(url)).saves[0];
      const label = fromFileUrl(url);
      for (const stage of save.stages) {
        assertEquals(stage.mapRows.length, PLUS_MAP_ROWS, label);
        for (const row of stage.mapRows) {
          rows++;
          assertEquals(row.length, PLUS_MAP_COLUMNS, label);
          assert(
            row[0].blank,
            `${label}: stage ${stage.stage} draws in column 0`,
          );
          assert(
            row[PLUS_MAP_COLUMNS - 1].blank,
            `${label}: stage ${stage.stage} draws in the last column`,
          );
        }
      }
    }
    assert(rows > 10_000, `only ${rows} rows seen`);
  },
});
