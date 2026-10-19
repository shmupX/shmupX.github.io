#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game's title a scrolling backdrop of its own: the gold
 * plate custom games wear, reading 869 instead of 2028.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/title-backdrop.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/title-backdrop.ts --out x.json
 *   deno run -A --node-modules-dir=none scripts/gs/title-backdrop.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/title-backdrop.ts --revert
 *
 * The art is art/titleBg869.jpg, drawn by draw_869_backdrop.py from rando's
 * gold 2028 (its upload, kept as scripts/2028-ai/art/titleBgCustom-rando.jpg;
 * static/games/2028-ai/assets/img/titleBgCustom.jpg is it redrawn): the same
 * gold, emboss, size, angle and spacing, as an 845x480 tile that repeats
 * exactly every 845 pixels across, so the title's endless sideways scroll
 * (TitleScene's wrapTilePositionX) never shows a seam.
 *
 * What it writes to shmupX/levels/gs (mcp/lib/rtdb.ts roots every level
 * path there; cmg's root-level copy is never touched):
 *
 * - `titleBgDataURL`, the JPEG as a data URL. A record with a backdrop wears
 *   it instead of the shared gold 2028, which every other custom game keeps:
 *   level-loader puts it up as `title_bg`, and customTitleArt reports
 *   titleBg, so the title scene scrolls it rather than title_bg_custom.
 * - `savedAt`, as every edit of the level does.
 *
 * The PS2 exporter decodes only PNG and GIF uploads (shmup-harbor's
 * titleUploadFrames), so `deno task ps2:page gs` leaves the disc's title as
 * it is and says so in its notes.
 *
 * Without --apply nothing is written. --apply writes under the ETag the
 * field was read with, so a save that raced this one is refused, and only
 * into an empty field (--force replaces another backdrop); run again, it
 * writes nothing. --out writes the whole level as it would be after the
 * write, for a local play-through (window.__OFFLINE_LEVEL__, see
 * build-stage2.ts). --revert takes this backdrop out again (--force takes
 * out another), and the title goes back to the shared gold 2028.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { dbPath, get, getWithEtag, put } from "../../mcp/lib/rtdb.ts";
import { ART } from "./build-stage2.ts";

const LEVEL = "gs";
const FIELD = `levels/${LEVEL}/titleBgDataURL`;

// deno-lint-ignore no-explicit-any
type Json = any;

/** The tile, as draw_869_backdrop.py writes it. */
export const BACKDROP = new URL("titleBg869.jpg", ART);

/** The tile as the record carries it. */
export async function backdropDataUrl(): Promise<string> {
  return "data:image/jpeg;base64," +
    encodeBase64(await Deno.readFile(BACKDROP));
}

export interface Plan {
  dataUrl: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  state: "new" | "already as planned" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<Plan> {
  const dataUrl = await backdropDataUrl();
  const { value, etag } = await getWithEtag<string>(FIELD);
  const state = value == null
    ? "new"
    : value === dataUrl
    ? "already as planned"
    : "differs";
  return { dataUrl, etag, state };
}

/** Write the backdrop, unless it is there already. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "differs" && !force) {
    throw new Error(
      `${dbPath(FIELD)} already holds another backdrop; --force replaces it`,
    );
  }
  await put(FIELD, p.dataUrl, { ifMatch: p.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return [dbPath(FIELD)];
}

/** Take the backdrop out: the title goes back to the shared gold 2028. */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const { value, etag } = await getWithEtag<string>(FIELD);
  if (value == null) return [];
  if (value !== await backdropDataUrl() && !force) {
    throw new Error(
      `${dbPath(FIELD)} holds a backdrop this script did not write; ` +
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
        field: "titleBgDataURL",
        art: fromFileUrl(BACKDROP),
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
      level.titleBgDataURL = p.dataUrl;
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
