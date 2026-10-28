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
//
// Pictures (DESCRIBE IT takes a picture as well as a sentence) add the rest:
// that the model is shown them ahead of the request and told what upload.ts
// made of them, that every tool call runs with them in its context, that a
// picture which is plainly not one is refused before it spends an ask while
// one that only fails to inflate is decoded no sooner than the request is
// admitted, that one build cuts a bounded number of frames from them, that
// PUBLISH decodes the same pictures again, and that a build's main projectile
// reaches the model and the card as a second image. Most of that is plumbing
// and is proved with hand-built UploadedImage values; the tests that need
// upload.ts's own decoding and analysis say so, and run the real thing — the
// end-to-end one cuts a body and an inked shot out of a synthetic picture
// through the real hosted create tool, which reads nothing from the catalog
// when it clones nothing.

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { z } from "zod";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import {
  ArtError,
  packFrames,
  resolveFrame,
  sheetDataUrl,
} from "../mcp/lib/art.ts";
import {
  buildCharacter,
  type CreateResult,
  MAX_UPLOAD_FRAMES,
} from "../mcp/lib/character.ts";
import {
  type CatalogTool,
  catalogTools,
  ok,
  previewOfBuild,
  type ToolContext,
  toolSpec,
} from "../mcp/lib/tools.ts";
import {
  decodeUploads,
  describeUploads,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIDE,
  MAX_UPLOADS,
  type UploadedImage,
} from "../mcp/lib/upload.ts";
import {
  callMessages,
  describeCall,
  describeResult,
  dispatch,
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
import {
  apiReason,
  assistantConfig,
  assistantHandlers,
  MAX_BODY_BYTES,
  MAX_PROMPT,
  PICTURE_PROMPT,
} from "../routes/api/assistant.ts";

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
/** Another 1×1 (one gold pixel), so a test can tell the shot's image from the body's. */
const SHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f4bhPwAHZALLB0SopwAAAABJRU5ErkJggg==";

/**
 * The tiny table. `contexts` keeps the ToolContext each call ran with, apart
 * from `calls` so the PUBLISH test can still compare calls exactly; with
 * `shot`, the create tool's preview carries a main projectile the way
 * previewOfBuild's does.
 */
function fakeTools({ shot = false }: { shot?: boolean } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const contexts: (ToolContext | undefined)[] = [];
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
      run: (args: Record<string, unknown>, ctx?: ToolContext) => {
        calls.push({ name: "shmupx_create_character", args });
        contexts.push(ctx);
        return Promise.resolve(ok({
          applied: !!args.apply,
          name: args.name,
          character: { hp: 1, anim: { idle: ["a"] } },
          atlas: { frameCount: 3 },
          unresolved: [],
          warnings: [],
          ...(args.preview
            ? { png_base64: PNG, width_px: 1, height_px: 1, frame: "a" }
            : {}),
          ...(args.preview && shot
            ? {
              projectile: {
                png_base64: SHOT_PNG,
                width_px: 1,
                height_px: 1,
                frame: "a_shot",
              },
            }
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
  return { tools, calls, contexts };
}

/**
 * An UploadedImage made by hand: what decodeUploads would answer for a
 * 4×3 picture with one subject, without running it. Enough for anything that
 * only carries pictures from one place to another.
 */
function handUpload(index: number, name: string, png = PNG): UploadedImage {
  return {
    index,
    name,
    raster: newRaster(4, 3),
    analysis: {
      width: 4,
      height: 3,
      background: {
        r: 255,
        g: 255,
        b: 255,
        hex: "#ffffff",
        transparent: false,
      },
      regions: [{
        index: 0,
        x: 1,
        y: 0,
        w: 2,
        h: 3,
        pixelScale: 1,
        native: { w: 2, h: 3 },
        kind: "image",
        darkOnLight: true,
      }],
    },
    png_base64: png,
  };
}

/**
 * A real picture to upload, as the editor sends one: 40×20, white, a red 8×8
 * block on the left and a black 6×4 one on the right — "Ryuda (left)" and
 * "the ascii image (right)" at the size of a test. 18 px apart, far more
 * than the merge distance a 40-px picture gets, so they are two regions.
 */
async function twoSubjects(): Promise<string> {
  const r = newRaster(40, 20);
  r.data.fill(255);
  const paint = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    rgb: [number, number, number],
  ) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        r.data.set([...rgb, 255], (y * r.width + x) * 4);
      }
    }
  };
  paint(2, 4, 8, 8, [200, 30, 30]);
  paint(28, 8, 6, 4, [0, 0, 0]);
  return encodeBase64(await encodePng(r));
}

const decoded = async (b64: string): Promise<Raster> =>
  await decodePng(decodeBase64(b64));

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
  // And the request itself asks for automatic caching, the breakpoint the
  // API keeps on the conversation's last block: three of the four a request
  // may carry, all the default five minutes, and no others.
  assertEquals(first.cache_control, { type: "ephemeral" });
  assertEquals(second.cache_control, { type: "ephemeral" });
  for (const request of [first, second]) {
    assertEquals(JSON.stringify(request).match(/"cache_control"/g)?.length, 3);
    assert(!JSON.stringify(request.messages).includes("cache_control"));
  }
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

/** ─── pictures, through the loop ───────────────────────────────────────── */

Deno.test("dispatch hands the request's pictures to the tool as its context", async () => {
  const { tools, contexts } = fakeTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const uploads = [handUpload(0, "ryuda")];
  const use = {
    type: "tool_use" as const,
    id: "t1",
    name: "shmupx_create_character",
    input: { name: "ryuda" },
  };
  await dispatch(byName, use, () => {}, { uploads });
  // The same pictures, not a copy: a frame ref names them by index.
  assertEquals(contexts.length, 1);
  assert(contexts[0]?.uploads === uploads);

  // No context is no pictures, as the MCP server calls it.
  await dispatch(byName, use, () => {});
  assertEquals(contexts[1], undefined);
});

Deno.test("a build's main projectile goes to the model as a second image, and onto the proposal", async () => {
  const { tools } = fakeTools({ shot: true });
  const api = scriptedApi([
    reply(
      [callTool("t1", "shmupx_create_character", { name: "ryuda" })],
      "tool_use",
    ),
  ]);
  const outcome = await runAssistant(
    "ryuda",
    {},
    agentOptions(tools, api.fetch),
  );

  // Body, then shot, each an image block after the JSON that names them.
  const block = (api.requests[1].messages as { content: Block[] }[]).at(-1)!
    .content[0] as { content: Block[] };
  assertEquals(block.content.map((b) => b.type), ["text", "image", "image"]);
  assertEquals(
    (block.content[1].source as { data: string }).data,
    PNG,
  );
  assertEquals(
    (block.content[2].source as { data: string }).data,
    SHOT_PNG,
  );
  const sent = JSON.parse(String(block.content[0].text));
  assertEquals(sent.png_base64, "(attached as an image)");
  assertEquals(sent.projectile.png_base64, "(attached as an image)");
  assertEquals(sent.projectile.frame, "a_shot");

  // The card gets the shot as its own field; the summary keeps its name and
  // size but not its pixels.
  const [proposal] = outcome.proposals;
  assertEquals(proposal.png_base64, PNG);
  assertEquals(proposal.projectile, {
    png_base64: SHOT_PNG,
    width_px: 1,
    height_px: 1,
  });
  assertEquals(proposal.summary.projectile, {
    width_px: 1,
    height_px: 1,
    frame: "a_shot",
  });
  assert(!JSON.stringify(proposal.summary).includes(SHOT_PNG));
});

// Needs upload.ts's describeUploads.
Deno.test("the first user message carries the pictures, then the request and what was made of them", async () => {
  const { tools, contexts } = fakeTools();
  const api = scriptedApi([
    reply(
      [callTool("t1", "shmupx_create_character", { name: "ryuda" })],
      "tool_use",
    ),
  ]);
  const uploads = [handUpload(0, "ryuda"), handUpload(1, "ascii", SHOT_PNG)];
  await runAssistant(
    "use the ascii image (right) as projectile for Ryuda (left)",
    { catalog: ["dezaBoss0"] },
    agentOptions(tools, api.fetch, { uploads }),
  );
  const [first] = api.requests;
  const content = (first.messages as { role: string; content: Block[] }[])[0]
    .content;

  // One image block per picture, in the request's order, each under a label
  // that names it as the analysis does; then the text.
  assertEquals(content.map((b) => b.type), [
    "text",
    "image",
    "text",
    "image",
    "text",
  ]);
  assertEquals(content[0].text, 'Picture 0 "ryuda":');
  assertEquals(content[1].source, {
    type: "base64",
    media_type: "image/png",
    data: PNG,
  });
  assertEquals(content[2].text, 'Picture 1 "ascii":');
  assertEquals((content[3].source as { data: string }).data, SHOT_PNG);
  const user = String(content[4].text);
  for (const label of [content[0].text, content[2].text]) {
    assertStringIncludes(user, `\n${label} `);
  }
  assertStringIncludes(
    user,
    "Request: use the ascii image (right) as projectile for Ryuda (left)",
  );
  assertStringIncludes(user, "Pictures attached (2)");
  assertStringIncludes(user, describeUploads(uploads));
  assertEquals(
    user,
    userMessage(
      "use the ascii image (right) as projectile for Ryuda (left)",
      { catalog: ["dezaBoss0"] },
      6,
      uploads,
    ),
  );

  // The pictures are the player's, so they stay out of the shared prefix:
  // the system prompt is the shared one and its breakpoints have not moved.
  // What caches them for the rest of this request is the automatic
  // breakpoint, asked for at the top level — no marker inside the messages.
  const system = first.system as { text: string; cache_control?: unknown }[];
  assertEquals(system.length, 1);
  assertEquals(system[0].text, SYSTEM_PROMPT);
  assert(!JSON.stringify(first.messages).includes("cache_control"));
  assertEquals(first.cache_control, { type: "ephemeral" });

  // And the tool call ran with them.
  assert(contexts[0]?.uploads === uploads);
});

Deno.test("an upload ref with no picture attached is an error the model can read", async () => {
  let message = "";
  try {
    await resolveFrame({ upload: 0, region: 1 });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "No picture is attached to this request");
  // Nor does an empty list count as one.
  message = "";
  try {
    await resolveFrame({ upload: 0 }, { uploads: [] });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "No picture is attached to this request");
  // A request without pictures says nothing about them.
  assert(!userMessage("x", {}, 3).includes("Pictures attached"));
});

/** ─── the real table, as the assistant sees it ─────────────────────────── */

Deno.test("the hosted table offers no file art, no writeTo and no level placement", () => {
  // The options the route builds its table with.
  const hosted = catalogTools({ local: false, uploads: true });
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

  // A frame may be cut out of an attached picture on the hosted table only:
  // the MCP server's shapes, and a hosted table built without uploads, are
  // as they were.
  assertStringIncludes(create(hosted), '"upload"');
  assertStringIncludes(create(hosted), '"region"');
  assertStringIncludes(create(hosted), "dark starfield");
  assert(!create(local).includes('"upload"'));
  assert(!create(catalogTools({ local: false })).includes('"upload"'));
  // The upload ref reaches every place a frame goes, through the one shape.
  const props = toolSpec(
    hosted.find((t) => t.name === "shmupx_create_character")!,
  ).input_schema.properties as Record<string, unknown>;
  for (const field of ["mainProjectile", "anim", "projectiles", "stageBgEnd"]) {
    assertStringIncludes(JSON.stringify(props[field]), '"upload"', field);
  }

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
  const dials = update.input_schema.properties as Record<
    string,
    { description?: string }
  >;
  assertMatch(dials.palette.description ?? "", /Recolour the body art/);
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

  // Beside it, the main projectile's first frame, cut the same way.
  assertExists(preview.projectile);
  assertEquals(preview.projectile.frame, "boss_shot");
  assertEquals(
    [preview.projectile.width_px, preview.projectile.height_px],
    [1, 1],
  );
  const shotPng = await decoded(preview.projectile.png_base64);
  assertEquals([shotPng.width, shotPng.height], [1, 1]);

  // A shot the sheet does not hold is no shot to draw.
  const unpacked = await previewOfBuild({
    ...built,
    character: { ...built.character, bulletDataA: { texture: ["elsewhere"] } },
  });
  assertEquals(unpacked?.frame, "boss_idle0");
  assertEquals(unpacked?.projectile, undefined);

  // No idle state: the first frame of the atlas stands in. No frames: nothing.
  const bare = { ...built, character: {} };
  assertEquals(
    (await previewOfBuild(bare))?.frame,
    Object.keys(json.frames)[0],
  );
  assertEquals((await previewOfBuild(bare))?.projectile, undefined);
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
  // What the editor sizes attached pictures by.
  assertEquals(some.maxUploads, MAX_UPLOADS);
  assertEquals(some.maxUploadBytes, MAX_UPLOAD_BYTES);
  assertEquals(some.maxUploadSide, MAX_UPLOAD_SIDE);
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
    message: "The model could not be reached (HTTP 401: invalid x-api-key).",
  }]);
});

Deno.test("a key not scoped to a workspace names one: ANTHROPIC_WORKSPACE_ID goes out as anthropic-workspace-id", async () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(
    assistantConfig(env({ ANTHROPIC_API_KEY: "k" })).workspaceId,
    undefined,
  );
  assertEquals(
    assistantConfig(env({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_WORKSPACE_ID: "  wrkspc_test  ",
    })).workspaceId,
    "wrkspc_test",
  );

  const seen: Headers[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return Promise.resolve(
      new Response(
        JSON.stringify(reply([text("ok")])),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
  const body = {
    system: "s",
    tools: [],
    messages: [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "hi" }],
    }],
    max_tokens: 16,
  };
  const base = {
    apiKey: "k",
    model: "m",
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
  await callMessages(body, base);
  await callMessages(body, { ...base, workspaceId: "wrkspc_test" });
  assertEquals(seen[0].get("anthropic-workspace-id"), null);
  assertEquals(seen[1].get("anthropic-workspace-id"), "wrkspc_test");
  assertEquals(seen[1].get("x-api-key"), "k");
});

Deno.test("an API error's reason is bounded, and never repeats a key", () => {
  assertEquals(apiReason(""), "");
  assertEquals(apiReason("HTTP 400"), "");
  assertEquals(
    apiReason("Your credit balance is too low.\n"),
    ": Your credit balance is too low",
  );
  assertEquals(
    apiReason("bad key sk-ant-api03-abc_DEF-123 rejected"),
    ": bad key sk-ant-… rejected",
  );
  const long = apiReason("x".repeat(500));
  assertEquals(long.length, 2 + 200);
  assert(long.endsWith("…"));
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

/** ─── pictures, through the route ──────────────────────────────────────── */

Deno.test("a picture that is not one is refused before it spends an ask", async () => {
  const { tools, calls } = fakeTools();
  const t = Date.parse("2026-10-27T10:00:00Z");
  const counter = new MemoryCounter(() => t);
  const api = scriptedApi([]);
  const handlers = assistantHandlers({
    env: keyed({ ASSISTANT_ASKS_PER_HOUR: "1" }),
    tools,
    counter,
    fetch: api.fetch,
    listCatalog: () => Promise.resolve([]),
    now: () => t,
  });
  const garbage = [
    { prompt: "x", uploads: [{ png: "not base64 at all!" }] },
    { prompt: "x", uploads: [{ png: encodeBase64(new Uint8Array(64)) }] },
    { prompt: "x", uploads: "nope" },
    {
      prompt: "x",
      uploads: Array.from({ length: MAX_UPLOADS + 1 }, () => ({ png: PNG })),
    },
    // A picture is no excuse for a prompt over the limit.
    { prompt: "x".repeat(MAX_PROMPT + 1), uploads: [{ png: PNG }] },
  ];
  for (const body of garbage) {
    const res = await handlers.POST(post(body));
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 60));
    const answer = await res.json();
    assertEquals(answer.ok, false);
    assertEquals(typeof answer.error, "string");
  }
  // Nothing was counted, nothing reached the model, nothing ran.
  assertEquals(await counter.peek("ask:day:2026-10-27"), 0);
  assertEquals(api.requests.length, 0);
  assertEquals(calls.length, 0);
  // So the one ask this client has this hour is still there.
  assertEquals((await handlers.POST(post({ prompt: "x" }))).status, 200);
});

/** zlib's CRC-32, for building a PNG chunk by hand. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * A PNG that is honest everywhere but its pixels: the signature, a 4×4 RGBA
 * IHDR, every chunk's length and CRC are right, and the IDAT is a zlib
 * header over a deflate block of the reserved type. Everything checkUploads
 * reads off the bytes passes; only inflating it — openUploads, the half that
 * costs — finds out.
 */
function honestHeaderBadPixels(): string {
  const u32 = (n: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return [...out];
  };
  const chunk = (type: string, body: number[]) => {
    const typed = [...new TextEncoder().encode(type), ...body];
    return [
      ...u32(body.length),
      ...typed,
      ...u32(crc32(Uint8Array.from(typed))),
    ];
  };
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return encodeBase64(Uint8Array.from([
    ...signature,
    ...chunk("IHDR", [...u32(4), ...u32(4), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", [0x78, 0x9c, 0x07, 0, 0, 0, 0]),
    ...chunk("IEND", []),
  ]));
}

Deno.test("a picture is decoded only once its request is admitted", async () => {
  const { tools, calls } = fakeTools();
  const t = Date.parse("2026-10-27T10:00:00Z");
  const counter = new MemoryCounter(() => t);
  const api = scriptedApi([]);
  const handlers = assistantHandlers({
    env: keyed({
      ASSISTANT_ASKS_PER_HOUR: "1",
      ASSISTANT_PUBLISHES_PER_HOUR: "1",
    }),
    tools,
    counter,
    fetch: api.fetch,
    listCatalog: () => Promise.resolve([]),
    now: () => t,
  });
  const liar = [{ name: "liar", png: honestHeaderBadPixels() }];
  const publish = {
    publish: { tool: "shmupx_create_character", args: { name: "liar" } },
    uploads: liar,
  };

  // Within the limit: admitted, counted, and only then refused, at the
  // decode — the picture lied about itself where checking is cheap.
  const ask = await handlers.POST(post({ prompt: "x", uploads: liar }));
  assertEquals(ask.status, 400);
  assertStringIncludes((await ask.json()).error, "Picture 0");
  assertEquals(await counter.peek("ask:day:2026-10-27"), 1);
  const pub = await handlers.POST(post(publish));
  assertEquals(pub.status, 400);
  assertEquals(
    await counter.peek(`publish:5.5.5.5:${Math.floor(t / 3600_000)}`),
    1,
  );

  // Over it, the same picture is a 429: the counter turned it away before
  // anything inflated it, or it would have been that 400 again.
  assertEquals(
    (await handlers.POST(post({ prompt: "x", uploads: liar }))).status,
    429,
  );
  assertEquals((await handlers.POST(post(publish))).status, 429);
  assertEquals(api.requests.length, 0);
  assertEquals(calls.length, 0);
});

// Needs upload.ts's decodeUploads and cutUpload, through the real
// buildCharacter — which reads nothing from the catalog when it clones
// nothing, and never writes.
Deno.test("one build cuts at most MAX_UPLOAD_FRAMES frames out of the pictures", async () => {
  const uploads = await decodeUploads([{
    name: "pic",
    png: await twoSubjects(),
  }]);
  const refs = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => ({ upload: 0, region: 0, as: `f${i}` }),
    );

  // Up to the cap, every one is cut — and the same ref used again anywhere
  // in the build is the same cut, so it costs nothing against it.
  const full = await buildCharacter({
    name: "full",
    anim: {
      idle: refs(MAX_UPLOAD_FRAMES),
      attack: Array.from(
        { length: 40 },
        () => ({ upload: 0, region: 0, as: "f0" }),
      ),
    },
    projectiles: {
      bulletDataA: { texture: [{ upload: 0, region: 0, as: "f1" }] },
    },
  }, { uploads });
  assertEquals(full.atlas.frameCount, MAX_UPLOAD_FRAMES);

  // One more is an error the model reads, before that cut is made.
  await assertRejects(
    () =>
      buildCharacter({
        name: "over",
        anim: {
          idle: refs(MAX_UPLOAD_FRAMES),
          attack: refs(MAX_UPLOAD_FRAMES + 1),
        },
      }, { uploads }),
    ArtError,
    `at most ${MAX_UPLOAD_FRAMES}`,
  );
  await assertRejects(
    () =>
      buildCharacter({
        name: "over",
        anim: { idle: refs(MAX_UPLOAD_FRAMES + 1) },
      }, { uploads }),
    ArtError,
    "Reuse frames",
  );
  // And it is refused before the first cut, not after sixteen of them: a
  // build over the limit whose very first ref could not be cut still hears
  // about the limit rather than about that ref.
  await assertRejects(
    () =>
      buildCharacter({
        name: "over",
        anim: {
          idle: Array.from(
            { length: MAX_UPLOAD_FRAMES + 1 },
            (_, i) => ({ upload: 0, region: 99, as: `f${i}` }),
          ),
        },
      }, { uploads }),
    ArtError,
    "Reuse frames",
  );
});

Deno.test("a body bigger than three pictures is refused by its length, unread", async () => {
  const { tools } = fakeTools();
  const api = scriptedApi([]);
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: api.fetch,
    listCatalog: () => Promise.resolve([]),
  });
  const ctx = post({ prompt: "x" }, {
    "content-length": String(MAX_BODY_BYTES + 1),
  });
  const res = await handlers.POST(ctx);
  assertEquals(res.status, 413);
  assertEquals(await res.json(), {
    ok: false,
    error: "That is too big to send.",
  });
  assertEquals(api.requests.length, 0);
  // Unread is the point: a route that parsed the body first and refused it
  // after would answer the same 413, having already paid for the megabytes.
  assert(!ctx.req.bodyUsed, "the body was read before it was refused");
  // Three pictures at the per-picture limit, base64'd, still fit.
  assert(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 * MAX_UPLOADS < MAX_BODY_BYTES);
});

Deno.test("a chunked body that never says its length is cut off at the limit, not buffered whole", async () => {
  const { tools } = fakeTools();
  const api = scriptedApi([]);
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: api.fetch,
    listCatalog: () => Promise.resolve([]),
  });
  // An endless stream of 1 MiB chunks: a route that buffered to the end
  // would never answer. Counting what was pulled proves the read stopped.
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const ctx = post({}, {});
  const req = new Request(ctx.req.url, {
    method: "POST",
    headers: ctx.req.headers,
    body,
  });
  assertEquals(req.headers.get("content-length"), null);
  const res = await handlers.POST({ req, info: ctx.info });
  assertEquals(res.status, 413);
  assertEquals(await res.json(), {
    ok: false,
    error: "That is too big to send.",
  });
  assert(cancelled, "the reader was not cancelled at the limit");
  assert(
    pulled <= MAX_BODY_BYTES / chunk.length + 2,
    `read ${pulled} MiB of a ${MAX_BODY_BYTES / chunk.length} MiB limit`,
  );
  assertEquals(api.requests.length, 0);
});

// Needs upload.ts's decodeUploads, analyzeUpload, cutUpload and
// describeUploads: the real hosted table cuts the body and the shot out of
// a synthetic picture. Nothing is read from the catalog — the build clones
// nothing — and nothing is written: the loop forces apply off.
Deno.test("a picture becomes a character: the model sees it, cuts a body and an inked shot from it, and the card shows both", async () => {
  const png = await twoSubjects();
  const api = scriptedApi([
    reply([
      callTool("t1", "shmupx_create_character", {
        name: "ryuda",
        anim: { idle: [{ upload: 0, region: 0 }] },
        mainProjectile: [{ upload: 0, region: 1, ink: "#ffffff" }],
      }),
    ], "tool_use"),
    reply([text("ryuda throws the right-hand picture, in white.")]),
  ]);
  const handlers = assistantHandlers({
    env: keyed(),
    counter: new MemoryCounter(),
    fetch: api.fetch,
    listCatalog: () => Promise.resolve(["dezaBoss0"]),
  });
  const res = await handlers.POST(post({
    prompt: "use the ascii image (right) as projectile for Ryuda (left)",
    uploads: [{ name: "pic", png: `data:image/png;base64,${png}` }],
  }));
  assertEquals(res.status, 200);
  const events = await ndjson(res);
  const done = events.at(-1)!;
  assertEquals(done.type, "done", JSON.stringify(events));

  // The model was shown the picture as sent (less its data: prefix), then
  // told what upload.ts made of it.
  const first = (api.requests[0].messages as { content: Block[] }[])[0]
    .content;
  assertEquals(first.map((b) => b.type), ["text", "image", "text"]);
  assertEquals(first[0].text, 'Picture 0 "pic":');
  assertEquals((first[1].source as { data: string }).data, png);
  const uploads = await decodeUploads([{ name: "pic", png }]);
  assertEquals(uploads[0].analysis.regions.length, 2);
  assertStringIncludes(String(first[2].text), describeUploads(uploads));

  // The dry run came back with the body and the shot as two images.
  const result = (api.requests[1].messages as { content: Block[] }[]).at(-1)!
    .content[0] as { content: Block[]; is_error?: boolean };
  assertEquals(result.is_error, undefined, JSON.stringify(result.content));
  assertEquals(result.content.map((b) => b.type), ["text", "image", "image"]);

  // The card: the red block as the body, the black block as a white shot.
  const [proposal] = done.proposals as {
    png_base64: string;
    projectile: { png_base64: string; width_px: number; height_px: number };
    summary: { atlas: { frames: string[] }; unresolved: string[] };
  }[];
  assertEquals(proposal.summary.atlas.frames, ["pic_r0", "pic_r1"]);
  assertEquals(proposal.summary.unresolved, []);
  const body = await decoded(proposal.png_base64);
  assertEquals([body.width, body.height], [8, 8]);
  assertEquals([...body.data.slice(0, 4)], [200, 30, 30, 255]);
  const shot = await decoded(proposal.projectile.png_base64);
  assertEquals([shot.width, shot.height], [6, 4]);
  assertEquals(
    [proposal.projectile.width_px, proposal.projectile.height_px],
    [6, 4],
  );
  for (let i = 0; i < shot.data.length; i += 4) {
    if (shot.data[i + 3] === 0) continue;
    assertEquals([...shot.data.slice(i, i + 3)], [255, 255, 255]);
  }
});

// Needs upload.ts's decodeUploads.
Deno.test("pictures alone are a request: an empty box asks for a character from them", async () => {
  const { tools, contexts } = fakeTools();
  const api = scriptedApi([
    reply(
      [callTool("t1", "shmupx_create_character", { name: "pic" })],
      "tool_use",
    ),
  ]);
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter: new MemoryCounter(),
    fetch: api.fetch,
    listCatalog: () => Promise.resolve([]),
  });
  const png = await twoSubjects();
  const res = await handlers.POST(
    post({ prompt: "  ", uploads: [{ name: "pic", png }] }),
  );
  assertEquals(res.status, 200);
  await ndjson(res);
  const content = (api.requests[0].messages as { content: Block[] }[])[0]
    .content;
  assertStringIncludes(
    String(content.at(-1)!.text),
    `Request: ${PICTURE_PROMPT}`,
  );
  // The tool ran with the decoded picture in its context.
  const [picture] = contexts[0]?.uploads ?? [];
  assertExists(picture);
  assertEquals(picture.index, 0);
  assertEquals([picture.raster.width, picture.raster.height], [40, 20]);
  assertEquals(picture.png_base64, png);
});

// Needs upload.ts's decodeUploads.
Deno.test("PUBLISH decodes the same pictures again and re-runs the call with them", async () => {
  const { tools, calls, contexts } = fakeTools();
  const counter = new MemoryCounter();
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter,
    fetch: scriptedApi([]).fetch,
  });
  const png = await twoSubjects();
  const args = {
    name: "ryuda",
    anim: { idle: [{ upload: 0, region: 0 }] },
  };
  const res = await handlers.POST(post({
    publish: { tool: "shmupx_create_character", args },
    uploads: [{ name: "pic", png }],
  }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).applied, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.apply, true);
  const [picture] = contexts[0]?.uploads ?? [];
  assertExists(picture);
  assertEquals([picture.raster.width, picture.raster.height], [40, 20]);
  // Analysed exactly as the ask's were, so region 0 is the same rectangle.
  const [again] = await decodeUploads([{ name: "pic", png }]);
  assertEquals(picture.analysis, again.analysis);
});

Deno.test("PUBLISH with a picture that is not one runs nothing and counts nothing", async () => {
  const { tools, calls } = fakeTools();
  const t = Date.parse("2026-10-27T10:00:00Z");
  const counter = new MemoryCounter(() => t);
  const handlers = assistantHandlers({
    env: keyed(),
    tools,
    counter,
    fetch: scriptedApi([]).fetch,
    now: () => t,
  });
  const res = await handlers.POST(post({
    publish: { tool: "shmupx_create_character", args: { name: "ryuda" } },
    uploads: [{ png: "garbage!" }],
  }));
  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
  assertEquals(
    await counter.peek(`publish:5.5.5.5:${Math.floor(t / 3600_000)}`),
    0,
  );
});
