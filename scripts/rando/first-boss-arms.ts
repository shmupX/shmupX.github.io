#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Arm the rando cloud game's first boss with a beam and a Hadoken.
 *
 *   deno run -A --node-modules-dir=none scripts/rando/first-boss-arms.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/rando/first-boss-arms.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/rando/first-boss-arms.ts --apply
 *   deno run -A --node-modules-dir=none scripts/rando/first-boss-arms.ts --revert
 *
 * rando's first boss (shmupX/levels/rando/bossData/boss0) is the Character
 * Library's dezaBoss0 — Ryu riding a Hadoken — flying its Dezaemon record:
 * weapon A aimed at the ship from its fire points, weapon C in the spread
 * and the spiral, two parts riding on him (37, the Hadoken comet; 38, the
 * yellow orbs) and the flame. Out of both weapons he threw the cart's stock
 * bullets (dezaBullet0 and dezaBullet2, carried as dezaBoss0_4..11): small
 * red and cyan dots, not the attacks of the character he is.
 *
 * This arms weapon A with the library's `hadouken` (the two-frame flicker
 * the create-character skill's hadoukenBoss fires, the comet of his own
 * part 37) and weapon C with its `beam` (four 32x8 segments of a cyan
 * laser), turned to its flight direction by `facing` (game.bundle.js,
 * faceBulletHeading). The rest of the record — hp, patterns, parts, the
 * flame, the slots' own speed and damage — is left exactly as it is.
 *
 * Nothing is written without --apply. --out writes the whole level as it
 * would be after the write, for a local play-through
 * (window.__OFFLINE_LEVEL__, see scripts/gs/build-stage2.ts). --apply
 * writes the art first and then the record, each under the ETag it was read
 * with, so a save that raced this one is refused. --revert puts the stock
 * bullets back and takes the six frames out of the atlas unless another
 * record of the level still draws one; --force arms a slot that is already
 * armed again (after a --revert that was undone by hand, say).
 *
 * Only shmupX's copy of the level is read or written (mcp/lib/rtdb.ts roots
 * every level path); cmg's root-level copy is never touched.
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
import { referencedFrames } from "../../mcp/lib/character.ts";
import {
  dbPath,
  decodeFrameName,
  encodeKey,
  get,
  getWithEtag,
  put,
} from "../../mcp/lib/rtdb.ts";
import { packTo, PAD } from "../gs/build-stage2.ts";

export const LEVEL = "rando";
/** The first stage's boss: the runtime pairs stage N with slot bossN. */
export const SLOT = "boss0";

// deno-lint-ignore no-explicit-any
type Json = any;
export type Boss = Record<string, Json>;

/** Weapon A, the Hadoken: both frames of the library's `hadouken` atlas. */
export const HADOUKEN = ["hadouken_0", "hadouken_1"];
/** Weapon C, the beam: all four segments of the library's `beam` atlas. */
export const BEAM = ["beam_0", "beam_1", "beam_2", "beam_3"];
/** The beam is drawn pointing right; a bullet of it turns to its heading. */
export const BEAM_FACING = 0;

/**
 * What the two slots held (read 2026-10-22): the cart's stock bullets, as
 * rando's atlas spells them. What --revert puts back.
 */
export const STOCK = {
  bulletDataA: [
    "dezaBoss0_4.png",
    "dezaBoss0_5.png",
    "dezaBoss0_6.png",
    "dezaBoss0_7.png",
  ],
  bulletDataC: [
    "dezaBoss0_8.png",
    "dezaBoss0_9.png",
    "dezaBoss0_10.png",
    "dezaBoss0_11.png",
  ],
};

const same = (a: unknown, b: string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Does this record already fire the Hadoken and the beam? */
export function isArmed(record: Boss | null): boolean {
  return !!record && same(record.bulletDataA?.texture, HADOUKEN) &&
    same(record.bulletDataC?.texture, BEAM);
}

/**
 * The record with weapon A firing the Hadoken and weapon C the beam. Each
 * slot keeps its own speed, damage, hp, score and gauge award; only the art
 * changes, and the beam gains its `facing`. Everything else is the record
 * as it is.
 */
export function armed(record: Boss): Boss {
  return {
    ...record,
    bulletDataA: { ...(record.bulletDataA ?? {}), texture: [...HADOUKEN] },
    bulletDataC: {
      ...(record.bulletDataC ?? {}),
      texture: [...BEAM],
      facing: BEAM_FACING,
    },
  };
}

/** The record with the stock bullets back in both slots, `facing` gone. */
export function disarmed(record: Boss): Boss {
  const { facing: _facing, ...c } = record.bulletDataC ?? {};
  return {
    ...record,
    bulletDataA: {
      ...(record.bulletDataA ?? {}),
      texture: [...STOCK.bulletDataA],
    },
    bulletDataC: { ...c, texture: [...STOCK.bulletDataC] },
  };
}

/** The six frames, cut from the library's two atlases under rando's names. */
async function sources(): Promise<ResolvedFrame[]> {
  const beam = ["atlas_s0", "atlas_s1", "atlas_s2", "atlas_s3"];
  return [
    await resolveFrame({
      atlas: "hadouken",
      frame: "atlas_s0",
      as: HADOUKEN[0],
    }),
    await resolveFrame({
      atlas: "hadouken",
      frame: "hadouken1",
      as: HADOUKEN[1],
    }),
    ...await Promise.all(
      beam.map((frame, i) =>
        resolveFrame({ atlas: "beam", frame, as: BEAM[i] })
      ),
    ),
  ];
}

export interface Plan {
  added: { frame: string; source: string }[];
  reused: string[];
  atlas: { before: { w: number; h: number }; after: { w: number; h: number } };
  atlasImageDataURL: string | null;
  atlasFrames: Record<string, FrameRect>;
  /** The slot as it is. */
  before: Boss;
  /** The slot as --apply writes it. */
  record: Boss;
  alreadyArmed: boolean;
  etags: { image: string | null; frames: string | null; slot: string | null };
}

export async function plan(): Promise<Plan> {
  const image = await getWithEtag<string>(
    `levels/${LEVEL}/atlasImageDataURL`,
    { timeoutMs: 120_000 },
  );
  const rawFrames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !rawFrames.value) {
    throw new Error(`${dbPath(`levels/${LEVEL}`)} has no atlas to add to`);
  }
  const slot = await getWithEtag<Boss>(`levels/${LEVEL}/bossData/${SLOT}`);
  if (!slot.value || typeof slot.value !== "object") {
    throw new Error(`${dbPath(`levels/${LEVEL}/bossData/${SLOT}`)} is empty`);
  }
  if (!slot.value.dezaemon?.boss) {
    throw new Error(
      `${dbPath(`levels/${LEVEL}/bossData/${SLOT}`)} is ${
        JSON.stringify(slot.value.name ?? null)
      }, not a Dezaemon boss — the weapons A and C this arms are the ones its ` +
        `fire points read (bossWeapon in game.bundle.js)`,
    );
  }
  const record = armed(slot.value);

  const have = new Set(Object.keys(rawFrames.value).map(decodeFrameName));
  const pull: ResolvedFrame[] = [];
  const reused: string[] = [];
  for (const f of await sources()) {
    if (have.has(f.name)) reused.push(f.name);
    else pull.push(f);
  }
  const missing = referencedFrames(record).filter((n) =>
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
    before: slot.value,
    record,
    alreadyArmed: isArmed(slot.value),
    etags: { image: image.etag, frames: rawFrames.etag, slot: slot.etag },
  };
}

/**
 * Write a plan: the art first, then the record that names it, each under
 * the ETag it was read with. A slot that already fires these is left alone
 * unless `force`.
 */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const slot = `levels/${LEVEL}/bossData/${SLOT}`;
  if (p.alreadyArmed && !force) {
    throw new Error(
      `${
        dbPath(slot)
      } already fires the Hadoken and the beam; --force re-arms it`,
    );
  }
  const written: string[] = [];
  if (p.atlasImageDataURL) {
    await put(`levels/${LEVEL}/atlasImageDataURL`, p.atlasImageDataURL, {
      ifMatch: p.etags.image,
      timeoutMs: 120_000,
    });
    await put(`levels/${LEVEL}/atlasFrames`, p.atlasFrames, {
      ifMatch: p.etags.frames,
    });
    written.push(
      dbPath(`levels/${LEVEL}/atlasImageDataURL`),
      dbPath(`levels/${LEVEL}/atlasFrames`),
    );
  }
  await put(slot, p.record, { ifMatch: p.etags.slot });
  written.push(dbPath(slot));
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
 * Undo --apply: the stock bullets back into the record first, so nothing is
 * left naming art that is gone, then the six frames — unless another record
 * still draws one — and the rows of the sheet they sat on, when nothing the
 * level kept sits below them.
 */
export async function revert(): Promise<string[]> {
  const written: string[] = [];
  const slotPath = `levels/${LEVEL}/bossData/${SLOT}`;
  const slot = await getWithEtag<Boss>(slotPath);
  if (slot.value && isArmed(slot.value)) {
    await put(slotPath, disarmed(slot.value), { ifMatch: slot.etag });
    written.push(dbPath(slotPath));
  }

  const image = await getWithEtag<string>(
    `levels/${LEVEL}/atlasImageDataURL`,
    { timeoutMs: 120_000 },
  );
  const frames = await getWithEtag<Record<string, FrameRect>>(
    `levels/${LEVEL}/atlasFrames`,
  );
  if (!image.value || !frames.value) return written;
  const drawn = await stillDrawn();
  const ours = new Set([...HADOUKEN, ...BEAM].filter((n) => !drawn.has(n)));
  const keep: Record<string, FrameRect> = {};
  let firstRow = Infinity;
  for (const [key, rect] of Object.entries(frames.value)) {
    if (ours.has(decodeFrameName(key))) {
      firstRow = Math.min(firstRow, rect.frame.y);
    } else keep[key] = rect;
  }
  if (!Number.isFinite(firstRow)) {
    if (written.length) await put(`levels/${LEVEL}/savedAt`, Date.now());
    return written;
  }
  const sheet = await decodeDataUrl(image.value);
  const lowest = Math.max(
    0,
    ...Object.values(keep).map((r) => r.frame.y + r.frame.h),
  );
  const height = lowest <= firstRow - PAD ? firstRow - PAD : sheet.height;
  const cropped = cut(sheet, { x: 0, y: 0, w: sheet.width, h: height });
  await put(`levels/${LEVEL}/atlasImageDataURL`, await sheetDataUrl(cropped), {
    ifMatch: image.etag,
    timeoutMs: 120_000,
  });
  await put(`levels/${LEVEL}/atlasFrames`, keep, { ifMatch: frames.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  written.push(
    dbPath(`levels/${LEVEL}/atlasImageDataURL`),
    dbPath(`levels/${LEVEL}/atlasFrames`),
  );
  return written;
}

/** The slot's weapons, as a dry run prints them: slot -> its frame list. */
export function weaponsOf(record: Boss): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {};
  for (const key of ["bulletDataA", "bulletDataB", "bulletDataC"]) {
    const w = record[key];
    out[key] = w && Array.isArray(w.texture) ? w.texture : null;
  }
  return out;
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
      slot: `bossData/${SLOT} (${p.before.name})`,
      alreadyArmed: p.alreadyArmed,
      added: p.added,
      reused: p.reused,
      atlas: p.atlas,
      weapons: { before: weaponsOf(p.before), after: weaponsOf(p.record) },
      facing: { bulletDataC: p.record.bulletDataC.facing },
    },
    null,
    2,
  ));
  if (out) {
    // The whole record is megabytes of data URLs: give the read its time.
    const level =
      (await getWithEtag<Json>(`levels/${LEVEL}`, { timeoutMs: 120_000 }))
        .value ?? {};
    if (p.atlasImageDataURL) level.atlasImageDataURL = p.atlasImageDataURL;
    level.atlasFrames = p.atlasFrames;
    level.bossData = { ...(level.bossData ?? {}), [SLOT]: p.record };
    await Deno.writeTextFile(out, JSON.stringify(level));
    console.log(`wrote ${out}`);
  }
  if (Deno.args.includes("--apply")) {
    const written = await apply(p, { force: Deno.args.includes("--force") });
    console.log(JSON.stringify({ written }, null, 2));
  } else {
    console.log("nothing written (--apply writes it, --revert takes it back)");
  }
}
