// Render a save's boss chambers under the legacy and current flip
// conventions, side by side, as PNGs.
//
// This exists because the background tilemap's flip bits were documented
// backwards until 2026-08-27: the decoder read bit15 as H-flip / bit14 as
// V-flip, when the map (like the sprite composition banks) is really
// bit15 = V / bit14 = H. Every mirror-symmetric backdrop came out garbled —
// the tiles beside a boss showed up in the wrong order and upside down.
//
// Each output PNG puts the legacy decoding on the left and whatever
// decodeStageBackground() currently produces on the right. The right side
// calls the shipped decoder rather than re-implementing the bit math, so if
// the convention is ever flipped back the two halves match and the
// regression is visible at a glance. A correct render shows coherent
// left-right-mirrored architecture; the legacy one breaks the mirror.
//
// Ramsie is the reference save — its stage 0 goddess chamber, stage 3 vine
// pillars and stage 4 mandala are all strongly symmetric:
//
//   deno run -A dev-fixtures/debug-tools/render-chamber.ts \
//     "static/editor/dezaemon/saves/Dez 2 - Ramsie.sav" /tmp/chambers
//
// Saves are not in the repo (see .gitignore); point it at a local one.
import { encodePNG } from "jsr:@img/png@^0.1.6";
import { normalize } from "../../packages/shmup-engine/src/bup-source.js";
import { parse } from "../../packages/shmup-engine/src/bup-parse.js";
import { parseSectionTable } from "../../packages/shmup-engine/src/payload-table.js";
import { decompress } from "../../packages/shmup-engine/src/decompress.js";
import {
  BG_COLS,
  decodeStageBackground,
  decodeStagePlacement,
  MAX_STAGES,
  SEC5_REGIONS,
} from "../../packages/shmup-engine/src/decode/decode-stage.js";
import { decodePalettes } from "../../packages/shmup-engine/src/decode/decode-cg.js";

const TILE = 16;
const GAP = 8; // grey divider between the two renders
const ROWS_ABOVE = 20; // map rows to show before the boss row
const ROWS_BELOW = 44; // and after

const savePath = Deno.args[0];
const outDir = Deno.args[1] ?? ".";
if (!savePath) {
  console.error(
    "usage: render-chamber.ts <save.sav> [outDir]",
  );
  Deno.exit(2);
}

// The engine modules are plain JS, so spell out the two shapes used here.
type Entry = { payload: { buffer: Uint8Array } | null };
type Section = { offset: number; size: number };

// A save file can hold several backup-RAM entries; the game is the big one.
const { data } = await normalize(await Deno.readFile(savePath));
const entries = (parse(data) as Entry[])
  .filter((s): s is Entry & { payload: { buffer: Uint8Array } } =>
    !!s.payload && s.payload.buffer.length > 10000
  )
  .sort((a, b) => b.payload.buffer.length - a.payload.buffer.length);
if (!entries.length) {
  console.error(`${savePath}: no game-sized save entry found`);
  Deno.exit(1);
}
const payload = entries[0].payload.buffer;

const sections = parseSectionTable(payload).sections as Section[];
const section = (i: number) => {
  const s = sections[i];
  return decompress(payload.subarray(s.offset, s.offset + s.size));
};
const cgPages = [section(0), section(1), section(2), section(3)];
const palettes = decodePalettes(section(4));
const sec5 = section(5);

// One 16x16 CG cell out of the 1024-cell space (4 pages x 256 cells).
const cellBytes = (index: number) => {
  const page = cgPages[index >> 8];
  const cell = index & 0xff;
  return page.subarray(cell * 256, cell * 256 + 256);
};

function drawTile(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  px: number,
  py: number,
  bytes: Uint8Array,
  hflip: boolean,
  vflip: boolean,
) {
  for (let y = 0; y < TILE; y++) {
    const sy = vflip ? TILE - 1 - y : y;
    for (let x = 0; x < TILE; x++) {
      const sx = hflip ? TILE - 1 - x : x;
      const b = bytes[sy * TILE + sx];
      const o = ((py + y) * canvasWidth + px + x) * 4;
      if (b === 0) {
        rgba[o + 3] = 255; // transparent CG pixel -> black backdrop
        continue;
      }
      const color = palettes[b >> 4].colors[b & 0x0f];
      rgba[o] = color.r;
      rgba[o + 1] = color.g;
      rgba[o + 2] = color.b;
      rgba[o + 3] = 255;
    }
  }
}

await Deno.mkdir(outDir, { recursive: true });
const stem = savePath.replace(/^.*[/\\]/, "").replace(/\.[^.]*$/, "")
  .replace(/[^\w.-]+/g, "-");
const { offset, stride } = SEC5_REGIONS.stageBanks;
let written = 0;

for (let stage = 0; stage < MAX_STAGES; stage++) {
  const boss = decodeStagePlacement(sec5, stage).boss;
  if (!boss) continue;
  // The shipped decoder's own view of this stage, for the right-hand render.
  const decoded = decodeStageBackground(sec5, stage);

  const firstRow = Math.max(0, boss.row - ROWS_ABOVE);
  const lastRow = Math.min(decoded.rows, boss.row + ROWS_BELOW);
  const rows = lastRow - firstRow;
  const width = BG_COLS * TILE * 2 + GAP;
  const height = rows * TILE;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = BG_COLS * TILE; x < BG_COLS * TILE + GAP; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 64;
      rgba[o + 1] = 64;
      rgba[o + 2] = 64;
      rgba[o + 3] = 255;
    }
  }

  const base = offset + stage * stride;
  const rightX = BG_COLS * TILE + GAP;
  for (let r = firstRow; r < lastRow; r++) {
    for (let c = 0; c < BG_COLS; c++) {
      const i = r * BG_COLS + c;
      const word = (sec5[base + i * 2] << 8) | sec5[base + i * 2 + 1];
      if (word === 0xffff) continue;
      const bytes = cellBytes(word & 0x3ff);
      const py = (r - firstRow) * TILE;
      // Left: the legacy convention (bit15 = H, bit14 = V).
      drawTile(
        rgba,
        width,
        c * TILE,
        py,
        bytes,
        (word & 0x8000) !== 0,
        (word & 0x4000) !== 0,
      );
      // Right: whatever the decoder says today.
      const tile = decoded.tiles[i];
      if (!tile) continue;
      drawTile(
        rgba,
        width,
        rightX + c * TILE,
        py,
        cellBytes(tile.cell),
        tile.hflip,
        tile.vflip,
      );
    }
  }

  const png = await encodePNG(new Uint8Array(rgba.buffer), {
    width,
    height,
    compression: 0,
    filter: 0,
    interlace: 0,
  });
  const out = `${outDir}/${stem}-stage${stage}-row${boss.row}.png`;
  await Deno.writeFile(out, png);
  written++;
  console.log(
    `stage ${stage}: boss row ${boss.row}, size class ${boss.sizeClass} -> ${out}`,
  );
}

if (!written) console.log("no stage in this save places a boss");
