// The 256-entry appearance script table (enemy record byte 0) and the boss
// arrival/death selectors — both extracted from the retail engine, so these
// tests pin the extraction rather than re-deriving it.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  APPEARANCE_CLASSES,
  APPEARANCE_FLAGS,
  APPEARANCE_SCRIPTS,
  appearanceScript,
  RIDES_SCROLL,
} from "../src/decode/appearance-table.js";
import {
  BOSS_ARRIVE_LATERAL,
  BOSS_ARRIVE_SCROLL,
  BOSS_PARK_LATERAL,
} from "../src/decode/decode-boss.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("the appearance table covers all 256 ids with well-formed rows", () => {
  assertStrictEquals(APPEARANCE_SCRIPTS.length, 256);
  assertStrictEquals(APPEARANCE_CLASSES.length, 256);
  let rows = 0;
  for (let id = 0; id < 256; id++) {
    const script = APPEARANCE_SCRIPTS[id];
    assert(script.length > 0, `id ${id} has rows`);
    for (const row of script) {
      assertStrictEquals(row.length, 5, `id ${id} row width`);
      for (const v of row) {
        assert(Number.isInteger(v) && v >= -32768 && v <= 65535);
      }
      rows++;
    }
  }
  assertStrictEquals(rows, 1206);
  // 208 scripted ids; the rest are the six hardcoded special classes
  assertStrictEquals(APPEARANCE_CLASSES.filter((c) => c === 0x30).length, 208);
});

Deno.test("appearance 0 is the archetypal sit-on-the-map enemy", () => {
  const s = appearanceScript(0);
  assertStrictEquals(s.scripted, true);
  assertStrictEquals(s.rows.length, 1);
  const row = s.rows[0];
  assertStrictEquals(row.dur, 32767); // hold ~forever
  assertStrictEquals(row.angle, 270); // 0xC000 = straight down
  assertStrictEquals(row.amp, 0); // ...but at zero speed
  assertStrictEquals(row.ridesScroll, true); // so it rides the background
  assertStrictEquals(row.advance, false);
});

Deno.test("velocity-suppress flags are rare, which is what makes the scripts move", () => {
  // Bits 5/6 SUPPRESS the drift components; if they enabled them instead,
  // almost every choreography in the table would be motionless.
  let reach = 0;
  for (let id = 0; id < 256; id++) {
    for (const row of APPEARANCE_SCRIPTS[id]) {
      if (row[4] & (APPEARANCE_FLAGS.VEL_COS | APPEARANCE_FLAGS.VEL_SIN)) {
        reach++;
        break;
      }
    }
  }
  assert(
    reach <= 24,
    `only a handful of scripts suppress a component, got ${reach}`,
  );
  // and a third of the table carries a real drift amplitude
  const moving = APPEARANCE_SCRIPTS.filter((rows) =>
    rows.some((r) => (r[3] & 0x7fff) > 0)
  );
  assert(
    moving.length > 80,
    `most scripts carry an amplitude, got ${moving.length}`,
  );
});

Deno.test("the rides-scroll bit survives into the compact table", () => {
  const riding = APPEARANCE_SCRIPTS.flat().filter((r) =>
    (r[3] & RIDES_SCROLL) !== 0
  );
  assertStrictEquals(riding.length, 40);
});

Deno.test({
  name: "ramsie's enemies carry their entry scripts through the mapper",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { mapSaveToGame } = await import("../src/map-to-game.js");
    const d = await decodedFixture("ramsie.sav");
    const { gameJson } = mapSaveToGame(d);
    const recs = Object.values(gameJson.enemyData).filter((r) =>
      r.dezaemon && r.dezaemon.entry
    );
    assert(
      recs.length > 100,
      `most enemies carry an entry, got ${recs.length}`,
    );
    for (const r of recs) {
      const e = r.dezaemon.entry;
      if (e.rows) {
        assert(Array.isArray(e.rows) && e.rows.length > 0);
        assertEquals(e.rows[0].length, 5);
      } else {
        // a special-AI appearance ships its class instead of rows
        assert(e.objectClass >= 0x31 && e.objectClass <= 0x36);
      }
    }
  },
});

Deno.test({
  name: "ramsie's bosses decode their arrival and death selectors",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    const bosses = d.bosses.filter((b) => b.behavior);
    assert(bosses.length > 0);
    for (const b of bosses) {
      const a = b.behavior.arrival;
      assert(BOSS_ARRIVE_LATERAL.includes(a.lateral));
      assertStrictEquals(typeof a.defaultEntry, "boolean");
      // with no scroll preset the boss starts above the screen and rides in
      if (a.defaultEntry) {
        assert(
          a.scroll < 0,
          `default entry starts off-screen, got ${a.scroll}`,
        );
      }
      const x = b.behavior.dying;
      if (x.lateral !== null) {
        assert(BOSS_ARRIVE_LATERAL.includes(x.lateral) || x.lateral === 336);
      }
    }
    // Stage 1's boss (b6 = 0x31) zooms in from just above the screen at the
    // park's lateral centre, and (b7 = 0x33) drifts off the bottom as it
    // dies. Low-nibble FX bits: 0 = zoom, 1 = its direction, 2 = spin,
    // 3 = its direction — so 0x31 is a zoom, not a spin.
    const s1 = bosses.find((b) => b.stage === 1);
    if (s1) {
      assertStrictEquals(s1.behavior.arrive, 0x31);
      assertStrictEquals(s1.behavior.arrival.zoom, true);
      assertStrictEquals(s1.behavior.arrival.spin, false);
      assertStrictEquals(s1.behavior.arrival.defaultEntry, false);
      assertStrictEquals(s1.behavior.arrival.lateral, BOSS_PARK_LATERAL);
      assertStrictEquals(s1.behavior.dying.scroll, BOSS_ARRIVE_SCROLL[1]); // 280 = off the bottom
      assertStrictEquals(s1.behavior.dying.zoom, true);
    }
  },
});
