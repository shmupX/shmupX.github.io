// lib/shelf.ts — turning a name somebody typed into something a build stages.
//
// Everything here runs with NO network, NO Node, NO Android SDK and NO local
// .sav collection (it is gitignored, and empty in a fresh clone), because that
// is the state CI and most checkouts are in. The rungs that need the network
// are exercised only through their refusals; the cart half is exercised for
// real by building one from the game this repo ships — `deno task build:sav`'s
// own trick — and reading it back, which is the round trip that decides whether
// an exported app is the whole game or a gutted one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  cartBytes,
  levelRecordFromCart,
  listShelf,
  resolveShelfName,
  ShelfError,
  shelfSlug,
} from "../lib/shelf.ts";
import { buildSav } from "../scripts/build-sav.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const OFFLINE = { root: ROOT, offline: true } as const;

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof ShelfError, `expected a ShelfError, got ${e}`);
    return e.message;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

Deno.test("one slug rule for the whole library", () => {
  // The shape the user types, the shape the directory has, and the shape the
  // database is keyed on all have to land on the same string — this is what
  // makes `build:windows 2028_ai` find static/games/2028-ai.
  assertEquals(shelfSlug("2028_ai"), "2028-ai");
  assertEquals(shelfSlug("2028-ai"), "2028-ai");
  assertEquals(shelfSlug("2028 AI"), "2028-ai");
  assertEquals(shelfSlug("G-Fencer 755"), "g-fencer-755");
  assertEquals(
    shelfSlug("Dez 2 - Air Streamer -Ver.A-"),
    "dez-2-air-streamer-ver-a",
  );
  // No `|| "save"` fallback, unlike its three siblings, and on purpose: a title
  // with no ASCII alphanumerics has to stay a miss rather than become a game
  // called "save". Nothing uses this as a path on its own.
  assertEquals(shelfSlug("!!!"), "");
  assertEquals(shelfSlug("エアストリーマー"), "");
});

Deno.test("the game this repo ships resolves offline", async () => {
  const hit = await resolveShelfName("2028_ai", OFFLINE);
  assertEquals(hit.kind, "game");
  assertEquals(hit.slug, "2028-ai");
  assertEquals(
    hit.levelFile,
    join(ROOT, "static", "games", "2028-ai", "foo.json"),
  );
  // NOT the record's own `name`, which is the literal "foo" — an app called
  // "foo" is the bug this guards.
  assertEquals(hit.levelName, "2028-ai");
});

Deno.test("--name renames the app without moving the record", async () => {
  const hit = await resolveShelfName("2028-ai", {
    ...OFFLINE,
    name: "My Build",
  });
  assertEquals(hit.levelName, "My Build");
  assertStringIncludes(hit.levelFile ?? "", "foo.json");
});

Deno.test("a browser shelf id is refused by name, not by 404", async () => {
  // "<slug>:<palette>" is what the editor files an export under in IndexedDB;
  // it is a real string a user might paste, and no shell can read that store.
  const message = await refusal(() =>
    resolveShelfName("mygame:saturn", OFFLINE)
  );
  assertStringIncludes(message, "browser shelf id");
  assertStringIncludes(message, "--sav");
});

Deno.test("a miss says so, and says where to look", async () => {
  const message = await refusal(() =>
    resolveShelfName("nosuchgamehere", OFFLINE)
  );
  assertStringIncludes(
    message,
    'nothing on the shelf is called "nosuchgamehere"',
  );
  // Offline, the report must not pretend it searched the network.
  assertStringIncludes(message, "--offline");
});

Deno.test("a cart path that is not there names the path", async () => {
  const message = await refusal(() =>
    resolveShelfName("./no-such-cart.sav", OFFLINE)
  );
  assertStringIncludes(message, "no such cart");
});

Deno.test("a buffer that is not a cart is refused with both legal sizes", async () => {
  const message = await refusal(() => cartBytes(new Uint8Array(1234)));
  assertStringIncludes(message, "not a");
  assertStringIncludes(message, "557,056");
  assertStringIncludes(message, "1,114,112");
});

Deno.test("the listing works with nothing but this checkout", async () => {
  const sections = await listShelf(OFFLINE);
  const repo = sections.find((s) => s.section === "THIS REPO");
  assert(repo, "the repo section is always present");
  assert(
    repo.rows.some((r) => r.slug === "2028-ai"),
    "the game this repo ships is listed",
  );
  // The community rung is the one that needs the network; offline it says so
  // rather than being silently absent.
  const community = sections.find((s) => s.section === "COMMUNITY LIBRARY");
  assert(community && community.note, "the community section explains itself");
});

Deno.test(
  "a cart round-trips into the whole game, not just the stage the console runs",
  async () => {
    // Build a cart from the game this repo ships, then read it back the way a
    // shelf build does. `deno task build:ps2` narrows a save to one stage on
    // purpose; a browser build must not, or the app ships with no music
    // (dezaemonBgm), no scenery (backgroundCells), no bullet or item tables and
    // exactly one stage — all of which game.bundle.js reads off the record.
    const out = await Deno.makeTempDir({ prefix: "shelf-cart-" });
    try {
      const built = await buildSav({ out: join(out, "foo.sav") });
      const cart = await Deno.readFile(built.outPath);
      const { record, name } = await levelRecordFromCart(cart, {
        name: "Round Trip",
      });

      assertEquals(name, "Round Trip");
      assertEquals(record.name, "Round Trip");

      // The atlas the runtime merges: a PNG data URL plus its frame table.
      assertStringIncludes(
        String(record.atlasImageDataURL),
        "data:image/png;base64,",
      );
      const frames = record.atlasFrames as Record<string, unknown>;
      assert(Object.keys(frames).length > 0, "the sheet has frames");

      // Every stage the cart holds, not only the one the record opens on.
      const stages = record.stages as Record<string, { enemylist?: unknown }>;
      assert(stages, "the record carries a stages map");
      assert(
        Object.keys(stages).length >= 1,
        "at least the stage the cart was built from",
      );
      for (const [key, stage] of Object.entries(stages)) {
        assert(/^stage\d+$/.test(key), `${key} is a stage key`);
        assert(Array.isArray(stage.enemylist), `${key} carries its grid`);
      }

      // The whole-game tables the runtime reads. Which of these a given cart
      // has depends on what its author drew, so the assertion is that the
      // carry-over happened at all — a record with none of them and a decode
      // that had them is the regression.
      assert(
        Array.isArray(record.enemylist),
        "the opening stage is still flat on the record",
      );
      assert(record.playerData, "the player survives the round trip");
      assert(
        Object.keys(record.enemyData as Record<string, unknown>).length > 0,
        "the enemy table survives the round trip",
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  },
);

Deno.test("an explicit cart path beats every shelf rung", async () => {
  const out = await Deno.makeTempDir({ prefix: "shelf-explicit-" });
  try {
    const built = await buildSav({ out: join(out, "Dez 2 - Explicit.sav") });
    const hit = await resolveShelfName(built.outPath, OFFLINE);
    assertEquals(hit.kind, "sav");
    // The filename supplies the title, prefix stripped, exactly as the shelf
    // itself names a save.
    assertEquals(hit.levelName, "Explicit");
    assert(hit.levelFile, "a cart becomes a level record on disk");
    assertEquals(hit.savFile, built.outPath);
    const record = JSON.parse(await Deno.readTextFile(hit.levelFile!));
    assertEquals(record.name, "Explicit");
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

// ── the cache keys on the cart, not on its title ─────────────────────────────
// Every one of these was a real way to ship the wrong game: two saves can share
// a title, a title can slug to nothing at all, --slot/--stage pick a different
// game out of the same bytes, and --name changes the leaderboard id but not the
// level. A title-keyed cache got all four wrong the same way — silently, by
// finding a file that was already there.

/** Two carts that differ in content but would slug identically. */
async function twoCarts(dir: string, title: string) {
  const a = await buildSav({ out: join(dir, `Dez 2 - ${title}.sav`) });
  const b = await buildSav({
    out: join(dir, "other", `Dez 2 - ${title}.sav`),
    // A different stage grid makes the bytes differ while the title does not.
    gameMode: 1,
  });
  return { a: a.outPath, b: b.outPath };
}

Deno.test("two different carts with the same title do not share a record", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shelf-same-title-" });
  try {
    const { a, b } = await twoCarts(dir, "Twin");
    const root = join(dir, "root");
    const hitA = await resolveShelfName(a, { root, offline: true });
    const hitB = await resolveShelfName(b, { root, offline: true });
    assertEquals(hitA.slug, hitB.slug, "they really do slug the same");
    assert(
      hitA.levelFile !== hitB.levelFile,
      `same cache file for two different carts: ${hitA.levelFile}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a title with no ASCII alphanumerics still gets its own cache entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shelf-unsluggable-" });
  try {
    const { a, b } = await twoCarts(dir, "エアストリーマー");
    const root = join(dir, "root");
    const hitA = await resolveShelfName(a, { root, offline: true });
    const hitB = await resolveShelfName(b, { root, offline: true });
    assertEquals(hitA.slug, "", "the title really does slug to nothing");
    assert(
      hitA.levelFile !== hitB.levelFile,
      "an unsluggable title must not collapse two carts onto one file",
    );
    // And the record must not be written to the cache root itself.
    assert(
      !hitA.levelFile!.endsWith(join("shelf", "level.json")),
      `the cache path collapsed: ${hitA.levelFile}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--name reaches the record, so the leaderboard id follows the app", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shelf-rename-" });
  try {
    const built = await buildSav({ out: join(dir, "Dez 2 - Alpha.sav") });
    const root = join(dir, "root");
    // First build caches a record named "Alpha"…
    const first = await resolveShelfName(built.outPath, {
      root,
      offline: true,
    });
    assertEquals(first.levelName, "Alpha");
    // …and the second must not hand back Alpha's name with Gamma's branding:
    // tools/build-level mints the leaderboard id from record.name.
    const second = await resolveShelfName(built.outPath, {
      root,
      offline: true,
      name: "Gamma",
    });
    assertEquals(second.levelName, "Gamma");
    const record = JSON.parse(await Deno.readTextFile(second.levelFile!));
    assertEquals(record.name, "Gamma");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--slot and --stage get their own cache entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shelf-slot-" });
  try {
    const built = await buildSav({ out: join(dir, "Dez 2 - Multi.sav") });
    const root = join(dir, "root");
    const plain = await resolveShelfName(built.outPath, {
      root,
      offline: true,
    });
    const staged = await resolveShelfName(built.outPath, {
      root,
      offline: true,
      stage: "0",
    });
    // Same stage, spelled explicitly — but the request differs, so a later
    // plain run must not inherit whichever stage an earlier one picked.
    assert(
      plain.levelFile !== staged.levelFile,
      "a --stage run must not overwrite the plain run's cached record",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
