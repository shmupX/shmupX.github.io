// Render a Dezaemon 2 save's stage background tilemap to PNG so the map can
// be compared against hardware captures: the full map strip (row 0 at the
// bottom, like the scroll), plus a 480px crop around the boss placement row
// (the boss chamber) when the stage defines one.
//
//   node dev-fixtures/debug-tools/dump-bg.mjs <save.sav> [options]
//
// Options:
//   --stage <n>   stage to render (default 0)
//   --out <dir>   output directory (default ./bg-dump)
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

const USAGE = "usage: dump-bg.mjs <save.sav> [--stage n] [--out dir]";
const VALUE_FLAGS = new Set(["stage", "out"]);
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
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
const OUT = flags.out ?? "./bg-dump";

const { normalize } = await import(path.join(LIB, "lib/bup-source.js"));
const bup = await import(path.join(LIB, "lib/bup-parse.js"));
const { isGameSave } = await import(path.join(LIB, "lib/payload-table.js"));
const { decodeSave } = await import(path.join(LIB, "lib/decode/index.js"));
const { PNG } = await import(path.join(LIB, "node_modules/pngjs/lib/png.js"));

const { data } = await normalize(fs.readFileSync(input));
const saves = bup.parse(data);
const save = saves.find(isGameSave) || saves[0];
const decoded = decodeSave(save.payload.buffer);

const bgStage = decoded.bgStages[STAGE];
if (!bgStage) {
  console.error(`stage ${STAGE} has no background`);
  process.exit(1);
}
const cells = decoded.bgCells;
const bossRow = decoded.stages[STAGE] && decoded.stages[STAGE].boss
  ? decoded.stages[STAGE].boss.row
  : null;
console.log(
  `stage ${STAGE}: ${bgStage.rows} rows x ${bgStage.cols} cols, ` +
    `${cells.length} distinct cells, boss row ${bossRow}`,
);

const TILE = 16;
const W = bgStage.cols * TILE;
const H = bgStage.rows * TILE;
const png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) png.data[i * 4 + 3] = 255; // black base
for (let r = 0; r < bgStage.rows; r++) {
  for (let c = 0; c < bgStage.cols; c++) {
    const word = bgStage.words[r * bgStage.cols + c];
    if (word === 0xffff) continue;
    const cell = cells[word & 0x3ff];
    if (!cell) continue;
    const hflip = (word & 0x8000) !== 0;
    const vflip = (word & 0x4000) !== 0;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const sx = hflip ? TILE - 1 - x : x;
        const sy = vflip ? TILE - 1 - y : y;
        const src = (sy * cell.w + sx) * 4;
        if (!cell.rgba[src + 3]) continue;
        // map row 0 at the BOTTOM, matching the scroll direction
        const dy = (bgStage.rows - 1 - r) * TILE + y;
        const dst = (dy * W + c * TILE + x) * 4;
        png.data[dst] = cell.rgba[src];
        png.data[dst + 1] = cell.rgba[src + 1];
        png.data[dst + 2] = cell.rgba[src + 2];
        png.data[dst + 3] = 255;
      }
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
const name = `stage${STAGE}-map.png`;
fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
console.log("wrote", name, `(${W}x${H})`);

function crop(y0, h, cropName) {
  const p = new PNG({ width: W, height: h });
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= H) continue;
    png.data.copy(p.data, y * W * 4, sy * W * 4, (sy + 1) * W * 4);
  }
  fs.writeFileSync(path.join(OUT, cropName), PNG.sync.write(p));
  console.log("wrote", cropName);
}
if (bossRow !== null) {
  const bossRowY = (bgStage.rows - 1 - bossRow) * TILE;
  crop(bossRowY - 240, 480, `stage${STAGE}-boss-chamber.png`);
}
