// The level's story, staged for the PS2's adventure scene.
//
// The port's own scene between stages fades "STAGE N / GET READY!" in and
// out; a level that tells a story (`storyData`) told it only in the browser.
// This stages what lib/ps2/runtime-story.ts needs to tell it on the console
// the way the web's story scene does: each stage's parts in order, each with
// the picture it is told over, and the speaker the plate names.
//
// The pictures go on a sheet of their own, assets/story.png — the first frame
// of each GIF, fitted inside the top half of the 256x480 game area at its own
// shape — so they cost the gameplay sheets nothing: AthenaEnv only uploads a
// texture while something draws it, and nothing does once the stage starts.
// A picture two parts share (gs's four parts are one GIF) is packed once.
// The words and the speaker ride in the sheet's own JSON (assets/story.json),
// which `AtlasManager.loadAtlas` reads and ignores the extra key of; a story
// with no pictures at all is the JSON alone, and the runtime then loads no
// image — a missing image file is a crash on the console.
//
// The console's face is Orbitron, which draws ASCII: typographic punctuation
// is folded to it (bitmap-font.ts foldToAscii) and anything else is dropped,
// rather than drawn as a box.

import { foldToAscii } from "../bitmap-font.ts";
import {
  containPicture,
  decodeStoryPicture,
  storySpeaker,
} from "../story-panels.ts";
import { buildPs2Atlas, type BuiltAtlas, type SourceFrame } from "./atlas.ts";

/** Where the story's script and its sheet go, relative to the boot directory. */
export const PS2_STORY_JSON = "assets/story.json";
export const PS2_STORY_PNG = "assets/story.png";

/** The box a picture is fitted inside: the top half of the game area. */
export const PS2_STORY_PICTURE = { w: 256, h: 240 } as const;

/** Stages a story may name, beyond which the editor writes none. */
const MAX_STORY_STAGES = 16;

export interface Ps2StoryPart {
  /** The part's words, as the console's face can draw them. */
  text: string;
  /** The sheet frame it is told over, or null for a black screen. */
  frame: string | null;
}

export interface Ps2Story {
  /** Who the plate names (story-panels.ts storySpeaker). */
  speaker: string;
  /** Each stage's parts by stage number ("0", "1", …), in order. */
  stages: Record<string, Ps2StoryPart[]>;
}

/** `text` as Orbitron can draw it: folded to ASCII, the rest dropped. */
export function ps2StoryText(text: string): string {
  return foldToAscii(text).replace(/[^\x20-\x7e\n]/g, "")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n").trim();
}

/**
 * The level's story as the PS2 tells it, with the sheet its pictures are
 * packed on (null when it has none) — or null when the level tells no story,
 * or says not to (`noStory`, which every boss rush and every import sets).
 */
export async function buildPs2Story(
  record: { storyData?: unknown; noStory?: unknown },
  onWarn: (message: string) => void = () => {},
): Promise<{ story: Ps2Story; atlas: BuiltAtlas | null } | null> {
  if (record.noStory === true) return null;
  const sd = record.storyData as
    | (Record<string, unknown> & { customImages?: Record<string, unknown> })
    | null
    | undefined;
  if (!sd || typeof sd !== "object") return null;
  const images = sd.customImages && typeof sd.customImages === "object"
    ? sd.customImages
    : {};

  const frameOf = new Map<string, string>(); // data URL -> frame name
  const sources: SourceFrame[] = [];
  const picture = async (stage: number, part: number) => {
    const key = `stage${stage}_part${part}`;
    const url = images[key];
    if (typeof url !== "string") return null;
    const known = frameOf.get(url);
    if (known) return known;
    try {
      const sheet = containPicture(
        await decodeStoryPicture(url),
        PS2_STORY_PICTURE.w,
        PS2_STORY_PICTURE.h,
      );
      const name = `story${sources.length}`;
      sources.push({
        name,
        sheet,
        entry: { frame: { x: 0, y: 0, w: sheet.width, h: sheet.height } },
      });
      frameOf.set(url, name);
      return name;
    } catch (e) {
      onWarn(`picture ${key}: ${(e as Error).message}`);
      return null;
    }
  };

  const stages: Record<string, Ps2StoryPart[]> = {};
  for (let stage = 0; stage < MAX_STORY_STAGES; stage++) {
    const st = sd[`stage${stage}`] as { part?: unknown } | undefined;
    if (!st || !Array.isArray(st.part)) continue;
    const parts: Ps2StoryPart[] = [];
    // A part with no picture of its own is told over the one before it, as
    // the web scene leaves its backdrop up until another replaces it.
    let frame: string | null = null;
    for (let m = 0; m < st.part.length; m++) {
      frame = (await picture(stage, m)) ?? frame;
      const raw = (st.part[m] as { text?: unknown } | null)?.text;
      const text = typeof raw === "string" ? ps2StoryText(raw) : "";
      if (text) parts.push({ text, frame });
    }
    if (parts.length) stages[String(stage)] = parts;
  }
  if (!Object.keys(stages).length) return null;
  const atlas = sources.length
    ? buildPs2Atlas(sources, "story.png", 512, 512 * 512)
    : null;
  return {
    story: { speaker: ps2StoryText(storySpeaker(sd)) || "G", stages },
    atlas,
  };
}
