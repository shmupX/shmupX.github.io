/* Pixel Composer — sprite-frame voxelizer engine + postMessage service bridge.
 *
 * Turns 2D pixel-art frames into "voxelized" versions: each opaque pixel
 * becomes a shaded 3D cube column, rendered from an orbitable camera into a
 * PNG (optionally a MagicaVoxel .vox model too). Dependency-free; everything
 * runs on 2D canvas so it works offline inside any CMG app.
 *
 * Two ways to consume it:
 *   1. In-process:  PixelComposerEngine.voxelizeFrames(frames, options)
 *      (SpriteX ships this file in its zip and calls it directly.)
 *   2. postMessage: embed /pixel-composer/ in an iframe and speak the
 *      pixel-composer-* protocol (see installBridge below). pc-client.js
 *      wraps both transports for requesters.
 *
 * Protocol (mirrors the launcher's spritex-preload bridge idiom):
 *   requester → composer:
 *     { type: 'pixel-composer-voxelize', requestId, frames: [{name, dataURL}], options }
 *   composer → requester:
 *     { type: 'pixel-composer-ready' }                       on bridge install
 *     { type: 'pixel-composer-voxelize-ack', requestId }     request received
 *     { type: 'pixel-composer-voxelize-result', requestId, ok,
 *       frames: [{name, dataURL, w, h, views?, vox?}], errors, error? }
 *
 * Trust posture: same as the other cmg-* bridges — requests are accepted from
 * any origin and replies target e.source with '*', because the payload is the
 * user's own sprite images and the transform is pure (no storage, no secrets).
 * Every request is sanitized: type/dataURL checks, frame-count/byte caps,
 * option clamping, per-frame dimension caps.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    mode: 'extrude',      // 'extrude' (uniform depth) | 'heightmap' (luminance → depth)
    depth: 6,             // voxels of extrusion (1..32)
    pixelSize: 4,         // rendered edge length of one voxel, in px (1..12)
    yaw: 30,              // camera azimuth, degrees
    pitch: 30,            // camera elevation, degrees (0..80)
    turntable: 0,         // 0 = single view, else N evenly spaced yaw views (2..16)
    outline: false,       // 1px dark silhouette outline
    alphaThreshold: 8,    // source alpha below this = empty (1..255)
    vox: false            // also emit a MagicaVoxel .vox model (base64)
  };

  var MAX_FRAMES = 64;
  var MAX_REQUEST_BYTES = 24 * 1024 * 1024; // matches the launcher's sprite-picker cap
  var MAX_DIM = 128;                        // per-frame source pixels per side
  var MAX_RENDER_VOXELS = 1 << 22;          // w*h*depth*views ceiling per frame
                                            // (allows 128x128x32 up to 8 views)
  var DATA_URL_RE = /^data:image\/(png|webp|gif|jpe?g);base64,/;

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function sanitizeOptions(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    return {
      mode: o.mode === 'heightmap' ? 'heightmap' : 'extrude',
      depth: Math.round(clamp(o.depth == null ? DEFAULTS.depth : o.depth, 1, 32)),
      pixelSize: Math.round(clamp(o.pixelSize == null ? DEFAULTS.pixelSize : o.pixelSize, 1, 12)),
      yaw: clamp(o.yaw == null ? DEFAULTS.yaw : o.yaw, -360, 360),
      pitch: clamp(o.pitch == null ? DEFAULTS.pitch : o.pitch, 0, 80),
      turntable: o.turntable ? Math.round(clamp(o.turntable, 2, 16)) : 0,
      outline: !!o.outline,
      alphaThreshold: Math.round(clamp(o.alphaThreshold == null ? DEFAULTS.alphaThreshold : o.alphaThreshold, 1, 255)),
      vox: !!o.vox
    };
  }

  function loadImage(dataURL) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image decode failed')); };
      img.src = dataURL;
    });
  }

  function imageDataFrom(img) {
    var cv = document.createElement('canvas');
    cv.width = img.naturalWidth || img.width;
    cv.height = img.naturalHeight || img.height;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, cv.width, cv.height);
  }

  /* Column model: one height per source pixel (0 = empty). A voxel exists at
   * (x, y, z) when z < height[y*w+x]; its color is the source pixel's. */
  function buildGrid(imageData, opts) {
    var w = imageData.width, h = imageData.height;
    var src = imageData.data;
    var heights = new Uint8Array(w * h);
    var colors = new Uint32Array(w * h); // 0xAABBGGRR (little-endian RGBA)
    var maxH = 0;
    for (var i = 0; i < w * h; i++) {
      var a = src[i * 4 + 3];
      if (a < opts.alphaThreshold) continue;
      var r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
      var d;
      if (opts.mode === 'heightmap') {
        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        d = 1 + Math.round((lum / 255) * (opts.depth - 1));
      } else {
        d = opts.depth;
      }
      heights[i] = d;
      if (d > maxH) maxH = d;
      colors[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
    return { w: w, h: h, d: maxH, heights: heights, colors: colors };
  }

  function filled(grid, x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= grid.w || y >= grid.h) return false;
    return z < grid.heights[y * grid.w + x];
  }

  /* World space: X right, Y up, Z toward the default camera. Image row gy
   * maps to world Y = (h - 1 - gy). Orthographic camera at azimuth yaw /
   * elevation pitch; fixed world light so turntable views shade coherently. */
  function renderView(grid, opts, yawDeg) {
    var t = yawDeg * Math.PI / 180;
    var p = opts.pitch * Math.PI / 180;
    var cosT = Math.cos(t), sinT = Math.sin(t);
    var cosP = Math.cos(p), sinP = Math.sin(p);
    var u = opts.pixelSize;

    // View basis (orthographic)
    var cam = [sinT * cosP, sinP, cosT * cosP];       // scene → camera
    var right = [cosT, 0, -sinT];
    var up = [-sinT * sinP, cosP, -cosT * sinP];

    function sx(x, y, z) { return (x * right[0] + y * right[1] + z * right[2]) * u; }
    function sy(x, y, z) { return -(x * up[0] + y * up[1] + z * up[2]) * u; }
    function depthOf(x, y, z) { return x * cam[0] + y * cam[1] + z * cam[2]; }

    // Canvas bounds from the 8 corners of the whole grid box
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var ci = 0; ci < 8; ci++) {
      var cx = (ci & 1) ? grid.w : 0;
      var cy = (ci & 2) ? grid.h : 0;
      var cz = (ci & 4) ? grid.d : 0;
      var px = sx(cx, cy, cz), py = sy(cx, cy, cz);
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    var pad = 2;
    var cw = Math.max(1, Math.ceil(maxX - minX) + pad * 2);
    var ch = Math.max(1, Math.ceil(maxY - minY) + pad * 2);
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.translate(pad - minX, pad - minY);

    // Fixed light, upper-front-left
    var L = [-0.45, 0.78, 0.44];
    function shade(color, nx, ny, nz) {
      var dot = nx * L[0] + ny * L[1] + nz * L[2];
      var f = 0.58 + 0.52 * Math.max(0, dot);
      var r = Math.min(255, ((color) & 255) * f) | 0;
      var g = Math.min(255, ((color >> 8) & 255) * f) | 0;
      var b = Math.min(255, ((color >> 16) & 255) * f) | 0;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    // Faces: n = world normal, d = neighbor delta in grid coords (gy is the
    // flipped world Y), c = 4 corner offsets from the voxel's world origin.
    var FACES = [
      { n: [1, 0, 0],  d: [1, 0, 0],  c: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
      { n: [-1, 0, 0], d: [-1, 0, 0], c: [[0,0,0],[0,1,0],[0,1,1],[0,0,1]] },
      { n: [0, 1, 0],  d: [0, -1, 0], c: [[0,1,0],[1,1,0],[1,1,1],[0,1,1]] },
      { n: [0, -1, 0], d: [0, 1, 0],  c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
      { n: [0, 0, 1],  d: [0, 0, 1],  c: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
      { n: [0, 0, -1], d: [0, 0, -1], c: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]] }
    ];
    var visible = FACES.filter(function (f) {
      return f.n[0] * cam[0] + f.n[1] * cam[1] + f.n[2] * cam[2] > 0.0001;
    });

    // Collect surface voxels back-to-front (painter over center depth)
    var vox = [];
    for (var gy = 0; gy < grid.h; gy++) {
      for (var gx = 0; gx < grid.w; gx++) {
        var hgt = grid.heights[gy * grid.w + gx];
        if (!hgt) continue;
        for (var gz = 0; gz < hgt; gz++) {
          // interior cells (all 6 neighbors filled) can't show a face
          if (filled(grid, gx + 1, gy, gz) && filled(grid, gx - 1, gy, gz) &&
              filled(grid, gx, gy + 1, gz) && filled(grid, gx, gy - 1, gz) &&
              filled(grid, gx, gy, gz + 1) && filled(grid, gx, gy, gz - 1)) continue;
          var wy = grid.h - 1 - gy;
          vox.push({ gx: gx, gy: gy, gz: gz, wy: wy, k: depthOf(gx + 0.5, wy + 0.5, gz + 0.5) });
        }
      }
    }
    vox.sort(function (a, b) { return a.k - b.k; });

    ctx.lineWidth = 0.8;
    ctx.lineJoin = 'round';
    for (var vi = 0; vi < vox.length; vi++) {
      var v = vox[vi];
      var color = grid.colors[v.gy * grid.w + v.gx];
      for (var fi = 0; fi < visible.length; fi++) {
        var f = visible[fi];
        // f.d is already the grid-space neighbor delta (the table pre-flips world Y)
        if (filled(grid, v.gx + f.d[0], v.gy + f.d[1], v.gz + f.d[2])) continue;
        var fill = shade(color, f.n[0], f.n[1], f.n[2]);
        ctx.fillStyle = fill;
        ctx.strokeStyle = fill; // stroke seals AA seams between quads
        ctx.beginPath();
        for (var pi = 0; pi < 4; pi++) {
          var c = f.c[pi];
          var wx2 = v.gx + c[0], wy2 = v.wy + c[1], wz2 = v.gz + c[2];
          var px2 = sx(wx2, wy2, wz2), py2 = sy(wx2, wy2, wz2);
          if (pi === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    if (opts.outline) applyOutline(cv);
    return cv;
  }

  /* 1px "sticker" outline: transparent pixels bordering opaque ones get a
   * darkened copy of the neighbor color. */
  function applyOutline(cv) {
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    var im = ctx.getImageData(0, 0, cv.width, cv.height);
    var d = im.data, w = cv.width, h = cv.height;
    var out = new Uint8ClampedArray(d);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (d[i + 3] > 40) continue;
        var ni = -1;
        if (x > 0 && d[i - 4 + 3] > 40) ni = i - 4;
        else if (x < w - 1 && d[i + 4 + 3] > 40) ni = i + 4;
        else if (y > 0 && d[i - w * 4 + 3] > 40) ni = i - w * 4;
        else if (y < h - 1 && d[i + w * 4 + 3] > 40) ni = i + w * 4;
        if (ni >= 0) {
          out[i] = d[ni] * 0.25;
          out[i + 1] = d[ni + 1] * 0.25;
          out[i + 2] = d[ni + 2] * 0.25;
          out[i + 3] = 255;
        }
      }
    }
    im.data.set(out);
    ctx.putImageData(im, 0, 0);
  }

  /* MagicaVoxel .vox (version 150): MAIN > SIZE + XYZI + RGBA.
   * Mapping: vox X = image x, vox Y = extrusion z, vox Z (up) = h-1-image y. */
  function buildVoxFile(grid) {
    var palette = [];          // up to 255 0xAABBGGRR entries
    var palIndex = {};         // color → 1-based index
    var voxels = [];
    for (var gy = 0; gy < grid.h; gy++) {
      for (var gx = 0; gx < grid.w; gx++) {
        var hgt = grid.heights[gy * grid.w + gx];
        if (!hgt) continue;
        var color = grid.colors[gy * grid.w + gx];
        var key = color >>> 0;
        var idx = palIndex[key];
        if (!idx) {
          if (palette.length >= 255) {
            // palette full — quantize to 5 bits/channel and reuse the nearest
            var r = (color & 255) >> 3 << 3, g = ((color >> 8) & 255) >> 3 << 3, b = ((color >> 16) & 255) >> 3 << 3;
            key = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
            idx = palIndex[key];
            if (!idx) { idx = nearestPaletteIndex(palette, key); palIndex[key] = idx; }
          } else {
            palette.push(key);
            idx = palette.length;
            palIndex[key] = idx;
          }
        }
        for (var gz = 0; gz < hgt; gz++) {
          voxels.push([gx, gz, grid.h - 1 - gy, idx]);
        }
      }
    }

    function writeU32(buf, off, val) {
      buf[off] = val & 255; buf[off + 1] = (val >> 8) & 255;
      buf[off + 2] = (val >> 16) & 255; buf[off + 3] = (val >> 24) & 255;
    }
    function chunk(id, content, childrenSize) {
      var b = new Uint8Array(12 + content.length);
      for (var i = 0; i < 4; i++) b[i] = id.charCodeAt(i);
      writeU32(b, 4, content.length);
      writeU32(b, 8, childrenSize || 0);
      b.set(content, 12);
      return b;
    }

    var sizeC = new Uint8Array(12);
    writeU32(sizeC, 0, grid.w); writeU32(sizeC, 4, grid.d); writeU32(sizeC, 8, grid.h);

    var xyziC = new Uint8Array(4 + voxels.length * 4);
    writeU32(xyziC, 0, voxels.length);
    for (var n = 0; n < voxels.length; n++) {
      var vv = voxels[n];
      xyziC[4 + n * 4] = vv[0]; xyziC[5 + n * 4] = vv[1];
      xyziC[6 + n * 4] = vv[2]; xyziC[7 + n * 4] = vv[3];
    }

    var rgbaC = new Uint8Array(256 * 4);
    for (var pi = 0; pi < palette.length; pi++) {
      var c = palette[pi];
      rgbaC[pi * 4] = c & 255; rgbaC[pi * 4 + 1] = (c >> 8) & 255;
      rgbaC[pi * 4 + 2] = (c >> 16) & 255; rgbaC[pi * 4 + 3] = 255;
    }

    var size = chunk('SIZE', sizeC);
    var xyzi = chunk('XYZI', xyziC);
    var rgba = chunk('RGBA', rgbaC);
    var childrenSize = size.length + xyzi.length + rgba.length;
    var main = chunk('MAIN', new Uint8Array(0), childrenSize);

    var total = new Uint8Array(8 + main.length + childrenSize);
    total[0] = 86; total[1] = 79; total[2] = 88; total[3] = 32; // 'VOX '
    writeU32(total, 4, 150);
    var off = 8;
    [main, size, xyzi, rgba].forEach(function (part) { total.set(part, off); off += part.length; });
    return total;
  }

  function nearestPaletteIndex(palette, color) {
    var r = color & 255, g = (color >> 8) & 255, b = (color >> 16) & 255;
    var best = 1, bestD = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i];
      var dr = (c & 255) - r, dg = ((c >> 8) & 255) - g, db = ((c >> 16) & 255) - b;
      var dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) { bestD = dist; best = i + 1; }
    }
    return best;
  }

  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /* Voxelize one frame → { name, dataURL, w, h, views?, vox? } */
  function voxelizeFrame(frame, options) {
    var opts = sanitizeOptions(options);
    return loadImage(frame.dataURL).then(function (img) {
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (!iw || !ih) throw new Error('empty image');
      if (iw > MAX_DIM || ih > MAX_DIM) {
        throw new Error('frame too large (' + iw + 'x' + ih + ', max ' + MAX_DIM + ')');
      }
      var viewCount = opts.turntable || 1;
      if (iw * ih * opts.depth * viewCount > MAX_RENDER_VOXELS) {
        throw new Error('render budget exceeded (' + iw + 'x' + ih + ' × depth ' +
          opts.depth + ' × ' + viewCount + ' views) — lower depth or view count');
      }
      var grid = buildGrid(imageDataFrom(img), opts);
      if (!grid.d) throw new Error('no opaque pixels');

      var baseName = String(frame.name || 'sprite');
      var result = { name: baseName + '_voxel' };

      var finish = function () {
        if (opts.vox) result.vox = bytesToBase64(buildVoxFile(grid));
        return result;
      };

      if (opts.turntable) {
        var views = [];
        var chain = Promise.resolve();
        for (var i = 0; i < opts.turntable; i++) {
          (function (idx) {
            chain = chain.then(function () {
              var yaw = opts.yaw + (360 / opts.turntable) * idx;
              var cvv = renderView(grid, opts, yaw);
              views.push({
                name: baseName + '_voxel_y' + Math.round(((yaw % 360) + 360) % 360),
                yaw: yaw,
                dataURL: cvv.toDataURL('image/png'),
                w: cvv.width, h: cvv.height
              });
              // yield so the hosting tab can repaint between heavy views
              return new Promise(function (r) { setTimeout(r, 0); });
            });
          })(i);
        }
        return chain.then(function () {
          result.views = views;
          result.dataURL = views[0].dataURL;
          result.w = views[0].w; result.h = views[0].h;
          return finish();
        });
      }

      var cv = renderView(grid, opts, opts.yaw);
      result.dataURL = cv.toDataURL('image/png');
      result.w = cv.width; result.h = cv.height;
      return finish();
    });
  }

  /* Voxelize a batch sequentially (bounded memory).
   * frames: [{ name, dataURL }]  → { ok, frames: [...], errors: [{name, error}] } */
  function voxelizeFrames(frames, options, onProgress) {
    var all = Array.isArray(frames) ? frames : [];
    var list = all.slice(0, MAX_FRAMES);
    var out = [], errors = [];
    // over-cap frames are reported, not silently dropped
    for (var di = MAX_FRAMES; di < all.length; di++) {
      errors.push({
        name: String((all[di] && all[di].name) || 'frame_' + di),
        error: 'dropped: exceeds ' + MAX_FRAMES + '-frame cap'
      });
    }
    var chain = Promise.resolve();
    list.forEach(function (frame, i) {
      chain = chain.then(function () {
        return voxelizeFrame(frame, options).then(function (res) {
          out.push(res);
          if (onProgress) onProgress(i + 1, list.length);
        }, function (err) {
          errors.push({ name: String(frame && frame.name || 'frame_' + i), error: String(err && err.message || err) });
          if (onProgress) onProgress(i + 1, list.length);
        });
      });
    });
    return chain.then(function () {
      return { ok: out.length > 0 || list.length === 0, frames: out, errors: errors };
    });
  }

  function sanitizeFrames(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var bytes = 0;
    for (var i = 0; i < raw.length && out.length < MAX_FRAMES; i++) {
      var f = raw[i];
      var dataURL = f && typeof f.dataURL === 'string' ? f.dataURL : '';
      if (!DATA_URL_RE.test(dataURL)) continue;
      bytes += dataURL.length;
      if (bytes > MAX_REQUEST_BYTES) break;
      var name = String(f.name || '').replace(/[^\w.-]/g, '').slice(0, 64) || ('sprite_' + out.length);
      out.push({ name: name, dataURL: dataURL });
    }
    return out;
  }

  /* postMessage service — call from the hosting page (index.html). Not
   * auto-installed so apps that bundle the engine for in-process use don't
   * also become a voxelize service. */
  var bridgeInstalled = false;
  function installBridge(onActivity) {
    if (bridgeInstalled) return;
    bridgeInstalled = true;

    global.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || d.type !== 'pixel-composer-voxelize' || !e.source) return;
      var requestId = typeof d.requestId === 'string' ? d.requestId.slice(0, 64) : '';
      var source = e.source;
      var reply = function (msg) {
        try { source.postMessage(msg, '*'); } catch (_) { /* requester gone */ }
      };
      reply({ type: 'pixel-composer-voxelize-ack', requestId: requestId });

      var requested = Array.isArray(d.frames) ? d.frames.length : 0;
      var frames = sanitizeFrames(d.frames);
      if (!frames.length) {
        reply({ type: 'pixel-composer-voxelize-result', requestId: requestId, ok: false, frames: [], errors: [], error: 'no valid frames' });
        return;
      }
      if (onActivity) onActivity(frames.length, e.origin);
      voxelizeFrames(frames, d.options).then(function (res) {
        var dropped = requested - frames.length;
        if (dropped > 0) {
          res.errors.push({
            name: 'request',
            error: dropped + ' frame(s) dropped (caps: ' + MAX_FRAMES +
              ' frames / 24MB; PNG, WebP, GIF or JPEG data URLs only)'
          });
        }
        reply({ type: 'pixel-composer-voxelize-result', requestId: requestId, ok: res.ok, frames: res.frames, errors: res.errors });
      }, function (err) {
        reply({ type: 'pixel-composer-voxelize-result', requestId: requestId, ok: false, frames: [], errors: [], error: String(err && err.message || err) });
      });
    });

    // Announce to whoever embedded/opened us (spritex-ready idiom)
    var hello = { type: 'pixel-composer-ready' };
    try { if (global.parent && global.parent !== global) global.parent.postMessage(hello, '*'); } catch (_) {}
    try { if (global.opener) global.opener.postMessage(hello, '*'); } catch (_) {}
  }

  global.PixelComposerEngine = {
    DEFAULTS: DEFAULTS,
    MAX_FRAMES: MAX_FRAMES,
    MAX_DIM: MAX_DIM,
    sanitizeOptions: sanitizeOptions,
    sanitizeFrames: sanitizeFrames,
    voxelizeFrame: voxelizeFrame,
    voxelizeFrames: voxelizeFrames,
    buildVoxFile: buildVoxFile,
    installBridge: installBridge
  };
})(window);
