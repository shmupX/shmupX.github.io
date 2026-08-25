# tools/build-level

Export a single Firebase level as a standalone **Cordova** (Android APK / iOS
project) or **Electron** (Linux AppImage) app — built entirely from cmg's own
in-repo game. There is **no external 2019-es7 checkout** and **no `CMG_ES7_REPO`**
env var. This is what the level editor's "Export to APK" button
(`static/editor/index.html` → `routes/api/build-apk.ts`) drives.

## Run

```
node tools/build-level <levelName> <android|ios|linux|all> [flags]
```

Flags: `--stage-only` (stage `www/` and stop — no native compile),
`--out <dir>`, `--package-id <id>`, `--skip-bgm`,
`--level-file <path>` (read the level from a local JSON file instead of Firebase).

Output goes to `build/<slug>/` (git-ignored): `www/` (staged app),
`cordova/` or `electron/` (native project), and `dist/` (the artifact).

## How it works

1. **Fetch** the level record from the evil-invaders RTDB (`lib/fetch-level.js`).
2. **Stage `www/`** (`lib/stage.js`) from `static/games/2028-ai/`:
   - the whole `assets/` tree + `lib/phaser.min.js`,
   - `game.bundle.js` — cmg's own game bundle, **patched for offline hosting**:
     asset base → document-relative, level URL → local `foo.json`,
   - `foo.json` — the full level record (kept intact so its `atlasImageDataURL`
     can be merged over the base atlas **at runtime** by the level-loader
     ScenePlugin; there is no offline atlas-baking step),
   - `phaser-game.html` — an offline port of `routes/games/2028-ai.tsx`
     (`lib/shell-template.js`).
3. **Download** custom BGM into `www/assets/custom-bgm/` (`lib/download-bgm.js`).
4. **Rebrand** `config.xml` / electron `package.json` / `manifest.json` with the
   level name + `com.easierbycode.<slug>` (`lib/rebrand.js`).
5. **Compile** via `cordova` / `electron-builder` (`lib/run-cordova.js`,
   `lib/run-electron.js`), sourcing project scaffolding from `scaffold/`.

Because the exported app reuses the same `game.bundle.js`, assets, and
level-loader plugin as the hosted game, any level that plays in cmg's 2028-ai
game renders identically in the exported build.

## Requirements

- **Node** on PATH (the route spawns `node`).
- **Android:** cordova + Android SDK + Gradle + JDK, `ANDROID_SDK_ROOT`.
- **Linux:** `electron-builder` toolchain (installed on demand into the build).
- Runs from a **source checkout** (`deno task dev`), not the packaged desktop
  binary (a `deno compile` VFS can't be a `node` working directory).

## `scaffold/`

Cordova/Electron project files vendored from 2019-es7 (config.xml, electron
main/preload/afterPack, hooks, res, icons, plugins, manifest.json). These are
data inputs to the native build, not game code. Excluded from deno fmt/lint via
`deno.json`.
