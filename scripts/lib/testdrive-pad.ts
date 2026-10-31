// The pure parts of scripts/testdrive-pad.ts: what the virtual pad presses,
// which main-menu row each press has to land on, and the page expressions that
// read the answer back. Split out so tests/testdrive_pad_test.ts can pin them
// without a bus or a browser.

import { type Ds4State, SONY_VENDOR_ID } from "./vigem.ts";

/** The launcher's main menu, top to bottom — MAIN_MENU in svelte-src/Dashboard.svelte. */
export const MAIN_MENU_LABELS = ["Games", "eShop", "Settings", "Desktop"];

export interface PadStep {
  label: string;
  press: Ds4State;
  /** The row the selection has to be on afterwards, 0 = Games. */
  want: number;
}

/**
 * Chrome shows a page no pad at all until one has been used, so the drive's
 * first input only unlocks it. Stick right, because on the main menu
 * left/right mean nothing (the dashboard declares no moveH) and the selection
 * has to still be on Games afterwards — which is itself checked.
 */
export const UNLOCK_PRESS: Ds4State = { lx: 0xFF };

/**
 * Down twice, up once, the left stick down and up, then up to the top. Every
 * press is one row, and none of them crosses an end of the list: a fresh press
 * there wraps (navMove), and then "one row" no longer means one row.
 */
export const MENU_STEPS: PadStep[] = [
  { label: "D-pad down", press: { dpad: "S" }, want: 1 },
  { label: "D-pad down", press: { dpad: "S" }, want: 2 },
  { label: "D-pad up", press: { dpad: "N" }, want: 1 },
  { label: "left stick down", press: { ly: 0xFF }, want: 2 },
  { label: "left stick up", press: { ly: 0x00 }, want: 1 },
  { label: "D-pad up", press: { dpad: "N" }, want: 0 },
];

export interface MenuRead {
  rows: number;
  sel: number;
  label: string | null;
  /** performance.timeOrigin: changes when the page reloads under the drive. */
  doc: number;
}

/** Reads the main menu's rows and which one is selected. */
export const MENU_EXPR = `(() => {
  const items = [...document.querySelectorAll('[aria-label="Main menu"] .item')];
  const sel = items.findIndex((e) => e.classList.contains('sel'));
  const label = sel < 0 ? null : (items[sel].querySelector('.bar span')?.textContent ?? '').trim();
  return { rows: items.length, sel, label, doc: performance.timeOrigin };
})()`;

export interface PadRead {
  index: number;
  id: string;
  mapping: string;
  buttons: number;
  axes: number;
}

/** Every pad the page can see, as the launcher's own poll sees them. */
export const PADS_EXPR =
  `[...((navigator.getGamepads && navigator.getGamepads()) || [])].filter(Boolean)` +
  `.map((p) => ({ index: p.index, id: p.id, mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length }))`;

/**
 * Is this Gamepad.id the Sony pad with this product id? Chrome spells it
 * "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)", Firefox
 * "54c-9cc-Wireless Controller".
 */
export function padIdMatches(
  id: string,
  product: number,
  vendor = SONY_VENDOR_ID,
): boolean {
  const v = vendor.toString(16);
  const p = product.toString(16);
  return new RegExp(
    `Vendor:\\s*0*${v}\\s+Product:\\s*0*${p}\\b|(^|\\b)0*${v}-0*${p}-`,
    "i",
  ).test(id);
}

/**
 * A sampler the drive leaves running in the page: every 4 ms it counts which
 * directions the pads read, as the launcher's own poll would read them. Taken
 * per press (TRACE_TAKE), it tells a press the menu missed from a press the
 * page never got — one is the launcher's bug, the other is the delivery's.
 */
export const TRACE_INSTALL = `(() => {
  if (window.__padTrace) return true;
  const t = window.__padTrace = { seen: {} };
  const bump = (k) => { t.seen[k] = (t.seen[k] || 0) + 1; };
  // The launcher polls pads from requestAnimationFrame, so a press is only as
  // visible to it as frames are being drawn: count them, the longest gap, and
  // the frames drawn while some direction was held — each of those is a frame
  // the launcher's own poll had the press in hand.
  let lastFrame = 0;
  const frame = (now) => {
    bump('frames');
    if (lastFrame) t.seen.maxGapMs = Math.max(t.seen.maxGapMs || 0, Math.round(now - lastFrame));
    lastFrame = now;
    for (const p of (navigator.getGamepads && navigator.getGamepads()) || []) {
      if (!p) continue;
      const b = (i) => p.buttons[i] && p.buttons[i].pressed;
      if (b(12) || b(13) || b(14) || b(15) || Math.abs(p.axes[0] || 0) > 0.5 || Math.abs(p.axes[1] || 0) > 0.5) {
        bump('heldFrames');
        break;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => {
    bump('samples');
    for (const p of (navigator.getGamepads && navigator.getGamepads()) || []) {
      if (!p) continue;
      if (p.buttons[12] && p.buttons[12].pressed) bump('dpadUp');
      if (p.buttons[13] && p.buttons[13].pressed) bump('dpadDown');
      const y = p.axes[1] || 0;
      if (y < -0.5) bump('stickUp');
      if (y > 0.5) bump('stickDown');
    }
  }, 4);
  return true;
})()`;

/**
 * How many frames the page has drawn with the press held, since the last take.
 *
 * WHY A PRESS IS HELD UNTIL THIS REACHES TWO, AND NOT FOR A FIXED TIME. The
 * launcher reads pads once per animation frame, and a headless Chrome without
 * a GPU draws the dashboard at 4-8 fps here — frame gaps of 100-350 ms. A
 * 150 ms tap fell between two frames often enough that one drive in three
 * failed, every time on a press the page HAD read for 150+ ms, and none of it
 * was the launcher's input logic. Held until two frames have seen it, a press
 * reaches that logic whatever the frame rate, so a miss means the logic.
 */
export const HELD_FRAMES_EXPR =
  `(window.__padTrace && window.__padTrace.seen.heldFrames) || 0`;
export const HELD_FRAMES = 2;

/** What the sampler counted since the last take, and a fresh count from now. */
export const TRACE_TAKE =
  `(() => { const t = window.__padTrace; if (!t) return null; const s = t.seen; t.seen = {}; return s; })()`;

/** What one press did, judged: the row it had to land on, and where it did. */
export interface StepResult {
  label: string;
  from: number;
  want: number;
  got: number;
  ok: boolean;
  /** Set when the row changed and then changed again — one press, two moves. */
  moved: number[];
}

export function judgeStep(
  step: PadStep,
  from: number,
  seen: number[],
): StepResult {
  const got = seen.length ? seen[seen.length - 1] : from;
  return {
    label: step.label,
    from,
    want: step.want,
    got,
    ok: got === step.want && seen.length <= 1,
    moved: seen,
  };
}
