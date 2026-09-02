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
// Requests outside the installed prefixes are left to the browser, and two
// checks keep them there. A path outside MIRRORABLE below — the fixed set of
// paths the catalogue could ever hand this worker — is returned to the
// browser with no respondWith() at all, synchronously, whether or not the
// installed set has been read yet. That is the check that matters, because
// the request that STARTS a stopped worker cannot wait for Cache Storage,
// and a navigation answered by a worker-mediated fetch has no fallback when
// that fetch fails or is cancelled: it becomes a network error the browser
// cannot retry. Then, once the installed set is in memory, a MIRRORABLE path
// whose core is not installed is left to the browser too. Only a MIRRORABLE
// path arriving before the set has been read is passed through, unchanged,
// and that passthrough never rejects.

const CACHE = "shmupx-emu-v1";
const STATE_URL = "/__emu-state.json";
const CONFIG_URL = "/emulators.json";

// Every path static/emulators.json could ever hand this worker: each core's
// prefixes and icon, plus the catalogue's shared entries (the rule lives in
// emuStateFor, static/ps2-library.js). Nothing else can be mirrored whatever
// the installed set turns out to be, which is what lets the fetch handler
// rule a path out before it has read that set. Keep in step with
// static/emulators.json — tests/emu_sw_universe_test.ts fails if a catalogue
// path stops being covered.
const MIRRORABLE = [
  "/nes/", "/Nintendo/",
  "/turbografx16/", "/TurboGrafx-16/",
  "/psx/", "/PlayStation/",
  "/saturn/", "/SegaSaturn/",
  "/arcade/",
  "/naomi/", "/Naomi/", "/icons/naomi-reindeer.png",
  "/ps2/", "/PlayStation2/",
  "/games/ps2-mario/", "/games/racer-intro/", "/games/shmup-party-ps2/",
  "/switch/", "/NintendoSwitch/",
  "/emulator-controls.js", "/shaders/",
];

let state = null; // { origin, prefixes: [], isolated: [] }; null until read
let stateRead = null; // the in-flight Cache Storage read, shared by callers

function emptyState() {
  return { origin: "", prefixes: [], isolated: [] };
}

// Never rejects. Kicked off at evaluation (below) so a worker woken by one
// request usually has the set in memory by the time the next one arrives. A
// state the page posts while the read is in flight is newer, and wins.
//
// A read that FAILS is not recorded. Storing it as an empty set would read
// as 'nothing installed' for the life of the worker, which now means never
// mirroring and never stamping the COOP/COEP the isolated players need —
// silently, since no request would reach mirror() to report it. Leaving the
// set unknown costs one retry per request instead, and only for MIRRORABLE
// paths.
function readState() {
  if (state) return Promise.resolve(state);
  if (!stateRead) {
    const pending = (async () => {
      let read = null;
      try {
        const cache = await caches.open(CACHE);
        const res = await cache.match(STATE_URL);
        read = (res && (await res.json())) || emptyState();
      } catch (err) {
        console.warn("emu-sw: state read failed, will retry", err);
      }
      if (read && !state) state = read;
      return state || emptyState();
    })();
    stateRead = pending;
    // Drop the memo once it settles so a failed read is retried, rather than
    // every later request being answered from the same stale promise.
    pending.then(() => {
      if (stateRead === pending) stateRead = null;
    });
  }
  return stateRead;
}
readState();

function matchPrefix(list, pathname) {
  return (list || []).some((p) => pathname === p || pathname.startsWith(p));
}

function mirrored(st, pathname) {
  return !!st.origin && matchPrefix(st.prefixes, pathname);
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

// mirror(), with the answer the players get when it fails: a 504 they can
// show, never a rejected promise.
async function mirrorOrFail(request, url) {
  try {
    return await mirror(request, url);
  } catch (err) {
    return new Response(
      "emulator asset unavailable: " + url.pathname + "\n" + err,
      { status: 504, headers: { "content-type": "text/plain" } },
    );
  }
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
    state = msg.state || emptyState();
    // A prefix MIRRORABLE does not cover can never be answered here, however
    // the page asks: the build that shipped that core is newer than this
    // worker, and only a worker update brings the two into line. Between the
    // deploy and that update the core 404s, so say which prefix it was.
    for (const prefix of state.prefixes || []) {
      if (!matchPrefix(MIRRORABLE, prefix)) {
        console.warn("emu-sw: outside this version's MIRRORABLE:", prefix);
      }
    }
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await cache.put(
        STATE_URL,
        new Response(JSON.stringify(state), {
          headers: { "content-type": "application/json" },
        }),
      );
    })().catch(() => {}));
  } else if (msg.type === "emu-evict") {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path !== STATE_URL && matchPrefix(msg.prefixes, path)) {
          await cache.delete(req);
        }
      }
    })().catch(() => {}));
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET" && e.request.method !== "HEAD") return;
  if (url.pathname === STATE_URL || url.pathname === CONFIG_URL) return;

  // Not a path any core could claim, so it is not this worker's business
  // whatever the installed set says. Decided here, before anything awaits,
  // so it holds for a worker this very request has just started — which is
  // the state every first navigation into the site finds it in.
  if (!matchPrefix(MIRRORABLE, url.pathname)) return;

  // respondWith() has to be called during dispatch, so the decision cannot
  // wait on Cache Storage. With the set in memory, decide now: a path whose
  // core is not installed is simply not answered, which leaves the request
  // to the browser's own loader with no worker in its path.
  if (state) {
    if (mirrored(state, url.pathname)) {
      e.respondWith(mirrorOrFail(e.request, url));
    }
    return;
  }

  // Cold start, and this is a path a core could own, so it cannot be handed
  // back until the set is known. Pass it through unchanged — e.request as it
  // came, so nothing about the request is rewritten — and turn a failed or
  // cancelled fetch into a network error response. The page sees what it
  // would have seen anyway; what goes away is the unhandled rejection in the
  // worker (Chrome still logs its own line for the failed FetchEvent).
  e.respondWith((async () => {
    const st = await readState();
    if (mirrored(st, url.pathname)) return mirrorOrFail(e.request, url);
    try {
      return await fetch(e.request);
    } catch {
      return Response.error();
    }
  })());
});
