# Super Mario SP — what this is made of

The ROM is built from third-party source. This file says whose, under what
terms, and what was changed. `upstream/LICENSE.txt` is kept verbatim and is the
licence that actually governs the engine.

## The engine — snes-platformer-example

<https://github.com/NovaSquirrel/snes-platformer-example>, MIT, © 2022
NovaSquirrel. Vendored at commit `213bb0d6ddb8f8fea26f5c255f6f5a4635f918f6`
(2025-07-08) into `upstream/`, pruned to what the build touches: the two
committed Windows binaries (`audio/tad-compiler.exe`, `tools/lz4.exe`), the
`.aseprite` sources for art we replace, and the `dist`/background rules we never
run are all left out. The MIT licence text ships beside it and inside the eShop
archive.

What we change, all of it via asserted string replacements in `main.ts` rather
than forked files, so a re-vendor fails loudly instead of building the wrong
game:

| File               | Change                                          | Why                                                                        |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `src/snesheader.s` | ROM title → `SUPER MARIO SP`                    | 14 of the 21 bytes the field holds                                         |
| `src/global.inc`   | `PlayerHeight` 28→16 px                         | Mario is 16 px tall; the GrafxKid character this engine shipped with is 28 |
| `src/levelload.s`  | `ScrollXLimit` → 150 blocks                     | the stage is 150 wide, not the demo's 15 screens                           |
| `src/levelload.s`  | `ScrollYLimit` → 0, `VerticalScrollEnabled` → 0 | the stage is one screen tall, pinned to the top                            |
| `makefile`         | `title`, and the audio rules                    | see below                                                                  |

`overlay/` holds the generated art, palettes, blocks and level — everything
`convert/convert.py` writes from the assets below.

## The audio — Terrific Audio Driver

<https://github.com/undisbeliever/terrific-audio-driver> v0.1.1, © Marcus Rowe.
The driver is zlib; the compiler and GUI are MIT. `upstream/audio/driver/*.bin`
are the driver, redistributed as upstream ships them.

`audio-prebuilt/` holds this project's compiled audio — `src/audio_enum.inc`,
`audio/audio_common.bin` and the two song `.bin`s — generated once and
committed, which is why the everyday build needs no Rust. Upstream ships
**Windows binaries only**, and building `tad-compiler` from source means a Rust
toolchain _and_ `wiz`, a C++ SPC700 assembler it invokes from its build script.
Pinned to v0.1.1 because that is the release whose ca65 API `src/tad-audio.s`
is, and a mismatched IO protocol version fails at assemble time.

To regenerate (on a machine with Rust and a C++17 compiler):

```sh
git clone --branch v0.1.1 --recurse-submodules \
  https://github.com/undisbeliever/terrific-audio-driver.git
cd terrific-audio-driver
sed -i '' 's/ -Werror//' wiz/Makefile        # newer clang warns where 2019 clang did not
make -C wiz -j8
cargo build --release --locked -p tad-compiler
```

then run the four commands the upstream makefile's audio rules used to run, and
drop the outputs into `audio-prebuilt/`.

## The art and the level — mario-sp

<https://github.com/easierbycode/mario-sp> at commit
`e473ded40475a66cfa3b121ba41a65ea90fa07b5`, the same author's Phaser game.
`assets/` holds only what `convert/convert.py` reads: `maps/level1.json`,
`tiles/tiles.png`, the Mario, Goomba and Koopa sprites, the collectibles, the
moving platform and the title screen.

**These are Nintendo-derived fan art.** The engine, the converters and the
packaging here are original or MIT; the pixels and the level layout are not, and
they arrive on the same footing they already sit on in mario-sp. Worth knowing
before this is pointed at anywhere public.

The engine's own original art — OpenGameArt's Kenney 16x16 by surt and kenney,
and GrafxKid's "Today Land Retired Characters" — is still in `upstream/` even
though the build replaces it, and is credited here for that reason.

## The emulator

Vendored separately, under `static/games/super-mario-sp/emulatorjs/`, not here.
EmulatorJS is GPL-3.0 and the snes9x core it loads carries Snes9x's own
non-commercial terms. See `VENDOR.md` beside those files.
