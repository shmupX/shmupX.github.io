// tools/sfc-sav — look inside a Super Famicom Dezaemon SRAM dump.
//
//   deno task sfc:probe report <sav> [--rom <sfc>] [--out <dir>]
//   deno task sfc:probe png <sav> palettes|graphics|map|scroll|groups
//                             --out <path> [--row N] [--stage N] [--scale N]
//   deno task sfc:probe hex <sav> --range A:B
//   deno task sfc:probe diff <a.sav> <b.sav>
//   deno task sfc:probe all <sav> [--rom <sfc>] --out <dir>
//
// The parser (packages/shmup-engine/src/sfc/) knows the regions the ROM's own
// map names; this is the way to look at what one particular dump holds — the
// per-region statistics that tell a full dump from a half one, the palette
// rows, the stage maps and scroll curves, the graphics bank when there is one.
// Saves and the ROM are never committed (dev-fixtures/ and
// packages/shmup-engine/fixtures/ are gitignored), so paths are given
// explicitly rather than discovered.

import { basename, dirname, extname, resolve } from "@std/path";
import {
  assemble2x2,
  coverage,
  flipTile,
  MAP_COLUMNS,
  parseSfcSav,
  regionFor,
  regionStats,
  type SfcSave,
  summarizeSfcSav,
  tilesToIndexed,
  withPaletteRow,
} from "../../packages/shmup-engine/src/sfc/index.js";
import { indexedToRgba } from "../../packages/shmup-engine/src/decode/decode-cg.js";
import {
  coalesceDiffRanges,
  totalDiffBytes,
} from "../../packages/shmup-engine/src/diff-ranges.js";
import { encodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const USAGE = `usage:
  sfc:probe report <sav> [--rom <sfc>] [--out <dir>]
  sfc:probe png <sav> palettes|graphics|map|scroll|groups --out <path>
                      [--row N] [--stage N] [--scale N]
  sfc:probe hex <sav> --range A:B
  sfc:probe diff <a.sav> <b.sav>
  sfc:probe all <sav> [--rom <sfc>] --out <dir>

  --rom     the Dezaemon ROM, to check its header, region table and default
            image against the save
  --row     palette row for graphics/groups renders (default 0)
  --stage   stage for map/scroll renders (default 0)
  --scale   integer upscale (default 1; map cells render at 4 px without
            graphics, 16 px with)
  --range   offsets, half-open, e.g. 0x7e8e:0x7fce`;

const args = [...Deno.args];
const command = args.shift();
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const VALUE_FLAGS = new Set([
  "--out",
  "--rom",
  "--row",
  "--stage",
  "--scale",
  "--range",
]);
const flags: Record<string, string | true> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg)) {
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    flags[arg] = value;
  } else if (arg.startsWith("--")) {
    flags[arg] = true;
  } else {
    positional.push(arg);
  }
}

function need(flag: string): string {
  const value = flags[flag];
  if (typeof value !== "string") fail(`${flag} is required`);
  return value;
}

function intFlag(flag: string, fallback: number): number {
  const value = flags[flag];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} wants a whole number`);
  return n;
}

function hex(n: number, width = 5): string {
  return "0x" + n.toString(16).padStart(width, "0");
}

async function write(path: string, bytes: Uint8Array) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
}

function loadSav(
  path: string | undefined,
): { path: string; bytes: Uint8Array } {
  if (!path) fail(`name a save file\n\n${USAGE}`);
  try {
    return { path, bytes: Deno.readFileSync(path) };
  } catch (err) {
    return fail(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function loadRom(): Uint8Array | null {
  const path = flags["--rom"];
  if (typeof path !== "string") return null;
  try {
    return Deno.readFileSync(path);
  } catch (err) {
    return fail(`cannot read ROM ${path}: ${(err as Error).message}`);
  }
}

function parse(bytes: Uint8Array): SfcSave {
  const parsed = parseSfcSav(bytes, { rom: loadRom() });
  if (!parsed.isSfcSav) {
    console.error(
      `warning: ${parsed.size} bytes, check string ${
        JSON.stringify(parsed.checkString)
      } — not a Dezaemon SRAM dump by size or magic; decoding anyway`,
    );
  }
  return parsed;
}

// --- rasters ------------------------------------------------------------------

type Rgba = [number, number, number, number];

function fill(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Rgba,
) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const at = ((y + dy) * r.width + x + dx) * 4;
      r.data[at] = c[0];
      r.data[at + 1] = c[1];
      r.data[at + 2] = c[2];
      r.data[at + 3] = c[3];
    }
  }
}

function blit(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: Uint8ClampedArray,
) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const from = (dy * w + dx) * 4;
      const to = ((y + dy) * r.width + x + dx) * 4;
      for (let c = 0; c < 4; c++) r.data[to + c] = rgba[from + c];
    }
  }
}

function upscale(r: Raster, scale: number): Raster {
  if (scale <= 1) return r;
  const out = newRaster(r.width * scale, r.height * scale);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = (Math.floor(y / scale) * r.width + Math.floor(x / scale)) *
        4;
      const to = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[to + c] = r.data[from + c];
    }
  }
  return out;
}

/** A distinct, stable colour per chip index, for maps drawn without graphics. */
function hashColor(index: number, flagged: boolean): Rgba {
  const hue = (index * 137.508) % 360;
  const s = 0.65;
  const v = flagged ? 0.55 : 0.95;
  const c = v * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
    255,
  ];
}

function renderPalettes(parsed: SfcSave): Raster {
  const rows = parsed.palettes?.rows ?? [];
  const cell = 8;
  const out = newRaster(16 * cell, rows.length * cell);
  rows.forEach((row, y) => {
    row.colors.forEach((color, x) => {
      fill(out, x * cell, y * cell, cell, cell, [
        color.r,
        color.g,
        color.b,
        255,
      ]);
    });
  });
  return out;
}

/** The graphics bank, the tile groups and the palettes — all three, or nothing to draw. */
function art(parsed: SfcSave) {
  const { graphics, groups, palettes } = parsed;
  if (!graphics || graphics.blank || !groups || !palettes) return null;
  return { tiles: graphics.tiles, groups, palettes: palettes.palettes };
}

function renderGraphics(parsed: SfcSave, row: number): Raster | null {
  const a = art(parsed);
  if (!a) return null;
  const sheet = tilesToIndexed(a.tiles, 16);
  const rgba = indexedToRgba(withPaletteRow(sheet.indices, row), a.palettes);
  const out = newRaster(sheet.width, sheet.height);
  out.data.set(rgba);
  return out;
}

type QuadEntry = {
  tile: number;
  hflip: boolean;
  vflip: boolean;
  empty: boolean;
};

/**
 * One 16x16 object from a quad of tilemap words, reading tile numbers as
 * indices into the flat graphics bank. The bank's real layout is open
 * (FORMAT-SFC.md "GRAPIC DATA"), so this is a probe's guess, not a decode.
 */
function quadRgba(
  a: NonNullable<ReturnType<typeof art>>,
  entries: QuadEntry[],
  row: number,
): Uint8ClampedArray {
  const blank = new Uint8Array(64);
  const pieces = entries.map((e) =>
    e.empty || e.tile >= a.tiles.length
      ? blank
      : flipTile(a.tiles[e.tile], e.hflip, e.vflip)
  );
  return indexedToRgba(withPaletteRow(assemble2x2(pieces), row), a.palettes);
}

function renderMap(parsed: SfcSave, stage: number, row: number): Raster {
  const map = parsed.maps?.[stage];
  if (!map) return fail(`stage ${stage} did not decode`);
  const a = art(parsed);
  const cell = a ? 16 : 4;
  const out = newRaster(map.columns * cell, map.rows * cell);
  for (let i = 0; i < map.cells.length; i++) {
    const v = map.cells[i];
    if (!v) continue;
    const x = (i % MAP_COLUMNS) * cell;
    const y = Math.floor(i / MAP_COLUMNS) * cell;
    if (a) {
      const chip = a.groups.map[v & 0x7f];
      if (chip) blit(out, x, y, 16, 16, quadRgba(a, chip.entries, row));
    } else {
      fill(out, x, y, cell, cell, hashColor(v & 0x7f, (v & 0x80) !== 0));
    }
  }
  return out;
}

function renderScroll(parsed: SfcSave, stage: number): Raster {
  const scroll = parsed.scroll?.[stage];
  if (!scroll) return fail(`stage ${stage} scroll table did not decode`);
  const out = newRaster(scroll.bytes.length, 256);
  fill(out, 0, 0, out.width, out.height, [16, 16, 24, 255]);
  for (let x = 0; x < scroll.bytes.length; x++) {
    fill(out, x, 255 - scroll.bytes[x], 1, 1, [255, 220, 80, 255]);
  }
  return out;
}

/** The GROUP tables as rows of 16x16 objects: ship, title, ending, bosses, enemies. */
function renderGroups(parsed: SfcSave, row: number): Raster | null {
  const a = art(parsed);
  if (!a) return null;
  const g = a.groups;
  const lines: { entries: QuadEntry[] }[][] = [
    g.myShip,
    g.title,
    g.ending,
    ...g.boss.map((b) => b.quads),
    ...g.enemy.map((e) => e.quads),
  ];
  const cols = Math.max(...lines.map((l) => l.length));
  const out = newRaster(cols * 16, lines.length * 16);
  lines.forEach((line, y) => {
    line.forEach((quad, x) =>
      blit(out, x * 16, y * 16, 16, 16, quadRgba(a, quad.entries, row))
    );
  });
  return out;
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

function countKinds(quads: { kind: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of quads) {
    const kind = q.kind ?? "other";
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function reportOf(path: string, parsed: SfcSave, bytes: Uint8Array) {
  const stats = regionStats(bytes);
  const arr = (view: Uint8Array) => Array.from(view);
  return {
    file: basename(path),
    size: parsed.size,
    sizeOk: parsed.sizeOk,
    complete: parsed.complete,
    checkString: parsed.checkString,
    checkStringOk: parsed.checkStringOk,
    segments: parsed.segments.map((s) => ({
      bank: hex(s.bank, 2),
      offset: hex(s.offset),
      present: s.present,
      blank: s.blank,
    })),
    checksum: parsed.checksum
      ? {
        copyMatches: parsed.checksum.equal,
        words: Array.from(parsed.checksum.words, (w) => hex(w, 4)),
      }
      : null,
    coverage: coverage(),
    regions: stats.map((s) => ({
      ...s,
      offset: hex(s.offset),
      end: hex(s.end),
      entropy: Number(s.entropy.toFixed(3)),
      zeroRatio: Number(s.zeroRatio.toFixed(3)),
      ffRatio: Number(s.ffRatio.toFixed(3)),
    })),
    palettes: parsed.palettes
      ? {
        rows: parsed.palettes.rows.length,
        colorRows: parsed.palettes.colorRowCount,
      }
      : null,
    config: parsed.config
      ? {
        titleType: parsed.config.titleType,
        mouseSpeed: parsed.config.mouseSpeed,
        editBgm: parsed.config.editBgm,
        bgmPatch: arr(parsed.config.bgmPatch),
        keyConfig: arr(parsed.config.keyConfig),
      }
      : null,
    hiScores: parsed.hiScores?.map((h) => ({
      rank: h.rank,
      score: h.score,
      name: h.name,
    })) ?? null,
    maps: parsed.maps?.map((m) => ({
      stage: m.stage,
      used: m.used,
      flagged: m.flagged,
      maxChip: m.maxChip,
    })) ?? null,
    scroll: parsed.scroll?.map((s) => ({
      stage: s.stage,
      min: s.min,
      max: s.max,
    })) ?? null,
    groups: parsed.groups
      ? {
        mapKinds: countKinds(parsed.groups.map),
        enemyKinds: countKinds(parsed.groups.enemy.flatMap((e) => e.quads)),
        bossKinds: countKinds(parsed.groups.boss.flatMap((b) => b.quads)),
        titleKinds: countKinds(parsed.groups.title),
        myShipKinds: countKinds(parsed.groups.myShip),
      }
      : null,
    enemiesInUse: parsed.enemies?.filter((e) => !e.blank).length ?? null,
    appearUsed: parsed.appear?.map((a) => a.used) ?? null,
    graphics: parsed.graphics
      ? {
        present: parsed.graphics.present,
        blank: parsed.graphics.blank,
        usedCount: parsed.graphics.usedCount,
      }
      : null,
    rom: parsed.rom
      ? {
        title: parsed.rom.header.title,
        sramSizeBytes: parsed.rom.header.sramSizeBytes,
        headerValid: parsed.rom.header.valid,
        isDezaemon: parsed.rom.isDezaemon,
        regionTableRows: parsed.rom.regionTable.length,
        regionTableMatches: parsed.rom.regionTableMatches,
        defaultImage: parsed.rom.defaultImage,
      }
      : null,
    errors: parsed.errors,
  };
}

function printRegionTable(bytes: Uint8Array) {
  console.log(
    "  range            label            conf.      entropy  zero  0xFF",
  );
  for (const s of regionStats(bytes)) {
    const state = !s.present ? "absent" : s.blank ? "blank" : "";
    console.log(
      `  ${hex(s.offset)}-${hex(s.end)}  ${s.label.padEnd(15)}  ${
        s.confidence.padEnd(9)
      }  ${s.entropy.toFixed(2).padStart(5)}  ${
        (s.zeroRatio * 100).toFixed(0).padStart(3)
      }%  ${(s.ffRatio * 100).toFixed(0).padStart(3)}%  ${state}`,
    );
  }
}

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

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

const encoder = new TextEncoder();

// --- commands -----------------------------------------------------------------

if (command === "report") {
  const { path, bytes } = loadSav(positional[0]);
  const parsed = parse(bytes);
  console.log(`${basename(path)}:`);
  console.log(indent(summarizeSfcSav(parsed)));
  printRegionTable(bytes);
  if (typeof flags["--out"] === "string") {
    const out = resolve(flags["--out"], "report.json");
    await write(
      out,
      encoder.encode(
        JSON.stringify(reportOf(path, parsed, bytes), null, 2) + "\n",
      ),
    );
    console.log(`  -> ${out}`);
  }
} else if (command === "png") {
  const { bytes } = loadSav(positional[0]);
  const what = positional[1];
  if (!what) {
    fail(`say what to draw: palettes|graphics|map|scroll|groups\n\n${USAGE}`);
  }
  const parsed = parse(bytes);
  const out = need("--out");
  const scale = Math.max(1, intFlag("--scale", 1));
  const row = intFlag("--row", 0);
  const stage = intFlag("--stage", 0);
  const noArt =
    "graphics segment is blank or absent in this dump — nothing to draw";
  if (what === "palettes") {
    await savePng(out, renderPalettes(parsed), scale, "palette rows");
  } else if (what === "graphics") {
    const raster = renderGraphics(parsed, row);
    if (!raster) console.log(noArt);
    else {await savePng(
        out,
        raster,
        scale,
        `graphics bank through palette row ${row}`,
      );}
  } else if (what === "map") {
    const how = art(parsed)
      ? "chips through the graphics bank"
      : "chip indices as colours; graphics blank";
    await savePng(
      out,
      renderMap(parsed, stage, row),
      scale,
      `stage ${stage} map (${how})`,
    );
  } else if (what === "scroll") {
    await savePng(
      out,
      renderScroll(parsed, stage),
      scale,
      `stage ${stage} scroll table`,
    );
  } else if (what === "groups") {
    const raster = renderGroups(parsed, row);
    if (!raster) console.log(noArt);
    else {await savePng(
        out,
        raster,
        scale,
        `group tables through palette row ${row}`,
      );}
  } else {
    fail(`unknown render ${what}\n\n${USAGE}`);
  }
} else if (command === "hex") {
  const { bytes } = loadSav(positional[0]);
  const range = need("--range").split(":");
  if (range.length !== 2) fail("--range wants A:B");
  const [from, to] = range.map((s) => Number(s));
  if (
    !Number.isInteger(from) || !Number.isInteger(to) || from < 0 ||
    to > bytes.length || from >= to
  ) {
    fail(
      `--range ${
        need("--range")
      } is not a half-open range inside ${bytes.length} bytes`,
    );
  }
  const region = regionFor(from);
  console.log(
    `${hex(from)}-${hex(to)}${
      region ? `  (${region.label}, ${region.confidence})` : ""
    }`,
  );
  console.log(hexdump(bytes, from, to));
} else if (command === "diff") {
  const a = loadSav(positional[0]);
  const b = loadSav(positional[1]);
  const ranges = coalesceDiffRanges(a.bytes, b.bytes, 8);
  const sizes = a.bytes.length !== b.bytes.length
    ? ` (sizes ${a.bytes.length} / ${b.bytes.length})`
    : "";
  console.log(
    `${basename(a.path)} vs ${basename(b.path)}: ${ranges.length} ranges, ${
      totalDiffBytes(ranges)
    } bytes differ${sizes}`,
  );
  for (const [start, end] of ranges) {
    const region = regionFor(start);
    console.log(
      `  ${hex(start)}-${hex(end + 1)}  ${
        String(end - start + 1).padStart(6)
      } B  ${region ? region.label : "?"}`,
    );
  }
} else if (command === "all") {
  const { path, bytes } = loadSav(positional[0]);
  const parsed = parse(bytes);
  const dir = need("--out");
  const stem = basename(path, extname(path));
  console.log(`${stem}:`);
  console.log(indent(summarizeSfcSav(parsed)));
  await write(
    resolve(dir, "report.json"),
    encoder.encode(
      JSON.stringify(reportOf(path, parsed, bytes), null, 2) + "\n",
    ),
  );
  await write(
    resolve(dir, "summary.txt"),
    encoder.encode(summarizeSfcSav(parsed) + "\n"),
  );
  await savePng(
    resolve(dir, "palettes.png"),
    renderPalettes(parsed),
    4,
    "palette rows",
  );
  for (let s = 0; s < (parsed.maps?.length ?? 0); s++) {
    await savePng(
      resolve(dir, `map-stage${s}.png`),
      renderMap(parsed, s, 0),
      1,
      `stage ${s} map`,
    );
    await savePng(
      resolve(dir, `scroll-stage${s}.png`),
      renderScroll(parsed, s),
      1,
      `stage ${s} scroll table`,
    );
  }
  const graphics = renderGraphics(parsed, 0);
  if (graphics) {
    await savePng(
      resolve(dir, "graphics-row0.png"),
      graphics,
      2,
      "graphics bank",
    );
  } else {console.log(
      "  graphics segment is blank or absent — no graphics/groups renders",
    );}
  const groups = renderGroups(parsed, 0);
  if (groups) {
    await savePng(resolve(dir, "groups-row0.png"), groups, 2, "group tables");
  }
  console.log(`  -> ${resolve(dir)}`);
} else {
  fail(`unknown command ${command}\n\n${USAGE}`);
}
