// scripts/build-desktop.ts — package shmupX as a desktop app.
//
//   deno task build:windows              → build/desktop/shmupX-windows-<arch>.exe
//   deno task build:linux                → build/desktop/shmupX-linux-<arch>.AppImage
//   deno task build:mac                  → build/desktop/shmupX-mac-<arch>.app
//   deno task build:desktop              → whichever of those three matches this host
//   deno task build:windows "My Level"   → that one Firebase level as a Windows app
//   deno task build:linux "My Level"     → …as a Linux AppImage
//   deno task build:mac "My Level"       → …as a macOS .dmg
//
// Two different products share these tasks, picked by whether a level name is
// given:
//
//   * No level name — the launcher itself. `deno task build` (Vite) and then
//     `deno compile desktop.ts` with the built app embedded, plus the export
//     tool and the 2028-ai game so the editor's "Export to APK" button works
//     inside the packaged app (routes/api/build-apk.ts stages those out of the
//     binary's read-only VFS). Linux is then wrapped in an AppImage, macOS in a
//     .app bundle.
//
//   * A level name — one game, through the per-level Electron export in
//     tools/build-level (the same pipeline the editor's export button drives).
//     Needs Node + the electron-builder toolchain; building the Windows app
//     from a Linux host additionally needs wine on PATH (electron-builder
//     rcedits the packaged .exe through it whatever the target is), and the
//     macOS app has to be built on a Mac.
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
// Flags (level builds) are forwarded verbatim to tools/build-level — e.g.
// --skip-bgm, --package-id, --level-file, --stage-only, --win-target,
// --mac-target. --arch is translated to its --win-arch / --mac-arch.

import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { resolveAthenaElf } from "../lib/ps2/athena.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

type Platform = "windows" | "linux" | "mac";
type Arch = "x86_64" | "aarch64";

const APPIMAGETOOL_URL = (arch: string) =>
  `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage`;
// The type-2 runtime appimagetool prepends to the squashfs image. Passing it
// explicitly (rather than letting appimagetool fetch its own) is what makes an
// AppImage for a foreign architecture reproducible from this host.
const RUNTIME_URL = (arch: string) =>
  `https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${arch}`;

// Flags this script consumes itself; everything else on a level build is passed
// straight through to tools/build-level.
const OWN_FLAGS = new Set([
  "--arch",
  "--skip-build",
  "--no-export-tools",
  "--no-terminal",
  "--no-appimage",
  "--no-bundle",
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
  };
  if (first !== "desktop" && !(first in named)) {
    fail(
      "usage: deno run -A scripts/build-desktop.ts <windows|linux|mac|desktop> " +
        "[levelName] [flags]",
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
    passthrough: [],
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch") {
      const value = argv[++i];
      if (value !== "x86_64" && value !== "aarch64") {
        fail(`--arch must be x86_64 or aarch64 (got ${value ?? "nothing"})`);
      }
      opts.arch = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) fail("--out needs a directory");
      opts.outDir = resolve(value);
      // A level build gets its own build root, so the tool needs to see this too.
      opts.passthrough.push("--out", value);
    } else if (arg === "--level") {
      opts.level = argv[++i] ?? fail("--level needs a name");
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
    fail("Node is required for per-level builds but is not on PATH.");
  }
  console.log(
    `Building level "${opts.level}" as a ${opts.platform} app ` +
      "(tools/build-level)…\n",
  );
  const args = ["tools/build-level", opts.level!, opts.platform];
  // One --arch knob for both products, translated to whichever the tool hands
  // electron-builder. Both default the same way it does, so this only ever
  // matters when --arch was passed explicitly.
  const ebArch = opts.arch === "aarch64" ? "arm64" : "x64";
  if (opts.platform === "windows" && !opts.passthrough.includes("--win-arch")) {
    args.push("--win-arch", ebArch);
  }
  if (opts.platform === "mac" && !opts.passthrough.includes("--mac-arch")) {
    args.push("--mac-arch", ebArch);
  }
  await run("node", args.concat(opts.passthrough));
}

// ------------------------------------------------------------------- main

const opts = parseArgs(Deno.args);

try {
  if (opts.level) {
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
