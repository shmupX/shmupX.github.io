// Driving the paused 2028-ai runtime from MCP.
//
// The debugger itself is scripts/lib/game-debug.ts, and everything it controls
// lives in the PAGE rather than in a process: `deno task game:debug` opens a
// Chrome whose probe has taken over requestAnimationFrame, walks the runtime
// through the title and the story to the first frame of the stage, and leaves
// it paused there. Anything that can reach that browser's DevTools port drives
// it from then on, so these tools are a second client against the same page —
// not a debugger of their own, and not something the player has to hand a
// session to.
//
// That is why every function here attaches, does one thing, and closes again.
// A socket held between tool calls would buy nothing — the frame counter, the
// pause flag and the synthetic pad are all page state, so re-attaching reads
// exactly what the last call left behind — and it would go stale the moment
// the player restarts the task, which is precisely when the next tool call has
// to keep working.

import { resolve } from "@std/path";
import {
  type DebugStatus,
  DEFAULT_CDP_PORT,
  GameDebug,
  KEY_SPECS,
  keySpec,
  PAD_BUTTONS,
  padButtonIndex,
} from "../../scripts/lib/game-debug.ts";

export { DEFAULT_CDP_PORT };
export type { DebugStatus };

/**
 * The accepted names, precomputed for the tool descriptions.
 *
 * The tools list them rather than validating silently, because a wrong pad
 * button is invisible in the game: the press lands on a button nothing reads
 * and the frame advances as if it had worked.
 */
export const PAD_BUTTON_NAMES: string[] = Object.keys(PAD_BUTTONS);
export const KEY_NAMES: string[] = Object.keys(KEY_SPECS);

/** Every report carries the port it came from; there can be more than one. */
export type DebugReport = DebugStatus & { port: number };

export interface PortOpts {
  port?: number;
}

/**
 * Fail fast, and with the one sentence that fixes it.
 *
 * `attachCdp` polls for 20 seconds by design — it is also the function that
 * waits for a Chrome that is still starting up in `launchDebugBrowser` — but a
 * tool call that stalls for 20 seconds and then reports a socket error teaches
 * the caller nothing. One cheap GET against the DevTools HTTP endpoint tells us
 * whether there is anything there at all, and if there is not, the answer is
 * always the same command.
 */
async function requireDebugBrowser(port: number): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    // Nothing here wants the body, but an undrained one holds the connection.
    await res.body?.cancel();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    throw new Error(
      `No debug browser is listening on DevTools port ${port}. Start one with ` +
        "`deno task game:debug` — it serves the level, opens the runtime, walks " +
        "it to the first frame of the stage and pauses it there, then leaves the " +
        "port open for these tools. If it is already running on a different " +
        "port, pass that port.",
    );
  }
}

/**
 * Attach, run one operation, close.
 *
 * `GameDebug.attach` already refuses a page with no probe or a stale one, in
 * words that name the task to restart, so the only error worth adding is the
 * one for a port with nothing behind it.
 */
async function withGame<T>(
  port: number | undefined,
  run: (game: GameDebug, port: number) => Promise<T>,
): Promise<T> {
  const on = port ?? DEFAULT_CDP_PORT;
  await requireDebugBrowser(on);
  const game = await GameDebug.attach(on);
  try {
    return await run(game, on);
  } finally {
    game.close();
  }
}

/** Scene, frame, pause flag, loop time, held buttons. */
export function debugStatus({ port }: PortOpts = {}): Promise<DebugReport> {
  return withGame(
    port,
    async (game, on) => ({ port: on, ...await game.status() }),
  );
}

/** What is on screen: display objects, the player, a count per visible frame. */
export function debugInspect(
  { port }: PortOpts = {},
): Promise<Record<string, unknown>> {
  return withGame(port, async (game, on) => {
    const seen = await game.inspect();
    // The probe answers {error: "no game"} when the page has no game global --
    // mid-reload, or a probe installed on something that is not the runtime.
    // Passing that through as a SUCCESS is the worst of both: the caller reads
    // an object, sees no scenes, and concludes the game is empty rather than
    // absent. Make it the failure it is.
    if (typeof seen.error === "string") {
      throw new Error(
        `the page on port ${on} has no running game (${seen.error}) -- it may ` +
          `still be reloading; retry, or restart \`deno task game:debug\``,
      );
    }
    return { port: on, ...seen };
  });
}

/** Freeze the world on the frame it is showing. */
export function debugPause({ port }: PortOpts = {}): Promise<DebugReport> {
  return withGame(
    port,
    async (game, on) => ({ port: on, ...await game.pause() }),
  );
}

/** Hand the animation frame back to the page. */
export function debugResume({ port }: PortOpts = {}): Promise<DebugReport> {
  return withGame(port, async (game, on) => ({
    port: on,
    ...await game.resume(),
  }));
}

export interface StepOpts extends PortOpts {
  frames?: number;
}

/** Advance exactly `frames` Phaser ticks. Pauses first, and stays paused. */
export function debugStep(
  { frames, port }: StepOpts = {},
): Promise<DebugReport> {
  return withGame(port, async (game, on) => ({
    port: on,
    ...await game.step(frames ?? 1),
  }));
}

export interface PressOpts extends StepOpts {
  buttons: string[];
}

/**
 * Hold pad buttons across `frames` ticks, then release them.
 *
 * The names are checked here, before anything attaches, so that a typo is
 * reported as a typo — `padButtonIndex` throws with the full list — instead of
 * as "no debug browser" when the browser happens to be down as well.
 */
export function debugPress(
  { buttons, frames, port }: PressOpts,
): Promise<DebugReport> {
  buttons.forEach(padButtonIndex);
  return withGame(port, async (game, on) => ({
    port: on,
    ...await game.press(buttons, frames),
  }));
}

export interface KeysOpts extends StepOpts {
  keys: string[];
}

/** Real key events, for the boxes that do not read the pad. */
export function debugKeys(
  { keys, frames, port }: KeysOpts,
): Promise<DebugReport> {
  keys.forEach(keySpec);
  return withGame(port, async (game, on) => ({
    port: on,
    ...await game.keys(keys, frames),
  }));
}

export interface ScreenshotOpts extends PortOpts {
  path: string;
}

/**
 * Capture the browser window to a PNG.
 *
 * The path is resolved before it is used: an MCP server's working directory is
 * whatever the client that spawned it happened to be in, so a relative path
 * that looks repo-relative to the caller is not, and answering with the
 * absolute path is the only way the caller can go read the file afterwards.
 */
export function debugScreenshot(
  { path, port }: ScreenshotOpts,
): Promise<{
  port: number;
  path: string;
  bytes: number;
  frame: number;
  width: number;
  height: number;
}> {
  return withGame(port, async (game, on) => ({
    port: on,
    ...await game.screenshot(resolve(path)),
  }));
}

export interface EvalOpts extends PortOpts {
  expression: string;
}

/**
 * Evaluate an expression in the page and report what it came back as.
 *
 * `value` arrives over Runtime.evaluate with returnByValue, so it is whatever
 * survived JSON. An expression whose result cannot cross that boundary — a DOM
 * node, a function, something cyclic — either comes back empty or is refused by
 * the protocol outright, which is why the tool description tells the caller to
 * read properties or JSON-clone. `undefined` is reported as null because JSON
 * has no other spelling for it, and `type` is then the only way to tell that
 * apart from a real null — it is `typeof` applied HERE, to what came back,
 * because Cdp.eval hands over `result.value` and drops the protocol's own type
 * tag. So it says what the value is in Deno rather than what it was in the
 * page: an array, a date and a JSON-cloned sprite all read "object".
 */
export function debugEval(
  { expression, port }: EvalOpts,
): Promise<{ port: number; expression: string; type: string; value: unknown }> {
  return withGame(port, async (game, on) => {
    const value = await game.evaluate<unknown>(expression);
    return {
      port: on,
      expression,
      type: value === null ? "null" : typeof value,
      value: value === undefined ? null : value,
    };
  });
}
