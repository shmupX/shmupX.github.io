// The Dezaemon shelf: this browser's Dezaemon 2 (Sega Saturn) .sav games.
//
// Four things land here. The level editor's "→ SAVE SHELF" files the cart it
// has just built (source "export"), and the eShop installs a published
// Dezaemon game onto the same shelf (source "eshop") — see
// static/eshop-library.js. The editor also files a cart it OPENED (source
// "import") and the mod made by editing one (source "mod") — see LINEAGE
// below. The launcher's coverflow and LIBRARY and the editor's LOAD GAME
// drawer all read it, and all react when it changes.
//
// Shared on purpose, the way static/ps2-library.js is: the editor imports it
// at runtime (`import('/deza-shelf.js')`), the dashboard bundles it. The
// database and store names predate this module — the editor created them
// inline — and the records it wrote must stay readable, so nothing here bumps
// the version or renames a field. A record is:
//
//   { id, title, file, palette, bytes (Uint8Array: the full 1,114,112-byte
//     MiSTer-layout .sav), size, savedAt, warnings?, report?,
//     source: "export" | "eshop" | "import" | "mod", eshopId?,
//     cover (data URL), parent? { id, title }, changes?, web?, stats? }
//
// Ids: an export keeps the editor's "<slug>:<palette>", so re-exporting the
// same level replaces its row instead of growing the shelf; an eShop install
// is "eshop:<catalog id>", so the two can never collide and the launcher can
// tell them apart without a lookup.
//
// LINEAGE
// Two more sources arrived with the editor's IMPORT sheet. A cart opened from
// a file or a URL is filed as it came (source "import", id "import:<slug>"),
// and the first edit to any opened cart forks it: SAVE MOD files the edited
// game as its own record (source "mod", id "mod:<parent slug>:<mod slug>")
// carrying `parent: { id, title }`, so the parent is never written over and
// the launcher's LIBRARY can say which game a mod came from. A mod also
// carries `changes` (how many edits it is from its parent) and `web`: the
// edits a Dezaemon 2 cart has nowhere to put — boss attack patterns, a story —
// which the editor lays back over the cart when it opens or plays the mod.
// These two are told apart by `source` alone, never by id prefix: an export
// of a game called "Mod" is "mod:saturn", and must stay an export.
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

// ── Lineage ──────────────────────────────────────────────────────────────────

/** A cart imported as it came: "import:<slug>". */
export function dezaShelfIdForImport(title) {
  return 'import:' + slugOfTitle(title);
}

/**
 * A mod's id: "mod:<parent slug>:<mod slug>". The parent half drops the
 * parent id's own namespace ("import:", "eshop:") and palette suffix, so two
 * mods of one game sit side by side and a mod of a mod reads as what it is.
 */
export function dezaShelfIdForMod(parentId, title) {
  const parent = String(parentId || '').replace(/^(import|eshop|mod):/, '').replace(/:(saturn|snes)$/, '');
  return 'mod:' + slugOfTitle(parent) + ':' + slugOfTitle(title);
}

export function isModShelfEntry(rec) {
  return !!rec && rec.source === 'mod';
}

export function isImportShelfEntry(rec) {
  return !!rec && rec.source === 'import';
}

/** Which of the four kinds a record is: "mod" | "import" | "eshop" | "export". */
export function shelfKindOf(rec) {
  if (isModShelfEntry(rec)) return 'mod';
  if (isImportShelfEntry(rec)) return 'import';
  if (isEshopShelfEntry(rec)) return 'eshop';
  return 'export';
}

// ── OG and MOD ───────────────────────────────────────────────────────────────
// The runtime plays two kinds of game, and each brought parts the other never
// had: a web game its hit points, HUD, combo, continues and story; a Dezaemon
// cart the Saturn's weapon kit. OG plays a game with its own side's parts and
// none of the other's — a cart as the Saturn played it, a one-hit ship under
// no HUD — and MOD lets every part cross over. (MOD was REBOOT until
// 2026-10-05; normalizeVersion still reads the old word.)
//
// The parts, in the order the launcher's cards list them. `param` is the URL
// parameter game.bundle.js answers to when one part is asked for by name, and
// `from` is the side it is native to — the same table as CROSSOVER in the
// runtime, which tests/library_lineage_test.ts holds this one equal to.
export const LIBRARY_VERSIONS = ['og', 'mod'];
export const LIBRARY_FEATURES = [
  { id: 'continues', label: 'CONTINUES', param: 'continues', from: 'web' },
  { id: 'combo', label: 'COMBO MULTIPLIER', param: 'combo', from: 'web' },
  { id: 'hud', label: 'HP + COMBO HUD', param: 'hud', from: 'web' },
  { id: 'armor', label: '3-HIT SHIP', param: 'armor', from: 'web' },
  { id: 'story', label: 'STORY MODE', param: 'story', from: 'web' },
  { id: 'dezaWeapons', label: 'DEZA WEAPONS', param: 'dezaWeapons', from: 'deza' },
];

/** "og" | "mod" for anything that names a version, "" for anything that does not. */
export function normalizeVersion(version) {
  const v = String(version || '').toLowerCase();
  if (v === 'og') return 'og';
  return v === 'mod' || v === 'reboot' ? 'mod' : '';
}

/** A mod opens on MOD, everything else on OG, until the player picks. */
export function defaultVersionFor(rec) {
  return isModShelfEntry(rec) ? 'mod' : 'og';
}

/**
 * What a version sends the runtime: the word itself, as { version }. Which
 * parts that turns on depends on the side the game came from, and only the
 * runtime knows that for certain (isImportedLevel in game.bundle.js) — so the
 * launcher and the editor pass the word along and never spell the parts out.
 * An unknown version sends nothing, which the runtime plays as OG.
 */
export function versionParams(version) {
  const v = normalizeVersion(version);
  return v ? { version: v } : {};
}

/**
 * The parts a version plays a game with, as [{ id, label, on }]: its own
 * side's in OG, every one in MOD. `side` is "deza" for a cart — everything on
 * this shelf — or "web".
 */
export function versionFeatures(version, side = 'deza') {
  const mod = normalizeVersion(version) === 'mod';
  return LIBRARY_FEATURES.map((f) => ({ id: f.id, label: f.label, on: mod || f.from === side }));
}

/**
 * The shelf as the launcher's LIBRARY lays it out: every game followed by its
 * mods (each group newest first), then any mod whose parent is no longer on
 * the shelf. Takes records or light rows — anything with { id, source,
 * parent?, savedAt? } — and returns { cards, games, mods }, where a card is
 * the row plus { kind, isMod, parentId, parentTitle, parentOnShelf, mods }.
 */
export function libraryCards(rows) {
  const list = (rows || []).filter((r) => r && r.id);
  const newest = (a, b) => (b.savedAt || 0) - (a.savedAt || 0);
  const byId = new Map(list.map((r) => [r.id, r]));
  const modsOf = new Map();
  const orphans = [];
  for (const r of list) {
    if (!isModShelfEntry(r)) continue;
    const pid = r.parent && r.parent.id;
    if (pid && byId.has(pid) && pid !== r.id) {
      if (!modsOf.has(pid)) modsOf.set(pid, []);
      modsOf.get(pid).push(r);
    } else orphans.push(r);
  }
  const card = (r) => {
    const isMod = isModShelfEntry(r);
    const pid = isMod && r.parent ? r.parent.id || '' : '';
    const parent = pid ? byId.get(pid) : null;
    return {
      ...r,
      kind: shelfKindOf(r),
      isMod,
      parentId: pid,
      parentTitle: isMod ? String((parent && parent.title) || (r.parent && r.parent.title) || '') : '',
      parentOnShelf: !!parent,
      mods: (modsOf.get(r.id) || []).length,
    };
  };
  const cards = [];
  const walk = (r, seen) => {
    cards.push(card(r));
    seen.add(r.id);
    // A mod of a mod nests the same way; `seen` stops a cycle a hand-edited
    // record could make.
    for (const m of (modsOf.get(r.id) || []).slice().sort(newest)) if (!seen.has(m.id)) walk(m, seen);
  };
  const seen = new Set();
  for (const r of list.filter((x) => !isModShelfEntry(x)).sort(newest)) walk(r, seen);
  for (const r of orphans.sort(newest)) if (!seen.has(r.id)) walk(r, seen);
  for (const r of list) if (!seen.has(r.id)) walk(r, seen);
  const mods = cards.filter((c) => c.isMod).length;
  return { cards, games: cards.length - mods, mods };
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

// Ids this session has already tried and failed to cover — and, separately,
// to count — so a cart the decoders cannot read is not re-decoded on every
// refresh. Two sets, because a cart can be coverless and still countable.
const uncoverable = new Set();
const uncountable = new Set();
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
    const covered = (typeof rec.cover === 'string' && rec.cover) || uncoverable.has(rec.id);
    const counted = (typeof rec.players === 'number' && rec.players > 0) || uncountable.has(rec.id);
    if (covered && counted) continue;
    if (!(rec.bytes instanceof Uint8Array) || !rec.bytes.length) continue;
    const patch = {};
    if (!covered) {
      const cover = await coverOrNull(rec);
      if (cover) patch.cover = cover;
      else uncoverable.add(rec.id);
    }
    if (!counted) {
      const players = await shelfCartPlayers(rec.bytes);
      // A cart the decoder cannot read is given up on rather than re-read on
      // every refresh — the same bargain the covers make.
      if (players) patch.players = players;
      else uncountable.add(rec.id);
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
