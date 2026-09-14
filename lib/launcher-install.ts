// Installing the launcher, so that the updater has somewhere to write.
//
// An .AppImage is one file that mounts itself read-only and runs the binary
// from inside that mount (lib/launcher-binary.ts). That is what makes it a good
// way to SHIP a launcher and a hopeless way to KEEP one current:
// `Deno.autoUpdate` patches the app's runtime dylib in place — it writes
// `<dylib>.update` beside it and the next launch swaps that in — and there is
// nowhere under /tmp/.mount_* to put either file. lib/self-update.ts refuses to
// arm on an AppImage for exactly that reason, and tells the player to install
// it from Settings -> ADD TO STEAM. This is that install: the step that turns
// the refusal into a way out instead of a wall.
//
// It is a COPY, not an extraction. The AppImage runtime has already mounted the
// squashfs and exported $APPDIR pointing at the mount, so the whole application
// tree is sitting there readable — copying it needs no FUSE, no
// `--appimage-extract` subprocess and no squashfs reader of our own, and what
// lands is the same directory `deno task build:linux --no-appimage` produces.
//
// Linux only, and deliberately. The macOS bundle is code-signed and a patched
// one would not load wherever it lived, and the Windows .exe has no updater at
// all (lib/self-update.ts): installing either would move ~500MB for no gain.
//
// Nothing here decides to install. routes/api/steam.ts does it as part of ADD
// TO STEAM, because the shortcut and the writable copy are the same wish —
// "put this in my library and keep it current" — and asking twice for one
// outcome is how a handheld ends up with two entries.

import { join } from "@std/path";
import { copy } from "@std/fs";
import { type DesktopOs, launcherDataDir } from "./desktop-browser.ts";
import type { LauncherBinary } from "./launcher-binary.ts";

/**
 * Where an installed copy lives: `app/` inside the launcher's own data
 * directory.
 *
 * Under the data dir rather than beside it because that directory already
 * exists, is already writable, and is already the thing the player would delete
 * to start over — the browser profiles the launcher spawns live there too
 * (lib/desktop-browser.ts). `~/.local/share/shmupX/app` on Linux.
 */
export function installDir(os: DesktopOs, env: Record<string, string>): string {
  const base = launcherDataDir(os, env);
  return os === "windows" ? `${base}\\app` : `${base}/app`;
}

/**
 * The file to run inside an installed tree.
 *
 * `AppRun` at the root is the one thing the AppImage format guarantees — the
 * layout under it is the application's own business, and this code has no
 * opinion about where `deno desktop` puts its binary.
 */
export function installedExe(dir: string): string {
  return join(dir, "AppRun");
}

export interface InstallPlan {
  /** Whether installing would do anything. */
  can: boolean;
  /** Where the copy goes. */
  dir: string;
  /** What the Steam shortcut should point at once it is there. */
  exe: string;
  /** The mounted tree to copy, when this build is running from one. */
  source: string | null;
  /** Why there is nothing to install, when there is not. */
  reason: string | null;
}

export interface InstallContext {
  os: DesktopOs;
  env: Record<string, string>;
  /** `currentLauncherBinary()` — which file this launcher is. */
  binary: LauncherBinary | null;
}

/**
 * Whether this launcher can install itself, and where it would land.
 *
 * Pure, so tests/launcher_install_test.ts can ask about an AppImage from a
 * machine that is not running one.
 */
export function installPlan(ctx: InstallContext): InstallPlan {
  const dir = installDir(ctx.os, ctx.env);
  const off = (reason: string): InstallPlan => ({
    can: false,
    dir,
    exe: installedExe(dir),
    source: null,
    reason,
  });
  if (!ctx.binary) {
    return off("this is a source checkout — there is no launcher to install");
  }
  if (ctx.binary.kind === "installed") {
    return off("this launcher is already installed, and updates itself");
  }
  if (ctx.os !== "linux" || ctx.binary.kind !== "appimage") {
    // Not a failure: a .app and an .exe are added to Steam where they are, and
    // both would be exactly as updatable from a copy as they are now.
    return off(
      "only the Linux AppImage is installed; this build runs in place",
    );
  }
  // $APPDIR is the AppImage runtime's own export, set beside $APPIMAGE. Without
  // it there is a mounted tree somewhere and no way to name it — refuse rather
  // than reconstruct a path from execPath, which would be a guess at the layout
  // this module deliberately has no opinion about.
  const source = (ctx.env.APPDIR ?? "").trim();
  if (!source) {
    return off(
      "the AppImage runtime did not say where it is mounted, so there is " +
        "nothing to copy",
    );
  }
  if (!(ctx.env.HOME ?? "").trim()) {
    return off("there is no HOME to install into");
  }
  return { can: true, dir, exe: installedExe(dir), source, reason: null };
}

export interface InstallOutcome {
  ok: boolean;
  /** The installed tree. */
  dir: string;
  /** The file to run — what the shortcut points at. */
  exe: string;
  /** Bytes written, for the line the player sees. */
  bytes: number;
  /** Why it did not install, when it did not. */
  error: string | null;
}

/** Every file under a tree, added up — what the copy is about to cost. */
async function treeSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) {
        await walk(child);
      } else if (entry.isFile) {
        try {
          total += (await Deno.stat(child)).size;
        } catch { /* vanished mid-walk; it is a size, not a ledger */ }
      }
    }
  };
  try {
    await walk(dir);
  } catch { /* unreadable; report what was counted */ }
  return total;
}

async function removeTree(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/**
 * Copy the mounted AppImage tree into the data directory.
 *
 * The copy lands in `app.new` and is only swapped over `app` once `AppRun` is
 * confirmed inside it, because the failure this guards against is silent: a
 * half-copied tree is still a directory, the shortcut still points at it, and
 * the player presses play on a launcher that no longer starts. The old tree is
 * kept until that moment — which does mean two copies on disk at once, ~1GB on
 * a handheld, for the length of one copy.
 *
 * Never throws. A launcher that will not add itself to Steam because an install
 * failed is worse than one that says why.
 */
export async function installLauncher(plan: InstallPlan): Promise<
  InstallOutcome
> {
  const fail = (error: string, bytes = 0): InstallOutcome => ({
    ok: false,
    dir: plan.dir,
    exe: plan.exe,
    bytes,
    error,
  });
  if (!plan.can || !plan.source) {
    return fail(plan.reason ?? "there is nothing to install");
  }
  const staging = `${plan.dir}.new`;
  try {
    await Deno.mkdir(plan.dir.replace(/[/\\][^/\\]+$/, ""), {
      recursive: true,
    });
    // A staging tree left by a run that died partway through is not a resume
    // point — it is an unknown fraction of an older build.
    await removeTree(staging);
    await copy(plan.source, staging, { overwrite: true });
  } catch (e) {
    await removeTree(staging).catch(() => {});
    return fail(`the copy failed: ${(e as Error).message}`);
  }
  const stagedExe = installedExe(staging);
  try {
    await Deno.stat(stagedExe);
  } catch {
    await removeTree(staging).catch(() => {});
    return fail(
      "the copied tree has no AppRun in it, so it would not start — nothing " +
        "was installed",
    );
  }
  const bytes = await treeSize(staging);
  try {
    await removeTree(plan.dir);
    await Deno.rename(staging, plan.dir);
  } catch (e) {
    return fail(
      `the installed copy could not be put in place: ${(e as Error).message}`,
      bytes,
    );
  }
  return { ok: true, dir: plan.dir, exe: plan.exe, bytes, error: null };
}
