// tools/deza-disc — look inside a Dezaemon 2 disc.
//
//   deno task deza:disc ls
//   deno task deza:disc get GAME.CMP --out build/GAME.bin
//   deno task deza:disc png EXT2_PIC.BIN --rows 0:224 --out build/shoki-settei.png
//
// The engine already knows how to open the disc (lib/disc-file.ts over
// packages/shmup-engine/src/cd/iso9660-read.js) and how to undo its LZSS
// (packages/shmup-engine/src/decompress.js). What was missing was a way to
// point those at an ARBITRARY file and look at the result — every existing
// caller asks for one thing it already knows the name and shape of
// (SNDPAC.BIN for the tone bank, MDLDT_NN.CMP for the part library).
//
// The disc itself is never committed. Drop an image in dev-fixtures/ (see
// README.md "PlayStation 2") and these commands find it; with nothing there
// they say so and exit 0, like the other disc tasks.

import { dirname, fromFileUrl, resolve } from "@std/path";
import { openDiscImages } from "../../lib/disc-file.ts";
import {
  listFiles,
  readFile,
} from "../../packages/shmup-engine/src/cd/iso9660-read.js";
import {
  decompress,
  decompressCmp,
} from "../../packages/shmup-engine/src/decompress.js";
import { encodePng, parsePalette, toGrey, toRgb, unpackPixels } from "./png.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..", "..");

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const USAGE = `usage:
  deza:disc ls [--all]
  deza:disc get <NAME> --out <path> [--plain|--lzss]
  deza:disc png <NAME> --out <path> [--width N] [--bpp 4|8]
                                    [--rows A:B] [--scale N]
                                    [--grey [--raw-palette]]

  --plain         write the file as stored, without undoing its LZSS
  --lzss          undo LZSS on a .BIN not in the known-compressed list
  --width         pixels per row (default 320 — the editor's screen width)
  --bpp           bits per pixel (default 8)
  --rows          half-open row range, e.g. 0:224 for one screen
  --scale         integer upscale, for reading small type
  --grey          ignore DEZA2.PAL and render greyscale
  --raw-palette   with --grey, use the stored index as the grey level instead
                  of spreading the region's own indices over 0-255`;

const args = [...Deno.args];
const command = args.shift();
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const VALUE_FLAGS = new Set(["--out", "--width", "--bpp", "--rows", "--scale"]);
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

const images = await openDiscImages(ROOT);
if (!images.length) {
  console.log(
    "[deza-disc] no disc image in dev-fixtures/ — drop a Dezaemon 2 disc " +
      "there to look inside it. Nothing to do.",
  );
  Deno.exit(0);
}
const { name: imageName, disc } = images[0];

/** ISO 9660 stores names with a ";1" version suffix; callers say "GAME.CMP". */
function bare(name: string): string {
  return name.split(";")[0];
}

// A .CMP is always LZSS and says so: its u32 LE header is the exact length of
// the stream that follows, which decompressCmp() checks. A .BIN carries no
// header and cannot be told apart from raw data by inspection — LZSS run over
// the SNDPAC.BIN sample bank does not fail, it "expands" 506 KB of samples
// into 1.6 MB of garbage. So the compressed .BIN files are listed instead.
// These are the editor's art and text, all confirmed by rendering them.
const LZSS_BIN = /(_PIC\.BIN|^HL_|^GFONT\.BIN|^CONP_OPT\.BIN)/i;

function isCompressed(name: string): boolean {
  const n = bare(name).toUpperCase();
  return n.endsWith(".CMP") || LZSS_BIN.test(n);
}

/** Undo the disc's LZSS, honouring the .CMP length header when there is one. */
function unpack(name: string, bytes: Uint8Array): Uint8Array {
  return bare(name).toUpperCase().endsWith(".CMP")
    ? decompressCmp(bytes)
    : decompress(bytes);
}

/**
 * What to do with a file, given the flags. Anything not known to be compressed
 * comes out as stored unless `--lzss` insists, so a raw sample bank is never
 * silently mangled.
 */
function resolve_(name: string, bytes: Uint8Array): {
  out: Uint8Array;
  how: string;
} {
  if (flags["--plain"]) return { out: bytes, how: "as stored" };
  if (flags["--lzss"] || isCompressed(name)) {
    return { out: unpack(name, bytes), how: "LZSS" };
  }
  return {
    out: bytes,
    how: "as stored (not known to be compressed — --lzss to force)",
  };
}

async function write(path: string, bytes: Uint8Array) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
}

function need(flag: string): string {
  const value = flags[flag];
  if (typeof value !== "string") fail(`${flag} is required`);
  return value;
}

function load(): { name: string; bytes: Uint8Array } {
  const name = positional[0];
  if (!name) fail("name a file — try `deza:disc ls`");
  const bytes = readFile(disc, name);
  if (!bytes) fail(`${name} is not on ${imageName}`);
  return { name, bytes };
}

if (command === "ls") {
  const entries = listFiles(disc)
    .filter((e: { isDir: boolean }) => !e.isDir)
    .sort((a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name)
    );
  // The 73 M_DATA and 25 DEMO files are bulk data; they drown the listing.
  const bulk = /^(M_DATA|DEMO_|MDLDT_|BACK\d)/;
  const shown = flags["--all"]
    ? entries
    : entries.filter((e: { name: string }) => !bulk.test(e.name));
  console.log(`${imageName}: ${entries.length} files`);
  for (const e of shown) {
    console.log(`  ${bare(e.name).padEnd(16)} ${String(e.size).padStart(9)}`);
  }
  if (shown.length !== entries.length) {
    console.log(`  … ${entries.length - shown.length} bulk files (--all)`);
  }
} else if (command === "get") {
  const { name, bytes } = load();
  const { out, how } = resolve_(name, bytes);
  const path = need("--out");
  await write(path, out);
  console.log(
    `${bare(name)}: ${bytes.length} bytes on disc -> ${out.length} ` +
      `${how} -> ${path}`,
  );
} else if (command === "png") {
  const { name, bytes } = load();
  const { out: data } = resolve_(name, bytes);
  const rows = typeof flags["--rows"] === "string"
    ? flags["--rows"].split(":")
    : [];
  const scale = Math.max(1, Number(flags["--scale"] ?? 1));
  const raster = unpackPixels(data, {
    width: Number(flags["--width"] ?? 320),
    bpp: Number(flags["--bpp"] ?? 8) === 4 ? 4 : 8,
    from: rows[0] ? Number(rows[0]) : undefined,
    to: rows[1] ? Number(rows[1]) : undefined,
  });

  // Real colour when the disc's palette is there and the caller wants it.
  const palBytes = flags["--grey"] ? null : readFile(disc, "DEZA2.PAL");
  const samples = palBytes
    ? toRgb(raster, parsePalette(palBytes), scale)
    : toGrey(raster, !flags["--raw-palette"], scale);

  const path = need("--out");
  await write(
    path,
    await encodePng(raster.width * scale, raster.height * scale, samples),
  );
  console.log(
    `${bare(name)}: ${raster.width * scale}x${raster.height * scale} ` +
      `(${raster.distinct} palette indices, ` +
      `${palBytes ? "DEZA2.PAL colour" : "greyscale"}) -> ${path}`,
  );
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
