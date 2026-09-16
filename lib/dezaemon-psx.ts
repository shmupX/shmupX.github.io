// The two PlayStation Dezaemons in dev-fixtures/ — Dezaemon+ (1996) and
// Dezaemon Kids! (1998) — as the browser's PlayStation player wants them, plus
// the memory cards lying beside them.
//
// The player is not ours. It is cmg's /psx/play.html, mirrored onto this origin
// by static/emu-sw.js under the psx core's prefixes, and it boots a
// bring-your-own disc from ONE file posted into its frame. So this module turns
// whatever is on disk into that one file: a zip holding a .cue and the track
// files it names, the same shape lib/dezaemon-disc.ts hands the Saturn player.
//
// The name inside the zip is a contract, not a label. The cue is
// "Dezaemon Kids.cue" or "Dezaemon Plus.cue", because the cue's base name is
// what EmulatorJS hands the core as the content name and therefore what names
// the core's memory-card file in /data/saves. The display titles' "!" and "+"
// are dropped on purpose: a "+" decodes as a space under form decoding, and
// this name reaches a content-disposition header and, sooner or later, a URL.
// It is fixed now, while nobody has a save, because changing it afterwards
// orphans every save already written under the old name.
//
// A disc is recognised by its CONTENTS, never its file name — the rule
// lib/dezaemon-disc.ts:16-18 and lib/dezaemon-sfc.ts:11-13 both state, for the
// same reason: the community collection names its rips every possible way. The
// test is SYSTEM.CNF's BOOT= line normalised to a product code, because that
// names the disc unambiguously and carries the region for free. Root markers
// (KIDS.EXE + KIDS_DAT.BIN; MAIN.EXE + an UPLOAD directory) are the fallback
// for a rip whose SYSTEM.CNF cannot be read, never the first test — MAIN.EXE
// alone is a generic PlayStation executable name shared with dozens of
// unrelated games, and marker files cannot tell SLPS-00335 from SLPS-01504.
//
// Two discs can be the same game. The one this project actually traced is
// Dezaemon Plus Select 100, SLPS-01504, a 1998 re-release whose saves are still
// SLPS-00335's (packages/shmup-engine/FORMAT-PSX.md:695-703, "Select 100").
// Both are game "plus", and each disc reports the code it really carries, so a
// row never tells the operator they have SLPS-00335 when they have the
// re-release.
//
// WHERE IT LOOKS
// dev-fixtures/ flat, for .cue/.bin/.iso/.img, plus $DEZAEMON_PSX_DISC for an
// image kept anywhere else — one path, identified by its contents like
// everything else, so it may name either disc. Memory cards: dev-fixtures/
// recursively, four levels down, for .sav/.mcr/.mcd/.mc/.srm/.gme/.mcs/.psv.
//
// Nothing here reads a whole image. A MODE2/2352 rip of either disc runs 300 to
// 700 MB and detection needs only the front of it: the Primary Volume
// Descriptor is at LBA 16 and the root directory extent and SYSTEM.CNF sit a
// couple of megabytes behind it on every PlayStation master. So detection opens
// a 16 MiB prefix — iso9660-read.js clamps through subarray and returns short
// rather than throwing when the buffer ends early (hasVolumeDescriptor, line
// 36) — and the zip is never assembled at all. It is emitted as a
// ReadableStream, and because every entry is STORED its exact length is known
// before a byte is read, which is what lets the route send a real
// content-length for a body that size.
//
// Both the detection and the card listing are memoised in module memory against
// the candidates' names, sizes and mtimes: the same bargain the two siblings
// strike, so a launcher polling the route costs a stat pass rather than a read
// of the tree.
//
// This module imports its Saturn sibling because the cue parsing, the cue
// generation, the track-mode table and the memo key are console-neutral and
// already written there. repoRoot is imported only for symmetry and re-exported
// here, so the route imports it from the module it is already using — exactly
// what lib/dezaemon-disc.ts and lib/dezaemon-sfc.ts each offer on their own.

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import {
  identifyGame,
  locateSaves,
  narrow,
  parseSaveHeader,
  PSX_GAMES,
} from "../packages/shmup-engine/src/psx/index.js";
import {
  findEntry,
  openDisc,
  readFile,
} from "../packages/shmup-engine/src/cd/iso9660-read.js";
import {
  candidatesKey,
  cueForImage,
  type DiscFile,
  parseCueFiles,
  repoRoot,
  rewriteCueFiles,
  trackModeFor,
} from "./dezaemon-disc.ts";
import { fixturesDir } from "@shmupx/shmup-harbor/disc-file";

export { repoRoot };

/** What the launcher calls the pair. Mirrors PSX_TITLE in
 * static/psx-library.js, which cannot import this file (plain browser ESM). */
export const DEZAEMON_PSX_TITLE = "Dezaemon (PlayStation)";

/**
 * The content name per game: the cue's base name inside the zip, which is what
 * EmulatorJS hands the core and therefore what names the core's memory-card
 * file. The display titles' "!" and "+" are dropped on purpose — a "+" decodes
 * as a space under form decoding and this name reaches a content-disposition
 * header and, sooner or later, a URL. Fixed now, because changing it after
 * anyone has a save orphans that save.
 */
export const PSX_CONTENT_NAMES = Object.freeze(
  {
    kids: "Dezaemon Kids",
    plus: "Dezaemon Plus",
  } as const,
);

/** Product codes that identify a disc, and the game each one is. */
export const PSX_DISC_CODES = Object.freeze(
  {
    "SLPS-01503": "kids",
    "SLPS-00335": "plus",
    "SLPS-01504": "plus", // Dezaemon Plus Select 100, the 1998 re-release
  } as const,
);

/** The canonical code for a disc identified by markers alone. */
export const PSX_FALLBACK_CODES = Object.freeze(
  {
    kids: "SLPS-01503",
    plus: "SLPS-00335",
  } as const,
);

/**
 * Root entries that identify a disc when SYSTEM.CNF cannot be read. `kind`
 * matters: Dezaemon+'s UPLOAD is a DIRECTORY, and the marker loop the Saturn
 * module uses rejects directories outright (dezaemonGeometry, line 131), so a
 * copy of it would answer "not a disc" for the one disc this project has read.
 * MAIN.EXE is never a marker on its own — it is a generic PlayStation
 * executable name shared with dozens of unrelated games.
 */
export const PSX_MARKERS = Object.freeze(
  {
    kids: [
      { path: "KIDS.EXE", kind: "file" },
      { path: "KIDS_DAT.BIN", kind: "file" },
    ],
    plus: [
      { path: "MAIN.EXE", kind: "file" },
      { path: "UPLOAD", kind: "dir" },
    ],
  } as const,
);

/** ISO 9660's own BIOS region prefixes: the disc says where it is from. */
export const PSX_REGIONS = Object.freeze(
  {
    SLPS: "JP",
    SLPM: "JP",
    SCPS: "JP",
    SLUS: "US",
    SCUS: "US",
    SLES: "EU",
    SCES: "EU",
  } as const,
);

/** The BIOS this origin serves for each region (all three are mirrored under
 * /bios/, which static/emu-sw.js:81 carries). */
export const PSX_REGION_BIOS = Object.freeze(
  {
    JP: "/bios/scph5500.bin",
    US: "/bios/scph5501.bin",
    EU: "/bios/scph5502.bin",
  } as const,
);

/** What the mirrored player hardcodes as EJS_biosUrl. Restated, not read:
 * /psx/play.html lives on the cmg origin and nothing here can change it. */
export const PSX_PLAYER_BIOS = "/bios/scph5501.bin";

const IMAGE_EXTENSIONS = [".bin", ".iso", ".img"];
const CUE_EXTENSION = ".cue";
const CARD_EXTENSIONS = [
  ".sav",
  ".mcr",
  ".mcd",
  ".mc",
  ".srm",
  ".gme",
  ".mcs",
  ".psv",
];

/** Detection opens a prefix, never the image: the PVD is at LBA 16 and the root
 * directory and SYSTEM.CNF sit within the first few thousand sectors of every
 * PlayStation master, while the image itself runs to 700 MB. The reader clamps
 * on a short buffer rather than throwing. */
const DISC_PREFIX_BYTES = 16 * 1024 * 1024;

/** A card is 128 KB; nothing far off that is worth opening. .gme adds a 0xF40
 * header, .psv 0x84, so the window is generous at the top. */
const MIN_CARD_BYTES = 0x2000;
const MAX_CARD_BYTES = 0x40000;

/** How deep under dev-fixtures/ the card walk goes. The collection keeps a
 * folder per game and sometimes a folder per contributor under that. */
const CARD_DEPTH = 4;

/** A runaway fixtures tree must not turn one poll into ten thousand reads. */
const CARD_LIMIT = 500;

export type PsxGameId = "kids" | "plus";

export interface PsxDisc {
  /** The product code, lowercased: the id the route and the launcher use. */
  id: string;
  game: PsxGameId;
  /** The display title — PSX_GAMES[game].title, "!" and "+" and all. */
  title: string;
  /** The code this disc actually carries: SLPS-01504 is not SLPS-00335. */
  code: string;
  codeFrom: "system.cnf" | "markers";
  /** "JP" | "US" | "EU", or null when the code's prefix is unknown. */
  region: string | null;
  /** The cue's base name: PSX_CONTENT_NAMES[game]. */
  content: string;
  /** The cue text as included in the zip; FILE lines name `files` flat. */
  cue: string;
  cueFrom: "file" | "generated";
  cuePath: string | null;
  /** The track files in the cue's order; the first is the data track. */
  files: DiscFile[];
}

export interface PsxCard {
  /** "card-" + 12 hex of SHA-256 over the absolute path: stable across a
   * rescan, and it names no path the route could be talked into opening. */
  id: string;
  game: PsxGameId;
  /** The player's own game name, narrowed, or "" when the card has none —
   * Dezaemon+ stores no name anywhere (FORMAT-PSX.md:58-61). */
  name: string;
  /** The save's title frame, narrowed: "デザエモンKids!『A 』". */
  title: string;
  /** The directory entry's name: BISLPS-01503DEZAKIDS / BISLPS-00335DEZA. */
  filename: string;
  /** locateSaves()'s wrapping: "card" | "gme" | "mcs" | "psv" | "bare". */
  container: string;
  /** Path relative to dev-fixtures/, for the row to show. Never a URL. */
  from: string;
  /** The save block's length, and the file's on disk. */
  size: number;
  fileSize: number;
  deleted: boolean;
}

// locateSaves() is JSDoc'd JavaScript, so its shape is only as good as the
// comment above it; naming here the two pieces this module actually touches
// pins what is read even if that comment drifts, the way tools/psx-sav/
// main.ts:127-135 does for the parse result.
interface LocatedSave {
  filename: string;
  data: Uint8Array;
  deleted: boolean;
}
interface Located {
  container: string;
  saves: LocatedSave[];
}

// SYSTEM.CNF is ASCII in every master anyone has dumped, but it is read off a
// disc, so it is decoded as Latin-1: that never throws, never merges two bytes
// into one character and never plants a replacement character in the middle of
// the boot line the way a strict UTF-8 decode of a corrupt sector would.
const CNF_TEXT = new TextDecoder("latin1");

// Copies rather than imports, because lib/dezaemon-disc.ts exports neither and
// this change is not allowed to edit that file.
function hasExtension(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

async function statFile(path: string): Promise<DiscFile | null> {
  try {
    const st = await Deno.stat(path);
    if (!st.isFile) return null;
    return {
      name: basename(path),
      path,
      size: st.size,
      mtime: st.mtime?.getTime() ?? 0,
    };
  } catch {
    return null; /* gone between the listing and the stat */
  }
}

/** The first `bytes` of SHA-256 over `text`, hex. The id scheme the Saturn's
 * discZipEtag uses (lib/dezaemon-disc.ts:414-422), shared here by the card ids
 * and the zip's ETag so a path never leaves this module as a path. */
async function sha256Hex(text: string, bytes: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest).subarray(0, bytes))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The discs ────────────────────────────────────────────────────────────────

/** The product code a SYSTEM.CNF names, normalised: "SLPS_015.03" and
 * "SLPS015.03" both become "SLPS-01503". Real discs vary between cdrom: and
 * cdrom0:, between \ and /, between spaced and unspaced =, and end lines with
 * CRLF — and the repo's own notes spell one of these two boot names with an
 * underscore and the other without (dev-fixtures/debug-tools/README.md), so the
 * separators are optional here rather than required. */
export function parsePsxBootCode(text: string): string | null {
  const m =
    /^\s*BOOT\s*=\s*cdrom0?:[\\/]*([A-Za-z]{4})[_-]?(\d{3})[._-]?(\d{2})/im
      .exec(text);
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null;
}

function regionFor(code: string): string | null {
  const prefix = code.slice(0, 4) as keyof typeof PSX_REGIONS;
  return PSX_REGIONS[prefix] ?? null;
}

/** Which Dezaemon a disc image is, from its contents. `bytes` may be a prefix.
 * Returns null for anything else — a Dezaemon 2 Saturn image included, which is
 * the decoy that actually turns up in dev-fixtures/. */
export function identifyPsxDisc(bytes: Uint8Array): {
  game: PsxGameId;
  code: string;
  codeFrom: "system.cnf" | "markers";
  region: string | null;
  sectorSize: number;
  dataOffset: number;
} | null {
  const disc = openDisc(bytes);
  if (!disc) return null;
  const geometry = { sectorSize: disc.sectorSize, dataOffset: disc.dataOffset };

  let cnf: Uint8Array | null = null;
  try {
    cnf = readFile(disc, "SYSTEM.CNF");
  } catch {
    cnf = null; /* a directory extent that runs off the end of a prefix */
  }
  if (cnf && cnf.length) {
    const code = parsePsxBootCode(CNF_TEXT.decode(cnf));
    // A boot code that parses is the disc's own answer and it is final. A disc
    // that boots something else is not a Dezaemon whatever its root holds, and
    // falling through to the markers here would let MAIN.EXE plus an UPLOAD
    // directory claim an unrelated game.
    if (code) {
      if (!(code in PSX_DISC_CODES)) return null;
      const game = PSX_DISC_CODES[code as keyof typeof PSX_DISC_CODES];
      return {
        game,
        code,
        codeFrom: "system.cnf",
        region: regionFor(code),
        ...geometry,
      };
    }
  }

  for (const game of ["kids", "plus"] as const) {
    let all = true;
    for (const marker of PSX_MARKERS[game]) {
      let entry: { isDir: boolean } | null = null;
      try {
        entry = findEntry(disc, marker.path);
      } catch {
        entry = null; /* same: a truncated extent, not a missing file */
      }
      if (!entry || entry.isDir !== (marker.kind === "dir")) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    const code = PSX_FALLBACK_CODES[game];
    return {
      game,
      code,
      codeFrom: "markers",
      region: regionFor(code),
      ...geometry,
    };
  }
  return null;
}

/** The first `bytes` of a file, or null. Deno.open plus a read loop: a 700 MB
 * Deno.readFile is what this whole module exists to avoid. */
export async function readDiscPrefix(
  path: string,
  bytes = DISC_PREFIX_BYTES,
): Promise<Uint8Array | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null; /* vanished, or not ours to read */
  }
  try {
    // Sized to the file rather than to the cap, because a fixtures directory
    // holds cue sheets and 128 KB memory cards next to the images and a flat
    // 16 MiB allocation per candidate is paid on every one of them.
    const size = (await file.stat()).size;
    const want = size > 0 ? Math.min(bytes, size) : bytes;
    const buf = new Uint8Array(want);
    let at = 0;
    while (at < buf.length) {
      const n = await file.read(buf.subarray(at));
      if (n === null || n === 0) break; // short file: the reader clamps anyway
      at += n;
    }
    return at > 0 ? buf.subarray(0, at) : null;
  } catch {
    return null; /* an I/O error mid-read is "not here", like an absent file */
  } finally {
    file.close();
  }
}

/**
 * Every file that could be, or describe, a PlayStation disc: the cues and
 * images in dev-fixtures/ AND one level below it, plus `extra` (the route
 * passes $DEZAEMON_PSX_DISC). Stat'd, so the result doubles as the change key
 * for the memo below.
 *
 * The same extensions as discCandidates (lib/dezaemon-disc.ts:161-186), copied
 * rather than imported: the glob is console-neutral but the name says Saturn,
 * and the two differ entirely in what they then open — that one reads each
 * image whole, this one reads a prefix.
 *
 * ONE LEVEL DOWN, because that is where a disc actually turns up. The Saturn's
 * glob is flat and the SFC's is not — findDezaemonSfcRom looks in "dev-fixtures/
 * and one level below it, because the collection keeps a console per folder"
 * (lib/dezaemon-sfc.ts:19). The PlayStation collection keeps a GAME per folder:
 * the cards arrive as dev-fixtures/Dezaemon Kids!/*.sav with the disc sitting
 * beside them, which a flat glob walks straight past. Only one level, and only
 * these extensions, so this stays a listing of two directories and not a walk
 * of whatever else is in there — the cards have their own deeper walk with its
 * own cap (psxCardCandidates).
 */
export async function psxDiscCandidates(
  root: string,
  extra: string[] = [],
): Promise<DiscFile[]> {
  const fixtures = fixturesDir(root);
  const paths = new Set<string>();
  const wanted = [CUE_EXTENSION, ...IMAGE_EXTENSIONS];
  const scan = (dir: string, descend: boolean) => {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        // A dot-directory is someone's cache and a `._name` is the AppleDouble
        // sidecar macOS leaves on this project's exFAT volume; neither holds a
        // disc and both cost a stat to find that out.
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory) {
          if (descend) scan(join(dir, entry.name), false);
          continue;
        }
        if (!entry.isFile) continue;
        if (hasExtension(entry.name, wanted)) paths.add(join(dir, entry.name));
      }
    } catch { /* unreadable, or absent — a fresh checkout has neither */ }
  };
  scan(fixtures, true);
  for (const p of extra) {
    if (p && hasExtension(p, [CUE_EXTENSION, ...IMAGE_EXTENSIONS])) {
      paths.add(isAbsolute(p) ? p : resolve(root, p));
    }
  }
  const files: DiscFile[] = [];
  for (const p of [...paths].sort((a, b) => a.localeCompare(b))) {
    const f = await statFile(p);
    if (f) files.push(f);
  }
  return files;
}

function psxDiscRecord(
  id: ReturnType<typeof identifyPsxDisc> & object,
  rest: Pick<PsxDisc, "cue" | "cueFrom" | "cuePath" | "files">,
): PsxDisc {
  return {
    id: id.code.toLowerCase(),
    game: id.game,
    title: PSX_GAMES[id.game].title,
    code: id.code,
    codeFrom: id.codeFrom,
    region: id.region,
    content: PSX_CONTENT_NAMES[id.game],
    ...rest,
  };
}

/** Detect without the memo: open a prefix of every candidate once. */
export async function detectPsxDiscs(
  candidates: DiscFile[],
): Promise<PsxDisc[]> {
  const discs: PsxDisc[] = [];
  const claimed = new Set<string>();
  // One record per product code. Both Dezaemon+ discs can be in a tree at once
  // and a rip can be there twice under two names; candidates are sorted by
  // path before anything is opened, so "the first one wins" is a stable answer
  // rather than whatever the filesystem happened to list first.
  const taken = new Set<string>();

  // Cues first: a cue on disk is the faithful description of its image(s), so
  // an image a cue names is reported through the cue, not on its own.
  for (
    const cue of candidates.filter((f) => hasExtension(f.name, [CUE_EXTENSION]))
  ) {
    let text: string;
    try {
      text = await Deno.readTextFile(cue.path);
    } catch {
      continue; /* a cue we cannot read describes nothing */
    }
    const names = parseCueFiles(text);
    if (!names.length) continue;
    const files: DiscFile[] = [];
    for (const name of names) {
      const f = await statFile(
        isAbsolute(name) ? name : join(dirname(cue.path), name),
      );
      if (!f) break;
      files.push(f);
    }
    if (files.length !== names.length) continue; // a FILE that is not there
    const prefix = await readDiscPrefix(files[0].path);
    if (!prefix) continue;
    const id = identifyPsxDisc(prefix);
    if (!id) continue;
    // Claimed before the duplicate test, not after: the cue describes these
    // tracks either way, and leaving them unclaimed would only let the bare
    // pass below offer the same disc again with a worse, generated cue.
    for (const f of files) claimed.add(f.path);
    if (taken.has(id.code)) continue;
    taken.add(id.code);
    // Renamed to base names: the zip is flat, and the two must agree.
    const renamed = rewriteCueFiles(text, (n) => basename(n));
    discs.push(psxDiscRecord(id, {
      cue: renamed.endsWith("\n") ? renamed : renamed + "\n",
      cueFrom: "file",
      cuePath: cue.path,
      files,
    }));
  }

  for (const img of candidates) {
    if (!hasExtension(img.name, IMAGE_EXTENSIONS) || claimed.has(img.path)) {
      continue;
    }
    const prefix = await readDiscPrefix(img.path);
    if (!prefix) continue;
    const id = identifyPsxDisc(prefix);
    // trackModeFor first, because cueForImage THROWS on a geometry no cue can
    // express (2448-byte sectors with subchannel data) and this is a probe: a
    // disc it cannot describe is "not here", not a 500 out of the route.
    if (!id || !trackModeFor(id)) continue;
    if (taken.has(id.code)) continue;
    taken.add(id.code);
    discs.push(psxDiscRecord(id, {
      cue: cueForImage(img.name, id),
      cueFrom: "generated",
      cuePath: null,
      files: [img],
    }));
  }
  return discs;
}

let detectedDiscs: { key: string; discs: PsxDisc[] } | null = null;

/**
 * Every PlayStation Dezaemon disc here, cue-described ones first. Memoised
 * against the candidates' names, sizes and mtimes, so a repeat call with
 * nothing changed opens no image.
 */
export async function findPsxDiscs(
  root: string,
  { extra = [], cache = true }: { extra?: string[]; cache?: boolean } = {},
): Promise<PsxDisc[]> {
  const candidates = await psxDiscCandidates(root, extra);
  const key = candidatesKey(candidates);
  if (cache && detectedDiscs && detectedDiscs.key === key) {
    return detectedDiscs.discs;
  }
  const discs = await detectPsxDiscs(candidates);
  if (cache) detectedDiscs = { key, discs };
  return discs;
}

/** One disc by its id (its lowercased product code), or null. */
export async function findPsxDisc(
  root: string,
  id: string,
  options?: { extra?: string[]; cache?: boolean },
): Promise<PsxDisc | null> {
  const wanted = id.toLowerCase();
  const discs = await findPsxDiscs(root, options);
  return discs.find((d) => d.id === wanted) ?? null;
}

// ── The memory cards ─────────────────────────────────────────────────────────

const FIXTURES_MARK = "/dev-fixtures/";

/** A candidate's path as a row may show it: relative to dev-fixtures/, POSIX
 * separators, never absolute. Cut at the fixtures segment rather than handed a
 * root, because detectPsxCards takes a candidate list and nothing else, and
 * fixturesDir() is join(root, "dev-fixtures") (packages/shmup-harbor/lib/
 * disc-file.ts:36-38), so the segment is always in a path this module made. */
function relativeToFixtures(path: string): string {
  const posix = path.replaceAll("\\", "/");
  const at = posix.lastIndexOf(FIXTURES_MARK);
  return at < 0
    ? posix.slice(posix.lastIndexOf("/") + 1)
    : posix.slice(at + FIXTURES_MARK.length);
}

/** Every file under dev-fixtures/ that is the right size and extension to be a
 * memory card, four levels deep, AppleDouble sidecars skipped. */
export async function psxCardCandidates(root: string): Promise<DiscFile[]> {
  const found: DiscFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= CARD_LIMIT) return;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      // No fixtures directory, or one this process may not list. Either way
      // there is nothing below it to report.
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= CARD_LIMIT) return;
      // "._01.sav" is macOS's AppleDouble fork on this project's exFAT volume
      // — 4 KB of extended attributes wearing the extension of the file it
      // describes — and ".cache/" is the extracted-disc cache. deno.json's
      // exclude lists "**/._*" for the same reason.
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        dirs.push(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!hasExtension(entry.name, CARD_EXTENSIONS)) continue;
      const f = await statFile(path);
      if (!f || f.size < MIN_CARD_BYTES || f.size > MAX_CARD_BYTES) continue;
      found.push(f);
    }
    if (depth >= CARD_DEPTH) return;
    for (const sub of dirs) await walk(sub, depth + 1);
  };
  await walk(fixturesDir(root), 1);
  return found;
}

/** Identify without the memo. Cheap on purpose: locateSaves peels the
 * container, identifyGame settles the game from the directory entry's name
 * alone, and parseSaveHeader reads the 256-byte title frame. NOTHING here
 * decompresses — a full parsePsxSav of a Kids! card costs 5.6 ms and 7.4 MB,
 * against 0.013 ms for this, and a shelf row needs none of it. */
export async function detectPsxCards(
  candidates: DiscFile[],
): Promise<PsxCard[]> {
  const cards: PsxCard[] = [];
  for (const f of candidates) {
    let located: Located;
    try {
      // At most 256 KB by the candidate filter, so this one is read whole.
      located = locateSaves(await Deno.readFile(f.path));
    } catch {
      continue; /* unreadable, or a container the walker choked on */
    }
    // "unknown" is the normal answer for a .srm that is a Saturn save or a
    // .sav that is 128 KB of zeroes: not a card, and not an error either.
    if (located.container === "unknown") continue;
    const from = relativeToFixtures(f.path);
    for (const save of located.saves) {
      const game = identifyGame(save.data, save.filename) as PsxGameId | null;
      if (!game) continue;
      const header = parseSaveHeader(save.data);
      // Kids! puts the player's own game name inside the title between 『 』;
      // Dezaemon+ has no name anywhere in text (FORMAT-PSX.md:58-61), so it
      // falls back to "" and the row composes its own label — never to the
      // product code, which would read as a name the player chose.
      const bracket = game === "kids" ? /『(.*?)』/.exec(header.title) : null;
      cards.push({
        // The path is hashed rather than carried: an id has to survive a
        // rescan and must name nothing this route could be asked to open.
        id: "card-" + await sha256Hex(f.path, 6),
        game,
        // narrow() has already turned the ideographic space into an ASCII one
        // (save-header.js:47-49), so a plain trim finishes the job.
        name: bracket ? narrow(bracket[1]).trim() : "",
        title: header.titleAscii,
        filename: save.filename,
        container: located.container,
        from,
        // save.data is a SUBARRAY of the file for a bare, .mcs or .psv save,
        // so its length is taken and the bytes are dropped here; holding one
        // would hold the whole file behind it.
        size: save.data.length,
        fileSize: f.size,
        deleted: save.deleted,
      });
    }
  }
  return cards;
}

let detectedCards: { key: string; cards: PsxCard[] } | null = null;

/** Every Dezaemon memory card here, in candidate order. */
export async function findPsxCards(
  root: string,
  { cache = true }: { cache?: boolean } = {},
): Promise<PsxCard[]> {
  const candidates = await psxCardCandidates(root);
  const key = candidatesKey(candidates);
  if (cache && detectedCards && detectedCards.key === key) {
    return detectedCards.cards;
  }
  const cards = await detectPsxCards(candidates);
  if (cache) detectedCards = { key, cards };
  return cards;
}

// ── The zip ──────────────────────────────────────────────────────────────────

// crc32() in @shmupx/shmup-harbor/zip takes the WHOLE buffer (zip.ts:80), and
// the whole buffer is the thing this module refuses to allocate. Same
// polynomial, same table, seedable so a 700 MB track can be fed through it a
// megabyte at a time.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
const CRC_INIT = 0xffffffff;

function crcUpdate(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

function crcFinish(crc: number): number {
  return (crc ^ CRC_INIT) >>> 0;
}

/** How much of a track is held at once. A megabyte is large enough that the
 * per-read overhead disappears against a 700 MB file and small enough that a
 * client reading slowly parks one of these, not a disc. */
const ZIP_CHUNK_BYTES = 1024 * 1024;

/** The same fixed stamp lib/dezaemon-disc.ts:408 zips with, so the same disc
 * still zips to the same bytes through either path. */
const ZIP_EPOCH = new Date("2000-03-04T00:00:00Z");

/** MS-DOS packed date and time, the only timestamp a plain ZIP entry carries.
 * The eight lines of lib/dezaemon-disc.ts:291-300, copied because that one is
 * module-private there and this change may not edit that file. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (Math.floor(date.getUTCSeconds() / 2)) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCHours() << 11),
    date: date.getUTCDate() |
      ((date.getUTCMonth() + 1) << 5) |
      ((date.getUTCFullYear() - 1980) << 9),
  };
}

/**
 * Exactly `size` bytes of a track, in ZIP_CHUNK_BYTES pieces.
 *
 * `size` comes from the stat that made this a candidate, and it is what the
 * local header, the central record and psxDiscZipLength all promise. A file
 * that shrank since then is zero-filled to the promise instead of ending the
 * body early: the zip is wrong either way, but a body shorter than its
 * content-length is a request that never finishes.
 *
 * `status.short` is how the caller learns it got padding rather than the
 * track. Only crcOfFile asks, and only so it knows not to remember the answer.
 */
async function* trackChunks(
  path: string,
  size: number,
  status?: { short: boolean },
): AsyncGenerator<Uint8Array, void, unknown> {
  let sent = 0;
  let file: Deno.FsFile | null = null;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    file = null; /* gone between the stat and the send */
  }
  if (file) {
    try {
      while (sent < size) {
        const buf = new Uint8Array(Math.min(ZIP_CHUNK_BYTES, size - sent));
        const n = await file.read(buf);
        if (n === null || n === 0) break;
        sent += n;
        yield n === buf.length ? buf : buf.subarray(0, n);
      }
    } finally {
      // Runs on a client that hangs up mid-disc too: psxDiscZipStream's cancel
      // returns the generator, which unwinds through here.
      file.close();
    }
  }
  while (sent < size) {
    // Reached for a file that would not open and for one that ended early, so
    // it is the one place that has to raise the flag.
    if (status) status.short = true;
    const take = Math.min(ZIP_CHUNK_BYTES, size - sent);
    yield new Uint8Array(take);
    sent += take;
  }
}

// Memoised against path, size and mtime, so a second launch of the same disc
// that misses the ETag pays one read of it rather than two. Cleared wholesale
// rather than evicted: a disc has a handful of tracks, and the key carries the
// mtime, so a rebuilt file can never answer from a stale entry anyway.
const CRC_MEMO_LIMIT = 32;
const trackCrcs = new Map<string, number>();

async function crcOfFile(f: DiscFile, signal?: AbortSignal): Promise<number> {
  const key = `${f.path}|${f.size}|${f.mtime}`;
  const memo = trackCrcs.get(key);
  if (memo !== undefined) return memo;
  const status = { short: false };
  let crc = CRC_INIT;
  for await (const chunk of trackChunks(f.path, f.size, status)) {
    // Checked per chunk, and it throws rather than breaks. This pre-pass runs
    // before the first byte of the body, so a client that hangs up here is
    // otherwise unnoticed until the whole disc has been read for a zip nobody
    // is waiting for; and breaking out would fall through to the memo below
    // and remember a CRC of the part it got to.
    signal?.throwIfAborted();
    crc = crcUpdate(crc, chunk);
  }
  const sum = crcFinish(crc);
  // A CRC taken over zero-fill describes a file this process could not read,
  // not the track. Remembering it would outlive its cause: the file comes
  // back, the mtime and size still key the same entry, and every later launch
  // serves a header whose CRC cannot match the data it precedes — a silently
  // broken zip in exchange for one saved read. So a short read is answered
  // once and never memoised.
  if (!status.short) {
    if (trackCrcs.size >= CRC_MEMO_LIMIT) trackCrcs.clear();
    trackCrcs.set(key, sum);
  }
  return sum;
}

/** The zip's entries: the cue first, then the track files under their own base
 * names. Every one STORED — the core reads sectors straight out of the stored
 * bytes, and a CD image barely deflates. */
export function psxZipEntries(disc: PsxDisc): {
  path: string;
  size: number;
  from: string | null; // null for the cue, which is generated
}[] {
  return [
    {
      path: `${disc.content}${CUE_EXTENSION}`,
      size: new TextEncoder().encode(disc.cue).length,
      from: null,
    },
    ...disc.files.map((f) => ({ path: f.name, size: f.size, from: f.path })),
  ];
}

/** The zip's exact length, known before a byte is read: every entry is stored,
 * so it is 76 + 2*nameBytes + dataBytes per entry (a 30-byte local header and a
 * 46-byte central record, each carrying the name), plus the 22-byte end record.
 * This is what lets the route send a real content-length for a 700 MB body. */
export function psxDiscZipLength(disc: PsxDisc): number {
  const encoder = new TextEncoder();
  let total = 22;
  for (const entry of psxZipEntries(disc)) {
    total += 76 + 2 * encoder.encode(entry.path).length + entry.size;
  }
  return total;
}

/** The zip's key: the disc's files plus the cue text they are paired with —
 * the Saturn's discZipKey (lib/dezaemon-disc.ts:385-387), which is the same
 * question asked of a different record. */
function psxDiscZipKey(disc: PsxDisc): string {
  return `${candidatesKey(disc.files)}\n${disc.cuePath ?? ""}\n${disc.cue}`;
}

/** A short, stable tag for the zip's bytes — an ETag the route hands out.
 * Quoted, like the Saturn's (lib/dezaemon-disc.ts:421) and like every other
 * ETag on the wire: an unquoted one is not a valid entity-tag and an
 * intermediary is free to drop it. */
export async function psxDiscZipEtag(disc: PsxDisc): Promise<string> {
  return `"psx-${disc.id}-${await sha256Hex(psxDiscZipKey(disc), 8)}"`;
}

function localHeader(
  name: Uint8Array,
  sum: number,
  size: number,
  stamp: { time: number; date: number },
): Uint8Array {
  const header = new Uint8Array(30 + name.length);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x04034b50, true);
  hv.setUint16(4, 20, true); // version needed: PKZip 2.0
  hv.setUint16(6, 0, true); // flags
  hv.setUint16(8, 0, true); // method: store
  hv.setUint16(10, stamp.time, true);
  hv.setUint16(12, stamp.date, true);
  hv.setUint32(14, sum, true);
  hv.setUint32(18, size, true);
  hv.setUint32(22, size, true);
  hv.setUint16(26, name.length, true);
  hv.setUint16(28, 0, true); // extra
  header.set(name, 30);
  return header;
}

function centralRecord(
  name: Uint8Array,
  sum: number,
  size: number,
  stamp: { time: number; date: number },
  offset: number,
): Uint8Array {
  const record = new Uint8Array(46 + name.length);
  const rv = new DataView(record.buffer);
  rv.setUint32(0, 0x02014b50, true);
  rv.setUint16(4, 20, true); // version made by
  rv.setUint16(6, 20, true); // version needed
  rv.setUint16(8, 0, true);
  rv.setUint16(10, 0, true);
  rv.setUint16(12, stamp.time, true);
  rv.setUint16(14, stamp.date, true);
  rv.setUint32(16, sum, true);
  rv.setUint32(20, size, true);
  rv.setUint32(24, size, true);
  rv.setUint16(28, name.length, true);
  rv.setUint16(30, 0, true); // extra
  rv.setUint16(32, 0, true); // comment
  rv.setUint16(34, 0, true); // disk number
  rv.setUint16(36, 0, true); // internal attributes
  rv.setUint32(38, 0, true); // external attributes
  rv.setUint32(42, offset, true);
  record.set(name, 46);
  return record;
}

function endRecord(
  count: number,
  centralSize: number,
  centralAt: number,
): Uint8Array {
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralAt, true);
  ev.setUint16(20, 0, true);
  return end;
}

// Byte-for-byte the record layout buildStoredZip writes (lib/dezaemon-disc.ts:
// 310-381) — same stamp, version 20, flags 0, method 0, compressed size equal
// to the uncompressed one — except that it is yielded instead of concatenated.
//
// Two passes over each track. The first CRCs it, because a STORED local header
// carries the CRC AHEAD of the data and by the time the data has streamed that
// header is long gone; the second sends it. The one-pass alternative is a data
// descriptor after each entry, and the player's unzipper is on another origin
// and not ours to test against.
async function* psxZipChunks(
  disc: PsxDisc,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, unknown> {
  const encoder = new TextEncoder();
  const cue = encoder.encode(disc.cue);
  const items: { path: string; size: number; file: DiscFile | null }[] = [
    { path: `${disc.content}${CUE_EXTENSION}`, size: cue.length, file: null },
    ...disc.files.map((f) => ({ path: f.name, size: f.size, file: f })),
  ];
  const sums: number[] = [];
  for (const item of items) {
    sums.push(
      item.file
        ? await crcOfFile(item.file, signal)
        : crcFinish(crcUpdate(CRC_INIT, cue)),
    );
  }

  const stamp = dosStamp(ZIP_EPOCH);
  const central: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = encoder.encode(item.path);
    yield localHeader(name, sums[i], item.size, stamp);
    central.push(centralRecord(name, sums[i], item.size, stamp, offset));
    offset += 30 + name.length + item.size;
    if (!item.file) {
      yield cue;
      continue;
    }
    for await (const chunk of trackChunks(item.file.path, item.size)) {
      yield chunk;
    }
  }
  let centralSize = 0;
  for (const record of central) {
    centralSize += record.length;
    yield record;
  }
  yield endRecord(items.length, centralSize, offset);
}

/**
 * The player's zip, as a stream. Never assembled: a MODE2/2352 rip runs to
 * 700 MB, and buildStoredZip in lib/dezaemon-disc.ts would hold that twice and
 * then memoise it for the life of the process (lines 389, 406).
 *
 * Pulled rather than pushed. The generator is stepped once per pull, so a
 * client reading at 2 MB/s parks one 1 MiB chunk here rather than letting the
 * whole disc pile up in the stream's queue — which is the failure this shape
 * exists to avoid, and the one an eager loop inside start() walks straight
 * into.
 *
 * Cancelling needs both halves. Returning the generator stops it at its next
 * YIELD, which is enough once the body is flowing; the CRC pre-pass has no
 * yield in it at all, so a hang-up during that first read would otherwise go
 * unnoticed until the whole disc had been read. The signal is what reaches
 * inside it.
 */
export function psxDiscZipStream(disc: PsxDisc): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  const chunks = psxZipChunks(disc, stop.signal);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        // The abort below is the only throw this generator has, and by the
        // time it lands the consumer is already gone: erroring the stream at
        // that point is shouting at an empty room. Anything else is real.
        if (!stop.signal.aborted) throw err;
      }
    },
    async cancel() {
      stop.abort();
      // A client that hangs up mid-disc unwinds the generator's finally, which
      // closes whatever track file is open. Without this the descriptor leaks
      // for the life of the process. The rejection is the abort coming back
      // out of the pre-pass, and it is ours.
      await chunks.return().catch(() => {});
    },
  });
}
