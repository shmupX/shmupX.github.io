// The object tools' write path, end to end, against a stand-in database.
//
// The real catalog is shared and open-write, so nothing here touches it:
// the rtdb module is pointed at a Deno.serve that speaks just enough of the
// RTDB REST protocol — GET/PUT on <node>.json, ?shallow=true, ETags and
// if-match — and is seeded with synthetic characters whose atlases are a
// handful of 4x4 pixels. That is enough to prove what the unit tests cannot:
// that an applied edit lands as the record and the atlas the runtime and the
// editor will read, that every frame an atlas held survives an in-place
// rewrite under the key it had, that a numbers-only edit leaves the atlas
// alone, that a shared atlas is never rewritten, that a second edit
// compounds on the first, that a raced write is refused, and that a dry run
// writes nothing at all.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  decodeDataUrl,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { cut } from "@shmupx/shmup-harbor/raster";
import {
  frameMap,
  invalidateAtlas,
  packFrames,
  sheetDataUrl,
} from "../mcp/lib/art.ts";
import {
  databaseUrl,
  encodeFrameKey,
  encodeKey,
  getWithEtag,
  put,
  setDatabaseUrl,
} from "../mcp/lib/rtdb.ts";
import {
  describeObject,
  listObjects,
  renderObject,
  updateObject,
} from "../mcp/lib/objects.ts";

/** ─── a stand-in RTDB ──────────────────────────────────────────────────── */

type Tree = Record<string, unknown>;

/** A stable stamp for a node's current value; RTDB's ETag plays this part. */
function stamp(node: unknown): string {
  const text = JSON.stringify(node ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

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
    if (!url.pathname.endsWith(".json")) {
      return new Response("expected <node>.json", { status: 400 });
    }
    const path = segments(url.pathname);
    if (req.method === "GET") {
      let node = read(path);
      const headers: Record<string, string> = {};
      if (req.headers.get("x-firebase-etag") === "true") {
        headers.etag = stamp(node);
      }
      if (
        url.searchParams.get("shallow") === "true" && node &&
        typeof node === "object"
      ) {
        node = Object.fromEntries(Object.keys(node).map((k) => [k, true]));
      }
      return Response.json(node, { headers });
    }
    if (req.method === "PUT") {
      const expected = req.headers.get("if-match");
      if (expected !== null && expected !== stamp(read(path))) {
        return new Response("precondition failed", { status: 412 });
      }
      const body = await req.json();
      write(path, body);
      writes.push(path.join("/"));
      return Response.json(body);
    }
    return new Response("unsupported", { status: 405 });
  });
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    read: (path: string) => read(path.split("/")),
    /** Change a node behind the tools' back, as spriteX or the editor would. */
    poke: (path: string, value: unknown) => write(path.split("/"), value),
    writes,
    close: () => server.shutdown(),
  };
}

/** ─── fixtures ─────────────────────────────────────────────────────────── */

function solid(w: number, h: number, rgb: [number, number, number]): Raster {
  const out = newRaster(w, h);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data.set([...rgb, 255], i);
  }
  return out;
}

/**
 * An atlas record the way the catalog holds them: json as a string with
 * plain frame names, unless `keys` respells some the way another writer did.
 */
async function atlasRecord(
  frames: Record<string, Raster>,
  { keys = {}, asObject = false }: {
    keys?: Record<string, string>;
    asObject?: boolean;
  } = {},
) {
  const { sheet, json } = packFrames(
    Object.entries(frames).map(([name, raster]) => ({
      name,
      raster,
      source: name,
      scope: "seed",
    })),
  );
  const respelled: Record<string, unknown> = {};
  for (const [name, rect] of Object.entries(json.frames)) {
    respelled[keys[name] ?? name] = rect;
  }
  const body = { ...json, frames: respelled };
  return {
    json: asObject ? body : JSON.stringify(body),
    png: await sheetDataUrl(sheet),
  };
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];
const GREY: [number, number, number] = [128, 128, 128];

const rect = (x: number, y: number, w: number, h: number) => ({
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w, h },
  sourceSize: { w, h },
});

async function seed(): Promise<Tree> {
  return {
    characters: {
      redBoss1: {
        name: "redBoss1",
        textureKey: "redBoss1",
        anim: { idle: ["boss_0.png", "boss_1.png"] },
        bulletDataA: { speed: 2, damage: 1, texture: ["shot_0.png"] },
        hp: 100,
        interval: 100,
        score: 1000,
      },
      hero: {
        name: "hero",
        textureKey: "shared_atlas",
        maxHp: 3,
        texture: ["hero_0.png"],
      },
      broken: {
        name: "broken",
        textureKey: "broken",
        texture: ["ghost.png"],
        hp: 5,
        interval: 50,
      },
      noAtlas: {
        name: "noAtlas",
        textureKey: "ghostAtlas",
        texture: ["x.png"],
        hp: 5,
        interval: 50,
      },
      // spriteX wrote this atlas as an object tree, so its frame keys are
      // k_-hex; and one frame carries the one-dot-leader this server once
      // wrote. The record spells both plainly, as records do.
      spritexGuy: {
        name: "spritexGuy",
        textureKey: "spritexGuy",
        texture: ["atlas_s0", "old.gif"],
        hp: 20,
        interval: -1,
      },
      // A bullet saved under a boss-family name is not a boss, and carries
      // no stage.
      dezaBoss1_shot: {
        name: "dezaBoss1_shot",
        textureKey: "dezaBoss1_shot",
        speed: 2,
        texture: ["shot_0.png"],
      },
    },
    atlases: {
      redBoss1: await atlasRecord({
        "boss_0.png": solid(4, 4, RED),
        "boss_1.png": solid(4, 4, RED),
        "shot_0.png": solid(2, 2, BLUE),
        // Nothing names this frame; an in-place rewrite must keep it anyway.
        "spare.png": solid(3, 3, GREEN),
      }),
      shared_atlas: await atlasRecord({
        "hero_0.png": solid(4, 4, GREY),
        "other.png": solid(2, 2, GREEN),
      }),
      broken: await atlasRecord({ "present.png": solid(1, 1, RED) }),
      spritexGuy: await atlasRecord({
        "atlas_s0": solid(2, 2, RED),
        "old.gif": solid(2, 2, RED),
      }, {
        keys: {
          "atlas_s0": encodeFrameKey("atlas_s0"),
          "old.gif": encodeKey("old.gif"),
        },
        asObject: true,
      }),
      dezaBoss1_shot: await atlasRecord({ "shot_0.png": solid(2, 2, BLUE) }),
    },
    levels: {
      "Daioh P!": {
        bossData: {
          boss0: {
            name: "redBoss1",
            anim: { idle: ["boss_0.png"] },
            hp: 215,
          },
          boss1: { name: "bison", texture: ["bison_idle0.gif"], hp: 150 },
          bossExtra: { name: "goki", hp: 350 },
        },
        // Level frame maps are real database keys, so they are dot-encoded.
        atlasFrames: { [encodeKey("boss_0.png")]: rect(0, 0, 4, 4) },
      },
    },
  };
}

/** The pixel at the top-left of `frame` in a stored atlas record. */
async function pixelOf(
  atlas: { json: string | Tree; png: string },
  frame: string,
): Promise<number[]> {
  const parsed = typeof atlas.json === "string"
    ? JSON.parse(atlas.json)
    : atlas.json;
  const rects = frameMap(parsed);
  const r = rects[frame];
  assert(r, `atlas has no frame ${frame}; has ${Object.keys(rects)}`);
  const sheet = await decodeDataUrl(atlas.png);
  const cell = cut(sheet, r.frame);
  return [...cell.data.slice(0, 4)];
}

/** The raw keys an atlas record's json carries, as another reader sees them. */
function rawKeys(atlas: { json: string | Tree }): string[] {
  const parsed = typeof atlas.json === "string"
    ? JSON.parse(atlas.json)
    : atlas.json;
  return Object.keys(parsed.frames).sort();
}

const png = async (b64: string) =>
  await decodeDataUrl(`data:image/png;base64,${b64}`);

/** ─── the tests ────────────────────────────────────────────────────────── */

Deno.test("the object tools against a stand-in database", async (t) => {
  const db = fakeDb(await seed());
  setDatabaseUrl(db.url);
  invalidateAtlas();
  try {
    await t.step(
      "list reads roles, stages, ordinals and sizes off the seed",
      async () => {
        const list = await listObjects();
        assertEquals(list.scope, "catalog");
        assertEquals(list.database, db.url);
        assertEquals(
          list.objects.map((o) => [o.id, o.role, o.stage, o.ordinal]),
          [
            // The one numbered boss is stage 1: the second boss, and no first.
            ["redBoss1", "boss", 1, 2],
            ["broken", "enemy", null, 1],
            ["noAtlas", "enemy", null, 2],
            ["spritexGuy", "enemy", null, 3],
            ["hero", "player", null, 1],
            // A boss-family name on a bullet carries no stage.
            ["dezaBoss1_shot", "projectile", null, 1],
          ],
        );
        assertEquals(list.objects[0].size, { w: 4, h: 4 });
        assertEquals(list.objects[0].states, ["idle"]);
        assertEquals(list.objects[0].projectiles, ["bulletDataA"]);
        // A frame the atlas lacks, or an atlas that is not there, has no size.
        assertEquals(list.objects[1].size, null);
        assertEquals(list.objects[2].size, null);
        // k_-hex and leader spellings are read as the names the record uses.
        assertEquals(list.objects[3].size, { w: 2, h: 2 });

        const second = await listObjects({ query: "the second boss" });
        assertEquals(second.resolved?.id, "redBoss1");
        const first = await listObjects({ query: "the first boss" });
        assertEquals(first.resolved, null);
        const spoken = await listObjects({ query: "red boss 1" });
        assertEquals(spoken.resolved?.id, "redBoss1");
        assertEquals(db.writes, []);
      },
    );

    await t.step(
      "a level lists its slots by exact key, mapped to the catalog",
      async () => {
        const lvl = await listObjects({
          level: "Daioh P!",
          query: "the second boss",
        });
        assertEquals(lvl.scope, "level");
        assertEquals(
          lvl.objects.map((o) => [o.id, o.ordinal, o.character, o.inCatalog]),
          [
            ["boss0", 1, "redBoss1", true],
            ["boss1", 2, "bison", false],
            ["bossExtra", 3, "goki", false],
          ],
        );
        // Sized from the level's own dot-encoded frame map.
        assertEquals(lvl.objects[0].size, { w: 4, h: 4 });
        assertEquals(lvl.objects[1].size, null);
        assertEquals(lvl.resolved?.id, "boss1");
        const last = await listObjects({
          level: "Daioh P!",
          query: "the last boss",
        });
        assertEquals(last.resolved?.id, "boss1");
        // The key is exact, and a miss names what is there.
        await assertRejects(
          () => listObjects({ level: "Daioh" }),
          Error,
          "Daioh P!",
        );
      },
    );

    await t.step(
      "get reports the dials' starting points and what the runtime reads",
      async () => {
        const d = await describeObject("redBoss1");
        assertEquals(d.role, "boss");
        assertEquals([d.ordinal, d.ordinalWord], [2, "second"]);
        assertEquals(d.missingFrames, []);
        assertEquals(d.stateFrames, { idle: ["boss_0.png", "boss_1.png"] });
        assertEquals(d.dials.aggression.interval, 100);
        assertEquals(d.dials.aggression.intervalRead, false);
        assertEquals(d.dials.aggression.shotsRead, true);
        assert(d.dials.aggression.cadence.includes("pattern script"));
        assertEquals(d.dials.aggression.projectiles, [
          { slot: "bulletDataA", speed: 2, damage: 1 },
        ]);
        assertEquals(d.dials.palette.colors, ["#ff0000"]);
        assertEquals(d.dials.silhouette.frames, ["boss_0.png", "boss_1.png"]);
        const b = await describeObject("broken");
        assertEquals(b.missingFrames, ["ghost.png"]);
        assertEquals(b.dials.aggression.intervalRead, true);
        const n = await describeObject("noAtlas");
        assertEquals(n.missingFrames, ["x.png"]);
      },
    );

    await t.step(
      "preview renders the frame the runtime spawns with",
      async () => {
        const r = await renderObject({ id: "redBoss1" });
        assertEquals([r.width_px, r.height_px], [4, 4]);
        assertEquals(r.frame, "boss_0.png");
        assertEquals(r.states, ["idle", "projectile"]);
        const image = await png(r.png_base64);
        assertEquals([...image.data.slice(0, 4)], [...RED, 255]);
        const shot = await renderObject({
          id: "redBoss1",
          state: "projectile",
        });
        assertEquals([shot.width_px, shot.height_px], [2, 2]);
        assertEquals([...(await png(shot.png_base64)).data.slice(0, 4)], [
          ...BLUE,
          255,
        ]);
        const big = await renderObject({ id: "redBoss1", scale: 3 });
        assertEquals([big.width_px, big.height_px], [12, 12]);
        await assertRejects(
          () => renderObject({ id: "redBoss1", frame: 2 }),
          Error,
          "out of range",
        );
        await assertRejects(
          () => renderObject({ id: "redBoss1", state: "attack" }),
          Error,
          "idle, projectile",
        );
        await assertRejects(
          () => renderObject({ id: "noAtlas" }),
          Error,
          "could not be read",
        );
        assertEquals(db.writes, []);
      },
    );

    await t.step(
      "a dry run answers with the result and writes nothing",
      async () => {
        const u = await updateObject({
          id: "redBoss1",
          aggression: 1,
          palette: { hue: 120 },
        });
        assertEquals(u.applied, false);
        assertEquals(u.written, []);
        // A boss's interval is not read by the runtime, so it is not moved.
        assertEquals(u.changes, [
          { field: "bulletDataA.speed", before: 2, after: 3 },
          { field: "bulletDataA.damage", before: 1, after: 2 },
        ]);
        assert(
          u.warnings.some((w) => w.includes("interval 100 is left alone")),
        );
        assertEquals(u.art.transformed, ["boss_0.png", "boss_1.png"]);
        assertEquals(u.atlas.write, "in place");
        // The preview is of the result, not of what is stored — and carries
        // the six watch keys only.
        assertEquals([...(await png(u.png_base64)).data.slice(0, 4)], [
          ...GREEN,
          255,
        ]);
        assertEquals(
          u.note,
          "bulletDataA.speed 2→3 · bulletDataA.damage 1→2 · hue +120°",
        );
        assert(!("frameIndex" in u) && !("scale" in u));
        assertEquals(db.writes, []);
        assertEquals(
          (db.read("characters/redBoss1") as { interval: number }).interval,
          100,
        );
        // A colour nobody knows fails before anything is read, whatever the
        // scope would have selected.
        await assertRejects(
          () =>
            updateObject({
              id: "redBoss1",
              palette: { toward: "dark red" },
              scope: "projectiles",
            }),
          Error,
          "Unknown colour",
        );
      },
    );

    await t.step(
      "a record with no atlas still dry-runs, and refuses to write",
      async () => {
        const dry = await updateObject({ id: "noAtlas", stats: { hp: 9 } });
        assertEquals(dry.unresolved, ["x.png"]);
        assertEquals(dry.changes, [{ field: "hp", before: 5, after: 9 }]);
        assert(dry.warnings.some((w) => w.includes("could not be read")));
        await assertRejects(
          () => updateObject({ id: "noAtlas", stats: { hp: 9 }, apply: true }),
          Error,
          "Refusing to write",
        );
        await assertRejects(
          () => updateObject({ id: "broken", aggression: 1, apply: true }),
          Error,
          "Refusing to write",
        );
        assertEquals(db.writes, []);
      },
    );

    await t.step(
      "a numbers-only apply writes the record and leaves the atlas alone",
      async () => {
        const atlasBefore = structuredClone(db.read("atlases/redBoss1"));
        const u = await updateObject({
          id: "redBoss1",
          aggression: 1,
          apply: true,
        });
        assertEquals(u.applied, true);
        assertEquals(u.written, ["characters/redBoss1"]);
        assertEquals(u.atlas.write, "untouched");
        assertEquals(db.writes, ["characters/redBoss1"]);
        const record = db.read("characters/redBoss1") as Record<
          string,
          unknown
        >;
        assertEquals((record.bulletDataA as { speed: number }).speed, 3);
        assertEquals((record.bulletDataA as { damage: number }).damage, 2);
        assertEquals(record.interval, 100);
        assertEquals(record.textureKey, "redBoss1");
        assertEquals(db.read("atlases/redBoss1"), atlasBefore);
      },
    );

    await t.step(
      "a stats apply writes exact values and warns about a dead interval",
      async () => {
        const before = db.writes.length;
        const u = await updateObject({
          id: "redBoss1",
          stats: { hp: 250, interval: 40 },
          apply: true,
        });
        assertEquals(u.written, ["characters/redBoss1"]);
        assertEquals(db.writes.length, before + 1);
        const record = db.read("characters/redBoss1") as Record<
          string,
          unknown
        >;
        assertEquals([record.hp, record.interval], [250, 40]);
        assert(
          u.warnings.some((w) => w.includes("never reads a boss's interval")),
        );
      },
    );

    await t.step(
      "a pixel apply rewrites the atlas in place, keeping every frame",
      async () => {
        const before = db.writes.length;
        const u = await updateObject({
          id: "redBoss1",
          palette: { hue: 120 },
          apply: true,
        });
        assertEquals(u.written, ["atlases/redBoss1", "characters/redBoss1"]);
        assertEquals(u.atlas.write, "in place");
        assertEquals(db.writes.slice(before), u.written);

        const atlas = db.read("atlases/redBoss1") as {
          json: string;
          png: string;
        };
        // Stored as a json string with PLAIN keys — the spelling the editor
        // matches a record's names against — and every frame still there.
        assertEquals(typeof atlas.json, "string");
        assertEquals(rawKeys(atlas), [
          "boss_0.png",
          "boss_1.png",
          "shot_0.png",
          "spare.png",
        ]);
        assert(!atlas.json.includes("․"));
        // Body frames recoloured, the shot and the spare left as they were.
        assertEquals(await pixelOf(atlas, "boss_0.png"), [...GREEN, 255]);
        assertEquals(await pixelOf(atlas, "boss_1.png"), [...GREEN, 255]);
        assertEquals(await pixelOf(atlas, "shot_0.png"), [...BLUE, 255]);
        assertEquals(await pixelOf(atlas, "spare.png"), [...GREEN, 255]);
      },
    );

    await t.step(
      "a second edit compounds on the first — the write read fresh",
      async () => {
        const u = await updateObject({
          id: "redBoss1",
          palette: { hue: 120 },
          apply: true,
        });
        assertEquals(u.applied, true);
        const atlas = db.read("atlases/redBoss1") as {
          json: string;
          png: string;
        };
        // Green turned 120° further is blue. Had the first write's atlas still
        // been cached, this would have recoloured the original red to green again.
        assertEquals(await pixelOf(atlas, "boss_0.png"), [...BLUE, 255]);
        const shown = await renderObject({ id: "redBoss1" });
        assertEquals([...(await png(shown.png_base64)).data.slice(0, 4)], [
          ...BLUE,
          255,
        ]);
      },
    );

    await t.step(
      "an in-place rewrite keeps k_-hex keys and fixes leader keys, with no duplicates",
      async () => {
        const u = await updateObject({
          id: "spritexGuy",
          palette: { hue: 120 },
          apply: true,
        });
        assertEquals(u.atlas.write, "in place");
        assertEquals(u.atlas.frameCount, 2);
        assertEquals(u.art.transformed.sort(), ["atlas_s0", "old.gif"]);
        const atlas = db.read("atlases/spritexGuy") as {
          json: string;
          png: string;
        };
        assertEquals(rawKeys(atlas), [encodeFrameKey("atlas_s0"), "old.gif"]);
        assertEquals(await pixelOf(atlas, "atlas_s0"), [...GREEN, 255]);
        assertEquals(await pixelOf(atlas, "old.gif"), [...GREEN, 255]);
      },
    );

    await t.step(
      "a write that raced another writer is refused, not won",
      async () => {
        // The tools read fresh right before writing, so the race has to be
        // driven at the database layer: a stale ETag on a conditional PUT.
        const fresh = await getWithEtag("atlases/redBoss1");
        assert(fresh.etag, "the stand-in answers with an ETag");
        db.poke("atlases/redBoss1/json", "{}");
        await assertRejects(
          () =>
            put("atlases/redBoss1", { json: "{}", png: "" }, {
              ifMatch: fresh.etag,
            }),
          Error,
          "changed since it was read",
        );
        // ...and honoured when nothing moved.
        const now = await getWithEtag<{ json: string; png: string }>(
          "atlases/redBoss1",
        );
        await put("atlases/redBoss1", now.value, { ifMatch: now.etag });
        // Put the seed's atlas back for the steps that follow.
        db.poke(
          "atlases/redBoss1",
          ((await seed()).atlases as Tree).redBoss1,
        );
        invalidateAtlas();
      },
    );

    await t.step(
      "saveAs writes a new character and leaves the original alone",
      async () => {
        const before = db.writes.length;
        const u = await updateObject({
          id: "redBoss1",
          silhouette: 1,
          saveAs: "bigRed",
          apply: true,
        });
        assertEquals(u.written, ["atlases/bigRed", "characters/bigRed"]);
        assertEquals(u.atlas.write, "new");
        assertEquals(db.writes.slice(before), u.written);
        assertEquals([u.width_px, u.height_px], [6, 6]);
        assertEquals(u.art.scale, 1.5);

        const copy = db.read("characters/bigRed") as Record<string, unknown>;
        assertEquals(copy.name, "bigRed");
        assertEquals(copy.textureKey, "bigRed");
        // The copy starts from the record as it stands.
        assertEquals(copy.hp, 250);
        const original = db.read("characters/redBoss1") as Record<
          string,
          unknown
        >;
        assertEquals(original.textureKey, "redBoss1");
        // A new atlas carries only what the record names — no spare.
        const atlas = db.read("atlases/bigRed") as {
          json: string;
          png: string;
        };
        assertEquals(rawKeys(atlas), [
          "boss_0.png",
          "boss_1.png",
          "shot_0.png",
        ]);
        const frames = frameMap(JSON.parse(atlas.json));
        assertEquals(frames["boss_0.png"].frame.w, 6);
        assertEquals(frames["shot_0.png"].frame.w, 2);
        // The new object is listable and resolvable at once, and having no
        // stage in its name it does not muddy "the second boss".
        const list = await listObjects({ query: "bigRed" });
        assertEquals(list.resolved?.size, { w: 6, h: 6 });
        assertEquals(
          (await listObjects({ query: "the second boss" })).resolved?.id,
          "redBoss1",
        );
      },
    );

    await t.step(
      "saveAs refuses the object's own name and a name that exists",
      async () => {
        const before = db.writes.length;
        await assertRejects(
          () =>
            updateObject({ id: "redBoss1", saveAs: "redBoss1", apply: true }),
          Error,
          "own name",
        );
        await assertRejects(
          () => updateObject({ id: "redBoss1", saveAs: "hero", apply: true }),
          Error,
          "already exists",
        );
        assertEquals(db.writes.length, before);
        assertEquals(
          (db.read("characters/hero") as { maxHp: number }).maxHp,
          3,
        );
      },
    );

    await t.step(
      "an object in a shared atlas: no-op writes nothing, numbers write the record, pixels fork",
      async () => {
        const sharedBefore = structuredClone(db.read("atlases/shared_atlas"));
        let before = db.writes.length;
        // Nothing asked, nothing written — and no fork.
        const noop = await updateObject({ id: "hero", apply: true });
        assertEquals(noop.applied, false);
        assertEquals(noop.written, []);
        assertEquals(noop.atlas.write, "untouched");
        assert(noop.warnings.some((w) => w.includes("Nothing changed")));
        assertEquals(db.writes.length, before);
        assertEquals(
          (db.read("characters/hero") as { textureKey: string }).textureKey,
          "shared_atlas",
        );
        // Numbers only: the record, still pointing at the shared sheet.
        const stats = await updateObject({
          id: "hero",
          stats: { maxHp: 5 },
          apply: true,
        });
        assertEquals(stats.written, ["characters/hero"]);
        assertEquals(
          (db.read("characters/hero") as { textureKey: string }).textureKey,
          "shared_atlas",
        );
        assertEquals(db.read("atlases/hero"), null);
        // Pixels: its own atlas, the shared one untouched.
        before = db.writes.length;
        const u = await updateObject({
          id: "hero",
          palette: { toward: "red" },
          apply: true,
        });
        assertEquals(u.written, ["atlases/hero", "characters/hero"]);
        assertEquals(u.atlas.write, "new");
        assertEquals(db.writes.slice(before), u.written);
        assert(u.warnings.some((w) => w.includes("shared_atlas")));
        assertEquals(db.read("atlases/shared_atlas"), sharedBefore);
        const hero = db.read("characters/hero") as Record<string, unknown>;
        assertEquals(hero.textureKey, "hero");
        assertEquals(hero.maxHp, 5);
        const atlas = db.read("atlases/hero") as { json: string; png: string };
        assertEquals(rawKeys(atlas), ["hero_0.png"]);
        const [r, g, b] = await pixelOf(atlas, "hero_0.png");
        assertEquals(r, 255);
        assert(g <= 2 && b <= 2, `grey became ${[r, g, b]}, not red`);
      },
    );

    await t.step(
      "scope projectiles recolours the shots and previews one",
      async () => {
        const u = await updateObject({
          id: "redBoss1",
          palette: { toward: "green" },
          scope: "projectiles",
        });
        assertEquals(u.art.transformed, ["shot_0.png"]);
        assertEquals([u.width_px, u.height_px], [2, 2]);
        const [r, g, b] = [...(await png(u.png_base64)).data.slice(0, 3)];
        assert(g > r && g > b, `shot became ${[r, g, b]}, not green`);
        assertEquals(u.note, "→ green");
        // The body was not touched.
        const body = await renderObject({ id: "redBoss1" });
        assertEquals([...(await png(body.png_base64)).data.slice(0, 4)], [
          ...RED,
          255,
        ]);
      },
    );

    await t.step("apply with nothing to change writes nothing", async () => {
      const before = db.writes.length;
      const u = await updateObject({ id: "redBoss1", apply: true });
      assertEquals(u.applied, false);
      assertEquals(u.written, []);
      assertEquals(db.writes.length, before);
      assert(u.warnings.some((w) => w.includes("Nothing changed")));
      assertEquals(u.note, "no change");
    });
  } finally {
    setDatabaseUrl(null);
    invalidateAtlas();
    await db.close();
  }
});

Deno.test("setDatabaseUrl overrides the environment and null restores it", () => {
  const before = Deno.env.get("SHMUPX_DB");
  try {
    Deno.env.set("SHMUPX_DB", "https://env.test");
    assertEquals(databaseUrl(), "https://env.test");
    setDatabaseUrl("https://override.test");
    assertEquals(databaseUrl(), "https://override.test");
    setDatabaseUrl(null);
    assertEquals(databaseUrl(), "https://env.test");
    Deno.env.delete("SHMUPX_DB");
    assertNotEquals(databaseUrl(), "https://env.test");
  } finally {
    setDatabaseUrl(null);
    if (before === undefined) Deno.env.delete("SHMUPX_DB");
    else Deno.env.set("SHMUPX_DB", before);
  }
});
