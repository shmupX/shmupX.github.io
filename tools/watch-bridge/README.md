# Watch bridge

The desktop side of the shmupX watch: reads what you dictate on the wrist, runs
it through an agent that has the character MCP attached, writes the sprite back
where the watch can see it.

```
watch                         firebase rtdb                desktop
─────                         ─────────────                ───────
dictate ──────────────────>  /utterances  ──────────────>  bridge.mjs
                                                               │
                                                        claude -p + MCP
                                                               │
sprite  <─────────────────   /preview     <────────────────────┤
states  <─────────────────   /agents      <────────────────────┘
```

The watch app itself (a Wear OS project, `shmupx-watch`) lives outside this
repo; this directory is its `daemon/`, kept here because everything it talks to
— the four `shmupx_*_object` tools in `mcp/` — is here.

## Run it

```bash
cd tools/watch-bridge
cp .env.example .env && $EDITOR .env && source .env
cp mcp.json.example mcp.json && $EDITOR mcp.json   # the absolute path to this checkout
npm start
```

Node 20+. No dependencies — `fetch`, SSE parsing and the stream reader are
standard library. `npm test` (or `deno task watch-bridge:test` from the repo
root) runs the tests, also with no dependencies.

`mcp.json` registers `mcp/server.ts`, which is a Deno program:
`deno run -A --node-modules-dir=none <checkout>/mcp/server.ts`. The path has to
be absolute, and `deno` has to be on the PATH of whatever starts the bridge. The
example names the server `shmupx-character`, the same name the repo's own
`.mcp.json` and the `edit-object` skill use, so the tool names the model reads
about are the tool names it has.

## How a sentence becomes a sprite

Each utterance runs as

```
echo "<what you said>" | claude -p --mcp-config mcp.json --strict-mcp-config \
       --allowedTools "mcp__shmupx-character__*" \
       --output-format stream-json --verbose --max-turns 12
```

Three of those flags are the difference between a preview and nothing:

- **`--output-format stream-json --verbose`.** The `json` format answers with a
  single object holding the agent's final _text_ — the tool results, which are
  where the sprite is, never reach this process. stream-json prints one JSON
  event per line for the whole turn, and every tool result arrives as a `user`
  event carrying a `tool_result` block. `--verbose` is required with stream-json
  in print mode.
- **`--allowedTools "mcp__shmupx-character__*"`.** `claude -p` cannot ask
  anybody for permission, so a tool that is not pre-approved is _denied_, not
  approved: the agent answers in prose that it could not run it and no preview
  arrives. The bridge builds this rule from the server names in `mcp.json`, so a
  second server is pre-approved the same way.
- **`--strict-mcp-config`.** Without it the CLI also loads the user's global MCP
  servers and, when run from the repo root, the repo's own `.mcp.json` copy of
  this server — two copies of every tool, only one of them covered by the allow
  rule. The model may pick the other and be denied.

The sentence goes in on stdin rather than as an argument: _"-make it bigger"_ as
an argument is `error: unknown option '-make it bigger'`.

`extractPreview()` in `bridge.mjs` walks the events and takes the **last** tool
result whose JSON carries a `png_base64` — a turn is usually _list, get, update
(dry), update (apply), preview_, and the last picture is the one that matches
what the catalog now holds. It reads both the `tool_result` block's content and
the event's `tool_use_result`, so a change in how Claude Code delivers either
does not blind it. The sprite is written even when the turn ends badly
(`--max-turns` reached, an execution error): the catalog may well already have
been written, and the picture is what says so. Those endings arrive as result
events with no `result` text at all, only `errors`, which is where the reason
shown on the wrist comes from. While the agent works, each tool call it makes is
written to the agent's `detail`, so the watch shows _shmupx_update_object…_
rather than just _working_.

## What the watch sees

- **`/preview`** —
  `{object_id, label, png_base64, width_px, height_px,
  revision, note}`, one
  PUT per sprite. `revision` is the write time in milliseconds: the watch caches
  the decoded bitmap on (`object_id`, `revision`), so it has to change on every
  write and survive a daemon restart — a counter that started over at 1 showed
  the old sprite after one.
- **`/agents`** — one PATCH of the parent,
  `{<agent id>: {label, state,
  detail, workspace, updated_at}}`. The watch
  reads every event on that stream as the whole map, whatever the event's path,
  so a PUT of the child would reach it at `/<id>` and be read as _no agents_.
  States are `idle`, `working` (first with what was said, then with each tool as
  it is called) and `done` (with the sprite's note). An error is reported as
  `idle` with an `Error: …` detail — not `blocked`, which on the watch means a
  question waiting for a tap, with approve / deny buttons that nothing here
  could answer.
- **`/utterances`** — read, never written. Whatever is already there when the
  bridge connects is history, remembered and left alone: everything ever
  dictated stays under that node, and replaying it would run every past edit
  again, compounding on art already edited. Sentences run one at a time, in the
  order they arrive.

## What it expects from the MCP

A tool result whose JSON has, at the top level:

```json
{
  "object_id": "dezaBoss1",
  "label": "dezaBoss1",
  "png_base64": "iVBORw0KGgo...",
  "width_px": 64,
  "height_px": 128,
  "note": "art ×1.25 · → red"
}
```

`png_base64` is bare — no `data:` prefix. Both `shmupx_preview_object` and
`shmupx_update_object` answer in exactly this shape (a dry run too); the watch's
`PreviewFrame` reads exactly these keys.

## The tool surface

Voice is bad at precision and good at intent, so the MCP exposes the catalog the
way a person speaks about it rather than by id:

- `shmupx_list_objects` — every character with a role and an ordinal; `query`
  resolves "the second boss", "deza boss 1", "akuma's bullets" to one object
- `shmupx_get_object` — its current state, and which dials the runtime would
  actually notice
- `shmupx_update_object` — aggression / silhouette / palette dials; a dry run by
  default, with a PNG of the result either way
- `shmupx_preview_object` — render what's there now

The agent's side of that conversation is `.claude/skills/edit-object/SKILL.md`,
which `claude -p` picks up from the checkout it runs in — this directory counts,
so `cd tools/watch-bridge && npm start` is enough.

## Environment

| variable              | default             | what                                  |
| --------------------- | ------------------- | ------------------------------------- |
| `SHMUPX_RTDB_URL`     | _(required)_        | the Realtime Database                 |
| `SHMUPX_RTDB_AUTH`    | empty               | `?auth=` token, if the rules need one |
| `SHMUPX_BUILDER_CODE` | `default`           | the `?builder=` code the watch uses   |
| `SHMUPX_AGENT_ID`     | `character-preview` | the agent's key under `/agents`       |
| `SHMUPX_MCP_CONFIG`   | `./mcp.json`        | the MCP config handed to `claude`     |
| `SHMUPX_CLAUDE_BIN`   | `claude`            | the CLI to spawn                      |
| `SHMUPX_MAX_TURNS`    | `12`                | `--max-turns`, a runaway guard        |

## Safety note

Every tool in `mcp.json` runs without a prompt, and `shmupx_update_object` with
`apply: true` writes to a catalog that is shared and open-write. That is what
makes hands-free editing work, and it is also why this should point at a copy of
the catalog (`SHMUPX_DB` on the server side) rather than the one everybody uses
— or at least why the agent should be told to `saveAs` rather than edit in
place.
