# shmupX Watch

The wrist end of shmupX. Two apps sharing one database and one pairing code:

- **The launcher** — browse the games catalog, send one to the paired desktop,
  and drive it from there. Eight screens, built from the Claude Design handoff
  in `shmupX-Watch.dc.html`.
- **The agent screens** — dictate a change to a sprite and watch the preview
  come back. The original build of this app, one swipe away.

Its desktop halves live in this same repo: `tools/watch-bridge/` runs the agent
that edits sprites, and `svelte-src/Dashboard.svelte` (via
`static/watch-launch.js`) is what actually starts a game when the wrist asks.

It runs on a clean clone with nothing configured — the bridge falls back to
canned data, and the fake desktop answers a launch, so every screen can be
walked on an emulator before any of it is wired up.

## The launcher

| Screen | What it is |
|---|---|
| Tile | Who we are paired with, and CONTINUE — the last thing launched. |
| Library | The catalog as a crown-driven carousel: the middle row is selected. |
| Dezaemon shelf | 262 Saturn saves, scrubbed A–Z. |
| Detail | One game, its metadata, a favourite star and LAUNCH. |
| Voice | Real dictation, matched against the real catalog. |
| Launching | Waiting for the desktop — with a deadline, and an honest failure. |
| Now playing | Transport and volume for whatever is running over there. |
| Input map | What this app can actually be driven with. |

Catalog comes from two places, both read straight over HTTPS with no SDK:
`https://codemonkey.games/games.manifest.json` for the games, and
`<rtdb>/dezaemon/index.json` for the shelf. Covers are deliberately not
prefetched — 262 saves at ~50 KB of base64 each is not a thing to do behind a
crown.

### The launch protocol

```
watch --> /builders/<code>/launch    one slot, latest press wins
watch --> /builders/<code>/control   pause · resume · stop · volume
watch <-- /builders/<code>/playing   what the desktop says is running
```

`LAUNCHING` does not advance on a timer the way the mock does — it waits for
the desktop to say the game started, and says so when nothing answers. The
payload and the rules that decide whether to act on one are in
`static/watch-launch.js`, tested in `tests/watch_launch_test.ts`.

**The database is open-write.** Anything arriving on these nodes was written by
whoever knows the build code. Nothing in the payload is used to build a path or
a URL: ids are looked up in catalogs the launcher already holds, and the one
free-form `url` field is clamped to the launcher's own origin.

## Versions

`gradle/libs.versions.toml` now pins Wear Compose at **1.6.2** for both
`wearCompose` and `wearComposeM3`, and the two have to stay equal — the library
unified its version line at 1.5.0, so foundation, material3, navigation and
material all ship as one number.

It used to read `1.4.1` / `1.0.0-alpha28`, which was a fiction worth knowing
about: material3 alpha28's module metadata *requires* foundation 1.5.0-alpha05,
Gradle resolves the maximum, and the 1.4.1 pin never reached the classpath at
all. The app was really being built against three separate alphas. Check any pin
in that file with

```bash
./gradlew :app:dependencies --configuration debugRuntimeClasspath
```

before believing it.

`compileSdk = 36` on AGP 8.7.3 prints a warning and builds fine.

## Run it

```bash
cp local.properties.example local.properties
# set sdk.dir; leave SHMUPX_RTDB_URL blank to stay on demo data
./gradlew :app:installDebug
```

Emulator: Android Studio's Wear OS API 36 image, large round. That's a 456x456
panel, matching the 45mm Pixel Watch 5.

## How the pieces fit

```
  watch                         firebase rtdb                desktop
  ─────                         ─────────────                ───────
  dictate ──────────────────>  /utterances  ──────────────>  bridge.mjs
                                                                 │
                                                          claude -p + MCP
                                                                 │
  sprite  <─────────────────   /preview     <────────────────────┤
  states  <─────────────────   /agents      <────────────────────┘
                                    │
                                    └──> codemonkey.games (?builder=CODE)
```

The database is the only thing both ends share, which is why the watch needs no
companion app and the desktop needs no inbound ports.

## What each piece does

| Path | Why it exists |
|---|---|
| `bridge/AgentBridge.kt` | One interface, three possible backends. `FakeBridge` is the default. |
| `bridge/FirebaseRestBridge.kt` | RTDB over REST + SSE. No google-services.json, no Play Services, smaller APK. |
| `ambient/AmbientController.kt` | Turns `AmbientLifecycleObserver` callbacks into a flow. |
| `session/SessionService.kt` | The ongoing activity. **This** is what keeps the app off the watch face. |
| `voice/VoiceInput.kt` | `RecognizerIntent` dictation. Needs the `<queries>` manifest entry. |
| `ui/SpriteCanvas.kt` | Integer scaling, `FilterQuality.None`. Pixel art stays crisp. |
| `ui/screens/AmbientScreen.kt` | Separate low-power layout: rings not discs, mostly black. |
| `daemon/bridge.mjs` | Desktop side. Reads utterances, runs your MCP, writes previews. |

## Staying open

Three separate things, often confused:

1. **Ambient** keeps your UI on screen when the display dims. On Wear OS 6+ with
   `targetSdk 36` you get this for free — `AmbientController` only decides what
   it *looks* like.
2. **Ongoing activity** exempts you from the second timeout, where the system
   gives up and shows the watch face. `SessionService` does this.
3. **`FLAG_KEEP_SCREEN_ON`** is the only true never-sleeps option and is
   deliberately not used here. It's a wake lock. Your battery will not survive
   an afternoon.

`startSession()` fires on first dictation rather than on launch, so you're not
running a foreground service just because the app is open.

## Wiring the bridge

1. Create a Realtime Database. For a personal setup, lock rules to your own UID
   and put a token in `SHMUPX_RTDB_AUTH` — `.read`/`.write` of `true` on a
   public URL means anyone who finds it can drive your agent.
2. Set `SHMUPX_BUILDER_CODE` to match the `?builder=` code the editor already
   uses, so watch, daemon and browser land on the same node.
3. `cd daemon && npm start`.

## Gestures: what is real on a Pixel Watch

The handoff's input map lists five gestures. Three of them do not exist on the
watch it targets, so the app does the honest thing instead and its INPUT MAP
screen says what is actually true.

| Design | Reality |
|---|---|
| Rotating crown | **Real.** `onRotaryScrollEvent` for values, and lists get it for free. |
| Side button, hold to talk | **Not available.** Wear guarantees only the power button; `KEYCODE_STEM_*` are optional and a Pixel Watch's side button is the system's (recents, assistant). Talking is an on-screen target instead. |
| Wrist flick, next row | **Not available.** Flick-to-scroll was removed in Wear OS 3. The gesture that came back is a wrist *turn*, and Google's guidance is explicit that it means dismiss and must not be remapped. |
| Double pinch, launch/confirm | **Real, not wired.** `Modifier.oneHandedGesture` needs `compose-material3` 1.7 and Wear OS 7; this app is on 1.6.2 stable. Worth adding when 1.7 ships — and note the guidelines require a visible button beside every gesture, which every action here already has. |
| Cover screen to stop | **Not available.** Pixel Watch 4 and 5 have no proximity sensor, and palm-cover is the system's own sleep gesture. What this app does instead: when the screen goes ambient, the running game **pauses**. |

## Not built, on purpose

- **Tiles and widgets.** A tile showing blocked-agent count would be better than
  opening the app at all. Wear OS 7 Widgets use Jetpack Glance + RemoteCompose.
- **Data Layer.** If you'd rather go phone-tethered than cloud, implement
  `AgentBridge` over `MessageClient`/`DataClient` and delete the Firebase class.
- **Complications.** Same idea, smaller surface.
- **Double pinch.** See the gesture table — a version bump away.
- **A pairing screen.** The build code comes from `local.properties` at build
  time. Typing eight characters on a 240 dp circle is miserable, and the code
  already arrives two better ways: the desktop prints a QR of it, and dictation
  is already in the app.

## Notes from the device

Things that only showed up on real hardware, kept here so they are not
rediscovered:

- **The panel is 480×480 at density 320 — 240 dp, not the design's 456.** The
  emulator's `wearos_large_round` is 454×454 (227 dp). Both are laid out for;
  the smaller one is the constraint.
- **A circle is narrowest where the design puts its footers.** About 130 dp of
  usable width remains near the bottom edge. The library's two-part hint had to
  become one line.
- **`AppScaffold` draws the clock exactly where the design puts its status
  line.** Suppressed with `timeText = {}` — the launcher is full-bleed and
  carries its own header.
- **Orbitron is wide.** The design's nominal title size ellipsised
  "SUPER MARIO SP" in a library row; titles sit a step smaller as a result.
- **Neither font has the design's symbols** (`◉ ≡ ■ ❚ ★ ☆ ◂ ▸ →`). They are
  drawn as vectors in `ui/Glyphs.kt`; set as text they fall back to the system
  sans at a visibly different weight.
- **Wear evicts a foreground app to the watch face within seconds.** The
  ongoing activity now follows the game, not just dictation — without it the
  transport controls disappear while you are holding them.
- **Ambient unmounts the whole interactive tree.** Anything remembered inside
  that branch — including the nav controller, and so every ViewModel scoped to
  a back stack entry — is rebuilt on the next wrist raise. The controller is
  created above the branch for that reason, and "pause when the screen dims"
  had to move out of the launcher entirely: an effect inside the thing ambient
  tears down can observe the tear-down only by dying.
- **An okhttp-sse stream that drops does not throw.** `newEventSource` is
  asynchronous, so a `try` around it can never catch a dropped connection, and
  a reconnect loop written that way is unreachable code. The listener signals a
  `CompletableDeferred` the supervisor parks on instead. Worth remembering
  because nothing about it fails loudly: the watch simply goes quiet.
