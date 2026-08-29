// Boot the PS2 bundle against a stand-in for AthenaEnv.
//
// There is no way to run athena.elf here, but the bundle only ever talks to
// AthenaEnv through a handful of globals — so this test provides them, points
// them at a real `deno task build:ps2` output, and runs a few frames. That
// covers the parts most likely to break silently: that the bundle is valid
// under a plain module evaluation, that every asset path the game opens is one
// the exporter actually wrote, and that the repacked atlases still contain the
// frame names the level and the recipe ask for.
//
// Skipped (not failed) when build/ps2 holds no build yet, so `deno task test`
// stays green on a fresh checkout.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

// Pick a build out of build/ps2 — the one with the richest level atlas, so a
// throwaway export of a level with no custom art cannot decide what this test
// gets to check.
function findBuild(): { dir: string; levelFrames: number } | null {
  const base = join(ROOT, "build", "ps2");
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(base)];
  } catch {
    return null;
  }
  let best: { dir: string; levelFrames: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name === ".cache") continue;
    for (const inner of Deno.readDirSync(join(base, entry.name))) {
      if (!inner.isDirectory) continue;
      const dir = join(base, entry.name, inner.name);
      try {
        Deno.statSync(join(dir, "main.js"));
      } catch {
        continue; // not an app folder
      }
      let levelFrames = 0;
      try {
        const atlas = JSON.parse(
          Deno.readTextFileSync(join(dir, "assets", "level_atlas.json")),
        ) as { frames?: Record<string, unknown> };
        levelFrames = Object.keys(atlas.frames ?? {}).length;
      } catch {
        // an unreadable atlas is itself worth reporting — leave the count at 0
      }
      if (!best || levelFrames > best.levelFrames) best = { dir, levelFrames };
    }
  }
  return best;
}

// PNG header only: the stub never needs the pixels, just the dimensions the
// atlas manager reads back off each Image.
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

interface DrawCall {
  path: string;
  startx: number;
  starty: number;
  endx: number;
  endy: number;
}

class Harness {
  opened: string[] = [];
  missing: string[] = [];
  draws: DrawCall[] = [];
  rects = 0;
  prints = 0;
  frames = 0;

  constructor(readonly dir: string, readonly frameLimit: number) {}

  read(path: string): Uint8Array | null {
    try {
      return Deno.readFileSync(join(this.dir, path));
    } catch {
      return null;
    }
  }
}

// Publish the AthenaEnv surface the bundle expects. A free function rather
// than a method so the stub classes can close over the harness directly.
function install(self: Harness): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g.Screen = {
    NTSC: 2,
    DEPTH_TEST_ENABLE: 1,
    getMode: () => ({ width: 640, height: 448 }),
    setVSync: () => {},
    setParam: () => {},
    clear: () => {},
    flip: () => {
      self.frames++;
      // The bundle's last statement is an infinite render loop; this is how
      // the test gets control back.
      if (self.frames >= self.frameLimit) throw new Error("__frames_done__");
    },
    display: () => {},
  };

  g.Draw = { rect: () => void self.rects++ };

  g.Image = class {
    width = 0;
    height = 0;
    startx = 0;
    starty = 0;
    endx = 0;
    endy = 0;
    color = 0;
    filter = 0;
    angle = 0;
    #path: string;
    constructor(path: string) {
      this.#path = path;
      self.opened.push(path);
      const bytes = self.read(path);
      if (!bytes) {
        // On hardware a missing file takes the interpreter down, so record
        // it rather than papering over it.
        self.missing.push(path);
        return;
      }
      const size = pngSize(bytes);
      this.width = size.width;
      this.height = size.height;
      this.endx = size.width;
      this.endy = size.height;
    }
    draw() {
      self.draws.push({
        path: this.#path,
        startx: this.startx,
        starty: this.starty,
        endx: this.endx,
        endy: this.endy,
      });
    }
  };

  g.Font = class {
    scale = 1;
    color = 0;
    print() {
      self.prints++;
    }
    getTextSize(text: string) {
      return { width: String(text).length * 8, height: 16 };
    }
  };

  // Pulse CROSS rather than holding it: the scenes advance on a rising
  // edge, and the title only accepts one after its intro has finished.
  const CROSS = 0x4000;
  const pad = {
    update: () => {},
    pressed: (mask: number) => mask === CROSS && self.frames % 30 < 2,
    justPressed: (mask: number) => mask === CROSS && self.frames % 30 === 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
  };
  g.Pads = {
    SELECT: 1,
    L3: 2,
    R3: 4,
    START: 8,
    UP: 16,
    RIGHT: 32,
    DOWN: 64,
    LEFT: 128,
    L2: 256,
    R2: 512,
    L1: 1024,
    R1: 2048,
    TRIANGLE: 4096,
    CIRCLE: 8192,
    CROSS: 16384,
    SQUARE: 32768,
    get: () => pad,
    getConnected: () => [0],
    getConnectedCount: () => 1,
    isActive: () => true,
  };

  // AthenaEnv's Timer counts microseconds — the game divides by 1000 to
  // feed its fixed-step clock — so one flip here is one 30Hz frame.
  let clock = 0;
  g.Timer = {
    new: () => ({}),
    getTime: () => (clock += 33_333),
  };

  g.std = {
    loadFile: (path: string) => {
      self.opened.push(path);
      const bytes = self.read(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    open: () => ({ puts: () => {}, close: () => {} }),
  };
}

Deno.test("the PS2 bundle boots against AthenaEnv's interface", async () => {
  const build = findBuild();
  if (!build) {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const { dir, levelFrames } = build;

  const harness = new Harness(dir, 900);
  install(harness);

  try {
    await import(`file://${join(dir, "main.js")}`);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("__frames_done__")) throw error;
  }

  assertEquals(
    harness.missing,
    [],
    "the game opened files the exporter did not write",
  );
  assert(
    harness.frames >= 900,
    `expected the render loop to run, saw ${harness.frames} frames`,
  );
  assert(
    harness.draws.length > 0,
    "the game drew no sprites at all",
  );

  // Every draw must name a real sub-rectangle of the sheet it came from —
  // catches an atlas whose JSON and PNG have drifted apart.
  const sizes = new Map<string, { width: number; height: number }>();
  for (const path of new Set(harness.opened)) {
    if (!path.endsWith(".png")) continue;
    const bytes = harness.read(path);
    if (bytes) sizes.set(path, pngSize(bytes));
  }
  for (const call of harness.draws) {
    const size = sizes.get(call.path);
    if (!size) continue;
    const right = Math.max(call.startx, call.endx);
    const bottom = Math.max(call.starty, call.endy);
    assert(
      right <= size.width && bottom <= size.height,
      `${call.path}: crop ${right}x${bottom} runs past the ${size.width}x${size.height} sheet`,
    );
  }

  // Getting this far means the run left the title, cleared the cutscene and
  // spawned waves: the enemies come from the level's atlas when it customised
  // them and from the base sheet when it did not.
  const drawnFrom = new Set(harness.draws.map((call) => call.path));
  console.log("  drew from:", [...drawnFrom].join(", "));
  const enemyAtlas = levelFrames > 0
    ? "assets/level_atlas.png"
    : "assets/game_asset.png";
  assert(
    drawnFrom.has(enemyAtlas),
    `nothing was ever drawn from ${enemyAtlas} — the exported waves never ` +
      `reached the screen`,
  );
  assert(
    drawnFrom.has("assets/cyber_liberty.png"),
    "the player ship was never drawn",
  );
});
