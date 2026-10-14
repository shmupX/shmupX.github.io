// Mednafen as the PlayStation with a memory card in slot 1.
//
// The Saturn side merges a level into one slot of Mednafen's cartridge
// (packages/shmup-harbor/lib/mednafen.ts). A Dezaemon Kids! save is simpler
// and blunter: the game writes one 15-block file that takes the WHOLE card,
// so there is no slot to merge into — the card IS the save. Installing a level
// means replacing Mednafen's slot-1 card for the Kids! disc, which is why the
// card that was there is backed up first, every time, under a timestamped
// name, and the response says where.
//
// The card's name is Mednafen's own: started with `-filesys.fname_sav %f.%x`
// (mednafenArgs, the Saturn launcher's flag, which this reuses), the PSX core
// keeps port 1's card as <disc base>.0.mcr in its save directory and port 2's
// as <disc base>.1.mcr. The disc is the Kids! image lib/dezaemon-psx.ts finds
// in dev-fixtures/ (or $DEZAEMON_PSX_DISC) — by its contents, never its name —
// and the cue beside it, or the bare track when the rip has none.
//
// The BIOS is the one thing this cannot supply. Mednafen hash-checks it and a
// Japanese SLPS disc needs scph5500.bin in <MEDNAFEN_HOME>/firmware (the US
// SCPH1001 is refused for the region). It is reported — present or not, and
// where it is looked for — rather than guessed at, so the editor can say why
// a launch will not boot before the user presses the button.
//
// LOCAL-ONLY, like everything else that writes into the user's emulator
// directory; the route gates it.

import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  binExists,
  findBin,
  launchMednafen,
  MednafenError,
  savDirFor,
} from "@shmupx/shmup-harbor/mednafen";
import { findPsxDiscs, type PsxDisc, repoRoot } from "./dezaemon-psx.ts";

export { MednafenError };

/** The raw card image Mednafen mounts: 128 KB, "MC" first. */
export const PSX_CARD_SIZE = 0x20000;
/** The BIOS a Japanese disc needs, by Mednafen's own file name. */
export const PSX_BIOS_JP = "scph5500.bin";

export interface PsxMednafenResolution {
  available: boolean;
  reason: string | null;
  bin: string;
  /** The image Mednafen is started on: the cue when the rip has one, else the track. */
  disc: string | null;
  /** The Kids! disc as lib/dezaemon-psx.ts describes it. */
  found: PsxDisc | null;
  savDir: string;
  /** The disc's base name — what the card is named after. */
  name: string;
  /** Where the slot-1 card lives, whether or not it exists yet. */
  cardPath: string | null;
  bios: { file: string; dir: string; present: boolean };
}

function home(): string {
  return (Deno.build.os === "windows"
    ? Deno.env.get("USERPROFILE")
    : Deno.env.get("HOME")) || ".";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A path's file name without its extension: the disc's save name. */
export function discBaseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() || path;
  return file.replace(/\.[^.]+$/, "");
}

/** Mednafen's firmware directory: beside its save directory, under its home. */
export function firmwareDirFor(savDir: string): string {
  return join(dirname(savDir), "firmware");
}

/** The slot-1 card's name under `-filesys.fname_sav %f.%x`: <base>.0.mcr. */
export function slotCardName(base: string, slot = 0): string {
  return `${base}.${slot}.mcr`;
}

/**
 * Where everything is, without insisting that it is: the Kids! disc, the
 * executable, the save directory, the BIOS. `available` says whether a launch
 * could start; `reason` says what is missing when it could not.
 */
export async function resolvePsxMednafen(
  { bin = null, savDir = null, root = null, extra = [] }: {
    bin?: string | null;
    savDir?: string | null;
    root?: string | null;
    extra?: string[];
  } = {},
): Promise<PsxMednafenResolution> {
  const exe = findBin(bin);
  const discs = await findPsxDiscs(root ?? await repoRoot(), { extra });
  const found = discs.find((d) => d.game === "kids") ?? null;
  const disc = found ? (found.cuePath ?? found.files[0]?.path ?? null) : null;
  let dir: string;
  try {
    dir = savDirFor(savDir, exe);
  } catch (e) {
    return {
      available: false,
      reason: (e as Error).message,
      bin: exe,
      disc,
      found,
      savDir: "",
      name: disc ? discBaseName(disc) : "",
      cardPath: null,
      bios: { file: PSX_BIOS_JP, dir: "", present: false },
    };
  }
  const name = disc ? discBaseName(disc) : "";
  const biosDir = firmwareDirFor(dir);
  const bios = {
    file: PSX_BIOS_JP,
    dir: biosDir,
    present: await exists(join(biosDir, PSX_BIOS_JP)) ||
      await exists(join(home(), ".mednafen", "firmware", PSX_BIOS_JP)),
  };
  const hasBin = await binExists(exe);
  const reason = !found
    ? "no Dezaemon Kids! disc image in dev-fixtures/ (a .cue/.bin whose " +
      "SYSTEM.CNF boots SLPS-01503; $DEZAEMON_PSX_DISC is looked at too)"
    : !hasBin
    ? `could not find "${exe}". Set MEDNAFEN_BIN to the mednafen executable (or put it on PATH).`
    : null;
  return {
    available: reason === null,
    reason,
    bin: exe,
    disc,
    found,
    savDir: dir,
    name,
    cardPath: name ? join(dir, slotCardName(name)) : null,
    bios,
  };
}

export interface PsxCardInstall {
  cardPath: string;
  backupPath: string | null;
  replaced: boolean;
}

/**
 * Install `card` as the slot-1 memory card for the disc: <savDir>/<name>.0.mcr,
 * with whatever was there copied to <savDir>/backup/<name>.0.<stamp>.mcr first.
 * The bytes are read back and compared before this reports success.
 */
export async function installPsxCard(
  card: Uint8Array,
  { savDir, name }: { savDir: string; name: string },
): Promise<PsxCardInstall> {
  if (card.length !== PSX_CARD_SIZE || card[0] !== 0x4d || card[1] !== 0x43) {
    throw new MednafenError(
      `a memory card is ${PSX_CARD_SIZE} bytes starting "MC"; got ${card.length}`,
    );
  }
  if (!name) throw new MednafenError("the card needs the disc's name");
  await ensureDir(savDir);
  const cardPath = resolve(join(savDir, slotCardName(name)));
  let backupPath: string | null = null;
  const replaced = await exists(cardPath);
  if (replaced) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(savDir, "backup");
    await ensureDir(backupDir);
    backupPath = join(backupDir, `${name}.0.${stamp}.mcr`);
    await Deno.copyFile(cardPath, backupPath);
  }
  await Deno.writeFile(cardPath, card);
  const back = await Deno.readFile(cardPath);
  if (back.length !== card.length || back.some((b, i) => b !== card[i])) {
    throw new MednafenError(`${cardPath} did not read back as written`);
  }
  return { cardPath, backupPath, replaced };
}

/** Start Mednafen on the Kids! disc, detached; resolves with the pid. */
export async function launchPsxMednafen(
  r: Pick<PsxMednafenResolution, "bin" | "disc">,
): Promise<{ pid: number | null; args: string[] }> {
  if (!r.disc) throw new MednafenError("no Dezaemon Kids! disc to start");
  const { pid, args } = await launchMednafen({ bin: r.bin, disc: r.disc }, {
    wait: false,
  });
  return { pid, args };
}
