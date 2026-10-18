// Where shmupX keeps its own games in the shared Realtime Database — harbor's
// copy of the app's lib/rtdb-root.ts.
//
// The database (evil-invaders-default-rtdb) is shared with cmg, the sibling
// app in ~/CODE/cmg. Its root-level `levels`, `levelAliases`, `atlases` and
// `characters` are cmg's catalog and stay exactly where they are; shmupX's
// games, and the characters and atlases those games name, live in a subtree
// beside them, `shmupX/`. Every build harbor makes by NAME — `build:ps2 gs`,
// `build:sav Ramsie`, an export job that says "2019" — therefore reads
// `shmupX/levels/<name>` (or the key `shmupX/levelAliases/<name lowercased>`
// stands for), and never the root copy, which would quietly build cmg's
// version of a game or one shmupX does not ship at all.
//
// Only those four nodes moved. The shelves harbor reads (dezaemon/*, eshop/*)
// and the export queue it serves (exportWorkers, exportQueue, exportBlobs,
// exportInputs) are shared stores and stay at the root, which is why the root
// is a PATH prefix chosen per node rather than a new database base URL: a
// base of `<db>/shmupX` would re-root the queue too, and nothing ever copied
// it there.
//
// Why a copy and not an import: a workspace package cannot reach up into the
// app (the published @shmupx/shmup-harbor has no lib/ above it to import), so
// the same three names are written here, and again in CommonJS for
// tools/build-level (lib/rtdb-root.js), which has no build step and cannot
// load TypeScript. tests/rtdb_root_test.ts runs all three over the same paths
// and fails on the first disagreement.
//
// One constant, no environment override — on purpose. Two spellings of the
// prefix in one deployment is how the copies drift, and the variable you might
// reach for, $SHMUPX_ROOT, already names the checkout's FILESYSTEM path
// (lib/repo-root.ts): read as an RTDB prefix it would be
// "/Users/.../shmupX.github.io" inside every export.

/** The subtree shmupX's own games live under. */
export const RTDB_ROOT = "shmupX";

/** The nodes that live under RTDB_ROOT. Every other node stays at the root. */
export const SCOPED_NODES = [
  "levels",
  "levelAliases",
  "atlases",
  "characters",
] as const;

export type ScopedNode = typeof SCOPED_NODES[number];

const SCOPED = new Set<string>(SCOPED_NODES);

/**
 * A database path with the shmupX root in front of it when it names one of
 * the scoped nodes, and unchanged otherwise:
 *
 *   rtdbPath("levels/gs")               -> "shmupX/levels/gs"
 *   rtdbPath("levels.json?shallow=true") -> "shmupX/levels.json?shallow=true"
 *   rtdbPath("/atlases/foo")            -> "/shmupX/atlases/foo"
 *   rtdbPath("dezaemon/index.json")     -> "dezaemon/index.json"
 *   rtdbPath("shmupX/levels/gs")        -> "shmupX/levels/gs" (already rooted)
 *
 * The first segment ends at the first "/", "?" or ".", so a REST tail with
 * its `.json` suffix or a query already on it is recognised too (no node or
 * key can contain a "." — Firebase refuses one). Leading slashes are kept
 * where they were, so the result drops into whichever of `${db}/${path}` or
 * `${db}${path}` the caller already builds.
 */
export function rtdbPath(path: string): string {
  const lead = /^\/*/.exec(path)![0];
  const rest = path.slice(lead.length);
  const first = /^[^/?.]*/.exec(rest)![0];
  return SCOPED.has(first) ? `${lead}${RTDB_ROOT}/${rest}` : path;
}
