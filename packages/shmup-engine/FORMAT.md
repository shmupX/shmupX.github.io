# Dezaemon 2 (Saturn) save format — reverse-engineering notes

Working notes for the importer. Split into **confirmed** (validated against real
saves and locked by unit tests) and **open** (needs more samples / disc RE).
Four reference saves live in `fixtures/`:

| File                    | Source                        | What it is                       |
|-------------------------|-------------------------------|----------------------------------|
| `ramsie.sav`            | hardware-style cart dump      | full user game "Ramsie"          |
| `mucha-kucha.sav`       | hardware-style cart dump      | full user game "MuchaKucha"      |
| `baseline-cart.bcr`     | OpenEmu / Mednafen battery    | empty (just-formatted) cart      |
| `baseline-internal.bkr` | OpenEmu / Mednafen battery    | 32KB internal RAM, `DEZA2___SYS` |

All multi-byte integers are **big-endian** (Saturn is a big-endian SH-2 machine).

## Container wrappings (confirmed — `lib/bup-source.js`)

Input files arrive in one of three wrappings, all normalized to raw BUP bytes:

- **gzip** — Mednafen / OpenEmu's `.bcr` battery saves. Standard gzip header
  (`1f 8b 08 …`) over the raw 512KB cart image.
- **0xFF-interleaved** — full hardware-style cart dumps. Every even byte is
  `0xFF` (the unused high half of each 16-bit backup-RAM word). 1MB physical,
  512KB+32KB logical. De-interleave by taking the odd bytes.
  (`lib/bup-deinterleave.js`)
- **raw** — internal-RAM dumps (`.bkr`, 32KB) and already-unwrapped cart images.

## Partitions and blocks (confirmed — `lib/bup-parse.js`)

A normalized image holds one or more **partitions**, each starting with a run
of the ASCII magic `"BackUpRam Format"`:

- Hardware-style cart dumps (1MB physical → 0x88000 logical): a 32KB
  internal-RAM mirror partition at `0x0`, then the 512KB cart partition at
  `0x8000`.
- Mednafen `.bcr`: the bare 512KB cart partition at `0x0`.
- Internal `.bkr`: the bare 32KB partition at `0x0`.

**Block size** is 512 bytes for 512KB partitions and 64 bytes for 32KB ones.
Block N lives at `partitionBase + N * blockSize`. Every allocated block begins
with a **4-byte tag**: `0x80000000` for a save's header block, `0x00000000`
for continuation blocks. (This resolves the old "block 3 at page+3*64 lands in
the magic zone" confusion — cart blocks are 512 bytes, and the `0x0000` words
formerly read as list gaps/terminators were continuation-block tags.)

## Directory entry == header block (confirmed)

| Off  | Size      | Field    | Ramsie         | Mucha          |
|------|-----------|----------|----------------|----------------|
| 0x00 | u32       | flag/tag | `0x80000000`   | `0x80000000`   |
| 0x04 | char[12]  | filename | `DEZA2____01`  | `DEZA2____01`  |
| 0x10 | char[10]  | comment  | `DEZA2 SGM`    | `MuchaKucha`   |
| 0x1A | u8        | language | 0 (JP)         | 5              |
| 0x1B | u24       | date     | 2007-12-25     | 1997-12-02     |
| 0x1E | u32       | datasize | 167,511        | 154,015        |
| 0x22 | …         | data stream (block list + payload)             |

`DEZA2____01` is slot 1 of Dezaemon 2's five save slots (`…01`–`…05`); the
user's game title lives inside the payload. `date` is minutes since
1980-01-01. Comments are Shift-JIS (the internal-RAM `DEZA2___SYS` record's
comment decodes to `ﾃﾞｻﾞ2_ｼｽﾃﾑ`, "Deza2 System").

## Data stream and block list (confirmed)

The save's data stream starts at header-block offset 0x22, fills the rest of
that block, and continues through the chained data blocks — skipping each
block's 4-byte tag. The stream contains, in order:

1. **Block list**: u16 block numbers, one per chained data block, terminated
   by `0x0000`. The list itself flows across block boundaries (Ramsie's 331
   entries occupy the rest of the header block plus the start of block 3).
2. **Payload**: exactly `datasize` bytes.

Ramsie: blocks 3..333, payload at logical `0x86BE`. Mucha: blocks 3..306,
payload at `0x8688`. Reassembly follows the chain, so fragmented saves (e.g.
multi-game carts) reassemble correctly. Validated end-to-end by the section
checksums below (`test/payload-table.test.js`).

## Payload: section table (confirmed — `lib/payload-table.js`)

A game payload is a 0x6C-byte table + **8 concatenated sections** consuming
`datasize` exactly:

| Off  | Type      | Field | Meaning                                          |
|------|-----------|-------|--------------------------------------------------|
| 0x00 | u32       | checksumTotal | sum of the 8 section checksums           |
| 0x04 | u32       | tableAddr | LWRAM address where the **compressed save image** is staged (`0x002C8A84` in both saves); sections start at `tableAddr + 0x6C` |
| 0x08 | u32       | endAddr | last section's addr + size                     |
| 0x0C | u32×3 × 8 | per-section `(checksum, addr, size)` — checksum is a plain 32-bit byte-sum; `addr`/`size` describe each **compressed** chunk, chaining by compressed size (ramsie: sec0 @0x2C8AF0+21065 → sec1 @0x2CDD39 …). They say nothing about where the *decompressed* live regions sit. |

Section sizes (Ramsie / Mucha): 21065/19310, 25320/24188, 26710/17909,
21853/21877, **447/448**, **56643/53492**, 14676/15977, 689/706.

Observations:

- **sec4** (~447 B) is nearly byte-identical between two *different* games →
  engine-default data; a free known-plaintext anchor for compression RE.
- **sec5** is the largest (~53–57 KB) with the lowest entropy → likely CG
  (sprite) data.
- sec7 (~700 B) and sec4 are the small sections — likely settings/title-ish.

## Section compression (confirmed — `lib/decompress.js`)

Sections are individually compressed with **classic Okumura LZSS** (the
"COMPRESS POINT / 87%" screen during SAVE). Identified by brute-forcing the
variant space (`dev/scan-compression.js`) with a virgin-ring-read
discriminator and the sec4 known-plaintext anchor:

- flag byte governs the next 8 items, **LSB first**; bit 1 = literal (1 byte),
  bit 0 = match (2 bytes `b1 b2`)
- match: offset = `b1 | ((b2 & 0xF0) << 4)` (absolute ring index),
  length = `(b2 & 0x0F) + 3`
- ring buffer 4096 bytes, **zero-filled**, write position starts at `0xFEE`
  (encoders reference the zero prefill to emit leading zero-runs)
- stream ends when the compressed input is exhausted

**Proof:** all 16 fixture sections decode cleanly to *exact, game-invariant*
region sizes:

| Section | Decompressed size | Cross-game similarity | Reading |
|---------|------------------:|----------------------:|---------|
| sec0    | 65,536 | 30.8% | game data (64KB region) |
| sec1    | 65,536 | 17.7% | game data |
| sec2    | 65,536 |  4.3% | game data |
| sec3    | 65,536 | 18.6% | game data |
| sec4    |    512 | 98.0% | settings-ish (delta diffs land at 0x180–0x1FF) |
| sec5    | 396,640 | 82.6% | CG / sprite pages (first ~55% dense, then sparse) |
| sec6    | 101,472 | 69.0% | game data |
| sec7    |  5,828 | 99.8% | engine-constant table |

Locked by `test/decompress.test.js`.

## Disc image (confirmed — probed 2026-08-05)

The retail disc (`dev-fixtures/Dezaemon 2 (Japan)/`, MODE1/2352 track 1 +
one CD-DA track) is a Rosetta stone for the section contents. Extract the
ISO9660 files (2048B user data at sector offset 16); findings:

- **`.CMP` container**: every `.CMP` file is `u32LE compressedSize` (== file
  size − 4) followed by **the same Okumura LZSS stream** as save sections.
  Our `lib/decompress.js` opens all of them unmodified.
- **`SGM_*.CMP` = complete games** (DAIO, RAMS, ELFI, MIYA, GUST + INIT):
  each decompresses to **exactly 766,596 bytes = the 8 raw sections in live
  MEMORY order `sec0,1,2,3,5,4,6,7`** (CG pages ×4, assembly, palettes, BGM,
  3D — no 0x6C table; that and the per-section recompression happen at save
  time). Under that slicing `SGM_RAMS` matches the `ramsie.sav` fixture
  byte-for-byte on **all 8 sections** — the Ramsie cart save is the untouched
  built-in sample. `SGM_INIT` == `SGM_GUST` byte-identical: the factory "New
  Game" state is the Bio Metal Gust sample. ELFI (hidden: L+R on Ramsie) and
  MIYA (雅, hidden: L+R on Gust) are full games not in any cart save.
  `dev/decode-corpus.js` ingests all six as corpus entries `disc-*`.
- **sec6 = BGM, proven**: `SMP_BGM.BIN` is uncompressed and exactly 101,472
  bytes = sec6's size = **24 song slots × 4,228 bytes**. `M_DATA01–73.BIN`
  (4,228 B each) are the preset songs: DAIOH-g0's sec6 is literally
  `M_DATA01..14` concatenated; Ramsie's sec6 matches 12 other presets
  slot-for-slot. Song format: small header (`0c 0f 05 xx …`) then 8-byte
  step rows, `0x80` = rest.
- **`MDLDT_01–56.CMP` = preset 3D models for ポリ吉** (the 3D-to-sprite
  editor, overlay `POLYKITI`): SGL-style compiled meshes loaded at LWRAM
  `0x2F0000` — 12 PDATA pointers, then vertex tables (12 B XYZ) and polygon
  tables (20 B = normal + 4 vertex indices), verified exactly. This is a
  *different* format from sec7's part lists (presets render from MDLDT
  directly; sec7 stores only user-built part compositions).
- **`BACK00–14.CMP` = preset backgrounds** (decode to ~72KB); `BACK00` has an
  RGB555 gray-ramp palette at +0x14 (byte-swapped), `BK_CHECK.CMP` opens with
  big-endian RGB555 ramps.
- **`DEMO_?N.BIN`** = per-stage input recordings ((u16 frames, u16 buttons)
  runs) for D=Daio×5, E=Elfi×3, G=Gust×5, M=Miya×4, R=Rams×5 → sample games
  have 3–5 stages.
- **`0KERNEL.BIN`** (SH-2 main program) holds 34 references to `0x002C8A84`
  (the save/load compression staging buffer). Editor overlays are code:
  `KUMITATE` = 組み子さん (game assembly), `S_PAINT` = 絵太郎 (CG),
  `POLYKITI` = ポリ吉 (3D), `GAME.CMP` = play-mode engine (165,628 B
  decompressed). **Caveat**: an early literal-pool xref scan
  (`dev-out/xref-offsets.txt`) assumed the *decompressed* sections lived at
  `0x2C8AF0+` — wrong (that range stages the *compressed* image), so its
  per-section offset map is mislabeled. Redo by first recovering the live
  region base addresses from the LZSS-decompress call sites (src = staging
  addrs, dst = live regions), then re-basing the constants.
- `DEZA2.PAL` = 576 B = 18 × 16 RGB555 colors (editor UI palette).
- `GAME.CMP` = play-mode engine code (165,628 B decompressed) — the target
  for tracing exact field semantics (enemy HP, stage script opcodes).

## Section semantics (2026-08-05 corpus + disc analysis)

The 8 sections map onto the game's own LOAD-menu grouping (ALL / CG /
game-settings / MUSIC / 3D) and its four editors (絵太郎 CG, 組み子さん
assembly, 音まろ music, ポリ吉 3D):

| Section | Content | Status |
|---------|---------|--------|
| sec0–3  | **CG art pages 1–4**: each a headerless **128×512** 8bpp bitmap stored as 256 consecutive 16×16-px cells of 256 B (cell t at t·256; in-cell offset = y·16+x; **8 cells per row**). Pixel byte = `(palette<<4) \| colorIndex` — the high nibble *is* the palette selector, so no external sprite-attribute table exists. Byte 0x00 = background; empty cells are zero-filled. | confirmed |
| sec4    | **Palette bank**: 16 palettes × 16 colors, u16be RGB555 (R bits 0–4, G 5–9, B 10–14, bit15 = CRAM RGB-mode flag). Rows 0–11 (0x000–0x17F) = 12 preset ramps, byte-identical across all games, bit15 clear; rows 12–15 (0x180–0x1FF) = the 4 user palettes (= the editor's "192 system + 64 user colors"), stored `0x8000\|color`, 0x0000 empty. u16[0] varies per game (meaning open). | confirmed |
| sec5    | **Game assembly data** (組み子さん) — see the sec5 region map below. Regions are proven from engine-code multiplications and tile exactly; the background tilemap, placement grid, enemy records, boss record and sprite composition banks are decoded, the scroll curve's field meaning and parts of the settings block remain open. | mostly decoded |
| sec6    | **BGM**: 24 song slots × 4,228 B (disc `M_DATA*` presets match verbatim). Song = 4-byte header + **32 measures × 132 B**, each measure = 4 control bytes + **4 parts × 32 steps**, part-major. Step: 0x00 empty, 0x01–0x3B note (~5 octaves), 0x80–0x88 sustain. | confirmed |
| sec7    | **3D models** (ポリ吉): u32be magic `0x12345678` (absent = never opened the 3D editor; section then all-zero or residual RAM — ELFI's "custom" sec7 is just uninitialized garbage), then 16 model slots × 328 B (u16be part count 0–9, u16be model color, 9 part records × 36 B), then 576 residual bytes. Part record, offsets pinned against SGM_DAIO's 37 parts (2026-08-28): `+0x00` u16 shape descriptor (high nibble = primitive family 0–5, rest variant bits), `+0x02` u16 pad (0), `+0x04` s32be×3 X/Y/Z position 16.16, `+0x10` u16be×3 rotations (65536 = 360°), `+0x16` u16 pad (0), `+0x18` s32be×3 scales, signed 16.16, negative = mirror. POLYKITI.bin literal pools confirm the slot stride (HWRAM working base `0x06097E90`, stride 0x148, end 0x1484). Decoder: `lib/decode/decode-model.js` (the part-shape meshes themselves are engine-fixed in the POLYKITI overlay — still untraced, so models decode as transforms over named-by-number primitives). | confirmed |

### sec5 region map

Boundaries and strides come from explicit multiplications in KUMITATE/GAME
literal pools; they tile the 396,640 bytes exactly, with no gaps:

| Offset | Layout | Content | Status |
|--------|--------|---------|--------|
| `+0x00000` | 10 × `0x5400` | **Background tilemap** per stage: 14 cols × 768 rows of u16be = 48 parts × 16 rows. `0xFFFF` = empty; else bit15 V-flip, bit14 H-flip (same convention as the sprite banks), bits 0–9 = CG cell index (1024-cell space). Part = 224×256 px. | **decoded** |
| `+0x34800` | 10 × `0xC0` | **Per-stage scroll curve** — **decoded** (2026-08-28, verified): one byte per 64 px of map (4 rows), indexed live as `stage*0xC0 + scrollPos>>6` and re-read every frame (stage init `+0x1DF44`, per-frame `+0x1E04C`; index shift = kernel `0x06010BF8` = `>>6`). Bits 0-2 = background **scroll speed** target via u16 table `+0x25B14` `[0,64,128,192,256,384,512,1024]` in **1/256 px per frame** (0–4 px/f); the engine EASES the current speed toward it at ±(12 + gap/16) units/frame (snap to 0), integrating whole pixels through a 1/256 accumulator; horizontal games scale ×365/256. Bits 3-5 = **raster-wave amplitude** via u16 table `+0x25B24` = px<<8 of `[0,1,3,5,9,15,22,30]`, ramped ±32 units/frame (a type change fades the old wave out at 64/frame first, rebuilding it every frame of the fade). Bits 6-7 = **wave type**, driving VDP2 SCRCTL NBG0: 0 = vertical ripple (LSCY, wavelength 64 lines, map-locked phase), 1 = traveling horizontal sine (LSCX, amp ×2), 2 = per-line random shake (LSCX, max ±0.75×amp px), 3 = line-zoom bulge (LZMX, symmetric around line 120). The engine substitutes a constant `0x02` byte when its play-STATE byte `u8[0x060840C5]` equals 2 (a demo/attract state — NOT the settings game mode; the same byte holds 6 in another state). Decoder: `lib/decode/decode-stage.js` (`decodeScrollCurve`). | **decoded** |
| `+0x34F80` | 10 × `0x3C00` | **Object placement grid**: 20 columns × 768 rows of *bytes* over the 320-px screen (the 224-px playfield sits at columns 3–16), sharing the background's rows and 48-part division. See the id table below. | **decoded** |
| `+0x5A780` | `0x60` | **Global settings** — see the byte map below | mostly decoded |
| `+0x5A7E0` | 10 × `0x478` | **Per-stage enemy definitions**: 60 records × 18 B (`0x438`) + the `0x40` **boss record** trailer. Record N defines the Nth zako id — see "Enemy record" and "Boss record" below. | **decoded** |
| `+0x5D490` | `0x1D0` | **Global sprite composition bank**: 232 u16be cell refs — **fully decoded** (2026-08-28, via the global-art VRAM upload GAME `+0x3EEC` over the 85-entry char-slot table `+0x27F1C` and the spawners that pick each char). Refs 0-23 = P1 ship (bank-A / idle / bank-B pairs of 2 × 32×32 frames), 24-47 = P2 ship, 48-51 charge glow, 52-68 per-weapon shot/effect art (63 = weapon-1 fire FX, 65 = weapon-2, 66 = weapon-3 object, 68 = weapon-4 missiles; 57-60 the beam segments), 69-78 = weapons 6/7 option figures (10 × 16×16), 79-92 = bomb art (79-82 bomb 4, 87 bomb 5, 88-89 bomb-7 dome, 91-92 sub-2 object), 93 missile smoke, 94-101 = the **8 item icons**, 102-107 = **blast anim A** (6 × 16×16), 108-131 = **blast anim B** (6 × 32×32), 132-143 = the **3 global bullet types** (4 × 16×16 frames each, drawn by char slots 55/59/63), 144-175 / 176-207 = **TITLE 1 / TITLE 2** (each 8×4 cells = 128×64 px), 208-231 = **six 64×16 credit strips** (an earlier 8×3/8×5/three-8×1 title split covered the same refs but mis-cut the pieces). Bombs 1/2/3 draw system chars, not save cells — every save gets them free. Decoder: `lib/decode/decode-sprites.js` (`extractGlobalArt`, `TITLE_SLOTS`). | **decoded** |
| `+0x5D660` | 10 × `0x580` | **Per-stage sprite composition**: 704 u16be cell refs — the flat bank GAME.CMP's stage-art VRAM upload walks slot by slot. Records 0–59 map onto seven art bands, the last 64 refs (`+0x500`) are the boss core; layout below. | **engine-traced** |

The bank layout is engine-traced (2026-08-22), replacing an earlier geometry
guessed from the placement-id counts. GAME.bin's stage-art VRAM upload
routine (file `+0x4000`; engine addr = `0x06064000` + file offset throughout)
walks a flat char-slot table at `0x0608C070` (file `+0x28070`; entries =
u16 geometry index, u16 bank byte offset), taking each slot's pixel size from
a geometry table at `0x06089CFC` (file `+0x25CFC`, 8-byte entries
`(w, h, vramOff, words)`). Slots 0–211 — every zako frame — upload
unconditionally; slots 212–220 are the boss core, selected through a
per-class `(start, end)` pair table (file `+0x20528`:
`[[0,4],[4,6],[6,8],[8,9]]` over base 212). Those tables pin the whole
`0x580` bank (decoder: `lib/decode/decode-sprites.js`):

| records | frames | frame size | bank bytes |
|---------|--------|------------|------------|
| 0–15    | 4 | 16×16 | `0x000`–`0x07F` |
| 16–23   | 4 | 32×16 | `0x080`–`0x0FF` |
| 24–31   | 4 | 16×32 | `0x100`–`0x17F` |
| 32–47   | 4 | 32×32 | `0x180`–`0x37F` |
| 48–51   | 2 | 64×32 | `0x380`–`0x3FF` |
| 52–55   | 2 | 32×64 | `0x400`–`0x47F` |
| 56–59   | 1 | 64×64 | `0x480`–`0x4FF` |
| boss core | per class | see below | `0x500`–`0x57F` |

Slot-count check: 64+32+32+64+8+8+4 = 212 = the upload loop's bound = the
boss-slot base, so the map accounts for every ref. The superseded "11
character slots × 64 refs" model was wrong past `0x180`: records 32–47 are
32×32 4-cell frames (not 16×16 1-cell), records 48–59 are large 2- and
1-frame sprites (not 4-frame 2×2), and its "boss art at the (7+class)th
64-ref slot" read the wrong region entirely. The "eight" 64×32 and 32×64
pieces are really 4 parts × 2 animation frames each (sprite stride 2).

**Boss core**: the placement id's size class (`0xF0`–`0xF3`) picks the
geometry — F0 = four 64×64 frames, F1 = two 128×64, F2 = two 64×128, F3 =
one 128×128 — and all four classes read the SAME 64 refs at `+0x500`. Core
frames wider than 4 cells store their refs as 4×4-cell (64×64 px) sub-blocks
in reading order (class 1: [left][right]; class 3: four quadrants), cells
row-major inside each block. Corpus stats (262 saves, 1,664 placed bosses):
classes F0–F3 occur 804/258/209/393 times, with painted cores in
63.6%/95.0%/94.3%/95.7% of placements.

Unused slots point every ref at the CG editor's unpainted-cell placeholder
(the most-referenced cell in the bank by an order of magnitude), so extraction
skips them and, since art is per stage, falls back to another stage that
places the same enemy. On DAIOH this resolves 204 of 215 placed ids directly
and the rest via fallback, yielding its aircraft, jets and capsules with their
4-frame animations.

Composition words: `0xFFFF` = empty, else bits 0–9 = CG cell index and
**bit14 = H-flip, bit15 = V-flip** — the SAME convention as the background
tilemap. (Two earlier revisions each got this wrong in one direction: the
first claimed the sprite banks copied the background map's then-documented
bit15 = H, the second "corrected" that by declaring the banks OPPOSITE to
the map. In fact the background map's bit15 = H claim was itself the error —
both stores use bit15 = V / bit14 = H.) Evidence, sprites: a corpus render
sweep — every mirror-pair composition (pervasive in boss and large art)
composes only under bit14 = H, a 4-fold-symmetric core in Mucha Kucha
Fighter exercises both bits at once, and there are zero counter-examples
across the 262 saves. Evidence, background (2026-08-27): Ramsie's
mirror-symmetric chambers — the stage-0 goddess boss chamber, stage 3's
vine pillars, stage 4's mandala — render as coherent left-right-mirrored
artwork only under bit14 = H, and under bit15 = H reproduce exactly the
garbled right-of-boss tiles reported from the level editor's play mode
(confirmed against a Saturn capture of the same chamber). The two banks
close the section exactly (`0x5D490 + 232·2 = 0x5D660`; `0x5D660 + 10·1408 =
0x60D60`), and both bases are SH-2 literals in the engine.

**Placement ids** — exactly 72 distinct non-zero values in eight disjoint
ranges across all 17 games:

| Ids | Meaning |
|-----|---------|
| `0x80`–`0x97`, `0xA0`–`0xA7`, `0xB0`–`0xBF`, `0xC0`–`0xC3`, `0xD0`–`0xD3`, `0xE0`–`0xE3` | the **60 zako slots**, in the same order as the 60 enemy records |
| `0xE8`–`0xEF` | the editor's **8 item slots** |
| `0xF0`–`0xF3` | **boss**, one of 4 size classes — at most one per stage |

A placed zako id has a non-empty enemy record 99.9% of the time (8 misses in
7740 checks), which is what ties the two regions together. Bosses sit deep in
the level (Ramsie stage 0: row 423 of 768, landing exactly on the boss-chamber
artwork), and zako appear in formations symmetric about the 20-column centre.
Stage count is taken from this grid rather than the background map — the two
disagree in 6 of 17 games (a cut-scene stage can carry objects with no painted
background), while placement and the enemy blocks always agree.

**Enemy identity is per stage, not global.** The 10 × `0x478` enemy block gives
each stage its own 60 records, and they are genuinely different enemies: in
DAIOH's second save, 56 of the 60 record slots hold a *different* 18-byte
definition in every stage that places them (record 0 has nine distinct
variants across its nine stages), and only 4 records are used by a single
stage. The per-stage sprite composition bank agrees — 327 painted
(stage, record) pairs resolve to 160 distinct compositions. So a roster keyed
on the record number alone collapses unrelated enemies together; the importer
keys on the **(stage, record) pair** (`lib/decode/decode-stage.js`).

**Enemy record (18 B)** — **decoded** (2026-08-08) by disassembling the zako
spawn routine in GAME.CMP (loaded at `0x06064000`; the routine at file
`+0x153C8` computes `record = 0x0029A7E0 + stage*0x478 + index*18` — the only
three literal-pool references to the record base in the whole engine are that
spawn routine and two small per-field query helpers at `+0x166B4`/`+0x1670C`).
Layout: a 6-byte head plus four 3-byte **change channels** — the editor's
start/end/rate/repeat interpolators:

| Byte | Field |
|------|-------|
| 0 | appearance id: indexes the 256-entry pointer table `+0x6088e5c` — whose entries are **BEHAVIOR SCRIPTS, not sprite definitions**. See "Appearance scripts" below. Sprite size, char slot, frame count and hitbox come from the PLACEMENT-ID BAND instead (seven spawn wrappers `+0x16070..+0x165F8`: frame counts 4/4/4/4/2/2/1 and char bases 67/131/163/195/259/267/275 across the seven art bands); `b0>>3` selects the object CLASS from `+0x21FB0` — 0x30 = scripted zako (208 ids, **93.9%** of corpus enemy definitions), 0x31–0x36 = hardcoded special AI on an empty script (48 ids, the rest). |
| 1 | bits0-2 **hp** index → `[60,30,15,10,5,3,2,1]` (`+0x6085ee8`; index 0 = toughest, 7 = the editor default) — the SAME value is the **animation frame period in ticks** (both counters load from it at spawn `+0x15448`; the anim reload doubles as the pierce-exchange hp, so damaged enemies animate faster); bits4-6 **score** index → `[50,100,200,500,1000,2000,5000,10000]` (`+0x6085ef0`); bit7 **ground** flag |
| 2 | bits0-2 **speed** index → u32 `[256,12800,…,512000]` (`+0x6085f20`, 16.16 px/frame, ×1.5 at rank ≥2 and again at rank 6); bit3+bits4-5 **movement pattern** (0-7, `((b2>>4)&3)\|((b2&8)>>1)`); bit3 alone is the TERRAIN-RIDE flag the ride helper gates on; bits6-7 **death mode** (see "The death word") |
| 3 | **death word parameter** — item slot / child record / chain key, by mode (see "The death word"). NOT fire params: nothing in the firing path reads this byte. |
| 4 | bits0-1 fire mode; **bits2-3 death presentation** (0 = vanish silently, 2 = small blast, 1/3 = full); bits4-6 **fire rate** index → interval `[119,59,29,19,9,5,3,1]` (`+0x6085f81`; mode 3 uses `[119,59,39,19,11,7,3,1]`) + randomization window `[29,22,16,11,7,4,2,1]` (`+0x6085f61`) — reload = interval + rand(window) |
| 5 | bits0-4 fire direction (0 = default/aimed), bits5-7 extra (passed to the shooter at `+0x607cfac`) |
| 6-8 | **speed-change channel** (enable `b6&1`) — values `[0,4,8,12,16,24,32,48,64]`/16 = ×0..×4 (`+0x6086004`), steps `[16..1024]`/256 (`+0x608600e`) |
| 9-11 | **rotation channel** (mode `b9&7`: 0 off, 1 cw, 2 ccw, 3/4 engine-special) — angles `[0,32,…,224]` of the 256-circle (`+0x6085fec`), steps `[16..2048]`/256 (`+0x6085ff4`) |
| 12-14 | **scale channel** (mode `b12&3`: 0 off, 1 XY, 2 X, 3 Y) — values ×0..×4 (`+0x6085fd0`, 16 = ×1.0, the spawn default `0x1000` = 16<<8), steps `[16..1024]`/256 (`+0x6085fda`); `b14` bits4-5 repeat X, bits2-3 repeat Y |
| 15-17 | **direction channel** (enable `b15&1`) — movement angles `[0,16,…,128]` (`+0x6086020`; default 0x80 = 128 = straight down), steps `[128..32767]`/256 (`+0x608602a`) |

Channel byte layout (A,B,C): A bits4-6 step index; B low/high nibble start/end
value index (rotation: 3-bit); C bits4-5 repeat (0 once, 1 loop, 2 ping-pong),
bits0-2 a trigger mode packed into a per-enemy status word (semantics open).

**Byte 5's low nibble is a GEOMETRY selector, used twice** (fully traced
2026-08-28, adversarially verified). The fire dispatcher (`+0x1989e`) masks
`b5 & 0xF` and routes 10/11/12 to three burst handlers (`+0x193d0` /
`+0x19538` / `+0x196a8`) — variants of one template over a per-slot burst
counter `u8[0x608DCF0]`: **10 = 4 volleys** one fire tick apart (counter
`&3`), **11 = 5 volleys** (reset when >4), **12 = 16 volleys on consecutive
serviced frames** (counter `&15`; its counter check precedes the fire-tick
gate, so a started spiral finishes even with global fire off). Every other
value falls through to the default handler (`+0x192d4`). All paths call the
same SHOOTER `+0x18FAC(slot, type=b4&3, b5&0x1F, Y; stack X, heading>>8)`
(the "kernel shot-spawn helper 0x6010be6" of the earlier note is just an
arithmetic `>>8`), which dispatches the nibble AGAIN through the 16-pointer
geometry table `0x6086074` — so the burst nibbles also pick their geometry:
10 = plain single (the 4-burst is 4 straight/aimed shots), 11 = single with
per-shot jitter of `(rand&31)−16` angle units, 12 = single stepping through
the 16-byte rotation table `+0x22064` `[C0 D0 E0 F0 00 10 .. B0]` indexed by
the burst counter — a **22.5°/shot full-circle spiral**.

### Axes and angles (settled 2026-08-28 — supersedes earlier notes)

Three independent code paths pin the two per-object position arrays, and
several earlier claims in this file had them (and therefore every angle)
rotated 90°:

| array | axis | evidence |
|-------|------|----------|
| `0x06090040` | **lateral** — the 20-column axis, screen X in a vertical game (0…320 px, playfield 48–272) | the placement walker stores `column << 11` (= col·16 px·128) here (`+0x169EE`→`+0x1609E`); the item spawner does the same with `(col·16+8)·128`; the collision test at `+0x18322` compares this axis' separation against the hitbox extent that holds **12** for a 32×16 sprite (its wide half-extent) |
| `0x0608D400` | **scroll** — the axis the stage scrolls along, screen Y in a vertical game (playfield 224 px) | the same call passes a *pixel* scroll position `<< 7`; the on-screen fire window tests it against `[0, 0x7000]` = 0–224 px; its hitbox extent is the narrow **6** |

Every object integrates in the master walker at `+0x791C` (`0x0606B91C`; the `+0x7930` of earlier notes is mid-body):

```
lateral (0x06090040) += s16 0x06094840[slot]      // the COS component
scroll  (0x0608D400) -= s16 0x0608F640[slot]      // the SIN component
```

and every velocity producer — the zako appearance drift (`+0x4D80`), the
boss movement interpreter (`+0x1A4E2`), the bullet spawn (`+0x185E2`) —
writes `cos(angle)·speed` to `0x06094840` and `sin(angle)·speed` to
`0x0608F640`. So for **every** angle in the engine:

> **screenX += cos(θ)·v, screenY −= sin(θ)·v** — i.e. a standard
> math-convention circle with the screen's Y flipped:
> **0 = right, ¼ turn = UP, ½ turn = left, ¾ turn = straight DOWN.**

In the 65536-unit space the interpreters use (boss steps, appearance rows)
that reads `0x0000` right, `0x4000` up, `0x8000` left, **`0xC000` down** —
which is why virtually every appearance row and boss "advance" step stores
`0xC000`. Verified in the runtime at frame resolution: a boss on heading
`0x0000` measures dx +0.287/dy 0, on `0x8000` dx −0.772/dy 0.

Speeds: a velocity producer computes `(trig · amplitude) >> 16` with a
trig amplitude of 0x7FFF (zako) or 0x10000 with an extra `>>1` (boss), so
the stored velocity is ≈ amplitude/2 in the ×128 position units —
**px/frame = amplitude/256** in both systems. In horizontal games the
SCROLL component is rescaled ×365/256 (`+0x4E1A`, `+0x1A514`) for the
320-px-wide scroll axis.

**Movement is a 2-bit mode plus a flag, not an 8-way enum.** The spawn packs
`b2` bits 4-5 and bit 3 into one byte at `0x6091550`
(`((b2>>4)&3) | (bit3 ? 4 : 0)`), and the engine reads that byte BITWISE
across its 56 read sites: masks `0x1` (17x), `0x4` (13x), `0x3` (12x), `0x2`
(2x), `0x8` (1x). Mode 3 never occurs in the corpus. `decode-enemy.js` now
exposes `move: {mode, flag}` alongside the packed `movePattern`.

### Appearance scripts (**decoded** 2026-08-28)

Each of the 256 appearance ids points at a variable-length list of 10-byte
rows (script data `+0x220BC`–`+0x24E52`; 202 distinct scripts, 1,206 rows
in total, extracted byte-exact to `data/appearance-scripts.json` and shipped
to the runtime by `src/decode/appearance-table.js`). The rows are the
enemy's **entry choreography** — the swoops, circles and hovers a Dezaemon
enemy performs on its own, independent of the record's change channels.

| offset | field |
|--------|-------|
| +0 | `u16` duration in AI ticks (one tick per display frame); `0x7FFF` = hold |
| +2 | `u16` drift **angle**, 65536 = full circle (see "Axes and angles": `0xC000` = straight down) |
| +4 | `s16` **turn rate** added to the angle every tick |
| +6 | `u16` **amplitude** in bits 0–14 (px/frame = amp/256); **bit15 = rides the scroll** |
| +8 | `u16` **flags** |

Interpreter 1 (`+0x4EC4`, the polar-drift one; interpreter 2 at `+0x5054`
is selected by flags bit7 and steers toward a lateral target instead) runs
one tick per frame:

- when the row timer expires the next row is loaded; **flags bit0 advances
  the cursor**, and a row without it holds forever (`+0x4F42`)
- while a row runs, `angle += turnRate` (`+0x4F60`)
- the drift helper `+0x4D80` then rewrites the velocity — but **only on a
  row load or on a tick that actually turned** (`+0x4F6C` skips the call
  when the turn rate is 0), so between those the velocity persists and the
  record's own channels stay in charge
- **flags bit5 SUPPRESSES the lateral component and bit6 the scroll one.**
  Both `tst`/`bt/s` pairs branch to the COMPUTE path when the bit is
  CLEAR and fall through to a store of 0 when it is set — the opposite of
  the "enable" reading, and the corpus confirms it: only 16 of the 256
  scripts ever set either bit, so under the enable reading 240 of the
  engine's choreographies would be motionless
- a **right-half spawn** (status bit0, set when the lateral coordinate
  exceeds `0x4FFF` = 160 px) negates the lateral component, which is what
  makes placed formations sweep out symmetrically; the **ground** flag
  (status bit1) negates the scroll component
- the TERRAIN RIDE — **fully traced 2026-08-28, superseding two earlier
  mis-attributions in this file** (see "Terrain ride" below for the complete
  helper). The row's amplitude bit15, **or** flags bit8 together with the
  packed movement byte's bit2, is the CALL GATE of the ride helper
  `+0x4BFC`; status bit6 is orthogonal to that gate and selects WHICH of the
  helper's two forms runs, not whether it runs at all. **Everything else
  holds its screen position** unless its own drift moves it. The 2028-ai
  runtime implements the whole model for entry-carrying imports (anchored
  riders recompute absolutely, plain riders add the frame's whole pixels,
  holders hold; hidden-above-screen holders are retired after ten seconds),
  keeping the legacy everything-scrolls model for imports that predate the
  entry data

Other flag bits: **bit4 = this appearance never fires** (48 of 256 ids —
the long-known `APPEARANCE_NOFIRE`), bit9 = expire the row early past a
resolver threshold, bit12 = halve the duration for the band's variant-B
spawn.

One AI tick is one display frame: the master walker makes a single pass
over slots 0–248 per frame with no segmentation (`+0x791C`), and a row
lasts `duration + 1` ticks (the counter is decremented before the test).

**The six special classes 0x31-0x36** (appearance ids 184-191 and 216-255,
11.5% of corpus enemy definitions — **decoded 2026-08-28 and adversarially
verified with no substantive errors**; full spec in the trace reports, all
six implemented in the 2028-ai runtime). The class table byte (`+0x21FB0`,
id>>3) routes them to hardcoded AI instead of the script interpreters; their
speed is `SPEED[id&7]` = `[128,256,384,512,640,768,1152,1536]`/256 =
0.5-6.0 px/tick:

- **0x36** (216-223, 6.7% of records): aims at the player ONCE at spawn and
  flies straight forever (no player: straight down for air, up for ground).
  Its fixed-heading branch is dead code — every spawn path clears the
  selector bit first.
- **0x31** (224-231): homer — re-aims every 8-23 ticks, turning 448 units
  (2.46°)/tick with shortest-way snap.
- **0x32** (240-247): stop-and-go over counter `c = s16(c+1)`, flip to
  `-LIMIT[id&7]` past `+LIMIT` (`[72,64,56,48,40,32,24,16]`): hover (c<0)
  aims at 2·S/tick with velocities zeroed and fire enabled; dash (c>=0)
  flies the frozen heading with fire suppressed, stopping early when it
  reaches the player's 16-px cell.
- **0x33** (232-239): drifts along the scroll axis (air down, ground up) at
  S/2; when the player draws level it charges sideways toward the player's
  side, accelerating S/64 units/tick² forever.
- **0x34** (248-255): the mirror — slides toward the player's column, then
  dives along the scroll axis with the same acceleration (and, unlike 0x33,
  terrain-rides during its slide when the movement byte's flag is set).
- **0x35** (184-191): locks on and flies at the player; within 56 px cross /
  128 px scroll it banks its angle through a half-circle at (S+128)
  units/tick with speed growing S/32 per tick — a swerving strafe that
  escapes sideways.

### Terrain ride — the helper `+0x4BFC` (fully traced, 2026-08-28)

`0x06068BFC(slot)` is 58 instructions (`..0x06068C6E`) with two branches, chosen by **bit6
(0x40) of `0x0608EF40[slot]`**. All positions below are the scroll axis;
`0x0608D400[slot]` is px<<7 and every other quantity here is WHOLE PIXELS
(`0x06010BF6`, the kernel helper the spawn calls, is literally seven
`shar r4` = an arithmetic `>>7`):

| symbol | meaning |
|--------|---------|
| `0x0608D3FA` (s16) | the map's current scroll position, in px |
| `0x06090A2C` (s16) | px the map scrolled THIS frame (recomputed every UNPAUSED frame at `+0x3570`) |
| `0x06094C40[slot]` (s16) | the object's screen Y **when its anchor was taken** |
| `0x0608EC90[slot]` (s16) | the map scroll at that same moment |
| `0x06090F40` (s16) | a map-LOOP rebase correction, non-zero only on a wrap frame — and wraps are NOT a demo-mode curiosity: the wrap block runs when the game mode is > 1 **or** any boss flag (`0x06084158`) is set, so ordinary play hits it |

```
ride(slot):
  if (status[slot] & 0x40):                       # ANCHORED — absolute
      if (rebase != 0): anchorScroll[slot] -= rebase
      scroll[slot] = (anchorY[slot] + mapScroll - anchorScroll[slot]) * 128
  else:                                           # plain rider — incremental
      scroll[slot] += framePixels * 128
```

The anchored form **rewrites** the coordinate rather than nudging it, so a
turret can never drift off its piece of terrain; the rebase keeps
`mapScroll - anchorScroll` invariant when a looping map wraps, so nothing
jumps. The anchor pair is seeded in exactly three places — the spawn tail
`+0x1675C`, the boss landing sequence, and the death-word child spawner
`+0x18F10`, where a child of an ANCHORED parent inherits both values verbatim
(otherwise it takes a fresh anchor at its own position).

Bit6 is **dynamic state**, not an object kind: the spawn sets it from bit7 of
the class-table byte `0x06085FB0[b0>>3]`, which is `0xB0` at indices 0, 2 and
3 — hence appearance ids 0-7 and 16-31, the turrets and scenery — and the
boss code sets/clears it as the map starts and stops scrolling, which is what
fixes its meaning as "currently riding the terrain". Chain-killed objects have
it cleared.

The helper has exactly **three call sites**, so it does NOT run for every
object every frame:

- `+0x4FAC`, in script mover A (`+0x4EC4`), when
  `(rowFlags & 0x100 && moveByte & 4) || (s16)amplitude < 0` — the second test
  is amplitude bit15. Row flags **bit7 picks the mover**: set = mover B
  (`+0x5054`), which inlines the incremental ride, gates on amplitude bit15
  alone and can never take the anchored branch; clear = mover A, the only path
  that honours bit6.
- `+0x6DA2`, class 0x33, in its sideways-charge sub-state, gated on the
  movement flag.
- `+0x70C4`, class 0x34, throughout **phase 1** (the lateral approach, not the
  dive), gated on the movement flag. It does not zero the scroll-axis velocity — it
  SETS it to `-(amplitude>>1)`, a half-speed downward drift, and zeroes only
  the heading, so the enemy slides across while both its own drift and the
  terrain carry it down. In phase 2 the movement flag instead makes the
  handler return at once (`+0x70E6`): neither ride nor acceleration.

That gating flag, bit2 of `0x06091550[slot]`, is **enemy-record byte 2 bit 3**
— the editor's per-placement movement flag. There is no lateral analogue: the
anchor array is referenced only alongside the scroll axis.

**Formation keys** (`0x06090530[slot]`): every grid-spawned ENEMY gets its
placement cell byte, written by the spawn tail `+0x1675C` (and by the periodic
extra spawner). Placed ITEMS (cells 0xE8-0xEF) bypass it and get key 0; cells
0xF0-0xFF spawn nothing. The byte is `1 bbb nnnn` — bit7 the OCCUPIED flag
(always 1 for a real key), bits4-6 the band, bits0-3 the index — and the band
nibble doubles as the object's size class for the despawn bound (`+0x4C8C`).
The array is a general per-slot scratch byte, not a dedicated key: other
object classes keep an 8-direction angle or a 0/1 latch there, and it is never
cleared when a slot is freed (every allocation site rewrites it first).

**The death word** — record byte 2 bits 6-7 (mode) and byte 3 (parameter),
**which this file previously mis-labelled "fire type" and "fire params"**. The
firing path never reads either byte; the spawn `+0x153C8` is the only code that
does, packing them into one per-slot u16 `0x06094240[slot]` as `mode<<8 | param`
that the death dispatcher `+0x6448` consumes when hp hits 0:

| mode | effect |
|------|--------|
| 0 | nothing |
| 1 | **drop an item.** The parameter is re-encoded at spawn as `(b3&8) ? 9 : (b3&7)+1` — an item SLOT 1-8, or 9 = cycle the slots through a global counter. 0 drops nothing. |
| 2 | **spawn a successor** at the dying enemy's exact position (no cell snapping), from the CURRENT stage's record table, index `BASE[(p>>4)&7] \| (p&15)` where `BASE` = the 7 bytes at `0x0608603C` = `[0,16,24,32,48,52,56]`. The low nibble is OR-ed in **unmasked** (`+0x1A488 or r4,r5`); the per-band mask 15/7/7/15/3/3/3 shapes only the art and hitbox. Band 7 is clamped to band 0. The child is tagged `0x06090530[child] = p\|0x80` and takes no velocity, hp or rank from its parent — only, conditionally, its terrain anchor. |
| 3 | **chain-kill.** Scans the 149 other slots of the 99-248 enemy pool for `0x06090530[j] == p\|0x80`, and arms the Nth match with `hp[j] = (4*N) \| 0x80000000`. A per-tick countdown re-enters the FULL death handler at zero, so each link awards its own score, drops its own item, spawns its own successor and can chain again. Victims are frozen (both walker components zeroed), silenced, credited to the same player and have their anchor bit cleared. |

Score is awarded unconditionally, before the mode dispatch. Record byte 4
bits 2-3 ride in the same word as the death PRESENTATION: **0 = vanish
silently** (no blast, no sound — word bit15), 2 = the small blast and no
revenge shot (bit14), 1 and 3 = the full blast. All of this applies to boss
parts too: they are built from the same 18-byte record by the same spawn.

Mode 2 also has a second, reduced trigger (`+0x63AC`) that every class handler
calls when the AI script vanishes the object: it spawns the successor only —
no score, no item, no chain, no blast.

The decoder surfaces all of it as `behavior.death`
(`{mode, param, item|key, record, silent, small}`, decode-enemy.js), the mapper
ships the formation key as `dezaemon.placementId` and resolves mode 2 to
`dezaemon.deathChild`, and the 2028-ai runtime implements every mode. Because a
child record is often never PLACED, the roster now includes the transitive
closure of mode-2 children so those enemies exist to be spawned.

**Change-channel triggers** (the C byte's bits 0–2 of each of the record's
four channels) resolve through `+0x4C8C` to a scroll-axis threshold: mode 0
= run from spawn, modes 1/2/3 = arm at `0x1F00`/`0x3800`/`0x5200` = **62 /
112 / 164 px** into the 224-px playfield (a per-enemy signed byte from
`+0x22044` shifts that by up to ±16 px), modes 4–7 = never arm (the
resolver returns 0). An **air** enemy arms when its scroll coordinate has
reached the threshold, a **ground** one when it has fallen back past it;
ground records additionally have modes 0 and 4 swapped at spawn
(`+0x15CD4`), which is why the editor's default reads the same for both —
and why the corpus shows air channels piled on mode 0 and ground channels
on mode 4. Arming re-seeds the channel from the start of its ramp.

A channel that reaches a scale of ×0 or ×4, or a direction value of 0,
**silently removes the object** (`+0x632A` — no explosion, no score), and
the per-enemy status word's bit15 (set while the scale is off unity or the
direction channel is exhausted) makes the object neither fire nor collide
that tick.

**Song playback: FULLY TRACED — timing has no calibrated constants.** BGM
sequencing is not in the 68000 driver at all — 0KERNEL walks a playing song
itself, and the whole timing chain is now engine-exact:

  - Every game overlay calls the kernel end-of-frame service (`0x6004850` /
    `0x60048b4`, GAME.BIN calls it from 27 sites), which runs the sound pump
    `0x6006ADC` once per frame (60 Hz). The pump, gated on the mailbox-ready
    bit (`0x25A004E0` bit 7, cleared by the driver within one spin of its
    main loop), runs the sequencer tick `0x6005DB8` and flushes the command
    queue `0x6041C00` -> `0x25A00700`.
  - The tick ends in a **step divider** (`+0x625e`): a word accumulator at
    `0x601F3FE` gains **+4 per frame**; when it reaches the song's divisor it
    subtracts it (keeping the remainder — phase-exact) and re-arms the
    walker, which the note sender disarms after every step. The divisor is
    **`TEMPO_TABLE[header byte 3]`** — the kernel table at `0x601F3A8` (file
    `+0x1B3A8`): `42 3C 39 36 34 31 2F 2D 2B 2A 28 27 26 24 23 22 21 20 1F
    1E 1D 1C 1B 1A 19 18 17 16 15 14 13 12`. So
    **`stepSeconds = divisor / 240`**, and with 4 steps per beat the 32
    editor tempo positions run 54.5-200 BPM (`BPM = 3600 / divisor`).
  - The walker (`+0x1bfc`) advances ONE cursor position 0..15 per armed
    step: a measure is **16 steps**, and per part it reads byte
    `[8 + part*32 + cursor]` AND byte `[24 + part*32 + cursor]`. Those are
    two COLUMNS of the same 16 steps, and the note sender (`+0x15bc`) says
    what each one is:
      - **bytes 0-15 = the voice column.** `0` rests (the sender writes gate
        `0x40`, key off); **bit 7 set = tie** (gate `0x10`, and the pitch
        register is left untouched); any other value is a note **onset**
        whose value picks the instrument — it is forwarded on the companion
        channel bank 4-7 as command 4.
      - **bytes 16-31 = the pitch column**, stored to the per-part note
        register `0x601F418` on each onset (`+0x36` is a constant bank
        offset, so it does not change relative pitch). The composer repeats
        the pitch byte on every held step; the driver ignores it there.

    The save data confirms this over Ramsie's 14 songs: a tie always has a
    pitch byte beside it (6427/6427) and that pitch is the identical value
    6401/6427 times; the voice column carries only a handful of distinct
    values per part (Ramsie's stage-0 song uses three across the whole
    piece) while the pitch column lands on a diatonic scale with five
    near-empty pitch classes. Reading the two columns as two melodic voices
    plays an instrument-select column as a tune and re-strikes every held
    note once per step.
  - byte 0 = **loop-start measure** (on wrap the measure cursor rewinds
    here, `+0x1d6e`) — byte 1 = **loop-end measure** (compared at `+0x1d56`)
  - byte 2 = **echo send 0-7**: stored at `0x601F3E0` with a dirty flag
    (`0x6005498`); on change the tick emits driver command 0x88 with
    **`(echo << 5) | 0x1F`**, which the driver (`LOG_SND +0x218c`, via the
    0x80-0x90 jump table at `+0x1b96`) writes to SCSP slot 16/17 register
    `+0x17` — **EFSDL|EFPAN**, the effect/reverb send of the BGM output
    pair. (Driver cmds 0x80/0x81 split the same byte hi-3/lo-5; 0x82 is
    master volume, MVOL at `$401(a5)`.)
  - measure control byte 3 = **accompaniment transpose**: indexes the
    signed semitone table at `0x601F3C8` (`-3 -2 -1 0 +1 +2 +3 +4 +5 +6 -5
    -4`). The sender adds it (`+0x16fc`) only to the seven auto-accompaniment
    channels the measure selects out of the kernel pattern table at
    `0x601F490` (row = `ctrl0*140 + (ctrl1*5 + (ctrl2&0x7F)>>1)*7 + channel`,
    16 bytes per row = the measure's 16 steps) — never to the four composed
    parts. The editor default control `00 00 80 03` selects pattern row 0
    and entry 3 = no transpose. **The accompaniment patterns live in kernel
    ROM, not in the save**, so a save that uses them carries music the
    importer does not yet reproduce; extracting `0x601F490` (kernel file
    `+0x1B490`) would add that track.

(The 68000 driver's own timers, for completeness: TIMA reload 0x4E = 247.75
Hz main-loop tick driving envelope/portamento engines at `+0x2704`/`+0x1562`;
TIMB reload 0x1D4 = 501 Hz on interrupt level 2 for mixing. Neither paces
the sequencer — the 60 Hz frame pump does.)

The runtime plays exactly this: 16-step measures, one voice per part taking
its pitch from the pitch column and holding it through ties,
`stepSeconds = divisor/240`, loop points (pass 0 from the top, later passes
rewind to loop-start), and the echo send approximated as a feedback-delay
tap scaled by `header[2]/7`. The two missing halves are now EXTRACTED
(2026-08-28) though not yet played: the kernel ROM accompaniment pattern
table (0KERNEL `+0x1B490`, 1260 rows × 16 steps; row = `ctrl0*140 +
(ctrl1*5 + ((ctrl2&0x7F)>>1))*7 + channel` — the `>>1` binds to ctrl2 only)
ships in `data/bgm-accompaniment.json`, and the 116-instrument tone bank map
(sample offsets into SNDPAC.BIN, loops, root pitch, envelopes — traced
through the 68000 driver's instrument-select command) in
`data/bgm-instruments.json`.

**The tone bank is now cut and played** (`src/audio/tone-bank.js`, packed table
in `src/audio/tone-bank-table.js`). SNDPAC.BIN is disc content and is not in
this repo; `src/cd/iso9660-read.js` pulls it out of a disc image the caller
supplies. Two facts settled by measurement against the retail bank:
**format 16 is signed BIG-endian 16-bit** (mean absolute first difference is
4-8x smaller than the little-endian reading on every tonal slice) and format 8
is signed 8-bit; and **every one of the 590 layers loops to its LAST sample** —
`loopEnd == lengthSamples - 1` without exception, so a loop is always the tail
`[loopStart, lengthSamples)`. The SCSP's reverse (LPCTL 2, 34 layers) and
alternating (LPCTL 3, 37 layers) modes are baked into the PCM at cut time, so
consumers only implement a forward loop. The 590 layers share 85 distinct
cuts. A note-on strikes EVERY layer whose range contains the note, which is
what makes the detune pairs chorus.

The bank's **base rate — the rate a sample plays at when it is sounding its own
`rootPitch` — measures 14,842 Hz, not 44,100.** A looped instrument sample
loops on a period boundary, so for base rate R the cycle count
`k = loopLength * 440 * 2^((rootPitch - 88)/12) / R` must be integral for every
layer (88 being the scale note that sounds concert A, the anchor the runtime's
BGM already uses). Fitting R over the bank's 34 distinct short loops puts 31 of
them within 2% of a whole cycle count with unbiased residuals; 44,100 fits
ZERO of 34 and would play every sampled note ~18.9 semitones sharp of the
periodic-wave voices. The shortest loops come out at exactly one cycle, which
pins the octave the fit is otherwise blind to. `SCSP_BASE_RATE` ships as
14,848 (29*512, within 0.04% of the fit); rendering the same instrument both
ways in an OfflineAudioContext then agrees to within one 1/48-octave analysis
bin. This is a calibration of the bank against the sequencer's note scale, not
a claim about the SCSP's DAC clock.

**Zako firing, re-traced 2026-08-24** (fire routine `+0x19810`, dispatcher
`+0x1989e`, shooter `+0x18fac`, spawn fill `+0x1548e`; supersedes the earlier
"band near the top" reading — those clamps at `+0x1985e` are on-screen X/Y
tests in the 320-wide grid space, so an enemy may fire anywhere visible):

- **`b5 & 0xF` picks a bullet-GEOMETRY function** from the 16-pointer table
  at `0x6086074` — ALL 16 traced (2026-08-28, verified; angle deltas in
  1/256-circle units, every shot same origin and speed): **0** = empty (the
  enemy never fires — most of a stage's roster); **1/10** = single; **2** =
  ±8 pair; **3** = 0,±8; **4** = 0,±16; **5** = ±8,±24 (no center); **6** =
  0,±8,±16; **7** = 0,±16,±32; **8** = the same 5-fan with bullet state 19 +
  a stored steer target (curving shots); **9** = single with homing state
  (18 aimed / 17 facing); **11** = single, jitter `(rand&31)−16`; **12** =
  single stepping the `+0x22064` spiral table; **13** = ±64 perpendicular
  pair; **14** = 0,±64,128 cross; **15** = 8-way star (0,±32,±64,±96,128).
  This same table serves the BOSS fire-point "shot function" (executor
  `+0x19FF4`; boss nibbles 9/10/11 route to boss burst handlers instead).
  **`b5 & 0x10` aims the volley at the player** (octant-folded atan2 via
  `+0x183d0`, re-computed EVERY volley so bursts track a moving player;
  suppressed within a (size+36) px point-blank box of the player); without
  it the shot leaves along the enemy's heading (`0x6094440`, 8.8 word),
  seeded by the spawn walker from the movement direction. See "Axes and
  angles" below for the velocity convention.
- **Fire cadence is a global RANK-driven pulse**: a per-frame accumulator
  `u16[0x6091E28] += 28 + rank/2` emits one fire tick on overflow past 255
  (~10 frames apart at rank 0, 2 at rank 255; tick flag `u8[0x6092024]`).
  Reload counters decrement and bursts advance only on fire ticks (pattern
  12's mid-burst shots excepted — every serviced frame). Off-screen and
  gate-suppressed ticks still decrement the reload (the gates branch to the
  fire routine's tail); only nibble 0 bypasses it. An extra per-slot
  suppress bit gates firing: `u16[0x6093C50] & 0x8000` set = no fire.
- **Rank** — two variables, both fully traced (2026-08-28, adversarially
  corrected). Static rank `u8[0x0608C712]` is the OPTION-menu difficulty
  LEVEL (EASY/NORMAL/HARD/MANIAC = 0..3, default 1; pad-edited in the
  option screen `+0x1F01A`/`+0x1F0A2`); it scales zako movement speed
  (×2/3 on EASY, ×1.5 at HARD+ — the old "rank 6" second ×1.5 is really
  play-state flags `0x060840C8 & 6 == 6`, the harder loop) and picks the
  dynamic system's rate tables. Dynamic level
  `u8[0x06090A2E]` ramps toward `target = [8,32,80,64][R] + 4*power +
  8*stage` (+1 per 256/[1,2,6,4][R] frames up, −1 per 256/[32,16,8,12][R]
  down, `+0x4AD8`/`+0x3728`); player death resets it to `8*stage +
  [2,8,20,16][R]` — dying lowers the difficulty. Consumers: the enemy bullet
  speed base `u16[0x608EF30] = dyn*4` and the fire-tick rate `28 + dyn/2`.
- **`b4 & 3` is the BULLET TYPE**, selecting one of the save's four global
  bullet configs (settings bytes +37..+40; bullet speed = live base
  `u16[0x608ef30]` + `[128,256,512,896][(cfg>>4)&3]`). It is not a "fire
  mode".
- **Intervals split by bullet type**: types 0-2 load `u8` intervals from
  `0x6085f70` = [14,12,10,8,6,4,2,1]; type 3 from `0x6085f80` (or `0x6085f90`
  when a mode global equals 3) = [119,59,29,19,9,5,3,1]; all tables are u16be
  with the value in the low byte, indexed by `(b4>>4)&7`, randomization
  window from `0x6085f60` = [29,22,16,11,7,4,2,1]. Reload (u8, `0x6090830`)
  = interval + rand % window, refilled at each shot, decremented inside the
  enemy's AI slice — the walker services the pool in segments, so wall-clock
  cadence runs several display frames per decrement (the runtime calibrates
  this stride against capture footage).
- The appearance gate stands: bit 4 of the definition word (u16 at +8 via
  the 256-entry pointer table at `0x6088e5c`, cached per enemy at spawn)
  still silences 48 of 256 appearances (`APPEARANCE_NOFIRE`, byte-exact).
- Rotation channel modes 3/4 ("engine-special") are aim-style: the sprite
  tracks the player rather than spinning, and its facing carries into
  facing-relative shots.

**Durability shares one unit space with damage — and the player-weapon
damage tables are traced.** Objects live in one pool; enemy LIFE decodes in
damage units ([60,30,15,10,5,3,2,1]). The player's normal shot carries its
damage in the same slot zako keep hp in (0x6090630): the spawn at GAME.CMP
`+0x10bbe` writes it from the five-entry power-level table at `+0x6085e14` =
**[9, 12, 15, 18, 21]** (its bullets score nothing — 0x6093e50/0x6095040 are
set to 0x7FFFFFFF at the same spawn). A full-power main shot is therefore 21
units, and max-LIFE zako die in ceil(60/21) = 3 hits, which is what the
importer's `ENGINE_SHOT_DAMAGE` now uses.

Big/pierce shots use a different channel: their power rides in the SCALE
slot (0x6095930/0x6091a30 — a big shot is literally as strong as it is
large), drained by each enemy's hp as it pierces (`+0xb8ec`:
`scale -= enemyHp`). The three per-level tables alongside the normal shot's
belong to the SUB-weapons (see the sub-weapon dispatcher under "Settings
byte map"): `+0x6085e6c` = [16,18,20,22,24] (read `+0x14692`), `+0x6085ebc`
= [8,14,20,26,32] (read `+0x14a50`), `+0x6085edc` = [48,60,72,84,96] (read
`+0x14dce`); `+0x6085ea8` holds player-bullet speeds [0x600..0xc00] =
6/8/10/12 px/frame by level.
The engine negates a channel's step when start > end, and rotation mode 2
negates it again (counter-clockwise). Cross-checks: the factory-default game
(SGM_INIT = Gust) decodes to hp 1 / score 50 everywhere — the editor's
defaults — and DAIOH's turret rows decode to hp 60 ground objects with aimed
fire, matching how it plays. Decoder: `lib/decode/decode-enemy.js`.

The old statistical profile (96.5% of nibbles ≤ 8 across 6799 records;
per-byte cardinalities 200, 108, 138, 68, 94, 79, 16, 65, 14, 40, 51, 14, 33,
77, 12, 16, 72, 15) matches this layout exactly — the "12-16 distinct" columns
are the channel A/C bytes.

**Settings byte map** (`+0x5A780`, 96 B):

| Offset | Content |
|--------|---------|
| `+0x00` | **game mode** — **decoded** (2026-08-28, verified): bit0 = scroll orientation (0 vertical, 1 horizontal), bit1 = player count (0 = 1P, 1 = 2P join-in). The engine reads the block IN PLACE through the pointer global `u32[0x060840C0] = 0x0029A780` (initialized data at GAME file `+0x200C0` — there is no copy, which is why literal scans found no readers). The world sim is orientation-INVARIANT: the same tilemap/placement/scroll-curve code runs both modes (1 grid row per 16 px of scroll); horizontal games differ in presentation (screen x = right-to-left scroll axis), input mapping, spawn edges, clamps, a ×365/256 scroll factor, and ALSO (2026-08-28): hitbox extents (the shot spawners swap the pair), the size-class tables `+0x22044/4C/54/5C`, the appearance/trigger bound bases (`+0x4C8C` returns 14/48/116 px instead of 62/112/164), the boss preset tables (two blocks are horizontal-only), and the scroll-axis window, which runs **[-96, 224] px** instead of [0, 224] — 96 px wider, all of it at the entry edge. Horizontal art is authored pre-rotated for the PLAYER, its shots and grid-spawned zako (facing forced 0 in both modes), but enemy bullets, several effects and the power-up items ARE given +90° in horizontal. |
| `+0x01` | **HUD dressing**: bits4-6 frame-graphic select (7 VDP2 tile sets via kernel `0x0600516C`), bits0-2 HUD palette select (kernel `0x06005138`) |
| `+0x02`–`+0x0B` | **per-stage flag bytes** (10 stages): bit0 CLEAR = the row starts a NEW numbered stage; bit0 SET = continuation part — the stage number holds and the BGM carries over (`+0x9C4`; polarity adversarially verified against MIYA/DAIOH/RAMS); bit6 = keep the scroll position on player death (`+0x121A`); bit7 = **the final stage** (the game ends after it, `+0xC2C`); bit5 editor-edited, consumer unfound |
| `+0x0C`–`+0x0F`, `+0x10`–`+0x13` | the two player-ship config blocks (P1/P2) — **decoded** (2026-08-28, verified; REPLACES the earlier "byte +3 low nibble = main weapon" heuristic, which was actually the autofire rate): byte +0 = `0x10 \| startingLoadout` (engine reads only &3); byte +1 = maxSpeedLevel<<4 \| rapid-fire param (manual fire interval = 8−v frames); byte +2 = maxPowerLevel<<4 \| initialPowerLevel (≤4; the power level indexes per-weapon per-level tables); byte +3 low nibble = **autofire rate index** → `[60,30,15,10,5,3,2,1]` frames/volley (`+0x21EE8`), high nibble 0-3 open. Loaded at player init `+0x90EC` into per-player globals. |
| `+0x14`–`+0x1B` | the four **WEAPON LOADOUT presets** (2 B each) — **decoded**: byte0 bits0-2 = MAIN weapon 0-7 (autofire dispatcher `+0x15128`: 0→none, 1→`+0xf498` … 7→`+0x11ea8`; per-level u32 damage tables, e.g. weapon 1 `+0x21D6C` = [13312..5120] per bullet — per-bullet damage FALLS as the level rises while projectile count grows; enemy LIFE stores as LIFE<<8, so a max-LIFE zako = 15360 units = 3 full-power weapon-1 hits), bits4-6 = SUB weapon 0-7 (dispatcher `+0x1509C` = `0x0607909C`, jump table `+0x150C4`) — **there are NO option pods** (2026-08-28): every handler spawns a transient bullet from the player's own slot window, nothing tracks the ship, so this is simply a second shot type. Max shots per tap `+0x21C50` = `[0,3,3,1,1,6,3,2]`, reload interval `+0x21C58` = `[0,6,5,12,1,3,6,28]`, drained 1/frame — the extra `power+3` drain sits INSIDE the `type == 7` branch (`+0xDD4C` returns to the epilogue otherwise), so types 1-6 fire at the RAW interval independent of power (6/5/12/1/3/6 frames) and only type 7 scales (`ceil(28/(L+3))` = 10/7/6/5/4). NOTE the main/sub labels may be swapped: the bits4-6 weapon is the one sharing the A button with the charge gauge; byte1 bits0-1 = CHARGE type 0-3 (dispatcher `+0x1528C` = `0x0607928C`; gauge +1/frame while held, cap 320, **never decays**, level = `gauge>>6 - 1` so level 0 is a real shot and only level -1 is a no-op; the gauge is zeroed when the ATTACK ends, not at release — busy counters 16/96/160 frames by type; a gauge above 31 SUPPRESSES the sub weapon — the tables `+0x6085EA8/EBC/EC8/EDC` earlier labeled "sub-weapon" belong HERE; gauge 0-320, level = gauge/64−1), bits4-7 = BOMB type + variant flag (16-way dispatcher `+0x151B0` = `0x060791B0`; the table is the low 8 entries duplicated except index 6/14, so bit3 only re-routes base type 6 and adds a 16.875°/frame spin to types 4 and 5. Eight behaviours as object classes 68-75; per-type attack powers `[4096,5632,6144,4608,10240,3584,3584,512]` into the damage word `u32[0x608C720]`; no INSTANT screen-clear — bombs are big piercing contact objects, though type 1 grows to a 344 px radius (wider than the playfield) over ~53 frames and drives a real full-screen flash). The ship byte +0 picks the STARTING loadout; weapon-change items (types 0-3) switch loadouts mid-game. The old `+0x6085E14` "charge damage [9,12,15,18,21]" claim is refuted — that table holds `[0x900..0x1500]` charge-pellet lifetime words. |
| `+0x1C`–`+0x23` | the 8 **item slots** — **decoded** (2026-08-28, verified): byte = `movement<<4 \| itemType`. Types (effect table `+0x25ACC`): 0-3 = weapon change to loadout preset 0-3, 4 = barrier (persists across respawns), 5 = bomb stock +1 (cap 99), 6 = score bonus, 7 = power-up (+1 shot level, capped by ship byte +2 high nibble), 8 = speed-up (+1, capped by ship byte +1 high nibble). Movement: 0 = launch-and-drift (6 px/f spin-launch, decay v−=v/8, then drift backward; uncollectible during the launch phase), 1 = bouncer (15 frames still, then 45°+k·90° diagonals at ~0.79 px/f per axis, bouncing off the playfield, blink-out after 1024 frames), 2 = scroll-anchored (rides the background). Placement ids 0xE8-0xEF spawn slot id&7; an enemy death-word `(w & 0x300)==0x100` drops item `w&0xFF` (1-8 = slot, 9 = cycling). |
| `+0x24` | **score-item value index** into the boss score table `[5000..1000000]` (`+0x21F00`) — one game-wide value for every type-6 item |
| `+0x25`–`+0x27` | the **3 global bullet configs** — **decoded** (2026-08-28, verified): read LIVE via the settings pointer `u32[0x060840C0]` (shooter `+0x19002` adds `0x25 + (record b4&3)`, so **b4&3 == 3 aliases the blast byte** — an engine quirk). Bits 0-2 = bullet **damage** index into u8 `[60,30,15,10,5,3,2,1]` (`+0x21EE8` — the shared durability units); bits 4-5 = **speed add** index into u16 `[128,256,512,896]` (`+0x220B4`); bit 7 = an editor checkbox stored per bullet (`cfg&0x80`, no traced play effect); bits 3/6 never set in the corpus. Bullet speed = `u16[0x608EF30] + add` where the base has exactly one writer: `rank<<2` (see rank below); velocity = `(speed × sin1.15) >> 16` added raw into **24.8** positions (256 units = 1 px), so px/frame = speed/512 — the four adds alone are 0.25/0.5/1.0/1.75 px/f. Bullet sprites: types 0/1/2 draw composition slots 55/59/63 with a 4-frame anim. Decoder: `lib/decode/decode-settings.js` (`bullets`). |
| `+0x28` | **blast byte**: bits 0-2 / bits 4-6 = explosion anim A/B **tick-hold** index into u8 `[8,7,6,5,4,3,2,1]` (`+0x25A98`; spawners `+0x1C104`/`+0x1C1F0`, appearances 43/49) |
| `+0x2D`–`+0x40` | **per-stage scroll extents** — **decoded** (2026-08-28): one (loop-start, end) byte pair per stage in **parts of 256 px** (16 map rows), read via `u32[0x060840C0]+0x2D/0x2E+2×stage`. Normal play STOPS the scroll one hardware screen short of `end<<8` (lookahead 256 px vertical / 320 horizontal, flag `0x06090A2A`); a boss fight (`u8[0x06084158]`) or game modes ≥ 2 **LOOP the background** from `end<<8` back to `loop<<8` preserving the 16-px row phase. This is why the values are always even ≤ 48. Decoder: `decode-settings.js` (`stageExtents`). |
| `+0x41`–`+0x58` | **BGM assignment table**: 24 entries, every value ≤ 23 in every game, indexing sec6's 24 song slots. Three special tracks first, then (main, boss) pairs per stage — DAIOH reads `12,11,13, 1,6, 2,7, 3,8, 4,9, 5,10`. No entry ever points at an empty song slot. |
| `+0x59` | **SFX set**: 1, 2 or 3 = the editor's REAL / COMIC / SF banks |
| `+0x5A`–`+0x5C` | **staff-roll role labels** — **decoded** (2026-08-28): three indices into the engine's fixed 16-label list (`+0x20164`: blank, PLANNING, PRODUCE, SFX PLAY, ENEMY DESIGN, MAP DESIGN, CHARACTER DESIGN, TITLE LOGO, 2D GRAPHIC, 3D GRAPHIC, DEBUG, SPECIAL THANKS, PRESENTED BY, GRAPHIC, MUSIC, THANKS), paired with the six drawn 64×16 credit strips (global bank refs 208-231) at the ending. The GameFAQs-derived "15-slot entrance effect sequencer" does not exist — the title has one fixed sway-in; this label picker is the 15-choice title-page feature. |

Background-map occupancy recovers each game's stage count, cross-checked by
the disc's per-stage `DEMO_?N.BIN` recordings: Ramsie 5 stages (31/29/46/32/12
parts used), Gust 6, DAIOH 5 + a 12-part stage 6, Devil Blade 2 up to 10.

### Boss record — the 0x40 trailer (decoded 2026-08-22)

The `0x40` trailer after each stage's 60 enemy records IS the boss record.
Traced from GAME.CMP's boss routines — spawn init `+0x1AC20`, pattern
activation `+0x1A878`, HP-stage advance `+0x1ABD4`, per-frame dispatcher
`+0x1BDCC`, death init `+0x1B330`, fire executor `+0x19FF4` (GAME.bin file
offsets; the engine reaches the trailer through the pointer global
`0x0609890C`) — and cross-checked against KUMITATE's boss editor (file
`+0x10F00`–`+0x14B00`), whose field writers confirm every mask. Decoder:
`lib/decode/decode-boss.js`.

| Byte | Field |
|------|-------|
| 0 | bits0-1 core **size class** (placement id `0xF0`–`0xF3`); bits4-5 **HP-stage count** − 1; bit6 rotate-in-place; bit7 death-FX spin variant |
| 1 | bits0-2 **hp** index → u32 `[1024000, 1536000, 2304000, 3328000, 4608000, 6144000, 7936000, 9984000]` (`+0x21F40`); bit3 option flag, stored **inverted** by the editor; bits4-6 **score** index → `[5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000]` (`+0x21F00`) |
| 2–5 | **pattern playlist**: byte 2+k = HP stage k's loop of four 2-bit pattern ids, consumed LSB-first. HP stages split the HP bar into equal bands; a band change advances to the next byte — the editor's "16-entry phase loop" is these 4 bytes × 4 entries |
| 6 / 7 | **arrival / death** selectors — **decoded** (2026-08-28; 60% of the corpus's 1,396 bosses author a position and 40% the flourishes). High nibble picks the off-screen START point (byte 6) / the death-drift TARGET (byte 7) out of two 4-entry preset tables per orientation, in the engine's 320×224 px space: vertical-mode arrival lateral `[160,-16,160,336]` (bit6 gates it) and scroll `[56,280,56,-56]` (bits 4∨6 gate it, else the **default entry**: start just off the top and ride in at the scroll speed); vertical-mode death lateral `[160,336,160,-16]` (bit6) and scroll `[56,-56,56,280]` (bit4), with neither set meaning "die where it stands". Entry 0 of each table is the park anchor — lateral 160 = centre, scroll 56. The size class nudges the entry's scroll coordinate by `[0,0,32,32]`. Low nibble = FX, the same pair on both bytes: **bit0 = ZOOM** (scale register `0x06094A40`, neutral `0x1000`) with bit1 its direction, **bit2 = SPIN** (rotation register `0x06094440`) with bit3 its direction. Both entrance flourishes run exactly **256 frames** — the same length as the entry glide, by design: the zoom rides 4.0×→1.0× at −48/frame or 0→1.0× at +16/frame, and the spin turns eight full revolutions with its rate ramping from 22.5°/frame down to nothing, landing upright. On death the scale rate is CONSTANT (+24 grow / −16 shrink) while the spin rate ACCELERATES by 16/frame and never settles; record byte0 bit7 is a 159-frame hold plus a 64-frame **fade-out**, not a second spin channel. The shared approach primitive `+0x1A6B4` sets a CONSTANT velocity of `distance·k/256` px/frame (k = 1 on arrival, 4 on a fast return, ½ on the death glide, floored at 0.5), so a glide takes ~256 frames whatever the distance. |
| 8–63 | 4 **pattern records** × 14 B |

Pattern record: byte +0 bits3-7 = **movement script** 0–31, bits0-2 =
speed; byte +1 bits0-2 = **fire-tick divider** → frames per fire tick
`[60,30,15,10,5,3,2,1]` (`+0x21EE8`); then 3 **fire points** of
`[dx.s8, dy.s8, rate<<4|type, param]`, dx/dy (s8, px) relative to the boss
centre.

**The 32 movement scripts are DECODED** (2026-08-28, adversarially verified;
extracted byte-exact to `lib/../data/boss-move-scripts.json`): script data at
`+0x252D4`–`+0x25A18`, pointer table `+0x25A18`, interpreted by `+0x1A2A4`
(the same interpreter drives zako appearance movement). A script is a list of
10-byte steps `{u16 dur, u16 heading, s16 turnRate, s16 speed, u16 flags}`;
`flags&3 == 0` terminates — **and the playlist advances to its next pattern
when the script ends**, snapping the boss back to its park anchor (a
pattern's length IS its script's length). The speed setting (byte +0 bits0-2)
picks factor `f` from `[1,2,3,4,6,8,10,14]` (`+0x2525C`): `counter = dur/f`,
`velocity = speed·f` (px/f = value/256), `turn/frame = turnRate·f/2` — so the
path SHAPE is speed-invariant (distance = speed·dur/256 px, total turn =
turnRate·dur/2 units of 65536/circle). Headings follow the engine-wide
convention (see "Axes and angles"): **0 = right, 0x4000 = up, 0x8000 = left,
0xC000 = down** — so scripts 1/2 are horizontal bobs and 3/4 vertical sways,
9/11 true circles (30×30 and 59×59 px), 22–27 mirror pairs, and the
live-tracking scripts 29–31 advance 160 px straight DOWN at the player. All
32 simulate to their analytic duration / path length / total turn.
Track flags: 0x20 = evade the player on X at speed/2, 0x40 = chase the
player's Y, 0x800 = aim-tracking heading (re-target every 8-23 frames, turn
448 units/frame); scripts 29-31 end with live-tracking terminators that skip
the park snap. The 32 shapes run from "sit still" (0) and vertical bobs (1-2)
through S-curves, loops, box weaves and cloverleafs to the tracking scripts.
Fire point types:

| type | Meaning |
|------|---------|
| 0–2 | bullet weapon A/B/C — param bits0-3 = shot function 0–12 (pointer table `+0x22074`), bit4 = aimed at the player, bits5-7 = extra arg |
| 3 | **respawning mobile part** |
| 4 | **one-shot static part**/turret, spawned immediately on pattern activation |
| 5 / 6 | special attacks (**beam** / **flame**; period table `+0x21FA0`) |

Types 3/4 spawn a destructible object at (bossX+dx, bossY+dy) drawing its
art from param: bits4-6 = art group (0–3 = the four zako bands, 4–6 = the
64×32 / 32×64 / 64×64 bands), bits0-3 = piece; the engine's spriteIndex =
charSlot + 67.

Worked example — Ramsie stage 0 (trailer at sec5 `+0x5A7E0 + 0x438`): class
F2, hp 4,608,000, score 20,000, 4 HP stages, first-band playlist 0,0,1,1.
Pattern 0 spawns two one-shot turret parts with 32×32 art at (−32,+28) and
(+30,+28) and runs the type-5 beam at (0,−25); the 64×64 figure pieces only
appear in patterns 2/3 (HP ≤ 50%). The chamber goddess is background art —
there is no giant boss sprite, which is why the boss placement row "lands
exactly on the boss-chamber artwork" (see Placement ids above).

### Live LWRAM map (from SH-2 disassembly of 0KERNEL/S_OPT/GAME/KUMITATE)

Sections live contiguously at: sec0 `0x00200000`, sec1 `0x00210000`, sec2
`0x00220000`, sec3 `0x00230000`, sec5 `0x00240000`, sec4 `0x002A0D60`, sec6
`0x002A0F60`, sec7 `0x002B9BC0`, end `0x002BB284` (= base + 766,596; RAM
order sec0,1,2,3,5,4,6,7 — matching the SGM stream, which GAME.bin
decompresses straight to `0x00200000`). The LZSS decompressor core is at
`0x06004FF8` (kernel file +0xFF8; r4=src r5=dst r6=len), its `.CMP` wrapper
(u32LE compressed-size header) at `0x060050F8`; the compressor and the
save-image builder live in S_OPT.bin (staging `0x002C8A84`, 0x6C header =
{checksumSum, base, endPtr} + 8 × {byte-sum, absAddr, compSize}; save blocks
shown = (end−base+32)>>6). Editor overlays load to HWRAM `0x06064000` via 18
0x40-byte kernel loader stanzas (GAME's at kernel file `+0x5410`;
GAME/KUMITATE/S_OPT all target the same base — overlays swap); MDLDT models
decompress to scratch `0x002F0000`;
DEMO recordings load raw at `0x002FF000`; sec6 song pointer = songIdx ×
0x1084 + sec6 base (engine proof of the 24×4,228 grid); the play engine
fetches CG cells as cellIndex×256 from `0x00200000` into VDP1 VRAM.

Known editor facts to guide the sec5 field map (GameFAQs editor FAQ +
Dezaemon DB): up to 10 stages × 48 map screens with spatial enemy placement;
7 zako size classes (16×16 up to 128×128, 1–6 anim frames); 4 boss classes
with 4 patterns × 3 fire points and 16-entry phase loops (both now decoded —
see the bank layout and "Boss record" above); 3 global bullet
types + 2 blast anims; weapons 7 main / 7 sub / 7 bomb / 3 charge; 8 item
slots; titles are **drawn** (TITLE 1/2 tile compositions + 15-slot entrance
effect sequencer) — which is why no title text exists anywhere in the data.

Prior art: Madroms' **D2SGM / D2SGM2** save managers (satakore.com, source
released) — the Lemureal saves' `D2SGM2` comment is that tool's signature.

**Controlled-delta captures** localize fields to sections *without*
decompression (a one-field edit changes exactly that section's checksum).
Capture sequence (same game, one change, re-saved; diff with
`dev/diff-saves.js` or the harness report):

| Sample              | Change from previous          | Localizes        |
|---------------------|-------------------------------|------------------|
| `00_base`           | minimal game (1 sprite/enemy/stage) | baseline    |
| `01_sprite_1px`     | repaint one pixel of sprite 1 | CG section + bpp |
| `02_sprite_frame`   | add one animation frame       | frame stride / count |
| `03_palette`        | change one palette color      | palette table + BGR555 layout |
| `10_enemy_hp`       | enemy HP 1 → 99               | enemy struct + HP field |
| `11_enemy_sprite`   | re-point enemy to sprite 2    | enemy struct stride |
| `20_spawn_time`     | move first spawn 1 tick later | stage script time field |
| `21_spawn_x`        | move first spawn 8px in X     | stage script X field |
| `30_bullet_nway`    | 3-way → 5-way                 | bullet pattern way-count |
| `31_bullet_speed`   | change bullet speed           | bullet speed field |
| `40_bgm_note`       | change one note               | BGM sequence vs sample bank |
| `50_title`          | rename the in-game title      | title string location |

## Cross-check option (high-leverage)

Load a Mednafen savestate taken inside Dezaemon 2 into Ghidra (SH-2, with the
VGKintsugi Sega Saturn loader). Search for references to `0x002C8A84` /
`0x002C8AF0` — the function that builds the section table leads directly to
the per-section compress call, and its LOAD-path counterpart is the
decompressor. Tracing `BUP_Read` pointer arithmetic confirms the staging
layout without guesswork.
