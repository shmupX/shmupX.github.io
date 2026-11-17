// A PS2 disc a STOCK console will boot: the export laid over a FreeDVDBoot
// image.
//
// A burned disc in PlayStation 2 format never gets past an unmodified
// console's own disc check: the browser shows its red "Please insert a
// PlayStation or PlayStation 2 format disc" screen and nothing on the disc
// ever runs. That is the console, not the image — every burned PS2 disc gets
// it — so the plain `.iso` needs a modchip (or PCSX2 with fast boot).
//
// FreeDVDBoot (github.com/CTurt/FreeDVDBoot) goes in the other door. Its disc
// is a DVD Video, which the console's DVD player opens happily; a crafted IFO
// takes the player over and boots uLaunchELF, built with ps2sdk's DVD-Video
// support for cdfs, so uLaunchELF can browse and launch files on the same
// disc. Each image only works on the DVD player versions it was made for.
//
// So the FreeDVDBoot disc is that image, byte for byte, with the export's
// files appended past its end and the ISO 9660 side rebuilt to list them
// (iso9660.ts, `base`). The UDF side the DVD player reads and the raw
// sectors the exploit loads its payload from are untouched — the payload
// sits outside the ISO 9660 volume in the 2.10 image, so this can not be
// done by re-mastering the files with genisoimage.
//
// On the console: DVD player version shows on the browser's Version screen
// (Triangle, no disc in). Boot the disc, wait for uLaunchELF, open cdfs:/
// and run ATHENA.ELF.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { encodeHex } from "@std/encoding/hex";

/** FreeDVDBoot's prebuilt images, at a pinned commit and hash. */
const COMMIT = "ba7fa5bbda2ccd19c0a1c37ab99115183a2a1b27";

interface BaseImage {
  /** File in FreeDVDBoot's `PREBUILT ISOs/`. */
  file: string;
  sha256: string;
  /** Which consoles it is for, for the build log and README. */
  consoles: string;
}

const PHAT_210_212: BaseImage = {
  file: "Some 2.10 models and all 2.12.iso",
  sha256: "2e232fb2de3934b0a82ee8e437f07de2ef3710bb51a3d7da0b48a0df5caf0afe",
  consoles:
    "phat consoles with DVD player 2.10 (SCPH-30000, -30001 R, -30004 R " +
    "per FreeDVDBoot; not SCPH-39004) or 2.12",
};

const PHAT_304: BaseImage = {
  file: "3.04 only - M+maybe other regions except J - English language.iso",
  sha256: "ba097b076018ac8adfd8c0f1ad80b3bb40472068032e6e2017428d4b1ddc2eb1",
  consoles:
    "phat consoles with DVD player 3.04 (not region J), console language English",
};

const SLIM: BaseImage = {
  file: "All PS2 Slims - English language.iso",
  sha256: "4b3fb26a746abd4544ca254240f4896e84745e83793bd9f8fb5dce055a63b7a0",
  consoles:
    "every slim console (DVD player 3.10 or 3.11), console language English",
};

/** The `--freedvdboot` values, by the DVD player version the browser shows. */
export const FREEDVDBOOT_TARGETS: Record<string, BaseImage> = {
  "2.10": PHAT_210_212,
  "2.12": PHAT_210_212,
  "3.04": PHAT_304,
  "3.10": SLIM,
  "3.11": SLIM,
  "slim": SLIM,
};

export interface FreeDvdBootBase {
  bytes: Uint8Array;
  source: string;
  consoles: string;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

async function readIfPresent(
  path: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

/**
 * The FreeDVDBoot image for `target` — a DVD player version from
 * FREEDVDBOOT_TARGETS, or a path to an image of your own (one of the
 * prebuilt ISOs already on disk, or one you built with FreeDVDBoot's own
 * makefiles). Downloaded ones are checked against the pinned hash and kept
 * in `cacheDir`.
 */
export async function resolveFreeDvdBootBase(
  target: string,
  cacheDir: string,
  log: (line: string) => void = console.log,
): Promise<FreeDvdBootBase> {
  const known = FREEDVDBOOT_TARGETS[target.toLowerCase()];
  if (!known) {
    const own = await readIfPresent(target);
    if (own) {
      return {
        bytes: own,
        source: target,
        consoles: "the consoles that image was made for",
      };
    }
    throw new Error(
      `--freedvdboot wants your console's DVD player version (` +
        `${Object.keys(FREEDVDBOOT_TARGETS).join(", ")}) or the path to a ` +
        `FreeDVDBoot image; "${target}" is neither`,
    );
  }

  const cached = join(cacheDir, "freedvdboot", known.file);
  let bytes = await readIfPresent(cached);
  let source = cached;
  if (!bytes || (await sha256(bytes)) !== known.sha256) {
    const url =
      `https://raw.githubusercontent.com/CTurt/FreeDVDBoot/${COMMIT}/` +
      `PREBUILT%20ISOs/${encodeURIComponent(known.file)}`;
    log(`  downloading FreeDVDBoot's "${known.file}"`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `could not download FreeDVDBoot's image (HTTP ${response.status}). ` +
          `Download "PREBUILT ISOs/${known.file}" from ` +
          `github.com/CTurt/FreeDVDBoot yourself and pass its path to ` +
          `--freedvdboot instead.`,
      );
    }
    bytes = new Uint8Array(await response.arrayBuffer());
    const got = await sha256(bytes);
    if (got !== known.sha256) {
      throw new Error(
        `FreeDVDBoot's "${known.file}" is not the image this build was ` +
          `made for (sha256 ${got})`,
      );
    }
    await ensureDir(join(cacheDir, "freedvdboot"));
    await Deno.writeFile(cached, bytes);
    source = url;
  }
  return { bytes, source, consoles: known.consoles };
}

/**
 * main.js on a FreeDVDBoot disc loads the sound module itself.
 *
 * AthenaEnv reads its settings, the audsrv switch among them, from
 * `cdrom0:ATHENA.INI;1` when it starts from a disc — through the boot ROM's
 * own cdrom0: device, which reads PS2-format discs only. On a DVD Video disc
 * that read fails quietly, audsrv is never started, and the runtime's first
 * call into `Sound` waits forever on an IOP module that is not there (the
 * same hang build.ts's `__PS2_AUDSRV__` comment describes). Loading the
 * module from the script does not depend on the ini at all, and costs
 * nothing when the ini did load it: AthenaEnv's loadModule returns at once
 * for a module that is already running.
 */
export const FREEDVDBOOT_AUDSRV_PREAMBLE =
  'if (typeof IOP !== "undefined") { try { IOP.loadModule("audsrv"); } catch (_) {} }';
