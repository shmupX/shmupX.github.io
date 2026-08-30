// Render a Dezaemon 2 save's boss-related sprites to PNGs for visual
// inspection: the boss core (or figure-piece fallback) frames and every part
// the boss trailer's fire points spawn, plus (with --records) any slice of
// the zako/large record bank.
//
//   node dev-fixtures/debug-tools/dump-sprites.mjs <save.sav> [options]
//
// Options:
//   --stage <n>     stage whose boss/bank to render (default 0)
//   --out <dir>     output directory (default ./sprite-dump)
//   --scale <n>     integer upscale factor (default 4)
//   --records a-b   also render records a..b of the stage's bank (e.g. 48-59)
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
  "usage: dump-sprites.mjs <save.sav> [--stage n] [--out dir] [--scale n] [--records a[-b]]";
const VALUE_FLAGS = new Set(["stage", "out", "scale", "records"]);
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
const OUT = flags.out ?? "./sprite-dump";
const SCALE = Number(flags.scale ?? 4);
const RECORDS = flags.records ?? null;

const { normalize } = await import(path.join(LIB, "lib/bup-source.js"));
const bup = await import(path.join(LIB, "lib/bup-parse.js"));
const { isGameSave } = await import(path.join(LIB, "lib/payload-table.js"));
const { decodeSave } = await import(path.join(LIB, "lib/decode/index.js"));
const sprites = await import(path.join(LIB, "lib/decode/decode-sprites.js"));
const { PNG } = await import(path.join(LIB, "node_modules/pngjs/lib/png.js"));

const { data } = await normalize(fs.readFileSync(input));
const saves = bup.parse(data);
const save = saves.find(isGameSave) || saves[0];
const decoded = decodeSave(save.payload.buffer);

fs.mkdirSync(OUT, { recursive: true });

function writeRgba(name, w, h, rgba) {
  const png = new PNG({ width: w * SCALE, height: h * SCALE });
  for (let y = 0; y < h * SCALE; y++) {
    for (let x = 0; x < w * SCALE; x++) {
      const src = ((y / SCALE | 0) * w + (x / SCALE | 0)) * 4;
      const dst = (y * w * SCALE + x) * 4;
      for (let c = 0; c < 4; c++) png.data[dst + c] = rgba[src + c];
    }
  }
  fs.writeFileSync(path.join(OUT, name + ".png"), PNG.sync.write(png));
  console.log("wrote", name + ".png");
}

function writeSprite(idx, prefix) {
  const s = decoded.sprites[idx];
  if (s) writeRgba(`${prefix}_${idx}_${s.key}`, s.w, s.h, s.rgba);
}

const boss = decoded.bosses.find((b) => b.stage === STAGE);
if (boss) {
  console.log(
    `stage ${STAGE} boss: sizeClass ${boss.sizeClass}, coreArt ${boss.coreArt}, ` +
      `row ${boss.row}, col ${boss.col}`,
  );
  for (const idx of boss.spriteKeys || []) writeSprite(idx, "core");
  for (const [rec, keys] of Object.entries(boss.partArt || {})) {
    for (const idx of keys) writeSprite(idx, `part${rec}`);
  }
} else {
  console.log(`stage ${STAGE} places no boss`);
}

if (RECORDS) {
  // "48-59" renders the range; a lone "48" renders just that record
  const [a, b = a] = RECORDS.split("-").filter(Boolean).map(Number);
  const sec5 = decoded.sections[5].decompressed;
  const cgPages = decoded.sections.slice(0, 4).map((s) => s.decompressed);
  for (let rec = a; rec <= b; rec++) {
    const art = sprites.readEnemyFrames(sec5, STAGE, rec);
    if (!art) {
      console.log("record", rec, "unpainted");
      continue;
    }
    art.frames.forEach((fr, i) => {
      const { w, h, rgba } = sprites.renderFrame(
        cgPages,
        decoded.cg.palettes,
        fr,
      );
      writeRgba(`rec${rec}_f${i}`, w, h, rgba);
    });
  }
}
