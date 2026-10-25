// A cart or a 64DD disk exported from the editor opens its stages on the
// game's story, as one built by `deno task build:sav / build:sfc / build:kids
// / build:plus / build:ddd` does. The editor composes the backdrops in the
// page with the engine's storyBackdrops (tests/engine_bundle_test.ts pins the
// bundle to the CLI's composer) and hands them to the writer — every writer
// call, or the exports that skip it open on empty scenery with no error
// anywhere.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ATHENA_FONT_PATH } from "../packages/shmup-harbor/lib/bitmap-font.ts";
import { repoRoot } from "../packages/shmup-harbor/lib/repo-root.ts";

const editor = async () =>
  (await Deno.readTextFile(join(repoRoot(), "static/editor/index.html")))
    .replaceAll("\r\n", "\n");

Deno.test("every cart export in the editor draws the story", async () => {
  const html = await editor();
  const calls = [
    ...html.matchAll(
      /window\.Dezaemon\.(exportLevelToSav|exportLevelToKidsCard|exportLevelToPlusCard|exportLevelToSfcSram|exportLevelToDdd)\(record/g,
    ),
  ];
  // Saturn three times (EXPORT, SAVE MOD, PUBLISH TO ESHOP; the shelf
  // rebuild goes through EXPORT's), then Kids!, Dezaemon+, the SFC and the
  // 64DD (DOWNLOAD and → PLAY 64DD both build through one call).
  assertEquals(calls.map((m) => m[1]).sort(), [
    "exportLevelToDdd",
    "exportLevelToKidsCard",
    "exportLevelToPlusCard",
    "exportLevelToSav",
    "exportLevelToSav",
    "exportLevelToSav",
    "exportLevelToSfcSram",
  ]);
  for (const m of calls) {
    const at = m.index!;
    const before = html.slice(Math.max(0, at - 80), at);
    assert(
      /exportWithStory\(\(storyBackdrops\) =>\s*$/.test(before),
      `${m[1]} at ${at} is not built through exportWithStory`,
    );
    const statement = html.slice(at, html.indexOf(";", at));
    assert(
      /storyBackdrops\s*[,}]/.test(statement),
      `${m[1]} at ${at} does not pass the story to the writer`,
    );
  }
  // Kids! opens with less room under its score, and asks for it as
  // build:kids does (KIDS_STORY_ROWS 32-px rows).
  const kids = html.slice(
    html.indexOf("async function buildKidsCardForExport()"),
    html.indexOf("async function buildPlusCardForExport()"),
  );
  assert(
    kids.includes("height: window.Dezaemon.KIDS_STORY_ROWS * 32"),
    "the Kids! export composes the story at the Saturn's height",
  );
  // Each export's line says what the story did: Saturn, PlayStation, SFC
  // and 64DD.
  assertEquals(
    [...html.matchAll(/(?<!function )dezaStorySummary\(out\)/g)].length,
    4,
  );
  // The 64DD's writer lists its stages under the project, so the story's
  // line and summary have to look there too.
  const stages = html.slice(
    html.indexOf("function dezaStoryStages(out)"),
    html.indexOf("function dezaStorySummary(out)"),
  );
  assert(
    stages.includes("rep.project && rep.project.stages"),
    "dezaStoryStages reads the 64DD's report.project.stages",
  );
});

Deno.test("the editor sets the story's words in the face the CLI does", async () => {
  const html = await editor();
  const url = html.match(/const DEZA_STORY_FONT_URL = '([^']+)'/)?.[1];
  assertEquals(url, "/" + ATHENA_FONT_PATH.replace(/^static\//, ""));
  const info = await Deno.stat(join(repoRoot(), ATHENA_FONT_PATH));
  assert(info.isFile);
});
