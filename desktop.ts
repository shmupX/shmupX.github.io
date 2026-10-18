// desktop.ts — entry point of the packaged desktop launcher.
//
// `deno task build:windows` / `build:linux` / `build:mac` package this file
// (see scripts/build-desktop.ts), by one of two routes:
//
//   * Windows — `deno compile`, into one self-contained .exe. It has no engine
//     of its own, so it borrows a browser for its window: a kiosk on a
//     dedicated profile where it can (lib/desktop-browser.ts says how one is
//     chosen), the system default otherwise.
//   * Linux and macOS — `deno desktop --backend cef`, which brings its own
//     Chromium and points it at the Deno.serve below. Nothing is borrowed, and
//     the artifact is an .AppImage or a .app that cross-builds from any host.
//
// Either way, closing the window quits the launcher, which is what Steam needs
// to see the "game" end; --keep-serving keeps the build server up regardless.
//
// A favorite's own Steam entry (lib/steam-favorites.ts) starts this same file
// with --game <section>:<row> or --play <shelf slug>: the dashboard opens that
// game straight away (routes/api/launch.ts), and leaving the game quits the
// launcher, window and all. The favorites are synced into Steam at startup and
// on the way out as well as whenever one changes; --steam-sync does just that
// and exits, for a run with Steam closed. The Steam build carries a marker
// (lib/launcher-flavor.ts) that is read here first, before the server loads,
// since that is what tells the server where its member content comes from. The
// same binary is what routes/api/build-apk.ts calls "the packaged desktop app":
// the tool + game it stages out of the read-only deno-compile VFS are embedded
// here by the `--include` flags the build script passes.
//
// The built server is pulled in with a *runtime* dynamic import rather than a
// static one on purpose: `_fresh/` is git-ignored and absent on a fresh clone,
// so a static `import ... from "./_fresh/server.js"` would fail `deno task
// check` before anyone has run a build. The build script passes
// `--include ./_fresh/server.js`, which puts that module and its whole graph
// (server-entry.mjs + the per-route chunks it imports) into the binary's VFS,
// where the specifier below resolves at startup.

import {
  type DesktopOs,
  launcherDataDir,
  openLauncherWindow,
} from "./lib/desktop-browser.ts";
import { currentLauncherBinary } from "./lib/launcher-binary.ts";
import { FLAVOR_FILE, readFlavorFile } from "./lib/launcher-flavor.ts";
import { readKept } from "./lib/kept-storage.ts";
import { enterNativeFullscreen } from "./lib/macos-fullscreen.ts";
import { keepSteamInputOff } from "./lib/steam-input.ts";
import { startAutoUpdate } from "./lib/self-update.ts";
import { restoreDisplays, restoreDisplaysSync } from "./lib/second-screen.ts";
import {
  localRunOptions,
  runFavoritesSync,
  type SyncReport,
} from "./lib/steam-favorites.ts";

interface FetchServer {
  fetch(
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Response | Promise<Response>;
}

const DEFAULT_PORT = 8787;
const HOSTNAME = Deno.env.get("SHMUPX_HOST") ?? "127.0.0.1";
const OS: DesktopOs = Deno.build.os === "windows"
  ? "windows"
  : Deno.build.os === "darwin"
  ? "darwin"
  : "linux";

// `deno desktop` (Linux and macOS, see scripts/build-desktop.ts) supplies the
// window itself: it binds this file's Deno.serve to an address of its own and
// points a CEF window at it. Only the `deno compile` builds — Windows, and any
// --no-window run — still have to go and find a browser to borrow.
//
// Deno.BrowserWindow is the tell: it exists only under `deno desktop`. The same
// runtime also exports DENO_SERVE_ADDRESS, which Deno.serve honours over the
// port below — so --port / SHMUPX_PORT are no-ops there, and pickPort would be
// scanning for a port nothing is going to use.
const UNDER_DENO_DESKTOP =
  typeof (Deno as { BrowserWindow?: unknown }).BrowserWindow === "function";

// The Steam build. Only a packaged app reads the marker: a checkout that once
// ran a Steam build still has the file under build/, and is not the Steam
// build for it. Steam ships this copy's updates, so the updater stays off.
const STANDALONE = (Deno.build as { standalone?: boolean }).standalone === true;
if (
  STANDALONE && readFlavorFile(new URL(`./${FLAVOR_FILE}`, import.meta.url))
) {
  Deno.env.set("SHMUPX_FLAVOR", "steam");
  Deno.env.set("SHMUPX_NO_UPDATE", "1");
}

interface Args {
  port?: number;
  open: boolean;
  /** A normal window rather than a fullscreen kiosk (SHMUPX_WINDOWED). */
  windowed: boolean;
  /** Stay up after the window closes (SHMUPX_KEEP_SERVING). */
  keepServing: boolean;
  /** --steam-sync: put the favorites in Steam, and exit. */
  syncOnly: boolean;
}

// The one game to open (routes/api/launch.ts reads these), and where else to
// look for member packs (lib/member-packs.ts). Environment variables, because
// the built server is a module graph of its own and reads them from there.
const VALUE_FLAGS: Record<string, (value: string) => void> = {
  "--game": (v) => Deno.env.set("SHMUPX_LAUNCH_GAME", v),
  "--play": (v) => Deno.env.set("SHMUPX_LAUNCH_PLAY", v),
  "--members": (v) => {
    const before = Deno.env.get("SHMUPX_MEMBERS");
    const sep = Deno.build.os === "windows" ? ";" : ":";
    Deno.env.set("SHMUPX_MEMBERS", before ? `${v}${sep}${before}` : v);
  },
};

function parseArgs(argv: string[]): Args {
  const env = Deno.env;
  const args: Args = {
    open: !env.get("SHMUPX_NO_OPEN"),
    windowed: !!env.get("SHMUPX_WINDOWED"),
    keepServing: !!env.get("SHMUPX_KEEP_SERVING"),
    syncOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value) VALUE_FLAGS[flag](value);
    } else if (arg === "--steam-sync") args.syncOnly = true;
    else if (arg === "--no-open") args.open = false;
    else if (arg === "--windowed") args.windowed = true;
    else if (arg === "--keep-serving") args.keepServing = true;
    else if (arg === "--browser" && argv[i + 1]) {
      // Same knob as the environment variable; the module reads it from there.
      env.set("SHMUPX_BROWSER", argv[++i]);
    } else if (arg.startsWith("--browser=")) {
      env.set("SHMUPX_BROWSER", arg.slice("--browser=".length));
    } else if (arg === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) {
      args.port = Number(arg.slice("--port=".length));
    }
  }
  return args;
}

// First port in [start, start+range) nothing else is listening on. A bound-then-
// closed port can in principle be taken in the gap before Deno.serve grabs it,
// but for a desktop app that beats failing outright because 8787 is busy.
function pickPort(start: number, range = 32): number {
  for (let port = start; port < start + range; port++) {
    try {
      const listener = Deno.listen({ hostname: HOSTNAME, port });
      listener.close();
      return port;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  return 0; // let the OS assign one
}

async function loadServer(): Promise<FetchServer> {
  const specifier = new URL("./_fresh/server.js", import.meta.url).href;
  try {
    const mod = await import(specifier);
    return mod.default as FetchServer;
  } catch (err) {
    console.error(
      "Could not load the built Fresh server from this binary: " +
        (err as Error).message,
    );
    console.error(
      "The binary was compiled without `--include ./_fresh/server.js`, or " +
        "`deno task build` had not been run when it was compiled.",
    );
    Deno.exit(1);
  }
}

const { port: portArg, open, windowed, keepServing, syncOnly } = parseArgs(
  Deno.args,
);

/** One favorites sync, said in a line; never a reason to fail. */
async function syncFavorites(origin?: string): Promise<SyncReport | null> {
  try {
    const opts = await localRunOptions(origin);
    const report = await runFavoritesSync(
      opts,
      (await readKept(opts.keptFile)).values,
    );
    if (report.added.length || report.removed.length || !report.ok) {
      console.log(
        report.ok
          ? `  Steam favorites: +${report.added.length} −${report.removed.length}` +
            (report.steamRunning ? " (restart Steam to see them)" : "")
          : `  Steam favorites: ${
            report.reason ?? report.problems[0] ?? "not synced"
          }`,
      );
    }
    return report;
  } catch (err) {
    console.warn(`  Steam favorites: ${(err as Error).message}`);
    return null;
  }
}

if (syncOnly) {
  const report = await syncFavorites();
  console.log(
    report?.ok
      ? `  ${report.favorites} favorite(s) in Steam, ${report.accounts} account(s).`
      : "  Nothing was written.",
  );
  Deno.exit(report?.ok ? 0 : 1);
}
const envPort = Number(Deno.env.get("SHMUPX_PORT") ?? "");
const requested = portArg ??
  (Number.isFinite(envPort) && envPort > 0 ? envPort : undefined);
// An explicitly requested port is used as-is (and fails loudly if taken); only
// the default gets the scan-for-a-free-one treatment.
// Under `deno desktop` the address is DENO_SERVE_ADDRESS's to choose, so there
// is nothing to scan for and nothing to honour.
const port = UNDER_DENO_DESKTOP ? DEFAULT_PORT : requested ?? pickPort(
  DEFAULT_PORT,
);

const server = await loadServer();

const shutdown = new AbortController();
// Closes a browser this process owns (lib/desktop-browser.ts).
const closeWindow = new AbortController();
let quitRequested = false;
// The quit routes/api/launch.ts calls when the one game this launcher was
// started for ends. On globalThis because that route lives in the built
// server's module graph, not this one.
(globalThis as { __shmupxQuit?: () => void }).__shmupxQuit = () => {
  if (quitRequested) return;
  quitRequested = true;
  console.log("\n  Game closed — quitting.\n");
  closeWindow.abort();
  shutdown.abort();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // SIGTERM isn't supported on Windows — registering it there throws.
  if (Deno.build.os === "windows" && signal === "SIGTERM") continue;
  Deno.addSignalListener(signal, () => shutdown.abort());
}

// Turn this desktop into a build server for exports queued from a phone, the
// hosted site or the PWA (lib/export-worker.ts). Asked of the built server
// through its own route rather than by importing the worker here: the route
// module inside _fresh/server.js is the copy the dashboard talks to, and going
// through it keeps exactly one worker in the process. The dashboard would do
// the same GET when it opens; this covers --no-open and a closed browser tab.
// Nothing in the request names an origin, so the route's cross-site gate lets
// it through; a worker the user switched off in Settings stays off.
async function startBuildServer(): Promise<void> {
  try {
    const res = await server.fetch(
      new Request("http://127.0.0.1/api/export-worker"),
    );
    const status = await res.json();
    if (!res.ok || !status.ok) {
      console.error(`  Build server: ${status.error ?? `HTTP ${res.status}`}`);
    } else if (!status.running) {
      console.log(
        "  Build server: off (switch it on in Settings → BUILD SERVER)\n",
      );
    }
  } catch (err) {
    console.error(`  Build server: ${(err as Error).message}`);
  }
}

// The window. A browser this process owns reports back when the player closes
// it, and that ends the launcher — unless it is meant to stay up as a build
// server (--keep-serving). The system opener reports nothing, so that path
// keeps the old behaviour: the server runs until Ctrl+C.
async function openWindow(url: string): Promise<void> {
  const outcome = await openLauncherWindow(url, {
    os: OS,
    env: Deno.env.toObject(),
    dataDir: launcherDataDir(OS, Deno.env.toObject()),
    windowed,
    log: console.log,
    signal: closeWindow.signal,
  });
  if (outcome !== "closed") return;
  if (keepServing) {
    console.log("\n  Window closed; still serving (--keep-serving).\n");
    return;
  }
  console.log("\n  Window closed — quitting.\n");
  shutdown.abort();
}

// Which file this launcher is, read once and outside the handler: it decides
// whether the updater can patch in place (an AppImage cannot) and it is what
// "Add to Steam" would point at. Cheap, and a throw here must not sink boot.
let launcherFile: ReturnType<typeof currentLauncherBinary> = null;
try {
  launcherFile = currentLauncherBinary();
} catch (_e) {
  launcherFile = null;
}

const httpServer = Deno.serve({
  hostname: HOSTNAME,
  port,
  signal: shutdown.signal,
  onListen: ({ hostname, port }) => {
    const url = `http://${hostname}:${port}/`;
    const version = (Deno as { desktopVersion?: string | null }).desktopVersion;
    console.log(
      `\n  shmupX${
        version ? ` ${version}` : ""
      } — codemonkey.games\n  ${url}\n`,
    );
    console.log("  Press Ctrl+C to quit.\n");
    // Keep this copy current on its own. `deno desktop` fetches a signed bsdiff
    // of the runtime rather than a whole download and stages it for the next
    // launch, rolling back by itself if that launch fails — so the player who
    // added this file to Steam once never has to think about it again. Off in
    // a source checkout and in the Windows `deno compile` build, which has no
    // updater; lib/self-update.ts says which cases and why.
    startAutoUpdate({
      env: Deno.env.toObject(),
      target: Deno.build.target,
      version: version ?? null,
      underDesktop: UNDER_DENO_DESKTOP,
      // Which file this is running from decides whether it CAN patch itself:
      // an AppImage is a read-only mount and cannot.
      binaryKind: launcherFile?.kind ?? null,
    });
    // Under `deno desktop` the window is already on screen and owns the
    // process' lifetime; borrowing a browser on top of it would put the
    // launcher up twice.
    if (open && !UNDER_DENO_DESKTOP) openWindow(url);
    // That window opens as an ordinary one, and on macOS nothing but the
    // window itself can make it fullscreen — the page's request needs a click
    // a pad player launching from Big Picture never makes. --windowed keeps it
    // a window, as it does the borrowed browsers.
    if (UNDER_DENO_DESKTOP && OS === "darwin" && !windowed) {
      enterNativeFullscreen({ log: console.log });
    }
    startBuildServer();
    // Favorites that changed while this launcher was not running — starred
    // on another copy's shelf, or entries Steam dropped — are put back now.
    // Then, on macOS, Steam Input goes off for every shmupX entry that has no
    // setting of the player's own: Steam has no virtual pad to hand the
    // launcher there, and holds on to the real one (lib/steam-input.ts). Only
    // possible while Steam is closed, so it waits for that if it has to.
    if (STANDALONE) {
      syncFavorites(url).then(() => {
        if (OS !== "darwin") return;
        let execPath = "";
        try {
          execPath = Deno.execPath();
        } catch { /* matched on the entries' tags instead */ }
        return keepSteamInputOff({
          os: OS,
          env: Deno.env.toObject(),
          exes: [launcherFile?.path ?? "", execPath],
        }, console.log);
      }).catch((err) => console.warn(`  Steam Input: ${err.message}`));
    }
  },
}, (req, info) => server.fetch(req, info));

// The controller screen (lib/second-screen.ts) may have turned the built-in
// panel on for a game; the launcher going away must not leave it that way. The
// server's copy of that module keeps its undo on globalThis, where this copy
// reads it — once on an orderly shutdown, and synchronously on `unload` for an
// exit nothing else saw coming (the last window closed under `deno desktop`).
globalThis.addEventListener("unload", () => restoreDisplaysSync());

await httpServer.finished;
await restoreDisplays();
// And on the way out, which is when RetroDECK syncs its own: the last word
// before Steam next reads its library. Bounded, so a slow network never holds
// the exit Steam is waiting to see.
if (STANDALONE) {
  await Promise.race([
    syncFavorites(),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
}
// Under `deno desktop` the CEF window outlives the server it shows unless the
// process ends: a launcher started for one game has to go when the game does.
if (quitRequested) Deno.exit(0);
