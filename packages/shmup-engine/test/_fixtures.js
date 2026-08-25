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
