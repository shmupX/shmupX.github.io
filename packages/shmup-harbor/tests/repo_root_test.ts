// The two roots every other file here hangs off.
//
// Worth its own test because the whole package moved down three levels at once
// and a dozen files that used to count `..` now ask these instead: a wrong
// answer here is not one broken export, it is all of them — and most of the
// layouts that would expose it (the bundled server, the packaged binary, a
// published copy fetched over https) are ones no other test in this suite runs.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { harborRoot, repoRoot } from "../lib/repo-root.ts";

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("repoRoot() is the checkout — the tree an export stages from", () => {
  const root = repoRoot();
  assert(
    exists(join(root, "static", "games", "2028-ai", "game.bundle.js")),
    `${root} has no base game`,
  );
  // The things harbor reaches out of the package for, all of them the repo's.
  assert(exists(join(root, "static")), "no static/");
  assert(exists(join(root, "deno.json")), "no root manifest");
});

Deno.test("harborRoot() is this package, not the checkout and not a sibling", () => {
  const harbor = harborRoot();
  assertEquals(basename(harbor), "shmup-harbor");
  assertStringIncludes(
    Deno.readTextFileSync(join(harbor, "deno.json")),
    '"@shmupx/shmup-harbor"',
  );
  // The three trees that moved down here. tools/build-level in particular is
  // what scripts/build-desktop.ts and lib/export-build.ts spawn.
  for (const dir of ["lib", "scripts", "tools"]) {
    assert(exists(join(harbor, dir)), `no ${dir}/ under ${harbor}`);
  }
  assert(
    exists(join(harbor, "tools", "build-level", "index.js")),
    "the Node build tool is not where harborRoot() says",
  );
  // What buildRuntimeBundle reads, and the reason it asks harborRoot() rather
  // than the root it is handed.
  assert(exists(join(harbor, "lib", "ps2", "runtime-entry.ts")));
});

Deno.test("the two are different directories, one inside the other", () => {
  const repo = repoRoot(), harbor = harborRoot();
  assert(repo !== harbor, "harborRoot() collapsed onto the checkout");
  assertEquals(harbor, join(repo, "packages", "shmup-harbor"));
  // The engine is the sibling the walk must not stop at: it has a deno.json
  // too, which is why the search reads the name rather than trusting the file.
  assert(exists(join(dirname(harbor), "shmup-engine", "deno.json")));
});

// Resolved once per process, so the override can only be observed from a fresh
// one — which is also the only way the packaged app and the Node half see it.
Deno.test("$SHMUPX_ROOT overrides the search", async () => {
  const probe = join(harborRoot(), "tests", "support", "print_roots.ts");
  const pinned = await Deno.makeTempDir();
  try {
    const { stdout, success } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", probe],
      env: { ...Deno.env.toObject(), SHMUPX_ROOT: pinned },
      stdout: "piped",
      stderr: "inherit",
    }).output();
    assert(success, "the probe did not run");
    const out = JSON.parse(new TextDecoder().decode(stdout));
    assertEquals(out.repo, pinned, "SHMUPX_ROOT was not honoured");
    // harborRoot() is its own search and does NOT follow the pin: it is the
    // package's own directory, which is where this file was loaded from
    // whatever the checkout is said to be.
    assertEquals(out.harbor, harborRoot());
  } finally {
    await Deno.remove(pinned, { recursive: true });
  }
});

Deno.test("neither throws when nothing above is a checkout", async () => {
  const elsewhere = await Deno.makeTempDir();
  const probe = join(harborRoot(), "tests", "support", "print_roots.ts");
  try {
    const { stdout, success } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", probe],
      cwd: elsewhere,
      env: { ...Deno.env.toObject(), SHMUPX_ROOT: "" },
      stdout: "piped",
      stderr: "inherit",
    }).output();
    // The module dir still finds the real checkout, so this is really a check
    // that an unrelated cwd changes nothing and nothing raises.
    assert(success, "importing repo-root.ts from an unrelated cwd threw");
    const out = JSON.parse(new TextDecoder().decode(stdout));
    assertEquals(out.repo, repoRoot());
    assertEquals(out.harbor, harborRoot());
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
});
