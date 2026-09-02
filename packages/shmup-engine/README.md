# @shmupx/shmup-engine

The Dezaemon 2 (Sega Saturn) save-game import pipeline: parse Saturn backup-RAM
images, decode a user-created game out of its `.sav` (LZSS + per-section
decoders), map it to the level editor's `game.json` format, pack a texture
atlas, and validate the result.

This package is the source of truth for the engine that was previously vendored
into cmg as `static/editor/dezaemon/lib` (and lives upstream as
`tools/dezaemon-import/lib` in the 2019-es7 repo). Every module is
environment-neutral ESM — no DOM, no canvas, no fetch; just `DataView`,
`TextEncoder`/`TextDecoder("shift-jis")` and `DecompressionStream`, all
available in Deno, browsers, and modern Node.

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

The deeper decoder internals (per-section decoders, player art, and so on) are
importable through subpath exports: `@shmupx/shmup-engine/decode`,
`.../map-to-game`, `.../bup-parse`, `.../bup-source`, `.../bup-deinterleave`,
`.../payload-table`, `.../decompress`, `.../atlas-pack`, `.../game-schema`,
`.../player-art`, `.../player2-art`, `.../diff-ranges`, `.../tone-bank`,
`.../iso9660-read`, `.../mesh-library`, `.../decode-mdldt`, `.../model-mesh`.

`FORMAT.md` documents the reverse-engineered save format; `games-db.json` is the
catalog of known community games.

## Tests

```
deno test -A packages/shmup-engine
```

The golden tests run against community-created Saturn saves (`ramsie.sav`,
`mucha-kucha.sav`, `baseline-cart.bcr`, `baseline-internal.bkr`). Those fixtures
are **not** committed (see the repo `.gitignore`) — tests that need them are
fixture-gated and report as `ignored` when the files are absent. Drop the
fixtures into `packages/shmup-engine/fixtures/` to run the full suite. The
`src/` tree is copied verbatim from upstream and is excluded from
`deno fmt`/`deno lint`.
