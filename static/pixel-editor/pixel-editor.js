// pixel-editor.js — a data-backed pixel editor for Dezaemon 2 CG art.
//
// The sprite is never an RGBA image here. It is w x h palette INDICES, edited
// over the 288-colour DEZA2.PAL (served as /palette.png — see
// packages/shmup-engine/src/palette/deza2-palette.js), and it is stored the
// way a Saturn save stores art: 16x16 cells of (palette<<4)|colour bytes in
// reading order, plus the 16x16 RGB555 bank a save's sec4 would carry. That
// is the contract a future .sav writer needs, so a sprite drawn here can be
// dropped into a CG page unchanged. The RGBA render is derived from it (and
// also stored, for tools that only read pictures — spriteX's PACKER reads
// sprites/*, the Tilemap Editor reads pixelSprites/* live).
//
//   pixelSprites/{key} = {
//     format: "deza2-cg-v1", name, w, h, cellsW, cellsH, frameCount,
//     frames: [base64 of w*h cell-major bytes, ...],
//     paletteBank: base64 of 256 u16be words (sec4 layout),
//     palette: "deza2", png: dataURL of the frame strip, frameW, frameH,
//     updatedAt
//   }
//   sprites/{key}            frame 0 as a dataURL (single frame)
//   sprites/{key}_{i}        one per frame (multi-frame)
//
// Palette sources are a registry (PALETTE_SOURCES): Dezaemon 2 is the default
// and the only one wired up; Super Famicom (15-bit BGR, 16-colour rows) is
// the declared next entry.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- engine ---
let E = null;
try {
  E = await import("/engine/shmup-engine.js");
} catch (err) {
  console.error("shmup-engine failed to load:", err);
  setStatus("ENGINE BUNDLE MISSING — run `deno task engine:bundle`");
  throw err;
}

const CELL = E.CG_CELL; // 16
const CG_COLORS = E.DEZA2_CG_COLORS; // 256
const PAL_COLS = E.DEZA2_PALETTE_COLS; // 16

// -------------------------------------------------------- palette sources ---
const PALETTE_SOURCES = {
  deza2: {
    label: "DEZAEMON 2 · DEZA2.PAL (288)",
    cols: 16,
    bands: [
      { name: "SYSTEM", rows: E.DEZA2_SYSTEM_ROWS, editable: false, paintable: true },
      { name: "USER", rows: E.DEZA2_USER_ROWS, editable: true, paintable: true },
      { name: "UI (NOT CG)", rows: E.DEZA2_UI_ROWS, editable: false, paintable: false },
    ],
    async load() {
      // The served PNG is the source of truth; the engine table is the same
      // data and covers a fetch failure (offline export, file://).
      try {
        const img = await loadImage(E.DEZA2_PALETTE_PNG);
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
        const words = E.paletteWordsFromRgba(rgba);
        if (words.length === E.DEZA2_PALETTE_SIZE) return { words, from: "palette.png" };
      } catch (err) {
        console.warn("palette.png unavailable, using the engine table:", err);
      }
      return { words: [...E.DEZA2_PALETTE_WORDS], from: "engine table" };
    },
  },
  sfc: {
    label: "SUPER FAMICOM · 15-BIT BGR (SOON)",
    disabled: true,
  },
};

// ------------------------------------------------------------------ state ---
const state = {
  source: "deza2",
  words: [], // palette words, index = CG pixel byte for < 256
  rgb: [], // deza2PaletteRgb(words)
  name: "",
  w: 16,
  h: 16,
  frames: [new Uint8Array(16 * 16)], // row-major indices
  frame: 0,
  color: 1,
  secondary: 0,
  tool: "pencil",
  zoom: 16,
  grid: true,
  cells: true,
  undo: [],
  redo: [],
  dirty: false,
  cloudKey: null,
  cloud: {}, // key -> record summary
};

const UNDO_LIMIT = 80;
const ZOOMS = [2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];

// ------------------------------------------------------------- utilities ---
function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
}
function note(msg, warn = false) {
  const el = $("note");
  if (!el) return;
  el.textContent = msg;
  el.style.color = warn ? "#ff9a9a" : "";
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load: " + src));
    img.src = src;
  });
}
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sanitizeKey(name) {
  return String(name || "").trim().replace(/[.#$\[\]\/\s]+/g, "_").replace(/^_+|_+$/g, "");
}
function hex2(n) {
  return n.toString(16).padStart(2, "0");
}
function rgbHex(p) {
  return "#" + hex2(p.r) + hex2(p.g) + hex2(p.b);
}
function paletteBand(i) {
  return E.deza2PaletteBand(i);
}
function paintable(i) {
  return i >= 0 && i < CG_COLORS;
}

// --------------------------------------------------------------- firebase ---
let db = null;
function initDb() {
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

// ------------------------------------------------------------- rendering ---
const canvas = $("pxCanvas");
const overlay = $("pxOverlay");
const ctx = canvas.getContext("2d");
const octx = overlay.getContext("2d");

function frame() {
  return state.frames[state.frame];
}

function renderFrame() {
  const { w, h } = state;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const rgba = E.indexedToRgbaWith(frame(), state.rgb);
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  applyZoom();
  renderOverlay();
  renderFrameStrip();
  $("sizeChip").textContent = `${w}×${h} · ${(w / CELL) * (h / CELL)} CELL${(w / CELL) * (h / CELL) === 1 ? "" : "S"} · FRAME ${state.frame + 1}/${state.frames.length}`;
  $("dirtyChip").textContent = state.dirty ? "UNSAVED" : (state.cloudKey ? `pixelSprites/${state.cloudKey}` : "—");
}

function applyZoom() {
  const { w, h, zoom } = state;
  canvas.style.width = `${w * zoom}px`;
  canvas.style.height = `${h * zoom}px`;
  // One checker square per sprite pixel, whatever the zoom.
  canvas.style.backgroundSize = `${zoom * 2}px ${zoom * 2}px`;
  overlay.width = w * zoom;
  overlay.height = h * zoom;
  overlay.style.width = `${w * zoom}px`;
  overlay.style.height = `${h * zoom}px`;
}

let hover = null; // {x, y}
let dragPreview = null; // {x0,y0,x1,y1} for line/rect

function renderOverlay() {
  const { w, h, zoom } = state;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.grid && zoom >= 6) {
    octx.strokeStyle = "rgba(140,255,110,.14)";
    octx.lineWidth = 1;
    octx.beginPath();
    for (let x = 0; x <= w; x++) {
      octx.moveTo(x * zoom + 0.5, 0);
      octx.lineTo(x * zoom + 0.5, h * zoom);
    }
    for (let y = 0; y <= h; y++) {
      octx.moveTo(0, y * zoom + 0.5);
      octx.lineTo(w * zoom, y * zoom + 0.5);
    }
    octx.stroke();
  }
  if (state.cells && (w > CELL || h > CELL)) {
    octx.strokeStyle = "rgba(255,184,74,.6)";
    octx.lineWidth = 1;
    octx.beginPath();
    for (let x = CELL; x < w; x += CELL) {
      octx.moveTo(x * zoom + 0.5, 0);
      octx.lineTo(x * zoom + 0.5, h * zoom);
    }
    for (let y = CELL; y < h; y += CELL) {
      octx.moveTo(0, y * zoom + 0.5);
      octx.lineTo(w * zoom, y * zoom + 0.5);
    }
    octx.stroke();
  }
  if (dragPreview) {
    const pts = state.tool === "line"
      ? linePoints(dragPreview.x0, dragPreview.y0, dragPreview.x1, dragPreview.y1)
      : rectPoints(dragPreview.x0, dragPreview.y0, dragPreview.x1, dragPreview.y1);
    const p = state.rgb[dragPreview.color] || { r: 0, g: 0, b: 0 };
    octx.fillStyle = dragPreview.color === 0 ? "rgba(255,255,255,.35)" : `rgba(${p.r},${p.g},${p.b},.85)`;
    for (const [x, y] of pts) octx.fillRect(x * zoom, y * zoom, zoom, zoom);
  }
  if (hover) {
    octx.strokeStyle = "rgba(246,255,74,.95)";
    octx.lineWidth = Math.max(1, Math.round(zoom / 8));
    octx.strokeRect(hover.x * zoom + 0.5, hover.y * zoom + 0.5, zoom - 1, zoom - 1);
  }
}

function renderFrameStrip() {
  const strip = $("frameStrip");
  strip.innerHTML = "";
  state.frames.forEach((fr, i) => {
    const wrap = document.createElement("div");
    wrap.className = "frame-thumb" + (i === state.frame ? " active" : "");
    const c = document.createElement("canvas");
    c.width = state.w;
    c.height = state.h;
    c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(fr, state.rgb), state.w, state.h), 0, 0);
    wrap.appendChild(c);
    const n = document.createElement("span");
    n.textContent = i + 1;
    wrap.appendChild(n);
    wrap.title = `Frame ${i + 1}`;
    wrap.addEventListener("click", () => selectFrame(i));
    strip.appendChild(wrap);
  });
  $("btnFrameDel").disabled = state.frames.length <= 1;
  $("btnFrameAdd").disabled = state.frames.length >= 6;
  $("btnFrameDup").disabled = state.frames.length >= 6;
}

// The animation preview cycles the frames at the strip's FPS: animTimer
// advances the frame, this interval just paints whichever is current.
let animTick = 0;
setInterval(() => {
  if (state.frames.length < 2) animTick = 0;
  const c = $("animPreview");
  if (c.width !== state.w || c.height !== state.h) {
    c.width = state.w;
    c.height = state.h;
  }
  const fr = state.frames[animTick] || frame();
  c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(fr, state.rgb), state.w, state.h), 0, 0);
  const box = Math.min(52 / state.w, 52 / state.h);
  c.style.width = `${Math.round(state.w * box)}px`;
  c.style.height = `${Math.round(state.h * box)}px`;
}, 1000 / 6);
$("animFps").addEventListener("change", () => {
  // Re-arm at the new rate by swapping the interval.
  const fps = Math.max(1, Math.min(30, parseInt($("animFps").value, 10) || 6));
  clearInterval(animTimer);
  animTimer = setInterval(animStep, 1000 / fps);
});
function animStep() {
  if (state.frames.length >= 2) animTick = (animTick + 1) % state.frames.length;
}
let animTimer = setInterval(animStep, 1000 / 6);

// ---------------------------------------------------------------- palette ---
function renderPalette() {
  const grid = $("paletteGrid");
  grid.innerHTML = "";
  const src = PALETTE_SOURCES[state.source];
  let index = 0;
  src.bands.forEach((band, bi) => {
    const label = document.createElement("div");
    label.className = "pal-band" + (bi === 0 ? " first" : "");
    label.textContent = `${band.name} · ROWS ${index / PAL_COLS}–${index / PAL_COLS + band.rows - 1}`;
    grid.appendChild(label);
    for (let r = 0; r < band.rows; r++) {
      for (let c = 0; c < PAL_COLS; c++, index++) {
        const i = index;
        const p = state.rgb[i];
        const b = document.createElement("button");
        b.className = "pal-swatch";
        b.style.setProperty("--c", rgbHex(p));
        if (i === 0) b.classList.add("transparent");
        if (!band.paintable) b.classList.add("ui");
        if (band.editable) b.classList.add("user");
        if (i === state.color) b.classList.add("selected");
        if (i === state.secondary && i !== state.color) b.classList.add("secondary");
        b.title = `${i} · row ${i >> 4} col ${i & 15} · ${rgbHex(p)} · RGB555 0x${p.raw.toString(16).padStart(4, "0")}` + (band.paintable ? "" : " — editor UI colour, not paintable");
        b.dataset.index = String(i);
        b.addEventListener("click", () => selectColor(i));
        b.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          if (paintable(i)) {
            state.secondary = i;
            renderPalette();
          }
        });
        grid.appendChild(b);
      }
    }
  });
  renderColorInfo();
}

function selectColor(i) {
  if (!paintable(i)) {
    setStatus(`INDEX ${i} IS AN EDITOR-UI COLOUR — A CG PIXEL CANNOT CARRY IT`);
    return;
  }
  state.color = i;
  if (state.tool === "eraser") setTool("pencil");
  renderPalette();
  setStatus(`COLOUR ${i} · ${paletteBand(i).toUpperCase()} ROW ${i >> 4} COL ${i & 15}`);
}

function renderColorInfo() {
  const i = state.color;
  const p = state.rgb[i];
  $("colorChip").style.setProperty("--c", rgbHex(p));
  $("colorChip").style.background = i === 0 ? "repeating-conic-gradient(#333 0 25%, #111 0 50%) 0 0/8px 8px" : rgbHex(p);
  $("colorInfo").textContent = `IDX ${i} · ${paletteBand(i).toUpperCase()} ${i >> 4}/${i & 15} · ${rgbHex(p).toUpperCase()} · 0x${p.raw.toString(16).padStart(4, "0")}${i === 0 ? " · TRANSPARENT" : ""}`;
  const editable = paletteBand(i) === "user";
  $("userColorWrap").style.display = editable ? "inline-flex" : "none";
  if (editable) $("userColor").value = rgbHex(p);
}

// Mix a user colour: quantised to 15 bits so it is exactly what the bank
// will hold; every pixel already painted with that index follows.
$("userColor").addEventListener("input", () => {
  const i = state.color;
  if (paletteBand(i) !== "user") return;
  const v = $("userColor").value;
  const r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16);
  state.words[i] = E.rgb8ToRgb555(r, g, b);
  state.rgb = E.deza2PaletteRgb(state.words);
  state.dirty = true;
  renderPalette();
  renderFrame();
});

async function loadPaletteSource(id) {
  const src = PALETTE_SOURCES[id];
  if (!src || src.disabled) return;
  state.source = id;
  const { words, from } = await src.load();
  state.words = words;
  state.rgb = E.deza2PaletteRgb(words);
  renderPalette();
  renderFrame();
  setStatus(`PALETTE · ${src.label} · ${words.length} COLOURS · FROM ${from.toUpperCase()}`);
}

function populatePaletteSelect() {
  const sel = $("paletteSource");
  sel.innerHTML = "";
  for (const [id, src] of Object.entries(PALETTE_SOURCES)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = src.label;
    opt.disabled = !!src.disabled;
    sel.appendChild(opt);
  }
  sel.value = state.source;
  sel.addEventListener("change", () => loadPaletteSource(sel.value));
}

// ------------------------------------------------------------- sizes ---
function populateSizes() {
  const sel = $("sizeSelect");
  sel.innerHTML = "";
  for (const s of E.DEZA2_ZAKO_SIZES) {
    const opt = document.createElement("option");
    opt.value = `${s.w}x${s.h}`;
    opt.textContent = `${s.label} · ${(s.w / CELL) * (s.h / CELL)} CELL${(s.w / CELL) * (s.h / CELL) === 1 ? "" : "S"} · ZAKO ×${s.frames}`;
    sel.appendChild(opt);
  }
  sel.value = `${state.w}x${state.h}`;
  sel.addEventListener("change", () => {
    const [w, h] = sel.value.split("x").map(Number);
    resizeSprite(w, h);
  });
}

// Resizing keeps the top-left of every frame: pixels outside are dropped,
// new space is transparent. One undo step.
function resizeSprite(w, h) {
  if (w === state.w && h === state.h) return;
  pushUndo();
  state.frames = state.frames.map((fr) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < Math.min(h, state.h); y++) {
      out.set(fr.subarray(y * state.w, y * state.w + Math.min(w, state.w)), y * w);
    }
    return out;
  });
  state.w = w;
  state.h = h;
  state.dirty = true;
  renderFrame();
  setStatus(`RESIZED TO ${w}×${h}`);
}

function newSprite(w, h) {
  state.frames = [new Uint8Array(w * h)];
  state.frame = 0;
  state.w = w;
  state.h = h;
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.cloudKey = null;
  $("btnCloudDelete").disabled = true;
  $("sizeSelect").value = `${w}x${h}`;
  renderFrame();
  renderCloudList();
}

// ---------------------------------------------------------------- undo ---
function snapshot() {
  return { frames: state.frames.map((f) => f.slice()), frame: state.frame, w: state.w, h: state.h, words: state.words.slice() };
}
function restore(s) {
  state.frames = s.frames.map((f) => f.slice());
  state.frame = Math.min(s.frame, state.frames.length - 1);
  state.w = s.w;
  state.h = s.h;
  state.words = s.words.slice();
  state.rgb = E.deza2PaletteRgb(state.words);
  $("sizeSelect").value = `${state.w}x${state.h}`;
}
function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  state.dirty = true;
  renderPalette();
  renderFrame();
  setStatus("UNDO");
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  state.dirty = true;
  renderPalette();
  renderFrame();
  setStatus("REDO");
}

// ---------------------------------------------------------------- tools ---
function setTool(t) {
  state.tool = t;
  document.querySelectorAll(".btn.tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
}

function setPixel(fr, x, y, v) {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  fr[y * state.w + x] = v;
}
function getPixel(fr, x, y) {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return -1;
  return fr[y * state.w + x];
}

function linePoints(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}
function rectPoints(x0, y0, x1, y1) {
  const pts = [];
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  for (let x = l; x <= r; x++) { pts.push([x, t]); if (b !== t) pts.push([x, b]); }
  for (let y = t + 1; y < b; y++) { pts.push([l, y]); if (r !== l) pts.push([r, y]); }
  return pts;
}
function floodFill(fr, x, y, v) {
  const target = getPixel(fr, x, y);
  if (target < 0 || target === v) return;
  const stack = [[x, y]];
  const { w, h } = state;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    if (fr[cy * w + cx] !== target) continue;
    fr[cy * w + cx] = v;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

// Pointer -> pixel, through the zoom.
function pixelAt(ev) {
  const r = overlay.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / state.zoom);
  const y = Math.floor((ev.clientY - r.top) / state.zoom);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return null;
  return { x, y };
}

let stroke = null; // {button, color, last}
overlay.addEventListener("pointerdown", (ev) => {
  const p = pixelAt(ev);
  if (!p) return;
  ev.preventDefault();
  overlay.setPointerCapture(ev.pointerId);
  const erase = ev.button === 2 || state.tool === "eraser";
  const color = erase ? 0 : state.color;
  if (state.tool === "pick") {
    const v = getPixel(frame(), p.x, p.y);
    if (v >= 0) selectColor(v);
    return;
  }
  pushUndo();
  stroke = { color, last: p };
  if (state.tool === "fill") {
    floodFill(frame(), p.x, p.y, color);
    state.dirty = true;
    renderFrame();
    stroke = null;
    return;
  }
  if (state.tool === "line" || state.tool === "rect") {
    dragPreview = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, color };
    renderOverlay();
    return;
  }
  setPixel(frame(), p.x, p.y, color);
  state.dirty = true;
  renderFrame();
});
overlay.addEventListener("pointermove", (ev) => {
  const p = pixelAt(ev);
  hover = p;
  if (p) {
    const v = getPixel(frame(), p.x, p.y);
    $("pxInfo").textContent = `${p.x},${p.y} · CELL ${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)} · IDX ${v}` + (v > 0 ? ` (${rgbHex(state.rgb[v]).toUpperCase()})` : v === 0 ? " (TRANSPARENT)" : "");
  }
  if (stroke && p) {
    if (dragPreview) {
      dragPreview.x1 = p.x;
      dragPreview.y1 = p.y;
    } else {
      // Bresenham between events so a fast drag leaves no gaps.
      for (const [x, y] of linePoints(stroke.last.x, stroke.last.y, p.x, p.y)) setPixel(frame(), x, y, stroke.color);
      stroke.last = p;
      state.dirty = true;
      renderFrame();
      return;
    }
  }
  renderOverlay();
});
function endStroke() {
  if (dragPreview) {
    const pts = state.tool === "line"
      ? linePoints(dragPreview.x0, dragPreview.y0, dragPreview.x1, dragPreview.y1)
      : rectPoints(dragPreview.x0, dragPreview.y0, dragPreview.x1, dragPreview.y1);
    for (const [x, y] of pts) setPixel(frame(), x, y, dragPreview.color);
    dragPreview = null;
    state.dirty = true;
    renderFrame();
  }
  stroke = null;
}
overlay.addEventListener("pointerup", endStroke);
overlay.addEventListener("pointercancel", endStroke);
overlay.addEventListener("pointerleave", () => {
  hover = null;
  renderOverlay();
});
overlay.addEventListener("contextmenu", (ev) => ev.preventDefault());
$("workspace").addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  zoomBy(ev.deltaY < 0 ? 1 : -1);
}, { passive: false });

function zoomBy(dir) {
  const i = ZOOMS.indexOf(state.zoom);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 6 : i) + dir))];
  state.zoom = next;
  applyZoom();
  renderOverlay();
  setStatus(`ZOOM ${next}×`);
}

function flip(horizontal) {
  pushUndo();
  const fr = frame();
  const out = new Uint8Array(fr.length);
  const { w, h } = state;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = horizontal ? fr[y * w + (w - 1 - x)] : fr[(h - 1 - y) * w + x];
    }
  }
  state.frames[state.frame] = out;
  state.dirty = true;
  renderFrame();
}
function shift(dx, dy) {
  pushUndo();
  const fr = frame();
  const out = new Uint8Array(fr.length);
  const { w, h } = state;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = fr[sy * w + sx];
    }
  }
  state.frames[state.frame] = out;
  state.dirty = true;
  renderFrame();
}

// --------------------------------------------------------------- frames ---
function selectFrame(i) {
  state.frame = Math.max(0, Math.min(state.frames.length - 1, i));
  renderFrame();
}
function addFrame(duplicate) {
  if (state.frames.length >= 6) return;
  pushUndo();
  const fr = duplicate ? frame().slice() : new Uint8Array(state.w * state.h);
  state.frames.splice(state.frame + 1, 0, fr);
  state.frame++;
  state.dirty = true;
  renderFrame();
}
function deleteFrame() {
  if (state.frames.length <= 1) return;
  pushUndo();
  state.frames.splice(state.frame, 1);
  state.frame = Math.min(state.frame, state.frames.length - 1);
  state.dirty = true;
  renderFrame();
}

// ------------------------------------------------------------- records ---
function stripCanvas() {
  const c = document.createElement("canvas");
  c.width = state.w * state.frames.length;
  c.height = state.h;
  const cx = c.getContext("2d");
  state.frames.forEach((fr, i) => {
    cx.putImageData(new ImageData(E.indexedToRgbaWith(fr, state.rgb), state.w, state.h), i * state.w, 0);
  });
  return c;
}
function frameDataURL(i) {
  const c = document.createElement("canvas");
  c.width = state.w;
  c.height = state.h;
  c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(state.frames[i], state.rgb), state.w, state.h), 0, 0);
  return c.toDataURL("image/png");
}
function bankBase64() {
  const bank = E.paletteBankWords(state.words);
  const bytes = new Uint8Array(bank.length * 2);
  bank.forEach((wd, i) => {
    bytes[i * 2] = wd >> 8;
    bytes[i * 2 + 1] = wd & 0xff;
  });
  return bytesToBase64(bytes);
}
function buildRecord() {
  return {
    format: "deza2-cg-v1",
    name: state.name,
    w: state.w,
    h: state.h,
    cellsW: state.w / CELL,
    cellsH: state.h / CELL,
    frameCount: state.frames.length,
    frames: state.frames.map((fr) => bytesToBase64(E.indexedToCells(fr, state.w, state.h))),
    paletteBank: bankBase64(),
    palette: state.source,
    png: stripCanvas().toDataURL("image/png"),
    frameW: state.w,
    frameH: state.h,
    updatedAt: Date.now(),
  };
}
function applyRecord(key, rec) {
  if (!rec || rec.format !== "deza2-cg-v1" || !Array.isArray(rec.frames)) {
    throw new Error("not a deza2-cg-v1 sprite record");
  }
  const w = rec.w | 0, h = rec.h | 0;
  if (w % CELL || h % CELL || w <= 0 || h <= 0) throw new Error(`bad sprite size ${w}x${h}`);
  // The bank's user rows are the sprite's own colours; system rows are
  // whatever the current source says (identical in every save anyway).
  if (typeof rec.paletteBank === "string") {
    const bytes = base64ToBytes(rec.paletteBank);
    for (let i = 0; i < CG_COLORS && i * 2 + 1 < bytes.length; i++) {
      if (E.deza2PaletteBand(i) !== "user") continue;
      const wd = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7fff;
      state.words[i] = wd;
    }
    state.rgb = E.deza2PaletteRgb(state.words);
  }
  state.frames = rec.frames.map((b64) => {
    const cells = base64ToBytes(b64);
    if (cells.length !== w * h) throw new Error("frame byte count does not match the sprite size");
    return E.cellsToIndexed(cells, w, h);
  });
  state.frame = 0;
  state.w = w;
  state.h = h;
  state.name = rec.name || key;
  state.cloudKey = key;
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  $("spriteName").value = state.name;
  $("sizeSelect").value = `${w}x${h}`;
  $("btnCloudDelete").disabled = false;
  renderPalette();
  renderFrame();
  renderCloudList();
}

// ---------------------------------------------------------------- cloud ---
async function saveToCloud() {
  const name = sanitizeKey($("spriteName").value);
  if (!name) {
    note("NAME THE SPRITE FIRST", true);
    $("spriteName").focus();
    return;
  }
  const d = initDb();
  if (!d) {
    note("FIREBASE UNAVAILABLE", true);
    return;
  }
  state.name = name;
  const rec = buildRecord();
  setStatus(`SAVING pixelSprites/${name}…`);
  try {
    const updates = {};
    updates[`pixelSprites/${name}`] = rec;
    // spriteX's PACKER lists sprites/* (a dataURL, or {png}); one per frame
    // so each is usable as a replacement frame.
    if (state.frames.length === 1) {
      updates[`sprites/${name}`] = frameDataURL(0);
    } else {
      state.frames.forEach((_, i) => {
        updates[`sprites/${name}_${i}`] = frameDataURL(i);
      });
    }
    await d.ref().update(updates);
    state.cloudKey = name;
    state.dirty = false;
    $("btnCloudDelete").disabled = false;
    setStatus(`SAVED · pixelSprites/${name} + sprites/${name}${state.frames.length > 1 ? "_0…" + (state.frames.length - 1) : ""}`);
    note(`SAVED pixelSprites/${name}`);
    try {
      new BroadcastChannel("pixel-editor").postMessage({ type: "pixel-sprite-saved", key: name });
    } catch (_e) { /* no BroadcastChannel */ }
    renderFrame();
  } catch (err) {
    console.error(err);
    note(`SAVE FAILED · ${err.message || err}`, true);
    setStatus("SAVE FAILED");
  }
}

async function deleteFromCloud() {
  const key = state.cloudKey;
  const d = initDb();
  if (!key || !d) return;
  if (!confirm(`Delete pixelSprites/${key} (and its sprites/* frames) from the cloud?`)) return;
  try {
    const updates = { [`pixelSprites/${key}`]: null, [`sprites/${key}`]: null };
    for (let i = 0; i < 6; i++) updates[`sprites/${key}_${i}`] = null;
    await d.ref().update(updates);
    state.cloudKey = null;
    $("btnCloudDelete").disabled = true;
    setStatus(`DELETED pixelSprites/${key}`);
    renderFrame();
  } catch (err) {
    note(`DELETE FAILED · ${err.message || err}`, true);
  }
}

async function loadFromCloud(key) {
  const d = initDb();
  if (!d) return;
  if (state.dirty && !confirm(`Load "${key}" and discard unsaved changes?`)) return;
  setStatus(`LOADING pixelSprites/${key}…`);
  try {
    const snap = await d.ref(`pixelSprites/${key}`).once("value");
    const rec = snap.val();
    if (!rec) throw new Error("record not found");
    applyRecord(key, rec);
    setStatus(`LOADED · pixelSprites/${key} · ${rec.w}×${rec.h} × ${rec.frameCount || rec.frames.length}`);
    history.replaceState(null, "", `?sprite=${encodeURIComponent(key)}`);
  } catch (err) {
    console.error(err);
    note(`LOAD FAILED · ${err.message || err}`, true);
  }
}

// The list follows the database live, so a sprite saved from another window
// (or deleted) shows up without a refresh.
function watchCloud() {
  const d = initDb();
  const list = $("cloudList");
  if (!d) {
    list.innerHTML = '<div class="sx-empty-hint">FIREBASE UNAVAILABLE — LOCAL ONLY</div>';
    $("cloudState").textContent = "RTDB · OFFLINE";
    return;
  }
  d.ref("pixelSprites").on("value", (snap) => {
    const val = snap.val() || {};
    state.cloud = {};
    for (const [key, rec] of Object.entries(val)) {
      if (!rec || typeof rec !== "object") continue;
      state.cloud[key] = { w: rec.w, h: rec.h, frameCount: rec.frameCount || (rec.frames || []).length, png: rec.png, updatedAt: rec.updatedAt || 0 };
    }
    renderCloudList();
    $("cloudState").textContent = `RTDB · ${Object.keys(state.cloud).length} SPRITE${Object.keys(state.cloud).length === 1 ? "" : "S"}`;
  }, (err) => {
    console.error(err);
    list.innerHTML = `<div class="sx-empty-hint">CLOUD LIST FAILED · ${err.message || err}</div>`;
  });
}

function renderCloudList() {
  const list = $("cloudList");
  const keys = Object.keys(state.cloud).sort((a, b) => (state.cloud[b].updatedAt || 0) - (state.cloud[a].updatedAt || 0));
  list.innerHTML = "";
  if (!keys.length) {
    list.innerHTML = '<div class="sx-empty-hint">NO SPRITES YET — SAVE ONE</div>';
    return;
  }
  for (const key of keys) {
    const s = state.cloud[key];
    const row = document.createElement("div");
    row.className = "cloud-row" + (key === state.cloudKey ? " active" : "");
    const img = document.createElement("img");
    img.src = s.png || "";
    img.alt = "";
    row.appendChild(img);
    const name = document.createElement("span");
    name.textContent = key;
    row.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${s.w}×${s.h}${s.frameCount > 1 ? ` ×${s.frameCount}` : ""}`;
    row.appendChild(meta);
    row.addEventListener("click", () => loadFromCloud(key));
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------- import ---
// A PNG becomes indices: every opaque pixel goes to its nearest CG-addressable
// colour, transparent pixels to 0, and the image is padded out to whole cells
// (the size select follows). Frames are cut left-to-right when the image is
// wider than the chosen frame width and a strip was asked for.
async function importImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const src = cx.getImageData(0, 0, c.width, c.height).data;
    const fh = Math.ceil(c.height / CELL) * CELL;
    // A strip of equal frames? Only when the height fits a zako size and the
    // width divides evenly into frames of that height's natural width.
    let fw = Math.ceil(c.width / CELL) * CELL;
    let frames = 1;
    const asStrip = c.width > c.height && c.width % c.height === 0 && c.height % CELL === 0 && c.width / c.height <= 6;
    if (asStrip && confirm(`Treat this ${c.width}×${c.height} image as ${c.width / c.height} frames of ${c.height}×${c.height}?`)) {
      fw = c.height;
      frames = c.width / c.height;
    }
    if (fw > 64 || fh > 64) {
      note("IMAGE LARGER THAN 64×64 — CROPPED TO THE TOP-LEFT 64×64", true);
    }
    const w = Math.min(64, fw), h = Math.min(64, fh);
    pushUndo();
    const out = [];
    for (let f = 0; f < frames; f++) {
      const fr = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = f * fw + x, sy = y;
          if (sx >= c.width || sy >= c.height) continue;
          const o = (sy * c.width + sx) * 4;
          if (src[o + 3] < 128) continue;
          fr[y * w + x] = E.nearestPaletteIndex(src[o], src[o + 1], src[o + 2], state.rgb);
        }
      }
      out.push(fr);
    }
    state.frames = out;
    state.frame = 0;
    state.w = w;
    state.h = h;
    state.dirty = true;
    if (!$("spriteName").value) $("spriteName").value = sanitizeKey(file.name.replace(/\.[^.]+$/, ""));
    $("sizeSelect").value = `${w}x${h}`;
    if ($("sizeSelect").value !== `${w}x${h}`) {
      // Not a zako size — keep it, but say so.
      note(`${w}×${h} IS NOT A ZAKO FRAME SIZE — STILL WHOLE CELLS, STILL SAVE-WRITER READY`);
    }
    renderFrame();
    setStatus(`IMPORTED ${file.name} · ${w}×${h} × ${frames} · QUANTISED TO THE PALETTE`);
  } catch (err) {
    note(`IMPORT FAILED · ${err.message || err}`, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadStrip() {
  const a = document.createElement("a");
  a.href = stripCanvas().toDataURL("image/png");
  a.download = `${sanitizeKey($("spriteName").value) || "sprite"}_${state.w}x${state.h}${state.frames.length > 1 ? "x" + state.frames.length : ""}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------- wiring ---
document.querySelectorAll(".btn.tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("btnFlipH").addEventListener("click", () => flip(true));
$("btnFlipV").addEventListener("click", () => flip(false));
$("btnShiftL").addEventListener("click", () => shift(-1, 0));
$("btnShiftR").addEventListener("click", () => shift(1, 0));
$("btnShiftU").addEventListener("click", () => shift(0, -1));
$("btnShiftD").addEventListener("click", () => shift(0, 1));
$("btnUndo").addEventListener("click", undo);
$("btnRedo").addEventListener("click", redo);
$("btnGrid").addEventListener("click", () => {
  state.grid = !state.grid;
  $("btnGrid").classList.toggle("active", state.grid);
  renderOverlay();
});
$("btnCells").addEventListener("click", () => {
  state.cells = !state.cells;
  $("btnCells").classList.toggle("active", state.cells);
  renderOverlay();
});
$("btnZoomIn").addEventListener("click", () => zoomBy(1));
$("btnZoomOut").addEventListener("click", () => zoomBy(-1));
$("btnClear").addEventListener("click", () => {
  pushUndo();
  frame().fill(0);
  state.dirty = true;
  renderFrame();
});
$("btnFrameAdd").addEventListener("click", () => addFrame(false));
$("btnFrameDup").addEventListener("click", () => addFrame(true));
$("btnFrameDel").addEventListener("click", deleteFrame);
$("btnNew").addEventListener("click", () => {
  if (state.dirty && !confirm("Start a new sprite and discard unsaved changes?")) return;
  const [w, h] = $("sizeSelect").value.split("x").map(Number);
  $("spriteName").value = "";
  state.name = "";
  newSprite(w, h);
  history.replaceState(null, "", location.pathname);
  setStatus(`NEW ${w}×${h} SPRITE`);
});
$("btnCloudSave").addEventListener("click", saveToCloud);
$("btnCloudDelete").addEventListener("click", deleteFromCloud);
$("btnCloudRefresh").addEventListener("click", () => renderCloudList());
$("btnDownload").addEventListener("click", downloadStrip);
$("fileImport").addEventListener("change", (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (f) importImage(f);
  ev.target.value = "";
});
$("spriteName").addEventListener("input", () => {
  state.name = $("spriteName").value;
  state.dirty = true;
});
document.addEventListener("dragover", (ev) => ev.preventDefault());
document.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (f && /^image\//.test(f.type)) importImage(f);
});

document.addEventListener("keydown", (ev) => {
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === "z") { ev.preventDefault(); undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.shiftKey && ev.key.toLowerCase() === "z"))) { ev.preventDefault(); redo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); saveToCloud(); return; }
  switch (ev.key) {
    case "b": case "B": setTool("pencil"); break;
    case "e": case "E": setTool("eraser"); break;
    case "g": case "G": setTool("fill"); break;
    case "l": case "L": setTool("line"); break;
    case "r": case "R": setTool("rect"); break;
    case "i": case "I": setTool("pick"); break;
    case "h": case "H": flip(true); break;
    case "v": case "V": flip(false); break;
    case "[": zoomBy(-1); break;
    case "]": zoomBy(1); break;
    case ",": selectFrame(state.frame - 1); break;
    case ".": selectFrame(state.frame + 1); break;
    case "ArrowLeft": ev.preventDefault(); shift(-1, 0); break;
    case "ArrowRight": ev.preventDefault(); shift(1, 0); break;
    case "ArrowUp": ev.preventDefault(); shift(0, -1); break;
    case "ArrowDown": ev.preventDefault(); shift(0, 1); break;
    case "x": case "X": { const s = state.color; state.color = state.secondary; state.secondary = s; renderPalette(); break; }
    default: return;
  }
});
window.addEventListener("beforeunload", (ev) => {
  if (state.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

// ---------------------------------------------------------------- boot ---
populateSizes();
populatePaletteSelect();
await loadPaletteSource("deza2");
const params = new URLSearchParams(location.search);
const sizeParam = params.get("size");
if (sizeParam && /^\d+x\d+$/.test(sizeParam)) {
  const [w, h] = sizeParam.split("x").map(Number);
  if (w % CELL === 0 && h % CELL === 0 && w <= 64 && h <= 64) newSprite(w, h);
}
renderFrame();
watchCloud();
if (params.get("sprite")) loadFromCloud(params.get("sprite"));

// Test hook: scripted checks drive the editor without a pointer.
window.__pixelEditor = {
  state,
  setPixel: (x, y, v) => { setPixel(frame(), x, y, v); renderFrame(); },
  getPixel: (x, y) => getPixel(frame(), x, y),
  buildRecord,
  applyRecord,
  newSprite,
  resizeSprite,
  selectColor,
  undo,
  redo,
};
