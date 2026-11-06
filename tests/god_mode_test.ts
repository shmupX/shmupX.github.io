// God mode (?god=1 — the editor's GOD MODE toggle, what Dezaemon 2's TEST PLAY
// panel calls MUTEKI) wears the Saturn's TEST PLAY watermark and shows the one
// score a god run can move, TODAY'S GOD BEST (tests/game_scores_test.ts has the
// score itself). game.bundle.js is a vendored artifact patched by hand (README),
// so the scenes are pinned here from its source text.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

const bundle = await read(BUNDLE);

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

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

/** The bundle's text from one marker up to (not including) the next. */
function section(js: string, from: string, to: string): string {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start >= 0 && end > start, `no section ${from}`);
  return js.slice(start, end);
}

const GAME = "var PhaserGameScene = class extends Phaser.Scene {";
const TITLE = "var PhaserTitleScene = class extends Phaser.Scene {";
const CONTINUE = "var PhaserContinueScene = class extends Phaser.Scene {";
const ENDING = "var PhaserEndingScene = class extends Phaser.Scene {";

Deno.test("TESTING sits on the kernel's HUD grid: SCORE's row, BOMB's column", () => {
  const consts = new Function(
    section(bundle, "  var DEZA_SCREEN_W = 320;", "  var DEZA_TITLE_BAND_Y") +
      section(bundle, "  var DEZA_HUD_SCORE = {", "  var DEZA_HUD_INK") +
      "\nreturn { DEZA_HUD_SCORE, DEZA_HUD_BOMB, DEZA_HUD_TESTING, DEZA_SCREEN_W };",
  )() as {
    DEZA_HUD_SCORE: { x: number; y: number };
    DEZA_HUD_BOMB: { x: number };
    DEZA_HUD_TESTING: { x: number; y: number; text: string };
    DEZA_SCREEN_W: number;
  };
  const t = consts.DEZA_HUD_TESTING;
  assertEquals(t.text, "TESTING");
  assertEquals(t.y, consts.DEZA_HUD_SCORE.y);
  assertEquals(t.x, consts.DEZA_HUD_BOMB.x);
  // 48 px in from the right edge, as SCORE is from the left.
  assertEquals(
    consts.DEZA_SCREEN_W - (t.x + t.text.length * 8),
    consts.DEZA_HUD_SCORE.x,
  );
});

Deno.test("the stage wears the watermark in the kernel font only under god mode", () => {
  const hud = methodSource(bundle, "createHUD", GAME);
  const gate = hud.indexOf("if (gameState.godFlg) {");
  assert(gate > 0, "createHUD has no god-mode block");
  const god = hud.slice(gate);
  // The same glyph sheet SCORE and BOMB are typed from, at the Saturn's spot.
  assert(
    god.includes(
      'dezaHudLine(\n          this,\n          "dezaHudTesting",\n          dezaSatX(DEZA_HUD_TESTING.x),\n          DEZA_HUD_TESTING.y,\n          DEZA_HUD_TESTING.text.length\n        )',
    ),
    "TESTING is not a dezaHudLine at DEZA_HUD_TESTING",
  );
  assert(
    god.includes("this.dezaTestingLine.setText(DEZA_HUD_TESTING.text);"),
    "the line is never typed",
  );
  // With no glyph sheet the TrueType of the same face stands in.
  assert(
    god.includes(
      'dezaCellText(this, dezaSatX(DEZA_HUD_TESTING.x), DEZA_HUD_TESTING.y, "")',
    ),
    "no fallback face",
  );
  // Over the band and the HUD (depth 101).
  assert(god.includes("this.dezaTestingLine.setDepth(102);"));
  // Nothing of it before the gate: a mortal run has no watermark.
  assert(!hud.slice(0, gate).includes("dezaHudTesting"));
  assert(hud.slice(0, gate).includes("this.dezaTestingLine = null;"));
});

Deno.test("the HUD shows TODAY'S GOD BEST and feeds it the score every frame", () => {
  const hud = methodSource(bundle, "createHUD", GAME);
  const god = hud.slice(hud.indexOf("if (gameState.godFlg) {"));
  // One line, on the band's WORLD BEST row where there is a band, else under
  // the kernel's SCORE line.
  assert(
    god.includes(
      'this.godBestText = componentOn("hud")\n          ? this.add.text(30, 50, getGodBestText(),',
    ),
    "no god best line on the band",
  );
  assert(
    god.includes(
      ": this.add.text(dezaSatX(DEZA_HUD_SCORE.x), DEZA_HUD_SCORE.y + DEZA_CELL + 2, getGodBestText(),",
    ),
    "no god best line under the kernel's SCORE",
  );
  const update = methodSource(bundle, "updateHUD", GAME);
  assert(
    update.includes(
      "if (this.godBestText) {\n        keepGodBest(this.scoreCount);\n        this.godBestText.setText(getGodBestText());\n      }",
    ),
    "updateHUD does not keep the god best",
  );
  // keepGodBest is a no-op without the flag, so the HUD line is the gate.
  const keep = functionSource(bundle, "keepGodBest");
  assert(
    keep.includes(
      "if (!gameState.godFlg) {\n      return currentGodHighScore();\n    }",
    ),
  );
});

Deno.test("the title and the ending's card carry the line only under god mode", () => {
  for (
    const [scene, at] of [[TITLE, "create"], [ENDING, "create"]] as const
  ) {
    const src = methodSource(bundle, at, scene);
    const n = src.split(
      "this.godBestText = gameState.godFlg\n        ? this.add.text(",
    ).length - 1;
    assertEquals(n, 1, `${at}() of ${scene}`);
    assert(
      src.includes("getGodBestText(),"),
      `${at}() of ${scene} shows something else`,
    );
  }
  // The title refreshes it: the UTC day can turn while it idles.
  assert(
    methodSource(bundle, "update", TITLE).includes(
      "if (this.godBestText) {\n        this.godBestText.setText(getGodBestText());\n      }",
    ),
  );
  // The ending files the final score, as the HUD did a frame before. The
  // continue card is out of a god run's reach — nothing kills the ship
  // (playerDamage returns on the flag, the Goki KO resumes) — so it carries
  // nothing of god mode.
  assertEquals(
    bundle.split("keepGodBest(Number(gameState.score || 0));").length,
    2,
  );
  const ending = methodSource(bundle, "create", ENDING);
  assert(ending.includes("keepGodBest(Number(gameState.score || 0));"));
  assert(!section(bundle, CONTINUE, ENDING).includes("odBest"));
  // The ending's staff roll hides the card, the god line with it.
  assert(
    bundle.includes(
      "var hidden = [this.gotoTitleBtn, this.worldBestText, this.scoreSyncText, this.godBestText, this.congraTxt, this.tweetBtn, this.continueNewrecord, this.scoreContainer];",
    ),
  );
});

Deno.test("the label and the cookie are the god best's own", () => {
  assertEquals(
    new Function(
      functionSource(bundle, "getGodBestLabel") + "\nreturn getGodBestLabel();",
    )(),
    "TODAY'S GOD BEST",
  );
  assert(bundle.includes('var GOD_SCORE_COOKIE = "afc2019_godHighScore";'));
  // Loaded with the game's other scores, dropped with them.
  assert(
    functionSource(bundle, "initializeFirebaseScores").includes(
      "loadHighScore();\n      loadGodHighScore();",
    ),
  );
  const reset = functionSource(bundle, "resetFirebaseScores");
  assert(
    reset.includes("gameState.godHighScore = 0;") &&
      reset.includes("godScoreDay = null;"),
  );
  assert(
    functionSource(bundle, "ensureScoreState").includes(
      "state.godHighScore = normalizeScore(state.godHighScore);",
    ),
  );
});
