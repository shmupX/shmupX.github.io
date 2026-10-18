// The browser build's DualShock: what lib/ps2/web-host.ts answers the game's
// `Pads` with.
//
// Three sources are ORed into the one pad the game reads, port 0:
//
//   * the keyboard — arrows (or WASD) move, Z or Space fire (CROSS), X is
//     CIRCLE, C is TRIANGLE, Enter START, Shift SELECT, Q and E are L1 and R1;
//   * every connected Gamepad, standard mapping, so the debug probe's
//     synthetic pad (scripts/lib/game-debug.ts) drives it too;
//   * a mask a script sets, for the bot: `globalThis.__PS2_PADS__.set(mask)`
//     holds exactly those buttons until the next set() or clear().
//
// refresh() runs once per frame, before the frame ticks, so every read inside
// a frame sees the same buttons and an edge (`fresh`) lasts exactly one frame
// — the same shape AthenaEnv's `pad.update()` snapshot has on a console.
//
// Nothing here imports Phaser, so it can be checked under Deno.

import { PAD_BUTTONS } from "@easierbycode/svelte-ps2";

export type AxisName = "lx" | "ly" | "rx" | "ry";

/** KeyboardEvent.code -> PS2 button mask. */
export const KEY_MAP: Readonly<Record<string, number>> = {
  ArrowUp: PAD_BUTTONS.UP,
  ArrowDown: PAD_BUTTONS.DOWN,
  ArrowLeft: PAD_BUTTONS.LEFT,
  ArrowRight: PAD_BUTTONS.RIGHT,
  KeyW: PAD_BUTTONS.UP,
  KeyS: PAD_BUTTONS.DOWN,
  KeyA: PAD_BUTTONS.LEFT,
  KeyD: PAD_BUTTONS.RIGHT,
  KeyZ: PAD_BUTTONS.CROSS,
  Space: PAD_BUTTONS.CROSS,
  KeyX: PAD_BUTTONS.CIRCLE,
  KeyC: PAD_BUTTONS.TRIANGLE,
  KeyV: PAD_BUTTONS.SQUARE,
  Enter: PAD_BUTTONS.START,
  NumpadEnter: PAD_BUTTONS.START,
  ShiftLeft: PAD_BUTTONS.SELECT,
  ShiftRight: PAD_BUTTONS.SELECT,
  KeyQ: PAD_BUTTONS.L1,
  KeyE: PAD_BUTTONS.R1,
  Digit1: PAD_BUTTONS.L2,
  Digit3: PAD_BUTTONS.R2,
};

/** Standard-mapping Gamepad button index -> PS2 button mask. */
export const GAMEPAD_MAP: readonly (number | undefined)[] = [
  PAD_BUTTONS.CROSS, // 0  A / Cross
  PAD_BUTTONS.CIRCLE, // 1  B / Circle
  PAD_BUTTONS.SQUARE, // 2  X / Square
  PAD_BUTTONS.TRIANGLE, // 3  Y / Triangle
  PAD_BUTTONS.L1, // 4
  PAD_BUTTONS.R1, // 5
  PAD_BUTTONS.L2, // 6
  PAD_BUTTONS.R2, // 7
  PAD_BUTTONS.SELECT, // 8  Back / Share
  PAD_BUTTONS.START, // 9  Start / Options
  PAD_BUTTONS.L3, // 10
  PAD_BUTTONS.R3, // 11
  PAD_BUTTONS.UP, // 12
  PAD_BUTTONS.DOWN, // 13
  PAD_BUTTONS.LEFT, // 14
  PAD_BUTTONS.RIGHT, // 15
];

/** The mask a set of held keys makes. */
export function keyMask(codes: Iterable<string>): number {
  let mask = 0;
  for (const code of codes) mask |= KEY_MAP[code] ?? 0;
  return mask;
}

/** The mask a Gamepad's buttons make. */
export function gamepadMask(
  buttons: readonly { pressed: boolean }[],
): number {
  let mask = 0;
  for (let i = 0; i < buttons.length && i < GAMEPAD_MAP.length; i++) {
    if (buttons[i]?.pressed) mask |= GAMEPAD_MAP[i] ?? 0;
  }
  return mask;
}

/** The bot's handle, published as `globalThis.__PS2_PADS__`. */
export interface ScriptedPads {
  /** Hold exactly these buttons (an OR of `BUTTONS`) until changed. */
  set(mask: number): number;
  /** Let go of everything the script holds. */
  clear(): number;
  /** What the script holds. */
  get(): number;
  /** What the game sees this frame: script, keyboard and gamepads together. */
  held(): number;
  readonly BUTTONS: typeof PAD_BUTTONS;
}

/** Just enough of a Gamepad to read. */
export interface GamepadLike {
  connected: boolean;
  buttons: readonly { pressed: boolean }[];
  axes: readonly number[];
}

export interface WebPadSourceOptions {
  /** Where key events arrive. Defaults to `globalThis` when it has listeners. */
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** The live Gamepad list. Defaults to `navigator.getGamepads`. */
  gamepads?: () => readonly (GamepadLike | null)[];
}

/**
 * The single-port pad source svelte-ps2's Phaser host asks (`held`, `fresh`,
 * `axis`) — the `PadSource` interface, matched structurally.
 */
export class WebPadSource {
  #keys = new Set<string>();
  #scripted = 0;
  #cur = 0;
  #prev = 0;
  #axes: Record<AxisName, number> = { lx: 0, ly: 0, rx: 0, ry: 0 };
  #target: WebPadSourceOptions["target"] | null;
  #gamepads: () => readonly (GamepadLike | null)[];

  #onKeyDown = (event: Event) => {
    const code = (event as KeyboardEvent).code;
    if (KEY_MAP[code] === undefined) return;
    // Arrows and Space would scroll the page out from under the game.
    event.preventDefault();
    this.#keys.add(code);
  };

  #onKeyUp = (event: Event) => {
    this.#keys.delete((event as KeyboardEvent).code);
  };

  // A key released while the tab was in the background never sends its keyup.
  #onBlur = () => this.#keys.clear();

  constructor(options: WebPadSourceOptions = {}) {
    const fallback = typeof globalThis.addEventListener === "function"
      ? globalThis
      : null;
    this.#target = options.target ?? fallback;
    this.#gamepads = options.gamepads ?? (() => {
      const nav = globalThis.navigator as Navigator | undefined;
      return nav && typeof nav.getGamepads === "function"
        ? nav.getGamepads()
        : [];
    });
    this.#target?.addEventListener("keydown", this.#onKeyDown);
    this.#target?.addEventListener("keyup", this.#onKeyUp);
    this.#target?.addEventListener("blur", this.#onBlur);
  }

  destroy(): void {
    this.#target?.removeEventListener("keydown", this.#onKeyDown);
    this.#target?.removeEventListener("keyup", this.#onKeyUp);
    this.#target?.removeEventListener("blur", this.#onBlur);
    this.#keys.clear();
  }

  /** Take this frame's snapshot. Call once per frame, before the tick. */
  refresh(): void {
    this.#prev = this.#cur;
    let mask = this.#scripted | keyMask(this.#keys);
    const axes: Record<AxisName, number> = { lx: 0, ly: 0, rx: 0, ry: 0 };
    let sticks = false;
    for (const pad of this.#gamepads()) {
      if (!pad || !pad.connected) continue;
      mask |= gamepadMask(pad.buttons);
      // The first pad's sticks; a second pad's would only fight it.
      if (!sticks) {
        sticks = true;
        axes.lx = pad.axes[0] ?? 0;
        axes.ly = pad.axes[1] ?? 0;
        axes.rx = pad.axes[2] ?? 0;
        axes.ry = pad.axes[3] ?? 0;
      }
    }
    this.#cur = mask;
    this.#axes = axes;
  }

  /** Every button held this frame. */
  get mask(): number {
    return this.#cur;
  }

  held(mask: number): boolean {
    return (this.#cur & mask) !== 0;
  }

  fresh(mask: number): boolean {
    return (this.#cur & mask) !== 0 && (this.#prev & mask) === 0;
  }

  /** Web Gamepad convention, -1..1; the host scales it to AthenaEnv's. */
  axis(name: AxisName): number {
    return this.#axes[name];
  }

  /** The handle the bot drives. */
  readonly scripted: ScriptedPads = {
    set: (mask: number) => (this.#scripted = (mask >>> 0) & 0xffff),
    clear: () => (this.#scripted = 0),
    get: () => this.#scripted,
    held: () => this.#cur,
    BUTTONS: PAD_BUTTONS,
  };
}
