// The remote export queue, browser side: ask a desktop to build a level into
// an APK / PS2 disc / desktop app, watch it happen, and collect the result.
//
// A phone, a browser on codemonkey.games or the installed PWA has no toolchain
// and no /api/build-apk (the hosted origin is read-only). A desktop running
// shmupX — the packaged app or `deno task dev` — has both, and runs the build
// server in lib/export-worker.ts. The two never talk directly; the Realtime
// Database sits between them:
//
//   exportWorkers/<code>            the desktop's heartbeat: name, targets,
//                                   last seen — "detected" means seen lately
//   exportQueue/<code>/<jobId>      one job: level, platform, status,
//                                   progress line, log tail, artifact list
//   exportBlobs/<jobId>/<i>/<n>     the artifact bytes, 512 KB base64 chunks
//
// The BUILD CODE — eight letters the desktop shows in Settings and prints at
// launch — is the pairing. Type it once here and every export from this
// browser is addressed to that desktop. (There is no Firebase Storage on the
// project, which is why the bytes ride the database; see the worker's notes.)
//
// Shared on purpose, like static/ps2-library.js: the editor imports it at
// runtime (`import('/export-queue.js')`) to queue and collect, the dashboard
// imports it at bundle time to list the same jobs in Settings → EXPORTS and to
// toast when one is ready. One store, one job list, one hand-off.

export const EXPORT_DB = 'https://evil-invaders-default-rtdb.firebaseio.com';
// Keep in step with lib/export-worker.ts (tests/export_queue_test.ts checks).
export const EXPORT_PATHS = { workers: 'exportWorkers', queue: 'exportQueue', blobs: 'exportBlobs' };
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
// A worker heartbeats every 20 s; three missed beats is gone.
export const WORKER_ONLINE_MS = 65_000;

export const BUILDER_CODE_KEY = 'shmupx-builder-code';
const CLIENT_ID_KEY = 'shmupx-export-client';
const JOBS_KEY = 'shmupx-export-jobs';

/** What each target is called once it is built. */
export const PLATFORM_ARTIFACTS = {
  android: 'APK',
  ios: 'iOS app',
  linux: 'AppImage',
  windows: 'MSI',
  ps2: 'PS2 disc',
  desktop: 'desktop app',
};

// ── Codes and identity ──────────────────────────────────────────────────────

export function normalizeBuilderCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return '';
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return '';
  return code;
}

export function formatBuilderCode(code) {
  return code ? code.slice(0, 4) + '-' + code.slice(4) : '';
}

function readLocal(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) { return fallback; }
}
function writeLocal(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) { /* private mode — the session still works, it just forgets */ }
}

/** The paired desktop's code, or '' when none has been typed in yet. */
export function getBuilderCode() {
  return normalizeBuilderCode(readLocal(BUILDER_CODE_KEY, ''));
}
export function setBuilderCode(raw) {
  const code = normalizeBuilderCode(raw);
  writeLocal(BUILDER_CODE_KEY, code || null);
  return code;
}

/** A stable id for this browser, so a job knows who asked for it. */
export function getClientId() {
  let id = readLocal(CLIENT_ID_KEY, '');
  if (!id) {
    id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    writeLocal(CLIENT_ID_KEY, id);
  }
  return id;
}

/** "Android · PWA", "iPhone · browser" — for the desktop's own log. */
export function requesterLabel() {
  const ua = navigator.userAgent || '';
  let device = 'browser';
  if (/android/i.test(ua)) device = 'Android';
  else if (/iphone|ipod/i.test(ua)) device = 'iPhone';
  else if (/ipad/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) device = 'iPad';
  else if (/windows/i.test(ua)) device = 'Windows';
  else if (/macintosh/i.test(ua)) device = 'Mac';
  else if (/linux/i.test(ua)) device = 'Linux';
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
  return device + ' · ' + (standalone ? 'PWA' : 'web');
}

/** Ids sort chronologically, which is the order the worker builds in. */
export function newJobId() {
  return Date.now().toString(36).padStart(9, '0') + '-' + Math.random().toString(36).slice(2, 8);
}

// ── The database over REST ──────────────────────────────────────────────────

function dbUrl(path) {
  return EXPORT_DB + '/' + path + '.json';
}

async function dbRequest(method, path, body) {
  const res = await fetch(dbUrl(path), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(method + ' ' + path + ': HTTP ' + res.status);
  return await res.json();
}

/** One REST-streaming event applied to a local mirror of the watched subtree. */
export function applyAtPath(root, path, data, merge) {
  const keys = String(path || '/').split('/').filter(Boolean);
  if (!keys.length) {
    if (merge) return Object.assign({}, root, data || {});
    return data || {};
  }
  const next = Object.assign({}, root);
  let node = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const child = node[keys[i]];
    const copy = child && typeof child === 'object' ? Object.assign({}, child) : {};
    node[keys[i]] = copy;
    node = copy;
  }
  const last = keys[keys.length - 1];
  if (merge) {
    const existing = node[last];
    node[last] = Object.assign({}, existing && typeof existing === 'object' ? existing : {}, data || {});
  } else if (data === null || data === undefined) delete node[last];
  else node[last] = data;
  return next;
}

/**
 * Watch a database path and call `cb(value)` with the whole subtree on every
 * change. The REST API streams server-sent events, and EventSource sends the
 * `Accept: text/event-stream` it wants on its own. Returns an unsubscribe.
 *
 * `cb(null, error)` reports a stream that dropped; EventSource reconnects by
 * itself, and the next `put` re-sends the whole subtree.
 */
export function watchPath(path, cb) {
  let mirror = {};
  let es;
  try {
    es = new EventSource(dbUrl(path));
  } catch (e) {
    cb(null, e);
    return () => {};
  }
  const apply = (merge) => (ev) => {
    let body;
    try { body = JSON.parse(ev.data); } catch (_) { return; }
    mirror = applyAtPath(mirror, body.path || '/', body.data, merge);
    cb(mirror);
  };
  es.addEventListener('put', apply(false));
  es.addEventListener('patch', apply(true));
  es.addEventListener('error', () => cb(null, new Error('stream dropped')));
  return () => { try { es.close(); } catch (_) {} };
}

// ── The desktop ─────────────────────────────────────────────────────────────

/** True when the worker record was heartbeated lately and not stopped since. */
export function workerOnline(worker, now = Date.now()) {
  if (!worker || typeof worker.seenAt !== 'number') return false;
  if (typeof worker.stoppedAt === 'number' && worker.stoppedAt >= worker.seenAt) return false;
  return now - worker.seenAt < WORKER_ONLINE_MS;
}

/** The targets a worker says it can build, upper-cased, in the editor's order. */
export function workerTargets(worker) {
  const order = ['android', 'ios', 'linux', 'windows', 'ps2'];
  const p = (worker && worker.platforms) || {};
  return order.filter((k) => p[k]).map((k) => k.toUpperCase());
}

/** A one-line reading of a worker record for a status row. */
export function describeWorker(worker, now = Date.now()) {
  if (!worker) return { online: false, text: 'no desktop with this code has been seen yet' };
  const online = workerOnline(worker, now);
  const name = worker.name || 'desktop';
  const targets = workerTargets(worker);
  if (online) {
    const busy = worker.busy && worker.busy.level
      ? ' · building "' + worker.busy.level + '"'
      : '';
    return {
      online: true,
      text: name + ' is online · builds ' + (targets.length ? targets.join(' ') : 'nothing it could detect') + busy,
    };
  }
  const ago = typeof worker.seenAt === 'number' ? relativeTime(now - worker.seenAt) : 'never';
  return { online: false, text: name + ' is offline (last seen ' + ago + ') — a queued export waits until it opens shmupX' };
}

export function relativeTime(ms) {
  if (!(ms >= 0)) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 36) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}

export function fetchWorker(code) {
  return dbRequest('GET', EXPORT_PATHS.workers + '/' + code);
}

/** Live view of one desktop. `cb({ worker, online, text })`. */
export function watchWorker(code, cb) {
  if (!normalizeBuilderCode(code)) return () => {};
  let latest = null;
  const tell = () => cb(Object.assign({ worker: latest }, describeWorker(latest)));
  const stop = watchPath(EXPORT_PATHS.workers + '/' + code, (value, err) => {
    if (err) return;
    latest = value && Object.keys(value).length ? value : null;
    tell();
  });
  // "Online" is a function of the clock, not only of the record.
  const tick = setInterval(tell, 15000);
  return () => { clearInterval(tick); stop(); };
}

// ── This browser's jobs ─────────────────────────────────────────────────────

function readJobs() {
  try {
    const v = JSON.parse(readLocal(JOBS_KEY, '[]'));
    return Array.isArray(v) ? v.filter((j) => j && j.code && j.id) : [];
  } catch (_) { return []; }
}
function writeJobs(list) {
  writeLocal(JOBS_KEY, JSON.stringify(list));
  // A same-tab listener (the storage event only fires in OTHER tabs).
  try { window.dispatchEvent(new CustomEvent('shmupx-export-jobs')); } catch (_) {}
}

/** Jobs queued from this browser, newest first: { code, id, level, platform, requestedAt }. */
export function listLocalJobs() {
  return readJobs().sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
}

export function forgetJob(code, id) {
  writeJobs(readJobs().filter((j) => !(j.code === code && j.id === id)));
}

/**
 * Queue `level` for `platform` on the desktop with `code`. The level must
 * already be saved to the cloud — the desktop reads it from there, exactly as
 * a local export does. Answers the job record.
 */
export async function queueExport({ code, level, platform }) {
  code = normalizeBuilderCode(code);
  if (!code) throw new Error('a BUILD CODE is needed — open shmupX on the desktop that should build this and read it off Settings');
  if (!level) throw new Error('the game needs a name');
  const id = newJobId();
  const job = {
    id,
    level: String(level),
    platform: String(platform || 'android').toLowerCase(),
    requester: getClientId(),
    requesterLabel: requesterLabel(),
    requestedAt: Date.now(),
    status: 'queued',
    progress: 'waiting for the desktop',
    attempts: 0,
  };
  await dbRequest('PUT', EXPORT_PATHS.queue + '/' + code + '/' + id, job);
  const list = readJobs();
  list.push({ code, id, level: job.level, platform: job.platform, requestedAt: job.requestedAt });
  writeJobs(list);
  return job;
}

/** Take a job back while it is still waiting. No effect once it is building. */
export async function cancelJob(code, id) {
  const path = EXPORT_PATHS.queue + '/' + code + '/' + id;
  const job = await dbRequest('GET', path);
  if (job && job.status === 'queued') {
    await dbRequest('PATCH', path, { status: 'cancelled', finishedAt: Date.now(), updatedAt: Date.now() });
    return true;
  }
  return false;
}

/** Drop a job and its bytes, from the database and from this browser's list. */
export async function dismissJob(code, id) {
  forgetJob(code, id);
  try { await dbRequest('DELETE', EXPORT_PATHS.blobs + '/' + id); } catch (_) {}
  try { await dbRequest('DELETE', EXPORT_PATHS.queue + '/' + code + '/' + id); } catch (_) {}
}

/** Tell the desktop the bytes have landed, so it can free the chunks. */
export async function markReceived(code, id) {
  try {
    await dbRequest('PATCH', EXPORT_PATHS.queue + '/' + code + '/' + id, { received: Date.now(), updatedAt: Date.now() });
  } catch (_) { /* the worker frees them after a day regardless */ }
}

/**
 * Watch every job this browser queued. `cb(jobs)` gets the full records,
 * newest first, each with `code` attached; a job the database no longer has
 * comes through with status 'gone'. One stream per desktop, however many
 * jobs are on it. Returns an unsubscribe.
 */
export function watchJobs(cb) {
  const streams = new Map(); // code → { stop, mirror }
  let stopped = false;
  const emit = () => {
    if (stopped) return;
    const local = listLocalJobs();
    cb(local.map((j) => {
      const s = streams.get(j.code);
      const rec = s && s.mirror ? s.mirror[j.id] : undefined;
      if (rec) return Object.assign({}, rec, { code: j.code, id: j.id });
      return { id: j.id, code: j.code, level: j.level, platform: j.platform, requestedAt: j.requestedAt, status: s && s.mirror ? 'gone' : 'connecting' };
    }));
  };
  const sync = () => {
    const wanted = new Set(listLocalJobs().map((j) => j.code));
    for (const [code, s] of streams) if (!wanted.has(code)) { s.stop(); streams.delete(code); }
    for (const code of wanted) {
      if (streams.has(code)) continue;
      const s = { stop: null, mirror: null };
      s.stop = watchPath(EXPORT_PATHS.queue + '/' + code, (value, err) => {
        if (err) return;
        s.mirror = value || {};
        emit();
      });
      streams.set(code, s);
    }
    emit();
  };
  sync();
  const onLocal = () => sync();
  window.addEventListener('shmupx-export-jobs', onLocal);
  window.addEventListener('storage', onLocal);
  return () => {
    stopped = true;
    window.removeEventListener('shmupx-export-jobs', onLocal);
    window.removeEventListener('storage', onLocal);
    for (const s of streams.values()) s.stop();
    streams.clear();
  };
}

// ── Collecting an artifact ──────────────────────────────────────────────────

function decodeChunk(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pull one artifact of a finished job out of the database and hand it back as
 * a Blob. `onProgress(received, total)` is called as chunks land. Four chunks
 * in flight, assembled in order.
 *
 * @param {{ artifacts?: any[], blobsFreed?: boolean }} job
 * @param {number} index
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function fetchQueuedArtifact(job, index, onProgress = () => {}) {
  const art = job && job.artifacts && job.artifacts[index];
  if (!art) throw new Error('that job has no such artifact');
  if (job.blobsFreed) throw new Error('the desktop has already freed this build — export it again');
  if (art.url) {
    // A future Storage-backed record: the browser can just fetch it.
    const res = await fetch(art.url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + art.name);
    return await res.blob();
  }
  const parts = new Array(art.chunks);
  let received = 0;
  let next = 0;
  const pull = async () => {
    while (next < art.chunks) {
      const i = next++;
      const b64 = await dbRequest('GET', art.path + '/' + i);
      if (typeof b64 !== 'string') throw new Error('chunk ' + i + ' of ' + art.name + ' is missing — the build may have been freed');
      parts[i] = decodeChunk(b64);
      received += parts[i].length;
      onProgress(received, art.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, art.chunks) }, pull));
  if (received !== art.size) {
    throw new Error(art.name + ' arrived short — ' + received + ' of ' + art.size + ' bytes');
  }
  return new Blob(parts, { type: art.contentType || 'application/octet-stream' });
}

/** Hand a Blob to the browser's download (on Android, an APK goes on to the installer). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'export';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── Describing a job ────────────────────────────────────────────────────────

export function jobArtifactLabel(job) {
  return PLATFORM_ARTIFACTS[(job && job.platform) || ''] || 'export';
}

export function jobTitle(job) {
  return jobArtifactLabel(job) + ' · ' + ((job && job.level) || '?');
}

/** A short status line for a row. */
export function jobStatusText(job, now = Date.now()) {
  if (!job) return '';
  switch (job.status) {
    case 'queued': return 'QUEUED · ' + (job.progress || 'waiting for the desktop');
    case 'building': return 'BUILDING · ' + (job.progress || '…');
    case 'done': return job.blobsFreed ? 'EXPIRED · export it again' : 'READY · ' + relativeTime(now - (job.finishedAt || now));
    case 'failed': return 'FAILED · ' + (job.error || 'see the log');
    case 'cancelled': return 'CANCELLED';
    case 'gone': return 'GONE · the desktop or a requester removed it';
    case 'connecting': return 'CONNECTING…';
    default: return String(job.status || '').toUpperCase();
  }
}

/** The label for an artifact's own button. */
export function artifactActionLabel(art) {
  switch (art && art.kind) {
    case 'iso': return 'DOWNLOAD DISC (.ISO)';
    case 'usb-zip': return 'DOWNLOAD USB FOLDER (.ZIP)';
    case 'apk': return 'INSTALL APK';
    case 'exe': return 'DOWNLOAD .EXE';
    case 'msi': return 'DOWNLOAD INSTALLER (.MSI)';
    case 'appimage': return 'DOWNLOAD APPIMAGE';
    case 'ipa': return 'DOWNLOAD .IPA';
    case 'dmg': return 'DOWNLOAD .DMG';
    default: return 'DOWNLOAD ' + ((art && art.name) || 'FILE');
  }
}

/** The disc artifact of a finished PS2 job, or null. */
export function ps2DiscArtifact(job) {
  if (!job || !job.artifacts) return null;
  const i = job.artifacts.findIndex((a) => a.kind === 'iso');
  return i < 0 ? null : { index: i, artifact: job.artifacts[i] };
}

/** A system notification for a finished job, when the page already may. */
export function notifyJobDone(job) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification('shmupX export ready', {
      body: jobTitle(job) + ' is ready to download.',
      tag: 'shmupx-export-' + job.id,
    });
    n.onclick = () => { try { window.focus(); } catch (_) {} };
  } catch (_) { /* not a notifying context */ }
}

/** Ask once, from a user gesture, so notifyJobDone can fire later. */
export function requestNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch (_) {}
}
