// scripts/rtdb-split.ts — seed shmupX's own subtree of the shared database
// from the root copies cmg keeps.
//
//   deno task rtdb:split                          # the plan: keys, sizes, states; writes nothing
//   deno task rtdb:split -- --write               # copy what is missing, then read every key back
//   deno task rtdb:split -- --write --force       # also replace records someone edited under shmupX/
//   deno task rtdb:split -- --db https://x.firebaseio.com   # another database (the base, never a subtree)
//
// The Realtime Database is shared with cmg (~/CODE/cmg). Until the split both
// apps read and wrote the same root `levels`, `levelAliases`, `atlases` and
// `characters`; now shmupX reads those four from `shmupX/` (lib/rtdb-root.ts
// has the why) and cmg keeps the root ones, all of them. This script is the
// one-off that gives `shmupX/` its starting contents: the five games shmupX
// ships, the two aliases that reach 2019, and the 29 characters those games
// name with each one's atlas. Everything else — every other level, the ~430
// spriteX atlases, leaderboards, sprites, the export queue — stays where it is
// and is not read at all.
//
// It is ADDITIVE and IDEMPOTENT:
//
//   - The only requests it makes are GETs, and with --write PUTs whose paths
//     start `shmupX/<scoped node>/` — assertInsideRoot checks every one before
//     it is sent. No DELETE, no PATCH, no PUT of null, nothing at the root.
//   - Each record is classified against what is already under shmupX/ first:
//       new      nothing there yet                          -> written
//       same     already exactly what would be written      -> left alone
//       partial  what a run that stopped between the PUTs   -> the rest of
//                of a split record leaves: its first pieces,   its pieces
//                in write order, exactly as planned, and       written
//                nothing else
//       differs  anything else: someone edited it there,     -> left alone and
//                or cmg changed the root copy after an          reported, unless
//                earlier run took it                            --force
//     so a second run writes nothing and an interrupted one picks up where it
//     stopped. Being a subset of the plan is not enough to count as partial:
//     a field deleted under shmupX/, or one cmg added at the root since, also
//     leaves the copy a subset, and re-sending the plan would undo the one and
//     copy the other without asking. A record that goes up in one PUT cannot
//     be half-written, so it is only ever new, same or differs, and any edit to
//     it is reported. The one edit this cannot tell from an interruption is to
//     a split record (foo and rando, live) that leaves exactly its first pieces
//     in write order: its last piece or pieces deleted under shmupX/, or a
//     child cmg adds at the root whose key sorts after all the others. Either
//     reads as partial and the next --write sends the tail, so the dry run
//     shows such a record as `partial ... (N to write)` — look at it first.
//   - After writing, every record that should now match is read back and its
//     SHA-256 (over key-sorted JSON) compared with the intended one; any
//     mismatch exits 1.
//
// The copy is not quite verbatim: two levels get a pinned `gameId`, which is
// what picks their leaderboard (leaderboards/<gameId>/..., unchanged and still
// at the root):
//
//   foo     -> foo-a9f37ed7. The root record says foo-5d6de24c, a board the
//              editor minted and nothing ever scored to; the stock game's
//              static/games/2028-ai/foo.json has no gameId and derives
//              foo-a9f37ed7, which is the board that holds the scores. Pinning
//              the shmupX copy to it puts a plain visit, ?level=foo and a foo
//              export on one board without touching the file.
//   Ramsie -> ramsie-cae9647a. The root record has no gameId, so the runtime
//              derives one from the name; writing that same derived id down
//              keeps the editor's first save from minting a random one and
//              moving the board.
//
// Both are recomputed here with the runtime's own derivation (the CommonJS
// mirror build-level bakes into exports) rather than trusted as typed, and the
// run stops if either no longer derives to its pin. The other three keep the
// gameIds they have.
//
// Big records go up in pieces. A level carries its atlas PNG, thumbnails and
// title art as data URLs, so foo and rando are ~6 MB; a record bigger than
// MAX_PUT_BYTES is PUT one child at a time (recursively, until each piece fits
// or is a single value), children in key order and one awaited PUT after
// another, all through scripts/lib/rtdb-publish.ts's throttled,
// retrying, print=silent put — the same 64 MB/min write budget every publisher
// shares. Atlases go first, then characters, then levels, then the aliases, so
// nothing is published before what it points at. While a split level is being
// written a reader of shmupX/levels/<key> can see part of it — for the length
// of the run, a few seconds a level — and a run that dies there leaves a
// `partial` record the next run completes.
//
// WRITES ARE OPT-IN, as in level:normalize and level:alias: without --write
// this prints the plan and stops. Exit codes: 0 done (or dry run), 1 a write
// or the read-back failed, 2 the root no longer looks the way the contract
// says (nothing written), 3 written and verified, but some records were left
// alone because they differ under shmupX/ (re-run with --force to replace).

import { createRequire } from "node:module";
import { fromFileUrl } from "@std/path";
import { RTDB_ROOT, rtdbPath, SCOPED_NODES } from "../lib/rtdb-root.ts";
import type { ScopedNode } from "../lib/rtdb-root.ts";
import {
  DEFAULT_WRITE_BUDGET_BYTES_PER_MIN,
  makePut,
  sha256Hex,
} from "./lib/rtdb-publish.ts";

/** The shared database's base. Never a subtree: the root is a path prefix. */
export const DEFAULT_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** The games shmupX ships — exact keys; lowercase `ramsie` stays cmg's. */
export const SHMUPX_LEVELS = ["2019-PS2", "foo", "gs", "Ramsie", "rando"];

/**
 * Leaderboard identities the shmupX copies are pinned to, each with the
 * record its id is derived from (see the header for why these two).
 */
export const LEVEL_GAME_ID_PINS: Record<string, string> = {
  foo: "foo-a9f37ed7",
  Ramsie: "ramsie-cae9647a",
};

/** Alias -> level key. Lowercase, as the level loader looks them up. */
export const SHMUPX_ALIASES: Record<string, string> = {
  "2019": "2019-PS2",
  streetfighter: "2019-PS2",
};

/** Every character the five games name; each brings its atlas along. */
export const SHMUPX_CHARACTERS = [
  "Akuma_2019",
  "Daltonius",
  "akuma",
  "deza1_09",
  "deza1_39",
  "deza1_44",
  "deza2_01",
  "deza2_02",
  "deza2_36",
  "deza3_33_whip",
  "deza3_47",
  "dezaBoss0",
  "dezaBoss0_Gill",
  "dezaBoss1",
  "dezaBoss3",
  "dezaBoss4_ramsie",
  "deza_dragon",
  "eternal_deza3_56",
  "fairy_shooters",
  "flirty_revenge",
  "hadoukenBoss",
  "megarush",
  "motorcycle_deza2_32",
  "pyramid",
  "pyramidDefaultProjectile",
  "ryu_level_moon",
  "sakura",
  "simon_belmont",
  "uglySister",
];

/**
 * A record whose JSON is bigger than this goes up one child at a time. The
 * editor saves a whole level in one SDK write, so a few MB in one body is
 * nothing RTDB minds; the line is drawn where a single slow PUT stops being
 * pleasant to retry, and below the budget so the throttle can always fit one.
 */
export const MAX_PUT_BYTES = 4 * 1024 * 1024;

/** Write order: what a record points at is published before the record. */
const WRITE_ORDER: ScopedNode[] = [
  "atlases",
  "characters",
  "levels",
  "levelAliases",
];

const STOCK_FOO_URL = new URL(
  "../static/games/2028-ai/foo.json",
  import.meta.url,
);

// The runtime's gameIdForLevel, loaded as Node loads it. build-level's
// lib/game-id.js is the CommonJS mirror of 2019-es7's gameIdentity.js that
// exports bake their __GAME_ID__ from, and game.bundle.js inlines the same
// three functions; fromFileUrl because the checkout may sit on a path with a
// space in it, which require() cannot find through a URL pathname.
const require = createRequire(import.meta.url);
const gameIdentity = require(
  fromFileUrl(
    new URL(
      "../packages/shmup-harbor/tools/build-level/lib/game-id.js",
      import.meta.url,
    ),
  ),
) as { gameIdForLevel(level: unknown): string | null };

/** The leaderboard id the runtime gives a level record. */
export const gameIdForLevel = gameIdentity.gameIdForLevel;

/** The root no longer matches what the split was planned against. */
export class SplitError extends Error {
  override name = "SplitError";
}

// ---- JSON helpers ------------------------------------------------------------

type Json = unknown;

const encoder = new TextEncoder();

/** Bytes of the body a PUT of this value sends. */
export function byteLength(value: Json): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, Json>)[key]);
    }
    return out;
  }
  return value;
}

/** JSON with every object's keys sorted, so equal trees hash equal. */
export function canonicalJson(value: Json): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

export async function hashJson(value: Json): Promise<string> {
  return await sha256Hex(encoder.encode(canonicalJson(value)));
}

function isContainer(value: Json): value is Record<string, Json> | Json[] {
  return value !== null && typeof value === "object";
}

// A container's children as RTDB holds them: arrays are objects keyed by
// index, and a null is an absent child (RTDB never stores one, and a GET only
// shows a null to fill a hole in an array). An object's come out in key order
// rather than in whatever order a GET happened to list them, so a record
// splits into the same pieces in the same order on every run — classify
// tells an interrupted run's leftovers from an edit by that order.
function children(value: Record<string, Json> | Json[]): [string, Json][] {
  const pairs: [string, Json][] = Array.isArray(value)
    ? value.map((child, i) => [String(i), child])
    : Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return pairs.filter(([, child]) => child !== null && child !== undefined);
}

function childAt(value: Json, key: string): Json {
  if (!isContainer(value)) return undefined;
  const child = (value as Record<string, Json>)[key];
  return child === null ? undefined : child;
}

function valueAt(value: Json, segments: string[]): Json {
  let at = value;
  for (const segment of segments) {
    at = childAt(at, segment);
    if (at === undefined) return undefined;
  }
  return at;
}

/**
 * Whether everything in `target` is also in `intended`, with the same value.
 * An interrupted copy always leaves a subset (anything the plan would not
 * have written means a person did), but so does an edit that only deletes;
 * classify asks for the rest.
 */
export function isSubsetOf(target: Json, intended: Json): boolean {
  if (!isContainer(target) || !isContainer(intended)) {
    return canonicalJson(target) === canonicalJson(intended);
  }
  for (const [key, child] of children(target)) {
    const want = childAt(intended, key);
    if (want === undefined || !isSubsetOf(child, want)) return false;
  }
  return true;
}

// ---- paths -------------------------------------------------------------------

/** A database path as a REST URL spells it: every segment encoded. */
export function restPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Throws unless `segments` names something strictly inside one of the scoped
 * nodes under the shmupX root. Every PUT passes through here first, so no plan
 * — however it was built — can write to the root or to a node that did not
 * move (shmupX/sprites would be a copy nothing reads).
 */
export function assertInsideRoot(segments: string[]): void {
  const [root, node, key] = segments;
  const scoped = (SCOPED_NODES as readonly string[]).includes(node);
  if (root !== RTDB_ROOT || !scoped || !key) {
    throw new Error(
      `refusing to write "${segments.join("/")}": only ${RTDB_ROOT}/<${
        SCOPED_NODES.join("|")
      }>/<key> is ours to write`,
    );
  }
}

// ---- the plan ----------------------------------------------------------------

export type RecordState = "new" | "same" | "partial" | "differs";

/** One PUT: a target path below the record (or the record itself). */
export interface Piece {
  segments: string[];
  value: Json;
  bytes: number;
}

export interface PlanRecord {
  node: ScopedNode;
  key: string;
  /** Where it is copied from, at the root (cmg's copy). */
  source: string;
  /** Where it goes: rtdbPath(source). */
  target: string;
  targetSegments: string[];
  /** Exactly what shmupX/<node>/<key> should hold afterwards. */
  value: Json;
  bytes: number;
  hash: string;
  /** What is under the target now. */
  state: RecordState;
  current: Json;
  /** The PUTs a write of a new record makes (one unless it is big). */
  pieces: Piece[];
  notes: string[];
}

export interface Plan {
  db: string;
  records: PlanRecord[];
  /** Keys already under shmupX/<node> that this copy does not cover. */
  extras: Partial<Record<ScopedNode, string[]>>;
}

/** Splits a value into PUT-sized pieces; never yields a null. */
export function splitPieces(
  segments: string[],
  value: Json,
  maxBytes = MAX_PUT_BYTES,
): Piece[] {
  const bytes = byteLength(value);
  if (bytes <= maxBytes || !isContainer(value)) {
    return [{ segments, value, bytes }];
  }
  const kids = children(value);
  if (!kids.length) return [{ segments, value, bytes }];
  return kids.flatMap(([key, child]) =>
    splitPieces([...segments, key], child, maxBytes)
  );
}

async function getJson(db: string, segments: string[], query = "") {
  const url = `${db}/${restPath(segments)}.json${query}`;
  const res = await globalThis.fetch(url);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`GET ${segments.join("/")}: HTTP ${res.status} ${text}`);
  }
  return await res.json() as Json;
}

/** Runs `fn` over `items` a few at a time, results in input order. */
async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** The stock game's level, whose derived gameId is foo's board. */
export async function loadStockFoo(): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(STOCK_FOO_URL));
}

/**
 * Throws unless the stock game still derives foo's pin. `stockFoo` is
 * static/games/2028-ai/foo.json, which has no gameId and the name "foo", so
 * this is the id a plain visit scores under — the board foo is pinned to.
 */
export function checkFooPin(stockFoo: Json): void {
  const fooId = gameIdForLevel(stockFoo);
  if (fooId !== LEVEL_GAME_ID_PINS.foo) {
    throw new SplitError(
      `static/games/2028-ai/foo.json derives gameId ${fooId}, not ${LEVEL_GAME_ID_PINS.foo}; ` +
        `the stock game's board moved, so pinning foo to the old one would split them`,
    );
  }
}

/**
 * Throws unless Ramsie's name still derives its pin. The id is derived from
 * the name alone, as the runtime does for a record with no gameId — even if
 * the root record has since been given one, since that is cmg's to keep.
 */
export function checkRamsiePin(name: unknown): void {
  const ramsieId = gameIdForLevel({ name });
  if (ramsieId !== LEVEL_GAME_ID_PINS.Ramsie) {
    throw new SplitError(
      `levels/Ramsie (name ${
        JSON.stringify(name)
      }) derives gameId ${ramsieId}, ` +
        `not ${LEVEL_GAME_ID_PINS.Ramsie}`,
    );
  }
}

interface Wanted {
  node: ScopedNode;
  key: string;
  value: Json;
  notes: string[];
}

/** What every record should be, read from the root and checked against the contract. */
async function wantedRecords(db: string, stockFoo: Json): Promise<Wanted[]> {
  const problems: string[] = [];
  const read = (node: ScopedNode, keys: string[]) =>
    mapPool(keys, 6, (key) => getJson(db, [node, key]));

  // Levels: copied whole, two with a pinned gameId.
  const levelValues = await read("levels", SHMUPX_LEVELS);
  const levels: Wanted[] = [];
  SHMUPX_LEVELS.forEach((key, i) => {
    const record = levelValues[i];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      problems.push(`levels/${key} is missing at the root`);
      return;
    }
    const root = record as Record<string, Json>;
    const had = typeof root.gameId === "string" ? root.gameId : undefined;
    const notes: string[] = [];
    let value: Json = root;
    if (Object.hasOwn(LEVEL_GAME_ID_PINS, key)) {
      const pin = LEVEL_GAME_ID_PINS[key];
      value = { ...root, gameId: pin };
      notes.push(
        had === pin
          ? `gameId ${pin} (pinned, already so)`
          : `gameId ${had ?? "(none)"} -> ${pin} (pinned)`,
      );
    } else if (had && had.trim()) {
      notes.push(`gameId ${had} (kept)`);
    } else {
      problems.push(
        `levels/${key} has no gameId at the root; the contract keeps the one it has`,
      );
    }
    levels.push({ node: "levels", key, value, notes });
  });
  const ramsie = levelValues[SHMUPX_LEVELS.indexOf("Ramsie")] as
    | Record<string, Json>
    | null;
  const pinChecks = [() => checkFooPin(stockFoo)];
  if (ramsie) pinChecks.push(() => checkRamsiePin(ramsie.name));
  for (const check of pinChecks) {
    try {
      check();
    } catch (e) {
      problems.push((e as Error).message);
    }
  }

  // Aliases: the two that reach 2019, still pointing there at the root.
  const aliasKeys = Object.keys(SHMUPX_ALIASES);
  const aliasValues = await read("levelAliases", aliasKeys);
  const aliases: Wanted[] = aliasKeys.map((alias, i) => {
    const want = SHMUPX_ALIASES[alias];
    if (alias !== alias.toLowerCase()) {
      problems.push(`alias ${alias} is not lowercase`);
    }
    if (!SHMUPX_LEVELS.includes(want)) {
      problems.push(`alias ${alias} names ${want}, which is not copied`);
    }
    if (aliasValues[i] !== want) {
      problems.push(
        `levelAliases/${alias} is ${
          JSON.stringify(aliasValues[i])
        } at the root, not "${want}"`,
      );
    }
    return { node: "levelAliases", key: alias, value: want, notes: [] };
  });

  // Characters, then the atlas each names: textureKey || id, as the runtime
  // and the MCP publisher pick it.
  const charValues = await read("characters", SHMUPX_CHARACTERS);
  const characters: Wanted[] = [];
  const atlasUsers = new Map<string, string[]>();
  SHMUPX_CHARACTERS.forEach((id, i) => {
    const record = charValues[i];
    if (!record || typeof record !== "object") {
      problems.push(`characters/${id} is missing at the root`);
      return;
    }
    const textureKey = (record as Record<string, Json>).textureKey;
    const atlas = (typeof textureKey === "string" && textureKey) || id;
    atlasUsers.set(atlas, [...(atlasUsers.get(atlas) ?? []), id]);
    characters.push({
      node: "characters",
      key: id,
      value: record,
      notes: atlas === id ? [] : [`atlas ${atlas}`],
    });
  });
  const atlasKeys = [...atlasUsers.keys()];
  const atlasValues = await read("atlases", atlasKeys);
  const atlases: Wanted[] = [];
  atlasKeys.forEach((key, i) => {
    const users = atlasUsers.get(key)!;
    if (atlasValues[i] === null || atlasValues[i] === undefined) {
      problems.push(
        `atlases/${key} (for ${users.join(", ")}) is missing at the root`,
      );
      return;
    }
    const shared = users.length > 1 || users[0] !== key;
    atlases.push({
      node: "atlases",
      key,
      value: atlasValues[i],
      notes: shared ? [`for ${users.join(", ")}`] : [],
    });
  });

  if (problems.length) {
    throw new SplitError(
      `the root does not match the split's contract, so nothing was planned:\n  - ${
        problems.join("\n  - ")
      }`,
    );
  }
  const byNode = { levels, levelAliases: aliases, characters, atlases };
  return WRITE_ORDER.flatMap((node) => byNode[node]);
}

/**
 * What is under a record's target, against the plan for it. `partial` is kept
 * to the one shape an interrupted run can leave. applySplit sends a record's
 * pieces one awaited PUT at a time, in plan order, and each PUT lands whole
 * or not at all, so a run that stopped partway leaves some first pieces
 * exactly as planned and nothing of the rest: no extra keys, no piece half
 * there, no gap before a piece that landed. Any other subset of the plan is
 * an edit — a field deleted under shmupX/, or one cmg added to the root copy
 * after a run took it — and is `differs`, because re-sending the plan would
 * undo it without a word. With one piece there is no in-between, so a record
 * that goes up whole is only ever new, same or differs.
 */
export function classify(
  current: Json,
  intended: Json,
  pieces: Piece[],
  targetSegments: string[],
): RecordState {
  if (current === null || current === undefined) return "new";
  if (canonicalJson(current) === canonicalJson(intended)) return "same";
  if (!isContainer(current) || !isSubsetOf(current, intended)) return "differs";
  const there = pieces.map((piece) =>
    valueAt(current, piece.segments.slice(targetSegments.length))
  );
  // -1: every piece is there, yet the record is not the plan's; 0: the first
  // piece never landed, so whatever is there did not come from a run.
  const landed = there.findIndex((value) => value === undefined);
  if (landed <= 0) return "differs";
  const headExact = pieces.slice(0, landed).every((piece, i) =>
    canonicalJson(there[i]) === canonicalJson(piece.value)
  );
  const tailAbsent = there.slice(landed).every((value) => value === undefined);
  return headExact && tailAbsent ? "partial" : "differs";
}

export interface PlanOptions {
  db?: string;
  /** static/games/2028-ai/foo.json by default. */
  stockFoo?: Json;
  maxPutBytes?: number;
}

/**
 * Reads the root and the shmupX subtree (GETs only) and works out every
 * record, its size, its pieces and what is already in its place.
 */
export async function planSplit(options: PlanOptions = {}): Promise<Plan> {
  const db = (options.db ?? DEFAULT_DB).replace(/\/+$/, "");
  const maxPutBytes = options.maxPutBytes ?? MAX_PUT_BYTES;
  const stockFoo = options.stockFoo ?? await loadStockFoo();
  const wanted = await wantedRecords(db, stockFoo);

  // What shmupX/ holds already: one shallow listing per node, then a full
  // read only of the keys that are there.
  const present = new Map<ScopedNode, Set<string>>();
  const extras: Plan["extras"] = {};
  for (const node of WRITE_ORDER) {
    const listing = await getJson(db, [RTDB_ROOT, node], "?shallow=true");
    const keys = new Set(
      listing && typeof listing === "object" ? Object.keys(listing) : [],
    );
    present.set(node, keys);
    const ours = new Set(
      wanted.filter((w) => w.node === node).map((w) => w.key),
    );
    const others = [...keys].filter((k) => !ours.has(k)).sort();
    if (others.length) extras[node] = others;
  }

  const records = await mapPool(wanted, 6, async (w) => {
    const source = `${w.node}/${w.key}`;
    const target = rtdbPath(source);
    const targetSegments = target.split("/");
    assertInsideRoot(targetSegments);
    const current = present.get(w.node)!.has(w.key)
      ? await getJson(db, targetSegments)
      : null;
    const pieces = splitPieces(targetSegments, w.value, maxPutBytes);
    for (const piece of pieces) {
      if (piece.bytes > DEFAULT_WRITE_BUDGET_BYTES_PER_MIN) {
        throw new SplitError(
          `${
            piece.segments.join("/")
          } is ${piece.bytes} bytes, more than a minute's write budget`,
        );
      }
    }
    return {
      node: w.node,
      key: w.key,
      source,
      target,
      targetSegments,
      value: w.value,
      bytes: byteLength(w.value),
      hash: await hashJson(w.value),
      state: classify(current, w.value, pieces, targetSegments),
      current,
      pieces,
      notes: w.notes,
    } satisfies PlanRecord;
  });
  return { db, records, extras };
}

// ---- writing -----------------------------------------------------------------

export interface ApplyOptions {
  force?: boolean;
  /** Override the write budget (tests); defaults to rtdb-publish's. */
  budgetBytesPerMin?: number;
  log?: (line: string) => void;
}

export interface Mismatch {
  target: string;
  expected: string;
  got: string;
}

export interface ApplyResult {
  /** Every PUT made, as database paths (decoded). */
  puts: string[];
  bytesWritten: number;
  written: string[];
  skipped: string[];
  verified: string[];
  mismatches: Mismatch[];
}

/** The PUTs a record needs, given what is already there and --force. */
export function writesFor(record: PlanRecord, force = false): Piece[] {
  switch (record.state) {
    case "same":
      return [];
    case "new":
      return record.pieces;
    case "partial":
      // Pieces that already landed whole are not sent twice; classify made
      // sure those are a head of the list, so what is left goes in order.
      return record.pieces.filter((piece) =>
        canonicalJson(
          valueAt(
            record.current,
            piece.segments.slice(record.targetSegments.length),
          ),
        ) !== canonicalJson(piece.value)
      );
    case "differs":
      // A forced replace goes in ONE body: child-by-child PUTs would leave the
      // edited record's extra children behind, and removing them one by one
      // would be the DELETE this script never makes.
      return force
        ? [{
          segments: record.targetSegments,
          value: record.value,
          bytes: record.bytes,
        }]
        : [];
  }
}

/** Writes the plan (PUTs under shmupX/ only), then reads every record back. */
export async function applySplit(
  plan: Plan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const { force = false, log = console.log } = options;
  const put = makePut({
    db: plan.db,
    budgetBytesPerMin: options.budgetBytesPerMin,
    warn: log,
  });
  const result: ApplyResult = {
    puts: [],
    bytesWritten: 0,
    written: [],
    skipped: [],
    verified: [],
    mismatches: [],
  };

  // Every path is checked before the first byte goes out, so a bad plan
  // writes nothing at all rather than everything up to the bad piece.
  const writes = plan.records.map((record) => ({
    record,
    pieces: writesFor(record, force),
  }));
  for (const { pieces } of writes) {
    for (const piece of pieces) {
      assertInsideRoot(piece.segments);
      if (piece.value === null || piece.value === undefined) {
        throw new Error(`refusing to PUT null at ${piece.segments.join("/")}`);
      }
    }
  }

  for (const { record, pieces } of writes) {
    if (record.state === "differs" && !force) {
      result.skipped.push(record.target);
      // Either someone edited the shmupX copy, or cmg changed the root one
      // after an earlier run took it; both are a person's call, not ours.
      log(
        `  skip  ${record.target}: holds something other than ${record.source} (edited under ${RTDB_ROOT}/, or the root moved on); --force replaces it`,
      );
      continue;
    }
    if (!pieces.length) continue;
    for (const piece of pieces) {
      const path = piece.segments.join("/");
      result.bytesWritten += await put(restPath(piece.segments), piece.value);
      result.puts.push(path);
      log(`  PUT   ${path}  ${fmtBytes(piece.bytes)}`);
    }
    result.written.push(record.target);
  }

  // Read back everything that should now be exactly the plan's value: what
  // was written and what was already the same. Skipped records are reported
  // above, not verified — they are someone else's now.
  const skipped = new Set(result.skipped);
  const toVerify = plan.records.filter((r) => !skipped.has(r.target));
  const hashes = await mapPool(
    toVerify,
    6,
    async (r) => await hashJson(await getJson(plan.db, r.targetSegments)),
  );
  toVerify.forEach((record, i) => {
    if (hashes[i] === record.hash) {
      result.verified.push(record.target);
    } else {
      result.mismatches.push({
        target: record.target,
        expected: record.hash,
        got: hashes[i],
      });
    }
  });
  return result;
}

// ---- output ------------------------------------------------------------------

function fmtBytes(n: number): string {
  return `${n.toLocaleString("en-US")} B`;
}

function fmtMiB(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/** The plan as the dry run prints it. */
export function formatPlan(plan: Plan, force = false): string[] {
  const lines: string[] = [];
  const keyWidth = Math.max(...plan.records.map((r) => r.key.length), 4);
  for (const node of WRITE_ORDER) {
    const rows = plan.records.filter((r) => r.node === node);
    if (!rows.length) continue;
    const bytes = rows.reduce((n, r) => n + r.bytes, 0);
    lines.push(
      `${node} (${rows.length}, ${fmtBytes(bytes)})  ${node}/<key> -> ${
        rtdbPath(`${node}/<key>`)
      }`,
    );
    for (const r of rows) {
      const writes = writesFor(r, force).length;
      const shown = r.node === "levelAliases"
        ? `-> ${r.value}`
        : `${fmtBytes(r.bytes).padStart(13)}  ${
          `${r.pieces.length} PUT${r.pieces.length === 1 ? "" : "s"}`.padEnd(7)
        }  sha256 ${r.hash.slice(0, 12)}`;
      const todo = r.state === "new" ? "" : `  (${writes} to write)`;
      const notes = r.notes.length ? `  ${r.notes.join("; ")}` : "";
      lines.push(
        `  ${r.state.padEnd(7)} ${
          r.key.padEnd(keyWidth)
        }  ${shown}${todo}${notes}`,
      );
    }
    const extra = plan.extras[node];
    if (extra?.length) {
      lines.push(
        `  also under ${RTDB_ROOT}/${node}, left alone: ${extra.join(", ")}`,
      );
    }
    lines.push("");
  }
  const count = (s: RecordState) =>
    plan.records.filter((r) => r.state === s).length;
  const total = plan.records.reduce((n, r) => n + r.bytes, 0);
  const pending = plan.records.flatMap((r) => writesFor(r, force));
  const pendingBytes = pending.reduce((n, p) => n + p.bytes, 0);
  lines.push(
    `totals: ${plan.records.length} records, ${fmtBytes(total)} (${
      fmtMiB(total)
    }); ` +
      `new ${count("new")}, same ${count("same")}, partial ${
        count("partial")
      }, differs ${count("differs")}`,
  );
  lines.push(
    `a write would send ${pending.length} PUT${
      pending.length === 1 ? "" : "s"
    }, ${fmtBytes(pendingBytes)} (${fmtMiB(pendingBytes)})` +
      (count("differs") && !force
        ? `, leaving ${count("differs")} differing record(s) alone`
        : ""),
  );
  return lines;
}

// ---- the command -------------------------------------------------------------

export interface MainIO {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Passed to planSplit (tests). */
  stockFoo?: Json;
  maxPutBytes?: number;
  budgetBytesPerMin?: number;
}

/** The CLI; answers with the exit code instead of exiting, for the tests. */
export async function main(args: string[], io: MainIO = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const rest = args.filter((arg) => arg !== "--");
  let write = false;
  let force = false;
  let db = DEFAULT_DB;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--write") write = true;
    else if (arg === "--force") force = true;
    else if (arg === "--db" && rest[i + 1]) db = rest[++i];
    else if (arg.startsWith("--db=")) db = arg.slice("--db=".length);
    else {
      error(`error: unknown argument ${arg}`);
      return 2;
    }
  }
  if (force && !write) {
    error("error: --force only means something with --write");
    return 2;
  }
  db = db.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(db)) {
    error(
      `error: --db must be the database's base URL (no path; the ${RTDB_ROOT}/ root is added per node), got ${db}`,
    );
    return 2;
  }

  log(
    `${write ? "Copying" : "Dry run:"} root -> ${RTDB_ROOT}/ on ${db}${
      force ? " (--force)" : ""
    }`,
  );
  let plan: Plan;
  try {
    plan = await planSplit({
      db,
      stockFoo: io.stockFoo,
      maxPutBytes: io.maxPutBytes,
    });
  } catch (e) {
    error(`error: ${(e as Error).message}`);
    return 2;
  }
  log("");
  for (const line of formatPlan(plan, force)) log(line);
  if (!write) {
    log("\nDry run — nothing written. Re-run with --write to copy.");
    return 0;
  }

  log("");
  let result: ApplyResult;
  try {
    result = await applySplit(plan, {
      force,
      log,
      budgetBytesPerMin: io.budgetBytesPerMin,
    });
  } catch (e) {
    error(`error: write stopped: ${(e as Error).message}`);
    error("Nothing outside the plan was touched; re-run to resume.");
    return 1;
  }
  log(
    `\nWrote ${result.puts.length} PUT(s), ${fmtBytes(result.bytesWritten)}; ` +
      `verified ${result.verified.length}/${
        plan.records.length - result.skipped.length
      } record(s) by read-back.`,
  );
  if (result.mismatches.length) {
    for (const m of result.mismatches) {
      error(
        `error: ${m.target} reads back as sha256 ${
          m.got.slice(0, 12)
        }, expected ${m.expected.slice(0, 12)}`,
      );
    }
    return 1;
  }
  if (result.skipped.length) {
    log(
      `Left alone (differ under ${RTDB_ROOT}/): ${
        result.skipped.join(", ")
      }. ` +
        `Re-run with --write --force to replace them.`,
    );
    return 3;
  }
  log("Done.");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
