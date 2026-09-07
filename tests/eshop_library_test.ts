// The eShop library's pure and injectable halves, under Deno.
//
// static/eshop-library.js is browser code (Cache Storage, IndexedDB, a service
// worker), but everything that decides WHAT to do — which repo an entry
// tracks, where its zip comes from, how two catalog halves merge, what a
// publish writes and in what order — takes no browser at all, and those are
// the rules the dashboard and the editor both lean on. Network goes through
// fetchImpl stubs: nothing here touches GitHub or the live database.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as eshopModule from "../static/eshop-library.js";
import * as shelfModule from "../static/deza-shelf.js";
import { gunzip, interleave } from "../packages/shmup-engine/mod.js";

// deno-lint-ignore no-explicit-any
type Any = any;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// The surface under test, spelled out: the modules are plain JS and this is
// the contract the two surfaces integrate against.
interface EshopLib {
  ESHOP_CACHE: string;
  ESHOP_PREFIX: string;
  ESHOP_RTDB: string;
  ESHOP_CHANNEL: string;
  MISTER_SAV_BYTES: number;
  LOGICAL_SAV_BYTES: number;
  normalizeEshopEntry(
    raw: unknown,
    origin?: string,
    key?: string,
  ): { entry?: Any; error?: string };
  loadEshopCatalog(
    opts?: { manifestUrl?: string; rtdb?: string; fetchImpl?: Fetch },
  ): Promise<
    {
      entries: Any[];
      errors: string[];
      sources: { manifest: string; rtdb: string };
      offline: boolean;
    }
  >;
  githubRepo(entry: unknown): { owner: string; repo: string } | null;
  latestSha(entry: unknown, fetchImpl?: Fetch): Promise<string | null>;
  resolveDownloadUrl(entry: unknown, sha?: string | null): string;
  entryUrl(entry: unknown): string;
  contentTypeFor(path: string): string;
  dezaBytesForShelf(bytes: Uint8Array, engine?: Any): Promise<Uint8Array>;
  publishDezaGame(opts: Record<string, unknown>): Promise<
    { id: string; index: Any; shelf: Any; shelfError: string }
  >;
  unpublishDezaGame(
    id: string,
    fetchImpl?: Fetch,
    rtdb?: string,
  ): Promise<{ id: string; deleted: string[] }>;
  notifyEshopChanged(): void;
  onEshopChanged(cb: () => void): () => void;
}
interface ShelfLib {
  DEZA_SHELF_DB: string;
  DEZA_SHELF_STORE: string;
  DEZA_SHELF_CHANNEL: string;
  slugOfTitle(title: unknown): string;
  dezaShelfIdForExport(title: unknown, palette: unknown): string;
  dezaShelfIdForEshop(id: unknown): string;
  isEshopShelfEntry(rec: unknown): boolean;
  listDezaShelf(): Promise<Any[]>;
  notifyDezaShelfChanged(): void;
  onDezaShelfChanged(cb: () => void): () => void;
}
const lib = eshopModule as unknown as EshopLib;
const shelf = shelfModule as unknown as ShelfLib;

const SHA = "390bb98a5975c614b6658f4210d3a05288a42b98";
const PARTY = {
  id: "shmup-party-phaser4",
  kind: "web",
  name: "Sh'M↑ Party",
  title: "SH'M↑ PARTY",
  sub: "Phaser 4 // 1-4 players · attract mode",
  icon: "/icons/shmup-party-icon.png",
  source: "github",
  repo: "easierbycode/shmup-party-phaser4",
  branch: "main",
  entry: "index.html",
  downloadUrl:
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/main/shmup-party-phaser4.zip",
  size: "8 MB",
  date: "07.28.26",
  twinStick: { default: true },
};

/** A fetch stub: routes by URL prefix, logs every call in order. */
function stubFetch(
  routes: Record<string, (url: string, init?: RequestInit) => Response>,
) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetchImpl: Fetch = (url, init) => {
    const method = (init?.method || "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : null,
    });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return Promise.resolve(handler(url, init));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetchImpl, calls };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const down = (): Response => {
  throw new TypeError("Failed to fetch");
};

// ── GitHub ───────────────────────────────────────────────────────────────────

Deno.test("githubRepo reads every GitHub spelling and nothing else", () => {
  const want = { owner: "easierbycode", repo: "shmup-party-phaser4" };
  for (
    const repo of [
      "easierbycode/shmup-party-phaser4",
      "easierbycode/shmup-party-phaser4.git",
      "https://github.com/easierbycode/shmup-party-phaser4",
      "https://www.github.com/easierbycode/shmup-party-phaser4.git",
      "github.com/easierbycode/shmup-party-phaser4",
      "git@github.com:easierbycode/shmup-party-phaser4.git",
      "  easierbycode/shmup-party-phaser4  ",
    ]
  ) {
    assertEquals(lib.githubRepo({ repo }), want, repo);
    assertEquals(lib.githubRepo(repo), want, "as a bare string: " + repo);
  }
  for (
    const repo of [
      "",
      "shmup-party-phaser4",
      "https://easierbycode.com/mario-sp", // a deploy URL, not a repo
      "easierbycode.com/mario-sp", // scheme-less deploy URL
      "git@gitlab.com:owner/name.git",
      "https://gitlab.com/owner/name",
    ]
  ) {
    assertStrictEquals(lib.githubRepo({ repo }), null, repo);
  }
  assertStrictEquals(lib.githubRepo(null), null);
  assertStrictEquals(lib.githubRepo({}), null);
});

Deno.test("latestSha accepts only a full sha from a GitHub entry", async () => {
  const api = "https://api.github.com/repos/easierbycode/shmup-party-phaser4/";
  const ok = stubFetch({ [api]: () => new Response(SHA.toUpperCase() + "\n") });
  assertStrictEquals(await lib.latestSha(PARTY, ok.fetchImpl), SHA);
  assertEquals(ok.calls[0].url, api + "commits/main");

  const short = stubFetch({ [api]: () => new Response("390bb98") });
  assertStrictEquals(await lib.latestSha(PARTY, short.fetchImpl), null);
  const limited = stubFetch({ [api]: () => new Response("", { status: 403 }) });
  assertStrictEquals(await lib.latestSha(PARTY, limited.fetchImpl), null);
  const offline = stubFetch({ [api]: down });
  assertStrictEquals(await lib.latestSha(PARTY, offline.fetchImpl), null);

  // Not a GitHub repo: no request at all.
  const never = stubFetch({});
  assertStrictEquals(
    await lib.latestSha(
      { repo: "https://easierbycode.com/x", branch: "main" },
      never.fetchImpl,
    ),
    null,
  );
  assertEquals(never.calls.length, 0);

  // A branch with a slash is one path segment to the API.
  const nested = stubFetch({ [api]: () => new Response(SHA) });
  await lib.latestSha({ ...PARTY, branch: "release/1.0" }, nested.fetchImpl);
  assertEquals(nested.calls[0].url, api + "commits/release%2F1.0");
});

Deno.test("resolveDownloadUrl pins a raw URL to the sha and otherwise leaves it", () => {
  assertEquals(
    lib.resolveDownloadUrl(PARTY, SHA),
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/" +
      SHA + "/shmup-party-phaser4.zip",
  );
  assertEquals(lib.resolveDownloadUrl(PARTY, null), PARTY.downloadUrl);
  assertEquals(lib.resolveDownloadUrl(PARTY, "390bb98"), PARTY.downloadUrl);
  // The refs/heads/ spelling of the same URL pins too.
  assertEquals(
    lib.resolveDownloadUrl({
      ...PARTY,
      downloadUrl:
        "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/refs/heads/main/dist/game.zip",
    }, SHA),
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/" +
      SHA + "/dist/game.zip",
  );
  // A slashed branch is matched whole.
  assertEquals(
    lib.resolveDownloadUrl({
      ...PARTY,
      branch: "release/1.0",
      downloadUrl:
        "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/release/1.0/game.zip",
    }, SHA),
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/" +
      SHA + "/game.zip",
  );
  // Another repo's raw file, a different branch, or a non-raw host: untouched.
  const other =
    "https://raw.githubusercontent.com/someone/else/main/shmup-party-phaser4.zip";
  assertEquals(
    lib.resolveDownloadUrl({ ...PARTY, downloadUrl: other }, SHA),
    other,
  );
  const dev =
    "https://raw.githubusercontent.com/easierbycode/shmup-party-phaser4/dev/x.zip";
  assertEquals(
    lib.resolveDownloadUrl({ ...PARTY, downloadUrl: dev }, SHA),
    dev,
  );
  const cdn = "https://cdn.example.com/builds/party.zip";
  assertEquals(
    lib.resolveDownloadUrl({ ...PARTY, downloadUrl: cdn }, SHA),
    cdn,
  );
});

Deno.test("resolveDownloadUrl falls back to the local zip route for a GitHub entry", () => {
  const bare = { ...PARTY, downloadUrl: "" };
  assertEquals(
    lib.resolveDownloadUrl(bare, null),
    "/api/eshop/zip?repo=easierbycode/shmup-party-phaser4&branch=main",
  );
  assertEquals(
    lib.resolveDownloadUrl(bare, SHA),
    "/api/eshop/zip?repo=easierbycode/shmup-party-phaser4&branch=main&ref=" +
      SHA,
  );
  assertEquals(
    lib.resolveDownloadUrl({ ...bare, branch: "release/1.0" }, null),
    "/api/eshop/zip?repo=easierbycode/shmup-party-phaser4&branch=release/1.0",
  );
  assertThrows(
    () =>
      lib.resolveDownloadUrl({
        id: "loose",
        kind: "web",
        source: "url",
        downloadUrl: "",
      }),
    Error,
    "loose has no downloadUrl",
  );
});

Deno.test("entryUrl is the same-origin page under /eshop/<id>/", () => {
  assertEquals(lib.entryUrl(PARTY), "/eshop/shmup-party-phaser4/index.html");
  assertEquals(
    lib.entryUrl({ id: "g", entry: "./dist/play.html" }),
    "/eshop/g/dist/play.html",
  );
  assertEquals(
    lib.entryUrl({ id: "g", entry: "/main.html" }),
    "/eshop/g/main.html",
  );
  assertEquals(lib.entryUrl({ id: "g" }), "/eshop/g/index.html");
});

Deno.test("contentTypeFor names the types that matter and defaults the rest", () => {
  assertEquals(lib.contentTypeFor("game.wasm"), "application/wasm");
  assertEquals(
    lib.contentTypeFor("assets/Game.JS"),
    "text/javascript; charset=utf-8",
  );
  assertEquals(lib.contentTypeFor("index.html"), "text/html; charset=utf-8");
  assertEquals(
    lib.contentTypeFor("a/b.webmanifest"),
    "application/manifest+json",
  );
  assertEquals(lib.contentTypeFor("font.woff2"), "font/woff2");
  assertEquals(lib.contentTypeFor("data.bin"), "application/octet-stream");
});

// ── The catalog ──────────────────────────────────────────────────────────────

Deno.test("normalizeEshopEntry fills the defaults and refuses a malformed row", () => {
  const { entry } = lib.normalizeEshopEntry({
    id: "x",
    kind: "web",
    name: "X",
    repo: "o/r",
  });
  assertEquals(entry.title, "X");
  assertEquals(entry.branch, "main");
  assertEquals(entry.entry, "index.html");
  assertEquals(entry.source, "github");
  assertEquals(entry.origin, "manifest");
  assertEquals(entry.icon, null);

  const deza = lib.normalizeEshopEntry(
    {
      kind: "deza",
      name: "Foo",
      size: 1114112,
      hasCover: true,
      publishedAt: 5,
    },
    "rtdb",
    "foo",
  ).entry;
  assertEquals(deza.id, "foo");
  assertEquals(deza.size, "1.1 MB");
  assertEquals(deza.sizeBytes, 1114112);
  assertEquals(deza.palette, "saturn");
  assertEquals(deza.source, "editor");
  assertEquals(deza.hasCover, true);

  for (
    const [raw, why] of [
      [{ id: "Bad Id", kind: "web", name: "n", repo: "o/r" }, "bad id"],
      [{ id: "x", kind: "rom", name: "n" }, "not web or deza"],
      [{ id: "x", kind: "web", repo: "o/r" }, "no name"],
      [
        { id: "x", kind: "web", name: "n", source: "url" },
        "needs a downloadUrl",
      ],
      ["nope", "not an object"],
      [null, "not an object"],
    ] as [unknown, string][]
  ) {
    const { entry, error } = lib.normalizeEshopEntry(raw);
    assertStrictEquals(entry, undefined);
    assert(error && error.includes(why), `${JSON.stringify(raw)}: ${error}`);
  }
});

Deno.test("loadEshopCatalog merges the manifest and the database; a static id wins", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/games.manifest.json": () =>
      json({
        version: 1,
        games: [],
        eshop: [PARTY, {
          id: "shared",
          kind: "deza",
          name: "Static Shared",
          slug: "shared",
        }],
      }),
    "https://db.test/eshop/index.json": () =>
      json({
        older: { kind: "deza", name: "Older", publishedAt: 1, size: 1114112 },
        newer: {
          kind: "deza",
          name: "Newer",
          publishedAt: 2,
          size: 1114112,
          hasCover: true,
        },
        shared: { kind: "deza", name: "Published Shared", publishedAt: 3 },
        broken: { kind: "deza" },
      }),
  });
  const got = await lib.loadEshopCatalog({
    rtdb: "https://db.test",
    fetchImpl,
  });
  assertEquals(got.entries.map((e) => e.id), [
    "shmup-party-phaser4",
    "shared",
    "newer",
    "older",
  ]);
  assertEquals(got.entries[1].name, "Static Shared");
  assertEquals(got.entries[1].origin, "manifest");
  assertEquals(got.entries[2].origin, "rtdb");
  assertEquals(
    got.entries[2].coverUrl,
    "https://db.test/eshop/covers/newer.json",
  );
  assertEquals(got.entries[3].coverUrl, null);
  assertEquals(got.entries[0].twinStick, { default: true });
  assertEquals(got.errors, ["rtdb/broken: broken: no name"]);
  assertEquals(got.sources, { manifest: "ok", rtdb: "ok" });
  assertEquals(got.offline, false);
  assertEquals(calls.map((c) => c.url), [
    "/games.manifest.json",
    "https://db.test/eshop/index.json",
  ]);
});

Deno.test("loadEshopCatalog fails soft: old manifest, dead database, both down", async () => {
  // A manifest from before data/eshop.json existed lists nothing — no error.
  const old = stubFetch({
    "/games.manifest.json": () => json({ version: 1, games: [] }),
    "https://db.test/eshop/index.json": () => json(null),
  });
  const a = await lib.loadEshopCatalog({
    rtdb: "https://db.test",
    fetchImpl: old.fetchImpl,
  });
  assertEquals(a.entries, []);
  assertEquals(a.errors, []);
  assertEquals(a.offline, false);

  // The database unreachable: the manifest's games still install.
  const half = stubFetch({
    "/games.manifest.json": () => json({ eshop: [PARTY] }),
    "https://db.test/eshop/index.json": down,
  });
  const b = await lib.loadEshopCatalog({
    rtdb: "https://db.test",
    fetchImpl: half.fetchImpl,
  });
  assertEquals(b.entries.map((e) => e.id), ["shmup-party-phaser4"]);
  assertEquals(b.errors, [
    "rtdb: Failed to fetch (https://db.test/eshop/index.json)",
  ]);
  assertEquals(b.sources.rtdb, "error");
  assertEquals(b.offline, false);

  // Manifest 404 and the database refusing: CATALOG OFFLINE.
  const none = stubFetch({
    "/games.manifest.json": () => new Response("", { status: 404 }),
    "https://db.test/eshop/index.json": () => new Response("", { status: 401 }),
  });
  const c = await lib.loadEshopCatalog({
    rtdb: "https://db.test",
    fetchImpl: none.fetchImpl,
  });
  assertEquals(c.entries, []);
  assertEquals(c.errors, [
    "manifest: HTTP 404 (/games.manifest.json)",
    "rtdb: HTTP 401 (https://db.test/eshop/index.json)",
  ]);
  assertEquals(c.offline, true);

  // A malformed manifest row is skipped, the rest kept.
  const mixed = stubFetch({
    "/games.manifest.json": () =>
      json({
        eshop: [{ id: "x", kind: "web", name: "no source" }, PARTY, PARTY],
      }),
    "https://db.test/eshop/index.json": () => json(null),
  });
  const d = await lib.loadEshopCatalog({
    rtdb: "https://db.test",
    fetchImpl: mixed.fetchImpl,
  });
  assertEquals(d.entries.map((e) => e.id), ["shmup-party-phaser4"]);
  assertEquals(d.errors, [
    "manifest[0]: x: a web entry needs a downloadUrl or a GitHub repo",
    "manifest[2]: duplicate id shmup-party-phaser4",
  ]);
});

// ── Dezaemon carts ───────────────────────────────────────────────────────────

/** A recognisable 557,056-byte logical cart: every byte is its offset's low 8 bits. */
function logicalCart(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(lib.LOGICAL_SAV_BYTES);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

Deno.test("dezaBytesForShelf stores the MiSTer layout whatever the source wrapped", async () => {
  const logical = logicalCart();
  const full = interleave(logical);
  assertEquals(full.length, lib.MISTER_SAV_BYTES);
  // The community/eShop form: gzip of the deinterleaved image.
  const gz = new Uint8Array(
    await new Response(
      new Blob([logical]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  assertEquals(await lib.dezaBytesForShelf(gz), full);
  // An interleaved cart handed over raw comes back as itself.
  assertEquals(await lib.dezaBytesForShelf(full), full);
  // A bare logical image is re-interleaved.
  assertEquals(await lib.dezaBytesForShelf(logical), full);
  // Anything else is not a cart.
  await assertRejects(
    () => lib.dezaBytesForShelf(new Uint8Array(0x8000)),
    Error,
    "32,768 bytes once unwrapped",
  );
});

Deno.test("publishDezaGame writes the save, the cover, then the index — and the save round-trips", async () => {
  const logical = logicalCart();
  const sav = interleave(logical);
  const { fetchImpl, calls } = stubFetch({
    "https://db.test/": () => new Response(null, { status: 204 }),
  });
  const got = await lib.publishDezaGame({
    name: "Foo Bar!",
    sav,
    palette: "snes",
    report: { stages: [{}, {}], cells: 300 },
    cover: { png: "data:image/png;base64,iVBORw0KGgo=", w: 256, h: 480 },
    author: "me",
    fetchImpl,
    rtdb: "https://db.test/",
  });
  assertEquals(got.id, "foo-bar");
  // Order is the contract: a half-published game must never list.
  assertEquals(calls.map((c) => c.method + " " + c.url), [
    "PUT https://db.test/eshop/saves/foo-bar.json?print=silent",
    "PUT https://db.test/eshop/covers/foo-bar.json?print=silent",
    "PUT https://db.test/eshop/index/foo-bar.json?print=silent",
  ]);

  const saves = JSON.parse(calls[0].body!);
  assertEquals(saves.interleaveProfile, "ff-even");
  assertEquals(saves.logicalSize, lib.LOGICAL_SAV_BYTES);
  assert(Number.isFinite(saves.publishedAt));
  const gz = Uint8Array.from(atob(saves.sav), (c) => c.charCodeAt(0));
  assertEquals(
    await gunzip(gz),
    logical,
    "gzip(deinterleave(sav)) must unwrap to the logical cart",
  );

  const cover = JSON.parse(calls[1].body!);
  assertEquals(cover.png, "data:image/png;base64,iVBORw0KGgo=");
  assertEquals([cover.w, cover.h], [256, 480]);

  const index = JSON.parse(calls[2].body!);
  assertEquals(index, got.index);
  assertEquals(index.schemaVersion, 1);
  assertEquals(index.kind, "deza");
  assertEquals(index.name, "Foo Bar!");
  assertEquals(index.title, "FOO BAR!");
  assertEquals(index.file, "Dez 2 - Foo Bar!.sav");
  assertEquals(index.palette, "snes");
  assertEquals(index.size, lib.MISTER_SAV_BYTES);
  assertEquals(index.sizeLabel, "1.1 MB");
  assertMatch(index.date, /^\d\d\.\d\d\.\d\d$/);
  assertEquals(index.publishedAt, saves.publishedAt);
  assertEquals(index.hasCover, true);
  assertEquals(index.stages, 2);
  assertEquals(index.cells, 300);
  assertEquals(index.author, "me");
  assertEquals(index.source, "editor");
  assertEquals(index.sub, "2 STAGES · 300/1024 CG CELLS · SNES PALETTE");

  // No IndexedDB here: the shelf half fails soft, the publish stands.
  assertStrictEquals(got.shelf, null);
  assert(got.shelfError.includes("shmupxDezaExports"), got.shelfError);
});

Deno.test("publishDezaGame stops before the index when the save is refused", async () => {
  const { fetchImpl, calls } = stubFetch({
    "https://db.test/eshop/saves/": () =>
      new Response("Permission denied", { status: 401 }),
    "https://db.test/": () => new Response(null, { status: 204 }),
  });
  await assertRejects(
    () =>
      lib.publishDezaGame({
        name: "Locked",
        sav: interleave(logicalCart()),
        fetchImpl,
        rtdb: "https://db.test",
      }),
    Error,
    "refused /eshop/saves/locked (HTTP 401: Permission denied)",
  );
  assertEquals(calls.length, 1);

  // A cart of the wrong size never reaches the network.
  const idle = stubFetch({});
  await assertRejects(
    () =>
      lib.publishDezaGame({
        name: "Short",
        sav: new Uint8Array(100),
        fetchImpl: idle.fetchImpl,
      }),
    Error,
    "a Dezaemon 2 cart is 1,114,112",
  );
  await assertRejects(
    () =>
      lib.publishDezaGame({
        name: "",
        sav: new Uint8Array(100),
        fetchImpl: idle.fetchImpl,
      }),
    Error,
    "needs a name",
  );
  assertEquals(idle.calls.length, 0);
});

Deno.test("publishDezaGame takes an explicit id and a logical cart", async () => {
  const { fetchImpl, calls } = stubFetch({
    "https://db.test/": () => new Response(null, { status: 204 }),
  });
  const got = await lib.publishDezaGame({
    id: "my-game-2",
    name: "My Game",
    sav: logicalCart(),
    fetchImpl,
    rtdb: "https://db.test",
  });
  assertEquals(got.id, "my-game-2");
  assertEquals(got.index.hasCover, false);
  assertEquals(got.index.sub, "0 STAGES · 0/1024 CG CELLS · SATURN PALETTE");
  // No cover: two writes, save then index.
  assertEquals(calls.map((c) => c.url), [
    "https://db.test/eshop/saves/my-game-2.json?print=silent",
    "https://db.test/eshop/index/my-game-2.json?print=silent",
  ]);
  await assertRejects(
    () =>
      lib.publishDezaGame({
        id: "Not OK",
        name: "x",
        sav: logicalCart(),
        fetchImpl,
      }),
    Error,
    'bad eShop id "Not OK"',
  );
});

Deno.test("unpublishDezaGame deletes the index first, then the save and cover", async () => {
  const { fetchImpl, calls } = stubFetch({
    "https://db.test/": () => new Response(null, { status: 204 }),
  });
  const got = await lib.unpublishDezaGame(
    "foo-bar",
    fetchImpl,
    "https://db.test",
  );
  assertEquals(got, { id: "foo-bar", deleted: ["index", "saves", "covers"] });
  assertEquals(calls.map((c) => c.method + " " + c.url), [
    "DELETE https://db.test/eshop/index/foo-bar.json",
    "DELETE https://db.test/eshop/saves/foo-bar.json",
    "DELETE https://db.test/eshop/covers/foo-bar.json",
  ]);
});

// ── The shelf ────────────────────────────────────────────────────────────────

Deno.test("the shelf's slugs and ids match the editor's", () => {
  assertEquals(shelf.DEZA_SHELF_DB, "shmupxDezaExports");
  assertEquals(shelf.DEZA_SHELF_STORE, "saves");
  assertEquals(shelf.DEZA_SHELF_CHANNEL, "shmupx-deza-shelf");
  // dezaSlugOfTitle / slugOf, verbatim.
  assertEquals(shelf.slugOfTitle("Air Streamer -Ver.A-"), "air-streamer-ver-a");
  assertEquals(shelf.slugOfTitle("  ÉVIL  Invaders!! "), "vil-invaders");
  assertEquals(shelf.slugOfTitle(""), "save");
  assertEquals(shelf.slugOfTitle(undefined), "save");
  // The editor's dezaExportId: "<slug>:<palette>".
  assertEquals(shelf.dezaShelfIdForExport("Foo Bar", "snes"), "foo-bar:snes");
  assertEquals(shelf.dezaShelfIdForExport("Foo", undefined), "foo:saturn");
  assertEquals(shelf.dezaShelfIdForEshop("foo-bar"), "eshop:foo-bar");
  assert(shelf.isEshopShelfEntry({ id: "eshop:foo", source: "eshop" }));
  assert(shelf.isEshopShelfEntry({ id: "eshop:foo" }));
  assert(shelf.isEshopShelfEntry({ id: "foo:saturn", source: "eshop" }));
  assert(!shelf.isEshopShelfEntry({ id: "foo:saturn", source: "export" }));
  assert(!shelf.isEshopShelfEntry({ id: "foo:saturn" }));
  assert(!shelf.isEshopShelfEntry(null));
});

Deno.test("listDezaShelf is an empty shelf where there is no IndexedDB", async () => {
  assertEquals(await shelf.listDezaShelf(), []);
});

Deno.test("change notification works with no browser around it", () => {
  let eshopHits = 0;
  let shelfHits = 0;
  const offEshop = lib.onEshopChanged(() => eshopHits++);
  const offShelf = shelf.onDezaShelfChanged(() => shelfHits++);
  lib.notifyEshopChanged();
  shelf.notifyDezaShelfChanged();
  assertEquals([eshopHits, shelfHits], [1, 1]);
  offEshop();
  offShelf();
  lib.notifyEshopChanged();
  shelf.notifyDezaShelfChanged();
  assertEquals([eshopHits, shelfHits], [1, 1]);
  assertEquals(lib.ESHOP_CHANNEL, "shmupx-eshop");
  assertEquals(lib.ESHOP_CACHE, "shmupx-eshop-v1");
  assertEquals(lib.ESHOP_PREFIX, "/eshop/");
  assertEquals(
    lib.ESHOP_RTDB,
    "https://evil-invaders-default-rtdb.firebaseio.com",
  );
});
