// The Super Famicom library's pure and injectable halves, under Deno.
//
// static/snes-shelf.js and static/snes-library.js are browser code (IndexedDB,
// BroadcastChannel, a service worker), but everything that decides WHAT to do —
// what a filename means, what slug a title takes, how a published row is read,
// what unwrapping a published cart checks — takes no browser at all, and those
// are the rules the editor, the launcher and the publisher all lean on.
//
// It also holds the MIRRORED COPIES equal. The slug rule exists twice on
// purpose: scripts/lib/sfc-library.ts keys the database on it and
// static/snes-shelf.js keys the browser's shelf on it, and they cannot import
// each other (static/ is plain browser ESM and cannot reach a .ts module). If
// they ever disagree, a game installed from the library and the same game
// imported from disk would sit on the shelf as two different rows — so the two
// are checked against each other rather than trusted.
//
// Network goes through fetchImpl stubs: nothing here touches the live database.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as shelf from "../static/snes-shelf.js";
import * as library from "../static/snes-library.js";
import {
  isSfcSaveName,
  sfcDumpDate,
  sfcFileTitle,
  sfcSlugOfFile,
  sfcSlugOfTitle as sfcSlugOfTitleTs,
} from "../scripts/lib/sfc-library.ts";
import { encodeBase64 } from "@std/encoding/base64";

// deno-lint-ignore no-explicit-any
type Any = any;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const SRAM_BYTES = 131072;
const CHECK_STRING_AT = 0x7ff8;

/** A minimal dump that passes isSfcSav: the right size and the magic. */
function fakeCart(fill = 0): Uint8Array {
  const bytes = new Uint8Array(SRAM_BYTES).fill(fill);
  new TextEncoder().encodeInto("T.TABATA", bytes.subarray(CHECK_STRING_AT));
  return bytes;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function jsonFetch(routes: Record<string, unknown>): Fetch {
  return (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) {
      return Promise.resolve(new Response("no", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(routes[key]), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

// ── the mirrored rules ───────────────────────────────────────────────────────

Deno.test("the browser's slug rule and the publisher's are the same rule", () => {
  const titles = [
    "ALDI Adventure",
    "A-28",
    "Air Streamer -Ver.A-",
    "May-Yang's 2mins World 'DAY1'",
    "  spaced  out  ",
    "Choh Parody Spirit Twin Ex.Sound ver.",
    "弾幕", // no ASCII alphanumerics at all
    "",
    "---",
  ];
  for (const title of titles) {
    assertEquals(
      (shelf as Any).sfcSlugOfTitle(title),
      sfcSlugOfTitleTs(title),
      `the two copies disagree about ${JSON.stringify(title)}`,
    );
  }
  // Both fall back rather than returning "": the slug IS the shelf id.
  assertEquals(sfcSlugOfTitleTs("弾幕"), "save");
  assertEquals(
    (shelf as Any).sfcSlugOfTitle("ALDI Adventure"),
    "aldi-adventure",
  );
});

Deno.test("the browser and the publisher split a filename the same way", () => {
  const names = [
    "ALDI Adventure (2026-08-22).srm",
    "ALDI Adventure.srm",
    "Dez SNES.sav",
    "Something (2026-8-2).srm", // not the dated shape: part of the title
    "Weird (2026-08-22) (2026-01-01).srm", // only the trailing one is a date
  ];
  for (const name of names) {
    const browser = (shelf as Any).sfcTitleFromFileName(name);
    assertEquals(browser.title, sfcFileTitle(name), `title of ${name}`);
    assertEquals(browser.dumpedAt, sfcDumpDate(name), `date of ${name}`);
  }
  assertEquals(
    sfcFileTitle("ALDI Adventure (2026-08-22).srm"),
    "ALDI Adventure",
  );
  assertEquals(sfcDumpDate("ALDI Adventure (2026-08-22).srm"), "2026-08-22");
  assertEquals(sfcDumpDate("ALDI Adventure.srm"), null);
  assertEquals(
    sfcFileTitle("Something (2026-8-2).srm"),
    "Something (2026-8-2)",
  );
  // A re-dump is the same game: both dates slug to one shelf row.
  assertEquals(
    sfcSlugOfFile("ALDI Adventure (2026-08-22).srm"),
    sfcSlugOfFile("ALDI Adventure (2027-01-09).srm"),
  );
});

Deno.test("the library walk skips AppleDouble forks and foreign extensions", () => {
  assertEquals(isSfcSaveName("ALDI Adventure (2026-08-22).srm"), true);
  assertEquals(isSfcSaveName("Dez SNES.sav"), true);
  assertEquals(isSfcSaveName("cart.sr0"), true);
  // What macOS leaves beside every file on this project's exFAT volume.
  assertEquals(isSfcSaveName("._ALDI Adventure (2026-08-22).srm"), false);
  assertEquals(isSfcSaveName("notes.txt"), false);
  assertEquals(isSfcSaveName("Dezaemon.sfc"), false);
});

// ── shelf ids ────────────────────────────────────────────────────────────────

Deno.test("an import and a library install never collide", () => {
  const s = shelf as Any;
  const mine = s.snesShelfIdForImport("ALDI Adventure");
  const theirs = s.snesShelfIdForLibrary("aldi-adventure");
  assertEquals(mine, "aldi-adventure");
  assertEquals(theirs, "library:aldi-adventure");
  assert(
    mine !== theirs,
    "installing a published game must not overwrite a dump",
  );
  assertEquals(s.isLibraryShelfEntry({ id: theirs }), true);
  assertEquals(s.isLibraryShelfEntry({ id: mine }), false);
  assertEquals(s.isLibraryShelfEntry({ id: mine, source: "library" }), true);
  assertEquals(s.isLibraryShelfEntry(null), false);
});

Deno.test("a shelf with no IndexedDB is empty, not broken", async () => {
  // Deno has no IndexedDB, which is exactly the private-mode case the launcher
  // has to survive: listSnesShelf swallows it, the writers do not.
  assertEquals(await (shelf as Any).listSnesShelf(), []);
  await assertRejects(
    () => (shelf as Any).putSnesShelfEntry({ id: "x", bytes: fakeCart() }),
    Error,
    "IndexedDB",
  );
});

Deno.test("a shelf record needs an id and real bytes", async () => {
  const s = shelf as Any;
  await assertRejects(
    () => s.putSnesShelfEntry({ bytes: fakeCart() }),
    Error,
    "string id",
  );
  await assertRejects(
    () => s.putSnesShelfEntry({ id: "x" }),
    Error,
    "SRAM bytes",
  );
  // The console gate comes before the store, so it fires even here where there
  // is no IndexedDB to reach: a Saturn cart is never a SNES shelf row.
  await assertRejects(
    () => s.putSnesShelfEntry({ id: "x", bytes: new Uint8Array(1114112) }),
    Error,
    "not a Dezaemon SRAM dump",
  );
});

Deno.test("isSfcCart reads the magic, not the extension", async () => {
  const s = shelf as Any;
  assertEquals(await s.isSfcCart(fakeCart()), true);
  // The right size, no magic — a formatted-but-foreign SRAM.
  assertEquals(await s.isSfcCart(new Uint8Array(SRAM_BYTES)), false);
  // A Saturn cart image.
  assertEquals(await s.isSfcCart(new Uint8Array(1114112)), false);
  assertEquals(await s.isSfcCart(new Uint8Array(16)), false);
});

// ── the published catalogue ──────────────────────────────────────────────────

const ALDI_ROW = {
  schemaVersion: 1,
  system: "sfc",
  slug: "aldi-adventure",
  file: "ALDI Adventure (2026-08-22).srm",
  fileTitle: "ALDI Adventure",
  dumpedAt: "2026-08-22",
  titleEn: "ALDI Adventure",
  titleJa: null,
  developerEn: "NovaSquirrel",
  genre: "Vertical Shoot-em-up",
  savBytes: SRAM_BYTES,
  complete: true,
  stageCells: [1234, 1792, 1862, 1694, 1176, 1006],
  enemiesUsed: 24,
  graphicsTiles: 1947,
  hasCover: true,
};

Deno.test("a published row is normalised, and a bad slug is refused", () => {
  const { entry } = (library as Any).normalizeSnesEntry(
    "aldi-adventure",
    ALDI_ROW,
  );
  assertEquals(entry.slug, "aldi-adventure");
  assertEquals(entry.name, "ALDI Adventure");
  assertEquals(entry.title, "ALDI ADVENTURE");
  assertEquals(entry.developer, "NovaSquirrel");
  assertEquals(entry.genre, "Vertical Shoot-em-up");
  assertEquals(entry.dumpedAt, "2026-08-22");
  assertEquals(entry.stageCells.length, 6);
  assertEquals(entry.hasCover, true);
  assertEquals(entry.complete, true);
  // A row that names no title falls back to its slug rather than rendering blank.
  assertEquals(
    (library as Any).normalizeSnesEntry("x-y", {}).entry.name,
    "x-y",
  );
  // Slugs become URL path segments and RTDB keys; anything else is refused.
  for (const bad of ["../etc", "Has Caps", "", "-leading", "a".repeat(80)]) {
    assert(
      (library as Any).normalizeSnesEntry(bad, ALDI_ROW).error,
      `${JSON.stringify(bad)} should not be a library slug`,
    );
  }
  assert((library as Any).normalizeSnesEntry("ok", "not a record").error);
});

Deno.test("the catalogue sorts newest dump first and fails soft when offline", async () => {
  const lib = library as Any;
  const index = {
    "aldi-adventure": ALDI_ROW,
    "older": {
      ...ALDI_ROW,
      slug: "older",
      titleEn: "Older",
      dumpedAt: "2025-01-01",
    },
    "undated": {
      ...ALDI_ROW,
      slug: "undated",
      titleEn: "Undated",
      dumpedAt: null,
    },
    "BAD SLUG": ALDI_ROW,
  };
  const ok = await lib.loadSnesLibrary({
    fetchImpl: jsonFetch({ "/index.json": index }),
  });
  assertEquals(ok.entries.map((e: Any) => e.slug), [
    "aldi-adventure",
    "older",
    "undated",
  ]);
  assertEquals(ok.offline, false);
  assertEquals(ok.errors.length, 1); // the bad slug, named rather than silently dropped

  // An unreachable database is an empty library with a reason — the launcher
  // renders this on every open and must not have to catch.
  const down = await lib.loadSnesLibrary({
    fetchImpl: () => Promise.reject(new Error("nope")),
  });
  assertEquals(down.entries, []);
  assertEquals(down.offline, true);
  assert(down.errors[0].includes("nope"));
});

Deno.test("a published cart is unwrapped, and a short one is refused", async () => {
  const lib = library as Any;
  const cart = fakeCart(0x5a);
  const packed = await gzipBytes(cart);
  const node = {
    sav: encodeBase64(packed),
    encoding: "gzip+base64",
    savBytes: cart.length,
  };
  const bytes = await lib.fetchSnesCart(
    { slug: "aldi-adventure" },
    { fetchImpl: jsonFetch({ "/saves/aldi-adventure.json": node }) },
  );
  assertEquals(bytes.length, SRAM_BYTES);
  assertEquals(bytes[0], 0x5a);
  assertEquals(await (shelf as Any).isSfcCart(bytes), true);

  // The ledger's own byte count is the check: a blob that unzips to something
  // else was corrupted, and filing it would make a row that boots a formatted
  // cart with no sign of why.
  await assertRejects(
    () =>
      lib.fetchSnesCart({ slug: "aldi-adventure" }, {
        fetchImpl: jsonFetch({
          "/saves/": { ...node, savBytes: SRAM_BYTES + 1 },
        }),
      }),
    Error,
    "not the 131073 it was filed as",
  );
  // Nothing published under that slug at all.
  await assertRejects(
    () =>
      lib.fetchSnesCart({ slug: "missing" }, {
        fetchImpl: jsonFetch({ "/saves/missing.json": null }),
      }),
    Error,
    "no cart published",
  );
  // A slug that is not a slug never becomes a URL.
  await assertRejects(
    () =>
      lib.fetchSnesCart({ slug: "../../eshop" }, { fetchImpl: jsonFetch({}) }),
    Error,
    "bad library slug",
  );
});

Deno.test("the cartridge probe answers rather than throwing", async () => {
  const lib = library as Any;
  // The route is local-only: on the deployed origin, in a packaged app, or with
  // no server at all, this has to read as "no cartridge" and not as a crash on
  // the launcher's boot path.
  const gone = await lib.findSnesRom({
    fetchImpl: () => Promise.reject(new Error("connection refused")),
  });
  assertEquals(gone.available, false);
  assert(gone.reason.includes("connection refused"));

  const notHere = await lib.findSnesRom({
    fetchImpl: () => Promise.resolve(new Response("no", { status: 404 })),
  });
  assertEquals(notHere.available, false);

  const here = await lib.findSnesRom({
    fetchImpl: jsonFetch({
      "/api/dezaemon-sfc": { available: true, name: "Dezaemon.sfc" },
    }),
  });
  assertEquals(here.available, true);
  assertEquals(here.name, "Dezaemon.sfc");
});

Deno.test("booting refuses a shelf row when the machine has no cartridge", async () => {
  await assertRejects(
    () =>
      (library as Any).snesBootFiles({
        title: "ALDI Adventure",
        bytes: fakeCart(),
      }, {
        fetchImpl: jsonFetch({
          "/api/dezaemon-sfc": { available: false, reason: "none here" },
        }),
      }),
    Error,
    "no Dezaemon (Super Famicom) ROM",
  );
  await assertRejects(
    () =>
      (library as Any).snesBootFiles({ title: "x" }, {
        fetchImpl: jsonFetch({}),
      }),
    Error,
    "no cart bytes",
  );
});

Deno.test("the catalogue node is a sibling of the Saturn one, never inside it", () => {
  // /dezaemon holds 262 Saturn carts and is read by the eShop and the editor's
  // shelf; a Super Famicom row appearing in it would be installed as one.
  assertEquals((library as Any).SNES_LIBRARY_ROOT, "dezaemonSfc");
  assertEquals((library as Any).SNES_CORE_ID, "snes");
});
