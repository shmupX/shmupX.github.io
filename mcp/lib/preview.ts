// Playing a created character, without publishing it anywhere.
//
// The runtime fetches one fixed URL before Phaser boots —
// /games/2028-ai/foo.json — and plays whatever record it gets. Serving that
// URL ourselves is therefore the whole preview: no editor, no localStorage or
// IndexedDB hand-off, no database. harbor's profiler already does exactly this
// (packages/shmup-harbor/tools/sav-profiler/lib/web.ts), so this module builds
// the record and hands it to that same server.
//
// The record starts from the shipped static/games/2028-ai/foo.json rather than
// from nothing. That file is a complete, known-playable level — art, enemy
// waves, story, title screens — so swapping one boss into it isolates the one
// thing being previewed. Its atlas is stacked the way the level loader stacks
// a level's sheet onto game_asset (_stackAtlas, level-loader.js:412): base
// sheet on top, incoming sheet below it, incoming frame rects pushed down by
// the base sheet's height.

import { join } from "@std/path";
import { decodeDataUrl, newRaster } from "@shmupx/shmup-harbor/png";
import { blit } from "@shmupx/shmup-harbor/raster";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
// Not a package export: serving one record at that URL is the profiler's own
// private helper, and widening @shmupx/shmup-harbor's published surface for it
// would put an internal in the JSR API. mcp/ is repo tooling like scripts/, so
// it reaches in by path instead.
import { startServer } from "../../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import { type FrameRect, sheetDataUrl } from "./art.ts";
import { encodeKey } from "./rtdb.ts";
import type { CreateResult } from "./character.ts";

export type LevelRecord = Record<string, unknown>;

/** The shipped level the preview is built on top of. */
export function baseLevelPath(): string {
  return join(repoRoot(), "static/games/2028-ai/foo.json");
}

export async function readBaseLevel(
  path = baseLevelPath(),
): Promise<LevelRecord> {
  return JSON.parse(await Deno.readTextFile(path)) as LevelRecord;
}

/**
 * Build the level record that plays `built` as the boss of one stage.
 *
 * `stage` picks which boss slot the character takes. A record's own
 * `bossData` REPLACES the base game's wholesale (mergeRecipe,
 * game.bundle.js:458-490), so the base level's other bosses are carried over
 * here rather than left to fall back to the shipped game — otherwise stages
 * that were not previewed would arrive empty.
 */
export async function buildPreviewLevel(
  built: CreateResult,
  { base, stage = 0 }: { base: LevelRecord; stage?: number },
): Promise<LevelRecord> {
  const record: LevelRecord = { ...base };

  const bossData = {
    ...(base.bossData && typeof base.bossData === "object"
      ? base.bossData
      : {}),
  } as Record<string, unknown>;
  bossData[`boss${stage}`] = built.character;
  record.bossData = bossData;
  record.stageKey = `stage${stage}`;
  record.name = built.name;

  // --- stack the character's sheet under the level's own ------------------
  const baseUrl = typeof base.atlasImageDataURL === "string"
    ? base.atlasImageDataURL
    : null;
  const baseFrames =
    (base.atlasFrames && typeof base.atlasFrames === "object"
      ? base.atlasFrames
      : {}) as Record<string, FrameRect>;

  const incoming = await decodeDataUrl(built.atlas.dataUrl);
  const baseSheet = baseUrl ? await decodeDataUrl(baseUrl) : null;
  const offsetY = baseSheet ? baseSheet.height : 0;

  const merged = newRaster(
    Math.max(baseSheet?.width ?? 0, incoming.width),
    offsetY + incoming.height,
  );
  if (baseSheet) blit(merged, baseSheet, 0, 0);
  blit(merged, incoming, 0, offsetY);

  const frames: Record<string, FrameRect> = { ...baseFrames };
  for (const [name, rect] of Object.entries(built.atlas.json.frames)) {
    // Keys are Firebase-encoded even in this file — it is a dump of a database
    // record, and the loader runs decodeFirebaseKey over every name it reads.
    frames[encodeKey(name)] = {
      ...rect,
      frame: { ...rect.frame, y: rect.frame.y + offsetY },
    };
  }

  record.atlasImageDataURL = await sheetDataUrl(merged);
  record.atlasFrames = frames;
  return record;
}

let running: { url: string; close: () => Promise<void> } | null = null;

/**
 * Serve a record at /games/2028-ai/foo.json and answer with the play URL.
 *
 * One server at a time: previewing a second character replaces the first
 * rather than leaving a port behind, since the whole point is that the URL
 * stays the same one the caller already has open.
 */
export async function servePreview(
  record: LevelRecord,
  { port = 8823, bossRush = true, stage = 0 }: {
    port?: number;
    bossRush?: boolean;
    stage?: number;
  } = {},
): Promise<{ url: string; playUrl: string }> {
  if (running) {
    await running.close();
    running = null;
  }
  running = startServer(record, { port });
  const params = new URLSearchParams();
  if (stage) params.set("stage", String(stage));
  // shortFlg empties the wave list, so the boss arrives immediately — the only
  // thing worth watching when the subject is one character.
  if (bossRush) params.set("bossRush", "1");
  const query = params.toString();
  return {
    url: running.url,
    playUrl: `${running.url}/games/2028-ai${query ? `?${query}` : ""}`,
  };
}

export async function stopPreview(): Promise<boolean> {
  if (!running) return false;
  await running.close();
  running = null;
  return true;
}
