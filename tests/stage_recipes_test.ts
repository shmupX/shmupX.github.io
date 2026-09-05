// Which of a level's enemies and bosses the PS2 export packs.
//
// A Dezaemon import carries every enemy type of every stage of the save, but
// the console plays one stage, and packing all of them shrank the level atlas
// to 1/2 or 1/4 — a 16x16 sprite reduced to 4x4 texels, which on the console
// was an enemy you could hit but not see. stageRecipes() cuts the set down to
// what the exported stage's wave grid names.

import { assert, assertEquals } from "@std/assert";
import {
  discStage,
  type LevelRecord,
  stageRecipes,
} from "../lib/ps2/assets.ts";

function enemy(name: string): Record<string, unknown> {
  return { name, texture: [`${name}_0.gif`, `${name}_1.gif`] };
}

const names = (list: Record<string, unknown>[]) =>
  list.map((rec) => rec.name as string).sort();

Deno.test("only the types the stage's grid names are packed", () => {
  const record: LevelRecord = {
    stageKey: "stage0",
    enemylist: [["A0", "00", "B1"], ["00", "A0", "00"]],
    enemyData: { enemyA: enemy("a"), enemyB: enemy("b"), enemyC: enemy("c") },
    bossData: { boss0: enemy("boss0"), boss1: enemy("boss1") },
  };
  const out = stageRecipes(record);
  assertEquals(names(out.enemies), ["a", "b"]);
  assertEquals(names(out.bosses), ["boss0"]);
  assert(out.note.includes("2 of 3 enemy types"), out.note);
  assert(out.note.includes("1 of 2 bosses"), out.note);
});

Deno.test("a two-letter code is read both ways", () => {
  // The browser reads `CM0` as enemyCM; the PS2 port at 1.1.0 reads it as
  // enemyC. Whichever the runtime does, the frames have to be there.
  const record: LevelRecord = {
    stageKey: "stage1",
    enemylist: [["CM0", "BE0"]],
    enemyData: {
      enemyC: enemy("c"),
      enemyCM: enemy("cm"),
      enemyBE: enemy("be"),
      enemyZ: enemy("z"),
    },
    bossData: { boss0: enemy("boss0"), boss1: enemy("boss1") },
  };
  const out = stageRecipes(record);
  assertEquals(names(out.enemies), ["be", "c", "cm"]);
  assertEquals(names(out.bosses), ["boss1"]);
});

Deno.test("the boss follows the port's clamp to five stages", () => {
  const record: LevelRecord = {
    stageKey: "stage7",
    enemylist: [["A0"]],
    enemyData: { enemyA: enemy("a") },
    bossData: { boss4: enemy("boss4"), boss7: enemy("boss7") },
  };
  // boss7 for a runtime that has the stage, boss4 for the port that clamps.
  assertEquals(names(stageRecipes(record).bosses), ["boss4", "boss7"]);
});

Deno.test("a grid that names nothing known falls back to everything", () => {
  const record: LevelRecord = {
    enemylist: [["Q0", "R0"]],
    enemyData: { enemyA: enemy("a"), enemyB: enemy("b") },
    bossData: { boss0: enemy("boss0"), boss3: enemy("boss3") },
  };
  const out = stageRecipes(record);
  assertEquals(names(out.enemies), ["a", "b"]);
  assertEquals(names(out.bosses), ["boss0", "boss3"]);
  assert(out.note.includes("packing all"), out.note);
});

Deno.test("codes that match no enemy are reported, not fatal", () => {
  const record: LevelRecord = {
    enemylist: [["A0", "Q0"]],
    enemyData: { enemyA: enemy("a") },
  };
  const out = stageRecipes(record);
  assertEquals(names(out.enemies), ["a"]);
  assert(out.note.includes("1 code(s) match no enemy (Q0)"), out.note);
});

Deno.test("a level with no custom enemies has nothing to say", () => {
  const out = stageRecipes({ enemylist: [["A0"]] });
  assertEquals(out.enemies, []);
  assertEquals(out.bosses, []);
  assertEquals(out.note, "");
});

// The disc's grid. The PS2 port reads only the first character of a cell as
// the enemy type, so a two-letter type has to become one character before it
// goes on the disc — or `CM0` spawns enemyC, which in Master Arena Mod is a
// single-pixel "star".

Deno.test("two-letter types become one character, and enemyData follows", () => {
  const record: LevelRecord = {
    enemylist: [["CM0", "A1", "00"], ["BE9", "CM0", "A0"]],
    enemyData: {
      enemyA: enemy("a"),
      enemyB: enemy("b"), // the port's misreading of BE — must not be shipped
      enemyC: enemy("c"), // likewise for CM
      enemyCM: enemy("cm"),
      enemyBE: enemy("be"),
      enemyZZ: enemy("zz"), // not on the grid
    },
  };
  const disc = discStage(record);
  // A keeps its letter; BE and CM take the first free ones, in order.
  assertEquals(disc.renamed, { BE: "B", CM: "C" });
  assertEquals(disc.enemylist, [["C0", "A1", "00"], ["B9", "C0", "A0"]]);
  assertEquals(names(Object.values(disc.enemyData)), ["a", "be", "cm"]);
  assertEquals(disc.enemyData.enemyB, enemy("be"));
  assertEquals(disc.enemyData.enemyC, enemy("cm"));
  assert(disc.note.includes("2 re-coded"), disc.note);
});

Deno.test("a letter the grid already uses is not handed out again", () => {
  const record: LevelRecord = {
    enemylist: [["A0", "B0", "AQ0"]],
    enemyData: { enemyA: enemy("a"), enemyB: enemy("b"), enemyAQ: enemy("aq") },
  };
  const disc = discStage(record);
  assertEquals(disc.renamed, { AQ: "C" });
  assertEquals(disc.enemylist, [["A0", "B0", "C0"]]);
});

Deno.test("the item digit rides along and 00 stays empty", () => {
  const record: LevelRecord = {
    enemylist: [["00", "XY3", "XY0"]],
    enemyData: { enemyXY: enemy("xy") },
  };
  assertEquals(discStage(record).enemylist, [["00", "A3", "A0"]]);
});

Deno.test("more types than codes leaves the rest alone and says so", () => {
  const enemyData: Record<string, Record<string, unknown>> = {};
  const row: string[] = [];
  // 61 codes exist (A-Z, a-z, 1-9); ask for 63 two-letter types.
  for (let i = 0; i < 63; i++) {
    const type = "Q" + String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26));
    enemyData[`enemy${type}`] = enemy(type);
    row.push(`${type}0`);
  }
  const disc = discStage({ enemylist: [row], enemyData });
  assertEquals(Object.keys(disc.renamed).length, 61);
  assert(disc.note.includes("2 more than there are codes"), disc.note);
  // The two leftovers keep their original codes and records.
  const kept = disc.enemylist[0].filter((code) => code.length > 2);
  assertEquals(kept.length, 2);
});

Deno.test("a single-letter grid ships untouched, minus unused records", () => {
  const record: LevelRecord = {
    enemylist: [["A0", "00"]],
    enemyData: { enemyA: enemy("a"), enemyB: enemy("b") },
  };
  const disc = discStage(record);
  assertEquals(disc.renamed, {});
  assertEquals(disc.enemylist, [["A0", "00"]]);
  assertEquals(names(Object.values(disc.enemyData)), ["a"]);
});

Deno.test("a grid naming nothing known is shipped as it was", () => {
  const record: LevelRecord = {
    enemylist: [["Q0"]],
    enemyData: { enemyA: enemy("a") },
  };
  const disc = discStage(record);
  assertEquals(disc.enemylist, [["Q0"]]);
  assertEquals(names(Object.values(disc.enemyData)), ["a"]);
  assertEquals(disc.note, "");
});
