// The SNES shelf: this browser's Super Famicom Dezaemon (.srm) games.
//
// Two things land here, the same two the Saturn shelf takes. The editor's
// "→ SNES LIBRARY" files a dump the player picked off their own disk (source
// "import"), and static/snes-library.js installs one published to the Realtime
// Database onto the same shelf (source "library"). The launcher's SUPER
// FAMICOM section reads it, and reacts when it changes.
//
// Shared on purpose, the way static/deza-shelf.js is: the editor imports it at
// runtime (`import('/snes-shelf.js')`), the dashboard bundles it. One store,
// one cover rule, one change signal — the two surfaces cannot drift.
//
// A record is:
//
//   { id, title, file, bytes (Uint8Array: the 131,072-byte SRAM dump), size,
//     savedAt, source: "import" | "library", slug, librarySlug?, dumpedAt?,
//     developer?, genre?, video?, stages?, cover (data URL) }
//
// WHY THE BYTES ARE THE FILE
// A Saturn cart on the other shelf is an interleaved 1,114,112-byte image that
// has to be stored in the MiSTer layout because that is what every consumer of
// it expects. An SFC dump has no layers at all — "no header, no interleave, no
// compression" (FORMAT-SFC.md) — so what is stored is the file the player
// dropped in, byte for byte, and what comes back out is a file they could write
// straight to a flash cart.
//
// IDS
// An import keeps the bare slug and a library install is "library:<slug>", so
// installing a published game never overwrites a dump the player made
// themselves, and the launcher can tell the two apart without a lookup. Same
// rule, same reason, as dezaShelfIdForEshop next door.
//
// COVERS
// Composed here from the cart itself, by the same composeSfcCover that
// `deno task sfc:upload` renders the published library with — so a dump this
// browser imported is shot by the same rule as one off the database, and no
// caller has to remember to supply one. A library install that fetched the
// published cover keeps it. Unlike the Saturn shelf, a cover can legitimately
// be unavailable: a 64 KB dump has no graphics bank and a factory-fresh cart's
// bank is blank, so those rows wear the text card instead.

export const SNES_SHELF_DB = 'shmupxSnesShelf';
export const SNES_SHELF_STORE = 'saves';
const SNES_SHELF_VERSION = 1;
/** Every write posts { type: "changed" } here so the other surface refreshes. */
export const SNES_SHELF_CHANNEL = 'shmupx-snes-shelf';

/** The 128 KB cart, and the short dump some dumpers stop at (FORMAT-SFC.md). */
export const SFC_SRAM_BYTES = 131072;
export const SFC_SHORT_BYTES = 65536;

/**
 * The slug the Super Famicom library keys on — identical to sfcSlugOfTitle in
 * scripts/lib/sfc-library.ts (which the publisher keys the database on) and to
 * slugOfTitle next door, so a title resolves to the same id wherever it is
 * computed. Mirrored rather than imported because this file is plain browser
 * ESM and cannot reach a .ts module; tests/sfc_library_test.ts holds the two
 * copies equal.
 */
export function sfcSlugOfTitle(title) {
  const s = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'save';
}

/** A dump the player imported themselves: the bare slug. */
export function snesShelfIdForImport(title) {
  return sfcSlugOfTitle(title);
}

/** A game installed off the published library: "library:<slug>". */
export function snesShelfIdForLibrary(slug) {
  return 'library:' + String(slug || '');
}

export function isLibraryShelfEntry(rec) {
  return !!rec && (rec.source === 'library' || String(rec.id || '').startsWith('library:'));
}

/**
 * "ALDI Adventure (2026-08-22).srm" -> { title, dumpedAt }. The collection
 * names a file for the game and the day it was dumped; the browser has to
 * split them the same way the publisher does, or an imported dump would sit on
 * the shelf under a different id than the same game installed from the library.
 * Mirrors sfcFileTitle/sfcDumpDate in scripts/lib/sfc-library.ts.
 */
export function sfcTitleFromFileName(name) {
  const base = String(name || '').replace(/\.(srm|sav|sr[0-9])$/i, '');
  const dated = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(base);
  return {
    title: base.replace(/\s*\((\d{4}-\d{2}-\d{2})\)\s*$/, '').trim(),
    dumpedAt: dated ? dated[1] : null,
  };
}

// ── The engine ───────────────────────────────────────────────────────────────
// Imported lazily, exactly the way static/deza-shelf.js does it (`new
// URL(...).href` keeps the specifier out of esbuild's reach, so the dashboard
// bundle leaves the import alone), and a rejected import is forgotten so the
// next shelf write retries rather than failing forever on a blip.

const ENGINE_URL = new URL('./engine/shmup-engine.js', import.meta.url).href;
let enginePending = null;
export function loadSnesEngine() {
  if (!enginePending) {
    enginePending = import(ENGINE_URL).catch((e) => { enginePending = null; throw e; });
  }
  return enginePending;
}

/** RGBA -> a PNG data URL, through a canvas. Null where there is no DOM. */
function rgbaToPngDataUrl(composed) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = composed.w;
  c.height = composed.h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(composed.rgba, composed.w, composed.h), 0, 0);
  return c.toDataURL('image/png');
}

/**
 * True when these bytes are a Dezaemon SRAM dump — size plus the "T.TABATA"
 * magic the boot code writes at 0x7FF8. The gate every road onto this shelf
 * passes through: a Saturn .sav, a ROM and a truncated download all arrive
 * with plausible extensions, and none of them is a game here.
 */
export async function isSfcCart(bytes) {
  try {
    const engine = await loadSnesEngine();
    return !!engine.isSfcSav(bytes);
  } catch (e) {
    console.warn('could not check whether a file is a Dezaemon SRAM dump:', e);
    return false;
  }
}

/**
 * The cover for one dump, as a PNG data URL, or null when the cart holds no
 * picture of itself. `parseSfcSav -> composeSfcCover` — the same two calls
 * scripts/upload-sfc-saves.ts makes for the published library.
 */
export async function composeSnesShelfCover(bytes) {
  const engine = await loadSnesEngine();
  const composed = engine.composeSfcCover(engine.parseSfcSav(bytes));
  return composed ? rgbaToPngDataUrl(composed) : null;
}

/** A parse, for the facts a shelf row shows without opening the cart again. */
export async function snesCartFacts(bytes) {
  try {
    const engine = await loadSnesEngine();
    const parsed = engine.parseSfcSav(bytes);
    return {
      complete: !!parsed.complete,
      stages: (parsed.maps || []).map((m) => m.used),
      graphicsTiles: parsed.graphics?.usedCount ?? 0,
    };
  } catch (e) {
    console.warn('could not read the contents of a cart:', e);
    return null;
  }
}

/** A record already carrying a cover, or null when one could not be made. */
async function coverOrNull(rec) {
  if (typeof rec.cover === 'string' && rec.cover) return rec.cover;
  try {
    return await composeSnesShelfCover(rec.bytes);
  } catch (e) {
    // A shelf game with no picture is a worse row, not a broken one — never
    // let this stop a cart being filed or read.
    console.warn('could not render a cover for "' + rec.id + '":', e);
    return null;
  }
}

// ── The store ────────────────────────────────────────────────────────────────

function named(what, e) {
  const reason = (e && e.message) || (e && e.name) || String(e || 'unknown error');
  return new Error('the SNES shelf (IndexedDB "' + SNES_SHELF_DB + '") could not be ' + what + ': ' + reason);
}

/**
 * Open the shelf database. The helpers below open and close per operation,
 * which is what keeps a second tab's write from being blocked by a connection
 * this one left idle.
 */
export function openSnesShelf() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(named('opened', new Error('this context has no IndexedDB')));
      return;
    }
    let req;
    try { req = indexedDB.open(SNES_SHELF_DB, SNES_SHELF_VERSION); } catch (e) { reject(named('opened', e)); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNES_SHELF_STORE)) db.createObjectStore(SNES_SHELF_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(named('opened', req.error || new Error('IndexedDB unavailable')));
    req.onblocked = () => reject(named('opened', new Error('another tab is holding it open')));
  });
}

function tx(mode, what, run) {
  return openSnesShelf().then((db) => new Promise((resolve, reject) => {
    let request;
    try {
      const t = db.transaction(SNES_SHELF_STORE, mode);
      request = run(t.objectStore(SNES_SHELF_STORE));
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
 * store it will not open) has an empty shelf, not a broken launcher — the same
 * rule static/deza-shelf.js and static/ps2-library.js apply to theirs.
 */
export async function listSnesShelf() {
  let rows;
  try {
    rows = await tx('readonly', 'read', (store) => store.getAll());
  } catch (_) {
    return [];
  }
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function getSnesShelfEntry(id) {
  const rec = await tx('readonly', 'read', (store) => store.get(String(id)));
  return rec || null;
}

/**
 * File a record (replacing any with the same id) and tell the other surface.
 * `bytes` must be the SRAM dump itself — that is what the player page is handed
 * and what a download writes back out.
 *
 * A caller with no `cover` gets one rendered here from those very bytes, so
 * every road onto the shelf ends with a row that looks like its game. A caller
 * WITH one (a library install that fetched the published cover) keeps it.
 */
export async function putSnesShelfEntry(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('a shelf record needs a string id');
  if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) {
    throw new Error('a shelf record needs the SRAM bytes themselves (a Uint8Array)');
  }
  // Refusing the wrong console here rather than at each call site is what stops
  // a Saturn cart, a ROM or a half-finished download becoming a row that can
  // only ever fail to boot.
  if (!(await isSfcCart(rec.bytes))) {
    throw new Error(
      rec.bytes.length + ' bytes: not a Dezaemon SRAM dump. A Super Famicom ' +
      'cart is ' + SFC_SRAM_BYTES + ' bytes (or ' + SFC_SHORT_BYTES + ' from a ' +
      'dumper that stops early) and carries "T.TABATA" at 0x7FF8.',
    );
  }
  const cover = await coverOrNull(rec);
  const facts = rec.stages ? null : await snesCartFacts(rec.bytes);
  const title = String(rec.title || rec.id);
  const record = {
    ...rec,
    title,
    slug: rec.slug || sfcSlugOfTitle(title),
    file: rec.file || (title + '.srm'),
    size: rec.size || rec.bytes.length,
    savedAt: rec.savedAt || Date.now(),
    source: rec.source || (rec.id.startsWith('library:') ? 'library' : 'import'),
    ...(cover ? { cover } : {}),
    ...(facts ? { stages: facts.stages, complete: facts.complete } : {}),
  };
  await tx('readwrite', 'written', (store) => store.put(record));
  notifySnesShelfChanged();
  return record;
}

// Ids this session has already tried and failed to cover, so a cart whose bank
// is blank is not re-decoded on every refresh. A coverless SNES row is normal
// rather than exceptional, which is exactly why this set matters more here
// than it does on the Saturn shelf.
const uncoverable = new Set();
let backfillPending = null;

/**
 * Give every coverless row on the shelf its picture, and say how many rows
 * changed. Idempotent and free on a shelf that is already covered, so readers
 * can call it every time they open.
 *
 * Each row is written as it is rendered rather than in one batch at the end,
 * which is what makes covers appear one by one in a list that is already on
 * screen — and since that notification brings the readers straight back here,
 * concurrent calls share the one run.
 */
export function backfillSnesShelfCovers() {
  if (!backfillPending) {
    backfillPending = runBackfill().finally(() => { backfillPending = null; });
  }
  return backfillPending;
}

async function runBackfill() {
  let filled = 0;
  for (const rec of await listSnesShelf()) {
    if ((typeof rec.cover === 'string' && rec.cover) || uncoverable.has(rec.id)) continue;
    if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) continue;
    const cover = await coverOrNull(rec);
    if (!cover) { uncoverable.add(rec.id); continue; }
    await tx('readwrite', 'written', (store) => store.put({ ...rec, cover }));
    filled += 1;
    notifySnesShelfChanged();
  }
  return filled;
}

export async function removeSnesShelfEntry(id) {
  await tx('readwrite', 'written', (store) => store.delete(String(id)));
  notifySnesShelfChanged();
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
    channel = new BroadcastChannel(SNES_SHELF_CHANNEL);
    channel.onmessage = (ev) => { if (ev?.data?.type === 'changed') fire(); };
  } catch (_) { channel = null; }
  return channel;
}
function fire() {
  for (const cb of [...local]) {
    try { cb(); } catch (_) { /* one listener's throw must not starve the rest */ }
  }
}

export function notifySnesShelfChanged() {
  try { shelfChannel()?.postMessage({ type: 'changed' }); } catch (_) { /* no channel — local listeners still hear it */ }
  fire();
}

/** Subscribe to shelf changes from any tab (and this one). Returns unsubscribe. */
export function onSnesShelfChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  shelfChannel();
  local.add(cb);
  return () => { local.delete(cb); };
}
