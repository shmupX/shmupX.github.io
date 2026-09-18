#!/usr/bin/env node
/**
 * shmupX watch bridge — desktop side.
 *
 * Subscribes to the utterances the watch writes, hands each one to an agent
 * that has the shmupX character MCP registered, and writes the result back
 * where the watch can see it.
 *
 *   watch --> /builders/<code>/utterances   (this daemon reads)
 *   agent --> /builders/<code>/preview      (this daemon writes)
 *   agent --> /builders/<code>/agents       (this daemon patches {<id>: …})
 *
 * Deliberately kept to Node's standard library plus one spawn, so there's
 * nothing to install and nothing to keep up to date.
 *
 * The agent is `claude -p` in stream-json mode. That choice is load-bearing:
 * `--output-format json` answers with ONE object holding the agent's final
 * text and nothing else, so the tool results — where the sprite actually is —
 * never reach this process. stream-json emits one JSON event per line for
 * the whole turn, including a `user` event for every tool result, and those
 * are what extractPreview() reads.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const RTDB_URL = process.env.SHMUPX_RTDB_URL;
const BUILDER = process.env.SHMUPX_BUILDER_CODE ?? "default";
const AUTH = process.env.SHMUPX_RTDB_AUTH ?? "";
const AGENT_ID = process.env.SHMUPX_AGENT_ID ?? "character-preview";
const MCP_CONFIG = process.env.SHMUPX_MCP_CONFIG ?? "./mcp.json";
const CLAUDE_BIN = process.env.SHMUPX_CLAUDE_BIN ?? "claude";
const MAX_TURNS = process.env.SHMUPX_MAX_TURNS ?? "12";
const RETRY_MS = 3000;

/** ─── the transcript ──────────────────────────────────────────────────── */

/**
 * One line of stream-json, or null for a blank line or anything that is not
 * JSON (a stray line of prose, a truncated last line).
 */
export function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const event = JSON.parse(trimmed);
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

/** The content blocks of an assistant or user event, whatever their shape. */
function blocksOf(event) {
  const content = event?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Is this the sprite payload the watch draws? */
function isPreview(value) {
  return !!value && typeof value === "object" &&
    typeof value.png_base64 === "string" && value.png_base64.length > 0;
}

/**
 * The preview payload inside one tool result, if there is one.
 *
 * The MCP answers every object tool with a JSON text block whose top level
 * carries `png_base64` (shmupx_preview_object, shmupx_update_object), and
 * Claude Code hands that back in two places: the `tool_result` block's
 * `content` — a string, or an array of text blocks — and, on the event
 * itself, `tool_use_result`, the tool's structured output. Either is enough;
 * both are read so a change in one does not blind the bridge.
 */
export function previewFrom(event) {
  if (event?.type !== "user") return null;

  const structured = event.tool_use_result;
  for (const candidate of [structured, structured?.structuredContent]) {
    if (isPreview(candidate)) return candidate;
  }

  for (const block of blocksOf(event)) {
    if (block?.type !== "tool_result") continue;
    const texts = typeof block.content === "string"
      ? [block.content]
      : Array.isArray(block.content)
      ? block.content.map((part) => part?.text).filter((t) =>
        typeof t === "string"
      )
      : [];
    for (const text of texts) {
      try {
        const parsed = JSON.parse(text);
        if (isPreview(parsed)) return parsed;
      } catch {
        // A tool result that is not JSON is not a sprite.
      }
    }
  }
  return null;
}

/**
 * The sprite to show for a whole turn: the LAST preview any tool returned.
 *
 * A turn is usually "list, get, update (dry), update (apply), preview", and
 * the last picture is the one that matches what the catalog now holds.
 */
export function extractPreview(events) {
  let latest = null;
  for (const event of events) {
    const preview = previewFrom(event);
    if (preview) latest = preview;
  }
  return latest;
}

/** The tools an assistant event asks for, by name. */
export function toolCallsIn(event) {
  if (event?.type !== "assistant") return [];
  return blocksOf(event)
    .filter((block) =>
      block?.type === "tool_use" && typeof block.name === "string"
    )
    .map((block) => block.name);
}

/** "mcp__shmupx-character__shmupx_update_object" → "shmupx_update_object". */
export function shortToolName(name) {
  const parts = String(name).split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : name;
}

/**
 * What the agent had to say for itself when the turn ended.
 *
 * A `success` result carries the final text in `result`. The error subtypes
 * (error_max_turns, error_during_execution, …) carry no `result` at all —
 * only `errors: string[]` — and reading `result` alone would report them as
 * a bare "Agent error".
 */
export function resultSummary(result) {
  if (typeof result?.result === "string" && result.result.trim()) {
    return result.result.trim();
  }
  if (Array.isArray(result?.errors) && result.errors.length) {
    return result.errors.map(String).join("; ");
  }
  return "";
}

/** ─── the agent ───────────────────────────────────────────────────────── */

/** The server names an MCP config registers. */
export function mcpServerNames(configText) {
  try {
    const parsed = JSON.parse(configText);
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/**
 * The --allowedTools rule that lets the agent call a server's tools without
 * asking. `claude -p` cannot ask anybody, so a tool that is not allowed is
 * DENIED, not approved — the agent then answers in prose that it could not
 * run the tool, and no preview ever arrives.
 */
export function allowedToolsFor(serverNames) {
  return serverNames.map((name) => `mcp__${name}__*`).join(",");
}

function readConfig() {
  try {
    return readFileSync(MCP_CONFIG, "utf8");
  } catch {
    return null;
  }
}

/**
 * The argv for one turn. The prompt is NOT in it — it goes in on stdin,
 * because a dictated sentence that happens to start with "-" is otherwise
 * parsed as an option ("error: unknown option '-make it bigger'").
 *
 * `--strict-mcp-config` matters as much as the allow rule: without it the
 * CLI also loads the user's global servers and, when run from the repo root,
 * the repo's own `.mcp.json` copy of this server. Only the servers named in
 * `config` are pre-approved, so a second copy under another name is a set of
 * tools the agent can see, may pick, and will be denied.
 */
export function agentArgs(
  config,
  { mcpConfig = MCP_CONFIG, maxTurns = MAX_TURNS } = {},
) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    // stream-json in print mode refuses to run without this.
    "--verbose",
    "--max-turns",
    String(maxTurns),
  ];
  if (config !== null) {
    args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
    const allowed = allowedToolsFor(mcpServerNames(config));
    if (allowed) args.push("--allowedTools", allowed);
  }
  return args;
}

/**
 * Runs one prompt through Claude Code non-interactively with the MCP attached,
 * streaming every event to `onEvent` as it arrives and resolving with all of
 * them plus the final `result` event.
 */
export function runAgent(prompt, { onEvent = () => {} } = {}) {
  const args = agentArgs(readConfig());

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let result = null;
    let err = "";

    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);

    // If the CLI dies before reading its prompt, the write fails; the close
    // handler below reports that, so here it is only kept from throwing.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseStreamLine(line);
      if (!event) return;
      events.push(event);
      if (event.type === "result") result = event;
      try {
        onEvent(event);
      } catch (e) {
        console.warn("onEvent threw:", e);
      }
    });

    child.on("close", (code) => {
      if (result) return resolve({ events, result });
      reject(
        new Error(
          err.trim() || `claude exited ${code} without a result event`,
        ),
      );
    });
  });
}

/** ─── the database ────────────────────────────────────────────────────── */

const base = (RTDB_URL ?? "").replace(/\/$/, "");
const qs = AUTH ? `?auth=${encodeURIComponent(AUTH)}` : "";
const path = (p) => `${base}/builders/${BUILDER}/${p}.json${qs}`;

/** One REST write. Never rejects: a lost write is logged, not fatal. */
async function write(p, body, method = "PUT") {
  try {
    const res = await fetch(path(p), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`${method} ${p} -> ${res.status}`);
    return res;
  } catch (e) {
    console.warn(`${method} ${p} failed: ${e.message ?? e}`);
    return null;
  }
}

/**
 * The agent's state, as the watch reads it. The watch streams `/agents` and
 * reads EVERY event's data as the whole `{<id>: agent}` map, whatever the
 * event's path — so this is a PATCH of the parent, which reaches it at
 * path "/", and not a PUT of the child, which would reach it at "/<id>" and
 * be read as an empty map.
 *
 * The writes are chained so they land in the order they were made: a
 * "working" note fired from the middle of a turn must never overtake the
 * "done" that ends it.
 */
let states = Promise.resolve();
function setState(state, detail = null) {
  const record = {
    label: AGENT_ID,
    state,
    detail,
    workspace: "shmupX",
    updated_at: Date.now(),
  };
  states = states.then(() => write("agents", { [AGENT_ID]: record }, "PATCH"));
  return states;
}

/**
 * The `/preview` record for one sprite. `revision` is the watch's bitmap
 * cache key together with `object_id`, so it has to change on every write
 * and survive a daemon restart — a per-process counter did neither.
 */
export function previewRecord(preview, fallbackNote, now = Date.now()) {
  return {
    object_id: preview.object_id ?? "object",
    label: preview.label ?? preview.object_id ?? "Object",
    png_base64: preview.png_base64,
    width_px: preview.width_px ?? 16,
    height_px: preview.height_px ?? 16,
    revision: now,
    note: preview.note ?? String(fallbackNote ?? "").slice(0, 120),
  };
}

async function handleUtterance(utterance) {
  const text = typeof utterance?.text === "string" ? utterance.text.trim() : "";
  if (!text) return;

  console.log(`> ${text}`);
  await setState("working", text);

  try {
    const { events, result } = await runAgent(text, {
      onEvent(event) {
        // Keep the wrist informed of what the agent is doing, not just that
        // it is doing something.
        const calls = toolCallsIn(event).map(shortToolName);
        if (calls.length) setState("working", `${calls.join(", ")}…`);
      },
    });

    const preview = extractPreview(events);
    const summary = resultSummary(result);

    // Whatever the turn's ending, a sprite the tools already returned is
    // real — the catalog may well have been written — so it is shown first.
    if (preview) {
      await write("preview", previewRecord(preview, summary || text));
    }

    if (result.is_error) {
      console.error(summary || "agent reported an error");
      // Not "blocked": on the watch that state means a question waiting for
      // a tap, with approve / deny buttons that nothing here could answer.
      await setState(
        "idle",
        `Error: ${summary || "agent failed"}`.slice(0, 120),
      );
      return;
    }

    await setState(
      "done",
      (preview
        ? preview.note ?? "Preview updated"
        : summary || "No preview returned").slice(0, 120),
    );
  } catch (e) {
    console.error(e);
    await setState("idle", `Error: ${e.message ?? e}`.slice(0, 120));
  }
}

/**
 * One agent at a time. Two sentences in quick succession are two edits to
 * the same catalog, and their states, previews and writes must not
 * interleave.
 */
let queue = Promise.resolve();
function enqueue(utterance) {
  queue = queue.then(() => handleUtterance(utterance)).catch((e) =>
    console.error(e)
  );
}

/**
 * One SSE frame from RTDB → `{event, path, data}`, or null for anything that
 * is not a `put` or `patch` (keep-alive, cancel, auth_revoked, garbage).
 */
export function parseSseFrame(chunk) {
  const event = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim();
  const data = chunk.match(/^data:\s*(.+)$/m)?.[1];
  if (!data || (event !== "put" && event !== "patch")) return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object"
      ? { event, path: parsed.path, data: parsed.data }
      : null;
  } catch {
    return null;
  }
}

/**
 * Which entries of one `/utterances` frame have not been seen yet.
 *
 * A frame at "/" is the whole node — on connect, and again on every
 * reconnect — and a deeper path is one new push. Everything returned is
 * marked seen; the caller decides whether it is work or history.
 */
export function takeNew(frame, seen) {
  const { path: p, data } = frame;
  if (!data || typeof data !== "object") return [];
  const entries = p === "/"
    ? Object.entries(data)
    : [[String(p ?? "").replace(/^\//, ""), data]];
  const fresh = [];
  for (const [key, value] of entries) {
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push([key, value]);
  }
  return fresh;
}

/** Minimal RTDB SSE reader — same protocol the watch uses. */
async function stream(p, onFrame) {
  const res = await fetch(path(p), {
    headers: { accept: "text/event-stream" },
  });
  // A bad token is a 401 in text/plain that closes at once; without this it
  // would be read as an empty stream and reconnected to with no delay.
  if (!res.ok) {
    const body = (await res.text()).trim().slice(0, 200);
    throw new Error(`GET ${p} -> ${res.status} ${body}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const frame = parseSseFrame(chunk);
      if (frame) onFrame(frame);
    }
  }
  // A clean close is still a disconnect; the caller's retry delay applies.
  throw new Error(`stream ${p} closed`);
}

async function main() {
  if (!RTDB_URL) {
    console.error("Set SHMUPX_RTDB_URL — see tools/watch-bridge/.env.example.");
    process.exit(1);
  }
  console.log(`shmupX bridge · builder ${BUILDER} · agent ${AGENT_ID}`);
  const config = readConfig();
  if (config === null) {
    console.warn(
      `No MCP config at ${MCP_CONFIG} — the agent will run without your tools.`,
    );
  } else {
    const names = mcpServerNames(config);
    console.log(
      names.length
        ? `MCP servers: ${names.join(", ")} (tools pre-approved as ${
          allowedToolsFor(names)
        })`
        : `${MCP_CONFIG} registers no mcpServers — nothing will be pre-approved.`,
    );
  }

  await setState("idle");

  // Everything ever dictated is still under /utterances, and the stream's
  // first frame is the whole node. That is history, not work: replaying it
  // would run every past edit again, compounding on art already edited.
  const seen = new Set();
  let primed = false;
  for (;;) {
    try {
      await stream("utterances", (frame) => {
        const fresh = takeNew(frame, seen);
        if (!primed && frame.path === "/") {
          primed = true;
          if (fresh.length) {
            console.log(`${fresh.length} earlier utterance(s) left as history`);
          }
          return;
        }
        for (const [, value] of fresh) enqueue(value);
      });
    } catch (e) {
      console.warn(
        `stream dropped, retrying in ${RETRY_MS / 1000}s:`,
        e.message,
      );
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

// Importable for its parsers (bridge.test.mjs); runs only as the entrypoint.
if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
