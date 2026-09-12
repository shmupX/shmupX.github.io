// The two roots harbor works from: the shmupX checkout, and its own directory.
//
// A port is built FROM a checkout, so most of what harbor reads lives outside
// the package: the base game under static/games/2028-ai that every export
// stages from, the gitignored dev-fixtures/ the disc and cart tasks look in,
// and the build/ tree the artifacts land in. Before the port layer moved here
// each of those files spelled the root as `<its own dir>/..`, which was right
// when they sat one level under the repo and is wrong now — and wrong again
// the next time anything moves.
//
// So neither distance is counted. Both are found, by walking up for a file
// only that root has above it. Counting would be wrong in three layouts at
// once: a checkout (three levels), the Vite-bundled server, where every module
// here is inlined into _fresh/server/assets/<chunk>.mjs and import.meta.url no
// longer points into the tree at all, and the packaged app's read-only
// `deno compile` VFS. lib/export-build.ts has always searched for the two roots
// it needs, for exactly this reason.
//
// $SHMUPX_ROOT wins over all of it, for a test rig or a packaged app that
// knows better than a search does.
//
// Nothing here runs at module scope. Several callers do call these at module
// scope, and a published copy of this package is fetched over https, where
// fromFileUrl throws and Deno.cwd() may not be granted — so the work happens
// inside the functions, behind try/catch, and a failed search degrades to a
// wrong-but-harmless path rather than an exception nobody can catch.

import { dirname, fromFileUrl, join, resolve } from "@std/path";

// static/games/2028-ai is the base game. game.bundle.js is the marker within
// it because it is committed, is never written by a build, and rides along in
// the packaged app's VFS — so a hit means a tree an export can actually run
// against rather than an empty directory left behind by one.
const REPO_MARKER = join("static", "games", "2028-ai", "game.bundle.js");

// harbor's own manifest. Its name is checked rather than its presence: every
// workspace member has a deno.json, so the file alone would stop the walk at
// packages/shmup-engine or at the checkout root.
const HARBOR_MARKER = "deno.json";
const HARBOR_NAME = '"@shmupx/shmup-harbor"';

let repo: string | null = null;
let harbor: string | null = null;

/**
 * The absolute path of the checkout root, without a trailing slash.
 *
 * Resolved once per process: every caller wants the same answer, and the
 * search is a handful of stats that should not be repeated per build.
 */
export function repoRoot(): string {
  return repo ??= findRepo();
}

/**
 * This package's own root — the directory holding deno.json, lib/, scripts/
 * and tools/.
 *
 * Callers want it for the things harbor SHIPS rather than the things the
 * checkout does: tools/build-level, the export scripts, lib/ps2's console-side
 * runtime entry. repoRoot() has not pointed at those since the port layer moved
 * down here, and the two are different directories in every layout.
 */
export function harborRoot(): string {
  return harbor ??= findHarbor();
}

function findRepo(): string {
  const pinned = env("SHMUPX_ROOT");
  if (pinned) return resolve(pinned);
  return walkUp((dir) => isFile(join(dir, REPO_MARKER))) ??
    // Nothing above us is a checkout: a published copy of this package, or a
    // tree without the base game. The working directory is the only other
    // thing a caller could have meant.
    cwd() ?? ".";
}

function findHarbor(): string {
  const found = walkUp((dir) => readsAs(join(dir, HARBOR_MARKER), HARBOR_NAME));
  if (found) return found;
  // Bundled, where import.meta.url is a chunk and there is nothing above it to
  // walk. The package is where the workspace keeps it, relative to the checkout
  // the other search found.
  return join(repoRoot(), "packages", "shmup-harbor");
}

/**
 * Walk up from this module, then out from the working directory, calling `hit`
 * at every step. The second start is what answers when the first is a bundle
 * chunk rather than a real place in the tree.
 */
function walkUp(hit: (dir: string) => boolean): string | null {
  for (const start of [moduleDir(), cwd()]) {
    if (!start) continue;
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (hit(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function moduleDir(): string | null {
  try {
    // Throws for a published copy, which is fetched over https.
    return dirname(fromFileUrl(import.meta.url));
  } catch {
    return null;
  }
}

function cwd(): string | null {
  try {
    return Deno.cwd();
  } catch {
    return null;
  }
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function readsAs(path: string, needle: string): boolean {
  try {
    return Deno.readTextFileSync(path).includes(needle);
  } catch {
    return false;
  }
}
