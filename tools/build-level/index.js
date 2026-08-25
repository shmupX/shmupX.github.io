#!/usr/bin/env node
"use strict";

// Build a standalone Cordova (android/ios) or Electron (linux) app from a single
// Firebase level, using cmg's OWN in-repo game (static/games/2028-ai) as the
// source — no external 2019-es7 checkout, no CMG_ES7_REPO. Invoked by
// routes/api/build-apk.ts (the level editor's "Export to APK" button).
//
// Usage:
//   node tools/build-level <levelName> <android|ios|linux|all> [flags]
//
// Flags:
//   --stage-only      Stage www/ and stop (no native compile). Verifiable
//                     without cordova/Android SDK/electron-builder.
//   --out <dir>       Override build root (default: <cmg>/build/<slug>)
//   --package-id <id> Override package id (default: com.easierbycode.<slug>)
//   --skip-bgm        Skip custom BGM downloads
//   --level-file <p>  Read the level record from a local JSON file instead of
//                     Firebase (offline staging / tests).
//
// Pipeline:
//   1. Fetch the level record (Firebase REST, or --level-file).
//   2. Stage www/: cmg assets + patched game.bundle.js + foo.json + shell.
//      (The custom atlas is merged at runtime by the level-loader plugin.)
//   3. Download custom BGM into www/assets/custom-bgm/.
//   4. Rebrand config.xml / electron package.json / manifest.json.
//   5. cordova compile / electron-builder → build/<slug>/dist/.

const fs = require("fs");
const path = require("path");

const { slugify, packageIdFor } = require("./lib/slug");
const { fetchLevel } = require("./lib/fetch-level");
const { downloadBgmForLevel } = require("./lib/download-bgm");
const { stageWww } = require("./lib/stage");
const { gameIdForLevel } = require("./lib/game-id");
const {
  rebrandConfigXml,
  rebrandElectronPackageJson,
  rebrandManifestJson,
} = require("./lib/rebrand");
const { buildCordova } = require("./lib/run-cordova");
const { buildElectronLinux } = require("./lib/run-electron");

const CMG_ROOT = path.resolve(__dirname, "..", "..");
const GAME_DIR = process.env.CMG_GAME_DIR ||
  path.join(CMG_ROOT, "static", "games", "2028-ai");
const GAMEPAD_PLUGIN = path.join(
  CMG_ROOT,
  "static",
  "gamepad-compatibility-plugin.js",
);
// Shim the offline shell's import map points "phaser" at, so inline scene
// scripts resolve a bare `import Phaser from "phaser"` with no network.
const PHASER_GLOBAL_SHIM = path.join(
  CMG_ROOT,
  "static",
  "phaser-plugins",
  "phaser-global.js",
);
// Leaderboard credentials, shared verbatim with the hosted player so an
// exported app scores to the same database.
const FIREBASE_CONFIG_SCRIPT = path.join(CMG_ROOT, "static", "firebase-config.js");
const SCAFFOLD_ROOT = path.join(__dirname, "scaffold");

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const takesValue = new Set(["out", "package-id", "level-file"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (takesValue.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        out.flags[key] = argv[++i];
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const levelName = args._[0];
  const platformArg = (args._[1] || "android").toLowerCase();
  if (!levelName) {
    console.error(
      "Usage: node tools/build-level <levelName> <android|ios|linux|all> " +
        "[--stage-only] [--out DIR] [--package-id ID] [--skip-bgm] " +
        "[--level-file PATH]",
    );
    process.exit(2);
  }
  const platforms = platformArg === "all"
    ? ["linux", "android", "ios"]
    : [platformArg];
  for (const p of platforms) {
    if (!["ios", "android", "linux"].includes(p)) {
      console.error("Unknown platform: " + p);
      process.exit(2);
    }
  }

  // Sanity-check the game source is present before doing any work.
  const bundle = path.join(GAME_DIR, "game.bundle.js");
  if (!fs.existsSync(bundle)) {
    console.error(
      "game source not found: " + bundle +
        "\nExpected cmg's 2028-ai game at " + GAME_DIR +
        " (set CMG_GAME_DIR to override).",
    );
    process.exit(4);
  }

  const slug = slugify(levelName);
  const packageId = args.flags["package-id"] || packageIdFor(levelName);
  const buildRoot = path.resolve(
    args.flags.out || path.join(CMG_ROOT, "build", slug),
  );
  const wwwRoot = path.join(buildRoot, "www");

  console.log("Level    : " + levelName);
  console.log("Slug     : " + slug);
  console.log("Package  : " + packageId);
  console.log("Game src : " + GAME_DIR);
  console.log("Build    : " + buildRoot);
  console.log("Platforms: " + platforms.join(", "));

  // 1. Level record
  console.log("\n[1/4] Loading level record…");
  let levelData;
  if (args.flags["level-file"]) {
    levelData = JSON.parse(fs.readFileSync(args.flags["level-file"], "utf8"));
    console.log("  from file: " + args.flags["level-file"]);
  } else {
    try {
      levelData = await fetchLevel(levelName);
    } catch (err) {
      console.error("ERROR: " + err.message);
      process.exit(err.code === "LEVEL_NOT_FOUND" ? 3 : 1);
    }
  }

  // 2. Stage www
  console.log("\n[2/4] Staging offline www/ from cmg's 2028-ai game…");
  // The level's leaderboard identity. The editor mints it onto the record the
  // first time the level is saved (and Export to APK saves first), so this is
  // normally just a read; a record predating gameId falls back to a stable id
  // derived from its name, which is what the hosted player derives too.
  const gameId = gameIdForLevel(levelData);
  console.log("  leaderboard: " + (gameId ? gameId : "(none — level has no name)"));

  stageWww({
    gameDir: GAME_DIR,
    gamepad: GAMEPAD_PLUGIN,
    phaserGlobalShim: PHASER_GLOBAL_SHIM,
    firebaseConfig: FIREBASE_CONFIG_SCRIPT,
    wwwRoot,
    levelName,
    levelData,
    gameId,
  });

  // 3. Custom BGM
  if (args.flags["skip-bgm"]) {
    console.log("\n[3/4] Skipping BGM download (--skip-bgm).");
  } else {
    console.log("\n[3/4] Downloading custom BGM…");
    try {
      const r = await downloadBgmForLevel(
        levelData,
        path.join(wwwRoot, "assets", "custom-bgm"),
      );
      console.log("  bgm files: " + r.downloaded);
    } catch (err) {
      console.warn("  BGM download failed (non-fatal): " + err.message);
    }
  }

  if (args.flags["stage-only"]) {
    console.log("\n--stage-only: www staged at " + wwwRoot);
    return;
  }

  // 4. Platform builds
  console.log("\n[4/4] Platform builds…");
  const results = {};
  const rebrandedConfig = rebrandConfigXml(
    path.join(SCAFFOLD_ROOT, "config.xml"),
    levelName,
    packageId,
  );
  for (const p of platforms) {
    console.log("\n--- " + p.toUpperCase() + " ---");
    try {
      if (p === "linux") {
        const pkg = rebrandElectronPackageJson(
          path.join(SCAFFOLD_ROOT, "electron", "package.json"),
          levelName,
          packageId,
          slug,
        );
        results.linux = await buildElectronLinux({
          scaffoldRoot: SCAFFOLD_ROOT,
          wwwRoot,
          buildRoot,
          rebrandedPackageJson: pkg,
        });
      } else {
        results[p] = await buildCordova({
          scaffoldRoot: SCAFFOLD_ROOT,
          wwwRoot,
          buildRoot,
          levelName,
          packageId,
          slug,
          platform: p,
          configXml: rebrandedConfig,
        });
      }
    } catch (err) {
      console.error(p + " build failed: " + err.message);
      process.exitCode = 1;
    }
  }

  // Rebranded manifest for reference (shell links ./phaser-game.html).
  try {
    const m = rebrandManifestJson(
      path.join(SCAFFOLD_ROOT, "manifest.json"),
      levelName,
    );
    fs.writeFileSync(
      path.join(wwwRoot, "manifest.json"),
      JSON.stringify(m, null, 2),
    );
  } catch (_e) { /* manifest optional */ }

  console.log("\nDone. Artifacts:");
  for (const p of Object.keys(results)) {
    for (const a of (results[p].artifacts || [])) {
      console.log("  " + p + "  " + a);
    }
  }
}

main().catch(function (err) {
  console.error("FATAL:", (err && err.stack) || err);
  process.exit(1);
});
