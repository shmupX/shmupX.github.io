#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Put Daltonius, the gs cloud game's stage-2 boss, in the shared character
 * library, where spriteX, the Pixel Editor and the level editor's + LIBRARY
 * can see him.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/publish-daltonius.ts           # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/publish-daltonius.ts --apply
 *
 * Writes two nodes, as the character tools publish every character:
 *
 * - `atlases/Daltonius`: his art. His 15 poses, the three "I'm Fired!!!"
 *   balloon frames and the 13 cells of Liu Kang becoming the dragon
 *   (scripts/gs/art), spriteX's RAM stick (sprites/RAM_0) for his small shot,
 *   the gs game's hacked laptop (laptop0/laptop1, cut from levels/gs) for his
 *   big one, and the dragon's heads (deza_dragon's deza1_52_0/1.gif).
 * - `characters/Daltonius`: the record gs flies as boss1 (DALTONIUS in
 *   build-stage2.ts), with `textureKey: "Daltonius"`. It keeps Akuma's
 *   routine pin, the danger balloon and the dragon stage, so wherever he is
 *   placed he moves like Akuma, turns into the dragon at half his bar, and
 *   says he is fired.
 *
 * Nothing is written without --apply. It refuses to replace a Daltonius
 * already in the library unless --force, and refuses to publish a record
 * that names a frame its atlas lacks — the runtime would draw stock art in
 * its place with no error anywhere.
 */

import { decodeDataUrl } from "@shmupx/shmup-harbor/png";
import { cut } from "@shmupx/shmup-harbor/raster";
import {
  type FrameRect,
  packFrames,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "../../mcp/lib/art.ts";
import {
  type CreateResult,
  publishCharacter,
  referencedFrames,
} from "../../mcp/lib/character.ts";
import { decodeFrameName, get, getWithEtag } from "../../mcp/lib/rtdb.ts";
import { ART, DALTONIUS, daltoniusArt, DRAGON_HEADS } from "./build-stage2.ts";

export const NAME = "Daltonius";

/** Frames of a cloud level's own sheet, cut out by name. */
async function levelFrames(
  level: string,
  names: string[],
): Promise<ResolvedFrame[]> {
  const url = await get<string>(`levels/${level}/atlasImageDataURL`);
  const raw = await get<Record<string, FrameRect>>(
    `levels/${level}/atlasFrames`,
  );
  if (!url || !raw) throw new Error(`levels/${level} has no atlas`);
  const frames: Record<string, FrameRect> = {};
  for (const [k, v] of Object.entries(raw)) frames[decodeFrameName(k)] = v;
  const sheet = await decodeDataUrl(url);
  return names.map((name) => {
    const rect = frames[name];
    if (!rect) throw new Error(`levels/${level} has no frame ${name}`);
    return {
      name,
      raster: cut(sheet, rect.frame),
      source: `levels/${level}#${name}`,
      scope: level,
    };
  });
}

/** Build his library entry: the record and the atlas it names. Writes nothing. */
export async function buildDaltonius(): Promise<CreateResult> {
  const pulled: ResolvedFrame[] = [];
  for (const name of daltoniusArt()) {
    pulled.push(
      await resolveFrame({
        file: new URL(`${name}.png`, ART).pathname,
        as: name,
      }),
    );
  }
  pulled.push(await resolveFrame({ sprite: "RAM_0" }));
  pulled.push(...await levelFrames("gs", ["laptop0", "laptop1"]));
  for (const frame of DRAGON_HEADS.frames) {
    pulled.push(await resolveFrame({ atlas: DRAGON_HEADS.atlas, frame }));
  }

  const character = structuredClone({ ...DALTONIUS, textureKey: NAME });
  const { sheet, json } = packFrames(pulled);
  const unresolved = referencedFrames(character).filter((n) => !json.frames[n]);
  return {
    name: NAME,
    clonedFrom: null,
    character,
    atlas: {
      json,
      dataUrl: await sheetDataUrl(sheet),
      frameCount: Object.keys(json.frames).length,
      size: { w: sheet.width, h: sheet.height },
    },
    provenance: pulled.map((f) => ({ frame: f.name, source: f.source })),
    unresolved,
    warnings: [],
  };
}

/** Publish it. Refuses an incomplete record, and an existing entry unless `force`. */
export async function publishDaltonius(
  built: CreateResult,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (built.unresolved.length) {
    throw new Error(
      `${NAME} names frames his atlas lacks: ${built.unresolved.join(", ")}`,
    );
  }
  const atlas = await getWithEtag(`atlases/${NAME}`);
  const record = await get(`characters/${NAME}`);
  if (!force && (atlas.value != null || record != null)) {
    throw new Error(
      `the library already has ${NAME}; --force replaces him`,
    );
  }
  return await publishCharacter(built, { atlasIfMatch: atlas.etag });
}

if (import.meta.main) {
  const built = await buildDaltonius();
  console.log(JSON.stringify(
    {
      name: built.name,
      atlas: { frames: built.atlas.frameCount, size: built.atlas.size },
      provenance: built.provenance,
      unresolved: built.unresolved,
      record: built.character,
    },
    null,
    2,
  ));
  if (Deno.args.includes("--apply")) {
    const written = await publishDaltonius(built, {
      force: Deno.args.includes("--force"),
    });
    console.log(JSON.stringify({ written }, null, 2));
  }
}
