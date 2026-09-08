"use strict";

// The Linux AppImage, built from a Windows host.
//
// electron-builder does not assemble the .AppImage itself: its Go helper
// (app-builder) shells out to mksquashfs, and every copy that ships with the
// toolchain is a Linux ELF binary — plus one for macOS. Windows can execute
// neither, so the AppImage target dies deep inside app-builder with
//
//   ⨯ cannot execute  cause=exec: "…\appimage-12.0.1\linux-arm64\mksquashfs":
//                                  file does not exist
//
// which reads like a missing download and is not: the file is right there, it
// just is not a Windows executable, and Go's exec.LookPath only accepts a
// PATHEXT extension. Which of the arch dirs it reaches for is decided by the
// architecture of app-builder.exe — this host's — and NOT by the architecture
// of the AppImage being built, so no --linux-arch spelling gets around it.
// electron-builder's own docs are blunt about the whole situation: AppImages
// "cannot be cross-compiled from macOS or Windows".
//
// Except that a Windows machine may well have a Linux to borrow one from. WSL
// ships the real mksquashfs (squashfs-tools), and app-builder reads
// MKSQUASHFS_PATH and runs whatever it names verbatim — a .cmd included. So
// bin/mksquashfs.cmd stands in for the Linux binary and forwards the call to
// `wsl mksquashfs`, and the AppImage target completes on Windows exactly as it
// would on Linux. Verified end to end against app-builder 3.5.10, the copy
// electron-builder 25 installs.
//
// Two things to know about the images that come out of this route:
//   * every file inside carries mode 0777, because that is what DrvFs reports
//     for the staged tree. Harmless — an AppImage's squashfs is mounted
//     read-only and nosuid, so even a Linux-native build's 4755 chrome-sandbox
//     is inert inside one — but it is why the images are not byte-identical to
//     a Linux-built one.
//   * the stage dir lives on NTFS, so two payload paths differing only in case
//     would collide. Electron packs the app into resources/app.asar, which
//     keeps this theoretical, but it is the one way a Windows-staged image
//     could differ in substance rather than in metadata.
//
// MKSQUASHFS_PATH is app-builder's own env var rather than a documented
// electron-builder feature. If a future version drops it the bridge stops
// applying and this file's guard turns back into the plain refusal it already
// is on a Windows machine with no WSL — a clear message instead of the
// "file does not exist" above.

const path = require("path");
const { spawnSync } = require("child_process");

/** The stand-in app-builder is pointed at. Kept next to the tool it belongs to. */
const SHIM = path.join(__dirname, "..", "bin", "mksquashfs.cmd");

const NO_WSL =
  "building the Linux AppImage on Windows needs WSL with squashfs-tools. " +
  "electron-builder assembles the image with mksquashfs and every copy it " +
  "ships is a Linux binary this host cannot run, so there is nothing to " +
  "assemble it with. Install a distro (wsl --install), then " +
  "`sudo apt install squashfs-tools` inside it — or build this target on " +
  "Linux or a Mac. The Windows .exe target needs none of that.";

/**
 * The `mksquashfs -version` line a WSL distro answers with, or null when there
 * is no wsl.exe, no distro installed, or no squashfs-tools in it.
 *
 * Kept to a timeout because a distro that has to cold-boot is the slow case and
 * a broken WSL install is the hanging one, and this runs before a build the
 * caller is waiting on.
 */
function wslMksquashfsVersion() {
  let r;
  try {
    r = spawnSync("wsl.exe", ["-e", "mksquashfs", "-version"], {
      encoding: "utf8",
      timeout: 60000,
    });
  } catch (_e) {
    return null;
  }
  if (r.error || r.status !== 0) return null;
  // squashfs-tools prints its banner on stdout; older builds used stderr.
  const text = String(r.stdout || "").trim() || String(r.stderr || "").trim();
  return text.split("\n")[0] || "mksquashfs";
}

/**
 * What the AppImage build needs from this host.
 *
 * `null` on a host that needs nothing — Linux and macOS both have a mksquashfs
 * electron-builder can run. Otherwise `{ ok }` plus either `env` (merge it into
 * electron-builder's environment) and a `note` worth logging, or a `reason` to
 * refuse the build with.
 */
function appImageBridge() {
  if (process.platform !== "win32") return null;
  // Somebody has already said which mksquashfs to use — theirs, not ours.
  if (process.env.MKSQUASHFS_PATH || process.env.USE_SYSTEM_MKSQUASHFS) {
    return null;
  }
  const version = wslMksquashfsVersion();
  if (!version) return { ok: false, reason: NO_WSL };
  return {
    ok: true,
    env: { MKSQUASHFS_PATH: SHIM },
    note: "AppImage: assembling through WSL (" + version + ").",
  };
}

module.exports = { appImageBridge, wslMksquashfsVersion, SHIM };
