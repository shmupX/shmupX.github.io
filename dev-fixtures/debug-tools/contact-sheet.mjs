// Render a labeled CONTACT SHEET of a Dezaemon 2 save's enemy roster — one
// cell per record, stamped with its record index — so a capture's creatures
// can be matched to the records that drive them ("which index is the statue
// that never moves?").
//
//   node dev-fixtures/debug-tools/contact-sheet.mjs <save.sav> [options]
//
// Options:
//   --stage <n>       stage whose placed records are drawn (default 0)
//   --enemies a,b,c   draw exactly these record indices instead
//   --frames          draw EVERY frame of each record, not just the first
//   --out <file>      output PNG (default ./contact-sheet.png)
//   --scale <n>       integer upscale factor (default 3)
//
// Cells are ordered by first spawn row (the order they appear in play), so
// reading the sheet left-to-right walks the stage. dump-behavior.mjs prints
// the matching attribute table for the same indices.
//
// The decoder lives in the 2019-es7 sibling checkout; point somewhere else
// with CMG_ES7_ROOT (same convention as scripts/vendor-dezaemon-import.ts).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CMG_ROOT = path.resolve(HERE, "..", "..");
const ES7_ROOT = process.env.CMG_ES7_ROOT ??
  ["2019-es7-0822", "2019-es7"]
    .map((d) => path.resolve(CMG_ROOT, "..", d))
    .find((d) =>
      fs.existsSync(path.join(d, "tools", "dezaemon-import", "lib"))
    );
if (!ES7_ROOT) {
  console.error(
    "2019-es7 checkout with tools/dezaemon-import not found — set CMG_ES7_ROOT",
  );
  process.exit(1);
}
const LIB = path.join(ES7_ROOT, "tools", "dezaemon-import");

const USAGE =
  "usage: contact-sheet.mjs <save.sav> [--stage n] [--enemies a,b,c] [--frames] [--out file] [--scale n]";
const VALUE_FLAGS = new Set(["stage", "enemies", "out", "scale"]);
const BOOL_FLAGS = new Set(["frames"]);
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = args[i + 1];
    if (!VALUE_FLAGS.has(name) || value === undefined) {
      console.error(`bad option: ${a}\n${USAGE}`);
      process.exit(2);
    }
    flags[name] = value;
    i++;
  } else {
    positional.push(a);
  }
}
const input = positional[0];
if (!input) {
  console.error(USAGE);
  process.exit(2);
}
const STAGE = Number(flags.stage ?? 0);
const OUT = flags.out ?? "./contact-sheet.png";
const SCALE = Number(flags.scale ?? 3);

const { normalize } = await import(path.join(LIB, "lib/bup-source.js"));
const bup = await import(path.join(LIB, "lib/bup-parse.js"));
const { isGameSave } = await import(path.join(LIB, "lib/payload-table.js"));
const { decodeSave } = await import(path.join(LIB, "lib/decode/index.js"));
const { PNG } = await import(path.join(LIB, "node_modules/pngjs/lib/png.js"));

const { data } = await normalize(fs.readFileSync(input));
const saves = bup.parse(data);
const save = saves.find(isGameSave) || saves[0];
const decoded = decodeSave(save.payload.buffer);

// Which records to draw: an explicit list, else everything the stage places,
// in first-spawn order.
let indices;
if (flags.enemies) {
  indices = flags.enemies.split(",").filter(Boolean).map(Number);
} else {
  const stage = decoded.stages[STAGE];
  if (!stage) {
    console.error(`save has no stage ${STAGE}`);
    process.exit(3);
  }
  const firstRow = new Map();
  stage.rows.forEach((row, ri) => {
    const srcRow = stage.waveRows ? stage.waveRows[ri] : ri;
    row.forEach((cell) => {
      if (!cell) return;
      if (!firstRow.has(cell.enemy) || srcRow < firstRow.get(cell.enemy)) {
        firstRow.set(cell.enemy, srcRow);
      }
    });
  });
  indices = [...firstRow.entries()].sort((a, b) => a[1] - b[1]).map((e) =>
    e[0]
  );
}
if (!indices.length) {
  console.error("nothing to draw");
  process.exit(3);
}

// Every cell to render: {label, sprite}. --frames expands a record into its
// whole animation, labeled "<idx>.<frame>".
const cells = [];
for (const idx of indices) {
  const e = decoded.enemies[idx];
  const keys = (e && e.spriteKeys) || [];
  const picks = flags.frames ? keys : keys.slice(0, 1);
  if (!picks.length) cells.push({ label: String(idx), sprite: null });
  for (let i = 0; i < picks.length; i++) {
    const sk = picks[i];
    cells.push({
      label: flags.frames ? `${idx}.${i}` : String(idx),
      sprite: typeof sk === "number" ? decoded.sprites[sk] : null,
    });
  }
}

// 3x5 digit glyphs (plus "." separator) so each cell says which record it is
// without a font dependency.
const GLYPHS = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"],
};

const LABEL_H = 7; // 5px glyphs + 1px padding above and below
const CELL = Math.max(
      ...cells.map((c) => (c.sprite ? Math.max(c.sprite.w, c.sprite.h) : 8)),
    ) *
    SCALE + LABEL_H + 2;
const COLS = Math.min(8, cells.length);
const ROWS = Math.ceil(cells.length / COLS);
const png = new PNG({ width: COLS * CELL, height: ROWS * CELL });
// Flat slate ground: light enough to read dark sprites, dark enough for pale
// ones (this roster is mostly bone-white statues on black scenery).
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = 38;
  png.data[i + 1] = 38;
  png.data[i + 2] = 50;
  png.data[i + 3] = 255;
}

function put(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const d = (y * png.width + x) * 4;
  png.data[d] = r;
  png.data[d + 1] = g;
  png.data[d + 2] = b;
  png.data[d + 3] = 255;
}

function drawLabel(text, ox, oy) {
  let cx = ox;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] === "1") put(cx + gx, oy + gy, 255, 220, 90);
      }
    }
    cx += 4;
  }
}

cells.forEach((cell, k) => {
  const ox = (k % COLS) * CELL;
  const oy = Math.floor(k / COLS) * CELL;
  drawLabel(cell.label, ox + 2, oy + 1);
  const s = cell.sprite;
  if (!s) return;
  const top = oy + LABEL_H;
  for (let y = 0; y < s.h && y * SCALE < CELL - LABEL_H; y++) {
    for (let x = 0; x < s.w && x * SCALE < CELL; x++) {
      const src = (y * s.w + x) * 4;
      if (s.rgba[src + 3] === 0) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          put(
            ox + x * SCALE + dx,
            top + y * SCALE + dy,
            s.rgba[src],
            s.rgba[src + 1],
            s.rgba[src + 2],
          );
        }
      }
    }
  }
});

fs.writeFileSync(OUT, PNG.sync.write(png));
console.log(
  `wrote ${OUT} — ${cells.length} cells (${COLS}x${ROWS}), records: ${
    indices.join(",")
  }`,
);
