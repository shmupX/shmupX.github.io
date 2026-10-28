// The assistant's agent loop: one request from the player, the catalog
// tools, the Messages API, and what comes back.
//
// This is the watch bridge's loop (tools/watch-bridge/bridge.mjs) with the
// two things that tied it to one desk taken out. There the agent was
// `claude -p` with the MCP server attached — a Claude Code subscription on
// one desktop, running only while that desktop was on. Here the agent is
// the Messages API called directly from the route, billed to the project's
// API key, and the tools are the same table the MCP server registers
// (mcp/lib/tools.ts) called in-process, so a player at codemonkey.games with
// no MCP client of their own gets the same "a boss like the stage 1 boss that
// throws hadoukens" as a Claude Code session in this checkout does.
//
// Two rules the loop enforces rather than asks the model to follow:
//
//   - It never writes. Every call to a tool that can write the catalog has
//     `apply` forced off before it runs, whatever the model passed, and the
//     call is kept as a PROPOSAL — the arguments, the dry run's summary and
//     the preview PNG — for the editor to show as a card with a PUBLISH
//     button. Publishing is the player's click (routes/api/assistant.ts),
//     which re-runs that one call with apply on. A model that is told "do
//     not publish" will mostly not publish; a loop that cannot publish never
//     does.
//   - It stops. `maxSteps` tool calls, then one last turn with tools off so
//     the model answers with what it has, then the loop ends whatever the
//     model wanted next. A request is a bounded spend of the project's
//     credits, not a session.
//
// The API client is a fetch, not the SDK: the request is small, the response
// is one JSON object, and a function that takes `fetch` is a function a test
// can hand a scripted API to.
//
// A request may also carry pictures (mcp/lib/upload.ts has decoded and
// analysed them by the time they arrive here). The model is shown each one as
// an image block at the head of the first user message, under a one-line
// label that names it the way the analysis does, with the analysis — the
// regions on the background, their size, whether they are enlarged pixel art
// or ink on paper — in the text after them, and every tool call runs with the
// same pictures in its context so an `{upload: n}` frame ref can be cut.
// They go in the first USER message and not the system prompt: the system
// prompt and the tool table are the cached prefix every player's request
// shares, and one player's pictures would make it nobody else's. Within one
// request they are cached all the same, behind the automatic breakpoint that
// follows the conversation's tail (callMessages).

import {
  type CatalogTool,
  guard,
  parseArgs,
  type ToolContext,
  type ToolResult,
  toolSpec,
} from "../../mcp/lib/tools.ts";
import { describeUploads, type UploadedImage } from "../../mcp/lib/upload.ts";

/** ─── the Messages API, as much of it as this needs ────────────────────── */

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
};
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock)[];
  is_error?: boolean;
};
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
type Message = { role: "user" | "assistant"; content: ContentBlock[] };

interface ApiResponse {
  content: (TextBlock | ToolUseBlock)[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage?: Partial<Usage>;
}

export interface ApiOptions {
  apiKey: string;
  model: string;
  /**
   * Sent as `anthropic-workspace-id` when set. A key that is not scoped to a
   * workspace is refused with a 400 unless every request names one; a
   * workspace-scoped key needs nothing here.
   */
  workspaceId?: string;
  /** The Messages endpoint; tests point it elsewhere. */
  url?: string;
  fetch?: typeof fetch;
  /** Per call. The whole request is bounded by the route, not here. */
  timeoutMs?: number;
}

/** The error the API answered with, kept apart from everything else that can go wrong. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 529]);

/**
 * One Messages API call, and a 429 or a 5xx is retried once after a short
 * wait.
 *
 * Three cache breakpoints, all the default five minutes. The last tool and
 * the system prompt are marked by hand: they are the same ~5K tokens on
 * every turn of every player's request, and a cache read is a tenth of the
 * price of sending them again, so they get a read point of their own that
 * nothing later in the conversation can move. The third is the request's
 * top-level `cache_control` — the API's automatic breakpoint, which it puts
 * on the last block of `messages` and walks forward as the conversation
 * grows. That one is for this request alone: the pictures lead the first
 * message (a few thousand tokens apiece) and every dry run adds a PNG or two,
 * and without it each turn would send all of them again at full price. The
 * history only ever grows at the end, so each turn reads the last one's
 * prefix and writes just what it added. (The capped last turn changes
 * `tool_choice`, which invalidates the cached conversation — not the tools or
 * the system prompt — so that one turn writes it again, once a request.)
 * Three of the four breakpoints a request may carry.
 */
export async function callMessages(
  body: {
    system: string;
    tools: ReturnType<typeof toolSpec>[];
    messages: Message[];
    max_tokens: number;
    tool_choice?: { type: "auto" | "none" | "any" };
  },
  options: ApiOptions,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const doFetch = options.fetch ?? fetch;
  const tools = body.tools.map((tool, i) =>
    i === body.tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  );
  const payload = {
    model: options.model,
    max_tokens: body.max_tokens,
    cache_control: { type: "ephemeral" },
    system: [{
      type: "text",
      text: body.system,
      cache_control: { type: "ephemeral" },
    }],
    tools,
    messages: body.messages,
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
  };
  const init = (): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": API_VERSION,
      ...(options.workspaceId
        ? { "anthropic-workspace-id": options.workspaceId }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: signal
      ? AbortSignal.any([
        signal,
        AbortSignal.timeout(options.timeoutMs ?? 90_000),
      ])
      : AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });

  for (let attempt = 0;; attempt++) {
    const res = await doFetch(options.url ?? API_URL, init());
    if (res.ok) return await res.json() as ApiResponse;
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      message = parsed.error?.message ?? text;
    } catch {
      // not JSON: the body is the message
    }
    if (attempt === 0 && RETRY_STATUSES.has(res.status) && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    throw new ApiError(res.status, message || `HTTP ${res.status}`);
  }
}

/** ─── what the loop reports ────────────────────────────────────────────── */

export type AgentEvent =
  | { type: "text"; text: string }
  | {
    type: "tool";
    name: string;
    input: Record<string, unknown>;
    label: string;
  }
  | { type: "tool_result"; name: string; ok: boolean; note: string };

/** A dry run the player may publish: the call to make again with apply on. */
export interface Proposal {
  tool: string;
  /** The arguments as the model made them, less `apply` and `preview`. */
  args: Record<string, unknown>;
  /** The character the publish would write. */
  name: string;
  /** The dry run's answer, less the PNGs and the full record. */
  summary: Record<string, unknown>;
  png_base64?: string;
  width_px?: number;
  height_px?: number;
  /** The first frame of its main projectile, for the card's SHOT box. */
  projectile?: { png_base64: string; width_px?: number; height_px?: number };
}

export interface AgentOutcome {
  /** The model's final answer to the player. */
  text: string;
  proposals: Proposal[];
  /** Tool calls made. */
  steps: number;
  /** API calls made. */
  turns: number;
  usage: Usage;
  stop: "end_turn" | "steps" | "max_tokens" | "aborted";
}

export interface AgentContext {
  /** The game open in the editor, if it has a name. */
  level?: string;
  /** The character whose sheet the player came from, if any. */
  character?: string;
  /** The catalog's names right now, so the first turn need not ask. */
  catalog?: string[];
}

export interface AgentOptions extends ApiOptions {
  tools: CatalogTool[];
  /** Tool calls allowed in one request. */
  maxSteps: number;
  /** Output tokens per turn. */
  maxTokens?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * Pictures the player attached, decoded and analysed. Shown to the model in
   * the first message and handed to every tool call as its context.
   */
  uploads?: UploadedImage[];
}

/** ─── the prompt ───────────────────────────────────────────────────────── */

export const SYSTEM_PROMPT =
  `You are the character assistant inside the shmupX level editor at codemonkey.games. A player typed one request into the CHARACTER LIBRARY panel. Build or edit a character with the tools, then answer the player in one to three short plain sentences.

WHAT A CHARACTER IS
A character is a boss-shaped record in the shared catalog: animation states (idle is what it spawns with, plus attack and others), four projectile slots, hp/score, a Dezaemon trailer on cart imports. dezaBoss0, dezaBoss1... are the bosses a Dezaemon 2 cart import produced, one per stage — "the stage 1 boss" and "the second boss" are dezaBoss1. Any catalog character can be cloned (shmupx_create_character with cloneFrom) and have frames swapped into its anim states, its projectiles or its stage-end backdrop; the catalog list is in the request, and a clone source must be on it.

ART
Frames come from atlases (about 430 sheets) and sprites (whole pictures). A frame is written "<atlas>/<frame>". Find atlases with shmupx_list_atlases and a match word. ALWAYS call shmupx_list_frames on an atlas before naming a frame of it and copy the name exactly: names rarely match the atlas (the hadouken atlas's frames are atlas_s0 and hadouken1; bg-great-hall's only frame is atlas_s0). A frame you did not list is a frame that comes back in unresolved.
The shot a boss fires is mainProjectile — never the unsuffixed bulletData, which the runtime does not read. anim replaces whole states ({idle: [...], attack: [...]}); states not named keep the clone's frames. Backdrop art (bg-* atlases) goes in stageBgEnd. Plain numbers (hp, score) go in stats.

PICTURES
The player may attach pictures; the request lists each with its regions (separate subjects on the background) and what they look like. Use one as a frame by writing {upload: 0, region: 1} wherever a frame goes — anim, mainProjectile, projectiles, stageBgEnd. Pixel art that was enlarged comes back to its own pixels on its own (pixelScale auto); size anything else with maxSize: a boss is 48–128 px, a shot 8–48. The game is played over a dark starfield, so give monochrome dark-on-light art (text, line art, a scan) a light ink such as "#ffffff". Look at the dry run's PNGs (the body, and the main projectile when there is one) and fix what is wrong. When the player says "left" or "right", the regions are listed left to right. A picture needs no atlas listing: clone the source, then one dry run with the upload refs. When a picture is the body, put it in every anim state the clone has (its record lists them — shootA, syngoku and the like, not only idle), or the clone's own art shows whenever the boss changes state.

EDITING BY PHRASE
"Make the second boss redder", "the pyramid, bulkier", "boss 2 should hit harder": resolve the phrase with shmupx_list_objects first and use resolved.id. If it answers candidates instead of resolved, ask the player which one in one sentence and stop. Then shmupx_update_object: palette for colour (toward "red", hue, saturation, lightness), silhouette for size, aggression for shots, stats for exact numbers. Unless the player says to change the original, pass saveAs with a new name so the shared original stays as it was. The result's warnings say what the runtime would not notice — say so.

NAMES
Use the name the player gave; otherwise choose a short camelCase name that is not in the catalog (hadoukenBoss, redPyramid). Names and art appear in a public catalog that other players browse: keep names tame, and decline hateful, sexual or harassing content in one sentence.

HOW PUBLISHING WORKS HERE
You cannot publish. Every shmupx_create_character and shmupx_update_object call you make is a dry run; the player sees your last dry run as a card with its sprite and a PUBLISH button, and publishing is their click. So: do not ask for confirmation, do not say you published or saved anything, and make sure your last dry run has an empty unresolved list — if it is not empty, list the frames you guessed and run it again with the real names. Each dry run answers with a PNG of the result (and of its main projectile, when it has one); look at them and fix what is wrong.

BUDGET
You have a small number of tool calls (the request says how many). A typical build is: get the clone source (or get_object for an edit), list atlases with a match word, list frames of the one or two atlases you will use, one dry run. Do not list every atlas without a match word, do not list sprites unless the player wants a whole picture, do not re-read what you already read.

ANSWERING
Plain text, no markdown, no JSON, no tool names. Say what you built or changed and what it is made of, and anything the player should know (a warning, a frame you substituted, a thing you could not find). If the request is not about characters, say in one sentence what this box can do.`;

/**
 * The request, with what the editor knows around it — and, when the player
 * attached pictures, what upload.ts made of each: its size, its background,
 * and the regions a frame ref can name. The pictures themselves are image
 * blocks ahead of this text, in the same order, each under a label that
 * begins as its line here does.
 */
export function userMessage(
  prompt: string,
  context: AgentContext,
  maxSteps: number,
  uploads: UploadedImage[] = [],
): string {
  const lines = [`Request: ${prompt.trim()}`];
  if (uploads.length) {
    lines.push(
      `Pictures attached (${uploads.length}), shown above under the same names:`,
      describeUploads(uploads),
    );
  }
  if (context.level) {
    lines.push(`Open in the editor: the game "${context.level}".`);
  }
  if (context.character) {
    lines.push(
      `The player opened this from the character sheet of "${context.character}" — that is the one they mean unless they name another.`,
    );
  }
  if (context.catalog?.length) {
    lines.push(
      `Catalog right now (${context.catalog.length}): ${
        context.catalog.join(", ")
      }`,
    );
  } else if (context.catalog) {
    lines.push("Catalog right now: empty.");
  }
  lines.push(`Tool calls available: ${maxSteps}.`);
  return lines.join("\n");
}

/** ─── labels for the editor's progress line ────────────────────────────── */

const str = (v: unknown, n = 40) => typeof v === "string" ? v.slice(0, n) : "";

/** What a call is doing, in the editor's own voice (it uppercases). */
export function describeCall(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "shmupx_list_characters":
      return "listing the catalog";
    case "shmupx_get_character":
      return `reading ${str(args.name)}`;
    case "shmupx_list_atlases":
      return args.match
        ? `looking for ${str(args.match)} atlases`
        : "listing every atlas";
    case "shmupx_list_frames":
      return `listing frames in ${str(args.atlas)}`;
    case "shmupx_list_sprites":
      return args.match
        ? `looking for ${str(args.match)} sprites`
        : "listing sprites";
    case "shmupx_create_character":
      return `building ${str(args.name)}` +
        (args.cloneFrom ? ` from ${str(args.cloneFrom)}` : "");
    case "shmupx_list_objects":
      return args.query ? `finding "${str(args.query)}"` : "listing objects";
    case "shmupx_get_object":
      return `reading ${str(args.id)}`;
    case "shmupx_update_object":
      return `editing ${str(args.id)}` +
        (args.saveAs ? ` as ${str(args.saveAs)}` : "");
    case "shmupx_preview_object":
      return `drawing ${str(args.id)}`;
    default:
      return name.replace(/^shmupx_/, "").replaceAll("_", " ");
  }
}

/** What a call found, for the same line. */
export function describeResult(name: string, result: ToolResult): string {
  if (result.isError) {
    return result.content[0]?.text.split("\n")[0].slice(0, 120) ?? "failed";
  }
  const s = result.structuredContent ?? {};
  const n = (v: unknown) =>
    typeof v === "number" ? v : Array.isArray(v) ? v.length : 0;
  switch (name) {
    case "shmupx_list_characters":
      return `${n(s.count)} characters`;
    case "shmupx_get_character":
      return `${n(s.referencedFrames)} frames referenced`;
    case "shmupx_get_object":
      return typeof s.role === "string" ? `a ${s.role}` : "read";
    case "shmupx_list_atlases":
      return `${n(s.count)} atlases`;
    case "shmupx_list_frames":
      return `${n(s.count)} frames`;
    case "shmupx_list_sprites":
      return `${n(s.count)} sprites`;
    case "shmupx_create_character": {
      const atlas = s.atlas as { frameCount?: number } | undefined;
      const unresolved = n(s.unresolved);
      return `${atlas?.frameCount ?? 0} frames packed` +
        (unresolved ? ` · ${unresolved} unresolved` : "");
    }
    case "shmupx_update_object":
      return `${n(s.changes)} changes`;
    case "shmupx_list_objects": {
      const resolved = s.resolved as { id?: string } | null | undefined;
      return resolved?.id
        ? `→ ${resolved.id}`
        : `${n(s.candidates)} candidates`;
    }
    default:
      return "ok";
  }
}

/** ─── dispatch ─────────────────────────────────────────────────────────── */

/** A proposal's key: two dry runs of the same character keep the later one. */
function proposalName(tool: string, args: Record<string, unknown>): string {
  if (tool === "shmupx_create_character") return String(args.name ?? "");
  return String(args.saveAs ?? args.id ?? "");
}

const SUMMARY_LIMIT = 24_000;

/** The dry run's payload for the card: no PNGs, no full record, bounded. */
function summaryOf(payload: Record<string, unknown>): Record<string, unknown> {
  const { png_base64: _png, character: _record, projectile, ...rest } = payload;
  let out: Record<string, unknown> = rest;
  // The projectile's frame name and size are worth a line on the card; its
  // base64 already travels as the proposal's own `projectile`.
  if (projectile && typeof projectile === "object") {
    const { png_base64: _shot, ...shot } = projectile as Record<
      string,
      unknown
    >;
    out = { ...out, projectile: shot };
  }
  if (JSON.stringify(out).length > SUMMARY_LIMIT) {
    const { provenance: _prov, ...smaller } = out;
    out = smaller;
  }
  return out;
}

interface Dispatched {
  block: ToolResultBlock;
  proposal?: Proposal;
}

/** A projectile preview the payload carries, if it carries one. */
function projectileOf(
  payload: Record<string, unknown> | undefined,
): { png_base64: string; width_px?: number; height_px?: number } | null {
  const shot = payload?.projectile as Record<string, unknown> | undefined;
  if (!shot || typeof shot !== "object") return null;
  if (typeof shot.png_base64 !== "string") return null;
  return {
    png_base64: shot.png_base64,
    width_px: shot.width_px as number | undefined,
    height_px: shot.height_px as number | undefined,
  };
}

const pngBlock = (data: string): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

/**
 * Run one tool call the model asked for. Arguments are checked against the
 * tool's own shape — a miss is an error the model reads, not an exception —
 * and a writing tool runs as a dry run however it was asked. A result that
 * carries a PNG hands it to the model as an image block beside the JSON (the
 * JSON gets a note where the base64 was), so the model sees the sprite it
 * just made rather than a wall of base64; a build's main projectile, when the
 * preview has one, follows as a second image the same way.
 *
 * `ctx` goes to the tool as it is: the pictures the request carried, which a
 * frame ref names by index and the tool cuts from.
 */
export async function dispatch(
  tools: Map<string, CatalogTool>,
  use: ToolUseBlock,
  onEvent: (event: AgentEvent) => void,
  ctx?: ToolContext,
): Promise<Dispatched> {
  const tool = tools.get(use.name);
  if (!tool) {
    return {
      block: {
        type: "tool_result",
        tool_use_id: use.id,
        content: `No such tool: ${use.name}.`,
        is_error: true,
      },
    };
  }
  let args: Record<string, unknown>;
  try {
    args = parseArgs(tool, use.input);
  } catch (err) {
    return {
      block: {
        type: "tool_result",
        tool_use_id: use.id,
        content: `Bad arguments for ${use.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        is_error: true,
      },
    };
  }
  if (tool.writes) {
    args.apply = false;
    if (tool.name === "shmupx_create_character") args.preview = true;
  }
  onEvent({
    type: "tool",
    name: tool.name,
    input: args,
    label: describeCall(tool.name, args),
  });

  const result = await guard(() => tool.run(args, ctx));
  onEvent({
    type: "tool_result",
    name: tool.name,
    ok: !result.isError,
    note: describeResult(tool.name, result),
  });

  const payload = result.structuredContent;
  const png = payload && typeof payload.png_base64 === "string"
    ? payload.png_base64
    : null;
  const shot = projectileOf(payload);
  let content: ToolResultBlock["content"];
  if (png && payload) {
    const attached = "(attached as an image)";
    const text = JSON.stringify(
      {
        ...payload,
        png_base64: attached,
        ...(shot
          ? {
            projectile: {
              ...(payload.projectile as Record<string, unknown>),
              png_base64: attached,
            },
          }
          : {}),
      },
      null,
      2,
    );
    // Body first, then the shot: the order the JSON names them in.
    content = [
      { type: "text", text },
      pngBlock(png),
      ...(shot ? [pngBlock(shot.png_base64)] : []),
    ];
  } else {
    content = result.content.map((c) => c.text).join("\n");
  }

  let proposal: Proposal | undefined;
  if (tool.writes && !result.isError && payload) {
    const { apply: _apply, preview: _preview, ...kept } = args;
    proposal = {
      tool: tool.name,
      args: kept,
      name: proposalName(tool.name, args),
      summary: summaryOf(payload),
      ...(png
        ? {
          png_base64: png,
          width_px: payload.width_px as number | undefined,
          height_px: payload.height_px as number | undefined,
        }
        : {}),
      ...(shot ? { projectile: shot } : {}),
    };
  }

  return {
    block: {
      type: "tool_result",
      tool_use_id: use.id,
      content,
      ...(result.isError ? { is_error: true } : {}),
    },
    proposal,
  };
}

/** ─── the loop ─────────────────────────────────────────────────────────── */

const zeroUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

function addUsage(total: Usage, part: Partial<Usage> | undefined): void {
  if (!part) return;
  for (const key of Object.keys(total) as (keyof Usage)[]) {
    total[key] += part[key] ?? 0;
  }
}

export async function runAssistant(
  prompt: string,
  context: AgentContext,
  options: AgentOptions,
): Promise<AgentOutcome> {
  const onEvent = options.onEvent ?? (() => {});
  const offered = options.tools.filter((t) => t.assistant);
  const byName = new Map(offered.map((t) => [t.name, t]));
  const specs = offered.map(toolSpec);
  const maxTokens = options.maxTokens ?? 2048;
  const uploads = options.uploads ?? [];
  const ctx: ToolContext = { uploads: options.uploads };

  // The pictures lead and the text that describes them follows — the order
  // the Messages API documents for an image and the question about it, and
  // the order userMessage's "shown above" counts in. Each picture comes
  // under a short text label, `Picture 0 "ryuda":`, the way the vision guide
  // introduces several images in one turn: with two or three of them, "the
  // second one" is a guess, while the label is the very name the analysis
  // lines below and every `{upload: n}` ref use. The base64 is the PNG as the
  // player's editor sent it, so the model sees exactly those pixels.
  const messages: Message[] = [{
    role: "user",
    content: [
      ...uploads.flatMap((upload): (TextBlock | ImageBlock)[] => [
        { type: "text", text: `Picture ${upload.index} "${upload.name}":` },
        pngBlock(upload.png_base64),
      ]),
      {
        type: "text",
        text: userMessage(prompt, context, options.maxSteps, uploads),
      },
    ],
  }];
  const proposals = new Map<string, Proposal>();
  const usage = zeroUsage();
  let steps = 0;
  let turns = 0;
  let finalText = "";
  let stop: AgentOutcome["stop"] = "end_turn";
  // One more API call is allowed after the step cap, with tools off, so the
  // model can tell the player what it has.
  let capped = false;

  while (true) {
    if (options.signal?.aborted) {
      stop = "aborted";
      break;
    }
    const res = await callMessages(
      {
        system: SYSTEM_PROMPT,
        tools: specs,
        messages,
        max_tokens: maxTokens,
        ...(capped ? { tool_choice: { type: "none" as const } } : {}),
      },
      options,
      options.signal,
    );
    turns++;
    addUsage(usage, res.usage);

    const texts = res.content.filter((b): b is TextBlock => b.type === "text");
    const uses = res.content.filter((b): b is ToolUseBlock =>
      b.type === "tool_use"
    );
    if (texts.length) {
      finalText = texts.map((t) => t.text).join("\n").trim();
      onEvent({ type: "text", text: finalText });
    }

    if (res.stop_reason !== "tool_use" || !uses.length || capped) {
      if (res.stop_reason === "max_tokens") stop = "max_tokens";
      else if (capped) stop = "steps";
      break;
    }

    messages.push({ role: "assistant", content: res.content });
    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (steps >= options.maxSteps) {
        capped = true;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content:
            "Tool call limit reached for this request. Answer the player with what you have.",
          is_error: true,
        });
        continue;
      }
      steps++;
      const done = await dispatch(byName, use, onEvent, ctx);
      results.push(done.block);
      if (done.proposal) {
        proposals.set(
          `${done.proposal.tool}:${done.proposal.name}`,
          done.proposal,
        );
      }
    }
    if (steps >= options.maxSteps) capped = true;
    messages.push({ role: "user", content: results });
  }

  return {
    text: finalText,
    proposals: [...proposals.values()],
    steps,
    turns,
    usage,
    stop,
  };
}
