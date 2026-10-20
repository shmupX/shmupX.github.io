// The level's story on the PS2: lib/ps2/story.ts stages it, and
// lib/ps2/runtime-story.ts tells it in place of the port's STAGE N card. The
// scene is driven here against a stand-in context — the port's own pieces are
// not loaded — so what it does with the pad and the scenes is checked without
// a console or a browser.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildPs2Story,
  PS2_STORY_PICTURE,
  ps2StoryText,
} from "../lib/ps2/story.ts";
import {
  createStoryScene,
  type StoryScript,
} from "../lib/ps2/runtime-story.ts";
import { repoRoot } from "../lib/repo-root.ts";

const FOO = join(repoRoot(), "static/games/2028-ai/foo.json");

Deno.test("ps2StoryText keeps what Orbitron can draw", () => {
  assertEquals(ps2StoryText("humanity’s  last…"), "humanity's last...");
  assertEquals(ps2StoryText("Mε†a Ϫ†, \nwas"), "Ma ,\nwas");
});

Deno.test("buildPs2Story stages nothing for a level that tells no story", async () => {
  assertStrictEquals(await buildPs2Story({}), null);
  assertStrictEquals(await buildPs2Story({ storyData: {} }), null);
  assertStrictEquals(
    await buildPs2Story({
      noStory: true,
      storyData: { stage0: { part: [{ text: "hidden" }] } },
    }),
    null,
    "noStory — every import and every boss rush — keeps the port's card",
  );
});

Deno.test("buildPs2Story keeps each stage's parts, a picture told until the next", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const sd = level.storyData;
  const pic = sd.customImages.stage0_part0;
  const built = await buildPs2Story({
    storyData: {
      speaker: "GS",
      customImages: { stage0_part0: pic, stage1_part1: pic },
      stage0: { part: [{ text: "one" }, { text: "" }, { text: "two" }] },
      stage1: { part: [{ text: "dark" }, { text: "lit" }] },
    },
  });
  assert(built);
  assertEquals(built.story.speaker, "GS");
  assertEquals(built.story.stages, {
    "0": [{ text: "one", frame: "story0" }, { text: "two", frame: "story0" }],
    // stage1's first part has no picture of its own and nothing before it;
    // its second is told over the same GIF, packed once.
    "1": [{ text: "dark", frame: null }, { text: "lit", frame: "story0" }],
  });
  assert(built.atlas);
  assertEquals(Object.keys(built.atlas.json.frames), ["story0"]);
  const f = built.atlas.json.frames.story0.frame;
  const ds = built.atlas.json.meta.ps2DisplayScale;
  assert(
    f.w * ds <= PS2_STORY_PICTURE.w + 2 && f.h * ds <= PS2_STORY_PICTURE.h + 2,
  );
});

Deno.test("buildPs2Story packs foo's pictures on one sheet at most 512 square", async () => {
  const level = JSON.parse(await Deno.readTextFile(FOO));
  const built = await buildPs2Story(level);
  assert(built && built.atlas);
  assertEquals(built.story.speaker, "G");
  assertEquals(Object.keys(built.story.stages), ["0", "1", "2", "3", "4"]);
  // Stages 0-3 each have a picture their two parts share; stage 4 has none.
  assertEquals(Object.keys(built.atlas.json.frames).length, 4);
  assertEquals(built.story.stages["4"].map((p) => p.frame), [null, null]);
  const { w, h } = built.atlas.json.meta.size;
  assert(w <= 512 && h <= 512, `${w}x${h}`);
});

// --- the scene ---

function stubContext(stageId: number) {
  const printed: string[] = [];
  const switched: string[] = [];
  const sounds: string[] = [];
  const pad = { start: false, confirm: false };
  const ctx = {
    rt: {
      Draw: { rect: () => {} },
      Color: { new: () => ({}) },
      Font: class {
        scale = 1;
        getTextSize(t: string) {
          return { width: t.length * 8, height: 12 };
        }
      },
      std: { loadFile: () => null },
    },
    vp: {
      scale: 1,
      toX: (x: number) => x,
      toY: (y: number) => y,
      toW: (w: number) => w,
      toH: (h: number) => h,
    },
    atlas: { drawFrameTL: () => {}, loadAtlas: () => true },
    state: { stageId },
    input: {
      isStartPressed: () => pad.start,
      isConfirmPressed: () => pad.confirm || pad.start,
    },
    sound: {
      playBgm: (k: string) => sounds.push(k),
      playSound: (k: string) => sounds.push(k),
      stopBgm: () => sounds.push("stop"),
    },
    scenes: { switch: (name: string) => switched.push(name) },
    font: { print: (_x: number, _y: number, t: string) => printed.push(t) },
  };
  return { ctx, printed, switched, sounds, pad };
}

const SCRIPT: StoryScript = {
  speaker: "GS",
  stages: {
    "0": [{ text: "one two", frame: null }, { text: "three", frame: null }],
  },
};

Deno.test("the story scene types each part, CROSS moves on, then the stage starts", () => {
  const { ctx, printed, switched, sounds, pad } = stubContext(0);
  // deno-lint-ignore no-explicit-any
  const scene = createStoryScene(ctx as any, SCRIPT, {});
  scene.init!();
  assertEquals(sounds.slice(0, 2), ["adventure_bgm", "g_adbenture_voice0"]);
  for (let i = 0; i < 3; i++) scene.update!();
  printed.length = 0;
  scene.draw!();
  assert(printed.includes("one"), "three characters in");
  assert(printed.includes("GS") && printed.includes("STAGE 1"));
  assert(!printed.some((t) => t.startsWith("NEXT")), "no prompt mid-line");
  for (let i = 0; i < 20; i++) scene.update!();
  // A press finishes nothing left to type, so it moves to the next part.
  pad.confirm = true;
  scene.update!();
  pad.confirm = false;
  printed.length = 0;
  scene.draw!();
  assertEquals(printed.filter((t) => /^thr/.test(t)).length, 0, "typing anew");
  // A press mid-line finishes it; the next one, on the last part, starts the stage.
  scene.update!();
  pad.confirm = true;
  scene.update!();
  printed.length = 0;
  scene.draw!();
  assert(printed.includes("three") && printed.includes("GO! >"));
  scene.update!();
  pad.confirm = false;
  assertEquals(switched, ["game"]);
  assert(sounds.includes("stop"), "the story's music stops with it");
});

Deno.test("START skips the rest of the story", () => {
  const { ctx, switched, pad } = stubContext(0);
  // deno-lint-ignore no-explicit-any
  const scene = createStoryScene(ctx as any, SCRIPT, {});
  scene.init!();
  scene.update!();
  pad.start = true;
  scene.update!();
  assertEquals(switched, ["game"]);
});

Deno.test("a stage the story says nothing of gets the port's STAGE N card", () => {
  const { ctx, printed, switched } = stubContext(3);
  // deno-lint-ignore no-explicit-any
  const scene = createStoryScene(ctx as any, SCRIPT, {});
  scene.init!();
  scene.update!();
  scene.draw!();
  assertEquals(printed, ["STAGE 4", "GET READY!"]);
  for (let i = 0; i < 240; i++) scene.update!();
  assertEquals(switched, ["game"]);
});
