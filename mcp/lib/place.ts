// Putting a character into a cloud level's boss slot.
//
// Two halves have to move together. The record is the easy one:
// `levels/<name>/bossData/boss<N>` is exactly the shape a character already
// is. (shmupX's copy of the level, shmupX/levels/<name> — rtdb.ts roots the
// path, and a level named by alias, "2019", is placed into the level the
// alias names. cmg's root-level copy of a game is never edited.) The art is
// the half that bites — every sprite spawn resolves frames against the
// level's own atlas, and `bulletFramesInAtlas` silently drops names the atlas
// lacks and falls back to stock art, so a record placed without its pixels
// renders wrong with no error anywhere.
//
// Only the frames the level is actually missing are added. A level's art is
// its author's: akuma carries its own `dezaBoss0_*.png`, and overwriting
// those with the catalog's copies of the same names would quietly restyle a
// boss nobody asked us to touch. The runtime's own `.gif`/`.png` sibling
// lookup (resolveFrame) then lets a record naming `foo.gif` find the level's
// `foo.png`, so skipping them costs nothing.

import { decodeDataUrl, newRaster } from "@shmupx/shmup-harbor/png";
import { blit } from "@shmupx/shmup-harbor/raster";
import {
  ArtError,
  type FrameRect,
  loadAtlas,
  packFrames,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "./art.ts";
import {
  assertSafeKey,
  dbPath,
  decodeFrameName,
  encodeKey,
  get,
  put,
} from "./rtdb.ts";
import { resolveLevelKey } from "./levels.ts";
import {
  type Character,
  getCharacter,
  referencedFrames,
  remapFrames,
} from "./character.ts";

export interface PlaceResult {
  /** The level's own key: what `level` named, or what its alias stands for. */
  level: string;
  /** The alias the level was asked for by, or null when it was its key. */
  alias: string | null;
  slot: string;
  character: string;
  /** The record that was there before — keep it to put things back. */
  replaced: Character | null;
  /** Frames added to the level's atlas. */
  added: { frame: string; source: string }[];
  /** Frames the level already had, left as they were — and renamed in the
   * record where the level spells them differently. */
  reused: string[];
  /** Frame names rewritten to the level's own spelling. */
  renamed: Record<string, string>;
  /** Names nothing could supply; a non-empty list blocks a write. */
  unresolved: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  written: string[];
}

/** Does this frame map carry `name`, under either extension the runtime aliases? */
function hasFrame(
  frames: Record<string, FrameRect>,
  name: string,
): string | null {
  if (frames[name]) return name;
  const alt = name.endsWith(".gif")
    ? `${name.slice(0, -4)}.png`
    : name.endsWith(".png")
    ? `${name.slice(0, -4)}.gif`
    : null;
  return alt && frames[alt] ? alt : null;
}

/**
 * Place `character` into `level`'s boss slot `stage`.
 *
 * Nothing is written unless `apply` — the levels tree is shared, and this
 * replaces work somebody else authored.
 */
export async function placeCharacter(
  { level, character, stage = 0, apply = false }: {
    level: string;
    character: string;
    stage?: number;
    apply?: boolean;
  },
): Promise<PlaceResult> {
  assertSafeKey("Level name", level);
  const slot = `boss${stage}`;
  // The exact key first, then the alias index, as ?level= resolves a name.
  // An unknown name falls through as given and fails below on its atlas.
  const found = await resolveLevelKey(level);
  const alias = found?.alias ?? null;
  if (found) {
    assertSafeKey("Level name", found.key);
    level = found.key;
  }

  const record = await getCharacter(character);
  const existing = await get<Character>(`levels/${level}/bossData/${slot}`);
  const rawFrames = await get<Record<string, FrameRect>>(
    `levels/${level}/atlasFrames`,
  );
  const sheetUrl = await get<string>(`levels/${level}/atlasImageDataURL`);
  if (!rawFrames || !sheetUrl) {
    throw new ArtError(
      `${
        dbPath(`levels/${level}`)
      } has no atlas (atlasFrames / atlasImageDataURL). ` +
        `Placing a character into it would render stock art for every frame.`,
    );
  }

  // The level's map, keyed the way an author writes names.
  const levelFrames: Record<string, FrameRect> = {};
  for (const [k, v] of Object.entries(rawFrames)) {
    levelFrames[decodeFrameName(k)] = v;
  }

  const sourceAtlas = typeof record.textureKey === "string"
    ? record.textureKey
    : character;
  const wanted = referencedFrames(record);
  const reused: string[] = [];
  const unresolved: string[] = [];
  const pull: ResolvedFrame[] = [];

  const atlas = await loadAtlas(sourceAtlas).catch(() => null);
  const rename: Record<string, string> = {};
  for (const name of wanted) {
    const already = hasFrame(levelFrames, name);
    if (already) {
      reused.push(already === name ? name : `${name} → ${already}`);
      if (already !== name) rename[name] = already;
      continue;
    }
    if (!atlas || !atlas.frames[name]) {
      unresolved.push(name);
      continue;
    }
    pull.push(await resolveFrame({ atlas: sourceAtlas, frame: name }));
  }
  // The record has to name the art the way THIS level's atlas spells it.
  const placed = remapFrames(record, rename);

  const before = await decodeDataUrl(sheetUrl);
  let after = { w: before.width, h: before.height };
  let mergedUrl: string | null = null;
  const mergedFrames: Record<string, FrameRect> = { ...rawFrames };

  if (pull.length) {
    // Stack the new art UNDER the level's sheet and push the incoming rects
    // down by its height — the same arrangement the level loader uses when it
    // stacks a level's sheet onto game_asset.
    const { sheet, json } = packFrames(pull);
    const merged = newRaster(
      Math.max(before.width, sheet.width),
      before.height + sheet.height,
    );
    blit(merged, before, 0, 0);
    blit(merged, sheet, 0, before.height);
    for (const [name, rect] of Object.entries(json.frames)) {
      mergedFrames[encodeKey(name)] = {
        ...rect,
        frame: { ...rect.frame, y: rect.frame.y + before.height },
      };
    }
    mergedUrl = await sheetDataUrl(merged);
    after = { w: merged.width, h: merged.height };
  }

  const written: string[] = [];
  if (apply) {
    if (unresolved.length) {
      throw new ArtError(
        `Refusing to place "${character}" into ${
          dbPath(`levels/${level}`)
        }: ${unresolved.length} ` +
          `frame(s) have no pixels — ${
            unresolved.join(", ")
          }. The runtime would ` +
          `fall back to stock art with no error anywhere.`,
      );
    }
    // Art first. A record that arrives before its frames renders stock art to
    // anyone who loads the level in between; frames with no record yet are
    // simply unused.
    if (mergedUrl) {
      await put(`levels/${level}/atlasImageDataURL`, mergedUrl);
      await put(`levels/${level}/atlasFrames`, mergedFrames);
      written.push(
        dbPath(`levels/${level}/atlasImageDataURL`),
        dbPath(`levels/${level}/atlasFrames`),
      );
    }
    await put(`levels/${level}/bossData/${slot}`, placed);
    written.push(dbPath(`levels/${level}/bossData/${slot}`));
  }

  return {
    level,
    alias,
    slot,
    character,
    renamed: rename,
    replaced: existing ?? null,
    added: pull.map((f) => ({ frame: f.name, source: f.source })),
    reused,
    unresolved,
    atlas: { before: { w: before.width, h: before.height }, after },
    written,
  };
}
