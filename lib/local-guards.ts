// Deploy/CSRF guards for the mutating local-only API routes, extracted from
// cmg's lib/games-store.ts (the rest of that store — the local add-game
// machinery — did not come along to shmupX).

export function isDeploy(): boolean {
  return !!Deno.env.get("DENO_DEPLOYMENT_ID");
}

// The hosts a same-origin request may legitimately name in Origin. Host is the
// obvious one, but a tunnel proxy may rewrite it while leaving the browser's
// Origin untouched, forwarding the address the browser used in
// X-Forwarded-Host — accepted here as well. A cross-site page cannot forge
// that header to whitelist itself: a custom request header makes the request
// non-"simple", so the browser preflights it, and nothing in this app answers
// OPTIONS with Access-Control-Allow-Headers, so the POST is never sent.
function selfHosts(req: Request): string[] {
  const hosts: string[] = [];
  const host = req.headers.get("host");
  if (host) hosts.push(host);
  const forwarded = req.headers.get("x-forwarded-host");
  // Comma-separated when a request crosses several proxies; the first entry is
  // the one the client actually addressed.
  const first = forwarded?.split(",")[0].trim();
  if (first) hosts.push(first);
  return hosts;
}

// sec-fetch-site is the primary signal — "none" is a user-initiated navigation
// (address bar, bookmark), which no attacker page can forge. Browsers that
// predate Fetch Metadata still attach Origin to every non-GET, so fall back to
// comparing its host against this origin's own (see selfHosts). A request
// carrying neither header is a non-browser client (curl, the repo's own
// scripts) and is not the CSRF threat model, so it passes.
function isCrossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return !selfHosts(req).includes(new URL(origin).host);
  } catch {
    return true; // an unparseable Origin is not something a browser sends
  }
}

// Fetch-Metadata CSRF gate for mutating local endpoints: a cross-site page can
// issue a CORS-"simple" POST with no preflight — bodyless, or with a
// text/plain body that ctx.req.json() happily parses — so neither the method
// nor the body shape is CSRF protection on its own.
export function crossSiteGuard(req: Request): Response | null {
  if (!isCrossSite(req)) return null;
  return Response.json({ ok: false, error: "cross-site request" }, {
    status: 403,
  });
}

// Shared guard for every mutating endpoint: refuse on the read-only hosted
// origin, and reject cross-site requests.
export function localWriteGuard(req: Request): Response | null {
  if (isDeploy()) {
    return Response.json(
      {
        ok: false,
        error: "This action is only available on a local install.",
      },
      { status: 403 },
    );
  }
  return crossSiteGuard(req);
}
