// The receiving end of the touch controller, inside a game document.
//
// The controller (static/virtual-pad/index.html) runs on another screen and
// sends its state as { t: "pad", l, a: [lx, ly, rx, ry], b: bitmask }. This
// makes that state a gamepad the game can read, with no change to the game:
// navigator.getGamepads() gains one standard-mapping pad, and a
// gamepadconnected event announces it the way a real pad's first press does.
//
// Two ways in:
//   * window.__cmgVirtualPadPush(msg) — the Android bridge
//     (cordova-plugin-second-screen) calls this from native code with every
//     message, injecting this file first if the page does not have it yet.
//   * the "cmg-virtual-pad" BroadcastChannel — a controller page in another
//     window of the same browser, for any game page that includes this file.
//
// The pad drops (gamepaddisconnected) when nothing has arrived for 4 s: the
// controller resends its state every 250 ms, so silence means it is gone.
//
// Real pads keep their places. The touch pad takes index 0 when that slot is
// free (the controller is player 1's in the usual case: no pad in hand), and
// the first free slot after the real ones otherwise.
//
// A plain script (no modules): native code evaluates it as a string.
(function () {
  "use strict";
  if (typeof window === "undefined" || window.__cmgVirtualPadPush) return;

  var BUTTONS = 17;
  var STALE_MS = 4000;
  var nav = window.navigator;
  var orig = typeof nav.getGamepads === "function"
    ? nav.getGamepads.bind(nav)
    : function () { return []; };

  var state = { axes: [0, 0, 0, 0], bits: 0, layout: "classic" };
  var connected = false;
  var index = 0;
  var lastAt = 0;

  function idFor(layout) {
    return layout === "twin"
      ? "CMG Touch Twin-Stick (STANDARD GAMEPAD)"
      : "CMG Touch Pad (STANDARD GAMEPAD)";
  }

  function snapshot() {
    var buttons = [];
    for (var i = 0; i < BUTTONS; i++) {
      var on = (state.bits & (1 << i)) !== 0;
      buttons.push({ pressed: on, touched: on, value: on ? 1 : 0 });
    }
    return {
      id: idFor(state.layout),
      index: index,
      connected: true,
      mapping: "standard",
      timestamp: (window.performance && performance.now()) || Date.now(),
      axes: state.axes.slice(0, 4),
      buttons: buttons,
      vibrationActuator: null,
      hapticActuators: [],
    };
  }

  function realPads() {
    var list = [];
    try { list = Array.prototype.slice.call(orig() || []); } catch (_) { list = []; }
    return list;
  }

  function freeIndex() {
    var real = realPads();
    for (var i = 0; i < real.length; i++) if (!real[i]) return i;
    return real.length;
  }

  nav.getGamepads = function () {
    var real = realPads();
    if (!connected) return real;
    var out = real.slice();
    while (out.length <= index) out.push(null);
    // A real pad that took the slot since the touch pad connected keeps it;
    // the touch pad moves to the end rather than hiding it.
    if (out[index]) {
      out.push(null);
      index = out.length - 1;
    }
    out[index] = snapshot();
    return out;
  };

  function announce(type) {
    var ev;
    try { ev = new Event(type); } catch (_) {
      ev = document.createEvent("Event");
      ev.initEvent(type, false, false);
    }
    try { Object.defineProperty(ev, "gamepad", { value: snapshot() }); } catch (_) { /* read-only */ }
    window.dispatchEvent(ev);
  }

  function clamp(v) {
    v = Number(v);
    return isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }

  window.__cmgVirtualPadPush = function (msg) {
    if (typeof msg === "string") {
      try { msg = JSON.parse(msg); } catch (_) { return; }
    }
    if (!msg || msg.t !== "pad") return;
    var a = Array.isArray(msg.a) ? msg.a : [];
    state.axes = [clamp(a[0]), clamp(a[1]), clamp(a[2]), clamp(a[3])];
    state.bits = (msg.b >>> 0) & ((1 << BUTTONS) - 1);
    state.layout = msg.l === "twin" ? "twin" : "classic";
    lastAt = Date.now();
    if (!connected) {
      index = freeIndex();
      connected = true;
      announce("gamepadconnected");
    }
  };

  setInterval(function () {
    if (connected && Date.now() - lastAt > STALE_MS) {
      announce("gamepaddisconnected");
      connected = false;
      state.axes = [0, 0, 0, 0];
      state.bits = 0;
    }
  }, 1000);

  try {
    var channel = new BroadcastChannel("cmg-virtual-pad");
    channel.onmessage = function (e) { window.__cmgVirtualPadPush(e.data); };
  } catch (_) { /* no BroadcastChannel — the native bridge is the only way in */ }
})();
