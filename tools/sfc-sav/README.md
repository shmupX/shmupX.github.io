# tools/sfc-sav — look inside a Super Famicom Dezaemon SRAM dump

```
deno task sfc:probe report <sav> [--rom <sfc>] [--out <dir>]
deno task sfc:probe png <sav> palettes|graphics|map|scroll|groups --out <path>
                          [--row N] [--stage N] [--scale N]
deno task sfc:probe hex <sav> --range A:B
deno task sfc:probe diff <a.sav> <b.sav>
deno task sfc:probe all <sav> [--rom <sfc>] --out <dir>
```

The parser lives in `packages/shmup-engine/src/sfc/` and knows the regions the
ROM's own memory map names (`packages/shmup-engine/FORMAT-SFC.md`). This tool is
how to look at one particular dump: which regions carry data, whether the upper
64 KB (the graphics bank) is there at all, what the palettes look like, the
shape of each stage's map and scroll table.

- `report` prints the per-region statistics (entropy, zero and 0xFF share,
  blank/absent) with the parser's confidence for each, and writes `report.json`
  under `--out`. With `--rom` it also checks the ROM header, parses the ROM's
  region table and compares it with the parser's, and says whether the save's
  first 64 KB is still the ROM's factory image.
- `png palettes` draws the 24 palette rows as swatches. `png map` draws a stage:
  a stage map drawn through its MAP GROUP chips and the stage's own palette
  row, from the save's sheets or — with `--rom` — the ROM's factory sheets a
  cart like the sample draws from; without either, slot numbers as colours.
  `png scroll` plots a stage's two scroll tables (the block sequencer in blue,
  the speed table in yellow). `png graphics` draws the save's two 128x512 chip
  sheets through one row; `png groups` the assembled ship, title, ending,
  boss and enemy sheets, each through the row the game gives it (`--row`
  overrides). FORMAT-SFC.md "Chip words and the GROUP tables".
- `hex` dumps a half-open range with its region name; `diff` lists the ranges
  two dumps differ in, by region — the tool for controlled-delta captures.
- `all` writes everything above into one directory.

Neither saves nor the ROM are committed. The fixture-gated tests read
`packages/shmup-engine/fixtures/dezaemon-sfc-sample.sav` and the ROM in
`dev-fixtures/`; both directories are gitignored.
