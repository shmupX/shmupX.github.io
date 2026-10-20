// The gs cloud game is called SQUAD, and GS tells its story
// (scripts/gs/squad-names.ts puts `title` and `storyData/speaker` on the
// level). The script runs against a stand-in database here, never the real
// one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import { apply, plan, revert } from "../scripts/gs/squad-names.ts";

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
    const url = new URL(req.url);
    const path = segments(url.pathname);
    if (req.method === "GET") {
      const node = read(path);
      const headers: Record<string, string> = {};
      if (req.headers.get("x-firebase-etag") === "true") {
        headers.etag = stamp(node);
      }
      // ?shallow=true answers with the child keys only.
      if (url.searchParams.get("shallow") === "true") {
        return Response.json(
          node && typeof node === "object"
            ? Object.fromEntries(Object.keys(node).map((k) => [k, true]))
            : node,
        );
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
const STORY = {
  stage0: { part: [{ background: "0", text: "But alas that is the glory" }] },
  customImages: { stage0_part0: "data:image/gif;base64,AAAA" },
};
const seed = (gs: Tree) => ({ shmupX: { levels: { gs } } });

Deno.test("--apply names the game SQUAD and its speaker GS, once", async () => {
  await withDb(seed({ name: "gs", storyData: STORY }), async (db) => {
    const p = await plan();
    assertEquals(p.map((f) => f.state), ["new", "new"]);
    assertEquals(await apply(p), [`${GS}/title`, `${GS}/storyData/speaker`]);
    assertEquals(db.read(`${GS}/title`), "SQUAD");
    assertEquals(db.read(`${GS}/storyData/speaker`), "GS");
    // The key the editor saves under, and the story itself, are untouched.
    assertEquals(db.read(`${GS}/name`), "gs");
    assertEquals(db.read(`${GS}/storyData/stage0`), STORY.stage0);
    assertEquals(db.read(`${GS}/storyData/customImages`), STORY.customImages);
    assert(typeof db.read(`${GS}/savedAt`) === "number");
    // cmg's root-level copy is never written.
    assertEquals(db.read("levels"), null);
    // Again: nothing to do.
    const again = await plan();
    assertEquals(again.map((f) => f.state), [
      "already as planned",
      "already as planned",
    ]);
    assertEquals(await apply(again), []);
  });
});

Deno.test("another title stays unless --force, and a racing save is refused", async () => {
  await withDb(
    seed({ name: "gs", title: "GEEK SQUAD", storyData: STORY }),
    async (db) => {
      const p = await plan();
      assertEquals(p.map((f) => f.state), ["differs", "new"]);
      await assertRejects(() => apply(p), Error, "--force");
      assertEquals(db.read(`${GS}/title`), "GEEK SQUAD");
      assertEquals(db.read(`${GS}/storyData/speaker`), null);
      // Read, then someone else saves: the ETag no longer matches.
      const stale = await plan();
      await saveElsewhere(db.url, `${GS}/title`, "SQUAD 2");
      await assertRejects(() => apply(stale, { force: true }), Error, "ETag");
      await apply(await plan(), { force: true });
      assertEquals(db.read(`${GS}/title`), "SQUAD");
    },
  );
});

Deno.test("no speaker goes into a story with no stages", async () => {
  await withDb(seed({ name: "gs" }), async (db) => {
    const p = await plan();
    await assertRejects(() => apply(p), Error, "no stages");
    assertEquals(db.read(`${GS}/storyData`), null);
    assertEquals(db.read(`${GS}/title`), null);
  });
});

Deno.test("--revert takes both out, and leaves another's value unless --force", async () => {
  await withDb(seed({ name: "gs", storyData: STORY }), async (db) => {
    await apply(await plan());
    assertEquals(await revert(), [`${GS}/title`, `${GS}/storyData/speaker`]);
    assertEquals(db.read(`${GS}/title`), null);
    assertEquals(db.read(`${GS}/storyData/speaker`), null);
    assertEquals(db.read(`${GS}/storyData/stage0`), STORY.stage0);
    assertEquals(await revert(), []);

    await saveElsewhere(db.url, `${GS}/title`, "GEEK SQUAD");
    await assertRejects(() => revert(), Error, "--force");
    assertEquals(db.read(`${GS}/title`), "GEEK SQUAD");
    assertEquals(await revert({ force: true }), [`${GS}/title`]);
  });
});

async function saveElsewhere(base: string, path: string, value: unknown) {
  const res = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
  await res.body?.cancel();
}
