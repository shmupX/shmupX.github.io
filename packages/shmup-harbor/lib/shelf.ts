// lib/shelf.ts — turn a name somebody typed into something a build can stage.
//
// `deno task build:windows "Master Arena Mod"` has always meant one thing: a
// level saved to Firebase from the editor. But the shelf holds three other
// kinds of game — the one this repo ships (static/games/2028-ai), the 262-save
// community Dezaemon 2 collection, and whatever the eShop has published — and
// none of them could be built into an app at all. `build:ps2` already reaches
// two of those (its `--sav` flag), which is exactly the asymmetry this closes:
//
//   deno task build:windows 2028_ai      → the game this repo ships, as an .exe
//   deno task build:android g-fencer-755 → a community cart, as an APK
//   deno task build:linux "My Level"     → unchanged: still the Firebase level
//
// WHAT COMES OUT
// A `ShelfHit` carries the two things every downstream builder wants and
// nothing else: the display name (which brands the app, its package id and its
// artifact filename) and, for everything that is not a cloud level, a
// `levelFile` on real disk. `node tools/build-level <name> <platform>
// --level-file <path>` already accepts exactly that and is fully offline once
// the file exists, so the Node half of the toolchain learns nothing new. A
// cloud level returns `levelFile: null` and is passed through bare, byte for
// byte as today.
//
// WHY A CART BECOMES A FILE RATHER THAN A FLAG
// A Dezaemon save is a 1,114,112-byte Saturn cart, not a level. Decoding it
// (normalize → parse → decodeSave → mapSaveToGame) is Deno-side work that
// lib/ps2/sav.ts already does for the PS2 export, and the only thing missing
// was the last hop the browser does for free: the packed sprite sheet has to
// become the `atlasImageDataURL` + `atlasFrames` pair the runtime's level
// loader merges (static/phaser-plugins/level-loader.js). Doing that here means
// a save-derived build and a Firebase-derived build hand the tool the same
// shape, and neither the tool nor the runtime has to know which it got.
//
// THE LADDER
// Resolution is a fixed, echoed order, and it never guesses between two hits:
// a name that matches two shelves is an error naming both unambiguous
// spellings. An explicit `game:` / `sav:` / `eshop:` / `deza:` / `level:`
// prefix skips straight to that rung.

import { basename, join, resolve } from "@std/path";
import { decodeBase64 } from "@std/encoding/base64";
import { ensureDir } from "@std/fs";
import { loadSavLevelFromBytes, savTitle } from "./ps2/sav.ts";
import { encodePng } from "./ps2/png.ts";
import * as deza from "@shmupx/shmup-engine";
import { repoRoot } from "./repo-root.ts";

const interleave = deza.interleave as (data: Uint8Array) => Uint8Array;

/** The two cart sizes `dezaBytesForShelf` recognises, mirrored from static/eshop-library.js. */
const LOGICAL_SAV_BYTES = 557056;
const MISTER_SAV_BYTES = 1114112;

/** The Realtime Database every shelf but the local one lives in. */
export const SHELF_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** How long a shelf lookup waits before deciding this machine is offline. */
const NET_TIMEOUT_MS = 15000;

export type ShelfKind =
  | "game"
  | "sav"
  | "eshop"
  | "deza"
  | "level";

export interface ShelfHit {
  kind: ShelfKind;
  /** The canonical slug, for the cache path and for the summary line. */
  slug: string;
  /** What the app is called: brands the package id, the window and the artifact. */
  levelName: string;
  /**
   * The level record on real disk, for `--level-file`. Null only for a cloud
   * level, which the Node tool fetches itself exactly as it always has.
   */
  levelFile: string | null;
  /** One line for the build log saying what the name was taken to mean. */
  note: string;
  /** The cart on disk, when this hit came from one — PS2 wants the .sav itself. */
  savFile?: string;
}

export interface ResolveOptions {
  /** Repo root; defaults to this module's own. */
  root?: string;
  /** `--slot`, for a cart holding more than one game. */
  slot?: number | null;
  /** `--stage`, for a cart whose stage0 is not the one to build. */
  stage?: string | null;
  /** Overrides the display name the shelf entry supplies. */
  name?: string | null;
  /** Refuse to touch the network — disk and cache only. */
  offline?: boolean;
  /** Rebuild the cached level record even when it is already there. */
  refresh?: boolean;
  log?: (message: string) => void;
}

/** A shelf lookup that failed in a way the caller should relay verbatim. */
export class ShelfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShelfError";
  }
}

const MODULE_ROOT: string = repoRoot();

/**
 * The slug the whole library keys on: lowercase, every run of non-alphanumerics
 * to one dash. Matches `slugOfTitle` in static/deza-shelf.js, `slugOf` in
 * scripts/upload-deza-saves.ts and `dezaSlugOfTitle` in the editor, so a title
 * resolves to the same id wherever it is computed — and so "2028_ai",
 * "2028-ai" and "2028 AI" are all the one game.
 *
 * One deliberate difference: those three end in `|| "save"`, and this does not.
 * They need a non-empty key because the slug IS their identity; here it is only
 * a lookup, and an all-Japanese title (which has no ASCII alphanumerics at all)
 * slugging to "" must stay a clean miss rather than silently becoming a game
 * called "save". Nothing here uses the result as a path on its own — see
 * `cacheKey`, which supplies its own fallback and a digest.
 */
export function shelfSlug(name: string): string {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** `game:2028-ai` → `{ scheme: "game", rest: "2028-ai" }`; no prefix → null scheme. */
function splitScheme(
  raw: string,
): { scheme: ShelfKind | null; rest: string } {
  const m = /^(game|sav|eshop|deza|level|cloud):(.*)$/is.exec(raw.trim());
  if (!m) return { scheme: null, rest: raw.trim() };
  const scheme = m[1].toLowerCase();
  return {
    // `cloud:` reads better on a command line than `level:`; both mean Firebase.
    scheme: (scheme === "cloud" ? "level" : scheme) as ShelfKind,
    rest: m[2].trim(),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (_e) {
    return false;
  }
}

/** A GET that says which shelf could not be reached rather than throwing a bare TypeError. */
async function getJson(
  url: string,
  what: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new ShelfError(
      `could not reach the ${what} at ${url}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    // A body left unread keeps the connection from being reused; Deno warns.
    await res.body?.cancel();
    throw new ShelfError(`${url} answered HTTP ${res.status}`);
  }
  return await res.json();
}

/** The same GET, but a network that is simply not there is a miss, not an error. */
async function tryJson(url: string, what: string): Promise<unknown> {
  try {
    return await getJson(url, what);
  } catch (_e) {
    return null;
  }
}

// ── carts ────────────────────────────────────────────────────────────────────

/**
 * Whatever a shelf handed over → the full MiSTer-layout cart.
 *
 * The Deno half of `dezaBytesForShelf` in static/eshop-library.js, and it has
 * to stay in step with it: the database stores gzip(deinterleave(sav)) because
 * the editor's single `normalize()` call is what has to be able to eat it, so
 * anything that unwraps to the 557,056-byte logical image is re-interleaved
 * here rather than being handed on half-unpacked.
 */
export async function cartBytes(raw: Uint8Array): Promise<Uint8Array> {
  const { data } = await (deza.normalize as (
    b: Uint8Array,
  ) => Promise<{ data: Uint8Array }>)(raw);
  if (data.length === LOGICAL_SAV_BYTES) return interleave(data);
  if (data.length === MISTER_SAV_BYTES) return data;
  throw new ShelfError(
    `the save unwraps to ${data.length.toLocaleString()} bytes — not a ` +
      `Dezaemon 2 cart image (expected ${LOGICAL_SAV_BYTES.toLocaleString()} ` +
      `logical or ${MISTER_SAV_BYTES.toLocaleString()} interleaved)`,
  );
}

/** Where a downloaded cart and its derived record are kept between runs. */
export function shelfCacheDir(root = MODULE_ROOT): string {
  return join(root, "build", "shelf");
}

// ── a cart becomes a level record ────────────────────────────────────────────

/**
 * A Uint8Array as base64, in 32 KB slices.
 *
 * `String.fromCharCode(...bytes)` over a megabyte-scale sheet overflows the
 * argument limit — the same reason the editor's own `bytesToBase64` chunks.
 */
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export interface SavRecordOptions {
  slot?: number | null;
  stage?: string | null;
  name?: string | null;
  label?: string | null;
  log?: (message: string) => void;
}

/**
 * The whole-game fields a browser build reads off the record but the PS2 one
 * does not — the editor's own cloud whitelist (static/editor/index.html
 * `buildLevelRecordForSav`), so a cart built here carries exactly what a cart
 * saved from the editor would.
 *
 * `deno task build:ps2` narrows a save to the single stage the console runs
 * and drops the rest, which is correct there and silently wrong here: without
 * these, static/games/2028-ai/game.bundle.js finds no music (`dezaemonBgm`),
 * no scenery (`backgroundCells`), no bullet or item tables, no drawn title
 * screen, and only one stage — a playable but gutted app.
 */
const WHOLE_GAME_KEYS = [
  "backgroundCells",
  "dezaemonBgm",
  "dezaemonBullets",
  "dezaemonItems",
  "dezaemonTitle",
  "dezaemonTitleScreen",
  "dezaemonCredits",
  "playerData2",
  "noStory",
  "storyData",
  "continueComment",
  "continueCommentEn",
  "meta",
] as const;

/** One stage as the cloud save stores it — mirrors the editor's `stageRecordForCloud`. */
function stageForCloud(src: Record<string, unknown>): Record<string, unknown> {
  const enemylist = Array.isArray(src?.enemylist) ? src.enemylist : [];
  const stage: Record<string, unknown> = { enemylist };
  if (
    Array.isArray(src?.waveRows) && src.waveRows.length === enemylist.length
  ) {
    stage.waveRows = src.waveRows;
    if (typeof src.waveInterval === "number" && src.waveInterval > 0) {
      stage.waveInterval = src.waveInterval;
    }
  }
  if (src?.background) stage.background = src.background;
  if (Array.isArray(src?.items) && src.items.length) stage.items = src.items;
  if (src?.scroll) stage.scroll = src.scroll;
  return stage;
}

/**
 * A Dezaemon cart → the level record shape the Firebase path produces.
 *
 * `loadSavLevelFromBytes` does everything except the last two hops. It hands
 * back the sprite sheet as a `Raster`, because the PS2 export wants raw pixels,
 * while the browser runtime wants the PNG data URL a canvas would have
 * produced — `atlasImageDataURL` + `atlasFrames` to
 * static/phaser-plugins/level-loader.js. And its `record` is narrowed to one
 * stage, so the whole-game half is grafted back on from the decode it already
 * did. Between them that is what makes a cart indistinguishable from a cloud
 * level to everything downstream.
 */
export async function levelRecordFromCart(
  cart: Uint8Array,
  options: SavRecordOptions = {},
): Promise<{ record: Record<string, unknown>; name: string; notes: string[] }> {
  const level = await loadSavLevelFromBytes(cart, {
    slot: options.slot ?? null,
    stage: options.stage ?? null,
    name: options.name ?? null,
    label: options.label ?? null,
  });
  const record = level.record as unknown as Record<string, unknown>;
  const game = level.game as Record<string, unknown>;
  const notes = [...level.notes];

  for (const key of WHOLE_GAME_KEYS) {
    if (game[key] !== undefined) record[key] = game[key];
  }
  // The stage the build opens on keeps carrying its own fields flat (which is
  // what an older record looks like), and `stages` carries every stage the
  // cart holds — so the app plays the whole game, not just stage0.
  const flat = game[level.stageKey] as Record<string, unknown> | undefined;
  if (flat?.scroll) record.scroll = flat.scroll;
  if (flat?.background) record.background = flat.background;
  if (Array.isArray(flat?.items) && flat.items.length) {
    record.items = flat.items;
  }

  const stages: Record<string, unknown> = {};
  for (const key of Object.keys(game)) {
    if (!/^stage\d+$/.test(key)) continue;
    stages[key] = stageForCloud(game[key] as Record<string, unknown>);
  }
  if (Object.keys(stages).length) {
    record.stages = stages;
    notes.push(
      `${Object.keys(stages).length} stage(s) carried; the app opens on ` +
        `${level.stageKey}`,
    );
  }
  const carried = WHOLE_GAME_KEYS.filter((k) => record[k] !== undefined);
  if (carried.length) notes.push(`whole-game data: ${carried.join(", ")}`);

  if (level.atlas) {
    const png = await encodePng(level.atlas.sheet);
    record.atlasImageDataURL = "data:image/png;base64," +
      base64(png as Uint8Array);
    record.atlasFrames = level.atlas.frames;
    options.log?.(
      `  atlas: ${level.atlas.sheet.width}x${level.atlas.sheet.height}, ` +
        `${Object.keys(level.atlas.frames).length} frames, ` +
        `${((png as Uint8Array).length / 1024).toFixed(0)} KB`,
    );
  } else {
    options.log?.("  atlas: none — the save carries no sprites");
  }
  // The display name is what brands the app; the record's own `name` is what
  // mints the leaderboard id (gameIdForLevel in tools/build-level). Keeping
  // them the same is what makes two builds of one cart share a board.
  record.name = level.name;
  return { record, name: level.name, notes };
}

/**
 * Where a decoded cart is cached.
 *
 * Keyed on the CART, not on its title. Two different saves can carry the same
 * title (the collection has several "-Ver.A-"/"-Ver.S-" pairs, and anyone can
 * name a file anything), a title made only of Japanese slugs to the empty
 * string, and --slot / --stage pick a different game out of the same bytes. A
 * title-keyed cache gets all three wrong the same way: it hands back a record
 * decoded from something else, silently, because the file is already there.
 * The digest closes that: a different cart, or a different slot or stage, is a
 * different file, and a re-run of the same request is still a hit.
 */
async function cacheKey(
  cart: Uint8Array,
  slug: string,
  opts: { slot?: number | null; stage?: string | null },
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", cart as BufferSource),
  );
  let hex = "";
  for (const byte of digest.subarray(0, 6)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  const suffix = `${opts.slot == null ? "" : `-s${opts.slot}`}` +
    `${opts.stage == null ? "" : `-${stageTag(opts.stage)}`}`;
  // The slug is only there to make the directory readable; the digest is what
  // makes it correct, so an unsluggable title costs legibility, not identity.
  return `${slug || "cart"}-${hex}${suffix}`;
}

/** `3`, `stage3` and `stage03` all name one stage, so they share a cache entry. */
function stageTag(stage: string): string {
  const digits = /^(?:stage)?0*(\d+)$/i.exec(stage.trim());
  return digits ? `stage${Number(digits[1])}` : shelfSlug(stage) || "stage";
}

/** Write a level record where `--level-file` can read it, and say where. */
async function cacheLevelFile(
  root: string,
  key: string,
  record: Record<string, unknown>,
): Promise<string> {
  const dir = join(shelfCacheDir(root), key);
  await ensureDir(dir);
  const path = join(dir, "level.json");
  await Deno.writeTextFile(path, JSON.stringify(record));
  return path;
}

/**
 * Reuse a cached record, renamed.
 *
 * The digest covers the cart and the slot/stage, but not `--name`: the record
 * is identical apart from its `name`, which brands the app AND mints its
 * leaderboard id (gameIdForLevel in tools/build-level). Rewriting that one
 * field is what keeps `--name "Gamma"` from shipping a game whose scores go to
 * whatever the previous build was called.
 */
async function renameCached(path: string, name: string): Promise<boolean> {
  try {
    const record = JSON.parse(await Deno.readTextFile(path));
    if (record?.name === name) return true;
    record.name = name;
    await Deno.writeTextFile(path, JSON.stringify(record));
    return true;
  } catch (_e) {
    // Unreadable or half-written — treat it as a miss and decode again.
    return false;
  }
}

// ── the rungs ────────────────────────────────────────────────────────────────

/** A cart already on disk → a cached level record. */
async function hitFromSavFile(
  path: string,
  slug: string,
  kind: ShelfKind,
  note: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit> {
  const cart = await Deno.readFile(path);
  const name = opts.name?.trim() || savTitle(path);
  // Decoding a cart is a second or two of CPU. The key covers the bytes and
  // the slot/stage, so a hit is genuinely the same game — see cacheKey.
  const key = await cacheKey(cart, slug, opts);
  const cached = join(shelfCacheDir(root), key, "level.json");
  if (
    !opts.refresh && await exists(cached) && await renameCached(cached, name)
  ) {
    opts.log?.(`${note} (cached record)`);
    return {
      kind,
      slug,
      levelName: name,
      levelFile: cached,
      note,
      savFile: path,
    };
  }
  opts.log?.(note);
  const { record, name: display, notes } = await levelRecordFromCart(cart, {
    slot: opts.slot,
    stage: opts.stage,
    name: opts.name,
    label: basename(path),
    log: opts.log,
  });
  for (const line of notes) opts.log?.(`  ${line}`);
  return {
    kind,
    slug,
    levelName: display,
    levelFile: await cacheLevelFile(root, key, record),
    note,
    savFile: path,
  };
}

/** A cart off the wire → a cached cart plus a cached level record. */
async function hitFromCartNode(
  node: { sav?: unknown; file?: unknown },
  slug: string,
  kind: ShelfKind,
  title: string,
  note: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit> {
  if (!node || typeof node.sav !== "string") {
    throw new ShelfError(
      `the shelf row for "${slug}" carries no save blob to build from`,
    );
  }
  opts.log?.(note);
  const cart = await cartBytes(decodeBase64(node.sav));
  // The cart itself is kept under the slug, which is stable and unique on both
  // remote shelves — this is what an --offline re-run reads back (cachedCart).
  const name = opts.name?.trim() || title;
  const savFile = await stashCart(root, slug, title, cart);
  const key = await cacheKey(cart, slug, opts);
  const cached = join(shelfCacheDir(root), key, "level.json");
  if (
    !opts.refresh && await exists(cached) && await renameCached(cached, name)
  ) {
    opts.log?.("  (cached record)");
    return { kind, slug, levelName: name, levelFile: cached, note, savFile };
  }
  const { record, notes } = await levelRecordFromCart(cart, {
    slot: opts.slot,
    stage: opts.stage,
    name,
    label: typeof node.file === "string" ? node.file : slug,
    log: opts.log,
  });
  for (const line of notes) opts.log?.(`  ${line}`);
  return {
    kind,
    slug,
    levelName: name,
    levelFile: await cacheLevelFile(root, key, record),
    note,
    savFile,
  };
}

/**
 * Keep a downloaded cart under its slug, so a later run can work offline.
 *
 * The title rides alongside in a sidecar because the file is named for the
 * slug, not the game: without it an offline rebuild would fall back to
 * `savTitle("g-fencer-755.sav")` and ship an app called "g-fencer-755".
 */
async function stashCart(
  root: string,
  slug: string,
  title: string,
  cart: Uint8Array,
): Promise<string> {
  const dir = join(shelfCacheDir(root), "carts");
  await ensureDir(dir);
  const path = join(dir, `${slug || "cart"}.sav`);
  await Deno.writeFile(path, cart);
  await Deno.writeTextFile(
    join(dir, `${slug || "cart"}.json`),
    JSON.stringify({ slug, title }),
  );
  return path;
}

/** The title `stashCart` filed with a cart, if it is still there. */
async function stashedTitle(
  root: string,
  slug: string,
): Promise<string | null> {
  try {
    const meta = JSON.parse(
      await Deno.readTextFile(
        join(shelfCacheDir(root), "carts", `${slug || "cart"}.json`),
      ),
    );
    const title = String(meta?.title ?? "").trim();
    return title || null;
  } catch (_e) {
    return null;
  }
}

/**
 * A cart this machine downloaded on an earlier run.
 *
 * The last rung before giving up, so a build that worked once keeps working on
 * a plane or behind `--offline` — without ever shadowing the live shelves,
 * which are still asked first whenever the network is there.
 */
async function cachedCart(
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit | null> {
  const path = join(shelfCacheDir(root), "carts", `${slug || "cart"}.sav`);
  if (!(await exists(path))) return null;
  const title = await stashedTitle(root, slug);
  return await hitFromSavFile(
    path,
    slug,
    "deza",
    `shelf: ${slug} → a cart this machine downloaded earlier ` +
      `(${opts.offline ? "--offline" : "the shelves did not answer"})`,
    // The file is named for the slug, so the title comes from the sidecar
    // rather than from the filename savTitle would read.
    { ...opts, name: opts.name?.trim() || title },
    root,
  );
}

/** The repo's own games: static/games/<slug>/foo.json is already a level record. */
async function repoGame(
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit | null> {
  const dir = join(root, "static", "games", slug);
  const foo = join(dir, "foo.json");
  if (!(await exists(foo))) return null;
  // The stock record's own `name` is the literal "foo" — a leaderboard id, not
  // a title — so the display name comes from the typed name unless the caller
  // said otherwise. Without this the app would ship called "foo".
  const note =
    `shelf: ${slug} → the game this repo ships (static/games/${slug})`;
  opts.log?.(note);
  return {
    kind: "game",
    slug,
    levelName: opts.name?.trim() || slug,
    levelFile: foo,
    note,
  };
}

/** The local .sav collection — empty in a fresh clone, since it is gitignored. */
async function localCollection(
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit | null> {
  for (
    const dir of [
      join(root, "static", "editor", "dezaemon", "saves"),
      join(root, "dev-fixtures"),
    ]
  ) {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile || !/\.(sav|bcr|bkr)$/i.test(entry.name)) continue;
      if (shelfSlug(savTitle(entry.name)) !== slug) continue;
      const path = join(dir, entry.name);
      return await hitFromSavFile(
        path,
        slug,
        "sav",
        `shelf: ${slug} → the local collection (${entry.name})`,
        opts,
        root,
      );
    }
  }
  return null;
}

/** The eShop: the committed catalog first, then whatever has been published live. */
async function eshopEntry(
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit | null> {
  let title = slug;
  let savUrl: string | null = null;
  let found = false;

  try {
    const catalog = JSON.parse(
      await Deno.readTextFile(join(root, "data", "eshop.json")),
    ) as Array<Record<string, unknown>>;
    for (const entry of catalog) {
      const id = String(entry.id ?? "");
      if (shelfSlug(id) !== slug) continue;
      if (entry.kind !== "deza") {
        throw new ShelfError(
          `"${id}" is an eShop entry of kind "${entry.kind}" — only a ` +
            `Dezaemon game (kind "deza") carries a cart a build can stage. A ` +
            `"web" entry is already a playable build; install it from the eShop.`,
        );
      }
      found = true;
      title = String(entry.name ?? entry.title ?? id);
      if (typeof entry.sav === "string") savUrl = entry.sav;
      if (typeof entry.slug === "string" && entry.slug) {
        slug = shelfSlug(entry.slug);
      }
      break;
    }
  } catch (e) {
    if (e instanceof ShelfError) throw e;
    // No catalog in this checkout, or it is not JSON — the live shelf may
    // still know the name, so this is not fatal.
  }

  if (savUrl) {
    opts.log?.(`shelf: ${slug} → the eShop catalog (${savUrl})`);
    const res = await fetch(savUrl, {
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new ShelfError(`${savUrl} answered HTTP ${res.status}`);
    }
    const cart = await cartBytes(new Uint8Array(await res.arrayBuffer()));
    return await hitFromCartNode(
      { sav: base64(cart), file: `${slug}.sav` },
      slug,
      "eshop",
      opts.name?.trim() || title,
      `shelf: ${slug} → the eShop catalog (${savUrl})`,
      opts,
      root,
    );
  }

  // A catalog row with no `sav` needs the live shelf to supply the cart, so
  // --offline can get no further than knowing the name exists.
  // Offline, the live half cannot be asked. A cart downloaded on an earlier
  // run answers instead (cachedCart, the rung after the network ones), so this
  // is a miss rather than a refusal.
  if (opts.offline) return null;

  const index = await tryJson(
    `${SHELF_DB}/eshop/index/${encodeURIComponent(slug)}.json`,
    "eShop catalog",
  ) as Record<string, unknown> | null;
  if (!index && !found) return null;
  if (index && typeof index.name === "string") title = index.name;

  const node = await tryJson(
    `${SHELF_DB}/eshop/saves/${encodeURIComponent(slug)}.json`,
    "published save",
  ) as { sav?: unknown; file?: unknown } | null;
  if (!node || typeof node.sav !== "string") return null;
  return await hitFromCartNode(
    node,
    slug,
    "eshop",
    opts.name?.trim() || title,
    `shelf: ${slug} → the eShop ("${title}", a Dezaemon 2 cart)`,
    opts,
    root,
  );
}

/** The 262-save community Dezaemon library, in the Realtime Database. */
async function communitySave(
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<ShelfHit | null> {
  if (opts.offline) return null;
  const index = await tryJson(
    `${SHELF_DB}/dezaemon/index/${encodeURIComponent(slug)}.json`,
    "community library",
  ) as Record<string, unknown> | null;
  if (!index) return null;
  const title = String(
    index.fileTitle ?? index.titleEn ?? savTitle(String(index.file ?? slug)),
  );
  const node = await getJson(
    `${SHELF_DB}/dezaemon/saves/${encodeURIComponent(slug)}.json`,
    "community save",
  ) as { sav?: unknown; file?: unknown };
  return await hitFromCartNode(
    node,
    slug,
    "deza",
    opts.name?.trim() || title,
    `shelf: ${slug} → the community library ("${title}"` +
      (index.developerEn ? ` by ${index.developerEn}` : "") + ")",
    opts,
    root,
  );
}

/** A Firebase level, the only rung that hands the name on rather than a file. */
async function cloudLevel(
  raw: string,
  opts: ResolveOptions,
): Promise<ShelfHit | null> {
  if (opts.offline) return null;
  // `?shallow=true` answers with `true` rather than the whole record, which
  // for a level with a custom atlas is several megabytes this process has no
  // use for — the Node tool fetches it again itself.
  const probe = await tryJson(
    `${SHELF_DB}/levels/${encodeURIComponent(raw)}.json?shallow=true`,
    "level database",
  );
  if (!probe) return null;
  const note = `shelf: "${raw}" → a cloud level (the build fetches it itself)`;
  opts.log?.(note);
  return {
    kind: "level",
    slug: shelfSlug(raw),
    levelName: raw,
    levelFile: null,
    note,
  };
}

// ── did you mean ─────────────────────────────────────────────────────────────

/** Levenshtein, capped — only used to rank a handful of near misses. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_v, i) => i);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

/** Every slug this machine can see, for a miss report. */
async function knownSlugs(
  opts: ResolveOptions,
  root: string,
): Promise<Array<{ slug: string; where: string }>> {
  const out: Array<{ slug: string; where: string }> = [];
  try {
    for await (const entry of Deno.readDir(join(root, "static", "games"))) {
      if (entry.isDirectory) out.push({ slug: entry.name, where: "repo" });
    }
  } catch (_e) { /* no games dir */ }
  try {
    const catalog = JSON.parse(
      await Deno.readTextFile(join(root, "data", "eshop.json")),
    ) as Array<Record<string, unknown>>;
    for (const entry of catalog) {
      out.push({ slug: shelfSlug(String(entry.id ?? "")), where: "eShop" });
    }
  } catch (_e) { /* no catalog */ }
  if (!opts.offline) {
    const index = await tryJson(
      `${SHELF_DB}/dezaemon/index.json?shallow=true`,
      "community library",
    ) as Record<string, unknown> | null;
    for (const slug of Object.keys(index ?? {})) {
      out.push({ slug, where: "community" });
    }
  }
  return out;
}

async function missReport(
  raw: string,
  slug: string,
  opts: ResolveOptions,
  root: string,
): Promise<never> {
  const all = await knownSlugs(opts, root);
  const near = all
    .map((c) => ({ ...c, d: editDistance(slug, c.slug) }))
    .filter((c) => c.d <= Math.max(2, Math.ceil(slug.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  const lines = [
    `nothing on the shelf is called "${raw}".`,
  ];
  if (near.length) {
    lines.push(
      "did you mean: " +
        near.map((c) => `${c.slug} (${c.where})`).join(", ") + "?",
    );
  }
  lines.push(
    opts.offline
      ? "--offline was passed, so only this checkout was searched. Drop the " +
        "flag to look on the eShop and in the community library."
      : "`deno task shelf:list` prints everything; `cloud:<name>` forces a " +
        "Firebase level lookup.",
  );
  throw new ShelfError(lines.join("\n  "));
}

// ── the ladder ───────────────────────────────────────────────────────────────

/**
 * Resolve a typed name to something a build can stage.
 *
 * The order is fixed so the same name always means the same game: an explicit
 * scheme, then a path on disk, then this repo's own games, the local .sav
 * collection, the eShop, the community library, and a cloud level last —
 * which keeps every `deno task build:windows "My Level"` that works today
 * working unchanged, since a name that is only a Firebase level still falls
 * all the way through to it.
 */
export async function resolveShelfName(
  raw: string,
  opts: ResolveOptions = {},
): Promise<ShelfHit> {
  const root = opts.root ?? MODULE_ROOT;
  const typed = String(raw ?? "").trim();
  if (!typed) throw new ShelfError("no game name was given");

  const { scheme, rest } = splitScheme(typed);
  const name = rest || typed;
  const slug = shelfSlug(name);

  // A browser shelf id ("<slug>:<palette>", "eshop:<id>") is a real thing a
  // user might copy out of the editor, and it names a record in ONE browser's
  // IndexedDB. Saying so beats "not found".
  if (!scheme && /^[a-z0-9-]+:(saturn|snes)$/i.test(typed)) {
    throw new ShelfError(
      `"${typed}" is a browser shelf id — that cart lives in one browser's ` +
        `IndexedDB and no shell can read it. Export it from the editor ` +
        `(→ .SAV), then build the file: --sav "<file>.sav".`,
    );
  }

  if (scheme === "sav" || /\.(sav|bcr|bkr)$/i.test(name)) {
    const path = resolve(name);
    if (!(await exists(path))) {
      throw new ShelfError(`no such cart: ${path}`);
    }
    return await hitFromSavFile(
      path,
      shelfSlug(savTitle(path)),
      "sav",
      `shelf: ${basename(path)} → a Dezaemon 2 cart on disk`,
      opts,
      root,
    );
  }

  if (scheme === "game") {
    return (await repoGame(slug, opts, root)) ??
      missReport(typed, slug, opts, root);
  }
  if (scheme === "eshop") {
    return (await eshopEntry(slug, opts, root)) ??
      (await cachedCart(slug, opts, root)) ??
      missReport(typed, slug, opts, root);
  }
  if (scheme === "deza") {
    return (await localCollection(slug, opts, root)) ??
      (await communitySave(slug, opts, root)) ??
      (await cachedCart(slug, opts, root)) ??
      missReport(typed, slug, opts, root);
  }
  if (scheme === "level") {
    // Forced: the name is passed through whether or not the probe answers, so
    // a level the shelf cannot see is still the tool's own 404 to report.
    const note = `shelf: "${name}" → a cloud level (forced by cloud:)`;
    opts.log?.(note);
    return { kind: "level", slug, levelName: name, levelFile: null, note };
  }

  // A path to a level record somebody already exported.
  if (/\.json$/i.test(name) && await exists(resolve(name))) {
    const path = resolve(name);
    let display = opts.name?.trim() || "";
    if (!display) {
      try {
        const record = JSON.parse(await Deno.readTextFile(path));
        display = String(record?.name ?? "").trim();
      } catch (_e) { /* unreadable — fall back to the filename */ }
    }
    const note = `shelf: ${basename(path)} → a level record on disk`;
    opts.log?.(note);
    return {
      kind: "level",
      slug: shelfSlug(display || basename(path)),
      levelName: display || basename(path).replace(/\.json$/i, ""),
      levelFile: path,
      note,
    };
  }

  // Both of these are on disk, so probing both costs nothing and a name that
  // means two games is caught rather than silently taken to mean the first.
  const hits: ShelfHit[] = [];
  const repo = await repoGame(slug, opts, root);
  if (repo) hits.push(repo);
  const local = await localCollection(slug, opts, root);
  if (local) hits.push(local);
  if (hits.length > 1) return ambiguous(typed, hits);
  if (hits.length === 1) return hits[0];

  const shop = await eshopEntry(slug, opts, root);
  if (shop) return shop;
  const community = await communitySave(slug, opts, root);
  if (community) return community;
  const cloud = await cloudLevel(name, opts);
  if (cloud) return cloud;
  // Last: a cart this machine already downloaded. After the live shelves, so a
  // republished save still wins when the network is there, and before the miss
  // report, so `--offline` (or a plane) can rebuild what worked yesterday.
  const cached = await cachedCart(slug, opts, root);
  if (cached) return cached;

  return await missReport(typed, slug, opts, root);
}

function ambiguous(typed: string, hits: ShelfHit[]): never {
  const scheme: Record<ShelfKind, string> = {
    game: "game:",
    sav: "sav:",
    eshop: "eshop:",
    deza: "deza:",
    level: "cloud:",
  };
  throw new ShelfError(
    `"${typed}" names more than one game on the shelf — say which:\n  ` +
      hits.map((h) => `${scheme[h.kind]}${h.slug}   (${h.note})`).join("\n  "),
  );
}

// ── the listing ──────────────────────────────────────────────────────────────

export interface ShelfListing {
  section: string;
  rows: Array<{ slug: string; title: string }>;
  note?: string;
}

/**
 * Everything this machine can build, by shelf. Used by `deno task shelf:list`
 * and by the miss report's suggestions; each section degrades to a note rather
 * than an error when its source cannot be reached.
 */
export async function listShelf(
  opts: ResolveOptions = {},
): Promise<ShelfListing[]> {
  const root = opts.root ?? MODULE_ROOT;
  const out: ShelfListing[] = [];

  const games: Array<{ slug: string; title: string }> = [];
  try {
    for await (const entry of Deno.readDir(join(root, "static", "games"))) {
      if (!entry.isDirectory) continue;
      if (await exists(join(root, "static", "games", entry.name, "foo.json"))) {
        games.push({ slug: entry.name, title: "the game this repo ships" });
      }
    }
  } catch (_e) { /* no games dir */ }
  out.push({ section: "THIS REPO", rows: games.sort(cmp) });

  const local: Array<{ slug: string; title: string }> = [];
  for (
    const dir of [
      join(root, "static", "editor", "dezaemon", "saves"),
      join(root, "dev-fixtures"),
    ]
  ) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !/\.(sav|bcr|bkr)$/i.test(entry.name)) continue;
        const title = savTitle(entry.name);
        local.push({ slug: shelfSlug(title), title });
      }
    } catch (_e) { /* not in this checkout */ }
  }
  out.push({
    section: "LOCAL .SAV COLLECTION",
    rows: local.sort(cmp),
    note: local.length
      ? undefined
      : "empty — the collection is gitignored; the community library below " +
        "holds the same saves",
  });

  const shop: Array<{ slug: string; title: string }> = [];
  try {
    const catalog = JSON.parse(
      await Deno.readTextFile(join(root, "data", "eshop.json")),
    ) as Array<Record<string, unknown>>;
    for (const entry of catalog) {
      shop.push({
        slug: shelfSlug(String(entry.id ?? "")),
        title: `${entry.name ?? entry.id} (${entry.kind})`,
      });
    }
  } catch (_e) { /* no catalog */ }
  out.push({ section: "ESHOP", rows: shop.sort(cmp) });

  if (opts.offline) {
    out.push({
      section: "COMMUNITY LIBRARY",
      rows: [],
      note: "--offline — not queried",
    });
    return out;
  }
  const index = await tryJson(
    `${SHELF_DB}/dezaemon/index.json`,
    "community library",
  ) as Record<string, Record<string, unknown>> | null;
  if (!index) {
    out.push({
      section: "COMMUNITY LIBRARY",
      rows: [],
      note: "unreachable — showing only what is in this checkout",
    });
    return out;
  }
  out.push({
    section: "COMMUNITY LIBRARY",
    rows: Object.entries(index).map(([slug, row]) => ({
      slug,
      title: String(row?.fileTitle ?? row?.titleEn ?? slug),
    })).sort(cmp),
  });
  return out;
}

function cmp(
  a: { slug: string },
  b: { slug: string },
): number {
  return a.slug.localeCompare(b.slug);
}
