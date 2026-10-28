// The player. AZLegendGolden's app.js (easierbycode/azlegend,
// static/public/app/scripts/app.js) with three changes for shmupX: every
// path is relative to this directory, the artist's album index is optional
// (./albums.json, loaded when present), and an album can be named on the URL
// (?bgm=…, see bgm-params.js) so a game hands the player its music by
// opening it. The `music-player:` protocol below is unchanged — the launcher,
// game-bgm.js and the watch remote (static/watch-music.js) all speak it.
(function () {
  "use strict";

  var ALBUM_INDEX_URL = "./albums.json";
  var MESSAGE_PREFIX = "music-player:";

  var pageParams = new URLSearchParams(window.location.search);
  // The name on the deck: the host's, if it says (?brand=), else ours.
  var DEFAULT_BRAND = (function () {
    var brand = (pageParams.get("brand") || "").replace(/[^\w .+'&-]/g, "").trim().slice(0, 24);
    return brand || "shmupX";
  })();

  var state = {
    albums: [],
    selectedAlbumIndex: 0,
    currentAlbumIndex: -1,
    currentTrackIndex: -1,
    seekDragging: false,
    clients: []
  };

  var elements = {
    brand: document.querySelector(".brand"),
    albumTabs: document.getElementById("albumTabs"),
    trackList: document.getElementById("trackList"),
    audio: document.getElementById("audioPlayer"),
    playerStatus: document.getElementById("playerStatus"),
    albumTitle: document.getElementById("albumTitle"),
    trackTitle: document.getElementById("trackTitle"),
    tapeLabel: document.getElementById("tapeLabel"),
    tapeStage: document.getElementById("tapeStage"),
    tapeShell: document.getElementById("tapeShell"),
    prevButton: document.getElementById("prevButton"),
    playButton: document.getElementById("playButton"),
    stopButton: document.getElementById("stopButton"),
    nextButton: document.getElementById("nextButton"),
    seekControl: document.getElementById("seekControl"),
    currentTime: document.getElementById("currentTime"),
    duration: document.getElementById("duration"),
    albumModal: null,
    albumModalList: null
  };

  var visualizer = new window.AudioPartyVisualizer(document.getElementById("visualizer"), {
    assetBase: "./images/audio-party",
    onFrequency: broadcastFrequency
  });

  function titleize(value) {
    return String(value || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map(function (part) {
        if (/^\d+$/.test(part)) {
          return part;
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(" ");
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }

    var minutes = Math.floor(seconds / 60);
    var rest = Math.floor(seconds % 60);
    return minutes + ":" + String(rest).padStart(2, "0");
  }

  function normalizeTrack(track) {
    if (typeof track === "string") {
      track = { url: track };
    }
    var url = track.url || "";
    var fileName = track.file || url.split("/").pop() || "";
    var normalized = {
      id: track.id || fileName.replace(/\.[^.]+$/, "") || url,
      title: track.title || titleize(fileName),
      file: fileName,
      url: url
    };

    // Optional playback hints (used by games sending BGM albums): a fixed
    // volume and a loop region in seconds. When loopEnd is set, playback
    // returns to loopStart instead of advancing to the next track.
    var volume = Number(track.volume);
    if (Number.isFinite(volume)) {
      normalized.volume = Math.min(1, Math.max(0, volume));
    }
    var loopStart = Number(track.loopStart);
    var loopEnd = Number(track.loopEnd);
    if (Number.isFinite(loopEnd) && loopEnd > 0) {
      normalized.loopStart = Number.isFinite(loopStart) && loopStart >= 0 ? loopStart : 0;
      normalized.loopEnd = loopEnd;
    } else if (track.loop === true) {
      normalized.loopStart = 0;
    }

    return normalized;
  }

  function normalizeAlbum(album) {
    var tracks = Array.isArray(album.tracks) ? album.tracks.map(normalizeTrack) : [];
    return {
      id: String(album.id || album.title || "album-" + Date.now()),
      title: album.title || titleize(album.id || "Album"),
      tracksUrl: typeof album.tracks === "string" ? album.tracks : album.tracksUrl || null,
      tracks: tracks
    };
  }

  function setStatus(message) {
    elements.playerStatus.textContent = message || "";
  }

  /** What the status line says when nothing is on. */
  function idleStatus() {
    return state.albums.length ? "Choose a song" : "Waiting for a game";
  }

  function currentAlbum() {
    return state.albums[state.currentAlbumIndex] || null;
  }

  function currentTrack() {
    var album = currentAlbum();
    if (!album) {
      return null;
    }
    return album.tracks[state.currentTrackIndex] || null;
  }

  function selectedAlbum() {
    return state.albums[state.selectedAlbumIndex] || null;
  }

  function albumIndexById(ref) {
    if (typeof ref === "number") {
      return state.albums[ref] ? ref : -1;
    }
    return state.albums.findIndex(function (album) {
      return album.id === ref || album.title === ref;
    });
  }

  function trackIndexByRef(album, ref) {
    if (!album) {
      return -1;
    }
    if (typeof ref === "number") {
      return album.tracks[ref] ? ref : -1;
    }
    return album.tracks.findIndex(function (track) {
      return track.id === ref || track.file === ref || track.title === ref || track.url === ref;
    });
  }

  function setTapePlaying(isPlaying) {
    elements.tapeShell.classList.toggle("playing", isPlaying);
    elements.tapeShell.classList.toggle("stopped", !isPlaying);
    elements.playButton.textContent = isPlaying ? "Pause" : "Play";
  }

  function updateNowPlaying() {
    var album = currentAlbum() || selectedAlbum();
    var track = currentTrack();

    elements.albumTitle.textContent = album ? album.title : "Album";
    elements.trackTitle.textContent = track ? track.title : "No track selected";
    elements.tapeLabel.textContent = album ? album.title : DEFAULT_BRAND;

    document.title = track ? track.title + " - " + DEFAULT_BRAND : DEFAULT_BRAND + " - Music Player";
    renderTrackList();
  }

  function updateProgress() {
    var audio = elements.audio;
    var duration = Number.isFinite(audio.duration) ? audio.duration : 0;

    if (!state.seekDragging) {
      elements.seekControl.value = duration ? Math.round((audio.currentTime / duration) * 1000) : 0;
    }

    elements.currentTime.textContent = formatTime(audio.currentTime);
    elements.duration.textContent = formatTime(duration);
  }

  function startPlayback(status) {
    var settled = false;
    var playPromise = elements.audio.play();
    var fallback = window.setTimeout(function () {
      if (settled) {
        return;
      }

      if (elements.audio.paused) {
        setTapePlaying(false);
        setStatus("Tap Play to start");
      } else {
        setTapePlaying(true);
        setStatus(status || "Playing");
      }
      renderTrackList();
    }, 1200);

    if (!playPromise || typeof playPromise.then !== "function") {
      window.clearTimeout(fallback);
      setTapePlaying(!elements.audio.paused);
      setStatus(elements.audio.paused ? "Tap Play to start" : (status || "Playing"));
      renderTrackList();
      return Promise.resolve();
    }

    return playPromise
      .then(function () {
        settled = true;
        window.clearTimeout(fallback);
        setTapePlaying(true);
        setStatus(status || "Playing");
        renderTrackList();
      })
      .catch(function () {
        settled = true;
        window.clearTimeout(fallback);
        setTapePlaying(false);
        setStatus("Tap Play to start");
        renderTrackList();
      });
  }

  function renderAlbumTabs() {
    elements.albumTabs.replaceChildren();

    state.albums.forEach(function (album, index) {
      var button = document.createElement("button");
      button.className = "album-tab";
      button.type = "button";
      button.id = "album-tab-" + album.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", index === state.selectedAlbumIndex ? "true" : "false");
      button.textContent = album.title;
      button.addEventListener("click", function () {
        selectAlbum(index);
      });
      elements.albumTabs.appendChild(button);
    });

    renderAlbumModalList();
  }

  function renderTrackList() {
    var album = selectedAlbum();
    elements.trackList.replaceChildren();

    if (!album) {
      return;
    }

    album.tracks.forEach(function (track, index) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      var title = document.createElement("span");
      var badge = document.createElement("span");
      var isActive = state.currentAlbumIndex === state.selectedAlbumIndex && state.currentTrackIndex === index;

      button.className = "track-button" + (isActive ? " is-active" : "");
      button.type = "button";
      button.setAttribute("aria-current", isActive ? "true" : "false");

      title.className = "track-title";
      title.textContent = track.title;
      badge.className = "track-badge";
      badge.textContent = isActive && !elements.audio.paused ? "Playing" : "MP3";

      button.appendChild(title);
      button.appendChild(badge);
      button.addEventListener("click", function () {
        playTrack(state.selectedAlbumIndex, index);
      });

      item.appendChild(button);
      elements.trackList.appendChild(item);
    });
  }

  function selectAlbum(index) {
    if (typeof index !== "number") {
      index = albumIndexById(index);
    }
    if (!state.albums[index]) {
      return;
    }

    state.selectedAlbumIndex = index;
    renderAlbumTabs();
    renderTrackList();

    var album = selectedAlbum();
    if (album && state.currentAlbumIndex < 0) {
      elements.albumTitle.textContent = album.title;
      elements.tapeLabel.textContent = album.title;
    }
    notifyClients("album-selected");
  }

  function applyTrackHints(track) {
    elements.audio.volume = Number.isFinite(track.volume) ? track.volume : 1;
  }

  function playTrack(albumIndex, trackIndex) {
    var album = state.albums[albumIndex];
    var track = album && album.tracks[trackIndex];
    if (!track) {
      return Promise.resolve();
    }

    state.currentAlbumIndex = albumIndex;
    state.currentTrackIndex = trackIndex;
    state.selectedAlbumIndex = albumIndex;
    renderAlbumTabs();
    updateNowPlaying();
    setStatus("Loading");

    applyTrackHints(track);
    if (elements.audio.getAttribute("src") !== track.url) {
      elements.audio.src = track.url;
      elements.audio.load();
    }

    return visualizer.connect(elements.audio)
      .then(function () {
        return startPlayback("Playing");
      })
      .then(function () {
        notifyClients("track-change");
      });
  }

  function togglePlayback() {
    var track = currentTrack();

    if (!track) {
      var album = selectedAlbum();
      if (album && album.tracks.length) {
        return playTrack(state.selectedAlbumIndex, 0);
      }
      return Promise.resolve();
    }

    if (elements.audio.paused) {
      return visualizer.connect(elements.audio)
        .then(function () {
          return startPlayback("Playing");
        });
    }

    elements.audio.pause();
    return Promise.resolve();
  }

  function stopTrack() {
    elements.audio.pause();
    elements.audio.currentTime = 0;
    setTapePlaying(false);
    setStatus(currentTrack() ? "Stopped" : idleStatus());
    updateProgress();
    renderTrackList();
    notifyClients("stop");
  }

  function playNeighbor(direction) {
    var albumIndex = state.currentAlbumIndex >= 0 ? state.currentAlbumIndex : state.selectedAlbumIndex;
    var album = state.albums[albumIndex];
    if (!album || !album.tracks.length) {
      return Promise.resolve();
    }

    var trackIndex = state.currentTrackIndex;
    if (trackIndex < 0 || state.currentAlbumIndex !== albumIndex) {
      trackIndex = direction > 0 ? 0 : album.tracks.length - 1;
    } else {
      trackIndex = (trackIndex + direction + album.tracks.length) % album.tracks.length;
    }

    return playTrack(albumIndex, trackIndex);
  }

  function enforceLoopRegion() {
    var track = currentTrack();
    if (!track || !Number.isFinite(track.loopEnd)) {
      return;
    }
    if (elements.audio.currentTime >= track.loopEnd) {
      elements.audio.currentTime = track.loopStart || 0;
    }
  }

  function fitTape() {
    var width = elements.tapeStage.clientWidth;
    var scale = Math.min(1, width / 480);
    elements.tapeShell.style.transform = "scale(" + scale + ")";
    elements.tapeStage.style.height = Math.round(300 * scale) + "px";
  }

  // ---------------------------------------------------------------------
  // Album loading — the player is generic: albums can come from the local
  // index (albums.json), from the URL (?bgm=), from the MusicPlayer API, or
  // be posted in by a host page / game via postMessage. Albums with the same
  // id are replaced.
  // ---------------------------------------------------------------------

  function resolveAlbumTracks(album) {
    if (album.tracks.length || !album.tracksUrl) {
      return Promise.resolve(album);
    }
    return fetch(album.tracksUrl)
      .then(function (response) {
        if (!response.ok) {
          throw new Error(album.title + " failed");
        }
        return response.json();
      })
      .then(function (tracks) {
        album.tracks = tracks.map(normalizeTrack);
        return album;
      });
  }

  function addAlbums(albums, options) {
    options = options || {};
    var incoming = (Array.isArray(albums) ? albums : [albums]).map(normalizeAlbum);

    return Promise.all(incoming.map(resolveAlbumTracks)).then(function (resolved) {
      resolved.forEach(function (album) {
        var existing = albumIndexById(album.id);
        if (existing >= 0) {
          state.albums[existing] = album;
          if (state.currentAlbumIndex === existing) {
            state.currentTrackIndex = Math.min(
              state.currentTrackIndex,
              album.tracks.length - 1
            );
          }
        } else {
          state.albums.push(album);
        }
      });

      renderAlbumTabs();
      renderTrackList();

      if (state.albums.length && state.currentAlbumIndex < 0) {
        var first = selectedAlbum() || state.albums[0];
        elements.albumTitle.textContent = first.title;
        elements.tapeLabel.textContent = first.title;
        if (elements.audio.paused) setStatus(idleStatus());
      }

      if (options.select !== undefined) {
        selectAlbum(albumIndexById(options.select));
      }

      notifyClients("albums-changed");

      if (options.play !== undefined && options.play !== null) {
        var playRef = options.play === true ? {} : options.play;
        var albumIndex = playRef.album !== undefined
          ? albumIndexById(playRef.album)
          : albumIndexById(resolved[0] && resolved[0].id);
        var trackIndex = trackIndexByRef(state.albums[albumIndex], playRef.track !== undefined ? playRef.track : 0);
        if (albumIndex >= 0 && trackIndex >= 0) {
          return playTrack(albumIndex, trackIndex).then(function () {
            return state.albums;
          });
        }
      }

      return state.albums;
    });
  }

  // ---------------------------------------------------------------------
  // Album selector modal — hidden until the brand text is tapped/clicked.
  // ---------------------------------------------------------------------

  function buildAlbumModal() {
    var modal = document.createElement("div");
    modal.id = "albumModal";
    modal.className = "album-modal";
    modal.hidden = true;

    var backdrop = document.createElement("div");
    backdrop.className = "album-modal-backdrop";
    backdrop.addEventListener("click", closeAlbumModal);

    var panel = document.createElement("div");
    panel.className = "album-modal-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Select album");

    var heading = document.createElement("h2");
    heading.className = "album-modal-title";
    heading.textContent = "Albums";

    var list = document.createElement("ul");
    list.className = "album-modal-list";

    var close = document.createElement("button");
    close.type = "button";
    close.className = "album-modal-close secondary-button";
    close.textContent = "Close";
    close.addEventListener("click", closeAlbumModal);

    panel.appendChild(heading);
    panel.appendChild(list);
    panel.appendChild(close);
    modal.appendChild(backdrop);
    modal.appendChild(panel);
    document.body.appendChild(modal);

    elements.albumModal = modal;
    elements.albumModalList = list;

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !modal.hidden) {
        closeAlbumModal();
      }
    });
  }

  function renderAlbumModalList() {
    if (!elements.albumModalList) {
      return;
    }

    elements.albumModalList.replaceChildren();
    state.albums.forEach(function (album, index) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      var isActive = index === state.selectedAlbumIndex;

      button.type = "button";
      button.className = "album-modal-option" + (isActive ? " is-active" : "");
      button.setAttribute("aria-current", isActive ? "true" : "false");
      button.textContent = album.title;

      var count = document.createElement("span");
      count.className = "album-modal-count";
      count.textContent = album.tracks.length + (album.tracks.length === 1 ? " track" : " tracks");
      button.appendChild(count);

      button.addEventListener("click", function () {
        selectAlbum(index);
        closeAlbumModal();
      });

      item.appendChild(button);
      elements.albumModalList.appendChild(item);
    });
  }

  function openAlbumModal() {
    if (!elements.albumModal || !state.albums.length) {
      return;
    }
    renderAlbumModalList();
    elements.albumModal.hidden = false;
  }

  function closeAlbumModal() {
    if (elements.albumModal) {
      elements.albumModal.hidden = true;
    }
  }

  // ---------------------------------------------------------------------
  // Messaging — games embed the player (iframe/popup) and drive it with
  // postMessage. Every message is `{ type: "music-player:<command>", ... }`.
  // The player announces itself with "music-player:ready" and answers
  // "music-player:get-state" with "music-player:state".
  // ---------------------------------------------------------------------

  function playerState() {
    var track = currentTrack();
    return {
      albums: state.albums.map(function (album) {
        return {
          id: album.id,
          title: album.title,
          tracks: album.tracks.map(function (t) {
            return { id: t.id, title: t.title, file: t.file, url: t.url };
          })
        };
      }),
      selectedAlbumId: selectedAlbum() ? selectedAlbum().id : null,
      currentAlbumId: currentAlbum() ? currentAlbum().id : null,
      currentTrackIndex: state.currentTrackIndex,
      currentTrackId: track ? track.id : null,
      paused: elements.audio.paused,
      currentTime: elements.audio.currentTime || 0,
      duration: Number.isFinite(elements.audio.duration) ? elements.audio.duration : 0
    };
  }

  function rememberClient(source, origin) {
    if (!source || source === window) {
      return;
    }
    var known = state.clients.some(function (client) {
      return client.source === source;
    });
    if (!known) {
      state.clients.push({ source: source, origin: origin || "*" });
    }
  }

  function postToClient(client, message) {
    try {
      client.source.postMessage(message, client.origin || "*");
    } catch (_error) {
      /* client window may be gone */
    }
  }

  function notifyClients(event) {
    var message = {
      type: MESSAGE_PREFIX + "event",
      event: event,
      state: playerState()
    };
    state.clients.forEach(function (client) {
      postToClient(client, message);
    });
  }

  // Post a message to every embedding host — the parent frame, the popup
  // opener, and any window that has spoken to us over the protocol — deduped so
  // a host that is both (e.g. the game frame that embedded us) is hit once.
  function broadcastToHosts(message) {
    var targets = [];
    function add(win, origin) {
      if (!win || win === window) {
        return;
      }
      for (var i = 0; i < targets.length; i += 1) {
        if (targets[i].win === win) {
          return;
        }
      }
      targets.push({ win: win, origin: origin || "*" });
    }
    add(window.parent, "*");
    add(window.opener, "*");
    state.clients.forEach(function (client) {
      add(client.source, client.origin);
    });
    targets.forEach(function (target) {
      try {
        target.win.postMessage(message, target.origin);
      } catch (_error) {
        /* host window may be gone */
      }
    });
  }

  // Stream the analyser bands driving the on-screen light rig to embedding
  // hosts, so a game visualization can pulse in sync with the player. `light`
  // is the mid band — the same value drawLights() animates the rig with — and
  // `lightFrame`/`lightFrames` are the rig frame just drawn and the frame
  // count, so a consumer can land on the exact colour the lights are showing
  // (re-deriving the frame from `light` on another window's clock cycles at
  // the right rate but at an arbitrary phase offset).
  // Throttled to ~20fps; the raw callback fires per animation frame.
  var lastFrequencyPost = 0;
  function broadcastFrequency(bands) {
    var now = (window.performance && performance.now)
      ? performance.now()
      : Date.now();
    if (now - lastFrequencyPost < 50) {
      return;
    }
    lastFrequencyPost = now;
    broadcastToHosts({
      type: MESSAGE_PREFIX + "frequency",
      bass: bands.bass,
      mid: bands.mid,
      high: bands.high,
      energy: bands.energy,
      light: bands.light,
      lightFrame: bands.lightFrame,
      lightFrames: bands.lightFrames,
      playing: !!bands.playing
    });
  }

  // Announce this window as a music player. `role: "musicPlayer"` lets a host
  // register us as its current music player without inferring it from context.
  function announceReady() {
    var message = { type: MESSAGE_PREFIX + "ready", role: "musicPlayer", state: playerState() };
    broadcastToHosts(message);
  }

  function handleMessage(event) {
    var data = event.data;
    if (!data || typeof data.type !== "string" || data.type.indexOf(MESSAGE_PREFIX) !== 0) {
      return;
    }

    rememberClient(event.source, event.origin);
    var command = data.type.slice(MESSAGE_PREFIX.length);

    switch (command) {
      case "add-albums":
        addAlbums(data.albums || [], { select: data.select, play: data.play });
        break;
      case "select-album":
        selectAlbum(albumIndexById(data.album));
        break;
      case "play": {
        var albumIndex = data.album !== undefined
          ? albumIndexById(data.album)
          : (state.currentAlbumIndex >= 0 ? state.currentAlbumIndex : state.selectedAlbumIndex);
        if (data.track !== undefined) {
          playTrack(albumIndex, trackIndexByRef(state.albums[albumIndex], data.track));
        } else {
          togglePlayback();
        }
        break;
      }
      case "pause":
        elements.audio.pause();
        break;
      case "resume":
        if (currentTrack()) {
          startPlayback("Playing");
        }
        break;
      case "stop":
        stopTrack();
        break;
      case "next":
        playNeighbor(1);
        break;
      case "prev":
        playNeighbor(-1);
        break;
      case "get-state":
        postToClient({ source: event.source, origin: event.origin }, {
          type: MESSAGE_PREFIX + "state",
          requestId: data.requestId,
          state: playerState()
        });
        break;
      default:
        break;
    }
  }

  function bindEvents() {
    elements.playButton.addEventListener("click", togglePlayback);
    elements.stopButton.addEventListener("click", stopTrack);
    elements.prevButton.addEventListener("click", function () {
      if (elements.audio.currentTime > 4) {
        elements.audio.currentTime = 0;
        updateProgress();
        return;
      }
      playNeighbor(-1);
    });
    elements.nextButton.addEventListener("click", function () {
      playNeighbor(1);
    });

    if (elements.brand) {
      elements.brand.textContent = DEFAULT_BRAND;
      elements.brand.addEventListener("click", openAlbumModal);
    }

    elements.tapeShell.addEventListener("click", togglePlayback);
    elements.tapeShell.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        togglePlayback();
      }
    });

    elements.seekControl.addEventListener("input", function () {
      state.seekDragging = true;
      var duration = Number.isFinite(elements.audio.duration) ? elements.audio.duration : 0;
      if (duration) {
        elements.currentTime.textContent = formatTime((Number(elements.seekControl.value) / 1000) * duration);
      }
    });

    elements.seekControl.addEventListener("change", function () {
      var duration = Number.isFinite(elements.audio.duration) ? elements.audio.duration : 0;
      if (duration) {
        elements.audio.currentTime = (Number(elements.seekControl.value) / 1000) * duration;
      }
      state.seekDragging = false;
      updateProgress();
    });

    elements.audio.addEventListener("play", function () {
      setTapePlaying(true);
      setStatus("Playing");
      renderTrackList();
      notifyClients("play");
    });
    elements.audio.addEventListener("pause", function () {
      setTapePlaying(false);
      if (currentTrack()) {
        setStatus("Paused");
      }
      renderTrackList();
      notifyClients("pause");
    });
    elements.audio.addEventListener("ended", function () {
      var track = currentTrack();
      if (track && (Number.isFinite(track.loopEnd) || Number.isFinite(track.loopStart))) {
        elements.audio.currentTime = track.loopStart || 0;
        startPlayback("Playing");
        return;
      }
      notifyClients("ended");
      playNeighbor(1);
    });
    elements.audio.addEventListener("timeupdate", function () {
      enforceLoopRegion();
      updateProgress();
    });
    elements.audio.addEventListener("durationchange", updateProgress);

    window.addEventListener("message", handleMessage);
    window.addEventListener("resize", fitTape);
  }

  // The optional local index. shmupX ships none — the player waits for a
  // game, the launcher or the URL to hand it an album — so a 404 here is the
  // ordinary case and says nothing.
  function loadAlbums() {
    return fetch(ALBUM_INDEX_URL)
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Album index failed");
        }
        return response.json();
      })
      .then(function (albumIndex) {
        return addAlbums(albumIndex);
      })
      .catch(function () {
        /* no index — fine */
      })
      .then(function () {
        setStatus(idleStatus());
      });
  }

  // The album the URL names (?bgm=…): added after the index so a game's
  // music sits beside whatever the index had, selected, and started when the
  // URL asks (which a browser allows only once the page has been tapped).
  function loadUrlAlbum() {
    var helper = window.MusicPlayerBgmParams;
    var album = helper ? helper.albumFromParams(pageParams, window.location.href) : null;
    if (!album) {
      return Promise.resolve();
    }
    return addAlbums([album], { select: album.id, play: album.autoplay ? { album: album.id, track: 0 } : undefined })
      .catch(function () {
        /* a track that will not load is reported when it is played */
      });
  }

  function init() {
    buildAlbumModal();
    bindEvents();
    fitTape();
    visualizer.load();
    updateNowPlaying();

    var loadDefaults = pageParams.get("albums") !== "none";

    var boot = loadDefaults ? loadAlbums() : Promise.resolve();
    boot.then(loadUrlAlbum).finally(function () {
      announceReady();
    });
  }

  // Public API — lets a host page (or game running in the same window)
  // drive the player directly instead of via postMessage.
  window.MusicPlayer = {
    addAlbums: addAlbums,
    selectAlbum: function (ref) {
      selectAlbum(albumIndexById(ref));
    },
    play: function (albumRef, trackRef) {
      if (albumRef === undefined) {
        return togglePlayback();
      }
      var albumIndex = albumIndexById(albumRef);
      return playTrack(albumIndex, trackIndexByRef(state.albums[albumIndex], trackRef !== undefined ? trackRef : 0));
    },
    pause: function () {
      elements.audio.pause();
    },
    resume: function () {
      if (currentTrack()) {
        return startPlayback("Playing");
      }
      return Promise.resolve();
    },
    stop: stopTrack,
    next: function () {
      return playNeighbor(1);
    },
    prev: function () {
      return playNeighbor(-1);
    },
    getState: playerState,
    openAlbumModal: openAlbumModal,
    closeAlbumModal: closeAlbumModal
  };

  init();
})();
