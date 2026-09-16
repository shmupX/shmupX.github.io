#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * shmupX character MCP server (stdio).
 *
 * Lets a player build a playable character out of what the catalog already
 * holds — clone an existing one's attributes, swap any frame of any sprite or
 * atlas into its animations, its projectiles or its stage-end backdrop, watch
 * it play, and publish it:
 *
 *   shmupx_list_characters   — characters in the catalog (dezaBoss0 and friends)
 *   shmupx_get_character     — one character's full record, the clone source
 *   shmupx_list_atlases      — the ~400 atlases frames can be taken from
 *   shmupx_list_frames       — frame names inside one atlas
 *   shmupx_list_sprites      — whole-image sprites, usable as a frame each
 *   shmupx_create_character  — clone + swap + pack an atlas; publishes on apply
 *   shmupx_preview_character — serve it into the real runtime and play it
 *   shmupx_place_character  — drop it into a cloud level's boss slot
 *   shmupx_stop_preview      — stop that server
 *
 * It also drives the browser `deno task game:debug` opens — the real runtime,
 * paused on one frame, steppable and pokeable over the DevTools port:
 *
 *   shmupx_debug_status      — scene, frame, pause flag, loop time, held buttons
 *   shmupx_debug_inspect     — what is on screen on this frame
 *   shmupx_debug_step        — advance N frames
 *   shmupx_debug_pause       — freeze it
 *   shmupx_debug_resume      — let it run
 *   shmupx_debug_press       — hold pad buttons for N frames
 *   shmupx_debug_keys        — real key events, for the title and story boxes
 *   shmupx_debug_screenshot  — a 1:1 PNG of the frame it is on
 *   shmupx_debug_eval        — arbitrary JS in that page
 *
 * Registered for this repo via .mcp.json; run manually with:
 *   deno run -A --node-modules-dir=none mcp/server.ts
 *
 * `--node-modules-dir=none` is not optional: the repo sets nodeModulesDir
 * "manual" for Fresh, and npm specifiers under that mode want a node_modules
 * this repo does not have. `none` resolves them from Deno's global cache.
 */

// The SDK's package exports route every nested subpath through one "./*"
// wildcard whose types pattern is "./dist/esm/*.d.ts" — so the runtime
// specifier "server/mcp.js" asks TypeScript for "server/mcp.js.d.ts", which
// does not exist, while the extensionless spelling resolves the types and
// nothing at runtime. Neither half works alone; @ts-types takes each from the
// spelling that has it. The pin is ~1.29.0 for the same reason: 1.30 dropped
// the wildcard altogether and McpServer became unreachable by any subpath.
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="@modelcontextprotocol/sdk/server/stdio"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "@std/path";
import { ensureDir } from "@std/fs";

import { databaseUrl } from "./lib/rtdb.ts";
import { frameMap, loadAtlas } from "./lib/art.ts";
import { listKeys } from "./lib/rtdb.ts";
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
} from "./lib/character.ts";
import {
  buildPreviewLevel,
  readBaseLevel,
  servePreview,
  stopPreview,
} from "./lib/preview.ts";
import { placeCharacter } from "./lib/place.ts";
import {
  debugEval,
  debugInspect,
  debugKeys,
  debugPause,
  debugPress,
  debugResume,
  debugScreenshot,
  debugStatus,
  debugStep,
  DEFAULT_CDP_PORT,
  KEY_NAMES,
  PAD_BUTTON_NAMES,
} from "./lib/debug.ts";

/** ─── result helpers (same contract as spriteX's server) ───────────────── */

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Every tool body runs through this. The errors these tools raise are the
 * caller's to act on — an atlas that has no such frame, art that is not on
 * disk, a name that is not an identifier — so they arrive as the message they
 * were written as rather than as a stack trace the model has to parse.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
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
type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

const frameRef = z.union([
  z.string().describe(
    'A frame of a catalog atlas, written "<atlas>/<frame>" — e.g. "hadouken/hadouken1". ' +
      "Use shmupx_list_frames to get exact frame names.",
  ),
  z.object({
    atlas: z.string(),
    frame: z.string(),
    as: z.string().optional().describe(
      "Rename the frame in the new character's atlas",
    ),
  }),
  z.object({
    sprite: z.string().describe("A whole /sprites entry, used as one frame"),
    as: z.string().optional(),
  }),
  z.object({
    file: z.string().describe(
      "A PNG in the working tree, e.g. dev-fixtures/hadouken0.png. " +
        "dev-fixtures/ is gitignored by design — the file must be placed there locally.",
    ),
    as: z.string().optional(),
  }),
]);

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

const getCharacterShape = {
  name: z.string().describe("Character name, e.g. 'dezaBoss0'"),
};

const listAtlasesShape = {
  match: z.string().optional().describe(
    "Case-insensitive substring filter on the atlas name",
  ),
};

const listFramesShape = {
  atlas: z.string().describe("Atlas name, e.g. 'hadouken'"),
};

const listSpritesShape = {
  match: z.string().optional().describe("Case-insensitive substring filter"),
};

const createShape = {
  ...buildShape,
  apply: z.boolean().optional().describe(
    "Publish to the catalog. Default false — a dry run that returns the record only.",
  ),
  writeTo: z.string().optional().describe(
    "Also write the built record and its atlas PNG to this directory, for inspection.",
  ),
};

const placeShape = {
  level: z.string().describe(
    "Cloud level name, e.g. 'akuma' (a key under /levels)",
  ),
  character: z.string().describe("Character to place, e.g. 'hadoukenBoss'"),
  stage: z.number().int().min(0).max(9).optional().describe(
    "Which boss slot to replace — boss<stage>. Default 0.",
  ),
  apply: z.boolean().optional().describe(
    "Write the change. Default false — a dry run reporting what would change.",
  ),
};

const previewShape = {
  ...buildShape,
  stage: z.number().int().min(0).max(4).optional().describe(
    "Boss slot to take (default 0)",
  ),
  port: z.number().int().optional().describe("Port to serve on (default 8823)"),
  bossRush: z.boolean().optional().describe(
    "Skip the waves and go straight to the boss (default true)",
  ),
};

/**
 * The debug tools all name a DevTools port, so a second debug browser — a
 * different stage, a different level — is reachable without restarting this
 * server. The default is the port `deno task game:debug` opens.
 */
const debugPort = z.number().int().min(1).max(65535).optional().describe(
  `DevTools port of the debug browser (default ${DEFAULT_CDP_PORT})`,
);

const debugShape = { port: debugPort };

const debugStepShape = {
  frames: z.number().int().min(1).max(3600).optional().describe(
    "Frames to advance (default 1). One frame is one Phaser tick, which moves " +
      "game.loop.time by 17ms.",
  ),
  port: debugPort,
};

const debugPressShape = {
  buttons: z.array(z.string()).min(1).describe(
    `Pad buttons to hold, by standard-mapping name: ${
      PAD_BUTTON_NAMES.join(", ")
    }`,
  ),
  frames: z.number().int().min(1).max(3600).optional().describe(
    "How many frames to hold them down for. Default 2: a button that is down " +
      "for a single frame is often missed by the runtime's JustDown checks.",
  ),
  port: debugPort,
};

const debugKeysShape = {
  keys: z.array(z.string()).min(1).describe(
    `Keys to press together and then release: ${KEY_NAMES.join(", ")}`,
  ),
  frames: z.number().int().min(1).max(3600).optional().describe(
    "How many frames to hold them down for (default 2)",
  ),
  port: debugPort,
};

const debugScreenshotShape = {
  path: z.string().describe(
    "Where to write the PNG. A relative path resolves against this server's " +
      "working directory, which is wherever the MCP client started it and not " +
      "necessarily the repo — the result answers with the absolute path written.",
  ),
  port: debugPort,
};

const debugEvalShape = {
  expression: z.string().describe(
    "A JavaScript expression to evaluate in the page. The game is " +
      "window.__PHASER_4_GAME__; the probe — frame queue, pause flag, synthetic " +
      "pad — is window.__dbg.",
  ),
  port: debugPort,
};

function toRequest(args: Record<string, unknown>): CreateRequest {
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
function summarize(built: CreateResult) {
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

/** ─── server ───────────────────────────────────────────────────────────── */

const server = new McpServer({ name: "shmupx-character", version: "1.0.0" });

server.registerTool("shmupx_list_characters", {
  title: "List characters",
  description:
    "List the characters in the shmupX catalog (/characters/*). These are boss-shaped records — " +
    "anim, projectile slots, a dezaemon trailer, hp/score — and any of them can be cloned. " +
    "dezaBoss0..N are the ones a Dezaemon 2 cart import produces.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, () =>
  guard(async () => {
    const names = await listCharacters();
    return ok({
      database: databaseUrl(),
      count: names.length,
      characters: names,
    });
  }));

server.registerTool("shmupx_get_character", {
  title: "Get a character",
  description:
    "Read one character's full record — the exact attributes a clone would inherit, plus the " +
    "frame names it references and the atlas those frames live in.",
  inputSchema: getCharacterShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ name }: Args<typeof getCharacterShape>) =>
  guard(async () => {
    const record = await getCharacter(name);
    return ok({
      name,
      textureKey: record.textureKey ?? null,
      fields: Object.keys(record).sort(),
      referencedFrames: referencedFrames(record).sort(),
      character: record,
    });
  }));

server.registerTool("shmupx_list_atlases", {
  title: "List atlases",
  description:
    "List every atlas in the catalog (/atlases/*). Each one is a sheet of named frames, and any " +
    "frame of any of them can be swapped into a character.",
  inputSchema: listAtlasesShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ match }: Args<typeof listAtlasesShape>) =>
  guard(async () => {
    const all = await listKeys("atlases");
    const names = match
      ? all.filter((n) => n.toLowerCase().includes(match.toLowerCase()))
      : all;
    return ok({ total: all.length, count: names.length, atlases: names });
  }));

server.registerTool("shmupx_list_frames", {
  title: "List frames in an atlas",
  description:
    "List the frame names inside one atlas, with each frame's pixel size. Call this before " +
    "referencing a frame — names are exact and often do not match the atlas name.",
  inputSchema: listFramesShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ atlas }: Args<typeof listFramesShape>) =>
  guard(async () => {
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
      sheet: loaded.json?.meta?.size ?? null,
      count: frames.length,
      frames,
    });
  }));

server.registerTool("shmupx_list_sprites", {
  title: "List sprites",
  description:
    "List the whole-image sprites in the catalog (/sprites/*). Each is a single picture rather " +
    "than a sheet, referenced as {sprite: '<name>'} and packed as one frame.",
  inputSchema: listSpritesShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ match }: Args<typeof listSpritesShape>) =>
  guard(async () => {
    const all = await listKeys("sprites");
    const names = match
      ? all.filter((n) => n.toLowerCase().includes(match.toLowerCase()))
      : all;
    return ok({ total: all.length, count: names.length, sprites: names });
  }));

server.registerTool("shmupx_create_character", {
  title: "Create a character",
  description:
    "Clone a character's attributes, swap frames from any sprite or atlas into its animations, " +
    "projectiles and stage-end backdrop, and pack the result into its own atlas. " +
    "Returns the built record WITHOUT writing anything; pass apply=true to publish it to the " +
    "catalog as characters/<name> + atlases/<name>. " +
    "The catalog is shared and open-write, so always show the dry run first and let the player " +
    "confirm before applying.",
  inputSchema: createShape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, (args: Args<typeof createShape>) =>
  guard(async () => {
    const built = await buildCharacter(toRequest(args));
    const payload: Record<string, unknown> = {
      applied: false,
      ...summarize(built),
    };

    if (args.writeTo) {
      const dir = resolve(args.writeTo);
      await ensureDir(dir);
      const json = `${dir}/${built.name}.json`;
      const png = `${dir}/${built.name}.png`;
      await Deno.writeTextFile(json, JSON.stringify(built.character, null, 2));
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
  }));

server.registerTool("shmupx_preview_character", {
  title: "Preview a character in the game",
  description:
    "Build a character and play it, without publishing anything. Serves the real 2028-ai runtime " +
    "with a level record whose boss is this character, and answers with a URL to open. " +
    "By default the enemy waves are skipped so the boss arrives at once.",
  inputSchema: previewShape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, (args: Args<typeof previewShape>) =>
  guard(async () => {
    const built = await buildCharacter(toRequest(args));
    const stage = (args.stage as number | undefined) ?? 0;
    const level = await buildPreviewLevel(built, {
      base: await readBaseLevel(),
      stage,
    });
    const served = await servePreview(level, {
      port: args.port as number | undefined,
      bossRush: (args.bossRush as boolean | undefined) ?? true,
      stage,
    });
    return ok({ ...served, stage, ...summarize(built) });
  }));

server.registerTool(
  "shmupx_place_character",
  {
    title: "Place a character into a level's boss slot",
    description:
      "Replace a cloud level's boss<N> with a character from the catalog, carrying its art across. " +
      "Only frames the level does not already have are added to its atlas — a level's own art is " +
      "left alone, and the runtime's .gif/.png sibling lookup lets the record find it. " +
      "Returns what would change WITHOUT writing; pass apply=true to write. " +
      "The result's 'replaced' field is the record that was there before — keep it to undo. " +
      "This edits a level somebody else authored, so always show the dry run and get a yes first.",
    inputSchema: placeShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  (args: Args<typeof placeShape>) =>
    guard(async () => ok(await placeCharacter(args))),
);

server.registerTool("shmupx_stop_preview", {
  title: "Stop the preview server",
  description:
    "Shut down the preview server started by shmupx_preview_character.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
}, () => guard(async () => ok({ stopped: await stopPreview() })));

server.registerTool(
  "shmupx_debug_status",
  {
    title: "Debug: where the game is",
    description:
      "Where the debug browser's game is right now: the active scenes, the probe's frame counter, " +
      "whether it is paused, Phaser's loop time and which pad buttons are held. Needs a browser " +
      "from `deno task game:debug`. PhaserGameScene is ALSO active underneath the story, so " +
      '"at the stage" means PhaserGameScene is listed while PhaserAdvScene and PhaserTitleScene ' +
      "are not.",
    inputSchema: debugShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ port }: Args<typeof debugShape>) =>
    guard(async () => ok(await debugStatus({ port }))),
);

server.registerTool(
  "shmupx_debug_inspect",
  {
    title: "Debug: what is on screen",
    description:
      "What the current frame actually holds: active scenes, total display objects, the player's " +
      "position, and a count per visible frame name. Those frame counts are how you tell whether a " +
      "character is drawing — its art is merged into the level's own game_asset texture, so there " +
      "is no texture named after the character to go looking for.",
    inputSchema: debugShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ port }: Args<typeof debugShape>) =>
    guard(async () => ok(await debugInspect({ port }))),
);

server.registerTool(
  "shmupx_debug_step",
  {
    title: "Debug: step frames",
    description:
      "Advance the game exactly N frames (default 1) and report where that left it. Pauses first — " +
      "stepping a running game means nothing — and leaves it paused, so shmupx_debug_resume is what " +
      "hands it back. One step is one Phaser tick and moves game.loop.time by 17ms however long the " +
      "pause lasted: that fixed clock is the point, since a real timestamp after a pause arrives as " +
      "one enormous delta and lurches the whole world forward.",
    inputSchema: debugStepShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  ({ frames, port }: Args<typeof debugStepShape>) =>
    guard(async () => ok(await debugStep({ frames, port }))),
);

server.registerTool(
  "shmupx_debug_pause",
  {
    title: "Debug: pause the game",
    description:
      "Freeze the game on the frame it is showing. The probe owns requestAnimationFrame rather than " +
      "poking Phaser's own TimeStep, so the world stops where it is and the frame you inspect, " +
      "screenshot and step from is that same frame. Pausing an already-paused game is a no-op.",
    inputSchema: debugShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  ({ port }: Args<typeof debugShape>) =>
    guard(async () => ok(await debugPause({ port }))),
);

server.registerTool(
  "shmupx_debug_resume",
  {
    title: "Debug: resume the game",
    description:
      "Let the game run at full speed again. Nothing else releases the pause — step, press and keys " +
      "all pause first — so this is the only way back to real time, and worth calling before " +
      "handing the browser back to a human.",
    inputSchema: debugShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  ({ port }: Args<typeof debugShape>) =>
    guard(async () => ok(await debugResume({ port }))),
);

server.registerTool(
  "shmupx_debug_press",
  {
    title: "Debug: press pad buttons",
    description:
      "Hold pad buttons down, step N frames with them down, then release them — an exact press, " +
      `because the game is paused around it. Names: ${
        PAD_BUTTON_NAMES.join(", ")
      }. ` +
      "One frame is often too short: much of the runtime looks for a JustDown edge and can miss a " +
      "button that was only down for a single tick, which is why frames defaults to 2. The title " +
      "screen and the story boxes do not read the pad at all — use shmupx_debug_keys there. Like " +
      "step, this pauses the game and leaves it paused — and the status it answers with was read " +
      "while the buttons were still down, so they appear in `pad`; they are released before the " +
      "call returns.",
    inputSchema: debugPressShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  (args: Args<typeof debugPressShape>) =>
    guard(async () => ok(await debugPress(args))),
);

server.registerTool(
  "shmupx_debug_keys",
  {
    title: "Debug: send key events",
    description:
      "Send real keyboard events: every named key goes down, the game is stepped N frames, then they " +
      `come up. Known keys: ${
        KEY_NAMES.join(", ")
      }. The title screen and the story boxes read the ` +
      "keyboard and not the pad, so this is the only input they answer. Like step and press, this " +
      "pauses the game and leaves it paused — the N frames are stepped, not waited for. The story " +
      "is a typewriter and a press completes the line it is on rather than skipping it — the " +
      "runtime has no story skip, which is why `deno task game:debug` spends minutes walking to " +
      "the stage instead of jumping there.",
    inputSchema: debugKeysShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  (args: Args<typeof debugKeysShape>) =>
    guard(async () => ok(await debugKeys(args))),
);

server.registerTool(
  "shmupx_debug_screenshot",
  {
    title: "Debug: screenshot the frame",
    description:
      "Capture the debug browser to a PNG and answer with the absolute path and the frame number it " +
      "was taken at. Each capture re-fits the viewport to the game's own 256x480 first — " +
      "Chrome's minimum window is wider than the game and its viewport emulation is per " +
      "DevTools connection — so the pixels are 1:1 rather than a scaled guess, and the result " +
      "carries the PNG's width and height. Paired with shmupx_debug_step this gives one file per frame; the frame number " +
      "in the result is the probe's counter and not a wall clock, so two captures of the same frame " +
      "really are the same picture.",
    inputSchema: debugScreenshotShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  (args: Args<typeof debugScreenshotShape>) =>
    guard(async () => ok(await debugScreenshot(args))),
);

server.registerTool(
  "shmupx_debug_eval",
  {
    title: "Debug: evaluate an expression in the page",
    description:
      "Evaluate a JavaScript expression in the debug browser's page and return its value. This is " +
      "arbitrary JS in the local Chrome the player started with `deno task game:debug`, and it can " +
      "do anything that page can do — so it is for the questions the other debug tools cannot " +
      "answer, not for routine work. The game is window.__PHASER_4_GAME__ and the probe is " +
      "window.__dbg. The value has to survive JSON: a DOM node, a function or a cyclic object comes " +
      "back empty or is refused by the protocol outright, so read the properties you want or wrap " +
      "the expression in JSON.parse(JSON.stringify(x)).",
    inputSchema: debugEvalShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  (args: Args<typeof debugEvalShape>) =>
    guard(async () => ok(await debugEval(args))),
);

/** ─── start ────────────────────────────────────────────────────────────── */

await server.connect(new StdioServerTransport());
console.error(
  `shmupx character MCP server running on stdio (${databaseUrl()})`,
);
