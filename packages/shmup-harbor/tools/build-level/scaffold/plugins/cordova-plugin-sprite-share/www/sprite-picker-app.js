/**
 * Sprite Picker App — Share edition (Android + iOS)
 *
 * Receives a shared image from SpriteShareActivity (Android/Kotlin) or
 * ShareViewController (iOS/Swift), runs sprite detection, lets user
 * select sprites, and saves them into a game atlas via the native bridge.
 *
 * Reuses:
 *  - SpriteDetect (sprite-detect.js) — verbatim from Chrome extension
 *  - Atlas repack algorithm — ported from level-editor.html
 */
(function () {
  "use strict";

  // ── Native Bridge (cross-platform) ──

  const NativeBridge = (function () {
    // Android: synchronous @JavascriptInterface, wrapped in Promises
    if (typeof Android !== "undefined") {
      return {
        getAtlasJson: (name) => Promise.resolve(Android.getAtlasJson(name)),
        getAtlasImageBase64: (name) => Promise.resolve(Android.getAtlasImageBase64(name)),
        saveAtlas: (name, png, json) => Promise.resolve(Android.saveAtlas(name, png, json)),
        hasRepackedAtlas: (name) => Promise.resolve(Android.hasRepackedAtlas(name)),
        close: () => { Android.closeActivity(); },
      };
    }

    // iOS: async WKScriptMessageHandler with callback pattern
    if (window.webkit && window.webkit.messageHandlers &&
        window.webkit.messageHandlers.spriteBridge) {
      let callId = 0;
      const pending = {};

      window._bridgeCallback = (id, result) => {
        if (pending[id]) {
          pending[id](result);
          delete pending[id];
        }
      };

      const call = (method, args) =>
        new Promise((resolve) => {
          const id = ++callId;
          pending[id] = resolve;
          window.webkit.messageHandlers.spriteBridge.postMessage({
            id: id, method: method, args: args || [],
          });
        });

      return {
        getAtlasJson: (name) => call("getAtlasJson", [name]),
        getAtlasImageBase64: (name) => call("getAtlasImageBase64", [name]),
        saveAtlas: (name, png, json) => call("saveAtlas", [name, png, json]),
        hasRepackedAtlas: (name) => call("hasRepackedAtlas", [name]),
        close: () => { call("close"); },
      };
    }

    return null;
  })();

  // ── State ──

  let sourceCanvas = null;     // offscreen canvas with the loaded image
  let overlayCanvas = null;
  let overlayCtx = null;
  let detected = [];           // array of { x, y, w, h }
  let selected = new Set();
  let detectionResult = null;  // { bgColor, tolerance, usedKeyOut }

  // Atlas state for replace mode
  let atlasData = null;        // parsed JSON
  let atlasImage = null;       // Image element

  // ── DOM refs ──

  const srcCanvas = document.getElementById("source-canvas");
  const ovrCanvas = document.getElementById("overlay-canvas");
  const thumbsStrip = document.getElementById("thumbs-strip");
  const thumbsEmpty = document.getElementById("thumbs-empty");
  const statusEl = document.getElementById("status");
  const atlasSelect = document.getElementById("atlas-select");
  const modeSelect = document.getElementById("mode-select");
  const frameRow = document.getElementById("frame-row");
  const frameSelect = document.getElementById("frame-select");
  const saveBtn = document.getElementById("save-btn");
  const selectAllBtn = document.getElementById("select-all-btn");
  const clearBtn = document.getElementById("clear-btn");
  const closeBtn = document.getElementById("close-btn");

  // ── Init ──

  closeBtn.addEventListener("click", () => {
    if (NativeBridge) NativeBridge.close();
  });

  modeSelect.addEventListener("change", () => {
    frameRow.style.display = modeSelect.value === "replace" ? "flex" : "none";
    if (modeSelect.value === "replace") loadFrameList();
  });

  atlasSelect.addEventListener("change", () => {
    if (modeSelect.value === "replace") loadFrameList();
  });

  saveBtn.addEventListener("click", saveToAtlas);
  selectAllBtn.addEventListener("click", () => {
    for (let i = 0; i < detected.length; i++) selected.add(i);
    drawOverlay();
    updateThumbs();
  });
  clearBtn.addEventListener("click", () => {
    selected.clear();
    drawOverlay();
    updateThumbs();
  });

  // Touch/click on overlay to toggle sprite selection
  ovrCanvas.addEventListener("click", onOverlayTap);
  // Also support touch for more responsive mobile feel
  let touchStartPos = null;
  ovrCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });
  ovrCanvas.addEventListener("touchend", (e) => {
    if (!touchStartPos || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartPos.x;
    const dy = t.clientY - touchStartPos.y;
    // Only treat as tap if finger didn't move much (not a scroll/pinch)
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      e.preventDefault();
      onOverlayTapAt(t.clientX, t.clientY);
    }
    touchStartPos = null;
  });

  // ── Entry point called from native (Kotlin/Swift) ──

  window.receiveSharedImage = async function (imageURL) {
    setStatus("loading", "Running sprite detection...");

    try {
      if (!imageURL) {
        setStatus("error", "No image data received.");
        return;
      }

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = imageURL;
      });

      let w = img.naturalWidth;
      let h = img.naturalHeight;

      // Scale down large images to prevent WebView OOM crashes
      const MAX_DIM = 1536;
      const MAX_PIXELS = 1250000;
      const dimScale = MAX_DIM / Math.max(w, h);
      const pixelScale = Math.sqrt(MAX_PIXELS / (w * h));
      const scale = Math.min(1, dimScale, pixelScale);
      if (scale < 1) {
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      // Draw to source canvas (possibly scaled)
      srcCanvas.width = w;
      srcCanvas.height = h;
      const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, w, h);
      sourceCanvas = srcCanvas;

      // Set up overlay canvas
      ovrCanvas.width = w;
      ovrCanvas.height = h;
      overlayCanvas = ovrCanvas;
      overlayCtx = ovrCanvas.getContext("2d");
      overlayCtx.imageSmoothingEnabled = false;

      // Sync displayed sizes so overlay aligns with source
      syncCanvasSizes();

      // Run detection
      const result = window.SpriteDetect.smartDetectSprites(ctx, w, h);
      detected = result.sprites;
      detectionResult = result;
      selected = new Set();

      if (detected.length === 0) {
        setStatus("info", "No sprites detected in this image.");
        return;
      }

      drawOverlay();
      updateThumbs();
      setStatus("info", "Detected " + detected.length + " sprites. Tap to select.");
    } catch (err) {
      setStatus("error", "Detection failed: " + err.message);
    }
  };

  // Keep overlay sized to match the source canvas's displayed size
  function syncCanvasSizes() {
    const wrap = document.getElementById("canvas-wrap");
    const displayW = srcCanvas.offsetWidth;
    const displayH = srcCanvas.offsetHeight;
    ovrCanvas.style.width = displayW + "px";
    ovrCanvas.style.height = displayH + "px";
  }

  // ── Overlay drawing ──

  function drawOverlay() {
    if (!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.lineWidth = 2;

    for (let i = 0; i < detected.length; i++) {
      const s = detected[i];
      overlayCtx.strokeStyle = selected.has(i)
        ? "rgba(0,200,0,0.9)"
        : "rgba(255,0,0,0.85)";
      overlayCtx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    }
  }

  // ── Overlay tap handling ──

  function onOverlayTap(ev) {
    onOverlayTapAt(ev.clientX, ev.clientY);
  }

  function onOverlayTapAt(clientX, clientY) {
    if (!overlayCanvas || !detected.length) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const x = Math.floor((clientX - rect.left) * scaleX);
    const y = Math.floor((clientY - rect.top) * scaleY);

    const idx = detected.findIndex(
      (s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
    );

    if (idx >= 0) {
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      drawOverlay();
      updateThumbs();
    }
  }

  // ── Thumbnails strip ──

  function updateThumbs() {
    thumbsStrip.innerHTML = "";
    saveBtn.disabled = selected.size === 0;

    if (!selected.size) {
      const span = document.createElement("span");
      span.id = "thumbs-empty";
      span.textContent = "No sprites selected";
      thumbsStrip.appendChild(span);
      return;
    }

    const sorted = [...selected].sort((a, b) => {
      const sa = detected[a];
      const sb = detected[b];
      if (sa.y !== sb.y) return sa.y - sb.y;
      return sa.x - sb.x;
    });

    sorted.forEach((i) => {
      const s = detected[i];
      const c = document.createElement("canvas");
      c.width = s.w;
      c.height = s.h;
      const cctx = c.getContext("2d");
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(sourceCanvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);

      const img = document.createElement("img");
      img.src = c.toDataURL("image/png");
      img.className = "sp-thumb selected";
      img.title = s.w + "x" + s.h + " @ (" + s.x + "," + s.y + ")";
      img.addEventListener("click", () => {
        selected.delete(i);
        drawOverlay();
        updateThumbs();
      });
      thumbsStrip.appendChild(img);
    });
  }

  // ── Frame list for replace mode ──

  async function loadFrameList() {
    frameSelect.innerHTML = '<option value="">-- Loading... --</option>';

    try {
      const atlasName = atlasSelect.value;
      const jsonStr = await NativeBridge.getAtlasJson(atlasName);
      const data = JSON.parse(jsonStr);
      const frames = Object.keys(data.frames || {});

      frameSelect.innerHTML = "";
      if (!frames.length) {
        frameSelect.innerHTML = '<option value="">-- No frames --</option>';
        return;
      }
      frames.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        frameSelect.appendChild(opt);
      });
    } catch (err) {
      frameSelect.innerHTML =
        '<option value="">-- Error: ' + err.message + " --</option>";
    }
  }

  // ── Save to atlas ──

  async function saveToAtlas() {
    if (!selected.size || !sourceCanvas) {
      setStatus("error", "No sprites selected");
      return;
    }

    const atlasName = atlasSelect.value;
    const mode = modeSelect.value;
    const frameName = mode === "replace" ? frameSelect.value : null;

    if (mode === "replace" && !frameName) {
      setStatus("error", "Select a frame to replace");
      return;
    }

    setStatus("loading", "Loading atlas...");

    try {
      // Load current atlas
      const jsonStr = await NativeBridge.getAtlasJson(atlasName);
      atlasData = JSON.parse(jsonStr);

      const imgDataUrl = await NativeBridge.getAtlasImageBase64(atlasName);
      if (imgDataUrl) {
        atlasImage = new Image();
        await new Promise((resolve, reject) => {
          atlasImage.onload = resolve;
          atlasImage.onerror = () => reject(new Error("Failed to load atlas image"));
          atlasImage.src = imgDataUrl;
        });
      } else {
        atlasImage = null;
      }

      setStatus("loading", "Extracting sprites...");

      // Extract selected sprites
      const selectedBoxes = [...selected]
        .sort((a, b) => {
          const sa = detected[a];
          const sb = detected[b];
          if (sa.y !== sb.y) return sa.y - sb.y;
          return sa.x - sb.x;
        })
        .map((i) => detected[i]);

      const opts =
        detectionResult && detectionResult.usedKeyOut
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

      // Build sprite entries
      const extraSprites = [];
      const replacedFrames = {};

      const entries = Object.entries(dataURLs);
      for (let idx = 0; idx < entries.length; idx++) {
        const [key, dataURL] = entries[idx];
        const box = selectedBoxes[idx];

        const img = new Image();
        await new Promise((r) => { img.onload = r; img.src = dataURL; });

        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        cv.getContext("2d").drawImage(img, 0, 0);

        if (mode === "replace" && frameName) {
          replacedFrames[frameName] = {
            key: frameName,
            canvas: cv,
            w: img.width,
            h: img.height,
          };
        } else {
          extraSprites.push({
            key: key + ".png",
            canvas: cv,
            w: img.width,
            h: img.height,
          });
        }
      }

      setStatus("loading", "Repacking atlas...");

      // Repack using the same algorithm as level-editor.html
      const result = buildAtlasWithReplacements(
        atlasData,
        atlasImage,
        replacedFrames,
        extraSprites
      );

      // Build final JSON
      const meta = atlasData.meta || {};
      const finalJson = {
        frames: result.frames,
        meta: {
          ...meta,
          image: "_" + atlasName + ".png",
          size: { w: result.canvas.width, h: result.canvas.height },
        },
      };

      setStatus("loading", "Saving atlas...");

      // Convert canvas to base64 PNG
      const pngBase64 = result.canvas.toDataURL("image/png");
      const jsonString = JSON.stringify(finalJson, null, 2);

      const ok = await NativeBridge.saveAtlas(atlasName, pngBase64, jsonString);

      if (ok) {
        setStatus("success", "Atlas saved! " + entries.length + " sprite(s) added.");
      } else {
        setStatus("error", "Failed to save atlas.");
      }
    } catch (err) {
      setStatus("error", "Save failed: " + err.message);
    }
  }

  // ── Atlas repack algorithm (ported from level-editor.html:1843-1877) ──

  function buildAtlasWithReplacements(
    atlasData,
    atlasImage,
    replacedFrames,
    extraSprites
  ) {
    const all = [];
    const frames = atlasData.frames || {};

    for (const k in frames) {
      const f = frames[k].frame;
      if (!f) continue;

      if (replacedFrames[k]) {
        all.push(replacedFrames[k]);
      } else {
        const fc = document.createElement("canvas");
        fc.width = f.w;
        fc.height = f.h;
        if (atlasImage) {
          fc.getContext("2d").drawImage(
            atlasImage,
            f.x,
            f.y,
            f.w,
            f.h,
            0,
            0,
            f.w,
            f.h
          );
        }
        all.push({ key: k, canvas: fc, w: f.w, h: f.h });
      }
    }

    all.push(...extraSprites);

    // Sort by height descending for better packing
    all.sort((a, b) => b.h - a.h);

    const MW = 2048;
    const P = 4;
    let cx = P,
      cy = P,
      rh = 0,
      fh = 0;
    const pos = {};

    all.forEach((s) => {
      if (cx + s.w + P > MW) {
        cy += rh + P;
        cx = P;
        rh = 0;
      }
      pos[s.key] = { x: cx, y: cy };
      cx += s.w + P;
      rh = Math.max(rh, s.h);
      fh = Math.max(fh, cy + s.h + P);
    });

    const canvas = document.createElement("canvas");
    canvas.width = MW;
    canvas.height = fh;
    const nc = canvas.getContext("2d");

    all.forEach((s) => {
      const p = pos[s.key];
      nc.drawImage(s.canvas, p.x, p.y);
    });

    const newFrames = {};
    all.forEach((s) => {
      const p = pos[s.key];
      newFrames[s.key] = {
        frame: { x: p.x, y: p.y, w: s.w, h: s.h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
        sourceSize: { w: s.w, h: s.h },
      };
    });

    return { canvas, frames: newFrames };
  }

  // ── Status display ──

  function setStatus(type, msg) {
    statusEl.className = "";
    if (type === "loading") {
      statusEl.innerHTML = '<span class="spinner"></span>' + msg;
    } else if (type === "error") {
      statusEl.className = "error";
      statusEl.textContent = msg;
    } else if (type === "success") {
      statusEl.className = "success";
      statusEl.textContent = msg;
    } else {
      statusEl.textContent = msg;
    }
  }

  // Resize overlay when window resizes
  window.addEventListener("resize", () => {
    if (sourceCanvas) syncCanvasSizes();
  });
})();
