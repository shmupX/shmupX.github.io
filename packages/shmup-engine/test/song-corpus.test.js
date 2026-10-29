// Every song 音まろ ever wrote, put through the music maker's song model.
//
// For each preset, each SMP_BGM slot and each slot of every cart in the
// collection:
//
//   - the view agrees with the decoder: partNotes() has readPartEvents()'s
//     note boundaries exactly;
//   - the song REBUILT through the editor's own operations — header, a
//     rhythm-only paste of its control bytes, then its notes placed one by
//     one onto the blank slot — plays exactly the same streams;
//   - when the song is canonical (songShape: nothing in it the editor would
//     not write itself) the rebuild is the same bytes, and when it is not,
//     the bytes differ only in the cells songShape listed.
//
// So a player can recompose any native song in the editor and the cart plays
// it identically, and an imported song the player does not touch is never
// re-encoded at all (bgm-record.test.js).
//
// Gated on the gitignored corpus (_song-corpus.js); DEZA_REQUIRE_CORPUS=1
// makes a missing corpus fail.

import { assert, assertEquals } from "@std/assert";
import { readPartEvents, SONG_SIZE } from "../src/decode/decode-song.js";
import { emptySong } from "../src/audio/bgm-record.js";
import {
  headerOf,
  isFfMeasure,
  NATIVE,
  partNotes,
  songShape,
  stepOffsets,
} from "../src/audio/song-view.js";
import {
  copyMeasures,
  pasteMeasures,
  placeNote,
  setHeader,
} from "../src/audio/song-edit.js";
import { songStreams } from "../src/audio/song-streams.js";
import {
  allNativeSongs,
  hasCartCorpus,
  hasPresetCorpus,
  hasSmpBgm,
  REQUIRE_CORPUS,
  requireCorpus,
  skipCorpus,
} from "./_song-corpus.js";

const MEASURE_SIZE = 132;

function rebuild(b) {
  const h = headerOf(b);
  let out = setHeader(emptySong(), {
    loopStart: h.loopStart,
    loopEnd: h.loopEnd,
    echo: h.echo,
    tempoIndex: h.tempoIndex,
  });
  for (let m = 0; m < 32; m++) {
    if (isFfMeasure(b, m)) continue;
    out = pasteMeasures(out, m, copyMeasures(b, m), {
      parts: [false, false, false, false],
      rhythm: true,
    });
  }
  for (let p = 0; p < 4; p++) {
    for (const n of partNotes(b, p)) {
      if (n.inst > NATIVE.INST_MAX) continue; // an "onset-instrument" issue
      out = placeNote(out, { part: p, step: n.step, len: n.len, pitch: n.pitch, inst: n.inst });
    }
  }
  return out;
}

/** Byte offsets songShape() says the editor would not write as they are. */
function issueOffsets(b, shape) {
  const allowed = new Set();
  for (const i of shape.issues) {
    if (i.kind === "ff-measure") {
      const from = 4 + i.measure * MEASURE_SIZE;
      for (let k = from; k < from + MEASURE_SIZE; k++) allowed.add(k);
    } else if (i.part !== undefined) {
      for (const at of stepOffsets(i.part, i.step)) allowed.add(at);
    }
  }
  return allowed;
}

function sounds(b) {
  const s = songStreams(b);
  return {
    parts: s.parts,
    accomp: s.accomp,
    loopStartStep: s.loopStartStep,
    loopEndStep: s.loopEndStep,
    stepSeconds: s.stepSeconds,
    echoLevel: s.echoLevel,
  };
}

Deno.test({
  name: "every native song rebuilds through the editor's operations and plays the same; canonical ones byte for byte",
  // Whatever part of the corpus is here is walked; DEZA_REQUIRE_CORPUS=1
  // insists on all three.
  ignore: skipCorpus(hasPresetCorpus() || hasSmpBgm() || hasCartCorpus()),
  fn() {
    if (REQUIRE_CORPUS) {
      requireCorpus(hasPresetCorpus(), "M_DATA01-73.BIN");
      requireCorpus(hasSmpBgm(), "SMP_BGM.BIN");
      requireCorpus(hasCartCorpus(), "dev-fixtures/Saturn/*.sav");
    }
    const songs = allNativeSongs();
    let canonical = 0;
    let rebuiltExact = 0;
    const kinds = {};
    for (const { where, bytes } of songs) {
      assertEquals(bytes.length, SONG_SIZE, where);
      for (let p = 0; p < 4; p++) {
        assertEquals(
          partNotes(bytes, p).map(({ step, len, pitch, inst }) => ({ step, note: pitch, instrument: inst, len })),
          readPartEvents(bytes, p),
          `${where} part ${p}: note boundaries`,
        );
      }
      const shape = songShape(bytes);
      for (const i of shape.issues) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
      const again = rebuild(bytes);
      assertEquals(sounds(again), sounds(bytes), `${where}: the rebuild plays differently`);
      const allowed = issueOffsets(bytes, shape);
      for (let k = 0; k < SONG_SIZE; k++) {
        if (again[k] !== bytes[k]) {
          assert(allowed.has(k), `${where}: byte ${k} differs (${bytes[k]} -> ${again[k]}) outside the listed issues`);
        }
      }
      if (shape.canonical) {
        canonical++;
        assertEquals(again, bytes, `${where}: canonical but not rebuilt byte for byte`);
      }
      if (again.every((v, k) => v === bytes[k])) rebuiltExact++;
    }
    console.log(
      `${songs.length} songs: ${canonical} canonical, ${rebuiltExact} rebuilt byte for byte; issues ${JSON.stringify(kinds)}`,
    );
  },
});
