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
// A game can also answer to ALIASES: other labels that name the same level,
// so 2019.codemonkey.games and streetfighter.codemonkey.games both open
// 2019-PS2. They live in one small index beside the levels, RTDB
// `levelAliases/<alias>` = the level's key, written by `deno task level:alias`
// (scripts/level-alias.ts). An alias is a lowercase DNS label and never wins
// over a level's own key: a level called `2019` would answer to 2019 first.
// The level loader reads the same index for ?level=<alias>.
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
export const ALIASES_PATH = "levelAliases";
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

/** Alias name -> the level key it stands for. */
export type LevelAliases = Readonly<Record<string, string>>;

/** An alias is spelled the way a subdomain label is: one lowercase DNS label. */
export function isAliasName(name: string): boolean {
  return LABEL_RE.test(name) && !RESERVED_SUBDOMAINS.has(name);
}

/**
 * The stored key a label stands for: exact, then by case, then an alias whose
 * level still exists, else null.
 */
export function matchLevelKey(
  label: string,
  keys: readonly string[],
  aliases: LevelAliases = {},
): string | null {
  if (keys.includes(label)) return label;
  const wanted = label.toLowerCase();
  const candidates = keys.filter((k) => k.toLowerCase() === wanted).sort();
  if (candidates.length) return candidates[0];
  const aliased = Object.hasOwn(aliases, wanted) ? aliases[wanted] : undefined;
  return typeof aliased === "string" && keys.includes(aliased) ? aliased : null;
}

/**
 * What making `wanted` aliases of `level` would write to the index, or why it
 * cannot: the level must exist (found the way a subdomain finds it), each
 * alias must be a label, a label no level owns (the level would always win
 * it) and not one another level already answers to (taken back explicitly,
 * with --remove, never silently). An alias the level already has is skipped.
 */
export function planAliases(
  level: string,
  wanted: readonly string[],
  keys: readonly string[],
  aliases: LevelAliases,
): { key: string | null; set: Record<string, string>; errors: string[] } {
  const key = matchLevelKey(level, keys);
  const set: Record<string, string> = {};
  const errors: string[] = [];
  if (key === null) {
    return { key, set, errors: [`no level is called "${level}"`] };
  }
  for (const raw of wanted) {
    const name = raw.trim().toLowerCase();
    if (!isAliasName(name)) {
      errors.push(
        `"${raw}" is not an alias: letters, digits and inner hyphens, as in a subdomain`,
      );
    } else if (keys.some((k) => k.toLowerCase() === name)) {
      errors.push(`"${name}" is already a level's own name`);
    } else if (Object.hasOwn(aliases, name) && aliases[name] !== key) {
      errors.push(`"${name}" already names "${aliases[name]}"`);
    } else if (aliases[name] !== key) {
      set[name] = key;
    }
  }
  return { key, set, errors };
}

/** Where a subdomain's root goes. `keys` null means the database was unreachable. */
export function subdomainTarget(
  label: string,
  keys: readonly string[] | null,
  aliases: LevelAliases = {},
): string {
  if (keys === null) {
    const aliased = Object.hasOwn(aliases, label) ? aliases[label] : label;
    return `${GAME_URL}?level=${encodeURIComponent(aliased)}`;
  }
  const key = matchLevelKey(label, keys, aliases);
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
  aliases: LevelAliases = {},
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
      location: subdomainTarget(label, keys, aliases),
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

let aliasesCache: { at: number; aliases: Record<string, string> } | null = null;

/**
 * The alias index, `levelAliases/*`, read whole (it is a few short strings)
 * and cached for a minute like the key listing; {} when there is none, null
 * when the read fails and nothing is cached yet. A value that is not a string
 * or a name that is not an alias is dropped rather than trusted.
 */
export async function cloudLevelAliases(
  db: string = LEVELS_DB,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Record<string, string> | null> {
  if (aliasesCache && now() - aliasesCache.at < KEYS_CACHE_MS) {
    return aliasesCache.aliases;
  }
  try {
    const res = await fetcher(`${db}/${ALIASES_PATH}.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`${ALIASES_PATH}.json ${res.status}`);
    const body = await res.json() as Record<string, unknown> | null;
    const aliases: Record<string, string> = {};
    if (body && typeof body === "object") {
      for (const [name, key] of Object.entries(body)) {
        if (isAliasName(name) && typeof key === "string" && key) {
          aliases[name] = key;
        }
      }
    }
    aliasesCache = { at: now(), aliases };
    return aliases;
  } catch (err) {
    console.warn(
      "level subdomains: could not read aliases:",
      (err as Error).message ?? err,
    );
    return aliasesCache ? aliasesCache.aliases : null;
  }
}

/** Forget the cached listings (tests). */
export function resetLevelKeysCache(): void {
  keysCache = null;
  aliasesCache = null;
}
