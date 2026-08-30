// Shared fixture access for the engine tests.
//
// The .sav/.bcr/.bkr fixtures are community-created Saturn saves and are
// gitignored (see the repo root .gitignore) — they never ship with the repo
// or the JSR package. Tests that need them are declared with
// `ignore: !hasFixtures(...)` so the suite stays green when they are absent;
// drop the files into packages/shmup-engine/fixtures/ to run the full suite.

const FIXTURES_DIR = new URL("../fixtures/", import.meta.url);

export function fixtureUrl(name) {
  return new URL(name, FIXTURES_DIR);
}

/** True when every named fixture file is present locally. */
export function hasFixtures(...names) {
  return names.every((name) => {
    try {
      Deno.statSync(fixtureUrl(name));
      return true;
    } catch {
      return false;
    }
  });
}

/** Read a fixture file (bytes). Only call from tests gated on hasFixtures. */
export function loadFixture(name) {
  return Deno.readFileSync(fixtureUrl(name));
}

/** Read a fixture file as UTF-8 text. */
export function loadFixtureText(name) {
  return Deno.readTextFileSync(fixtureUrl(name));
}

// --- The Saturn sample bank -------------------------------------------------
//
// SNDPAC.BIN is disc content: not in this repo, not in the JSR package, and
// not in fixtures/ either. Tone-bank tests find it the same way the build
// does — a bare copy, the extraction cache, or straight out of a Dezaemon 2
// disc image dropped in the repo's gitignored dev-fixtures/.

import { openDisc, readFile } from "../src/cd/iso9660-read.js";

const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);
const BANK_CANDIDATES = [
  fixtureUrl("SNDPAC.BIN"),
  new URL(".cache/SNDPAC.BIN", DEV_FIXTURES),
  new URL("SNDPAC.BIN", DEV_FIXTURES),
];
const DISC_EXTENSIONS = [".bin", ".iso", ".img"];

function readIfPresent(url) {
  try {
    return Deno.readFileSync(url);
  } catch {
    return null;
  }
}

/**
 * SNDPAC.BIN bytes, or null when there is nothing local to read. Tests gate on
 * this so the suite stays green on a checkout without the disc.
 */
export function loadSoundBank() {
  for (const url of BANK_CANDIDATES) {
    const bytes = readIfPresent(url);
    if (bytes) return bytes;
  }
  let entries;
  try {
    entries = [...Deno.readDirSync(DEV_FIXTURES)];
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile) continue;
    const lower = entry.name.toLowerCase();
    if (!DISC_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const image = readIfPresent(
      new URL(encodeURIComponent(entry.name), DEV_FIXTURES),
    );
    if (!image) continue;
    const disc = openDisc(image);
    const found = disc && readFile(disc, "SNDPAC.BIN");
    if (found) return found;
  }
  return null;
}

let bankProbe;
/** True when loadSoundBank() will return bytes. Cached — the scan reads discs. */
export function hasSoundBank() {
  if (bankProbe === undefined) bankProbe = loadSoundBank();
  return bankProbe !== null;
}
