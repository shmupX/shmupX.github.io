# Dezaemon+ and Dezaemon Kids! (PlayStation) save formats — reverse-engineering notes

Working notes for the PlayStation parsers (`src/psx/`): _Dezaemon+_ (Dezaemon
Plus!, Athena, 1996, SLPS-00335 — the port of the Super Famicom Dezaemon) and
_Dezaemon Kids!_ (Athena, 1998, SLPS-01503). The Saturn sequel's notes are in
`FORMAT.md`, the Super Famicom original's in `FORMAT-SFC.md`; these two sit
between them — Dezaemon+ keeps the Super Famicom's data in a new order, Kids!
keeps a Super-Famicom-shaped design but packs it with the Saturn's compressor
and draws it with the Saturn's 16×16 CG cells.

Everything here is traced from the two games' own code, off the discs, and then
checked against the community collection. Split into **confirmed** (the code
says it and the data agrees), **likely** (one of the two) and **open**.

| Material                   | Where                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dezaemon Kids! (Japan)`   | `dev-fixtures/Dezaemon Kids!/*.bin` + `.cue` — `KIDS.EXE`, `GAMES.CMP` (play engine), `KIDS_DAT.BIN` (a 13 MB archive)                                  |
| `Dezaemon Plus (Japan)`    | `dev-fixtures/*.bin` + `.cue` — SLPS-00335, boot `SLPS_003.35`, which loads `DEZA.EXE` at `0x80010000`; also `ALLBGMSE.VH`/`.VB` and `UPLOAD/SAMP?.BIN` |
| `Dezaemon Plus Select 100` | **not in `dev-fixtures`** — SLPS-01504, `MAIN.EXE`, `STRDATA.`                                                                                          |
| `Dezaemon Kids!/**/*.sav`  | 98 memory-card images, one Kids! game each                                                                                                              |
| `Dezaemon+/**/*.sav`       | 67 memory-card images, one Dezaemon+ game each                                                                                                          |

**The Dezaemon+ disc in `dev-fixtures` is SLPS-00335, not Select 100**, and the
difference matters because the two editions are different builds with different
addresses (below). `dev-fixtures/Dezaemon+/playstationdisc.chd` extracts
byte-identical to `dev-fixtures/Dezaemon Plus (Japan).bin` — both 438,589,200
bytes, `cmp` exit 0 — so there is one Dezaemon+ image here in two containers and
**no Select 100 image at all**. `UPLOAD/SAMP?.BIN` is on both editions and so is
here; only `MAIN.EXE` and `STRDATA.` are Select-100-only.

**Nothing in the `MAIN.EXE` column below can be re-checked from anything in
`dev-fixtures`.** Those addresses were read off a Select 100 image obtained
outside the repo, as community disc images always are, and a reader with only
this checkout has to take them on trust or find an image of their own. Treat a
file's name as no evidence of which edition it is: a disc image named _Select
100_ turned up during this work that was byte-identical to the SLPS-00335 image
above. The test is `SYSTEM.CNF` — `BOOT = cdrom:\SLPS_015.04;1` for Select 100,
`SLPS_003.35` for the original.

All of `dev-fixtures/` is gitignored: the discs and the saves are community
content and never ship with the repo. Counts below ("all 98", "all 67") are
those collections. The disassembler is `dev-fixtures/debug-tools/mipsdis.mjs`
(MIPS R3000, the counterpart of the Saturn's `sh2dis.mjs`).

All multi-byte integers are **little-endian**.

## Container (confirmed — `src/psx/memcard.js`)

A PlayStation memory card is 128 KB: 16 blocks of 8 KB. Block 0 is the directory
— frame 0 holds `MC`, frames 1..15 describe blocks 1..15 (status `0x51` first /
`0x52` middle / `0x53` last / `0xA0` free, u32 byte size, u16 next-block link as
a 0-based index or `0xFFFF`, the 20-byte file name), and every directory frame
ends in the XOR of its first 127 bytes. Both games write **one 15-block file of
0x1E000 = 122,880 bytes** taking the whole card:

| Game           | File name              | Blocks |
| -------------- | ---------------------- | ------ |
| Dezaemon+      | `BISLPS-00335DEZA`     | 1..15  |
| Dezaemon Kids! | `BISLPS-01503DEZAKIDS` | 1..15  |

`locateSaves()` also peels a DexDrive `.gme` (3,904-byte header), a single-save
`.mcs` (one directory frame, then the blocks), a PS3 `.psv` (0x84-byte header)
and bare blocks that open with `SC`.

## Save header (confirmed — `src/psx/save-header.js`)

The standard PlayStation title frame: `SC`, icon flag `0x11` (one 16×16 frame),
block count 15, a 64-byte Shift-JIS title at `0x04`, the icon's 16-colour CLUT
at `0x60` (RGB555, bit 15 = STP) and the icon at `0x80` (4bpp, low nibble = left
pixel). Game data starts at `0x100`.

- Kids! writes the user's game name into the title, between 『 』, in fullwidth
  characters padded with U+3000:
  `デザエモンＫｉｄｓ！ユーザーゲームデータ『Ａｉｒ　Ｓｔｏｒｙ　　』`.
  `bracketedName()` / `narrow()` turn that into "Air Story".
- Dezaemon+ writes a fixed title,
  `デザエモン＋（プラス）　ユーザーゲームデータ`, assembled from five pieces of
  a template in the program (table entries 0-4). Its game name exists only as a
  logo drawn in the graphics bank.

---

# Dezaemon Kids!

## Section directory (confirmed — `parseKidsTable`, saver `0x80071884`)

Eleven u32 at file offset `0x100`:

| Word | Value                                              | Air Story  |
| ---- | -------------------------------------------------- | ---------- |
| 0    | end of the last section = word 7 + 0x100           | `0x11D80`  |
| 1    | graphics section, compressed size, exact           | `0xEB7C`   |
| 2    | data section, compressed size, exact               | `0x2F4F`   |
| 3    | graphics section offset — `0x180` in all 98        | `0x180`    |
| 4    | byte sum of the graphics section over word 9 bytes | `0x6BA760` |
| 5    | data section offset = word 3 + word 9              | `0xED00`   |
| 6    | byte sum of the data section over word 10 bytes    | `0x15576C` |
| 7    | tail offset = word 5 + word 10                     | `0x11C80`  |
| 8    | byte sum of the 0x100-byte tail                    | `0x31D8`   |
| 9    | word 1 rounded up to 0x80 (a card sector)          | `0xEB80`   |
| 10   | word 2 rounded up to 0x80                          | `0x2F80`   |

Every arithmetic relation and every checksum holds on all 98 saves; the
checksums are plain 32-bit byte sums, as in Dezaemon 2's payload table, taken
over the **sector-padded** span. The padding is stale staging-buffer content and
is non-zero in 96 of the 98 saves, which is why the sum has to run over the
padded span and not the exact one. Only word 0 (`end`) bytes are written to the
card, so everything past it is whatever the card held before — in 18 of the 98
saves that is the second half of a Dezaemon+ image. The 84 bytes at
`0x12C..0x180`, between the directory and the first section, are stale staging
content too, not a thumbnail.

## Compression (confirmed)

Both sections are **the Saturn Dezaemon 2's Okumura LZSS**, unchanged: flag byte
LSB first (1 = literal), 2-byte match `b1 b2` with offset
`b1 | ((b2 & 0xF0) << 4)` into a zero-filled 4 KB ring written from `0xFEE`,
length `(b2 & 0x0F) + 3`; the stream ends with the input. KIDS.EXE carries both
halves of the codec — encoder at `0x8006C904`, decoder at `0x8006CD10` — and
`src/decompress.js` opens every section of every save to exactly:

| Section  | Decompressed | RAM        | Compressed range over the 98 |
| -------- | -----------: | ---------- | ---------------------------- |
| graphics |      262,144 | 0x80010000 | 45,024 .. 102,894 bytes      |
| data     |       64,712 | 0x80050000 | 5,420 .. 15,306 bytes        |
| tail     |          256 | 0x8005FCC8 | stored raw                   |

The three land in RAM back to back, which is what makes the disc's sample games
(below) drop-in replacements for a save's two sections.

## Graphics (confirmed layout and palette — `kidsCgPages`, `kids-palette.js`)

262,144 bytes = **four Dezaemon 2 CG pages**: 64 KB each, 256 cells of 16×16 at
8 bits per pixel, eight cells to a row (`decode-cg.js decodeCgPage`), 1,024
cells in all.

**The colours are not in the save.** They are `G256PAL.CLT` in the disc's
`KIDS_DAT.BIN`: a 532-byte TIM-style blob (u32 id `0x11`, u32 flags 2, a 20-byte
block header, then 256 RGB555 words, R in bits 0-4, bit 15 = STP). KIDS.EXE's
CLUT loader `0x8006A34C` skips the header and calls `LoadClut2` sixteen times to
lay the 256 words out as **one 256×1 VRAM row**, so the draw code's
`GetClut(0, 482)` / `GetClut(0, 483)` make a CG pixel byte the index straight
into those 256 words — there is no `(row << 4) | colour` indirection as on the
Saturn. Two rows are loaded at boot and differ in exactly one word:

| Row | File           | Index 0  | Used for              |
| --- | -------------- | -------- | --------------------- |
| 482 | `G256PAL.CLT`  | `0xFFFF` | map and background    |
| 483 | `G256PAL2.CLT` | `0x0000` | sprites (transparent) |

`GAMES.bin`, the play overlay, carries a byte-identical copy of `G256PAL2` at
`0x80148420` and derives its fade rows from it. Nothing a save contains reaches
the bank; the only runtime write to those VRAM rows is the editor toggling index
0 between white and black from option byte `+0xB8` bit 0. The bank is embedded
in `src/psx/kids-palette.js`, and rendering a save through it gives the games'
own art (`deno task psx:probe png <sav> cells`). The per-stage **background
set** (config byte 105+stage) is a different thing and does not touch this bank:
`GAME/SIDE1|2/BGY%02d.CMP` and `GAME/LENGTH1|2/BGT%02d.CMP` are complete 8bpp
TIMs — their own 256-word CLUT plus a full-screen picture, 256×224 for a
side-scrolling game and 224×240 for a vertical one — uploaded to VRAM x=896 as a
backdrop behind the user's chips. A save names which one to use and carries none
of it, which is why a stage's colours can differ from this bank without anything
in the save saying so.

`G16PAL.CLT` is the editor's own 4bpp UI bank and renders CG pages as noise.

## Data section (confirmed — `KIDS_REGIONS`)

Offsets inside the decompressed 64,712 bytes, all read off KIDS.EXE's per-stage
initialiser `0x80075E30`, its play-init pointer routine `0x80080958` and
GAMES.bin's readers, then checked on all 98 saves.

```
00000-07DFF   MAP       6 x 0x1500   384 rows x 7 chip words
07E00-0803F   SCROLL    6 x 0x60     192 nibbles, one per 64 px
08040-0D13F   APPEAR    6 x 0xD80    384 rows x 9 slot bytes
0D140-0D1AF   CONFIG    0x70         game-wide settings
0D1B0-0D713   RECORDS   6 x 0xE6     40 x 5-byte enemies + 2 x 15-byte bosses
0D714-0D8C7   SHIP      0x1B4        the ships, their shots, items, title
0D8C8-0FCC7   SPRITES   6 x 0x600    the cells each enemy and boss draws with
```

The three per-stage regions agree on the same stage length: 384 map rows × 32
px, 192 scroll units × 64 px and 384 appear rows × 32 px are all **12,288 px**
(`0x3000`, the wrap GAMES.bin's renderer uses).

### MAP

A stage is 384 rows of **7 chips**, one u16 each — 14 bytes per row. A chip is
**32×32 px**, drawn as the 2×2 group of CG cells `n, n+1, n+8, n+9`:

| Bits  | Meaning                                       |
| ----- | --------------------------------------------- |
| 0-9   | `n`, the top-left cell of the group (0..1023) |
| 10-12 | never read, never set                         |
| 13    | horizontal flip                               |
| 14    | vertical flip                                 |
| 15    | blank — the low bits are then ignored         |

7 chips × 32 px = 224 px of the 256-px screen. GAMES.bin's renderer `0x8011B548`
takes the row as `base + stage*0x1500 + (y >> 4) * 7` and wraps y into [0,
12288); aligning y to multiples of 32 is its caller's doing (`andi a0,a0,0xFFE0`
at `0x8011B440`). Its column strip table `0x80148310` names the four strips
`(0,2) (2,4) (4,6) (6,7)`.

**`n` is always 2×2-aligned.** Across 530,520 non-blank chips in the 98 saves,
bits 0 and 3 of the cell number are never set, so a group starts on an even
column and an even row of its CG page — which is exactly what drawing
`n, n+1, n+8, n+9` requires, and what a flat 16×16 reading would not produce.
The dead-bit set is therefore {0, 3, 10, 11, 12}, and the alignment implies the
weaker facts that a group never straddles a row of eight or runs off the
1,024-cell bank. `0x8080` (the initialiser's fill) and `0x8000` are the two
commonest blank words but not the only ones: fourteen distinct blank words
occur, some carrying flip bits or a stale cell number the renderer discards.

_(An earlier statistical pass read this region as 192 rows of 14 cells of 16×16
px. It fills the same bytes and renders plausibly at a glance, but every feature
comes out doubled side by side: it is two chip rows drawn next to each other.
The chip reading renders as real scenery.)_

### SCROLL

6 × 0x60 bytes: one **nibble per 64 px** of map, low nibble first, 192 nibbles
per stage. The play engine uses `value & 3`, which indexes GAMES.bin's s16 table
`0x80148318` = `[0x0000, 0x0040, 0x0100, 0x0400]` — **0, 0.25, 1 and 4 px per
frame** in 8.8 fixed point for a vertically scrolling game, eased toward from
the previous speed. A horizontal game (config byte 0 bit 0) scales the same
table on another path in `0x80117F78`, so those four figures are the vertical
case only; the ship-speed field indexes the same table, so it is a general speed
table rather than a scroll-specific one. The editor reads the **whole** nibble
(`0x8008BD20` / `0x8008BD74`), using it plus an orientation to pick a scroll
icon. `0x22` is the initialiser's fill; no nibble above 3 occurs in any of the
98 saves.

### APPEAR

6 × **0xD80** — 384 rows of **9 slot bytes**, one per 32 px across and down (9
columns = 224 px plus one cell beyond each edge). The spawner `0x8013A364` reads
`base + stage*0xD80 + (y >> 5) * 9`. A slot byte is
`present (bit 7) | class (bits 4-6) | id (bits 0-3)`:

| Class | Size  | Records | Note                                              |
| ----- | ----- | ------- | ------------------------------------------------- |
| 0     | 32×32 | 16      | ids 0-15 all occur                                |
| 1     | 64×32 | 8       | ids never exceed 7 in any save                    |
| 2     | 32×64 | 8       | "                                                 |
| 3     | 64×64 | 8       | "                                                 |
| 4     | —     | —       | the boss; only the byte `0xC0` itself ever occurs |
| 5     | —     | —       | a footprint mark, present bit **clear**           |

The engine masks the id to four bits for every class, so classes 1-3 could
address a neighbouring class's records; no save does. A stage places at most one
boss (never two in any of the 588 stage blocks). `0xD000..0xD140`, which the
earlier statistical pass called an unused gap, is simply the sixth stage's tail
and is non-zero in 27 of the 98 saves.

The footprint marks (`0x51`..`0x5F`, 105,489 across the collection) sit on cells
a bigger enemy covers, and the spawner skips them. A mark is
`0x50 | (dx << 2) | dy`, the cell's own offset inside the owner's rectangle: the
editor stamps the whole rectangle at `0x8008A3D0` (`ori v0,v0,0x50`, then `sb`)
and the caller overwrites the (0,0) cell with the owner byte, which is why
`0x50` never occurs while `0x51`..`0x5F` all do.

**Which way the offset runs depends on the game's scroll direction**, and that
is what makes the rule look broken if you miss it. The stamp lands at
`anchor + dx - 9*dy` in a vertical game and `anchor + 9*dx + dy` in a horizontal
one — `0x8008A3D0` branches on the config's bit 0 — so inverted, the owner of a
mark at index `i` is `i + 9*dy - dx` or `i - 9*dx - dy`. Honouring the flag
resolves **99.87 %** of the 105,489 marks to a present owner; forcing either
rule on every save gives 60.8 % and 58.4 %. The 0.13 % that do not resolve are
orphans in 24 of the 588 stage blocks, all boss-shaped, left when a boss moved
or was resized: the editor erases the old rectangle using a size it caches in
RAM at `0x800B4094`, which no save carries.

Rectangle sizes come from the editor's table `0x800B2FBC` — 1x1, 2x1, 1x2, 2x2
for classes 0-3 — and for the boss from `0x80063688`, indexed by bits 6-7 of the
boss record. Two routines read the marks back, the editor's cursor pick-up
(`0x80083670`) and the pre-placement overlap clear (`0x8008A110`, which erases
the displaced enemy entirely); the play engine never sees them. A writer has to
regenerate them: without them the editor will not displace an overlapping enemy
and its grid corrupts.

### CONFIG

0x70 bytes at `0xD140` (RAM `0x8005D140`, pointer `*0x800BC34C`), written by two
initialisers — `0x800760E8` for the game and `0x80075E30` per stage — and now
named almost throughout:

| Offset       | Meaning                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0x00 bit 0  | horizontal-scrolling game (SIDE), else vertical (LENGTH)                                                                                                              |
| +0x01        | font: bits 0-2 typeface, 3-5 palette, 6-7 the file FN1..FN4 (also the cell size)                                                                                      |
| +0x02        | sound bank 0..4 (`AUDIO%d0.VH`/`.VB`)                                                                                                                                 |
| +0x03..+0x08 | per stage: bit 7 = the last stage, bit 0 = a chained stage that does not advance the number; bits 5-6 read but unnamed                                                |
| +0x09..+0x0E | two three-byte player-ship records; only byte 2 (masked to 2 bits) has a play-mode reader                                                                             |
| +0x0F, +0x10 | point-item values: `[100, 500, 1000, 0]` and `[5000, 10000, 50000, 0]`                                                                                                |
| +0x11..+0x19 | nine item records, two 2-bit fields each                                                                                                                              |
| +0x1A        | two small fields, both read at play init, meaning open                                                                                                                |
| +0x1B..+0x22 | two four-byte player-shot records: pattern (0..8), a second selector (0..6), a third (0..8), and a speed class (0..2)                                                 |
| +0x23..+0x62 | sixteen 4-byte sound entries (below)                                                                                                                                  |
| +0x63..+0x68 | per stage: bits 0-1 scroll speed into the same `[0, 0.25, 1, 4]` table the SCROLL nibbles use, bit 2 its direction, bits 4-5 a background speed into `[0, 4, 12, 24]` |
| +0x69..+0x6E | per stage: the background set (below)                                                                                                                                 |
| +0x6F        | pad; no routine forms it and it is zero in all 98 saves and 13 disc samples                                                                                           |

A **sound entry** is `[mode|volume, bgm, preset, master]`: bit 7 of byte 0 plays
a preset instead of a file, bits 0-6 are the sequence volume, byte 1 is the BGM
file number 1..99 (`SOUND\G_BGM1..4\BGM%02d.CMP`, banked 1-29 / 30-59 / 60-89 /
90-99), byte 2 the preset number and byte 3 the master volume. Entries 0-3
belong to the game and entries `4+2s` and `5+2s` to stage `s`; everything past
`2 × stageCount + 4` is zeroed when the game loads.

A **background set** is 0 for none, 1..16 for `GAME\{SIDE,LENGTH}1\` and 17..38
for `…2\` at number+34, as `BGY%02d.CMP` (horizontal) or `BGT%02d.CMP`
(vertical). Every one of the 1,422 BGM files and 520 background files the 98
saves name is present in the disc's archive, which is the cross-check that the
banking arithmetic and the SIDE/LENGTH rule are right.

Still unnamed inside the block: the two ship records' first two bytes, `+0x1A`,
and bits 5-6 of the per-stage flag byte.

### RECORDS

6 × 0xE6. Per stage, 40 five-byte enemy records addressed
`(classBase[class] + id) * 5` with `classBase = 0, 16, 24, 32` (GAMES.bin table
`0x8014A274`; the table has a fifth entry, unused, because class 4 is the boss
and short-circuits), then **two 15-byte boss records at +0xC8** — one per boss
part, pairing with the two boss sprite tables below. Some readers form the index
with `OR` and others with `+`, which agree only because an id stays inside its
class's width; none of the 98 saves has one that does not. Fields, from the
spawner `0x801384F4` (**likely** — the tables are traced, the names are read off
what they feed):

| Byte | Bits | Feeds                                                    |
| ---- | ---- | -------------------------------------------------------- |
| 0    | 0-4  | movement pattern (pointer table `0x8014B4E8`)            |
| 0    | 5-6  | movement variant (mod 3)                                 |
| 0    | 7    | spawn gate flag                                          |
| 1    | 0-2  | hit points (tables `0x8014A0D0/E0/F0`)                   |
| 1    | 3-4  | score class (50/100/200, 500/1000/2000, 2000/5000/10000) |
| 2    | 4-5  | shot timing class                                        |
| 2    | 6-7  | fire interval — 30, 10, 2, 0 frames (`0x8014A094`)       |
| 3    | 0-3  | shot pattern (+1)                                        |

A boss record's byte 0 bits 6-7 are its size class: 64×64, 128×64, 64×128,
128×128. Its remaining bytes are three 4-byte sub-records, undecoded.

### SHIP and SPRITES

`0xD714` is a 0x1B4-byte common table of u16 **cell words in the map's
encoding** (bits 0-9 the cell, 13/14 the flips, 15 blank): the two ships' three
poses each (pose 3 is pose 1 h-flipped), their shots, six item icons, 24 blocks
and seven 2×2 quads. `0xD8C8` is 6 × 0x600, one table per stage:

| Offset | Contents                                                       |
| ------ | -------------------------------------------------------------- |
| +0x000 | class 0: 16 entries × 16 cells (an 8×2 block strip = 4 frames) |
| +0x200 | class 1: 8 entries × 16 cells                                  |
| +0x300 | class 2: 8 entries × 16 cells                                  |
| +0x400 | class 3: 8 entries × 16 cells                                  |
| +0x500 | boss part 0: 64 cells (8×8 blocks = 128×128 px)                |
| +0x580 | boss part 1: 64 cells                                          |

Six of those end **exactly** at 0xFCC8: there is no trailer.

## The tail (confirmed)

The 0x100 raw bytes at word 7: ten 16-byte high-score entries, then 0x60 option
bytes. The insert is GAMES.bin `0x80116098`.

```
+00  e8 02 24 00  80 01  00 00  42 43 47 2e 2e 2e 2e 2e   2,360,040  "BCG....."
+10  88 37 22 00  80 01  00 00  41 43 45 2e 2e 2e 2e 2e   2,242,440  "ACE....."
+20  98 7d 17 00  04 02  00 00  47 45 49 4c 2e 2e 2e 2e   1,539,480  "GEIL...."
```

u32 score; byte +4 = the 0-based stage reached, or `0x80` for an all-clear; byte
+5 = the level the run was started on (0..3, and 4 for a test play from inside
the editor); +6 and +7 are always zero; an 8-character ASCII name padded with
`.`. The factory ladder is 1000..100, stage 0, level 1.

Of the 0x60 option bytes, the ones with traced readers are `+0xA0` screen-width
mode, `+0xAE` stereo, `+0xB6` preset BGM, `+0xB7` SE mute, `+0xB8` bit 0 the
backdrop colour (white or black — it is index 0 of the map CLUT), `+0xB9` BGM
file number (`BGM%02d.CMP`), `+0xBA` volume.

## The disc's own games (confirmed)

`KIDS_DAT.BIN` has no directory of its own: KIDS.EXE holds a 38-record table at
`0x800B0B78` of `{char* dirName, u8 count, entryList*}` whose entries are 8
bytes `{char* name, u16 startSector, u16 sizeSectors}`, and the loader
`0x800680BC` reads `(archiveLBA + startSector)` for `sizeSectors << 11` bytes.
The 732 entries' sizes sum to exactly the archive's 6,624 sectors and run
contiguously from sector 0.

Its `\SAMPLE\` directory holds 13 `SGM_*.CMP` sample games. Each decompresses to
**0x4FCC8 bytes = a save's 0x40000 graphics section immediately followed by its
0xFCC8 data section**, with no header, padding or trailer, and without the tail
— the tail is rebuilt from code after a sample load. `SGM_INIT` (the boot image)
is byte-identical to `SGM_MATU` and is a complete game, not a blank. `SGM_RAMS`
is Athena's own "RAMSIE KIDS VERSION" and is _not_ the community Ramsie port,
which shares only 24 of 949 cells with it.

---

# Dezaemon+

Raw — no directory in the file, no compression. The directory is a **74-entry
scatter/gather table**, entries `{u32 destRAM, u32 length, u8 flag, u8 kind}`,
walked by the save routine `0x80035CF8` and the load routine `0x80036334`; its
lengths sum to exactly 0x1E000. `PLUS_TABLE` in `src/psx/plus.js` is that table.
It lives at MAIN.EXE `0x8005A380` and at DEZA.EXE `0x800DE2B8` — see the next
section before you go looking for either.

```
00000-000FF   SC HEADER    5 template pieces
00100-100FF   GRAPHICS     0x10000, two 256x256 4bpp texture pages
10100-103FF   PALETTES     0x300, 24 rows of 16 RGB555 words
10400-1AF2B   STAGES       5 x 0x223C
1AF2C-1B08F   GLOBAL       0x164, eight pieces
1B090-1DE8F   SOUND        0x2E00, 16 songs of 0x2E0
1DE90-1DFCF   HIGH SCORE   2 x 0xA0
1DFD0-1DFD7   SETTINGS     8 bytes from four variables
1DFD8-1DFFF   CHECKSUMS    20 u16, one per flag group
```

## Two editions, two sets of addresses (confirmed)

**Dezaemon+ was read here as two different programs, and their addresses do not
transfer.** The original SLPS-00335 boots `SLPS_003.35`, which loads
**`DEZA.EXE` at `0x80010000`**; the Select 100 re-release SLPS-01504 boots
**`MAIN.EXE`**. They implement the same save format — the file is still named
`BISLPS-00335DEZA` — but they are separate builds, so the same routine sits at a
different address in each:

| Thing                    | `DEZA.EXE` (SLPS-00335) | `MAIN.EXE` (Select 100) |
| ------------------------ | ----------------------- | ----------------------- |
| scatter/gather table     | `0x800DE2B8`            | `0x8005A380`            |
| song unpacker            | `0x80057760`            | `0x8002E49C`            |
| melody sequencer         | `0x80057E70`            | `0x8002EBD4`            |
| instrument permutation   | `0x800F03A8`            | `0x8007E4EC`            |
| instrument map, flag set | `0x800F03E8`            | `0x8007E52C`            |
| instrument map, clear    | `0x800F0408`            | `0x8007E54C`            |
| song note table          | `0x800F03BA`            | `0x8007E4FE`            |
| song tempo table         | `0x800F0484`            | `0x8007E5C8`            |
| `STRDATA.` index table   | —                       | `0x8009DC7C`            |

**In this Dezaemon+ part of the document, an address is a `MAIN.EXE` address
unless it says `DEZA.EXE`.** Everything but the SOUND section below was traced
in `MAIN.EXE`; the SOUND section was traced in `DEZA.EXE` and labels itself
throughout. For `DEZA.EXE`, `gp = 0x8014E140`, set at `0x80013B40` — without
that the `N(gp)` globals the sound code uses do not resolve.

**The sound-table block corresponds by a constant `-0x71EBC`, and the whole
block was checked byte for byte**: the permutation, its inverse (`0x800F03C8` →
`0x8007E50C`), both instrument maps, the note table and the tempo table are
byte-identical between the two builds at that offset —
`0x800F03A8`..`0x800F04C4` against `0x8007E4EC`..`0x8007E608`, 284 bytes, and
the maximal identical run around them is 6,909 bytes. (Not "the note table's 200
bytes": the span from the note base to the end of code 99 is 200 bytes, but only
the 90 belonging to codes 55..99 are ever addressed, and the other 110 are the
permutation tail and the two maps this sentence already lists.) The two ends are
anchored by their cross-references rather than by the offset alone —
`0x8007E4EC` is loaded only from `0x8002E4C8`, inside MAIN.EXE's unpacker,
exactly as `0x800F03A8` is loaded from `0x80057864` inside DEZA.EXE's; and
`0x8007E4FE` is loaded from `0x8002ECB0`, inside MAIN.EXE's melody sequencer
`0x8002EBD4`, exactly as `0x800F03BA` is loaded from `0x80057F5C` inside
DEZA.EXE's `0x80057E70`.

**Earlier notes gave `0x8007E4EC` as the note table. That was wrong** — it is
the instrument permutation. The note base sits `0x12` bytes further on in both
builds, inside the permutation's own 32 bytes, which is how the two got
confused: the note table is a base for `base + code * 2` arithmetic and only
codes 55 and up address anything of its own (below).

## Checksums (confirmed — `plusChecksums`)

The save routine accumulates one u16 per flag group as it gathers:

```
for every byte of the file, in order:
    if (fileOffset & 0x7F) == 0:  cs[flag] += entryIndex
    cs[flag] += byte * (offsetWithinEntry & 0x1F) + entryIndex
    when an entry ends and the next has a different flag (kind != 5):
        cs[flag + 1] = 0
```

and writes the twenty results as the file's last 0x28 bytes. (An entry is 12
bytes with a zero `u16` pad; the live array is 40 halfwords, of which only the
first twenty reach the file. A second, identically shaped table sits right after
the first at `0x8005A6F8` with the same lengths, flags and kinds and different
destinations — it is the disc-load path, and it is why the graphics page
pointers come in two pairs.) The load routine recomputes them and accepts the
file only if groups `0x00..0x12` match; group `0x13` covers the array itself and
is self-referential, so nothing checks it.

**This is what pins the layout.** A group's checksum depends on each byte's
offset _within its table entry_ and on the entry's _index_, so it is wrong
unless every boundary is right. `plusChecksums()` reproduces the **verified**
0x26 bytes — groups `0x00..0x12`, the nineteen words the load routine actually
compares — of **all 67 community saves**; a table with the stage stride changed
to 0x2240 reproduces **none**. (The assertion is that `checksums.bad` is empty,
`psx-fixtures.test.js:239`, and that is the same nineteen-word comparison.) The
twentieth word is **open**, and now measured on real saves as well as synthetic
ones: nothing in the suite compares it, on a block sealed with all twenty it
does not converge (see Editing, below), and across the 24 community saves this
checkout holds, the stored word matches the computed one in **none** of them.
The one finding that would have reopened the question — real saves satisfying
it, which would mean the program writes the array in a second pass — did not
happen. It is also the parser's integrity check: a corrupt save names the group
that failed.

One quirk worth knowing: a byte whose offset within its entry is a multiple of
32 is multiplied by zero, so its _value_ does not reach the sum — one byte in 32
is invisible to the check (`psx-plus.test.js` documents it).

## GRAPHICS and PALETTES (confirmed)

0x10000 bytes at `0x100`, 4bpp with a 128-byte row pitch: a **256 px wide by 512
row** bitmap, which is two PlayStation 256×256 texture pages stacked. The low
nibble of a byte is the left pixel. The four 0x4000 quarters the table splits it
into are checksum groups, not picture boundaries.

`0x10100`: **24 rows** of 16 RGB555 words — the Super Famicom's PALETTE DATA
count — with bit 15 = STP and colour 0 transparent. MAIN.EXE `0x800114D4`
LoadImages them to VRAM `(0, 480+row)` and the draw code picks a row by what it
is drawing: the **map takes the stage's own row**, every enemy class 6+stage,
the boss 12+stage, the player 18, title and ending 19, shots 20, effects 21.

## A stage block (confirmed — 0x223C, `PLUS_STAGE_LAYOUT`)

| Offset  | Size   | Piece         | RAM array  |
| ------- | ------ | ------------- | ---------- |
| +0x0000 | 0x900  | MAP           | 0x80145C88 |
| +0x0900 | 0x200  | SCROLL        | 0x80149288 |
| +0x0B00 | 0x100  | MAP GROUP     | 0x8018C2B0 |
| +0x0C00 | 0x080  | ENEMY GROUP   | 0x801212E0 |
| +0x0C80 | 0x200  | ENEMY DATA    | 0x80115B50 |
| +0x0E80 | 0x140  | SPRITE LAYOUT | 0x8018D668 |
| +0x0FC0 | 0x1200 | APPEAR        | 0x8011A050 |
| +0x21C0 | 0x03C  | STAGE CONFIG  | 0x80120EC0 |
| +0x21FC | 0x040  | BOSS GROUP    | 0x80119828 |

### MAP and MAP GROUP

0x900 = **128 rows of 18 bytes**. A row is eight chip bytes, one byte of
vertical-flip bits for them, eight more chip bytes, and one more flip byte:

```
 0  1  2  3  4  5  6  7   8   9 10 11 12 13 14 15 16  17
[c  c  c  c  c  c  c  c] [v] [c  c  c  c  c  c  c  c] [v]
```

A chip byte's **bit 7 is the horizontal flip** and its low seven bits index MAP
GROUP. In a flip byte **bit 7 is the leftmost of its eight chips** and bit 0 the
rightmost: over 43,520 rows of all 67 saves plus the disc sample, byte 8's bit 7
and byte 17's bit 0 are _never_ set, and those are exactly the bits belonging to
the two columns (row bytes 0 and 16) that never carry a chip. Under the opposite
bit order a fifth of the set bits would fall on empty chips; under this one, 4.7
%.

So a row is 16 chips of 16×16 px = 256 px, of which the first and last are
always empty — 224 px drawn, the same visible width as Kids!. Columns 0 and 16
being empty is inherited from the Super Famicom original, where it was noted but
unexplained (`FORMAT-SFC.md`).

A MAP GROUP word names a 16×16 px tile in the graphics bank:

| Bits | Meaning                                      |
| ---- | -------------------------------------------- |
| 0-2  | tile column, low three bits                  |
| 3-6  | tile row (0..15)                             |
| 7    | tile column bit 3 — the right half of a page |
| 8-9  | texture page (a save carries pages 0 and 1)  |

`deno task psx:probe png <sav> map --stage N` draws a stage through this and it
comes out as the game's own scenery.

### SCROLL, APPEAR, ENEMY DATA, SPRITE LAYOUT, GROUPS

- **SCROLL EFECT** (0x200): 256 steps of 64 px, each naming one of the 32
  four-row map blocks, then 256 effect bytes. 256 × 64 px = 16,384 px of stage
  built by sequencing 32 blocks of the 2,048-px map — the Super Famicom idea.
- **APPEAR** (0x1200): 256 records of 14 bytes (record 1 is the `0xFF` end
  mark), then a 0x400 table mapping each 16 px of scroll to a record — 1,024
  entries × 16 px = 16,384 px, the same stage length the scroll table gives. A
  record byte `0x80|n` in column k spawns at x = 16(k+1) px; the class nibble
  8/9/A/B/C picks 16×16 / 32×16 / 16×32 / 32×32 / 64×64 and definitions `n`,
  `16+n`, `32+n`, `48+(n&7)`, `56+(n&3)`; `D` is the boss.
- **ENEMY DATA** (0x200): 60 definitions of 8 bytes, then a 32-byte boss
  definition at +0x1E0. STAGE CONFIG (0x3C) is one byte per definition.
- **SPRITE LAYOUT** (0x140) is the chip layout of the stage's 256x320 sprite
  sheet, which `0x8001C82C` blits to VRAM (896, 0) in four sub-blocks — `0x80`
  as a plain 16-wide grid, then three `0x40` blocks with interleaved addressing.
  (The Super Famicom's ODR was the first guess for this piece and is wrong.)
  **MAP GROUP**, **ENEMY GROUP** (64 u16) and **BOSS GROUP** (32 u16) are the
  tile tables.

## GLOBAL, SOUND, HIGH SCORE, SETTINGS

The 0x164 global block is eight pieces in file order. Five carry the Super
Famicom cart's own names; two do not, and were misread as the cart's until their
readers were traced:

| Offset  | Size | Piece              | Contents                                                         |
| ------- | ---- | ------------------ | ---------------------------------------------------------------- |
| 0x1AF2C | 2    | TITLE TYPE         | six 2-bit entry-animation selectors, three per byte, values 0..2 |
| 0x1AF2E | 0x40 | TITLE GROUP        | 32 tile words (`w & 0x3FFF` index, 0x4000 h-flip, 0x8000 v-flip) |
| 0x1AF6E | 0x18 | ENDING GROUP       | 12 tile words, drawn only on the user game's ending              |
| 0x1AF86 | 0x9A | MY SHIP GROUP      | 77 tile words; the runtime forces words 61-63 to 0x3FC..0x3FE    |
| 0x1B020 | 0x4D | MY SHIP ODR        | 77 bytes, OR'd over the program's default sheet                  |
| 0x1B06D | 0x10 | **ITEM TABLE**     | seven item slots, _not_ a stage list                             |
| 0x1B07D | 3    | three settings     | _not_ one game-config field                                      |
| 0x1B080 | 0x10 | **BGM ASSIGNMENT** | sixteen song numbers, _not_ the cart's BGM PATCH                 |

The **ITEM TABLE** is a leading unused word then seven `u16` slots: the low byte
is an effect id 1..11 through the handler table `0x8007DC54` (1-6 set weapon
0-5, 7 bomb, 8 score bonus, 9 power up, 10 speed up, 11 option) and the high
byte an enable flag. Slot 0's id also seeds the weapon a new game starts with.
The three bytes after it are unrelated to each other: a SCORE-item bonus index
into `{5000 … 1000000}`, a charge time 0..5 worth `(5-v)*45+40` frames, and the
**stage count minus one**. **BGM ASSIGNMENT** is sixteen song numbers 0..50 —
0-15 this save's own songs, 16-31 a second bank, 32-50 songs inside the program
— for stages 0-5, their bosses, the title, game over, the ending and one song
decoded at session start.

**The stage-count ceiling is 5, not 6** (**likely** — derived from the table's
own RAM bases, not from a traced load). The file carries five stage blocks:
`PLUS_STAGES = 5` (plus.js:58), and 5 × 0x223C = 0xAB2C lands exactly on
`PLUS_GLOBAL_OFFSET`, so there is no sixth block to read. The program's arrays
are six deep, and their own addresses say so: MAP's base
`0x80145C88 + 6 × 0x900 = 0x80149288`, which is SCROLL's base (plus.js:163-164),
and ENEMY GROUP's `0x801212E0 + 6 × 0x80 = 0x801215E0`, which is TITLE GROUP's
(plus.js:166, :177). Neither adjacency comes out right at a depth of 5 or 7. The
palette map is six wide too — enemies `6+stage`, the boss `12+stage` over 24
rows (plus.js:342-361) — and BGM ASSIGNMENT names stage 5 and boss 5. So slot 5
exists in RAM and the file never fills it: a save whose count byte holds 5 asks
for a sixth stage whose data is whatever RAM held before, and it passes every
checksum and every parser check, because `stageCount` is `settings[2] + 1` with
no clamp (plus.js:595). A tool should refuse to write 6. Note that
`psx-fixtures.test.js:256-259` asserts `stageCount >= 1 && stageCount <= 6`,
which points the other way: that is a bound on what the corpus holds, not a
claim about what loads. The corpus has now been searched, and **none** of the 24
Dezaemon+ saves in this checkout holds 6 (`psx-plus-edit.test.js`, the
fixture-gated case, prints the count). That is consistent with the ceiling and
does not prove it: 24 saves by people who never had a sixth stage to fill would
look exactly the same.

**SOUND** is 0x2E00 = **16 songs of 0x2E0 bytes**, bit-packed rather than a
byte-per-step sequencer. BGM ASSIGNMENT's numbers 0-15 name these sixteen. The
whole format is decoded in the next section.

**HIGH SCORE** is two tables of ten 16-byte entries: `u32le` score, the 0-based
stage reached, three always-zero bytes, an 8-character name. A stage equal to
the stage count prints as ALL. Table A (0x1DE90) is the built-in Athena game's
ladder and table B (0x1DF30) the user game's — only B is swapped in and out as
games are loaded, so a tool that rewrites scores should touch B and leave A
alone (likely: the selector is a RAM flag, not a saved byte).

**SETTINGS**, the eight bytes at 0x1DFD0, are per byte rather than the four
variables the table gathers them from: a cursor speed 0..2, a font bank, the
menu BGM track (0-3 = `BGM01..04.SEQ`, higher = off), a mono/stereo flag, and
then **four button bitmasks** for the key configuration — `0x01` circle, `0x02`
cross, `0x04` triangle, `0x08` square, `0x10` L1, `0x20` L2, `0x40` R1, `0x80`
R2, not indices. The factory value is `00 00 00 00 02 01 08 02`.

## SOUND, the song format (confirmed — `src/psx/plus-song.js`)

**Every RAM address in this section is a `DEZA.EXE` (SLPS-00335) address** — the
`MAIN.EXE` build of Select 100 has the same code somewhere else, and the
correspondences that are known are the table above. The few numbers here that
are _not_ RAM are offsets into the 0x1E000 save block and say so.
`gp = 0x8014E140`, set at `0x80013B40`, is what makes the `N(gp)` globals below
resolve.

The save's `0x1B090` holds sixteen songs of 0x2E0 = 736 bytes, **734 of which
carry bits**. A song is one bit stream read **MSB first**, and it unpacks into a
flat 1,092-byte buffer at `0x801F05F4`: 16 bars of 68 bytes, then 4 tail bytes.
Six routines carry the whole format:

| Routine      | What it is                                                           |
| ------------ | -------------------------------------------------------------------- |
| `0x80057650` | the bit reader — MSB first out of a one-byte refilled register       |
| `0x800576CC` | the same loop for the 6-bit note field, with its own tail arithmetic |
| `0x80057760` | the unpacker: bit stream → the 1,092-byte buffer                     |
| `0x80057B04` | the packer, the way back                                             |
| `0x80057E70` | the melody sequencer, called once per step                           |
| `0x80058130` | the accompaniment player, called twice per step                      |

`src/psx/plus-song.js` is those routines transcribed, each export carrying the
address it was read from.

### The bit stream

Per bar, in order: a **4/2/4/4 header** (`0x800577A0`..`0x8005781C`), then 32
cells of **5 + 6** bits. After the sixteenth bar, a **3/5/4/4 tail**
(`0x800578A0`..`0x80057918`). That is 16 × (14 + 32 × 11) + 16 = 5,872 bits =
734 bytes, which is why 736 bytes hold a song with two to spare.

### The 32 cells are two 16-step voices, not 32 steps

The earlier note here read a bar as "32 steps of 11 bits". That is true of the
bits and wrong about the music. The melody sequencer `0x80057E70` addresses a
cell as

```
offset = bar * 68 + 4 + step * 2 + voice * 32     note at +1, instrument at +0
```

— its loop bound at `0x8005801C` is `slti v0,s3,2`, so there are **two voices**
(`0x80058020` is the branch that acts on it); `0x80057ECC` takes the step as
`pos & 0xF`, so each is **16 steps**; and `0x80057EE0` is what puts voice 1
thirty-two bytes further into the bar. The bar stride 68 is `bar * (16 + 1) * 4`
at `0x80057EBC`.

**Of the 5 + 6 split, the 6-bit field is the note and it comes second.** This is
the one thing worth pinning hardest, because reversing the split still produces
plausible-looking output — a stream of small numbers either way — and only the
sequencer's `+1` / `+0` says which is which.

### A cell

The **5-bit field** passes through the permutation at `0x800F03A8` to become the
editor's instrument number, and the packer `0x80057B04` applies the inverse at
`0x800F03C8` on the way back in, so the byte in the unpacked buffer is the
editor's numbering and the raw bits are the driver's:

```
0  1  2  3  4  5  6 16  8  9 10 11 12 13 14 15
7 17 18 19 20 21 22 23 31 24 28 27 25 29 26 30
```

At play time the instrument byte goes through one more map — `0x800F0408` with
the flag at `0x8014E844` clear, `0x800F03E8` with it set, the second being the
inverse permutation again, so with the flag set the driver program is the raw
5-bit field. **Voice 0 plays program `map[i] + 1` (`0x80057FF0`) and voice 1
`map[i] + 91` (`0x80057FDC`)**: two banks, not two channels of one.
(`0x80057FE8` is where the voice-0 path begins, the target of the `bne s3,v0` at
`0x80057FCC`; the `addiu` itself is two instructions later.)

The **6-bit field** becomes a note byte through the tail of reader `0x800576CC`
— `sltiu 62`, then `+7`, then `+55`, so `v + 55` and `v + 62` once `v >= 62`.
Codes 0..61 become 55..116 and the top two become **`0x7C` = 124, key off
(`0x80057EF8`)** and **`0x7D` = 125, tie — do nothing, let the note ring
(`0x80057F18`)**. The extra +7 exists to lift those two control codes clear of
the note range.

**There is no duration field anywhere in the format.** A note rings until the
next note byte, the next key off, or the end of the song; tie steps are what
extend it, and the sequencer extends a note by simply skipping the step.

### The note table

`0x800F03BA`, read as a `u16` at `base + noteByte * 2`. **The high byte is
SsUtKeyOn's `note` argument** and the low byte its `fine`, always zero. What
pins that is the accompaniment path `0x800582E8`, which forms `a1 = note << 8`;
the two libsnd wrappers are `0x800C79F4`, which unpacks two words into
`SsUtKeyOn(vabId, prog, note, fine, volL, volR)`, and `0x800D0864` for the
matching key-off.

**Only codes 55..99 have entries** — the same range the sequencer's gate
`0x80057F20` admits (`note - 55 < 45`) — and the holes inside it are the codes
whose low nibble would be 12..15, which leaves **33 live codes**. The closed
form

```
key = (b >> 4) * 12 + (b & 15) + 12
```

reproduces all 33 non-zero entries exactly: a note byte is a key packed as an
octave nibble and a semitone nibble, and the output runs 55..87. **`key` is a
number in the driver's own key space.** Every absolute key quoted from here on
is in that space; whether it is concert pitch — whether 60 is middle C — is
open, and is the last subsection of this section.

`0x800F03BA` is a base for that arithmetic, not the start of the data — the
entries actually addressed begin at `0x800F0428` (code 55) and end at
`0x800F0481` (code 99). The sound tables run from `0x800F03A8` in one block:
permutation, inverse, the two instrument maps, the note entries, then the tempo
table at `0x800F0484`, which is a check on each of the four 32-entry widths
(`0x800F03A8 + 4 * 0x20 = 0x800F0428`, and `0x800F0484 + 0x20 = 0x800F04A4`, the
volume table). The one seam that is not flush is the note entries' own: they end
at `0x800F0482` exclusive, and `0x800F0482`..`0x800F0483` hold `00 00` — a zero
entry for code 100 — before the tempo table begins.

### Tempo and volume

**TEMPO** is the 32-entry table at `0x800F0484`, indexed by the tail's 5-bit
field:

```
92 82 73 67 61 56 52 49 46 43 41 38 36 35 33 32
31 30 29 28 27 26 25 24 23 22 21 20 19 18 17 16
```

Thirty-two byte entries from `0x800F0484` run exactly up to the volume table at
`0x800F04A4`, which is the check on the width. The value is a **step period in
units of 4 per frame**: `0x80058F20` adds 4 to a counter each frame and
`0x80058FD8` fires a step when it passes the period. A step is a sixteenth — the
one **assumed** link in this chain, since the driver never names a beat, though
16 steps to a bar makes 4/4 overwhelming — so at 60 Hz the tempo is **3600 /
period BPM**, 39 at the slow end and 225 at the fast one. A different
steps-per-beat would rescale every BPM here by the same ratio and change nothing
else. The 3600 is `60 s × 60 fps × 4 ticks-per-frame / 4 steps-per-beat`;
`plusSongSettings` derives it from those constants rather than writing it out.

**VOLUME** is the 8-entry table at `0x800F04A4`, indexed by the tail's 3-bit
field: `[0, 8, 16, 24, 32, 40, 48, 56]`, a level on the driver's 0..127 scale,
which `0x800C73A8` multiplies by 32767/127 into the master-volume command (code
6).

### The tail

The four tail fields, named from `0x800583E4` and the tick at `0x80058F18`
(`0x80058EC0`..`0x80058F14` is a second copy of `0x800583E4`'s store-and-set-
volume block, and it ends `j 0x80059010` — it jumps past the tick, so it is not
the routine to read this off):

| Field | Bits | Meaning                                                                       |
| ----- | ---- | ----------------------------------------------------------------------------- |
| 0     | 3    | volume index into `0x800F04A4`                                                |
| 1     | 5    | tempo index into `0x800F0484`                                                 |
| 2     | 4    | loop bar (`gp+1652`) — the song resumes at step `loopBar * 16`                |
| 3     | 4    | last bar (`gp+912`) — it loops after this bar, so it plays `lastBar + 1` bars |

The compare against `lastBar + 1` is `bne v1,v0,0x80058FCC` at `0x80058FB4`, and
the reset to `loopBar * 16` is `sll v0,v0,4` at `0x80058FC4` followed by
`sw v0,452(gp)`.

### The bar header is a backing pattern

The four header fields are not melody at all: they pick a backing pattern out of
a **92,160-byte ROM at `0x800F4BAC`** and transpose it. The accompaniment player
`0x80058130` is what says so, and the clamps are at `0x800580C4`:

| Field | Bits | Meaning                                                                                                       |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------- |
| 0     | 4    | pattern A, `< 9` (`0x800580CC` — 9 or more reads as 0)                                                        |
| 1     | 2    | pattern B, `< 4` (`0x800580E4`)                                                                               |
| 2     | 4    | pattern C, `< 10` (`0x800580FC`), then `>> 1` (`0x80058198`); the low bit gates an extra track (`0x8005820C`) |
| 3     | 4    | transpose, added to every ROM note (`0x80058270`)                                                             |

```
romOffset = patternA * 10240 + patternB * 2560 + (patternC >> 1) * 512
```

(`0x80058174`..`0x800581A0`). 9 × 10240 is 92,160 exactly, so the three strides
account for the whole ROM: 9 × 4 × 5 patterns of 512 bytes, each pattern 8
tracks × 16 steps × 2 half-steps × (instrument, note).

### The backing tracks are octave-folded

After the transpose, every ROM note is folded through three per-track `u32`
tables (`0x80058278`..`0x800582D8`):

| Table | Address      | Tracks 0..4         |
| ----- | ------------ | ------------------- |
| LO    | `0x800F0504` | 56, 32, 44, 44, 15  |
| MID   | `0x800F0518` | 81, 57, 69, 69, 255 |
| HI    | `0x800F052C` | 92, 68, 80, 80, 255 |

The rule, read off the branches and not tidied:

```
if (note > HI[track])                              note -= 12;
else if (LO[track] < note && note < MID[track])    note -= 12;
otherwise                                          unchanged
```

That is **not** a fold into a register: a note between MID and HI is left alone
while one between LO and MID drops an octave, so the two tests are not two
halves of one range test. Track 4's row is `15 / 255 / 255`, which no note byte
can exceed, so for that track the first test never fires and the second fires
for anything above 15. The tables are five entries long while the pattern shape
above counts eight track slots, and the reason is `slti v0,s3,5` at
`0x80058258`, whose `beq` jumps to `0x800582DC`: past the transpose at
`0x80058270` **and** past the whole fold. **Tracks 5-7 get neither.** Only five
tracks are pitched, so five entries is the whole of it — not three tracks
unaccounted for. The three tables are `u32` and laid end to end — MID starts
`0x14` after LO, which is exactly five words — so the gate is load-bearing
rather than defensive: without it the read for track 5 would walk off LO into
MID and come back with 81. The fold belongs to the backing: it sits inside the
accompaniment player, between its transpose at `0x80058270` and its key-on at
`0x800582E8`, and the melody sequencer's own range (`0x80057E70`..`0x80058130`)
has nothing like it.

### What the corpus says

Two independent checks, neither of them from the code:

- Across **the 1,072 songs in the 67 Dezaemon+ saves** (949 of which carry a
  note at all; no slot is all-zero), the only note bytes that occur are those 33
  table codes plus 124 and 125. Not one table hole, not one value above 99 —
  which is what a decode that had the 5 + 6 split backwards, or the `+55` wrong,
  would not produce. **This is the strongest evidence the layout is right**,
  because it is the one check real data can falsify: a reversed 5 + 6 split, a
  moved note base and a bar header widened to 15 bits each make it fail.
- The disc's `ALLBGMSE.VH` multisamples melody programs **1-34** and **91-124**
  over exactly **keys 55..87**, the table's output range. Those are precisely
  the two program ranges the `+1` / `+91` voice bias lands on over a 0..33
  instrument map, which is the cross-check that the bias names two 34-program
  banks rather than an offset into one.

### Still open: whether the key numbers are concert-absolute

**Whether a Dezaemon+ key number is absolute pitch — whether key 60 really is
middle C — is not settled here.** That depends on the recorded pitch of the VAGs
against each tone's centre note, which has not been measured. What is _not_ in
doubt is the `+12` in the closed form: the table's own high bytes are 55 for
code 55 and 60 for code `0x40`, so the constant is a measurement. The open
question is only whether the driver's key space is concert-absolute.

The key space is at least internally consistent, program by program. The melody
side is the `1-34` / `91-124` check above. On the backing side, the pattern ROM
names driver programs **35-43 and 125** (plus 0, which occurs only in cells
whose note is already key-off or tie), and the accompaniment applies no bias —
the ROM byte goes to `SsUtKeyOn` as the program directly (`0x8005824C` loads it,
`0x800582F8` passes it). Against `ALLBGMSE.VH`, **every one of those ten
programs is multisampled over a key range that contains the notes the ROM
actually plays under it**, untransposed. Three are exact rather than merely
containing: 35 is 4..51 against ROM notes 4..51, 40 is 4..105 against 4..105,
and — sharpest of the three, because it is the narrowest — 125 appears on track
5 only, with notes 100..107, against a VH program of exactly eight tones
spanning exactly 100..107. The other seven are strict containments. A wrong
anchor shifts every note by the same constant; it does not distort anything, and
it changes nothing above. `plusNoteToMidi()` hedges the same way in its comment.

### Reading a save

The sixteen songs start at the save's `0x1B090`, 0x2E0 apart (`decodePlusSongs`,
which takes a 0x1E000 save block, not a whole card), and BGM ASSIGNMENT's
sixteen bytes at the save's `0x1B080` say which plays where. `encodePlusSong()`
is the packer, and re-packing every decode lands on the original bytes for all
1,072 songs in the collection — which says the two are mutual inverses and that
the slot's two slack bytes are always zero. It does _not_ say the bit layout is
right: a round trip is symmetric, so any re-slicing applied to both sides
survives it. The note-byte check above is what the layout rests on.

## ENEMY DATA, field by field (confirmed)

The 8-byte definition, as MAIN.EXE `0x8001B210` splits it. Each field indexes a
table the reader owns, which is what fixes the widths:

| Byte | Bits | Field                                                                               |
| ---- | ---- | ----------------------------------------------------------------------------------- |
| 0    | all  | movement script, 0..159, into the pointer table `0x8007D760`                        |
| 1    | 0-4  | shot pattern, 0..19, into the spawner's function table `0x8007DCA4`                 |
| 1    | 5-7  | fire rate — a random mask and a base, `0x8007B374` / `0x8007B384`                   |
| 2    | 0-1  | shot mode                                                                           |
| 2    | 2    | drops an item on death                                                              |
| 2    | 3-5  | scale rate `{32, 64, 128, 256, 384, 512, 640, 768}` per frame                       |
| 2    | 6, 7 | animate the x and y scale                                                           |
| 3    | 0-2  | hit points `{1, 50, 100, 200, 400, 800, 1000, 2000}`                                |
| 3    | 3-4  | what happens at the scale limit: stop, reverse, restart, despawn                    |
| 3    | 5-7  | hit flags — the hit sound, immunity to shots, and a collision mask                  |
| 4    | 0-2  | score `{50, 100, 200, 500, 1000, 2000, 5000, 10000}`                                |
| 4    | 3-4  | what happens at the end of a turn: stop, sweep back, restart                        |
| 4    | 5-7  | animation interval `{59, 29, 14, 9, 5, 2, 1, 0}` frames                             |
| 5    | 0-6  | a parameter for shot mode 2, split 3 + 4 bits (halves unnamed)                      |
| 5    | 7    | a depth gate that bands shooting, collision and the CLUT by scale                   |
| 6    | 0-1  | rotation: none, one way, the other, or aim at the player                            |
| 6    | 2-4  | end scale, and bits 5-7 the start scale: `{0, 6, 8, 16, 24, 32, 48, 64}`, 16 = 100% |
| 7    | 0-1  | start trigger: immediately, or when y reaches 31 or 70 px                           |
| 7    | 2-4  | start heading `{0, 224, 192, 160, 128, 96, 64, 32}` of 256                          |
| 7    | 5-7  | turn rate `{16, 32, 64, 128, 256, 384, 512, 2048}`                                  |

The stage config byte that goes with a definition is at `stage*60 + index` in
the 0x3C piece, not beside the record.

## Editing (confirmed — `plusChecksums`, `plus-edit.js`)

The twenty u16 at `0x1DFD8` — 0x28 bytes, the file's tail — are the only bytes
in a Dezaemon+ save derived from any other byte. Everything else sits at a fixed
offset and is read as it stands, so editing is surgical by construction: write
the bytes a field owns, reseal, and not one of the other 122,840 bytes has to
move. A **seal** rewrites the nineteen words the load routine verifies — groups
`0x00..0x12`, 0x26 bytes at `0x1DFD8..0x1DFFD` — and leaves the twentieth, at
`0x1DFFE`, exactly as it found it.

**The twentieth word must not be written**, because it is not a fixed point: it
covers the checksum array itself, so writing it changes bytes it is computed
over and the next pass computes something else again. Measured on the synthetic
block (`_psx-synthetic.js:142`): stored 2920, computed 13002; write 13002 and it
computes 13863; write that and 12913; write that and 13329. Four passes, four
values. Nothing reads it — `PLUS_CHECKED_GROUPS = 0x13` (plus.js:79), and the
load routine stops there — so leaving it alone costs nothing and is what keeps a
seal idempotent.

**The seal is corpus-verified.** All 24 Dezaemon+ saves in this checkout reseal
to themselves byte for byte — parse, seal, compare, zero bytes move
(`psx-plus-edit.test.js`, the fixture-gated case at the end, which skips when
the collection is absent). That is what makes "surgical" a measurement rather
than an intention, and it is the case to run before trusting this on a save you
cannot replace. The wider collection these notes cite is 67 saves; a checkout
holding all of them proves correspondingly more.

**A seal is idempotent, and an edit costs N + 2 bytes per checksum group it
dirties.** Sealing a block whose nineteen words already agree changes zero bytes
(measured). One poked byte falls in exactly one group, so the seal rewrites
exactly one 2-byte word and touches nothing else: over all 255 other values a
byte at `0x12345` can take, the only offsets that ever move are `0x12345` and
that group's word at `0x1DFE4`-`0x1DFE5` — both its bytes 223 times, its low
byte alone the other 32.

**The per-group qualifier is not pedantry** — a write that straddles a boundary
costs more, and is the whole reason a seal is never partial. A 16x16 repaint at
pixel row 120 is one 128-byte write that crosses the graphics quarter at
`0x100 + 0x4000` = `0x4100`, so it dirties groups `0x01` and `0x02`
(`plus.js:204`) and seals four bytes, not two — measured, and pinned by
`psx-plus-edit.test.js`, "a repaint that straddles a graphics quarter dirties
two groups, and one seal fixes both".

N + 2 is what the seal _writes_; what _differs_ is N + 1 whenever the word's
high byte already holds the right value, which for the 255 values a byte at
`0x1041` can take happens 184 times against 71.

**Two fields reach an indirect jump.** ENEMY DATA byte 0 is a movement script
0..159 into the pointer table `0x8007D760`, and byte 1's low five bits a shot
pattern 0..19 into the spawner's function table `0x8007DCA4` (both confirmed, in
the table above). Neither is bounded on the way in: `movement: b[0]`
(plus.js:494) takes the whole byte, and `b[1] & 0x1f` (plus.js:495) admits 0..31
against twenty entries. A value past the end fetches a word past the table and
the program calls through it (**likely** — the tables and their lengths are
traced, the out-of-range path is not), so these are the two an editor should
refuse rather than warn about. The item table's effect id is a third index into
a handler table (`0x8007DC54`, above), but the corpus stays inside it:
`psx-fixtures.test.js:262` asserts 0..11 over all 67 saves.

**Checksums cannot confirm an edit landed.** The sum multiplies every byte by
`offsetWithinEntry & 0x1F` (plus.js:244), so a byte whose offset within its
table entry is a multiple of 32 is multiplied by zero and its value never
reaches any group — the quirk above, counted over `PLUS_TABLE`: **3,850 of the
122,880 bytes, 3.13 %**. They are not obscure corners. Measured, poking the
cursor speed (`0x1DFD0`), the font bank (`0x1DFD1`), the menu BGM (`0x1DFD2`),
key mask 0 (`0x1DFD4`), the SCORE bonus (`0x1B07D`) or TITLE TYPE's first byte
(`0x1AF2C`) each leaves `plusChecksums().bad` empty, while `0x1DFD3` and
`0x1DFD5..7` do move group `0x12`. A clean checksum proves the file will load,
not that the write happened; verify an edit by diffing bytes.

**Nothing above the save is derived from it.** A card's only other checksums are
the XOR each directory frame carries over its own first 127 bytes
(`frameChecksum`, memcard.js:71), which never covers a data block, and frame 0's
size and chain link do not change because the file is always 0x1E000 — so an
edited block written back over blocks 1..15 leaves every frame valid. The trap
is on the way out, not in: for a card and a `.gme`, `parseMemoryCard` copies the
chained blocks into a fresh buffer (memcard.js:162-163, :172), so the `data` a
parse hands back is not a view of the image and poking it edits nothing. Write
through `blockBytes(card, block)` instead. Only `.mcs`, `.psv` and a bare block
alias the caller's bytes (memcard.js:209, :218, :222).

## Select 100 (confirmed)

_Dezaemon Plus Select 100_ (SLPS-01504) is a **second, different disc**: a
re-release that bundles 100 selected user games, and the `MAIN.EXE` build every
unlabelled address in this part belongs to. **It is not in `dev-fixtures`** —
the Dezaemon+ image there is SLPS-00335 in two containers (see the material
table at the top), and these notes were read off a Select 100 image obtained
outside the repo, so nothing in this section can be re-checked from this
checkout alone. Its `STRDATA.` holds **106 headerless save blocks** (the `SC`
frame stripped, the high-score and option tail zeroed) interleaved with 444 TIM
readme pages, indexed by an 88-byte-per-entry table at MAIN.EXE `0x8009DC7C`.
All 106 parse cleanly as Dezaemon+ saves once an `SC` frame is put back. The
save format itself is SLPS-00335's: the file is still named `BISLPS-00335DEZA`.

---

## Unresolved

- **Kids! CONFIG, what is left**: the first two bytes of each player-ship
  record, `+0x1A`, and bits 5-6 of the per-stage flag byte. The rest of the
  block is named above. The editor's settings menu is drawn from PELON glyph
  structures rather than stored strings, so a screenshot of that screen (or
  rendering those glyphs) is the cheap way in.
- **Kids! options**: most of the 0x1C bytes, including `+0xB8` bit 1, which is
  set in 96 of 98 saves and in every disc sample but has no reader found.
- **Kids! record fields**: byte 3's bits 4-7 and byte 4 entirely; the boss
  record's three 4-byte sub-records.
- **Dezaemon+ boss definition**: the 32 bytes at `+0x1E0`. The 60 ordinary
  definitions are named above; the boss's are not.
- **Dezaemon+ SPRITE LAYOUT**: the blit geometry is traced but not a single
  byte's meaning; three of its four sub-blocks use interleaved addressing.
- **Dezaemon+ SCROLL effects**: the 256 bytes that follow the 256 block numbers.
  `decodePlusScroll` hands them back as a raw view and names nothing
  (plus.js:565); no reader for them has been traced, so neither their meaning
  nor their range is known.
- **Dezaemon+ STAGE CONFIG**: the 60 bytes at `+0x21C0`. The shape is confirmed
  — one byte per enemy definition, which is how the reader pairs them
  (plus.js:526) — and the meaning is not: nothing says what the byte does to the
  definition it belongs to.
- **Dezaemon+ ENEMY GROUP and BOSS GROUP**: named as tile tables (64 and 32 u16)
  with no traced word encoding. The format carries two incompatible ones — MAP
  GROUP's 10-bit column/row/page, clamped by the reader (`decodePlusGroupWord`,
  plus.js:401-406), and the global groups' `w & 0x3FFF` index with `0x4000` /
  `0x8000` flips — and nothing says which of the two these use.
  `decodePlusGroupWord` is exported and will decode either into
  plausible-looking values, so a wrong guess rescrambles enemy graphics quietly.
- **Dezaemon+ shot mode**: ENEMY DATA byte 2 bits 0-1. The field is read
  (`shotMode: b[2] & 3`, plus.js:497) and its four values are never enumerated,
  although byte 5's parameter is defined relative to mode 2 — so mode 2 shoots
  and the other three are unnamed.
- **Dezaemon+ graphics pages**: which pair of the program's four tile buffers a
  save occupies is edition-dependent, and the reason the two populations differ
  is inferred from the two load paths rather than traced.
- **Dezaemon+ octave anchor**: whether a song's key numbers are concert-absolute
  — whether key 60 is middle C. The song format itself is decoded (SOUND,
  above); what is open is one constant, the pitch the VAGs are actually recorded
  at against each tone's centre note. Getting it wrong transposes a
  reconstruction as a whole and distorts nothing inside it.
- **Dezaemon+ high-score tables**: which of the two the game writes is a RAM
  flag no save carries, so the A/B ownership above rests on which one the
  community saves actually vary (53 of 67 for B against 8 for A).

## The round trip through the games themselves (confirmed)

Both editors have now been closed against the programs that own the format,
under Mednafen 1.32.1 with a Japanese BIOS — the only check that tests our bytes
against something we did not write.

**Dezaemon+ (SLPS-00335), 2026-09-16.** `plus-edit.js` set the stage count to 2
and table-B rank 1 to 9,999,990 "CLAUDE!." on stage 1 of _Devil Blade Complete
Edition_; the card went into slot 1, LOAD/SAVE → ロード read it and printed
ロードOK, and セーブ wrote the loaded state back to the empty card in slot 2.
That second card parses with the same stageCount 2 and the same rank 1, and the
nineteen group checksums verify on both.

**Dezaemon Kids! (SLPS-01503), 2026-09-16.** `kids-edit.js` renamed _Air Story_
to SKY TALE and put 1,234,500 "CLAUDE.." at rank 1; the PERON MENU's ロード read
it (ロードが終わったよ) and セーブ wrote the loaded state back to the card in
slot 2. The two saves agree everywhere the format reaches. The directory is
identical, including the three byte sums (7,055,200 / 1,398,636 / 12,879) and
`end` 0x11D80; both compressed sections are identical byte for byte, and so are
their decompressed forms (262,144 and 64,712 bytes, zero differing); the tail's
ten high-score rows match, ours among them, and so do all 112 option bytes. Only
two things differ: the 14 bytes of the name window — the save screen takes the
title from the card it is overwriting, and slot 2 was empty — and the slack past
`end`, which the format does not define and which carries whatever the editor's
RAM held.

That the game's own compressor reproduces the stream our editor copied verbatim
is the second result: for data it did not change, Athena's encoder is
deterministic and lands on the bytes already in the section.

**A trap in the harness, not in the format.** Mednafen writes a memory-card file
only when it decides the card is dirty, so a save the game reports as finished
can sit in the emulator and never reach the `.mcr`. Trust the file's mtime, not
セーブが終わったよ: in this session two saves onto an occupied slot-1 card never
reached disk, while the save onto the empty slot-2 card was flushed about five
seconds after the game finished writing it.

## Method

The layouts above came from the games' own programs: `mipsdis.mjs` over
`KIDS.EXE`, its overlays (`GAMES.bin` at 0x801131A0, `GRAPH.bin`, `PELON.bin` at
0x80176820, `OVK1..9.bin` at 0x80101CE0), Select 100's `MAIN.EXE` and — for the
song format, and only that — SLPS-00335's `DEZA.EXE`, following the save and
load routines out to every reader of every region, then checking each stride and
mask against the whole community collection. Where code and data could disagree
they were made to argue: the Dezaemon+ region table is confirmed by a checksum
that reproduces 67 of 67 saves and 0 of 67 under a perturbed table; the Kids!
map geometry is confirmed by 530,520 chips none of which straddles a CG row, and
by the rendered result.

The probe writes what a save holds:
`deno task psx:probe all <sav> --out build/psx/<name>/` (report, icon, the
graphics bank, palettes, every stage map rendered as the game draws it, and
`report.json`); `psx:probe diff a.sav b.sav` names the regions two saves differ
in, comparing Kids!'s decompressed sections rather than its compressed bytes —
the tool for a controlled delta, which is still the cheapest way to move any of
the open items above.

What a debugger would still add, none of it needed for the format itself:
booting either game in a debugging emulator (DuckStation, PCSX-Redux, no$psx)
and watching the editor's settings screen would name the option bytes in an
afternoon; dumping VRAM rows 482/483 during play would close the last caveat on
the Kids! palette bank, which rests on the boot loader plus the absence of any
other writer.
