// deno task build:ps2 — package one level as a PlayStation 2 game.
//
// Two artifacts come out of a build, because there are two ways to run PS2
// homebrew: a folder you copy to a USB stick (athena.elf + main.js + assets,
// launched from wLaunchELF/OPL) and a bootable ISO of the same tree (for a
// disc, for PCSX2, or for the launcher's own in-browser PS2 player).
//
// The game code is 5velte-ps2's AthenaEnv port of this very shooter, bundled
// from JSR by `deno bundle` into the single main.js that AthenaEnv's QuickJS
// evaluates on boot. Everything else here is data: the level record becomes
// console-sized atlases and a level.json (lib/ps2/assets.ts).

import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { resolveAthenaElf } from "./athena.ts";
import { type LevelRecord, stageAssets, type StagedFile } from "./assets.ts";
import { buildIso } from "./iso9660.ts";

const FIREBASE_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

// AthenaEnv reads this beside the ELF (or as cdrom0:ATHENA.INI;1 on a disc).
// The boot logo is off so the game comes straight up, and audsrv stays
// unloaded because ps2-sp runs silent on hardware — see the README.
const ATHENA_INI = [
  "boot_logo = false",
  "dark_mode = true",
  'default_script = "main.js"',
  "audsrv = false",
  "",
].join("\n");

// What the PS2 boot ROM reads off the disc to find the executable.
const SYSTEM_CNF = [
  "BOOT2 = cdrom0:\\ATHENA.ELF;1",
  "VER = 1.00",
  "VMODE = NTSC",
  "",
].join("\r\n");

export interface BuildPs2Options {
  /** Repository root — where static/ and build/ live. */
  root: string;
  /** Firebase level to export. Omitted: the base game shipped in the repo. */
  levelName?: string | null;
  /** Read the level from this JSON file instead of Firebase. */
  levelFile?: string | null;
  /** Defaults to <root>/build/ps2. */
  outDir?: string | null;
  /** Use this athena.elf rather than downloading the AthenaEnv release. */
  athenaElf?: string | null;
  /** Re-download AthenaEnv even if the cache has it. */
  refreshAthena?: boolean;
  /** Cap on either dimension of a generated atlas (default 512). */
  maxSheet?: number;
  /** Skip the ISO and produce only the folder build. */
  skipIso?: boolean;
  log?: (message: string) => void;
}

export interface BuildPs2Result {
  /** The level's display name. */
  name: string;
  /** Folder holding both artifacts. */
  dir: string;
  /** The athena.elf build — copy this whole folder to a USB stick. */
  appDir: string;
  /** The disc image, unless --no-iso was passed. */
  isoPath: string | null;
  artifacts: string[];
  notes: string[];
}

/** Strip what a filesystem (and the editor's own sanitiser) will not take. */
function safeName(name: string): string {
  return name.replace(/[.#$/\[\]]/g, "_").replace(/[^\w \-]/g, "").trim()
    .slice(0, 64) || "level";
}

/** CamelCase, alphanumeric: the folder and ISO basename inside the export. */
function appName(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "Level";
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("")
    .slice(0, 30);
}

async function loadRecord(
  options: BuildPs2Options,
  log: (message: string) => void,
): Promise<{ record: LevelRecord; fallbackName: string }> {
  if (options.levelFile) {
    log(`  level from file: ${options.levelFile}`);
    const record = JSON.parse(
      await Deno.readTextFile(options.levelFile),
    ) as LevelRecord;
    return { record, fallbackName: record.name?.trim() || "shmupX" };
  }
  if (options.levelName) {
    const url = `${FIREBASE_DB}/levels/${
      encodeURIComponent(options.levelName)
    }.json`;
    log(`  level from Firebase: ${options.levelName}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not read the level (HTTP ${response.status})`);
    }
    const record = await response.json() as LevelRecord | null;
    if (!record || !record.enemylist) {
      throw new Error(`level "${options.levelName}" not found`);
    }
    return { record, fallbackName: options.levelName };
  }
  // No name: the game the repo already ships, so `deno task build:ps2` on a
  // fresh checkout produces something playable without touching the network.
  const path = join(options.root, "static", "games", "2028-ai", "foo.json");
  log(`  level from the bundled base game: ${path}`);
  // The bundled record's own name is an internal one ("foo"); the artifact
  // this produces is the launcher's game, so call it that.
  return {
    record: JSON.parse(await Deno.readTextFile(path)),
    fallbackName: "shmupX",
  };
}

/**
 * Bundle lib/ps2/runtime-entry.ts (and the JSR game it pulls in) into the
 * single main.js AthenaEnv evaluates. The result depends only on the entry and
 * the pinned dependency, so it is cached and reused across level builds.
 */
async function bundleRuntime(
  root: string,
  cacheDir: string,
  log: (message: string) => void,
): Promise<Uint8Array> {
  const entry = join(root, "lib", "ps2", "runtime-entry.ts");
  const out = join(cacheDir, "main.js");
  const stamp = join(cacheDir, "main.js.key");
  const key = [
    await Deno.readTextFile(entry),
    await Deno.readTextFile(join(root, "deno.json")),
  ].join("\n");

  try {
    if (await Deno.readTextFile(stamp) === key) {
      log("  runtime: reusing the cached bundle");
      return await Deno.readFile(out);
    }
  } catch {
    // No usable cache — fall through and bundle.
  }

  await ensureDir(cacheDir);
  log("  runtime: bundling 5velte-ps2 for QuickJS");
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--quiet",
      // The console has no Node built-ins; "browser" keeps the bundler from
      // resolving any away.
      "--platform=browser",
      "--format=esm",
      "--output",
      out,
      entry,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  });
  let result: Deno.CommandOutput;
  try {
    result = await command.output();
  } catch (error) {
    throw new Error(
      `could not run \`deno bundle\` (${(error as Error).message}). The PS2 ` +
        `export needs the Deno CLI on PATH the first time it runs; after that ` +
        `the bundle is cached in ${cacheDir}.`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `deno bundle failed:\n${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  const bytes = await Deno.readFile(out);
  await Deno.writeTextFile(stamp, key);
  return bytes;
}

async function writeTree(dir: string, files: StagedFile[]): Promise<void> {
  for (const file of files) {
    const target = join(dir, file.path);
    await ensureDir(dirname(target));
    await Deno.writeFile(target, file.data);
  }
}

export async function buildPs2(
  options: BuildPs2Options,
): Promise<BuildPs2Result> {
  const log = options.log ?? ((message: string) => console.log(message));
  const root = resolve(options.root);
  const gameDir = join(root, "static", "games", "2028-ai");
  const cacheDir = join(root, "build", "ps2", ".cache");

  const { record, fallbackName } = await loadRecord(options, log);
  const name = safeName(options.levelName ?? fallbackName);
  const app = appName(name);
  const outRoot = options.outDir
    ? resolve(options.outDir)
    : join(root, "build", "ps2");
  const dir = join(outRoot, name);
  const appDir = join(dir, app);

  log(`Level  : ${name}`);
  log(`Output : ${dir}`);

  const mainJs = await bundleRuntime(root, cacheDir, log);
  log(`  runtime: main.js is ${(mainJs.length / 1024).toFixed(0)}KB`);

  const athena = await resolveAthenaElf({
    cacheDir,
    elfPath: options.athenaElf ?? null,
    refresh: options.refreshAthena,
  });
  log(
    `  athena.elf: ${
      (athena.bytes.length / 1048576).toFixed(1)
    }MB from ${athena.source}`,
  );

  log("  staging assets…");
  const staged = await stageAssets({
    gameDir,
    record,
    maxSheet: options.maxSheet,
  });
  for (const note of staged.notes) log(`    ${note}`);

  const encoder = new TextEncoder();
  const payload: StagedFile[] = [
    { path: "SYSTEM.CNF", data: encoder.encode(SYSTEM_CNF) },
    { path: "athena.elf", data: athena.bytes },
    { path: "athena.ini", data: encoder.encode(ATHENA_INI) },
    { path: "main.js", data: mainJs },
    ...staged.files,
  ];

  await Deno.remove(appDir, { recursive: true }).catch(() => {});
  await ensureDir(appDir);
  await writeTree(appDir, payload);

  const artifacts = [appDir];
  let isoPath: string | null = null;
  if (!options.skipIso) {
    log("  writing the disc image…");
    const iso = buildIso({
      volumeId: app,
      files: payload,
      // Fixed, so rebuilding the same level yields the same image.
      date: new Date("2000-03-04T00:00:00Z"),
    });
    isoPath = join(dir, `${app}.iso`);
    await Deno.writeFile(isoPath, iso);
    artifacts.push(isoPath);
    log(`  iso: ${(iso.length / 1048576).toFixed(1)}MB`);
  }

  await Deno.writeTextFile(
    join(dir, "README.txt"),
    readme(name, app, isoPath !== null),
  );

  return { name, dir, appDir, isoPath, artifacts, notes: staged.notes };
}

function readme(name: string, app: string, hasIso: boolean): string {
  return [
    `${name} — PlayStation 2 build`,
    "",
    `${app}/`,
    "    The AthenaEnv build. Copy the whole folder to a USB stick (or a",
    "    memory card, or an internal HDD partition) and launch",
    `    ${app}/athena.elf from wLaunchELF, OPL or FMCB. athena.elf is the`,
    "    interpreter; main.js is the game; assets/ is this level.",
    "",
    ...(hasIso
      ? [
        `${app}.iso`,
        "    The same tree as a bootable disc. Runs in PCSX2 and in the",
        "    launcher's own in-browser PS2 player; burning it for real",
        "    hardware needs a modchip or FMCB, as with any homebrew disc.",
        "",
      ]
      : []),
    "Controls: D-pad or left stick to move, Cross to fire, Start to pause.",
    "",
    "Rebuild with:  deno task build:ps2 " + JSON.stringify(name),
    "",
  ].join("\n");
}
