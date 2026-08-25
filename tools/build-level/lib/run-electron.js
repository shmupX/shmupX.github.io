"use strict";

// Compiles the staged www/ into a desktop app via electron-builder: a Linux
// AppImage or a Windows .exe (a single-file `portable` build by default, so it
// mirrors the AppImage — --win-target nsis|zip|dir picks another). Electron
// scaffolding (main.js/preload.js/afterPack.js/package.json + icons) comes from
// the tool's vendored scaffold/ dir. main.js loads phaser-game.html over a
// custom app:// protocol, so the staged shell name matches.
//
// Cross-building: an AppImage needs a Linux host, and ANY Windows target built
// from Linux needs wine on PATH — electron-builder rcedits the packaged .exe
// (icon + version resources) through it, before the target even matters.

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

// Artifact extension per electron-builder target, used to pick the built files
// out of electron/dist/ afterwards.
function artifactExt(platform, winTarget) {
  if (platform !== "windows") return ".AppImage";
  return winTarget === "zip" ? ".zip" : ".exe";
}

async function buildElectron(opts) {
  const { scaffoldRoot, wwwRoot, buildRoot, rebrandedPackageJson } = opts;
  const platform = opts.platform === "windows" ? "windows" : "linux";
  const winTarget = opts.winTarget || "portable";
  // electron-builder otherwise packs for the *host* arch, which on an arm64
  // machine silently yields a win32-arm64 app almost nobody can run.
  const winArch = opts.winArch || "x64";
  const perfMode = opts.perfMode !== false;
  const electronSrc = path.join(scaffoldRoot, "electron");
  const electronDir = path.join(buildRoot, "electron");
  fs.mkdirSync(electronDir, { recursive: true });

  for (const f of ["preload.js", "afterPack.js"]) {
    copyFile(path.join(electronSrc, f), path.join(electronDir, f));
  }

  // Patch main.js: prepend Chromium perf flags + F11/Cmd+F fullscreen toggle.
  let mainJs = fs.readFileSync(path.join(electronSrc, "main.js"), "utf8");
  const perfPreamble = [
    "// ----- Performance Mode (injected by tools/build-level) -----",
    "if (process.env.GEMSHELL_PERF !== '0') {",
    "    try {",
    "        const { app } = require('electron');",
    "        app.commandLine.appendSwitch('disable-frame-rate-limit');",
    "        app.commandLine.appendSwitch('disable-gpu-vsync');",
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
    : ["--linux", "AppImage"];
  run("npx", ["electron-builder"].concat(targetArgs, ["--publish", "never"]), {
    cwd: electronDir,
  });

  const distDir = path.join(electronDir, "dist");
  const outDir = path.join(buildRoot, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = [];
  const ext = artifactExt(platform, winTarget);
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
