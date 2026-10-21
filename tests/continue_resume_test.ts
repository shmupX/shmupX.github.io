// CONTINUE? → YES resumes on the stage that killed you.
//
// 2019's own ContinueScene never touched stageId, and neither does the PS2
// port's (continueSelectYes) or the web runtime's road for an imported cart.
// The Phaser port reset it to 0 alongside the title's and the ending's resets
// (2019-es7 275fab6), and game.bundle.js kept that for every web game: a
// continue on gs's second stage sent the player back to its first. The bundle
// is vendored and patched by hand (README-Technical.md), so this reads it.

import { assert } from "@std/assert";

const bundle = (await Deno.readTextFile(
  new URL("../static/games/2028-ai/game.bundle.js", import.meta.url),
)).replaceAll("\r\n", "\n");

function continueGoNext(): string {
  const scene = bundle.indexOf(
    "var PhaserContinueScene = class extends Phaser.Scene {",
  );
  const start = bundle.indexOf("    goNext() {", scene);
  const end = bundle.indexOf("\n    playSound(key, volume) {", start);
  assert(scene > 0 && start > scene && end > start, "no ContinueScene.goNext");
  return bundle.slice(start, end);
}

Deno.test("a continue keeps the stage, and the song where the death paused it", () => {
  const goNext = continueGoNext();
  assert(
    goNext.includes(
      "gameState.continueCnt = Number(gameState.continueCnt || 0) + 1;",
    ),
    "the YES branch moved",
  );
  assert(
    !/gameState\.stageId\s*=/.test(goNext),
    "a continue sets the stage again",
  );
  assert(
    !goNext.includes("gameState.dezaBgmResume = null"),
    "a continue drops the song's place",
  );
  assert(goNext.includes('nextScene = "PhaserGameScene";'));
});

Deno.test("a new game still starts on stage 0", () => {
  // The title's START and the ending's GO TO TITLE are the resets that stay.
  const resets = bundle.match(/gameState\.stageId = 0;/g) ?? [];
  assert(resets.length >= 2, `only ${resets.length} stage resets left`);
});
