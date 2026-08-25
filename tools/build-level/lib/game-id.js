"use strict";

// Which leaderboard an exported app writes to.
//
// This is a deliberate CommonJS mirror of `2019-es7/src/gameIdentity.js`. The
// build tool is standalone by design — it must stage an app from cmg's own
// in-repo game with no 2019-es7 checkout present — so it cannot import the
// runtime module, and the runtime (an ES module in the browser bundle) cannot
// import this one. The two must agree exactly or an app would score to a
// different board than the hosted player does, so
// tests/build_level_game_id_test.ts cross-checks them against each other and
// skips only when the sibling checkout is absent.
//
// Keep the two in sync: any change here needs the same change there.

const ID_MAX = 48;

// RTDB keys cannot contain . $ # [ ] / or control characters, and level names
// are user-supplied, so everything outside a conservative set is collapsed.
function slugifyGameId(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ID_MAX);
}

// A short, stable digest of the name — keeps two levels whose names slugify to
// the same thing (e.g. "Ramsie" and "ramsie!") on separate boards.
function nameDigest(name) {
  let h = 0x811c9dc5;
  const s = String(name == null ? "" : name);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// The id for a level record. An explicit gameId (minted by the editor the first
// time the level was saved) wins; otherwise it is derived from the name so a
// record saved before gameId existed still gets a stable board of its own.
function gameIdForLevel(level) {
  if (!level || typeof level !== "object") return null;
  if (typeof level.gameId === "string" && level.gameId.trim()) {
    return slugifyGameId(level.gameId) || null;
  }
  const name = typeof level.name === "string" ? level.name : "";
  if (!name.trim()) return null;
  const slug = slugifyGameId(name) || "level";
  return slug + "-" + nameDigest(name);
}

module.exports = { slugifyGameId, gameIdForLevel };
