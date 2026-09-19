// tools/n64-ddd — look inside a Dezaemon 3D 64DD disk (.ddd).
//
//   deno task n64:probe ls <ddd>
//   deno task n64:probe get <ddd> <NAME.EXT> --out <path>
//   deno task n64:probe report <ddd> [--stats] [--out <dir>]
//   deno task n64:probe png <ddd> <NAME.EXT> --out <path> [--columns N]
//   deno task n64:probe all <ddd> --out <dir>
//
// The parser is packages/shmup-engine/src/n64/. The disk is the user data area
// of a 64DD disk — the Dezaemon DD prototype data disk, written 1998-02-23 from
// a Partner-N64 unit for an expansion that was never released — and it is not a
// ROM: without the DEZA64 cartridge it only draws a notice telling you to go and
// get one.
//
// The disk is never committed (dev-fixtures/ is gitignored), so its path is
// given explicitly rather than discovered. One caution if you go past the
// sample projects: 64dd.org labels this dump the old one, and it differs from
// the current deza1.NDD in 175,897 bytes, every one of them inside the save
// area where the DST user project lives. Read DST from deza1.NDD, not from this.

import { basename, dirname, resolve } from "@std/path";
import { encodePng, newRaster } from "@shmupx/shmup-harbor/png";
import {
  byProject,
  decodeTileSheet,
  extractFile,
  parseDddImage,
  readDirectory,
  summarizeDddImage,
} from "../../packages/shmup-engine/src/n64/index.js";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const USAGE = `usage:
  n64:probe ls <ddd>
  n64:probe get <ddd> <NAME.EXT> --out <path>
  n64:probe report <ddd> [--stats] [--out <dir>]
  n64:probe png <ddd> <NAME.EXT> --out <path> [--columns N]
  n64:probe all <ddd> --out <dir>

  --out       where to write; a directory for report/all, a file otherwise
  --stats     entropy and 0x00/0xFF share per region (walks all 64 MB)
  --columns   tiles per row in a png contact sheet (default 20)`;

const args = [...Deno.args];
const command = args.shift();

if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const VALUE_FLAGS = new Set(["--out", "--columns"]);
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
  if (!path) fail(`a .ddd image is required\n\n${USAGE}`);
  try {
    return Deno.readFileSync(path);
  } catch (err) {
    return fail(`${path}: ${err instanceof Error ? err.message : err}`);
  }
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

async function renderPng(data: Uint8Array, path: string, columns: number) {
  const sheet = decodeTileSheet(data, { columns });
  if (sheet.tiles === 0) {
    fail("that file holds no whole 64x32 tiles, so it is not a graphics sheet");
  }
  const raster = newRaster(sheet.width, sheet.height);
  raster.data.set(sheet.data);
  await write(path, await encodePng(raster));
}

if (command === "ls") {
  const bytes = load(positional[0]);
  const parsed = parseDddImage(bytes);
  if (!parsed.directory) {
    fail("no ATNFS directory found; is this a Dezaemon 3D data disk?");
  }
  console.log(listing(parsed.directory));
} else if (command === "get") {
  const bytes = load(positional[0]);
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
  const bytes = load(positional[0]);
  const parsed = parseDddImage(bytes, { stats: flags["--stats"] === true });
  const text = [summarizeDddImage(parsed), "", listing(parsed.directory ?? [])]
    .join("\n");
  console.log(text);
  const out = flags["--out"];
  if (typeof out === "string") {
    await write(`${out}/report.txt`, `${text}\n`);
    await write(`${out}/report.json`, `${JSON.stringify(parsed, null, 2)}\n`);
  }
} else if (command === "png") {
  const bytes = load(positional[0]);
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
  const bytes = load(positional[0]);
  const out = need("--out");
  const parsed = parseDddImage(bytes, { stats: true });
  if (!parsed.directory) {
    fail("no ATNFS directory found; is this a Dezaemon 3D data disk?");
  }
  const text = [summarizeDddImage(parsed), "", listing(parsed.directory)].join(
    "\n",
  );
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
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
