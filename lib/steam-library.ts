// Finding Steam on this machine, and putting the launcher in its library.
//
// lib/steam-shortcut.ts builds the entry and lib/steam-vdf.ts encodes it; this
// is the half that touches the disk. The search is deliberately a LIST rather
// than a lookup: on Linux the same install answers to three or four paths (two
// of them symlinks into the third), Flatpak and Snap each move the whole tree,
// and a handheld running Bazzite is the Flatpak case. Guessing one and being
// wrong reads to the player as "Add to Steam did nothing".
//
// The one thing this cannot do anything about is Steam being open. Steam reads
// shortcuts.vdf when it starts and writes its own in-memory copy back when it
// quits, so a shortcut added underneath a running client is discarded the
// moment the player exits it. That is why `installShortcut` reports whether
// Steam looks like it is running and the UI says to restart it: there is no
// way to make the write stick while the client is up.

import { dirname, join } from "@std/path";
import {
  type AddResult,
  addShortcut,
  runGameId,
  type ShortcutInput,
} from "./steam-shortcut.ts";
import { parseBinaryVdf, VdfError, writeBinaryVdf } from "./steam-vdf.ts";

export type SteamOs = "linux" | "darwin" | "windows";

/**
 * Every place a Steam install might be, most likely first.
 *
 * The Linux entries are not alternatives so much as aliases: `~/.steam/steam`
 * and `~/.steam/root` are usually symlinks into `~/.local/share/Steam`.
 * `realpath` collapses them in `steamRoots`, which matters because writing the
 * same file twice through two names would double every shortcut.
 */
export function candidateRoots(
  os: SteamOs,
  env: Record<string, string>,
): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (os === "windows") {
    const programFiles86 = env["ProgramFiles(x86)"] ??
      "C:\\Program Files (x86)";
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      join(programFiles86, "Steam"),
      join(programFiles, "Steam"),
    ];
  }
  if (os === "darwin") {
    return home ? [join(home, "Library", "Application Support", "Steam")] : [];
  }
  if (!home) return [];
  const xdgData = env.XDG_DATA_HOME || join(home, ".local", "share");
  return [
    join(home, ".steam", "steam"),
    join(home, ".steam", "root"),
    join(xdgData, "Steam"),
    // Flatpak — the Steam Deck and Bazzite case.
    join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
    join(
      home,
      ".var",
      "app",
      "com.valvesoftware.Steam",
      ".local",
      "share",
      "Steam",
    ),
    // Snap.
    join(home, "snap", "steam", "common", ".local", "share", "Steam"),
  ];
}

async function realDir(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) return null;
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** The Steam installs actually on this disk, deduplicated by real path. */
export async function steamRoots(
  os: SteamOs,
  env: Record<string, string>,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidateRoots(os, env)) {
    const real = await realDir(join(candidate, "userdata"));
    if (!real) continue;
    const root = dirname(real);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/**
 * Each signed-in account's config directory under a root.
 *
 * The directory name is the 32-bit Steam3 account id. `0` and `anonymous` are
 * not people. Every account is written rather than only the most recent one:
 * on a shared machine the player who pressed the button is not reliably the
 * one Steam logged in last, and an extra shortcut in an account nobody uses
 * costs nothing.
 */
export async function steamAccounts(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(root, "userdata"))) {
      // The exFAT checkout this repo lives on grows `._*` sidecars beside every
      // file; they are not accounts, and neither is anything non-numeric.
      if (!entry.isDirectory || !/^\d+$/.test(entry.name)) continue;
      if (entry.name === "0") continue;
      const config = join(root, "userdata", entry.name, "config");
      try {
        if ((await Deno.stat(config)).isDirectory) out.push(config);
      } catch { /* an account with no config yet */ }
    }
  } catch { /* no userdata — not an install after all */ }
  return out.sort();
}

/** Whether a Steam client looks like it is running, which decides the advice. */
export async function steamIsRunning(
  os: SteamOs,
  env: Record<string, string>,
): Promise<boolean> {
  if (os !== "linux") return false; // nothing reliable to read without a process list
  const home = env.HOME ?? "";
  if (!home) return false;
  for (
    const pidFile of [
      join(home, ".steam", "steam.pid"),
      join(
        home,
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".steam",
        "steam.pid",
      ),
    ]
  ) {
    try {
      const pid = Number((await Deno.readTextFile(pidFile)).trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      // /proc is the only check that does not need a subprocess.
      if ((await Deno.stat(`/proc/${pid}`)).isDirectory) return true;
    } catch { /* no pid file, or the process is gone */ }
  }
  return false;
}

export interface InstallOutcome {
  /** The config directory written. */
  config: string;
  action: AddResult["action"];
  appId: number;
  /** `steam://rungameid/…` for this entry. */
  runUrl: string;
}

export interface InstallReport {
  ok: boolean;
  /** One entry per account written. */
  installed: InstallOutcome[];
  /** Why nothing was written, when nothing was. */
  reason?: string;
  /** Steam has to be restarted before it will show them. */
  steamRunning: boolean;
  /** Files that could not be read or written, with the reason. */
  problems: string[];
}

/**
 * Add (or bring up to date) the launcher's entry in every account on this
 * machine.
 *
 * A file that cannot be PARSED is never overwritten — it is somebody's whole
 * non-Steam library, and this code's understanding of the format is
 * reverse-engineered. It is reported as a problem and skipped, leaving the
 * player a library that still works and a message that says which file.
 *
 * The write is atomic per account: a temp file in the same directory, renamed
 * over. Steam reading a half-written shortcuts.vdf is the one failure here that
 * loses data.
 */
export async function installShortcut(
  input: ShortcutInput,
  options: { os: SteamOs; env: Record<string, string> },
): Promise<InstallReport> {
  const problems: string[] = [];
  const installed: InstallOutcome[] = [];
  const roots = await steamRoots(options.os, options.env);
  const steamRunning = await steamIsRunning(options.os, options.env);
  if (!roots.length) {
    return {
      ok: false,
      installed,
      steamRunning,
      problems,
      reason: "no Steam installation found on this machine",
    };
  }

  let accounts = 0;
  for (const root of roots) {
    for (const config of await steamAccounts(root)) {
      accounts++;
      const path = join(config, "shortcuts.vdf");
      let bytes = new Uint8Array(0);
      try {
        bytes = await Deno.readFile(path);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          problems.push(`${path}: ${(e as Error).message}`);
          continue;
        }
        // No file yet is the normal state for an account that has never added
        // a non-Steam game; an empty tree is exactly right.
      }
      let result: AddResult;
      try {
        result = addShortcut(parseBinaryVdf(bytes), input);
      } catch (e) {
        problems.push(
          `${path}: ${(e as Error).message}` +
            (e instanceof VdfError ? " — left untouched" : ""),
        );
        continue;
      }
      try {
        const temp = join(config, `.shortcuts.vdf.shmupx-${accounts}`);
        await Deno.writeFile(temp, writeBinaryVdf(result.root));
        await Deno.rename(temp, path);
      } catch (e) {
        problems.push(`${path}: ${(e as Error).message}`);
        continue;
      }
      installed.push({
        config,
        action: result.action,
        appId: result.appId,
        runUrl: `steam://rungameid/${runGameId(result.appId)}`,
      });
    }
  }

  if (!installed.length) {
    return {
      ok: false,
      installed,
      steamRunning,
      problems,
      reason: accounts
        ? "Steam is installed, but none of its accounts could be written"
        : "Steam is installed but nobody has signed in to it yet",
    };
  }
  return { ok: true, installed, steamRunning, problems };
}
