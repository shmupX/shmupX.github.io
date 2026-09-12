# tools/psx-sav — look inside a PlayStation Dezaemon save

```
deno task psx:probe report <sav>
deno task psx:probe png <sav> icon|graphics|palettes|map|cells --out <path>
                          [--stage N] [--page N] [--row N] [--scale N] [--rows N]
deno task psx:probe hex <sav> --range A:B [--section header|graphics|data|tail]
deno task psx:probe diff <a.sav> <b.sav>
deno task psx:probe all <sav> --out <dir>
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

Saves are community content and never committed; the fixture-gated tests read
the collection in the repo-root `dev-fixtures/` (`Dezaemon Kids!/`,
`Dezaemon+/`).
