// desktop.js — boot module of the CMG Desktop (/desktop/), the "Switch to
// Desktop" counterpart of the console dashboard. Look and feel mirror the
// Phaser Desktop workstation: blue wallpaper, floating top taskbar, purple
// window chrome. This file owns the app registry, desktop icons, taskbar
// (launcher search, running windows, snap-layout picker, clock, Switch to
// Console), the shared local-folder workspace, and layout persistence under
// the launcher's cmg-* localStorage convention.

import { WindowManager } from "./wm.js";
import * as fs from "./fs.js";
import { CodeEditor } from "./editor.js";
import { FilesApp } from "./files-app.js";
import { glyphIcon, tileIcon } from "./icons.js";

const STORE_KEY = "cmg-desktop";
const SPRITEX_URL = "https://easierbycode.com/spriteX/";
const IFRAME_ALLOW = "autoplay; fullscreen; gamepad; xr-spatial-tracking";

const desktopEl = document.getElementById("desktop");
const iconsEl = document.getElementById("desktop-icons");
const trayEl = document.getElementById("tb-tray");
const clockEl = document.getElementById("tb-clock");
const onlineEl = document.getElementById("tb-online");

// ---- persisted state ---------------------------------------------------

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const state = { openApps: [], ...(raw && typeof raw === "object" ? raw : {}) };
    // Anything but an array here would throw in the boot restore loop and
    // leave the desktop half-built; a corrupt blob should just cost the layout.
    if (!Array.isArray(state.openApps)) state.openApps = [];
    return state;
  } catch (_e) {
    return { openApps: [] };
  }
}
const state = loadState();

let saveTimer = 0;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.openApps = wm.windows
      .filter((w) => APPS[w.appId]?.persist)
      .map((w) => ({
        app: w.appId,
        rect: wm.getRect(w),
        snap: w.snap,
        minimized: w.minimized,
        data: w.persistData?.() ?? null,
      }));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (_e) { /* private mode etc. */ }
  }, 400);
}

// ---- window manager ----------------------------------------------------

const wm = new WindowManager(desktopEl, {
  onWindowsChanged: () => {
    renderTray();
    saveStateSoon();
  },
  onFocus: () => renderTray(),
});

// ---- toasts ------------------------------------------------------------

const toastEl = document.getElementById("toast");
let toastTimer = 0;
function notify(text) {
  toastEl.textContent = text;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), 3200);
}

// ---- shared workspace (local folder) -----------------------------------

let workspace = null;
const workspaceListeners = new Set();
function onWorkspaceChange(cb) {
  workspaceListeners.add(cb);
  return () => workspaceListeners.delete(cb);
}
function setWorkspace(handle) {
  workspace = handle;
  for (const cb of workspaceListeners) cb(handle);
}
async function requestWorkspace() {
  if (!fs.supported) {
    notify("This browser has no File System Access API — use Chrome or Edge.");
    return null;
  }
  try {
    const handle = await fs.pickWorkspace();
    setWorkspace(handle);
    notify(`Workspace: ${handle.name}`);
    return handle;
  } catch (e) {
    if (e?.name !== "AbortError") notify(`Could not open folder: ${e.message || e}`);
    return null;
  }
}

// A workspace picked on a previous visit can be restored with one click
// (the permission re-grant must come from a user gesture).
async function offerRestoredWorkspace() {
  if (!fs.supported) return;
  const prev = await fs.restoreWorkspace();
  if (!prev) return;
  if (prev.granted) {
    setWorkspace(prev.handle);
    return;
  }
  const chip = document.getElementById("tb-restore");
  chip.hidden = false;
  chip.textContent = `↻ ${prev.handle.name}`;
  chip.title = `Reconnect the "${prev.handle.name}" workspace from last time`;
  chip.addEventListener("click", async () => {
    if (await fs.requestPermission(prev.handle)) {
      setWorkspace(prev.handle);
      notify(`Workspace restored: ${prev.handle.name}`);
    } else notify("Permission was not granted.");
    chip.hidden = true;
  }, { once: true });
}

// ---- generic window builders ------------------------------------------

function openIframeWindow({ appId, title, icon, url, width, height, sandbox }) {
  const frame = document.createElement("iframe");
  frame.className = "app-frame";
  frame.src = url;
  frame.allow = IFRAME_ALLOW;
  frame.title = title;
  // Trusted first-party tools (spriteX, the level editor…) stay unsandboxed —
  // they need their own origin to reach storage and our APIs. Arbitrary HTML
  // the user previews from disk does not: a blob: frame would otherwise
  // inherit this origin and could read the desktop's own storage.
  if (sandbox) frame.setAttribute("sandbox", sandbox);
  // Those same trusted tools are told they are running on the desktop, so a
  // link they would otherwise send to a browser tab can come back here as a
  // Web Browser instead (see the cmg-open-url listener below). A sandboxed
  // preview has an opaque origin and is never told.
  if (!sandbox && new URL(url, location.href).origin === location.origin) {
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow?.postMessage(
          { type: "cmg-desktop-hello" },
          location.origin,
        );
      } catch (_e) { /* frame navigated away mid-announcement */ }
    });
  }
  const win = wm.create({
    appId,
    title,
    icon: iconNode(icon),
    width: width ?? 960,
    height: height ?? 640,
    content: frame,
    onClose: () => {
      if (frame.src.startsWith("blob:")) URL.revokeObjectURL(frame.src);
    },
  });
  return win;
}

function openImage(name, blob) {
  const url = URL.createObjectURL(blob);
  const wrap = document.createElement("div");
  wrap.className = "image-viewer";
  const img = document.createElement("img");
  img.src = url;
  img.alt = name;
  wrap.appendChild(img);
  wm.create({
    appId: "image",
    title: name,
    icon: iconNode({ lucide: "image", hue: 190 }),
    width: 640,
    height: 520,
    content: wrap,
    onClose: () => URL.revokeObjectURL(url),
  });
}

function openInEditor(fileHandle, path, dirHandle) {
  let win = wm.windows.find((w) => w.appId === "editor");
  if (!win) win = APPS.editor.open();
  wm.focus(win);
  win.editorInstance.openFileEntry(fileHandle, path, dirHandle);
}

const editorEnv = {
  getWorkspace: () => workspace,
  requestWorkspace,
  openIframe: (title, url, lucide) =>
    openIframeWindow({
      appId: "preview",
      title,
      icon: { lucide: lucide ?? "play", hue: 45 },
      url,
      width: 900,
      height: 620,
      sandbox: "allow-scripts allow-forms allow-modals allow-popups",
    }),
  openImage,
  notify,
};

// ---- app registry ------------------------------------------------------
//
// Each app: { title, icon: {glyph|monogram, hue}, open(data) -> win,
// persist, desktopIcon, pinned }. `hue` drives the neon tile gradient.

const APPS = {
  tools: {
    title: "Tools",
    icon: { lucide: "folder", hue: 42 },
    desktopIcon: true,
    pinned: false,
    persist: true,
    open: () => {
      const grid = document.createElement("div");
      grid.className = "folder-window";
      // spriteX deliberately leads — first app of the Tools folder.
      for (
        const id of [
          "spritex",
          "leveleditor",
          "pixelcomposer",
          "bossviewer",
          "modelviewer",
        ]
      ) {
        const app = APPS[id];
        const cell = document.createElement("button");
        cell.className = "folder-cell";
        cell.append(iconNode(app.icon, "lg"));
        const label = document.createElement("span");
        label.textContent = app.title;
        cell.appendChild(label);
        cell.addEventListener("dblclick", () => launch(id));
        cell.addEventListener("keydown", (e) => {
          if (e.key === "Enter") launch(id);
        });
        cell.title = `${app.title} — double-click to open`;
        grid.appendChild(cell);
      }
      return wm.create({
        appId: "tools",
        title: "Tools",
        icon: iconNode({ lucide: "folder", hue: 42 }),
        width: 560,
        height: 380,
        content: grid,
      });
    },
  },

  spritex: {
    title: "spriteX",
    icon: { monogram: "SX", hue: 268 },
    pinned: true,
    persist: true,
    open: () =>
      openIframeWindow({
        appId: "spritex",
        title: "spriteX — Sprite Sheet Workbench",
        icon: { monogram: "SX", hue: 268 },
        url: SPRITEX_URL,
        width: 1100,
        height: 700,
      }),
  },

  leveleditor: {
    title: "Level Editor",
    icon: { monogram: "LE", hue: 130 },
    persist: true,
    open: () =>
      openIframeWindow({
        appId: "leveleditor",
        title: "2028.ai Level Editor",
        icon: { monogram: "LE", hue: 130 },
        url: "/editor/?game=2028-ai",
        width: 1100,
        height: 700,
      }),
  },

  pixelcomposer: {
    title: "Pixel Composer",
    icon: { monogram: "PC", hue: 200 },
    persist: true,
    open: () =>
      openIframeWindow({
        appId: "pixelcomposer",
        title: "Pixel Composer // Voxelizer",
        icon: { monogram: "PC", hue: 200 },
        url: "/pixel-composer/",
        width: 980,
        height: 660,
      }),
  },

  bossviewer: {
    title: "Boss Viewer",
    icon: { monogram: "BV", hue: 20 },
    persist: true,
    open: () =>
      openIframeWindow({
        appId: "bossviewer",
        title: "Boss Viewer",
        icon: { monogram: "BV", hue: 20 },
        url: "/editor/boss-viewer.html",
        width: 980,
        height: 660,
      }),
  },

  modelviewer: {
    title: "Model Viewer",
    icon: { monogram: "MV", hue: 280 },
    persist: true,
    open: () =>
      openIframeWindow({
        appId: "modelviewer",
        title: "Model Viewer",
        icon: { monogram: "MV", hue: 280 },
        url: "/editor/model-viewer.html",
        width: 980,
        height: 660,
      }),
  },

  files: {
    title: "Files",
    icon: { lucide: "hard-drive", hue: 165 },
    desktopIcon: true,
    pinned: true,
    persist: true,
    open: () => {
      const app = new FilesApp({
        getWorkspace: () => workspace,
        requestWorkspace,
        openInEditor,
        openImage,
        notify,
        onWorkspaceChange,
      });
      return wm.create({
        appId: "files",
        title: "Files",
        icon: iconNode({ lucide: "hard-drive", hue: 165 }),
        width: 760,
        height: 520,
        content: app.el,
        onClose: () => app.destroy(),
      });
    },
  },

  editor: {
    title: "Code Editor",
    icon: { lucide: "code-xml", hue: 300 },
    desktopIcon: true,
    pinned: true,
    persist: true,
    open: () => {
      const editor = new CodeEditor(editorEnv);
      const unsub = onWorkspaceChange(() => editor.renderTree());
      const win = wm.create({
        appId: "editor",
        title: "Code Editor",
        icon: iconNode({ lucide: "code-xml", hue: 300 }),
        width: 980,
        height: 640,
        content: editor.el,
        onClose: () => unsub(),
      });
      win.confirmClose = () => editor.confirmClose();
      win.editorInstance = editor;
      return win;
    },
  },

  browser: {
    title: "Web Browser",
    icon: { lucide: "globe", hue: 212 },
    desktopIcon: true,
    pinned: true,
    persist: true,
    open: (data) => openBrowserWindow(data?.url),
  },

  help: {
    title: "Getting Started",
    icon: { lucide: "book-open", hue: 340 },
    desktopIcon: true,
    persist: true,
    open: () => openHelpWindow(),
  },
};

function launch(appId, data) {
  const app = APPS[appId];
  if (!app) return null;
  // Single-instance apps: focus the existing window instead of stacking a twin.
  const existing = wm.windows.find((w) => w.appId === appId);
  if (existing && appId !== "browser") {
    wm.focus(existing);
    return existing;
  }
  return app.open(data);
}

// ---- web (iframe) browser windows -------------------------------------

// YouTube's watch pages refuse to be embedded; its player at /embed/ does
// not. The address bar and ↗ keep the real watch URL — only what the frame
// loads is swapped — so a video handed over by an app (the level editor's
// Dezaemon shelf) actually plays in this window instead of sitting blank.
function youtubeIdOf(url) {
  try {
    const u = new URL(url, location.href);
    const host = u.hostname.replace(/^www\./, "");
    const id = host === "youtu.be"
      ? u.pathname.slice(1).split("/")[0]
      : /^youtube(-nocookie)?\.com$/.test(host)
      ? (u.pathname === "/watch"
        ? u.searchParams.get("v")
        : (u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/) || [])[1])
      : null;
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch (_e) {
    return null;
  }
}

function frameSrcFor(url) {
  const id = youtubeIdOf(url);
  return id
    ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`
    : url;
}

function hostOf(url) {
  try {
    return new URL(url, location.href).host || url;
  } catch (_e) {
    return url;
  }
}

function normalizeUrl(raw) {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("/")) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t)) return `https://${t}`;
  return null;
}

function openBrowserWindow(initialUrl) {
  const wrap = document.createElement("div");
  wrap.className = "browser-app";
  wrap.innerHTML = `
    <div class="bw-bar">
      <button class="bw-btn bw-reload" title="Reload">&#8635;</button>
      <input class="bw-url" type="text" placeholder="https:// — many sites refuse to be embedded; those stay blank" spellcheck="false">
      <button class="bw-btn bw-go" title="Go">&#10132;</button>
      <a class="bw-btn bw-ext" title="Open in a browser tab" target="_blank" rel="noopener">&#8599;</a>
    </div>
    <div class="bw-frame-wrap">
      <div class="bw-placeholder">
        <p>Enter an address to open a site in this window.</p>
        <p class="fa-hint">Sites that send X-Frame-Options / CSP frame-ancestors will refuse to load — use &#8599; for those.</p>
      </div>
    </div>
  `;
  const urlInput = wrap.querySelector(".bw-url");
  const frameWrap = wrap.querySelector(".bw-frame-wrap");
  const placeholder = wrap.querySelector(".bw-placeholder");
  const ext = wrap.querySelector(".bw-ext");
  let frame = null;
  let currentUrl = null;

  const go = (raw) => {
    const url = normalizeUrl(raw ?? urlInput.value);
    if (!url) return notify("That does not look like a URL.");
    currentUrl = url;
    urlInput.value = url;
    ext.href = url;
    // A refused frame is indistinguishable from a loaded one in script (load
    // fires either way, and the document is opaque either way) — but it paints
    // nothing at all. So the note stays in the wrap and the frame is layered
    // over it: a site that loads covers the note, a site that refuses leaves
    // it showing.
    placeholder.innerHTML = `<p><b>${hostOf(url)}</b></p>` +
      `<p class="fa-hint">If this stays blank, the site refuses to be ` +
      `embedded (X-Frame-Options / CSP frame-ancestors) — use &#8599; above ` +
      `to open it in a browser tab.</p>`;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "app-frame";
      // IFRAME_ALLOW already carries autoplay; encrypted-media is what an
      // embedded YouTube player wants on top of it.
      frame.allow = `${IFRAME_ALLOW}; encrypted-media`;
      frame.title = "web browser";
      frameWrap.appendChild(frame);
    }
    frame.src = frameSrcFor(url);
    win.persistUrl = url;
    saveStateSoon();
  };
  wrap.querySelector(".bw-go").addEventListener("click", () => go());
  wrap.querySelector(".bw-reload").addEventListener("click", () => {
    if (frame && currentUrl) frame.src = frameSrcFor(currentUrl);
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });

  const win = wm.create({
    appId: "browser",
    title: "Web Browser",
    icon: iconNode({ lucide: "globe", hue: 212 }),
    width: 980,
    height: 660,
    content: wrap,
  });
  win.persistData = () => ({ url: win.persistUrl ?? null });
  win.browserGo = go;
  if (initialUrl) go(initialUrl);
  else setTimeout(() => urlInput.focus(), 50);
  return win;
}

// ---- links handed over by a hosted app ---------------------------------
//
// A tool running in a window asks the desktop to open a link instead of
// opening it itself — the level editor does this for the satakore.com page and
// the YouTube video of a Dezaemon .sav it recognises — so the page lands in a
// Web Browser window beside the tool rather than as a browser tab. Only
// same-origin frames this desktop hosts may ask, and only for an address
// normalizeUrl() accepts.
//
// An open Web Browser window is reused rather than stacking a new one per
// link, the way following a link in a browser reuses its tab.
function isHostedFrame(source) {
  if (!source) return false;
  for (const w of wm.windows) {
    for (const frame of w.el.querySelectorAll("iframe")) {
      if (frame.contentWindow === source) return true;
    }
  }
  return false;
}

globalThis.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "cmg-open-url" || typeof msg.url !== "string") return;
  if (ev.origin !== location.origin || !isHostedFrame(ev.source)) return;
  const url = normalizeUrl(msg.url);
  if (!url) return;
  const open = wm.windows.find((w) => w.appId === "browser" && w.browserGo);
  if (open) {
    open.browserGo(url);
    wm.focus(open);
  } else launch("browser", { url });
  notify(`Web Browser: ${msg.title || hostOf(url)}`);
});

// ---- help window -------------------------------------------------------

function openHelpWindow() {
  const el = document.createElement("div");
  el.className = "help-app";
  el.innerHTML = `
    <h2>CMG DESKTOP <span>// WORKSTATION</span></h2>
    <p>A desktop mode for codemonkey.games. Open the <b>Tools</b> folder for
    the workbench apps (spriteX, Level Editor, Pixel Composer), browse and
    edit <b>local files</b> with Files + Code Editor, and open any website as
    a draggable window with <b>Web Browser</b>.</p>

    <h3>Window snapping</h3>
    <p>Drag a window against an edge or corner (or use the shortcuts / the
    taskbar layout button). Halves and quarters combine: snap left, then up,
    for the top-left quarter.</p>
    <table>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>&#8592;</kbd> / <kbd>&#8594;</kbd></td><td>Snap to left / right half</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>&#8593;</kbd></td><td>Maximize · then top quarter when snapped</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>&#8595;</kbd></td><td>Restore · bottom quarter · minimize</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Enter</kbd></td><td>Maximize / restore</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Tab</kbd></td><td>Cycle windows</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> / <kbd>Q</kbd></td><td>Minimize / close window</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>Save file (Code Editor)</td></tr>
    </table>
    <p class="fa-hint">Shortcuts act on the focused window. A window whose app
    (iframe) has keyboard focus keeps its keys — click a title bar first.</p>

    <h3>Local files</h3>
    <p>Files and the Code Editor share one workspace folder, opened with the
    browser's File System Access API (Chrome / Edge). Files never leave this
    machine; the permission chip in the taskbar reconnects last visit's
    folder.</p>

    <p><button class="btn-accent" id="help-console">&#8592; Switch to Console</button></p>
  `;
  const win = wm.create({
    appId: "help",
    title: "Getting Started",
    icon: iconNode({ lucide: "book-open", hue: 340 }),
    width: 640,
    height: 560,
    content: el,
  });
  el.querySelector("#help-console").addEventListener("click", () => {
    location.href = "/";
  });
  return win;
}

// ---- icons -------------------------------------------------------------

// icon: { lucide, hue } | { monogram, hue } — both render as an app tile.
function iconNode(icon, size) {
  if (icon.lucide || icon.monogram) return tileIcon(icon, size ?? "");
  return tileIcon({ lucide: "app-window", hue: 260 }, size ?? "");
}

function renderDesktopIcons() {
  iconsEl.textContent = "";
  // Tools first — the folder leads the desktop, spriteX leads the folder.
  const order = ["tools", "files", "editor", "browser", "help"];
  for (const id of order) {
    const app = APPS[id];
    if (!app?.desktopIcon && id !== "tools") continue;
    const btn = document.createElement("button");
    btn.className = "desk-icon";
    btn.append(iconNode(app.icon, "lg"));
    const label = document.createElement("span");
    label.textContent = app.title;
    btn.appendChild(label);
    btn.title = `${app.title} — double-click to open`;
    btn.addEventListener("dblclick", () => launch(id));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") launch(id);
    });
    btn.addEventListener("click", () => {
      for (const b of iconsEl.querySelectorAll(".desk-icon")) {
        b.classList.toggle("sel", b === btn);
      }
    });
    iconsEl.appendChild(btn);
  }
}

// ---- taskbar -----------------------------------------------------------

function renderTray() {
  trayEl.textContent = "";
  const running = new Map();
  for (const w of wm.windows) {
    if (!running.has(w.appId)) running.set(w.appId, []);
    running.get(w.appId).push(w);
  }
  const shown = new Set();
  const addTile = (appId, wins) => {
    const app = APPS[appId];
    const tile = document.createElement("button");
    tile.className = "tray-tile";
    const icon = app ? app.icon : { glyph: "▢", plain: true };
    tile.append(iconNode(icon));
    const title = app?.title ?? wins?.[0]?.title ?? appId;
    tile.title = title;
    if (wins?.length) {
      tile.classList.add("running");
      if (wins.some((w) => w === wm.focused)) tile.classList.add("active");
      tile.addEventListener("click", () => {
        const focusedHere = wins.find((w) => w === wm.focused);
        if (focusedHere && !focusedHere.minimized) wm.minimize(focusedHere);
        else wm.focus(wins[0]);
      });
    } else {
      tile.addEventListener("click", () => launch(appId));
    }
    trayEl.appendChild(tile);
  };
  for (const [appId, app] of Object.entries(APPS)) {
    if (!app.pinned) continue;
    shown.add(appId);
    addTile(appId, running.get(appId));
  }
  for (const [appId, wins] of running) {
    if (shown.has(appId)) continue;
    addTile(appId, wins);
  }
}

// Clock — HH:MM like a taskbar should, Share Tech Mono per house style.
function tickClock() {
  const d = new Date();
  clockEl.textContent = `${String(d.getHours()).padStart(2, "0")}:${
    String(d.getMinutes()).padStart(2, "0")
  }`;
}
setInterval(tickClock, 5000);
tickClock();

function renderOnline() {
  const on = navigator.onLine;
  onlineEl.classList.toggle("off", !on);
  onlineEl.querySelector("span").textContent = on ? "ONLINE" : "OFFLINE";
}
globalThis.addEventListener("online", renderOnline);
globalThis.addEventListener("offline", renderOnline);
renderOnline();

// ---- popovers (search, layouts) ---------------------------------------

function popover(anchor, className, build) {
  const existing = document.querySelector(`.${className}`);
  if (existing) {
    existing.remove();
    return null;
  }
  const pop = document.createElement("div");
  pop.className = `tb-pop ${className}`;
  build(pop);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pw - 8))}px`;
  const dismiss = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
      pop.remove();
      document.removeEventListener("pointerdown", dismiss, true);
    }
  };
  document.addEventListener("pointerdown", dismiss, true);
  return pop;
}

// Start menu off the brand pill — uppercase section headers over app-tile
// grids, the Phaser Desktop start-menu shape scaled to our app count.
const openStartMenu = (e) => {
  popover(e.currentTarget, "start-pop", (pop) => {
    const sections = [
      [
        "Tools",
        ["spritex", "leveleditor", "pixelcomposer", "bossviewer", "modelviewer"],
      ],
      ["System", ["files", "editor", "browser", "tools", "help"]],
    ];
    for (const [name, ids] of sections) {
      const head = document.createElement("div");
      head.className = "start-head";
      head.textContent = name;
      pop.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "start-grid";
      for (const id of ids) {
        const app = APPS[id];
        const cell = document.createElement("button");
        cell.className = "start-cell";
        cell.append(iconNode(app.icon, "lg"));
        const label = document.createElement("span");
        label.textContent = app.title;
        cell.appendChild(label);
        cell.addEventListener("click", () => {
          pop.remove();
          launch(id);
        });
        grid.appendChild(cell);
      }
      pop.appendChild(grid);
    }
  });
};
// The wordmark pill hides on narrow bars, so the brand badge opens the same
// menu — otherwise phones have no way into it.
document.getElementById("tb-start").addEventListener("click", openStartMenu);
document.getElementById("tb-brand").addEventListener("click", openStartMenu);

document.getElementById("tb-search").addEventListener("click", (e) => {
  const pop = popover(e.currentTarget, "search-pop", (pop) => {
    pop.innerHTML = `<input type="text" class="search-input" placeholder="Search apps…" spellcheck="false"><div class="search-list"></div>`;
    const input = pop.querySelector(".search-input");
    const list = pop.querySelector(".search-list");
    const render = (q) => {
      list.textContent = "";
      for (const [id, app] of Object.entries(APPS)) {
        if (q && !app.title.toLowerCase().includes(q.toLowerCase())) continue;
        const row = document.createElement("button");
        row.className = "search-row";
        row.append(iconNode(app.icon));
        const label = document.createElement("span");
        label.textContent = app.title;
        row.appendChild(label);
        row.addEventListener("click", () => {
          pop.remove();
          launch(id);
        });
        list.appendChild(row);
      }
    };
    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") list.querySelector(".search-row")?.click();
      if (ev.key === "Escape") pop.remove();
    });
    render("");
  });
  pop?.querySelector(".search-input")?.focus();
});

document.getElementById("tb-layouts").addEventListener("click", (e) => {
  popover(e.currentTarget, "layout-pop", (pop) => {
    pop.innerHTML = `<div class="layout-hint">Snap focused window</div>`;
    const snapTo = (fn) => {
      pop.remove();
      const win = wm.focused ?? wm.topWindow();
      if (win) fn(win);
      else notify("No window to snap.");
    };
    const zones = [
      ["◧", "Left half", (w) => wm.applySnap(w, { h: "left" })],
      ["◨", "Right half", (w) => wm.applySnap(w, { h: "right" })],
      ["◰", "Top-left", (w) => wm.applySnap(w, { h: "left", v: "top" })],
      ["◳", "Top-right", (w) => wm.applySnap(w, { h: "right", v: "top" })],
      ["◱", "Bottom-left", (w) => wm.applySnap(w, { h: "left", v: "bottom" })],
      ["◲", "Bottom-right", (w) => wm.applySnap(w, { h: "right", v: "bottom" })],
      ["▣", "Maximize", (w) => wm.applySnap(w, { max: true })],
      ["▢", "Center", (w) => wm.centerWindow(w)],
    ];
    const grid = document.createElement("div");
    grid.className = "layout-grid";
    for (const [glyph, label, fn] of zones) {
      const b = document.createElement("button");
      b.className = "layout-zone";
      b.textContent = glyph;
      b.title = label;
      b.addEventListener("click", () => snapTo(fn));
      grid.appendChild(b);
    }
    pop.appendChild(grid);
    const actions = document.createElement("div");
    actions.className = "layout-actions";
    for (const [label, fn] of [["Tile Windows", () => wm.tile()], ["Stack Windows", () => wm.stack()]]) {
      const b = document.createElement("button");
      b.className = "layout-action";
      b.textContent = label;
      b.addEventListener("click", () => {
        pop.remove();
        fn();
      });
      actions.appendChild(b);
    }
    pop.appendChild(actions);
  });
});

document.getElementById("tb-console").addEventListener("click", () => {
  location.href = "/";
});

// ---- boot --------------------------------------------------------------

renderDesktopIcons();
renderTray();
offerRestoredWorkspace();

// Console/debug handle — lets power users (and the test harness) script the
// desktop: cmgDesktop.launch('spritex'), cmgDesktop.setWorkspace(handle), …
globalThis.cmgDesktop = { launch, setWorkspace, wm, apps: APPS };

// Reopen last session's windows; first visit gets the folder + help.
// Saved rects are clamped into the current viewport — a layout saved on a
// bigger monitor (or a mangled localStorage blob) must not strand windows
// off-screen.
let restored = 0;
for (const saved of state.openApps) {
  if (!saved || typeof saved !== "object") continue;
  const app = APPS[saved.app];
  if (!app?.persist) continue;
  const win = launch(saved.app, saved.data ?? undefined);
  if (!win) continue;
  restored++;
  // On a phone the window was already opened full-bleed; a rect saved on a
  // desktop would only shrink it back into a sliver.
  const rect = saved.rect && !wm.isNarrow() ? wm.clampRect(saved.rect) : null;
  if (rect) wm.setRect(win, rect);
  if (saved.snap && (saved.snap.h || saved.snap.v || saved.snap.max)) {
    win.restoreRect = rect;
    wm.applySnap(win, saved.snap);
  }
  if (saved.minimized) wm.minimize(win);
}
if (!restored && !state.visited) {
  state.visited = true;
  launch("help");
  const tools = launch("tools");
  if (tools) {
    const { w } = wm.bounds();
    // Parked to the right of the welcome window — but only where there is a
    // right-hand side to park in.
    if (!wm.isNarrow()) {
      wm.setRect(
        tools,
        wm.clampRect({ x: Math.max(16, w - 600), y: 64, w: 560, h: 380 }),
      );
    }
    wm.focus(tools);
  }
  saveStateSoon();
}
