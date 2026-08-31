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
  // The NEWEST build, not the richest one: build/ps2/ accumulates every level
  // ever exported, and the point of this test is that the bundle just built
  // still boots. Picking by level size instead would quietly keep testing an
  // old main.js — which is how a build with sound came up silent here.
  let best: { dir: string; levelFrames: number; built: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name === ".cache") continue;
    for (const inner of Deno.readDirSync(join(base, entry.name))) {
      if (!inner.isDirectory) continue;
      const dir = join(base, entry.name, inner.name);
      let built: number;
      try {
        built = Deno.statSync(join(dir, "main.js")).mtime?.getTime() ?? 0;
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
      if (!best || built > best.built) best = { dir, levelFrames, built };
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
  /** Effects the game asked audsrv to load. */
  played: string[] = [];
  /** Every one-shot actually fired, with the channel it went to. */
  plays: { path: string; ch: number }[] = [];
  /**
   * Screen setup. AthenaEnv v4's depth test has no Z-buffer behind it and
   * blanks every other flip, and VSync off puts the flip mid-scanout: either
   * one is a console that draws nothing while every other check here still
   * passes, which is exactly what happened. Undefined means never set.
   */
  vsync: boolean | undefined = undefined;
  depthTest: number | undefined = undefined;

  /** Music tracks opened, and how often a finished one was restarted. */
  streams: string[] = [];
  rewinds = 0;

  /**
   * Whether this export carries music at all. `--no-music` is a supported
   * build — it is most of the disc — and there the game still asks audsrv for
   * every track, so an absent track is the export working, not a gap in it.
   */
  get hasMusic(): boolean {
    return this.read("assets/sounds/adventure_bgm.wav") !== null;
  }
  rects = 0;
  prints = 0;
  frames = 0;
  /** Draw.rect() calls in each completed frame — the pause overlay is one. */
  rectsPerFrame: number[] = [];

  constructor(readonly dir: string, readonly frameLimit: number) {}

  read(path: string): Uint8Array | null {
    try {
      return Deno.readFileSync(join(this.dir, path));
    } catch {
      return null;
    }
  }
}

/** Frames at which the harness presses START, to pause and then unpause. */
const PAUSE_ON = 650;
const PAUSE_OFF = 780;
const near = (frame: number, at: number) => frame >= at && frame < at + 3;

// Publish the AthenaEnv surface the bundle expects. A free function rather
// than a method so the stub classes can close over the harness directly.
function install(self: Harness): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g.Screen = {
    NTSC: 2,
    DEPTH_TEST_ENABLE: 1,
    getMode: () => ({ width: 640, height: 448 }),
    setVSync: (on: boolean) => {
      self.vsync = on;
    },
    setParam: (param: number, value: number) => {
      if (param === 1) self.depthTest = value;
    },
    clear: () => {},
    flip: () => {
      self.rectsPerFrame.push(self.rects);
      self.rects = 0;
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
  const START = 0x0008;
  const pad = {
    update: () => {},
    // Cross every 30 frames to get through the menus and into play, then
    // hands off; START goes down twice, at PAUSE_ON and PAUSE_OFF, with
    // nothing else touching the pad in between so the pause is unambiguous.
    pressed: (mask: number) =>
      self.frames < 600
        ? mask === CROSS && self.frames % 30 < 2
        : mask === START &&
          (near(self.frames, PAUSE_ON) || near(self.frames, PAUSE_OFF)),
    justPressed: (mask: number) =>
      self.frames < 600
        ? mask === CROSS && self.frames % 30 === 0
        : mask === START &&
          (self.frames === PAUSE_ON || self.frames === PAUSE_OFF),
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

  // AthenaEnv's audsrv binding, present only when athena.ini enables it.
  // lib/ps2/runtime-sound.ts drives this, so an effect the exporter never
  // staged shows up here as a missing file exactly like a missing sheet
  // would — audsrv itself throws on a path it cannot open.
  g.Sound = {
    Sfx: (path: string) => {
      self.opened.push(path);
      if (!self.read(path)) {
        self.missing.push(path);
        throw new Error(`no such sound: ${path}`);
      }
      self.played.push(path);
      return { volume: 0, play: (ch: number) => self.plays.push({ path, ch }) };
    },
    // A track that runs out after 20 polls, so the looping in
    // runtime-sound.ts pump() is exercised rather than merely present:
    // audsrv streams do not loop, and a BGM that stops after one pass is the
    // bug this is here to catch. Twenty because the harness presses Cross
    // every 30 frames, so no scene here holds the music for much longer.
    Stream: (path: string) => {
      self.opened.push(path);
      if (!self.read(path)) {
        // audsrv throws on a path it cannot open, and runtime-sound.ts is
        // meant to swallow that and play on in silence.
        if (self.hasMusic) self.missing.push(path);
        throw new Error(`no such track: ${path}`);
      }
      self.streams.push(path);
      let left = 0;
      return {
        play: () => {
          left = 20;
        },
        pause: () => {
          left = 0;
        },
        playing: () => (left > 0 ? (left--, true) : false),
        rewind: () => {
          self.rewinds++;
        },
        free: () => {},
        volume: 0,
      };
    },
    findChannel: () => 0,
    setVolume: () => {},
  };

  g.std = {
    loadFile: (path: string) => {
      self.opened.push(path);
      const bytes = self.read(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    // QuickJS's std.open returns null when it cannot open the file, which is
    // what lib/ps2/runtime-sound.ts probes with before handing a path to
    // AthenaEnv's loaders — those fseek() a NULL FILE* and take the console
    // down. Writes (the high-score file) always succeed.
    open: (path: string, mode: string) =>
      mode.indexOf("r") !== -1 && !self.read(path)
        ? null
        : { puts: () => {}, close: () => {} },
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

  // Before anything about drawing: did the runtime make the screen usable?
  assertEquals(
    harness.depthTest,
    0,
    "the depth test was left on — v4 blanks every other flip without a " +
      "Z-buffer, so nothing is ever seen on hardware",
  );
  assertEquals(
    harness.vsync,
    true,
    "VSync was never enabled — the flip lands mid-scanout and the screen " +
      "goes black on hardware",
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

  // Pause. The port's game scene reads one START press as two things: it
  // pauses, and then its own pause menu sees the same edge through
  // `isConfirmPressed()` — which is `isPressed(CROSS) || isPressed(START)` —
  // and resumes before anything is drawn. runtime-entry.ts re-applies the
  // press afterwards. The overlay is a full-screen Draw.rect, so a paused
  // frame fills more rectangles than a running one.
  const meanRects = (from: number, to: number) => {
    const window = harness.rectsPerFrame.slice(from, to);
    return window.reduce((n, v) => n + v, 0) / (window.length || 1);
  };
  const running = meanRects(PAUSE_ON - 40, PAUSE_ON);
  const paused = meanRects(PAUSE_ON + 10, PAUSE_OFF);
  const resumed = meanRects(PAUSE_OFF + 10, PAUSE_OFF + 100);
  console.log(
    `  rects/frame: ${running.toFixed(2)} running, ${paused.toFixed(2)} ` +
      `paused, ${resumed.toFixed(2)} resumed`,
  );
  assert(
    paused > running,
    `START did not pause: ${paused.toFixed(2)} rects/frame while paused vs ` +
      `${running.toFixed(2)} running`,
  );
  assert(
    resumed < paused,
    `START did not unpause: still ${resumed.toFixed(2)} rects/frame`,
  );

  // Sound. The port asks for .wav paths and the disc carries .adp, so this
  // also pins the extension swap in lib/ps2/runtime-sound.ts.
  if (harness.played.length) {
    for (const path of harness.played) {
      assert(
        path.startsWith("assets/sounds/") && path.endsWith(".adp"),
        `loaded a sound from an unexpected path: ${path}`,
      );
    }
    assert(
      harness.played.includes("assets/sounds/se_shoot.adp"),
      "the shot effect was never loaded",
    );
    console.log(
      `  loaded ${harness.played.length} effects, fired ${harness.plays.length}`,
    );
    assert(
      harness.plays.length > 0,
      "900 frames of play fired no sound at all",
    );

    // Music, when this build has it — --no-music is a supported export, and
    // it is most of the disc. loadStream only records a path, so a track
    // opening at all means the game reached a scene that plays one.
    if (harness.hasMusic) {
      assert(harness.streams.length > 0, "no music track was ever opened");
      for (const path of harness.streams) {
        assert(
          path.startsWith("assets/sounds/") && path.endsWith(".wav"),
          `opened a track from an unexpected path: ${path}`,
        );
      }
      console.log(
        `  opened ${harness.streams.length} tracks, looped ${harness.rewinds}`,
      );
      assert(
        harness.rewinds > 0,
        "a track ran out and was never restarted — BGM would play once",
      );
    } else {
      console.log("  (no music in this build — track assertions skipped)");
    }
  } else {
    console.log("  (no audio in this build — sound assertions skipped)");
  }
});
