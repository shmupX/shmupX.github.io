// deno task tonebank:table — bake data/bgm-instruments.json into the compact
// module the runtime ships (packages/shmup-engine/src/audio/tone-bank-table.js).
//
// Same split as the appearance scripts: data/ keeps the verbose,
// human-readable extraction that FORMAT.md documents, and src/ carries a
// packed copy so a browser importing the engine does not pull 256 KB of JSON
// with a field name repeated 590 times. Regenerating is a task, not a build
// step — the table only changes when the RE does.

import { fromFileUrl } from "@std/path";

const SRC = fromFileUrl(
  new URL(
    "../packages/shmup-engine/data/bgm-instruments.json",
    import.meta.url,
  ),
);
const OUT = fromFileUrl(
  new URL(
    "../packages/shmup-engine/src/audio/tone-bank-table.js",
    import.meta.url,
  ),
);

interface Layer {
  noteLo: number;
  noteHi: number;
  sampleOffsetInSNDPAC: number;
  format: number;
  lengthSamples: number;
  loopMode: number;
  loopStart: number;
  loopEnd: number;
  rootPitch: number;
  fineTune: number;
  level: number;
  pan: number;
  velCurve: number;
  eg: {
    AR: number;
    D1R: number;
    D2R: number;
    RR: number;
    DL: number;
    KRS: number;
    EGHOLD: number;
    LPSLNK: number;
  };
}

interface Instrument {
  instrument: number;
  flags: number;
  volAdj: number;
  layers: Layer[];
}

const map = JSON.parse(await Deno.readTextFile(SRC)) as {
  meta: Record<string, unknown>;
  instruments: Instrument[];
};

const layers: number[] = [];
const instruments: number[] = [];

for (const inst of map.instruments) {
  instruments.push(
    inst.flags,
    inst.volAdj,
    layers.length / 20,
    inst.layers.length,
  );
  for (const l of inst.layers) {
    // The whole design leans on loops being TAIL loops. Assert it here rather
    // than carrying a field the data has never once contradicted.
    if (l.loopMode !== 0 && l.loopEnd !== l.lengthSamples - 1) {
      throw new Error(
        `instrument ${inst.instrument}: loopEnd ${l.loopEnd} != lengthSamples-1 ${
          l.lengthSamples - 1
        }`,
      );
    }
    if (l.format !== 8 && l.format !== 16) {
      throw new Error(
        `instrument ${inst.instrument}: unknown format ${l.format}`,
      );
    }
    layers.push(
      l.noteLo,
      l.noteHi,
      l.sampleOffsetInSNDPAC,
      l.format,
      l.lengthSamples,
      l.loopMode,
      l.loopStart,
      l.rootPitch,
      l.fineTune,
      l.level,
      l.pan,
      l.velCurve,
      l.eg.AR,
      l.eg.D1R,
      l.eg.D2R,
      l.eg.RR,
      l.eg.DL,
      l.eg.KRS,
      l.eg.EGHOLD,
      l.eg.LPSLNK,
    );
  }
}

const layerCount = layers.length / 20;
const source =
  `// Dezaemon 2 TONE BANK — the 116-instrument map the 68000 sound driver's
// instrument-select command (channel cmd 4) indexes, packed from
// data/bgm-instruments.json by scripts/build-tone-bank-table.ts. Do not edit;
// regenerate with \`deno task tonebank:table\`.
//
// Every layer points at a slice of SNDPAC.BIN, the disc's sample bank. The
// bank is disc content and is NOT in this repo — src/audio/tone-bank.js cuts
// the samples out of one the caller supplies.
//
// A note-on strikes EVERY layer whose [noteLo..noteHi] contains the note; the
// detune/chorus pairs are two layers over the same range with opposite
// fineTune. Sounding pitch is
//   playbackRate = 2^((note - rootPitch + fineTune/256 + transpose) / 12)
// with the composed parts' note = pitch-column byte + 54 and the
// accompaniment's note = the pattern byte as-is.
//
// ${layerCount} layers across ${map.instruments.length} instruments.

// Field order of one TONE_LAYERS row.
export const LAYER_FIELDS = 20;
export const LAYER = {
    NOTE_LO: 0,
    NOTE_HI: 1,
    OFFSET: 2, //         byte offset into SNDPAC.BIN
    FORMAT: 3, //         8 = signed 8-bit PCM, 16 = signed 16-bit BIG-endian
    LENGTH_SAMPLES: 4,
    LOOP_MODE: 5, //      SCSP LPCTL: 0 off, 1 forward, 2 reverse, 3 alternating
    LOOP_START: 6, //     in samples; the loop always runs to the last sample
    ROOT_PITCH: 7,
    FINE_TUNE: 8, //      1/256 semitone
    LEVEL: 9, //          attenuation, ~0.375 dB per step
    PAN: 10, //           SCSP pan byte
    VEL_CURVE: 11,
    EG_AR: 12,
    EG_D1R: 13,
    EG_D2R: 14,
    EG_RR: 15,
    EG_DL: 16,
    EG_KRS: 17,
    EG_EGHOLD: 18,
    EG_LPSLNK: 19,
};

// Field order of one TONE_INSTRUMENTS row.
export const INSTRUMENT_FIELDS = 4;
export const INSTRUMENT = {
    FLAGS: 0,
    VOL_ADJ: 1,
    FIRST_LAYER: 2,
    LAYER_COUNT: 3,
};

export const TONE_INSTRUMENTS = [${instruments.join(",")}];

export const TONE_LAYERS = [${layers.join(",")}];
`;

await Deno.writeTextFile(OUT, source);
console.log(
  `[tonebank:table] ${map.instruments.length} instruments, ${layerCount} layers -> ${OUT} (${
    (source.length / 1024).toFixed(1)
  } KB)`,
);
