// The touch controller: one on-screen gamepad, two places it is shown.
//
//   * OVER the game — the launcher lays it on top of the game frame when the
//     machine has a touchscreen and no pad (a Legion Go with its controller
//     off, a tablet), and feeds what it reads into the frame as a standard
//     Gamepad (svelte-src/Dashboard.svelte, "Touch Controller").
//   * As a whole SCREEN — static/virtual-pad/index.html, the controller page,
//     shown on the device's own panel while the game plays on a monitor: the
//     Legion's built-in screen under the desktop launcher (lib/display-layout.ts
//     turns it back on), or the phone under a per-game Android build whose game
//     has gone to the external display (cordova-plugin-second-screen).
//
// Two layouts, chosen by the game:
//   twin     — two floating sticks, one per half of the screen (move / aim),
//              the way Sh'M↑ Party's own touch controls work; a strip of small
//              buttons (L1, SELECT, A, B, START, R1) along the top.
//   classic  — a floating stick on the left that also writes the D-pad, ABXY
//              on the right, shoulders in the top corners, SELECT and START
//              between them.
//
// What it reports is the standard mapping's own shape — axes [lx, ly, rx, ry]
// and a bitmask over the 17 standard buttons — so a receiver can hand it to a
// game as navigator.getGamepads() would. encodePadState/decodePadState are the
// wire form the controller page sends across windows (BroadcastChannel) and
// across the Android bridge.
//
// Environment-neutral ESM with no imports: esbuild bundles it into the
// dashboard, and the controller page loads it as a module off the same origin.

export const PAD_BUTTON_COUNT = 17;
export const PAD_LAYOUTS = ["twin", "classic"];
/** The BroadcastChannel a controller page and a game window share. */
export const PAD_CHANNEL = "cmg-virtual-pad";

// Standard-mapping button indices.
const A = 0, B = 1, X = 2, Y = 3, L1 = 4, R1 = 5, L2 = 6, R2 = 7;
const SELECT = 8, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

/** Past this deflection a classic stick also holds that D-pad direction. */
const DPAD_THRESHOLD = 0.5;
/** Below this fraction of the radius a stick reads as centred. */
const DEAD_FRACTION = 0.18;

/** The id a receiver gives the pad. Sh'M↑ Party reads /touch twin-?stick/ as touch. */
export function padIdFor(layout) {
  return layout === "twin"
    ? "CMG Touch Twin-Stick (STANDARD GAMEPAD)"
    : "CMG Touch Pad (STANDARD GAMEPAD)";
}

export function normalizeLayout(layout) {
  return PAD_LAYOUTS.includes(layout) ? layout : "classic";
}

export function emptyPadState() {
  return { axes: [0, 0, 0, 0], bits: 0 };
}

function clampAxis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

/** A state as the small JSON object the controller page sends. */
export function encodePadState(state, layout) {
  return {
    t: "pad",
    l: normalizeLayout(layout),
    a: (state.axes || []).slice(0, 4).map((v) => Math.round(clampAxis(v) * 1000) / 1000),
    b: (state.bits >>> 0) & ((1 << PAD_BUTTON_COUNT) - 1),
  };
}

/** The inverse of encodePadState; null for anything that is not one. */
export function decodePadState(msg) {
  if (!msg || typeof msg !== "object" || msg.t !== "pad") return null;
  const axes = [0, 0, 0, 0];
  if (Array.isArray(msg.a)) {
    for (let i = 0; i < 4; i++) axes[i] = clampAxis(msg.a[i]);
  }
  const bits = Number.isInteger(msg.b)
    ? (msg.b >>> 0) & ((1 << PAD_BUTTON_COUNT) - 1)
    : 0;
  return { layout: normalizeLayout(msg.l), axes, bits };
}

/** True when anything is held or deflected. */
export function padStateActive(state) {
  if (!state) return false;
  if (state.bits) return true;
  for (const v of state.axes || []) if (Math.abs(v) > 0.05) return true;
  return false;
}

/**
 * A state as a Gamepad-shaped object, the way a game reads one: standard
 * mapping, 17 buttons, 4 axes. Built fresh per read like the real API's
 * snapshots, so a game that keeps the last one around sees it go stale rather
 * than change under it.
 */
export function gamepadFromState(state, opts = {}) {
  const bits = state ? state.bits >>> 0 : 0;
  const buttons = [];
  for (let i = 0; i < PAD_BUTTON_COUNT; i++) {
    const pressed = (bits & (1 << i)) !== 0;
    buttons.push({ pressed, touched: pressed, value: pressed ? 1 : 0 });
  }
  const axes = state ? state.axes.slice(0, 4).map(clampAxis) : [0, 0, 0, 0];
  return {
    id: opts.id || padIdFor(opts.layout),
    index: opts.index ?? 0,
    connected: true,
    mapping: "standard",
    timestamp: opts.timestamp ?? (typeof performance !== "undefined" ? performance.now() : Date.now()),
    axes,
    buttons,
    vibrationActuator: null,
    hapticActuators: [],
  };
}

// ── the on-screen controller ────────────────────────────────────────────────

const STYLE_ID = "cmg-vpad-style";
const STYLE = `
.cmg-vpad { position: absolute; inset: 0; touch-action: none; user-select: none;
  -webkit-user-select: none; -webkit-touch-callout: none; overflow: hidden;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #e9ffe0;
  --vpad-accent: 124, 255, 79; }
.cmg-vpad.full { background: radial-gradient(ellipse at 50% 120%, #10241a 0%, #050807 65%); }
.cmg-vpad.overlay { pointer-events: none; }
.cmg-vpad.overlay .cmg-vpad-zone, .cmg-vpad.overlay .cmg-vpad-btn { pointer-events: auto; }
.cmg-vpad-zone { position: absolute; top: 0; bottom: 0; touch-action: none; }
.cmg-vpad-zone.left { left: 0; width: 50%; }
.cmg-vpad-zone.right { right: 0; width: 50%; }
.cmg-vpad.full .cmg-vpad-zone.left { border-right: 1px solid rgba(var(--vpad-accent), .08); }
.cmg-vpad-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-size: 13px; letter-spacing: .3em; opacity: .28; pointer-events: none; text-transform: uppercase; }
.cmg-vpad.overlay .cmg-vpad-hint { display: none; }
.cmg-vpad-base, .cmg-vpad-knob { position: absolute; border-radius: 50%; pointer-events: none;
  transform: translate(-50%, -50%); display: none; }
.cmg-vpad-base { background: rgba(var(--vpad-accent), .10); border: 2px solid rgba(var(--vpad-accent), .35); }
.cmg-vpad-knob { background: rgba(var(--vpad-accent), .38); border: 2px solid rgba(var(--vpad-accent), .85); }
.cmg-vpad-btn { position: absolute; display: flex; align-items: center; justify-content: center;
  border-radius: 999px; border: 2px solid rgba(var(--vpad-accent), .55); background: rgba(10, 20, 14, .55);
  color: inherit; font: 700 14px/1 system-ui, sans-serif; letter-spacing: .06em; padding: 0;
  touch-action: none; -webkit-tap-highlight-color: transparent; outline: none; }
.cmg-vpad.overlay .cmg-vpad-btn { opacity: .5; }
.cmg-vpad-btn.on { background: rgba(var(--vpad-accent), .55); color: #031; opacity: 1; }
.cmg-vpad-btn.face { width: var(--face); height: var(--face); font-size: calc(var(--face) * .36); }
.cmg-vpad-btn.small { height: 34px; min-width: 64px; padding: 0 12px; font-size: 12px; }
.cmg-vpad.overlay .cmg-vpad-btn.small { height: 28px; min-width: 52px; font-size: 11px; }
.cmg-vpad-bar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex;
  gap: 8px; pointer-events: none; }
.cmg-vpad-bar .cmg-vpad-btn { position: static; pointer-events: auto; }
.cmg-vpad.overlay .cmg-vpad-bar { top: 6px; }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  (doc.head || doc.documentElement).appendChild(el);
}

/**
 * Mount a controller into `root` (positioned; the controller fills it).
 *
 * opts:
 *   layout       'twin' | 'classic'
 *   overlay      true over a game (transparent, faint, only the controls take
 *                touches); false for a whole controller screen
 *   acceptMouse  let a mouse drive it too. Off over a game: a Legion Go in FPS
 *                mode turns its right half into a mouse, and that mouse must
 *                not grab a stick the player never touched.
 *   onChange(state)  every change, with a copy of { axes, bits }
 *
 * Returns { state(), setLayout(layout), release(), destroy() }.
 */
export function mountVirtualPad(root, opts = {}) {
  const doc = root.ownerDocument || document;
  ensureStyle(doc);
  let layout = normalizeLayout(opts.layout);
  const overlay = !!opts.overlay;
  const acceptMouse = opts.acceptMouse ?? !overlay;
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  const state = emptyPadState();
  let host = null;
  const sticks = [];
  const listeners = [];

  function on(el, type, fn) {
    el.addEventListener(type, fn, { passive: false });
    listeners.push(() => el.removeEventListener(type, fn));
  }
  function accepts(e) {
    return acceptMouse || e.pointerType === "touch" || e.pointerType === "pen";
  }
  function emit() {
    onChange({ axes: state.axes.slice(), bits: state.bits });
  }
  function setBit(i, down) {
    const before = state.bits;
    state.bits = down ? (state.bits | (1 << i)) : (state.bits & ~(1 << i));
    return before !== state.bits;
  }
  function buzz() {
    try { navigator.vibrate?.(8); } catch (_) { /* no vibration here */ }
  }

  function radius() {
    const r = root.getBoundingClientRect();
    const short = Math.min(r.width, r.height) || 360;
    return overlay ? Math.max(48, Math.min(72, short * 0.12)) : Math.max(56, Math.min(120, short * 0.2));
  }

  function makeStick(zone, axisX, axisY, dpad) {
    const base = doc.createElement("span");
    base.className = "cmg-vpad-base";
    const knob = doc.createElement("span");
    knob.className = "cmg-vpad-knob";
    zone.append(base, knob);
    const st = { zone, base, knob, axisX, axisY, dpad, id: null, ox: 0, oy: 0 };

    function place(x, y) {
      const rect = zone.getBoundingClientRect();
      const R = radius();
      let dx = x - st.ox, dy = y - st.oy;
      const d = Math.hypot(dx, dy);
      const k = d > R ? R / d : 1;
      const lx = st.ox - rect.left, ly = st.oy - rect.top;
      knob.style.left = lx + dx * k + "px";
      knob.style.top = ly + dy * k + "px";
      let vx = 0, vy = 0;
      if (d >= R * DEAD_FRACTION) {
        const mag = Math.min(1, (d - R * DEAD_FRACTION) / (R * (1 - DEAD_FRACTION)));
        vx = (dx / d) * mag;
        vy = (dy / d) * mag;
      }
      let changed = state.axes[axisX] !== vx || state.axes[axisY] !== vy;
      state.axes[axisX] = vx;
      state.axes[axisY] = vy;
      if (dpad) {
        changed = setBit(UP, vy < -DPAD_THRESHOLD) || changed;
        changed = setBit(DOWN, vy > DPAD_THRESHOLD) || changed;
        changed = setBit(LEFT, vx < -DPAD_THRESHOLD) || changed;
        changed = setBit(RIGHT, vx > DPAD_THRESHOLD) || changed;
      }
      if (changed) emit();
    }
    function release() {
      st.id = null;
      base.style.display = "none";
      knob.style.display = "none";
      const had = state.axes[axisX] !== 0 || state.axes[axisY] !== 0 ||
        (dpad && (state.bits & ((1 << UP) | (1 << DOWN) | (1 << LEFT) | (1 << RIGHT))));
      state.axes[axisX] = 0;
      state.axes[axisY] = 0;
      if (dpad) for (const b of [UP, DOWN, LEFT, RIGHT]) setBit(b, false);
      if (had) emit();
    }
    st.release = release;

    on(zone, "pointerdown", (e) => {
      if (!accepts(e) || st.id !== null) return;
      e.preventDefault();
      st.id = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety */ }
      const rect = zone.getBoundingClientRect();
      const R = radius();
      // Keep the whole ring on screen so the knob can travel every way.
      st.ox = Math.max(rect.left + R, Math.min(rect.right - R, e.clientX));
      st.oy = Math.max(rect.top + R, Math.min(rect.bottom - R, e.clientY));
      for (const el of [base, knob]) el.style.display = "block";
      base.style.width = base.style.height = R * 2 + "px";
      knob.style.width = knob.style.height = Math.round(R * 0.9) + "px";
      base.style.left = st.ox - rect.left + "px";
      base.style.top = st.oy - rect.top + "px";
      place(e.clientX, e.clientY);
    });
    on(zone, "pointermove", (e) => {
      if (e.pointerId !== st.id) return;
      e.preventDefault();
      place(e.clientX, e.clientY);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      on(zone, type, (e) => {
        if (e.pointerId === st.id) release();
      });
    }
    sticks.push(st);
    return st;
  }

  function makeButton(parent, index, label, cls, style) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "cmg-vpad-btn " + cls;
    b.textContent = label;
    b.tabIndex = -1;
    b.setAttribute("aria-label", label);
    if (style) Object.assign(b.style, style);
    parent.appendChild(b);
    let held = null;
    const up = (e) => {
      if (held === null || (e && e.pointerId !== held)) return;
      held = null;
      b.classList.remove("on");
      if (setBit(index, false)) emit();
    };
    on(b, "pointerdown", (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      held = e.pointerId;
      try { b.setPointerCapture(e.pointerId); } catch (_) { /* fine without */ }
      b.classList.add("on");
      buzz();
      if (setBit(index, true)) emit();
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) on(b, type, up);
    on(b, "contextmenu", (e) => e.preventDefault());
    return b;
  }

  function build() {
    for (const off of listeners.splice(0)) off();
    host?.remove();
    sticks.length = 0;
    state.axes = [0, 0, 0, 0];
    state.bits = 0;
    host = doc.createElement("div");
    host.className = "cmg-vpad " + layout + (overlay ? " overlay" : " full");
    root.appendChild(host);

    const left = doc.createElement("div");
    left.className = "cmg-vpad-zone left";
    host.appendChild(left);
    const bar = doc.createElement("div");
    bar.className = "cmg-vpad-bar";

    if (layout === "twin") {
      const right = doc.createElement("div");
      right.className = "cmg-vpad-zone right";
      host.appendChild(right);
      if (!overlay) {
        left.insertAdjacentHTML("beforeend", '<span class="cmg-vpad-hint">move</span>');
        right.insertAdjacentHTML("beforeend", '<span class="cmg-vpad-hint">aim</span>');
      }
      makeStick(left, 0, 1, false);
      makeStick(right, 2, 3, false);
      host.appendChild(bar);
      makeButton(bar, L1, "L1", "small");
      makeButton(bar, SELECT, "SELECT", "small");
      makeButton(bar, A, "A", "small");
      makeButton(bar, B, "B", "small");
      makeButton(bar, START, "START", "small");
      makeButton(bar, R1, "R1", "small");
    } else {
      if (!overlay) left.insertAdjacentHTML("beforeend", '<span class="cmg-vpad-hint">move</span>');
      makeStick(left, 0, 1, true);
      host.appendChild(bar);
      makeButton(bar, SELECT, "SELECT", "small");
      makeButton(bar, START, "START", "small");
      // Over a game the shoulders sit below the top corners: the launcher's
      // Guide gesture owns those (a two-finger corner tap, Dashboard.svelte).
      const side = overlay ? 6 : 10;
      const top = overlay ? 112 : 10;
      makeButton(host, L2, "L2", "small", { left: side + "px", top: top + "px" });
      makeButton(host, L1, "L1", "small", { left: side + "px", top: top + 42 + "px" });
      makeButton(host, R2, "R2", "small", { right: side + "px", top: top + "px" });
      makeButton(host, R1, "R1", "small", { right: side + "px", top: top + 42 + "px" });
      // ABXY as a diamond in the bottom-right, sized off the screen.
      const r = root.getBoundingClientRect();
      const short = Math.min(r.width, r.height) || 360;
      const face = Math.round(overlay ? Math.max(44, Math.min(64, short * 0.11)) : Math.max(56, Math.min(96, short * 0.17)));
      host.style.setProperty("--face", face + "px");
      const gap = Math.round(face * 0.12);
      const cx = Math.round(face * 1.5 + gap + (overlay ? 16 : 28)); // from the right edge
      const cy = Math.round(face * 1.5 + gap + (overlay ? 16 : 28)); // from the bottom edge
      const half = face / 2;
      const off = face / 2 + gap + half;
      const pos = (dx, dy) => ({ right: cx - half + dx + "px", bottom: cy - half + dy + "px" });
      makeButton(host, Y, "Y", "face", pos(0, off));
      makeButton(host, A, "A", "face", pos(0, -off));
      makeButton(host, X, "X", "face", pos(off, 0));
      makeButton(host, B, "B", "face", pos(-off, 0));
    }
    emit();
  }

  function release() {
    for (const st of sticks) st.release();
    for (const b of host ? host.querySelectorAll(".cmg-vpad-btn") : []) b.classList.remove("on");
    if (state.bits) {
      state.bits = 0;
      emit();
    }
  }

  // A controller that loses the page (tab hidden, window blurred, screen off)
  // must not leave a direction held in the game.
  const onHide = () => release();
  doc.addEventListener("visibilitychange", onHide);
  (doc.defaultView || window).addEventListener("blur", onHide);
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (layout === "classic") build(); }, 150);
  };
  (doc.defaultView || window).addEventListener("resize", onResize);

  build();

  return {
    state: () => ({ axes: state.axes.slice(), bits: state.bits }),
    layout: () => layout,
    setLayout(next) {
      next = normalizeLayout(next);
      if (next === layout) return;
      layout = next;
      build();
    },
    release,
    destroy() {
      release();
      for (const off of listeners.splice(0)) off();
      doc.removeEventListener("visibilitychange", onHide);
      (doc.defaultView || window).removeEventListener("blur", onHide);
      (doc.defaultView || window).removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      host?.remove();
      host = null;
    },
  };
}
