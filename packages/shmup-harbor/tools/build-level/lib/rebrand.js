"use strict";

// Produces the rebranded config.xml (Cordova), electron package.json and
// manifest.json for one level: display name = the record's title, else the
// level name (appTitleFor), package id = com.easierbycode.<slug>. Unlike the
// 2019-es7 original there is no
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

// What the launcher calls the app: the record's `title` when it has one —
// gs's is SQUAD — else the name it was built by. Only the label: the slug and
// the package id stay the build name's, so a game retitled after it was
// installed updates in place rather than landing beside itself.
function appTitleFor(levelName, levelData) {
  const own = levelData && typeof levelData.title === "string"
    ? levelData.title.trim()
    : "";
  return own || levelName;
}

// `entry` is the page the app opens: phaser-game.html for a staged level, a
// web build's own page (e.g. play/index.html) for an eShop web entry.
function rebrandConfigXml(sourceXml, levelName, packageId, entry) {
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
    '<content src="' + xmlEscape(entry || "phaser-game.html") + '" />',
  );
  return xml;
}

function rebrandManifestJson(sourcePath, levelName) {
  const m = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  m.name = levelName;
  m.short_name = levelName;
  m.start_url = "./phaser-game.html";
  return m;
}

module.exports = {
  appTitleFor,
  rebrandConfigXml,
  rebrandManifestJson,
};
