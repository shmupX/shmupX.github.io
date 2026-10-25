# Dezaemon 3D (Nintendo 64) 64DD disk format — reverse-engineering notes

Working notes for the Nintendo 64 reader and writer (`src/n64/`): _Dezaemon 3D_
(Athena, 1997) and the 64DD data disk its unreleased expansion kept user
projects on. The Saturn's notes are in `FORMAT.md`, the Super Famicom's in
`FORMAT-SFC.md`, the PlayStation's in `FORMAT-PSX.md`; this disk shares the
Saturn's LZSS compressor with the PlayStation ports and little else. Split into
**confirmed** (measured against the bytes of the prototype disk and locked by a
test, or published geometry that the implementations named below agree on),
**likely** (a layout whose arithmetic closes against the measured sizes but has
not been checked field by field against the bytes) and **open** (only the label
is known). On this platform confidence tops out at likely for anything not
provable by arithmetic: a controlled delta — change one thing in the editor,
save, diff — needs a 64DD emulator, a disk writer and the DEZA64 cartridge, and
the cartridge was never released. Nothing described here has been booted on
hardware or in an emulator.

| Material                                            | Where                                                                   | What it is                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dezaemon298.ddd`                                   | `dev-fixtures/` (gitignored, **not** in every checkout)                 | 64,458,560 bytes, md5 `99a67674130f271f150db75c02d14f0a` — the prototype data disk's user area, 64dd.org's "old dump"                                  |
| `deza1.NDD`                                         | **not in the repo** (64dd.org, `DEZA_1_19980223.zip`)                   | the canonical dump, 64,931,840 bytes: the same disk with its 24-block system area, and a differently written save area                                 |
| `file formats.txt`                                  | **not in the repo** (the 2024 fan translation, Zoinkity/whowasphone404) | the field-by-field description of every payload type; read whole for the record codecs (`records.js`), summarised on `static/dezaemon-parity-n64.html` |
| `leogeo.c`                                          | jkbenaim/leotools                                                       | the published zone tables and the system-area reader this geometry was cross-checked against                                                           |
| `disk.h`, `disk.c`                                  | mupen64plus-core `src/device/dd/`                                       | the zone tables, `struct dd_sys_data`, and `scan_and_expand_disk_format`, which is what an emulator checks before mounting                             |
| `static/dezaemon-parity-n64.html`                   | this repo                                                               | the survey of 2026-09-19: every offset below that is not derived from the modules is copied from it                                                    |
| `tests/dezaemon_n64_test.ts`, `…_n64_write_test.ts` | this repo                                                               | 39 tests that run against synthetic disks; two more are `ignore:`-gated on the fixture                                                                 |

LuigiBlood's 64dd wiki and the fan translation's `file formats.txt` were the
survey's sources for the geometry and the record layouts respectively. Neither
is reachable from this repo's own tooling, but the wiki's _Disk Specification_
and _Dezaemon 3D_ pages were supplied to the session that wrote the system-area
and geometry modules, and the physical account of the disk and the disk-ID check
below are quoted from them; the record layouts are cited through the parity
page's summary and the two implementations named above, which the modules were
held to.

All multi-byte integers are **big-endian** (the N64 is big-endian), as in the
Saturn notes and unlike the Super Famicom's and the PlayStation's.

## What the disk is (confirmed)

A 64DD disk is 4,316 blocks, the first 24 of them a **system area** the drive's
IPL reads and the rest the **user area** a game sees as LBA 0 onwards. Two dump
shapes exist:

| Image  | Bytes      | Holds                                                                                                                         |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `.ndd` | 64,931,840 | the whole disk, system area first — what mupen64plus-core calls the SDK format (`disk.h` `SDK_FORMAT_DUMP_SIZE` `0x03DEC800`) |
| `.ddd` | 64,458,560 | the user area alone: the `.ndd` less 473,280 = 24 × 85 × 232 bytes                                                            |

`.ddd` is not a format anything else names: it is the 2018 dumper's extension
for the user area, settled by byte comparison — `deza1.NDD[473280:]` is
`dezaemon298.ddd` except inside the save area. `imageFormat()` tells the two
apart by length alone; nothing else does, and nothing else can, since a `.ddd`
carries no header. mupen64plus mounts the `.ndd` length and the MAME-format
70,627,520-byte dump (`0x0435B0C0`), and a third shape, D64 (a 0x200-byte
header, then the ROM and RAM areas); this repo writes `.ndd` and `.ddd` only.

The prototype is a **data disk**: it was written 1998-02-23 19:24:25 from a
Partner-N64 development unit for an expansion of the cartridge game that never
shipped. Its boot program (user LBA 0–8, a libultra executable at
`0x0`–`0x29420`, 168,992 bytes, load address `0x80000400`) does one thing: it
draws the notice at `0x28E80`, in romaji:

```
KONO DISK WA DEZA64 DATA DISK DESU
ICHIDO DENGEN WO KIRI DEZA64 NO
ROMCARTRIDGE WO SOUNYUUSHITE
DENGEN WO IRENAOSHITE KUDASAI
```

— power off, insert the DEZA64 cartridge, power on again. It holds no filesystem
code at all (all 274 `jr ra` instructions in the 64 MB fall inside it, and not
one filename constant); the filesystem lives on the cartridge, which enters
**disk mode** with this disk in the drive. DEZA64 is Dezaemon 3D's internal
codename. `isDddImage()` recognises a `.ddd` by its length and by
`DEZA64 DATA DISK` anywhere in `0x28000`–`0x2A000`.

What the disk carries, in user-area terms: two pressed sample projects,
`SAMPLEZ1` and `SAMP` (byte-identical to each other file for file), in a
read-only directory in the ROM area; and in the RAM (save) area the cartridge's
own `DEZA3D.SYS` and `DEZA3D.HSC`, a writable directory, and a user project
`DST`. 64dd.org labels the fixture the old dump: it differs from `deza1.NDD` in
175,897 bytes, every one inside `0x18CF180`–`0x1922C3F`, the save area, so the
ROM area and everything built on it is the same in both and `DST` should be read
from `deza1.NDD`.

What a disk this repo writes is, in the same terms: a **pressed** project in the
read-only directory beside the two samples. Built on a donor (the prototype as
`.ddd` or `.ndd`) it keeps the donor's boot program and its whole RAM area byte
for byte, so the cartridge still has what it needs for disk mode. Built from
nothing it has the notice, the files, the directory and an empty RAM area: this
repo's reader opens it, and the cartridge is **not** expected to enter disk mode
on it (not tried). One built on `deza1.NDD` was booted in the launcher's player
("The launcher's player"); none has been put on hardware.

## Container geometry (confirmed — `src/n64/geometry.js`)

A block is **85 sectors** of user data, and the sector size steps down from the
outer edge inwards through 232, 216, 208, 192, 176, 160, 144, 128 and 112 bytes,
so a block is 19,720 bytes in the outermost zone and 9,520 in the innermost. The
physical disk (LuigiBlood's wiki, _Disk Specification_): two sides, each of
1,175 cylinder tracks over eight zones, side 1 starting one zone in; a track is
two blocks; a block on the media is 90 sectors — the 85 of user data, four of C2
error correction and one gap, of which only the 85 reach an image (C1 correction
is seven bytes a sector and the drive's business); a sector of zone _n_ is the
_n_-th size above. So there are sixteen **physical zones**, 0–7 on side 0 and
8–15 on side 1, side 1's zone _k_ having the sector size of side 0's zone
_k_ + 1. A side's eight zones have 158, 158, 149, 149, 149, 149, 149 and 114
tracks, of which the driver treats twelve a zone as defective on a retail disk
(ten on a development one) and skips them, so the usable blocks are 292, 292,
274, 274, 274, 274, 274 and 204 on each side — 4,316 in all, 24 of them the
system area, 4,292 the user area. The driver also interleaves the two blocks of
every odd track for seek time and reads side 1's tracks from the end of a zone
inwards; none of that reaches an image, which is the blocks in LBA order. LBA
order walks the physical zones through a per-disk-type permutation, the
**virtual zones**: the ROM area is zones 0, 1 and 2 of both sides always and one
zone more per disk type (zone 3 from type 1, zone 4 from type 2, … zone 8 from
type 6), the RAM area the rest — the disk type is handed to the drive in a
command that write-protects those zones. The Dezaemon disk is **disk type 0**,
and `zoneTable(0)` is, in user terms (LBA 0 is the first block after the system
area, offset 0 the first byte of a `.ddd`):

| vzone | pzone | Sector |  Block | First LBA | Last LBA | Blocks | `.ddd` offset | Area |
| ----: | ----: | -----: | -----: | --------: | -------: | -----: | ------------- | ---- |
|     0 |     0 |    232 | 19,720 |         0 |      267 |    268 | `0x0000000`   | ROM  |
|     1 |     1 |    216 | 18,360 |       268 |      559 |    292 | `0x050A460`   | ROM  |
|     2 |     2 |    208 | 17,680 |       560 |      833 |    274 | `0x0A27240`   | ROM  |
|     3 |     9 |    208 | 17,680 |       834 |     1125 |    292 | `0x0EC5D60`   | ROM  |
|     4 |     8 |    216 | 18,360 |      1126 |     1417 |    292 | `0x13B23A0`   | ROM  |
|     5 |     3 |    192 | 16,320 |      1418 |     1691 |    274 | `0x18CF180`   | RAM  |
|     6 |     4 |    176 | 14,960 |      1692 |     1965 |    274 | `0x1D12D00`   | RAM  |
|     7 |     5 |    160 | 13,600 |      1966 |     2239 |    274 | `0x20FB8E0`   | RAM  |
|     8 |     6 |    144 | 12,240 |      2240 |     2513 |    274 | `0x2489520`   | RAM  |
|     9 |     7 |    128 | 10,880 |      2514 |     2717 |    204 | `0x27BC1C0`   | RAM  |
|    10 |    15 |    112 |  9,520 |      2718 |     2921 |    204 | `0x29D9FC0`   | RAM  |
|    11 |    14 |    128 | 10,880 |      2922 |     3195 |    274 | `0x2BB4200`   | RAM  |
|    12 |    13 |    144 | 12,240 |      3196 |     3469 |    274 | `0x2E8BF00`   | RAM  |
|    13 |    12 |    160 | 13,600 |      3470 |     3743 |    274 | `0x31BEBA0`   | RAM  |
|    14 |    11 |    176 | 14,960 |      3744 |     4017 |    274 | `0x354C7E0`   | RAM  |
|    15 |    10 |    192 | 16,320 |      4018 |     4291 |    274 | `0x39353C0`   | RAM  |

vzone 0 is 292 blocks less the 24 of the system area, which is why the first
boundary is LBA 268 and not 292. `lbaToOffset()` is this table; `extentBytes()`
sums block by block because an extent can straddle a boundary and one on the
prototype does (`SAMP 3MD` starts at LBA 266 and runs five blocks across 268:
94,520 bytes, not 5 × 19,720); `blocksFor()` is its inverse and is what the
directory's `blockCount` is.

Three measurements pin the table to the prototype, beyond the published tables
themselves:

- every one of the 60 directory entries satisfies
  `blockCount === ceil(storedSize / blockSize(startLba))`, and the same file
  appears with 10 blocks at LBA 96 (197,200 bytes of room) and 11 at LBA 272
  (201,960), which happens only if the block shrinks from 19,720 to 18,360 at
  LBA 268;
- the read-only directory is replicated at three image offsets that are exactly
  in-block offset 834 of LBA 1417, 1419 and 1422 under this table and under no
  other ordering of the sector sizes — 1417 is the last ROM block (18,360
  bytes), 1419 and 1422 are RAM blocks (16,320);
- the sixteen zones sum to 64,458,560 bytes, the length of every `.ddd`.

The ROM/RAM split is LBA **1417 / 1418**, offset `0x18CF180`: the ROM area is
the five virtual zones before it, 26,014,080 bytes; the RAM area is the eleven
after, 38,444,480 bytes. The prototype's system area does not record the split
(below); it is recovered from the data instead, and unambiguously — the ROM area
holds exactly one large `0xFF` run, `0x6C7188`–`0x18CA9C8`, 18,888,768 bytes of
unwritten media, and the last sample file's extent ends at `0x6C7187`, flush
against it. Laid out, the prototype's ROM area is

| Offset                  | LBA                 |      Bytes | What                                                                |
| ----------------------- | ------------------- | ---------: | ------------------------------------------------------------------- |
| `0x000000`–`0x029420`   | 0–8                 |    168,992 | the boot program                                                    |
| `0x029420`–`0x02B548`   | 8                   |      8,488 | the pad after it, up to LBA 9 (open; nothing reads it)              |
| `0x02B548`–`0x6C7188`   | 9–368               |  6,929,472 | the 60 LZSS streams of the two samples, end to end, no padding      |
| `0x6C7188`–`0x18CA9C8`  | 368 (its tail)–1416 | 18,888,768 | `0xFF`, unwritten                                                   |
| `0x18CA9C8`–`0x18CF180` | 1417                |     18,360 | the directory block: 834 bytes, then the five arrays, then 12 spare |

Cross-checks against the published implementations, which agree with each other
and with the table: jkbenaim/leotools `leogeo.c` `pzone_tbl1[0]` gives the last
user LBA of each virtual zone as 267, 559, 833, 1125, 1417, 1691, 1965, 2239,
2513, 2717, 2921, 3195, 3469, 3743, 4017, 4291 — the table's Last LBA column —
and its `block_size_per_vzone` the nine block sizes (leotools numbers head 1's
zones the other way round, folding them through `vzone_tbl`; the sizes come out
the same). mupen64plus-core `disk.h` `DiskTypeZones[0]` is
`{0, 1, 2, 9, 8, 3, 4, 5, 6, 7, 15, 14, 13, 12, 11, 10}`, `DISK_TYPE_ZONES[0]`
verbatim; its `VZoneLBATable[0]`, in physical LBAs (`0x124`, `0x248`, `0x35A`,
`0x47E`, `0x5A2` …), is each zone's last user LBA plus 25 (267 + 25 = `0x124`);
`disk.c` `RAM_START_LBA[0]` is `0x5A2`, 1418 + 24, and `RAM_SIZES[0]` is
`0x24A9DC0` = 38,444,480, the RAM area's length above. The three sources use the
same multiset of sector sizes in a non-monotone order, so a fixed stride or a
plain 232→112 descent finds nothing in either image.

**The other six disk types (derived, unverified against a disk).** A type's ROM
area is its first 5 + 2 × type virtual zones (type 6 is all ROM) and
`DISK_TYPE_ZONES` carries the published permutation for each, so `zoneTable(t)`
exists for 0–6, every one sums to 64,458,560, and the RAM areas start at LBA
1418, 1966, 2514, 3062, 3610 and 4088 — mupen64plus's `RAM_START_LBA` entries
`0x5A2`, `0x7C6`, `0x9EA`, `0xC0E`, `0xE32` and `0x1010` less 24 — with none for
type 6. No disk of another type has been measured here, the directory block is
only known for type 0, and `buildDisk()` says so in a warning when asked for
another type.

## The system area (likely — `src/n64/system-area.js`)

The 24 blocks a `.ndd` carries before the user area are all outermost-zone
blocks of 19,720 bytes, so system LBA _n_ is at _n_ × 19,720 in the `.ndd` and
user LBA 0 is at 473,280 = `0x738C0` (`nddLbaToOffset()` adds that to the `.ddd`
offset: the directory's first copy is at `0x193E5CA` in an `.ndd`). Two records
matter, and each is one sector written 85 times over so that any sector of its
block reads the same:

| Record      | Blocks (retail) | Blocks (development)                                                   | `.ndd` offsets of the retail blocks   |
| ----------- | --------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| system data | LBA 0, 1, 8, 9  | LBA 2, 3, 10, 11, in 192-byte sectors (zone 3's, `SECTORSIZE_SYS_DEV`) | `0x0`, `0x4D08`, `0x26840`, `0x2B548` |
| disk ID     | LBA 14, 15      | the same                                                               | `0x43670`, `0x48378`                  |

The layouts are the ones leotools (`LeoGeo_analyze_disk`) and mupen64plus
(`struct dd_sys_data`) read, and the fields below are theirs:

| Off    | Size    | System data (0xE8 bytes)                                      | Prototype / writer default          |
| ------ | ------- | ------------------------------------------------------------- | ----------------------------------- |
| `0x00` | u32     | region: `E8 48 D3 16` Japan, `22 63 EE 56` USA, 0 development | Japan                               |
| `0x04` | u8      | format, `0x10` on a retail-format disk                        | `0x10`                              |
| `0x05` | u8      | bit 4 retail, bits 0–3 the disk type (0–6)                    | `0x10`: retail, type 0              |
| `0x06` | u16     | IPL load size in blocks, from user LBA 0                      | 9                                   |
| `0x08` | u8[16]  | defect-track table offsets per physical zone, cumulative      | all zero                            |
| `0x18` | u32     | unused                                                        | 0                                   |
| `0x1C` | u32     | IPL load address, `0x80000000`–`0x807FFFFF`                   | `0x80000400`                        |
| `0x20` | u8[192] | defect tracks, twelve per zone at most                        | all zero                            |
| `0xE0` | u16     | last ROM-area user LBA                                        | prototype `0x1016`; writer **1417** |
| `0xE2` | u16     | first RAM-area user LBA (`0xFFFF`: none)                      | prototype `0x1C22`; writer **1418** |
| `0xE4` | u16     | last RAM-area user LBA (`0xFFFF`: none)                       | prototype `0x282E`; writer **4291** |
| `0xE6` | u16     | unused                                                        | 0                                   |

| Off    | Size    | Disk ID (0x20 bytes used of the sector)            | Prototype / writer default                             |
| ------ | ------- | -------------------------------------------------- | ------------------------------------------------------ |
| `0x00` | char[4] | initial code                                       | `DEZA`                                                 |
| `0x04` | u8      | game version                                       | 0                                                      |
| `0x05` | u8      | disk number                                        | 0                                                      |
| `0x06` | u8      | RAM use (1 when the RAM area is written)           | 1                                                      |
| `0x07` | u8      | disk use                                           | 0                                                      |
| `0x08` | u8[9]   | unused here                                        | 0                                                      |
| `0x11` | BCD[7]  | year (two bytes), month, day, hour, minute, second | prototype `1998-02-23 19:24:25`; writer the build time |
| `0x18` | char[2] | company code — **what the cartridge checks**       | `E7`, Athena                                           |
| `0x1A` | char[6] | free area — **what the cartridge checks**          | `ATNFS0`: `ATNFS` + the disk type in ASCII             |

What the prototype's own copy holds, recovered from `deza1.NDD` and recorded on
the parity page: region Japan, format `0x10`, disk type 0, `DEZA`, the timestamp
above, `PTN64` (a Partner-N64 mark) and `ATNFS0` in the free area. The three
area fields read `0x1016` / `0x1C22` / `0x282E` (4,118 / 7,202 / 10,286): an
arithmetic sequence with step `0xC0C`, none of them the true 1417 / 1418 / 4291,
the last two past the last user LBA — filler, not data, so the cartridge cannot
be reading them and the disk does not record where its own ROM area ends. The
writer puts the **true** values in because an emulator's D64 path does read
them: mupen64plus `disk.c` refuses a D64 whose RAM start is not
`RAM_START_LBA[type] − 24` (1418 for type 0) and sizes the ROM area from
`rom_lba_end`. The IPL fields describe the boot program the prototype carries
(nine blocks = 177,480 bytes, of which 168,992 are used, loaded to
`0x80000400`); they are kept on a disk built without that program, since the
cartridge never runs it.

What the **cartridge** checks before it treats a disk as its own (LuigiBlood's
wiki, _Dezaemon 3D_; likely — it is the wiki's reading of the game, and no disk
this writes has been put in front of one): the drive must be a Japanese retail
or a development unit, and the disk ID — no game code, and not the system data —
must carry company code `E7` and free area `ATNFS?` with `?` the disk type in
ASCII. Dezaemon 3D does not reboot into a disk the way most 64DD expansions do;
it keeps running from the cartridge and uses the disk for storage, with sample
projects pressed into the ROM area. `encodeDiskId()` writes `E7` and
`ATNFS<diskType>` by default, `buildSystemArea()` takes the type from the system
data it is given, and `isDezaemonDiskId()` is the check; an `.ndd` this repo
wrote before 2026-10-14 carried two NULs for the company code and would not have
passed it.

What an emulator checks before it mounts an `.ndd` — mupen64plus
`scan_and_expand_disk_format`, which `checkSystemData()` and `readSystemArea()`
reproduce: it walks LBA 0, 1, 2, 3, 8, 9, 10, 11 for the first block whose
record has `(type & 0xEF) <= 6`, an IPL load size of 1..4291 (`MAX_LBA − 24`,
zero refused), a load address in `0x80000000`–`0x807FFFFF` and a region of
Japan, USA or development, **and** whose 85 sectors are identical (232 bytes
each, or 192 when the block is 2, 3, 10 or 11, which also marks the disk
development); then LBA 14 or 15 as the disk ID, again only when every sector
agrees. `buildSystemArea()` writes exactly that — the system data in LBA 0, 1, 8
and 9, the disk ID in 14 and 15, every sector of each block a copy, everything
else zero — and the write tests read it back through `readSystemArea()`, which
reports what the emulator would refuse rather than throwing. Confidence stops at
likely because the prototype's system area is known from the parity page's
reading of `deza1.NDD`, not from a fixture in this checkout, and because no
emulator has mounted a disk this writes.

## The directory (confirmed — `src/n64/directory.js`)

**ATNFS**, Athena's own (the disk ID's free area says `ATNFS0`), not Nintendo's
MFS — `mfsextract` (leotools) and `mfs_manager` do not read it. It is a
**structure of arrays**, five parallel arrays of 834 slots laid end to end,
which is why a reader that looks for a name followed by a size finds names and
nothing else:

| Array        | Slot bytes | `.ddd` offset |            Bytes | Holds                                                              |
| ------------ | ---------: | ------------- | ---------------: | ------------------------------------------------------------------ |
| `names`      |         11 | `0x18CAD0A`   | 9,174 (`0x23D6`) | NAME, eight characters space-padded, then EXT, three; no separator |
| `startLba`   |          2 | `0x18CD0E0`   |  1,668 (`0x684`) | u16, user LBA                                                      |
| `blockCount` |          2 | `0x18CD764`   |  1,668 (`0x684`) | u16                                                                |
| `reserved`   |          2 | `0x18CDDE8`   |  1,668 (`0x684`) | u16, zero in all 60 used slots                                     |
| `storedSize` |          4 | `0x18CE46C`   |  3,336 (`0xD08`) | u32, the compressed length — what makes extraction possible        |

Together 834 × 21 = **17,514 bytes**, `0x18CAD0A`–`0x18CF174`. The slot count is
measured from the three equal `0x684` strides between the u16 arrays; those
strides run through zero fill, which cannot tell a large array from a small one
followed by padding, so 834 is what one disk shows and `encodeDirectory()` takes
`slots` as a parameter rather than a law. It fits its block exactly: the arrays
start 834 bytes into LBA 1417 (`0x18CA9C8`, 18,360 bytes) and 834 + 834 × 21 =
18,348 ≤ 18,360, leaving 12 bytes before the RAM area at `0x18CF180`. The 834
bytes before the arrays are not understood (open); the writer carries them from
the donor and leaves them zero on a disk built from nothing.

**Three copies**, byte-identical: at `0x18CAD0A`, `0x18D3482` and `0x18DF3C2`,
34,680 and then 48,960 bytes on. Both gaps are exact sums of block sizes —
34,680 = (18,360 − 834) + 16,320 + 834 and 48,960 = 3 × 16,320 — which is how
the geometry first announced itself: all three sit 834 bytes into a block, the
last ROM block and the second and fifth RAM blocks (`DIRECTORY_COPY_LBAS` 1417,
1419, 1422; `directoryOffsets()` derives the three offsets from the zone table,
and they come out exactly). The two RAM-area copies are the only bytes this repo
writes into the RAM area.

Reading (`readDirectory()`): slots are read in order until the first whose
eleven name bytes are not all printable ASCII (`0x20`–`0x7E`) or are blank — the
unused tail is zero. A stage file's extension starts with its digit (`0GR`,
`8MD`), so `sizeKey()` strips it when looking a size up. Writing
(`encodeDirectory()`, `writeDirectory()`): a name is 1–8 printable characters
with no blank inside it, an extension exactly 3; `normalizeProjectName()`
reduces a given name to upper-case A–Z and 0–9, at most eight, because an ATNFS
name is matched byte for byte by the cartridge and every project on the
prototype — the two samples and `DST` — uses nothing else; unused slots are
zero; all three copies are written.

**Allocation** is contiguous and starts at LBA 9, after the boot program's nine
blocks: `startLba[i] + blockCount[i] === startLba[i + 1]` for all 59 pairs of
the prototype's 60 entries, LBA 9 through 368 (the next free block is 369). The
**blockCount rule** is `ceil(storedSize / blockSize(startLba))` for a file that
stays in one zone and `blocksFor(startLba, storedSize)` in general: the blocks
its bytes span from where it starts. `layoutFiles()` lays a list of streams that
way from LBA 9, refuses when a file would reach LBA 1417 (the directory's block,
so the last file block is 1416 and the ROM area has 1,408 file blocks,
25,818,240 bytes), and `checkDirectory()` holds any directory to three
invariants — `contiguous`, `blocksFit`, `withinCapacity` — rather than assuming
them. `blocksFit` is the one that proves the zone boundary. Note that
`startLba + blockCount` is a valid extent **only in this directory**: the
writable one fragments (below).

## Compression (confirmed — `src/decompress.js`, `src/compress.js`)

Every file is one **Okumura LZSS** stream, and the Saturn Dezaemon 2's decoder
in `src/decompress.js` opens them unmodified — the same codec the PlayStation
Dezaemons use: a flag byte governs the next eight items LSB first, 1 = literal
(one byte), 0 = match (two bytes `b1 b2` with offset `b1 | ((b2 & 0xF0) << 4)`,
an absolute index into a 4,096-byte ring zero-filled with the write pointer at
`0xFEE`, and length `(b2 & 0x0F) + 3`); the stream ends when the input does. The
LZSS module inside the fan translation's `DezaDiskTool.exe` self-describes as a
port of Okumura's codec, which corroborates it independently. `src/compress.js`
is the encoder (hash chain over the ring, zero prefill included, matches of
3–18): anything it emits decodes to its input through `decompress()`, and
`packProject()` runs it over every file a project contributes. Nothing on the
prototype is ever recompressed — a donor's streams are carried byte for byte.

**The trap.** There is no length prefix on these streams and the decoder cannot
fail: hand it noise and it returns noise, at length. One pass of the survey was
misled that way. A decompression is evidence only when the caller slices the
stream to the directory's `storedSize` **and** the output length matches a
predicted value, so `extractFile()` always does both and reports `sizeOk`, and
`buildDisk()` decompresses every stream it wrote and compares the bytes before
it returns. For scale: a zero 4,096-byte texture compresses to 485 bytes, a zero
1,064,960-byte `GR` sheet to 125,726, and a project whose thirty files are all
zero to 1,487,128 bytes in 95 blocks (LBA 9–103), ratio 0.118.

## Graphics (confirmed — `src/n64/graphics.js`)

`CGR` and the per-stage `GR` files decompress to flat sheets of 64-pixel-wide
scanlines, two bytes a pixel, **no palette** — the Saturn and PlayStation
Dezaemons index a colour bank, this one does not. The word is big-endian
**RGBA5551**, `RRRRRGGG GGBBBBBA`: five bits each of red, green and blue, then
one bit of alpha in **bit 0**. That is the difference that matters —
`rgb555ToRgb` in `src/psx/decode-cg.js` reads bit 15 as the flag and the low
fifteen as colour, and on this data every channel comes out shifted.

The format was settled by counting: of the 432,506 nonzero words in
`SAMPLEZ1.0GR` every one has bit 0 set, and so do all 29,180 in `CGR`. Nothing
but an alpha bit produces a ratio of exactly 1 (`alphaBitRatio()` keeps the
test). A **texture** is a 64×32 tile of 0x1000 bytes; `CGR` is 0x28000 = **40**
of them and a stage's `GR` 0x104000 = **260** — the published documentation says
520, and 0x104000 ÷ 2 ÷ (64 × 32) is 260. Rendered as a contact sheet
(`decodeTileSheet()`, `n64:probe png`) the tiles are unmistakably art: the
sample's `GEAR SQUID` title logos, `WARNING` and `DANGER` plates, a briefing
screen, cut-in portraits.

Decoding scales a channel by × 255 / 31 so 31 lands on 255 (`decodeRgba5551`).
Encoding (`encodeRgba5551` in `project-write.js`) rounds × 31 / 255, takes alpha
from the alpha byte against a cutoff of 128, and writes a transparent pixel as
the zero word — which is what the prototype's own sheets use for nothing, and
what `isBlankTexture()` tests a whole texture for. The write tests hold the
encoder to the decoder.

## The project model and the record files (likely — `src/n64/records.js`)

A project is **thirty files**: six globals — `GAM CGR CMD CBL ULB MUS` — and
`BL`, `MD`, `GR` for each of eight stages numbered 0, 1, 2, 3, 4, 5, 6 and
**8**; stage 7 is simply absent from the numbering (`projectExts()` is that list
in directory order). Decompressed, a project is 12,596,477 bytes, of which the
two graphics types are 8,683,520 (69%, confirmed), the six record types
3,638,925 (29%, likely) and the `MUS` sequence bodies 274,032 (2%, open). The
sizes are confirmed by the prototype itself: 58 of its 60 files decompress to
exactly the documented size; the two misses are the two `GAM` files, both 1,360
bytes against a documented 1,369, and the documentation names exactly those two
as having "slightly different, incompatible formatting" on the prototype disks.
Landing five distinct types on exact sizes up to a megabyte confirms the LBA
map, the directory, the codec and the documentation's dimensions at once; its
**counts** are another matter (520 for `GR`), so every count below is re-derived
from the size.

| Ext   | Bytes                | Documented contents                                                                                                                                                                                              | Confidence                         |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `GAM` | 0x559 = 1,369        | global settings, two 0xA0 high-score blocks, ~120 s16 sprite-atlas coordinates, 30 light entries, a 0x200 editor palette; fields `0x1`, `0x225`, `0x557`, `0x558` marked `???`; nine bytes short on both samples | likely; the nine bytes open        |
| `CGR` | 0x28000 = 163,840    | 40 textures, 64×32 RGBA5551                                                                                                                                                                                      | **confirmed**                      |
| `CMD` | 0xF2A8 = 62,120      | 20 model records of 0xC20 + 20 texture indices in the remaining 40 bytes (two each, by subtraction)                                                                                                              | record confirmed, table likely     |
| `CBL` | 0x9B4 = 2,484        | 27 entries of 0x5C: 20 enemies and 7 items                                                                                                                                                                       | likely                             |
| `ULB` | 0xE100 = 57,600      | 8 model records of 0xC20 + 8 textures of 0x1000 — the only file mixing the two record kinds                                                                                                                      | likely                             |
| `MUS` | 0x42E70 = 274,032    | 24 songs of 0x2C9A: a 0x1A-byte header each, then 0x2C80 of sequence data nothing describes                                                                                                                      | header likely, body **open**       |
| `#BL` | 0x8B37 = 35,639      | 180 enemy entries of 0x5C (16,560 bytes), enemy placement, a 256-entry map table, 500 layout-effect commands of 0xC (6,000); `0x47`, `0x5B`, `0x8B2F` marked `???`                                               | likely; the sum is not closed here |
| `#MD` | 0x62944 = 403,780    | 130 model records of 0xC20 + 260 bytes; `+0xC11`–`0xC1F` of a record marked `???`                                                                                                                                | record confirmed, table likely     |
| `#GR` | 0x104000 = 1,064,960 | 260 textures, 64×32 RGBA5551                                                                                                                                                                                     | **confirmed**                      |

The **model record**, 0xC20 bytes, is plain data rather than F3DEX display lists
— a scan of the whole 64 MB found only 4 `G_ENDDL` and 1 `G_RDPPIPESYNC`, all
inside the boot stub, so the engine builds its display lists at run time and the
disk stores geometry as structs. As `records.js` reads it from
`file
formats.txt`:

| Off     | Size       | Field                                                                                                                                                                |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x000` | u8         | vertex count, ≤ 100                                                                                                                                                  |
| `0x001` | u8         | face count, ≤ 100                                                                                                                                                    |
| `0x002` | 100 × 6    | vertices: s16 x, y, z                                                                                                                                                |
| `0x25A` | 100 × 0x14 | faces: three vertex indices, a pad, three s16 UV pairs, three bytes of baked RGB light, a texturing byte (`0x80` untextured, `0x40` light mask, low nibble the tile) |
| `0xA2A` | u16        | unnamed                                                                                                                                                              |
| `0xA2C` | 16 × 0x14  | tiles: u32 offset to the selection's corner, u32 vertical mirror, u32 width power, u32 horizontal mirror, u32 height power                                           |
| `0xB6C` | 16 × u16   | tile horizontal scales (0x64..0x400 documented; the samples hold up to 0x46F)                                                                                        |
| `0xB8C` | 16 × u16   | tile vertical scales                                                                                                                                                 |
| `0xBAC` | 100 × s8   | per-vertex group (-1 ungrouped)                                                                                                                                      |
| `0xC10` | u8         | light position (0..0x1D, one of `GAM`'s thirty)                                                                                                                      |
| `0xC11` | 15         | marked `???`, carried raw                                                                                                                                            |

**The codecs.** `src/n64/records.js` is a typed encode and decode for every
record the document describes — the 0x5C enemy entry with each packed byte's
bits named, the 0xC layout position and the three terminated layers, the map's
three settings bytes and 256 entries, the 0xC layout effect with its nineteen
command names, the `#BL` tail, the 0xC20 model, the 0x559 `GAM`, the 0x1A song
header and the blank song — and whole-file builders and parsers over them:
`buildStageBl`/`parseStageBl`, `buildCbl`/`parseCbl`, `buildMdFile`,
`buildCmdFile`, `buildUlbFile` and their parsers, `encodeGam`/`decodeGam`,
`buildMusFile`/`parseMusFile`. Every encode defaults every field and
range-checks by name; every decode is the inverse, with the bits a packed byte
does not document kept under `unknownBits` so a real file re-encodes byte for
byte. The ground truth beyond the document is the cartridge's own **initial
save** — the 0x18000-byte `sram` the translation ships for its fileserver, whose
bank table and LZSS streams decompress to exactly `GAM` 0x559, `CGR` 0x12000,
`CMD` 0x7968 (the cartridge variant, ten models), `CBL` 0x9B4, three stage `BL`
of 0x8FC2 (the cartridge variant, a 0x104-byte model-index prefix before the
disk layout), `MUS` 8 × 0x2C9A and `DEZA3D.SYS` 0x290. Against it:
`encodeGam({})` **is** that `GAM` byte for byte; `blankSong()` is its song 0 and
its eight songs re-encode byte-exact; the three stages, the `CBL` and all ten
`CMD` models parse and rebuild with zero mismatches, the tail's layer indices
equal to what `layoutIndices()` computes (0/9/10, 0/121/123, 0/1/108). Three
places the codecs depart from the document, each marked where it happens: the
sprite y table ends at 0x224, so the vibration bytes start there, not 0x223;
shots 2 and 3's type bytes (0x25, 0x26) are packed like shot 1's, since the
stages hold 0x20, 0x80, 0xA0 and 0x81 in them; and the player's initial altitude
admits 9 and 10, the cartridge's default being 9. What the real data also
showed: every layout layer ends in an entry whose enemy number is -1 and the
rest zero; the tail's first-enemy indices count those terminators; an unset map
entry carries texture 150; stage entries name models 20..148 almost exclusively
(the first stage also 0 and 19, the second 11), the seven items 12..18 only, and
the twenty common entries anything from 8 to 80 — read here as the common `CMD`
coming first in the model-number space, a stage's slot _k_ being model 20 + _k_,
on the items and the stages' habit alone (likely); layout entries within a layer
sit in **descending** frame order from +19 down to about -90,000, with x in
roughly -400..430 and y in 63..600 on the map layer (to 800 on layer B; the
units are the game's, untraced). Still **open**: the units of a face's UV pairs
(the sample models run to 321 × 291 over 64 × 32 textures) and of a tile's
offset; the tile index base (textured faces name tiles 1..9 and leave tile 0 at
the editor's blank `0, 0, 5, 0, 6`, which read as the document says would be 64
× 128); the disk-mode `#BL` tail's words at 0x8B2F, 0x8B33 and 0x8B35, which the
cartridge variant lacks; the score table's 0xD entry (printed as 1,000,000, read
here as 100,000); and the tempo table's 33rd entry. No disk- mode `#BL`, `CMD`
or `MUS` was available to check — the prototype's `SAMPLEZ1` files are on the
fixture, not in CI — and nothing any codec writes has been put in front of the
game.

## The writable area (likely / open)

The RAM area, LBA 1418–4291 from `0x18CF180`, is the cartridge's: the parity
page locates a **writable directory** of the same structure-of-arrays shape at
about `0x18CF174` — the first RAM block, 16,320 bytes — with a per-block u16
**allocation map** at `0x18CF182` where `0xFFFF` means free and anything else is
the owning slot index. It has 21 used slots: 11 live, `DEZA3D.SYS`, `DEZA3D.HSC`
and nine files of the user project `DST`, plus 10 **tombstoned** — deletion is
FAT-style, the first byte of the name zeroed. Its capacity reads as 480 slots,
16 projects × 30 files, inferred from strides through zero fill exactly as the
834 was, and one disk cannot settle it. Two traps: files here are **fragmented**
— `DST.MUS` claims start LBA 1428, count 3, and the map places it on 1428, 1429
and 1451, so `startLba + blockCount` is not an extent in this directory — and
there is **no checksum** anywhere in either directory, so a wrong guess is
indistinguishable from a right one and unknown fields have to be preserved
verbatim rather than recomputed. What `DEZA3D.SYS` and `DEZA3D.HSC` hold is
open. And the fixture is the wrong dump for any of it: the 175,897 bytes that
differ from `deza1.NDD` all fall in here.

Nothing in this repo writes this area. `buildDisk()` copies a donor's RAM area
byte for byte and leaves it zero on a disk built from nothing, in both cases bar
the two read-only directory copies at 834 bytes into LBA 1419 and 1422. That is
a deliberate stop: without the allocation map's rules and with no checksum to
tell a wrong layout from a right one, a saved project is not something this
writer can honestly produce.

## Writing a disk (`src/n64/disk-write.js`, `export-ddd.js`, `project-write.js`)

**`buildDisk(options)`** — `base`, `projects`, `remove`, `format`, `systemArea`,
`boot`, `type` — lays a user area out in this order and returns `image`,
`format`, `directory`, `report` and `warnings`:

1. LBA 0–8: the base's bytes verbatim; on a disk built from nothing, the given
   `boot` (at most 177,480 bytes, nine blocks) or else only the notice — the
   four romaji lines as NUL-terminated strings at `0x28E80` (`writeNotice()`;
   the words are the prototype's own and the first line is what `isDddImage()`
   looks for, but the prototype's exact separators were not recorded, so the
   encoding is likely, not confirmed).
2. LBA 9 onwards: every file as one LZSS stream, end to end with no padding, in
   directory order — the base's projects first in the order the base lists them,
   their streams untouched, then the new ones; a new project named like one on
   the base takes that project's place in the order and its old streams are
   dropped, and `remove` drops a project outright (a name that is not on the
   disk only warns). Within a project the thirty extensions sort as
   `projectExts()` does, an extension the format does not name after them.
   `layoutFiles()` assigns LBAs and block counts and refuses a ROM area that
   would overflow into the directory's block.
3. `0xFF` from LBA 9 up to the directory block, under and after the streams —
   what unwritten media reads as, and what the prototype has.
4. The directory, three copies, through `writeDirectory()`.
5. The RAM area: the base's, verbatim; zero otherwise.
6. For an `.ndd`: the given `systemArea`, else the base's when the base is an
   `.ndd`, else `buildSystemArea({systemData: {diskType: type}})`.

**Before it returns**, the reader is the judge: `readDirectory()` must read back
the same number of entries, each equal in name, extension, start LBA, block
count and stored size; `checkDirectory()` must pass `contiguous`, `blocksFit`
and `withinCapacity`; every stream on the disk must equal the one laid, and
every stream that was compressed here must `decompress()` to the bytes given;
and each of the three directory copies must compare equal to the encoded bytes.
A base disk whose own directory contradicts the geometry is refused up front by
`readProjects()` ("refusing to rewrite it"). The `report` names each project's
files with raw and stored sizes, start LBA, block count and ratio, the next free
LBA, the ROM area's file bytes (25,818,240) and what is left, and the three
directory offsets. `putProject()` and `removeProject()` are `buildDisk()` with
one project; `convertDisk()` goes `.ddd` ↔ `.ndd` without touching the user
area. The fixture-gated test rebuilds the prototype from its own two projects
and gets the same 64,458,560 bytes, then puts a third project on, checks the
save area is untouched, removes it and gets the prototype back.

**`buildN64ProjectFromLevel(level, art, options)`** — `name`, `template`,
`title1`, `title2`, `framesPerEnemy`, `storyBackdrops` — makes the thirty files,
and since the
codecs landed it places the level rather than only its art. Each frame becomes
ONE 64×32 texture — a model shows one texture, so a frame wider than 64 or
taller than 32 is shrunk to fit with its aspect kept (`shrinkRgba()`,
`spriteTexture()`) and the report lists it under `scaled` — laid into the
sheets' **blank** textures (`TextureSheet.place()`: never over a painted one, so
a template's own art survives; a frame that fits nowhere is `missed` and warned
about). Into `CGR`: the two title pictures fitted to 128×64 (2×2 textures), two
spread frames of the ship (the level's, or the base game's duke when the level
names none), and up to eight item frames (`isN64ItemFrame()`: names matching
`item`, `powerup`, `speedup`, `1up`), the first the art holds. No record names
them, so the caller hands them over: the editor's art is the whole base atlas,
and `build:ddd` asks the base atlas for every frame that matches and orders the
art as the editor's atlas holds it (`inEditorAtlasOrder()` in harbor's
`scripts/build-sav.ts`), so the two put the same icons in the same slots. Per
stage, for each enemy letter its enemylist uses, most
placed first: up to four spread frames into `GR` (blank textures first, then a
template's art the map does not name, from the top of the sheet down — see
"A model's texture"), a **billboard model** per frame into `MD`
(`spriteModel()`: a quad lying on the ground plane, 10 units a pixel of the
frame it came from, on tile 1 set to the whole texture, its UVs the sprite's
own texels with the top row at the far edge), its texture number in the
model's slot (40 + the `GR` tile, `N64_GR_TEXTURE_BASE`), and an **enemy entry**
per drop digit its cells carry (`enemyEntryFromEditor()`: score and HP from the
record, the four frame model numbers as 20 + the slot, the motion speed, a
bullet-1 shot aimed at the player when the record names an interval, the item
the digit maps to — the three shot power-ups the shot item, 4 bonus1, 5 the
bomb, 9 the shield); then the boss's idle frames and an entry with the
stage-clear and lock-on flags, its HP capped at 15 (15 when the record names
none) and a fixed motion. The **layout** puts every cell on the map layer, as
enemy number 20 + its entry (`N64_ENEMY_NUMBER_BASE`; 0-19 are the common `CBL`
enemies), at x across -400..400 by column and y 240, at the scroll its row
comes on at (`-(row × 160)`, `N64_SCROLL_PER_ROW`: a stage scrolls 600 a
second and the Saturn 60 px, so a 16-px row is 160; the row from the Saturn
writer's `FIRST_SPAWN_ROW`/`ROW_STEP` or the stage's `waveRows`; a "frame"
here is a scroll distance, see "A level's story"), the boss at x 0, y 400
after the last wave, entries in descending frame order; the map settings and
map entries come from a template stage's `BL` when there is one, else the map
is unset; the effects are the opening scene every stage gets
(`N64_STAGE_SCENE`, "A model's texture") and a stage's story ("A level's
story"). The common files: the ship and the item icons as common models 10 and 12..18 (the slots the cartridge's game
uses) in `CMD`, the seven item entries pointing at them in `CBL`, `GAM` with the
final stage set (a template's `GAM` is carried with only that byte changed — the
prototype's 1,360-byte ones included), blank songs in `MUS`, an empty `ULB`; a
template's `CMD`, `CBL`, `MUS` and `ULB` are carried instead. The report says
per file whether it is `art`, `art over
template`, `records`, `template`,
`template, final stage set` or `blank`, per sheet how many textures were painted
by the template, used, free, missed and scaled, and per stage its `records`:
entries, models, placements, the boss's entry and whether the map is the
template's. The limits are the format's: 180 entries, 130 models, 1,000
placements and 260 textures a stage, each warned about when it runs out. A
template is a project's thirty files decompressed —
`templateFromDisk(image, name)` gives the named or the first project of a disk
that way. Every number here that is not a measurement is a constant with its
evidence beside it (`N64_MODEL_NUMBER_BASE`, `N64_LAYOUT_HALF_WIDTH`,
`N64_SPAWN_Y`, `N64_UNITS_PER_PIXEL`, the speed, hit-size and drop tables), all
**likely**; what a boot settled is in the next section.

**`exportLevelToDdd(level, art, options)`** — the project options above plus
`disk`, `template`, `format`, `systemArea` — is the one call: the project onto
the donor `disk` (or a disk from nothing), with `template` `"disk"` (the donor's
first project; the default when there is a donor), a project name on the donor,
a files list, or `null`; `format` `"ndd"` (the default) or `"ddd"`; the file
named `dddFileName(title, format)` — `Dezaemon 3D - <title>.ndd`, the title's
`\ / : * ? " < > |` runs turned to `-`. It returns `image`, `format`,
`fileName`, `name`, `project` (the project's report), `directory`, `report` and
`warnings`.

**Entry points.** The CLI is `deno task build:ddd`, which is
`packages/shmup-harbor/scripts/build-ddd.ts`:

```
deno task build:ddd                                   # foo.json -> "Dezaemon 3D - foo.ndd"
deno task build:ddd foo                               # the cloud level levels/foo
deno task build:ddd foo --disk dev-fixtures/deza1.ndd # onto that donor (default: the first 64DD image in dev-fixtures/)
deno task build:ddd foo --no-disk                     # a disk built from nothing
deno task build:ddd foo --as GEARSQ --template SAMP   # the project's name, and the donor project under it
deno task build:ddd foo --ddd --out build/n64/foo.ddd --report
```

The donor defaults to the first 64DD image in `dev-fixtures/`, found by length
and never by name, an `.ndd` preferred because it brings its own system area;
`--no-template` leaves every non-sheet file zero. The editor's EXPORT sheet,
CONSOLE › **N64**, is the same call from the engine bundle
(`window.Dezaemon.exportLevelToDdd`, so the bundle has to postdate the writer —
`deno task engine:bundle`): a DONOR DISK file input (checked by length; its
projects are listed, and a donor with none gets no template), a PROJECT NAME
field (eight letters and digits, the open game's name cut to fit by default; a
name on the donor replaces that project), a FORMAT pick between NDD and DDD, and
DOWNLOAD. The editor draws the story as `build:ddd` does, with the composer in
the bundle (`src/story/story-panels.js`, `Dezaemon.storyBackdrops`), and its
line says how many stages open on it. No disk has been put on hardware.

**What the writer does not write** — the list a future session starts from:

- where a placement should go: x ±400 puts gs's columns in the middle third of
  the screen where the ship flies, and layout y reads as height (rows at y 100
  to 700 came on smaller and nearer the horizon as y fell), so whether 240 is
  the ship's own height, and whether a wider x would suit a level better, is
  open — the sample's map layers run ±627;
- a tile's `offset` beyond 0 (the selection's corner in 4×4 blocks, 0x20 a
  row): the writer only ever selects a whole texture, and how a model's texture
  index pages past its first texture is untested;
- layout effects beyond the scene's and the story's: no song command, no
  stage-clear command (the boss's flag is relied on instead), one camera for the
  whole stage; the map is unset unless a template stage lends its map table,
  and a template's effects are never carried (a stage-clear or a camera move at
  the wrong frame would be worse than none). The ground a template's map lends
  is not seen with the scene written here: gs's stages are black behind the
  sprites;
- the template's ship: with a template its `GAM` and `CMD` are carried, and on
  gs the ship draws as a grey block rather than the sample's own jet;
- what a template-less `GAM` still names: it is the cartridge's initial game
  with the final stage set and the player's frames on the ship's model, and it
  keeps the shield's models (7 and 5, empty slots on a disk built here — the
  shield draws nothing) and the title settings' texture references, whose
  meaning is open;
- the `MUS` sequence bodies: 24 blank songs, or a template's;
- the RAM area: the writable directory, the allocation map, `DEZA3D.SYS`,
  `DEZA3D.HSC`, and any **saved** (as opposed to pressed) project — carried from
  the donor or left zero;
- the boot program: a disk from nothing has the notice and nothing else in its
  nine blocks, and the 8,488-byte pad after the prototype's program;
- the 834 bytes at the head of the directory block (donor's or zero), and the 12
  after the arrays;
- a system area's defect tables (zero) and `PTN64`, which the parity page
  records but does not place;
- the nine bytes by which the prototype's two `GAM` files fall short of the
  documented 1,369, and the "slightly different, incompatible formatting" the
  translation's notes say they have beyond that;
- textures beyond what the blank slots hold: a sheet that runs out is reported,
  not grown — a project has 40 + 8 × 260 textures and no more (a story alone
  takes back a template's art, below);
- any disk type but 0 beyond the geometry (a warning says so), any `.ndd` whose
  system area is development-format, and the D64 or MAME image shapes;
- a story for a stage past the level's own (a boss's split second stage never
  gets one).

### A level's story (traced 2026-10-20, booted the same day)

The cart writers open a stage on its story drawn into its scenery; this disk's
scenery is a 3D ground, so a stage opens on its story the way the sample game
opens its boss briefings — the "PHASE 01 AREA GUARD" picture: forty `portrait`
layout effects covering the screen, then one effect clearing them. The trace
came off `deza1.NDD`'s `SAMPLEZ1` (its `SAMP` twin is byte-identical); the
boot is a disk built by `build:ddd gs --disk deza1.NDD`, and test disks made
from it with one thing varied, in `static/n64dd/play.html` (EmulatorJS 4.2.3,
mupen64plus-next; "The launcher's player").

What the boot settled:

- **One texture numbering** (confirmed). Model and effect textures count 0-39
  for `CGR` and 40-299 for the stage's `#GR` tiles (tile = number − 40): a
  portrait naming 140 drew `#GR` tile 100. The sample's stage models name
  103-299, which only this reading keeps inside 260 tiles, so the writer's
  stage models now store 40 + tile (`N64_GR_TEXTURE_BASE`); they had stored the
  raw tile.
- **A layout's enemy numbers count from 20** (confirmed). 0-19 are the common
  `CBL` enemies; a stage's entry _k_ is placed as 20 + _k_. The sample's
  layouts name 20..173 only, its third stage places its stage-clear entry, 51,
  as 71, and a placement of 20 + _k_ came on with the model of entry _k_. The
  writer had placed entry _k_ as _k_ — a common enemy.
- **The effect clock is 30 Hz** (confirmed): the stage clock in RAM
  (`0x801C8384`) advances 30 a second, and an effect's frame is read against it
  — the sample's stage 0, a demo flight with its stage-clear at 829, fades to
  stage 1 about 1,660 video frames in. The sample's briefings (30 and 55) are
  one and two seconds.
- **`portrait`** (flags from the translation's notes, set and clear booted):
  value 0 set (0) or clear (255); value 1 the texture, one byte, so `#GR` tiles
  0-215 only; value 2 the position `row × 10 + column`, rows of 32 px (0-7),
  columns 32 px apart (0-9), so a 64-px texture takes every other one; value 3
  the flags — 1 set (else remove), 2 composite (else opaque), 4 wipe (else
  instant), 8 clear all. Forty sets at frame 0 show from the stage's first
  frame (under its fade in from white, about a second and a half), over the 3D
  scene and over the HUD, a 320×256 grid whose last 16 lines are below the
  screen; `[255, 255, 0, 12]` takes all forty down. The textures need not be
  distinct: a cell names any texture.
- **Layout "frames" are scroll distances, not time** (confirmed). Each layer —
  map, A, B — has a scroll position in RAM (`0x801C85D0`, `D4`, `D8`) that
  counts up as the stage runs, and a placement comes on as its layer's
  position passes -frame (likely: entries nearer than the start came on at
  once). A stage with no scroll effect advances every layer 20 a frame, as rate
  3 does; rate 2 advanced 10 a frame; `mapScrollRate [0, 7]` holds the map
  where it stands, which was 229 or 404 at the first frame in different boots.
  The sample's stage 1 places map enemies out to -106,807 while its own
  stage-clear effect is at 2,900.
- Whether the waves run on underneath: they would — a portrait is drawn over
  everything and holds nothing back — so the story holds the scroll itself.

What the writer does (`project-write.js`: `storyScreen`, `storyEffects`,
`storyFrames`, `TextureSheet.claim`): a stage `stage<N>` with a backdrop in
`storyBackdrops` (`src/story/story-panels.js`, 224 px wide, its sizes
largest first) takes the first size no taller than 240 whose textures fit:
centred on an opaque black 320×240, cut into the forty 64×32 cells, identical
cells sharing one texture (gs's stage 0 takes 23). The textures go into the
stage's `#GR` tiles 0-215 that are blank, then into a template's art that
nothing this project writes points at — its own models replace the template's,
so only the map's texture bytes are in use, and since that byte's numbering is
open a tile is kept under both readings (t, and t − 40). The effects: at frame
0 the ship hidden, the map's scroll held and the forty portraits (set,
opaque, instant); at the story's frames the clear, the ship back and the map at
rate 3, which goes on as a stage with no scroll effect would. The story stays
four seconds and a frame for every two characters of its words, six to fifteen
seconds (`N64_STORY_*`). Every placement moves 404 further on
(`N64_SCROLL_START`), so nothing comes on behind the story. A story with no
size that fits is warned about and left out; a smaller picture, the words
alone, then the opening words are the fallbacks the backdrop carries. The
stage's report carries `story: {size, textures, reclaimed, frames, seconds}`,
and `build:ddd` logs it on its `story:` line (`storyLogLine`).

Booted on gs: the game lists the `GS` project, loads it, and stage 0 opens on
the GS plate, "But alas that is the glory of the digital age" and the stage's
picture, readable once the fade has gone; the clear comes on time, the ship
comes back and the map scrolls on from where it was held. Stage 1's story is the
same effects on its own sheet. Then the waves come: gs's headphone invaders and
geek car, upright and in their own colours, coming down the screen toward the
ship from the horizon (the next section).

### A model's texture, and a sprite that draws (booted 2026-10-21)

The writer's first billboards drew nothing, so they were taken apart by test
disks (`mdtest`/`sq` scripts in the side-session notes' `64dd-boot-harness`).
The decisive one moved the sample's city stage into stage 0 and replaced only
its models — the sample's own placement, pacing and camera, the model varied:

- **Geometry.** A quad lying in the XZ plane (y 0) wound `[0, 1, 2]`,
  `[0, 2, 3]` over near-left, near-right, far-right, far-left draws; the other
  winding is culled, and a quad in XY is edge-on to the camera and shows
  nothing. Untextured faces draw in their `light` colour.
- **UVs are texels**, and a tile is `1 << (widthPower + 1)` across but
  `1 << (heightPower − 1)` down — the document's "4 = 32, 5 = 64" holds for the
  width only. A face spanning UV 0..64 × 0..32 on a tile of powers 5 and 4
  showed the texture once across and its top 8 rows four times down; on powers
  5 and 6 (the editor's blank tile, so the whole 64×32 texture) it shows the
  texture once. The writer's quads had used height power 4.
- **Upright.** With u running along +x and v from the texture's height at the
  near edge to 0 at the far edge, a numbered test texture read the right way
  up and unmirrored; the three other assignments read flipped or mirrored.
- **The texture number** is the one numbering (40 + `#GR` tile), as the
  portraits showed.
- **A scene to draw in.** On gs's own stage the corrected sprites still drew
  nothing until the stage carried the sample city stage's frame-0 effects —
  altitude 10, fog `[56, 24, 0, 0]`, camera zoom 0, angle 0, rotation 10. With
  them the sprites came on (`N64_STAGE_SCENE`, every stage, at frame 0, before
  the story's).
- **Size.** The sample's ship model (264 units across) shows about 27 px wide
  where the player flies; at 10 units a pixel a sprite draws near its own size
  there (`N64_UNITS_PER_PIXEL`), and a frame shrunk to fit its 64×32 texture
  keeps its own size on screen.

So `billboardModel()` (records.js) lies in XZ, wound up, on the whole texture
by default, and `spriteModel()` sets the UVs to the sprite's own box. Booted on
gs: after the story, the stage's enemies come on near the horizon and grow as
they come down toward the ship, at the 160-a-row pace. A stage sheet with no
blank textures left (gs's stage 0 under `SAMPLEZ1`'s, 252 painted) used to
drop most of a level's frames; frames now take back the template's art the map
does not name, from the top of the sheet down, so all fifteen of gs's stage-0
frames are drawn and its story still finds tiles below 216.

### A boss's second stage (`project-write.js`, `src/boss-stage2.js`; researched 2026-10-18)

The web runtime lays a boss record's `stage2` block over the boss once its hp
falls below `hpBelow` of the bar: new stances, new weapons, the same bar
(README-Technical.md "A boss can have a second stage"; gs's Daltonius turns into
Liu Kang's dragon). A project has **no boss record at all**: a boss is an
ordinary 0x5C enemy entry with the hit byte's stage-clear (0x40) and lock-on
(0x80) flags, four animation model numbers and one frame speed, an HP byte of
0-15 hits, and three shot slots. No field documented here gates anything on hit
points, swaps an entry's models, or spawns one entry when another dies;
`enemySet`/`enemyRise` (0x44/0x45) and a shot's `launchedEnemy` are names
without a traced meaning.

So the writer splits such a boss into **two chained bosses either side of a
stage break**: the boss's own stage keeps it in its first form with the top of
the bar, and a stage put in right after it — no waves, the template's map for
that stage number, report key `<stage>:stage2`, boss `boss<n>:stage2` — has the
second form for its stage-clear entry (its own textures and models in that
stage's GR and MD) with the rest; `GAM`'s final stage moves one on. A level that
already fills all eight stages keeps the boss in its first form alone, with the
whole bar, and warns. Placing both forms in one stage — the second at a later
frame, the first without the stage-clear flag — was not tried: placements are
timed by frame, so nothing would hold the dragon back until Daltonius dies. The
HP byte caps both halves at 16 hits (gs: 1,750 each).

A boss now fires: its shot is its `projectileData`, else its first weapon slot
that names art (`bulletDataA`, `bulletData` …, as the runtime reads them) —
before this a web boss armed only with `bulletData*` (Daltonius, among others)
wrote no shot at all. **The bullets are the project's own**, though: `GAM`'s
sprite tables name two enemy shots and two lasers game-wide, the writer paints
no projectile art, and the shot type is always bullet 1, so neither form shows
the record's textures. The report's `transform` (and `exportLevelToDdd`'s) reads
"approximated: two chained bosses across a stage break", naming the stages, and
lists the `splits`; each stage's report carries `form: 1 | 2` beside its `boss`.
Like every disk this writes, untested on hardware or in an emulator.

## The launcher's player (booted — `static/n64dd/play.html`, `static/n64dd-library.js`, `lib/dezaemon-n64.ts`)

A data disk boots only beside Dezaemon 3D's cartridge and the 64DD's own IPL
ROM, neither of which is ours to ship, so the launcher finds both on the
operator's disk (`/api/dezaemon-n64`, `deno task n64:stage`) and the editor's →
PLAY 64DD row opens `static/n64dd/play.html` — the `n64dd` core of
`static/emulators.json`, `local` like the Super Famicom's — on the cartridge,
the IPL and a disk parked through `/api/n64dd-disk`. The cartridge leaves in
English: the 2024 translation's xdelta3 delta (`static/n64dd/`, 557,699 bytes,
two VCDIFF windows whose data, instruction and address sections are LZMA-packed
`.xz` streams) is applied by `src/n64/vcdiff.js` over `src/n64/xz.js` and the
result held to the SHA-1 its readme gives (`04D0423E…`; the Japanese dump is
`1C10A85A…`, 16,777,216 bytes, any of the three byte orders accepted and put in
z64 order first).

How the three files reach EmulatorJS 4.2.3's mupen64plus-next core was read out
of the sources — EmulatorJS's `emulator.js` and its RetroArch fork, and
libretro's `mupen64plus-libretro-nx` as the EmulatorJS fork builds it, and then
booted (below the list):

- The cartridge is the content: EmulatorJS writes the game to `/<name>` and
  starts the core on `/Dezaemon3D.z64`.
- The disk goes beside it as `/Dezaemon3D.z64.ndd` — the content's **full** name
  plus `.ndd`: `retro_load_game` appends `.ndd` to the cartridge's path and,
  when that opens, keeps it as the disk (`libretro.c`, the "workaround for
  broken subsystem"). The `ndd` subsystem (disk + cartridge) exists but only
  RetroArch's `--subsystem` reaches it; no core option attaches a disk.
- The IPL goes to `/Mupen64plus/IPL.n64`: the path is hard-coded under the
  core's system directory (`main.c`, `"Mupen64plus" + "/" + "IPL.n64"`), its
  byte order read from its first word, and the EmulatorJS RetroArch build leaves
  the system directory empty so RetroArch falls back to the content directory,
  `/`. It is read only when a disk was found; without it the core logs "Failed
  to load DD IPL ROM" and the cartridge boots in ROM mode.
- Both are placed through `EJS_externalFiles` —
  `{"/Dezaemon3D.z64.ndd":
  bytes, "/Mupen64plus/IPL.n64": bytes}` — the one
  hook that writes a file at a given path, directories made, before the core
  starts. The values must be bytes: in 4.2.3 a URL-string entry is fetched to an
  `ArrayBuffer` that Emscripten's `FS.writeFile` refuses, and the failure is
  swallowed. `EJS_biosUrl` cannot do it (it names the file after the URL and
  writes to `/`), and a `File` given to it hangs the loader.
- The core validates the `.ndd` the way `readSystemArea()` does
  (`scan_and_expand_disk_format`), takes the region from its system data, and
  redirects every write to a full copy `/Dezaemon3D.z64.ndd.disk_save`, which it
  prefers over the `.ndd` on the next load. EmulatorJS persists neither; the
  page's SAVE DISK button downloads the copy (or the untouched disk), and a disk
  handed back as the next launch's disk is read in place.
- Not possible with this core: booting a disk with no cartridge (its
  `valid_extensions` have no `ndd`); a second content file through EmulatorJS's
  configuration. `parallel_n64`, the other EmulatorJS N64 core, classifies a
  lone `.ndd` as a disk and boots the IPL on it, but pairs no cartridge with it
  and keeps the disk inside a 70 MB `.srm` — so the page asks for
  `mupen64plus_next` and a player who switched cores in EmulatorJS's menu gets
  no disk.
- Two cartridge-side cautions from the translation's readme. Dezaemon 3D saves
  to 768 Kbit banked SRAM; the core's SRAM is 32 KB, so bank 0 works and the
  other two are lost, and the game's boot-time save test may or may not pass. In
  disk mode the game copies `DEZA3D.SYS` from the cartridge's save when the disk
  has none — a disk built without a donor has none, since the writable area is
  not written — and refuses to go on when that copy fails.

That was written from the sources; on 2026-10-20 it was **booted** (Claude's
browser pane, the CDN's 4.2.3, the translated cartridge `04D0423E…` and
`64DD_IPL.n64` staged by `n64:stage`, disks built on `deza1.NDD`), and the
recipe holds as written: the core finds `/Dezaemon3D.z64.ndd` and
`/Mupen64plus/IPL.n64`, the cartridge goes into disk mode, and GAME SELECT lists
`DST` (RAM), `SAMPLEZ1`, `SAMP` and the project a build put on — which loads,
shows its high scores and title, and plays. A disk built from nothing was not
tried. What driving it took, for the next session (the scripts were scratch):

- **Input.** `gameManager.simulateInput(0, index, value)`: RetroPad 0 is the
  N64's **A** (confirm) and 1 its **B** — the page's `PAD` comment, which calls
  8 A, has them the wrong way round — 3 START, 4-7 the d-pad, 16-19 the stick
  right, left, down, up (32767 full). The select screen's pointer moves half a
  pixel a frame on the d-pad, so a d-pad hold is a repeatable path; its hot spot
  is about 9 px above the drawn hand, and the list's ▼ (about 140, 176) scrolls
  it a row a press. START on the menu, or a press before a screen has settled,
  can land in the editor or a cartridge demo, and once an A went unanswered on
  GAME SELECT with the project highlighted — a fresh boot is the remedy.
- **Hidden pane.** The pane throttles `requestAnimationFrame` to a few frames a
  second; a `MessageChannel`-paced replacement installed before `loader.js`
  runs the core at 60 (fast-forward with ratio 0 reaches about 100).
- **Pictures.** The core's own screenshot is black; with `preserveDrawingBuffer`
  forced the canvas can be read, but when the pane's size or pixel ratio
  changes the canvas shows a zoomed corner until a reload, so the pane's own
  screenshot at 0.4 (320×240, the N64's pixels) was the reliable one.
- **State.** RDRAM sits in `Module.HEAPU8` (found by the cartridge's boot code
  from ROM `0x1000`; `0xF6D0000` in that build), a word at its host order. A
  save state restored after a project has loaded leaves a grey screen, and so
  does a `restart()`; each test was a page load.
- **Writing test disks.** `buildDisk()` refuses a project whose file straddles
  the zone change at LBA 268 (`layoutFiles()` counts the blocks across it,
  `checkDirectory()`'s `blocksFit` by the starting zone); keeping the donor's
  two samples starts a new project at 368 and avoids it.

## Unresolved

- the 834 bytes at the head of the directory block, and whether 834 slots is the
  array's length or one disk's zero fill (`DIRECTORY_SLOTS` is measured,
  `encodeDirectory()` takes it as a parameter);
- the writable directory's slot count (480 is inferred), the full rules of the
  allocation map and fragmentation, and the contents of `DEZA3D.SYS` and
  `DEZA3D.HSC`;
- the system area's `PTN64` and company code, and the prototype's three filler
  area LBAs — why `0x1016` / `0x1C22` / `0x282E`;
- the notice's exact separators in the prototype's boot program, and the
  8,488-byte pad after it;
- the meaning of what `records.js` encodes: its layouts re-encode the
  cartridge's own initial save byte for byte, but the units of a face's UV pairs
  and a tile's offset, the tile index base, the disk-mode `#BL` tail's last
  three words, and the gaps the documentation itself marks `???` (`#MD`
  `+0xC11`–`0xC1F`, `#BL` `0x47`, `0x5B`, `0x8B2F`, `GAM` `0x1`, `0x225`,
  `0x557`, `0x558`) are carried, not understood;
- the nine bytes the two `GAM` files are short, which a retail disk would
  settle, except that none exists;
- the `MUS` sequence body: 24 × 0x2C80 bytes with no description at all, and no
  cheap route, since the playback code is on a cartridge nobody has;
- whether a disk built from nothing puts the cartridge into disk mode (one built
  on `deza1.NDD` does, booted), and where a level's placements belong on the
  screen (see "What the writer does not write");
- whether `buildDisk()`'s straddle-aware block count or `blocksFit`'s
  start-zone count is the game's reading for a file across LBA 268;
- the other six disk types' directory blocks, if a disk of another type ever
  carried ATNFS.

## Method

The read path came out of the bytes and the prior art together, on 2026-09-19: a
canonical dump of the same disk on 64dd.org, which settled what a `.ddd` is by
subtraction, and the fan translation's `file formats.txt`, whose sizes are the
predictions the extraction was tested against. Every offset and stride on the
parity page was measured against the bytes and re-measured independently before
it was written down, and the one claim everything else rests on — that the chain
from LBA to decompressed file is right — was tested the only way this platform
allows: by predicting 60 output sizes and hitting 58 exactly, with the two
misses on the two files the documentation names as malformed.

The geometry was then completed from the published tables rather than from the
disk — the 60 sample files all lie below user LBA 368, where the map is two
zones, and reaching the directory block needs all sixteen — and held to the disk
by the three measurements in **Container geometry**, and to leotools' `leogeo.c`
and mupen64plus-core's `disk.h` / `disk.c` by the tests (the per-zone last LBAs,
the type permutations, the RAM start of every type, the RAM area's length). The
system area follows the same two readers and the emulator's own acceptance test.

The writer was judged by the reader. `tests/dezaemon_n64_write_test.ts` builds
synthetic disks and reads every one back through `readDirectory()`,
`checkDirectory()`, `extractFile()` and `readSystemArea()`; `buildDisk()` does
the same to every disk before it returns it. The one test that needs the real
thing — the prototype re-laid from its own projects is the same 64,458,560
bytes; put a project on, the save area is untouched; take it off, the prototype
is back — is `ignore:`-gated on `dev-fixtures/dezaemon298.ddd` and skips in a
checkout without it, as the reader's 58-of-60 test does.

The probe (`tools/n64-ddd`) writes what a disk holds — `ls` the directory, `get`
one file decompressed, `png` a sheet as a contact sheet of its tiles, `report`
the regions and invariants, `sys` the system area as an emulator reads it, `all`
the lot — and takes a `.ddd` or an `.ndd`, told apart by length:

```
deno task n64:probe all <disk> --out build/n64/<name>/
deno task n64:probe put <disk> <dir> --as NAME --out <path> [--ndd|--ddd]
deno task n64:probe rm <disk> NAME --out <path> [--ndd|--ddd]
deno task n64:probe convert <disk> --out <path> [--ndd|--ddd]
```

Its three writing verbs — `put`, `rm`, `convert` — are the writer above on a
disk file: `put` presses a directory of the thirty files on as a project, `rm`
takes one off, `convert` goes between the two image formats; each writes to
`--out` (never the input) and reads the result back first. `build:ddd` builds a
disk from a level.

What would move the open items, in order of cost: decompiling the three Python
bytecode bodies inside `DezaDiskTool.exe` (a `Filetable` class, a `known_sizes`
table, an 8.3 name helper, an LBA-usage checksum, its LZSS module) hands over
the size table and the compressed-extension list as someone else's tested code —
half a day, and it retires most of the record questions; `deza1.NDD` beside the
fixture gives a second reading of the writable area, which is the only way to
see the allocation map move; a controlled delta needs a 64DD emulator with a
disk writer and the DEZA64 cartridge, and the cartridge was never released, so
for anything not provable by arithmetic this platform's ceiling is likely.
