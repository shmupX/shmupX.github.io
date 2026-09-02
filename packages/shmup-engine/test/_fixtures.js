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

const discCache = new Map();

/**
 * A named file off the disc, or null when there is nothing local to read:
 * the given candidate copies first, then dev-fixtures/.cache/<name>, a bare
 * dev-fixtures/<name>, then every disc image in dev-fixtures/. Tests gate on
 * this so the suite stays green on a checkout without the disc. Disc images
 * are opened once per process — the scan reads 7 MB files.
 */
export function loadDiscFile(name, candidates = []) {
  for (
    const url of [
      ...candidates,
      new URL(`.cache/${name}`, DEV_FIXTURES),
      new URL(name, DEV_FIXTURES),
    ]
  ) {
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
    let disc = discCache.get(entry.name);
    if (disc === undefined) {
      const image = readIfPresent(
        new URL(encodeURIComponent(entry.name), DEV_FIXTURES),
      );
      disc = image ? openDisc(image) : null;
      discCache.set(entry.name, disc);
    }
    const found = disc && readFile(disc, name);
    if (found) return found;
  }
  return null;
}

const discProbe = new Map();
/** True when loadDiscFile(name) will return bytes. Cached per name. */
export function hasDiscFile(name) {
  if (!discProbe.has(name)) discProbe.set(name, loadDiscFile(name) !== null);
  return discProbe.get(name);
}

/** SNDPAC.BIN bytes, or null (see loadDiscFile). */
export function loadSoundBank() {
  return loadDiscFile("SNDPAC.BIN", BANK_CANDIDATES);
}

let bankProbe;
/** True when loadSoundBank() will return bytes. Cached — the scan reads discs. */
export function hasSoundBank() {
  if (bankProbe === undefined) bankProbe = loadSoundBank();
  return bankProbe !== null;
}

// --- Saves that live in dev-fixtures/ rather than fixtures/ ----------------
//
// The community collection (and the disc's own sample games) sit in the
// repo-root dev-fixtures/, also gitignored. Tests that want one of those —
// DAIOH's six models, say — gate the same way.

export function devFixtureUrl(name) {
  return new URL(encodeURIComponent(name), DEV_FIXTURES);
}

export function hasDevFixtures(...names) {
  return names.every((name) => {
    try {
      Deno.statSync(devFixtureUrl(name));
      return true;
    } catch {
      return false;
    }
  });
}

export function loadDevFixture(name) {
  return Deno.readFileSync(devFixtureUrl(name));
}
