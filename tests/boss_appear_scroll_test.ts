// The boss-arrival slide starts over with the scene.
//
// bossAdd slides the stage's loop backdrop (and the corridor overlay) down
// 214 px to bring stage_end in from the top, on a flag and a count the
// fixed-update loop reads (bossAppearBgFlg, bossAppearBgScroll). Phaser's
// Scene instance outlives a scene.stop/start — only create() runs again — so a
// run that ended inside the boss's first seconds, then GAME OVER, GO TO TITLE,
// START, carried the flag and its count into the next game: the fresh
// backdrop, built at y 0, slid down for whatever the count had left, and
// stage 1 opened with a black band across its top where no backdrop was.
// Reproduced in a headless Chromium on the cloud game rando: the second
// run's backdrop sat at y 144 with the flag still up. create() now drops
// both, beside the other per-run boss state it already resets.

import { assert } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One method of a class in the bundle, by name, as source text. */
function methodSource(js: string, name: string, after: string): string {
  const from = js.indexOf(after);
  assert(from >= 0, `no ${after} in ${BUNDLE}`);
  const start = js.indexOf(`\n    ${name}(`, from);
  assert(start >= 0, `no ${name}() after ${after}`);
  const end = js.indexOf("\n    }\n", start);
  assert(end > start, `${name}() does not close`);
  return js.slice(start, end + 6);
}

Deno.test("create() drops the boss-arrival slide before it builds the backdrop", async () => {
  const js = await read(BUNDLE);
  const create = methodSource(js, "create", "var PhaserGameScene = class");
  const flag = create.indexOf("this.bossAppearBgFlg = false;");
  const count = create.indexOf("this.bossAppearBgScroll = 0;");
  const backdrop = create.indexOf("this.stageBg = this.add.tileSprite(");
  assert(flag >= 0, "create() leaves bossAppearBgFlg as the last run left it");
  assert(
    count >= 0,
    "create() leaves bossAppearBgScroll as the last run left it",
  );
  assert(
    backdrop > flag && backdrop > count,
    "the slide is dropped after the backdrop is built",
  );
  // Beside the rest of the per-run boss state, not somewhere a stage could
  // skip.
  assert(create.indexOf("this.bossReached = false;") < flag);
});

Deno.test("bossAdd still arms the slide, and the loop still ends it", async () => {
  const js = await read(BUNDLE);
  assert(
    js.includes(
      "      scene.bossAppearBgFlg = true;\n      scene.bossAppearBgScroll = 0;\n",
    ),
    "bossAdd no longer starts the slide",
  );
  assert(
    js.includes(
      "if (this.bossAppearBgScroll >= 214 || this.stageEndBg.y >= 42) {\n            this.bossAppearBgFlg = false;",
    ),
    "the slide no longer ends at 214 px",
  );
});
