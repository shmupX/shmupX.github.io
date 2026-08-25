import { App, staticFiles } from "fresh";
import { define, type State } from "./utils.ts";
import { injectLauncherMarker } from "./lib/launcher-inject.ts";

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
