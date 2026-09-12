// ENGINE COMPARISON (debug) — play the level this page is running on the
// Saturn (Mednafen) and in this runtime at the same moment, record a window
// of both, and show the two side by side.
//
// Inert unless debug is on: ?debug=1 on this page or on the launcher framing
// it (the launcher and the editor both forward the flag), or
// localStorage['shmupx-debug'] = '1'. Then it does two things:
//
//   - tells the launcher's Guide about a SATURN COMPARE button over the
//     cmg-actions channel (see svelte-src/Dashboard.svelte), and draws its own
//     button when the page stands alone, and
//   - on that button, runs the comparison and opens a split view of the
//     result: the Saturn's recording on the left, the runtime's on the right.
//
// Where it runs: on the machine serving this page when that machine can
// (POST /api/engine-compare — a local install or the dev server, on macOS
// with Mednafen, the disc and Chrome), otherwise on the desktop paired with
// ?builder=ABCX-DEFY through the export queue (static/export-queue.js, job
// kind "engine-compare"), the same way an APK is built remotely. The level is
// named by ?source= (the editor passes the shelf slug it loaded), else by the
// running recipe's title, else the button asks.
//
// The work itself is tools/sav-profiler, wrapped by lib/engine-compare.ts.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var topParams = null;
  try {
    if (window.top !== window) topParams = new URLSearchParams(window.top.location.search);
  } catch (_) { /* cross-origin launcher: nothing to read */ }
  var param = function (name) {
    return params.get(name) || (topParams && topParams.get(name)) || '';
  };
  var stored = function (key) {
    try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
  };
  var debugOn = param('debug') === '1' || stored('shmupx-debug') === '1';
  if (!debugOn) return;

  var builderParam = param('builder');
  if (builderParam) {
    try { localStorage.setItem('shmupx-builder-code', builderParam.toUpperCase()); } catch (_) { /* fine */ }
  }
  var ACTION_ID = 'engine-compare';
  var DEFAULT_FROM = 44;
  var DEFAULT_FOR = 5;

  // ── what to compare ─────────────────────────────────────────────────────
  function recipeTitle() {
    var gs = window.__CMG_GAME_STATE__ || null;
    var recipe = gs && gs._phaserRecipe;
    if (!recipe) {
      try {
        var raw = localStorage.getItem('__editorPhaserRecipe__');
        if (raw) recipe = JSON.parse(raw);
      } catch (_) { recipe = null; }
    }
    if (!recipe) return '';
    var meta = recipe.meta || {};
    return String(meta.sourceTitle || recipe.name || '').trim();
  }
  function levelSource() {
    var s = param('source') || param('play');
    if (s) return s;
    var level = param('level');
    if (level && level !== 'foo') return level;
    return recipeTitle();
  }

  // ── the overlay ─────────────────────────────────────────────────────────
  var overlay = null;
  var logEl = null;
  var bodyEl = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'engine-compare-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.92);color:#e5e7eb;' +
      'font:13px/1.4 ui-monospace,Menlo,monospace;display:flex;flex-direction:column;padding:12px;box-sizing:border-box;';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:8px;';
    var title = document.createElement('strong');
    title.textContent = 'SATURN vs shmupX';
    title.style.letterSpacing = '.08em';
    var close = document.createElement('button');
    close.textContent = 'CLOSE';
    close.style.cssText = 'margin-left:auto;background:#374151;color:#fff;border:0;padding:6px 12px;cursor:pointer;';
    close.onclick = function () { overlay.style.display = 'none'; };
    head.appendChild(title);
    head.appendChild(close);
    bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;';
    logEl = document.createElement('pre');
    logEl.style.cssText = 'margin:0;max-height:30vh;overflow:auto;background:#111827;padding:8px;white-space:pre-wrap;';
    overlay.appendChild(head);
    overlay.appendChild(bodyEl);
    overlay.appendChild(logEl);
    document.body.appendChild(overlay);
    return overlay;
  }
  function say(line) {
    ensureOverlay();
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function showResult(videoUrl, links, note) {
    ensureOverlay();
    bodyEl.innerHTML = '';
    if (note) {
      var p = document.createElement('div');
      p.textContent = note;
      bodyEl.appendChild(p);
    }
    if (videoUrl) {
      var v = document.createElement('video');
      v.src = videoUrl;
      v.controls = true;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.style.cssText = 'max-width:100%;max-height:60vh;background:#000;image-rendering:pixelated;';
      bodyEl.appendChild(v);
    }
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;';
    (links || []).forEach(function (l) {
      var a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      a.target = '_blank';
      a.style.color = '#93c5fd';
      row.appendChild(a);
    });
    bodyEl.appendChild(row);
  }

  // ── running it locally ─────────────────────────────────────────────────
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function localCapability() {
    try {
      var res = await fetch('/api/engine-compare', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }
  async function runLocal(source, from, len) {
    var res = await fetch('/api/engine-compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: source, from: from, for: len }),
    });
    var j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    var id = j.job.id;
    var seen = 0;
    for (;;) {
      await sleep(2000);
      var r = await fetch('/api/engine-compare?job=' + encodeURIComponent(id), { cache: 'no-store' });
      var s = await r.json();
      if (!r.ok || !s.ok) throw new Error(s.error || ('HTTP ' + r.status));
      var job = s.job;
      var lines = job.log || [];
      for (; seen < lines.length; seen++) say(lines[seen]);
      if (job.status === 'failed') throw new Error(job.error || 'the comparison failed');
      if (job.status === 'done') {
        var file = function (name) { return '/api/engine-compare?job=' + encodeURIComponent(id) + '&file=' + name; };
        var files = (job.result && job.result.files) || [];
        var links = files.filter(function (n) { return n !== 'compare.mp4'; })
          .map(function (n) { return { href: file(n), label: n }; });
        var note = job.result.name + ' — ' + job.from + 's to ' + (job.from + job.len) + 's after Start' +
          (job.result.gameStartedAfterMs != null ? '; runtime gameplay began ' + (job.result.gameStartedAfterMs / 1000).toFixed(2) + 's after Start' : '') +
          (job.result.saturnLagSec > 0.5 ? '; the emulator ran ' + job.result.saturnLagSec.toFixed(1) + 's slow' : '');
        showResult(files.indexOf('compare.mp4') >= 0 ? file('compare.mp4') : null, links, note);
        return;
      }
    }
  }

  // ── running it on the paired desktop ───────────────────────────────────
  async function runRemote(code, source, from, len) {
    var q = await import('/export-queue.js');
    q.setBuilderCode(code);
    say('queueing to desktop ' + q.formatBuilderCode(q.getBuilderCode()) + ' …');
    var job = await q.queueExport({
      code: code,
      level: source,
      platform: 'compare',
      kind: 'engine-compare',
      options: { from: from, for: len },
    });
    // watchJobs streams every job this browser queued; wait for ours to end.
    var finished = await new Promise(function (resolve, reject) {
      var last = '';
      var stop = q.watchJobs(function (jobs) {
        var cur = null;
        for (var i = 0; i < jobs.length; i++) if (jobs[i].id === job.id) cur = jobs[i];
        if (!cur) return;
        var line = q.jobStatusText(cur);
        if (line !== last) { say(line); last = line; }
        if (cur.status === 'done') { stop(); resolve(cur); }
        else if (cur.status === 'failed') { stop(); reject(new Error(cur.error || 'the desktop failed the comparison')); }
        else if (cur.status === 'cancelled' || cur.status === 'gone') { stop(); resolve(null); }
      });
    });
    if (!finished) { say('the job was cancelled or dropped'); return; }
    var arts = finished.artifacts || [];
    var videoUrl = null;
    var links = [];
    for (var a = 0; a < arts.length; a++) {
      say('fetching ' + arts[a].name + ' …');
      var blob = await q.fetchQueuedArtifact(finished, a);
      var url = URL.createObjectURL(blob);
      if (arts[a].kind === 'video') videoUrl = url;
      else links.push({ href: url, label: arts[a].name });
    }
    try { await q.markReceived(code, finished.id); } catch (_) { /* best effort */ }
    showResult(videoUrl, links, finished.level + ' — from desktop ' + (finished.workerName || finished.worker || ''));
  }

  // ── the button ─────────────────────────────────────────────────────────
  var running = false;
  async function start() {
    if (running) { ensureOverlay().style.display = 'flex'; return; }
    var source = levelSource();
    source = window.prompt('Compare which level? (shelf slug, title, cloud level or sav: path)', source || '') || '';
    source = source.trim();
    if (!source) return;
    var from = Number(window.prompt('Record from second', String(DEFAULT_FROM)) || DEFAULT_FROM);
    var len = Number(window.prompt('For how many seconds', String(DEFAULT_FOR)) || DEFAULT_FOR);
    if (!(from >= 0) || !(len > 0)) return;
    running = true;
    ensureOverlay().style.display = 'flex';
    bodyEl.innerHTML = '';
    logEl.textContent = '';
    try {
      var code = stored('shmupx-builder-code');
      var cap = await localCapability();
      if (cap && cap.available) {
        say('running on this machine …');
        await runLocal(source, from, len);
      } else if (code) {
        say((cap && cap.reason) ? 'not here (' + cap.reason + ')' : 'no local runner');
        await runRemote(code, source, from, len);
      } else {
        say('This page cannot run the comparison here' + ((cap && cap.reason) ? ' (' + cap.reason + ')' : '') +
          ', and no desktop is paired. Open it with ?builder=ABCX-DEFY, the BUILD CODE shown in the desktop app\'s Settings.');
      }
    } catch (e) {
      say('FAILED: ' + (e && e.message ? e.message : e));
    } finally {
      running = false;
    }
  }

  function advertise() {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: 'cmg-actions', actions: [{ id: ACTION_ID, label: 'Saturn Compare' }] }, '*');
    } catch (_) { /* no launcher */ }
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data || {};
    if (d.type === 'cmg-action' && d.id === ACTION_ID) start();
  });
  function ownButton() {
    var b = document.createElement('button');
    b.id = 'engine-compare-button';
    b.textContent = 'SATURN COMPARE';
    b.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147482000;background:#1f2937;color:#fbbf24;border:1px solid #fbbf24;' +
      'font:11px ui-monospace,Menlo,monospace;letter-spacing:.08em;padding:6px 10px;cursor:pointer;opacity:.85;';
    b.onclick = start;
    document.body.appendChild(b);
  }
  function boot() {
    advertise();
    // Repeat once the bundle has surely booted: a launcher that reset its
    // action set on load would otherwise miss the first announcement.
    setTimeout(advertise, 4000);
    if (window.parent === window) ownButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
