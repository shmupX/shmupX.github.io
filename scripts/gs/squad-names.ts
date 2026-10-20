#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Call the gs cloud game SQUAD, and let GS tell its story.
 *
 *   deno run -A --node-modules-dir=none scripts/gs/squad-names.ts            # dry run
 *   deno run -A --node-modules-dir=none scripts/gs/squad-names.ts --apply
 *   deno run -A --node-modules-dir=none scripts/gs/squad-names.ts --revert
 *
 * Two fields on shmupX/levels/gs:
 *
 *   `title`: "SQUAD". What the game is called on screen and on a phone: the
 *   title scene sets it in Orbitron where a logo would be (level-loader's
 *   titleNameOf, which used to read the record's `name` and so printed GS),
 *   and tools/build-level names the exported app after it (appTitleFor), so
 *   the APK's launcher label reads SQUAD. `name` stays "gs": it is the key
 *   the editor saves under, and the build's slug and package id
 *   (com.easierbycode.gs) come from the build name, so an installed copy
 *   updates in place.
 *
 *   `storyData/speaker`: "GS". The name on the plate above AdvScene's story
 *   box, which was always G (game.bundle.js's storySpeaker).
 *
 * Plus `savedAt`, as every edit of the level does. An exported app snapshots
 * the record when it is built, so the APK says SQUAD once it is rebuilt
 * (`deno task build:android gs`) and reinstalled.
 *
 * Without --apply nothing is written. --apply writes each field under the
 * ETag it was read with, only where it is empty (--force replaces another
 * value); run again, it writes nothing. The speaker is only ever written into
 * a story that has stages: a storyData holding nothing but a speaker would
 * read as a story with no parts. --revert takes both out again (--force takes
 * out values this script did not write).
 */

import { dbPath, getWithEtag, listKeys, put } from "../../mcp/lib/rtdb.ts";

const LEVEL = "gs";

export const FIELDS = [
  { field: `levels/${LEVEL}/title`, value: "SQUAD" },
  { field: `levels/${LEVEL}/storyData/speaker`, value: "GS" },
] as const;

export interface FieldPlan {
  field: string;
  value: string;
  /** The field's ETag when it was read. */
  etag: string | null;
  state: "new" | "already as planned" | "differs";
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<FieldPlan[]> {
  return await Promise.all(FIELDS.map(async ({ field, value }) => {
    const { value: now, etag } = await getWithEtag<unknown>(field);
    const state: FieldPlan["state"] = now == null
      ? "new"
      : now === value
      ? "already as planned"
      : "differs";
    return { field, value, etag, state };
  }));
}

async function storyHasStages(): Promise<boolean> {
  const keys = await listKeys(`levels/${LEVEL}/storyData`);
  return keys.some((k) => /^stage\d+$/.test(k));
}

/** Write the names that are not there yet. */
export async function apply(
  p: FieldPlan[],
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const todo = p.filter((f) => f.state !== "already as planned");
  if (!todo.length) return [];
  const clash = todo.find((f) => f.state === "differs");
  if (clash && !force) {
    throw new Error(
      `${dbPath(clash.field)} already holds another value; --force replaces it`,
    );
  }
  if (
    todo.some((f) => f.field.endsWith("/storyData/speaker")) &&
    !(await storyHasStages())
  ) {
    throw new Error(
      `${dbPath(`levels/${LEVEL}/storyData`)} has no stages to speak`,
    );
  }
  const written: string[] = [];
  for (const f of todo) {
    await put(f.field, f.value, { ifMatch: f.etag });
    written.push(dbPath(f.field));
  }
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return written;
}

/** Take both names out: the title reads GS again, and G tells the story. */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const read = await Promise.all(FIELDS.map(async ({ field, value }) => {
    const { value: now, etag } = await getWithEtag<unknown>(field);
    return { field, ours: now === value, now, etag };
  }));
  const present = read.filter((f) => f.now != null);
  if (!present.length) return [];
  const foreign = present.find((f) => !f.ours);
  if (foreign && !force) {
    throw new Error(
      `${dbPath(foreign.field)} holds a value this script did not write; ` +
        `--force takes it out anyway`,
    );
  }
  const removed: string[] = [];
  for (const f of present) {
    await put(f.field, null, { ifMatch: f.etag });
    removed.push(dbPath(f.field));
  }
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return removed;
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
        fields: p.map((f) => ({
          field: dbPath(f.field),
          value: f.value,
          state: f.state === "differs"
            ? "differs (--force replaces it)"
            : f.state,
        })),
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
