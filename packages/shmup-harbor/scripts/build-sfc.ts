// scripts/build-sfc.ts — a level record as a Super Famicom Dezaemon SRAM image.
//
//   deno task build:sfc                                  # the bundled base game (foo.json) -> "Dezaemon SFC - foo.srm"
//   deno task build:sfc foo                              # the cloud level levels/foo
//   deno task build:sfc ./backups/mygame.json            # a level record on disk
//   deno task build:sfc foo --out build/sfc/foo.srm --report
//
// The 1994 cart's counterpart of build-kids.ts: the same level record and art
// go through packages/shmup-engine/src/sfc/sfc-write.js and come out as the
// 128 KB raw battery-SRAM image (.srm, as emulators name it) Kaite Tsukutte
// Asoberu Dezaemon (SHVC-66) loads as its one saved game. FORMAT-SFC.md
// "Writing a save".

import { dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { exportLevelToSfcSram } from "@shmupx/shmup-engine";
import { repoRoot } from "../lib/repo-root.ts";
import { loadLevel, loadLevelArt, titleArt } from "./build-sav.ts";

const ROOT = repoRoot();

export interface BuildSfcOptions {
  level?: string | null;
  name?: string | null;
  out?: string | null;
  noBaseAtlas?: boolean;
  log?: (message: string) => void;
}

export interface BuildSfcResult {
  outPath: string;
  bytes: number;
  fileName: string;
  name: string;
  warnings: string[];
  report: Record<string, unknown>;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

/** Build the image. Exported so a test drives the same code the task does. */
export async function buildSfc(
  options: BuildSfcOptions = {},
): Promise<BuildSfcResult> {
  const log = options.log ?? (() => {});
  const { record } = await loadLevel(options.level, log);
  const art = await loadLevelArt(record, {
    noBaseAtlas: options.noBaseAtlas,
    log,
  });
  const title1 = await titleArt(record.logoDataURL, "logo", log);

  const result = exportLevelToSfcSram(record, art, {
    name: options.name?.trim() || null,
    title1,
  });
  const rep = result.report;
  log(`name: ${result.name}`);
  log(
    `stages: ${
      rep.stages.map((s: { key: string; placements: number; boss: unknown }) =>
        `${s.key} ${s.placements} spawns${s.boss ? " + boss" : ""}`
      ).join(", ")
    }`,
  );
  log(
    `chips: ${rep.chips.used} of ${rep.chips.capacity} (${rep.chips.shared} shared); palette rows: ${
      rep.rows.map((r: { row: number; colors: number; owner: string }) =>
        `${r.row} ${r.owner} (${r.colors})`
      ).join(", ")
    }`,
  );
  type StageReport = {
    key: string;
    enemies: { name: string; klass: number; size: string }[];
    records: number;
    lines: number;
    mapChips: number;
    rowsDrawn: number;
    boss: { name: string; hpIndex: number; line: number } | null;
  };
  for (const st of rep.stages as StageReport[]) {
    log(
      `${st.key}: ${st.enemies.length} entries (${
        st.enemies.map((e) => `${e.name} c${e.klass} ${e.size}`).join(", ")
      }); ${st.records} spawn records over ${st.lines} lines; ${st.mapChips} scenery chips over ${st.rowsDrawn} rows${
        st.boss
          ? `; boss "${st.boss.name}" hp index ${st.boss.hpIndex} on line ${st.boss.line}`
          : "; no boss"
      }`,
    );
  }
  for (const w of result.warnings) log(`warning: ${w}`);

  const outPath = resolve(
    options.out || join(ROOT, "build", "sfc", result.fileName),
  );
  await ensureDir(dirname(outPath));
  await Deno.writeFile(outPath, result.sram);
  log(`wrote ${relative(ROOT, outPath)} (${result.sram.length} bytes)`);
  return {
    outPath,
    bytes: result.sram.length,
    fileName: result.fileName,
    name: result.name,
    warnings: result.warnings,
    report: rep as Record<string, unknown>,
  };
}

if (import.meta.main) {
  const opts: BuildSfcOptions = { log: (m) => console.log(m) };
  let report = false;
  const args = Deno.args.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--name") opts.name = value();
    else if (arg.startsWith("--name=")) opts.name = arg.slice(7);
    else if (arg === "--out") opts.out = value();
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg === "--report") report = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else if (opts.level) fail(`unexpected argument ${arg}`);
    else opts.level = arg;
  }
  try {
    const r = await buildSfc(opts);
    if (report) console.log(JSON.stringify(r.report, null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}
