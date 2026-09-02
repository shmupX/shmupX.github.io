// The PS2 library: locally built PlayStation 2 games, and the emulator core
// that runs them.
//
// shmupX can build a level into a PS2 disc without leaving the browser (the
// editor's TARGET -> PS2 posts to /api/build-apk, which runs lib/ps2 in the
// Fresh process). This module is what happens next: it keeps those discs in
// IndexedDB, makes sure the Play! core is installed, and hands one to the
// player.
//
// Shared on purpose. The editor imports it at runtime (`import('/ps2-library.js')`)
// to file a build it has just made; the dashboard imports it at bundle time to
// render those builds as rows in its PlayStation 2 section. One store, one
// install path, one hand-off — the two surfaces cannot drift.
//
// WHY THE DISC AND NOT THE .ELF
// A PS2 build is athena.elf (a QuickJS interpreter) plus main.js and assets/
// beside it. Play! will happily boot a bare .elf — it writes it into the
// Emscripten filesystem and jumps to it — but AthenaEnv would then come up with
// no device to read its script or its art from and sit there. The .iso carries
// the whole tree with a SYSTEM.CNF that names the ELF, so `bootDiscImage` gives
// the interpreter a cdrom0: to find everything on. The disc is therefore the
// only self-contained artifact, and the only one this library stores.

// ── The emulator catalogue ───────────────────────────────────────────────────
// Keep these in step with svelte-src/Dashboard.svelte, which reads and writes
// the same keys, and with static/emu-sw.js, which owns the cache.
export const EMU_KEY = 'shmupx-emulators';
export const EMU_SW = '/emu-sw.js';
export const EMU_CATALOG = '/emulators.json';
export const EMU_CACHE = 'shmupx-emu-v1';
export const EMU_STATE_URL = '/__emu-state.json';
export const PS2_CORE_ID = 'ps2';

// Where the player picks a bring-your-own disc up from. play.html opens this
// database, reads `disc` and deletes it; the names are its contract, not ours.
const BYOD_DB = 'cmg-ps2-byod';
const BYOD_STORE = 'files';
const BYOD_KEY = 'disc';

// This library's own store.
const LIB_DB = 'shmupx-ps2-library';
const LIB_STORE = 'games';
const LIB_VERSION = 1;

/**
 * The state emu-sw.js needs to answer a core's paths: every installed core's
 * prefixes, its tile icon (which lives outside them), and the catalogue's
 * shared scripts (which live outside every core). Cores flagged `isolated`
 * additionally get COOP/COEP stamped on their responses.
 *
 * The dashboard calls this too — it is the one rule for what the worker is
 * allowed to mirror, and a second copy of it would eventually disagree.
 */
export function emuStateFor(catalog, installedIds) {
  const cores = (catalog?.cores || []).filter((c) => installedIds.includes(c.id));
  const prefixes = [];
  for (const core of cores) {
    prefixes.push(...(core.prefixes || []));
    if (core.icon) prefixes.push(core.icon);
  }
  if (cores.length) prefixes.push(...(catalog?.shared || []));
  const isolated = [];
  for (const core of cores) if (core.isolated) isolated.push(...(core.prefixes || []));
  return { origin: catalog?.origin || '', prefixes, isolated };
}

export function readInstalledCores() {
  try {
    const v = JSON.parse(localStorage.getItem(EMU_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch (_) { return []; }
}

// Registering is idempotent, but a worker that is merely ACTIVE is not enough:
// an uncontrolled page's fetches never reach it, so the mirrored paths would
// 404 against this origin. Wait for control, with a ceiling so a claim that
// never lands cannot hang an install.
let swReady = null;
let swError = '';  // why the last registration attempt failed, for the message above
function readyWorker() {
  if (swReady) return swReady;
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  swReady = (async () => {
    await navigator.serviceWorker.register(EMU_SW);
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 8000);
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
        if (navigator.serviceWorker.controller) done();
      });
    }
    return reg;
  })().catch((e) => {
    swError = e?.message || String(e);
    // Not cached as a permanent failure: a reload, or a server that has come
    // back up, should get a fresh attempt rather than the stale rejection.
    swReady = null;
    return null;
  });
  return swReady;
}

// The worker sends no reply, but it persists the state it applied — which is
// the only acknowledgement available, and the thing to wait for before treating
// the mirrored paths as live.
async function confirmState(state) {
  const want = state.prefixes.join('|');
  for (let i = 0; i < 60; i++) {
    try {
      const res = await (await caches.open(EMU_CACHE)).match(EMU_STATE_URL);
      if (res) {
        const got = await res.json();
        if (got.origin === state.origin && (got.prefixes || []).join('|') === want) return true;
      }
    } catch (_) { return false; } // no Cache Storage — nothing to wait for
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

/**
 * Install the Play! core if it is not already there, and leave it usable
 * offline.
 *
 * Adding `ps2` to the installed set is what makes the dashboard's PlayStation 2
 * section appear as well, so a game filed from the editor is reachable from the
 * launcher without a second install.
 *
 * `onStep(message)` is called as it goes; the whole thing is a no-op beyond a
 * state push when the core is already installed.
 */
export async function ensurePs2Core(onStep = () => {}) {
  const response = await getOrExplain(EMU_CATALOG, 'emulator catalogue');
  if (!response.ok) {
    throw new Error('could not read ' + EMU_CATALOG + ' (HTTP ' + response.status + ')');
  }
  const catalog = await response.json();
  const core = (catalog.cores || []).find((c) => c.id === PS2_CORE_ID);
  if (!core) throw new Error('the emulator catalogue lists no PlayStation 2 core');

  const installed = readInstalledCores();
  const already = installed.includes(PS2_CORE_ID);
  const next = already ? installed : [...installed, PS2_CORE_ID];
  try { localStorage.setItem(EMU_KEY, JSON.stringify(next)); } catch (_) {}

  onStep(already ? 'PlayStation 2 core: already installed' : 'installing the PlayStation 2 core…');
  const state = emuStateFor(catalog, next);
  const reg = await readyWorker();
  const worker = reg?.active || navigator.serviceWorker?.controller || null;
  if (!worker) {
    // Three different situations used to share one message. Separating them
    // matters because only the last one is the app's fault: a page served over
    // plain http from a non-loopback host cannot have a worker at all, and some
    // embedded browsers refuse to register one however the page is served.
    throw new Error(
      !('serviceWorker' in navigator)
        ? 'this browser has no service worker API, so the emulator cannot be mirrored'
        : !window.isSecureContext
        ? 'this page is not a secure context (' + location.origin + '), and a ' +
          'service worker — which is how the emulator is mirrored — needs https ' +
          'or localhost'
        : 'the service worker at ' + EMU_SW + ' would not register (' +
          (swError || 'no reason reported') + '), so the emulator cannot be mirrored',
    );
  }
  worker.postMessage({ type: 'emu-state', state });
  await confirmState(state);

  // Registration is not control, and `worker` above is truthy either way: a
  // hard reload — and DevTools' "Bypass for network" — leaves this page outside
  // the worker while the registration stays active and healthy, and then every
  // mirrored path below 404s against this origin. The state push above is still
  // worth doing (the next load's worker reads it), but nothing here can be
  // fetched, so name the condition rather than failing on the player page.
  if (!navigator.serviceWorker.controller) {
    throw new Error(
      'the emulator mirror is not in front of this page: the service worker is ' +
      'registered but is not controlling it, which is what a hard reload leaves ' +
      'behind. Reload the page and try again.',
    );
  }

  // Warm what the section needs to be usable at once. The core wasm, BIOS and
  // ROMs stay lazy — the player pulls them as it asks for them, and the worker
  // keeps each one on first use.
  //
  // A catalogue `shared` entry ending in "/" is a PREFIX for the worker to
  // answer, not a file (the origin 404s it), so there is nothing to warm there.
  // And warming is an optimisation, not the install: the worker already holds
  // the prefixes, so anything that fails here will simply be fetched on use.
  // Only the player page is fatal — that is the page about to be opened.
  const targets = [core.player, core.manifest, ...(catalog.shared || [])]
    .filter((path) => path && !path.endsWith('/'));
  const cold = [];
  let done = 0;
  for (const path of targets) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Drain it: the worker's cache.put() only completes once the response has
      // been read, so "warmed" must not run ahead of "cached".
      await res.arrayBuffer();
    } catch (e) {
      if (path === core.player) {
        throw new Error('could not fetch the PS2 player (' + path + '): ' + (e.message || e));
      }
      cold.push(path);
    }
    onStep('warming ' + (++done) + ' / ' + targets.length);
  }
  return { core, installed: !already, cold };
}

// ── The library store ────────────────────────────────────────────────────────

function openLibrary() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(LIB_DB, LIB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(LIB_STORE)) {
        open.result.createObjectStore(LIB_STORE, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error('IndexedDB unavailable'));
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIB_STORE, mode);
    const request = fn(tx.objectStore(LIB_STORE));
    tx.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

/** Filesystem-safe, stable across rebuilds of the same level: one row per name. */
export function ps2GameId(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, 60) || 'game';
}

/**
 * File a built disc. Re-filing a game that is already there replaces it, so
 * exporting the same level twice updates the row instead of growing the shelf.
 */
export async function addPs2Game({ name, blob, file, source }) {
  if (!blob) throw new Error('a library entry needs the disc image itself');
  const id = ps2GameId(name);
  const record = {
    id,
    name: String(name || id),
    file: file || (id + '.iso'),
    size: blob.size,
    source: source || 'local build',
    addedAt: Date.now(),
    blob,
  };
  const db = await openLibrary();
  await run(db, 'readwrite', (store) => store.put(record));
  return record;
}

/** Every filed game, newest first. Blobs come along — they are the point. */
export async function listPs2Games() {
  let rows = [];
  try {
    const db = await openLibrary();
    rows = (await run(db, 'readonly', (store) => store.getAll())) || [];
  } catch (_) {
    return []; // private mode, no IndexedDB — an empty shelf, not an error
  }
  return rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function getPs2Game(id) {
  const db = await openLibrary();
  return await run(db, 'readonly', (store) => store.get(id));
}

export async function removePs2Game(id) {
  const db = await openLibrary();
  await run(db, 'readwrite', (store) => store.delete(id));
}

// ── Handing a disc to the player ─────────────────────────────────────────────

/**
 * Park a disc where /ps2/play.html?byod=1 collects it, and answer with the URL
 * to send the browser to.
 *
 * Top-level, always. Play! keeps guest RAM in a SharedArrayBuffer, which the
 * browser only grants a cross-origin-isolated document; /ps2/ is served with
 * COOP+COEP (main.ts, and emu-sw.js stamps the same pair on what it mirrors),
 * but an iframe only isolates when its embedder does too — and the launcher
 * does not. A top-level navigation is the mode the player's own BYOD path was
 * written for, exit gestures and all.
 */
export async function ps2PlayerUrl(record) {
  const blob = record?.blob;
  if (!blob) throw new Error('that game has no disc image');
  const file = blob instanceof File
    ? blob
    : new File([blob], record.file || (record.id + '.iso'), { type: 'application/x-iso9660-image' });
  await new Promise((resolve, reject) => {
    const open = indexedDB.open(BYOD_DB, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(BYOD_STORE)) {
        open.result.createObjectStore(BYOD_STORE);
      }
    };
    open.onerror = () => reject(open.error || new Error('IndexedDB unavailable'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(BYOD_STORE, 'readwrite');
      tx.objectStore(BYOD_STORE).put(file, BYOD_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
  return '/ps2/play.html?byod=1';
}

/**
 * GET `url`, turning the two failure shapes into something that names itself.
 *
 * A `fetch` that THROWS is the transport, not the server: nothing answered on
 * this origin at all. In this app that overwhelmingly means the build host is
 * gone — the `deno task dev` that produced the path was stopped, or the desktop
 * app was restarted and came up on a different port — and the browser's own
 * wording for it ("Failed to fetch", "Load failed", "NetworkError...") says
 * none of that. A build panel can sit on screen for a long time after the
 * server behind it went away, so this is the likely reading, not an edge case.
 */
async function getOrExplain(url, what) {
  try {
    return await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(
      'could not reach ' + url + ' (' + (e.message || e) + ') — ' +
      'nothing is answering on ' + location.origin + ', so the ' + what +
      ' cannot be read. Is the app (or `deno task dev`) that built this still ' +
      'running on this port?',
    );
  }
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/**
 * Fetch a built artifact off the local build host
 * (routes/api/build-artifact.ts), reporting progress as it arrives.
 *
 * READ THE STREAM, DO NOT CALL res.blob(). `.blob()` is the obvious one line
 * and it is the line that broke. emu-sw.js registers at scope "/", and it used
 * to answer every same-origin GET on the site — and Chrome fails a ~40 MB
 * worker-mediated body handed to `.blob()` outright, with the bare wording
 * "Failed to fetch". Reliably on the first requests after a page load, then
 * intermittently, which is why it read as a flaky server rather than a fixed
 * rule. It was never the transfer: the same URL, in the same tab, in the same
 * second, delivered all 41,146,368 bytes through the body reader every time.
 *
 * The worker no longer touches this path at all — /api/… is outside its
 * MIRRORABLE set, so it is left to the browser whether or not a core is
 * installed. The stream stays anyway, so a later change to what the worker
 * claims cannot quietly bring the failure back.
 *
 * So the bytes are collected here and the Blob is built locally. That also
 * gives this a count, which is what lets a genuinely broken transfer say how
 * far it got instead of parroting the browser.
 *
 * `onProgress(received, total)` is called at most once per megabyte, plus once
 * at the end; `total` is 0 when the response carried no content-length.
 */
export async function fetchArtifact(path, onProgress = () => {}) {
  const url = '/api/build-artifact?path=' + encodeURIComponent(path);
  const res = await getOrExplain(url, 'disc image');
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { detail = (await res.json()).error || detail; } catch (_) {}
    throw new Error(detail + ' (' + url + ')');
  }
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const total = Number(res.headers.get('content-length')) || 0;
  // No body stream to read (an ancient browser, or a synthesised response):
  // arrayBuffer is the fallback rather than blob, for the same reason.
  if (!res.body) return new Blob([await res.arrayBuffer()], { type });

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let reported = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got - reported >= 1048576) { reported = got; onProgress(got, total); }
    }
  } catch (e) {
    // The headers arrived and the body did not. Distinct from getOrExplain's
    // case: the server WAS there and the transfer broke off, which for a disc
    // read off a temp directory means the file moved or the host went down
    // mid-download.
    throw new Error(
      'the disc image broke off after ' + mb(got) +
      (total ? ' of ' + mb(total) : '') + ' (' + (e.message || e) +
      ') — rebuild it and try again',
    );
  }
  // A short body with no error is the other half of the same failure: the
  // stream ended cleanly before content-length said it should.
  if (total && got !== total) {
    throw new Error(
      'the disc image arrived short — ' + mb(got) + ' of ' + mb(total) +
      ' — rebuild it and try again',
    );
  }
  if (got !== reported) onProgress(got, total);
  return new Blob(chunks, { type });
}
