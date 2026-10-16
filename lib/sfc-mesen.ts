// lib/sfc-mesen.ts: Mesen's test runner as a headless Super Famicom, with a
// way back out.
//
// `Mesen --testRunner <rom> <script.lua>` boots a cart with no window, no
// sound and no pad, runs the Lua script against it, and exits with whatever
// the script hands emu.stop(). That is a console that can be asked questions
// — but only eight bits of answer come back through the exit code, the Lua
// sandbox has no `io` and nothing the script logs reaches stdout. The channel
// this module adds is the battery: Mesen writes the cart's SRAM to
// <home>/Saves/<rom base>.srm when it stops, so a script that fills SRAM with
// its findings (screenshots, memory dumps, a status line) before stopping has
// 128 KB delivered to disk, and runMesenWithBattery() brings it back.
//
// The save a script boots is the script's own business: emu.write() into
// snesSaveRam and emu.reset() puts any image under the cart without touching
// Mesen's folders, which is how scripts/lib/sfc-verify.ts does it. Whatever
// battery file was in the slot before a run is backed up to <home>/Saves/
// backup/ on disk, held in memory, and put back afterwards, so running a
// check never costs the operator the save Mesen keeps for that ROM.
//
// WHERE THINGS ARE
// The binary: --mesen, then $MESEN_BIN, then the macOS bundle in
// /Applications, else `mesen` on PATH. The home folder: $MESEN_HOME, then the
// folders Mesen builds use — ~/Library/Application Support/MesenCE and
// Mesen2 on macOS, ~/Documents/Mesen2 and ~/Mesen2 elsewhere — the first
// that exists. Mesen creates its home on first run, so a machine that has
// never launched it has no folder until one run has happened.

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";

const IS_WINDOWS = Deno.build.os === "windows";
const IS_MAC = Deno.build.os === "darwin";

/** Every failure this module reports; `message` is meant for the user. */
export class MesenError extends Error {
  override name = "MesenError";
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

/** The Mesen executable: an explicit path, then $MESEN_BIN, else the platform's usual place. */
export function findMesenBin(flag: string | null = null): string {
  if (flag) return flag;
  const env = Deno.env.get("MESEN_BIN");
  if (env) return env;
  if (IS_MAC) return "/Applications/Mesen.app/Contents/MacOS/Mesen";
  return IS_WINDOWS ? "Mesen.exe" : "mesen";
}

/** Whether `bin` names something that can be launched: a path that exists, or a name on PATH. */
export async function mesenBinExists(bin: string): Promise<boolean> {
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

/** Where Mesen's home folder may be, most likely first. */
export function mesenHomeCandidates(flag: string | null = null): string[] {
  const out: string[] = [];
  if (flag) out.push(resolve(flag));
  const env = Deno.env.get("MESEN_HOME");
  if (env) out.push(resolve(env));
  const h = home();
  if (IS_MAC) {
    out.push(join(h, "Library", "Application Support", "MesenCE"));
    out.push(join(h, "Library", "Application Support", "Mesen2"));
  }
  out.push(join(h, "Documents", "Mesen2"));
  out.push(join(h, "Mesen2"));
  return out;
}

/** The first candidate home folder that exists, or null. */
export async function findMesenHome(
  flag: string | null = null,
): Promise<string | null> {
  for (const dir of mesenHomeCandidates(flag)) {
    try {
      if ((await Deno.stat(dir)).isDirectory) return dir;
    } catch { /* not this one */ }
  }
  return null;
}

/** A ROM's base name: what Mesen names its battery after. */
export function romBaseName(romPath: string): string {
  return basename(romPath).replace(/\.[^.]+$/, "");
}

/** The battery file Mesen keeps for `romPath` under `home`. */
export function batteryPath(home: string, romPath: string): string {
  return join(home, "Saves", `${romBaseName(romPath)}.srm`);
}

/** A byte array as a Lua string literal body: three-digit decimal escapes, so no byte can run into the next. */
export function luaByteString(bytes: Uint8Array): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = "\\" + String(bytes[i]).padStart(3, "0");
  }
  return parts.join("");
}

export interface MesenRun {
  /** The exit code — what the script gave emu.stop(), 255 for Mesen's own timeout, null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  args: string[];
  ms: number;
  /** True when this module killed Mesen for overrunning the hard limit. */
  killed: boolean;
}

/**
 * Run one Lua script against one ROM in Mesen's test runner and wait for it.
 * `timeoutSec` is Mesen's own limit, after which it stops with -1; a hard
 * limit 30 s beyond that kills a Mesen that never got as far as its timer.
 */
export async function runMesenTest(
  { bin, rom, script, timeoutSec = 120 }: {
    bin: string;
    rom: string;
    script: string;
    timeoutSec?: number;
  },
): Promise<MesenRun> {
  const args = [
    "--testRunner",
    `--testRunnerTimeout=${timeoutSec}`,
    rom,
    script,
  ];
  const started = Date.now();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(bin, { args, stdout: "piped", stderr: "piped" })
      .spawn();
  } catch (e) {
    throw new MesenError(
      `could not start ${bin}: ${
        (e as Error).message
      }. Set MESEN_BIN to the Mesen executable (the macOS bundle's Contents/MacOS/Mesen), or pass --mesen.`,
    );
  }
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, (timeoutSec + 30) * 1000);
  const output = await child.output();
  clearTimeout(timer);
  const decoder = new TextDecoder();
  return {
    code: killed ? null : output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    args,
    ms: Date.now() - started,
    killed,
  };
}

export interface MesenBatteryRun {
  run: MesenRun;
  /** The SRAM Mesen wrote when it stopped, or null when no battery file appeared. */
  battery: Uint8Array | null;
  batteryPath: string;
  /** Where the slot's previous occupant was copied before the run, when there was one. */
  backupPath: string | null;
  /** The home folder the battery was read from. */
  home: string;
}

/**
 * Run a script and bring back the SRAM Mesen wrote on stop. The battery slot
 * for the ROM is emptied first so a stale file cannot pass for the run's
 * output, and whatever was in it is restored afterwards — from memory, with
 * a copy on disk under <home>/Saves/backup/ in case this process does not
 * get that far.
 */
export async function runMesenWithBattery(
  { bin, rom, script, home = null, timeoutSec = 120 }: {
    bin: string;
    rom: string;
    script: string;
    home?: string | null;
    timeoutSec?: number;
  },
): Promise<MesenBatteryRun> {
  let dir = await findMesenHome(home);
  if (!dir) {
    // A first run makes the folder; the battery it wrote tells us where.
    const run = await runMesenTest({ bin, rom, script, timeoutSec });
    dir = await findMesenHome(home);
    if (!dir) {
      throw new MesenError(
        `Mesen ran (exit ${run.code}) but no home folder appeared at any of: ${
          mesenHomeCandidates(home).join(", ")
        }. Set MESEN_HOME to the folder holding Mesen's Saves/ directory.`,
      );
    }
    const path = batteryPath(dir, rom);
    const battery = (await exists(path)) ? await Deno.readFile(path) : null;
    // The slot held nothing before, so leave it as the run left it only if
    // we must; the caller got the bytes, the folder goes back to empty.
    if (battery) await Deno.remove(path);
    return { run, battery, batteryPath: path, backupPath: null, home: dir };
  }

  const path = batteryPath(dir, rom);
  let previous: Uint8Array | null = null;
  let backupPath: string | null = null;
  if (await exists(path)) {
    previous = await Deno.readFile(path);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(
      dirname(path),
      "backup",
      `${romBaseName(rom)}.${stamp}.srm`,
    );
    await ensureDir(dirname(backupPath));
    await Deno.writeFile(backupPath, previous);
    await Deno.remove(path);
  }
  try {
    const run = await runMesenTest({ bin, rom, script, timeoutSec });
    const battery = (await exists(path)) ? await Deno.readFile(path) : null;
    return { run, battery, batteryPath: path, backupPath, home: dir };
  } finally {
    if (previous) {
      await ensureDir(dirname(path));
      await Deno.writeFile(path, previous);
    } else if (await exists(path)) {
      await Deno.remove(path);
    }
  }
}
