// A packaged app's download-once store. What the binary leaves out
// (lib/streamed-payloads.ts) comes from its source the first time anything
// asks for it, lands under the launcher's data directory, and is served from
// disk from then on — online or not.
//
// The server keeps it, not the page, because the page cannot: under `deno
// desktop` the browser profile is a fresh $TMPDIR/laufey_cef_<pid>/ every
// launch and the origin is 127.0.0.1:<ephemeral port>, so IndexedDB, Cache
// Storage and localStorage all start empty each time. The data directory is
// the one place both a CEF build and a borrowed-browser build keep.
//
// A file is downloaded whole before the first byte is served. Nothing that
// asks for one can use part of it (the arcade player takes the romset as one
// File, Phaser decodes a track only once it has all of it), and serving from
// the finished file is what gives a ranged probe or a HEAD a proper answer
// when the source ignores Range, as the deploy does.

import { createHash } from "node:crypto";
import { walk } from "@std/fs";
import { serveFile } from "@std/http/file-server";
import { dirname, join } from "@std/path";

/** Where the page path `pathname` is kept under `root`, or null for a path that could step outside it. */
export function storedPath(root: string, pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!seg || seg === "." || seg === ".." || /[\\/:\0]/.test(seg)) {
      return null;
    }
    segments.push(seg);
  }
  return join(root, ...segments);
}

// Paths whose answer can change under the same name: a manifest maps names to
// files, and a player page is the document being opened. They are fetched
// again whenever the source answers in time, and the copy is kept for when it
// does not. Everything else is immutable once stored — romsets, tracks, cores.
// The same rule as static/emu-sw.js's revalidates().
const REVALIDATES = /(\/manifest\.json|\.html)$/;
const REVALIDATE_MS = 4000;

/** True when the store already holds `pathname`. */
export async function isStored(
  root: string,
  pathname: string,
): Promise<boolean> {
  const file = storedPath(root, pathname);
  return file !== null && await isFile(file);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Why a downloaded body cannot be what `pathname` names, or null. Every source
 * is https, so a captive portal fails TLS before it gets here; these catch the
 * rest — a truncated body, a host that answered with a page instead of the
 * file, a file swapped under its name.
 *
 * - The deploy and the core host are Fresh, whose ETag is W/"<sha256 of the
 *   body>": when there is one, the body must hash to it.
 * - No HTML where a file was asked for.
 * - A body sent without Content-Encoding is as long as it said.
 * - A romset is a zip, a core is wasm, a recipe or manifest parses.
 */
export function bodyProblem(
  pathname: string,
  res: Response,
  body: { sha256: string; size: number; head: Uint8Array; text?: string },
): string | null {
  const etag = /^(?:W\/)?"([0-9a-f]{64})"$/.exec(res.headers.get("etag") ?? "");
  if (etag && etag[1] !== body.sha256) {
    return "the body does not match its ETag";
  }
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type) && !pathname.endsWith(".html")) {
    return "a page came back where a file was asked for";
  }
  const length = res.headers.get("content-length");
  if (
    length !== null && !res.headers.get("content-encoding") &&
    Number(length) !== body.size
  ) return `${body.size} of ${length} bytes arrived`;
  const starts = (...bytes: number[]) =>
    bytes.every((b, i) => body.head[i] === b);
  if (pathname.endsWith(".zip") && !starts(0x50, 0x4b)) return "not a zip";
  if (pathname.endsWith(".wasm") && !starts(0x00, 0x61, 0x73, 0x6d)) {
    return "not WebAssembly";
  }
  if (pathname.endsWith(".json") && body.text !== undefined) {
    try {
      JSON.parse(body.text);
    } catch {
      return "not JSON";
    }
  }
  return null;
}

/**
 * Fetch `url` into `file` through a synced temp file, so a reader never sees
 * half and a crash never leaves one. Resolves to the source's answer when it
 * was an error; throws when the body is not the file.
 */
async function download(
  pathname: string,
  url: string,
  file: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response | null> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return res;
  }
  await Deno.mkdir(dirname(file), { recursive: true });
  const part = `${file}.${crypto.randomUUID()}.part`;
  try {
    const hash = createHash("sha256");
    let size = 0;
    const head = new Uint8Array(8);
    const out = await Deno.open(part, { write: true, createNew: true });
    try {
      for await (const chunk of res.body) {
        if (size < head.length) {
          head.set(chunk.subarray(0, head.length - size), size);
        }
        hash.update(chunk);
        size += chunk.length;
        for (let off = 0; off < chunk.length;) {
          off += await out.write(chunk.subarray(off));
        }
      }
      await out.syncData();
    } finally {
      out.close();
    }
    const problem = bodyProblem(pathname, res, {
      sha256: hash.digest("hex"),
      size,
      head,
      text: pathname.endsWith(".json")
        ? await Deno.readTextFile(part)
        : undefined,
    });
    if (problem) throw new Error(problem);
    await Deno.rename(part, file);
  } catch (err) {
    await Deno.remove(part).catch(() => {});
    throw err;
  }
  return null;
}

/**
 * Remove temp files a killed download left behind, once they are old enough
 * that no live download can own them. Run once at startup.
 */
export async function sweepPartials(
  root: string,
  olderThanMs = 60 * 60 * 1000,
): Promise<number> {
  let removed = 0;
  try {
    for await (const e of walk(root, { exts: [".part"], includeDirs: false })) {
      const { mtime } = await Deno.stat(e.path);
      if (mtime && Date.now() - mtime.getTime() > olderThanMs) {
        await Deno.remove(e.path).catch(() => {});
        removed++;
      }
    }
  } catch {
    // No store yet: nothing to sweep.
  }
  return removed;
}

// One download per file however many ask at once: the boss track is four keys.
const inFlight = new Map<string, Promise<Response | null>>();

export interface StoreOptions {
  /** The store folder under the launcher's data directory. */
  root: string;
  /** The URL the file is fetched from when the store does not hold it. */
  source: string;
  fetchImpl?: typeof fetch;
}

export type Stored =
  | { ok: true; file: string }
  | { ok: false; status: number; reason: string };

/**
 * Make sure the store holds `pathname`, downloading it from `opts.source` if
 * not (or refreshing it, for a path that revalidates). An error answer from
 * the source is passed on and nothing is stored; an unreachable source is a
 * 502, unless a copy is already held, which then stands.
 */
export async function ensureStored(
  pathname: string,
  opts: StoreOptions,
): Promise<Stored> {
  const file = storedPath(opts.root, pathname);
  if (!file) return { ok: false, status: 404, reason: "not a storable path" };
  const held = await isFile(file);
  if (held && !REVALIDATES.test(pathname)) return { ok: true, file };

  let pending = inFlight.get(file);
  if (!pending) {
    pending = download(
      pathname,
      opts.source,
      file,
      opts.fetchImpl ?? fetch,
      held ? AbortSignal.timeout(REVALIDATE_MS) : undefined,
    ).finally(() => inFlight.delete(file));
    inFlight.set(file, pending);
  }
  try {
    const failed = await pending;
    if (failed && !held) {
      return {
        ok: false,
        status: failed.status,
        reason: `${opts.source} answered ${failed.status}`,
      };
    }
  } catch (err) {
    if (!held) {
      return {
        ok: false,
        status: 502,
        reason: `could not keep ${opts.source}: ${(err as Error).message}`,
      };
    }
  }
  return { ok: true, file };
}

/** Answer `req` for `pathname` from the store, downloading it first if needed. */
export async function serveStored(
  req: Request,
  pathname: string,
  opts: StoreOptions,
): Promise<Response> {
  const stored = await ensureStored(pathname, opts);
  if (!stored.ok) {
    return new Response(stored.reason, {
      status: stored.status,
      headers: { "content-type": "text/plain" },
    });
  }
  return await serveFile(req, stored.file);
}
