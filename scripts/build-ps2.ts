// scripts/build-ps2.ts — package a level as a PlayStation 2 game.
//
//   deno task build:ps2                     → the base game shipped in the repo
//   deno task build:ps2 "Master Arena Mod"  → that Firebase level
//
// Both produce build/ps2/<level name>/ holding two ways to run it: a folder
// with athena.elf + main.js + assets to copy onto a USB stick, and a bootable
// .iso of the same tree. lib/ps2/build.ts does the work; this is argument
// parsing and the summary.
//
// Flags:
//   --out <dir>          write somewhere other than build/ps2
//   --level-file <path>  read the level from a local JSON export, not Firebase
//   --athena-elf <path>  use this AthenaEnv build instead of downloading one
//   --refresh-athena     re-download AthenaEnv even if it is cached
//   --atlas-max <px>     cap generated atlases at this size (default 512)
//   --no-iso             stop after the folder build

import { dirname, fromFileUrl, relative, resolve } from "@std/path";
import { buildPs2 } from "../lib/ps2/build.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

const VALUE_FLAGS = new Set([
  "--out",
  "--level-file",
  "--athena-elf",
  "--atlas-max",
]);

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      flags[arg] = value;
    } else if (arg === "--refresh-athena" || arg === "--no-iso") {
      flags[arg] = true;
    } else {
      fail(`unknown flag ${arg}`);
    }
  }
  if (positional.length > 1) {
    fail(
      `expected at most one level name, got ${positional.length}. ` +
        `Quote names that contain spaces: deno task build:ps2 "My Game"`,
    );
  }
  return { level: positional[0] ?? null, flags };
}

const { level, flags } = parse(Deno.args);

const atlasMax = flags["--atlas-max"];
if (atlasMax !== undefined && !/^\d+$/.test(String(atlasMax))) {
  fail(`--atlas-max must be a number of pixels, got "${atlasMax}"`);
}

try {
  const result = await buildPs2({
    root: ROOT,
    levelName: level,
    levelFile: typeof flags["--level-file"] === "string"
      ? flags["--level-file"]
      : null,
    outDir: typeof flags["--out"] === "string" ? flags["--out"] : null,
    athenaElf: typeof flags["--athena-elf"] === "string"
      ? flags["--athena-elf"]
      : null,
    refreshAthena: flags["--refresh-athena"] === true,
    maxSheet: atlasMax === undefined ? undefined : Number(atlasMax),
    skipIso: flags["--no-iso"] === true,
  });

  const here = (path: string) => relative(ROOT, path) || path;
  console.log("\nDone.");
  console.log(`  folder : ${here(result.appDir)}/`);
  if (result.isoPath) console.log(`  disc   : ${here(result.isoPath)}`);
  console.log(`  notes  : ${here(result.dir)}/README.txt`);
} catch (error) {
  fail((error as Error).message);
}
