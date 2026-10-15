/**
 * shmupX Sprite Picker - Background Service Worker
 * Handles: CORS image proxy, level-editor discovery, routing, context menu.
 *
 * Sprites picked by the content script travel one of two roads:
 *   editor tab   content → here → bridge/shmupx-bridge.js in the editor frame
 *                → window.postMessage SPRITE_PICKER_INJECT → the editor's
 *                Atlas Manager (static/editor/index.html).
 *   inbox        content → here → PUT to the Realtime Database at
 *                spritePicker/inbox/<CODE>/<batchId>; the editor's watcher
 *                picks the batch up when it opens with that PICKER CODE.
 */

importScripts("/lib/picker-core.js");

const Core = globalThis.ShxPickerCore;

// How long an editor frame gets to answer a ping / frame listing, and how
// long an inbox write may take before it is abandoned (the panel waits 90 s
// for an inbox send, so this error reaches it first).
const PING_TIMEOUT_MS = 1500;
const FRAMES_TIMEOUT_MS = 3500;
const INBOX_PUT_TIMEOUT_MS = 80000;

// Register context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "shx-detect-sprites",
    title: "Detect Sprites in This Image",
    contexts: ["image"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "shx-detect-sprites" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "DETECT_IMAGE",
      srcUrl: info.srcUrl,
    }, () => {
      // No picker on that tab (not a sprite site, not injected) — nothing to do.
      void chrome.runtime.lastError;
    });
  }
});

// Message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "FETCH_IMAGE") {
    fetchImageAsDataURL(msg.url).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // async response
  }

  if (msg.type === "PING_EDITOR") {
    pingEditor().then(sendResponse).catch((err) => {
      sendResponse({ editorFrames: [], dashboardTabs: [], error: err.message });
    });
    return true;
  }

  if (msg.type === "GET_ATLAS_FRAMES") {
    getAtlasFrames(msg.atlas).then(sendResponse).catch((err) => {
      sendResponse({ frames: [], atlas: null, error: err.message });
    });
    return true;
  }

  if (msg.type === "SEND_SPRITES") {
    sendSprites(msg).then(sendResponse).catch((err) => {
      // The target it tried travels with the error so the panel's TARGET
      // line does not go stale on a failed send.
      sendResponse({ error: err.message, target: err.target || null });
    });
    return true;
  }
});

// ==================== Image proxy ====================

/** Fetch a cross-origin image and return it as a data URL */
async function fetchImageAsDataURL(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const blob = await response.blob();
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { dataURL: `data:${blob.type || "image/png"};base64,${btoa(binary)}` };
}

// ==================== Editor discovery ====================

/**
 * tabs.sendMessage with a timeout. `options` may carry a frameId; without
 * one every frame of the tab receives the message and the FIRST frame to
 * call sendResponse wins — the bridge only answers from an editor frame
 * (the dashboard answers late, see bridge/shmupx-bridge.js), so a dashboard
 * tab with the editor in its iframe reports the editor.
 */
function sendToTab(tabId, message, options, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const cb = (response) => {
      if (chrome.runtime.lastError) finish(undefined); // no bridge / nobody answered
      else finish(response);
    };
    try {
      if (options) chrome.tabs.sendMessage(tabId, message, options, cb);
      else chrome.tabs.sendMessage(tabId, message, cb);
    } catch (_) {
      finish(undefined);
    }
  });
}

/** The stored picker code and where it came from: { code, source: "typed" | "editor" | null }. */
async function getStoredPickerCode() {
  try {
    const stored = await chrome.storage.local.get(["pickerCode", "pickerCodeSource"]);
    const code = Core.normalizePickerCode(stored?.pickerCode);
    return {
      code,
      source: code ? (stored?.pickerCodeSource === "typed" ? "typed" : "editor") : null,
    };
  } catch (_) {
    return { code: "", source: null };
  }
}

/**
 * Keep the code an editor frame reports, so a user who once had the editor
 * open never has to type it. A code the user typed themselves is never
 * overwritten; one learned earlier follows the editor.
 */
async function learnPickerCode(reported) {
  const code = Core.normalizePickerCode(reported);
  if (!code) return null;
  const stored = await getStoredPickerCode();
  if (stored.source === "typed") return stored;
  if (stored.code === code) return stored;
  try {
    await chrome.storage.local.set({ pickerCode: code, pickerCodeSource: "editor" });
  } catch (_) {
    return stored;
  }
  return { code, source: "editor" };
}

/** Every open editor frame (tab or PWA window, top-level or in the dashboard's iframe), plus dashboards without one. */
async function scanEditorFrames() {
  const tabs = await chrome.tabs.query({ url: Core.EDITOR_URL_PATTERNS });
  const editorFrames = [];
  const dashboardTabs = [];
  await Promise.all(tabs.map(async (tab) => {
    if (!Number.isInteger(tab.id)) return;
    const resp = await sendToTab(tab.id, { type: "SHX_PING" }, undefined, PING_TIMEOUT_MS);
    if (!resp) return;
    if (resp.isEditor) {
      editorFrames.push({
        tabId: tab.id,
        windowId: tab.windowId,
        // A content script cannot read its own frameId; the top frame is 0
        // and an iframe is unknown (null), which routes through all frames.
        frameId: resp.frameId ?? (resp.isTop ? 0 : null),
        href: resp.href || tab.url || null,
        pickerCode: Core.normalizePickerCode(resp.pickerCode) || null,
        active: !!tab.active,
      });
    } else if (resp.isDashboard) {
      dashboardTabs.push({ tabId: tab.id, windowId: tab.windowId, href: tab.url || null });
    }
  }));
  // Stable order: the active editor first, then by tab id.
  editorFrames.sort((a, b) => (b.active - a.active) || (a.tabId - b.tabId));
  return { editorFrames, dashboardTabs };
}

async function pingEditor() {
  const { editorFrames, dashboardTabs } = await scanEditorFrames();
  let stored = await getStoredPickerCode();
  const reported = editorFrames.find((f) => f.pickerCode)?.pickerCode;
  if (reported) stored = (await learnPickerCode(reported)) || stored;
  const target = Core.chooseTarget({ editorFrames, pickerCode: stored.code });
  return {
    editorFrames,
    dashboardTabs,
    pickerCode: stored.code || null,
    pickerCodeSource: stored.source,
    target,
  };
}

// ==================== Atlas frames ====================

/**
 * The frames of one atlas (`atlas`), or of the editor's current one when
 * omitted. The editor answers for any atlas it knows without switching, and
 * says which one it is on (`currentAtlas`) and which exist (`atlases`).
 */
async function getAtlasFrames(atlas) {
  const { editorFrames, target } = await pingEditor();
  if (target.kind === "inbox") return { frames: [], atlas: null, inbox: true };
  if (target.kind !== "tab") return { frames: [], atlas: null, error: target.reason };
  const request = { type: "SHX_GET_FRAMES" };
  if (typeof atlas === "string" && atlas) request.atlas = atlas;
  const resp = await sendToTab(
    target.tabId,
    request,
    Core.frameOptions(target),
    FRAMES_TIMEOUT_MS,
  );
  if (!resp) throw new Error(`Editor tab ${target.tabId} did not answer`);
  if (resp.error) throw new Error(resp.error);
  if (resp.pickerCode) await learnPickerCode(resp.pickerCode);
  return {
    frames: Array.isArray(resp.frames) ? resp.frames : [],
    atlas: typeof resp.atlas === "string" ? resp.atlas : null,
    currentAtlas: typeof resp.currentAtlas === "string" ? resp.currentAtlas : null,
    atlases: Array.isArray(resp.atlases) ? resp.atlases.filter((k) => typeof k === "string" && k) : null,
    tabId: target.tabId,
    editorFrames,
  };
}

// ==================== Send ====================

async function sendSprites(msg) {
  const sprites = Array.isArray(msg.sprites) ? msg.sprites : [];
  if (!sprites.length) throw new Error("No sprites to send");

  const payload = Core.buildInjectPayload({
    sprites,
    atlas: msg.atlas,
    mode: msg.mode,
    frameName: msg.frameName,
    now: Date.now(),
  });

  const { target } = await pingEditor();
  const count = `${sprites.length} SPRITE${sprites.length === 1 ? "" : "S"}`;
  const withTarget = (err) => {
    err.target = target;
    return err;
  };

  if (target.kind === "tab") {
    try {
      await injectIntoTab(target, payload);
    } catch (err) {
      throw withTarget(err);
    }
    await focusTab(target.tabId);
    return {
      success: true,
      target,
      batchId: payload.batchId,
      message: `SENT ${count} → ${Core.describeTarget(target)}`,
    };
  }

  if (target.kind === "inbox") {
    if (Core.inboxTooLarge(sprites)) {
      const mib = (Core.payloadBytes(sprites) / (1024 * 1024)).toFixed(1);
      throw withTarget(new Error(
        `${mib} MiB of sprites is over the ${Core.INBOX_MAX_LABEL} inbox limit — ` +
        "send fewer at a time, or open the editor in a tab",
      ));
    }
    try {
      await putInbox(target.code, payload);
    } catch (err) {
      throw withTarget(err);
    }
    return {
      success: true,
      target,
      batchId: payload.batchId,
      message: `SENT ${count} → INBOX ${Core.formatPickerCode(target.code)} (the editor picks them up when it opens)`,
    };
  }

  throw withTarget(new Error(target.reason));
}

/** Hand the payload to the editor frame's bridge, which posts SPRITE_PICKER_INJECT into the page. */
async function injectIntoTab(target, payload) {
  const resp = await sendToTab(
    target.tabId,
    { type: "SHX_INJECT", payload },
    Core.frameOptions(target),
    FRAMES_TIMEOUT_MS,
  );
  if (!resp) throw new Error(`Editor tab ${target.tabId} did not accept the sprites`);
  if (resp.error) throw new Error(resp.error);
  return resp;
}

/** Bring the editor forward so its notification is seen. Best effort. */
async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = tab?.windowId;
    if (Number.isInteger(windowId)) {
      await chrome.windows.update(windowId, { focused: true });
    }
  } catch (_) {
    // A PWA window or a closed tab may refuse; the sprites are already there.
  }
}

/** Write one batch to the Realtime Database inbox the editor watches. */
async function putInbox(code, payload) {
  const url = Core.inboxUrl(code, payload.batchId);
  const body = Core.inboxBody(payload);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INBOX_PUT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error("Inbox write timed out — check the editor before sending again");
    }
    throw new Error(`Inbox unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Inbox write failed: ${response.status} ${response.statusText}`);
  }
  return true;
}
