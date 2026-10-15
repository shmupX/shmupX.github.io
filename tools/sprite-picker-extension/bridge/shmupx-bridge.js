/**
 * shmupX Sprite Picker - Editor Bridge
 * Content script on the level editor's origins, in EVERY frame: the editor
 * (static/editor/index.html at /editor/) may be its own tab, a PWA window,
 * or the dashboard's same-origin <iframe> (svelte-src/Dashboard.svelte).
 *
 * Relays between the service worker and the page's own listener
 * ("SPRITE PICKER EXTENSION BRIDGE" in the editor):
 *   SHX_PING        → am I the editor? (answer) / the dashboard? (answer late)
 *   SHX_INJECT      → window.postMessage SPRITE_PICKER_INJECT
 *   SHX_GET_FRAMES  → window.postMessage GET_ATLAS_FRAMES { requestId, atlas? },
 *                     wait for ATLAS_FRAMES_RESPONSE
 * Frames that are neither return without responding, so the editor frame's
 * answer is the one the service worker receives.
 */
(function () {
  "use strict";

  if (window.__shxBridgeLoaded) return;
  window.__shxBridgeLoaded = true;

  const Core = globalThis.ShxPickerCore;

  // The dashboard's root route mounts #app-root and loads dashboard.bundle.js
  // (routes/index.tsx). Other pages on these origins are games — not us.
  function isDashboard() {
    return !!document.getElementById("app-root") &&
      !!document.querySelector('script[src*="dashboard.bundle"]');
  }

  // The editor path AND the editor's own mark: this bridge runs on every
  // localhost / 127.0.0.1 port, where any project may have a /editor route.
  function isEditor() {
    return Core.isEditorPath(location.pathname) &&
      !!document.querySelector('meta[name="shmupx-editor"]');
  }

  // How long the dashboard frame waits before answering a ping, so an editor
  // frame in its iframe (which answers at once) wins the single response slot.
  const DASHBOARD_PING_DELAY_MS = 250;
  const FRAMES_TIMEOUT_MS = 3000;

  function readPickerCode() {
    try {
      // The page's own localStorage — content scripts share it with the editor.
      return Core.normalizePickerCode(localStorage.getItem("shmupx-picker-code")) || null;
    } catch (_) {
      return null;
    }
  }

  function safeRespond(sendResponse, value) {
    try {
      sendResponse(value);
    } catch (_) {
      // Another frame already answered and the port closed.
    }
  }

  /**
   * Ask the page for an atlas's frames (`atlas`, or its current one when
   * null). Resolves { frames, atlas, currentAtlas, atlases, pickerCode } —
   * what the editor's ATLAS_FRAMES_RESPONSE carries — or rejects on timeout.
   */
  function requestAtlasFrames(atlas) {
    return new Promise((resolve, reject) => {
      const requestId = "shx-" + Date.now().toString(36) + "-" +
        Math.random().toString(36).slice(2, 8);
      const onMessage = (ev) => {
        const d = ev.data;
        if (!d || d.source !== "sprite-picker-page") return;
        if (d.type !== "ATLAS_FRAMES_RESPONSE" || d.requestId !== requestId) return;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        const answered = typeof d.atlas === "string" ? d.atlas : null;
        resolve({
          frames: Array.isArray(d.frames) ? d.frames : [],
          atlas: answered,
          // An editor predating `currentAtlas` answers only for its current
          // atlas, so with no atlas asked for, `atlas` is the current one.
          currentAtlas: typeof d.currentAtlas === "string"
            ? d.currentAtlas
            : (atlas ? null : answered),
          atlases: Array.isArray(d.atlases) ? d.atlases : null,
          pickerCode: Core.normalizePickerCode(d.pickerCode) || null,
        });
      };
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The editor did not answer GET_ATLAS_FRAMES"));
      }, FRAMES_TIMEOUT_MS);
      window.addEventListener("message", onMessage);
      const request = { source: "sprite-picker-bridge", type: "GET_ATLAS_FRAMES", requestId };
      if (atlas) request.atlas = atlas;
      window.postMessage(request, location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "SHX_PING") {
      if (isEditor()) {
        sendResponse({
          isEditor: true,
          isTop: window === window.top,
          href: location.href,
          pickerCode: readPickerCode(),
        });
        return;
      }
      if (isDashboard()) {
        // Answer late: if the editor is in our iframe its answer lands first.
        setTimeout(() => safeRespond(sendResponse, { isDashboard: true }), DASHBOARD_PING_DELAY_MS);
        return true;
      }
      return; // not us — leave the response slot to the editor frame
    }

    if (!isEditor()) return;

    if (msg.type === "SHX_INJECT") {
      const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
      if (!Array.isArray(payload.sprites) || !payload.sprites.length) {
        sendResponse({ error: "No sprites in the inject" });
        return;
      }
      window.postMessage(
        { source: "sprite-picker-bridge", type: "SPRITE_PICKER_INJECT", ...payload },
        location.origin,
      );
      sendResponse({ success: true, href: location.href });
      return;
    }

    if (msg.type === "SHX_GET_FRAMES") {
      const atlas = typeof msg.atlas === "string" && msg.atlas ? msg.atlas : null;
      requestAtlasFrames(atlas).then(
        (result) => safeRespond(sendResponse, result),
        (err) => safeRespond(sendResponse, { frames: [], atlas: null, error: err.message }),
      );
      return true; // async response
    }
  });
})();
