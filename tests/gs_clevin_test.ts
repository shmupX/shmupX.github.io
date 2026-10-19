// Clevin in the gs cloud game's second stage, as scripts/gs/add-clevin.ts
// writes him.
//
// The script edits shmupX/levels/gs in the shared, open-write database, so
// what it writes has to be right the first time and come back out cleanly:
// Clevin attacks as deza2_02 does, his cells only ever land on empty ones,
// his art is in the atlas before anything names it, and --revert leaves the
// atlas, the record slot and the wave list as they were. All of it against a
// stand-in database, never the real one.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  decodeDataUrl,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { type FrameRect, sheetDataUrl } from "../mcp/lib/art.ts";
import { referencedFrames } from "../mcp/lib/character.ts";
import { decodeFrameName, setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import { STAGE2 } from "../scripts/gs/build-stage2.ts";
import {
  apply,
  BODY,
  CLEVIN,
  LETTER,
  plan,
  revert,
  SHOT,
  WAVES,
  withClevin,
  withoutClevin,
} from "../scripts/gs/add-clevin.ts";

type Tree = Record<string, unknown>;

/** A stable stamp for a node's current value; RTDB's ETag plays this part. */
function stamp(node: unknown): string {
  const text = JSON.stringify(node ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Just enough RTDB REST: GET/PUT on <node>.json, with ETags. */
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
    node[path[path.length - 1]] = value;
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

/** A sheet whose every pixel says where it is, so a moved pixel shows. */
function patterned(w: number, h: number): Raster {
  const out = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data.set([x & 255, y & 255, (x * y) & 255, 255], (y * w + x) * 4);
    }
  }
  return out;
}

const rect = (x: number, y: number, w: number, h: number): FrameRect => ({
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w, h },
  sourceSize: { w, h },
});

/** gs, small: a laptop, the flirty girl, stage 2's waves as built. */
async function withDb(
  run: (db: ReturnType<typeof fakeDb>, sheet: Raster, level: Tree) => Promise<
    void
  >,
) {
  const sheet = patterned(300, 64);
  const level: Tree = {
    atlasImageDataURL: await sheetDataUrl(sheet),
    atlasFrames: { laptop0: rect(0, 0, 74, 58) },
    enemyData: {
      enemyC: { name: "laptop", texture: ["laptop0"] },
      enemyG: { name: "flirtyGirl", texture: ["laptop0"] },
    },
    stages: { stage1: { enemylist: STAGE2 } },
    savedAt: 1,
  };
  const db = fakeDb({
    shmupX: { levels: { gs: level } },
    // cmg's root-level copy, which must come out as it went in.
    levels: { gs: { ...structuredClone(level), savedAt: 0 } },
    // spriteX's whole-image art lives at the root.
    sprites: { [SHOT]: await sheetDataUrl(patterned(22, 32)) },
  });
  setDatabaseUrl(db.url);
  try {
    await run(db, sheet, level);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
}

Deno.test("Clevin attacks as deza2_02 does, with his face and the badge", () => {
  // The imp's movement script and fire table, kept whole.
  assertEquals(CLEVIN.dezaemon.behavior.fire, {
    aimed: true,
    direction: 17,
    directionEx: 0,
    enabled: true,
    geometry: 1,
    interval: 5,
    mode: 1,
    window: 4,
  });
  assertEquals(CLEVIN.dezaemon.entry.rows.length, 11);
  assertEquals(CLEVIN.dezaemon.attributes.length, 36, "eighteen cart bytes");
  assertEquals(CLEVIN.dezaemon.placementId, 130);
  // Where the imp sat in rando does not travel with him.
  for (const key of ["stage", "record", "placements"]) {
    assert(!(key in CLEVIN.dezaemon), key);
  }
  // Sixteen times the imp's 3 hp, and the badge in the slot the runtime reads.
  assertEquals(CLEVIN.hp, 48);
  assertEquals(CLEVIN.bulletData.texture, [SHOT]);
  assertEquals(referencedFrames(CLEVIN).sort(), [SHOT, BODY].sort());
});

Deno.test("his cells land only on empty cells, and come back out", () => {
  const laid = withClevin(STAGE2);
  const cells = laid.flat().filter((c) => c[0] === LETTER);
  assertEquals(cells.length, 6);
  for (const at of Object.keys(WAVES)) {
    assert(STAGE2[Number(at)].every((c) => c === "00"), `row ${at} was empty`);
  }
  assertEquals(withoutClevin(laid), STAGE2);
  assertEquals(STAGE2.flat().filter((c) => c[0] === LETTER), [], "untouched");
  // A second run, or another enemy in his place, is refused.
  assertThrows(() => withClevin(laid), Error, "taken");
  const crowded = STAGE2.map((r) => r.slice());
  crowded[9][1] = "C0";
  assertThrows(() => withClevin(crowded), Error, "row 9 column 1 (C0)");
  assertThrows(() => withClevin(STAGE2.slice(0, 5)), Error, "no row");
});

Deno.test({
  name: "apply lands the art, the record and the cells; revert takes them out",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db, sheet, level) => {
      const p = await plan();
      assertEquals(p.added.map((a) => a.frame), [BODY, SHOT]);
      assertEquals(p.taken, false);
      await apply(p);

      const frames = db.read("shmupX/levels/gs/atlasFrames") as Record<
        string,
        FrameRect
      >;
      const names = Object.keys(frames).map(decodeFrameName);
      for (const n of [BODY, SHOT, "laptop0"]) assert(names.includes(n), n);
      assertEquals(frames.laptop0, (level.atlasFrames as Tree).laptop0);
      const after = await decodeDataUrl(
        db.read("shmupX/levels/gs/atlasImageDataURL") as string,
      );
      assertEquals(after.width, sheet.width);
      assert(after.height > sheet.height, "packed under the sheet");
      for (let i = 0; i < sheet.data.length; i++) {
        if (after.data[i] !== sheet.data[i]) {
          throw new Error(`the level's own pixel ${i} moved`);
        }
      }
      assertEquals(
        db.read(`shmupX/levels/gs/enemyData/enemy${LETTER}`),
        CLEVIN,
      );
      assertEquals(
        db.read("shmupX/levels/gs/stages/stage1/enemylist"),
        withClevin(STAGE2),
      );
      // Twice is refused: his cells are taken.
      await assertRejects(() => plan(), Error, "taken");

      await revert();
      assertEquals(db.read(`shmupX/levels/gs/enemyData/enemy${LETTER}`), null);
      assertEquals(db.read("shmupX/levels/gs/stages/stage1/enemylist"), STAGE2);
      assertEquals(db.read("shmupX/levels/gs/atlasFrames"), level.atlasFrames);
      const back = await decodeDataUrl(
        db.read("shmupX/levels/gs/atlasImageDataURL") as string,
      );
      assertEquals([back.width, back.height], [sheet.width, sheet.height]);
      // cmg's copy was never touched.
      assertEquals(db.read("levels/gs/savedAt"), 0);
      assertEquals(db.read("levels/gs/enemyData/enemyH"), null);
    });
  },
});

Deno.test({
  name: "a frame another record still draws survives revert",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db) => {
      await apply(await plan());
      // Someone gives the laptop the badge too, after Clevin landed.
      const laptop = db.read("shmupX/levels/gs/enemyData/enemyC") as Tree;
      await fetch(`${db.url}/shmupX/levels/gs/enemyData/enemyC.json`, {
        method: "PUT",
        body: JSON.stringify({ ...laptop, bulletData: { texture: [SHOT] } }),
      }).then((r) => r.body?.cancel());
      await revert();
      const names = Object.keys(
        db.read("shmupX/levels/gs/atlasFrames") as Tree,
      ).map(decodeFrameName);
      assert(names.includes(SHOT), "the badge stays: the laptop draws it");
      assert(!names.includes(BODY), "Clevin's face goes");
    });
  },
});
