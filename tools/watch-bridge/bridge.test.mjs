// The contracts the bridge has with its neighbours, each pinned as a literal:
// where the sprite is in a stream-json transcript (and the single `json`
// object it is NOT in), what the CLI is invoked with, what the watch reads,
// and how RTDB's stream is read.
//
//   npm test        (node --test, no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentArgs,
  allowedToolsFor,
  extractPreview,
  mcpServerNames,
  parseSseFrame,
  parseStreamLine,
  previewFrom,
  previewRecord,
  resultSummary,
  shortToolName,
  takeNew,
  toolCallsIn,
} from "./bridge.mjs";

const SERVER = "shmupx-character";
const tool = (name) => `mcp__${SERVER}__${name}`;

const sprite = (note, id = "dezaBoss1") => ({
  object_id: id,
  label: id,
  png_base64: "iVBORw0KGgo=",
  width_px: 64,
  height_px: 128,
  note,
});

/** A `user` event the way stream-json carries a tool result back to Claude. */
const toolResult = (payload, { asString = false, extra = {} } = {}) => ({
  type: "user",
  session_id: "s",
  uuid: "u",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: asString
        ? JSON.stringify(payload)
        : [{ type: "text", text: JSON.stringify(payload) }],
    }],
  },
  ...extra,
});

const toolUse = (...names) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: names.map((name, i) => ({
      type: "tool_use",
      id: `toolu_${i}`,
      name,
      input: {},
    })),
  },
});

test("a tool result carrying png_base64 is a preview, as text blocks or a string", () => {
  assert.deepEqual(previewFrom(toolResult(sprite("idle"))), sprite("idle"));
  assert.deepEqual(
    previewFrom(toolResult(sprite("idle"), { asString: true })),
    sprite("idle"),
  );
});

test("the event's own tool_use_result is read too, plain or under structuredContent", () => {
  const bare = toolResult({ ok: true }, {
    extra: { tool_use_result: sprite("bare") },
  });
  assert.equal(previewFrom(bare).note, "bare");
  // The shape the CLI actually builds for an MCP result: the content beside
  // the server's structuredContent.
  const nested = toolResult({ ok: true }, {
    extra: {
      tool_use_result: {
        content: JSON.stringify(sprite("nested")),
        structuredContent: sprite("nested"),
      },
    },
  });
  assert.equal(previewFrom(nested).note, "nested");
});

test("results that are not a sprite are not a preview", () => {
  // A listing, an empty picture, an error string, prose, the final result.
  assert.equal(previewFrom(toolResult({ count: 27, objects: [] })), null);
  assert.equal(
    previewFrom(toolResult({ ...sprite("x"), png_base64: "" })),
    null,
  );
  assert.equal(
    previewFrom({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "Error: no such object" }],
      },
    }),
    null,
  );
  assert.equal(
    previewFrom({
      type: "assistant",
      message: {
        content: [{ type: "text", text: JSON.stringify(sprite("x")) }],
      },
    }),
    null,
  );
  assert.equal(
    previewFrom({ type: "result", result: JSON.stringify(sprite("x")) }),
    null,
  );
  assert.equal(previewFrom(null), null);
});

test("extractPreview takes the LAST preview of the turn", () => {
  const events = [
    { type: "system", subtype: "init" },
    toolUse(tool("shmupx_list_objects")),
    toolResult({ resolved: { id: "dezaBoss1" } }),
    toolUse(tool("shmupx_update_object")),
    toolResult(sprite("art ×1.25 · dry")),
    toolUse(tool("shmupx_update_object")),
    toolResult(sprite("art ×1.25")),
    toolUse(tool("shmupx_preview_object")),
    toolResult(sprite("idle 1/2 · dezaBoss1_0.gif")),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Done." }] },
    },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ];
  assert.equal(extractPreview(events).note, "idle 1/2 · dezaBoss1_0.gif");
  assert.equal(extractPreview(events.slice(0, 3)), null);
  assert.equal(extractPreview([]), null);
});

test("the single-object `json` format has no tool results, which is why the bridge streams", () => {
  // What `--output-format json` prints: one result object, final text only.
  const only = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "I previewed dezaBoss1; the note was 'idle 1/2'.",
  };
  assert.equal(extractPreview([only]), null);
});

test("parseStreamLine tolerates lines that are not events", () => {
  assert.deepEqual(parseStreamLine('{"type":"system","subtype":"init"}\n'), {
    type: "system",
    subtype: "init",
  });
  assert.equal(parseStreamLine(""), null);
  assert.equal(parseStreamLine("not an event"), null);
  assert.equal(parseStreamLine('{"type":"result", "truncated'), null);
  assert.equal(parseStreamLine("42"), null);
});

test("the turn's summary comes from `result`, or from `errors` when the subtype is an error", () => {
  assert.equal(
    resultSummary({ subtype: "success", is_error: false, result: " Done. " }),
    "Done.",
  );
  // The error subtypes carry no `result` key at all.
  assert.equal(
    resultSummary({
      subtype: "error_max_turns",
      is_error: true,
      errors: ["Reached maximum number of turns (12)"],
    }),
    "Reached maximum number of turns (12)",
  );
  assert.equal(
    resultSummary({ subtype: "error_during_execution", is_error: true }),
    "",
  );
  assert.equal(resultSummary(null), "");
});

test("tool calls are read off assistant events and shortened for the wrist", () => {
  assert.deepEqual(
    toolCallsIn(
      toolUse(tool("shmupx_list_objects"), tool("shmupx_update_object")),
    ),
    [tool("shmupx_list_objects"), tool("shmupx_update_object")],
  );
  assert.deepEqual(toolCallsIn(toolResult(sprite("x"))), []);
  assert.equal(
    shortToolName(tool("shmupx_update_object")),
    "shmupx_update_object",
  );
  assert.equal(shortToolName("Read"), "Read");
});

test("the MCP config decides which tools are pre-approved", () => {
  const config = JSON.stringify({
    mcpServers: {
      [SERVER]: { command: "deno", args: [] },
      other: { command: "x" },
    },
  });
  assert.deepEqual(mcpServerNames(config), [SERVER, "other"]);
  assert.equal(
    allowedToolsFor([SERVER, "other"]),
    `mcp__${SERVER}__*,mcp__other__*`,
  );
  assert.equal(allowedToolsFor([]), "");
  assert.deepEqual(mcpServerNames("not json"), []);
  assert.deepEqual(mcpServerNames("{}"), []);
});

test("the CLI is invoked in stream-json, strictly on our MCP config, with the prompt kept out of argv", () => {
  const config = JSON.stringify({
    mcpServers: { [SERVER]: { command: "deno" } },
  });
  const args = agentArgs(config, { mcpConfig: "mcp.json", maxTurns: 12 });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "12",
    "--mcp-config",
    "mcp.json",
    "--strict-mcp-config",
    "--allowedTools",
    `mcp__${SERVER}__*`,
  ]);
  // No positional: a sentence starting with "-" would be read as an option.
  assert.ok(
    !args.some((a) =>
      !a.startsWith("-") && a !== "12" && a !== "stream-json" &&
      a !== "mcp.json" && a !== `mcp__${SERVER}__*`
    ),
  );
  // No config file: no MCP flags, and nothing pre-approved.
  assert.deepEqual(
    agentArgs(null, { maxTurns: 3 }),
    ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "3"],
  );
  // A config that registers nothing still gets --strict-mcp-config, so the
  // user's global servers stay out.
  assert.deepEqual(agentArgs("{}", { mcpConfig: "m.json", maxTurns: 1 }), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "1",
    "--mcp-config",
    "m.json",
    "--strict-mcp-config",
  ]);
});

test("the /preview record carries exactly what the watch reads, with a revision that moves", () => {
  const record = previewRecord(sprite("art ×1.25"), "fallback", 1700000000000);
  assert.deepEqual(record, {
    object_id: "dezaBoss1",
    label: "dezaBoss1",
    png_base64: "iVBORw0KGgo=",
    width_px: 64,
    height_px: 128,
    revision: 1700000000000,
    note: "art ×1.25",
  });
  const sparse = previewRecord({ png_base64: "AAAA" }, "what was said", 5);
  assert.equal(sparse.object_id, "object");
  assert.equal(sparse.label, "Object");
  assert.equal(sparse.width_px, 16);
  assert.equal(sparse.note, "what was said");
  assert.equal(sparse.revision, 5);
});

test("RTDB frames: put and patch are read, everything else is dropped", () => {
  assert.deepEqual(
    parseSseFrame('event: put\ndata: {"path":"/","data":{"a":{"text":"hi"}}}'),
    { event: "put", path: "/", data: { a: { text: "hi" } } },
  );
  assert.deepEqual(
    parseSseFrame('event: patch\ndata: {"path":"/-Nx","data":{"text":"yo"}}'),
    { event: "patch", path: "/-Nx", data: { text: "yo" } },
  );
  assert.equal(parseSseFrame("event: keep-alive\ndata: null"), null);
  assert.equal(parseSseFrame("event: cancel\ndata: null"), null);
  assert.equal(
    parseSseFrame("event: auth_revoked\ndata: credential is no longer valid"),
    null,
  );
  assert.equal(parseSseFrame(""), null);
  assert.equal(parseSseFrame("event: put\ndata: not json"), null);
});

test("takeNew: the whole node on connect, one push per deeper path, nothing twice", () => {
  const seen = new Set();
  const history = takeNew(
    {
      event: "put",
      path: "/",
      data: { a: { text: "old 1" }, b: { text: "old 2" } },
    },
    seen,
  );
  assert.deepEqual(history.map(([k]) => k), ["a", "b"]);
  // A new dictation arrives at its own path…
  assert.deepEqual(
    takeNew({ event: "put", path: "/c", data: { text: "new" } }, seen),
    [["c", { text: "new" }]],
  );
  // …and a reconnect's whole node yields only what has not been seen.
  assert.deepEqual(
    takeNew(
      {
        event: "put",
        path: "/",
        data: { a: {}, b: {}, c: {}, d: { text: "gap" } },
      },
      seen,
    ),
    [["d", { text: "gap" }]],
  );
  // Nothing: a deleted node, a field edit under a seen push.
  assert.deepEqual(takeNew({ event: "put", path: "/", data: null }, seen), []);
  assert.deepEqual(
    takeNew({ event: "patch", path: "/c", data: { text: "edited" } }, seen),
    [],
  );
});
