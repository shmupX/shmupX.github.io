"use strict";

// slugify: lowercase alphanumeric, max 30 chars, used for build dir + artifact
// names (routes/api/build-apk.ts mirrors this to locate the output). Keep it in
// sync there.
function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) ||
    "level";
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
// used for build dirs/artifacts.
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

module.exports = { slugify, packageIdFor, safePackageSegment };
