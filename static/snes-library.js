// The SNES library: the published Super Famicom Dezaemon catalogue, what
// "install" means for one of its games, and the core that runs them.
//
// `deno task sfc:upload` publishes the collection to the Realtime Database
// under /dezaemonSfc — index, covers and the SRAM dumps themselves. This module
// is the browser half: it reads that catalogue, installs a game onto the SNES
// shelf (static/snes-shelf.js), makes sure the emulator core is installed, and
// hands a cart to the player.
//
// Shared on purpose, the way static/ps2-library.js and static/eshop-library.js
// are: the editor imports it at runtime (`import('/snes-library.js')`) for its
// "→ SNES LIBRARY" row, the dashboard bundles it to render the SUPER FAMICOM
// section. One catalogue reader, one install path, one hand-off.
//
// A SAVE IS NOT A GAME
// This is the one thing the SNES shelf does that no other shelf here has to.
// A PS2 row is a disc and a Saturn row is a cart that the disc already in the
// drive can load; a SNES row is 128 KB of SRAM belonging to a cartridge that is
// not ours to ship. So launching one needs two files — Athena's 1994 Dezaemon
// ROM, found on the operator's own disk by /api/dezaemon-sfc, and the dump off
// the shelf — and the launcher hands the player both. A machine with no ROM has
// a shelf it can fill, browse and export from, and cannot boot; the section
// says so rather than offering a Play that could only fail.
//
// WHERE THE PLAYER IS
// static/snes/play.html, on this origin. Every OTHER core in
// static/emulators.json is served by the cmg origin and mirrored onto this one
// by static/emu-sw.js, and this shelf waited on that mirror for as long as it
// has existed — cmg answers /snes/play.html with a 404, so the core installed
// and none of its rows could boot. The player is ours now, running on the
// EmulatorJS snes9x already vendored for Super Mario SP, and the catalogue
// entry is flagged `local` so the worker leaves this origin's own files alone.
//
// WHERE THE CARTRIDGE IS
// Two answers, tried in that order by findSnesRom. /api/dezaemon-sfc reads the
// operator's own disk and is what a source checkout uses. A PACKAGED launcher
// has no dev-fixtures/ to read (a compiled binary embeds _fresh/client, which
// is static/, and nothing else), so `deno task sfc:stage` copies the cart to
// SNES_STATIC_ROM below and the same shelf boots there too.

import { ensureEmuCore, readInstalledCores } from './ps2-library.js';
import {
  isLibraryShelfEntry,
  listSnesShelf,
  loadSnesEngine,
  putSnesShelfEntry,
  removeSnesShelfEntry,
  sfcSlugOfTitle,
  snesShelfIdForLibrary,
} from './snes-shelf.js';

export const SNES_RTDB = 'https://evil-invaders-default-rtdb.firebaseio.com';
/** The database node `deno task sfc:upload` writes. */
export const SNES_LIBRARY_ROOT = 'dezaemonSfc';
export const SNES_CORE_ID = 'snes';
export const SNES_CORE_LABEL = 'Super Famicom';
/** Where the launcher asks whether this machine has the cartridge. */
export const SNES_ROM_URL = '/api/dezaemon-sfc';
/**
 * The cart staged into static/ by `deno task sfc:stage`, for the builds the
 * route cannot answer in — it reads dev-fixtures/ off real disk, and a
 * packaged launcher carries no such directory. Keep in step with DEFAULT_OUT
 * in scripts/stage-dezaemon-sfc.ts; tests/snes_player_test.ts checks the pair.
 */
export const SNES_STATIC_ROM = '/snes/Dezaemon.sfc';
/** What the launcher calls the cart. Mirrors DEZAEMON_SFC_TITLE in
 * lib/dezaemon-sfc.ts, which static/ cannot import (plain browser ESM). */
export const SNES_ROM_TITLE = 'Dezaemon (Super Famicom)';
/** Bring-your-own-cart: the player is posted the ROM and the SRAM. */
export const SNES_BYOD_PLAYER = '/snes/play.html?byod=1';
export const SNES_BYOD_READY = 'snes-byod-ready';
export const SNES_BYOD_FILE = 'snes-byod-file';
/** Every install/uninstall posts { type: "changed" } here. */
export const SNES_LIBRARY_CHANNEL = 'shmupx-snes-library';

/** A library slug: RTDB-key safe and URL safe, which sfcSlugOfTitle guarantees. */
export const SNES_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const noop = () => {};
const defaultFetch = (url, init) => fetch(url, init);
const msg = (e) => (e && e.message) || String(e || 'unknown error');

// ── The catalogue ────────────────────────────────────────────────────────────

/**
 * One published row, normalised. Unknown fields are dropped rather than passed
 * through: the index is written by a script in this repo, but it is still
 * remote data and the launcher renders it.
 */
export function normalizeSnesEntry(slug, raw) {
  const id = String(slug || '').trim();
  if (!SNES_SLUG_RE.test(id)) return { error: 'bad library slug ' + JSON.stringify(slug) };
  if (!raw || typeof raw !== 'object') return { error: id + ': not a record' };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const name = str(raw.titleEn) || str(raw.fileTitle) || id;
  return {
    entry: {
      slug: id,
      name,
      title: name.toUpperCase(),
      titleJa: str(raw.titleJa) || null,
      developer: str(raw.developerEn) || null,
      developerJa: str(raw.developerJa) || null,
      genre: str(raw.genre) || null,
      genreJa: str(raw.genreJa) || null,
      // The gameplay video games-db-sfc.json carries, as a bare YouTube id.
      video: str(raw.video) || null,
      url: str(raw.url) || null,
      file: str(raw.file) || (name + '.srm'),
      dumpedAt: str(raw.dumpedAt) || null,
      savBytes: num(raw.savBytes),
      blobBytes: num(raw.blobBytes),
      // A 64 KB dump is missing its graphics bank: playable, but it will wear
      // no cover and its scenery comes from the ROM's defaults.
      complete: raw.complete !== false,
      stageCells: Array.isArray(raw.stageCells) ? raw.stageCells.map(num) : [],
      enemiesUsed: num(raw.enemiesUsed),
      graphicsTiles: num(raw.graphicsTiles),
      hasCover: !!raw.hasCover,
      updatedAt: str(raw.updatedAt) || null,
    },
  };
}

async function getJson(url, fetchImpl, what) {
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error('could not reach the ' + what + ' at ' + url + ' (' + msg(e) + ')');
  }
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new Error(url + ' answered HTTP ' + res.status);
  }
  return await res.json();
}

/**
 * The whole published catalogue, newest dump first. Fails soft the way the
 * eShop's reader does: an unreachable database is an empty library with a
 * reason, not an exception the launcher has to catch on every render.
 */
export async function loadSnesLibrary({
  rtdb = SNES_RTDB,
  fetchImpl = defaultFetch,
} = {}) {
  const base = rtdb.replace(/\/$/, '');
  const errors = [];
  const entries = [];
  let offline = false;
  try {
    const index = await getJson(base + '/' + SNES_LIBRARY_ROOT + '/index.json', fetchImpl, 'SNES library');
    for (const [slug, raw] of Object.entries(index || {})) {
      const { entry, error } = normalizeSnesEntry(slug, raw);
      if (error) errors.push(error);
      else entries.push(entry);
    }
  } catch (e) {
    offline = true;
    errors.push(msg(e));
  }
  entries.sort((a, b) =>
    (b.dumpedAt || '').localeCompare(a.dumpedAt || '') || a.name.localeCompare(b.name)
  );
  return { entries, errors, offline };
}

const covers = new Map();

/**
 * A published cover, as a PNG data URL, or null. The cover is a JSON node
 * ({ png, w, h }) rather than an image, so it cannot be an <img src> until it
 * has been through here.
 */
export async function loadSnesCover(entry, { rtdb = SNES_RTDB, fetchImpl = defaultFetch } = {}) {
  if (!entry || !entry.hasCover) return null;
  const slug = entry.slug;
  if (covers.has(slug)) return covers.get(slug);
  const url = rtdb.replace(/\/$/, '') + '/' + SNES_LIBRARY_ROOT + '/covers/' + slug + '.json';
  const pending = (async () => {
    try {
      const res = await fetchImpl(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const node = await res.json();
      return typeof node?.png === 'string' ? node.png : null;
    } catch (_) {
      return null;
    }
  })();
  covers.set(slug, pending);
  const png = await pending;
  if (!png) covers.delete(slug); // let a blip retry rather than pin a blank cover
  return png;
}

function bytesFromBase64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The SRAM dump behind one library row.
 *
 * The database stores gzip(dump) — plain gzip, no interleave and no other
 * wrapper, because an SFC dump has none (FORMAT-SFC.md) — so unwrapping is one
 * gunzip and what comes out is the file itself. The engine's gunzip is used
 * rather than DecompressionStream so this behaves identically in the dashboard
 * bundle, the editor and a test under Deno.
 */
export async function fetchSnesCart(entry, {
  rtdb = SNES_RTDB,
  fetchImpl = defaultFetch,
  engine = null,
  onProgress = noop,
} = {}) {
  const slug = entry?.slug;
  if (!SNES_SLUG_RE.test(String(slug || ''))) {
    throw new Error('bad library slug ' + JSON.stringify(slug));
  }
  const url = rtdb.replace(/\/$/, '') + '/' + SNES_LIBRARY_ROOT + '/saves/' + slug + '.json';
  onProgress(10, '⬇ CART');
  const node = await getJson(url, fetchImpl, 'published cart');
  if (!node || typeof node.sav !== 'string') {
    throw new Error('no cart published for ' + slug + ' (looked at ' + url + ')');
  }
  onProgress(60, 'UNPACKING');
  const packed = bytesFromBase64(node.sav);
  const lib = engine || await loadSnesEngine();
  const bytes = lib.isGzip(packed) ? await lib.gunzip(packed) : packed;
  // The ledger says how big the dump was before it was packed; a blob that
  // unzips to something else has been corrupted in transit or in the database,
  // and filing it would produce a shelf row that boots to a formatted cart.
  if (node.savBytes && bytes.length !== node.savBytes) {
    throw new Error(
      slug + ': the published cart unpacked to ' + bytes.length +
      ' bytes, not the ' + node.savBytes + ' it was filed as',
    );
  }
  onProgress(80, 'UNPACKED');
  return bytes;
}

/**
 * Install one published game onto this browser's SNES shelf. Re-installing
 * replaces the row, so a re-dumped game updates rather than doubling.
 */
export async function installSnesGame(entry, {
  rtdb = SNES_RTDB,
  fetchImpl = defaultFetch,
  engine = null,
  onProgress = noop,
} = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : noop;
  const bytes = await fetchSnesCart(entry, { rtdb, fetchImpl, engine, onProgress: progress });
  progress(90, 'SHELVING');
  let cover = null;
  try { cover = await loadSnesCover(entry, { rtdb, fetchImpl }); } catch (_) { cover = null; }
  const record = await putSnesShelfEntry({
    id: snesShelfIdForLibrary(entry.slug),
    slug: entry.slug,
    title: entry.name,
    file: entry.file,
    bytes,
    size: bytes.length,
    savedAt: Date.now(),
    source: 'library',
    librarySlug: entry.slug,
    ...(entry.developer ? { developer: entry.developer } : {}),
    ...(entry.genre ? { genre: entry.genre } : {}),
    ...(entry.video ? { video: entry.video } : {}),
    ...(entry.dumpedAt ? { dumpedAt: entry.dumpedAt } : {}),
    ...(cover ? { cover } : {}),
  });
  notifySnesLibraryChanged();
  progress(100, 'ON THE SHELF');
  return record;
}

export async function uninstallSnesGame(slug) {
  await removeSnesShelfEntry(snesShelfIdForLibrary(slug));
  notifySnesLibraryChanged();
}

/** The library slugs installed on this browser's shelf. */
export async function installedSnesGames() {
  const rows = await listSnesShelf();
  return rows.filter(isLibraryShelfEntry)
    .map((r) => r.librarySlug || String(r.id).replace(/^library:/, ''));
}

// ── The cartridge ────────────────────────────────────────────────────────────

/** What /api/dezaemon-sfc says about this machine, or why it said nothing. */
async function askRomRoute(fetchImpl) {
  try {
    const res = await fetchImpl(SNES_ROM_URL, { cache: 'no-store' });
    if (!res.ok) return { available: false, reason: SNES_ROM_URL + ' answered HTTP ' + res.status };
    const body = await res.json();
    return body && typeof body === 'object' ? body : { available: false, reason: 'unreadable answer' };
  } catch (e) {
    return { available: false, reason: msg(e) };
  }
}

/**
 * The staged cart, if this build carries one. A HEAD rather than a GET: the
 * answer wanted here is "is it there", and the ROM is half a megabyte that
 * only a launch has any use for.
 */
async function findStagedRom(fetchImpl) {
  try {
    const res = await fetchImpl(SNES_STATIC_ROM, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    await res.body?.cancel?.();
    return {
      available: true,
      title: SNES_ROM_TITLE,
      name: SNES_STATIC_ROM.split('/').pop(),
      size: Number(res.headers.get('content-length')) || 0,
      // Staged by `deno task sfc:stage`, which strips the copier header for
      // the same reason the route does.
      copierHeader: 0,
      rom: SNES_STATIC_ROM,
      romName: 'Dezaemon.sfc',
      source: 'staged',
    };
  } catch (_) {
    return null; // no server, no such file: the route's answer is the answer
  }
}

/**
 * The cartridge this machine can boot: `{ available, ... }`, or a
 * not-available answer when there is none.
 *
 * Two places, in order. /api/dezaemon-sfc reads the operator's own disk and is
 * the live answer in a source checkout — a ROM dropped into dev-fixtures/ is
 * found without rebuilding anything. A packaged launcher has no such directory
 * (and the deployed origin answers "local only"), so the staged copy under
 * static/ is the fallback, and the one that makes the shelf boot there. The
 * route wins when both are present: it is the file the operator is actually
 * editing, and the staged copy may be a build old.
 */
export async function findSnesRom({ fetchImpl = defaultFetch } = {}) {
  const asked = await askRomRoute(fetchImpl);
  if (asked.available) return asked;
  return await findStagedRom(fetchImpl) || asked;
}

/**
 * The ROM itself, as a File in THIS realm, for posting into the player frame.
 * `url` is whichever of the two sources findSnesRom settled on.
 */
export async function fetchSnesRomFile(
  { fetchImpl = defaultFetch, name = 'Dezaemon.sfc', url = SNES_ROM_URL + '?rom=1' } = {},
) {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' answered HTTP ' + res.status);
  const blob = await res.blob();
  return new File([blob], name, { type: 'application/octet-stream' });
}

// ── The core ─────────────────────────────────────────────────────────────────

/**
 * Install the Super Famicom core. Shares every hard part with the PS2's
 * installer — see ensureEmuCore in static/ps2-library.js — but takes the short
 * path through it: the catalogue entry is flagged `local`, so all that happens
 * is the id being recorded and static/snes/play.html being fetched once to
 * prove it is there. No mirror, no service worker, nothing downloaded.
 *
 * It can still throw (a player that 404s is a core that cannot boot), and
 * callers should go on filing the cart FIRST and treating a failure here as a
 * note on the row: a shelf that cannot boot is still a shelf.
 */
export function ensureSnesCore(onStep = () => {}) {
  return ensureEmuCore(SNES_CORE_ID, SNES_CORE_LABEL, onStep);
}

export function isSnesCoreInstalled() {
  try { return readInstalledCores().includes(SNES_CORE_ID); } catch (_) { return false; }
}

// ── Handing a cart to the player ─────────────────────────────────────────────

/**
 * The Files the player needs, in this realm.
 *
 * A File built in the LAUNCHER's realm fails EmulatorJS's `instanceof File`
 * check inside the player frame, which is why the Saturn hand-off posts a File
 * the frame then re-wraps; here both files are built by whoever is about to
 * post them, and the caller is the launcher, so they are made here and the
 * player is expected to accept them as it accepts the Saturn disc.
 *
 * `record` is a shelf row, and passing NOTHING means the bare cartridge: the
 * Dezaemon ROM with no save under it, which is the row the section leads with
 * on a machine that has the cart. A row that is present but carries no bytes is
 * still an error — that is a shelf entry that failed to load, not a request to
 * boot the cart empty.
 */
export async function snesBootFiles(record, { fetchImpl = defaultFetch } = {}) {
  const bare = record === null || record === undefined;
  if (!bare && !(record.bytes instanceof Uint8Array)) {
    throw new Error('that shelf row has no cart bytes');
  }
  const rom = await findSnesRom({ fetchImpl });
  if (!rom.available) {
    throw new Error(
      'this machine has no Dezaemon (Super Famicom) ROM, so there is no ' +
      'cartridge to run the save in: ' + (rom.reason || 'not found'),
    );
  }
  const romFile = await fetchSnesRomFile({
    fetchImpl,
    name: rom.romName || 'Dezaemon.sfc',
    url: rom.rom || SNES_ROM_URL + '?rom=1',
  });
  if (bare) {
    return { rom: romFile, sram: null, title: rom.title || SNES_ROM_TITLE };
  }
  // The save file's base name has to match the ROM's, because that is how every
  // libretro core pairs a .srm with the cartridge it belongs to.
  const sramName = romFile.name.replace(/\.[^.]+$/, '') + '.srm';
  const sram = new File([record.bytes], sramName, { type: 'application/octet-stream' });
  return { rom: romFile, sram, title: record.title || record.slug || 'Dezaemon' };
}

// ── Change notification ──────────────────────────────────────────────────────

const local = new Set();
let channel = null;
function libraryChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    channel = new BroadcastChannel(SNES_LIBRARY_CHANNEL);
    channel.onmessage = (ev) => { if (ev?.data?.type === 'changed') fire(); };
  } catch (_) { channel = null; }
  return channel;
}
function fire() {
  for (const cb of [...local]) {
    try { cb(); } catch (_) { /* one listener's throw must not starve the rest */ }
  }
}

export function notifySnesLibraryChanged() {
  try { libraryChannel()?.postMessage({ type: 'changed' }); } catch (_) { /* local listeners still hear it */ }
  fire();
}

export function onSnesLibraryChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  libraryChannel();
  local.add(cb);
  return () => { local.delete(cb); };
}

/** The id an imported dump takes on the shelf — re-exported so the editor's
 * "→ SNES LIBRARY" and this module agree without importing both files. */
export { sfcSlugOfTitle };
