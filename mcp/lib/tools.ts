// The catalog tools, as one table.
//
// Two things hand these tools to a model: the stdio MCP server (mcp/server.ts,
// for a Claude Code session in this checkout and for the watch bridge) and
// the hosted assistant (routes/api/assistant.ts, for a player typing into the
// editor at codemonkey.games with no MCP client of their own). They used to
// live inline in the server, which made the assistant a second copy of every
// shape and every handler, drifting from the first. Now the server registers
// this table and the assistant turns the same table into Messages API tool
// specs, so a tool exists once: its zod shape is the MCP inputSchema AND, via
// z.toJSONSchema, the API's input_schema; its handler is the same function
// behind both.
//
// What is NOT here: the preview server (mcp/lib/preview.ts — it binds a port
// on the machine running it, which on Deno Deploy is nobody's) and the debug
// tools (a DevTools port on the player's own Chrome). Those stay the MCP
// server's alone.
//
// `local` says whether the process runs on the player's own machine. Only
// then may art come from a file in the working tree (dev-fixtures/) and a
// built character be written to a directory for inspection; the hosted
// assistant has neither a working tree nor anywhere worth writing, so those
// branches are not in the shapes it offers.

import { z } from "zod";
import { resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { decodeDataUrl } from "@shmupx/shmup-harbor/png";
import { cut } from "@shmupx/shmup-harbor/raster";

import { catalogUrl, databaseUrl, listKeys } from "./rtdb.ts";
import { frameMap, loadAtlas } from "./art.ts";
import {
  buildCharacter,
  type CreateRequest,
  type CreateResult,
  getCharacter,
  listCharacters,
  MAIN_PROJECTILE_KEY,
  PROJECTILE_KEYS,
  publishCharacter,
  referencedFrames,
} from "./character.ts";
import { placeCharacter } from "./place.ts";
import {
  describeObject,
  EDIT_SCOPES,
  framesFor,
  listObjects,
  renderObject,
  ROLES,
  updateObject,
} from "./objects.ts";
import { pngBase64 } from "./pixels.ts";

/** ─── result helpers (same contract as spriteX's server) ───────────────── */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Every tool body runs through this. The errors these tools raise are the
 * caller's to act on — an atlas that has no such frame, art that is not on
 * disk, a name that is not an identifier — so they arrive as the message they
 * were written as rather than as a stack trace the model has to parse.
 */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** ─── shared input shapes ──────────────────────────────────────────────── */

/**
 * A handler's arguments, derived from the shape it was registered with.
 *
 * registerTool's own inference does not survive Deno's type checker — the
 * callback's parameter lands as an implicit any — so each shape is named and
 * each handler is annotated with what that shape infers to. The types are the
 * real ones; only the path to them is manual.
 */
export type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export interface CatalogToolOptions {
  /**
   * The process runs on the player's own machine: a frame may be a PNG in the
   * working tree, and a build may also be written to a directory.
   */
  local: boolean;
}

const atlasFrameRef = z.string().describe(
  'A frame of a catalog atlas, written "<atlas>/<frame>" — e.g. "hadouken/hadouken1". ' +
    "shmupX's own atlas of that name is used when there is one, else the root " +
    "catalog's (read only). Use shmupx_list_frames to get exact frame names.",
);

const namedFrameRef = z.object({
  atlas: z.string(),
  frame: z.string(),
  as: z.string().optional().describe(
    "Rename the frame in the new character's atlas",
  ),
});

const spriteRef = z.object({
  sprite: z.string().describe(
    "A whole /sprites entry (root-level, shared with spriteX), used as one frame",
  ),
  as: z.string().optional(),
});

const fileRef = z.object({
  file: z.string().describe(
    "A PNG in the working tree, e.g. dev-fixtures/hadouken0.png. " +
      "dev-fixtures/ is gitignored by design — the file must be placed there locally.",
  ),
  as: z.string().optional(),
});

function frameRefFor({ local }: CatalogToolOptions) {
  return local
    ? z.union([atlasFrameRef, namedFrameRef, spriteRef, fileRef])
    : z.union([atlasFrameRef, namedFrameRef, spriteRef]);
}

/**
 * The shapes that depend on where the process runs. The MCP server's preview
 * tool builds on `buildShape` too, so it takes the local variant from here
 * rather than spelling a second one.
 */
export function shapesFor(options: CatalogToolOptions) {
  const frameRef = frameRefFor(options);

  const projectileOverride = z.object({
    texture: z.array(frameRef).optional().describe(
      "The projectile's frames. Bullets carry no Phaser animation — the runtime " +
        "hand-flips this list with setFrame(), so two frames is a two-frame flicker.",
    ),
    speed: z.number().optional(),
    damage: z.number().optional(),
    hp: z.number().optional(),
    score: z.number().optional(),
    spgage: z.number().optional(),
    frameRate: z.number().optional().describe(
      "How fast a multi-frame bullet flips",
    ),
  });

  /** The fields that describe a character to build; shared by create and preview. */
  const buildShape = {
    name: z.string().describe(
      "Name of the new character (letters, digits, _ or -)",
    ),
    cloneFrom: z.string().optional().describe(
      "Character to clone every attribute from, e.g. 'dezaBoss0'. Omit to build from nothing.",
    ),
    mainProjectile: z.array(frameRef).optional().describe(
      `Frames for the MAIN projectile. Sugar for projectiles.${MAIN_PROJECTILE_KEY}.texture — ` +
        "the slot the runtime actually fires from. Writing the unsuffixed `bulletData` " +
        "instead is the classic mistake and changes nothing visible.",
    ),
    anim: z.record(z.string(), z.array(frameRef)).optional().describe(
      "Animation states to replace, e.g. {idle: [...], attack: [...]}. Keys not named are kept from the clone.",
    ),
    projectiles: z.record(z.string(), projectileOverride).optional().describe(
      `Projectile slots to replace. One of: ${PROJECTILE_KEYS.join(", ")}.`,
    ),
    stageBgEnd: z.union([frameRef, z.null()]).optional().describe(
      "Art to raise behind this boss instead of the shipped stage_end backdrop — any " +
        "sprite, atlas cell or rasterised tilemap. null clears an inherited one.",
    ),
    stageBgEndAlpha: z.number().min(0).max(1).optional().describe(
      "Opacity for the stage-end backdrop, 0..1 — lay it over the starfield instead " +
        "of hiding it. On its own, with no stageBgEnd, it makes the shipped backdrop " +
        "translucent.",
    ),
    stats: z.record(z.string(), z.union([z.number(), z.boolean()])).optional()
      .describe(
        "Plain fields to set on the record: hp, score, interval, spgage, shadowOffsetY, shadowReverse.",
      ),
  };

  const createShape = {
    ...buildShape,
    apply: z.boolean().optional().describe(
      "Publish to the catalog. Default false — a dry run that returns the record only.",
    ),
    preview: z.boolean().optional().describe(
      "Also answer with the first idle frame of the built character as a PNG " +
        "(png_base64, width_px, height_px), cut from the atlas it packed.",
    ),
    ...(options.local
      ? {
        writeTo: z.string().optional().describe(
          "Also write the built record and its atlas PNG to this directory, for inspection.",
        ),
      }
      : {}),
  };

  return { frameRef, buildShape, createShape };
}

export const getCharacterShape = {
  name: z.string().describe("Character name, e.g. 'dezaBoss0'"),
};

export const listAtlasesShape = {
  match: z.string().optional().describe(
    "Case-insensitive substring filter on the atlas name",
  ),
};

export const listFramesShape = {
  atlas: z.string().describe("Atlas name, e.g. 'hadouken'"),
};

export const listSpritesShape = {
  match: z.string().optional().describe("Case-insensitive substring filter"),
};

export const placeShape = {
  level: z.string().describe(
    "Cloud level name, e.g. 'gs' — a key under shmupX/levels, or an alias in " +
      "shmupX/levelAliases ('2019' is 2019-PS2)",
  ),
  character: z.string().describe("Character to place, e.g. 'hadoukenBoss'"),
  stage: z.number().int().min(0).max(9).optional().describe(
    "Which boss slot to replace — boss<stage>. Default 0.",
  ),
  apply: z.boolean().optional().describe(
    "Write the change. Default false — a dry run reporting what would change.",
  ),
};

/**
 * The object tools. An object is a catalog character addressed by role and
 * ordinal instead of by id, so a spoken phrase can reach it; the id every
 * other tool takes is what `shmupx_list_objects` resolves the phrase to.
 */
export const listObjectsShape = {
  query: z.string().optional().describe(
    "The phrase naming one object, as a person says it: 'the second boss', " +
      "'boss 2', 'the last boss', 'stage 1 boss', 'the pyramid', 'hadouken'. " +
      "Resolved deterministically — ordinals count stages where the names carry " +
      "them (the second boss is stage 1) — and the result's `resolved` is the one " +
      "match, `candidates` the shortlist when there are several, `ignored` the " +
      "words that named nothing.",
  ),
  role: z.enum(ROLES).optional().describe(
    "Only objects of this kind. Roles are read off the record's shape: boss, " +
      "enemy (zako), player, projectile, art.",
  ),
  level: z.string().optional().describe(
    "List a cloud level's boss slots (shmupX/levels/<name>/bossData/boss<N>; an alias " +
      "such as '2019' names its level) instead of " +
      "the catalog — 'the second boss' there is boss1. Each slot names the catalog " +
      "character it came from, when there is one; THAT is the id the edit tools " +
      "take, since a level's copy is edited by editing the character and placing " +
      "it again with shmupx_place_character.",
  ),
};

export const getObjectShape = {
  id: z.string().describe(
    "Object id — a catalog character name such as 'dezaBoss1', usually the " +
      "`resolved.id` shmupx_list_objects answered with.",
  ),
};

export const previewObjectShape = {
  id: getObjectShape.id,
  state: z.string().optional().describe(
    "Which frames: an animation state ('idle' — the default, and what the runtime " +
      "spawns it with — 'attack', ...), 'projectile' for its main shot, or " +
      "'backdrop' for its stage-end art. The result lists the states it has.",
  ),
  frame: z.number().int().min(0).optional().describe(
    "Frame index within the state (default 0).",
  ),
  scale: z.number().int().min(1).max(8).optional().describe(
    "Integer nearest-neighbour upscale (default 1). The watch scales for itself, " +
      "so leave this alone unless a bigger PNG is wanted for its own sake.",
  ),
};

const paletteShape = z.object({
  hue: z.number().min(-360).max(360).optional().describe(
    "Degrees to rotate every hue by; 120 turns red into green.",
  ),
  saturation: z.number().min(-1).max(1).optional().describe(
    "-1 is greyscale, +1 doubles saturation.",
  ),
  lightness: z.number().min(-1).max(1).optional().describe(
    "-1 is black, +1 is white; 0.3 lifts every tone 30% of the way.",
  ),
  toward: z.string().optional().describe(
    "Pull every hue toward this colour, keeping the shading: '#f00', '#00ff00', " +
      "'red', 'blue', 'purple', 'gold'... Grey pixels take the colour outright.",
  ),
  amount: z.number().min(0).max(1).optional().describe(
    "How far toward it (default 1, all the way).",
  ),
});

export const updateObjectShape = {
  id: getObjectShape.id,
  aggression: z.number().min(-1).max(1).optional().describe(
    "-1..1. The shots, and a zako's cadence: +1 multiplies every projectile slot's " +
      "speed and damage by 1.5, and halves a zako's `interval` (the ticks between " +
      "its shots); -1 does the reverse. A boss's interval is left alone — the " +
      "runtime never reads it, a boss fires on its pattern script's clock — and the " +
      "result says so. Arithmetic on the current values, so a second 'more " +
      "aggressive' compounds. hp is not aggression — use stats for that.",
  ),
  silhouette: z.number().min(-1).max(1).optional().describe(
    "-1..1. Resamples the body art to 1 + 0.5 × this: +1 is half again as big " +
      "(64px becomes 96px), -1 is half size. Nearest-neighbour, so pixel art stays " +
      "pixel art; the sprite's hitbox follows its frame size.",
  ),
  palette: paletteShape.optional().describe(
    "Recolour the body art. Shading survives a hue, saturation or toward edit — " +
      "outlines stay dark, highlights stay light — because lightness is kept unless " +
      "`lightness` itself is set. Toward white, black or grey drains colour instead " +
      "of moving hue.",
  ),
  scope: z.enum(EDIT_SCOPES).optional().describe(
    "Which frames silhouette and palette touch: 'body' (default — the object " +
      "itself, not its shots or backdrop), 'projectiles', or 'all'. Silhouette " +
      "never resamples a Dezaemon boss's part frames (turrets sit at the cart's " +
      "fixed offsets); palette recolours them with the rest of the body.",
  ),
  stats: z.record(z.string(), z.union([z.number(), z.boolean()])).optional()
    .describe(
      "Exact field values, applied after the dials: hp, score, spgage, " +
        "shadowOffsetY, shadowReverse — and interval, which only a stock zako's " +
        "runtime reads (the result warns when it is written anywhere else).",
    ),
  saveAs: z.string().optional().describe(
    "Write the result as a NEW character under this name and leave the original " +
      "untouched — the safe way to try an edit on a shared catalog. The name must " +
      "not already exist; an apply that would replace a character is refused.",
  ),
  apply: z.boolean().optional().describe(
    "Write the result to the catalog. Default false — a dry run that answers with " +
      "the changes and a preview PNG of the result and writes nothing. A hands-free " +
      "session runs a fresh server per utterance, so an edit that is not applied " +
      "is gone by the next sentence: pass apply=true when the player has asked for " +
      "the change to happen, and prefer saveAs when they have not said where.",
  ),
};

/** ─── build helpers (shared with the preview tool in mcp/server.ts) ────── */

export function toRequest(args: Record<string, unknown>): CreateRequest {
  const projectiles = {
    ...(args.projectiles as CreateRequest["projectiles"] ?? {}),
  };
  if (args.mainProjectile) {
    projectiles[MAIN_PROJECTILE_KEY] = {
      ...projectiles[MAIN_PROJECTILE_KEY],
      texture: args.mainProjectile as never,
    };
  }
  return {
    name: args.name as string,
    cloneFrom: args.cloneFrom as string | undefined,
    anim: args.anim as CreateRequest["anim"],
    projectiles,
    stageBgEnd: args.stageBgEnd as CreateRequest["stageBgEnd"],
    stageBgEndAlpha: args.stageBgEndAlpha as number | undefined,
    stats: args.stats as CreateRequest["stats"],
  };
}

/** What a build reports back. The atlas dataURL is megabytes — never inline it. */
export function summarize(built: CreateResult) {
  return {
    name: built.name,
    clonedFrom: built.clonedFrom,
    character: built.character,
    atlas: {
      frameCount: built.atlas.frameCount,
      size: built.atlas.size,
      dataUrlBytes: built.atlas.dataUrl.length,
      frames: Object.keys(built.atlas.json.frames).sort(),
    },
    provenance: built.provenance,
    unresolved: built.unresolved,
    warnings: built.warnings,
  };
}

/**
 * The first idle frame of a build, cut back out of the atlas it packed, as the
 * bare-base64 PNG shape the object tools answer with. The sheet is decoded
 * from the data URL the build already carries rather than kept as a raster
 * beside it: a build is made to be published, and one decode of a small
 * sheet is cheaper than every CreateResult carrying its pixels twice.
 */
export async function previewOfBuild(built: CreateResult): Promise<
  {
    png_base64: string;
    width_px: number;
    height_px: number;
    frame: string;
  } | null
> {
  let name: string | undefined;
  try {
    name = framesFor(built.character, "idle")[0];
  } catch {
    name = undefined;
  }
  const frames = built.atlas.json.frames;
  name = name && frames[name] ? name : Object.keys(frames)[0];
  const rect = name ? frames[name] : undefined;
  if (!name || !rect) return null;
  const sheet = await decodeDataUrl(built.atlas.dataUrl);
  const raster = cut(sheet, rect.frame);
  return {
    png_base64: await pngBase64(raster),
    width_px: raster.width,
    height_px: raster.height,
    frame: name,
  };
}

/** ─── the table ────────────────────────────────────────────────────────── */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CatalogTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  shape: S;
  annotations: ToolAnnotations;
  /**
   * The tool writes the catalog when its `apply` is true. The hosted assistant
   * forces `apply` off on every call it relays and keeps the call as a
   * proposal the player can publish; a tool without this flag has no `apply`.
   */
  writes: boolean;
  /**
   * Offered to the hosted assistant. Off for shmupx_place_character: it edits
   * a cloud level somebody else authored, and the editor already has its own
   * way of folding a catalog character into the level that is open — ADD.
   */
  assistant: boolean;
  run(args: Args<S>): Promise<ToolResult>;
}

// The handlers are typed against their own shapes; the table erases that to
// one element type so a loop can register or dispatch them.
function tool<S extends z.ZodRawShape>(t: CatalogTool<S>): CatalogTool {
  return t as unknown as CatalogTool;
}

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/** Every catalog tool, built for a process that is or is not on the player's machine. */
export function catalogTools(options: CatalogToolOptions): CatalogTool[] {
  const { createShape } = shapesFor(options);

  return [
    tool({
      name: "shmupx_list_characters",
      title: "List characters",
      description:
        "List the characters in the shmupX catalog (shmupX/characters/*; cmg's root-level " +
        "characters are another app's and are not listed). These are boss-shaped records — " +
        "anim, projectile slots, a dezaemon trailer, hp/score — and any of them can be cloned. " +
        "dezaBoss0..N are the ones a Dezaemon 2 cart import produces.",
      shape: {},
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async () => {
        const names = await listCharacters();
        return ok({
          database: databaseUrl(),
          catalog: catalogUrl(),
          count: names.length,
          characters: names,
        });
      },
    }),

    tool({
      name: "shmupx_get_character",
      title: "Get a character",
      description:
        "Read one character's full record — the exact attributes a clone would inherit, plus the " +
        "frame names it references and the atlas those frames live in.",
      shape: getCharacterShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async ({ name }) => {
        const record = await getCharacter(name);
        return ok({
          name,
          textureKey: record.textureKey ?? null,
          fields: Object.keys(record).sort(),
          referencedFrames: referencedFrames(record).sort(),
          character: record,
        });
      },
    }),

    tool({
      name: "shmupx_list_atlases",
      title: "List atlases",
      description:
        "List every atlas frames can be taken from: shmupX's own (shmupX/atlases/*, where the " +
        "catalog's characters keep their art) and the root catalog's (atlases/*, cmg's and " +
        "spriteX's ~430 sheets, read only). Each one is a sheet of named frames, and any frame " +
        "of any of them can be swapped into a character; a name in both is shmupX's. " +
        "`shmupX` lists the names that are shmupX's own.",
      shape: listAtlasesShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async ({ match }) => {
        const [own, root] = await Promise.all([
          listKeys("atlases"),
          listKeys("atlases", { unscoped: true }),
        ]);
        const all = [...new Set([...own, ...root])].sort();
        const hit = (n: string) =>
          !match || n.toLowerCase().includes(match.toLowerCase());
        const names = all.filter(hit);
        return ok({
          total: all.length,
          count: names.length,
          atlases: names,
          shmupX: own.filter(hit),
        });
      },
    }),

    tool({
      name: "shmupx_list_frames",
      title: "List frames in an atlas",
      description:
        "List the frame names inside one atlas, with each frame's pixel size. Call this before " +
        "referencing a frame — names are exact and often do not match the atlas name.",
      shape: listFramesShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async ({ atlas }) => {
        const loaded = await loadAtlas(atlas, { sheet: false });
        const frames = Object.entries(frameMap(loaded.json))
          .map(([name, rect]) => ({
            name,
            ref: `${atlas}/${name}`,
            w: rect.frame.w,
            h: rect.frame.h,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!frames.length) return fail(`Atlas "${atlas}" has no frames.`);
        return ok({
          atlas,
          // Which tree answered: shmupX's own atlas, or the root catalog's.
          source: loaded.path,
          sheet: loaded.json?.meta?.size ?? null,
          count: frames.length,
          frames,
        });
      },
    }),

    tool({
      name: "shmupx_list_sprites",
      title: "List sprites",
      description:
        "List the whole-image sprites in the catalog (/sprites/*). Each is a single picture rather " +
        "than a sheet, referenced as {sprite: '<name>'} and packed as one frame.",
      shape: listSpritesShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async ({ match }) => {
        const all = await listKeys("sprites");
        const names = match
          ? all.filter((n) => n.toLowerCase().includes(match.toLowerCase()))
          : all;
        return ok({ total: all.length, count: names.length, sprites: names });
      },
    }),

    tool({
      name: "shmupx_create_character",
      title: "Create a character",
      description:
        "Clone a character's attributes, swap frames from any sprite or atlas into its animations, " +
        "projectiles and stage-end backdrop, and pack the result into its own atlas. " +
        "Returns the built record WITHOUT writing anything; pass apply=true to publish it to the " +
        "catalog as shmupX/characters/<name> + shmupX/atlases/<name> (never to cmg's root-level " +
        "copies). " +
        "The catalog is shared and open-write, so always show the dry run first and let the player " +
        "confirm before applying.",
      shape: createShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      writes: true,
      assistant: true,
      run: async (args) => {
        const built = await buildCharacter(toRequest(args));
        const payload: Record<string, unknown> = {
          applied: false,
          ...summarize(built),
        };

        if (args.preview) {
          const preview = await previewOfBuild(built);
          if (preview) Object.assign(payload, preview);
        }

        const writeTo = (args as { writeTo?: string }).writeTo;
        if (options.local && writeTo) {
          const dir = resolve(writeTo);
          await ensureDir(dir);
          const json = `${dir}/${built.name}.json`;
          const png = `${dir}/${built.name}.png`;
          await Deno.writeTextFile(
            json,
            JSON.stringify(built.character, null, 2),
          );
          const body = built.atlas.dataUrl.slice(
            built.atlas.dataUrl.indexOf(",") + 1,
          );
          await Deno.writeFile(
            png,
            Uint8Array.from(atob(body), (c) => c.charCodeAt(0)),
          );
          payload.files = { character: json, atlas: png };
        }

        if (args.apply) {
          if (built.unresolved.length) {
            return fail(
              `Refusing to publish "${built.name}": ${built.unresolved.length} frame name(s) have no ` +
                `pixels behind them — ${
                  built.unresolved.join(", ")
                }. The runtime silently filters ` +
                `unknown frames out, so this would publish a character that renders wrong with no ` +
                `error anywhere. Supply those frames, or drop the fields that name them.`,
            );
          }
          payload.written = await publishCharacter(built);
          payload.applied = true;
        }
        return ok(payload);
      },
    }),

    tool({
      name: "shmupx_place_character",
      title: "Place a character into a level's boss slot",
      description:
        "Replace a cloud level's boss<N> with a character from the catalog, carrying its art across. " +
        "The level is shmupX's copy, shmupX/levels/<key>; an alias ('2019') names its level. " +
        "Only frames the level does not already have are added to its atlas — a level's own art is " +
        "left alone, and the runtime's .gif/.png sibling lookup lets the record find it. " +
        "Returns what would change WITHOUT writing; pass apply=true to write. " +
        "The result's 'replaced' field is the record that was there before — keep it to undo. " +
        "This edits a level somebody else authored, so always show the dry run and get a yes first.",
      shape: placeShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      writes: true,
      assistant: false,
      run: async (args) => ok(await placeCharacter(args)),
    }),

    tool({
      name: "shmupx_list_objects",
      title: "List objects, and resolve a phrase to one",
      description:
        "The catalog's characters as objects a person can point at without an id: each with a " +
        "role read off its shape (boss, enemy, player, projectile, art), an ordinal within that " +
        "role, the stage number its name carries, its animation states, its projectile slots and " +
        "the pixel size of the frame it spawns with. Pass `query` to resolve a phrase — 'the " +
        "second boss', 'boss 2', 'the last boss', 'the pyramid' — to one object: `resolved` is the " +
        "answer, `candidates` the shortlist when it is ambiguous, `explanation` how it was read. " +
        "Ordinals count stages where the names carry them: the second boss is stage 1, and a " +
        "stage nobody has resolves to nothing rather than to a guess. Pass `level` to list a cloud " +
        "level's boss slots instead; each names the catalog character to edit. Start every " +
        "spoken edit here.",
      shape: listObjectsShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async (args) => ok(await listObjects(args)),
    }),

    tool({
      name: "shmupx_get_object",
      title: "Get an object's current state",
      description:
        "One object before editing it: its summary, every frame each state and projectile slot " +
        "draws, the frames the record names that its atlas lacks, and under `dials` what " +
        "shmupx_update_object would move and whether the runtime would notice: for aggression " +
        "the current interval with `intervalRead` (true only for a stock zako — a boss fires on " +
        "its pattern script, a Dezaemon zako on the cart's fire table), each slot's " +
        "speed/damage with `shotsRead`; for silhouette the body frames and their size (parts " +
        "listed apart, they keep their size); for palette the body frames and the colours the " +
        "idle frame is made of, so 'redder' can be judged against what is there. `character` " +
        "is the full record.",
      shape: getObjectShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async ({ id }) => ok(await describeObject(id)),
    }),

    tool({
      name: "shmupx_update_object",
      title: "Edit an object with dials",
      description:
        "Turn semantic dials on an object — aggression (shot speed and damage, plus a zako's " +
        "fire cadence), silhouette (body art resampled bigger or smaller), palette (a recolour that keeps the " +
        "shading) — plus exact `stats` for anything precise, and answer with the field changes, " +
        "the frames transformed, and a preview PNG of the result (`png_base64`) whether or not " +
        "anything was written. Writes NOTHING unless apply=true. Then: numbers-only edits " +
        "write shmupX/characters/<id> alone; pixel edits on a character with its own atlas rewrite " +
        "shmupX/atlases/<id> in place — every frame the atlas held is kept, edited or not, under its " +
        "existing key spelling, conditionally on the ETag it was read with — while an object " +
        "whose art lives in a shared atlas never has that atlas touched: its edited frames go to " +
        "their own shmupX/atlases/<id>. saveAs writes a new character (the name must be free) and " +
        "leaves the original alone. An apply with nothing changed writes nothing. The catalog " +
        "is shared and open-write, so say what will change before applying, and refuse to apply " +
        "while `unresolved` is non-empty. Every dial reports what the runtime would NOT notice " +
        "in `warnings` — a boss's interval, a Dezaemon zako's shot speed — rather than moving it.",
      shape: updateObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      writes: true,
      assistant: true,
      run: async (args) => ok(await updateObject(args)),
    }),

    tool({
      name: "shmupx_preview_object",
      title: "Preview an object as a PNG",
      description:
        "Render one frame of an object as it is in the catalog right now, cut from its own atlas " +
        "at 1:1, and answer in the shape the watch bridge reads: object_id, label, png_base64 " +
        "(bare base64, no data: prefix), width_px, height_px, note. Default is the first idle " +
        "frame — the one the runtime spawns it with; `state` picks another animation, " +
        "'projectile' its main shot, 'backdrop' its stage-end art. This is the picture of what " +
        "is there; shmupx_update_object answers with the picture of what an edit would make. " +
        "For playing it in the real runtime use shmupx_preview_character instead.",
      shape: previewObjectShape,
      annotations: readOnly,
      writes: false,
      assistant: true,
      run: async (args) => ok(await renderObject(args)),
    }),
  ];
}

/** ─── Messages API specs ───────────────────────────────────────────────── */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * A tool as the Messages API takes it. The schema is the zod shape itself,
 * converted — the same descriptions an MCP client reads, so a model reaches
 * the catalog through the same words whichever way it arrived.
 */
export function toolSpec(tool: CatalogTool): ToolSpec {
  const schema = z.toJSONSchema(z.object(tool.shape), {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
  };
}

/** Parse a model's arguments against a tool's shape; throws on a miss. */
export function parseArgs(
  tool: CatalogTool,
  input: unknown,
): Record<string, unknown> {
  return z.object(tool.shape).parse(input ?? {}) as Record<string, unknown>;
}
