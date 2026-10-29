// deno task bgm:tables — bake the two engine-fixed music tables into the
// module the editor's song player ships
// (packages/shmup-engine/src/audio/bgm-tables.js).
//
//   data/bgm-accompaniment.json  the kernel ROM's 1260 x 16 accompaniment
//                                pattern rows -> ACCOMP_TABLE_B64
//   data/bgm-voices.json         116 instruments as harmonic profiles
//                                -> BGM_VOICE_ROWS
//
// Both come out exactly as game.bundle.js carries them (DEZA_ACCOMP_B64 and
// DEZA_BGM_VOICES), so the editor and the runtime play from the same numbers;
// tests/music_song_parity_test.ts holds the two equal. Same split as
// tonebank:table — data/ keeps the verbose extraction, src/ the packed copy.

import { fromFileUrl } from "@std/path";

const DATA = new URL("../packages/shmup-engine/data/", import.meta.url);
const OUT = fromFileUrl(
  new URL(
    "../packages/shmup-engine/src/audio/bgm-tables.js",
    import.meta.url,
  ),
);

interface AccompRow {
  row: number;
  steps: number[];
}
interface VoiceLayer {
  lo: number;
  hi: number;
  lvl: number;
  a: number;
  d: number;
  s: number;
  r: number;
  n: number;
  h: number[];
}

const accomp = JSON.parse(
  await Deno.readTextFile(new URL("bgm-accompaniment.json", DATA)),
) as { rows: AccompRow[] };
const voices = JSON.parse(
  await Deno.readTextFile(new URL("bgm-voices.json", DATA)),
) as { voices: { i: number; layers: VoiceLayer[] }[] };

const table = new Uint8Array(accomp.rows.length * 16);
for (const r of accomp.rows) {
  if (r.steps.length !== 16) throw new Error(`row ${r.row}: ${r.steps.length} steps`);
  table.set(r.steps, r.row * 16);
}
let bin = "";
for (const b of table) bin += String.fromCharCode(b);
const accompB64 = btoa(bin);

// The runtime's literal rounds the envelope and noisiness; keep its rounding
// (toFixed, not Math.round — 0.355 must come out 0.35, as it does there).
const fix = (x: number, d: number) => Number(x.toFixed(d));
const rows = voices.voices.map((v, i) => {
  if (v.i !== i) throw new Error(`voice ${i} is numbered ${v.i}`);
  return v.layers.map((L) => [
    L.lo,
    L.hi,
    L.lvl,
    fix(L.a, 3),
    fix(L.d, 3),
    fix(L.s, 2),
    fix(L.r, 3),
    fix(L.n, 2),
    ...L.h,
  ]);
});

const source =
  `// Dezaemon 2 music tables the save cannot carry, packed from data/ by
// scripts/build-bgm-tables.ts. Do not edit; regenerate with
// \`deno task bgm:tables\`. Identical to game.bundle.js's DEZA_ACCOMP_B64 and
// DEZA_BGM_VOICES (tests/music_song_parity_test.ts).
//
// ACCOMP_TABLE_B64  the kernel ROM auto-accompaniment pattern table
//                   (0KERNEL.BIN +0x1B490), ${accomp.rows.length} rows x 16 step bytes:
//                   row = ctrl0*140 + (ctrl1*5 + ((ctrl2&0x7F)>>1))*7 + channel;
//                   0 = rest, bit 7 = tie, else an absolute driver-scale note.
// BGM_VOICE_ROWS    per instrument, one row per distinct layer note range:
//                   [noteLo, noteHi, level, attack, decay, sustain, release,
//                    noise, ...16 harmonic amplitudes] — an analysis of the
//                   tone bank, played as a PeriodicWave when the samples are
//                   not loaded.

export const ACCOMP_ROWS = ${accomp.rows.length};
export const ACCOMP_TABLE_B64 =
    "${accompB64}";

export const BGM_VOICE_ROWS = ${JSON.stringify(rows)};
`;

await Deno.writeTextFile(OUT, source);
console.log(
  `bgm-tables.js: ${accomp.rows.length} accompaniment rows, ${rows.length} voices`,
);
