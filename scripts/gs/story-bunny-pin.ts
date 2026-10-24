#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the third-stage story of gs, and of rando, the glitter bunny pin as
 * the picture of its second part.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts            # dry run, gs
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --level rando
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --revert
 *
 * The art is art/bunnyPin.png, cut by cut_bunny_pin.py out of the upload
 * (art/bunnyPinUpload.jpg, the pin photographed on black among a scatter of
 * stars): the pin alone, on a transparent 180x240, the size and shape gs's
 * other story pictures are.
 *
 * What it writes to shmupX/levels/<level> (mcp/lib/rtdb.ts roots every
 * level path there; cmg's root-level copy is never touched):
 *
 * - `storyData/customImages/stage2_part1`, the PNG as a data URL: the
 *   picture AdvScene shows over the third-stage story's second part,
 *   decoded into the advCustom_stage2_part1 texture by the level loader's
 *   applyStoryImages before the first scene, and the picture a cart opens
 *   that stage on (shmup-harbor's story-panels take PNG as well as GIF).
 * - `savedAt`, as every edit of the level does.
 *
 * Two levels carry it (LEVELS), each with what its slot held before:
 *
 * - gs: the slot was empty. gs has two stages (stages/stage0 and stage1),
 *   so until it gets a third this entry is the one past its last, holding
 *   the editor's seed, 2028.Ai's third-stage words ("This beauty is
 *   something that both you as well as I, both possess!" under the pin),
 *   and a picture there makes it an epilogue of gs's own (game.bundle.js's
 *   authoredEpilogue): AdvScene plays it after the second stage, where a
 *   two-stage game with no such entry goes straight to its ending. A third
 *   stage, when it comes, opens on it instead.
 * - rando, the game the SAVE SHELF's exports play (the one whose plate
 *   still reads G): its third stage is a stage, and the slot held the upload
 *   itself, the editor's raw copy of the photo, black and stars and all,
 *   under "Digital Satan promised our deepest desires". The pin replaces it.
 *
 * Without --apply nothing is written. --apply writes under the ETag the
 * field was read with, so a save that raced this one is refused, into an
 * empty slot or over what the slot held before (--force replaces anything
 * else); run again, it writes nothing. --out writes the whole level as it
 * would be after the write, for a local play-through
 * (window.__OFFLINE_LEVEL__, see build-stage2.ts). --revert puts back what
 * the slot held before: rando gets its raw upload again, gs's slot is
 * emptied and the entry is the seeded story it was, no epilogue (--force
 * reverts a picture this script did not write).
 */

import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { dbPath, get, getWithEtag, put } from "../../mcp/lib/rtdb.ts";
import { ART } from "./build-stage2.ts";

/** The third stage's second story part. */
export const KEY = "stage2_part1";

// deno-lint-ignore no-explicit-any
type Json = any;

/** The pin, as cut_bunny_pin.py writes it. */
export const PICTURE = new URL("bunnyPin.png", ART);
/** The photo as it was uploaded: what rando's slot held. */
export const UPLOAD = new URL("bunnyPinUpload.jpg", ART);

/** The picture as the record carries it. */
export async function pictureDataUrl(): Promise<string> {
  return "data:image/png;base64," + encodeBase64(await Deno.readFile(PICTURE));
}

/** The upload as the editor stored it on rando. */
export async function uploadDataUrl(): Promise<string> {
  return "data:image/jpeg;base64," + encodeBase64(await Deno.readFile(UPLOAD));
}

export type Level = "gs" | "rando";

/** What each level's slot held before the pin, and gets back on --revert. */
export const LEVELS: Record<Level, { before: () => Promise<string | null> }> = {
  gs: { before: () => Promise.resolve(null) },
  rando: { before: uploadDataUrl },
};

export function levelOf(name: string): Level {
  if (!(name in LEVELS)) {
    throw new Error(
      `no such level for the pin: ${JSON.stringify(name)} (${
        Object.keys(LEVELS).join(", ")
      })`,
    );
  }
  return name as Level;
}

const field = (level: Level) => `levels/${level}/storyData/customImages/${KEY}`;

export interface Plan {
  level: Level;
  dataUrl: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  /** "before": the slot still holds what it held before the pin. */
  state: "new" | "already as planned" | "before" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(level: Level = "gs"): Promise<Plan> {
  const [dataUrl, before, { value, etag }] = await Promise.all([
    pictureDataUrl(),
    LEVELS[level].before(),
    getWithEtag<unknown>(field(level)),
  ]);
  const state: Plan["state"] = value == null
    ? "new"
    : value === dataUrl
    ? "already as planned"
    : before != null && value === before
    ? "before"
    : "differs";
  return { level, dataUrl, etag, state };
}

/** Write the picture into the empty slot or over what it held before. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "differs" && !force) {
    throw new Error(
      `${
        dbPath(field(p.level))
      } already holds another picture; --force replaces it`,
    );
  }
  await put(field(p.level), p.dataUrl, { ifMatch: p.etag });
  await put(`levels/${p.level}/savedAt`, Date.now());
  return [dbPath(field(p.level))];
}

/** Put back what the slot held before the pin. */
export async function revert(
  level: Level = "gs",
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const [ours, before, { value, etag }] = await Promise.all([
    pictureDataUrl(),
    LEVELS[level].before(),
    getWithEtag<unknown>(field(level)),
  ]);
  if (value == null || value === before) return [];
  if (value !== ours && !force) {
    throw new Error(
      `${dbPath(field(level))} holds a picture this script did not write; ` +
        `--force takes it out anyway`,
    );
  }
  await put(field(level), before, { ifMatch: etag });
  await put(`levels/${level}/savedAt`, Date.now());
  return [dbPath(field(level))];
}

if (import.meta.main) {
  const force = Deno.args.includes("--force");
  const levelAt = Deno.args.indexOf("--level");
  const level = levelOf(levelAt >= 0 ? Deno.args[levelAt + 1] ?? "" : "gs");
  if (Deno.args.includes("--revert")) {
    console.log(
      JSON.stringify({ reverted: await revert(level, { force }) }, null, 2),
    );
  } else {
    const outAt = Deno.args.indexOf("--out");
    const out = outAt >= 0 ? Deno.args[outAt + 1] : undefined;
    const p = await plan(level);
    console.log(JSON.stringify(
      {
        level: dbPath(`levels/${level}`),
        field: `storyData/customImages/${KEY}`,
        art: fromFileUrl(PICTURE),
        dataUrlLength: p.dataUrl.length,
        state: p.state === "differs"
          ? "differs (--force replaces it)"
          : p.state === "before"
          ? "what the slot held before the pin (replaced)"
          : p.state,
      },
      null,
      2,
    ));
    if (out) {
      const record: Json = (await get<Json>(`levels/${level}`)) ?? {};
      record.storyData ??= {};
      record.storyData.customImages ??= {};
      record.storyData.customImages[KEY] = p.dataUrl;
      await Deno.writeTextFile(out, JSON.stringify(record));
      console.log(`wrote ${out}`);
    }
    if (Deno.args.includes("--apply")) {
      console.log(
        JSON.stringify({ written: await apply(p, { force }) }, null, 2),
      );
    }
  }
}
