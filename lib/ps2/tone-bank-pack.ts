// The Dezaemon tone bank, rendered as PS2 audio.
//
// The instrument map (packages/shmup-engine/data/bgm-instruments.json) says
// where each of the 116 instruments' PCM sits inside SNDPAC.BIN and how it
// loops. SNDPAC.BIN is disc content and is not in this repo, so the bank is
// located at build time: a Dezaemon 2 disc image dropped into dev-fixtures/
// (gitignored) is opened with the engine's ISO 9660 reader and the file is
// pulled straight out of it. No disc, no pack — the export stays silent
// exactly as it does today.
//
// Output, under assets/sounds/tonebank/ on the disc:
//
//   tbNN.adp        one audsrv SPU2 ADPCM file per distinct sample cut
//   tonebank.json   which cut each instrument layer uses, plus the pitch,
//                   level, pan and envelope a player needs to sound it
//
// The .wav twins (same PCM, canonical 44-byte header) are written only to the
// local output directory: they are for listening to and for the browser, and
// would triple the audio on the disc for nothing.
//
// lib/sndpac.ts finds the bank and renders the browser's copy of it.

import {
  cutLayer,
  INSTRUMENT_COUNT,
  instrumentAt,
  layerAt,
  SCSP_BASE_RATE,
  uniqueSlices,
} from "../../packages/shmup-engine/src/audio/tone-bank.js";
import {
  alignLoopForAdpcm,
  encodeAdp,
  encodeWav,
  fitToHeadroom,
} from "./adpcm.ts";
import type { StagedFile } from "./assets.ts";

export { cacheSndpac, findSndpac, type SndpacSource } from "../sndpac.ts";

/** Where the pack lands inside the staged tree (and so on the ISO). */
export const TONE_BANK_DIR = "assets/sounds/tonebank";

export interface ToneBankPack {
  /** Files to stage on the disc (ADPCM + the index). */
  files: StagedFile[];
  /** PCM twins for listening/browser use; not staged. */
  wavFiles: StagedFile[];
  notes: string[];
}

/** Encode the whole bank. Throws only if the map points outside the bank. */
export function buildToneBankPack(sndpac: Uint8Array): ToneBankPack {
  const slices = uniqueSlices();
  const files: StagedFile[] = [];
  const wavFiles: StagedFile[] = [];
  const sliceOfLayer = new Map<number, number>();
  const index: Record<string, unknown>[] = [];

  let adpBytes = 0;
  let repeated = 0;
  let truncated = 0;
  let attenuated = 0;
  let skipped = 0;

  slices.forEach((slice, i) => {
    const cut = cutLayer(sndpac, layerAt(slice.layerIndexes[0]));
    if (!cut) {
      skipped++;
      return;
    }
    const name = `tb${String(i).padStart(2, "0")}`;
    const aligned = cut.loop
      ? alignLoopForAdpcm(cut.pcm, cut.loopStart)
      : { pcm: cut.pcm, loopStart: 0, method: "none" as const };
    if (aligned.method === "repeat") repeated++;
    if (aligned.method === "truncate") truncated++;

    // A handful of bank samples touch full scale, which the SPU2 encoder
    // clips; pulling them under its headroom first is worth up to 20 dB.
    const fitted = fitToHeadroom(aligned.pcm);
    if (fitted.scale !== 1) attenuated++;

    const adp = encodeAdp(fitted.pcm, {
      rate: SCSP_BASE_RATE,
      loop: cut.loop,
      loopStartSample: aligned.loopStart,
    });
    adpBytes += adp.length;
    files.push({ path: `${TONE_BANK_DIR}/${name}.adp`, data: adp });
    wavFiles.push({
      path: `${TONE_BANK_DIR}/${name}.wav`,
      data: encodeWav(fitted.pcm, SCSP_BASE_RATE),
    });

    for (const layerIndex of slice.layerIndexes) {
      sliceOfLayer.set(layerIndex, i);
    }
    index.push({
      file: `${name}.adp`,
      samples: aligned.pcm.length,
      loop: cut.loop,
      loopStart: aligned.loopStart,
      // How the loop was made to land on a 28-sample ADPCM block: "repeat" is
      // exact, "truncate" shortens a long loop by under one block.
      align: aligned.method,
      // <1 when the sample had to come down to the SPU2 encoder's headroom.
      scale: Number(fitted.scale.toFixed(5)),
      sourceLoopMode: slice.loopMode,
    });
  });

  const instruments = [];
  for (let i = 0; i < INSTRUMENT_COUNT; i++) {
    const inst = instrumentAt(i)!;
    const layers = [];
    for (let k = 0; k < inst.layerCount; k++) {
      const layerIndex = inst.firstLayer + k;
      const slice = sliceOfLayer.get(layerIndex);
      if (slice === undefined) continue;
      const l = layerAt(layerIndex)!;
      layers.push({
        slice,
        noteLo: l.noteLo,
        noteHi: l.noteHi,
        rootPitch: l.rootPitch,
        fineTune: l.fineTune,
        level: l.level,
        pan: l.pan,
        eg: l.eg,
      });
    }
    instruments.push({ flags: inst.flags, volAdj: inst.volAdj, layers });
  }

  const json = {
    meta: {
      baseRate: SCSP_BASE_RATE,
      pitch:
        "playbackRate = 2^((note - rootPitch + fineTune/256 + transpose)/12); composed note = pitch-column byte + 54",
      select:
        "composed parts use voice-column byte 1-59; accompaniment uses 60+ctrl0; sound effects 69+",
      layerSelect:
        "a note-on strikes EVERY layer whose [noteLo..noteHi] contains the note",
      level: "attenuation, about 0.375 dB per step",
    },
    slices: index,
    instruments,
  };
  files.push({
    path: `${TONE_BANK_DIR}/tonebank.json`,
    data: new TextEncoder().encode(JSON.stringify(json)),
  });

  const notes = [
    `tone bank: ${index.length} samples, ${
      (adpBytes / 1024).toFixed(0)
    } KB of ADPCM`,
    `tone bank loops: ${repeated} repeated to an exact block boundary, ${truncated} shortened by under one block`,
  ];
  if (attenuated) {
    notes.push(
      `tone bank: ${attenuated} sample(s) pulled under the SPU2 encoder's headroom (at most 0.6 dB)`,
    );
  }
  if (skipped) {
    notes.push(
      `tone bank: ${skipped} sample(s) fell outside SNDPAC.BIN and were dropped`,
    );
  }
  return { files, wavFiles, notes };
}
