// lib/store-shots.ts — CAPTURE SCREENSHOTS on the PUBLISH panel: one
// testdrive recording of the game, cut into a still at every size the picked
// stores want.
//
// The recording is scripts/testdrive-parity.ts's web pane — the tool-assisted
// pilot playing the level's boss on the web runtime, kept as panes/web.mp4 —
// run with `--targets web` alone, so no emulator is started. ffmpeg then
// takes one frame out of the middle of the fight and fits it to each store's
// size: scaled with nearest-neighbour (it is pixel art), letterboxed in black
// where the aspect differs (the web pane is a 256×480 portrait, a Steam
// header is not). The stills land in build/publish/<slug>/shots/<store>/, with
// a manifest beside them so the panel can show what is there after a reload.
//
// What becomes of them: the App Store ones ride up with the next publish
// (the editor writes them into the game's store listing, which the review
// step of ios-publish.yml reads); the Steam and itch.io ones are downloads,
// since neither store takes page art over its upload tool.
//
// A capture is a background job: the route starts one, the panel polls it.
// This module keeps the jobs and knows the command lines; the route is the
// HTTP face. The tool-and-ffmpeg dependency is the same one the parity rig
// already has (scripts/lib/testdrive-rig.ts), and a machine without either
// gets the tail of the log as the reason.

import { join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { slugFor } from "@shmupx/shmup-harbor/export";
import type { StoreId } from "./store-publish.ts";

export interface ShotSize {
  key: string;
  label: string;
  w: number;
  h: number;
}

/** The sizes each store's page or listing takes, in the panel's order. */
export const SHOT_SIZES: Record<StoreId, ShotSize[]> = {
  ios: [
    { key: "iphone-67", label: "APP STORE 6.7″", w: 1290, h: 2796 },
    { key: "iphone-65", label: "APP STORE 6.5″", w: 1284, h: 2778 },
  ],
  steam: [
    { key: "capsule", label: "STEAM CAPSULE", w: 616, h: 353 },
    { key: "header", label: "STEAM HEADER", w: 460, h: 215 },
    { key: "shot", label: "STEAM SHOT", w: 1920, h: 1080 },
  ],
  itch: [
    { key: "cover", label: "ITCH COVER", w: 630, h: 500 },
    { key: "shot", label: "ITCH SHOT", w: 1920, h: 1080 },
  ],
};

/** App Store Connect's name for each iOS size, for the review step. */
export const ASC_DISPLAY_TYPES: Record<string, string> = {
  "iphone-67": "APP_IPHONE_67",
  "iphone-65": "APP_IPHONE_65",
};

export interface Shot extends ShotSize {
  store: StoreId;
  /** build/publish/<slug>/shots/<store>/<key>.png, relative to the publish root. */
  path: string;
}

export function shotPathFor(slug: string, store: StoreId, key: string): string {
  return `${slug}/shots/${store}/${key}.png`;
}

/** Every still a capture cuts, whichever stores are picked. */
export function allShots(slug: string): Shot[] {
  const out: Shot[] = [];
  for (const store of Object.keys(SHOT_SIZES) as StoreId[]) {
    for (const size of SHOT_SIZES[store]) {
      out.push({ ...size, store, path: shotPathFor(slug, store, size.key) });
    }
  }
  return out;
}

/**
 * The parity script, web pane only, into the publish folder. One attempt
 * with its frames kept: a boss whose window never completes (one that fires
 * nothing, say) would otherwise cost three runs and leave no frame at all,
 * and the raw screencast is as good a still as the clip. The frames are
 * removed again once the stills are cut.
 */
export function captureArgs(level: string, outDir: string): string[] {
  return [
    "run",
    "-A",
    "scripts/testdrive-parity.ts",
    level,
    "--targets",
    "web",
    "--attempts",
    "1",
    "--keep-frames",
    "--max-mb",
    "0",
    "--out",
    outDir,
  ];
}

/**
 * One frame at `at` seconds, fitted to w×h: scaled to fit with
 * nearest-neighbour, then padded to the exact size.
 */
export function stillArgs(
  input: string,
  size: { w: number; h: number },
  at: number,
  output: string,
): string[] {
  const { w, h } = size;
  return [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    at.toFixed(2),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=neighbor,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-update",
    "1",
    output,
  ];
}

export type CaptureStatus = "recording" | "cutting" | "done" | "failed";

export interface CaptureJob {
  id: string;
  level: string;
  slug: string;
  status: CaptureStatus;
  startedAt: number;
  finishedAt: number | null;
  /** One line for the panel's note. */
  note: string;
  /** The last lines of the tool's output, for a failure. */
  log: string[];
  shots: Shot[];
  /** The clip the stills were cut from, relative to the publish root. */
  clip: string | null;
}

export interface Manifest {
  level: string;
  slug: string;
  capturedAt: string;
  clip: string;
  shots: Shot[];
}

export interface CaptureDeps {
  /** Where build/publish is. */
  root: string;
  /** Runs a command to completion; answers its exit code and output tail. */
  run: (
    cmd: string,
    args: string[],
    opts: { cwd: string; onLine?: (line: string) => void },
  ) => Promise<{ code: number; tail: string[] }>;
  now?: () => number;
}

/** The clip's length in seconds, by ffprobe; null when it cannot say. */
export async function clipDuration(
  run: CaptureDeps["run"],
  clip: string,
  cwd: string,
): Promise<number | null> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    clip,
  ], { cwd }).catch(() => null);
  if (!out || out.code !== 0) return null;
  const n = Number((out.tail[out.tail.length - 1] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const TAIL = 40;

/**
 * The frame to cut from when the rig left no clip: the recording window
 * (the boss from --from-hp until every projectile kind has shown) never
 * opens for a boss that fires nothing, and the rig then keeps its raw
 * screencast under frames/web-<attempt>/ instead. The newest attempt's
 * middle frame, or null when there is nothing at all.
 */
export function middleFrame(
  dirs: { name: string; files: string[] }[],
): { dir: string; file: string } | null {
  const attempts = dirs
    .filter((d) =>
      /^web-\d+$/.test(d.name) && d.files.some((f) => /\.png$/i.test(f))
    )
    .sort((a, b) => Number(b.name.slice(4)) - Number(a.name.slice(4)));
  const pick = attempts[0];
  if (!pick) return null;
  const frames = pick.files.filter((f) => /\.png$/i.test(f)).sort();
  return { dir: pick.name, file: frames[Math.floor(frames.length / 2)] };
}

async function rawFrame(outDir: string): Promise<string | null> {
  const dirs: { name: string; files: string[] }[] = [];
  try {
    for await (const d of Deno.readDir(join(outDir, "frames"))) {
      if (!d.isDirectory) continue;
      const files: string[] = [];
      for await (const f of Deno.readDir(join(outDir, "frames", d.name))) {
        if (f.isFile) files.push(f.name);
      }
      dirs.push({ name: d.name, files });
    }
  } catch {
    return null;
  }
  const pick = middleFrame(dirs);
  return pick ? join(outDir, "frames", pick.dir, pick.file) : null;
}

/** Run a command, keeping the last lines of what it printed. */
export const runCapture: CaptureDeps["run"] = async (cmd, args, opts) => {
  const child = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();
  const tail: string[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > TAIL) tail.shift();
        opts.onLine?.(line);
      }
    }
    if (rest.trim()) {
      tail.push(rest);
      if (tail.length > TAIL) tail.shift();
    }
  };
  await Promise.all([read(child.stdout), read(child.stderr)]);
  const status = await child.status;
  return { code: status.code, tail };
};

/** The capture jobs this process has run, by id and by level. */
export class CaptureRegistry {
  private jobs = new Map<string, CaptureJob>();
  constructor(private deps: CaptureDeps) {}

  get(id: string): CaptureJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** The job for a level still going, if any. */
  running(level: string): CaptureJob | null {
    for (const j of this.jobs.values()) {
      if (
        j.level === level &&
        (j.status === "recording" || j.status === "cutting")
      ) {
        return j;
      }
    }
    return null;
  }

  /** Start a capture; the job is answered at once and finishes on its own. */
  start(level: string): CaptureJob {
    const going = this.running(level);
    if (going) return going;
    const now = this.deps.now ?? Date.now;
    const slug = slugFor(level);
    const job: CaptureJob = {
      id: `${slug}-${now().toString(36)}`,
      level,
      slug,
      status: "recording",
      startedAt: now(),
      finishedAt: null,
      note: "The pilot is playing " + level + " on the web runtime…",
      log: [],
      shots: [],
      clip: null,
    };
    this.jobs.set(job.id, job);
    this.work(job).catch((e) => {
      job.status = "failed";
      job.finishedAt = now();
      job.note = (e as Error).message;
    });
    return job;
  }

  private async work(job: CaptureJob): Promise<void> {
    const { root, run } = this.deps;
    const now = this.deps.now ?? Date.now;
    const repo = resolve(root, "..", "..");
    const outDir = join(root, job.slug, "testdrive");
    await ensureDir(outDir);
    const rec = await run(Deno.execPath(), captureArgs(job.level, outDir), {
      cwd: repo,
      onLine: (line) => {
        job.log.push(line);
        if (job.log.length > TAIL) job.log.shift();
        // The rig narrates the fight; the last line is the live note.
        job.note = line.replace(/^\s*\[[^\]]*\]\s*/, "").slice(0, 160);
      },
    });
    // The clip, or — when the rig's window never opened — the middle of its
    // raw screencast; nothing at all means the game never ran.
    let clip = join(outDir, "panes", "web.mp4");
    let fromClip = await exists(clip);
    let raw: string | null = null;
    if (!fromClip) raw = await rawFrame(outDir);
    if (!fromClip && !raw) {
      job.status = "failed";
      job.finishedAt = now();
      job.note = rec.code !== 0
        ? `The testdrive exited ${rec.code}: ` +
          (rec.tail[rec.tail.length - 1] ?? "no output")
        : "The testdrive left no web clip and no frames.";
      return;
    }
    if (!fromClip) {
      clip = raw!;
      fromClip = false;
    }
    job.status = "cutting";
    job.note = "Cutting stills out of the recording…";
    job.clip = fromClip
      ? `${job.slug}/testdrive/panes/web.mp4`
      : `${job.slug}/testdrive/frames/${
        clip.split(/[\\/]/).slice(-2).join("/")
      }`;
    const length = fromClip ? await clipDuration(run, clip, repo) : null;
    // A little past the middle: the boss is on screen and the pilot is busy.
    const at = length ? Math.max(0, length * 0.55) : 0;
    const shots: Shot[] = [];
    for (const shot of allShots(job.slug)) {
      const output = join(root, shot.path);
      await ensureDir(join(root, job.slug, "shots", shot.store));
      const cut = await run("ffmpeg", stillArgs(clip, shot, at, output), {
        cwd: repo,
      });
      if (cut.code !== 0 || !(await exists(output))) {
        job.status = "failed";
        job.finishedAt = now();
        job.note = `ffmpeg could not cut ${shot.label}: ` +
          (cut.tail[cut.tail.length - 1] ?? `exit ${cut.code}`);
        return;
      }
      shots.push(shot);
    }
    const manifest: Manifest = {
      level: job.level,
      slug: job.slug,
      capturedAt: new Date(now()).toISOString(),
      clip: job.clip,
      shots,
    };
    await Deno.writeTextFile(
      join(root, job.slug, "shots", "shots.json"),
      JSON.stringify(manifest, null, 2),
    );
    // The raw screencast is hundreds of megabytes; the stills are cut now.
    await Deno.remove(join(outDir, "frames"), { recursive: true }).catch(
      () => {},
    );
    job.shots = shots;
    job.status = "done";
    job.finishedAt = now();
    job.note = `${job.clip} → ${shots.length} stills, one set per store.` +
      (fromClip
        ? ""
        : " (The boss window never opened — the stills are the middle of the raw screencast.)");
  }
}

/** What an earlier capture left for this level, if anything. */
export async function readManifest(
  root: string,
  level: string,
): Promise<Manifest | null> {
  const slug = slugFor(level);
  try {
    const text = await Deno.readTextFile(
      join(root, slug, "shots", "shots.json"),
    );
    const m = JSON.parse(text) as Manifest;
    return m && Array.isArray(m.shots) ? m : null;
  } catch {
    return null;
  }
}

/** A still's path on disk, or null when the query reaches outside the root. */
export function containedShot(root: string, rel: string): string | null {
  if (!/^[a-z0-9-]+\/shots\/(ios|steam|itch)\/[a-z0-9-]+\.png$/.test(rel)) {
    return null;
  }
  const full = resolve(root, rel);
  const base = resolve(root);
  return full.startsWith(base + "\\") || full.startsWith(base + "/")
    ? full
    : null;
}
