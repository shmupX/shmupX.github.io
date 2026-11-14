// 2028.Ai's bonus stage: RonaGun's stage, after the secret one.
//
// foo's secret stage (stage 4, the monkey brain) is reached by finishing
// every boss with the CA bomb, the hidden one included, without a continue.
// Clearing it now leads to a bonus stage, stage 5, that is RonaGun's
// (static/games/hellophaser/game.json): every wave of it through to the
// Seductress, Lincoln's thruster on the ship, its own starfield, and Diamond
// Eyes. A stage record's `bonus: true` marks it; the runtime (game.bundle.js,
// a vendored artifact patched by hand — README) plays it with no story and
// counts it as none of the game's own stages, so the last stage, the endings
// and the ROUND cards stay as they were.

import { assert, assertEquals } from "@std/assert";
import { SOUNDTRACK } from "../scripts/2028-ai/stage-bgm.ts";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const LOADER = "static/phaser-plugins/level-loader.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");
const readJson = async (p: string) => JSON.parse(await read(p));

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

type Recipe = Record<string, unknown>;
interface Flow {
  isBonusStage(recipe: Recipe | null, stageId: number): boolean;
  lastStageId(recipe: Recipe | null): number;
  decideEnding(recipe: Recipe | null): boolean;
  cloudStageRecord(src: Recipe): Recipe | null;
  stageRecordFromLevel(src: Recipe): Recipe | null;
  gameState: Record<string, number>;
}

async function flow(): Promise<Flow> {
  const js = await read(BUNDLE);
  const names = [
    "clampStageId",
    "recipeStageIds",
    "isBonusStage",
    "lastStageId",
    "decideEnding",
    "copyBonusStageFields",
    "cloudStageRecord",
    "stageRecordFromLevel",
  ];
  return new Function(
    "var MAX_STAGE_ID = 9;\n" +
      "var gameState = { stageId: 0, akebonoCnt: 0, continueCnt: 0 };\n" +
      "function isImportedLevel() { return false; }\n" +
      "function storyOff() { return false; }\n" +
      names.map((n) => functionSource(js, n)).join("") +
      "\nreturn { isBonusStage, lastStageId, decideEnding, cloudStageRecord, stageRecordFromLevel, gameState };",
  )() as Flow;
}

const stage = { enemylist: [["00"]] };
const RECIPE: Recipe = {
  stage0: stage,
  stage1: stage,
  stage2: stage,
  stage3: stage,
  stage4: stage,
  stage5: { enemylist: [["00"]], bonus: true },
};

Deno.test("the bonus stage follows the secret stage and is none of the game's own", async () => {
  const f = await flow();
  assert(f.isBonusStage(RECIPE, 5));
  assert(!f.isBonusStage(RECIPE, 4));
  assert(!f.isBonusStage(null, 5));
  // The last stage is still the secret one.
  assertEquals(f.lastStageId(RECIPE), 4);
  assertEquals(f.lastStageId({ stage0: stage, stage1: stage }), 1);
  const gs = f.gameState;
  // Stage 4 is the ending unless every boss went down to the CA bomb with
  // no continue, as before.
  Object.assign(gs, { stageId: 4, akebonoCnt: 3, continueCnt: 0 });
  assert(f.decideEnding(RECIPE));
  Object.assign(gs, { stageId: 4, akebonoCnt: 4, continueCnt: 1 });
  assert(f.decideEnding(RECIPE));
  Object.assign(gs, { stageId: 4, akebonoCnt: 4, continueCnt: 0 });
  assert(!f.decideEnding(RECIPE));
  // Clearing it plays the bonus stage, and clearing that, the ending.
  Object.assign(gs, { stageId: 5 });
  assert(!f.decideEnding(RECIPE));
  Object.assign(gs, { stageId: 6 });
  assert(f.decideEnding(RECIPE));
});

Deno.test("both loaders keep a bonus stage's own fields", async () => {
  const f = await flow();
  const src = {
    enemylist: [["00"]],
    bonus: true,
    playerTrail: { texture: ["hpBlue"] },
    backdrop: { loop: "data:a", end: "data:b" },
  };
  for (const rec of [f.cloudStageRecord(src), f.stageRecordFromLevel(src)]) {
    assertEquals(rec?.bonus, true);
    assertEquals(rec?.playerTrail, src.playerTrail);
    assertEquals(rec?.backdrop, src.backdrop);
  }
  assertEquals(f.cloudStageRecord({ enemylist: [["00"]] }), {
    enemylist: [["00"]],
  });
  // The plugin's copy, and its merge: a `stages` of bonus stages alone adds
  // them to the base game's instead of replacing them.
  const loader = await read(LOADER);
  assert(loader.includes("copyBonusStageFields(src, stage);"));
  for (const js of [loader, await read(BUNDLE)]) {
    assert(
      js.includes("if (onlyBonus) break;"),
      "a bonus stage drops the base stages",
    );
  }
});

Deno.test("the game plays the bonus stage with no story, its own card, backdrop and trail", async () => {
  const flat = (await read(BUNDLE)).replace(/\s+/g, " ");
  for (
    const [what, src] of [
      [
        "the story is skipped",
        "if (recipe && isBonusStage(recipe, gameState.stageId)) { this.endingFlg = false;",
      ],
      [
        "its card",
        'var bonusText = this.add.text(GCX6, GCY3, "BONUS STAGE", {',
      ],
      [
        "its backdrop",
        "this.ownBackdrop ? ownBackdrop.loop : bgSuffix + assetStage",
      ],
      ["no corridor over it", "!this.dezaBg && !this.ownBackdrop &&"],
      [
        "the ship's trail",
        "if (stageRecT && stageRecT.playerTrail) pd = Object.assign({}, pd, { trail: stageRecT.playerTrail });",
      ],
      [
        "its end picture",
        "if (ownStage && ownStage.backdrop && scene.textures.exists(ownEnd)) fallbackKey = ownEnd;",
      ],
      ["the backdrops load", "loadStageBackdrops(self, baseRecipe);"],
      [
        "a late backdrop still goes up",
        "if (stageData.backdrop && !this.ownBackdrop) awaitStageBackdrop(this, stageId, stageData);",
      ],
    ]
  ) {
    assert(flat.includes(src), `missing: ${what}`);
  }
});

Deno.test("foo's bonus stage is RonaGun's, every wave through to the Seductress", async () => {
  const foo = await readJson("static/games/2028-ai/foo.json");
  const rona = await readJson("static/games/hellophaser/game.json");
  const bonus = foo.stages.stage5;
  const own = rona.stages.stage0;
  assertEquals(Object.keys(foo.stages), ["stage5"]);
  assertEquals(bonus.bonus, true);
  assertEquals(bonus.enemylist, own.enemylist);
  assertEquals(bonus.waveRows, own.waveRows);
  assertEquals(bonus.waveInterval, own.waveInterval);
  assertEquals(bonus.playerTrail, rona.playerData.trail);
  assertEquals(bonus.backdrop, rona.stageBackgrounds.stage0);
  for (const key of Object.keys(rona.enemyData)) {
    assertEquals(foo.enemyData[key], rona.enemyData[key], key);
  }
  assertEquals(foo.bossData.boss5, rona.bossData.boss0);
  assertEquals(foo.bossData.boss5.name, "seductress");
  // foo's own five stages and its secret boss are untouched.
  for (
    const key of ["boss0", "boss1", "boss2", "boss3", "boss4", "bossExtra"]
  ) {
    assert(foo.bossData[key], key);
  }
  // Every frame the stage draws is in foo's atlas, where RonaGun's had it,
  // under foo's own art.
  const frames = foo.atlasFrames;
  const offset = Math.max(
    ...Object.entries(frames)
      .filter(([k]) => !(k in rona.atlasFrames))
      .map(([, v]) =>
        (v as { frame: { y: number; h: number } }).frame.y +
        (v as { frame: { h: number } }).frame.h
      ),
  );
  for (const [name, rec] of Object.entries(rona.atlasFrames)) {
    const r = rec as { frame: { x: number; y: number; w: number; h: number } };
    assert(frames[name], `no ${name} in foo's atlas`);
    assertEquals(frames[name].frame.x, r.frame.x, name);
    assertEquals(frames[name].frame.w, r.frame.w, name);
    assert(frames[name].frame.y >= offset, `${name} overlaps foo's art`);
  }
  const textures =
    JSON.stringify([rona.enemyData, rona.bossData, rona.playerData.trail])
      .match(/"hp[A-Za-z0-9_]+"/g) ?? [];
  for (const t of new Set(textures)) {
    assert(frames[JSON.parse(t)], `${t} has no frame`);
  }
  // The atlas picture holds them: its PNG header's height.
  const png = Uint8Array.from(
    atob(foo.atlasImageDataURL.split(",")[1].slice(0, 64)),
    (c) => c.charCodeAt(0),
  );
  const height = new DataView(png.buffer).getUint32(20);
  for (const v of Object.values(frames)) {
    const r = v as { frame: { y: number; h: number } };
    assert(r.frame.y + r.frame.h <= height);
  }
});

Deno.test("the bonus stage plays Diamond Eyes", async () => {
  const foo = await readJson("static/games/2028-ai/foo.json");
  assertEquals(
    foo.customAudioURLs.stage5_bgm,
    "https://easierbycode.com/diamond-eyes.mp3",
  );
  assertEquals(SOUNDTRACK.stage5_bgm, foo.customAudioURLs.stage5_bgm);
});
