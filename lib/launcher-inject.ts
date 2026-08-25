// Launcher-detection contract, ported from codemonkey-games-launcher (its
// routes/[...path].ts injects the same marker into every game it serves).
// Games hide their own standalone chrome — headers, attribution, instructions —
// when running inside the launcher via CSS keyed off these signals:
//
//   .inLauncher #info { display: none !important; }
//
// Signals stamped on the game document when it runs inside the launcher UI:
//   - window.__CMG_LAUNCHER__ === true and window.__CMG__.launcher === true
//   - <html data-cmg-launcher="1">
//   - class "inLauncher" on <html> and <body>
//
// One deliberate divergence from upstream: the launcher repo stamps
// unconditionally because its server exists only to back the kiosk window.
// CMG's routes are also the public web app, so the marker here fires only when
// the page is actually embedded (window.parent !== window) — a direct visit to
// /games/<id>/ keeps the game's standalone header. The dashboard always runs
// games in an iframe (web, kiosk, and desktop builds alike), so every real
// launcher launch is covered. This matches the convention CMG demos already
// use by hand (static/demos/akuma.js); the same stamp is applied from the
// launcher side for same-origin frames in svelte-src/Dashboard.svelte
// (injectLauncherMarkerIntoFrame) — both are idempotent.

export const LAUNCHER_MARKER = `\n<script id="cmg-launcher-marker">(function(){
  try {
    if (window.parent === window) return; /* standalone tab: keep the game's own chrome */
    window.__CMG_LAUNCHER__ = true;
    if (!window.__CMG__) { try { window.__CMG__ = Object.freeze({ launcher: true, name: "cmg" }); } catch(_){} }
    try { document.documentElement.setAttribute("data-cmg-launcher", "1"); } catch(_){}
    try { document.documentElement.classList.add("inLauncher"); } catch(_){}
    try {
      if (document.body) document.body.classList.add("inLauncher");
      else document.addEventListener("DOMContentLoaded", function(){ try { document.body && document.body.classList.add("inLauncher"); } catch(_){} }, { once: true });
    } catch(_){}
  } catch(_){}
})();</script>\n`;

// Icon-capture agent, stamped alongside the marker (and into the emulator
// player pages, which don't get the marker). Two jobs, both inert unless the
// launcher is involved:
//
//   1. Arming — when the dashboard has a local icon store it sets
//      sessionStorage "cmg-icon-capture" = "1" (same-origin frames share the
//      tab's sessionStorage), and this script — which runs before any game
//      script — patches getContext to force preserveDrawingBuffer on WebGL
//      contexts so a later canvas readback sees real pixels instead of a
//      cleared back buffer. This is the fix for the launcher repo's
//      "dataUrl is black rectangle" bug, applied at the right time.
//   2. Capture responder — when the frame is CROSS-origin (a packaged
//      launcher running games off the deploy), the dashboard can't reach in,
//      so it asks over postMessage; the agent lazy-loads /icon-capture.js
//      from its own origin and answers with a PNG data URL. Parent-only.
export const CAPTURE_AGENT = `\n<script id="cmg-icon-capture-agent">(function(){
  try {
    var armed = false;
    try { armed = sessionStorage.getItem("cmg-icon-capture") === "1"; } catch(_){}
    if (armed && window.HTMLCanvasElement) {
      var getCtx = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
          attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
        }
        return getCtx.call(this, type, attrs);
      };
    }
    if (window.parent === window) return;
    window.addEventListener("message", function(ev) {
      var d = ev.data;
      if (!d || d.type !== "cmg-icon-capture-request") return;
      if (ev.source !== window.parent) return;
      import(new URL("/icon-capture.js", location.origin).href).then(function(mod){
        return mod.captureGameDocument(window, { maxDim: d.maxDim || 512 });
      }).then(function(dataUrl){
        ev.source.postMessage({ type: "cmg-icon-capture-result", token: d.token, dataUrl: dataUrl }, "*");
      }).catch(function(e){
        try { ev.source.postMessage({ type: "cmg-icon-capture-result", token: d.token, error: String(e && e.message || e) }, "*"); } catch(_){}
      });
    });
  } catch(_){}
})();</script>\n`;

function injectAfterHead(html: string, snippet: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + snippet);
  }
  if (/^<!doctype[^>]*>/i.test(html)) {
    return html.replace(/^<!doctype[^>]*>/i, (m) => m + snippet);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + snippet);
  }
  return snippet + html;
}

// Insert the marker right after <head> so it runs before the game's own
// scripts. Fallback anchors mirror the upstream injector: after <!doctype>,
// after <html>, else prepended to fragment-only documents. Idempotent: a
// document that already carries the marker (e.g. stamped by both the
// middleware in main.ts and a route-level injector) is returned unchanged.
export function injectLauncherMarker(html: string): string {
  if (html.includes('id="cmg-launcher-marker"')) return html;
  return injectAfterHead(html, LAUNCHER_MARKER);
}

// Same anchors and idempotency for the capture agent.
export function injectCaptureAgent(html: string): string {
  if (html.includes('id="cmg-icon-capture-agent"')) return html;
  return injectAfterHead(html, CAPTURE_AGENT);
}
