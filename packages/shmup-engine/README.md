# @shmupx/shmup-engine

The Dezaemon 2 (Sega Saturn) save-game import pipeline: parse Saturn backup-RAM
images, decode a user-created game out of its `.sav` (LZSS + per-section
decoders), map it to the level editor's `game.json` format, pack a texture
atlas, and validate the result — and, since 2026-09-05, the way back: a level
record plus its RGBA frames -> a MiSTer-layout `.sav`, with the art reduced to
the Saturn or Super Famicom palette (`exportLevelToSav`).

This package is the source of truth for the engine that was previously vendored
into cmg as `static/editor/dezaemon/lib` (and lives upstream as
`tools/dezaemon-import/lib` in the 2019-es7 repo). Every module is
environment-neutral ESM — no DOM, no canvas, no fetch; just `DataView`,
`TextEncoder`/`TextDecoder("shift-jis")` and `DecompressionStream`, all
available in Deno, browsers, and modern Node.

**New here?** [DECODING.md](DECODING.md) walks one worked example per kind of
output — a colour, a pixel, a sprite, an enemy, a boss, a background tile, a
setting, a note, a 3D shape — showing the exact bytes, what they become, and the
line that does it. [FORMAT.md](FORMAT.md) is the full field reference.

## The pipeline

```js
import {
  decodeSave,
  isGameSave,
  mapSaveToGame,
  normalize,
  packShelf,
  parse,
  validateGameJson,
} from "@shmupx/shmup-engine";

// 1. Raw bytes of a Saturn backup-RAM image (.sav/.bcr/.bkr — raw,
//    gzipped, or interleaved cartridge dumps are all handled).
const bytes = await Deno.readFile("ramsie.sav");
const { data } = await normalize(bytes);

// 2. Parse the BackUpRam Format directory and reassemble block-accurate
//    payloads, then pick the Dezaemon 2 game save.
const save = parse(data).filter(isGameSave)[0];

// 3. Decode the save: section table, LZSS decompression, CG pages/palettes,
//    stages, enemies, bosses, songs — with per-layer confidence levels.
const decoded = decodeSave(save.payload.buffer);

// 4. Map to the editor's game.json + a sprite list (RGBA frames).
const { gameJson, sprites, warnings } = mapSaveToGame(decoded, {
  sourceEntry: save,
});

// 5. Pack the sprites into atlas geometry. packShelf returns geometry only
//    ({width, height, places}) — the caller does the pixel blitting into
//    whatever surface it has (canvas, PNG encoder, ...).
const atlas = packShelf(sprites.map((s) => ({ w: s.w, h: s.h, data: s })));

// At any point: validate a game.json.
const { ok, errors, warnings: schemaWarnings } = validateGameJson(gameJson);
```

And back again — a level record (the cloud save shape: `enemylist`, `width`,
`enemyData`, `bossData`, ... or `stages.stageN`) and its atlas frames as RGBA:

```js
import { exportLevelToSav } from "@shmupx/shmup-engine";

// art: { "redEyeOcto0.png": { w, h, rgba }, ... } — the caller slices the
// atlas (a canvas in the browser, lib/ps2/png.ts in Deno); the module has no DOM.
const { sav, fileName, warnings, report } = exportLevelToSav(level, art, {
  palette: "saturn", // or "snes": one 15-colour row per sprite
  title1: logoRgba, // optional {w, h, rgba} for the drawn TITLE 1 / TITLE 2
  itemEmblems: { 8: speedIcon }, // optional 16×16 icon per type; else a square
});
await Deno.writeFile(fileName, sav); // "Dez 2 - <name>.sav", 1,114,112 bytes
```

Under the hood: `buildSaveFromGame` (level + art -> the eight raw sections:
palette target, CG cell packing, stages/records/banks/settings), `buildPayload`
(LZSS `compress` + the checksummed section table) and `buildBupImage` (a
formatted 32 KB + 512 KB BackUpRam image, 0xFF-interleaved).
`deno task build:sav` is the CLI over it; the level editor's DOWNLOAD .SAV runs
the same code in the page.

## Export surface

The root module (`mod.js`) flat-exports the surface the level editor binds as
`window.Dezaemon`:

- **`./src/bup-source.js`** — `normalize`, `gunzip`, `isGzip`
- **`./src/bup-parse.js`** — `parse`, `MAGIC`, `ENTRY_FLAG`, `detectPartitions`,
  `parseEntry`, `bupDateToDate`, `extractPayload`, `findEntries`
- **`./src/payload-table.js`** — `parseSectionTable`, `validateSectionTable`,
  `isGameSave`, `byteSum`, `TABLE_SIZE`, `SECTION_COUNT`
- **`./src/map-to-game.js`** — `mapSaveToGame`, `buildBlankGame`, `emptyWave`,
  `enemyLetters`, `decodePlayerArt`, `DUKE_PLAYER`, `EVIL_INVADERS_PLAYER`,
  `BUILTIN_DEFAULTS`, `GRID_COLS`, `MAX_STAGES`, `SINGLE_LETTER_ENEMIES`,
  `BLANK_WAVES`, `FRAMES_PER_SOURCE_ROW`, `PLAYER_SHOT_DAMAGE_BY_LEVEL`,
  `ENGINE_SHOT_DAMAGE`, `ENEMY_BULLET_SPEED`
- **`./src/decode/index.js`** — `decodeSave`
- **`./src/cover/compose-cover.js`** — `composeCover`, `COVER_W`, `COVER_H`,
  `renderTitlePage`, `inkStats`: a decoded save → the 256×480 title-screen shot
  every shelf in the app wears, as raw RGBA (the caller encodes it — Deno with
  `jsr:@img/png`, a browser with a canvas). The drawn KUMITATE TITLE page over
  the busiest screenful of the game's own scenery, falling back to the biggest
  boss, then a strip of enemies, then CG page 0, so every save gets a picture of
  itself. The drawing internals (`blit`, `makeCanvas`, `drawBackdrop`,
  `pickBackdrop`, `readBankBlock`, `imgInk`, the geometry constants) stay behind
  the `./cover` subpath — their names are too general for a flat surface that
  becomes `window.Dezaemon`.
- **`./src/decode/decode-model.js`** — `decodeModels` (sec7, the ポリ吉 3D
  compositions), `MODEL_SLOTS`, `SEC7_MAGIC`, `SHAPE_FAMILIES`,
  `FAMILY_MESH_COUNTS`, `FAMILY_FILE_RANGES`
- **`./src/decode/decode-cg.js`** — `rgb555ToRgb`, `rgb555ToHex` (the CG page
  decoders themselves stay behind the `./decode` subpath)
- **`./src/model/mesh-library.js`** — the 224-mesh ポリ吉 part library: the
  `(family, meshIndex)` index (`libraryIndex`, `mdldtFileFor`, `familyForFile`,
  `FAMILY_OFFSETS`), `meshFor`, procedural placeholders (`placeholderMesh`,
  `placeholderLibrary`), `makeMesh`, `polygonNormals`, `meshBounds`, and the
  JSON form (`serializeMeshLibrary`, `meshLibraryFromJson`)
- **`./src/model/decode-mdldt.js`** — `decodeMdldt`, `buildMeshLibrary` (SGL
  `PDATA` out of decompressed `MDLDT_NN.CMP` bytes the caller supplies)
- **`./src/model/model-mesh.js`** — a model as world-space triangles and a frame
  of screen-space ones for Phaser's `Mesh2D`: `composeTransform`,
  `buildModelMesh`, `allocFrame`, `orbitCamera`, `projectModel`,
  `buildSwatchTable` / `swatchUV` / `swatchRgb`, `packMesh2D`,
  `wireframeSegments`, `quantizeRotation`, `ROT_ORDERS`, `modelStats`
- **`./src/audio/tone-bank.js`** — `cutLayer`, `uniqueSlices`, `instrumentAt`,
  `layerAt`, `pickLayers`, `playbackRate`, `SCSP_BASE_RATE`, … (the Saturn
  timbres out of a caller-supplied `SNDPAC.BIN`)
- **`./src/cd/iso9660-read.js`** — `openDisc`, `readFile`, `listFiles`,
  `findEntry`, `readExtent`
- **`./src/atlas-pack.js`** — `packShelf`
- **`./src/game-schema.js`** — `validateGameJson`
- extras: `decompress`, `decompressCmp` (disc `.CMP` files), `SECTION_SIZES`,
  `SECTION_HINTS` (LZSS + section geometry), `detect`, `deinterleave` (cartridge
  dumps), `coalesceDiffRanges`, `totalDiffBytes` (byte-range diffing)
- **`./src/compress.js`** — `compress`, `compressCmp`: the LZSS encoder, the
  exact inverse of `decompress`
- **`./src/bup-write.js`** — `buildPayload`, `buildBupImage`, `buildGameSave`,
  `formatPartition`, `writeSaveEntry`, `dataBlocksFor`, `interleave`,
  `bupDateFromDate`, `encodeComment`, `gameSaveFilename`, `BUP_LANGUAGE`,
  `MISTER_SAV_SIZE`, …: the BackUpRam image writer
- **`./src/palette/palette-target.js`** — `PALETTE_TARGETS`, `quantizeFrames`
  (RGBA frames -> CG pixel bytes + the sec4 bank under `saturn` or `snes`),
  `medianCut`, `colorHistogram`, `emptyBank`, `bankToSec4`, `bankToPalettes`,
  `snesCgramBytes`, `frameGroup`
- **`./src/write/cg-pack.js`** — `CgPacker` (shared 16×16 cells over the four
  pages, mirror-aware), `CgFullError`, `REF_HFLIP`, `REF_VFLIP`
- **`./src/write/game-to-save.js`** — `buildSaveFromGame`, `levelStages`,
  `encodeEnemyRecord`, `enemyRecordFromEditor`, `encodeBossTrailer`,
  `encodeSettings`, `emptySong`, `emptySongBank`, `fitRgba`, `bandFor`,
  `bossClassFor`, `mapColumn`, `spreadFrames`, `blastFrames`, `itemIcon`, …
- **`./src/write/export-sav.js`** — `exportLevelToSav`, `savFileName`,
  `savComment`

`buildSaveFromGame` paints the drawn title screen from `title1`/`title2` when
the caller has images (the editor's TITLE EDITOR uploads), and otherwise from
the level's own `dezaemonTitle` + `dezaemonTitleScreen.layout` — the atlas frame
names and slot placements `mapSaveToGame` produced when the game was imported
from a cart. That fallback, plus the six credit strips it writes alongside, is
what lets a community save go import → export → play without losing its title
to the host runtime's own. `report.title.source` is `"cart"`, `"uploaded"` or
`"none"`.

The deeper decoder internals (per-section decoders, player art, and so on) are
importable through subpath exports: `@shmupx/shmup-engine/decode`,
`.../map-to-game`, `.../bup-parse`, `.../bup-source`, `.../bup-deinterleave`,
`.../payload-table`, `.../decompress`, `.../atlas-pack`, `.../game-schema`,
`.../player-art`, `.../player2-art`, `.../diff-ranges`, `.../tone-bank`,
`.../iso9660-read`, `.../mesh-library`, `.../decode-mdldt`, `.../model-mesh`,
`.../compress`, `.../bup-write`, `.../palette-target`, `.../cg-pack`,
`.../game-to-save`, `.../export-sav`, `.../cover`.

`FORMAT.md` documents the reverse-engineered save format; `games-db.json` is the
catalog of known community games.

## Super Famicom Dezaemon (`./sfc`)

`@shmupx/shmup-engine/sfc` reads the 1994 Super Famicom cart's battery SRAM — a
raw 128 KB dump, nothing like the Saturn image above. It is a structural parser:
`parseSfcSav(bytes, {rom})` returns every region the ROM's own memory map names
(palette rows, the six stage maps and scroll tables, the tile groups, high
scores, configuration words, the graphics bank when the dump has one) with a
confidence per block, and never throws on content. Pieces: `sram.js` (container,
`T.TABATA` magic, checksum copy), `regions.js` (the map), `cgram.js` (BGR555
rows), `tiles.js` (4bpp/2bpp planar codec), `tilemap.js` and `groups.js`
(tilemap-word quads), `map.js`, `tables.js`, `enemy.js`, `graphics.js`, and
`rom.js` (header, the ROM's region table, its default SRAM image). It stays
behind the subpath — `mod.js` is the Saturn editor bundle. `FORMAT-SFC.md` holds
the notes; `deno task sfc:probe` (`tools/sfc-sav/`) renders what a dump
contains.

## Tests

```
deno test -A packages/shmup-engine
```

The golden tests run against community-created Saturn saves (`ramsie.sav`,
`mucha-kucha.sav`, `baseline-cart.bcr`, `baseline-internal.bkr`) — the writer's
among them: each fixture's sections must round-trip through `compress`, and a
cart rebuilt from Ramsie's own sections must decode identically. Those fixtures
are **not** committed (see the repo `.gitignore`) — tests that need them are
fixture-gated and report as `ignored` when the files are absent. Drop the
fixtures into `packages/shmup-engine/fixtures/` to run the full suite. The
`src/` tree is copied verbatim from upstream and is excluded from
`deno fmt`/`deno lint`.
