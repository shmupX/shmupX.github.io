// scripts/publish-eshop-sav.ts — a level as a Dezaemon 2 cart, published to
// the eShop.
//
//   deno task eshop:publish foo                              # shmupX/levels/foo → /eshop/{saves,covers,index}/foo
//   deno task eshop:publish foo --name dezaFoo               # listed as "dezaFoo" (id dezafoo), replacing what is there
//   deno task eshop:publish foo --name dezaFoo --author "EASIER BY CODE"
//   deno task eshop:publish ./backups/mygame.json --palette snes
//   deno task eshop:publish foo --name dezaFoo --dry-run     # build and render, say what would be written
//
// The editor's SYSTEM MENU → EXPORT → ESHOP, from a checkout. It is the same
// three things in the same order: the cart `deno task build:sav` writes (story
// panels, title art and staff roll included), the cover the shelf wears
// (composeCover over the cart just written, as `deno task eshop:covers`
// renders it), and the three database writes of publishDezaGame in
// static/eshop-library.js — the one function the editor calls — save, cover,
// listing last, so a half-published game never lists. A game published here
// and one published from the page are indistinguishable in the database.
//
// --name is the listing's name AND the cart's own: its header comment and the
// "Dez 2 - <name>.sav" the shop installs it as (the editor sets record.name
// the same way before it exports). The id is the name's slug unless --id says
// otherwise. Publishing to an id that exists REPLACES it — save, cover and
// listing — and the listing that goes is named first.
//
// Who the listing says made it is whoever the cart's staff roll names
// (publishDezaGame reads the roll off the writer's report): the level's own
// `attribution`, else --author, else — as build:sav — this process's user,
// which in a container is nobody you meant. --no-author credits nobody.
//
// Writing is the point, so there is no --write; --dry-run holds the writes
// back and prints what each would have carried.

import { relative } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import {
  buildSav,
  type BuildSavOptions,
  type BuildSavResult,
} from "@shmupx/shmup-harbor/build-sav";
import { encodePng } from "@shmupx/shmup-harbor/png";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import * as engine from "@shmupx/shmup-engine";
import * as eshopLibrary from "../static/eshop-library.js";
import { slugOfTitle } from "../static/deza-shelf.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Log = (message: string) => void;

// static/eshop-library.js is plain JS whose defaults (`report = null`,
// `engine = null`) type its parameters as null; this is the contract the
// editor and tests/eshop_library_test.ts call it by.
interface PublishDezaGameOptions {
  id?: string;
  name: string;
  sav: Uint8Array;
  palette?: "saturn" | "snes";
  report?: Record<string, unknown> | null;
  cover?: { png: string; w: number; h: number } | null;
  author?: string;
  sub?: string;
  fetchImpl?: Fetch;
  engine?: unknown;
  rtdb?: string;
  onProgress?: (pct: number, label: string) => void;
}
const { ESHOP_RTDB } = eshopLibrary as { ESHOP_RTDB: string };
const publishDezaGame = eshopLibrary.publishDezaGame as unknown as (
  opts: PublishDezaGameOptions,
) => Promise<{ id: string; index: Record<string, unknown> }>;

export interface PublishOptions {
  /** A level name in the cloud, or a path to a level JSON file. Omitted: foo.json. */
  level?: string | null;
  /** The listing's name and the cart's. Omitted: the level's own name. */
  name?: string | null;
  /** The eShop id. Omitted: the name's slug. */
  id?: string | null;
  palette?: "saturn" | "snes";
  /** build:sav's `attribution` (--author NAME): the staff roll outright. */
  attribution?: unknown;
  /** build:sav's `author`: null credits nobody (--no-author). */
  author?: string | null;
  gameMode?: number;
  /** Where the .sav lands. Omitted: build/sav/<file>. */
  out?: string | null;
  /** Build and render, write nothing to the database. */
  dryRun?: boolean;
  rtdb?: string;
  fetchImpl?: Fetch;
  log?: Log;
}

export interface EshopWrite {
  path: string;
  bytes: number;
}

export interface PublishResult {
  id: string;
  name: string;
  dryRun: boolean;
  /** The cart, as build:sav left it. */
  sav: BuildSavResult;
  /** The listing that was there before, or null. */
  replaced: Record<string, unknown> | null;
  /** The listing as written (or, dry, as it would have been). */
  index: Record<string, unknown>;
  cover: { w: number; h: number; bytes: number; hasTitleArt: boolean } | null;
  /** Every PUT, in order, with the size of its body. */
  writes: EshopWrite[];
}

/**
 * The listing's own picture: the cart decoded and shot by composeCover, the
 * same four calls the community library and `eshop:covers` make, so a game
 * published from here wears the cover it would wear anywhere else.
 */
export async function renderCover(
  sav: Uint8Array,
): Promise<{ png: string; w: number; h: number; hasTitleArt: boolean } | null> {
  const { data } = await engine.normalize(sav);
  const entry = engine.parse(data).filter(engine.isGameSave)[0];
  if (!entry?.payload) return null;
  const composed = engine.composeCover(engine.decodeSave(entry.payload.buffer));
  const png = await encodePng({
    width: composed.w,
    height: composed.h,
    data: new Uint8Array(composed.rgba),
  });
  return {
    png: `data:image/png;base64,${encodeBase64(png)}`,
    w: composed.w,
    h: composed.h,
    hasTitleArt: composed.hasTitleArt,
  };
}

/** A fetch that lets reads through and records writes without sending them. */
function dryFetch(real: Fetch, writes: EshopWrite[]): Fetch {
  return (url, init) => {
    const method = (init?.method || "GET").toUpperCase();
    if (method === "GET") return real(url, init);
    const body = typeof init?.body === "string" ? init.body : "";
    writes.push({
      path: new URL(url).pathname.replace(/\.json$/, ""),
      bytes: new TextEncoder().encode(body).length,
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

/** A fetch that records what it writes, and writes it. */
function countingFetch(real: Fetch, writes: EshopWrite[]): Fetch {
  return async (url, init) => {
    const res = await real(url, init);
    const method = (init?.method || "GET").toUpperCase();
    if (method !== "GET" && res.ok) {
      const body = typeof init?.body === "string" ? init.body : "";
      writes.push({
        path: new URL(url).pathname.replace(/\.json$/, ""),
        bytes: new TextEncoder().encode(body).length,
      });
    }
    return res;
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * Export the level and publish it. Exported so the test drives the same code
 * the task does, against a fetch of its own.
 */
export async function publishLevelToEshop(
  options: PublishOptions = {},
): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const realFetch: Fetch = options.fetchImpl ??
    ((url, init) => fetch(url, init));
  const base = String(options.rtdb || ESHOP_RTDB).replace(/\/$/, "");
  const palette = options.palette ?? "saturn";
  const dryRun = !!options.dryRun;

  // 1. The cart — build:sav, with the eShop name on it.
  const build: BuildSavOptions = {
    level: options.level,
    name: options.name,
    palette,
    out: options.out,
    gameMode: options.gameMode,
    log,
  };
  if (options.attribution !== undefined) {
    build.attribution = options.attribution;
  }
  if (options.author !== undefined) build.author = options.author;
  const sav = await buildSav(build);
  const name = String(options.name?.trim() || sav.report.name || "").trim() ||
    sav.fileName.replace(/^Dez 2 - /, "").replace(/\.sav$/, "");
  const id = String(options.id || "").trim() || slugOfTitle(name);
  const bytes = await Deno.readFile(sav.outPath);

  // 2. The cover, off the cart just written.
  const cover = await renderCover(bytes);
  log(
    cover
      ? `cover: ${cover.w}x${cover.h} from ${
        cover.hasTitleArt ? "its drawn title page" : "its own art"
      }, ${kb(cover.png.length)} as a data URL`
      : "cover: the cart holds no readable game save — the listing goes out without one",
  );

  // 3. What is there now, so replacing it is said rather than discovered.
  let replaced: Record<string, unknown> | null = null;
  try {
    const res = await realFetch(`${base}/eshop/index/${id}.json`);
    if (res.ok) {
      replaced = await res.json() as Record<string, unknown> | null;
    } else await res.body?.cancel();
  } catch (e) {
    log(`eshop: could not read the listing (${(e as Error).message})`);
  }
  if (replaced) {
    log(
      `eshop: replacing "${replaced.name ?? id}" (${id}) listed ${
        replaced.date ?? "undated"
      }${replaced.author ? ` by ${replaced.author}` : ""} — ${
        replaced.stages ?? "?"
      } stages, ${replaced.palette ?? "?"} palette, ${
        replaced.hasCover ? "with" : "without"
      } a cover`,
    );
  } else log(`eshop: ${id} is a new listing`);

  // 4. publishDezaGame — the editor's own three writes, in its order.
  const stages = Array.isArray(sav.report.stages)
    ? sav.report.stages.length
    : Number(sav.report.stages) || 0;
  const writes: EshopWrite[] = [];
  const fetchImpl = dryRun
    ? dryFetch(realFetch, writes)
    : countingFetch(realFetch, writes);
  const published = await publishDezaGame({
    id,
    name,
    sav: bytes,
    palette,
    report: sav.report,
    cover: cover ? { png: cover.png, w: cover.w, h: cover.h } : null,
    sub: `Dezaemon 2 // ${stages} stage${
      stages === 1 ? "" : "s"
    } · ${palette} palette`,
    fetchImpl,
    engine,
    rtdb: base,
    onProgress: (_pct, label) =>
      log(`eshop: ${dryRun ? "would be " : ""}${label.toLowerCase()}`),
  });

  for (const w of writes) {
    log(
      `eshop: ${dryRun ? "would write" : "wrote"} ${w.path} (${kb(w.bytes)})`,
    );
  }
  const index = published.index;
  log(
    `${
      dryRun ? "DRY RUN — not published:" : "published"
    } ${name} as ${published.id}${
      index.author ? ` · by ${index.author}` : ""
    } · ${index.sub} · ${index.date}`,
  );

  return {
    id: published.id,
    name,
    dryRun,
    sav,
    replaced,
    index,
    cover: cover
      ? {
        w: cover.w,
        h: cover.h,
        bytes: cover.png.length,
        hasTitleArt: cover.hasTitleArt,
      }
      : null,
    writes,
  };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

if (import.meta.main) {
  const opts: PublishOptions = { log: (m) => console.log(m) };
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
    else if (arg === "--id") opts.id = value();
    else if (arg.startsWith("--id=")) opts.id = arg.slice(5);
    else if (arg === "--palette" || arg.startsWith("--palette=")) {
      const v = arg === "--palette" ? value() : arg.slice("--palette=".length);
      if (v !== "saturn" && v !== "snes") {
        fail(`--palette must be saturn or snes, got ${v}`);
      }
      opts.palette = v;
    } else if (arg === "--author") opts.attribution = value();
    else if (arg.startsWith("--author=")) opts.attribution = arg.slice(9);
    else if (arg === "--no-author") opts.author = null;
    else if (arg === "--out") opts.out = value();
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--horizontal") opts.gameMode = (opts.gameMode ?? 0) | 1;
    else if (arg === "--two-player") opts.gameMode = (opts.gameMode ?? 0) | 2;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--rtdb") opts.rtdb = value();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: deno task eshop:publish [level-name | level.json] [--name NAME] [--id ID]\n" +
          "       [--palette saturn|snes] [--author NAME | --no-author] [--horizontal] [--two-player]\n" +
          "       [--out file.sav] [--dry-run] [--rtdb URL]",
      );
      Deno.exit(0);
    } else if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
    else if (opts.level) {
      fail(`only one level at a time (got ${opts.level} and ${arg})`);
    } else opts.level = arg;
  }
  try {
    const result = await publishLevelToEshop(opts);
    console.log(
      `cart: ${relative(repoRoot(), result.sav.outPath)} (${
        kb(result.sav.bytes)
      })`,
    );
  } catch (e) {
    fail((e as Error).message);
  }
  // The shelf libraries open a BroadcastChannel to tell the other tabs a
  // browser would have; under Deno it has nobody to tell and keeps the event
  // loop alive, so without this the process sits here after its last line.
  Deno.exit(0);
}
