# Aloud — notes for coding agents

A standalone audiobook player for Wear OS (Pixel Watch 5). ~2,000 lines of Kotlin.
`ROADMAP.md` is the human-facing plan; this file is the machine-facing memory of
things that are expensive to rediscover.

**The app is called "🐵 Music" on the watch** — launcher label, uploader page,
store title, and a 🐵 launcher icon (`drawable-*/ic_launcher_monkey*.png`,
rendered from Noto Color Emoji and Noto Emoji). Everything internal is still
Aloud: the package `com.emre.aloud`, the `Aloud` log tag, the keystore alias and
these notes. Do not rename the package — a new `applicationId` is a different
app to the watch, and the installed one keeps its library.

## Build and verify

```bash
export JAVA_HOME=/home/emre/.jdks/temurin-21.0.12.1
./gradlew :app:testDebugUnitTest   # 67 JVM tests
./gradlew :app:lintDebug           # gate: 0 errors, no baseline
./gradlew :app:assembleRelease     # signed, ~5 MB, R8-minified
```

Release signing uses `~/.gradle/aloud-release.jks` (alias `aloud`, password in
`~/.gradle/gradle.properties` as `aloudReleaseStorePassword`). CI decodes the same
keystore from the `ALOUD_STORE_B64` secret, so locally built and CI-built release
APKs are interchangeable for install purposes.

## Traps that have already cost real time

**Do not "simplify away" `books/Mp4ChapterParser.kt`.** It looks redundant with
Media3, which parses the same chapter formats. It is not. Media3's `Mp4Extractor`
parses the entire audio sample table before publishing chapters — millions of
entries for a 23 h book. Measured on the watch: **>4 minutes** for a 1.3 GB M4B
versus **0.3 s** for the parser, which reads only `chpl` and the chapter track.
It is O(chapters), Media3 is O(audio samples). This was deleted once and had to be
restored. A PC's CPU and page cache hide the difference completely.

**Chapters must be read off the playback path.** ExoPlayer only drives the
extractor past the file header *while actually playing*, and `Mp4Extractor` drops
chapters on the first seek. A book opened paused at its saved position — every
resume, and the default startup screen — gets nothing from `Player.Listener`.
`books/ChapterReader.kt` reads the file directly on an IO thread. The listener
path is kept only as a bonus for playback from byte zero.

**`readChapters()` must start *after* `player.setMediaItem()`.** `onMediaItemTransition`
cancels `chapterJob`, so a read started earlier is cancelled by the very item it
was reading for.

**Any JVM test that reads a file from byte zero cannot see either bug above.**
Both were found only on device.

**`onPlayWhenReadyChanged` reports a becoming-noisy pause even for a book that
was ALREADY paused.** Auto-resume must therefore be gated on `wasPlaying`, not
on the reason alone — otherwise a Bluetooth blip arms auto-resume on a book the
listener deliberately stopped, and reconnecting a headset later starts it
playing. Two cases must both be checked after any change here: playing when the
route drops (must resume) and user-paused when it drops (must stay paused).

## The desktop music remote (`remote/`)

Not part of playback: `ui/RemoteScreen.kt` switches songs on a paired desktop
through a Firebase Realtime Database, the way shmupX's watch app starts games.
The other half is `static/watch-music.js` plus its wiring in
`svelte-src/Dashboard.svelte` — in **this** repo (shmupX, two directories up),
and the same files in the **cmg** repo the remote was first written against;
all three must change together. shmupX's launcher pairs by its BUILD CODE on a
desktop, so one code reaches both its game launcher and this remote.

```
watch   --> /builders/<code>/music/launch    {id, album, track, created_at}
watch   --> /builders/<code>/music/control   {action, created_at}
desktop --> /builders/<code>/music/playing   {state, album, track, title, id, failed_id, detail}
desktop --> /builders/<code>/music/library   {albums: [{id, title, tracks: [{id, title}]}]}
```

- **The stream's first frame is history, not a desktop.** Every connection
  opens with a snapshot of whatever the last session left in the database.
  `hostSeen` therefore only turns true on a write that arrives *after* it —
  normally the answer to the `sync` the watch sends on connect. Showing the
  snapshot's `playing` as live is the bug this prevents.
- **The desktop answers a `sync` by writing, even if nothing changed**, because
  the database does not notify listeners of a write that changed nothing.
  `updated_at` is what makes it a change. Do not "optimise" it away.
- **Nothing compares the watch's clock with the desktop's.** `created_at` only
  tells one control from another. The launcher recognises stale records by
  position — the first frame after each connect is history — because a
  "written before I booted" rule silently drops every press from a watch whose
  clock runs behind.
- **A launcher switched on after the watch said hello announces itself but
  sends no albums**; the bridge re-sends `sync` on a desktop's first word if
  the hello was not recent.
- **`failed_id` rides beside `state`, never over it.** A refused press must not
  make the watch forget the song still playing.
- **A press is settled only by `playing.id` naming it.** There is no timer that
  assumes success; the 12 s deadline only ever produces "No reply".
- **Everything read is untrusted** — the database is open-write to anyone with
  the code. Ids are de-duplicated because they feed lazy-list keys (a repeat
  crashes the list) and are never truncated (a shortened id names nothing).
- **`HttpURLConnection.disconnect()` is called off the main thread.** A read
  blocked on the socket ignores coroutine cancellation, so `stop()` has to
  close the connection — and closing a TLS socket writes to it.
- **org.json is a stub under unit tests** (`isReturnDefaultValues`). The real
  one is a `testImplementation` dependency; without it every parse returns null
  and the tests fail in ways that look like logic bugs.
- **No HTTP client library on purpose.** `HttpURLConnection` plus a forty-line
  event-stream reader costs the APK nothing.

- **The watch keyboard's confirm fires `onDone` on its own terms.** Supplying
  `onDone` replaces Compose's default of closing the keyboard, so the handler
  must either pair or call `defaultKeyboardAction` — otherwise the ✓ button
  looks dead. And it must read validity from the state, not from a value
  captured at composition, which can still be the pre-typing one.

`RemoteBridgeTest` runs the bridge against a real local HTTP server standing in
for the database. Verified on the Pixel Watch 5 (2026-10-01) against the hosted
launcher and the real database: typing the code on the watch keyboard, the
album list, switching a song, pause/play/next/previous, and the stream being
re-opened with a fresh `sync` after the app was backgrounded and brought back.

Driving that screen over adb has its own traps:

- **`adb shell input text` does not type into the app.** The characters show up
  in the Wear keyboard's preview line but never reach the text field
  (`onValueChange` is not called), and ✓ then submits an empty field. Tap the
  on-screen keys by coordinate instead; those arrive one `onValueChange` each.
- **Wait for the keyboard before tapping keys.** It can take from one to more
  than five seconds to appear; poll `dumpsys input_method | grep
  mInputShown=true`. Taps sent early land on the app underneath.
- **`--es screen remote`** opens the screen directly on a debug build.

## Device workflow

Use the `wear-device-testing` skill. The essentials:

- **`run-as` only works on a debuggable build.** The watch normally runs the
  *release* build, so `adb push` + `run-as cp` is unavailable and books must go in
  through the app's own uploader over HTTP (~2.8 MB/s).
- **Installing the app kills the upload service.** Never `adb install` while a
  transfer is running; finish the upload first. This has interrupted transfers twice.
- **debug and release signatures differ.** Switching between them requires an
  uninstall, which **wipes the library** (8.5 GB). Same-key release→release
  upgrades keep app data.
- **`uiautomator dump` is unreliable** when the watch is dozing or on its charger:
  it returns stale content, mixes in watch-face nodes, or reports rows with empty
  text. **Take a screenshot and look at it** before believing a dump. A phantom
  "blank row" bug was chased for several turns before a screenshot showed the app
  was not even foregrounded.
- **Synthetic input scrolls a `verticalScroll` but not a lazy list.** `adb shell
  input swipe` moves `NowPlayingScreen`; it does nothing to `TransformingLazyColumn`
  in the library or chapter list. That is an adb limitation, not an app bug —
  fingers and the crown work on both.
- **mdns leaves duplicate adb entries** (`192.168.0.15:39023` and
  `adb-…_tcp`), after which plain `adb shell` fails with "more than one device".
  `adb disconnect <ip:port>` clears it.
- **A paired phone sends `KEYCODE_MEDIA_PAUSE`** (`callingPackage:
  com.google.android.bluetooth`) shortly after playback starts, which pauses the
  book. Suspect this before suspecting the app when playback stops on its own.

## Release and distribution

- **`versionCode` must increase for every release.** `v0.1.0` and `v0.1.1` both
  shipped `versionCode = 1`; F-Droid and IzzyOnDroid key updates off that field and
  would not have seen the second as newer.
- **Verify the artifact matches the commit before claiming a build is current.**
  A CI artifact from an older tag was once installed and described as up to date.
  Pull the APK back off the device and compare hashes:
  `adb pull $(adb shell pm path com.emre.aloud | sed 's/package://')`.
- Fastlane metadata for IzzyOnDroid lives in `fastlane/metadata/android/en-US/`.

## Library conventions

Audiobooks live in `~/Audiobooks`, named **`<Author> - <Full Title>.<ext>`** —
author first, then the full title including any subtitle.
Tags follow `artist` = author and `title` = `album` = full title including
subtitle; cover art embedded. Retag losslessly and confirm the audio is untouched:

```bash
ffmpeg -i in.m4b -map 0 -c copy -metadata title="..." -disposition:v:0 attached_pic out.m4b
ffmpeg -v error -i FILE -map 0:a -c copy -f streamhash -hash md5 -   # must not change
```

`ffprobe -show_chapters` is the reference for expected chapter counts; the app
should match it exactly. Some files legitimately have zero chapters — an empty
list is correct, not a bug. Never fabricate chapter marks.
