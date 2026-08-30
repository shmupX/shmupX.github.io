// Dump a Dezaemon 2 save's decoded ENEMY BEHAVIOR — the 18-byte per-(stage,
// record) attribute block — next to where the stage actually places each
// record. This is the table to read when the imported level plays wrong:
// which enemies fire, how often, how they move, and which of the four
// change channels are live.
//
//   node dev-fixtures/debug-tools/dump-behavior.mjs <save.sav> [options]
//
// Options:
//   --stage <n>       stage to report (default 0)
//   --enemy <idx>     also list that record's exact placements (row/col)
//   --summary         fire-mode distribution + the ground/max-LIFE turrets
//
// Columns: rows = the scroll rows the record is placed on (first..last, and
// how many placements); spd = px per SATURN frame; mv = the packed movement
// mode+flag byte (4 and 2 ride the map as scenery); fire{} = the decoded
// fire config (i = reload interval in frames, d = raw byte-5 direction,
// p = one of the three untraced special pattern handlers); rot/scl/dir/spd
// channels show their start>end when enabled. See the 2019-es7 importer's
// FORMAT.md "Enemy record (18 B)" for the field derivations.
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
  "usage: dump-behavior.mjs <save.sav> [--stage n] [--enemy idx] [--summary]";
const VALUE_FLAGS = new Set(["stage", "enemy"]);
const BOOL_FLAGS = new Set(["summary"]);
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
const ENEMY = flags.enemy === undefined ? null : Number(flags.enemy);

const { normalize } = await import(path.join(LIB, "lib/bup-source.js"));
const bup = await import(path.join(LIB, "lib/bup-parse.js"));
const { isGameSave } = await import(path.join(LIB, "lib/payload-table.js"));
const { decodeSave } = await import(path.join(LIB, "lib/decode/index.js"));

const { data } = await normalize(fs.readFileSync(input));
const saves = bup.parse(data);
const save = saves.find(isGameSave) || saves[0];
const decoded = decodeSave(save.payload.buffer);

const stage = decoded.stages[STAGE];
if (!stage) {
  console.error(
    `save has no stage ${STAGE} (decoded ${decoded.stages.length})`,
  );
  process.exit(3);
}

// Spawn rows per record. decode-stage emits rows in spawn order; waveRows
// carries the scroll row each one came from, which is the number that lines
// up with a capture's timeline (8 frames per row).
const rowsOfEnemy = new Map();
const placementsOfEnemy = new Map();
stage.rows.forEach((row, ri) => {
  const srcRow = stage.waveRows ? stage.waveRows[ri] : ri;
  row.forEach((cell, ci) => {
    if (!cell) return;
    if (!rowsOfEnemy.has(cell.enemy)) {
      rowsOfEnemy.set(cell.enemy, []);
      placementsOfEnemy.set(cell.enemy, []);
    }
    rowsOfEnemy.get(cell.enemy).push(srcRow);
    placementsOfEnemy.get(cell.enemy).push(`r${srcRow}c${ci}`);
  });
});

const pad = (v, w) => String(v).padStart(w);
const chan = (c) => c && c.enabled ? `${round(c.from)}>${round(c.to)}` : "-";
const round = (n) => Math.round(n * 100) / 100;

console.log(
  `${path.basename(input)} — stage ${STAGE}: ${stage.rows.length} waves, ` +
    `${stage.cols} cols, rows ${
      stage.waveRows
        ? `${stage.waveRows[0]}..${stage.waveRows[stage.waveRows.length - 1]}`
        : "n/a"
    }, ${rowsOfEnemy.size} records placed`,
);
console.log(
  "idx | rows(first..last, n) | gnd spd    mv fire{en t c m i d p} " +
    "rot scl dirCh spdChg | app",
);

const byFirstRow = [...rowsOfEnemy.entries()]
  .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]));
for (const [idx, rows] of byFirstRow) {
  const e = decoded.enemies[idx];
  if (!e || !e.behavior) {
    console.log(`${pad(idx, 3)} | (no behavior decoded)`);
    continue;
  }
  const b = e.behavior;
  const f = b.fire;
  console.log(
    [
      pad(idx, 3),
      "|",
      `${pad(Math.min(...rows), 3)}..${pad(Math.max(...rows), 3)}`,
      `n=${pad(rows.length, 3)}`,
      "|",
      b.ground ? "GND" : "   ",
      `spd=${round(b.speed).toFixed(2)}`,
      `mv=${b.movePattern}`,
      `fire{${f.enabled ? "ON " : "off"}`,
      `t=${f.type}`,
      `c=${f.count}`,
      `m=${f.mode}`,
      `i=${pad(f.interval, 3)}`,
      `d=${pad(f.direction, 2)}`,
      `p=${f.pattern ?? "-"}}`,
      `rot=${b.rotation.enabled ? b.rotation.mode : "-"}`,
      `scl=${b.scale.enabled ? b.scale.axes : "-"}`,
      `dir=${chan(b.direction)}`,
      `spdCh=${chan(b.speedChange)}`,
      `| app=${b.appearance}`,
    ].join(" "),
  );
}

if (ENEMY !== null) {
  const spots = placementsOfEnemy.get(ENEMY);
  console.log(
    `\nrecord ${ENEMY} placements (${spots ? spots.length : 0}): ` +
      (spots ? spots.join(" ") : "none in this stage"),
  );
}

if (flags.summary) {
  // Fire mode across every PLACEMENT (not per record), so a mode used by one
  // record placed 200 times reads as the presence it actually has in play.
  const modes = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const turrets = [];
  for (const [idx, rows] of rowsOfEnemy) {
    const e = decoded.enemies[idx];
    if (!e || !e.behavior) continue;
    const b = e.behavior;
    modes[b.fire.mode] += rows.length;
    // Ground objects at max LIFE are the emplaced turrets — the class whose
    // behavior a capture pins down most clearly.
    if (b.ground && b.hp === 60) {
      turrets.push(
        `idx=${idx} n=${rows.length} fires=${b.fire.enabled} ` +
          `type=${b.fire.type} int=${b.fire.interval} dir=${b.fire.direction} ` +
          `app=${b.appearance}`,
      );
    }
  }
  console.log(
    `\nfire-mode distribution (by placement): ${JSON.stringify(modes)}`,
  );
  console.log(
    `ground max-LIFE turrets: ${
      turrets.length ? "\n  " + turrets.join("\n  ") : "none"
    }`,
  );
}
