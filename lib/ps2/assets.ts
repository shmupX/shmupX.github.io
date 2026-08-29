// Turn one level record into the file set the PS2 build boots with.
//
// The editor stores a level as its wave grid plus a custom sprite atlas
// stacked on top of the base game's, exactly as the browser player composites
// them (see the level-loader plugin). Here the same merge happens ahead of
// time and the result is repacked into console-sized sheets:
//
//   assets/game_asset.png|json   the base sprite atlas, repacked
//   assets/game_ui.png|json      the base HUD atlas, repacked
//   assets/cyber_liberty.png     the player, as the 32x32 grid sheet ps2-sp wants
//   assets/game.json             the base recipe (player/enemy/boss stats)
//   assets/level.json            this level's waves and custom entity stats
//   assets/level_atlas.png|json  every frame that level.json names
//
// ps2-sp tags each of the level's own enemies with the `level_atlas` texture,
// so the level atlas has to be self-sufficient: a frame the level references
// but never customised is pulled from the base sheet rather than left dangling.

import { join } from "@std/path";
import {
  decodeDataUrl,
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "./png.ts";
import { buildPs2Atlas, type FrameEntry, type SourceFrame } from "./atlas.ts";
import { blit, cut, fitInto } from "./raster.ts";

/** A Firebase `levels/{name}` record, as the editor saves it. */
export interface LevelRecord {
  name?: string;
  enemylist?: string[][];
  stageKey?: string;
  width?: number;
  waveRows?: number[];
  waveInterval?: number;
  enemyData?: Record<string, Record<string, unknown>>;
  bossData?: Record<string, Record<string, unknown>>;
  playerData?: Record<string, unknown>;
  atlasFrames?: Record<string, FrameEntry>;
  atlasImageDataURL?: string;
}

export interface StagedFile {
  path: string;
  data: Uint8Array;
}

export interface StageResult {
  files: StagedFile[];
  /** Human-readable notes for the build log. */
  notes: string[];
}

/** One frame, and which sheet it must be cut from. */
interface IndexedFrame {
  sheet: Raster;
  entry: FrameEntry;
}

// Firebase keys cannot contain '.', so the editor stores frame names with a
// one-dot-leader in its place. The browser player reverses this the same way.
const decodeKey = (key: string) => key.replace(/․/g, ".");

const textEncoder = new TextEncoder();
const json = (value: unknown) => textEncoder.encode(JSON.stringify(value));

/**
 * Build the name -> (sheet, rect) index the rest of the staging works from:
 * the base atlas, with the level's custom atlas laid over it. A custom frame
 * wins over a base frame of the same name, and also claims the opposite
 * .gif/.png spelling, which is how the browser player resolves them.
 */
function buildFrameIndex(
  baseSheet: Raster,
  baseFrames: Record<string, FrameEntry>,
  custom: { sheet: Raster; frames: Record<string, FrameEntry> } | null,
): Map<string, IndexedFrame> {
  const index = new Map<string, IndexedFrame>();
  for (const [name, entry] of Object.entries(baseFrames)) {
    index.set(name, { sheet: baseSheet, entry });
  }
  if (!custom) return index;
  for (const [rawName, data] of Object.entries(custom.frames)) {
    if (!data || !data.frame) continue;
    const name = decodeKey(rawName);
    const { w, h } = data.frame;
    const entry: FrameEntry = {
      frame: { x: data.frame.x, y: data.frame.y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
    };
    index.set(name, { sheet: custom.sheet, entry });
    const alt = name.endsWith(".png")
      ? name.slice(0, -4) + ".gif"
      : name.endsWith(".gif")
      ? name.slice(0, -4) + ".png"
      : null;
    if (alt) index.set(alt, { sheet: custom.sheet, entry });
  }
  return index;
}

/** Exact name first, then the other of .gif/.png — ps2-sp's own fallback. */
function resolve(
  index: Map<string, IndexedFrame>,
  name: string,
): IndexedFrame | null {
  const direct = index.get(name);
  if (direct) return direct;
  const alt = name.endsWith(".gif")
    ? name.slice(0, -4) + ".png"
    : name.endsWith(".png")
    ? name.slice(0, -4) + ".gif"
    : null;
  return alt ? index.get(alt) ?? null : null;
}

// Every texture array reachable from an entity record. The shapes differ
// between the web export (anim.idle / bulletData) and the PS2 port
// (texture / projectileData), and a record can carry either, so collect both.
function collectTextures(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (key === "texture" || key === "attackTexture" || key === "itemTexture") {
      if (Array.isArray(child)) {
        for (const frame of child) {
          if (typeof frame === "string" && frame) into.add(frame);
        }
      }
      continue;
    }
    if (key === "anim" && child && typeof child === "object") {
      for (const list of Object.values(child as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const frame of list) {
          if (typeof frame === "string" && frame) into.add(frame);
        }
      }
      continue;
    }
    if (child && typeof child === "object") collectTextures(child, into);
  }
}

async function repackBaseAtlas(
  gameDir: string,
  name: string,
  maxSheet: number,
): Promise<{ files: StagedFile[]; note: string }> {
  const sheet = await decodePng(
    await Deno.readFile(join(gameDir, "assets", "img", `${name}.png`)),
  );
  const source = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", `${name}.json`)),
  ) as { frames: Record<string, FrameEntry> };
  const frames: SourceFrame[] = Object.entries(source.frames).map((
    [frameName, entry],
  ) => ({ name: frameName, sheet, entry }));
  const built = buildPs2Atlas(frames, `${name}.png`, maxSheet);
  return {
    files: [
      { path: `assets/${name}.png`, data: await encodePng(built.image) },
      { path: `assets/${name}.json`, data: json(built.json) },
    ],
    note: `${name}: ${frames.length} frames -> ${built.image.width}x` +
      `${built.image.height} at 1/${built.displayScale}`,
  };
}

export interface StageOptions {
  /** static/games/2028-ai — the base game's asset tree. */
  gameDir: string;
  record: LevelRecord;
  /** Cap on either dimension of a generated atlas. */
  maxSheet?: number;
}

/** Produce every file the console reads, ready to hand to the ISO writer. */
export async function stageAssets(options: StageOptions): Promise<StageResult> {
  const { gameDir, record } = options;
  const maxSheet = options.maxSheet ?? 512;
  const files: StagedFile[] = [];
  const notes: string[] = [];

  for (const name of ["game_asset", "game_ui"]) {
    const built = await repackBaseAtlas(gameDir, name, maxSheet);
    files.push(...built.files);
    notes.push(built.note);
  }

  // The recipe the port normalises into its own shape at boot.
  files.push({
    path: "assets/game.json",
    data: await Deno.readFile(join(gameDir, "assets", "game.json")),
  });

  const baseSheet = await decodePng(
    await Deno.readFile(join(gameDir, "assets", "img", "game_asset.png")),
  );
  const baseJson = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game_asset.json")),
  ) as { frames: Record<string, FrameEntry> };

  let custom: { sheet: Raster; frames: Record<string, FrameEntry> } | null =
    null;
  if (record.atlasImageDataURL && record.atlasFrames) {
    custom = {
      sheet: await decodeDataUrl(record.atlasImageDataURL),
      frames: record.atlasFrames,
    };
    notes.push(
      `custom atlas: ${Object.keys(record.atlasFrames).length} frames, ` +
        `${custom.sheet.width}x${custom.sheet.height}`,
    );
  } else {
    notes.push("custom atlas: none — the level uses the base sprites");
  }
  const index = buildFrameIndex(baseSheet, baseJson.frames, custom);

  // --- the level's own atlas ---
  const wanted = new Set<string>();
  collectTextures(record.enemyData ?? {}, wanted);
  collectTextures(record.bossData ?? {}, wanted);

  const levelFrames: SourceFrame[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const found = resolve(index, name);
    if (!found) {
      missing.push(name);
      continue;
    }
    levelFrames.push({ name, sheet: found.sheet, entry: found.entry });
  }

  if (levelFrames.length > 0) {
    const built = buildPs2Atlas(levelFrames, "level_atlas.png", maxSheet);
    files.push(
      { path: "assets/level_atlas.png", data: await encodePng(built.image) },
      { path: "assets/level_atlas.json", data: json(built.json) },
    );
    notes.push(
      `level_atlas: ${levelFrames.length} frames -> ${built.image.width}x` +
        `${built.image.height} at 1/${built.displayScale}`,
    );
  } else {
    // ps2-sp opens both paths unconditionally, and AthenaEnv's image loader
    // does not survive a missing file, so an empty level still gets a sheet.
    files.push(
      {
        path: "assets/level_atlas.png",
        data: await encodePng(newRaster(2, 2)),
      },
      { path: "assets/level_atlas.json", data: json({ frames: {} }) },
    );
    notes.push("level_atlas: empty — the level names no custom sprites");
  }
  if (missing.length) {
    notes.push(
      `level_atlas: ${missing.length} frame(s) not found in either sheet ` +
        `(${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`,
    );
  }

  // --- the player sheet ---
  const playerFrames = Array.isArray(record.playerData?.texture)
    ? record.playerData.texture as string[]
    : null;
  const fallback = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game.json")),
  ) as { playerData?: { texture?: string[] } };
  const wantedPlayer =
    (playerFrames && playerFrames.length
      ? playerFrames
      : fallback.playerData?.texture) ?? ["player00.gif", "player01.gif"];
  files.push({
    path: "assets/cyber_liberty.png",
    data: await encodePng(buildPlayerSheet(index, wantedPlayer)),
  });
  notes.push(`player: ${wantedPlayer.slice(0, 2).join(", ")}`);

  // --- the level itself ---
  //
  // enemyData and bossData are omitted rather than emptied when the level does
  // not carry them: the port *replaces* the base recipe's entries with
  // whatever the level file has, so shipping `{}` would leave the waves
  // pointing at enemies that no longer exist and the stage would come up bare.
  const hasEnemyData = Object.keys(record.enemyData ?? {}).length > 0;
  const hasBossData = Object.keys(record.bossData ?? {}).length > 0;
  files.push({
    path: "assets/level.json",
    data: json({
      name: record.name ?? "",
      stageKey: record.stageKey ?? "stage0",
      width: record.width ?? 8,
      enemylist: record.enemylist ?? [],
      ...(hasEnemyData ? { enemyData: record.enemyData } : {}),
      ...(hasBossData ? { bossData: record.bossData } : {}),
    }),
  });
  notes.push(
    `level.json: ${(record.enemylist ?? []).length} waves` +
      (hasEnemyData ? ", custom enemies" : ", base enemies") +
      (hasBossData ? ", custom boss" : ""),
  );

  return { files, notes };
}

// ps2-sp loads the player from a uniform 32x32 grid sheet and animates cells
// '0' and '1', so the level's first two player frames are fitted into two
// cells — scaled to fit rather than stretched, since the source art is taller
// than it is wide.
function buildPlayerSheet(
  index: Map<string, IndexedFrame>,
  frameNames: string[],
): Raster {
  const cells: Raster[] = [];
  for (const name of frameNames) {
    const found = resolve(index, name);
    if (!found) continue;
    const size = found.entry.sourceSize ?? found.entry.frame;
    const origin = found.entry.trimmed && found.entry.spriteSourceSize
      ? found.entry.spriteSourceSize
      : { x: 0, y: 0 };
    const full = cut(
      found.sheet,
      found.entry.frame,
      size.w,
      size.h,
      origin.x,
      origin.y,
    );
    cells.push(fitInto(full, 32, 32));
    if (cells.length === 2) break;
  }
  const sheet = newRaster(64, 32);
  if (cells.length === 0) return sheet;
  blit(sheet, cells[0], 0, 0);
  blit(sheet, cells[1] ?? cells[0], 32, 0);
  return sheet;
}
