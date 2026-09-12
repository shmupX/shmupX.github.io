// pixel-editor.js — a data-backed pixel editor for Dezaemon 2 CG art, drawn
// together in live rooms.
//
// The sprite is never an RGBA image here. It is w x h palette INDICES, edited
// over the 288-colour DEZA2.PAL (see
// packages/shmup-engine/src/palette/deza2-palette.js), and it is stored the
// way a Saturn save stores art: 16x16 cells of (palette<<4)|colour bytes in
// reading order, plus the 16x16 RGB555 bank a save's sec4 would carry. That
// is the contract the .sav writer consumes (the engine's write/ modules), so a
// sprite drawn here can be dropped into a CG page unchanged. The RGBA render
// is derived from it (and also stored, for tools that only read pictures —
// spriteX's PACKER reads sprites/*, the Tilemap Editor reads pixelSprites/*
// live).
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
// Rooms. Every open editor is in a room (?room=CODE, minted when absent) and
// the room IS the sprite being drawn: everyone on the link edits the same
// pixels live, the way a shared document works —
//
//   pixelRooms/{code}/meta                 { w, h, frameCount, name, updatedAt }
//   pixelRooms/{code}/frames/{f}/{i}       palette index (sparse — 0 is absent)
//   pixelRooms/{code}/palette/{i}          RGB555 word, user rows 192–255 only
//   pixelRooms/{code}/presence/{client}    { n: name, k: colour, at, c: {x, y, f} }
//
// Pixels travel as single writes (batched every 40 ms), so the last pixel
// written wins; structure (size, frame count, name, the user palette) is
// pushed whole and adopted by everyone. Undo is per client — a diff of the
// pixels this client changed — and is dropped when the sprite changes shape
// underneath it. A cloud sprite (pixelSprites/*) is a snapshot; the room is
// the live copy, and loading a snapshot loads it into the room.
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
const MAX_SIZE = 64;
const MAX_FRAMES = 6;
const UNDO_LIMIT = 80;
const ZOOMS = [2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];
// Narrower than this and the two docks become drawers over the canvas (the
// CMG Desktop's window, a phone, a split screen); wider and they sit beside it.
const BREAKPOINT = 1080;
const PEER_COLORS = ["#FF6BD6", "#6BD8FF", "#FFB84A", "#B48CFF", "#FF7A5C", "#7CFF4F", "#F6FF4A", "#5CFFC9"];
// No 0/O or 1/I, so a code read out loud survives.
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const IDENTITY_KEY = "shmupx.pixel-editor.identity";
const CLIENT_KEY = "shmupx.pixel-editor.client";

// -------------------------------------------------------- palette sources ---
const PALETTE_SOURCES = {
  deza2: {
    label: "DEZAEMON 2 · DEZA2.PAL (288)",
    bands: [
      { name: "SYSTEM", rows: E.DEZA2_SYSTEM_ROWS, editable: false, paintable: true },
      { name: "USER", rows: E.DEZA2_USER_ROWS, editable: true, paintable: true },
      { name: "UI (NOT CG)", rows: E.DEZA2_UI_ROWS, editable: false, paintable: false },
    ],
    // The engine table is what /palette.png is built from (scripts/build-palette.ts).
    words: () => [...E.DEZA2_PALETTE_WORDS],
  },
  sfc: {
    label: "SUPER FAMICOM · 15-BIT BGR (SOON)",
    disabled: true,
  },
};

// ------------------------------------------------------------------ state ---
// The sprite, as everyone in the room sees it.
const doc = {
  w: 16,
  h: 16,
  frames: [new Uint8Array(16 * 16)], // row-major indices
  frame: 0,
  tool: "pencil",
  color: 1,
  secondary: 0,
  zoom: 16,
  grid: true,
  cells: true,
  name: "",
  dirty: false,
  cloudKey: null,
  source: "deza2",
  fps: 6,
  rev: 0, // bumped on every visible pixel change; the frame strip keys off it
};
let words = []; // palette words, index = CG pixel byte for < 256
let rgb = []; // deza2PaletteRgb(words)
let palRev = 0;
const undoStack = [];
const redoStack = [];
let op = null; // the stroke in progress: { frame, before: Map<index, oldValue> }
// This window only.
const ui = { narrow: false, leftOpen: false, rightOpen: false, shortcuts: false, status: "PIXEL EDITOR READY", note: "", noteWarn: false, autoZoom: true };
const net = { db: null, room: null, roomRefs: [], me: null, roomId: "", state: "connecting", peers: {}, self: null, shareUrl: "", peerSig: "" };
let cloud = {}; // key -> record summary
let cloudLoaded = false;
let pending = {}; // room paths waiting for the next flush
let flushTimer = null, rafId = null, softTimer = null, nameTimer = null, mixTimer = null, fitRaf = null;
let cursorAt = 0;
let hover = null; // {x, y}
let drag = null; // {x0, y0, x1, y1, color} for line/rect
let stroke = null; // {color, last}
let pendingSprite = null; // ?sprite= to load once the room is joined
const memo = {};

// ------------------------------------------------------------- utilities ---
function setStatus(msg) {
  ui.status = msg;
  const el = $("status");
  if (el) el.textContent = msg;
}
function note(msg, warn = false) {
  ui.note = msg;
  ui.noteWarn = warn;
  const el = $("note");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("warn", warn);
}
function randCode(n) {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < n; i++) s += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
  return s;
}
function roomCode(param) {
  const code = String(param || "").trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(code) ? code : randCode(6);
}
function sanitizeKey(name) {
  return String(name || "").trim().replace(/[.#$\[\]\/\s]+/g, "_").replace(/^_+|_+$/g, "");
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
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
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
function cellCount() {
  return (doc.w / CELL) * (doc.h / CELL);
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "S"}`;
}

// Who this window is: a name and a colour that persist (localStorage), and a
// client id per tab (sessionStorage) so two tabs of one person are two seats.
function loadIdentity() {
  let id = null;
  try {
    id = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null");
  } catch (_e) {
    id = null;
  }
  if (!id || !id.name || !id.color) {
    id = { name: "PILOT-" + randCode(4), color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] };
    try {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(id));
    } catch (_e) { /* private mode */ }
  }
  let cid = null;
  try {
    cid = sessionStorage.getItem(CLIENT_KEY);
    if (!cid) {
      cid = randCode(8);
      sessionStorage.setItem(CLIENT_KEY, cid);
    }
  } catch (_e) {
    cid = randCode(8);
  }
  return { id: cid, name: String(id.name).slice(0, 12).toUpperCase(), color: id.color };
}
function saveIdentity() {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name: net.self.name, color: net.self.color }));
  } catch (_e) { /* ignore */ }
}
// The address bar becomes the share link: just ?room=, so a link passed on
// carries the room and nothing that would re-run a hand-off (?sprite=, ?size=)
// in every window that opens it.
function setRoomId(id) {
  net.roomId = id;
  try {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("room", id);
    history.replaceState(null, "", u);
    net.shareUrl = u.href;
  } catch (_e) {
    net.shareUrl = location.origin + location.pathname + "?room=" + id;
  }
}

// --------------------------------------------------------------- firebase ---
function initNet() {
  try {
    if (typeof firebase !== "undefined" && window.__FIREBASE_CONFIG__) {
      const app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(window.__FIREBASE_CONFIG__);
      net.db = firebase.database(app);
    }
  } catch (err) {
    console.warn("Firebase init failed:", err);
    net.db = null;
  }
  if (!net.db) {
    net.state = "offline";
    setStatus("FIREBASE UNAVAILABLE — LOCAL ONLY");
    refresh();
    return;
  }
  watchCloud();
  joinRoom(net.roomId);
}
function netFail(err) {
  const msg = (err && err.message) || String(err);
  console.warn("sync failed:", err);
  if (/permission/i.test(msg)) {
    leaveRoom();
    net.state = "denied";
    setStatus("ROOM SYNC DENIED BY RTDB RULES — LOCAL ONLY");
  } else {
    net.state = "error";
    setStatus("SYNC FAILED · " + msg);
  }
  refresh();
}

// ------------------------------------------------------------- rendering ---
const app = $("app");
const canvas = $("pxCanvas");
const overlay = $("pxOverlay");
const workspace = $("workspace");
const ctx = canvas.getContext("2d");
const octx = overlay.getContext("2d");

function frame() {
  return doc.frames[doc.frame];
}

// paint(): the sprite changed — repaint the canvas and everything that shows it.
function paint() {
  doc.rev++;
  paintFrame();
  refresh();
}
function paintFrame() {
  const { w, h } = doc;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.putImageData(new ImageData(E.indexedToRgbaWith(frame(), rgb), w, h), 0, 0);
  applyZoom();
  paintOverlay();
}
function applyZoom() {
  const { w, h, zoom } = doc;
  const W = w * zoom, H = h * zoom;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  // One checker square per sprite pixel, whatever the zoom.
  canvas.style.backgroundSize = `${zoom * 2}px ${zoom * 2}px`;
  if (overlay.width !== W || overlay.height !== H) {
    overlay.width = W;
    overlay.height = H;
  }
  overlay.style.width = `${W}px`;
  overlay.style.height = `${H}px`;
}
function paintOverlay() {
  const { w, h, zoom: z } = doc;
  const g = octx;
  g.clearRect(0, 0, overlay.width, overlay.height);
  if (doc.grid && z >= 6) {
    g.strokeStyle = "rgba(140,255,110,.14)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      g.moveTo(x * z + 0.5, 0);
      g.lineTo(x * z + 0.5, h * z);
    }
    for (let y = 0; y <= h; y++) {
      g.moveTo(0, y * z + 0.5);
      g.lineTo(w * z, y * z + 0.5);
    }
    g.stroke();
  }
  if (doc.cells && (w > CELL || h > CELL)) {
    g.strokeStyle = "rgba(255,184,74,.6)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = CELL; x < w; x += CELL) {
      g.moveTo(x * z + 0.5, 0);
      g.lineTo(x * z + 0.5, h * z);
    }
    for (let y = CELL; y < h; y += CELL) {
      g.moveTo(0, y * z + 0.5);
      g.lineTo(w * z, y * z + 0.5);
    }
    g.stroke();
  }
  if (drag) {
    const pts = doc.tool === "line" ? linePoints(drag.x0, drag.y0, drag.x1, drag.y1) : rectPoints(drag.x0, drag.y0, drag.x1, drag.y1);
    const p = rgb[drag.color] || { r: 0, g: 0, b: 0 };
    g.fillStyle = drag.color === 0 ? "rgba(255,255,255,.35)" : `rgba(${p.r},${p.g},${p.b},.85)`;
    for (const [x, y] of pts) g.fillRect(x * z, y * z, z, z);
  }
  // Everyone else's cursor, in their colour, with their name beside it.
  for (const p of Object.values(net.peers)) {
    const c = p && p.c;
    if (!c || c.f !== doc.frame || c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) continue;
    g.strokeStyle = p.k || "#fff";
    g.lineWidth = Math.max(1, Math.round(z / 8));
    g.strokeRect(c.x * z + 0.5, c.y * z + 0.5, z - 1, z - 1);
    const label = String(p.n || "?").slice(0, 12);
    g.font = '10px "Share Tech Mono", monospace';
    const tw = Math.ceil(g.measureText(label).width) + 8;
    let lx = c.x * z + z + 3, ly = c.y * z - 15;
    if (lx + tw > overlay.width) lx = c.x * z - tw - 3;
    if (ly < 0) ly = c.y * z + z + 3;
    if (lx < 0) lx = 0;
    g.fillStyle = p.k || "#fff";
    g.fillRect(lx, ly, tw, 14);
    g.fillStyle = "#0a120b";
    g.textBaseline = "middle";
    g.fillText(label, lx + 4, ly + 7);
  }
  if (hover) {
    g.strokeStyle = "rgba(246,255,74,.95)";
    g.lineWidth = Math.max(1, Math.round(z / 8));
    g.strokeRect(hover.x * z + 0.5, hover.y * z + 0.5, z - 1, z - 1);
  }
}
function showInfo(p) {
  const v = getPixel(p.x, p.y);
  $("pxInfo").textContent = `${p.x},${p.y} · CELL ${p.x >> 4},${p.y >> 4} · IDX ${v}` +
    (v > 0 ? ` (${rgbHex(rgb[v]).toUpperCase()})` : v === 0 ? " (TRANSPARENT)" : "");
}

// The animation preview cycles the frames at the strip's FPS: animTimer
// advances the frame, the paint interval just paints whichever is current.
let animTick = 0;
function paintAnim() {
  const c = $("animPreview");
  if (doc.frames.length < 2) animTick = 0;
  if (c.width !== doc.w || c.height !== doc.h) {
    c.width = doc.w;
    c.height = doc.h;
  }
  const fr = doc.frames[animTick] || frame();
  c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(fr, rgb), doc.w, doc.h), 0, 0);
  const box = Math.min(52 / doc.w, 52 / doc.h);
  c.style.width = `${Math.round(doc.w * box)}px`;
  c.style.height = `${Math.round(doc.h * box)}px`;
}
function animStep() {
  if (doc.frames.length >= 2) animTick = (animTick + 1) % doc.frames.length;
}
let animTimer = setInterval(animStep, 1000 / doc.fps);
setInterval(paintAnim, 1000 / 6);

// Auto-fit: the largest zoom step that shows the whole sprite, re-fitted when
// the workspace changes size, until the user zooms by hand.
function fitZoom() {
  ui.autoZoom = true;
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = null;
    fitNow();
  });
}
function fitNow() {
  if (!ui.autoZoom) return;
  const aw = workspace.clientWidth - 48, ah = workspace.clientHeight - 48;
  if (aw < 60 || ah < 60) return;
  let z = ZOOMS[0];
  for (const cand of ZOOMS) if (doc.w * cand <= aw && doc.h * cand <= ah) z = cand;
  if (z !== doc.zoom) {
    doc.zoom = z;
    applyZoom();
    paintOverlay();
    renderTools();
  }
}
function zoomBy(dir) {
  ui.autoZoom = false;
  const i = ZOOMS.indexOf(doc.zoom);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 6 : i) + dir))];
  doc.zoom = next;
  applyZoom();
  paintOverlay();
  setStatus(`ZOOM ${next}×`);
  renderTools();
}

// ------------------------------------------------------- pixels + undo ---
function getPixel(x, y) {
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return -1;
  return frame()[y * doc.w + x];
}
// Every pixel change goes through puti(): it records the old value for the
// stroke's undo entry and queues the write to the room.
function beginOp() {
  op = { frame: doc.frame, before: new Map() };
}
function puti(i, v) {
  const fr = frame();
  if (i < 0 || i >= fr.length) return;
  const old = fr[i];
  if (old === v) return;
  if (op && !op.before.has(i)) op.before.set(i, old);
  fr[i] = v;
  queueNet(doc.frame, i, v);
}
function put(x, y, v) {
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
  puti(y * doc.w + x, v);
}
function endOp() {
  const done = op;
  op = null;
  if (!done || !done.before.size) return;
  const fr = doc.frames[done.frame];
  const after = new Map();
  for (const i of done.before.keys()) after.set(i, fr[i]);
  undoStack.push({ frame: done.frame, w: doc.w, h: doc.h, before: done.before, after });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  doc.dirty = true;
}
function applyDiff(e, map) {
  if (e.w !== doc.w || e.h !== doc.h || e.frame >= doc.frames.length) return false;
  doc.frame = e.frame;
  const fr = doc.frames[e.frame];
  for (const [i, v] of map) {
    fr[i] = v;
    queueNet(e.frame, i, v);
  }
  doc.dirty = true;
  return true;
}
function undo() {
  const e = undoStack.pop();
  if (!e) return;
  if (applyDiff(e, e.before)) {
    redoStack.push(e);
    flushNet();
    paint();
    setStatus("UNDO");
  } else {
    setStatus("UNDO SKIPPED — THE SPRITE CHANGED SHAPE SINCE");
    refresh();
  }
}
function redo() {
  const e = redoStack.pop();
  if (!e) return;
  if (applyDiff(e, e.after)) {
    undoStack.push(e);
    flushNet();
    paint();
    setStatus("REDO");
  } else {
    setStatus("REDO SKIPPED — THE SPRITE CHANGED SHAPE SINCE");
    refresh();
  }
}
function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
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
function floodFill(x, y, v) {
  const fr = frame();
  const target = getPixel(x, y);
  if (target < 0 || target === v) return;
  const stack = [[x, y]];
  const { w, h } = doc;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    if (fr[cy * w + cx] !== target) continue;
    puti(cy * w + cx, v);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}
// A transform of the whole frame is one undo step of only the pixels it changed.
function wholeFrameOp(fn) {
  const out = fn(frame().slice(), doc.w, doc.h);
  beginOp();
  for (let i = 0; i < out.length; i++) puti(i, out[i]);
  endOp();
  flushNet();
  paint();
}
function flip(horizontal) {
  wholeFrameOp((fr, w, h) => {
    const out = new Uint8Array(fr.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = horizontal ? fr[y * w + (w - 1 - x)] : fr[(h - 1 - y) * w + x];
    }
    return out;
  });
}
function shift(dx, dy) {
  wholeFrameOp((fr, w, h) => {
    const out = new Uint8Array(fr.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x - dx, sy = y - dy;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = fr[sy * w + sx];
      }
    }
    return out;
  });
}
function clearFrame() {
  wholeFrameOp((fr) => new Uint8Array(fr.length));
  setStatus("FRAME CLEARED");
}

// --------------------------------------------------------------- pointer ---
function pixelAt(ev) {
  const r = overlay.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / doc.zoom);
  const y = Math.floor((ev.clientY - r.top) / doc.zoom);
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
  return { x, y };
}
overlay.addEventListener("pointerdown", (ev) => {
  const p = pixelAt(ev);
  if (!p) return;
  ev.preventDefault();
  try {
    overlay.setPointerCapture(ev.pointerId);
  } catch (_e) { /* ignore */ }
  const erase = ev.button === 2 || doc.tool === "eraser";
  const color = erase ? 0 : doc.color;
  if (doc.tool === "pick") {
    const v = getPixel(p.x, p.y);
    if (v >= 0) selectColor(v);
    return;
  }
  beginOp();
  stroke = { color, last: p };
  if (doc.tool === "fill") {
    floodFill(p.x, p.y, color);
    endOp();
    stroke = null;
    flushNet();
    paint();
    return;
  }
  if (doc.tool === "line" || doc.tool === "rect") {
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, color };
    paintOverlay();
    return;
  }
  put(p.x, p.y, color);
  paintFrame();
});
overlay.addEventListener("pointermove", (ev) => {
  const p = pixelAt(ev);
  hover = p;
  if (p) {
    showInfo(p);
    sendCursor(p);
  }
  if (stroke && p) {
    if (drag) {
      drag.x1 = p.x;
      drag.y1 = p.y;
    } else {
      // Bresenham between events so a fast drag leaves no gaps.
      for (const [x, y] of linePoints(stroke.last.x, stroke.last.y, p.x, p.y)) put(x, y, stroke.color);
      stroke.last = p;
      paintFrame();
      return;
    }
  }
  paintOverlay();
});
function endStroke() {
  if (drag) {
    const pts = doc.tool === "line" ? linePoints(drag.x0, drag.y0, drag.x1, drag.y1) : rectPoints(drag.x0, drag.y0, drag.x1, drag.y1);
    for (const [x, y] of pts) put(x, y, drag.color);
    drag = null;
  }
  if (stroke) {
    endOp();
    stroke = null;
    flushNet();
    paint();
  }
}
overlay.addEventListener("pointerup", endStroke);
overlay.addEventListener("pointercancel", endStroke);
overlay.addEventListener("pointerleave", () => {
  hover = null;
  sendCursor(null);
  paintOverlay();
});
overlay.addEventListener("contextmenu", (ev) => ev.preventDefault());
workspace.addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  zoomBy(ev.deltaY < 0 ? 1 : -1);
}, { passive: false });

// ---------------------------------------------------------------- palette ---
function setTool(t) {
  doc.tool = t;
  renderTools();
}
function selectColor(i) {
  if (!paintable(i)) {
    setStatus(`INDEX ${i} IS AN EDITOR-UI COLOUR — A CG PIXEL CANNOT CARRY IT`);
    return;
  }
  doc.color = i;
  if (doc.tool === "eraser") doc.tool = "pencil";
  setStatus(`COLOUR ${i} · ${paletteBand(i).toUpperCase()} ROW ${i >> 4} COL ${i & 15}`);
  renderTools();
  renderPaletteSelection();
  renderColorInfo();
}
function setSecondary(i) {
  if (!paintable(i)) return;
  doc.secondary = i;
  renderPaletteSelection();
}
// Mix a user colour: quantised to 15 bits so it is exactly what the bank
// will hold; every pixel already painted with that index follows, here and
// on everyone else's canvas.
function mixColor(hexColor) {
  const i = doc.color;
  if (paletteBand(i) !== "user") return;
  const r = parseInt(hexColor.slice(1, 3), 16), g = parseInt(hexColor.slice(3, 5), 16), b = parseInt(hexColor.slice(5, 7), 16);
  const wd = E.rgb8ToRgb555(r, g, b);
  if (words[i] === wd) return;
  words[i] = wd;
  rgb = E.deza2PaletteRgb(words);
  palRev++;
  doc.dirty = true;
  clearTimeout(mixTimer);
  mixTimer = setTimeout(() => {
    if (net.room) net.room.child("palette/" + i).set(words[i]).catch(netFail);
  }, 150);
  paint();
}
function loadPaletteSource(id) {
  const src = PALETTE_SOURCES[id];
  if (!src || src.disabled) return;
  doc.source = id;
  words = src.words();
  rgb = E.deza2PaletteRgb(words);
  palRev++;
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
  sel.value = doc.source;
  sel.addEventListener("change", () => {
    if (PALETTE_SOURCES[sel.value] && !PALETTE_SOURCES[sel.value].disabled) {
      loadPaletteSource(sel.value);
      paint();
    } else {
      setStatus("SUPER FAMICOM PALETTE — SOON");
      sel.value = doc.source;
    }
  });
}

// ------------------------------------------------------------- structure ---
function populateSizes() {
  const sel = $("sizeSelect");
  sel.innerHTML = "";
  for (const s of E.DEZA2_ZAKO_SIZES) {
    const c = (s.w / CELL) * (s.h / CELL);
    const opt = document.createElement("option");
    opt.value = `${s.w}x${s.h}`;
    opt.textContent = `${s.label} · ${plural(c, "CELL")} · ZAKO ×${s.frames}`;
    sel.appendChild(opt);
  }
  sel.value = `${doc.w}x${doc.h}`;
  sel.addEventListener("change", () => {
    const [w, h] = sel.value.split("x").map(Number);
    resizeSprite(w, h);
  });
}
// Resizing keeps the top-left of every frame: pixels outside are dropped, new
// space is transparent. Structure changes are not undoable — they are pushed
// whole to the room, and everyone's history is reset with them.
function resizeSprite(w, h) {
  if (w === doc.w && h === doc.h) return;
  doc.frames = doc.frames.map((fr) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < Math.min(h, doc.h); y++) {
      out.set(fr.subarray(y * doc.w, y * doc.w + Math.min(w, doc.w)), y * w);
    }
    return out;
  });
  doc.w = w;
  doc.h = h;
  doc.dirty = true;
  clearHistory();
  fitZoom();
  pushStructure();
  paint();
  setStatus(`RESIZED TO ${w}×${h}`);
}
function selectFrame(i) {
  doc.frame = Math.max(0, Math.min(doc.frames.length - 1, i));
  hover = null;
  paint();
}
function addFrame(duplicate) {
  if (doc.frames.length >= MAX_FRAMES) return;
  const fr = duplicate ? frame().slice() : new Uint8Array(doc.w * doc.h);
  doc.frames.splice(doc.frame + 1, 0, fr);
  doc.frame++;
  doc.dirty = true;
  clearHistory();
  pushStructure();
  paint();
}
function deleteFrame() {
  if (doc.frames.length <= 1) return;
  doc.frames.splice(doc.frame, 1);
  doc.frame = Math.min(doc.frame, doc.frames.length - 1);
  doc.dirty = true;
  clearHistory();
  pushStructure();
  paint();
}
// A new sprite is a new room: the old one keeps what was drawn in it.
function newSprite(w, h) {
  doc.frames = [new Uint8Array(w * h)];
  doc.frame = 0;
  doc.w = w;
  doc.h = h;
  doc.name = "";
  doc.dirty = false;
  doc.cloudKey = null;
  clearHistory();
  const fresh = PALETTE_SOURCES[doc.source].words();
  for (let i = E.DEZA2_SYSTEM_ROWS * PAL_COLS; i < CG_COLORS; i++) words[i] = fresh[i];
  rgb = E.deza2PaletteRgb(words);
  palRev++;
  $("spriteName").value = "";
  fitZoom();
  newRoom(false);
  paint();
  setStatus(`NEW ${w}×${h} SPRITE · ROOM ${net.roomId}`);
}

// ---------------------------------------------------------------- rooms ---
function leaveRoom() {
  for (const r of net.roomRefs) {
    try {
      r.off();
    } catch (_e) { /* ignore */ }
  }
  net.roomRefs = [];
  if (net.me) {
    try {
      net.me.onDisconnect().cancel();
      net.me.remove();
    } catch (_e) { /* ignore */ }
  }
  net.room = null;
  net.me = null;
  net.peers = {};
  net.peerSig = "";
  pending = {};
  clearTimeout(flushTimer);
  flushTimer = null;
}
function joinRoom(id) {
  if (!net.db) return;
  leaveRoom();
  const room = net.db.ref("pixelRooms/" + id);
  net.room = room;
  net.state = "joining";
  refresh();
  room.child("meta").once("value").then((snap) => {
    if (net.room !== room) return; // moved on to another room meanwhile
    const meta = snap.val();
    // An empty room takes this window's sprite; an existing one is adopted,
    // pixels and all (they arrive as child_added right after this).
    if (!meta) pushStructure();
    else adoptMeta(meta, true);
    const metaRef = room.child("meta");
    metaRef.on("value", (s) => {
      const m = s.val();
      if (m) adoptMeta(m, false);
    });
    net.roomRefs.push(metaRef);
    for (let f = 0; f < MAX_FRAMES; f++) {
      const fr = room.child("frames/" + f);
      const on = (s) => onRemotePixel(f, +s.key, s.val() | 0);
      const off = (s) => onRemotePixel(f, +s.key, 0);
      fr.on("child_added", on);
      fr.on("child_changed", on);
      fr.on("child_removed", off);
      net.roomRefs.push(fr);
    }
    const pal = room.child("palette");
    const onPal = (s) => onRemotePalette(+s.key, s.val() | 0);
    pal.on("child_added", onPal);
    pal.on("child_changed", onPal);
    net.roomRefs.push(pal);
    const pres = room.child("presence");
    pres.on("value", (s) => onPresence(s.val() || {}));
    net.roomRefs.push(pres);
    net.me = pres.child(net.self.id);
    net.me.onDisconnect().remove();
    net.me.set({ n: net.self.name, k: net.self.color, at: firebase.database.ServerValue.TIMESTAMP }).catch(netFail);
    net.state = "live";
    setStatus(`ROOM ${id} · ${meta ? "JOINED" : "CREATED"} · SHARE THE LINK TO DRAW TOGETHER`);
    refresh();
    if (pendingSprite) {
      const key = pendingSprite;
      pendingSprite = null;
      loadFromCloud(key);
    }
  }).catch(netFail);
}
function newRoom(keepPixels = true) {
  const id = randCode(6);
  setRoomId(id);
  if (net.db) joinRoom(id);
  else refresh();
  if (keepPixels) setStatus(`FORKED INTO ROOM ${id} — THE OLD ROOM KEEPS ITS COPY`);
}
function sparseFrames() {
  const out = {};
  doc.frames.forEach((fr, f) => {
    const o = {};
    let any = false;
    for (let i = 0; i < fr.length; i++) {
      if (fr[i]) {
        o[i] = fr[i];
        any = true;
      }
    }
    if (any) out[f] = o;
  });
  return out;
}
// The whole sprite, replacing what the room holds: size, frames, name and the
// user palette. Pixel strokes never come through here.
function pushStructure() {
  const room = net.room;
  if (!room) return;
  const palette = {};
  for (let i = E.DEZA2_SYSTEM_ROWS * PAL_COLS; i < CG_COLORS; i++) if (words[i]) palette[i] = words[i];
  room.update({
    meta: { w: doc.w, h: doc.h, frameCount: doc.frames.length, name: doc.name || "", updatedAt: firebase.database.ServerValue.TIMESTAMP },
    frames: sparseFrames(),
    palette,
  }).catch(netFail);
}
function adoptMeta(m, initial) {
  const w = m.w | 0, h = m.h | 0, n = Math.max(1, Math.min(MAX_FRAMES, (m.frameCount | 0) || 1));
  if (w % CELL || h % CELL || w < CELL || h < CELL || w > MAX_SIZE || h > MAX_SIZE) return;
  // Joining always starts from the room's pixels; a shape change from someone
  // else does too (the frames are fetched again in one go).
  if (initial || w !== doc.w || h !== doc.h || n !== doc.frames.length) {
    doc.w = w;
    doc.h = h;
    doc.frames = Array.from({ length: n }, () => new Uint8Array(w * h));
    doc.frame = Math.min(doc.frame, n - 1);
    clearHistory();
    $("sizeSelect").value = `${w}x${h}`;
    fitZoom();
    if (!initial) resyncFrames();
  }
  if (typeof m.name === "string" && m.name !== doc.name && document.activeElement !== $("spriteName")) {
    doc.name = m.name;
    $("spriteName").value = m.name;
  }
  paint();
}
function resyncFrames() {
  const room = net.room;
  if (!room) return;
  room.child("frames").once("value").then((s) => {
    if (net.room !== room) return;
    const val = s.val() || {};
    for (const [fk, px] of Object.entries(val)) {
      const f = +fk;
      if (!(f >= 0 && f < doc.frames.length) || !px) continue;
      const fr = doc.frames[f];
      fr.fill(0);
      for (const [ik, v] of Object.entries(px)) {
        const i = +ik;
        if (i >= 0 && i < fr.length && v) fr[i] = v | 0;
      }
    }
    paint();
  }).catch(netFail);
}
// One pixel from the room. Our own writes echo back equal and return early;
// a stranger's is painted on the next frame and the thumbnails follow shortly.
function onRemotePixel(f, i, v) {
  if (!(f >= 0 && f < doc.frames.length)) return;
  const fr = doc.frames[f];
  if (!(i >= 0 && i < fr.length) || fr[i] === v) return;
  fr[i] = v;
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      paintFrame();
    });
  }
  if (!softTimer) {
    softTimer = setTimeout(() => {
      softTimer = null;
      doc.rev++;
      refresh();
    }, 200);
  }
}
function onRemotePalette(i, word) {
  if (paletteBand(i) !== "user") return;
  const wd = word & 0x7fff;
  if (words[i] === wd) return;
  words[i] = wd;
  rgb = E.deza2PaletteRgb(words);
  palRev++;
  paint();
}
function onPresence(val) {
  const peers = {};
  for (const [id, p] of Object.entries(val)) {
    if (id === net.self.id || !p) continue;
    peers[id] = p;
  }
  net.peers = peers;
  const sig = Object.entries(peers).map(([id, p]) => id + (p.n || "") + (p.k || "") + (p.c ? "F" + p.c.f : "")).join("|");
  paintOverlay();
  if (sig !== net.peerSig) {
    net.peerSig = sig;
    refresh();
  }
}
function sendCursor(p) {
  if (!net.me) return;
  const now = performance.now();
  if (p && now - cursorAt < 66) return;
  cursorAt = now;
  net.me.child("c").set(p ? { x: p.x, y: p.y, f: doc.frame } : null).catch(() => {});
}
function queueNet(f, i, v) {
  if (!net.room) return;
  pending["frames/" + f + "/" + i] = v || null;
  if (!flushTimer) flushTimer = setTimeout(flushNet, 40);
}
function flushNet() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const p = pending;
  pending = {};
  const room = net.room;
  if (!room || !Object.keys(p).length) return;
  p["meta/updatedAt"] = firebase.database.ServerValue.TIMESTAMP;
  room.update(p).catch(netFail);
}
function syncName() {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => {
    if (net.room) net.room.child("meta/name").set(doc.name || "").catch(() => {});
  }, 400);
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(net.shareUrl);
    setStatus(`LINK COPIED · ${net.shareUrl}`);
  } catch (_e) {
    setStatus(`COPY BLOCKED — SELECT THE LINK: ${net.shareUrl}`);
  }
}

// ---------------------------------------------------------------- cloud ---
function stripCanvas() {
  const c = document.createElement("canvas");
  c.width = doc.w * doc.frames.length;
  c.height = doc.h;
  const cx = c.getContext("2d");
  doc.frames.forEach((fr, i) => {
    cx.putImageData(new ImageData(E.indexedToRgbaWith(fr, rgb), doc.w, doc.h), i * doc.w, 0);
  });
  return c;
}
function frameDataURL(i) {
  const c = document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(doc.frames[i], rgb), doc.w, doc.h), 0, 0);
  return c.toDataURL("image/png");
}
function bankBase64() {
  const bank = E.paletteBankWords(words);
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
    name: doc.name,
    w: doc.w,
    h: doc.h,
    cellsW: doc.w / CELL,
    cellsH: doc.h / CELL,
    frameCount: doc.frames.length,
    frames: doc.frames.map((fr) => bytesToBase64(E.indexedToCells(fr, doc.w, doc.h))),
    paletteBank: bankBase64(),
    palette: doc.source,
    png: stripCanvas().toDataURL("image/png"),
    frameW: doc.w,
    frameH: doc.h,
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
      if (paletteBand(i) !== "user") continue;
      words[i] = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7fff;
    }
    rgb = E.deza2PaletteRgb(words);
    palRev++;
  }
  doc.frames = rec.frames.map((b64) => {
    const cells = base64ToBytes(b64);
    if (cells.length !== w * h) throw new Error("frame byte count does not match the sprite size");
    return E.cellsToIndexed(cells, w, h);
  });
  doc.frame = 0;
  doc.w = w;
  doc.h = h;
  doc.name = rec.name || key;
  doc.cloudKey = key;
  doc.dirty = false;
  clearHistory();
  $("spriteName").value = doc.name;
  $("sizeSelect").value = `${w}x${h}`;
  fitZoom();
  pushStructure();
  paint();
}
async function saveToCloud() {
  const name = sanitizeKey(doc.name);
  if (!name) {
    note("NAME THE SPRITE FIRST", true);
    $("spriteName").focus();
    return;
  }
  if (!net.db) {
    note("FIREBASE UNAVAILABLE", true);
    return;
  }
  doc.name = name;
  $("spriteName").value = name;
  const rec = buildRecord();
  setStatus(`SAVING pixelSprites/${name}…`);
  try {
    const updates = {};
    updates[`pixelSprites/${name}`] = rec;
    // spriteX's PACKER lists sprites/* (a dataURL, or {png}); one per frame
    // so each is usable as a replacement frame.
    if (doc.frames.length === 1) {
      updates[`sprites/${name}`] = frameDataURL(0);
    } else {
      doc.frames.forEach((_, i) => {
        updates[`sprites/${name}_${i}`] = frameDataURL(i);
      });
    }
    await net.db.ref().update(updates);
    doc.cloudKey = name;
    doc.dirty = false;
    syncName();
    setStatus(`SAVED · pixelSprites/${name} + sprites/${name}${doc.frames.length > 1 ? "_0…" + (doc.frames.length - 1) : ""}`);
    note(`SAVED pixelSprites/${name}`);
    try {
      new BroadcastChannel("pixel-editor").postMessage({ type: "pixel-sprite-saved", key: name });
    } catch (_e) { /* no BroadcastChannel */ }
    refresh();
  } catch (err) {
    console.error(err);
    note(`SAVE FAILED · ${err.message || err}`, true);
    setStatus("SAVE FAILED");
  }
}
async function deleteFromCloud() {
  const key = doc.cloudKey;
  if (!key || !net.db) return;
  if (!confirm(`Delete pixelSprites/${key} (and its sprites/* frames) from the cloud?`)) return;
  try {
    const updates = { [`pixelSprites/${key}`]: null, [`sprites/${key}`]: null };
    for (let i = 0; i < MAX_FRAMES; i++) updates[`sprites/${key}_${i}`] = null;
    await net.db.ref().update(updates);
    doc.cloudKey = null;
    setStatus(`DELETED pixelSprites/${key}`);
    refresh();
  } catch (err) {
    note(`DELETE FAILED · ${err.message || err}`, true);
  }
}
async function loadFromCloud(key) {
  if (!net.db) return;
  if (doc.dirty && !confirm(`Load "${key}" into this room and discard unsaved changes?`)) return;
  setStatus(`LOADING pixelSprites/${key}…`);
  try {
    const snap = await net.db.ref(`pixelSprites/${key}`).once("value");
    const rec = snap.val();
    if (!rec) throw new Error("record not found");
    applyRecord(key, rec);
    setStatus(`LOADED · pixelSprites/${key} · ${rec.w}×${rec.h} × ${rec.frameCount || rec.frames.length} · INTO ROOM ${net.roomId}`);
  } catch (err) {
    console.error(err);
    note(`LOAD FAILED · ${err.message || err}`, true);
  }
}
// The list follows the database live, so a sprite saved from another window
// (or deleted) shows up without a refresh.
function watchCloud() {
  net.db.ref("pixelSprites").on("value", (snap) => {
    const val = snap.val() || {};
    cloud = {};
    for (const [key, rec] of Object.entries(val)) {
      if (!rec || typeof rec !== "object") continue;
      cloud[key] = { w: rec.w, h: rec.h, frameCount: rec.frameCount || (rec.frames || []).length, png: rec.png, updatedAt: rec.updatedAt || 0 };
    }
    cloudLoaded = true;
    renderCloudList();
  }, (err) => {
    console.error(err);
    cloudLoaded = true;
    note(`CLOUD LIST FAILED · ${err.message || err}`, true);
    renderCloudList();
  });
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
    const asStrip = c.width > c.height && c.width % c.height === 0 && c.height % CELL === 0 && c.width / c.height <= MAX_FRAMES;
    if (asStrip && confirm(`Treat this ${c.width}×${c.height} image as ${c.width / c.height} frames of ${c.height}×${c.height}?`)) {
      fw = c.height;
      frames = c.width / c.height;
    }
    if (fw > MAX_SIZE || fh > MAX_SIZE) {
      note(`IMAGE LARGER THAN ${MAX_SIZE}×${MAX_SIZE} — CROPPED TO THE TOP-LEFT ${MAX_SIZE}×${MAX_SIZE}`, true);
    }
    const w = Math.min(MAX_SIZE, fw), h = Math.min(MAX_SIZE, fh);
    const out = [];
    for (let f = 0; f < frames; f++) {
      const fr = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = f * fw + x, sy = y;
          if (sx >= c.width || sy >= c.height) continue;
          const o = (sy * c.width + sx) * 4;
          if (src[o + 3] < 128) continue;
          fr[y * w + x] = E.nearestPaletteIndex(src[o], src[o + 1], src[o + 2], rgb);
        }
      }
      out.push(fr);
    }
    doc.frames = out;
    doc.frame = 0;
    doc.w = w;
    doc.h = h;
    doc.dirty = true;
    clearHistory();
    if (!doc.name) {
      doc.name = sanitizeKey(file.name.replace(/\.[^.]+$/, ""));
      $("spriteName").value = doc.name;
      syncName();
    }
    $("sizeSelect").value = `${w}x${h}`;
    if (!E.DEZA2_ZAKO_SIZES.some((s) => s.w === w && s.h === h)) {
      note(`${w}×${h} IS NOT A ZAKO FRAME SIZE — STILL WHOLE CELLS, STILL SAVE-WRITER READY`);
    }
    fitZoom();
    pushStructure();
    paint();
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
  a.download = `${sanitizeKey(doc.name) || "sprite"}_${doc.w}x${doc.h}${doc.frames.length > 1 ? "x" + doc.frames.length : ""}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------ rendering ---
// refresh(): everything that shows state, cheap enough to run after any
// change. The two expensive parts (swatches, frame thumbnails) are memoised.
function refresh() {
  renderLayout();
  renderTopbar();
  renderTools();
  renderPaletteGrid();
  renderPaletteSelection();
  renderColorInfo();
  renderHead();
  renderFrameStrip();
  renderRoom();
  renderCloudMeta();
  renderFooter();
}
function renderLayout() {
  const narrow = window.innerWidth < BREAKPOINT;
  if (narrow !== ui.narrow) {
    ui.narrow = narrow;
    if (!narrow) ui.leftOpen = ui.rightOpen = false;
  }
  app.classList.toggle("narrow", narrow);
  app.classList.toggle("left-open", narrow && ui.leftOpen);
  app.classList.toggle("right-open", narrow && ui.rightOpen);
  $("scrim").hidden = !(narrow && (ui.leftOpen || ui.rightOpen));
}
function peerList() {
  return Object.entries(net.peers).map(([id, q]) => ({
    id,
    name: String(q.n || "?").slice(0, 12),
    color: q.k || "#fff",
    meta: q.c && q.c.f !== undefined ? `F${(q.c.f | 0) + 1}` : "HERE",
  }));
}
function renderTopbar() {
  const share = $("shareUrl");
  if (share.value !== net.shareUrl) share.value = net.shareUrl;
  const others = peerList();
  const self = net.self || { name: "", color: "#7CFF4F" };
  const key = `${self.name}|${self.color}|${net.peerSig}`;
  if (memo.peersKey !== key) {
    memo.peersKey = key;
    const box = $("peers");
    box.innerHTML = "";
    const all = [
      { initials: (self.name || "?").slice(0, 2), color: self.color, title: `${self.name} (YOU)`, ring: "#dcffc2" },
      ...others.map((q) => ({ initials: q.name.slice(0, 2), color: q.color, title: q.name, ring: "rgba(8,20,10,.9)" })),
    ];
    for (const p of all) {
      const el = document.createElement("span");
      el.className = "sx-peer";
      el.textContent = p.initials;
      el.title = p.title;
      el.style.background = p.color;
      el.style.border = `2px solid ${p.ring}`;
      el.style.boxShadow = `0 0 10px ${p.color}`;
      box.appendChild(el);
    }
    box.title = all.map((p) => p.title).join(", ");
  }
  const n = others.length + 1;
  $("netLabel").textContent = net.state === "live"
    ? `RTDB · LIVE · ${n} HERE`
    : net.state === "joining"
    ? "RTDB · JOINING…"
    : net.state === "connecting"
    ? "RTDB · CONNECTING…"
    : net.state === "denied"
    ? "RTDB · DENIED · LOCAL ONLY"
    : net.state === "error"
    ? "RTDB · SYNC ERROR"
    : "LOCAL ONLY";
}
function renderTools() {
  document.querySelectorAll(".btn.tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === doc.tool));
  $("toolLabel").textContent = doc.tool.toUpperCase();
  $("btnUndo").disabled = !undoStack.length;
  $("btnRedo").disabled = !redoStack.length;
  $("zoomLabel").textContent = `${doc.zoom}×`;
  $("btnGrid").classList.toggle("active", doc.grid);
  $("btnCells").classList.toggle("active", doc.cells);
}
// The 288 swatches are built once per palette revision; selection is a class flip.
let swatchEls = [];
function renderPaletteGrid() {
  if (memo.palKey === palRev) return;
  memo.palKey = palRev;
  const grid = $("paletteGrid");
  grid.innerHTML = "";
  swatchEls = [];
  const src = PALETTE_SOURCES[doc.source];
  let index = 0;
  src.bands.forEach((band, bi) => {
    const label = document.createElement("div");
    label.className = "pal-band" + (bi === 0 ? " first" : "");
    label.textContent = `${band.name} · ROWS ${index / PAL_COLS}–${index / PAL_COLS + band.rows - 1}`;
    grid.appendChild(label);
    for (let r = 0; r < band.rows; r++) {
      for (let c = 0; c < PAL_COLS; c++, index++) {
        const i = index;
        const p = rgb[i];
        const b = document.createElement("button");
        b.className = "pal-swatch";
        b.style.setProperty("--c", rgbHex(p));
        if (i === 0) b.classList.add("transparent");
        if (!band.paintable) b.classList.add("ui");
        if (band.editable) b.classList.add("user");
        b.title = `${i} · row ${i >> 4} col ${i & 15} · ${rgbHex(p)} · RGB555 0x${p.raw.toString(16).padStart(4, "0")}` +
          (band.paintable ? "" : " — editor UI colour, not paintable");
        b.dataset.index = String(i);
        b.addEventListener("click", () => selectColor(i));
        if (band.paintable) {
          b.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            setSecondary(i);
          });
        }
        swatchEls[i] = b;
        grid.appendChild(b);
      }
    }
  });
  memo.selKey = "";
}
function renderPaletteSelection() {
  const key = `${doc.color}|${doc.secondary}`;
  if (memo.selKey === key) return;
  memo.selKey = key;
  swatchEls.forEach((b, i) => {
    b.classList.toggle("selected", i === doc.color);
    b.classList.toggle("secondary", i === doc.secondary && i !== doc.color);
  });
}
function renderColorInfo() {
  const i = doc.color;
  const p = rgb[i];
  if (!p) return;
  const chip = $("colorChip");
  chip.style.setProperty("--c", rgbHex(p));
  chip.classList.toggle("transparent", i === 0);
  $("colorInfo").textContent = `IDX ${i} · ${paletteBand(i).toUpperCase()} ${i >> 4}/${i & 15} · ${rgbHex(p).toUpperCase()} · 0x${p.raw.toString(16).padStart(4, "0")}${i === 0 ? " · TRANSPARENT" : ""}`;
  const editable = paletteBand(i) === "user";
  $("userColorWrap").hidden = !editable;
  if (editable && document.activeElement !== $("userColor")) $("userColor").value = rgbHex(p);
}
function renderHead() {
  const cells = cellCount();
  $("titleName").textContent = doc.name || "UNTITLED SPRITE";
  $("sizeChip").textContent = `${doc.w}×${doc.h} · ${plural(cells, "CELL")} · FRAME ${doc.frame + 1}/${doc.frames.length}`;
  const dirty = doc.dirty ? "UNSAVED" : doc.cloudKey ? `pixelSprites/${doc.cloudKey}` : "—";
  $("dirtyChip").textContent = dirty;
  $("dirtyChipDock").textContent = dirty;
}
function renderFrameStrip() {
  const key = `${doc.rev}|${doc.frame}|${doc.frames.length}|${palRev}`;
  if (memo.stripKey !== key) {
    memo.stripKey = key;
    const strip = $("frameStrip");
    strip.innerHTML = "";
    doc.frames.forEach((fr, i) => {
      const wrap = document.createElement("div");
      wrap.className = "frame-thumb" + (i === doc.frame ? " active" : "");
      const c = document.createElement("canvas");
      c.width = doc.w;
      c.height = doc.h;
      c.getContext("2d").putImageData(new ImageData(E.indexedToRgbaWith(fr, rgb), doc.w, doc.h), 0, 0);
      wrap.appendChild(c);
      const n = document.createElement("span");
      n.textContent = i + 1;
      wrap.appendChild(n);
      wrap.title = `Frame ${i + 1}`;
      wrap.addEventListener("click", () => selectFrame(i));
      strip.appendChild(wrap);
    });
  }
  $("btnFrameDel").disabled = doc.frames.length <= 1;
  $("btnFrameAdd").disabled = doc.frames.length >= MAX_FRAMES;
  $("btnFrameDup").disabled = doc.frames.length >= MAX_FRAMES;
}
function renderRoom() {
  const others = peerList();
  $("roomId").textContent = net.roomId || "——————";
  $("roomState").textContent = net.state === "live" ? `LIVE · ${others.length + 1} HERE` : net.state.toUpperCase();
  const self = net.self || { name: "", color: "#7CFF4F" };
  const dot = $("selfDot");
  dot.style.background = self.color;
  dot.style.boxShadow = `0 0 8px ${self.color}`;
  const nameEl = $("selfName");
  if (document.activeElement !== nameEl && nameEl.value !== self.name) nameEl.value = self.name;
  const key = `${net.peerSig}`;
  if (memo.rosterKey !== key) {
    memo.rosterKey = key;
    const box = $("roster");
    box.innerHTML = "";
    for (const q of others) {
      const row = document.createElement("div");
      row.className = "roster-row";
      const d = document.createElement("span");
      d.className = "dot";
      d.style.background = q.color;
      d.style.boxShadow = `0 0 8px ${q.color}`;
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = q.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = q.meta;
      row.append(d, nm, meta);
      box.appendChild(row);
    }
  }
  $("alone").hidden = others.length > 0;
}
function cloudKeys() {
  return Object.keys(cloud).sort((a, b) => (cloud[b].updatedAt || 0) - (cloud[a].updatedAt || 0));
}
function renderCloudList() {
  const rows = $("cloudRows");
  rows.innerHTML = "";
  for (const key of cloudKeys()) {
    const s = cloud[key];
    const row = document.createElement("div");
    row.className = "cloud-row";
    row.dataset.key = key;
    row.title = `Load pixelSprites/${key} into this room`;
    const img = document.createElement("img");
    img.src = s.png || "";
    img.alt = "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = key;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${s.w}×${s.h}${s.frameCount > 1 ? ` ×${s.frameCount}` : ""}`;
    row.append(img, name, meta);
    row.addEventListener("click", () => loadFromCloud(key));
    rows.appendChild(row);
  }
  renderCloudMeta();
}
function renderCloudMeta() {
  const keys = cloudKeys();
  $("cloudCount").textContent = keys.length ? plural(keys.length, "SPRITE") : "";
  const empty = !net.db && net.state !== "connecting" ? "FIREBASE UNAVAILABLE — LOCAL ONLY" : !cloudLoaded ? "LOADING…" : keys.length ? "" : "NO SPRITES YET — SAVE ONE";
  const emptyEl = $("cloudEmpty");
  emptyEl.textContent = empty;
  emptyEl.hidden = !empty;
  for (const row of $("cloudRows").children) row.classList.toggle("active", row.dataset.key === doc.cloudKey);
  $("btnCloudDelete").disabled = !doc.cloudKey;
}
function renderFooter() {
  $("status").textContent = ui.status;
  $("roomLabel").textContent = net.roomId ? `ROOM ${net.roomId}` : "";
  $("btnShortcuts").classList.toggle("active", ui.shortcuts);
  $("shortcuts").hidden = !ui.shortcuts;
}

// ------------------------------------------------------------- wiring ---
function toggleDrawer(side) {
  const open = side === "left" ? !ui.leftOpen : !ui.rightOpen;
  ui.leftOpen = side === "left" && open;
  ui.rightOpen = side === "right" && open;
  renderLayout();
}
function closeDrawers() {
  ui.leftOpen = ui.rightOpen = false;
  renderLayout();
}
$("btnToolsDrawer").addEventListener("click", () => toggleDrawer("left"));
$("btnSpriteDrawer").addEventListener("click", () => toggleDrawer("right"));
$("btnCloseLeft").addEventListener("click", closeDrawers);
$("btnCloseRight").addEventListener("click", closeDrawers);
$("scrim").addEventListener("click", closeDrawers);
$("shareUrl").addEventListener("focus", (ev) => ev.target.select());
$("btnCopyTop").addEventListener("click", copyLink);
$("btnCopyLink").addEventListener("click", copyLink);
$("btnFork").addEventListener("click", () => newRoom(true));
$("selfName").addEventListener("change", () => {
  net.self.name = $("selfName").value.toUpperCase().slice(0, 12) || net.self.name;
  saveIdentity();
  if (net.me) net.me.child("n").set(net.self.name).catch(() => {});
  memo.peersKey = null;
  refresh();
});
document.querySelectorAll(".btn.tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("btnFlipH").addEventListener("click", () => flip(true));
$("btnFlipV").addEventListener("click", () => flip(false));
$("btnShiftL").addEventListener("click", () => shift(-1, 0));
$("btnShiftR").addEventListener("click", () => shift(1, 0));
$("btnShiftU").addEventListener("click", () => shift(0, -1));
$("btnShiftD").addEventListener("click", () => shift(0, 1));
$("btnUndo").addEventListener("click", undo);
$("btnRedo").addEventListener("click", redo);
$("btnZoomIn").addEventListener("click", () => zoomBy(1));
$("btnZoomOut").addEventListener("click", () => zoomBy(-1));
$("btnGrid").addEventListener("click", () => {
  doc.grid = !doc.grid;
  paintOverlay();
  renderTools();
});
$("btnCells").addEventListener("click", () => {
  doc.cells = !doc.cells;
  paintOverlay();
  renderTools();
});
$("btnClear").addEventListener("click", clearFrame);
$("userColor").addEventListener("input", () => mixColor($("userColor").value));
$("btnFrameAdd").addEventListener("click", () => addFrame(false));
$("btnFrameDup").addEventListener("click", () => addFrame(true));
$("btnFrameDel").addEventListener("click", deleteFrame);
$("animFps").addEventListener("change", () => {
  doc.fps = Math.max(1, Math.min(30, parseInt($("animFps").value, 10) || 6));
  $("animFps").value = doc.fps;
  clearInterval(animTimer);
  animTimer = setInterval(animStep, 1000 / doc.fps);
});
$("spriteName").addEventListener("input", () => {
  doc.name = $("spriteName").value;
  doc.dirty = true;
  syncName();
  renderHead();
});
$("btnNew").addEventListener("click", () => {
  if (doc.dirty && !confirm("Start a new sprite in a fresh room and discard unsaved changes?")) return;
  newSprite(doc.w, doc.h);
});
$("btnCloudSave").addEventListener("click", saveToCloud);
$("btnCloudDelete").addEventListener("click", deleteFromCloud);
$("btnImport").addEventListener("click", () => $("fileImport").click());
$("btnDownload").addEventListener("click", downloadStrip);
$("fileImport").addEventListener("change", (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (f) importImage(f);
  ev.target.value = "";
});
$("btnShortcuts").addEventListener("click", () => {
  ui.shortcuts = !ui.shortcuts;
  renderFooter();
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
    case ",": selectFrame(doc.frame - 1); break;
    case ".": selectFrame(doc.frame + 1); break;
    case "ArrowLeft": ev.preventDefault(); shift(-1, 0); break;
    case "ArrowRight": ev.preventDefault(); shift(1, 0); break;
    case "ArrowUp": ev.preventDefault(); shift(0, -1); break;
    case "ArrowDown": ev.preventDefault(); shift(0, 1); break;
    case "x": case "X": {
      const s = doc.color;
      doc.color = doc.secondary;
      doc.secondary = s;
      renderPaletteSelection();
      renderColorInfo();
      break;
    }
    case "Escape":
      ui.leftOpen = ui.rightOpen = false;
      ui.shortcuts = false;
      renderLayout();
      renderFooter();
      break;
    default:
      return;
  }
});
window.addEventListener("beforeunload", (ev) => {
  if (doc.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});
window.addEventListener("resize", () => {
  refresh();
  if (ui.autoZoom) fitZoom();
});
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (ui.autoZoom) fitNow();
  }).observe(workspace);
}
// Leaving takes the seat with it; a page brought back from the bfcache (a phone
// switching apps and back) takes it again.
window.addEventListener("pagehide", leaveRoom);
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted && net.db && !net.room) joinRoom(net.roomId);
});

// ---------------------------------------------------------------- boot ---
populateSizes();
populatePaletteSelect();
loadPaletteSource("deza2");
net.self = loadIdentity();
const params = new URLSearchParams(location.search);
const sizeParam = params.get("size");
if (sizeParam && /^\d+x\d+$/.test(sizeParam)) {
  const [w, h] = sizeParam.split("x").map(Number);
  if (w % CELL === 0 && h % CELL === 0 && w > 0 && h > 0 && w <= MAX_SIZE && h <= MAX_SIZE) {
    doc.w = w;
    doc.h = h;
    doc.frames = [new Uint8Array(w * h)];
    $("sizeSelect").value = `${w}x${h}`;
  }
}
pendingSprite = params.get("sprite");
setRoomId(roomCode(params.get("room")));
fitZoom();
paint();
initNet();

// Test hook: scripted checks drive the editor without a pointer.
window.__pixelEditor = {
  doc,
  state: doc,
  net,
  getPixel,
  setPixel: (x, y, v) => {
    beginOp();
    put(x, y, v);
    endOp();
    flushNet();
    paint();
  },
  buildRecord,
  applyRecord,
  newSprite,
  resizeSprite,
  selectColor,
  setTool,
  undo,
  redo,
  joinRoom,
  newRoom,
  leaveRoom,
};
