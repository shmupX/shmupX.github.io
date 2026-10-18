// Where shmupX keeps its own games in the shared Realtime Database.
//
// The database (evil-invaders-default-rtdb) is shared with cmg, the sibling
// app in ~/CODE/cmg, and for a long time both apps read and wrote the same
// root-level `levels`, `levelAliases`, `atlases` and `characters`. cmg keeps
// every one of those (the root copies are its catalog and stay untouched);
// shmupX now has its own subtree beside them, `shmupX/`, holding only the
// games it ships and the characters and atlases those games name. A level
// saved, aliased or placed here edits shmupX's copy and never cmg's.
//
// Only those four nodes moved. Everything else stays at the root because it
// is a shared tool or service store rather than part of a game catalog:
// leaderboards, sprites, pixelSprites, pixelRooms, tilemaps, maps, fonts,
// eshop, dezaemon, dezaemonSfc, builders, the export queue (exportWorkers,
// exportQueue, exportBlobs, exportInputs), netplay, game, games and
// spritePicker. That is why the root is a PATH prefix chosen per node and not
// a new database base URL: swapping the whole base for `<db>/shmupX` would
// also re-root sprites/ and the export queue, which nothing has copied there.
//
// One constant, no environment override, on purpose. Two spellings of the
// prefix in one deployment is how the copies would drift, and the env var
// you might reach for, SHMUPX_ROOT, already names the checkout's filesystem
// path (packages/shmup-harbor/lib/repo-root.ts) — an RTDB prefix read from it
// would be "/Users/.../shmupX.github.io". Where a DATABASE base comes from an
// env var (CHARACTERS_DB, SHMUPX_DB) it is still read as the base, and this
// prefix goes on top.
//
// Mirrors that cannot import app code keep the same API in step:
// packages/shmup-harbor/lib/rtdb-root.ts (harbor is a workspace package) and
// the CommonJS build-level carries its own copy. Browser pages spell it as
// window.__RTDB_ROOT__ next to their Firebase config.

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
 *   rtdbPath("levels/gs")              -> "shmupX/levels/gs"
 *   rtdbPath("levelAliases.json")      -> "shmupX/levelAliases.json"
 *   rtdbPath("characters?shallow=true") -> "shmupX/characters?shallow=true"
 *   rtdbPath("/atlases/foo")           -> "/shmupX/atlases/foo"
 *   rtdbPath("sprites/RAM_0")          -> "sprites/RAM_0"
 *   rtdbPath("shmupX/levels/gs")       -> "shmupX/levels/gs" (already rooted)
 *
 * The first segment ends at the first "/", "?" or "." so a REST path with
 * its `.json` suffix or a query already on it is recognised too; no node or
 * key here can contain a "." (Firebase refuses one in a key). Leading slashes
 * are kept where they were, so the result drops into whichever of
 * `${db}/${path}` or `${db}${path}` the caller already builds.
 */
export function rtdbPath(path: string): string {
  const lead = /^\/*/.exec(path)![0];
  const rest = path.slice(lead.length);
  const first = /^[^/?.]*/.exec(rest)![0];
  return SCOPED.has(first) ? `${lead}${RTDB_ROOT}/${rest}` : path;
}
