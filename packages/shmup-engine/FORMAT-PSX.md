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

| Material                   | Where                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Dezaemon Kids! (Japan)`   | `dev-fixtures/*.bin` + `.cue` — `KIDS.EXE`, `GAMES.CMP` (play engine), `KIDS_DAT.BIN` (a 13 MB archive) |
| `Dezaemon Plus Select 100` | `dev-fixtures/*.bin` + `.cue` — `MAIN.EXE`, `UPLOAD/SAMP?.BIN`, `STRDATA.`                              |
| `Dezaemon Kids!/**/*.sav`  | 98 memory-card images, one Kids! game each                                                              |
| `Dezaemon+/**/*.sav`       | 67 memory-card images, one Dezaemon+ game each                                                          |

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
a bigger enemy covers, and the spawner skips them. Their low nibble looks like a
back-pointer to the owning cell, but no offset convention fits: the best of the
six sign and axis orderings, `owner = (row + (n & 3), col - (n >> 2))`, lands on
a present byte for only 60.4 % of them, and the misses point at other
footprints. Carried raw as `mark` until an editor trace settles it.

### CONFIG

0x70 bytes at `0xD140` (RAM `0x8005D140`, pointer `*0x800BC34C`). Named so far:

| Offset       | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| +0x00 bit 0  | horizontal-scrolling game                                                                       |
| +0x03..+0x08 | bit 7 marks the last stage (the stage list ends there)                                          |
| +0x23..+0x63 | sixteen 4-byte entries `[0x7F\|enabled, a, b, 0x20]`, sound-like                                |
| +0x63+stage  | packed byte, read at play init (default 0x22)                                                   |
| +0x99+stage  | bits 0-1 ship speed                                                                             |
| +0x105+stage | `& 0x7F` = background set — a backdrop picture on the disc, not part of the save (see Graphics) |

The rest have readers but no verified label (see "Unresolved"). 0x70 is the gap
to the record base rather than the used size: the highest offset any routine
touches is +0x6E, and the last byte is zero in all 98 saves and all 13 disc
samples.

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
scatter/gather table at MAIN.EXE `0x8005A380`**, entries
`{u32 destRAM, u32 length, u8 flag, u8 kind}`, walked by the save routine
`0x80035CF8` and the load routine `0x80036334`; its lengths sum to exactly
0x1E000. `PLUS_TABLE` in `src/psx/plus.js` is that table.

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
unless every boundary is right. `plusChecksums()` reproduces the stored 0x28
bytes of **all 67 community saves**; a table with the stage stride changed to
0x2240 reproduces **none**. It is also the parser's integrity check: a corrupt
save names the group that failed.

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

The 0x164 global block is eight pieces in file order: TITLE TYPE (2), TITLE
GROUP (0x40), ENDING GROUP (0x18), MY SHIP GROUP (0x9A), MY SHIP ODR (0x4D), a
16-byte stage list (0x8014A740), 3 bytes of game config, and BGM PATCH (0x10) —
the same set of names the Super Famicom cart has.

**SOUND** is 0x2E00 = **16 songs of 0x2E0 bytes**, bit-packed rather than a
byte-per-step sequencer: MAIN.EXE `0x8002E49C` unpacks a song as 16 bars of a
14-bit header and 32 steps of 11 bits (5 + 6), then a 16-bit tail — 734 bytes of
the 736 available.

**HIGH SCORE** is two tables of ten 16-byte entries (u32le score, four bytes, an
8-character name); the factory ladder 1000..100 fills both. **SETTINGS** is
eight bytes gathered from four separate variables (u8, u8, u16, u32).

## Select 100 (confirmed)

The disc read here is _Dezaemon Plus Select 100_ (SLPS-01504), a re-release that
bundles 100 selected user games. Its `STRDATA.` holds **106 headerless save
blocks** (the `SC` frame stripped, the high-score and option tail zeroed)
interleaved with 444 TIM readme pages, indexed by an 88-byte-per-entry table at
MAIN.EXE `0x8009DC7C`. All 106 parse cleanly as Dezaemon+ saves once an `SC`
frame is put back. The save format itself is SLPS-00335's: the file is still
named `BISLPS-00335DEZA`.

---

## Unresolved

- **Kids! CONFIG**: bytes 1, 2, 26, 51-58, the sixteen 4-byte sound-like
  entries, and the packed byte at +0x63+stage have known readers but no verified
  labels. The editor's settings menu is drawn from PELON glyph structures rather
  than stored strings, so a screenshot of that screen (or rendering those
  glyphs) is the cheap way in.
- **Kids! options**: most of the 0x60 bytes, including `+0xB8` bit 1, which is
  set in 96 of 98 saves and in every disc sample but has no reader found.
- **Kids! APPEAR footprint marks** (`0x51`..`0x5F`): they mark cells a bigger
  enemy covers, but the low nibble's meaning is open — the obvious back-pointer
  readings fit at most 60 % of the 105,489 marks (above). The editor routine
  that stamps them, near `0x8008A5AC`, is the place to look.
- **Kids! record fields**: byte 3's bits 4-7 and byte 4 entirely; the boss
  record's three 4-byte sub-records.
- **Dezaemon+ enemy definition**: the 8 bytes' field split beyond the bit groups
  the reader `0x8001B210` makes, and the boss's 32 bytes.
- **Dezaemon+ settings and global config**: which option each of the eight
  settings bytes and the 3 game-config bytes is, and which game mode owns
  high-score table A versus B.
- **Dezaemon+ SPRITE LAYOUT**: the blit geometry is traced but not a single
  byte's meaning; three of its four sub-blocks use interleaved addressing.
- **Dezaemon+ graphics pages**: the page pointers span two 64 KB buffers while a
  save carries one, so whether pages 2-3 are ever reachable from a save is open.
- **Dezaemon+ song fields**: the bar header's 4/2/4/4 bits and the tail's
  3/5/4/4, and the note table `0x8007E4EC`.

## Method

The layouts above came from the two programs: `mipsdis.mjs` over `KIDS.EXE`, its
overlays (`GAMES.bin` at 0x801131A0, `GRAPH.bin`, `PELON.bin` at 0x80176820,
`OVK1..9.bin` at 0x80101CE0) and `MAIN.EXE`, following the save and load
routines out to every reader of every region, then checking each stride and mask
against the whole community collection. Where code and data could disagree they
were made to argue: the Dezaemon+ region table is confirmed by a checksum that
reproduces 67 of 67 saves and 0 of 67 under a perturbed table; the Kids! map
geometry is confirmed by 530,520 chips none of which straddles a CG row, and by
the rendered result.

The probe writes what a save holds:
`deno task psx:probe all <sav> --out build/psx/<name>/` (report, icon, the
graphics bank, palettes, every stage map rendered as the game draws it, and
`report.json`); `psx:probe diff a.sav b.sav` names the regions two saves differ
in, comparing Kids!'s decompressed sections rather than its compressed bytes —
the tool for a controlled delta, which is still the cheapest way to move any of
the open items above.

What a live run would add, none of it needed for the format itself: booting
either game in a debugging emulator (DuckStation, PCSX-Redux, no$psx) and
watching the editor's settings screen would name the option bytes in an
afternoon; dumping VRAM rows 482/483 during play would close the last caveat on
the Kids! palette bank, which rests on the boot loader plus the absence of any
other writer.
