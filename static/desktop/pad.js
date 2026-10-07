// pad.js — a gamepad (and the arrow keys) at the CMG Desktop.
//
// The Desktop is a mouse-and-keyboard workstation, but the launcher's "Switch
// to Desktop" tile is one press away on a pad, and a player who arrives on
// one must be able to do something — above all, get back. This module moves
// a focus ring between the things on the desktop (the icons, the taskbar, the
// focused window's title-bar buttons and the buttons inside it, an open
// menu) by direction, the way a TV UI does, and binds the pad like the
// launcher does:
//
//   D-pad / left stick   move the ring         A (FBTN_BOTTOM)  activate
//   B (FBTN_RIGHT)       close menu / window   X (FBTN_LEFT)    window menu
//   Y (FBTN_TOP)         minimise the window   L / R            cycle windows
//   START                the start menu        SELECT + START   back to the console
//   Home                 back to the console
//
// Button indices follow the standard gamepad layout; the compat plugin
// (gamepad-compatibility-plugin.js, loaded by desktop/index.html ahead of
// this) folds the SNES pad's quirks into it, so an SNES Select/Start and
// D-pad arrive at 8/9 and 12-15 here like everyone else's.
//
// What a frame holds (an app's iframe) is beyond reach — a pad there is the
// app's own business — but the window chrome around it always answers.

const DEADZONE = 0.55;
const REPEAT_DELAY = 420; // ms a direction is held before it repeats
const REPEAT_EVERY = 130;
const FOCUS_CLASS = "pad-focus";

export function installPadNav({ wm, activate, openStartMenu, toConsole }) {
  let raf = 0;
  let padSeen = false;
  const state = {
    btn: new Set(),
    dir: 0, // bitfield-free: the last direction string, or 0
    dirSince: 0,
    lastMoveAt: 0,
    chordFired: false,
  };

  // ---- what can take the ring ---------------------------------------------

  const visible = (el) => {
    if (!el || el.hidden || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return getComputedStyle(el).visibility !== "hidden";
  };

  // A menu on top owns the ring while it is up; otherwise the whole desktop.
  function targets() {
    const pops = [...document.querySelectorAll(".tb-pop, .win-menu-pop")];
    const pop = pops[pops.length - 1];
    if (pop) {
      return [...pop.querySelectorAll("button, .search-row, [tabindex='0']")].filter(visible);
    }
    const out = [];
    out.push(...document.querySelectorAll("#desktop-icons .desk-icon"));
    out.push(...document.querySelectorAll("#taskbar button"));
    const win = wm.focused;
    if (win && !win.minimized) {
      out.push(...win.el.querySelectorAll(".win-btn"));
      out.push(...win.el.querySelectorAll(".win-body button, .win-body [tabindex='0'], .win-body a[href]"));
    }
    return out.filter(visible);
  }

  function current() {
    const el = document.querySelector("." + FOCUS_CLASS);
    return el && visible(el) ? el : null;
  }

  function ring(el) {
    for (const old of document.querySelectorAll("." + FOCUS_CLASS)) {
      if (old !== el) old.classList.remove(FOCUS_CLASS);
    }
    if (!el) return;
    el.classList.add(FOCUS_CLASS);
    try { el.focus({ preventScroll: true }); } catch (_e) { /* not focusable */ }
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_e) { /* ignore */ }
    const win = wm.windows.find((w) => w.el.contains(el));
    if (win && wm.focused !== win) wm.focus(win);
  }

  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  };

  // The nearest target in `dir` from `from`: closest along the axis, with
  // sideways drift counting double so a column stays a column. Off the edge,
  // wrap to the far side.
  function neighbour(from, dir, list) {
    const c = center(from);
    let best = null, bestScore = Infinity;
    let wrap = null, wrapScore = -Infinity;
    for (const el of list) {
      if (el === from) continue;
      const o = center(el);
      const dx = o.x - c.x, dy = o.y - c.y;
      let primary, secondary;
      if (dir === "left") { primary = -dx; secondary = Math.abs(dy); }
      else if (dir === "right") { primary = dx; secondary = Math.abs(dy); }
      else if (dir === "up") { primary = -dy; secondary = Math.abs(dx); }
      else { primary = dy; secondary = Math.abs(dx); }
      // Overlapping rows/columns: an element whose box straddles ours on the
      // cross axis is a better neighbour than one far to the side.
      const overlap = (dir === "left" || dir === "right")
        ? Math.min(c.r.bottom, o.r.bottom) - Math.max(c.r.top, o.r.top)
        : Math.min(c.r.right, o.r.right) - Math.max(c.r.left, o.r.left);
      if (primary > 4) {
        const score = primary + (overlap > 0 ? secondary * 0.5 : secondary * 2 + 200);
        if (score < bestScore) { bestScore = score; best = el; }
      } else {
        // Candidate for wrapping: the one farthest the other way.
        const score = -primary + (overlap > 0 ? 0 : secondary);
        if (score > wrapScore) { wrapScore = score; wrap = el; }
      }
    }
    return best || wrap;
  }

  function move(dir) {
    const list = targets();
    if (!list.length) { ring(null); return; }
    const from = current();
    if (!from || !list.includes(from)) {
      // Nothing ringed yet: the first thing in the list — an icon, or a
      // menu's first entry.
      ring(list[0]);
      return;
    }
    const next = neighbour(from, dir, list);
    if (next) ring(next);
  }

  // ---- actions -------------------------------------------------------------

  function topPopover() {
    const pops = document.querySelectorAll(".tb-pop, .win-menu-pop");
    return pops[pops.length - 1] || null;
  }

  function doActivate() {
    const el = current();
    if (!el) { move("right"); return; }
    if (activate(el)) return;
    el.click();
  }

  function doBack() {
    const pop = topPopover();
    if (pop) { pop.remove(); ring(null); move("right"); return; }
    const el = current();
    const win = (el && wm.windows.find((w) => w.el.contains(el))) || wm.focused;
    if (win) {
      wm.close(win);
      ring(null);
      move("right");
    }
  }

  function doWindowMenu() {
    const win = wm.focused;
    if (!win || win.minimized) return;
    const btn = win.el.querySelector(".win-menu");
    if (btn) btn.click();
    // The menu's first entry takes the ring.
    setTimeout(() => move("right"), 0);
  }

  function doMinimize() {
    const win = wm.focused;
    if (win && !win.minimized) { wm.minimize(win); ring(null); move("right"); }
  }

  function doCycle() {
    wm.cycle();
    const win = wm.focused;
    if (win) {
      const btn = win.el.querySelector(".win-menu");
      if (btn) ring(btn);
    }
  }

  // ---- the pad --------------------------------------------------------------

  function readDir(pad) {
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    if (b(12)) return "up";
    if (b(13)) return "down";
    if (b(14)) return "left";
    if (b(15)) return "right";
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    if (Math.abs(ax) <= 1.05 && Math.abs(ay) <= 1.05) {
      if (ay < -DEADZONE) return "up";
      if (ay > DEADZONE) return "down";
      if (ax < -DEADZONE) return "left";
      if (ax > DEADZONE) return "right";
    }
    return 0;
  }

  function activePad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let fallback = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!fallback) fallback = p;
      if (p.buttons.some((x) => x && x.pressed) || p.axes.some((v) => Math.abs(v) > DEADZONE && Math.abs(v) <= 1.05)) return p;
    }
    return fallback;
  }

  function poll() {
    raf = requestAnimationFrame(poll);
    const pad = activePad();
    if (!pad) { state.btn.clear(); state.dir = 0; return; }
    if (!padSeen) { padSeen = true; document.body.classList.add("pad-connected"); }
    const now = performance.now();

    const pressed = new Set();
    pad.buttons.forEach((b, i) => { if (b && b.pressed) pressed.add(i); });
    const just = (i) => pressed.has(i) && !state.btn.has(i);
    const selHeld = pressed.has(8);
    const startHeld = pressed.has(9);

    // SELECT + START: home. Fires once per chord; neither half does its own
    // thing while the other is down.
    if (selHeld && startHeld) {
      if (!state.chordFired) { state.chordFired = true; toConsole(); }
      state.btn = pressed;
      state.dir = 0;
      return;
    }
    if (!selHeld && !startHeld) state.chordFired = false;

    const dir = selHeld ? 0 : readDir(pad);
    if (dir && dir !== state.dir) {
      move(dir);
      state.dirSince = now;
      state.lastMoveAt = now;
    } else if (dir && now - state.dirSince >= REPEAT_DELAY && now - state.lastMoveAt >= REPEAT_EVERY) {
      move(dir);
      state.lastMoveAt = now;
    }
    state.dir = dir;

    if (!selHeld) {
      if (just(0)) doActivate();
      if (just(1)) doBack();
      if (just(2)) doWindowMenu();
      if (just(3)) doMinimize();
      if (just(4) || just(5)) doCycle();
      if (just(16)) toConsole();
      // START on its own, once released without SELECT: the start menu,
      // with the ring on its first entry.
      if (state.btn.has(9) && !startHeld && !state.chordFired) {
        openStartMenu();
        setTimeout(() => { if (topPopover()) move("right"); }, 0);
      }
    }
    state.btn = pressed;
  }

  // ---- the keyboard ----------------------------------------------------------
  // Arrows walk the same ring when nothing that wants them has focus, so a
  // handheld whose stick types WASD/arrows (the Legion Go's FPS mode) can
  // drive the desktop too. Enter is the button's own.
  globalThis.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
    if (!dir) return;
    // Only once a ring exists, or on a pad-connected desktop — a plain
    // keyboard user scrolling a window keeps the arrows.
    if (!current() && !padSeen) return;
    e.preventDefault();
    move(dir);
  });

  // A mouse or finger takes over: the ring goes, so it never lies about
  // what A would press.
  globalThis.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.pointerType === "touch" || e.pointerType === "pen") {
      const el = current();
      if (el && !el.contains(e.target)) el.classList.remove(FOCUS_CLASS);
    }
  }, true);

  globalThis.addEventListener("gamepadconnected", () => { if (!raf) poll(); });
  // Chrome only lists a pad after a button press, and the event can predate
  // this module — poll regardless, cheaply, until one shows up.
  if (!raf) poll();

  return { move, ring, targets };
}
