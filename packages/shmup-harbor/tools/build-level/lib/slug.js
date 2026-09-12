"use strict";

// slugify: lowercase alphanumeric, max 30 chars, used for build dir + artifact
// names. lib/export-build.ts `slugFor` is the Deno mirror of this function
// (scripts/build-desktop.ts imports it from there rather than keeping a third
// copy), and tests/build_level_slug_test.ts cross-checks the two — keep them in
// sync, or the server looks for the artifact in a directory the tool never
// wrote.
//
// WHY A DIGEST HANGS OFF SOME SLUGS
// Stripping everything outside [a-z0-9] is fine for "G-Fencer 755"
// ("gfencer755") and wrong for a title written in another script: 111 of the
// 228 Japanese titles in static/editor/dezaemon/games-db.json have no ASCII
// alphanumerics at all, so every one of them used to become the bare constant
// "level" — one shared build/level/ tree, one level.exe / level.AppImage /
// level-app-debug.apk, one com.easierbycode.level package id, and one
// build/records/level.json. Eight more titles end in a "2" and nothing else
// Latin, so they all collided on "2". A build of the second game silently
// overwrote the first.
//
// So: when the slug still SPELLS the name it keeps its plain shape and nothing
// that works today moves. When it does not — because the name's own characters
// were dropped, or because it ran past 30 — an 8-hex digest of the full name is
// appended, exactly the way `nameDigest` keeps two same-slug leaderboards apart
// in lib/game-id.js and the SHA-256 suffix keeps two same-title carts apart in
// lib/shelf.ts `cacheKey`. The slug is there to make the directory readable;
// the digest is what makes it identify one game.

// The characters a slug may lose without losing meaning: ASCII whitespace and
// punctuation separate words rather than spell them, so "G-Fencer 755" is
// fully spelled by "gfencer755". Everything else — kana, hanzi, Cyrillic,
// accented Latin, emoji — is content.
const SEPARATORS = /[\s!-\/:-@\[-`{-~]+/g;

const SLUG_MAX = 30;

// A short, stable digest of a name. FNV-1a, 32-bit, as 8 hex digits — the same
// function lib/game-id.js uses for leaderboard ids. It is duplicated rather
// than shared because that file is a deliberate line-for-line mirror of
// 2019-es7's gameIdentity.js and must not grow imports.
function nameDigest(name) {
  let h = 0x811c9dc5;
  const s = String(name == null ? "" : name);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function slugify(name) {
  const raw = String(name || "");
  // No name at all: there is nothing to tell apart, so keep the bare constant
  // this has always returned rather than a digest of the empty string.
  if (!raw.trim()) return "level";
  const letters = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const slug = letters.slice(0, SLUG_MAX);
  // What the slug threw away that was not a separator: if this is empty and
  // nothing was truncated, the slug spells the whole name and stands alone.
  const lost = raw.replace(SEPARATORS, "").replace(/[a-zA-Z0-9]+/g, "");
  if (slug && !lost && letters.length <= SLUG_MAX) return slug;
  return `${slug || "level"}-${nameDigest(raw)}`;
}

// Java/Android reserved words can't be used as a package-name segment.
const JAVA_RESERVED = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "final", "finally", "float", "for", "goto", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "native", "new",
  "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws",
  "transient", "try", "void", "volatile", "while", "true", "false", "null",
]);

// The slug is fine for filenames but not always a valid package-name segment: a
// segment must start with a letter and must not be a reserved word. The case
// that actually bites is an all-numeric level name (e.g. "0707" ->
// "com.easierbycode.0707", which cordova rejects with "not a valid
// identifier"). Normalise to a stable, valid segment WITHOUT changing the slug
// used for build dirs/artifacts. The `-` a digested slug carries goes the same
// way, so "level-3f2a1c04" becomes the segment "level3f2a1c04" — still one
// package id per game, which is what the collision cost before.
function safePackageSegment(slug) {
  let s = slug.replace(/[^a-z0-9_]/g, "");
  if (!s) s = "app";
  if (!/^[a-z_]/.test(s)) s = "a" + s; // must not start with a digit
  if (JAVA_RESERVED.has(s)) s = s + "_";
  return s;
}

function packageIdFor(name) {
  return "com.easierbycode." + safePackageSegment(slugify(name));
}

module.exports = { slugify, packageIdFor, safePackageSegment, nameDigest };
