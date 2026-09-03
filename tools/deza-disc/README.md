# tools/deza-disc

Look inside a Dezaemon 2 disc: list its files, undo their compression, and
render its editor screens as PNGs.

The disc is never committed. Drop an image in `dev-fixtures/` (gitignored — see
the root README's "PlayStation 2" section) and these commands find it. With
nothing there they say so and exit 0, like `deza:tonebank`.

## Run

```
deno task deza:disc ls [--all]
deno task deza:disc get <NAME> --out <path> [--plain|--lzss]
deno task deza:disc png <NAME> --out <path> [--width N] [--bpp 4|8]
                                            [--rows A:B] [--scale N]
                                            [--grey [--raw-palette]]
```

`ls` hides the bulk files (`M_DATA*`, `DEMO_*`, `MDLDT_*`, `BACK*`) unless you
pass `--all`.

## What this adds

Nothing about the disc itself — the engine already had all of it:

- `lib/disc-file.ts` over `packages/shmup-engine/src/cd/iso9660-read.js` finds
  and reads files out of a disc image.
- `packages/shmup-engine/src/decompress.js` undoes the LZSS: `decompressCmp()`
  for a `.CMP` (u32 LE length header, then the stream) and `decompress()` for a
  bare stream.

What was missing was a way to point those at an **arbitrary** file and look at
the result. Every existing caller asks for one thing whose name and shape it
already knows: `SNDPAC.BIN` for the tone bank, `MDLDT_NN.CMP` for the ポリ吉
part library. This tool is the general case, plus the pixel formats below.

## The pixel formats

Established 2026-09-02 by rendering until the screens came out legible, and
cross-checked against what the screens say about themselves (the `SPEED` panel
carries MIN/MAX 1-8, which is the `maxSpeedLevel` nibble at settings `+0x0D`).

| What                                  | Layout                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `*_PIC.BIN` editor screen backgrounds | 8bpp linear, **320 px** wide, no tiling                                                                 |
| `DEZA2SW.CMP` shared label atlas      | 8bpp linear, **64 px** wide (3405 rows)                                                                 |
| `HL_*.BIN` help overlays              | 4bpp linear, **256 px** wide (first panel only — later panels drift, so the file is not one flat image) |

Both layouts are plain scanline order, which is why a wrong `--width` _shears_
the image diagonally instead of scrambling it — a useful signal when probing an
unknown file. Row-to-row autocorrelation over a candidate stride recovers the
width when you have no idea: the true width wins by a wide margin.

Not every `.BIN` is compressed — `SNDPAC.BIN` and `SMP_BGM.BIN` are raw sample
data — and **you cannot tell by inspection**. LZSS run over the sample bank does
not fail; it happily "expands" 506 KB of samples into 1.6 MB of garbage, so
size-grew heuristics are worthless here. A `.CMP` proves itself (its u32 header
is the exact stream length, which `decompressCmp()` checks); for a `.BIN` the
tool decompresses only the names known to be editor art — `*_PIC.BIN`, `HL_*`,
`GFONT.BIN`, `CONP_OPT.BIN` — and otherwise writes the file as stored and says
so. `--lzss` forces it, `--plain` forbids it.

Colour comes from `DEZA2.PAL` — 576 bytes, uncompressed, 288 u16 big-endian
RGB555 entries with no header. An 8bpp pixel is `(palette << 4) | colour`, the
same convention the save's CG pages use (`SECTION_HINTS` in
`packages/shmup-engine/src/decompress.js`), so the pixel value indexes that flat
table directly and the editor comes out in its real greens and blues.

`--grey` skips the palette and spreads whichever indices occur in the requested
region over 0-255 instead. That is often the better choice for _reading_ small
type, since the real palette draws dark text on a bright panel. Adding
`--raw-palette` to it shows the stored index untouched, which is usually
near-black.

## Where the editor screens are

The screens sit at the **top** of their `*_PIC.BIN`; the rest of each file is
character art. `KUMITATE.CMP` is the editor mode that loads all of them.

```
deno task deza:disc png SYS_PIC.BIN  --rows 0:184 --scale 2 --out /tmp/settings.png
deno task deza:disc png EXT2_PIC.BIN --rows 0:224 --scale 2 --out /tmp/shoki-settei.png
deno task deza:disc png EXT1_PIC.BIN --rows 0:192 --scale 2 --out /tmp/fire-blast.png
deno task deza:disc png DEZA2SW.CMP  --width 64 --rows 195:355 --scale 5 --out /tmp/labels.png
```

| File           | Screen                                                                                      | UI rows       |
| -------------- | ------------------------------------------------------------------------------------------- | ------------- |
| `SYS_PIC.BIN`  | game settings: `PLAYER` (1P ONLY / 1P & 2P), `SCROLL`, `STAGE 1`-`10`, `EDIT START`, `FONT` | 0-183         |
| `EXT2_PIC.BIN` | 初期設定 — the player ship, tabs `SPEED` / `ARMS` / `ANIM`                                  | 0-223         |
| `EXT1_PIC.BIN` | the ship's shot and explosion graphics: `FIRE 1`-`3`, `BLAST 1`-`2`                         | 0-191         |
| `MYCH_PIC.BIN` | the ship's sprite slots (six, paged)                                                        | 0-191         |
| `ZAKK_PIC.BIN` | enemy editor: `MOVE`, `FIRE`, `LIFE`, `SCORE`, `ANIM`, `SFX`                                | 0-199         |
| `BOSK_PIC.BIN` | boss editor: `MOVE`, `FIRE 1`-`3`, `ANIM`, `SPEED`                                          | 0-215         |
| `CONP_OPT.BIN` | `SYSTEM OPTION`: BGM, SE, SPEAKER, KABEGAMI                                                 | 0-223         |
| `MESS_PIC.BIN` | the confirmation dialogs                                                                    | 0-47, 104-247 |

The `ARMS` panel is **not** among them — it is drawn at runtime by `KUMITATE`
from `DEZA2SW` labels, which is why the loadout fields have no baked artwork.

## The label atlas

`DEZA2SW.CMP` is where the editor's words live, as a 64 px strip of label cells,
each in a normal and a highlighted variant side by side. It holds `SPEED` /
`ARMS` / `ANIM`, the four loadout presets `TYPE A`-`TYPE D`, and the weapon
names the `ARMS` panel offers:

> OFF, VULCAN A, VULCAN B, SHADOW, WAVE, MISSILE, HOMING, BOUND, G·MISSILE,
> RF·LASER, H·MISSILE, S·MISSILE, OPTION A, OPTION B, OPTION C, BIG, RED, GREEN,
> BLUE, WIPE, EDIT A, EDIT B, LASER, CANNON, FIRE

That is 24 names after `OFF`, and the loadout's four fields take 7 + 7 + 3 + 7
non-zero values — so the atlas holds four contiguous groups, one per field. Note
that `MAIN` and `SUB` appear nowhere in it: those are our decoder's words
(`decode-settings.js`), not the editor's.
