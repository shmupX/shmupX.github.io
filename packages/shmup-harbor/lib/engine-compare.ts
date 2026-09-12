// The engine comparison as a job: one .sav played on the Saturn (Mednafen)
// and in the shmupX runtime at the same moment, a window of both recorded
// side by side. tools/sav-profiler does the work; this module wraps it for
// two callers that hand the result to a browser —
//
//   - POST /api/engine-compare (routes/api/engine-compare.ts): the machine
//     serving the page runs it and serves the files back, and
//   - the remote builder (lib/export-worker.ts): a paired desktop runs it and
//     uploads the files as a job's artifacts, like any export.
//
// The level is named the way every build names one — a shelf slug, a title,
// a `sav:` path (lib/shelf.ts resolveShelfName) — and a cloud level is turned
// into a cart first with scripts/build-sav.ts, since the Saturn can only play
// a .sav. One comparison runs at a time: the emulator and the browser it
// drives own the screen.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { resolveShelfName, ShelfError, shelfSlug } from "./shelf.ts";
import { buildSav } from "../scripts/build-sav.ts";
import { resolveMednafen } from "./mednafen.ts";
import { packagedBuildRoot } from "./build-workspace.ts";
import { defaults, profile } from "../tools/sav-profiler/main.ts";
import { findChrome } from "../tools/sav-profiler/lib/web.ts";

export class CompareError extends Error {
  override name = "CompareError";
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface CompareRequest {
  /** The level: shelf slug / title / `sav:` path / cloud level name. */
  source: string;
  /** Seconds after Start where the window begins. */
  from?: number;
  /** Window length in seconds. */
  len?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface CompareResult {
  name: string;
  runDir: string;
  video: string | null;
  sheet: string | null;
  moment: string | null;
  reportMd: string;
  reportJson: string;
  /** Seconds after Start where the window began, and its length. */
  from: number;
  len: number;
  gameStartedAfterMs: number | null;
  saturnLagSec: number;
}

/** The files of a result, in the order a viewer wants them. */
export function resultFiles(r: CompareResult): string[] {
  return [r.video, r.sheet, r.moment, r.reportMd].filter((p): p is string =>
    !!p
  );
}

/** Where comparisons run when nothing says otherwise: beside the builds. */
export function compareRoot(): string {
  return join(packagedBuildRoot(), "profiler");
}

export interface CompareCapability {
  available: boolean;
  reasons: string[];
  platform: string;
  mednafen: boolean;
  chrome: boolean;
  ffmpeg: boolean;
}

async function commandRuns(bin: string, args: string[]): Promise<boolean> {
  try {
    const out = await new Deno.Command(bin, {
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** Can this machine run a comparison at all? Says what is missing. */
export async function compareCapabilities(): Promise<CompareCapability> {
  const reasons: string[] = [];
  const platform = Deno.build.os;
  if (platform !== "darwin") {
    reasons.push(
      "the Saturn driver posts keys with CGEvent, which is macOS only",
    );
  }
  const m = await resolveMednafen();
  if (!m.available) reasons.push(m.reason ?? "Mednafen or the disc is missing");
  let chrome = true;
  try {
    await findChrome();
  } catch (e) {
    chrome = false;
    reasons.push((e as Error).message);
  }
  const ffmpeg = await commandRuns("ffmpeg", ["-version"]) &&
    await commandRuns("ffprobe", ["-version"]);
  if (!ffmpeg) reasons.push("ffmpeg and ffprobe are needed to cut the frames");
  return {
    available: reasons.length === 0,
    reasons,
    platform,
    mednafen: m.available,
    chrome,
    ffmpeg,
  };
}

/**
 * The .sav for `source`: a cart the shelf resolver finds as it is, or a cloud
 * level built into one.
 */
export async function resolveCompareSav(
  source: string,
  log: (line: string) => void = () => {},
): Promise<{ savFile: string; name: string }> {
  const typed = String(source ?? "").trim();
  if (!typed) throw new CompareError("no level was named");
  let hit;
  try {
    hit = await resolveShelfName(typed);
  } catch (e) {
    if (e instanceof ShelfError) throw new CompareError(e.message, 404);
    throw e;
  }
  log(hit.note);
  if (hit.savFile) return { savFile: hit.savFile, name: hit.levelName };
  // A cloud level: the Saturn needs a cart, so build one the way
  // `deno task build:sav` does.
  const out = join(compareRoot(), "sav");
  await ensureDir(out);
  const built = await buildSav({ level: hit.levelName, out, log });
  return { savFile: built.outPath, name: hit.levelName };
}

/** Run one comparison to completion. */
export async function runCompare(req: CompareRequest): Promise<CompareResult> {
  const log = req.log ?? (() => {});
  const from = Number.isFinite(req.from) ? Number(req.from) : 44;
  const len = Number.isFinite(req.len) ? Number(req.len) : 5;
  if (from < 0 || from > 600 || len <= 0 || len > 60) {
    throw new CompareError(
      "the window must start within 0-600 s and last 1-60 s",
    );
  }
  const { savFile, name } = await resolveCompareSav(req.source, log);
  if (req.signal?.aborted) throw new CompareError("cancelled", 499);
  const r = await profile({
    ...defaults(),
    sav: savFile,
    from,
    len,
    out: compareRoot(),
    log,
  });
  return {
    name: r.name || name,
    runDir: r.runDir,
    video: r.video,
    sheet: r.sheet,
    moment: r.moment,
    reportMd: join(r.runDir, "report.md"),
    reportJson: join(r.runDir, "report.json"),
    from,
    len,
    gameStartedAfterMs: r.gameStartedAfterMs,
    saturnLagSec: r.saturnLagSec,
  };
}

// ---- the local job registry (the API route's half) --------------------------

export type CompareStatus = "running" | "done" | "failed";

export interface CompareJob {
  id: string;
  source: string;
  from: number;
  len: number;
  status: CompareStatus;
  progress: string;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: CompareResult | null;
}

const JOBS_KEY = Symbol.for("shmupx.compareJobs");
const g = globalThis as unknown as Record<symbol, Map<string, CompareJob>>;
const jobs: Map<string, CompareJob> = g[JOBS_KEY] ??= new Map();

export function getCompareJob(id: string): CompareJob | null {
  return jobs.get(id) ?? null;
}

export function runningCompareJob(): CompareJob | null {
  for (const j of jobs.values()) if (j.status === "running") return j;
  return null;
}

/** The job as the browser sees it: no absolute paths, a bounded log. */
export function publicCompareJob(job: CompareJob): Record<string, unknown> {
  const files = job.result ? resultFiles(job.result) : [];
  return {
    id: job.id,
    source: job.source,
    from: job.from,
    len: job.len,
    status: job.status,
    progress: job.progress,
    log: job.log.slice(-40),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result
      ? {
        name: job.result.name,
        files: files.map((p) => p.slice(p.lastIndexOf("/") + 1)),
        gameStartedAfterMs: job.result.gameStartedAfterMs,
        saturnLagSec: job.result.saturnLagSec,
      }
      : null,
  };
}

/** The absolute path of one of a finished job's files, by its base name. */
export function compareJobFile(job: CompareJob, name: string): string | null {
  if (!job.result) return null;
  for (const p of resultFiles(job.result)) {
    if (p.slice(p.lastIndexOf("/") + 1) === name) return p;
  }
  if (name === "report.json") return job.result.reportJson;
  return null;
}

/** Start a comparison in the background; answers at once with the job. */
export function startCompare(
  req: Omit<CompareRequest, "log" | "signal">,
): CompareJob {
  if (runningCompareJob()) {
    throw new CompareError(
      "a comparison is already running on this machine",
      409,
    );
  }
  const id = `${Date.now().toString(36)}-${
    Math.random().toString(36).slice(2, 8)
  }`;
  const job: CompareJob = {
    id,
    source: String(req.source ?? "").trim(),
    from: Number.isFinite(req.from) ? Number(req.from) : 44,
    len: Number.isFinite(req.len) ? Number(req.len) : 5,
    status: "running",
    progress: "starting",
    log: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
  };
  jobs.set(id, job);
  // Keep the registry small: a dozen finished jobs is plenty for a viewer.
  const finished = [...jobs.values()].filter((j) => j.status !== "running");
  for (const old of finished.slice(0, Math.max(0, finished.length - 12))) {
    jobs.delete(old.id);
  }
  const log = (line: string) => {
    job.log.push(line);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    job.progress = line;
  };
  runCompare({ source: job.source, from: job.from, len: job.len, log })
    .then((result) => {
      job.result = result;
      job.status = "done";
      job.progress = "ready";
    })
    .catch((e) => {
      job.status = "failed";
      job.error = (e as Error).message;
      job.progress = "failed";
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

/** The slug a comparison job's artifacts are filed under. */
export function compareSlug(source: string): string {
  return shelfSlug(String(source ?? "").replace(/^sav:/, "")) || "compare";
}
