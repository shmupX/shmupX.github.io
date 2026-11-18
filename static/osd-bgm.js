// The Guide's background-music selector: a track the player picks in the
// in-game OSD (Sound → BGM track) to play in place of the running game's own
// music.
//
// The launcher plays it, not the game: one looping <audio> in the top
// document, at the Guide's BGM volume, while a game is on. The game's own BGM
// channel is held at zero over cmg-volume for as long as the pick is sounding
// (or on its way to), the same hold the docked music player gets — and the
// deck still outranks this: while it plays, the pick waits and comes back
// when it stops. "Game" is no pick at all, and the game's music is its own
// again.
//
// The pick is remembered (BGM_CHOICE_KEY) and matched against BGM_TRACKS when
// read back, so what is stored is only ever an id from this list — never a
// URL to fetch.
//
// The files are the 2028.Ai recordings (README-Technical, "foo's own music is
// a recording again"): three cuts of one track, about 1:42, 2:30 and 4:25,
// and Diamond Eyes. They are AAC in an MP4 container under an .mp3 name; a
// browser that cannot decode that reports an error, which leaves the game
// its own music.
//
// A track can be locked: the row offers it only once a game has unlocked it.
// bgm.mp3 (3:00, a plain MP3) is 2028.Ai's loop 2 — the runs after one that
// beat its bonus level, RonaGun — where it is the stage music in 1.mp3's
// place (game.bundle.js, unlockLoop2). The game says so with
// { type: 'cmg-bgm-unlock', urls }; a URL there only ever unlocks a track of
// this list, matched exactly, and what is kept (BGM_UNLOCKED_KEY) is the
// track's id, never the URL.

export const BGM_CHOICE_KEY = 'cmg-bgm-track';
export const BGM_UNLOCKED_KEY = 'cmg-bgm-unlocked';

/** No pick: the running game plays its own music. */
export const BGM_GAME = '';

const BGM_BASE = 'https://easierbycode.com/';

export const BGM_TRACKS = Object.freeze([
  Object.freeze({ id: '1', label: '1.mp3', url: BGM_BASE + '1.mp3' }),
  Object.freeze({ id: '2', label: '2.mp3', url: BGM_BASE + '2.mp3' }),
  Object.freeze({ id: '4', label: '4.mp3', url: BGM_BASE + '4.mp3' }),
  Object.freeze({ id: 'diamond-eyes', label: 'Diamond Eyes', url: BGM_BASE + 'diamond-eyes.mp3' }),
  Object.freeze({ id: 'bgm', label: 'bgm.mp3', url: BGM_BASE + 'bgm.mp3', locked: true }),
]);

/**
 * What the Guide's row steps through: the game's own music, then the tracks
 * — a locked one only when `unlocked` names it.
 * @param {readonly string[]} [unlocked]
 */
export function bgmOptions(unlocked = []) {
  return Object.freeze([
    Object.freeze({ value: BGM_GAME, label: 'Game' }),
    ...BGM_TRACKS
      .filter((t) => !t.locked || unlocked.includes(t.id))
      .map((t) => Object.freeze({ value: t.id, label: t.label })),
  ]);
}

/** The row before anything is unlocked. */
export const BGM_OPTIONS = bgmOptions();

/**
 * The track an id names, or null — for BGM_GAME and for anything unknown.
 * @param {unknown} id
 */
export function bgmTrack(id) {
  return BGM_TRACKS.find((t) => t.id === id) || null;
}

/**
 * The part of localStorage the pick is kept in.
 * @typedef {{
 *   getItem(key: string): string | null,
 *   setItem(key: string, value: string): void,
 *   removeItem(key: string): void,
 * }} BgmStorage
 */

/** @returns {BgmStorage | null} */
function defaultStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

/**
 * The locked tracks unlocked so far, by id: only ids of locked tracks of
 * BGM_TRACKS, whatever else is stored.
 * @param {BgmStorage | null} [storage]
 * @returns {string[]}
 */
export function loadBgmUnlocks(storage = defaultStorage()) {
  try {
    const list = JSON.parse(storage?.getItem(BGM_UNLOCKED_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return BGM_TRACKS.filter((t) => t.locked && list.includes(t.id)).map((t) => t.id);
  } catch (_) { return []; }
}

/**
 * Unlock the locked tracks whose URL is in `urls` (what a game sent with
 * cmg-bgm-unlock) and keep them. Returns every track unlocked now, by id;
 * anything that is not one of BGM_TRACKS' own URLs unlocks nothing.
 * @param {unknown} urls
 * @param {BgmStorage | null} [storage]
 * @returns {string[]}
 */
export function unlockBgmTracks(urls, storage = defaultStorage()) {
  const had = loadBgmUnlocks(storage);
  const asked = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string').slice(0, 16) : [];
  const now = BGM_TRACKS
    .filter((t) => t.locked && (had.includes(t.id) || asked.includes(t.url)))
    .map((t) => t.id);
  if (now.length !== had.length) {
    try { storage?.setItem(BGM_UNLOCKED_KEY, JSON.stringify(now)); } catch (_) { /* the unlock lasts the session */ }
  }
  return now;
}

/**
 * Whether the row may offer the track an id names: an open track, or a
 * locked one that `unlocked` names.
 * @param {unknown} id
 * @param {readonly string[]} unlocked
 */
function offered(id, unlocked) {
  const t = bgmTrack(id);
  return !!t && (!t.locked || unlocked.includes(t.id));
}

/**
 * The remembered pick, or BGM_GAME when nothing (or nothing on offer) is
 * stored.
 * @param {BgmStorage | null} [storage]
 */
export function loadBgmChoice(storage = defaultStorage()) {
  try {
    const id = storage?.getItem(BGM_CHOICE_KEY);
    return offered(id, loadBgmUnlocks(storage)) ? id : BGM_GAME;
  } catch (_) { return BGM_GAME; }
}

/**
 * Remember a pick; BGM_GAME (or an id not on offer) clears it. Returns what
 * was kept. `unlocked` is what the row offers, which outlasts a storage that
 * would not keep the unlock.
 * @param {string} id
 * @param {BgmStorage | null} [storage]
 * @param {readonly string[]} [unlocked]
 */
export function saveBgmChoice(id, storage = defaultStorage(), unlocked = loadBgmUnlocks(storage)) {
  const kept = offered(id, unlocked) ? id : BGM_GAME;
  try {
    if (kept) storage?.setItem(BGM_CHOICE_KEY, kept);
    else storage?.removeItem(BGM_CHOICE_KEY);
  } catch (_) { /* storage disabled/full — the pick lasts the session */ }
  return kept;
}

function clampVolume(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/**
 * The one looping <audio> behind the selector.
 *
 * `set(url, volume)` says what should be sounding now — a URL, or null for
 * nothing — and is safe to call again and again with the same wish. `state`
 * says how that is going:
 *
 *   idle      nothing wanted
 *   starting  wanted, loading or waiting on play()
 *   playing   sounding
 *   blocked   the browser refused play() (no gesture on the page yet); tried
 *             again every `retryMs`, and on the next set()
 *   paused    something outside paused it (a media key, the tab going to the
 *             background); the next set() resumes it
 *   failed    the file would not load or decode; stays so until the wish
 *             changes
 *
 * `holding` is true for starting and playing: the states in which the game's
 * own BGM should be silent. `onstate(state)` fires on every change.
 *
 * @typedef {object} BgmAudio The part of an <audio> the player uses.
 * @property {string} src
 * @property {boolean} loop
 * @property {string} preload
 * @property {number} volume
 * @property {unknown} error
 * @property {() => (Promise<void> | void)} play
 * @property {() => void} pause
 * @property {(type: string, listener: () => void) => void} addEventListener
 *
 * @param {object} [options]
 * @param {() => BgmAudio} [options.makeAudio]
 * @param {(state: string) => void} [options.onstate]
 * @param {number} [options.retryMs]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 */
export function createBgmPlayer({
  makeAudio = () => new Audio(),
  onstate = () => {},
  retryMs = 2000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let audio = null;
  let url = null;     // what should be sounding
  let loaded = null;  // what the element holds
  let volume = 1;
  let state = 'idle';
  let timer = null;

  function setState(next) {
    if (next === state) return;
    state = next;
    try { onstate(state); } catch (_) { /* a listener's problem, not playback's */ }
  }
  function cancelRetry() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function ensureAudio() {
    if (audio) return audio;
    audio = makeAudio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.addEventListener('playing', () => { if (url) setState('playing'); });
    audio.addEventListener('pause', () => {
      // Our own pause() runs with the wish already cleared and settles the
      // state itself; a pause that arrives while a track is still wanted came
      // from outside.
      if (url && state === 'playing') setState('paused');
    });
    audio.addEventListener('error', () => {
      // audio.error is reset by a newer load, so a stale event from the track
      // before this one is not mistaken for this one failing.
      if (!audio.error) return;
      loaded = null; // a later wish for the same file loads it afresh
      if (url) { cancelRetry(); setState('failed'); }
    });
    return audio;
  }
  function start() {
    cancelRetry();
    if (!url || !audio) return;
    const wanted = url;
    if (state !== 'playing') setState('starting');
    let attempt;
    try { attempt = audio.play(); } catch (_) { setState('failed'); return; }
    Promise.resolve(attempt).catch((err) => {
      if (url !== wanted || state === 'playing') return; // superseded, or it got going anyway
      const name = err && err.name;
      // A newer load or pause interrupted this play(); that call answers for itself.
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        setState('blocked');
        timer = setTimer(() => { timer = null; start(); }, retryMs);
        return;
      }
      setState('failed');
    });
  }

  return {
    get state() { return state; },
    get holding() { return state === 'starting' || state === 'playing'; },
    /**
     * @param {string | null} nextUrl
     * @param {number} [nextVolume]
     */
    set(nextUrl, nextVolume) {
      volume = clampVolume(nextVolume);
      if (audio) audio.volume = volume;
      const next = typeof nextUrl === 'string' && nextUrl ? nextUrl : null;
      if (next === url) {
        // The same wish again is the cue to retry what a gesture or a return
        // to the tab may now allow — but not a file that already failed.
        if (url && (state === 'blocked' || state === 'paused')) start();
        return;
      }
      url = next;
      cancelRetry();
      if (!url) {
        if (audio) { try { audio.pause(); } catch (_) { /* ignore */ } }
        setState('idle');
        return;
      }
      const a = ensureAudio();
      a.volume = volume;
      // A track that was only paused (the deck took over, the game closed)
      // picks up where it left off; a different one loads from the top.
      if (loaded !== url) { a.src = url; loaded = url; }
      setState('starting');
      start();
    },
  };
}
