// The Dezaemon 2 disc in dev-fixtures/, as the browser's Saturn player wants
// it.
//
// The launcher adds its Sega Saturn section automatically when a Dezaemon 2
// disc image is lying in the gitignored dev-fixtures/ (GET /api/dezaemon-disc
// asks here). The player — cmg's /saturn/play.html, EmulatorJS around the
// yabause core — boots a bring-your-own disc from ONE zip holding a .cue and
// the track files it names, so this module turns whatever is on disk into that
// zip: a .cue found beside the image is used as it is; a bare .bin/.iso/.img
// gets a one-track cue written for its sector geometry. The cue inside the zip
// is always "Dezaemon 2.cue", because the cue's base name is what EmulatorJS
// hands the core as the content name and therefore what names the core's
// backup-memory file (/data/saves/Dezaemon 2.srm — static/saturn-saves.js
// writes a level into that file, so the name is a contract, not a label).
//
// A disc is recognised by its contents rather than its file name: the ISO
// 9660 root has to hold GAME.CMP and DEZA2.PAL, the game's program and
// palette (the same files scripts/build-mesh-library.ts and deza:palette read
// off the disc). lib/disc-file.ts opens the images; this adds the names,
// sizes and cue handling that the zip needs.
//
// The image is 7.6 MB and detection has to open it, so both the detection and
// the built zip are memoised in module memory against the fixture directory's
// listing (names, sizes, mtimes): a launcher polling the route costs a stat
// pass, not a read of the tree, and the zip is built once per change.

import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  resolve,
} from "@std/path";
import {
  findEntry,
  openDisc,
} from "../packages/shmup-engine/src/cd/iso9660-read.js";
import { crc32 } from "./ps2/zip.ts";
import { fixturesDir } from "./disc-file.ts";

/** The disc's title, and the content name the cue inside the zip carries. */
export const DEZAEMON_TITLE = "Dezaemon 2";
export const DEZAEMON_CONTENT_NAME = "Dezaemon 2";
export const DEZAEMON_CUE_NAME = `${DEZAEMON_CONTENT_NAME}.cue`;
export const DEZAEMON_ZIP_NAME = `${DEZAEMON_CONTENT_NAME}.zip`;

/** What has to be in the ISO 9660 root for an image to be Dezaemon 2. */
export const MARKER_FILES = ["GAME.CMP", "DEZA2.PAL"];

const IMAGE_EXTENSIONS = [".bin", ".iso", ".img"];
const CUE_EXTENSION = ".cue";

export interface DiscFile {
  /** The name the file has inside the zip (its base name on disk). */
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export interface DezaemonDisc {
  /** The cue text as included in the zip: FILE lines name `files` as included. */
  cue: string;
  /** Whether the cue came from disk or was written for a bare image. */
  cueFrom: "file" | "generated";
  cuePath: string | null;
  /** The track files, in the cue's order; the first is the data track. */
  files: DiscFile[];
}

/** The FILE names a cue sheet references, in order, quotes removed. */
export function parseCueFiles(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\S+\s*$/i);
    if (m) names.push(m[1] ?? m[2]);
  }
  return names;
}

/** The same cue with every FILE name replaced by `rename(name)`, so a cue
 * whose FILE lines carried a directory still names the files as the zip
 * holds them (flat, by base name). */
export function rewriteCueFiles(
  text: string,
  rename: (name: string) => string,
): string {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*FILE\s+)(?:"([^"]+)"|(\S+))(\s+\S+\s*)$/i);
    if (!m) return line;
    return `${m[1]}"${rename(m[2] ?? m[3])}"${m[4]}`;
  }).join("\n");
}

/** The cue TRACK mode for a sector geometry the ISO reader detected, or null
 * when a cue cannot express it (2448-byte sectors with subchannel data). */
export function trackModeFor(
  geometry: { sectorSize: number; dataOffset: number },
): string | null {
  const { sectorSize, dataOffset } = geometry;
  if (sectorSize === 2048) return "MODE1/2048";
  if (sectorSize === 2352 && dataOffset === 16) return "MODE1/2352";
  if (sectorSize === 2352 && dataOffset === 24) return "MODE2/2352";
  if (sectorSize === 2336) return "MODE2/2336";
  return null;
}

/** A one-track cue for a bare data image. */
export function cueForImage(
  fileName: string,
  geometry: { sectorSize: number; dataOffset: number },
): string {
  const mode = trackModeFor(geometry);
  if (!mode) {
    throw new Error(
      `${fileName}: ${geometry.sectorSize}-byte sectors cannot be described by a cue sheet`,
    );
  }
  return `FILE "${fileName}" BINARY\n  TRACK 01 ${mode}\n    INDEX 01 00:00:00\n`;
}

/** Whether these bytes are a Dezaemon 2 disc image; the geometry when so. */
export function dezaemonGeometry(
  bytes: Uint8Array,
): { sectorSize: number; dataOffset: number } | null {
  const disc = openDisc(bytes);
  if (!disc) return null;
  for (const marker of MARKER_FILES) {
    const entry = findEntry(disc, marker);
    if (!entry || entry.isDir) return null;
  }
  return { sectorSize: disc.sectorSize, dataOffset: disc.dataOffset };
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
    return null;
  }
}

function hasExtension(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

/**
 * Every file that could be, or describe, a disc: the cues and images in
 * dev-fixtures/ plus any `extra` paths (the route passes $DEZAEMON_DISC).
 * Stat'd, so the result doubles as the change key for the memo below.
 */
export async function discCandidates(
  root: string,
  extra: string[] = [],
): Promise<DiscFile[]> {
  const fixtures = fixturesDir(root);
  const paths = new Set<string>();
  try {
    for (const entry of Deno.readDirSync(fixtures)) {
      if (!entry.isFile) continue;
      if (hasExtension(entry.name, [CUE_EXTENSION, ...IMAGE_EXTENSIONS])) {
        paths.add(join(fixtures, entry.name));
      }
    }
  } catch { /* no fixtures directory — the normal state of a fresh checkout */ }
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

/** The memo key for a candidate list: a change to any name, size or mtime
 * invalidates both the detection and the zip built from it. */
export function candidatesKey(files: DiscFile[]): string {
  return files.map((f) => `${f.path}|${f.size}|${f.mtime}`).join("\n");
}

/** Detect without the memo: open every candidate once. */
export async function detectDezaemonDiscs(
  candidates: DiscFile[],
): Promise<DezaemonDisc[]> {
  const discs: DezaemonDisc[] = [];
  const claimed = new Set<string>();

  // Cues first: a cue on disk is the faithful description of its image(s),
  // so an image a cue names is reported through the cue, not on its own.
  for (const cue of candidates.filter((f) => hasExtension(f.name, [".cue"]))) {
    let text: string;
    try {
      text = await Deno.readTextFile(cue.path);
    } catch {
      continue;
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
    let image: Uint8Array;
    try {
      image = await Deno.readFile(files[0].path);
    } catch {
      continue;
    }
    if (!dezaemonGeometry(image)) continue;
    // Renamed to base names: the zip is flat, and the two must agree.
    const renamed = rewriteCueFiles(text, (n) => basename(n));
    discs.push({
      cue: renamed.endsWith("\n") ? renamed : renamed + "\n",
      cueFrom: "file",
      cuePath: cue.path,
      files,
    });
    for (const f of files) claimed.add(f.path);
  }

  for (const img of candidates) {
    if (!hasExtension(img.name, IMAGE_EXTENSIONS) || claimed.has(img.path)) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(img.path);
    } catch {
      continue;
    }
    const geometry = dezaemonGeometry(bytes);
    if (!geometry || !trackModeFor(geometry)) continue;
    discs.push({
      cue: cueForImage(img.name, geometry),
      cueFrom: "generated",
      cuePath: null,
      files: [img],
    });
  }
  return discs;
}

let detected: { key: string; discs: DezaemonDisc[] } | null = null;

/**
 * Every Dezaemon 2 disc in dev-fixtures/ (and `extra`), cue-described ones
 * first. Memoised against the candidates' names, sizes and mtimes, so a
 * repeat call with nothing changed opens no image.
 */
export async function findDezaemonDiscs(
  root: string,
  { extra = [], cache = true }: { extra?: string[]; cache?: boolean } = {},
): Promise<DezaemonDisc[]> {
  const candidates = await discCandidates(root, extra);
  const key = candidatesKey(candidates);
  if (cache && detected && detected.key === key) return detected.discs;
  const discs = await detectDezaemonDiscs(candidates);
  if (cache) detected = { key, discs };
  return discs;
}

/** The disc the launcher uses: the first found, or null. */
export async function findDezaemonDisc(
  root: string,
  options?: { extra?: string[]; cache?: boolean },
): Promise<DezaemonDisc | null> {
  return (await findDezaemonDiscs(root, options))[0] ?? null;
}

// ── The zip ──────────────────────────────────────────────────────────────────

/** MS-DOS packed date and time, the only timestamp a plain ZIP entry carries. */
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
 * A ZIP of `entries`, every one STORED. The same layout lib/ps2/zip.ts
 * writes, minus the deflate: that writer compresses whatever shrinks, and a
 * raw CD image shrinks a little, which would cost a 7.6 MB deflate here and
 * an inflate in the player's JavaScript for nothing — the core reads the
 * sectors straight out of the stored bytes. `date` is fixed by the caller so
 * the same disc zips to the same bytes.
 */
export function buildStoredZip(
  entries: { path: string; data: Uint8Array }[],
  date: Date,
): Uint8Array {
  const stamp = dosStamp(date);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const sum = crc32(entry.data);
    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true); // version needed: PKZip 2.0
    hv.setUint16(6, 0, true); // flags
    hv.setUint16(8, 0, true); // method: store
    hv.setUint16(10, stamp.time, true);
    hv.setUint16(12, stamp.date, true);
    hv.setUint32(14, sum, true);
    hv.setUint32(18, entry.data.length, true);
    hv.setUint32(22, entry.data.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true); // extra
    header.set(name, 30);

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
    rv.setUint32(20, entry.data.length, true);
    rv.setUint32(24, entry.data.length, true);
    rv.setUint16(28, name.length, true);
    rv.setUint16(30, 0, true); // extra
    rv.setUint16(32, 0, true); // comment
    rv.setUint16(34, 0, true); // disk number
    rv.setUint16(36, 0, true); // internal attributes
    rv.setUint32(38, 0, true); // external attributes
    rv.setUint32(42, offset, true);
    record.set(name, 46);

    parts.push(header, entry.data);
    central.push(record);
    offset += header.length + entry.data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The zip's key: the disc's files plus the cue text they are paired with. */
export function discZipKey(disc: DezaemonDisc): string {
  return `${candidatesKey(disc.files)}\n${disc.cuePath ?? ""}\n${disc.cue}`;
}

let builtZip: { key: string; bytes: Uint8Array } | null = null;

/**
 * The player's zip for `disc`: "Dezaemon 2.cue" then the track files under
 * their own names, all stored. Built once per change to the files, then
 * served from memory.
 */
export async function buildDezaemonDiscZip(
  disc: DezaemonDisc,
  { cache = true }: { cache?: boolean } = {},
): Promise<Uint8Array> {
  const key = discZipKey(disc);
  if (cache && builtZip && builtZip.key === key) return builtZip.bytes;
  const entries = [
    { path: DEZAEMON_CUE_NAME, data: new TextEncoder().encode(disc.cue) },
  ];
  for (const f of disc.files) {
    entries.push({ path: f.name, data: await Deno.readFile(f.path) });
  }
  const bytes = buildStoredZip(entries, new Date("2000-03-04T00:00:00Z"));
  if (cache) builtZip = { key, bytes };
  return bytes;
}

/** A short, stable tag for the zip's bytes — an ETag the route can hand out. */
export async function discZipEtag(disc: DezaemonDisc): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(discZipKey(disc)),
  );
  const hex = Array.from(new Uint8Array(digest).subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"deza2-${hex}"`;
}

/**
 * The checkout this module runs in, found by walking up from the module's own
 * location for dev-fixtures/: the module sits in lib/ in a source checkout and
 * in _fresh/server/assets/<chunk>.mjs once Vite has bundled the server (the
 * same reason routes/api/build-artifact.ts walks). Falls back to the working
 * directory, which is the checkout under `deno task dev`.
 */
export async function repoRoot(): Promise<string> {
  let dir: string;
  try {
    dir = dirname(fromFileUrl(import.meta.url));
  } catch {
    return Deno.cwd(); // not a file: URL — nothing to walk up from
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
