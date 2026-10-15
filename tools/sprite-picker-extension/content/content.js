/**
 * shmupX Sprite Picker - Content Script
 * Injected on sprite resource sites. Provides:
 * 1. Pick mode toggle (⊕) to select sprite-sheet images for detection
 * 2. Overlay canvas with detected sprite bounding boxes
 * 3. A CRT-styled panel (the level editor's own look) to review picks and
 *    send them to the shmupX level editor's Atlas Manager — an open editor
 *    tab, or its inbox (background/service-worker.js → bridge / RTDB).
 *
 * The toggle, overlay and panel live in a CLOSED shadow root on a host
 * element, so the page the picker runs on cannot read the PICKER CODE out of
 * the panel or drive a send with synthetic clicks; every handler also
 * requires a trusted event. content.css is linked into the shadow tree (the
 * manifest copy in the document only styles the page's images); a shadow
 * tree cannot declare @font-face, so a tiny one is injected into the document.
 */
(function () {
  "use strict";

  // Guard against double-injection: the popup's "Inject picker on this tab"
  // action re-executes this script on pages where the manifest already ran
  // it, which stacked duplicate listeners/panels and broke the UI.
  if (window.__shxLoaded) return;
  window.__shxLoaded = true;

  const Core = globalThis.ShxPickerCore;

  let pickMode = false;
  let host = null; // the shadow host in the page's <body>
  let shadow = null; // its closed shadow root: toggle, overlay, panel
  let overlayContainer = null;
  let overlayCanvas = null;
  let overlayCtx = null;
  let sourceCanvas = null; // offscreen canvas with the loaded image
  let detected = [];
  let selected = new Set();
  let detectionResult = null; // { bgColor, tolerance, usedKeyOut }
  let panelEl = null;
  let toggleBtn = null;
  let targetImg = null;
  let processing = false;

  // Where sends go, and what the editor told us about its atlases.
  let target = null; // { kind: "tab", tabId, frameId } | { kind: "inbox", code } | { kind: "none", reason }
  let editorAtlas = null; // the editor's current atlas key (ATLAS_FRAMES_RESPONSE.currentAtlas)
  let knownAtlases = []; // ATLAS_FRAMES_RESPONSE.atlases; Core.ATLAS_KEYS until the editor says
  let framesByAtlas = {}; // atlas key → frame names, as the editor answered them
  let atlasTouched = false; // the user picked a TARGET ATLAS themselves
  let replaceWanted = false; // the user chose REPLACE FRAME (kept while the selection is not one sprite)
  let frameListToken = 0; // drops a late frame listing for an atlas no longer selected

  /** Only events the user caused run handlers; a page's synthetic events do not. */
  const trusted = (fn) => (ev) => {
    if (!ev || !ev.isTrusted) return;
    return fn(ev);
  };

  /** The mode a send really uses: REPLACE needs exactly one sprite. */
  function currentMode() {
    return replaceWanted && selected.size === 1 ? "replace" : "add";
  }

  // ==================== Messaging ====================

  /**
   * sendMessage that cannot wedge the picker: MV3 service workers can be
   * killed mid-request (the promise then never settles) and an extension
   * reload invalidates this content script's runtime. Both used to leave
   * `processing` stuck true, so pick mode looked active but clicks did
   * nothing. Timeout + explicit error text instead.
   */
  function sendMessageSafe(msg, timeoutMs = 20000, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(timeoutMessage || "EXTENSION NOT RESPONDING — TRY RELOADING THE PAGE"));
      }, timeoutMs);
      let p;
      try {
        p = chrome.runtime.sendMessage(msg);
      } catch (err) {
        clearTimeout(timer);
        done = true;
        reject(new Error("EXTENSION WAS RELOADED — REFRESH THIS PAGE"));
        return;
      }
      p.then(
        (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(resp);
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const m = String(err?.message || err);
          reject(
            /context invalidated/i.test(m)
              ? new Error("EXTENSION WAS RELOADED — REFRESH THIS PAGE")
              : err
          );
        }
      );
    });
  }

  // ==================== Shadow host ====================

  /** The document-level @font-face the shadow tree's text uses (a shadow tree cannot declare one). */
  function ensureFont() {
    if (document.getElementById("shx-font-face")) return;
    const style = document.createElement("style");
    style.id = "shx-font-face";
    style.textContent =
      '@font-face{font-family:"SHX Orbitron";src:url("' +
      chrome.runtime.getURL("fonts/Orbitron-Variable.woff2") +
      '") format("woff2");font-weight:400 900;font-style:normal;font-display:swap;}';
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * The closed shadow root everything renders in. The page may have
   * replaced/re-rendered <body> (lazy loads, pjax) and silently detached the
   * host; the shadow tree survives on it, so re-attach rather than rebuild.
   */
  function ensureHost() {
    ensureFont();
    if (host && host.isConnected) return shadow;
    if (!host) {
      host = document.createElement("div");
      // No box of its own: fixed/absolute children position as if they were
      // the body's, exactly as before the shadow root.
      host.style.setProperty("display", "contents", "important");
      shadow = host.attachShadow({ mode: "closed" });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("content/content.css");
      shadow.appendChild(link);
    }
    document.body.appendChild(host);
    return shadow;
  }

  // ==================== Toggle Button ====================

  function createToggleButton() {
    toggleBtn = document.createElement("button");
    toggleBtn.className = "shx-toggle-btn";
    toggleBtn.textContent = "⊕"; // crosshair circle
    toggleBtn.title = "shmupX Sprite Picker: Click to enter pick mode";
    toggleBtn.addEventListener("click", trusted(() => {
      pickMode = !pickMode;
      // Entering pick mode is a recovery point: never let a hung/failed prior
      // detection keep the click handler gated off.
      if (pickMode) processing = false;
      toggleBtn.classList.toggle("active", pickMode);
      toggleBtn.title = pickMode
        ? "shmupX Sprite Picker: Click an image to detect sprites"
        : "shmupX Sprite Picker: Click to enter pick mode";
      document.body.classList.toggle("shx-pick-mode", pickMode);
      if (!pickMode) clearHighlights();
    }));
    ensureHost().appendChild(toggleBtn);
  }

  // ==================== Image Hover Highlighting ====================

  let lastHovered = null;

  document.addEventListener(
    "mouseover",
    trusted((ev) => {
      if (!pickMode) return;
      const img = ev.target.closest("img");
      if (img && img.naturalWidth > 64 && img.naturalHeight > 64) {
        if (lastHovered && lastHovered !== img)
          lastHovered.classList.remove("shx-img-highlight");
        img.classList.add("shx-img-highlight");
        lastHovered = img;
      }
    }),
    true
  );

  document.addEventListener(
    "mouseout",
    trusted((ev) => {
      if (!pickMode) return;
      const img = ev.target.closest("img");
      if (img) img.classList.remove("shx-img-highlight");
    }),
    true
  );

  function clearHighlights() {
    document.querySelectorAll(".shx-img-highlight").forEach((el) => {
      el.classList.remove("shx-img-highlight");
    });
  }

  // ==================== Image Click -> Detection ====================

  document.addEventListener(
    "click",
    trusted((ev) => {
      ensureHost(); // the page may have re-rendered <body> under us
      if (!pickMode || processing) return;
      // Clicks inside the shadow tree surface here retargeted to the host,
      // which is not an <img>, so they fall through untouched.
      const img = ev.target.closest("img");
      if (!img || img.naturalWidth <= 64 || img.naturalHeight <= 64) return;

      ev.preventDefault();
      ev.stopPropagation();
      detectOnImage(img);
    }),
    true
  );

  // Listen for context menu "Detect Sprites in This Image"
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DETECT_IMAGE" && msg.srcUrl) {
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        if (img.src === msg.srcUrl || img.currentSrc === msg.srcUrl) {
          detectOnImage(img);
          return;
        }
      }
      // Image not found as <img> -- try fetching directly
      detectOnUrl(msg.srcUrl);
    }
  });

  async function detectOnImage(img) {
    processing = true;
    targetImg = img;
    clearOverlay();
    showPanel();
    setPanelStatus("loading", "FETCHING IMAGE…");

    try {
      // Use the service worker to fetch the image (bypasses CORS)
      const resp = await sendMessageSafe({
        type: "FETCH_IMAGE",
        url: img.src || img.currentSrc,
      });

      if (resp.error) throw new Error(resp.error);
      await runDetection(resp.dataURL, img);
    } catch (err) {
      setPanelStatus("error", "DETECTION FAILED: " + err.message);
    } finally {
      processing = false;
    }
  }

  async function detectOnUrl(url) {
    processing = true;
    targetImg = null;
    clearOverlay();
    showPanel();
    setPanelStatus("loading", "FETCHING IMAGE…");

    try {
      const resp = await sendMessageSafe({
        type: "FETCH_IMAGE",
        url: url,
      });
      if (resp.error) throw new Error(resp.error);
      await runDetection(resp.dataURL, null);
    } catch (err) {
      setPanelStatus("error", "DETECTION FAILED: " + err.message);
    } finally {
      processing = false;
    }
  }

  async function runDetection(dataURL, img) {
    setPanelStatus("loading", "DETECTING SPRITES…");

    // Load the image
    const loadedImg = new Image();
    loadedImg.src = dataURL;
    await new Promise((resolve, reject) => {
      loadedImg.onload = resolve;
      loadedImg.onerror = reject;
    });

    const w = loadedImg.naturalWidth;
    const h = loadedImg.naturalHeight;

    // Draw to offscreen canvas
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(loadedImg, 0, 0);

    // Run detection
    const result = window.SpriteDetect.smartDetectSprites(ctx, w, h);
    detected = result.sprites;
    detectionResult = result;
    selected = new Set();

    if (detected.length === 0) {
      setPanelStatus("info", "NO SPRITES DETECTED IN THIS IMAGE.");
      return;
    }

    // Create overlay on the image
    if (img) {
      createOverlay(img, w, h);
    }

    drawOverlay();
    updatePanel();
    setPanelStatus("info", `DETECTED ${detected.length} SPRITES · CLICK TO SELECT`);
  }

  // ==================== Overlay ====================

  function createOverlay(img, naturalW, naturalH) {
    clearOverlay();

    const rect = img.getBoundingClientRect();
    overlayContainer = document.createElement("div");
    overlayContainer.className = "shx-overlay-container";

    // Position overlay exactly over the image
    overlayContainer.style.left = rect.left + window.scrollX + "px";
    overlayContainer.style.top = rect.top + window.scrollY + "px";
    overlayContainer.style.width = rect.width + "px";
    overlayContainer.style.height = rect.height + "px";

    overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = naturalW;
    overlayCanvas.height = naturalH;
    overlayCanvas.style.width = rect.width + "px";
    overlayCanvas.style.height = rect.height + "px";
    overlayCtx = overlayCanvas.getContext("2d");
    overlayCtx.imageSmoothingEnabled = false;

    overlayCanvas.addEventListener("click", trusted(onOverlayClick));

    overlayContainer.appendChild(overlayCanvas);
    ensureHost().appendChild(overlayContainer);

    // Reposition on scroll/resize
    const reposition = () => {
      if (!overlayContainer || !img.isConnected) return;
      const r = img.getBoundingClientRect();
      overlayContainer.style.left = r.left + window.scrollX + "px";
      overlayContainer.style.top = r.top + window.scrollY + "px";
      overlayContainer.style.width = r.width + "px";
      overlayContainer.style.height = r.height + "px";
      overlayCanvas.style.width = r.width + "px";
      overlayCanvas.style.height = r.height + "px";
    };
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition, { passive: true });
    overlayContainer._cleanup = () => {
      window.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }

  function clearOverlay() {
    if (overlayContainer) {
      if (overlayContainer._cleanup) overlayContainer._cleanup();
      overlayContainer.remove();
      overlayContainer = null;
      overlayCanvas = null;
      overlayCtx = null;
    }
  }

  function onOverlayClick(ev) {
    if (!overlayCanvas || !detected.length) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const x = Math.floor((ev.clientX - rect.left) * scaleX);
    const y = Math.floor((ev.clientY - rect.top) * scaleY);

    const idx = detected.findIndex(
      (s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
    );

    if (idx >= 0) {
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      drawOverlay();
      updatePanel();
    } else if (pickMode && targetImg && !processing) {
      // The overlay covers the image, so in pick mode a click that misses
      // every sprite would otherwise be swallowed — re-detect instead.
      detectOnImage(targetImg);
    }
  }

  function drawOverlay() {
    if (!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.lineWidth = 1;

    // The editor's palette: lime for detected, glossy yellow for selected.
    for (let i = 0; i < detected.length; i++) {
      const s = detected[i];
      overlayCtx.strokeStyle = selected.has(i)
        ? "rgba(246, 255, 74, 0.95)"
        : "rgba(156, 255, 107, 0.75)";
      overlayCtx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    }
  }

  // ==================== Selection Panel ====================

  function showPanel() {
    // A stale panel reference whose host left the DOM used to block the UI
    // from ever showing again; ensureHost re-attaches the host (and with it
    // the panel), so only a panel that was really removed is rebuilt.
    ensureHost();
    if (panelEl && !panelEl.isConnected) {
      panelEl = null;
    }
    if (panelEl) return;
    panelEl = document.createElement("div");
    panelEl.className = "shx-panel";
    panelEl.innerHTML = `
      <div class="shx-hd">
        <span class="shx-title">SHMUPX SPRITE PICKER</span>
        <button class="shx-x" title="Close">✕</button>
      </div>
      <div class="shx-body">
        <div class="shx-sect">TARGET</div>
        <div class="shx-target-row">
          <span class="shx-target">CHECKING…</span>
          <button class="shx-refresh-btn" title="Recheck where sends go">↻</button>
        </div>
        <div class="shx-sect">SELECTED SPRITES</div>
        <div class="shx-thumbs"></div>
        <div class="shx-sect">TARGET ATLAS</div>
        <select class="shx-select shx-atlas-select"></select>
        <div class="shx-sect">MODE</div>
        <div class="shx-row-btns shx-mode-row">
          <button class="shx-btn shx-mode-btn active" data-mode="add">ADD</button>
          <button class="shx-btn shx-mode-btn" data-mode="replace">REPLACE FRAME</button>
        </div>
        <div class="shx-hint shx-mode-hint"></div>
        <div class="shx-replace-wrap" hidden>
          <div class="shx-sect">FRAME TO REPLACE</div>
          <input class="shx-input shx-frame-input" type="text" list="shx-frames-list"
                 placeholder="FRAME NAME" spellcheck="false" autocomplete="off" />
          <datalist id="shx-frames-list"></datalist>
          <div class="shx-hint shx-frames-hint"></div>
        </div>
        <div class="shx-sect">SPRITE NAME</div>
        <input class="shx-input shx-name-input" type="text" value="sprite" spellcheck="false" />
        <button class="shx-send-btn">SEND TO SHMUPX</button>
        <div class="shx-row-btns">
          <button class="shx-btn shx-select-all-btn">ALL</button>
          <button class="shx-btn shx-clear-btn">CLEAR</button>
        </div>
        <div class="shx-status"></div>
      </div>
      <div class="shx-foot">
        <span><b>⊕</b> PICK</span>
        <span><b>CLICK</b> SELECT</span>
        <span class="shx-foot-hint">SEND → ATLAS MANAGER</span>
      </div>
    `;

    panelEl.querySelector(".shx-x").addEventListener("click", trusted(() => {
      closeAll();
    }));

    panelEl.querySelector(".shx-send-btn").addEventListener("click", trusted(sendToShmupX));
    panelEl.querySelector(".shx-select-all-btn").addEventListener("click", trusted(() => {
      for (let i = 0; i < detected.length; i++) selected.add(i);
      drawOverlay();
      updatePanel();
    }));
    panelEl.querySelector(".shx-clear-btn").addEventListener("click", trusted(() => {
      selected.clear();
      drawOverlay();
      updatePanel();
    }));
    panelEl.querySelector(".shx-refresh-btn").addEventListener("click", trusted(() => {
      refreshTarget();
    }));
    panelEl.querySelectorAll(".shx-mode-btn").forEach((btn) => {
      btn.addEventListener("click", trusted(() => {
        replaceWanted = btn.dataset.mode === "replace";
        updateModeButtons();
      }));
    });
    panelEl.querySelector(".shx-atlas-select").addEventListener("change", trusted(() => {
      atlasTouched = true;
      updateFrameList();
    }));

    ensureHost().appendChild(panelEl);
    fillAtlasSelect();
    updateModeButtons();
    refreshTarget();
  }

  function closeAll() {
    clearOverlay();
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    detected = [];
    selected.clear();
    sourceCanvas = null;
    pickMode = false;
    if (toggleBtn) toggleBtn.classList.remove("active");
    document.body.classList.remove("shx-pick-mode");
  }

  function sortedSelection() {
    return [...selected].sort((a, b) => {
      const sa = detected[a];
      const sb = detected[b];
      if (sa.y !== sb.y) return sa.y - sb.y;
      return sa.x - sb.x;
    });
  }

  function updatePanel() {
    if (!panelEl) return;
    const thumbsContainer = panelEl.querySelector(".shx-thumbs");
    thumbsContainer.innerHTML = "";

    updateModeButtons();

    if (!selected.size) {
      thumbsContainer.innerHTML =
        '<span class="shx-empty">NO SPRITES SELECTED</span>';
      return;
    }

    sortedSelection().forEach((i) => {
      const s = detected[i];
      const c = document.createElement("canvas");
      c.width = s.w;
      c.height = s.h;
      const cctx = c.getContext("2d");
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(sourceCanvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);

      const img = document.createElement("img");
      img.src = c.toDataURL("image/png");
      img.className = "shx-thumb";
      img.style.width = Math.min(64, s.w * 2) + "px";
      img.style.height = "auto";
      img.title = `${s.w}x${s.h} @ (${s.x},${s.y}) — click to remove`;
      img.addEventListener("click", trusted(() => {
        selected.delete(i);
        drawOverlay();
        updatePanel();
      }));
      thumbsContainer.appendChild(img);
    });
  }

  function setPanelStatus(type, msg) {
    if (!panelEl) return;
    const el = panelEl.querySelector(".shx-status");
    if (type === "loading") {
      el.innerHTML = `<span class="shx-spinner"></span>${escapeHtml(msg)}`;
    } else if (type === "error") {
      el.innerHTML = `<span class="shx-err">${escapeHtml(msg)}</span>`;
    } else {
      el.textContent = msg;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ==================== Target / atlas / mode ====================

  function setTargetLine(text, kind) {
    if (!panelEl) return;
    const el = panelEl.querySelector(".shx-target");
    el.textContent = text;
    el.classList.toggle("shx-target-ok", kind === "tab" || kind === "inbox");
    el.classList.toggle("shx-target-none", kind === "none");
  }

  /** Ask the service worker where sends go, then the editor which atlas it is on and what it holds. */
  async function refreshTarget() {
    if (!panelEl) return;
    setTargetLine("CHECKING…", null);
    try {
      const resp = await sendMessageSafe({ type: "PING_EDITOR" }, 6000);
      if (resp?.error) throw new Error(resp.error);
      target = resp?.target || Core.chooseTarget({
        editorFrames: resp?.editorFrames,
        pickerCode: resp?.pickerCode,
      });
    } catch (err) {
      target = { kind: "none", reason: err.message };
    }
    setTargetLine(Core.describeTarget(target), target.kind);

    // What we knew about the editor's atlases may be from another editor.
    editorAtlas = null;
    framesByAtlas = {};
    if (target.kind === "tab") {
      await fetchFrames(null);
    }
    fillAtlasSelect();
  }

  /**
   * Ask the editor for one atlas's frames (`atlasKey`, or its current one
   * when null) and remember them. Also learns the editor's current atlas and
   * its list of atlases. Resolves with the atlas key answered, or null.
   */
  async function fetchFrames(atlasKey) {
    try {
      const msg = { type: "GET_ATLAS_FRAMES" };
      if (atlasKey) msg.atlas = atlasKey;
      const resp = await sendMessageSafe(msg, 6000);
      if (!resp || resp.error || resp.inbox) return null;
      if (typeof resp.currentAtlas === "string" && resp.currentAtlas) {
        editorAtlas = resp.currentAtlas;
      } else if (!atlasKey && typeof resp.atlas === "string" && resp.atlas) {
        editorAtlas = resp.atlas; // an editor that only answers for its current atlas
      }
      if (Array.isArray(resp.atlases) && resp.atlases.length) knownAtlases = resp.atlases;
      const answered = (typeof resp.atlas === "string" && resp.atlas) || (atlasKey ? null : editorAtlas);
      if (answered) framesByAtlas[answered] = Array.isArray(resp.frames) ? resp.frames : [];
      return answered;
    } catch (_) {
      return null; // the frame list is a convenience; the send still works without it
    }
  }

  /**
   * The TARGET ATLAS list: the editor's current atlas first (and selected,
   * until the user picks one themselves), then the atlases the editor
   * reported. When the editor's current atlas is unknown — no editor tab, or
   * the first answer still in flight — the first entry is "EDITOR'S CURRENT"
   * (value ""), and a send then names no atlas so the editor keeps its own.
   */
  function fillAtlasSelect() {
    if (!panelEl) return;
    const sel = panelEl.querySelector(".shx-atlas-select");
    const previous = atlasTouched ? sel.value : null;
    sel.innerHTML = "";
    const add = (value, label) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    };
    if (!editorAtlas) add("", "EDITOR'S CURRENT");
    Core.atlasOptions(editorAtlas, knownAtlases).forEach((key) => {
      add(key, key === editorAtlas ? `${key.toUpperCase()} · CURRENT` : key.toUpperCase());
    });
    const values = [...sel.options].map((o) => o.value);
    if (previous !== null && values.includes(previous)) sel.value = previous;
    else sel.value = editorAtlas || "";
    updateFrameList();
  }

  /** The atlas a REPLACE would hit: the chosen one, or the editor's current. */
  function replaceAtlasKey() {
    if (!panelEl) return editorAtlas;
    return panelEl.querySelector(".shx-atlas-select").value || editorAtlas || null;
  }

  /**
   * The REPLACE datalist for the chosen atlas. The editor answers
   * GET_ATLAS_FRAMES for any atlas it knows without switching, so an atlas
   * not yet listed is fetched on demand and cached in framesByAtlas.
   */
  function updateFrameList() {
    if (!panelEl) return;
    const list = panelEl.querySelector("#shx-frames-list");
    const hint = panelEl.querySelector(".shx-frames-hint");
    const key = replaceAtlasKey();
    const token = ++frameListToken;

    const show = (frames) => {
      list.innerHTML = "";
      frames.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        list.appendChild(opt);
      });
      hint.textContent = `${frames.length} FRAME${frames.length === 1 ? "" : "S"} IN ${key.toUpperCase()}`;
    };

    if (target?.kind !== "tab") {
      list.innerHTML = "";
      hint.textContent = "NO EDITOR TAB — FRAME NAMES CANNOT BE CHECKED";
      return;
    }
    if (!key) {
      list.innerHTML = "";
      hint.textContent = "TYPE THE FRAME NAME";
      return;
    }
    if (Array.isArray(framesByAtlas[key])) {
      show(framesByAtlas[key]);
      return;
    }
    list.innerHTML = "";
    hint.textContent = `LOADING FRAMES OF ${key.toUpperCase()}…`;
    fetchFrames(key).then((answered) => {
      if (token !== frameListToken) return; // the user moved on
      if (answered && Array.isArray(framesByAtlas[answered]) && answered === replaceAtlasKey()) {
        show(framesByAtlas[answered]);
      } else {
        hint.textContent = `FRAMES OF ${key.toUpperCase()} UNAVAILABLE — TYPE THE NAME`;
      }
    });
  }

  /**
   * REPLACE FRAME is remembered as the user's wish and only applies while
   * exactly one sprite is selected; with another count the send is an ADD,
   * the panel says so, and REPLACE comes back when the count returns to one.
   */
  function updateModeButtons() {
    if (!panelEl) return;
    const canReplace = selected.size === 1;
    const mode = currentMode();
    panelEl.querySelectorAll(".shx-mode-btn").forEach((btn) => {
      const isReplace = btn.dataset.mode === "replace";
      btn.classList.toggle("active", isReplace ? replaceWanted : !replaceWanted);
      btn.disabled = isReplace && !canReplace;
      btn.title = isReplace && !canReplace
        ? "Select exactly one sprite to replace a frame"
        : "";
    });
    panelEl.querySelector(".shx-replace-wrap").hidden = !replaceWanted;
    panelEl.querySelector(".shx-mode-hint").textContent =
      replaceWanted && !canReplace ? "REPLACE NEEDS ONE SPRITE — SENDING AS ADD" : "";
    panelEl.querySelector(".shx-send-btn").textContent =
      mode === "replace" ? "REPLACE IN SHMUPX" : "SEND TO SHMUPX";
  }

  // ==================== Send to shmupX ====================

  async function sendToShmupX() {
    if (!selected.size || !sourceCanvas) {
      setPanelStatus("error", "NO SPRITES SELECTED");
      return;
    }

    const base = Core.sanitizeSpriteName(panelEl.querySelector(".shx-name-input").value);
    // "" is EDITOR'S CURRENT: name no atlas and the editor keeps its own.
    const atlas = panelEl.querySelector(".shx-atlas-select").value || undefined;
    const mode = currentMode();
    const frameName = mode === "replace"
      ? panelEl.querySelector(".shx-frame-input").value.trim()
      : undefined;

    if (mode === "replace") {
      if (!frameName) {
        setPanelStatus("error", "NAME THE FRAME TO REPLACE");
        return;
      }
      // When the editor told us what the atlas holds, a name it does not
      // have is refused here rather than reported as a success twice.
      const key = replaceAtlasKey();
      const frames = key ? framesByAtlas[key] : null;
      if (Array.isArray(frames) && !frames.includes(frameName)) {
        const near = Core.closestName(frameName, frames);
        setPanelStatus(
          "error",
          `NO FRAME "${frameName}" IN ${(key || "THE ATLAS").toUpperCase()}` +
            (near ? ` — DID YOU MEAN "${near}"?` : ""),
        );
        return;
      }
    }

    const isInbox = target?.kind === "inbox";
    setPanelStatus("loading", isInbox ? "SENDING TO THE INBOX…" : "SENDING TO SHMUPX…");

    // Extract selected sprites as data URLs (reading order: top-left first)
    const selectedBoxes = sortedSelection().map((i) => detected[i]);

    const opts = detectionResult?.usedKeyOut
      ? {
          bgColor: detectionResult.bgColor,
          tolerance: detectionResult.tolerance,
        }
      : {};

    const dataURLs = window.SpriteDetect.extractSpriteDataURLs(
      sourceCanvas,
      selectedBoxes,
      opts
    );

    const sprites = Object.values(dataURLs).map((dataURL, idx) => ({
      name: `${base}_${idx}`,
      dataURL: dataURL,
      w: selectedBoxes[idx].w,
      h: selectedBoxes[idx].h,
    }));

    try {
      // An inbox write can be slow on a poor link; a timeout there must not
      // read as an extension fault and invite a duplicate send.
      const resp = await sendMessageSafe(
        { type: "SEND_SPRITES", sprites, atlas, mode, frameName },
        isInbox ? 90000 : 30000,
        isInbox ? "STILL SENDING — CHECK THE EDITOR BEFORE SENDING AGAIN" : undefined,
      );

      if (!resp) throw new Error("NO ANSWER FROM THE EXTENSION");
      if (resp.error) throw new Error(resp.error);
      if (resp.target) {
        target = resp.target;
        setTargetLine(Core.describeTarget(target), target.kind);
      }
      setPanelStatus(
        "info",
        resp.message ||
          `SENT ${sprites.length} SPRITE${sprites.length === 1 ? "" : "S"} → ${Core.describeTarget(target)}`
      );
    } catch (err) {
      setPanelStatus("error", "SEND FAILED: " + err.message);
      refreshTarget(); // the editor may have gone away — say where the next send goes
    }
  }

  // ==================== Init ====================

  createToggleButton();
})();
