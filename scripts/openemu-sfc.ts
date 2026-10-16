#!/usr/bin/env -S deno run -A
/**
 * `deno task sfc:openemu` — a level as the Dezaemon cart's battery save in
 * OpenEmu, and the cart booted on it.
 *
 *   deno task sfc:openemu rando                   # build the cloud level, install, launch
 *   deno task sfc:openemu --srm build/sfc/foo.srm # an .srm that already exists
 *   deno task sfc:openemu rando --no-launch       # install only
 *   deno task sfc:openemu rando --keep-state      # leave the auto save state alone
 *   deno task sfc:openemu rando --dry-run         # say what would happen, write nothing
 *
 * The macOS leg of `deno task sfc:verify`'s "does it play" question, answered
 * by playing: the same image the writer makes goes where OpenEmu's SNES9x core
 * reads a cart's battery from, and OpenEmu opens the ROM. Three things make
 * this more than a copy (lib/sfc-openemu.ts has the whole story):
 *
 *   - OpenEmu rewrites the slot when a game closes, so it is quit first and
 *     the file written only once it has gone;
 *   - a resumed save state carries its own cart RAM and never reads the slot,
 *     so the ROM's Auto Save State is retired — bundle to backup/, library
 *     row deleted — and the launch is a cold boot;
 *   - the slot that was there is backed up, and the new one read back.
 *
 * Exit 0 when the save is in and (unless --no-launch) the game is open,
 * 2 when something is missing: no OpenEmu library ROM, a bad image.
 */

import { basename, resolve } from "@std/path";
import { buildSfc } from "../packages/shmup-harbor/scripts/build-sfc.ts";
import {
  verifySfcChecksums,
} from "../packages/shmup-engine/src/sfc/checksum.js";
import { isSfcSav } from "../packages/shmup-engine/src/sfc/sram.js";
import {
  autoStateLocation,
  batterySlot,
  findOpenEmuRom,
  installOpenEmuSram,
  launchOpenEmu,
  OpenEmuError,
  openEmuPaths,
  openEmuRunning,
  openEmuSupportDir,
  quitOpenEmu,
  retireAutoSaveState,
  statesFolder,
} from "../lib/sfc-openemu.ts";

const USAGE = `usage: deno task sfc:openemu [level] [options]

  level            a cloud level name or a level .json, as build:sfc takes it
                   (nothing: the bundled base game)
  --srm FILE       install this .srm instead of building one
  --name NAME      the game's name on the cart (build:sfc --name)
  --support DIR    OpenEmu's Application Support folder ($OPENEMU_SUPPORT,
                   else ~/Library/Application Support/OpenEmu)
  --no-launch      install, do not open the game
  --keep-state     do not retire the ROM's Auto Save State (the game will
                   resume it and never read the new save)
  --no-quit        refuse instead of quitting a running OpenEmu
  --dry-run        report everything, write nothing`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

interface Options {
  level: string | null;
  srm: string | null;
  name: string | null;
  support: string | null;
  launch: boolean;
  keepState: boolean;
  quit: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    level: null,
    srm: null,
    name: null,
    support: null,
    launch: true,
    keepState: false,
    quit: true,
    dryRun: false,
  };
  const args = argv.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    } else if (arg === "--srm") o.srm = value();
    else if (arg === "--name") o.name = value();
    else if (arg === "--support") o.support = value();
    else if (arg === "--no-launch") o.launch = false;
    else if (arg === "--keep-state") o.keepState = true;
    else if (arg === "--no-quit") o.quit = false;
    else if (arg === "--dry-run") o.dryRun = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}\n\n${USAGE}`);
    else if (o.level) fail(`unexpected argument ${arg}`);
    else o.level = arg;
  }
  return o;
}

export interface OpenEmuBootstrap {
  srmPath: string;
  rom: string;
  slot: string;
  backup: string | null;
  stateMovedTo: string | null;
  stateRowsDeleted: number | null;
  launched: boolean;
  dryRun: boolean;
}

/** The whole task, exported so a test can drive it against a fixture folder. */
export async function bootstrapOpenEmu(
  o: Options,
  log: (line: string) => void = () => {},
): Promise<OpenEmuBootstrap> {
  // 1. the image
  let srmPath: string;
  if (o.srm) {
    srmPath = resolve(o.srm);
  } else {
    const built = await buildSfc({ level: o.level, name: o.name, log });
    srmPath = built.outPath;
    log(`built ${built.fileName} (${built.bytes} bytes)`);
  }
  let sram: Uint8Array;
  try {
    sram = await Deno.readFile(srmPath);
  } catch (e) {
    throw new OpenEmuError(`cannot read ${srmPath}: ${(e as Error).message}`);
  }
  if (!isSfcSav(sram) || sram.length !== 0x20000) {
    throw new OpenEmuError(
      `${
        basename(srmPath)
      } is not a 128 KB Dezaemon SRAM image (size ${sram.length}, magic ${
        isSfcSav(sram) ? "ok" : "missing"
      })`,
    );
  }
  const v = verifySfcChecksums(sram);
  if (!v.ok) {
    throw new OpenEmuError(
      `${basename(srmPath)}: ${
        v.words.filter((w: { ok: boolean }) => !w.ok).length
      } of 17 checksum words do not verify; the ROM would format the cart`,
    );
  }

  // 2. OpenEmu's side
  const paths = openEmuPaths(openEmuSupportDir(o.support));
  const rom = await findOpenEmuRom(paths.romsDir);
  if (!rom) {
    throw new OpenEmuError(
      `no Dezaemon cart in OpenEmu's SNES library (${paths.romsDir}): import the .sfc into OpenEmu first`,
    );
  }
  const slot = batterySlot(paths.batteryDir, rom);
  log(`save : ${srmPath}`);
  log(`rom  : ${rom.path}`);
  log(`slot : ${slot}`);
  log(
    `state: ${
      statesFolder(paths.statesDir, rom)
    }/Auto Save State.oesavestate (row ${autoStateLocation(rom)})`,
  );

  const result: OpenEmuBootstrap = {
    srmPath,
    rom: rom.path,
    slot,
    backup: null,
    stateMovedTo: null,
    stateRowsDeleted: null,
    launched: false,
    dryRun: o.dryRun,
  };
  if (o.dryRun) {
    log("--dry-run: nothing written");
    return result;
  }

  // 3. nobody writing the slot but us
  if (await openEmuRunning()) {
    if (!o.quit) {
      throw new OpenEmuError(
        "OpenEmu is running and would rewrite the slot on quit; close it, or drop --no-quit",
      );
    }
    log("quitting OpenEmu…");
    await quitOpenEmu();
  }

  // 4. the state that would outrank the battery
  if (!o.keepState) {
    const r = await retireAutoSaveState({
      statesDir: paths.statesDir,
      batteryDir: paths.batteryDir,
      database: paths.database,
      rom,
    });
    result.stateMovedTo = r.movedTo;
    result.stateRowsDeleted = r.rowsDeleted;
    if (r.movedTo) log(`auto save state -> ${r.movedTo}`);
    else log("no auto save state on disk");
    if (r.rowsDeleted !== null) {
      log(`library rows removed: ${r.rowsDeleted}`);
    } else if (r.databaseNote) log(`note: ${r.databaseNote}`);
  }

  // 5. the slot
  const inst = await installOpenEmuSram(sram, {
    batteryDir: paths.batteryDir,
    rom,
  });
  result.backup = inst.backupPath;
  log(
    inst.replaced
      ? `installed; the previous slot is ${inst.backupPath}`
      : "installed into an empty slot",
  );

  // 6. the game
  if (o.launch) {
    await launchOpenEmu(rom);
    result.launched = true;
    log(`opened ${rom.name} in OpenEmu`);
  }
  return result;
}

if (import.meta.main) {
  const o = parseArgs(Deno.args);
  try {
    const r = await bootstrapOpenEmu(o, (m) => console.log(m));
    if (!r.dryRun) {
      console.log(
        r.launched
          ? "OK: the save is in OpenEmu's slot and the cart is booting on it — Start for GAME PLAY, Start again for GAME START"
          : "OK: the save is in OpenEmu's slot; open the cart in OpenEmu to play it",
      );
    }
  } catch (e) {
    if (e instanceof OpenEmuError) fail(e.message);
    throw e;
  }
}
