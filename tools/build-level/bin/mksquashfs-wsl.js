#!/usr/bin/env node
"use strict";

// `mksquashfs`, for a Windows host, borrowed from WSL.
//
// app-builder calls this the way it would call the real thing:
//
//   mksquashfs <stageDir> <output.AppImage> -offset N -all-root -noappend \
//              -no-progress -quiet -no-xattrs -no-fragments
//
// so everything here is argument translation. The stage dir and the output
// file arrive as Windows paths, which the Linux binary on the other side of
// wsl.exe cannot open; wslpath turns each of them into its /mnt/<drive>/ form.
// Flags and their values pass through untouched.
//
// Reached only through bin/mksquashfs.cmd, which lib/appimage-bridge.js points
// MKSQUASHFS_PATH at. That file explains why any of this is necessary.

const { spawnSync } = require("child_process");

// Written this way rather than as a regex literal so the backslash survives
// every layer of quoting between here and a shell.
const BACKSLASH = String.fromCharCode(92);

/** "C:\a\b" / "C:/a/b" — the only arguments that need translating. */
function isWindowsPath(arg) {
  return /^[A-Za-z]:[\\/]/.test(arg);
}

/**
 * The /mnt/<drive>/ form of a Windows path.
 *
 * wslpath is handed the forward-slash spelling because wsl.exe eats backslashes
 * on the way to the Linux side — passing "C:\Users\..." through verbatim
 * arrives as "C:Users..." and wslpath rejects it.
 */
function toWslPath(winPath) {
  const flat = winPath.split(BACKSLASH).join("/");
  const r = spawnSync("wsl.exe", ["wslpath", "-a", flat], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : String(r.stderr || "").trim();
    console.error("mksquashfs-wsl: wslpath failed for " + flat + ": " + why);
    process.exit(1);
  }
  const out = String(r.stdout || "").trim();
  if (!out) {
    console.error("mksquashfs-wsl: wslpath returned nothing for " + flat);
    process.exit(1);
  }
  return out;
}

function main(argv) {
  const args = argv.map(function (a) {
    return isWindowsPath(a) ? toWslPath(a) : a;
  });
  const r = spawnSync("wsl.exe", ["-e", "mksquashfs"].concat(args), {
    stdio: "inherit",
  });
  if (r.error) {
    console.error("mksquashfs-wsl: could not run wsl.exe: " + r.error.message);
    process.exit(1);
  }
  // A signalled child has a null status; anything but a clean 0 must fail the
  // build rather than leave app-builder appending squashfs to a runtime that
  // never got one.
  process.exit(r.status === null ? 1 : r.status);
}

// Guarded so tests can require this file for isWindowsPath without spawning
// anything — it is the one piece of judgement here, and getting it wrong means
// either an untranslated path or a mangled flag value.
if (require.main === module) main(process.argv.slice(2));

module.exports = { isWindowsPath, toWslPath };
