// scripts/build-sample-songs.ts — 音まろ's 73 sample songs, for MUSIC's
// LOAD SAMPLE SONG.
//
//   deno task deza:samplesongs              → static/editor/dezaemon/sample-songs.{bin,json}
//   deno task deza:samplesongs --from <dir> (a folder holding M_DATA01-73.BIN)
//
// M_DATA01-73.BIN on the Dezaemon 2 disc are the songs the console's music
// editor offers as SS-25..SS-97: 4,228 bytes each, exactly a sec6 song slot
// (FORMAT.md; a cart that loaded one carries it byte for byte). They are read
// from the extraction cache (dev-fixtures/.cache/saturn-disc/), a bare copy, or
// a disc image in dev-fixtures/, and written as one .bin (73 slots back to
// back) and a small index. Published by the project's decision (2026-10-28):
// committed and served from static/ like mesh-library.json, and on Steam only
// in the members' Dezaemon 2 disc pack (lib/member-content.ts).
//
// Deterministic; with no disc the committed files stay authoritative and the
// task exits 0. Song names, where 音まろ's own table gives them, go in the
// index's `name` (empty until they are read off S_EDIT).

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { findDiscFiles } from "@shmupx/shmup-harbor/disc-file";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "static", "editor", "dezaemon");
const COUNT = 73;
const SIZE = 4228;

let from = join(ROOT, "dev-fixtures", ".cache", "saturn-disc");
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--from") from = resolve(Deno.args[++i] ?? "");
  else {
    console.error(`error: unknown argument ${Deno.args[i]}`);
    Deno.exit(2);
  }
}

const names = Array.from({ length: COUNT }, (_, i) => `M_DATA${String(i + 1).padStart(2, "0")}.BIN`);
const files: (Uint8Array | null)[] = await Promise.all(
  names.map((n) => Deno.readFile(join(from, n)).catch(() => null)),
);
let source = from;
if (files.some((f) => !f)) {
  const found = await findDiscFiles(ROOT, names);
  if (found) {
    found.files.forEach((f, i) => {
      if (!files[i] && f) files[i] = f;
    });
    source = found.from;
  }
}
const missing = names.filter((_, i) => !files[i] || files[i]!.length !== SIZE);
if (missing.length === COUNT) {
  console.log(
    `sample songs: no M_DATA*.BIN or Dezaemon 2 disc image in dev-fixtures/ — keeping ${
      relative(ROOT, join(OUT_DIR, "sample-songs.bin"))
    } as committed`,
  );
  Deno.exit(0);
}
if (missing.length) {
  console.error(`error: ${missing.length} sample songs missing or the wrong size: ${missing.join(", ")}`);
  Deno.exit(2);
}

const bin = new Uint8Array(COUNT * SIZE);
files.forEach((f, i) => bin.set(f!, i * SIZE));
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const index = {
  format: "deza-sample-songs",
  version: 1,
  count: COUNT,
  songSize: SIZE,
  sha256: await hex(bin),
  songs: await Promise.all(files.map(async (f, i) => ({ ss: 25 + i, file: names[i], name: "", sha256: await hex(f!) }))),
};
await Deno.mkdir(OUT_DIR, { recursive: true });
await Deno.writeFile(join(OUT_DIR, "sample-songs.bin"), bin);
await Deno.writeTextFile(join(OUT_DIR, "sample-songs.json"), JSON.stringify(index, null, 1) + "\n");
console.log(`sample songs: ${COUNT} songs (${bin.length.toLocaleString()} B) from ${source} → ${relative(ROOT, OUT_DIR)}`);
