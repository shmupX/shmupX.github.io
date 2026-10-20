// The name on the plate above the story box.
//
// AdvScene always printed "G" there: 2028.Ai's story is G's. A game whose
// story someone else tells names them in `storyData.speaker` (gs's is GS),
// and AdvScene sets that name on the plate's middle, widening the plate for a
// name that would not fit. With none, G keeps his letter where it always sat.
// The editor's story pills and AdvScene's stage lookup only read stage<N>
// keys, so the extra key rides along with the story untouched.

import { assert, assertEquals } from "@std/assert";

const bundle = (await Deno.readTextFile(
  new URL("../static/games/2028-ai/game.bundle.js", import.meta.url),
)).replaceAll("\r\n", "\n");

function slice(from: string, to: string) {
  const start = bundle.indexOf(from);
  const end = bundle.indexOf(to, start);
  assert(start > 0 && end > start, `no ${from}`);
  return bundle.slice(start, end);
}

const storySpeaker = new Function(
  slice(
    "function storySpeaker(storyData) {",
    "function decideEnding(recipe) {",
  ) +
    "return storySpeaker;",
)() as (story: unknown) => string;

Deno.test("the story's own speaker names the plate, else G", () => {
  assertEquals(storySpeaker({ speaker: "GS", stage0: { part: [] } }), "GS");
  assertEquals(storySpeaker({ speaker: "  GS " }), "GS");
  assertEquals(storySpeaker({ speaker: "" }), "G");
  assertEquals(storySpeaker({ speaker: 3 }), "G");
  assertEquals(storySpeaker({ stage0: { part: [] } }), "G");
  assertEquals(storySpeaker(null), "G");
});

Deno.test("AdvScene puts the speaker on the plate", () => {
  const create = slice(
    "var PhaserAdvScene = class extends Phaser.Scene {",
    "playSound(key, volume) {",
  );
  assert(
    create.includes("var speaker = storySpeaker(this.scenario);"),
    "AdvScene does not read the story's speaker",
  );
  assert(
    create.includes(
      "this.nameTxt = addPixiPositionedText(this, 50, GAME_DIMENSIONS.CENTER_Y - 4, speaker, {",
    ),
    "the plate still prints a fixed name",
  );
  assert(
    !create.includes('GAME_DIMENSIONS.CENTER_Y - 4, "G", {'),
    "a hard-coded G is back on the plate",
  );
  // The plate is drawn after the name is measured, at the width it needs.
  assert(
    create.includes(
      "nameBg.fillRoundedRect(16, GAME_DIMENSIONS.CENTER_Y - 5, nameW, 24, 6);",
    ),
    "the plate does not take the name's width",
  );
});
