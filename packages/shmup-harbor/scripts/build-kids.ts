// scripts/build-kids.ts — a level record as a Dezaemon Kids! memory card.
//
//   deno task build:kids                                  # the bundled base game (foo.json) -> "Dezaemon Kids - foo.mcr"
//   deno task build:kids foo                              # the cloud level levels/foo
//   deno task build:kids ./backups/mygame.json            # a level record on disk
//   deno task build:kids foo --out build/kids/foo.mcr --report
//   deno task build:kids foo --name "SKY TALE"            # the card's own name (ten ASCII characters) over the level's
//   deno task build:kids foo --background 3               # one of the disc's 38 backdrops behind every stage
//
// The PlayStation counterpart of build-sav.ts: the same level record and the
// same art go through packages/shmup-engine/src/psx/kids-write.js instead of
// the Saturn writer, and come out as the 128 KB raw memory-card image
// (.mcr, as Mednafen names them) holding one BISLPS-01503DEZAKIDS save — the
// file an emulator mounts in slot 1 and Dezaemon Kids! loads from its PERON
// menu. FORMAT-PSX.md "Writing a Kids! save" is the layout.
//
// The game name on the card is the level's, cut to the ten ASCII characters
// the title field holds; --name says it outright. Frames the level names but
// its own atlas lacks come from the base game's sheet, as for the Saturn.

import { dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  exportLevelToKidsCard,
  KIDS_STOCK_ITEM_FRAMES,
} from "@shmupx/shmup-engine";
import { repoRoot } from "../lib/repo-root.ts";
import { loadLevel, loadLevelArt, titleArt } from "./build-sav.ts";

const ROOT = repoRoot();

export interface BuildKidsOptions {
  /** A level name in the cloud, or a path to a level JSON file. Omitted: foo.json. */
  level?: string | null;
  /** The card's game name, over the level's own. */
  name?: string | null;
  out?: string | null;
  /** One of the disc's backdrops (1..38) behind every stage; 0 for none. */
  background?: number;
  /** Skip the base game's atlas for missing frames. */
  noBaseAtlas?: boolean;
  horizontal?: boolean;
  log?: (message: string) => void;
}

export interface BuildKidsResult {
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
export async function buildKids(
  options: BuildKidsOptions = {},
): Promise<BuildKidsResult> {
  const log = options.log ?? (() => {});
  const { record } = await loadLevel(options.level, log);
  const art = await loadLevelArt(record, {
    noBaseAtlas: options.noBaseAtlas,
    log,
    // The item icons come from the base game's power-up emblems, which no
    // record names; the CLI asks for them so the card shows the stock art.
    extraNames: KIDS_STOCK_ITEM_FRAMES,
  });
  const title1 = await titleArt(record.logoDataURL, "logo", log);
  const title2 = await titleArt(record.subTitleDataURL, "subtitle", log);

  const result = exportLevelToKidsCard(record, art, {
    name: options.name?.trim() || null,
    title1,
    title2,
    backgroundSet: options.background ?? 0,
    horizontal: options.horizontal ?? false,
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
  log(`items: ${rep.items.join(", ")}`);
  log(
    `cells: ${rep.cells.used} of 1024 (${rep.cells.chips} chips, ${rep.cells.sprites} sprite cells, ${rep.cells.shared} shared)`,
  );
  log(
    `sections: graphics ${rep.sizes.graphics} B, data ${rep.sizes.data} B packed; ${rep.slack} B to spare`,
  );
  for (const w of result.warnings) log(`warning: ${w}`);

  const outPath = resolve(
    options.out || join(ROOT, "build", "kids", result.fileName),
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
  const opts: BuildKidsOptions = { log: (m) => console.log(m) };
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
    else if (arg === "--background") opts.background = Number(value());
    else if (arg.startsWith("--background=")) {
      opts.background = Number(arg.slice(13));
    } else if (arg === "--horizontal") opts.horizontal = true;
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg === "--report") report = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else if (opts.level) fail(`unexpected argument ${arg}`);
    else opts.level = arg;
  }
  if (
    opts.background !== undefined &&
    (!Number.isInteger(opts.background) || opts.background < 0 ||
      opts.background > 38)
  ) {
    fail("--background is 0 (none) or 1..38");
  }
  try {
    const r = await buildKids(opts);
    if (report) console.log(JSON.stringify(r.report, null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}
