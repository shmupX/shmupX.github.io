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

// --- one place on the sheet per picture ---
//
// A Dezaemon cart's animations repeat cells: a zako that does not animate is
// still four frames, of one drawing. Packed a frame at a time, Master Arena
// Mod's 447 frames (187 pictures) overflowed the level's sheet and went on at
// half size, where its one-pixel stars were a quarter-opaque smudge.

/** A sheet of 64px cells side by side, each one flat colour of its own. */
function cells(count: number, size = 64) {
  const sheet = newRaster(size * count, size);
  for (let i = 0; i < count; i++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        sheet.data.set(
          [i & 255, 40 + (i >> 8), 200, 255],
          (y * sheet.width + i * size + x) * 4,
        );
      }
    }
  }
  const cell = (i: number) => ({
    frame: { x: i * size, y: 0, w: size, h: size },
  });
  return { sheet, cell };
}

Deno.test("frames that are the same picture share one place on the sheet", () => {
  const { sheet, cell } = cells(2, 32);
  const frames: SourceFrame[] = [
    ...[0, 1, 2, 3].map((n) => ({
      name: `zako_${n}.gif`,
      sheet,
      entry: cell(0),
    })),
    { name: "other_0.gif", sheet, entry: cell(1) },
  ];
  const built = buildPs2Atlas(frames, "test.png", 512);
  // Every name is still a frame the port can ask for.
  assertEquals(
    Object.keys(built.json.frames).sort(),
    frames.map((frame) => frame.name).sort(),
  );
  const place = (name: string) => JSON.stringify(built.json.frames[name].frame);
  assertEquals(
    new Set([0, 1, 2, 3].map((n) => place(`zako_${n}.gif`))).size,
    1,
    "four cells of one drawing took more than one place",
  );
  assert(place("other_0.gif") !== place("zako_0.gif"));
  // And the sheet is the size two pictures need, not five.
  assert(
    built.image.width * built.image.height <= 128 * 64,
    `${built.image.width}x${built.image.height}`,
  );
  // The picture is where the frames say it is.
  const zako = built.json.frames["zako_0.gif"].frame;
  assertEquals(pixel(built.image, zako.x, zako.y), [0, 40, 200, 255]);
  const other = built.json.frames["other_0.gif"].frame;
  assertEquals(pixel(built.image, other.x, other.y), [1, 40, 200, 255]);
});

Deno.test("a cart whose cells repeat keeps full size where it used to halve", () => {
  // Thirty 64px pictures, four frames of each: a frame at a time that is
  // half a million texels, twice what a 512 sheet holds; once each it is an
  // eighth of a megabyte.
  const { sheet, cell } = cells(30);
  const frames: SourceFrame[] = [];
  for (let i = 0; i < 30; i++) {
    for (let n = 0; n < 4; n++) {
      frames.push({ name: `enemy${i}_${n}.gif`, sheet, entry: cell(i) });
    }
  }
  const built = buildPs2Atlas(frames, "test.png", 512);
  assertEquals(built.displayScale, 1);
  assertEquals(Object.keys(built.json.frames).length, 120);
});

Deno.test("a frame turned as it is packed is not the picture it was", () => {
  // The same strip, one copy turned upright for a shot: two pictures.
  const sheet = newRaster(16, 4);
  for (let i = 0; i < 16 * 4; i++) sheet.data.set([9, 9, 9, 255], i * 4);
  const entry = { frame: { x: 0, y: 0, w: 16, h: 4 } };
  const built = buildPs2Atlas(
    [
      { name: "shot.png", sheet, entry, rotate: true },
      { name: "wing.png", sheet, entry },
    ],
    "test.png",
    512,
  );
  const shot = built.json.frames["shot.png"].frame;
  const wing = built.json.frames["wing.png"].frame;
  assertEquals([shot.w, shot.h, wing.w, wing.h], [4, 16, 16, 4]);
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
  coverTitleFrames,
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

Deno.test("a shelf cover becomes the whole title screen", () => {
  // The shelf renders a 256x480 shot of every Dezaemon save's title screen,
  // which is exactly the logical screen the port lays its title scene out in.
  // It goes in as `title_bg`, and everything the stock screen would put on
  // top of it is left out of the sheet.
  const notes: string[] = [];
  const { overrides, drop } = coverTitleFrames(newRaster(256, 480), notes);
  assertEquals(overrides.length, 1);
  assertEquals(overrides[0].name, "title_bg");
  assertEquals(overrides[0].entry.frame, { x: 0, y: 0, w: 256, h: 480 });
  for (const covered of ["titleG.gif", "logo.gif", "subTitle.gif"]) {
    assert(drop.has(covered), `${covered} would sit on top of the shot`);
  }
});

Deno.test("the cover is pre-distorted into the window that survives", () => {
  // `title_bg` is the one frame the title scene draws in raw screen
  // coordinates rather than through the viewport, and the letterbox is then
  // painted over it — so only the middle 96 of its 256 columns are ever seen,
  // stretched 2.5x. A cover dropped in untreated shows as the middle third of
  // itself. It is squeezed into those columns instead, and the port's own
  // stretch undoes the squeeze.
  const cover = newRaster(256, 480);
  for (let i = 0; i < 256 * 480; i++) cover.data.set([9, 9, 9, 255], i * 4);
  const { overrides } = coverTitleFrames(cover, []);
  const framed = overrides[0].sheet;
  assertEquals(framed.width, 256);
  assertEquals(framed.height, 480);

  const columnUsed = (x: number) => {
    for (let y = 0; y < framed.height; y++) {
      if (framed.data[(y * framed.width + x) * 4 + 3] !== 0) return true;
    }
    return false;
  };
  // Padding either side, content in the middle.
  assert(!columnUsed(0), "column 0 should be padding");
  assert(!columnUsed(79), "column 79 should be padding");
  assert(columnUsed(80), "the content should start at column 80");
  assert(columnUsed(175), "the content should reach column 175");
  assert(!columnUsed(176), "column 176 should be padding");
  assert(!columnUsed(255), "column 255 should be padding");
});
