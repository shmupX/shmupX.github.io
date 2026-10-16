// lib/sfc-openemu.ts: a Super Famicom Dezaemon SRAM image as OpenEmu's battery
// save for the cart in its library, and the cart booted on it.
//
// The macOS leg beside lib/sfc-mednafen.ts, and the same shape — find the ROM,
// find the save slot, back the slot up, write, read back, start the game —
// with two things only OpenEmu has:
//
// THE SLOT IS NAMED AFTER THE LIBRARY'S COPY OF THE ROM. OpenEmu runs the
// Super Famicom on its SNES9x core and keeps a cart's battery RAM as
// ~/Library/Application Support/OpenEmu/SNES9x/Battery Saves/<rom base>.sav —
// the raw 131,072 bytes, .sav rather than .srm, named after the ROM file in
// Game Library/roms/Super Nintendo (SNES)/. The ROM is found there by its
// contents (src/sfc/rom.js isDezaemonRom), never by name, because the
// library's copy is whatever the user imported.
//
// A SAVE STATE OUTRANKS THE BATTERY. OpenEmu writes an "Auto Save State"
// when a game quits and restores it when the game is next opened, and a
// state is the whole console — cart RAM included. Resume one and the game is
// back where it was, the new battery file never read, and on the next quit
// the state's RAM is written over it. So a battery is only loaded by a cold
// boot, and a cold boot only happens when the game has no auto state. Moving
// the state's bundle aside is not enough: OpenEmu tracks states in its Core
// Data library (Game Library/Library.storedata, ZSAVESTATE), and a bundle
// gone from under a row makes the next launch complain that "State" could not
// be opened. retireAutoSaveState() therefore does both, with OpenEmu closed:
// the bundle goes to the battery backup folder, and the row goes with
// sqlite3, which macOS ships. Only rows for THIS rom's OESpecialState_auto
// are touched; named save states are the user's and stay.
//
// OpenEmu rewrites the slot when a game closes, so nothing here writes while
// it runs: quitOpenEmu() asks it to quit (AppleScript) and waits, and the
// caller decides whether that is acceptable.

import { basename, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { isDezaemonRom } from "../packages/shmup-engine/src/sfc/rom.js";
import { isSfcSav, SRAM_SIZE } from "../packages/shmup-engine/src/sfc/sram.js";

/** Every failure this module reports; `message` is meant for the user. */
export class OpenEmuError extends Error {
  override name = "OpenEmuError";
}

function home(): string {
  return Deno.env.get("HOME") || ".";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** OpenEmu's Application Support folder: $OPENEMU_SUPPORT, else the usual place. */
export function openEmuSupportDir(flag: string | null = null): string {
  return resolve(
    flag || Deno.env.get("OPENEMU_SUPPORT") ||
      join(home(), "Library", "Application Support", "OpenEmu"),
  );
}

export interface OpenEmuPaths {
  support: string;
  /** Game Library/roms/Super Nintendo (SNES)/ */
  romsDir: string;
  /** SNES9x/Battery Saves/ */
  batteryDir: string;
  /** Save States/SuperNES/ */
  statesDir: string;
  /** Game Library/Library.storedata */
  database: string;
}

export function openEmuPaths(support: string): OpenEmuPaths {
  return {
    support,
    romsDir: join(support, "Game Library", "roms", "Super Nintendo (SNES)"),
    batteryDir: join(support, "SNES9x", "Battery Saves"),
    statesDir: join(support, "Save States", "SuperNES"),
    database: join(support, "Game Library", "Library.storedata"),
  };
}

export interface OpenEmuRom {
  path: string;
  name: string;
  /** The file name without its extension: what the slot and the states folder are named after. */
  base: string;
  size: number;
}

const ROM_EXTENSIONS = [".sfc", ".smc", ".fig", ".swc"];

/** The Dezaemon cart in OpenEmu's SNES library, by its contents, or null. */
export async function findOpenEmuRom(
  romsDir: string,
): Promise<OpenEmuRom | null> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(romsDir)];
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const lower = entry.name.toLowerCase();
    if (!entry.isFile || entry.name.startsWith("._")) continue;
    if (!ROM_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const path = join(romsDir, entry.name);
    let bytes: Uint8Array;
    try {
      const info = await Deno.stat(path);
      if (info.size < 0x40000 || info.size > 0x800000) continue;
      bytes = await Deno.readFile(path);
    } catch {
      continue;
    }
    if (!isDezaemonRom(bytes)) continue;
    return {
      path,
      name: entry.name,
      base: entry.name.replace(/\.[^.]+$/, ""),
      size: bytes.length,
    };
  }
  return null;
}

/** The battery slot for `rom`: <batteryDir>/<rom base>.sav. */
export function batterySlot(batteryDir: string, rom: OpenEmuRom): string {
  return join(batteryDir, `${rom.base}.sav`);
}

/** The folder OpenEmu keeps `rom`'s save states in. */
export function statesFolder(statesDir: string, rom: OpenEmuRom): string {
  return join(statesDir, rom.base);
}

export interface SlotInstall {
  slotPath: string;
  backupPath: string | null;
  replaced: boolean;
}

/**
 * Install `sram` as the slot, with whatever was there copied to
 * <batteryDir>/backup/<base>.<stamp>.sav first. The bytes are read back and
 * compared before this reports success.
 */
export async function installOpenEmuSram(
  sram: Uint8Array,
  { batteryDir, rom }: { batteryDir: string; rom: OpenEmuRom },
): Promise<SlotInstall> {
  if (sram.length !== SRAM_SIZE || !isSfcSav(sram)) {
    throw new OpenEmuError(
      `a Dezaemon SRAM image is ${SRAM_SIZE} bytes carrying "T.TABATA" at 0x7FF8; got ${sram.length}${
        sram.length === SRAM_SIZE ? " without the magic" : ""
      }`,
    );
  }
  await ensureDir(batteryDir);
  const slotPath = batterySlot(batteryDir, rom);
  let backupPath: string | null = null;
  const replaced = await exists(slotPath);
  if (replaced) {
    backupPath = join(batteryDir, "backup", `${rom.base}.${stamp()}.sav`);
    await ensureDir(join(batteryDir, "backup"));
    await Deno.copyFile(slotPath, backupPath);
  }
  await Deno.writeFile(slotPath, sram);
  const back = await Deno.readFile(slotPath);
  if (back.length !== sram.length || back.some((b, i) => b !== sram[i])) {
    throw new OpenEmuError(`${slotPath} did not read back as written`);
  }
  return { slotPath, backupPath, replaced };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export const AUTO_STATE_BUNDLE = "Auto Save State.oesavestate";
/** The ZNAME OpenEmu gives the state it restores on launch. */
export const AUTO_STATE_NAME = "OESpecialState_auto";

export interface AutoStateRetirement {
  /** Where the bundle went, or null when there was none on disk. */
  movedTo: string | null;
  /** Rows deleted from ZSAVESTATE, or null when the database was not touched. */
  rowsDeleted: number | null;
  /** What the sqlite step said when it could not run. */
  databaseNote: string | null;
}

/**
 * The library's ZLOCATION for a state bundle: the path under Save States/,
 * percent-encoded the way Core Data's URL stores it. "SuperNES/<base>/Auto
 * Save State.oesavestate", with every space a %20 and the brackets, commas
 * and parentheses a ROM name tends to carry left as they are.
 */
export function autoStateLocation(rom: OpenEmuRom): string {
  const rel = `SuperNES/${rom.base}/${AUTO_STATE_BUNDLE}`;
  // encodeURIComponent and Core Data agree: spaces and brackets encoded,
  // parentheses, hyphens and dots literal.
  return rel.split("/").map(encodeURIComponent).join("/");
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Retire the auto save state for `rom`, so the next launch is a cold boot
 * that reads the battery: the bundle to <batteryDir>/backup/, the library
 * row deleted. `sqlite3` is macOS's own; when it is missing the bundle still
 * moves and `databaseNote` says the row is left (one "could not be opened"
 * dialog, then OpenEmu writes a fresh state over the row on the next quit).
 * Call with OpenEmu closed: Core Data holds the store open while it runs.
 */
export async function retireAutoSaveState(
  { statesDir, batteryDir, database, rom, sqlite = "sqlite3" }: {
    statesDir: string;
    batteryDir: string;
    database: string;
    rom: OpenEmuRom;
    sqlite?: string;
  },
): Promise<AutoStateRetirement> {
  const bundle = join(statesFolder(statesDir, rom), AUTO_STATE_BUNDLE);
  let movedTo: string | null = null;
  if (await exists(bundle)) {
    movedTo = join(batteryDir, "backup", `${rom.base}.${stamp()}.oesavestate`);
    await ensureDir(join(batteryDir, "backup"));
    await Deno.rename(bundle, movedTo);
  }
  let rowsDeleted: number | null = null;
  let databaseNote: string | null = null;
  if (!(await exists(database))) {
    databaseNote = `no library database at ${database}`;
  } else {
    const where = `ZNAME = ${sqlQuote(AUTO_STATE_NAME)} AND ZLOCATION = ${
      sqlQuote(autoStateLocation(rom))
    }`;
    try {
      const out = await new Deno.Command(sqlite, {
        args: [
          database,
          `DELETE FROM ZSAVESTATE WHERE ${where}; SELECT changes();`,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!out.success) {
        databaseNote = `sqlite3 failed: ${
          new TextDecoder().decode(out.stderr).trim()
        }`;
      } else {
        rowsDeleted = Number(new TextDecoder().decode(out.stdout).trim()) || 0;
      }
    } catch (e) {
      databaseNote = `could not run ${sqlite}: ${(e as Error).message}`;
    }
  }
  return { movedTo, rowsDeleted, databaseNote };
}

/** Whether OpenEmu has a process. */
export async function openEmuRunning(): Promise<boolean> {
  try {
    const out = await new Deno.Command("pgrep", { args: ["-x", "OpenEmu"] })
      .output();
    return out.success;
  } catch {
    return false;
  }
}

/** Ask OpenEmu to quit and wait for it to go; it writes its battery saves on the way out. */
export async function quitOpenEmu(timeoutMs = 20_000): Promise<void> {
  if (!(await openEmuRunning())) return;
  await new Deno.Command("osascript", {
    args: ["-e", 'tell application "OpenEmu" to quit'],
  }).output();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await openEmuRunning())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new OpenEmuError(
    "OpenEmu did not quit; close it (it may be asking about an unsaved state) and run again",
  );
}

/** Open the ROM in OpenEmu, which starts it. */
export async function launchOpenEmu(
  rom: OpenEmuRom,
  app = "OpenEmu",
): Promise<void> {
  const out = await new Deno.Command("open", { args: ["-a", app, rom.path] })
    .output();
  if (!out.success) {
    throw new OpenEmuError(
      `could not open ${basename(rom.path)} in ${app}: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
}
