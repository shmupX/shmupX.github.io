# Dezaemon (Super Famicom) save format — reverse-engineering notes

Working notes for the SFC importer (`src/sfc/`), the Super Famicom _Kaite
Tsukutte Asoberu Dezaemon_ (Athena, 1994, cart SHVC-66). Split into
**confirmed** (validated against a real dump and locked by unit tests) and
**open** (needs a second fixture or emulator tracing), with **likely** for a
layout whose stride and shape match the ROM's own label but whose semantics are
unverified. The Saturn sequel's notes are in `FORMAT.md`; the two formats share
nothing but the palette word.

Four reference files:

| File                                      | Where                                                                                                      | What it is                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dezaemon-sfc-sample.sav`                 | `fixtures/` (gitignored)                                                                                   | 128 KB emulator dump — the factory sample                                                      |
| `Dez SNES.sav`                            | repo-root `dev-fixtures/debug-tools/`                                                                      | the same factory sample, committed                                                             |
| `ALDI Adventure (2026-08-22).srm`         | the SFC library, `/dezaemonSfc/saves`; a copy in `dev-fixtures/SNES Dezaemon - Kaite Tsukutte Asoberu/`    | NovaSquirrel's cart — the first dump with a graphics bank                                      |
| `Kaite Tsukutte Asoberu - Dezaemon ….sfc` | repo-root `dev-fixtures/` (gitignored), also as `SNES Dezaemon - Kaite Tsukutte Asoberu/Dezaemon (EN).sfc` | the 512 KB ROM (an English-patched build; the USB stick's `+ROMS/Super Nintendo (SNES)/` copy) |

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
seed and no table. `src/sfc/checksum.js` is that table transcribed
(`SFC_CHECKSUM_DESCRIPTORS`), with `sealSfcChecksums()` doing exactly the above
and `verifySfcChecksums()` recomputing all seventeen words;
`test/sfc-checksum.test.js` holds the transcription to both dumps, and
`parseSfcSav` reports the verification beside the copy comparison.

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

## MAP DATA and SCROLL EFECT (confirmed — `src/sfc/map.js`; traced 2026-10-14)

MAP DATA, `0x340-0x393F`, is **6 stages × 0x900**: 128 rows of 18 bytes, row 0
the stage start, row 127 its end (the stage loader `$00:9B9C`, ROM `0x1B9C`,
builds a 16×128 tilemap of 16×16 BG words from it; both dumps render as upright
scenery through it). A row is two 9-byte halves, each eight cells and a flag
byte:

```
[cell0 .. cell7][flags] [cell8 .. cell15][flags]
cell:  bit 7 = horizontal flip, bits 0-6 = MAP GROUP slot (0-127)
flags: bit 7 = vertical flip of cell 0, bit 6 of cell 1 … bit 0 of cell 7
```

So the playfield is **16 chips = 256 px wide** and 2,048 px tall. The earlier
"18 columns" reading counted the two flag bytes as cells, and the "empty columns
0 and 16" were those bytes; `rowContinuity()` is gone with it. A cell's slot
names a word of the stage's MAP GROUP (below); slot 0 is the blank chip by the
editor's convention (its clear writes word 0 = `0x03FF`).

```
00340  00 9c 1b 1b 1b 1b 1b 1b 00 | 1b 1b 1b 1b 1b 1b 1b 00 00   stage 0, row 0: cells, flags, cells, flags
```

SCROLL EFECT, `0x3940-0x453F`, is 6 × 0x200: **two 256-byte tables**, one entry
per 64 px of the stage. `+0x000` is the **map-row-block sequencer** (confirmed):
the tilemap streamer `$00:D851-D8C9` fetches block `A[(scroll >> 6) + 4]` and
uploads map rows `A[i]*4 .. +3`, so entry i says which 4-row block of the
128-row map (0..31) is shown while the scroll runs through its 64 px. The clear
routine fills it with `i & 0x1F`, which plays the map in order and repeats it
every 2,048 px over the stage's 1,024 lines (16,384 px); the sample's
`18 18 18 00 01 02 19 11 12 13 …` is a re-sequenced one. `+0x100` (cleared to
`0x42`) has **no reader in the play engine**: every access to its WRAM copy
`$7E:7100` is the editor's, and the frame loop advances the scroll clock by
exactly `INC $1584` = 1 px/frame (`$04:FAE5`). Whether it is dead data or
consumed by a path not found is open; `0x42` is what every save holds. The
scroll never stops per band: while a boss lives it loops inside the current
1,024-px window (`$19DB`, `$05:B746`).

## Chip words and the GROUP tables (confirmed — `src/sfc/chips.js`, `src/sfc/groups.js`)

A GROUP word is **not a VRAM tile number**: it is a chip coordinate. The chip
assembler `$80:AC5D` (ROM `0x2C5D`) turns each word into a SOURCE address
through a five-entry sheet table at `$00:AEB9` and copies that 16×16 chip (four
8×8 4bpp tiles) into the SLOT the word occupies in its table; the slot, not the
word, decides the VRAM tile (`$80:AE36`: slot i → tile
`(i >> 3) * 32 + (i & 7) * 2`).

```
0x2e89  LDA $01 ; AND #$0007 ; ASL ; ASL ; TAX          ; word bits 8-10: the sheet
0x2e93  LDA $AEB9,X ; STA $28 ; LDA $AEBB,X ; STA $2A   ; {address, bank}
0x2e9d  LDA $00 ; AND #$0007 ; XBA ; LSR ; LSR ; ADC $28   ; + (w & 7) * 0x40     column
0x2eaa  LDA $00 ; AND #$00F8 ; XBA ; LSR ;       ADC $28   ; + ((w >> 3) & 0x1F) * 0x400   row
```

| Sheet (bits 8-10) | Source                      | What                |
| ----------------- | --------------------------- | ------------------- |
| 0                 | `$72:0000` = SRAM `0x10000` | GRAPIC DATA, half 1 |
| 1                 | `$73:0000` = SRAM `0x18000` | GRAPIC DATA, half 2 |
| 2                 | `$88:8000` = ROM `0x40000`  | the factory art     |
| 3                 | `$89:8000` = ROM `0x48000`  | the factory art     |
| 4                 | `$8C:8000` = ROM `0x60000`  | the editor's icons  |

A sheet is 32 KB laid out 16 tiles (128 px) wide: 32 chip rows of 8 chips, a
chip row `0x400` bytes, a chip `0x40` bytes with its tiles at `+0` (top-left),
`+0x20` (top-right), `+0x200` (bottom-left), `+0x220` (bottom-right). Bits 14
and 15 of the word are horizontal and vertical flips; bits 11-13 are masked off
on save. `0xFFFF` is the empty word, which the assembler draws as the ROM's
blank chip at `$89:FDC0` — sheet 3, row 31, column 7, the word `0x03FF` the
tables also use as empty. That is why the factory sample only names words
`0x200-0x3FF` (its art is the ROM's, read at play time, which is why its own
graphics bank is zero and it still draws) and a user cart names `0x000-0x1FF`; a
writer's chip index 0..511 into the two user sheets IS its word.

The stage assembly (`$04:F979` for TEST PLAY, `$05:AFD0` for the game) runs four
passes, each into the WRAM sheet at `$7E:2000` then to VRAM:

| Pass | Table (words)            | VRAM            | As the PPU sees it              |
| ---- | ------------------------ | --------------- | ------------------------------- |
| 1    | MAP GROUP, stage n, 128  | `0x4000-0x7FFF` | BG tiles `0x200` + slot formula |
| 2    | MY SHIP GROUP, 64        | `0x8000-0x9FFF` | OBJ names `0x000-0x0FF`         |
| 3    | BOSS GROUP, stage n, 32  | `0x0400-0x13FF` | BG tiles `0x020-0x09F`          |
| 4    | ENEMY GROUP, stage n, 64 | `0xA000-0xBFFF` | OBJ names `0x100-0x1FF`         |

PPU setup for play (`$80:BCC3`): OBSEL `$62` (OBJ base `0x8000`, sizes 16/32),
BGMODE `$39` (mode 1, 16×16 tiles). So a MAP GROUP word is one 16×16 BG tile,
the boss is a BG object and enemies and the ship are sprites.

| Region        | Words   | Shape                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| MAP GROUP     | 6 × 128 | the chips a stage's map cells name; cleared to `0xFF` with word 0 = `0x03FF`                                 |
| ENEMY GROUP   | 6 × 64  | the stage's enemy sprite sheet, 8×8 chips; cleared to `0xFFFF`                                               |
| BOSS GROUP    | 6 × 32  | the boss as an 8×4-chip BG sheet (128×64 px), drawn whole on BG1; cleared to `0x03FF`                        |
| TITLE GROUP   | 32      | the title picture, 8×4 chips on screen as two 4-wide halves: slots 0-15 the left, 16-31 the right, each 4 rows row-major |
| ENDING GROUP  | 12      | the ending screen's chips; `0x03FF` when unused                                                              |
| MY SHIP GROUP | 64      | the ship sheet: poses, shots, enemy bullets, weapons, items, explosions; slots 61-63 forced to `0x3FC-0x3FE` |

```
0ff80  00 02 01 02 08 02 09 02 02 02 03 02 0a 02 0b 02   MY SHIP GROUP slots 0-7: sheet 2 rows 0-1
04e80  44 02 45 02 45 42 44 42 4c 02 4d 02 4d 42 4c 42   BOSS GROUP boss 0: mirrored halves (bit 14)
04540  ff 03 d8 02 ff ff 5d 03 55 03 ff ff df 02 d7 02   MAP GROUP slots 0-7: blank, chips, empties
```

The two **ODR** regions reference the assembled sheets by slot. A byte is
`[V:1][H:1][row:3][col:3]`, slot = row × 8 + col, the flips applied on top of
the chip's own. ENEMY ODR is 320 bytes a stage (6 × `0x140`), laid out by class:
`0x00-0x3F` class 0 (16 entries × 4 chips: four 16×16 frames), `0x40-0x7F` class
1 (two frames of two chips, 32×16), `0x80-0xBF` class 2 (16×32), `0xC0-0xFF`
class 3 (8 entries × 8: two frames of four chips, 32×32), `0x100-0x13F` class 4
(4 entries × 16: one 64×64 frame); the object builder `$80:A3EC-A573` reads them
so, with the frame count 3/1/1/1/0 and chips per frame 1/2/2/4/16. MY SHIP ODR
is 64 bytes, 56 used, bits 6-7 the flips of the ship sheet's chips 0-55
(`$00:9D8B`), zero in both dumps.

```
0f800  12 15 2a 2b 19 1b 1d 5b 19 1b 1d 5b 09 0b 23 25   ENEMY ODR stage 0: class 0 entries 0-3, four frames each
0f8c0  17 57 08 48 58 18 66 26                           class 3 entry 0: frame 0 [TL TR BL BR], frame 1 (0x40 = H)
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

## ENEMY DATA and APPEAR DATA (confirmed layout and fields — `src/sfc/enemy.js`; traced 2026-10-14)

ENEMY DATA, `0x8000-0x8BFF`, is **6 stages × 0x200** (the stage loader
`$00:A14D` copies one stage's 0x200 to `$7E:F9EE`), not 24 × 128. Inside a
stage, five classes of eight-byte entries at the bases of the editor's table
`$04:E6C8`, then a 32-byte boss block:

| Offset        | Class | Entries | Sprite | ENEMY ODR                       |
| ------------- | ----- | ------- | ------ | ------------------------------- |
| `0x000-0x07F` | 0     | 16      | 16×16  | `0x00 + e*4`: four frames of 1  |
| `0x080-0x0FF` | 1     | 16      | 32×16  | `0x40 + e*4`: two frames of 2   |
| `0x100-0x17F` | 2     | 16      | 16×32  | `0x80 + e*4`: two frames of 2   |
| `0x180-0x1BF` | 3     | 8       | 32×32  | `0xC0 + e*8`: two frames of 4   |
| `0x1C0-0x1DF` | 4     | 4       | 64×64  | `0x100 + e*16`: one frame of 16 |
| `0x1E0-0x1FF` | —     | —       | —      | the boss block                  |

An entry is one placeable enemy variant; an APPEAR byte names it by (class,
entry). Its fields, as the object builder `$00:A713-A88C` consumes them:

| Byte | Bits | Field                                                                                                                                                        |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | 3-7  | **movement family** 0-19 (object type `$80:ABE9[family]`; 0-16 scripted paths `$82:A5F5`, 17 homing, 18 level-and-dash, 19 wait-and-dash)                    |
| 0    | 0-2  | **variant**: for families 0-16 one of 8 scripts, mostly the same path at speeds 1, 2, 3, 4, 5, 6, 9, 12 px/frame; for 17-19 the speed `$82:A508` = {1.5 … 8} |
| 1    | 0-4  | shot aim/pattern parameter (+2C, 0-31; the shot routine `$02:82AD`'s mapping is open; 0 on every non-firing sample entry)                                    |
| 1    | 5-7  | shot rate `$80:ABB9` = {31, 31, 15, 15, 7, 3, 1, 0} frames between shots (a mask), shot speed `$80:ABC9` = {20, 18, 14, 10, 8, 4, 2, 1}                      |
| 2    | 0-1  | shot type 0-2 (3 reads as 0); type 2 stores byte 5 as its parameter                                                                                          |
| 2    | 2    | **item drop** on death (`$02:9CEF`): the item's kind cycles through the ROM sequence `$82:EB7D`                                                              |
| 3    | 0-2  | **hit points** `$80:AB8F` = {1, 50, 100, 200, 400, 800, 1000, 2000}                                                                                          |
| 3    | 5-7  | flags: bits 0-1 clear = the enemy must be gone before the stage can end (`$02:9CC8`); bit 2 (byte 3 bit 7) = lowest OAM priority, drawn behind               |
| 4    | 0-2  | **score** `$80:AB5F` = {50, 100, 200, 500, 1000, 2000, 5000, 10000}                                                                                          |
| 4    | 5-7  | animation interval `$80:AB57` = {59, 29, 14, 9, 5, 2, 1, 0} frames a frame                                                                                   |
| 5    | 0-7  | shot type 2's parameter                                                                                                                                      |
| 6-7  |      | never read                                                                                                                                                   |

Contact damage is per class (`$80:AB9F` = {1, 5, 5, 12, 24}). The families,
decoded from the script table (a step is
`[duration][angle][angle delta]
[speed 9.7, bit 15 = ride the ground][next]`,
angle `0xC000` = down):

| Family | Behaviour                           | Family | Behaviour                                       |
| ------ | ----------------------------------- | ------ | ----------------------------------------------- |
| 0      | stationary on the ground (turrets)  | 10     | square patrol                                   |
| 1      | straight down                       | 11     | down with lateral weaving turns                 |
| 2      | down, pause, down                   | 12     | up/down bobbing                                 |
| 3      | down, slow, curve back up and leave | 13     | down, slow, retreat up, down forever            |
| 4-5    | U-turn (two timings)                | 14     | stepwise: down, stop, sideways, stop            |
| 6      | arc, exit sideways                  | 15     | down, then long sweeps                          |
| 7      | zig-zag, then sideways              | 16     | down, stop, exit up-right                       |
| 8      | down, long turn, up                 | 17     | homing (turns toward the player)                |
| 9      | ground vehicle, scroll-relative     | 18-19  | level with the player and dash; wait, aim, dash |

The sample's stage-0 popcorn `52 00 00 00 a0 00` is family 10 variant 2, no
shots, 1 hit point, 50 points, animated every 5 frames; a straight-down popcorn
at 3 px/frame is `0A 00 00 00 00 00`. An object spawned at x ≥ 128 px is
mirrored (its horizontal velocity negated), so paths are authored for the left
half.

**The boss block** (`+0x1E0`, `$00:A917-AAD0`): bytes 0-2 the animation frame
count, timer and reload; 3-5 per phase the shot aim (bits 0-4) and rate (5-7); 6
the three phases' shot types (bits 0-1, 2-3, 4-5) and the body layout (bit 6: 0
= wide, the 128×64 sheet as a 96×48 box, script `$82:85AC`; 1 = tall, 48×96,
`$82:85C0`); 7-12 three per-phase pairs the phase logic `$02:A337` consumes
(likely phase length and burst); 13 the **hit points** `$80:ABA9` = {24, 2000,
4000, 8000, 12000, 16000, 18000, 24000} (bits 0-2) and a priority bit (6); 14
the score index (bits 0-2); 15-17 per phase a type-2 shot parameter; 18-31
unused. The boss uses the fixed object slot 63, spawns at x 128 with its whole
32-chip sheet on BG1 (palettes 6 and 5), descends on a built-in script and
parks; its phases cycle on a timer (16-47 frames), not on hit points. Its death
sets `$19CF` → STAGE CLEAR.

APPEAR DATA, `0x8C00-0xF7FF`, is 6 stages × 0x1200: **256 records of 14 bytes**
(table A, `0xE00`) then **1,024 bytes** (table B). B is indexed by the stage
**line** — the scroll clock `$1584` counts pixels and the spawner `$05:8E73`
fires on each change of `$1584 >> 4`, so a line is 16 px, one map row, line 0
the stage start, and a stage is 1,024 lines long with the 128-row map sequenced
over it (SCROLL EFECT above). `B[line]` is the index of the A record that fires
there, 0 for none; the editor de-duplicates identical records, so a record is a
reusable spawn line. A record is one spawn byte per playfield column 1..14 (the
16-chip map's edge columns never spawn):

```
[bit 7 valid][bits 6-4 class][bits 3-0 entry]
```

The loader masks the entry by class (`$00:99C8`: 0-2 keep 0-15, 3 keeps 0-7, 4
keeps 0-3). **Class 5 (`0xD0`) spawns the boss** (`$05:8F26`). The spawn centre
is x = column × 16 + half the sprite's width, y = −(half its height + 32) px —
just above the screen. Record 0 is the empty record and record 1 the END code
(fourteen `0xFF` the loader forces); `$00:98B2` writes an END line one row past
the last non-zero line at game start itself, so a save never stores one, and
marks the line eight rows before each `0xD0` for the boss warning. The stage
ends on the END line once no boss and no must-be-destroyed enemy is alive.

```
08c00  00 00 00 00 00 00 00 00 00 00 00 00 00 00 | ff ff … ff   records 0 and 1
09a00  …  B[2] = 66: record 66 = c9: class 3 entry 0  (the sample's first spawn, line 2 = 32 px)
```

## GRAPIC DATA (confirmed — `src/sfc/chips.js`, `src/sfc/graphics.js`, `src/sfc/tiles.js`)

`0x10000-0x1FFFF`, the upper two segments: the save's two chip sheets (sheets 0
and 1 of the chip-word table above), each 32 KB of 4bpp planar 8×8 tiles (32
bytes: rows of bitplanes 0+1 interleaved, then rows of 2+3, leftmost pixel in
bit 7) laid out 16 tiles wide, so that a chip word's row and column land on
`0x10000 + sheet × 0x8000 + row × 0x400 + col × 0x40`. The factory sample draws
from the ROM's sheets 2 and 3 instead (`0x40000-0x4FFFF`, the same layout),
which is where its art lives and why its own bank is zero; the data source flag
`$19CE` (`$00:AECD`) makes every loader read the ROM's default image when the
sample plays. ALDI Adventure uses 1,947 of the 2,048 tiles and shares none with
the factory art.

## Palette rows (confirmed — `src/sfc/cgram.js`)

The per-stage sample copy `$03:C790` moves rows n, 6+n and 12+n for stage n, the
global copy `$03:C731` rows 18-21: rows **0-5 the stages' scenery, 6-11 their
enemies, 12-17 their bosses, 18 the ship, 19 the title and ending, 20 items and
weapons, 21 free**, and 22-23 the editor's own colour picker (the bit-15 words),
never copied to CGRAM. At play the map draws through BG palette 7, the boss
through BG palettes 6 and 5, enemies through OBJ palette 4; the CGRAM slots of
the ship, item and title rows were not located (write the rows the sample uses
and the game is right by construction).

## Boot, format and the save's defaults (confirmed — `$00:82BB-83C5`, `$00:8551`)

Boot: a ROM mirror check, then CHECK SUM word F (or, failing that, the copy's
own word, with the block restored from the copy), then `T.TABATA` — four of its
eight bytes matching keeps the save, with word F simply recomputed — and only
then words 0..E, whose mismatch shows a "CHECK SUM" message and waits for a
button; the save still loads. The SRAM-size probe's scratch byte is written into
MOUSE SPEED's high byte and word D recomputed at every boot. Format copies ROM
`0x50000-0x5FFFF` over the first 64 KB, zeroes GRAPIC DATA, writes `T.TABATA`
and seals. Nothing reads RESERVED. The editor's clear images: MAP all zero,
SCROLL its defaults, MAP GROUP `0xFF` with word 0 = `0x03FF`, ENEMY GROUP
`0xFFFF`, ENEMY ODR / ENEMY DATA / APPEAR zero (plus the forced END record),
BOSS / TITLE / ENDING / SHIP groups `0x03FF`, SOUND the ROM block `$80:8E46` in
all 16 slots, BGM PATCH zero, KEY CONFIG `20 08 10 20`, both HIGH SCORE tables
from ROM `0x8DA6`. A HIGH SCORE entry's byte 4 is the stage reached (6 = all
clear, `$05:CF85`); entries 0-9 are the sample game's table, 10-19 the user
game's. BGM PATCH slots are 0-5 stage n's song, 6-11 its boss song, 12 the
title, 13-15 ending / clear / game over, each `& 0x3F`; 0-15 pick the save's
SOUND DATA songs (16 × `0x2E0`), 0x10 and up the ROM's built-in ones, which is
all the sample uses. The game always has six stages; an empty stage ends at its
first line.

## Writing a save (`src/sfc/sfc-write.js`, `src/sfc/sfc-format.js`, `src/sfc/checksum.js`)

`exportLevelToSfcSram(level, art)` builds an image from nothing — the editor's
level record and its RGBA frames in, the 128 KB `.srm` out — the way
`src/write/game-to-save.js` builds a Saturn cart; `deno task build:sfc` runs it
from a shell and the editor's CONSOLE › SFC rows in the page. It starts from
`formatSfcSram()`: the magic, the RESERVED bytes, the configuration words, both
factory hi-score ladders, the picker rows, the cleared tables, the APPEAR
headers and — because the note format is open and the sample's songs play — the
factory sample's SOUND DATA and BGM PATCH (the ROM's songs), all embedded in
`factory-data.js` by `tools/sfc-sav/factory-data.ts`. Over that:

- **Art** is quantised into 15-colour rows — row n for stage n's scenery, 6+n
  its enemies, 12+n its boss, 18 the ship, 19 the title — written with a
  sprite's first colour in word 0, since the console lands a row one colour up
  (pixel index k draws word k − 1; "Running a save" below) — and cut into
  16×16 chips of the two user sheets, one copy per distinct chip with mirrors
  shared through the flip bits (`SfcChipBank`); a chip's word is its index.
- **Scenery**: the level's 16×16 cell grid, one chip a cell, the first 128 rows
  centred in the 16-column playfield; a stage's distinct chips take MAP GROUP
  slots 1..127 and the cells' own flips ride the cell bits. The scroll tables
  stay the defaults (the map in order, 1 px/frame).
- **An enemy** takes an entry of the class its art fits (16×16, 32×16, 16×32,
  32×32, 64×64, falling to the next shape that holds it when a class is full),
  one entry per drop digit since the drop is a bit: family 1 (straight down) at
  the variant nearest its speed, hit points the nearest table value to hits × 25
  (the plain shot's damage is untraced; 1 hit = 1), score and animation interval
  nearest the tables, the sample's aim value 13 with the rate nearest its
  interval when it fires, no flags. Its frames go into the stage's 64-slot enemy
  sheet (slot 0 blank) and ENEMY ODR names them per the class layout.
- **Waves**: each grid row is a 14-byte record on its line — the level's wave
  row, else lines 2, 6, 10 …; columns spread over 1..14 — de-duplicated into
  records 2..255. **The boss** paints its first frame into the 8×4 sheet, wears
  the sample's stage-0 block with the hit-point index nearest hits × 25 and the
  wide layout, and is spawned by a class-5 byte twelve lines past the last wave.
- **The ship** is the level's own frames — the first as the level pose, the
  second (else the first) banking left and its mirror banking right, each
  fitted to 32×32 — in the three pose slots the player handler names (chips
  0-3, 4-7 and 8-11 of MY SHIP GROUP, each TL TR BL BR) through row 18, which
  only the ship draws through; a level with no ship frames flies Duke. The
  rest of the sheet (the dome at 12-15, shots, enemy bullets, weapons, items,
  explosions) keeps the factory sheet's words — the ROM's art, read at play
  time exactly as the sample reads it — with the sample's rows 20 and 21.
- **The title picture** (TITLE GROUP, 8×4 chips on screen through row 19) is
  the browser's title scene as the cart can hold it: the title editor's
  backdrop tiled from the top-left, the logo at y 75 and the subtitle at y 130
  flush left, the window around the logo and subtitle fitted to 128×64 and
  box-filtered down (`composeTitlePicture`); a logo alone sits on the title's
  black, as the sample's does. The group is not that grid row-major — the
  left half of the picture is slots 0-15 and the right half 16-31, each 4
  wide and 4 rows row-major (`titleSlotForCell`; a save with every chip
  coded, photographed at the title, 2026-10-16).
- The sixteen CHECK SUM words, the copy and its word are sealed last, and the
  image is read back through `parseSfcSav` and `verifySfcChecksums` before it
  leaves.

## Running a save (`scripts/lib/sfc-verify.ts`, `lib/sfc-mesen.ts`; observed 2026-10-14)

`deno task sfc:verify <srm>` boots the real cart in Mesen 2's test runner
(`--testRunner`, no window, no pad), writes the image into SRAM from Lua and
resets, then drives the game by polling WRAM and reads the console back
through the battery file Mesen writes on stop (the Lua sandbox has no `io`;
the 128 KB cart is the only way out). What the runs settled, two saves and
both games:

- **Boot.** Reset → "DEZAEMON SUPER FAMICOM VERSION" (~120 frames) → the
  Athena logo (~240) → the main menu GAME PLAY / EDIT / ETC. at ~900 frames.
  A save the boot accepts comes through byte-identical but for CHECK SUM,
  CHECK SUM COPY and MOUSE SPEED (0x7E5A-0x7E7B), which it rewrites.
- **The main menu.** Start IS "GAME PLAY" whatever the cursor points at —
  the hand icon moves with Down but Start ignores it; B (not A) picks the
  pointed entry, so EDIT is Down + B. GAME PLAY → the game's own title:
  TITLE GROUP flown in over its background (the TITLE TYPE animation takes
  ~200 frames), GAME START / OPTION / EXIT, where Start picks the cursor's
  entry (it rests on GAME START).
- **State bytes** (WRAM, found by diffing dumps of each screen): the main
  menu is `$000D == 1 and $03D6 == 5`; the game's title and its OPTION
  screen are `$000D == 0 and $00D8 == $9C`; a stage playing is
  `$03F4 == 1 and $0406 == 3`. `$19CE` is 1 on every screen of the user
  game, so it is not a "sample is playing" flag at the menu.
- **CGRAM at play.** A PALETTE DATA row lands one colour up — colour 0 of
  the hardware palette is transparent, so row word k is palette colour
  k + 1 and the row's word 15 is dropped; a pixel of index k therefore draws
  word k − 1, which is how the writer lays a row out: BG palette 7 ← row n
  (stage n's scenery), BG palette 6 ← row 12 + n (boss), OBJ palette 4
  (CGRAM 0x180) ← row 6 + n (enemies), BG palette 3 ← row 19 (title), OBJ
  palette 7 ← row 18 (ship), OBJ palette 6 ← row 20 (items), OBJ palette 5
  ← row 21 (free), and OBJ palette 1 ← row 21 again with its word 15 at
  colour 0 (a built level's dump at the title and in play, 2026-10-16). VRAM
  holds the stage's chips as the save's own tiles (ALDI: ~500 of its 1,947
  tiles in VRAM mid-stage 0, plus ~190 of the ROM's factory tiles for the
  ship, shots and items).
- **The ship sheet at play** (OAM, a built level, 2026-10-16). The ship is
  four 16×16 OBJs through OBJ palette 7, naming MY SHIP GROUP chips 4-7 (TL
  TR BL BR) while level, 0-3 while banking left and 8-11 banking right — the
  player handler `$02:85D6` keeps the pose in the object's byte 1 (0 left, 1
  level, 2 right) and walks it one step every 5 frames (10 back to level)
  from the sign of the x velocity, which it reads from the speed table
  `$02:8743` by the pad direction and `$19D4 & 3`. Chips 12-15 (the factory's
  blue dome) were never named in 2,000 frames. Y fires: the shots are chips
  47-53 through OBJ palette 6; enemy bullets and explosions are chips 24-45
  through OBJ palette 5; the forced 61-63 draw through OBJ palette 1.
  Nothing but the ship draws through palette 7, so row 18 is the ship's own.
- **Mesen.** Its home on this machine's build is
  `~/Library/Application Support/MesenCE/` (Mesen 2 proper uses `~/Mesen2`
  or `~/Documents/Mesen2`); the battery is `Saves/<rom base>.srm`, written
  on `emu.stop()` even in test-runner mode. `emu.takeScreenshot()` returns
  the PNG as a string; `emu.read`/`emu.write` reach `snesSaveRam`,
  `snesWorkRam`, `snesCgRam` and `snesVideoRam`; `emu.setInput({start=true},
  0)` inside an `inputPolled` callback presses a button.

## Unresolved

- **The row-to-CGRAM copy** for rows 18-21 goes through a table not yet
  found; which palette each lands in is observed ("Running a save"), not
  traced.
- **Entry byte 1 bits 0-4** (shot aim/pattern) and the shapes of shot types 0-2:
  the shot routine `$02:82AD`. The writer copies the sample's value.
- **The boss block's pair bytes 7-12** and the score index's table; the exact
  phase logic (`$02:A337`).
- **SCROLL EFECT +0x100**: no play-time reader found; `0x42` is what every save
  holds.
- **The ship sheet's chips 12-15** (the factory's blue dome: a second
  animation type?) and the item and weapon slot roles beyond the pointers
  listed in the trace; the three poses are settled ("Running a save").
- **SOUND DATA's note format**, and whether an all-zero song is tolerated; the
  writer carries the sample's 16 songs and points BGM PATCH at ROM songs.
- **The player's shot damage** against the hit-point table.
- The editor's "page" table for its pixel screen (irrelevant to the game).

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
