// The Steam build's member packs, from the build to the request.
//
// `deno task build:steam` leaves what is not ours to sell out of the binary
// (lib/member-content.ts) and writes it into shmupx-member-<id>.zip files
// (lib/member-build.ts); the packaged server answers those paths out of the
// zips where a member drops them (lib/member-packs.ts). These pin which file
// goes in which pack, that the binary's excludes cover exactly the member
// files in as few flags as they can, and that a pack serves its files byte for
// byte — whole, ranged, HEAD and 304 — while never answering for a path no
// member rule names.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { buildZip } from "@shmupx/shmup-harbor/zip";
import {
  MEMBER_DEFAULTS,
  memberPacks,
  packFileName,
  packFor,
  REVIEW,
} from "../lib/member-content.ts";
import {
  assignPacks,
  minimalExcludes,
  restoreMemberPacks,
  treeUrls,
  writeMemberPacks,
} from "../lib/member-build.ts";
import {
  decodedPath,
  memberContentType,
  memberDirs,
  MemberLibrary,
  namedMemberDirs,
  parseRange,
  readZipEntry,
  readZipIndex,
  ZipFormatError,
} from "../lib/member-packs.ts";
import {
  flavorFileText,
  launcherFlavor,
  readFlavorFile,
} from "../lib/launcher-flavor.ts";

const ROMSETS = ["/games/metamoqester/metmqstr.zip"];
const PACKS = memberPacks(ROMSETS);
const idOf = (path: string) => packFor(path, PACKS)?.id ?? null;

Deno.test("every member path falls to its pack, and the game's own files to none", () => {
  const cases: Array<[string, string | null]> = [
    ["/snes/Dezaemon.sfc", "dezaemon-sfc"],
    ["/snes/play.html", null],
    ["/n64dd/Dezaemon 3D (Japan).z64", "dezaemon-3d"],
    ["/n64dd/64DD_IPL.bin", "dezaemon-3d"],
    ["/n64dd/dezaemon-3d-usa-2024.09.12.xdelta", "dezaemon-3d"],
    ["/n64dd/play.html", null],
    ["/editor/dezaemon/mesh-library.json", "dezaemon-2-disc"],
    ["/editor/dezaemon/games-db.json", null],
    ["/editor/dezaemon/saves/g-fencer.sav", "dezaemon-saves"],
    ["/editor/dezaemon/saves.manifest.json", "dezaemon-saves"],
    ["/games/metamoqester/metmqstr.zip", "arcade"],
    // A board the catalogue gains after the build is still the arcade pack's.
    ["/games/new-board/newbrd.zip", "arcade"],
    ["/games/2028-ai/assets/custom-bgm/manifest.json", "2028-ai-soundtrack"],
    [
      "/games/2028-ai/assets/sounds/boss_bison_bgm.mp3",
      "2028-ai-street-fighter",
    ],
    [
      "/games/2028-ai/assets/sounds/boss_goki_voice_ko.mp3",
      "2028-ai-street-fighter",
    ],
    ["/games/2028-ai/assets/sounds/se_shoot.mp3", null],
    ["/games/2028-ai/assets/sounds/voice_fight.mp3", null],
    ["/games/2028-ai/game.bundle.js", null],
    ["/games/super-mario-sp/super-mario-sp.sfc", "super-mario-sp"],
    // The Switch is a whole console: its page, core, keys and cartridges.
    ["/switch/play.html", "switch"],
    ["/switch/core/switch_core.wasm", "switch"],
    ["/switch/keys/prod.keys", "switch"],
    ["/NintendoSwitch/Game (USA).xci", "switch"],
    ["/NintendoSwitch/manifest.json", "switch"],
    ["/NintendoSwitch/covers/Game.png", "switch"],
    ["/bios/scph5500.bin", null],
    ["/games/2019-web.zip", null],
    ["/dashboard.bundle.js", null],
  ];
  for (const [path, id] of cases) assertEquals(idOf(path), id, path);
  assertEquals(new Set(PACKS.map((p) => p.id)).size, PACKS.length);
  assertEquals(packFileName("arcade"), "shmupx-member-arcade.zip");
  assert(REVIEW.length > 0);
});

Deno.test("the binary's excludes are whole folders where they can be, files where they must", () => {
  const all = [
    "/games/arcade-a/a.zip",
    "/games/arcade-b/b.zip",
    "/games/2028-ai/game.bundle.js",
    "/games/2028-ai/assets/sounds/boss_bison_bgm.mp3",
    "/games/2028-ai/assets/sounds/se_shoot.mp3",
    "/editor/dezaemon/saves/a.sav",
    "/editor/dezaemon/saves/b.sav",
    "/editor/dezaemon/saves.manifest.json",
    "/editor/dezaemon/mesh-library.json",
    "/editor/dezaemon/games-db.json",
  ];
  const member = new Set(all.filter((u) => idOf(u)));
  assertEquals(minimalExcludes(all, member), [
    "/editor/dezaemon/mesh-library.json",
    "/editor/dezaemon/saves",
    "/editor/dezaemon/saves.manifest.json",
    "/games/2028-ai/assets/sounds/boss_bison_bgm.mp3",
    "/games/arcade-a",
    "/games/arcade-b",
  ]);
  // Every member file is under one, and nothing else is.
  const ex = minimalExcludes(all, member);
  for (const u of all) {
    const covered = ex.some((e) => u === e || u.startsWith(e + "/"));
    assertEquals(covered, member.has(u), u);
  }
  assertEquals(minimalExcludes(all, new Set()), []);
});

/** A static/-shaped tree with some member content and some not. */
async function fixture(dir: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {
    "/snes/Dezaemon.sfc": new Uint8Array(4096).map((_, i) => (i * 7) & 0xff),
    "/snes/play.html": new TextEncoder().encode("<!doctype html>player"),
    "/games/metamoqester/metmqstr.zip": new Uint8Array([
      0x50,
      0x4b,
      3,
      4,
      9,
      9,
    ]),
    "/editor/dezaemon/mesh-library.json": new TextEncoder().encode(
      JSON.stringify({ meshes: Array(50).fill({ v: [1, 2, 3] }) }),
    ),
    "/editor/dezaemon/saves.manifest.json": new TextEncoder().encode(
      '{"saves":[]}',
    ),
    "/games/2028-ai/game.bundle.js": new TextEncoder().encode("game()"),
  };
  for (const [url, data] of Object.entries(files)) {
    const path = join(dir, ...url.slice(1).split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeFile(path, data);
  }
  return files;
}

Deno.test("packs hold exactly their files; one with only a default in it is not written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const root = join(dir, "static");
    await fixture(root);
    const urls = await treeUrls(root);
    const assigned = assignPacks(urls, PACKS);
    assertEquals(assigned.get("dezaemon-sfc"), ["/snes/Dezaemon.sfc"]);
    assertEquals(assigned.get("dezaemon-saves"), [
      "/editor/dezaemon/saves.manifest.json",
    ]);
    const out = join(dir, "members");
    await Deno.mkdir(out);
    // A pack from an earlier build that this one does not write goes.
    await Deno.writeFile(
      join(out, "shmupx-member-stale.zip"),
      new Uint8Array(1),
    );
    const written = await writeMemberPacks({
      root,
      outDir: out,
      packs: PACKS,
      built: new Date("2026-10-18T00:00:00Z"),
    });
    assertEquals(written.map((w) => w.id), [
      "dezaemon-sfc",
      "dezaemon-2-disc",
      "arcade",
    ]);
    const names = [];
    for await (const e of Deno.readDir(out)) names.push(e.name);
    assertEquals(names.sort(), written.map((w) => packFileName(w.id)).sort());
    const index = await readZipIndex(join(out, packFileName("dezaemon-sfc")));
    assertEquals([...index.keys()].sort(), [
      "member.json",
      "snes/Dezaemon.sfc",
    ]);
    assert("/editor/dezaemon/saves.manifest.json" in MEMBER_DEFAULTS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a pack serves its files whole, ranged, as HEAD and as 304, and nothing a rule does not name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const root = join(dir, "static");
    const files = await fixture(root);
    const out = join(dir, "members");
    await writeMemberPacks({
      root,
      outDir: out,
      packs: PACKS,
      built: new Date(),
    });
    // A zip that tries to answer for the launcher's own page.
    await Deno.writeFile(
      join(out, "sneaky.zip"),
      await buildZip([
        { path: "index.html", data: new TextEncoder().encode("phish") },
      ], new Date()),
    );
    const library = new MemberLibrary({
      dirs: () => [out],
      importDir: out,
      rules: memberPacks([]),
    });
    const get = (
      path: string,
      headers: Record<string, string> = {},
      method = "GET",
    ) =>
      library.serve(new Request("http://x" + path, { method, headers }), path);

    const rom = await get("/snes/Dezaemon.sfc");
    assertEquals(rom?.status, 200);
    assertEquals(
      new Uint8Array(await rom!.arrayBuffer()),
      files["/snes/Dezaemon.sfc"],
    );
    assertEquals(rom!.headers.get("content-type"), "application/octet-stream");

    // The deflated JSON comes back as it went in.
    const mesh = await get("/editor/dezaemon/mesh-library.json");
    assertEquals(
      await mesh!.text(),
      new TextDecoder().decode(files["/editor/dezaemon/mesh-library.json"]),
    );
    assertStringIncludes(
      mesh!.headers.get("content-type")!,
      "application/json",
    );

    // The arcade install's probe: one byte of the romset.
    const probe = await get("/games/metamoqester/metmqstr.zip", {
      range: "bytes=0-0",
    });
    assertEquals(probe?.status, 206);
    assertEquals(probe!.headers.get("content-range"), "bytes 0-0/6");
    assertEquals(
      new Uint8Array(await probe!.arrayBuffer()),
      new Uint8Array([0x50]),
    );

    const head = await get("/snes/Dezaemon.sfc", {}, "HEAD");
    assertEquals(head?.status, 200);
    assertEquals(head!.headers.get("content-length"), "4096");
    assertEquals(await head!.text(), "");

    const again = await get("/snes/Dezaemon.sfc", {
      "if-none-match": rom!.headers.get("etag")!,
    });
    assertEquals(again?.status, 304);
    await again!.body?.cancel();

    const past = await get("/snes/Dezaemon.sfc", { range: "bytes=9999-" });
    assertEquals(past?.status, 416);

    // Not in any pack, and not a member path at all.
    assertEquals(await get("/n64dd/Dezaemon.z64"), null);
    assertEquals(await get("/index.html"), null);
    const { packs } = await library.packs();
    const sneaky = packs.find((p) => p.path.endsWith("sneaky.zip"))!;
    assertEquals([sneaky.files.length, sneaky.ignored], [0, 1]);
    const sfc = packs.find((p) => p.id === "dezaemon-sfc")!;
    assertEquals(sfc.title, "Dezaemon (Super Famicom) cartridge");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a folder pack, an import, and a pack dropped in while running", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const members = join(dir, "members");
    const folder = join(members, "my-cart");
    await Deno.mkdir(join(folder, "snes"), { recursive: true });
    await Deno.writeTextFile(
      join(folder, "member.json"),
      JSON.stringify({
        format: "shmupx.member-pack",
        version: 1,
        id: "dezaemon-sfc",
      }),
    );
    await Deno.writeFile(
      join(folder, "snes", "Dezaemon.sfc"),
      new Uint8Array([1, 2, 3]),
    );
    const library = new MemberLibrary({
      dirs: () => [members],
      importDir: members,
      rules: memberPacks([]),
    });
    const req = (path: string) => new Request("http://x" + path);
    const sfc = await library.serve(
      req("/snes/Dezaemon.sfc"),
      "/snes/Dezaemon.sfc",
    );
    assertEquals(
      new Uint8Array(await sfc!.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );

    // An import with nothing a pack carries is refused, and leaves nothing.
    const junk = await buildZip([
      { path: "readme.txt", data: new TextEncoder().encode("hi") },
    ], new Date());
    await assertRejects(
      () => library.importPack(junk, "junk.zip"),
      Error,
      "none of the files a member pack carries",
    );
    await assertRejects(
      () => library.importPack(new Uint8Array([1, 2, 3]), "x.zip"),
      ZipFormatError,
    );
    // A real one is filed under its member.json's id.
    const mesh = await buildZip([
      {
        path: "member.json",
        data: new TextEncoder().encode(JSON.stringify({
          format: "shmupx.member-pack",
          version: 1,
          id: "dezaemon-2-disc",
          title: "Disc",
        })),
      },
      {
        path: "editor/dezaemon/mesh-library.json",
        data: new TextEncoder().encode("{}"),
      },
    ], new Date());
    const pack = await library.importPack(mesh, "whatever.zip");
    assertEquals(pack.path, join(members, "shmupx-member-dezaemon-2-disc.zip"));
    const names = [];
    for await (const e of Deno.readDir(members)) names.push(e.name);
    assertEquals(names.sort(), [
      "my-cart",
      "shmupx-member-dezaemon-2-disc.zip",
    ]);

    // Dropped in by hand after the first scan: found by the next request for
    // one of its files once the last scan is a few seconds old.
    await Deno.writeFile(
      join(members, "arcade.zip"),
      await buildZip([
        { path: "games/x/x.zip", data: new Uint8Array([0x50, 0x4b]) },
      ], new Date()),
    );
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60_000;
      const board = await library.serve(
        req("/games/x/x.zip"),
        "/games/x/x.zip",
      );
      assertEquals(board?.status, 200);
      await board!.body?.cancel();
    } finally {
      Date.now = realNow;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a console pack carries its sections, and a launcher reads them back only as far as the pack honours them", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const root = join(dir, "static");
    const enc = (s: string) => new TextEncoder().encode(s);
    const files: Record<string, Uint8Array> = {
      "/switch/play.html": enc("<!doctype html>switch"),
      "/switch/core/switch_core.js": enc("export default () => ({})"),
      "/switch/keys/prod.keys": enc("header_key = 00"),
      "/NintendoSwitch/manifest.json": enc('[{"file":"a.nro","name":"a"}]'),
      "/NintendoSwitch/a.nro": enc("NRO0"),
    };
    for (const [url, data] of Object.entries(files)) {
      const path = join(root, ...url.slice(1).split("/"));
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeFile(path, data);
    }
    const out = join(dir, "members");
    const log: string[] = [];
    const written = await writeMemberPacks({
      root,
      outDir: out,
      packs: PACKS,
      built: new Date("2026-10-26T00:00:00Z"),
      log: (line) => log.push(line),
    });
    assertEquals(written.map((w) => w.id), ["switch"]);
    assertStringIncludes(log[0], "adds the NINTENDO SWITCH section");
    const zip = join(out, packFileName("switch"));
    const index = await readZipIndex(zip);
    const meta = JSON.parse(
      new TextDecoder().decode(
        await readZipEntry(zip, index.get("member.json")!),
      ),
    );
    assertEquals(meta.ui.sections[0].id, "switch");
    assertEquals(meta.ui.sections[0].player, "/switch/play.html");
    assertEquals(meta.files.length, 5);

    // Read back as the launcher reads it: the section rides on the pack,
    // and the shelf's rows come out of the zip like any other file.
    const library = new MemberLibrary({
      dirs: () => [out],
      importDir: out,
      rules: memberPacks([]),
    });
    assertEquals(library.exclusive, false);
    const { packs } = await library.packs();
    assertEquals(packs[0].ui?.sections.map((s) => s.id), ["switch"]);
    assertEquals(
      packs[0].ui?.sections[0].manifest,
      "/NintendoSwitch/manifest.json",
    );
    const shelf = await library.serve(
      new Request("http://x/NintendoSwitch/manifest.json"),
      "/NintendoSwitch/manifest.json",
    );
    assertEquals(await shelf!.json(), [{ file: "a.nro", name: "a" }]);
    const keys = await library.serve(
      new Request("http://x/switch/keys/prod.keys"),
      "/switch/keys/prod.keys",
    );
    assertEquals(await keys!.text(), "header_key = 00");

    // A pack whose member.json promises a section its files cannot honour
    // — the player is not in it — adds nothing, and still serves.
    const promise = await buildZip([
      {
        path: "member.json",
        data: enc(JSON.stringify({
          format: "shmupx.member-pack",
          version: 1,
          id: "switch",
          ui: {
            sections: [{ ...SWITCH_SECTION, player: "/switch/gone.html" }],
          },
        })),
      },
      { path: "switch/keys/prod.keys", data: enc("x") },
    ], new Date());
    const imported = await library.importPack(promise, "promise.zip");
    assertEquals(imported.ui, undefined);
    assertEquals(imported.files, ["/switch/keys/prod.keys"]);
    assert("/NintendoSwitch/manifest.json" in MEMBER_DEFAULTS);
    assertEquals(MEMBER_DEFAULTS["/NintendoSwitch/manifest.json"], "[]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const SWITCH_SECTION = memberPacks([]).find((p) => p.id === "switch")!.ui!
  .sections[0];

Deno.test("only SHMUPX_MEMBERS names the folders a non-Steam build reads", () => {
  const sep = Deno.build.os === "windows" ? ";" : ":";
  assertEquals(
    namedMemberDirs({ SHMUPX_MEMBERS: ["/a/members", " /b "].join(sep) }),
    ["/a/members", "/b"],
  );
  assertEquals(namedMemberDirs({}), []);
  assertEquals(namedMemberDirs({ SHMUPX_MEMBERS: "" }), []);
});

Deno.test("a restore writes member files into a checkout and nothing else", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const zip = join(dir, "shmupx-member-x.zip");
    await Deno.writeFile(
      zip,
      await buildZip([
        { path: "member.json", data: new TextEncoder().encode("{}") },
        { path: "snes/Dezaemon.sfc", data: new Uint8Array([7]) },
        { path: "index.html", data: new TextEncoder().encode("no") },
      ], new Date()),
    );
    const staticDir = join(dir, "static");
    const [r] = await restoreMemberPacks([zip], staticDir, PACKS);
    assertEquals(r.written, ["/snes/Dezaemon.sfc"]);
    assertEquals(r.skipped, ["/index.html"]);
    assertEquals(
      await Deno.readFile(join(staticDir, "snes", "Dezaemon.sfc")),
      new Uint8Array([7]),
    );
    await assertRejects(() => Deno.stat(join(staticDir, "index.html")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ranges, paths, types and folders are read the way a browser and a player expect", () => {
  assertEquals(parseRange("bytes=0-0", 10), { start: 0, end: 0 });
  assertEquals(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  assertEquals(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assertEquals(parseRange("bytes=2-100", 10), { start: 2, end: 9 });
  assertEquals(parseRange("bytes=10-", 10), "unsatisfiable");
  assertEquals(parseRange("bytes=0-1,4-5", 10), null);
  assertEquals(parseRange(null, 10), null);

  assertEquals(
    decodedPath("/n64dd/Dezaemon%203D.z64"),
    "/n64dd/Dezaemon 3D.z64",
  );
  assertEquals(decodedPath("/a/%2e%2e/b"), null);
  assertEquals(decodedPath("/a/%E0%A4%A"), null);
  assertEquals(decodedPath("/"), null);

  assertEquals(memberContentType("/x/boss.mp3"), "audio/mpeg");
  assertEquals(memberContentType("/x/a.SFC"), "application/octet-stream");

  const dirs = memberDirs({
    env: {
      SHMUPX_MEMBERS: ["/mnt/usb/members", "/opt/more"].join(
        Deno.build.os === "windows" ? ";" : ":",
      ),
    },
    dataDir: "/home/p/.local/share/shmupX",
    execPath: "/Applications/shmupX.app/Contents/MacOS/shmupX",
  });
  assertEquals(dirs[0], "/mnt/usb/members");
  assertEquals(dirs[1], "/opt/more");
  assert(dirs.includes(join("/home/p/.local/share/shmupX", "members")));
  assert(dirs.includes(join("/Applications", "members")));
});

Deno.test("only a packaged app's own marker makes it the Steam build", async () => {
  assertEquals(launcherFlavor({ SHMUPX_FLAVOR: "steam" }), "steam");
  assertEquals(launcherFlavor({}), null);
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "flavor.json");
    await Deno.writeTextFile(
      file,
      flavorFileText(new Date("2026-10-18T00:00:00Z")),
    );
    const url = new URL(
      "file://" + (Deno.build.os === "windows" ? "/" : "") +
        file.replaceAll("\\", "/"),
    );
    assertEquals(readFlavorFile(url)?.flavor, "steam");
    await Deno.writeTextFile(file, '{"flavor":"retail"}');
    assertEquals(readFlavorFile(url), null);
    assertEquals(readFlavorFile(new URL("./nope.json", url)), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
