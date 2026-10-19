// The title editor's uploads on the disc.
//
// The browser puts a game's `logoDataURL`, `subTitleDataURL` and
// `titleBgDataURL` up as its title logo, subtitle and backdrop. The PS2
// exporter read none of them, so a disc showed 2028.Ai's logo over the port's
// flat purple fill whatever the game had uploaded. The port draws
// `logo.gif`, `subTitle.gif` and `title_bg` from game_ui, so each upload has
// to be packed there under that name, framed to land where the browser shows
// it.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type LevelRecord,
  stageAssets,
  type StagedFile,
  titleUploadFrames,
} from "../lib/ps2/assets.ts";
import { encodePng, newRaster, type Raster } from "../lib/ps2/png.ts";
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

function pixel(r: Raster, x: number, y: number) {
  const o = (y * r.width + x) * 4;
  return [...r.data.subarray(o, o + 4)];
}

const MAGENTA = [255, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

Deno.test("the logo and subtitle go up as the port's plates, flush left", async () => {
  // A plate narrower than the screen: the browser rests it with its left edge
  // at 0 (its centre at half its own width), and the port centres a 256-wide
  // plate, so the upload sits at the left of one.
  const notes: string[] = [];
  const { overrides, drop } = await titleUploadFrames({
    logoDataURL: await dataUrl(solid(100, 40, MAGENTA)),
    subTitleDataURL: await dataUrl(solid(256, 20, MAGENTA)),
  }, notes);
  assertEquals(drop.size, 0);
  const byName = new Map(overrides.map((f) => [f.name, f]));
  assertEquals([...byName.keys()].sort(), ["logo.gif", "subTitle.gif"]);

  const logo = byName.get("logo.gif")!;
  assertEquals([logo.sheet.width, logo.sheet.height], [256, 40]);
  assertEquals(logo.entry.frame, { x: 0, y: 0, w: 256, h: 40 });
  assertEquals(pixel(logo.sheet, 5, 20), MAGENTA);
  assertEquals(pixel(logo.sheet, 99, 20), MAGENTA);
  assertEquals(pixel(logo.sheet, 100, 20), CLEAR);
  // A stock-width upload comes out exactly as it went in.
  const sub = byName.get("subTitle.gif")!;
  assertEquals([sub.sheet.width, sub.sheet.height], [256, 20]);
  assertEquals(pixel(sub.sheet, 255, 10), MAGENTA);
  assert(notes.some((n) => n.includes("logo 100x40, subtitle 256x20")));
});

Deno.test("the backdrop fills the screen the browser shows, squeezed for the port", async () => {
  // 64x64 tiles across the 256x480 screen as the browser's tileSprite does;
  // the port stretches title_bg 2.5x across the 640 and the letterbox keeps
  // only the middle, so the screen is squeezed into the columns that survive.
  const notes: string[] = [];
  const { overrides } = await titleUploadFrames({
    titleBgDataURL: await dataUrl(solid(64, 64, MAGENTA)),
  }, notes);
  assertEquals(overrides.map((f) => f.name), ["title_bg"]);
  const bg = overrides[0].sheet;
  assertEquals([bg.width, bg.height], [256, 480]);
  // The visible window is columns 80..175: filled, top to bottom.
  for (const y of [0, 240, 479]) {
    assertEquals(pixel(bg, 80, y), MAGENTA, `x 80, y ${y}`);
    assertEquals(pixel(bg, 175, y), MAGENTA, `x 175, y ${y}`);
  }
  // Either side of it is what the letterbox paints over.
  assertEquals(pixel(bg, 10, 240), CLEAR);
  assertEquals(pixel(bg, 250, 240), CLEAR);
  assert(notes.some((n) => n.includes("backdrop 64x64 tiled")));
});

Deno.test("an upload with no decoder here leaves the stock plate, and says so", async () => {
  const notes: string[] = [];
  const { overrides } = await titleUploadFrames({
    logoDataURL: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==",
  }, notes);
  assertEquals(overrides, []);
  assert(
    notes.some((n) => n.includes("logo upload is image/jpeg")),
    notes.join("\n"),
  );

  // Nor does a broken one fail the build: it is title decoration.
  const broken: string[] = [];
  const kept = await titleUploadFrames({
    titleBgDataURL: "data:image/png;base64,iVBORw0KGgo=",
    subTitleDataURL: "data:image/png;base64,***",
  }, broken);
  assertEquals(kept.overrides, []);
  assertEquals(
    broken.filter((n) => n.includes("upload is unreadable")).length,
    2,
    broken.join("\n"),
  );
});

function parse(files: StagedFile[], path: string) {
  const file = files.find((entry) => entry.path === path);
  assert(file, `the export did not stage ${path}`);
  return JSON.parse(decoder.decode(file.data));
}

Deno.test("the game this repo ships takes its own title onto the disc", async () => {
  // Its logo is a GIF, its subtitle a PNG and its backdrop an 845x480 PNG:
  // rando's gold 2028 redrawn to tile (scripts/2028-ai/draw_2028_backdrop.py).
  const record = JSON.parse(
    await Deno.readTextFile(join(GAME_DIR, "foo.json")),
  ) as LevelRecord;
  const staged = await stageAssets({ gameDir: GAME_DIR, record });
  const ui = parse(staged.files, "assets/game_ui.json");
  const scale = ui.meta.ps2DisplayScale;
  const size = (name: string) => {
    const f = ui.frames[name];
    assert(f, `${name} is not on the staged game_ui`);
    return [f.frame.w * scale, f.frame.h * scale];
  };
  assertEquals(size("title_bg"), [256, 480]);
  assertEquals(size("logo.gif"), [256, 91]);
  assertEquals(size("subTitle.gif"), [256, 20]);
  // game_ui holds only what the port draws, so all of it — backdrop too —
  // packs at full size on the one-doubling sheet.
  assertEquals(scale, 1);
  assertEquals(ui.meta.size.w * ui.meta.size.h, 512 * 1024);
  assert(
    staged.notes.some((n) =>
      n.includes(
        "logo 256x91, subtitle 256x20, backdrop 845x480 (its top-left",
      )
    ),
    staged.notes.join("\n"),
  );
});

Deno.test("a cover or a save's drawn title still wins over the uploads", async () => {
  const uploads = {
    logoDataURL: await dataUrl(solid(100, 40, MAGENTA)),
    titleBgDataURL: await dataUrl(solid(64, 64, MAGENTA)),
  };
  const covered = await stageAssets({
    gameDir: GAME_DIR,
    record: { name: "t", ...uploads },
    cover: newRaster(256, 480),
  });
  assertEquals(
    parse(covered.files, "assets/game_ui.json").frames["logo.gif"],
    undefined,
  );
  assert(covered.notes.some((n) => n.includes("uploads left out — the cover")));

  // A drawn title hides the backdrop and puts the save's own strip up as the
  // logo, as the browser's dezaTitle branch does.
  const drawn = await stageAssets({
    gameDir: GAME_DIR,
    record: {
      name: "t",
      ...uploads,
      dezaemonTitle: { title1: "player00.gif" },
    },
  });
  const ui = parse(drawn.files, "assets/game_ui.json");
  assertEquals(ui.frames["title_bg"], undefined);
  assert(ui.frames["logo.gif"].frame.w * ui.meta.ps2DisplayScale < 100);
  assert(
    drawn.notes.some((n) => n.includes("uploads left out — the save's drawn")),
  );
});
