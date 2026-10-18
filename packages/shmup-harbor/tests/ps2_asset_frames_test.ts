// game_asset on the disc: only what the port can draw from it.
//
// The stock sheet is 221 frames, every enemy, boss and effect of 2028.Ai's
// five stages, and packed whole into a 512 sheet it came out at 1/4: a 32px
// enemy 8 texels across. The port draws a fraction of it on any one disc —
// the player's shots and barrier, the power-ups, explosions and turbo hits,
// game.json's own enemies and bosses when the level brings none, and the
// shots of every boss — so the exporter packs that fraction
// (portAssetFrames). Leaving out a frame the port asks for draws nothing at
// all, silently, so these tests read the port's code for the names it builds
// and check a staged disc carries what its recipes name.
// ps2_whole_game_test.ts plays the shipped game to the ending on top of this.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type LevelRecord,
  PORT_ASSET_FRAMES,
  stageAssets,
  type StagedFile,
} from "../lib/ps2/assets.ts";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");
const decoder = new TextDecoder();

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const readJson = async (path: string): Promise<Json> =>
  JSON.parse(await Deno.readTextFile(path));

function sheet(files: StagedFile[]) {
  const file = files.find((entry) => entry.path === "assets/game_asset.json");
  assert(file, "the export did not stage game_asset");
  return JSON.parse(decoder.decode(file.data)) as Json;
}

/** Every `texture` list's frames under `value`. */
function textures(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value as Json)) {
    if (key === "texture" && Array.isArray(child)) {
      for (const frame of child) into.add(frame);
    } else textures(child, into);
  }
  return into;
}

const stockNames = async () =>
  Object.keys(
    (await readJson(join(GAME_DIR, "assets", "game_asset.json"))).frames,
  );

Deno.test("the port's code names no game_asset frame the disc leaves out", async () => {
  const cache = join(ROOT, "build", "ps2", ".cache");
  try {
    await Deno.stat(join(cache, "main.js"));
  } catch {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const js = decoder.decode(await buildRuntimeBundle(ROOT, cache));
  const stock = await stockNames();
  // A stock frame its code spells out in full: the power-ups.
  const named = stock.filter((name) => js.includes(`"${name}"`));
  assert(named.length > 0, "the port names no game_asset frame?");
  for (const name of named) {
    assert(PORT_ASSET_FRAMES.has(name), `the port names ${name}`);
  }
  // And one it builds as `"prefix" + n + ".gif"`: explosions and turbo hits.
  const prefixes = [...js.matchAll(/"([A-Za-z_]+\d?)" \+ String\(/g)]
    .map((m) => m[1]);
  let built = 0;
  for (const prefix of new Set(prefixes)) {
    const series = stock.filter((name) =>
      new RegExp(`^${prefix}\\d+\\.gif$`).test(name)
    );
    built += series.length;
    for (const name of series) {
      assert(PORT_ASSET_FRAMES.has(name), `the port builds ${name}`);
    }
  }
  assert(built >= 12, `only ${built} built names found — has the code moved?`);
});

Deno.test("the shipped game's game_asset is its shots, effects and boss shots, at full size", async () => {
  const record = await readJson(join(GAME_DIR, "foo.json")) as LevelRecord;
  const recipe = await readJson(join(GAME_DIR, "assets", "game.json"));
  const { files } = await stageAssets({ gameDir: GAME_DIR, record });
  const asset = sheet(files);
  const have = new Set(Object.keys(asset.frames));
  const stock = new Set(await stockNames());

  // What the port draws from game_asset whatever the level: the player's
  // shots and barrier, out of game.json, and what its code names.
  for (const name of [...textures(recipe.playerData), ...PORT_ASSET_FRAMES]) {
    if (stock.has(name)) assert(have.has(name), `${name} was left out`);
  }
  // Every boss's shots, which the port files under game_asset.
  for (const boss of Object.values(record.bossData ?? {}) as Json[]) {
    for (const name of textures(boss.projectileData)) {
      assert(have.has(name), `${name} (a boss's shot) was left out`);
    }
  }
  // The level brings its own enemies and animated bosses, so the stock
  // ones are not on the sheet: Fang's 242x182 poses, for one.
  assertEquals(have.has("fang_idle0.gif"), false);
  assert(have.size < stock.size / 2, `${have.size} of ${stock.size} frames`);
  assertEquals(asset.meta.ps2DisplayScale, 1);
});

Deno.test("a level with no enemies or bosses of its own keeps game.json's on game_asset", async () => {
  const recipe = await readJson(join(GAME_DIR, "assets", "game.json"));
  const { files } = await stageAssets({ gameDir: GAME_DIR, record: {} });
  const have = new Set(Object.keys(sheet(files).frames));
  const stock = new Set(await stockNames());
  for (
    const name of [
      ...textures(recipe.enemyData),
      ...textures(recipe.bossData),
    ]
  ) {
    if (stock.has(name)) assert(have.has(name), `${name} was left out`);
  }
});

Deno.test("a level boss without anim stays on game_asset, body and all", async () => {
  // The port points only a boss with `anim` at the level atlas.
  const recipe = await readJson(join(GAME_DIR, "assets", "game.json"));
  const stockBoss = recipe.bossData.boss0 as Json;
  const record: LevelRecord = {
    enemylist: [["00"]],
    bossData: { boss0: { ...stockBoss, anim: undefined } },
  };
  const { files } = await stageAssets({ gameDir: GAME_DIR, record });
  const have = new Set(Object.keys(sheet(files).frames));
  for (const name of textures(stockBoss)) {
    assert(have.has(name), `${name} was left out`);
  }
});
