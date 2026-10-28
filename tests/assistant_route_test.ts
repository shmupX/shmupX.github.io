// The character assistant behind the editor's DESCRIBE IT box: the agent
// loop (lib/assistant/agent.ts), the spend limits (lib/assistant/limits.ts)
// and the route that fronts them (routes/api/assistant.ts).
//
// Nothing here reaches the Messages API or the catalog. The API is a
// scripted fetch that answers from a queue and keeps every request body, and
// the tools are a tiny table in the shape of mcp/lib/tools.ts whose handlers
// record what they were asked. That is enough to prove what matters about a
// loop that spends the project's credits against a shared, open-write
// catalog: that a model asking to publish is answered with a dry run, that
// the dry run becomes a proposal with its sprite, that the step cap ends a
// request the model would run on with, that the system prompt and the tool
// table are marked for caching, that the route refuses without a key and
// across sites, that the limits count what they should, and that PUBLISH
// re-runs exactly the proposed call with apply on and nothing else.

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { z } from "zod";
import { decodeBase64 } from "@std/encoding/base64";
import { decodePng, newRaster } from "@shmupx/shmup-harbor/png";
import { packFrames, sheetDataUrl } from "../mcp/lib/art.ts";
import type { CreateResult } from "../mcp/lib/character.ts";
import {
  type CatalogTool,
  catalogTools,
  ok,
  previewOfBuild,
  toolSpec,
} from "../mcp/lib/tools.ts";
import {
  describeCall,
  describeResult,
  runAssistant,
  SYSTEM_PROMPT,
  userMessage,
} from "../lib/assistant/agent.ts";
import {
  admit,
  clientKey,
  DEFAULT_LIMITS,
  limitsFromEnv,
  MemoryCounter,
} from "../lib/assistant/limits.ts";
import { assistantHandlers, MAX_PROMPT } from "../routes/api/assistant.ts";

/** ─── a scripted Messages API ──────────────────────────────────────────── */

type Block = Record<string, unknown>;

function reply(
  content: Block[],
  stop_reason = "end_turn",
  usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
) {
  return { content, stop_reason, usage };
}

const text = (t: string) => ({ type: "text", text: t });
const callTool = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** Answers from the queue in order; after the queue, every call is a final text. */
function scriptedApi(queue: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    // With tools off the real API never answers a tool_use; neither does this.
    const next = body.tool_choice?.type === "none" || !queue.length
      ? reply([text("Done.")])
      : queue.shift();
    return Promise.resolve(
      new Response(JSON.stringify(next), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

/** ─── a tiny tool table ────────────────────────────────────────────────── */

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeTools() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const tools: CatalogTool[] = [
    {
      name: "shmupx_list_atlases",
      title: "List atlases",
      description: "List atlases.",
      shape: { match: z.string().optional() },
      annotations: { readOnlyHint: true },
      writes: false,
      assistant: true,
      run: (args: Record<string, unknown>) => {
        calls.push({ name: "shmupx_list_atlases", args });
        return Promise.resolve(
          ok({ count: 2, atlases: ["hadouken", "akuma"] }),
        );
      },
    },
    {
      name: "shmupx_create_character",
      title: "Create a character",
      description: "Build a character.",
      shape: {
        name: z.string(),
        cloneFrom: z.string().optional(),
        apply: z.boolean().optional(),
        preview: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
      writes: true,
      assistant: true,
      run: (args: Record<string, unknown>) => {
        calls.push({ name: "shmupx_create_character", args });
        return Promise.resolve(ok({
          applied: !!args.apply,
          name: args.name,
          character: { hp: 1, anim: { idle: ["a"] } },
          atlas: { frameCount: 3 },
          unresolved: [],
          warnings: [],
          ...(args.preview
            ? { png_base64: PNG, width_px: 1, height_px: 1 }
            : {}),
          ...(args.apply
            ? { written: [`shmupX/characters/${args.name}`] }
            : {}),
        }));
      },
    },
    {
      name: "shmupx_place_character",
      title: "Place",
      description: "Edits somebody's level.",
      shape: {
        level: z.string(),
        character: z.string(),
        apply: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
      writes: true,
      assistant: false,
      run: (args: Record<string, unknown>) => {
        calls.push({ name: "shmupx_place_character", args });
        return Promise.resolve(ok({ applied: !!args.apply }));
      },
    },
  ] as unknown as CatalogTool[];
  return { tools, calls };
}

const agentOptions = (
  tools: CatalogTool[],
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof runAssistant>[2]> = {},
) => ({
  apiKey: "sk-test",
  model: "claude-test",
  fetch,
  tools,
  maxSteps: 6,
  ...extra,
});

/** ─── the loop ─────────────────────────────────────────────────────────── */

Deno.test("a model that asks to publish gets a dry run, and the dry run becomes a proposal", async () => {
  const { tools, calls } = fakeTools();
  const api = scriptedApi([
    reply(
      [callTool("t1", "shmupx_list_atlases", { match: "hadou" })],
      "tool_use",
    ),
    reply([
      text("Building it."),
      callTool("t2", "shmupx_create_character", {
        name: "hadoukenBoss",
        cloneFrom: "dezaBoss0",
        apply: true,
      }),
    ], "tool_use"),
    reply([text("hadoukenBoss is a dezaBoss0 clone that throws hadoukens.")]),
  ]);
  const events: unknown[] = [];
  const outcome = await runAssistant(
    "a boss like the stage 1 boss that throws hadoukens",
    { level: "gs", catalog: ["dezaBoss0", "dezaBoss1"] },
    agentOptions(tools, api.fetch, { onEvent: (e) => events.push(e) }),
  );

  // The write never happened, whatever the model passed.
  const create = calls.find((c) => c.name === "shmupx_create_character");
  assertExists(create);
  assertEquals(create.args.apply, false);
  assertEquals(create.args.preview, true);

  // The dry run is the proposal: the call to make again, its summary, its sprite.
  assertEquals(outcome.proposals.length, 1);
  const [proposal] = outcome.proposals;
  assertEquals(proposal.tool, "shmupx_create_character");
  assertEquals(proposal.name, "hadoukenBoss");
  assertEquals(proposal.args, { name: "hadoukenBoss", cloneFrom: "dezaBoss0" });
  assertEquals(proposal.png_base64, PNG);
  assertEquals(proposal.summary.applied, false);
  assert(!("png_base64" in proposal.summary));
  assert(!("character" in proposal.summary));

  assertEquals(
    outcome.text,
    "hadoukenBoss is a dezaBoss0 clone that throws hadoukens.",
  );
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.turns, 3);
  assertEquals(outcome.stop, "end_turn");
  assertEquals(outcome.usage.input_tokens, 300);
  assertEquals(outcome.usage.output_tokens, 60);

  // The editor's progress line sees each call and what it found.
  const labels = events.filter((e) => (e as { type: string }).type === "tool")
    .map((e) => (e as { label: string }).label);
  assertEquals(labels, [
    "looking for hadou atlases",
    "building hadoukenBoss from dezaBoss0",
  ]);
  const notes = events.filter((e) =>
    (e as { type: string }).type === "tool_result"
  )
    .map((e) => (e as { note: string }).note);
  assertEquals(notes, ["2 atlases", "3 frames packed"]);
});

Deno.test("the request carries the cached prefix, the context, and the sprite as an image", async () => {
  const { tools } = fakeTools();
  const api = scriptedApi([
    reply(
      [callTool("t1", "shmupx_create_character", { name: "x" })],
      "tool_use",
    ),
  ]);
  await runAssistant(
    "make x",
    { level: "gs", character: "dezaBoss1", catalog: ["dezaBoss0"] },
    agentOptions(tools, api.fetch),
  );
  const [first, second] = api.requests;

  // System prompt and the last tool are cache breakpoints; the model is told
  // the catalog, the open game and where the player came from.
  const system = first.system as { text: string; cache_control?: unknown }[];
  assertEquals(system[0].text, SYSTEM_PROMPT);
  assertEquals(system[0].cache_control, { type: "ephemeral" });
  const toolsSent = first.tools as {
    name: string;
    cache_control?: unknown;
    input_schema: unknown;
  }[];
  assertEquals(toolsSent.map((t) => t.name), [
    "shmupx_list_atlases",
    "shmupx_create_character",
  ]);
  assertEquals(toolsSent.at(-1)?.cache_control, { type: "ephemeral" });
  assertEquals(toolsSent[0].cache_control, undefined);
  const user =
    (first.messages as { content: { text: string }[] }[])[0].content[0].text;
  assertStringIncludes(user, "Request: make x");
  assertStringIncludes(user, 'the game "gs"');
  assertStringIncludes(user, 'character sheet of "dezaBoss1"');
  assertStringIncludes(user, "Catalog right now (1): dezaBoss0");
  assertStringIncludes(user, "Tool calls available: 6");

  // The tool result went back as JSON plus the PNG as an image block, so the
  // model can look at what it made.
  const results = (second.messages as { role: string; content: Block[] }[]).at(
    -1,
  )!;
  assertEquals(results.role, "user");
  const block = results.content[0] as { type: string; content: Block[] };
  assertEquals(block.type, "tool_result");
  assertEquals(block.content[0].type, "text");
  assertStringIncludes(
    String(block.content[0].text),
    '"png_base64": "(attached as an image)"',
  );
  assertEquals(block.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG },
  });
});

Deno.test("the step cap ends a request the model would run on with", async () => {
  const { tools, calls } = fakeTools();
  const forever = Array.from(
    { length: 10 },
    (_, i) => reply([callTool(`t${i}`, "shmupx_list_atlases", {})], "tool_use"),
  );
  const api = scriptedApi(forever);
  const outcome = await runAssistant(
    "list everything",
    {},
    agentOptions(tools, api.fetch, { maxSteps: 3 }),
  );
  assertEquals(calls.length, 3);
  assertEquals(outcome.steps, 3);
  assertEquals(outcome.stop, "steps");
  // One last turn with tools off, so the model answers with what it has.
  const last = api.requests.at(-1)!;
  assertEquals(last.tool_choice, { type: "none" });
  assertEquals(outcome.turns, 4);
  assertEquals(outcome.text, "Done.");
});

Deno.test("bad arguments and unknown tools come back as errors the model reads", async () => {
  const { tools, calls } = fakeTools();
  const api = scriptedApi([
    reply([
      callTool("t1", "shmupx_create_character", { nope: 1 }),
      callTool("t2", "shmupx_place_character", { level: "gs", character: "x" }),
      callTool("t3", "shmupx_debug_eval", { expression: "1" }),
    ], "tool_use"),
  ]);
  await runAssistant("x", {}, agentOptions(tools, api.fetch));
  assertEquals(calls.length, 0);
  const results =
    (api.requests[1].messages as { content: Block[] }[]).at(-1)!.content;
  assertEquals(results.map((r) => r.is_error), [true, true, true]);
  assertStringIncludes(
    String(results[0].content),
    "Bad arguments for shmupx_create_character",
  );
  // A tool the assistant was not offered does not exist for it.
  assertStringIncludes(
    String(results[1].content),
    "No such tool: shmupx_place_character",
  );
  assertStringIncludes(
    String(results[2].content),
    "No such tool: shmupx_debug_eval",
  );
});

Deno.test("the labels read as the editor shows them", () => {
  assertEquals(
    describeCall("shmupx_list_frames", { atlas: "hadouken" }),
    "listing frames in hadouken",
  );
  assertEquals(
    describeCall("shmupx_list_objects", { query: "the second boss" }),
    'finding "the second boss"',
  );
  assertEquals(
    describeCall("shmupx_update_object", {
      id: "dezaBoss1",
      saveAs: "redBoss",
    }),
    "editing dezaBoss1 as redBoss",
  );
  assertEquals(
    describeResult(
      "shmupx_create_character",
      ok({ atlas: { frameCount: 4 }, unresolved: ["a", "b"] }),
    ),
    "4 frames packed · 2 unresolved",
  );
  assertEquals(
    describeResult(
      "shmupx_list_objects",
      ok({ resolved: { id: "dezaBoss1" } }),
    ),
    "→ dezaBoss1",
  );
  assertEquals(
    describeResult(
      "shmupx_list_objects",
      ok({ resolved: null, candidates: [1, 2] }),
    ),
    "2 candidates",
  );
  assertEquals(
    describeResult("x", {
      content: [{ type: "text", text: "No such frame\nmore" }],
      isError: true,
    }),
    "No such frame",
  );
  assertStringIncludes(
    userMessage("hi", { catalog: [] }, 3),
    "Catalog right now: empty.",
  );
});

/** ─── the real table, as the assistant sees it ─────────────────────────── */

Deno.test("the hosted table offers no file art, no writeTo and no level placement", () => {
  const hosted = catalogTools({ local: false });
  const local = catalogTools({ local: true });
  const offered = hosted.filter((t) => t.assistant).map((t) => t.name);
  assert(!offered.includes("shmupx_place_character"));
  assert(offered.includes("shmupx_create_character"));
  assert(offered.includes("shmupx_update_object"));

  const create = (tools: CatalogTool[]) =>
    JSON.stringify(
      toolSpec(tools.find((t) => t.name === "shmupx_create_character")!),
    );
  assert(!create(hosted).includes("writeTo"));
  assert(!create(hosted).includes('"file"'));
  assertStringIncludes(create(local), "writeTo");
  assertStringIncludes(create(local), "dev-fixtures");

  // Every spec is a JSON Schema object the API takes, and the schema keeps
  // the descriptions an MCP client reads.
  for (const tool of hosted) {
    const spec = toolSpec(tool);
    assertEquals(spec.input_schema.type, "object");
    assert(!("$schema" in spec.input_schema));
  }
  const update = toolSpec(
    hosted.find((t) => t.name === "shmupx_update_object")!,
  );
  const props = update.input_schema.properties as Record<
    string,
    { description?: string }
  >;
  assertMatch(props.palette.description ?? "", /Recolour the body art/);
});

Deno.test("a build's preview is its first idle frame, cut back out of the sheet it packed", async () => {
  // Two frames of different sizes, so the one that comes back is telling.
  const idle = newRaster(3, 2);
  idle.data.fill(255);
  const shot = newRaster(1, 1);
  const { sheet, json } = packFrames([
    { name: "boss_idle0", raster: idle, source: "test", scope: "test" },
    { name: "boss_shot", raster: shot, source: "test", scope: "test" },
  ]);
  const built: CreateResult = {
    name: "testBoss",
    clonedFrom: null,
    character: {
      anim: { idle: ["boss_idle0"] },
      bulletDataA: { texture: ["boss_shot"] },
    },
    atlas: {
      json,
      dataUrl: await sheetDataUrl(sheet),
      frameCount: 2,
      size: { w: sheet.width, h: sheet.height },
    },
    provenance: [],
    unresolved: [],
    warnings: [],
  };
  const preview = await previewOfBuild(built);
  assertExists(preview);
  assertEquals(preview.frame, "boss_idle0");
  assertEquals([preview.width_px, preview.height_px], [3, 2]);
  const png = await decodePng(decodeBase64(preview.png_base64));
  assertEquals([png.width, png.height], [3, 2]);
  assertEquals(png.data[0], 255);

  // No idle state: the first frame of the atlas stands in. No frames: nothing.
  const bare = { ...built, character: {} };
  assertEquals(
    (await previewOfBuild(bare))?.frame,
    Object.keys(json.frames)[0],
  );
  assertEquals(
    await previewOfBuild({
      ...built,
      atlas: { ...built.atlas, json: { ...json, frames: {} } },
    }),
    null,
  );
});

/** ─── limits ───────────────────────────────────────────────────────────── */

Deno.test("a client has an hour's worth, everybody has a day's worth, publishes are apart", async () => {
  let t = Date.parse("2026-10-27T10:00:00Z");
  const counter = new MemoryCounter(() => t);
  const limits = { asksPerHour: 2, asksPerDay: 5, publishesPerHour: 1 };
  const hour = () => Math.floor(t / 3600_000);

  assertEquals((await admit(counter, limits, "ask", "a", t)).ok, true);
  assertEquals((await admit(counter, limits, "ask", "a", t)).ok, true);
  const third = await admit(counter, limits, "ask", "a", t);
  assert(!third.ok);
  assertStringIncludes(third.reason, "2 requests in an hour");
  assertEquals(third.retryAfterSeconds, 3600);
  // The refused ask never counted against the day.
  assertEquals(await counter.peek("ask:day:2026-10-27"), 2);

  // Other clients are admitted — until the day is spent by everybody.
  assertEquals((await admit(counter, limits, "ask", "b", t)).ok, true);
  assertEquals((await admit(counter, limits, "ask", "b", t)).ok, true);
  assertEquals((await admit(counter, limits, "ask", "c", t)).ok, true);
  const spent = await admit(counter, limits, "ask", "c", t);
  assert(!spent.ok);
  assertStringIncludes(spent.reason, "today");
  assertEquals(spent.retryAfterSeconds, 14 * 3600);

  // Publishing has its own bucket and does not touch the day.
  assertEquals((await admit(counter, limits, "publish", "a", t)).ok, true);
  assert(!(await admit(counter, limits, "publish", "a", t)).ok);
  assertEquals(await counter.peek("ask:day:2026-10-27"), 6);

  // The hour rolls over — a's bucket starts again — but the day does not.
  t += 3600_000;
  const later = await admit(counter, limits, "ask", "a", t);
  assertEquals(await counter.peek(`ask:a:${hour()}`), 1);
  assert(!later.ok);
  assertStringIncludes(later.reason, "today");
});

Deno.test("limits come from the environment, with sane defaults", () => {
  assertEquals(limitsFromEnv(() => undefined), DEFAULT_LIMITS);
  assertEquals(
    limitsFromEnv((k) =>
      ({ ASSISTANT_ASKS_PER_HOUR: "3", ASSISTANT_ASKS_PER_DAY: "x" })[k]
    ),
    { ...DEFAULT_LIMITS, asksPerHour: 3 },
  );
  const h = (o: Record<string, string>) => new Headers(o);
  assertEquals(
    clientKey(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }), undefined),
    "1.2.3.4",
  );
  assertEquals(
    clientKey(h({}), { transport: "tcp", hostname: "9.9.9.9", port: 1 }),
    "9.9.9.9",
  );
  assertEquals(clientKey(h({}), undefined), "local");
});

/** ─── the route ────────────────────────────────────────────────────────── */

type Ctx = { req: Request; info?: Deno.ServeHandlerInfo };
const ORIGIN = "https://codemonkey.games";

function post(
  body: unknown,
  headers: Record<string, string> = {},
  ip = "5.5.5.5",
): Ctx {
  return {
    req: new Request(`${ORIGIN}/api/assistant`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        host: "codemonkey.games",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    info: {
      remoteAddr: { transport: "tcp", hostname: ip, port: 1 },
      completed: Promise.resolve(),
    } as unknown as Deno.ServeHandlerInfo,
  };
}

async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  assertEquals(
    res.headers.get("content-type"),
    "application/x-ndjson; charset=utf-8",
  );
  const body = await res.text();
  return body.trim().split("\n").map((line) => JSON.parse(line));
}

const keyed = (extra: Record<string, string> = {}) => (k: string) =>
  ({ ANTHROPIC_API_KEY: "sk-test", ASSISTANT_MODEL: "claude-test", ...extra })[
    k
  ];

Deno.test("GET says whether this build can answer, and with what", async () => {
  const { tools } = fakeTools();
  const off = assistantHandlers({
    env: () => undefined,
    tools,
    counter: new MemoryCounter(),
  });
  const none = await off.GET({ req: new Request(`${ORIGIN}/api/assistant`) })
    .json();
  assertEquals(none.available, false);
  assertEquals(none.model, undefined);

  const on = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
  });
  const some = await on.GET({ req: new Request(`${ORIGIN}/api/assistant`) })
    .json();
  assertEquals(some.available, true);
  assertEquals(some.model, "claude-test");
  assertEquals(some.maxPrompt, MAX_PROMPT);
  assertEquals(some.tools, ["shmupx_list_atlases", "shmupx_create_character"]);
  assertEquals(some.limits, DEFAULT_LIMITS);
});

Deno.test("POST refuses without a key, across sites, and with nothing to say", async () => {
  const { tools } = fakeTools();
  const off = assistantHandlers({
    env: () => undefined,
    tools,
    counter: new MemoryCounter(),
  });
  assertEquals((await off.POST(post({ prompt: "x" }))).status, 503);

  const on = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: scriptedApi([]).fetch,
    listCatalog: () => Promise.resolve([]),
  });
  assertEquals(
    (await on.POST(post({ prompt: "x" }, { "sec-fetch-site": "cross-site" })))
      .status,
    403,
  );
  assertEquals((await on.POST(post({ prompt: "   " }))).status, 400);
  assertEquals(
    (await on.POST(post({ prompt: "x".repeat(MAX_PROMPT + 1) }))).status,
    400,
  );
  const notJson = await on.POST({
    req: new Request(`${ORIGIN}/api/assistant`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: "nope",
    }),
  });
  assertEquals(notJson.status, 400);
});

Deno.test("POST streams the loop as NDJSON and ends with the proposals", async () => {
  const { tools, calls } = fakeTools();
  const api = scriptedApi([
    reply([
      callTool("t1", "shmupx_create_character", {
        name: "redBoss",
        apply: true,
      }),
    ], "tool_use"),
    reply([text("redBoss is ready.")]),
  ]);
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: api.fetch,
    listCatalog: () => Promise.resolve(["dezaBoss0"]),
  });
  const res = await handlers.POST(
    post({ prompt: "a red boss", context: { level: "gs" } }),
  );
  assertEquals(res.status, 200);
  const events = await ndjson(res);
  assertEquals(events.map((e) => e.type), [
    "tool",
    "tool_result",
    "text",
    "done",
  ]);
  const done = events.at(-1)!;
  assertEquals(done.text, "redBoss is ready.");
  const proposals = done.proposals as { name: string; args: unknown }[];
  assertEquals(proposals.length, 1);
  assertEquals(proposals[0].name, "redBoss");
  assertEquals(proposals[0].args, { name: "redBoss" });
  // Still a dry run, whatever the model asked for; the catalog went in the first turn.
  assertEquals(calls[0].args.apply, false);
  const user =
    (api.requests[0].messages as { content: { text: string }[] }[])[0]
      .content[0].text;
  assertStringIncludes(user, "Catalog right now (1): dezaBoss0");
  assertStringIncludes(user, 'the game "gs"');
});

Deno.test("an API that will not answer is an error event, not a broken stream", async () => {
  const { tools } = fakeTools();
  const failing = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { message: "invalid x-api-key" } }),
        { status: 401 },
      ),
    );
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: failing as unknown as typeof fetch,
    listCatalog: () => Promise.reject(new Error("db down")),
  });
  const events = await ndjson(await handlers.POST(post({ prompt: "x" })));
  assertEquals(events, [{
    type: "error",
    message: "The model could not be reached (HTTP 401).",
  }]);
});

Deno.test("the limits answer 429 with a retry-after", async () => {
  const { tools } = fakeTools();
  const handlers = assistantHandlers({
    env: keyed({ ASSISTANT_ASKS_PER_HOUR: "1" }),
    tools,
    counter: new MemoryCounter(),
    fetch: scriptedApi([]).fetch,
    listCatalog: () => Promise.resolve([]),
  });
  assertEquals((await handlers.POST(post({ prompt: "x" }))).status, 200);
  const limited = await handlers.POST(post({ prompt: "x" }));
  assertEquals(limited.status, 429);
  assertMatch(limited.headers.get("retry-after") ?? "", /^\d+$/);
  assertStringIncludes((await limited.json()).error, "1 requests in an hour");
  // Another address is another client.
  assertEquals(
    (await handlers.POST(post({ prompt: "x" }, {}, "6.6.6.6"))).status,
    200,
  );
});

Deno.test("PUBLISH re-runs the proposed call with apply on, and nothing else", async () => {
  const { tools, calls } = fakeTools();
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: scriptedApi([]).fetch,
  });
  const res = await handlers.POST(post({
    publish: {
      tool: "shmupx_create_character",
      args: {
        name: "redBoss",
        cloneFrom: "dezaBoss0",
        apply: false,
        preview: true,
      },
    },
  }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.applied, true);
  assertEquals(body.written, ["shmupX/characters/redBoss"]);
  assert(!("character" in body));
  assertEquals(calls, [{
    name: "shmupx_create_character",
    args: { name: "redBoss", cloneFrom: "dezaBoss0", apply: true },
  }]);

  // Not a tool the assistant publishes: a read, a level edit, a stranger.
  for (
    const tool of [
      "shmupx_list_atlases",
      "shmupx_place_character",
      "shmupx_debug_eval",
    ]
  ) {
    const refused = await handlers.POST(post({ publish: { tool, args: {} } }));
    assertEquals(refused.status, 400, tool);
  }
  assertEquals(calls.length, 1);

  // Arguments are checked against the tool's own shape.
  const bad = await handlers.POST(
    post({ publish: { tool: "shmupx_create_character", args: {} } }),
  );
  assertEquals(bad.status, 400);
  assertStringIncludes((await bad.json()).error, "Bad arguments");
});
