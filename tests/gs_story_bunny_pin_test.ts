// The gs cloud game's third-stage story carries the glitter bunny pin on its
// second part (scripts/gs/cut_bunny_pin.py cuts it out of the upload,
// scripts/gs/story-bunny-pin.ts puts it on the level as
// storyData/customImages/stage2_part1). gs has two stages, so that entry is
// the one past its last, and the pin makes it an epilogue of gs's own. The
// script runs against a stand-in database here, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { decodeDataUrl } from "@shmupx/shmup-harbor/png";
import { setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  KEY,
  PICTURE,
  pictureDataUrl,
  plan,
  revert,
} from "../scripts/gs/story-bunny-pin.ts";

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
const IMAGES = `${GS}/storyData/customImages`;
/** The hacked-laptops GIF gs's four story parts share. */
const SHARED = "data:image/gif;base64,R0lGODlhtADwAAAA";
/** gs's story as the record holds it: its two stages' words, then the
 * editor's seed, 2028.Ai's own third-stage story, past them. */
const STAGES = {
  stage0: { part: [{ background: "0", text: "But alas that is the glory" }] },
  stage1: {
    part: [
      { background: "1", text: "for you shall always live amongst us as bits" },
      {
        background: "Done",
        text: "and bytes in my little magic information rectangle",
      },
    ],
  },
  stage2: {
    part: [
      {
        background: "2",
        text:
          "The people of Earth, \ncoming together to \nachieve the high score, \nis truly a beautiful thing.",
      },
      {
        background: "Done",
        text:
          "This beauty is something \nthat both you as well as I,\nboth possess!",
      },
    ],
  },
};
const sharing = () => ({
  stage0_part0: SHARED,
  stage0_part1: SHARED,
  stage1_part0: SHARED,
  stage1_part1: SHARED,
});
const seed = (customImages: Tree) => ({
  shmupX: {
    levels: {
      gs: {
        name: "gs",
        stages: { stage0: {}, stage1: {} },
        storyData: { ...STAGES, customImages },
      },
    },
  },
});

Deno.test("the pin is cut onto a clear 180x240, the shape of gs's other story pictures", async () => {
  const png = await Deno.readFile(PICTURE);
  // PNG signature, then IHDR: width, height, bit depth, colour type 6 (RGBA).
  assertEquals([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  assertEquals([view.getUint32(16), view.getUint32(20)], [180, 240]);
  assertEquals([png[24], png[25]], [8, 6]);
  const url = await pictureDataUrl();
  assert(url.startsWith("data:image/png;base64,"));
  assertEquals(decodeBase64(url.slice(url.indexOf(",") + 1)), png);

  const { width, height, data } = await decodeDataUrl(url);
  assertEquals([width, height], [180, 240]);
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  const rowShows = (y: number) => {
    for (let x = 0; x < width; x++) if (alpha(x, y)) return true;
    return false;
  };
  // The black it was photographed on, and the stars around it, are gone:
  // the corners are clear, and so are the four rows above and below it.
  for (const [x, y] of [[0, 0], [179, 0], [0, 239], [179, 239]]) {
    assertEquals(alpha(x, y), 0, `corner ${x},${y}`);
  }
  for (const y of [0, 1, 2, 3, 236, 237, 238, 239]) {
    assert(!rowShows(y), `row ${y}`);
  }
  // The pin fills the rows between, ears to feet, and its face is solid.
  for (let y = 4; y <= 235; y++) assert(rowShows(y), `row ${y}`);
  assertEquals(alpha(90, 120), 255);
});

Deno.test("the pin goes on the third stage's second part, and makes that entry gs's epilogue", async () => {
  assertEquals(KEY, "stage2_part1");
  const js = (await Deno.readTextFile(
    new URL("../static/games/2028-ai/game.bundle.js", import.meta.url),
  )).replaceAll("\r\n", "\n");
  const start = js.indexOf("  function storyLines(entry) {");
  const end = js.indexOf("  // Where a game's own story picture goes", start);
  assert(start > 0 && end > start, "no authoredEpilogue");
  const authoredEpilogue = new Function(
    "ADV_SCENARIO_EN",
    "ADV_SCENARIO_JA",
    js.slice(start, end) + "\nreturn authoredEpilogue;",
  )({ stage2: STAGES.stage2 }, {}) as (
    storyData: unknown,
    stageId: number,
  ) => boolean;
  // The seeded words alone are the base game's: no epilogue, and a two-stage
  // game goes from its second stage straight to its ending.
  assertEquals(
    authoredEpilogue({ ...STAGES, customImages: sharing() }, 2),
    false,
  );
  // With the pin on the entry's second part, AdvScene plays it after stage 2.
  assertEquals(
    authoredEpilogue({
      ...STAGES,
      customImages: { ...sharing(), [KEY]: await pictureDataUrl() },
    }, 2),
    true,
  );
});

Deno.test("--apply writes the picture into the empty slot, once", async () => {
  await withDb(seed(sharing()), async (db) => {
    const p = await plan();
    assertEquals(p.state, "new");
    assertEquals(await apply(p), [`${IMAGES}/${KEY}`]);
    assertEquals(db.read(`${IMAGES}/${KEY}`), await pictureDataUrl());
    // The four earlier parts keep their picture, and the words are untouched.
    assertEquals(db.read(IMAGES), {
      ...sharing(),
      [KEY]: await pictureDataUrl(),
    });
    assertEquals(db.read(`${GS}/storyData/stage2`), STAGES.stage2);
    assert(typeof db.read(`${GS}/savedAt`) === "number");
    // cmg's root-level copy is never written.
    assertEquals(db.read("levels"), null);
    // Again: nothing to do.
    const again = await plan();
    assertEquals(again.state, "already as planned");
    assertEquals(await apply(again), []);
  });
});

Deno.test("another picture stays unless --force, and a racing save is refused", async () => {
  const theirs = "data:image/png;base64,AAAA";
  await withDb(seed({ ...sharing(), [KEY]: theirs }), async (db) => {
    const p = await plan();
    assertEquals(p.state, "differs");
    await assertRejects(() => apply(p), Error, "--force");
    assertEquals(db.read(`${IMAGES}/${KEY}`), theirs);
    await assertRejects(() => revert(), Error, "--force");
    assertEquals(db.read(`${IMAGES}/${KEY}`), theirs);
    // Read, then someone else saves: the ETag no longer matches.
    const stale = await plan();
    await saveElsewhere(db.url, `${IMAGES}/${KEY}`, "data:,changed");
    await assertRejects(() => apply(stale, { force: true }), Error, "ETag");
    assertEquals(await apply(await plan(), { force: true }), [
      `${IMAGES}/${KEY}`,
    ]);
    assertEquals(db.read(`${IMAGES}/${KEY}`), await pictureDataUrl());
  });
});

Deno.test("--revert takes the picture out, and the entry is the seeded story it was", async () => {
  await withDb(seed(sharing()), async (db) => {
    await apply(await plan());
    assertEquals(await revert(), [`${IMAGES}/${KEY}`]);
    assertEquals(db.read(`${IMAGES}/${KEY}`), null);
    assertEquals(db.read(IMAGES), sharing());
    assertEquals(db.read(`${GS}/storyData/stage2`), STAGES.stage2);
    assertEquals(await revert(), []);
    // --force takes out a picture this script did not write, the same way.
    await saveElsewhere(
      db.url,
      `${IMAGES}/${KEY}`,
      "data:image/png;base64,AAAA",
    );
    assertEquals(await revert({ force: true }), [`${IMAGES}/${KEY}`]);
    assertEquals(db.read(`${IMAGES}/${KEY}`), null);
  });
});

async function saveElsewhere(base: string, path: string, value: unknown) {
  const res = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
  await res.body?.cancel();
}
