// The launcher's half of the watch music remote: a song picked on the wrist
// plays here, in the docked music player, and what is playing is reported
// back.
//
//   watch  --> /builders/<code>/music/launch    one slot, latest press wins
//   watch  --> /builders/<code>/music/control   pause · resume · stop · next ·
//                                               prev · sync
//   here   --> /builders/<code>/music/playing   what the player is doing
//   here   --> /builders/<code>/music/library   the albums it can play
//
// The other end is the watchAmp app's ♪ Desktop music screen
// (tools/watchamp/, remote/RemoteBridge.kt). The two never talk directly —
// the Realtime Database sits between them, which is why the watch needs no
// companion app and this page needs no inbound port. It is the same database,
// the same code and the same shape of code as static/watch-launch.js, which
// starts games the same way; `music` is its own subtree so one code pairs a
// wrist to both without the two stepping on each other's `launch`.
//
// THE WATCH CODE is the pairing. On a desktop running shmupX it is the BUILD
// CODE the launcher already shows (Settings › BUILD SERVER), so one code
// pairs the wrist to everything; on the hosted site, which has no build
// server, this page makes one up the first time the remote is switched on
// and remembers it. Either way it is shown in Settings › WATCH REMOTE and in
// the Guide's Music section, and typed once on the watch.
//
// SECURITY. The database is open-read and open-write with no auth, so anything
// arriving here was written by whoever knows the code — which is meant to be
// the owner's watch and might not be. Every field is therefore untrusted:
// `action` is matched against a fixed list, and `album`/`track` are looked up
// in the library the player itself reported rather than passed through. Nothing
// here is eval'd, fetched or navigated to on the strength of what a record
// said. What is published is ids and titles — never a track's URL.
//
// Ported from cmg's static/watch-music.js; the protocol is byte-for-byte the
// one watchAmp was verified against, so a watch paired to cmg pairs here the
// same way.

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  EXPORT_DB,
  formatBuilderCode,
  normalizeBuilderCode,
} from './export-queue.js';

export const WATCH_DB = EXPORT_DB;
export const WATCH_ROOT = 'builders';

export { CODE_ALPHABET, CODE_LENGTH };

export const WATCH_CODE_KEY = 'shmupx-watch-music-code';
export const WATCH_ON_KEY = 'shmupx-watch-music';

/** The actions a control record may name. Anything else is dropped. */
export const CONTROL_ACTIONS = Object.freeze([
  'pause',
  'resume',
  'stop',
  'next',
  'prev',
  // "Are you there?" — sent when the watch opens its remote. Answered by
  // publishing the library and the current state afresh.
  'sync',
]);

// Bounds on what is published. The watch renders the library as one list, and
// a game can push albums of any size into the player (add-albums).
export const MAX_ALBUMS = 50;
export const MAX_TRACKS = 500;
export const MAX_TEXT = 120;
export const MAX_ID = 512;

/**
 * How many acted-on records to remember. A redelivery is always of the CURRENT
 * node, so only recent ids can ever be asked about — and on an open-write
 * database an unbounded set is a leak somebody else can drive.
 */
const SEEN_LIMIT = 256;

function remember(seen, key) {
  seen.add(key);
  while (seen.size > SEEN_LIMIT) {
    seen.delete(seen.values().next().value);
  }
}

// ── The code ────────────────────────────────────────────────────────────────

/** The form that goes in a database path, or "" if it is not a code. */
export function normalizeWatchCode(raw) {
  return normalizeBuilderCode(raw);
}

/** `ABCD-EFGH`, for showing to a person. Never build a path from this. */
export function formatWatchCode(code) {
  return formatBuilderCode(code);
}

/**
 * A fresh code. The code is the only thing standing between a stranger and
 * this player's transport, so it comes from the CSPRNG; 256 is a multiple of
 * the alphabet's 32, so the modulo carries no bias.
 */
export function newWatchCode(random = (n) => crypto.getRandomValues(n)) {
  const bytes = random(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) { /* private mode — the session still works, it just forgets */ }
}

/** This launcher's own code, made up and remembered the first time it is asked. */
export function ensureWatchCode() {
  let code = normalizeWatchCode(readLocal(WATCH_CODE_KEY));
  if (!code) {
    code = newWatchCode();
    writeLocal(WATCH_CODE_KEY, code);
  }
  return code;
}

/** Off unless switched on: an idle launcher should not hold a stream open. */
export function watchMusicEnabled() {
  return readLocal(WATCH_ON_KEY) === '1';
}
export function setWatchMusicEnabled(on) {
  writeLocal(WATCH_ON_KEY, on ? '1' : '0');
}

// ── What arrives ────────────────────────────────────────────────────────────

function isId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_ID;
}

/**
 * Is this a launch worth acting on?
 *
 * Pure, so the rules are testable without a database:
 *
 * - **It names a song.** `album` and `track` are ids to look up, so they must
 *   at least be plausible ids.
 * - **An id we have not already run.** What makes a press distinguishable from
 *   a redelivery of the same press.
 *
 * Deliberately no comparison of `created_at` against this page's clock. The
 * obvious rule — "drop anything written before we booted" — silently drops
 * every press from a watch whose clock runs behind, and nothing anywhere would
 * report an error. History is recognised by where it sits in the stream
 * instead; see watchMusic.
 */
export function isFreshLaunch(record, seen) {
  if (!record || typeof record !== 'object') return false;
  if (!isId(record.id) || !isId(record.album) || !isId(record.track)) {
    return false;
  }
  return !seen.has(record.id);
}

/** The same for a control record. Remembers it when it returns true. */
export function isFreshControl(record, seen) {
  if (!record || typeof record !== 'object') return false;
  if (!CONTROL_ACTIONS.includes(record.action)) return false;
  const createdAt = Number(record.created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  // Controls have no id of their own — the write time is the identity, which
  // is enough because the watch never sends two in the same millisecond. It is
  // only ever compared with itself, so the watch's clock need not be right.
  const key = `${record.action}:${createdAt}`;
  if (seen.has(key)) return false;
  remember(seen, key);
  return true;
}

// ── What the player says, in the watch's terms ──────────────────────────────

function text(value, fallback) {
  const s = typeof value === 'string' ? value.trim() : '';
  return (s || fallback).slice(0, MAX_TEXT);
}

function albumsOf(state) {
  return Array.isArray(state?.albums) ? state.albums : [];
}

/**
 * The player's library as the watch gets it: ids and titles, nothing else.
 *
 * An album with no tracks is left out — there is nothing on it to pick — and
 * so is anything whose id could not be sent back to us intact.
 */
export function libraryFromState(state) {
  const albums = [];
  for (const album of albumsOf(state)) {
    if (albums.length >= MAX_ALBUMS) break;
    if (!isId(album?.id) || !Array.isArray(album.tracks)) continue;
    const tracks = [];
    for (const track of album.tracks) {
      if (tracks.length >= MAX_TRACKS) break;
      if (!isId(track?.id)) continue;
      tracks.push({ id: track.id, title: text(track.title, track.id) });
    }
    if (!tracks.length) continue;
    albums.push({ id: album.id, title: text(album.title, album.id), tracks });
  }
  return { albums };
}

/**
 * The album and track a request names, out of the player's own library — or
 * null. This lookup is the whole of the trust boundary: what reaches the
 * player is the id it reported itself, never the string that arrived.
 */
export function findTrack(state, albumId, trackId) {
  const album = albumsOf(state).find((a) => a?.id === albumId);
  const track = Array.isArray(album?.tracks)
    ? album.tracks.find((t) => t?.id === trackId)
    : null;
  return album && track ? { album, track } : null;
}

/**
 * The `playing` record for a player state.
 *
 * `state` is always the truth about the player. `launch` — the watch press we
 * last acted on — is echoed as `id` only while the track it asked for is the
 * one on, which is what tells the wrist its press landed. `failed` rides
 * beside the state rather than replacing it: a press we could not honour must
 * not make the watch forget the song that is still playing.
 */
export function playingFromState(state, options = {}) {
  /** @type {{ launch?: any, failed?: any }} */
  const { launch = null, failed = null } = options;
  const found = state
    ? findTrack(state, state.currentAlbumId, state.currentTrackId)
    : null;
  const answered = !!found && !!launch && launch.album === found.album.id &&
    launch.track === found.track.id;
  return {
    state: found ? (state.paused ? 'paused' : 'playing') : 'idle',
    album: found ? found.album.id : null,
    track: found ? found.track.id : null,
    title: found ? text(found.track.title, found.track.id) : null,
    album_title: found ? text(found.album.title, found.album.id) : null,
    id: answered ? launch.id : null,
    failed_id: failed?.id ?? null,
    detail: failed?.detail ?? null,
  };
}

// ── The database over REST ──────────────────────────────────────────────────

function dbUrl(code, node) {
  return `${WATCH_DB}/${WATCH_ROOT}/${code}/music/${node}.json`;
}

/**
 * Subscribe to one paired watch.
 *
 * `handlers.onLaunch(record)` and `handlers.onControl(record)` are called only
 * for records worth acting on. Returns an unsubscribe.
 *
 * THE FIRST FRAME AFTER EVERY CONNECT IS HISTORY. The database opens each
 * stream with the node as it stands — the last press, possibly from days ago —
 * and EventSource reconnects by itself, so that happens again after every
 * dropped connection or laptop sleep. Acting on it would start a song nobody
 * just asked for. So that frame is remembered and never acted on; only what
 * arrives after it is a press. The cost is a press made while the stream was
 * down, which the watch reports as "no reply" and the listener taps again.
 *
 * Both nodes are single slots the watch PUTs whole, so a record is always the
 * `data` of a `put` at the stream's own path; anything else is not something
 * the watch writes and is ignored.
 */
export function watchMusic(
  rawCode,
  handlers = {},
  /** @type {any} */ EventSourceImpl = globalThis.EventSource,
) {
  const code = normalizeWatchCode(rawCode);
  if (!code || typeof EventSourceImpl !== 'function') return () => {};

  const launchSeen = new Set();
  const controlSeen = new Set();

  const open = (node, onRecord, onHistory) => {
    let es;
    try {
      es = new EventSourceImpl(dbUrl(code, node));
    } catch (e) {
      console.warn('watch music stream failed to open', e);
      return () => {};
    }
    let history = true;
    es.addEventListener('open', () => {
      history = true;
    });
    es.addEventListener('put', (ev) => {
      let body;
      try {
        body = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!body || body.path !== '/') return;
      const snapshot = history;
      history = false;
      if (!body.data) return;
      try {
        if (snapshot) onHistory(body.data);
        else onRecord(body.data);
      } catch (e) {
        console.warn('watch music handler threw', e);
      }
    });
    return () => {
      try {
        es.close();
      } catch (_) { /* already closed */ }
    };
  };

  const stopLaunch = open('launch', (record) => {
    if (!isFreshLaunch(record, launchSeen)) return;
    remember(launchSeen, record.id);
    handlers.onLaunch?.(record);
  }, (record) => {
    if (isFreshLaunch(record, launchSeen)) remember(launchSeen, record.id);
  });
  const stopControl = open('control', (record) => {
    if (!isFreshControl(record, controlSeen)) return;
    handlers.onControl?.(record);
  }, (record) => {
    isFreshControl(record, controlSeen); // remembered, not acted on
  });

  return () => {
    stopLaunch();
    stopControl();
  };
}

/**
 * Write `playing` or `library` for the watch to read.
 *
 * Always the whole record: this page holds the player's full state every time
 * it has anything to say, so there is never a reason to send part of one.
 * `updated_at` makes every write a change, which matters for `sync` — the
 * database does not notify listeners of a write that changed nothing, and an
 * unchanged answer would look to the watch like no answer.
 *
 * Never rejects: the watch not knowing is not worth breaking playback over.
 */
export async function publishMusic(
  rawCode,
  node,
  body,
  /** @type {any} */ fetchImpl = fetch,
) {
  const code = normalizeWatchCode(rawCode);
  if (!code || (node !== 'playing' && node !== 'library')) return false;
  try {
    const res = await fetchImpl(dbUrl(code, node), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, updated_at: Date.now() }),
    });
    return res.ok;
  } catch (e) {
    console.warn('publishMusic failed', e);
    return false;
  }
}
