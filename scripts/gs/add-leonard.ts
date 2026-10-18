#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Put Leonard into the gs cloud game's second stage.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/add-leonard.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/add-leonard.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/add-leonard.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/add-leonard.ts --revert
 *
 * Leonard is the round grey face with the glasses (art/leonard.png). He
 * attacks exactly as deza2_02 does, the horned imp of the rando level's third
 * stage (shmupX/levels/rando/enemyData/enemyC, a Dezaemon 2 import): the same
 * entry script, the same aimed fire table, the same eighteen cart bytes, so a
 * Saturn export writes him with that record verbatim. His one change of
 * weapon is the shot: spriteX's geek badge (sprites/geekBadge_0) instead of
 * the imp's fireball.
 *
 * What it adds to shmupX/levels/gs (shmupX's copy; cmg's root-level copy is
 * never read or written, mcp/lib/rtdb.ts roots every level path):
 *
 * - `enemyData/enemyH`, Leonard;
 * - six H cells on empty rows of `stages/stage1`'s wave list (WAVES): two
 *   Leonards early, two mid-stage, two late. A cell that is not empty is
 *   refused, never overwritten;
 * - leonard and geekBadge_0, packed under the level's sheet the way
 *   build-stage2.ts packs, reused when the level already has them.
 *
 * Without --apply nothing is written. --out writes the whole level as it
 * would be after the write, for a local play-through (window.__OFFLINE_LEVEL__,
 * see build-stage2.ts). --apply writes the art and the wave list under the
 * ETags they were read with, so a save that raced this one is refused, and
 * Leonard's record only into an empty slot (--force replaces it). --revert
 * takes the H cells, the record and the two frames back out — a frame some
 * other record of the level still draws stays.
 */

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

/** Leonard's letter in the wave list: the next one gs has free. */
export const LETTER = "H";
/** His frame and his shot's, by the names they get in the level's atlas. */
export const BODY = "leonard";
export const SHOT = "geekBadge_0";

/**
 * Leonard: deza2_02 (rando's enemyC, read 2026-10-18) with his face and the
 * badge. Everything that makes the imp attack as it does is kept — the
 * runtime drives a Dezaemon zako from `dezaemon.behavior` (fire table,
 * speed, death word) and `dezaemon.entry` (its movement script), keys its
 * formation band off `placementId`, and the Saturn writer copies
 * `attributes`, the cart's own record, byte for byte. Dropped: `stage`,
 * `record` and `placements`, which only say where the imp sat in rando
 * (the runtime matches `stage`/`record` against a Dezaemon boss's parts).
 *
 * He is sixteen times as tough as the imp: `hp` 48 to its 3, the field the
 * runtime's createEnemy reads (`behavior.hp` is not hit points — with no
 * `animPeriod` beside it the runtime reads it as the animation period). At
 * 12 the stage's own fire brought him down in 0.3-0.9 s, before the imp's
 * reload (4-7 fire ticks, ~0.6-1.0 s from spawn) let him shoot once; at 48 he
 * lives long enough to fire on the imp's own cadence. The cart record keeps
 * the imp's hit-point index 0: the Saturn table goes 256, 12800, … with no
 * step in between.
 */
export const LEONARD = {
  name: "leonard",
  texture: [BODY],
  hp: 48,
  interval: 5,
  score: 100,
  speed: 0,
  spgage: 4,
  shadowOffsetY: 10,
  shadowReverse: true,
  bulletData: {
    damage: 1,
    hp: 1,
    score: 100,
    speed: 3.88,
    spgage: 2,
    texture: [SHOT],
  },
  dezaemon: {
    attributes: "6f1000005511000000000000000000000000",
    behavior: {
      appearance: 111,
      death: { mode: 0, param: 0, silent: false, small: false },
      direction: {
        enabled: false,
        from: 0,
        repeat: 0,
        step: 0.703125,
        to: 0,
        trigger: 0,
      },
      fire: {
        aimed: true,
        direction: 17,
        directionEx: 0,
        enabled: true,
        geometry: 1,
        interval: 5,
        mode: 1,
        window: 4,
      },
      ground: false,
      hp: 60,
      move: { flag: false, mode: 0 },
      movePattern: 0,
      rotation: {
        enabled: false,
        from: 0,
        mode: 0,
        repeat: 0,
        step: 0.087890625,
        to: 0,
        trigger: 0,
      },
      scale: {
        axes: "",
        enabled: false,
        from: 0,
        repeat: 0,
        repeatY: 0,
        step: 0.00390625,
        to: 0,
        trigger: 0,
      },
      score: 100,
      speed: 0.00390625,
      speedChange: {
        enabled: false,
        from: 0,
        repeat: 0,
        step: 0.00390625,
        to: 0,
        trigger: 0,
      },
    },
    entry: {
      rows: [
        [6, 49152, 0, 1536, 4097],
        [6, 49152, 2728, 1536, 1],
        [6, 0, 0, 1536, 1],
        [12, 0, -2728, 1536, 1],
        [6, 32768, 0, 1536, 1],
        [12, 32768, 2728, 1536, 1],
        [6, 0, 0, 1536, 1],
        [12, 0, -2728, 1536, 1],
        [6, 32768, 0, 1536, 1],
        [6, 32768, 2728, 1536, 1],
        [32767, 49152, 0, 1536, 1],
      ],
    },
    placementId: 130,
  },
};

/**
 * Where Leonard comes in: row index of stage 2's wave list (top row last —
 * the runtime plays the list bottom-up) -> that row with his cells. Each of
 * these rows is empty in the stage build-stage2.ts wrote.
 */
export const WAVES: Record<number, string[]> = {
  13: ["00", "00", "H0", "00", "00", "H0", "00", "00"],
  9: ["00", "H0", "00", "00", "00", "00", "H0", "00"],
  4: ["00", "00", "00", "H0", "H0", "00", "00", "00"],
};

const isLeonard = (cell: unknown) =>
  typeof cell === "string" && cell.length === 2 && cell[0] === LETTER;

/**
 * The wave list with Leonard's cells laid in. Throws when a cell he needs
 * holds anything but "00" — another enemy, or Leonard from an earlier run —
 * or when the list is too short to have the row.
 */
export function withLeonard(enemylist: string[][]): string[][] {
  const out = enemylist.map((row) => row.slice());
  const clash: string[] = [];
  for (const [at, cells] of Object.entries(WAVES)) {
    const r = Number(at);
    if (!out[r]) throw new Error(`stage 2 has no row ${r} for Leonard`);
    cells.forEach((cell, c) => {
      if (cell === "00") return;
      if (out[r][c] !== "00") clash.push(`row ${r} column ${c} (${out[r][c]})`);
      else out[r][c] = cell;
    });
  }
  if (clash.length) {
    throw new Error(`Leonard's cells are taken: ${clash.join(", ")}`);
  }
  return out;
}

/** The wave list with every Leonard cell emptied. */
export function withoutLeonard(enemylist: string[][]): string[][] {
  return enemylist.map((row) => row.map((c) => (isLeonard(c) ? "00" : c)));
}

/** The frames this script packs: Leonard from art/, the badge from spriteX. */
async function sources(): Promise<ResolvedFrame[]> {
  return [
    await resolveFrame({
      file: fromFileUrl(new URL(`${BODY}.png`, ART)),
      as: BODY,
    }),
    await resolveFrame({ sprite: SHOT }),
  ];
}

export interface Plan {
  added: { frame: string; source: string }[];
  reused: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  atlasImageDataURL: string | null;
  atlasFrames: Record<string, FrameRect>;
  record: typeof LEONARD;
  enemylist: string[][];
  taken: boolean;
  etags: { image: string | null; frames: string | null; waves: string | null };
}

export async function plan(): Promise<Plan> {
  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const rawFrames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !rawFrames.value) {
    throw new Error(`${dbPath(`levels/${LEVEL}`)} has no atlas to add to`);
  }
  const waves = await getWithEtag<string[][]>(
    `levels/${LEVEL}/stages/stage1/enemylist`,
  );
  if (!Array.isArray(waves.value)) {
    throw new Error(
      `${dbPath(`levels/${LEVEL}`)} has no stage 2 — run build-stage2.ts first`,
    );
  }
  const enemylist = withLeonard(waves.value);

  const have = new Set(Object.keys(rawFrames.value).map(decodeFrameName));
  const pull: ResolvedFrame[] = [];
  const reused: string[] = [];
  for (const f of await sources()) {
    if (have.has(f.name)) reused.push(f.name);
    else pull.push(f);
  }
  const missing = referencedFrames(LEONARD).filter((n) =>
    !have.has(n) && !pull.some((f) => f.name === n)
  );
  if (missing.length) throw new Error(`no art for ${missing.join(", ")}`);

  const before = await decodeDataUrl(image.value);
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
    added: pull.map((f) => ({ frame: f.name, source: f.source })),
    reused,
    atlas: {
      before: { w: before.width, h: before.height },
      after: { w: after.width, h: after.height },
    },
    atlasImageDataURL: pull.length ? await sheetDataUrl(after) : null,
    atlasFrames,
    record: LEONARD,
    enemylist,
    taken: (await get(`levels/${LEVEL}/enemyData/enemy${LETTER}`)) != null,
    etags: { image: image.etag, frames: rawFrames.etag, waves: waves.etag },
  };
}

/**
 * Write a plan: the art first, then the record that names it, then the wave
 * list that places it — art and waves under the ETags they were read with.
 * Refuses to replace an enemy already in Leonard's slot unless `force`.
 */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const slot = `levels/${LEVEL}/enemyData/enemy${LETTER}`;
  if (p.taken && !force) {
    throw new Error(`${dbPath(slot)} is taken; --force replaces it`);
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
  await put(slot, p.record);
  written.push(dbPath(slot));
  const waves = `levels/${LEVEL}/stages/stage1/enemylist`;
  await put(waves, p.enemylist, { ifMatch: p.etags.waves });
  written.push(dbPath(waves));
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return written;
}

/** Every frame name the level's records still draw. */
async function stillDrawn(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const node of ["enemyData", "bossData", "playerData"]) {
    const value = await get<Json>(`levels/${LEVEL}/${node}`);
    const records = node === "playerData"
      ? [value]
      : Object.values(value ?? {});
    for (const rec of records) {
      if (rec && typeof rec === "object") {
        for (const n of referencedFrames(rec)) names.add(n);
      }
    }
  }
  return names;
}

/**
 * Undo --apply: the H cells and the record first, so nothing is left naming
 * art that is gone, then the two frames — unless another record still draws
 * one — and the rows of the sheet they sat on, when nothing the level kept
 * sits below them.
 */
export async function revert(): Promise<string[]> {
  const written: string[] = [];
  const wavesPath = `levels/${LEVEL}/stages/stage1/enemylist`;
  const waves = await getWithEtag<string[][]>(wavesPath);
  if (
    Array.isArray(waves.value) && waves.value.some((r) => r.some(isLeonard))
  ) {
    await put(wavesPath, withoutLeonard(waves.value), { ifMatch: waves.etag });
    written.push(dbPath(wavesPath));
  }
  const slot = `levels/${LEVEL}/enemyData/enemy${LETTER}`;
  await put(slot, null);
  written.push(dbPath(slot));

  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const frames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !frames.value) return written;
  const drawn = await stillDrawn();
  const ours = new Set([BODY, SHOT].filter((n) => !drawn.has(n)));
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
      record: `enemyData/enemy${LETTER}`,
      slotTaken: p.taken,
      waves: Object.keys(WAVES).map(Number).sort((a, b) => a - b).map((r) =>
        `row ${r}: ${p.enemylist[r].join(" ")}`
      ),
    },
    null,
    2,
  ));
  if (out) {
    const level = (await get<Json>(`levels/${LEVEL}`)) ?? {};
    if (p.atlasImageDataURL) level.atlasImageDataURL = p.atlasImageDataURL;
    level.atlasFrames = p.atlasFrames;
    level.enemyData = {
      ...(level.enemyData ?? {}),
      [`enemy${LETTER}`]: p.record,
    };
    level.stages = {
      ...(level.stages ?? {}),
      stage1: { ...(level.stages?.stage1 ?? {}), enemylist: p.enemylist },
    };
    await Deno.writeTextFile(out, JSON.stringify(level));
    console.log(`wrote ${out}`);
  }
  if (Deno.args.includes("--apply")) {
    const written = await apply(p, { force: Deno.args.includes("--force") });
    console.log(JSON.stringify({ written }, null, 2));
  }
}
