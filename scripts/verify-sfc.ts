#!/usr/bin/env -S deno run -A
/**
 * `deno task sfc:verify` — prove that a Super Famicom Dezaemon save runs.
 *
 *   deno task sfc:verify "build/sfc/Dezaemon SFC - foo.srm"
 *   deno task sfc:verify foo.srm --out build/sfc-verify/foo --play-frames 1200
 *   deno task sfc:verify foo.srm --static-only        # no emulator: the file alone
 *   deno task sfc:verify foo.srm --json               # the verdict as JSON on stdout
 *
 * Why an emulator at all. The writer reads its image back and verifies the
 * seventeen checksum words before it leaves, and every one of those checks
 * passes on a save the ROM then formats over at boot, or plays as a black
 * screen with the factory ship. The ROM is the only reader whose opinion
 * counts, so this boots the real cart in Mesen's headless test runner with
 * the save underneath, presses GAME PLAY and GAME START, lets a stage run,
 * and reads the console: the SRAM against the file, CGRAM for the save's
 * palette rows, VRAM for its tiles, and three screenshots for a human
 * (scripts/lib/sfc-verify.ts has the whole method; lib/sfc-mesen.ts the
 * emulator).
 *
 * Needs Mesen 2 (the macOS bundle in /Applications, $MESEN_BIN, or `mesen`
 * on PATH) and the Dezaemon ROM (dev-fixtures/, $DEZAEMON_SFC_ROM, or
 * --rom). Mesen's battery slot for the ROM is backed up and restored around
 * the run. Exit 0 when the save plays, 1 when it does not, 2 when the check
 * could not run.
 */

import { basename, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { findDezaemonSfcRom, readDezaemonSfcRom } from "../lib/dezaemon-sfc.ts";
import {
  findMesenBin,
  findMesenHome,
  mesenBinExists,
  MesenError,
  runMesenWithBattery,
} from "../lib/sfc-mesen.ts";
import {
  decodeReport,
  type Finding,
  formatFindings,
  liveFindings,
  staticFindings,
  verifyScript,
} from "./lib/sfc-verify.ts";

const USAGE = `usage: deno task sfc:verify <save.srm> [options]

  --rom <sfc>         the Dezaemon ROM (else dev-fixtures/ or $DEZAEMON_SFC_ROM)
  --out <dir>         where the screenshots and report.json go
                      (default build/sfc-verify/<save name>/)
  --mesen <bin>       the Mesen executable (else $MESEN_BIN or the usual place)
  --mesen-home <dir>  Mesen's home folder, the one with Saves/ (else $MESEN_HOME
                      or the usual place)
  --play-frames <n>   frames to let the stage run before reading the console (600)
  --timeout <sec>     Mesen's own limit on the run (120)
  --static-only       check the file and stop; no emulator
  --json              print the verdict as JSON instead of lines`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

interface Options {
  save: string | null;
  rom: string | null;
  out: string | null;
  mesen: string | null;
  mesenHome: string | null;
  playFrames: number;
  timeout: number;
  staticOnly: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    save: null,
    rom: null,
    out: null,
    mesen: null,
    mesenHome: null,
    playFrames: 600,
    timeout: 120,
    staticOnly: false,
    json: false,
  };
  const args = argv.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    const num = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) fail(`${arg} wants a whole number`);
      return n;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    } else if (arg === "--rom") o.rom = value();
    else if (arg === "--out") o.out = value();
    else if (arg === "--mesen") o.mesen = value();
    else if (arg === "--mesen-home") o.mesenHome = value();
    else if (arg === "--play-frames") o.playFrames = num();
    else if (arg === "--timeout") o.timeout = num();
    else if (arg === "--static-only") o.staticOnly = true;
    else if (arg === "--json") o.json = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}\n\n${USAGE}`);
    else if (o.save) fail(`unexpected argument ${arg}`);
    else o.save = arg;
  }
  if (!o.save) fail(`name a save file\n\n${USAGE}`);
  return o;
}

export interface VerifyResult {
  save: string;
  rom: string | null;
  ok: boolean;
  ran: boolean;
  exitCode: number | null;
  static: Finding[];
  live: Finding[];
  out: string | null;
  shots: string[];
}

/**
 * Both layers over one save. Exported so a test drives the same code the
 * task does; `log` gets the progress lines the terminal shows.
 */
export async function verifySfcSave(
  o: Options,
  log: (line: string) => void = () => {},
): Promise<VerifyResult> {
  const savePath = resolve(o.save!);
  let sram: Uint8Array;
  try {
    sram = await Deno.readFile(savePath);
  } catch (e) {
    throw new MesenError(`cannot read ${savePath}: ${(e as Error).message}`);
  }

  const root = repoRoot();
  const extra = [o.rom, Deno.env.get("DEZAEMON_SFC_ROM")].filter((
    p,
  ): p is string => !!p);
  const found = await findDezaemonSfcRom(root, { extra });
  const rom = found ? await readDezaemonSfcRom(found) : null;
  log(`save : ${savePath} (${sram.length} bytes)`);
  log(
    `rom  : ${
      found ? found.path : "none found (static checks only know the save)"
    }`,
  );

  const s = staticFindings(sram, rom);
  log("file:");
  log(formatFindings(s.findings));
  const result: VerifyResult = {
    save: savePath,
    rom: found?.path ?? null,
    ok: !s.findings.some((x) => x.level === "fail"),
    ran: false,
    exitCode: null,
    static: s.findings,
    live: [],
    out: null,
    shots: [],
  };
  if (o.staticOnly) return result;
  if (!result.ok) {
    log("the file fails on its own; not booting it");
    return result;
  }
  if (!found) {
    throw new MesenError(
      "no Super Famicom Dezaemon ROM: put the .sfc in dev-fixtures/ (or a folder under it), set $DEZAEMON_SFC_ROM, or pass --rom",
    );
  }
  const bin = findMesenBin(o.mesen);
  if (!(await mesenBinExists(bin))) {
    throw new MesenError(
      `could not find Mesen at "${bin}". Set MESEN_BIN to the executable (the macOS bundle's Contents/MacOS/Mesen), or pass --mesen.`,
    );
  }

  const outDir = resolve(
    o.out ||
      join(
        root,
        "build",
        "sfc-verify",
        basename(savePath).replace(/\.[^.]+$/, ""),
      ),
  );
  await ensureDir(outDir);
  const scratch = await Deno.makeTempDir({ prefix: "sfc-verify-" });
  const scriptPath = join(scratch, "verify.lua");
  await Deno.writeTextFile(
    scriptPath,
    verifyScript(sram, { playFrames: o.playFrames }),
  );
  log(
    `mesen: ${bin}${
      (await findMesenHome(o.mesenHome))
        ? ""
        : " (first run: its home folder will be created)"
    }`,
  );
  log(`booting ${found.name} with the save, playing ${o.playFrames} frames…`);
  try {
    const run = await runMesenWithBattery({
      bin,
      rom: found.path,
      script: scriptPath,
      home: o.mesenHome,
      timeoutSec: o.timeout,
    });
    result.ran = true;
    result.exitCode = run.run.code;
    if (run.run.killed) {
      throw new MesenError(
        `Mesen did not stop within ${o.timeout + 30}s and was killed`,
      );
    }
    const report = run.battery ? decodeReport(run.battery) : null;
    for (const [name, png] of Object.entries(report?.shots ?? {})) {
      const path = join(outDir, `${name}.png`);
      await Deno.writeFile(path, png);
      result.shots.push(path);
    }
    const live = await liveFindings(sram, rom, report, run.run.code);
    result.live = live.findings;
    result.ok = live.ok;
    result.out = outDir;
    log(`console (${(run.run.ms / 1000).toFixed(1)}s, exit ${run.run.code}):`);
    log(formatFindings(live.findings));
    if (report?.status.frames) {
      log(`  ${result.shots.length} screenshots -> ${outDir}`);
    }
    await Deno.writeTextFile(
      join(outDir, "report.json"),
      JSON.stringify(
        { ...result, status: report?.status ?? null, mesen: run.run.args },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
  return result;
}

if (import.meta.main) {
  const o = parseArgs(Deno.args);
  try {
    const r = await verifySfcSave(o, o.json ? () => {} : (m) => console.log(m));
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(
        r.ok
          ? r.ran
            ? `OK: ${basename(r.save)} boots, loads and plays as this save`
            : `OK: ${basename(r.save)} passes the file checks (not booted)`
          : `FAIL: ${basename(r.save)} does not ${
            r.ran ? "play as written" : "pass the file checks"
          }`,
      );
    }
    Deno.exit(r.ok ? 0 : 1);
  } catch (e) {
    if (e instanceof MesenError) fail(e.message);
    throw e;
  }
}
