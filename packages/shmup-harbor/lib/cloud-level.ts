// Which shmupX cloud level a typed name means, and its record.
//
// Every harbor build that takes a level by NAME comes through here: the PS2
// disc (lib/ps2/build.ts), the five cart writers (scripts/build-sav.ts
// loadLevel, which build-ddd, build-kids, build-sfc and build-plus share), and
// the shelf's cloud rung (lib/shelf.ts), which only asks whether the level is
// there. tools/build-level is plain Node and keeps a CommonJS copy of the same
// steps in lib/fetch-level.js; tests/cloud_level_test.ts drives both against
// one fake database and compares the URLs they ask for.
//
// The steps are the runtime level-loader's (static/phaser-plugins/
// level-loader.js fetchLevel), so a name means the same game in a build as it
// does on the website:
//
//   1. shmupX/levels/<name> — the name as typed, case and all. "Ramsie" and
//      "ramsie" were two different records at the root, so nothing here
//      lowercases a level key.
//   2. shmupX/levelAliases/<name lowercased> — an alias index the editor and
//      scripts/level-alias.ts keep in lowercase. "2019" and "StreetFighter"
//      both name 2019-PS2, whose key nobody types.
//   3. shmupX/levels/<the key the alias names>.
//
// Never the root copies. Those are cmg's catalog (rtdb-root.ts says why), and
// falling back to them would build a game shmupX does not ship, or cmg's
// version of one it does, with nothing in the log to say so.

import { rtdbPath } from "./rtdb-root.ts";

/** The database base every name is read from; the root prefix goes on top. */
export const CLOUD_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** GET one REST path and answer the parsed JSON (null for an empty node). */
export type JsonGet = (url: string) => Promise<unknown>;

export interface CloudLevelOptions {
  /** Database base URL — the root, never `<db>/shmupX`. Default CLOUD_DB. */
  db?: string;
  /** How a URL is read. Defaults to fetch(), throwing on a non-2xx answer. */
  get?: JsonGet;
  /** Whether what a level path answered is a level. Default: any value. */
  accept?: (value: unknown) => boolean;
  /**
   * Read the levels with `?shallow=true`: an answer of `true`-per-child
   * rather than the record, which for a level with a custom atlas is several
   * megabytes a caller that only asks "is it there?" has no use for.
   */
  shallow?: boolean;
}

export interface CloudLevel {
  /** The level's key under shmupX/levels — the name, or what it aliases. */
  key: string;
  /** The name as typed when it was an alias rather than a key, else null. */
  alias: string | null;
  /** What the level path answered: the record, or the shallow map. */
  value: unknown;
  /** The URL that answered it. */
  url: string;
}

/** `<db>/shmupX/levels/<name>.json`, with `?shallow=true` when asked. */
export function cloudLevelUrl(
  name: string,
  db: string = CLOUD_DB,
  shallow = false,
): string {
  return `${db}/${rtdbPath(`levels/${encodeURIComponent(name)}`)}.json` +
    (shallow ? "?shallow=true" : "");
}

/** `<db>/shmupX/levelAliases/<name lowercased>.json`. */
export function cloudAliasUrl(name: string, db: string = CLOUD_DB): string {
  return `${db}/${
    rtdbPath(`levelAliases/${encodeURIComponent(name.toLowerCase())}`)
  }.json`;
}

/** The default reader: a non-2xx answer is an error the caller reports. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    // A body left unread keeps the connection from being reused.
    await response.body?.cancel();
    throw new Error(`could not read the level (HTTP ${response.status})`);
  }
  return await response.json();
}

/**
 * The level `name` means, or null when shmupX has no such level.
 *
 * A failed read of the level itself is thrown — a database that is down is
 * not a level that is missing. A failed read of the alias index is a miss,
 * as it is in the runtime: the name was not a key, and an index that cannot
 * be read names nothing.
 */
export async function resolveCloudLevel(
  name: string,
  opts: CloudLevelOptions = {},
): Promise<CloudLevel | null> {
  const db = opts.db ?? CLOUD_DB;
  const get = opts.get ?? fetchJson;
  const accept = opts.accept ?? ((value: unknown) => value != null);
  const shallow = !!opts.shallow;
  const typed = String(name ?? "");
  if (!typed) return null;

  const direct = cloudLevelUrl(typed, db, shallow);
  const value = await get(direct);
  if (accept(value)) return { key: typed, alias: null, value, url: direct };

  let key: unknown = null;
  try {
    key = await get(cloudAliasUrl(typed, db));
  } catch (_e) {
    return null;
  }
  if (typeof key !== "string" || !key || key === typed) return null;
  const aliased = cloudLevelUrl(key, db, shallow);
  const target = await get(aliased);
  if (!accept(target)) return null;
  return { key, alias: typed, value: target, url: aliased };
}
