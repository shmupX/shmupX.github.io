// The Steam build's member packs, read where they lie.
//
// `deno task build:steam` leaves what is not ours to sell out of the binary
// and writes it into shmupx-member-<id>.zip files instead (lib/member-
// content.ts says what goes where). A member drops those zips into a members
// folder, or imports them from the launcher, and from then on the packaged
// server answers those paths out of the zips themselves: the central
// directory is read once per pack, and a request reads one entry — only the
// asked-for bytes of a stored one, so an arcade player's ranged probe of a
// 14 MB romset reads one byte. Nothing is unpacked onto disk.
//
// A folder that holds a member.json is a pack too, for anyone who would
// rather unzip one than keep the archive. Either way a pack can only answer
// for paths a member rule names, so a zip dropped in by mistake — or on
// purpose — can never stand in for the launcher's own pages.
//
// Where packs are looked for, first match winning:
//   $SHMUPX_MEMBERS          one or more folders, the platform's PATH delimiter
//   <data dir>/members       where the launcher's MEMBER FILES import puts them
//   <beside the binary>/members   e.g. Steam's "Browse local files" folder

import { crc32 } from "@shmupx/shmup-harbor/zip";
import { serveFile } from "@std/http/file-server";
import { basename, DELIMITER, dirname, extname, join } from "@std/path";
import { launcherDataDir } from "./desktop-browser.ts";
import { isSteamFlavor } from "./launcher-flavor.ts";
import {
  MEMBER_FORMAT,
  type MemberManifest,
  type MemberPack,
  memberPacks,
  packFor,
} from "./member-content.ts";

// ------------------------------------------------------------------ zip index

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
const FLAG_ENCRYPTED = 0x0001;

/** One file in an archive, as its central directory describes it. */
export interface ZipEntryInfo {
  /** Its path inside the archive, `/`-separated with no leading slash. */
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  crc: number;
  compressed: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
}

export class ZipFormatError extends Error {}

async function readAt(
  file: Deno.FsFile,
  at: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  await file.seek(at, Deno.SeekMode.Start);
  let got = 0;
  while (got < length) {
    const n = await file.read(out.subarray(got));
    if (n === null) throw new ZipFormatError("the archive ends early");
    got += n;
  }
  return out;
}

/** An archive path as a key: forward slashes, relative, never climbing out. */
function cleanName(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) =>
    p !== "" && p !== "."
  );
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/**
 * Every file in the zip at `path`, by name, read off its central directory.
 * Directories, and entries that climb with "..", are left out. ZIP64 and
 * encrypted entries are refused: buildZip writes neither, and a member pack
 * this reader misread would serve the wrong bytes under the right name.
 */
export async function readZipIndex(
  path: string,
): Promise<Map<string, ZipEntryInfo>> {
  using file = await Deno.open(path, { read: true });
  const size = (await file.stat()).size;
  if (size < EOCD_MIN) throw new ZipFormatError("not a zip");
  const tailLength = Math.min(size, EOCD_SEARCH);
  const tail = await readAt(file, size - tailLength, tailLength);
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError("not a zip (no end record)");
  const count = tv.getUint16(end + 10, true);
  const cdSize = tv.getUint32(end + 12, true);
  const cdOffset = tv.getUint32(end + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipFormatError("a ZIP64 archive, which this does not read");
  }
  if (cdOffset + cdSize > size) {
    throw new ZipFormatError("the central directory runs past the end");
  }
  const cd = await readAt(file, cdOffset, cdSize);
  const v = new DataView(cd.buffer);
  const names = new TextDecoder();
  const entries = new Map<string, ZipEntryInfo>();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || v.getUint32(at, true) !== CENTRAL_SIG) {
      throw new ZipFormatError("a broken central directory");
    }
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const compressed = v.getUint32(at + 20, true);
    const usize = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const raw = names.decode(cd.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (raw.endsWith("/")) continue;
    if (flags & FLAG_ENCRYPTED) {
      throw new ZipFormatError(`${raw} is encrypted`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipFormatError(`${raw} uses compression method ${method}`);
    }
    if (
      compressed === 0xffffffff || usize === 0xffffffff ||
      offset === 0xffffffff
    ) throw new ZipFormatError(`${raw} needs ZIP64`);
    const name = cleanName(raw);
    if (name === null || entries.has(name)) continue;
    entries.set(name, { name, method, crc, compressed, size: usize, offset });
  }
  return entries;
}

/** Where an entry's bytes start: past its local header, which has its own name and extra lengths. */
async function dataStart(file: Deno.FsFile, e: ZipEntryInfo): Promise<number> {
  const head = await readAt(file, e.offset, 30);
  const hv = new DataView(head.buffer);
  if (hv.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipFormatError(`${e.name}: no local header where it should be`);
  }
  return e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One whole entry, checked against its CRC. */
export async function readZipEntry(
  path: string,
  e: ZipEntryInfo,
): Promise<Uint8Array> {
  using file = await Deno.open(path, { read: true });
  const body = await readAt(file, await dataStart(file, e), e.compressed);
  const data = e.method === 8 ? await inflateRaw(body) : body;
  if (data.length !== e.size || crc32(data) !== e.crc) {
    throw new ZipFormatError(`${e.name} does not match its checksum`);
  }
  return data;
}

/** Part of a stored entry, read straight off the disk. */
async function readStoredSlice(
  path: string,
  e: ZipEntryInfo,
  start: number,
  length: number,
): Promise<Uint8Array> {
  using file = await Deno.open(path, { read: true });
  return await readAt(file, await dataStart(file, e) + start, length);
}

// ------------------------------------------------------------------- packs

/** A pack found in a members folder. */
export interface InstalledPack {
  /** The id its member.json gives, or the file's own name. */
  id: string;
  title: string;
  /** The zip, or the folder holding member.json. */
  path: string;
  kind: "zip" | "folder";
  /** The URL paths it answers for (decoded, leading slash), sorted. */
  files: string[];
  /** Files it carries that no member rule names, and so never serves. */
  ignored: number;
}

/** A pack that could not be read, and why. */
export interface PackProblem {
  path: string;
  reason: string;
}

interface Hit {
  pack: InstalledPack;
  entry?: ZipEntryInfo;
  file?: string;
}

/** The URL path a request names, decoded segment by segment, or null when it cannot be. */
export function decodedPath(pathname: string): string | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/").slice(1)) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === ".." || /[\\\0]/.test(seg)) {
      return null;
    }
    segments.push(seg);
  }
  return segments.length ? "/" + segments.join("/") : null;
}

/** The pack name a zip file carries in its own name: shmupx-member-arcade.zip → arcade. */
function idFromFileName(name: string): string {
  return name.replace(/\.zip$/i, "").replace(/^shmupx-member-/i, "");
}

function readManifest(text: string): Partial<MemberManifest> | null {
  try {
    const m = JSON.parse(text);
    return m && typeof m === "object" && m.format === MEMBER_FORMAT ? m : null;
  } catch {
    return null;
  }
}

/** The folders packs are looked for in, most specific first. */
export function memberDirs(opts: {
  env: Record<string, string>;
  dataDir: string;
  execPath?: string;
}): string[] {
  const dirs = (opts.env.SHMUPX_MEMBERS ?? "").split(DELIMITER).map((d) =>
    d.trim()
  ).filter(Boolean);
  dirs.push(join(opts.dataDir, "members"));
  if (opts.execPath) {
    const beside = dirname(opts.execPath);
    dirs.push(join(beside, "members"));
    // A macOS bundle's binary is three folders down from where a person
    // would put the folder: next to the .app.
    const bundle = /^(.*)[\\/][^\\/]+\.app[\\/]Contents[\\/]MacOS$/.exec(
      beside,
    );
    if (bundle) dirs.push(join(bundle[1], "members"));
  }
  return [...new Set(dirs)];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".mjs": "text/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".md": "text/markdown; charset=UTF-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

/** What a served member file says it is. ROMs and saves are plain bytes. */
export function memberContentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The single byte range a Range header asks of `size` bytes: null for none
 * (or one this does not honour, which is then answered whole, as RFC 9110
 * allows), "unsatisfiable" for one past the end.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** How long a lookup that missed trusts the last scan before looking again. */
const RESCAN_MS = 3000;

/**
 * Every pack in the members folders, and what each answers for.
 *
 * Scanned on first use, after an import, and again when a path a rule names
 * misses and the last scan is a few seconds old — so a zip dropped into the
 * folder while the launcher runs is picked up by the next request for one of
 * its files, with no restart.
 */
export class MemberLibrary {
  #dirs: () => string[];
  #importDir: string;
  #rules: readonly MemberPack[];
  #packs: InstalledPack[] = [];
  #problems: PackProblem[] = [];
  #index = new Map<string, Hit>();
  #scannedAt = -Infinity;
  #scanning: Promise<void> | null = null;

  constructor(opts: {
    dirs: () => string[];
    /** Where an import is filed: <data dir>/members. */
    importDir: string;
    rules: readonly MemberPack[];
  }) {
    this.#dirs = opts.dirs;
    this.#importDir = opts.importDir;
    this.#rules = opts.rules;
  }

  get rules(): readonly MemberPack[] {
    return this.#rules;
  }

  /** The rule a URL path falls under, or null when it is not member content. */
  ruleFor(path: string): MemberPack | null {
    return packFor(path, this.#rules);
  }

  get importDir(): string {
    return this.#importDir;
  }

  get dirs(): string[] {
    return this.#dirs();
  }

  async packs(): Promise<{ packs: InstalledPack[]; problems: PackProblem[] }> {
    await this.#ensureScanned();
    return { packs: this.#packs, problems: this.#problems };
  }

  /** Look again now, whatever the last scan found. */
  rescan(): Promise<void> {
    if (!this.#scanning) {
      this.#scanning = this.#scan().finally(() => {
        this.#scanning = null;
      });
    }
    return this.#scanning;
  }

  async #ensureScanned(): Promise<void> {
    if (this.#scannedAt === -Infinity) await this.rescan();
  }

  async #scan(): Promise<void> {
    const packs: InstalledPack[] = [];
    const problems: PackProblem[] = [];
    const index = new Map<string, Hit>();
    const add = (pack: InstalledPack, hits: Map<string, Hit>) => {
      packs.push(pack);
      for (const [path, hit] of hits) {
        if (!index.has(path)) index.set(path, hit);
      }
    };
    for (const dir of this.#dirs()) {
      let names: Deno.DirEntry[] = [];
      try {
        for await (const e of Deno.readDir(dir)) names.push(e);
      } catch {
        continue; // no such folder: nothing in it
      }
      names = names.filter((e) => !e.name.startsWith("."))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const e of names) {
        const path = join(dir, e.name);
        try {
          if (e.isFile && /\.zip$/i.test(e.name)) {
            const read = await this.#readZipPack(path);
            if (read) add(read.pack, read.hits);
          } else if (e.isDirectory) {
            const read = await this.#readFolderPack(path);
            if (read) add(read.pack, read.hits);
          }
        } catch (err) {
          problems.push({ path, reason: (err as Error).message });
        }
      }
    }
    this.#packs = packs;
    this.#problems = problems;
    this.#index = index;
    this.#scannedAt = Date.now();
  }

  async #readZipPack(
    path: string,
    fileName = basename(path),
  ): Promise<{ pack: InstalledPack; hits: Map<string, Hit> } | null> {
    const entries = await readZipIndex(path);
    const meta = entries.get("member.json");
    const manifest = meta
      ? readManifest(new TextDecoder().decode(await readZipEntry(path, meta)))
      : null;
    const hits = new Map<string, Hit>();
    const pack: InstalledPack = {
      id: typeof manifest?.id === "string" && manifest.id
        ? manifest.id
        : idFromFileName(fileName),
      title: typeof manifest?.title === "string" ? manifest.title : "",
      path,
      kind: "zip",
      files: [],
      ignored: 0,
    };
    for (const entry of entries.values()) {
      if (entry.name === "member.json") continue;
      const url = "/" + entry.name;
      if (!this.ruleFor(url)) {
        pack.ignored++;
        continue;
      }
      hits.set(url, { pack, entry });
      pack.files.push(url);
    }
    pack.files.sort();
    if (!pack.title) pack.title = this.#titleOf(pack);
    return { pack, hits };
  }

  async #readFolderPack(
    dir: string,
  ): Promise<{ pack: InstalledPack; hits: Map<string, Hit> } | null> {
    let manifest: Partial<MemberManifest> | null;
    try {
      manifest = readManifest(
        await Deno.readTextFile(join(dir, "member.json")),
      );
    } catch {
      return null; // a folder with no member.json is not a pack
    }
    if (!manifest) throw new Error("member.json is not a member pack's");
    const hits = new Map<string, Hit>();
    const pack: InstalledPack = {
      id: typeof manifest.id === "string" && manifest.id
        ? manifest.id
        : basename(dir),
      title: typeof manifest.title === "string" ? manifest.title : "",
      path: dir,
      kind: "folder",
      files: [],
      ignored: 0,
    };
    const walk = async (at: string, rel: string[]) => {
      for await (const e of Deno.readDir(at)) {
        if (e.name.startsWith("._") || e.name === ".DS_Store") continue;
        const next = [...rel, e.name];
        if (e.isDirectory) await walk(join(at, e.name), next);
        else if (e.isFile) {
          if (!rel.length && e.name === "member.json") continue;
          const url = "/" + next.join("/");
          if (!this.ruleFor(url)) {
            pack.ignored++;
            continue;
          }
          hits.set(url, { pack, file: join(at, e.name) });
          pack.files.push(url);
        }
      }
    };
    await walk(dir, []);
    pack.files.sort();
    if (!pack.title) pack.title = this.#titleOf(pack);
    return { pack, hits };
  }

  /** A pack with no title of its own takes the rule its files fall under. */
  #titleOf(pack: InstalledPack): string {
    const rule = this.#rules.find((r) => r.id === pack.id) ??
      (pack.files[0] ? this.ruleFor(pack.files[0]) : null);
    return rule?.title ?? pack.id;
  }

  /** Which pack holds `path` (a decoded URL path), looking again if it is not found and the last look is stale. */
  async locate(path: string): Promise<Hit | null> {
    await this.#ensureScanned();
    let hit = this.#index.get(path) ?? null;
    if (!hit && Date.now() - this.#scannedAt > RESCAN_MS) {
      await this.rescan();
      hit = this.#index.get(path) ?? null;
    }
    return hit;
  }

  /**
   * Answer `req` for the decoded URL path `path` out of whichever pack holds
   * it, or null when none does. GET and HEAD, a single byte range, and an
   * ETag from the entry's CRC so a second load is a 304.
   */
  async serve(req: Request, path: string): Promise<Response | null> {
    const hit = await this.locate(path);
    if (!hit) return null;
    if (hit.file) {
      try {
        return await serveFile(req, hit.file);
      } catch {
        await this.rescan();
        return null;
      }
    }
    const entry = hit.entry!;
    const zip = hit.pack.path;
    const etag = `"m${entry.crc.toString(16).padStart(8, "0")}-${entry.size}"`;
    const headers = new Headers({
      "content-type": memberContentType(path),
      "accept-ranges": "bytes",
      etag,
      "cache-control": "no-cache",
    });
    if ((req.headers.get("if-none-match") ?? "").includes(etag)) {
      return new Response(null, { status: 304, headers });
    }
    const range = parseRange(req.headers.get("range"), entry.size);
    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${entry.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? entry.size - 1;
    const length = Math.max(0, end - start + 1);
    headers.set("content-length", String(length));
    if (range) {
      headers.set("content-range", `bytes ${start}-${end}/${entry.size}`);
    }
    const status = range ? 206 : 200;
    if (req.method === "HEAD") return new Response(null, { status, headers });
    let body: Uint8Array;
    try {
      body = entry.method === 0 && range
        ? await readStoredSlice(zip, entry, start, length)
        : (await readZipEntry(zip, entry)).subarray(start, end + 1);
    } catch (err) {
      // The zip changed or broke under us: say so once, and look again.
      await this.rescan();
      return new Response(`${hit.pack.path}: ${(err as Error).message}`, {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(body as Uint8Array<ArrayBuffer>, { status, headers });
  }

  /**
   * File `bytes` as a pack in the import folder, under the name its
   * member.json gives (or `name`). Refused unless it reads as a zip that holds
   * at least one file a member rule names. Resolves to the pack as filed.
   */
  async importPack(bytes: Uint8Array, name: string): Promise<InstalledPack> {
    const dir = this.#importDir;
    await Deno.mkdir(dir, { recursive: true });
    const part = join(dir, `.import-${crypto.randomUUID()}.part`);
    await Deno.writeFile(part, bytes);
    try {
      const read = await this.#readZipPack(part, basename(name));
      if (!read || !read.pack.files.length) {
        throw new Error(
          "it holds none of the files a member pack carries",
        );
      }
      const id = read.pack.id.replace(/[^A-Za-z0-9_.-]+/g, "-")
        .replace(/^[.-]+/, "") || "pack";
      const dest = join(dir, `shmupx-member-${id}.zip`);
      await Deno.rename(part, dest);
      await this.rescan();
      return this.#packs.find((p) => p.path === dest) ?? read.pack;
    } catch (err) {
      await Deno.remove(part).catch(() => {});
      throw err;
    }
  }
}

let shared: MemberLibrary | null | undefined;

/**
 * The Steam build's packs, one library for the whole server (main.ts serves
 * from it, /api/members lists and imports into it); null in any other build,
 * which carries or downloads its member content instead.
 */
export function steamMemberLibrary(): MemberLibrary | null {
  if (shared !== undefined) return shared;
  const standalone = (Deno.build as { standalone?: boolean }).standalone ===
    true;
  if (!standalone || !isSteamFlavor()) return (shared = null);
  const os = Deno.build.os === "windows"
    ? "windows"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  const env = Deno.env.toObject();
  const dataDir = launcherDataDir(os, env);
  let execPath = "";
  try {
    execPath = Deno.execPath();
  } catch { /* cannot say: the data dir still works */ }
  shared = new MemberLibrary({
    // Read per scan, so --members (desktop.ts sets SHMUPX_MEMBERS) and a
    // folder created after startup both count.
    dirs: () => memberDirs({ env: Deno.env.toObject(), dataDir, execPath }),
    importDir: join(dataDir, "members"),
    // Every romset shape counts as the arcade pack's, so the eShop's own list
    // is not needed here (lib/member-content.ts).
    rules: memberPacks([]),
  });
  return shared;
}
