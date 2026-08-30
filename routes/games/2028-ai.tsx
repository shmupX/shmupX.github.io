import { Head } from "fresh/runtime";
import { define } from "../../utils.ts";

// "2028.Ai" — a self-contained build of the 2019-es7 Phaser shooter, hosted
// inside cmg. The game scenes are shipped as one esbuild bundle
// (/games/2028-ai/game.bundle.js, built by scripts/build-2028-ai.ts). The
// level is fetched from foo.json and resolved at runtime by the level-loader
// ScenePlugin; Phaser and all assets/audio are served locally.
//
// Screen-fit + portrait lock mirror 2019-es7/phaser-game.html: the 256x480
// canvas is CSS-scaled to fill the viewport (preserving aspect), and a
// landscape viewport is rotated -90deg so the game is always presented
// portrait. The input-mapping patches keep Phaser's pointer→game coordinate
// transforms correct under that CSS scale/rotation.

// Maps the bare "phaser" specifier onto the shim that re-exports the UMD
// global this page loads, so scene scripts share the game's single Phaser.
const PHASER_IMPORT_MAP = JSON.stringify({
  imports: { "phaser": "/phaser-plugins/phaser-global.js" },
});

// Scene scripts importing the characters library by its documentation URL
// (easierbycode.com/2019-es7/characters) are rewritten to this module. On
// cmg-served pages that is our own /characters route, whose named exports are
// generated from the database per request — a character created moments ago
// imports by name with no rebuild. Standalone/offline exports of this game
// lack the route (and this global), so scene-script.js falls back to the
// static GitHub Pages build.
const CHARACTERS_MODULE = `
globalThis.__CHARACTERS_MODULE__ = location.origin + "/characters";
`;

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

// Launcher OSD bridge. Once this game has keyboard focus the parent launcher
// stops receiving keydowns, so its own ` / ~ / Esc handler never fires. When
// embedded in cmg — which can be cross-origin in packaged/online builds, where
// the launcher can't inject a forwarder itself — forward those keys up so it
// can toggle the in-game Guide/OSD. Capture phase + stopImmediatePropagation so
// the game doesn't also act on them. No-op when the page is opened standalone.
const OSD_BRIDGE = `
(function () {
  if (window.parent === window) return; // standalone — leave keys to the game
  window.addEventListener("keydown", function (e) {
    if (e.code === "Backquote" || e.key === "\`" || e.key === "~" ||
        e.keyCode === 192 || e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      try { window.parent.postMessage({ type: "tg16-toggle-controls" }, "*"); } catch (_) {}
    }
  }, true);
})();
`;

// Level-editor capability broadcast. This game ships the ported level editor
// (served at /editor/), so it tells the launcher on boot — mirroring the
// cmg-cheats/cmg-actions opt-in pattern — which surfaces an "Edit Levels" entry
// in the Guide OSD. The games.json `levelEditor` flag is the belt-and-suspenders
// fallback for when the launcher can't hear this (e.g. an older manifest); the
// dashboard sanitizes both to a same-origin /editor… path.
const LEVEL_EDITOR_BROADCAST = `
(function () {
  if (window.parent === window) return; // standalone — no launcher to notify
  try { window.parent.postMessage({ type: "cmg-level-editor", game: "2028-ai" }, "*"); } catch (_) {}
})();
`;

// Cheat-availability broadcast. Advertises this game's boot-time URL-param
// cheats (bossRush, stage, and the ?boss=goki Akuma cheat) to the parent
// launcher over the cmg-cheats opt-in pattern, so its Guide OSD surfaces a
// Cheats submenu when this game runs inside cmg. The Xbox-360-blade embedded
// OSD that used to render these in-page was extracted into the launcher's
// XBOX 360 dashboard theme (Settings → Theme).
const CHEATS_BROADCAST = `
(function () {
  if (window.parent === window) return; // standalone — no launcher to notify
  try { window.parent.postMessage({ type: "cmg-cheats", cheats: [
    { param: "bossRush", kind: "toggle", label: "Boss Rush", on: "1" },
    { param: "stage", kind: "slider", label: "Start Stage", min: 0, max: 4 },
    { param: "boss", kind: "toggle", label: "Akuma Boss", on: "goki" }
  ] }, "*"); } catch (_) {}
})();
`;

// A font declared only in @font-face never loads for canvas text (canvas
// drawing doesn't count as CSS usage), so start the fetch explicitly. Any
// text object drawn before it lands gets re-rendered by the runtime's
// document.fonts.ready hook.
const FONT_PRELOAD = `
if (document.fonts && document.fonts.load) {
  document.fonts.load("700 16px Orbitron").catch(function () {});
}
`;

// Screen-fit + portrait, ported from 2019-es7/phaser-game.html.
const FIT_PORTRAIT = `
(function () {
  var GW = 256, GH = 480;

  function isRotated() {
    var t = window.getComputedStyle(document.documentElement).transform;
    return !!t && t !== "none";
  }

  function fitCanvas() {
    var pc = document.querySelector("#phaser-canvas canvas");
    if (!pc) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    // Under the CSS landscape-rotation fallback the visual viewport is
    // portrait but innerWidth/innerHeight still report landscape — swap them.
    var cssRotated = isRotated();
    if (cssRotated && vw > vh) { var tmp = vw; vw = vh; vh = tmp; }
    var scale = Math.min(vw / GW, vh / GH);
    pc.style.width = Math.floor(GW * scale) + "px";
    pc.style.height = Math.floor(GH * scale) + "px";
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.scale) return;
    // refresh() re-derives the whole scale state, but only makes sense on the
    // unrotated layout; when rotated just re-read canvasBounds (through the
    // patched getBoundingClientRect) so pointer mapping tracks the new size.
    if (!cssRotated && typeof g.scale.refresh === "function") g.scale.refresh();
    else if (cssRotated && typeof g.scale.updateBounds === "function") g.scale.updateBounds();
  }
  window.__fitCanvas = fitCanvas;
  window.addEventListener("resize", fitCanvas);
  window.addEventListener("orientationchange", function () { setTimeout(fitCanvas, 50); });

  // Phaser maps pointer→game coords via gameSize / canvasBounds; force that
  // ratio so it is correct for any DPR / CSS scale / rotation.
  function fixPhaserTransform() {
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.scale) return;
    g.scale.transformX = function (pageX) { var cb = this.canvasBounds; return (pageX - cb.x) * (GW / cb.width); };
    g.scale.transformY = function (pageY) { var cb = this.canvasBounds; return (pageY - cb.y) * (GH / cb.height); };
  }
  window.__fixPhaserTransform = fixPhaserTransform;

  // Under the landscape fallback the page lives in rotated local coordinates
  // while pointer events and getBoundingClientRect speak screen coordinates.
  // rotate(-90deg) about left/top with the page at top:100% maps local (x, y)
  // to screen (y, innerHeight - x); invert that (local x = innerHeight -
  // screenY, local y = screenX) for the canvas bounds and for every mouse and
  // touch coordinate so Phaser's hit-testing lines up with what the player
  // sees. The rotation checks are live so flipping orientation mid-game
  // engages/disengages the mapping.
  function patchCanvasInputForRotation(canvas) {
    var origBCR = HTMLElement.prototype.getBoundingClientRect;
    canvas.getBoundingClientRect = function () {
      var r = origBCR.call(canvas);
      if (!isRotated()) return r;
      var vh = window.innerHeight;
      return {
        left: vh - r.bottom, top: r.left,
        right: vh - r.top, bottom: r.right,
        width: r.height, height: r.width,
        x: vh - r.bottom, y: r.left,
      };
    };
    function toLocal(p) {
      var cx = p.clientX, cy = p.clientY;
      var vh = window.innerHeight;
      Object.defineProperty(p, "clientX", { value: vh - cy, configurable: true });
      Object.defineProperty(p, "clientY", { value: cx, configurable: true });
      Object.defineProperty(p, "pageX", { value: vh - cy, configurable: true });
      Object.defineProperty(p, "pageY", { value: cx, configurable: true });
    }
    function swap(e) {
      if (!isRotated()) return;
      if (e.changedTouches) {
        for (var i = 0; i < e.changedTouches.length; i++) toLocal(e.changedTouches[i]);
      } else {
        toLocal(e);
      }
    }
    // Window capture so the rewrite always runs before Phaser's own canvas/
    // window listeners, whatever order they were registered in.
    ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove",
      "touchstart", "touchend", "touchmove", "touchcancel"].forEach(function (ev) {
      window.addEventListener(ev, swap, true);
    });
  }

  // Best-effort native portrait lock (only succeeds in fullscreen on some
  // browsers; the CSS rotation is the reliable fallback).
  function lockPortrait() {
    try {
      if (window.screen && window.screen.orientation && window.screen.orientation.lock) {
        window.screen.orientation.lock("portrait").catch(function () {});
      }
    } catch (e) {}
  }
  window.addEventListener("pointerdown", lockPortrait, { once: true });

  // Order matters: install the bounds/event rewrite first so fitCanvas's
  // updateBounds call already reads the virtual (un-rotated) rect.
  function onCanvas(canvas) {
    patchCanvasInputForRotation(canvas);
    fixPhaserTransform();
    fitCanvas();
  }

  // Fit + patch as soon as Phaser inserts the canvas. On the cmg route this
  // script runs in <head>, before #phaser-canvas exists in the body, so arm
  // the observer on DOMContentLoaded in that case (the exported shell runs it
  // from the end of <body>, where the container is already there).
  function arm() {
    var container = document.getElementById("phaser-canvas");
    if (!container) return false;
    var existing = container.querySelector("canvas");
    if (existing) { onCanvas(existing); return true; }
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          if (muts[i].addedNodes[j].tagName === "CANVAS") {
            onCanvas(muts[i].addedNodes[j]);
            obs.disconnect();
            return;
          }
        }
      }
    });
    obs.observe(container, { childList: true });
    return true;
  }
  if (!arm()) document.addEventListener("DOMContentLoaded", arm);
})();
`;

export default define.page(function Game2028() {
  return (
    <>
      <Head>
        <title>2028.Ai</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
        />
        <meta name="theme-color" content="#000000" />
        {
          /* Declared so the browser stops probing /apple-touch-icon.png at the
             root and 404ing: with no link element it guesses that path itself.
             Same icon the dashboard uses, so a home-screen shortcut to a game
             matches a shortcut to the launcher. */
        }
        <link
          key="apple-touch"
          rel="apple-touch-icon"
          href="/app-icons/ios/icon-180.png"
        />
        <style>
          {`
          /* The runtime's STAFF ROLL card renders canvas text in Orbitron;
             declared here because canvas usage alone never fetches a CSS
             font — FONT_PRELOAD below starts the load. */
          @font-face {
            font-family: 'Orbitron';
            src: url('/games/2028-ai/assets/fonts/Orbitron-Variable.woff2') format('woff2'),
                 url('/games/2028-ai/assets/fonts/Orbitron-Variable.ttf') format('truetype');
            font-weight: 400 900;
            font-display: swap;
          }
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            height: 100dvh;
            background: #000;
            overflow: hidden;
            overscroll-behavior: none;
            touch-action: none;
          }
          #phaser-canvas {
            width: 100%;
            height: 100%;
            height: 100dvh;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding-top: env(safe-area-inset-top, 0px);
            padding-bottom: env(safe-area-inset-bottom, 0px);
            padding-left: env(safe-area-inset-left, 0px);
            padding-right: env(safe-area-inset-right, 0px);
          }
          #phaser-canvas canvas {
            image-rendering: pixelated;
            image-rendering: crisp-edges;
            touch-action: none;
          }
          /* Force portrait layout on landscape screens by rotating the page. */
          @media screen and (orientation: landscape) {
            html {
              transform: rotate(-90deg);
              transform-origin: left top;
              width: 100vh;
              height: 100vw;
              overflow: hidden;
              position: absolute;
              top: 100%;
              left: 0;
            }
            html body { height: 100%; }
            html #phaser-canvas { height: 100%; }
          }
          `}
        </style>
        {
          /* Lets a player scene script (and the 5velte-ph4ser build it may
             pull from esm.sh with ?external=phaser) resolve a bare
             `import Phaser from "phaser"`. Phaser ships here as a UMD global,
             so the specifier maps to a shim re-exporting globalThis.Phaser —
             pointing it at a CDN ESM build instead would give scripts a
             second, unrelated Phaser. Must precede any module script. */
        }
        <script
          type="importmap"
          dangerouslySetInnerHTML={{ __html: PHASER_IMPORT_MAP }}
        />
        <script src="/gamepad-compatibility-plugin.js"></script>
        {
          /* Leaderboard. The config is the same file tools/build-level stages
             into an exported app, so a level scores to one board wherever it is
             played. The compat SDK is deferred (never blocking the bundle) and
             firebaseScores.js waits a bounded time for it, so a slow or absent
             network costs boot time nothing and just leaves the local cache. */
        }
        <script src="/firebase-config.js"></script>
        <script
          defer
          src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"
        >
        </script>
        <script
          defer
          src="https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js"
        >
        </script>
        <script dangerouslySetInnerHTML={{ __html: CHARACTERS_MODULE }} />
        <script dangerouslySetInnerHTML={{ __html: OSD_BRIDGE }} />
        <script dangerouslySetInnerHTML={{ __html: LEVEL_EDITOR_BROADCAST }} />
        <script dangerouslySetInnerHTML={{ __html: AUDIO_UNLOCK }} />
        <script dangerouslySetInnerHTML={{ __html: FONT_PRELOAD }} />
        <script dangerouslySetInnerHTML={{ __html: FIT_PORTRAIT }} />
      </Head>

      {
        /* Read by the level-loader plugin's custom-BGM path. Kept relative
          ("./") because the Phaser loader already has setBaseURL("/games/2028-ai/"),
          so an absolute value here would double the prefix. */
      }
      <div id="baseUrl" hidden>./</div>
      <div id="phaser-canvas"></div>

      <script src="/games/2028-ai/lib/phaser.min.js" defer></script>
      <script src="/games/2028-ai/game.bundle.js" defer></script>

      {
        /* EXTRACT MODE: save any paused sprite to the shared character
          library — rides the standalone PAUSE panel the bundle builds. */
      }
      <script src="/phaser-plugins/extract-mode.js" defer></script>

      {
        /* ONLINE 2P: the live-runs panel and the guest view. Inert unless the
          page is opened with ?online=1 — see static/phaser-plugins/netplay-lobby.js
          and the cmgNet* host half in game.bundle.js. */
      }
      <script src="/phaser-plugins/netplay-lobby.js" type="module" defer>
      </script>

      {/* Advertise boot-time cheats to the cmg launcher's Guide OSD. */}
      <script dangerouslySetInnerHTML={{ __html: CHEATS_BROADCAST }} />
    </>
  );
});
