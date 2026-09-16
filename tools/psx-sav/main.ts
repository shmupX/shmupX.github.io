// tools/psx-sav — look inside a PlayStation Dezaemon save (Dezaemon+ or
// Dezaemon Kids!): a memory-card image, a DexDrive .gme, a single-save .mcs,
// a PS3 .psv, or the bare save blocks.
//
//   deno task psx:probe report <sav>
//   deno task psx:probe png <sav> icon|graphics|palettes|map|cells --out <path>
//                             [--stage N] [--page N] [--row N] [--scale N] [--rows N]
//   deno task psx:probe hex <sav> --range A:B [--section header|graphics|data|tail]
//   deno task psx:probe diff <a.sav> <b.sav>
//   deno task psx:probe all <sav> --out <dir>
//   deno task psx:probe edit <sav> --out <path> [--set <field>=<value>]...
//
// The parser is packages/shmup-engine/src/psx/ and the notes are FORMAT-PSX.md.
// Both games' maps render as the real thing: a Kids! stage is 7 chips of 32x32
// px drawn from the save's CG cells through the disc's fixed palette bank, and
// a Dezaemon+ stage is 16 chips of 16x16 px drawn through the stage's MAP
// GROUP table into the save's own 4bpp graphics bank and palette row.
//
// `edit` is the only verb that writes, and each --set goes through exactly one
// setter — src/psx/plus-edit.js for Dezaemon+, src/psx/kids-edit.js for Kids!.
// What "surgical" costs differs by game, because the two formats derive
// different things. A Dezaemon+ save is raw, so an N-byte edit writes N + 2
// bytes per checksum group it dirties and nothing else moves. A Kids! save
// keeps its graphics and data LZSS-packed, so a section the edit touches is
// RECOMPRESSED with src/compress.js, which is not the encoder KIDS.EXE used:
// measured here over the 77 community Kids! saves, 0 recompress byte-identically
// and the two sections together come back a mean 796 bytes larger. An untouched
// section is copied verbatim, which is what keeps an edit-nothing round trip
// byte-identical. It never writes over its input. Saves are community content
// and are never committed.

import { basename, dirname, resolve } from "@std/path";
import {
  coalesceDiffRanges,
  totalDiffBytes,
} from "../../packages/shmup-engine/src/diff-ranges.js";
import { rgb555ToRgb } from "../../packages/shmup-engine/src/decode/decode-cg.js";
import {
  copyPlusSong,
  decodeKidsChip,
  decodePlusAppear,
  decodePlusEnemyData,
  decodePlusMapGroup,
  decodeShiftJis,
  editKidsSave,
  GME_HEADER_SIZE,
  isPlusBlock,
  KIDS_ALL_CLEAR,
  KIDS_BLOCK_SIZE,
  KIDS_CHIP_DIM,
  KIDS_FIRST_SECTION,
  KIDS_MAP_COLUMNS,
  KIDS_MAP_ROWS,
  KIDS_REGIONS,
  KIDS_TAIL_SIZE,
  kidsCell,
  kidsDisplayName,
  kidsPalette,
  kidsScoreName,
  MCS_HEADER_SIZE,
  narrow,
  parseKidsTable,
  parsePsxSav,
  placeKidsSave,
  placePlusSave,
  PLUS_BLOCK_SIZE,
  PLUS_CHIP_DIM,
  PLUS_GRAPHICS_WIDTH,
  PLUS_MAP_COLUMNS,
  PLUS_MAP_ROWS,
  PLUS_MENU_BGM_OFF,
  PLUS_REGIONS,
  PLUS_STAGE_LAYOUT,
  PLUS_UNSEALED_GROUP,
  PLUS_UNSEALED_OFFSET,
  plusChecksums,
  plusEntryAt,
  plusGroupRegions,
  plusPaletteRow,
  PSX_GAMES,
  sealPlusChecksums,
  setKidsGameName,
  setKidsHiScore,
  setPlusBgmSlot,
  setPlusChargeTime,
  setPlusCursorSpeed,
  setPlusHiScore,
  setPlusItemSlot,
  setPlusKeyConfig,
  setPlusMenuBgm,
  setPlusScoreBonus,
  setPlusStageCount,
  setPlusStereo,
  summarizePsxSav,
  validateKidsTable,
} from "../../packages/shmup-engine/src/psx/index.js";
import { encodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const USAGE = `usage:
  psx:probe report <sav>
  psx:probe png <sav> icon|graphics|palettes|map|cells --out <path>
                      [--stage N] [--page N] [--row N] [--scale N] [--rows N]
  psx:probe hex <sav> --range A:B [--section header|graphics|data|tail]
  psx:probe diff <a.sav> <b.sav>
  psx:probe all <sav> --out <dir>
  psx:probe edit <sav> --out <path> [--set <field>=<value>]... [--force]

  --stage   stage for map renders (default 0)
  --page    Kids! CG page for graphics renders (default: all four side by side)
  --row     Dezaemon+ palette row for graphics renders (default: the map's own)
  --rows    map rows to draw (default: all of them)
  --scale   integer upscale (default 1; icons default to 8)
  --range   offsets, half-open, e.g. 0x10100:0x10400
  --section which part of a Kids! save --range addresses (default header, the
            raw file; graphics and data are the decompressed sections)
  --set     a field to write, from the set the save's own game has; repeats,
            applied in order (edit). An unknown field prints that set
  --force   edit a save whose checksums already fail, or a Dezaemon+ one
            carrying no "SC" frame (edit)`;

const args = [...Deno.args];
const command = args.shift();
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const VALUE_FLAGS = new Set([
  "--out",
  "--stage",
  "--page",
  "--row",
  "--scale",
  "--range",
  "--rows",
  "--section",
]);
/** Flags that may be given more than once; their values collect in order. */
const REPEATED_FLAGS = new Set(["--set"]);
const flags: Record<string, string | true> = {};
const repeated: Record<string, string[]> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg) || REPEATED_FLAGS.has(arg)) {
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    if (REPEATED_FLAGS.has(arg)) (repeated[arg] ??= []).push(value);
    else flags[arg] = value;
  } else if (arg.startsWith("--")) flags[arg] = true;
  else positional.push(arg);
}

function need(flag: string): string {
  const v = flags[flag];
  if (typeof v !== "string") fail(`${flag} is required\n\n${USAGE}`);
  return v;
}

function intFlag(flag: string, fallback: number): number {
  const v = flags[flag];
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${flag} wants a non-negative integer`);
  }
  return n;
}

function hex(n: number, width = 5): string {
  return "0x" + n.toString(16).padStart(width, "0");
}

async function write(path: string, bytes: Uint8Array) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
}

/**
 * Whether two paths name ONE file — what `edit` asks before it writes.
 *
 * resolve() alone is not that question. It is pure string arithmetic: it
 * collapses ".." and makes a path absolute without ever reading the
 * filesystem, so it folds neither case nor symlinks. Both holes were
 * reproduced on this machine against a card built by buildPlusBlock/buildCard:
 * `--out ORIG.MCR` for Orig.mcr compared unequal on case-insensitive APFS and
 * left ONE file on disk — the input, overwritten — and an --out symlink
 * pointing back at the input was followed by write() onto the input. What that
 * destroys is the before-image the whole diff workflow rests on (README.md),
 * and a community save has no committed copy to restore from.
 *
 * dev+ino is what the kernel calls identity, so it survives every spelling and
 * closes hardlinks too. statSync, never lstatSync: it must follow a symlink
 * because Deno.writeFile does. A stat that throws means --out names nothing
 * yet and so cannot BE the input, but the canonical directory is then still
 * worth comparing — realPathSync resolves a symlinked or case-different parent
 * that resolve() would miss — and the string compare stays for an --out whose
 * directory does not exist either, which write() is about to mkdir.
 */
function sameFile(out: string, path: string): boolean {
  try {
    const a = Deno.statSync(out);
    const b = Deno.statSync(path);
    if (a.ino !== null && b.ino !== null) {
      return a.dev === b.dev && a.ino === b.ino;
    }
  } catch {
    // --out does not exist (or cannot be stat'd); fall through.
  }
  try {
    return resolve(Deno.realPathSync(dirname(out)), basename(out)) ===
      resolve(Deno.realPathSync(dirname(path)), basename(path));
  } catch {
    return resolve(out) === resolve(path);
  }
}

// deno-lint-ignore no-explicit-any
type Save = any;
interface Parsed {
  container: string;
  card:
    | {
      files: { filename: string; data: Uint8Array }[];
      freeBlocks: number;
    }
    | null;
  saves: Save[];
  others: { filename: string; size: number }[];
  errors: { block: string; message: string }[];
}

function load(
  path: string | undefined,
): {
  path: string;
  parsed: Parsed;
  save: Save;
  bytes: Uint8Array;
  block: Uint8Array;
} {
  if (!path) fail(`name a save file\n\n${USAGE}`);
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(path);
  } catch (err) {
    return fail(`cannot read ${path}: ${(err as Error).message}`);
  }
  const parsed = parsePsxSav(bytes) as unknown as Parsed;
  if (parsed.saves.length === 0) {
    fail(
      `${path}: no Dezaemon+ or Dezaemon Kids! save found (${parsed.container}${
        parsed.errors.map((e) => `; ${e.message}`).join("")
      })`,
    );
  }
  return {
    path,
    parsed,
    save: parsed.saves[0],
    bytes,
    block: blockOf(bytes, parsed),
  };
}

/**
 * The save's bytes for READING. For a card and a .gme this is the copy
 * parseMemoryCard joined out of the chained blocks (memcard.js:161-172), not a
 * view of the file: writing through it edits nothing. `edit` uses
 * editableBlock() instead.
 */
function blockOf(bytes: Uint8Array, parsed: Parsed): Uint8Array {
  if (parsed.card) {
    const file = parsed.card.files.find((f) =>
      f.filename === parsed.saves[0].filename
    );
    if (file) return file.data;
  }
  if (parsed.container === "mcs") return bytes.subarray(0x80);
  if (parsed.container === "psv") return bytes.subarray(0x84);
  return bytes;
}

// --- rasters ------------------------------------------------------------------

type Rgba = [number, number, number, number];

function put(r: Raster, x: number, y: number, c: Rgba) {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const o = (y * r.width + x) * 4;
  r.data[o] = c[0];
  r.data[o + 1] = c[1];
  r.data[o + 2] = c[2];
  r.data[o + 3] = c[3];
}

function fill(
  r: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  c: Rgba,
) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) put(r, x, y, c);
  }
}

function upscale(r: Raster, scale: number): Raster {
  if (scale <= 1) return r;
  const out = newRaster(r.width * scale, r.height * scale);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (((y / scale) | 0) * r.width + ((x / scale) | 0)) * 4;
      const d = (y * out.width + x) * 4;
      out.data[d] = r.data[s];
      out.data[d + 1] = r.data[s + 1];
      out.data[d + 2] = r.data[s + 2];
      out.data[d + 3] = r.data[s + 3];
    }
  }
  return out;
}

function rgbaOf(word: number, alpha = 255): Rgba {
  const { r, g, b } = rgb555ToRgb(word);
  return [r, g, b, alpha];
}

function renderIcon(save: Save): Raster {
  const header = save.header;
  const frames = header.icons.length || 1;
  const out = newRaster(16 * frames, 16);
  header.icons.forEach((icon: Uint8Array, f: number) => {
    for (let i = 0; i < 256; i++) {
      const v = icon[i];
      put(
        out,
        f * 16 + (i % 16),
        (i / 16) | 0,
        v === 0 ? [0, 0, 0, 0] : rgbaOf(header.clut[v]),
      );
    }
  });
  return out;
}

// --- Dezaemon Kids! -----------------------------------------------------------

function kidsRgba(backdrop = false): Rgba[] {
  return kidsPalette({ backdrop }).map((
    c: { r: number; g: number; b: number; raw: number },
    i: number,
  ) =>
    i === 0 && !backdrop ? [0, 0, 0, 0] as Rgba : [c.r, c.g, c.b, 255] as Rgba
  );
}

/** One 32x32 chip of a Kids! map, drawn from its four CG cells. */
function drawKidsChip(
  out: Raster,
  graphics: Uint8Array,
  pal: Rgba[],
  word: number,
  x0: number,
  y0: number,
) {
  const chip = decodeKidsChip(word);
  if (chip.blank) return;
  const quads = [[0, 0], [16, 0], [0, 16], [16, 16]];
  chip.cells.forEach((cell: number, q: number) => {
    if (cell >= 1024) return;
    const bytes = kidsCell(graphics, cell);
    const [qx, qy] = quads[q];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = bytes[y * 16 + x];
        if (v === 0) continue;
        let sx = qx + x;
        let sy = qy + y;
        if (chip.hflip) sx = KIDS_CHIP_DIM - 1 - sx;
        if (chip.vflip) sy = KIDS_CHIP_DIM - 1 - sy;
        put(out, x0 + sx, y0 + sy, pal[v]);
      }
    }
  });
}

function renderKidsMap(save: Save, stage: number, maxRows: number): Raster {
  const map = save.map?.[stage];
  if (!map) fail(`no stage ${stage}`);
  const rows = Math.min(maxRows || KIDS_MAP_ROWS, KIDS_MAP_ROWS);
  const out = newRaster(KIDS_MAP_COLUMNS * KIDS_CHIP_DIM, rows * KIDS_CHIP_DIM);
  fill(out, 0, 0, out.width, out.height, [0, 0, 0, 255]);
  const pal = kidsRgba(false);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < KIDS_MAP_COLUMNS; c++) {
      drawKidsChip(
        out,
        save.graphics,
        pal,
        map.words[r * KIDS_MAP_COLUMNS + c],
        c * KIDS_CHIP_DIM,
        r * KIDS_CHIP_DIM,
      );
    }
  }
  return out;
}

function renderKidsCells(save: Save): Raster {
  const pages: Uint8Array[] = save.pages;
  const which = typeof flags["--page"] === "string"
    ? [intFlag("--page", 0)]
    : [0, 1, 2, 3];
  const pal = kidsRgba(false);
  const out = newRaster(128 * which.length, 512);
  fill(out, 0, 0, out.width, out.height, [0, 0, 0, 255]);
  which.forEach((p, k) => {
    const page = pages[p];
    if (!page) fail(`no CG page ${p}`);
    for (let i = 0; i < page.length; i++) {
      const v = page[i];
      if (v === 0) continue;
      put(out, k * 128 + (i % 128), (i / 128) | 0, pal[v]);
    }
  });
  return out;
}

// --- Dezaemon+ ----------------------------------------------------------------

function plusRowRgba(save: Save, row: number): Rgba[] {
  const palette = save.palettes[row];
  if (!palette) fail(`--row wants 0..${save.palettes.length - 1}`);
  return palette.colors.map((
    c: { raw: number; r: number; g: number; b: number },
    i: number,
  ) => i === 0 ? [0, 0, 0, 0] as Rgba : [c.r, c.g, c.b, 255] as Rgba);
}

function plusPixel(
  graphics: { indexed: Uint8Array },
  x: number,
  y: number,
): number {
  return graphics.indexed[y * PLUS_GRAPHICS_WIDTH + x];
}

function renderPlusMap(save: Save, stage: number, maxRows: number): Raster {
  const st = save.stages?.[stage];
  if (!st) fail(`no stage ${stage}`);
  const group = decodePlusMapGroup(st);
  const pal = plusRowRgba(
    save,
    intFlag("--row", plusPaletteRow("map", stage) ?? 0),
  );
  const rows = Math.min(maxRows || PLUS_MAP_ROWS, PLUS_MAP_ROWS);
  const out = newRaster(PLUS_MAP_COLUMNS * PLUS_CHIP_DIM, rows * PLUS_CHIP_DIM);
  fill(out, 0, 0, out.width, out.height, [0, 0, 0, 255]);
  for (let r = 0; r < rows; r++) {
    st.mapRows[r].forEach(
      (
        chip: { group: number; hflip: boolean; vflip: boolean; blank: boolean },
        col: number,
      ) => {
        if (chip.blank) return;
        const tile = group[chip.group];
        if (!tile || tile.y + PLUS_CHIP_DIM > save.graphics.height) return;
        for (let y = 0; y < PLUS_CHIP_DIM; y++) {
          for (let x = 0; x < PLUS_CHIP_DIM; x++) {
            const v = plusPixel(save.graphics, tile.x + x, tile.y + y);
            if (v === 0) continue;
            const dx = col * PLUS_CHIP_DIM +
              (chip.hflip ? PLUS_CHIP_DIM - 1 - x : x);
            const dy = r * PLUS_CHIP_DIM +
              (chip.vflip ? PLUS_CHIP_DIM - 1 - y : y);
            put(out, dx, dy, pal[v]);
          }
        }
      },
    );
  }
  return out;
}

function renderPlusGraphics(save: Save): Raster {
  const g = save.graphics;
  const pal = plusRowRgba(save, intFlag("--row", 0));
  const out = newRaster(g.width, g.height);
  fill(out, 0, 0, out.width, out.height, [0, 0, 0, 255]);
  for (let i = 0; i < g.indexed.length; i++) {
    const v = g.indexed[i];
    if (v === 0) continue;
    put(out, i % g.width, (i / g.width) | 0, pal[v]);
  }
  return out;
}

function renderPalettes(save: Save): Raster {
  const cell = 12;
  if (save.game === "kids") {
    const bank = kidsPalette({ backdrop: false });
    const out = newRaster(16 * cell, 16 * cell);
    bank.forEach(
      (c: { r: number; g: number; b: number; stp: boolean }, i: number) => {
        fill(out, (i % 16) * cell, ((i / 16) | 0) * cell, cell, cell, [
          c.r,
          c.g,
          c.b,
          255,
        ]);
        if (c.stp) {
          fill(out, (i % 16) * cell + cell - 3, ((i / 16) | 0) * cell, 3, 3, [
            255,
            255,
            255,
            255,
          ]);
        }
      },
    );
    return out;
  }
  const rows = save.palettes;
  const out = newRaster(16 * cell, rows.length * cell);
  rows.forEach(
    (
      row: {
        colors: {
          raw: number;
          stp: boolean;
          r: number;
          g: number;
          b: number;
        }[];
      },
      r: number,
    ) => {
      row.colors.forEach((c, i) => {
        fill(out, i * cell, r * cell, cell, cell, [c.r, c.g, c.b, 255]);
        if (c.stp) {
          fill(out, i * cell + cell - 3, r * cell, 3, 3, [255, 255, 255, 255]);
        }
      });
    },
  );
  return out;
}

function renderGraphics(save: Save): Raster {
  return save.game === "kids"
    ? renderKidsCells(save)
    : renderPlusGraphics(save);
}

function renderMap(save: Save, stage: number): Raster {
  const rows = intFlag("--rows", 0);
  return save.game === "kids"
    ? renderKidsMap(save, stage, rows)
    : renderPlusMap(save, stage, rows);
}

async function savePng(
  path: string,
  raster: Raster,
  scale: number,
  what: string,
) {
  const scaled = upscale(raster, scale);
  await write(path, await encodePng(scaled));
  console.log(`${what}: ${scaled.width}x${scaled.height} -> ${path}`);
}

// --- reports ------------------------------------------------------------------

function hexdump(bytes: Uint8Array, from: number, to: number): string {
  const lines: string[] = [];
  for (let at = from; at < to; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, to));
    const hexes = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(
      " ",
    );
    const ascii = Array.from(
      row,
      (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."),
    ).join("");
    lines.push(
      `${at.toString(16).padStart(5, "0")}  ${hexes.padEnd(47)}  ${ascii}`,
    );
  }
  return lines.join("\n");
}

interface Region {
  name: string;
  label: string;
  offset: number;
  end: number;
  confidence: string;
  note: string;
}

function regionTable(regions: readonly Region[], indentBy = "  "): string {
  return regions.map((r) =>
    `${indentBy}${hex(r.offset)}-${hex(r.end)}  ${r.label.padEnd(12)} ${
      r.confidence.padEnd(9)
    } ${r.note}`
  ).join("\n");
}

function regionFor(regions: readonly Region[], at: number): Region | null {
  for (const r of regions) if (at >= r.offset && at < r.end) return r;
  return null;
}

function kidsReport(save: Save) {
  console.log(`  data-section regions (offsets inside the decompressed data):`);
  console.log(regionTable(KIDS_REGIONS, "    "));
  if (save.config) {
    const c = save.config;
    console.log(
      `  config: ${
        c.horizontal ? "horizontal" : "vertical"
      } scrolling, ${c.stageCount} stages`,
    );
    for (const s of c.stages) {
      const scroll = `${s.scrollSpeed} px/frame${
        s.scrollReverse ? " reversed" : ""
      }`;
      const bg = s.backgroundFile
        ? `${s.backgroundFile}${
          s.backgroundSpeed ? ` at ${s.backgroundSpeed}` : " static"
        }`
        : "no background";
      console.log(
        `    stage ${s.stage}: scroll ${scroll}, ${bg}${
          s.last ? ", LAST" : ""
        }${s.chained ? ", chained" : ""}`,
      );
    }
  }
  if (save.appear && save.records) {
    console.log(`  per stage: chips, spawns, distinct enemies, boss`);
    save.appear.forEach((a: Save, s: number) => {
      const used = new Set(
        a.spawns.map((sp: { klass: number; id: number }) =>
          `${sp.klass}:${sp.id}`
        ),
      );
      console.log(
        `    stage ${s}: ${String(save.map[s].used).padStart(4)} chips, ${
          String(a.spawns.length).padStart(4)
        } spawns, ${used.size} enemies, ${
          a.boss ? `boss ${save.records[s].bosses[0].size}` : "no boss"
        }`,
      );
    });
  }
  if (save.config?.sound) {
    const live = save.config.sound.slice(0, save.config.liveSoundEntries);
    console.log(`  music (${live.length} live entries):`);
    for (const [i, e] of live.entries()) {
      const what = e.preset ? `preset ${e.presetNumber}` : e.file ?? "none";
      console.log(
        `    ${String(i).padStart(2)}  ${
          String(e.scope).padEnd(8)
        } ${what}, volume ${e.volume}`,
      );
    }
  }
  if (save.config?.font) {
    const c = save.config;
    console.log(
      `  font ${c.font.file} typeface ${c.font.typeface} colour ${c.font.colour}, sound bank ${c.soundBank}, items ${c.pointItems.small}/${c.pointItems.large} pts`,
    );
  }
  if (save.options) {
    const o = save.options;
    console.log(
      `  options: BGM file ${o.bgmFile} volume ${o.bgmVolume}, preset ${o.presetBgm}, SE ${
        o.seMuted ? "muted" : "on"
      }, ${o.stereo ? "stereo" : "mono"}, backdrop ${
        o.backdropWhite ? "white" : "black"
      }`,
    );
  }
  if (save.hiScores) {
    console.log(`  high scores:`);
    for (const h of save.hiScores) {
      const where = h.allClear ? "ALL CLEAR" : `stage ${h.stage + 1}`;
      console.log(
        `    ${String(h.rank).padStart(2)}  ${
          String(h.score).padStart(9)
        }  ${h.name}  ${where}, ${h.muteki ? "MUTEKI" : h.levelName}`,
      );
    }
  }
}

function plusReport(save: Save) {
  console.log(`  regions (offsets inside the save):`);
  console.log(regionTable(PLUS_REGIONS, "    "));
  console.log(`  inside each 0x223C stage block:`);
  for (const p of PLUS_STAGE_LAYOUT) {
    console.log(`    +${hex(p.offset, 4)}-${hex(p.end, 4)}  ${p.label}`);
  }
  if (save.stages) {
    console.log(
      `  per stage: chips, distinct map tiles, spawn records, enemies placed`,
    );
    save.stages.forEach((st: Save, s: number) => {
      const groups = new Set<number>();
      for (const row of st.mapRows) {
        for (const c of row) if (!c.blank) groups.add(c.group);
      }
      const appear = decodePlusAppear(st);
      const live = appear.records.filter((r: { spawns: unknown[] }) =>
        r.spawns.length > 0
      );
      const spawns = live.reduce(
        (a: number, r: { spawns: unknown[] }) => a + r.spawns.length,
        0,
      );
      const enemies = decodePlusEnemyData(st);
      const used = enemies.enemies.filter((e: { bytes: Uint8Array }) =>
        e.bytes.some((b: number) =>
          b !== 0
        )
      ).length;
      console.log(
        `    stage ${s}: ${
          String(st.used).padStart(4)
        } chips, ${groups.size} tiles, ${live.length} records / ${spawns} spawns, ${used} enemy definitions`,
      );
    });
  }
  if (save.checksums && !save.checksums.ok) {
    console.log(`  checksum mismatches:`);
    for (const group of save.checksums.bad) {
      const where = plusGroupRegions(group).map((
        r: { sub: string; group: string; offset: number },
      ) => `${hex(r.offset)} ${r.sub || r.group}`);
      console.log(`    group ${hex(group, 2)} covers ${where.join(", ")}`);
    }
  }
  if (save.hiScores) {
    console.log(`  high scores:`);
    for (const h of save.hiScores) {
      console.log(
        `    table ${h.table} #${String(h.rank).padStart(2)}  ${
          String(h.score).padStart(9)
        }  ${h.name}`,
      );
    }
  }
}

function report(path: string, parsed: Parsed, save: Save) {
  console.log(`${basename(path)}:`);
  console.log(
    summarizePsxSav(parsed as never).split("\n").map((l) => `  ${l}`).join(
      "\n",
    ),
  );
  if (save.game === "kids") kidsReport(save);
  else plusReport(save);
}

// --- edit ---------------------------------------------------------------------

// Writing a Dezaemon+ save back is a different problem from reading one, and
// the whole difference is two sentences.
//
// The only derived bytes in the format are the twenty u16 at 0x1DFD8, of which
// the game verifies nineteen (PLUS_CHECKED_GROUPS = 0x13, plus.js:79), so one
// seal after the last --set is everything the file owes: an N-byte edit writes
// N + 2 bytes PER CHECKSUM GROUP it dirties, and fewer than that differ. Both
// halves of that are measured, not arithmetic: a 16x16 repaint at pixel row
// 120 crosses the graphics quarter boundary at 0x100 + 0x4000 = 0x4100, dirties
// groups 1 and 2 and seals four bytes, not two ("a repaint that straddles a
// graphics quarter dirties two groups", test/psx-plus-edit.test.js), while a
// sealed word whose high byte already held the right value differs in one byte
// where two were written — for a single poked byte at 0x1041, 184 of the 255
// other values (FORMAT-PSX.md). The verb reports the seal's own byte count and
// then counts the diff, so what it prints is measured. Word 0x13 covers the
// checksum array itself, does not converge, and is never written — a seal that
// touched it would change the block on every pass and idempotence would be gone.
//
// And locateSaves() hands back a COPY of a card's blocks (parseMemoryCard joins
// the chain into a fresh buffer, memcard.js:161-172), so blockOf() above — what
// every read verb uses — is exactly the wrong thing to write through: the poke
// lands in the copy and the file on disk is untouched. Cards and .gme images go
// back block by block through placePlusSave(); an .mcs and a bare run already
// alias the caller's bytes and are sliced to exactly PLUS_BLOCK_SIZE, because
// plusChecksums accepts an oversized buffer and silently checksums the first
// 0x1E000 of it. A .psv is refused outright: its 0x84-byte header carries a
// console signature this package can neither read nor regenerate.

/** One setter's report — PlusWrite, as src/psx/plus-edit.js hands it back. */
interface PlusWrite {
  field: string;
  offset: number;
  length: number;
  before: number[];
  after: number[];
  groups: number[];
  changed: boolean;
  checksumBlind: boolean;
  warnings: string[];
}

/** What sealPlusChecksums() reports — only the words that actually changed. */
interface PlusSeal {
  words: { group: number; offset: number; before: number; after: number }[];
  bytes: number;
  ok: boolean;
}

/** What placePlusSave() and placeKidsSave() report about the card. */
interface CardPlacement {
  filename: string;
  blocks: number[];
  bytes: number;
  framesOk: boolean;
  warnings: string[];
}

interface EditField {
  /** How the slot part of the field name is spelled, for the listing. */
  slot?: string;
  /** What goes after the `=`, for the listing and the refusal. */
  value: string;
  /** Calls exactly one library setter. Every range is the library's to refuse. */
  apply(block: Uint8Array, slot: string, value: string): unknown;
  /** How the bytes this write touched read back as the field's own value. */
  show?(bytes: number[]): string;
}

const DETAIL_COLUMN = 39;

function byte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function editInt(what: string, text: string | undefined): number {
  if (text === undefined || text === "") fail(`${what} needs a number`);
  const n = Number(text);
  if (!Number.isInteger(n)) fail(`${what} wants an integer, not ${text}`);
  return n;
}

function editOnOff(what: string, text: string): boolean {
  if (text === "on" || text === "1") return true;
  if (text === "off" || text === "0") return false;
  return fail(`${what} wants on or off, not ${text}`);
}

/**
 * A high-score name as sixteen hex digits, never as text. plus.js:631 decodes
 * the field with latin1(), a raw byte-to-charCode pass-through, and the
 * Dezaemon+ font is untraced — typing letters would write bytes whose glyphs
 * nobody has seen.
 */
function editName(text: string): Uint8Array {
  if (!/^[0-9a-f]{16}$/i.test(text)) {
    fail(`a high-score name is sixteen hex digits (eight bytes), not ${text}`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Only fields whose value is a single scalar. Bulk work belongs in a script. */
const PLUS_EDIT_FIELDS: Record<string, EditField> = {
  "stage-count": {
    value: "1..5",
    apply: (b, _s, v) => setPlusStageCount(b, editInt("stage-count", v)),
    show: (b) => String(b[0] + 1),
  },
  "score-bonus": {
    value: "0..7, an index into PLUS_SCORE_BONUS",
    apply: (b, _s, v) => setPlusScoreBonus(b, editInt("score-bonus", v)),
    show: (b) => String(b[0] & 7),
  },
  "charge-time": {
    value: "0..5",
    apply: (b, _s, v) => setPlusChargeTime(b, editInt("charge-time", v)),
    show: (b) => String(b[0]),
  },
  "cursor-speed": {
    value: "0..2",
    apply: (b, _s, v) => setPlusCursorSpeed(b, editInt("cursor-speed", v)),
    show: (b) => String(b[0]),
  },
  "menu-bgm": {
    value: "0..3, or off",
    apply: (b, _s, v) =>
      setPlusMenuBgm(
        b,
        v === "off" ? PLUS_MENU_BGM_OFF : editInt("menu-bgm", v),
      ),
    show: (b) => (b[0] >= PLUS_MENU_BGM_OFF ? "off" : String(b[0])),
  },
  "stereo": {
    value: "on or off",
    apply: (b, _s, v) => setPlusStereo(b, editOnOff("stereo", v)),
    show: (b) => (b[0] ? "on" : "off"),
  },
  "keys": {
    value: "<m0>,<m1>,<m2>,<m3> button bitmasks (0x.. or decimal)",
    apply: (b, _s, v) => {
      const masks = v.split(",");
      if (masks.length !== 4) {
        fail(`keys wants four masks, got ${masks.length}: ${v}`);
      }
      return setPlusKeyConfig(
        b,
        masks.map((m, i) => editInt(`keys mask ${i}`, m)),
      );
    },
    show: (b) => b.map(byte).join(","),
  },
  "bgm": {
    slot: "<slot>",
    value: "0..50; slot 0..15 or a PLUS_BGM_SLOTS name",
    apply: (b, s, v) =>
      setPlusBgmSlot(
        b,
        /^\d+$/.test(s) ? Number(s) : s,
        editInt("bgm song", v),
      ),
    show: (b) => String(b[0]),
  },
  "item": {
    slot: "<slot>",
    value: "0..11, an effect id; slot 0..6",
    apply: (b, s, v) =>
      setPlusItemSlot(b, editInt("item slot", s), {
        effect: editInt("item effect", v),
      }),
    show: (b) => String(b[0]),
  },
  "hiscore": {
    slot: "<rank>",
    value: "<score>[:<stage>[:<16 hex digits>]]; rank 1..10, table B only",
    // Only what the caller typed is passed on. An omitted stage or name is
    // preserved by setPlusHiScore itself, unvalidated, the way it preserves
    // setPlusItemSlot's enableByte and setPlusMapGroupTile's page — so the CLI
    // neither re-reads the entry nor needs a rank guard to index it safely.
    // Re-reading it here was a measured trap: `edit` can lower the stage count
    // after a record is set (--set hiscore.1=5000:4, then --set stage-count=1),
    // and handing the stored 4 back through the setter's range check refused
    // --set hiscore.1=6000 over a value nobody typed.
    apply: (b, s, v) => {
      const parts = v.split(":");
      return setPlusHiScore(b, editInt("hiscore rank", s), {
        score: editInt("hiscore score", parts[0]),
        ...(parts[1] ? { stage: editInt("hiscore stage", parts[1]) } : {}),
        ...(parts[2] ? { name: editName(parts[2]) } : {}),
      });
    },
    show: (b) =>
      `${((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0)}:${b[4]}:${
        b.slice(8, 16).map(byte).join("")
      }`,
  },
  "song": {
    slot: "<to>",
    value: "<from>; both 0..15, a whole 0x2E0 slot",
    apply: (b, s, v) =>
      copyPlusSong(b, editInt("song slot", s), editInt("song source", v)),
  },
};

function plusEditFieldList(): string {
  const rows = Object.entries(PLUS_EDIT_FIELDS).map(([name, f]) =>
    `  ${(name + (f.slot ? `.${f.slot}` : "")).padEnd(16)} ${f.value}`
  );
  return `fields, each exactly one library setter:\n${rows.join("\n")}`;
}

/**
 * How many of a write's bytes cannot move a checksum. Every byte contributes
 * `value * (offsetWithinEntry & 0x1F)` (plus.js:244), so each 32nd byte of a
 * table entry is multiplied by zero and its value never reaches the sum —
 * 3,850 of the file's 122,880 bytes, cursor speed, font bank, menu BGM and
 * keys[0] among them. A clean checksum is never proof an edit landed.
 *
 * null when the write is visibly not one run, which is why this takes the
 * record and not two numbers. A PlusWrite carries no list of ranges: `offset`
 * is only the FIRST byte written and `length` only how many, and a few setters
 * own bytes that are not contiguous — a map cell is a chip byte and a flip byte
 * up to nine apart, a pixel rectangle is one run per scanline (applyWrite's doc
 * comment in plus-edit.js). Walking [offset, offset + length) for one of those
 * weighs bytes the write never touched: setPlusMapCell over stage 0, column 1,
 * row 7 writes 0x1047f and 0x10486, the span walks 0x1047f and 0x10480, and it
 * counts one blind byte where the truth is none.
 *
 * Every PLUS_EDIT_FIELDS setter writes a single run today — all eleven measured —
 * and `after` re-checks that per write rather than trusting the list stays that
 * way: for one run it IS the block's own slice, so a mismatch is proof the
 * record is not a span and the count would be fiction. A match is NOT the
 * converse, so this narrows the trap rather than closing it: measured,
 * swapPlusGroupWords("ship", 0, 76) writes 0x1af86-7 and 0x1b01e-f, all four
 * bytes are zero on a synthetic block, the untouched 0x1af88-9 therefore match
 * `after`, and it slips through to report 1. Only the library closes it —
 * applyWrite already visits every written offset and already calls
 * checksumWeightAt on each, so the count belongs on PlusWrite beside
 * checksumBlind, which is computed that way and is right for every setter.
 */
function blindBytes(block: Uint8Array, w: PlusWrite): number | null {
  if (w.after.some((b, i) => block[w.offset + i] !== b)) return null;
  let blind = 0;
  for (let at = w.offset; at < w.offset + w.length; at++) {
    const row = plusEntryAt(at) as { offset: number } | null;
    if (row && ((at - row.offset) & 0x1f) === 0) blind++;
  }
  return blind;
}

/** A line with its offsets in a fixed column, wrapped when the left runs long. */
function detail(left: string, right: string) {
  if (left.length >= DETAIL_COLUMN) {
    console.log(left);
    console.log(" ".repeat(DETAIL_COLUMN) + right);
  } else console.log(left.padEnd(DETAIL_COLUMN) + right);
}

/** One --set, applied. A refusal carries the library's own message. */
function applyPlusEdit(
  block: Uint8Array,
  text: string,
): { key: string; value: string; field: EditField; write: PlusWrite } {
  const eq = text.indexOf("=");
  if (eq < 0) {
    fail(`--set wants <field>=<value>, not ${text}\n\n${plusEditFieldList()}`);
  }
  const key = text.slice(0, eq);
  const value = text.slice(eq + 1);
  const dot = key.indexOf(".");
  const field = PLUS_EDIT_FIELDS[dot < 0 ? key : key.slice(0, dot)];
  if (!field) fail(`--set ${key}: no such field\n\n${plusEditFieldList()}`);
  try {
    const write = field.apply(
      block,
      dot < 0 ? "" : key.slice(dot + 1),
      value,
    ) as PlusWrite;
    return { key, value, field, write };
  } catch (err) {
    return fail(`--set ${text}: ${(err as Error).message}`);
  }
}

/**
 * Prints what one write landed, and returns its checksum-blind byte count —
 * null when blindBytes() cannot know it, which no field reaches today.
 */
function reportPlusEdit(
  block: Uint8Array,
  key: string,
  value: string,
  field: EditField,
  w: PlusWrite,
): number | null {
  const blind = blindBytes(block, w);
  const region = regionFor(PLUS_REGIONS, w.offset);
  const groups = w.groups.length === 1
    ? `group ${hex(w.groups[0], 2)}`
    : `groups ${w.groups.map((g) => hex(g, 2)).join(" ")}`;
  // The all-or-nothing label is the library's own: applyWrite weighs each byte
  // it writes, so checksumBlind holds for a run and for a scattered write
  // alike. Only the partial label needs the count, and `blind === w.length`
  // would be the same answer as checksumBlind over the same bytes.
  const seen = w.checksumBlind
    ? "  checksum-blind"
    : blind !== null && blind > 0
    ? "  checksum-blind in part"
    : "";
  // A field with no show() is a bulk write — a whole song slot — whose bytes
  // say nothing a reader wants; echo what was asked for and how much moved.
  const said = field.show
    ? `${field.show(w.after)}${
      w.changed ? ` (was ${field.show(w.before)})` : " (unchanged)"
    }`
    : `${value} (${w.length} bytes${w.changed ? "" : ", unchanged"})`;
  detail(
    `  set ${key} = ${said}`,
    `${hex(w.offset)}  ${(region?.label ?? "").padEnd(12)}${groups}${seen}`,
  );
  for (const warning of w.warnings) console.log(`    ${warning}`);
  return blind;
}

/**
 * The 0x1E000 bytes an edit writes through — deliberately not blockOf(). For a
 * card and a .gme the save parseMemoryCard hands back is a copy, so the edit
 * happens in an explicit copy of it and placePlusSave() puts it back; an .mcs
 * (memcard.js:209) and a bare run (:222) already alias the file's own bytes.
 */
function editableBlock(
  bytes: Uint8Array,
  parsed: Parsed,
  save: Save,
): Uint8Array {
  // The two games' blocks are the same length — PLUS_BLOCK_SIZE and
  // KIDS_BLOCK_SIZE are both 0x1E000, fifteen card blocks — so this slices the
  // same span either way and only the refusal names a game.
  const size = save.game === "kids" ? KIDS_BLOCK_SIZE : PLUS_BLOCK_SIZE;
  const what = `a ${PSX_GAMES[save.game as "kids" | "plus"].title} block`;
  if (parsed.container === "mcs" || parsed.container === "bare") {
    const at = parsed.container === "mcs" ? MCS_HEADER_SIZE : 0;
    if (bytes.length - at < size) {
      fail(
        `${parsed.container}: ${
          bytes.length - at
        } bytes of save; ${what} is ${size}`,
      );
    }
    return bytes.subarray(at, at + size);
  }
  const file = parsed.card?.files.find((f) => f.filename === save.filename);
  if (!file) fail(`${save.filename || "the save"} is not a file on this card`);
  if (file.data.length < size) {
    fail(
      `${file.filename}: ${file.data.length} bytes on the card; ${what} is ${size}`,
    );
  }
  return Uint8Array.from(file.data.subarray(0, size));
}

/** Card blocks as the chain reads: a run collapses, anything else lists. */
function blockRun(blocks: number[]): string {
  const run = blocks.every((b, i) => i === 0 || b === blocks[i - 1] + 1);
  return run && blocks.length > 1
    ? `${blocks[0]}-${blocks[blocks.length - 1]}`
    : blocks.join(", ");
}

/** What every arm of `edit` starts from: the parse, the flags, the target. */
interface EditRun {
  path: string;
  parsed: Parsed;
  save: Save;
  bytes: Uint8Array;
  out: string;
  force: boolean;
  sets: string[];
}

/** `edit` for a Dezaemon+ save: every --set, then one seal, then the card. */
async function editPlus(run: EditRun, block: Uint8Array) {
  const { path, parsed, save, bytes, out, force, sets } = run;
  if (!isPlusBlock(block) && !force) {
    fail(
      `${
        basename(path)
      } carries no "SC" Dezaemon+ frame — a Select 100 block has it stripped; --force edits it anyway`,
    );
  }
  const opening = plusChecksums(block);
  if (!opening.ok && !force) {
    fail(
      `${basename(path)} already fails checksum groups ${
        opening.bad.map((g: number) => hex(g, 2)).join(", ")
      }; --force edits it anyway, and --force with no --set just reseals it`,
    );
  }
  const before = Uint8Array.from(block);
  console.log(
    `${basename(path)}: ${PSX_GAMES.plus.title} (${parsed.container}${
      parsed.card
        ? `, ${parsed.card.files.length} file${
          parsed.card.files.length === 1 ? "" : "s"
        }, ${parsed.card.freeBlocks} free blocks`
        : ""
    })`,
  );
  if (!opening.ok) {
    console.log(
      `  the input already failed groups ${
        opening.bad.map((g: number) => hex(g, 2)).join(" ")
      }; --force accepted it and the seal below rewrites them`,
    );
  }
  if (sets.length === 0) console.log(`  no --set given: resealing only`);
  // null the moment one write cannot be counted: a total that quietly dropped
  // that write would read as "and the rest are fine", which is the one thing
  // this line exists to stop a caller believing.
  let blind: number | null = 0;
  for (const text of sets) {
    const { key, value, field, write: w } = applyPlusEdit(block, text);
    const n = reportPlusEdit(block, key, value, field, w);
    blind = blind === null || n === null ? null : blind + n;
  }
  // Once, after every --set: nineteen groups cost 1.35 ms and delete a whole
  // class of bug, because a write that straddles a graphics quarter dirties
  // two groups at once and a partial seal would miss one.
  const seal = sealPlusChecksums(block) as PlusSeal;
  if (seal.words.length === 0) {
    console.log(`  nothing to reseal: every verified group already matched`);
  } else {
    detail(
      `  sealed groups ${
        [...new Set(seal.words.map((w) => w.group))].map((g) => hex(g, 2)).join(
          " ",
        )
      }`,
      `${
        seal.words.map((w) => hex(w.offset)).join(", ")
      } (${seal.bytes} bytes)`,
    );
  }
  console.log(
    `  group ${hex(PLUS_UNSEALED_GROUP, 2)} at ${
      hex(PLUS_UNSEALED_OFFSET)
    } left as found — the game does not verify it`,
  );
  if (!seal.ok) {
    fail(
      `the reseal did not verify; nothing written. This is a bug in sealPlusChecksums, not in the save`,
    );
  }
  let changed = 0;
  for (let i = 0; i < PLUS_BLOCK_SIZE; i++) {
    if (before[i] !== block[i]) changed++;
  }
  console.log(`  ${changed} bytes of ${PLUS_BLOCK_SIZE} changed in the block`);
  if (blind === null) {
    console.log(
      `  a write's bytes are not one contiguous run and its record does not`,
    );
    console.log(
      `  carry the offsets it wrote, so no checksum-blind count is possible`,
    );
    console.log(`  for this edit — diff the bytes instead`);
  } else if (blind > 0) {
    console.log(
      `  ${blind} of the written bytes cannot move a checksum: a byte whose offset`,
    );
    console.log(
      `  within its table entry is a multiple of 32 is multiplied by zero, so a`,
    );
    console.log(
      `  clean checksum is not proof the edit landed — diff the bytes instead`,
    );
  }
  let placement: CardPlacement | null = null;
  if (parsed.container === "card" || parsed.container === "gme") {
    const card = parsed.container === "gme"
      ? bytes.subarray(GME_HEADER_SIZE)
      : bytes;
    try {
      placement = placePlusSave(card, block, {
        filename: save.filename,
        requirePlus: !force,
      }) as CardPlacement;
    } catch (err) {
      fail(`${basename(path)}: ${(err as Error).message}`);
    }
  }
  await write(out, bytes);
  console.log(
    `  wrote ${out} (${
      placement
        ? `block placed in card blocks ${blockRun(placement.blocks)}, ${
          placement.framesOk
            ? "all frames ok"
            : "A DIRECTORY FRAME NO LONGER CHECKSUMS"
        }`
        : `${parsed.container}, ${PLUS_BLOCK_SIZE} bytes edited in place`
    })`,
  );
  for (const warning of placement?.warnings ?? []) {
    console.log(`    ${warning}`);
  }
}

// --- edit: Dezaemon Kids! -----------------------------------------------------

// The Kids! arm is not the Dezaemon+ one with different offsets, and the extra
// lines it prints are the difference.
//
// A Kids! block is not raw. From 0x180 it is two Okumura-LZSS streams —
// graphics, 0x40000 decompressed, and data, 0xFCC8 — then a raw 0x100 tail,
// with eleven u32 at 0x100 giving each section's offset, exact size,
// sector-rounded size and 32-bit byte sum over the PADDED span (FORMAT-PSX.md,
// "Section directory"). So an edit inside a section is never a poke: the
// section goes back through src/compress.js, which is NOT the encoder KIDS.EXE
// shipped. Measured here over the 77 real Kids! saves in dev-fixtures/ — the
// folder holds 97 dumps and the other 20 are Dezaemon+ saves, told apart by the
// card directory entry's name and never by the folder — 0 of 77 recompress
// byte-identically and the two sections together come back a mean 796 bytes
// larger (min -2,322, max +2,495). An edited section therefore changes far more
// bytes than the edit asked for, which is why the report names every section it
// re-encoded and says so in prose: the byte count alone reads as corruption.
//
// An UNTOUCHED section keeps its original stream, copied verbatim, and that is
// editKidsSave()'s contract rather than this file's choice — it is the only way
// an edit-nothing run comes back byte-identical, the property the Dezaemon+ arm
// gets for free. Both fields below write outside the two streams (the tail is
// stored raw, the game name is in the "SC" frame), so a normal run here
// re-encodes nothing at all.
//
// And the file is 0x1E000 bytes whatever the streams weigh. Slack as found
// across the 77 runs 4,864..74,880 bytes (mean 37,147); with BOTH sections
// re-encoded the tightest left is 4,224 ("Cronos (Keroyon) (D25).sav"). All 77
// still fit, but 4,224 against an encoder that can cost 2,495 is not a margin
// to assume, so every run prints the slack it measured and editKidsSave()
// refuses with the arithmetic rather than truncating.

/** One setter's report — KidsFieldWrite, as src/psx/kids-edit.js returns it. */
interface KidsFieldWrite {
  field: string;
  section: string;
  offset: number;
  length: number;
  before: number[];
  after: number[];
  changed: boolean;
  inBlock: boolean;
  warnings: string[];
}

/** One section, as editKidsSave() reports where it put it. */
interface KidsSectionMove {
  name: string;
  offset: number;
  size: number;
  padded: number;
  supplied: boolean;
  recompressed: boolean;
  moved: boolean;
  sizeDelta: number;
  paddingKept: boolean;
  was: { offset: number; size: number; padded: number };
}

/** What editKidsSave() reports about the block it relaid and resealed. */
interface KidsRelay {
  sections: KidsSectionMove[];
  end: number;
  wasEnd: number;
  slack: number;
  seal: {
    words: { index: number; name: string; offset: number }[];
    bytes: number;
    checksums: { graphics: boolean; data: boolean; tail: boolean; ok: boolean };
    consistent: boolean;
  };
  identical: boolean;
  changedBytes: number;
  warnings: string[];
}

/** The buffers a Kids! --set writes into. */
interface KidsTarget {
  block: Uint8Array;
  /** A COPY of the block's tail; editKidsSave() puts it back. */
  tail: Uint8Array;
}

interface KidsEditField {
  /** How the slot part of the field name is spelled, for the listing. */
  slot?: string;
  /** What goes after the `=`, for the listing and the refusal. */
  value: string;
  /**
   * Calls exactly one library setter. Every range is the library's to refuse.
   * The return type is KidsFieldWrite and not `unknown` — the Dezaemon+ arm's
   * choice above — so that `deno check` compares each setter's own record
   * against the shape this file prints from, instead of a cast asserting it.
   */
  apply(target: KidsTarget, slot: string, value: string): KidsFieldWrite;
  /** How the bytes this write touched read back as the field's own value. */
  show(bytes: number[]): string;
}

/**
 * Which of the three byte sums covers a write — the Kids! answer to the
 * Dezaemon+ arm's `checksum-blind`.
 *
 * "block" is everything below 0x180: the "SC" title frame the game name lives
 * in, and the directory itself. Words 4, 6 and 8 sum the graphics, data and
 * tail spans and nothing else (kids.js:258-264), and a memory card's only other
 * checksum is the XOR each directory frame takes over its own 128 bytes
 * (memcard.js:71), which never covers a data block. So a name write is final
 * the moment it lands and no checksum can confirm it. `diff` is what does: its
 * Kids! header pair covers 0x00..0x180, which is where the name is.
 */
const KIDS_COVER: Record<string, string> = {
  tail: "word 8 covers it",
  data: "word 6 covers it",
  graphics: "word 4 covers it",
  block: "no checksum covers it",
};

/** The game name as text: the field is Shift-JIS, and kids.js:713 narrows it. */
function kidsTitleText(bytes: number[]): string {
  return narrow(decodeShiftJis(Uint8Array.from(bytes))).replace(/\s+/g, " ")
    .trim();
}

/** Only fields whose value is a single scalar. Bulk work belongs in a script. */
const KIDS_EDIT_FIELDS: Record<string, KidsEditField> = {
  "name": {
    value: "up to 10 characters, ASCII or its fullwidth twins",
    // A string, where a Dezaemon+ high-score name has to be hex: this field IS
    // traced. The title is Shift-JIS, save-header.js decodes it with
    // TextDecoder, and kidsNameBytes() refuses every character it cannot encode
    // rather than substituting one (kids-edit.js:1048-1053). A katakana or
    // kanji name is raw Shift-JIS bytes and goes through the library, not
    // argv: measured here, 54 of the 77 real names have a character with no
    // ASCII form, so this field types 23 of them.
    apply: (t, _s, v) => setKidsGameName(t.block, v),
    show: kidsTitleText,
  },
  "hiscore": {
    slot: "<rank>",
    value: "<score>[:<stage>|all[:<name>[:<level>]]]; rank 1..10",
    // Only what the caller typed is passed on, for the reason plus-edit.js
    // arrived at the hard way: an omitted part is preserved by the setter,
    // unvalidated, so correcting a score never touches the stage a run reached.
    apply: (t, s, v) => {
      const parts = v.split(":");
      if (parts.length > 4) {
        fail(
          `--set hiscore.${s}: ${v} has ${
            parts.length - 1
          } colons; the value is <score>[:<stage>|all[:<name>[:<level>]]] and a name with a colon in it has to go through the library`,
        );
      }
      const [score, where, name, level] = parts;
      return setKidsHiScore(t.tail, editInt("hiscore rank", s), {
        score: editInt("hiscore score", score),
        ...(where === "all" ? { allClear: true } : {}),
        ...(where && where !== "all"
          ? { stage: editInt("hiscore stage", where) }
          : {}),
        ...(name ? { name: kidsScoreName(name) } : {}),
        ...(level ? { level: editInt("hiscore level", level) } : {}),
      });
    },
    show: (b) =>
      `${((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0)}:${
        b[4] === KIDS_ALL_CLEAR ? "all" : b[4]
      }:${b.slice(8, 16).map((c) => String.fromCharCode(c)).join("")}:${b[5]}`,
  },
};

function kidsEditFieldList(): string {
  const rows = Object.entries(KIDS_EDIT_FIELDS).map(([name, f]) =>
    `  ${(name + (f.slot ? `.${f.slot}` : "")).padEnd(16)} ${f.value}`
  );
  return `fields, each exactly one library setter:\n${rows.join("\n")}`;
}

/** One --set, applied. A refusal carries the library's own message. */
function applyKidsEdit(
  target: KidsTarget,
  text: string,
): {
  key: string;
  value: string;
  field: KidsEditField;
  write: KidsFieldWrite;
} {
  const eq = text.indexOf("=");
  if (eq < 0) {
    fail(`--set wants <field>=<value>, not ${text}\n\n${kidsEditFieldList()}`);
  }
  const key = text.slice(0, eq);
  const value = text.slice(eq + 1);
  const dot = key.indexOf(".");
  const field = KIDS_EDIT_FIELDS[dot < 0 ? key : key.slice(0, dot)];
  if (!field) fail(`--set ${key}: no such field\n\n${kidsEditFieldList()}`);
  try {
    const write = field.apply(target, dot < 0 ? "" : key.slice(dot + 1), value);
    return { key, value, field, write };
  } catch (err) {
    return fail(`--set ${text}: ${(err as Error).message}`);
  }
}

/** Prints what one write landed, and where a checksum can confirm it. */
function reportKidsEdit(
  key: string,
  field: KidsEditField,
  w: KidsFieldWrite,
) {
  const where = w.section === "block"
    ? hex(w.offset)
    : `${w.section}+${hex(w.offset, 4)}`;
  detail(
    `  set ${key} = ${field.show(w.after)}${
      w.changed ? ` (was ${field.show(w.before)})` : " (unchanged)"
    }`,
    `${where}  ${KIDS_COVER[w.section] ?? ""}`,
  );
  for (const warning of w.warnings) console.log(`    ${warning}`);
}

/** Where each section ended up, and what putting it there cost. */
function reportKidsSections(relay: KidsRelay) {
  for (const s of relay.sections) {
    const size = s.sizeDelta === 0
      ? `${String(s.size).padStart(6)} B`
      : `${s.was.size} -> ${s.size} B`;
    const how = s.recompressed
      ? `recompressed (${s.sizeDelta >= 0 ? "+" : ""}${s.sizeDelta})`
      : s.supplied
      ? "rewritten raw"
      : "copied verbatim";
    detail(
      `  ${s.name.padEnd(8)} ${size} ${how}${
        s.moved ? `, moved from ${hex(s.was.offset)}` : ""
      }`,
      `${hex(s.offset)}${
        s.padded > s.size ? `  padded to ${hex(s.padded, 4)}` : ""
      }${s.paddingKept || s.padded === s.size ? "" : ", padding zeroed"}`,
    );
  }
}

/** editKidsSave(), with the library's refusal as the CLI's. */
function kidsRelay(
  block: Uint8Array,
  sections: { tail?: Uint8Array },
  path: string,
): KidsRelay {
  try {
    return editKidsSave(block, sections) as KidsRelay;
  } catch (err) {
    return fail(`${basename(path)}: ${(err as Error).message}`);
  }
}

/** `edit` for a Kids! save: every --set, then one relay, then the card. */
async function editKids(run: EditRun, block: Uint8Array) {
  const { path, parsed, save, bytes, out, force, sets } = run;
  // Not overridable, and --force says so rather than staying silent: an LZSS
  // stream carries no length (decompress() stops when its input runs out,
  // decompress.js:27), so a directory that does not cross-check leaves nothing
  // able to say where a section ends — not this verb and not editKidsSave.
  const table = parseKidsTable(block);
  if (!table.consistent) {
    fail(
      `${basename(path)}: the eleven-word directory at ${
        hex(0x100)
      } does not cross-check (${
        table.problems.join("; ")
      }); an LZSS stream carries no length, so nothing here can recover where the sections end — --force cannot help`,
    );
  }
  const opening = validateKidsTable(block, table);
  const sums = (v: { graphics: boolean; data: boolean; tail: boolean }) =>
    `graphics ${v.graphics ? "ok" : "BAD"}, data ${
      v.data ? "ok" : "BAD"
    }, tail ${v.tail ? "ok" : "BAD"}`;
  if (!opening.ok && !force) {
    fail(
      `${basename(path)} already fails its byte sums (${
        sums(opening)
      }); --force edits it anyway, and --force with no --set just reseals the directory`,
    );
  }
  const before = Uint8Array.from(block);
  console.log(
    `${basename(path)}: ${PSX_GAMES.kids.title} (${parsed.container}${
      parsed.card
        ? `, ${parsed.card.files.length} file${
          parsed.card.files.length === 1 ? "" : "s"
        }, ${parsed.card.freeBlocks} free blocks`
        : ""
    })`,
  );
  console.log(`  game name: ${kidsDisplayName(save)}`);
  if (!opening.ok) {
    console.log(
      `  the input's own sums did not verify (${
        sums(opening)
      }); --force accepted it and the seal below heals them`,
    );
  }
  if (sets.length === 0) {
    console.log(`  no --set given: relaying and resealing only`);
  }
  // The tail is taken from THIS block and not from save.tail, which is a view
  // into the parse's own buffer — for a card and a .gme that buffer is a COPY
  // (memcard.js:161-163), so an edit there would land nowhere. It is a copy
  // either way, because editKidsSave() writes it back itself.
  const at = table.sections.tail.offset;
  const target: KidsTarget = {
    block,
    tail: Uint8Array.from(block.subarray(at, at + KIDS_TAIL_SIZE)),
  };
  const dirty = new Set<string>();
  for (const text of sets) {
    const { key, field, write: w } = applyKidsEdit(target, text);
    reportKidsEdit(key, field, w);
    if (w.changed) dirty.add(w.section);
  }
  // Both fields today write "block" (final where it lands) or "tail" (handed
  // back below). This refusal cannot fire now and is not decoration: a field
  // that wrote a decompressed section and was not passed on would be dropped
  // silently, and the save would come out sealed, loadable and unedited.
  for (const section of dirty) {
    if (section !== "block" && section !== "tail") {
      fail(
        `--set wrote the ${section} section, which this verb does not hand to editKidsSave — the edit would be dropped`,
      );
    }
  }
  const relay = kidsRelay(
    block,
    dirty.has("tail") ? { tail: target.tail } : {},
    path,
  );
  reportKidsSections(relay);
  if (relay.seal.words.length === 0) {
    console.log(`  the directory already agreed: nothing to reseal`);
  } else {
    detail(
      `  sealed directory words ${
        relay.seal.words.map((w) => `${w.index} ${w.name}`).join(", ")
      }`,
      `${
        relay.seal.words.map((w) => hex(w.offset)).join(", ")
      } (${relay.seal.bytes} bytes)`,
    );
  }
  detail(
    `  end ${
      relay.end === relay.wasEnd
        ? `${hex(relay.end)} unchanged`
        : `${hex(relay.wasEnd)} -> ${hex(relay.end)}`
    }`,
    `${relay.slack} bytes of slack in the ${hex(KIDS_BLOCK_SIZE)} file`,
  );
  for (const warning of relay.warnings) console.log(`    ${warning}`);
  if (!relay.seal.consistent || !relay.seal.checksums.ok) {
    fail(
      `the reseal did not verify (${sums(relay.seal.checksums)}${
        relay.seal.consistent ? "" : ", directory inconsistent"
      }); nothing written. This is a bug in editKidsSave, not in the save`,
    );
  }
  let changed = 0;
  for (let i = 0; i < KIDS_BLOCK_SIZE; i++) {
    if (before[i] !== block[i]) changed++;
  }
  console.log(`  ${changed} bytes of ${KIDS_BLOCK_SIZE} changed in the block`);
  // How to read that number, which is not the Dezaemon+ arm's answer. There an
  // N-byte edit writes N + 2 bytes per dirtied group and nothing else moves.
  // Here a section the edit supplied is replaced whole, so the count is mostly
  // the new stream. No --set writes a section today — both fields are the tail
  // and the title frame — so a run of this verb prints the second line; the
  // first is what it owes a caller the moment a stream comes back from
  // src/compress.js, whether that is a new field here or a script driving
  // editKidsSave() directly.
  const redone = relay.sections.filter((s) => s.recompressed);
  if (redone.length > 0) {
    console.log(
      `  ${
        redone.map((s) => s.name).join(" and ")
      } came back through src/compress.js, which is not the`,
    );
    console.log(
      `  encoder the game used: 0 of the 77 community saves recompress`,
    );
    console.log(
      `  byte-identically, mean +796 bytes over the two sections. So most of`,
    );
    console.log(
      `  that count is the new stream and not the edit, and it is not`,
    );
    console.log(
      `  corruption — diff the decompressed sections, not the file`,
    );
  } else {
    console.log(
      `  both LZSS streams were copied verbatim — no --set writes one — so`,
    );
    console.log(
      `  every changed byte is one the edit or the directory asked for`,
    );
  }
  let placement: CardPlacement | null = null;
  if (parsed.container === "card" || parsed.container === "gme") {
    const card = parsed.container === "gme"
      ? bytes.subarray(GME_HEADER_SIZE)
      : bytes;
    try {
      placement = placeKidsSave(card, block, {
        filename: save.filename,
        requireKids: !force,
      }) as CardPlacement;
    } catch (err) {
      fail(`${basename(path)}: ${(err as Error).message}`);
    }
  }
  await write(out, bytes);
  console.log(
    `  wrote ${out} (${
      placement
        ? `block placed in card blocks ${blockRun(placement.blocks)}, ${
          placement.framesOk
            ? "all frames ok"
            : "A DIRECTORY FRAME NO LONGER CHECKSUMS"
        }`
        : `${parsed.container}, ${KIDS_BLOCK_SIZE} bytes edited in place`
    })`,
  );
  for (const warning of placement?.warnings ?? []) {
    console.log(`    ${warning}`);
  }
}

// --- commands -----------------------------------------------------------------

if (command === "report") {
  const { path, parsed, save } = load(positional[0]);
  report(path, parsed, save);
} else if (command === "png") {
  const { save } = load(positional[0]);
  const what = positional[1];
  const out = need("--out");
  const scale = intFlag("--scale", what === "icon" ? 8 : 1);
  if (what === "icon") await savePng(out, renderIcon(save), scale, "icon");
  else if (what === "graphics" || what === "cells") {
    await savePng(out, renderGraphics(save), scale, "graphics");
  } else if (what === "palettes") {
    await savePng(out, renderPalettes(save), scale, "palettes");
  } else if (what === "map") {
    const stage = intFlag("--stage", 0);
    await savePng(out, renderMap(save, stage), scale, `map stage ${stage}`);
  } else {fail(
      `png wants icon|graphics|palettes|map|cells, not ${what}\n\n${USAGE}`,
    );}
} else if (command === "hex") {
  const { save, block } = load(positional[0]);
  const range = need("--range");
  const m = /^(0x[0-9a-f]+|\d+):(0x[0-9a-f]+|\d+)$/i.exec(range);
  if (!m) fail("--range wants A:B");
  const section = typeof flags["--section"] === "string"
    ? flags["--section"]
    : "header";
  let bytes = block;
  let regions: readonly Region[] | null = save.game === "kids"
    ? null
    : PLUS_REGIONS;
  if (save.game === "kids" && section !== "header") {
    const picked = section === "graphics"
      ? save.graphics
      : section === "data"
      ? save.data
      : section === "tail"
      ? save.tail
      : null;
    if (!picked) fail(`--section wants header, graphics, data or tail`);
    bytes = picked;
    regions = section === "data" ? KIDS_REGIONS : null;
  }
  const from = Number(m[1]);
  const to = Math.min(Number(m[2]), bytes.length);
  const r = regions ? regionFor(regions, from) : null;
  console.log(
    `${hex(from)}-${hex(to)}${save.game === "kids" ? ` (${section})` : ""}${
      r ? `  ${r.label}, ${r.confidence}` : ""
    }`,
  );
  console.log(hexdump(bytes, from, to));
} else if (command === "diff") {
  const a = load(positional[0]);
  const b = load(positional[1]);
  if (a.save.game !== b.save.game) {
    fail(`${a.save.game} vs ${b.save.game}: different games`);
  }
  const bytes = (v: unknown) => (v instanceof Uint8Array ? v : null);
  const pairs: [
    string,
    Uint8Array | null,
    Uint8Array | null,
    readonly Region[] | null,
  ][] = a.save.game === "kids"
    // The header goes first and is the raw bytes below the first section: the
    // "SC" title frame the game name lives in, the icon, the eleven directory
    // words and the 84 stale staging bytes at 0x12C. Without it two saves that
    // differ only in their name diff as identical, and `edit --set name` is a
    // write no Kids! checksum covers, so this is the only place it shows.
    ? [
      [
        "header",
        a.block.subarray(0, KIDS_FIRST_SECTION),
        b.block.subarray(0, KIDS_FIRST_SECTION),
        null,
      ],
      ["graphics", bytes(a.save.graphics), bytes(b.save.graphics), null],
      ["data", bytes(a.save.data), bytes(b.save.data), KIDS_REGIONS],
      ["tail", bytes(a.save.tail), bytes(b.save.tail), null],
    ]
    : [["block", a.block, b.block, PLUS_REGIONS]];
  for (const [label, x, y, regions] of pairs) {
    if (!x || !y) {
      console.log(`${label}: missing on one side`);
      continue;
    }
    const ranges = coalesceDiffRanges(x, y) as [number, number][];
    console.log(
      `${label}: ${
        totalDiffBytes(ranges)
      } bytes differ in ${ranges.length} range${
        ranges.length === 1 ? "" : "s"
      }`,
    );
    for (const [start, last] of ranges) {
      const region = regions ? regionFor(regions, start) : null;
      console.log(
        `  ${hex(start)}-${hex(last + 1)} (${last + 1 - start})${
          region ? `  ${region.label}` : ""
        }`,
      );
    }
  }
} else if (command === "all") {
  const { path, parsed, save } = load(positional[0]);
  const dir = need("--out");
  report(path, parsed, save);
  await savePng(`${dir}/icon.png`, renderIcon(save), 8, "icon");
  await savePng(`${dir}/graphics.png`, renderGraphics(save), 1, "graphics");
  await savePng(`${dir}/palettes.png`, renderPalettes(save), 1, "palettes");
  const stages = save.game === "kids" ? save.map.length : save.stages.length;
  for (let s = 0; s < stages; s++) {
    await savePng(
      `${dir}/map-${s}.png`,
      renderMap(save, s),
      1,
      `map stage ${s}`,
    );
  }
  const name = save.game === "kids"
    ? kidsDisplayName(save)
    : PSX_GAMES.plus.title;
  await write(
    `${dir}/report.json`,
    new TextEncoder().encode(JSON.stringify(
      {
        file: path,
        game: save.game,
        name,
        title: save.header?.title,
        filename: save.filename,
        errors: save.errors,
        ...(save.game === "kids"
          ? {
            table: save.table,
            checksums: save.checksums,
            config: save.config?.bytes ? Array.from(save.config.bytes) : null,
            hiScores: save.hiScores,
          }
          : {
            checksums: save.checksums,
            hiScores: save.hiScores,
            settings: save.settings ? Array.from(save.settings.bytes) : null,
          }),
      },
      null,
      2,
    )),
  );
  console.log(`report.json -> ${dir}/report.json`);
} else if (command === "edit") {
  const { path, parsed, save, bytes } = load(positional[0]);
  const run: EditRun = {
    path,
    parsed,
    save,
    bytes,
    out: need("--out"),
    force: flags["--force"] === true,
    sets: repeated["--set"] ?? [],
  };
  // Not a warning and not overridable by --force, and true of both games: a
  // PS3 .psv carries a signature over the save in its 0x84-byte header, and
  // nothing in src/psx/ reads, checks or can regenerate it (memcard.js:214-219
  // slices past it and reads the filename). An edited one would be a file this
  // package reads back happily and a real PS3 rejects.
  if (parsed.container === "psv") {
    fail(
      `a .psv carries a signature this package cannot regenerate; convert it to a card image or an .mcs first`,
    );
  }
  if (sameFile(run.out, path)) {
    fail(`--out must name a different file; edit never writes over its input`);
  }
  const block = editableBlock(bytes, parsed, save);
  if (save.game === "kids") await editKids(run, block);
  else await editPlus(run, block);
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
