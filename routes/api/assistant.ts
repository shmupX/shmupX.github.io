import { define } from "../../utils.ts";
import { crossSiteGuard } from "../../lib/local-guards.ts";
import {
  type CatalogTool,
  catalogTools,
  guard,
  parseArgs,
} from "../../mcp/lib/tools.ts";
import { listCharacters } from "../../mcp/lib/character.ts";
import {
  type AgentContext,
  ApiError,
  DEFAULT_MODEL,
  runAssistant,
} from "../../lib/assistant/agent.ts";
import {
  admit,
  clientKey,
  type Counter,
  type Limits,
  limitsFromEnv,
  openCounter,
} from "../../lib/assistant/limits.ts";

// /api/assistant — the character assistant behind the editor's DESCRIBE IT box.
//
// A player types "a boss like the stage 1 boss that throws hadoukens" into
// the CHARACTER LIBRARY panel and this route runs the agent loop
// (lib/assistant/agent.ts) over the catalog tools (mcp/lib/tools.ts) on the
// project's own API key — the same tools the MCP server offers a Claude
// Code session, for a player who has neither.
//
//   GET   { available, model, limits, maxPrompt, maxSteps }
//         Whether this build can answer at all: it can when ANTHROPIC_API_KEY
//         is set, on the hosted site or on a desktop install whose owner set
//         one. The editor shows the box only when this says so.
//   POST  { prompt, context?: { level?, character? } }
//         The request. Answers NDJSON, one event per line as the loop makes
//         them — { type: "tool", label } and { type: "tool_result", note } for
//         the progress line, { type: "text" } as the model speaks — ending in
//         { type: "done", text, proposals, steps, usage } or { type: "error",
//         message }. A proposal is a dry run the player may publish: a card
//         with the sprite.
//   POST  { publish: { tool, args } }
//         The PUBLISH button: that one tool call again with apply on. Costs
//         no credits; writes shmupX/characters/<name> and its atlas.
//
// Nothing the model does writes the catalog. The loop forces `apply` off on
// every writing tool; only this route's publish branch turns it on, and
// only for a tool the assistant was offered (shmupx_place_character, which
// edits other people's levels, is not one). The catalog is open-write
// anyway — a script can PUT to it directly — so the gate here is not
// security against a player, it is a guarantee about the model: no sentence
// a player types can make the assistant publish without the player's click.
//
// Spend is bounded three ways (lib/assistant/limits.ts): tool calls per
// request, requests per client per hour, requests per day for everybody.
// The Fetch Metadata gate keeps a cross-site page from spending them.

export const MAX_PROMPT = 400;
const MAX_CONTEXT_FIELD = 80;

export interface AssistantConfig {
  apiKey: string | null;
  model: string;
  maxSteps: number;
  maxTokens: number;
  limits: Limits;
}

/** Read the configuration, through `get` so a test can stand in for the environment. */
export function assistantConfig(
  get: (key: string) => string | undefined = envGet,
): AssistantConfig {
  const int = (key: string, fallback: number, max: number) => {
    const n = Number(get(key));
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  return {
    apiKey: get("ANTHROPIC_API_KEY")?.trim() || null,
    model: get("ASSISTANT_MODEL")?.trim() || DEFAULT_MODEL,
    maxSteps: int("ASSISTANT_MAX_STEPS", 12, 40),
    maxTokens: int("ASSISTANT_MAX_TOKENS", 2048, 8192),
    limits: limitsFromEnv(get),
  };
}

function envGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

export interface AssistantDeps {
  env?: (key: string) => string | undefined;
  fetch?: typeof fetch;
  /** The Messages endpoint, for a test's scripted API. */
  apiUrl?: string;
  tools?: CatalogTool[];
  counter?: Counter | Promise<Counter>;
  /** The catalog's names for the first turn; the real one reads the database. */
  listCatalog?: () => Promise<string[]>;
  now?: () => number;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

type Ctx = { req: Request; info?: Deno.ServeHandlerInfo };

/** The handlers, with their dependencies injectable. */
export function assistantHandlers(deps: AssistantDeps = {}) {
  const env = deps.env ?? envGet;
  const tools = deps.tools ?? catalogTools({ local: false });
  const offered = tools.filter((t) => t.assistant);
  const counterP = Promise.resolve(deps.counter ?? openCounter());
  const listCatalog = deps.listCatalog ?? listCharacters;
  const now = deps.now ?? Date.now;

  const describe = () => {
    const config = assistantConfig(env);
    return {
      available: !!config.apiKey,
      model: config.apiKey ? config.model : undefined,
      limits: config.limits,
      maxPrompt: MAX_PROMPT,
      maxSteps: config.maxSteps,
      tools: offered.map((t) => t.name),
    };
  };

  async function publish(
    body: Record<string, unknown>,
    client: string,
    config: AssistantConfig,
  ): Promise<Response> {
    const request = body.publish as Record<string, unknown>;
    const tool = typeof request.tool === "string"
      ? offered.find((t) => t.name === request.tool)
      : undefined;
    if (!tool || !tool.writes) {
      return json(
        { ok: false, error: "Not a tool the assistant publishes." },
        400,
      );
    }
    const admission = await admit(
      await counterP,
      config.limits,
      "publish",
      client,
      now(),
    );
    if (!admission.ok) {
      return json({ ok: false, error: admission.reason }, 429, {
        "retry-after": String(admission.retryAfterSeconds),
      });
    }
    let args: Record<string, unknown>;
    try {
      args = parseArgs(tool, request.args);
    } catch (err) {
      return json({
        ok: false,
        error: `Bad arguments: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }, 400);
    }
    args.apply = true;
    delete args.preview;
    const result = await guard(() => tool.run(args));
    if (result.isError) {
      return json(
        { ok: false, error: result.content[0]?.text ?? "failed" },
        422,
      );
    }
    const payload = result.structuredContent ?? {};
    const { png_base64: _png, character: _record, provenance: _prov, ...rest } =
      payload;
    return json({ ok: true, tool: tool.name, ...rest });
  }

  function ask(
    body: Record<string, unknown>,
    client: string,
    config: AssistantConfig,
    signal: AbortSignal,
  ): Promise<Response> {
    return (async () => {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return json({ ok: false, error: "Say what to build." }, 400);
      if (prompt.length > MAX_PROMPT) {
        return json({
          ok: false,
          error: `Keep it under ${MAX_PROMPT} characters.`,
        }, 400);
      }
      const raw = (body.context ?? {}) as Record<string, unknown>;
      const field = (v: unknown) =>
        typeof v === "string" && v.trim()
          ? v.trim().slice(0, MAX_CONTEXT_FIELD)
          : undefined;
      const context: AgentContext = {
        level: field(raw.level),
        character: field(raw.character),
      };

      const admission = await admit(
        await counterP,
        config.limits,
        "ask",
        client,
        now(),
      );
      if (!admission.ok) {
        return json({ ok: false, error: admission.reason }, 429, {
          "retry-after": String(admission.retryAfterSeconds),
        });
      }

      // The catalog's names go in the first turn so the model need not
      // spend a tool call asking; a database that will not answer right now
      // just means it asks.
      context.catalog = await listCatalog().catch(() => undefined);

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          try {
            const outcome = await runAssistant(prompt, context, {
              apiKey: config.apiKey!,
              model: config.model,
              url: deps.apiUrl,
              fetch: deps.fetch,
              tools: offered,
              maxSteps: config.maxSteps,
              maxTokens: config.maxTokens,
              onEvent: send,
              signal,
            });
            send({ type: "done", ...outcome });
          } catch (err) {
            const message = err instanceof ApiError
              ? `The model could not be reached (HTTP ${err.status}).`
              : err instanceof Error && err.name === "AbortError"
              ? "Stopped."
              : "Something went wrong on the way to the model.";
            console.error(
              `[assistant] ${client}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            try {
              send({ type: "error", message });
            } catch {
              // the player went away mid-stream
            }
          } finally {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    })();
  }

  return {
    GET(_ctx: Ctx) {
      return json(describe());
    },

    async POST(ctx: Ctx) {
      const denied = crossSiteGuard(ctx.req);
      if (denied) return denied;
      const config = assistantConfig(env);
      if (!config.apiKey) {
        return json({
          ok: false,
          error: "The assistant is not available on this build.",
        }, 503);
      }
      let body: Record<string, unknown>;
      try {
        body = await ctx.req.json();
        if (!body || typeof body !== "object") throw new Error("not an object");
      } catch {
        return json({ ok: false, error: "Send JSON." }, 400);
      }
      const client = clientKey(ctx.req.headers, ctx.info?.remoteAddr);
      if (body.publish && typeof body.publish === "object") {
        return publish(body, client, config);
      }
      return ask(body, client, config, ctx.req.signal);
    },
  };
}

const handlers = assistantHandlers();

export const handler = define.handlers({
  GET: (ctx) => handlers.GET(ctx as unknown as Ctx),
  POST: (ctx) =>
    handlers.POST(
      {
        req: ctx.req,
        info: (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info,
      },
    ),
});
