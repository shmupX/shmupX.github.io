// The whole game on the disc, not just the stage it opens on.
//
// The port (svelte-ps2's ps2-sp) reads a level in two steps. It swaps the base
// recipe's enemy and boss tables for the ones in level.json, tagging each
// record so its sprites are looked for on the level atlas; then it plays
// stage0 through stage4 out of those tables — and, after the ending, stage0
// through stage4 again. An exporter that staged only the stage a level was
// saved on turned that into a disc with one working stage: stage one, then a
// boss you could hit but not see, then four stages of nothing. laterStages
// and stageRecipes (stage_recipes_test.ts) are what put the rest on the disc.
//
// None of that fails loudly. The port does not draw a placeholder for a frame
// it cannot find and does not complain about a wave code with no enemy behind
// it, so the tests here model what the port will ask the disc for and insist
// the disc can answer — and then, when a compiled runtime is on hand, play the
// real thing from the title screen to the ending and watch what gets drawn.
// That last one is what caught the bosses' own bullets: the port draws every
// boss shot from game_asset, so a level's own bullet art packed anywhere else
// is never seen.

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { normalizeLegacyGame } from "@shmupx/shmup-engine";
import {
  buildLevelAtlas,
  type LevelRecord,
  stageAssets,
  type StagedFile,
} from "../lib/ps2/assets.ts";
import type { SourceFrame } from "../lib/ps2/atlas.ts";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { newRaster } from "../lib/ps2/png.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");
const decoder = new TextDecoder();

// Recipes and atlases as they come off the disc: read, not modelled.
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// The level atlas's sheet
// ---------------------------------------------------------------------------

function squares(count: number, size: number): SourceFrame[] {
  const sheet = newRaster(size, size);
  return Array.from({ length: count }, (_, i) => ({
    name: `frame${i}.gif`,
    sheet,
    entry: { frame: { x: 0, y: 0, w: size, h: size } },
  }));
}

Deno.test("a set that fits the usual sheet packs exactly as it always did", () => {
  const built = buildLevelAtlas(squares(40, 32));
  assertEquals(built.displayScale, 1);
  assert(built.image.width <= 512 && built.image.height <= 512);
});

Deno.test("five stages of sprites get the roomier sheet rather than half size", () => {
  // ~290k texels of art: more than a 512 sheet holds, well inside 512x1024.
  const frames = squares(72, 64);
  for (const budget of [{}, { maxSheet: 512 }]) {
    const built = buildLevelAtlas(frames, budget);
    assertEquals(built.displayScale, 1, JSON.stringify(budget));
    assertEquals(built.image.width * built.image.height, 512 * 1024);
  }
  // One doubling past whatever the cap is, so a smaller cap stays smaller.
  const small = buildLevelAtlas(squares(20, 64), { maxSheet: 256 });
  assertEquals(small.displayScale, 1);
  assertEquals(small.image.width * small.image.height, 256 * 512);

  // A cover has already spent the margin on game_ui: the old sheet, and the
  // scale that costs.
  const tight = buildLevelAtlas(frames, { cover: true });
  assertEquals(tight.displayScale, 2);
  assert(tight.image.width <= 512 && tight.image.height <= 512);
});

Deno.test("the roomier sheet is 512x1024 at most, never the full 1024", () => {
  // Too much even for 512x1024 at full size. 1024x1024 would hold it, and
  // would be a megabyte of the console's four.
  const built = buildLevelAtlas(squares(150, 64));
  assertEquals(built.displayScale, 2);
  assert(built.image.width * built.image.height <= 512 * 1024);
  // At a 1024 cap there is no doubling left: the GS samples nothing larger.
  const capped = buildLevelAtlas(squares(150, 64), { maxSheet: 1024 });
  assert(capped.image.width <= 1024 && capped.image.height <= 1024);
});

// ---------------------------------------------------------------------------
// What the port will ask a disc for
// ---------------------------------------------------------------------------

function parse(files: StagedFile[], path: string): Json {
  const file = files.find((entry) => entry.path === path);
  assert(file, `the export did not stage ${path}`);
  return JSON.parse(decoder.decode(file.data));
}

/**
 * The recipe as the port holds it once it has booted — loadFirebaseLevel and
 * then normalizeRecipe, from ps2-sp/assets.ts at svelte-ps2 1.1.1.
 */
function portRecipe(files: StagedFile[]): Json {
  const recipe = parse(files, "assets/game.json");
  const level = parse(files, "assets/level.json");
  recipe[level.stageKey || "stage0"] = { enemylist: level.enemylist };
  if (level.enemyData) {
    for (const enemy of Object.values<Json>(level.enemyData)) {
      enemy.atlas = "level_atlas";
      const shots = enemy.projectileData ?? enemy.bulletData;
      if (shots) shots.atlas = "level_atlas";
    }
    recipe.enemyData = level.enemyData;
  }
  if (level.bossData) {
    for (const boss of Object.values<Json>(level.bossData)) {
      if (boss.anim) boss.atlas = "level_atlas";
      if (boss.bulletData) boss.bulletData.atlas = "level_atlas";
    }
    recipe.bossData = level.bossData;
  }
  for (const boss of Object.values<Json>(recipe.bossData ?? {})) {
    if (!boss.texture?.length && boss.anim) boss.texture = boss.anim.idle || [];
    if (!boss.projectileData && boss.bulletData?.texture) {
      boss.projectileData = { texture: boss.bulletData.texture };
    }
  }
  for (const enemy of Object.values<Json>(recipe.enemyData ?? {})) {
    if (!enemy.projectileData && enemy.bulletData?.texture) {
      enemy.projectileData = {
        texture: enemy.bulletData.texture,
        atlas: enemy.bulletData.atlas,
      };
    }
  }
  return recipe;
}

/**
 * Everything the five stages of a disc cannot put on screen: a wave cell with
 * no enemy behind it, a stage with no boss, a frame that is not on the sheet
 * the port will look for it on. Empty means the disc is whole.
 */
function unseen(files: StagedFile[]): string[] {
  const recipe = portRecipe(files);
  const sheets: Record<string, Json> = {
    game_asset: parse(files, "assets/game_asset.json").frames,
    level_atlas: parse(files, "assets/level_atlas.json").frames,
  };
  // AtlasManager.resolveFrameName: the name, else the other of .gif/.png.
  const has = (sheet: string, frame: string) =>
    !!sheets[sheet]?.[frame] ||
    !!sheets[sheet]?.[
      frame.replace(/\.(gif|png)$/, (_, ext) => ext === "gif" ? ".png" : ".gif")
    ];

  const problems = new Set<string>();
  const need = (who: string, sheet: string, frames: string[] | undefined) => {
    for (const frame of frames ?? []) {
      if (!has(sheet, frame)) problems.add(`${who}: ${frame} not on ${sheet}`);
    }
  };
  for (let stage = 0; stage < 5; stage++) {
    const grid: string[][] = recipe[`stage${stage}`]?.enemylist ?? [];
    assert(grid.length > 0, `stage${stage} has no waves`);
    for (const code of new Set(grid.flat().map(String))) {
      if (code === "00") continue;
      const key = `enemy${code.slice(0, -1)}`;
      const enemy = recipe.enemyData?.[key];
      if (!enemy) {
        problems.add(`stage${stage}: ${code} names ${key}, which is not there`);
        continue;
      }
      const sheet = enemy.atlas || "game_asset";
      need(key, sheet, enemy.texture);
      const shots = enemy.projectileData;
      need(`${key} shots`, shots?.atlas || sheet, shots?.texture);
    }
    const boss = recipe.bossData?.[`boss${stage}`];
    if (!boss) {
      problems.add(`stage${stage} has no boss`);
      continue;
    }
    if (!boss.texture?.length) problems.add(`boss${stage} has no frames`);
    need(`boss${stage}`, boss.atlas || "game_asset", boss.texture);
    // A boss's shots are queued with frame names and no atlas, so they are
    // drawn from the base sheet whatever the level's records were tagged.
    need(`boss${stage} shots`, "game_asset", boss.projectileData?.texture);
    need(`boss${stage} shots`, "game_asset", boss.projectileDataA?.texture);
  }
  return [...problems];
}

/** A game.json — `stageN` at the top level — as the record the editor saves. */
function recordFromGame(game: Json, name: string): LevelRecord {
  const stages: Record<string, { enemylist: string[][] }> = {};
  for (const key of Object.keys(game)) {
    if (/^stage\d+$/.test(key)) {
      stages[key] = { enemylist: game[key].enemylist };
    }
  }
  return {
    name,
    stageKey: "stage0",
    enemylist: stages.stage0.enemylist,
    width: 8,
    stages,
    enemyData: game.enemyData,
    bossData: game.bossData,
    playerData: game.playerData,
  };
}

async function readJson(path: string): Promise<Json | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

Deno.test("a five-stage game saved from the editor is whole on the disc", async () => {
  // The stock recipe as a whole-game record — every stage under `stages`,
  // every record, not one custom frame — with stage1's waves changed, so the
  // record is recognisably not the base game. The shape a web game arrives in
  // when it is imported from a directory and saved.
  const game = (await readJson(join(GAME_DIR, "assets", "game.json")))!;
  game.stage1.enemylist = [...game.stage1.enemylist].reverse();
  const record = recordFromGame(game, "five-stages");

  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  assertEquals(unseen(staged.files), []);

  // The other four stages are the record's own, not the base game's.
  const recipe = parse(staged.files, "assets/game.json");
  for (const key of ["stage1", "stage2", "stage3", "stage4"]) {
    assertEquals(recipe[key].enemylist, game[key].enemylist, key);
  }
  // Every enemy any of them names.
  const level = parse(staged.files, "assets/level.json");
  assertEquals(
    Object.keys(level.enemyData).sort(),
    Object.keys(game.enemyData).sort(),
  );

  // And the whole game still draws at full size — five bosses of 2019 art,
  // which at every animation they carry came out at 1/4.
  const atlas = parse(staged.files, "assets/level_atlas.json");
  assertEquals(atlas.meta.ps2DisplayScale, 1);
  assert(atlas.meta.size.w * atlas.meta.size.h <= 512 * 1024);
});

Deno.test("the 2019 game in dev-fixtures/ is whole on the disc", async () => {
  // The game the invisible bosses were reported with, brought up to today's
  // frame names the way the editor's directory import does. dev-fixtures/ is
  // git-ignored, so this runs where the directory has been dropped in.
  const game = await readJson(
    join(ROOT, "dev-fixtures", "2019-web", "game.json"),
  );
  if (!game) {
    console.log("  (skipped: no dev-fixtures/2019-web/game.json)");
    return;
  }
  normalizeLegacyGame(game);
  const staged = await stageAssets({
    gameDir: GAME_DIR,
    record: recordFromGame(game, "2019"),
  });
  assertEquals(unseen(staged.files), []);
});

// The game this repo ships is ONE wave grid with enemy and boss tables for
// five stages: the browser plays the base game's waves for the other four out
// of the level's tables, and so does the port. It also brings its own art for
// everything, boss bullets included.
let shippedGame: Promise<StagedFile[]> | null = null;
function stageShippedGame(): Promise<StagedFile[]> {
  return shippedGame ??= (async () => {
    const record = (await readJson(join(GAME_DIR, "foo.json")))!;
    return (await stageAssets({ gameDir: GAME_DIR, record })).files;
  })();
}

Deno.test("the game this repo ships is whole on the disc", async () => {
  const files = await stageShippedGame();
  assertEquals(unseen(files), []);

  // Its stages 1-4 are the base game's, so game.json goes out untouched…
  assertEquals(
    files.find((file) => file.path === "assets/game.json")!.data,
    await Deno.readFile(join(GAME_DIR, "assets", "game.json")),
  );
  // …and its bosses' own bullets are on the sheet the port draws them from.
  const base = parse(files, "assets/game_asset.json").frames;
  assert(base["flirtyRevengeProjectile0.png"], "boss3's shots were not packed");
});

Deno.test("a game exported from a later stage is whole on its next game too", async () => {
  // Saved with stage2 open: the disc boots there and plays on to the ending,
  // and the ending starts the next game at stage0, out of the same tables. So
  // stage0's and stage1's enemies and bosses are on the disc as well.
  const record = (await readJson(join(GAME_DIR, "foo.json")))!;
  record.stageKey = "stage2";
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  assertEquals(unseen(staged.files), []);
});

// ---------------------------------------------------------------------------
// The real runtime, from the title screen to the ending
// ---------------------------------------------------------------------------

interface Played {
  /** `sheet:frame` -> drawn at least once, per stage. */
  drawn: Map<number, Set<string>>;
  ended: boolean;
  frames: number;
}

/**
 * Run the compiled port over a staged disc with a stand-in for AthenaEnv, with
 * a player who cannot die holding fire, until the ending or `limit` frames.
 * Which frame a draw was is read back off the crop rectangle the port set.
 */
async function play(
  dir: string,
  mainJs: string,
  limit: number,
): Promise<Played> {
  const read = (path: string) => {
    try {
      return Deno.readFileSync(join(dir, path));
    } catch {
      return null;
    }
  };
  // "x,y,w,h" -> frame name, per sheet the port opens.
  const byRect = new Map<string, Map<string, string>>();
  for (const name of ["game_asset", "game_ui", "level_atlas"]) {
    const atlas = JSON.parse(decoder.decode(read(`assets/${name}.json`)!));
    const rects = new Map<string, string>();
    for (const [frame, entry] of Object.entries<Json>(atlas.frames)) {
      const f = entry.frame;
      rects.set(`${f.x},${f.y},${f.w},${f.h}`, frame);
    }
    byRect.set(`assets/${name}.png`, rects);
  }

  const out: Played = { drawn: new Map(), ended: false, frames: 0 };
  let stage = -1;
  let inGame = false;
  const g = globalThis as unknown as Record<string, unknown>;
  g.Screen = {
    NTSC: 2,
    DEPTH_TEST_ENABLE: 1,
    getMode: () => ({ width: 640, height: 448 }),
    setVSync: () => {},
    setParam: () => {},
    clear: () => {},
    flip: () => {
      out.frames++;
      // The bundle's last statement is an infinite loop; this is the way out.
      if (out.ended || out.frames >= limit) throw new Error("__played__");
    },
    display: () => {},
  };
  g.Draw = { rect: () => {} };
  g.Image = class {
    width = 0;
    height = 0;
    startx = 0;
    starty = 0;
    endx = 0;
    endy = 0;
    color = 0;
    filter = 0;
    angle = 0;
    #path: string;
    constructor(path: string) {
      this.#path = path;
      const bytes = read(path);
      assert(bytes, `the game opened ${path}, which is not on the disc`);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      this.width = this.endx = view.getUint32(16);
      this.height = this.endy = view.getUint32(20);
    }
    draw() {
      if (!inGame) return;
      // A flipped sprite has its crop edges swapped; the rectangle is the same.
      const x = Math.min(this.startx, this.endx);
      const y = Math.min(this.starty, this.endy);
      const w = Math.abs(this.endx - this.startx);
      const h = Math.abs(this.endy - this.starty);
      const frame = byRect.get(this.#path)?.get(`${x},${y},${w},${h}`);
      if (!frame) return;
      const sheet = this.#path.slice("assets/".length, -".png".length);
      let seen = out.drawn.get(stage);
      if (!seen) out.drawn.set(stage, seen = new Set());
      seen.add(`${sheet}:${frame}`);
    }
  };
  g.Font = class {
    scale = 1;
    color = 0;
    // The game scene announces each stage; nothing else says where we are.
    print(_x: number, _y: number, text: string) {
      const round = /^ROUND (\d+)$/.exec(String(text));
      if (round) {
        stage = Number(round[1]) - 1;
        inGame = true;
      } else if (/^STAGE \d+$/.test(String(text))) {
        inGame = false; // the interlude before the next one
      } else if (String(text) === "CONGRATULATIONS!") {
        inGame = false;
        out.ended = true;
      }
    }
    getTextSize(text: string) {
      return { width: String(text).length * 8, height: 16 };
    }
  };
  const CROSS = 0x4000;
  const pad = {
    update: () => {},
    // Cross on a pulse: the menus and interludes advance on a rising edge.
    pressed: (mask: number) => mask === CROSS && out.frames % 30 < 2,
    justPressed: (mask: number) => mask === CROSS && out.frames % 30 === 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
  };
  g.Pads = {
    SELECT: 1,
    L3: 2,
    R3: 4,
    START: 8,
    UP: 16,
    RIGHT: 32,
    DOWN: 64,
    LEFT: 128,
    L2: 256,
    R2: 512,
    L1: 1024,
    R1: 2048,
    TRIANGLE: 4096,
    CIRCLE: 8192,
    CROSS,
    SQUARE: 32768,
    get: () => pad,
    getConnected: () => [0],
    getConnectedCount: () => 1,
    isActive: () => true,
  };
  let clock = 0;
  g.Timer = { new: () => ({}), getTime: () => (clock += 33_333) };
  g.std = {
    loadFile: (path: string) => {
      const bytes = read(path);
      if (!bytes) return null;
      if (path !== "assets/game.json") return decoder.decode(bytes);
      // The pad above cannot dodge, and the run has to reach every stage.
      const recipe = JSON.parse(decoder.decode(bytes));
      recipe.playerData.maxHp = 1e9;
      return JSON.stringify(recipe);
    },
    open: () => ({ puts: () => {}, close: () => {} }),
  };

  const quiet = console.log;
  console.log = () => {};
  try {
    await import(`file://${mainJs}`);
  } catch (error) {
    if (!(error as Error).message.includes("__played__")) throw error;
  } finally {
    console.log = quiet;
  }
  return out;
}

Deno.test("the port draws every stage's enemies and its boss, to the ending", async () => {
  const cache = join(ROOT, "build", "ps2", ".cache");
  try {
    await Deno.stat(join(cache, "main.js"));
  } catch {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  // The cache is only as fresh as its last build; this re-bundles when the
  // port's pin or the entry has moved since, and is instant when not.
  const runtime = await buildRuntimeBundle(ROOT, cache);
  const files = await stageShippedGame();

  const dir = await Deno.makeTempDir({ prefix: "shmupx-ps2-" });
  try {
    for (const file of files) {
      const target = join(dir, file.path);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, file.data);
    }
    // The preamble build.ts writes for a silent build at the export's pace.
    const mainJs = join(dir, "main.mjs");
    await Deno.writeFile(
      mainJs,
      new Uint8Array([
        ...new TextEncoder().encode(
          "globalThis.__PS2_GAME_FPS__ = 120;\n" +
            "globalThis.__PS2_AUDSRV__ = false;\n",
        ),
        ...runtime,
      ]),
    );

    const played = await play(dir, mainJs, 60_000);
    assert(
      played.ended,
      `the game never reached its ending in ${played.frames} frames — ` +
        `stages seen: ${[...played.drawn.keys()].join(", ")}`,
    );

    const recipe = portRecipe(files);
    for (let stage = 0; stage < 5; stage++) {
      const seen = played.drawn.get(stage) ?? new Set<string>();
      const drew = (sheet: string, frames: string[]) =>
        frames.some((frame) => seen.has(`${sheet}:${frame}`));
      const grid: string[][] = recipe[`stage${stage}`].enemylist;
      for (const code of new Set(grid.flat().map(String))) {
        if (code === "00") continue;
        const enemy = recipe.enemyData[`enemy${code.slice(0, -1)}`];
        assert(
          drew(enemy.atlas, enemy.texture),
          `stage${stage}: ${enemy.name} (${code}) was never drawn`,
        );
      }
      const boss = recipe.bossData[`boss${stage}`];
      assert(
        drew(boss.atlas, boss.texture),
        `stage${stage}: the boss (${boss.name}) was never drawn`,
      );
    }
    // The fourth boss is the one whose own bullet art the port fires.
    assert(
      [...(played.drawn.get(3) ?? [])].includes(
        "game_asset:flirtyRevengeProjectile0.png",
      ),
      "boss3 fired shots that were never drawn",
    );
    console.log(
      `  five stages and the ending in ${played.frames} frames; ` +
        [0, 1, 2, 3, 4].map((stage) => `${played.drawn.get(stage)?.size ?? 0}`)
          .join("/") +
        " distinct sprites per stage",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
