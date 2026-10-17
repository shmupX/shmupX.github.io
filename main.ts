import { App, staticFiles } from "fresh";
import { define, type State } from "./utils.ts";
import { injectLauncherMarker } from "./lib/launcher-inject.ts";
import { dirIndexRedirect } from "./lib/static-indexes.ts";
import {
  cloudLevelAliases,
  cloudLevelKeys,
  subdomainRedirect,
} from "./lib/level-subdomain.ts";
import { join } from "@std/path";
import { launcherDataDir } from "./lib/desktop-browser.ts";
import {
  applyKept,
  injectKeptStorage,
  KEPT_STORAGE_URL,
  readBody,
  readKept,
} from "./lib/kept-storage.ts";
import { isStored, serveStored, sweepPartials } from "./lib/offline-store.ts";
import {
  isKeptManifest,
  isLeftOut,
  keepArcadeBoard,
  keptManifest,
  localizeCatalog,
  ROMSET_PATH,
  sourceFor,
} from "./lib/streamed-payloads.ts";

export const app = new App<State>();

// Stamp the launcher-detection marker (lib/launcher-inject.ts) into every
// game HTML response, wherever it comes from: staticFiles() built-ins or
// per-game Fresh routes. Registered ahead of staticFiles() so it wraps those
// responses too. Gated to /games/* so the dashboard shell and the editor stay
// untouched. The marker script only activates when the page is actually
// embedded (window.parent !== window). Validator headers are dropped along
// with content-length: a 304 against a pre-injection cached copy would
// otherwise keep serving unstamped HTML.
app.use(async (ctx) => {
  const res = await ctx.next();
  if (ctx.req.method !== "GET" || res.status !== 200) return res;
  const path = new URL(ctx.req.url).pathname;
  if (!/^\/games(\/|$)/.test(path)) return res;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;
  const html = injectLauncherMarker(await res.text());
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(html, { status: res.status, headers });
});

// Cross-origin isolation for the PS2 and Switch players. Both keep guest RAM
// in a shared WebAssembly.Memory addressed by worker threads, which browsers
// gate on SharedArrayBuffer, which in turn requires the document to arrive
// cross-origin-isolated. Scoped to these two prefixes because a site-wide COEP
// would break every other embedded page's cross-origin subresources.
//
// These players are opted-in downloads, so in practice static/emu-sw.js serves
// them out of Cache Storage and stamps the same pair itself. This covers the
// case where the files are present on the server instead. Keep the list in
// sync with ISOLATED_PLAYERS in vite.config.ts (dev) and emu-sw.js.
const ISOLATED_PLAYERS = ["/ps2/", "/switch/"];
app.use(async (ctx) => {
  const res = await ctx.next();
  const path = new URL(ctx.req.url).pathname;
  if (ISOLATED_PLAYERS.some((p) => path.startsWith(p))) {
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  return res;
});

// Send a static directory index to its trailing-slash form before staticFiles()
// can answer the bare one itself — see lib/static-indexes.ts for what breaks
// otherwise. GET and HEAD only, so a 301's method rewriting never applies to
// anything but a page load. vite.config.ts does the same in dev.
app.use((ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return ctx.next();
  const url = new URL(ctx.req.url);
  const to = dirIndexRedirect(url.pathname + url.search);
  if (to === null) return ctx.next();
  return new Response(null, { status: 301, headers: { location: to } });
});

// `<name>.codemonkey.games/` is the level called <name>: its root goes to
// the game with that level, or — when no level has the name — to the
// editor's NEW GAME with the name filled in. Only the root; every other path
// on a subdomain serves as the apex does. lib/level-subdomain.ts has the
// matching rules, the cached level listing and the alias index it reads
// (2019.codemonkey.games is 2019-PS2 by alias). Ahead of
// staticFiles() and the dashboard route, GET and HEAD only.
app.use(async (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return ctx.next();
  if (new URL(ctx.req.url).pathname !== "/") return ctx.next();
  const peek = subdomainRedirect(ctx.req, []);
  if (peek === null) return ctx.next();
  const [keys, aliases] = await Promise.all([
    cloudLevelKeys(),
    cloudLevelAliases(),
  ]);
  return subdomainRedirect(ctx.req, keys, aliases ?? {}) ?? ctx.next();
});

// A packaged app's page keeps nothing past the launch (a fresh CEF profile and
// port every time), so its server keeps what has to last, under the launcher's
// data directory, and answers for it ahead of staticFiles() — whose build
// snapshot still lists what the binary left out, and would 500 opening it:
//
// - What the binary leaves out (lib/streamed-payloads.ts) and the arcade
//   player it never carried are downloaded the first time they are asked for
//   and served from disk after, online or not (lib/offline-store.ts). A
//   romset's first request brings its whole board with it — player, engine
//   recipe, MAME core — so a board installed once plays offline. A kept
//   folder's manifest lists only the tracks the store holds, since the level
//   loader plays silence for a listed track that is not there.
// - The catalogue calls the kept cores `local`, so the dashboard asks this
//   server for them instead of mirroring them through the service worker.
// - The installed-cores set and the arcade shelf are kept on disk too, and put
//   back into every page's localStorage before its scripts run
//   (lib/kept-storage.ts).
//
// None of it runs outside a packaged app: a checkout and the deploy serve
// static/ as they always have.
const STANDALONE = (Deno.build as { standalone?: boolean }).standalone === true;
const DATA_DIR = launcherDataDir(
  Deno.build.os === "windows"
    ? "windows"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux",
  Deno.env.toObject(),
);
const STORE_ROOT = join(DATA_DIR, "offline");
const KEPT_FILE = join(DATA_DIR, "kept-storage.json");
if (STANDALONE) sweepPartials(STORE_ROOT);
app.use(async (ctx) => {
  if (!STANDALONE) return ctx.next();
  const { method } = ctx.req;
  const { pathname } = new URL(ctx.req.url);
  if (pathname === KEPT_STORAGE_URL) {
    if (method !== "PUT") return new Response(null, { status: 405 });
    const body = await readBody(ctx.req);
    const status = body === null ? 400 : await applyKept(KEPT_FILE, body);
    return new Response(null, { status });
  }
  if (method !== "GET" && method !== "HEAD") return ctx.next();
  if (isLeftOut(pathname)) return new Response(null, { status: 404 });

  if (pathname === "/emulators.json" && method === "GET") {
    const res = await ctx.next();
    if (!res.ok) return res;
    return Response.json(localizeCatalog(await res.json()), {
      headers: { "cache-control": "no-store" },
    });
  }

  if (isKeptManifest(pathname) && method === "GET") {
    return keptManifest(pathname, { root: STORE_ROOT });
  }
  const source = sourceFor(pathname);
  if (source) {
    if (ROMSET_PATH.test(pathname)) {
      // The install's probe waits for the whole board, so installed means
      // playable offline; later launches top it up in the background.
      const first = !(await isStored(STORE_ROOT, pathname));
      const board = keepArcadeBoard(pathname, { root: STORE_ROOT }).catch(
        (err) => console.warn(`[offline] ${pathname}: ${err.message}`),
      );
      if (first) await board;
    }
    return serveStored(ctx.req, pathname, { root: STORE_ROOT, source });
  }

  const res = await ctx.next();
  const type = res.headers.get("content-type") ?? "";
  if (method !== "GET" || res.status !== 200 || !type.includes("text/html")) {
    return res;
  }
  const html = injectKeptStorage(await res.text(), await readKept(KEPT_FILE));
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(html, { status: 200, headers });
});

app.use(staticFiles());

// Pass a shared value from a middleware
app.use(async (ctx) => {
  ctx.state.shared = "hello";
  return await ctx.next();
});

// Per-request access log. Useful in dev but noisy in production, so it's
// gated on SHMUPX_VERBOSE. The env is read per request so the toggle works at
// runtime, not just at build time.
const requestLoggerMiddleware = define.middleware((ctx) => {
  if (Deno.env.get("SHMUPX_VERBOSE")) {
    console.log(`${ctx.req.method} ${ctx.req.url}`);
  }
  return ctx.next();
});
app.use(requestLoggerMiddleware);

// Include file-system based routes here
app.fsRoutes();

// Default export for the @fresh/plugin-vite convention. Note this is NOT a
// valid `deno serve` entry: Fresh's App has no `fetch` property (only
// `handler()`/`listen()`), so auto-serve entries must use the built
// `_fresh/server.js`, which wraps the handler in `{ fetch }`. The
// `deno task start` task (see deno.json) does exactly that.
export default app;
