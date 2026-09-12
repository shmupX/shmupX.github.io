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
//     source: "export" | "eshop", eshopId?, cover (data URL) }
//
// Ids: an export keeps the editor's "<slug>:<palette>", so re-exporting the
// same level replaces its row instead of growing the shelf; an eShop install
// is "eshop:<catalog id>", so the two can never collide and the launcher can
// tell them apart without a lookup.
//
// COVERS
// `cover` used to be optional and, for the editor's own exports, always
// missing: the coverflow drew a text card reading "DEZAEMON 2 / <title> / YOUR
// EXPORT" where every community save has its title screen. It is filled in
// here now, from the cart itself, by the same `composeCover` the 258 community
// covers are rendered with (`deno task deza:upload`) — so a game this browser
// made is shot by the same rule as one dumped off a Saturn cart, and no caller
// has to remember to supply one. `backfillDezaShelfCovers()` does the same for
// records filed before this existed.

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

// ── The cover ────────────────────────────────────────────────────────────────
// The 256x480 title-screen shot a shelf row wears. It is composed from the
// cart's own bytes rather than from anything the editor happened to have on
// screen, which is what makes it the game's OWN title: `composeCover` reads the
// drawn KUMITATE TITLE page straight out of the sprite bank over the busiest
// screenful of the game's scenery, and falls back to the biggest boss, then a
// strip of enemies, then CG page 0 — so a cart with no drawn title still gets a
// picture of itself instead of the base game's logo.
//
// The engine is imported lazily, exactly the way static/eshop-library.js does
// it (`new URL(...).href` keeps the specifier out of esbuild's reach, so the
// dashboard bundle leaves the import alone), and a rejected import is forgotten
// so the next shelf write retries rather than failing forever on a blip.

const ENGINE_URL = new URL('./engine/shmup-engine.js', import.meta.url).href;
let enginePending = null;
function loadEngine() {
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
  // composed.rgba is already a Uint8ClampedArray, which is what ImageData wants.
  ctx.putImageData(new ImageData(composed.rgba, composed.w, composed.h), 0, 0);
  return c.toDataURL('image/png');
}

/**
 * The cover for one cart image, as a PNG data URL, or null when the bytes hold
 * no readable game save.
 *
 * The chain is `normalize -> parse -> isGameSave -> decodeSave -> composeCover`
 * — the same four calls scripts/upload-deza-saves.ts makes for the community
 * library, so both shelves are shot by one process. It is done from the CART
 * rather than from the editor's in-memory game on purpose: whatever the browser
 * can play back out of this record is exactly what the picture shows.
 */
export async function composeShelfCover(bytes) {
  const engine = await loadEngine();
  const { data } = await engine.normalize(bytes);
  const entry = engine.parse(data).filter(engine.isGameSave)[0];
  if (!entry || !entry.payload) return null;
  return rgbaToPngDataUrl(engine.composeCover(engine.decodeSave(entry.payload.buffer)));
}

/**
 * How many can play the cart in this record: 2 when its game-mode bit1
 * (Dezaemon 2's "2P join-in") is set, 1 when not, 0 when the bytes hold no
 * readable game save. The dashboard's 2P filter reads it off the shelf for
 * the eShop's installed Dezaemon games.
 */
export async function shelfCartPlayers(bytes) {
  try {
    const engine = await loadEngine();
    const { data } = await engine.normalize(bytes);
    const entry = engine.parse(data).filter(engine.isGameSave)[0];
    if (!entry || !entry.payload) return 0;
    const decoded = engine.decodeSave(entry.payload.buffer);
    const mode = decoded && decoded.settings && decoded.settings.gameMode;
    if (typeof mode !== 'number') return 0;
    return (mode & 2) !== 0 ? 2 : 1;
  } catch (e) {
    console.warn('could not read the player count of a cart:', e);
    return 0;
  }
}

/** A record's player count, kept when it has one and read from the cart when not. */
async function playersOf(rec) {
  if (typeof rec.players === 'number' && rec.players > 0) return rec.players;
  return shelfCartPlayers(rec.bytes);
}

/** A record already carrying a cover, or null when one could not be made. */
async function coverOrNull(rec) {
  if (typeof rec.cover === 'string' && rec.cover) return rec.cover;
  try {
    return await composeShelfCover(rec.bytes);
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
 *
 * A caller that has no `cover` gets one rendered here from those very bytes, so
 * every road onto the shelf — the editor's → SAVE SHELF, an eShop install whose
 * listing carries no art, a backfill — ends with a row that has its own title
 * screen on it. A caller WITH one (an eShop install that fetched the published
 * cover) keeps it untouched.
 */
export async function putDezaShelfEntry(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('a shelf record needs a string id');
  if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) {
    throw new Error('a shelf record needs the .sav bytes themselves (a Uint8Array)');
  }
  const cover = await coverOrNull(rec);
  const players = await playersOf(rec);
  const record = {
    ...rec,
    title: String(rec.title || rec.id),
    file: rec.file || ('Dez 2 - ' + String(rec.title || rec.id) + '.sav'),
    palette: rec.palette || 'saturn',
    size: rec.size || rec.bytes.length,
    savedAt: rec.savedAt || Date.now(),
    source: rec.source || (rec.id.startsWith('eshop:') ? 'eshop' : 'export'),
    ...(cover ? { cover } : {}),
    ...(players ? { players } : {}),
  };
  await tx('readwrite', 'written', (store) => store.put(record));
  notifyDezaShelfChanged();
  return record;
}

// Ids this session has already tried and failed to cover, so a cart the
// decoders cannot read is not re-decoded on every refresh.
const uncoverable = new Set();
let backfillPending = null;

/**
 * Give every coverless row on the shelf its title screen — and every row
 * filed before player counts existed its count — and say how many rows
 * changed. For the records filed before covers existed — including the ones
 * the eShop installed from a listing published without art.
 *
 * Idempotent and free on a shelf that is already covered and counted, so both
 * readers can call it every time they open. Each row is written as it is
 * rendered rather than in one batch at the end, which is what makes covers
 * appear one by one in a coverflow that is already on screen — and since that
 * notification brings the readers straight back here, concurrent calls share
 * the one run.
 */
export function backfillDezaShelfCovers() {
  if (!backfillPending) {
    backfillPending = runBackfill().finally(() => { backfillPending = null; });
  }
  return backfillPending;
}

async function runBackfill() {
  let filled = 0;
  for (const rec of await listDezaShelf()) {
    const covered = typeof rec.cover === 'string' && rec.cover;
    const counted = typeof rec.players === 'number' && rec.players > 0;
    if ((covered || uncoverable.has(rec.id)) && counted) continue;
    if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) continue;
    const patch = {};
    if (!covered && !uncoverable.has(rec.id)) {
      const cover = await coverOrNull(rec);
      if (cover) patch.cover = cover;
      else uncoverable.add(rec.id);
    }
    if (!counted) {
      const players = await shelfCartPlayers(rec.bytes);
      // An unreadable cart is left uncounted, not retried: the cover pass
      // has already given up on it by now.
      if (players) patch.players = players;
      else if (!uncoverable.has(rec.id)) uncoverable.add(rec.id);
    }
    if (!Object.keys(patch).length) continue;
    await tx('readwrite', 'written', (store) => store.put({ ...rec, ...patch }));
    filled += 1;
    notifyDezaShelfChanged();
  }
  return filled;
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
