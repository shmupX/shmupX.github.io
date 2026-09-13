// Genuine full round trip on real fixture saves that carry 3D models:
//   .sav -> normalize/parse -> decodeSave -> mapSaveToGame -> editor-shaped
//   level record -> buildSaveFromGame -> buildPayload -> decodeSave -> models
//
//   deno run -A dev-fixtures/debug-tools/model-survey.mjs     # first, once
//   deno run -A dev-fixtures/debug-tools/model-roundtrip.mjs [count]
//
// model-survey.mjs checks sec7 alone; this drives the whole editor path, so
// it is what catches a model surviving the encoder but lost on the way
// through mapSaveToGame or the export whitelist. Prints OK/FAIL per save and
// the first differing byte of the JSON when they disagree. Deno, not node.
import { fileURLToPath } from "node:url";
import { normalize } from "../../packages/shmup-engine/src/bup-source.js";
import * as bup from "../../packages/shmup-engine/src/bup-parse.js";
import { isGameSave } from "../../packages/shmup-engine/src/payload-table.js";
import { decodeSave } from "../../packages/shmup-engine/src/decode/index.js";
import { mapSaveToGame } from "../../packages/shmup-engine/src/map-to-game.js";
import { buildSaveFromGame } from "../../packages/shmup-engine/src/write/game-to-save.js";
import { buildPayload } from "../../packages/shmup-engine/src/bup-write.js";

const SURVEY_JSON = fileURLToPath(new URL("../.cache/model-survey.json", import.meta.url));
let targets;
try {
  targets = JSON.parse(await Deno.readTextFile(SURVEY_JSON));
} catch {
  console.error(`no ${SURVEY_JSON}\nrun model-survey.mjs first — it writes the list of saves that carry models.`);
  Deno.exit(1);
}
targets = targets.slice(0, Number(Deno.args[0] || 6));

// The editor's buildLevelRecordForSav(), minus the DOM.
const WHOLE = ['backgroundCells','dezaemonBgm','dezaemonBullets','dezaemonItems','dezaemonModels','dezaemonTitle','dezaemonTitleScreen','meta'];
function levelRecord(g) {
  const stageKey = Object.keys(g).filter(k=>/^stage\d+$/.test(k)).sort()[0] || "stage0";
  const stages = {};
  for (const k of Object.keys(g)) if (/^stage\d+$/.test(k)) stages[k] = g[k];
  const rec = {
    name: "roundtrip",
    stageKey,
    enemylist: g[stageKey].enemylist,
    width: g[stageKey].enemylist[0].length,
    enemyData: g.enemyData || {},
    bossData: g.bossData || {},
    playerData: g.playerData || {},
    stages,
  };
  const st = g[stageKey];
  if (st.waveRows) rec.waveRows = st.waveRows;
  if (st.scroll) rec.scroll = st.scroll;
  if (st.items) rec.items = st.items;
  if (st.background) rec.background = st.background;
  for (const k of WHOLE) if (g[k]) rec[k] = g[k];
  return rec;
}

let ok = 0, failed = 0;
for (const t of targets) {
  const bytes = await Deno.readFile(t.f);
  const n = await normalize(bytes);
  const save = bup.parse(n.data).filter(isGameSave)[0];
  const decoded = decodeSave(save.payload.buffer ?? save.payload);
  const { gameJson, sprites } = mapSaveToGame(decoded);
  const art = {};
  for (const s of sprites) art[s.key] = { w: s.w, h: s.h, rgba: s.rgba };
  const level = levelRecord(gameJson);
  const { sections, warnings } = buildSaveFromGame(level, art);
  const re = decodeSave(buildPayload(sections));
  const before = decoded.models, after = re.models;
  const same = JSON.stringify(before) === JSON.stringify(after);
  same ? ok++ : failed++;
  console.log(
    (same ? "OK  " : "FAIL") + "  " + t.f.split("/dev-fixtures/").pop(),
    "models", before.models.length, "->", after ? after.models.length : null,
    "| warn(3D):", warnings.filter(w=>/3D/.test(w)).length,
    "| sec7 len", sections[7].length,
  );
  if (!same) {
    const b = JSON.stringify(before), a = JSON.stringify(after||null);
    for (let i=0;i<Math.max(a.length,b.length);i++) if (a[i]!==b[i]) { console.log("  first diff @", i, "\n   before:", b.slice(Math.max(0,i-80), i+120), "\n   after :", a.slice(Math.max(0,i-80), i+120)); break; }
  }
}
console.log(`\n${ok} ok, ${failed} failed`);
if (failed) Deno.exit(1);
