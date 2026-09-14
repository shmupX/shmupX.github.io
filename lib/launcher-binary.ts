// Which file on disk IS the launcher — the one thing "Add to Steam" has to get
// right, because the shortcut it writes is a path and nothing checks it again.
//
// Three answers, and only one of them is `Deno.execPath()`:
//
//   * An AppImage is a single file that mounts itself and runs the binary
//     INSIDE the mount, so execPath is something like
//     /tmp/.mount_shmupXAbC123/usr/bin/shmupX — a path that stops existing the
//     moment the app quits. The AppImage runtime exports $APPIMAGE with the
//     real path of the file the player double-clicked, and that is the only
//     thing worth handing to Steam.
//   * A `deno compile` .exe and a macOS .app are what execPath says they are.
//   * A source checkout is `deno` itself, which is not a game. Adding it to
//     Steam would file the Deno binary in somebody's library and launch a REPL,
//     so the answer there is "there is nothing to add" — `Deno.build.standalone`
//     is what tells the two apart.
//
// A fourth answer appeared with the updater: an AppImage that has been INSTALLED
// (lib/launcher-install.ts copies its mounted tree into the launcher's data
// directory) runs from an ordinary writable directory, so it is the one Linux
// shape `Deno.autoUpdate` can patch. Nothing in execPath says so — the binary
// inside the installed tree looks like any other — which is why the install
// directory is part of the context rather than something inferred here.
//
// Pure, so tests/launcher_binary_test.ts can check all four without being any
// of them.

import { installDir } from "./launcher-install.ts";

export interface BinaryContext {
  env: Record<string, string>;
  execPath: string;
  /** Deno.build.standalone: this is a packaged app rather than a checkout. */
  standalone: boolean;
  os: "linux" | "darwin" | "windows";
  /**
   * Where an installed copy would live (`installDir()`), when the caller knows.
   *
   * Running from inside it is what "installed" means, and it is the only kind
   * whose consequences reach past the shortcut: lib/self-update.ts arms the
   * updater for it. Optional, so a caller that does not care still gets the
   * other three answers.
   */
  installDir?: string;
}

export interface LauncherBinary {
  /** The file to run. */
  path: string;
  /** How it was identified, for the message when something looks wrong. */
  kind: "appimage" | "macos-app" | "executable" | "installed";
}

/** Is `path` the directory `dir`, or something under it? */
function isInside(path: string, dir: string, os: BinaryContext["os"]): boolean {
  const norm = (value: string) => {
    const slashed = os === "windows" ? value.replace(/\\/g, "/") : value;
    const trimmed = slashed.replace(/\/+$/, "");
    return os === "windows" ? trimmed.toLowerCase() : trimmed;
  };
  const inside = norm(path);
  const root = norm(dir);
  return inside === root || inside.startsWith(`${root}/`);
}

/**
 * The launcher's own file, or null when this is not a packaged launcher.
 *
 * Null is not a failure — it is the honest answer in a checkout, and the caller
 * turns it into "run `deno task build:linux` first" rather than a broken
 * shortcut.
 */
export function launcherBinary(ctx: BinaryContext): LauncherBinary | null {
  // $APPIMAGE is set by the AppImage runtime itself, so it is only present when
  // this really is running from one — and it outranks execPath even though
  // standalone is true in both cases.
  const appImage = (ctx.env.APPIMAGE ?? "").trim();
  if (appImage) return { path: appImage, kind: "appimage" };
  if (!ctx.standalone) return null;
  if (!ctx.execPath) return null;
  // An installed tree is entered through its AppRun, not through whatever
  // execPath reports from inside it: AppRun is the only file the AppImage
  // layout guarantees, and it is what sets the tree up before handing over.
  const installed = (ctx.installDir ?? "").trim();
  if (installed && isInside(ctx.execPath, installed, ctx.os)) {
    const sep = ctx.os === "windows" ? "\\" : "/";
    return { path: `${installed}${sep}AppRun`, kind: "installed" };
  }
  if (ctx.os === "darwin") {
    // Steam wants the bundle, not the Mach-O buried in it: pointing a shortcut
    // at Contents/MacOS/shmupX launches it without the bundle's Info.plist, so
    // it gets no icon, no name and no dock entry.
    const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(ctx.execPath);
    if (bundle) return { path: bundle[1], kind: "macos-app" };
  }
  return { path: ctx.execPath, kind: "executable" };
}

/** The launcher's own file as this process sees it. */
export function currentLauncherBinary(): LauncherBinary | null {
  let execPath = "";
  try {
    execPath = Deno.execPath();
  } catch {
    // --allow-read was not granted for it; treat that as "cannot say".
    return null;
  }
  const os = Deno.build.os === "windows"
    ? "windows"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  let env: Record<string, string> = {};
  try {
    env = Deno.env.toObject();
  } catch { /* --allow-env was not granted */ }
  return launcherBinary({
    env,
    execPath,
    standalone: (Deno.build as { standalone?: boolean }).standalone === true,
    os,
    installDir: installDir(os, env),
  });
}
