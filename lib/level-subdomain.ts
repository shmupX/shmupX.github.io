// Level subdomains: `<name>.codemonkey.games` is the level called <name>.
//
// A visit to the ROOT of a subdomain is routed by its label (main.ts, ahead
// of the dashboard route):
//
//   2019-ps2.codemonkey.games/   -> /games/2028-ai?level=2019-PS2   (a level
//                                   that exists: the game, straight in)
//   anything-else.codemonkey.games/ -> /editor/?new=anything-else  (no such
//                                   level: NEW GAME, named for the label)
//
// Only the root is redirected. Every other path on a subdomain serves as the
// apex does, which is what lets the redirect be relative: the game page and
// its bundle load from the same host the visitor typed.
//
// The level is looked up by name in the cloud (RTDB `levels/*`, the same keys
// the level loader reads with ?level=). Hostnames are case-insensitive and
// RTDB keys are not — the level is stored as `2019-PS2` — so the label is
// matched exactly first, then lowercased, then against every key's lowercase
// (sorted, so a tie such as `ramsie`/`Ramsie` resolves the same way every
// time). A key the DNS could never spell (a space, an underscore, a dot) is
// simply not reachable this way.
//
// The key list comes from one shallow REST read, cached for a minute the way
// /characters caches its listing. When the database cannot be read at all the
// label is sent to the GAME, not the editor: a shared link to a real level is
// the common case, and the loader's own "no such level" screen is a better
// failure than a stranger's editor opening over a name that exists.

export const DEFAULT_SITE_HOSTS = ["codemonkey.games", "localhost"];

/** Labels that are the apex under another name, never a level. */
export const RESERVED_SUBDOMAINS = new Set(["www"]);

export const LEVELS_DB = Deno.env.get("CHARACTERS_DB") ??
  "https://evil-invaders-default-rtdb.firebaseio.com";
export const LEVELS_PATH = "levels";
export const KEYS_CACHE_MS = 60_000;

export const GAME_URL = "/games/2028-ai";
export const NEW_GAME_URL = "/editor/";

// One DNS label: letters, digits and inner hyphens, 63 chars at most.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The hostname a Host (or X-Forwarded-Host) value names: no port, lowercased. */
export function hostnameOf(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  const first = hostHeader.split(",")[0].trim().toLowerCase();
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"));
  const colon = first.lastIndexOf(":");
  return colon > 0 && !first.slice(colon + 1).includes(":")
    ? first.slice(0, colon)
    : first;
}

/**
 * The level label a host names, or null: the apex itself, `www`, a host that
 * is not one of ours (a LAN address, the app's own deno.net URL), or a label
 * that is nested (`a.b.codemonkey.games`) all answer null.
 */
export function subdomainOf(
  hostHeader: string | null | undefined,
  siteHosts: readonly string[] = DEFAULT_SITE_HOSTS,
): string | null {
  const host = hostnameOf(hostHeader);
  for (const site of siteHosts) {
    if (host === site || !host.endsWith("." + site)) continue;
    const label = host.slice(0, -(site.length + 1));
    if (
      label.includes(".") || RESERVED_SUBDOMAINS.has(label) ||
      !LABEL_RE.test(label)
    ) return null;
    return label;
  }
  return null;
}

/** The stored key a label stands for: exact, then by case, else null. */
export function matchLevelKey(
  label: string,
  keys: readonly string[],
): string | null {
  if (keys.includes(label)) return label;
  const wanted = label.toLowerCase();
  const candidates = keys.filter((k) => k.toLowerCase() === wanted).sort();
  return candidates[0] ?? null;
}

/** Where a subdomain's root goes. `keys` null means the database was unreachable. */
export function subdomainTarget(
  label: string,
  keys: readonly string[] | null,
): string {
  if (keys === null) return `${GAME_URL}?level=${encodeURIComponent(label)}`;
  const key = matchLevelKey(label, keys);
  if (key !== null) return `${GAME_URL}?level=${encodeURIComponent(key)}`;
  return `${NEW_GAME_URL}?new=${encodeURIComponent(label)}`;
}

/**
 * The redirect a request earns, or null when it is not a subdomain root. The
 * browser's own host wins over the one a tunnel proxy rewrote (X-Forwarded-Host
 * carries it, as lib/local-guards.ts reads it), so a level link through the
 * dev tunnel still routes. GET and HEAD only: a 302's method rewriting must
 * never land on a form post.
 */
export function subdomainRedirect(
  req: Request,
  keys: readonly string[] | null,
  siteHosts: readonly string[] = DEFAULT_SITE_HOSTS,
): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/" && url.pathname !== "/index.html") return null;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ??
    url.host;
  const label = subdomainOf(host, siteHosts);
  if (label === null) return null;
  return new Response(null, {
    status: 302,
    headers: {
      location: subdomainTarget(label, keys),
      "cache-control": "no-store",
    },
  });
}

let keysCache: { at: number; keys: string[] } | null = null;

/**
 * Every level's key, from a shallow read of the database, cached for a
 * minute; null when the read fails and nothing is cached yet. `fetcher` and
 * `now` are injectable for tests.
 */
export async function cloudLevelKeys(
  db: string = LEVELS_DB,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string[] | null> {
  if (keysCache && now() - keysCache.at < KEYS_CACHE_MS) return keysCache.keys;
  try {
    const res = await fetcher(`${db}/${LEVELS_PATH}.json?shallow=true`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`levels.json ${res.status}`);
    const body = await res.json() as Record<string, unknown> | null;
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    keysCache = { at: now(), keys };
    return keys;
  } catch (err) {
    console.warn(
      "level subdomains: could not list levels:",
      (err as Error).message ?? err,
    );
    return keysCache ? keysCache.keys : null;
  }
}

/** Forget the cached listing (tests). */
export function resetLevelKeysCache(): void {
  keysCache = null;
}
