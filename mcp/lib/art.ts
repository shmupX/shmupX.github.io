// Art for a created character: pull frames out of whatever the catalog and the
// working tree hold, and pack the ones a record actually names into one sheet.
//
// The runtime gives us no choice about the destination. Every sprite spawn in
// static/games/2028-ai/game.bundle.js hardcodes the texture key to
// "game_asset" and supplies only a FRAME NAME, and the level loader's
// _stackAtlas stacks a level record's own sheet under that atlas at boot. So
// "swap in any frame from any sprite or atlas" means, concretely: cut the
// chosen frames out of their source sheets, repack them into one sheet, and
// name them in the record. That is what this module does — headlessly, with
// harbor's PNG and raster primitives rather than a browser canvas, the same
// arrangement scripts/build-powerup-atlas.ts uses.

import {
  decodeDataUrl,
  decodePng,
  encodePng,
  newRaster,
} from "@shmupx/shmup-harbor/png";
import type { Bytes, Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import {
  assertSafeKey,
  decodeFrameName,
  encodeFrameKey,
  encodeKey,
  get,
} from "./rtdb.ts";

/** Gap between packed cells, so no sampling can bleed across a frame edge. */
const PAD = 2;
/** Width to pack to before starting a new shelf row. */
const SHEET_WIDTH = 512;

export class ArtError extends Error {
  override name = "ArtError";
}

export interface FrameRect {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

/** A TexturePacker-style hash atlas, the shape the runtime and spriteX read. */
export interface AtlasJson {
  frames: Record<string, FrameRect>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
  };
}

/**
 * Where one frame comes from. The string form `"atlas/frame"` is what a
 * caller types; the object forms exist for a local file, a whole /sprites
 * entry, and for renaming a frame on the way in.
 */
export type FrameRef =
  | string
  | { atlas: string; frame: string; as?: string }
  | { sprite: string; as?: string }
  | { file: string; as?: string };

export interface ResolvedFrame {
  /** Name this frame will carry in the packed sheet, and in the record. */
  name: string;
  raster: Raster;
  /** Where the pixels came from, for the provenance report. */
  source: string;
  /** The atlas/sprite/file that supplied it, used to break name collisions. */
  scope: string;
}

/**
 * An atlas `json` leaf arrives as an object, a JSON string, or — from older
 * publishers — a JSON string that was stringified twice. Normalize all three.
 */
function normalizeAtlasJson(value: unknown): AtlasJson | null {
  if (value == null) return null;
  if (typeof value === "object") return value as AtlasJson;
  if (typeof value !== "string") return null;
  try {
    const once = JSON.parse(value.trim());
    return (typeof once === "string" ? JSON.parse(once) : once) as AtlasJson;
  } catch {
    return null;
  }
}

/**
 * Every frame of an atlas, by its real name.
 *
 * Three layouts are in the catalog and all three are read here:
 *
 *   hash     {frames: {"foo0.png": {frame, ...}}}
 *   array    {frames: [{filename: "foo0.png", ...}]}       TexturePacker
 *   textures {textures: [{frames: [{filename, ...}]}]}     TexturePacker "Phaser 3"
 *
 * The array forms matter: read as a plain map, their frame names come out as
 * the array indices "0", "1", ... and nothing ever matches a real name. Names
 * then go through both key encodings this database uses — see decodeFrameName.
 */
export function frameMap(json: AtlasJson | null): Record<string, FrameRect> {
  const out: Record<string, FrameRect> = {};
  // Hand-maintained atlases carry keys that are not frames at all — the
  // catalog's own 2028_game_asset has a "comment" holding a section divider
  // among its 190 real entries — so entries are admitted by shape, not by
  // position.
  const isRect = (value: unknown): value is FrameRect => {
    const f = (value as { frame?: unknown } | null)?.frame as
      | { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
      | undefined;
    return !!f && typeof f.x === "number" && typeof f.y === "number" &&
      typeof f.w === "number" && typeof f.h === "number";
  };
  const absorb = (frames: unknown) => {
    if (Array.isArray(frames)) {
      for (const entry of frames) {
        const name = (entry as { filename?: unknown }).filename;
        if (typeof name === "string" && isRect(entry)) {
          out[decodeFrameName(name)] = entry;
        }
      }
    } else if (frames && typeof frames === "object") {
      for (const [name, rect] of Object.entries(frames)) {
        if (name === "__BASE" || !isRect(rect)) continue;
        out[decodeFrameName(name)] = rect;
      }
    }
  };
  absorb(json?.frames);
  const textures = (json as { textures?: unknown } | null)?.textures;
  if (Array.isArray(textures)) {
    for (const tex of textures) absorb((tex as { frames?: unknown })?.frames);
  }
  return out;
}

/** Base64 leaf to bytes. Sheets may or may not carry a data: prefix. */
function decodeBase64(raw: string): Bytes {
  const body = raw.replace(/^data:[^,]*;base64,/, "");
  const binary = atob(body);
  // `new ArrayBuffer` explicitly, rather than the length overload: harbor's
  // Bytes is Uint8Array<ArrayBuffer>, and the plain form widens to
  // ArrayBufferLike (which admits SharedArrayBuffer) and will not assign.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface LoadedAtlas {
  name: string;
  json: AtlasJson | null;
  frames: Record<string, FrameRect>;
  sheet: Raster | null;
}

const atlasCache = new Map<string, LoadedAtlas>();

/** Read one catalog atlas: its frame map, and its sheet decoded to RGBA. */
export async function loadAtlas(
  name: string,
  { sheet = true }: { sheet?: boolean } = {},
): Promise<LoadedAtlas> {
  assertSafeKey("Atlas name", name);
  const cached = atlasCache.get(name);
  if (cached && (!sheet || cached.sheet)) return cached;
  const record = await get<{ json?: unknown; png?: unknown }>(
    `atlases/${name}`,
  );
  if (!record || typeof record !== "object") {
    throw new ArtError(
      `No atlas at atlases/${name}. Use shmupx_list_atlases to see valid names.`,
    );
  }
  const json = normalizeAtlasJson(record.json);
  const loaded: LoadedAtlas = {
    name,
    json,
    frames: frameMap(json),
    sheet: sheet && typeof record.png === "string"
      ? await decodePng(decodeBase64(record.png))
      : null,
  };
  atlasCache.set(name, loaded);
  return loaded;
}

function parseRef(ref: FrameRef): Exclude<FrameRef, string> {
  if (typeof ref !== "string") return ref;
  // "atlas/frame" — the frame half may itself contain "/" in principle, so
  // split on the FIRST separator only and let the atlas-name guard reject
  // anything strange.
  const slash = ref.indexOf("/");
  if (slash < 0) {
    throw new ArtError(
      `Frame reference ${
        JSON.stringify(ref)
      } has no atlas. Write "<atlas>/<frame>" (e.g. "hadouken/hadouken1"), ` +
        `or {sprite: "name"} for a whole /sprites entry, or {file: "path.png"}.`,
    );
  }
  return { atlas: ref.slice(0, slash), frame: ref.slice(slash + 1) };
}

/** Turn one reference into pixels plus the name it will carry. */
export async function resolveFrame(ref: FrameRef): Promise<ResolvedFrame> {
  const spec = parseRef(ref);

  if ("atlas" in spec) {
    const atlas = await loadAtlas(spec.atlas);
    const rect = atlas.frames[spec.frame] ??
      atlas.frames[decodeFrameName(spec.frame)];
    if (!rect) {
      const near = Object.keys(atlas.frames).slice(0, 12);
      throw new ArtError(
        `Atlas "${spec.atlas}" has no frame "${spec.frame}". ` +
          `It carries ${Object.keys(atlas.frames).length}: ${near.join(", ")}` +
          (near.length < Object.keys(atlas.frames).length ? ", ..." : "") +
          ". Use shmupx_list_frames for the full list.",
      );
    }
    if (!atlas.sheet) {
      throw new ArtError(`Atlas "${spec.atlas}" has no png leaf to cut from.`);
    }
    return {
      name: spec.as ?? spec.frame,
      raster: cut(atlas.sheet, rect.frame),
      source: `atlases/${spec.atlas}#${spec.frame}`,
      scope: spec.atlas,
    };
  }

  if ("sprite" in spec) {
    // A sprite whose name carries a "." is stored under its k_-hex spelling,
    // so try both before giving up, and accept either leaf shape.
    let raw: unknown = null;
    for (const key of [spec.sprite, encodeFrameKey(spec.sprite)]) {
      if (!/^[\w-]+$/.test(key)) continue;
      const value = await get<unknown>(`sprites/${key}`);
      raw = typeof value === "string"
        ? value
        : (value as { png?: unknown })?.png;
      if (typeof raw === "string") break;
    }
    if (typeof raw !== "string") {
      throw new ArtError(
        `No sprite at sprites/${spec.sprite}. Use shmupx_list_sprites to see valid names.`,
      );
    }
    return {
      name: spec.as ?? spec.sprite,
      raster: raw.startsWith("data:")
        ? await decodeDataUrl(raw)
        : await decodePng(decodeBase64(raw)),
      source: `sprites/${spec.sprite}`,
      scope: spec.sprite,
    };
  }

  // A file in the working tree. dev-fixtures/ is the repo's designated
  // local-only art drop (gitignored but for debug-tools/), so this is the
  // path for art that is not in the catalog yet.
  const bytes = await Deno.readFile(spec.file).catch(() => {
    throw new ArtError(
      `No such file: ${spec.file}. ` +
        `Art under dev-fixtures/ is gitignored by design, so the file has to be ` +
        `placed there locally before it can be packed.`,
    );
  });
  const base = spec.file.split("/").pop() ?? spec.file;
  return {
    name: spec.as ?? base,
    raster: await decodePng(bytes),
    source: spec.file,
    scope: base.replace(/\.[^.]+$/, ""),
  };
}

/**
 * Pack rasters into one sheet by shelf rows, tallest first.
 *
 * Not a clever packer — the sheets here are a handful of sprites, and every
 * byte of the result is base64'd into a level record, so predictability beats
 * the last few percent of area.
 */
export function packFrames(
  entries: ResolvedFrame[],
): { sheet: Raster; json: AtlasJson } {
  const order = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      b.entry.raster.height - a.entry.raster.height || a.index - b.index
    );

  const placed: { entry: ResolvedFrame; x: number; y: number }[] = [];
  let penX = 0, penY = 0, rowH = 0, width = 0;
  for (const { entry } of order) {
    const { width: w, height: h } = entry.raster;
    if (penX > 0 && penX + w > SHEET_WIDTH) {
      penX = 0;
      penY += rowH + PAD;
      rowH = 0;
    }
    placed.push({ entry, x: penX, y: penY });
    penX += w + PAD;
    rowH = Math.max(rowH, h);
    width = Math.max(width, penX - PAD);
  }
  const height = penY + rowH;

  const sheet = newRaster(Math.max(1, width), Math.max(1, height));
  const frames: Record<string, FrameRect> = {};
  for (const { entry, x, y } of placed) {
    blit(sheet, entry.raster, x, y);
    const w = entry.raster.width;
    const h = entry.raster.height;
    frames[entry.name] = {
      frame: { x, y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
    };
  }

  return {
    sheet,
    json: {
      frames,
      meta: {
        app: "shmupX character MCP",
        version: "1.0",
        image: "atlas.png",
        format: "RGBA8888",
        size: { w: sheet.width, h: sheet.height },
        scale: "1",
      },
    },
  };
}

/** The packed sheet as the `data:image/png;base64,...` a level record carries. */
export async function sheetDataUrl(sheet: Raster): Promise<string> {
  const png = await encodePng(sheet);
  let binary = "";
  for (let i = 0; i < png.length; i++) binary += String.fromCharCode(png[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

/** A frame map with its keys Firebase-encoded, for anything stored in RTDB. */
export function encodeFrameMap(
  frames: Record<string, FrameRect>,
): Record<string, FrameRect> {
  const out: Record<string, FrameRect> = {};
  for (const [name, rect] of Object.entries(frames)) {
    out[encodeKey(name)] = rect;
  }
  return out;
}
