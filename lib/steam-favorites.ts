// Favorites become games in Steam, the way RetroDECK's Steam Sync does it.
//
// Star a game in the launcher, or a game on the Dezaemon shelf, and it gets an
// entry of its own in Steam's library: the launcher's binary, started with
// --game or --play so it opens straight into that one game and quits when the
// player leaves it (desktop.ts, routes/api/launch.ts). Unstar it and the
// entry goes. The player never adds anything by hand.
//
// What is a favorite comes from the page's own localStorage — the dashboard's
// GAME_FAVS_KEY, and the shelf's SHELF_FAVS_KEY, which the editor's SAVED
// GAMES drawer shares — and a packaged app already sends every change to those
// keys to its server (lib/kept-storage.ts). So the sync needs nothing from
// the page: main.ts hands each change here, and desktop.ts runs it once at
// startup and once on the way out, which is when RetroDECK runs its own.
//
// The entries are told apart from everything else in shortcuts.vdf by
// FAVORITES_TAG and their --game/--play, never by name or appid, so a player
// who renames one in Steam keeps it, and its appid — and with it any artwork
// they gave it — survives every later sync. Steam only reads the file when it
// starts, so new entries show after a Steam restart, as with ADD TO STEAM
// (lib/steam-library.ts says why nothing can make them show sooner).

import { dirname, join } from "@std/path";
import { decodeBase64 } from "@std/encoding/base64";
import { launcherDataDir } from "./desktop-browser.ts";
import { KEPT_FILE_NAME } from "./kept-storage.ts";
import {
  currentLauncherBinary,
  type LauncherBinary,
} from "./launcher-binary.ts";
import { installDir, installedExe } from "./launcher-install.ts";
import {
  FAVORITES_TAG,
  isFavoriteShortcut,
  makeShortcut,
  quotePath,
  shortcutAppId,
  shortcutsOf,
  signedAppId,
  tagsOf,
} from "./steam-shortcut.ts";
import {
  steamAccounts,
  steamIsRunning,
  type SteamOs,
  steamRoots,
} from "./steam-library.ts";
import { keepSteamInputOff } from "./steam-input.ts";
import { parseBinaryVdf, type VdfMap, writeBinaryVdf } from "./steam-vdf.ts";

/** The dashboard's starred rows: `[{ id, title, icon? }]`, id `<section>:<row key>`. */
export const GAME_FAVS_KEY = "cmg-game-favs";

/** The shelf's starred games: database slugs (svelte-src/Dashboard.svelte SAV_FAVS_KEY). */
export const SHELF_FAVS_KEY = "cmg-deza-favs";

/** Where the community shelf's titles and covers live (lib/shelf.ts SHELF_DB). */
export const SHELF_DB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** One favorite, as Steam should list it. */
export interface Favorite {
  /** "game:<section>:<row key>" or "shelf:<slug>": what the entry is matched by. */
  key: string;
  /** --game: the dashboard row to open. */
  game?: string;
  /** --play: the shelf game to play. */
  play?: string;
  title: string;
  /** A picture for it: a path on the launcher's own server, an https URL or a data: URL. */
  art?: string;
}

/** A starred dashboard row, as the dashboard stores it. */
export interface GameFavRecord {
  id: string;
  title: string;
  icon?: string;
}

const ROW_ID = /^[a-z0-9][a-z0-9_-]*:[^\s"']+$/i;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The dashboard's starred rows out of their stored JSON; anything malformed is dropped. */
export function readGameFavs(raw: string | null | undefined): GameFavRecord[] {
  try {
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list.flatMap((r) => {
      const id = typeof r?.id === "string" ? r.id : "";
      if (!ROW_ID.test(id) || seen.has(id)) return [];
      seen.add(id);
      const title = typeof r.title === "string" && r.title.trim()
        ? r.title.trim()
        : id.slice(id.indexOf(":") + 1);
      return [{
        id,
        title,
        ...(typeof r.icon === "string" && r.icon ? { icon: r.icon } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/**
 * The shelf's starred slugs. A shelf id (it carries a ":") names a game this
 * browser exported into IndexedDB, which a packaged app's page does not keep
 * past the launch, so Steam could not open it — the shelf never stars those
 * anyway (toggleSavFav).
 */
export function readShelfFavs(raw: string | null | undefined): string[] {
  try {
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    return [
      ...new Set(list.filter((s) => typeof s === "string" && SLUG.test(s))),
    ];
  } catch {
    return [];
  }
}

/** "g-fencer-755" → "G Fencer 755": a title for a slug whose real one is not known yet. */
export function titleFromSlug(slug: string): string {
  return slug.split("-").filter(Boolean).map((w) =>
    w[0].toUpperCase() + w.slice(1)
  ).join(" ");
}

/** Every favorite in the kept storage values, dashboard rows first. */
export function favoritesFrom(
  values: Record<string, string | null | undefined>,
  titles: Record<string, string> = {},
): Favorite[] {
  const games = readGameFavs(values[GAME_FAVS_KEY]).map((g): Favorite => ({
    key: `game:${g.id}`,
    game: g.id,
    title: g.title,
    ...(g.icon ? { art: g.icon } : {}),
  }));
  const shelf = readShelfFavs(values[SHELF_FAVS_KEY]).map((slug): Favorite => ({
    key: `shelf:${slug}`,
    play: slug,
    title: titles[slug] || titleFromSlug(slug),
  }));
  return [...games, ...shelf];
}

// ------------------------------------------------------------ launch options

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_:.\/-]+$/.test(arg)
    ? arg
    : `"${arg.replace(/"/g, '\\"')}"`;
}

/** The arguments that open the launcher on `f`. */
export function launchArgs(f: Pick<Favorite, "game" | "play">): string[] {
  if (f.play) return ["--play", f.play];
  return ["--game", f.game ?? ""];
}

/** Those arguments as Steam's one LaunchOptions string. */
export function launchOptionsFor(f: Pick<Favorite, "game" | "play">): string {
  return launchArgs(f).map(quoteArg).join(" ");
}

/** A command line split the way a shell would: spaces separate, quotes group. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && text[i + 1] === quote) cur += text[++i];
      else if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** What --game / --play an argument list names, either spelling. */
export function launchTarget(args: readonly string[]): {
  game?: string;
  play?: string;
} {
  const out: { game?: string; play?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(game|play)(?:=(.*))?$/.exec(args[i]);
    if (!m) continue;
    const value = m[2] ?? args[++i];
    if (value) out[m[1] as "game" | "play"] = value;
  }
  return out;
}

/** The favorite key an existing entry was written for, or null when it is not one of ours. */
export function favoriteKeyOf(entry: VdfMap): string | null {
  if (!isFavoriteShortcut(entry)) return null;
  const t = launchTarget(splitArgs(String(entry.LaunchOptions ?? "")));
  return t.play ? `shelf:${t.play}` : t.game ? `game:${t.game}` : null;
}

// ---------------------------------------------------------------- reconcile

export interface FavoriteTarget {
  /** The binary every entry runs (favoriteExe). */
  exe: string;
  startDir?: string;
  /** The icon file to show for a favorite, if there is one. */
  icon?: (f: Favorite) => string | undefined;
}

export interface Reconciled {
  root: VdfMap;
  added: string[];
  updated: string[];
  removed: string[];
  /** Each wanted favorite's appid, the one its artwork is filed under. */
  appIds: Map<string, number>;
  /** The appids of the entries taken out, whose artwork goes too. */
  removedAppIds: number[];
}

function sameEntry(a: VdfMap, b: VdfMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The file with exactly `wanted` as favorites' entries: new ones added, ours
 * that are no longer wanted taken out, and the rest brought up to date —
 * keeping their appid, the name the player may have given them and anything a
 * newer client wrote. Every entry that is not one of ours is kept as it was,
 * in its place; ours follow, in `wanted` order. A title some other entry
 * already uses gets a " ★", since the appid is derived from the binary and
 * the name, and two entries with one appid share their artwork in Steam.
 */
export function reconcileFavorites(
  root: VdfMap,
  wanted: readonly Favorite[],
  target: FavoriteTarget,
): Reconciled {
  const others: VdfMap[] = [];
  const ours = new Map<string, VdfMap>();
  for (const value of Object.values(shortcutsOf(root))) {
    if (!value || typeof value !== "object") continue;
    const entry = value as VdfMap;
    const key = favoriteKeyOf(entry);
    if (key && !ours.has(key)) ours.set(key, entry);
    else if (!key) others.push(entry);
    // A second entry for one favorite (a copy the player made, or two syncs
    // that raced) is dropped: there is one entry per favorite.
  }
  const out: VdfMap[] = [...others];
  const names = new Set(others.map((e) => String(e.AppName ?? "")));
  const added: string[] = [];
  const updated: string[] = [];
  const appIds = new Map<string, number>();
  const wantedKeys = new Set<string>();
  for (const f of wanted) {
    if (wantedKeys.has(f.key)) continue;
    wantedKeys.add(f.key);
    const before = ours.get(f.key);
    let name = before ? String(before.AppName ?? f.title) : f.title;
    if (!before) { while (names.has(name)) name += " ★"; }
    names.add(name);
    const fresh = makeShortcut({
      appName: name,
      exe: target.exe,
      startDir: target.startDir,
      icon: target.icon?.(f) ?? (before ? String(before.icon ?? "") : ""),
      launchOptions: launchOptionsFor(f),
      tags: [FAVORITES_TAG],
    });
    let entry = fresh;
    if (before) {
      // Steam's own keys, and the collections the player added it to, stay.
      const tags = [...new Set([...tagsOf(before), FAVORITES_TAG])];
      const tagMap: VdfMap = {};
      tags.forEach((t, i) => (tagMap[String(i)] = t));
      entry = {
        ...before,
        Exe: fresh.Exe,
        StartDir: fresh.StartDir,
        LaunchOptions: fresh.LaunchOptions,
        icon: fresh.icon,
        tags: tagMap,
        appid: typeof before.appid === "number" ? before.appid : fresh.appid,
      };
      if (!sameEntry(before, entry)) updated.push(f.key);
    } else {
      // A name changed with " ★" changes the id with it; recompute.
      entry.appid = signedAppId(shortcutAppId(quotePath(target.exe), name));
      added.push(f.key);
    }
    appIds.set(f.key, (entry.appid as number) >>> 0);
    out.push(entry);
  }
  const removed: string[] = [];
  const removedAppIds: number[] = [];
  for (const [key, entry] of ours) {
    if (wantedKeys.has(key)) continue;
    removed.push(key);
    if (typeof entry.appid === "number") removedAppIds.push(entry.appid >>> 0);
  }
  const shortcuts: VdfMap = {};
  out.forEach((e, i) => (shortcuts[String(i)] = e));
  return {
    root: { ...root, shortcuts },
    added,
    updated,
    removed,
    appIds,
    removedAppIds,
  };
}

// ------------------------------------------------------------------- binary

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * The file a favorite's entry runs, or null when this is not a packaged
 * launcher (a checkout has nothing to point Steam at).
 *
 * The launcher's own file, with two exceptions that both come down to the
 * arguments reaching it: on macOS the binary inside the bundle, since a .app
 * is opened rather than run and its arguments are not its own to keep; and on
 * Linux a plain app directory's AppRun — what the Steam build's depot is
 * entered through — when the binary sits in one. An AppImage that was
 * installed (lib/launcher-install.ts) is pointed at its installed copy, the
 * one that keeps itself current, as ADD TO STEAM does.
 */
export async function favoriteExe(opts: {
  binary: LauncherBinary | null;
  os: SteamOs;
  execPath: string;
  /** An installed copy's AppRun, when there is one (installedExe). */
  installed?: string | null;
}): Promise<string | null> {
  const b = opts.binary;
  if (!b) return null;
  if (b.kind === "appimage" && opts.installed && await isFile(opts.installed)) {
    return opts.installed;
  }
  if (b.kind === "macos-app") return opts.execPath || b.path;
  if (opts.os === "linux" && b.kind === "executable") {
    let dir = dirname(b.path);
    for (let i = 0; i < 3; i++) {
      const appRun = join(dir, "AppRun");
      if (await isFile(appRun)) return appRun;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return b.path;
}

// --------------------------------------------------------------------- sync

export interface SyncReport {
  ok: boolean;
  /** When it ran, ISO 8601. */
  at: string;
  enabled: boolean;
  steamFound: boolean;
  /** Steam has to be restarted before it shows what changed. */
  steamRunning: boolean;
  /** Accounts whose file was read. */
  accounts: number;
  favorites: number;
  added: string[];
  updated: string[];
  removed: string[];
  problems: string[];
  reason?: string;
}

/** Where a favorite's artwork goes: Steam's wide capsule, portrait capsule and hero. */
export function gridFiles(gridDir: string, appId: number): string[] {
  return [`${appId}.png`, `${appId}p.png`, `${appId}_hero.png`].map((n) =>
    join(gridDir, n)
  );
}

/**
 * Make every Steam account's favorites' entries match `wanted`.
 *
 * A file that cannot be parsed is left alone and reported, as ADD TO STEAM
 * does (it is somebody's whole non-Steam library); a file that would not
 * change is not rewritten. Artwork is written only where none is, so art the
 * player picked for an entry is never replaced, and an entry's artwork goes
 * when the entry does.
 */
export async function syncFavoritesToSteam(
  wanted: readonly Favorite[],
  opts: {
    os: SteamOs;
    env: Record<string, string>;
    exe: string;
    /** The picture for a favorite, as image bytes, or null. */
    art?: (f: Favorite) => Promise<Uint8Array | null>;
    /** The icon file for a favorite, when one has been saved. */
    icon?: (f: Favorite) => string | undefined;
    enabled?: boolean;
  },
): Promise<SyncReport> {
  const report: SyncReport = {
    ok: false,
    at: new Date().toISOString(),
    enabled: opts.enabled ?? true,
    steamFound: false,
    steamRunning: await steamIsRunning(opts.os, opts.env),
    accounts: 0,
    favorites: wanted.length,
    added: [],
    updated: [],
    removed: [],
    problems: [],
  };
  const roots = await steamRoots(opts.os, opts.env);
  report.steamFound = roots.length > 0;
  if (!roots.length) {
    report.reason = "no Steam installation found on this machine";
    return report;
  }
  const art = new Map<string, Promise<Uint8Array | null>>();
  const artFor = (f: Favorite) => {
    if (!opts.art) return Promise.resolve(null);
    if (!art.has(f.key)) art.set(f.key, opts.art(f).catch(() => null));
    return art.get(f.key)!;
  };
  const merge = (into: string[], from: string[]) => {
    for (const k of from) if (!into.includes(k)) into.push(k);
  };
  let written = 0;
  for (const root of roots) {
    for (const config of await steamAccounts(root)) {
      report.accounts++;
      const path = join(config, "shortcuts.vdf");
      let bytes = new Uint8Array(0);
      try {
        bytes = await Deno.readFile(path);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          report.problems.push(`${path}: ${(e as Error).message}`);
          continue;
        }
      }
      let result: Reconciled;
      try {
        result = reconcileFavorites(parseBinaryVdf(bytes), wanted, {
          exe: opts.exe,
          icon: opts.icon,
        });
      } catch (e) {
        report.problems.push(
          `${path}: ${(e as Error).message} — left untouched`,
        );
        continue;
      }
      if (
        result.added.length || result.updated.length || result.removed.length
      ) {
        try {
          // Unique: desktop.ts and the server each run syncs of their own.
          const temp = join(config, `.shortcuts.vdf.${crypto.randomUUID()}`);
          await Deno.writeFile(temp, writeBinaryVdf(result.root));
          await Deno.rename(temp, path);
        } catch (e) {
          report.problems.push(`${path}: ${(e as Error).message}`);
          continue;
        }
      }
      written++;
      merge(report.added, result.added);
      merge(report.updated, result.updated);
      merge(report.removed, result.removed);

      const grid = join(config, "grid");
      for (const appId of result.removedAppIds) {
        for (const file of gridFiles(grid, appId)) {
          await Deno.remove(file).catch(() => {});
        }
      }
      for (const f of wanted) {
        const appId = result.appIds.get(f.key);
        if (appId === undefined) continue;
        const files = gridFiles(grid, appId);
        const missing: string[] = [];
        for (const file of files) if (!await isFile(file)) missing.push(file);
        if (!missing.length) continue;
        const image = await artFor(f);
        if (!image) continue;
        try {
          await Deno.mkdir(grid, { recursive: true });
          for (const file of missing) await Deno.writeFile(file, image);
        } catch (e) {
          report.problems.push(`${grid}: ${(e as Error).message}`);
        }
      }
    }
  }
  report.ok = written > 0;
  if (!report.ok && !report.reason) {
    report.reason = report.accounts
      ? "Steam is installed, but none of its accounts could be written"
      : "Steam is installed but nobody has signed in to it yet";
  }
  return report;
}

// -------------------------------------------------------- state and sources

/** What the sync keeps between runs, beside the launcher's other files. */
export interface FavoritesState {
  /** Off removes every favorite's entry, and adds none. */
  enabled: boolean;
  /** Shelf titles already looked up, by slug. */
  titles: Record<string, string>;
  last?: SyncReport;
}

export const STATE_FILE = "steam-favorites.json";

export async function readFavoritesState(
  dataDir: string,
): Promise<FavoritesState> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(join(dataDir, STATE_FILE)));
    const titles: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw?.titles ?? {})) {
      if (SLUG.test(k) && typeof v === "string") titles[k] = v;
    }
    return {
      enabled: raw?.enabled !== false,
      titles,
      ...(raw?.last && typeof raw.last === "object" ? { last: raw.last } : {}),
    };
  } catch {
    return { enabled: true, titles: {} };
  }
}

export async function writeFavoritesState(
  dataDir: string,
  state: FavoritesState,
): Promise<void> {
  await Deno.mkdir(dataDir, { recursive: true });
  const file = join(dataDir, STATE_FILE);
  const part = `${file}.${crypto.randomUUID()}.part`;
  await Deno.writeTextFile(part, JSON.stringify(state, null, 2));
  await Deno.rename(part, file);
}

const FETCH_MS = 6000;

/** The shelf's own titles for `slugs` (the database index), for those `known` does not have. */
export async function lookUpTitles(
  slugs: readonly string[],
  known: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const out = { ...known };
  await Promise.all(
    slugs.filter((s) => !out[s]).map(async (slug) => {
      try {
        const res = await fetchImpl(
          `${SHELF_DB}/dezaemon/index/${encodeURIComponent(slug)}.json`,
          { signal: AbortSignal.timeout(FETCH_MS) },
        );
        const e = res.ok ? await res.json() : null;
        const title = e?.titleEn || e?.fileTitle;
        if (typeof title === "string" && title.trim()) out[slug] = title.trim();
      } catch { /* offline: the slug's own words stand in until next time */ }
    }),
  );
  return out;
}

function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(url);
  if (!m) return null;
  try {
    return decodeBase64(m[1]);
  } catch {
    return null;
  }
}

/**
 * A favorite's picture: a shelf game's title screen from the database, or the
 * dashboard row's icon, fetched from the launcher's own server at `origin`.
 */
export async function fetchFavoriteArt(
  f: Favorite,
  opts: { origin?: string; fetchImpl?: typeof fetch },
): Promise<Uint8Array | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const get = async (url: string) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  };
  try {
    if (f.play) {
      const res = await fetchImpl(
        `${SHELF_DB}/dezaemon/covers/${encodeURIComponent(f.play)}.json`,
        { signal: AbortSignal.timeout(FETCH_MS) },
      );
      const rec = res.ok ? await res.json() : null;
      return typeof rec?.png === "string" ? dataUrlBytes(rec.png) : null;
    }
    if (!f.art) return null;
    if (f.art.startsWith("data:")) return dataUrlBytes(f.art);
    if (/^https:\/\//.test(f.art)) return await get(f.art);
    if (f.art.startsWith("/") && opts.origin) {
      return await get(new URL(f.art, opts.origin).href);
    }
  } catch { /* no art is not a failure */ }
  return null;
}

/** A favorite key as a file name. */
export function artFileName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, "_") + ".png";
}

/**
 * The favorites' pictures, kept under `dir`: fetched once, read from there
 * after, so a sync with no network still has them and the shortcut's icon
 * field has a file to point at.
 */
export function keptArt(
  dir: string,
  source: (f: Favorite) => Promise<Uint8Array | null>,
): {
  art: (f: Favorite) => Promise<Uint8Array | null>;
  icon: (f: Favorite) => string | undefined;
} {
  const held = new Set<string>();
  try {
    for (const e of Deno.readDirSync(dir)) if (e.isFile) held.add(e.name);
  } catch { /* none kept yet */ }
  return {
    icon: (f) =>
      held.has(artFileName(f.key)) ? join(dir, artFileName(f.key)) : undefined,
    art: async (f) => {
      const file = join(dir, artFileName(f.key));
      try {
        return await Deno.readFile(file);
      } catch { /* not kept yet */ }
      const bytes = await source(f);
      if (bytes) {
        try {
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeFile(file, bytes);
          held.add(artFileName(f.key));
        } catch { /* kept next time, then */ }
      }
      return bytes;
    },
  };
}

// ------------------------------------------------------------------- runner

export interface RunOptions {
  /** The launcher's data directory (launcherDataDir). */
  dataDir: string;
  /** Where lib/kept-storage.ts keeps the page's values. */
  keptFile: string;
  os: SteamOs;
  env: Record<string, string>;
  /** The binary entries run, or null when there is none to point at. */
  exe: string | null;
  /** The launcher's own server, for a dashboard row's icon. */
  origin?: string;
  fetchImpl?: typeof fetch;
}

let running: Promise<SyncReport> = Promise.resolve(
  null as unknown as SyncReport,
);

/**
 * One sync, start to finish: the favorites the page kept, their shelf titles
 * (looked up once, then remembered), their pictures (fetched once, then
 * kept), and the entries written. Syncs run one at a time. With the sync
 * switched off it removes every favorite's entry instead.
 */
export function runFavoritesSync(
  opts: RunOptions,
  values: Record<string, string | null | undefined>,
): Promise<SyncReport> {
  const run = running.catch(() => {}).then(async () => {
    const state = await readFavoritesState(opts.dataDir);
    const base: SyncReport = {
      ok: false,
      at: new Date().toISOString(),
      enabled: state.enabled,
      steamFound: false,
      steamRunning: false,
      accounts: 0,
      favorites: 0,
      added: [],
      updated: [],
      removed: [],
      problems: [],
    };
    if (!opts.exe) {
      return {
        ...base,
        reason: "this is a source checkout: there is no launcher binary for " +
          "Steam to run",
      };
    }
    const slugs = readShelfFavs(values[SHELF_FAVS_KEY]);
    state.titles = await lookUpTitles(slugs, state.titles, opts.fetchImpl);
    const wanted = state.enabled ? favoritesFrom(values, state.titles) : [];
    const pictures = keptArt(
      join(opts.dataDir, "steam-art"),
      (f) => fetchFavoriteArt(f, opts),
    );
    // Fetched before the entries are written, so a new entry gets its icon
    // in the same pass rather than the next.
    await Promise.all(wanted.map((f) => pictures.art(f).catch(() => null)));
    const report = await syncFavoritesToSteam(wanted, {
      os: opts.os,
      env: opts.env,
      exe: opts.exe,
      art: pictures.art,
      icon: pictures.icon,
      enabled: state.enabled,
    });
    state.last = report;
    await writeFavoritesState(opts.dataDir, state).catch(() => {});
    return report;
  });
  running = run;
  return run;
}

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * A sync a moment from now: a burst of changes (a star, then another, or the
 * editor's drawer and the dashboard both writing) becomes one sync.
 */
export function scheduleFavoritesSync(
  opts: () => Promise<RunOptions>,
  values: () => Promise<Record<string, string | null | undefined>>,
  delayMs = 1500,
): void {
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    try {
      const run = await opts();
      const report = await runFavoritesSync(run, await values());
      // A new favorite is a new entry, and on macOS each one needs Steam
      // Input off before the pad reaches it (lib/steam-input.ts).
      if (report.ok && run.os === "darwin" && run.exe) {
        await keepSteamInputOff(
          { os: run.os, env: run.env, exes: [run.exe] },
          console.log,
        );
      }
      if (report.added.length || report.removed.length) {
        console.log(
          `  Steam favorites: +${report.added.length} −${report.removed.length}` +
            (report.steamRunning ? " (restart Steam to see them)" : ""),
        );
      }
    } catch (err) {
      console.warn(`  Steam favorites: ${(err as Error).message}`);
    }
  }, delayMs);
}

/** This machine's favorites sync, as the packaged launcher runs it. */
export async function localRunOptions(origin?: string): Promise<RunOptions> {
  const os: SteamOs = Deno.build.os === "windows"
    ? "windows"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  let env: Record<string, string> = {};
  try {
    env = Deno.env.toObject();
  } catch { /* --allow-env was not granted */ }
  const dataDir = launcherDataDir(os, env);
  let execPath = "";
  try {
    execPath = Deno.execPath();
  } catch { /* cannot say */ }
  const exe = await favoriteExe({
    binary: currentLauncherBinary(),
    os,
    execPath,
    installed: installedExe(installDir(os, env)),
  });
  return {
    dataDir,
    keptFile: join(dataDir, KEPT_FILE_NAME),
    os,
    env,
    exe,
    origin,
  };
}
