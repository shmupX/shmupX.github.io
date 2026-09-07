// The eShop: shmupX's global game list, and what "install" means for each
// kind of game in it.
//
// The catalog has two halves. data/eshop.json in this repo (added by pull
// request, served through static/games.manifest.json) lists web builds —
// zips of a finished browser game — and community Dezaemon carts; the Firebase
// RTDB at /eshop/ lists Dezaemon 2 games published straight from the level
// editor. This module reads both as one list, installs either kind, tells the
// launcher what is installed, and publishes from the editor.
//
// Shared on purpose, the way static/ps2-library.js is: the editor imports it
// at runtime (`import('/eshop-library.js')`) to publish and to install onto
// the shelf; the dashboard bundles it to render the eShop and the installed
// rows. One catalog reader, one install path per kind, one change signal —
// the two surfaces cannot drift.
//
// WHERE AN INSTALL LIVES
// A web game becomes files in Cache Storage under "/eshop/<id>/…", answered
// by static/emu-sw.js (the one service worker, scope "/"), so an installed
// game is a same-origin page — which is the only kind gamepad-support.js can
// feed mapped keys to, and the only kind that still opens offline. A Dezaemon
// game becomes a record on the Dezaemon shelf (static/deza-shelf.js), beside
// the editor's own exports, because that is where the launcher's coverflow
// and the editor's LOAD GAME drawer already look.
//
// A web install counts only once "/eshop/<id>/.complete" exists, and that
// marker is written strictly LAST. An install interrupted mid-unzip must read
// as not installed rather than boot to a black frame with half its assets —
// the launcher upstream learned that the hard way.

import { readyEmuWorker, EMU_SW } from './ps2-library.js';
import {
  dezaShelfIdForEshop,
  isEshopShelfEntry,
  listDezaShelf,
  putDezaShelfEntry,
  removeDezaShelfEntry,
  slugOfTitle,
} from './deza-shelf.js';

export const ESHOP_CACHE = 'shmupx-eshop-v1';
export const ESHOP_PREFIX = '/eshop/';
export const ESHOP_RTDB = 'https://evil-invaders-default-rtdb.firebaseio.com';
export const ESHOP_CHANNEL = 'shmupx-eshop';

/** A catalog id: RTDB-key safe, URL safe, and the folder name under /eshop/. */
export const ESHOP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A release status, as a game's own codemonkey.json (or a catalog row) spells
 * it: an UPPER_SNAKE token — RELEASED, EARLY_ACCESS, BETA, … A blank one
 * reads as RELEASED everywhere it is shown.
 */
export const STATUS_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** "early access" / "Early-Access" / "EARLY_ACCESS" → "EARLY_ACCESS"; anything else "". */
export function normalizeStatus(v) {
  const s = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_RE.test(s) ? s : '';
}

/** "EARLY_ACCESS" → "EARLY ACCESS": what a chip, a filter or the disc panel shows. */
export function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ');
}

/** A Dezaemon 2 cart as MiSTer writes it: (32 KB + 512 KB) x 2 for the 0xFF interleave. */
export const MISTER_SAV_BYTES = 1114112;
/** The same cart with the filler stripped — what the RTDB stores gzipped. */
export const LOGICAL_SAV_BYTES = 557056;

// Resolved against this module's own URL, so the same string works from the
// dashboard bundle (/dashboard.bundle.js), the editor's runtime import
// (/eshop-library.js) and a Deno test (static/eshop-library.js): the engine and
// the unzipper sit beside it under the static root in every case, and the
// browser hands back the very module instance the editor already holds as
// window.Dezaemon, since the resolved URL is the same.
const ENGINE_URL = new URL('./engine/shmup-engine.js', import.meta.url).href;
const ZIP_READ_URL = new URL('./zip-read.js', import.meta.url).href;

const noop = () => {};
// `fetch` called through a local binding, never as a detached global: some
// embedders reject the latter with "Illegal invocation".
const defaultFetch = (url, init) => fetch(url, init);
const msg = (e) => (e && e.message) || String(e || 'unknown error');
const SHA_RE = /^[0-9a-f]{40}$/i;

// ── The catalog ──────────────────────────────────────────────────────────────

/**
 * One catalog entry, whichever half it came from, in the shape every consumer
 * reads. Returns { entry } or { error } — never throws, because one bad row
 * must not take the rest of the shop down.
 *
 * `origin` is "manifest" (data/eshop.json via games.manifest.json) or "rtdb"
 * (published from the editor; `key` is the RTDB key, which is the id).
 */
export function normalizeEshopEntry(raw, origin = 'manifest', key = '') {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const id = origin === 'rtdb' ? String(key || raw.id || '') : String(raw.id || '');
  if (!ESHOP_ID_RE.test(id)) return { error: 'bad id ' + JSON.stringify(id) };
  const kind = raw.kind === 'web' || raw.kind === 'deza' ? raw.kind : null;
  if (!kind) return { error: id + ': kind ' + JSON.stringify(raw.kind) + ' is not web or deza' };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '';
  if (!name) return { error: id + ': no name' };
  const str = (v) => (typeof v === 'string' ? v : '');
  const sizeLabel = str(raw.sizeLabel) || str(raw.size) || (Number.isFinite(raw.size) ? mbLabel(raw.size) : '');
  const entry = {
    id,
    kind,
    name,
    title: str(raw.title) || name.toUpperCase(),
    sub: str(raw.sub),
    icon: str(raw.icon) || null,
    size: sizeLabel,
    date: str(raw.date),
    source: str(raw.source),
    origin,
    hasCover: false,
    coverUrl: null,
    // Pinned on the row, or — when the row leaves it blank — read from the
    // game's own codemonkey.json by applyGameManifests().
    status: normalizeStatus(raw.status),
  };
  if (kind === 'web') {
    entry.repo = str(raw.repo);
    entry.source = entry.source || (entry.repo ? 'github' : 'url');
    entry.branch = str(raw.branch) || 'main';
    entry.entry = cleanRel(raw.entry) || 'index.html';
    entry.subdir = cleanRel(raw.subdir);
    entry.downloadUrl = str(raw.downloadUrl);
    entry.streamUrl = str(raw.streamUrl);
    // Launcher capabilities, verbatim: the dashboard reads them exactly as it
    // reads a manifest game's.
    if (raw.twinStick !== undefined) entry.twinStick = raw.twinStick;
    if (raw.touchControls !== undefined) entry.touchControls = raw.touchControls;
    if (raw.levelEditor !== undefined) entry.levelEditor = raw.levelEditor;
    if (!entry.downloadUrl && !githubRepo(entry)) {
      return { error: id + ': a web entry needs a downloadUrl or a GitHub repo' };
    }
  } else {
    entry.source = entry.source || (origin === 'rtdb' ? 'editor' : 'manifest');
    entry.sav = str(raw.sav);
    entry.slug = str(raw.slug);
    entry.file = str(raw.file);
    entry.palette = raw.palette === 'snes' ? 'snes' : 'saturn';
    entry.author = str(raw.author);
    entry.publishedAt = Number(raw.publishedAt) || 0;
    entry.stages = Number(raw.stages) || 0;
    entry.cells = Number(raw.cells) || 0;
    entry.sizeBytes = Number.isFinite(raw.size) ? raw.size : 0;
    entry.hasCover = !!raw.hasCover || typeof raw.cover === 'string';
    // An RTDB cover is a JSON node ({ png: data URL, w, h }), not an image:
    // read it through loadEshopCover(), which is what turns this into <img src>.
    if (typeof raw.cover === 'string') entry.coverUrl = raw.cover;
  }
  return { entry };
}

/**
 * The whole catalog: manifest entries first, then games published from the
 * editor, de-duplicated by id (a static entry wins over an RTDB row of the
 * same id, so a pull request can pin a published game). Each half fails soft:
 * an unreachable database still leaves the manifest's games installable, and
 * vice versa. `offline` is true only when neither half answered.
 */
export async function loadEshopCatalog({
  manifestUrl = '/games.manifest.json',
  rtdb = ESHOP_RTDB,
  fetchImpl = defaultFetch,
  gameManifests = true,
} = {}) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  const sources = { manifest: 'error', rtdb: 'error' };

  try {
    const res = await fetchImpl(manifestUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const manifest = await res.json();
    sources.manifest = 'ok';
    // An older manifest (built before data/eshop.json existed) simply lists
    // nothing here; that is not a fault.
    const rows = Array.isArray(manifest?.eshop) ? manifest.eshop : [];
    rows.forEach((raw, i) => {
      const { entry, error } = normalizeEshopEntry(raw, 'manifest');
      if (error) { errors.push('manifest[' + i + ']: ' + error); return; }
      if (seen.has(entry.id)) { errors.push('manifest[' + i + ']: duplicate id ' + entry.id); return; }
      seen.add(entry.id);
      entries.push(entry);
    });
  } catch (e) {
    errors.push('manifest: ' + msg(e) + ' (' + manifestUrl + ')');
  }

  const indexUrl = rtdb.replace(/\/$/, '') + '/eshop/index.json';
  try {
    const res = await fetchImpl(indexUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const index = await res.json();
    sources.rtdb = 'ok';
    // A node whose keys all look numeric comes back as an array; nulls are
    // deleted rows. Same walk either way.
    const rows = Array.isArray(index)
      ? index.map((row, i) => [String(i), row]).filter(([, row]) => row)
      : index && typeof index === 'object' ? Object.entries(index) : [];
    rows.sort((a, b) => (Number(b[1]?.publishedAt) || 0) - (Number(a[1]?.publishedAt) || 0));
    for (const [key, raw] of rows) {
      const { entry, error } = normalizeEshopEntry(raw, 'rtdb', key);
      if (error) { errors.push('rtdb/' + key + ': ' + error); continue; }
      if (seen.has(entry.id)) continue; // the static entry wins, silently
      seen.add(entry.id);
      if (entry.hasCover && !entry.coverUrl) entry.coverUrl = rtdb.replace(/\/$/, '') + '/eshop/covers/' + entry.id + '.json';
      entries.push(entry);
    }
  } catch (e) {
    errors.push('rtdb: ' + msg(e) + ' (' + indexUrl + ')');
  }

  // What each GitHub-tracked build says about itself, from its repo's own
  // codemonkey.json — its release status. After both halves, so a status a
  // static row pinned is already in place to win.
  if (gameManifests) errors.push(...await applyGameManifests(entries, fetchImpl));

  return { entries, errors, sources, offline: sources.manifest !== 'ok' && sources.rtdb !== 'ok' };
}

// Covers are read once per id and kept: the RTDB node is ~50 KB of data URL
// and the same row is drawn by the shop, the shelf and the installer.
const covers = new Map();
/**
 * The cover as something an <img> can show (a data URL), or null. Reads an
 * RTDB cover node, passes a manifest entry's image URL straight through.
 */
export async function loadEshopCover(entry, fetchImpl = defaultFetch) {
  if (!entry || !entry.hasCover) return null;
  const url = entry.coverUrl;
  if (!url) return null;
  if (!/\/eshop\/covers\/[^/]+\.json$/.test(url)) return url;
  if (covers.has(entry.id)) return covers.get(entry.id);
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
  covers.set(entry.id, pending);
  const png = await pending;
  if (!png) covers.delete(entry.id); // let a blip retry rather than pin a blank cover
  return png;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * The GitHub owner/repo an entry tracks, or null when it tracks none.
 *
 * Accepts a bare owner/name, a github.com URL (with or without .git), an scp
 * remote (git@github.com:owner/name) and a host-qualified path. Anything
 * hosted elsewhere is NOT a GitHub repo — null, so an update check no-ops
 * instead of asking api.github.com about a deploy host as if it were an owner.
 * Ported from the launcher upstream, where exactly that had happened.
 */
export function githubRepo(entry) {
  const raw = String(typeof entry === 'string' ? entry : entry?.repo || '').trim().replace(/\.git$/, '');
  if (!raw) return null;
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    if (scp[1] !== 'github.com') return null;
    const p = scp[2].split('/').filter(Boolean);
    return p.length >= 2 ? { owner: p[0], repo: p[1] } : null;
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
      const p = u.pathname.split('/').filter(Boolean);
      return p.length >= 2 ? { owner: p[0], repo: p[1] } : null;
    } catch (_) { return null; }
  }
  const p = raw.split('/').filter(Boolean);
  if (p[0] === 'github.com' || p[0] === 'www.github.com') return p.length >= 3 ? { owner: p[1], repo: p[2] } : null;
  // Bare form: a first segment with a dot is a host, not an owner (GitHub
  // owners never contain one), so a scheme-less deploy URL cannot slip through.
  if (p.length >= 2 && !p[0].includes('.')) return { owner: p[0], repo: p[1] };
  return null;
}

/**
 * The latest commit on the entry's branch, as the full 40-hex sha, or null on
 * any failure (offline, rate-limited, not a GitHub repo). The vnd.github.sha
 * media type makes the body the bare sha — no JSON to parse.
 */
export async function latestSha(entry, fetchImpl = defaultFetch) {
  const r = githubRepo(entry);
  if (!r) return null;
  const branch = String(entry?.branch || 'main');
  try {
    const res = await fetchImpl(
      'https://api.github.com/repos/' + r.owner + '/' + r.repo + '/commits/' + encodeURIComponent(branch),
      { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store' },
    );
    if (!res.ok) return null;
    const sha = (await res.text()).trim().toLowerCase();
    return SHA_RE.test(sha) ? sha : null;
  } catch (_) {
    return null;
  }
}

/**
 * The game's own codemonkey.json — the file the cmg launcher has always let a
 * game ship at its root — as raw.githubusercontent.com serves it off the
 * tracked branch; null for anything that tracks no GitHub repo.
 */
export function gameManifestUrl(entry) {
  const r = githubRepo(entry);
  if (!r || entry?.kind !== 'web') return null;
  return 'https://raw.githubusercontent.com/' + r.owner + '/' + r.repo + '/' + String(entry.branch || 'main') + '/codemonkey.json';
}

/**
 * Take from a game's codemonkey.json what the catalog row left blank: its
 * release status today. A static row's own value wins, so a pull request can
 * pin one. Mutates and returns the entry.
 */
export function mergeGameManifest(entry, manifest) {
  if (!entry || !manifest || typeof manifest !== 'object') return entry;
  if (!entry.status) entry.status = normalizeStatus(manifest.status);
  return entry;
}

/**
 * Read every GitHub-tracked web entry's own codemonkey.json, in parallel, and
 * merge it (mergeGameManifest). Fails soft per entry: a repo without the file
 * (404) is the normal case and says nothing; a host that will not answer, or
 * a file that is not JSON, leaves the entry as it was and is reported in the
 * returned error lines.
 */
export async function applyGameManifests(entries, fetchImpl = defaultFetch) {
  const errors = [];
  await Promise.all((entries || []).map(async (entry) => {
    const url = gameManifestUrl(entry);
    if (!url) return;
    let manifest;
    try {
      const res = await fetchImpl(url, { cache: 'no-store' });
      if (res.status === 404) return;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      manifest = await res.json();
    } catch (e) {
      errors.push(entry.id + ': codemonkey.json ' + msg(e) + ' (' + url + ')');
      return;
    }
    mergeGameManifest(entry, manifest);
  }));
  return errors;
}

/**
 * Where the zip comes from.
 *
 * No downloadUrl on a GitHub entry: the local route /api/eshop/zip streams
 * the codeload zipball (pinned with &ref= when the sha is known). A
 * raw.githubusercontent.com URL on the tracked repo's branch is rewritten to
 * the sha when known, so the install is the exact newest build regardless of
 * what the raw CDN still has cached for the branch — and the sha recorded
 * with the install is then true by construction. Anything else is used as is.
 */
export function resolveDownloadUrl(entry, sha = null) {
  const url = String(entry?.downloadUrl || '').trim();
  const r = githubRepo(entry);
  const branch = String(entry?.branch || 'main');
  const pinned = sha && SHA_RE.test(String(sha)) ? String(sha).toLowerCase() : null;
  if (!url) {
    if (!r) throw new Error((entry?.id || 'this entry') + ' has no downloadUrl and tracks no GitHub repo');
    return '/api/eshop/zip?repo=' + encodeURIComponent(r.owner) + '/' + encodeURIComponent(r.repo) +
      '&branch=' + encodeURIComponent(branch).replace(/%2F/g, '/') + (pinned ? '&ref=' + pinned : '');
  }
  if (!pinned || !r) return url;
  let u;
  try { u = new URL(url); } catch (_) { return url; }
  if (u.hostname !== 'raw.githubusercontent.com') return url;
  const parts = u.pathname.split('/'); // ['', owner, repo, ...ref and path]
  if (parts.length < 5) return url;
  // Only the tracked repo's own raw URL: a sha from repo A pinned onto a file
  // in repo B would 404.
  if (parts[1].toLowerCase() !== r.owner.toLowerCase() || parts[2].toLowerCase() !== r.repo.toLowerCase()) return url;
  const rest = parts.slice(3).join('/');
  const heads = 'refs/heads/' + branch + '/';
  const plain = branch + '/';
  const tail = rest.startsWith(heads) ? rest.slice(heads.length) : rest.startsWith(plain) ? rest.slice(plain.length) : null;
  if (tail === null || !tail) return url;
  u.pathname = '/' + parts[1] + '/' + parts[2] + '/' + pinned + '/' + tail;
  return u.href;
}

/** The same-origin page an installed web game opens at. */
export function entryUrl(entry) {
  return ESHOP_PREFIX + String(entry?.id || '') + '/' + (cleanRel(entry?.entry) || 'index.html');
}

// ── Cache Storage: the installed web games ───────────────────────────────────

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** The Content-Type a cached file is served with; wasm and js are the ones that matter. */
export function contentTypeFor(path) {
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// A relative path inside an install: forward slashes, no leading "./" or "/",
// no empty segments. "" for nothing.
function cleanRel(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');
}

async function openCache() {
  try {
    if (typeof caches === 'undefined') throw new Error('this context has no Cache Storage');
    return await caches.open(ESHOP_CACHE);
  } catch (e) {
    throw new Error('Cache Storage ("' + ESHOP_CACHE + '"), where installed games live, could not be opened: ' + msg(e));
  }
}

// The cache key of one installed file. The path goes in raw and the URL parser
// percent-encodes it exactly as it will encode the game's own request for the
// same file, so the two meet; only "?" and "#" — which a request could never
// carry as path characters — are escaped by hand so the key keeps its tail.
const keyFor = (id, rel) => ESHOP_PREFIX + id + '/' + rel.replace(/#/g, '%23').replace(/\?/g, '%3F');
const completeKey = (id) => keyFor(id, '.complete');
const sourceKey = (id) => keyFor(id, '.source');
const prefixOf = (id) => ESHOP_PREFIX + id + '/';

function pathOf(req) {
  try { return decodeURIComponent(new URL(req.url).pathname); } catch (_) { return ''; }
}

async function readSource(cache, id) {
  try {
    const res = await cache.match(sourceKey(id));
    return res ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

/** Installed iff the entry page and the .complete marker are both cached. */
export async function webInstallState(id) {
  try {
    const cache = await openCache();
    const source = await readSource(cache, id);
    const entry = cleanRel(source?.entry) || 'index.html';
    const [page, complete] = await Promise.all([cache.match(keyFor(id, entry)), cache.match(completeKey(id))]);
    return { installed: !!(page && complete), source };
  } catch (_) {
    return { installed: false, source: null };
  }
}

// Every cached key under "/eshop/<id>/", deleted. Returns how many went.
async function purge(cache, id) {
  const prefix = prefixOf(id);
  const keys = (await cache.keys()).filter((req) => pathOf(req).startsWith(prefix));
  await Promise.all(keys.map((req) => cache.delete(req)));
  return keys.length;
}

/** True while any web game is installed — the worker must then stay registered. */
export async function hasInstalledWebGames() {
  try {
    const cache = await openCache();
    return (await cache.keys()).some((req) => {
      const p = pathOf(req);
      return p.startsWith(ESHOP_PREFIX) && p.endsWith('/.complete');
    });
  } catch (_) {
    return false;
  }
}

/** The installed subset of `entries`, each carrying its `.state` ({ installed, source }). */
export async function installedWebGames(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || entry.kind !== 'web') continue;
    const state = await webInstallState(entry.id);
    if (state.installed) out.push({ ...entry, state });
  }
  return out;
}

/**
 * Register the service worker that serves /eshop/ and wait for it to control
 * this page. Shares ps2-library's memoised registration: the emulator mirror
 * and the eShop are the same worker, and two register() calls racing each
 * other gain nothing. Resolves to the registration, or null when there can be
 * none (no API, insecure context, refused) — installWebGame turns that null
 * into a message that says which.
 */
export function ensureEshopWorker() {
  return readyEmuWorker();
}

async function requireWorker() {
  const reg = await ensureEshopWorker();
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!reg || !sw) {
    throw new Error(
      !sw
        ? 'this browser has no service worker API, so an installed game could not be served'
        : typeof window !== 'undefined' && !window.isSecureContext
        ? 'this page is not a secure context (' + location.origin + '): a service worker — which is what ' +
          'serves an installed game — needs https or localhost'
        : 'the service worker at ' + EMU_SW + ' would not register, so an installed game could not be served',
    );
  }
  // Registered is not controlling. A hard reload (or DevTools' "Bypass for
  // network") leaves the page outside its worker, and every /eshop/ path
  // would then 404 against the origin. Say so BEFORE the download, not after.
  if (!sw.controller) {
    throw new Error(
      'the service worker is registered but is not in front of this page, which is what a hard ' +
      'reload leaves behind — reload the page and try again',
    );
  }
  return reg;
}

// "8 MB" → bytes, for a progress bar when the server sends no content-length
// (GitHub's codeload zipball never does).
function estimateBytes(label) {
  const m = String(label || '').match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!m) return 0;
  const unit = { kb: 1024, mb: 1048576, gb: 1073741824 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * unit) || 0;
}
const mbLabel = (n) => (n / 1048576).toFixed(1) + ' MB';

/**
 * GET the zip, reading the body as a stream so progress is real and so the
 * bytes never go through res.blob() — see fetchArtifact in ps2-library.js for
 * the worker-mediated failure that rules that out. Reports 0–80.
 */
async function downloadZip(url, sizeHint, onProgress) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', mode: 'cors' });
  } catch (e) {
    const local = url.startsWith('/');
    throw new Error(
      'could not reach ' + url + ' (' + msg(e) + ')' +
      (local
        ? ' — nothing is answering on this origin; is the app (or `deno task dev`) still running?'
        : ' — offline, or the host does not allow this origin to read it'),
    );
  }
  if (!res.ok) throw new Error(url + ' answered HTTP ' + res.status);
  const declared = Number(res.headers.get('content-length')) || 0;
  const total = declared || estimateBytes(sizeHint);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      // An estimated total may be wrong; keep an estimate short of "done".
      const pct = total ? Math.min(declared ? 80 : 79, Math.round((got / total) * 80)) : 0;
      onProgress(pct, '⬇ ' + (total ? pct + '%' : mbLabel(got)));
    }
  } catch (e) {
    throw new Error('the download broke off after ' + mbLabel(got) + (declared ? ' of ' + mbLabel(declared) : '') + ' (' + msg(e) + ')');
  }
  // Short, not merely different: a cross-origin host that gzips the transfer
  // declares the ENCODED length while the reader yields decoded bytes (and
  // Content-Encoding is not a CORS-exposed header, so it cannot be checked),
  // which is more bytes than declared, never fewer.
  if (declared && got < declared) {
    throw new Error('the download arrived short — ' + mbLabel(got) + ' of ' + mbLabel(declared));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

let zipReader = null;
function loadZipReader() {
  if (!zipReader) {
    zipReader = import(ZIP_READ_URL).catch((e) => {
      zipReader = null;
      throw new Error('the unzipper (' + ZIP_READ_URL + ') could not be loaded: ' + msg(e));
    });
  }
  return zipReader;
}

let engineModule = null;
function loadEngine() {
  if (!engineModule) {
    engineModule = import(ENGINE_URL).catch((e) => {
      engineModule = null;
      throw new Error('the Dezaemon engine (' + ENGINE_URL + ') could not be loaded: ' + msg(e));
    });
  }
  return engineModule;
}

// A GitHub codeload zipball wraps every file in "<repo>-<branch>/" (or
// "<repo>-<sha>/" when fetched by sha). Strip exactly that wrapper, and only
// when every entry shares it, so a catalog entry can say entry:"index.html"
// whatever the branch — while a committed zip that keeps its own top folder
// (referenced by subdir/entry) is left intact.
function stripWrapper(files, entry, sha) {
  if (!files.length) return files;
  const first = files[0].path;
  const slash = first.indexOf('/');
  if (slash === -1) return files;
  const top = first.slice(0, slash + 1);
  if (!files.every((f) => f.path.startsWith(top))) return files;
  const r = githubRepo(entry);
  if (!r) return files;
  const branch = String(entry.branch || 'main').replace(/\//g, '-');
  const wrappers = [r.repo + '-' + branch + '/'];
  if (sha) wrappers.push(r.repo + '-' + sha + '/', r.repo + '-' + sha.slice(0, 7) + '/');
  if (!wrappers.some((w) => w.toLowerCase() === top.toLowerCase())) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(top.length) })).filter((f) => f.path);
}

// `subdir` names the folder inside the archive that becomes the game's root.
function applySubdir(files, subdir) {
  const sub = cleanRel(subdir);
  if (!sub || sub === 'root') return files;
  const prefix = sub + '/';
  const kept = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) })).filter((f) => f.path);
  if (!kept.length) {
    throw new Error('the archive has no "' + sub + '/" folder (it holds ' + topLevel(files) + ')');
  }
  return kept;
}

// The archive's root codemonkey.json as an object, or null (absent, or not JSON).
function readShippedManifest(files) {
  const f = files.find((x) => x.path === 'codemonkey.json');
  if (!f) return null;
  try {
    return JSON.parse(new TextDecoder().decode(f.data));
  } catch (_) {
    return null;
  }
}

function topLevel(files) {
  const names = [...new Set(files.map((f) => f.path.split('/')[0]))];
  if (!names.length) return 'nothing';
  return names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
}

// Godot registers its own cross-origin-isolation worker when this flag is on.
// It would fight emu-sw.js for the scope, and a game framed by the launcher
// cannot be isolated anyway (the launcher is not), so the flag is turned off
// and the game runs single-threaded. Cheap, and a no-op for everything else.
function rewriteHtml(body) {
  const text = new TextDecoder().decode(body);
  if (!text.includes('ensureCrossOriginIsolationHeaders')) return body;
  return new TextEncoder().encode(
    text.replace(/"ensureCrossOriginIsolationHeaders"\s*:\s*true/g, '"ensureCrossOriginIsolationHeaders":false'),
  );
}

const textResponse = (text, type = 'text/plain') => new Response(text, { headers: { 'Content-Type': type } });

/**
 * Install (or, with `force`, reinstall) a web game: worker → sha → zip →
 * unzip → files under "/eshop/<id>/" → .source → .complete. `onProgress(pct,
 * label)` runs 0–80 through the download and 80–100 through the cache writes.
 * Throws an Error whose message names the step that failed.
 */
export async function installWebGame(entry, { onProgress = noop, force = false } = {}) {
  if (!entry || entry.kind !== 'web') throw new Error('only a web entry can be installed this way');
  const id = String(entry.id || '');
  if (!ESHOP_ID_RE.test(id)) throw new Error('bad catalog id ' + JSON.stringify(id));
  const progress = typeof onProgress === 'function' ? onProgress : noop;

  if (!force) {
    const state = await webInstallState(id);
    if (state.installed) {
      progress(100, 'INSTALLED');
      return { ok: true, sha: state.source?.sha || null, files: state.source?.files || 0, already: true };
    }
  }

  await requireWorker();
  progress(0, 'CHECKING');
  const sha = await latestSha(entry);
  const url = resolveDownloadUrl(entry, sha);
  const zipBytes = await downloadZip(url, entry.size, progress);

  progress(80, 'UNPACKING');
  const { unzip } = await loadZipReader();
  let files;
  try {
    files = (await unzip(zipBytes)).filter((f) => !f.dir);
  } catch (e) {
    throw new Error('the archive from ' + url + ' could not be read: ' + msg(e));
  }
  files = stripWrapper(files, entry, sha);
  files = applySubdir(files, entry.subdir);
  const page = cleanRel(entry.entry) || 'index.html';
  if (!files.some((f) => f.path === page)) {
    throw new Error(page + ' is not in the archive (its top level holds ' + topLevel(files) + ')');
  }
  // The build's own codemonkey.json, when it ships one at the archive root:
  // its release status is recorded with the install, so the launcher can
  // still show it with the catalog unreachable.
  const shipped = readShippedManifest(files);

  const cache = await openCache();
  // Invalidate before writing: if this (re)install dies mid-way the game must
  // read as NOT installed, and no file of an older build may survive under
  // the new one.
  await cache.delete(completeKey(id));
  await purge(cache, id);
  let n = 0;
  for (const f of files) {
    const body = /\.html?$/i.test(f.path) ? rewriteHtml(f.data) : f.data;
    try {
      await cache.put(keyFor(id, f.path), new Response(body, { headers: { 'Content-Type': contentTypeFor(f.path) } }));
    } catch (e) {
      throw new Error('could not cache ' + f.path + ' (' + msg(e) + ') — the browser may be out of storage');
    }
    n++;
    progress(80 + Math.round((n / files.length) * 20), 'INSTALLING ' + n + ' / ' + files.length);
  }
  // What this install came from. checkWebUpdate compares downloadUrl and date
  // to the live catalog (the CATALOG's values, not the sha-pinned URL, or the
  // comparison would never hold), so editing either in data/eshop.json is the
  // update lever for a zip with no repo to track.
  const source = {
    downloadUrl: entry.downloadUrl || '',
    resolvedUrl: url,
    date: entry.date || '',
    sha,
    installedAt: Date.now(),
    entry: page,
    files: n,
    repo: entry.repo || '',
    branch: entry.branch || 'main',
    status: entry.status || normalizeStatus(shipped?.status),
  };
  await cache.put(sourceKey(id), textResponse(JSON.stringify(source), 'application/json'));
  // Every file landed — only now does the install count.
  await cache.put(completeKey(id), textResponse('1'));
  notifyEshopChanged();
  progress(100, 'INSTALLED');
  return { ok: true, sha, files: n };
}

/** Drop every cached file of a web game. Answers with what the cache says afterwards. */
export async function uninstallWebGame(id) {
  const cache = await openCache();
  // The marker first, so a purge that fails half-way cannot leave the game
  // looking installed with files missing.
  await cache.delete(completeKey(id));
  const removed = await purge(cache, id);
  const after = await webInstallState(id);
  notifyEshopChanged();
  return { removed, installed: after.installed };
}

/**
 * Is a newer build available for an installed web game? Flagged when the
 * recorded sha and GitHub's current one are both known and differ, or when
 * the catalog's downloadUrl/date no longer match what was installed. A
 * missing baseline stays "installed" — no false prompts.
 */
export async function checkWebUpdate(entry) {
  const state = await webInstallState(entry?.id);
  if (!state.installed) return { updateAvailable: false, installedSha: null, latestSha: null, reason: 'not installed' };
  const src = state.source || {};
  const installedSha = SHA_RE.test(String(src.sha || '')) ? String(src.sha).toLowerCase() : null;
  const catalogChanged = ('downloadUrl' in src || 'date' in src) &&
    (String(src.downloadUrl || '') !== String(entry.downloadUrl || '') || String(src.date || '') !== String(entry.date || ''));
  const latest = githubRepo(entry) ? await latestSha(entry) : null;
  const shaChanged = !!(installedSha && latest && installedSha !== latest);
  return {
    updateAvailable: catalogChanged || shaChanged,
    installedSha,
    latestSha: latest,
    reason: shaChanged ? 'a newer commit on ' + (entry.branch || 'main') : catalogChanged ? 'the catalog entry changed' : '',
  };
}

// ── Dezaemon games: the shelf ────────────────────────────────────────────────

function bytesFromBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 32 KB slices: String.fromCharCode over a whole cart blows the argument limit.
function base64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function getJson(url, fetchImpl, what) {
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error('could not reach ' + url + ' (' + msg(e) + ') — the ' + what + ' cannot be read');
  }
  if (!res.ok) throw new Error(url + ' answered HTTP ' + res.status + ' — the ' + what + ' cannot be read');
  return await res.json();
}

// The cart bytes, still wrapped however the source wrapped them (gzip, raw,
// interleaved): entry.sav first, then the eShop's own node, then the community
// library's.
async function fetchSavBytes(entry, fetchImpl, rtdb, onProgress) {
  const base = rtdb.replace(/\/$/, '');
  const tried = [];
  if (entry.sav) {
    const url = entry.sav;
    tried.push(url);
    let res;
    try {
      res = await fetchImpl(url, { cache: 'no-store' });
    } catch (e) {
      throw new Error('could not reach ' + url + ' (' + msg(e) + ')');
    }
    if (!res.ok) throw new Error(url + ' answered HTTP ' + res.status);
    onProgress(40, '⬇ SAVE');
    return new Uint8Array(await res.arrayBuffer());
  }
  const own = base + '/eshop/saves/' + entry.id + '.json';
  tried.push(own);
  const node = await getJson(own, fetchImpl, 'published save');
  if (node && typeof node.sav === 'string') {
    onProgress(40, '⬇ SAVE');
    return bytesFromBase64(node.sav);
  }
  const slug = entry.slug || entry.id;
  const community = base + '/dezaemon/saves/' + slug + '.json';
  tried.push(community);
  const row = await getJson(community, fetchImpl, 'community save');
  if (row && typeof row.sav === 'string') {
    onProgress(40, '⬇ SAVE');
    return bytesFromBase64(row.sav);
  }
  throw new Error('no save found for ' + entry.id + ' (looked at ' + tried.join(', ') + ')');
}

/**
 * Whatever a save source hands over → the full MiSTer-layout cart the shelf
 * stores. normalize() unwraps gzip and strips an interleave; a 557,056-byte
 * logical image is re-interleaved, a 1,114,112-byte one is kept, anything
 * else is not a Dezaemon 2 cart.
 */
export async function dezaBytesForShelf(bytes, engine = null) {
  const eng = engine || await loadEngine();
  const { data } = await eng.normalize(bytes);
  if (data.length === LOGICAL_SAV_BYTES) return eng.interleave(data);
  if (data.length === MISTER_SAV_BYTES) return data;
  throw new Error(
    'the save is ' + data.length.toLocaleString() + ' bytes once unwrapped — not a Dezaemon 2 cart image ' +
    '(expected ' + LOGICAL_SAV_BYTES.toLocaleString() + ' logical or ' + MISTER_SAV_BYTES.toLocaleString() + ' interleaved)',
  );
}

/**
 * Put a Dezaemon game on the shelf as an installed eShop entry
 * ("eshop:<id>"). Resolves to the shelf record. `onProgress(pct, label)`.
 */
export async function installDezaGame(entry, { onProgress = noop, fetchImpl = defaultFetch, engine = null, rtdb = ESHOP_RTDB } = {}) {
  if (!entry || entry.kind !== 'deza') throw new Error('only a Dezaemon entry can go on the shelf');
  const id = String(entry.id || '');
  if (!ESHOP_ID_RE.test(id)) throw new Error('bad catalog id ' + JSON.stringify(id));
  const progress = typeof onProgress === 'function' ? onProgress : noop;
  progress(0, '⬇ SAVE');
  const raw = await fetchSavBytes(entry, fetchImpl, rtdb, progress);
  progress(70, 'UNPACKING');
  const bytes = await dezaBytesForShelf(raw, engine);
  progress(90, 'SHELVING');
  let cover = null;
  try { cover = await loadEshopCover(entry, fetchImpl); } catch (_) { cover = null; }
  const name = entry.name || entry.title || id;
  const record = await putDezaShelfEntry({
    id: dezaShelfIdForEshop(id),
    title: name,
    file: entry.file || ('Dez 2 - ' + name + '.sav'),
    palette: entry.palette || 'saturn',
    bytes,
    size: bytes.length,
    savedAt: Date.now(),
    source: 'eshop',
    eshopId: id,
    ...(cover ? { cover } : {}),
  });
  notifyEshopChanged();
  progress(100, 'ON THE SHELF');
  return record;
}

/** Take an eShop Dezaemon game off the shelf. Accepts the catalog id or the shelf id. */
export async function uninstallDezaGame(id) {
  const shelfId = String(id || '').startsWith('eshop:') ? String(id) : dezaShelfIdForEshop(id);
  await removeDezaShelfEntry(shelfId);
  notifyEshopChanged();
}

/** The shelf rows that came from the eShop (source "eshop"), newest first. */
export async function installedDezaGames() {
  return (await listDezaShelf()).filter(isEshopShelfEntry);
}

// ── Publishing from the editor ───────────────────────────────────────────────

function mmddyy(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '.' + p(d.getDate()) + '.' + String(d.getFullYear()).slice(-2);
}

async function rtdbPut(base, node, id, value, fetchImpl) {
  const path = '/eshop/' + node + '/' + id;
  let res;
  try {
    // print=silent: without it the database echoes the whole value back, and
    // a save node is ~1 MB of base64.
    res = await fetchImpl(base + path + '.json?print=silent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch (e) {
    throw new Error('could not reach the eShop database at ' + base + ' (' + msg(e) + ') while writing ' + path);
  }
  if (!res.ok) {
    let text = '';
    try { text = (await res.text()).slice(0, 200); } catch (_) { /* the status is the message */ }
    throw new Error('the eShop database refused ' + path + ' (HTTP ' + res.status + (text ? ': ' + text : '') + ')');
  }
  try { await res.body?.cancel(); } catch (_) { /* nothing to drain */ }
}

async function rtdbDelete(base, node, id, fetchImpl) {
  const path = '/eshop/' + node + '/' + id;
  let res;
  try {
    res = await fetchImpl(base + path + '.json', { method: 'DELETE' });
  } catch (e) {
    throw new Error('could not reach the eShop database at ' + base + ' (' + msg(e) + ') while deleting ' + path);
  }
  if (!res.ok) throw new Error('the eShop database refused to delete ' + path + ' (HTTP ' + res.status + ')');
}

// A cover as { png, w, h }: the editor hands a data URL, and its size is read
// off the image when this context can decode one (a Deno test cannot; 0 then).
async function coverNode(cover) {
  if (!cover) return null;
  if (typeof cover === 'object' && typeof cover.png === 'string') {
    return { png: cover.png, w: Number(cover.w) || 0, h: Number(cover.h) || 0 };
  }
  if (typeof cover !== 'string' || !cover.startsWith('data:image/')) return null;
  let w = 0, h = 0;
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(await (await fetch(cover)).blob());
      w = bmp.width;
      h = bmp.height;
      bmp.close?.();
    }
  } catch (_) { /* size unknown — the PNG itself still carries it */ }
  return { png: cover, w, h };
}

/**
 * Publish a Dezaemon game to the eShop: gzip(deinterleave(sav)) → /eshop/saves,
 * the cover → /eshop/covers, and the index row LAST, so a half-published game
 * never lists. The publisher's own shelf gets the game as an installed eShop
 * entry at once (softly: a shelf that will not write is reported in
 * `shelfError`, not thrown — the publish itself succeeded).
 *
 * `sav` is the 1,114,112-byte MiSTer image the exporter builds (a 557,056-byte
 * logical image is accepted too). `id` defaults to slugOfTitle(name).
 */
export async function publishDezaGame({
  id = '',
  name,
  sav,
  palette = 'saturn',
  report = null,
  cover = null,
  author = '',
  sub = '',
  fetchImpl = defaultFetch,
  engine = null,
  rtdb = ESHOP_RTDB,
  onProgress = noop,
} = {}) {
  const title = String(name || '').trim();
  if (!title) throw new Error('a published game needs a name');
  if (!(sav instanceof Uint8Array)) throw new Error('publish needs the .sav bytes (a Uint8Array)');
  const gameId = String(id || '').trim() || slugOfTitle(title);
  if (!ESHOP_ID_RE.test(gameId)) throw new Error('bad eShop id ' + JSON.stringify(gameId) + ' — lowercase letters, digits and dashes only');
  const progress = typeof onProgress === 'function' ? onProgress : noop;
  const base = String(rtdb || ESHOP_RTDB).replace(/\/$/, '');
  const pal = palette === 'snes' ? 'snes' : 'saturn';

  const eng = engine || await loadEngine();
  let logical, full;
  if (sav.length === MISTER_SAV_BYTES) {
    logical = eng.deinterleave(sav);
    full = sav;
  } else if (sav.length === LOGICAL_SAV_BYTES) {
    logical = sav;
    full = eng.interleave(sav);
  } else {
    throw new Error('the .sav is ' + sav.length.toLocaleString() + ' bytes; a Dezaemon 2 cart is ' + MISTER_SAV_BYTES.toLocaleString());
  }
  if (logical.length !== LOGICAL_SAV_BYTES) {
    throw new Error('the .sav is not an interleaved cart image (its even bytes are not the 0xFF filler)');
  }

  progress(10, 'PACKING');
  const gz = await gzipBytes(logical);
  const publishedAt = Date.now();
  const savesNode = {
    sav: base64FromBytes(gz),
    encoding: 'gzip+base64',
    interleaveProfile: 'ff-even',
    logicalSize: LOGICAL_SAV_BYTES,
    blobBytes: gz.length,
    publishedAt,
  };
  const png = await coverNode(cover);
  const stages = Array.isArray(report?.stages) ? report.stages.length : Number(report?.stages) || 0;
  const cells = Number(report?.cells) || 0;
  const file = 'Dez 2 - ' + title + '.sav';
  const index = {
    schemaVersion: 1,
    kind: 'deza',
    name: title,
    title: title.toUpperCase(),
    sub: String(sub || '') || (stages + ' STAGE' + (stages === 1 ? '' : 'S') + ' · ' + cells + '/1024 CG CELLS · ' + pal.toUpperCase() + ' PALETTE'),
    ...(author ? { author: String(author) } : {}),
    file,
    palette: pal,
    size: MISTER_SAV_BYTES,
    sizeLabel: mbLabel(MISTER_SAV_BYTES),
    date: mmddyy(publishedAt),
    publishedAt,
    hasCover: !!png,
    stages,
    cells,
    source: 'editor',
  };

  progress(30, 'UPLOADING SAVE');
  await rtdbPut(base, 'saves', gameId, savesNode, fetchImpl);
  if (png) {
    progress(70, 'UPLOADING COVER');
    await rtdbPut(base, 'covers', gameId, { ...png, publishedAt }, fetchImpl);
  }
  progress(85, 'LISTING');
  await rtdbPut(base, 'index', gameId, index, fetchImpl);

  // On the publisher's own shelf too, as the installed eShop entry it now is.
  let shelf = null;
  let shelfError = '';
  try {
    shelf = await putDezaShelfEntry({
      id: dezaShelfIdForEshop(gameId),
      title,
      file,
      palette: pal,
      bytes: full,
      size: full.length,
      savedAt: publishedAt,
      ...(report ? { report } : {}),
      source: 'eshop',
      eshopId: gameId,
      ...(png ? { cover: png.png } : {}),
    });
  } catch (e) {
    shelfError = msg(e);
  }
  covers.delete(gameId);
  notifyEshopChanged();
  progress(100, 'PUBLISHED');
  return { id: gameId, index, shelf, shelfError };
}

/** Delist a published game: index first (so it vanishes at once), then its save and cover. */
export async function unpublishDezaGame(id, fetchImpl = defaultFetch, rtdb = ESHOP_RTDB) {
  const gameId = String(id || '').trim();
  if (!ESHOP_ID_RE.test(gameId)) throw new Error('bad eShop id ' + JSON.stringify(gameId));
  const base = String(rtdb || ESHOP_RTDB).replace(/\/$/, '');
  for (const node of ['index', 'saves', 'covers']) await rtdbDelete(base, node, gameId, fetchImpl);
  covers.delete(gameId);
  notifyEshopChanged();
  return { id: gameId, deleted: ['index', 'saves', 'covers'] };
}

// ── Change notification ──────────────────────────────────────────────────────
// Installs happen in the editor's frame as well as the launcher's page, and in
// other tabs. A BroadcastChannel reaches the other tabs; a postMessage to the
// parent reaches the launcher above an editor frame, whose onWindowMessage
// accepts { type: "cmg-eshop-changed" } from its own frame; and local
// subscribers are called directly, since a channel never echoes to the object
// that posted.

const local = new Set();
let channel = null;
function eshopChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    channel = new BroadcastChannel(ESHOP_CHANNEL);
    channel.onmessage = (ev) => { if (ev?.data?.type === 'changed') fire(); };
  } catch (_) { channel = null; }
  return channel;
}
function fire() {
  for (const cb of [...local]) {
    try { cb(); } catch (_) { /* one listener's throw must not starve the rest */ }
  }
}

export function notifyEshopChanged() {
  try { eshopChannel()?.postMessage({ type: 'changed' }); } catch (_) { /* no channel — local listeners still hear it */ }
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'cmg-eshop-changed' }, '*');
    }
  } catch (_) { /* a parent that will not take messages is not our problem */ }
  fire();
}

/** Subscribe to eShop changes from any tab, frame, or this context. Returns unsubscribe. */
export function onEshopChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  eshopChannel();
  local.add(cb);
  return () => { local.delete(cb); };
}
