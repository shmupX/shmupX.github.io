// A level record cut down to its bosses, from a chosen stage on.
//
// The web runtime has a boss rush of its own (`?bossRush=1` empties each
// stage's wave list as it starts, `?stage=N` boots straight into a stage), but
// a console export has neither: a Super Famicom cart, a Dezaemon 2 save, a
// PlayStation memory card and a 64DD disk each play the game they were written
// with from its first stage, start to finish. So the boss rush has to be in
// the record before the writer sees it, and this is the one place that puts it
// there for every exporter — build:sfc, build:sav, build:kids, build:plus,
// build:ddd and build:ps2 all take it as `--boss-rush[=N]`.
//
// What it does to the record:
//
// - Every stage keeps its scenery and its boss and trades its waves for ONE
//   showcase row: every enemy type the level places anywhere (cut stages
//   included), one of each, strongest in the middle and each weaker type a
//   column further out, alternating sides, with the row's leftover columns
//   mirroring the wing opposite — an arch by toughness, the way a formation
//   is drawn in the editor. The level's item drops ride on it too, each once,
//   on an enemy that drops it in the level (hangDrops): the row shows the
//   items as well, and the boss is met armed the way the level arms you —
//   which a tool-assisted run against a boss timer needs. The stage's own run
//   of empty rows before its first
//   wave is kept ahead of it, so the row comes in on the stage's own beat
//   rather than over its title. Each writer places a stage's boss a fixed gap
//   after the last wave, so the boss follows the row on every target. More
//   types than the row has columns spill into a second row; gs's seven fit
//   its eight. A stage's `waveRows` (the editor's wave grid) goes, and the
//   top-level flat `enemylist` becomes the first stage's — an array either
//   way, because lib/export-build.ts refuses a record without one.
// - A Dezaemon import's boss can carry the cart's own boss row
//   (`bossData.bossN.dezaemon.row`), which the Saturn writer prefers over the
//   gap after the last wave; that row is dropped so the boss comes on early
//   there as well.
// - `noStory` is set and `storyData` dropped: a story panel pushes a Saturn
//   stage's whole layout down 48 rows, and the panels are numbered by stage.
// - With `startStage` N, stages before N are cut and the rest renumbered from
//   stage0, their bosses with them — every writer pairs the i-th stage with
//   `boss<i>`, and none of the console formats has a stage select. The
//   per-stage song table of an import (`dezaemonBgm.stages`) is cut the same
//   way, and `stageKey` (the stage the PS2 port opens on) points at stage0.
//
// The record is changed in place, like forceImportedNoStory, and what was done
// comes back as a summary for the build's log.

/** What bossRushRecord did, for the build's log and its tests. */
export interface BossRushSummary {
  /** The stage (0-based, in the original numbering) the rush starts on. */
  startStage: number;
  /** The kept stages, under their original keys, in play order. */
  stages: string[];
  /** The stages cut because they come before `startStage`. */
  dropped: string[];
  /** The kept bosses, under their new keys. */
  bosses: string[];
  /** How many wave rows were emptied out across the kept stages. */
  waveRowsCleared: number;
  /** The enemy types the level places, strongest first. */
  enemyTypes: string[];
  /** The showcase row (or rows) every kept stage now opens on. */
  showcase: string[][];
}

// deno-lint-ignore no-explicit-any
type Json = any;

const STAGE_KEY = /^stage(\d+)$/;
const BOSS_KEY = /^boss(\d+)$/;

function numbered(
  map: Record<string, unknown> | null | undefined,
  pattern: RegExp,
  keep: (value: unknown) => boolean = (value) => value != null,
): string[] {
  if (!map || typeof map !== "object") return [];
  return Object.keys(map)
    .filter((key) => pattern.test(key) && keep(map[key]))
    .sort((a, b) => Number(pattern.exec(a)![1]) - Number(pattern.exec(b)![1]));
}

const hasWaves = (value: unknown) =>
  !!value && typeof value === "object" &&
  Array.isArray((value as { enemylist?: unknown }).enemylist);

/** A placed cell's enemy letter ("C1" -> "C"), or null for an empty one. */
function cellType(cell: unknown): string | null {
  if (typeof cell !== "string") return null;
  const m = /^([A-Za-z])\d$/.exec(cell);
  return m ? m[1].toUpperCase() : null;
}

/** A placed cell's item drop ("C1" -> "1"), or null for none. */
function cellDrop(cell: unknown): string | null {
  if (typeof cell !== "string") return null;
  const m = /^[A-Za-z]([1-9])$/.exec(cell);
  return m ? m[1] : null;
}

/** Every wave row of a record: the flat fields and every stage's. */
function allRows(record: Record<string, Json>): unknown[][] {
  const out: unknown[][] = [];
  const add = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (Array.isArray(row)) out.push(row);
  };
  add(record.enemylist);
  for (const holder of [record.stages, record]) {
    if (!holder || typeof holder !== "object") continue;
    for (const key of numbered(holder, STAGE_KEY, hasWaves)) {
      add(holder[key].enemylist);
    }
  }
  return out;
}

/** How many empty rows a wave list opens with before its first enemy. */
function leadIn(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const row of rows) {
    if (Array.isArray(row) && row.some((c) => cellType(c))) break;
    n++;
  }
  return n === rows.length ? 0 : n;
}

/**
 * Every enemy type a record places, in any stage or the flat fields, ordered
 * strongest first (by its enemyData hp; ties by letter), so a showcase built
 * from it puts the toughest in the middle.
 */
export function levelEnemyTypes(record: Record<string, Json>): string[] {
  const seen = new Set<string>();
  for (const row of allRows(record)) {
    for (const cell of row) {
      const t = cellType(cell);
      if (t) seen.add(t);
    }
  }
  const hp = (t: string) => Number(record.enemyData?.[`enemy${t}`]?.hp) || 0;
  return [...seen].sort((a, b) => hp(b) - hp(a) || a.localeCompare(b));
}

/**
 * The item drops a record places, in the order the level first drops them,
 * each with the enemy types that carry it there: `[["9", ["B", "C"]], …]`.
 */
export function levelDrops(record: Record<string, Json>): [string, string[]][] {
  const carriers = new Map<string, Set<string>>();
  for (const row of allRows(record)) {
    for (const cell of row) {
      const t = cellType(cell);
      const d = cellDrop(cell);
      if (!t || !d) continue;
      if (!carriers.has(d)) carriers.set(d, new Set());
      carriers.get(d)!.add(t);
    }
  }
  return [...carriers].map(([d, ts]) => [d, [...ts]]);
}

/**
 * Hang each of the level's drops on one showcase cell, so the row shows its
 * items as well as its enemies (and a rush starts the boss armed the way the
 * level arms you): each drop, in the level's order, goes on the first free
 * cell — middle out — whose enemy carries it in the level, else on the first
 * free cell at all. More drops than cells: the rest are left off. Mutates.
 */
export function hangDrops(
  rows: string[][],
  drops: [string, string[]][],
): void {
  const cells: [number, number][] = [];
  for (let r = 0; r < rows.length; r++) {
    for (const c of centreOut(rows[r].length)) {
      if (cellType(rows[r][c])) cells.push([r, c]);
    }
  }
  const free = new Set(cells.map((_, i) => i));
  for (const [drop, carriers] of drops) {
    let pick = -1;
    for (const i of free) {
      const [r, c] = cells[i];
      if (carriers.includes(cellType(rows[r][c])!)) {
        pick = i;
        break;
      }
    }
    if (pick < 0) pick = free.values().next().value ?? -1;
    if (pick < 0) return;
    free.delete(pick);
    const [r, c] = cells[pick];
    rows[r][c] = `${cellType(rows[r][c])}${drop}`;
  }
}

/** The columns of a row from the middle out, alternating left and right. */
function centreOut(width: number): number[] {
  const mid = (width - 1) / 2;
  return Array.from({ length: width }, (_, i) => i)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
}

/**
 * The showcase: `types` (strongest first) laid into rows of `width`, the
 * first type nearest the middle and each next one a column further out on
 * alternating sides. A row with columns to spare fills each from the column
 * mirroring it, so the formation reads symmetric. No drops yet — hangDrops.
 */
export function showcaseRows(types: string[], width: number): string[][] {
  const rows: string[][] = [];
  const order = centreOut(width);
  for (let i = 0; i < types.length; i += width) {
    const chunk = types.slice(i, i + width);
    const row = new Array<string>(width).fill("00");
    chunk.forEach((t, k) => row[order[k]] = `${t}0`);
    for (let k = chunk.length; k < width; k++) {
      const col = order[k];
      row[col] = row[width - 1 - col];
    }
    rows.push(row);
  }
  return rows;
}

/** A level's row width: its own `width`, else its widest wave row, else 8. */
function rowWidth(record: Record<string, Json>, stages: Json[]): number {
  const w = Number(record.width);
  if (Number.isInteger(w) && w > 0) return w;
  let widest = 0;
  for (const rows of [record.enemylist, ...stages.map((s) => s?.enemylist)]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (Array.isArray(row)) widest = Math.max(widest, row.length);
    }
  }
  return widest || 8;
}

/**
 * Parse one command-line argument as the boss-rush flag. `--boss-rush` starts
 * on the first stage, `--boss-rush=N` on stage N (0-based, as the stage keys
 * and the web runtime's `?stage=` count). Anything else is not this flag:
 * undefined. A malformed value throws.
 */
export function parseBossRushFlag(arg: string): number | undefined {
  if (arg === "--boss-rush") return 0;
  if (!arg.startsWith("--boss-rush=")) return undefined;
  const value = arg.slice("--boss-rush=".length);
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `--boss-rush takes a stage number (0 is the first), got "${value}"`,
    );
  }
  return Number(value);
}

/** Cut a record down to its bosses from `startStage` on. Mutates it. */
export function bossRushRecord(
  record: Record<string, Json>,
  { startStage = 0 }: { startStage?: number } = {},
): BossRushSummary {
  if (!Number.isInteger(startStage) || startStage < 0) {
    throw new Error(`boss rush: bad start stage ${startStage}`);
  }

  // The same three shapes levelStages() (shmup-engine write/game-to-save.js)
  // reads, in the same order: a `stages` map, the flat single-stage fields,
  // or the oldest records' top-level stageN blocks.
  const stageMap = record.stages && typeof record.stages === "object"
    ? record.stages as Record<string, Json>
    : null;
  let holder: Record<string, Json> | null = null;
  let keys = numbered(stageMap, STAGE_KEY, hasWaves);
  if (keys.length) holder = stageMap;
  else if (!Array.isArray(record.enemylist)) {
    keys = numbered(record, STAGE_KEY, hasWaves);
    if (keys.length) holder = record;
  }
  const stageCount = holder ? keys.length : 1;
  if (startStage >= stageCount) {
    throw new Error(
      `boss rush: the level has ${stageCount} stage${
        stageCount === 1 ? "" : "s"
      }, so there is no stage ${startStage} to start on`,
    );
  }

  // Read before anything is cut: the showcase is every type the LEVEL places,
  // a cut stage's included.
  const enemyTypes = levelEnemyTypes(record);
  const allStages = holder ? keys.map((key) => holder![key]) : [record];
  const showcase = showcaseRows(enemyTypes, rowWidth(record, allStages));
  hangDrops(showcase, levelDrops(record));
  const blank = () => new Array<string>(showcase[0]?.length ?? 0).fill("00");

  let waveRowsCleared = 0;
  const rush = (stage: Json) => {
    const rows = Array.isArray(stage.enemylist) ? stage.enemylist : [];
    waveRowsCleared += rows.length;
    const pause = Math.min(leadIn(rows), 4);
    stage.enemylist = [
      ...Array.from({ length: showcase.length ? pause : 0 }, blank),
      ...showcase.map((row) => row.slice()),
    ];
    delete stage.waveRows;
  };

  const kept = holder ? keys.slice(startStage) : ["stage0"];
  const dropped = holder ? keys.slice(0, startStage) : [];
  if (holder) {
    for (const key of keys) delete holder[key];
    allStages.slice(startStage).forEach((stage, i) => {
      rush(stage);
      holder![`stage${i}`] = stage;
    });
    // The flat fields are the editor's copy of one stage: the first one now.
    record.enemylist = holder.stage0.enemylist.map((row: string[]) =>
      row.slice()
    );
  } else {
    // No map: the flat fields ARE the level's single stage.
    rush(record);
  }
  delete record.waveRows;

  // Bosses follow their stages: boss<startStage + i> becomes boss<i>.
  const bosses: string[] = [];
  const bossData = record.bossData && typeof record.bossData === "object"
    ? record.bossData as Record<string, Json>
    : null;
  if (bossData) {
    const bossKeys = numbered(bossData, BOSS_KEY);
    const byIndex = new Map(
      bossKeys.map((key) => [Number(BOSS_KEY.exec(key)![1]), bossData[key]]),
    );
    for (const key of bossKeys) delete bossData[key];
    for (let i = 0; i < kept.length; i++) {
      const boss = byIndex.get(startStage + i);
      if (!boss) continue;
      if (boss.dezaemon && typeof boss.dezaemon === "object") {
        delete boss.dezaemon.row;
      }
      bossData[`boss${i}`] = boss;
      bosses.push(`boss${i}`);
    }
  }

  const bgmStages = record.dezaemonBgm?.stages;
  if (Array.isArray(bgmStages) && startStage > 0) {
    record.dezaemonBgm.stages = bgmStages.slice(startStage);
  }
  if (typeof record.stageKey === "string") record.stageKey = "stage0";
  record.noStory = true;
  delete record.storyData;

  return {
    startStage,
    stages: kept,
    dropped,
    bosses,
    waveRowsCleared,
    enemyTypes,
    showcase,
  };
}

/** One line for a build's log. */
export function describeBossRush(summary: BossRushSummary): string {
  const from = summary.startStage
    ? `from ${summary.stages[0]} (${summary.dropped.join(", ")} cut)`
    : "from the first stage";
  const row = summary.showcase.length
    ? `showcase ${summary.showcase.map((r) => r.join(" ")).join(" / ")}`
    : "no enemies to showcase";
  return `boss rush: ${summary.stages.length} stage${
    summary.stages.length === 1 ? "" : "s"
  } ${from}, ${summary.waveRowsCleared} wave rows replaced by ${row}, bosses ${
    summary.bosses.join(", ") || "none"
  }`;
}
