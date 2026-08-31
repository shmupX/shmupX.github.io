// Turning sprites upright as they are packed.
//
// The PS2 port draws every frame axis-aligned: AtlasManager.drawFrame takes no
// angle, and a bullet's `rotation` is only ever used to move it. The base
// game's shot art is drawn side-on (bigProjectile_0.png is a 23x8 horizontal
// streak) because the browser engine rotates a sprite to its heading, so on the
// console shots flew up the screen lying on their side. The exporter turns that
// art a quarter turn at pack time instead.

import { assert, assertEquals } from "@std/assert";
import { buildPs2Atlas, type SourceFrame } from "../lib/ps2/atlas.ts";
import { newRaster } from "../lib/ps2/png.ts";
import { rotateCcw } from "../lib/ps2/raster.ts";

function pixel(r: ReturnType<typeof newRaster>, x: number, y: number) {
  const o = (y * r.width + x) * 4;
  return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]];
}

Deno.test("a quarter turn moves what pointed right to pointing up", () => {
  // A 3x1 strip whose bright end is at the right — a bullet pointing along +x.
  const strip = newRaster(3, 1);
  strip.data.set([10, 0, 0, 255], 0);
  strip.data.set([20, 0, 0, 255], 4);
  strip.data.set([30, 0, 0, 255], 8); // the tip
  const turned = rotateCcw(strip);

  assertEquals(turned.width, 1);
  assertEquals(turned.height, 3);
  // The tip is now at the TOP, which is where a shot travelling up points.
  assertEquals(pixel(turned, 0, 0), [30, 0, 0, 255]);
  assertEquals(pixel(turned, 0, 1), [20, 0, 0, 255]);
  assertEquals(pixel(turned, 0, 2), [10, 0, 0, 255]);
});

Deno.test("four quarter turns are the identity", () => {
  const src = newRaster(5, 3);
  for (let i = 0; i < 15; i++) src.data.set([i, i * 2, i * 3, 255], i * 4);
  const round = rotateCcw(rotateCcw(rotateCcw(rotateCcw(src))));
  assertEquals(round.width, src.width);
  assertEquals(round.height, src.height);
  assertEquals([...round.data], [...src.data]);
});

Deno.test("the packer honours the rotate flag per frame", () => {
  const sheet = newRaster(32, 32);
  for (let i = 0; i < 32 * 32; i++) sheet.data[i * 4 + 3] = 255;
  const entry = (x: number, y: number, w: number, h: number) => ({
    frame: { x, y, w, h },
    rotated: false,
    trimmed: false,
  });
  const frames: SourceFrame[] = [
    // Wide, and asked to be turned: should come out tall.
    { name: "shot.png", sheet, entry: entry(0, 0, 16, 4), rotate: true },
    // Wide, left alone: should stay wide.
    { name: "wing.png", sheet, entry: entry(0, 8, 16, 4) },
  ];
  const built = buildPs2Atlas(frames, "test.png", 512);
  const shot = built.json.frames["shot.png"].frame;
  const wing = built.json.frames["wing.png"].frame;
  assert(shot.h > shot.w, `shot stayed ${shot.w}x${shot.h}`);
  assert(wing.w > wing.h, `wing became ${wing.w}x${wing.h}`);
  // Same pixels either way, just transposed.
  assertEquals(shot.w, wing.h);
  assertEquals(shot.h, wing.w);
});

// --- a Dezaemon save's own title screen ---
//
// mapSaveToGame records the save's drawn TITLE 1/2 and credit strips as
// `dezaemonTitle`: role -> a frame name in the level's atlas. The browser
// runtime hides the stock backdrop and sliding logo when that field is there
// and shows the save's art instead. The PS2 port has no such branch, so the
// exporter arranges the same thing by packing the save's frames under the
// names the port does draw, and leaving the rest out of the sheet — a frame
// that is not in the atlas fails the port's own hasFrame() check.

import {
  dezaemonTitleFrames,
  type IndexedFrame,
  type LevelRecord,
} from "../lib/ps2/assets.ts";

function index(names: string[]): Map<string, IndexedFrame> {
  const sheet = newRaster(64, 64);
  const map = new Map<string, IndexedFrame>();
  for (const name of names) {
    map.set(name, {
      sheet,
      entry: {
        frame: { x: 0, y: 0, w: 8, h: 8 },
        rotated: false,
        trimmed: false,
      },
    });
  }
  return map;
}

Deno.test("a save's title art replaces the stock title screen", () => {
  const record: LevelRecord = {
    dezaemonTitle: {
      title1: "dezaTitle1.gif",
      title2: "dezaTitle2.gif",
      credit: "dezaCredit.gif",
    },
  };
  const notes: string[] = [];
  const { overrides, drop } = dezaemonTitleFrames(
    record,
    index(["dezaTitle1.gif", "dezaTitle2.gif", "dezaCredit.gif"]),
    notes,
  );
  const under = new Map(overrides.map((f) => [f.name, f]));
  assertEquals([...under.keys()].sort(), ["logo.gif", "subTitle.gif"]);
  // The stock backdrop and the sliding "titleG" logo are what the browser
  // hides; here they are simply not packed.
  assert(drop.has("titleG.gif"), "titleG.gif should be dropped");
  assert(drop.has("title_bg"), "title_bg should be dropped");
  assert(notes.some((n) => n.includes("dezaemon title")), "no note");
});

Deno.test("title2 alone still becomes the logo", () => {
  // The browser's `dezaLogo = title1 || title2` — a save that drew only the
  // lower strip still gets it as the logo rather than as a subtitle under
  // nothing.
  const notes: string[] = [];
  const { overrides, drop } = dezaemonTitleFrames(
    { dezaemonTitle: { title2: "dezaTitle2.gif" } },
    index(["dezaTitle2.gif"]),
    notes,
  );
  assertEquals(overrides.map((f) => f.name), ["logo.gif"]);
  assert(drop.has("subTitle.gif"), "there is no subtitle to draw");
});

Deno.test("a level with no save title leaves the stock screen alone", () => {
  const notes: string[] = [];
  const { overrides, drop } = dezaemonTitleFrames({}, index([]), notes);
  assertEquals(overrides.length, 0);
  assertEquals(drop.size, 0);
  assertEquals(notes.length, 0);
});

Deno.test("a role naming a frame the atlas lacks is reported", () => {
  const notes: string[] = [];
  const { overrides, drop } = dezaemonTitleFrames(
    { dezaemonTitle: { title1: "gone.gif", title2: "dezaTitle2.gif" } },
    index(["dezaTitle2.gif"]),
    notes,
  );
  // title1 is missing, so title2 is promoted to the logo slot.
  assertEquals(overrides.map((f) => f.name), ["logo.gif"]);
  assert(drop.has("subTitle.gif"));
  assert(notes[0].includes("title1"), `note did not name title1: ${notes[0]}`);
});
