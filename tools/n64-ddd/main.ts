// tools/n64-ddd — look inside a Dezaemon 3D 64DD disk (.ddd or .ndd), and
// write one.
//
//   deno task n64:probe ls <disk>
//   deno task n64:probe get <disk> <NAME.EXT> --out <path>
//   deno task n64:probe report <disk> [--stats] [--out <dir>]
//   deno task n64:probe png <disk> <NAME.EXT> --out <path> [--columns N]
//   deno task n64:probe all <disk> --out <dir>
//   deno task n64:probe sys <disk>
//   deno task n64:probe put <disk> <dir> --as NAME --out <path> [--ndd|--ddd]
//   deno task n64:probe rm <disk> NAME --out <path> [--ndd|--ddd]
//   deno task n64:probe convert <disk> --out <path> [--ndd|--ddd]
//
// <disk> is a .ddd (the user area of a 64DD disk, what the 2018 dump is) or an
// .ndd (the whole disk, its 24-block system area first, what an emulator
// mounts); every verb takes either, told apart by length and never by name.
// The reader and the writer are packages/shmup-engine/src/n64/. The disk is
// the Dezaemon DD prototype data disk, written 1998-02-23 from a Partner-N64
// unit for an expansion that was never released — and it is not a ROM:
// without the DEZA64 cartridge it only draws a notice telling you to go and
// get one.
//
// The three verbs that write — put, rm, convert — honour what the reader
// measured and nothing more: files laid end to end from LBA 9 in directory
// order, the read-only directory written at 834 bytes into LBA 1417, 1419 and
// 1422, and the RAM area (LBA 1418 on) carried byte for byte from the input.
// A project they put on a disk is a PRESSED one beside the two samples; the
// writable directory, the allocation map and the cartridge's DEZA3D.SYS /
// DEZA3D.HSC are never touched, because their layout is not known well enough
// (static/dezaemon-parity-n64.html, section 03). Every disk written is read
// back through the reader before it is saved, and --out never names the
// input. Nothing here has been tried on hardware or in an emulator.
//
// The disk is never committed (dev-fixtures/ is gitignored), so its path is
// given explicitly rather than discovered. One caution if you go past the
// sample projects: 64dd.org labels this dump the old one, and it differs from
// the current deza1.NDD in 175,897 bytes, every one of them inside the save
// area where the DST user project lives. Read DST from deza1.NDD, not from this.

import { basename, dirname, extname, join, resolve } from "@std/path";
import { encodePng, newRaster } from "@shmupx/shmup-harbor/png";
import {
  byProject,
  convertDisk,
  DDD_IMAGE_BYTES,
  decodeTileSheet,
  DOCUMENTED_SIZES,
  extractFile,
  imageFormat,
  NDD_IMAGE_BYTES,
  normalizeProjectName,
  parseDddImage,
  projectExts,
  putProject,
  readDirectory,
  readProjects,
  readSystemArea,
  REGION_DEVELOPMENT,
  REGION_JAPAN,
  REGION_USA,
  removeProject,
  sizeKey,
  summarizeDddImage,
  SYSTEM_AREA_BYTES,
  userArea,
} from "../../packages/shmup-engine/src/n64/index.js";

type DiskFormat = "ddd" | "ndd";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const USAGE = `usage:
  n64:probe ls <disk>
  n64:probe get <disk> <NAME.EXT> --out <path>
  n64:probe report <disk> [--stats] [--out <dir>]
  n64:probe png <disk> <NAME.EXT> --out <path> [--columns N]
  n64:probe all <disk> --out <dir>
  n64:probe sys <disk>
  n64:probe put <disk> <dir> --as NAME --out <path> [--ndd|--ddd]
  n64:probe rm <disk> NAME --out <path> [--ndd|--ddd]
  n64:probe convert <disk> --out <path> [--ndd|--ddd]

  <disk>      a .ddd (user area) or an .ndd (whole disk), told apart by size
  <dir>       a project's files as 'all' writes them: <EXT>.bin, e.g. CGR.bin, 0GR.bin
  --out       where to write; a directory for report/all, a file otherwise;
              never the input
  --as        the project's name on the disk, eight letters and digits
  --ndd/--ddd the image to write (else the --out extension, else the input's)
  --stats     entropy and 0x00/0xFF share per region (walks all 64 MB)
  --columns   tiles per row in a png contact sheet (default 20)`;

const args = [...Deno.args];
const command = args.shift();

if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const VALUE_FLAGS = new Set(["--out", "--columns", "--as"]);
const flags: Record<string, string | true> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg)) {
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    flags[arg] = value;
  } else if (arg.startsWith("--")) {
    flags[arg] = true;
  } else {
    positional.push(arg);
  }
}

function need(flag: string): string {
  const value = flags[flag];
  if (typeof value !== "string") fail(`${flag} is required\n\n${USAGE}`);
  return value;
}

function intFlag(flag: string, fallback: number): number {
  const value = flags[flag];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive integer`);
  return n;
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

async function write(path: string, data: Uint8Array | string) {
  await Deno.mkdir(dirname(resolve(path)), { recursive: true });
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  await Deno.writeFile(path, bytes);
  console.log(`${path}  ${bytes.length} bytes`);
}

function load(path: string | undefined): Uint8Array {
  if (!path) fail(`a .ddd or .ndd image is required\n\n${USAGE}`);
  try {
    return Deno.readFileSync(path);
  } catch (err) {
    return fail(`${path}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The user area of whatever was loaded: an .ndd's tail, a .ddd itself, and
 * anything of another length as it is, so that `report` can say what is
 * wrong with it instead of throwing.
 */
function user(image: Uint8Array): Uint8Array {
  return imageFormat(image) ? userArea(image) : image;
}

/** As user(), for the verbs that need a real disk. */
function disk(path: string | undefined): {
  path: string;
  image: Uint8Array;
  format: DiskFormat;
} {
  const image = load(path);
  const format = imageFormat(image) as DiskFormat | null;
  if (!format) {
    fail(
      `${path} is ${image.length} bytes, neither a .ddd (${DDD_IMAGE_BYTES}) nor an .ndd (${NDD_IMAGE_BYTES})`,
    );
  }
  return { path: path!, image, format };
}

/**
 * Whether --out names the input — compared as the kernel sees the two files
 * when both exist (dev + ino, so a symlink or another spelling of the same
 * name is caught), else as resolved paths. A write over the input would
 * destroy the only copy of a disk that is never committed.
 */
function sameFile(out: string, input: string): boolean {
  try {
    const a = Deno.statSync(out);
    const b = Deno.statSync(input);
    if (a.ino !== null && b.ino !== null) {
      return a.dev === b.dev && a.ino === b.ino;
    }
  } catch {
    // --out does not exist yet; fall through to the paths
  }
  try {
    return resolve(Deno.realPathSync(dirname(out)), basename(out)) ===
      resolve(Deno.realPathSync(dirname(input)), basename(input));
  } catch {
    return resolve(out) === resolve(input);
  }
}

/** --out for a verb that writes a disk: required, and never the input. */
function outDisk(input: string): string {
  const out = need("--out");
  if (sameFile(out, input)) {
    fail(
      "--out must name a different file; nothing here writes over its input",
    );
  }
  return out;
}

/** The image to write: the flag, else the --out extension, else the input's. */
function outFormat(out: string, fallback: DiskFormat): DiskFormat {
  if (flags["--ndd"] && flags["--ddd"]) {
    fail("--ndd and --ddd are one or the other");
  }
  if (flags["--ndd"]) return "ndd";
  if (flags["--ddd"]) return "ddd";
  const ext = extname(out).toLowerCase();
  if (ext === ".ndd" || ext === ".ddd") return ext.slice(1) as DiskFormat;
  return fallback;
}

/** "SAMPLEZ1.0GR" or "SAMPLEZ1 0GR" — the directory stores no dot. */
function pick(entries: ReturnType<typeof readDirectory>, spec: string) {
  const want = spec.replace(".", "").toUpperCase();
  const hit = entries.find((e) => `${e.name}${e.ext}`.toUpperCase() === want);
  if (!hit) {
    fail(
      `no file named ${spec}; try 'n64:probe ls' to see the ${entries.length} there are`,
    );
  }
  return hit;
}

function listing(entries: ReturnType<typeof readDirectory>): string {
  const lines = [
    "  # name     ext   lba blk   stored     offset  documented",
  ];
  for (const e of entries) {
    lines.push(
      `${String(e.slot).padStart(3)} ${e.name.padEnd(8)} ${e.ext.padEnd(3)} ` +
        `${String(e.startLba).padStart(5)} ${
          String(e.blockCount).padStart(3)
        } ` +
        `${String(e.storedSize).padStart(8)} ${hex(e.offset ?? 0)} ` +
        `${e.documentedSize === null ? "-" : String(e.documentedSize)}`,
    );
  }
  return lines.join("\n");
}

function regionName(region: number): string {
  if (region === REGION_JAPAN) return "Japan";
  if (region === REGION_USA) return "USA";
  if (region === REGION_DEVELOPMENT) return "development";
  return "unknown";
}

function dateText(date: Date | null): string {
  if (!date) return "none";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${
    p(date.getDate())
  } ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function ascii(s: string): string {
  return JSON.stringify(s);
}

/** The system area of an .ndd as text, the way an emulator reads it; one line for a .ddd. */
function systemText(image: Uint8Array): string {
  if (imageFormat(image) !== "ndd") return "system area: none (a .ddd)";
  const sys = readSystemArea(image);
  const lines = [
    `system area: ${SYSTEM_AREA_BYTES} bytes before the user area`,
  ];
  const d = sys.systemData;
  if (d) {
    lines.push(
      `system data: LBA ${sys.systemLba} (${
        sys.development ? "development" : "retail"
      }-format sectors)`,
      `  region      ${regionName(d.region)} (${hex(d.region)})`,
      `  format      0x${
        d.format.toString(16).padStart(2, "0")
      }  disk type ${d.diskType}${d.retail ? " (retail)" : ""}`,
      `  IPL         ${d.iplLoadBlocks} block${
        d.iplLoadBlocks === 1 ? "" : "s"
      } loaded to ${hex(d.iplLoadAddress)}`,
      `  ROM area    user LBA 0..${d.romEndLba}`,
      d.ramStartLba === 0xffff
        ? "  RAM area    none"
        : `  RAM area    user LBA ${d.ramStartLba}..${d.ramEndLba}`,
    );
  }
  const id = sys.diskId;
  if (id) {
    lines.push(
      `disk ID: LBA ${sys.diskIdLba}`,
      `  code        ${
        ascii(id.initialCode)
      }  version ${id.version}  disk ${id.diskNumber}  RAM use ${id.ramUse}  disk use ${id.diskUse}`,
      `  date        ${dateText(id.date)}`,
      `  company     ${ascii(id.companyCode)}  free area ${ascii(id.freeArea)}`,
    );
  }
  for (const e of sys.errors) lines.push(`error: ${e}`);
  return lines.join("\n");
}

/**
 * The report's text: the one-screen summary of the user area, the system
 * area when the image brought one (an .ndd, which the summary's size line
 * does not count), and the listing.
 */
function summary(
  image: Uint8Array,
  parsed: ReturnType<typeof parseDddImage>,
): string {
  const ndd = imageFormat(image) === "ndd";
  return [
    ...(ndd
      ? [
        `image: an .ndd of ${image.length} bytes; the user area below is its tail`,
      ]
      : []),
    summarizeDddImage(parsed),
    ...(ndd ? ["", systemText(image)] : []),
    "",
    listing(parsed.directory ?? []),
  ].join("\n");
}

async function renderPng(data: Uint8Array, path: string, columns: number) {
  const sheet = decodeTileSheet(data, { columns });
  if (sheet.tiles === 0) {
    fail("that file holds no whole 64x32 tiles, so it is not a graphics sheet");
  }
  const raster = newRaster(sheet.width, sheet.height);
  raster.data.set(sheet.data);
  await write(path, await encodePng(raster));
}

/**
 * A project's files off disk, as `all` writes them: <EXT>.bin, the three
 * characters before .bin being the extension (CGR.bin, 0GR.bin; a
 * NAME.EXT.bin spelling is taken too). Anything else in the directory —
 * the PNG renders, the report — is left alone.
 */
async function readProjectDir(
  dir: string,
): Promise<{ ext: string; data: Uint8Array; file: string }[]> {
  const files: { ext: string; data: Uint8Array; file: string }[] = [];
  const subdirs: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch (err) {
    return fail(`${dir}: ${err instanceof Error ? err.message : err}`);
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory) {
      subdirs.push(e.name);
      continue;
    }
    if (!/\.bin$/i.test(e.name)) continue;
    const stem = e.name.slice(0, -4);
    const ext = stem.slice(stem.lastIndexOf(".") + 1).toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(ext)) continue;
    if (files.some((f) => f.ext === ext)) {
      fail(
        `${dir} holds ${ext} twice (${
          files.find((f) => f.ext === ext)!.file
        } and ${e.name})`,
      );
    }
    files.push({
      ext,
      data: await Deno.readFile(join(dir, e.name)),
      file: e.name,
    });
  }
  if (!files.length) {
    const projects = subdirs.filter((s) => {
      try {
        return [...Deno.readDirSync(join(dir, s))].some((e) =>
          /\.bin$/i.test(e.name)
        );
      } catch {
        return false;
      }
    });
    fail(
      `${dir} holds no <EXT>.bin files` +
        (projects.length
          ? `; its project directories are ${projects.join(", ")} — name one`
          : ""),
    );
  }
  return files;
}

if (command === "ls") {
  const bytes = user(load(positional[0]));
  const parsed = parseDddImage(bytes);
  if (!parsed.directory) {
    fail("no ATNFS directory found; is this a Dezaemon 3D data disk?");
  }
  console.log(listing(parsed.directory));
} else if (command === "get") {
  const bytes = user(load(positional[0]));
  const entry = pick(
    readDirectory(bytes),
    positional[1] ?? fail(`a file name is required\n\n${USAGE}`),
  );
  const file = extractFile(bytes, entry);
  if (!file.sizeOk && file.expected !== null) {
    console.warn(
      `warning: ${entry.name}.${entry.ext} decompressed to ${file.data.length}, not the documented ${file.expected}`,
    );
  }
  await write(need("--out"), file.data);
} else if (command === "report") {
  const image = load(positional[0]);
  const parsed = parseDddImage(user(image), {
    stats: flags["--stats"] === true,
  });
  const text = summary(image, parsed);
  console.log(text);
  const out = flags["--out"];
  if (typeof out === "string") {
    await write(`${out}/report.txt`, `${text}\n`);
    const json = imageFormat(image) === "ndd"
      ? { ...parsed, systemArea: readSystemArea(image) }
      : parsed;
    await write(`${out}/report.json`, `${JSON.stringify(json, null, 2)}\n`);
  }
} else if (command === "png") {
  const bytes = user(load(positional[0]));
  const entry = pick(
    readDirectory(bytes),
    positional[1] ?? fail(`a file name is required\n\n${USAGE}`),
  );
  await renderPng(
    extractFile(bytes, entry).data,
    need("--out"),
    intFlag("--columns", 20),
  );
} else if (command === "all") {
  const image = load(positional[0]);
  const bytes = user(image);
  const out = need("--out");
  const parsed = parseDddImage(bytes, { stats: true });
  if (!parsed.directory) {
    fail("no ATNFS directory found; is this a Dezaemon 3D data disk?");
  }
  const text = summary(image, parsed);
  await write(`${out}/report.txt`, `${text}\n`);
  await write(`${out}/report.json`, `${JSON.stringify(parsed, null, 2)}\n`);
  for (const [name, files] of byProject(parsed.directory)) {
    for (const entry of files) {
      const file = extractFile(bytes, entry);
      await write(`${out}/${name}/${entry.ext}.bin`, file.data);
      if (entry.ext === "CGR" || entry.ext.endsWith("GR")) {
        await renderPng(file.data, `${out}/${name}/${entry.ext}.png`, 20);
      }
    }
  }
  console.log(`\n${basename(out)}: ${parsed.directory.length} files`);
} else if (command === "sys") {
  console.log(systemText(load(positional[0])));
} else if (command === "put") {
  const base = disk(positional[0]);
  const dir = positional[1] ??
    fail(`a project directory is required\n\n${USAGE}`);
  const out = outDisk(base.path);
  const format = outFormat(out, base.format);
  let name: string;
  try {
    name = normalizeProjectName(need("--as"));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const files = await readProjectDir(dir);
  const known = projectExts();
  for (const f of files) {
    if (!known.includes(f.ext)) {
      console.warn(
        `warning: ${f.file}: ${f.ext} is not one of a project's thirty files; written after them`,
      );
    }
    const documented =
      DOCUMENTED_SIZES[sizeKey(f.ext) as keyof typeof DOCUMENTED_SIZES];
    if (documented !== undefined && f.data.length !== documented) {
      console.warn(
        `warning: ${f.file} is ${f.data.length} bytes; a ${f.ext} is documented as ${documented}`,
      );
    }
  }
  const missing = known.filter((ext) => !files.some((f) => f.ext === ext));
  if (missing.length) {
    console.warn(
      `warning: ${dir} lacks ${missing.length} of a project's thirty files (${
        missing.join(", ")
      }); the project goes on without them`,
    );
  }
  const before = readProjects(base.image).map((p) => p.name);
  const built = putProject(
    base.image,
    { name, files: files.map((f) => ({ ext: f.ext, data: f.data })) },
    { format },
  );
  const rep = built.report as {
    projects: {
      name: string;
      kept: boolean;
      stored: number;
      firstLba: number | null;
      blockCount: number;
    }[];
    files: number;
    romFree: number;
  };
  const mine = rep.projects.find((p) => p.name === name)!;
  console.log(
    `${name}: ${files.length} files from ${dir}, ${
      files.reduce((a, f) => a + f.data.length, 0)
    } bytes -> ${mine.stored} stored in ${mine.blockCount} blocks from LBA ${mine.firstLba}` +
      (before.includes(name) ? ` (replacing the ${name} that was there)` : ""),
  );
  console.log(
    `disk: ${
      rep.projects.map((p) => `${p.name} ${p.kept ? "kept" : "new"}`).join(", ")
    }; ${rep.files} files; ${rep.romFree} bytes of the ROM area free; RAM area carried as it was`,
  );
  for (const w of built.warnings) console.warn(`warning: ${w}`);
  await write(out, built.image);
  console.log(`a .${built.format}; untested on hardware or in an emulator`);
} else if (command === "rm") {
  const base = disk(positional[0]);
  const spec = positional[1] ?? fail(`a project name is required\n\n${USAGE}`);
  const out = outDisk(base.path);
  const format = outFormat(out, base.format);
  let name: string;
  try {
    name = normalizeProjectName(spec);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const before = readProjects(base.image).map((p) => p.name);
  if (!before.includes(name)) {
    fail(
      `no project named ${name} on the disk; it holds ${
        before.join(", ") || "none"
      }`,
    );
  }
  const built = removeProject(base.image, name, { format });
  const rep = built.report as {
    projects: { name: string }[];
    files: number;
    romFree: number;
  };
  console.log(
    `removed ${name}; disk: ${
      rep.projects.map((p) => p.name).join(", ") || "no projects"
    }; ${rep.files} files; ${rep.romFree} bytes of the ROM area free; RAM area carried as it was`,
  );
  for (const w of built.warnings) console.warn(`warning: ${w}`);
  await write(out, built.image);
  console.log(`a .${built.format}; untested on hardware or in an emulator`);
} else if (command === "convert") {
  const base = disk(positional[0]);
  const out = outDisk(base.path);
  const ext = extname(out).toLowerCase();
  if (!flags["--ndd"] && !flags["--ddd"] && ext !== ".ndd" && ext !== ".ddd") {
    fail("say which format: --ndd or --ddd, or an --out named .ndd or .ddd");
  }
  const format = outFormat(out, base.format);
  if (format === base.format) {
    fail(
      `${base.path} is already a .${format}; convert writes the other format`,
    );
  }
  const image = convertDisk(base.image, format);
  console.log(
    format === "ndd"
      ? `.ddd -> .ndd: a system area built for a type-0 disk (DEZA, ATNFS0, dated now) in front of the user area, untouched`
      : `.ndd -> .ddd: the user area alone; the system area is dropped`,
  );
  await write(out, image);
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
