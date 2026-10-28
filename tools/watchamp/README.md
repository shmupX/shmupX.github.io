# 🐵 Music (watchAmp)

> **shmupX's copy.** This is [shmupX/watchAmp](https://github.com/shmupX/watchAmp)
> as of 2026-10-27, vendored so the watch end of the music remote lives beside
> its desktop end: the launcher's `static/watch-music.js` and its wiring in
> `svelte-src/Dashboard.svelte`, which dock the music player at
> `static/music-player/`. The two halves share one wire format and change
> together. Build it from the repo root with `deno task watchamp:build`
> (`watchamp:install` sideloads it, `watchamp:test` runs the JVM tests), or
> from this directory with `./gradlew` as below. The app, its package name
> `com.emre.aloud` and its GPL-3.0 licence (see `LICENSE`) are unchanged — it
> descends from [tuncoglu/aloud](https://github.com/tuncoglu/aloud).
>
> **Pairing with shmupX:** on a desktop running shmupX the code to type is the
> BUILD CODE under **Settings → BUILD SERVER**; on the hosted site it is the
> code **Settings → WATCH REMOTE** shows once the remote is switched on.
> Either way the row has to be ON for the desktop to answer.

> Formerly **Aloud**. Only the name on the watch and the icon changed: the
> package is still `com.emre.aloud`, and the code, logs and developer notes
> still say Aloud.

**Your audiobooks. On your Wear OS watch. No phone required.**

🐵 Music is a free, open-source, standalone audiobook player for Wear OS. Copy your
own DRM-free **MP3 or M4B audiobooks** to a Pixel Watch, connect Bluetooth
headphones, and go for a run without carrying a phone.

It is designed for people looking for a **Wear OS audiobook player**, an
**offline audiobook app for Pixel Watch**, or a private way to listen to their
own audiobook library without Audible, a cloud account, or a companion app.

> **Status:** usable sideloaded alpha. Built and tested on Pixel Watch 5 running
> Wear OS 4+. There is not yet a Play Store listing or public APK release.

[![CI](https://github.com/tuncoglu/aloud/actions/workflows/ci.yml/badge.svg)](https://github.com/tuncoglu/aloud/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

## What it does

- Plays local **MP3 and M4B** audiobooks directly on the watch
- Remembers your position separately for every book, including after restarts
- Reads chapters from M4B Nero/QuickTime chapter tracks and MP3 ID3 `CHAP` frames
- Offers playback speed from 0.75–2.0× and a persistent 15/30/60/120-minute sleep timer
- Keeps playing with the screen off and supports system media controls and headset buttons
- Recovers cleanly when Bluetooth headphones temporarily disconnect
- Transfers books through a built-in browser uploader over your local Wi-Fi
- Doubles as a remote for desktop music: pick a song on the watch and a paired
  shmupX launcher (or the [cmg launcher](https://github.com/easierbycode/cmg)
  the remote was first built for) switches to it
- Requires no phone, companion app, account, cloud service, analytics, or tracking

## The simple workflow

```
Computer ──(local Wi-Fi upload)──> Wear OS watch ──(Bluetooth)──> headphones
```

On the watch, open **🐵 Music → Uploader → Start**. 🐵 Music displays a local address
and a six-digit PIN. Open that address on a computer on the same Wi-Fi, enter the
PIN, and drag in your `.m4b` or `.mp3` files. Stop the uploader, choose a book,
connect headphones, and listen.

The uploader is intentionally local and temporary: it starts only when you ask
it to, stops after two minutes idle, and removes incomplete files. 🐵 Music does not
need internet access to play books already stored on the watch.

## Desktop music remote

Separate from the audiobook player, and optional: **Library → ♪ Desktop music**
lists the albums of the music player docked in a shmupX launcher (or a
[cmg launcher](https://github.com/easierbycode/cmg); both speak the same
protocol) and switches the song playing there when you tap one, with previous
/ pause / next alongside.

```
watch ──(internet)──> Firebase Realtime Database <──(internet)── launcher ──> music player
```

1. In the launcher, open **Settings → WATCH REMOTE** and switch it on. It shows
   an eight-character code such as `ABCD-EFGH` (on a shmupX desktop that is
   its BUILD CODE, the one its watch app already pairs by).
2. On the watch, open **🐵 Music → ♪ Desktop music**, type the code and tap
   **Pair**. It is remembered; **Unpair** is at the bottom of the list.

The watch and the desktop never connect to each other — both talk to the
database, so they do not need to share a network and the desktop needs no open
port. It is the same arrangement shmupX's watch app uses to start a game on a
desktop. Unlike everything else in 🐵 Music this part does need internet access on
the watch, and only while that screen is open: the connection is dropped when
the app leaves the foreground.

A song is not shown as switched until the desktop says so, and a press nobody
answers says "No reply from desktop" rather than pretending. The pairing code
is the only secret: the database is open to anyone who knows it, which is why
the launcher only ever plays tracks its own player reported and the watch treats
everything it reads as untrusted. Volume is not remotely adjustable — the
player has no command for it.

To bake a code into your own build instead of typing it, see
[`local.properties.example`](local.properties.example).

## Install

🐵 Music is currently installed by sideloading. Enable wireless debugging on the
watch:

**Settings → System → Developer options → Wireless debugging → On**

Then pair and connect with ADB:

```bash
adb pair 192.168.x.y:<pair-port>        # enter the code shown on the watch
adb connect 192.168.x.y:<connect-port>
./gradlew :app:installDebug
```

The debug APK is also produced by CI for every push. A public, signed APK download
will be added to GitHub Releases when the distribution workflow is ready.

## Build and test

Requirements: JDK 21 and an Android SDK with API 37 installed.

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:lintDebug
./gradlew :app:assembleDebug
./gradlew :app:assembleRelease
```

The test suite covers M4B chapter parsing, MP3 chapter handling, the uploader
contract (including PIN enforcement, chunk validation, retries and cleanup),
library naming/media-ID rules, and the desktop remote (wire format, the event
stream, and the whole press-and-wait-for-an-answer path against a stand-in
database). CI runs tests, lint and a debug build on every
push and pull request; tagged builds produce a signed release APK when the
repository signing secrets are configured.

## Why this project exists

Most Wear OS audiobook options are phone-first, closed, cloud-dependent, or
awkward for a personal DRM-free library. 🐵 Music does one thing deliberately:
make the watch itself a reliable offline audiobook player for running, walking,
travel, and sleep.

## Engineering notes

The interesting implementation details are documented in the source and
[ROADMAP.md](ROADMAP.md). In particular:

- MP4/M4B chapters are parsed in O(chapters), avoiding Media3's slow full sample-table
  scan on large audiobooks.
- Chapter discovery happens off the playback path, so chapters remain available
  when resuming a paused book.
- Bluetooth route loss is handled as a recoverable interruption while deliberate
  pauses remain paused.
- The release build is R8-minified and signed outside the repository.

## Limitations

- Wear OS only; this is not an Android phone, iOS, or desktop player.
- Tested primarily on Pixel Watch 5. Other Wear OS watches may work but are not
  yet verified.
- Files must be DRM-free. ALAC-only M4B files are not currently supported.
- Sideloading is required for now.
- Long uninterrupted listening and battery impact still need broader real-world
  testing.

## Contributing

Bug reports and device compatibility reports are welcome. Please include the
watch model, Wear OS version, 🐵 Music version/commit, file format, and whether the
problem is reproducible after restarting the app. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap and licence

See [ROADMAP.md](ROADMAP.md) for current verification status and planned work.

🐵 Music is licensed under [GPL-3.0](LICENSE).
