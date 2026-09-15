// The catalog database. spriteX, the Pixel Editor, the Tilemap Editor and the
// level editor all read and write this one Realtime Database, so a character
// published here is a character those tools list — that is the whole point of
// putting creation on an MCP server rather than in a new editor screen.
//
// Reads are plain GETs. Writes are PUTs and there is no auth: the database is
// open-write (see the /characters route's note about it), so every write path
// in this module is gated behind an explicit `apply` in the tool layer and
// every key is validated before it is interpolated into a URL.

const DEFAULT_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** The database this server talks to. `SHMUPX_DB` overrides it for testing. */
export function databaseUrl(): string {
  return Deno.env.get("SHMUPX_DB") ?? DEFAULT_DB;
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
export function nodeUrl(path: string): string {
  const cut = path.indexOf("?");
  const node = cut === -1 ? path : path.slice(0, cut);
  const query = cut === -1 ? "" : path.slice(cut);
  return `${databaseUrl()}/${node}.json${query}`;
}

async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = nodeUrl(path);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
  } catch (err) {
    throw new RtdbError(
      `${init?.method ?? "GET"} ${path} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new RtdbError(
      `${
        init?.method ?? "GET"
      } ${path} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return res;
}

/** Read a node. Returns null for a node that does not exist. */
export async function get<T = unknown>(path: string): Promise<T | null> {
  return (await (await request(path)).json()) as T | null;
}

/**
 * List a node's immediate child keys without downloading their bodies.
 * `?shallow=true` answers with `{key: true}` — the only sane way to list
 * /atlases, whose 400 children carry a megabyte of base64 each.
 */
export async function listKeys(path: string): Promise<string[]> {
  const data = await (await request(`${path}?shallow=true`)).json();
  return data && typeof data === "object" ? Object.keys(data).sort() : [];
}

/** Replace a node. */
export async function put(path: string, value: unknown): Promise<void> {
  await request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
