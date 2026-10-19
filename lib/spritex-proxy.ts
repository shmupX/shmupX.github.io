// codemonkey.games/spriteX/ — spriteX on this origin, working on shmupX's
// catalog.
//
// spriteX (github.com/easierbycode/spriteX) deploys itself to GitHub Pages at
// easierbycode.com/spriteX/, and there it is cmg's tool: it lists, previews
// and packs into the root-level characters/ and atlases/. Here every GET or
// HEAD under /spriteX/ is answered from that deployment, with one addition to
// each page: window.__RTDB_ROOT__, set ahead of spriteX's own scripts. spriteX
// reads it the way the level editor reads it, putting the four scoped nodes
// (levels, levelAliases, atlases, characters) under shmupX/ and leaving
// sprites/, fonts/, maps/ and tilemaps/ at the root (lib/rtdb-root.ts). So the
// copy here lists shmupX's characters and atlases, and a sheet packed here is
// written to shmupX/atlases, where the level editor's Firebase Sprites and its
// + LIBRARY find it. easierbycode.com/spriteX/ sets nothing and stays cmg's.
// A spriteX build from before it read the global ignores it and edits the
// root, as it always did.
//
// Proxied rather than copied into static/: spriteX keeps deploying from its
// own repo, and this copy is never a release behind it. The cost is that it
// needs easierbycode.com to answer, which matters little for a tool whose
// every action is a database read or write. An upstream that cannot be
// reached is a 502.
//
// One file is answered here instead: spriteX's service worker. Its activate
// step deletes every cache but its own, and Cache Storage belongs to the whole
// origin, so registered here it would wipe the emulator downloads
// (shmupx-emu-v1) and every installed eShop game (shmupx-eshop-v1) the first
// time anyone opened spriteX. /spriteX/sw.js is a worker that does nothing:
// spriteX's registration still succeeds, and nothing is cached or deleted.
//
// Redirects from upstream that stay inside spriteX are rewritten onto this
// origin, and a path that would or could resolve outside /spriteX/ (an
// encoded `..` or separator, a doubled slash) is a 404, so this never fronts
// the rest of the host.

import { RTDB_ROOT } from "./rtdb-root.ts";

/** Where spriteX is served on this origin. */
export const SPRITEX_PATH = "/spriteX/";

/** spriteX's own deployment, which everything under SPRITEX_PATH comes from. */
export const SPRITEX_UPSTREAM = "https://easierbycode.com/spriteX/";

/** How long the upstream has to answer before the request is a 502. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** The request headers passed upstream; cookies and the rest stay here. */
const FORWARDED = [
  "accept",
  "accept-language",
  "if-modified-since",
  "if-none-match",
];

/** Upstream headers that describe its bytes or its connection, not ours. */
const DROPPED = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
];

/** The page's first script: the subtree spriteX's scoped nodes go under. */
export const RTDB_ROOT_SCRIPT =
  `<script id="shmupx-rtdb-root">window.__RTDB_ROOT__ = ${
    JSON.stringify(RTDB_ROOT)
  };</script>`;

/** What /spriteX/sw.js is here: a worker with no caches and no fetch handler. */
export const NOOP_WORKER =
  "// spriteX's service worker as codemonkey.games serves it: nothing.\n" +
  "// spriteX's own deletes every other cache on the origin, and this origin\n" +
  "// keeps its emulator downloads and eShop installs in Cache Storage\n" +
  "// (lib/spritex-proxy.ts in shmupX).\n";

/**
 * The upstream URL a request path stands for, or null when the path is not
 * under SPRITEX_PATH or would resolve outside the upstream's own directory.
 */
export function spritexUpstreamUrl(
  pathname: string,
  search = "",
  upstream = SPRITEX_UPSTREAM,
): URL | null {
  if (!pathname.startsWith(SPRITEX_PATH)) return null;
  const rest = pathname.slice(SPRITEX_PATH.length);
  // A leading slash would make the rest host-relative ("//other.host/"), and
  // an encoded separator is a `..` the upstream might decode after this check.
  if (rest.startsWith("/") || /%2f|%5c/i.test(rest)) return null;
  const url = new URL(rest + search, upstream);
  return url.href.startsWith(upstream) ? url : null;
}

/**
 * An upstream Location header as this origin should send it: inside the
 * upstream's directory it becomes the same path under SPRITEX_PATH (whichever
 * scheme the upstream named), anywhere else it is left absolute.
 */
export function localLocation(
  location: string,
  from: URL,
  upstream = SPRITEX_UPSTREAM,
): string {
  let to: URL;
  try {
    to = new URL(location, from);
  } catch {
    return location;
  }
  const base = new URL(upstream);
  const dir = base.pathname.replace(/\/$/, "");
  if (
    to.host !== base.host ||
    (to.pathname !== dir && !to.pathname.startsWith(base.pathname))
  ) return to.href;
  return SPRITEX_PATH + to.pathname.slice(base.pathname.length) + to.search +
    to.hash;
}

/**
 * The page with RTDB_ROOT_SCRIPT first in its head (after the doctype when
 * it has no head tag, so it never drops into quirks mode), once.
 */
export function injectRtdbRoot(html: string): string {
  if (html.includes('id="shmupx-rtdb-root"')) return html;
  const anchor = /<head\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (!anchor) return RTDB_ROOT_SCRIPT + html;
  const at = anchor.index + anchor[0].length;
  return html.slice(0, at) + RTDB_ROOT_SCRIPT + html.slice(at);
}

export interface SpriteXOptions {
  /** The fetch the upstream is reached with; tests pass their own. */
  fetch?: typeof fetch;
  /** The deployment to proxy, with its trailing slash. */
  upstream?: string;
}

/**
 * The answer to a request on this origin when it is spriteX's, else null.
 * The bare /spriteX is sent to /spriteX/ (spriteX's URLs are relative), sw.js
 * is NOOP_WORKER, any method but GET and HEAD is a 405, and everything else
 * is the upstream's answer, with the root script added to an HTML page.
 */
export async function serveSpriteX(
  req: Request,
  opts: SpriteXOptions = {},
): Promise<Response | null> {
  const { pathname, search } = new URL(req.url);
  if (pathname === SPRITEX_PATH.slice(0, -1)) {
    return new Response(null, {
      status: 301,
      headers: { location: SPRITEX_PATH + search },
    });
  }
  if (!pathname.startsWith(SPRITEX_PATH)) return null;
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (pathname === SPRITEX_PATH + "sw.js") {
    return new Response(head ? null : NOOP_WORKER, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }
  const upstream = opts.upstream ?? SPRITEX_UPSTREAM;
  const target = spritexUpstreamUrl(pathname, search, upstream);
  if (!target) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target, {
      method: req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return new Response(
      `spriteX could not be reached at ${target.href}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const out = new Headers(res.headers);
  for (const name of DROPPED) out.delete(name);
  const location = out.get("location");
  if (location) out.set("location", localLocation(location, target, upstream));
  const type = out.get("content-type") ?? "";
  if (!head && res.status === 200 && type.includes("text/html")) {
    // The page differs from the upstream's bytes, so its validators go: a
    // 304 against them would hand back a page without the root on it.
    out.delete("etag");
    out.delete("last-modified");
    return new Response(injectRtdbRoot(await res.text()), {
      status: 200,
      headers: out,
    });
  }
  const empty = head || res.status === 204 || res.status === 304;
  if (empty) await res.body?.cancel();
  return new Response(empty ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: out,
  });
}
