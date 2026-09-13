"use strict";

// Compiles the staged www/ into a desktop app via `deno desktop`, which is what
// replaced the electron-builder path this file sits next to.
//
// The shape is the same one scripts/build-desktop.ts uses for the launcher: a
// Deno.serve over the staged tree, embedded in the binary's VFS, with a window
// pointed at it. That gets the game a real http:// origin for free, which is
// the whole reason the Electron main process had to register a privileged
// app:// scheme (file:// blocks ES module imports).
//
// Why this is worth the swap:
//   * No host gates. electron-builder cannot cross-compile an AppImage from
//     Windows or macOS ("they cannot be cross-compiled" — its own docs), which
//     is why lib/appimage-bridge.js had to borrow WSL's mksquashfs; it cannot
//     build a macOS app off a Mac at all; and it rcedits every Windows target,
//     which needs wine on a Linux host. `deno desktop` packs the SquashFS
//     in-process and writes the .app itself, so every target builds from here.
//   * No Chromium to maintain. The scaffold pinned electron@^33, whose last
//     release was 2025-04-26; Electron supports only its latest three majors.
//
// The backend is CEF rather than the default OS webview, for the same reason
// the launcher uses it: this is a controller-driven Phaser game, and the native
// webviews do not agree about the Gamepad API (WebKitGTK exposes it only when
// the distro compiled against libmanette; WKWebView delivers pad input only to
// the view holding first responder).
//
// One deliberate difference from the Electron build: a Windows artifact is a
// .msi, not a portable .exe. `deno desktop` has no single-file Windows output —
// it always lays the app out as a launcher .exe beside denort.dll and the
// backend — so an .msi is the closest thing to "the one file you hand someone".

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(cmd, args, opts) {
  console.log("$ " + cmd + " " + args.join(" "));
  const r = spawnSync(
    cmd,
    args,
    Object.assign(
      { stdio: "inherit", shell: process.platform === "win32" },
      opts || {},
    ),
  );
  if (r.status !== 0) throw new Error(cmd + " exited " + r.status);
}

// ---------------------------------------------------------------- targets

const TRIPLES = {
  windows: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  mac: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
};

function tripleFor(platform, arch) {
  const byArch = TRIPLES[platform];
  const triple = byArch && byArch[arch];
  if (!triple) {
    throw new Error(
      "no deno target for " + platform + "/" + arch +
        " (supported: " + Object.keys(byArch || {}).join(", ") + ")",
    );
  }
  return triple;
}

// ------------------------------------------------------------------- icon

// The icns chunk type each PNG edge length belongs to. Mirrors the table in
// scripts/build-desktop.ts — macOS only renders a PNG-backed entry whose pixels
// match the size its type promises.
const ICNS_TYPES = {
  32: ["ic11"],
  128: ["ic07"],
  256: ["ic08", "ic13"],
  512: ["ic09", "ic14"],
};

function pngSize(buf) {
  if (buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  return width === buf.readUInt32BE(20) ? width : null;
}

// An .icns is a flat container: "icns" + total length, then one 8-byte-headed
// chunk per image. PNG payloads have been legal since 10.7, so this needs no
// iconutil and therefore no macOS host — which matters because `deno desktop`
// converts a --icon PNG for a mac target through a Mac-only tool and fails with
// a bare "program not found" anywhere else.
function buildIcns(sources) {
  const chunks = [];
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    const png = fs.readFileSync(source);
    const size = pngSize(png);
    const types = size === null ? undefined : ICNS_TYPES[size];
    if (!types) continue;
    for (const type of types) {
      const head = Buffer.alloc(8);
      head.write(type, 0, "ascii");
      head.writeUInt32BE(png.length + 8, 4);
      chunks.push(Buffer.concat([head, png]));
    }
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** The icon to hand `deno desktop`, converted for the target if it has to be. */
function iconFor(platform, iconsDir, outDir) {
  const png512 = path.join(iconsDir, "icon-512.png");
  if (platform !== "mac") return fs.existsSync(png512) ? png512 : null;
  const icns = buildIcns(
    [32, 128, 256, 512].map((n) => path.join(iconsDir, "icon-" + n + ".png")),
  );
  if (!icns) return null;
  const out = path.join(outDir, "icon.icns");
  fs.writeFileSync(out, icns);
  return out;
}

// ------------------------------------------------------------ app entry

// The Deno entrypoint written into the build dir and compiled by `deno desktop`.
// It serves the staged www/ out of the binary's read-only VFS.
//
// electronAudio: the Electron build exposed window.electronAudio.loadCustomAudio
// over a preload contextBridge, reading <userData>/custom-audio/*.mp3 so players
// could drop in their own BGM. There is no preload here and none is needed — the
// page and the Deno side share an origin — so the same contract is served over
// HTTP and shimmed into the shell. The game treats it as optional and falls back
// to IndexedDB, and disk still wins over IndexedDB (level-loader.js).
function appEntry(shell, appName) {
  return `// Generated by tools/build-level/lib/run-deno-desktop.js — do not edit.
import { contentType } from "jsr:@std/media-types@^1/content-type";
import { extname, join, normalize } from "jsr:@std/path@^1";

const WWW = new URL("./www/", import.meta.url);
const SHELL = ${JSON.stringify(shell)};

/** Where a player drops their own <key>.mp3 overrides. */
function customAudioDir(): string {
  const env = Deno.env.get.bind(Deno.env);
  const home = env("HOME") ?? "";
  const base = Deno.build.os === "windows"
    ? env("LOCALAPPDATA") ?? join(home, "AppData", "Local")
    : Deno.build.os === "darwin"
    ? join(home, "Library", "Application Support")
    : env("XDG_DATA_HOME") ?? join(home, ".local", "share");
  return join(base, ${JSON.stringify(appName)}, "custom-audio");
}

async function customAudioKeys(): Promise<string[]> {
  const keys: string[] = [];
  try {
    for await (const entry of Deno.readDir(customAudioDir())) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".mp3")) {
        keys.push(entry.name.slice(0, -4));
      }
    }
  } catch { /* no directory yet is the normal case */ }
  return keys;
}

// Stands in for the preload contextBridge the Electron shell used to install.
const AUDIO_SHIM = \`<script>
globalThis.electronAudio = {
  async loadCustomAudio() {
    const out = {};
    try {
      const keys = await (await fetch("/__custom-audio")).json();
      await Promise.all(keys.map(async (k) => {
        const r = await fetch("/__custom-audio/" + encodeURIComponent(k) + ".mp3");
        if (r.ok) out[k] = await r.arrayBuffer();
      }));
    } catch (e) {
      console.warn("custom audio unavailable:", e);
    }
    return out;
  },
};
</script>\`;

// Uint8Array<ArrayBuffer>, not a bare Uint8Array: the bare form widens to
// ArrayBufferLike, which is not a BodyInit.
async function readWww(rel: string): Promise<Uint8Array<ArrayBuffer> | null> {
  // normalize collapses any ".." before it can climb out of the VFS root.
  const safe = normalize(rel).replace(/^([.][.][/\\\\])+/, "");
  try {
    return await Deno.readFile(new URL(safe, WWW));
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/__custom-audio") {
      return Response.json(await customAudioKeys());
    }
    if (pathname.startsWith("/__custom-audio/")) {
      const name = pathname.slice("/__custom-audio/".length);
      try {
        const bytes = await Deno.readFile(join(customAudioDir(), name));
        return new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (pathname === "/" || pathname === "") pathname = "/" + SHELL;
    const bytes = await readWww(pathname.replace(/^\\//, ""));
    if (!bytes) return new Response("not found", { status: 404 });

    const type = contentType(extname(pathname)) ?? "application/octet-stream";
    // Only the shell needs the shim, and only it is HTML worth rewriting.
    if (pathname.endsWith("/" + SHELL) || pathname === "/" + SHELL) {
      const html = new TextDecoder().decode(bytes).replace(
        "</head>",
        AUDIO_SHIM + "</head>",
      );
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(bytes, { headers: { "content-type": type } });
  },
} satisfies Deno.ServeDefaultExport;
`;
}

// -------------------------------------------------------------- identity

// A reverse-DNS bundle id for one game. The Cordova side's package id
// (com.easierbycode.<slug>) is already exactly that shape, so it is reused
// verbatim to keep one game's identity the same across every target it builds
// for. Identifiers are [A-Za-z0-9.-] with no empty segment, so a slug that
// reduces to nothing — or a package id carrying anything else — falls back to
// something valid rather than making the build skip the .desktop entry.
function identifierFor(packageId, slug) {
  const clean = String(packageId || "").replace(/[^A-Za-z0-9.-]/g, "-");
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(clean)) return clean;
  const tail = String(slug || "").replace(/[^A-Za-z0-9-]/g, "-") || "app";
  return "com.easierbycode." + tail;
}

// ------------------------------------------------------------------ build

async function buildDenoDesktop(opts) {
  const { scaffoldRoot, wwwRoot, buildRoot, slug, platform } = opts;
  const arch = platform === "windows"
    ? (opts.winArch || "x64")
    : platform === "mac"
    ? (opts.macArch || (process.arch === "arm64" ? "arm64" : "x64"))
    // A Linux target built ON Linux is normally for the machine that built it;
    // cross-built from anywhere else, x64 is what everyone else gets.
    : (opts.linuxArch ||
      (process.platform === "linux" && process.arch === "arm64"
        ? "arm64"
        : "x64"));
  if (platform === "mac" && arch === "universal") {
    throw new Error(
      "`deno desktop` has no universal target; build --mac-arch x64 or arm64.",
    );
  }
  const triple = tripleFor(platform, arch);

  const appDir = path.join(buildRoot, "desktop");
  fs.mkdirSync(appDir, { recursive: true });

  // The staged tree has to sit beside the entry so `--include ./www` embeds it
  // at the path the entry resolves against import.meta.url.
  const stagedWww = path.join(appDir, "www");
  fs.rmSync(stagedWww, { recursive: true, force: true });
  // Without the filter this copies macOS's AppleDouble fork of every asset,
  // and `--include ./www` then embeds each one in the binary: the shipped app
  // carries a 4 KB "._foo.png" beside every real foo.png.
  fs.cpSync(wwwRoot, stagedWww, {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith("._"),
  });

  const shell = opts.shell || "phaser-game.html";
  const entry = path.join(appDir, "app.ts");
  fs.writeFileSync(entry, appEntry(shell, slug));

  // Each exported game needs a bundle identity of its own. `deno desktop` has
  // no --identifier flag; it reads desktop.app.identifier out of the deno.json
  // it discovers, and with none here it would walk up to the repo's own and
  // stamp every game with the *launcher's* id — one shared identity, and with
  // it one shared storage. So the build dir gets a deno.json of its own, which
  // is found first because deno runs with cwd here.
  fs.writeFileSync(
    path.join(appDir, "deno.json"),
    JSON.stringify(
      { desktop: { app: { identifier: identifierFor(opts.packageId, slug) } } },
      null,
      2,
    ),
  );

  const distDir = path.join(buildRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  // `deno desktop` takes the app's identity — the macOS CFBundleName, the Linux
  // .desktop entry, the name in the Dock — from the output file's stem, so the
  // build is named for the game and nothing else.
  const ext = platform === "windows"
    ? ".msi"
    : platform === "mac"
    ? ""
    : ".AppImage";
  const output = path.join(distDir, slug + ext);

  const args = [
    "desktop",
    "--allow-all",
    "--backend",
    "cef",
    "--target",
    triple,
    "--output",
    output,
    "--include",
    "./www",
  ];
  const icon = iconFor(platform, path.join(scaffoldRoot, "icons"), appDir);
  if (icon) args.push("--icon", icon);
  args.push("./app.ts");

  run(opts.denoPath || "deno", args, { cwd: appDir });

  const artifact = platform === "mac" ? output + ".app" : output;
  return { artifacts: fs.existsSync(artifact) ? [artifact] : [] };
}

module.exports = { buildDenoDesktop, tripleFor, buildIcns, identifierFor };
