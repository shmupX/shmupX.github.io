// lib/export-build.ts — build one cloud level into an installable app, on the
// machine this process runs on.
//
// Extracted from routes/api/build-apk.ts so the same code serves two callers:
// that route (the editor's EXPORT button, pressed on a local host) and
// lib/export-worker.ts (this desktop picking up a job somebody queued from a
// phone or the hosted site). Everything that decides HOW a target is built on
// this host — which tree the tool runs against, whether this is a checkout or
// the packaged app, where the toolchain lives — is here; the callers only
// differ in where the request came from and where the artifact goes next.
//
// PS2 is the odd one out: it has no Node half at all. It is pure Deno
// (lib/ps2), so it runs in-process. Every other target spawns
// `node tools/build-level`, which needs a local Node plus the platform
// toolchain (cordova + the Android SDK, electron-builder) installed.
//
// LOCAL-ONLY by nature: it spawns subprocesses and writes to disk. Under `deno
// task dev` the repo is a real checkout; inside the packaged desktop binary it
// is a read-only deno-compile VFS that `node` cannot execute against, so the
// embedded tool + game are first staged onto real disk (stageEmbeddedRuntime)
// and run there.

import { dirname, fromFileUrl, join } from "@std/path";
import { buildPs2 } from "./ps2/build.ts";
import { packagedBuildRoot } from "./build-workspace.ts";

export const EXPORT_PLATFORMS = new Set([
  "android",
  "ios",
  "linux",
  "windows",
  // Built in-process by lib/ps2 rather than by tools/build-level.
  "ps2",
  // Whichever desktop app this host can build natively — resolved by
  // resolveDesktopPlatform rather than passed through, so the artifact lookup
  // (and the platform echoed back) knows which extension to look for.
  "desktop",
  "all",
]);

/** A build that failed for a reason the caller should relay as-is. */
export class ExportError extends Error {
  constructor(
    message: string,
    /** HTTP status the API route answers with. */
    readonly status = 500,
    /** Tail of the build output, when there was any. */
    readonly log = "",
  ) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportRequest {
  level: string;
  platform: string;
  /**
   * The level record to build, instead of the one `level` names in Firebase.
   *
   * A Dezaemon cart open in the editor is not a cloud level and never will be:
   * it was imported from a .sav (a file, or the shelf) and lives in the
   * browser, so there is no `/levels/<name>` for a build to fetch. The editor
   * therefore hands the record over directly — the same shape it would have
   * saved — and it is written to disk here for `--level-file`. That is the one
   * thing that lets the .SAV half of the editor export to all five platforms.
   */
  levelRecord?: unknown;
  /** Called with each line of build output as it is produced. */
  log?: (line: string) => void;
  /** Aborting kills a running `node tools/build-level`. */
  signal?: AbortSignal;
}

export interface Ps2Outcome {
  name: string;
  dir: string;
  appDir: string | null;
  isoPath: string | null;
}

export interface ExportOutcome {
  level: string;
  /** The concrete platform built — "desktop" has been resolved by now. */
  platform: string;
  slug: string;
  /** Paths on this machine's disk. */
  artifacts: string[];
  /** Tail of the build output. */
  log: string;
  /**
   * Named rather than positional, so a caller can offer the disc and the USB
   * folder as separate downloads. PS2 builds only.
   */
  ps2?: Ps2Outcome;
}

/**
 * Keep a level name to a benign charset. Args reach the tool through
 * Deno.Command as an array (no shell), so this is belt-and-suspenders — but it
 * is also the gate that decides whether a build happens at all, since
 * `runExport` rejects an empty result with a 400.
 *
 * It used to strip `[^\w \-]`, and `\w` without the `u` flag is ASCII only: a
 * title written in kana, hanzi, Cyrillic or Greek was emptied here and refused
 * before it ever reached the builder, so "Export to APK" simply did not work
 * for most of the community's own games. Unicode letters, numbers and combining
 * marks are content and are kept; what is dropped is what makes a name
 * dangerous as a path or an RTDB key — separators, control characters, and the
 * `. # $ / [ ]` the Realtime Database forbids (mapped to `_`, as before).
 * The name is XML-escaped again downstream by tools/build-level/lib/rebrand.js
 * before it reaches config.xml.
 */
export function sanitizeLevelName(raw: string): string {
  return String(raw)
    .replace(/[.#$/\[\]]/g, "_")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}_ \-]/gu, "")
    .trim()
    .slice(0, 64);
}

/**
 * Mirror tools/build-level/lib/slug.js `slugify` EXACTLY, so findArtifacts
 * looks in the same build/<slug>/dist the tool wrote. The two are cross-checked
 * by tests/build_level_slug_test.ts, which runs the Node copy and compares.
 *
 * See that file for why some slugs carry an 8-hex digest: a name the slug
 * cannot spell (any title with no ASCII alphanumerics — 111 of the 228 Japanese
 * titles in the shipped catalogue) used to collapse to the bare constant
 * "level", so every one of them shared one build tree and one artifact name.
 */
export function slugFor(name: string): string {
  const raw = String(name ?? "");
  if (!raw.trim()) return "level";
  const letters = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const slug = letters.slice(0, SLUG_MAX);
  const lost = raw.replace(SEPARATORS, "").replace(/[a-zA-Z0-9]+/g, "");
  if (slug && !lost && letters.length <= SLUG_MAX) return slug;
  return `${slug || "level"}-${nameDigest(raw)}`;
}

/** ASCII whitespace and punctuation: they separate words rather than spell them. */
const SEPARATORS = /[\s!-\/:-@\[-`{-~]+/g;
const SLUG_MAX = 30;

/** FNV-1a as 8 hex digits — the digest tools/build-level/lib/slug.js appends. */
function nameDigest(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function resolveDesktopPlatform(platform: string): string {
  if (platform !== "desktop") return platform;
  return Deno.build.os === "windows" ? "windows" : "linux";
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
export function isCompiledBinary(): boolean {
  return fromFileUrl(import.meta.url).replaceAll("\\", "/").includes(
    "/deno-compile-",
  );
}

// The root that holds tools/ + static/ — the layout tools/build-level assumes
// when it derives CMG_ROOT as __dirname/../.. .
//
// Depth is NOT fixed. In a source checkout this module is lib/export-build.ts,
// one level down. Once Vite bundles the server the same code lands in
// _fresh/server/assets/<chunk>.mjs — three levels down, and inside the packaged
// binary that's the read-only deno-compile VFS. Walk up until the tool actually
// shows up.
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

// The PS2 target needs a different marker: it has no Node half, so what it
// looks for is the base game lib/ps2 stages every export out of. That tree is
// embedded in the packaged app as well as sitting in a checkout, which is why
// the marker is the game rather than lib/ps2/runtime-entry.ts — the packaged
// app builds without the sources at all (see ps2Runtime below).
async function findPs2Root(): Promise<string | null> {
  let dir = dirname(fromFileUrl(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (
      await pathExists(join(dir, "static", "games", "2028-ai", "foo.json")) &&
      await pathExists(
        join(dir, "static", "games", "2028-ai", "assets", "game.json"),
      )
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The base game, on REAL disk.
//
// lib/ps2 reads most of the tree itself, and Deno reads the VFS happily — but
// the sound packs shell out to ffmpeg with a source path, and a separate
// process cannot see Deno's VFS at all. Without this the packaged app built a
// perfectly good disc with every sound missing ("no source for 60 key(s)"),
// which is the same reason `node tools/build-level` gets staged out next door.
// Re-copied each run so an app update propagates.
async function stagePs2Game(vfsRoot: string): Promise<string> {
  const root = join(packagedBuildRoot(), "src");
  await copyTree(
    join(vfsRoot, "static", "games", "2028-ai"),
    join(root, "static", "games", "2028-ai"),
  );
  return root;
}

// What the packaged app exports with instead of the sources.
//
// A source checkout compiles lib/ps2/runtime-entry.ts with `deno bundle` on
// every build, so an edit to the runtime lands in the next disc. The packaged
// binary has neither those sources nor a Deno CLI to run, so
// scripts/build-desktop.ts compiles the runtime once at packaging time and
// embeds it — together with the AthenaEnv interpreter, which otherwise costs a
// download. Both live where a checkout's own cache keeps them, so the paths are
// the same either way.
async function ps2Runtime(
  vfsRoot: string,
): Promise<{ runtimeJs: Uint8Array; athenaElf: string | null } | null> {
  const cache = join(vfsRoot, "build", "ps2", ".cache");
  const bundle = join(cache, "main.js");
  if (!(await pathExists(bundle))) return null;
  const elf = join(cache, "athena.elf");
  return {
    runtimeJs: await Deno.readFile(bundle),
    athenaElf: (await pathExists(elf)) ? elf : null,
  };
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
  // Loose files the tool reads straight off CMG_ROOT. Each is existsSync-
  // guarded on its side, so leaving one behind degrades the export silently
  // (no controller shim / a scene script's `import Phaser from "phaser"`
  // failing to resolve offline / no leaderboard) rather than failing the build.
  for (
    const rel of [
      ["static", "gamepad-compatibility-plugin.js"],
      ["static", "phaser-plugins", "phaser-global.js"],
      // Leaderboard credentials — without these the exported app plays fine but
      // scores nowhere.
      ["static", "firebase-config.js"],
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
    : platform === "windows"
    ? ".exe"
    : platform === "ios"
    ? ".ipa"
    : platform === "ps2"
    ? ".iso"
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

// Where the Android SDK is, when the environment does not say. A fresh shell
// (where ANDROID_SDK_ROOT is unset) can still find the default install.
//
// Exported because scripts/build-desktop.ts spawns the same Node tool for
// `deno task build:android` and needs the same default; a second copy there
// would be one more place for the search list to drift.
export async function guessAndroidSdk(
  env: Record<string, string>,
): Promise<string | null> {
  if (env.ANDROID_SDK_ROOT) return env.ANDROID_SDK_ROOT;
  if (env.ANDROID_HOME) return env.ANDROID_HOME;
  const home = env.HOME || env.USERPROFILE || "";
  if (!home) return null;
  for (
    const guess of [
      join(home, "Library", "Android", "sdk"),
      join(home, "AppData", "Local", "Android", "Sdk"),
      join(home, "Android", "Sdk"),
    ]
  ) {
    if (await pathExists(guess)) return guess;
  }
  return null;
}

// Read a child's stream line by line, handing each non-blank line on as it
// completes, and return the whole text for the log tail.
//
// `stop` is what keeps an Android build from hanging forever. `node
// tools/build-level` shells out to gradle, which leaves DAEMONS running — they
// inherit the pipes, so stdout and stderr stay open long after the tool itself
// has exited and the .apk is sitting on disk. Waiting for the streams to end
// therefore waits on a process nobody is waiting for: the build succeeds and
// the request never returns. So the caller stops the read once the child is
// gone and the tail has had a moment to flush.
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  stop?: Promise<unknown>,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const STOP = Symbol("stop");
  let all = "";
  let buf = "";
  try {
    for (;;) {
      const next = stop
        ? await Promise.race([reader.read(), stop.then(() => STOP)])
        : await reader.read();
      if (next === STOP) break;
      const { done, value } = next as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      all += text;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    }
  } finally {
    // Releases this end of the pipe whether the stream ended on its own or a
    // daemon is still holding the other end open.
    try {
      await reader.cancel();
    } catch (_e) { /* already closed */ }
  }
  if (buf.trim()) onLine(buf);
  return all;
}

async function runPs2Export(
  level: string,
  levelFile: string | null,
  log: (line: string) => void,
): Promise<ExportOutcome> {
  const root = await findPs2Root();
  if (!root) {
    throw new ExportError(
      "Could not locate the base game the PS2 build stages from " +
        "(static/games/2028-ai).",
    );
  }
  // Packaged: the tree is a read-only VFS, so the runtime comes pre-compiled
  // out of it and everything written goes to real disk. A checkout keeps its
  // own behaviour — bundling from source, writing into build/ps2 — so an
  // edit to lib/ps2 still shows up in the very next export.
  const packaged = isCompiledBinary();
  const prebuilt = packaged ? await ps2Runtime(root) : null;
  if (packaged && !prebuilt) {
    throw new ExportError(
      "This build of the app carries no PS2 runtime, so it cannot " +
        "export for the PS2. Rebuild it without --no-export-tools, or run " +
        "the export from a source checkout (`deno task dev`).",
    );
  }
  const workRoot = packaged ? join(packagedBuildRoot(), "ps2") : null;
  const lines: string[] = [];
  try {
    const built = await buildPs2({
      root: packaged ? await stagePs2Game(root) : root,
      levelName: level,
      // A record handed over by the editor wins over the cloud lookup the name
      // would otherwise trigger — see ExportRequest.levelRecord.
      ...(levelFile ? { levelFile } : {}),
      ...(workRoot
        ? { outDir: workRoot, cacheDir: join(workRoot, ".cache") }
        : {}),
      ...(prebuilt
        ? { runtimeJs: prebuilt.runtimeJs, athenaElf: prebuilt.athenaElf }
        : {}),
      // The disc is what every follow-up needs: it is the artifact an emulator
      // boots, in-browser or otherwise. The athena.elf folder alone is a
      // USB-stick artifact — Play! can load an ELF, but AthenaEnv would then
      // have no device to read main.js and assets/ from, so the disc is the
      // only self-contained form.
      iso: true,
      log: (message) => {
        lines.push(message);
        log(message);
      },
    });
    return {
      level,
      platform: "ps2",
      slug: slugFor(level),
      artifacts: built.artifacts,
      ps2: {
        name: built.name,
        dir: built.dir,
        appDir: built.appDir,
        isoPath: built.isoPath,
      },
      log: lines.join("\n"),
    };
  } catch (e) {
    if (e instanceof ExportError) throw e;
    throw new ExportError(
      `PS2 export failed: ${(e as Error).message}`,
      500,
      lines.join("\n"),
    );
  }
}

async function runNodeExport(
  level: string,
  platform: string,
  levelFile: string | null,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<ExportOutcome> {
  // In a source checkout this is a real dir; in the packaged desktop binary
  // it's the read-only deno-compile VFS (see findRuntimeRoot).
  const moduleRoot = await findRuntimeRoot();
  if (!moduleRoot) {
    throw new ExportError(
      "Build tool not found — tools/build-level is not embedded in " +
        "this build. Run the export from a source checkout (`deno task dev`).",
    );
  }

  // Where `node tools/build-level` actually runs. A source checkout runs in
  // place; the packaged binary first stages the embedded tool + game onto real
  // disk (node can't use a VFS path as its cwd).
  let runRoot = moduleRoot;
  if (isCompiledBinary()) {
    try {
      runRoot = await stageEmbeddedRuntime(moduleRoot);
    } catch (e) {
      throw new ExportError(
        "Could not stage the build tool out of the packaged app: " +
          (e as Error).message +
          ". Run the export from a source checkout (`deno task dev`) instead.",
      );
    }
  }
  if (!(await pathExists(join(runRoot, "tools", "build-level", "index.js")))) {
    throw new ExportError(
      "Build tool not found. Run the export from a source checkout " +
        "(`deno task dev`).",
    );
  }

  // Pass the parent env through, defaulting the Android SDK location so a
  // fresh shell (where ANDROID_SDK_ROOT is unset) can still find it. Missing
  // toolchains surface as the tool's own error in the returned log.
  const env = Deno.env.toObject();
  if (platform === "android" || platform === "all") {
    const sdk = await guessAndroidSdk(env);
    if (sdk) {
      env.ANDROID_SDK_ROOT = sdk;
      env.ANDROID_HOME = sdk;
    }
  }

  let stdout = "", stderr = "", code = -1;
  try {
    const args = ["tools/build-level", level, platform];
    if (levelFile) args.push("--level-file", levelFile);
    const child = new Deno.Command("node", {
      args,
      cwd: runRoot,
      env,
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    // The child exiting is the end of the build; the pipes outliving it is
    // gradle's daemons, not output still to come (see readLines). Give the
    // tail a beat to flush after the exit, then stop reading.
    const exited = child.status.then(async (s) => {
      await new Promise((r) => setTimeout(r, 1500));
      return s;
    });
    const [out, err, status] = await Promise.all([
      readLines(child.stdout, log, exited),
      readLines(child.stderr, log, exited),
      child.status,
    ]);
    stdout = out;
    stderr = err;
    code = status.code;
  } catch (e) {
    throw new ExportError(
      `Failed to spawn build (is Node installed and on PATH?): ${
        (e as Error).message
      }`,
    );
  }

  const tail = (stdout + "\n" + stderr).slice(-6000);
  if (signal?.aborted) {
    throw new ExportError("The build was stopped.", 500, tail);
  }
  if (code !== 0) {
    throw new ExportError(
      `build-level exited ${code} for "${level}" (${platform}).`,
      500,
      tail,
    );
  }

  const artifacts = await findArtifacts(runRoot, slugFor(level), platform);
  return { level, platform, slug: slugFor(level), artifacts, log: tail };
}

/**
 * Build `level` for `platform` on this machine.
 *
 * Validates the request the way the API route always has (a bad name or an
 * unknown platform is an ExportError with a 4xx status), resolves "desktop" to
 * what this host builds natively, and dispatches to the in-process PS2 builder
 * or to `node tools/build-level`.
 */
export async function runExport(req: ExportRequest): Promise<ExportOutcome> {
  const log = req.log ?? (() => {});
  const level = sanitizeLevelName(req.level || "");
  if (!level) {
    throw new ExportError("Missing or invalid 'level' name.", 400);
  }
  let platform = String(req.platform || "android").toLowerCase();
  if (!EXPORT_PLATFORMS.has(platform)) {
    throw new ExportError(`Unknown platform '${platform}'.`, 400);
  }
  platform = resolveDesktopPlatform(platform);
  const levelFile = req.levelRecord === undefined
    ? null
    : await stageLevelRecord(level, req.levelRecord, log);
  if (platform === "ps2") return await runPs2Export(level, levelFile, log);
  return await runNodeExport(level, platform, levelFile, log, req.signal);
}

/**
 * Write a caller-supplied level record where both builders can read it.
 *
 * Under the same roof as everything else a build produces, so it is cleaned up
 * with them and a packaged app (whose tree is a read-only VFS) has somewhere
 * writable to put it.
 */
async function stageLevelRecord(
  level: string,
  record: unknown,
  log: (line: string) => void,
): Promise<string> {
  if (!record || typeof record !== "object") {
    throw new ExportError(
      "'levelRecord' must be the level object itself.",
      400,
    );
  }
  if (!Array.isArray((record as { enemylist?: unknown }).enemylist)) {
    throw new ExportError(
      "'levelRecord' has no enemylist — that is not a level.",
      400,
    );
  }
  const dir = join(packagedBuildRoot(), "records");
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, `${slugFor(level)}.json`);
  const json = JSON.stringify(record);
  await Deno.writeTextFile(path, json);
  log(
    `Building from the record the editor supplied (${
      (json.length / 1048576).toFixed(2)
    } MB) rather than from the cloud.`,
  );
  return path;
}

// ── What this host can build ──────────────────────────────────────────────────

export interface ExportCapabilities {
  /** Platform → whether this host looks able to build it. */
  platforms: Record<string, boolean>;
  /** What was found or missed, for the status readout. */
  notes: string[];
}

// `cmd --version`, or null when the command is not there (or hangs).
async function commandVersion(
  cmd: string,
  args: string[] = ["--version"],
): Promise<string | null> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      signal: AbortSignal.timeout(8000),
    }).output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout).trim().split("\n")[0] || "ok";
  } catch {
    return null;
  }
}

/**
 * A best-effort probe of the toolchains on this machine, so the queue can say
 * which targets this desktop is likely to build before anyone waits on one.
 * Advisory only — a build that this says is possible can still fail, and the
 * job's own log then says why.
 */
export async function detectExportCapabilities(): Promise<ExportCapabilities> {
  const notes: string[] = [];
  const platforms: Record<string, boolean> = {
    android: false,
    ios: false,
    linux: false,
    windows: false,
    ps2: false,
  };

  const ps2Root = await findPs2Root();
  if (!ps2Root) notes.push("PS2: base game not found");
  else if (isCompiledBinary() && !(await ps2Runtime(ps2Root))) {
    notes.push("PS2: this build of the app carries no PS2 runtime");
  } else platforms.ps2 = true;

  const tool = (await findRuntimeRoot()) !== null;
  if (!tool) notes.push("tools/build-level not found");
  const node = await commandVersion("node");
  if (node) notes.push(`node ${node}`);
  else notes.push("node not on PATH");
  const ready = tool && node !== null;

  const env = Deno.env.toObject();
  const sdk = ready ? await guessAndroidSdk(env) : null;
  if (ready && !sdk) notes.push("Android SDK not found");
  platforms.android = ready && sdk !== null;

  platforms.ios = ready && Deno.build.os === "darwin";
  platforms.linux = ready;
  // electron-builder rcedits a Windows .exe through wine on every other host.
  if (ready) {
    if (Deno.build.os === "windows") platforms.windows = true;
    else {
      const wine = await commandVersion("wine");
      platforms.windows = wine !== null;
      if (!wine) notes.push("wine not on PATH (needed for Windows builds)");
    }
  }
  return { platforms, notes };
}
