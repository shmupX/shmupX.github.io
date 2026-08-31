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
  encodeIndexedPng,
  encodePng,
  newRaster,
  type Raster,
} from "./png.ts";
import { buildPs2Atlas, type FrameEntry, type SourceFrame } from "./atlas.ts";
import { quantize } from "./palette.ts";
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
  /**
   * A Dezaemon save's own drawn title screen: role -> the atlas frame name
   * holding it. `mapSaveToGame` writes this from the save's TITLE 1/2 and
   * credit strips.
   */
  dezaemonTitle?: Record<string, string>;
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
export interface IndexedFrame {
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

/**
 * Every sheet goes on the disc as an 8-bit indexed PNG.
 *
 * AthenaEnv uploads those as GS_PSM_T8, a quarter of the VRAM of the RGBA
 * form. That is the difference between the working set fitting in the GS's
 * 4 MB and not: the three sheets are 2.51 MB at 32bpp, and the framebuffer
 * alone (640x448, double-buffered, 32-bit) is 2.19 MB of the 4. Over-commit
 * and AthenaEnv's texture manager evicts and re-uploads sheets over DMA,
 * which costs far more than the colour ever could.
 *
 * The sheets hold 17k-32k distinct colours, so this is lossy — measured mean
 * error is under 3.2 of 255. `note` says so per sheet, and says EXACT when a
 * sheet fitted in 256 colours on its own.
 */
async function encodeSheet(
  raster: Raster,
  name: string,
): Promise<{ data: Uint8Array; note: string }> {
  const q = quantize(raster);
  return {
    data: await encodeIndexedPng(q),
    note: q.exact
      ? `${name}: ${q.sourceColors} colours, exact as 8-bit indexed`
      : `${name}: ${q.sourceColors} colours -> 256, mean error ` +
        `${q.meanError.toFixed(2)}/255`,
  };
}

/**
 * The player's shot frames, from the level's own recipe with the base game's
 * as the fallback — the same lookup the port does at draw time
 * (`p.shootNormalData.texture[0]` and friends).
 *
 * These are the frames that get turned upright. The art is drawn side-on —
 * `bigProjectile_0.png` is a 23x8 horizontal streak — because the browser
 * engine rotates a sprite to its heading. The PS2 port does not: its
 * `AtlasManager.drawFrame` takes no angle, and a bullet's `rotation` only ever
 * moves it. So shots flew up the screen lying on their side.
 */
function playerShotFrames(
  record: LevelRecord,
  fallback: { playerData?: Record<string, unknown> },
): Set<string> {
  const out = new Set<string>();
  for (const source of [record.playerData, fallback.playerData]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith("shoot")) continue;
      const texture = (value as { texture?: unknown })?.texture;
      if (!Array.isArray(texture)) continue;
      for (const frame of texture) {
        if (typeof frame === "string") out.add(frame);
      }
    }
  }
  return out;
}

async function repackBaseAtlas(
  gameDir: string,
  name: string,
  maxSheet: number,
  rotate: Set<string> = new Set(),
  /** Frames to pack under these names instead of the base sheet's own. */
  overrides: SourceFrame[] = [],
  /** Base frames to leave out entirely, so `hasFrame` reports false. */
  drop: Set<string> = new Set(),
): Promise<{ files: StagedFile[]; note: string }> {
  const sheet = await decodePng(
    await Deno.readFile(join(gameDir, "assets", "img", `${name}.png`)),
  );
  const source = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", `${name}.json`)),
  ) as { frames: Record<string, FrameEntry> };
  const replaced = new Set(overrides.map((frame) => frame.name));
  const frames: SourceFrame[] = Object.entries(source.frames)
    .filter(([frameName]) => !drop.has(frameName) && !replaced.has(frameName))
    .map((
      [frameName, entry],
    ) => ({ name: frameName, sheet, entry, rotate: rotate.has(frameName) }));
  frames.push(...overrides);
  const built = buildPs2Atlas(frames, `${name}.png`, maxSheet);
  const encoded = await encodeSheet(built.image, name);
  return {
    files: [
      { path: `assets/${name}.png`, data: encoded.data },
      { path: `assets/${name}.json`, data: json(built.json) },
    ],
    note: `${name}: ${frames.length} frames -> ${built.image.width}x` +
      `${built.image.height} at 1/${built.displayScale}; ${encoded.note}`,
  };
}

export interface StageOptions {
  /** static/games/2028-ai — the base game's asset tree. */
  gameDir: string;
  record: LevelRecord;
  /** Cap on either dimension of a generated atlas. */
  maxSheet?: number;
}

/**
 * A Dezaemon save's own title screen, mapped onto the frames the PS2 port's
 * title scene actually draws.
 *
 * `mapSaveToGame` records the save's drawn TITLE 1/2 and credit strips as
 * `dezaemonTitle`: role -> a frame name in the level's atlas. The browser
 * runtime keys off the same field and, when it is there, hides the stock
 * backdrop and the sliding "titleG" logo and puts the save's own art up
 * instead (game.bundle.js, `dezaTitle`). The port has no such branch — it
 * draws `title_bg`, `titleG.gif`, `logo.gif` and `subTitle.gif` from game_ui
 * and nothing else — so the same effect is arranged here, by packing the
 * save's art under those names and leaving the ones it should not draw out of
 * the sheet entirely. A frame that is not in the atlas fails the port's own
 * `hasFrame` check, which is exactly the `setVisible(false)` the browser does.
 *
 * The role pairing follows the browser: title1 is the logo, or title2 stands
 * in when a save drew only the lower strip; the subtitle is title2, and only
 * when title1 took the logo slot. `credit` has nowhere to go — the port draws
 * its copyright line as text — so it is reported and dropped.
 */
export function dezaemonTitleFrames(
  record: LevelRecord,
  index: Map<string, IndexedFrame>,
  notes: string[],
): { overrides: SourceFrame[]; drop: Set<string> } {
  const roles = record.dezaemonTitle;
  const overrides: SourceFrame[] = [];
  const drop = new Set<string>();
  if (!roles || !Object.keys(roles).length) return { overrides, drop };

  const frameFor = (role: string): SourceFrame | null => {
    const name = roles[role];
    if (!name) return null;
    const found = resolve(index, name);
    return found ? { name, sheet: found.sheet, entry: found.entry } : null;
  };

  const title1 = frameFor("title1");
  const title2 = frameFor("title2");
  const logo = title1 ?? title2;
  const subtitle = title1 ? title2 : null;

  // The save's title replaces the whole stock arrangement, not part of it.
  drop.add("titleG.gif");
  drop.add("title_bg");

  if (logo) overrides.push({ ...logo, name: "logo.gif" });
  else drop.add("logo.gif");
  if (subtitle) overrides.push({ ...subtitle, name: "subTitle.gif" });
  else drop.add("subTitle.gif");

  const missing = Object.entries(roles)
    .filter(([role, name]) => role !== "credit" && name && !frameFor(role))
    .map(([role]) => role);
  notes.push(
    `dezaemon title: ${
      logo ? `logo from ${roles.title1 ?? roles.title2}` : "no logo art"
    }${subtitle ? `, subtitle from ${roles.title2}` : ""}` +
      `${roles.credit ? " (credit strip has nowhere to go)" : ""}` +
      `${missing.length ? `; ${missing.join(", ")} not in the atlas` : ""}`,
  );
  return { overrides, drop };
}

/** Produce every file the console reads, ready to hand to the ISO writer. */
export async function stageAssets(options: StageOptions): Promise<StageResult> {
  const { gameDir, record } = options;
  const maxSheet = options.maxSheet ?? 512;
  const files: StagedFile[] = [];
  const notes: string[] = [];

  const baseRecipe = JSON.parse(
    await Deno.readTextFile(join(gameDir, "assets", "game.json")),
  ) as { playerData?: Record<string, unknown> };
  // Only game_asset: that is the sheet the port draws bullets from.
  const upright = playerShotFrames(record, baseRecipe);

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

  const title = dezaemonTitleFrames(record, index, notes);

  for (const name of ["game_asset", "game_ui"]) {
    const built = await repackBaseAtlas(
      gameDir,
      name,
      maxSheet,
      name === "game_asset" ? upright : new Set(),
      name === "game_ui" ? title.overrides : [],
      name === "game_ui" ? title.drop : new Set(),
    );
    files.push(...built.files);
    notes.push(built.note);
  }
  if (upright.size) {
    notes.push(
      `player shots: ${upright.size} frame(s) turned upright — ` +
        `${[...upright].slice(0, 3).join(", ")}${
          upright.size > 3 ? ", …" : ""
        }`,
    );
  }

  // The recipe the port normalises into its own shape at boot.
  files.push({
    path: "assets/game.json",
    data: await Deno.readFile(join(gameDir, "assets", "game.json")),
  });

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
    const sheet = await encodeSheet(built.image, "level_atlas");
    files.push(
      { path: "assets/level_atlas.png", data: sheet.data },
      { path: "assets/level_atlas.json", data: json(built.json) },
    );
    notes.push(
      `level_atlas: ${levelFrames.length} frames -> ${built.image.width}x` +
        `${built.image.height} at 1/${built.displayScale}`,
      sheet.note,
    );
  } else {
    // ps2-sp opens both paths unconditionally, and AthenaEnv's image loader
    // does not survive a missing file, so an empty level still gets a sheet.
    files.push(
      {
        path: "assets/level_atlas.png",
        data: (await encodeSheet(newRaster(2, 2), "level_atlas")).data,
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
  const player = await encodeSheet(
    buildPlayerSheet(index, wantedPlayer),
    "player sheet",
  );
  files.push({ path: "assets/cyber_liberty.png", data: player.data });
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
