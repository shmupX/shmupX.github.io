// What an exported level's www/ carries of the game's music.
//
// gs's APK was 66 MB, and 42 MB of it was 2028.Ai's own custom soundtrack:
// stageWww copied the stock game's downloaded custom-bgm/ into every export,
// though the runtime only reads it for keys the level's own customAudioURLs
// names. It also shipped all six stock boss themes for a game with two stages.
// These pin both halves against the real bundle, so a bundle rebuilt with its
// RESOURCE_PATHS reshaped shows up here rather than as a red ERR: banner on a
// phone.

import { assert, assertEquals } from "@std/assert";
import { createRequire } from "node:module";
import { fromFileUrl, join } from "@std/path";

const require = createRequire(import.meta.url);
const { stageWww, unplayedStageBgm } = require(
  fromFileUrl(new URL("../tools/build-level/lib/stage.js", import.meta.url)),
);
const BUNDLE = fromFileUrl(
  new URL("../../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const THEMES = ["bison", "barlog", "sagat", "vega", "fang", "goki"].map((n) =>
  `boss_${n}_bgm`
);
const ENEMYLIST = [["00"]];

Deno.test("a stage plays its slot's theme, and Akuma's only on stage 3", () => {
  // gs: two stages, so bison and barlog and nothing else.
  assertEquals(
    unplayedStageBgm({
      stageKey: "stage0",
      stages: { stage0: {}, stage1: {} },
    }),
    ["boss_sagat_bgm", "boss_vega_bgm", "boss_fang_bgm", "boss_goki_bgm"],
  );
  assertEquals(
    unplayedStageBgm({ stages: { stage3: {} } }),
    ["boss_barlog_bgm", "boss_sagat_bgm", "boss_fang_bgm"],
  );
  // Slots wrap at five; a stage past 9 is not a stage.
  assertEquals(
    unplayedStageBgm({ stageKey: "stage5", stages: { stage12: {} } }),
    THEMES.filter((k) => k !== "boss_bison_bgm"),
  );
});

Deno.test("a level without `stages` keeps every theme", () => {
  // mergeRecipe keeps the base game's stages around a lone stage record.
  assertEquals(unplayedStageBgm({ enemylist: ENEMYLIST }), []);
  assertEquals(unplayedStageBgm(null), []);
});

Deno.test("staging leaves out the stock custom-bgm and the unplayed themes", async () => {
  const root = await Deno.makeTempDir();
  const gameDir = join(root, "game");
  const www = join(root, "www");
  await Deno.mkdir(join(gameDir, "assets", "sounds"), { recursive: true });
  await Deno.mkdir(join(gameDir, "assets", "custom-bgm"), { recursive: true });
  await Deno.mkdir(join(gameDir, "lib"), { recursive: true });
  await Deno.copyFile(BUNDLE, join(gameDir, "game.bundle.js"));
  await Deno.writeTextFile(join(gameDir, "lib", "phaser.min.js"), "");
  for (const key of THEMES) {
    await Deno.writeTextFile(join(gameDir, "assets", "sounds", key + ".mp3"), "");
  }
  await Deno.writeTextFile(
    join(gameDir, "assets", "custom-bgm", "614ade7f06c50da0.mp3"),
    "",
  );

  const log = console.log;
  console.log = () => {};
  try {
    stageWww({
      gameDir,
      wwwRoot: www,
      levelName: "gs",
      levelData: {
        enemylist: ENEMYLIST,
        stageKey: "stage0",
        stages: { stage0: { enemylist: ENEMYLIST }, stage1: { enemylist: ENEMYLIST } },
      },
      gameId: null,
    });
  } finally {
    console.log = log;
  }

  const exists = (p: string) => Deno.stat(p).then(() => true, () => false);
  assert(!(await exists(join(www, "assets", "custom-bgm"))));
  const bundle = await Deno.readTextFile(join(www, "game.bundle.js"));
  for (const key of THEMES) {
    const kept = key === "boss_bison_bgm" || key === "boss_barlog_bgm";
    assertEquals(
      await exists(join(www, "assets", "sounds", key + ".mp3")),
      kept,
      key,
    );
    assertEquals(
      bundle.includes(`${key}: "assets/sounds/${key}.mp3",`),
      kept,
      key + " in RESOURCE_PATHS",
    );
  }
  // Still a script after the lines came out.
  const check = await new Deno.Command("node", {
    args: ["--check", join(www, "game.bundle.js")],
  }).output();
  assert(check.success, new TextDecoder().decode(check.stderr));
});
