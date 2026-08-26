// Publish the community Dezaemon 2 save library to the Firebase Realtime
// Database: the save itself, a generated title-screen cover, and the
// games-db metadata (titleEn/titleJa, developerEn/developerJa, genre).
//
//   deno task deza:upload                 # whole library, skipping what is current
//   deno task deza:upload -- --dry-run    # decode/render/measure, write nothing
//   deno task deza:upload -- --only "A28" # substring filter on the filename
//   deno task deza:upload -- --limit 5
//   deno task deza:upload -- --force      # re-render covers and re-upload blobs
//
// WHY THE SAVE IS STORED DEINTERLEAVED
// A .sav is a 1,114,112-byte interleaved Saturn cart image whose every even
// byte is filler. bup-source.normalize() unwraps exactly ONE layer, so
// gzip(raw .sav) would hand the editor a still-interleaved image and parse()
// would throw. Storing gzip(deinterleave(sav)) is what the editor's single
// normalize() call can actually eat — and it is 23% smaller. The filler is
// one of two fixed profiles (recorded as `interleaveProfile`), so the original
// cart image is still reconstructible byte-for-byte from what we store.
//
// TREE SHAPE
//   /dezaemon/meta           { schemaVersion, count, generatedAt }
//   /dezaemon/index/<slug>   metadata + the idempotency ledger (no blobs)
//   /dezaemon/covers/<slug>  { png: data URL, w, h, ... }
//   /dezaemon/saves/<slug>   { sav: base64 gzip, ... }
// RTDB has no field projection — reading a node returns every descendant — so
// the catalogue lives in its own node. One GET of /dezaemon/index.json renders
// the whole shelf (~120 KB) without touching the ~46 MB of save blobs.
import { encodeBase64 } from "@std/encoding/base64";
import {
  decodeSave,
  isGameSave,
  normalize,
  parse,
} from "../packages/shmup-engine/mod.js";
import { composeCover } from "./lib/deza-cover.js";
import { encodePNG } from "jsr:@img/png@^0.1.6";

const DB = "https://evil-invaders-default-rtdb.firebaseio.com";
const ROOT = "dezaemon";
const SCHEMA_VERSION = 1;
const SAVES_DIR = new URL("../static/editor/dezaemon/saves/", import.meta.url);
const GAMES_DB = new URL(
  "../static/editor/dezaemon/games-db.json",
  import.meta.url,
);

// RTDB documents a 64 MB/minute bytes-written cap. Stay well under it: the
// save blobs alone are ~46 MB, so an unthrottled run would ride the ceiling.
const WRITE_BUDGET_BYTES_PER_MIN = 36 * 1024 * 1024;

// ---------------------------------------------------------------- metadata --

// The editor's matcher, verbatim (static/editor/index.html dezaNormTitle):
// lowercase, then delete every run of characters outside [a-z0-9].
function dezaNormTitle(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Japanese genre names, mirroring DEZA_GENRE_JA in the editor. Covers all 15
// genre values games-db.json uses.
const GENRE_JA: Record<string, string> = {
  "Vertical Shoot-em-up": "縦スクロールシューティング",
  "Horizontal Shoot-em-up": "横スクロールシューティング",
  "Vertical Shoot-em-up / Danmaku": "縦スクロールシューティング／弾幕",
  "Horizontal Shoot-em-up / Danmaku": "横スクロールシューティング／弾幕",
  "Vertical Shoot-em-up / Story": "縦スクロールシューティング／ストーリー",
  "Horizontal Shoot-em-up / Story": "横スクロールシューティング／ストーリー",
  "Score Attack Vertical Shoot-em-up":
    "スコアアタック縦スクロールシューティング",
  "Score Attack Horizontal Shoot-em-up":
    "スコアアタック横スクロールシューティング",
  "Action - Shoot-em-up": "アクションシューティング",
  "Action - Racing": "アクションレーシング",
  "Action - Puzzle": "アクションパズル",
  "Action": "アクション",
  "Tool": "ツール",
  "Movie": "ムービー",
  "Avant-Garde Art": "前衛アート",
};

// Extra normalized-key -> normalized-key aliases, on top of the four that ship
// in games-db.json. Every one is a version/mode/stage variant or a parenthetical
// of a row that already exists (six are byte-identical payloads), so each is a
// safe join and none collides with a real row. Kept here rather than in
// games-db.json, which is a verbatim upstream copy.
//
// Deliberately NOT aliased, because each is a genuinely different game that
// merely shares a prefix: SIMPLE1500 Shinkaisokudo, Gamsahra 4, Mix-up
// Paradise, Skullave Gaiden ver.L/M/N, Hurricane SP, NS Maze C.U.
const EXTRA_ALIASES: Record<string, string> = {
  "chohparody": "chohparodyspirittwin",
  "laireii": "laireiihybridstyle",
  "novarevival": "lemurealnovarevival12alicia",
  "devildimensionkaruka": "devildimensionkakukai2",
  "devildimensionkakukai2backstage": "devildimensionkakukai2",
  "devildimensionkakukai2frontstage": "devildimensionkakukai2",
  "chohparodyspirittwinexsoundver": "chohparodyspirittwin",
  "shinjashintenseiexsoundver": "shinjashintensei",
  "daiohthehyperstorm2018ver": "daiohthehyperstorm",
  "cosmolightcruiseroyodoblaster": "cosmolightcruiseroyodo",
  "cosmolightcruiseroyodomild": "cosmolightcruiseroyodo",
};

type Meta = {
  title: string;
  titleJa: string;
  developer: string;
  developerJa: string;
  genre: string;
};

async function loadGamesDb() {
  const db = JSON.parse(await Deno.readTextFile(GAMES_DB)) as {
    games: string[][];
    aliases?: Record<string, string>;
  };
  const byTitle = new Map<string, Meta>();
  for (const g of db.games ?? []) {
    byTitle.set(dezaNormTitle(g[0]), {
      title: g[0],
      titleJa: g[1],
      developer: g[2],
      developerJa: g[3],
      genre: g[4],
    });
  }
  // A real row always wins over an alias, matching the editor's guard.
  const aliased = new Set<string>();
  for (
    const [from, to] of [
      ...Object.entries(db.aliases ?? {}),
      ...Object.entries(EXTRA_ALIASES),
    ]
  ) {
    const target = byTitle.get(to);
    if (target && !byTitle.has(from)) {
      byTitle.set(from, target);
      aliased.add(from);
    }
  }
  return { byTitle, aliased };
}

// "Dez 2 - Air Streamer -Ver.A-.sav" -> "Air Streamer -Ver.A-"
function fileTitleOf(file: string): string {
  return file.replace(/\.(sav|bcr|bkr)$/i, "").replace(/^Dez 2 - /, "");
}

// Key on the FILE, not the title: five games-db rows are shared by two files
// each, so titles are not unique but filenames are. Verified collision-free
// across all 258, and it strips the characters RTDB keys cannot carry.
function slugOf(file: string): string {
  const s = fileTitleOf(file).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "save";
}

// ------------------------------------------------------------------ binary --

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The even bytes of the cart image are filler. Exactly two profiles occur
// across the library; recording which one lets the original .sav be rebuilt
// byte-for-byte from the deinterleaved half we store.
function interleaveProfile(sav: Uint8Array): string | null {
  let ff = true;
  let ffThen00 = true;
  for (let i = 0; i < sav.length; i += 2) {
    const b = sav[i];
    if (b !== 0xff) ff = false;
    if (b !== (i < 0x10000 ? 0xff : 0x00)) ffThen00 = false;
    if (!ff && !ffThen00) return null;
  }
  return ff ? "ff" : ffThen00 ? "ff64k-then-00" : null;
}

function deinterleave(sav: Uint8Array): Uint8Array {
  const out = new Uint8Array(sav.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = sav[i * 2 + 1];
  return out;
}

// --------------------------------------------------------------- transport --

let writtenWindow: { at: number; bytes: number }[] = [];

async function throttle(nextBytes: number) {
  for (;;) {
    const cutoff = Date.now() - 60_000;
    writtenWindow = writtenWindow.filter((w) => w.at > cutoff);
    const inWindow = writtenWindow.reduce((n, w) => n + w.bytes, 0);
    if (inWindow + nextBytes <= WRITE_BUDGET_BYTES_PER_MIN) return;
    const oldest = writtenWindow[0];
    const waitMs = Math.max(250, oldest.at + 60_000 - Date.now());
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 5_000)));
  }
}

// print=silent matters: without it RTDB echoes every written value back, which
// would burn tens of MB of the project's monthly download quota for nothing.
async function put(path: string, value: unknown): Promise<number> {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body).length;
  await throttle(bytes);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${DB}/${path}.json?print=silent`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) {
        await res.body?.cancel();
        writtenWindow.push({ at: Date.now(), bytes });
        return bytes;
      }
      const text = (await res.text()).slice(0, 300);
      if (attempt === 4) throw new Error(`HTTP ${res.status}: ${text}`);
      console.warn(`  ! ${path} HTTP ${res.status} — retry ${attempt}/3`);
    } catch (e) {
      if (attempt === 4) throw e;
      console.warn(`  ! ${path} ${(e as Error).message} — retry ${attempt}/3`);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return bytes;
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
const only = value("only");
const limit = Number(value("limit") ?? 0);

const { byTitle, aliased } = await loadGamesDb();

let files: string[] = [];
for await (const e of Deno.readDir(SAVES_DIR)) {
  if (e.isFile && /\.(sav|bcr|bkr)$/i.test(e.name)) files.push(e.name);
}
files.sort();
if (only) {
  files = files.filter((f) => f.toLowerCase().includes(only.toLowerCase()));
}
if (limit > 0) files = files.slice(0, limit);

console.log(
  `[deza] ${files.length} save(s)${
    dryRun ? " — DRY RUN, nothing is written" : ""
  }`,
);

// One cheap GET of the catalogue tells us what is already current. Never GET
// /dezaemon/saves — that is the whole 46 MB.
let existing: Record<string, Record<string, unknown>> = {};
if (!dryRun || force) {
  const res = await fetch(`${DB}/${ROOT}/index.json`);
  if (res.ok) existing = (await res.json()) ?? {};
  console.log(
    `[deza] ${Object.keys(existing).length} existing index entr(ies)`,
  );
}

let uploadedBytes = 0;
let matched = 0, aliasMatched = 0, unmatched = 0;
let coversMade = 0, coversSkipped = 0, blobsSent = 0, blobsSkipped = 0;
const failures: { file: string; error: string }[] = [];
const unmatchedTitles: string[] = [];
const started = Date.now();

for (const [i, file] of files.entries()) {
  const slug = slugOf(file);
  const fileTitle = fileTitleOf(file);
  const label = `[${i + 1}/${files.length}] ${fileTitle}`;
  try {
    const sav = await Deno.readFile(new URL(file, SAVES_DIR));
    const savSha256 = await sha256Hex(sav);
    const prev = existing[slug] ?? {};
    const current = prev.schemaVersion === SCHEMA_VERSION &&
      prev.savSha256 === savSha256;

    // Metadata join: filename title -> games-db row (exact, then alias).
    const norm = dezaNormTitle(fileTitle);
    const meta = byTitle.get(norm);
    const matchedBy = !meta ? "none" : aliased.has(norm) ? "alias" : "exact";
    if (matchedBy === "exact") matched++;
    else if (matchedBy === "alias") aliasMatched++;
    else {
      unmatched++;
      unmatchedTitles.push(fileTitle);
    }

    // Cover: only rendered when one does not already exist (or --force).
    const haveCover = current && !!prev.coverSha256 && !!prev.coverGeneratedAt;
    let cover:
      | { png: Uint8Array; w: number; h: number; source: string }
      | null = null;
    if (!haveCover || force) {
      const { data } = await normalize(sav);
      const entry = parse(data).filter(isGameSave)[0];
      if (!entry?.payload) {
        throw new Error("no readable DEZA2____NN game entry in this image");
      }
      const decoded = decodeSave(entry.payload.buffer);
      const composed = composeCover(decoded);
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
        source: composed.hasTitleArt ? "titleArt" : "fallback",
      };
      coversMade++;
    } else coversSkipped++;

    // Save blob: gzip of the deinterleaved image (see header).
    const profile = interleaveProfile(sav);
    const needBlob = !current || force;
    let blobB64 = "", blobSha = "", blobBytes = 0;
    if (needBlob) {
      const gz = await gzip(deinterleave(sav));
      blobB64 = encodeBase64(gz);
      blobSha = await sha256Hex(gz);
      blobBytes = gz.length;
    }

    const coverSha = cover
      ? await sha256Hex(cover.png)
      : String(prev.coverSha256 ?? "");
    const coverB64 = cover ? encodeBase64(cover.png) : "";

    if (dryRun) {
      console.log(
        `${label} — ${matchedBy}${meta ? ` (${meta.genre})` : ""}, ` +
          `blob ${needBlob ? `${(blobBytes / 1024).toFixed(0)}KB` : "skip"}, ` +
          `cover ${
            cover ? `${(cover.png.length / 1024).toFixed(1)}KB` : "skip"
          }`,
      );
      continue;
    }

    // Blob and cover first, index entry last: the index is the commit record,
    // so an interrupted run leaves an unreferenced blob rather than a
    // catalogue row pointing at something that was never written.
    if (needBlob) {
      uploadedBytes += await put(`${ROOT}/saves/${slug}`, {
        sav: blobB64,
        encoding: "gzip+base64",
        interleaveProfile: profile,
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
        png: `data:image/png;base64,${coverB64}`,
        w: cover.w,
        h: cover.h,
        bytes: cover.png.length,
        sha256: coverSha,
        source: cover.source,
        generatedAt: new Date().toISOString(),
      });
    }

    uploadedBytes += await put(`${ROOT}/index/${slug}`, {
      schemaVersion: SCHEMA_VERSION,
      slug,
      file,
      fileTitle,
      titleEn: meta?.title ?? fileTitle,
      titleJa: meta?.titleJa ?? null,
      developerEn: meta?.developer ?? null,
      developerJa: meta?.developerJa ?? null,
      genre: meta?.genre ?? null,
      genreJa: meta?.genre ? GENRE_JA[meta.genre] ?? null : null,
      metaSource: meta ? "games-db" : "filename",
      matchedBy,
      savBytes: sav.length,
      savSha256,
      blobBytes: needBlob ? blobBytes : prev.blobBytes ?? null,
      blobSha256: needBlob ? blobSha : prev.blobSha256 ?? null,
      blobEncoding: "gzip+base64",
      interleaveProfile: profile,
      hasCover: true,
      coverW: cover?.w ?? prev.coverW ?? null,
      coverH: cover?.h ?? prev.coverH ?? null,
      coverSha256: coverSha || null,
      coverSource: cover?.source ?? prev.coverSource ?? null,
      coverGeneratedAt: cover
        ? new Date().toISOString()
        : prev.coverGeneratedAt ?? null,
      updatedAt: new Date().toISOString(),
    });

    console.log(
      `${label} — ${matchedBy}, blob ${
        needBlob ? `${(blobBytes / 1024).toFixed(0)}KB` : "current"
      }` +
        `, cover ${
          cover ? `${(cover.png.length / 1024).toFixed(1)}KB` : "current"
        }`,
    );
  } catch (e) {
    failures.push({ file, error: (e as Error).message });
    console.error(`${label} — FAILED: ${(e as Error).message}`);
  }
}

if (!dryRun && !failures.length && !only && !limit) {
  await put(`${ROOT}/meta`, {
    schemaVersion: SCHEMA_VERSION,
    count: files.length,
    generatedAt: new Date().toISOString(),
    source: "Dezaemon 2 (Saturn) community saves",
  });
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n[deza] ${files.length} save(s) in ${secs}s — ` +
    `metadata: ${matched} exact + ${aliasMatched} alias, ${unmatched} title-only; ` +
    `covers: ${coversMade} rendered, ${coversSkipped} already present; ` +
    `blobs: ${blobsSent} sent, ${blobsSkipped} current; ` +
    `${(uploadedBytes / 1024 / 1024).toFixed(1)} MB written`,
);
if (unmatchedTitles.length) {
  console.log(`[deza] no games-db row for: ${unmatchedTitles.join(", ")}`);
}
if (failures.length) {
  console.error(`[deza] ${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
  Deno.exit(1);
}
