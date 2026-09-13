// Publish the Super Famicom Dezaemon library to the Firebase Realtime
// Database: the SRAM dump itself, a generated cover, and the games-db-sfc
// metadata (titleEn/titleJa, developerEn/developerJa, genre).
//
//   deno task sfc:upload                        # the whole library
//   deno task sfc:upload -- --dry-run           # decode/render/measure, write nothing
//   deno task sfc:upload -- --only "ALDI"       # substring filter on the filename
//   deno task sfc:upload -- --limit 5
//   deno task sfc:upload -- --force             # re-render covers and re-upload blobs
//   deno task sfc:upload -- --covers-only       # re-render covers, leave blobs alone
//   deno task sfc:upload -- --from "dev-fixtures/SNES Dezaemon - Kaite Tsukutte Asoberu"
//
// The Saturn publisher beside this one (upload-deza-saves.ts) is the model, and
// they share their transport (lib/rtdb-publish.ts). Four things differ, and
// each is a property of the format rather than a preference:
//
// THE BLOB IS THE FILE
// A Saturn .sav is an interleaved cart image whose every even byte is filler,
// so that one stores gzip(deinterleave(sav)) and records which filler profile
// it threw away. An SFC dump has none of that — "no header, no interleave, no
// compression, 131,072 bytes" (FORMAT-SFC.md) — so the blob is simply
// gzip(bytes) and unzips to something a parser can eat directly.
//
// RECOGNITION, NOT EXTENSION
// Both consoles' dumps get called ".sav" by somebody: this repo's own committed
// SNES fixture is dev-fixtures/debug-tools/Dez SNES.sav, and 262 Saturn carts
// share that extension. The extension therefore only decides what to LOOK at;
// isSfcSav (size plus the "T.TABATA" magic at 0x7FF8) decides what to publish,
// so pointing --from at a mixed directory skips the Saturn half rather than
// filing it under a Super Famicom slug.
//
// A DATED FILENAME IS A DUMP DATE
// The collection is named "<title> (YYYY-MM-DD).srm" — an author's build, not a
// catalogue entry — so the trailing date comes off the title and is kept as
// `dumpedAt`. Two dumps of the same game are the same game; the later one wins
// its slug, which is what makes re-dumping a work in progress an update rather
// than a second shelf row.
//
// THE COVER IS SCENERY
// composeSfcCover (packages/shmup-engine/src/sfc/cover.js) — the busiest
// screenful of the game's own stages, at the same 256x480 every Saturn cover
// uses so one shelf can show both. A cart with a blank graphics bank has no
// picture of itself and is published without one.
//
// TREE SHAPE — a sibling of /dezaemon, never mixed into it
//   /dezaemonSfc/meta           { schemaVersion, count, generatedAt, source }
//   /dezaemonSfc/index/<slug>   metadata + the idempotency ledger (no blobs)
//   /dezaemonSfc/covers/<slug>  { png: data URL, w, h, ... }
//   /dezaemonSfc/saves/<slug>   { sav: base64 gzip, ... }
// RTDB has no field projection, so the catalogue lives in its own node: one GET
// of /dezaemonSfc/index.json renders the shelf without touching the blobs.
import { encodeBase64 } from "@std/encoding/base64";
import {
  composeSfcCover,
  isSfcSav,
  parseSfcSav,
  SFC_SRAM_SIZE,
} from "../packages/shmup-engine/mod.js";
import { encodePNG } from "jsr:@img/png@^0.1.6";
import { GENRE_JA, gzip, makePut, sha256Hex } from "./lib/rtdb-publish.ts";
import {
  isSfcSaveName,
  sfcDumpDate,
  sfcFileTitle,
  sfcSlugOfFile,
} from "./lib/sfc-library.ts";

const DB = "https://evil-invaders-default-rtdb.firebaseio.com";
const ROOT = "dezaemonSfc";
const SCHEMA_VERSION = 1;
// Where the library lives in this checkout. Super Famicom dumps are community
// work like the Saturn ones and are gitignored the same way, so this is a
// default for --from rather than a directory the repo ships.
const SAVES_DIR = new URL(
  "../dev-fixtures/SNES Dezaemon - Kaite Tsukutte Asoberu/",
  import.meta.url,
);
const GAMES_DB = new URL(
  "../static/editor/dezaemon/games-db-sfc.json",
  import.meta.url,
);

// A whole SFC library is a rounding error next to the Saturn one's 46 MB — 128
// KB a cart, ~40 KB gzipped — so the shared default budget is never reached.
const put = makePut({ db: DB });

// ---------------------------------------------------------------- metadata --

// The editor's matcher, verbatim (static/editor/index.html dezaNormTitle):
// lowercase, then delete every run of characters outside [a-z0-9].
function dezaNormTitle(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type Meta = {
  title: string;
  titleJa: string | null;
  developer: string | null;
  developerJa: string | null;
  genre: string | null;
};

async function loadGamesDb() {
  const db = JSON.parse(await Deno.readTextFile(GAMES_DB)) as {
    games: (string | null)[][];
    aliases?: Record<string, string>;
  };
  const byTitle = new Map<string, Meta>();
  for (const g of db.games ?? []) {
    byTitle.set(dezaNormTitle(g[0] ?? ""), {
      title: g[0] ?? "",
      titleJa: g[1] ?? null,
      developer: g[2] ?? null,
      developerJa: g[3] ?? null,
      genre: g[4] ?? null,
    });
  }
  // A real row always wins over an alias, matching the editor's guard.
  const aliased = new Set<string>();
  for (const [from, to] of Object.entries(db.aliases ?? {})) {
    const target = byTitle.get(to);
    if (target && !byTitle.has(from)) {
      byTitle.set(from, target);
      aliased.add(from);
    }
  }
  return { byTitle, aliased };
}

// ------------------------------------------------------------------- main ---

const args = Deno.args;
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = flag("dry-run");
const force = flag("force");
// Re-render and re-upload the COVERS without touching the save blobs: a cover
// is derived from the decoders, so a decode fix can make every stored cover
// wrong while the dumps themselves stay byte-perfect.
const coversOnly = flag("covers-only");
const only = value("only");
const limit = Number(value("limit") ?? 0);

const { byTitle, aliased } = await loadGamesDb();

const savesDir = value("from")
  ? new URL(`${value("from")!.replace(/\/?$/, "/")}`, `file://${Deno.cwd()}/`)
  : SAVES_DIR;

let files: string[] = [];
try {
  for await (const e of Deno.readDir(savesDir)) {
    if (e.isFile && isSfcSaveName(e.name)) files.push(e.name);
  }
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
  console.error(
    `[sfc] no library at ${savesDir.pathname} — pass --from <dir>`,
  );
  Deno.exit(2);
}
files.sort();
if (only) {
  files = files.filter((f) => f.toLowerCase().includes(only.toLowerCase()));
}
if (limit > 0) files = files.slice(0, limit);

console.log(
  `[sfc] ${files.length} candidate(s)${
    dryRun ? " — DRY RUN, nothing is written" : ""
  }`,
);

// One cheap GET of the catalogue says what is already current. Never GET
// /dezaemonSfc/saves — that is every blob.
let existing: Record<string, Record<string, unknown>> = {};
if (!dryRun || force) {
  const res = await fetch(`${DB}/${ROOT}/index.json`);
  if (res.ok) existing = (await res.json()) ?? {};
  console.log(`[sfc] ${Object.keys(existing).length} existing index entr(ies)`);
}

let uploadedBytes = 0;
let matched = 0, aliasMatched = 0, unmatched = 0;
let coversMade = 0, coversSkipped = 0, coverless = 0;
let blobsSent = 0, blobsSkipped = 0, notSfc = 0, published = 0;
const failures: { file: string; error: string }[] = [];
const unmatchedTitles: string[] = [];
const skipped: string[] = [];
const started = Date.now();

for (const [i, file] of files.entries()) {
  const slug = sfcSlugOfFile(file);
  const fileTitle = sfcFileTitle(file);
  const label = `[${i + 1}/${files.length}] ${fileTitle}`;
  try {
    const sav = await Deno.readFile(
      new URL(encodeURIComponent(file), savesDir),
    );

    // The recognition gate. A Saturn cart, a ROM, or a truncated dump lands
    // here with the right extension and must not be published as a Super
    // Famicom game — say which file and why, and move on rather than fail the
    // run: a mixed directory is the normal case, not an error.
    if (!isSfcSav(sav)) {
      notSfc++;
      skipped.push(`${file} (${sav.length} bytes, no T.TABATA magic)`);
      console.log(`${label} — skipped: not a Dezaemon SRAM dump`);
      continue;
    }

    const savSha256 = await sha256Hex(sav);
    const prev = existing[slug] ?? {};
    const current = prev.schemaVersion === SCHEMA_VERSION &&
      prev.savSha256 === savSha256;

    // Metadata join: filename title -> games-db-sfc row (exact, then alias).
    const norm = dezaNormTitle(fileTitle);
    const meta = byTitle.get(norm);
    const matchedBy = !meta ? "none" : aliased.has(norm) ? "alias" : "exact";
    if (matchedBy === "exact") matched++;
    else if (matchedBy === "alias") aliasMatched++;
    else {
      unmatched++;
      unmatchedTitles.push(fileTitle);
    }

    const parsed = parseSfcSav(sav);

    const haveCover = current && !!prev.coverSha256 && !!prev.coverGeneratedAt;
    let cover:
      | { png: Uint8Array; w: number; h: number; stage: number; cells: number }
      | null = null;
    if (!haveCover || force || coversOnly) {
      const composed = composeSfcCover(parsed);
      if (composed) {
        // encodePNG detaches the buffer it is given, so hand it a copy.
        const png = await encodePNG(new Uint8Array(composed.rgba), {
          width: composed.w,
          height: composed.h,
          compression: 0,
          filter: 0,
          interlace: 0,
        });
        cover = {
          png,
          w: composed.w,
          h: composed.h,
          stage: composed.stage,
          cells: composed.cells,
        };
        coversMade++;
      } else {
        // A 64 KB dump or a blank graphics bank. The shelf draws its own text
        // card for a coverless row, so this is publishable, not a failure.
        coverless++;
      }
    } else coversSkipped++;

    const needBlob = (!current || force) && !coversOnly;
    let blobB64 = "", blobSha = "", blobBytes = 0;
    if (needBlob) {
      const gz = await gzip(sav);
      blobB64 = encodeBase64(gz);
      blobSha = await sha256Hex(gz);
      blobBytes = gz.length;
    }

    const coverSha = cover
      ? await sha256Hex(cover.png)
      : String(prev.coverSha256 ?? "");

    if (dryRun) {
      console.log(
        `${label} — ${matchedBy}${meta?.genre ? ` (${meta.genre})` : ""}, ` +
          `${parsed.complete ? "128K" : "64K"}, ` +
          `blob ${needBlob ? `${(blobBytes / 1024).toFixed(0)}KB` : "skip"}, ` +
          `cover ${
            cover
              ? `${(cover.png.length / 1024).toFixed(1)}KB stage ${cover.stage}`
              : haveCover
              ? "skip"
              : "none"
          }`,
      );
      published++;
      continue;
    }

    // Blob and cover first, index entry last: the index is the commit record,
    // so an interrupted run leaves an unreferenced blob rather than a
    // catalogue row pointing at something that was never written.
    if (needBlob) {
      uploadedBytes += await put(`${ROOT}/saves/${slug}`, {
        sav: blobB64,
        encoding: "gzip+base64",
        blobBytes,
        blobSha256: blobSha,
        savBytes: sav.length,
        savSha256,
        file,
      });
      blobsSent++;
    } else blobsSkipped++;

    if (cover) {
      uploadedBytes += await put(`${ROOT}/covers/${slug}`, {
        png: `data:image/png;base64,${encodeBase64(cover.png)}`,
        w: cover.w,
        h: cover.h,
        bytes: cover.png.length,
        sha256: coverSha,
        source: "scenery",
        stage: cover.stage,
        cells: cover.cells,
        generatedAt: new Date().toISOString(),
      });
    }

    uploadedBytes += await put(`${ROOT}/index/${slug}`, {
      schemaVersion: SCHEMA_VERSION,
      system: "sfc",
      slug,
      file,
      fileTitle,
      dumpedAt: sfcDumpDate(file),
      titleEn: meta?.title ?? fileTitle,
      titleJa: meta?.titleJa ?? null,
      developerEn: meta?.developer ?? null,
      developerJa: meta?.developerJa ?? null,
      genre: meta?.genre ?? null,
      genreJa: meta?.genre ? GENRE_JA[meta.genre] ?? null : null,
      metaSource: meta ? "games-db-sfc" : "filename",
      matchedBy,
      // What the parse found, so a shelf row can describe the cart without
      // fetching its blob: a 64 KB dump has no graphics bank, and stage cell
      // counts are the closest thing the format has to "how big is this game".
      savBytes: sav.length,
      savSha256,
      complete: parsed.complete,
      checkStringOk: parsed.checkStringOk,
      stageCells: (parsed.maps ?? []).map((m) => m.used),
      enemiesUsed: (parsed.enemies ?? []).filter((e) => !e.blank).length,
      graphicsTiles: parsed.graphics?.usedCount ?? 0,
      blobBytes: needBlob ? blobBytes : prev.blobBytes ?? null,
      blobSha256: needBlob ? blobSha : prev.blobSha256 ?? null,
      blobEncoding: "gzip+base64",
      hasCover: !!coverSha,
      coverW: cover?.w ?? prev.coverW ?? null,
      coverH: cover?.h ?? prev.coverH ?? null,
      coverSha256: coverSha || null,
      coverSource: cover ? "scenery" : prev.coverSource ?? null,
      coverGeneratedAt: cover
        ? new Date().toISOString()
        : prev.coverGeneratedAt ?? null,
      updatedAt: new Date().toISOString(),
    });
    published++;

    console.log(
      `${label} — ${matchedBy}, blob ${
        needBlob ? `${(blobBytes / 1024).toFixed(0)}KB` : "current"
      }, cover ${
        cover
          ? `${(cover.png.length / 1024).toFixed(1)}KB`
          : haveCover
          ? "current"
          : "none"
      }`,
    );
  } catch (e) {
    failures.push({ file, error: (e as Error).message });
    console.error(`${label} — FAILED: ${(e as Error).message}`);
  }
}

// `count` is what was PUBLISHED, not what was looked at: a directory holding
// Saturn carts too would otherwise report a library larger than the shelf.
if (!dryRun && !failures.length && !only && !limit) {
  await put(`${ROOT}/meta`, {
    schemaVersion: SCHEMA_VERSION,
    count: published,
    generatedAt: new Date().toISOString(),
    source: "Kaite Tsukutte Asoberu Dezaemon (Super Famicom) community saves",
    sramBytes: SFC_SRAM_SIZE,
  });
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n[sfc] ${files.length} candidate(s) in ${secs}s — ` +
    `${published} published, ${notSfc} not a Dezaemon dump; ` +
    `metadata: ${matched} exact + ${aliasMatched} alias, ${unmatched} title-only; ` +
    `covers: ${coversMade} rendered, ${coversSkipped} already present, ${coverless} unavailable; ` +
    `blobs: ${blobsSent} sent, ${blobsSkipped} current; ` +
    `${(uploadedBytes / 1024).toFixed(0)} KB written`,
);
if (skipped.length) console.log(`[sfc] skipped: ${skipped.join(", ")}`);
if (unmatchedTitles.length) {
  console.log(
    `[sfc] no games-db-sfc row for: ${unmatchedTitles.join(", ")} — ` +
      `add one to static/editor/dezaemon/games-db-sfc.json`,
  );
}
if (failures.length) {
  console.error(`[sfc] ${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
  Deno.exit(1);
}
