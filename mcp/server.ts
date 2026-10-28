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
 *   shmupx_list_atlases      — the ~430 atlases frames can be taken from
 *   shmupx_list_frames       — frame names inside one atlas
 *   shmupx_list_sprites      — whole-image sprites, usable as a frame each
 *   shmupx_create_character  — clone + swap + pack an atlas; publishes on apply
 *   shmupx_preview_character — serve it into the real runtime and play it
 *   shmupx_place_character  — drop it into a cloud level's boss slot
 *   shmupx_stop_preview      — stop that server
 *
 * Four more address those same records the way a person speaks about them,
 * for a voice session that cannot dictate an id — "make the second boss
 * bulkier" — and answer with the sprite as a PNG rather than a URL:
 *
 *   shmupx_list_objects      — every object with a role and an ordinal; a phrase resolves
 *   shmupx_get_object        — one object's state and what each dial would move
 *   shmupx_update_object     — aggression / silhouette / palette dials; writes on apply
 *   shmupx_preview_object    — one frame as bare base64 PNG (the watch's shape)
 *
 * The catalog tools — everything above but the preview server — are one
 * table in mcp/lib/tools.ts, shared with the hosted assistant
 * (routes/api/assistant.ts) that offers the same tools to a player typing
 * into the editor. This file registers that table and adds what only makes
 * sense on the player's own machine: the preview server, and the debug
 * tools below.
 *
 * The catalog is shmupX's own subtree of the database it shares with cmg:
 * shmupX/characters, shmupX/atlases, shmupX/levels (lib/rtdb-root.ts,
 * mcp/lib/rtdb.ts). Every write lands there and nowhere else. Source art is
 * the one exception on the read side: a frame can be borrowed from ANY atlas,
 * so an atlas shmupX lacks is read from the root-level atlases/<name>, cmg's
 * full catalog (and spriteX's), without ever being written back there.
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

import { catalogUrl } from "./lib/rtdb.ts";
import { buildCharacter } from "./lib/character.ts";
import {
  buildPreviewLevel,
  readBaseLevel,
  servePreview,
  stopPreview,
} from "./lib/preview.ts";
import {
  type Args,
  catalogTools,
  guard,
  ok,
  shapesFor,
  summarize,
  toRequest,
} from "./lib/tools.ts";
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

/** ─── shapes of the tools only this process has ────────────────────────── */

// This server runs in the checkout, so a frame may be a file under
// dev-fixtures/ and a build may be written out for inspection.
const LOCAL = { local: true } as const;

const previewShape = {
  ...shapesFor(LOCAL).buildShape,
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

/** ─── server ───────────────────────────────────────────────────────────── */

const server = new McpServer({ name: "shmupx-character", version: "1.0.0" });

// The catalog tools, from the shared table.
for (const tool of catalogTools(LOCAL)) {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.shape,
    annotations: tool.annotations,
  }, (args: Record<string, unknown>) => guard(() => tool.run(args)));
}

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
  `shmupx character MCP server running on stdio (${catalogUrl()})`,
);
