// The offline half of scripts/testdrive-ps2-textures.ts: which sheet budgets
// a disc could be built at, what each costs the Graphics Synthesizer, which
// one is the sharpest that still fits, and how a browser sheet is reduced to
// the texel density the disc would carry. tests/testdrive_textures_test.ts
// pins it; nothing here reads a file or opens a browser.
//
// THE QUESTION. The PS2 export repacks the editor's 2048px sheets into small
// power-of-two atlases (lib/ps2/assets.ts; 512 by default) and the console
// scales every frame back up, so sprites keep their size and lose texture.
// `--atlas-max 1024` buys sharpness with VRAM, and the only honest way to say
// whether that is worth it for a given level is to look. Play! cannot boot
// the disc, so the look has to happen in the web runtime: the same stage in
// the same version, side by side, each pane's sheets reduced to what the disc
// would hold at that budget.
//
// THE THRESHOLD. The GS has 4 MB. The frame buffer — 640×448, 32-bit, double
// buffered — takes 2.19 MB of it before a texture is uploaded, and every
// sheet goes up as 8-bit indexed (one byte a texel; encodeSheet in
// assets.ts). A budget whose sheets, plus that buffer, fit in the 4 MB is
// within the threshold; over it, AthenaEnv's texture manager starts evicting
// and re-uploading sheets over DMA every frame, which no sharpness repays.
//
// A WHOLE DISC AT 1024 RARELY FITS: three 1 MB sheets and the buffer are
// 5.2 MB. What does fit is some of the sheets at 1024 — the export packs
// every sheet at one cap today, but the GS does not care which cap a sheet
// came from, only how many texels are up — so when no whole-disc budget is
// sharper than the baseline, the right pane is the sharpest MIX: sheets
// upgraded one at a time, in the order a player sees them (the enemies and
// bullets in game_asset, the level's own sprites, then the UI), while the
// total stays under the threshold. The report says which, and that a
// per-sheet --atlas-max is what would build it.

import {
  cut,
  downscale,
  resizeTo,
} from "../../packages/shmup-harbor/lib/ps2/raster.ts";
import type { Raster } from "../../packages/shmup-harbor/lib/ps2/png.ts";

/** The console's video memory, and what the frame buffer takes of it. */
export const GS_VRAM_BYTES = 4 * 1024 * 1024;
export const FRAMEBUFFER_BYTES = 640 * 448 * 4 * 2;

/** The sheet caps a disc can be built at: the export's default and the GS's ceiling. */
export const DEFAULT_SHEET = 512;
export const SHEET_BUDGETS = [512, 1024];

/** The sheets a mix upgrades, most visible first. */
export const UPGRADE_ORDER = ["game_asset", "level_atlas", "game_ui"];

/** One staged sheet: its name on the disc and its texel dimensions. */
export interface Sheet {
  name: string;
  w: number;
  h: number;
}

/** A disc built at one budget — or mixed from two — and what it costs the GS. */
export interface Budget {
  /** "512", "1024", or "mixed" for a per-sheet pick. */
  label: string;
  /** The cap every sheet was packed under; null for a mix. */
  maxSheet: number | null;
  sheets: Sheet[];
  /** Texels, one byte each, plus the frame buffer. */
  vramBytes: number;
  /** Against the threshold it was judged by. */
  fits: boolean;
  /** `scale` per sheet: 4 means the sheet holds a quarter of the source texels per axis. */
  scales: Record<string, number>;
}

/** Width and height off a PNG's IHDR; the staged sheets never get decoded. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } {
  if (bytes.length < 24) throw new Error("png: too short for an IHDR");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/**
 * The display scales assets.ts reports for the sheets it repacked, read off
 * its build notes: "<name>: … -> WxH at 1/N". The notes are the one place the
 * number comes out of stageAssets, and the wording is pinned by the test.
 */
export function sheetScales(notes: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const note of notes) {
    const m = /^([a-z_]+): .*? at 1\/(\d+)/.exec(note);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function cost(sheets: Sheet[]): number {
  return sheets.reduce((n, s) => n + s.w * s.h, 0) + FRAMEBUFFER_BYTES;
}

/** What a disc built at `maxSheet` with these sheets costs, and whether it fits `vram`. */
export function budgetOf(
  maxSheet: number,
  sheets: Sheet[],
  scales: Record<string, number>,
  vram = GS_VRAM_BYTES,
): Budget {
  const vramBytes = cost(sheets);
  return {
    label: String(maxSheet),
    maxSheet,
    sheets,
    vramBytes,
    fits: vramBytes <= vram,
    scales,
  };
}

/**
 * The sharpest mix of `base`'s sheets and `sharper`'s that fits `vram`:
 * sheets are swapped for the sharper build's one at a time in UPGRADE_ORDER
 * (then any the order does not name), each kept only if the total still
 * fits. Null when not one sheet could be upgraded.
 */
export function mixSharpest(
  base: Budget,
  sharper: Budget,
  vram = GS_VRAM_BYTES,
): Budget | null {
  const sheets = base.sheets.map((s) => ({ ...s }));
  const scales = { ...base.scales };
  const names = [
    ...UPGRADE_ORDER,
    ...sheets.map((s) => s.name).filter((n) => !UPGRADE_ORDER.includes(n)),
  ];
  let upgraded = 0;
  for (const name of names) {
    const i = sheets.findIndex((s) => s.name === name);
    const to = sharper.sheets.find((s) => s.name === name);
    if (i < 0 || !to) continue;
    const from = sheets[i];
    // Only an upgrade counts: the same sheet at the same scale is no change,
    // and a sheet the sharper build packed SMALLER (it can, when fewer
    // frames fell under the cap) is not one.
    if ((sharper.scales[name] ?? 1) >= (base.scales[name] ?? 1)) continue;
    sheets[i] = { ...to };
    if (cost(sheets) > vram) {
      sheets[i] = from;
      continue;
    }
    scales[name] = sharper.scales[name];
    upgraded++;
  }
  if (!upgraded) return null;
  return {
    label: "mixed",
    maxSheet: null,
    sheets,
    vramBytes: cost(sheets),
    fits: true,
    scales,
  };
}

/**
 * The two discs worth putting beside each other: the export's default on the
 * left, and on the right the largest whole-disc budget that fits — or, when
 * none does, the sharpest mix of sheets that does. `sharp` is null when
 * nothing at all is sharper within the threshold, and the caller says so
 * instead of recording two identical panes.
 */
export function pickPair(
  budgets: Budget[],
  baseline = DEFAULT_SHEET,
  vram = GS_VRAM_BYTES,
): { base: Budget; sharp: Budget | null } {
  const base = budgets.find((b) => b.maxSheet === baseline);
  if (!base) throw new Error(`no budget was built at ${baseline}`);
  const above = budgets
    .filter((b) => b.maxSheet !== null && b.maxSheet! > baseline)
    .sort((a, b) => b.maxSheet! - a.maxSheet!);
  const whole = above.find((b) => b.fits);
  if (whole) return { base, sharp: whole };
  for (const candidate of above) {
    const mix = mixSharpest(base, candidate, vram);
    if (mix) return { base, sharp: mix };
  }
  return { base, sharp: null };
}

/**
 * A sheet at the disc's texel density, at the browser's size.
 *
 * The export box-filters every frame down by `scale` (atlas.ts) and the
 * console draws the result scaled back up; this does the same to the whole
 * sheet and scales it back with nearest-neighbour, so each pane's textures
 * are what that disc would carry, in a sheet the runtime loads unchanged.
 * The export pads each frame to a multiple of the scale before filtering so
 * blocks line up with the sprite's own edges; filtering the sheet whole
 * misaligns a frame's blocks by up to scale−1 texels, which moves a smudge
 * and never sharpens or blurs it. Scale 1 is the sheet untouched.
 */
export function degrade(sheet: Raster, scale: number): Raster {
  if (scale <= 1) return sheet;
  const w = Math.ceil(sheet.width / scale) * scale;
  const h = Math.ceil(sheet.height / scale) * scale;
  const padded = w === sheet.width && h === sheet.height
    ? sheet
    : cut(sheet, { x: 0, y: 0, w: sheet.width, h: sheet.height }, w, h, 0, 0);
  return resizeTo(downscale(padded, scale), sheet.width, sheet.height);
}

/** The pane marker in a game URL: which pane's sheets it should be fed. */
export const TEX_PARAM = "tex";

/**
 * The game URL for one pane: the level by name, the version, the stage, god
 * mode, the pane marker.
 *
 * The level is NAMED even though the pane never fetches it. The runtime's
 * level loader answers with `globalThis.__OFFLINE_LEVEL__` whenever one is
 * set, before it looks at the name, and `offlineInjector` sets it per pane
 * before the bundle runs; the name is what makes the boot skip the title and
 * the story and go straight to `?stage=` (showTitle is `!explicitLevel`). A
 * URL without it shows the title, and a Start press from there plays the
 * story first.
 */
export function paneUrl(
  origin: string,
  gamePath: string,
  opts: {
    level: string;
    version: string;
    stage: number;
    god: boolean;
    pane: string;
  },
): string {
  const u = new URL(gamePath, origin);
  u.searchParams.set("level", opts.level);
  u.searchParams.set("stage", String(opts.stage));
  if (opts.god) u.searchParams.set("god", "1");
  u.searchParams.set("version", opts.version);
  u.searchParams.set(TEX_PARAM, opts.pane);
  return u.toString();
}

/**
 * Which pane a paused request belongs to. A same-origin subresource request
 * carries its document's full URL as the Referer, pane marker included;
 * when it does not (a policy, a document request), the frame's own URL from
 * the frame tree answers. Null when neither says.
 */
export function paneOfRequest(
  headers: Record<string, string>,
  frameUrl: string | undefined,
): string | null {
  const referer = Object.entries(headers).find(([k]) =>
    k.toLowerCase() === "referer"
  )?.[1];
  for (const candidate of [referer, frameUrl]) {
    if (!candidate) continue;
    try {
      const v = new URL(candidate).searchParams.get(TEX_PARAM);
      if (v) return v;
    } catch { /* not a URL */ }
  }
  return null;
}

/**
 * The script every document in the page runs before its own: the pane's
 * level record, planted where the runtime's loader looks first. `records`
 * maps a pane marker to its record as JSON text; a document whose URL names
 * no pane (the harness itself) is left alone. Each record carries its marker
 * as `__tex`, which is how the driver confirms a pane got its own.
 */
export function offlineInjector(records: Record<string, string>): string {
  const table = Object.entries(records).map(([pane, json]) =>
    `${JSON.stringify(pane)}: ${json}`
  ).join(",\n");
  return `(function () {
  try {
    var pane = new URLSearchParams(location.search).get(${
    JSON.stringify(TEX_PARAM)
  });
    var records = {${table}};
    if (pane && records[pane]) {
      records[pane].__tex = pane;
      globalThis.__OFFLINE_LEVEL__ = records[pane];
    }
  } catch (e) {}
})();`;
}

/** The cloud level database's REST address for a level, as the runtime reads it. */
export const FIREBASE_DB = "https://evil-invaders-default-rtdb.firebaseio.com";
export function cloudLevelUrl(name: string): string {
  // The runtime's own sanitising of a ?level= name (readLevelParam).
  const key = name.replace(/[.#$/\[\]]/g, "_").trim();
  return `${FIREBASE_DB}/levels/${encodeURIComponent(key)}.json`;
}

/**
 * The caption over a pane, in the ~30 characters a 256px pane holds: the
 * texel share each sheet keeps, and what the disc costs the GS.
 */
export function paneLabel(b: Budget): string {
  const s = (k: string) => `1/${b.scales[k] ?? 1}`;
  const mb = (b.vramBytes / 1048576).toFixed(1);
  return `game ${s("game_asset")} lvl ${s("level_atlas")} ui ${
    s("game_ui")
  } · ${mb}MB`;
}
