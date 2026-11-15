// A game's secret level: another cloud level that plays after the game's
// ending, whichever ending it was. foo names hellophaser, RonaGun.
//
// The level loader (static/phaser-plugins/level-loader.js, and the copy of it
// inlined in game.bundle.js, a vendored artifact patched by hand — README)
// fetches the level a record's `secretLevel` names and puts its stages past
// the game's own (installSecretLevel). The runtime counts none of them as the
// game's, sends a beaten game into them (sceneAfterStory), and plays each with
// the level's own enemies and the level's ship trail (stageRecipe). The
// helpers are run out of the real files.

import { assert, assertEquals } from "@std/assert";
import {
  installSecretLevel,
  SECRET_AUDIO_PREFIX,
  secretLevelName,
} from "../static/phaser-plugins/level-loader.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const LOADER = "static/phaser-plugins/level-loader.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One `var NAME = ...;` line of the bundle's IIFE. */
function constSource(js: string, name: string): string {
  const m = new RegExp(`\\n  var ${name} = [^\\n]+;\\n`).exec(js);
  assert(m, `no ${name} in ${BUNDLE}`);
  return m[0];
}

// deno-lint-ignore no-explicit-any
type Json = any;

const rows = (n: number) => Array.from({ length: n }, () => ["00"]);

/** foo's shape: five stages, their bosses and the hidden one. */
function game(): Json {
  const g: Json = { enemyData: { enemyA: { name: "own" } }, bossData: {} };
  for (let i = 0; i < 5; i++) {
    g["stage" + i] = { enemylist: rows(3) };
    g.bossData["boss" + i] = { name: "boss" + i };
  }
  g.bossData.bossExtra = { name: "Elon" };
  g.playerData = { name: "duke", texture: ["duke_0"] };
  return g;
}

/** RonaGun's shape: one stage, its boss, its own enemies and ship trail. */
function ronagun(): Json {
  return {
    stage0: {
      enemylist: rows(7),
      waveRows: [1, 2, 3, 4, 5, 6, 7],
      waveInterval: 2,
    },
    bossData: { boss0: { name: "seductress", hp: 20 } },
    enemyData: { enemyAAA: { name: "blueAngel" } },
    playerData: { name: "shipBoy", trail: { texture: ["hpBlue"], speed: 125 } },
    endsOnClear: false,
  };
}

Deno.test("secretLevelName reads a key, an alias or { level }, as a level key", () => {
  assertEquals(secretLevelName({ secretLevel: "hellophaser" }), "hellophaser");
  assertEquals(
    secretLevelName({ secretLevel: { level: "ronagun" } }),
    "ronagun",
  );
  // Spelled the way ?level= is: no character the database refuses in a key.
  assertEquals(secretLevelName({ secretLevel: "a/b.c" }), "a_b_c");
  assertEquals(secretLevelName({ secretLevel: "" }), null);
  assertEquals(secretLevelName({}), null);
  assertEquals(secretLevelName(null), null);
});

Deno.test("installSecretLevel puts the level's stages and bosses past the game's own", () => {
  const recipe = game();
  const span = installSecretLevel(recipe, ronagun(), {
    level: "hellophaser",
    title: "RONAGUN",
  });
  assert(span);
  assertEquals(span.first, 5);
  assertEquals(span.count, 1);
  assertEquals(span.stages, [0]);
  assertEquals(span.level, "hellophaser");
  assertEquals(span.title, "RONAGUN");
  assertEquals(recipe.stage5.enemylist.length, 7);
  assertEquals(recipe.bossData.boss5.name, "seductress");
  // The game's own stages, bosses and enemies are left as they were: the
  // level's enemies ride on the descriptor, lettered as that level letters them.
  assertEquals(recipe.stage4.enemylist.length, 3);
  assertEquals(recipe.bossData.boss0.name, "boss0");
  assertEquals(recipe.bossData.bossExtra.name, "Elon");
  assertEquals(Object.keys(recipe.enemyData), ["enemyA"]);
  assertEquals(Object.keys(span.enemyData), ["enemyAAA"]);
  // The visiting ship wears the level's ship's trail.
  assertEquals(span.trail.texture, ["hpBlue"]);
  assertEquals(span.audioKeys, []);
  assertEquals(recipe.secretLevel, span);
  assertEquals(SECRET_AUDIO_PREFIX, "secret:");
});

Deno.test("installSecretLevel stops at the last stage number, and says when there is no room", () => {
  // A game that ends at stage 7 has room for two of a three-stage level.
  const seven: Json = { bossData: {} };
  for (let i = 0; i <= 7; i++) seven["stage" + i] = { enemylist: rows(1) };
  const three: Json = {
    bossData: {},
    stage0: { enemylist: rows(1) },
    stage1: { enemylist: rows(2) },
    stage2: { enemylist: rows(3) },
  };
  const span = installSecretLevel(seven, three, {});
  assert(span);
  assertEquals([span.first, span.count, span.stages], [8, 2, [0, 1]]);
  assertEquals(seven.stage9.enemylist.length, 2);
  // A game that already fills stage 9 gets none, and no descriptor.
  const nine: Json = { stage9: { enemylist: rows(1) } };
  assertEquals(installSecretLevel(nine, ronagun(), {}), null);
  assertEquals(nine.secretLevel, undefined);
  // A level with no stage adds nothing.
  const g = game();
  assertEquals(installSecretLevel(g, { bossData: {} }, {}), null);
  assertEquals(g.stage5, undefined);
});

Deno.test("the bundle's inlined loader carries the plugin's secret-level code, line for line", async () => {
  const plugin = await read(LOADER);
  const bundle = await read(BUNDLE);
  const lines = (text: string) =>
    text.split("\n").map((l) => l.trim().replace(/^export /, "")).filter(
      Boolean,
    );
  const between = (text: string, from: string, to: string) => {
    const i = text.indexOf(from);
    const j = text.indexOf(to, i);
    assert(i >= 0 && j > i, `no ${from.trim()} .. ${to.trim()}`);
    return text.slice(i, j);
  };
  for (
    const [from, to] of [
      [
        "// ---- A secret level ----",
        "// Does a level record carry a whole game's framing",
      ],
      // The plugin's methods: both headers read "A secret level", so this
      // block starts at its first method.
      ["readLevelRecord(levelName, opts) {", "// ---- Custom audio ----"],
    ]
  ) {
    assertEquals(
      lines(between(bundle, from.trim(), to.trim())),
      lines(between(plugin, from.trim(), to.trim())),
      from.trim(),
    );
  }
  for (const [path, js] of [[LOADER, plugin], [BUNDLE, bundle]]) {
    const flat = js.replace(/\s+/g, " ");
    // Both roads in: the cloud or baked record, awaited with the story
    // pictures, and the editor's PLAY.
    assert(
      flat.includes(
        "this.applyStoryImages(data), // The game's secret level, if it names one (applySecretLevel): // its stages join the recipe before the first scene reads it. this.applySecretLevel(recipe, data, baseRecipe, o)",
      ),
      path + ": the cloud road does not install the secret level",
    );
    assert(
      flat.includes(
        "const secretLevel = this.applySecretLevel(recipe, recipe, baseRecipe, o);",
      ),
      path + ": the editor's PLAY does not install the secret level",
    );
    assert(
      flat.includes(".then((result) => secretLevel.then(() => result));"),
      path + ": the editor's PLAY does not wait for the secret level",
    );
  }
});

interface Runtime {
  lastStageId(recipe: Json): number;
  assetStageId(stageId: number): number;
  isSecretStage(recipe: Json, stageId: number): boolean;
  stageRecipe(recipe: Json, stageId: number): Json;
  sceneAfterStory(scene: { endingFlg: boolean }): string;
}

async function runtime(gameState: Json): Promise<Runtime> {
  const js = await read(BUNDLE);
  const names = [
    "clampStageId",
    "secretSpan",
    "isSecretStage",
    "ownStageId",
    "assetStageId",
    "recipeStageIds",
    "lastStageId",
    "stageRecipe",
    "sceneAfterStory",
  ];
  return new Function(
    "gameState",
    constSource(js, "MAX_STAGE_ID") + constSource(js, "ASSET_STAGES") +
      names.map((n) => functionSource(js, n)).join("") +
      "\nreturn { lastStageId, assetStageId, isSecretStage, stageRecipe, sceneAfterStory };",
  )(gameState) as Runtime;
}

function fooWithRonagun(): Json {
  const recipe = game();
  installSecretLevel(recipe, ronagun(), { level: "hellophaser" });
  return recipe;
}

Deno.test("a secret level's stages are not the game's: its last stage and its stage art stay its own", async () => {
  const recipe = fooWithRonagun();
  const rt = await runtime({ _phaserRecipe: recipe, stageId: 0 });
  assertEquals(rt.lastStageId(recipe), 4);
  assertEquals(rt.isSecretStage(recipe, 4), false);
  assertEquals(rt.isSecretStage(recipe, 5), true);
  // RonaGun's stage 0 plays with stage 0's stock routine, voices and art.
  assertEquals(rt.assetStageId(5), 0);
  assertEquals(rt.assetStageId(3), 3);
});

Deno.test("a beaten game goes on into its secret level, by either ending", async () => {
  const recipe = fooWithRonagun();
  const state: Json = { _phaserRecipe: recipe, stageId: 1 };
  const rt = await runtime(state);
  // Between the game's own stages the story goes on to the next stage.
  assertEquals(rt.sceneAfterStory({ endingFlg: false }), "PhaserGameScene");
  assertEquals(state.stageId, 1);
  // The normal ending: stage 3 cleared without unlocking the secret stage,
  // so the run arrives at stage 4 with the ending decided.
  state.stageId = 4;
  assertEquals(rt.sceneAfterStory({ endingFlg: true }), "PhaserGameScene");
  assertEquals(state.stageId, 5);
  // The secret stage cleared: the run arrives at stage 5, the level's first.
  state.stageId = 5;
  assertEquals(rt.sceneAfterStory({ endingFlg: true }), "PhaserGameScene");
  assertEquals(state.stageId, 5);
  // Past the level's last stage, the game's ending.
  state.stageId = 6;
  assertEquals(rt.sceneAfterStory({ endingFlg: true }), "PhaserEndingScene");
  // A game with no secret level ends where it always did.
  const plain = game();
  const alone = await runtime({ _phaserRecipe: plain, stageId: 4 });
  assertEquals(alone.sceneAfterStory({ endingFlg: true }), "PhaserEndingScene");
});

Deno.test("a secret level's stage fields the level's enemies, and the ship wears its trail", async () => {
  const recipe = fooWithRonagun();
  const rt = await runtime({ _phaserRecipe: recipe, stageId: 5 });
  const view = rt.stageRecipe(recipe, 5);
  assertEquals(Object.keys(view.enemyData), ["enemyAAA"]);
  assertEquals(view.playerData.name, "duke");
  assertEquals(view.playerData.trail.texture, ["hpBlue"]);
  // The recipe the run keeps is not touched.
  assertEquals(recipe.playerData.trail, undefined);
  assertEquals(Object.keys(recipe.enemyData), ["enemyA"]);
  // The game's own stages play the game's recipe as it is.
  assert(rt.stageRecipe(recipe, 2) === recipe);
  // A ship with a trail of its own keeps it.
  recipe.playerData.trail = { texture: ["own"] };
  assertEquals(rt.stageRecipe(recipe, 5).playerData.trail.texture, ["own"]);
});

Deno.test("the game scene, the story scene and the boss read the secret level", async () => {
  const js = await read(BUNDLE);
  const flat = js.replace(/\s+/g, " ");
  for (
    const [needle, why] of [
      [
        "this.recipe = stageRecipe(recipeData(), gameState.stageId || 0);",
        "the game scene plays the game's recipe on a secret stage",
      ],
      [
        "var nextScene = sceneAfterStory(this);",
        "the story scene does not route a beaten game",
      ],
      [
        "var afterEpilogue = sceneAfterStory(this);",
        "the epilogue does not route a beaten game",
      ],
      [
        'var secretLoop = isSecretStage(this.recipe, stageId) && this.textures.exists("secret_loop" + stageId)',
        "a secret stage draws the game's backdrop",
      ],
      [
        "!isImportedLevel() && !isSecretStage(scene.recipe, stageId) && scene.recipe.bossData",
        "the hidden boss can arrive on a secret stage",
      ],
      [
        "GOKI_PATTERN : ownStageId(stageId);",
        "a secret level's boss flies the routine of the game's stage number",
      ],
      [
        "if (secret && stageId === secret.first) {",
        "the secret level opens on no card of its own",
      ],
    ]
  ) assert(flat.includes(needle), why);
});

Deno.test("foo names RonaGun as its secret level, and the editor keeps the field", async () => {
  const foo = JSON.parse(await read("static/games/2028-ai/foo.json"));
  assertEquals(foo.secretLevel, "hellophaser");
  const editor = await read("static/editor/index.html");
  assert(
    editor.includes(
      "payload.secretLevel = (gameData && gameData.secretLevel) || null;",
    ),
    "a cloud SAVE drops secretLevel",
  );
  assert(
    editor.includes("if (d.secretLevel) gameData.secretLevel = d.secretLevel;"),
    "a cloud load forgets secretLevel",
  );
});
