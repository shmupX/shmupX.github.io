// The script that runs on the console.
//
// `deno task build:ps2` bundles this file — and everything it imports — into a
// single main.js next to athena.elf, which AthenaEnv evaluates as a module on
// boot. 5velte-ps2 supplies both halves: `native` wraps AthenaEnv's own
// globals in the runtime interface, and `ps2-sp` is the vertical shooter
// itself, so the only thing this file decides is where the exported level's
// three files live on the disc. Nothing here runs under Deno — it is compiled
// for QuickJS, which is the JavaScript engine inside athena.elf.

import { createNativeRuntime } from "@easierbycode/svelte-ps2/native";
import { createGame, SCENE_GAME } from "@easierbycode/svelte-ps2/ps2-sp";
import { createAthenaSound } from "./runtime-sound.ts";

// Set the screen up before anything draws.
//
// AthenaEnv v4 enables a depth test with no Z-buffer behind it, which blanks
// every other flip: the screen alternates between the clear colour and black
// and no sprite ever survives to be seen. This game is painter's-order 2D and
// wants none of it. VSync has to be on for the same reason — off, the flip
// lands mid-scanout and the picture goes black.
//
// Neither call is the port's to make (its runtime interface exposes no
// setParam), and neither has a counterpart in the browser build, so they live
// here — the one file that is only ever compiled for the console.
const screen = (globalThis as {
  Screen?: {
    setParam?: (param: number, value: number) => void;
    setVSync?: (on: boolean) => void;
    setFrameCounter?: (on: boolean) => void;
    DEPTH_TEST_ENABLE?: number;
  };
}).Screen;

// `deno task build:ps2 --uncapped` prepends this to the bundle. It takes the
// flip off the vertical blank so the loop runs as fast as the console can
// draw, and turns on AthenaEnv's own frame counter so the number is visible
// on the TV. Both are measurement tools: an uncapped build tears, and the
// game's logic is a fixed 30 Hz step either way (FixedStep in ps2-sp), so the
// only thing this changes is how often a frame is presented — which is
// exactly what you want to know when the question is "how fast could this
// go?".
const uncapped =
  (globalThis as { __PS2_UNCAPPED__?: boolean }).__PS2_UNCAPPED__ === true;

if (screen) {
  if (
    typeof screen.setParam === "function" &&
    typeof screen.DEPTH_TEST_ENABLE === "number"
  ) {
    screen.setParam(screen.DEPTH_TEST_ENABLE, 0);
  }
  if (typeof screen.setVSync === "function") screen.setVSync(!uncapped);
  if (uncapped && typeof screen.setFrameCounter === "function") {
    screen.setFrameCounter(true);
  }
}

const runtime = createNativeRuntime();

// audsrv, when this build carries audio; a silent stand-in when it does not.
const sound = createAthenaSound();

const game = createGame(runtime, {
  sound,
  // Paths are relative to the boot directory: `cdfs:/` on a disc, the app's
  // own folder on a USB stick. lib/ps2/build.ts writes exactly these three.
  level: {
    dataPath: "assets/level.json",
    atlasPngPath: "assets/level_atlas.png",
    atlasJsonPath: "assets/level_atlas.json",
  },
});

// The package's runNativeLoop() is `while (true) rt.tick()`. Two things need a
// look every frame that it does not give us, so the loop lives here instead.
//
// The music, because audsrv's streams do not loop themselves.
//
// And START, because the port's game scene reads one press as two things. Its
// update does:
//
//     if (input.isStartPressed()) { ...paused = 1... }
//     if (state.paused) { updatePauseMenu(); return }
//
// and updatePauseMenu's own `isConfirmPressed()` is
// `isPressed(CROSS) || isPressed(START)`. `isPressed` is an edge against a
// held/prevHeld snapshot taken once per frame, so on the frame START pauses
// the game the menu sees that same edge as "confirm", the cursor is still on
// Resume, and it unpauses again before anything is drawn. Pressing START did
// nothing at all.
//
// That belongs upstream in @easierbycode/svelte-ps2 — the menu should ignore
// confirm on the frame it opened. Until it is fixed there, this re-applies
// what the press meant, from the state as it was before the frame ran.
// `createGame` hands back the context to do it with.
const ctx = game.ctx;

for (;;) {
  const pausedBefore = ctx.state.paused;
  runtime.tick();
  sound.pump();
  if (ctx.scenes.current === SCENE_GAME && ctx.input.isStartPressed()) {
    const paused = !pausedBefore;
    ctx.state.paused = paused ? 1 : 0;
    ctx.scheduler.paused = paused;
    ctx.tweens.paused = paused;
  }
}
