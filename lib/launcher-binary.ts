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
// Pure, so tests/launcher_binary_test.ts can check all three without being any
// of them.

export interface BinaryContext {
  env: Record<string, string>;
  execPath: string;
  /** Deno.build.standalone: this is a packaged app rather than a checkout. */
  standalone: boolean;
  os: "linux" | "darwin" | "windows";
}

export interface LauncherBinary {
  /** The file to run. */
  path: string;
  /** How it was identified, for the message when something looks wrong. */
  kind: "appimage" | "macos-app" | "executable";
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
  });
}
