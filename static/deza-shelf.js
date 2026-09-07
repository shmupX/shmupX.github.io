// The Dezaemon shelf: this browser's Dezaemon 2 (Sega Saturn) .sav games.
//
// Two things land here. The level editor's "→ SAVE SHELF" files the cart it has
// just built (source "export"), and the eShop installs a published Dezaemon
// game onto the same shelf (source "eshop") — see static/eshop-library.js. The
// launcher's coverflow and the editor's LOAD GAME drawer both read it, and
// both react when it changes.
//
// Shared on purpose, the way static/ps2-library.js is: the editor imports it
// at runtime (`import('/deza-shelf.js')`), the dashboard bundles it. The
// database and store names predate this module — the editor created them
// inline — and the records it wrote must stay readable, so nothing here bumps
// the version or renames a field. A record is:
//
//   { id, title, file, palette, bytes (Uint8Array: the full 1,114,112-byte
//     MiSTer-layout .sav), size, savedAt, warnings?, report?,
//     source: "export" | "eshop", eshopId?, cover? (data URL) }
//
// Ids: an export keeps the editor's "<slug>:<palette>", so re-exporting the
// same level replaces its row instead of growing the shelf; an eShop install
// is "eshop:<catalog id>", so the two can never collide and the launcher can
// tell them apart without a lookup.

export const DEZA_SHELF_DB = 'shmupxDezaExports';
export const DEZA_SHELF_STORE = 'saves';
// Version 1 and never higher: the editor still opens this database with an
// explicit version, and a store upgraded past it would refuse that open.
const DEZA_SHELF_VERSION = 1;
// Every write posts { type: "changed" } here so the other surface refreshes.
export const DEZA_SHELF_CHANNEL = 'shmupx-deza-shelf';

/**
 * The slug the whole Dezaemon library keys on — identical to the editor's
 * dezaSlugOfTitle and the upload script's slugOf (scripts/upload-deza-saves.ts),
 * so a title resolves to the same id wherever it is computed.
 */
export function slugOfTitle(title) {
  const s = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'save';
}

/** The editor's export id, byte for byte: "<slug>:<palette>". */
export function dezaShelfIdForExport(title, palette) {
  return slugOfTitle(title) + ':' + String(palette || 'saturn');
}

/** An installed eShop game's shelf id: "eshop:<catalog id>". */
export function dezaShelfIdForEshop(id) {
  return 'eshop:' + String(id || '');
}

export function isEshopShelfEntry(rec) {
  return !!rec && (rec.source === 'eshop' || String(rec.id || '').startsWith('eshop:'));
}

// ── The store ────────────────────────────────────────────────────────────────

function named(what, e) {
  const reason = (e && e.message) || (e && e.name) || String(e || 'unknown error');
  return new Error('the Dezaemon shelf (IndexedDB "' + DEZA_SHELF_DB + '") could not be ' + what + ': ' + reason);
}

/**
 * Open the shelf database. Callers that use this directly close what they get;
 * the helpers below open and close per operation, which is what keeps a second
 * tab's write from being blocked by a connection this one left idle.
 */
export function openDezaShelf() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(named('opened', new Error('this context has no IndexedDB')));
      return;
    }
    let req;
    try { req = indexedDB.open(DEZA_SHELF_DB, DEZA_SHELF_VERSION); } catch (e) { reject(named('opened', e)); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DEZA_SHELF_STORE)) db.createObjectStore(DEZA_SHELF_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(named('opened', req.error || new Error('IndexedDB unavailable')));
    req.onblocked = () => reject(named('opened', new Error('another tab is holding it open')));
  });
}

function tx(mode, what, run) {
  return openDezaShelf().then((db) => new Promise((resolve, reject) => {
    let request;
    try {
      const t = db.transaction(DEZA_SHELF_STORE, mode);
      request = run(t.objectStore(DEZA_SHELF_STORE));
      t.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
      t.onerror = () => { db.close(); reject(named(what, t.error)); };
      t.onabort = () => { db.close(); reject(named(what, t.error || new Error('transaction aborted'))); };
    } catch (e) {
      db.close();
      reject(named(what, e));
    }
  }));
}

/**
 * Every record, newest first. Never throws: a browser with no IndexedDB (or a
 * store it will not open) has an empty shelf, not a broken launcher — the
 * same rule static/ps2-library.js applies to its own list.
 */
export async function listDezaShelf() {
  let rows;
  try {
    rows = await tx('readonly', 'read', (store) => store.getAll());
  } catch (_) {
    return [];
  }
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function getDezaShelfEntry(id) {
  const rec = await tx('readonly', 'read', (store) => store.get(String(id)));
  return rec || null;
}

/**
 * File a record (replacing any with the same id) and tell the other surface.
 * `bytes` must be the full MiSTer-layout cart: that is what the editor's
 * playExport hand-off and the Saturn export paths expect to find.
 */
export async function putDezaShelfEntry(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('a shelf record needs a string id');
  if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) {
    throw new Error('a shelf record needs the .sav bytes themselves (a Uint8Array)');
  }
  const record = {
    ...rec,
    title: String(rec.title || rec.id),
    file: rec.file || ('Dez 2 - ' + String(rec.title || rec.id) + '.sav'),
    palette: rec.palette || 'saturn',
    size: rec.size || rec.bytes.length,
    savedAt: rec.savedAt || Date.now(),
    source: rec.source || (rec.id.startsWith('eshop:') ? 'eshop' : 'export'),
  };
  await tx('readwrite', 'written', (store) => store.put(record));
  notifyDezaShelfChanged();
  return record;
}

export async function removeDezaShelfEntry(id) {
  await tx('readwrite', 'written', (store) => store.delete(String(id)));
  notifyDezaShelfChanged();
}

// ── Change notification ──────────────────────────────────────────────────────
// A BroadcastChannel reaches the other tab (and the launcher above an editor
// frame) but never the channel object that posted, so local subscribers are
// called directly as well: one subscribe covers "I changed it" and "someone
// else did".

const local = new Set();
let channel = null;
function shelfChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    channel = new BroadcastChannel(DEZA_SHELF_CHANNEL);
    channel.onmessage = (ev) => { if (ev?.data?.type === 'changed') fire(); };
  } catch (_) { channel = null; }
  return channel;
}
function fire() {
  for (const cb of [...local]) {
    try { cb(); } catch (_) { /* one listener's throw must not starve the rest */ }
  }
}

export function notifyDezaShelfChanged() {
  try { shelfChannel()?.postMessage({ type: 'changed' }); } catch (_) { /* no channel — local listeners still hear it */ }
  fire();
}

/** Subscribe to shelf changes from any tab (and this one). Returns unsubscribe. */
export function onDezaShelfChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  shelfChannel();
  local.add(cb);
  return () => { local.delete(cb); };
}
