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
// to see the "game" end; --keep-serving keeps the build server up regardless. The
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

interface Args {
  port?: number;
  open: boolean;
  /** A normal window rather than a fullscreen kiosk (SHMUPX_WINDOWED). */
  windowed: boolean;
  /** Stay up after the window closes (SHMUPX_KEEP_SERVING). */
  keepServing: boolean;
}

function parseArgs(argv: string[]): Args {
  const env = Deno.env;
  const args: Args = {
    open: !env.get("SHMUPX_NO_OPEN"),
    windowed: !!env.get("SHMUPX_WINDOWED"),
    keepServing: !!env.get("SHMUPX_KEEP_SERVING"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") args.open = false;
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

const { port: portArg, open, windowed, keepServing } = parseArgs(Deno.args);
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
  });
  if (outcome !== "closed") return;
  if (keepServing) {
    console.log("\n  Window closed; still serving (--keep-serving).\n");
    return;
  }
  console.log("\n  Window closed — quitting.\n");
  shutdown.abort();
}

const httpServer = Deno.serve({
  hostname: HOSTNAME,
  port,
  signal: shutdown.signal,
  onListen: ({ hostname, port }) => {
    const url = `http://${hostname}:${port}/`;
    console.log(`\n  shmupX — codemonkey.games\n  ${url}\n`);
    console.log("  Press Ctrl+C to quit.\n");
    // Under `deno desktop` the window is already on screen and owns the
    // process' lifetime; borrowing a browser on top of it would put the
    // launcher up twice.
    if (open && !UNDER_DENO_DESKTOP) openWindow(url);
    startBuildServer();
  },
}, (req, info) => server.fetch(req, info));

await httpServer.finished;
