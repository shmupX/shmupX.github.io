# tools/psx-sav — look inside a PlayStation Dezaemon save

```
deno task psx:probe report <sav>
deno task psx:probe png <sav> icon|graphics|palettes|map|cells --out <path>
                          [--stage N] [--page N] [--row N] [--scale N] [--rows N]
deno task psx:probe hex <sav> --range A:B [--section header|graphics|data|tail]
deno task psx:probe diff <a.sav> <b.sav>
deno task psx:probe all <sav> --out <dir>
deno task psx:probe edit <sav> --out <path> [--set <field>=<value>]... [--force]
```

Reads Dezaemon+ (1996) and Dezaemon Kids! (1998) saves in whatever wrapping a
dump has — a raw 128 KB memory-card image, a DexDrive `.gme`, a single-save
`.mcs`, a PS3 `.psv`, or the bare save blocks. The parser lives in
`packages/shmup-engine/src/psx/` and its notes in
`packages/shmup-engine/FORMAT-PSX.md`.

- `report` prints the container, the save's title and game name, the region
  tables with a confidence each, and per stage what it actually holds: chips,
  spawns, enemy definitions, the boss's size class. For Kids! it verifies the
  three byte-sum checksums and prints the game settings and the high scores with
  the stage each run reached; for Dezaemon+ it recomputes the program's own
  twenty group checksums and names any group that fails.
- `png map` draws a stage **the way the game draws it**: a Kids! stage as 32×32
  chips, each built from a 2×2 group of the save's CG cells and coloured through
  the fixed disc palette; a Dezaemon+ stage through that stage's MAP GROUP table
  into the save's graphics pages and its own palette row. Both apply the
  horizontal and vertical flips. `--rows N` crops a long stage.
- `png cells` (or `graphics`) draws the graphics bank itself: Kids!'s four CG
  pages, or Dezaemon+'s 256×512 4bpp bitmap through palette row `--row`.
  `png palettes` draws the colour bank — Kids!'s fixed 256 entries as a 16×16
  grid, Dezaemon+'s own 24 rows — with a white corner on STP-flagged colours.
  `png icon` draws the save's memory-card icon through its own CLUT.
- `hex` dumps a half-open range, naming the region it starts in; for a Kids!
  save `--section graphics|data|tail` addresses a decompressed section instead
  of the raw file.
- `diff` lists the ranges two saves differ in, comparing Kids!'s decompressed
  sections rather than its compressed bytes — the tool for controlled-delta
  captures, which is how the open items in FORMAT-PSX.md get closed: change one
  thing in the editor, save, diff.
- `all` writes everything above plus `report.json` into one directory.
- `edit` is the only verb that writes, and it is surgical. Each `--set` goes
  through exactly one setter in `packages/shmup-engine/src/psx/plus-edit.js`,
  which refuses a value the traced tables cannot hold rather than clamping it;
  the nineteen checksum groups the game verifies are sealed once after the last
  `--set`, so an edit writes two more bytes per checksum group it dirties — a
  one-byte edit inside one group writes three bytes and usually differs in two,
  and a write that straddles a graphics quarter dirties two groups and seals
  four. The verb prints the counts it measured. The twentieth word covers the
  checksum array itself, does not converge, and is left as found. A card or a
  `.gme` goes back block by block along its directory chain — the save a parse
  hands you is a copy of those blocks, not a view of them — while an `.mcs` or a
  bare block run is patched in place and a `.psv` is refused outright, because
  its header carries a console signature this package can neither read nor
  regenerate. `--out` is required and never names the input — the refusal is by
  file identity, so another spelling of the same name, a symlink or a hard link
  is refused too, and the before-image a `diff` needs survives. With no `--set`
  it only reseals, which is the repair path for a save whose checksums fail;
  that and a Select 100 block with no `SC` frame both need `--force`. The fields
  are the ones whose value is a single scalar:

  ```
  stage-count=1..5      score-bonus=0..7       charge-time=0..5
  cursor-speed=0..2     menu-bgm=0..3|off      stereo=on|off
  keys=<m0>,<m1>,<m2>,<m3>                     bgm.<slot>=0..50
  item.<slot>=0..11     song.<to>=<from>
  hiscore.<rank>=<score>[:<stage>[:<16 hex digits>]]
  ```

  Bulk work — pixels, palette rows, map cells, appear records, enemy definitions
  — is the library's, not `argv`'s. A high-score name is eight bytes spelled as
  sixteen hex digits and never as text, because the field decodes
  byte-for-charCode and the Dezaemon+ font is untraced. An omitted `:<stage>` or
  `:<name>` preserves what the entry already holds and is not range-checked, so
  correcting a score never touches the stage a run reached — not even on a save
  whose stage count has since been lowered past it. A stage you do pass is
  checked. And a written byte whose offset within its table entry is a multiple
  of 32 is multiplied by zero, so no checksum can confirm it landed: the tool
  prints `checksum-blind` on those writes, and the answer there is `diff`, not
  the checksums.

Saves are community content and never committed; the fixture-gated tests read
the collection in the repo-root `dev-fixtures/` (`Dezaemon Kids!/`,
`Dezaemon+/`).
