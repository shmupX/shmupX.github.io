// Two generations of the export worker, and a database for them to share.
//
// A BUILD CODE can have two desktops behind it at once: the installed app and
// a checkout's server read the same config file, so they heartbeat the same
// record and stream the same queue. Until every install updates, one of the
// two may still be a version-1 worker from before the shmupX/ split, which
// claims every job whose status is "queued" and builds names from cmg's
// root-level levels. What keeps it off the jobs it would get wrong is only
// what version 1 does with the statuses and claim marks version 2 writes —
// so the tests run the version-1 worker's own code against them, not a copy
// of what it is believed to do.
//
// That code is read out of git at V1_WORKER_COMMIT, the last commit before the
// split; every commit that shipped WORKER_VERSION = 1 (67a3152 onwards) has
// the same claim, recovery and prune rules. Its relative imports are pointed
// at today's lib/ (only the pure helpers and the claim/recover/heartbeat
// paths run, none of which build anything). Where git or that commit is not
// there — a shallow clone — loadV1Worker answers null and the tests that
// need it are skipped.

import { fromFileUrl } from "@std/path";
import type { ExportJob } from "../../lib/export-worker.ts";

export const V1_WORKER_COMMIT = "674177d";

const LIB = new URL("../../lib/", import.meta.url);
const REPO = new URL("../../../../", import.meta.url);

// Version 1's job is today's minus the fields added since, so one type reads both.
type Job = ExportJob;
type Tree = Record<string, unknown>;

/** The parts of a worker module these tests drive. */
export interface WorkerModule {
  WORKER_VERSION: number;
  pickNextJob(jobs: Record<string, Job | undefined>): Job | null;
  jobsToPrune(
    jobs: Record<string, Job | undefined>,
    now: number,
  ): { freeBlobs: string[]; remove: string[] };
  ExportWorker: new () => unknown;
}

/** An ExportWorker with its private paths opened up. */
export interface DrivenWorker {
  code: string;
  claim(job: Job): Promise<boolean>;
  recoverStale(): Promise<void>;
  heartbeat(): Promise<void>;
  stop(): Promise<void>;
  run(job: Job): Promise<void>;
  snapshot: Record<string, Job | undefined>;
}

let v1: Promise<WorkerModule | null> | null = null;

/** The version-1 worker module, or null where git cannot produce it. */
export function loadV1Worker(): Promise<WorkerModule | null> {
  v1 ??= (async () => {
    let src: string;
    try {
      const out = await new Deno.Command("git", {
        args: [
          "show",
          `${V1_WORKER_COMMIT}:packages/shmup-harbor/lib/export-worker.ts`,
        ],
        cwd: fromFileUrl(REPO),
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!out.success) return null;
      src = new TextDecoder().decode(out.stdout);
    } catch {
      return null;
    }
    if (!src.includes("export const WORKER_VERSION = 1;")) return null;
    src = src.replace(
      /from "\.\/([^"]+)"/g,
      (_m, rel: string) => `from "${new URL(rel, LIB).href}"`,
    );
    const dir = await Deno.makeTempDir({ prefix: "export-worker-v1-" });
    try {
      const file = `${dir}/export-worker-v1.ts`;
      await Deno.writeTextFile(file, src);
      return await import(`file://${file}`) as WorkerModule;
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  })();
  return v1;
}

/** A worker of `mod` paired to `code`, as if it had read its config. */
export function driveWorker(
  mod: { ExportWorker: new () => unknown },
  code: string,
  name = "Mac",
): DrivenWorker {
  const worker = new mod.ExportWorker() as unknown as Record<string, unknown>;
  worker.config = { code, name, enabled: true, createdAt: 0 };
  return worker as unknown as DrivenWorker;
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function etagOf(v: unknown): string {
  // FNV-1a of the JSON: changes whenever the node does, which is all an ETag
  // has to do here.
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(v ?? null)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${h.toString(16)}"`;
}

/**
 * The Realtime Database's REST surface as a tree in memory: GET a subtree
 * (with an ETag on request), PUT (conditional on If-Match), PATCH with
 * multi-path keys, DELETE, and null deleting — with empty nodes vanishing the
 * way the real one's do. Replaces globalThis.fetch until `restore()`.
 */
export function fakeRtdb() {
  let tree: Tree = {};
  const calls: string[] = [];
  const keysOf = (path: string) => path.split("/").filter(Boolean);
  const read = (path: string): unknown => {
    let node: unknown = tree;
    for (const key of keysOf(path)) {
      if (!node || typeof node !== "object") return null;
      node = (node as Tree)[key];
    }
    return node === undefined ? null : node;
  };
  const prune = (node: Tree): Tree => {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") {
        prune(v as Tree);
        if (!Object.keys(v as Tree).length) delete node[k];
      } else if (v === null || v === undefined) delete node[k];
    }
    return node;
  };
  const write = (path: string, value: unknown) => {
    const keys = keysOf(path);
    if (!keys.length) {
      tree = value && typeof value === "object" ? clone(value as Tree) : {};
      prune(tree);
      return;
    }
    let node = tree;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      if (!next || typeof next !== "object") node[key] = {};
      node = node[key] as Tree;
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = clone(value);
    prune(tree);
  };
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = decodeURIComponent(url.pathname).replace(/^\//, "")
      .replace(/\.json$/, "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${path}`);
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body));
    if (method === "GET") {
      const value = clone(read(path));
      const res = Response.json(value ?? null);
      if (headers.get("X-Firebase-ETag") === "true") {
        res.headers.set("etag", etagOf(value));
      }
      return Promise.resolve(res);
    }
    if (method === "PUT") {
      const match = headers.get("if-match");
      if (match && match !== etagOf(read(path))) {
        return Promise.resolve(new Response("null", { status: 412 }));
      }
      write(path, body);
      return Promise.resolve(Response.json(body ?? null));
    }
    if (method === "PATCH") {
      for (const [key, value] of Object.entries(body as Tree)) {
        write(`${path}/${key}`, value);
      }
      return Promise.resolve(Response.json(body ?? null));
    }
    if (method === "DELETE") {
      write(path, null);
      return Promise.resolve(Response.json(null));
    }
    return Promise.resolve(new Response("", { status: 405 }));
  }) as typeof fetch;
  return {
    calls,
    get: (path: string) => clone(read(path)),
    set: (path: string, value: unknown) => write(path, value),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}
