// Master Arena Mod: the community cart "Master Arena" as the cloud game
// scripts/master-arena-mod/build-level.ts writes, its ten stages as they
// are, Mike Tyson as its first boss on Barlog's routine and Ryuda as its
// second. The script edits nothing in place — it builds one record and
// writes it into an empty slot — so what is pinned here is the record: the
// cells cut out of monkey-kombat's sheet, Tyson's record and the Saturn
// trailer that stands in for Barlog's routine (byte for byte), Ryuda placed
// and renamed to the level's spelling, the cart carried through untouched
// but for the two slots, the atlas grown only downward, keys RTDB takes,
// and a write that refuses a slot already taken and a revert that refuses
// a record that is not its own. All of it against a stand-in cart and a
// stand-in database, never the real ones.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  decodeDataUrl,
  decodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { cut } from "@shmupx/shmup-harbor/raster";
import { encodeBossTrailer } from "@shmupx/shmup-engine";
import { decodeBossTrailer } from "../packages/shmup-engine/src/decode/decode-boss.js";
import {
  type FrameRect,
  type ResolvedFrame,
  sheetDataUrl,
} from "../mcp/lib/art.ts";
import { referencedFrames } from "../mcp/lib/character.ts";
import { decodeFrameName, setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import { gameIdForLevel } from "../static/phaser-plugins/level-loader.js";
import { PAD } from "../scripts/gs/build-stage2.ts";
import { badRtdbKey } from "../scripts/lib/rtdb-publish.ts";
import {
  apply,
  ART,
  BARLOG_PATTERN,
  BARLOG_SHOT,
  isThisMod,
  type Json,
  LEVEL,
  MOD_SCRIPT,
  PARENT,
  plan,
  revert,
  RYUDA,
  ryudaRecord,
  ryudaRename,
  type Sources,
  summary,
  TYSON,
  TYSON_ANIM,
  TYSON_CELL,
  TYSON_CELLS,
  TYSON_PATTERNS,
  TYSON_PLAYLIST,
  TYSON_SHEET,
  TYSON_SIZE_CLASS,
  tysonFrames,
  tysonRecord,
  tysonTrailer,
} from "../scripts/master-arena-mod/build-level.ts";

type Tree = Record<string, unknown>;

// ---------------------------------------------------------------- fixtures

/** A sheet whose every pixel says where it is, so a moved pixel shows. */
function patterned(w: number, h: number, seed = 0): Raster {
  const out = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data.set(
        [(x + seed) & 255, (y + seed) & 255, (x * y + seed) & 255, 255],
        (y * w + x) * 4,
      );
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

const same = (a: Raster, b: Raster) =>
  a.width === b.width && a.height === b.height &&
  a.data.every((v, i) => v === b.data[i]);

/** The cart's first boss's trailer, as Master Arena's decodes (its bytes). */
function trailer(spec: Json): Json {
  return decodeBossTrailer(encodeBossTrailer(spec));
}
const BOSS0_TRAILER = trailer({
  sizeClass: 0,
  hpStages: 3,
  rotate: false,
  deathSpin: false,
  hp: 4608000,
  score: 100000,
  optionFlag: true,
  playlist: [[0, 0, 0, 0], [3, 3, 3, 3], [1, 2, 1, 2], [0, 0, 0, 0]],
  arrive: 17,
  death: 48,
  patterns: [
    { moveScript: 29, moveSpeed: 4, fireTickFrames: 3, firePoints: [] },
    { moveScript: 29, moveSpeed: 6, fireTickFrames: 3, firePoints: [] },
    { moveScript: 2, moveSpeed: 3, fireTickFrames: 2, firePoints: [] },
    { moveScript: 31, moveSpeed: 5, fireTickFrames: 1, firePoints: [] },
  ],
});
const BOSS1_TRAILER = trailer({
  sizeClass: 1,
  hpStages: 2,
  hp: 4608000,
  score: 100000,
  optionFlag: true,
  playlist: [[0, 1, 1, 0], [2, 1, 3, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  arrive: 19,
  death: 80,
  patterns: [{
    moveScript: 2,
    moveSpeed: 1,
    fireTickFrames: 2,
    firePoints: [],
  }],
});

/** The catalog's ryuda, as shmupX/characters/ryuda spells her. */
function ryudaCharacter(): Json {
  return {
    name: RYUDA,
    textureKey: RYUDA,
    anim: { attack: ["ryuda-projectile_r0"], idle: ["ryuda-projectile_r0"] },
    bulletDataA: {
      damage: 1,
      hp: 1,
      score: 0,
      speed: 2,
      spgage: 0,
      texture: ["ryudaShotXray"],
    },
    bulletDataC: {
      damage: 1,
      hp: 1,
      score: 0,
      speed: 2,
      spgage: 0,
      texture: [
        "dezaBullet2_0.gif",
        "dezaBullet2_1.gif",
        "dezaBullet2_2.gif",
        "dezaBullet2_3.gif",
      ],
    },
    dezaemon: {
      boss: trailer({
        sizeClass: 0,
        hpStages: 1,
        hp: 2304000,
        score: 10000,
        optionFlag: true,
        playlist: [[0, 1, 2, 3], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        arrive: 241,
        death: 244,
        patterns: [{
          moveScript: 12,
          moveSpeed: 3,
          fireTickFrames: 10,
          firePoints: [
            { dx: -12, dy: -16, type: 3, rate: 2, param: 53 },
            { dx: 23, dy: 15, type: 3, rate: 6, param: 54 },
            { dx: 0, dy: 17, type: 0, rate: 3, param: 17 },
          ],
        }],
      }),
      col: 8,
      coreArt: true,
      partArt: {
        37: ["dezaPart0_37_0.gif", "dezaPart0_37_1.gif"],
        38: ["dezaPart0_38_0.gif", "dezaPart0_38_1.gif"],
      },
      row: 161,
      sizeClass: 0,
    },
    hp: 113,
    interval: 100,
    score: 10000,
    shadowOffsetY: 50,
    shadowReverse: true,
    spgage: 30,
    stageBgEnd: { alpha: 0.45, frame: "bg-great-hall_atlas_s0" },
  };
}

/** Her frames, as loadRyuda hands them over: under the level's names. */
function ryudaFrames(character: Json): ResolvedFrame[] {
  const { rename, frames } = ryudaRename(character);
  const back = Object.fromEntries(
    Object.entries(rename).map(([from, to]) => [to, from]),
  );
  const size = (name: string) =>
    name === "ryuda-projectile_r0"
      ? [58, 63]
      : name === "ryudaShotXray"
      ? [45, 48]
      : name.startsWith("dezaPart")
      ? [32, 32]
      : [16, 16];
  return frames.map((name, i) => {
    const [w, h] = size(back[name] ?? name);
    return {
      name,
      raster: patterned(w, h, 100 + i),
      source: `atlases/ryuda/${back[name] ?? name}`,
      scope: RYUDA,
    };
  });
}

/** A cart as the shelf decodes one: two stages, three bosses, its own art. */
async function cartRecord(): Promise<{ cart: Json; sheet: Raster }> {
  const sheet = patterned(256, 96);
  const atlasFrames: Record<string, FrameRect> = {
    "dezaBoss0_0.gif": rect(0, 0, 64, 64),
    "dezaBoss0_1.gif": rect(64, 0, 64, 64),
    "dezaBoss1_0.gif": rect(128, 0, 128, 64),
    "dezaBullet2_0.gif": rect(0, 64, 16, 16),
    "dezaBullet2_1.gif": rect(16, 64, 16, 16),
    "dezaBullet2_2.gif": rect(32, 64, 16, 16),
    "dezaBullet2_3.gif": rect(48, 64, 16, 16),
    "deza0_00_0.gif": rect(64, 64, 16, 16),
    "dezaShip_0.gif": rect(80, 64, 32, 32),
  };
  const boss = (n: number, idle: string[], deza: Json): Json => ({
    name: `dezaBoss${n}`,
    score: 100000,
    spgage: 30,
    hp: 900,
    interval: 100,
    shadowReverse: true,
    shadowOffsetY: 50,
    bulletData: {},
    anim: { idle, attack: idle },
    dezaemon: deza,
  });
  // A stage's scenery: a 2x2 grid of u16be tile words, base64, over the
  // cells the record lists — the shape the schema checks.
  const stage = (rows: number): Json => ({
    enemylist: Array.from({ length: rows }, () => ["A0", "00", "00", "00"]),
    waveRows: Array.from({ length: rows }, (_, i) => i),
    waveInterval: 1,
    background: { cols: 2, rows: 2, tiles: btoa("\0\0\0\x01\0\x01\0\0") },
    scroll: { curve: "" },
    items: [],
  });
  const cart: Json = {
    name: PARENT.name,
    stageKey: "stage0",
    width: 4,
    ...stage(3),
    stages: { stage0: stage(3), stage1: stage(2), stage2: stage(2) },
    backgroundCells: ["deza0_00_0.gif", "dezaBullet2_0.gif"],
    enemyData: {
      enemyA: {
        name: "deza0_00",
        hp: 1,
        score: 100,
        texture: ["deza0_00_0.gif"],
        dezaemon: { stage: 0, record: 0 },
      },
    },
    bossData: {
      boss0: boss(0, ["dezaBoss0_0.gif", "dezaBoss0_1.gif"], {
        sizeClass: 0,
        row: 728,
        col: 8,
        boss: BOSS0_TRAILER,
        partArt: { 26: ["dezaPart0_26_0.gif"] },
        coreArt: false,
      }),
      boss1: boss(1, ["dezaBoss1_0.gif"], {
        sizeClass: 1,
        row: 730,
        col: 6,
        boss: BOSS1_TRAILER,
        coreArt: false,
      }),
      boss2: boss(2, ["dezaBoss0_1.gif"], {
        sizeClass: 0,
        row: 700,
        col: 8,
        boss: BOSS0_TRAILER,
        coreArt: false,
      }),
    },
    playerData: { name: "dezaShip", texture: ["dezaShip_0.gif"] },
    meta: { version: "1.0", source: "dezaemon2", dezaemonSettings: {} },
    noStory: true,
    dezaemonTitle: { title1: "MASTER ARENA" },
    dezaemonTitleScreen: { layout: {} },
    dezaemonBullets: { art: [[], [], []], configs: [] },
    atlasImageDataURL: await sheetDataUrl(sheet),
    atlasFrames,
  };
  return { cart, sheet };
}

const STOCK_PLAYER: Json = {
  name: "duke",
  maxHp: 3,
  texture: ["duke_0"],
  shootNormal: { texture: ["normalProjectile0"] },
  shootBig: { texture: ["bigProjectile0"] },
  shoot3way: { texture: ["projectile3way0"] },
  barrier: { texture: ["barrier0"] },
};

async function sources(): Promise<Sources & { sheet: Raster }> {
  const { cart, sheet } = await cartRecord();
  const ryuda = ryudaCharacter();
  return {
    cart,
    sheet,
    index: {
      genre: "Vertical Shoot-em-up",
      titleEn: "Master Arena",
      developerEn: "MA Project",
    },
    ryuda,
    ryudaFrames: ryudaFrames(ryuda),
    tysonSheet: await decodePng(
      await Deno.readFile(new URL(TYSON_SHEET, ART)),
    ),
    barlogShots: BARLOG_SHOT.texture.map((name, i) => ({
      name,
      raster: patterned(43, 104, 200 + i),
      source: `game_asset#${name}`,
      scope: "game_asset",
    })),
    stockAtlasHeight: 2128,
    stockFrames: new Set(["normalProjectile0.gif", ...BARLOG_SHOT.texture]),
    stockPlayer: STOCK_PLAYER,
  };
}

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

// ---------------------------------------------------------------- the sheet

Deno.test("monkey-kombat's sheet is thirteen clean cells, every one in a stance", async () => {
  const sheet = await decodePng(await Deno.readFile(new URL(TYSON_SHEET, ART)));
  const frames = tysonFrames(sheet);
  assertEquals(frames.map((f) => f.name), Object.keys(TYSON_CELLS));
  assertEquals(frames.length, 13);
  for (const f of frames) {
    assertEquals([f.raster.width, f.raster.height], [
      TYSON_CELL.w,
      TYSON_CELL.h,
    ]);
    const cell = TYSON_CELLS[f.name];
    assert(
      same(
        f.raster,
        cut(sheet, { x: cell * TYSON_CELL.w, y: 0, ...TYSON_CELL }),
      ),
      `${f.name} is cell ${cell}`,
    );
    let drawn = 0;
    for (let i = 3; i < f.raster.data.length; i += 4) {
      const a = f.raster.data[i];
      assert(a === 0 || a === 255, `${f.name}: binary alpha, got ${a}`);
      if (a) drawn++;
    }
    assert(drawn > 1000, `${f.name} is drawn`);
  }
  // Every stance names a cell, and every cell is in a stance.
  const used = new Set(Object.values(TYSON_ANIM).flat());
  for (const name of used) assert(name in TYSON_CELLS, name);
  assertEquals([...used].sort(), Object.keys(TYSON_CELLS).sort());
  // The idle list has Barlog's rhythm: three, back to the first, two, back.
  assertEquals(TYSON_ANIM.idle.length, 7);
  assertEquals(TYSON_ANIM.idle[3], TYSON_ANIM.idle[0]);
  assertEquals(TYSON_ANIM.idle[6], TYSON_ANIM.idle[4]);
  // A sheet of the wrong shape is refused, not cut short.
  assertThrows(() => tysonFrames(patterned(55 * 12, 122)), Error, "cells");
  assertThrows(() => tysonFrames(patterned(55 * 13, 121)), Error, "cells");
});

// ---------------------------------------------------------------- tyson

Deno.test("tyson's record: his art and shadow, Barlog's routine and shot, the slot's bar", async () => {
  const { cart } = await cartRecord();
  const slot = cart.bossData.boss0;
  const t = tysonRecord(slot);
  assertEquals(t.name, TYSON);
  assertEquals(t.attackPattern, BARLOG_PATTERN);
  assertEquals(t.anim, TYSON_ANIM);
  assertEquals(t.bulletData, BARLOG_SHOT);
  assertEquals(t.bulletDataA, undefined);
  assertEquals([t.hp, t.score, t.spgage], [slot.hp, slot.score, slot.spgage]);
  assertEquals(t.interval, 200);
  assertEquals(t.shadowReverse, false);
  assertEquals(t.shadowOffsetY, TYSON_CELL.h - 5);
  assertEquals(t.dezaemon.sizeClass, TYSON_SIZE_CLASS);
  assertEquals([t.dezaemon.row, t.dezaemon.col], [728, 8]);
  assertEquals("partArt" in t.dezaemon, false);
  assertEquals("coreArt" in t.dezaemon, false);
  // Untouched slots stay untouched.
  assertEquals(slot.name, "dezaBoss0");
  assertEquals(slot.dezaemon.boss, BOSS0_TRAILER);
});

Deno.test("tyson's Saturn trailer is the slot's with Barlog's moves in it, byte for byte", () => {
  const block = tysonTrailer(BOSS0_TRAILER);
  // The slot's own: bar, score, flags, entrance, death.
  for (
    const k of [
      "hpStages",
      "rotate",
      "deathSpin",
      "hp",
      "score",
      "optionFlag",
      "arrive",
      "death",
      "dying",
    ]
  ) {
    assertEquals(block[k], BOSS0_TRAILER[k], k);
  }
  assertEquals(block.sizeClass, TYSON_SIZE_CLASS);
  // The larger core enters 32 rows further out (the class nudge).
  assertEquals(block.arrival, {
    ...BOSS0_TRAILER.arrival,
    scroll: BOSS0_TRAILER.arrival.scroll + 32,
  });
  assertEquals(block.playlist, TYSON_PLAYLIST);
  // Barlog's three moves and the mirrored first, at the fastest speed,
  // one shot a move from under his centre; the dive never follows the dash.
  assertEquals(block.patterns.map((p: Json) => p.moveScript), [22, 31, 28, 23]);
  for (const [i, p] of block.patterns.entries()) {
    assertEquals(p.moveSpeed, 7);
    assertEquals(p.fireTickFrames, 60);
    assertEquals(p.firePoints.length, 3);
    const aimed = i === 1;
    assertEquals(p.firePoints[0], {
      dx: 0,
      dy: 20,
      type: 0,
      rate: 0,
      param: aimed ? 0x11 : 0x01,
      shot: { weapon: 0, fn: 1, aimed, arg: 0 },
    });
    for (const fp of p.firePoints.slice(1)) {
      assertEquals(fp.shot, { weapon: 0, fn: 0, aimed: false, arg: 0 });
    }
  }
  for (const row of block.playlist) {
    for (let i = 1; i < row.length; i++) {
      assert(!(row[i - 1] === 1 && row[i] === 2), "no dive after the dash");
    }
    assert(row[0] !== 2, "no band opens on the dive");
  }
  // Spelled as a decoded trailer: encoding and decoding it changes nothing,
  // and the slot's own block round-trips the same way.
  assertEquals(trailer(block), block);
  assertEquals(trailer(BOSS0_TRAILER), BOSS0_TRAILER);
  assertEquals(trailer(TYSON_PATTERNS && block), block);
  // The bytes the writer will put on the cart.
  const bytes = encodeBossTrailer(block);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  assertEquals(
    hex,
    "22 44 b4 e1 6d 00 11 30 " +
      "b7 00 00 14 00 01 00 00 00 00 00 00 00 00 " +
      "ff 00 00 14 00 11 00 00 00 00 00 00 00 00 " +
      "e7 00 00 14 00 01 00 00 00 00 00 00 00 00 " +
      "bf 00 00 14 00 01 00 00 00 00 00 00 00 00",
  );
});

// ---------------------------------------------------------------- ryuda

Deno.test("ryuda is placed as the library has her, renamed to the level's spelling, without her backdrop", async () => {
  const { cart } = await cartRecord();
  const character = ryudaCharacter();
  const { rename, frames } = ryudaRename(character);
  // Her own names stay; a name the cart spells too gets her prefix; the
  // backdrop is not among them.
  assertEquals(rename, {
    "dezaPart0_37_0.gif": "ryuda_dezaPart0_37_0.gif",
    "dezaPart0_37_1.gif": "ryuda_dezaPart0_37_1.gif",
    "dezaPart0_38_0.gif": "ryuda_dezaPart0_38_0.gif",
    "dezaPart0_38_1.gif": "ryuda_dezaPart0_38_1.gif",
    "dezaBullet2_0.gif": "ryuda_dezaBullet2_0.gif",
    "dezaBullet2_1.gif": "ryuda_dezaBullet2_1.gif",
    "dezaBullet2_2.gif": "ryuda_dezaBullet2_2.gif",
    "dezaBullet2_3.gif": "ryuda_dezaBullet2_3.gif",
  });
  assert(frames.includes("ryuda-projectile_r0"));
  assert(frames.includes("ryudaShotXray"));
  assert(!frames.includes("bg-great-hall_atlas_s0"));
  assert(frames.every((f) => f.toLowerCase().startsWith(RYUDA)));

  const placed = ryudaRecord(character, cart.bossData.boss1);
  assertEquals("stageBgEnd" in placed, false);
  assertEquals("attackPattern" in placed, false);
  assertEquals([placed.dezaemon.row, placed.dezaemon.col], [730, 6]);
  assertEquals(placed.dezaemon.sizeClass, 0);
  assertEquals(placed.dezaemon.boss, character.dezaemon.boss);
  assertEquals(placed.bulletDataC.texture, [
    "ryuda_dezaBullet2_0.gif",
    "ryuda_dezaBullet2_1.gif",
    "ryuda_dezaBullet2_2.gif",
    "ryuda_dezaBullet2_3.gif",
  ]);
  assertEquals(placed.dezaemon.partArt["37"], [
    "ryuda_dezaPart0_37_0.gif",
    "ryuda_dezaPart0_37_1.gif",
  ]);
  assertEquals(referencedFrames(placed).sort(), frames.sort());
  // Everything else is hers as the catalog has her.
  const { stageBgEnd: _bg, dezaemon: _d, bulletDataC: _c, ...hers } = character;
  const { dezaemon: _pd, bulletDataC: _pc, ...theirs } = placed;
  assertEquals(theirs, hers);
  assertEquals(character.stageBgEnd.frame, "bg-great-hall_atlas_s0");
});

// ---------------------------------------------------------------- the plan

Deno.test("the record is the cart's, but for the two slots and the art they bring", async () => {
  const s = await sources();
  const before = structuredClone(s.cart);
  const p = await plan(s);
  const r = p.record;

  assertEquals(r.name, LEVEL);
  assertEquals(r.gameId, gameIdForLevel({ name: LEVEL }));
  assertEquals(r.meta.source, "dezaemon2");
  assertEquals(r.meta.mod, {
    parent: PARENT.name,
    slug: PARENT.slug,
    script: MOD_SCRIPT,
    bosses: { boss0: TYSON, boss1: RYUDA },
  });
  assertEquals(r.dezaemonCredits.developer, "MA Project");
  assertEquals(r.dezaemonCredits.title, "Master Arena");
  assertEquals("attribution" in r, false);
  assert(isThisMod(r));

  // The cart, carried through: every key but the ones the mod owns.
  const owned = new Set([
    "name",
    "gameId",
    "bossData",
    "atlasImageDataURL",
    "atlasFrames",
    "dezaemonCredits",
    "meta",
  ]);
  for (const k of Object.keys(before)) {
    if (!owned.has(k)) assertEquals(r[k], before[k], k);
  }
  assertEquals(Object.keys(r).filter((k) => !(k in before)).sort(), [
    "dezaemonCredits",
    "gameId",
  ]);
  assertEquals(s.cart, before, "the sources are not edited in place");

  // The slots: Tyson first, Ryuda second, the third as it was.
  assertEquals(r.bossData.boss0, tysonRecord(before.bossData.boss0));
  assertEquals(r.bossData.boss1, ryudaRecord(s.ryuda, before.bossData.boss1));
  assertEquals(r.bossData.boss2, before.bossData.boss2);
  assertEquals(p.bosses, {
    boss0: { before: "dezaBoss0", after: TYSON },
    boss1: { before: "dezaBoss1", after: RYUDA },
  });

  // The atlas: keys RTDB takes, the cart's frames where they were, the new
  // ones under them, every pixel where its frame says.
  assertEquals(badRtdbKey(r), null);
  const frames: Record<string, FrameRect> = {};
  for (const [k, v] of Object.entries(r.atlasFrames)) {
    assert(!k.includes("."), `${k} is keyed for RTDB`);
    frames[decodeFrameName(k)] = v as FrameRect;
  }
  for (const [k, v] of Object.entries(before.atlasFrames)) {
    assertEquals(frames[k], v, `${k} stays where it was`);
  }
  const after = await decodeDataUrl(r.atlasImageDataURL);
  assertEquals(after.width, s.sheet.width);
  assertEquals(p.atlas.before, { w: 256, h: 96 });
  assertEquals(p.atlas.after, { w: after.width, h: after.height });
  assert(same(cut(after, { x: 0, y: 0, w: 256, h: 96 }), s.sheet));
  const added = [
    ...tysonFrames(s.tysonSheet),
    ...s.barlogShots,
    ...s.ryudaFrames,
  ];
  assertEquals(p.added.map((a) => a.frame), added.map((a) => a.name));
  assertEquals(p.reused, []);
  for (const f of added) {
    const at = frames[f.name];
    assert(at, `${f.name} is in the atlas`);
    assert(at.frame.y >= 96 + PAD, `${f.name} sits under the cart's sheet`);
    assert(same(cut(after, at.frame), f.raster), `${f.name}'s pixels`);
  }
  // The cart's bullets are still the cart's; Ryuda's are hers, beside them.
  assert(
    same(
      cut(after, frames["dezaBullet2_0.gif"].frame),
      cut(s.sheet, before.atlasFrames["dezaBullet2_0.gif"].frame),
    ),
  );
  assert(
    !same(
      cut(after, frames["dezaBullet2_0.gif"].frame),
      cut(after, frames["ryuda_dezaBullet2_0.gif"].frame),
    ),
  );
  // Every frame the two bosses name has pixels.
  for (const slot of ["boss0", "boss1"]) {
    for (const name of referencedFrames(r.bossData[slot])) {
      assert(frames[name], `${slot} names ${name}`);
    }
  }
  assertEquals(p.warnings.filter((w) => /boss[01]/.test(w)), []);

  const sum = summary(p);
  assertEquals(sum.stages, 3);
  assertEquals(sum.bosses.boss0, "tyson (boss1) hp 900");
  assertEquals(sum.bosses.boss1, "ryuda hp 113");
  assertEquals(sum.changed, p.bosses);
});

Deno.test("a cart that is not Master Arena, or art that is short, is refused", async () => {
  const s = await sources();
  const web = structuredClone(s);
  web.cart.bossData.boss0 = {
    name: "bison",
    hp: 100,
    anim: { idle: ["dezaBoss0_0.gif"] },
  };
  await assertRejects(() => plan(web), Error, "not a Dezaemon boss");
  const short = structuredClone(s);
  short.ryudaFrames = short.ryudaFrames.filter((f) =>
    f.name !== "ryudaShotXray"
  );
  await assertRejects(() => plan(short), Error, "ryudaShotXray");
  const tall = structuredClone(s);
  tall.stockAtlasHeight = 4096;
  await assertRejects(() => plan(tall), Error, "rows tall");
});

// ---------------------------------------------------------------- writing

Deno.test("--apply fills an empty slot once, and --revert takes back only this mod", async () => {
  const s = await sources();
  const { record } = await plan(s);
  const db = fakeDb({ shmupX: { levels: {} } });
  setDatabaseUrl(db.url);
  try {
    const path = `shmupX/levels/${LEVEL}`;
    assertEquals(await apply(record), path);
    const written = db.read(path) as Json;
    assertEquals(written.name, LEVEL);
    assertEquals(written.gameId, record.gameId);
    assertEquals(written.savedAt, { ".sv": "timestamp" });
    assertEquals(written.bossData.boss0.name, TYSON);
    assertEquals(written.bossData.boss1.name, RYUDA);

    // A second write is refused; forced, it keeps the board the scores are on.
    await assertRejects(() => apply(record), Error, "--force");
    (db.read(path) as Json).gameId = "master-arena-mod-kept";
    const forced = structuredClone(record);
    assertEquals(await apply(forced, { force: true }), path);
    assertEquals((db.read(path) as Json).gameId, "master-arena-mod-kept");

    // Revert deletes ours; a record that is not ours stays unless forced.
    assertEquals(await revert(), `${path} deleted`);
    assertEquals(db.read(path), null);
    assertEquals(await revert(), `${path} is already empty`);
    await apply({ name: "somebody's level", meta: { version: "1.0" } });
    assert(!isThisMod(db.read(path) as Json));
    await assertRejects(() => revert(), Error, "--force");
    assertEquals(await revert({ force: true }), `${path} deleted`);
    assertEquals(db.read(path), null);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
});
