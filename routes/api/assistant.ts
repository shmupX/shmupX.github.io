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
import {
  type CheckedUpload,
  checkUploads,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIDE,
  MAX_UPLOADS,
  openUploads,
  type UploadedImage,
  UploadError,
} from "../../mcp/lib/upload.ts";

// /api/assistant — the character assistant behind the editor's DESCRIBE IT box.
//
// A player types "a boss like the stage 1 boss that throws hadoukens" into
// the CHARACTER LIBRARY panel and this route runs the agent loop
// (lib/assistant/agent.ts) over the catalog tools (mcp/lib/tools.ts) on the
// project's own API key — the same tools the MCP server offers a Claude
// Code session, for a player who has neither.
//
//   GET   { available, model, limits, maxPrompt, maxSteps, tools,
//           maxUploads, maxUploadBytes, maxUploadSide }
//         Whether this build can answer at all: it can when ANTHROPIC_API_KEY
//         is set, on the hosted site or on a desktop install whose owner set
//         one. The editor shows the box only when this says so, and sizes the
//         pictures it lets a player attach by the last three.
//   POST  { prompt, context?: { level?, character? },
//           uploads?: [{ name?, png }] }
//         The request. `uploads` are pictures the player attached, each the
//         bare base64 of a PNG (a data: prefix is stripped) — the editor
//         turns whatever was picked into PNG on a canvas first, so PNG is all
//         this decodes. With pictures attached the prompt may be empty. A
//         picture that is plainly not one, or is too big, is a 400 before
//         anything is counted against the player's hour; one whose header
//         passes and whose pixels then do not is a 400 after, because
//         decoding is the expensive half and only an admitted request gets
//         it. Answers NDJSON, one event per
//         line as the loop makes them — { type: "tool", label } and
//         { type: "tool_result", note } for the progress line, { type: "text" }
//         as the model speaks — ending in { type: "done", text, proposals,
//         steps, usage } or { type: "error", message }. A proposal is a dry
//         run the player may publish: a card with the sprite, and with its
//         main projectile when the preview has one.
//   POST  { publish: { tool, args }, uploads?: [...] }
//         The PUBLISH button: that one tool call again with apply on. Costs
//         no credits; writes shmupX/characters/<name> and its atlas. A
//         proposal whose frames came out of a picture sends the same
//         pictures again — this route keeps nothing between requests, so the
//         pixels a ref like {upload: 0, region: 1} names have to come back
//         with it, and are decoded and analysed exactly as the ask's were.
//
// A body over MAX_BODY_BYTES is refused by its content-length before it is
// read, with a 413.
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

/**
 * The largest body this reads. Three pictures at MAX_UPLOAD_BYTES are 12 MB
 * of PNG and 16 MB once base64'd, so a decimal 16 MB would refuse the very
 * request the limits allow; the binary 16 MiB leaves ~750 KB for the JSON
 * around them.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** What an empty prompt means when pictures came with it. */
export const PICTURE_PROMPT = "Make a character from the attached picture.";

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

/**
 * The 400 that says what is wrong with a request's pictures. An
 * UploadError's message is written for the player and goes back as it is.
 * Anything else decodePng could throw on a malformed file is still the
 * file's fault rather than this server's, so it is a 400 too — with a
 * message that does not leak a stack frame into the editor.
 */
function pictureRefused(err: unknown, client: string): Response {
  if (err instanceof UploadError) {
    return json({ ok: false, error: err.message }, 400);
  }
  console.error(
    `[assistant] ${client}: picture refused: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  return json({ ok: false, error: "That picture could not be read." }, 400);
}

/**
 * The request's pictures, checked but not yet decoded, or the 400 that says
 * what is wrong with them. Nothing to check is no pictures: most asks carry
 * none, and the editor leaves the field out for those (a scripted client may
 * send an empty list instead, which means the same).
 *
 * This is the half that runs BEFORE admission, and only the cheap half: the
 * list's shape, the base64, the byte count, the signature and the IHDR, all
 * read off the bytes without inflating one. Garbage is still refused without
 * costing the player an ask. Decoding and analysing are openPictures, after
 * admit(): three pictures at the limit are seconds of synchronous CPU on an
 * isolate every other player's stream shares, and a client already over its
 * limit must not be able to buy those seconds with requests that end in a
 * 429.
 */
function checkPictures(
  raw: unknown,
  client: string,
): CheckedUpload[] | Response {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  try {
    return checkUploads(raw);
  } catch (err) {
    return pictureRefused(err, client);
  }
}

/**
 * The checked pictures decoded and analysed, once the request has been
 * admitted, or the 400. A picture can still fail here — pixel data that will
 * not inflate, or inflates past what its header declared — and it is still
 * a 400, though by now the ask or the publish has been counted. That is
 * deliberate: it is a picture that lied about itself in the part checkUploads
 * reads cheaply, and handing the count back would hand back exactly the
 * decoding this order exists to meter.
 */
async function openPictures(
  checked: CheckedUpload[],
  client: string,
): Promise<UploadedImage[] | Response> {
  if (!checked.length) return [];
  try {
    return await openUploads(checked);
  } catch (err) {
    return pictureRefused(err, client);
  }
}

type Ctx = { req: Request; info?: Deno.ServeHandlerInfo };

/** The handlers, with their dependencies injectable. */
export function assistantHandlers(deps: AssistantDeps = {}) {
  const env = deps.env ?? envGet;
  const tools = deps.tools ?? catalogTools({ local: false, uploads: true });
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
      maxUploads: MAX_UPLOADS,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxUploadSide: MAX_UPLOAD_SIDE,
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
    // Checked before admission, as in ask(): a picture that is plainly not
    // one should not cost the player one of their publishes.
    const checked = checkPictures(body.uploads, client);
    if (checked instanceof Response) return checked;
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
    // Decoded only now, admitted and with arguments that parse: the cheap
    // refusals all come before the expensive part.
    const uploads = await openPictures(checked, client);
    if (uploads instanceof Response) return uploads;
    args.apply = true;
    delete args.preview;
    const result = await guard(() => tool.run(args, { uploads }));
    if (result.isError) {
      return json(
        { ok: false, error: result.content[0]?.text ?? "failed" },
        422,
      );
    }
    const payload = result.structuredContent ?? {};
    const {
      png_base64: _png,
      projectile: _shot,
      character: _record,
      provenance: _prov,
      ...rest
    } = payload;
    return json({ ok: true, tool: tool.name, ...rest });
  }

  function ask(
    body: Record<string, unknown>,
    client: string,
    config: AssistantConfig,
    signal: AbortSignal,
  ): Promise<Response> {
    return (async () => {
      const typed = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (typed.length > MAX_PROMPT) {
        return json({
          ok: false,
          error: `Keep it under ${MAX_PROMPT} characters.`,
        }, 400);
      }
      // Checked before admission: bad input should not spend the player's
      // hourly asks, and a picture that is plainly not one is bad input.
      // Decoding waits until after (checkPictures says why).
      const checked = checkPictures(body.uploads, client);
      if (checked instanceof Response) return checked;
      // A picture is a request on its own — "this, as a boss" — so with one
      // attached an empty box means the obvious thing.
      const prompt = typed || (checked.length ? PICTURE_PROMPT : "");
      if (!prompt) return json({ ok: false, error: "Say what to build." }, 400);
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
      const uploads = await openPictures(checked, client);
      if (uploads instanceof Response) return uploads;

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
              uploads,
            });
            send({ type: "done", ...outcome });
          } catch (err) {
            // The API's own words ride along: "credit balance is too low",
            // "invalid x-api-key" and a schema complaint all arrive as a bare
            // 400 or 401 otherwise, and the server log is not where the person
            // looking at the box can see. They never carry the key, but a
            // key-shaped string is blanked anyway, and the text is bounded.
            const message = err instanceof ApiError
              ? `The model could not be reached (HTTP ${err.status}${
                apiReason(err.message)
              }).`
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
      // By its declared length, before a byte of it is read: the largest
      // body a request has any use for is three pictures at their limit, so
      // anything bigger is refused without parsing megabytes of JSON first.
      // A chunked body declares no length, so the read itself is capped too
      // (readCapped) — otherwise it is the platform's ceiling, not ours.
      const length = Number(ctx.req.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        return json({ ok: false, error: "That is too big to send." }, 413);
      }
      const raw = await readCapped(ctx.req, MAX_BODY_BYTES);
      if (raw === null) {
        return json({ ok: false, error: "That is too big to send." }, 413);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
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

/** ": <the API's message>" for an error event, or "" when it says nothing. */
export function apiReason(message: string): string {
  const text = message
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  if (!text || /^HTTP \d+$/.test(text)) return "";
  return ": " + (text.length > 200 ? text.slice(0, 199) + "…" : text);
}

/**
 * The body as text, or null once it passes `max` bytes — the reader is
 * cancelled there, so a chunked body that never declared its length is not
 * buffered past the limit either.
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
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
