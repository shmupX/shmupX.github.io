// What a Super Famicom Dezaemon dump's FILENAME means.
//
// Split out of scripts/upload-sfc-saves.ts so it can be tested without running
// the publisher — that script does its work at the top level, so importing it
// would upload the library. Everything here is pure.
//
// The collection names a file for the game and the day it was dumped:
//
//   ALDI Adventure (2026-08-22).srm
//   └── title ───┘ └─ dump date ┘
//
// which is an author's build rather than a catalogue entry, and is why the slug
// is taken from the title alone. Two dumps of the same game are the same game:
// re-dumping a work in progress has to update its shelf row, not add a second
// one beside it. (The Saturn publisher keys on the whole filename instead, for
// the opposite reason — there, five games-db rows are shared by two files each,
// so the titles are not unique and only the filenames are.)

/** Extensions worth LOOKING at. isSfcSav decides what is actually a dump. */
export const SFC_SAVE_EXT = /\.(srm|sav|sr[0-9])$/i;

/** A trailing " (YYYY-MM-DD)", the dump date the collection names files with. */
export const SFC_DUMP_DATE = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

/** "ALDI Adventure (2026-08-22).srm" -> "ALDI Adventure" */
export function sfcFileTitle(file: string): string {
  return file.replace(SFC_SAVE_EXT, "").replace(SFC_DUMP_DATE, "").trim();
}

/** "ALDI Adventure (2026-08-22).srm" -> "2026-08-22"; null when undated. */
export function sfcDumpDate(file: string): string | null {
  return SFC_DUMP_DATE.exec(file.replace(SFC_SAVE_EXT, ""))?.[1] ?? null;
}

/**
 * The slug the Super Famicom library keys on: lowercase, every run of
 * non-alphanumerics to one dash, ends trimmed.
 *
 * The same rule as slugOfTitle in static/deza-shelf.js, shelfSlug in
 * @shmupx/shmup-harbor and dezaSlugOfTitle in the editor — mirrored rather
 * than imported because static/ is plain browser ESM and cannot reach a .ts
 * module. sfcSlugOfTitle in static/snes-shelf.js is the browser's copy, and
 * a test holds the two equal (tests/sfc_library_test.ts).
 */
export function sfcSlugOfTitle(title: string): string {
  const s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "save";
}

/** The slug for a file in the collection: its title's. */
export function sfcSlugOfFile(file: string): string {
  return sfcSlugOfTitle(sfcFileTitle(file));
}

/**
 * True for a name the library walk should open. AppleDouble forks are excluded
 * here rather than at each call site: this collection lives on an exFAT volume,
 * which keeps extended attributes in a "._<name>" sidecar beside every file,
 * and those sidecars match the extension test exactly.
 */
export function isSfcSaveName(name: string): boolean {
  return !name.startsWith("._") && SFC_SAVE_EXT.test(name);
}
