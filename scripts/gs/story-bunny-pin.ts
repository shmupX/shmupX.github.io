#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game's third-stage story a picture for its second part:
 * the glitter bunny pin.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/story-bunny-pin.ts --revert
 *
 * The art is art/bunnyPin.png, cut by cut_bunny_pin.py out of the upload
 * (art/bunnyPinUpload.jpg, the pin photographed on black among a scatter of
 * stars): the pin alone, on a transparent 180x240, the size and shape gs's
 * other story pictures are.
 *
 * What it writes to shmupX/levels/gs (mcp/lib/rtdb.ts roots every level
 * path there; cmg's root-level copy is never touched):
 *
 * - `storyData/customImages/stage2_part1`, the PNG as a data URL: the
 *   picture AdvScene shows over the third-stage story's second part,
 *   decoded into the advCustom_stage2_part1 texture by the level loader's
 *   applyStoryImages before the first scene, and the picture a cart opens
 *   that stage on (shmup-harbor's story-panels take PNG as well as GIF).
 *   The entry's words are the ones the editor seeded, 2028.Ai's third-stage
 *   story: the pin's part reads "This beauty is something that both you as
 *   well as I, both possess!". gs's four earlier parts keep the
 *   hacked-laptops GIF they share.
 * - `savedAt`, as every edit of the level does.
 *
 * gs has two stages (stages/stage0 and stage1), so until it gets a third
 * this entry is the one past its last, and a picture there makes it an
 * epilogue of gs's own (game.bundle.js's authoredEpilogue): AdvScene plays
 * stage2's story, seeded words and pin, after the second stage, where a
 * two-stage game with no such entry goes straight to its ending. A third
 * stage, when it comes, opens on it instead.
 *
 * Without --apply nothing is written. --apply writes under the ETag the
 * field was read with, so a save that raced this one is refused, and only
 * into an empty slot (--force replaces another picture); run again, it
 * writes nothing. --out writes the whole level as it would be after the
 * write, for a local play-through (window.__OFFLINE_LEVEL__, see
 * build-stage2.ts). --revert takes the picture out again (--force takes
 * out another), and the entry is the seeded story it was: no epilogue.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { dbPath, get, getWithEtag, put } from "../../mcp/lib/rtdb.ts";
import { ART } from "./build-stage2.ts";

const LEVEL = "gs";
/** The third stage's second story part. */
export const KEY = "stage2_part1";
const FIELD = `levels/${LEVEL}/storyData/customImages/${KEY}`;

// deno-lint-ignore no-explicit-any
type Json = any;

/** The pin, as cut_bunny_pin.py writes it. */
export const PICTURE = new URL("bunnyPin.png", ART);

/** The picture as the record carries it. */
export async function pictureDataUrl(): Promise<string> {
  return "data:image/png;base64," + encodeBase64(await Deno.readFile(PICTURE));
}

export interface Plan {
  dataUrl: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  state: "new" | "already as planned" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<Plan> {
  const dataUrl = await pictureDataUrl();
  const { value, etag } = await getWithEtag<unknown>(FIELD);
  const state: Plan["state"] = value == null
    ? "new"
    : value === dataUrl
    ? "already as planned"
    : "differs";
  return { dataUrl, etag, state };
}

/** Write the picture, unless it is there already. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "differs" && !force) {
    throw new Error(
      `${dbPath(FIELD)} already holds another picture; --force replaces it`,
    );
  }
  await put(FIELD, p.dataUrl, { ifMatch: p.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return [dbPath(FIELD)];
}

/** Take the picture out: the entry is the seeded story it was. */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const { value, etag } = await getWithEtag<unknown>(FIELD);
  if (value == null) return [];
  if (value !== await pictureDataUrl() && !force) {
    throw new Error(
      `${dbPath(FIELD)} holds a picture this script did not write; ` +
        `--force takes it out anyway`,
    );
  }
  await put(FIELD, null, { ifMatch: etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return [dbPath(FIELD)];
}

if (import.meta.main) {
  const force = Deno.args.includes("--force");
  if (Deno.args.includes("--revert")) {
    console.log(JSON.stringify({ reverted: await revert({ force }) }, null, 2));
  } else {
    const outAt = Deno.args.indexOf("--out");
    const out = outAt >= 0 ? Deno.args[outAt + 1] : undefined;
    const p = await plan();
    console.log(JSON.stringify(
      {
        level: dbPath(`levels/${LEVEL}`),
        field: `storyData/customImages/${KEY}`,
        art: fromFileUrl(PICTURE),
        dataUrlLength: p.dataUrl.length,
        state: p.state === "differs"
          ? "differs (--force replaces it)"
          : p.state,
      },
      null,
      2,
    ));
    if (out) {
      const level: Json = (await get<Json>(`levels/${LEVEL}`)) ?? {};
      level.storyData ??= {};
      level.storyData.customImages ??= {};
      level.storyData.customImages[KEY] = p.dataUrl;
      await Deno.writeTextFile(out, JSON.stringify(level));
      console.log(`wrote ${out}`);
    }
    if (Deno.args.includes("--apply")) {
      console.log(
        JSON.stringify({ written: await apply(p, { force }) }, null, 2),
      );
    }
  }
}
