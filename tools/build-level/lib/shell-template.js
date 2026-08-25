"use strict";

// Renders the offline `phaser-game.html` shell that becomes the exported app's
// entry document. It is a static port of the cmg host page routes/games/
// 2028-ai.tsx: same 256x480 canvas fit + portrait-lock behaviour, but with
// relative script srcs (no launcher, no OSD, no cross-origin bridge) so it runs
// self-contained inside a Cordova (https://localhost) or Electron (app://)
// WebView. The name is deliberately `phaser-game.html` so both the Cordova
// `<content src>` default and electron/main.js's hard-coded loadURL find it.

// Audio-unlock: route every AudioContext through a resume-on-input wrapper so
// BGM starts after the first tap/key (mobile autoplay policy). Verbatim from the
// host page.
const AUDIO_UNLOCK = `
(function () {
  var ctxs = [];
  var OrigAC = window.AudioContext || window.webkitAudioContext;
  if (!OrigAC) return;
  function Patched() { var c = new OrigAC(); ctxs.push(c); return c; }
  Patched.prototype = OrigAC.prototype;
  if (window.AudioContext) window.AudioContext = Patched;
  if (window.webkitAudioContext) window.webkitAudioContext = Patched;
  function resume(ctx) {
    if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) ctx.resume().catch(function () {});
  }
  function unlock() {
    for (var i = 0; i < ctxs.length; i++) resume(ctxs[i]);
    var game = window.__PHASER_4_GAME__;
    if (game && game.sound) {
      var c = game.sound.context || game.sound.audioContext;
      if (c) resume(c);
      try { if (typeof game.sound.unlock === "function") game.sound.unlock(); } catch (e) {}
      if (game.sound.locked) game.sound.locked = false;
    }
  }
  ["pointerdown", "touchstart", "mousedown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });
})();
`;

// Screen-fit + portrait, ported from routes/games/2028-ai.tsx (itself ported
// from 2019-es7/phaser-game.html). CSS-scales the fixed 256x480 canvas to fill
// the viewport preserving aspect, rotates the page -90deg on landscape screens,
// and keeps Phaser's pointer->game coordinate mapping correct under that scale/
// rotation.
const FIT_PORTRAIT = `
(function () {
  var GW = 256, GH = 480;

  function fitCanvas() {
    var pc = document.querySelector("#phaser-canvas canvas");
    if (!pc) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var t = window.getComputedStyle(document.documentElement).transform;
    var cssRotated = t && t !== "none";
    if (cssRotated && vw > vh) { var tmp = vw; vw = vh; vh = tmp; }
    var scale = Math.min(vw / GW, vh / GH);
    pc.style.width = Math.floor(GW * scale) + "px";
    pc.style.height = Math.floor(GH * scale) + "px";
    if (!cssRotated) {
      var g = window.__PHASER_4_GAME__;
      if (g && g.scale && typeof g.scale.refresh === "function") g.scale.refresh();
    }
  }
  window.__fitCanvas = fitCanvas;
  window.addEventListener("resize", fitCanvas);
  window.addEventListener("orientationchange", function () { setTimeout(fitCanvas, 50); });

  function fixPhaserTransform() {
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.scale) return;
    g.scale.transformX = function (pageX) { var cb = this.canvasBounds; return (pageX - cb.x) * (GW / cb.width); };
    g.scale.transformY = function (pageY) { var cb = this.canvasBounds; return (pageY - cb.y) * (GH / cb.height); };
  }
  window.__fixPhaserTransform = fixPhaserTransform;

  function patchCanvasInputForRotation(canvas) {
    var s = window.getComputedStyle(document.documentElement);
    if (!s.transform || s.transform === "none") return;
    var origBCR = HTMLElement.prototype.getBoundingClientRect;
    canvas.getBoundingClientRect = function () {
      var r = origBCR.call(canvas);
      return {
        left: r.top, top: window.innerHeight - r.right,
        right: r.bottom, bottom: window.innerHeight - r.left,
        width: r.height, height: r.width,
        x: r.top, y: window.innerHeight - r.right,
      };
    };
    var vh = window.innerHeight;
    function swap(e) {
      var cx = e.clientX, cy = e.clientY;
      Object.defineProperty(e, "clientX", { value: cy, configurable: true });
      Object.defineProperty(e, "clientY", { value: vh - cx, configurable: true });
      Object.defineProperty(e, "pageX", { value: cy, configurable: true });
      Object.defineProperty(e, "pageY", { value: vh - cx, configurable: true });
    }
    ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove"].forEach(function (ev) {
      canvas.addEventListener(ev, swap, true);
    });
  }

  function lockPortrait() {
    try {
      if (window.screen && window.screen.orientation && window.screen.orientation.lock) {
        window.screen.orientation.lock("portrait").catch(function () {});
      }
    } catch (e) {}
  }
  window.addEventListener("pointerdown", lockPortrait, { once: true });

  (function observe() {
    var container = document.getElementById("phaser-canvas");
    if (!container) return;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          if (muts[i].addedNodes[j].tagName === "CANVAS") {
            fitCanvas();
            patchCanvasInputForRotation(muts[i].addedNodes[j]);
            fixPhaserTransform();
            obs.disconnect();
            return;
          }
        }
      }
    });
    obs.observe(container, { childList: true });
  })();
})();
`;

const STYLE = `
html, body { margin: 0; padding: 0; width: 100%; height: 100%; height: 100dvh; background: #000; overflow: hidden; overscroll-behavior: none; touch-action: none; }
#phaser-canvas { width: 100%; height: 100%; height: 100dvh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
#phaser-canvas canvas { image-rendering: pixelated; image-rendering: crisp-edges; touch-action: none; }
@media screen and (orientation: landscape) {
  html { transform: rotate(-90deg); transform-origin: left top; width: 100vh; height: 100vw; overflow: hidden; position: absolute; top: 100%; left: 0; }
  html body { height: 100%; }
  html #phaser-canvas { height: 100%; }
}
`;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Build the shell. `hasGamepad` includes the controller-compat shim when it was
// staged. The three runtime scripts sit at the end of <body> (in order) so they
// run after #phaser-canvas exists — the fit observer attaches to it, and Phaser
// is defined before game.bundle.js boots.
//
// `godMode` bakes the level editor's GOD MODE toggle into the app: the toggle
// rides the level record as `godMode`, and pre-seeding __GAME_STATE__ before
// the bundle evaluates makes it the default the runtime's ?god= param sync
// keeps (an exported app launches with no query string). The exported-app
// marker itself is unconditional — the runtime hides the TWEET buttons and the
// in-app BUILD APK forge when it sees it, so an export can't re-export itself.
//
// `gameId` is this level's leaderboard identity (see 2019-es7 gameIdentity.js).
// It is baked in rather than read back off foo.json so the app keeps its board
// through any later change to the level record's shape. The Firebase compat SDK
// it needs is loaded DEFERRED: an offline app has to boot at full speed and
// fall back to its local high-score cache, so those scripts must never block
// the bundle. firebaseScores.js waits a bounded time for the namespace.
const FIREBASE_SDK_BASE = "https://www.gstatic.com/firebasejs/10.12.5/";

// Safe to inline in a <script>: the only sequence that could close the element
// early is "</", and JSON has no other markup-significant output.
function jsonLiteral(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderShell(opts) {
  const levelName = htmlEscape(opts.levelName || "2028.Ai");
  const gamepadTag = opts.hasGamepad
    ? '\n    <script src="gamepad-compatibility-plugin.js"></script>'
    : "";
  const flagsTag = "window.__EXPORTED_LEVEL_APP__ = true;" +
    (opts.godMode ? " window.__GAME_STATE__ = { godFlg: true };" : "") +
    (opts.gameId ? " window.__GAME_ID__ = " + jsonLiteral(String(opts.gameId)) + ";" : "");
  // No gameId means no board to reach, so the SDK would only be dead weight.
  const leaderboardTags = opts.gameId
    ? '\n    <script src="firebase-config.js"></script>' +
      '\n    <script defer src="' + FIREBASE_SDK_BASE + 'firebase-app-compat.js"></script>' +
      '\n    <script defer src="' + FIREBASE_SDK_BASE + 'firebase-database-compat.js"></script>'
    : "";
  return `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>${levelName}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="theme-color" content="#000000">
    <!-- Lets an inline scene script resolve a bare \`import Phaser from "phaser"\`
         offline: Phaser ships here as a UMD global, so the specifier maps to a
         shim re-exporting globalThis.Phaser (staged next to this file). Without
         it, exported builds would silently drop scene scripts that work on the
         web. Must precede any module script. -->
    <script type="importmap">{"imports":{"phaser":"./phaser-global.js"}}</script>
    <script>${flagsTag}</script>${leaderboardTags}
    <style>${STYLE}</style>
</head>
<body>
    <!-- Read by the level-loader plugin's custom-BGM path; "./" so it does not
         double the (now document-relative) asset prefix. -->
    <div id="baseUrl" hidden>./</div>
    <div id="phaser-canvas"></div>

    <script>${AUDIO_UNLOCK}</script>
    <script>${FIT_PORTRAIT}</script>${gamepadTag}
    <script src="lib/phaser.min.js"></script>
    <script src="game.bundle.js"></script>
</body>
</html>
`;
}

module.exports = { renderShell };
