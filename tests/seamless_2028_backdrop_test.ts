// rando's gold 2028, redrawn to tile, wherever a record carried rando's
// upload as its own scrolling title backdrop: 2028.Ai's foo.json here, and
// the rando and foo records in the database (scripts/2028-ai/title-backdrop.ts).
// The upload was 768 wide, which is not a period of its pattern, so the
// title's endless sideways scroll showed a seam at every wrap. The script
// runs against a stand-in database here, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  LEVELS,
  plan,
  pngDataUrl,
  revert,
  TILE,
  UPLOAD,
} from "../scripts/2028-ai/title-backdrop.ts";

type Tree = Record<string, unknown>;

/** A PNG's width and height, from its IHDR. */
function pngSize(bytes: Uint8Array): [number, number] {
  assertEquals(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

async function sha1(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

Deno.test("2028.Ai's own record scrolls the seamless tile, as a PNG", async () => {
  const foo = JSON.parse(
    await Deno.readTextFile(
      new URL("../static/games/2028-ai/foo.json", import.meta.url),
    ),
  );
  // A plain visit bakes foo.json and puts this up as title_bg. A PNG, since
  // the PS2, Saturn and SFC exporters decode only PNG and GIF title art.
  assertEquals(foo.titleBgDataURL, await pngDataUrl(TILE));
  const tile = decodeBase64(
    foo.titleBgDataURL.slice(foo.titleBgDataURL.indexOf(",") + 1),
  );
  // 845 is where the lattice comes round three rows across, as the shared
  // plate's JPEG (titleBgCustom.jpg, the same picture); 480 is the title's
  // height.
  assertEquals(pngSize(tile), [845, 480]);
});

Deno.test("rando's upload is kept byte for byte, for --revert", async () => {
  const upload = await Deno.readFile(UPLOAD);
  assertEquals(pngSize(upload), [768, 1376]);
  assertEquals(
    await sha1(upload),
    "69fd3ff191fa0d6974a30a61f6a6fae3909e8144",
  );
});

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

async function saveElsewhere(base: string, path: string, value: unknown) {
  const res = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
  await res.body?.cancel();
}

/** shmupX/levels as the live database had it: both records on the upload. */
async function seeded(): Promise<Tree> {
  const upload = await pngDataUrl(UPLOAD);
  return {
    shmupX: {
      levels: Object.fromEntries(
        LEVELS.map((level) => [level, { name: level, titleBgDataURL: upload }]),
      ),
    },
  };
}

Deno.test("the script works on rando and 2028.Ai's foo, nothing else", () => {
  assertEquals([...LEVELS], ["rando", "foo"]);
});

Deno.test("the dry run writes nothing; --apply puts the tile over the upload, once", async () => {
  await withDb(await seeded(), async (db) => {
    const tile = await pngDataUrl(TILE);
    const upload = await pngDataUrl(UPLOAD);
    for (const level of LEVELS) {
      const p = await plan(level);
      assertEquals(p.state, "rando's upload");
      assertEquals(p.currentLength, upload.length);
      assertEquals(db.read(`shmupX/levels/${level}/titleBgDataURL`), upload);
      assertEquals(await apply(p), [`shmupX/levels/${level}/titleBgDataURL`]);
      assertEquals(db.read(`shmupX/levels/${level}/titleBgDataURL`), tile);
      assert(typeof db.read(`shmupX/levels/${level}/savedAt`) === "number");
      assertEquals(db.read(`shmupX/levels/${level}/name`), level);
      // Again: nothing to do.
      const again = await plan(level);
      assertEquals(again.state, "already as planned");
      assertEquals(await apply(again), []);
    }
    // cmg's root-level copy is never written.
    assertEquals(db.read("levels"), null);
  });
});

Deno.test("another backdrop or an empty field stays unless --force, and a racing save is refused", async () => {
  const theirs = "data:image/png;base64,AAAA";
  await withDb(
    { shmupX: { levels: { rando: { titleBgDataURL: theirs }, foo: {} } } },
    async (db) => {
      const rando = await plan("rando");
      assertEquals(rando.state, "differs");
      await assertRejects(() => apply(rando), Error, "--force");
      assertEquals(db.read("shmupX/levels/rando/titleBgDataURL"), theirs);
      const foo = await plan("foo");
      assertEquals(foo.state, "empty");
      await assertRejects(() => apply(foo), Error, "--force");
      assertEquals(db.read("shmupX/levels/foo/titleBgDataURL"), null);
      await assertRejects(() => revert("rando"), Error, "--force");
      assertEquals(db.read("shmupX/levels/rando/titleBgDataURL"), theirs);
      // Read, then someone else saves: the ETag no longer matches.
      const stale = await plan("rando");
      await saveElsewhere(
        db.url,
        "shmupX/levels/rando/titleBgDataURL",
        "data:,changed",
      );
      await assertRejects(() => apply(stale, { force: true }), Error, "ETag");
      assertEquals(await apply(await plan("rando"), { force: true }), [
        "shmupX/levels/rando/titleBgDataURL",
      ]);
    },
  );
});

Deno.test("--revert puts rando's upload back where the tile went", async () => {
  await withDb(await seeded(), async (db) => {
    for (const level of LEVELS) await apply(await plan(level));
    for (const level of LEVELS) {
      assertEquals(await revert(level), [
        `shmupX/levels/${level}/titleBgDataURL`,
      ]);
      assertEquals(
        db.read(`shmupX/levels/${level}/titleBgDataURL`),
        await pngDataUrl(UPLOAD),
      );
      assertEquals(await revert(level), []);
    }
  });
});
