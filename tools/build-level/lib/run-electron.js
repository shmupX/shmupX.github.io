"use strict";

// Compiles the staged www/ into a desktop app via electron-builder: a Linux
// AppImage, a Windows .exe (a single-file `portable` build by default, so it
// mirrors the AppImage — --win-target nsis|zip|dir picks another) or a macOS
// .dmg (--mac-target zip|dir picks another). Electron scaffolding
// (main.js/preload.js/afterPack.js/package.json + icons) comes from the tool's
// vendored scaffold/ dir. main.js loads phaser-game.html over a custom app://
// protocol, so the staged shell name matches.
//
// Cross-building: an AppImage needs a Linux mksquashfs — a Linux host has one,
// a Mac has electron-builder's own copy, and a Windows host borrows WSL's (see
// lib/appimage-bridge.js, which is also what refuses the build when there is no
// WSL to borrow from). ANY Windows target built from Linux needs wine on PATH —
// electron-builder rcedits the packaged .exe (icon + version resources) through
// it, before the target even matters — and a Mac app needs a Mac: hdiutil
// builds the .dmg and codesign signs what goes in it.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { appImageBridge } = require("./appimage-bridge");

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

// Artifact extension per electron-builder target, used to pick the built files
// out of electron/dist/ afterwards.
function artifactExt(platform, winTarget, macTarget) {
  if (platform === "windows") return winTarget === "zip" ? ".zip" : ".exe";
  if (platform === "mac") return macTarget === "zip" ? ".zip" : ".dmg";
  return ".AppImage";
}

async function buildElectron(opts) {
  const { scaffoldRoot, wwwRoot, buildRoot, rebrandedPackageJson } = opts;
  const platform = ["windows", "mac"].includes(opts.platform)
    ? opts.platform
    : "linux";
  if (platform === "mac" && process.platform !== "darwin") {
    throw new Error(
      "building the macOS app needs a macOS host (hdiutil + codesign).",
    );
  }
  // Settled here rather than at the electron-builder call so a host that cannot
  // finish an AppImage says so now, instead of after two npm installs and a
  // full Electron download.
  const bridge = platform === "linux" ? appImageBridge() : null;
  if (bridge && !bridge.ok) throw new Error(bridge.reason);
  if (bridge) console.log(bridge.note);
  const winTarget = opts.winTarget || "portable";
  // electron-builder otherwise packs for the *host* arch, which on an arm64
  // machine silently yields a win32-arm64 app almost nobody can run.
  const winArch = opts.winArch || "x64";
  const macTarget = opts.macTarget || "dmg";
  const macArch = opts.macArch || (process.arch === "arm64" ? "arm64" : "x64");
  // Same trap as winArch, with one difference: a Linux target built ON Linux is
  // normally meant for the machine that built it, so the host arch is the right
  // default there. Cross-built from Windows or a Mac it says nothing about
  // where the AppImage will run — this used to hand a Windows-on-ARM laptop a
  // linux-arm64 AppImage — so x64 is what everyone else gets.
  const linuxArch = opts.linuxArch ||
    (process.platform === "linux" && process.arch === "arm64" ? "arm64" : "x64");
  const perfMode = opts.perfMode !== false;
  const electronSrc = path.join(scaffoldRoot, "electron");
  const electronDir = path.join(buildRoot, "electron");
  fs.mkdirSync(electronDir, { recursive: true });

  for (const f of ["preload.js", "afterPack.js"]) {
    copyFile(path.join(electronSrc, f), path.join(electronDir, f));
  }

  // Patch main.js: prepend Chromium perf flags + F11/Cmd+F fullscreen toggle.
  // No disable-frame-rate-limit / disable-gpu-vsync here: the game ticks on
  // a fixed 120 Hz accumulator, so an uncapped rAF buys nothing, and at the
  // 800+ frames/s it reached on an M-series Mac the renderer starved the
  // compositor — the screen updated a few times a second while the game's
  // own loop ran at full speed (measured 2026-09-05 on the "fighter" build:
  // a 25 s screen capture got 80 frames with the switches, 1438 without).
  let mainJs = fs.readFileSync(path.join(electronSrc, "main.js"), "utf8");
  const perfPreamble = [
    "// ----- Performance Mode (injected by tools/build-level) -----",
    "if (process.env.GEMSHELL_PERF !== '0') {",
    "    try {",
    "        const { app } = require('electron');",
    "        app.commandLine.appendSwitch('disable-renderer-backgrounding');",
    "        app.commandLine.appendSwitch('enable-zero-copy');",
    "    } catch (e) {}",
    "}",
    "",
  ].join("\n");
  const perfPostamble = [
    "",
    "// ----- F11 / Cmd+F fullscreen toggle (injected) -----",
    "try {",
    "    const { app: _app, globalShortcut, BrowserWindow: _BW } = require('electron');",
    "    _app.whenReady().then(() => {",
    "        const toggleFs = () => {",
    "            const w = _BW.getAllWindows()[0];",
    "            if (w) w.setFullScreen(!w.isFullScreen());",
    "        };",
    "        try { globalShortcut.register('F11', toggleFs); } catch (e) {}",
    "        try { globalShortcut.register('CommandOrControl+F', toggleFs); } catch (e) {}",
    "    });",
    "    _app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });",
    "} catch (e) {}",
    "",
  ].join("\n");
  if (perfMode) mainJs = perfPreamble + mainJs + perfPostamble;
  fs.writeFileSync(path.join(electronDir, "main.js"), mainJs);

  copyDir(wwwRoot, path.join(electronDir, "www"));
  copyDir(path.join(scaffoldRoot, "icons"), path.join(electronDir, "icons"));
  fs.writeFileSync(
    path.join(electronDir, "package.json"),
    JSON.stringify(rebrandedPackageJson, null, 2),
  );

  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: electronDir,
  });
  run("npm", [
    "install",
    "--save-dev",
    "--no-audit",
    "--no-fund",
    "electron@^33",
    "electron-builder@^25",
  ], { cwd: electronDir });
  const targetArgs = platform === "windows"
    ? ["--win", winTarget, "--" + winArch]
    : platform === "mac"
    ? ["--mac", macTarget, "--" + macArch]
    : ["--linux", "AppImage", "--" + linuxArch];
  run("npx", ["electron-builder"].concat(targetArgs, ["--publish", "never"]), {
    cwd: electronDir,
    // MKSQUASHFS_PATH, on Windows, so app-builder reaches the WSL stand-in
    // instead of a Linux binary it cannot exec. Nothing to add anywhere else.
    env: Object.assign({}, process.env, (bridge && bridge.env) || {}),
  });

  const distDir = path.join(electronDir, "dist");
  const outDir = path.join(buildRoot, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = [];
  const ext = artifactExt(platform, winTarget, macTarget);
  if (fs.existsSync(distDir)) {
    for (const f of fs.readdirSync(distDir)) {
      if (f.toLowerCase().endsWith(ext.toLowerCase())) {
        copyFile(path.join(distDir, f), path.join(outDir, f));
        artifacts.push(path.join(outDir, f));
      }
    }
  }
  return { artifacts };
}

module.exports = { buildElectron };
