// The level's story, told on the console before each stage.
//
// The port's adventure scene (svelte-ps2 ps2-sp/scenes/adv.ts) fades "STAGE N
// / GET READY!" in and out and knows nothing of a level's story. When the
// build staged one (lib/ps2/story.ts, named by `__PS2_STORY__` in main.js's
// preamble), runtime-entry.ts registers this scene under the port's own
// SCENE_ADV name in its place, so every way into a stage — the title, a boss
// cleared — passes through it, and nothing in the port has to change.
//
// It tells the stage's parts the way the web's story scene does: the part's
// picture at the top, the speaker's plate and a black box of words below, the
// words typed one character a logic step (33 ms, the web's pace — this scene
// runs at the port's 30 Hz, not the game scene's faster clock). CROSS finishes
// a line, then moves to the next part; START skips the rest of the story. A
// stage the story says nothing about gets the port's own STAGE N card.
//
// Nothing here runs under Deno; it is bundled into main.js with the port.

import {
  type GameContext,
  GCX,
  GCY,
  SCENE_ADV,
  SCENE_GAME,
  SCREEN_H,
  SCREEN_W,
} from "@easierbycode/svelte-ps2/ps2-sp";
import type { SceneHandlers } from "@easierbycode/svelte-ps2/toolkit";

/** What lib/ps2/story.ts writes into assets/story.json beside the sheet. */
export interface StoryScript {
  speaker: string;
  stages: Record<string, { text: string; frame: string | null }[]>;
}

/** A picture's size in game pixels, read off the sheet's own JSON. */
export type StoryFrames = Record<string, { w: number; h: number }>;

/** The atlas name the pictures are loaded under. */
export const STORY_ATLAS = "story";

// The web scene's layout, in the 256x480 game area.
const PICTURE_H = 235;
const PLATE = { x: 16, y: 235, minW: 80, h: 24 };
const BOX = { x: 8, y: 247, w: 240, h: 180 };
const PAD = 12;
const EDGE = 2;

/**
 * Read the staged story and put its scene in place of the port's adventure
 * scene. Answers whether it did: a script that will not load leaves the
 * port's own scene where it was.
 */
export function installStory(ctx: GameContext, jsonPath: string): boolean {
  const text = ctx.rt.std.loadFile(jsonPath);
  if (!text) return false;
  let data: {
    story?: StoryScript;
    frames?: Record<string, { frame: { w: number; h: number } }>;
    meta?: { image?: string; ps2DisplayScale?: number };
  };
  try {
    data = JSON.parse(text);
  } catch {
    return false;
  }
  if (!data.story || !data.story.stages) return false;
  const frames: StoryFrames = {};
  if (data.meta?.image && data.frames) {
    const dir = jsonPath.slice(0, jsonPath.lastIndexOf("/") + 1);
    if (ctx.atlas.loadAtlas(STORY_ATLAS, dir + data.meta.image, jsonPath)) {
      const ds = data.meta.ps2DisplayScale || 1;
      for (const [name, f] of Object.entries(data.frames)) {
        frames[name] = { w: f.frame.w * ds, h: f.frame.h * ds };
      }
    }
  }
  ctx.scenes.register(SCENE_ADV, createStoryScene(ctx, data.story, frames));
  return true;
}

export function createStoryScene(
  ctx: GameContext,
  script: StoryScript,
  frames: StoryFrames,
): SceneHandlers {
  const g = globalThis as {
    __PS2_FONT__?: string;
    __PS2_FONT_SCALE__?: number;
  };
  // A face of its own to measure with, at the scale the port prints at
  // (createGameFont): `ctx.font` can print but not measure. Made on first
  // use, so a disc whose story never plays never loads it.
  type Measure = {
    scale: number;
    getTextSize(t: string): { width: number; height: number };
  };
  let measure: Measure | null = null;
  const face = (): Measure => {
    if (!measure) {
      try {
        const f = new ctx.rt.Font(g.__PS2_FONT__ || "default");
        f.scale = ctx.vp.scale * (g.__PS2_FONT_SCALE__ || 1);
        measure = f;
      } catch {
        measure = {
          scale: 1,
          getTextSize: (t) => ({ width: t.length * 9, height: 14 }),
        };
      }
    }
    return measure;
  };
  // +1: the build prints bold, one pixel to the right of itself.
  const textWidth = (t: string): number => face().getTextSize(t).width + 1;
  let lineH = 0;
  const lineHeight = () =>
    lineH ||
    (lineH = Math.max(12, Math.ceil(face().getTextSize("Ag").height) + 4));

  /** `text` broken into lines no wider than `maxW` screen pixels. */
  const wrap = (text: string, maxW: number): string[] => {
    const out: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ").filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && textWidth(next) > maxW) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  };

  const s = {
    parts: [] as { text: string; frame: string | null }[],
    part: 0,
    lines: [] as string[],
    total: 0,
    shown: 0,
    timer: 0,
    done: false,
  };

  const startPart = () => {
    const p = s.parts[s.part];
    s.lines = wrap(p.text, ctx.vp.toW(BOX.w - 2 * PAD));
    s.total = s.lines.reduce((n, l) => n + l.length, 0);
    s.shown = 0;
  };
  // Once: the scene keeps updating through the fade the switch starts.
  const finish = () => {
    s.done = true;
    ctx.sound.stopBgm();
    ctx.scenes.switch(SCENE_GAME);
  };

  function init(): void {
    s.parts = script.stages[String(ctx.state.stageId)] ?? [];
    s.part = 0;
    s.timer = 0;
    s.done = false;
    if (s.parts.length) startPart();
    ctx.sound.playBgm("adventure_bgm");
    ctx.sound.playSound("g_adbenture_voice0");
  }

  function update(): void {
    if (s.done) return;
    s.timer++;
    if (!s.parts.length) {
      // The port's own card, as adv.ts plays it.
      if (s.timer >= 240 || (ctx.input.isConfirmPressed() && s.timer > 30)) {
        finish();
      }
      return;
    }
    if (ctx.input.isStartPressed()) {
      finish();
      return;
    }
    if (s.shown < s.total) s.shown++;
    if (ctx.input.isConfirmPressed() && s.timer > 10) {
      if (s.shown < s.total) s.shown = s.total;
      else if (s.part + 1 < s.parts.length) {
        s.part++;
        startPart();
        ctx.sound.playSound("se_cursor");
      } else finish();
    }
  }

  function draw(): void {
    const { rt, vp, font } = ctx;
    rt.Draw.rect(0, 0, SCREEN_W, SCREEN_H, rt.Color.new(0, 0, 0));
    const white = rt.Color.new(255, 255, 255);
    const stageLabel = "STAGE " + String(ctx.state.stageId + 1);
    if (!s.parts.length) {
      const t = s.timer < 60
        ? s.timer / 60
        : s.timer < 180
        ? 1
        : Math.max(0, 1 - (s.timer - 180) / 60);
      const faded = rt.Color.new(255, 255, 255, Math.floor(t * 128));
      font.print(vp.toX(GCX - 60), vp.toY(GCY - 20), stageLabel, faded);
      font.print(vp.toX(GCX - 50), vp.toY(GCY + 10), "GET READY!", faded);
      return;
    }

    const part = s.parts[s.part];
    const pic = part.frame ? frames[part.frame] : undefined;
    if (part.frame && pic) {
      ctx.atlas.drawFrameTL(
        STORY_ATLAS,
        part.frame,
        vp.toX((256 - pic.w) / 2),
        vp.toY(Math.max(0, (PICTURE_H - pic.h) / 2)),
        vp.scale,
        vp.scale,
      );
    }

    const framed = (x: number, y: number, w: number, h: number) => {
      rt.Draw.rect(vp.toX(x), vp.toY(y), vp.toW(w), vp.toH(h), white);
      rt.Draw.rect(
        vp.toX(x + EDGE),
        vp.toY(y + EDGE),
        vp.toW(w - 2 * EDGE),
        vp.toH(h - 2 * EDGE),
        rt.Color.new(0, 0, 0),
      );
    };
    framed(BOX.x, BOX.y, BOX.w, BOX.h);
    const nameW = Math.max(
      PLATE.minW,
      Math.ceil(textWidth(script.speaker) / vp.scale) + 24,
    );
    framed(PLATE.x, PLATE.y, nameW, PLATE.h);
    font.print(
      vp.toX(PLATE.x + 12),
      vp.toY(PLATE.y + 5),
      script.speaker,
      white,
    );
    const lh = lineHeight();
    // The stage, which the port's card used to say, at the box's foot
    // across from the prompt.
    font.print(
      vp.toX(BOX.x + PAD),
      vp.toY(BOX.y + BOX.h - PAD) - lh,
      stageLabel,
      white,
    );

    let left = s.shown;
    for (let i = 0; i < s.lines.length && left > 0; i++) {
      const line = s.lines[i].slice(0, left);
      left -= s.lines[i].length;
      font.print(
        vp.toX(BOX.x + PAD),
        vp.toY(BOX.y + PAD) + i * lh,
        line,
        white,
      );
    }
    if (s.shown >= s.total) {
      const prompt = s.part + 1 < s.parts.length ? "NEXT >" : "GO! >";
      font.print(
        vp.toX(BOX.x + BOX.w - PAD) - textWidth(prompt),
        vp.toY(BOX.y + BOX.h - PAD) - lh,
        prompt,
        white,
      );
    }
  }

  return { init, update, draw };
}
