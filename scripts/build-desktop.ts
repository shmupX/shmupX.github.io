// scripts/build-desktop.ts — package shmupX as an app.
//
//   deno task build:windows              → build/desktop/shmupX-windows-<arch>.exe
//   deno task build:linux                → build/desktop/shmupX-linux-<arch>.AppImage
//   deno task build:mac                  → build/desktop/shmupX-mac-<arch>.app
//   deno task build:desktop              → whichever of those three matches this host
//   deno task build:windows 2028_ai      → the game this repo ships, as a Windows app
//   deno task build:android g-fencer-755 → a community Dezaemon cart, as an APK
//   deno task build:linux "My Level"     → that one Firebase level, as an AppImage
//   deno task shelf:list                 → every name the three above accept
//
// Two different products share these tasks, picked by whether a game name is
// given:
//
//   * No name — the launcher itself. `deno task build` (Vite) and then
//     desktop.ts packaged with the built app embedded, plus the export tool and
//     the 2028-ai game so the editor's "Export to APK" button works inside the
//     packaged app (routes/api/build-apk.ts stages those out of the binary's
//     read-only VFS). android and ios have no launcher, so they always need a
//     name.
//
//     Two routes, because they are good at different things:
//       - Windows → `deno compile`. The only one that still yields a single
//         file. `deno desktop` always lays Windows out as a directory (a
//         launcher .exe beside denort.dll and the backend), and its --compress
//         form is a .bat over an archive — both worse for "add a non-Steam
//         game". The .exe has no engine, so it borrows a browser at runtime.
//       - Linux and macOS → `deno desktop --backend cef`, which brings its own
//         Chromium and writes the .AppImage / .app itself. Neither is
//         host-gated: the AppImage is packed in-process (no appimagetool, no
//         mksquashfs, no WSL) and the .app needs no Mac, so both cross-build
//         from here. Only a .dmg would need a Mac, and this builds a .app.
//
//   * A name — one game, through the per-level export in tools/build-level (the
//     same pipeline the editor's export button drives). Needs Node + the
//     platform toolchain; building the Windows app from a Linux host
//     additionally needs wine on PATH (electron-builder rcedits the packaged
//     .exe through it whatever the target is), the macOS app has to be built on
//     a Mac, and android needs cordova + the Android SDK.
//
//     The name is resolved against the whole shelf by lib/shelf.ts, not assumed
//     to be a Firebase level: this repo's own games, the local .sav collection,
//     the eShop and the 262-save community Dezaemon library all answer to it,
//     and a cloud level is the last rung — so every name that worked before
//     still means what it did. Anything that is not a cloud level reaches the
//     Node tool as `--level-file <path>`, which is a shape it already accepts,
//     so the tool itself is untouched.
//
// Flags (launcher):
//   --arch x86_64|aarch64  target architecture (default: x86_64 for Windows,
//                          this host's for Linux and macOS, aarch64 for a
//                          macOS build from a host that is not a Mac)
//   --out <dir>            output directory (default: build/desktop)
//   --skip-build           reuse the existing _fresh/ build instead of rebuilding
//   --no-export-tools      leave the APK-export tool + game out of the binary
//                          (they cost ~0.3MB: deno dedupes the game against the
//                          identical copy Vite put in _fresh/client)
//   --no-terminal          Windows: no console window behind the app
//   --no-appimage          Linux: stop at the plain app directory, unwrapped
//   --no-bundle            macOS: stop at the plain app directory, no .app
//
// Flags (game builds):
//   --sav <path>           build this Dezaemon 2 cart, whatever the name says
//   --slot <n>             which game in a cart that holds more than one
//   --stage <n>            which of the cart's stages to build
//   --name <title>         what to call the app, overriding the shelf's title
//   --offline              resolve against this checkout only, never the network
//   --refresh              re-decode the cart instead of reusing build/shelf
//   --list                 print every buildable name and exit
// Everything else is forwarded verbatim to tools/build-level — e.g. --skip-bgm,
// --package-id, --level-file, --stage-only, --win-target, --mac-target. --arch
// is translated to its --win-arch / --mac-arch.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { resolveAthenaElf } from "../lib/ps2/athena.ts";
import { guessAndroidSdk, slugFor } from "../lib/export-build.ts";
import { listShelf, resolveShelfName, ShelfError } from "../lib/shelf.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

type Platform = "windows" | "linux" | "mac" | "android" | "ios";
type Arch = "x86_64" | "aarch64";

/** The two Cordova targets: no launcher product, and no --arch of their own. */
const MOBILE = new Set<Platform>(["android", "ios"]);

// Flags this script consumes itself; everything else on a game build is passed
// straight through to tools/build-level.
const OWN_FLAGS = new Set([
  "--arch",
  "--skip-build",
  "--no-export-tools",
  "--no-terminal",
  "--no-appimage",
  "--no-bundle",
  "--sav",
  "--slot",
  "--stage",
  "--name",
  "--offline",
  "--refresh",
  "--list",
  "--out",
  "--level",
]);

// tools/build-level flags that take a value. Forwarding the value together with
// its flag keeps it from being mistaken for the level name.
const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--level-file",
  "--package-id",
  "--win-target",
  "--mac-target",
  "--mac-arch",
  // --win-arch belongs here too and never was: line 777 already reads it back
  // out of passthrough, but without an entry here its value fell through as a
  // bare argument and was taken for the level name. --linux-arch is the third
  // of the set; unlike the other two, --arch is not translated into it (this
  // script's --arch defaults to the host's, which for a Linux target built on
  // Windows is exactly the wrong answer — see run-electron.js).
  "--win-arch",
  "--linux-arch",
]);

interface Options {
  platform: Platform;
  arch: Arch;
  outDir: string;
  level: string | null;
  skipBuild: boolean;
  exportTools: boolean;
  noTerminal: boolean;
  appImage: boolean;
  appBundle: boolean;
  /** --sav: build this cart whatever the positional says. */
  sav: string | null;
  slot: number | null;
  stage: string | null;
  /** --name: what to call the app, overriding whatever the shelf calls it. */
  name: string | null;
  offline: boolean;
  refresh: boolean;
  list: boolean;
  passthrough: string[];
}

function hostArch(): Arch {
  return Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
}

function hostPlatform(): Platform {
  if (Deno.build.os === "windows") return "windows";
  if (Deno.build.os === "darwin") return "mac";
  return "linux";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

function parseArgs(argv: string[]): Options {
  const first = (argv[0] ?? "").toLowerCase();
  const named: Record<string, Platform> = {
    windows: "windows",
    linux: "linux",
    mac: "mac",
    macos: "mac",
    darwin: "mac",
    android: "android",
    ios: "ios",
  };
  if (first !== "desktop" && !(first in named)) {
    fail(
      "usage: deno run -A scripts/build-desktop.ts " +
        "<windows|linux|mac|android|ios|desktop> [gameName] [flags]",
    );
  }
  const platform = first === "desktop" ? hostPlatform() : named[first];
  const opts: Options = {
    platform,
    // Windows on ARM runs x64 binaries under emulation but not the reverse, so
    // a Windows build defaults to x86_64 whatever the host is. Linux and macOS
    // builds default to this host's arch, so `deno task build:linux` /
    // `build:mac` yield something you can run right here; cross-building for
    // macOS from elsewhere defaults to aarch64, since Rosetta covers the other
    // direction and Apple Silicon does not.
    arch: platform === "mac" && hostPlatform() !== "mac"
      ? "aarch64"
      : platform === "windows"
      ? "x86_64"
      : hostArch(),
    outDir: join(ROOT, "build", "desktop"),
    level: null,
    skipBuild: false,
    exportTools: true,
    noTerminal: false,
    appImage: true,
    appBundle: true,
    sav: null,
    slot: null,
    stage: null,
    name: null,
    offline: false,
    refresh: false,
    list: false,
    passthrough: [],
  };

  for (let i = 1; i < argv.length; i++) {
    // Both spellings for the flags this script owns, because a cart path with
    // spaces reads better attached — --sav="./Dez 2 - Foo.sav" — which is the
    // same accommodation scripts/build-ps2.ts makes.
    let arg = argv[i];
    let inline: string | null = null;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0 && OWN_FLAGS.has(arg.slice(0, eq))) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const flagValue = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };

    if (arg === "--sav") opts.sav = resolve(flagValue());
    else if (arg === "--name") opts.name = flagValue();
    else if (arg === "--stage") opts.stage = flagValue();
    else if (arg === "--slot") {
      const n = Number(flagValue());
      if (!Number.isInteger(n) || n < 0) fail("--slot takes a whole number");
      opts.slot = n;
    } else if (arg === "--offline") opts.offline = true;
    else if (arg === "--refresh") opts.refresh = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--arch") {
      const arch = flagValue();
      if (arch !== "x86_64" && arch !== "aarch64") {
        fail(`--arch must be x86_64 or aarch64 (got ${arch})`);
      }
      opts.arch = arch;
    } else if (arg === "--out") {
      const value = flagValue();
      if (!value) fail("--out needs a directory");
      opts.outDir = resolve(value);
      // A level build gets its own build root, so the tool needs to see this too.
      opts.passthrough.push("--out", value);
    } else if (arg === "--level") {
      opts.level = flagValue();
    } else if (arg === "--skip-build") opts.skipBuild = true;
    else if (arg === "--no-export-tools") opts.exportTools = false;
    else if (arg === "--no-terminal") opts.noTerminal = true;
    else if (arg === "--no-appimage") opts.appImage = false;
    else if (arg === "--no-bundle") opts.appBundle = false;
    else if (arg.startsWith("--")) {
      if (OWN_FLAGS.has(arg.split("=")[0])) continue;
      opts.passthrough.push(arg);
      if (PASSTHROUGH_VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined) {
        opts.passthrough.push(argv[++i]);
      }
    } else if (opts.level === null) opts.level = arg;
    else opts.passthrough.push(arg);
  }

  // A cart named outright is the game, so the positional (if any) is free to
  // be the title instead — which is how `build:ps2 "Chohsoku Stringer" --sav …`
  // already reads.
  if (opts.sav && opts.level && !opts.name) {
    opts.name = opts.level;
    opts.level = null;
  }

  // android and ios have no launcher product to fall back on: tools/build-level
  // is the only thing that builds them, and it needs a game. Catching this here
  // beats compiling a launcher nobody asked for, or spawning node to be told.
  if (MOBILE.has(opts.platform) && !opts.level && !opts.sav && !opts.list) {
    fail(
      `build:${opts.platform} builds one game — name it, e.g.\n  ` +
        `deno task build:${opts.platform} 2028_ai\n` +
        `  deno task shelf:list   lists every name it accepts`,
    );
  }
  return opts;
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  let status: Deno.CommandStatus;
  try {
    status = await new Deno.Command(cmd, {
      args,
      cwd: opts.cwd ?? ROOT,
      env: opts.env,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
  } catch (err) {
    throw new Error(`could not run ${cmd}: ${(err as Error).message}`);
  }
  if (!status.success) throw new Error(`${cmd} exited ${status.code}`);
}

// A .app is a directory, so its size is its tree's.
async function artifactSize(path: string): Promise<number> {
  const info = await Deno.stat(path);
  if (!info.isDirectory) return info.size;
  let total = 0;
  for await (const entry of walk(path, { followSymlinks: false })) {
    total += (await Deno.lstat(entry.path)).size;
  }
  return total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------- launcher

async function buildWeb(skip: boolean): Promise<void> {
  const server = join(ROOT, "_fresh", "server.js");
  if (skip) {
    if (!(await exists(server))) {
      fail("--skip-build was passed but _fresh/server.js does not exist yet");
    }
    console.log("Reusing the existing _fresh/ build (--skip-build).");
    return;
  }
  console.log("\n[1/3] Building the web app (deno task build)…");
  await run(Deno.execPath(), ["task", "build"]);
}

/**
 * Compile the PS2 runtime, and get hold of the AthenaEnv interpreter, so both
 * can be embedded.
 *
 * The packaged app has no sources to bundle from and no Deno CLI to bundle
 * with, which is why its PS2 export used to refuse outright. The runtime is
 * level-independent — it is the same main.js for every disc — so compiling it
 * here, once, is all that was missing. athena.elf rides along for the same
 * reason a checkout caches it: otherwise the first export in the packaged app
 * needs a GitHub download.
 *
 * Best effort. Either one failing costs the packaged app its PS2 export
 * (routes/api/build-apk.ts says so plainly) but must not sink a desktop build.
 */
async function stagePs2Runtime(): Promise<string[]> {
  const cacheDir = join(ROOT, "build", "ps2", ".cache");
  const includes: string[] = [];
  try {
    await buildRuntimeBundle(ROOT, cacheDir, (m) => console.log(` ${m}`));
    includes.push("--include", "./build/ps2/.cache/main.js");
  } catch (err) {
    console.warn(
      `  PS2 runtime: ${(err as Error).message} — the packaged app will not ` +
        `be able to export for the PS2.`,
    );
    return includes;
  }
  try {
    const athena = await resolveAthenaElf({ cacheDir });
    console.log(
      `  athena.elf: ${(athena.bytes.length / 1048576).toFixed(1)}MB from ` +
        athena.source,
    );
    includes.push("--include", "./build/ps2/.cache/athena.elf");
  } catch (err) {
    console.warn(
      `  athena.elf: ${(err as Error).message} — the packaged app will ` +
        `download it on its first PS2 export instead.`,
    );
  }
  return includes;
}

/** The target triple for a platform/arch pair. Shared by both build routes. */
function targetTriple(opts: Options): string {
  return opts.platform === "windows"
    ? `${opts.arch}-pc-windows-msvc`
    : opts.platform === "mac"
    ? `${opts.arch}-apple-darwin`
    : `${opts.arch}-unknown-linux-gnu`;
}

/**
 * What both `deno compile` and `deno desktop` embed. The two subcommands take
 * the same --include/--exclude flags, so the payload is described once.
 *
 * The one flag they do not share is --app-name: `deno desktop` rejects it and
 * derives the storage identity from the output file name instead, which is why
 * the artifact names below are worth keeping stable.
 */
async function embedArgs(opts: Options): Promise<string[]> {
  const args = [
    // The built server, and the client assets its ProdBuildCache reads at
    // runtime out of _fresh/client.
    "--include",
    "./_fresh/server.js",
    "--include",
    "./_fresh/client",
    // node_modules is a build-time dependency (vite/esbuild/svelte). Vite has
    // already bundled everything the server needs, so embedding the tree would
    // add ~90MB of dead weight.
    "--exclude",
    "./node_modules",
    // The SpacetimeDB module's own tree is the same story, and worth naming
    // separately because the exclude above only reaches the root one: it is
    // what `spacetime publish` builds from, never something the launcher runs.
    // ~44MB.
    "--exclude",
    "./spacetimedb/module/node_modules",
  ];
  if (opts.exportTools) {
    // What routes/api/build-apk.ts copies out of the VFS onto real disk before
    // spawning `node tools/build-level`. The layout has to mirror the repo:
    // the tool derives its game dir as <root>/static/games/2028-ai.
    args.push(
      "--include",
      "./tools/build-level",
      "--include",
      "./static/games/2028-ai",
      "--include",
      "./static/gamepad-compatibility-plugin.js",
      "--include",
      "./static/phaser-plugins/phaser-global.js",
      "--include",
      "./static/firebase-config.js",
    );
    // And what the PS2 export needs, which is not a Node tool at all: the
    // compiled runtime plus the interpreter that runs it.
    console.log("\n  Staging the PS2 runtime…");
    args.push(...await stagePs2Runtime());
  }
  return args;
}

// The icns chunk type each PNG edge length belongs to. macOS only renders a
// PNG-backed entry whose pixels match the size its type promises, so the set is
// keyed by what the file actually is rather than by its name.
const ICNS_TYPES: Record<number, string[]> = {
  32: ["ic11"], //          16x16@2x
  128: ["ic07"], //         128x128
  256: ["ic08", "ic13"], // 256x256, 128x128@2x
  512: ["ic09", "ic14"], // 512x512, 256x256@2x
};

const ICNS_SOURCES = [32, 128, 256, 512];

// A PNG's IHDR is always its first chunk: 8-byte signature, 4-byte length,
// "IHDR", then width and height as big-endian uint32s.
function pngSize(png: Uint8Array): number | null {
  if (png.length < 24) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  return width === view.getUint32(20) ? width : null;
}

/**
 * An .icns is a flat container: "icns" + total length, then one 8-byte-headed
 * chunk per image. PNG payloads have been legal since 10.7, so the icon can be
 * assembled straight from static/app-icons — no iconutil, and therefore no
 * macOS host, required.
 *
 * `deno desktop` accepts either .icns or .png for a macOS target, but the PNG
 * path converts through a tool that only exists on a Mac: cross-building with
 * `--icon <png>` fails with a bare "program not found". Handing it a .icns
 * built here sidesteps that, which is the same reason this existed before.
 */
async function buildIcns(sources: string[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const source of sources) {
    const png = await Deno.readFile(source);
    const size = pngSize(png);
    const types = size === null ? undefined : ICNS_TYPES[size];
    if (!types) {
      console.warn(`  skipping ${source}: no icns type for a ${size ?? "?"}px PNG`);
      continue;
    }
    for (const type of types) {
      const chunk = new Uint8Array(8 + png.length);
      chunk.set(new TextEncoder().encode(type), 0);
      new DataView(chunk.buffer).setUint32(4, chunk.length);
      chunk.set(png, 8);
      chunks.push(chunk);
    }
  }
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const icns = new Uint8Array(total);
  icns.set(new TextEncoder().encode("icns"), 0);
  new DataView(icns.buffer).setUint32(4, total);
  let at = 8;
  for (const chunk of chunks) {
    icns.set(chunk, at);
    at += chunk.length;
  }
  return icns;
}

/** The icon file to hand `deno desktop`, built for the target if need be. */
async function iconFor(opts: Options): Promise<string> {
  const icons = join(ROOT, "static", "app-icons");
  if (opts.platform !== "mac") return join(icons, "icon-512.png");
  const icns = await buildIcns(
    ICNS_SOURCES.map((size) => join(icons, `icon-${size}.png`)),
  );
  const path = join(opts.outDir, "shmupX.icns");
  await Deno.writeFile(path, icns);
  return path;
}

/**
 * Linux and macOS: `deno desktop`, which brings its own window.
 *
 * The backend is CEF rather than the default OS webview. The launcher is a
 * Phaser game driven by a controller, and the native webviews cannot be relied
 * on for that: WebKitGTK only exposes the Gamepad API when the distro compiled
 * it against libmanette (Fedora and Arch do, so Bazzite is fine — but it is the
 * distro's call, not ours), and WKWebView only delivers gamepad input to the
 * view holding first responder. CEF costs ~150MB over the webview backend and
 * removes the question.
 *
 * Nothing here is host-gated. `deno desktop` writes the AppImage in-process —
 * it packs the SquashFS itself and prepends the type-2 runtime — so a Linux
 * artifact cross-builds from Windows with no appimagetool, no mksquashfs and no
 * WSL. Only a .dmg would need a Mac, and this builds a .app instead.
 */
async function buildDesktopApp(opts: Options): Promise<string> {
  const target = targetTriple(opts);
  // `deno desktop` has no --app-name: it derives the app name, and from that
  // the reverse-DNS bundle identifier, from this file name. Identifiers are
  // [A-Za-z0-9.-], so the underscore in "x86_64" would make it invalid — and
  // rather than fail, the build silently skips writing the .desktop entry,
  // which is what gives the AppImage its name and monkey icon in a desktop
  // environment (and in Steam, added as a non-Steam game). Hence "x86-64".
  // `deno desktop` has no --app-name: the app's own identity — the macOS
  // CFBundleName, the Linux .desktop entry, the process name in the Dock and
  // Cmd-Tab — is the *output file's stem*. So it builds as plain "shmupX" and
  // the arch-tagged artifact name is applied afterwards by renaming: the
  // identity is baked into Info.plist / the .desktop entry at build time and
  // does not follow the file. That also keeps the identifier free of the
  // underscore in "x86_64", which is not legal in a reverse-DNS bundle id and
  // makes the build skip the .desktop entry rather than fail.
  //
  // A macOS target always lands in a bundle and `deno desktop` appends the
  // .app itself, so passing one would name it "….app.app"; --no-bundle has
  // nothing to turn off there. On Linux the .AppImage extension *is* the
  // request to wrap, and --no-appimage leaves the plain app directory.
  const wrap = opts.platform === "mac"
    ? ".app"
    : opts.appImage
    ? ".AppImage"
    : "";
  const output = join(opts.outDir, opts.platform === "mac" ? "shmupX" : `shmupX${wrap}`);
  const built = join(opts.outDir, `shmupX${wrap}`);
  const artifact = join(
    opts.outDir,
    `shmupX-${opts.platform === "mac" ? "mac" : "linux"}-${opts.arch}${wrap}`,
  );

  const args = [
    "desktop",
    "--allow-all",
    "--backend",
    "cef",
    "--target",
    target,
    "--output",
    output,
    ...await embedArgs(opts),
  ];
  args.push("--icon", await iconFor(opts));
  args.push("./desktop.ts");

  console.log(
    `\n[2/2] Building the launcher for ${target} with \`deno desktop\` (CEF)…`,
  );
  await ensureDir(dirname(output));
  await run(Deno.execPath(), args);
  // Rename into the documented, arch-tagged artifact name. Both forms are
  // rebuilt from scratch each run, so an artifact left over from a previous
  // build of the same target has to go first or the rename fails.
  await Deno.remove(artifact, { recursive: true }).catch(() => {});
  await Deno.rename(built, artifact);
  return artifact;
}

/** Windows: `deno compile`, which keeps the single-file .exe. */
async function compileLauncher(opts: Options): Promise<string> {
  const target = targetTriple(opts);
  const output = join(opts.outDir, `shmupX-windows-${opts.arch}.exe`);

  const args = [
    "compile",
    "--allow-all",
    "--target",
    target,
    // Storage identity (localStorage/caches) that survives renaming the binary.
    "--app-name",
    "shmupX",
    "--output",
    output,
    ...await embedArgs(opts),
  ];
  args.push("--icon", "./static/app-icons/cmg.ico");
  if (opts.noTerminal) args.push("--no-terminal");
  args.push("./desktop.ts");

  console.log(`\n[2/2] Compiling the launcher for ${target}…`);
  await ensureDir(dirname(output));
  await run(Deno.execPath(), args);
  return output;
}

// ------------------------------------------------------------ level builds

/**
 * What the shelf name means, and the file (if any) the tool should stage it
 * from.
 *
 * `--level-file` passed by hand wins outright and skips resolution entirely,
 * so the escape hatch every shelf build prints — "this is the record I built,
 * pass it yourself to reproduce me" — keeps working.
 */
async function resolveGame(
  opts: Options,
): Promise<{ levelName: string; levelFile: string | null }> {
  const explicit = opts.passthrough.indexOf("--level-file");
  if (explicit >= 0) {
    return {
      levelName: opts.name ?? opts.level ?? "level",
      levelFile: null, // already in passthrough; don't add it twice
    };
  }
  // --sav names the cart outright, so it is resolved as a path rather than
  // against the shelf — mirroring `build:ps2 --sav`.
  const target = opts.sav ?? opts.level!;
  try {
    const hit = await resolveShelfName(target, {
      root: ROOT,
      slot: opts.slot,
      stage: opts.stage,
      name: opts.name,
      offline: opts.offline,
      refresh: opts.refresh,
      log: (message) => console.log(message),
    });
    return { levelName: hit.levelName, levelFile: hit.levelFile };
  } catch (err) {
    if (err instanceof ShelfError) fail(err.message);
    throw err;
  }
}

async function buildLevel(opts: Options): Promise<void> {
  const tool = join(ROOT, "tools", "build-level", "index.js");
  if (!(await exists(tool))) fail(`build tool not found at ${tool}`);
  try {
    const probe = await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!probe.success) throw new Error("node --version failed");
  } catch (_err) {
    fail("Node is required for per-game builds but is not on PATH.");
  }
  if (opts.platform === "ios" && Deno.build.os !== "darwin") {
    fail(
      "an iOS build needs a macOS host (Xcode + CocoaPods). Everything up to " +
        "the native compile works anywhere: add --stage-only to check the " +
        "staged www/.",
    );
  }

  const { levelName, levelFile } = await resolveGame(opts);
  console.log(
    `\nBuilding "${levelName}" as a ${opts.platform} app ` +
      "(tools/build-level)…\n",
  );
  const args = ["tools/build-level", levelName, opts.platform];
  if (levelFile) args.push("--level-file", levelFile);
  // One --arch knob for both products, translated to whichever the tool hands
  // electron-builder. Both default the same way it does, so this only ever
  // matters when --arch was passed explicitly. Cordova picks its own ABIs.
  const ebArch = opts.arch === "aarch64" ? "arm64" : "x64";
  if (opts.platform === "windows" && !opts.passthrough.includes("--win-arch")) {
    args.push("--win-arch", ebArch);
  }
  if (opts.platform === "mac" && !opts.passthrough.includes("--mac-arch")) {
    args.push("--mac-arch", ebArch);
  }

  // The same default lib/export-build.ts gives the editor's export button, so
  // a fresh shell with no ANDROID_SDK_ROOT builds here too.
  const env = Deno.env.toObject();
  if (opts.platform === "android") {
    const sdk = await guessAndroidSdk(env);
    if (sdk) {
      env.ANDROID_SDK_ROOT = sdk;
      env.ANDROID_HOME = sdk;
    } else {
      console.warn(
        "  warning: no Android SDK found (ANDROID_SDK_ROOT / ANDROID_HOME " +
          "unset, and none at the default install path) — cordova will say " +
          "so if it cannot proceed.",
      );
    }
  }
  await run("node", args.concat(opts.passthrough), { env });

  if (opts.passthrough.includes("--stage-only")) return;
  // --out moves the tool's whole build root, and it was forwarded verbatim, so
  // the summary has to look where the artifact actually landed.
  const outAt = opts.passthrough.indexOf("--out");
  const buildRoot = outAt >= 0 && opts.passthrough[outAt + 1]
    ? resolve(opts.passthrough[outAt + 1])
    : join(ROOT, "build", slugFor(levelName));
  await reportArtifacts(buildRoot, opts.platform);
}

/**
 * Say what was built and where, the way the launcher branch signs off.
 *
 * The tool prints its own per-platform chatter, but not one line naming the
 * file — which on a ten-minute Android build is the only line anyone is
 * waiting for.
 */
async function reportArtifacts(
  buildRoot: string,
  platform: Platform,
): Promise<void> {
  const dist = join(buildRoot, "dist");
  // What the DEFAULT target yields — used only to order the listing. A
  // --win-target zip/nsis/dir (or a --mac-target zip) is just as much the
  // artifact, and reporting "no .exe turned up" while a perfectly good .zip
  // sits next to it reads as a failure when nothing failed.
  const usual = platform === "linux"
    ? ".appimage"
    : platform === "windows"
    ? ".exe"
    : platform === "mac"
    ? ".dmg"
    : platform === "ios"
    ? ".ipa"
    : ".apk";
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(dist)) {
      if (entry.isFile || entry.isDirectory) found.push(join(dist, entry.name));
    }
  } catch (_e) { /* no dist dir — the tool already said why */ }
  if (!found.length) {
    if (platform === "ios") {
      console.log(
        `\nDone. iOS stops at an Xcode project — open ` +
          `${join(buildRoot, "cordova", "platforms", "ios")} and archive it ` +
          `there for an .ipa.`,
      );
      return;
    }
    console.log(`\nDone, but ${dist} is empty — expected a ${usual}.`);
    return;
  }
  found.sort((a, b) =>
    Number(b.toLowerCase().endsWith(usual)) -
    Number(a.toLowerCase().endsWith(usual))
  );
  for (const path of found) {
    const size = await artifactSize(path) / 1024 / 1024;
    console.log(`\nDone. ${path} (${size.toFixed(1)} MB)`);
  }
}

/** `deno task shelf:list` — every name a build will accept. */
async function printShelf(opts: Options): Promise<void> {
  const sections = await listShelf({ root: ROOT, offline: opts.offline });
  for (const section of sections) {
    console.log(`\n${section.section}`);
    if (section.note) console.log(`  (${section.note})`);
    for (const row of section.rows) {
      console.log(`  ${row.slug.padEnd(34)} ${row.title}`);
    }
    if (!section.rows.length && !section.note) console.log("  (none)");
  }
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  console.log(
    `\n${total} name(s). Build one with e.g. ` +
      `\`deno task build:android <name>\`; a name that is on two shelves ` +
      `takes a game:/eshop:/deza:/cloud: prefix.`,
  );
}

// ------------------------------------------------------------------- main

const opts = parseArgs(Deno.args);

try {
  if (opts.list) {
    await printShelf(opts);
  } else if (opts.level || opts.sav) {
    await buildLevel(opts);
  } else {
    console.log(
      `Packaging the shmupX launcher for ${opts.platform}/${opts.arch}.`,
    );
    await ensureDir(opts.outDir);
    await buildWeb(opts.skipBuild);
    // Windows keeps `deno compile`, which is the only route that still yields a
    // single-file .exe — `deno desktop` always lays a Windows app out as a
    // directory (a launcher .exe beside denort.dll and the backend), and its
    // --compress form is a .bat over a payload archive, which is worse for
    // "add a non-Steam game". Linux and macOS take `deno desktop`.
    const artifact = opts.platform === "windows"
      ? await compileLauncher(opts)
      : await buildDesktopApp(opts);
    const size = await artifactSize(artifact) / 1024 / 1024;
    console.log(`\nDone. ${artifact} (${size.toFixed(1)} MB)`);
  }
} catch (err) {
  // The failing step has already printed its own output; a stack trace on top
  // of it just buries the real error.
  console.error(`\nerror: ${(err as Error).message}`);
  Deno.exit(1);
}
