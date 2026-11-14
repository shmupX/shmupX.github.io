#!/usr/bin/env -S deno run -A --node-modules-dir=none
/**
 * Give 2028.Ai's database record its recorded soundtrack in place of the
 * tone-bank one.
 *
 *   deno task 2028-ai:stage-bgm              # dry run
 *   deno task 2028-ai:stage-bgm --apply
 *   deno task 2028-ai:stage-bgm --revert
 *
 * shmupX/levels/foo carried `dezaemonBgm`: a 21-minute recording transcribed
 * onto the Dezaemon 2 tone bank, 21 songs played as one piece across the
 * stages, the first of them at the title (README-Technical, "A soundtrack off
 * the tone bank"). Its music is a recording again, in three cuts the runtime
 * picks between by a stage's length (game.bundle.js `stageBgmTrack`):
 * SOUNDTRACK below, the same entries static/games/2028-ai/foo.json carries
 * for a plain visit (tests/stage_bgm_by_length_test.ts holds the two
 * together).
 *
 * What --apply writes to the record (mcp/lib/rtdb.ts roots the path under
 * shmupX/; cmg's root-level copy is never touched):
 *
 * - `customAudioURLs`, with SOUNDTRACK's entries laid over what is there.
 *   Its other entries, the two voices, are kept;
 * - `dezaemonBgm`, removed. A level that carries one plays it and never its
 *   recording (GameScene's playBossBgm), so the two cannot stand together;
 * - `savedAt`, as every edit of a level does.
 *
 * Without --apply nothing is written: the dry run says what the record holds
 * now. Each field is written under the ETag it was read with, so a save that
 * raced this one is refused. --apply removes only the soundtrack kept beside
 * this script (bgm/foo-tone-bank.json, as the record carried it on
 * 2026-11-12) and refuses another, since --revert could not put that one
 * back; --force removes it anyway. Run again, it writes nothing.
 *
 * --revert puts the kept soundtrack back and takes SOUNDTRACK's entries out
 * of `customAudioURLs` (an entry someone has since pointed elsewhere is left
 * alone). It is what a Saturn cart of the game needs first: build:sav writes
 * a cart's music from `dezaemonBgm`, and a cart cannot play a recording.
 */

import { dbPath, getWithEtag, put } from "../../mcp/lib/rtdb.ts";

/** The record: 2028.Ai's own game. */
export const LEVEL = "foo";

const CUT = (minutes: 1 | 2 | 4) => `https://easierbycode.com/${minutes}.mp3`;

/**
 * 2028.Ai's music, as its `customAudioURLs` names it.
 *
 * `stage_bgm` is every stage's track and `stage_bgm_<N>min` the cut for a
 * stage that runs N minutes or longer. The five stage themes name the first
 * cut too, for what reads a level's music by its boss: the exporters, and a
 * runtime from before the stage tracks. `title_bgm` is the title's, the
 * four-minute cut. The hidden boss's theme is Diamond Eyes, a track of its
 * own, whatever the stage's length.
 * `boss2_bgm` is the fight with the third boss, from his arrival, and
 * `stage4_bgm` the secret stage's own track, the two-minute cut, whatever its
 * length (the stage after the fourth, reached by finishing every boss with
 * the CA bomb and no continue). `stage5_bgm` is the bonus stage's, RonaGun's
 * stage after the secret one, on Diamond Eyes as well.
 */
export const SOUNDTRACK: Readonly<Record<string, string>> = {
  boss2_bgm: "https://easierbycode.com/boss.mp3",
  boss_barlog_bgm: CUT(1),
  boss_bison_bgm: CUT(1),
  boss_fang_bgm: CUT(1),
  boss_goki_bgm: "https://easierbycode.com/diamond-eyes.mp3",
  boss_sagat_bgm: CUT(1),
  boss_vega_bgm: CUT(1),
  stage4_bgm: CUT(2),
  stage5_bgm: "https://easierbycode.com/diamond-eyes.mp3",
  stage_bgm: CUT(1),
  stage_bgm_2min: CUT(2),
  stage_bgm_4min: CUT(4),
  title_bgm: CUT(4),
};

/** The tone-bank soundtrack the record carried, for --revert. */
export const TONE_BANK = new URL("./bgm/foo-tone-bank.json", import.meta.url);

const LARGE_TIMEOUT_MS = 120_000;

const audioField = `levels/${LEVEL}/customAudioURLs`;
const bgmField = `levels/${LEVEL}/dezaemonBgm`;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Urls = Record<string, string>;

export async function toneBank(): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(TONE_BANK));
}

/** One spelling for a JSON value, whatever order its keys came in. */
function canonical(value: Json | undefined): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${
    Object.keys(value).sort().map((k) =>
      `${JSON.stringify(k)}:${canonical(value[k])}`
    ).join(",")
  }}`;
}

/** What the record's music is now. */
export type State =
  | "the tone-bank soundtrack"
  | "already as planned"
  | "another tone-bank soundtrack"
  | "no soundtrack";

export interface Plan {
  state: State;
  /** `customAudioURLs` as read, and the ETag it was read with. */
  urls: Urls;
  urlsEtag: string | null;
  /** `customAudioURLs` as --apply leaves it. */
  planned: Urls;
  /** SOUNDTRACK's keys the record does not name as planned yet. */
  missing: string[];
  /** Whether the record carries a `dezaemonBgm`, and its ETag. */
  hasToneBank: boolean;
  bgmEtag: string | null;
}

/** What --apply would write. Writes nothing. */
export async function plan(): Promise<Plan> {
  const [audio, bgm, kept] = await Promise.all([
    getWithEtag<Urls>(audioField),
    getWithEtag<Json>(bgmField, { timeoutMs: LARGE_TIMEOUT_MS }),
    toneBank(),
  ]);
  const urls = audio.value && typeof audio.value === "object"
    ? audio.value
    : {};
  const planned = { ...urls, ...SOUNDTRACK };
  const missing = Object.keys(SOUNDTRACK).filter((k) =>
    urls[k] !== SOUNDTRACK[k]
  );
  const hasToneBank = bgm.value != null;
  const state: State = !hasToneBank
    ? (missing.length ? "no soundtrack" : "already as planned")
    : canonical(bgm.value) === canonical(kept)
    ? "the tone-bank soundtrack"
    : "another tone-bank soundtrack";
  return {
    state,
    urls,
    urlsEtag: audio.etag,
    planned,
    missing,
    hasToneBank,
    bgmEtag: bgm.etag,
  };
}

/** Write the recorded soundtrack in. Returns the fields written. */
export async function apply(
  p: Plan,
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  if (p.state === "already as planned") return [];
  if (p.state === "another tone-bank soundtrack" && !force) {
    throw new Error(
      `${
        dbPath(bgmField)
      } is not the soundtrack kept in bgm/foo-tone-bank.json, ` +
        `so --revert could not put it back; --force removes it anyway`,
    );
  }
  const written: string[] = [];
  if (p.missing.length) {
    await put(audioField, p.planned, { ifMatch: p.urlsEtag });
    written.push(dbPath(audioField));
  }
  if (p.hasToneBank) {
    await put(bgmField, null, {
      ifMatch: p.bgmEtag,
      timeoutMs: LARGE_TIMEOUT_MS,
    });
    written.push(dbPath(bgmField));
  }
  await put(`levels/${LEVEL}/savedAt`, Date.now());
  return written;
}

/** Put the tone-bank soundtrack back. Returns the fields written. */
export async function revert(
  { force = false }: { force?: boolean } = {},
): Promise<string[]> {
  const p = await plan();
  if (p.state === "another tone-bank soundtrack" && !force) {
    throw new Error(
      `${dbPath(bgmField)} holds a soundtrack this script did not remove; ` +
        `--force writes the kept one over it`,
    );
  }
  const written: string[] = [];
  const urls: Urls = { ...p.urls };
  let taken = 0;
  for (const key of Object.keys(SOUNDTRACK)) {
    if (urls[key] !== SOUNDTRACK[key]) continue;
    delete urls[key];
    taken++;
  }
  if (taken) {
    // An empty map is no node at all in this database.
    await put(audioField, Object.keys(urls).length ? urls : null, {
      ifMatch: p.urlsEtag,
    });
    written.push(dbPath(audioField));
  }
  if (p.state !== "the tone-bank soundtrack") {
    await put(bgmField, await toneBank(), {
      ifMatch: p.bgmEtag,
      timeoutMs: LARGE_TIMEOUT_MS,
    });
    written.push(dbPath(bgmField));
  }
  if (written.length) await put(`levels/${LEVEL}/savedAt`, Date.now());
  return written;
}

if (import.meta.main) {
  const force = Deno.args.includes("--force");
  if (Deno.args.includes("--revert")) {
    console.log(JSON.stringify({ reverted: await revert({ force }) }, null, 2));
  } else {
    const p = await plan();
    console.log(JSON.stringify(
      {
        record: dbPath(`levels/${LEVEL}`),
        state: p.state === "another tone-bank soundtrack"
          ? `${p.state} (--force removes it anyway)`
          : p.state,
        dezaemonBgm: p.hasToneBank ? "present, to remove" : "absent",
        customAudioURLs: { now: p.urls, toSet: p.missing },
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
