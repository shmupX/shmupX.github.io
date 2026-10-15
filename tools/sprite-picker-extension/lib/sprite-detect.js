/**
 * Sprite detection algorithms ported from spriteX/src/atlasManager.ts
 * Pure functions -- no external dependencies.
 */
(function () {
  "use strict";

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function colorDistance(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((x, y) => x - y);
    const idx = clamp(
      Math.floor((p / 100) * (sorted.length - 1)),
      0,
      sorted.length - 1
    );
    return sorted[idx];
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m
      ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
      : null;
  }

  function rgbToHex(rgb) {
    const to2 = (v) => clamp(v | 0, 0, 255).toString(16).padStart(2, "0");
    return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
  }

  /** Border sampling + dominant color (quantized) */
  function sampleBorderDominant(imageData, sampleStride) {
    if (sampleStride === undefined) sampleStride = 2;
    const { width, height, data } = imageData;
    const samples = [];
    const pick = (x, y) => {
      const i = (y * width + x) * 4;
      samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    };
    for (let x = 0; x < width; x += sampleStride) {
      pick(x, 0);
      pick(x, height - 1);
    }
    for (let y = 0; y < height; y += sampleStride) {
      pick(0, y);
      pick(width - 1, y);
    }
    if (!samples.length) return { dominant: null, distances: [] };

    const qKey = (c) =>
      `${(c.r >> 2) << 2},${(c.g >> 2) << 2},${(c.b >> 2) << 2}`;
    const counts = new Map();
    for (const s of samples) {
      const k = qKey(s);
      const v = counts.get(k);
      if (v) v.count++;
      else counts.set(k, { rgb: s, count: 1 });
    }

    let dominant = null;
    let best = -1;
    counts.forEach((v) => {
      if (v.count > best) {
        best = v.count;
        dominant = v.rgb;
      }
    });

    const distances = dominant
      ? samples.map((s) => colorDistance(s, dominant))
      : [];
    return { dominant, distances };
  }

  function computeAdaptiveTolerance(distances, min, max) {
    if (min === undefined) min = 6;
    if (max === undefined) max = 48;
    if (!distances.length) return 12;
    const p90 = percentile(distances, 90);
    const tol = Math.ceil(p90 + 2);
    return clamp(tol, min, max);
  }

  function keyOutBackground(imageData, bg, tolerance) {
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (colorDistance({ r, g, b }, bg) <= tolerance) {
        data[i + 3] = 0;
      }
    }
  }

  /** Flood-fill connected-component sprite detection */
  function detectSpritesFromImageData(imageData, opts) {
    opts = opts || {};
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    const alphaThreshold = opts.alphaThreshold != null ? opts.alphaThreshold : 1;
    const minArea = opts.minArea != null ? opts.minArea : 2;
    const use8Conn = !!opts.use8Conn;
    const nearTolerance = opts.tolerance != null ? opts.tolerance : 12;
    const userBg = opts.bgColor || null;

    let hasTransparency = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] <= alphaThreshold) {
        hasTransparency = true;
        break;
      }
    }

    let inferredBg = userBg;
    if (!inferredBg && !hasTransparency) {
      const s = sampleBorderDominant(imageData);
      inferredBg = s.dominant;
    }

    const pxCount = width * height;
    const visited = new Uint8Array(pxCount);
    const bgMark = new Uint8Array(pxCount);

    const neighbors = use8Conn
      ? [
          { dx: 1, dy: 0 },
          { dx: -1, dy: 0 },
          { dx: 0, dy: 1 },
          { dx: 0, dy: -1 },
          { dx: 1, dy: 1 },
          { dx: 1, dy: -1 },
          { dx: -1, dy: 1 },
          { dx: -1, dy: -1 },
        ]
      : [
          { dx: 1, dy: 0 },
          { dx: -1, dy: 0 },
          { dx: 0, dy: 1 },
          { dx: 0, dy: -1 },
        ];

    const getIdx = (x, y) => (y * width + x) * 4;
    const isTransparent = (a) => a <= alphaThreshold;
    const nearBg = (r, g, b) => {
      if (!inferredBg) return false;
      return colorDistance({ r, g, b }, inferredBg) <= nearTolerance;
    };

    const q = [];
    const pushIfBg = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const lin = y * width + x;
      if (bgMark[lin]) return;
      const i = getIdx(x, y);
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const isBg = isTransparent(a) || nearBg(r, g, b);
      if (isBg) {
        bgMark[lin] = 1;
        q.push({ x, y });
      }
    };

    for (let x = 0; x < width; x++) {
      pushIfBg(x, 0);
      pushIfBg(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      pushIfBg(0, y);
      pushIfBg(width - 1, y);
    }

    while (q.length) {
      const pt = q.pop();
      for (const nb of neighbors) {
        pushIfBg(pt.x + nb.dx, pt.y + nb.dy);
      }
    }

    const isSpritePixel = (x, y) => {
      const lin = y * width + x;
      if (bgMark[lin]) return false;
      const i = getIdx(x, y);
      const a = data[i + 3];
      if (isTransparent(a)) return false;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (inferredBg && nearBg(r, g, b)) return false;
      return true;
    };

    function floodFill(startX, startY) {
      const stack = [{ x: startX, y: startY }];
      let minX = startX,
        minY = startY,
        maxX = startX,
        maxY = startY,
        area = 0;

      visited[startY * width + startX] = 1;

      while (stack.length) {
        const pt = stack.pop();
        area++;
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;

        for (const nb of neighbors) {
          const nx = pt.x + nb.dx;
          const ny = pt.y + nb.dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const lin = ny * width + nx;
          if (visited[lin]) continue;
          if (isSpritePixel(nx, ny)) {
            visited[lin] = 1;
            stack.push({ x: nx, y: ny });
          }
        }
      }

      return {
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        area: area,
      };
    }

    const out = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const lin = y * width + x;
        if (visited[lin] || bgMark[lin]) continue;
        if (isSpritePixel(x, y)) {
          const box = floodFill(x, y);
          if ((box.area || 0) >= minArea) {
            delete box.area;
            out.push(box);
          }
        } else {
          visited[lin] = 1;
        }
      }
    }
    return out;
  }

  /** Auto bg detect, key-out, then detect on keyed result */
  function smartDetectSprites(ctx, width, height, explicitBg) {
    const imageData = ctx.getImageData(0, 0, width, height);

    let hasTransparency = false;
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] < 255) {
        hasTransparency = true;
        break;
      }
    }

    if (hasTransparency) {
      const sprites = detectSpritesFromImageData(imageData, {
        alphaThreshold: 1,
        minArea: 2,
        use8Conn: false,
      });
      return { sprites, bgColor: null, tolerance: 0, usedKeyOut: false };
    }

    const { dominant, distances } = sampleBorderDominant(imageData);
    const computedBg = explicitBg || dominant || null;
    const tolerance = computeAdaptiveTolerance(distances, 6, 48);

    const workData = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    let usedKeyOut = false;
    if (computedBg) {
      keyOutBackground(workData, computedBg, tolerance);
      usedKeyOut = true;
    }

    const sprites = detectSpritesFromImageData(workData, {
      bgColor: computedBg,
      tolerance,
      minArea: 2,
      use8Conn: false,
      alphaThreshold: 1,
    });

    return { sprites, bgColor: computedBg, tolerance, usedKeyOut };
  }

  /** Extract selected sprite regions as data URLs */
  function extractSpriteDataURLs(originalCanvas, boxes, opts) {
    opts = opts || {};
    const out = {};
    boxes.forEach((spr, idx) => {
      const c = document.createElement("canvas");
      c.width = spr.w;
      c.height = spr.h;
      const cctx = c.getContext("2d", { willReadFrequently: true });
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(
        originalCanvas,
        spr.x,
        spr.y,
        spr.w,
        spr.h,
        0,
        0,
        spr.w,
        spr.h
      );

      if (opts.bgColor) {
        const id = cctx.getImageData(0, 0, spr.w, spr.h);
        keyOutBackground(id, opts.bgColor, opts.tolerance || 12);
        cctx.putImageData(id, 0, 0);
      }

      out["sprite_" + idx] = c.toDataURL("image/png");
    });
    return out;
  }

  // Expose on window for content script access
  window.SpriteDetect = {
    smartDetectSprites,
    detectSpritesFromImageData,
    extractSpriteDataURLs,
    keyOutBackground,
    hexToRgb,
    rgbToHex,
    colorDistance,
  };
})();
