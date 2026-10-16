// The editor's PLAY rows never put a stage on the game's URL.
//
// `?stage=N` on the game's URL is the launcher Guide's Start Stage cheat:
// a boot that carries it skips the title, and the runtime lays it back over
// every run started from the title (cmgApplyCheatStart, pinned by
// cheat_boot_test.ts). Both editor PLAY rows used to add the open stage
// there, so the cloud game "rando", saved with its second stage open, opened
// in its second stage from PLAY GAME and STARTed from its title straight
// back into it. PLAY IN PHASER still opens the stage being edited — its
// stage travels in localStorage, which the level loader reads — and PLAY
// GAME plays the saved game from its title.

import { assert } from "@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One function of the editor's script, by name, as source text. */
function editorFunction(html: string, name: string): string {
  const m = new RegExp(`\\n( *)(async )?function ${name}\\(`).exec(html);
  assert(m, `no ${name} in the editor`);
  const start = m.index + 1;
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} does not close`);
}

/** The game URLs a function builds: its template literals on GAME_PLAY_URL. */
function playUrls(src: string): string[] {
  return [...src.matchAll(/`\$\{GAME_PLAY_URL\}[^`]*`/g)].map((m) => m[0]);
}

Deno.test("PLAY IN PHASER hands its stage over in localStorage, not as ?stage=", async () => {
  const src = editorFunction(
    await read("static/editor/index.html"),
    "playCurrentStage",
  );
  const urls = playUrls(src);
  assert(urls.length === 1, urls.join("\n"));
  assert(urls[0].includes("?editorPlay=1"), urls[0]);
  assert(
    !/[?&]stage=/.test(urls[0]),
    "the open stage is on the URL: " + urls[0],
  );
  // ...and the loader still finds it.
  assert(
    src.includes(
      "localStorage.setItem(LEVEL_LOADER_DEFAULTS.editorStageKey, String(sid));",
    ),
  );
  const loader = await read("static/phaser-plugins/level-loader.js");
  assert(
    loader.includes('readParam("stage") || localStorage.getItem(stageKey)'),
  );
});

Deno.test("PLAY GAME opens the saved game at its title, not the open stage", async () => {
  const src = editorFunction(
    await read("static/editor/index.html"),
    "playFirebaseLevel",
  );
  const urls = playUrls(src);
  assert(urls.length === 1, urls.join("\n"));
  assert(urls[0].includes("?level=${encodeURIComponent(name)}"), urls[0]);
  assert(
    !/[?&]stage=/.test(urls[0]),
    "the open stage is on the URL: " + urls[0],
  );
});
