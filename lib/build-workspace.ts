// Where the packaged desktop app puts what it builds.
//
// A `deno compile` binary carries its whole tree in a READ-ONLY VFS, so the
// build/ directory a source checkout writes into does not exist for it in any
// writable sense. Everything it produces therefore goes to one real directory
// on disk, named here so the two routes that care agree on it:
// routes/api/build-apk.ts writes there, routes/api/build-artifact.ts is willing
// to serve from there.
//
// Deliberately stable rather than a fresh mkdtemp each run: the export panel
// hands out paths under it after the build has returned, and a build the user
// made yesterday should still be downloadable today.

import { join } from "jsr:@std/path@^1.1.2";

export function packagedBuildRoot(): string {
  return join(tmpRoot(), "shmupx-build");
}

/**
 * Where the packaged app stages the embedded `tools/build-level` + game so that
 * `node` — which cannot read Deno's VFS — has real files to run against.
 *
 * This is NOT packagedBuildRoot(): the Node tool derives its own output as
 * <cwd>/build/<slug>/dist, so everything the android, ios and desktop targets
 * produce inside the packaged app lands under THIS root instead. Naming it here
 * is what keeps routes/api/build-artifact.ts willing to serve those artifacts —
 * it allowed only the two roots above, so every download link the export panel
 * offered for a packaged Node build came back 403.
 */
export function stagedRuntimeRoot(): string {
  return join(tmpRoot(), "cmg-build-level");
}

function tmpRoot(): string {
  return Deno.env.get("TEMP") ?? Deno.env.get("TMPDIR") ?? "/tmp";
}
