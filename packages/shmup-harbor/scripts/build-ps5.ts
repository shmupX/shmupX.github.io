// scripts/build-ps5.ts — package a level to run on a (jailbroken) PS5.
//
//   deno task build:ps5:iso squad                     → that Firebase level
//   deno task build:ps5:iso                           → the base game
//   deno task build:ps5:iso --sav "Dez 2 - Foo.sav"   → that Dezaemon 2 cart
//
// The result is build/ps5/<level name>/ holding a PS2 disc image with its own
// serial and the artwork a PS2 Classics packager turns into a PS4 package —
// see lib/ps5/build.ts for why, and the README.txt it writes for how to get
// it onto the console.
//
// Takes the same level and game flags as build:ps2 (see scripts/build-ps2.ts):
// --out, --level-file, --sav, --slot, --stage, --boss-rush[=n], --athena-elf,
// --refresh-athena, --atlas-max, --sndpac, --no-audio, --no-music, --uncapped,
// --game-fps, --cover, --sfx-budget. There is no --iso or --zip: the disc is
// the output.

import { relative } from "@std/path";
import { buildPs5 } from "../lib/ps5/build.ts";
import { parseBossRushFlag } from "../lib/boss-rush.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();

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
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name === "--boss-rush") {
      try {
        flags[name] = String(parseBossRushFlag(arg));
      } catch (error) {
        fail((error as Error).message);
      }
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`${name} needs a value`);
      flags[name] = value;
    } else if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) fail(`${name} takes no value`);
      flags[name] = true;
    } else if (name === "--iso" || name === "--zip") {
      fail(`${name} is a build:ps2 flag — build:ps5:iso always writes a disc`);
    } else {
      fail(`unknown flag ${name}`);
    }
  }
  if (positional.length > 1) {
    fail(
      `expected at most one level name, got ${positional.length}. ` +
        `Quote names that contain spaces: deno task build:ps5:iso "My Game"`,
    );
  }
  return { level: positional[0] ?? null, flags };
}

const { level, flags } = parse(Deno.args);
const text = (flag: string) =>
  typeof flags[flag] === "string" ? flags[flag] as string : null;

for (const flag of ["--atlas-max", "--slot", "--game-fps", "--sfx-budget"]) {
  const value = text(flag);
  if (value !== null && !/^\d+$/.test(value)) {
    fail(`${flag} must be a whole number, got "${value}"`);
  }
}
const savFile = text("--sav");
if (!savFile) {
  for (const flag of ["--slot", "--stage"]) {
    if (flags[flag] !== undefined) fail(`${flag} only applies with --sav`);
  }
}
if (savFile && text("--level-file") !== null) {
  fail("--sav and --level-file both name a level — pass one of them");
}

try {
  const result = await buildPs5({
    root: ROOT,
    levelName: level,
    levelFile: text("--level-file"),
    savFile,
    savSlot: text("--slot") === null ? null : Number(text("--slot")),
    stage: text("--stage"),
    bossRush: text("--boss-rush") === null ? null : Number(text("--boss-rush")),
    outDir: text("--out"),
    athenaElf: text("--athena-elf"),
    refreshAthena: flags["--refresh-athena"] === true,
    maxSheet: text("--atlas-max") === null
      ? undefined
      : Number(text("--atlas-max")),
    sndpac: text("--sndpac"),
    skipAudio: flags["--no-audio"] === true,
    skipMusic: flags["--no-music"] === true,
    uncapped: flags["--uncapped"] === true,
    cover: text("--cover"),
    gameFps: text("--game-fps") === null
      ? undefined
      : Number(text("--game-fps")),
    sfxBudgetBytes: text("--sfx-budget") === null
      ? undefined
      : Number(text("--sfx-budget")) * 1024,
  });

  const here = (path: string) => relative(ROOT, path) || path;
  console.log("\nDone.");
  console.log(`  disc    : ${here(result.isoPath)}`);
  console.log(`  artwork : ${here(result.dir)}/fpkg/`);
  console.log(`  serial  : ${result.serial}`);
  console.log(`  notes   : ${here(result.dir)}/README.txt`);
} catch (error) {
  fail((error as Error).message);
}
