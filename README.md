# shmupX — codemonkey.games

The final CMG launcher, rebuilt as **shmupX**: a Deno Fresh 2 + Vite app for
[Deno Deploy](https://deploy.deno.com) with a single built-in game — the shmupX
level editor, a standalone version of the cmg level editor.

The `.sav` / `game.json` pipeline (Dezaemon 2 Saturn save parsing, decoding,
mapping, atlas packing, schema validation) lives in the
[`packages/shmup-engine`](packages/shmup-engine) workspace member, published to
JSR as `@shmupx/shmup-engine`. The editor consumes it as a same-origin bundle
built by `deno task engine:bundle` into `static/engine/shmup-engine.js`.

## Layout

- `main.ts`, `routes/`, `vite.config.ts` — the Fresh shell (launcher marker
  injection + static files + fs routes).
- `svelte-src/` — the launcher dashboard (Svelte 5), esbuild-bundled at build
  time into `static/dashboard.bundle.js` by `deno task dashboard:build`.
- `data/games.json` → `deno task games:manifest` → `static/games.manifest.json`
  — the OTA manifest the dashboard fetches (push to main = every client sees the
  new list, no rebuild).
- `static/editor/` — the shmupX level editor (single-file app).
- `static/games/2028-ai/` — the editor's base game + play runtime (the Phaser 4
  engine that runs editor-authored levels).
- `packages/shmup-engine/` — the JSR module: everything for editing/exporting
  `.sav` and `game.json` games.

## Tasks

```sh
deno task dev      # vite dev server (+ ngrok tunnel when available)
deno task build    # manifest + dashboard + engine bundle + vite build
deno task start    # serve the production build (_fresh/server.js)
deno task test     # shmup-engine tests
deno task check    # fmt + lint + type-check
```

Requires Deno canary (`deno upgrade canary`).

## Deploy

Deno Deploy git integration: the app is linked to this repo in the Deploy
dashboard (the app slug decides the default `<app>.<org>.deno.net` URL — it is
not set from this file), and every push to main triggers a build.

The `deploy` block in `deno.json` is what that build follows:

- `install` — `deno install` (npm deps for vite/esbuild/svelte).
- `build` — `deno task build` (manifest → BGM → dashboard bundle → engine bundle
  → `vite build`).
- `runtime.entrypoint` — `./_fresh/server.js`, the built server that wraps the
  Fresh handler in `{ fetch }`. This must be set explicitly: `main.ts` exports a
  Fresh `App`, which has no `fetch` and cannot serve traffic, so leaving Deploy
  to auto-detect an entrypoint yields a build that never produces a working
  deployment.

Point the `codemonkey.games` domain at the app in the Deploy dashboard.
