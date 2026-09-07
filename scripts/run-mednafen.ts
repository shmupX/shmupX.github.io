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
// The Mednafen binary, the disc image and the BIOS are the user's own (the disc
// and BIOS are community content, never in the repo), so their locations come
// from flags or env vars — the launcher prints what it resolved and fails with
// a clear message when something is missing:
//
//   MEDNAFEN_BIN            path to the mednafen executable (else found on PATH;
//                           on Windows give a full path so the save dir resolves)
//   DEZAEMON_DISC           the .cue / .m3u disc image (required; a few common
//                           spots are auto-probed when unset)
//   MEDNAFEN_SAV            the Mednafen save directory (default: <base>/sav,
//                           base = the exe dir on Windows, else $MEDNAFEN_HOME or
//                           ~/.mednafen)
//   MEDNAFEN_LD_LIBRARY_PATH prepended to LD_LIBRARY_PATH for the child (for a
//                           Mednafen unpacked outside the system libs, as on WSL)
//
// Mednafen is launched with `-filesys.fname_sav %f.%x`, so the save file is
// named after the disc (<disc-basename>.bcr/.bkr) regardless of the user's
// mednafen.cfg — that is the name written here. An existing .bcr is backed up
// to <sav>/backup/ first (parity with the .bat's install-cart.ps1). Close
// Mednafen before running: it rewrites its save files on exit.

import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  CART_PARTITION_SIZE,
  INTERNAL_PARTITION_SIZE,
  normalize,
} from "../packages/shmup-engine/mod.js";
import { buildSav } from "./build-sav.ts";

const IS_WINDOWS = Deno.build.os === "windows";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

function home(): string {
  return (IS_WINDOWS ? Deno.env.get("USERPROFILE") : Deno.env.get("HOME")) ||
    ".";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The MiSTer-layout .sav → Mednafen's cart (.bcr, gzip of the 512 KB cart) and
 * internal RAM (.bkr, raw 32 KB), the shape Mednafen reads and writes. */
async function toMednafenPair(sav: Uint8Array) {
  const { data } = await normalize(sav);
  const expected = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;
  if (data.length !== expected) {
    fail(
      `the .sav normalizes to ${data.length} bytes, expected ${expected} ` +
        `(32 KB internal + 512 KB cart)`,
    );
  }
  const cart = data.subarray(INTERNAL_PARTITION_SIZE);
  const bcr = new Uint8Array(
    await new Response(
      new Blob([cart]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  return { bcr, bkr: data.subarray(0, INTERNAL_PARTITION_SIZE) };
}

/** The disc image: --disc, then DEZAEMON_DISC, then a few common spots. */
async function findDisc(flag: string | null): Promise<string> {
  const candidates = [
    flag,
    Deno.env.get("DEZAEMON_DISC"),
    join(home(), "saturn", "Dezaemon 2 (Japan)", "Dezaemon 2 (Japan).cue"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (await exists(c)) return resolve(c);
  }
  // last resort: any .cue beside the auto-probed disc folder
  const dir = join(home(), "saturn", "Dezaemon 2 (Japan)");
  if (await exists(dir)) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.toLowerCase().endsWith(".cue")) {
        return join(dir, e.name);
      }
    }
  }
  fail(
    "no disc image found. Set DEZAEMON_DISC=/path/to/'Dezaemon 2 (Japan).cue' " +
      "(or pass --disc PATH). The disc is community content and is not in the repo.",
  );
}

/** The Mednafen executable: --bin, then MEDNAFEN_BIN, else the PATH name. */
function findBin(flag: string | null): string {
  return flag || Deno.env.get("MEDNAFEN_BIN") ||
    (IS_WINDOWS ? "mednafen.exe" : "mednafen");
}

/** Running a Windows mednafen.exe from WSL, via binfmt interop — the way a WSL
 * user reaches the Windows Mednafen (the only one that sees a USB/Bluetooth pad,
 * e.g. a Stadia controller; WSL exposes no /dev/input). Path arguments handed to
 * the .exe must be Windows paths, and it lays its saves out portably (beside the
 * exe) like a native Windows install. */
function isWslExe(bin: string): boolean {
  return !IS_WINDOWS && /\.exe$/i.test(bin);
}

/** Translate a WSL path to the Windows form a Windows .exe understands. */
function toWinPath(p: string): string {
  try {
    const { stdout, success } = new Deno.Command("wslpath", {
      args: ["-w", p],
    }).outputSync();
    if (success) return new TextDecoder().decode(stdout).trim();
  } catch { /* fall through */ }
  return p;
}

/** Mednafen's save directory: --sav-dir, then MEDNAFEN_SAV, else <base>/sav. */
function savDir(flag: string | null, bin: string): string {
  const explicit = flag || Deno.env.get("MEDNAFEN_SAV");
  if (explicit) return resolve(explicit);
  const portable = IS_WINDOWS || isWslExe(bin); // Windows Mednafen keeps saves beside the exe
  const base = portable
    ? dirname(bin)
    : (Deno.env.get("MEDNAFEN_HOME") || join(home(), ".mednafen"));
  if (portable && (base === "." || !base)) {
    fail(
      "cannot tell where Mednafen keeps saves. Give MEDNAFEN_BIN a full path to " +
        "mednafen.exe, or set MEDNAFEN_SAV to the sav directory.",
    );
  }
  return resolve(join(base, "sav"));
}

function baseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() || path;
  return file.replace(/\.[^.]+$/, "");
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
  const disc = await findDisc(discFlag);
  const dir = savDir(savDirFlag, bin);
  const name = baseName(disc);
  console.log(`mednafen : ${bin}`);
  console.log(`disc     : ${disc}`);
  console.log(`save dir : ${dir}  (as "${name}.bcr" / ".bkr")`);

  // 3. convert and seed, backing up any existing cart first.
  const { bcr, bkr } = await toMednafenPair(await Deno.readFile(savPath));
  await ensureDir(dir);
  const bcrPath = join(dir, `${name}.bcr`);
  if (await exists(bcrPath)) {
    const backup = join(dir, "backup");
    await ensureDir(backup);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Deno.copyFile(bcrPath, join(backup, `${name}.${stamp}.bcr`));
    console.log(`backed up the old cart to backup/${name}.${stamp}.bcr`);
  }
  await Deno.writeFile(bcrPath, bcr);
  await Deno.writeFile(join(dir, `${name}.bkr`), bkr);
  console.log(
    `seeded the cart save (${bcr.length} B cart, ${bkr.length} B internal)`,
  );

  if (installOnly) {
    console.log("--install-only: not launching Mednafen.");
    return;
  }

  // 4. launch. Force the save name to match the disc, whatever the cfg says.
  const env: Record<string, string> = {};
  const extraLib = Deno.env.get("MEDNAFEN_LD_LIBRARY_PATH");
  if (extraLib && !IS_WINDOWS) {
    const cur = Deno.env.get("LD_LIBRARY_PATH");
    env.LD_LIBRARY_PATH = cur ? `${extraLib}:${cur}` : extraLib;
  }
  // A Windows .exe launched from WSL needs the disc as a Windows path.
  const discArg = isWslExe(bin) ? toWinPath(disc) : disc;
  const args = [
    "-filesys.fname_sav",
    "%f.%x",
    "-cd.image_memcache",
    "1",
    ...passThrough,
    discArg,
  ];
  console.log(`launching: ${bin} ${args.join(" ")}`);
  try {
    const command = new Deno.Command(bin, {
      args,
      env,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) console.error(`mednafen exited with code ${code}`);
    Deno.exit(code);
  } catch (e) {
    fail(
      `could not launch "${bin}": ${e instanceof Error ? e.message : e}. ` +
        `Set MEDNAFEN_BIN to the mednafen executable (or put it on PATH).`,
    );
  }
}

if (import.meta.main) await main();
