// scripts/reimport-cloud-level.ts — decode a cloud level's Dezaemon 2 cart
// again with today's engine and publish the result over the record, in place.
//
//   deno task level:reimport Ramsie                       # what it would publish; writes nothing
//   deno task level:reimport Ramsie -- --write            # publish it
//   deno task level:reimport Ramsie -- --sav "Dez 2 - Ramsie.sav" --write   # from a cart on disk
//   deno task level:reimport Ramsie -- --restore build/cloud-levels/Ramsie.1787621269033.json --write
//   deno task level:reimport Ramsie -- --out build/ramsie.json   # the record it would publish, as a file
//
// A level imported from a cart is a snapshot of what the importer knew the
// day it ran. shmupX/levels/Ramsie was saved in August 2026 by an importer
// that did not yet pull the cart's own ship, bullets and item icons out of
// the global art bank (the record flies the stock 2028.Ai ship, duke) and
// wrote the scenery's flip bits in the convention the engine has since
// corrected (decode-stage.js: bit15 is the vertical flip, bit14 the
// horizontal; the earlier reading had them swapped). Today's runtime reads
// such a record faithfully, which is the problem: every mirrored tile draws
// flipped the wrong way, and the boss chambers come out scrambled. Nothing in
// the runtime can put the ship back — the record never carried its frames —
// so the fix is the record, decoded afresh.
//
// This runs the decode the editor's ".SAV LOAD GAME" would (the harbor's
// shelf: normalize → parse → decodeSave → mapSaveToGame → levelRecordFromCart,
// the same pipeline every build by name takes) and lays the result out the
// way the editor's SAVE writes a cloud level. The cart decides everything it
// knows: stages, scenery, ship, bullets, items, music, title screen, settings.
// What only the editor knows is kept from the record it replaces — the
// leaderboard id above all (a new one would orphan the game's scores), the
// GOD MODE knob, the CABINET, the staff-roll attribution, custom audio, a
// story the author wrote, title art, UI atlas overrides. Frame thumbnails are
// dropped: the editor rebuilds them from the atlas on LOAD. A frame is named
// by its file, and RTDB refuses a key with a dot in it, so the atlas map is
// keyed the way the editor's SAVE keys it — ONE DOT LEADER (U+2024) in the
// dot's place, which every reader turns back.
//
// The level is shmupX's copy, shmupX/levels/<key> (lib/rtdb-root.ts), found
// the way a subdomain finds it: the name as typed, then the alias index. The
// cart is the community library's (RTDB dezaemon/saves/<slug>, by the key's
// slug — "Ramsie" is "ramsie"), the local collection when this checkout has
// one, or `--sav <file>`. cmg's root-level levels/* is never touched, which
// is also what makes this reversible: the root copy is the record as it was.
//
// WRITES ARE OPT-IN, as in level:normalize and level:alias: without --write
// this prints what would change and stops. Either way the record as it stands
// is written to build/cloud-levels/<key>.<savedAt>.json first, and
// `--restore <that file> --write` puts it back. A write is ONE PUT of the
// whole record — a reader never sees half of it — through the throttled,
// print=silent put every publisher shares (scripts/lib/rtdb-publish.ts).
// Exit codes: 0 done (or dry run), 1 a read or write failed, 2 the arguments
// or the level.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { decodeBase64 } from "@std/encoding/base64";
import {
  CLOUD_DB,
  cloudLevelUrl,
  resolveCloudLevel,
} from "@shmupx/shmup-harbor/cloud-level";
import {
  resolveShelfName,
  SHELF_DB,
  ShelfError,
  shelfSlug,
} from "@shmupx/shmup-harbor/shelf";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { rtdbPath } from "../lib/rtdb-root.ts";
import { gameIdForLevel } from "../static/phaser-plugins/level-loader.js";
import { GENRE_JA, makePut } from "./lib/rtdb-publish.ts";

export type Json = Record<string, unknown>;

/**
 * What the editor knows about a game and a cart cannot: carried from the
 * record being replaced, when it has them. `gameId` first — it names the
 * leaderboard, and a re-minted one would move the game's scores.
 */
export const EDITOR_KEYS = [
  "gameId",
  "godMode",
  "cabinet",
  "attribution",
  "customAudioURLs",
  "storyData",
  "sceneScripts",
  "titleBgDataURL",
  "logoDataURL",
  "subTitleDataURL",
  "titleStartTextDataURL",
  "uiAtlases",
  "ownCutin",
  "ownItems",
  "stageBackgrounds",
] as const;

/** The server stamps the save time, as the editor's SAVE has it do. */
export const SERVER_TIMESTAMP = { ".sv": "timestamp" } as const;

/**
 * The community credits the editor attaches to an import from the library's
 * index row (dezaItemFromRtdb / dezaCreditsFromMeta in static/editor): the
 * games-db join the upload already did. Null for a row the table knows
 * nothing about, as the editor leaves it.
 */
export function creditsFromIndex(row: Json | null | undefined): Json | null {
  if (!row || typeof row !== "object" || !row.genre) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const genre = str(row.genre);
  return {
    title: str(row.titleEn) ?? str(row.fileTitle),
    titleJa: str(row.titleJa),
    developer: str(row.developerEn),
    developerJa: str(row.developerJa),
    genre,
    genreJa: str(row.genreJa) ?? (genre && GENRE_JA[genre]) ?? null,
    url: str(row.url),
  };
}

/** `playerData.name (first frame)`, for the report. */
export function describeShip(record: Json | null | undefined): string {
  const player = record?.playerData as Json | undefined;
  if (!player || typeof player !== "object") return "(none)";
  const texture = Array.isArray(player.texture) ? player.texture : [];
  const name = typeof player.name === "string" ? player.name : "?";
  return texture.length ? `${name} (${String(texture[0])})` : name;
}

/** The u16be tile words of a stage's scenery, or null when it has none. */
function tileWords(
  bg: unknown,
): { rows: number; cols: number; words: Uint16Array } | null {
  const b = bg as Json | null;
  if (!b || typeof b !== "object" || typeof b.tiles !== "string") return null;
  const rows = Number(b.rows), cols = Number(b.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(b.tiles);
  } catch (_e) {
    return null;
  }
  const count = rows * cols;
  if (bytes.length < count * 2) return null;
  const words = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    words[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  }
  return { rows, cols, words };
}

export interface TileDiff {
  /** Cells in the grid. */
  cells: number;
  /** Cells that differ at all. */
  differ: number;
  /** Of those: the same cell with its two flip bits swapped. */
  flipSwapped: number;
}

/**
 * How two scenery grids differ, or null when they are not the same shape
 * (one missing, or a different size — then the whole thing changes).
 */
export function tileDiff(before: unknown, after: unknown): TileDiff | null {
  const a = tileWords(before), b = tileWords(after);
  if (!a || !b || a.rows !== b.rows || a.cols !== b.cols) return null;
  let differ = 0, flipSwapped = 0;
  for (let i = 0; i < a.words.length; i++) {
    const x = a.words[i], y = b.words[i];
    if (x === y) continue;
    differ++;
    if (
      x !== 0xffff && y !== 0xffff && (x & 0x3fff) === (y & 0x3fff) &&
      (x & 0xc000) !== 0 && (y & 0xc000) !== 0 &&
      ((x & 0x4000) !== 0) === ((y & 0x8000) !== 0) &&
      ((x & 0x8000) !== 0) === ((y & 0x4000) !== 0)
    ) flipSwapped++;
  }
  return { cells: a.words.length, differ, flipSwapped };
}

export interface BuildOptions {
  /** The record under shmupX/levels/<key> as it stands ({} when none). */
  existing: Json;
  /** What levelRecordFromCart made of the cart. */
  cart: Json;
  /** The level's key, the fallback for a record with no name. */
  key: string;
  /** The library's index row for the cart, when it is in the library. */
  index?: Json | null;
  /** The runtime's gameIdForLevel, for a record that never had an id. */
  deriveGameId: (level: Json) => string | null;
}

export interface BuildReport {
  /** Top-level keys the cart decided. */
  fromCart: string[];
  /** Top-level keys carried over from the record. */
  kept: string[];
  /** Top-level keys of the record that the new one does not have. */
  dropped: string[];
}

/**
 * RTDB refuses a key that is empty or holds `.`, `$`, `#`, `[`, `]` or `/`,
 * and a frame is named by its file ("deza0_00_0.gif"). The editor's SAVE
 * keys such a map with ONE DOT LEADER (U+2024) in the dot's place and every
 * reader turns it back (the editor's LOAD, lib/ps2/assets.ts, the parity
 * rig); a cart's decode names its frames plainly, so the maps it hands over
 * are re-keyed here the same way.
 */
export const DOT_LEADER = "․";
/** The top-level maps a record keys by frame name. */
export const FRAME_MAPS: ReadonlySet<string> = new Set([
  "atlasFrames",
  "frameThumbnails",
]);
export function rtdbFrameKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map((
      [name, frame],
    ) => [name.replaceAll(".", DOT_LEADER), frame]),
  );
}

/**
 * The record to publish: the cart's decode laid out as the editor's SAVE
 * writes it, with what only the editor knows carried over.
 */
export function buildPayload(
  { existing, cart, key, index, deriveGameId }: BuildOptions,
): { payload: Json; report: BuildReport } {
  const payload: Json = {};
  const fromCart: string[] = [];
  for (const [k, v] of Object.entries(cart)) {
    if (v === undefined || v === null) continue;
    payload[k] = FRAME_MAPS.has(k) ? rtdbFrameKeys(v) : v;
    fromCart.push(k);
  }
  // The record's own name is what it is called everywhere (the title, the
  // board's meta); the cart's title only names a record that had none.
  const own = typeof existing.name === "string" ? existing.name.trim() : "";
  const cartName = typeof cart.name === "string" ? cart.name.trim() : "";
  payload.name = own || cartName || key;

  const kept: string[] = [];
  for (const k of EDITOR_KEYS) {
    const v = existing[k];
    if (v === undefined || v === null) continue;
    payload[k] = v;
    kept.push(k);
  }
  // A story the author wrote in the editor comes with the author's own
  // no-story setting; a cart alone has no story and says so.
  if (existing.storyData && typeof existing.noStory === "boolean") {
    payload.noStory = existing.noStory;
    kept.push("noStory");
  }
  const existingId = typeof existing.gameId === "string"
    ? existing.gameId.trim()
    : "";
  if (!existingId) {
    // Written down, as rtdb:split pinned it, so the editor's first save does
    // not mint a random id and move the board the name already scores to.
    const derived = deriveGameId({ name: payload.name });
    if (derived) {
      payload.gameId = derived;
      fromCart.push("gameId");
    }
  }
  // Who made it, as the staff roll will say: the library's row knows the
  // developer; the cart only its own title comment; the record what the
  // editor attached when it was imported.
  const credits = creditsFromIndex(index) ??
    (cart.dezaemonCredits as Json | undefined) ??
    (existing.dezaemonCredits as Json | undefined) ??
    { title: payload.name };
  payload.dezaemonCredits = credits;
  payload.savedAt = SERVER_TIMESTAMP;

  const dropped = Object.keys(existing).filter((k) => !(k in payload)).sort();
  return {
    payload,
    report: { fromCart: fromCart.sort(), kept: kept.sort(), dropped },
  };
}

/** The stages a record carries, flat stage first, in stage order. */
function stageKeysOf(record: Json): string[] {
  const stages = record.stages as Json | undefined;
  const keys = stages && typeof stages === "object"
    ? Object.keys(stages).filter((k) => /^stage\d+$/.test(k))
    : [];
  return keys.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}

/** The dry run's account of what changes, one line per thing. */
export function compareRecords(existing: Json, payload: Json): string[] {
  const lines: string[] = [];
  const meta = (r: Json) => (r.meta as Json | undefined)?.source ?? "(none)";
  lines.push(
    `ship:        ${describeShip(existing)} -> ${describeShip(payload)}`,
  );
  lines.push(
    `meta.source: ${String(meta(existing))} -> ${String(meta(payload))}`,
  );
  const frames = (r: Json) =>
    r.atlasFrames && typeof r.atlasFrames === "object"
      ? Object.keys(r.atlasFrames as Json).length
      : 0;
  lines.push(`atlas:       ${frames(existing)} -> ${frames(payload)} frames`);
  const cells = (r: Json) =>
    Array.isArray(r.backgroundCells) ? r.backgroundCells.length : 0;
  lines.push(
    `scenery:     ${cells(existing)} -> ${cells(payload)} cells`,
  );
  const before = (existing.stages ?? {}) as Json;
  const after = (payload.stages ?? {}) as Json;
  for (const k of stageKeysOf(payload)) {
    const stage = after[k] as Json;
    const rows = Array.isArray(stage.enemylist) ? stage.enemylist.length : 0;
    const bg = stage.background as Json | undefined;
    let line = `${k}:      ${rows} rows`;
    if (bg) {
      line += `, scenery ${bg.cols}x${bg.rows}`;
      const was = (before[k] as Json | undefined)?.background;
      const diff = tileDiff(was, bg);
      if (!was) line += " (new)";
      else if (diff === null) line += " (replaced)";
      else if (diff.differ === 0) line += " (same)";
      else {
        line += ` (${diff.differ} of ${diff.cells} cells change`;
        if (diff.flipSwapped) line += `, ${diff.flipSwapped} re-flipped`;
        line += ")";
      }
    }
    lines.push(line);
  }
  for (const k of stageKeysOf(existing)) {
    if (!(k in after)) lines.push(`${k}:      dropped`);
  }
  return lines;
}

// ---- The run -----------------------------------------------------------------

function fail(message: string, code = 2): never {
  console.error(`error: ${message}`);
  Deno.exit(code);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${url} answered HTTP ${res.status}`);
  }
  return await res.json();
}

/** A key as a file name: anything a path would mind becomes an underscore. */
function fileSafe(key: string): string {
  return key.replace(/[^\w.-]+/g, "_") || "level";
}

async function main(): Promise<number> {
  const args = Deno.args.filter((arg) => arg !== "--");
  const write = args.includes("--write");
  const valueOf = (flag: string): string | null => {
    const at = args.indexOf(flag);
    if (at < 0) return null;
    const value = args[at + 1];
    if (!value || value.startsWith("--")) fail(`${flag} wants a file`);
    return value;
  };
  const savFile = valueOf("--sav");
  const restoreFile = valueOf("--restore");
  const outFile = valueOf("--out");
  const taken = new Set([savFile, restoreFile, outFile]);
  const names = args.filter((arg, i) =>
    !arg.startsWith("--") && !(taken.has(arg) && args[i - 1]?.startsWith("--"))
  );
  if (names.length !== 1) {
    fail(
      "expected exactly one level name, e.g. deno task level:reimport Ramsie",
    );
  }
  if (savFile && restoreFile) fail("--sav and --restore contradict each other");
  const asked = names[0];

  // The level, found the way a subdomain finds it: the key as typed, then
  // the alias index. Shallow first — its atlas is megabytes — then whole.
  let found;
  try {
    found = await resolveCloudLevel(asked, { shallow: true });
  } catch (e) {
    fail(`could not read ${rtdbPath("levels")}: ${(e as Error).message}`, 1);
  }
  if (!found) {
    fail(
      `no cloud level is called "${asked}" (${rtdbPath("levels")}, nor the ` +
        `alias index ${rtdbPath("levelAliases")})`,
    );
  }
  const key = found.key;
  if (found.alias) console.log(`"${asked}" is an alias of "${key}"`);
  const levelPath = rtdbPath(`levels/${encodeURIComponent(key)}`);
  const existing = (await getJson(cloudLevelUrl(key, CLOUD_DB)) ?? {}) as Json;
  if (!Array.isArray(existing.enemylist)) {
    fail(`${levelPath} is not a level record (no enemylist)`);
  }
  const existingSize = JSON.stringify(existing).length;
  console.log(
    `${levelPath}: "${existing.name}", ${
      (existingSize / 1024 / 1024).toFixed(1)
    } MB, ` +
      `saved ${
        typeof existing.savedAt === "number"
          ? new Date(existing.savedAt).toISOString()
          : "(no savedAt)"
      }`,
  );

  // The record as it stands, kept where --restore can find it.
  const stamp = typeof existing.savedAt === "number"
    ? String(existing.savedAt)
    : String(Date.now());
  const backupDir = join(repoRoot(), "build", "cloud-levels");
  await ensureDir(backupDir);
  const backup = join(backupDir, `${fileSafe(key)}.${stamp}.json`);
  await Deno.writeTextFile(backup, JSON.stringify(existing));
  console.log(`backup:      ${backup}`);

  const put = makePut({ db: CLOUD_DB });

  if (restoreFile) {
    let record: Json;
    try {
      record = JSON.parse(await Deno.readTextFile(restoreFile));
    } catch (e) {
      fail(`could not read ${restoreFile}: ${(e as Error).message}`);
    }
    if (
      !record || typeof record !== "object" || !Array.isArray(record.enemylist)
    ) {
      fail(`${restoreFile} is not a level record (no enemylist)`);
    }
    console.log(
      `restore:     ${restoreFile} -> ${levelPath} ` +
        `("${record.name}", ${
          (JSON.stringify(record).length / 1024 / 1024).toFixed(1)
        } MB)`,
    );
    if (!write) {
      console.log(
        "\nDry run — nothing written. Re-run with --write to restore.",
      );
      return 0;
    }
    await put(levelPath, record);
    console.log("Restored.");
    return 0;
  }

  // The cart, decoded the way every build by name decodes one.
  const slug = shelfSlug(key);
  let hit;
  try {
    hit = await resolveShelfName(savFile ? `sav:${savFile}` : `deza:${key}`, {
      name: typeof existing.name === "string" ? existing.name : key,
      refresh: true,
      log: (s) => console.log(s),
    });
  } catch (e) {
    if (e instanceof ShelfError) fail(e.message);
    throw e;
  }
  if (!hit.levelFile) fail(`the shelf answered "${asked}" with no record`);
  const cart = JSON.parse(await Deno.readTextFile(hit.levelFile)) as Json;
  let index: Json | null = null;
  try {
    index = (await getJson(
      `${SHELF_DB}/dezaemon/index/${encodeURIComponent(slug)}.json`,
    )) as Json | null;
  } catch (_e) {
    // Not in the library (a cart on disk, say): the credits fall back.
  }

  const { payload, report } = buildPayload({
    existing,
    cart,
    key,
    index,
    // The runtime's own derivation, off the loader the website runs.
    deriveGameId: (level) => gameIdForLevel(level) as string | null,
  });
  const size = JSON.stringify(payload).length;
  console.log("");
  for (const line of compareRecords(existing, payload)) console.log(line);
  console.log(`from the cart:   ${report.fromCart.join(", ")}`);
  console.log(`kept as is:      ${report.kept.join(", ") || "(nothing)"}`);
  console.log(`dropped:         ${report.dropped.join(", ") || "(nothing)"}`);
  console.log(`record:          ${(size / 1024 / 1024).toFixed(1)} MB`);
  // The record as it would go up, for a look or for `deno task game:debug`'s
  // level server — the same bytes whether or not this run publishes.
  if (outFile) {
    await Deno.writeTextFile(outFile, JSON.stringify(payload));
    console.log(`written to:      ${outFile}`);
  }

  if (!write) {
    console.log("\nDry run — nothing written. Re-run with --write to publish.");
    return 0;
  }
  console.log(`\nPUT ${levelPath} ...`);
  await put(levelPath, payload);
  // Read back what a visitor's level loader reads first.
  const base = `${CLOUD_DB}/${levelPath}`;
  const [name, ship, source, savedAt] = await Promise.all([
    getJson(`${base}/name.json`),
    getJson(`${base}/playerData/name.json`),
    getJson(`${base}/meta/source.json`),
    getJson(`${base}/savedAt.json`),
  ]);
  if (name !== payload.name || ship !== (payload.playerData as Json).name) {
    fail(
      `read-back of ${levelPath} does not match what was written ` +
        `(name ${String(name)}, ship ${String(ship)})`,
      1,
    );
  }
  console.log(
    `Published: "${String(name)}" flies ${String(ship)}, meta.source ` +
      `${String(source)}, savedAt ${
        typeof savedAt === "number" ? new Date(savedAt).toISOString() : "?"
      }.`,
  );
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
