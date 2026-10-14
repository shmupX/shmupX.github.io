"use strict";

// The app icon: a game that flies its own ship wears it.
//
// The scaffold's launcher icons are Duke — 2028.Ai's player, the first frame
// of his walk, scaled by whole pixels up to each Android density
// (scaffold/res/android/*.png) and to the PWA sizes (scaffold/icons). A game
// whose player record names frames of its own gets the same treatment from
// ITS first frame. The rule for "its own" is playsOwnShip's in game.bundle.js:
// playerData.texture is set and, unless the record is a Dezaemon import,
// differs from the base game's player as shipped in game.json — so a record
// that merely restates Duke still gets Duke. The pixels come from the level's
// own atlas (atlasImageDataURL + atlasFrames, the frames the editor saved) or,
// for a roster ship the base sheet already has, from game_asset.png. A frame
// this cannot find keeps the scaffold's icons, and says so.
//
// Written under build/<slug>/app-icon/, then copied over the cordova project's
// res/android and icons/ by run-cordova.js, and handed to `deno desktop` by
// run-deno-desktop.js in place of the scaffold's icons dir.

const fs = require("fs");
const path = require("path");
const { decodePng, encodePng, newRaster } = require("./png");
const { isImportedRecord } = require("./stage");

/** Cordova's six legacy launcher densities: config.xml names each one. */
const ANDROID_DENSITIES = {
  ldpi: 36,
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

/** The scaffold/icons files the PWA manifest (and the Mobile shelf) read. */
const SHARED_ICONS = {
  "icon-192.png": 192,
  "icon-512.png": 512,
  "apple-touch-icon.png": 180,
};

/**
 * What the desktop targets want on top (run-deno-desktop.js iconFor): Linux
 * and Windows take icon-512.png, and a Mac .icns is assembled from these
 * three and the 512 — the sizes macOS renders a PNG-backed entry for.
 */
const DESKTOP_ICONS = {
  "icon-32.png": 32,
  "icon-128.png": 128,
  "icon-256.png": 256,
};

// Firebase keys cannot hold "."; the editor writes U+2024 in its place
// (level-loader.js decodeFirebaseKey).
function decodeFirebaseKey(key) {
  return String(key).replace(/․/g, ".");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_e) {
    return null;
  }
}

/**
 * The first frame of the game's own player, or null when the game flies
 * Duke. Mirrors playsOwnShip: an import's player is always its own; a web
 * game's is when its texture list is not the base game's.
 */
function ownPlayerFrameName(levelData, baseRecipe) {
  const pd = levelData && levelData.playerData;
  const own = pd && Array.isArray(pd.texture) ? pd.texture : [];
  if (!own.length || typeof own[0] !== "string" || !own[0]) return null;
  if (!isImportedRecord(levelData)) {
    const bp = baseRecipe && baseRecipe.playerData;
    const stock = bp && Array.isArray(bp.texture) ? bp.texture : [];
    if (own.join("\n") === stock.join("\n")) return null;
  }
  return own[0];
}

/**
 * One frame's rect out of an atlas frame map (TexturePacker hash or array),
 * by name — trying the Firebase spelling and the .gif/.png twin, the way the
 * runtime's merged atlas resolves a name.
 */
function lookupFrame(frames, name) {
  if (!frames || !name) return null;
  const list = Array.isArray(frames)
    ? frames.map((f) => [f && f.filename, f])
    : Object.keys(frames).map((k) => [k, frames[k]]);
  const wanted = new Set([name]);
  const plain = decodeFirebaseKey(name);
  wanted.add(plain);
  if (plain.endsWith(".png")) wanted.add(plain.slice(0, -4) + ".gif");
  else if (plain.endsWith(".gif")) wanted.add(plain.slice(0, -4) + ".png");
  // Exact name first, then the alternates, so a .png replacement and the
  // base .gif it shadows resolve to the replacement.
  for (const candidate of wanted) {
    for (const [key, fd] of list) {
      if (!key || decodeFirebaseKey(key) !== candidate) continue;
      const r = fd && fd.frame;
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      return { x: r.x | 0, y: r.y | 0, w: r.w | 0, h: r.h | 0 };
    }
  }
  return null;
}

/** The PNG bytes of a data: URL, or null when it is not a PNG. */
function pngFromDataUrl(url) {
  const m = /^data:image\/png;base64,([\s\S]+)$/.exec(String(url || ""));
  return m ? Buffer.from(m[1], "base64") : null;
}

/** Copy `rect` out of `sheet` as its own raster; null when it falls outside. */
function cutFrame(sheet, rect) {
  if (
    rect.x < 0 || rect.y < 0 || rect.x + rect.w > sheet.width ||
    rect.y + rect.h > sheet.height
  ) {
    return null;
  }
  const out = newRaster(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * sheet.width + rect.x) * 4;
    out.data.set(sheet.data.subarray(src, src + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/** Drop fully transparent rows and columns around the sprite. */
function trimTransparent(r) {
  let x0 = r.width, y0 = r.height, x1 = -1, y1 = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null; // nothing but air
  return cutFrame(r, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

/** Nearest-neighbour resample — pixel art stays pixel art. */
function scaleNearest(src, w, h) {
  const out = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const s = (sy * src.width + sx) * 4;
      const d = (y * w + x) * 4;
      out.data[d] = src.data[s];
      out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2];
      out.data[d + 3] = src.data[s + 3];
    }
  }
  return out;
}

/**
 * The sprite centred on a transparent size×size canvas, blown up by the
 * largest whole factor that fits (a fractional one shimmers) — or, when it is
 * bigger than the canvas, shrunk to fit.
 */
function fitInto(sprite, size) {
  const fit = Math.min(size / sprite.width, size / sprite.height);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  const w = Math.max(1, Math.round(sprite.width * scale));
  const h = Math.max(1, Math.round(sprite.height * scale));
  const scaled = scaleNearest(sprite, w, h);
  const out = newRaster(size, size);
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    out.data.set(
      scaled.data.subarray(y * w * 4, (y + 1) * w * 4),
      ((oy + y) * size + ox) * 4,
    );
  }
  return out;
}

/**
 * The game's own player, first frame, as a raster — with where it came from —
 * or null (with a reason) when the game flies Duke or the frame is nowhere to
 * be found.
 *
 *   levelData — the level record
 *   gameDir   — the base game (static/games/2028-ai): assets/game.json is the
 *               base recipe, assets/game_asset.json + its image the base sheet
 */
function playerSprite(levelData, gameDir) {
  const baseRecipe = readJson(path.join(gameDir, "assets", "game.json"));
  const name = ownPlayerFrameName(levelData, baseRecipe);
  if (!name) return { sprite: null, name: null, from: null, why: "flies Duke" };

  // The level's own atlas first: that is where the editor put the frames it
  // saved, and an incoming frame wins over the base sheet's on a collision.
  const levelRect = lookupFrame(levelData.atlasFrames, name);
  if (levelRect) {
    const png = pngFromDataUrl(levelData.atlasImageDataURL);
    if (png) {
      try {
        const sprite = cutFrame(decodePng(png), levelRect);
        if (sprite) return { sprite, name, from: "the game's atlas", why: null };
      } catch (err) {
        return { sprite: null, name, from: null, why: "atlas: " + err.message };
      }
    }
  }

  // Then the base sheet: a roster ship or a character the base game has.
  const sheetJson = readJson(path.join(gameDir, "assets", "game_asset.json"));
  const baseRect = sheetJson && lookupFrame(sheetJson.frames, name);
  if (baseRect) {
    const image = sheetJson.meta && sheetJson.meta.image
      ? sheetJson.meta.image
      : "img/game_asset.png";
    try {
      const sheet = decodePng(fs.readFileSync(path.join(gameDir, "assets", image)));
      const sprite = cutFrame(sheet, baseRect);
      if (sprite) return { sprite, name, from: "the base game's sheet", why: null };
    } catch (err) {
      return { sprite: null, name, from: null, why: "sheet: " + err.message };
    }
  }
  return { sprite: null, name, from: null, why: "frame not in any atlas" };
}

/**
 * Build the icon set for a level under `outDir` (cleared first). Returns
 * { dir, name, from, files } when the game has a ship of its own, else null
 * with a line on the console saying why Duke stays.
 */
function writeAppIcon(opts) {
  const { levelData, gameDir, outDir, log } = opts;
  const say = log || function (s) { console.log(s); };
  const found = playerSprite(levelData, gameDir);
  if (!found.sprite) {
    if (found.name) {
      say("  icon: " + found.name + " — " + found.why + "; Duke stays.");
    } else {
      say("  icon: Duke (the base game's player).");
    }
    return null;
  }
  const sprite = trimTransparent(found.sprite);
  if (!sprite) {
    say("  icon: " + found.name + " is fully transparent; Duke stays.");
    return null;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "android"), { recursive: true });
  const files = [];
  const write = function (file, raster) {
    fs.writeFileSync(file, encodePng(raster));
    files.push(file);
  };
  // The frame itself, for a look (and for anything that wants the pixels).
  write(path.join(outDir, "source.png"), sprite);
  for (const density of Object.keys(ANDROID_DENSITIES)) {
    write(
      path.join(outDir, "android", density + ".png"),
      fitInto(sprite, ANDROID_DENSITIES[density]),
    );
  }
  for (const file of Object.keys(SHARED_ICONS)) {
    write(path.join(outDir, file), fitInto(sprite, SHARED_ICONS[file]));
  }
  for (const file of Object.keys(DESKTOP_ICONS)) {
    write(path.join(outDir, file), fitInto(sprite, DESKTOP_ICONS[file]));
  }
  fs.writeFileSync(
    path.join(outDir, "icon.json"),
    JSON.stringify(
      {
        frame: found.name,
        from: found.from,
        size: { w: sprite.width, h: sprite.height },
      },
      null,
      2,
    ),
  );
  say(
    "  icon: " + found.name + " (" + sprite.width + "×" + sprite.height +
      ", the game's own ship, from " + found.from + ")",
  );
  return { dir: outDir, name: found.name, from: found.from, files };
}

/**
 * Lay an icon set written by writeAppIcon over a cordova project: the six
 * densities into res/android/ and the shared sizes into icons/, where the
 * scaffold's copies of Duke already sit.
 */
function applyAppIcon(iconDir, cordovaDir) {
  if (!iconDir) return false;
  let copied = 0;
  for (const density of Object.keys(ANDROID_DENSITIES)) {
    const src = path.join(iconDir, "android", density + ".png");
    if (!fs.existsSync(src)) continue;
    const dst = path.join(cordovaDir, "res", "android", density + ".png");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  for (const file of Object.keys(SHARED_ICONS)) {
    const src = path.join(iconDir, file);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(cordovaDir, "icons", file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  return copied > 0;
}

module.exports = {
  ANDROID_DENSITIES,
  SHARED_ICONS,
  DESKTOP_ICONS,
  ownPlayerFrameName,
  lookupFrame,
  playerSprite,
  writeAppIcon,
  applyAppIcon,
  // for tests
  fitInto,
  trimTransparent,
  scaleNearest,
};
