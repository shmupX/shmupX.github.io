// Is this level record a Dezaemon 2 cart, and does it have a story?
//
// Two questions the export pipeline has to answer the same way the runtime
// does, at every door a record can come in through — the shelf's own decode,
// a cached record from a previous run, the editor's POST, a job the build
// server picked up off the queue. They live here rather than in lib/shelf.ts
// so asking them costs nothing: shelf.ts pulls in the whole engine to decode a
// cart, and lib/export-build.ts has no reason to.
//
// The stakes are the story. A Dezaemon game has no adventure interludes — the
// format has nowhere to put a scene, a line of text or a cutscene picture — so
// `mapSaveToGame` stamps `noStory` on every save it imports. The runtime's
// fallback for a level that carries no story of its own is 2028.Ai's hardcoded
// world-map scenario, so a cart that reaches the builder without the flag
// opens on somebody else's story, in somebody else's voice, under somebody
// else's title. The flag has to survive every hop, and this is what makes it.

/** The whole-game records only a Dezaemon import carries. */
const DEZAEMON_KEYS = [
  "dezaemonBgm",
  "dezaemonTitle",
  "dezaemonTitleScreen",
  "dezaemonModels",
  "dezaemonBullets",
  "dezaemonItems",
  "dezaemonCredits",
] as const;

/**
 * Whether a level record came out of a Dezaemon 2 cart.
 *
 * The same three questions `isImportedLevel()` asks in
 * static/games/2028-ai/game.bundle.js, in the same order, so the build side and
 * the runtime cannot disagree about what an import is: the stamp
 * `mapSaveToGame` writes into `meta`, then the whole-game records only a cart
 * has, then the per-enemy Dezaemon block — which is the one that survives a
 * record being passed through a whitelist that has never heard of the others.
 */
export function isImportedRecord(record: Record<string, unknown>): boolean {
  const meta = record.meta as
    | { source?: unknown; dezaemonSettings?: unknown }
    | null
    | undefined;
  if (meta && (meta.source === "dezaemon2" || meta.dezaemonSettings)) {
    return true;
  }
  for (const key of DEZAEMON_KEYS) if (record[key]) return true;
  const enemies = record.enemyData as
    | Record<string, { dezaemon?: unknown } | null>
    | null
    | undefined;
  for (const key in enemies ?? {}) if (enemies?.[key]?.dezaemon) return true;
  return false;
}

/**
 * Make an imported record say out loud that it has no story.
 *
 * Only ever turns story OFF, and only on a record that IS an import and has no
 * story of its own — a cart whose author added scenes in the editor keeps them,
 * and a stock level is never touched. Mutates in place and returns whether
 * anything changed, so a caller holding a cached file knows to write it back.
 */
export function forceImportedNoStory(record: Record<string, unknown>): boolean {
  if (record.noStory === true) return false;
  if (record.storyData) return false;
  if (!isImportedRecord(record)) return false;
  record.noStory = true;
  return true;
}
