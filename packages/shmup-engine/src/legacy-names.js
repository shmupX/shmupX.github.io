// The names the 2019 web game used, mapped onto the ones the 2028-ai base
// game uses today — which is what every runtime that opens a level reads.
//
// Between the two, the base atlas renamed every bullet frame (`normalTama0`
// became `normalProjectile0`, `sagat_tamaA0` became `sagat_projectileA0`, the
// CA BOMB's `caExplosion00` became `spExplosion00`) and game.json renamed the
// gauge fields: `cagage`, the 2019 game's CA gauge, became `spgage`, and the
// bomb's `caDamage` became `spDamage`. A game.json from that era — or a cloud
// level saved from one, like 2019-PS2 — still carries the old names. The
// runtime looks the frames up in the current atlas and finds nothing, so those
// bullets draw nothing on the console; it reads `spgage` and falls back to a
// default, so kills grant the wrong gauge.
//
// The level editor runs this over every game it opens (directory import,
// cloud load), so a re-save writes current names; scripts/normalize-cloud-level.ts
// runs it over a stored record in place. Every step only touches a name it
// recognises, so running it twice changes nothing the second time.

const FRAME_RENAMES = [
  // `<x>Tama<A-C?><n>` -> `<x>Projectile<A-C?><n>`: normalTama0, vegaTama2.
  [/Tama(?=[A-Z]?\d+[.․](?:gif|png)$)/, "Projectile"],
  // `<boss>_tama<A-C?><n>` -> `<boss>_projectile<A-C?><n>`: sagat_tamaA0.
  [/_tama(?=[A-Z]?\d+[.․](?:gif|png)$)/, "_projectile"],
  // The CA BOMB's blast is the SP blast now.
  [/^caExplosion(?=\d+[.․](?:gif|png)$)/, "spExplosion"],
];

// Old field -> new field, on enemy, boss, bullet and player records alike.
const FIELD_RENAMES = { cagage: "spgage", caDamage: "spDamage" };

// The keys that hold frame names: plain arrays of them, or (for `anim`) a
// map of animation name -> array of them.
const TEXTURE_KEYS = new Set(["texture", "attackTexture", "itemTexture"]);

/**
 * @typedef {{ path: string, from: string, to: string }} FrameRename
 *   One frame reference renamed: where it sat, what it said, what it says now.
 * @typedef {{ path: string, to: string }} FieldRename
 *   One field renamed: where it sat and the key it is under now.
 * @typedef {{ frames: FrameRename[], fields: FieldRename[] }} LegacyReport
 */

/**
 * A frame name as the current atlas spells it. Names it does not recognise
 * come back untouched. The `․` (one-dot leader) form the editor stores atlas
 * keys under in Firebase is understood too.
 *
 * @template T
 * @param {T} name
 * @returns {T}
 */
export function legacyFrameName(name) {
  if (typeof name !== "string") return name;
  let out = name;
  for (const [pattern, to] of FRAME_RENAMES) out = out.replace(pattern, to);
  return out;
}

/**
 * Rename the old frame names and fields inside one record — an enemy, a
 * boss, a player, or anything holding `texture` arrays and `bulletData`s —
 * in place. `report` collects what changed; `path` is where this record
 * lives, for the report.
 *
 * @param {unknown} record
 * @param {string} path
 * @param {LegacyReport} report
 * @param {Set<object>} seen
 */
function normalizeRecord(record, path, report, seen) {
  if (!record || typeof record !== "object" || seen.has(record)) return;
  seen.add(record);
  if (Array.isArray(record)) {
    for (let i = 0; i < record.length; i++) {
      normalizeRecord(record[i], `${path}[${i}]`, report, seen);
    }
    return;
  }
  for (const [from, to] of Object.entries(FIELD_RENAMES)) {
    if (!(from in record)) continue;
    // A record that already carries the new name keeps it; the old one is
    // only ever a leftover then.
    if (!(to in record)) record[to] = record[from];
    delete record[from];
    report.fields.push({ path: `${path}.${from}`, to });
  }
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (TEXTURE_KEYS.has(key) && Array.isArray(value)) {
      renameFrames(value, `${path}.${key}`, report);
    } else if (key === "anim" && value && typeof value === "object") {
      for (const [animName, frames] of Object.entries(value)) {
        if (Array.isArray(frames)) {
          renameFrames(frames, `${path}.anim.${animName}`, report);
        }
      }
    } else if (value && typeof value === "object") {
      normalizeRecord(value, `${path}.${key}`, report, seen);
    }
  }
}

/**
 * @param {unknown[]} list
 * @param {string} path
 * @param {LegacyReport} report
 */
function renameFrames(list, path, report) {
  for (let i = 0; i < list.length; i++) {
    const to = legacyFrameName(list[i]);
    if (to === list[i]) continue;
    report.frames.push({ path: `${path}[${i}]`, from: list[i], to });
    list[i] = to;
  }
}

/**
 * Bring a game.json, or a cloud level record (the same `enemyData`,
 * `bossData`, `playerData` at the top), up to today's names, in place.
 *
 * Returns what changed: `frames` (each frame reference renamed) and `fields`
 * (each gauge field renamed), both empty when the game already used the
 * current names.
 *
 * @param {unknown} game
 * @returns {LegacyReport}
 */
export function normalizeLegacyGame(game) {
  /** @type {LegacyReport} */
  const report = { frames: [], fields: [] };
  if (!game || typeof game !== "object") return report;
  const seen = new Set();
  for (const key of ["enemyData", "bossData", "playerData", "playerData2"]) {
    if (game[key] && typeof game[key] === "object") {
      normalizeRecord(game[key], key, report, seen);
    }
  }
  return report;
}

/**
 * An atlas's frame table with its keys brought up to today's names, so a
 * 2019 sheet opened beside a normalised game still resolves every reference.
 * A key whose new spelling the table already holds is left alone — the
 * current frame wins. Keys may be plain (`normalTama0.gif`) or in the
 * editor's Firebase form (`normalTama0․gif`).
 *
 * @template {Record<string, unknown> | null | undefined} T
 * @param {T} frames
 * @returns {T}
 */
export function normalizeLegacyAtlasFrames(frames) {
  if (!frames || typeof frames !== "object") return frames;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(frames)) {
    const renamed = legacyFrameName(key);
    if (renamed !== key && (renamed in frames || renamed in out)) {
      out[key] = value;
      continue;
    }
    out[renamed] = value;
  }
  return /** @type {T} */ (out);
}
