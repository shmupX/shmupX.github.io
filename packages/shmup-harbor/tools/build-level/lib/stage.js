"use strict";

// Stages the offline www/ tree for one exported level, sourcing everything from
// cmg's own in-repo game (static/games/2028-ai) — NOT an external 2019-es7
// checkout. The game code is cmg's already-built game.bundle.js; the custom
// atlas is merged at runtime in the browser by the level-loader ScenePlugin
// (see static/phaser-plugins/level-loader.js), so there is no offline atlas
// baking step here.

const fs = require("fs");
const path = require("path");
const { renderShell } = require("./shell-template");

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// skip(srcPath) leaves an entry, and everything under it, behind.
function copyDir(src, dst, skip) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // macOS's AppleDouble fork of every file, which exFAT gives us no way
    // to avoid. Staged into www/ they become 4 KB of binary wearing an
    // asset's extension, and everything downstream — the cordova copy, the
    // zip, the embedded VFS — carries them into the shipped app.
    if (entry.name.startsWith("._")) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (skip && skip(s)) continue;
    if (entry.isDirectory()) copyDir(s, d, skip);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// The two exact lines emitted by scripts/build-2028-ai.ts from
// scripts/2028-ai/boot-entry.js. The bundle is built un-minified, so these are
// stable string literals — but if the boot-entry constants are renamed/retyped
// the patch below will match nothing and we throw rather than ship a bundle
// that phones home / can't find its assets.
const OFFLINE_PATCHES = [
  {
    from: 'var ASSET_BASE = "/games/2028-ai/";',
    to: 'var ASSET_BASE = "";',
    why: "asset base -> document-relative (assets sit at www/assets)",
  },
  {
    // shmupX's vendored bundle already fetches same-origin (no deploy-origin
    // phone-home); rewrite it to the local staged copy for offline use.
    from: 'var LEVEL_DATA_URL = "/games/2028-ai/foo.json";',
    to: 'var LEVEL_DATA_URL = "foo.json";',
    why: "level source -> local www/foo.json (no network)",
  },
];

// Read cmg's game.bundle.js and rewrite it for offline hosting inside the
// exported app: relative asset base + local level file. With ASSET_BASE="" the
// derived LEVEL_DATA_FALLBACK_URL (= ASSET_BASE + "foo.json") is also local.
function patchBundleForOffline(bundleSrc) {
  let js = fs.readFileSync(bundleSrc, "utf8");
  for (const p of OFFLINE_PATCHES) {
    if (!js.includes(p.from)) {
      throw new Error(
        "game.bundle.js offline patch failed — could not find:\n  " + p.from +
          "\nThe 2028-ai bundle changed; update OFFLINE_PATCHES in " +
          "tools/build-level/lib/stage.js (" + p.why + ").",
      );
    }
    js = js.split(p.from).join(p.to);
  }
  return js;
}

// The whole-game records only a Dezaemon import carries, and the three
// questions the runtime's isImportedLevel() asks. A hand-kept mirror of
// packages/shmup-harbor/lib/imported-level.ts: that module is Deno TypeScript
// and this tool is plain Node with no build step, so the rule is written twice
// rather than shared. tests/imported_level_test.ts pins the two together. A
// soundtrack (dezaemonBgm) is not provenance — web levels carry one too.
const DEZAEMON_KEYS = [
  "dezaemonTitle",
  "dezaemonTitleScreen",
  "dezaemonModels",
  "dezaemonBullets",
  "dezaemonItems",
  "dezaemonCredits",
];

function isImportedRecord(record) {
  if (!record || typeof record !== "object") return false;
  const meta = record.meta;
  if (meta && (meta.source === "dezaemon2" || meta.dezaemonSettings)) return true;
  for (const key of DEZAEMON_KEYS) if (record[key]) return true;
  const enemies = record.enemyData || {};
  for (const key in enemies) if (enemies[key] && enemies[key].dezaemon) return true;
  return false;
}

// A Dezaemon cart has no story, and a record that does not say so opens the app
// on 2028.Ai's hardcoded one. Returns the record to write — a copy when the flag
// had to be added, so nothing else holding it is surprised.
function withImportedNoStory(levelData) {
  if (!levelData || typeof levelData !== "object") return levelData;
  if (levelData.noStory === true || levelData.storyData) return levelData;
  if (!isImportedRecord(levelData)) return levelData;
  console.log("  story: a Dezaemon cart with no story of its own — scenes off.");
  return Object.assign({}, levelData, { noStory: true });
}

// The stock boss themes by asset stage (stageId % 5). The runtime's
// playBossBgm picks a stage's music by its slot, not by its boss, and Akuma's
// theme only plays on stage 3, the one stage he can turn up on.
const STAGE_BGM = ["bison", "barlog", "sagat", "vega", "fang"];

// The stock boss themes a level's stages never play. Only a record with
// `stages` is the whole game: without it mergeRecipe keeps the base game's
// stages around the level's one, and every theme stays.
function unplayedStageBgm(levelData) {
  const stages = levelData && levelData.stages;
  if (!stages || typeof stages !== "object") return [];
  const played = new Set();
  for (const key of [levelData.stageKey || "stage0"].concat(Object.keys(stages))) {
    const m = /^stage(\d+)$/.exec(key);
    // recipeStageIds ignores a stage past 9 the same way.
    if (!m || Number(m[1]) > 9) continue;
    const id = Number(m[1]);
    played.add(STAGE_BGM[id % STAGE_BGM.length]);
    if (id === 3) played.add("goki");
  }
  return STAGE_BGM.concat(["goki"])
    .filter((name) => !played.has(name))
    .map((name) => "boss_" + name + "_bgm");
}

// Leave out the boss themes the level never plays, ~2 MB of mp3 apiece. The
// BootScene preloads every mp3 in RESOURCE_PATHS and pins a red ERR: banner
// over the game for any it cannot load, so a theme comes out of the bundle's
// list and www/ together, or not at all. Returns the keys it left out.
function trimStageBgm(wwwRoot, levelData) {
  const bundlePath = path.join(wwwRoot, "game.bundle.js");
  let js = fs.readFileSync(bundlePath, "utf8");
  const dropped = [];
  for (const key of unplayedStageBgm(levelData)) {
    const file = path.join(wwwRoot, "assets", "sounds", key + ".mp3");
    const entry = new RegExp(
      "\\r?\\n[ \\t]*" + key + ': "assets/sounds/' + key + '\\.mp3",',
    );
    if (!fs.existsSync(file)) continue;
    if (!entry.test(js)) {
      // A bundle that lists its sounds some other way keeps them all: a
      // bigger app, never a broken one.
      console.warn("  bgm: " + key + " not in the bundle's RESOURCE_PATHS; kept.");
      continue;
    }
    js = js.replace(entry, "");
    fs.rmSync(file);
    dropped.push(key);
  }
  if (dropped.length) fs.writeFileSync(bundlePath, js);
  return dropped;
}

// gameDir  = <cmg>/static/games/2028-ai
// gamepad  = <cmg>/static/gamepad-compatibility-plugin.js (optional)
// phaserGlobalShim = <cmg>/static/phaser-plugins/phaser-global.js (optional);
//            staged as www/phaser-global.js, the target of the shell's
//            "phaser" import map
// firebaseConfig   = <cmg>/static/firebase-config.js (optional); staged beside
//            the shell so the app can reach its leaderboard
// wwwRoot  = build/<slug>/www
// levelData= raw Firebase level record (carries atlasImageDataURL/atlasFrames
//            which the runtime plugin composites over the base game_asset atlas)
// gameId   = this level's leaderboard identity; omitted → no board, and the
//            shell leaves the Firebase SDK out entirely
function stageWww(opts) {
  const {
    gameDir,
    gamepad,
    phaserGlobalShim,
    firebaseConfig,
    extractPlugin,
    editorOrigin,
    databaseURL,
    rtdbRoot,
    wwwRoot,
    levelName,
    levelData,
    gameId,
  } = opts;

  fs.rmSync(wwwRoot, { recursive: true, force: true });
  fs.mkdirSync(wwwRoot, { recursive: true });

  // Full asset tree (game_asset/game_ui/title_ui atlases, stage + loading
  // backgrounds, fonts, sounds, game.json) — the same set the hosted game
  // loads, copied wholesale so nothing the BootScene preloads is missing.
  //
  // Except custom-bgm/: that is 2028.Ai's own soundtrack (`deno task build`
  // downloads it from foo.json's customAudioURLs), and the runtime only reads
  // it for keys the LEVEL's customAudioURLs names. Copied in, every export
  // carried its 41 MB track whether it played it or not; a level's own
  // custom BGM is lib/download-bgm.js's to stage.
  //
  // And tone-bank/: the Saturn samples a Dezaemon soundtrack plays on (1.3 MB),
  // which a level without `dezaemonBgm` never asks for.
  const stockCustomBgm = path.join(gameDir, "assets", "custom-bgm");
  const toneBank = path.join(gameDir, "assets", "tone-bank");
  const playsToneBank = !!(levelData && levelData.dezaemonBgm);
  copyDir(path.join(gameDir, "assets"), path.join(wwwRoot, "assets"), (s) =>
    s === stockCustomBgm || (s === toneBank && !playsToneBank));

  // Phaser runtime + the (patched) game bundle.
  copyFile(
    path.join(gameDir, "lib", "phaser.min.js"),
    path.join(wwwRoot, "lib", "phaser.min.js"),
  );

  // The shell's import map points "phaser" here; without it a scene script
  // doing `import Phaser from "phaser"` would fail to resolve offline.
  if (phaserGlobalShim && fs.existsSync(phaserGlobalShim)) {
    copyFile(phaserGlobalShim, path.join(wwwRoot, "phaser-global.js"));
  }

  // EXTRACT MODE: lets the exported app save any paused sprite to the shared
  // character library. Must be emitted after game.bundle.js (see renderShell).
  const hasExtract = !!(extractPlugin && fs.existsSync(extractPlugin));
  if (hasExtract) {
    copyFile(extractPlugin, path.join(wwwRoot, "extract-mode.js"));
  }
  fs.writeFileSync(
    path.join(wwwRoot, "game.bundle.js"),
    patchBundleForOffline(path.join(gameDir, "game.bundle.js")),
  );
  const unplayed = trimStageBgm(wwwRoot, levelData);
  if (unplayed.length) {
    console.log("  bgm: left out " + unplayed.join(", ") + " (no stage plays them)");
  }

  // Controller-compat shim (optional).
  const hasGamepad = !!(gamepad && fs.existsSync(gamepad));
  if (hasGamepad) {
    copyFile(gamepad, path.join(wwwRoot, "gamepad-compatibility-plugin.js"));
  }

  // Leaderboard credentials. Staged rather than inlined so the exported app and
  // the hosted player read the identical file; without it the app still runs,
  // it just keeps its high score to itself.
  const hasFirebase = !!(gameId && firebaseConfig && fs.existsSync(firebaseConfig));
  if (hasFirebase) {
    copyFile(firebaseConfig, path.join(wwwRoot, "firebase-config.js"));
  }

  // The level the patched bundle fetches as foo.json. Keep the full record
  // (including atlasImageDataURL) so the plugin can merge the custom atlas.
  //
  // This is the last door every build goes through, including the one the Deno
  // side cannot reach: `--level-file` is normalized before it gets here, but a
  // record this tool fetched from Firebase itself (index.js's fetchLevel) has
  // touched nothing else. So the no-story rule is applied here too — see
  // packages/shmup-harbor/lib/imported-level.ts for what it is and why.
  fs.writeFileSync(
    path.join(wwwRoot, "foo.json"),
    JSON.stringify(withImportedNoStory(levelData)),
  );

  // Offline entry document. The editor's GOD MODE toggle rides the level
  // record (saved right before the export kicks off), so honoring it here is
  // what makes "god mode on at export time" hold inside the app.
  fs.writeFileSync(
    path.join(wwwRoot, "phaser-game.html"),
    renderShell({
      levelName,
      hasGamepad,
      godMode: !!(levelData && levelData.godMode === true),
      gameId: hasFirebase ? gameId : null,
      hasExtract,
      editorOrigin: editorOrigin || null,
      // Which tree of the shared database is this app's. Baked whether or not
      // firebase-config.js was staged above: EXTRACT MODE publishes from every
      // export, and without it would fall back to the database's root, which
      // is cmg's library (see renderShell).
      databaseURL: databaseURL || null,
      rtdbRoot,
    }),
  );
}

module.exports = {
  stageWww,
  patchBundleForOffline,
  unplayedStageBgm,
  trimStageBgm,
  copyDir,
  copyFile,
  isImportedRecord,
  withImportedNoStory,
};
