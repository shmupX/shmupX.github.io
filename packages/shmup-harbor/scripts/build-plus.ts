// scripts/build-plus.ts — a level record as a Dezaemon+ memory card.
//
//   deno task build:plus                                  # the bundled base game (foo.json) -> "Dezaemon Plus - foo.mcr"
//   deno task build:plus foo                              # the cloud level shmupX/levels/foo
//   deno task build:plus ./backups/mygame.json            # a level record on disk
//   deno task build:plus foo --out build/plus/foo.mcr --report
//
// The 1996 port's counterpart of build-kids.ts: the same level record and art
// go through packages/shmup-engine/src/psx/plus-write.js and come out as the
// 128 KB raw card image holding one BISLPS-00335DEZA save, which both
// Dezaemon+ (SLPS-00335) and Dezaemon Plus Select 100 (SLPS-01504) load from
// their LOAD/SAVE menu. A Dezaemon+ save carries no text name: the level's
// name is the card file's only. FORMAT-PSX.md "Writing a Dezaemon+ save".

import { dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { exportLevelToPlusCard } from "@shmupx/shmup-engine";
import { repoRoot } from "../lib/repo-root.ts";
import { storyLogLine, type StoryStageReport } from "../lib/story-panels.ts";
import {
  bossRushArg,
  levelStoryBackdrops,
  loadLevel,
  loadLevelArt,
  titleArt,
} from "./build-sav.ts";

const ROOT = repoRoot();

export interface BuildPlusOptions {
  level?: string | null;
  name?: string | null;
  out?: string | null;
  noBaseAtlas?: boolean;
  horizontal?: boolean;
  /** Cut the level to its bosses from this stage on (lib/boss-rush.ts). */
  bossRush?: number | null;
  log?: (message: string) => void;
}

export interface BuildPlusResult {
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

/** Build the card. Exported so a test drives the same code the task does. */
export async function buildPlus(
  options: BuildPlusOptions = {},
): Promise<BuildPlusResult> {
  const log = options.log ?? (() => {});
  const { record } = await loadLevel(options.level, log, {
    bossRush: options.bossRush,
  });
  const art = await loadLevelArt(record, {
    noBaseAtlas: options.noBaseAtlas,
    log,
  });
  const title1 = await titleArt(record.logoDataURL, "logo", log);
  const backdrops = await levelStoryBackdrops(record, log);

  const result = exportLevelToPlusCard(record, art, {
    name: options.name?.trim() || null,
    title1,
    horizontal: options.horizontal ?? false,
    storyBackdrops: backdrops,
  });
  const rep = result.report;
  log(
    `name: ${result.name} (the card file's; a Dezaemon+ save has no text name)`,
  );
  log(storyLogLine(backdrops, rep.stages as StoryStageReport[]));
  log(
    `stages: ${
      rep.stages.map((s: { key: string; placements: number; boss: unknown }) =>
        `${s.key} ${s.placements} spawns${s.boss ? " + boss" : ""}`
      ).join(", ")
    }`,
  );
  log(
    `tiles: ${rep.tiles.used} of 512 (${rep.tiles.shared} shared); palette rows in use: ${
      rep.rows.map((r: { row: number; colors: number }) =>
        `${r.row}:${r.colors}`
      ).join(" ")
    }`,
  );
  for (const st of rep.stages) {
    if (st.boss) {
      log(
        `${st.key}: boss "${st.boss.name}"${
          st.boss.form ? ` (form ${st.boss.form})` : ""
        } ${
          st.boss.vertical ? "64x128" : "128x64"
        }, ${st.boss.tiles} tiles, ${st.boss.hits} hits; ${st.enemyEntries} enemy tiles over ${st.enemyTiles} sheet cells`,
      );
    } else {
      log(
        `${st.key}: no boss; ${st.enemyEntries} enemy tiles over ${st.enemyTiles} sheet cells`,
      );
    }
  }
  log(`transform: ${rep.transform}`);
  for (const w of result.warnings) log(`warning: ${w}`);

  const outPath = resolve(
    options.out || join(ROOT, "build", "plus", result.fileName),
  );
  await ensureDir(dirname(outPath));
  await Deno.writeFile(outPath, result.card);
  log(`wrote ${relative(ROOT, outPath)} (${result.card.length} bytes)`);
  return {
    outPath,
    bytes: result.card.length,
    fileName: result.fileName,
    name: result.name,
    warnings: result.warnings,
    report: rep as Record<string, unknown>,
  };
}

if (import.meta.main) {
  const opts: BuildPlusOptions = { log: (m) => console.log(m) };
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
    else if (arg === "--horizontal") opts.horizontal = true;
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg.startsWith("--boss-rush")) opts.bossRush = bossRushArg(arg);
    else if (arg === "--report") report = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else if (opts.level) fail(`unexpected argument ${arg}`);
    else opts.level = arg;
  }
  try {
    const r = await buildPlus(opts);
    if (report) console.log(JSON.stringify(r.report, null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}
