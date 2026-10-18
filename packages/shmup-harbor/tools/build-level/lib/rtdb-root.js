"use strict";

// Where shmupX keeps its own games in the shared Realtime Database — the
// CommonJS copy of packages/shmup-harbor/lib/rtdb-root.ts (itself a copy of
// the app's lib/rtdb-root.ts).
//
// The database is shared with cmg. Its root-level levels, levelAliases,
// atlases and characters are cmg's catalog; shmupX's games live under
// `shmupX/` beside them, so a build by name reads shmupX/levels/<name> and
// never the root copy (lib/fetch-level.js). Only those four nodes moved —
// every other node, the export queue included, stays at the root — which is
// why the root is a path prefix per node and not a new base URL.
//
// This tool is plain Node with no build step, so it cannot load the
// TypeScript module and keeps the same three names here instead.
// packages/shmup-harbor/tests/rtdb_root_test.ts runs this copy and the two
// TypeScript ones over the same paths and fails on any disagreement.
//
// A constant, never an environment variable: $SHMUPX_ROOT already means the
// checkout's FILESYSTEM path to this tool (index.js cmgRoot), and two
// spellings of the prefix in one deployment is how the copies drift.

const RTDB_ROOT = "shmupX";

const SCOPED_NODES = Object.freeze([
  "levels",
  "levelAliases",
  "atlases",
  "characters",
]);

const SCOPED = new Set(SCOPED_NODES);

// The path with the root in front when its first segment is a scoped node,
// unchanged otherwise. The segment ends at the first "/", "?" or ".", so a
// REST tail with ".json" or a query on it is recognised too; leading slashes
// stay where they were.
function rtdbPath(path) {
  const lead = /^\/*/.exec(path)[0];
  const rest = path.slice(lead.length);
  const first = /^[^/?.]*/.exec(rest)[0];
  return SCOPED.has(first) ? lead + RTDB_ROOT + "/" + rest : path;
}

module.exports = { RTDB_ROOT, SCOPED_NODES, rtdbPath };
