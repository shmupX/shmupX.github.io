// Pack the 2019 game's PS2 web build into the archive the eShop installs.
//
//   deno task 2019:zip            # from static/games/2019/level.json
//   deno task 2019:zip --fetch    # refresh that file from the cloud level first
//
// "2019" is the shooter this repo's game is a build of, imported from its web
// folder (dev-fixtures/2019-web) and exported for the PlayStation 2 as the
// cloud level 2019-PS2. The disc that export makes comes up black under Play!
// (README: AthenaEnv stalls in its HLE kernel), so what the eShop lists is the
// export's WEB BUILD — the same level the PS2 panel's PLAY WEB BUILD row and
// the PS2 shelf's WEB row play — filed on the PlayStation 2 section by its
// `shelf`, where A on it runs the version that runs.
//
// The archive is three files, not a game tree:
//
//   index.html       the 2028.Ai game page, rendered standalone
//                    (lib/game-page.ts) and stamped with the launcher marker
//   game.bundle.js   this checkout's runtime, with the one line that names the
//                    level pointed at the foo.json beside it
//   foo.json         the level record, as the editor saved it
//
// Everything else — Phaser, the plugins, the atlases, the sounds, the stage
// art — is fetched off this origin by root-relative URL, where it already is
// for /games/2028-ai; copying the 68 MB of it into Cache Storage for one more
// level would buy nothing but the download. That is also why the game page's
// own test about relative URLs (tests/super_mario_sp_test.ts) does not apply
// here: this page is only ever served from an install, never from /games/.
//
// The level is read from a committed file rather than the database at build
// time, so `deno task build` on Deploy needs no network and the same commit
// always builds the same archive. `--fetch` is how the file is refreshed after
// the level is re-exported from the editor. `frameThumbnails` — the editor's
// own preview cache, 650 KB of it — is dropped on the way; nothing the runtime
// reads is in it.

import { buildZip, type ZipEntry } from "@shmupx/shmup-harbor/zip";
import { fromFileUrl } from "@std/path";
import { injectLauncherMarker } from "../../lib/launcher-inject.ts";
import { standaloneGamePageHtml } from "../../lib/game-page.ts";

/** The cloud level the archive plays. */
export const LEVEL = "2019-PS2";
export const RTDB = "https://evil-invaders-default-rtdb.firebaseio.com";

// fromFileUrl, not .pathname: this checkout's path has a space in it.
const RECORD = fromFileUrl(
  new URL("../../static/games/2019/level.json", import.meta.url),
);
const BUNDLE = fromFileUrl(
  new URL("../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const OUT = new URL("../../static/games/2019-web.zip", import.meta.url);

// Fixed, so zipping the same inputs twice gives the same bytes.
const STAMP = new Date("2026-10-07T00:00:00Z");

/**
 * The one line of the bundle that names the level. The same anchor
 * tools/build-level/lib/stage.js patches for an exported app; both throw
 * rather than ship a bundle that plays 2028.Ai's own level when the line
 * moves.
 */
export const LEVEL_PATCH = {
  from: 'var LEVEL_DATA_URL = "/games/2028-ai/foo.json";',
  to: 'var LEVEL_DATA_URL = "foo.json";',
};

/** The bundle, reading its level from the foo.json beside the page. */
export function patchBundle(js: string): string {
  if (!js.includes(LEVEL_PATCH.from)) {
    throw new Error(
      "game.bundle.js changed: could not find " + LEVEL_PATCH.from +
        " — update LEVEL_PATCH in scripts/2019/build-zip.ts",
    );
  }
  return js.split(LEVEL_PATCH.from).join(LEVEL_PATCH.to);
}

/** The record as the archive carries it: the runtime's fields, not the editor's. */
export function slimRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...record };
  delete out.frameThumbnails;
  return out;
}

/** Pull the cloud level into static/games/2019/level.json. */
export async function fetchRecord(): Promise<Record<string, unknown>> {
  const res = await fetch(`${RTDB}/levels/${encodeURIComponent(LEVEL)}.json`);
  if (!res.ok) throw new Error(`levels/${LEVEL}: HTTP ${res.status}`);
  const record = await res.json();
  if (!record || typeof record !== "object") {
    throw new Error(`levels/${LEVEL} is not a level record`);
  }
  const slim = slimRecord(record);
  await Deno.mkdir(new URL("./", `file://${RECORD}`), { recursive: true });
  await Deno.writeTextFile(RECORD, JSON.stringify(slim) + "\n");
  return slim;
}

/** The archive's entries, sorted. */
export async function gameEntries(): Promise<ZipEntry[]> {
  const encoder = new TextEncoder();
  const record = JSON.parse(await Deno.readTextFile(RECORD));
  const html = injectLauncherMarker(
    standaloneGamePageHtml({ title: "2019", bundleSrc: "game.bundle.js" }),
  );
  const entries: ZipEntry[] = [
    {
      path: "foo.json",
      data: encoder.encode(JSON.stringify(slimRecord(record))),
    },
    {
      path: "game.bundle.js",
      data: encoder.encode(patchBundle(await Deno.readTextFile(BUNDLE))),
    },
    { path: "index.html", data: encoder.encode(html) },
  ];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

if (import.meta.main) {
  if (Deno.args.includes("--fetch")) {
    const record = await fetchRecord();
    console.log(
      `fetched levels/${LEVEL} -> ${RECORD} (${
        Object.keys(record).length
      } fields${record.stageBackgrounds ? ", with stage backgrounds" : ""})`,
    );
  }
  const entries = await gameEntries();
  const zip = await buildZip(entries, STAMP);
  await Deno.writeFile(OUT, zip);
  console.log(
    `wrote ${fromFileUrl(OUT)} (${(zip.length / 1048576).toFixed(1)} MB, ${
      entries.map((e) => e.path).join(", ")
    })`,
  );
}
