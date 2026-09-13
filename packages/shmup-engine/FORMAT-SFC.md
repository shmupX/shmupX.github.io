# Dezaemon (Super Famicom) save format — reverse-engineering notes

Working notes for the SFC importer (`src/sfc/`), the Super Famicom _Kaite
Tsukutte Asoberu Dezaemon_ (Athena, 1994, cart SHVC-66). Split into
**confirmed** (validated against a real dump and locked by unit tests) and
**open** (needs a second fixture or emulator tracing), with **likely** for a
layout whose stride and shape match the ROM's own label but whose semantics are
unverified. The Saturn sequel's notes are in `FORMAT.md`; the two formats share
nothing but the palette word.

Four reference files:

| File                                      | Where                                  | What it is                                                |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `dezaemon-sfc-sample.sav`                 | `fixtures/` (gitignored)               | 128 KB emulator dump — the factory sample                 |
| `Dez SNES.sav`                            | repo-root `dev-fixtures/debug-tools/`  | the same factory sample, committed                        |
| `ALDI Adventure (2026-08-22).srm`         | the SFC library, `/dezaemonSfc/saves`  | NovaSquirrel's cart — the first dump with a graphics bank |
| `Kaite Tsukutte Asoberu - Dezaemon ….sfc` | repo-root `dev-fixtures/` (gitignored) | the 512 KB ROM (an English-patched build)                 |

The sample dump's first 64 KB is byte-identical to ROM `0x50000-0x5FFFF`, the
image the game copies into fresh SRAM, so it is the built-in sample game as
shipped and has never been edited. Its upper 64 KB is all zero.

`Dez SNES.sav` is that same dump byte for byte (every documented value below
reproduces from it, down to the per-stage map counts). It is a duplicate, not a
second fixture: for the open questions it carries no information the sample did
not, and for the CHECK SUM specifically it is worth exactly zero bits. The real
second dump is ALDI Adventure, which the SFC library publishes. Note also that
it sits inside the one path the repo's `.gitignore` exempts — a directory whose
own comment scopes it to "scripts that read the fixtures, not the fixtures
themselves" — and that its lower 64 KB is a verbatim copy of the commercial ROM.

All multi-byte integers are **little-endian** (the 65C816 is little-endian), the
opposite of the Saturn notes.

## Container (confirmed — `src/sfc/sram.js`)

The cart carries 1024 Kbit = **128 KB** of battery SRAM, which LoROM maps as
four 32 KB segments in banks `$70-$73`. Dumps are the raw bytes: no header, no
interleave, no compression, 131,072 bytes. Some dumpers stop after the second
segment; a 65,536-byte file is accepted and everything but GRAPIC DATA is in it.

The ROM's internal header (ROM `0x7FC0`) declares it: title `DEZAEMON`, map mode
`0x30` (LoROM, FastROM), cart type `0x02` (ROM + SRAM + battery), ROM size code
`0x09` (512 KB), SRAM size code `0x07` (128 KB), checksum valid.

Recognition: size, plus the eight ASCII bytes `T.TABATA` at `0x7FF8` — the
programmer's initials (ROM credits: `TSUTOMU TABATA    94/01/27`), used as the
"this SRAM has been formatted" magic. The boot code also insists on exactly 128
KB of SRAM: it writes `$707E7B` (the MOUSE SPEED word) and reads it back through
the mirror, which is why cartridge copiers with more SRAM fail its
`S-RAM CHECK!` screen.

## The ROM's own map (confirmed — `src/sfc/rom.js`)

At ROM `0x66A5` the game keeps a debug table, `ADDRESS       NAME`, one row per
region. It is reproduced verbatim (spelling included) in `src/sfc/regions.js`,
and `parseRomRegionTable()` reads it back so a test can hold the two equal:

```
00000-0001F   CHECK SUM          08000-08BFF   ENEMY DATA
00020-0003F   RESERVED           08C00-0F7FF   APPEAR DATA
00040-0033F   PALETTE DATA       0F800-0FF7F   ENEMY ODR
00340-0393F   MAP DATA           0FF80-0FFFF   MY SHIP GROUP
03940-0453F   SCROLL EFECT       10000-1FFFF   GRAPIC DATA
04540-04B3F   MAP GROUP
04B40-04B7F   MY SHIP ODR
04B80-04E7F   ENEMY GROUP
04E80-04FFF   BOSS GROUP
05000-0503F   TITLE GROUP
05040-05057   ENDING GROUP
05058-07E57   SOUND DATA
07E58-07E59   TITLE TYPE
07E5A-07E79   CHECK SUM COPY
07E7A-07E7B   MOUSE SPEED
07E7C-07E7D   EDIT BGM
07E7E-07E8D   BGM PATCH
07E8E-07FCD   HIGH SCORE
07FCE-07FD1   KEY CONFIG
07FD2-07FF7   RESERVED
07FF8-07FFF   CHECK STRINGS
```

Ranges are inclusive in the ROM; `regions.js` stores exclusive ends. The 26
regions tile the 128 KB exactly (`sfc-regions.test.js`).

## CHECK SUM (confirmed — traced in the ROM; `src/sfc/sram.js` reads it)

32 bytes at `0x0000`, repeated byte-for-byte at `0x7E5A` (CHECK SUM COPY), read
as sixteen little-endian words. The routine is at ROM `0x47B` (`$00:847B`,
compute) and ROM `0x482` (`$00:8482`, verify); both set a mode flag and fall
into one body at `$00:848A`. Disassembled with
`dev-fixtures/debug-tools/w65c816dis.mjs`.

Each word is

    word = 0xFFFF - Σ segments ( Σ the segment's 16-bit little-endian words )

with every addition truncated to 16 bits. Two details decide it, and both are
visible in the loop:

```
0x4B2  LDY #$0000
0x4B5  LDA #$0000
0x4B8  CLC                          <- inside the loop; the branch lands here
0x4B9  ADC [$2C],Y
0x4BB  INY / INY
0x4BD  DEX
0x4BE  BNE $00:84B8
0x4C0  CLC / ADC $00 / STA $00      ; running total across segments
 …
0x4C8  LDA #$FFFF / SEC / SBC $00   ; one's complement
0x4CE  LDX $A8
0x4D2  STA [$A0]                    ; compute mode ($A8 = 0)
0x4D6  CMP [$A0]                    ; verify mode ($A8 = 1), else $D8 = 1
```

The `CLC` is the branch target, so carry is discarded on every add rather than
propagating — the accumulator is a plain mod-2^16 sum. The tail is
`0xFFFF - total`, which is the one's complement, settling a question the saves
alone could not: word 0's bytes are `52 AD`, and because `0x52 + 0xAD = 0xFF`
byte-swapping and complementing produce identical bytes there, so the dumps were
consistent with either. The ROM complements.

A word is **not** a checksum of one contiguous span. Each is a scatter/gather
over a list of segments, which is why sweeping contiguous ranges across two
dumps found nothing. `$80:8665` (ROM `0x665`) is a table of seventeen pointers;
each descriptor is a 3-byte target pointer followed by
`{3-byte source, 2-byte
length}` segments terminated by `0xFFFF`. SRAM banks
`$70-$73` are linear, so `$71:0000` is offset `0x8000` and `$72:0000` is
`0x10000`.

| Word | At       | Covers                                                                                                                                                               |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `0x00`   | GRAPIC DATA (`0x10000-0x20000`, as two bank-sized segments) + PALETTE DATA (`0x40`, `0x300`)                                                                         |
| 1-6  | `0x02`   | stage _n_: MAP DATA `0x340 + n*0x900` (`0x900`), SCROLL `0x3940 + n*0x200` (`0x200`), MAP GROUP `0x4540 + n*0x100` (`0x100`)                                         |
| 7-C  | `0x0E`   | stage _n_: ENEMY GROUP `0x4B80 + n*0x80`, ENEMY ODR `0xF800 + n*0x140`, BOSS GROUP `0x4E80 + n*0x40`, ENEMY DATA `0x8000 + n*0x200`, APPEAR DATA `0x8C00 + n*0x1200` |
| D    | `0x1A`   | MY SHIP ODR, MY SHIP GROUP, TITLE GROUP, TITLE TYPE, ENDING GROUP, MOUSE SPEED, EDIT BGM, both HIGH SCORE tables, KEY CONFIG                                         |
| E    | `0x1C`   | SOUND DATA (`0x5058`, `0x2E00`) + BGM PATCH (`0x7E7E`, `0x10`)                                                                                                       |
| F    | `0x1E`   | the block's own first fifteen words (`0x0000`, `0x1E`)                                                                                                               |
| —    | `0x7E78` | the copy's first fifteen words (`0x7E5A`, `0x1E`) — descriptor 0x10, the copy's equivalent of word F                                                                 |

Word F explains the totalling property: it is `0xFFFF` minus the sum of words
0-14, so the sixteen words sum to `0xFFFF` in every valid save, by construction
rather than by coincidence. `readChecksumBlocks()` returns the words
little-endian, so that is assertable directly.

Everything in the save is covered except CHECK SUM's own word F, RESERVED
(`0x20-0x40`), RESERVED2 (`0x7FD2-0x7FF8`) and CHECK STRINGS — which is why the
`T.TABATA` magic can be checked independently of the block.

**For a writer:** compute the sixteen words in order, 0 through E, then F last
over the fifteen already written, then copy all 32 bytes to `0x7E5A` and write
the copy's own word at `0x7E78`. Nothing else is needed; there is no CRC, no
seed and no table.

### What the boot check does with it

`$00:8462` wraps the verify entry, taking a descriptor index in A, and the boot
path calls it with `#$0F` then `#$10` — the block's own word, then the copy's.
If the block fails and the copy passes, `$00:82F0` copies the 32 bytes back from
`0x7E5A` over `0x0000`; if both fail the save is rejected. So the block and its
copy are each self-checking, and the copy is a repair source rather than a
second opinion.

### Structure the table settles

The descriptor strides answer four questions the region map left open, because
the ROM is striding the regions it checksums:

- **SCROLL EFECT really is 6 × `0x200`.** `map.js` called that split a
  placeholder; descriptors 1-6 walk it at exactly that stride.
- **MAP GROUP is per-stage**, 6 × `0x100` — 32 quads a stage, not one shared
  table of 192.
- **ENEMY DATA is per-stage**, 6 × `0x200` — four 128-byte records a stage,
  which is the 24 the region holds, but grouped rather than pooled. ENEMY ODR
  strides with it at 6 × `0x140` (20 four-byte quads per record), and ENEMY
  GROUP at 6 × `0x80`.
- **BOSS GROUP is 6 × `0x40`**, one boss of eight quads per stage, which is what
  `groups.js` already assumed.

## PALETTE DATA (confirmed — `src/sfc/cgram.js`)

`0x40-0x33F`: 24 rows of 16 words, a row per 4bpp palette. The word is the same
15-bit layout as the Saturn's (R bits 0-4, G 5-9, B 10-14), stored
little-endian, bit 15 clear — `rgb555ToRgb()` from `decode-cg.js` converts it
unchanged. Colour 0 of a row is transparent.

```
00040  17 00 c0 00 21 0d e1 15 42 22 e3 2e f8 26 49 15   row 0: 0x0017, 0x00c0, 0x0d21 …
00050  8b 29 cd 35 05 2d a8 45 8f 62 14 77 60 00 9f 1d
```

Rows 0-21 are colour words throughout the sample. Rows at `0x100`, `0x120`,
`0x140`, `0x160` and `0x180` are five identical default rows; `0x2A0` starts a
blue-grey ramp, `0x2C0` a red-to-yellow-to-white one. Rows 22-23 (`0x300-0x33F`)
are different: pure red/green/blue ramps and primaries — the editor's own colour
picker by the look of it — and each ends in a word with bit 15 set (`0x87F7`,
`0xB76E`). `decodePaletteData()` reports `colorRowCount` (22 in the sample)
rather than assuming.

## MAP DATA and SCROLL EFECT (likely — `src/sfc/map.js`)

MAP DATA, `0x340-0x393F`, is 0x3600 bytes = **6 stages × 0x900**, one byte per
16×16 chip indexing MAP GROUP. A stage is **18 columns × 128 rows** — a
288-pixel playfield, two chips wider than the 256-pixel screen, 2,048 pixels
tall. The width is measured (`rowContinuity()` in `map.js`): the share of cells
equal to the cell one row down beats every non-multiple width in every sample
stage (0.17-0.40) while 16 scores 0.01-0.20; its multiples 36 and 54 trail as
harmonics, 36 edging 18 by 0.002 in stage 4, and 0x900 / 18 is exactly 128.
Rendering the cells at 16 columns shears the scenery into diagonals; at 18 it
stands upright (`sfc:probe png map`). Columns 0 and 16 hold no non-zero cell in
any stage and columns 8 and 17 are sparse, roughly a third as full as the rest,
so the drawn field is narrower than the stride — per-row markers rather than
scenery, possibly, which is open. Bit 7 is set on some cells (`0x9C` below) and
is not interpreted; the chip index masks to `0x7F`, and no sample cell
exceeds 127.

```
00340  00 9c 1b 1b 1b 1b 1b 1b 00 1b 1b 1b 1b 1b 1b 1b 00 00   stage 0, row 0 (18 cells)
00352  00 01 1d 1d 9c 1b 1c 1d 00 1d 1d 9c 1b 1b 1b 1b 00 00   row 1
```

Sample usage: 1823 / 1794 / 1931 / 1495 / 712 / 698 non-zero cells per stage.

SCROLL EFECT, `0x3940-0x453F`, is **6 × 0x200 by size**, and that split is a
placeholder: the sample opens with 0x100 bytes of small integers, and smooth
curves of bytes around `0x40` (`0x38-0x47`) padded with `0x1F` and `0x1D` recur
every 0x200 from `+0x100` — a per-stage scroll-speed or offset table by the
label; what indexes it is open.

```
03940  18 18 18 00 01 02 19 11 12 13 06 07 1a 11 12 13   +0x000: small integers
03a40  43 43 43 43 43 43 43 43 43 43 43 43 43 43 43 43   +0x100: the first curve
```

## Tilemap words and the GROUP tables (likely — `src/sfc/tilemap.js`, `src/sfc/groups.js`)

Every GROUP region is a table of **quads**: four SNES BG tilemap words (8 bytes)
per 16×16 object. A word is little-endian: bits 0-9 tile, 10-12 palette row, 13
priority, 14 horizontal flip, 15 vertical flip. An unused slot is `0xFFFF` or
`0x03FF` (tile 0x3FF, drawn blank).

| Region        | Quads  | Sample                                          |
| ------------- | ------ | ----------------------------------------------- |
| MAP GROUP     | 192    | free-form picks of tiles 0x2C0-0x373; 119 empty |
| ENEMY GROUP   | 24 × 4 | mostly 0x360-0x3FB, a few from 0x200 and 0x2B8  |
| BOSS GROUP    | 6 × 8  | 16 of 48 mirrored `[n, n+1, n+1\|H, n\|H]`      |
| TITLE GROUP   | 8      | 0x2A0-0x2BF in order, 0x2B8-0x2BA absent        |
| ENDING GROUP  | 3      | all empty                                       |
| MY SHIP GROUP | 16     | 5 of 16 are 2×2 chips `[n, n+1, n+8, n+9]`      |

```
0ff80  00 02 01 02 08 02 09 02 02 02 03 02 0a 02 0b 02   MY SHIP GROUP quads 0-1
04e80  44 02 45 02 45 42 44 42 4c 02 4d 02 4d 42 4c 42   BOSS GROUP boss 0, quads 0-1
04540  ff 03 d8 02 ff ff 5d 03 55 03 ff ff df 02 d7 02   MAP GROUP chips 0-1
```

`classifyQuad()` names the two recurring shapes ("chip", "strip") and "empty";
anything else is `null`. The `[n, n+1, n+8, n+9]` shape suggests the ship's
tiles sit in an 8-tile-wide sheet; the tile numbers are VRAM tile numbers, and
which SRAM bytes they load from is the GRAPIC DATA question below.

The two **ODR** regions are the same idea in 8-bit: four tile numbers per quad.
ENEMY ODR is 24 × 80 bytes = 20 quads per enemy; MY SHIP ODR is 16 quads (zero
in the sample). The repeated quads look like animation frame lists:

```
0f800  12 15 2a 2b 19 1b 1d 5b 19 1b 1d 5b 09 0b 23 25   ENEMY ODR enemy 0, quads 0-3
```

## SOUND DATA (open — `src/sfc/tables.js` slices it)

`0x5058-0x7E57`, 11,776 bytes, entropy 7.45 bits/byte — a bit-packed stream, not
tiles and not a byte-per-step sequencer. The composer holds 16 bars at a 1/16
quantise in 4/4 with two voices and changeable instruments; BGM PATCH (below) is
16 instrument numbers. Nothing here is decoded.

## Configuration words (confirmed — `src/sfc/tables.js`)

| Off    | Size | Field       | Sample                                               |
| ------ | ---- | ----------- | ---------------------------------------------------- |
| 0x7E58 | u16  | TITLE TYPE  | `0x020A`                                             |
| 0x7E7A | u16  | MOUSE SPEED | 0 (SNES Mouse; ROM: "MODIFIED FROM SHVC MOUSE BIOS") |
| 0x7E7C | u16  | EDIT BGM    | 0                                                    |
| 0x7E7E | 16   | BGM PATCH   | `11 12 13 14 15 16 16 17 18 16 19 1a 10 1c 1d 1b`    |
| 0x7FCE | 4    | KEY CONFIG  | `20 08 10 20`                                        |
| 0x7FD2 | 38   | RESERVED    | 20 of 38 bytes `0xFF`                                |
| 0x0020 | 32   | RESERVED    | zero but for `0x3160` at 0x3E                        |

## HIGH SCORE (confirmed — `src/sfc/tables.js`)

`0x7E8E-0x7FCD`: 20 entries of 16 bytes — a u32 score, four bytes not yet
understood (zero in the sample), an 8-character name. Two tables of ten: the
factory ladder 1000, 900 … 100 appears twice, names `........`.

```
07e8e  e8 03 00 00 00 00 00 00 2e 2e 2e 2e 2e 2e 2e 2e   rank 1: 1000 "........"
07f2e  e8 03 00 00 00 00 00 00 2e 2e 2e 2e 2e 2e 2e 2e   rank 11: the second table
```

## ENEMY DATA and APPEAR DATA (likely — `src/sfc/enemy.js`)

ENEMY DATA, `0x8000-0x8BFF`: **24 records × 128 bytes**; the sample fills 23
(record 21 is blank). APPEAR DATA, `0x8C00-0xF7FF`: **6 stages × 0x1200**; every
stage in the sample opens with fourteen zero bytes and fourteen `0xFF`, then
sparse entries. Both are returned as raw views; the fields are for the tracing
below.

```
08000  00 0d 00 80 a1 00 00 00 9d 00 00 00 a0 00 00 00   ENEMY DATA record 0
08c00  00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff ff   APPEAR DATA stage 0
08c10  ff ff ff ff ff ff ff ff ff ff ff ff 00 00 00 00
```

## GRAPIC DATA (open — `src/sfc/graphics.js`, `src/sfc/tiles.js`)

`0x10000-0x1FFFF`, the upper two segments: by size 2,048 SNES 4bpp planar 8×8
tiles (32 bytes each: rows of bitplanes 0+1 interleaved, then rows of bitplanes
2+3, leftmost pixel in bit 7). The sample dump has the whole region zeroed, so
the tile codec is locked by synthetic tests only, and the mapping from a group
word's tile number to an SRAM offset is unknown — 64 KB is more than VRAM holds
at once, so the game must bank it. The ROM's last 128 KB (`0x60000+`) renders as
editor UI icons, not as the sample's bank; where the sample game's art comes
from when it is played is also open.

## Unresolved

- the two flagged palette rows at 0x300;
- the meaning of MAP DATA cell bit 7 (the 18-column width is measured, not yet
  seen rendered through real graphics);
- the SOUND DATA layout (SCROLL EFECT's 6 x 0x200 split is now confirmed by the
  checksum descriptors, but what indexes a curve is still open);
- ENEMY DATA fields, APPEAR DATA records, the ODR frame lists;
- GRAPIC DATA banking and where the sample's graphics live;
- the four bytes after each high score, TITLE TYPE, KEY CONFIG bit meanings.

## Method

The probe writes what a dump holds:
`deno task sfc:probe all <sav> --rom
<sfc> --out build/sfc/<name>/` (region
statistics, palette swatches, stage maps as chip-index colours, scroll curves,
and the graphics bank and group renders when the dump has graphics).
`sfc:probe diff a.sav b.sav` names the regions two dumps differ in.

Closing the open items needs the ROM in a debugging emulator (Mesen 2's SNES
core, or bsnes-plus) with the fixture as its `.srm`:

1. the CHECK SUM is done — disassembled statically rather than traced, with
   `dev-fixtures/debug-tools/w65c816dis.mjs`, and the routine reproduces all
   seventeen words on both known dumps. Static disassembly is worth trying
   before reaching for the emulator on the rest of these;
2. the DMA log (SRAM source → VRAM/CGRAM destination) gives the GRAPIC DATA
   banking, which palette rows reach CGRAM, and which group feeds which layer;
3. reads of SCROLL EFECT while scrolling, and of SOUND DATA during the APU
   upload (`$2140-$2143`), settle those two;
4. controlled deltas — change one thing, save, `sfc:probe diff` — confirm the
   MAP DATA width, the APPEAR record shape and the ENEMY DATA fields.

A second fixture with graphics has arrived: ALDI Adventure, in the SFC library.
It is the diff the GRAPIC DATA, ENEMY DATA and SCROLL EFECT questions start from
— 1,947 of 2,048 tiles used and all 24 enemy records filled, against a sample
whose bank is zero — and it is what proved the CHECK SUM routine, since the
sample alone cannot tell a correct rule from one that merely fits a save whose
graphics bank is empty.
