// A Dezaemon 2 cart image, as the level record `--sav` hands the exporter.
//
// Gated on dev-fixtures/, which is git-ignored: the .sav library is community
// content, not repo content (same posture as the tone-bank test next door).
//
// What is worth asserting here is the CONTRACT lib/ps2/assets.ts consumes, not
// the decode itself — the engine's own suite covers that. A record whose
// enemylist names a frame nobody packed, or whose waveRows are a different
// length than its waves, builds a disc that boots to an empty stage rather
// than failing, so those are the things checked.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { loadSavLevel, savSlug, savTitle } from "../lib/ps2/sav.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

async function findSav(): Promise<string | null> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(join(ROOT, "dev-fixtures"))) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".sav")) {
        names.push(entry.name);
      }
    }
    names.sort();
    return names.length ? join(ROOT, "dev-fixtures", names[0]) : null;
  } catch {
    return null;
  }
}

const sav = await findSav();
const gated = { ignore: sav === null };
if (!sav) console.log("  (sav level: skipped — no .sav in dev-fixtures/)");

Deno.test("the filename supplies the name the shelf uses", () => {
  assertEquals(
    savTitle("Dez 2 - Air Streamer -Ver.A-.sav"),
    "Air Streamer -Ver.A-",
  );
  assertEquals(savTitle("/a/b/Dez 2 - A28.sav"), "A28");
  assertEquals(savSlug("Dez 2 - Chohsoku Stringer.sav"), "chohsoku-stringer");
  assertEquals(
    savSlug("Dez 2 - BW (Black and White).sav"),
    "bw-black-and-white",
  );
});

Deno.test("a save becomes a staged stage", gated, async () => {
  const level = await loadSavLevel(sav!);

  assertEquals(level.name, savTitle(sav!));
  assert(
    /^stage\d$/.test(level.record.stageKey!),
    "one stage, named the port's way",
  );

  const waves = level.record.enemylist!;
  assert(waves.length > 0, "an exported stage must have waves");
  const width = level.record.width!;
  for (const row of waves) {
    assertEquals(row.length, width, "every row is the record's own width");
  }
  assert(
    waves.some((row) => row.some((cell) => cell !== "00")),
    "an exported stage must place at least one enemy",
  );

  // The runtime pairs waveRows with waves by index; a record that carries a
  // mismatched pair would silently re-time the stage.
  if (level.record.waveRows) {
    assertEquals(level.record.waveRows.length, waves.length);
  }

  // Every letter the grid names has to have a record, or the port spawns
  // nothing where that cell was.
  const enemies = level.record.enemyData!;
  for (const row of waves) {
    for (const cell of row) {
      if (cell === "00") continue;
      const key = "enemy" + cell.replace(/\d+$/, "");
      assert(key in enemies, `${cell} has no ${key} record`);
    }
  }
});

Deno.test(
  "the sprites the record names are all on its sheet",
  gated,
  async () => {
    const level = await loadSavLevel(sav!);
    const atlas = level.atlas;
    assert(atlas, "a Dezaemon save always carries its own art");

    for (const [name, entry] of Object.entries(atlas.frames)) {
      const { x, y, w, h } = entry.frame;
      assert(w > 0 && h > 0, `${name} is empty`);
      assert(
        x >= 0 && y >= 0 && x + w <= atlas.sheet.width &&
          y + h <= atlas.sheet.height,
        `${name} falls outside the ${atlas.sheet.width}x${atlas.sheet.height} sheet`,
      );
    }

    // Not every frame an enemy names is the save's own — the base game's sheet
    // covers the rest (that merge is buildFrameIndex's job) — but the save's
    // sprites are what make it look like itself, so some must be referenced.
    const named = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") named.add(item);
          else walk(item);
        }
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) walk(item);
      }
    };
    walk(level.record.enemyData);
    const own = [...named].filter((frame) => frame in atlas.frames);
    assert(own.length > 0, "no enemy draws from the save's own art");
  },
);

Deno.test("an explicit stage is taken at its word", gated, async () => {
  const level = await loadSavLevel(sav!, { stage: "0" });
  assertEquals(level.record.stageKey, "stage0");
  await assertRejects(
    () => loadSavLevel(sav!, { stage: "zz" }),
    "stage0..stage9",
  );
  await assertRejects(() => loadSavLevel(sav!, { slot: 99 }), "out of range");
});

async function assertRejects(fn: () => Promise<unknown>, contains: string) {
  try {
    await fn();
  } catch (error) {
    assert(
      (error as Error).message.includes(contains),
      `expected "${contains}" in: ${(error as Error).message}`,
    );
    return;
  }
  throw new Error(`expected a rejection mentioning "${contains}"`);
}
