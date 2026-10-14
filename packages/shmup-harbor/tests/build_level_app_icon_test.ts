// The app icon: a game that flies its own ship wears it.
//
// tools/build-level/lib/app-icon.js cuts the first frame of a game's player
// out of its atlas and scales it to the Android densities and the PWA sizes,
// the way the scaffold's icons are Duke's first frame. Its rule for "its own
// player" is playsOwnShip's in game.bundle.js, and its PNG codec is a Node
// port of lib/ps2/png.ts — so this runs the Node code for real against
// fixtures this file encodes with the Deno codec, and reads what it wrote
// back through the same.
//
// tools/build-level is excluded from deno.json's fmt/lint/check, so this is
// the only automated coverage the icon has.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { harborRoot } from "../lib/repo-root.ts";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "../lib/ps2/png.ts";

const TOOL = join(harborRoot(), "tools", "build-level", "lib", "app-icon.js");

async function haveNode(): Promise<boolean> {
  try {
    return (await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}
const nodeAvailable = await haveNode();
if (!nodeAvailable) {
  console.log("  (build-level app icon: skipped — no node on PATH)");
}

const RED = [220, 30, 30, 255];
const BLUE = [30, 30, 220, 255];
const GREEN = [30, 220, 30, 255];

function fill(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  c: number[],
) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      r.data.set(c, (yy * r.width + xx) * 4);
    }
  }
}

function pixel(r: Raster, x: number, y: number): number[] {
  return Array.from(
    r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4),
  );
}

async function dataUrl(r: Raster): Promise<string> {
  const bytes = await encodePng(r);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "data:image/png;base64," + btoa(bin);
}

/**
 * A base game on disk: Duke is the 2×2 blue block at the sheet's left,
 * roster_0 the 2×2 green one beside him.
 */
async function writeBaseGame(dir: string) {
  await Deno.mkdir(join(dir, "assets", "img"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "assets", "game.json"),
    JSON.stringify({ playerData: { texture: ["duke_0", "duke_1"] } }),
  );
  await Deno.writeTextFile(
    join(dir, "assets", "game_asset.json"),
    JSON.stringify({
      frames: {
        duke_0: { frame: { x: 0, y: 0, w: 2, h: 2 } },
        roster_0: { frame: { x: 2, y: 0, w: 2, h: 2 } },
      },
      meta: { image: "img/game_asset.png" },
    }),
  );
  const sheet = newRaster(4, 2);
  fill(sheet, 0, 0, 2, 2, BLUE);
  fill(sheet, 2, 0, 2, 2, GREEN);
  await Deno.writeFile(
    join(dir, "assets", "img", "game_asset.png"),
    await encodePng(sheet),
  );
}

/** A level atlas: a 3×2 red ship at (1,1) inside a 5×4 frame of air. */
async function levelAtlas(): Promise<
  { atlasImageDataURL: string; atlasFrames: unknown }
> {
  const atlas = newRaster(6, 4);
  fill(atlas, 1, 1, 3, 2, RED);
  return {
    atlasImageDataURL: await dataUrl(atlas),
    // The Firebase spelling of "ship_1.png" (U+2024 for the dot).
    atlasFrames: { "ship_1․png": { frame: { x: 0, y: 0, w: 5, h: 4 } } },
  };
}

interface Outcome {
  result: { dir: string; name: string; from: string; files: string[] } | null;
  said: string[];
}

/** Run writeAppIcon in Node for one level record. */
async function runTool(
  gameDir: string,
  outDir: string,
  levelData: unknown,
): Promise<Outcome> {
  const script = `
    const { writeAppIcon } = require(process.argv[1]);
    const levelData = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
    const said = [];
    const result = writeAppIcon({ levelData, gameDir: process.argv[2], outDir: process.argv[4], log: (s) => said.push(s) });
    console.log(JSON.stringify({ result, said }));
  `;
  const levelFile = join(outDir + ".json");
  await Deno.writeTextFile(levelFile, JSON.stringify(levelData));
  const out = await new Deno.Command("node", {
    args: ["-e", script, TOOL, gameDir, levelFile, outDir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

async function readIcon(file: string): Promise<Raster> {
  return await decodePng(await Deno.readFile(file));
}

Deno.test({
  name:
    "a game with a ship of its own wears its first frame, cut from its atlas",
  ignore: !nodeAvailable,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "app-icon-" });
    try {
      const game = join(tmp, "game");
      await writeBaseGame(game);
      const out = join(tmp, "icon");
      const { result, said } = await runTool(game, out, {
        playerData: { texture: ["ship_1.png", "ship_2.png"] },
        ...(await levelAtlas()),
      });
      assert(result, "a ship of its own → an icon set: " + said.join(" / "));
      assertEquals(result.name, "ship_1.png");
      assertEquals(result.from, "the game's atlas");
      assertEquals(result.dir, out);
      // Six densities + three shared sizes + three icns sources + the source
      // frame.
      assertEquals(result.files.length, 13);

      // The frame is trimmed to the 3×2 ship, then blown up by whole pixels:
      // ×64 fits 192 (192×128, centred), ×12 fits 36 (36×24).
      const big = await readIcon(join(out, "android", "xxxhdpi.png"));
      assertEquals([big.width, big.height], [192, 192]);
      assertEquals(pixel(big, 96, 96), RED, "the ship, centred");
      assertEquals(pixel(big, 96, 10), [0, 0, 0, 0], "air above the ship");
      assertEquals(pixel(big, 0, 32), RED, "the ship spans the full width");
      assertEquals(pixel(big, 0, 31), [0, 0, 0, 0], "and starts at row 32");
      const small = await readIcon(join(out, "android", "ldpi.png"));
      assertEquals([small.width, small.height], [36, 36]);
      assertEquals(pixel(small, 18, 18), RED);
      assertEquals(pixel(small, 18, 2), [0, 0, 0, 0]);
      const shared = await readIcon(join(out, "icon-512.png"));
      assertEquals([shared.width, shared.height], [512, 512]);
      assertEquals(pixel(shared, 256, 256), RED);
      for (const n of [32, 128, 256]) {
        const icns = await readIcon(join(out, `icon-${n}.png`));
        assertEquals([icns.width, icns.height], [n, n]);
        assertEquals(pixel(icns, n >> 1, n >> 1), RED);
      }
      const src = await readIcon(join(out, "source.png"));
      assertEquals(
        [src.width, src.height],
        [3, 2],
        "the source frame, trimmed",
      );
      const meta = JSON.parse(await Deno.readTextFile(join(out, "icon.json")));
      assertEquals(meta, {
        frame: "ship_1.png",
        from: "the game's atlas",
        size: { w: 3, h: 2 },
      });
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "a record that restates Duke keeps the scaffold's icons; an import's player is always its own",
  ignore: !nodeAvailable,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "app-icon-" });
    try {
      const game = join(tmp, "game");
      await writeBaseGame(game);

      const duke = await runTool(game, join(tmp, "duke"), {
        playerData: { texture: ["duke_0", "duke_1"] },
        ...(await levelAtlas()),
      });
      assertEquals(duke.result, null);
      assertEquals(duke.said, ["  icon: Duke (the base game's player)."]);
      assertEquals(await exists(join(tmp, "duke")), false, "nothing written");

      const none = await runTool(game, join(tmp, "none"), { enemyData: {} });
      assertEquals(none.result, null);

      // The same two frames, on a Dezaemon import: that ship is the cart's.
      const cart = await runTool(game, join(tmp, "cart"), {
        meta: { source: "dezaemon2" },
        playerData: { texture: ["duke_0", "duke_1"] },
      });
      assert(cart.result);
      assertEquals(cart.result.name, "duke_0");
      assertEquals(cart.result.from, "the base game's sheet");
      const icon = await readIcon(join(tmp, "cart", "android", "mdpi.png"));
      assertEquals(pixel(icon, 24, 24), BLUE);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "a roster ship the base sheet has is cut from there; a frame nowhere keeps Duke",
  ignore: !nodeAvailable,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "app-icon-" });
    try {
      const game = join(tmp, "game");
      await writeBaseGame(game);

      const roster = await runTool(game, join(tmp, "roster"), {
        playerData: { texture: ["roster_0"] },
      });
      assert(roster.result);
      assertEquals(roster.result.from, "the base game's sheet");
      const icon = await readIcon(join(tmp, "roster", "android", "hdpi.png"));
      assertEquals([icon.width, icon.height], [72, 72]);
      assertEquals(pixel(icon, 36, 36), GREEN);
      assertEquals(pixel(icon, 0, 0), GREEN, "a square frame fills the square");

      const ghost = await runTool(game, join(tmp, "ghost"), {
        playerData: { texture: ["ghost_0"] },
        ...(await levelAtlas()),
      });
      assertEquals(ghost.result, null);
      assertEquals(ghost.said, [
        "  icon: ghost_0 — frame not in any atlas; Duke stays.",
      ]);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "applyAppIcon lays the set over a cordova project's res/android and icons/",
  ignore: !nodeAvailable,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "app-icon-" });
    try {
      const game = join(tmp, "game");
      await writeBaseGame(game);
      const out = join(tmp, "icon");
      const { result } = await runTool(game, out, {
        playerData: { texture: ["ship_1.png"] },
        ...(await levelAtlas()),
      });
      assert(result);
      const cordova = join(tmp, "cordova");
      // What the scaffold copy leaves there: Duke, to be covered.
      await Deno.mkdir(join(cordova, "res", "android"), { recursive: true });
      await Deno.writeTextFile(
        join(cordova, "res", "android", "mdpi.png"),
        "duke",
      );
      const script = `
        const { applyAppIcon } = require(process.argv[1]);
        console.log(JSON.stringify({
          applied: applyAppIcon(process.argv[2], process.argv[3]),
          none: applyAppIcon(null, process.argv[3]),
        }));
      `;
      const run = await new Deno.Command("node", {
        args: ["-e", script, TOOL, out, cordova],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!run.success) throw new Error(new TextDecoder().decode(run.stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(run.stdout)), {
        applied: true,
        none: false,
      });
      for (const d of ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
        const icon = await readIcon(
          join(cordova, "res", "android", d + ".png"),
        );
        assertEquals(pixel(icon, icon.width >> 1, icon.height >> 1), RED, d);
      }
      for (
        const f of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]
      ) {
        assert(await exists(join(cordova, "icons", f)), f);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "the set feeds the desktop builder: a Mac .icns with all four sizes",
  ignore: !nodeAvailable,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "app-icon-" });
    try {
      const game = join(tmp, "game");
      await writeBaseGame(game);
      const out = join(tmp, "icon");
      const { result } = await runTool(game, out, {
        playerData: { texture: ["ship_1.png"] },
        ...(await levelAtlas()),
      });
      assert(result);
      // What run-deno-desktop.js iconFor does for a mac target, over this dir.
      const script = `
        const path = require("path");
        const { buildIcns } = require(process.argv[1]);
        const icns = buildIcns([32, 128, 256, 512].map((n) => path.join(process.argv[2], "icon-" + n + ".png")));
        const types = [];
        let at = 8;
        while (at + 8 <= icns.length) {
          types.push(icns.toString("ascii", at, at + 4));
          at += icns.readUInt32BE(at + 4);
        }
        console.log(JSON.stringify(types));
      `;
      const run = await new Deno.Command("node", {
        args: [
          "-e",
          script,
          join(
            harborRoot(),
            "tools",
            "build-level",
            "lib",
            "run-deno-desktop.js",
          ),
          out,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!run.success) throw new Error(new TextDecoder().decode(run.stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(run.stdout)), [
        "ic11",
        "ic07",
        "ic08",
        "ic13",
        "ic09",
        "ic14",
      ]);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
