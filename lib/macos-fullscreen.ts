// lib/macos-fullscreen.ts — the macOS launcher's window, made fullscreen at
// launch.
//
// `deno desktop` opens the launcher in a plain window, and Deno.BrowserWindow
// has no fullscreen option to change that. The page used to ask through the
// Fullscreen API (Dashboard.svelte, requestLauncherFullscreen), which Chromium
// grants only with a real gesture — and a gamepad press is not one. Launched
// from Steam's Big Picture, which is itself a fullscreen Space, that left the
// player looking at a desktop window they could only fix with a mouse.
//
// So the window is asked natively instead: the same toggleFullScreen: the
// green button sends, which gives it a Space of its own. Everything goes
// through the Objective-C runtime over FFI, because nothing else in the process
// can reach the NSWindow. Two rules shape it:
//
//   * AppKit is main-thread only, and this script's thread is not the main one
//     (the CEF host owns that). Reads are harmless from here; anything that
//     changes a window is sent with performSelectorOnMainThread:.
//   * The window has to be on screen before it can go fullscreen, and nothing
//     tells this script when it is. It polls until a titled, visible window
//     exists, then asks — and checks afterwards, since a toggle sent while the
//     window is still animating in can be dropped.
//
// Picking the window is pure (pickLauncherWindow), so tests/macos_fullscreen_
// test.ts can check it without a Mac.

/** NSWindowStyleMaskTitled — a window with a title bar, as the launcher's is. */
export const STYLE_TITLED = 1 << 0;
/** NSWindowStyleMaskFullScreen — set while the window is in its own Space. */
export const STYLE_FULLSCREEN = 1 << 14;
/** NSWindowCollectionBehaviorFullScreenNone — the window opted out. */
export const BEHAVIOR_FULLSCREEN_NONE = 1 << 9;
/** NSWindowCollectionBehaviorFullScreenAuxiliary — it may only join another's. */
export const BEHAVIOR_FULLSCREEN_AUXILIARY = 1 << 8;

/** What the picker needs to know about one of NSApp's windows. */
export interface WindowFacts {
  visible: boolean;
  styleMask: number;
  /** NSWindowLevel; 0 is an ordinary document window. */
  level: number;
  collectionBehavior: number;
}

/**
 * Which of NSApp's windows is the launcher's, or -1 when none is up yet.
 *
 * CEF keeps a few of its own: borderless, often transparent, sometimes floated
 * above everything. The launcher's is the titled one at the normal level. A
 * second titled window (the editor's play window, the controller screen) can
 * only come later, from the page, so the first match is the launcher.
 */
export function pickLauncherWindow(windows: readonly WindowFacts[]): number {
  return windows.findIndex((w) =>
    w.visible && w.level === 0 && (w.styleMask & STYLE_TITLED) !== 0
  );
}

/** Whether a window can be given a fullscreen Space of its own. */
export function canGoFullscreen(w: WindowFacts): boolean {
  return (w.collectionBehavior &
    (BEHAVIOR_FULLSCREEN_NONE | BEHAVIOR_FULLSCREEN_AUXILIARY)) === 0;
}

export type FullscreenOutcome =
  | "entered"
  | "already"
  | "no-window"
  | "refused"
  | "unavailable";

export interface FullscreenOptions {
  /** How long to wait for the window to appear. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const encoder = new TextEncoder();
const cstr = (s: string) => encoder.encode(`${s}\0`);

/** The Objective-C runtime, with objc_msgSend bound once per signature used. */
function openObjc() {
  return Deno.dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { parameters: ["buffer"], result: "pointer" },
    sel_registerName: { parameters: ["buffer"], result: "pointer" },
    send: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer"],
      result: "pointer",
    },
    sendIndex: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer", "u64"],
      result: "pointer",
    },
    sendU64: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer"],
      result: "u64",
    },
    sendI64: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer"],
      result: "i64",
    },
    sendBool: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer"],
      result: "u8",
    },
    // performSelectorOnMainThread:withObject:waitUntilDone:
    sendOnMain: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer", "pointer", "pointer", "u8"],
      result: "void",
    },
  });
}

type Objc = ReturnType<typeof openObjc>;

function windowsOf(
  objc: Objc,
  sel: (name: string) => Deno.PointerValue,
): { handles: Deno.PointerValue[]; facts: WindowFacts[] } {
  const s = objc.symbols;
  const app = s.send(
    s.objc_getClass(cstr("NSApplication")),
    sel("sharedApplication"),
  );
  const handles: Deno.PointerValue[] = [];
  const facts: WindowFacts[] = [];
  if (!app) return { handles, facts };
  const list = s.send(app, sel("windows"));
  if (!list) return { handles, facts };
  const count = Number(s.sendU64(list, sel("count")));
  for (let i = 0; i < count; i++) {
    const w = s.sendIndex(list, sel("objectAtIndex:"), BigInt(i));
    if (!w) continue;
    handles.push(w);
    facts.push({
      visible: s.sendBool(w, sel("isVisible")) !== 0,
      styleMask: Number(s.sendU64(w, sel("styleMask"))),
      level: Number(s.sendI64(w, sel("level"))),
      collectionBehavior: Number(s.sendU64(w, sel("collectionBehavior"))),
    });
  }
  return { handles, facts };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Put the launcher's window into native fullscreen, once it is on screen.
 *
 * Never throws: a launcher that cannot go fullscreen is still a launcher, and
 * the page's own gesture-latched request remains as the fallback.
 */
export async function enterNativeFullscreen(
  options: FullscreenOptions = {},
): Promise<FullscreenOutcome> {
  const log = options.log ?? (() => {});
  if (Deno.build.os !== "darwin") return "unavailable";
  let objc: Objc;
  try {
    objc = openObjc();
  } catch (e) {
    log(`  Fullscreen: no Objective-C runtime (${(e as Error).message})`);
    return "unavailable";
  }
  try {
    const sels = new Map<string, Deno.PointerValue>();
    const sel = (name: string) => {
      let p = sels.get(name);
      if (p === undefined) {
        p = objc.symbols.sel_registerName(cstr(name));
        sels.set(name, p);
      }
      return p;
    };
    const onMain = (target: Deno.PointerValue, action: string) =>
      objc.symbols.sendOnMain(
        target,
        sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
        sel(action),
        null,
        0,
      );

    /** The launcher's window as it is right now, or null. */
    const launcher = () => {
      const { handles, facts } = windowsOf(objc, sel);
      const i = pickLauncherWindow(facts);
      return i < 0 ? null : { handle: handles[i], facts: facts[i] };
    };
    const isFullscreen = (w: { facts: WindowFacts }) =>
      (w.facts.styleMask & STYLE_FULLSCREEN) !== 0;

    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    let found = launcher();
    while (!found && Date.now() < deadline) {
      await sleep(150);
      found = launcher();
    }
    if (!found) {
      log("  Fullscreen: no launcher window appeared in time.");
      return "no-window";
    }
    if (isFullscreen(found)) return "already";
    if (!canGoFullscreen(found.facts)) {
      log("  Fullscreen: the launcher window does not allow it.");
      return "refused";
    }
    // A window that has only just appeared is still ordering in, and a toggle
    // sent then can be swallowed. Wait, ask, and only ask again once the first
    // request has plainly gone nowhere — a second toggle that lands mid-way
    // through the transition would take the window straight back out.
    await sleep(400);
    for (let tries = 0; tries < 3; tries++) {
      const now = launcher();
      if (!now) break;
      if (isFullscreen(now)) return "entered";
      onMain(now.handle, "makeKeyAndOrderFront:");
      onMain(now.handle, "toggleFullScreen:");
      for (let waited = 0; waited < 3000; waited += 150) {
        await sleep(150);
        const after = launcher();
        if (after && isFullscreen(after)) return "entered";
      }
    }
    log("  Fullscreen: the window did not go fullscreen when asked.");
    return "refused";
  } catch (e) {
    log(`  Fullscreen: ${(e as Error).message}`);
    return "unavailable";
  } finally {
    objc.close();
  }
}
