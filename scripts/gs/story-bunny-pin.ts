#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game's second stage a second story picture of its own:
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
 * - `storyData/customImages/stage1_part1`, the PNG as a data URL: the
 *   picture AdvScene shows over the second stage's second part ("and bytes
 *   in my little magic information rectangle"), decoded into the
 *   advCustom_stage1_part1 texture by the level loader's applyStoryImages
 *   before the first scene, and the picture a cart opens the stage on
 *   (shmup-harbor's story-panels take PNG as well as GIF). The four parts
 *   of gs's story shared one picture, the hacked-laptops GIF; this part gets
 *   its own and the other three keep theirs.
 * - `savedAt`, as every edit of the level does.
 *
 * Without --apply nothing is written. --apply writes under the ETag the
 * field was read with, so a save that raced this one is refused. It fills
 * an empty slot or replaces the shared picture (the one stage1_part0 still
 * carries); a picture that is neither needs --force. Run again, it writes
 * nothing. --out writes the whole level as it would be after the write, for
 * a local play-through (window.__OFFLINE_LEVEL__, see build-stage2.ts).
 * --revert puts the shared picture back, copied from stage1_part0 — or,
 * with no stage1_part0 to copy, takes the part's picture out, and AdvScene
 * shows 2028.Ai's stock portrait for it. --force reverts a picture this
 * script did not write.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { dbPath, get, getWithEtag, put } from "../../mcp/lib/rtdb.ts";
import { ART } from "./build-stage2.ts";

const LEVEL = "gs";
const IMAGES = `levels/${LEVEL}/storyData/customImages`;
/** The second stage's second part. */
export const KEY = "stage1_part1";
/** The part whose picture this one shared, and gets back on --revert. */
export const SHARED_WITH = "stage1_part0";
const FIELD = `${IMAGES}/${KEY}`;

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
  /** "shared": the part still shows the picture stage1_part0 shows. */
  state: "new" | "already as planned" | "shared" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<Plan> {
  const dataUrl = await pictureDataUrl();
  const [{ value, etag }, shared] = await Promise.all([
    getWithEtag<unknown>(FIELD),
    get<unknown>(`${IMAGES}/${SHARED_WITH}`),
  ]);
  const state: Plan["state"] = value == null
    ? "new"
    : value === dataUrl
    ? "already as planned"
    : shared != null && value === shared
    ? "shared"
    : "differs";
  return { dataUrl, etag, state };
}

/** Write the picture over the shared one or into an empty slot. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "differs" && !force) {
    throw new Error(
      `${
        dbPath(FIELD)
      } already holds a picture of its own; --force replaces it`,
    );
  }
  await put(FIELD, p.dataUrl, { ifMatch: p.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return [dbPath(FIELD)];
}

/**
 * Put the shared picture back (stage1_part0's), or with none to copy take
 * the part's picture out.
 */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const [{ value, etag }, shared] = await Promise.all([
    getWithEtag<unknown>(FIELD),
    get<unknown>(`${IMAGES}/${SHARED_WITH}`),
  ]);
  if (value == null || (shared != null && value === shared)) return [];
  if (value !== await pictureDataUrl() && !force) {
    throw new Error(
      `${dbPath(FIELD)} holds a picture this script did not write; ` +
        `--force takes it out anyway`,
    );
  }
  await put(FIELD, typeof shared === "string" ? shared : null, {
    ifMatch: etag,
  });
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
          : p.state === "shared"
          ? `shared with ${SHARED_WITH} (replaced)`
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
