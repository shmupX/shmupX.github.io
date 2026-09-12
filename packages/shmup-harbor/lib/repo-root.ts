// The shmupX checkout this package sits inside.
//
// A port is built FROM a checkout, so most of what harbor reads lives outside
// the package: the base game under static/games/2028-ai that every export
// stages from, the gitignored dev-fixtures/ the disc and cart tasks look in,
// and the build/ tree the artifacts land in. Before the port layer moved here
// each of those files spelled the root as `<its own dir>/..`, which was right
// when they sat one level under the repo and is wrong now — and wrong again
// the next time anything moves.
//
// So the distance is not counted. It is found, by walking up for the one file
// that only the checkout root has above it, exactly the way lib/export-build.ts
// already finds the two roots it needs. That also survives the two layouts
// where the count genuinely is not fixed: Vite bundles the server into
// _fresh/server/assets/ and `deno compile` lays the same modules out inside a
// read-only VFS, in neither of which is this module three levels down.
//
// $SHMUPX_ROOT wins over all of it, for a test rig or a packaged app that
// knows better than a search does.

import { dirname, fromFileUrl, join, resolve } from "@std/path";

// static/games/2028-ai is the base game. game.bundle.js is the marker within
// it because it is committed, is never written by a build, and rides along in
// the packaged app's VFS — so a hit means a tree an export can actually run
// against rather than an empty directory left behind by one.
const MARKER = join("static", "games", "2028-ai", "game.bundle.js");

// packages/shmup-harbor/lib/repo-root.ts → the checkout, when the search finds
// nothing: a published copy of this package has no checkout above it, and a
// caller that passes its own root never reaches this at all.
const CHECKOUT_DEPTH = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
);

let cached: string | null = null;

/**
 * The absolute path of the checkout root, without a trailing slash.
 *
 * Resolved once per process: every caller wants the same answer, and the
 * search is a handful of stats that should not be repeated per build.
 */
export function repoRoot(): string {
  if (cached !== null) return cached;
  return cached = findRoot();
}

function findRoot(): string {
  const pinned = Deno.env.get("SHMUPX_ROOT");
  if (pinned) return resolve(pinned);

  // Up from this module, then out from the working directory — the second is
  // what answers when the first is a bundle chunk rather than a tree.
  for (const start of [dirname(fromFileUrl(import.meta.url)), Deno.cwd()]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (isFile(join(dir, MARKER))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return CHECKOUT_DEPTH;
}

/**
 * This package's own root — the directory holding deno.json, lib/, scripts/
 * and tools/.
 *
 * Exact rather than searched: this module sits at <harbor>/lib/repo-root.ts and
 * always will. Callers want it for the things harbor ships rather than the
 * things the checkout does — tools/build-level and the export scripts — which
 * repoRoot() has not pointed at since the port layer moved down here.
 */
export function harborRoot(): string {
  return resolve(dirname(fromFileUrl(import.meta.url)), "..");
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
