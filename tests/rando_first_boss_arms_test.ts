// rando's first boss armed with a beam and a Hadoken, as
// scripts/rando/first-boss-arms.ts writes him.
//
// The script edits shmupX/levels/rando in the shared, open-write database,
// so what it writes has to be right the first time and come back out
// cleanly: only the two weapon slots change and only their art, the six
// frames are in the atlas before the record names them, a slot already armed
// is refused, a record that moved under the plan is refused, and --revert
// leaves the record and the atlas as they were. All of it against a stand-in
// database, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  decodeDataUrl,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import {
  type FrameRect,
  invalidateAtlas,
  sheetDataUrl,
} from "../mcp/lib/art.ts";
import { referencedFrames } from "../mcp/lib/character.ts";
import {
  decodeFrameName,
  encodeKey,
  put,
  setDatabaseUrl,
} from "../mcp/lib/rtdb.ts";
import { PAD } from "../scripts/gs/build-stage2.ts";
import {
  apply,
  armed,
  BEAM,
  BEAM_FACING,
  type Boss,
  disarmed,
  HADOUKEN,
  isArmed,
  LEVEL,
  plan,
  revert,
  SLOT,
  STOCK,
  weaponsOf,
} from "../scripts/rando/first-boss-arms.ts";

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

/** A catalog atlas leaf: the frame map and a raw base64 sheet, as stored. */
async function catalogAtlas(
  w: number,
  h: number,
  frames: Record<string, FrameRect>,
) {
  return {
    json: { frames, meta: { size: { w, h } } },
    png: (await sheetDataUrl(patterned(w, h))).split(",")[1],
  };
}

/** rando's first boss as the level holds him (read 2026-10-22), in small. */
function ryu(): Boss {
  const weapon = (texture: string[]) => ({
    damage: 1,
    hp: 1,
    score: 0,
    speed: 2,
    spgage: 0,
    texture,
  });
  return {
    name: "dezaBoss0",
    hp: 113,
    interval: 100,
    score: 10000,
    anim: { idle: ["dezaBoss0_0.png"], attack: ["dezaBoss0_0.png"] },
    bulletDataA: weapon([...STOCK.bulletDataA]),
    bulletDataC: weapon([...STOCK.bulletDataC]),
    dezaemon: {
      boss: { patterns: [{ firePoints: [], fireTickFrames: 10 }] },
      partArt: { "37": ["dezaBoss0_12.png"] },
      coreArt: true,
    },
  };
}

/** rando, small: Ryu and the frames his record names, on a 300x64 sheet. */
async function withDb(
  run: (db: ReturnType<typeof fakeDb>, sheet: Raster, level: Tree) => Promise<
    void
  >,
) {
  const sheet = patterned(300, 64);
  const atlasFrames: Record<string, FrameRect> = {
    [encodeKey("dezaBoss0_0.png")]: rect(0, 0, 64, 64),
    [encodeKey("dezaBoss0_12.png")]: rect(64, 0, 32, 32),
  };
  [...STOCK.bulletDataA, ...STOCK.bulletDataC].forEach((name, i) => {
    atlasFrames[encodeKey(name)] = rect(96 + i * 16, 0, 16, 16);
  });
  const level: Tree = {
    atlasImageDataURL: await sheetDataUrl(sheet),
    atlasFrames,
    bossData: { [SLOT]: ryu(), boss1: { name: "goki" } },
    enemyData: { enemyA: { name: "imp", texture: ["dezaBoss0_12.png"] } },
    savedAt: 1,
  };
  const db = fakeDb({
    shmupX: { levels: { [LEVEL]: level } },
    // cmg's root-level copy, which must come out as it went in.
    levels: { [LEVEL]: { ...structuredClone(level), savedAt: 0 } },
    // The library's art, in cmg's root catalog, where the two atlases live.
    atlases: {
      hadouken: await catalogAtlas(32, 50, {
        atlas_s0: rect(0, 0, 28, 18),
        hadouken1: rect(0, 18, 32, 32),
      }),
      beam: await catalogAtlas(128, 8, {
        atlas_s0: rect(0, 0, 32, 8),
        atlas_s1: rect(32, 0, 32, 8),
        atlas_s2: rect(64, 0, 32, 8),
        atlas_s3: rect(96, 0, 32, 8),
      }),
    },
  });
  setDatabaseUrl(db.url);
  invalidateAtlas();
  try {
    await run(db, sheet, level);
  } finally {
    setDatabaseUrl(null);
    invalidateAtlas();
    await db.close();
  }
}

Deno.test("only the two weapons' art changes, and it comes back out", () => {
  const before = ryu();
  const after = armed(before);
  assertEquals(after.bulletDataA.texture, HADOUKEN);
  assertEquals(after.bulletDataC.texture, BEAM);
  // The beam is drawn pointing right, and says so; the Hadoken is not turned.
  assertEquals(after.bulletDataC.facing, BEAM_FACING);
  assertEquals(after.bulletDataA.facing, undefined);
  // Each slot keeps its own speed, damage, hp, score and gauge award.
  for (const slot of ["bulletDataA", "bulletDataC"]) {
    const { texture: _t, facing: _f, ...rest } = after[slot];
    const { texture: _was, ...kept } = before[slot];
    assertEquals(rest, kept, slot);
  }
  // Everything else is the record as it was.
  const { bulletDataA: _a, bulletDataC: _c, ...restAfter } = after;
  const { bulletDataA: _b, bulletDataC: _d, ...restBefore } = before;
  assertEquals(restAfter, restBefore);
  assertEquals(ryu(), before, "the input is not edited");

  assert(isArmed(after));
  assert(!isArmed(before));
  assert(!isArmed(null));
  assertEquals(disarmed(after), before);
  assertEquals(weaponsOf(after), {
    bulletDataA: HADOUKEN,
    bulletDataB: null,
    bulletDataC: BEAM,
  });
  // The six frames are the only new art the record names.
  const fresh = referencedFrames(after).filter((n) =>
    !referencedFrames(before).includes(n)
  );
  assertEquals(fresh.sort(), [...HADOUKEN, ...BEAM].sort());
});

Deno.test({
  name:
    "apply lands the art under the sheet, then the record; revert takes both back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db, sheet, level) => {
      const p = await plan();
      assertEquals(p.added.map((a) => a.frame), [...HADOUKEN, ...BEAM]);
      assertEquals(p.reused, []);
      assertEquals(p.alreadyArmed, false);
      assertEquals(p.before, ryu());
      assertEquals(p.record, armed(ryu()));
      assertEquals(p.atlas.before, { w: sheet.width, h: sheet.height });
      assertEquals(p.atlas.after.w, sheet.width);
      assert(p.atlas.after.h > sheet.height + PAD, "packed under the sheet");

      const written = await apply(p);
      assertEquals(written, [
        `shmupX/levels/${LEVEL}/atlasImageDataURL`,
        `shmupX/levels/${LEVEL}/atlasFrames`,
        `shmupX/levels/${LEVEL}/bossData/${SLOT}`,
      ]);
      const slot = db.read(`shmupX/levels/${LEVEL}/bossData/${SLOT}`) as Boss;
      assertEquals(slot, armed(ryu()));
      const frames = db.read(`shmupX/levels/${LEVEL}/atlasFrames`) as Record<
        string,
        FrameRect
      >;
      const names = Object.keys(frames).map(decodeFrameName);
      for (const n of referencedFrames(slot)) assert(names.includes(n), n);
      for (const [key, r] of Object.entries(level.atlasFrames as Tree)) {
        assertEquals(frames[key], r, `${key} stays where it was`);
      }
      for (const n of [...HADOUKEN, ...BEAM]) {
        assert(frames[n].frame.y >= sheet.height + PAD, `${n} is under`);
      }
      const after = await decodeDataUrl(
        db.read(`shmupX/levels/${LEVEL}/atlasImageDataURL`) as string,
      );
      assertEquals(after.width, sheet.width);
      for (let i = 0; i < sheet.data.length; i++) {
        if (after.data[i] !== sheet.data[i]) {
          throw new Error(`the level's own pixel ${i} moved`);
        }
      }
      assert((db.read(`shmupX/levels/${LEVEL}/savedAt`) as number) > 1);
      // cmg's copy is not touched.
      assertEquals(db.read(`levels/${LEVEL}/bossData/${SLOT}`), ryu());
      assertEquals(db.read(`levels/${LEVEL}/atlasFrames`), level.atlasFrames);

      // A second run finds the art there and the slot armed, and refuses
      // to write it again unless forced.
      const again = await plan();
      assertEquals(again.added, []);
      assertEquals(again.reused, [...HADOUKEN, ...BEAM]);
      assertEquals(again.alreadyArmed, true);
      assertEquals(again.atlasImageDataURL, null);
      await assertRejects(() => apply(again), Error, "already fires");
      assertEquals(await apply(again, { force: true }), [
        `shmupX/levels/${LEVEL}/bossData/${SLOT}`,
      ]);

      await revert();
      assertEquals(
        db.read(`shmupX/levels/${LEVEL}/bossData/${SLOT}`),
        ryu(),
        "the stock bullets are back, facing gone",
      );
      assertEquals(
        db.read(`shmupX/levels/${LEVEL}/atlasFrames`),
        level.atlasFrames,
      );
      const back = await decodeDataUrl(
        db.read(`shmupX/levels/${LEVEL}/atlasImageDataURL`) as string,
      );
      assertEquals([back.width, back.height], [sheet.width, sheet.height]);
      assertEquals(back.data, sheet.data);
      // Reverting what is not there is a no-op.
      assertEquals(await revert(), []);
    });
  },
});

Deno.test({
  name: "a record that moved under the plan is refused, not overwritten",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db) => {
      const p = await plan();
      const edited = { ...ryu(), hp: 999 };
      await put(`levels/${LEVEL}/bossData/${SLOT}`, edited);
      await assertRejects(() => apply(p), Error, "changed since");
      assertEquals(db.read(`shmupX/levels/${LEVEL}/bossData/${SLOT}`), edited);
      // The art went in first and stays: harmless, and the next plan reuses it.
      const next = await plan();
      assertEquals(next.added, []);
      assertEquals(next.record.hp, 999);
    });
  },
});

Deno.test({
  name: "a slot that is not a Dezaemon boss is refused",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async () => {
      await put(`levels/${LEVEL}/bossData/${SLOT}`, {
        name: "goki",
        bulletDataA: { texture: ["Akuma_2019_15.png"] },
      });
      await assertRejects(() => plan(), Error, "not a Dezaemon boss");
    });
  },
});
