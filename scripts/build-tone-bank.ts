// scripts/build-tone-bank.ts — cut the Dezaemon 2 tone bank out of SNDPAC.BIN.
//
//   deno task deza:tonebank                  → find the bank, cache it, report
//   deno task deza:tonebank --out build/tonebank
//   deno task deza:tonebank --sndpac path/to/SNDPAC.BIN
//
// SNDPAC.BIN is disc content and is never committed. The bank is found in
// dev-fixtures/ (gitignored): a bare SNDPAC.BIN, or any disc image the ISO
// 9660 reader can pull one out of. Finding nothing is not an error — the task
// says so and exits 0, and every consumer falls back to its synthesised
// voices.
//
// With --out it also writes the PS2 pack (audsrv .adp per sample, plus
// tonebank.json and .wav twins). `deno task build:ps2` does this itself; the
// flag is for inspecting the render without building a disc.
//
// Flags:
//   --sndpac <path>  use this bank instead of searching dev-fixtures/
//   --out <dir>      also render the PS2 pack here
//   --no-cache       skip writing dev-fixtures/.cache/SNDPAC.BIN

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  buildToneBankPack,
  cacheSndpac,
  findSndpac,
} from "../lib/ps2/tone-bank-pack.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const VALUE_FLAGS = new Set(["--sndpac", "--out"]);

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const flags: Record<string, string | true> = {};
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (VALUE_FLAGS.has(arg)) {
    const value = Deno.args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    flags[arg] = value;
  } else if (arg === "--no-cache") {
    flags[arg] = true;
  } else {
    fail(`unknown argument ${arg}`);
  }
}

const source = await findSndpac(
  ROOT,
  typeof flags["--sndpac"] === "string" ? flags["--sndpac"] : null,
);

if (!source) {
  console.log(
    "[tonebank] no SNDPAC.BIN found — drop a Dezaemon 2 disc image (or the " +
      "bank itself) into dev-fixtures/ to render the real Saturn timbres. " +
      "Nothing to do.",
  );
  Deno.exit(0);
}

console.log(
  `[tonebank] bank: ${
    relative(ROOT, source.from) || source.from
  } (${source.bytes.length} bytes)`,
);
if (flags["--no-cache"] !== true) await cacheSndpac(ROOT, source.bytes);

const outFlag = flags["--out"];
if (typeof outFlag !== "string") {
  console.log("[tonebank] cached. Pass --out <dir> to render the PS2 pack.");
  Deno.exit(0);
}

const pack = buildToneBankPack(source.bytes);
const outDir = resolve(ROOT, outFlag);
for (const file of [...pack.files, ...pack.wavFiles]) {
  const target = join(outDir, file.path);
  await ensureDir(dirname(target));
  await Deno.writeFile(target, file.data);
}
for (const note of pack.notes) console.log(`[tonebank] ${note}`);
console.log(
  `[tonebank] wrote ${pack.files.length + pack.wavFiles.length} files to ${
    relative(ROOT, outDir) || outDir
  }/`,
);
