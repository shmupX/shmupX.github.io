// mcp/ builds characters out of the catalog, and two of its contracts are with
// code it cannot import: the frame-key encodings spriteX writes, and the field
// names static/games/2028-ai/game.bundle.js reads. Both are pinned here.
//
// The bundle half matters more than it looks. game.bundle.js is a vendored
// prebuilt artifact carrying hand edits a rebuild would silently drop (see the
// README's list), and the stage-end backdrop below is now one of them — so a
// dropped edit should fail a test rather than quietly stop working in a cart
// nobody plays until later.
//
// Nothing here touches the network: every case is a literal.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { newRaster } from "@shmupx/shmup-harbor/png";
import {
  assertSafeKey,
  decodeFrameKey,
  decodeFrameName,
  decodeKey,
  encodeFrameKey,
  encodeKey,
} from "../mcp/lib/rtdb.ts";
import { type AtlasJson, frameMap, packFrames } from "../mcp/lib/art.ts";
import {
  MAIN_PROJECTILE_KEY,
  PROJECTILE_KEYS,
  referencedFrames,
  remapFrames,
} from "../mcp/lib/character.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const BUNDLE = join(ROOT, "static/games/2028-ai/game.bundle.js");

const rect = (x: number, y: number, w: number, h: number) => ({
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w, h },
  sourceSize: { w, h },
});

Deno.test("the dot encoding round-trips", () => {
  assertEquals(encodeKey("hadouken0.png"), "hadouken0․png");
  assertEquals(decodeKey("hadouken0․png"), "hadouken0.png");
  assertEquals(decodeKey(encodeKey("a.b.c")), "a.b.c");
});

Deno.test("the k_-hex encoding round-trips and leaves other names alone", () => {
  // The real key bg-great-hall's only frame is stored under.
  assertEquals(
    decodeFrameKey("k_00610074006c00610073005f00730030"),
    "atlas_s0",
  );
  assertEquals(
    encodeFrameKey("atlas_s0"),
    "k_00610074006c00610073005f00730030",
  );
  // Idempotent: encoding an already-encoded key must not stack a second layer.
  assertEquals(
    encodeFrameKey("k_00610074006c00610073005f00730030"),
    "k_00610074006c00610073005f00730030",
  );
  // A name that merely starts with k_ is not an encoding.
  assertEquals(decodeFrameKey("k_boss"), "k_boss");
  assertEquals(decodeFrameKey("plain0.png"), "plain0.png");
  // Both encodings at once, outermost first.
  assertEquals(decodeFrameName(encodeFrameKey("boss0.gif")), "boss0.gif");
});

Deno.test("frameMap reads all three atlas layouts", () => {
  const hash = {
    frames: { "a0․png": rect(0, 0, 8, 8) },
  } as unknown as AtlasJson;
  assertEquals(Object.keys(frameMap(hash)), ["a0.png"]);

  const array = {
    frames: [{ filename: "b0.png", ...rect(0, 0, 8, 8) }],
  } as unknown as AtlasJson;
  assertEquals(Object.keys(frameMap(array)), ["b0.png"]);

  // TexturePacker's "Phaser 3" export. Read as a plain map this yields the
  // array indices "0", "1", ... and never matches a real frame name.
  const textures = {
    textures: [{ frames: [{ filename: "c0.png", ...rect(0, 0, 8, 8) }] }],
  } as unknown as AtlasJson;
  assertEquals(Object.keys(frameMap(textures)), ["c0.png"]);
});

Deno.test("frameMap admits frames by shape, not by position", () => {
  // 2028_game_asset really does carry a "comment" holding a section divider
  // among its frames, and __BASE is Phaser's own entry.
  const json = {
    frames: {
      comment: "STAGE BG--------",
      __BASE: rect(0, 0, 1, 1),
      good: rect(0, 0, 8, 8),
      truncated: { frame: { x: 0, y: 0 } },
    },
  } as unknown as AtlasJson;
  assertEquals(Object.keys(frameMap(json)), ["good"]);
});

Deno.test("packFrames lays every frame out without overlapping", () => {
  const frames = [
    { name: "tall", raster: newRaster(10, 40), source: "t", scope: "s" },
    { name: "wide", raster: newRaster(40, 10), source: "w", scope: "s" },
    { name: "small", raster: newRaster(4, 4), source: "s", scope: "s" },
  ];
  const { sheet, json } = packFrames(frames);
  assertEquals(Object.keys(json.frames).sort(), ["small", "tall", "wide"]);

  for (const f of frames) {
    const r = json.frames[f.name].frame;
    assertEquals(r.w, f.raster.width);
    assertEquals(r.h, f.raster.height);
    assert(r.x >= 0 && r.y >= 0, `${f.name} placed off-sheet`);
    assert(
      r.x + r.w <= sheet.width && r.y + r.h <= sheet.height,
      `${f.name} overruns the sheet`,
    );
  }
  const rects = Object.values(json.frames).map((f) => f.frame);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w &&
        a.y < b.y + b.h && b.y < a.y + a.h;
      assert(!overlaps, `frames ${i} and ${j} overlap`);
    }
  }
  assertEquals(json.meta.size, { w: sheet.width, h: sheet.height });
});

Deno.test("referencedFrames walks every slot the runtime reads", () => {
  const names = referencedFrames({
    anim: { idle: ["i0.gif"], attack: ["a0.gif"], _authoring: ["skip.gif"] },
    bulletDataA: { texture: ["pa.gif"] },
    projectileDataB: { texture: ["pb.gif"] },
    dezaemon: { partArt: { "37": ["part.gif"] }, coreArt: ["core.gif"] },
    texture: ["top.gif"],
    stageBgEnd: "end.png",
  });
  assertEquals(
    names.sort(),
    [
      "a0.gif",
      "core.gif",
      "end.png",
      "i0.gif",
      "pa.gif",
      "part.gif",
      "pb.gif",
      "top.gif",
    ],
  );
  // Keys starting with "_" are authoring notes, not art — the editor's own
  // collector skips them and so must this.
  assert(!names.includes("skip.gif"));

  // The {texture, frame} spelling of stageBgEnd names art too, with or without
  // an alpha beside it — and an alpha on its own names no art at all.
  assertEquals(
    referencedFrames({ stageBgEnd: { texture: "game_asset", frame: "x.png" } }),
    ["x.png"],
  );
  assertEquals(
    referencedFrames({ stageBgEnd: { frame: "x.png", alpha: 0.45 } }),
    ["x.png"],
  );
  assertEquals(referencedFrames({ stageBgEnd: { alpha: 0.45 } }), []);
});

Deno.test("a key that could walk the URL is refused", () => {
  assertThrows(() => assertSafeKey("Atlas name", "../atlases/game_asset"));
  assertThrows(() => assertSafeKey("Atlas name", "a/b"));
  assertThrows(() => assertSafeKey("Atlas name", "has.dot"));
  assertSafeKey("Atlas name", "bg-great-hall");
  assertSafeKey("Atlas name", "2028_game_asset");
});

Deno.test("the projectile slots stay in step with the bundle", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  const block = src.match(/var BOSS_PROJECTILE_KEYS = \[([\s\S]*?)\]/);
  assert(block, "BOSS_PROJECTILE_KEYS is gone from game.bundle.js");
  const inBundle = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(
    [...PROJECTILE_KEYS].sort(),
    inBundle.sort(),
    "mcp/lib/character.ts and the runtime disagree about the projectile slots",
  );
});

Deno.test("the main projectile is the slot the runtime actually fires", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  // bossWeapon() is the Dezaemon path's only weapon resolver, and it reads the
  // suffixed slots exclusively — which is why bulletData is the wrong answer.
  assert(
    src.includes("scene.bossProjDataA"),
    "the runtime no longer reads bossProjDataA",
  );
  assertEquals(MAIN_PROJECTILE_KEY, "bulletDataA");
});

Deno.test("the stage-end backdrop override is still wired into the bundle", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  assert(
    src.includes("function resolveStageBgEnd("),
    "resolveStageBgEnd is gone — a rebuild of the vendored bundle dropped it",
  );
  assert(
    src.includes(
      "var bgEnd = resolveStageBgEnd(this, stageId, bgEndSuffix + assetStage)",
    ),
    "resolveStageBgEnd is no longer called where stageEndBg is created",
  );
  // The whole reason it resolves eagerly: .height is measured on the next line.
  assert(
    src.includes("this.stageEndBg.y = -this.stageEndBg.height"),
    "the stage-end backdrop no longer measures its own height",
  );
  assert(
    src.includes("rec.stageBgEnd"),
    "the boss record's stageBgEnd is not read",
  );
});
Deno.test("the backdrop's opacity is read and applied", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  // `opacity` is accepted as a synonym, since that is what an author says.
  assert(
    src.includes('typeof spec.alpha === "number" ? spec.alpha : spec.opacity'),
    "stageBgEnd no longer reads alpha/opacity",
  );
  assert(
    src.includes(
      "if (bgEnd.alpha !== null) this.stageEndBg.setAlpha(bgEnd.alpha)",
    ),
    "the resolved alpha is never applied to the backdrop",
  );
  // Applied BEFORE the height is measured and the object hidden, so the alpha
  // is part of the object's initial state rather than a later mutation.
  const applyAt = src.indexOf("this.stageEndBg.setAlpha(bgEnd.alpha)");
  const measureAt = src.indexOf("this.stageEndBg.y = -this.stageEndBg.height");
  assert(
    applyAt > 0 && measureAt > applyAt,
    "alpha is applied after the measure",
  );
});

Deno.test("remapFrames rewrites every slot referencedFrames collects", () => {
  const record = {
    anim: { idle: ["a.gif"], _note: ["a.gif"] },
    bulletDataA: { texture: ["a.gif", "keep.png"] },
    dezaemon: { partArt: { "37": ["a.gif"] }, coreArt: ["a.gif"] },
    texture: ["a.gif"],
    stageBgEnd: { frame: "a.gif", alpha: 0.45 },
  };
  const out = remapFrames(record, { "a.gif": "a.png" }) as typeof record;

  assertEquals(out.anim.idle, ["a.png"]);
  assertEquals(out.bulletDataA.texture, ["a.png", "keep.png"]);
  assertEquals(out.dezaemon.partArt["37"], ["a.png"]);
  assertEquals(out.dezaemon.coreArt, ["a.png"]);
  assertEquals(out.texture, ["a.png"]);
  assertEquals(out.stageBgEnd, { frame: "a.png", alpha: 0.45 });
  // Authoring keys are not art and are left alone, as elsewhere.
  assertEquals(out.anim._note, ["a.gif"]);
  // The source is not mutated.
  assertEquals(record.anim.idle, ["a.gif"]);

  // The bare-string spelling of stageBgEnd is rewritten too.
  assertEquals(
    (remapFrames({ stageBgEnd: "a.gif" }, { "a.gif": "a.png" }) as {
      stageBgEnd: string;
    })
      .stageBgEnd,
    "a.png",
  );
  // Nothing to rename is a faithful copy.
  assertEquals(remapFrames(record, {}), record);
});

Deno.test("a placed record must be renamed, not left to runtime aliasing", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  // mergeRecipe's repair pass is why remapFrames exists: it tests the FIRST
  // frame of each anim against the merged atlas EXACTLY, with none of
  // resolveFrame's .gif/.png forgiveness, and reverts the whole record to the
  // base game's boss when it misses. A placed record naming the other
  // extension loses its art to 2028.Ai's Bison.
  assert(
    src.includes("!atlasFrames[fbAnim[0]]"),
    "mergeRecipe no longer repairs anim against the atlas — recheck remapFrames",
  );
  assert(
    src.includes("fb.anim[ak] = lb.anim[ak]"),
    "mergeRecipe no longer reverts to the base record on a miss",
  );
});
