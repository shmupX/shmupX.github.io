// The 2028.Ai game page, as data: the inline scripts and the stylesheet the
// Fresh route (routes/games/2028-ai.tsx) puts in its head, and the same page
// rendered as one standalone HTML string for a build that is served from
// somewhere else — scripts/2019/build-zip.ts writes it into the eShop archive
// of the 2019 game's PS2 web build, which plays out of Cache Storage at
// /eshop/2019/ with the bundle and the assets fetched off this origin. The
// two used to drift by construction: the route owned the scripts, and every
// other shell (tools/build-level's, the profiler's) was a hand copy.

// Maps the bare "phaser" specifier onto the shim that re-exports the UMD
// global this page loads, so scene scripts share the game's single Phaser.
export const PHASER_IMPORT_MAP = JSON.stringify({
  imports: { "phaser": "/phaser-plugins/phaser-global.js" },
});

// Scene scripts importing the characters library by its documentation URL
// (easierbycode.com/2019-es7/characters) are rewritten to this module. On
// cmg-served pages that is our own /characters route, whose named exports are
// generated from the database per request — a character created moments ago
// imports by name with no rebuild. Standalone/offline exports of this game
// lack the route (and this global), so scene-script.js falls back to the
// static GitHub Pages build.
export const CHARACTERS_MODULE = `
globalThis.__CHARACTERS_MODULE__ = location.origin + "/characters";
`;

export const AUDIO_UNLOCK = `
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
export const OSD_BRIDGE = `
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
export const LEVEL_EDITOR_BROADCAST = `
(function () {
  if (window.parent === window) return; // standalone — no launcher to notify
  try { window.parent.postMessage({ type: "cmg-level-editor", game: "2028-ai" }, "*"); } catch (_) {}
})();
`;

// Cheat-availability broadcast: see `cmgBroadcastCheats` in game.bundle.js. It
// used to be a static list in this head, but which boot-time cheats this page
// offers depends on the level it ends up running — an imported Dezaemon save
// has its own stage count and no Akuma — so the bundle sends it once the level
// has resolved instead. (The Xbox-360-blade embedded OSD that used to render
// these in-page was extracted into the launcher's XBOX 360 dashboard theme.)

// A font declared only in @font-face never loads for canvas text (canvas
// drawing doesn't count as CSS usage), so start the fetch explicitly. Any
// text object drawn before it lands gets re-rendered by the runtime's
// document.fonts.ready hook.
export const FONT_PRELOAD = `
if (document.fonts && document.fonts.load) {
  document.fonts.load("8px athenaFont").catch(function () {});
}
`;

// Screen-fit + portrait, ported from 2019-es7/phaser-game.html.
export const FIT_PORTRAIT = `
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

/** The route's <style> block, verbatim. */
export const GAME_PAGE_CSS = `
          /* The runtime's text over gameplay — the Dezaemon title prompt,
             the STAFF ROLL card and the PAUSE panel — is set in athenaFont:
             Dezaemon 2's own 8x8 game font (the disc's GFONT.BIN, font 0),
             kept in spriteX's catalog and traced to TrueType by its
             scripts/export-font.mjs, one em per 8 px cell so it is
             pixel-exact at 8 px (the sheet sits beside the .ttf). Declared
             here because canvas usage alone never fetches a CSS font —
             FONT_PRELOAD below starts the load. */
          @font-face {
            font-family: 'athenaFont';
            src: url('/games/2028-ai/assets/fonts/athenaFont.ttf') format('truetype');
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
`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The game page as one HTML document, for a copy of the bundle that lives
 * beside it. Every other URL is root-relative to this origin — the Phaser
 * build, the plugins, the gamepad bridge, the leaderboard config — because
 * that is where they are, whichever path the page itself is served from.
 * `bundleSrc` is the one thing that moves: the eShop archive carries its own
 * game.bundle.js, patched to read the level from a foo.json beside it.
 *
 * What the route has and this does not: LEVEL_EDITOR_BROADCAST, which tells
 * the launcher this game ships the level editor — true of 2028.Ai's own entry,
 * not of a level exported from it.
 */
export function standaloneGamePageHtml(
  { title, bundleSrc }: { title: string; bundleSrc: string },
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<link rel="apple-touch-icon" href="/app-icons/ios/icon-180.png">
<style>${GAME_PAGE_CSS}</style>
<script type="importmap">${PHASER_IMPORT_MAP}</script>
<script src="/gamepad-compatibility-plugin.js"></script>
<script src="/firebase-config.js"></script>
<script defer src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"></script>
<script defer src="https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js"></script>
<script>${CHARACTERS_MODULE}</script>
<script>${OSD_BRIDGE}</script>
<script>${AUDIO_UNLOCK}</script>
<script>${FONT_PRELOAD}</script>
<script>${FIT_PORTRAIT}</script>
</head>
<body>
<div id="baseUrl" hidden>./</div>
<div id="phaser-canvas"></div>
<script src="/games/2028-ai/lib/phaser.min.js" defer></script>
<script src="${esc(bundleSrc)}" defer></script>
<script src="/phaser-plugins/extract-mode.js" defer></script>
<script src="/phaser-plugins/netplay-lobby.js" type="module" defer></script>
<script src="/phaser-plugins/engine-compare.js" defer></script>
</body>
</html>
`;
}
