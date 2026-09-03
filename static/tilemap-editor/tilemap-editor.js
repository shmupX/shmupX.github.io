// tilemap-editor.js — the SpriteX Tilemap Editor, mirrored into shmupX.
//
// The editing core is spriteX's TILEMAP tab (github.com/easierbycode/spriteX,
// src/tilemapEditor.ts) ported to plain JS: a Tiled JSON map + tileset PNG
// (+ external tileset JSON) on a zoomable canvas, tile and object layers,
// place / erase / pick, one undo per stroke, download, and tilemaps/* in the
// Realtime Database. On top of that, three things this repo needs:
//
//   ORIENTATION   the same map viewed as the game scrolls it. A Dezaemon stage
//                 is a 14-column x 768-row tile grid whose row 0 is where the
//                 stage STARTS — the runtime draws it at the bottom and scrolls
//                 up (game.bundle.js buildStageBackground), and a horizontal
//                 cart is that same grid rotated a quarter turn. VERTICAL puts
//                 the start at the bottom, HORIZONTAL at the left; NATIVE is
//                 the Tiled map as authored. All three edit one set of cells.
//   LEVEL SCENERY a cloud level's stage.background ({cols, rows, tiles: base64
//                 u16be words — bits 0-9 index backgroundCells, bit 15 h-flip,
//                 bit 14 v-flip as the runtime reads them, 0xFFFF empty}) over
//                 its backgroundCells frames, loaded from levels/* or handed
//                 over by an open Level Editor, and written back either way.
//   PIXEL SPRITES pixelSprites/* (the Pixel Editor's records) as a live tile
//                 source: every 16x16 cell of every sprite is a tile the map
//                 can take, and taking one appends it to the map's tileset —
//                 for a level, to its backgroundCells and level atlas.
//
// The TILESET EXTRACTOR tab lives in tileset-extractor.js.

import { initTilesetExtractor } from "./tileset-extractor.js";

const $ = (id) => document.getElementById(id);

let E = null;
try {
  E = await import("/engine/shmup-engine.js");
} catch (err) {
  console.warn("shmup-engine bundle unavailable — pixel-sprite tiles disabled:", err);
}

/** ====================== GID flip-flag masks ==================== */
const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

/** ====================== Dezaemon scenery geometry ============== */
const TILE = 16;
const BG_COLS = 14;
const BG_ROWS = 768;
const BG_PART_ROWS = 16;
const BG_EMPTY = 0xffff;
const BASE_ATLAS_JSON = "/games/2028-ai/assets/game_asset.json";
const BASE_ATLAS_PNG = "/games/2028-ai/assets/img/game_asset.png";
const EDITOR_CHANNEL = "editor-viewer-bridge";

/** ============================ State ============================ */
let map = null;
let mapFileName = "";
let tilesetImage = null; // HTMLImageElement | HTMLCanvasElement
let tilesetImageDataURL = "";
let externalTilesetJson = null;

const ts = { firstgid: 1, name: "tiles", tilewidth: 8, tileheight: 8, margin: 0, spacing: 0, columns: 1, tilecount: 0 };
let collideByTileId = new Map();
let flatLayers = [];
let activeLayerIndex = 0;
let selectedGid = 1; // 0 = eraser
let cursor = { cx: 0, cy: 0 }; // MAP cell
let zoom = 3;
let showGrid = true;
let inspectedObject = null;
let mapDirty = false;
let strokeActive = false;
let strokePushed = false;
let placeFlipH = false;
let placeFlipV = false;
let orientation = "native"; // native | vertical | horizontal
const PALETTE_SCALE = 2;
const undoStack = [];
const UNDO_LIMIT = 60;

let pendingMapJson = null;
let pendingMapName = "";
let pendingTilesetJson = null;
let pendingPngDataURL = "";
let pendingPngName = "";

let baseCanvas, baseCtx, overlayCanvas, overlayCtx;

// Tile palette source: this map's tileset, or the live pixel sprites.
let paletteSource = "tileset";
let pixelTiles = []; // [{ id, key, frame, cx, cy, canvas, name }]
let selectedPixelTile = -1;

// A cloud level's scenery session (or one handed over by the Level Editor).
let level = null;

function setStatus(msg) {
  const el = $("sxStatusLine");
  if (el) el.textContent = msg;
}
function levelNote(msg, warn = false) {
  const el = $("levelNote");
  if (!el) return;
  el.textContent = msg;
  el.style.color = warn ? "#ff9a9a" : "";
}

/** =========================== Firebase ========================== */
let db = null;
function getDb() {
  if (db) return db;
  try {
    if (typeof firebase === "undefined" || !window.__FIREBASE_CONFIG__) return null;
    const app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(window.__FIREBASE_CONFIG__);
    db = firebase.database(app);
  } catch (err) {
    console.warn("Firebase unavailable:", err);
    db = null;
  }
  return db;
}
const DB_URL = (window.__FIREBASE_CONFIG__ && window.__FIREBASE_CONFIG__.databaseURL) || "https://evil-invaders-default-rtdb.firebaseio.com";
// level-loader.js's key encoding: "." becomes U+2024 in a frame key.
const encodeKey = (k) => k.replace(/\./g, "․");
const decodeKey = (k) => k.replace(/․/g, ".");

/** =========================== Helpers =========================== */
const isTileLayer = (l) => l.type === "tilelayer";
const isObjectLayer = (l) => l.type === "objectgroup";

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}
function sanitizeKey(name) {
  return name.replace(/[.#$\[\]\/]/g, "_");
}
function ensureDataURL(s) {
  return typeof s === "string" && s.startsWith("data:") ? s : "data:image/png;base64," + s;
}

function rebuildFlatLayers() {
  flatLayers = [];
  if (!map) return;
  const walk = (layers, depth, groupVisible, groupOpacity, prefix) => {
    for (const l of layers) {
      if (l.type === "group") {
        walk(l.layers || [], depth + 1, groupVisible && l.visible !== false, groupOpacity * (l.opacity ?? 1), `${prefix}${l.name || "group"}/`);
      } else {
        flatLayers.push({ layer: l, depth, groupVisible, groupOpacity, label: `${prefix}${l.name || "layer"}` });
      }
    }
  };
  walk(map.layers, 0, true, 1, "");
}
const activeLayer = () => flatLayers[activeLayerIndex]?.layer || null;
function forEachLayer(fn) {
  for (const fl of flatLayers) fn(fl.layer);
}
function maxObjectId() {
  let m = 0;
  forEachLayer((l) => {
    if (!isObjectLayer(l)) return;
    for (const o of l.objects || []) m = Math.max(m, o.id || 0);
  });
  return m;
}
function maxLayerId() {
  let m = 0;
  if (!map) return m;
  const walk = (layers) => {
    for (const l of layers) {
      m = Math.max(m, l.id || 0);
      if (l.type === "group") walk(l.layers || []);
    }
  };
  walk(map.layers);
  return m;
}
const layerData = (layer) => (Array.isArray(layer.data) ? layer.data : []);

function decodeLayerDataInPlace(layer) {
  if (Array.isArray(layer.data)) return;
  if (typeof layer.data === "string") {
    if (layer.compression) {
      throw new Error(`Layer "${layer.name}" uses compressed tile data (${layer.compression}); re-export from Tiled as CSV or uncompressed base64.`);
    }
    const bin = atob(layer.data);
    const out = new Array(Math.floor(bin.length / 4));
    for (let i = 0; i < out.length; i++) {
      const j = i * 4;
      out[i] = (bin.charCodeAt(j) | (bin.charCodeAt(j + 1) << 8) | (bin.charCodeAt(j + 2) << 16) | (bin.charCodeAt(j + 3) << 24)) >>> 0;
    }
    layer.data = out;
    delete layer.encoding;
    delete layer.compression;
  }
}
function tilePropertiesSource() {
  const ext = externalTilesetJson;
  if (ext && Array.isArray(ext.tiles)) return ext.tiles;
  const entry = map?.tilesets?.[0];
  if (entry && Array.isArray(entry.tiles)) return entry.tiles;
  return [];
}
function rebuildCollideMap() {
  collideByTileId = new Map();
  for (const t of tilePropertiesSource()) {
    const prop = (t.properties || []).find((p) => p.name === "collide");
    if (prop) collideByTileId.set(t.id, !!prop.value);
  }
}

/** ===================== Orientation (view) ====================== */
// Map cell <-> display cell. The map is always stored native (Tiled: row 0
// at the top); the view lays it out the way the game scrolls it.
function displaySize() {
  if (!map) return { cols: 0, rows: 0 };
  return orientation === "horizontal" ? { cols: map.height, rows: map.width } : { cols: map.width, rows: map.height };
}
function displayTile() {
  if (!map) return { w: 8, h: 8 };
  return orientation === "horizontal" ? { w: map.tileheight, h: map.tilewidth } : { w: map.tilewidth, h: map.tileheight };
}
function mapToDisplay(cx, cy) {
  if (orientation === "vertical") return { dx: cx, dy: map.height - 1 - cy };
  if (orientation === "horizontal") return { dx: cy, dy: cx };
  return { dx: cx, dy: cy };
}
function displayToMap(dx, dy) {
  if (orientation === "vertical") return { cx: dx, cy: map.height - 1 - dy };
  if (orientation === "horizontal") return { cx: dy, cy: dx };
  return { cx: dx, cy: dy };
}
function setOrientation(o) {
  orientation = o;
  document.querySelectorAll("#orientSeg .btn").forEach((b) => b.classList.toggle("active", b.dataset.orient === o));
  if (!map) return;
  resizeCanvases();
  rebuildBase();
  drawTilemapOverlay();
  updateInfoChip();
  updatePartControls();
  setStatus(`VIEW · ${o.toUpperCase()}${o === "vertical" ? " · START AT THE BOTTOM, SCROLLS UP" : o === "horizontal" ? " · START AT THE LEFT, SCROLLS RIGHT" : ""}`);
}

/** ====================== Loading / files ======================== */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsText(file);
  });
}
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
}
const looksLikeMap = (json) => json && (json.type === "map" || (Array.isArray(json.layers) && json.width != null));
const looksLikeTileset = (json) => json && (json.type === "tileset" || (json.columns != null && json.image != null && json.layers == null));

async function tilemapLoadFiles(files) {
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith(".png") || file.type === "image/png") {
        pendingPngDataURL = await readFileAsDataURL(file);
        pendingPngName = file.name;
      } else if (lower.endsWith(".json") || file.type === "application/json") {
        const json = JSON.parse(await readFileAsText(file));
        if (looksLikeMap(json)) {
          pendingMapJson = json;
          pendingMapName = file.name.replace(/\.json$/i, "");
        } else if (looksLikeTileset(json)) {
          pendingTilesetJson = json;
        } else {
          setStatus(`UNRECOGNIZED JSON: ${file.name.toUpperCase()}`);
        }
      }
    } catch (err) {
      console.error(err);
      setStatus(`FAILED TO READ ${file.name.toUpperCase()}`);
    }
  }
  if (pendingMapJson && pendingPngDataURL) {
    await initFromPending();
    refreshFileStatus();
    return;
  }
  if (map && pendingTilesetJson && !pendingMapJson && !pendingPngDataURL) {
    externalTilesetJson = pendingTilesetJson;
    pendingTilesetJson = null;
    resolveTilesetParams();
    rebuildCollideMap();
    rebuildBase();
    drawTilemapOverlay();
    renderPalette();
    updatePaletteInfo();
    setStatus("TILESET JSON APPLIED");
  }
  refreshFileStatus();
}

function refreshFileStatus() {
  const el = $("tilemapFileStatus");
  if (!el) return;
  if (map && !pendingMapJson && !pendingPngDataURL) {
    el.textContent = level ? `LEVEL ${level.name.toUpperCase()} · ${level.stageKey.toUpperCase()} SCENERY` : `LOADED: ${mapFileName} — DROP NEW FILES TO REPLACE`;
    return;
  }
  const needsExternal = !!pendingMapJson?.tilesets?.[0]?.source;
  el.textContent = [
    pendingMapJson ? `MAP: ${pendingMapName}` : "MAP: missing",
    pendingTilesetJson ? "TILESET JSON: ok" : needsExternal ? `TILESET JSON: required (${pendingMapJson.tilesets[0].source})` : "TILESET JSON: optional",
    pendingPngDataURL ? `PNG: ${pendingPngName}` : "PNG: missing",
  ].join(" | ");
}

async function initFromPending({ keepLevel = false, keepOrientation = false } = {}) {
  const mj = pendingMapJson;
  if (mj.infinite) {
    setStatus("INFINITE MAPS NOT SUPPORTED");
    alert("Infinite Tiled maps are not supported. Re-export with a fixed size.");
    return false;
  }
  try {
    const decodeWalk = (layers) => {
      for (const layer of layers) {
        if (isTileLayer(layer)) decodeLayerDataInPlace(layer);
        else if (layer.type === "group") decodeWalk(layer.layers || []);
      }
    };
    decodeWalk(mj.layers);
  } catch (err) {
    alert(err?.message || "Failed to decode layer data.");
    return false;
  }
  let img;
  try {
    img = await loadImage(pendingPngDataURL);
  } catch (err) {
    alert("Failed to load tileset image");
    throw err;
  }
  map = mj;
  mapFileName = pendingMapName || "tilemap";
  tilesetImage = img;
  tilesetImageDataURL = pendingPngDataURL;
  externalTilesetJson = pendingTilesetJson;
  undoStack.length = 0;
  inspectedObject = null;
  mapDirty = false;
  if (!keepLevel) level = null;
  pendingMapJson = null;
  pendingMapName = "";
  pendingTilesetJson = null;
  pendingPngDataURL = "";
  pendingPngName = "";

  resolveTilesetParams();
  rebuildCollideMap();
  rebuildFlatLayers();
  activeLayerIndex = Math.max(0, flatLayers.findIndex((fl) => isTileLayer(fl.layer)));
  selectedGid = ts.firstgid;
  cursor = { cx: 0, cy: 0 };
  zoom = Math.max(1, Math.min(6, Math.round(24 / Math.max(1, map.tileheight))));
  if (!keepOrientation) orientation = "native";
  document.querySelectorAll("#orientSeg .btn").forEach((b) => b.classList.toggle("active", b.dataset.orient === orientation));
  paletteSource = "tileset";
  $("tilesetSourceSelect").value = "tileset";
  selectedPixelTile = -1;

  const nameInput = $("tilemapNameInput");
  if (nameInput && !level) nameInput.value = mapFileName;
  $("tilemapDownloadBtn").disabled = false;
  $("tilemapSaveCloudBtn").disabled = false;
  $("tilemapDims").textContent = `${map.width}×${map.height} @ ${map.tilewidth}px`;

  resizeCanvases();
  rebuildBase();
  drawTilemapOverlay();
  renderLayersList();
  renderPalette();
  updateInfoChip();
  updatePaletteInfo();
  renderObjectInspector();
  updatePartControls();
  updateLevelButtons();
  refreshFileStatus();

  const firstEntry = map.tilesets?.[0];
  if ((map.tilesets || []).length > 1) setStatus("MAP HAS MULTIPLE TILESETS — USING FIRST ONLY");
  else if (firstEntry?.source && !externalTilesetJson) setStatus(`MAP USES EXTERNAL TILESET "${firstEntry.source.toUpperCase()}" — UPLOAD IT FOR CORRECT TILE GEOMETRY`);
  else setStatus(`TILEMAP LOADED · ${mapFileName.toUpperCase()}`);
  return true;
}

function resolveTilesetParams() {
  const entry = map?.tilesets?.[0] || {};
  const ext = externalTilesetJson || {};
  ts.firstgid = entry.firstgid || 1;
  ts.name = ext.name || entry.name || "tiles";
  ts.tilewidth = ext.tilewidth || entry.tilewidth || map?.tilewidth || 8;
  ts.tileheight = ext.tileheight || entry.tileheight || map?.tileheight || 8;
  ts.margin = ext.margin ?? entry.margin ?? 0;
  ts.spacing = ext.spacing ?? entry.spacing ?? 0;
  const img = tilesetImage;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  ts.columns = Math.max(1, Math.floor((iw - ts.margin * 2 + ts.spacing) / (ts.tilewidth + ts.spacing)));
  const rows = Math.max(1, Math.floor((ih - ts.margin * 2 + ts.spacing) / (ts.tileheight + ts.spacing)));
  ts.tilecount = ts.columns * rows;
  // A tileset entry that names its own count wins over the image's rows,
  // so an image with trailing empty rows keeps its palette tight.
  const declared = ext.tilecount ?? entry.tilecount;
  if (Number.isFinite(declared) && declared >= 0 && declared < ts.tilecount) ts.tilecount = declared;
}

/** ========================= Rendering =========================== */
function resizeCanvases() {
  if (!map) return;
  const d = displaySize(), t = displayTile();
  baseCanvas.width = d.cols * t.w;
  baseCanvas.height = d.rows * t.h;
  overlayCanvas.width = baseCanvas.width;
  overlayCanvas.height = baseCanvas.height;
  applyZoom();
}
function applyZoom() {
  if (!map) return;
  const w = baseCanvas.width * zoom, h = baseCanvas.height * zoom;
  baseCanvas.style.width = `${w}px`;
  baseCanvas.style.height = `${h}px`;
  overlayCanvas.style.width = `${w}px`;
  overlayCanvas.style.height = `${h}px`;
  $("tilemapZoomBtn").textContent = `ZOOM: ${zoom}x`;
}

// Draw one gid at a display rect. `rotate` turns the tile a quarter turn
// clockwise (the horizontal view); Tiled's own flips apply in tile space.
function drawGid(ctx, rawGid, dx, dy, dw, dh, rotate = false) {
  const gid = rawGid & GID_MASK;
  const tw = ts.tilewidth, th = ts.tileheight;
  const outW = dw ?? tw, outH = dh ?? th;
  const id = gid - ts.firstgid;
  if (!tilesetImage || id < 0 || id >= ts.tilecount) {
    ctx.fillStyle = "rgba(255,0,255,0.6)";
    ctx.fillRect(dx, dy, outW, outH);
    return;
  }
  const sx = ts.margin + (id % ts.columns) * (tw + ts.spacing);
  const sy = ts.margin + Math.floor(id / ts.columns) * (th + ts.spacing);
  const flipH = !!(rawGid & FLIP_H), flipV = !!(rawGid & FLIP_V), flipD = !!(rawGid & FLIP_D);
  if (!flipH && !flipV && !flipD && !rotate) {
    ctx.drawImage(tilesetImage, sx, sy, tw, th, dx, dy, outW, outH);
    return;
  }
  ctx.save();
  ctx.translate(dx + outW / 2, dy + outH / 2);
  if (rotate) ctx.rotate(Math.PI / 2);
  // Tiled applies the diagonal flip first, then H/V; canvas composes so the
  // last call acts first, hence H/V before the diagonal pair.
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  if (flipD) {
    ctx.rotate(Math.PI / 2);
    ctx.scale(1, -1);
  }
  const tileW = rotate ? outH : outW, tileH = rotate ? outW : outH;
  ctx.drawImage(tilesetImage, sx, sy, tw, th, -tileW / 2, -tileH / 2, tileW, tileH);
  ctx.restore();
}

function rebuildBase() {
  if (!map) return;
  baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
  baseCtx.imageSmoothingEnabled = false;
  const t = displayTile();
  const rotate = orientation === "horizontal";
  for (const fl of flatLayers) {
    const layer = fl.layer;
    if (!fl.groupVisible || layer.visible === false) continue;
    baseCtx.globalAlpha = fl.groupOpacity * (layer.opacity ?? 1);
    if (isTileLayer(layer)) {
      const data = layerData(layer);
      const lw = layer.width ?? map.width, lh = layer.height ?? map.height;
      const dyOff = orientation === "native" ? map.tileheight - ts.tileheight : 0;
      for (let i = 0; i < data.length; i++) {
        const gid = data[i];
        if (!gid) continue;
        const cx = i % lw, cy = Math.floor(i / lw);
        if (cy >= lh) break;
        const { dx, dy } = mapToDisplay(cx, cy);
        drawGid(baseCtx, gid, dx * t.w, dy * t.h + dyOff, orientation === "native" ? undefined : t.w, orientation === "native" ? undefined : t.h, rotate);
      }
    } else if (isObjectLayer(layer) && orientation === "native") {
      for (const obj of layer.objects || []) {
        if (obj.visible === false || !obj.gid) continue;
        const w = obj.width || map.tilewidth, h = obj.height || map.tileheight;
        const rot = ((obj.rotation || 0) * Math.PI) / 180;
        if (rot) {
          baseCtx.save();
          baseCtx.translate(obj.x, obj.y);
          baseCtx.rotate(rot);
          drawGid(baseCtx, obj.gid, 0, -h, w, h);
          baseCtx.restore();
        } else {
          drawGid(baseCtx, obj.gid, obj.x, obj.y - h, w, h);
        }
      }
    }
  }
  baseCtx.globalAlpha = 1;
}

function objectBounds(obj) {
  const w = obj.width || (map ? map.tilewidth : 8);
  const h = obj.height || (map ? map.tileheight : 8);
  if (obj.gid) return { x: obj.x, y: obj.y - h, w, h };
  if (obj.point) return { x: obj.x - 3, y: obj.y - 3, w: 6, h: 6 };
  return { x: obj.x, y: obj.y, w, h };
}

function drawTilemapOverlay() {
  if (!map) return;
  const w = overlayCanvas.width, h = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, w, h);
  const d = displaySize(), t = displayTile();
  if (showGrid) {
    overlayCtx.strokeStyle = "rgba(140,255,110,0.14)";
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    for (let x = 0; x <= d.cols; x++) {
      overlayCtx.moveTo(x * t.w + 0.5, 0);
      overlayCtx.lineTo(x * t.w + 0.5, h);
    }
    for (let y = 0; y <= d.rows; y++) {
      overlayCtx.moveTo(0, y * t.h + 0.5);
      overlayCtx.lineTo(w, y * t.h + 0.5);
    }
    overlayCtx.stroke();
    // Part boundaries for scenery (16 rows a screen), in the scroll axis.
    if (level) {
      overlayCtx.strokeStyle = "rgba(255,184,74,0.45)";
      overlayCtx.beginPath();
      for (let r = BG_PART_ROWS; r < map.height; r += BG_PART_ROWS) {
        const { dx, dy } = mapToDisplay(0, r);
        if (orientation === "horizontal") {
          overlayCtx.moveTo(dx * t.w + 0.5, 0);
          overlayCtx.lineTo(dx * t.w + 0.5, h);
        } else {
          const yy = (orientation === "vertical" ? dy + 1 : dy) * t.h + 0.5;
          overlayCtx.moveTo(0, yy);
          overlayCtx.lineTo(w, yy);
        }
      }
      overlayCtx.stroke();
    }
  }
  if (orientation === "native") {
    flatLayers.forEach((fl, li) => {
      const layer = fl.layer;
      if (!isObjectLayer(layer) || !fl.groupVisible || layer.visible === false) return;
      const isActive = li === activeLayerIndex;
      for (const obj of layer.objects || []) {
        const b = objectBounds(obj);
        const isInspected = obj === inspectedObject;
        overlayCtx.lineWidth = isInspected ? 2 : 1;
        overlayCtx.strokeStyle = isInspected ? "rgba(246,255,74,0.95)" : isActive ? "rgba(0,200,255,0.9)" : "rgba(0,200,255,0.35)";
        const rot = ((obj.rotation || 0) * Math.PI) / 180;
        if (rot) {
          overlayCtx.save();
          overlayCtx.translate(obj.x, obj.y);
          overlayCtx.rotate(rot);
          if (obj.gid) overlayCtx.strokeRect(0.5, -b.h + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
          else overlayCtx.strokeRect(0.5, 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
          overlayCtx.restore();
        } else if (obj.ellipse) {
          overlayCtx.beginPath();
          overlayCtx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
          overlayCtx.stroke();
        } else {
          overlayCtx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
        }
      }
    });
  }
  const { dx, dy } = mapToDisplay(cursor.cx, cursor.cy);
  overlayCtx.lineWidth = Math.max(1, Math.round(2 / Math.max(1, zoom / 2)));
  overlayCtx.strokeStyle = "rgba(246,255,74,0.95)";
  overlayCtx.strokeRect(dx * t.w + 0.5, dy * t.h + 0.5, t.w - 1, t.h - 1);
}

/** ===================== Layers list / palette =================== */
function renderLayersList() {
  const cont = $("tilemapLayersList");
  cont.innerHTML = "";
  cont.classList.remove("sx-empty-hint");
  if (!map) {
    cont.classList.add("sx-empty-hint");
    cont.textContent = "Load a tilemap to see layers.";
    return;
  }
  flatLayers.forEach((fl, i) => {
    const layer = fl.layer;
    const row = document.createElement("div");
    row.className = "tm-layer-row" + (i === activeLayerIndex ? " active" : "");
    if (fl.depth > 0) row.style.marginLeft = `${fl.depth * 14}px`;
    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = layer.visible !== false;
    vis.title = "Toggle layer visibility";
    vis.addEventListener("click", (ev) => ev.stopPropagation());
    vis.addEventListener("change", () => {
      layer.visible = vis.checked;
      rebuildBase();
      drawTilemapOverlay();
    });
    const name = document.createElement("span");
    name.className = "tm-layer-name";
    name.textContent = fl.label || `layer ${i}`;
    const badge = document.createElement("span");
    badge.className = "tm-layer-badge";
    badge.textContent = isTileLayer(layer) ? "TILES" : isObjectLayer(layer) ? `OBJ ${(layer.objects || []).length}` : layer.type.toUpperCase();
    row.append(vis, name, badge);
    row.addEventListener("click", () => setActiveLayer(i));
    cont.appendChild(row);
  });
}
function setActiveLayer(i) {
  if (!map || !flatLayers.length) return;
  activeLayerIndex = Math.max(0, Math.min(flatLayers.length - 1, i));
  inspectedObject = null;
  renderLayersList();
  renderObjectInspector();
  drawTilemapOverlay();
  updateInfoChip();
  const layer = activeLayer();
  if (layer) setStatus(`LAYER · ${layer.name.toUpperCase()} (${layer.type.toUpperCase()})`);
}
function tilemapCycleLayer(d) {
  if (!map || !flatLayers.length) return;
  setActiveLayer((activeLayerIndex + d + flatLayers.length) % flatLayers.length);
}

function renderPalette() {
  const canvas = $("tilemapPaletteCanvas");
  const ctx = canvas.getContext("2d");
  if (paletteSource === "pixelSprites") {
    renderPixelPalette(canvas, ctx);
    return;
  }
  if (!map || !tilesetImage) {
    canvas.width = 10;
    canvas.height = 10;
    ctx.clearRect(0, 0, 10, 10);
    return;
  }
  const tw = ts.tilewidth, th = ts.tileheight, cols = ts.columns;
  const rows = Math.ceil(ts.tilecount / cols), s = PALETTE_SCALE;
  canvas.width = cols * tw * s;
  canvas.height = rows * th * s;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let id = 0; id < ts.tilecount; id++) {
    const cx = id % cols, cy = Math.floor(id / cols);
    const sx = ts.margin + cx * (tw + ts.spacing), sy = ts.margin + cy * (th + ts.spacing);
    ctx.drawImage(tilesetImage, sx, sy, tw, th, cx * tw * s, cy * th * s, tw * s, th * s);
    if (collideByTileId.get(id)) {
      ctx.fillStyle = "rgba(255,80,80,0.9)";
      ctx.fillRect(cx * tw * s + tw * s - 3, cy * th * s, 3, 3);
    }
  }
  if (selectedGid >= ts.firstgid) {
    const id = selectedGid - ts.firstgid;
    if (id < ts.tilecount) {
      const cx = id % cols, cy = Math.floor(id / cols);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(246,255,74,0.95)";
      ctx.strokeRect(cx * tw * s + 1, cy * th * s + 1, tw * s - 2, th * s - 2);
    }
  }
  $("tilemapEraserBtn").classList.toggle("active", selectedGid === 0);
}
function updatePaletteInfo() {
  const el = $("tilemapPaletteInfo");
  if (paletteSource === "pixelSprites") {
    const t = pixelTiles[selectedPixelTile];
    el.textContent = !pixelTiles.length
      ? "NO PIXEL SPRITES IN THE CLOUD YET — DRAW ONE IN THE PIXEL EDITOR"
      : t ? `${t.key} · FRAME ${t.frame} · CELL ${t.cx},${t.cy} → + ADD TO MAP` : `${pixelTiles.length} CELLS FROM pixelSprites/* — CLICK ONE`;
    return;
  }
  if (!map || !tilesetImage) {
    el.textContent = "NO TILESET LOADED";
    return;
  }
  if (selectedGid === 0) {
    el.textContent = "ERASER — PLACES EMPTY (GID 0)";
    return;
  }
  const id = selectedGid - ts.firstgid;
  const collide = collideByTileId.get(id) ? " · COLLIDE" : "";
  const cellName = level && level.cells[id] ? ` · ${level.cells[id]}` : "";
  const flips = (placeFlipH ? " · FLIP H" : "") + (placeFlipV ? " · FLIP V" : "");
  el.textContent = `TILE ${id} · GID ${selectedGid}${collide}${cellName} · ${ts.name} ${ts.columns}×${Math.ceil(ts.tilecount / ts.columns)}${flips}`;
}
function selectGid(gid) {
  selectedGid = gid;
  renderPalette();
  updatePaletteInfo();
  updateInfoChip();
}
function updateInfoChip() {
  const el = $("tilemapInfoChip");
  if (!map) {
    el.textContent = "NO MAP LOADED";
    return;
  }
  const fl = flatLayers[activeLayerIndex];
  const gidLabel = selectedGid === 0 ? "ERASE" : `GID ${selectedGid}`;
  const part = level ? ` · PART ${Math.floor(cursor.cy / BG_PART_ROWS)}` : "";
  el.textContent = `${fl ? fl.label : "-"} · CELL ${cursor.cx},${cursor.cy}${part} · ${gidLabel} · ${orientation.toUpperCase()}`;
}

/** ====================== Editing operations ===================== */
function pushUndo() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;
  if (strokeActive) {
    if (strokePushed) return;
    strokePushed = true;
  }
  if (isTileLayer(layer)) {
    undoStack.push({ kind: "tiles", layerIndex: activeLayerIndex, data: layerData(layer).slice(), nextobjectid: map.nextobjectid });
  } else if (isObjectLayer(layer)) {
    undoStack.push({ kind: "objects", layerIndex: activeLayerIndex, objects: JSON.parse(JSON.stringify(layer.objects || [])), nextobjectid: map.nextobjectid });
  }
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function tilemapUndo() {
  if (!map || !undoStack.length) return;
  const entry = undoStack.pop();
  const layer = flatLayers[entry.layerIndex]?.layer;
  if (!layer) return;
  if (entry.kind === "tiles") layer.data = entry.data;
  else {
    layer.objects = entry.objects;
    inspectedObject = null;
  }
  if (entry.nextobjectid != null) map.nextobjectid = entry.nextobjectid;
  markDirty();
  rebuildBase();
  drawTilemapOverlay();
  renderLayersList();
  renderObjectInspector();
  setStatus("UNDO");
}
function markDirty() {
  mapDirty = true;
  if (level) {
    const entry = level.maps[level.stageKey];
    if (entry) entry.dirty = true;
    updateStageSelect();
  }
  updateLevelButtons();
}
const cellIndex = (layer, cx, cy) => cy * (layer.width ?? map.width) + cx;
function hitObjectAt(px, py) {
  const layer = activeLayer();
  if (!layer || !isObjectLayer(layer)) return null;
  const objs = layer.objects || [];
  for (let i = objs.length - 1; i >= 0; i--) {
    const b = objectBounds(objs[i]);
    if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return objs[i];
  }
  return null;
}
function placeGid() {
  return selectedGid === 0 ? 0 : ((selectedGid | (placeFlipH ? FLIP_H : 0) | (placeFlipV ? FLIP_V : 0)) >>> 0);
}
function tilemapPlace() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;
  if (isTileLayer(layer)) {
    const idx = cellIndex(layer, cursor.cx, cursor.cy);
    const data = layerData(layer);
    if (idx < 0 || idx >= data.length) return;
    const gid = placeGid();
    if (data[idx] === gid) return;
    pushUndo();
    data[idx] = gid;
    markDirty();
    rebuildBase();
    drawTilemapOverlay();
    setStatus(selectedGid === 0 ? `ERASED TILE ${cursor.cx},${cursor.cy}` : `PLACED GID ${selectedGid} AT ${cursor.cx},${cursor.cy}`);
    return;
  }
  if (isObjectLayer(layer)) {
    pushUndo();
    if (!layer.objects) layer.objects = [];
    const tw = map.tilewidth, th = map.tileheight;
    const id = Math.max(map.nextobjectid || 1, maxObjectId() + 1);
    const obj = selectedGid > 0
      ? { id, gid: selectedGid, name: "", type: "", rotation: 0, visible: true, width: tw, height: th, x: cursor.cx * tw, y: (cursor.cy + 1) * th }
      : { id, name: "", type: "", rotation: 0, visible: true, width: tw, height: th, x: cursor.cx * tw, y: cursor.cy * th };
    layer.objects.push(obj);
    map.nextobjectid = id + 1;
    markDirty();
    inspectedObject = obj;
    rebuildBase();
    drawTilemapOverlay();
    renderLayersList();
    renderObjectInspector();
    setStatus(`ADDED OBJECT #${id}${selectedGid ? ` (GID ${selectedGid})` : ""}`);
  }
}
function tilemapDelete() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;
  if (isTileLayer(layer)) {
    const idx = cellIndex(layer, cursor.cx, cursor.cy);
    const data = layerData(layer);
    if (idx < 0 || idx >= data.length || !data[idx]) return;
    pushUndo();
    data[idx] = 0;
    markDirty();
    rebuildBase();
    drawTilemapOverlay();
    setStatus(`ERASED TILE ${cursor.cx},${cursor.cy}`);
    return;
  }
  if (isObjectLayer(layer)) {
    const tw = map.tilewidth, th = map.tileheight;
    const obj = hitObjectAt(cursor.cx * tw + tw / 2, cursor.cy * th + th / 2);
    if (!obj) {
      setStatus("NO OBJECT AT CURSOR");
      return;
    }
    pushUndo();
    layer.objects = (layer.objects || []).filter((o) => o !== obj);
    if (inspectedObject === obj) inspectedObject = null;
    markDirty();
    rebuildBase();
    drawTilemapOverlay();
    renderLayersList();
    renderObjectInspector();
    setStatus(`DELETED OBJECT #${obj.id}`);
  }
}
function tilemapPick() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;
  if (isTileLayer(layer)) {
    const data = layerData(layer);
    const raw = data[cellIndex(layer, cursor.cx, cursor.cy)] || 0;
    const gid = raw & GID_MASK;
    if (gid > 0) {
      placeFlipH = !!(raw & FLIP_H);
      placeFlipV = !!(raw & FLIP_V);
      $("placeFlipH").classList.toggle("active", placeFlipH);
      $("placeFlipV").classList.toggle("active", placeFlipV);
      paletteSource = "tileset";
      $("tilesetSourceSelect").value = "tileset";
      selectGid(gid);
      setStatus(`PICKED GID ${gid}`);
    } else setStatus("EMPTY CELL — NOTHING TO PICK");
    return;
  }
  if (isObjectLayer(layer)) {
    const tw = map.tilewidth, th = map.tileheight;
    const obj = hitObjectAt(cursor.cx * tw + tw / 2, cursor.cy * th + th / 2);
    if (obj?.gid) {
      selectGid(obj.gid & GID_MASK);
      setStatus(`PICKED GID ${obj.gid & GID_MASK} FROM OBJECT #${obj.id}`);
    } else if (obj) {
      inspectedObject = obj;
      renderObjectInspector();
      drawTilemapOverlay();
      setStatus(`INSPECTING OBJECT #${obj.id}`);
    }
  }
}
function tilemapToggleGrid() {
  showGrid = !showGrid;
  $("tilemapGridBtn").classList.toggle("active", showGrid);
  drawTilemapOverlay();
}
function addObjectLayer() {
  if (!map) {
    alert("Load a tilemap first.");
    return;
  }
  const id = Math.max(map.nextlayerid || 1, maxLayerId() + 1);
  const layer = { draworder: "topdown", id, name: `objects_${id}`, objects: [], opacity: 1, type: "objectgroup", visible: true, x: 0, y: 0 };
  map.layers.push(layer);
  map.nextlayerid = id + 1;
  markDirty();
  rebuildFlatLayers();
  setActiveLayer(flatLayers.length - 1);
  setStatus(`ADDED OBJECT LAYER "${layer.name.toUpperCase()}"`);
}

/** ================ Cursor movement / hit testing ================ */
function clampCursor() {
  if (!map) return;
  cursor.cx = Math.max(0, Math.min(map.width - 1, cursor.cx));
  cursor.cy = Math.max(0, Math.min(map.height - 1, cursor.cy));
}
function afterCursorMove() {
  clampCursor();
  updateHoveredObject();
  drawTilemapOverlay();
  updateInfoChip();
  syncPartInput();
}
function updateHoveredObject() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer || !isObjectLayer(layer)) return;
  const tw = map.tilewidth, th = map.tileheight;
  const obj = hitObjectAt(cursor.cx * tw + tw / 2, cursor.cy * th + th / 2);
  if (obj) {
    inspectedObject = obj;
    renderObjectInspector();
  }
}
function scrollCursorIntoView() {
  if (!map) return;
  const container = $("tilemapCanvasContainer");
  const t = displayTile();
  const { dx, dy } = mapToDisplay(cursor.cx, cursor.cy);
  const tw = t.w * zoom, th = t.h * zoom;
  const x = dx * tw + 16, y = dy * th + 16;
  const margin = 2 * tw;
  if (x < container.scrollLeft + margin) container.scrollLeft = Math.max(0, x - margin);
  else if (x + tw > container.scrollLeft + container.clientWidth - margin) container.scrollLeft = x + tw + margin - container.clientWidth;
  if (y < container.scrollTop + th) container.scrollTop = Math.max(0, y - th);
  else if (y + th > container.scrollTop + container.clientHeight - th) container.scrollTop = y + 2 * th - container.clientHeight;
}
// Arrows move on the SCREEN: in the vertical view "up" is further into the
// stage, in the horizontal view "right" is.
function tilemapMoveCursor(ddx, ddy) {
  if (!map) return;
  const { dx, dy } = mapToDisplay(cursor.cx, cursor.cy);
  const d = displaySize();
  const nx = Math.max(0, Math.min(d.cols - 1, dx + ddx)), ny = Math.max(0, Math.min(d.rows - 1, dy + ddy));
  const m = displayToMap(nx, ny);
  cursor.cx = m.cx;
  cursor.cy = m.cy;
  afterCursorMove();
  scrollCursorIntoView();
}
function tilemapSetCursorFromClient(clientX, clientY) {
  if (!map) return false;
  const rect = overlayCanvas.getBoundingClientRect();
  const t = displayTile();
  const dx = Math.floor((clientX - rect.left) / (t.w * zoom));
  const dy = Math.floor((clientY - rect.top) / (t.h * zoom));
  const d = displaySize();
  if (dx < 0 || dy < 0 || dx >= d.cols || dy >= d.rows) return false;
  const m = displayToMap(dx, dy);
  if (m.cx !== cursor.cx || m.cy !== cursor.cy) {
    cursor.cx = m.cx;
    cursor.cy = m.cy;
    afterCursorMove();
  }
  return true;
}

// PART (16-row screen) navigation for scenery.
function updatePartControls() {
  const wrap = $("partWrap");
  if (!level || !map) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const parts = Math.ceil(map.height / BG_PART_ROWS);
  $("partInput").max = String(parts - 1);
  $("partTotal").textContent = `/${parts}`;
  syncPartInput();
}
function syncPartInput() {
  if (!level || !map) return;
  $("partInput").value = String(Math.floor(cursor.cy / BG_PART_ROWS));
}
function gotoPart(p) {
  if (!level || !map) return;
  const parts = Math.ceil(map.height / BG_PART_ROWS);
  const part = Math.max(0, Math.min(parts - 1, p | 0));
  cursor.cy = part * BG_PART_ROWS;
  afterCursorMove();
  scrollCursorIntoView();
}

/** ====================== Object inspector ======================= */
function renderObjectInspector() {
  const wrap = $("tilemapObjectInspector");
  const layer = activeLayer();
  const show = !!(layer && isObjectLayer(layer));
  wrap.style.display = show ? "flex" : "none";
  if (!show) return;
  const info = $("tilemapObjInfo"), nameInput = $("tilemapObjName"), typeInput = $("tilemapObjType");
  if (!inspectedObject) {
    info.textContent = "NO OBJECT UNDER CURSOR";
    nameInput.value = "";
    nameInput.disabled = true;
    typeInput.value = "";
    typeInput.disabled = true;
    return;
  }
  const o = inspectedObject;
  info.textContent = `#${o.id} · ${o.gid ? `GID ${o.gid & GID_MASK}` : "SHAPE"} · ${Math.round(o.x)},${Math.round(o.y)}`;
  nameInput.disabled = false;
  nameInput.value = o.name || "";
  typeInput.disabled = false;
  typeInput.value = o.type || "";
}

/** ==================== Download / cloud sync ==================== */
const serializeMap = () => JSON.stringify(map, null, 1);
function downloadFile(name, content, type) {
  const a = document.createElement("a");
  const blob = new Blob([content], { type });
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function downloadMapJson() {
  if (!map) return;
  const name = $("tilemapNameInput").value.trim() || mapFileName || "tilemap";
  downloadFile(`${name}.json`, serializeMap(), "application/json");
  mapDirty = false;
}
async function saveTilemapToCloud() {
  if (!map) return;
  const rawName = $("tilemapNameInput").value.trim() || mapFileName || "tilemap";
  const key = sanitizeKey(rawName);
  const d = getDb();
  if (!d) {
    alert("Firebase unavailable.");
    return;
  }
  try {
    await d.ref(`tilemaps/${key}`).set({
      json: serializeMap(),
      tileset: externalTilesetJson ? JSON.stringify(externalTilesetJson) : null,
      png: tilesetImageDataURL || null,
    });
    mapDirty = false;
    setStatus(`SAVED · tilemaps/${key}`);
    await populateTilemapSelect();
  } catch (err) {
    console.error(err);
    alert(`Failed to save tilemap: ${err?.message || "unknown error"}`);
  }
}
async function populateTilemapSelect() {
  const select = $("tilemapSelect");
  const setOptions = (keys) => {
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Load from cloud --";
    select.appendChild(placeholder);
    for (const k of keys) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      select.appendChild(opt);
    }
  };
  try {
    const res = await fetch(`${DB_URL}/tilemaps.json?shallow=true`);
    const data = res.ok ? await res.json() : null;
    setOptions(data ? Object.keys(data).sort() : []);
  } catch (err) {
    console.error("Failed to list tilemaps:", err);
    setOptions([]);
  }
}
async function loadTilemapFromCloud(key) {
  if (!key) return;
  const d = getDb();
  if (!d) return;
  try {
    const snapshot = await d.ref(`tilemaps/${key}`).once("value");
    if (!snapshot.exists()) {
      alert(`Tilemap "${key}" not found.`);
      return;
    }
    const val = snapshot.val();
    const json = typeof val.json === "string" ? JSON.parse(val.json) : val.json;
    if (!looksLikeMap(json)) {
      alert("Stored tilemap JSON is not a valid Tiled map.");
      return;
    }
    if (!val.png) {
      alert("Stored tilemap has no tileset image.");
      return;
    }
    pendingMapJson = json;
    pendingMapName = key;
    pendingTilesetJson = typeof val.tileset === "string" ? JSON.parse(val.tileset) : val.tileset || null;
    pendingPngDataURL = ensureDataURL(val.png);
    pendingPngName = "cloud tileset";
    refreshFileStatus();
    await initFromPending();
  } catch (err) {
    console.error(err);
    alert(`Failed to load tilemap: ${err?.message || "unknown error"}`);
  }
}

/** ================= Pixel sprites as a tile source ============== */
// pixelSprites/* is watched live: a sprite saved in the Pixel Editor shows up
// here as tiles at once. Each 16x16 cell of each frame is one tile.
function watchPixelSprites() {
  const d = getDb();
  if (!d || !E) return;
  d.ref("pixelSprites").on("value", (snap) => {
    const val = snap.val() || {};
    pixelTiles = [];
    for (const [key, rec] of Object.entries(val)) {
      if (!rec || rec.format !== "deza2-cg-v1" || !Array.isArray(rec.frames)) continue;
      const w = rec.w | 0, h = rec.h | 0;
      if (w % TILE || h % TILE) continue;
      const words = [...E.DEZA2_PALETTE_WORDS];
      if (typeof rec.paletteBank === "string") {
        const bytes = base64ToBytes(rec.paletteBank);
        for (let i = 0; i < E.DEZA2_CG_COLORS && i * 2 + 1 < bytes.length; i++) {
          if (E.deza2PaletteBand(i) === "user") words[i] = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7fff;
        }
      }
      const rgb = E.deza2PaletteRgb(words);
      rec.frames.forEach((b64, fi) => {
        let cells;
        try {
          cells = base64ToBytes(b64);
        } catch (_e) {
          return;
        }
        if (cells.length !== w * h) return;
        const cw = w / TILE, ch = h / TILE;
        for (let cy = 0; cy < ch; cy++) {
          for (let cx = 0; cx < cw; cx++) {
            const cellBytes = cells.subarray((cy * cw + cx) * 256, (cy * cw + cx + 1) * 256);
            let blank = true;
            for (let i = 0; i < 256; i++) if (cellBytes[i]) { blank = false; break; }
            if (blank) continue;
            const c = document.createElement("canvas");
            c.width = TILE;
            c.height = TILE;
            c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(cellBytes, rgb), TILE, TILE), 0, 0);
            const single = cw * ch === 1 && rec.frames.length === 1;
            pixelTiles.push({ key, frame: fi, cx, cy, canvas: c, name: single ? key : `${key}_f${fi}_c${cy * cw + cx}` });
          }
        }
      });
    }
    if (selectedPixelTile >= pixelTiles.length) selectedPixelTile = -1;
    if (paletteSource === "pixelSprites") {
      renderPalette();
      updatePaletteInfo();
    }
    $("cloudState").textContent = `RTDB · ${pixelTiles.length} PIXEL TILE${pixelTiles.length === 1 ? "" : "S"} LIVE`;
  });
}
function renderPixelPalette(canvas, ctx) {
  const cols = 16, s = PALETTE_SCALE;
  const rows = Math.max(1, Math.ceil(pixelTiles.length / cols));
  canvas.width = cols * TILE * s;
  canvas.height = rows * TILE * s;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  pixelTiles.forEach((t, i) => {
    ctx.drawImage(t.canvas, (i % cols) * TILE * s, Math.floor(i / cols) * TILE * s, TILE * s, TILE * s);
  });
  if (selectedPixelTile >= 0) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(246,255,74,0.95)";
    ctx.strokeRect((selectedPixelTile % cols) * TILE * s + 1, Math.floor(selectedPixelTile / cols) * TILE * s + 1, TILE * s - 2, TILE * s - 2);
  }
  $("btnAddPixelTiles").disabled = !(map && selectedPixelTile >= 0);
}

// Append one tile image to the map's tileset: a fresh canvas with room for
// one more tile (a new row when the current one is full), the map's tileset
// entry updated to match. Only for gutter-less tilesets — with margin or
// spacing the geometry is the file's, not ours to extend.
function appendTileToTileset(tileCanvas, cellName) {
  if (!map || !tilesetImage) return -1;
  if (ts.margin || ts.spacing) {
    setStatus("CANNOT EXTEND A TILESET WITH MARGIN/SPACING — SAVE THE TILES AS THEIR OWN SHEET");
    return -1;
  }
  if (ts.tilewidth !== TILE || ts.tileheight !== TILE) {
    setStatus(`PIXEL TILES ARE 16×16 — THIS MAP'S TILES ARE ${ts.tilewidth}×${ts.tileheight}`);
    return -1;
  }
  const id = ts.tilecount;
  const cols = ts.columns;
  const rowsNeeded = Math.ceil((id + 1) / cols);
  const c = document.createElement("canvas");
  c.width = cols * TILE;
  c.height = rowsNeeded * TILE;
  const cx = c.getContext("2d");
  cx.drawImage(tilesetImage, 0, 0);
  cx.drawImage(tileCanvas, (id % cols) * TILE, Math.floor(id / cols) * TILE);
  tilesetImage = c;
  tilesetImageDataURL = c.toDataURL("image/png");
  ts.tilecount = id + 1;
  const entry = map.tilesets?.[0];
  if (entry) {
    entry.tilecount = ts.tilecount;
    entry.imagewidth = c.width;
    entry.imageheight = c.height;
    entry.columns = cols;
  }
  if (level) {
    level.cells.push(cellName);
    level.newCells.push({ name: cellName, canvas: tileCanvas });
    level.maps[level.stageKey].dirty = true;
    updateStageSelect();
  }
  markDirty();
  return id;
}
function addSelectedPixelTile() {
  const t = pixelTiles[selectedPixelTile];
  if (!t || !map) return;
  // Already in this map's tileset? Reuse it.
  if (level) {
    const existing = level.cells.indexOf(t.name);
    if (existing >= 0) {
      paletteSource = "tileset";
      $("tilesetSourceSelect").value = "tileset";
      selectGid(ts.firstgid + existing);
      setStatus(`${t.name} IS ALREADY TILE ${existing}`);
      return;
    }
  }
  const id = appendTileToTileset(t.canvas, t.name);
  if (id < 0) return;
  paletteSource = "tileset";
  $("tilesetSourceSelect").value = "tileset";
  selectGid(ts.firstgid + id);
  setStatus(`ADDED ${t.name} AS TILE ${id}${level ? ` · backgroundCells[${id}]` : ""}`);
}

/** ===================== Level scenery session =================== */
// stage.background <-> Tiled map, and the level's backgroundCells frames as
// the tileset image, so the whole editing core above needs no special case.
function sceneryToMap(bg, cellCount, tilesetDims) {
  const cols = bg?.cols || BG_COLS, rows = bg?.rows || BG_ROWS;
  const data = new Array(cols * rows).fill(0);
  if (bg && bg.tiles) {
    const bytes = base64ToBytes(bg.tiles);
    for (let i = 0; i < cols * rows && i * 2 + 1 < bytes.length; i++) {
      const word = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
      if (word === BG_EMPTY) continue;
      let gid = (word & 0x3ff) + 1;
      if (word & 0x8000) gid |= FLIP_H;
      if (word & 0x4000) gid |= FLIP_V;
      data[i] = gid >>> 0;
    }
  }
  return {
    type: "map",
    version: "1.10",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: cols,
    height: rows,
    tilewidth: TILE,
    tileheight: TILE,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{ id: 1, name: "scenery", type: "tilelayer", visible: true, opacity: 1, x: 0, y: 0, width: cols, height: rows, data }],
    tilesets: [{
      firstgid: 1,
      name: "backgroundCells",
      image: "backgroundCells.png",
      imagewidth: tilesetDims.w,
      imageheight: tilesetDims.h,
      tilewidth: TILE,
      tileheight: TILE,
      margin: 0,
      spacing: 0,
      columns: 16,
      tilecount: cellCount,
    }],
  };
}
function mapToScenery(m) {
  const layer = (m.layers || []).find(isTileLayer);
  const data = layer ? layerData(layer) : [];
  const cols = m.width, rows = m.height;
  const bytes = new Uint8Array(cols * rows * 2);
  for (let i = 0; i < cols * rows; i++) {
    const raw = data[i] || 0;
    let word = BG_EMPTY;
    if (raw) {
      word = ((raw & GID_MASK) - 1) & 0x3ff;
      if (raw & FLIP_H) word |= 0x8000;
      if (raw & FLIP_V) word |= 0x4000;
    }
    bytes[i * 2] = word >> 8;
    bytes[i * 2 + 1] = word & 0xff;
  }
  return { cols, rows, tiles: bytesToBase64(bytes) };
}

// The level atlas as {image, frames: name -> {x, y, w, h}}. Cloud records
// hold the level's custom frames under encoded keys; the editor's bridge
// holds the whole working atlas; the shipped base atlas backs both.
function framesMapOf(json) {
  if (!json) return {};
  if (json.frames && !Array.isArray(json.frames)) return json.frames;
  const list = Array.isArray(json.frames) ? json.frames : json.textures?.[0]?.frames;
  if (Array.isArray(list)) {
    const m = {};
    for (const f of list) if (f && f.filename) m[f.filename] = f;
    return m;
  }
  return json.textures?.[0]?.frames || {};
}
let baseAtlasPromise = null;
function baseAtlas() {
  if (!baseAtlasPromise) {
    baseAtlasPromise = (async () => {
      const [json, image] = await Promise.all([fetch(BASE_ATLAS_JSON).then((r) => r.json()), loadImage(BASE_ATLAS_PNG)]);
      return { image, frames: framesMapOf(json) };
    })().catch((err) => {
      console.warn("base atlas unavailable:", err);
      return null;
    });
  }
  return baseAtlasPromise;
}
function frameRect(entry) {
  const f = entry && entry.frame;
  if (!f) return null;
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}
async function buildCellsTileset(cells, atlases) {
  const cols = 16;
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const c = document.createElement("canvas");
  c.width = cols * TILE;
  c.height = rows * TILE;
  const ctx = c.getContext("2d");
  let missing = 0;
  cells.forEach((name, i) => {
    let drawn = false;
    for (const a of atlases) {
      if (!a) continue;
      const entry = a.frames[name] || a.frames[encodeKey(name)];
      const r = frameRect(entry);
      if (!r) continue;
      ctx.drawImage(a.image, r.x, r.y, r.w, r.h, (i % cols) * TILE, Math.floor(i / cols) * TILE, TILE, TILE);
      drawn = true;
      break;
    }
    if (!drawn) {
      missing++;
      ctx.fillStyle = "rgba(255,0,255,.5)";
      ctx.fillRect((i % cols) * TILE, Math.floor(i / cols) * TILE, TILE, TILE);
    }
  });
  return { canvas: c, missing };
}

// Which stage a record's flat fields belong to: the one whose grid they equal.
function flatStageOf(record) {
  if (!record || !record.stages || !Array.isArray(record.enemylist)) return null;
  const flat = JSON.stringify(record.enemylist);
  for (const [k, s] of Object.entries(record.stages)) {
    if (s && JSON.stringify(s.enemylist || null) === flat) return k;
  }
  return null;
}

async function levelAtlasFromRecord(record) {
  if (!record || !record.atlasImageDataURL || !record.atlasFrames) return null;
  try {
    const image = await loadImage(ensureDataURL(record.atlasImageDataURL));
    const frames = {};
    for (const [k, v] of Object.entries(record.atlasFrames)) frames[decodeKey(k)] = v;
    return { image, frames };
  } catch (err) {
    console.warn("level atlas unreadable:", err);
    return null;
  }
}

// The Level Editor's IndexedDB bridge: the working atlas it last published.
function readBridgeAtlas(atlasKey) {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open("editorViewerBridge");
    } catch (_e) {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore("assets");
      } catch (_e) { /* exists */ }
    };
    req.onsuccess = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains("assets")) {
        idb.close();
        resolve(null);
        return;
      }
      try {
        const get = idb.transaction("assets", "readonly").objectStore("assets").get("atlas:" + (atlasKey || "game_asset"));
        get.onsuccess = async () => {
          const rec = get.result;
          idb.close();
          if (!rec || !rec.blob) {
            resolve(null);
            return;
          }
          try {
            const url = URL.createObjectURL(rec.blob);
            const image = await loadImage(url);
            resolve({ image, frames: framesMapOf({ frames: rec.frames }) });
          } catch (_e) {
            resolve(null);
          }
        };
        get.onerror = () => {
          idb.close();
          resolve(null);
        };
      } catch (_e) {
        idb.close();
        resolve(null);
      }
    };
  });
}
function readBridgeSession() {
  return new Promise((resolve) => {
    try {
      const raw = sessionStorage.getItem("editorTilemapBridge");
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.v === 1 && p.stages) {
          resolve(p);
          return;
        }
      }
    } catch (_e) { /* fall through */ }
    let req;
    try {
      req = indexedDB.open("editorViewerBridge");
    } catch (_e) {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore("assets");
      } catch (_e) { /* exists */ }
    };
    req.onsuccess = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains("assets")) {
        idb.close();
        resolve(null);
        return;
      }
      try {
        const get = idb.transaction("assets", "readonly").objectStore("assets").get("tilemapSession");
        get.onsuccess = () => {
          const p = get.result;
          idb.close();
          resolve(p && p.v === 1 && p.stages ? p : null);
        };
        get.onerror = () => {
          idb.close();
          resolve(null);
        };
      } catch (_e) {
        idb.close();
        resolve(null);
      }
    };
  });
}

async function populateLevelSelect() {
  const select = $("levelSelect");
  try {
    const res = await fetch(`${DB_URL}/levels.json?shallow=true`);
    const data = res.ok ? await res.json() : null;
    const keys = data ? Object.keys(data).sort((a, b) => a.localeCompare(b)) : [];
    select.innerHTML = '<option value="">-- Cloud level --</option>';
    for (const k of keys) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      select.appendChild(opt);
    }
    if (level && level.name && keys.includes(level.name)) select.value = level.name;
  } catch (err) {
    console.error("Failed to list levels:", err);
  }
}

// Open a level session from a cloud record or the editor's hand-off.
async function openLevelSession({ name, stages, backgroundCells, atlases, stageKey, horizontal, fromEditor, gameId, record }) {
  const cells = Array.isArray(backgroundCells) ? backgroundCells.slice() : [];
  const stageKeys = Object.keys(stages).filter((k) => /^stage\d+$/.test(k)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  if (!stageKeys.length) {
    levelNote("THIS LEVEL HAS NO STAGES", true);
    return false;
  }
  level = {
    name,
    gameId: gameId || null,
    fromEditor: !!fromEditor,
    record: record || null,
    cells,
    newCells: [],
    atlases,
    stageKey: stageKeys.includes(stageKey) ? stageKey : stageKeys[0],
    maps: {},
    horizontal: !!horizontal,
  };
  for (const k of stageKeys) {
    level.maps[k] = { bg: stages[k]?.background || null, map: null, dirty: false, hadScenery: !!(stages[k]?.background) };
  }
  $("levelSelect").value = name;
  updateStageSelect();
  const ok = await openStage(level.stageKey);
  levelNote(fromEditor ? `FROM THE LEVEL EDITOR · ${stageKeys.length} STAGE${stageKeys.length === 1 ? "" : "S"} · ${cells.length} CELLS` : `levels/${name} · ${stageKeys.length} STAGE${stageKeys.length === 1 ? "" : "S"} · ${cells.length} CELLS`);
  return ok;
}
function updateStageSelect() {
  const sel = $("stageSelect");
  sel.innerHTML = "";
  if (!level) {
    sel.innerHTML = '<option value="">STAGE</option>';
    return;
  }
  for (const [k, e] of Object.entries(level.maps)) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = `${k.toUpperCase()}${e.dirty ? " *" : ""}${!e.hadScenery && !e.dirty ? " ·" : ""}`;
    opt.title = e.hadScenery ? "has scenery" : "no scenery yet — an empty grid";
    sel.appendChild(opt);
  }
  sel.value = level.stageKey;
}
function syncStageIntoSession() {
  if (!level || !map) return;
  const entry = level.maps[level.stageKey];
  if (entry) entry.map = map;
}
async function openStage(stageKey) {
  if (!level) return false;
  syncStageIntoSession();
  const entry = level.maps[stageKey];
  if (!entry) return false;
  const { canvas, missing } = await buildCellsTileset(level.cells, level.atlases);
  const cellCount = level.cells.length;
  const m = entry.map || sceneryToMap(entry.bg, cellCount, { w: canvas.width, h: canvas.height });
  m.tilesets[0].tilecount = cellCount;
  m.tilesets[0].imagewidth = canvas.width;
  m.tilesets[0].imageheight = canvas.height;
  pendingMapJson = m;
  pendingMapName = `${level.name} · ${stageKey}`;
  pendingTilesetJson = null;
  pendingPngDataURL = canvas.toDataURL("image/png");
  pendingPngName = "backgroundCells";
  level.stageKey = stageKey;
  const wanted = level.horizontal ? "horizontal" : "vertical";
  orientation = orientation === "native" ? wanted : orientation;
  const ok = await initFromPending({ keepLevel: true, keepOrientation: true });
  if (!ok) return false;
  entry.map = map;
  mapDirty = entry.dirty;
  $("tilemapNameInput").value = `${sanitizeKey(level.name)}_${stageKey}`;
  updateStageSelect();
  updateLevelButtons();
  setOrientation(orientation);
  if (missing) setStatus(`STAGE ${stageKey.toUpperCase()} · ${missing} OF ${cellCount} CELLS HAVE NO ART IN ANY ATLAS (MAGENTA)`);
  else setStatus(`STAGE ${stageKey.toUpperCase()} SCENERY · ${map.width}×${map.height} · ${cellCount} CELLS${entry.hadScenery ? "" : " · EMPTY GRID"}`);
  return true;
}
function updateLevelButtons() {
  const has = !!(level && map);
  $("btnLevelSave").disabled = !has;
  $("btnLevelApply").disabled = !has;
}

async function loadLevelFromCloud(name, stageKey) {
  const d = getDb();
  if (!d) {
    levelNote("FIREBASE UNAVAILABLE", true);
    return false;
  }
  if (level && Object.values(level.maps).some((e) => e.dirty) && !confirm("Switch level and discard unsaved scenery edits?")) return false;
  levelNote(`LOADING levels/${name}…`);
  try {
    const snap = await d.ref(`levels/${name}`).once("value");
    const record = snap.val();
    if (!record) throw new Error("level not found");
    const stages = {};
    if (record.stages && typeof record.stages === "object") {
      for (const [k, s] of Object.entries(record.stages)) if (s) stages[k] = s;
    } else if (Array.isArray(record.enemylist)) {
      stages.stage0 = { enemylist: record.enemylist, background: record.background || null };
    }
    const atlases = [await levelAtlasFromRecord(record), await baseAtlas()];
    const horizontal = !!(record.meta && record.meta.dezaemonSettings && record.meta.dezaemonSettings.horizontal);
    history.replaceState(null, "", `?level=${encodeURIComponent(name)}${stageKey ? `&stage=${encodeURIComponent(stageKey)}` : ""}`);
    return await openLevelSession({ name, stages, backgroundCells: record.backgroundCells, atlases, stageKey, horizontal, record, gameId: record.gameId });
  } catch (err) {
    console.error(err);
    levelNote(`LOAD FAILED · ${err.message || err}`, true);
    return false;
  }
}

// Pack this session's new cells onto the level's custom atlas: the existing
// image grows by whole 16-px rows underneath, each new cell gets a frame
// entry under its encoded key. Returns the fields to write.
async function extendLevelAtlas(record, newCells) {
  const frames = {};
  if (record && record.atlasFrames) for (const [k, v] of Object.entries(record.atlasFrames)) frames[k] = v;
  let image = null;
  if (record && record.atlasImageDataURL) {
    try {
      image = await loadImage(ensureDataURL(record.atlasImageDataURL));
    } catch (_e) {
      image = null;
    }
  }
  const baseW = image ? image.naturalWidth : 256;
  const baseH = image ? image.naturalHeight : 0;
  const perRow = Math.max(1, Math.floor(baseW / TILE));
  const rows = Math.ceil(newCells.length / perRow);
  const c = document.createElement("canvas");
  c.width = baseW;
  c.height = baseH + rows * TILE;
  const ctx = c.getContext("2d");
  if (image) ctx.drawImage(image, 0, 0);
  newCells.forEach((cell, i) => {
    const x = (i % perRow) * TILE, y = baseH + Math.floor(i / perRow) * TILE;
    ctx.drawImage(cell.canvas, x, y);
    frames[encodeKey(cell.name)] = {
      frame: { x, y, w: TILE, h: TILE },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: TILE, h: TILE },
      sourceSize: { w: TILE, h: TILE },
    };
  });
  return { atlasImageDataURL: c.toDataURL("image/png"), atlasFrames: frames };
}

async function saveLevelScenery() {
  if (!level || !map) return;
  syncStageIntoSession();
  const d = getDb();
  if (!d) {
    levelNote("FIREBASE UNAVAILABLE", true);
    return;
  }
  const name = level.name;
  if (!name) {
    levelNote("THIS SESSION HAS NO CLOUD LEVEL NAME — SAVE THE GAME FROM THE LEVEL EDITOR FIRST", true);
    return;
  }
  const dirty = Object.entries(level.maps).filter(([, e]) => e.dirty && e.map);
  if (!dirty.length && !level.newCells.length) {
    levelNote("NO SCENERY CHANGES TO SAVE");
    return;
  }
  levelNote(`SAVING levels/${name}…`);
  try {
    const snap = await d.ref(`levels/${name}`).once("value");
    const record = snap.val();
    if (!record) throw new Error(`levels/${name} does not exist — save the game from the Level Editor first`);
    const updates = {};
    const flatKey = flatStageOf(record);
    for (const [k, e] of dirty) {
      const bg = mapToScenery(e.map);
      updates[`levels/${name}/stages/${k}/background`] = bg;
      if (flatKey === k || (!record.stages && k === "stage0")) updates[`levels/${name}/background`] = bg;
    }
    if (level.newCells.length) {
      updates[`levels/${name}/backgroundCells`] = level.cells.slice();
      const ext = await extendLevelAtlas(record, level.newCells);
      updates[`levels/${name}/atlasImageDataURL`] = ext.atlasImageDataURL;
      updates[`levels/${name}/atlasFrames`] = ext.atlasFrames;
    } else if (!Array.isArray(record.backgroundCells) || record.backgroundCells.length !== level.cells.length) {
      updates[`levels/${name}/backgroundCells`] = level.cells.slice();
    }
    await d.ref().update(updates);
    for (const [, e] of dirty) e.dirty = false;
    const added = level.newCells.length;
    level.newCells = [];
    level.record = { ...record, backgroundCells: level.cells.slice() };
    mapDirty = false;
    updateStageSelect();
    levelNote(`SAVED · levels/${name} · ${dirty.length} STAGE${dirty.length === 1 ? "" : "S"}${added ? ` · ${added} NEW CELL${added === 1 ? "" : "S"} PACKED INTO THE LEVEL ATLAS` : ""}`);
    setStatus(`SAVED SCENERY TO levels/${name}`);
    broadcastApply({ saved: true });
  } catch (err) {
    console.error(err);
    levelNote(`SAVE FAILED · ${err.message || err}`, true);
  }
}

// Hand the edited scenery to an open Level Editor (same origin) — it takes
// the grid into its in-memory game, plus any new cells as atlas extras.
function broadcastApply({ saved = false } = {}) {
  if (!level || !map) return;
  syncStageIntoSession();
  const stages = {};
  for (const [k, e] of Object.entries(level.maps)) if (e.map && (e.dirty || saved)) stages[k] = mapToScenery(e.map);
  const payload = {
    type: "tilemap-apply",
    gameId: level.gameId || null,
    levelName: level.name || null,
    stageKey: level.stageKey,
    stages,
    backgroundCells: level.cells.slice(),
    newCells: level.newCells.map((c) => ({ key: c.name, png: c.canvas.toDataURL("image/png") })),
    saved,
  };
  try {
    new BroadcastChannel(EDITOR_CHANNEL).postMessage(payload);
    if (!saved) {
      levelNote(`APPLIED TO THE LEVEL EDITOR · ${Object.keys(stages).length} STAGE${Object.keys(stages).length === 1 ? "" : "S"}${payload.newCells.length ? ` · ${payload.newCells.length} NEW CELLS` : ""} — SAVE THERE TO KEEP IT`);
      setStatus("SCENERY SENT TO THE LEVEL EDITOR");
    }
  } catch (err) {
    levelNote(`NO BROADCAST CHANNEL · ${err.message || err}`, true);
  }
}

/** ========================= UI wiring =========================== */
function cycleZoom() {
  zoom = (zoom % 6) + 1;
  applyZoom();
  drawTilemapOverlay();
  scrollCursorIntoView();
}
function onPaletteClick(ev) {
  const canvas = $("tilemapPaletteCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top, s = PALETTE_SCALE;
  if (paletteSource === "pixelSprites") {
    const cx = Math.floor(x / (TILE * s)), cy = Math.floor(y / (TILE * s));
    const i = cy * 16 + cx;
    if (cx < 0 || cx >= 16 || i >= pixelTiles.length) return;
    selectedPixelTile = i;
    renderPalette();
    updatePaletteInfo();
    return;
  }
  if (!map || !tilesetImage) return;
  const cx = Math.floor(x / (ts.tilewidth * s)), cy = Math.floor(y / (ts.tileheight * s));
  if (cx < 0 || cx >= ts.columns) return;
  const id = cy * ts.columns + cx;
  if (id < 0 || id >= ts.tilecount) return;
  selectGid(ts.firstgid + id);
  setStatus(`SELECTED GID ${ts.firstgid + id}`);
}
function wireCanvasMouse() {
  let painting = false, paintButton = 0;
  overlayCanvas.addEventListener("pointermove", (ev) => {
    if (!map) return;
    tilemapSetCursorFromClient(ev.clientX, ev.clientY);
    if (painting && (ev.buttons & 1 || ev.buttons & 2)) {
      if (paintButton === 0) tilemapPlace();
      else tilemapDelete();
    } else if (painting) painting = false;
  });
  overlayCanvas.addEventListener("pointerdown", (ev) => {
    if (!map) return;
    ev.preventDefault();
    tilemapSetCursorFromClient(ev.clientX, ev.clientY);
    const layer = activeLayer();
    if (ev.button === 0 || ev.button === 2) {
      painting = !!(layer && isTileLayer(layer));
      paintButton = ev.button;
      if (painting) {
        strokeActive = true;
        strokePushed = false;
      }
      if (ev.button === 0) tilemapPlace();
      else tilemapDelete();
    }
  });
  window.addEventListener("pointerup", () => {
    painting = false;
    strokeActive = false;
    strokePushed = false;
  });
  overlayCanvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
}
let activeTab = "map";
function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.getAttribute("data-panel") !== tab;
  });
  document.querySelectorAll(".sx-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("[data-hints]").forEach((h) => {
    h.hidden = h.getAttribute("data-hints") !== tab;
  });
  $("tabHint").textContent = tab === "map" ? "DROP level.json + tiles.png · OR LOAD A LEVEL'S SCENERY" : "A LEVEL SCREENSHOT IN → tiles.png + map.json OUT";
}
function wireKeyboard(extractor) {
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (activeTab === "extract") {
      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); extractor.nudge(-1, 0); break;
        case "ArrowRight": e.preventDefault(); extractor.nudge(1, 0); break;
        case "ArrowUp": e.preventDefault(); extractor.nudge(0, -1); break;
        case "ArrowDown": e.preventDefault(); extractor.nudge(0, 1); break;
        case "Enter": extractor.extract(); break;
      }
      return;
    }
    if (!map) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      tilemapUndo();
      return;
    }
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); tilemapMoveCursor(-1, 0); break;
      case "ArrowRight": e.preventDefault(); tilemapMoveCursor(1, 0); break;
      case "ArrowUp": e.preventDefault(); tilemapMoveCursor(0, -1); break;
      case "ArrowDown": e.preventDefault(); tilemapMoveCursor(0, 1); break;
      case "Enter": case " ": e.preventDefault(); tilemapPlace(); break;
      case "Delete": case "Backspace": case "x": case "X": e.preventDefault(); tilemapDelete(); break;
      case "p": case "P": tilemapPick(); break;
      case "e": case "E": selectGid(selectedGid === 0 ? ts.firstgid : 0); break;
      case "f": case "F": $("placeFlipH").click(); break;
      case "v": case "V": $("placeFlipV").click(); break;
      case "[": tilemapCycleLayer(-1); break;
      case "]": tilemapCycleLayer(1); break;
      case "g": case "G": tilemapToggleGrid(); break;
      case "+": case "=": cycleZoom(); break;
      case "PageUp": if (level) gotoPart(Math.floor(cursor.cy / BG_PART_ROWS) + 1); break;
      case "PageDown": if (level) gotoPart(Math.floor(cursor.cy / BG_PART_ROWS) - 1); break;
    }
  });
}
function wireDragDrop() {
  const panel = $("mapPanel");
  ["dragenter", "dragover"].forEach((name) => panel.addEventListener(name, (ev) => {
    ev.preventDefault();
    panel.classList.add("sx-drop-active");
  }));
  panel.addEventListener("dragleave", () => panel.classList.remove("sx-drop-active"));
  panel.addEventListener("drop", (ev) => {
    ev.preventDefault();
    panel.classList.remove("sx-drop-active");
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length) tilemapLoadFiles(files);
  });
}

// The extractor's result opens here as a plain Tiled map.
async function openExtractedAsMap({ map: json, png, name }) {
  if (map && mapDirty && !confirm("Open the extracted map and discard unsaved changes?")) return;
  pendingMapJson = json;
  pendingMapName = name || "extracted";
  pendingTilesetJson = null;
  pendingPngDataURL = png;
  pendingPngName = "tiles.png";
  showTab("map");
  await initFromPending();
  refreshFileStatus();
}

function init() {
  baseCanvas = $("tilemapCanvas");
  overlayCanvas = $("tilemapOverlayCanvas");
  baseCtx = baseCanvas.getContext("2d");
  overlayCtx = overlayCanvas.getContext("2d");
  baseCtx.imageSmoothingEnabled = false;
  overlayCtx.imageSmoothingEnabled = false;

  document.querySelectorAll(".sx-tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("tilemapFileInput").addEventListener("change", (ev) => {
    const files = Array.from(ev.target.files || []);
    if (files.length) tilemapLoadFiles(files);
    ev.target.value = "";
  });
  $("tilemapZoomBtn").addEventListener("click", cycleZoom);
  $("tilemapGridBtn").addEventListener("click", tilemapToggleGrid);
  $("tilemapAddObjLayerBtn").addEventListener("click", addObjectLayer);
  $("tilemapEraserBtn").addEventListener("click", () => {
    paletteSource = "tileset";
    $("tilesetSourceSelect").value = "tileset";
    selectGid(selectedGid === 0 ? ts.firstgid : 0);
    setStatus(selectedGid === 0 ? "ERASER SELECTED" : "ERASER OFF");
  });
  $("placeFlipH").addEventListener("click", () => {
    placeFlipH = !placeFlipH;
    $("placeFlipH").classList.toggle("active", placeFlipH);
    updatePaletteInfo();
  });
  $("placeFlipV").addEventListener("click", () => {
    placeFlipV = !placeFlipV;
    $("placeFlipV").classList.toggle("active", placeFlipV);
    updatePaletteInfo();
  });
  $("tilemapPaletteCanvas").addEventListener("click", onPaletteClick);
  $("tilesetSourceSelect").addEventListener("change", (ev) => {
    paletteSource = ev.target.value;
    renderPalette();
    updatePaletteInfo();
  });
  $("btnAddPixelTiles").addEventListener("click", addSelectedPixelTile);
  $("tilemapDownloadBtn").addEventListener("click", downloadMapJson);
  $("tilemapSaveCloudBtn").addEventListener("click", () => void saveTilemapToCloud());
  $("tilemapSelect").addEventListener("change", (ev) => {
    const select = ev.target;
    if (!select.value) return;
    if (map && mapDirty && !confirm(`Load "${select.value}" from the cloud and discard unsaved changes to "${mapFileName}"?`)) {
      select.value = "";
      return;
    }
    loadTilemapFromCloud(select.value);
  });
  $("tilemapObjName").addEventListener("input", (ev) => {
    if (inspectedObject) {
      inspectedObject.name = ev.target.value;
      markDirty();
    }
  });
  $("tilemapObjType").addEventListener("input", (ev) => {
    if (inspectedObject) {
      inspectedObject.type = ev.target.value;
      markDirty();
    }
  });
  document.querySelectorAll("#orientSeg .btn").forEach((b) => b.addEventListener("click", () => setOrientation(b.dataset.orient)));
  $("partInput").addEventListener("change", () => gotoPart(parseInt($("partInput").value, 10) || 0));
  $("levelSelect").addEventListener("change", (ev) => {
    if (ev.target.value) loadLevelFromCloud(ev.target.value);
  });
  $("stageSelect").addEventListener("change", (ev) => {
    if (level && ev.target.value) openStage(ev.target.value);
  });
  $("btnLevelSave").addEventListener("click", () => void saveLevelScenery());
  $("btnLevelApply").addEventListener("click", () => broadcastApply());
  document.querySelectorAll("#orientSeg .btn").forEach((b) => b.classList.toggle("active", b.dataset.orient === orientation));

  wireCanvasMouse();
  wireDragDrop();
  const extractor = initTilesetExtractor({ openAsMap: openExtractedAsMap, setStatus });
  wireKeyboard(extractor);
  populateTilemapSelect();
  populateLevelSelect();
  watchPixelSprites();
  window.addEventListener("beforeunload", (ev) => {
    if (mapDirty || (level && Object.values(level.maps).some((e) => e.dirty))) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  // Test hook, mirroring spriteX's __sxTilemap.
  window.__sxTilemap = {
    loadFiles: (files) => tilemapLoadFiles(files),
    getMap: () => map,
    getState: () => ({ activeLayerIndex, selectedGid, cursor: { ...cursor }, zoom, tileset: { ...ts }, dirty: mapDirty, layerCount: flatLayers.length, orientation, level: level ? { name: level.name, stageKey: level.stageKey, cells: level.cells.length, newCells: level.newCells.length, stages: Object.keys(level.maps) } : null, pixelTiles: pixelTiles.length }),
    place: tilemapPlace,
    erase: tilemapDelete,
    pick: tilemapPick,
    moveCursor: tilemapMoveCursor,
    setCursor: (cx, cy) => { cursor = { cx, cy }; afterCursorMove(); },
    cycleLayer: tilemapCycleLayer,
    undo: tilemapUndo,
    setOrientation,
    serialize: () => (map ? serializeMap() : null),
    scenery: () => (map ? mapToScenery(map) : null),
    sceneryToMap,
    mapToScenery,
    openExtractedAsMap,
    loadLevel: loadLevelFromCloud,
    openStage,
    selectPixelTile: (i) => { selectedPixelTile = i; paletteSource = "pixelSprites"; renderPalette(); },
    addSelectedPixelTile,
    extractor,
  };
}

async function boot() {
  init();
  const params = new URLSearchParams(location.search);
  if (params.get("orient")) orientation = params.get("orient");
  if (params.get("tab") === "extract") showTab("extract");
  if (params.get("level")) {
    await loadLevelFromCloud(params.get("level"), params.get("stage") || undefined);
    return;
  }
  if (params.get("tilemap")) {
    await loadTilemapFromCloud(params.get("tilemap"));
    return;
  }
  // Nothing asked for: take whatever the Level Editor last handed over.
  const session = await readBridgeSession();
  if (session) {
    const bridgeAtlas = await readBridgeAtlas(session.atlasKey);
    const atlases = [bridgeAtlas, await baseAtlas()];
    await openLevelSession({
      name: session.levelName || "",
      stages: session.stages,
      backgroundCells: session.backgroundCells,
      atlases,
      stageKey: session.stageKey,
      horizontal: !!session.horizontal,
      fromEditor: true,
      gameId: session.gameId,
    });
    if (!session.levelName) levelNote("FROM THE LEVEL EDITOR (UNSAVED GAME) · APPLY TO EDITOR SENDS EDITS BACK; SAVE THE GAME THERE TO KEEP THEM");
  }
}

boot();
