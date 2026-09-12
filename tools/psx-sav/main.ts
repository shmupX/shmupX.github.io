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
//
// The parser is packages/shmup-engine/src/psx/ and the notes are FORMAT-PSX.md.
// Both games' maps render as the real thing: a Kids! stage is 7 chips of 32x32
// px drawn from the save's CG cells through the disc's fixed palette bank, and
// a Dezaemon+ stage is 16 chips of 16x16 px drawn through the stage's MAP
// GROUP table into the save's own 4bpp graphics bank and palette row. Saves
// are community content and are never committed.

import { basename, dirname } from "@std/path";
import {
  coalesceDiffRanges,
  totalDiffBytes,
} from "../../packages/shmup-engine/src/diff-ranges.js";
import { rgb555ToRgb } from "../../packages/shmup-engine/src/decode/decode-cg.js";
import {
  decodeKidsChip,
  decodePlusAppear,
  decodePlusEnemyData,
  decodePlusMapGroup,
  KIDS_CHIP_DIM,
  KIDS_MAP_COLUMNS,
  KIDS_MAP_ROWS,
  KIDS_REGIONS,
  kidsCell,
  kidsDisplayName,
  kidsPalette,
  parsePsxSav,
  PLUS_CHIP_DIM,
  PLUS_GRAPHICS_WIDTH,
  PLUS_MAP_COLUMNS,
  PLUS_MAP_ROWS,
  PLUS_REGIONS,
  PLUS_STAGE_LAYOUT,
  plusGroupRegions,
  plusPaletteRow,
  PSX_GAMES,
  summarizePsxSav,
} from "../../packages/shmup-engine/src/psx/index.js";
import { encodePng, newRaster, type Raster } from "../../lib/ps2/png.ts";

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

  --stage   stage for map renders (default 0)
  --page    Kids! CG page for graphics renders (default: all four side by side)
  --row     Dezaemon+ palette row for graphics renders (default: the map's own)
  --rows    map rows to draw (default: all of them)
  --scale   integer upscale (default 1; icons default to 8)
  --range   offsets, half-open, e.g. 0x10100:0x10400
  --section which part of a Kids! save --range addresses (default header, the
            raw file; graphics and data are the decompressed sections)`;

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
const flags: Record<string, string | true> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg)) {
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    flags[arg] = value;
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

// deno-lint-ignore no-explicit-any
type Save = any;
interface Parsed {
  container: string;
  card: { files: { filename: string; data: Uint8Array }[] } | null;
  saves: Save[];
  others: { filename: string; size: number }[];
  errors: { block: string; message: string }[];
}

function load(
  path: string | undefined,
): { path: string; parsed: Parsed; save: Save; block: Uint8Array } {
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
  return { path, parsed, save: parsed.saves[0], block: blockOf(bytes, parsed) };
}

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
      console.log(
        `    stage ${s.stage}: ship speed ${s.shipSpeed}, background set ${s.backgroundSet}${
          s.last ? ", LAST" : ""
        }`,
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
    ? [
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
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
