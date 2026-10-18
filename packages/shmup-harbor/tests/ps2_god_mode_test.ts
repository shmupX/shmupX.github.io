// The PS2 title's god-mode secret.
//
// Hold L and R and press START (or SELECT, for turbo) on the title and the run
// that starts cannot be hurt. Two halves make it: runtime-entry.ts reads the
// pad as the title takes the press and sets `state.godMode`, and
// runtime-patches.ts puts the guard that reads it at the top of the port's
// playerOnDamage, a function private to svelte-ps2. The patch is checked on
// its own; then, when a compiled runtime is on hand, a ship with one hit
// point sits still in the real port until it dies, and the same ship started
// with the secret has to outlast it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { stageAssets } from "../lib/ps2/assets.ts";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { patchRuntime } from "../lib/ps2/runtime-patches.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");
const decoder = new TextDecoder();

Deno.test("the god-mode guard goes in at the top of playerOnDamage", () => {
  const port = [
    "function playerOnDamage(ctx2, p, amount) {",
    "  if (p.barrierFlg || p.damageAnimFlg || p.dead) return;",
    "  p.hp -= amount;",
    "}",
    // What the boss's second stage anchors on (tests/ps2_boss_stage2_test.ts):
    // every patch's anchor has to be there for any of them to go on.
    "function createBoss(ctx2, data, stageId) {",
    "}",
    "function bossLoop(ctx2, b) {",
    "  const bMul = ctx2.state.turboMode ? 2 : 1;",
    "  b.moveTimer += bMul;",
    "  if (b.attackCooldown <= 0) {",
    "    bossAttack(ctx2, b);",
    "  }",
    "}",
    "function bossDraw(ctx2, b) {",
    "}",
  ].join("\n");
  const patched = patchRuntime(port);
  assert(
    patched.startsWith(
      "function playerOnDamage(ctx2, p, amount) {\n" +
        "  if (ctx2.state.godMode) return;\n" +
        "  if (p.barrierFlg",
    ),
    patched,
  );
  // A port that moved the function out from under the patch fails the build.
  assertThrows(
    () => patchRuntime("function playerDamage(ctx, p, n) {\n}"),
    Error,
    'patch "god mode"',
  );
});

const PADS = {
  SELECT: 1,
  START: 8,
  L1: 1024,
  L2: 256,
  R1: 2048,
  R2: 512,
  CROSS: 16384,
};

interface Run {
  /** The continue card came up: the ship died. */
  died: boolean;
  /** Frames spent in a stage. */
  flying: number;
  /** Frames in all, title and interludes included. */
  frames: number;
}

/**
 * Boot the compiled port over a staged disc against a stand-in for AthenaEnv,
 * with a one-hit ship that never moves or fires. `hold` is held and `press`
 * pulsed while the title is up, and nothing at all after it, so the ship dies
 * to the first thing that reaches it — or to the boss timer, which ends every
 * stage the ship cannot finish.
 */
async function run(
  dir: string,
  mainJs: string,
  title: { hold: number[]; press: number },
  limit: number,
): Promise<Run> {
  const read = (path: string) => {
    try {
      return Deno.readFileSync(join(dir, path));
    } catch {
      return null;
    }
  };
  const out: Run = { died: false, flying: 0, frames: 0 };

  let titleUp = false;
  let titleDrawn = false;
  let inGame = false;
  const g = globalThis as unknown as Record<string, unknown>;
  g.Screen = {
    NTSC: 2,
    DEPTH_TEST_ENABLE: 1,
    getMode: () => ({ width: 640, height: 448 }),
    setVSync: () => {},
    setParam: () => {},
    clear: () => {},
    flip: () => {
      const frames = ++out.frames;
      if (inGame) out.flying++;
      titleUp = titleDrawn;
      titleDrawn = false;
      // The bundle's last statement is an infinite loop; this is the way out.
      if (out.died || frames >= limit) throw new Error("__played__");
    },
    display: () => {},
  };
  g.Draw = { rect: () => {} };
  g.Image = class {
    width = 0;
    height = 0;
    startx = 0;
    starty = 0;
    endx = 0;
    endy = 0;
    color = 0;
    constructor(path: string) {
      const bytes = read(path);
      assert(bytes, `the game opened ${path}, which is not on the disc`);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      this.width = this.endx = view.getUint32(16);
      this.height = this.endy = view.getUint32(20);
    }
    draw() {}
  };
  g.Font = class {
    scale = 1;
    color = 0;
    print(_x: number, _y: number, text: string) {
      const said = String(text);
      if (said === "HI-SCORE") titleDrawn = true;
      else if (/^ROUND \d+$/.test(said)) inGame = true;
      else if (said === "YES") {
        // Only the continue card offers YES / NO.
        inGame = false;
        out.died = true;
      }
    }
    getTextSize(text: string) {
      return { width: String(text).length * 8, height: 16 };
    }
  };
  const pad = {
    update: () => {},
    pressed: (mask: number) =>
      titleUp &&
      (title.hold.includes(mask) ||
        (mask === title.press && out.frames % 30 < 2)),
    justPressed: () => false,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
  };
  g.Pads = {
    ...PADS,
    L3: 2,
    R3: 4,
    UP: 16,
    RIGHT: 32,
    DOWN: 64,
    LEFT: 128,
    TRIANGLE: 4096,
    CIRCLE: 8192,
    SQUARE: 32768,
    get: () => pad,
    getConnected: () => [0],
    getConnectedCount: () => 1,
    isActive: () => true,
  };
  let clock = 0;
  g.Timer = { new: () => ({}), getTime: () => (clock += 33_333) };
  g.std = {
    loadFile: (path: string) => {
      const bytes = read(path);
      if (!bytes) return null;
      if (path !== "assets/game.json") return decoder.decode(bytes);
      const recipe = JSON.parse(decoder.decode(bytes));
      recipe.playerData.maxHp = 1;
      return JSON.stringify(recipe);
    },
    open: () => ({ puts: () => {}, close: () => {} }),
  };

  const quiet = console.log;
  console.log = () => {};
  try {
    await import(`file://${mainJs}`);
  } catch (error) {
    if (!(error as Error).message.includes("__played__")) throw error;
  } finally {
    console.log = quiet;
  }
  return out;
}

Deno.test("L+R held through START or SELECT on the title plays the run in god mode", async () => {
  const cache = join(ROOT, "build", "ps2", ".cache");
  try {
    await Deno.stat(join(cache, "main.js"));
  } catch {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const runtime = await buildRuntimeBundle(ROOT, cache);
  const record = JSON.parse(
    await Deno.readTextFile(join(GAME_DIR, "foo.json")),
  );
  const { files } = await stageAssets({ gameDir: GAME_DIR, record });

  const dir = await Deno.makeTempDir({ prefix: "shmupx-ps2-god-" });
  try {
    for (const file of files) {
      const target = join(dir, file.path);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, file.data);
    }
    // One copy per run: a module is evaluated once per URL.
    let runs = 0;
    const play = async (
      title: { hold: number[]; press: number },
      limit: number,
    ) => {
      const mainJs = join(dir, `main-${runs++}.mjs`);
      await Deno.writeFile(
        mainJs,
        new Uint8Array([
          ...new TextEncoder().encode(
            "globalThis.__PS2_GAME_FPS__ = 120;\n" +
              "globalThis.__PS2_AUDSRV__ = false;\n",
          ),
          ...runtime,
        ]),
      );
      return await run(dir, mainJs, title, limit);
    };

    // Without the secret the one-hit ship dies, and that is the yardstick.
    const mortal = await play({ hold: [], press: PADS.START }, 40_000);
    assert(mortal.died, "the control ship never died — nothing to measure by");
    // L alone is not the secret.
    const half = await play({ hold: [PADS.L1], press: PADS.START }, 40_000);
    assert(half.died, "L without R played in god mode");

    // Long enough to fly three times as long as the mortal ship did.
    const limit = mortal.frames + mortal.flying * 2;
    for (
      const [how, title] of [
        ["START", { hold: [PADS.L1, PADS.R1], press: PADS.START }],
        ["SELECT", { hold: [PADS.L2, PADS.R2], press: PADS.SELECT }],
      ] as const
    ) {
      const ran = await play(
        { hold: [...title.hold], press: title.press },
        limit,
      );
      assertEquals(
        ran.died,
        false,
        `L+R+${how}: the ship died after ${ran.flying} frames in a stage`,
      );
      assert(
        ran.flying > mortal.flying * 2,
        `L+R+${how}: only ${ran.flying} frames in a stage against the ` +
          `${mortal.flying} the ship lasted without it`,
      );
    }
    console.log(
      `  a one-hit ship died after ${mortal.flying} frames; with L+R it ` +
        `flew more than twice that, through START and SELECT alike`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
