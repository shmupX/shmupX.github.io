// Level subdomains: `<name>.codemonkey.games` is the level called <name>.
//
// A visit to the ROOT of a subdomain is routed by its label (main.ts, ahead
// of the dashboard route):
//
//   2019-ps2.codemonkey.games/   -> /games/2028-ai?level=2019-PS2   (a level
//                                   that exists: the game, straight in)
//   elfin.codemonkey.games/      -> /editor/?game=2028-ai&play=elfin  (no such
//                                   level, but a SHELF game of that slug: the
//                                   cart, run straight away)
//   anything-else.codemonkey.games/ -> /editor/?new=anything-else  (neither:
//                                   NEW GAME, named for the label)
//
// Only the root is redirected. Every other path on a subdomain serves as the
// apex does, which is what lets the redirect be relative: the game page and
// its bundle load from the same host the visitor typed.
//
// The level is looked up by name in the cloud (RTDB `shmupX/levels/*`, the
// same keys the level loader reads with ?level=). Only shmupX's own games are
// there: the database is shared with cmg, whose catalog is the root-level
// `levels/*`, and a label naming one of cmg's games and none of ours is a NEW
// GAME here, not cmg's game (lib/rtdb-root.ts). Hostnames are
// case-insensitive and RTDB keys are not — the level is stored as `2019-PS2`
// — so the label is matched exactly first, then lowercased, then against
// every key's lowercase (sorted, so a tie such as `ramsie`/`Ramsie` resolves
// the same way every time). A key the DNS could never spell (a space, an
// underscore, a dot) is reached by its slug: every run of such characters
// becomes one hyphen, so master-arena-mod.codemonkey.games is the level stored
// as `Master Arena Mod` (levelSlug). The slug is the level's own name, so it
// ranks above an alias.
//
// A game can also answer to ALIASES: other labels that name the same level,
// so 2019.codemonkey.games and streetfighter.codemonkey.games both open
// 2019-PS2. They live in one small index beside the levels, RTDB
// `shmupX/levelAliases/<alias>` = the level's key, written by
// `deno task level:alias` (scripts/level-alias.ts). An alias is a lowercase
// DNS label and never wins over a level's own key: a level called `2019`
// would answer to 2019 first. The level loader reads the same index for
// ?level=<alias>.
//
// The SHELF is the community Dezaemon 2 library (RTDB `dezaemon/index/<slug>`,
// published by `deno task deza:upload`; the slug is the title lowercased with
// runs of anything but a-z0-9 made one hyphen, so `Elfin` is `elfin`). It is
// asked after the levels and the aliases, so a level, or an alias, always keeps
// a name it already answers to, and before NEW GAME, so a name that is
// someone's cart is never offered as a blank slate. The editor's own `?play=`
// hand-off (static/editor/index.html playDezaemonLibrarySlug, the one the
// launcher's coverflow sends) resolves the slug and runs the cart. Carts that
// live only in one browser (eShop installs, a visitor's own exports) are not in
// the database, so no host can name them.
//
// The key list comes from one shallow REST read, cached for a minute the way
// /characters caches its listing. When the database cannot be read at all the
// label is sent to the GAME, not the editor: a shared link to a real level is
// the common case, and the loader's own "no such level" screen is a better
// failure than a stranger's editor opening over a name that exists. The shelf
// listing is read the same way, but an unreadable one (with levels readable) is
// an empty shelf: opening a cart's player over a name nobody has claimed would
// cost the NEW GAME a stranger came for.

import { rtdbPath } from "./rtdb-root.ts";

export const DEFAULT_SITE_HOSTS = ["codemonkey.games", "localhost"];

/** Labels that are the apex under another name, never a level. */
export const RESERVED_SUBDOMAINS = new Set(["www"]);

// The DATABASE, not the subtree: CHARACTERS_DB names the base the way it
// always has (a deployment that set it to the bare database URL still works),
// and the shmupX root goes on the paths below.
export const LEVELS_DB = Deno.env.get("CHARACTERS_DB") ??
  "https://evil-invaders-default-rtdb.firebaseio.com";
export const LEVELS_PATH = rtdbPath("levels");
export const ALIASES_PATH = rtdbPath("levelAliases");
// The Dezaemon library is a shared store, not a game catalog, so it stays at
// the database root (lib/rtdb-root.ts): rtdbPath leaves it alone.
export const SHELF_PATH = rtdbPath("dezaemon/index");
export const KEYS_CACHE_MS = 60_000;

export const GAME_URL = "/games/2028-ai";
export const NEW_GAME_URL = "/editor/";
// What the launcher's coverflow sends for a shelf game too
// (svelte-src/Dashboard.svelte): /editor/?game=2028-ai&play=<slug>.
export const SHELF_PLAY_URL = "/editor/";
export const SHELF_GAME_ID = "2028-ai";

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
 * How a key is spelled as a DNS label: lowercase, every run of characters a
 * hostname cannot hold (a space, an underscore, a dot...) one hyphen, none at
 * the ends. `Master Arena Mod` is `master-arena-mod`. "" when nothing is left.
 */
export function levelSlug(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The stored key a label stands for: exact, then by case, then by slug (the
 * key as a label, levelSlug), then an alias whose level still exists, else
 * null. A level's own name, however it is spelled, beats an alias.
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
  const slugged = wanted
    ? keys.filter((k) => levelSlug(k) === wanted).sort()
    : [];
  if (slugged.length) return slugged[0];
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
    } else if (
      keys.some((k) => k.toLowerCase() === name || levelSlug(k) === name)
    ) {
      errors.push(`"${name}" is already a level's own name`);
    } else if (Object.hasOwn(aliases, name) && aliases[name] !== key) {
      errors.push(`"${name}" already names "${aliases[name]}"`);
    } else if (aliases[name] !== key) {
      set[name] = key;
    }
  }
  return { key, set, errors };
}

/**
 * `path?name=value…`, then every parameter of the visitor's own query that the
 * label has not already decided: squad.codemonkey.games/?god=1 is the game with
 * god mode on, the way /games/2028-ai?level=gs&god=1 is. The label decides the
 * level, so a `level` (or `new`, or for a shelf game `game` and `play`) the
 * visitor typed as well is the one thing not carried.
 */
function withQuery(
  path: string,
  decided: ReadonlyArray<readonly [string, string]>,
  search: string,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of decided) params.set(name, value);
  const names = new Set(decided.map(([name]) => name));
  for (const [k, v] of new URLSearchParams(search)) {
    if (!names.has(k)) params.append(k, v);
  }
  return `${path}?${params.toString()}`;
}

/**
 * The shelf slug a label names, or null. Slugs are lowercase by construction
 * (see the header) and a hostname label is lowercased before it gets here, so
 * the match is exact.
 */
export function matchShelfSlug(
  label: string,
  slugs: readonly string[],
): string | null {
  return slugs.includes(label) ? label : null;
}

/**
 * Where a subdomain's root goes. `keys` null means the database was
 * unreachable. `search` is the visitor's own query, carried along (withQuery).
 * `shelf` is the Dezaemon library's slugs: asked after every level and alias,
 * before NEW GAME, and not at all when the levels could not be read.
 */
export function subdomainTarget(
  label: string,
  keys: readonly string[] | null,
  aliases: LevelAliases = {},
  search = "",
  shelf: readonly string[] = [],
): string {
  if (keys === null) {
    const aliased = Object.hasOwn(aliases, label) ? aliases[label] : label;
    return withQuery(GAME_URL, [["level", aliased]], search);
  }
  const key = matchLevelKey(label, keys, aliases);
  if (key !== null) return withQuery(GAME_URL, [["level", key]], search);
  const slug = matchShelfSlug(label, shelf);
  if (slug !== null) {
    return withQuery(
      SHELF_PLAY_URL,
      [["game", SHELF_GAME_ID], ["play", slug]],
      search,
    );
  }
  return withQuery(NEW_GAME_URL, [["new", label]], search);
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
  shelf: readonly string[] = [],
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
      location: subdomainTarget(label, keys, aliases, url.search, shelf),
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
    if (!res.ok) throw new Error(`${LEVELS_PATH}.json ${res.status}`);
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
 * The alias index, `shmupX/levelAliases/*`, read whole (a few short strings)
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

let shelfCache: { at: number; slugs: string[] } | null = null;

/**
 * Every Dezaemon shelf game's slug, from a shallow read of the library's index
 * (a few hundred short keys; the saves themselves are never touched), cached
 * for a minute like the level listing; null when the read fails and nothing is
 * cached yet. `fetcher` and `now` are injectable for tests.
 */
export async function cloudShelfSlugs(
  db: string = LEVELS_DB,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string[] | null> {
  if (shelfCache && now() - shelfCache.at < KEYS_CACHE_MS) {
    return shelfCache.slugs;
  }
  try {
    const res = await fetcher(`${db}/${SHELF_PATH}.json?shallow=true`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`${SHELF_PATH}.json ${res.status}`);
    const body = await res.json() as Record<string, unknown> | null;
    const slugs = body && typeof body === "object" ? Object.keys(body) : [];
    shelfCache = { at: now(), slugs };
    return slugs;
  } catch (err) {
    console.warn(
      "level subdomains: could not list shelf games:",
      (err as Error).message ?? err,
    );
    return shelfCache ? shelfCache.slugs : null;
  }
}

/** Forget the cached listings (tests). */
export function resetLevelKeysCache(): void {
  keysCache = null;
  aliasesCache = null;
  shelfCache = null;
}
