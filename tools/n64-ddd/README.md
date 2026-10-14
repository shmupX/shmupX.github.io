# tools/n64-ddd — look inside a Dezaemon 3D 64DD disk, and write one

```
deno task n64:probe ls <disk>
deno task n64:probe get <disk> <NAME.EXT> --out <path>
deno task n64:probe report <disk> [--stats] [--out <dir>]
deno task n64:probe png <disk> <NAME.EXT> --out <path> [--columns N]
deno task n64:probe all <disk> --out <dir>
deno task n64:probe sys <disk>
deno task n64:probe put <disk> <dir> --as NAME --out <path> [--ndd|--ddd]
deno task n64:probe rm <disk> NAME --out <path> [--ndd|--ddd]
deno task n64:probe convert <disk> --out <path> [--ndd|--ddd]
```

Reads and writes the Dezaemon 3D (Athena, 1997) 64DD data disk — the prototype
written 1998-02-23 from a Partner-N64 unit for an expansion that was never
released. `<disk>` is a `.ddd` (the user area of the disk, 64,458,560 bytes,
what the 2018 dump is) or an `.ndd` (the whole disk, 64,931,840 bytes, its
24-block system area first, what an emulator mounts); every verb takes either,
told apart by length and never by name. The reader and the writer live in
`packages/shmup-engine/src/n64/`, the notes in
`packages/shmup-engine/FORMAT-N64.md` and the format's status on
`static/dezaemon-parity-n64.html`.

- `ls` lists the ATNFS directory: slot, project name, extension, start LBA,
  block count, stored (compressed) size, byte offset in the user area, and the
  decompressed size the format documentation predicts.
- `get` writes one file out, decompressed through the repo's own Okumura LZSS
  decoder, and warns when the result is not the documented size — the decoder
  cannot fail on its own, so the size is the only evidence that the stream was
  read right.
- `report` prints the image's size and recognition (the boot program's own
  "DEZA64 DATA DISK" notice), the directory grouped by project, and the three
  invariants the directory is meant to satisfy — `contiguous`, `blocksFit`,
  `withinCapacity` — followed by the listing. For an `.ndd` it also prints the
  system area block that `sys` prints. `--stats` adds the entropy and the
  0x00/0xFF share of every region, which walks all 64 MB. `--out <dir>` writes
  `report.txt` and `report.json`.
- `png` renders a graphics sheet (`CGR`, or a stage's `#GR`) as a contact sheet
  of its 64×32 RGBA5551 tiles, `--columns` to a row.
- `all` writes `report.txt`, `report.json`, every file as
  `<dir>/<NAME>/<EXT>.bin` and every graphics sheet as `<EXT>.png` beside it.
  That per-project directory is exactly what `put` takes back.
- `sys` prints the system area of an `.ndd` the way mupen64plus-core reads it
  before mounting a disk: which of LBA 0–3 / 8–11 holds a system data record
  whose 85 sectors agree (retail or development format), its region, format
  byte, disk type, IPL load size and address, ROM end and RAM start/end LBAs;
  then the disk ID from LBA 14 or 15 — initial code (`DEZA`), version, disk
  number, RAM use, disk use, the BCD timestamp, the company code and the free
  area (`ATNFS0`). For a `.ddd` it says `none (a .ddd)`, because that format
  carries no system area.
- `put` lays the files in `<dir>` onto the disk as project `NAME` — eight
  letters and digits, anything else dropped — replacing a project of that name
  if there is one. `<dir>` holds the files as `all` writes them, `<EXT>.bin`
  (`CGR.bin`, `0GR.bin`, …; a `NAME.EXT.bin` spelling is taken too), the PNGs
  and reports beside them ignored. Each is LZSS-compressed; a file that is not
  its documented size, an extension that is not one of a project's thirty, and a
  project short of thirty files are each warned about rather than refused.
- `rm` drops a project and re-lays the rest. A name not on the disk is refused
  with the names that are.
- `convert` writes the other format: an `.ndd` from a `.ddd` gets a system area
  built for a type-0 disk (region Japan, retail format, the prototype's IPL
  fields, disk ID `DEZA` with `ATNFS0` in the free area, dated now); a `.ddd`
  from an `.ndd` is the user area alone. The format comes from `--ndd`/`--ddd`,
  else from the `--out` extension. Nothing in the user area changes.

**What the write verbs honour.** The three that write — `put`, `rm`, `convert` —
honour what the reader measured on the prototype and nothing more: the files go
end to end from LBA 9 in directory order (the six globals, then `BL` `MD` `GR` a
stage), each file's block count being the blocks its bytes span from where it
starts — the block shrinks from 19,720 to 18,360 bytes at LBA 268 — and the next
starting on the block after; the unwritten run up to the directory's block is
0xFF; the read-only directory is written three times, 834 bytes into LBA 1417,
1419 and 1422; and the RAM area, LBA 1418 to 4291, is carried byte for byte from
the input — the two directory copies that sit inside it are rewritten, the rest
is not touched. The format of the image written is `--ndd`/`--ddd`, else the
`--out` extension, else the input's; an `.ndd` keeps the input's system area, or
gets a built one when the input was a `.ddd`. Every disk is read back through
the reader — directory, invariants, every new stream decompressed and compared —
before it is saved. `--out` is required and never names the input: the two are
compared as the kernel sees them (dev + ino when both exist), so a symlink or
another spelling of the same name is refused too, and the only copy of a disk
that is never committed survives.

**What they do not touch.** A project `put` writes is a _pressed_ one, in the
read-only directory beside the prototype's two samples (`SAMPLEZ1`, `SAMP`), not
a saved one. Nothing writes the writable directory, its per-block allocation
map, or the cartridge's own `DEZA3D.SYS` and `DEZA3D.HSC`: their layout is only
partly known (section 03 of the parity page — save-area files can be fragmented,
and there is no checksum to tell a wrong guess from a right one), so they are
carried as found. The boot program in LBA 0–8 is likewise carried, never
rewritten. A disk converted or rebuilt from the prototype therefore keeps what
the cartridge needs to go into disk mode; what the cartridge makes of a third
project in the read-only directory is unknown — nothing here has been tried on
hardware or in an emulator, because no cartridge, emulator or disk fixture
exists to try it on.

The other direction — a level record INTO a disk — is `deno task build:ddd`
(`packages/shmup-harbor/scripts/build-ddd.ts` over
`packages/shmup-engine/src/n64/export-ddd.js`), which lays the level's art into
the free textures of the `CGR` and stage `GR` sheets and takes every other file
from a template project on a donor disk — by default the first 64DD image in
`dev-fixtures/`, an `.ndd` before a `.ddd` — or writes zero bytes at the
documented size without one. Nothing on the disk refers to the textures it lays,
so the result is the disk with the level's art on it, not a playable Dezaemon 3D
game. `n64:probe report` on a built image is the quickest check that its
directory and system area read back; `sys` on a built `.ndd` shows the system
area an emulator would validate.

The disk is community content and is never committed; `dev-fixtures/` is
gitignored, so a path is given explicitly rather than discovered, and the
fixture-gated test (`tests/dezaemon_n64_test.ts`) skips without it. One caution
if you go past the sample projects: 64dd.org labels `dezaemon298.ddd` the old
dump, and it differs from the current `deza1.NDD` in 175,897 bytes, every one of
them inside the save area where the `DST` user project lives. The two pressed
samples are byte-identical between the dumps, so everything above holds for them
— but read `DST` from `deza1.NDD`, not from the old dump, and expect a disk
rebuilt from the old dump to carry its save area as it is.
