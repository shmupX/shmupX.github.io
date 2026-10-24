// The Boss Lab throws the weapon the runtime would.
//
// A boss record arms up to four slots under either of two spellings —
// bulletDataX or projectileDataX — and the runtime reads them in that order
// (game.bundle.js, bossWeaponSlots), the stock routines firing A and B. The
// lab's sim (static/editor/boss-lab.js, projData) read only the bulletData
// spelling, so a boss armed as foo.json spells its bosses — rando's Trump,
// projectileDataA a green laser and projectileDataB a gold fireball — had no
// weapon in the lab's eyes and borrowed the next record's: he threw Akuma's
// purple fireball. Only a boss with no weapon at all borrows one now.

import { assert, assertEquals } from "@std/assert";

const LAB = "static/editor/boss-lab.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

// deno-lint-ignore no-explicit-any
type Json = any;

/**
 * The lab's projData, lifted out of its class and bound to a stand-in lab
 * over `data`, with `key` the boss on show. effKey answers the way the lab's
 * does for a record with no pending pick: its saved attackPattern, else its
 * own slot.
 */
async function projDataOf(data: Record<string, Json>, key: string) {
  const js = await read(LAB);
  const m = /\n {8}projData\(sel\) \{\n([\s\S]*?)\n {8}\}\n/.exec(js);
  assert(m, `no projData(sel) in ${LAB}`);
  const lab = {
    data: () => data,
    curBoss: () => data[key],
    curKey: () => key,
    effKey: (k: string) => (data[k] && data[k].attackPattern) || k,
  };
  const fn = new Function("sel", m[1]) as (this: typeof lab, sel: string) =>
    | { texture: string[] }
    | null;
  return (sel: "A" | "B") => fn.call(lab, sel)?.texture ?? null;
}

/** rando's bosses, as the cloud level spells their weapons (2026-10-22). */
const RANDO: Record<string, Json> = {
  boss0: {
    name: "dezaBoss0",
    bulletDataA: { texture: ["dezaBoss0_4.png", "dezaBoss0_5.png"] },
    bulletDataC: { texture: ["dezaBoss0_8.png", "dezaBoss0_9.png"] },
  },
  boss1: {
    name: "goki",
    bulletDataA: { texture: ["Akuma_2019_15.png"] },
    bulletDataB: { texture: ["Akuma_2019_18.png"] },
  },
  boss2: {
    name: "trump",
    attackPattern: "bossExtra",
    projectileDataA: { texture: ["trump_projectileA0.png"] },
    projectileDataB: { texture: ["trump_projectileB0.png"] },
  },
};

Deno.test("each slot is read under either spelling, as the runtime reads it", async () => {
  // Trump: the green laser and the gold fireball, not Akuma's purple one.
  const trump = await projDataOf(RANDO, "boss2");
  assertEquals(trump("A"), ["trump_projectileA0.png"]);
  assertEquals(trump("B"), ["trump_projectileB0.png"]);
  // Akuma: the purple fireball and the red one.
  const akuma = await projDataOf(RANDO, "boss1");
  assertEquals(akuma("A"), ["Akuma_2019_15.png"]);
  assertEquals(akuma("B"), ["Akuma_2019_18.png"]);
  // A boss with an A and no B throws A for both, as the routines do.
  const ryu = await projDataOf(RANDO, "boss0");
  assertEquals(ryu("A"), ["dezaBoss0_4.png", "dezaBoss0_5.png"]);
  assertEquals(ryu("B"), ["dezaBoss0_4.png", "dezaBoss0_5.png"]);
});

Deno.test("the bare slot stands in, bulletData before projectileData, and an empty slot is no weapon", async () => {
  const data: Record<string, Json> = {
    boss0: {
      name: "both",
      bulletDataA: { texture: ["a-bullet"] },
      projectileDataA: { texture: ["a-projectile"] },
      bulletData: { texture: ["bare"] },
    },
    boss1: { name: "bare", projectileData: { texture: ["bare-only"] } },
    boss2: {
      name: "stub",
      bulletDataA: { texture: [] },
      projectileDataA: { texture: ["real"] },
      projectileDataB: {},
    },
  };
  const both = await projDataOf(data, "boss0");
  assertEquals(both("A"), ["a-bullet"], "bulletData spelling first");
  assertEquals(both("B"), ["bare"], "the bare slot before A for a missing B");
  const bare = await projDataOf(data, "boss1");
  assertEquals(bare("A"), ["bare-only"]);
  assertEquals(bare("B"), ["bare-only"]);
  // An empty texture list is no weapon: the other spelling wins, and a
  // missing B falls to A.
  const stub = await projDataOf(data, "boss2");
  assertEquals(stub("A"), ["real"]);
  assertEquals(stub("B"), ["real"]);
});

Deno.test("only a boss with no weapon at all borrows one", async () => {
  const data: Record<string, Json> = {
    ...RANDO,
    boss3: { name: "unarmed", attackPattern: "boss2" },
    boss4: { name: "unarmed too" },
  };
  // Pinned to Trump's routine, it throws what that record throws.
  const pinned = await projDataOf(data, "boss3");
  assertEquals(pinned("A"), ["trump_projectileA0.png"]);
  assertEquals(pinned("B"), ["trump_projectileB0.png"]);
  // With no routine to borrow from, boss1's — Akuma's — as before.
  const loose = await projDataOf(data, "boss4");
  assertEquals(loose("A"), ["Akuma_2019_15.png"]);
  assertEquals(loose("B"), ["Akuma_2019_18.png"]);
  // And a boss with nothing anywhere throws nothing.
  const alone = await projDataOf({ boss4: data.boss4 }, "boss4");
  assertEquals(alone("A"), null);
  assertEquals(alone("B"), null);
});
