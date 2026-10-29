// The editor's song model plays what the game plays.
//
// The music maker builds its note streams with the engine's song-streams.js
// and its tables with bgm-tables.js; the runtime does the same job inside
// game.bundle.js (parseBgmSong, buildAccompParts, DEZA_ACCOMP_B64,
// DEZA_BGM_VOICES), a vendored artifact patched by hand. This lifts the
// bundle's own functions and literals and holds the two equal, on synthetic
// songs always and on every native song when the corpus is present — so a
// change on either side that is not ported to the other fails here.

import { assert, assertEquals } from "@std/assert";
import {
  ACCOMP_TABLE_B64,
  BGM_VOICE_ROWS,
} from "../packages/shmup-engine/src/audio/bgm-tables.js";
import { songStreams } from "../packages/shmup-engine/src/audio/song-streams.js";
import {
  bytesToB64,
  emptySong,
} from "../packages/shmup-engine/src/audio/bgm-record.js";
import {
  placeNote,
  setHeader,
  setRhythm,
} from "../packages/shmup-engine/src/audio/song-edit.js";
import {
  allNativeSongs,
  hasCartCorpus,
  hasPresetCorpus,
  requireCorpus,
  skipCorpus,
} from "../packages/shmup-engine/test/_song-corpus.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const js = (await Deno.readTextFile(new URL(`../${BUNDLE}`, import.meta.url)))
  .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One top-level `var NAME = …;` of the bundle, as source text. */
function varSource(name: string): string {
  const start = js.indexOf(`\n  var ${name} = `);
  assert(start >= 0, `no var ${name} in ${BUNDLE}`);
  const end = js.indexOf(";\n", start);
  return js.slice(start, end + 2);
}

type Streams = ReturnType<typeof songStreams>;
const parseBgmSong = new Function(
  [
    varSource("DEZA_TEMPO_TABLE"),
    functionSource("bgmStepSeconds"),
    functionSource("b64ToBytes"),
    varSource("DEZA_ACCOMP_B64"),
    varSource("DEZA_ACCOMP_TRANSPOSE"),
    "var dezaAccompTable = null;",
    functionSource("accompTable"),
    functionSource("buildAccompParts"),
    functionSource("parseBgmSong"),
    "return parseBgmSong;",
  ].join("\n"),
)() as (b64: string) => Streams;

Deno.test("the engine's tables are the bundle's DEZA_ACCOMP_B64 and DEZA_BGM_VOICES", () => {
  const accomp = new Function(`${varSource("DEZA_ACCOMP_B64")} return DEZA_ACCOMP_B64;`)();
  assertEquals(ACCOMP_TABLE_B64, accomp);
  const voices = new Function(`${varSource("DEZA_BGM_VOICES")} return DEZA_BGM_VOICES;`)();
  assertEquals(BGM_VOICE_ROWS, voices);
});

Deno.test("songStreams is parseBgmSong: composed parts, accompaniment, loop, tempo and echo", () => {
  let s = emptySong();
  s = placeNote(s, { part: 0, step: 0, len: 4, pitch: 25, inst: 13 });
  s = placeNote(s, { part: 3, step: 15, len: 3, pitch: 50, inst: 48 }); // across a bar line
  s = setRhythm(s, 0, { bank: 3, pattern: 1, chord: 2, key: 9 });
  s = setRhythm(s, 1, { bank: 8, pattern: 3, chord: 4, key: 11 });
  s = setHeader(s, { loopStart: 1, loopEnd: 6, echo: 6, tempoIndex: 28 });
  assertEquals(songStreams(s), parseBgmSong(bytesToB64(s)));
  // Loop bytes the wrong way round play the whole song, in both.
  const odd = s.slice();
  odd[0] = 9;
  odd[1] = 2;
  assertEquals(songStreams(odd), parseBgmSong(bytesToB64(odd)));
  // Control bytes off the end of the pattern table are skipped, in both.
  const garbage = s.slice();
  garbage.fill(0xfe, 4, 8);
  assertEquals(songStreams(garbage), parseBgmSong(bytesToB64(garbage)));
});

// Bytes a cart can carry that no editor operation writes: the clamps and
// masks have to agree too, or a drift in one would only show on hardware.
Deno.test("songStreams is parseBgmSong on bytes past every range", () => {
  let s = placeNote(emptySong(), { part: 0, step: 0, len: 4, pitch: 25, inst: 13 });
  s = setRhythm(s, 1, { bank: 3, pattern: 1, chord: 2, key: 3 });
  const cases: [string, (b: Uint8Array) => void][] = [
    ["loop bytes past 31", (b) => { b[0] = 40; b[1] = 200; }],
    ["loop end 255", (b) => { b[0] = 1; b[1] = 255; }],
    ["tempo byte with high bits", (b) => { b[3] = 28 | 0x20; }],
    ["tempo byte 0xFF", (b) => { b[3] = 0xff; }],
    ["pitch 60 on a voice byte", (b) => { b[4 + 4 + 16 + 5] = 60; }],
    ["pitch 0x80 under a tie", (b) => { b[4 + 4 + 6] = 0x80; b[4 + 4 + 16 + 6] = 0x80; }],
    ["an orphan tie", (b) => { b[4 + 5 * 132 + 4] = 0x80; b[4 + 5 * 132 + 4 + 16] = 30; }],
    ["key index 12", (b) => { b[4 + 132 + 3] = 12; }],
    ["key index 13", (b) => { b[4 + 132 + 3] = 13; }],
  ];
  for (const [why, poke] of cases) {
    const b = s.slice();
    poke(b);
    assertEquals(songStreams(b), parseBgmSong(bytesToB64(b)), why);
  }
});

Deno.test({
  name: "songStreams is parseBgmSong on every native song",
  ignore: skipCorpus(hasPresetCorpus() || hasCartCorpus()),
  fn() {
    requireCorpus(hasPresetCorpus() || hasCartCorpus(), "M_DATA01-73.BIN or dev-fixtures/Saturn/*.sav");
    const songs = allNativeSongs();
    assert(songs.length > 0);
    for (const { where, bytes } of songs) {
      assertEquals(songStreams(bytes), parseBgmSong(bytesToB64(bytes)), where);
    }
    console.log(`${songs.length} native songs parse the same in the editor and the game`);
  },
});
