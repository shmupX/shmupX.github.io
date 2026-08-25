/* Pixel Composer client — drop-in helper for CMG apps (SpriteX, Level Editor)
 * to send sprite frames off for voxelization and get the results back.
 *
 *   const res = await CMGPixelComposer.voxelize(
 *     [{ name: 'enemyA_0', dataURL }, { name: 'enemyA_1', canvas }],
 *     { depth: 6, pixelSize: 3, turntable: 0, vox: false }
 *   );
 *   // res.frames → [{ name, dataURL, w, h, views?, vox? }], res.errors → [...]
 *
 * Transport is picked automatically:
 *   - If window.PixelComposerEngine is present (the app bundles
 *     pixel-composer.js, like the SpriteX zip), voxelize in-process. Works
 *     fully offline.
 *   - Otherwise embed the Pixel Composer service page in a hidden iframe and
 *     speak the pixel-composer-* postMessage protocol, re-posting the request
 *     every 500ms until acked (the launcher's delivery idiom) and correlating
 *     replies by requestId.
 *
 * Service URL resolution: CMGPixelComposer.configure({ url }) >
 * <script data-pc-url="..."> > '/pixel-composer/' (same-origin default —
 * correct for /editor/ and for the launcher-cached /cmg-net/ apps).
 */
(function (global) {
  'use strict';

  var scriptEl = document.currentScript;
  var cfg = {
    url: (scriptEl && scriptEl.getAttribute('data-pc-url')) || '/pixel-composer/',
    ackTimeoutMs: 45000,     // service page may need to load first
    resultTimeoutMs: 180000  // large batches take a while
  };

  var iframe = null;
  var pending = {}; // requestId → { resolve, reject, ackTimer, deliverTimer, resultTimer }
  var seq = 0;
  var listening = false;

  function ensureListener() {
    if (listening) return;
    listening = true;
    global.addEventListener('message', function (e) {
      // Only trust messages from our own hidden iframe (identity check, same
      // as the launcher's bridges — window identities compare cross-origin).
      if (!iframe || e.source !== iframe.contentWindow) return;
      var d = e && e.data;
      if (!d || typeof d.type !== 'string') return;
      var p = d.requestId && pending[d.requestId];
      if (d.type === 'pixel-composer-voxelize-ack' && p) {
        clearInterval(p.deliverTimer);
        clearTimeout(p.ackTimer);
      } else if (d.type === 'pixel-composer-voxelize-result' && p) {
        settle(d.requestId);
        if (d.ok) {
          p.resolve({ frames: d.frames || [], errors: d.errors || [] });
        } else {
          // surface per-frame detail like the in-process branch does
          var detail = d.error ||
            (d.errors && d.errors.length ? 'voxelize failed: ' + d.errors[0].error : 'voxelize failed');
          p.reject(new Error(detail));
        }
      }
    });
  }

  function settle(requestId) {
    var p = pending[requestId];
    if (!p) return;
    clearInterval(p.deliverTimer);
    clearTimeout(p.ackTimer);
    clearTimeout(p.resultTimer);
    delete pending[requestId];
  }

  function ensureIframe() {
    if (iframe && iframe.parentNode) return iframe;
    iframe = document.createElement('iframe');
    iframe.src = cfg.url;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;visibility:hidden;';
    document.body.appendChild(iframe);
    return iframe;
  }

  /* Accept frames as {name, dataURL} or {name, canvas}; normalize to dataURLs. */
  function normalizeFrames(frames) {
    var out = [];
    (Array.isArray(frames) ? frames : []).forEach(function (f, i) {
      if (!f) return;
      var name = String(f.name || 'sprite_' + i);
      if (typeof f.dataURL === 'string' && f.dataURL.indexOf('data:image/') === 0) {
        out.push({ name: name, dataURL: f.dataURL });
      } else if (f.canvas && typeof f.canvas.toDataURL === 'function') {
        out.push({ name: name, dataURL: f.canvas.toDataURL('image/png') });
      }
    });
    return out;
  }

  function voxelize(frames, options) {
    var list = normalizeFrames(frames);
    if (!list.length) return Promise.reject(new Error('no frames to voxelize'));

    // In-process transport when the engine is bundled (offline-proof)
    if (global.PixelComposerEngine) {
      return global.PixelComposerEngine.voxelizeFrames(list, options).then(function (res) {
        if (!res.ok && res.errors.length) {
          throw new Error('voxelize failed: ' + res.errors[0].error);
        }
        return { frames: res.frames, errors: res.errors };
      });
    }

    // iframe transport
    ensureListener();
    var frame = ensureIframe();
    var requestId = 'pc_' + Date.now().toString(36) + '_' + (++seq);
    var msg = { type: 'pixel-composer-voxelize', requestId: requestId, frames: list, options: options || {} };

    return new Promise(function (resolve, reject) {
      var p = pending[requestId] = { resolve: resolve, reject: reject };
      var post = function () {
        try { frame.contentWindow.postMessage(msg, '*'); } catch (_) { /* not ready yet */ }
      };
      // Re-post until the service acks — it may still be loading.
      p.deliverTimer = setInterval(post, 500);
      p.ackTimer = setTimeout(function () {
        settle(requestId);
        reject(new Error('Pixel Composer did not respond (is ' + cfg.url + ' reachable?)'));
      }, cfg.ackTimeoutMs);
      p.resultTimer = setTimeout(function () {
        settle(requestId);
        reject(new Error('Pixel Composer timed out'));
      }, cfg.resultTimeoutMs);
      post();
    });
  }

  function rejectAllPending(reason) {
    Object.keys(pending).forEach(function (id) {
      var p = pending[id];
      settle(id);
      p.reject(new Error(reason));
    });
  }

  function configure(next) {
    if (next && typeof next.url === 'string' && next.url) {
      if (iframe && iframe.parentNode && cfg.url !== next.url) {
        // in-flight requests target the old frame; fail them now rather than
        // letting them silently stall into their timeouts
        rejectAllPending('Pixel Composer service URL changed while a request was in flight');
        iframe.parentNode.removeChild(iframe);
        iframe = null;
      }
      cfg.url = next.url;
    }
    if (next && next.ackTimeoutMs > 0) cfg.ackTimeoutMs = next.ackTimeoutMs;
    if (next && next.resultTimeoutMs > 0) cfg.resultTimeoutMs = next.resultTimeoutMs;
  }

  function dispose() {
    rejectAllPending('Pixel Composer client disposed');
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    iframe = null;
  }

  global.CMGPixelComposer = {
    voxelize: voxelize,
    configure: configure,
    dispose: dispose
  };
})(window);
