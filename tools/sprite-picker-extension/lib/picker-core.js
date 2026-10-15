/**
 * shmupX Sprite Picker - shared core
 *
 * Pure functions used by the service worker, the popup, the content script
 * and the editor bridge. A plain script (no modules) so it loads in all four
 * contexts: it assigns `globalThis.ShxPickerCore`. The tests evaluate the
 * source the same way (the repo's package.json is "type": "module", so a
 * require() would not see module.exports); the CommonJS export below is for
 * any plain-CJS caller.
 *
 * Nothing in here touches chrome.*, the DOM or the network.
 */
(function () {
  "use strict";

  // The picker code the editor's Atlas Manager shows: 8 characters from an
  // alphabet with no 0/O or 1/I, so a code read off a screen types back in.
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const CODE_LENGTH = 8;

  // Where sprites go when no editor tab is open: a Realtime Database inbox
  // the editor watches (spritePicker/inbox/<CODE>/<batchId>).
  const RTDB_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
  const INBOX_ROOT = "spritePicker/inbox";
  const INBOX_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB of sprites per batch
  const INBOX_MAX_LABEL = "4 MiB"; // the one spelling every message uses

  // Who an inject says it came from (the editor shows it in its notification).
  const FROM = "shmupX Sprite Picker";

  // The atlases the editor knows. `game_asset` is the game's sprites and the
  // editor's default; the editor's current one comes back in
  // ATLAS_FRAMES_RESPONSE.atlas and goes first in the picker's list.
  const ATLAS_KEYS = ["game_asset", "game_ui", "title_ui"];

  // Where the level editor lives, as chrome.tabs.query / manifest match
  // patterns. Ports are not part of a match pattern, so `http://localhost/*`
  // covers the dev server (5173 / 8000) and the Windows desktop binary (8787).
  const EDITOR_URL_PATTERNS = [
    "https://codemonkey.games/*",
    "https://*.codemonkey.games/*",
    "https://shmupx.github.io/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ];

  // The editor page itself: static/editor/index.html served at /editor/.
  const EDITOR_PATHS = ["/editor", "/editor/", "/editor/index.html"];

  const NO_TARGET_REASON =
    "Open the level editor (codemonkey.games/editor) in a tab, " +
    "or set the PICKER CODE the editor's Atlas Manager shows";

  /** Upper-case, strip everything but letters and digits; "" unless the result is a valid code. */
  function normalizePickerCode(raw) {
    if (raw === null || raw === undefined) return "";
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleaned.length !== CODE_LENGTH) return "";
    for (const ch of cleaned) {
      if (!CODE_ALPHABET.includes(ch)) return "";
    }
    return cleaned;
  }

  /** "ABCDEFGH" → "ABCD-EFGH"; "" for anything that is not a valid code. */
  function formatPickerCode(code) {
    const c = normalizePickerCode(code);
    if (!c) return "";
    return c.slice(0, 4) + "-" + c.slice(4);
  }

  /** The editor's path, with any query/hash dropped. */
  function isEditorPath(pathname) {
    if (typeof pathname !== "string") return false;
    const bare = pathname.split(/[?#]/, 1)[0];
    return EDITOR_PATHS.includes(bare);
  }

  /** Does this URL sit on an origin the editor is served from? (Any path.) */
  function isEditorOrigin(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return false;
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol === "https:") {
      return host === "codemonkey.games" ||
        host.endsWith(".codemonkey.games") ||
        host === "shmupx.github.io";
    }
    if (u.protocol === "http:") {
      return host === "localhost" || host === "127.0.0.1";
    }
    return false;
  }

  /** Editor origin AND editor path: the page the bridge injects into. */
  function isEditorUrl(url) {
    if (!isEditorOrigin(url)) return false;
    return isEditorPath(new URL(String(url)).pathname);
  }

  /** `spritePicker/inbox/<CODE>/<batchId>` — throws rather than build a bad key. */
  function inboxPath(code, batchId) {
    const c = normalizePickerCode(code);
    if (!c) throw new Error("Invalid picker code");
    if (typeof batchId !== "string" || !/^[A-Za-z0-9_-]+$/.test(batchId)) {
      throw new Error("Invalid batch id");
    }
    return `${INBOX_ROOT}/${c}/${batchId}`;
  }

  /** Full RTDB URL for an inbox write. */
  function inboxUrl(code, batchId) {
    return `${RTDB_URL}/${inboxPath(code, batchId)}.json`;
  }

  /**
   * A batch id that sorts by time and is a legal RTDB key:
   * `<ms since epoch, base 36>-<6 random base-36 chars>`.
   */
  function newBatchId(now, rand) {
    const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
    const r = typeof rand === "function" ? rand : Math.random;
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    let tail = "";
    for (let i = 0; i < 6; i++) {
      const n = Math.min(35, Math.max(0, Math.floor(r() * 36)));
      tail += digits[n];
    }
    return `${Math.max(0, Math.floor(t)).toString(36)}-${tail}`;
  }

  /** UTF-8 size of the sprites as JSON — what the inbox write carries. */
  function payloadBytes(sprites) {
    const json = JSON.stringify(Array.isArray(sprites) ? sprites : []);
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(json).length;
    }
    // Data URLs are ASCII, so length is bytes; names may not be.
    let n = 0;
    for (let i = 0; i < json.length; i++) {
      const c = json.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
    }
    return n;
  }

  function inboxTooLarge(sprites) {
    return payloadBytes(sprites) > INBOX_MAX_BYTES;
  }

  /** cmg's sprite base-name rule: word characters and dashes, 40 max, "sprite" when empty. */
  function sanitizeSpriteName(raw) {
    return String(raw === null || raw === undefined ? "" : raw)
      .replace(/[^\w-]/g, "")
      .slice(0, 40) || "sprite";
  }

  /**
   * The TARGET ATLAS list: the editor's current atlas first, then the atlases
   * the editor reported (ATLAS_FRAMES_RESPONSE.atlases) or, failing that, the
   * known keys — deduped.
   */
  function atlasOptions(current, atlases) {
    const out = [];
    const push = (k) => {
      if (typeof k === "string" && k && !out.includes(k)) out.push(k);
    };
    push(current);
    const list = Array.isArray(atlases) && atlases.length ? atlases : ATLAS_KEYS;
    list.forEach(push);
    return out;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * The frame name a REPLACE most likely meant: an exact match ignoring case,
   * a name that contains / is contained by the typed one, or the nearest by
   * edit distance when it is near enough (2, or half the typed length). null
   * when nothing is close.
   */
  function closestName(name, candidates) {
    if (typeof name !== "string" || !name.trim()) return null;
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const n = name.trim().toLowerCase();
    const names = candidates.filter((c) => typeof c === "string" && c);
    const exact = names.find((c) => c.toLowerCase() === n);
    if (exact) return exact;
    let best = null;
    let bestScore = Infinity;
    for (const c of names) {
      const lc = c.toLowerCase();
      let score = levenshtein(n, lc);
      if (lc.includes(n) || n.includes(lc)) score = Math.min(score, 1);
      if (score < bestScore || (score === bestScore && c.length < best.length)) {
        best = c;
        bestScore = score;
      }
    }
    const limit = Math.max(2, Math.ceil(n.length / 2));
    return bestScore <= limit ? best : null;
  }

  /**
   * Where a send goes. `editorFrames` is what PING_EDITOR collected:
   * [{ tabId, frameId, href, pickerCode }]. The first editor frame wins; with
   * none, a valid picker code routes to the inbox; otherwise there is no target.
   */
  function chooseTarget(opts) {
    const o = opts || {};
    const frames = Array.isArray(o.editorFrames) ? o.editorFrames : [];
    const first = frames.find((f) => f && Number.isInteger(f.tabId));
    if (first) {
      const frameId = Number.isInteger(first.frameId) && first.frameId >= 0
        ? first.frameId
        : null;
      return {
        kind: "tab",
        tabId: first.tabId,
        frameId,
        href: typeof first.href === "string" ? first.href : null,
      };
    }
    const code = normalizePickerCode(o.pickerCode);
    if (code) return { kind: "inbox", code };
    return { kind: "none", reason: NO_TARGET_REASON };
  }

  /**
   * tabs.sendMessage options for a target: a known iframe gets its frameId;
   * the top frame (0) or an unknown frame (null) is addressed with none, so
   * every frame receives the message and only the editor frame acts on it.
   */
  function frameOptions(target) {
    const id = target && target.frameId;
    return Number.isInteger(id) && id > 0 ? { frameId: id } : undefined;
  }

  /** The CRT status line for a target. */
  function describeTarget(target) {
    if (!target || typeof target !== "object") return "NO TARGET";
    switch (target.kind) {
      case "tab":
        return `EDITOR TAB ${target.tabId}`;
      case "inbox":
        return `INBOX ${formatPickerCode(target.code)}`;
      default:
        return "NO TARGET — " + String(target.reason || NO_TARGET_REASON).toUpperCase();
    }
  }

  /**
   * The body of a SPRITE_PICKER_INJECT, minus `source`/`type` (the bridge adds
   * those): the editor's contract plus batchId / from / at on every inject.
   */
  function buildInjectPayload(opts) {
    const o = opts || {};
    const sprites = Array.isArray(o.sprites) ? o.sprites : [];
    const mode = o.mode === "replace" ? "replace" : "add";
    const frameName = typeof o.frameName === "string" && o.frameName.trim()
      ? o.frameName.trim()
      : null;
    if (mode === "replace" && !frameName) {
      throw new Error("REPLACE needs a frame name");
    }
    if (mode === "replace" && sprites.length !== 1) {
      throw new Error("REPLACE takes exactly one sprite");
    }
    const payload = {
      sprites,
      mode,
      batchId: typeof o.batchId === "string" && o.batchId ? o.batchId : newBatchId(o.now),
      from: FROM,
      at: typeof o.now === "number" ? o.now : Date.now(),
    };
    if (typeof o.atlas === "string" && o.atlas) payload.atlas = o.atlas;
    if (frameName) payload.frameName = frameName;
    return payload;
  }

  /**
   * The record an inbox batch is written as, from an inject payload: the
   * editor's contract fields with null (not undefined — the Realtime Database
   * rejects undefined) where the picker had nothing to say.
   */
  function inboxBody(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    return {
      at: typeof p.at === "number" ? p.at : Date.now(),
      from: FROM,
      batchId: typeof p.batchId === "string" && p.batchId ? p.batchId : newBatchId(p.at),
      atlas: typeof p.atlas === "string" && p.atlas ? p.atlas : null,
      mode: p.mode === "replace" ? "replace" : "add",
      frameName: typeof p.frameName === "string" && p.frameName ? p.frameName : null,
      sprites: Array.isArray(p.sprites) ? p.sprites : [],
    };
  }

  const api = {
    CODE_ALPHABET,
    CODE_LENGTH,
    RTDB_URL,
    INBOX_ROOT,
    INBOX_MAX_BYTES,
    INBOX_MAX_LABEL,
    FROM,
    ATLAS_KEYS,
    EDITOR_URL_PATTERNS,
    EDITOR_PATHS,
    NO_TARGET_REASON,
    normalizePickerCode,
    formatPickerCode,
    isEditorPath,
    isEditorOrigin,
    isEditorUrl,
    inboxPath,
    inboxUrl,
    newBatchId,
    payloadBytes,
    inboxTooLarge,
    sanitizeSpriteName,
    atlasOptions,
    closestName,
    chooseTarget,
    frameOptions,
    describeTarget,
    buildInjectPayload,
    inboxBody,
  };

  globalThis.ShxPickerCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
