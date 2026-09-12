# @shmupx/shmup-harbor

Where a shmupX level leaves for another machine.

[`@shmupx/shmup-engine`](../shmup-engine) reads and writes the Dezaemon 2
formats. **harbor** takes what comes out of it and makes something that _runs
somewhere else_:

| target                      | task                                                    | what comes out                                          |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **PlayStation 2**           | `deno task build:ps2` (`:zip`, `:iso`)                  | an `athena.elf` USB folder, a `.zip`, a bootable `.iso` |
| **Windows / Linux / macOS** | `deno task build:windows` / `build:linux` / `build:mac` | an `.exe`, an `.AppImage`, a `.app`                     |
| **Android / iOS**           | `deno task build:android` / `build:ios`                 | an `.apk`, an unsigned `.ipa` (or an Xcode project)     |
| **Sega Saturn**             | `deno task build:sav`                                   | the 1,114,112-byte Dezaemon 2 cart save MiSTer reads    |
| **…into your emulator**     | `deno task sav:run` / `sav:inject`                      | that cart merged into the save this machine already has |
| **…and checked**            | `deno task sav:profile`                                 | the same level on the Saturn and in the browser, framed |

The root [README](../../README.md) is the narrative — what each target is for,
every flag, and why the artifacts are shaped the way they are. This file is the
map of the package.

## Layout

- `lib/ps2/` — the PS2 export. `build.ts` orchestrates; `assets.ts` cuts a level
  down to what the Graphics Synthesizer can hold; `atlas.ts`, `palette.ts` and
  `png.ts` repack and quantise the sheets; `adpcm.ts`, `sound-pack.ts` and
  `tone-bank-pack.ts` render the audio; `iso9660.ts` writes the disc;
  `runtime-entry.ts` and `runtime-sound.ts` are the only two files here that
  never run under Deno — they are bundled for QuickJS and run **on the
  console**.
- `lib/export-build.ts` — one level into an installable app, on this machine.
  PS2 runs in-process; everything else spawns `node tools/build-level`.
- `lib/export-worker.ts` — the same build, asked for from somewhere else: the
  BUILD CODE, the queue over the Realtime Database, and the artifact upload.
- `lib/shelf.ts` — turns a name somebody typed into something a build can stage.
- `lib/cart-inject.ts`, `lib/mednafen.ts` — the Saturn cart merge and the
  emulator around it.
- `lib/engine-compare.ts`, `tools/sav-profiler/` — the parity run: the same cart
  played in Mednafen and in the browser at once, recorded side by side.
- `tools/build-level/` — the Node half: Cordova (android/ios) and `deno desktop`
  (linux/windows/mac), with its scaffold. It has its own
  [README](tools/build-level/README.md). Deliberately **not published**: those
  targets need the checkout's base game to stage from, so a copy of the package
  pulled off JSR could not run them anyway, and the Android/iOS scaffolding is
  60-odd files of icons, Kotlin and Swift that no importer would ever reach.
- `scripts/` — the CLI front ends the root's `deno task`s call.

## Importing it

Everything is on a subpath; see `exports` in [`deno.json`](deno.json). The flat
[`mod.ts`](mod.ts) carries the drivers.

```ts
import { buildPs2 } from "@shmupx/shmup-harbor/ps2";
import { resolveShelfName } from "@shmupx/shmup-harbor/shelf";
import { encodePng } from "@shmupx/shmup-harbor/png";
```

The generic codecs live under `lib/ps2/` because that is what they were written
for, but they are ordinary and the rest of the repo borrows them: `./png`,
`./gif`, `./zip`, `./raster`, `./palette`, `./deflate` and `./iso9660` are all
console-free.

## It builds from a checkout

harbor is not standalone the way the engine is, and is not meant to be. An
export stages the base game out of `static/games/2028-ai`, spawns
`tools/build-level` with a real Node, reads the gitignored `dev-fixtures/`, and
writes into `build/`. All of that is the **repo's**, not the package's.

[`lib/repo-root.ts`](lib/repo-root.ts) is where that coupling is named. It finds
the checkout by walking up for the base game rather than counting directories —
which is what makes the same code work in a source tree, inside the Vite-bundled
server, and inside the packaged app's read-only `deno compile` VFS, where the
distances are all different. `$SHMUPX_ROOT` overrides it, and
`tools/build-level/index.js` runs the same search on the Node side so both
halves agree on where `build/<slug>` goes.

`harborRoot()` is the other one: the package's own directory, for the things
harbor ships rather than the things the checkout does.

## Tests

```sh
deno task test          # the whole workspace
deno test -A packages/shmup-harbor
```

Fixture-gated tests skip themselves when `dev-fixtures/` is empty, which it is
in a fresh clone — a `.sav`, a disc image or a `SNDPAC.BIN` dropped in there
lights them up. `tests/` is excluded from the published package.
