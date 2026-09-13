// A Dezaemon cart must never open on 2028.Ai's story.
//
// The rule that decides that — is this record an import, and does it have a
// story of its own — is written twice on purpose: once in Deno
// (lib/imported-level.ts, which the shelf and both browser-side export paths
// call) and once in plain Node (tools/build-level/lib/stage.js, the last door
// every APK goes through, including the one the Deno side never sees). There is
// no build step that could share it, so this is what keeps the two honest, and
// what pins both against the third copy — `isImportedLevel()` in
// static/games/2028-ai/game.bundle.js, whose three questions they mirror.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createRequire } from "node:module";
import { fromFileUrl } from "@std/path";
import {
  forceImportedNoStory,
  isImportedRecord,
} from "../lib/imported-level.ts";

// The Node half, loaded as Node loads it. fromFileUrl because this checkout
// lives on a volume with a space in its name, where a URL pathname keeps the
// space percent-encoded and require() cannot find the file.
const require = createRequire(import.meta.url);
const stage = require(
  fromFileUrl(new URL("../tools/build-level/lib/stage.js", import.meta.url)),
) as {
  isImportedRecord(record: unknown): boolean;
  withImportedNoStory(record: unknown): unknown;
};

/** Every shape that should read as a cart, and the signal that makes it one. */
const IMPORTS: [string, Record<string, unknown>][] = [
  ["the stamp mapSaveToGame writes", {
    meta: { version: "1.0", source: "dezaemon2" },
  }],
  ["a cart's own game mode, when the stamp is all that was lost", {
    meta: { version: "1.0", dezaemonSettings: { ships: 3 } },
  }],
  ["the save's soundtrack", { dezaemonBgm: { 0: "…" } }],
  ["the save's drawn title", { dezaemonTitle: { title1: "gsp_12" } }],
  ["the title's entrance program", { dezaemonTitleScreen: { entrance: [1] } }],
  ["the ポリ吉 models", { dezaemonModels: { 0: {} } }],
  ["the global bullet table", { dezaemonBullets: { a: {} } }],
  ["the global item table", { dezaemonItems: { a: {} } }],
  ["the community credits", { dezaemonCredits: { author: "somebody" } }],
  ["a single enemy's Dezaemon block — the last signal standing", {
    enemyData: { enemyA: { dezaemon: { record: 2 } } },
  }],
];

/** And every shape that must NOT, however Dezaemon-ish it looks. */
const NOT_IMPORTS: [string, Record<string, unknown>][] = [
  ["an empty record", {}],
  ["a stock level", { name: "My Level", enemylist: [["01"]] }],
  ["meta from a level that is not a cart", { meta: { version: "1.0" } }],
  ["a Dezaemon key that is present but empty", { dezaemonBgm: null }],
  ["an enemy with no Dezaemon block", { enemyData: { enemyA: { hp: 3 } } }],
  ["an enemy entry that is null", { enemyData: { enemyA: null } }],
];

Deno.test("every signal a cart can arrive with reads as an import", () => {
  for (const [why, record] of IMPORTS) {
    assert(isImportedRecord(record), `Deno: ${why}`);
    assert(stage.isImportedRecord(record), `Node: ${why}`);
  }
});

Deno.test("nothing else does — a stock level is never mistaken for a cart", () => {
  for (const [why, record] of NOT_IMPORTS) {
    assertFalse(isImportedRecord(record), `Deno: ${why}`);
    assertFalse(stage.isImportedRecord(record), `Node: ${why}`);
  }
});

Deno.test("an import with no story of its own gets the flag", () => {
  const record: Record<string, unknown> = {
    meta: { source: "dezaemon2" },
    enemylist: [["01"]],
  };
  assert(forceImportedNoStory(record), "the record had to be changed");
  assertEquals(record.noStory, true);
  // And the Node half reaches the same record, without mutating its input:
  // stage.js hands the copy to JSON.stringify and the caller keeps the original.
  const before: Record<string, unknown> = {
    meta: { source: "dezaemon2" },
    enemylist: [["01"]],
  };
  const after = stage.withImportedNoStory(before) as Record<string, unknown>;
  assertEquals(after.noStory, true);
  assertEquals(before.noStory, undefined, "the caller's record is untouched");
});

Deno.test("a cart whose author wrote a story in the editor keeps it", () => {
  const record: Record<string, unknown> = {
    meta: { source: "dezaemon2" },
    storyData: { stage0: { part: [{ text: "the war begins" }] } },
  };
  assertFalse(forceImportedNoStory(record), "nothing to change");
  assertEquals(record.noStory, undefined);
  assertEquals(
    (stage.withImportedNoStory(record) as Record<string, unknown>).noStory,
    undefined,
  );
});

Deno.test("a stock level is left alone, story or no story", () => {
  const withStory: Record<string, unknown> = {
    name: "2028-AI",
    storyData: { stage0: {} },
  };
  const without: Record<string, unknown> = { name: "My Level" };
  assertFalse(forceImportedNoStory(withStory));
  assertFalse(forceImportedNoStory(without));
  assertEquals(without.noStory, undefined, "story stays ON for a stock level");
  assertEquals(
    (stage.withImportedNoStory(without) as Record<string, unknown>).noStory,
    undefined,
  );
});

Deno.test("a flag already set is not rewritten, either way round", () => {
  const on: Record<string, unknown> = {
    meta: { source: "dezaemon2" },
    noStory: true,
  };
  assertFalse(forceImportedNoStory(on), "already says what it needs to");
  // An author who turned the story back ON in the editor saved `false`. That is
  // a decision, not a missing flag — but it is also a cart with no storyData, so
  // the flag goes back on: there is nothing else for the scene to show, and the
  // alternative is 2028.Ai's. With storyData present (the case above) it stands.
  const off: Record<string, unknown> = {
    meta: { source: "dezaemon2" },
    noStory: false,
  };
  assert(forceImportedNoStory(off));
  assertEquals(off.noStory, true);
});

Deno.test("a record that is not an object at all does not throw", () => {
  assertEquals(stage.withImportedNoStory(null), null);
  assertEquals(stage.withImportedNoStory(undefined), undefined);
  assertFalse(stage.isImportedRecord(null));
  assertFalse(stage.isImportedRecord("a string"));
});
