# The music player

AZLegendGolden's cassette deck — the "AZ Legend" music player the cmg launcher
docks beside a game — vendored into shmupX so the launcher serves its own copy
at `/music-player/` and nothing here reaches out to the artist's deployment.
The source is [easierbycode/azlegend](https://github.com/easierbycode/azlegend)
(`static/player.html` and `static/public/app/`), taken 2026-10-27; the
tracks are not: the deck boots empty and waits for a game, the launcher or the
URL to hand it an album.

Every URL in the page is relative, which is why `/music-player` is listed in
`lib/static-indexes.ts`: served at the bare path, its stylesheets would resolve
one directory too high.

## What is here

| File | What |
| --- | --- |
| `index.html` | The deck. The same markup as azlegend's `player.html`, minus the artist's bio and the PWA offline button. |
| `app.js` | The player: albums, transport, the tape, and the `music-player:` postMessage protocol below. |
| `bgm-params.js` | The album the URL names (`?bgm=`), checked before it is loaded. |
| `audio-visualizer.js` | The light rig behind the deck, driven by an analyser on the `<audio>`; its bands are streamed to hosts as `music-player:frequency`. |
| `game-bgm.js` | A game's side: route BGM through the player instead of a sound manager. Ported from cmg's `static/music-player/sound.js`. |
| `styles/`, `image/`, `font/`, `images/` | The cassette-tape UI, its skins and fonts, the rig's sprites. |

## Handing it music

Three ways in; they can be combined, and an album with the same id replaces
the earlier one.

**On the URL.** A game (or anyone) opens the player with its tracks:

```
/music-player/?bgm=https://cdn.example/stage1.mp3&bgm=https://cdn.example/boss.mp3
             &title=Stage%201&title=Boss&album=My%20Game&autoplay=1
```

`bgm` (also `bgmURL`) repeats once per track, `title` beside it in the same
order (optional — a missing one is read off the file name), `album` names the
album, and `autoplay=1` starts the first track as soon as the browser allows
it (which is after the page has been tapped; until then the deck says "Tap
Play to start"). Only `http(s)` and `blob:` URLs are kept, at most 200.
`?brand=` names the deck; `?albums=none` skips `./albums.json`, the index the
deck reads on every boot — shipped as an empty list, so an album that should
always be there is added by editing that file.

**Over postMessage.** A host — the launcher's sidebar, a game that embedded
the player in an iframe — sends

```js
frame.contentWindow.postMessage({
  type: "music-player:add-albums",
  albums: [{ id: "my-game", title: "My Game", tracks: [
    { id: "stage1", title: "Stage 1", url: "https://cdn.example/stage1.mp3",
      volume: 0.6, loopStart: 0.9, loopEnd: 61.1 },
  ] }],
  select: "my-game",            // optional
  play: { album: "my-game", track: "stage1" },   // optional
}, "*");
```

A track's `loopStart`/`loopEnd` (seconds) make the player loop that region
instead of advancing, which is how a game's BGM markers survive the trip.

**From a game in the launcher.** The 2028-ai runtime posts its level's BGM —
the stock boss tracks and whatever `customAudioURLs` the level carries — to
the launcher as `{ type: "cmg-music-album", album }` once its level resolves
(`cmgBroadcastMusicAlbum` in `game.bundle.js`). The launcher checks the album
(http(s) URLs only, bounded), mounts the player out of sight if it is not up,
and adds it. The Guide's **Music → Music Player** row then opens the deck
over the game with that album on it; while the deck plays, the game's own BGM
channel is held at zero and comes back when the deck pauses or stops.

`game-bgm.js` is the other direction: a game whose sound code is in its own
hands can `initSound(game, { bgm: {...}, tracks: {...} })` and have every BGM
key play in a hidden player frame, the way cmg's 2019-turbo does.

## The protocol

Everything is `{ type: "music-player:<command>", ... }`.

| Host → player | |
| --- | --- |
| `add-albums` | `albums: [...]`, optional `select`, `play` |
| `select-album` | `album: <id>` |
| `play` | `album`, `track` to start one; no `track` toggles play/pause |
| `pause` · `resume` · `stop` · `next` · `prev` | the transport |
| `get-state` | answered with `state` (carrying the same `requestId`) |

| Player → host | |
| --- | --- |
| `ready` | on boot, to the parent and opener: `role: "musicPlayer"`, `state` |
| `event` | `event: albums-changed · album-selected · track-change · play · pause · stop · ended`, with `state` |
| `state` | the answer to `get-state` |
| `frequency` | ~20 Hz while playing: `bass`, `mid`, `high`, `energy`, `light`, `lightFrame`, `lightFrames` |

`state` is `{ albums: [{ id, title, tracks: [{ id, title, file, url }] }],
selectedAlbumId, currentAlbumId, currentTrackIndex, currentTrackId, paused,
currentTime, duration }`. The same window object is `window.MusicPlayer`
(`addAlbums`, `play`, `pause`, `resume`, `stop`, `next`, `prev`, `getState`).

## The watch

A paired watchAmp (`tools/watchamp/`, its **♪ Desktop music** screen) lists the
albums on this deck and switches the song. That is the launcher's doing, not
the player's: `static/watch-music.js` publishes the player's library and state
to the Realtime Database and plays what the wrist picks, by the ids the player
itself reported. See **The music player and the watch remote** in
`README-Technical.md`.
