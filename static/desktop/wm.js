// wm.js — window manager for the CMG Desktop (/desktop/).
//
// Owns everything about windows as rectangles: create/close, focus and
// z-order, drag, resize, minimize/maximize, edge-drag snapping with a
// preview ghost, and the Ctrl+Alt keyboard snap shortcuts. What goes INSIDE
// a window (apps, iframes, the editor) is desktop.js/editor.js territory —
// the only content-specific thing here is the iframe pointer shield: iframes
// swallow pointermove, so every drag/resize stamps .wm-interacting on the
// root, which CSS uses to turn iframe pointer-events off.
//
// Snapping model: a window carries {h: 'left'|'right'|null, v: 'top'|
// 'bottom'|null, max: bool}. Halves and quarters fall out of combining the
// two axes (Ctrl+Alt+Left then Ctrl+Alt+Up = top-left quarter), which is
// also how the drag zones and the taskbar layout picker express themselves.

const MIN_W = 280;
const MIN_H = 180;
const SNAP_GAP = 10; // breathing room around snapped windows, matches the taskbar float
const EDGE = 24; // px from a desktop edge that arms drag-snap
const MARGIN = 8; // gap a window keeps from the desktop edge when placed
const NARROW = 700; // below this a desktop-sized window cannot fit — fill instead

export class WindowManager {
  /**
   * @param {HTMLElement} desktopEl   the wallpaper area windows live in
   * @param {object} hooks            { onWindowsChanged(list), onFocus(win) }
   */
  constructor(desktopEl, hooks = {}) {
    this.desktop = desktopEl;
    this.hooks = hooks;
    this.windows = [];
    this.zCounter = 10;
    this.idCounter = 0;

    this.ghost = document.createElement("div");
    this.ghost.className = "snap-ghost";
    this.ghost.hidden = true;
    this.desktop.appendChild(this.ghost);

    globalThis.addEventListener("keydown", (e) => this.onKey(e), true);
    // A click that lands inside an iframe never reaches us — but the page
    // loses focus to the frame, which we can hear. Blur → whichever iframe
    // took focus owns the window that should be focused.
    globalThis.addEventListener("blur", () => {
      const ae = document.activeElement;
      if (ae && ae.tagName === "IFRAME") {
        const win = this.windows.find((w) => w.el.contains(ae));
        if (win) this.focus(win);
      }
    });
    this.lastBounds = this.bounds();
    globalThis.addEventListener("resize", () => this.reflow());
  }

  bounds() {
    return { w: this.desktop.clientWidth, h: this.desktop.clientHeight };
  }

  /** Phone-width desktop: app-requested window sizes cannot fit it. */
  isNarrow() {
    return this.bounds().w < NARROW;
  }

  /** The whole desktop minus the edge margin — what a window fills when narrow. */
  fullBleedRect() {
    const { w, h } = this.bounds();
    return {
      x: MARGIN,
      y: MARGIN,
      w: Math.max(MIN_W, w - MARGIN * 2),
      h: Math.max(MIN_H, h - MARGIN * 2),
    };
  }

  /**
   * Force a rect onto the desktop: sane numbers, no bigger than the desktop,
   * no corner outside it. Every placement path funnels through here so a
   * saved/restored/app-supplied rect can never hang off a small screen.
   */
  clampRect(raw = {}) {
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const { w: bw, h: bh } = this.bounds();
    const w = Math.min(
      Math.max(num(raw.w, 720), MIN_W),
      Math.max(MIN_W, bw - MARGIN * 2),
    );
    const h = Math.min(
      Math.max(num(raw.h, 480), MIN_H),
      Math.max(MIN_H, bh - MARGIN * 2),
    );
    const x = Math.min(Math.max(num(raw.x, 60), 0), Math.max(0, bw - w));
    const y = Math.min(Math.max(num(raw.y, 40), 0), Math.max(0, bh - h));
    return { x, y, w, h };
  }

  /**
   * @param {object} opts { title, icon, appId, width, height, x, y,
   *                        content: HTMLElement, titlebarCenter?: HTMLElement,
   *                        onClose?, onFocus? }
   */
  create(opts) {
    const id = `win-${++this.idCounter}`;
    const el = document.createElement("section");
    el.className = "win";
    el.dataset.winId = id;
    // Control cluster mirrors Phaser Desktop: ☰ window menu, minimise,
    // close — no dedicated maximize button (double-click / menu / Ctrl+Alt).
    el.innerHTML = `
      <header class="win-titlebar">
        <div class="win-title">
          <span class="win-icon"></span>
          <span class="win-title-text"></span>
        </div>
        <div class="win-tb-center"></div>
        <div class="win-controls">
          <button class="win-btn win-menu" title="Window menu">&#9776;</button>
          <button class="win-btn win-min" title="Minimise (Ctrl+Alt+M)">&#8212;</button>
          <button class="win-btn win-close" title="Close (Ctrl+Alt+Q)">&#10005;</button>
        </div>
      </header>
      <div class="win-body"></div>
    `;
    for (
      const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]
    ) {
      const h = document.createElement("div");
      h.className = `win-rs win-rs-${dir}`;
      h.dataset.dir = dir;
      el.appendChild(h);
    }

    el.querySelector(".win-icon").append(opts.icon ?? "");
    el.querySelector(".win-title-text").textContent = opts.title ?? "Window";
    if (opts.titlebarCenter) {
      el.querySelector(".win-tb-center").appendChild(opts.titlebarCenter);
    }
    el.querySelector(".win-body").appendChild(opts.content);

    const { w: bw, h: bh } = this.bounds();
    let rect;
    if (this.isNarrow()) {
      // No room to cascade a 960px app window on a phone: every window fills
      // the desktop and the taskbar tray switches between them.
      rect = this.fullBleedRect();
    } else {
      const width = Math.min(opts.width ?? 720, bw - 20);
      const height = Math.min(opts.height ?? 480, bh - 20);
      // Cascade new windows from the top-left like a desktop should.
      const cascade = (this.windows.length % 8) * 28;
      rect = this.clampRect({
        x: opts.x ?? Math.max(8, Math.min(60 + cascade, bw - width - 8)),
        y: opts.y ?? Math.max(8, Math.min(48 + cascade, bh - height - 8)),
        w: width,
        h: height,
      });
    }

    const win = {
      id,
      el,
      appId: opts.appId ?? "",
      title: opts.title ?? "Window",
      icon: opts.icon ?? "",
      snap: { h: null, v: null, max: false },
      restoreRect: null,
      minimized: false,
      onClose: opts.onClose,
    };
    this.setRect(win, rect);
    this.windows.push(win);
    this.desktop.appendChild(el);

    el.addEventListener("pointerdown", () => this.focus(win), true);
    el.querySelector(".win-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(win);
    });
    el.querySelector(".win-min").addEventListener("click", (e) => {
      e.stopPropagation();
      this.minimize(win);
    });
    el.querySelector(".win-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      this.showWindowMenu(win, e.currentTarget);
    });

    const titlebar = el.querySelector(".win-titlebar");
    titlebar.addEventListener("dblclick", (e) => {
      if (e.target.closest(".win-btn") || e.target.closest(".win-tb-center")) {
        return;
      }
      this.toggleMaximize(win);
    });
    this.wireDrag(win, titlebar);
    for (const h of el.querySelectorAll(".win-rs")) this.wireResize(win, h);

    this.focus(win);
    this.changed();
    return win;
  }

  setRect(win, r) {
    win.el.style.left = `${Math.round(r.x)}px`;
    win.el.style.top = `${Math.round(r.y)}px`;
    win.el.style.width = `${Math.round(r.w)}px`;
    win.el.style.height = `${Math.round(r.h)}px`;
  }

  getRect(win) {
    if (win.minimized && win.lastRect) return { ...win.lastRect };
    return {
      x: win.el.offsetLeft,
      y: win.el.offsetTop,
      w: win.el.offsetWidth,
      h: win.el.offsetHeight,
    };
  }

  focus(win) {
    if (win.minimized) this.restoreMin(win);
    if (this.focused === win) return;
    this.focused = win;
    win.el.style.zIndex = ++this.zCounter;
    for (const w of this.windows) {
      w.el.classList.toggle("focused", w === win);
    }
    this.hooks.onFocus?.(win);
    this.changed();
  }

  close(win) {
    const i = this.windows.indexOf(win);
    if (i === -1) return;
    // An app with unsaved work gets to veto (the editor asks the user).
    if (win.confirmClose && !win.confirmClose()) return;
    this.windows.splice(i, 1);
    win.onClose?.(win);
    win.el.remove();
    if (this.focused === win) {
      this.focused = null;
      const top = this.topWindow();
      if (top) this.focus(top);
    }
    this.changed();
  }

  minimize(win) {
    // A hidden element measures 0×0, so remember the rect while it still has
    // one — otherwise persistence saves 0×0 and the window comes back tiny.
    if (!win.minimized) win.lastRect = this.getRect(win);
    win.minimized = true;
    win.el.classList.add("minimized");
    if (this.focused === win) {
      this.focused = null;
      const top = this.topWindow();
      if (top) this.focus(top);
    }
    this.changed();
  }

  restoreMin(win) {
    win.minimized = false;
    win.el.classList.remove("minimized");
    this.changed();
  }

  topWindow() {
    let best = null;
    for (const w of this.windows) {
      if (w.minimized) continue;
      if (!best || +w.el.style.zIndex > +best.el.style.zIndex) best = w;
    }
    return best;
  }

  cycle() {
    const visible = this.windows.filter((w) => !w.minimized);
    if (visible.length < 2) return;
    visible.sort((a, b) => +a.el.style.zIndex - +b.el.style.zIndex);
    this.focus(visible[0]); // bottom-most comes to the top
  }

  // ---- snapping --------------------------------------------------------

  rememberRestore(win) {
    if (!win.snap.h && !win.snap.v && !win.snap.max) {
      win.restoreRect = this.getRect(win);
    }
  }

  snapRect(snap) {
    const { w, h } = this.bounds();
    const g = SNAP_GAP;
    if (snap.max) return { x: g, y: g, w: w - g * 2, h: h - g * 2 };
    const halfW = (w - g * 3) / 2;
    const halfH = (h - g * 3) / 2;
    const x = snap.h === "right" ? g * 2 + halfW : g;
    const y = snap.v === "bottom" ? g * 2 + halfH : g;
    return {
      x,
      y,
      w: snap.h ? halfW : w - g * 2,
      h: snap.v ? halfH : h - g * 2,
    };
  }

  applySnap(win, snap) {
    this.rememberRestore(win);
    win.snap = { h: snap.h ?? null, v: snap.v ?? null, max: !!snap.max };
    win.el.classList.add("snapping");
    this.setRect(win, this.snapRect(win.snap));
    win.el.classList.toggle("maximized", win.snap.max);
    setTimeout(() => win.el.classList.remove("snapping"), 180);
    this.changed();
  }

  unsnap(win, rect) {
    win.snap = { h: null, v: null, max: false };
    win.el.classList.remove("maximized");
    if (rect) this.setRect(win, rect);
    this.changed();
  }

  restore(win) {
    const rect = win.restoreRect ?? this.centeredRect();
    win.el.classList.add("snapping");
    this.unsnap(win, rect);
    setTimeout(() => win.el.classList.remove("snapping"), 180);
  }

  centeredRect() {
    const { w, h } = this.bounds();
    return { x: w * 0.15, y: h * 0.12, w: w * 0.7, h: h * 0.72 };
  }

  toggleMaximize(win) {
    if (win.snap.max) this.restore(win);
    else this.applySnap(win, { max: true });
  }

  // Phaser Desktop's "center" snap: a 76%×74% rect, not a sticky snap state.
  centerWindow(win) {
    this.rememberRestore(win);
    const { w, h } = this.bounds();
    win.el.classList.add("snapping");
    this.unsnap(win, { x: w * 0.12, y: h * 0.13, w: w * 0.76, h: h * 0.74 });
    setTimeout(() => win.el.classList.remove("snapping"), 180);
  }

  // "Tile Windows" — bento the visible windows into a near-square grid.
  tile() {
    const wins = this.windows.filter((w) => !w.minimized);
    if (!wins.length) return;
    const { w, h } = this.bounds();
    const g = SNAP_GAP;
    const cols = Math.ceil(Math.sqrt(wins.length));
    const rows = Math.ceil(wins.length / cols);
    const cw = (w - g * (cols + 1)) / cols;
    const ch = (h - g * (rows + 1)) / rows;
    wins.forEach((win, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      this.rememberRestore(win);
      this.unsnap(win);
      win.el.classList.add("snapping");
      this.setRect(win, {
        x: g + c * (cw + g),
        y: g + r * (ch + g),
        w: cw,
        h: ch,
      });
      setTimeout(() => win.el.classList.remove("snapping"), 180);
    });
    this.changed();
  }

  // "Stack Windows" — cascade from the top-left with a fixed offset.
  stack() {
    const wins = this.windows.filter((w) => !w.minimized);
    const { w, h } = this.bounds();
    wins.forEach((win, i) => {
      const off = 28 * (i % 6);
      this.rememberRestore(win);
      this.unsnap(win);
      win.el.classList.add("snapping");
      this.setRect(win, {
        x: 40 + off,
        y: 24 + off,
        w: Math.min(860, w * 0.62),
        h: Math.min(600, h * 0.72),
      });
      setTimeout(() => win.el.classList.remove("snapping"), 180);
      this.focus(win);
    });
  }

  showWindowMenu(win, anchor) {
    document.querySelector(".win-menu-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "win-menu-pop";
    const items = [
      [win.snap.max ? "Restore" : "Maximise", () => this.toggleMaximize(win), "Ctrl+Alt+↵"],
      ["Minimise", () => this.minimize(win), "Ctrl+Alt+M"],
      ["Snap Left", () => this.applySnap(win, { h: "left" }), "Ctrl+Alt+←"],
      ["Snap Right", () => this.applySnap(win, { h: "right" }), "Ctrl+Alt+→"],
      ["Center", () => this.centerWindow(win), "Ctrl+Alt+C"],
      null,
      ["Close", () => this.close(win), "Ctrl+Alt+Q"],
    ];
    for (const item of items) {
      if (!item) {
        const hr = document.createElement("div");
        hr.className = "win-menu-sep";
        pop.appendChild(hr);
        continue;
      }
      const [label, fn, hint] = item;
      const btn = document.createElement("button");
      btn.className = "win-menu-item" + (label === "Close" ? " danger" : "");
      btn.innerHTML = `<span>${label}</span>${hint ? `<kbd>${hint}</kbd>` : ""}`;
      btn.addEventListener("click", () => {
        pop.remove();
        fn();
      });
      pop.appendChild(btn);
    }
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 210))}px`;
    document.body.appendChild(pop);
    const dismiss = (e) => {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener("pointerdown", dismiss, true);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
  }

  isSnapped(win) {
    return !!(win.snap.h || win.snap.v || win.snap.max);
  }

  /**
   * The desktop changed size (rotation, a phone's collapsing URL bar, a
   * resized browser). Snapped windows re-snap; floating ones get pulled back
   * inside. A window that filled the old bounds keeps filling the new ones —
   * otherwise a phone's URL bar sliding away would shrink it a little on
   * every scroll and never give the height back.
   */
  reflow() {
    const prev = this.lastBounds ?? this.bounds();
    const now = this.bounds();
    this.lastBounds = now;
    if (!now.w || !now.h) return; // desktop is hidden — measurements are junk
    let moved = false;
    for (const win of this.windows) {
      if (this.isSnapped(win)) {
        this.setRect(win, this.snapRect(win.snap));
        moved = true;
        continue;
      }
      if (win.minimized && !win.lastRect) continue;
      const r = this.getRect(win);
      const filled = r.w >= prev.w - MARGIN * 3 && r.h >= prev.h - MARGIN * 3;
      const next = filled ? this.fullBleedRect() : this.clampRect(r);
      if (
        next.x === r.x && next.y === r.y && next.w === r.w && next.h === r.h
      ) continue;
      if (win.minimized) win.lastRect = next;
      this.setRect(win, next);
      moved = true;
    }
    // Resize fires in a stream while a browser window is dragged; only tell
    // the shell (tray re-render, state save) when a rect actually changed.
    if (moved) this.changed();
  }

  // ---- dragging --------------------------------------------------------

  wireDrag(win, titlebar) {
    titlebar.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      if (down.target.closest(".win-btn") || down.target.closest(".win-tb-center")) {
        return;
      }
      down.preventDefault();
      titlebar.setPointerCapture(down.pointerId);
      this.desktop.classList.add("wm-interacting");

      let rect = this.getRect(win);
      // Grab-offset: x as a fraction (so un-maximizing keeps the cursor on
      // the bar proportionally), y as the actual pixel offset (no jump).
      const downRect = this.desktop.getBoundingClientRect();
      const fx = (down.clientX - downRect.left - rect.x) / rect.w;
      let fy = down.clientY - downRect.top - rect.y;
      let started = false;
      let zone = null;

      const move = (ev) => {
        const dRect = this.desktop.getBoundingClientRect();
        const px = ev.clientX - dRect.left;
        const py = ev.clientY - dRect.top;
        if (!started) {
          started = true;
          if (this.isSnapped(win)) {
            // Dragging a snapped/maximized window peels it off at its old size.
            const restored = win.restoreRect ?? this.centeredRect();
            fy = Math.min(fy, 16);
            rect = {
              x: px - restored.w * fx,
              y: py - fy,
              w: restored.w,
              h: restored.h,
            };
            this.unsnap(win, rect);
          }
        }
        rect.x = px - rect.w * fx;
        rect.y = Math.max(0, py - fy);
        this.setRect(win, rect);

        zone = this.zoneAt(px, py);
        this.showGhost(zone);
      };
      // Tear both end-events down together: a `once` pointercancel left
      // registered after a normal pointerup would fire on some *later*
      // gesture and re-apply this drag's stale snap zone.
      const up = () => {
        titlebar.removeEventListener("pointermove", move);
        titlebar.removeEventListener("pointerup", up);
        titlebar.removeEventListener("pointercancel", up);
        this.desktop.classList.remove("wm-interacting");
        this.ghost.hidden = true;
        if (zone) this.applySnap(win, zone);
        else this.changed();
      };
      titlebar.addEventListener("pointermove", move);
      titlebar.addEventListener("pointerup", up);
      titlebar.addEventListener("pointercancel", up);
    });
  }

  zoneAt(px, py) {
    const { w, h } = this.bounds();
    const nearL = px < EDGE, nearR = px > w - EDGE;
    const nearT = py < EDGE, nearB = py > h - EDGE;
    if (nearT && nearL) return { h: "left", v: "top" };
    if (nearT && nearR) return { h: "right", v: "top" };
    if (nearB && nearL) return { h: "left", v: "bottom" };
    if (nearB && nearR) return { h: "right", v: "bottom" };
    if (nearL) return { h: "left" };
    if (nearR) return { h: "right" };
    if (nearT) return { max: true };
    return null;
  }

  showGhost(zone) {
    if (!zone) {
      this.ghost.hidden = true;
      return;
    }
    const r = this.snapRect({ h: zone.h ?? null, v: zone.v ?? null, max: !!zone.max });
    Object.assign(this.ghost.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
    });
    this.ghost.hidden = false;
  }

  // ---- resizing --------------------------------------------------------

  wireResize(win, handle) {
    handle.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      down.stopPropagation();
      this.focus(win);
      handle.setPointerCapture(down.pointerId);
      this.desktop.classList.add("wm-interacting");
      if (this.isSnapped(win)) this.unsnap(win);

      const dir = handle.dataset.dir;
      const start = this.getRect(win);
      const sx = down.clientX, sy = down.clientY;

      const move = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        const r = { ...start };
        if (dir.includes("e")) r.w = Math.max(MIN_W, start.w + dx);
        if (dir.includes("s")) r.h = Math.max(MIN_H, start.h + dy);
        if (dir.includes("w")) {
          r.w = Math.max(MIN_W, start.w - dx);
          r.x = start.x + start.w - r.w;
        }
        if (dir.includes("n")) {
          r.h = Math.max(MIN_H, start.h - dy);
          r.y = start.y + start.h - r.h;
        }
        this.setRect(win, r);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this.desktop.classList.remove("wm-interacting");
        this.changed();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ---- keyboard --------------------------------------------------------

  onKey(e) {
    if (!(e.ctrlKey && e.altKey)) return;
    const win = this.focused;
    const need = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "Tab":
        need();
        this.cycle();
        return;
    }
    if (!win) return;
    switch (e.key) {
      case "ArrowLeft":
        need();
        this.applySnap(win, { h: "left", v: win.snap.max ? null : win.snap.v });
        break;
      case "ArrowRight":
        need();
        this.applySnap(win, { h: "right", v: win.snap.max ? null : win.snap.v });
        break;
      case "ArrowUp":
        need();
        if (win.snap.h) this.applySnap(win, { h: win.snap.h, v: "top" });
        else this.applySnap(win, { max: true });
        break;
      case "ArrowDown":
        need();
        if (win.snap.max) this.restore(win);
        else if (win.snap.v === "top") {
          this.applySnap(win, { h: win.snap.h, v: null });
        } else if (win.snap.h) {
          this.applySnap(win, { h: win.snap.h, v: "bottom" });
        } else if (this.isSnapped(win)) this.restore(win);
        else this.minimize(win);
        break;
      case "Enter":
        need();
        this.toggleMaximize(win);
        break;
      case "c":
      case "C":
        need();
        this.centerWindow(win);
        break;
      case "m":
      case "M":
        need();
        this.minimize(win);
        break;
      case "q":
      case "Q":
        need();
        this.close(win);
        break;
    }
  }

  changed() {
    this.hooks.onWindowsChanged?.(this.windows.slice());
  }
}
