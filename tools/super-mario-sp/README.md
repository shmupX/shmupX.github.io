# Super Mario SP — the Super Famicom build

A real 65816 ROM: NovaSquirrel's MIT `snes-platformer-example`, rethemed with
mario-sp's art and carrying mario-sp's level 1, built with ca65/ld65.

```sh
deno task super-mario-sp:rom     # convert, stage, assemble, verify, install the .sfc
deno task super-mario-sp:zip     # pack the game folder into the eShop's archive
deno task super-mario-sp:vendor  # re-fetch the pinned EmulatorJS files
```

The ROM lands in `static/games/super-mario-sp/`, beside the player page and the
vendored emulator that runs it.

## What is here

|                      |                                                           |
| -------------------- | --------------------------------------------------------- |
| `upstream/`          | the pruned vendored engine — pristine, never edited       |
| `overlay/`           | everything `convert/convert.py` generates, staged over it |
| `assets/`            | the mario-sp inputs the converter reads                   |
| `audio-prebuilt/`    | compiled audio, committed so the build needs no Rust      |
| `convert/convert.py` | mario-sp's Phaser assets → the engine's inputs            |
| `main.ts`            | the build: stage, patch, assemble, verify, install        |
| `convert-report.md`  | generated; what the conversion had to round off           |

`NOTICE.md` says who owns what and how to regenerate the audio.

## Requirements

`cc65` (ca65 + ld65), Python 3 with Pillow, `lz4`, and `make`:

```sh
brew install cc65 lz4
python3 -m pip install Pillow
```

Rust is **not** needed — see the audio note in `NOTICE.md`.

## How the level survives the trip

mario-sp draws on an 8×8 grid; this engine's level grid is 16×16 blocks, 256
wide by 32 tall. Level 1 is 300×18 of the former, which is **150×9** of the
latter — so the whole stage fits at 1:1 pixels, with no scaling and no splitting
into rooms, by folding every 2×2 group of source tiles into one block.

The conversion is by _name_, not by tile id: `levelconvert.py` reads each tile's
`Name` property out of `levels/tiles/level.tsx` and resolves it against the
`Block` enum that `makeblocks.py` writes from `tools/blocks.txt`. The converter
emits all three together, so they agree by construction.

The one thing that cannot survive is collision granularity. mario-sp collides on
8×8 and this engine on 16×16, so a 2×2 group that is only partly solid has to
round up. `convert-report.md` lists every cell that did, with its source tiles,
rather than letting it pass silently.

## Nothing is built in the tree

`main.ts` copies `upstream/` + `overlay/` + `audio-prebuilt/` into
`build/super-mario-sp/` and runs make there, skipping macOS's `._name`
AppleDouble sidecars on the way. This checkout lives on an exFAT volume where
macOS writes one beside every file it touches, and the upstream makefile globs
with a bare `$(wildcard tilesets4/*.png)` — which matches them and hands a 4 KB
binary blob to `pilbmp2nes.py` as if it were a PNG. Staging makes the whole
class of failure impossible instead of patching nine globs.
