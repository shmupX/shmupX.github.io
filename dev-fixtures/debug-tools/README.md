# debug-tools

Reverse-engineering and comparison tools for Dezaemon 2 (Sega Saturn) save
imports. The saves themselves are copyrighted community content and stay local
(`.gitignore` keeps all of `dev-fixtures/` except this directory) — these
scripts are original and are tracked.

Everything here reads the decoder and runtime out of the **2019-es7 sibling
checkout**. Override the location with `CMG_ES7_ROOT`; note that a machine
holding several checkouts on different branches is the normal case, and picking
the wrong one is the classic silent failure — `serve-runtime.ts` deliberately
prefers the same checkout `scripts/build-2028-ai.ts` bundles from.

## Inspecting a save

| Tool                                  | Answers                                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dump-behavior.mjs <save.sav>`        | What does each enemy record _do_? Fire config, speed, movement mode, change channels, and the scroll rows it is placed on. `--summary` adds fire-mode distribution and the ground turrets; `--enemy N` lists exact row/column placements. |
| `contact-sheet.mjs <save.sav>`        | Which record is that creature? A labeled sprite grid in first-spawn order. `--frames` draws whole animations.                                                                                                                             |
| `dump-sprites.mjs <save.sav>`         | Boss core/part art, and any slice of the zako record bank, as individual PNGs.                                                                                                                                                            |
| `dump-bg.mjs <save.sav>`              | The stage background tilemap, including a crop of the boss chamber.                                                                                                                                                                       |
| `sav-to-mednafen.ts <sav> <out-base>` | Turns an exported `.sav` (`deno task build:sav`) into Mednafen's `<name>.bcr` + `<name>.bkr` so the game loads it from the cartridge in an emulator — the round trip that checks the writer on a real engine. Deno, not node.             |

Read them together: `contact-sheet.mjs` tells you record 22 is the winged
statue, `dump-behavior.mjs` tells you record 22 is ground, max-LIFE, and carries
an untraced special fire pattern.

## Checking the writer against the corpus

One save proves the decoder reads it; the corpus proves the writer does not
quietly drop anything. Both tools are Deno, not node, and both read the local
fixtures — so the numbers are only as complete as the saves on this machine.

```sh
# every 3D model in dev-fixtures: model/part totals, the stale-byte tallies,
# and whether each sec7 re-encodes to the bytes it was decoded from
deno run -A dev-fixtures/debug-tools/model-survey.mjs
#   -> dev-fixtures/.cache/model-survey.json   (the saves that carry models)

# then drive the whole editor path over those saves — mapSaveToGame, the
# export whitelist, buildSaveFromGame — and diff the models that come back
deno run -A dev-fixtures/debug-tools/model-roundtrip.mjs [count]   # default 6
```

`model-survey.mjs` is where the corpus figures quoted in FORMAT.md and the
commit log come from — re-run it rather than carrying a number forward. In its
output `roundBad` is the count that must stay 0: it means a decode → encode →
decode cycle changed the models' _meaning_. `differ` is weaker, counting sec7
blocks that are not byte-identical on re-encode, which a normalising writer can
cause without losing anything.

Read the two together. The survey checks sec7 in isolation, so it stays green
when a model encodes correctly but is lost on the way through the editor's level
record — exactly the defect `model-roundtrip.mjs` catches, and did.

## Reading the engine itself

When record fields and captures disagree, the answer is in the play engine's
SH-2 code:

```sh
# unpack the whole disc once: every ISO 9660 file, every .CMP decompressed
# beside it, and a check that the addresses in FORMAT.md still land
deno run -A dev-fixtures/debug-tools/extract-disc.ts
#   -> dev-fixtures/.cache/saturn-disc/{GAME.CMP,0KERNEL.BIN,SGM_*.CMP,…}
#      dev-fixtures/.cache/saturn-disc/unpacked/{GAME.bin,KUMITATE.bin,…}

# disassemble; PC-relative literal pools are resolved inline
SH2DIS_BIN=dev-fixtures/.cache/saturn-disc/unpacked/GAME.bin \
  node dev-fixtures/debug-tools/sh2dis.mjs 0x0607d810 0x0607d8e0

# who touches a RAM array? (readers, writers, and jsr-via-literal callers)
SH2DIS_BIN=… node dev-fixtures/debug-tools/sh2dis.mjs --xref 0x06090830
```

`extract-cmp.mjs` is still the way to pull ONE file out when you know which;
`extract-disc.ts` is the other half, because most questions turn out to need a
file nobody predicted — an editor overlay for the editor's own labels, a sample
game to hold a save against, a preset song, the part library.

File offset = RAM address − 0x06064000, which is why FORMAT.md writes the play
engine's addresses as `+0x19810` and means RAM `0x0607D810`. Its "Zako firing,
re-traced" section is the worked example: the fire dispatcher at `+0x1989e`, the
bullet-geometry table at `0x6086074` and the spawn-time interval fill at
`+0x1548e` all came out of these two tools. Verify a fresh extraction before
trusting an offset — GAME.bin must be 165,628 bytes and the interval table at
`0x6085f60` must read `00 1d 00 16 00 10 00 0b …` (u16be, values in the low
bytes), or the LZSS phase is off and every address is wrong. `extract-disc.ts`
checks both itself and exits non-zero if either fails.

The disc is also what makes the container provable rather than merely plausible:
its six `SGM_*.CMP` sample games are complete games, and two of them are in the
community save collection as well, so
`packages/shmup-engine/test/disc-sample-games.test.js` holds the two paths equal
byte for byte across all eight sections.

## The PlayStation discs and saves

`dev-fixtures/Dezaemon Kids!/` and `dev-fixtures/Dezaemon+/` hold the
PlayStation collection — memory-card images, one game each — and the two disc
images sit beside them (`Dezaemon Kids! (Japan).bin/.cue`,
`Dezaemon Plus
Select 100 (Japan).bin/.cue`, MODE2/2352). The save parser is
`packages/shmup-engine/src/psx/`, the probe `deno task psx:probe`
(`tools/psx-sav/`), the notes `packages/shmup-engine/FORMAT-PSX.md`. Kids! packs
its save sections and its disc `.CMP` files with the same Okumura LZSS as the
Saturn, so the engine's `decompress.js` (`decompressCmp`) opens them unchanged.

The CPU is a MIPS R3000, so the SH-2 tool above does not apply; its counterpart
is:

```sh
# the executables come straight off the ISO 9660 track (the engine's
# iso9660-read.js handles MODE2/2352): SLPS015.03 boots KIDS.EXE,
# SLPS_015.04 boots MAIN.EXE
MIPSDIS_BIN=dev-fixtures/.cache/psx-disc/kids/KIDS.EXE \
  node dev-fixtures/debug-tools/mipsdis.mjs 0x80064524 0x80064580

# who touches a RAM address? (lui/addiu/lw address synthesis is resolved
# inline, so readers, writers and address-of sites all show up)
MIPSDIS_BIN=... node dev-fixtures/debug-tools/mipsdis.mjs --xref 0x800bc820 0x100

# find a routine by a constant it uses (0xfee = the LZSS ring start)
MIPSDIS_BIN=... node dev-fixtures/debug-tools/mipsdis.mjs --imm 0xfee
```

A file that starts with `PS-X EXE` is opened at its header's load address; a raw
overlay (the decompressed `.CMP` blobs) needs `MIPSDIS_BASE`. The lui tracking
restarts at every function prologue, so an address assembled across a branch is
missed — grep the `lui` half by hand when `--xref` comes up empty.

## Comparing against hardware

```sh
# 1. stills from a capture, at the rate you need
dev-fixtures/debug-tools/extract-frames.sh ramsie.mov ./frames 4

# 2. serve the editor and the runtime SOURCE from one origin
deno run -A dev-fixtures/debug-tools/serve-runtime.ts "dev-fixtures/Dez 2 - Ramsie.sav"
```

Import the save at `/editor/?game=2028-ai` (the URL-import field reaches the
served copy at `/__sav__/save.sav`), press PLAY, and the runtime at
`/es7/phaser-game.html?editorPlay=1&stage=0&god=1` runs from unbundled
`src/phaser/*.js` — edit a scene module, reload, see the change.

Then paste `deterministic-step.js` into the devtools console to drive the game
frame by frame instead of trusting whatever `requestAnimationFrame` delivered:

```js
await dezaStep.attach(); // freezes real time, and PROVES the freeze
dezaStep.toSecond(31); // jump to the same moment as frame 31 of the capture
dezaStep.census(); // scroll, live records, bullets on screen
dezaStep.glueError("W", 600); // 0 = record is pinned to the map, as scenery should be
dezaStep.resume();
```

`attach()` throws rather than returning an unverified result if real time is not
actually frozen — interleaved wall-clock frames make every measurement drift,
and the numbers still look plausible.

## Gotcha worth knowing

A browser keeps one ES module graph per URL, so after editing a scene module a
plain reload re-runs the **stale** module and the change appears to do nothing.
`serve-runtime.ts` sends `cache-control: no-store` for `/es7/` to prevent it;
confirm in the page before trusting a result:

```js
// probe for a string your edit just introduced, e.g.:
String((await import("/es7/src/phaser/dezaemon-runtime.js")).initEnemyBehavior)
  .includes("patrols");
```
