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
| sec7    | **3D models** (ポリ吉): u32be magic `0x12345678` (absent = never opened the 3D editor; section then all-zero or residual RAM — ELFI's "custom" sec7 is just uninitialized garbage), then 16 model slots × 328 B (u16be part count 0–9, u16be model color, 9 part records × 36 B: u16 shape descriptor, s32be 16.16 X/Y/Z position, s16be rotations (65536=360°), s32be signed 16.16 scales, negative = mirror), then 576 residual bytes. POLYKITI.bin literal pools confirm (HWRAM working base `0x06097E90`, stride 0x148, end 0x1484). | confirmed |

### sec5 region map

Boundaries and strides come from explicit multiplications in KUMITATE/GAME
literal pools; they tile the 396,640 bytes exactly, with no gaps:

| Offset | Layout | Content | Status |
|--------|--------|---------|--------|
| `+0x00000` | 10 × `0x5400` | **Background tilemap** per stage: 14 cols × 768 rows of u16be = 48 parts × 16 rows. `0xFFFF` = empty; else bit15 V-flip, bit14 H-flip (same convention as the sprite banks), bits 0–9 = CG cell index (1024-cell space). Part = 224×256 px. | **decoded** |
| `+0x34800` | 10 × `0xC0` | **Per-stage scroll curve**: 192 bytes, one per 4 map rows (64 px of scroll). Values move in long runs and ramp down through the stage; the non-zero extent tracks the stage's used rows (`lastNonZero ≈ lastUsedRow/4`, always slightly short of it). Not a record array — no stride shows column specialisation. | decoded (shape), field meaning open |
| `+0x34F80` | 10 × `0x3C00` | **Object placement grid**: 20 columns × 768 rows of *bytes* over the 320-px screen (the 224-px playfield sits at columns 3–16), sharing the background's rows and 48-part division. See the id table below. | **decoded** |
| `+0x5A780` | `0x60` | **Global settings** — see the byte map below | mostly decoded |
| `+0x5A7E0` | 10 × `0x478` | **Per-stage enemy definitions**: 60 records × 18 B (`0x438`) + the `0x40` **boss record** trailer. Record N defines the Nth zako id — see "Enemy record" and "Boss record" below. | **decoded** |
| `+0x5D490` | `0x1D0` | **Global sprite composition bank**: 232 u16be cell refs (player ship frames, bullets, item icons, explosions, the drawn title logo, credit glyphs) | decoded (structure) |
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
| 0 | appearance id: full byte indexes a 256-entry pointer table (`+0x6088e5c`) of sprite/animation definitions; `b0>>3` also classifies (a `>3` query helper exists) |
| 1 | bits0-2 **hp** index → `[60,30,15,10,5,3,2,1]` (`+0x6085ee8`; index 0 = toughest, 7 = the editor default); bits4-6 **score** index → `[50,100,200,500,1000,2000,5000,10000]` (`+0x6085ef0`); bit7 **ground** flag |
| 2 | bits0-2 **speed** index → u32 `[256,12800,…,512000]` (`+0x6085f20`, 16.16 px/frame, ×1.5 at rank ≥2 and again at rank 6); bit3+bits4-5 **movement pattern** (0-7, `((b2>>4)&3)\|((b2&8)>>1)`); bits6-7 **fire type** |
| 3 | fire params (type 1: bits0-2 count−1, bit3 wide; other types OR raw) |
| 4 | bits0-1 fire mode; bits4-6 **fire rate** index → interval `[119,59,29,19,9,5,3,1]` (`+0x6085f81`; mode 3 uses `[119,59,39,19,11,7,3,1]`) + randomization window `[29,22,16,11,7,4,2,1]` (`+0x6085f61`) — reload = interval + rand(window) |
| 5 | bits0-4 fire direction (0 = default/aimed), bits5-7 extra (passed to the shooter at `+0x607cfac`) |
| 6-8 | **speed-change channel** (enable `b6&1`) — values `[0,4,8,12,16,24,32,48,64]`/16 = ×0..×4 (`+0x6086004`), steps `[16..1024]`/256 (`+0x608600e`) |
| 9-11 | **rotation channel** (mode `b9&7`: 0 off, 1 cw, 2 ccw, 3/4 engine-special) — angles `[0,32,…,224]` of the 256-circle (`+0x6085fec`), steps `[16..2048]`/256 (`+0x6085ff4`) |
| 12-14 | **scale channel** (mode `b12&3`: 0 off, 1 XY, 2 X, 3 Y) — values ×0..×4 (`+0x6085fd0`, 16 = ×1.0, the spawn default `0x1000` = 16<<8), steps `[16..1024]`/256 (`+0x6085fda`); `b14` bits4-5 repeat X, bits2-3 repeat Y |
| 15-17 | **direction channel** (enable `b15&1`) — movement angles `[0,16,…,128]` (`+0x6086020`; default 0x80 = 128 = straight down), steps `[128..32767]`/256 (`+0x608602a`) |

Channel byte layout (A,B,C): A bits4-6 step index; B low/high nibble start/end
value index (rotation: 3-bit); C bits4-5 repeat (0 once, 1 loop, 2 ping-pong),
bits0-2 a trigger mode packed into a per-enemy status word (semantics open).

**Byte 5 is dual-use: pattern selector AND angle.** The fire dispatcher
(`+0x1989e`) masks `b5 & 0xF` and routes 10/11/12 to three special pattern
handlers (`+0x193d0` / `+0x19538` / `+0x196a8` — three variants of one
routine; which shape each draws is still open). Every other value falls
through to the default handler (`+0x192d4`), which passes `b5 & 0x1F` as the
angle argument to the kernel's shot-spawn helper (`0x6010be6`) alongside the
object's current heading. So 10-12 are patterns, not directions — 765 of the
12,153 enemies measured across 60 community saves (6.3%) carry one, and
reading them as angles pointed those enemies sideways.

**Movement is a 2-bit mode plus a flag, not an 8-way enum.** The spawn packs
`b2` bits 4-5 and bit 3 into one byte at `0x6091550`
(`((b2>>4)&3) | (bit3 ? 4 : 0)`), and the engine reads that byte BITWISE
across its 56 read sites: masks `0x1` (17x), `0x4` (13x), `0x3` (12x), `0x2`
(2x), `0x8` (1x). Mode 3 never occurs in the corpus. `decode-enemy.js` now
exposes `move: {mode, flag}` alongside the packed `movePattern`.

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
tap scaled by `header[2]/7`. Not reproduced: the ROM accompaniment patterns
and the instrument column's timbres (the Saturn's samples are not in the
save, so each part keeps a fixed synth voice).

**Zako firing, re-traced 2026-08-24** (fire routine `+0x19810`, dispatcher
`+0x1989e`, shooter `+0x18fac`, spawn fill `+0x1548e`; supersedes the earlier
"band near the top" reading — those clamps at `+0x1985e` are on-screen X/Y
tests in the 320-wide grid space, so an enemy may fire anywhere visible):

- **`b5 & 0xF` picks a bullet-GEOMETRY function** from the 16-pointer table
  at `0x6086074`: **0 is an empty routine — the enemy never fires** (most of
  a stage's roster); 1 = single shot, 2 = side-by-side pair (±8px), 5 = a
  three-shot fan (±8 angle units), 13 = a perpendicular pair (±64 units);
  10/11/12 route to the three special handlers (`+0x193d0`/`+0x19538`/
  `+0x196a8`, still untraced). **`b5 & 0x10` aims the volley at the player**
  (angle computed at fire time via `+0x183d0`); without it the shot leaves
  relative to the enemy's facing (`0x6094440`), straight down for a standard
  zako.
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
| `+0x00` | game mode, values 0–3 (2 bits; scroll orientation + player count candidates) |
| `+0x0C`–`+0x0F`, `+0x10`–`+0x13` | the two player-ship config blocks (P1/P2). Byte +0: always `0x10`/`0x11` (two-value item, open). Byte +1: two packed enums (open). Byte +2: KUMITATE-edited pair (`0x40/0x41/0x44` observed, open). Byte +3 low nibble = **MAIN WEAPON 0-7**, high nibble a 0-3 select. Weapon evidence: KUMITATE's menu handler pairs `+0x0F`/`+0x13` with its own UI data; the nibble spans 6 of 8 values across the corpus (an 8-option menu; every other ship byte holds 2-4 values); the factory default (SGM_INIT = Gust) stores 6. GAME.CMP has TWO fire dispatchers, both segmented: the autofire jump table `+0x15144` (mova `+0x15150`) routes 0→none (returns -1), 1→`+0xf498`, 2→`+0xfcac`, 3→`+0xfe08`, 4→`+0x104cc`, 5→exit (charge-type), 6→`+0x1110c`, 7→`+0x11ea8`; the charge/release dispatcher `+0x1cebc` routes 5→`+0x10a6c` (charge-level damage table `+0x6085e14`), 6→`+0x113fc` (4/bullet bursts, `+0x11fd0`), 7→`+0x1204c`. Weapon 4's damage is traced: twin bullets of 27 (r5 arg at `+0x10500` into the spawn `+0x1038c`). Weapons 1/2/3/7 pass damage through helper args or per-frame beam ticks (weapon 1 zeroes the damage slot at spawn, `+0xf046`) — dataflow follow-up still open. The sub-weapon has its own dispatcher `+0x1528c` (config via pointer global `0x6084118`, & 3): 0→none, 1→`+0x1471c` (calls `+0x145e8`, table `+0x6085e6c` [16..24]), 2→`+0x14988` (table `+0x6085ebc` [8..32]), 3→`+0x14d04` (table `+0x6085edc` [48..96]) — so those three tables are SUB-weapon damage-by-level, and the ship block's `+3` high nibble (0-3) is the sub-weapon select. The settings→engine copy is pointer-indirected and untraced, so the weapon byte is `heuristic` (congruence), not `confirmed`. |
| `+0x1C`–`+0x23` | 8-entry table, all values ≤ 38 — the 8 item slots |
| `+0x2D`–`+0x40` | 20 **always-even** bytes (10 pairs, max 48 = 2×24) |
| `+0x41`–`+0x58` | **BGM assignment table**: 24 entries, every value ≤ 23 in every game, indexing sec6's 24 song slots. Three special tracks first, then (main, boss) pairs per stage — DAIOH reads `12,11,13, 1,6, 2,7, 3,8, 4,9, 5,10`. No entry ever points at an empty song slot. |
| `+0x59` | **SFX set**: 1, 2 or 3 = the editor's REAL / COMIC / SF banks |

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
| 6 / 7 | **arrival / death** behavior selectors (velocity presets and scroll-stop position); carried raw |
| 8–63 | 4 **pattern records** × 14 B |

Pattern record: byte +0 bits3-7 = **movement script** 0–31 (engine-fixed
script data at `+0x252D4`–`+0x25A18`, pointer table `+0x25A18`), bits0-2 =
speed; byte +1 bits0-2 = **fire-tick divider** → frames per fire tick
`[60,30,15,10,5,3,2,1]` (`+0x21EE8`); then 3 **fire points** of
`[dx.s8, dy.s8, rate<<4|type, param]`, dx/dy relative to the boss centre.
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
