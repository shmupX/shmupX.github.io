// scripts/build-ps2.ts — package a level as a PlayStation 2 game.
//
//   deno task build:ps2                          → the base game in the repo
//   deno task build:ps2 "Master Arena Mod"       → that Firebase level
//   deno task build:ps2 --sav "Dez 2 - Foo.sav"  → that Dezaemon 2 cart
//
// The result is build/ps2/<level name>/ holding the folder to copy onto a USB
// stick (athena.elf + main.js + assets), plus whichever of the two single-file
// forms was asked for: `--zip` swaps that folder for an archive of it and
// `--iso` adds a bootable disc image. lib/ps2/build.ts does the work; this is
// argument parsing and the summary.
//
// The three sibling tasks are this one with an output flag pre-set:
//
//   deno task build:ps2:zip "Chohsoku Stringer" --sav="./Dez 2 - Chohsoku Stringer.sav"
//   deno task build:ps2:iso --sav="./Dez 2 - Chohsoku Stringer.sav"
//
// — the second showing that the name is optional: leave it off and the save's
// filename supplies it ("Dez 2 - Chohsoku Stringer.sav" -> "Chohsoku Stringer",
// the same title the shelf gives it).
//
// Flags:
//   --out <dir>          write somewhere other than build/ps2
//   --level-file <path>  read the level from a local JSON export, not Firebase
//   --sav <path>         read the level from a Dezaemon 2 .sav instead
//   --slot <n>           which game in a .sav that holds more than one
//   --stage <n>          which of the save's stages to export (the console
//                        runs one; default: the first with anything on it)
//   --athena-elf <path>  use this AthenaEnv build instead of downloading one
//   --refresh-athena     re-download AthenaEnv even if it is cached
//   --atlas-max <px>     cap generated atlases at this size (default 512)
//   --sndpac <path>      render the tone bank from this SNDPAC.BIN
//   --no-audio           build silent even when a sound bank is available
//   --no-music           keep the effects, drop the streamed music
//   --uncapped           unlock the frame rate and show the frame counter
//   --game-fps <n>       logic steps per second (default 120; the port's is 30)
//   --cover <slug|png>   use this shelf title-screen shot as the title screen
//   --sfx-budget <KB>    how much IOP RAM the effects may use (default 1024)
//   --iso                also write a disc image (the folder is the default)
//   --zip                write the folder as one .zip instead of as a folder

import { dirname, fromFileUrl, relative, resolve } from "@std/path";
import { buildPs2 } from "../lib/ps2/build.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

const VALUE_FLAGS = new Set([
  "--cover",
  "--sfx-budget",
  "--game-fps",
  "--out",
  "--level-file",
  "--sav",
  "--slot",
  "--stage",
  "--athena-elf",
  "--atlas-max",
  "--sndpac",
]);

const BOOL_FLAGS = new Set([
  "--refresh-athena",
  "--iso",
  "--zip",
  "--no-audio",
  "--no-music",
  "--uncapped",
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
    if (arg === "--") {
      // `deno task build:ps2 -- --uncapped` passes the separator through.
      continue;
    }
    // Both spellings, because a path with spaces reads better attached:
    // --sav="./Dez 2 - Chohsoku Stringer.sav".
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`${name} needs a value`);
      flags[name] = value;
    } else if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) fail(`${name} takes no value`);
      flags[name] = true;
    } else {
      fail(`unknown flag ${name}`);
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

const savFile = typeof flags["--sav"] === "string" ? flags["--sav"] : null;
const slot = flags["--slot"];
if (slot !== undefined && !/^\d+$/.test(String(slot))) {
  fail(`--slot must be a save number, got "${slot}"`);
}
if (!savFile) {
  for (const flag of ["--slot", "--stage"]) {
    if (flags[flag] !== undefined) fail(`${flag} only applies with --sav`);
  }
}
if (savFile && flags["--level-file"] !== undefined) {
  fail("--sav and --level-file both name a level — pass one of them");
}

try {
  const result = await buildPs2({
    root: ROOT,
    levelName: level,
    levelFile: typeof flags["--level-file"] === "string"
      ? flags["--level-file"]
      : null,
    savFile,
    savSlot: slot === undefined ? null : Number(slot),
    stage: typeof flags["--stage"] === "string" ? flags["--stage"] : null,
    outDir: typeof flags["--out"] === "string" ? flags["--out"] : null,
    athenaElf: typeof flags["--athena-elf"] === "string"
      ? flags["--athena-elf"]
      : null,
    refreshAthena: flags["--refresh-athena"] === true,
    maxSheet: atlasMax === undefined ? undefined : Number(atlasMax),
    iso: flags["--iso"] === true,
    zip: flags["--zip"] === true,
    sndpac: typeof flags["--sndpac"] === "string" ? flags["--sndpac"] : null,
    skipAudio: flags["--no-audio"] === true,
    skipMusic: flags["--no-music"] === true,
    uncapped: flags["--uncapped"] === true,
    cover: typeof flags["--cover"] === "string" ? flags["--cover"] : null,
    gameFps: typeof flags["--game-fps"] === "string"
      ? Number(flags["--game-fps"])
      : undefined,
    sfxBudgetBytes: typeof flags["--sfx-budget"] === "string"
      ? Number(flags["--sfx-budget"]) * 1024
      : undefined,
  });

  const here = (path: string) => relative(ROOT, path) || path;
  console.log("\nDone.");
  if (result.appDir) console.log(`  folder : ${here(result.appDir)}/`);
  if (result.zipPath) console.log(`  zip    : ${here(result.zipPath)}`);
  if (result.isoPath) console.log(`  disc   : ${here(result.isoPath)}`);
  console.log(`  notes  : ${here(result.dir)}/README.txt`);
} catch (error) {
  fail((error as Error).message);
}
