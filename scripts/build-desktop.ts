// scripts/build-desktop.ts — package shmupX as a desktop app.
//
//   deno task build:windows              → build/desktop/shmupX-windows-<arch>.exe
//   deno task build:linux                → build/desktop/shmupX-linux-<arch>.AppImage
//   deno task build:desktop              → whichever of those two matches this host
//   deno task build:windows "My Level"   → that one Firebase level as a Windows app
//   deno task build:linux "My Level"     → …as a Linux AppImage
//
// Two different products share these tasks, picked by whether a level name is
// given:
//
//   * No level name — the launcher itself. `deno task build` (Vite) and then
//     `deno compile desktop.ts` with the built app embedded, plus the export
//     tool and the 2028-ai game so the editor's "Export to APK" button works
//     inside the packaged app (routes/api/build-apk.ts stages those out of the
//     binary's read-only VFS). Linux is then wrapped in an AppImage.
//
//   * A level name — one game, through the per-level Electron export in
//     tools/build-level (the same pipeline the editor's export button drives).
//     Needs Node + the electron-builder toolchain, and building the Windows app
//     from a Linux host additionally needs wine on PATH: electron-builder
//     rcedits the packaged .exe through it whatever the target is.
//
// Flags (launcher):
//   --arch x86_64|aarch64  target architecture (default: x86_64 for Windows,
//                          this host's for Linux)
//   --out <dir>            output directory (default: build/desktop)
//   --skip-build           reuse the existing _fresh/ build instead of rebuilding
//   --no-export-tools      leave the APK-export tool + game out of the binary
//                          (they cost ~0.3MB: deno dedupes the game against the
//                          identical copy Vite put in _fresh/client)
//   --no-terminal          Windows: no console window behind the app
//   --no-appimage          Linux: stop at the raw binary + AppDir
//
// Flags (level builds) are forwarded verbatim to tools/build-level — e.g.
// --skip-bgm, --package-id, --level-file, --stage-only, --win-target. --arch is
// translated to its --win-arch.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

type Platform = "windows" | "linux";
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
]);

// tools/build-level flags that take a value. Forwarding the value together with
// its flag keeps it from being mistaken for the level name.
const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--level-file",
  "--package-id",
  "--win-target",
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
  passthrough: string[];
}

function hostArch(): Arch {
  return Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
}

function hostPlatform(): Platform {
  return Deno.build.os === "windows" ? "windows" : "linux";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

function parseArgs(argv: string[]): Options {
  const first = (argv[0] ?? "").toLowerCase();
  if (!["windows", "linux", "desktop"].includes(first)) {
    fail(
      "usage: deno run -A scripts/build-desktop.ts <windows|linux|desktop> " +
        "[levelName] [flags]",
    );
  }
  const platform = first === "desktop" ? hostPlatform() : first as Platform;
  const opts: Options = {
    platform,
    // Windows on ARM runs x64 binaries under emulation but not the reverse, so
    // a Windows build defaults to x86_64 whatever the host is. A Linux build
    // defaults to this host's arch, so `deno task build:linux` yields an
    // AppImage you can run right here.
    arch: platform === "windows" ? "x86_64" : hostArch(),
    outDir: join(ROOT, "build", "desktop"),
    level: null,
    skipBuild: false,
    exportTools: true,
    noTerminal: false,
    appImage: true,
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

async function compileLauncher(opts: Options): Promise<string> {
  const target = opts.platform === "windows"
    ? `${opts.arch}-pc-windows-msvc`
    : `${opts.arch}-unknown-linux-gnu`;
  const output = opts.platform === "windows"
    ? join(opts.outDir, `shmupX-windows-${opts.arch}.exe`)
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
  // One --arch knob for both products. The tool defaults to x64 too, so this
  // only ever matters when --arch was passed explicitly.
  if (opts.platform === "windows" && !opts.passthrough.includes("--win-arch")) {
    args.push("--win-arch", opts.arch === "aarch64" ? "arm64" : "x64");
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
      : binary;
    const size = (await Deno.stat(artifact)).size / 1024 / 1024;
    console.log(`\nDone. ${artifact} (${size.toFixed(1)} MB)`);
  }
} catch (err) {
  // The failing step has already printed its own output; a stack trace on top
  // of it just buries the real error.
  console.error(`\nerror: ${(err as Error).message}`);
  Deno.exit(1);
}
