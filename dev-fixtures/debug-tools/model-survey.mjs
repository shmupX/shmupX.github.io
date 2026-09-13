// Every 3D model in the fixture corpus, and whether sec7 survives a re-encode.
//
//   deno run -A dev-fixtures/debug-tools/model-survey.mjs
//
// Walks dev-fixtures/ for .sav/.bcr/.bkr, decodes section 7 of every game
// save in them, and reports the corpus-wide counts that FORMAT.md and the
// README quote — saves carrying models, model and part totals, and the
// stale-byte tallies. For each one it re-encodes the decoded models and
// checks the bytes against the originals, so a writer change that is not
// byte-exact shows up here as `differ` rather than in a cart months later.
//
// Writes the list of saves that carry models to dev-fixtures/.cache/, where
// model-roundtrip.mjs picks it up. Deno, not node.
import { fileURLToPath } from "node:url";
import { normalize } from "../../packages/shmup-engine/src/bup-source.js";
import * as bup from "../../packages/shmup-engine/src/bup-parse.js";
import { isGameSave } from "../../packages/shmup-engine/src/payload-table.js";
import { decodeSave } from "../../packages/shmup-engine/src/decode/index.js";
import {
  decodeModels,
  MODEL_SLOT_SIZE,
  MODEL_SLOTS,
} from "../../packages/shmup-engine/src/decode/decode-model.js";
import { encodeModels } from "../../packages/shmup-engine/src/write/encode-model.js";

// Resolved from this file, not the cwd: the checkout can live on a path with
// a space in it, which is why these go through fileURLToPath rather than
// URL.pathname.
const FIXTURES = fileURLToPath(new URL("../", import.meta.url));
const CACHE = fileURLToPath(new URL("../.cache/", import.meta.url));
export const SURVEY_JSON = `${CACHE}model-survey.json`;

const files = [];
async function walk(d) {
  for await (const e of Deno.readDir(d)) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === ".cache" || e.name === "debug-tools") continue;
      await walk(p);
    } else if (/\.(sav|bcr|bkr)$/i.test(e.name)) files.push(p);
  }
}
await walk(FIXTURES.replace(/\/$/, ""));
files.sort();

let entries = 0, magic = 0, withModels = 0, models = 0, parts = 0;
let identical = 0, differ = 0, roundOk = 0, roundBad = 0;
let bit15 = 0, padNonZero = 0, overCount = 0;
const withModelFiles = [];
for (const f of files) {
  let bytes;
  try {
    bytes = await Deno.readFile(f);
  } catch {
    continue;
  }
  let saves;
  try {
    const n = await normalize(bytes);
    saves = bup.parse(n.data).filter(isGameSave);
  } catch {
    continue;
  }
  for (const s of saves) {
    let d;
    try {
      d = decodeSave(s.payload.buffer ?? s.payload);
    } catch {
      continue;
    }
    entries++;
    const sec = d.sections && d.sections[7];
    if (!sec || !sec.decompressed) continue;
    const raw = sec.decompressed;
    const m = decodeModels(raw);
    if (m) magic++;
    if (!m || !m.models.length) continue;
    withModels++;
    models += m.models.length;
    for (const mm of m.models) {
      parts += mm.parts.length;
      // Bit 15 falls outside all three 5-bit channels the shader reads, so it
      // is never displayed; count it rather than assume it is clear.
      if (mm.color & 0x8000) bit15++;
    }
    for (let slot = 0; slot < MODEL_SLOTS; slot++) {
      const base = 4 + slot * MODEL_SLOT_SIZE;
      const pc = (raw[base] << 8) | raw[base + 1];
      if (pc > 9) overCount++;
      for (let p = 0; p < Math.min(pc, 9); p++) {
        const at = base + 4 + p * 36;
        if (raw[at + 2] || raw[at + 3] || raw[at + 0x16] || raw[at + 0x17]) {
          padNonZero++;
        }
      }
    }
    withModelFiles.push({ f, file: s.filename, count: m.models.length });
    const re = encodeModels(m);
    let same = re.length === raw.length;
    if (same) {
      for (let i = 0; i < re.length; i++) {
        if (re[i] !== raw[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) identical++;
    else differ++;
    const back = decodeModels(re);
    if (JSON.stringify(back) === JSON.stringify(m)) roundOk++;
    else {
      roundBad++;
      console.log("ROUNDTRIP MISMATCH", f);
    }
  }
}
console.log(
  JSON.stringify(
    {
      files: files.length,
      entries,
      magic,
      withModels,
      models,
      parts,
      identical,
      differ,
      roundOk,
      roundBad,
      bit15,
      padNonZero,
      overCount,
    },
    null,
    2,
  ),
);
await Deno.mkdir(CACHE, { recursive: true });
await Deno.writeTextFile(SURVEY_JSON, JSON.stringify(withModelFiles, null, 1));
console.log(`\nsaves carrying models -> ${SURVEY_JSON}`);
