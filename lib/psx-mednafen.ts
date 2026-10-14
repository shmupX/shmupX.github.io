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
// Japanese SLPS disc needs scph5500.bin (the US SCPH1001 is refused for the
// region). It is looked for in Mednafen's own firmware folder and then in the
// gitignored dev-fixtures/ (bios/, or the top), and a copy found there is
// handed to the launch as `-psx.bios_jp <path>` so nothing has to be copied
// into the emulator's directory. It is reported — present or not, and where
// it was looked for — rather than guessed at, so the editor can say why a
// launch will not boot before the user presses the button.
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
  /**
   * `dir` is Mednafen's firmware folder; `path` is the copy that will be
   * used — there, or in dev-fixtures/ — and null when there is none.
   */
  bios: { file: string; dir: string; present: boolean; path: string | null };
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

/** The places a Japanese BIOS is looked for, in order. */
export function biosCandidates(firmwareDir: string, root: string): string[] {
  return [
    join(firmwareDir, PSX_BIOS_JP),
    join(home(), ".mednafen", "firmware", PSX_BIOS_JP),
    join(root, "dev-fixtures", "bios", PSX_BIOS_JP),
    join(root, "dev-fixtures", PSX_BIOS_JP),
  ];
}

async function findBios(
  firmwareDir: string,
  root: string,
): Promise<string | null> {
  for (const c of biosCandidates(firmwareDir, root)) {
    if (await exists(c)) return resolve(c);
  }
  return null;
}

/**
 * Where everything is, without insisting that it is: the Kids! disc, the
 * executable, the save directory, the BIOS. `available` says whether a launch
 * could start; `reason` says what is missing when it could not.
 */
export type PsxWriterGame = "kids" | "plus";

export async function resolvePsxMednafen(
  { bin = null, savDir = null, root = null, extra = [], game = "kids" }: {
    bin?: string | null;
    savDir?: string | null;
    root?: string | null;
    extra?: string[];
    /** Which Dezaemon's disc to start: Kids! (SLPS-01503) or Dezaemon+ (SLPS-00335 / Select 100). */
    game?: PsxWriterGame;
  } = {},
): Promise<PsxMednafenResolution> {
  const exe = findBin(bin);
  const at = root ?? await repoRoot();
  const discs = await findPsxDiscs(at, { extra });
  const found = discs.find((d) => d.game === game) ?? null;
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
      bios: { file: PSX_BIOS_JP, dir: "", present: false, path: null },
    };
  }
  const name = disc ? discBaseName(disc) : "";
  const biosDir = firmwareDirFor(dir);
  const biosPath = await findBios(biosDir, at);
  const bios = {
    file: PSX_BIOS_JP,
    dir: biosDir,
    present: biosPath !== null,
    path: biosPath,
  };
  const hasBin = await binExists(exe);
  const reason = !found
    ? (game === "plus"
      ? "no Dezaemon+ disc image in dev-fixtures/ (a .cue/.bin whose " +
        "SYSTEM.CNF boots SLPS-00335 or SLPS-01504; $DEZAEMON_PSX_DISC is looked at too)"
      : "no Dezaemon Kids! disc image in dev-fixtures/ (a .cue/.bin whose " +
        "SYSTEM.CNF boots SLPS-01503; $DEZAEMON_PSX_DISC is looked at too)")
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

/**
 * The extra arguments a launch carries: the BIOS by path when the copy found
 * is not in Mednafen's own firmware folder (an absolute `psx.bios_jp` is
 * taken as given; a bare name is looked up in that folder).
 */
export function psxLaunchArgs(
  bios: Pick<PsxMednafenResolution["bios"], "dir" | "path" | "file">,
): string[] {
  if (!bios.path) return [];
  if (resolve(bios.path) === resolve(join(bios.dir, bios.file))) return [];
  return ["-psx.bios_jp", bios.path];
}

/** Start Mednafen on the resolved disc, detached; resolves with the pid. */
export async function launchPsxMednafen(
  r: Pick<PsxMednafenResolution, "bin" | "disc" | "bios">,
  { wait = false }: { wait?: boolean } = {},
): Promise<{ pid: number | null; code: number | null; args: string[] }> {
  if (!r.disc) throw new MednafenError("no PlayStation Dezaemon disc to start");
  const { pid, code, args } = await launchMednafen(
    { bin: r.bin, disc: r.disc },
    { wait, passThrough: psxLaunchArgs(r.bios) },
  );
  return { pid, code, args };
}
