"use strict";

// Compiles the staged www/ into an installable Cordova app (android apk / ios
// project). Project scaffolding (hooks, res, icons, plugins) is sourced from the
// tool's vendored scaffold/ dir — see tools/build-level/scaffold — not an
// external checkout.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

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
function run(cmd, args, opts) {
  console.log("$ " + cmd + " " + args.join(" "));
  const r = spawnSync(
    cmd,
    args,
    Object.assign(
      { stdio: "inherit", shell: process.platform === "win32" },
      opts || {},
    ),
  );
  if (r.status !== 0) throw new Error(cmd + " exited " + r.status);
}

// ------------------------------------------------------------------- iOS

// Compile the staged Xcode project and wrap the result as an .ipa.
//
// `cordova prepare ios` is as far as the build used to go, on every host
// including a Mac — so "EXPORT IOS APP" produced a project and nothing else,
// and because nothing was written to dist/ the caller could not tell that from
// a build that had produced an app. On a Mac there is no reason to stop there.
//
// Signing is switched OFF rather than attempted. The alternative is to demand
// an Apple developer account and a provisioning profile before the button does
// anything at all, and the point of this pipeline is that you press one button
// and get a file. An unsigned .ipa is what every sideloading route
// (AltStore, Sideloadly, TrollStore) re-signs anyway, and someone who does have
// a team can open the project and archive it the usual way.
//
// Returns the .ipa path, or null when this host cannot compile one — a missing
// or unusable Xcode is not a build failure, it just means the project is the
// artifact.
function buildIosIpa(iosRoot, buildRoot, outDir, slug) {
  if (process.platform !== "darwin") {
    console.log(
      "iOS: not a Mac, so the build stops at the Xcode project — only " +
        "xcodebuild can compile one.",
    );
    return null;
  }
  // The scheme is named for the app, and cordova writes it into the WORKSPACE
  // (platforms/ios/<App>.xcworkspace/xcshareddata/xcschemes), not the project —
  // so the workspace is what xcodebuild has to be pointed at. Read the name off
  // disk instead of re-deriving it: cordova has already applied its own rules
  // to the level name, and a second guess here would drift from them.
  const workspace = fs.readdirSync(iosRoot).find(function (n) {
    return n.endsWith(".xcworkspace");
  });
  if (!workspace) {
    console.warn("iOS: no .xcworkspace under " + iosRoot + " to build.");
    return null;
  }
  const scheme = workspace.replace(/\.xcworkspace$/, "");
  const derived = path.join(buildRoot, "ios-derived");
  fs.rmSync(derived, { recursive: true, force: true });
  try {
    run("xcodebuild", [
      "-workspace",
      path.join(iosRoot, workspace),
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-sdk",
      "iphoneos",
      "-derivedDataPath",
      derived,
      "CODE_SIGN_IDENTITY=",
      "CODE_SIGNING_REQUIRED=NO",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGN_ENTITLEMENTS=",
      "build",
    ]);
  } catch (err) {
    // Xcode absent, its licence unaccepted, or the project genuinely does not
    // compile. The project is still on disk and still worth handing back, so
    // say why and fall back rather than failing the export.
    console.warn("iOS: xcodebuild failed (" + err.message + ").");
    return null;
  }
  const products = path.join(derived, "Build", "Products", "Debug-iphoneos");
  const app = fs.existsSync(products) &&
    fs.readdirSync(products).find(function (n) {
      return n.endsWith(".app");
    });
  if (!app) {
    console.warn("iOS: xcodebuild wrote no .app under " + products + ".");
    return null;
  }
  // An .ipa is a zip of a Payload/ directory holding the .app — a bare .app is
  // not installable by anything. `cp -R` rather than a JS copy so the bundle's
  // modes and symlinks survive; both it and `zip` ship with macOS, which is the
  // only place this runs.
  const stage = path.join(buildRoot, "ios-ipa");
  fs.rmSync(stage, { recursive: true, force: true });
  const payload = path.join(stage, "Payload");
  fs.mkdirSync(payload, { recursive: true });
  run("cp", ["-R", path.join(products, app), path.join(payload, app)]);
  const ipa = path.join(outDir, slug + ".ipa");
  fs.rmSync(ipa, { force: true });
  run("zip", ["-qry", ipa, "Payload"], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log("iOS: unsigned .ipa at " + ipa);
  return ipa;
}

async function buildCordova(opts) {
  const {
    scaffoldRoot,
    wwwRoot,
    buildRoot,
    levelName,
    packageId,
    slug,
    platform,
    configXml,
  } = opts;
  if (platform !== "android" && platform !== "ios") {
    throw new Error("Unsupported cordova platform: " + platform);
  }

  const cordovaDir = path.join(buildRoot, "cordova");
  fs.mkdirSync(path.dirname(cordovaDir), { recursive: true });

  if (fs.existsSync(cordovaDir)) {
    fs.rmSync(cordovaDir, { recursive: true, force: true });
  }
  run("cordova", ["create", cordovaDir, packageId, levelName]);

  fs.writeFileSync(path.join(cordovaDir, "config.xml"), configXml);
  copyDir(path.join(scaffoldRoot, "hooks"), path.join(cordovaDir, "hooks"));
  copyDir(path.join(scaffoldRoot, "res"), path.join(cordovaDir, "res"));
  copyDir(path.join(scaffoldRoot, "icons"), path.join(cordovaDir, "icons"));

  const dstWww = path.join(cordovaDir, "www");
  if (fs.existsSync(dstWww)) fs.rmSync(dstWww, { recursive: true, force: true });
  copyDir(wwwRoot, dstWww);

  // Inject cordova.js into the shell so plugins are available.
  const htmlPath = path.join(dstWww, "phaser-game.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  if (html.indexOf('src="cordova.js"') === -1) {
    html = html.replace(/<\/head>/, '<script src="cordova.js"></script>\n</head>');
    fs.writeFileSync(htmlPath, html);
  }

  const platformArg = platform === "android" ? "android@14.0.1" : "ios@7.1.1";
  run("cordova", ["platform", "add", platformArg], { cwd: cordovaDir });

  if (platform === "android") {
    const plug = path.join(scaffoldRoot, "plugins", "cordova-plugin-sprite-share");
    if (fs.existsSync(plug)) {
      run("cordova", ["plugin", "add", plug, "--nosave"], { cwd: cordovaDir });
    }
  } else {
    const plug = path.join(scaffoldRoot, "plugins", "cordova-plugin-ios-haptics");
    if (fs.existsSync(plug)) {
      run("cordova", ["plugin", "add", plug, "--nosave"], { cwd: cordovaDir });
    }
  }

  if (platform === "android") {
    run("cordova", ["compile", "android", "--debug", "--packageType=apk"], {
      cwd: cordovaDir,
    });
  } else {
    run("cordova", ["prepare", "ios"], { cwd: cordovaDir });
  }

  const outDir = path.join(buildRoot, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = [];
  if (platform === "android") {
    const apkRoot = path.join(
      cordovaDir,
      "platforms/android/app/build/outputs/apk",
    );
    (function findApks(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        // "._app-debug.apk" ends with .apk like the real thing, so an
        // unfiltered walk copies macOS's 4 KB fork into dist/ and reports it
        // as a built app alongside — or instead of — the APK.
        if (e.name.startsWith("._")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) findApks(full);
        else if (e.isFile() && full.endsWith(".apk")) {
          const dst = path.join(outDir, slug + "-" + e.name);
          copyFile(full, dst);
          artifacts.push(dst);
        }
      }
    })(apkRoot);
  } else {
    // The .ipa when this host could compile one, the Xcode project when it
    // could not. Either way something real goes back: an empty artifact list
    // is what let a build that stopped at a project be reported as a finished
    // app (see findArtifacts in lib/export-build.ts).
    const iosRoot = path.join(cordovaDir, "platforms/ios");
    const ipa = buildIosIpa(iosRoot, buildRoot, outDir, slug);
    artifacts.push(ipa || iosRoot);
  }
  return { artifacts };
}

module.exports = { buildCordova };
