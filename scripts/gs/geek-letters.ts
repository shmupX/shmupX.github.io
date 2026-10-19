#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game's first boss, Geekstar, his letters.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/geek-letters.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/geek-letters.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/geek-letters.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/geek-letters.ts --revert
 *
 * Geekstar is the Geek Squad logo, and the white "Geek" across it is the same
 * four letters squad-game explodes into: art/geek-g.png, geek-e.png and
 * geek-k.png (squad-game's assets/images), pixel for pixel. This lays them
 * back over the logo as the boss record's `overlay` (game.bundle.js,
 * armBossOverlay): each letter filled black over the white one it hides, so
 * the logo reads as four dark letters, and every few seconds one of them,
 * picked at random, fades in flashing neon and leaves as an aimed shot — his
 * third attack, beside the two his pattern fires geek-bullet with. From the
 * moment a letter starts to fade in until it leaves, the red flame in his
 * mask's eyes and mouth burns in that letter's colour instead (the overlay's
 * `glow`: the flame cut out of each of his frames, tinted at run time).
 *
 * The title's G is the same logo, so its white letters are covered the same
 * way: black, as they are in the game — and the dim grey edge a pixel round
 * each, which would otherwise still outline "Geek" on the black.
 *
 * What it writes to shmupX/levels/gs (shmupX's copy; cmg's root-level copy is
 * never read or written, mcp/lib/rtdb.ts roots every level path):
 *
 * - geek-g, geek-e and geek-k, and a `<frame>-flame` cut of each of his
 *   frames, packed under the level's sheet the way build-stage2.ts packs,
 *   reused when the level already has them;
 * - `bossData/boss0/overlay`, only onto Geekstar (the record must be his) and
 *   only into an empty field (--force replaces one that differs);
 * - `uiAtlases/game_ui/imageDataURL`, its `titleG.gif` with the letters
 *   covered — only where the title is still his logo, uncovered; a title
 *   covered before the edge was is covered the rest of the way.
 *
 * Without --apply nothing is written. --out writes the whole level as it
 * would be after the write, for a local play-through (window.__OFFLINE_LEVEL__,
 * see build-stage2.ts). --apply writes the art under the ETags it was read
 * with, so a save that raced this one is refused, and writes nothing that is
 * already as planned: run again, it adds only what is missing. --revert takes
 * the overlay and its frames back out — a frame some other record still draws
 * stays — and gives the title its white letters back.
 */

import { equal } from "@std/assert/equal";
import { fromFileUrl } from "@std/path";
import { decodeDataUrl, newRaster } from "@shmupx/shmup-harbor/png";
import type { Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import {
  type FrameRect,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "../../mcp/lib/art.ts";
import { referencedFrames } from "../../mcp/lib/character.ts";
import {
  dbPath,
  decodeFrameName,
  encodeKey,
  get,
  getWithEtag,
  put,
} from "../../mcp/lib/rtdb.ts";
import { ART, packTo, PAD } from "./build-stage2.ts";

const LEVEL = "gs";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Geekstar's slot, and the name his record must carry. */
export const BOSS = "boss0";
export const BOSS_NAME = "geekstar";

/** The letters, by the names they get in the level's atlas. */
export const LETTERS = ["geek-g", "geek-e", "geek-k"] as const;

/**
 * The overlay. Each part's x, y is its top-left in Geekstar's 170x105 frame —
 * the same in all five of his frames, which only animate the mask above.
 * Measured by matching each letter's white pixels against the logo's: G 673
 * of 673, K 534 of 534, each E 486 and 483 of the image's 489 (the logo's
 * second E is a pixel wider; the black fill takes the letter's dark outline
 * too, which covers it).
 *
 * The shot: one letter every 2.6 s, 0.9 s to fade in, then aimed at 3 px a
 * frame — a little quicker than his geek-bullet's 2.5, a lot bigger to dodge.
 */
export const OVERLAY = {
  parts: [
    { frame: "geek-g", x: 21, y: 24 },
    { frame: "geek-e", x: 58, y: 31 },
    { frame: "geek-e", x: 90, y: 31 },
    { frame: "geek-k", x: 123, y: 25 },
  ],
  cover: "#000000",
  shot: {
    every: 2600,
    chargeMs: 900,
    flashMs: 60,
    colors: ["#ff2bd6", "#00f0ff", "#39ff14", "#fff200", "#ff6a00"],
    speed: 3,
    damage: 1,
    hp: 1,
    score: 300,
    spgage: 3,
  },
};

/**
 * Where his flame burns: the mask's eyes and mouth, in his frame, above the
 * letters. The orange of SQUAD below is never inside it, and is not red
 * enough to pass isFlame anyway (its green is ~135).
 */
export const FLAME_BOX = { x: 55, y: 0, w: 60, h: 40 };

/** A pure red: the flame, from its bright 255,0,0 down to its ~176,0,0. */
export const isFlame = (r: number, g: number, b: number, a: number): boolean =>
  a >= 128 && r >= 96 && g < 64 && b < 64;

/** A boss frame's flame cut, by name. */
export const flameName = (frame: string): string => `${frame}-flame`;

export interface FlameCut {
  /** Top-left of every cut in the boss frame: one rectangle for all. */
  x: number;
  y: number;
  /** Boss frame -> its cut: the flame's red channel as white, shading and all. */
  cuts: Record<string, Raster>;
}

/**
 * The flame of each boss frame, cut out of FLAME_BOX in white with the red's
 * own brightness, so a tint lights it as the red did: full where it was 255,
 * darker where it was darker. Every cut is the same rectangle — the union of
 * the flame over all the frames, as the mouth's grows while he attacks — so
 * the runtime lays any of them at one place. Null when no frame has a flame.
 */
export function flameCut(frames: Record<string, Raster>): FlameCut | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const flame = (img: Raster, x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return isFlame(
      img.data[i],
      img.data[i + 1],
      img.data[i + 2],
      img.data[i + 3],
    );
  };
  for (const img of Object.values(frames)) {
    const right = Math.min(img.width, FLAME_BOX.x + FLAME_BOX.w);
    const bottom = Math.min(img.height, FLAME_BOX.y + FLAME_BOX.h);
    for (let y = FLAME_BOX.y; y < bottom; y++) {
      for (let x = FLAME_BOX.x; x < right; x++) {
        if (!flame(img, x, y)) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) return null;
  const cuts: Record<string, Raster> = {};
  for (const [name, img] of Object.entries(frames)) {
    const cutOut = newRaster(x1 - x0 + 1, y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!flame(img, x, y)) continue;
        const r = img.data[(y * img.width + x) * 4];
        cutOut.data.set([r, r, r, 255], ((y - y0) * cutOut.width + x - x0) * 4);
      }
    }
    cuts[name] = cutOut;
  }
  return { x: x0, y: y0, cuts };
}

/**
 * The title's G: gs's own (uiAtlases/game_ui, `titleG.gif`) is Geekstar's
 * logo — his frame geekstar0, pixel for pixel, at TITLE_AT in it — so its
 * white letters are covered the way his are in the game, by the same black
 * letters at the same places in the logo, and their edge with them.
 */
export const TITLE_FRAME = "titleG.gif";
export const TITLE_LOGO = "geekstar0";
export const TITLE_AT = { x: 38, y: 178 };

type Rect = FrameRect["frame"];

/**
 * A white letter's edge in the logo: the dim grey it fades out through, 4 to
 * 50 a channel in Geekstar's. Never his mask, which comes within a pixel of
 * the E's — it is bright, or coloured (its darkest, a teal, is 0,72,80).
 */
export const isLetterEdge = (
  r: number,
  g: number,
  b: number,
  a: number,
): boolean =>
  a >= 128 && Math.max(r, g, b) <= 64 &&
  Math.max(r, g, b) - Math.min(r, g, b) <= 16;

/**
 * What the black letters cover in the logo, one flag a pixel: every pixel of
 * a letter, and the edge a pixel out from it. The letters are hard-edged and
 * the logo's white ones are not, so black over the letters alone leaves that
 * edge drawing "Geek" in outline on the oval.
 */
export function letterCover(
  logo: Raster,
  letters: Record<string, Raster>,
): Uint8Array {
  const { width, height } = logo;
  const solid = new Uint8Array(width * height);
  for (const part of OVERLAY.parts) {
    const letter = letters[part.frame];
    for (let y = 0; y < letter.height; y++) {
      for (let x = 0; x < letter.width; x++) {
        if (letter.data[(y * letter.width + x) * 4 + 3] < 128) continue;
        const lx = part.x + x, ly = part.y + y;
        if (lx < width && ly < height) solid[ly * width + lx] = 1;
      }
    }
  }
  const cover = solid.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (solid[y * width + x]) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          const nx = x + dx, ny = y + dy;
          touches = nx >= 0 && ny >= 0 && nx < width && ny < height &&
            solid[ny * width + nx] === 1;
        }
      }
      const [r, g, b, a] = logo.data.subarray(
        (y * width + x) * 4,
        (y * width + x) * 4 + 4,
      );
      if (touches && isLetterEdge(r, g, b, a)) cover[y * width + x] = 1;
    }
  }
  return cover;
}

/**
 * Each pixel the black letters cover in the title: its index into the
 * title's data, and into the logo frame's.
 */
function* titleCovered(
  title: Raster,
  rect: Rect,
  logo: Raster,
  letters: Record<string, Raster>,
): Generator<[number, number]> {
  const cover = letterCover(logo, letters);
  for (let ly = 0; ly < logo.height; ly++) {
    for (let lx = 0; lx < logo.width; lx++) {
      if (!cover[ly * logo.width + lx]) continue;
      const tx = rect.x + TITLE_AT.x + lx, ty = rect.y + TITLE_AT.y + ly;
      if (tx >= title.width || ty >= title.height) continue;
      yield [(ty * title.width + tx) * 4, (ly * logo.width + lx) * 4];
    }
  }
}

const BLACK = [0, 0, 0, 255];

/**
 * The title with its letters covered, or "covered" when they already are.
 * Throws when the title is not the logo there: covering it would paint black
 * over art this was never measured against.
 */
export function coverTitle(
  title: Raster,
  rect: Rect,
  logo: Raster,
  letters: Record<string, Raster>,
): Raster | "covered" {
  let covered = true;
  for (const [t, l] of titleCovered(title, rect, logo, letters)) {
    const px = title.data.subarray(t, t + 4);
    if (BLACK.every((v, k) => px[k] === v)) continue;
    covered = false;
    if (!logo.data.subarray(l, l + 4).every((v, k) => px[k] === v)) {
      throw new Error(
        `${TITLE_FRAME} is not ${TITLE_LOGO} at ${TITLE_AT.x},${TITLE_AT.y}: ` +
          `nothing was covered`,
      );
    }
  }
  if (covered) return "covered";
  const out = { ...title, data: title.data.slice() };
  for (const [t] of titleCovered(title, rect, logo, letters)) {
    out.data.set(BLACK, t);
  }
  return out;
}

/** The title with every covered pixel back as the logo has it. */
export function uncoverTitle(
  title: Raster,
  rect: Rect,
  logo: Raster,
  letters: Record<string, Raster>,
): Raster {
  const out = { ...title, data: title.data.slice() };
  for (const [t, l] of titleCovered(title, rect, logo, letters)) {
    out.data.set(logo.data.subarray(l, l + 4), t);
  }
  return out;
}

/** The letters' own pixels, by name, from art/. */
async function letterRasters(): Promise<Record<string, Raster>> {
  const out: Record<string, Raster> = {};
  for (const f of await sources()) out[f.name] = f.raster;
  return out;
}

/** The frames his record draws him with: every stance, and his texture. */
export function bossFrames(boss: Json): string[] {
  const names = new Set<string>();
  for (const list of Object.values(boss?.anim ?? {})) {
    if (Array.isArray(list)) {
      for (const n of list) if (typeof n === "string") names.add(n);
    }
  }
  for (const n of [boss?.texture].flat()) {
    if (typeof n === "string") names.add(n);
  }
  return [...names];
}

/** The letters from art/. */
async function sources(): Promise<ResolvedFrame[]> {
  const out: ResolvedFrame[] = [];
  for (const name of LETTERS) {
    out.push(
      await resolveFrame({
        file: fromFileUrl(new URL(`${name}.png`, ART)),
        as: name,
      }),
    );
  }
  return out;
}

export type Overlay = typeof OVERLAY & {
  glow?: { x: number; y: number; frames: Record<string, string> };
};

export interface Plan {
  added: string[];
  reused: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  atlasImageDataURL: string | null;
  atlasFrames: Record<string, FrameRect>;
  overlay: Overlay;
  /** The overlay the record has now, when it has one. */
  existing: Json;
  /**
   * The title: "cover" with the image that covers it, "covered" when it
   * already is, "none" when the level has no title G of its own.
   */
  title: {
    state: "cover" | "covered" | "none";
    imageDataURL: string | null;
    etag: string | null;
  };
  etags: { image: string | null; frames: string | null };
}

/** The level's own title G and the sheet it is on, or null. */
async function titleSheet(): Promise<
  { image: string; etag: string | null; rect: Rect } | null
> {
  const frames = await get<Record<string, FrameRect>>(
    `levels/${LEVEL}/uiAtlases/game_ui/frames`,
  );
  const key = Object.keys(frames ?? {}).find((k) =>
    decodeFrameName(k) === TITLE_FRAME
  );
  if (!key) return null;
  const image = await getWithEtag<string>(
    `levels/${LEVEL}/uiAtlases/game_ui/imageDataURL`,
  );
  return image.value
    ? { image: image.value, etag: image.etag, rect: frames![key].frame }
    : null;
}

export async function plan(): Promise<Plan> {
  const boss = await get<Json>(`levels/${LEVEL}/bossData/${BOSS}`);
  if (!boss || boss.name !== BOSS_NAME) {
    throw new Error(
      `${dbPath(`levels/${LEVEL}/bossData/${BOSS}`)} is not ${BOSS_NAME} (${
        boss?.name ?? "empty"
      })`,
    );
  }
  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const rawFrames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !rawFrames.value) {
    throw new Error(`${dbPath(`levels/${LEVEL}`)} has no atlas to add to`);
  }

  const before = await decodeDataUrl(image.value);
  const byName = new Map(
    Object.entries(rawFrames.value).map(([k, r]) => [decodeFrameName(k), r]),
  );
  const drawn: Record<string, Raster> = {};
  for (const name of bossFrames(boss)) {
    const rect = byName.get(name);
    if (rect) drawn[name] = cut(before, rect.frame);
  }
  const flame = flameCut(drawn);
  const overlay: Overlay = { ...OVERLAY };
  const wanted = await sources();
  if (flame) {
    overlay.glow = { x: flame.x, y: flame.y, frames: {} };
    for (const [name, raster] of Object.entries(flame.cuts)) {
      overlay.glow.frames[name] = flameName(name);
      wanted.push({
        name: flameName(name),
        raster,
        source: `the flame of ${name}`,
        scope: LEVEL,
      });
    }
  }

  const pull: ResolvedFrame[] = [];
  const reused: string[] = [];
  for (const f of wanted) {
    if (byName.has(f.name)) reused.push(f.name);
    else pull.push(f);
  }

  const title: Plan["title"] = {
    state: "none",
    imageDataURL: null,
    etag: null,
  };
  const sheet = await titleSheet();
  const logoRect = byName.get(TITLE_LOGO);
  if (sheet && logoRect) {
    const covered = coverTitle(
      await decodeDataUrl(sheet.image),
      sheet.rect,
      cut(before, logoRect.frame),
      await letterRasters(),
    );
    title.etag = sheet.etag;
    if (covered === "covered") title.state = "covered";
    else {
      title.state = "cover";
      title.imageDataURL = await sheetDataUrl(covered);
    }
  }

  let after: Raster = before;
  const atlasFrames: Record<string, FrameRect> = { ...rawFrames.value };
  if (pull.length) {
    const { sheet, frames } = packTo(before.width, pull);
    after = newRaster(
      Math.max(before.width, sheet.width),
      before.height + PAD + sheet.height,
    );
    blit(after, before, 0, 0);
    blit(after, sheet, 0, before.height + PAD);
    for (const [name, rect] of Object.entries(frames)) {
      atlasFrames[encodeKey(name)] = {
        ...rect,
        frame: { ...rect.frame, y: rect.frame.y + before.height + PAD },
      };
    }
  }

  return {
    added: pull.map((f) => f.name),
    reused,
    atlas: {
      before: { w: before.width, h: before.height },
      after: { w: after.width, h: after.height },
    },
    atlasImageDataURL: pull.length ? await sheetDataUrl(after) : null,
    atlasFrames,
    overlay,
    existing: boss.overlay ?? null,
    title,
    etags: { image: image.etag, frames: rawFrames.etag },
  };
}

/**
 * Write a plan: the art first, under the ETags it was read with, then the
 * overlay that names it, then the title. What is already as planned is not
 * written again, so a second run adds only what the first did not; an
 * overlay that differs from the plan is refused unless `force`.
 */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const field = `levels/${LEVEL}/bossData/${BOSS}/overlay`;
  const same = p.existing !== null && equal(p.existing, p.overlay);
  if (p.existing !== null && !same && !force) {
    throw new Error(`${dbPath(field)} is set; --force replaces it`);
  }
  const written: string[] = [];
  if (p.atlasImageDataURL) {
    await put(`levels/${LEVEL}/atlasImageDataURL`, p.atlasImageDataURL, {
      ifMatch: p.etags.image,
    });
    await put(`levels/${LEVEL}/atlasFrames`, p.atlasFrames, {
      ifMatch: p.etags.frames,
    });
    written.push(
      dbPath(`levels/${LEVEL}/atlasImageDataURL`),
      dbPath(`levels/${LEVEL}/atlasFrames`),
    );
  }
  if (!same) {
    await put(field, p.overlay);
    written.push(dbPath(field));
  }
  if (p.title.state === "cover") {
    const at = `levels/${LEVEL}/uiAtlases/game_ui/imageDataURL`;
    await put(at, p.title.imageDataURL, { ifMatch: p.title.etag });
    written.push(dbPath(at));
  }
  if (written.length) await put(`levels/${LEVEL}/savedAt`, Date.now());
  return written;
}

/** Every frame name the level's records still draw, overlays included. */
async function stillDrawn(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const node of ["enemyData", "bossData", "playerData"]) {
    const value = await get<Json>(`levels/${LEVEL}/${node}`);
    const records = node === "playerData"
      ? [value]
      : Object.values(value ?? {});
    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      for (const n of referencedFrames(rec)) names.add(n);
      for (const n of overlayFrames(rec.overlay)) names.add(n);
    }
  }
  return names;
}

/** Every frame an overlay draws: its parts and its glow. */
export function overlayFrames(overlay: Json): string[] {
  const names: string[] = [];
  for (const part of overlay?.parts ?? []) {
    if (typeof part?.frame === "string") names.push(part.frame);
  }
  for (const n of Object.values(overlay?.glow?.frames ?? {})) {
    if (typeof n === "string") names.push(n);
  }
  return names;
}

/**
 * Undo --apply: the overlay first, so nothing is left naming art that is
 * gone; the title's white letters, back from the logo they were covered on;
 * then the overlay's letters and flame cuts — unless another record still
 * draws one — and the rows of the sheet they sat on, when nothing the level
 * kept sits below them.
 */
export async function revert(): Promise<string[]> {
  const field = `levels/${LEVEL}/bossData/${BOSS}/overlay`;
  const was = await get<Json>(field);
  await put(field, null);
  const written = [dbPath(field)];

  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const frames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !frames.value) return written;

  const titled = await titleSheet();
  const logoRect = Object.entries(frames.value).find(([k]) =>
    decodeFrameName(k) === TITLE_LOGO
  )?.[1];
  if (titled && logoRect) {
    const title = await decodeDataUrl(titled.image);
    const back = uncoverTitle(
      title,
      titled.rect,
      cut(await decodeDataUrl(image.value), logoRect.frame),
      await letterRasters(),
    );
    if (!equal(back.data, title.data)) {
      const at = `levels/${LEVEL}/uiAtlases/game_ui/imageDataURL`;
      await put(at, await sheetDataUrl(back), { ifMatch: titled.etag });
      written.push(dbPath(at));
    }
  }

  const drawn = await stillDrawn();
  const ours = new Set<string>(
    [...LETTERS, ...overlayFrames(was)].filter((n) => !drawn.has(n)),
  );
  const keep: Record<string, FrameRect> = {};
  let firstRow = Infinity;
  for (const [key, rect] of Object.entries(frames.value)) {
    if (ours.has(decodeFrameName(key))) {
      firstRow = Math.min(firstRow, rect.frame.y);
    } else keep[key] = rect;
  }
  if (!Number.isFinite(firstRow)) return written;
  const sheet = await decodeDataUrl(image.value);
  const lowest = Math.max(
    0,
    ...Object.values(keep).map((r) => r.frame.y + r.frame.h),
  );
  const height = lowest <= firstRow - PAD ? firstRow - PAD : sheet.height;
  const cropped = cut(sheet, { x: 0, y: 0, w: sheet.width, h: height });
  await put(`levels/${LEVEL}/atlasImageDataURL`, await sheetDataUrl(cropped), {
    ifMatch: image.etag,
  });
  await put(`levels/${LEVEL}/atlasFrames`, keep, { ifMatch: frames.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  written.push(
    dbPath(`levels/${LEVEL}/atlasImageDataURL`),
    dbPath(`levels/${LEVEL}/atlasFrames`),
  );
  return written;
}

if (import.meta.main && Deno.args.includes("--revert")) {
  console.log(JSON.stringify({ reverted: await revert() }, null, 2));
} else if (import.meta.main) {
  const outAt = Deno.args.indexOf("--out");
  const out = outAt >= 0 ? Deno.args[outAt + 1] : undefined;
  const p = await plan();
  console.log(JSON.stringify(
    {
      level: dbPath(`levels/${LEVEL}`),
      added: p.added,
      reused: p.reused,
      atlas: p.atlas,
      field: `bossData/${BOSS}/overlay`,
      overlay: p.existing === null
        ? "new"
        : equal(p.existing, p.overlay)
        ? "already as planned"
        : "differs (--force replaces it)",
      title: p.title.state,
    },
    null,
    2,
  ));
  if (out) {
    const level = (await get<Json>(`levels/${LEVEL}`)) ?? {};
    if (p.atlasImageDataURL) level.atlasImageDataURL = p.atlasImageDataURL;
    level.atlasFrames = p.atlasFrames;
    level.bossData[BOSS] = { ...level.bossData[BOSS], overlay: p.overlay };
    if (p.title.imageDataURL) {
      level.uiAtlases.game_ui.imageDataURL = p.title.imageDataURL;
    }
    await Deno.writeTextFile(out, JSON.stringify(level));
    console.log(`wrote ${out}`);
  }
  if (Deno.args.includes("--apply")) {
    const written = await apply(p, { force: Deno.args.includes("--force") });
    console.log(JSON.stringify({ written }, null, 2));
  }
}
