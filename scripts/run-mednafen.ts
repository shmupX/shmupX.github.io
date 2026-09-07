// Launch Mednafen with a level preloaded as the Saturn cartridge save — the
// cross-platform, in-repo equivalent of the ad-hoc dezaemon2.sh / "Dezaemon 2.bat"
// launchers. It builds the level's .sav (scripts/build-sav.ts), converts it to
// Mednafen's <disc>.bcr/.bkr save pair (the same de-interleave + gzip the
// dev-fixtures/debug-tools/sav-to-mednafen.ts converter does), drops it in
// Mednafen's save directory under the disc's name, then starts Mednafen on the
// disc. Runs the platform's own Mednafen: native Windows Deno launches
// mednafen.exe, Linux/macOS Deno launches mednafen.
//
//   deno task sav:run                      # level "foo", auto-detected paths
//   deno task sav:run air-streamer         # a different cloud level or JSON file
//   deno task sav:run --install-only       # seed the cart save, do not launch
//   deno task sav:run -- -sound 0          # pass extra args straight to Mednafen
//
// From WSL, point MEDNAFEN_BIN at a mednafen.exe to launch the Windows Mednafen
// over interop — the only one that sees a USB/Bluetooth pad (e.g. a Stadia
// controller); WSL exposes no /dev/input. The disc path is translated with
// wslpath, and saves land beside the exe:
//   MEDNAFEN_BIN=/mnt/c/.../mednafen.exe \
//   DEZAEMON_DISC=/mnt/c/.../'Dezaemon 2 (Japan).cue' deno task sav:run
//
// The resolution of the binary, disc and save directory (MEDNAFEN_BIN,
// DEZAEMON_DISC, MEDNAFEN_SAV, MEDNAFEN_LD_LIBRARY_PATH), the conversion and
// the launch live in lib/mednafen.ts, shared with POST /api/saturn-save (the
// editor's "→ MEDNAFEN CART" row). This file is the command line around them:
// it prints what was resolved and fails with a clear message when something is
// missing. Close Mednafen before running: it rewrites its save files on exit.

import { resolve } from "@std/path";
import {
  baseName,
  findBin,
  findDisc,
  installCartSave,
  launchMednafen,
  MednafenError,
  NO_DISC_MESSAGE,
  savDirFor,
} from "../lib/mednafen.ts";
import { buildSav } from "./build-sav.ts";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const argv = Deno.args.slice();
  const passThrough: string[] = [];
  const sep = argv.indexOf("--");
  if (sep !== -1) passThrough.push(...argv.splice(sep).slice(1));

  let level: string | null = null;
  let palette: "saturn" | "snes" = "saturn";
  let discFlag: string | null = null, binFlag: string | null = null;
  let savDirFlag: string | null = null, savFile: string | null = null;
  let installOnly = false, build = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install-only") installOnly = true;
    else if (a === "--no-build") build = false;
    else if (a === "--palette") palette = argv[++i] as "saturn" | "snes";
    else if (a === "--disc") discFlag = argv[++i];
    else if (a === "--bin") binFlag = argv[++i];
    else if (a === "--sav-dir") savDirFlag = argv[++i];
    else if (a === "--sav") {
      savFile = argv[++i];
      build = false;
    } else if (a.startsWith("-")) fail(`unknown flag ${a}`);
    else level = a;
  }

  // 1. the .sav — build it (default) or take an existing one.
  let savPath: string;
  if (savFile) {
    savPath = resolve(savFile);
    if (!(await exists(savPath))) fail(`no such .sav: ${savPath}`);
  } else if (build) {
    const res = await buildSav({ level, palette });
    savPath = res.outPath;
    console.log(`built ${res.fileName} (${res.bytes} bytes)`);
  } else {
    fail("--no-build needs --sav PATH to point at an existing .sav");
  }

  // 2. resolve the environment.
  const bin = findBin(binFlag);
  const disc = (await findDisc(discFlag)) ?? fail(NO_DISC_MESSAGE);
  let dir: string;
  try {
    dir = savDirFor(savDirFlag, bin);
  } catch (e) {
    fail((e as Error).message);
  }
  const name = baseName(disc);
  console.log(`mednafen : ${bin}`);
  console.log(`disc     : ${disc}`);
  console.log(`save dir : ${dir}  (as "${name}.bcr" / ".bkr")`);

  // 3. convert and seed, backing up any existing cart first.
  let installed;
  try {
    installed = await installCartSave(await Deno.readFile(savPath), {
      savDir: dir,
      name,
    });
  } catch (e) {
    if (e instanceof MednafenError) fail(e.message);
    throw e;
  }
  if (installed.backupPath) {
    console.log(
      `backed up the old cart to backup/${
        installed.backupPath.replace(/\\/g, "/").split("/").pop()
      }`,
    );
  }
  console.log(
    `seeded the cart save (${installed.bcrBytes} B cart, ${installed.bkrBytes} B internal)`,
  );

  if (installOnly) {
    console.log("--install-only: not launching Mednafen.");
    return;
  }

  // 4. launch, and exit with Mednafen's own code once it quits.
  try {
    const { code } = await launchMednafen({ bin, disc }, {
      passThrough,
      wait: true,
      onLaunch: (args) => console.log(`launching: ${bin} ${args.join(" ")}`),
    });
    if (code !== 0) console.error(`mednafen exited with code ${code}`);
    Deno.exit(code ?? 0);
  } catch (e) {
    if (e instanceof MednafenError) fail(e.message);
    throw e;
  }
}

if (import.meta.main) await main();
