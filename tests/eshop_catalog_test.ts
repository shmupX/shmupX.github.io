// The eShop catalog, data/eshop.json, checked the way the installer will read
// it.
//
// Games reach the eShop by pull request against that file, and a row the
// installer cannot act on — an id that is not a path segment, a github entry
// with no repo, a download from a host the installer will not fetch from —
// ships as a tile that never installs and says nothing about why. So every
// rule static/eshop-library.js relies on is enforced here, on the data file
// and on the manifest built from it (static/games.manifest.json is what the
// launcher actually fetches; it has to carry the same array). CI runs this on
// every PR that touches data/ (.github/workflows/eshop.yml).
//
// The rules themselves live in scripts/build-games-manifest.ts, so the build
// and this test agree by construction.

import { assertEquals } from "@std/assert";
import { eshopEntryProblems } from "../scripts/build-games-manifest.ts";

const read = async (p: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`../${p}`, import.meta.url)));

Deno.test("data/eshop.json is an array of valid entries with unique ids", async () => {
  const eshop = await read("data/eshop.json");
  assertEquals(Array.isArray(eshop), true, "data/eshop.json must be an array");
  for (const [i, e] of eshop.entries()) {
    assertEquals(
      typeof e?.id === "string" && typeof e?.name === "string",
      true,
      `eshop[${i}] needs string "id" and "name"`,
    );
  }
  const problems = eshop.flatMap((
    e: Parameters<typeof eshopEntryProblems>[0],
    i: number,
  ) => eshopEntryProblems(e, i));
  assertEquals(problems, [], "data/eshop.json has invalid entries");

  const ids = eshop.map((e: { id: string }) => e.id);
  assertEquals(
    [...new Set(ids)].length,
    ids.length,
    "ids double as cache paths (/eshop/<id>/) and shelf ids — they must be unique",
  );
});

Deno.test("static/games.manifest.json carries the same eshop array", async () => {
  const eshop = await read("data/eshop.json");
  const manifest = await read("static/games.manifest.json");
  assertEquals(
    manifest.eshop,
    eshop,
    "static/games.manifest.json is stale — run `deno task games:manifest`",
  );
  assertEquals(
    "demos" in manifest,
    false,
    "the manifest no longer carries a demos list (the eShop replaced it)",
  );
  assertEquals(typeof manifest.version, "string");
  assertEquals(Array.isArray(manifest.games), true);
});

Deno.test("the first global game is shmup-party-phaser4 at its latest build", async () => {
  const eshop = await read("data/eshop.json");
  const first = eshop.find((e: { id: string }) =>
    e.id === "shmup-party-phaser4"
  );
  assertEquals(first?.kind, "web");
  assertEquals(first?.source, "github");
  assertEquals(first?.repo, "easierbycode/shmup-party-phaser4");
  assertEquals(first?.branch, "main");
  // A raw.githubusercontent.com URL on the branch: the installer swaps
  // "/main/" for the latest commit sha when it knows it, so the install is
  // pinned to the newest build rather than whatever the CDN still holds.
  assertEquals(
    first?.downloadUrl,
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/main/shmup-party-phaser4.zip",
  );
  assertEquals(first?.icon, "/icons/shmup-party-icon.png");
  const icon = await Deno.stat(
    new URL("../static/icons/shmup-party-icon.png", import.meta.url),
  );
  assertEquals(icon.isFile, true, "the icon the catalog points at must ship");
});

Deno.test("eshopEntryProblems rejects what the installer cannot act on", () => {
  const ok = {
    id: "ok-game",
    kind: "web" as const,
    name: "Ok",
    title: "OK",
    source: "github" as const,
    repo: "easierbycode/ok",
  };
  assertEquals(eshopEntryProblems(ok, 0), []);

  const bad = (patch: Record<string, unknown>) =>
    eshopEntryProblems({ ...ok, ...patch } as typeof ok, 0).length > 0;
  assertEquals(bad({ id: "Ok Game" }), true, "id with spaces/case");
  assertEquals(bad({ id: "-leading" }), true, "id starting with -");
  assertEquals(bad({ kind: "rom" }), true, "unknown kind");
  assertEquals(
    bad({ repo: "https://github.com/easierbycode/ok" }),
    true,
    "repo must be owner/name",
  );
  assertEquals(bad({ source: "url" }), true, "url source without downloadUrl");
  assertEquals(
    bad({ downloadUrl: "http://insecure/x.zip" }),
    true,
    "http download",
  );
  assertEquals(
    bad({ downloadUrl: "//cdn/x.zip" }),
    true,
    "protocol-relative download",
  );
  assertEquals(bad({ icon: "icons/x.png" }), true, "relative icon");
  assertEquals(bad({ date: "2026-07-28" }), true, "date not MM.DD.YY");
  assertEquals(bad({ subdir: "../x" }), true, "subdir climbing out");
  assertEquals(bad({ title: "" }), true, "empty title");

  // deza: a save URL or a community slug, one or the other.
  const deza = { id: "foo", kind: "deza" as const, name: "Foo", title: "FOO" };
  assertEquals(
    eshopEntryProblems(deza, 0).length > 0,
    true,
    "needs sav or slug",
  );
  assertEquals(eshopEntryProblems({ ...deza, slug: "foo" }, 0), []);
  assertEquals(
    eshopEntryProblems({
      ...deza,
      sav: "/editor/dezaemon/saves/Dez 2 - Foo.sav",
    }, 0),
    [],
  );
  assertEquals(
    eshopEntryProblems({ ...deza, sav: "ftp://x/Foo.sav" }, 0).length > 0,
    true,
  );
});
