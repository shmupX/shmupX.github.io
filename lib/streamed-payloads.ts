// What the packaged app leaves out of its binary, and how it does without.
//
// The binary embeds _fresh/client — Vite's copy of static/ — whole (embedArgs
// in packages/shmup-harbor/scripts/build-desktop.ts), so everything under
// static/ ships in it unless build-desktop excludes it. These it excludes.
//
// What it leaves out it downloads once and keeps (lib/offline-store.ts), and
// sourceFor() says from where. The arcade core joins them though the binary
// never carried it: the dashboard mirrors a core through a service worker into
// Cache Storage, which a packaged app's profile does not keep past the launch,
// so the packaged server keeps the arcade player itself and the catalogue it
// serves calls the core `local`.
//
// Fresh's production staticFiles() serves from the build snapshot's file list,
// and that list still names an excluded file: opening it throws and the request
// 500s. So main.ts answers these paths ahead of staticFiles(), and only in a
// packaged app — a checkout and the deploy serve them from static/ as before.

import { ensureStored } from "./offline-store.ts";

/** Where a packaged app downloads what it does not carry: the deploy. */
export const STREAM_ORIGIN = "https://codemonkey.games";

/** static/emulators.json's origin: where the dashboard mirrors its cores from. */
export const CORE_ORIGIN = "https://cmg.easierbycode.deno.net";

/**
 * Where the arcade player's MAME engine lives: its ENGINE_REMOTE. The player
 * looks under ENGINE_DIR first, so a kept copy there is what plays offline.
 */
export const ENGINE_ORIGIN = "https://emularity-engine.ux-b.archive.org";
const ENGINE_DIR = "/arcade/emularity/engine/";

/** Cores a packaged app serves itself from its store, with each one's prefixes on CORE_ORIGIN. */
export const KEPT_CORES: Readonly<Record<string, readonly string[]>> = {
  arcade: ["/arcade/"],
};

/**
 * An arcade romset: /games/<id>/<romset>.zip, the shape every arcade row's
 * romUrl in data/eshop.json takes (tests/eshop_catalog_test.ts pins each one).
 */
export const ROMSET_PATH =
  /^\/games\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.-]+\.zip$/;

/**
 * Folders a packaged app downloads once from STREAM_ORIGIN and keeps, beside
 * the romsets (lib/offline-store.ts):
 *
 * - 2028-ai's custom BGM: 41 MB, one track that four bosses share. Should the
 *   deploy be unreachable on the first play, the level loader streams each
 *   track from its own source URL and plays the stock sound if that fails too
 *   (static/phaser-plugins/level-loader.js, _queueAudioOverrides).
 */
export const KEPT_FOLDERS: readonly string[] = [
  "/games/2028-ai/assets/custom-bgm/",
];

/** True when a packaged app keeps `pathname` from STREAM_ORIGIN rather than carrying it. */
export function keptFromDeploy(pathname: string): boolean {
  return ROMSET_PATH.test(pathname) ||
    KEPT_FOLDERS.some((p) => pathname.startsWith(p));
}

/**
 * Paths a packaged app leaves out and answers 404 for: Super Mario SP's eShop
 * archive. Its row left the catalogue, and a stale copy in a checkout would
 * otherwise still ride along.
 */
export const LEFT_OUT: readonly string[] = [
  "/games/super-mario-sp-web.zip",
];

/**
 * Folders no packaged app embeds: the Nintendo Switch's emulator core, keys
 * and cartridges, which a checkout holds under static/ for `deno task
 * members:pack` to put in the `switch` member pack (lib/member-content.ts).
 * The Steam build serves them from that pack, and so does the free launcher
 * when `--members` names one; neither has any other source for them, and a
 * cartridge runs to tens of gigabytes, which no binary should carry. Their
 * paths are answered as the pack's are: from a pack, with a MEMBER_DEFAULTS
 * entry (the cartridge list, empty), or 404 (main.ts).
 */
export const LEFT_OUT_FOLDERS: readonly string[] = [
  "/switch/core/",
  "/switch/keys/",
  "/NintendoSwitch/",
];

export function isLeftOut(pathname: string): boolean {
  return LEFT_OUT.includes(pathname) ||
    LEFT_OUT_FOLDERS.some((f) =>
      pathname === f.slice(0, -1) || pathname.startsWith(f)
    );
}

/** The romUrls a packaged app keeps: every arcade row's that has the romset shape. */
export function keptRomsets(
  eshop: ReadonlyArray<{ kind?: unknown; romUrl?: unknown }>,
): string[] {
  return eshop.flatMap((e) =>
    e.kind === "arcade" && typeof e.romUrl === "string" &&
      ROMSET_PATH.test(e.romUrl)
      ? [e.romUrl]
      : []
  );
}

/** Every static path build-desktop excludes from the binary (folders without the slash). */
export function excludedFromBinary(
  eshop: ReadonlyArray<{ kind?: unknown; romUrl?: unknown }>,
): string[] {
  return [
    ...keptRomsets(eshop),
    ...KEPT_FOLDERS,
    ...LEFT_OUT,
    ...LEFT_OUT_FOLDERS,
  ].map((p) => p.replace(/\/$/, ""));
}

/** Where a packaged app downloads `pathname` from to keep it, or null when it does not keep it. */
export function sourceFor(pathname: string): string | null {
  if (keptFromDeploy(pathname)) return STREAM_ORIGIN + pathname;
  if (pathname.startsWith(ENGINE_DIR)) {
    const name = pathname.slice(ENGINE_DIR.length);
    if (!name || name.includes("/")) return null;
    // The player asks for a core by its unzipped name (localCoreName drops the
    // .gz); the engine sends the .gz with Content-Encoding: gzip, which fetch
    // undoes, so what lands on disk is the file the player asked for.
    return `${ENGINE_ORIGIN}/${
      /\.(js|wasm)$/.test(name) ? name + ".gz" : name
    }`;
  }
  for (const prefixes of Object.values(KEPT_CORES)) {
    if (prefixes.some((p) => pathname.startsWith(p))) {
      return CORE_ORIGIN + pathname;
    }
  }
  return null;
}

interface Catalog {
  cores?: Array<{ id?: unknown; local?: unknown }>;
}

/** The emulator catalogue as a packaged app serves it: its kept cores are `local`. */
export function localizeCatalog<T extends Catalog>(catalog: T): T {
  return {
    ...catalog,
    cores: (catalog.cores ?? []).map((c) =>
      typeof c.id === "string" && c.id in KEPT_CORES ? { ...c, local: true } : c
    ),
  };
}

interface Recipe {
  driver?: unknown;
  wasmjs_filename?: unknown;
  wasm_filename?: unknown;
}

/**
 * Every page path an arcade board needs to play with no network, beyond the
 * romset: the player and its scripts, the engine recipe, the MAME core it
 * names, and the control and NVRAM files the player looks for (most boards
 * have none — those simply are not kept). Mirrors static/arcade's play.html:
 * getRecipe, resolveCoreUrl, resolveCfg, resolveNvram.
 */
export function arcadeFiles(rom: string, recipe: Recipe | null): string[] {
  const enc = encodeURIComponent;
  const files = [
    "/arcade/play.html",
    "/arcade/manifest.json",
    "/arcade/emularity/browserfs.min.js",
    "/arcade/emularity/loader.js",
    `${ENGINE_DIR}${enc(rom)}.json`,
    "/arcade/cfg/default.cfg",
    `/arcade/cfg/${enc(rom)}.cfg`,
  ];
  if (!recipe) return files;
  const driver = typeof recipe.driver === "string" && recipe.driver
    ? recipe.driver
    : rom;
  for (
    const gz of [
      typeof recipe.wasmjs_filename === "string"
        ? recipe.wasmjs_filename
        : "mamezn.js.gz",
      typeof recipe.wasm_filename === "string"
        ? recipe.wasm_filename
        : "mamezn.wasm.gz",
    ]
  ) files.push(ENGINE_DIR + enc(gz.replace(/\.gz$/i, "")));
  if (driver !== rom) files.push(`/arcade/cfg/${enc(driver)}.cfg`);
  files.push(`/arcade/nvram/${enc(driver)}/at28c16`);
  return files;
}

/**
 * Keep an arcade board whole: the romset at `romPath`, then everything
 * arcadeFiles() says its player needs. The romset is named after the board
 * (data/eshop.json's `rom`, which tests/streamed_payloads_test.ts pins), and
 * so is its engine recipe. Only the romset's failure is reported — a missing
 * cfg is normal, and a core that could not be fetched now is fetched on play.
 */
export async function keepArcadeBoard(
  romPath: string,
  opts: { root: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const source = sourceFor(romPath);
  const board = source
    ? await ensureStored(romPath, { ...opts, source })
    : null;
  if (!board?.ok) return;
  await keepArcadePlayer(romPath, opts);
}

/**
 * Everything but the romset: what keepArcadeBoard keeps once the board is
 * held. The Steam build calls it directly, since its romsets come from a
 * member pack (lib/member-packs.ts) and the player and core do not.
 */
export async function keepArcadePlayer(
  romPath: string,
  opts: { root: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const keep = (path: string) => {
    const source = sourceFor(path);
    return source
      ? ensureStored(path, { ...opts, source })
      : Promise.resolve(null);
  };
  const rom = decodeURIComponent(romPath.slice(romPath.lastIndexOf("/") + 1))
    .replace(/\.zip$/, "");
  const recipeAt = await keep(`${ENGINE_DIR}${encodeURIComponent(rom)}.json`);
  let recipe: Recipe | null = null;
  if (recipeAt?.ok) {
    try {
      recipe = JSON.parse(await Deno.readTextFile(recipeAt.file));
    } catch {
      recipe = null;
    }
  }
  await Promise.all(arcadeFiles(rom, recipe).map(keep));
}

/** The engine recipe an arcade romset's board is played by: kept once the board's player is. */
export function arcadeRecipePath(romPath: string): string {
  const rom = decodeURIComponent(romPath.slice(romPath.lastIndexOf("/") + 1))
    .replace(/\.zip$/, "");
  return `${ENGINE_DIR}${encodeURIComponent(rom)}.json`;
}

/** True for a kept folder's track manifest (custom-bgm/manifest.json). */
export function isKeptManifest(pathname: string): boolean {
  return pathname.endsWith("/manifest.json") &&
    KEPT_FOLDERS.some((p) => pathname.startsWith(p));
}

/**
 * A kept folder's manifest as a packaged app serves it: each track it names is
 * fetched first (once — later launches find them held), and only the tracks
 * the store then holds are listed. The level loader trusts a listed track and
 * never falls back from a dead local path, so a track named but not held —
 * a first launch offline, a download cut off — would play silence; unlisted,
 * it streams from its source or plays the stock sound instead.
 */
export async function keptManifest(
  pathname: string,
  opts: { root: string; fetchImpl?: typeof fetch },
): Promise<Response> {
  const keep = (path: string) =>
    ensureStored(path, { ...opts, source: sourceFor(path)! });
  const at = await keep(pathname);
  if (!at.ok) return new Response(at.reason, { status: at.status });
  let names: Record<string, unknown>;
  try {
    names = JSON.parse(await Deno.readTextFile(at.file));
  } catch {
    return new Response("unreadable manifest", { status: 502 });
  }
  const dir = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  const files = [...new Set(Object.values(names))].filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const held = new Set<string>();
  await Promise.all(files.map(async (f) => {
    if ((await keep(dir + encodeURIComponent(f))).ok) held.add(f);
  }));
  const listed: Record<string, string> = {};
  for (const [key, f] of Object.entries(names)) {
    if (typeof f === "string" && held.has(f)) listed[key] = f;
  }
  return Response.json(listed, { headers: { "cache-control": "no-store" } });
}
