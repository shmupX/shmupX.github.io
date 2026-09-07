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
  chip indices as colours when the dump has no graphics, chips through the
  graphics bank when it does (a guess at the bank layout — see FORMAT-SFC.md
  "GRAPIC DATA"). `png scroll` plots a stage's scroll table. `png graphics` and
  `png groups` need a dump with graphics and say so otherwise.
- `hex` dumps a half-open range with its region name; `diff` lists the ranges
  two dumps differ in, by region — the tool for controlled-delta captures.
- `all` writes everything above into one directory.

Neither saves nor the ROM are committed. The fixture-gated tests read
`packages/shmup-engine/fixtures/dezaemon-sfc-sample.sav` and the ROM in
`dev-fixtures/`; both directories are gitignored.
