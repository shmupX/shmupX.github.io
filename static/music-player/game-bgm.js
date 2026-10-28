// game-bgm.js — a game's BGM through the music player instead of its own
// sound manager. Ported from cmg's static/music-player/sound.js (itself a
// drop-in for 2019-turbo's src/sound.js); same exports: initSound, play, stop,
// bgmPlay, stopBgm, stopAll, pauseAll, resumeAll.
//
// BGM keys (anything present in options.bgm) are sent to the player, which
// runs in a hidden iframe and is driven over postMessage (protocol in
// ./app.js). Loop regions come along as track metadata, so the player handles
// the [start, end] looping a Phaser marker would have. Non-BGM keys (voices /
// SEs) stay local, played as plain HTMLAudio one-shots so they never
// interrupt the music.
//
// Usage (in place of a game's own initSound(game)):
//   import { initSound, bgmPlay, stopBgm } from "/music-player/game-bgm.js";
//   initSound(game, {
//     playerUrl: "/music-player/",          // the default — same origin
//     albumId: "my-game-bgm",
//     albumTitle: "My Game",
//     bgm: { stage1: { url: ".../stage1.mp3", start: 914888, end: 6111881, volume: 0.5 } },
//     tracks: { se_decision: { url: ".../se_decision.mp3", volume: 0.5 } },
//     isMuted: () => settings.lowMode,
//   })
// start/end are microseconds, matching 2019-turbo's BGM_INFO.
//
// The album is also mirrored onto the same-origin BroadcastChannel
// "azlegend-music" and localStorage "azlegend:last-album" — the names the
// level editor (static/editor/index.html) already listens on, to offer the
// tracks as BGM replacements even when the game tab is closed.

const MESSAGE_PREFIX = "music-player:";
const MICROS = 1e6;

const config = {
  playerUrl: "/music-player/",
  albumId: "game-bgm",
  albumTitle: "Game BGM",
  bgm: {},
  tracks: {},
  isMuted: () => false,
  visible: false,
};

let frame = null;
let playerOrigin = "*";
let readyResolve = null;
let readyPromise = null;
let playerReady = false;
const commandQueue = []; // messages sent before the album was accepted
let lastState = null;
let currentBgmKey = null;
const seCache = new Map(); // key -> base HTMLAudioElement
const seClones = new Map(); // key -> Set of in-flight overlapping clones
let requestSeq = 0;
const pendingState = new Map(); // requestId -> resolve

function muted() {
  try {
    return !!config.isMuted();
  } catch (_e) {
    return false;
  }
}

function rawPost(message) {
  frame?.contentWindow?.postMessage(message, playerOrigin);
}

// Callers keep the old synchronous contract (initSound() then bgmPlay()
// without awaiting), so commands issued before the iframe accepted the
// album are queued and flushed on readiness instead of being lost.
function post(message) {
  if (!playerReady) {
    commandQueue.push(message);
    return;
  }
  rawPost(message);
}

const ALBUM_BROADCAST_CHANNEL = "azlegend-music";
const ALBUM_STORAGE_KEY = "azlegend:last-album";
function broadcastAlbumToEditor(album) {
  if (!album || !Array.isArray(album.tracks) || !album.tracks.length) return;
  try {
    localStorage.setItem(ALBUM_STORAGE_KEY, JSON.stringify(album));
  } catch (_e) { /* private mode / quota — non-fatal */ }
  try {
    const ch = new BroadcastChannel(ALBUM_BROADCAST_CHANNEL);
    ch.postMessage({ type: "album-available", album });
    ch.close();
  } catch (_e) { /* BroadcastChannel unsupported — localStorage still set */ }
}

/** The album the player is sent, built from options.bgm. */
export function bgmAlbum() {
  return {
    id: config.albumId,
    title: config.albumTitle,
    tracks: Object.entries(config.bgm).map(([key, info]) => ({
      id: key,
      title: info.title || key,
      url: info.url,
      volume: info.volume,
      loopStart: Number.isFinite(info.start) ? info.start / MICROS : 0,
      loopEnd: Number.isFinite(info.end) ? info.end / MICROS : undefined,
    })),
  };
}

function onMessage(event) {
  const data = event.data;
  if (
    !data || typeof data.type !== "string" ||
    !data.type.startsWith(MESSAGE_PREFIX)
  ) return;
  if (frame && event.source !== frame.contentWindow) return;

  const command = data.type.slice(MESSAGE_PREFIX.length);
  if (data.state) lastState = data.state;

  if (command === "ready") {
    playerOrigin = event.origin || "*";
    rawPost({
      type: MESSAGE_PREFIX + "add-albums",
      albums: [bgmAlbum()],
      select: config.albumId,
    });
  } else if (command === "event" && data.event === "albums-changed") {
    const album = (data.state?.albums || []).find((a) =>
      a.id === config.albumId
    );
    if (album) {
      playerReady = true;
      while (commandQueue.length) rawPost(commandQueue.shift());
      if (readyResolve) {
        readyResolve(album);
        readyResolve = null;
      }
    }
  } else if (command === "state" && data.requestId !== undefined) {
    const resolve = pendingState.get(data.requestId);
    if (resolve) {
      pendingState.delete(data.requestId);
      resolve(data.state);
    }
  }
}

export function configureSound(options = {}) {
  Object.assign(config, options);
}

// `game` is accepted for signature compatibility with a Phaser sound shim but
// is unused — the embedded player replaces game.sound entirely for BGM.
export function initSound(_game, options = {}) {
  configureSound(options);
  if (!config.playerUrl) {
    throw new Error("initSound: options.playerUrl (the player page) is required");
  }
  // Publish the album to the editor side-channel as soon as the BGM set is
  // known (before the player handshake), so an editor open in another tab can
  // offer these tracks immediately.
  broadcastAlbumToEditor(bgmAlbum());
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  globalThis.addEventListener("message", onMessage);

  frame = document.createElement("iframe");
  frame.id = "music-player-frame";
  frame.setAttribute("allow", "autoplay");
  if (!config.visible) {
    // Two transparent pixels, not display:none: a frame with no area is
    // render-throttled and loses the requestAnimationFrame loop the player's
    // analyser feed runs on.
    frame.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none;";
  } else {
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:480px;height:360px;border:0;z-index:9999;";
  }
  const url = new URL(config.playerUrl, globalThis.location.href);
  url.searchParams.set("albums", "none"); // only the game's album
  frame.src = url.href;
  document.body.appendChild(frame);

  return readyPromise;
}

export function soundReady() {
  return readyPromise || Promise.reject(new Error("initSound not called"));
}

export function getPlayerState() {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingState.delete(requestId);
      reject(new Error("music player state timed out"));
    }, 5000);
    pendingState.set(requestId, (state) => {
      clearTimeout(timer);
      resolve(state);
    });
    post({ type: MESSAGE_PREFIX + "get-state", requestId });
  });
}

function localSe(key) {
  const info = config.tracks[key];
  if (!info || !info.url) return null;
  if (seCache.has(key)) return seCache.get(key);
  const audio = new Audio(info.url);
  audio.volume = Number.isFinite(info.volume) ? info.volume : 1;
  audio.preload = "auto";
  seCache.set(key, audio);
  return audio;
}

// Overlapping one-shots: if the base element for a key is mid-playback,
// play a throwaway clone instead of cutting the earlier instance off.
function playSe(key) {
  const base = localSe(key);
  if (!base) return null;
  let audio = base;
  if (!base.paused && !base.ended) {
    audio = base.cloneNode(true);
    audio.volume = base.volume;
    let clones = seClones.get(key);
    if (!clones) {
      clones = new Set();
      seClones.set(key, clones);
    }
    clones.add(audio);
    audio.addEventListener("ended", () => clones.delete(audio));
  }
  audio.currentTime = 0;
  audio.play().catch(() => {/* gesture-gated */});
  return audio;
}

function eachSe(fn) {
  seCache.forEach((audio) => fn(audio));
  seClones.forEach((clones) => clones.forEach((audio) => fn(audio)));
}

export function play(key) {
  if (muted()) return null;
  if (config.bgm[key]) {
    post({ type: MESSAGE_PREFIX + "play", album: config.albumId, track: key });
    currentBgmKey = key;
    return key;
  }
  return playSe(key);
}

export function stop(key) {
  if (config.bgm[key]) {
    stopBgm(key);
    return;
  }
  const audio = seCache.get(key);
  if (audio && !audio.paused) audio.pause();
  const clones = seClones.get(key);
  if (clones) {
    clones.forEach((clone) => clone.pause());
    clones.clear();
  }
}

// Play once from the top, then loop the [start, end] region — the loop
// region rides on the track metadata, so the player enforces it.
export function bgmPlay(key) {
  if (muted() || !config.bgm[key]) return;
  currentBgmKey = key;
  post({ type: MESSAGE_PREFIX + "play", album: config.albumId, track: key });
}

export function stopBgm(key) {
  if (key !== undefined && key !== currentBgmKey) return;
  currentBgmKey = null;
  post({ type: MESSAGE_PREFIX + "stop" });
}

// Stop/pause cleanup must run even while muted — a mute/low-mode toggle
// mid-battle should silence BGM already playing, not leave it running.
export function stopAll() {
  currentBgmKey = null;
  post({ type: MESSAGE_PREFIX + "stop" });
  eachSe((audio) => {
    if (!audio.paused) audio.pause();
  });
  seClones.forEach((clones) => clones.clear());
}

export function pauseAll() {
  post({ type: MESSAGE_PREFIX + "pause" });
  eachSe((audio) => {
    if (!audio.paused) audio.pause();
  });
}

export function resumeAll() {
  if (muted()) return;
  post({ type: MESSAGE_PREFIX + "resume" });
}

export function currentBgm() {
  return currentBgmKey;
}

export function playerStateSnapshot() {
  return lastState;
}
