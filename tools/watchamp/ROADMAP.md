# Roadmap

Status: ✅ done · 🔶 needs a device check · ⬜ todo · ⏸ deferred

The old `REMEDIATION.md` phased plan (R1–R37) is finished and has been removed;
its history is in git. This file is the whole inventory now.

## Verify before shipping

| Gate | Command | State |
| --- | --- | --- |
| Unit tests | `./gradlew :app:testDebugUnitTest` | ✅ 67 passing |
| Static analysis | `./gradlew :app:lintDebug` | ✅ 0 errors, no baseline |
| Release build | `./gradlew :app:assembleRelease` | ✅ signed, R8-minified |

Prefix with `JAVA_HOME=/home/emre/.jdks/temurin-21.0.12.1`.

## Open

- ✅ **Desktop music remote** (Library → ♪ Desktop music). Pick a song on the
  watch and the paired cmg launcher's music player switches to it; the launcher
  half is `static/watch-music.js` in the cmg repo. Verified off-device: the
  bridge against a stand-in database in the JVM tests, and end to end against
  the real launcher and player in headless Chromium — launch, pause/resume,
  next/prev, a refused press, and a cold start with the player not yet open.

  **Verified on the Pixel Watch 5** (2026-10-01), debug build, against the
  hosted launcher and the real database: the code typed on the watch keyboard,
  the album list, a tapped song starting on the desktop and showing as playing
  on the wrist, pause / play / next / previous, and a fresh `sync` after the
  app was backgrounded and brought back.

  The device run earned its keep: the keyboard's ✓ did nothing at all until
  `onDone` was made to close the keyboard itself for a not-yet-valid code.

  **Still unchecked:** crown and finger scrolling of the album list (adb cannot
  scroll a lazy list), what the screen says with Wi-Fi off, the release build
  (R8 has not seen this code), and the battery cost of holding the stream open
  while the screen is up.
- 🔶 **First real listening session, 2026-09-01 evening.** Three problems
  reported from an actual run with Pixel Buds Pro:

  | Reported | Status |
  | --- | --- |
  | A phone notification to the headset stopped playback entirely, no resume | ✅ fixed |
  | Playback overlapped watch/phone announcements | 🔶 partly — see below |
  | A watch health announcement did not pause the book | ⬜ may not be fixable |

  The cause of the first was a dead audio route: the only trace left behind was
  `state=ERROR(7) … error=Bluetooth audio disconnected` in `dumpsys
  media_session`. `handleAudioBecomingNoisy` was never set, `onPlayerError` only
  recorded the failure and never re-prepared, and release builds logged nothing
  at all. All three are fixed, and warnings now survive into release builds
  (`adb logcat -s Aloud:W`).

  Verified on the watch, both directions: playing when the route drops resumes by
  itself (1:06:37 → 1:06:51); a book the listener paused stays paused
  (1:06:57 → 1:06:57).

  **Not proven:** the exact reported case. Testing used a full Bluetooth
  disconnect, not a phone notification briefly seizing the headset — the same
  class of event, handled generically, but it cannot be driven from adb. The next
  run is the test.

  **Possibly not fixable:** a watch announcement that plays *without requesting
  audio focus* is invisible to the player. Audio focus itself is configured
  correctly — Media3 requests it and, because the content type is `SPEECH`,
  pauses rather than ducks.
- ⬜ **Nobody has yet listened for an hour uninterrupted.** Battery cost over a
  run is also unmeasured.
- ✅ **Running as `com.emre.aloud` on the watch** (2026-09-01): 21 books /
  8.80 GB verified byte-exact against the source library, old `com.emre.wearbook`
  package and its data removed.
- ✅ **Release workflow proven** by tag `v0.1.0`. It had never worked before: the
  job wrote the keystore password but never put a keystore on the runner, and no
  repository secrets existed at all. It now decodes `ALOUD_STORE_B64`, runs only
  after tests pass, and the attached APK was confirmed to carry the release
  certificate (`5A:75:82:00…`).
- ✅ **Uploader re-verified on the watch**: ten endpoint checks (PIN enforcement,
  mandatory `total`, overshoot → 413, traversal → 400), a 3 MiB chunked upload
  that came back sha256-identical, and DELETE cleanup.
- ✅ **Crown/rotary scrolling, `TimeText`, chapter-list auto-follow** — confirmed
  by hand on the Pixel Watch 5. Touch scrolling works too; only synthetic
  `adb input swipe` fails to move the list, which is an adb artefact.
- ✅ **Getting back to the player from the library.** The library used to be a
  one-way trip; it now shows a `▶ <title>` row while a book is loaded, and
  re-tapping the current book navigates instead of re-preparing it.
- ✅ **Chapters verified on the Pixel Watch 5** (2026-09-01), both formats and
  both entry paths: M4B QuickTime `ch 1/17`, MP3 ID3 `CHAP` `ch 1/21`, chapter
  list renders, and a cold restart resumes at 18.6 s with the chapter list
  intact.

  On-device testing earned its keep here. Deleting the hand-written parser in
  favour of the player's own chapter callbacks looked airtight off-device, but
  ExoPlayer only drives the extractor past the header **while playing**, and
  `Mp4Extractor` drops chapters on the first seek. So every resume — and the
  paused continue-listening startup, i.e. normal use — came up with no chapters.
  Every JVM test read from byte zero and never saw it. Fixed by
  `books/ChapterReader.kt`, which drives Media3's extractor over the file on an
  IO thread, independently of playback position.

  A second on-device finding reversed the parser deletion outright. Media3's
  MP4 extractor parses the whole audio sample table before publishing chapters:
  **over 4 minutes** for a 1.3 GB / 23 h book on the watch, versus 0.3 s for
  `Mp4ChapterParser`, which reads only `chpl` and the chapter track. The parser
  is back for MP4/M4B; Media3 still handles MP3 ID3 `CHAP` (no sample table, so
  it is fast). Measured across the reference library: every count matches
  `ffprobe`, worst case 0.5 s.

  Note: some files genuinely have no chapters — an empty list there is
  correct, not a bug. Files that tag every chapter with the book's own title are
  renumbered "Chapter N" rather than shown as-is.
- ⬜ The browser upload page itself (the JS in `UploadServer.kt`) is still only
  exercised by hand; the server contract underneath it is covered by tests and
  was re-verified on the watch.
- ⬜ Rate-limit wrong PINs per source address. Today any device on the LAN can
  stop the uploader with 20 wrong guesses — an unauthenticated denial of service.
  Also consider a `Host`-header check to defeat DNS rebinding.
- ⬜ Serialise concurrent uploads to the same name. Two parallel POSTs to one
  `.part` interleave their writes; the web client is sequential, so it takes a
  second client to hit, but it can corrupt a book.
- ⬜ Detect ALAC-only M4Bs and warn (ExoPlayer has no ALAC decoder; advise an AAC
  transcode).
- ⬜ Library search/filter once the book count passes a screenful.
- ⬜ Battery measurement on the watch during playback (wake mode is already `LOCAL`).
- ⬜ IzzyOnDroid submission (no account fee; the step before F-Droid proper).

## Deferred

⏸ Bookmarks · skip-silence · volume boost · edit-list (`elst`) offsets ·
Play Store ($25 + Wear review; sideloading works indefinitely).

## Session-handoff notes

- Build: `JAVA_HOME=/home/emre/.jdks/temurin-21.0.12.1 ./gradlew :app:assembleDebug`
- Device: `adb mdns services` finds the pair/connect ports (they rotate on watch
  reboot). A reboot also turns WiFi debugging off, and the watch kills the app
  process aggressively when idle — expect pid churn; the media FGS keeps it alive
  while playing.
- Screenshots aren't readable over adb — use `uiautomator dump` and
  `logcat -s Aloud`.
