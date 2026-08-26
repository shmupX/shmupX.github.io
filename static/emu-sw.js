// Same-origin mirror for opted-in emulator cores.
//
// shmupX ships no emulators. Enabling one in Settings records its path
// prefixes here; from then on this worker answers those paths from Cache
// Storage, fetching anything it does not yet hold from the cmg origin and
// keeping it. That is why installing a core does not need a file list: the
// players pull their own cores, BIOS and ROMs, and each request materialises
// on first use. Uninstalling drops the prefixes and deletes their entries.
//
// It has to be a worker rather than plain fetches for two reasons:
//   1. The mapped gamepad->keyboard input the launcher synthesises only reaches
//      a SAME-ORIGIN frame (gamepad-support.js bails silently otherwise). A
//      player loaded straight from the cmg origin would be cross-origin and
//      silently unplayable, so every byte has to arrive under our own origin.
//   2. PS2 and Switch need SharedArrayBuffer, which the browser only grants a
//      cross-origin-isolated document. Responses synthesised here carry the
//      COOP/COEP the isolated players need, plus CORP on every mirrored
//      subresource so require-corp does not reject them.
//
// Requests outside the installed prefixes are not touched at all.

const CACHE = "shmupx-emu-v1";
const STATE_URL = "/__emu-state.json";
const CONFIG_URL = "/emulators.json";

let state = null; // { origin, prefixes: [], isolated: [] }

async function readState() {
  if (state) return state;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(STATE_URL);
    state = res ? await res.json() : { origin: "", prefixes: [], isolated: [] };
  } catch {
    state = { origin: "", prefixes: [], isolated: [] };
  }
  return state;
}

function matchPrefix(list, pathname) {
  return (list || []).some((p) => pathname === p || pathname.startsWith(p));
}

// Re-emit a response with the headers the isolated players need. A Response
// from the cache has immutable headers, so this always builds a new one.
function withHeaders(res, isolated) {
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (isolated) {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function mirror(request, url) {
  const st = await readState();
  const cache = await caches.open(CACHE);
  const isolated = matchPrefix(st.isolated, url.pathname);

  const hit = await cache.match(url.pathname);

  // EmulatorJS HEADs a ROM to read content-length before it streams it, and
  // aborts the load outright if that request fails. Answer HEAD with the
  // headers only: from the cached copy when we hold it (measuring the body,
  // since a cached response need not carry content-length), otherwise from
  // upstream. Never store a HEAD — it has no body to store.
  if (request.method === "HEAD") {
    if (hit) {
      const size = (await hit.clone().blob()).size;
      const headers = new Headers(hit.headers);
      headers.set("content-length", String(size));
      return withHeaders(
        new Response(null, { status: hit.status, headers }),
        isolated,
      );
    }
    const head = await fetch(st.origin + url.pathname + url.search, {
      method: "HEAD",
    });
    return withHeaders(
      new Response(null, { status: head.status, headers: head.headers }),
      isolated,
    );
  }

  if (hit) return withHeaders(hit, isolated);

  // Not held yet — pull it from the origin that has it. Range requests (the
  // emulators stream large ISOs) are passed through uncached: a partial body
  // must never be stored as if it were the whole file.
  const upstream = st.origin + url.pathname + url.search;
  if (request.headers.has("range")) {
    const ranged = await fetch(upstream, { headers: request.headers });
    return withHeaders(ranged, isolated);
  }

  const res = await fetch(upstream);
  if (res.ok) {
    try {
      await cache.put(url.pathname, res.clone());
    } catch { /* quota — serve it anyway, just uncached */ }
  }
  return withHeaders(res, isolated);
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// The page owns the installed set; it writes state here and asks for eviction.
self.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "emu-state") {
    state = msg.state || null;
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await cache.put(
        STATE_URL,
        new Response(JSON.stringify(state), {
          headers: { "content-type": "application/json" },
        }),
      );
    })());
  } else if (msg.type === "emu-evict") {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path !== STATE_URL && matchPrefix(msg.prefixes, path)) {
          await cache.delete(req);
        }
      }
    })());
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET" && e.request.method !== "HEAD") return;
  if (url.pathname === STATE_URL || url.pathname === CONFIG_URL) return;

  e.respondWith((async () => {
    const st = await readState();
    if (!st.origin || !matchPrefix(st.prefixes, url.pathname)) {
      return fetch(e.request);
    }
    try {
      return await mirror(e.request, url);
    } catch (err) {
      return new Response(
        "emulator asset unavailable: " + url.pathname + "\n" + err,
        { status: 504, headers: { "content-type": "text/plain" } },
      );
    }
  })());
});
