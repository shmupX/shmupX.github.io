// The gs cloud game's stage 2, as scripts/gs/build-stage2.ts writes it.
//
// The script edits levels/gs in the shared, open-write database, so what it
// writes has to be right the first time and has to come back out cleanly:
// the art lands before the records that name it, every frame the records
// draw is in the level's atlas afterwards, the level's own frames keep their
// pixels and rects, and --revert leaves the atlas and the records exactly as
// they were. All of it against a stand-in database, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  decodeDataUrl,
  decodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { cut } from "@shmupx/shmup-harbor/raster";
import { type FrameRect, packFrames, sheetDataUrl } from "../mcp/lib/art.ts";
import { decodeFrameName, setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  DALTONIUS,
  DRAGON_HEADS,
  namedFrames,
  packedNames,
  plan,
  revert,
  STAGE2,
} from "../scripts/gs/build-stage2.ts";

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
  const writes: string[] = [];
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
    const url = new URL(req.url);
    const path = segments(url.pathname);
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
      writes.push(path.join("/"));
      return Response.json(null);
    }
    return new Response("unsupported", { status: 405 });
  });
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    read: (path: string) => read(path.split("/")),
    writes,
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

/** The gs level's shape, small: its laptops, its stage-1 boss and waves. */
async function seed(extra: Tree = {}) {
  const sheet = patterned(2031, 113);
  const frames = {
    geekstar0: rect(4, 4, 170, 105),
    laptop0: rect(1140, 4, 74, 58),
    laptop1: rect(1218, 4, 74, 58),
  };
  const level = {
    atlasImageDataURL: await sheetDataUrl(sheet),
    atlasFrames: frames,
    bossData: { boss0: { name: "geekstar", anim: { idle: ["geekstar0"] } } },
    enemyData: { enemyC: { name: "laptop", texture: ["laptop0", "laptop1"] } },
    stages: { stage0: { enemylist: [["C0", "00"]] } },
    savedAt: 1,
    ...extra,
  };
  const ram = await sheetDataUrl(patterned(32, 18));
  // The Character Library's deza_dragon atlas, where the dragon's heads live.
  const heads = packFrames(DRAGON_HEADS.frames.map((name) => ({
    name,
    raster: patterned(32, 64),
    source: name,
    scope: "seed",
  })));
  const dragonAtlas = {
    json: JSON.stringify(heads.json),
    png: await sheetDataUrl(heads.sheet),
  };
  return { sheet, frames, level, ram, dragonAtlas };
}

async function withDb(
  extra: Tree,
  run: (
    db: ReturnType<typeof fakeDb>,
    s: Awaited<ReturnType<typeof seed>>,
  ) => Promise<void>,
) {
  const s = await seed(extra);
  const db = fakeDb({
    levels: { gs: s.level },
    sprites: { RAM_0: s.ram },
    atlases: { [DRAGON_HEADS.atlas]: s.dragonAtlas },
  });
  setDatabaseUrl(db.url);
  try {
    await run(db, s);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
}

const sameRaster = (a: Raster, b: Raster, what: string) => {
  assertEquals([a.width, a.height], [b.width, b.height], `${what} size`);
  assert(
    a.data.every((v, i) => v === b.data[i]),
    `${what} pixels differ`,
  );
};

Deno.test({
  name: "stage 2 lands art first, names only art the level has, and reverts",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb({}, async (db, s) => {
      const p = await plan();
      assertEquals(p.added.map((a) => a.frame).sort(), packedNames().sort());
      assertEquals(p.taken, []);
      // Packed under the old sheet, to its width, and no taller than the art.
      const packed = Object.entries(p.atlasFrames)
        .filter(([key]) => packedNames().includes(decodeFrameName(key)))
        .map(([, r]) => r.frame);
      assertEquals(packed.length, packedNames().length);
      for (const r of packed) {
        assert(r.y >= 113 + 4 && r.x + r.w <= 2031, JSON.stringify(r));
      }
      assertEquals(p.atlas.after.w, 2031);
      assertEquals(p.atlas.after.h, Math.max(...packed.map((r) => r.y + r.h)));

      await apply(p);
      // The art before anything that names it.
      const order = db.writes.map((w) => w.replace("levels/gs/", ""));
      assertEquals(order.slice(0, 2), ["atlasImageDataURL", "atlasFrames"]);
      assertEquals(order.slice(2, 5), [
        "enemyData/enemyG",
        "bossData/boss1",
        "stages/stage1",
      ]);

      const stored = db.read("levels/gs/atlasFrames") as Record<
        string,
        FrameRect
      >;
      const frames: Record<string, FrameRect> = {};
      for (const [k, r] of Object.entries(stored)) {
        frames[decodeFrameName(k)] = r;
      }
      // Every frame the records draw, the dragon stage's included.
      for (const name of namedFrames()) assert(frames[name], `no ${name}`);
      for (const name of DRAGON_HEADS.frames) assert(frames[name], name);
      const after = await decodeDataUrl(
        db.read("levels/gs/atlasImageDataURL") as string,
      );
      // The level's own frames: same rects, same pixels.
      for (const [name, r] of Object.entries(s.frames)) {
        assertEquals(frames[name], r);
        sameRaster(cut(after, r.frame), cut(s.sheet, r.frame), name);
      }
      // A packed frame is the drawn art, pixel for pixel.
      const fired = await decodePng(
        await Deno.readFile(
          new URL("../scripts/gs/art/Daltonius_fired0.png", import.meta.url),
        ),
      );
      sameRaster(
        cut(after, frames.Daltonius_fired0.frame),
        fired,
        "Daltonius_fired0",
      );
      const dragon = await decodePng(
        await Deno.readFile(
          new URL("../scripts/gs/art/liuKangDragon9.png", import.meta.url),
        ),
      );
      sameRaster(
        cut(after, frames.liuKangDragon9.frame),
        dragon,
        "liuKangDragon9",
      );
      assertEquals(db.read("levels/gs/bossData/boss1"), DALTONIUS);
      assertEquals(db.read("levels/gs/stages/stage1"), { enemylist: STAGE2 });
      assertEquals(db.read("levels/gs/bossData/boss0"), s.level.bossData.boss0);

      // A second run finds everything there and adds nothing.
      const again = await plan();
      assertEquals(again.added, []);
      assertEquals(again.atlasImageDataURL, null);
      assertEquals(again.taken.sort(), [
        "bossData/boss1",
        "enemyData/enemyG",
        "stages/stage1",
      ]);
      await assertRejects(() => apply(again), Error, "--force");

      await revert();
      for (
        const path of ["stages/stage1", "bossData/boss1", "enemyData/enemyG"]
      ) {
        assertEquals(db.read(`levels/gs/${path}`), null, path);
      }
      assertEquals(db.read("levels/gs/atlasFrames"), s.frames);
      sameRaster(
        await decodeDataUrl(db.read("levels/gs/atlasImageDataURL") as string),
        s.sheet,
        "reverted sheet",
      );
    });
  },
});

Deno.test({
  name: "stage 2 will not replace a boss already in the slot without --force",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const theirs = { name: "someoneElse" };
    await withDb({ bossData: { boss1: theirs } }, async (db) => {
      const p = await plan();
      assertEquals(p.taken, ["bossData/boss1"]);
      await assertRejects(() => apply(p), Error, "bossData/boss1");
      assertEquals(db.writes, []);
      assertEquals(db.read("levels/gs/bossData/boss1"), theirs);
    });
  },
});
