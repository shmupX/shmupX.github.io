// This browser's own .sav builds — the shelf the editor's → SAVE SHELF row
// files into, kept in IndexedDB.
//
// Shared on purpose, like static/ps2-library.js: the editor imports it at
// runtime (`import('/deza-exports.js')`) to file, list, load and forget its
// exports, and the launcher's dashboard imports it at bundle time so the SAVED
// GAMES coverflow can shelve the same builds ahead of the community
// collection. One store, one row shape, one change signal — a .sav filed in
// the editor turns up in the launcher without either side knowing about the
// other's code.
//
// A record is what the editor writes:
//   { id, title, file, palette, bytes: Uint8Array, size, savedAt,
//     warnings: string[], report }
// `id` is dezaExportId(title, palette), so re-exporting the same game with
// the same palette replaces the row instead of growing the shelf.

export const DEZA_EXPORTS_DB = 'shmupxDezaExports';
export const DEZA_EXPORTS_STORE = 'saves';
// Every write announces itself here, so a launcher a frame away re-reads.
export const DEZA_EXPORTS_CHANNEL = 'shmupx-deza-exports';

/** Filesystem-safe, stable across rebuilds: one row per game + palette. */
export function dezaExportId(title, palette) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + ':' + palette;
}

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DEZA_EXPORTS_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DEZA_EXPORTS_STORE)) {
        db.createObjectStore(DEZA_EXPORTS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
  });
}

function tx(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(DEZA_EXPORTS_STORE, mode);
    const req = run(t.objectStore(DEZA_EXPORTS_STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error || new Error('IndexedDB transaction failed')); };
    t.onabort = () => { db.close(); reject(t.error || new Error('IndexedDB transaction aborted')); };
  }));
}

let channel = null;
function announce() {
  try {
    if (!channel) channel = new BroadcastChannel(DEZA_EXPORTS_CHANNEL);
    channel.postMessage({ type: 'changed', at: Date.now() });
  } catch (_) { /* no BroadcastChannel — the next open re-reads anyway */ }
}

export async function putDezaExport(record) {
  if (!record || !record.id) throw new Error('an export needs an id');
  await tx('readwrite', (st) => st.put(record));
  announce();
}

export function getDezaExport(id) {
  return tx('readonly', (st) => st.get(id));
}

export async function deleteDezaExport(id) {
  await tx('readwrite', (st) => st.delete(id));
  announce();
}

/**
 * Every export, newest first. The cart image itself is left out unless asked
 * for — a shelf row does not need a megabyte of bytes to draw itself.
 */
export async function listDezaExports({ withBytes = false } = {}) {
  let rows = [];
  try {
    rows = (await tx('readonly', (st) => st.getAll())) || [];
  } catch (_) {
    return []; // private mode, no IndexedDB — an empty shelf, not an error
  }
  rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (withBytes) return rows;
  return rows.map((r) => {
    const { bytes: _bytes, ...rest } = r;
    return rest;
  });
}

/**
 * Call `cb()` whenever an export is filed or forgotten, in this tab or any
 * other same-origin one (the editor is an iframe of the launcher). Returns an
 * unsubscribe.
 */
export function watchDezaExports(cb) {
  let bc = null;
  try {
    bc = new BroadcastChannel(DEZA_EXPORTS_CHANNEL);
    bc.onmessage = () => cb();
  } catch (_) { bc = null; }
  return () => { try { bc?.close(); } catch (_) {} };
}
