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
import {
  createGame,
  type GameContext,
  SCENE_GAME,
} from "@easierbycode/svelte-ps2/ps2-sp";
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

// How fast the game THINKS. Not a frame rate — the port runs its logic on a
// fixed 30 Hz step (`FixedStep` in ps2-sp/game.ts) and that step is what moves
// everything: ships, bullets, waves, the scroll. Rendering as fast as the
// console can is separate and changes none of it, which is why an uncapped
// build looked no quicker.
//
// FixedStep divides real elapsed time by its 33.3 ms step to decide how many
// updates to run, and it reads that time from `rt.Timer` — the only thing in
// the whole bundle that does. Handing it a clock that runs `rate` times fast
// therefore buys `rate` times as many logic steps per second, while
// `FRAME_MS` stays 33.3 so each step advances tweens and the scheduler by
// exactly what it always did. Four times the movement, same physics per step.
//
// `deno task build:ps2 -- --game-fps 30` puts it back to the browser's pace.
const GAME_FPS =
  (globalThis as { __PS2_GAME_FPS__?: number }).__PS2_GAME_FPS__ ?? 30;
const rate = GAME_FPS / 30;

// Set once createGame returns; everything below reads it lazily, because the
// port builds its input layer inside createGame and so has to be handed the
// wrapped pad before there is a context to consult.
let ctx: GameContext | null = null;
const inGame = () => ctx !== null && ctx.scenes.current === SCENE_GAME;

if (rate !== 1) {
  // ONLY the game scene runs fast. Everything else — the title, the
  // interlude, the continue countdown — is paced against the wall clock by
  // counting logic steps, so speeding those up just makes the countdown run
  // out four times too soon. `cs.countDownTimer++` with `% 40` is nine
  // seconds at 30 Hz and a bit over two at 120.
  //
  // The clock scales the DELTA rather than the reading, so it stays monotonic
  // across a scene change. Scaling the reading would make time jump backwards
  // when the rate dropped, and FixedStep would sit on a negative accumulator.
  const base = runtime.Timer;
  let virtualUs = 0;
  let lastRealUs = 0;
  let started = false;
  runtime.Timer = {
    ...base,
    getTime: (timer) => {
      const real = base.getTime(timer);
      if (!started) {
        lastRealUs = real;
        started = true;
      }
      virtualUs += (real - lastRealUs) * (inGame() ? rate : 1);
      lastRealUs = real;
      return virtualUs;
    },
  };

  // Steering is the one thing that must NOT go four times faster. The port
  // moves the ship by nudging a target every logic step —
  // `p.targetX -= PLAYER_MOVE_SPEED` while left is held — and then eases the
  // ship toward it with `PLAYER_SMOOTHING`. Four times the steps means four
  // times the travel per second, which is what makes a tap cross half the
  // screen. So the direction keys and the stick are shown to the game on one
  // step in `rate`: the target moves at its original pace while the easing
  // still runs at the full rate, which reads as the same speed but smoother.
  //
  // Only while actually flying. Menus read directions as edges
  // (`isUpPressed`), and a held direction flickering on every fourth step
  // would spin a cursor.
  const pads = runtime.Pads;
  const realPad = pads.get();
  const DIRECTIONS = [pads.UP, pads.DOWN, pads.LEFT, pads.RIGHT];
  let logicStep = 0;
  const steering = () =>
    inGame() && !ctx!.state.paused && logicStep % rate !== 0;

  const gatedPad = {
    update: () => {
      logicStep++;
      realPad.update();
    },
    pressed: (mask: number) =>
      DIRECTIONS.indexOf(mask) !== -1 && steering()
        ? false
        : realPad.pressed(mask),
    justPressed: (mask: number) => realPad.justPressed(mask),
    get lx() {
      return steering() ? 0 : realPad.lx;
    },
    get ly() {
      return steering() ? 0 : realPad.ly;
    },
    get rx() {
      return realPad.rx;
    },
    get ry() {
      return realPad.ry;
    },
  };
  runtime.Pads = { ...pads, get: () => gatedPad } as typeof pads;
}

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
ctx = game.ctx;

// The edge is read off the pad here rather than through `ctx.input`, because
// the port's `isPressed` is an edge against a snapshot it retakes on every
// LOGIC step — and there are `rate` of those per rendered frame. By the time
// the frame is over the press has long since stopped being an edge, so
// `isStartPressed()` is false and the repair would never fire. The pad's own
// held state, sampled once per frame, is the thing that survives.
const pad = runtime.Pads.get();
const START = runtime.Pads.START;
let startWasDown = false;

for (;;) {
  // Sample the pad BEFORE the frame runs, so this edge and the one the port's
  // own input layer takes during the frame are the same press. Reading it
  // afterwards puts this a frame ahead: the repair would set `paused` before
  // the scene had handled the press, and the scene would then find it already
  // paused and treat the press as an unpause.
  const startDown = pad.pressed(START);
  const startPressed = startDown && !startWasDown;
  startWasDown = startDown;
  const pausedBefore = ctx.state.paused;

  runtime.tick();
  sound.pump();

  if (startPressed && ctx.scenes.current === SCENE_GAME) {
    const paused = !pausedBefore;
    ctx.state.paused = paused ? 1 : 0;
    ctx.scheduler.paused = paused;
    ctx.tweens.paused = paused;
  }
}
