# sav-profiler — one .sav, Mednafen and shmupX side by side

```sh
deno task sav:profile "dev-fixtures/Dez 2 - Ramsie.sav" --from 44 --for 5
```

plays a Dezaemon 2 save on the Saturn (Mednafen, the user's own disc image) and
in the shmupX runtime (a real Chrome) **at the same moment**, records the window
you ask for from both, and writes the frames out as pairs so the two can be
compared by eye and by number.

## What a run does

1. **Decodes the .sav headlessly** into the level record the runtime plays —
   `levelRecordFromCart` in `lib/shelf.ts`, the same code the PS2 and desktop
   builds use. A small server serves `static/` and answers the runtime's one
   level fetch, `/games/2028-ai/foo.json`, with that record. The level editor is
   not involved.
2. **Builds a profile** under `build/profiler/<level>-<sha>/`: a cartridge with
   the level alone in slot 1 (`lib/cart-inject.ts`, into an otherwise empty
   cart), a Mednafen override config, snapshots, states. The user's
   `~/.mednafen` — cart, states, `mednafen.cfg` — is never written.
3. **Arms the Saturn once per level.** The first run boots the disc and walks
   Dezaemon 2's pointer menus (OPTION → LOAD → cartridge → slot 1 → ALL → OK →
   はい → OK → RETURN → 組立 → EDIT START → TEST), switches MUTEKI on with the
   value's ► arrow, parks the pointer on START and saves a state there: the TEST
   PLAY panel, where one A press starts the stage about two seconds later with
   the ship invincible — the Saturn's `?god=1`. About two minutes; the snapshots
   taken along the way are kept in `prep/`, and every click is checked against
   the screen it should produce. Every later run loads that state a few seconds
   after launch.
4. **Arms the runtime** on its title screen (the Dezaemon logo entrance has to
   finish before a press counts), and with `--live` a second browser on the
   deployed site the same way.
5. **Presses Start on both at once** — that is `t = 0`. Mednafen records its own
   video from launch (`-qtrecord`); Chrome's screencast captures the canvas over
   the window; the game scene is sampled every 50 ms for every enemy's position,
   scale and alpha.
6. **Cuts and compares.** The Start press is found in the Saturn video as the
   end of the still run that matches the armed panel (nothing wall-clock, so an
   emulator that fell behind still lines up); the window is extracted from both
   at `--fps`; `sheet.png` stacks the pairs, `moment.png` is the strongest zoom
   sighting at 2x, `compare.mp4` the pairs as one clip, `report.md` /
   `report.json` carry the numbers (each zoomed enemy with how far its shadow
   travelled), `samples.json` every sample.

## Flags

| flag                       | default                                                     |                                                                      |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `--from N`                 | 44                                                          | seconds after Start where the window begins                          |
| `--for N`                  | 5                                                           | window length                                                        |
| `--fps N`                  | 10                                                          | frames per second cut from both recordings                           |
| `--slot N`                 | first game save                                             | which slot of a multi-save cart                                      |
| `--out DIR`                | `build/profiler`                                            | where profiles and runs go                                           |
| `--disc PATH`              | `DEZAEMON_DISC`, then `dev-fixtures/Dezaemon 2 (Japan).cue` | the disc image                                                       |
| `--bin PATH`               | `MEDNAFEN_BIN`, then `mednafen` on PATH                     |                                                                      |
| `--chrome PATH`            | `CHROME_BIN`, then /Applications                            |                                                                      |
| `--prepare`                |                                                             | build the profile and the armed state, do not run                    |
| `--reset`                  |                                                             | throw the armed state away and rebuild it                            |
| `--no-god`                 |                                                             | run the web side without `?god=1` (the Saturn ship is always mortal) |
| `--keep-video`             |                                                             | keep `saturn.mov` (about 1 MB/s)                                     |
| `--no-saturn` / `--no-web` |                                                             | one side only                                                        |
| `--live`                   |                                                             | also drive the DEPLOYED site as a third pane                         |
| `--live-url URL`           | `https://codemonkey.games/games/2028-ai`                    | the page `--live` drives                                             |

## The deployed site as a third pane

`--live` adds a third browser on the real
**https://codemonkey.games/games/2028-ai**, armed and started in the same
`Promise.all` as the other two, so a run shows the Saturn, this checkout, and
what players actually get. It is what catches a deploy that is behind the
checkout, or a bundle that only misbehaves when Deploy serves it.

The pane is only worth looking at if it is playing the SAME level, and the
deployed origin will not serve a level this tool built. So the level is answered
inside the browser instead: the deployed bundle fetches one fixed same-origin
URL for it (`LEVEL_DATA_URL = "/games/2028-ai/foo.json"`, which you can read in
the served `game.bundle.js`), and `interceptLevel()` in `lib/web.ts` fulfils
exactly that request over CDP's `Fetch` domain with the cart's record.
Everything else — the bundle, the atlases, the fonts — comes from Deploy
untouched, which is the whole point. Chrome is therefore launched on
`about:blank` and navigated only once the interception is armed, since the
bundle asks for its level as it boots. `report.md` says whether the injection
actually landed; if it did not, the pane is prod's own level and is **not**
comparable.

Things to know before using it:

- **`--live --no-god` against codemonkey.games is refused**, before anything is
  read or booted. `?god=1` is the only thing keeping a run off the production
  leaderboard — mortal, the deployed bundle counts the score as a record and
  stamps the profiled cart's name on the board for the injected level's id.
  Point `--live-url` at a staging host to run mortal.
- **It is slow to arm.** Deploy serves everything `no-store` and Chrome runs
  with a 1-byte disk cache, so the live pane re-fetches ~127 loader items and
  the multi-MB record every run: measured at 11–13 s for the local shell against
  still-not-ready at 61 s for the live origin. The live pane gets a four-minute
  arming timeout of its own, and both browsers are re-checked on the idle title
  immediately before Start — the Dezaemon title loops every ~23 s and a press
  during its 2.1 s entrance only snaps the logos.
- **A live pane that will not arm is dropped, not fatal.** The run continues as
  Saturn vs this checkout, and `report.md` says why the pane is missing.
- It needs the network, so it is off by default and the in-page `?debug=1` path
  never turns it on.
- It is a third browser on a machine already running an emulator under a
  closed-loop driver — `saturn.ts` re-fronts Mednafen every 2.5 s and the run
  already fails loudly when the emulator falls behind the wall clock, so expect
  `--live` to make that likelier on a busy machine.
- The live pane's own enemy samples are kept, in `samples.json` under
  `liveSamples`, so a deploy that is behind the checkout can be diffed rather
  than eyeballed.

With `--live` the contact sheet's cells and `compare.mp4` become three panes
(Saturn | this checkout | deployed, 1116x480) instead of two (860x480); without
it every output is exactly what it was.

## Needs

macOS. Mednafen (`brew install mednafen`) with the Saturn BIOS (`sega_101.bin`)
in `~/.mednafen/firmware`; the disc image; Chrome; `ffmpeg` and `ffprobe`;
`swiftc` (Xcode command line tools) to build the key helper once; and the
**Accessibility** grant for the terminal, because Mednafen only takes keys
through its window and the helper has to bring it to the front and post real key
events (`CGEventPostToPid`). Expect the Mednafen window to take focus for the
length of the run.

## Reading the result

`t = 0` is the Start press. The Saturn starts the level as its title fades; the
runtime used to play 2028.Ai's ROUND / FIGHT card first, which put every
imported cart 2.5 s behind — that card is now skipped for imported levels, and
`report.md` says when the runtime's `gameStarted` flag rose. The Saturn video is
10560×480 with the true shape in its sample aspect ratio; frames are squeezed to
604×480 on extraction.

The sampling behind the enemy table is the runtime's own state (`scene.enemies`,
`scaleX/Y`, `alpha`, and each enemy's shadow sprite), so "×1.50, shadow 52 px"
is what the runtime drew, not an estimate off a frame.

Driving Dezaemon 2's menus has a few rules worth knowing before touching
`lib/saturn.ts`: the pointer accelerates (a 35 ms tap moves it nothing, 100 ms
about 13 px), so moves are closed-loop against a template match; a value widget
takes A only from its arrow glyphs, and only when Mednafen was not re-fronted
within a few frames of the press (`keys.ts` activates only when needed); and a
key helper that releases twice breaks those widgets entirely.

## From a page

With `?debug=1` the game page (`static/phaser-plugins/engine-compare.js`) can
run the same comparison for the level it is playing — through
`POST /api/engine-compare` on the machine serving the page, or on a desktop
paired with `?builder=CODE` through the export queue (job kind
`engine-compare`). `lib/engine-compare.ts` wraps `profile()` for both.

## Test

`tests/sav_profiler_e2e_test.ts` runs a full profile and asserts on it. It is
gated on `SAV_PROFILER_E2E=1` (and on the save named by `SAV_PROFILER_SAV`)
because it needs the display, the disc, the emulator and the browser.
