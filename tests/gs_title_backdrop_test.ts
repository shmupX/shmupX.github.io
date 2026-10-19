// The gs cloud game's title backdrop: the gold plate custom games wear,
// reading 869 instead of 2028 (scripts/gs/draw_869_backdrop.py draws it,
// scripts/gs/title-backdrop.ts puts it on the level as titleBgDataURL). The
// script runs against a stand-in database here, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  BACKDROP,
  backdropDataUrl,
  plan,
  revert,
} from "../scripts/gs/title-backdrop.ts";

type Tree = Record<string, unknown>;

/** A stable stamp for a node's current value; RTDB's ETag plays this part. */
function stamp(node: unknown): string {
  const text = JSON.stringify(node ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Just enough RTDB REST: GET/PUT on <node>.json, with ETags; null deletes. */
function fakeDb(seed: Tree) {
  const root: Tree = structuredClone(seed);
  const segments = (pathname: string) =>
    pathname.slice(0, -".json".length).split("/").filter(Boolean).map(
      decodeURIComponent,
    );
  const read = (path: string[]): unknown =>
    path.reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Tree)[key] : undefined,
      root,
    ) ?? null;
  const write = (path: string[], value: unknown) => {
    let node = root;
    for (const key of path.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== "object") node[key] = {};
      node = node[key] as Tree;
    }
    if (value === null) delete node[path[path.length - 1]];
    else node[path[path.length - 1]] = value;
  };
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const path = segments(new URL(req.url).pathname);
    if (req.method === "GET") {
      const node = read(path);
      const headers: Record<string, string> = {};
      if (req.headers.get("x-firebase-etag") === "true") {
        headers.etag = stamp(node);
      }
      return Response.json(node, { headers });
    }
    if (req.method === "PUT") {
      const expected = req.headers.get("if-match");
      if (expected !== null && expected !== stamp(read(path))) {
        return new Response("precondition failed", { status: 412 });
      }
      write(path, await req.json());
      return Response.json(null);
    }
    return new Response("unsupported", { status: 405 });
  });
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    read: (path: string) => read(path.split("/")),
    close: () => server.shutdown(),
  };
}

async function withDb(
  seed: Tree,
  run: (db: ReturnType<typeof fakeDb>) => Promise<void>,
) {
  const db = fakeDb(seed);
  setDatabaseUrl(db.url);
  try {
    await run(db);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
}

const GS = "shmupX/levels/gs";

Deno.test("the backdrop is a JPEG as tall as the title and three rows of its pattern wide", async () => {
  const jpg = await Deno.readFile(BACKDROP);
  assertEquals([jpg[0], jpg[1]], [0xff, 0xd8]);
  // The first baseline frame header (SOF0) holds height then width.
  let at = 2;
  while (at < jpg.length && jpg[at + 1] !== 0xc0) {
    at += 2 + ((jpg[at + 2] << 8) | jpg[at + 3]);
  }
  const height = (jpg[at + 5] << 8) | jpg[at + 6];
  const width = (jpg[at + 7] << 8) | jpg[at + 8];
  // 480 is GAME_DIMENSIONS.HEIGHT; 845 is where the lattice of 869s,
  // 121.22 px between rows tilted 25.5 degrees, comes round again three
  // rows across (draw_869_backdrop.py), so the sideways wrap has no seam.
  assertEquals([width, height], [845, 480]);
  const url = await backdropDataUrl();
  assert(url.startsWith("data:image/jpeg;base64,"));
  assertEquals(decodeBase64(url.slice(url.indexOf(",") + 1)), jpg);
});

Deno.test("--apply writes the backdrop into an empty field, once", async () => {
  await withDb({ shmupX: { levels: { gs: { name: "gs" } } } }, async (db) => {
    const p = await plan();
    assertEquals(p.state, "new");
    assertEquals(await apply(p), [`${GS}/titleBgDataURL`]);
    assertEquals(db.read(`${GS}/titleBgDataURL`), await backdropDataUrl());
    assert(typeof db.read(`${GS}/savedAt`) === "number");
    // cmg's root-level copy is never written.
    assertEquals(db.read("levels"), null);
    // Again: nothing to do.
    const again = await plan();
    assertEquals(again.state, "already as planned");
    assertEquals(await apply(again), []);
  });
});

Deno.test("another backdrop stays unless --force, and a racing save is refused", async () => {
  const theirs = "data:image/png;base64,AAAA";
  await withDb(
    { shmupX: { levels: { gs: { titleBgDataURL: theirs } } } },
    async (db) => {
      const p = await plan();
      assertEquals(p.state, "differs");
      await assertRejects(() => apply(p), Error, "--force");
      assertEquals(db.read(`${GS}/titleBgDataURL`), theirs);
      await assertRejects(() => revert(), Error, "--force");
      assertEquals(db.read(`${GS}/titleBgDataURL`), theirs);
      // Read, then someone else saves: the ETag no longer matches.
      const stale = await plan();
      await saveElsewhere(db.url, `${GS}/titleBgDataURL`, "data:,changed");
      await assertRejects(() => apply(stale, { force: true }), Error, "ETag");
      assertEquals(await apply(await plan(), { force: true }), [
        `${GS}/titleBgDataURL`,
      ]);
    },
  );
});

Deno.test("--revert takes it out, and the title goes back to the shared plate", async () => {
  await withDb({ shmupX: { levels: { gs: { name: "gs" } } } }, async (db) => {
    await apply(await plan());
    assertEquals(await revert(), [`${GS}/titleBgDataURL`]);
    assertEquals(db.read(`${GS}/titleBgDataURL`), null);
    assertEquals(db.read(`${GS}/name`), "gs");
    assertEquals(await revert(), []);
  });
});

async function saveElsewhere(base: string, path: string, value: unknown) {
  const res = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
  await res.body?.cancel();
}
