// scripts/build-ddd.ts — a level record as a Dezaemon 3D 64DD data disk.
//
//   deno task build:ddd                                   # the bundled base game (foo.json) -> "Dezaemon 3D - foo.ndd"
//   deno task build:ddd foo                               # the cloud level shmupX/levels/foo
//   deno task build:ddd ./backups/mygame.json             # a level record on disk
//   deno task build:ddd foo --disk dev-fixtures/deza1.ndd # onto that donor disk (default: the first 64DD image in dev-fixtures/)
//   deno task build:ddd foo --no-disk                     # a disk built from nothing: no donor, no boot program, no RAM area
//   deno task build:ddd foo --as GEARSQ --template SAMP   # the project's name on the disk, and the donor project under it
//   deno task build:ddd foo --ddd --out build/n64/foo.ddd --report
//   deno task build:ddd foo --title-words "FOO WARS"     # the title picture's words, for a level with no logo (default: static/n64dd/titles.json, else its title)
//
// The Nintendo 64 counterpart of build-kids.ts: the same level record and the
// same art go through packages/shmup-engine/src/n64/export-ddd.js instead of
// a PlayStation writer, and come out as a 64DD disk image — an .ndd (the whole
// disk, its 24-block system area first, what an emulator mounts) or a .ddd
// (the user area alone, what this repo's reader takes). The project goes on
// the disk as a PRESSED one in the read-only directory, beside the
// prototype's two samples, its files laid end to end from LBA 9 and the
// directory written three times over; nothing writes the RAM (save) area, the
// writable directory or the cartridge's own DEZA3D.SYS / DEZA3D.HSC, whose
// layouts are not known well enough (static/dezaemon-parity-n64.html,
// sections 03 and 04).
//
// How far the project reaches is the writer's to say, not this script's: the
// level's frames are laid into the free 64x32 textures of the CGR and stage
// GR sheets (the one CONFIRMED record format) and the level is placed through
// the record codecs — a billboard model per frame, an enemy entry per letter,
// the layout, the boss, the ship and items as common models — with a
// TEMPLATE project on the donor (the donor's first, or --template NAME)
// lending its CMD, CBL, MUS, ULB and map tables, or, with --no-template, GAM
// the cartridge's own initial game, CMD and CBL the level's ship and item
// icons alone, the songs blank and the maps unset. Each stage with a story
// opens on it as a full-screen portrait briefing (lib/story-panels.ts, the
// writer's storyEffects). Every unit the records carry that is not a
// measurement is a reading of the format document marked likely in the
// engine.
//
// The donor matters more here than on the other consoles. A disk built on the
// prototype keeps the boot program and the RAM area the cartridge needs to go
// into disk mode; a disk built from nothing (--no-disk, or no image in
// dev-fixtures/) is recognised by this repo's reader and is not expected to
// put the cartridge into disk mode. A disk built on deza1.NDD was booted in
// static/n64dd/play.html (EmulatorJS mupen64plus-next) on 2026-10-20/21: the
// project is listed, loads and plays, its stages open on their story and its
// enemies draw as sprites on the ground plane (FORMAT-N64.md); no disk has
// been put on hardware. The donor is found by size, never by name — a .ddd
// or .ndd is exactly one of two lengths — and an .ndd is preferred over a
// .ddd because it brings its own system area.

import { basename, dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  DDD_IMAGE_BYTES,
  exportLevelToDdd,
  isN64ItemFrame,
  n64ImageFormat,
  n64ReadProjects,
  NDD_IMAGE_BYTES,
} from "@shmupx/shmup-engine";
import { repoRoot } from "../lib/repo-root.ts";
import { loadAthenaFont } from "../lib/bitmap-font.ts";
import { storyLogLine, type StoryStageReport } from "../lib/story-panels.ts";
import {
  baseAtlasFrameNames,
  bossRushArg,
  inEditorAtlasOrder,
  levelStoryBackdrops,
  loadLevel,
  loadLevelArt,
  titleArt,
} from "./build-sav.ts";

const ROOT = repoRoot();
const FIXTURES = join(ROOT, "dev-fixtures");

export type DiskFormat = "ndd" | "ddd";

export interface BuildDddOptions {
  /** A level name in the cloud, or a path to a level JSON file. Omitted: foo.json. */
  level?: string | null;
  /** The project's name on the disk (eight letters and digits), over the level's own. */
  name?: string | null;
  /** A donor .ddd or .ndd to lay the project onto. Omitted: the first 64DD image in dev-fixtures/. */
  disk?: string | null;
  /** Build from nothing: no donor, so no boot program and an empty RAM area. */
  noDisk?: boolean;
  /** The donor project whose files underlie the new one. Omitted: the donor's first. */
  template?: string | null;
  /** No template: GAM is the cartridge's initial game, CMD/CBL hold the ship and items alone, the songs are blank, the maps unset. */
  noTemplate?: boolean;
  /** The image to write: the whole disk (.ndd, the default) or the user area alone (.ddd). */
  format?: DiskFormat;
  out?: string | null;
  /** Skip the base game's atlas for missing frames. */
  noBaseAtlas?: boolean;
  /** Cut the level to its bosses from this stage on (lib/boss-rush.ts). */
  bossRush?: number | null;
  /** The title picture's words for a level with no logo, over static/n64dd/titles.json's. */
  titleWords?: string | null;
  log?: (message: string) => void;
}

export interface BuildDddResult {
  outPath: string;
  bytes: number;
  fileName: string;
  /** The project's name on the disk. */
  name: string;
  format: DiskFormat;
  /** The donor disk's path, or null for a disk built from nothing. */
  donor: string | null;
  /** The donor project whose files underlie the new one, or null. */
  template: string | null;
  warnings: string[];
  report: Record<string, unknown>;
}

/** The parts of the export's report this script reads back to the terminal. */
interface SheetReport {
  textures: { key: string; index: number; textures: number }[];
  painted: number;
  used: number;
  free: number;
  missed: string[];
  reclaimed?: number;
  story?: { textures: number; reclaimed: number } | null;
}
interface TitlePicture {
  source: "logo" | "words" | "subtitle" | "cleared";
  sheet: string;
  y: number;
  textures: number[];
}
interface TitleReport {
  words: string | null;
  title1: TitlePicture | null;
  title2: TitlePicture | null;
}
interface DddReport {
  project: {
    title: TitleReport;
    common: SheetReport;
    stages: (SheetReport & { key: string; ext: string })[];
    files: { ext: string; bytes: number; source: string }[];
    bytes: number;
  };
  projects: {
    name: string;
    kept: boolean;
    files: unknown[];
    stored: number;
    firstLba: number | null;
    blockCount: number;
  }[];
  files: number;
  romFree: number;
  templateProject: string | null;
  transform: string;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

/** Where a level's 64DD title words are kept, by its name; the editor fetches the same file. */
export const DDD_TITLES = join(ROOT, "static", "n64dd", "titles.json");

/** A level's 64DD title words from DDD_TITLES, or null when it lists none. */
export async function dddTitleWords(
  levelName: string,
  file: string = DDD_TITLES,
): Promise<string | null> {
  try {
    const all = JSON.parse(await Deno.readTextFile(file));
    const words = all?.[levelName]?.titleWords;
    return typeof words === "string" && words.trim() ? words.trim() : null;
  } catch {
    return null;
  }
}

/** The build log's "title:" line, from the writer's report. */
export function titleLogLine(t: TitleReport | undefined): string {
  const one = t?.title1;
  if (!one) {
    return "title: the template's own pictures (no logo, and no words to draw)";
  }
  const what = one.source === "logo"
    ? "the level's logo"
    : `"${t!.words}" in the story's face`;
  const two = t?.title2
    ? t.title2.source === "cleared"
      ? "; title 2 cleared"
      : "; title 2 the level's subtitle"
    : "";
  return `title: ${what}, at y ${one.y} (${one.sheet} textures ${
    one.textures.join(", ")
  })${two}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The donor a build defaults to: the first 64DD image in dev-fixtures/,
 * judged by size alone (n64ImageFormat() knows the two lengths) — an .ndd
 * before a .ddd, then by name. null when the folder holds none.
 */
export async function findDonorDisk(
  dir: string = FIXTURES,
): Promise<string | null> {
  const found: { path: string; format: DiskFormat }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile && !entry.isSymlink) continue;
      const path = join(dir, entry.name);
      let size: number;
      try {
        size = (await Deno.stat(path)).size;
      } catch {
        continue;
      }
      const format = n64ImageFormat({ length: size }) as DiskFormat | null;
      if (format) found.push({ path, format });
    }
  } catch {
    return null; // no dev-fixtures/ in this checkout
  }
  found.sort((a, b) =>
    a.format === b.format
      ? a.path.localeCompare(b.path)
      : a.format === "ndd"
      ? -1
      : 1
  );
  return found[0]?.path ?? null;
}

function shown(path: string): string {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

/** Build the disk. Exported so a test drives the same code the task does. */
export async function buildDdd(
  options: BuildDddOptions = {},
): Promise<BuildDddResult> {
  const log = options.log ?? (() => {});
  const format: DiskFormat = options.format ?? "ndd";
  const { record } = await loadLevel(options.level, log, {
    bossRush: options.bossRush,
  });
  // The item icons: no record names them, and the writer takes the first it
  // meets (isN64ItemFrame). The editor's art is the whole base atlas with
  // the level's frames folded in, so the CLI asks the base atlas for every
  // frame the writer would take and orders the art as the editor's is —
  // the same icons in the same slots as the editor's disk.
  const baseNames = await baseAtlasFrameNames();
  const art = inEditorAtlasOrder(
    await loadLevelArt(record, {
      noBaseAtlas: options.noBaseAtlas,
      log,
      extraNames: baseNames.filter(isN64ItemFrame),
    }),
    baseNames,
  );
  const title1 = await titleArt(record.logoDataURL, "logo", log);
  const title2 = await titleArt(record.subTitleDataURL, "subtitle", log);

  // --- the donor ---
  let donor: string | null = null;
  let disk: Uint8Array | null = null;
  if (!options.noDisk) {
    donor = options.disk ? resolve(options.disk) : await findDonorDisk();
    if (donor) {
      disk = await Deno.readFile(donor);
      const have = n64ImageFormat(disk);
      if (!have) {
        throw new Error(
          `${
            shown(donor)
          } is ${disk.length} bytes, neither a .ddd (${DDD_IMAGE_BYTES}) nor an .ndd (${NDD_IMAGE_BYTES})`,
        );
      }
      const names = n64ReadProjects(disk).map((p: { name: string }) => p.name);
      log(
        `donor: ${shown(donor)} (.${have}${
          options.disk ? "" : ", the first 64DD image in dev-fixtures/"
        }; projects ${names.join(", ") || "none"})`,
      );
    } else {
      log(
        "donor: none — no .ddd or .ndd of 64DD size in dev-fixtures/, so the disk is built from nothing",
      );
    }
  } else {
    log("donor: none (--no-disk) — the disk is built from nothing");
  }
  if (disk === null) {
    log(
      "note: a disk built from nothing has no boot program and an empty RAM area; it is not expected to put the cartridge into disk mode",
    );
  }

  // --- the template ---
  let template: string | null;
  if (options.noTemplate) template = null;
  else if (options.template) template = options.template;
  else template = disk ? "disk" : null;
  if (template && !disk) {
    throw new Error(
      `--template ${template} needs a donor disk to come from (--disk <path>, or drop --no-disk)`,
    );
  }

  // The story, as each stage's opening briefing: forty portrait effects
  // covering the screen while the scroll waits (FORMAT-N64.md "A level's
  // story"); the writer takes the largest size its textures allow.
  const backdrops = await levelStoryBackdrops(record, log);

  // The title: a level with no logo shows words in the story's face — its
  // 64DD title words (static/n64dd/titles.json, or --title-words), else its
  // own title — where the GAM points, in place of the donor's logo.
  const titleWords = options.titleWords?.trim() ||
    (await dddTitleWords(String(record.name ?? ""))) || null;
  let font = null;
  try {
    font = await loadAthenaFont(ROOT);
  } catch (e) {
    log(
      `warning: the story's face did not load (${
        (e as Error).message
      }); a level with no logo keeps the template's title`,
    );
  }

  const result = exportLevelToDdd(record, art, {
    name: options.name?.trim() || null,
    disk,
    template,
    format,
    title1,
    title2,
    font,
    titleWords,
    storyBackdrops: backdrops,
  });
  const rep = result.report as unknown as DddReport;
  log(`name: ${result.name}`);
  log(titleLogLine(rep.project.title));
  log(storyLogLine(backdrops, rep.project.stages as StoryStageReport[]));
  log(
    rep.templateProject
      ? `template: ${rep.templateProject}${
        options.template ? "" : " (the donor's first project)"
      } — its files underlie every one the art does not paint`
      : "template: none — GAM is the cartridge's initial game with the final stage set, CMD and CBL hold the ship and item icons alone, the songs are blank, the maps unset",
  );
  // Frames and a story may take back a template's textures (the writer's
  // `reclaimed`), so the textures are counted from what was placed.
  const sheet = (label: string, s: SheetReport) => {
    const story = s.story ?? null;
    const reclaimed = s.reclaimed ?? 0;
    const frames = s.textures.filter((t) => !t.key.endsWith(":story"));
    return `${label} ${count(frames.length, "frame")} in ${
      count(s.used - s.painted + reclaimed - (story?.textures ?? 0), "texture")
    }${story ? ` + its story in ${story.textures}` : ""}${
      reclaimed ? ` (${reclaimed} of them the template's, taken back)` : ""
    }${s.painted ? ` beside ${s.painted} painted` : ""}, ${s.free} free`;
  };
  log(
    `textures: ${
      [
        sheet("CGR", rep.project.common),
        ...rep.project.stages.map((s) => sheet(`${s.key} ${s.ext}`, s)),
      ].join("; ")
    }`,
  );
  const sources = new Map<string, number>();
  for (const f of rep.project.files) {
    sources.set(f.source, (sources.get(f.source) ?? 0) + 1);
  }
  log(
    `files: ${rep.project.files.length} (${
      [...sources].map(([source, n]) => `${n} ${source}`).join(", ")
    }), ${rep.project.bytes} bytes decompressed`,
  );
  const mine = rep.projects.find((p) => p.name === result.name);
  log(
    `disk: ${
      rep.projects.map((p) => `${p.name} ${p.kept ? "kept" : "new"}`).join(
        ", ",
      )
    } — ${count(rep.files, "file")}${
      mine
        ? `; ${result.name} stored in ${mine.stored} bytes over ${
          count(mine.blockCount, "block")
        } from LBA ${mine.firstLba}`
        : ""
    }; ${rep.romFree} bytes of the ROM area free`,
  );
  log(`transform: ${rep.transform}`);
  for (const w of result.warnings) log(`warning: ${w}`);
  log(
    "note: booted in mupen64plus-next on a deza1.NDD donor, a disk like this loads and plays, opens its stages on their story and draws its enemies as sprites (FORMAT-N64.md); untested on hardware",
  );

  const outPath = resolve(
    options.out || join(ROOT, "build", "n64", result.fileName),
  );
  if (donor && resolve(donor) === outPath) {
    throw new Error("--out must name a different file from the donor disk");
  }
  await ensureDir(dirname(outPath));
  await Deno.writeFile(outPath, result.image);
  log(
    `wrote ${shown(outPath)} (${result.image.length} bytes, .${result.format})`,
  );
  return {
    outPath,
    bytes: result.image.length,
    fileName: result.fileName,
    name: result.name,
    format: result.format as DiskFormat,
    donor,
    template: rep.templateProject,
    warnings: result.warnings,
    report: result.report as unknown as Record<string, unknown>,
  };
}

if (import.meta.main) {
  const opts: BuildDddOptions = { log: (m) => console.log(m) };
  let report = false;
  const args = Deno.args.slice();
  while (args.length) {
    const arg = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--name" || arg === "--as") opts.name = value();
    else if (arg.startsWith("--name=")) opts.name = arg.slice(7);
    else if (arg.startsWith("--as=")) opts.name = arg.slice(5);
    else if (arg === "--disk") opts.disk = value();
    else if (arg.startsWith("--disk=")) opts.disk = arg.slice(7);
    else if (arg === "--no-disk") opts.noDisk = true;
    else if (arg === "--template") opts.template = value();
    else if (arg.startsWith("--template=")) opts.template = arg.slice(11);
    else if (arg === "--no-template") opts.noTemplate = true;
    else if (arg === "--ndd" || arg === "--ddd") {
      const format = arg.slice(2) as DiskFormat;
      if (opts.format && opts.format !== format) {
        fail("--ndd and --ddd are one or the other");
      }
      opts.format = format;
    } else if (arg === "--out") opts.out = value();
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--no-base-atlas") opts.noBaseAtlas = true;
    else if (arg === "--title-words") opts.titleWords = value();
    else if (arg.startsWith("--title-words=")) opts.titleWords = arg.slice(14);
    else if (arg.startsWith("--boss-rush")) opts.bossRush = bossRushArg(arg);
    else if (arg === "--report") report = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: deno task build:ddd [level-name | level.json] [--as NAME] [--disk <ddd|ndd> | --no-disk]\n" +
          "       [--template NAME | --no-template] [--ndd | --ddd] [--out file] [--no-base-atlas] [--boss-rush[=STAGE]]\n" +
          "       [--title-words WORDS] [--report]",
      );
      Deno.exit(0);
    } else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else if (opts.level) fail(`unexpected argument ${arg}`);
    else opts.level = arg;
  }
  if (opts.disk && opts.noDisk) {
    fail("--disk and --no-disk are one or the other");
  }
  if (opts.template && opts.noTemplate) {
    fail("--template and --no-template are one or the other");
  }
  if (opts.disk && !/\.(ddd|ndd)$/i.test(basename(opts.disk))) {
    console.log(
      `note: ${opts.disk} is not named .ddd or .ndd; it is judged by its size`,
    );
  }
  try {
    const r = await buildDdd(opts);
    if (report) console.log(JSON.stringify(r.report, null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}
