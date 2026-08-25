/* SpriteX ⇄ Pixel Composer addon — adds VOXELIZE buttons to the SpriteX
 * workbench without touching its built bundle. Ships inside spritex.zip
 * alongside pixel-composer.js + pc-client.js (in-process transport, works
 * offline) and is also served at /pixel-composer/spritex-addon.js.
 *
 * Sources of frames (whatever the current tab offers):
 *   VIEW tab   — the frames selected in the atlas strip
 *                (#atlasFramesContainer .atlas-frame-wrapper.selected)
 *   EXTRACT    — the sprite thumbs in the SELECTED dock
 *                (#selectedSpritesContainer img[src^="data:image/"])
 *
 * Results are handed back through the packer's upload input: each voxelized
 * PNG becomes a synthetic File, so SpriteX ingests them as UPLOADED SPRITES
 * named after the frame (its existing dedupe/rename rules apply) and they can
 * be added to any atlas from the PACKER tab.
 */
(function () {
  'use strict';

  if (window.__pcSpritexAddon) return;
  window.__pcSpritexAddon = true;

  function $(id) { return document.getElementById(id); }

  function status(msg) {
    var line = $('sxStatusLine');
    if (line) line.textContent = msg;
  }

  function collectViewFrames() {
    var out = [];
    document.querySelectorAll('#atlasFramesContainer .atlas-frame-wrapper.selected').forEach(function (w, i) {
      var img = w.querySelector('img');
      var label = w.querySelector('.atlas-frame-label');
      if (!img || img.src.indexOf('data:image/') !== 0) return;
      var name = (label && label.textContent || w.title || '').trim() || ('frame_' + i);
      out.push({ name: name, dataURL: img.src });
    });
    return out;
  }

  function collectExtractSprites() {
    var out = [];
    document.querySelectorAll('#selectedSpritesContainer img').forEach(function (img, i) {
      if (img.src.indexOf('data:image/') !== 0) return;
      out.push({ name: 'sprite_' + i, dataURL: img.src });
    });
    return out;
  }

  function dataURLToFile(dataURL, filename) {
    var parts = dataURL.split(',');
    var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/png';
    var bin = atob(parts[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }

  /* Feed voxelized frames into the packer's UPLOADED SPRITES source via its
   * own upload input, so SpriteX's normal naming/dedupe/UI flow handles them. */
  function deliverToPacker(frames) {
    var input = $('packerUploadInput');
    if (!input) return 0;
    var dt = new DataTransfer();
    var count = 0;
    frames.forEach(function (f) {
      if (!f || typeof f.dataURL !== 'string') return;
      // A turntable result carries every view; deliver each as its own sprite.
      var all = Array.isArray(f.views) && f.views.length ? f.views : [f];
      all.forEach(function (v) {
        try {
          dt.items.add(dataURLToFile(v.dataURL, (v.name || 'voxel') + '.png'));
          count++;
        } catch (_) { /* skip malformed frame */ }
      });
    });
    if (!count) return 0;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return count;
  }

  function makeButton(label) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = label;
    btn.title = 'Send the selected frames to Pixel Composer and get voxelized versions back (→ PACKER · UPLOADED SPRITES)';
    return btn;
  }

  function wire(btn, collector) {
    var idle = btn.textContent;
    btn.addEventListener('click', function () {
      if (!window.CMGPixelComposer) { status('PIXEL COMPOSER UNAVAILABLE'); return; }
      var frames = collector();
      if (!frames.length) { status('SELECT FRAMES TO VOXELIZE FIRST'); return; }
      btn.disabled = true;
      btn.textContent = 'VOXELIZING…';
      status('VOXELIZING ' + frames.length + ' FRAME(S)…');
      window.CMGPixelComposer.voxelize(frames, { depth: 6, pixelSize: 3 })
        .then(function (res) {
          var delivered = deliverToPacker(res.frames);
          var failed = res.errors.length;
          status(delivered
            ? delivered + ' VOXEL SPRITE(S) → PACKER · UPLOADED SPRITES' + (failed ? ' · ' + failed + ' FAILED' : '')
            : 'VOXELIZE PRODUCED NO SPRITES' + (failed ? ' · ' + failed + ' FAILED' : ''));
        })
        .catch(function (err) {
          status('VOXELIZE FAILED: ' + String(err && err.message || err).toUpperCase());
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = idle;
        });
    });
  }

  function install() {
    // VIEW tab — under the GIF/JSON/PNG download grid in the atlas dock
    var viewActions = document.querySelector('#viewAtlasDock .sx-dock-actions');
    if (viewActions) {
      var vBtn = makeButton('⬢ VOXELIZE SELECTED');
      vBtn.style.width = '100%';
      vBtn.style.marginTop = '8px';
      wire(vBtn, collectViewFrames);
      viewActions.appendChild(vBtn);
    }

    // EXTRACT tab — alongside the atlas-builder actions in the sheet dock
    var sheetActions = $('sheetAtlasSave');
    if (sheetActions) {
      var eBtn = makeButton('⬢ VOXELIZE SELECTED');
      wire(eBtn, collectExtractSprites);
      sheetActions.appendChild(eBtn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
