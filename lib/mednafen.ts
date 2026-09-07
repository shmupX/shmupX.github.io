// Mednafen as the Saturn that has a backup cartridge.
//
// The browser's Saturn core (yabause, EmulatorJS) keeps only the console's
// 32 KB internal backup memory, and a level exported from the editor is a
// ~110 KB save — most games do not fit. Mednafen does have the 512 KB
// cartridge, so it is where a level goes to be played on a desktop: convert
// the MiSTer-layout .sav to Mednafen's <disc>.bcr/.bkr save pair, drop it in
// Mednafen's save directory under the disc's name, start Mednafen on the disc.
//
// Two callers share this: `deno task sav:run` (scripts/run-mednafen.ts, the
// CLI, which builds the .sav first) and POST /api/saturn-save (the editor's
// "→ MEDNAFEN CART" row, which sends the .sav it just built). Everything here
// reports failure by throwing MednafenError with a message a person can act
// on; the CLI prints it and exits, the route returns it.
//
// The Mednafen binary, the disc image and the BIOS are the user's own (the
// disc and BIOS are community content, never in the repo), so their locations
// come from arguments or env vars:
//
//   MEDNAFEN_BIN            path to the mednafen executable (else found on PATH;
//                           on Windows give a full path so the save dir resolves)
//   DEZAEMON_DISC           the .cue / .m3u disc image (a few common spots are
//                           auto-probed when unset)
//   MEDNAFEN_SAV            the Mednafen save directory (default: <base>/sav,
//                           base = the exe dir on Windows, else $MEDNAFEN_HOME or
//                           ~/.mednafen)
//   MEDNAFEN_LD_LIBRARY_PATH prepended to LD_LIBRARY_PATH for the child (for a
//                           Mednafen unpacked outside the system libs, as on WSL)
//
// Mednafen is launched with `-filesys.fname_sav %f.%x`, so the save file is
// named after the disc (<disc-basename>.bcr/.bkr) regardless of the user's
// mednafen.cfg — that is the name written here. An existing .bcr is backed up
// to <sav>/backup/ first. Close Mednafen before installing: it rewrites its
// save files on exit.

import { dirname, isAbsolute, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  CART_PARTITION_SIZE,
  INTERNAL_PARTITION_SIZE,
  normalize,
} from "../packages/shmup-engine/mod.js";

const IS_WINDOWS = Deno.build.os === "windows";

/** Every failure this module reports; `message` is meant for the user. */
export class MednafenError extends Error {
  override name = "MednafenError";
}

export interface MednafenPaths {
  /** The executable: a path, or a bare name to be found on PATH. */
  bin: string;
  /** The disc image (.cue / .m3u), absolute. */
  disc: string;
  /** Mednafen's save directory, absolute. */
  savDir: string;
  /** The disc's base name — what the save pair is called. */
  name: string;
}

export interface MednafenResolution extends MednafenPaths {
  /** True when both the executable and the disc were found. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason: string | null;
}

export interface CartInstall {
  bcrPath: string;
  bkrPath: string;
  /** Where the previous .bcr went, or null when there was none. */
  backupPath: string | null;
  bcrBytes: number;
  bkrBytes: number;
}

function home(): string {
  return (IS_WINDOWS ? Deno.env.get("USERPROFILE") : Deno.env.get("HOME")) ||
    ".";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The MiSTer-layout .sav → Mednafen's cart (.bcr, gzip of the 512 KB cart) and
 * internal RAM (.bkr, raw 32 KB), the shape Mednafen reads and writes. Accepts
 * anything normalize() does — the interleaved 1,114,112-byte image, a gzip of
 * it, or the 557,056-byte logical bytes. */
export async function toMednafenPair(
  sav: Uint8Array,
): Promise<{ bcr: Uint8Array; bkr: Uint8Array }> {
  const { data } = await normalize(sav);
  const expected = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;
  if (data.length !== expected) {
    throw new MednafenError(
      `the .sav normalizes to ${data.length} bytes, expected ${expected} ` +
        `(32 KB internal + 512 KB cart)`,
    );
  }
  const cart = data.subarray(INTERNAL_PARTITION_SIZE);
  const bcr = new Uint8Array(
    await new Response(
      new Blob([cart]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  return { bcr, bkr: data.slice(0, INTERNAL_PARTITION_SIZE) };
}

/** The disc image: an explicit path, then DEZAEMON_DISC, then a few common
 * spots. Null when nothing is there — the disc is community content and is
 * never in the repo, so that is the normal state of a fresh machine. */
export async function findDisc(
  flag: string | null = null,
): Promise<string | null> {
  const candidates = [
    flag,
    Deno.env.get("DEZAEMON_DISC"),
    join(home(), "saturn", "Dezaemon 2 (Japan)", "Dezaemon 2 (Japan).cue"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (await exists(c)) return resolve(c);
  }
  // last resort: any .cue beside the auto-probed disc folder
  const dir = join(home(), "saturn", "Dezaemon 2 (Japan)");
  if (await exists(dir)) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.toLowerCase().endsWith(".cue")) {
        return join(dir, e.name);
      }
    }
  }
  return null;
}

export const NO_DISC_MESSAGE =
  "no disc image found. Set DEZAEMON_DISC=/path/to/'Dezaemon 2 (Japan).cue' " +
  "(or pass --disc PATH). The disc is community content and is not in the repo.";

/** The Mednafen executable: an explicit path, then MEDNAFEN_BIN, else the
 * PATH name. */
export function findBin(flag: string | null = null): string {
  return flag || Deno.env.get("MEDNAFEN_BIN") ||
    (IS_WINDOWS ? "mednafen.exe" : "mednafen");
}

/** Running a Windows mednafen.exe from WSL, via binfmt interop — the way a WSL
 * user reaches the Windows Mednafen (the only one that sees a USB/Bluetooth pad,
 * e.g. a Stadia controller; WSL exposes no /dev/input). Path arguments handed to
 * the .exe must be Windows paths, and it lays its saves out portably (beside the
 * exe) like a native Windows install. */
export function isWslExe(bin: string, os: string = Deno.build.os): boolean {
  return os !== "windows" && /\.exe$/i.test(bin);
}

/** Translate a WSL path to the Windows form a Windows .exe understands. */
export function toWinPath(p: string): string {
  try {
    const { stdout, success } = new Deno.Command("wslpath", {
      args: ["-w", p],
    }).outputSync();
    if (success) return new TextDecoder().decode(stdout).trim();
  } catch { /* fall through */ }
  return p;
}

/** Mednafen's save directory: an explicit dir, then MEDNAFEN_SAV, else
 * <base>/sav. Throws when a portable (Windows) Mednafen was named without a
 * directory, since there is then no way to know where its saves live. */
export function savDirFor(flag: string | null, bin: string): string {
  const explicit = flag || Deno.env.get("MEDNAFEN_SAV");
  if (explicit) return resolve(explicit);
  const portable = IS_WINDOWS || isWslExe(bin); // Windows Mednafen keeps saves beside the exe
  const base = portable
    ? dirname(bin)
    : (Deno.env.get("MEDNAFEN_HOME") || join(home(), ".mednafen"));
  if (portable && (base === "." || !base)) {
    throw new MednafenError(
      "cannot tell where Mednafen keeps saves. Give MEDNAFEN_BIN a full path to " +
        "mednafen.exe, or set MEDNAFEN_SAV to the sav directory.",
    );
  }
  return resolve(join(base, "sav"));
}

/** A path's file name without its extension: the disc's save name. */
export function baseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() || path;
  return file.replace(/\.[^.]+$/, "");
}

/** Whether `bin` names something that can be launched: a path that exists,
 * or a bare name some PATH entry holds (with PATHEXT on Windows). */
export async function binExists(bin: string): Promise<boolean> {
  if (isAbsolute(bin) || /[\\/]/.test(bin)) return await exists(bin);
  const dirs = (Deno.env.get("PATH") || "").split(IS_WINDOWS ? ";" : ":")
    .filter(Boolean);
  const exts = IS_WINDOWS && !/\.[^.\\/]+$/.test(bin)
    ? (Deno.env.get("PATHEXT") || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await exists(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

/**
 * Resolve where everything is, without insisting that it is. `available`
 * says whether a launch could work; `reason` says what is missing when it
 * could not. Only savDir's failure is fatal, since without it nothing can be
 * installed at all.
 */
export async function resolveMednafen(
  { bin = null, disc = null, savDir = null }: {
    bin?: string | null;
    disc?: string | null;
    savDir?: string | null;
  } = {},
): Promise<MednafenResolution> {
  const exe = findBin(bin);
  const found = await findDisc(disc);
  let dir: string;
  try {
    dir = savDirFor(savDir, exe);
  } catch (e) {
    return {
      bin: exe,
      disc: found ?? "",
      savDir: "",
      name: found ? baseName(found) : "",
      available: false,
      reason: (e as Error).message,
    };
  }
  const hasBin = await binExists(exe);
  const reason = !found
    ? NO_DISC_MESSAGE
    : !hasBin
    ? `could not find "${exe}". Set MEDNAFEN_BIN to the mednafen executable (or put it on PATH).`
    : null;
  return {
    bin: exe,
    disc: found ?? "",
    savDir: dir,
    name: found ? baseName(found) : "",
    available: reason === null,
    reason,
  };
}

/** The name an existing cart is backed up under, beside the save directory. */
export function backupFileName(name: string, now: Date): string {
  return `${name}.${now.toISOString().replace(/[:.]/g, "-")}.bcr`;
}

/**
 * Convert `sav` and write it as <savDir>/<name>.bcr + .bkr, backing up an
 * existing .bcr to <savDir>/backup/ first. Nothing is written until the
 * conversion has succeeded, so a bad .sav leaves the save directory alone.
 */
export async function installCartSave(
  sav: Uint8Array,
  paths: Pick<MednafenPaths, "savDir" | "name">,
  { now = new Date() }: { now?: Date } = {},
): Promise<CartInstall> {
  const { bcr, bkr } = await toMednafenPair(sav);
  await ensureDir(paths.savDir);
  const bcrPath = join(paths.savDir, `${paths.name}.bcr`);
  const bkrPath = join(paths.savDir, `${paths.name}.bkr`);
  let backupPath: string | null = null;
  if (await exists(bcrPath)) {
    const backup = join(paths.savDir, "backup");
    await ensureDir(backup);
    backupPath = join(backup, backupFileName(paths.name, now));
    await Deno.copyFile(bcrPath, backupPath);
  }
  await Deno.writeFile(bcrPath, bcr);
  await Deno.writeFile(bkrPath, bkr);
  return {
    bcrPath,
    bkrPath,
    backupPath,
    bcrBytes: bcr.length,
    bkrBytes: bkr.length,
  };
}

/** The argument list Mednafen is started with: the save name forced to match
 * the disc, whatever the cfg says; the disc as a Windows path when a Windows
 * .exe is being run from WSL. */
export function mednafenArgs(
  disc: string,
  passThrough: string[] = [],
  { bin = "mednafen", winPath = toWinPath, os = Deno.build.os }: {
    bin?: string;
    winPath?: (p: string) => string;
    os?: string;
  } = {},
): string[] {
  return [
    "-filesys.fname_sav",
    "%f.%x",
    "-cd.image_memcache",
    "1",
    ...passThrough,
    isWslExe(bin, os) ? winPath(disc) : disc,
  ];
}

/** The child's extra environment: MEDNAFEN_LD_LIBRARY_PATH ahead of the
 * system libs, on the platforms that have such a thing. */
export function mednafenEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const extraLib = Deno.env.get("MEDNAFEN_LD_LIBRARY_PATH");
  if (extraLib && !IS_WINDOWS) {
    const cur = Deno.env.get("LD_LIBRARY_PATH");
    env.LD_LIBRARY_PATH = cur ? `${extraLib}:${cur}` : extraLib;
  }
  return env;
}

/**
 * Start Mednafen on the disc. `wait: true` (the CLI) inherits the terminal
 * and resolves with the exit code once Mednafen quits; `wait: false` (the
 * route) detaches the child so the request returns while the game runs, and
 * resolves with its pid. A launch that cannot start at all — no such
 * executable — throws.
 */
export async function launchMednafen(
  paths: Pick<MednafenPaths, "bin" | "disc">,
  { passThrough = [], wait = true, onLaunch }: {
    passThrough?: string[];
    wait?: boolean;
    /** Told the final argument list just before the child starts. */
    onLaunch?: (args: string[]) => void;
  } = {},
): Promise<{ code: number | null; pid: number | null; args: string[] }> {
  const args = mednafenArgs(paths.disc, passThrough, { bin: paths.bin });
  const env = mednafenEnv();
  onLaunch?.(args);
  try {
    if (wait) {
      const { code } = await new Deno.Command(paths.bin, {
        args,
        env,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      }).output();
      return { code, pid: null, args };
    }
    const child = new Deno.Command(paths.bin, {
      args,
      env,
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();
    child.unref();
    return { code: null, pid: child.pid, args };
  } catch (e) {
    throw new MednafenError(
      `could not launch "${paths.bin}": ${
        e instanceof Error ? e.message : e
      }. Set MEDNAFEN_BIN to the mednafen executable (or put it on PATH).`,
    );
  }
}
