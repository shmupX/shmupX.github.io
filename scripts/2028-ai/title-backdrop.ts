#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Swap rando's seamed gold 2028 for the seamless one, in the database records
 * that carry it as their own scrolling title backdrop.
 *
 *   deno run -A --node-modules-dir=none scripts/2028-ai/title-backdrop.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/2028-ai/title-backdrop.ts --apply
 *   deno run -A --node-modules-dir=none scripts/2028-ai/title-backdrop.ts --revert
 *
 * rando drew the gold 2028 and uploaded it as a 768x1376 PNG, kept as
 * art/titleBgUpload-rando.png. Its own record (shmupX/levels/rando) and
 * 2028.Ai's (shmupX/levels/foo) carry it as titleBgDataURL, and the title
 * scrolls it sideways without end: 768 is not a period of its pattern, so it
 * shows a seam at every wrap. draw_2028_backdrop.py redraws it as an 845x480
 * tile that repeats exactly every 845 pixels, and writes it losslessly as
 * art/titleBg2028.png; that PNG is what goes in. A PNG and not the title's
 * JPEG, because the exporters decode only PNG and GIF title art
 * (shmup-harbor's PS2 titleUploadFrames, build-sav's titleArt, which
 * build-sfc shares). static/games/2028-ai/foo.json, which a plain visit to
 * 2028.Ai bakes, carries the same PNG (tests/seamless_2028_backdrop_test.ts).
 *
 * What it writes to each record (mcp/lib/rtdb.ts roots every level path
 * under shmupX/; cmg's root-level copy is never touched):
 *
 * - `titleBgDataURL`, the tile as a PNG data URL;
 * - `savedAt`, as every edit of a level does.
 *
 * Without --apply nothing is written: the dry run says what each record holds
 * now. --apply writes under the ETag the field was read with, so a save that
 * raced this one is refused, and only over rando's upload (--force also
 * replaces another backdrop, or fills an empty field); run again, it writes
 * nothing. --revert puts rando's upload back where this script wrote the
 * tile (--force over another backdrop). The fields are megabytes long, so
 * reads and writes allow LARGE_TIMEOUT_MS rather than rtdb.ts's 30 seconds.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { dbPath, getWithEtag, put } from "../../mcp/lib/rtdb.ts";

/** The records that carried rando's upload as their own backdrop. */
export const LEVELS = ["rando", "foo"] as const;

export const ART = new URL("./art/", import.meta.url);
/** The seamless tile, as draw_2028_backdrop.py writes it. */
export const TILE = new URL("titleBg2028.png", ART);
/** rando's upload, byte for byte as the records carried it. */
export const UPLOAD = new URL("titleBgUpload-rando.png", ART);

const LARGE_TIMEOUT_MS = 300_000;

const field = (level: string) => `levels/${level}/titleBgDataURL`;

/** A PNG file as a record carries it. */
export async function pngDataUrl(file: URL): Promise<string> {
  return "data:image/png;base64," + encodeBase64(await Deno.readFile(file));
}

export type State =
  | "rando's upload"
  | "already as planned"
  | "empty"
  | "differs";

export interface Plan {
  level: string;
  dataUrl: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  state: State;
  /** How long the field's data URL is now, 0 for none. */
  currentLength: number;
}

/** What --apply would write to one record. Writes nothing. */
export async function plan(level: string): Promise<Plan> {
  const [dataUrl, upload] = await Promise.all([
    pngDataUrl(TILE),
    pngDataUrl(UPLOAD),
  ]);
  const { value, etag } = await getWithEtag<string>(field(level), {
    timeoutMs: LARGE_TIMEOUT_MS,
  });
  const state: State = value == null
    ? "empty"
    : value === dataUrl
    ? "already as planned"
    : value === upload
    ? "rando's upload"
    : "differs";
  return { level, dataUrl, etag, state, currentLength: value?.length ?? 0 };
}

/** Write the tile over rando's upload, unless it is there already. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state !== "rando's upload" && !force) {
    throw new Error(
      `${dbPath(field(p.level))} is ${
        p.state === "empty" ? "empty" : "another backdrop"
      }, not rando's upload; --force writes the tile anyway`,
    );
  }
  await put(field(p.level), p.dataUrl, {
    ifMatch: p.etag,
    timeoutMs: LARGE_TIMEOUT_MS,
  });
  await put(`levels/${p.level}/savedAt`, Date.now());
  return [dbPath(field(p.level))];
}

/** Put rando's upload back where the tile is. */
export async function revert(
  level: string,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const p = await plan(level);
  if (p.state === "rando's upload") return [];
  if (p.state !== "already as planned" && !force) {
    throw new Error(
      `${dbPath(field(level))} holds a backdrop this script did not write; ` +
        `--force puts rando's upload there anyway`,
    );
  }
  await put(field(level), await pngDataUrl(UPLOAD), {
    ifMatch: p.etag,
    timeoutMs: LARGE_TIMEOUT_MS,
  });
  await put(`levels/${level}/savedAt`, Date.now());
  return [dbPath(field(level))];
}

if (import.meta.main) {
  const force = Deno.args.includes("--force");
  if (Deno.args.includes("--revert")) {
    const reverted: string[] = [];
    for (const level of LEVELS) {
      reverted.push(...await revert(level, { force }));
    }
    console.log(JSON.stringify({ reverted }, null, 2));
  } else {
    const plans: Plan[] = [];
    for (const level of LEVELS) plans.push(await plan(level));
    console.log(JSON.stringify(
      {
        art: fromFileUrl(TILE),
        dataUrlLength: plans[0].dataUrl.length,
        records: plans.map((p) => ({
          level: dbPath(`levels/${p.level}`),
          field: "titleBgDataURL",
          currentLength: p.currentLength,
          state: p.state === "differs" || p.state === "empty"
            ? `${p.state} (--force writes the tile anyway)`
            : p.state,
        })),
      },
      null,
      2,
    ));
    if (Deno.args.includes("--apply")) {
      const written: string[] = [];
      for (const p of plans) written.push(...await apply(p, { force }));
      console.log(JSON.stringify({ written }, null, 2));
    }
  }
}
