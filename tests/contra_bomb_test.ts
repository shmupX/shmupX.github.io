// The bomb's emblem: Contra's winged eagle on the SP button and the bomb drop.
//
// The cart writer gives a bomb item no letter — F, S, R and B are the shot
// levels and the barrier — and draws its stand-in instead (game-to-save.js
// itemIcon: a 12x12 box with its corners off and a glint, in the type's
// colour). A web game exported to the SAVE SHELF came back with that square
// as its bomb pickup, and the runtime, which dresses the SP button in a
// cart's own bomb icon (dezaSpFaces), wore the orange box on the button too.
// The runtime (game.bundle.js, a vendored artifact patched by hand — README)
// now knows the writer's square by its silhouette, as it knows its own
// winged letters, and puts the eagle in its place on the button and on the
// drop. An author's own bomb icon is kept.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { itemIcon } from "../packages/shmup-engine/src/write/game-to-save.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const STRIP = "static/games/2028-ai/assets/img/contraBomb.png";

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

/** One method of a class in the bundle, by name, as source text. */
function methodSource(js: string, name: string, after: string): string {
  const from = js.indexOf(after);
  assert(from >= 0, `no ${after} in ${BUNDLE}`);
  const start = js.indexOf(`\n    ${name}(`, from);
  assert(start >= 0, `no ${name}() after ${after}`);
  const end = js.indexOf("\n    }\n", start);
  assert(end > start, `${name}() does not close`);
  return js.slice(start, end + 6);
}

/** A PNG's width and height, off its IHDR. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) assert(bytes[i] === sig[i], "not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertEquals(String.fromCharCode(...bytes.slice(12, 16)), "IHDR");
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

const CONSTANTS = `
  var CONTRA_BOMB_KEY = "contraBomb";
  var CONTRA_BOMB_W = 24;
  var CONTRA_BOMB_H = 15;
  var CONTRA_BOMB_FRAMES = 4;
  var CONTRA_BOMB_ZOOM = 2;
  var SP_FACE_ICON_ZOOM = 3;
`;

/** The alpha mask of a 16x16 RGBA frame, the shape frameAlphaMask hands back. */
function maskOf(frame: { w: number; h: number; rgba: Uint8Array }) {
  const data = new Uint8Array(frame.w * frame.h);
  for (let i = 0; i < data.length; i++) {
    data[i] = frame.rgba[i * 4 + 3] > 0 ? 1 : 0;
  }
  return { data, width: frame.w, height: frame.h };
}

Deno.test("the strip is four 24x15 frames, and the boot loads it as the contraBomb sheet", async () => {
  const js = await read(BUNDLE);
  const png = await Deno.readFile(new URL(`../${STRIP}`, import.meta.url));
  assertEquals(pngSize(png), { width: 96, height: 15 });
  for (const line of CONSTANTS.trim().split("\n").slice(0, 4)) {
    assert(js.includes(line.trim()), `${line.trim()} is not in the bundle`);
  }
  assert(
    js.includes(
      'this.load.spritesheet(CONTRA_BOMB_KEY, "assets/img/contraBomb.png", { frameWidth: CONTRA_BOMB_W, frameHeight: CONTRA_BOMB_H });',
    ),
    "the boot does not load the eagle",
  );
});

Deno.test("isWriterItemSquare knows the writer's stand-in by its silhouette, whatever its colour", async () => {
  const js = await read(BUNDLE);
  const isSquare = new Function(
    functionSource(js, "isWriterItemSquare") + "\nreturn isWriterItemSquare;",
  )() as (scene: unknown, frame: string) => boolean;
  const masks: Record<string, ReturnType<typeof maskOf> | null> = {};
  const scene = {
    frameAlphaMask: (_key: string, f: string) => masks[f] ?? null,
  };
  // Every type's square — the bomb's orange one included — is the one shape.
  for (let type = 0; type <= 8; type++) {
    masks[`item${type}`] = maskOf(itemIcon(type));
    assert(
      isSquare(scene, `item${type}`),
      `type ${type}'s square is not known`,
    );
  }
  // A full cell, a hollow box, a shifted box, another size: an author's art.
  const full = maskOf(itemIcon(5));
  full.data.fill(1);
  masks.full = full;
  assertStrictEquals(isSquare(scene, "full"), false);
  const hollow = maskOf(itemIcon(5));
  hollow.data[7 * 16 + 7] = 0;
  masks.hollow = hollow;
  assertStrictEquals(isSquare(scene, "hollow"), false);
  const shifted = maskOf(itemIcon(5));
  shifted.data[2 * 16 + 1] = 1;
  masks.shifted = shifted;
  assertStrictEquals(isSquare(scene, "shifted"), false);
  masks.wide = { data: new Uint8Array(26 * 15).fill(1), width: 26, height: 15 };
  assertStrictEquals(isSquare(scene, "wide"), false);
  // No pixels to read (a tainted source): not ours.
  masks.none = null;
  assertStrictEquals(isSquare(scene, "none"), false);
});

type Icon = { texture: string; frame: string | number; zoom?: number };

Deno.test("dezaSpFaces wears the eagle over the writer's square, in four colours, and keeps an author's icon", async () => {
  const js = await read(BUNDLE);
  const run = (opts: { eagleLoaded: boolean; square: boolean }) => {
    const drawn: { key: string; icon: Icon; lit: boolean }[] = [];
    const textures = new Set<string>(opts.eagleLoaded ? ["contraBomb"] : []);
    const scene = {
      textures: { exists: (k: string) => textures.has(k) },
      frameAlphaMask: () => null,
    };
    const dezaSpFaces = new Function(
      "drawn",
      "textures",
      CONSTANTS +
        "var dezaSpIconFrame = function() { return 'bombIcon.gif'; };" +
        `var isWriterItemSquare = function() { return ${opts.square}; };` +
        "var drawSpFace = function(scene, key, icon, lit) { drawn.push({ key: key, icon: icon, lit: lit }); textures.add(key); return true; };" +
        functionSource(js, "contraBombFace") +
        functionSource(js, "dezaSpFaces") +
        "\nreturn dezaSpFaces;",
    )(drawn, textures) as (scene: unknown) => {
      full: string;
      empty: string;
      frames: string[] | null;
    } | null;
    return {
      faces: dezaSpFaces(scene),
      drawn,
      again: () => dezaSpFaces(scene),
    };
  };

  // The writer's square, the eagle loaded: four lit faces and one spent one.
  const eagle = run({ eagleLoaded: true, square: true });
  assert(eagle.faces);
  assertEquals(eagle.faces.frames, [
    "dezaSpFull:contraBomb:0",
    "dezaSpFull:contraBomb:1",
    "dezaSpFull:contraBomb:2",
    "dezaSpFull:contraBomb:3",
  ]);
  assertEquals(eagle.faces.full, "dezaSpFull:contraBomb:0");
  assertEquals(eagle.faces.empty, "dezaSpEmpty:contraBomb");
  assertEquals(eagle.drawn.length, 5);
  for (let i = 0; i < 4; i++) {
    assertEquals(eagle.drawn[i], {
      key: `dezaSpFull:contraBomb:${i}`,
      icon: { texture: "contraBomb", frame: i, zoom: 2 },
      lit: true,
    });
  }
  assertEquals(eagle.drawn[4], {
    key: "dezaSpEmpty:contraBomb",
    icon: { texture: "contraBomb", frame: 0, zoom: 2 },
    lit: false,
  });
  // Drawn once: the next stage finds the set and draws nothing.
  assertEquals(eagle.again(), eagle.faces);
  assertEquals(eagle.drawn.length, 5);

  // An author's own icon: the one still, at the cell's zoom, no cycle.
  const own = run({ eagleLoaded: true, square: false });
  assert(own.faces);
  assertStrictEquals(own.faces.frames, null);
  assertEquals(own.faces.full, "dezaSpFull:bombIcon.gif");
  assertEquals(own.drawn.map((d) => d.icon), [
    { texture: "game_asset", frame: "bombIcon.gif" },
    { texture: "game_asset", frame: "bombIcon.gif" },
  ]);

  // The eagle not loaded: the square it came with, as before.
  const bare = run({ eagleLoaded: false, square: true });
  assert(bare.faces);
  assertStrictEquals(bare.faces.frames, null);
  assertEquals(bare.faces.full, "dezaSpFull:bombIcon.gif");
});

Deno.test("the button cycles the eagle's colours while a bomb is in stock, and the drop flaps it", async () => {
  const js = await read(BUNDLE);
  // create() carries a four-space closer of its own, so it is read whole:
  // these two lines are nowhere else in the bundle.
  assert(
    js.includes(
      "this.spFaceFrames = spFaces && spFaces.frames ? spFaces.frames : null;",
    ),
    "create() does not keep the eagle's faces",
  );
  assert(
    js.includes(
      "this.time.addEvent({ delay: CONTRA_BOMB_FRAME_MS, loop: true, callback: this.cycleSpFace, callbackScope: this });",
    ),
    "create() starts no clock for the cycle",
  );
  const cycle = methodSource(js, "cycleSpFace", "var PhaserGameScene = class");
  assert(
    cycle.includes(
      "if (!this.spBtnReadyBg || this.spBtnReadyBg.alpha < 1) return;",
    ),
    "the cycle runs on an empty meter",
  );
  assert(
    cycle.includes(
      "this.spBtnBar.setTexture(this.spFaceFrames[this.spFaceFrame]);",
    ),
  );
  assert(
    cycle.includes("this.updateSpGauge();"),
    "the crop is not laid back over the new face",
  );
  // The drop: the writer's square on the bomb drop, and nothing else, flies
  // the eagle; an author's icon and the stock art do not.
  const drop = methodSource(js, "dropItem", "var PhaserGameScene = class");
  assert(
    drop.includes(
      'var eagle = itemName === "dezaSp" && usingOwn && !ownItems &&\n        this.textures.exists(CONTRA_BOMB_KEY) && isWriterItemSquare(this, own);',
    ),
    "the drop does not know the writer's square",
  );
  assert(drop.includes("item = this.add.sprite(x, y, CONTRA_BOMB_KEY, 0);"));
  assert(
    drop.includes('if (!item && letter && this.textures.exists("powerups")) {'),
    "a letter would draw over the eagle",
  );
});
