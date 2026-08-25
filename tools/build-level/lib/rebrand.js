"use strict";

// Produces the rebranded config.xml (Cordova), electron package.json and
// manifest.json for one level: display name = level name, package id =
// com.easierbycode.<slug>. Unlike the 2019-es7 original there is no
// phaser-game.html rewrite here — stage.js authors the offline shell directly,
// and its <content src="phaser-game.html"> is already the Cordova default.

const fs = require("fs");

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rebrandConfigXml(sourceXml, levelName, packageId) {
  let xml = fs.readFileSync(sourceXml, "utf8");
  xml = xml.replace(
    /<widget\s+id="[^"]*"/,
    '<widget id="' + xmlEscape(packageId) + '"',
  );
  xml = xml.replace(
    /<name>[\s\S]*?<\/name>/,
    "<name>" + xmlEscape(levelName) + "</name>",
  );
  xml = xml.replace(
    /<content\s+src="[^"]*"\s*\/>/,
    '<content src="phaser-game.html" />',
  );
  return xml;
}

// opts.winTarget picks the electron-builder Windows target (portable by
// default — one self-contained .exe, the closest thing to the AppImage).
function rebrandElectronPackageJson(sourcePath, levelName, packageId, slug, opts) {
  const winTarget = (opts && opts.winTarget) || "portable";
  const pkg = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  pkg.name = slug;
  pkg.productName = levelName;
  pkg.description = levelName;
  pkg.build = pkg.build || {};
  pkg.build.appId = packageId;
  pkg.build.productName = levelName;
  pkg.build.linux = pkg.build.linux || {};
  pkg.build.linux.artifactName = slug + ".AppImage";
  // The scaffold only carries a Linux block; Windows is configured here so the
  // vendored package.json stays exactly as it came from 2019-es7. icon-512.png
  // is fine as a Windows icon — electron-builder converts a >=256px PNG to .ico.
  pkg.build.win = pkg.build.win || {};
  pkg.build.win.target = winTarget;
  pkg.build.win.icon = pkg.build.win.icon || "icons/icon-512.png";
  pkg.build.win.artifactName = slug +
    (winTarget === "zip" ? ".zip" : winTarget === "dir" ? "" : ".exe");
  return pkg;
}

function rebrandManifestJson(sourcePath, levelName) {
  const m = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  m.name = levelName;
  m.short_name = levelName;
  m.start_url = "./phaser-game.html";
  return m;
}

module.exports = {
  rebrandConfigXml,
  rebrandElectronPackageJson,
  rebrandManifestJson,
};
