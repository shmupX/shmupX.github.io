// `deno task eshop:publish` end to end, against a database that is a stub:
// the base game (static/games/2028-ai/foo.json, the record the editor would
// save to levels/foo) is built as a cart, shot for its cover, and published
// through the same publishDezaGame the editor calls — and what reaches the
// database is checked the way the shop and the shelf will read it. A dry run
// builds and renders the same and sends nothing.
//
// The cart is built for real (the same build sav_export_test.ts checks the
// bytes of), so this is the slow kind of test; it holds the one thing the
// unit tests in eshop_library_test.ts cannot — that the cart, the cover and
// the listing are the ones the task actually makes.

import {
  assert,
  assertEquals,
  assertMatch,
  assertStrictEquals,
} from "@std/assert";
import { join } from "@std/path";
import { gunzip } from "../packages/shmup-engine/mod.js";
import { publishLevelToEshop } from "../scripts/publish-eshop-sav.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FOO = join(ROOT, "static", "games", "2028-ai", "foo.json");
const DB = "https://db.test";

type Call = { url: string; method: string; body: string | null };

/** A database with one listing in it, answering every write with 204. */
function stubDb(existing: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(existing), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  return { fetchImpl, calls };
}

Deno.test("eshop:publish builds the cart, shoots the cover and writes save, cover, listing — replacing the id", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-eshop-publish-" });
  try {
    const { fetchImpl, calls } = stubDb({
      kind: "deza",
      name: "dezaFoo",
      date: "09.08.26",
      stages: 5,
      palette: "saturn",
      hasCover: true,
    });
    const log: string[] = [];
    const got = await publishLevelToEshop({
      level: FOO,
      name: "dezaFoo",
      attribution: "EASIER BY CODE",
      out: join(dir, "dezaFoo.sav"),
      rtdb: DB,
      fetchImpl,
      log: (m) => log.push(m),
    });

    assertEquals(got.id, "dezafoo");
    assertEquals(got.name, "dezaFoo");
    assertStrictEquals(got.dryRun, false);
    // The cart carries the eShop name as its own.
    assertEquals(got.sav.fileName, "Dez 2 - dezaFoo.sav");
    assertEquals((await Deno.stat(got.sav.outPath)).size, 1114112);
    // foo carries a story, and the cart opens its stages on it.
    assert(
      log.some((m) => /^story: \d+ stages? open on a panel/.test(m)),
      log.filter((m) => m.startsWith("story")).join("\n") || "no story line",
    );
    // The listing that goes is read first and named.
    assertEquals(got.replaced?.name, "dezaFoo");
    assert(
      log.some((m) => m.startsWith('eshop: replacing "dezaFoo" (dezafoo)')),
    );

    // The read, then the editor's three writes in the editor's order.
    assertEquals(calls.map((c) => `${c.method} ${c.url}`), [
      `GET ${DB}/eshop/index/dezafoo.json`,
      `PUT ${DB}/eshop/saves/dezafoo.json?print=silent`,
      `PUT ${DB}/eshop/covers/dezafoo.json?print=silent`,
      `PUT ${DB}/eshop/index/dezafoo.json?print=silent`,
    ]);
    assertEquals(got.writes.map((w) => w.path), [
      "/eshop/saves/dezafoo",
      "/eshop/covers/dezafoo",
      "/eshop/index/dezafoo",
    ]);

    // The save node unwraps to the logical cart, as the shelf expects.
    const saves = JSON.parse(calls[1].body!);
    assertEquals(saves.encoding, "gzip+base64");
    assertEquals(saves.interleaveProfile, "ff-even");
    const gz = Uint8Array.from(atob(saves.sav), (c) => c.charCodeAt(0));
    assertEquals((await gunzip(gz)).length, 557056);

    // The cover is the runtime's portrait viewport, as a PNG data URL.
    const cover = JSON.parse(calls[2].body!);
    assertMatch(cover.png, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    assertEquals([cover.w, cover.h], [256, 480]);
    assertEquals(cover.publishedAt, saves.publishedAt);
    assertEquals(got.cover?.hasTitleArt, true);

    // The listing, as the shop reads it.
    const index = JSON.parse(calls[3].body!);
    assertEquals(index, got.index);
    assertEquals(index.kind, "deza");
    assertEquals(index.name, "dezaFoo");
    assertEquals(index.title, "DEZAFOO");
    assertEquals(index.file, "Dez 2 - dezaFoo.sav");
    assertEquals(index.palette, "saturn");
    assertEquals(index.hasCover, true);
    assertEquals(index.source, "editor");
    assertEquals(index.author, "EASIER BY CODE");
    const stages = (got.sav.report.stages as unknown[]).length;
    assert(stages > 0);
    assertEquals(index.stages, stages);
    assertEquals(
      index.sub,
      `Dezaemon 2 // ${stages} stage${
        stages === 1 ? "" : "s"
      } · saturn palette`,
    );
    assertEquals(index.players, 1);
    assertEquals(index.publishedAt, saves.publishedAt);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("eshop:publish --dry-run builds and renders, reads the listing, and writes nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-eshop-publish-" });
  try {
    const { fetchImpl, calls } = stubDb(null);
    const log: string[] = [];
    const got = await publishLevelToEshop({
      level: FOO,
      name: "dezaFoo",
      id: "my-foo",
      attribution: "EASIER BY CODE",
      out: join(dir, "dezaFoo.sav"),
      rtdb: DB,
      fetchImpl,
      dryRun: true,
      log: (m) => log.push(m),
    });
    assertStrictEquals(got.dryRun, true);
    assertEquals(got.id, "my-foo");
    assertEquals(got.replaced, null);
    assertEquals(calls.map((c) => `${c.method} ${c.url}`), [
      `GET ${DB}/eshop/index/my-foo.json`,
    ]);
    assertEquals(got.writes.map((w) => w.path), [
      "/eshop/saves/my-foo",
      "/eshop/covers/my-foo",
      "/eshop/index/my-foo",
    ]);
    assert(got.writes.every((w) => w.bytes > 0));
    assertEquals(got.index.name, "dezaFoo");
    assert(log.some((m) => m.startsWith("DRY RUN")));
    assert(log.some((m) => m === "eshop: my-foo is a new listing"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
