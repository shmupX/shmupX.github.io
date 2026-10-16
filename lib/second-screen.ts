// lib/second-screen.ts — the desktop launcher's controller screen.
//
// While a game is up on a monitor and no pad is in hand, the machine's own
// touchscreen can be the controller: lib/display-layout.ts brings the
// built-in panel up beside the monitor, and a second launcher window, frameless
// and kept on top, shows static/virtual-pad/index.html across it. That page and
// the launcher's window are one origin in one browser, so the pad's state goes
// straight across a BroadcastChannel into the game frame (Dashboard.svelte,
// "Touch Controller") — this module only arranges the screens and the window.
//
// The window is `deno desktop`'s Deno.BrowserWindow — the same constructor
// routes/api/desktop-window.ts opens the editor's play window with, and only
// there (the Linux and macOS builds) does it exist. This module is bundled into
// the Fresh server (routes/api/second-screen.ts), a separate copy of the code
// from desktop.ts's, so what has to be undone when the launcher quits — the
// display commands — is kept on globalThis, where desktop.ts's own copy can
// find it on the way out.

import {
  applyCommands,
  detectOutputs,
  type DisplayOutput,
  planExtend,
  unsupportedReason,
} from "./display-layout.ts";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of `deno desktop`'s window object this module uses. */
interface ControllerWindow extends EventTarget {
  navigate(url: string): void;
  show(): void;
  close(): void;
  isClosed(): boolean;
  setPosition(x: number, y: number): void;
  setSize(width: number, height: number): void;
  setAlwaysOnTop?(on: boolean): void;
  setTitle?(title: string): void;
}

type ControllerWindowCtor = new (
  options: Record<string, unknown>,
) => ControllerWindow;

function browserWindowCtor(): ControllerWindowCtor | null {
  const ctor = (Deno as { BrowserWindow?: unknown }).BrowserWindow;
  return typeof ctor === "function" ? ctor as ControllerWindowCtor : null;
}

interface SharedState {
  window: ControllerWindow | null;
  open: boolean;
  /** Display commands that undo what opening changed. */
  restore: string[][];
  busy: Promise<unknown>;
}

const KEY = "__shmupxSecondScreen";

function shared(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>;
  return g[KEY] ??= {
    window: null,
    open: false,
    restore: [],
    busy: Promise.resolve(),
  };
}

/**
 * Put the controller page on `rect`: frameless, on top, the whole panel. One
 * window, reused — a second open moves and re-points it.
 */
function showController(rect: ScreenRect, url: string): void {
  const ctor = browserWindowCtor();
  if (!ctor) throw new Error("not running under the desktop launcher");
  const s = shared();
  let win = s.window && !s.window.isClosed() ? s.window : null;
  if (!win) {
    win = new ctor({
      title: "shmupX Controller",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      frameless: true,
      alwaysOnTop: true,
      resizable: false,
      noActivate: true,
    });
    // Closed by hand (Alt+F4, the compositor): the screens go back too.
    const created = win;
    created.addEventListener("close", () => {
      if (shared().window === created) shared().window = null;
      noteControllerClosed();
    });
    s.window = win;
  }
  win.setPosition(rect.x, rect.y);
  win.setSize(rect.width, rect.height);
  try {
    win.setAlwaysOnTop?.(true);
  } catch (_e) { /* creation option already said so */ }
  win.navigate(url);
  win.show();
}

function hideController(): void {
  const s = shared();
  const win = s.window;
  s.window = null;
  if (win && !win.isClosed()) {
    try {
      win.close();
    } catch (_e) { /* already going */ }
  }
}

/** One change at a time: open and close both rearrange the same screens. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const s = shared();
  const next = s.busy.then(fn, fn);
  s.busy = next.catch(() => {});
  return next;
}

function rectOf(o: DisplayOutput): ScreenRect {
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

export interface SecondScreenStatus {
  /** Whether this launcher can show a controller screen at all. */
  available: boolean;
  reason?: string;
  /** A monitor is connected and lit. */
  external: boolean;
  /** The built-in screen is on (it has to be turned on to be used). */
  internalEnabled: boolean;
  open: boolean;
}

export async function secondScreenStatus(): Promise<SecondScreenStatus> {
  const s = shared();
  const base = { external: false, internalEnabled: false, open: s.open };
  if (!browserWindowCtor()) {
    return {
      ...base,
      available: false,
      reason: "needs the packaged desktop launcher (Linux AppImage)",
    };
  }
  const reason = unsupportedReason(Deno.build.os, Deno.env.toObject());
  if (reason) return { ...base, available: false, reason };
  const found = await detectOutputs();
  if (!found) {
    return {
      ...base,
      available: false,
      reason: "cannot read the display layout (no kscreen-doctor or xrandr)",
    };
  }
  const external = found.outputs.some((o) =>
    o.connected && o.enabled && !o.internal
  );
  const internal = found.outputs.find((o) => o.connected && o.internal);
  if (!internal) {
    return {
      ...base,
      external,
      available: false,
      reason: "this machine has no built-in screen",
    };
  }
  return {
    ...base,
    available: true,
    external,
    internalEnabled: internal.enabled,
  };
}

/**
 * Bring the built-in screen up and show the controller on it.
 *
 * `origin` is the launcher page's own origin — the controller page must share
 * it for the BroadcastChannel to reach the game.
 */
export function openSecondScreen(opts: {
  origin: string;
  layout: string;
  title?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return serial(async () => {
    const s = shared();
    if (!browserWindowCtor()) {
      return { ok: false, reason: "not a desktop launcher" };
    }
    const reason = unsupportedReason(Deno.build.os, Deno.env.toObject());
    if (reason) return { ok: false, reason };
    const found = await detectOutputs();
    if (!found) return { ok: false, reason: "cannot read the display layout" };
    const plan = planExtend(found.outputs, found.backend);
    if ("error" in plan) return { ok: false, reason: plan.error };

    let internal = plan.internal;
    if (plan.apply.length) {
      const failed = await applyCommands(plan.apply);
      if (failed) return { ok: false, reason: failed };
      // Remember the undo the moment the change lands, so even a failure
      // below — or the launcher quitting — still puts the screens back.
      s.restore = plan.restore;
      // The compositor applies the change asynchronously; read back where
      // the panel really landed (scale and rotation are its own) before
      // placing a window on it.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const again = await detectOutputs();
        const lit = again?.outputs.find((o) =>
          o.name === plan.internal.name && o.enabled
        );
        if (lit && lit.width > 0) {
          internal = lit;
          break;
        }
      }
    }

    const url = new URL("/virtual-pad/index.html", opts.origin);
    url.searchParams.set("layout", opts.layout === "twin" ? "twin" : "classic");
    if (opts.title) url.searchParams.set("title", opts.title.slice(0, 60));
    try {
      showController(rectOf(internal), url.href);
    } catch (e) {
      await restoreDisplays();
      return { ok: false, reason: (e as Error).message };
    }
    s.open = true;
    return { ok: true };
  });
}

/** Close the controller window and put the screens back. */
export function closeSecondScreen(): Promise<{ ok: boolean; reason?: string }> {
  return serial(async () => {
    const s = shared();
    s.open = false;
    hideController();
    const failed = await restoreDisplays();
    return failed ? { ok: false, reason: failed } : { ok: true };
  });
}

/**
 * Undo whatever opening changed. Safe to call any number of times, and from
 * desktop.ts on the way out.
 */
export async function restoreDisplays(): Promise<string | null> {
  const s = shared();
  const cmds = s.restore;
  s.restore = [];
  if (!cmds.length) return null;
  return await applyCommands(cmds);
}

/** desktop.ts: the controller window was closed by hand. */
export function noteControllerClosed(): void {
  const s = shared();
  if (!s.open) return;
  s.open = false;
  serial(() => restoreDisplays());
}

/**
 * The synchronous undo, for the process's own `unload` — the last moment there
 * is, and one where nothing asynchronous gets to finish.
 */
export function restoreDisplaysSync(): void {
  const s = shared();
  const cmds = s.restore;
  s.restore = [];
  for (const cmd of cmds) {
    try {
      new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        stdout: "null",
        stderr: "null",
      }).outputSync();
    } catch (_e) { /* best effort on the way out */ }
  }
}
