// lib/export-worker.ts — the desktop end of the remote export queue.
//
// A phone, a browser on the hosted site or the installed PWA cannot build an
// APK or a PS2 disc: /api/build-apk refuses on the read-only Deploy origin, and
// nothing on a phone has cordova or electron-builder anyway. A desktop running
// shmupX (the packaged app, or `deno task dev`) does. This worker is how the
// two meet without either being able to reach the other directly:
//
//   * The desktop mints a BUILD CODE (8 letters, kept in the user's config
//     directory) and heartbeats `exportWorkers/<code>` in the Realtime
//     Database — what it is, which targets its toolchain can build, when it
//     was last seen.
//   * A requester who knows the code writes a job under
//     `exportQueue/<code>/<jobId>` (static/export-queue.js). The code is the
//     whole pairing: whoever has it can queue builds on that desktop.
//   * The worker streams that path over the REST API's server-sent events,
//     claims the oldest queued job with an ETag-conditional write, builds it
//     through lib/export-build.ts — the same code the local EXPORT button
//     uses — and writes the artifact back as base64 chunks under
//     `exportBlobs/<jobId>`, then marks the job done.
//   * The requester's page watches the job, assembles the chunks into a Blob
//     and offers download / install / add-to-library. It sets `received`
//     when it has the bytes, and the worker frees the chunks; unclaimed
//     chunks expire after a day, finished jobs after a week.
//
// WHY THE DATABASE CARRIES THE BYTES. Firebase Storage is the obvious home for
// a 40 MB disc, and the client config even names a bucket — but the project
// has never had one provisioned (the bucket 404s on both bucket-name forms,
// and the editor's own custom-audio upload already warns about exactly that).
// The database is open-write on these paths today, its free tier moves 10 GB
// a month, and it is the one store every surface here already talks to. A
// 512 KB chunk is comfortably under its 10 MB string limit and small enough to
// show progress against. If a bucket appears later, an artifact record can
// carry a `url` instead of `chunks` and the client falls through to fetch().
//
// The worker is a process-wide singleton (keyed on globalThis, so Vite's dev
// module reloads and desktop.ts's own copy of this module share it), started
// by routes/api/export-worker.ts — which the dashboard GETs on boot when it is
// served locally — and by desktop.ts at launch. It never starts on Deploy.

import { encodeBase64 } from "@std/encoding/base64";
import { basename, join } from "@std/path";
import { buildZip, treeEntries } from "./ps2/zip.ts";
import {
  detectExportCapabilities,
  type ExportCapabilities,
  ExportError,
  type ExportOutcome,
  runExport,
} from "./export-build.ts";
import { compareSlug, resultFiles, runCompare } from "./engine-compare.ts";

export const EXPORT_DB = "https://evil-invaders-default-rtdb.firebaseio.com";
// Keep in step with static/export-queue.js (tests/export_queue_test.ts checks).
export const EXPORT_PATHS = {
  workers: "exportWorkers",
  queue: "exportQueue",
  blobs: "exportBlobs",
} as const;
export const CHUNK_BYTES = 512 * 1024;
export const HEARTBEAT_MS = 20_000;
// No I, O, 0 or 1: a code is read off one screen and typed into another.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const WORKER_VERSION = 1;

const BLOB_TTL_MS = 24 * 3600_000;
const JOB_TTL_MS = 7 * 24 * 3600_000;
const PRUNE_EVERY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 2;
const LOG_TAIL = 6000;
const UPLOAD_PARALLEL = 3;

export type JobStatus = "queued" | "building" | "done" | "failed" | "cancelled";

export interface JobArtifact {
  name: string;
  size: number;
  /** iso | usb-zip | apk | exe | msi | appimage | ipa | dmg | zip | file */
  kind: string;
  contentType: string;
  chunks: number;
  chunkBytes: number;
  /** Database path of the chunk list: exportBlobs/<jobId>/<index>. */
  path: string;
}

export interface ExportJob {
  id: string;
  level: string;
  platform: string;
  /**
   * What the desktop should do with `level`: build it (absent, or "export"),
   * or "engine-compare" — play it on the Saturn and in the runtime at once
   * and upload the recording pair (lib/engine-compare.ts). `platform` reads
   * "compare" for those, which no build target answers to.
   */
  kind?: "export" | "engine-compare";
  /** The kind's own parameters (a comparison's `from` and `for`, seconds). */
  options?: Record<string, unknown>;
  requester?: string;
  requesterLabel?: string;
  requestedAt: number;
  status: JobStatus;
  progress?: string;
  log?: string;
  error?: string;
  worker?: string;
  workerName?: string;
  claimedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt?: number;
  attempts?: number;
  artifacts?: JobArtifact[];
  slug?: string;
  received?: number;
  blobsFreed?: boolean;
}

export interface WorkerConfig {
  code: string;
  name: string;
  enabled: boolean;
  createdAt: number;
}

export interface JobSummary {
  id: string;
  level: string;
  platform: string;
  status: JobStatus;
  requesterLabel?: string;
  finishedAt: number;
  durationMs: number;
  error?: string;
}

export interface WorkerStatus {
  running: boolean;
  enabled: boolean;
  code: string;
  name: string;
  db: string;
  os: string;
  arch: string;
  platforms: Record<string, boolean>;
  notes: string[];
  startedAt: number | null;
  connected: boolean;
  current: {
    id: string;
    level: string;
    platform: string;
    startedAt: number;
    progress: string;
  } | null;
  queued: number;
  history: JobSummary[];
  lastError: string;
  configPath: string;
}

// ── Pure helpers (tested in tests/export_queue_test.ts) ───────────────────────

export function newBuilderCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Upper-case, drop separators, and answer "" unless it is a well-formed code. */
export function normalizeBuilderCode(raw: string): string {
  const code = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return "";
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return "";
  return code;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Split whatever has arrived on an SSE stream into the complete events it
 * holds, and hand back the trailing partial block to prepend to the next read.
 */
export function parseSseChunk(
  buffer: string,
): { events: SseEvent[]; rest: string } {
  const text = buffer.replaceAll("\r\n", "\n");
  const events: SseEvent[] = [];
  let at = 0;
  for (;;) {
    const end = text.indexOf("\n\n", at);
    if (end < 0) break;
    const block = text.slice(at, end);
    at = end + 2;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (block.trim()) events.push({ event, data: data.join("\n") });
  }
  return { events, rest: text.slice(at) };
}

type Tree = Record<string, unknown>;

/**
 * Apply one REST-streaming event to a local mirror of the watched subtree.
 * `path` is relative to the subtree ("/" is the whole thing); a `put` replaces
 * what is there, a `patch` merges one level of keys. Null deletes, as in the
 * database itself.
 */
export function applyAtPath(
  root: Tree,
  path: string,
  data: unknown,
  merge: boolean,
): Tree {
  const keys = path.split("/").filter(Boolean);
  if (keys.length === 0) {
    if (merge) return { ...root, ...(data as Tree ?? {}) };
    return (data as Tree) ?? {};
  }
  const next: Tree = { ...root };
  let node: Tree = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const child = node[keys[i]];
    const copy: Tree = child && typeof child === "object"
      ? { ...(child as Tree) }
      : {};
    node[keys[i]] = copy;
    node = copy;
  }
  const last = keys[keys.length - 1];
  if (merge) {
    const existing = node[last];
    node[last] = {
      ...(existing && typeof existing === "object" ? existing as Tree : {}),
      ...(data as Tree ?? {}),
    };
  } else if (data === null || data === undefined) delete node[last];
  else node[last] = data;
  return next;
}

/** The oldest queued job. Ids sort chronologically (static/export-queue.js). */
export function pickNextJob(
  jobs: Record<string, ExportJob | undefined>,
): ExportJob | null {
  const queued = Object.entries(jobs)
    .filter(([, job]) => job && job.status === "queued")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return queued.length ? queued[0][1] ?? null : null;
}

/**
 * Which finished jobs have chunks to free (collected, or a day old) and which
 * are old enough to forget entirely.
 */
export function jobsToPrune(
  jobs: Record<string, ExportJob | undefined>,
  now: number,
): { freeBlobs: string[]; remove: string[] } {
  const freeBlobs: string[] = [];
  const remove: string[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!job) continue;
    if (job.status === "queued" || job.status === "building") continue;
    const finished = job.finishedAt ?? job.requestedAt ?? 0;
    if (finished + JOB_TTL_MS < now) {
      remove.push(id);
      continue;
    }
    if (job.artifacts?.length && !job.blobsFreed) {
      if (job.received || finished + BLOB_TTL_MS < now) freeBlobs.push(id);
    }
  }
  return { freeBlobs, remove };
}

export function artifactKind(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "iso") return "iso";
  if (ext === "apk") return "apk";
  if (ext === "exe") return "exe";
  // The per-game Windows export is an .msi: deno desktop has no single-file
  // .exe output, so an installer is what stands in for the portable one.
  if (ext === "msi") return "msi";
  if (ext === "appimage") return "appimage";
  if (ext === "ipa") return "ipa";
  if (ext === "dmg") return "dmg";
  if (ext === "zip") return "zip";
  // An engine comparison's files: the side-by-side clip, its contact sheet
  // and the strongest moment, and the written report.
  if (ext === "mp4") return "video";
  if (ext === "png") return "image";
  if (ext === "md") return "text";
  return "file";
}

const CONTENT_TYPES: Record<string, string> = {
  iso: "application/x-iso9660-image",
  apk: "application/vnd.android.package-archive",
  msi: "application/x-msi",
  zip: "application/zip",
  "usb-zip": "application/zip",
  video: "video/mp4",
  image: "image/png",
  text: "text/markdown; charset=utf-8",
};

// ── Config ────────────────────────────────────────────────────────────────────

/** Where the build code lives between runs, per platform convention. */
export function configDir(): string {
  const env = Deno.env.toObject();
  const home = env.HOME || env.USERPROFILE || ".";
  if (Deno.build.os === "windows") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "shmupX");
  }
  if (Deno.build.os === "darwin") {
    return join(home, "Library", "Application Support", "shmupX");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "shmupx");
}

function configPath(): string {
  return join(configDir(), "export-worker.json");
}

function hostName(): string {
  try {
    return Deno.hostname();
  } catch {
    return "shmupX desktop";
  }
}

async function loadConfig(): Promise<WorkerConfig> {
  let cfg: Partial<WorkerConfig> = {};
  try {
    cfg = JSON.parse(await Deno.readTextFile(configPath()));
  } catch { /* first run */ }
  const config: WorkerConfig = {
    code: normalizeBuilderCode(cfg.code ?? "") || newBuilderCode(),
    name: typeof cfg.name === "string" && cfg.name.trim()
      ? cfg.name.trim().slice(0, 40)
      : hostName(),
    enabled: cfg.enabled !== false,
    createdAt: typeof cfg.createdAt === "number" ? cfg.createdAt : Date.now(),
  };
  if (!cfg.code || cfg.code !== config.code) await saveConfig(config);
  // A fixed code for a test rig or a CI box, never written back to disk.
  const forced = normalizeBuilderCode(Deno.env.get("SHMUPX_BUILD_CODE") ?? "");
  if (forced) config.code = forced;
  return config;
}

async function saveConfig(config: WorkerConfig): Promise<void> {
  try {
    await Deno.mkdir(configDir(), { recursive: true });
    await Deno.writeTextFile(
      configPath(),
      JSON.stringify(config, null, 2) + "\n",
    );
  } catch (e) {
    console.warn(
      `export worker: could not save ${configPath()}: ${(e as Error).message}`,
    );
  }
}

// ── Database REST ─────────────────────────────────────────────────────────────

function dbUrl(path: string): string {
  return `${EXPORT_DB}/${path}.json`;
}

async function dbGet<T>(
  path: string,
  wantEtag = false,
): Promise<{ data: T | null; etag: string }> {
  const res = await fetch(dbUrl(path), {
    headers: wantEtag ? { "X-Firebase-ETag": "true" } : {},
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return { data: await res.json(), etag: res.headers.get("etag") ?? "" };
}

/** PUT; with an etag it is conditional and answers false on a mismatch. */
async function dbPut(
  path: string,
  value: unknown,
  etag?: string,
): Promise<boolean> {
  const res = await fetch(dbUrl(path), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: JSON.stringify(value),
  });
  if (res.status === 412) {
    await res.body?.cancel();
    return false;
  }
  if (!res.ok) throw new Error(`PUT ${path}: HTTP ${res.status}`);
  await res.body?.cancel();
  return true;
}

async function dbPatch(path: string, value: Tree): Promise<void> {
  const res = await fetch(dbUrl(path), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: HTTP ${res.status}`);
  await res.body?.cancel();
}

async function dbDelete(path: string): Promise<void> {
  const res = await fetch(dbUrl(path), { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path}: HTTP ${res.status}`);
  await res.body?.cancel();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ── The worker ────────────────────────────────────────────────────────────────

interface Upload {
  name: string;
  kind: string;
  bytes: Uint8Array;
}

/**
 * An engine comparison as the worker's outcome: the same shape a build
 * answers with, so the upload, the verdict and the history need no second
 * path. The paired desktop plays the level on its own screen.
 */
async function runCompareOutcome(
  job: ExportJob,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<ExportOutcome> {
  const o = job.options ?? {};
  const r = await runCompare({
    source: job.level,
    from: typeof o.from === "number" ? o.from : undefined,
    len: typeof o.for === "number" ? o.for : undefined,
    log,
    signal,
  });
  return {
    level: job.level,
    platform: "compare",
    slug: compareSlug(job.level),
    artifacts: resultFiles(r),
    log: "",
  } as ExportOutcome;
}

export class ExportWorker {
  private config: WorkerConfig | null = null;
  private caps: ExportCapabilities = { platforms: {}, notes: [] };
  private abort: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private snapshot: Record<string, ExportJob | undefined> = {};
  private history: JobSummary[] = [];
  private startedAt: number | null = null;
  private starting: Promise<void> | null = null;
  running = false;
  connected = false;
  lastError = "";
  current: WorkerStatus["current"] = null;

  get code(): string {
    return this.config?.code ?? "";
  }

  status(): WorkerStatus {
    const queued = Object.values(this.snapshot)
      .filter((job) => job?.status === "queued").length;
    return {
      running: this.running,
      enabled: this.config?.enabled ?? true,
      code: this.code,
      name: this.config?.name ?? "",
      db: EXPORT_DB,
      os: Deno.build.os,
      arch: Deno.build.arch,
      platforms: this.caps.platforms,
      notes: this.caps.notes,
      startedAt: this.startedAt,
      connected: this.connected,
      current: this.current,
      queued,
      history: this.history,
      lastError: this.lastError,
      configPath: configPath(),
    };
  }

  /** Start unless the user switched the worker off (or the env did). */
  async autoStart(): Promise<void> {
    if (this.running) return;
    if (Deno.env.get("SHMUPX_EXPORT_WORKER") === "0") return;
    if (!this.config) this.config = await loadConfig();
    if (!this.config.enabled) return;
    await this.start();
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (!this.config) this.config = await loadConfig();
        this.abort = new AbortController();
        this.running = true;
        this.startedAt = Date.now();
        this.lastError = "";
        this.caps = await detectExportCapabilities();
        await this.recoverStale();
        await this.heartbeat();
        this.heartbeatTimer = setInterval(
          () => this.heartbeat(),
          HEARTBEAT_MS,
        );
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
        this.prune();
        this.streamLoop();
        console.log(
          `\n  Build server ON — BUILD CODE ${formatBuilderCode(this.code)}` +
            `\n  targets: ${this.targetList() || "none detected"}\n`,
        );
      } catch (e) {
        this.running = false;
        this.lastError = (e as Error).message;
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.connected = false;
    this.abort?.abort();
    this.abort = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    this.heartbeatTimer = this.pruneTimer = null;
    try {
      await dbPatch(`${EXPORT_PATHS.workers}/${this.code}`, {
        stoppedAt: Date.now(),
        busy: null,
      });
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.config) this.config = await loadConfig();
    if (this.config.enabled !== enabled) {
      this.config.enabled = enabled;
      await saveConfig(this.config);
    }
  }

  async rename(name: string): Promise<void> {
    if (!this.config) this.config = await loadConfig();
    const clean = String(name ?? "").trim().slice(0, 40);
    if (!clean) return;
    this.config.name = clean;
    await saveConfig(this.config);
    if (this.running) await this.heartbeat();
  }

  /** A fresh code: whoever had the old one can no longer queue here. */
  async regenerateCode(): Promise<void> {
    const wasRunning = this.running;
    await this.stop();
    if (!this.config) this.config = await loadConfig();
    try {
      await dbDelete(`${EXPORT_PATHS.workers}/${this.config.code}`);
    } catch { /* it may never have been written */ }
    this.config.code = newBuilderCode();
    await saveConfig(this.config);
    this.snapshot = {};
    if (wasRunning) await this.start();
  }

  private targetList(): string {
    return Object.entries(this.caps.platforms)
      .filter(([, ok]) => ok)
      .map(([p]) => p.toUpperCase())
      .join(" ");
  }

  private async heartbeat(): Promise<void> {
    if (!this.running || !this.config) return;
    try {
      await dbPatch(`${EXPORT_PATHS.workers}/${this.code}`, {
        name: this.config.name,
        os: Deno.build.os,
        arch: Deno.build.arch,
        platforms: this.caps.platforms,
        notes: this.caps.notes,
        version: WORKER_VERSION,
        startedAt: this.startedAt,
        seenAt: Date.now(),
        stoppedAt: null,
        busy: this.current
          ? {
            id: this.current.id,
            level: this.current.level,
            platform: this.current.platform,
          }
          : null,
      });
    } catch (e) {
      this.lastError = `heartbeat: ${(e as Error).message}`;
    }
  }

  // A job this same desktop was building when it last went away is queued
  // again — once. Twice in a row is a build that kills the app, and that goes
  // to the requester as a failure rather than looping.
  private async recoverStale(): Promise<void> {
    const { data } = await dbGet<Record<string, ExportJob>>(
      `${EXPORT_PATHS.queue}/${this.code}`,
    );
    this.snapshot = data ?? {};
    for (const job of Object.values(this.snapshot)) {
      if (!job || job.status !== "building" || job.worker !== this.code) {
        continue;
      }
      const attempts = (job.attempts ?? 0) + 1;
      const patch: Tree = attempts < MAX_ATTEMPTS
        ? {
          status: "queued",
          attempts,
          progress: "the desktop went away mid-build — queued again",
          updatedAt: Date.now(),
        }
        : {
          status: "failed",
          attempts,
          error: "the desktop stopped twice while building this — see its log",
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        };
      try {
        await dbPatch(`${EXPORT_PATHS.queue}/${this.code}/${job.id}`, patch);
        Object.assign(job, patch);
      } catch (e) {
        this.lastError = (e as Error).message;
      }
    }
  }

  private async streamLoop(): Promise<void> {
    const signal = this.abort?.signal;
    let backoff = 1000;
    while (this.running && signal && !signal.aborted) {
      try {
        const res = await fetch(dbUrl(`${EXPORT_PATHS.queue}/${this.code}`), {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) {
          await res.body?.cancel();
          throw new Error(`stream: HTTP ${res.status}`);
        }
        this.connected = true;
        backoff = 1000;
        const decoder = new TextDecoder();
        let rest = "";
        for await (const chunk of res.body) {
          const parsed = parseSseChunk(
            rest + decoder.decode(chunk, { stream: true }),
          );
          rest = parsed.rest;
          for (const ev of parsed.events) this.onEvent(ev);
        }
      } catch (e) {
        if (!this.running) break;
        this.lastError = `stream: ${(e as Error).message}`;
      }
      this.connected = false;
      if (!this.running) break;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private onEvent(ev: SseEvent): void {
    if (ev.event === "keep-alive") return;
    if (ev.event === "cancel" || ev.event === "auth_revoked") {
      throw new Error(`stream ${ev.event}`);
    }
    if (ev.event !== "put" && ev.event !== "patch") return;
    let body: { path?: string; data?: unknown };
    try {
      body = JSON.parse(ev.data);
    } catch {
      return;
    }
    this.snapshot = applyAtPath(
      this.snapshot as Tree,
      body.path ?? "/",
      body.data ?? null,
      ev.event === "patch",
    ) as Record<string, ExportJob | undefined>;
    this.maybeRun();
  }

  private maybeRun(): void {
    if (!this.running || this.current) return;
    const job = pickNextJob(this.snapshot);
    if (!job) return;
    // Reserve the slot synchronously: the next event must not start a second
    // build while this one is still claiming.
    this.current = {
      id: job.id,
      level: job.level,
      platform: job.platform,
      startedAt: Date.now(),
      progress: "claiming…",
    };
    this.claim(job).then((claimed) => {
      if (!claimed) {
        this.current = null;
        this.maybeRun();
        return;
      }
      return this.run(job);
    }).catch((e) => {
      this.lastError = (e as Error).message;
      this.current = null;
    });
  }

  // The database has no transactions over REST, but it has ETags: read the
  // job, and write it back only if nobody else has in the meantime. Two
  // desktops sharing one code (a copied config file) therefore never build
  // the same job twice.
  private async claim(job: ExportJob): Promise<boolean> {
    const path = `${EXPORT_PATHS.queue}/${this.code}/${job.id}`;
    const { data, etag } = await dbGet<ExportJob>(path, true);
    if (!data || data.status !== "queued") return false;
    const now = Date.now();
    const claimed: ExportJob = {
      ...data,
      status: "building",
      worker: this.code,
      workerName: this.config?.name ?? "",
      claimedAt: now,
      startedAt: now,
      updatedAt: now,
      progress: `claimed by ${this.config?.name ?? "the desktop"}`,
    };
    const ok = await dbPut(path, claimed, etag);
    if (ok) this.snapshot[job.id] = claimed;
    return ok;
  }

  private patchJob(id: string, patch: Tree): Promise<void> {
    const existing = this.snapshot[id];
    if (existing) Object.assign(existing, patch);
    return dbPatch(`${EXPORT_PATHS.queue}/${this.code}/${id}`, patch);
  }

  private async run(job: ExportJob): Promise<void> {
    const started = Date.now();
    const lines: string[] = [];
    let pendingLine: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushInFlight: Promise<void> = Promise.resolve();
    // Progress goes up at most once a second: a cordova build is thousands of
    // lines, and each one is a write somebody's phone is streaming.
    const flush = () => {
      flushTimer = null;
      if (pendingLine === null) return;
      const line = pendingLine;
      pendingLine = null;
      flushInFlight = this.patchJob(job.id, {
        progress: line,
        updatedAt: Date.now(),
      }).catch(() => {});
    };
    // Before the verdict goes up: drop a progress line still waiting, and let
    // one already on the wire land first, so it cannot overwrite the verdict's
    // own fields after the fact.
    const settle = async () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      pendingLine = null;
      await flushInFlight;
    };
    const log = (line: string) => {
      lines.push(line);
      if (lines.length > 2000) lines.splice(0, lines.length - 2000);
      if (this.current) this.current.progress = line;
      pendingLine = line;
      if (flushTimer === null) flushTimer = setTimeout(flush, 1000);
    };
    const tail = () => lines.join("\n").slice(-LOG_TAIL);
    const signal = this.abort?.signal;
    let outcome: "done" | "failed" | "requeued" = "failed";
    let error = "";
    try {
      let built: ExportOutcome;
      if (job.kind === "engine-compare") {
        log(`comparing "${job.level}" on the Saturn and in the runtime`);
        built = await runCompareOutcome(job, log, signal);
      } else {
        log(`building "${job.level}" for ${job.platform}`);
        built = await runExport({
          level: job.level,
          platform: job.platform,
          log,
          signal,
        });
      }
      const artifacts = await this.uploadArtifacts(job, built, log);
      await settle();
      await this.patchJob(job.id, {
        status: "done",
        platform: built.platform,
        slug: built.slug,
        artifacts,
        progress: "ready",
        log: tail(),
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      });
      outcome = "done";
    } catch (e) {
      await settle();
      error = (e as Error).message;
      const extra = e instanceof ExportError && e.log ? "\n" + e.log : "";
      const attempts = (job.attempts ?? 0) + 1;
      if (signal?.aborted && attempts < MAX_ATTEMPTS) {
        // Stopped by the user (or the app closing) mid-build: not the job's
        // fault, so it goes back on the queue for the next start.
        outcome = "requeued";
        await dbPatch(`${EXPORT_PATHS.queue}/${this.code}/${job.id}`, {
          status: "queued",
          attempts,
          progress: "the desktop stopped mid-build — queued again",
          updatedAt: Date.now(),
        }).catch(() => {});
      } else {
        await dbPatch(`${EXPORT_PATHS.queue}/${this.code}/${job.id}`, {
          status: "failed",
          attempts,
          error,
          log: (tail() + extra).slice(-LOG_TAIL),
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        }).catch((err) => {
          this.lastError = (err as Error).message;
        });
      }
    } finally {
      if (outcome !== "requeued") {
        this.history.unshift({
          id: job.id,
          level: job.level,
          platform: job.platform,
          status: outcome,
          requesterLabel: job.requesterLabel,
          finishedAt: Date.now(),
          durationMs: Date.now() - started,
          ...(error ? { error } : {}),
        });
        this.history.splice(12);
      }
      this.current = null;
      this.heartbeat();
      this.maybeRun();
    }
  }

  // Everything a requester could want from the build, as one upload each.
  private async collectUploads(
    built: ExportOutcome,
    log: (line: string) => void,
  ): Promise<Upload[]> {
    const uploads: Upload[] = [];
    if (built.ps2) {
      if (built.ps2.isoPath) {
        uploads.push({
          name: basename(built.ps2.isoPath),
          kind: "iso",
          bytes: await Deno.readFile(built.ps2.isoPath),
        });
      }
      if (built.ps2.appDir) {
        log(`zipping the USB folder ${basename(built.ps2.appDir)}`);
        // Fixed timestamp, like every other archive this repo writes, so the
        // same export uploaded twice is the same file.
        const zip = await buildZip(
          await treeEntries(built.ps2.appDir),
          new Date("2000-03-04T00:00:00Z"),
        );
        uploads.push({
          name: `${basename(built.ps2.appDir)}.zip`,
          kind: "usb-zip",
          bytes: zip,
        });
      }
      return uploads;
    }
    for (const path of built.artifacts) {
      // Not every artifact is a file: a macOS `deno desktop` build is a
      // <slug>.app BUNDLE, and Deno.readFile on a directory throws — so the job
      // died at the upload with an IsADirectory error after the build itself had
      // gone perfectly. Zip a directory the way the PS2 USB folder above is
      // zipped; unpacking it anywhere reproduces the folder.
      const stat = await Deno.stat(path);
      if (stat.isDirectory) {
        log(`zipping ${basename(path)}`);
        const zip = await buildZip(
          await treeEntries(path),
          new Date("2000-03-04T00:00:00Z"),
        );
        uploads.push({
          name: `${basename(path)}.zip`,
          kind: "zip",
          bytes: zip,
        });
        continue;
      }
      uploads.push({
        name: basename(path),
        kind: artifactKind(path),
        bytes: await Deno.readFile(path),
      });
    }
    return uploads;
  }

  private async uploadArtifacts(
    job: ExportJob,
    built: ExportOutcome,
    log: (line: string) => void,
  ): Promise<JobArtifact[]> {
    const uploads = await this.collectUploads(built, log);
    if (!uploads.length) {
      throw new ExportError(
        "The build finished but produced nothing to upload.",
        500,
        built.log,
      );
    }
    const records: JobArtifact[] = [];
    for (let ai = 0; ai < uploads.length; ai++) {
      const up = uploads[ai];
      const path = `${EXPORT_PATHS.blobs}/${job.id}/${ai}`;
      const chunks = Math.ceil(up.bytes.length / CHUNK_BYTES);
      const mb = (up.bytes.length / 1048576).toFixed(1);
      log(`uploading ${up.name} (${mb} MB) 0 / ${chunks}`);
      // The chunk count goes up first so a reader that sees the list before
      // the job flips to done knows how much is coming.
      await dbPut(`${path}/meta`, {
        name: up.name,
        size: up.bytes.length,
        chunks,
      });
      let next = 0;
      let done = 0;
      const send = async () => {
        while (next < chunks) {
          const ci = next++;
          const slice = up.bytes.subarray(
            ci * CHUNK_BYTES,
            Math.min((ci + 1) * CHUNK_BYTES, up.bytes.length),
          );
          await dbPut(`${path}/${ci}`, encodeBase64(slice));
          done++;
          if (done % 8 === 0 || done === chunks) {
            log(`uploading ${up.name} (${mb} MB) ${done} / ${chunks}`);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_PARALLEL, chunks) }, send),
      );
      records.push({
        name: up.name,
        size: up.bytes.length,
        kind: up.kind,
        contentType: CONTENT_TYPES[up.kind] ?? "application/octet-stream",
        chunks,
        chunkBytes: CHUNK_BYTES,
        path,
      });
    }
    return records;
  }

  private async prune(): Promise<void> {
    if (!this.running) return;
    const { freeBlobs, remove } = jobsToPrune(this.snapshot, Date.now());
    for (const id of freeBlobs) {
      try {
        await dbDelete(`${EXPORT_PATHS.blobs}/${id}`);
        await this.patchJob(id, { blobsFreed: true, updatedAt: Date.now() });
      } catch (e) {
        this.lastError = `prune: ${(e as Error).message}`;
      }
    }
    for (const id of remove) {
      try {
        await dbDelete(`${EXPORT_PATHS.blobs}/${id}`);
        await dbDelete(`${EXPORT_PATHS.queue}/${this.code}/${id}`);
        delete this.snapshot[id];
      } catch (e) {
        this.lastError = `prune: ${(e as Error).message}`;
      }
    }
  }
}

export function formatBuilderCode(code: string): string {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : "";
}

// One worker per process, however many copies of this module get evaluated:
// Vite's dev server re-runs modules on edit, and desktop.ts carries its own
// bundle of the server next to the route's.
const WORKER_KEY = Symbol.for("shmupx.exportWorker");

export function exportWorker(): ExportWorker {
  const g = globalThis as unknown as Record<symbol, ExportWorker | undefined>;
  if (!g[WORKER_KEY]) g[WORKER_KEY] = new ExportWorker();
  return g[WORKER_KEY]!;
}
