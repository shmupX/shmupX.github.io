// The Super Famicom Dezaemon ROM in dev-fixtures/, as the browser's SNES player
// wants it.
//
// This is the SNES half of lib/dezaemon-disc.ts, and it exists for the same
// reason: a shelf record is a SAVE, and a save is not a game you can boot. The
// Saturn shelf needs Dezaemon 2's disc under the cart; the SNES shelf needs
// Athena's 1994 cart (SHVC-66) under the SRAM. Neither is ours to ship — both
// are gitignored — so both are found on the operator's own disk and handed to
// the player from there.
//
// A ROM is recognised by its CONTENTS, never its filename. The library is full
// of English patches, headered copier dumps and hand-renamed files, so the test
// is the one the parser already applies (src/sfc/rom.js): the internal header
// at 0x7FC0 names DEZAEMON and declares 128 KB of SRAM. copierHeaderSize()
// absorbs the 512-byte copier header some dumps carry, so a .smc off a Super
// Wild Card passes the same test a clean .sfc does.
//
// WHERE IT LOOKS
// dev-fixtures/ and one level below it, because the collection keeps a console
// per folder ("SNES Dezaemon - Kaite Tsukutte Asoberu/"), plus $DEZAEMON_SFC_ROM
// for a ROM kept anywhere else. Candidates are filtered by extension and size
// before anything is opened, and then read WHOLE rather than probed for their
// header: copierHeaderSize() decides whether a dump carries a 512-byte copier
// header from the length of the file (`length % 0x8000 === 512`), so a partial
// read makes it answer for the slice instead of the ROM and every address in
// the header lands 512 bytes out. The lookup is memoised against the directory
// listing, so this happens once per change rather than once per request.

import { basename, dirname, fromFileUrl, join } from "@std/path";
import {
  isDezaemonRom,
  readRomHeader,
} from "../packages/shmup-engine/src/sfc/rom.js";

/** What the launcher calls it, and the name the ROM reaches the player under. */
export const DEZAEMON_SFC_TITLE = "Dezaemon (Super Famicom)";
export const DEZAEMON_SFC_ROM_NAME = "Dezaemon.sfc";

const ROM_EXTENSIONS = [".sfc", ".smc", ".fig", ".swc"];
/** A Dezaemon ROM is 512 KB; anything far off that is not worth opening. */
const MIN_ROM_BYTES = 0x40000;
const MAX_ROM_BYTES = 0x800000;

export interface DezaemonSfcRom {
  /** Absolute path on this machine. */
  path: string;
  /** Its own base name, for the log line and the launcher's subtitle. */
  name: string;
  size: number;
  mtime: number;
  /** What the internal header says, so the launcher can show it. */
  header: {
    title: string;
    copierHeader: number;
    romSizeBytes: number;
    sramSizeBytes: number;
    valid: boolean;
  };
}

/**
 * The checkout this module runs in, found by walking up for dev-fixtures/ —
 * the module sits in lib/ in a source checkout and in _fresh/server/assets/
 * once Vite has bundled the server. Same walk as lib/dezaemon-disc.ts.
 */
export async function repoRoot(): Promise<string> {
  let dir: string;
  try {
    dir = dirname(fromFileUrl(import.meta.url));
  } catch {
    return Deno.cwd();
  }
  for (let i = 0; i < 6; i++) {
    try {
      if ((await Deno.stat(join(dir, "dev-fixtures"))).isDirectory) return dir;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return Deno.cwd();
}

function looksLikeRomName(name: string): boolean {
  // "._Dezaemon.sfc" is macOS's AppleDouble fork on an exFAT volume — 4 KB of
  // extended attributes wearing the same extension as the thing it describes.
  if (name.startsWith("._")) return false;
  const lower = name.toLowerCase();
  return ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Every path worth opening: dev-fixtures/ and one level below it, in name order. */
export async function romCandidates(
  root: string,
  { extra = [] as string[] } = {},
): Promise<{ path: string; size: number; mtime: number }[]> {
  const out: { path: string; size: number; mtime: number }[] = [];
  const seen = new Set<string>();
  const add = async (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      const info = await Deno.stat(path);
      if (!info.isFile) return;
      if (info.size < MIN_ROM_BYTES || info.size > MAX_ROM_BYTES) return;
      out.push({ path, size: info.size, mtime: info.mtime?.getTime() ?? 0 });
    } catch { /* gone between listing and stat */ }
  };
  // An explicit path is taken as given — no extension test, because somebody
  // who names a file in an environment variable means that file.
  for (const path of extra) {
    if (!path) continue;
    seen.add(path);
    try {
      const info = await Deno.stat(path);
      if (info.isFile) {
        out.push({ path, size: info.size, mtime: info.mtime?.getTime() ?? 0 });
      }
    } catch { /* named but not there */ }
  }

  const fixtures = join(root, "dev-fixtures");
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(fixtures)];
  } catch {
    return out;
  }
  const dirs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory) {
      if (!entry.name.startsWith(".")) dirs.push(join(fixtures, entry.name));
    } else if (entry.isFile && looksLikeRomName(entry.name)) {
      await add(join(fixtures, entry.name));
    }
  }
  for (const dir of dirs) {
    let sub: Deno.DirEntry[];
    try {
      sub = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const entry of sub.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile && looksLikeRomName(entry.name)) {
        await add(join(dir, entry.name));
      }
    }
  }
  return out;
}

/** A candidate's bytes, or null when it vanished or cannot be read. */
async function readCandidate(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

// Memoised against the candidate listing (paths, sizes, mtimes), the same
// bargain lib/dezaemon-disc.ts strikes: a launcher polling the route costs a
// stat pass rather than a read of every ROM in the tree.
let cached: { key: string; rom: DezaemonSfcRom | null } | null = null;

function candidatesKey(
  files: { path: string; size: number; mtime: number }[],
): string {
  return files.map((f) => `${f.path}:${f.size}:${f.mtime}`).join("|");
}

/**
 * The Dezaemon ROM on this machine, or null. First match in candidate order,
 * which puts $DEZAEMON_SFC_ROM ahead of anything discovered.
 */
export async function findDezaemonSfcRom(
  root: string,
  { extra = [] as string[] } = {},
): Promise<DezaemonSfcRom | null> {
  const files = await romCandidates(root, { extra });
  const key = candidatesKey(files);
  if (cached && cached.key === key) return cached.rom;
  let found: DezaemonSfcRom | null = null;
  for (const file of files) {
    const bytes = await readCandidate(file.path);
    if (!bytes || !isDezaemonRom(bytes)) continue;
    const h = readRomHeader(bytes);
    found = {
      path: file.path,
      name: basename(file.path),
      size: file.size,
      mtime: file.mtime,
      header: {
        title: h.title,
        copierHeader: h.copierHeader,
        romSizeBytes: h.romSizeBytes,
        sramSizeBytes: h.sramSizeBytes,
        valid: h.valid,
      },
    };
    break;
  }
  cached = { key, rom: found };
  return found;
}

/**
 * The ROM's bytes, with any copier header removed.
 *
 * EmulatorJS hands the core whatever file it is given, and a 512-byte copier
 * header shifts every address in it — the core either refuses the ROM or runs
 * it 512 bytes out of phase. The header is detected by the same rule that
 * recognised the ROM (src/sfc/rom.js copierHeaderSize), so what leaves here is
 * always the bare image whatever the dump carried.
 */
export async function readDezaemonSfcRom(
  rom: DezaemonSfcRom,
): Promise<Uint8Array> {
  const bytes = await Deno.readFile(rom.path);
  return rom.header.copierHeader
    ? bytes.subarray(rom.header.copierHeader)
    : bytes;
}

/** Drop the memo — for tests, which build and rebuild fixture trees. */
export function forgetDezaemonSfcRom(): void {
  cached = null;
}
