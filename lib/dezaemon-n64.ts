// The Dezaemon 3D cartridge and the 64DD IPL in dev-fixtures/, as the browser's
// Nintendo 64DD player wants them — and the English translation laid over the
// cartridge on the way out.
//
// This is the Nintendo 64 half of lib/dezaemon-sfc.ts, and it exists for the
// same reason. A disk the editor builds (packages/shmup-engine/src/n64/) is a
// data disk, and a data disk is not a game you can boot: Dezaemon 3D's code
// lives on the cartridge (Athena, 1998, NUS-NDZJ) and the 64DD needs its own
// IPL ROM to spin a disk at all. Neither is ours to ship — both are gitignored
// — so both are found on the operator's own disk and handed to the player
// from there.
//
// THE TRANSLATION. Zoinkity and whowasphone404's 2024 English patch
// (static/n64dd/dezaemon-3d-usa-2024.09.12.xdelta, an xdelta3 delta against
// the Japanese ROM in native byte order) is applied in memory by
// readDezaemonN64Rom(): the Japanese dump goes in, the English ROM comes out,
// and the result is checked against the SHA-1 the patch's readme publishes for
// the patched file. A dump that is already the English ROM passes through.
// Its readme also says what the patch needs: "an original, unmodified ROM in
// native byte order (big-endian)" — so every dump is put in that order first,
// whichever of the three orders it was written in.
//
// A ROM IS RECOGNISED BY ITS CONTENTS, never its file name, the rule every
// finder here follows: the library is full of hand-named files. The test is
// the cartridge header — the byte-order mark at 0x0, the twenty-character
// internal name at 0x20 — and then the SHA-1 of the whole image in z64 order
// against the two sums the readme gives, which is what tells the Japanese ROM
// from the English one and either from a dump the patch would refuse.
//
// THE IPL is the one file here with no published sum to hold it to. It is
// recognised as a 4 MB N64 image whose internal name says IPL or 64DD, or —
// when that name is blank, as some dumps' are — by a file name that says
// "ipl". Confidence: likely. The player passes it to the core as the 64DD
// IPL; the core, not this module, is what rejects a wrong one.
//
// WHERE IT LOOKS: dev-fixtures/ and one level below it, plus $DEZAEMON_N64_ROM
// and $N64DD_IPL for files kept anywhere else. Candidates are filtered by
// extension and exact size (16 MB for the cartridge, 4 MB for the IPL) before
// anything is opened, and the lookup is memoised against the directory listing
// like its siblings, so a launcher polling the route costs a stat pass.

import { basename, dirname, fromFileUrl, join } from "@std/path";
import { applyVcdiff } from "../packages/shmup-engine/src/n64/index.js";

/** What the launcher calls the cartridge, and the name it reaches the player under. */
export const DEZAEMON_N64_TITLE = "Dezaemon 3D (Nintendo 64)";
export const DEZAEMON_N64_ROM_NAME = "Dezaemon3D.z64";
/** The name the IPL reaches the player under. */
export const N64DD_IPL_NAME = "64DD_IPL.n64";
/** The translation patch, served from static/ so the player could apply it too. */
export const DEZAEMON_N64_PATCH_FILE = "dezaemon-3d-usa-2024.09.12.xdelta";
export const DEZAEMON_N64_PATCH_URL = `/n64dd/${DEZAEMON_N64_PATCH_FILE}`;

/** Dezaemon 3D is a 128 Mbit cartridge; the retail 64DD IPL is 32 Mbit. */
export const DEZAEMON_N64_ROM_BYTES = 0x1000000;
export const N64DD_IPL_BYTES = 0x400000;

/** The readme's sums (z64 order): the Japanese ROM the patch takes, and the English one it makes. */
export const DEZAEMON_N64_SHA1_JAPAN =
  "1c10a85a2b6a782e6302b19c2387e2d58983a8d4";
export const DEZAEMON_N64_SHA1_ENGLISH =
  "04d0423ed9c143dc33aaa16835d6f8019f1720bb";

const ROM_EXTENSIONS = [".z64", ".n64", ".v64", ".rom", ".bin"];

export type N64ByteOrder = "z64" | "v64" | "n64";

/** The cartridge header fields this module reads. */
export interface N64RomHeader {
  /** The byte order the file was written in, or null when the mark is not an N64 one. */
  order: N64ByteOrder | null;
  /** The twenty-character internal name at 0x20, trimmed. */
  name: string;
  /** The four-character game code at 0x3B, e.g. NDZJ. */
  gameCode: string;
  /** The version byte at 0x3F. */
  version: number;
}

export type DezaemonN64Edition = "japan" | "english" | "unknown";

export interface DezaemonN64Rom {
  path: string;
  name: string;
  size: number;
  mtime: number;
  header: N64RomHeader;
  /** SHA-1 of the image in z64 order, lower-case hex. */
  sha1: string;
  /** Which dump this is, by that sum: the one the patch takes, the one it makes, or neither. */
  edition: DezaemonN64Edition;
}

export interface N64ddIpl {
  path: string;
  name: string;
  size: number;
  mtime: number;
  header: N64RomHeader;
  sha1: string;
}

export interface DezaemonN64Set {
  rom: DezaemonN64Rom | null;
  ipl: N64ddIpl | null;
}

/**
 * The byte-order mark of each N64 dump order. The first word is the PI bus
 * timing the boot code is read with, and it is not the same on every image:
 * a cartridge's is 0x80371240, the 64DD IPL's 0x80270740 (the retail Japanese
 * IPL, "64DD IPL (JPN)", dumped 2026-10-18). Both are listed in all three
 * orders, or a real IPL reads as no N64 image at all and is never found.
 */
const MARKS: Record<string, N64ByteOrder> = {
  "80371240": "z64",
  "37804012": "v64",
  "40123780": "n64",
  "80270740": "z64",
  "27804007": "v64",
  "40072780": "n64",
};

function hex4(bytes: Uint8Array): string {
  return Array.from(
    bytes.subarray(0, 4),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** The byte order of an N64 image by its first four bytes, or null. */
export function n64ByteOrder(bytes: Uint8Array): N64ByteOrder | null {
  if (bytes.length < 0x40) return null;
  return MARKS[hex4(bytes)] ?? null;
}

/**
 * The same image in z64 (big-endian, native) order: a v64 dump has every
 * 16-bit pair swapped, an n64 dump every 32-bit word reversed. A z64 image is
 * returned as it is (no copy).
 */
export function toZ64(bytes: Uint8Array): Uint8Array {
  const order = n64ByteOrder(bytes);
  if (order === "z64" || order === null) return bytes;
  const out = new Uint8Array(bytes.length);
  if (order === "v64") {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out[i] = bytes[i + 1];
      out[i + 1] = bytes[i];
    }
  } else {
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      out[i] = bytes[i + 3];
      out[i + 1] = bytes[i + 2];
      out[i + 2] = bytes[i + 1];
      out[i + 3] = bytes[i];
    }
  }
  return out;
}

/** The header of an image, read in z64 order whatever order the bytes are in. */
export function readN64Header(bytes: Uint8Array): N64RomHeader {
  const order = n64ByteOrder(bytes);
  const z = order === null ? bytes : toZ64(bytes.subarray(0, 0x40));
  const ascii = (at: number, len: number) =>
    Array.from(
      z.subarray(at, at + len),
      (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : " "),
    )
      .join("").trim();
  return {
    order,
    name: z.length >= 0x40 ? ascii(0x20, 20) : "",
    gameCode: z.length >= 0x40 ? ascii(0x3b, 4) : "",
    version: z.length >= 0x40 ? z[0x3f] : 0,
  };
}

/** Lower-case hex SHA-1 of a buffer. */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Whether an image's header says Dezaemon 3D (the sum is the stronger test; this is the cheap one). */
export function looksLikeDezaemon3d(header: N64RomHeader): boolean {
  return header.order !== null &&
    (/DEZAEMON\s*3D/i.test(header.name) || header.gameCode === "NDZJ");
}

/** Whether an image's header (or, failing a name, its file name) says it is the 64DD IPL. */
export function looksLikeN64ddIpl(
  header: N64RomHeader,
  fileName: string,
): boolean {
  if (header.order === null) return false;
  if (/IPL|64DD/i.test(header.name)) return true;
  return header.name === "" && /ipl/i.test(fileName);
}

/** The edition a z64-order sum names. */
export function editionOf(sha1: string): DezaemonN64Edition {
  if (sha1 === DEZAEMON_N64_SHA1_JAPAN) return "japan";
  if (sha1 === DEZAEMON_N64_SHA1_ENGLISH) return "english";
  return "unknown";
}

/**
 * The checkout this module runs in, found by walking up for dev-fixtures/ —
 * the same walk as lib/dezaemon-sfc.ts, for the same two layouts.
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
  if (name.startsWith("._")) return false;
  const lower = name.toLowerCase();
  return ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface Candidate {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Every path worth opening: dev-fixtures/ and one level below it, in name
 * order, at exactly the two sizes a cartridge and an IPL are. An explicit path
 * is taken as given, whatever its name — somebody who names a file in an
 * environment variable means that file.
 */
export async function n64Candidates(
  root: string,
  { extra = [] as string[] } = {},
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = async (path: string, any = false) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      const info = await Deno.stat(path);
      if (!info.isFile) return;
      if (
        !any && info.size !== DEZAEMON_N64_ROM_BYTES &&
        info.size !== N64DD_IPL_BYTES
      ) return;
      out.push({ path, size: info.size, mtime: info.mtime?.getTime() ?? 0 });
    } catch { /* gone between listing and stat */ }
  };
  for (const path of extra) if (path) await add(path, true);
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

let cached: { key: string; found: DezaemonN64Set } | null = null;

function candidatesKey(files: Candidate[]): string {
  return files.map((f) => `${f.path}:${f.size}:${f.mtime}`).join("|");
}

/**
 * The Dezaemon 3D cartridge and the 64DD IPL on this machine, either null when
 * absent. The first Japanese or English Dezaemon dump in candidate order wins
 * ($DEZAEMON_N64_ROM ahead of anything discovered); a Dezaemon dump whose sum
 * is neither is kept only until a known one turns up, so a bad dump is still
 * reported rather than silently skipped.
 */
export async function findDezaemonN64(
  root: string,
  { extra = [] as string[] } = {},
): Promise<DezaemonN64Set> {
  const files = await n64Candidates(root, { extra });
  const key = candidatesKey(files);
  if (cached && cached.key === key) return cached.found;
  const found: DezaemonN64Set = { rom: null, ipl: null };
  for (const file of files) {
    if (found.rom && found.rom.edition !== "unknown" && found.ipl) break;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(file.path);
    } catch {
      continue;
    }
    const header = readN64Header(bytes);
    if (header.order === null) continue;
    if (
      bytes.length === DEZAEMON_N64_ROM_BYTES && looksLikeDezaemon3d(header)
    ) {
      if (found.rom && found.rom.edition !== "unknown") continue;
      const sha1 = await sha1Hex(toZ64(bytes));
      const edition = editionOf(sha1);
      if (found.rom && edition === "unknown") continue;
      found.rom = {
        path: file.path,
        name: basename(file.path),
        size: file.size,
        mtime: file.mtime,
        header,
        sha1,
        edition,
      };
      continue;
    }
    if (bytes.length === DEZAEMON_N64_ROM_BYTES) {
      // A 16 MB image whose header does not say Dezaemon may still be it, renamed
      // and relabelled: the sum is the final word.
      const sha1 = await sha1Hex(toZ64(bytes));
      const edition = editionOf(sha1);
      if (
        edition !== "unknown" && !(found.rom && found.rom.edition !== "unknown")
      ) {
        found.rom = {
          path: file.path,
          name: basename(file.path),
          size: file.size,
          mtime: file.mtime,
          header,
          sha1,
          edition,
        };
      }
      continue;
    }
    if (
      !found.ipl && bytes.length === N64DD_IPL_BYTES &&
      looksLikeN64ddIpl(header, basename(file.path))
    ) {
      found.ipl = {
        path: file.path,
        name: basename(file.path),
        size: file.size,
        mtime: file.mtime,
        header,
        sha1: await sha1Hex(toZ64(bytes)),
      };
    }
  }
  cached = { key, found };
  return found;
}

/** The patch's bytes, from static/n64dd/ in the checkout. */
export async function readDezaemonN64Patch(root: string): Promise<Uint8Array> {
  return await Deno.readFile(
    join(root, "static", "n64dd", DEZAEMON_N64_PATCH_FILE),
  );
}

/**
 * The English ROM in z64 order: the dump put in native order, then — when it
 * is the Japanese ROM — the translation applied and the result held to the
 * readme's sum. The English dump passes through; any other is refused,
 * because the patch would refuse it too, with a less helpful message.
 */
export async function readDezaemonN64Rom(
  rom: DezaemonN64Rom,
  { root, patch }: { root?: string; patch?: Uint8Array } = {},
): Promise<Uint8Array> {
  const bytes = toZ64(await Deno.readFile(rom.path));
  if (rom.edition === "english") return bytes;
  if (rom.edition !== "japan") {
    throw new Error(
      `${rom.name} is a Dezaemon 3D dump the translation does not know (SHA-1 ${rom.sha1}); ` +
        `the patch takes the original Japanese ROM, SHA-1 ${DEZAEMON_N64_SHA1_JAPAN}`,
    );
  }
  const delta = patch ?? await readDezaemonN64Patch(root ?? await repoRoot());
  const english = applyVcdiff(bytes, delta, { verify: true });
  const sum = await sha1Hex(english);
  if (sum !== DEZAEMON_N64_SHA1_ENGLISH) {
    throw new Error(
      `the patched ROM's SHA-1 is ${sum}, not the ${DEZAEMON_N64_SHA1_ENGLISH} the translation's readme gives`,
    );
  }
  return english;
}

/** The IPL's bytes in z64 order. */
export async function readN64ddIpl(ipl: N64ddIpl): Promise<Uint8Array> {
  return toZ64(await Deno.readFile(ipl.path));
}

/** Drop the memo — for tests, which build and rebuild fixture trees. */
export function forgetDezaemonN64(): void {
  cached = null;
}
