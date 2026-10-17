// A game's own UI art on the disc.
//
// The editor's Atlas Manager carries a replaced game_ui frame — titleG.gif,
// the wordmark the title slides in — as `uiAtlases.game_ui`, and the browser
// stacks it onto game_ui. The exporter read the level atlas alone, so a disc
// kept 2028.Ai's wordmark whatever the game had put there. An older record
// (the cloud game "contra") carries the frame in its level atlas instead,
// which the browser lifts onto game_ui by name; the disc has to do the same.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type LevelRecord,
  PORT_UI_FRAMES,
  portDrawsUi,
  stageAssets,
  type StagedFile,
  uiAtlasFrames,
} from "../lib/ps2/assets.ts";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import type { FrameEntry } from "../lib/ps2/atlas.ts";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "../lib/ps2/png.ts";
import { repoRoot } from "../lib/repo-root.ts";

const GAME_DIR = join(repoRoot(), "static", "games", "2028-ai");
const decoder = new TextDecoder();

function solid(w: number, h: number, rgba: number[]): Raster {
  const r = newRaster(w, h);
  for (let i = 0; i < w * h; i++) r.data.set(rgba, i * 4);
  return r;
}

async function dataUrl(raster: Raster): Promise<string> {
  const bytes = await encodePng(raster);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return "data:image/png;base64," + btoa(binary);
}

const rect = (x: number, y: number, w: number, h: number): FrameEntry => ({
  frame: { x, y, w, h },
});

const BASE = {
  asset: new Set(["player00.gif"]),
  ui: new Set(["titleG.gif", "logo.gif"]),
};

Deno.test("a set's game_ui frame replaces the base one, under its name", async () => {
  const sheet = solid(40, 12, [255, 0, 255, 255]);
  const notes: string[] = [];
  const frames = await uiAtlasFrames(
    {
      uiAtlases: {
        game_ui: {
          imageDataURL: await dataUrl(sheet),
          frames: {
            // The other spelling still lands on the port's titleG.gif.
            "titleG․png": rect(0, 0, 40, 12),
            // No slot on the base sheet: the port never asks for it.
            "banner․gif": rect(0, 0, 8, 8),
          },
        },
        title_ui: { frames: { "playBtnPc0․gif": rect(0, 0, 8, 8) } },
      },
    },
    null,
    BASE,
    notes,
  );
  assertEquals(frames.map((f) => f.name), ["titleG.gif"]);
  assertEquals(frames[0].entry.frame, { x: 0, y: 0, w: 40, h: 12 });
  assertEquals(frames[0].sheet.width, 40);
  assert(
    notes.some((n) => n.includes("never draws") && n.includes("banner.gif")),
  );
  assert(notes.some((n) => n.startsWith("title_ui: 1 frame(s) left out")));
});

Deno.test("a UI frame an older save left in the level atlas goes to game_ui", async () => {
  // contra's shape: the ship's frames and the wordmark, in one level sheet.
  const level = {
    sheet: newRaster(64, 32),
    frames: {
      "player00․gif": rect(0, 0, 24, 24),
      "titleG․gif": rect(24, 0, 40, 12),
    },
  };
  const notes: string[] = [];
  const frames = await uiAtlasFrames({}, level, BASE, notes);
  assertEquals(frames.map((f) => f.name), ["titleG.gif"]);
  assert(frames[0].sheet === level.sheet);
  assertEquals(frames[0].entry.frame, { x: 24, y: 0, w: 40, h: 12 });
  assert(notes.some((n) => n.includes("from its level atlas")));
});

Deno.test("the record's own set wins over the level atlas's copy", async () => {
  const own = solid(50, 9, [0, 255, 0, 255]);
  const frames = await uiAtlasFrames(
    {
      uiAtlases: {
        game_ui: {
          imageDataURL: await dataUrl(own),
          frames: { "titleG․gif": rect(0, 0, 50, 9) },
        },
      },
    },
    { sheet: newRaster(64, 32), frames: { "titleG․gif": rect(0, 0, 40, 12) } },
    BASE,
    [],
  );
  assertEquals(frames.length, 1);
  assertEquals(frames[0].entry.frame, { x: 0, y: 0, w: 50, h: 9 });
});

function parse(files: StagedFile[], path: string) {
  const file = files.find((entry) => entry.path === path);
  assert(file, `the export did not stage ${path}`);
  return JSON.parse(decoder.decode(file.data));
}

async function stagedPixel(files: StagedFile[], name: string) {
  const atlas = parse(files, "assets/game_ui.json");
  const entry = atlas.frames[name];
  assert(entry, `${name} is not on the staged game_ui`);
  const sheet = await decodePng(
    new Uint8Array(
      files.find((file) => file.path === "assets/game_ui.png")!.data,
    ),
  );
  const x = entry.frame.x + (entry.frame.w >> 1);
  const y = entry.frame.y + (entry.frame.h >> 1);
  const o = (y * sheet.width + x) * 4;
  return {
    entry,
    scale: atlas.meta.ps2DisplayScale,
    rgba: [...sheet.data.subarray(o, o + 4)],
  };
}

Deno.test("the disc's game_ui carries the game's own wordmark", async () => {
  const wordmark = solid(128, 64, [255, 0, 255, 255]);
  const record: LevelRecord = {
    name: "ui-art",
    uiAtlases: {
      game_ui: {
        imageDataURL: await dataUrl(wordmark),
        frames: { "titleG․gif": rect(0, 0, 128, 64) },
      },
    },
  };
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  const { entry, scale, rgba } = await stagedPixel(staged.files, "titleG.gif");
  // The game's 128x64 plate, not the stock 256x364 one, at the sheet's scale.
  assertEquals(entry.frame.w * scale, 128);
  assertEquals(entry.frame.h * scale, 64);
  assertEquals(rgba, [255, 0, 255, 255]);
  const frames = parse(staged.files, "assets/game_ui.json").frames;
  // The rest of what the port draws is still there...
  assert(frames["continueTitle.gif"]);
  // ...but not the 2019 logo and tagline the port centres on G's plate: they
  // would print across the game's own art (gs's Geek Squad badge).
  assertEquals(frames["logo.gif"], undefined);
  assertEquals(frames["subTitle.gif"], undefined);
  assert(staged.notes.some((n) => n.includes("game's own art — titleG.gif")));
  assert(
    staged.notes.some((n) =>
      n.includes("stock logo.gif and subTitle.gif left out")
    ),
  );
});

Deno.test("a logo of the game's own still goes up over its own G", async () => {
  const record: LevelRecord = {
    name: "ui-art",
    logoDataURL: await dataUrl(solid(200, 40, [0, 255, 255, 255])),
    uiAtlases: {
      game_ui: {
        imageDataURL: await dataUrl(solid(128, 64, [255, 0, 255, 255])),
        frames: { "titleG․gif": rect(0, 0, 128, 64) },
      },
    },
  };
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  const { rgba } = await stagedPixel(staged.files, "logo.gif");
  // The 256-wide plate is flush left, so its centre is the upload's cyan
  // (give or take the sheet's palette), not the stock red 2019.
  assert(
    rgba[0] < 16 && rgba[1] > 240 && rgba[2] > 240 && rgba[3] === 255,
    `logo.gif is ${rgba}, not the upload`,
  );
  const frames = parse(staged.files, "assets/game_ui.json").frames;
  assert(frames["titleG.gif"]);
  assertEquals(frames["subTitle.gif"], undefined);
});

Deno.test("a game that flies its own ship idles it where G stood on the continue card", async () => {
  // gs's shape: one 32x50 ship frame in the level atlas.
  const record: LevelRecord = {
    name: "own-ship",
    atlasImageDataURL: await dataUrl(solid(32, 50, [0, 255, 0, 255])),
    atlasFrames: { "bby-ship": rect(0, 0, 32, 50) },
    playerData: { texture: ["bby-ship"] },
  };
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  for (const face of ["continueFace0.gif", "continueFace1.gif"]) {
    // G's 100x131 box, the ship centred in it: green, not G.
    const { entry, scale, rgba } = await stagedPixel(staged.files, face);
    assertEquals(entry.frame.w * scale, 100);
    assertEquals(rgba, [0, 255, 0, 255]);
  }
  assert(
    staged.notes.some((n) =>
      n.includes("own ship (bby-ship) where G stood, at 2x")
    ),
  );
});

Deno.test("a recipe that restates the base player keeps G on the continue card", async () => {
  const stock = JSON.parse(
    await Deno.readTextFile(join(GAME_DIR, "assets", "game.json")),
  );
  const staged = await stageAssets({
    gameDir: GAME_DIR,
    record: { playerData: { texture: stock.playerData.texture } },
  });
  const { rgba } = await stagedPixel(staged.files, "continueFace0.gif");
  assert(rgba[3] > 0, "G's face is missing");
  assertEquals(staged.notes.filter((n) => n.startsWith("continue:")), []);
});

Deno.test("game_ui carries only what the port draws, at full size", async () => {
  const staged = await stageAssets({ gameDir: GAME_DIR, record: {} });
  const ui = parse(staged.files, "assets/game_ui.json");
  for (const name of Object.keys(ui.frames)) {
    assert(PORT_UI_FRAMES.has(name), `${name} is packed but never drawn`);
  }
  // The stock title's three 256-wide plates and G, and the continue card,
  // on the one-doubling sheet at 1:1 — they packed at 1/4 among the rest.
  assertEquals(ui.meta.ps2DisplayScale, 1);
  assert(ui.meta.size.w * ui.meta.size.h <= 512 * 1024);
  assertEquals(ui.frames["titleG.gif"].frame.w, 256);
});

Deno.test("a game's own frame the port never draws stays off the disc", async () => {
  const record: LevelRecord = {
    uiAtlases: {
      game_ui: {
        imageDataURL: await dataUrl(solid(64, 45, [255, 0, 255, 255])),
        frames: { "hudBg0․gif": rect(0, 0, 64, 45) },
      },
    },
  };
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  assertEquals(
    parse(staged.files, "assets/game_ui.json").frames["hudBg0.gif"],
    undefined,
  );
  assert(
    staged.notes.some((n) => n.includes("never draws") && n.includes("hudBg0")),
  );
});

Deno.test("the port asks game_ui for nothing the disc leaves out", async () => {
  const cache = join(repoRoot(), "build", "ps2", ".cache");
  try {
    await Deno.stat(join(cache, "main.js"));
  } catch {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const js = decoder.decode(await buildRuntimeBundle(repoRoot(), cache));
  // Every name it passes game_ui as a literal...
  const asked = [...js.matchAll(/"game_ui", "([^"]+)"/g)].map((m) => m[1]);
  // ...and every stock game_ui name that appears in it at all, which is how
  // one it picks at run time (`faceFrame`) shows up.
  const stock = JSON.parse(
    await Deno.readTextFile(join(GAME_DIR, "assets", "game_ui.json")),
  ).frames as Record<string, unknown>;
  const named = Object.keys(stock).filter((name) => js.includes(`"${name}"`));
  assert(asked.length > 0, "the bundle draws nothing from game_ui?");
  for (const name of new Set([...asked, ...named])) {
    if (name.endsWith(".png")) continue; // the files the sheets load from
    assert(portDrawsUi(name), `the port draws game_ui's ${name}`);
  }
  // The one it builds by concatenation.
  assert(js.includes(`"stage_loop" + `), "stage_loop is no longer built so");
});

Deno.test("a stock G keeps the stock logo and subtitle on it", async () => {
  const staged = await stageAssets({ gameDir: GAME_DIR, record: {} });
  const frames = parse(staged.files, "assets/game_ui.json").frames;
  for (const plate of ["titleG.gif", "logo.gif", "subTitle.gif"]) {
    assert(frames[plate], `${plate} is missing from the stock title`);
  }
});

Deno.test("a cover still covers the game's wordmark", async () => {
  const record: LevelRecord = {
    name: "ui-art",
    uiAtlases: {
      game_ui: {
        imageDataURL: await dataUrl(solid(128, 64, [255, 0, 255, 255])),
        frames: { "titleG․gif": rect(0, 0, 128, 64) },
      },
    },
  };
  const staged = await stageAssets({
    gameDir: GAME_DIR,
    record,
    cover: newRaster(256, 480),
  });
  // The shot is the whole title; nothing the browser would hide sits on it.
  assertEquals(
    parse(staged.files, "assets/game_ui.json").frames["titleG.gif"],
    undefined,
  );
  assert(
    staged.notes.some((n) => n.includes("the title screen puts its own art")),
  );
});
