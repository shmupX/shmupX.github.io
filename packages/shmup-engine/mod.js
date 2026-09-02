// @shmupx/shmup-engine — the Dezaemon 2 (Sega Saturn) .sav → game.json pipeline.
//
// Pipeline: bytes → normalize() (gunzip/deinterleave a backup-RAM image) →
// parse() (directory entries + block-accurate payloads) → isGameSave() filter →
// decodeSave() (section table, LZSS decompress, CG/stage/enemy/boss/song
// decoders) → mapSaveToGame() ({gameJson, sprites}) → packShelf() (atlas
// geometry; the caller blits pixels). validateGameJson() checks any game.json.
//
// This is a flat re-export of the surface the level editor binds as
// `window.Dezaemon`. Explicit named re-exports on purpose: `export *` chains
// would silently drop names that two modules both export (map-to-game.js
// re-exports DUKE_PLAYER/decodePlayerArt from player-art.js, and
// src/decode/decode-stage.js has its own MAX_STAGES). Deeper decoder internals
// stay reachable through the subpath exports declared in deno.json.

// --- Saturn backup-RAM sources (src/bup-source.js) ---
export { gunzip, isGzip, normalize } from "./src/bup-source.js";

// --- BackUpRam Format parsing (src/bup-parse.js) ---
export {
  bupDateToDate,
  detectPartitions,
  ENTRY_FLAG,
  extractPayload,
  findEntries,
  MAGIC,
  parse,
  parseEntry,
} from "./src/bup-parse.js";

// --- Save payload section table (src/payload-table.js) ---
export {
  byteSum,
  isGameSave,
  parseSectionTable,
  SECTION_COUNT,
  TABLE_SIZE,
  validateSectionTable,
} from "./src/payload-table.js";

// --- game.json mapping (src/map-to-game.js) ---
// decodePlayerArt/DUKE_PLAYER originate in src/player-art.js and
// decodePlayer2Art/TROOPER_PLAYER in src/player2-art.js; map-to-game
// re-exports them, so this module is their single flat-surface source.
export {
  BLANK_WAVES,
  buildBlankGame,
  BUILTIN_DEFAULTS,
  decodePlayer2Art,
  decodePlayerArt,
  DUKE_PLAYER,
  emptyWave,
  ENEMY_BULLET_SPEED,
  enemyLetters,
  ENGINE_SHOT_DAMAGE,
  EVIL_INVADERS_PLAYER,
  FRAMES_PER_SOURCE_ROW,
  GRID_COLS,
  mapSaveToGame,
  MAX_STAGES,
  PLAYER_SHOT_DAMAGE_BY_LEVEL,
  SINGLE_LETTER_ENEMIES,
  TROOPER_PLAYER,
} from "./src/map-to-game.js";

// --- Save decoding (src/decode/index.js) ---
export { decodeSave } from "./src/decode/index.js";

// --- sec7 3D models (src/decode/decode-model.js) ---
export {
  decodeModels,
  FAMILY_FILE_RANGES,
  FAMILY_MESH_COUNTS,
  MODEL_SLOTS,
  SEC7_MAGIC,
  SHAPE_FAMILIES,
} from "./src/decode/decode-model.js";

// --- Saturn RGB555 (src/decode/decode-cg.js; the CG decoders themselves stay
// behind the ./decode subpath) ---
export { rgb555ToHex, rgb555ToRgb } from "./src/decode/decode-cg.js";

// --- The ポリ吉 part library: index, placeholders, JSON form (src/model/mesh-library.js) ---
export {
  COLOR_SETS,
  FAMILY_OFFSETS,
  familyForFile,
  familyOfLibraryIndex,
  LIBRARY_MESH_COUNT,
  libraryIndex,
  makeMesh,
  mdldtFileFor,
  mdldtFileName,
  meshBounds,
  meshFor,
  meshLibraryFromJson,
  MODEL_UNIT_RADIUS,
  placeholderLibrary,
  placeholderMesh,
  polygonNormals,
  serializeMeshLibrary,
} from "./src/model/mesh-library.js";

// --- MDLDT_NN.CMP reader, the real part library off a disc (src/model/decode-mdldt.js) ---
export {
  buildMeshLibrary,
  decodeMdldt,
  MDLDT_BASE,
  MDLDT_FILE_COUNT,
} from "./src/model/decode-mdldt.js";

// --- Model -> triangles: transforms, camera, projection, Mesh2D packing (src/model/model-mesh.js) ---
export {
  allocFrame,
  buildModelMesh,
  buildSwatchTable,
  composeTransform,
  LIGHT_AZIMUTH,
  LIGHT_TILT,
  LIGHT_VIEW,
  MAX_SWATCH_COLORS,
  modelStats,
  NEAR,
  normalMatrix,
  orbitCamera,
  packMesh2D,
  projectModel,
  quantizeRotation,
  ROT_ORDERS,
  ROTATION_ORDER,
  ROTATION_QUANTUM,
  saturnLightView,
  SHADE_FLOOR,
  SHADE_LEVELS,
  SHADE_ZERO,
  shadeRgb555,
  shadeRow,
  SWATCH_LAYOUT,
  swatchCell,
  swatchCellRect,
  swatchRgb,
  swatchUV,
  tintRgb555,
  transformPoint,
  wireframeSegments,
} from "./src/model/model-mesh.js";

// --- Atlas packing (src/atlas-pack.js) ---
export { packShelf } from "./src/atlas-pack.js";

// --- game.json validation (src/game-schema.js) ---
export { validateGameJson } from "./src/game-schema.js";

// --- Extras: LZSS + section geometry (src/decompress.js) ---
export {
  decompress,
  decompressCmp,
  SECTION_HINTS,
  SECTION_SIZES,
} from "./src/decompress.js";

// --- Extras: cartridge-dump deinterleaving (src/bup-deinterleave.js) ---
export { deinterleave, detect } from "./src/bup-deinterleave.js";

// --- Tone bank: real Saturn samples out of SNDPAC.BIN (src/audio/tone-bank.js) ---
export {
  cutLayer,
  INSTRUMENT_COUNT,
  instrumentAt,
  LAYER_COUNT,
  layerAt,
  levelGain,
  LOOP_ALTERNATE,
  LOOP_FORWARD,
  LOOP_OFF,
  LOOP_REVERSE,
  panPosition,
  pickLayers,
  playbackRate,
  SCSP_BASE_RATE,
  toFloat32,
  uniqueSlices,
} from "./src/audio/tone-bank.js";

// --- Read-only ISO 9660, for pulling files off a disc image (src/cd/iso9660-read.js) ---
export {
  findEntry,
  listFiles,
  openDisc,
  readExtent,
  readFile,
} from "./src/cd/iso9660-read.js";

// --- Extras: byte-range diffing (src/diff-ranges.js) ---
export { coalesceDiffRanges, totalDiffBytes } from "./src/diff-ranges.js";
