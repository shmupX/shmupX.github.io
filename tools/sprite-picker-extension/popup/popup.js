/**
 * shmupX Sprite Picker - Popup Script
 * Shows where sends go (an editor tab, or the inbox under a PICKER CODE),
 * takes the code, and offers inject-on-any-site.
 */
(function () {
  "use strict";

  const Core = globalThis.ShxPickerCore;

  const statusEl = document.getElementById("shxStatus");
  const codeInput = document.getElementById("codeInput");
  const codeNote = document.getElementById("codeNote");
  const injectBtn = document.getElementById("injectBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const versionHint = document.getElementById("versionHint");

  const CODE_NOTE_DEFAULT = "SHOWN IN THE EDITOR'S ATLAS MANAGER";

  // What the last PING_EDITOR saw, so inject can refuse an editor tab the
  // URL alone does not reveal (the editor inside the dashboard's iframe).
  let lastEditorTabIds = new Set();

  try {
    const v = chrome.runtime.getManifest().version;
    if (v) versionHint.textContent = "V" + v;
  } catch (_) {
    // keep the static footer
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = "status " + (ok ? "connected" : "disconnected");
  }

  async function checkConnection() {
    setStatus("CHECKING…", false);
    try {
      const resp = await chrome.runtime.sendMessage({ type: "PING_EDITOR" });
      if (!resp) throw new Error("NO ANSWER FROM THE EXTENSION");
      if (resp.error) throw new Error(resp.error);
      lastEditorTabIds = new Set((resp.editorFrames || []).map((f) => f.tabId));
      const target = resp.target || Core.chooseTarget({
        editorFrames: resp.editorFrames,
        pickerCode: resp.pickerCode,
      });

      // A code the service worker learned from an editor frame shows up here
      // without the user typing it — unless they are typing right now.
      if (resp.pickerCode && document.activeElement !== codeInput) {
        renderCode(resp.pickerCode, { stored: true, source: resp.pickerCodeSource });
      }

      if (target.kind === "tab") {
        let atlas = null;
        try {
          const fr = await chrome.runtime.sendMessage({ type: "GET_ATLAS_FRAMES" });
          if (fr && !fr.error) atlas = fr.currentAtlas || fr.atlas || null;
        } catch (_) {
          // the atlas is decoration here
        }
        setStatus(
          `EDITOR ONLINE · TAB ${target.tabId}` + (atlas ? ` · ${atlas}` : ""),
          true,
        );
        return;
      }

      if (target.kind === "inbox") {
        setStatus(`NO EDITOR TAB · INBOX ${Core.formatPickerCode(target.code)}`, true);
        return;
      }

      const dashboards = Array.isArray(resp.dashboardTabs) ? resp.dashboardTabs.length : 0;
      setStatus(
        dashboards
          ? "NO TARGET — DASHBOARD OPEN: LAUNCH THE LEVEL EDITOR TILE, OR SET THE PICKER CODE"
          : Core.describeTarget(target),
        false,
      );
    } catch (err) {
      setStatus("ERROR: " + err.message, false);
    }
  }

  // ---------- Picker code ----------

  /**
   * Show a code: formatted live (ABCD-EFGH), green when valid, red when it
   * cannot be one. `stored` codes came from chrome.storage — typed earlier
   * (`source` "typed") or learned from an editor tab (`source` "editor").
   */
  function renderCode(raw, { stored = false, source = null } = {}) {
    const typed = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const code = Core.normalizePickerCode(typed);
    // Format live: ABCD-EFGH once there is more than half a code.
    codeInput.value = typed.length > 4
      ? typed.slice(0, 4) + "-" + typed.slice(4, 8)
      : typed;
    codeInput.classList.toggle("valid", !!code);
    codeInput.classList.toggle("invalid", !code && typed.length > 0);
    if (code) {
      if (stored && source === "editor") {
        codeNote.textContent = "LEARNED FROM THE EDITOR TAB · SENDS WITH NO EDITOR TAB GO TO THIS INBOX";
      } else if (stored) {
        codeNote.textContent = "SAVED · SENDS WITH NO EDITOR TAB GO TO THIS INBOX";
      } else {
        codeNote.textContent = "VALID · SAVED";
      }
      codeNote.className = "code-note";
    } else if (!typed.length) {
      codeNote.textContent = CODE_NOTE_DEFAULT;
      codeNote.className = "code-note";
    } else if (typed.length < Core.CODE_LENGTH) {
      codeNote.textContent = `${Core.CODE_LENGTH - typed.length} MORE…`;
      codeNote.className = "code-note";
    } else {
      codeNote.textContent = "INVALID CODE — 8 OF " + Core.CODE_ALPHABET;
      codeNote.className = "code-note invalid";
    }
    return code;
  }

  async function loadCode() {
    try {
      const stored = await chrome.storage.local.get(["pickerCode", "pickerCodeSource"]);
      renderCode(stored?.pickerCode || "", {
        stored: true,
        source: stored?.pickerCodeSource === "typed" ? "typed" : "editor",
      });
    } catch (_) {
      renderCode("");
    }
  }

  let recheckTimer = null;
  codeInput.addEventListener("input", async () => {
    const code = renderCode(codeInput.value);
    try {
      // A full valid code is stored as the user's own; anything else clears
      // it, so a stale code never routes sprites once they started changing it.
      if (code) await chrome.storage.local.set({ pickerCode: code, pickerCodeSource: "typed" });
      else await chrome.storage.local.remove(["pickerCode", "pickerCodeSource"]);
    } catch (err) {
      codeNote.textContent = "COULD NOT SAVE: " + err.message;
      codeNote.className = "code-note invalid";
    }
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(checkConnection, 250);
  });

  // ---------- Quick actions ----------

  /**
   * Inject the picker on the current tab (for sites the manifest does not
   * match). The service worker's image proxy is a plain fetch, so it also
   * asks for a lasting host permission on this tab's origin: without it the
   * proxy could only read this origin while the activeTab grant lasts.
   */
  injectBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if ((tab.url && Core.isEditorUrl(tab.url)) || lastEditorTabIds.has(tab.id)) {
      setStatus("THIS IS THE EDITOR — INJECT ON A SPRITE-SHEET TAB", false);
      return;
    }

    let originGranted = false;
    try {
      const origin = new URL(tab.url).origin;
      if (/^https?:$/.test(new URL(origin).protocol)) {
        originGranted = await chrome.permissions.request({ origins: [origin + "/*"] });
      }
    } catch (_) {
      // Declined or not requestable (chrome://, file://): the activeTab grant still covers this tab for now.
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/picker-core.js", "lib/sprite-detect.js", "content/content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content/content.css"],
      });
      setStatus(
        originGranted
          ? "PICKER INJECTED ON CURRENT TAB"
          : "PICKER INJECTED — IMAGES ON THIS SITE READABLE UNTIL YOU NAVIGATE",
        true,
      );
    } catch (err) {
      setStatus("INJECT FAILED: " + err.message, false);
    }
  });

  refreshBtn.addEventListener("click", checkConnection);

  loadCode();
  checkConnection();
})();
