// Every directory walk that decides what gets built, listed or shipped, against
// a tree that has macOS's AppleDouble forks in it.
//
// This checkout lives on an exFAT volume, which has nowhere to keep extended
// attributes, so macOS writes a 4 KB `._<name>` beside every file — and the
// fork inherits the original's extension, so it passes an extension test
// exactly as the real file does. The forks regenerate constantly, so deleting
// them is not a fix; each walk carries its own guard, and this is what keeps
// those guards from being quietly dropped.
//
// The trees here are built rather than borrowed: a fixture directory that
// happens to have a fork beside it today may not tomorrow, and a test that
// silently stops exercising the thing it names is worse than no test.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRequire } from "node:module";
import { fromFileUrl, join } from "@std/path";
import {
  listShelf,
  resolveShelfName,
  ShelfError,
  shelfSlug,
} from "../lib/shelf.ts";
import { savTitle } from "../lib/ps2/sav.ts";
import { treeEntries } from "../lib/ps2/zip.ts";
import { findArtifacts } from "../lib/export-build.ts";

/** A fork is 4 KB of AppleDouble, never the thing its extension advertises. */
const FORK = new Uint8Array(4096);

async function write(path: string, bytes: Uint8Array): Promise<void> {
  await Deno.writeFile(path, bytes);
}

// ── the shelf ────────────────────────────────────────────────────────────────

Deno.test("a fork is buildable either way, and must not be", () => {
  // Why the guard cannot live in the slug rule instead: by the time a name is
  // slugged the "._" is gone with the rest of the punctuation, and what is
  // left is a name the shelf will happily resolve. Which of the two shapes it
  // takes depends only on whether savTitle found a "Dez 2 - " prefix to strip.
  //
  // No prefix: the fork lands on the real save's own slug and shadows it.
  assertEquals(shelfSlug(savTitle("Dez SNES.sav")), "dez-snes");
  assertEquals(shelfSlug(savTitle("._Dez SNES.sav")), "dez-snes");
  // Prefixed: the fork keeps the prefix the real save loses, so it becomes a
  // second, separately buildable name sitting beside the real one.
  assertEquals(shelfSlug(savTitle("Dez 2 - Avenge.sav")), "avenge");
  assertEquals(shelfSlug(savTitle("._Dez 2 - Avenge.sav")), "dez-2-avenge");
});

Deno.test("`shelf:list` counts saves, not forks", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "dev-fixtures"), { recursive: true });
  for (const name of ["Dez SNES.sav", "._Dez SNES.sav"]) {
    await write(join(root, "dev-fixtures", name), FORK);
  }
  const local = (await listShelf({ root })).find(
    (s) => s.section === "LOCAL .SAV COLLECTION",
  )!;
  assertEquals(local.rows.map((r) => r.title), ["Dez SNES"]);
});

Deno.test("a fork is not a buildable name of its own", async () => {
  // "._Dez 2 - Avenge.sav" keeps the "Dez 2 - " prefix that savTitle strips
  // off the real save, so it slugs to "dez-2-avenge" — a name nothing on this
  // shelf should answer to. Unguarded it resolves, and what it resolves to is
  // 4 KB of AppleDouble handed to the exporter as a cart.
  //
  // `deza:` goes to the local collection first and `offline` stops the miss
  // falling through to the network, so this asks exactly one question and
  // asks it the same way every time — unlike the shadowing case below, which
  // Deno.readDir's order gets a vote in.
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "dev-fixtures"), { recursive: true });
  for (const name of ["Dez 2 - Avenge.sav", "._Dez 2 - Avenge.sav"]) {
    await write(join(root, "dev-fixtures", name), FORK);
  }
  const log: string[] = [];
  await assertRejects(
    () =>
      resolveShelfName("deza:dez-2-avenge", {
        root,
        offline: true,
        log: (l) => log.push(l),
      }),
    ShelfError,
  );
  assertEquals(log.filter((l) => l.includes("the local collection")), []);
});

Deno.test("the save behind a fork still resolves", async () => {
  // The other shape: "._Dez SNES.sav" has no prefix to keep, so it lands on
  // the real save's own slug and the two stop being distinguishable by name.
  // Which one an unguarded walk returns is down to readDir order, so this is
  // the happy path rather than the regression — that the guard skips the fork
  // WITHOUT also skipping the save beside it. `shelf:list` above is the one
  // that fails when the guard goes.
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "dev-fixtures"), { recursive: true });
  for (const name of ["Dez SNES.sav", "._Dez SNES.sav"]) {
    await write(join(root, "dev-fixtures", name), FORK);
  }
  // The note naming the chosen file is logged before the cart is decoded, so
  // the pick is observable even though this fixture is not a real cart and
  // the decode that follows is expected to throw.
  const log: string[] = [];
  try {
    await resolveShelfName("deza:dez-snes", {
      root,
      offline: true,
      log: (l) => log.push(l),
    });
  } catch { /* not a cart — the pick has already been logged */ }
  const picked = log.find((l) => l.includes("the local collection")) ?? "";
  assert(
    picked.includes("(Dez SNES.sav)"),
    `resolved to the fork instead of the save: ${picked || "(nothing logged)"}`,
  );
});

// ── what ships ───────────────────────────────────────────────────────────────

Deno.test("an export archive carries no forks", async () => {
  const root = await Deno.makeTempDir();
  const dist = join(root, "dist");
  await Deno.mkdir(join(dist, "assets"), { recursive: true });
  await write(join(dist, "game.js"), FORK);
  await write(join(dist, "._game.js"), FORK);
  await write(join(dist, "assets", "s.png"), FORK);
  await write(join(dist, "assets", "._s.png"), FORK);

  const paths = (await treeEntries(dist)).map((e) => e.path);
  assertEquals(paths, ["dist/assets/s.png", "dist/game.js"]);
});

Deno.test("a fork is never offered as a built app", async () => {
  const root = await Deno.makeTempDir();
  const dist = join(root, "build", "avenge", "dist");
  await Deno.mkdir(dist, { recursive: true });
  for (const name of ["avenge.apk", "._avenge.apk"]) {
    await write(join(dist, name), FORK);
  }
  // "all" is the dangerous one: it matches on nothing, so every fork in dist/
  // would be reported as an artifact.
  for (const platform of ["android", "all"]) {
    assertEquals(
      (await findArtifacts(root, "avenge", platform)).map((p) =>
        p.slice(dist.length + 1)
      ),
      ["avenge.apk"],
      `platform ${platform}`,
    );
  }
});

Deno.test("the Node staging copy drops forks, whole subtrees included", async () => {
  // tools/build-level is plain Node and excluded from deno fmt/lint/check, so
  // the real module is loaded the way Node loads it. fromFileUrl because this
  // checkout's volume has a space in its name, which a URL pathname keeps
  // percent-encoded and require() cannot resolve.
  const require = createRequire(import.meta.url);
  const { copyDir } = require(
    fromFileUrl(new URL("../tools/build-level/lib/stage.js", import.meta.url)),
  ) as { copyDir(src: string, dst: string): void };

  const root = await Deno.makeTempDir();
  const src = join(root, "www");
  await Deno.mkdir(join(src, "assets"), { recursive: true });
  await Deno.mkdir(join(src, "._ghost"), { recursive: true });
  await write(join(src, "._ghost", "inner.png"), FORK);
  await write(join(src, "game.js"), FORK);
  await write(join(src, "._game.js"), FORK);
  await write(join(src, "assets", "s.png"), FORK);
  await write(join(src, "assets", "._s.png"), FORK);

  const dst = join(root, "staged");
  copyDir(src, dst);

  const seen: string[] = [];
  const walk = async (at: string, rel: string) => {
    for await (const e of Deno.readDir(at)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(join(at, e.name), r);
      else seen.push(r);
    }
  };
  await walk(dst, "");
  assertEquals(seen.sort(), ["assets/s.png", "game.js"]);
});
