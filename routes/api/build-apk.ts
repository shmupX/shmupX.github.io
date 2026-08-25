import { define } from "../../utils.ts";
import { crossSiteGuard } from "../../lib/local-guards.ts";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.1.2";

// POST /api/build-apk — export a custom Firebase "Game" to an installable app.
//
// The build pipeline now lives IN this repo at tools/build-level and compiles
// cmg's own 2028-ai game (static/games/2028-ai) — there is no external 2019-es7
// checkout and no CMG_ES7_REPO env var any more. The level editor
// (static/editor/index.html) POSTs here; we spawn `node tools/build-level`,
// wait for it, and return the artifact path(s) + a log tail.
//
// LOCAL-ONLY: it spawns a subprocess and writes to disk, so it is refused on the
// read-only Deno Deploy origin. It runs under `deno task dev` and inside the
// packaged desktop binary — there the repo lives in a read-only deno-compile VFS
// that `node` can't execute against, so the handler first stages the embedded
// tool + game onto real disk (stageEmbeddedRuntime) and runs there. Either way a
// local Node + the platform toolchain (cordova/Android SDK, electron-builder)
// must be installed on the machine.

const PLATFORMS = new Set(["android", "ios", "linux", "all"]);

// Mirror the tool's slugify: keep the arg to a benign charset. Args are passed
// to Deno.Command as an array (no shell), so this is belt-and-suspenders.
function sanitizeLevelName(raw: string): string {
  return String(raw).replace(/[.#$/\[\]]/g, "_").replace(/[^\w \-]/g, "").trim()
    .slice(0, 64);
}

// Mirror tools/build-level/lib/slug.js slugify EXACTLY (incl. the "level"
// fallback) so findArtifacts looks in the same build/<slug>/dist the tool wrote.
function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) || "level";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch (_e) {
    return false;
  }
}

// True when running from a `deno compile` binary (the desktop app), whose
// modules live under a read-only `deno-compile-*` temp VFS rather than a real
// checkout. import.meta.url carries that marker — it's exactly the path that
// showed up in the old "build tool not found" error. Deno.stat can't tell VFS
// from real disk (an embedded file "exists"), so this is how we distinguish.
function isCompiledBinary(): boolean {
  return fromFileUrl(import.meta.url).replaceAll("\\", "/").includes(
    "/deno-compile-",
  );
}

// The root that holds tools/ + static/ — the layout tools/build-level assumes
// when it derives CMG_ROOT as __dirname/../.. .
//
// Depth is NOT fixed. In a source checkout under `deno task dev` this module is
// routes/api/build-apk.ts, two levels down. Once Vite bundles the server the
// same route lands in _fresh/server/assets/<chunk>.mjs — three levels down, and
// inside the packaged binary that's the read-only deno-compile VFS. The old
// hard-coded "../.." therefore resolved to <root>/_fresh in every bundled
// build, which is what produced the "path not found: .../_fresh/tools/
// build-level" export failure. Walk up until the tool actually shows up.
async function findRuntimeRoot(): Promise<string | null> {
  let dir = dirname(fromFileUrl(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (await pathExists(join(dir, "tools", "build-level", "index.js"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Recursively copy a directory tree from `src` to `dst`. Used to materialise the
// embedded tool + game out of the VFS onto the real filesystem, since `node` (a
// separate process) can't read Deno's virtual paths.
async function copyTree(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory) await copyTree(s, d);
    else if (entry.isFile) await Deno.writeFile(d, await Deno.readFile(s));
  }
}

// Materialise the embedded tools/build-level + static/games/2028-ai (+ the
// gamepad shim) into a reused real working dir and return its root, so the
// packaged desktop app can spawn `node tools/build-level` against real files.
// Re-copied each run so an app update propagates. The tool derives its game dir
// as <root>/static/games/2028-ai, so the layout here must mirror the repo.
async function stageEmbeddedRuntime(vfsRoot: string): Promise<string> {
  const tmp = Deno.env.get("TEMP") ?? Deno.env.get("TMPDIR") ?? "/tmp";
  const work = join(tmp, "cmg-build-level");
  await copyTree(
    join(vfsRoot, "tools", "build-level"),
    join(work, "tools", "build-level"),
  );
  await copyTree(
    join(vfsRoot, "static", "games", "2028-ai"),
    join(work, "static", "games", "2028-ai"),
  );
  // Loose files the tool reads straight off CMG_ROOT. Both are existsSync-
  // guarded on its side, so leaving one behind degrades the export silently
  // (no controller shim / a scene script's `import Phaser from "phaser"`
  // failing to resolve offline) rather than failing the build.
  for (
    const rel of [
      ["static", "gamepad-compatibility-plugin.js"],
      ["static", "phaser-plugins", "phaser-global.js"],
    ]
  ) {
    const src = join(vfsRoot, ...rel);
    if (!(await pathExists(src))) continue;
    const dst = join(work, ...rel);
    await Deno.mkdir(dirname(dst), { recursive: true });
    await Deno.writeFile(dst, await Deno.readFile(src));
  }
  return work;
}

// After a successful build, find the produced artifact(s) for the given slug.
// The tool writes to build/<slug>/dist/.
async function findArtifacts(
  cmgRoot: string,
  slug: string,
  platform: string,
): Promise<string[]> {
  const distDir = join(cmgRoot, "build", slug, "dist");
  if (!(await pathExists(distDir))) return [];
  const wantExt = platform === "linux"
    ? ".appimage"
    : platform === "ios"
    ? ".ipa"
    : ".apk";
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(distDir)) {
      if (!entry.isFile) continue;
      const lower = entry.name.toLowerCase();
      if (platform === "all" || lower.endsWith(wantExt)) {
        out.push(join(distDir, entry.name));
      }
    }
  } catch (_e) { /* dir vanished mid-read — treat as none */ }
  return out;
}

export const handler = define.handlers({
  async POST(ctx) {
    // Requiring a JSON body is not a CSRF defense: a cross-site page can post
    // text/plain without tripping a CORS preflight, and ctx.req.json() parses it
    // all the same. Since a hit here spawns the build tool and writes to disk,
    // gate on Fetch Metadata the way every other mutating local route does.
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
      return Response.json(
        {
          ok: false,
          error: "APK export is only available on a local install.",
        },
        { status: 403 },
      );
    }

    let body: { level?: string; platform?: string };
    try {
      body = await ctx.req.json();
    } catch (_e) {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }

    const level = sanitizeLevelName(body.level || "");
    if (!level) {
      return Response.json(
        { ok: false, error: "Missing or invalid 'level' name." },
        { status: 400 },
      );
    }
    const platform = String(body.platform || "android").toLowerCase();
    if (!PLATFORMS.has(platform)) {
      return Response.json(
        { ok: false, error: `Unknown platform '${platform}'.` },
        { status: 400 },
      );
    }

    // In a source checkout this is a real dir; in the packaged desktop binary
    // it's the read-only deno-compile VFS (see findRuntimeRoot).
    const moduleRoot = await findRuntimeRoot();
    if (!moduleRoot) {
      return Response.json({
        ok: false,
        error: "Build tool not found — tools/build-level is not embedded in " +
          "this build. Run the export from a source checkout (`deno task dev`).",
      }, { status: 500 });
    }

    // Where `node tools/build-level` actually runs. A source checkout runs in
    // place; the packaged binary first stages the embedded tool + game onto real
    // disk (node can't use a VFS path as its cwd).
    let runRoot = moduleRoot;
    if (isCompiledBinary()) {
      try {
        runRoot = await stageEmbeddedRuntime(moduleRoot);
      } catch (e) {
        return Response.json({
          ok: false,
          error: "Could not stage the build tool out of the packaged app: " +
            (e as Error).message +
            ". Run the export from a source checkout (`deno task dev`) instead.",
        }, { status: 500 });
      }
    }
    if (
      !(await pathExists(join(runRoot, "tools", "build-level", "index.js")))
    ) {
      return Response.json({
        ok: false,
        error: "Build tool not found. Run the export from a source checkout " +
          "(`deno task dev`).",
      }, { status: 500 });
    }

    // Pass the parent env through, defaulting the Android SDK location so a
    // fresh shell (where ANDROID_SDK_ROOT is unset) can still find it. Missing
    // toolchains surface as the tool's own error in the returned log.
    const env = Deno.env.toObject();
    if (platform === "android" || platform === "all") {
      if (!env.ANDROID_SDK_ROOT && !env.ANDROID_HOME) {
        const home = env.HOME || env.USERPROFILE || "";
        const guesses = home
          ? [
            join(home, "Library", "Android", "sdk"),
            join(home, "AppData", "Local", "Android", "Sdk"),
          ]
          : [];
        for (const guess of guesses) {
          if (await pathExists(guess)) {
            env.ANDROID_SDK_ROOT = guess;
            env.ANDROID_HOME = guess;
            break;
          }
        }
      }
    }

    let stdout = "", stderr = "", code = -1;
    try {
      const cmd = new Deno.Command("node", {
        args: ["tools/build-level", level, platform],
        cwd: runRoot,
        env,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      code = result.code;
      stdout = new TextDecoder().decode(result.stdout);
      stderr = new TextDecoder().decode(result.stderr);
    } catch (e) {
      return Response.json({
        ok: false,
        error: `Failed to spawn build (is Node installed and on PATH?): ${
          (e as Error).message
        }`,
      }, { status: 500 });
    }

    const log = (stdout + "\n" + stderr).slice(-6000);
    if (code !== 0) {
      return Response.json({
        ok: false,
        error: `build-level exited ${code} for "${level}" (${platform}).`,
        log,
      }, { status: 500 });
    }

    const artifacts = await findArtifacts(runRoot, slugFor(level), platform);
    return Response.json({
      ok: true,
      level,
      platform,
      slug: slugFor(level),
      artifacts,
      log,
    });
  },
});
