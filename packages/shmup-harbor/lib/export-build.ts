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

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { buildZip, treeEntries } from "./ps2/zip.ts";
import { buildPs2 } from "./ps2/build.ts";
import { packagedBuildRoot, stagedRuntimeRoot } from "./build-workspace.ts";
import { repoRoot } from "./repo-root.ts";
import { forceImportedNoStory } from "./imported-level.ts";

export const EXPORT_PLATFORMS: Set<string> = new Set([
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
   * What was produced, when it is not simply "the app, ready to install" — the
   * one sentence the editor should show instead of announcing a finished app.
   *
   * Set for an iOS build off a Mac, which stops at an Xcode project. Without it
   * the only honest options were to fail a build that did everything it could
   * or to call a project an app, and the UI chose the second for months.
   */
  note?: string;
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

// The directory that HOLDS tools/build-level — the tool's own parent, which is
// not the same thing as the root it builds into (see runExportTool).
//
// Depth is NOT fixed and neither is the suffix. In a checkout the tool sits at
// packages/shmup-harbor/tools/build-level and this module is one level above it
// under the same member; once Vite bundles the server the same code lands in
// _fresh/server/assets/<chunk>.mjs, from where only the checkout root is ever
// walked past; and the packaged binary lays both out in a read-only
// deno-compile VFS with the repo's shape. Walk up, and at each step try the
// tool where a checkout keeps it as well as directly underneath — the second is
// what answers for the bundled server and for the staged copy the packaged app
// writes (stageEmbeddedRuntime), which mirrors the repo rather than the member.
const TOOL_PARENTS = [".", join("packages", "shmup-harbor")];

async function findRuntimeRoot(): Promise<string | null> {
  let dir = dirname(fromFileUrl(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const under of TOOL_PARENTS) {
      const parent = resolve(dir, under);
      if (await pathExists(join(parent, "tools", "build-level", "index.js"))) {
        return parent;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
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

/**
 * Loose files the Node tool reads straight off the root it derives, as
 * repo-relative path segments. They live at the CHECKOUT root, not under
 * packages/shmup-harbor — which is why stageEmbeddedRuntime reads them from
 * gameVfsRoot rather than from the tree the tool itself came out of.
 *
 * Every one is existsSync-guarded on the tool's side, so a file missing from
 * the packaged app degrades the export SILENTLY — no controller shim, or a
 * scene script's `import Phaser from "phaser"` failing to resolve offline, or
 * no leaderboard, or no EXTRACT MODE — rather than failing the build. Nothing
 * downstream can tell you a name is missing here, which is why the list is one
 * constant rather than two: scripts/build-desktop.ts turns it into the
 * `deno compile --include` arguments that put the files in the binary's VFS,
 * and stageEmbeddedRuntime below copies the same names back out onto real
 * disk. When those were two hand-kept lists, extract-mode.js was added to the
 * tool and to neither of them, and every app exported from inside the packaged
 * app lost EXTRACT MODE for as long as that lasted.
 */
export const EMBEDDED_LOOSE_FILES: readonly string[][] = [
  ["static", "gamepad-compatibility-plugin.js"],
  // Shim the offline shell's import map points "phaser" at.
  ["static", "phaser-plugins", "phaser-global.js"],
  // Leaderboard credentials — without these the exported app plays fine but
  // scores nowhere.
  ["static", "firebase-config.js"],
  // EXTRACT MODE — the exported app's PAUSE panel publishes sprites to the
  // shared character library through it.
  ["static", "phaser-plugins", "extract-mode.js"],
];

// Materialise the embedded tools/build-level + static/games/2028-ai (+ the
// loose files above) into a reused real working dir and return its root, so the
// packaged desktop app can spawn `node tools/build-level` against real files.
// Re-copied each run so an app update propagates. The tool derives its own root
// by walking up for the base game, so the layout written here must mirror the
// repo — which is exactly why the two sources are separate arguments: inside
// the VFS the tool lives under packages/shmup-harbor and the game does not.
async function stageEmbeddedRuntime(
  toolVfsRoot: string,
  gameVfsRoot: string,
): Promise<string> {
  const work = stagedRuntimeRoot();
  await copyTree(
    join(toolVfsRoot, "tools", "build-level"),
    join(work, "tools", "build-level"),
  );
  const vfsRoot = gameVfsRoot;
  await copyTree(
    join(vfsRoot, "static", "games", "2028-ai"),
    join(work, "static", "games", "2028-ai"),
  );
  for (const rel of EMBEDDED_LOOSE_FILES) {
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
//
// What a target's artifact is NAMED is the tool's business, not this function's.
// Matching on one hard-coded extension per platform meant that every time the
// builder renamed its output this quietly returned nothing — and "nothing" is
// indistinguishable here from "the build produced nothing", so the export
// reported success with an empty artifact list and the editor painted the green
// "see build/ output" line over a build that had left the user nothing to open.
// The electron-builder → `deno desktop` swap did exactly that to three targets
// at once: windows became <slug>.msi while this still looked for ".exe", mac
// became <slug>.app which is a DIRECTORY and so failed the isFile test, and ios
// has never once written a .ipa (see the iOS fallback below).
//
// Widening the scan to "anything in dist" is not the answer either: dist is
// shared by every target for a game, so an iOS build would hand back the .exe a
// Windows build left there last week. Only the tool knows which file belongs to
// which target, so it writes build/<slug>/artifacts.json saying so, and that is
// what this reads. The scan survives underneath it for a tree built by an older
// copy of the tool — but scoped to the extensions the platform can actually
// produce, never one guess and never everything.
export async function findArtifacts(
  cmgRoot: string,
  slug: string,
  platform: string,
): Promise<string[]> {
  const buildRoot = join(cmgRoot, "build", slug);
  const recorded = await recordedArtifacts(buildRoot, platform);
  if (recorded.length) return recorded;

  const wanted = knownExtensions(platform);
  const distDir = join(buildRoot, "dist");
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(distDir)) {
      // Directories count: a macOS `deno desktop` build is a <slug>.app bundle,
      // and /api/build-artifact serves a directory by zipping it on the way out.
      if (!entry.isFile && !entry.isDirectory) continue;
      const lower = entry.name.toLowerCase();
      if (platform === "all" || wanted.some((ext) => lower.endsWith(ext))) {
        out.push(join(distDir, entry.name));
      }
    }
  } catch (_e) { /* no dist, or it vanished mid-read — treat as none */ }
  // iOS is the one target whose build legitimately stops short of an installable
  // file, and it stops there on every host that is not a Mac: `cordova prepare
  // ios` stages a complete Xcode project and only `xcodebuild` can turn that
  // into an app. The project is a real, useful artifact — zip it, move it to a
  // Mac, open the workspace — so hand it back rather than reporting nothing.
  // It lives beside dist/ rather than in it because copying a multi-hundred-MB
  // project into dist to satisfy this lookup would be pure waste.
  if (!out.length && (platform === "ios" || platform === "all")) {
    const project = join(buildRoot, "cordova", "platforms", "ios");
    if (await pathExists(project)) out.push(project);
  }
  return out;
}

/**
 * What tools/build-level recorded for this platform on its last run, minus
 * anything that has since been deleted.
 *
 * "all" is the union, in the tool's own order, because that is the one request
 * whose answer legitimately spans targets.
 */
async function recordedArtifacts(
  buildRoot: string,
  platform: string,
): Promise<string[]> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(
      await Deno.readTextFile(join(buildRoot, "artifacts.json")),
    );
  } catch (_e) {
    return [];
  }
  if (!manifest || typeof manifest !== "object") return [];
  const keys = platform === "all" ? Object.keys(manifest) : [platform];
  const out: string[] = [];
  for (const key of keys) {
    const paths = manifest[key];
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      if (typeof path !== "string" || !path) continue;
      // A recorded path that is no longer on disk is a build somebody has since
      // cleaned up; offering it would hand the editor a download that 404s.
      if (await pathExists(path)) out.push(path);
    }
  }
  return out;
}

/**
 * Every extension a target's artifact may carry, for the fallback scan only.
 * Kept in step with tools/build-level/lib/run-deno-desktop.js and
 * run-cordova.js, which are what actually name these files — though the
 * manifest above is what makes that drift stop mattering.
 */
function knownExtensions(platform: string): string[] {
  switch (platform) {
    case "linux":
      return [".appimage"];
    // .msi is what `deno desktop` writes; .exe and .zip are what the
    // electron-builder path and a non-default --win-target left behind.
    case "windows":
      return [".msi", ".exe", ".zip"];
    case "mac":
      return [".app", ".dmg", ".zip"];
    case "ios":
      return [".ipa", IOS_PROJECT_SUFFIX];
    case "ps2":
      return [".iso"];
    default:
      return [".apk"];
  }
}

/** True when this path is the staged Xcode project rather than an installable app. */
export function isIosProject(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return p.endsWith("/cordova/platforms/ios");
}

/** What the zipped Xcode project is called in dist/. */
export const IOS_PROJECT_SUFFIX = "-ios-xcode.zip";

/**
 * Replace a staged Xcode project with one zip of it in dist/, and say what was
 * produced.
 *
 * Handing back the project's own path looked fine and was not: buildCordova
 * begins every run with `rm -rf <buildRoot>/cordova`, so the artifact the editor
 * had just been given was deleted by the next export of the same game — the
 * download link went to a 404 and the queue's upload died on a missing path.
 * dist/ is never cleaned between runs, so that is where the artifact has to
 * live. Zipping it here rather than in the Node tool reuses the writer the PS2
 * export already leans on, and writing it once beats /api/build-artifact
 * re-zipping 65 MB in memory on every click.
 */
export async function packageIosProject(
  buildRoot: string,
  slug: string,
  artifacts: string[],
  log: (line: string) => void,
): Promise<{ artifacts: string[]; note?: string }> {
  const at = artifacts.findIndex(isIosProject);
  if (at < 0) {
    // A Mac compiled one, and it is deliberately unsigned (see buildIosIpa in
    // run-cordova.js). Saying so is the difference between a download that
    // works and one that fails on the device with nothing to explain it.
    if (artifacts.some((p) => p.toLowerCase().endsWith(".ipa"))) {
      return {
        artifacts,
        note: "Unsigned .ipa — iOS will not install it as it stands. " +
          "Re-sign it with your own Apple ID (Sideloadly, AltStore or Xcode) " +
          "first.",
      };
    }
    return { artifacts };
  }
  const project = artifacts[at];
  let workspace: string | null = null;
  try {
    for await (const e of Deno.readDir(project)) {
      if (e.name.endsWith(".xcworkspace")) {
        workspace = e.name;
        break;
      }
    }
  } catch (_e) { /* named generically below */ }
  const zipPath = join(buildRoot, "dist", `${slug}${IOS_PROJECT_SUFFIX}`);
  log(`Packing the Xcode project as ${zipPath} …`);
  const entries = await treeEntries(project, `${slug}-ios`);
  // The only thing that still speaks to whoever opens this zip on a Mac a week
  // from now, on a machine that has never seen this editor.
  entries.push({
    path: `${slug}-ios/HOW-TO-BUILD.txt`,
    data: new TextEncoder().encode(
      [
        "This is an Xcode project, not an installable app.",
        "",
        "It was staged by shmupX on a machine without Xcode, which is as far",
        "as anything but Xcode can take an iOS build.",
        "",
        "  1. Unzip this folder on a Mac.",
        `  2. Open ${workspace ?? "the .xcworkspace"} in Xcode.`,
        "  3. Pick your team under Signing & Capabilities, then Product > Run",
        "     to put it on a device, or Product > Archive for an .ipa.",
        "",
        "Exporting from shmupX ON a Mac skips all of this and hands you an",
        "unsigned .ipa directly.",
        "",
      ].join("\n"),
    ),
  });
  await Deno.mkdir(dirname(zipPath), { recursive: true });
  // Fixed timestamp, like every other archive this repo writes, so the same
  // export packed twice is the same file.
  await Deno.writeFile(
    zipPath,
    await buildZip(entries, new Date("2000-03-04T00:00:00Z")),
  );
  const out = artifacts.slice();
  out[at] = zipPath;
  return {
    artifacts: out,
    note: "iOS stops at an Xcode project on this host — only Xcode can turn " +
      "it into an app. Unzip it on a Mac, open the .xcworkspace and archive " +
      "it there.",
  };
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

  // Two roots, because the tool no longer lives at the root it builds into.
  //
  //   toolRoot — holds tools/build-level, i.e. packages/shmup-harbor.
  //   runRoot  — the cwd, and the tree `build/<slug>` lands in. The tool
  //              derives it for itself by walking up for the base game
  //              (index.js cmgRoot), so these two MUST agree with that walk or
  //              findArtifacts below looks in the wrong place — which is why it
  //              is repoRoot() here, the same search from the Deno side.
  //
  // A source checkout runs in place; the packaged binary first stages the
  // embedded tool + game onto real disk (node can't use a VFS path as its cwd),
  // and that staged tree mirrors the repo, so there the two roots are one.
  let toolRoot = moduleRoot;
  let runRoot = repoRoot();
  if (isCompiledBinary()) {
    try {
      toolRoot = runRoot = await stageEmbeddedRuntime(
        moduleRoot,
        (await findPs2Root()) ?? repoRoot(),
      );
    } catch (e) {
      throw new ExportError(
        "Could not stage the build tool out of the packaged app: " +
          (e as Error).message +
          ". Run the export from a source checkout (`deno task dev`) instead.",
      );
    }
  }
  const toolEntry = join(toolRoot, "tools", "build-level");
  if (!(await pathExists(join(toolEntry, "index.js")))) {
    throw new ExportError(
      "Build tool not found. Run the export from a source checkout " +
        "(`deno task dev`).",
    );
  }

  // Pass the parent env through, defaulting the Android SDK location so a
  // fresh shell (where ANDROID_SDK_ROOT is unset) can still find it. Missing
  // toolchains surface as the tool's own error in the returned log.
  const env = Deno.env.toObject();
  // Pin the child to the tree we are actually handing it. The tool honours
  // $SHMUPX_ROOT ahead of its own search, so a user who exported that variable
  // would otherwise send the packaged app's staged copy off to a different
  // checkout than the one it just staged — and runRoot is the right answer in
  // the source case too, where it is what the search would have found anyway.
  env.SHMUPX_ROOT = runRoot;
  if (platform === "android" || platform === "all") {
    const sdk = await guessAndroidSdk(env);
    if (sdk) {
      env.ANDROID_SDK_ROOT = sdk;
      env.ANDROID_HOME = sdk;
    }
  }

  let stdout = "", stderr = "", code = -1;
  try {
    const args = [toolEntry, level, platform];
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

  const slug = slugFor(level);
  const found = await findArtifacts(runRoot, slug, platform);
  const { artifacts, note } = await packageIosProject(
    join(runRoot, "build", slug),
    slug,
    found,
    log,
  );
  // A build that exits 0 having written nothing is a failure, and until now it
  // was the one failure this pipeline reported as a success: runExport resolved
  // ok, the route answered 200, and the editor painted a green "built: see
  // build/ output" over an empty dist. lib/export-worker.ts has always refused
  // this case ("produced nothing to upload") — the local route just never did.
  if (!artifacts.length) {
    throw new ExportError(
      `The ${platform} build finished without producing anything. Look at ` +
        "the build log for the step that gave up.",
      500,
      tail,
    );
  }
  return {
    level,
    platform,
    slug,
    artifacts,
    log: tail,
    ...(note ? { note } : {}),
  };
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
  // A cart has no story, and a record that does not say so opens the app on
  // 2028.Ai's — see forceImportedNoStory. This is the door both browser-side
  // paths come through (the editor's own POST, and a job the worker picked up
  // off the queue), so a phone running a months-old editor bundle is covered
  // here rather than not at all.
  if (forceImportedNoStory(record as Record<string, unknown>)) {
    log("This is a Dezaemon cart with no story of its own — story scenes off.");
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

  // Deliberately darwin-only, even though `cordova prepare ios` now hands back
  // a usable Xcode project from any host: this flag is what the queue routes a
  // REMOTE job by, and somebody who asked a paired desktop for an iOS app
  // should not be handed a project to compile themselves. A local export made
  // on this machine still gets the project — see the fallback in findArtifacts.
  platforms.ios = ready && Deno.build.os === "darwin";
  if (ready && !platforms.ios) {
    notes.push("iOS: not a Mac — a local export stops at an Xcode project");
  }
  // The desktop targets have no host requirement any more. They did under
  // electron-builder: an AppImage needed a Linux mksquashfs (which is why a
  // Windows host had to borrow WSL's), a Windows .exe was rcedited through wine
  // off Windows, and a Mac app needed a Mac. `deno desktop` packs the SquashFS
  // and authors the MSI in-process and writes the .app itself, so all three
  // cross-compile from wherever this is running — only a .dmg would need a Mac,
  // and the per-game build makes a .app. What they do still need is Deno
  // itself, which is what is running this.
  if (ready) {
    platforms.linux = true;
    platforms.windows = true;
  }
  return { platforms, notes };
}
