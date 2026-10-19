// codemonkey.games/spriteX/ (lib/spritex-proxy.ts, wired in main.ts): spriteX
// served from its own deployment with shmupX's database root on its pages,
// and never with its own service worker, which would empty this origin's
// Cache Storage.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { RTDB_ROOT } from "../lib/rtdb-root.ts";
import {
  injectRtdbRoot,
  localLocation,
  NOOP_WORKER,
  RTDB_ROOT_SCRIPT,
  serveSpriteX,
  SPRITEX_UPSTREAM,
  spritexUpstreamUrl,
} from "../lib/spritex-proxy.ts";

const SITE = "https://codemonkey.games";

const PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="manifest" href="manifest.json" />
  </head>
  <body>
    <script type="module" src="assets/main.js"></script>
  </body>
</html>`;

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that answers from a table and records what it was asked. */
function upstream(
  answer: (url: URL) => Response,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push({ url: url.href, init });
    return Promise.resolve(answer(url));
  }) as typeof fetch;
  return { fetch: fake, seen };
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(SITE + path, init);
}

Deno.test("a path under /spriteX/ is the same path under spriteX's deployment, and nothing outside it", () => {
  assertEquals(
    spritexUpstreamUrl("/spriteX/")?.href,
    "https://easierbycode.com/spriteX/",
  );
  assertEquals(
    spritexUpstreamUrl("/spriteX/assets/main.js", "?v=2")?.href,
    "https://easierbycode.com/spriteX/assets/main.js?v=2",
  );
  // Not spriteX's: other paths, and the case GitHub Pages would not match.
  assertStrictEquals(spritexUpstreamUrl("/"), null);
  assertStrictEquals(spritexUpstreamUrl("/spritex/"), null);
  assertStrictEquals(spritexUpstreamUrl("/spriteXY/"), null);
  // Resolving out of the directory, or onto another host, is refused.
  assertStrictEquals(spritexUpstreamUrl("/spriteX/%2e%2e/secret"), null);
  assertStrictEquals(spritexUpstreamUrl("/spriteX/..%2fsecret"), null);
  assertStrictEquals(spritexUpstreamUrl("/spriteX//evil.test/x"), null);
});

Deno.test("the bare /spriteX is sent to /spriteX/ with its query, and other paths are left to the app", async () => {
  const res = await serveSpriteX(get("/spriteX?tab=pack"));
  assertEquals(res?.status, 301);
  assertEquals(res?.headers.get("location"), "/spriteX/?tab=pack");
  for (const path of ["/", "/spritex/", "/editor/", "/spriteXY"]) {
    assertStrictEquals(await serveSpriteX(get(path)), null, path);
  }
});

Deno.test("spriteX's page gets shmupX's root first in its head, once, without validators", async () => {
  const { fetch, seen } = upstream(() =>
    new Response(PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": "999",
        "cache-control": "max-age=600",
        etag: '"abc"',
        "last-modified": "Mon, 19 Oct 2026 12:00:00 GMT",
      },
    })
  );
  const res = await serveSpriteX(get("/spriteX/"), { fetch });
  assertEquals(seen.map((s) => s.url), [SPRITEX_UPSTREAM]);
  assertEquals(res?.status, 200);
  const html = await res!.text();
  assert(html.startsWith("<!DOCTYPE html>"), "the doctype stays first");
  const root = html.indexOf(RTDB_ROOT_SCRIPT);
  assert(root > html.indexOf("<head>"), "the root script is in the head");
  assert(
    root < html.indexOf('<script type="module"'),
    "and ahead of spriteX's own module",
  );
  assertEquals(html.split(RTDB_ROOT_SCRIPT).length, 2, "exactly once");
  assertEquals(res!.headers.get("cache-control"), "max-age=600");
  for (const dropped of ["etag", "last-modified", "content-encoding"]) {
    assertStrictEquals(res!.headers.get(dropped), null, dropped);
  }
  assertEquals(injectRtdbRoot(html), html, "injecting twice changes nothing");
});

Deno.test("the injected script sets the root lib/rtdb-root.ts names", () => {
  const script = /<script[^>]*>([\s\S]*)<\/script>/.exec(RTDB_ROOT_SCRIPT)![1];
  const window: Record<string, unknown> = {};
  new Function("window", script)(window);
  assertEquals(window.__RTDB_ROOT__, RTDB_ROOT);
});

Deno.test("a page with no head tag gets the root after its doctype, or first", () => {
  assertEquals(
    injectRtdbRoot("<!doctype html><p>hi"),
    `<!doctype html>${RTDB_ROOT_SCRIPT}<p>hi`,
  );
  // spriteX's 404.html, which is one meta refresh.
  const meta = '<meta http-equiv="refresh" content="0; url=./" />';
  assertEquals(injectRtdbRoot(meta), RTDB_ROOT_SCRIPT + meta);
  // <header> is not <head>.
  assertEquals(
    injectRtdbRoot("<!doctype html><header></header>"),
    `<!doctype html>${RTDB_ROOT_SCRIPT}<header></header>`,
  );
});

Deno.test("anything else passes through as the upstream sent it, conditional requests included", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { fetch, seen } = upstream((url) =>
    url.pathname.endsWith("main.js")
      ? new Response(bytes, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "content-encoding": "gzip",
          "set-cookie": "a=b",
          etag: '"js"',
        },
      })
      : new Response(null, { status: 304, headers: { etag: '"png"' } })
  );
  const js = await serveSpriteX(
    get("/spriteX/assets/main.js", {
      headers: { cookie: "session=1", "if-none-match": '"old"' },
    }),
    { fetch },
  );
  assertEquals(js?.status, 200);
  assertEquals(new Uint8Array(await js!.arrayBuffer()), bytes);
  assertEquals(js!.headers.get("etag"), '"js"');
  assertStrictEquals(js!.headers.get("content-encoding"), null);
  assertStrictEquals(js!.headers.get("set-cookie"), null);
  const sent = new Headers(seen[0].init.headers);
  assertEquals(sent.get("if-none-match"), '"old"');
  assertStrictEquals(sent.get("cookie"), null, "cookies stay on this origin");
  assertEquals(seen[0].init.redirect, "manual");

  const png = await serveSpriteX(
    get("/spriteX/icons/icon-192.png", {
      headers: { "if-none-match": '"png"' },
    }),
    { fetch },
  );
  assertEquals(png?.status, 304);
  assertStrictEquals(png!.body, null);
});

Deno.test("spriteX's service worker is never fetched: this origin answers with one that touches no cache", async () => {
  const { fetch, seen } = upstream(() => {
    throw new Error("the upstream sw.js must not be asked for");
  });
  const res = await serveSpriteX(get("/spriteX/sw.js"), { fetch });
  assertEquals(seen, []);
  assertEquals(res?.status, 200);
  assert(res!.headers.get("content-type")!.startsWith("text/javascript"));
  const body = await res!.text();
  assertEquals(body, NOOP_WORKER);
  // Only comments: nothing that runs, so nothing that can reach Cache Storage.
  assertEquals(body.split("\n").filter((l) => l && !l.startsWith("//")), []);

  const headRes = await serveSpriteX(get("/spriteX/sw.js", { method: "HEAD" }));
  assertEquals(headRes?.status, 200);
  assertStrictEquals(headRes!.body, null);
});

Deno.test("an upstream redirect inside spriteX stays on this origin, one elsewhere is left alone", async () => {
  const from = new URL("https://easierbycode.com/spriteX/icons");
  assertEquals(
    localLocation("https://easierbycode.com/spriteX/icons/", from),
    "/spriteX/icons/",
  );
  assertEquals(
    localLocation("http://easierbycode.com/spriteX/?a=1#b", from),
    "/spriteX/?a=1#b",
  );
  assertEquals(localLocation("./", from), "/spriteX/");
  assertEquals(
    localLocation("https://easierbycode.com/spriteX", from),
    "/spriteX/",
  );
  assertEquals(
    localLocation("https://easierbycode.com/other/", from),
    "https://easierbycode.com/other/",
  );
  assertEquals(
    localLocation("https://github.com/easierbycode/spriteX", from),
    "https://github.com/easierbycode/spriteX",
  );

  const { fetch } = upstream(() =>
    new Response(null, {
      status: 301,
      headers: { location: "https://easierbycode.com/spriteX/icons/" },
    })
  );
  const res = await serveSpriteX(get("/spriteX/icons"), { fetch });
  assertEquals(res?.status, 301);
  assertEquals(res?.headers.get("location"), "/spriteX/icons/");
});

Deno.test("an unreachable upstream is a 502, a write is a 405, HEAD has no body", async () => {
  const down =
    (() => Promise.reject(new TypeError("dns error"))) as typeof fetch;
  const res = await serveSpriteX(get("/spriteX/"), { fetch: down });
  assertEquals(res?.status, 502);
  assert((await res!.text()).includes("dns error"));

  const post = await serveSpriteX(get("/spriteX/", { method: "POST" }));
  assertEquals(post?.status, 405);
  assertEquals(post?.headers.get("allow"), "GET, HEAD");

  const { fetch, seen } = upstream(() =>
    new Response(null, { headers: { "content-type": "text/html" } })
  );
  const head = await serveSpriteX(get("/spriteX/", { method: "HEAD" }), {
    fetch,
  });
  assertEquals(seen[0].init.method, "HEAD");
  assertEquals(head?.status, 200);
  assertStrictEquals(head!.body, null);
});

Deno.test("the CMG Desktop opens spriteX on this origin, where it is shmupX's", async () => {
  const desktop = await Deno.readTextFile(
    new URL("../static/desktop/desktop.js", import.meta.url),
  );
  const url = /const SPRITEX_URL = "([^"]+)"/.exec(desktop)?.[1];
  assertEquals(url, "/spriteX/");
});
