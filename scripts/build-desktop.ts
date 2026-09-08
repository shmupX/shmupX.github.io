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
//     `deno compile desktop.ts` with the built app embedded, plus the export
//     tool and the 2028-ai game so the editor's "Export to APK" button works
//     inside the packaged app (routes/api/build-apk.ts stages those out of the
//     binary's read-only VFS). Linux is then wrapped in an AppImage, macOS in a
//     .app bundle. android and ios have no launcher, so they always need a name.
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
//   --no-appimage          Linux: stop at the raw binary + AppDir
//   --no-bundle            macOS: stop at the raw binary, no .app around it
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

import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { resolveAthenaElf } from "../lib/ps2/athena.ts";
import { guessAndroidSdk } from "../lib/export-build.ts";
import { listShelf, resolveShelfName, ShelfError } from "../lib/shelf.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

type Platform = "windows" | "linux" | "mac" | "android" | "ios";
type Arch = "x86_64" | "aarch64";

/** The two Cordova targets: no launcher product, and no --arch of their own. */
const MOBILE = new Set<Platform>(["android", "ios"]);

const APPIMAGETOOL_URL = (arch: string) =>
  `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage`;
// The type-2 runtime appimagetool prepends to the squashfs image. Passing it
// explicitly (rather than letting appimagetool fetch its own) is what makes an
// AppImage for a foreign architecture reproducible from this host.
const RUNTIME_URL = (arch: string) =>
  `https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${arch}`;

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

async function compileLauncher(opts: Options): Promise<string> {
  const target = opts.platform === "windows"
    ? `${opts.arch}-pc-windows-msvc`
    : opts.platform === "mac"
    ? `${opts.arch}-apple-darwin`
    : `${opts.arch}-unknown-linux-gnu`;
  const output = opts.platform === "windows"
    ? join(opts.outDir, `shmupX-windows-${opts.arch}.exe`)
    : opts.platform === "mac"
    // macOS lands inside the .app it will be launched from; --no-bundle drops
    // the wrapper and leaves a plain, runnable binary next to it.
    ? (opts.appBundle
      ? join(
        opts.outDir,
        `shmupX-mac-${opts.arch}.app`,
        "Contents",
        "MacOS",
        "shmupx",
      )
      : join(opts.outDir, `shmupX-mac-${opts.arch}`))
    // Linux lands in the AppDir the AppImage is built from; a --no-appimage run
    // leaves it there as a plain, runnable binary.
    : join(
      opts.outDir,
      `shmupX-linux-${opts.arch}.AppDir`,
      "usr",
      "bin",
      "shmupx",
    );

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
  if (opts.platform === "windows") {
    args.push("--icon", "./static/app-icons/cmg.ico");
    if (opts.noTerminal) args.push("--no-terminal");
  }
  args.push("./desktop.ts");

  console.log(`\n[2/3] Compiling the launcher for ${target}…`);
  await ensureDir(dirname(output));
  await run(Deno.execPath(), args);
  return output;
}

// ---------------------------------------------------------------- AppImage

async function download(url: string, dest: string): Promise<string> {
  if (await exists(dest)) return dest;
  console.log(`  fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  }
  await ensureDir(dirname(dest));
  await Deno.writeFile(dest, new Uint8Array(await res.arrayBuffer()));
  return dest;
}

// appimagetool itself is an AppImage, so it has to match the *host* arch — only
// the runtime it embeds has to match the target arch.
async function findAppimagetool(cacheDir: string): Promise<string> {
  const override = Deno.env.get("APPIMAGETOOL");
  if (override) return override;
  try {
    const probe = await new Deno.Command("appimagetool", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    if (probe.success) return "appimagetool";
  } catch (_err) { /* not on PATH — fall through to the download */ }
  const cached = join(cacheDir, `appimagetool-${hostArch()}.AppImage`);
  await download(APPIMAGETOOL_URL(hostArch()), cached);
  await Deno.chmod(cached, 0o755);
  return cached;
}

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=shmupX
GenericName=Game launcher
Comment=The codemonkey.games launcher and shmupX level editor
Exec=shmupx
Icon=shmupx
Categories=Game;
Terminal=false
`;

// AppRun is what the AppImage runtime executes after mounting the image; $HERE
// is the mount point, which changes every launch.
const APP_RUN = `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/shmupx" "$@"
`;

async function buildAppImage(opts: Options, binary: string): Promise<string> {
  if (Deno.build.os !== "linux") {
    fail(
      "building an AppImage needs a Linux host (appimagetool is a Linux " +
        "binary). Pass --no-appimage to stop at the raw binary.",
    );
  }
  const appDir = resolve(binary, "..", "..", ".."); // <out>/shmupX-linux-<arch>.AppDir
  const cacheDir = join(opts.outDir, ".cache");

  console.log("\n[3/3] Packaging the AppImage…");
  await Deno.writeTextFile(join(appDir, "AppRun"), APP_RUN);
  await Deno.chmod(join(appDir, "AppRun"), 0o755);
  await Deno.writeTextFile(join(appDir, "shmupx.desktop"), DESKTOP_ENTRY);
  await ensureDir(join(appDir, "usr", "share", "applications"));
  await Deno.copyFile(
    join(appDir, "shmupx.desktop"),
    join(appDir, "usr", "share", "applications", "shmupx.desktop"),
  );

  // The icon has to sit at the AppDir root under the name the desktop entry's
  // Icon= key uses, and again as .DirIcon (what file managers and Steam read).
  const icon = join(ROOT, "static", "app-icons", "launcher-256.png");
  const iconDir = join(
    appDir,
    "usr",
    "share",
    "icons",
    "hicolor",
    "256x256",
    "apps",
  );
  await ensureDir(iconDir);
  for (
    const dest of [
      join(appDir, "shmupx.png"),
      join(appDir, ".DirIcon"),
      join(iconDir, "shmupx.png"),
    ]
  ) {
    await Deno.copyFile(icon, dest);
  }

  const tool = await findAppimagetool(cacheDir);
  const runtime = await download(
    RUNTIME_URL(opts.arch),
    join(cacheDir, `runtime-${opts.arch}`),
  );
  const output = join(opts.outDir, `shmupX-linux-${opts.arch}.AppImage`);
  await run(
    tool,
    ["--runtime-file", runtime, "--no-appstream", appDir, output],
    {
      env: {
        ...Deno.env.toObject(),
        ARCH: opts.arch,
        // WSL, containers and most CI images have no FUSE, which appimagetool
        // needs to mount *itself*. Extracting instead works everywhere.
        APPIMAGE_EXTRACT_AND_RUN: "1",
      },
    },
  );
  await Deno.chmod(output, 0o755);
  return output;
}

// ---------------------------------------------------------------- .app bundle

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

const INFO_PLIST = (arch: Arch) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>shmupX</string>
  <key>CFBundleExecutable</key><string>shmupx</string>
  <key>CFBundleIconFile</key><string>shmupx</string>
  <key>CFBundleIdentifier</key><string>games.codemonkey.shmupx</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>shmupX</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>LSMinimumSystemVersion</key><string>${
    arch === "aarch64" ? "11.0" : "10.15"
  }</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

// A PNG's IHDR is always its first chunk: 8-byte signature, 4-byte length,
// "IHDR", then width and height as big-endian uint32s.
function pngSize(png: Uint8Array): number | null {
  if (png.length < 24) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  return width === view.getUint32(20) ? width : null;
}

// An .icns is a flat container: "icns" + total length, then one 8-byte-headed
// chunk per image. PNG payloads have been legal since 10.7, so the icon can be
// assembled straight from static/app-icons — no iconutil, and therefore no
// macOS host, required.
async function buildIcns(sources: string[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const source of sources) {
    const png = await Deno.readFile(source);
    const size = pngSize(png);
    const types = size === null ? undefined : ICNS_TYPES[size];
    if (!types) {
      console.warn(
        `  skipping ${basename(source)}: no icns type for a ${
          size ?? "?"
        }px PNG`,
      );
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

// `deno compile` ad-hoc signs the binary it emits, which is what lets it run on
// Apple Silicon at all. Sealing the bundle on top of that is what keeps the
// icon, Info.plist and identity from being swappable, and gives the app a
// stable identity for per-app permissions. codesign is macOS-only, so a bundle
// cross-built from anywhere else stays unsealed until it lands on a Mac.
async function sealBundle(appDir: string): Promise<void> {
  if (Deno.build.os !== "darwin") {
    console.log(
      "  no codesign on this host — the bundle is unsigned. On the Mac it " +
        `lands on:\n    codesign --force --sign - "${basename(appDir)}"`,
    );
    return;
  }
  try {
    await run("codesign", ["--force", "--sign", "-", appDir]);
  } catch (err) {
    console.warn(`  codesign failed (non-fatal): ${(err as Error).message}`);
  }
}

async function buildAppBundle(opts: Options, binary: string): Promise<string> {
  const appDir = resolve(binary, "..", "..", ".."); // <out>/shmupX-mac-<arch>.app
  const contents = join(appDir, "Contents");
  const resources = join(contents, "Resources");

  console.log("\n[3/3] Assembling the .app bundle…");
  await ensureDir(resources);
  await Deno.writeTextFile(join(contents, "Info.plist"), INFO_PLIST(opts.arch));
  // The eight bytes Finder reads to type a bundle without parsing its plist.
  await Deno.writeTextFile(join(contents, "PkgInfo"), "APPL????");
  await Deno.writeFile(
    join(resources, "shmupx.icns"),
    await buildIcns(
      ICNS_SOURCES.map((size) =>
        join(ROOT, "static", "app-icons", `icon-${size}.png`)
      ),
    ),
  );
  await sealBundle(appDir);
  return appDir;
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

/** Mirrors tools/build-level's own output layout: build/<slug>/dist/. */
function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) || "level";
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
    const binary = await compileLauncher(opts);
    const artifact = opts.platform === "linux" && opts.appImage
      ? await buildAppImage(opts, binary)
      : opts.platform === "mac" && opts.appBundle
      ? await buildAppBundle(opts, binary)
      : binary;
    const size = await artifactSize(artifact) / 1024 / 1024;
    console.log(`\nDone. ${artifact} (${size.toFixed(1)} MB)`);
  }
} catch (err) {
  // The failing step has already printed its own output; a stack trace on top
  // of it just buries the real error.
  console.error(`\nerror: ${(err as Error).message}`);
  Deno.exit(1);
}
