// The catalog database. spriteX, the Pixel Editor, the Tilemap Editor and the
// level editor all read and write this one Realtime Database, so a character
// published here is a character those tools list — that is the whole point of
// putting creation on an MCP server rather than in a new editor screen. (The
// level editor, the game and spriteX at codemonkey.games/spriteX/ read
// shmupX's subtree, below; spriteX at easierbycode.com still lists cmg's
// catalog, not this one.)
//
// Reads are plain GETs. Writes are PUTs and there is no auth: the database is
// open-write (see the /characters route's note about it), so every write path
// in this module is gated behind an explicit `apply` in the tool layer and
// every key is validated before it is interpolated into a URL.
//
// The database is shared with cmg, and shmupX's own catalog is a subtree of
// it: levels, levelAliases, atlases and characters live under `shmupX/`
// (lib/rtdb-root.ts), while the root-level copies of those four are cmg's.
// Every path this module is handed is spelled the way it always was —
// "characters/dezaBoss0", "levels/gs/bossData" — and nodeUrl puts the shmupX
// root in front of the scoped ones, so every read and every write of the
// tools lands in shmupX's subtree. Everything else (sprites/, spriteX's
// whole-image art) stays at the root. The base URL is the DATABASE, never
// the subtree: pointing SHMUPX_DB at <db>/shmupX would re-root sprites/ too.
//
// One read is allowed past the subtree, and only a read: `unscoped`, for
// SOURCE art (art.ts), where cmg's full atlas catalog is what "any frame of
// any atlas" has always meant. There is deliberately no unscoped write.

import { RTDB_ROOT, rtdbPath } from "../../lib/rtdb-root.ts";

const DEFAULT_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

let overrideUrl: string | null = null;

/**
 * Point this module at another database for the rest of the process, or
 * back at the environment with null. Tests use it instead of Deno.env so two
 * test files running in parallel isolates cannot redirect each other's
 * fetches through the one process-wide environment.
 */
export function setDatabaseUrl(url: string | null): void {
  overrideUrl = url;
}

/**
 * The database this server talks to — its base, not shmupX's subtree.
 * `SHMUPX_DB` overrides it for testing.
 */
export function databaseUrl(): string {
  return overrideUrl ?? Deno.env.get("SHMUPX_DB") ?? DEFAULT_DB;
}

/** The URL of shmupX's own subtree, to report which tree a read came from. */
export function catalogUrl(): string {
  return `${databaseUrl()}/${RTDB_ROOT}`;
}

export interface ReadOptions {
  /**
   * Read the database-root copy of a scoped node — cmg's catalog — instead
   * of shmupX's. For source art only (art.ts); there is no write counterpart.
   */
  unscoped?: boolean;
}

/**
 * The path a node really has in the database: the shmupX root in front of
 * levels/levelAliases/atlases/characters, everything else as given. What the
 * errors name, so a failure says which tree it was reading.
 */
export function dbPath(
  path: string,
  { unscoped = false }: ReadOptions = {},
): string {
  return unscoped ? path : rtdbPath(path);
}

export class RtdbError extends Error {
  override name = "RtdbError";
}

// Firebase RTDB keys cannot contain "." — the level loader encodes it as the
// one-dot-leader (U+2024) on write and decodes it back on read. Atlas frame
// names are almost all "foo0.png", so every frame map crossing this boundary
// goes through these. Kept byte-identical to encodeFirebaseKey /
// decodeFirebaseKey in static/phaser-plugins/level-loader.js:150-157.
export function encodeKey(key: string): string {
  return key.replace(/\./g, "․");
}

export function decodeKey(key: string): string {
  return key.replace(/․/g, ".");
}

/**
 * The OTHER frame-key encoding in this catalog: `k_` followed by the name's
 * UTF-16 code units in 4-digit hex. spriteX writes it for atlases that
 * round-tripped through RTDB as object trees rather than as one JSON string,
 * where every frame name was itself a key and "." was not the only character
 * Firebase refused. `bg-great-hall`'s single frame is stored this way, so an
 * atlas reader that does not decode it sees one frame called
 * "k_00610074006c00610073005f00730030" instead of "atlas_s0".
 *
 * Kept in step with decodeFrameKey in spriteX's scripts/frame-keys.mjs.
 */
export function decodeFrameKey(key: string): string {
  if (!key.startsWith("k_")) return key;
  const hex = key.slice(2);
  // A name that merely starts with "k_" is not an encoding — pass it through.
  if (hex.length === 0 || hex.length % 4 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return key;
  }
  let out = "";
  for (let i = 0; i < hex.length; i += 4) {
    out += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

/** Idempotent inverse of decodeFrameKey — never stacks a second layer. */
export function encodeFrameKey(name: string): string {
  if (decodeFrameKey(name) !== name) return name;
  let hex = "";
  for (let i = 0; i < name.length; i++) {
    hex += name.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `k_${hex}`;
}

/** Both encodings, outermost first: a frame name as an author would write it. */
export function decodeFrameName(key: string): string {
  return decodeKey(decodeFrameKey(key));
}

/**
 * A single path segment that is safe to interpolate into a database URL.
 *
 * Firebase rejects `.`, `#`, `$`, `[` and `]` in keys outright, but the reason
 * to check here is `/` and `..`: a name like `../atlases/game_asset` would
 * otherwise walk the URL to a node the caller never asked for — and on the
 * write side, silently overwrite it. Same rule spriteX's MCP server publishes
 * fonts by.
 */
export function assertSafeKey(kind: string, key: string): void {
  if (!/^[\w-]+$/.test(key)) {
    throw new RtdbError(
      `${kind} must be a plain identifier (letters, digits, _ or -), got ${
        JSON.stringify(key)
      }.`,
    );
  }
}

/**
 * The REST URL for a node, with `.json` where Firebase needs it.
 *
 * The suffix belongs to the PATH, not to the end of the whole URL: it is what
 * tells the database to answer with the node's JSON, and a request without it
 * is a request for the console's web UI, which it answers with a 301 to
 * console.firebase.google.com. `listKeys` passes "<node>?shallow=true", so
 * appending blindly built "/characters?shallow=true.json" -- a path carrying no
 * suffix at all, whose redirect then decided the outcome: a session that cannot
 * reach the console failed the fetch outright, and one that could got the
 * console's HTML and threw on .json(). Neither names the cause, and both land
 * in the first step of creating a character.
 */
export function nodeUrl(path: string, options: ReadOptions = {}): string {
  const cut = path.indexOf("?");
  const node = cut === -1 ? path : path.slice(0, cut);
  const query = cut === -1 ? "" : path.slice(cut);
  return `${databaseUrl()}/${dbPath(node, options)}.json${query}`;
}

async function request(
  path: string,
  init?: RequestInit,
  options: ReadOptions = {},
): Promise<Response> {
  const url = nodeUrl(path, options);
  const where = dbPath(path, options);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
  } catch (err) {
    throw new RtdbError(
      `${init?.method ?? "GET"} ${where} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new RtdbError(
      `${
        init?.method ?? "GET"
      } ${where} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return res;
}

/** Read a node. Returns null for a node that does not exist. */
export async function get<T = unknown>(
  path: string,
  options: ReadOptions = {},
): Promise<T | null> {
  return (await (await request(path, undefined, options)).json()) as T | null;
}

export interface Fetched<T> {
  value: T | null;
  /** The node's ETag at the moment it was read, for a conditional write. */
  etag: string | null;
}

/**
 * Read a node together with its ETag. Asking with `X-Firebase-ETag: true`
 * makes the database stamp the answer; handing that stamp back on a PUT as
 * `if-match` turns a lost-update race into a refusal. `timeoutMs` (30 s by
 * default) bounds the whole read, body included: a megabytes-long data URL
 * over a slow link needs more.
 */
export async function getWithEtag<T = unknown>(
  path: string,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<Fetched<T>> {
  const res = await request(path, {
    headers: { "X-Firebase-ETag": "true" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    value: (await res.json()) as T | null,
    etag: res.headers.get("etag"),
  };
}

/**
 * List a node's immediate child keys without downloading their bodies.
 * `?shallow=true` answers with `{key: true}` — the only sane way to list
 * /atlases, whose 400 children carry a megabyte of base64 each.
 */
export async function listKeys(
  path: string,
  options: ReadOptions = {},
): Promise<string[]> {
  const data = await (await request(`${path}?shallow=true`, undefined, options))
    .json();
  return data && typeof data === "object" ? Object.keys(data).sort() : [];
}

/**
 * Replace a node. With `ifMatch` — an ETag from getWithEtag — the database
 * refuses (412) when the node has changed since that read, and the refusal
 * arrives as an error that says so rather than as a silent overwrite. The
 * atlases are shared with spriteX and both editors, so an in-place rewrite
 * of one is exactly the write that needs this. `timeoutMs` as for
 * getWithEtag.
 */
export async function put(
  path: string,
  value: unknown,
  { ifMatch, timeoutMs = 30_000 }: {
    ifMatch?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (ifMatch) headers["if-match"] = ifMatch;
  // Always the scoped spelling: a write never reaches cmg's root copy.
  const url = nodeUrl(path);
  const where = dbPath(path);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new RtdbError(
      `PUT ${where} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (res.status === 412) {
    throw new RtdbError(
      `PUT ${where} refused: the node changed since it was read (ETag mismatch). ` +
        `Something else wrote it in the meantime — read it again and redo the edit.`,
    );
  }
  if (!res.ok) {
    throw new RtdbError(
      `PUT ${where} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
}
