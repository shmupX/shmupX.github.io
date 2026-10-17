#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game its second stage: flirty girls, hacked laptops and a
 * final boss drawn from a whiteboard doodle.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/build-stage2.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/build-stage2.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/build-stage2.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/build-stage2.ts --revert
 *
 * What it adds to levels/gs, and nothing else:
 *
 * - `stages/stage1`, the second stage's wave list: flirty girls (G) and the
 *   game's own hacked laptops (C, the stage-1 enemy whose screens read
 *   HACKED), with a big-shot, a 3-way, a speed-up and a barrier drop.
 * - `enemyData/enemyG`, the flirty girl: the shipped game's enemy, her lip
 *   bullets and all (static/games/2028-ai/foo.json's enemyC).
 * - `bossData/boss1`, lolBoss: Akuma's frame set one for one (idle, shootA,
 *   shootB, the Ashura warp, both finish poses), drawn by draw_lol_boss.py,
 *   pinned to Akuma's routine (`attackPattern: "bossExtra"`) with Akuma's own
 *   hp, score, interval and bullet stats. His small shot (bulletDataA) is
 *   spriteX's RAM stick (sprites/RAM_0) and his big one (bulletDataB) is the
 *   game's hacked laptop, laptop0/laptop1. His danger balloon is the
 *   whiteboard's "I'm Fired!!!" (`dangerBalloon`, read by game.bundle.js).
 * - the art all of that names, packed under the level's existing sheet, the
 *   way the level loader stacks a level's sheet under game_asset. Frames the
 *   level already carries are reused and never repainted, so a re-run adds
 *   nothing.
 *
 * Without --apply nothing is written. --out writes the whole level as it
 * would be after the write, for a local play-through before the shared record
 * changes: the level loader plays `window.__OFFLINE_LEVEL__` ahead of the
 * database, so a page that sets it to this file and opens
 * /games/2028-ai?level=gs&stage=1 plays stage 2 off it. --apply writes the
 * art first under an ETag, so a save that raced this one is refused rather
 * than overwritten, then the three records, each only if its slot is empty
 * (--force replaces them). --revert takes all of it back out: the three
 * records, the frames this script packs, and the sheet rows they sat on.
 */

import { decodeDataUrl, newRaster } from "@shmupx/shmup-harbor/png";
import type { Raster } from "@shmupx/shmup-harbor/png";
import { blit, cut } from "@shmupx/shmup-harbor/raster";
import {
  type FrameRect,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "../../mcp/lib/art.ts";
import {
  decodeFrameName,
  encodeKey,
  get,
  getWithEtag,
  put,
} from "../../mcp/lib/rtdb.ts";

const LEVEL = "gs";
const ART = new URL("./art/", import.meta.url);
const SHIPPED = new URL("../../static/games/2028-ai/foo.json", import.meta.url);
const PAD = 4;

// deno-lint-ignore no-explicit-any
type Json = any;

const BOSS_POSES = {
  idle: ["idle0", "idle1"],
  shootA: ["shootA0", "shootA1", "shootA2"],
  shootB: ["shootB0", "shootB1", "shootB2", "shootB3", "shootB4"],
  syngoku: ["syungoku0", "syungoku1", "syungoku2"],
  syngokuFinish: ["syungoku_finish"],
  syngokuFinishTen: ["syungoku_finish_ten"],
};
const FIRED = ["lolBoss_fired0", "lolBoss_fired1", "lolBoss_fired2"];
const FLIRTY = {
  flirtyGirl0: "flirtyGirl0.png",
  flirtyGirl1: "flirtyGirl1.png",
  flirtyGirlProjectile0: "flirtyGirlProjectile0.png",
  flirtyGirlProjectile1: "flirtyGirlProjectile1.png",
  flirtyGirlProjectile2: "flirtyGirlProjectile2.png",
};

const anim = Object.fromEntries(
  Object.entries(BOSS_POSES).map((
    [k, poses],
  ) => [k, poses.map((p) => `lolBoss_${p}`)]),
);

/** The stage-2 boss. Akuma's numbers (the stock bossExtra) throughout. */
export const LOL_BOSS = {
  name: "lolBoss",
  attackPattern: "bossExtra",
  anim,
  bulletDataA: {
    damage: 1,
    hp: 5,
    score: 100,
    speed: 2.3,
    spgage: 5,
    texture: ["RAM_0"],
  },
  bulletDataB: {
    damage: 1,
    hp: 20,
    score: 500,
    speed: 1.5,
    spgage: 10,
    texture: ["laptop0", "laptop1"],
  },
  // The balloon's tail tip sits by the crown, right of the topknot; the
  // balloon rises above and to the right of his head, as on the whiteboard.
  dangerBalloon: { frames: FIRED, x: 50, y: 20 },
  hp: 350,
  interval: 200,
  score: 8000,
  shadowOffsetY: 10,
  shadowReverse: true,
  spgage: 30,
};

/** The flirty girl, as the shipped game has her, on this level's frame names. */
export const FLIRTY_GIRL = {
  hp: 1,
  interval: 170,
  name: "flirtyGirl",
  projectileData: {
    damage: 1,
    hp: 1,
    score: 100,
    sound: ["smooch"],
    speed: 1.2,
    spgage: 1,
    texture: [
      "flirtyGirlProjectile0",
      "flirtyGirlProjectile1",
      "flirtyGirlProjectile2",
    ],
  },
  score: 200,
  shadowOffsetY: 30,
  shadowReverse: false,
  speed: 0.8,
  spgage: 5,
  texture: ["flirtyGirl0", "flirtyGirl1"],
};

/**
 * Stage 2's waves, top row last: the runtime plays the list bottom-up. G is
 * the flirty girl, C the hacked laptop; the digit is the drop (1 big shot,
 * 2 three-way, 3 speed, 9 barrier).
 */
export const STAGE2 = [
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["G0", "00", "C0", "00", "00", "C0", "00", "G0"],
  ["00", "G0", "00", "C0", "C9", "00", "G0", "00"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["C0", "C0", "00", "G0", "G0", "00", "C0", "C0"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["00", "G0", "00", "00", "00", "00", "G2", "00"],
  ["G0", "00", "G0", "00", "00", "G0", "00", "G0"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["00", "00", "C0", "C0", "C1", "C0", "00", "00"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["00", "C0", "00", "G0", "00", "G0", "00", "C0"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
  ["00", "G0", "00", "00", "00", "00", "G0", "00"],
  ["00", "00", "C0", "00", "00", "C0", "00", "00"],
  ["00", "00", "00", "G3", "00", "00", "00", "00"],
  ["00", "00", "00", "00", "00", "00", "00", "00"],
];

/** Every frame this script packs into the level, by the name it gets there. */
export function packedNames(): string[] {
  return [
    ...Object.values(anim).flat(),
    ...FIRED,
    "RAM_0",
    ...Object.keys(FLIRTY),
  ];
}

/** Every frame name the three records draw. */
export function namedFrames(): string[] {
  const names = new Set<string>([
    ...Object.values(anim).flat(),
    ...FIRED,
    ...LOL_BOSS.bulletDataA.texture,
    ...LOL_BOSS.bulletDataB.texture,
    ...FLIRTY_GIRL.texture,
    ...FLIRTY_GIRL.projectileData.texture,
  ]);
  return [...names];
}

/** Cut the flirty girl out of the shipped game's own atlas. */
async function flirtyFrames(): Promise<ResolvedFrame[]> {
  const shipped = JSON.parse(await Deno.readTextFile(SHIPPED));
  const sheet = await decodeDataUrl(shipped.atlasImageDataURL);
  const frames: Record<string, FrameRect> = {};
  for (const [k, v] of Object.entries(shipped.atlasFrames)) {
    frames[decodeFrameName(k)] = v as FrameRect;
  }
  return Object.entries(FLIRTY).map(([name, src]) => {
    const rect = frames[src];
    if (!rect) throw new Error(`foo.json's atlas has no ${src}`);
    return {
      name,
      raster: cut(sheet, rect.frame),
      source: `static/games/2028-ai/foo.json#${src}`,
      scope: "foo",
    };
  });
}

/**
 * Shelf-pack to the level sheet's own width, in the order given, so the sheet
 * only grows down. A frame wider than that sheet widens it rather than being
 * clipped.
 */
function packTo(width: number, entries: ResolvedFrame[]) {
  const sheetW = Math.max(width, ...entries.map((e) => e.raster.width));
  const placed: { entry: ResolvedFrame; x: number; y: number }[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const entry of entries) {
    const { width: w, height: h } = entry.raster;
    if (x > 0 && x + w > sheetW) {
      x = 0;
      y += rowH + PAD;
      rowH = 0;
    }
    placed.push({ entry, x, y });
    x += w + PAD;
    rowH = Math.max(rowH, h);
  }
  const sheet = newRaster(sheetW, y + rowH);
  const frames: Record<string, FrameRect> = {};
  for (const { entry, x, y } of placed) {
    blit(sheet, entry.raster, x, y);
    const { width: w, height: h } = entry.raster;
    frames[entry.name] = {
      frame: { x, y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
    };
  }
  return { sheet, frames };
}

export interface Plan {
  added: { frame: string; source: string }[];
  reused: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  atlasImageDataURL: string | null;
  atlasFrames: Record<string, FrameRect>;
  records: Record<string, unknown>;
  taken: string[];
  etags: { image: string | null; frames: string | null };
}

export async function plan(): Promise<Plan> {
  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const rawFrames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !rawFrames.value) {
    throw new Error(`levels/${LEVEL} has no atlas to add to`);
  }
  const have = new Set(Object.keys(rawFrames.value).map(decodeFrameName));

  // Every source, in packing order: the boss's poses in one row, then the
  // small things.
  const sources: (() => Promise<ResolvedFrame>)[] = [];
  for (const name of Object.values(anim).flat()) {
    sources.push(() =>
      resolveFrame({ file: new URL(`${name}.png`, ART).pathname, as: name })
    );
  }
  for (const name of FIRED) {
    sources.push(() =>
      resolveFrame({ file: new URL(`${name}.png`, ART).pathname, as: name })
    );
  }
  sources.push(() => resolveFrame({ sprite: "RAM_0" }));
  const flirty = await flirtyFrames();
  for (const f of flirty) sources.push(() => Promise.resolve(f));

  const pull: ResolvedFrame[] = [];
  const reused: string[] = [];
  for (const load of sources) {
    const f = await load();
    if (have.has(f.name)) reused.push(f.name);
    else pull.push(f);
  }
  const missing = namedFrames().filter((n) =>
    !have.has(n) && !pull.some((f) => f.name === n)
  );
  if (missing.length) {
    throw new Error(`no art for ${missing.join(", ")}`);
  }

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

  // The wave list last: it names the enemy and the boss.
  const records: Record<string, unknown> = {
    "enemyData/enemyG": FLIRTY_GIRL,
    "bossData/boss1": LOL_BOSS,
    "stages/stage1": { enemylist: STAGE2 },
  };
  const taken: string[] = [];
  for (const path of Object.keys(records)) {
    if ((await get(`levels/${LEVEL}/${path}`)) != null) taken.push(path);
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
    records,
    taken,
    etags: { image: image.etag, frames: rawFrames.etag },
  };
}

const RECORD_PATHS = ["stages/stage1", "bossData/boss1", "enemyData/enemyG"];

/**
 * Undo --apply: drop the three records, then the frames this script packed
 * and the rows of the sheet they sat on. Records go first, so nothing is left
 * naming art that is gone. The sheet is cut back only when nothing the level
 * kept sits below the first packed row.
 */
export async function revert(): Promise<string[]> {
  const written: string[] = [];
  for (const path of RECORD_PATHS) {
    await put(`levels/${LEVEL}/${path}`, null);
    written.push(`levels/${LEVEL}/${path}`);
  }
  const image = await getWithEtag<string>(`levels/${LEVEL}/atlasImageDataURL`);
  const frames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !frames.value) return written;
  const ours = new Set(packedNames());
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
    `levels/${LEVEL}/atlasImageDataURL`,
    `levels/${LEVEL}/atlasFrames`,
  );
  return written;
}

/**
 * Write a plan: the art first, under the ETags it was read with, so a save
 * that raced this one is refused rather than overwritten; then the records,
 * which name that art. Refuses to replace a record already in a slot unless
 * `force`.
 */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.taken.length && !force) {
    throw new Error(
      `levels/${LEVEL} already has ${
        p.taken.join(", ")
      }; --force replaces them`,
    );
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
      `levels/${LEVEL}/atlasImageDataURL`,
      `levels/${LEVEL}/atlasFrames`,
    );
  }
  for (const [path, value] of Object.entries(p.records)) {
    await put(`levels/${LEVEL}/${path}`, value);
    written.push(`levels/${LEVEL}/${path}`);
  }
  await put(`levels/${LEVEL}/savedAt`, Date.now());
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
      level: LEVEL,
      added: p.added,
      reused: p.reused,
      atlas: p.atlas,
      records: Object.keys(p.records),
      alreadyThere: p.taken,
    },
    null,
    2,
  ));
  if (out) {
    const level = (await get<Json>(`levels/${LEVEL}`)) ?? {};
    if (p.atlasImageDataURL) level.atlasImageDataURL = p.atlasImageDataURL;
    level.atlasFrames = p.atlasFrames;
    for (const [path, value] of Object.entries(p.records)) {
      const [node, key] = path.split("/");
      level[node] = { ...(level[node] ?? {}), [key]: value };
    }
    await Deno.writeTextFile(out, JSON.stringify(level));
    console.log(`wrote ${out}`);
  }
  if (Deno.args.includes("--apply")) {
    const written = await apply(p, { force: Deno.args.includes("--force") });
    console.log(JSON.stringify({ written }, null, 2));
  }
}
