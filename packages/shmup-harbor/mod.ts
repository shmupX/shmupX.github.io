// @shmupx/shmup-harbor — where a shmupX level leaves for another machine.
//
// @shmupx/shmup-engine reads and writes the Dezaemon 2 formats; this package
// takes what comes out of it and makes something that RUNS somewhere else: a
// PlayStation 2 USB folder or boot disc, a packaged Windows / Linux / macOS
// launcher, an Android APK or an iOS project, a Saturn cart save for MiSTer or
// real hardware — and the emulator injection and Saturn-vs-web parity profiler
// that say whether the port came out right.
//
// This file is the flat surface: the drivers, their option and result types,
// and the errors they throw. Everything else is reachable on its own subpath
// (see deno.json) — `@shmupx/shmup-harbor/png`, `/zip`, `/shelf`, `/ps2/sav`
// and the rest — which is how the app imports the pieces it needs.
//
// A note on what this package can and cannot be lifted out of the repo: the
// export pipeline builds FROM a shmupX checkout. It stages the base game from
// static/games/2028-ai, it spawns tools/build-level with a real Node, and it
// writes into build/. lib/repo-root.ts is where that coupling is named, and
// $SHMUPX_ROOT is how you point it somewhere else.

// ── PlayStation 2 ───────────────────────────────────────────────────────────
export {
  buildPs2,
  type BuildPs2Options,
  type BuildPs2Result,
  buildRuntimeBundle,
} from "./lib/ps2/build.ts";
export {
  type GameJson,
  loadSavLevel,
  loadSavLevelFromBytes,
  type SavLevel,
  type SavLevelOptions,
  savSlug,
  savTitle,
  type StageRecord,
} from "./lib/ps2/sav.ts";

// ── The app targets: APK, iOS, and the three desktops ───────────────────────
export {
  detectExportCapabilities,
  EXPORT_PLATFORMS,
  type ExportCapabilities,
  ExportError,
  type ExportOutcome,
  type ExportRequest,
  findArtifacts,
  guessAndroidSdk,
  IOS_PROJECT_SUFFIX,
  isCompiledBinary,
  isIosProject,
  packageIosProject,
  type Ps2Outcome,
  resolveDesktopPlatform,
  runExport,
  sanitizeLevelName,
  slugFor,
} from "./lib/export-build.ts";
export { packagedBuildRoot, stagedRuntimeRoot } from "./lib/build-workspace.ts";
export { repoRoot } from "./lib/repo-root.ts";

// ── Building somebody else's export, on this desktop ────────────────────────
export {
  CHUNK_BYTES,
  CODE_ALPHABET,
  CODE_LENGTH,
  EXPORT_DB,
  EXPORT_PATHS,
  type ExportJob,
  type ExportWorker,
  exportWorker,
  formatBuilderCode,
  HEARTBEAT_MS,
  type JobArtifact,
  type JobStatus,
  type JobSummary,
  newBuilderCode,
  normalizeBuilderCode,
  WORKER_VERSION,
  type WorkerConfig,
  type WorkerStatus,
} from "./lib/export-worker.ts";

// ── Which game a name means ─────────────────────────────────────────────────
export {
  cartBytes,
  levelRecordFromCart,
  listShelf,
  type ResolveOptions,
  resolveShelfName,
  SHELF_DB,
  shelfCacheDir,
  ShelfError,
  type ShelfHit,
  type ShelfKind,
  type ShelfListing,
  shelfSlug,
} from "./lib/shelf.ts";

// ── Saturn: the cart, the emulator, and the parity run ──────────────────────
export {
  backupFileName,
  injectCart,
  InjectError,
  type InjectRequest,
  type InjectResult,
} from "./lib/cart-inject.ts";
export {
  type CartInstall,
  findBin,
  findDisc,
  installCartSave,
  launchMednafen,
  mednafenArgs,
  mednafenEnv,
  MednafenError,
  type MednafenPaths,
  type MednafenResolution,
  NO_DISC_MESSAGE,
  resolveMednafen,
  savDirFor,
} from "./lib/mednafen.ts";
export {
  compareCapabilities,
  type CompareCapability,
  CompareError,
  type CompareJob,
  compareJobFile,
  type CompareRequest,
  type CompareResult,
  type CompareStatus,
  getCompareJob,
  publicCompareJob,
  resolveCompareSav,
  runCompare,
  runningCompareJob,
  startCompare,
} from "./lib/engine-compare.ts";
