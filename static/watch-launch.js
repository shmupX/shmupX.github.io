// The launcher's half of the shmupX watch protocol: a game picked on the wrist
// starts here, and what happens to it is reported back.
//
//   watch  --> /builders/<code>/launch    one slot, latest press wins
//   watch  --> /builders/<code>/control   pause · resume · stop · volume
//   here   --> /builders/<code>/playing   what is actually running
//
// Same database and the same BUILD CODE as the export queue — one code pairs a
// wrist to a desktop for everything — but a different subtree: `builders/<code>`
// is the watch's, `exportQueue/<code>` is the build server's. The watch app
// (tools/shmupx-watch) reads and writes exactly these three nodes, and
// tools/watch-bridge/ owns three more beside them (utterances, preview, agents)
// for the sprite-editing side.
//
// THE LAUNCHER PAGE IS THE CONSUMER, not the daemon in tools/watch-bridge/.
// That is not an accident of where it was easier to write: three of the six
// kinds cannot be started from a shell at all. An arcade board and an SFC cart
// are postMessaged into an emulator running in this page, and a PS2 build comes
// out of this browser's own IndexedDB. A daemon can open a URL; it cannot hand
// a File to a worker in someone else's tab.
//
// SECURITY. The database is open-read and open-write with no auth, so anything
// arriving here was written by whoever knows the code — which is meant to be
// the owner's watch and might not be. Every field is therefore treated as
// untrusted: `kind` is matched against a fixed list, ids are looked up in
// catalogs this page already has rather than used to build paths, and `url` is
// clamped to this origin. Nothing here is eval'd, fetched or navigated to on
// the strength of what the record said.

import { normalizeBuilderCode, watchPath, EXPORT_DB } from './export-queue.js';

/** The node everything below hangs off. */
export const WATCH_ROOT = 'builders';

/** The kinds a launch request may name. Anything else is dropped. */
export const LAUNCH_KINDS = Object.freeze([
  'game', // an in-repo game with its own route
  'eshop-web', // a web build installed into Cache Storage
  'arcade', // a MAME romset against a core
  'deza', // a Dezaemon 2 Saturn save
  'snes', // a Super Famicom cart
  'ps2', // a PS2 build out of IndexedDB
  'url', // a same-origin path, clamped below
]);

/** The actions a control record may name. */
export const CONTROL_ACTIONS = Object.freeze(['pause', 'resume', 'stop', 'volume']);

/**
 * How many acted-on records to remember.
 *
 * The sets exist to stop a redelivered record being acted on twice, and a
 * redelivery is always of the CURRENT node — so only recent ids can ever be
 * asked about. An unbounded set on a page that stays open for days is a slow
 * leak with no upside, and on an open-write database it is a leak somebody else
 * can drive.
 */
const SEEN_LIMIT = 256;

/** Add to an insertion-ordered set, evicting the oldest past [SEEN_LIMIT]. */
function remember(seen, key) {
  seen.add(key);
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    seen.delete(oldest);
  }
}

function dbUrl(path) {
  return `${EXPORT_DB}/${path}.json`;
}

/**
 * Is this a launch worth acting on?
 *
 * Pure, so the rules are testable without a database. Three things are checked,
 * and each one has bitten something in this repo before:
 *
 * - **A known kind.** Switching on an arbitrary string means a typo silently
 *   does nothing; an explicit list means it is dropped and said so.
 * - **An id we have not already run.** The stream's first frame after
 *   connecting is the WHOLE node, so the last launch arrives again every time
 *   this page opens. Without the id, opening the launcher would replay it.
 * - **Not from before we booted.** A record older than this page has already
 *   been acted on by whoever was open at the time.
 */
export function isFreshLaunch(record, seen, bootAt) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.id !== 'string' || !record.id) return false;
  if (!LAUNCH_KINDS.includes(record.kind)) return false;
  if (seen.has(record.id)) return false;
  // A watch with a wrong clock would otherwise be permanently in the past or
  // permanently in the future; only a *confidently* old record is skipped.
  const createdAt = Number(record.created_at);
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < bootAt) return false;
  return true;
}

/** Same rules for a control record, minus the kind list. */
export function isFreshControl(record, seen, bootAt) {
  if (!record || typeof record !== 'object') return false;
  if (!CONTROL_ACTIONS.includes(record.action)) return false;
  const createdAt = Number(record.created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  // Controls have no id of their own — the write time is the identity, which
  // is enough because the watch never sends two in the same millisecond.
  const key = `${record.action}:${createdAt}`;
  if (seen.has(key)) return false;
  if (createdAt < bootAt) return false;
  remember(seen, key);
  return true;
}

/**
 * A same-origin path, or null.
 *
 * `url` is the one field that is a capability rather than a name, so it gets
 * the strictest treatment: parsed against this origin and rejected unless it
 * stayed there. A watch cannot talk this page into loading someone else's site
 * into the game frame.
 */
export function sameOriginPath(raw, origin) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin) return null;
    return url.pathname + url.search + url.hash;
  } catch (_) {
    return null;
  }
}

/**
 * Subscribe to one paired watch.
 *
 * `handlers.onLaunch(record)` and `handlers.onControl(record)` are called only
 * for records that pass the freshness rules above. Returns an unsubscribe.
 */
export function watchLaunches(rawCode, handlers = {}, now = Date.now()) {
  const code = normalizeBuilderCode(rawCode);
  if (!code) return () => {};

  const bootAt = now;
  const launchSeen = new Set();
  const controlSeen = new Set();

  const stopLaunch = watchPath(`${WATCH_ROOT}/${code}/launch`, (value) => {
    if (!value) return;
    // watchPath mirrors the subtree, so `value` is the launch record itself.
    if (!isFreshLaunch(value, launchSeen, bootAt)) return;
    remember(launchSeen, value.id);
    try {
      handlers.onLaunch?.(value);
    } catch (e) {
      console.warn('watch launch handler threw', e);
    }
  });

  const stopControl = watchPath(`${WATCH_ROOT}/${code}/control`, (value) => {
    if (!value) return;
    if (!isFreshControl(value, controlSeen, bootAt)) return;
    try {
      handlers.onControl?.(value);
    } catch (e) {
      console.warn('watch control handler threw', e);
    }
  });

  return () => {
    stopLaunch();
    stopControl();
  };
}

/**
 * Tell the watch what is running.
 *
 * MERGES by default, and that is not a detail. A pause writes only
 * `{state, volume}`; as a PUT that replaces the node, so the title, the game id
 * and the launch id all vanish and the wrist ends up showing a paused game with
 * no name. PATCH leaves the fields this call did not mention alone.
 *
 * Pass `replace: true` for the transitions that really are a fresh record — a
 * new launch, or going idle — where leaving the previous game's title behind
 * would be its own kind of lie.
 *
 * Never rejects: the watch not knowing is worse than a thrown promise nobody
 * awaited, but it is not worth breaking a launch over. Fire-and-forget.
 */
export async function publishPlaying(rawCode, state, { replace = false } = {}) {
  const code = normalizeBuilderCode(rawCode);
  if (!code) return false;
  const body = replace
    ? { state: 'idle', title: null, game_id: null, id: null, kind: null, ...state, updated_at: Date.now() }
    : { ...state, updated_at: Date.now() };
  try {
    const res = await fetch(dbUrl(`${WATCH_ROOT}/${code}/playing`), {
      method: replace ? 'PUT' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (e) {
    console.warn('publishPlaying failed', e);
    return false;
  }
}

/**
 * Publish the shelf sizes the watch cannot count for itself.
 *
 * The watch reads the games manifest and the Dezaemon index straight off the
 * network, so those it knows. The Super Famicom and PlayStation 2 shelves are a
 * different matter: they live in THIS browser's IndexedDB and are not reachable
 * from a wrist at all. Without this the watch either shows nothing for them or
 * invents a number, and the design's hardcoded "6" and "3" are exactly the
 * invented kind — the real counts move.
 */
export async function publishShelves(rawCode, counts) {
  const code = normalizeBuilderCode(rawCode);
  if (!code || !counts) return false;
  const body = { updated_at: Date.now() };
  // Only publish counts we actually have. An absent key reads on the watch as
  // "unknown", which is different from, and more honest than, zero.
  for (const key of ['deza', 'snes', 'ps2']) {
    if (Number.isFinite(counts[key])) body[key] = counts[key];
  }
  try {
    const res = await fetch(dbUrl(`${WATCH_ROOT}/${code}/shelves`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (e) {
    console.warn('publishShelves failed', e);
    return false;
  }
}
