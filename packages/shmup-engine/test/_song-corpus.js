// The song corpus for the music tests: what 音まろ itself wrote.
//
//   presets  the disc's 73 sample songs, M_DATA01-73.BIN (SS-25..97 in the
//            editor), 4,228 bytes each
//   smpBgm   SMP_BGM.BIN, the bank a New Game starts with (24 slots)
//   carts    sec6 and the BGM table of every game save in the community
//            collection, dev-fixtures/Saturn/*.sav (a few carts hold more
//            than one game)
//
// All of it is disc or community content and gitignored, so every test that
// reads it is declared `ignore: !hasX()`. Run with DEZA_REQUIRE_CORPUS=1 to
// make a missing corpus a failure instead of a skip.
//
// This is kept apart from _fixtures.js on purpose: widening that file's disc
// search (it looks in dev-fixtures/.cache/<name> and top-level images only)
// would un-skip unrelated disc tests on machines that only have the
// extraction cache.

import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave, parseSectionTable } from "../src/payload-table.js";
import { decompress } from "../src/decompress.js";
import { SONG_SIZE, SONG_SLOTS } from "../src/decode/decode-song.js";
import { decodeSettings } from "../src/decode/decode-settings.js";
import { loadDiscFile } from "./_fixtures.js";

const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);
const DISC_CACHE = new URL(".cache/saturn-disc/", DEV_FIXTURES);
const CART_DIRS = [new URL("Saturn/", DEV_FIXTURES), DEV_FIXTURES];

export const PRESET_COUNT = 73;
export const REQUIRE_CORPUS = (() => {
  try {
    return Deno.env.get("DEZA_REQUIRE_CORPUS") === "1";
  } catch {
    return false;
  }
})();

function readIfPresent(url) {
  try {
    return Deno.readFileSync(url);
  } catch {
    return null;
  }
}

/** A file off the Dezaemon 2 disc: the extraction cache first, then wherever _fixtures.js looks. */
export function saturnDiscFile(name) {
  return readIfPresent(new URL(name, DISC_CACHE)) ?? loadDiscFile(name);
}

let presets;
/** [{name: "M_DATA01", ss: 25, bytes}] for every preset present, in disc order. */
export function presetSongs() {
  if (presets) return presets;
  presets = [];
  for (let i = 1; i <= PRESET_COUNT; i++) {
    const name = `M_DATA${String(i).padStart(2, "0")}`;
    const bytes = saturnDiscFile(`${name}.BIN`);
    if (bytes && bytes.length === SONG_SIZE) {
      presets.push({ name, ss: 24 + i, bytes });
    }
  }
  return presets;
}

export function hasPresetCorpus() {
  return presetSongs().length === PRESET_COUNT;
}

let smpBgm;
/** The 24 slots of SMP_BGM.BIN, or [] when it is absent. */
export function smpBgmSlots() {
  if (smpBgm) return smpBgm;
  const bank = saturnDiscFile("SMP_BGM.BIN");
  smpBgm = [];
  if (bank && bank.length === SONG_SIZE * SONG_SLOTS) {
    for (let i = 0; i < SONG_SLOTS; i++) {
      smpBgm.push(bank.slice(i * SONG_SIZE, (i + 1) * SONG_SIZE));
    }
  }
  return smpBgm;
}

export function hasSmpBgm() {
  return smpBgmSlots().length === SONG_SLOTS;
}

let carts;
/**
 * Every game save in the collection, the way disc-sample-games.test.js reads
 * one: de-interleave, BUP directory, section table, LZSS per section.
 *
 *   { file, entry, sec5, sec6, bgmTable: number[24], sfxSet, settingsAt }
 *
 * `settingsAt` is the sec5 offset of the settings block, so a test can
 * compare the raw +0x41..+0x59 bytes. Files that do not parse are skipped
 * and listed in `cartSaveErrors()`.
 */
export function cartSaves() {
  if (carts) return carts;
  carts = [];
  cartErrors = [];
  const seen = new Set();
  for (const dir of CART_DIRS) {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!e.isFile || !e.name.toLowerCase().endsWith(".sav")) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const raw = readIfPresent(new URL(encodeURIComponent(e.name), dir));
      if (!raw) continue;
      let saves;
      try {
        saves = bup.parse(deinterleave(raw)).filter(isGameSave);
      } catch (err) {
        cartErrors.push({ file: e.name, error: String(err) });
        continue;
      }
      for (const save of saves) {
        try {
          const payload = save.payload.buffer;
          const table = parseSectionTable(payload);
          const sections = table.sections.map((s) =>
            Uint8Array.from(
              decompress(payload.subarray(s.offset, s.offset + s.size)),
            )
          );
          const sec5 = sections[5];
          const sec6 = sections[6];
          if (!sec5 || !sec6 || sec6.length !== SONG_SIZE * SONG_SLOTS) {
            cartErrors.push({ file: e.name, entry: save.filename, error: "no sec5/sec6" });
            continue;
          }
          const settings = decodeSettings(sec5);
          carts.push({
            file: e.name,
            entry: save.filename,
            sec5,
            sec6,
            bgmTable: settings.bgmTable,
            sfxSet: settings.sfxSet,
            settingsAt: SETTINGS_OFFSET,
          });
        } catch (err) {
          cartErrors.push({ file: e.name, entry: save.filename, error: String(err) });
        }
      }
    }
  }
  return carts;
}

let cartErrors = [];
export function cartSaveErrors() {
  cartSaves();
  return cartErrors;
}

/** sec5 offset of the settings block (decode-stage.js SEC5_REGIONS.settings). */
export const SETTINGS_OFFSET = 0x5a780;

export function hasCartCorpus() {
  return cartSaves().length > 0;
}

/** The 24 slots of a cart's sec6 as copies. */
export function slotsOf(sec6) {
  const out = [];
  for (let i = 0; i < SONG_SLOTS; i++) {
    out.push(sec6.slice(i * SONG_SIZE, (i + 1) * SONG_SIZE));
  }
  return out;
}

/**
 * Every native song once: presets, SMP_BGM slots and cart slots, each
 * `{ where, bytes }`. Duplicates (a cart slot that is a preset) are kept, since
 * they are what each cart actually carries.
 */
export function allNativeSongs() {
  const out = [];
  for (const p of presetSongs()) out.push({ where: p.name, bytes: p.bytes });
  smpBgmSlots().forEach((bytes, i) => out.push({ where: `SMP_BGM[${i}]`, bytes }));
  for (const c of cartSaves()) {
    slotsOf(c.sec6).forEach((bytes, i) =>
      out.push({ where: `${c.file}#${c.entry}[${i}]`, bytes })
    );
  }
  return out;
}

/**
 * Throw when the corpus is required and missing. Call at the top of a gated
 * test's fn, so DEZA_REQUIRE_CORPUS=1 turns the skip into a failure (the
 * test's `ignore` is then false by way of `skipCorpus`).
 */
export function requireCorpus(has, what) {
  if (!has) throw new Error(`song corpus missing: ${what} (dev-fixtures)`);
}

/** `ignore` for a corpus test: skip when missing, unless DEZA_REQUIRE_CORPUS=1. */
export function skipCorpus(has) {
  return !has && !REQUIRE_CORPUS;
}
