// Geekstar's letters: the gs cloud game's first boss wears the G, E, E, K of
// his logo as a boss-record `overlay` (scripts/gs/geek-letters.ts writes it;
// game.bundle.js's armBossOverlay draws it). Each letter is filled black over
// the white one it hides, one at a time a letter fades in flashing neon and
// leaves as an aimed shot, and while it charges his mask's red eyes and mouth
// burn in its colour. The script's half runs against a stand-in database,
// never the real one; the runtime's half against a stand-in scene.

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  decodeDataUrl,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { type FrameRect, sheetDataUrl } from "../mcp/lib/art.ts";
import { referencedFrames, remapFrames } from "../mcp/lib/character.ts";
import { decodeFrameName, encodeKey, setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  BOSS_NAME,
  bossFrames,
  coverTitle,
  FLAME_BOX,
  flameCut,
  flameName,
  isFlame,
  isLetterEdge,
  letterCover,
  LETTERS,
  OVERLAY,
  plan,
  revert,
  TITLE_AT,
  TITLE_FRAME,
  uncoverTitle,
} from "../scripts/gs/geek-letters.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
type Tree = Record<string, unknown>;

// ---------------------------------------------------------------- the script

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

const rect = (x: number, y: number, w: number, h: number): FrameRect => ({
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w, h },
  sourceSize: { w, h },
});

const put = (img: Raster, x: number, y: number, rgba: number[]) =>
  img.data.set(rgba, (y * img.width + x) * 4);

/**
 * Two of his frames side by side, 170x105 each: an eye of bright red, the
 * mouth darker, and the orange of SQUAD below, which is not his flame.
 */
function geekstarSheet(): Raster {
  const sheet = newRaster(340, 105);
  for (const at of [0, 170]) {
    put(sheet, at + 85, 20, [255, 0, 0, 255]);
    put(sheet, at + 90, 30, [176, 0, 0, 255]);
    put(sheet, at + 85, 80, [250, 135, 40, 255]);
  }
  // The mouth is wider in the second frame: he is attacking.
  put(sheet, 170 + 95, 31, [255, 0, 0, 255]);
  // The logo's white G, as a block where the letter sits in the first frame.
  for (let y = 24; y < 24 + 38; y++) {
    for (let x = 21; x < 21 + 34; x++) put(sheet, x, y, [255, 255, 255, 255]);
  }
  return sheet;
}

/** The first frame — the logo — laid into a title G at TITLE_AT. */
function titleOf(sheet: Raster): Raster {
  const title = newRaster(256, 300);
  for (let y = 0; y < 105; y++) {
    title.data.set(
      sheet.data.subarray(y * sheet.width * 4, (y * sheet.width + 170) * 4),
      ((y + TITLE_AT.y) * 256 + TITLE_AT.x) * 4,
    );
  }
  return title;
}

async function withDb(
  run: (db: ReturnType<typeof fakeDb>, sheet: Raster, level: Tree) => Promise<
    void
  >,
) {
  const sheet = geekstarSheet();
  const level: Tree = {
    atlasImageDataURL: await sheetDataUrl(sheet),
    atlasFrames: {
      geekstar0: rect(0, 0, 170, 105),
      geekstar5: rect(170, 0, 170, 105),
    },
    bossData: {
      boss0: {
        name: BOSS_NAME,
        hp: 240,
        anim: { idle: ["geekstar0"], attack: ["geekstar5", "geekstar0"] },
        bulletData: { texture: ["geek-bullet"] },
      },
    },
    uiAtlases: {
      game_ui: {
        frames: { [encodeKey(TITLE_FRAME)]: rect(0, 0, 256, 300) },
        imageDataURL: await sheetDataUrl(titleOf(sheet)),
      },
    },
    savedAt: 1,
  };
  const db = fakeDb({
    shmupX: { levels: { gs: level } },
    // cmg's root-level copy, which must come out as it went in.
    levels: { gs: { ...structuredClone(level), savedAt: 0 } },
  });
  setDatabaseUrl(db.url);
  try {
    await run(db, sheet, level);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
}

Deno.test("his flame is the mask's pure reds, never SQUAD's orange", () => {
  assert(isFlame(255, 0, 0, 255));
  assert(isFlame(176, 0, 0, 255));
  assert(!isFlame(250, 135, 40, 255), "SQUAD");
  assert(!isFlame(255, 255, 255, 255), "a letter");
  assert(!isFlame(255, 0, 0, 0), "transparent");
});

Deno.test("each frame's flame is cut in white at one shared rectangle", () => {
  const sheet = geekstarSheet();
  const frame = (x: number) => {
    const out = newRaster(170, 105);
    for (let y = 0; y < 105; y++) {
      out.data.set(
        sheet.data.subarray((y * 340 + x) * 4, (y * 340 + x + 170) * 4),
        y * 170 * 4,
      );
    }
    return out;
  };
  const flame = flameCut({ geekstar0: frame(0), geekstar5: frame(170) });
  assert(flame);
  // The union of both frames' reds: the eye at 85,20 to the wide mouth 95,31.
  assertEquals([flame.x, flame.y], [85, 20]);
  for (const cut of Object.values(flame.cuts)) {
    assertEquals([cut.width, cut.height], [11, 12]);
  }
  const at = (
    img: Raster,
    x: number,
    y: number,
  ) => [
    ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
  ];
  // The red's brightness, as white: the darker mouth comes out grey.
  assertEquals(at(flame.cuts.geekstar0, 0, 0), [255, 255, 255, 255]);
  assertEquals(at(flame.cuts.geekstar0, 5, 10), [176, 176, 176, 255]);
  // Only the attacking frame has the wider mouth.
  assertEquals(at(flame.cuts.geekstar0, 10, 11), [0, 0, 0, 0]);
  assertEquals(at(flame.cuts.geekstar5, 10, 11), [255, 255, 255, 255]);
  // SQUAD's orange is below FLAME_BOX, and no frame without red has a flame.
  assert(80 >= FLAME_BOX.y + FLAME_BOX.h);
  assertEquals(flameCut({ blank: newRaster(170, 105) }), null);
});

Deno.test("his frames are his stances and his texture, not his bullets", () => {
  assertEquals(
    bossFrames({
      texture: ["geekstar0"],
      anim: { idle: ["geekstar0", "geekstar1"], warp: ["geekstar3"] },
      bulletData: { texture: ["geek-bullet"] },
    }).sort(),
    ["geekstar0", "geekstar1", "geekstar3"],
  );
});

Deno.test("the character tools carry an overlay's art with the boss", () => {
  const record = {
    anim: { idle: ["geekstar0"] },
    overlay: {
      ...OVERLAY,
      glow: { x: 81, y: 16, frames: { geekstar0: "geekstar0-flame" } },
    },
  };
  assertEquals(referencedFrames(record).sort(), [
    "geek-e",
    "geek-g",
    "geek-k",
    "geekstar0",
    "geekstar0-flame",
  ]);
  const moved = remapFrames(record, {
    geekstar0: "gs_geekstar0",
    "geekstar0-flame": "gs_geekstar0-flame",
    "geek-e": "gs_geek-e",
  }) as Json;
  assertEquals(moved.overlay.parts.map((p: Json) => p.frame), [
    "geek-g",
    "gs_geek-e",
    "gs_geek-e",
    "geek-k",
  ]);
  // The glow is keyed by his frames: the keys move with them.
  assertEquals(moved.overlay.glow.frames, {
    gs_geekstar0: "gs_geekstar0-flame",
  });
  assertEquals(record.overlay.parts[1].frame, "geek-e", "a copy, not in place");
});

Deno.test("the letters sit on the logo's own: four of them, G E E K", () => {
  assertEquals(OVERLAY.parts.map((p) => p.frame), [
    "geek-g",
    "geek-e",
    "geek-e",
    "geek-k",
  ]);
  for (const name of LETTERS) {
    assert(OVERLAY.parts.some((p) => p.frame === name), name);
  }
  assertEquals(OVERLAY.cover, "#000000");
});

Deno.test({
  name:
    "apply lands the letters, the flame cuts and the overlay; revert takes them out",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db, sheet, level) => {
      const p = await plan();
      assertEquals(p.added.slice(0, 3), [...LETTERS]);
      assertEquals(
        p.added.slice(3).sort(),
        [flameName("geekstar0"), flameName("geekstar5")].sort(),
      );
      assertEquals(p.overlay.glow?.frames, {
        geekstar0: flameName("geekstar0"),
        geekstar5: flameName("geekstar5"),
      });
      assertEquals([p.overlay.glow?.x, p.overlay.glow?.y], [85, 20]);
      await apply(p);

      const frames = db.read("shmupX/levels/gs/atlasFrames") as Record<
        string,
        FrameRect
      >;
      const names = Object.keys(frames).map(decodeFrameName);
      for (const n of p.added) assert(names.includes(n), n);
      const after = await decodeDataUrl(
        db.read("shmupX/levels/gs/atlasImageDataURL") as string,
      );
      assert(after.height > sheet.height, "packed under the sheet");
      for (let i = 0; i < sheet.data.length; i++) {
        if (after.data[i] !== sheet.data[i]) {
          throw new Error(`the level's own pixel ${i} moved`);
        }
      }
      const boss = db.read("shmupX/levels/gs/bossData/boss0") as Json;
      assertEquals(boss.overlay, p.overlay);
      assertEquals(boss.hp, 240, "the rest of his record is his");

      // The title's white G is black where the letter covers it, and only
      // there: every pixel that changed is black, and it was the logo's.
      const titleAt = "shmupX/levels/gs/uiAtlases/game_ui/imageDataURL";
      const before = titleOf(sheet);
      const covered = await decodeDataUrl(db.read(titleAt) as string);
      let blacked = 0;
      for (let i = 0; i < before.data.length; i += 4) {
        const was = [...before.data.subarray(i, i + 4)];
        const now = [...covered.data.subarray(i, i + 4)];
        if (was.join() === now.join()) continue;
        assertEquals(now, [0, 0, 0, 255], `pixel ${i / 4}`);
        blacked++;
      }
      assert(blacked > 300, `only ${blacked} pixels covered`);

      // Again: everything is as planned, so nothing is written.
      const again = await plan();
      assertEquals([again.added, again.title.state], [[], "covered"]);
      assertEquals(await apply(again), []);
      // An overlay someone changed is replaced only when forced.
      await fetch(
        `${db.url}/shmupX/levels/gs/bossData/boss0/overlay/cover.json`,
        {
          method: "PUT",
          body: JSON.stringify("#ffffff"),
        },
      ).then((r) => r.body?.cancel());
      await assertRejects(() => plan().then((q) => apply(q)), Error, "--force");

      await revert();
      assertEquals(db.read("shmupX/levels/gs/bossData/boss0/overlay"), null);
      assertEquals(db.read("shmupX/levels/gs/atlasFrames"), level.atlasFrames);
      const back = await decodeDataUrl(
        db.read("shmupX/levels/gs/atlasImageDataURL") as string,
      );
      assertEquals([back.width, back.height], [sheet.width, sheet.height]);
      const untitled = await decodeDataUrl(db.read(titleAt) as string);
      assertEquals(untitled.data, before.data, "the white letters are back");
      // cmg's copy was never touched.
      assertEquals(db.read("levels/gs/savedAt"), 0);
      assertEquals(db.read("levels/gs/bossData/boss0/overlay"), null);
    });
  },
});

Deno.test("the title is covered only where it is his logo", () => {
  const dot = newRaster(1, 1);
  dot.data.set([255, 255, 255, 255]);
  const letters = { "geek-g": dot, "geek-e": dot, "geek-k": dot };
  const logo = newRaster(170, 105);
  for (const part of OVERLAY.parts) {
    put(logo, part.x, part.y, [255, 255, 255, 255]);
  }
  const title = newRaster(256, 300);
  for (const part of OVERLAY.parts) {
    put(title, TITLE_AT.x + part.x, TITLE_AT.y + part.y, [255, 255, 255, 255]);
  }
  const area = { x: 0, y: 0, w: 256, h: 300 };
  const covered = coverTitle(title, area, logo, letters);
  assert(covered !== "covered");
  for (const part of OVERLAY.parts) {
    const i = ((TITLE_AT.y + part.y) * 256 + TITLE_AT.x + part.x) * 4;
    assertEquals([...covered.data.subarray(i, i + 4)], [0, 0, 0, 255]);
  }
  assertEquals(coverTitle(covered, area, logo, letters), "covered");
  assertEquals(uncoverTitle(covered, area, logo, letters).data, title.data);
  // Some other art where his letters would be is never painted over.
  put(title, TITLE_AT.x + 21, TITLE_AT.y + 24, [255, 0, 0, 255]);
  assertThrows(
    () => coverTitle(title, area, logo, letters),
    Error,
    "is not geekstar0",
  );
});

Deno.test("the title's letters go black with the grey edge round them", () => {
  // A letter 2x1, white in the logo with the dim grey it fades out through
  // a pixel round it — and his mask's teal a pixel off it, which stays.
  const bar = newRaster(2, 1);
  bar.data.set([255, 255, 255, 255, 255, 255, 255, 255]);
  const letters = { "geek-g": bar, "geek-e": bar, "geek-k": bar };
  const [g] = OVERLAY.parts;
  const logo = newRaster(170, 105);
  for (let y = g.y - 1; y <= g.y + 1; y++) {
    for (let x = g.x - 1; x <= g.x + 2; x++) put(logo, x, y, [13, 13, 13, 255]);
  }
  put(logo, g.x - 1, g.y, [0, 72, 80, 255]);
  put(logo, g.x, g.y, [255, 255, 255, 255]);
  put(logo, g.x + 1, g.y, [255, 255, 255, 255]);
  // Two pixels out is not his edge, grey or not.
  put(logo, g.x + 3, g.y, [13, 13, 13, 255]);
  assert(isLetterEdge(13, 8, 4, 255) && isLetterEdge(50, 50, 50, 255));
  assert(!isLetterEdge(0, 72, 80, 255), "the mask's teal");
  assert(!isLetterEdge(144, 144, 160, 255), "the mask's grey");
  assert(!isLetterEdge(13, 13, 13, 0), "transparent");

  const cover = letterCover(logo, letters);
  const at = (x: number, y: number) => cover[y * 170 + x];
  assertEquals([at(g.x, g.y), at(g.x + 1, g.y)], [1, 1], "the letter");
  assertEquals(at(g.x - 1, g.y - 1), 1, "its edge");
  assertEquals(at(g.x + 2, g.y + 1), 1, "its edge");
  assertEquals(at(g.x - 1, g.y), 0, "the mask");
  assertEquals(at(g.x + 3, g.y), 0, "two out");

  // A title covered before the edge was is covered the rest of the way.
  const area = { x: 0, y: 0, w: 256, h: 300 };
  const title = newRaster(256, 300);
  for (let y = 0; y < 105; y++) {
    title.data.set(
      logo.data.subarray(y * 170 * 4, (y + 1) * 170 * 4),
      ((y + TITLE_AT.y) * 256 + TITLE_AT.x) * 4,
    );
  }
  const half = { ...title, data: title.data.slice() };
  put(half, TITLE_AT.x + g.x, TITLE_AT.y + g.y, [0, 0, 0, 255]);
  put(half, TITLE_AT.x + g.x + 1, TITLE_AT.y + g.y, [0, 0, 0, 255]);
  const covered = coverTitle(half, area, logo, letters);
  assert(covered !== "covered");
  const px = (img: Raster, x: number, y: number) => {
    const i = ((TITLE_AT.y + y) * 256 + TITLE_AT.x + x) * 4;
    return [...img.data.subarray(i, i + 4)];
  };
  assertEquals(px(covered, g.x - 1, g.y - 1), [0, 0, 0, 255]);
  assertEquals(px(covered, g.x - 1, g.y), [0, 72, 80, 255]);
  assertEquals(px(covered, g.x + 3, g.y), [13, 13, 13, 255]);
  assertEquals(coverTitle(covered, area, logo, letters), "covered");
  assertEquals(uncoverTitle(covered, area, logo, letters).data, title.data);
});

Deno.test({
  name: "only Geekstar gets them",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withDb(async (db) => {
      await fetch(`${db.url}/shmupX/levels/gs/bossData/boss0/name.json`, {
        method: "PUT",
        body: JSON.stringify("daltonius"),
      }).then((r) => r.body?.cancel());
      await assertRejects(() => plan(), Error, "is not geekstar");
    });
  },
});

// --------------------------------------------------------------- the runtime

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One top-level `var` of the bundle's IIFE, by name, as source text. */
function varSource(js: string, name: string): string {
  const start = js.indexOf(`\n  var ${name} = `);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  return js.slice(start, js.indexOf(";\n", start) + 2);
}

/** Frame sizes of the stand-in atlas: his frame, the letters, a flame cut. */
const SIZES: Record<string, [number, number]> = {
  geekstar0: [170, 105],
  geekstar5: [170, 105],
  "geek-g": [34, 38],
  "geek-e": [30, 31],
  "geek-k": [29, 37],
  "geekstar0-flame": [17, 18],
  "geekstar5-flame": [17, 18],
};

const FILL = 1;

class Obj {
  x: number;
  y: number;
  width = 0;
  height = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  alpha = 1;
  visible = true;
  active = true;
  depth = 0;
  tintTopLeft = 0xffffff;
  tintMode = 0;
  frame: { name: string } = { name: "" };
  data = new Map<string, unknown>();
  handlers: Record<string, () => void> = {};
  list: Obj[] = [];
  constructor(x: number, y: number, frame?: string) {
    this.x = x;
    this.y = y;
    if (frame) this.setFrame(frame);
  }
  setFrame(name: string) {
    this.frame = { name };
    [this.width, this.height] = SIZES[name];
    return this;
  }
  setOrigin() {
    return this;
  }
  setDepth(d: number) {
    this.depth = d;
    return this;
  }
  setScale(x: number, y: number) {
    this.scaleX = x;
    this.scaleY = y;
    return this;
  }
  setTint(c: number) {
    this.tintTopLeft = c;
    return this;
  }
  setTintMode(m: number) {
    this.tintMode = m;
    return this;
  }
  setAlpha(a: number) {
    this.alpha = a;
    return this;
  }
  setVisible(v: boolean) {
    this.visible = v;
    return this;
  }
  setPosition(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
  getData(k: string) {
    return this.data.get(k);
  }
  setData(k: string, v: unknown) {
    this.data.set(k, v);
    return this;
  }
  add(child: Obj) {
    this.list.push(child);
  }
  remove(child: Obj) {
    this.list = this.list.filter((c) => c !== child);
  }
  once(event: string, fn: () => void) {
    this.handlers[event] = fn;
  }
  destroy() {
    this.active = false;
    this.handlers.destroy?.();
  }
}

function stageScene(frames = Object.keys(SIZES)) {
  const tweens: Json[] = [];
  const timers: Json[] = [];
  const listeners = new Map<string, () => void>();
  const ship = new Obj(128, 400);
  const scene: Json = {
    textures: { get: () => ({ has: (f: string) => frames.includes(f) }) },
    add: {
      sprite: (x: number, y: number, _key: string, f: string) =>
        new Obj(x, y, f),
      container: (x: number, y: number) => new Obj(x, y),
    },
    events: {
      on: (e: string, fn: () => void) => listeners.set(e, fn),
      off: (e: string) => listeners.delete(e),
    },
    time: {
      now: 0,
      addEvent: (cfg: Json) => {
        const t = { ...cfg, removed: false, remove: () => (t.removed = true) };
        timers.push(t);
        return t;
      },
      delayedCall: () => {},
    },
    tweens: { add: (cfg: Json) => tweens.push(cfg), killTweensOf: () => {} },
    enemyBullets: [] as Obj[],
    bossEntering: false,
    theWorldFlg: false,
    ship,
  };
  return { scene, tweens, timers, listeners };
}

async function overlayFns() {
  const js = await read(BUNDLE);
  return new Function(
    "Phaser",
    "aimPlayer",
    "_bossAlive",
    "\nvar resolveFrame = function(scene, key, name) { return name; };\n" +
      functionSource(js, "bulletFramesInAtlas") +
      varSource(js, "OVERLAY_NEON") +
      functionSource(js, "overlayColor") +
      functionSource(js, "bossOverlayParts") +
      functionSource(js, "bossOverlayGlow") +
      functionSource(js, "flashOverlayTint") +
      functionSource(js, "armBossOverlay") +
      functionSource(js, "chargeOverlayShot") +
      functionSource(js, "fireOverlayShot") +
      "\nreturn { armBossOverlay };",
  )(
    { TintModes: { FILL } },
    (scene: Json) => scene.ship,
    (scene: Json) => !!scene.bossSprite && scene.bossSprite.active,
  ) as { armBossOverlay: (scene: Json, boss: Obj, record: Json) => Json };
}

const geekstar = {
  name: "geekstar",
  overlay: {
    ...OVERLAY,
    glow: {
      x: 81,
      y: 16,
      frames: { geekstar0: "geekstar0-flame", geekstar5: "geekstar5-flame" },
    },
  },
};

Deno.test("each letter covers its own, filled black, centred on the logo's", async () => {
  const { armBossOverlay } = await overlayFns();
  const { scene, listeners } = stageScene();
  const boss = new Obj(128, 182.5, "geekstar0");
  scene.bossSprite = boss;
  const state = armBossOverlay(scene, boss, geekstar);
  assert(state);
  // Glow first (under the letters), then G E E K.
  const [lamp, ...letters] = state.box.list as Obj[];
  assertEquals(lamp.visible, false, "no glow until a letter charges");
  assertEquals(letters.map((l) => l.frame.name), [
    "geek-g",
    "geek-e",
    "geek-e",
    "geek-k",
  ]);
  // A part's centre, from the boss's: its top-left in his 170x105 frame plus
  // half itself, less half the frame.
  assertEquals(letters.map((l) => [l.x, l.y]), [
    [21 + 17 - 85, 24 + 19 - 52.5],
    [58 + 15 - 85, 31 + 15.5 - 52.5],
    [90 + 15 - 85, 31 + 15.5 - 52.5],
    [123 + 14.5 - 85, 25 + 18.5 - 52.5],
  ]);
  for (const l of letters) {
    assertEquals([l.tintTopLeft, l.tintMode], [0x000000, FILL]);
  }
  // The container rides on the boss, zoom and all.
  boss.x = 100;
  boss.y = 60;
  boss.scaleX = boss.scaleY = 1.5;
  listeners.get("postupdate")!();
  assertEquals([state.box.x, state.box.y, state.box.scaleX], [100, 60, 1.5]);
});

Deno.test("a letter charges in neon, lights his flame, and leaves aimed", async () => {
  const { armBossOverlay } = await overlayFns();
  const { scene, tweens, timers, listeners } = stageScene();
  const boss = new Obj(128, 182.5, "geekstar5");
  scene.bossSprite = boss;
  const state = armBossOverlay(scene, boss, geekstar);
  assertEquals(timers.length, 1);
  assertEquals(timers[0].delay, OVERLAY.shot.every);

  const random = Math.random;
  Math.random = () => 0.99; // the K
  try {
    timers[0].callback();
  } finally {
    Math.random = random;
  }
  const charge = state.charge as Obj;
  assertEquals(charge.frame.name, "geek-k");
  assertEquals(charge.alpha, 0, "it fades in");
  assertEquals(tweens[0].alpha, 1);
  assertEquals(tweens[0].duration, OVERLAY.shot.chargeMs);
  // A second timer tick while it charges starts nothing.
  timers[0].callback();
  assertEquals(tweens.length, 1);

  // Mid-charge, at the clock's third colour: the letter and the flame of the
  // frame he is in burn the same neon.
  scene.time.now = OVERLAY.shot.flashMs * 2 + 1;
  listeners.get("postupdate")!();
  const neon = parseInt(OVERLAY.shot.colors[2].slice(1), 16);
  const lamp = state.box.list[0] as Obj;
  assertEquals(charge.tintTopLeft, neon);
  assertEquals(
    [lamp.visible, lamp.frame.name, lamp.tintTopLeft],
    [true, "geekstar5-flame", neon],
  );
  assertEquals(
    [lamp.x, lamp.y],
    [81 + 8.5 - 85, 16 + 9 - 52.5],
    "over the flame it was cut from",
  );

  // Full opacity: it leaves the boss as a shot, from where it sat, at the ship.
  charge.alpha = 1;
  tweens[0].onComplete();
  listeners.get("postupdate")!();
  assertEquals(state.charge, null);
  assert(!state.box.list.includes(charge));
  assertEquals(lamp.visible, false, "the flame is his own red again");
  assertEquals(scene.enemyBullets, [charge]);
  assertEquals([charge.x, charge.y], [128 + 52.5, 182.5 - 9]);
  const dx = 128 - charge.x, dy = 400 - charge.y;
  const d = Math.hypot(dx, dy);
  assertAlmostEquals(charge.getData("rotX") as number, dx / d);
  assertAlmostEquals(charge.getData("rotY") as number, dy / d);
  assertEquals(charge.getData("speed"), OVERLAY.shot.speed);
  assert(charge.getData("tints"), "it keeps flashing in flight");
  // The four covers are all still there: the logo never shows.
  assertEquals(state.box.list.length, 5);
});

Deno.test("an atlas without a letter draws no overlay; a dead boss takes his along", async () => {
  const { armBossOverlay } = await overlayFns();
  const bare = stageScene(["geekstar0"]);
  const boss0 = new Obj(128, 182.5, "geekstar0");
  assertEquals(armBossOverlay(bare.scene, boss0, geekstar), null);

  const { scene, timers, listeners } = stageScene();
  const boss = new Obj(128, 182.5, "geekstar0");
  scene.bossSprite = boss;
  const state = armBossOverlay(scene, boss, geekstar);
  boss.destroy();
  assertEquals(state.box.active, false);
  assertEquals(timers[0].removed, true);
  assertEquals(listeners.has("postupdate"), false);
});
