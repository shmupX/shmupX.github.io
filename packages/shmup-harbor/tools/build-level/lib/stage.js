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

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
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
  copyDir(path.join(gameDir, "assets"), path.join(wwwRoot, "assets"));

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
  fs.writeFileSync(
    path.join(wwwRoot, "foo.json"),
    JSON.stringify(levelData),
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
    }),
  );
}

module.exports = { stageWww, patchBundleForOffline, copyDir, copyFile };
