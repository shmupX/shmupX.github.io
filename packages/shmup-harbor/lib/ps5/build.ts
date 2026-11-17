// deno task build:ps5:iso — package one level for a PlayStation 5.
//
// A PS5 has no PlayStation 2 hardware and will not boot a burned PS2 disc, so
// there is no way to hand it the PS2 build as it stands. What it does run is
// a PS4 "PS2 Classic": a PS4 package that wraps a PS2 disc image in Sony's own
// PS2 emulator. On a jailbroken PS5 (one running etaHEN or another homebrew
// enabler that installs fake PKGs) such a package installs and runs like any
// other game. So this build is the AthenaEnv disc from lib/ps2/build.ts, made
// ready for a PS2 Classics packager:
//
//   - the same tree, re-mastered with a boot executable and SYSTEM.CNF whose
//     serial belongs to this level alone, because the packager turns the
//     serial into the PS4 title and content IDs, and two packages with the
//     same IDs replace each other on the console;
//   - the PS4 artwork the packager asks for — icon0.png (512x512) and
//     pic0.png / pic1.png (1920x1080) — cut from the level's own title screen;
//   - fpkg.txt with the title, serial and suggested content ID to type in.
//
// Making the .pkg itself needs Sony's PS2 emulator files and PS4 packaging
// tools, which cannot ship here, so that last step is a PC tool's (the
// README says which). The PS2 build is reused untouched: this calls buildPs2
// for the folder, then reads that folder back, so whatever the PS2 export puts
// on its disc ends up on this one too.

import { basename, join, relative, resolve } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { buildPs2, type BuildPs2Options } from "../ps2/build.ts";
import { buildIso, type IsoFile } from "../ps2/iso9660.ts";
import { decodePng, encodePng, newRaster, type Raster } from "../ps2/png.ts";
import { blit, cut, fitInto } from "../ps2/raster.ts";

/** Same fixed stamp as the PS2 export, so a rebuild is byte-identical. */
const BUILD_DATE = new Date("2000-03-04T00:00:00Z");

/** The four letters every shmupX disc serial starts with (the PS2 build's). */
const SERIAL_PREFIX = "SHMP";

/** The PS2 build's own serial, which every level shares; never reused here. */
const PS2_SERIAL_NUMBER = 1;

export type BuildPs5Options = Omit<BuildPs2Options, "iso" | "zip">;

export interface BuildPs5Result {
  /** The level's name as the build folder spells it. */
  name: string;
  /** build/ps5/<name>/ — everything below sits in it. */
  dir: string;
  isoPath: string;
  /** "SHMP_123.45", the boot executable's name on the disc. */
  bootName: string;
  /** "SHMP12345", the same serial as packagers and the PS4 write it. */
  serial: string;
  /** A content ID for the package, if the packager asks for one. */
  contentId: string;
  artwork: string[];
  notes: string[];
}

/**
 * A serial for this level: SHMP plus five digits from a hash of its name, so
 * the same level always gets the same one and different levels (almost
 * always) different ones. 00001 is left to the PS2 build, which uses it for
 * every level.
 */
export function levelSerialNumber(name: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const number = hash % 100000;
  return number === PS2_SERIAL_NUMBER || number === 0 ? 2 : number;
}

/** "SHMP_123.45": the ????_???.?? shape the PS2 BIOS insists on. */
export function bootName(serialNumber: number): string {
  const digits = String(serialNumber).padStart(5, "0");
  return `${SERIAL_PREFIX}_${digits.slice(0, 3)}.${digits.slice(3)}`;
}

/** "SHMP12345": the serial as PS2 Classics packagers and the PS4 write it. */
export function serialId(serialNumber: number): string {
  return `${SERIAL_PREFIX}${String(serialNumber).padStart(5, "0")}`;
}

/**
 * A PS4 content ID for the package: UP9000 (the publisher prefix PS2 Classics
 * carry), a CUSA title ID sharing the serial's digits, and the serial padded
 * to the 16-character label.
 */
export function contentId(serialNumber: number): string {
  const digits = String(serialNumber).padStart(5, "0");
  return `UP9000-CUSA${digits}_00-${serialId(serialNumber)}0000001`;
}

/** What the PS2 boot ROM reads off the disc to find the executable. */
export function systemCnf(boot: string): string {
  return [`BOOT2 = cdrom0:\\${boot};1`, "VER = 1.00", "VMODE = NTSC", ""]
    .join("\r\n");
}

/**
 * The folder build's files as the disc carries them. Same renames as the PS2
 * disc (lib/ps2/build.ts): AthenaEnv asks for `cdrom0:ATHENA.INI;1` in upper
 * case, and the ELF takes the serial-shaped name SYSTEM.CNF boots — this
 * level's serial rather than the shared one.
 */
export function discFiles(files: IsoFile[], boot: string): IsoFile[] {
  const encoder = new TextEncoder();
  const out: IsoFile[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower === "system.cnf") continue;
    if (lower === "athena.ini") out.push({ ...file, path: "ATHENA.INI" });
    else if (lower === "athena.elf") out.push({ ...file, path: boot });
    else out.push(file);
  }
  if (!out.some((file) => file.path === boot)) {
    throw new Error("the PS2 build has no athena.elf to boot");
  }
  return [
    { path: "SYSTEM.CNF", data: encoder.encode(systemCnf(boot)) },
    ...out,
  ];
}

async function readTree(dir: string): Promise<IsoFile[]> {
  const files: IsoFile[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    files.push({
      path: relative(dir, entry.path).replaceAll("\\", "/"),
      data: await Deno.readFile(entry.path),
    });
  }
  // walk's order follows the filesystem; sort so the disc does not.
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

interface TitleArt {
  backdrop: Raster | null;
  logo: Raster | null;
}

/** The title backdrop and logo, cut back out of the PS2 build's UI atlas. */
async function titleArt(appDir: string): Promise<TitleArt> {
  try {
    const sheet = await decodePng(
      await Deno.readFile(join(appDir, "assets", "game_ui.png")),
    );
    const atlas = JSON.parse(
      await Deno.readTextFile(join(appDir, "assets", "game_ui.json")),
    ) as {
      frames: Record<
        string,
        { frame: { x: number; y: number; w: number; h: number } }
      >;
    };
    const frame = (key: string) => {
      const entry = atlas.frames[key];
      return entry ? cut(sheet, entry.frame) : null;
    };
    return { backdrop: frame("title_bg"), logo: frame("logo.gif") };
  } catch {
    return { backdrop: null, logo: null };
  }
}

/** A raster filled with one opaque colour. */
function solid(width: number, height: number, rgb: number): Raster {
  const out = newRaster(width, height);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = (rgb >> 16) & 255;
    out.data[i + 1] = (rgb >> 8) & 255;
    out.data[i + 2] = rgb & 255;
    out.data[i + 3] = 255;
  }
  return out;
}

/** The largest whole-number scale of `src` that fits the box (at least 1). */
function integerFit(src: Raster, boxW: number, boxH: number): Raster {
  const scale = Math.max(
    1,
    Math.floor(Math.min(boxW / src.width, boxH / src.height)),
  );
  return fitInto(src, src.width * scale, src.height * scale);
}

/**
 * PS4 artwork from the title screen. Pixel art, so every scale is a whole
 * number and nearest-neighbour; the backdrop is portrait (the game is), so it
 * sits centred on black with the logo over its top, as the title screen
 * shows it.
 */
export function composeArt(
  art: TitleArt,
  width: number,
  height: number,
): Raster {
  const canvas = solid(width, height, 0x000000);
  if (art.backdrop) {
    const backdrop = integerFit(art.backdrop, width, height);
    blit(
      canvas,
      backdrop,
      Math.floor((width - backdrop.width) / 2),
      Math.floor((height - backdrop.height) / 2),
    );
  }
  if (art.logo) {
    const logo = integerFit(art.logo, width * 0.9, height * 0.4);
    blit(
      canvas,
      logo,
      Math.floor((width - logo.width) / 2),
      Math.floor(height * 0.12),
    );
  }
  return canvas;
}

export async function buildPs5(
  options: BuildPs5Options,
): Promise<BuildPs5Result> {
  const log = options.log ?? ((message: string) => console.log(message));
  const root = resolve(options.root);
  const outRoot = options.outDir
    ? resolve(options.outDir)
    : join(root, "build", "ps5");

  // The PS2 folder build, written where this build's files go; the folder is
  // read back and removed below, as a PS5 has no use for it.
  const ps2 = await buildPs2({
    ...options,
    outDir: outRoot,
    // Kept beside the PS2 build's cache: same runtime, AthenaEnv and levels.
    cacheDir: options.cacheDir ?? join(root, "build", "ps2", ".cache"),
    iso: false,
    zip: false,
    log,
  });
  if (!ps2.appDir) throw new Error("the PS2 build wrote no folder");
  const appDir = ps2.appDir;
  const app = basename(appDir);
  const dir = ps2.dir;

  const number = levelSerialNumber(ps2.name);
  const boot = bootName(number);
  const serial = serialId(number);
  const content = contentId(number);
  log(`  serial: ${serial} (boots ${boot})`);

  log("  writing the PS5 disc image…");
  const iso = buildIso({
    volumeId: app,
    files: discFiles(await readTree(appDir), boot),
    date: BUILD_DATE,
  });
  const isoPath = join(dir, `${app}.iso`);
  try {
    await Deno.writeFile(isoPath, iso);
  } catch (error) {
    if (!/os error 32|being used by another process/.test(String(error))) {
      throw error;
    }
    throw new Error(
      `${isoPath} is open in another program — a packager or emulator, most ` +
        `likely. Close it and build again.`,
    );
  }
  log(`  iso: ${(iso.length / 1048576).toFixed(1)}MB`);

  const notes = [...ps2.notes];
  const art = await titleArt(appDir);
  if (!art.backdrop) {
    notes.push("no title backdrop in the build — the artwork is plain black");
    log("  artwork: no title backdrop found, so plain black");
  }
  const artDir = join(dir, "fpkg");
  await ensureDir(artDir);
  const artwork: string[] = [];
  for (
    const [file, width, height] of [
      ["icon0.png", 512, 512],
      ["pic0.png", 1920, 1080],
      ["pic1.png", 1920, 1080],
    ] as const
  ) {
    const path = join(artDir, file);
    await Deno.writeFile(path, await encodePng(composeArt(art, width, height)));
    artwork.push(path);
  }
  log("  artwork: icon0.png 512x512, pic0.png and pic1.png 1920x1080");

  await Deno.writeTextFile(
    join(artDir, "fpkg.txt"),
    [
      `Title      : ${ps2.name}`,
      `Serial     : ${serial}`,
      `Content ID : ${content}`,
      `Disc image : ../${app}.iso`,
      `Icon       : icon0.png (512x512)`,
      `Background : pic0.png, pic1.png (1920x1080)`,
      "",
    ].join("\n"),
  );

  // The PS2 folder (and its README) has served its purpose.
  await Deno.remove(appDir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "README.txt"),
    readme(ps2.name, app, serial, content, options),
  );

  return {
    name: ps2.name,
    dir,
    isoPath,
    bootName: boot,
    serial,
    contentId: content,
    artwork,
    notes,
  };
}

function readme(
  name: string,
  app: string,
  serial: string,
  content: string,
  options: BuildPs5Options,
): string {
  const rebuild = [
    "deno task build:ps5:iso",
    options.savFile && !options.levelName
      ? ""
      : JSON.stringify(options.levelName ?? name),
    options.savFile ? `--sav ${JSON.stringify(options.savFile)}` : "",
    options.stage ? `--stage ${options.stage}` : "",
    options.savSlot ? `--slot ${options.savSlot}` : "",
  ].filter(Boolean).join(" ");
  return [
    `${name} — PlayStation 5 build (as a PS2 Classic)`,
    "",
    "A PS5 runs this the way it runs any PS2 Classic: as a PS4 package that",
    "wraps the disc image below in Sony's PS2 emulator. That package is not",
    "signed by Sony, so the console has to be jailbroken with a homebrew",
    "enabler that installs fake PKGs (etaHEN, for example). A stock PS5",
    "cannot run it, and a burned disc does nothing in a PS5's drive.",
    "",
    `${app}.iso`,
    "    The PS2 build's AthenaEnv disc, with a serial of its own",
    `    (${serial}) so its package does not replace another level's.`,
    "    It still boots in PCSX2 like the PS2 disc does.",
    "",
    "fpkg/",
    "    icon0.png (512x512) and pic0.png / pic1.png (1920x1080) for the",
    "    package, cut from the level's title screen, and fpkg.txt with the",
    "    title, serial and content ID to give the packager.",
    "",
    "To install it on a PS5:",
    "  1. On a Windows PC, open a PS2 Classics FPKG maker (PS2-FPKG and",
    "     similar tools; they bring the PS2 emulator and PS4 packaging",
    "     tools this build cannot ship).",
    `  2. Give it ${app}.iso, the title and serial from fpkg/fpkg.txt,`,
    "     icon0.png and pic0.png. If it asks for a content ID, use",
    `     ${content}.`,
    "  3. Build the .pkg and install it on the PS5 with the enabler's",
    "     package installer (etaHEN's, over the network or from USB).",
    "",
    "The game runs inside the PS4's PS2 emulator, not on PS2 hardware, so",
    "how well AthenaEnv and its audio run there is down to that emulator.",
    "",
    "Controls: D-pad or left stick to move, Cross to fire, Start to pause.",
    "",
    "Rebuild with:  " + rebuild,
    "",
  ].join("\n");
}
