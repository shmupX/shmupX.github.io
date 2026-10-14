// lib/sfc-mednafen.ts: a Super Famicom Dezaemon SRAM image as Mednafen's save
// for the cart on this machine.
//
// The Super Famicom half of lib/psx-mednafen.ts, and the same shape: find the
// ROM (lib/dezaemon-sfc.ts, by content), find Mednafen and its save
// directory, write the 128 KB SRAM as the file Mednafen reads back for that
// ROM, and start the emulator on the ROM. Under the `-filesys.fname_sav %f.%x`
// every launch here passes, the SNES modules keep a cart's battery RAM as
// <rom base>.srm beside the Saturn's .bcr and the PlayStation's .0.mcr — so
// "Dezaemon (EN).sfc" reads "Dezaemon (EN).srm", which is the raw 131,072-byte
// dump with no header, the same bytes an emulator dumps and the SFC parser
// reads (packages/shmup-engine/src/sfc/sram.js).
//
// The image is checked before anything touches the disk: 131,072 bytes
// carrying "T.TABATA" at 0x7FF8, or it is not a Dezaemon save. Whatever was in
// the slot is copied to <savDir>/backup/ first, because an SRAM file is the
// whole cart: there is no slot to merge into.

import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  binExists,
  findBin,
  launchMednafen,
  MednafenError,
  savDirFor,
} from "@shmupx/shmup-harbor/mednafen";
import {
  type DezaemonSfcRom,
  findDezaemonSfcRom,
  repoRoot,
} from "./dezaemon-sfc.ts";
import { isSfcSav, SRAM_SIZE } from "../packages/shmup-engine/src/sfc/sram.js";

export { MednafenError };

/** The raw SRAM image Mednafen keeps: 128 KB, "T.TABATA" at 0x7FF8. */
export const SFC_SRAM_SIZE = SRAM_SIZE;

export interface SfcMednafenResolution {
  available: boolean;
  reason: string | null;
  bin: string;
  /** The ROM Mednafen is started on. */
  rom: string | null;
  found: DezaemonSfcRom | null;
  savDir: string;
  /** The ROM's base name — what the save is named after. */
  name: string;
  /** Where the SRAM file lives, whether or not it exists yet. */
  sramPath: string | null;
}

/** A path's file name without its extension: the ROM's save name. */
export function romBaseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() || path;
  return file.replace(/\.[^.]+$/, "");
}

/** The save's name under `-filesys.fname_sav %f.%x`: <base>.srm. */
export function sramFileName(base: string): string {
  return `${base}.srm`;
}

/**
 * Where everything is, without insisting that it is: the ROM, the executable
 * and the save directory. `available` says whether a launch could start;
 * `reason` says what is missing when it could not.
 */
export async function resolveSfcMednafen(
  { bin = null, savDir = null, root = null, extra = [] }: {
    bin?: string | null;
    savDir?: string | null;
    root?: string | null;
    extra?: string[];
  } = {},
): Promise<SfcMednafenResolution> {
  const exe = findBin(bin);
  const at = root ?? await repoRoot();
  const found = await findDezaemonSfcRom(at, { extra });
  const rom = found ? found.path : null;
  let dir: string;
  try {
    dir = savDirFor(savDir, exe);
  } catch (e) {
    return {
      available: false,
      reason: (e as Error).message,
      bin: exe,
      rom,
      found,
      savDir: "",
      name: rom ? romBaseName(rom) : "",
      sramPath: null,
    };
  }
  const name = rom ? romBaseName(rom) : "";
  const hasBin = await binExists(exe);
  const reason = !found
    ? "no Super Famicom Dezaemon ROM in dev-fixtures/ (a .sfc/.smc whose " +
      "internal header names DEZAEMON with 128 KB of SRAM; $DEZAEMON_SFC_ROM is looked at too)"
    : !hasBin
    ? `could not find "${exe}". Set MEDNAFEN_BIN to the mednafen executable (or put it on PATH).`
    : null;
  return {
    available: reason === null,
    reason,
    bin: exe,
    rom,
    found,
    savDir: dir,
    name,
    sramPath: name ? join(dir, sramFileName(name)) : null,
  };
}

export interface SfcSramInstall {
  sramPath: string;
  backupPath: string | null;
  replaced: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install `sram` as the ROM's save: <savDir>/<name>.srm, with whatever was
 * there copied to <savDir>/backup/<name>.<stamp>.srm first. The bytes are
 * read back and compared before this reports success.
 */
export async function installSfcSram(
  sram: Uint8Array,
  { savDir, name }: { savDir: string; name: string },
): Promise<SfcSramInstall> {
  if (sram.length !== SFC_SRAM_SIZE || !isSfcSav(sram)) {
    throw new MednafenError(
      `a Dezaemon SRAM image is ${SFC_SRAM_SIZE} bytes carrying "T.TABATA" at 0x7FF8; got ${sram.length}${
        sram.length === SFC_SRAM_SIZE ? " without the magic" : ""
      }`,
    );
  }
  if (!name) throw new MednafenError("the save needs the ROM's name");
  await ensureDir(savDir);
  const sramPath = resolve(join(savDir, sramFileName(name)));
  let backupPath: string | null = null;
  const replaced = await exists(sramPath);
  if (replaced) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(savDir, "backup");
    await ensureDir(backupDir);
    backupPath = join(backupDir, `${name}.${stamp}.srm`);
    await Deno.copyFile(sramPath, backupPath);
  }
  await Deno.writeFile(sramPath, sram);
  const back = await Deno.readFile(sramPath);
  if (back.length !== sram.length || back.some((b, i) => b !== sram[i])) {
    throw new MednafenError(`${sramPath} did not read back as written`);
  }
  return { sramPath, backupPath, replaced };
}

/** Start Mednafen on the resolved ROM, detached; resolves with the pid. */
export async function launchSfcMednafen(
  r: Pick<SfcMednafenResolution, "bin" | "rom">,
  { wait = false }: { wait?: boolean } = {},
): Promise<{ pid: number | null; code: number | null; args: string[] }> {
  if (!r.rom) throw new MednafenError("no Super Famicom Dezaemon ROM to start");
  const { pid, code, args } = await launchMednafen(
    { bin: r.bin, disc: r.rom },
    { wait },
  );
  return { pid, code, args };
}
