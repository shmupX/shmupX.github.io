// The web build of a PS2 export: a build's own tree, plus the page that runs
// it in a browser.
//
// `writeWebBuild(buildDir, outDir)` takes a `deno task build:ps2` folder —
// athena.ini, main.js, assets/… — and writes beside a copy of it:
//
//   host.js     lib/ps2/web-host.ts and everything it pulls in (svelte-ps2's
//               browser runtime, Phaser), bundled into one module
//   index.html  the page: a screen, the controls, and host.js pointed at the
//               tree with `data-build="./"`
//   files.json  the tree's file list, since a page cannot list a directory
//
// The tree is copied as the build wrote it, so the page plays the very main.js
// a console boots. Only what a console alone opens is left out — the ELF and
// SYSTEM.CNF (web-files.ts HARDWARE_ONLY). Serve outDir over HTTP and open
// index.html; a file:// page cannot import modules.

import { basename, dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { localGraph } from "./build.ts";
import {
  bootScript,
  parseAthenaIni,
  type WebManifest,
  webManifest,
} from "./web-files.ts";
import { harborRoot, repoRoot } from "../repo-root.ts";

export interface WebIndexOptions {
  /** What the tab and the heading call the game. */
  title: string;
  /** The build folder relative to the page. Default `./`. */
  build?: string;
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** The page that boots host.js against a build folder. */
export function webIndexHtml(options: WebIndexOptions): string {
  const title = escapeHtml(options.title);
  const build = escapeHtml(options.build ?? "./");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — PlayStation 2</title>
    <meta name="description" content="${title} for PlayStation 2, running its AthenaEnv build in the browser." />
    <style>
      :root {
        color-scheme: dark;
        --bg: #000;
        --fg: #d8ecd2;
        --dim: #84977f;
        --edge: #2b3a29;
        --error: #ff8a80;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        min-height: 100%;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.45 ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
      }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        min-height: 100vh;
        padding: 16px;
      }
      h1 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      #ps2 {
        position: relative;
        width: min(100%, calc((100vh - 150px) * 640 / 448), 1280px);
        aspect-ratio: 640 / 448;
        border: 1px solid var(--edge);
      }
      #ps2 canvas {
        display: block;
      }
      .ps2-status {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: grid;
        place-items: center;
        padding: 12px;
        color: var(--dim);
        white-space: pre-wrap;
        text-align: center;
        pointer-events: none;
      }
      .ps2-status:empty {
        display: none;
      }
      .ps2-status.ps2-error {
        place-items: start;
        overflow: auto;
        color: var(--error);
        font-size: 12px;
        text-align: left;
        pointer-events: auto;
      }
      .ps2-hud {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(100% + 4px);
        color: var(--dim);
        font-size: 12px;
        text-align: center;
      }
      .keys {
        max-width: 640px;
        margin: 8px 0 0;
        color: var(--dim);
        font-size: 12px;
        text-align: center;
      }
      kbd {
        padding: 0 4px;
        border: 1px solid var(--edge);
        border-radius: 3px;
        color: var(--fg);
        font: inherit;
      }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <main id="ps2" data-build="${build}"></main>
    <p class="keys">
      <kbd>←↑↓→</kbd> move · <kbd>Z</kbd>/<kbd>Space</kbd> fire ·
      <kbd>C</kbd> special · <kbd>X</kbd> back · <kbd>Enter</kbd> START ·
      <kbd>Shift</kbd> SELECT = turbo · <kbd>Q</kbd>/<kbd>E</kbd> = L1/R1 —
      hold <kbd>Q</kbd>+<kbd>E</kbd> while pressing START or SELECT on the title
      for god mode. A gamepad works too.
    </p>
    <script type="module" src="host.js"></script>
  </body>
</html>
`;
}

export interface BundleWebHostOptions {
  /** The checkout to bundle in — where node_modules/phaser is. */
  root?: string;
  /** Where host.js is cached between builds. Default <root>/build/ps2/.cache. */
  cacheDir?: string;
  log?: (message: string) => void;
}

/**
 * Bundle lib/ps2/web-host.ts into one self-contained browser module.
 *
 * Cached the way buildRuntimeBundle caches main.js: the key is harbor's
 * deno.json (the svelte-ps2 and Phaser pins) plus every local module the host
 * reaches, so editing any of them rebuilds it and nothing else does. Needs the
 * Deno CLI, and Phaser installed in the checkout (`deno install`).
 */
export async function bundleWebHost(
  options: BundleWebHostOptions = {},
): Promise<Uint8Array> {
  const log = options.log ?? (() => {});
  const root = resolve(options.root ?? repoRoot());
  const cacheDir = resolve(
    options.cacheDir ?? join(root, "build", "ps2", ".cache"),
  );
  const entry = join(harborRoot(), "lib", "ps2", "web-host.ts");
  const out = join(cacheDir, "web-host.js");
  const stamp = join(cacheDir, "web-host.js.key");
  const parts = [await Deno.readTextFile(join(harborRoot(), "deno.json"))];
  for (const path of await localGraph(entry)) {
    parts.push(path, await Deno.readTextFile(path));
  }
  const key = parts.join("\n");

  try {
    if (await Deno.readTextFile(stamp) === key) {
      log("  web host: reusing the cached bundle");
      return await Deno.readFile(out);
    }
  } catch {
    // No usable cache — bundle.
  }

  await ensureDir(cacheDir);
  log("  web host: bundling svelte-ps2's browser runtime and Phaser");
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--quiet",
      "--platform=browser",
      "--format=esm",
      "--minify",
      "--output",
      out,
      entry,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      `deno bundle of the web host failed:\n${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  await Deno.writeTextFile(stamp, key);
  return await Deno.readFile(out);
}

export interface WriteWebBuildOptions {
  /** The page's title. Default: the build folder's name. */
  title?: string;
  /** An already-bundled host.js; skips `bundleWebHost`. */
  hostJs?: Uint8Array;
  /** Passed to bundleWebHost. */
  root?: string;
  cacheDir?: string;
  log?: (message: string) => void;
}

export interface WriteWebBuildResult {
  outDir: string;
  /** The page itself. */
  index: string;
  manifest: WebManifest;
  /** Bytes of the build copied, host.js not included. */
  bytes: number;
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
async function walkTree(
  dir: string,
): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const visit = async (at: string) => {
    for await (const entry of Deno.readDir(at)) {
      const full = join(at, entry.name);
      if (entry.isDirectory) await visit(full);
      else if (entry.isFile) {
        out.push({
          path: relative(dir, full).replace(/\\/g, "/"),
          size: (await Deno.stat(full)).size,
        });
      }
    }
  };
  await visit(dir);
  return out;
}

/**
 * Copy a PS2 build's tree into `outDir` with host.js, index.html and
 * files.json beside it: a folder that plays the build when served.
 *
 * Writing into a folder an earlier call wrote is safe: what the old files.json
 * listed and the new one does not is removed, and nothing else in `outDir` is
 * touched.
 */
export async function writeWebBuild(
  buildDir: string,
  outDir: string,
  options: WriteWebBuildOptions = {},
): Promise<WriteWebBuildResult> {
  const from = resolve(buildDir);
  const to = resolve(outDir);
  const inside = relative(from, to);
  if (inside === "" || (!inside.startsWith("..") && !/^[a-z]:/i.test(inside))) {
    throw new Error(
      `writeWebBuild: ${to} is inside the build it copies (${from})`,
    );
  }

  let ini: Record<string, string>;
  try {
    ini = parseAthenaIni(await Deno.readTextFile(join(from, "athena.ini")));
  } catch {
    throw new Error(
      `writeWebBuild: ${from} has no athena.ini — point it at the app folder ` +
        "`deno task build:ps2` writes (the one holding main.js and assets/)",
    );
  }
  const script = bootScript(ini);
  const manifest = webManifest(await walkTree(from));
  if (!manifest.files.some((file) => file.path === script)) {
    throw new Error(`writeWebBuild: ${from} has no ${script}`);
  }

  const hostJs = options.hostJs ??
    await bundleWebHost({
      root: options.root,
      cacheDir: options.cacheDir,
      log: options.log,
    });

  await ensureDir(to);
  const keep = new Set(manifest.files.map((file) => file.path));
  try {
    const old = JSON.parse(
      await Deno.readTextFile(join(to, "files.json")),
    ) as WebManifest;
    for (const file of old.files ?? []) {
      if (!keep.has(file.path)) {
        await Deno.remove(join(to, file.path)).catch(() => {});
      }
    }
  } catch {
    // Nothing written here before.
  }

  let bytes = 0;
  for (const file of manifest.files) {
    const target = join(to, file.path);
    await ensureDir(dirname(target));
    await Deno.copyFile(join(from, file.path), target);
    bytes += file.size;
  }
  await Deno.writeFile(join(to, "host.js"), hostJs);
  const index = join(to, "index.html");
  await Deno.writeTextFile(
    index,
    webIndexHtml({ title: options.title ?? basename(from) }),
  );
  await Deno.writeTextFile(
    join(to, "files.json"),
    JSON.stringify(manifest, null, 1) + "\n",
  );
  return { outDir: to, index, manifest, bytes };
}
