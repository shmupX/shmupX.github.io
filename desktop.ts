// desktop.ts — entry point of the packaged desktop launcher.
//
// `deno task build:windows` / `deno task build:linux` compile this file with
// `deno compile` (see scripts/build-desktop.ts) into one self-contained binary
// that serves the built Fresh app on loopback and opens it in the browser. The
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

interface FetchServer {
  fetch(
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Response | Promise<Response>;
}

const DEFAULT_PORT = 8787;
const HOSTNAME = Deno.env.get("SHMUPX_HOST") ?? "127.0.0.1";

function parseArgs(argv: string[]): { port?: number; open: boolean } {
  let port: number | undefined;
  let open = !Deno.env.get("SHMUPX_NO_OPEN");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") open = false;
    else if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }
  return { port, open };
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

function openInBrowser(url: string): void {
  const [cmd, args] = Deno.build.os === "windows"
    ? ["cmd", ["/c", "start", "", url]]
    : Deno.build.os === "darwin"
    ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = new Deno.Command(cmd as string, {
      args: args as string[],
      stdout: "null",
      stderr: "null",
    }).spawn();
    // Don't let a browser that stays attached to its launcher keep us alive.
    child.unref();
  } catch (err) {
    console.error(`Could not open a browser (${(err as Error).message}).`);
    console.error(`Open ${url} yourself.`);
  }
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

const { port: portArg, open } = parseArgs(Deno.args);
const envPort = Number(Deno.env.get("SHMUPX_PORT") ?? "");
const requested = portArg ??
  (Number.isFinite(envPort) && envPort > 0 ? envPort : undefined);
// An explicitly requested port is used as-is (and fails loudly if taken); only
// the default gets the scan-for-a-free-one treatment.
const port = requested ?? pickPort(DEFAULT_PORT);

const server = await loadServer();

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // SIGTERM isn't supported on Windows — registering it there throws.
  if (Deno.build.os === "windows" && signal === "SIGTERM") continue;
  Deno.addSignalListener(signal, () => shutdown.abort());
}

const httpServer = Deno.serve({
  hostname: HOSTNAME,
  port,
  signal: shutdown.signal,
  onListen: ({ hostname, port }) => {
    const url = `http://${hostname}:${port}/`;
    console.log(`\n  shmupX — codemonkey.games\n  ${url}\n`);
    console.log("  Press Ctrl+C to quit.\n");
    if (open) openInBrowser(url);
  },
}, (req, info) => server.fetch(req, info));

await httpServer.finished;
