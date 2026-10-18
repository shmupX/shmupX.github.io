// Finding a cloud level by the name a person gives it.
//
// shmupX's games live at shmupX/levels/<key> (rtdb.ts roots the path), and a
// game can also answer to aliases: shmupX/levelAliases/<lowercase alias> holds
// the key it stands for, so "2019" and "streetfighter" both mean 2019-PS2 —
// the index `deno task level:alias` writes and the level loader and the
// subdomain router read. A tool that takes a level name resolves it the way
// the loader does for ?level=: the exact key first, then the alias. Without
// that, "place it in 2019" read levels/2019, found nothing, and said the level
// had no bossData.

import { ArtError } from "./art.ts";
import { get, RtdbError } from "./rtdb.ts";

/**
 * A level name as a URL path segment. Level keys are what their authors
 * typed — "Daioh P!", "SummerCarnival'99 LECCA" — so the identifier rule the
 * other trees use is too strict here; what matters is that the segment
 * cannot walk the path or start a query.
 */
export function levelSegment(level: string): string {
  if (
    !level || level.length > 200 ||
    // deno-lint-ignore no-control-regex
    /[/.#$[\]\x00-\x1f\x7f]/.test(level)
  ) {
    throw new ArtError(
      `Level name ${JSON.stringify(level)} is not a valid database key.`,
    );
  }
  return encodeURIComponent(level);
}

export interface ResolvedLevel {
  /** The level's own key under shmupX/levels. */
  key: string;
  /** The alias that named it, lowercased, or null when the name was the key. */
  alias: string | null;
}

/**
 * The level `name` stands for: shmupX/levels/<name> when there is one, else
 * the key shmupX/levelAliases/<name lowercased> names, else null. The
 * existence check is a shallow read — a level carries its whole sheet as a
 * data URL, and nobody needs a megabyte to learn that it is there.
 */
export async function resolveLevelKey(
  name: string,
): Promise<ResolvedLevel | null> {
  const segment = levelSegment(name);
  if (await get<unknown>(`levels/${segment}?shallow=true`) !== null) {
    return { key: name, alias: null };
  }
  const alias = name.toLowerCase();
  let target: unknown;
  try {
    target = await get<unknown>(`levelAliases/${levelSegment(alias)}`);
  } catch (err) {
    // A name no alias could be spelled as is simply not an alias; a database
    // that could not be read is still an error.
    if (err instanceof RtdbError) throw err;
    return null;
  }
  if (typeof target !== "string" || !target) return null;
  levelSegment(target); // an index entry is data from an open-write tree
  return { key: target, alias };
}
