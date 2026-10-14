// The Nintendo 64DD library: what it takes to boot a disk the editor built,
// and where the launcher finds it.
//
// Shared on purpose, the way static/snes-library.js and static/ps2-library.js
// are: the editor imports it at runtime (`import('/n64dd-library.js')`) for
// its → PLAY 64DD row, and the dashboard can bundle it for a section. One
// lookup, one hand-off.
//
// A DISK IS NOT A GAME
// The same thing the SNES shelf has to say about a save, twice over. A disk
// out of packages/shmup-engine/src/n64/ is a data disk — Dezaemon 3D's code
// is on the cartridge, and the 64DD will not spin a disk without its own IPL
// ROM. Neither is ours to ship, so launching needs THREE files: the cartridge
// (translated to English on the way, by /api/dezaemon-n64 or `deno task
// n64:stage`), the IPL, and the disk. A machine with no cartridge or no IPL
// has a row that says so rather than a Play that could only fail.
//
// WHERE THE PLAYER IS
// static/n64dd/play.html, on this origin — the catalogue entry is `local`, as
// the Super Famicom's is, so the service worker leaves it alone. Its
// EmulatorJS and the N64 core are not vendored here (they are fetched from
// the EmulatorJS CDN at the pinned version); see the page's own header.
//
// WHERE THE CARTRIDGE AND THE IPL ARE
// Two answers, tried in that order by findN64ddRom. /api/dezaemon-n64 reads
// the operator's own disk and is what a source checkout uses. A PACKAGED
// launcher has no dev-fixtures/ to read, so `deno task n64:stage` copies the
// pair to N64DD_STATIC_ROM / N64DD_STATIC_IPL below and the same row boots
// there too.
//
// WHERE THE DISK GOES
// The player is another window, so the 64 MB disk is not posted into it: the
// editor parks it through /api/n64dd-disk (build/n64dd/ in the checkout) and
// the player is opened with the three URLs in its query string, the
// "?rom=<path>" contract every player in the catalogue already takes.

import { ensureEmuCore, readInstalledCores } from './ps2-library.js';

export const N64DD_CORE_ID = 'n64dd';
export const N64DD_CORE_LABEL = 'Nintendo 64DD';
/** Where the launcher asks whether this machine has the cartridge and the IPL. */
export const N64DD_ROM_URL = '/api/dezaemon-n64';
/** Where a disk the editor built is parked for the player. */
export const N64DD_DISK_URL = '/api/n64dd-disk';
/**
 * The pair staged into static/ by `deno task n64:stage`, for the builds the
 * route cannot answer in. Keep in step with DEFAULT_DIR and the two names in
 * scripts/stage-dezaemon-n64.ts; tests/n64dd_player_test.ts checks the set.
 */
export const N64DD_STATIC_ROM = '/n64dd/Dezaemon3D.z64';
export const N64DD_STATIC_IPL = '/n64dd/64DD_IPL.n64';
/** What the launcher calls the cartridge. Mirrors DEZAEMON_N64_TITLE in
 * lib/dezaemon-n64.ts, which static/ cannot import (plain browser ESM). */
export const N64DD_ROM_TITLE = 'Dezaemon 3D (Nintendo 64)';
/** The player, and the query it takes: rom, ipl, disk (URLs) and name. */
export const N64DD_PLAYER = '/n64dd/play.html';

const defaultFetch = (url, init) => fetch(url, init);
const msg = (e) => (e && e.message) || String(e || 'unknown error');

// ── The cartridge and the IPL ────────────────────────────────────────────────

async function askRomRoute(fetchImpl) {
  try {
    const res = await fetchImpl(N64DD_ROM_URL, { cache: 'no-store' });
    if (!res.ok) return { available: false, reason: N64DD_ROM_URL + ' answered HTTP ' + res.status };
    const body = await res.json();
    return body && typeof body === 'object' ? body : { available: false, reason: 'unreadable answer' };
  } catch (e) {
    return { available: false, reason: msg(e) };
  }
}

async function headStatic(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    await res.body?.cancel?.();
    return { url, name: url.split('/').pop(), size: Number(res.headers.get('content-length')) || 0, staged: true };
  } catch (_) {
    return null;
  }
}

/**
 * The staged pair, if this build carries it. HEADs rather than GETs: the
 * answer wanted here is "are they there", and the two files are 20 MB that
 * only a launch has any use for.
 */
async function findStagedPair(fetchImpl) {
  const [rom, ipl] = await Promise.all([headStatic(fetchImpl, N64DD_STATIC_ROM), headStatic(fetchImpl, N64DD_STATIC_IPL)]);
  if (!rom && !ipl) return null;
  const missing = [];
  if (!rom) missing.push('no ' + N64DD_STATIC_ROM + ' staged (deno task n64:stage)');
  if (!ipl) missing.push('no ' + N64DD_STATIC_IPL + ' staged (deno task n64:stage)');
  return {
    available: !!(rom && ipl),
    title: N64DD_ROM_TITLE,
    rom: rom ? { ...rom, edition: 'english', english: true, fileName: rom.name } : null,
    ipl: ipl ? { ...ipl, fileName: ipl.name } : null,
    staged: true,
    reason: missing.length ? missing.join('; ') : null,
  };
}

/**
 * Whether this machine can boot a disk: the route's answer when it has both
 * files, else the staged copies, else the route's reason. The shape is the
 * route's: { available, rom: {url, fileName, ...} | null, ipl: {...} | null,
 * reason }.
 */
export async function findN64ddRom({ fetchImpl = defaultFetch } = {}) {
  const asked = await askRomRoute(fetchImpl);
  if (asked.available) return asked;
  const staged = await findStagedPair(fetchImpl);
  if (staged && staged.available) return staged;
  // Neither complete: say what each is missing, the route's reason first.
  if (staged) {
    return {
      ...asked,
      available: false,
      rom: asked.rom || staged.rom,
      ipl: asked.ipl || staged.ipl,
      reason: [asked.reason, staged.reason].filter(Boolean).join('; ') || 'not found',
    };
  }
  return asked;
}

// ── The disk ─────────────────────────────────────────────────────────────────

/**
 * Park a disk the page built, so the player can fetch it by URL. `bytes` is a
 * .ndd or .ddd image (a .ddd comes back as an .ndd); the answer carries the
 * URL to give the player and the file's name.
 */
export async function storeN64ddDisk(bytes, name, { fetchImpl = defaultFetch } = {}) {
  const res = await fetchImpl(N64DD_DISK_URL + '?name=' + encodeURIComponent(name || 'editor.ndd'), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && (body.error || body.reason)) || (N64DD_DISK_URL + ' answered HTTP ' + res.status));
  }
  return body;
}

/** The player's URL for a cartridge, an IPL and a disk, each by URL, and a name for the window. */
export function n64ddPlayerUrl({ rom, ipl, disk, name } = {}) {
  const q = new URLSearchParams();
  if (rom) q.set('rom', rom);
  if (ipl) q.set('ipl', ipl);
  if (disk) q.set('disk', disk);
  if (name) q.set('name', name);
  return N64DD_PLAYER + '?' + q.toString();
}

// ── The core ─────────────────────────────────────────────────────────────────

/**
 * Install the Nintendo 64DD core: the catalogue entry is `local`, so all that
 * happens is the id being recorded and static/n64dd/play.html being fetched
 * once to prove it is there — see ensureEmuCore in static/ps2-library.js. The
 * core's wasm itself arrives from the EmulatorJS CDN when the page boots.
 */
export function ensureN64ddCore(onStep = () => {}) {
  return ensureEmuCore(N64DD_CORE_ID, N64DD_CORE_LABEL, onStep);
}

export function isN64ddCoreInstalled() {
  try { return readInstalledCores().includes(N64DD_CORE_ID); } catch (_) { return false; }
}
