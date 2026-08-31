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
  const tmp = Deno.env.get("TEMP") ?? Deno.env.get("TMPDIR") ?? "/tmp";
  return join(tmp, "shmupx-build");
}
