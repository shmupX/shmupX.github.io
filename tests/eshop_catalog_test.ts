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

Deno.test("the first global game is Sh'M↑ Party's PS2 port, from its Pages deploy", async () => {
  const eshop = await read("data/eshop.json");
  const first = eshop.find((e: { id: string }) => e.id === "shmup-party-ps2");
  assertEquals(first?.kind, "web");
  assertEquals(first?.source, "github");
  // The repo is what the update check follows (a newer commit on main flags
  // UPDATE); the zip is what that repo's deploy publishes beside
  // https://easierbycode.com/shmup-party-ps2/ — the site's own browser build
  // once more at a relative base path, so it runs from /eshop/<id>/. Not a
  // raw.githubusercontent.com URL, so the installer takes it as is: every
  // install is the build the site's PLAY IN BROWSER button runs.
  assertEquals(first?.repo, "easierbycode/shmup-party-ps2");
  assertEquals(first?.branch, "main");
  assertEquals(
    first?.downloadUrl,
    "https://easierbycode.com/shmup-party-ps2/shmup-party-ps2-web.zip",
  );
  // The game is the site's /play/ page, so that is the entry inside the zip.
  assertEquals(first?.entry, "play/index.html");
  assertEquals(first?.icon, "/icons/shmup-party-icon.png");
  const icon = await Deno.stat(
    new URL("../static/icons/shmup-party-icon.png", import.meta.url),
  );
  assertEquals(icon.isFile, true, "the icon the catalog points at must ship");
  // The Phaser 4 build it replaced is gone, not merely second.
  assertEquals(
    eshop.some((e: { id: string }) => e.id === "shmup-party-phaser4"),
    false,
  );
});

Deno.test("the arcade board ships with the romset the catalog points at", async () => {
  const eshop = await read("data/eshop.json");
  const zun = eshop.find((e: { id: string }) => e.id === "zunzunkyou-no-yabou");
  assertEquals(zun?.kind, "arcade");
  // `core` is the section it lands in — an id in static/emulators.json, or
  // installing it turns on a section the launcher cannot draw.
  assertEquals(zun?.core, "arcade");
  const cores = JSON.parse(
    await Deno.readTextFile(
      new URL("../static/emulators.json", import.meta.url),
    ),
  ).cores as { id: string }[];
  assertEquals(
    cores.some((c) => c.id === zun?.core),
    true,
    "the core the entry names must be in static/emulators.json",
  );
  // `rom` is the romset/driver name the player is asked for, and the zip it
  // fetches has to be named for it: the player takes the name on faith and
  // resolves the recipe and MAME core from it.
  assertEquals(zun?.rom, "zunkyou");
  assertEquals(zun?.romUrl, "/games/zunzunkyou-no-yabou/zunkyou.zip");
  const rom = await Deno.stat(
    new URL("../static/games/zunzunkyou-no-yabou/zunkyou.zip", import.meta.url),
  );
  assertEquals(rom.isFile, true, "the romset the catalog points at must ship");
  // The MAME core and the per-game recipe are NOT ours: the player resolves
  // them from the Emularity engine, the same way the mirror's own arcade rows
  // do. Committing a copy here would be 21 MB of bytes archive.org already
  // serves — see the entry's sub line.
  for (const stray of ["mamesegac2.js.gz", "mamesegac2.wasm.gz"]) {
    let found = true;
    try {
      await Deno.stat(
        new URL(
          "../static/games/zunzunkyou-no-yabou/" + stray,
          import.meta.url,
        ),
      );
    } catch {
      found = false;
    }
    assertEquals(found, false, stray + " is the engine's to serve, not ours");
  }
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
  // An arcade row needs all three of core/rom/romUrl — each one is something
  // the launcher cannot guess.
  const arcade = {
    id: "ok-board",
    kind: "arcade" as const,
    name: "Ok",
    title: "OK",
    core: "arcade",
    rom: "okrom",
    romUrl: "/games/ok/okrom.zip",
  };
  assertEquals(eshopEntryProblems(arcade, 0), []);
  const badArcade = (patch: Record<string, unknown>) =>
    eshopEntryProblems({ ...arcade, ...patch } as typeof arcade, 0).length > 0;
  assertEquals(badArcade({ core: undefined }), true, "no core");
  assertEquals(badArcade({ rom: undefined }), true, "no rom");
  assertEquals(badArcade({ romUrl: undefined }), true, "no romUrl");
  assertEquals(badArcade({ core: "Arcade" }), true, "core must be an id");
  assertEquals(badArcade({ rom: "Zun Kyou" }), true, "rom must be an id");
  assertEquals(
    badArcade({ romUrl: "http://insecure/x.zip" }),
    true,
    "http romUrl",
  );
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
  assertEquals(bad({ status: "early access" }), true, "status not UPPER_SNAKE");
  assertEquals(bad({ status: "" }), true, "empty status");
  assertEquals(
    eshopEntryProblems({ ...ok, status: "EARLY_ACCESS" }, 0),
    [],
    "a pinned status",
  );
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
