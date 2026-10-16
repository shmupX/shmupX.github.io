"use strict";

// The phone as the controller, for the Cordova builds.
//
// When the phone is plugged into a monitor (Pixel Desktop mode, any Android 10+
// phone with DisplayPort over USB-C), cordova-plugin-second-screen moves the
// game onto the external display and shows the touch controller on the phone
// in its place (scaffold/plugins/cordova-plugin-second-screen says how). This
// stages the two things it needs inside www/:
//
//   www/virtual-pad/       the controller page and its module, and pad-shim.js,
//                          which the plugin injects into the game's page to
//                          turn what the controller sends into a gamepad —
//                          the same files the launcher serves from
//                          static/virtual-pad/.
//   www/second-screen.json { layout, entry, title }: which controller to show
//                          (two sticks or a pad) and which page is the game.
//
// stageWebDir is the other half of an eShop web build: its unpacked files
// become www/ as they are.

const fs = require("fs");
const path = require("path");

const PAD_FILES = ["index.html", "virtual-pad.js", "pad-shim.js"];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // macOS AppleDouble files ride along on an exFAT/USB checkout; staged they
    // are binary junk wearing a real file's name.
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function stageSecondScreen(opts) {
  const { cmgRoot, wwwRoot, layout, entry, title } = opts;
  const src = path.join(cmgRoot, "static", "virtual-pad");
  const dst = path.join(wwwRoot, "virtual-pad");
  // Like the tool's other loose files, a missing controller degrades rather
  // than fails: with no second-screen.json the plugin leaves the game where it
  // is.
  const missing = PAD_FILES.filter((n) => !fs.existsSync(path.join(src, n)));
  if (missing.length) {
    console.warn("  second screen: off (" + missing.join(", ") + " not found under " + src + ")");
    return null;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of PAD_FILES) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
  const config = {
    layout: layout === "twin" ? "twin" : "classic",
    entry: String(entry || "index.html").replace(/^\.?\//, ""),
    title: String(title || ""),
  };
  fs.writeFileSync(
    path.join(wwwRoot, "second-screen.json"),
    JSON.stringify(config, null, 2),
  );
  console.log(
    "  second screen: " + config.layout + " controller on the phone, " +
      config.entry + " on the monitor",
  );
  return config;
}

function stageWebDir(opts) {
  const { srcDir, wwwRoot, entry } = opts;
  const page = path.join(srcDir, entry);
  if (!fs.existsSync(page)) {
    throw new Error("the web build has no " + entry + " (looked in " + srcDir + ")");
  }
  fs.rmSync(wwwRoot, { recursive: true, force: true });
  copyDir(srcDir, wwwRoot);
  // The controller's files live at www/virtual-pad/; a build that already has
  // a directory by that name would be overwritten, so say so.
  if (fs.existsSync(path.join(srcDir, "virtual-pad"))) {
    console.warn("  warning: the build's own virtual-pad/ is replaced by the controller's");
  }
  let files = 0;
  (function count(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) count(path.join(dir, e.name));
      else files++;
    }
  })(wwwRoot);
  console.log("  " + files + " file(s) from " + srcDir);
}

module.exports = { stageSecondScreen, stageWebDir };
