// scripts/normalize-cloud-level.ts — bring a stored cloud level's 2019 names
// up to today's, in place.
//
//   deno task level:normalize "2019-PS2"             # what it would change; writes nothing
//   deno task level:normalize "2019-PS2" -- --write  # patch the record
//
// A level saved from the 2019 web game's game.json names its bullets for a
// sheet the runtime no longer has (`normalTama0.gif`, `sagat_tamaA0.gif`) and
// its gauge fields `cagage` / `caDamage`. The runtime finds no such frames, so
// those bullets draw nothing — on the PS2 the export logs them as "not found
// in either sheet" — and reads `spgage`, so kills grant a default gauge. The
// editor now renames all of this on load (packages/shmup-engine
// src/legacy-names.js), so opening and re-saving the level would do the same;
// this is the same rename without the round trip through a browser.
//
// WRITES ARE OPT-IN. The default is a dry run against the live database:
// it prints every frame and field that would change and stops. `--write`
// PATCHes only the subtrees that changed (enemyData, bossData, playerData,
// playerData2, atlasFrames), leaving the rest of the record — grid, stages,
// thumbnails, scores — exactly as it was.

import {
  normalizeLegacyAtlasFrames,
  normalizeLegacyGame,
} from "@shmupx/shmup-engine/legacy-names";

const FIREBASE_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

// The parts of a record the rename can touch — fetched one by one so the
// level's atlas image and thumbnails never come down at all.
const PARTS = [
  "enemyData",
  "bossData",
  "playerData",
  "playerData2",
  "atlasFrames",
] as const;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const args = Deno.args.filter((arg) => arg !== "--");
const write = args.includes("--write");
const names = args.filter((arg) => !arg.startsWith("--"));
if (names.length !== 1) {
  fail(
    'expected exactly one level name, e.g. deno task level:normalize "2019-PS2"',
  );
}
const name = names[0];
const base = `${FIREBASE_DB}/levels/${encodeURIComponent(name)}`;

const exists = await fetch(`${base}/name.json`);
if (!exists.ok || (await exists.json()) === null) {
  fail(`level "${name}" not found`);
}

const record: Record<string, unknown> = {};
for (const part of PARTS) {
  const response = await fetch(`${base}/${part}.json`);
  if (!response.ok) fail(`could not read ${part} (HTTP ${response.status})`);
  const value = await response.json();
  if (value !== null) record[part] = value;
}

const before = JSON.stringify(record);
const report = normalizeLegacyGame(record);
if (record.atlasFrames) {
  record.atlasFrames = normalizeLegacyAtlasFrames(
    record.atlasFrames as Record<string, unknown>,
  );
}

console.log(`Level  : ${name}`);
for (const change of report.frames) {
  console.log(`  frame : ${change.path}: ${change.from} -> ${change.to}`);
}
for (const change of report.fields) {
  console.log(`  field : ${change.path} -> ${change.to}`);
}
const changed = PARTS.filter((part) =>
  part in record &&
  JSON.stringify(record[part]) !==
    JSON.stringify(JSON.parse(before)[part] ?? null)
);
if (changed.length === 0) {
  console.log("  nothing to change — the level already uses today's names");
  Deno.exit(0);
}
console.log(
  `  ${report.frames.length} frame reference(s), ${report.fields.length} ` +
    `field(s); subtrees to write: ${changed.join(", ")}`,
);

if (!write) {
  console.log("\nDry run — nothing written. Re-run with --write to patch it.");
  Deno.exit(0);
}

const patch: Record<string, unknown> = {};
for (const part of changed) patch[part] = record[part];
const response = await fetch(`${base}.json`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(patch),
});
if (!response.ok) {
  fail(`PATCH failed (HTTP ${response.status}): ${await response.text()}`);
}
console.log(`\nWritten: ${changed.join(", ")} of levels/${name}`);
