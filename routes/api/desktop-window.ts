import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";

// /api/desktop-window — open a second window of the packaged desktop app.
//
//   GET   { available } — is this the launcher, i.e. can it open one?
//   POST  { url, title?, width?, height?, key? } → { ok, reused }
//
// `window.open()` is useless inside the launcher. Under `deno desktop
// --backend cef` (the macOS and Linux packaging route, see desktop.ts) it
// returns null to the page, and the window that does appear is outside the
// app's storage jar and has no opener. That breaks the level editor's hand-off
// to the game, which travels entirely through storage: the recipe in
// localStorage, the atlas in IndexedDB. A game opened that way finds neither
// and falls back to the shipped foo.json — so the editor shows an imported
// Dezaemon save while the new window plays the stock level.
//
// A window the launcher process opens *itself* has neither problem: same CEF
// profile, so localStorage and IndexedDB are the same stores, and the query
// string survives. Deno.BrowserWindow is the constructor the launcher already
// uses for its own window, and its existence is the same "are we under `deno
// desktop`" tell desktop.ts keys on.
//
// LOCAL-ONLY, SAME-ORIGIN-ONLY: the hosted deploy and a source checkout opened
// in an ordinary browser answer { available: false } and open nothing — those
// hosts have a working window.open and do not need this. The address must be
// this origin's own: a chromeless app window pointed wherever a page asks is a
// phishing surface, so a foreign URL is refused rather than clamped.

/** The slice of `deno desktop`'s window object this route uses. */
interface LauncherWindow {
  navigate(url: string): void;
  show(): void;
  focus(): void;
  isClosed(): boolean;
  setTitle(title: string): void;
  setSize(width: number, height: number): void;
}

type LauncherWindowCtor = new (
  options: Record<string, unknown>,
) => LauncherWindow;

function browserWindowCtor(): LauncherWindowCtor | null {
  const ctor = (Deno as { BrowserWindow?: unknown }).BrowserWindow;
  return typeof ctor === "function" ? ctor as LauncherWindowCtor : null;
}

/** Can this process put a second launcher window on screen? */
export function launcherWindowsAvailable(): boolean {
  return !isDeploy() && browserWindowCtor() !== null;
}

// One window per key, reused the way following a link reuses a browser tab —
// playing a stage twenty times should not leave twenty windows behind. A
// window the player closed reads as closed and is replaced.
const windows = new Map<string, LauncherWindow>();

const DEFAULT_KEY = "play";
// The game is a 256x480 portrait canvas; this is that shape with room for the
// window frame. Anything the caller asks for is clamped to something that
// still fits on a laptop display.
const DEFAULT_SIZE = { width: 540, height: 940 };
const MIN_EDGE = 240;
const MAX_EDGE = 4096;

function clampEdge(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_EDGE, Math.max(MIN_EDGE, Math.round(n)));
}

/**
 * Resolve `raw` against the address this request came in on, and return it
 * only if it lands on that same origin. Relative URLs ("/games/2028-ai?…",
 * which is what the editor sends) are the normal case.
 */
export function sameOriginTarget(raw: unknown, requestUrl: string): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const here = new URL(requestUrl);
  let target: URL;
  try {
    target = new URL(raw, here);
  } catch {
    return null;
  }
  return target.origin === here.origin ? target : null;
}

export const handler = define.handlers({
  GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    return Response.json({ available: launcherWindowsAvailable() });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;

    const ctor = browserWindowCtor();
    if (!ctor) {
      return Response.json({
        ok: false,
        error: "Not running under the desktop launcher.",
      }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Expected a JSON body." }, {
        status: 400,
      });
    }

    const target = sameOriginTarget(body.url, ctx.req.url);
    if (!target) {
      return Response.json({
        ok: false,
        error: "url must be an address on this origin.",
      }, { status: 400 });
    }

    const key = typeof body.key === "string" && body.key
      ? body.key
      : DEFAULT_KEY;
    const title = typeof body.title === "string" && body.title
      ? body.title.slice(0, 120)
      : "shmupX";
    const width = clampEdge(body.width, DEFAULT_SIZE.width);
    const height = clampEdge(body.height, DEFAULT_SIZE.height);

    try {
      const existing = windows.get(key);
      if (existing && !existing.isClosed()) {
        existing.setTitle(title);
        existing.navigate(target.href);
        existing.show();
        existing.focus();
        return Response.json({ ok: true, reused: true });
      }
      const win = new ctor({});
      win.setTitle(title);
      win.setSize(width, height);
      win.navigate(target.href);
      win.show();
      windows.set(key, win);
      return Response.json({ ok: true, reused: false });
    } catch (e) {
      // A window that cannot be opened is reported rather than thrown: the
      // editor falls back to window.open, which is no worse than before.
      windows.delete(key);
      return Response.json({ ok: false, error: (e as Error).message }, {
        status: 500,
      });
    }
  },
});
