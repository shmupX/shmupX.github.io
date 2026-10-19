#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give the gs cloud game's title foo's gold start prompt.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/title-start-text.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/title-start-text.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/title-start-text.ts --revert
 *
 * The title's "TAP OR CLICK START" is game_ui's titleStartText.gif — red TAP
 * and CLICK — unless the record carries `titleStartTextDataURL`, which the
 * title draws instead (level-loader's applyTitleImages puts it up as
 * custom_titleStartText). foo (static/games/2028-ai/foo.json, the same as
 * shmupX/levels/foo) carries the gold one: the stock frame's 160x12 text,
 * pixel for pixel, with TAP and CLICK in gold (255,219,10). This copies foo's
 * field onto gs.
 *
 * What it writes to shmupX/levels/gs: `titleStartTextDataURL`, and
 * `savedAt`, as every edit of the level does.
 *
 * The PS2 port prints PRESS START over its title and draws no start image,
 * so the disc's title is unchanged — and "TAP OR CLICK" is not a pad's
 * prompt anyway.
 *
 * Without --apply nothing is written. --apply writes under the ETag the
 * field was read with, only into an empty field (--force replaces another
 * prompt); run again, it writes nothing. --revert takes it out again (--force
 * takes out another), and the title goes back to the red stock frame.
 */

import { fromFileUrl } from "@std/path";
import { dbPath, getWithEtag, put } from "../../mcp/lib/rtdb.ts";

const LEVEL = "gs";
const FIELD = `levels/${LEVEL}/titleStartTextDataURL`;

/** foo's record, as the repo ships it. */
export const FOO = new URL(
  "../../static/games/2028-ai/foo.json",
  import.meta.url,
);

/** foo's gold prompt, as its record carries it. */
export async function goldPrompt(): Promise<string> {
  const foo = JSON.parse(await Deno.readTextFile(FOO));
  const url = foo.titleStartTextDataURL;
  if (typeof url !== "string" || !url.startsWith("data:image/png;base64,")) {
    throw new Error(`${fromFileUrl(FOO)} has no titleStartTextDataURL`);
  }
  return url;
}

export interface Plan {
  dataUrl: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  state: "new" | "already as planned" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<Plan> {
  const dataUrl = await goldPrompt();
  const { value, etag } = await getWithEtag<string>(FIELD);
  const state = value == null
    ? "new"
    : value === dataUrl
    ? "already as planned"
    : "differs";
  return { dataUrl, etag, state };
}

/** Write the gold prompt, unless it is there already. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "differs" && !force) {
    throw new Error(
      `${dbPath(FIELD)} already holds another prompt; --force replaces it`,
    );
  }
  await put(FIELD, p.dataUrl, { ifMatch: p.etag });
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return [dbPath(FIELD)];
}

/** Take the gold prompt out: the title goes back to the red stock frame. */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const { value, etag } = await getWithEtag<string>(FIELD);
  if (value == null) return [];
  if (value !== await goldPrompt() && !force) {
    throw new Error(
      `${dbPath(FIELD)} holds a prompt this script did not write; ` +
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
    const p = await plan();
    console.log(JSON.stringify(
      {
        level: dbPath(`levels/${LEVEL}`),
        field: "titleStartTextDataURL",
        from: fromFileUrl(FOO),
        dataUrlLength: p.dataUrl.length,
        state: p.state === "differs"
          ? "differs (--force replaces it)"
          : p.state,
      },
      null,
      2,
    ));
    if (Deno.args.includes("--apply")) {
      console.log(
        JSON.stringify({ written: await apply(p, { force }) }, null, 2),
      );
    }
  }
}
