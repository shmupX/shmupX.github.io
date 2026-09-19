// Dezaemon+ SOUND: the interior of a song. The bit layout was already in
// FORMAT-PSX.md; what is asserted here is the MEANING traced out of DEZA.EXE
// (SLPS-00335) — see src/psx/plus-song.js, which carries every address.
//
// WHICH TEST CARRIES THE WEIGHT. It is the CORPUS note-byte test, not the
// round trip. The corpus was written by people who never saw this decoder, and
// the note table has twelve holes inside its own 55..99 window: if the layout
// is wrong, real songs land in those holes and the test goes red. Every split,
// boundary and note-mapping error tried against it did exactly that.
//
// The ROUND TRIP proves something narrower than its name suggests, and the
// difference is worth stating because it is easy to bank on. It shows that
// decodePlusSong and encodePlusSong are MUTUAL INVERSES over all 1,072 songs
// in the collection, and that each slot's two slack bytes are zero. It cannot
// show the bit layout is right: a round trip is symmetric by construction, so
// any re-slicing applied to both sides survives it. A 15-bit bar header
// (4/2/4/5) — which fills all 736 bytes with NO slack, the opposite of what
// this file asserts — re-encoded byte for byte across all 1,072 songs. Keep
// the test for what it does prove; do not read the layout out of it.
//
// The 5+6 direction test is the other one that matters: reversing the split
// still yields a plausible instrument (0..31) and a plausible note, so nothing
// downstream would look wrong. It is pinned twice, here and in the corpus.

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  decodePlusSong,
  decodePlusSongs,
  encodePlusSong,
  PLUS_ACCOMP_EXTRA_TRACK,
  PLUS_ACCOMP_FOLD_HI,
  PLUS_ACCOMP_FOLD_LO,
  PLUS_ACCOMP_FOLD_MID,
  PLUS_ACCOMP_PITCHED_TRACKS,
  PLUS_ACCOMP_ROM,
  PLUS_ACCOMP_TRACKS,
  PLUS_BPM_NUMERATOR,
  PLUS_FRAMES_PER_SECOND,
  PLUS_INSTRUMENT_PERM,
  PLUS_INSTRUMENT_PROGRAMS,
  PLUS_INSTRUMENT_PROGRAMS_ALT,
  PLUS_INSTRUMENT_UNPERM,
  PLUS_NOTE_MAX,
  PLUS_NOTE_MIN,
  PLUS_NOTE_REST,
  PLUS_NOTE_TIE,
  PLUS_SONG_BAR_STRIDE,
  PLUS_SONG_BARS,
  PLUS_SONG_BITS,
  PLUS_SONG_CELLS,
  PLUS_SONG_PACKED_BYTES,
  PLUS_SONG_STEPS,
  PLUS_SONG_UNPACKED_SIZE,
  PLUS_SONG_VOICE_STRIDE,
  PLUS_SONG_VOICES,
  PLUS_STEPS_PER_BEAT,
  PLUS_TEMPO_TABLE,
  PLUS_TEMPO_TICKS_PER_FRAME,
  PLUS_VOLUME_TABLE,
  plusBarAccompaniment,
  plusFoldAccompanimentNote,
  plusNoteFromBits,
  plusNoteName,
  plusNoteToBits,
  plusNoteToMidi,
  plusSongSettings,
  plusSongUnpacked,
  plusVoiceEvents,
  plusVoiceProgram,
} from "../src/psx/plus-song.js";
import {
  PLUS_SONG_COUNT,
  PLUS_SONG_SIZE,
  PLUS_SOUND_OFFSET,
} from "../src/psx/plus.js";
import { identifyGame, locateSaves } from "../src/psx/index.js";
import { hasDiscFile, loadDiscFile } from "./_fixtures.js";

// --- helpers -----------------------------------------------------------------

/**
 * Pack a song from RAW BIT FIELDS, deliberately not through encodePlusSong:
 * this takes the 5-bit and 6-bit values as they sit in the stream, so nothing
 * here knows about the instrument permutation or the note mapping. That is
 * what lets the direction test below be an independent check rather than a
 * restatement of the decoder.
 */
function packSong({ heads = [], cells = [], tail = [0, 0, 0, 0] } = {}) {
  const out = new Uint8Array(PLUS_SONG_SIZE);
  let bit = 0;
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) {
      if ((v >> i) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
      bit++;
    }
  };
  for (let b = 0; b < PLUS_SONG_BARS; b++) {
    const head = heads[b] ?? [0, 0, 0, 0];
    [4, 2, 4, 4].forEach((n, i) => put(head[i], n));
    for (let c = 0; c < PLUS_SONG_CELLS; c++) {
      const [raw5, raw6] = cells[b]?.[c] ?? [0, 0];
      put(raw5, 5);
      put(raw6, 6);
    }
  }
  [3, 5, 4, 4].forEach((n, i) => put(tail[i], n));
  return out;
}

/** A song object whose every cell is a rest, ready to have notes dropped in. */
function restSong() {
  const bars = [];
  for (let b = 0; b < PLUS_SONG_BARS; b++) {
    const voices = [];
    for (let v = 0; v < PLUS_SONG_VOICES; v++) {
      voices.push(
        Array.from({ length: PLUS_SONG_STEPS }, () => ({
          instrument: 0,
          note: PLUS_NOTE_REST,
          raw5: 0,
          raw6: plusNoteToBits(PLUS_NOTE_REST),
        })),
      );
    }
    bars.push({ head: [0, 0, 0, 0], voices });
  }
  return { bars, tail: [0, 0, 0, 15] };
}

// The real table at DEZA.EXE 0x800F03BA, read as u16 at base + byte*2 and kept
// as its high byte — every entry that is not 0x0000. Written out rather than
// computed so the closed form has something to be checked AGAINST.
const NOTE_TABLE = Object.freeze([
  [55, 55],
  [56, 56],
  [57, 57],
  [58, 58],
  [59, 59],
  [64, 60],
  [65, 61],
  [66, 62],
  [67, 63],
  [68, 64],
  [69, 65],
  [70, 66],
  [71, 67],
  [72, 68],
  [73, 69],
  [74, 70],
  [75, 71],
  [80, 72],
  [81, 73],
  [82, 74],
  [83, 75],
  [84, 76],
  [85, 77],
  [86, 78],
  [87, 79],
  [88, 80],
  [89, 81],
  [90, 82],
  [91, 83],
  [96, 84],
  [97, 85],
  [98, 86],
  [99, 87],
]);
// The other hand-transcribed ROM tables, written out here for the same reason
// NOTE_TABLE is: a transcription checked only at its endpoints is not checked.
// Sampling index 0 and index 31 of a 32-entry table leaves 30 entries in which
// a single mistyped digit passes, and a mistyped digit is the likeliest error
// there is. Each of these is the byte run at the named DEZA.EXE (SLPS-00335)
// address, read straight out of the executable.

// deno-fmt-ignore
/** DEZA.EXE 0x800F0484, 32 bytes. */
const TEMPO_BYTES = Object.freeze([
  92, 82, 73, 67, 61, 56, 52, 49, 46, 43, 41, 38, 36, 35, 33, 32,
  31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
]);
/** DEZA.EXE 0x800F04A4, 8 bytes. */
const VOLUME_BYTES = Object.freeze([0, 8, 16, 24, 32, 40, 48, 56]);
// deno-fmt-ignore
/** DEZA.EXE 0x800F03A8, 32 bytes — the 5-bit field's permutation. */
const PERM_BYTES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 16, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 17, 18, 19, 20, 21, 22, 23, 31, 24, 28, 27, 25, 29, 26, 30,
]);
// deno-fmt-ignore
/** DEZA.EXE 0x800F03C8, 32 bytes — the packer's inverse of it. */
const UNPERM_BYTES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 16, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 17, 18, 19, 20, 21, 22, 23, 25, 28, 30, 27, 26, 29, 31, 24,
]);
// deno-fmt-ignore
/** DEZA.EXE 0x800F0408, 32 bytes — the play-time map with 0x8014E844 clear. */
const PROGRAM_MAP_BYTES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 32, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 17, 18, 19, 20, 21, 22, 23, 25, 28, 30, 27, 33, 29, 31, 24,
]);
// deno-fmt-ignore
/**
 * DEZA.EXE 0x800F03E8, 32 bytes — the same map with the flag set.
 *
 * TRANSCRIBED SEPARATELY, THOUGH IT COMES OUT EQUAL TO UNPERM_BYTES. Aliasing
 * it to that constant is what the file used to do, and it made the interesting
 * claim — that 0x800F03E8 and 0x800F03C8 hold the same 32 bytes, which is why
 * the permutation cancels and the driver program is the raw 5 bits — true by
 * construction instead of by measurement. Two independent transcriptions can
 * disagree; one transcription compared against itself cannot.
 */
const PROGRAM_MAP_ALT_BYTES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 16, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 17, 18, 19, 20, 21, 22, 23, 25, 28, 30, 27, 26, 29, 31, 24,
]);

/** The codes in 55..99 whose low nibble is 12..15: the table holds 0x0000 for these. */
const NOTE_TABLE_HOLES = Object.freeze([
  60,
  61,
  62,
  63,
  76,
  77,
  78,
  79,
  92,
  93,
  94,
  95,
]);

// --- the shape of the thing --------------------------------------------------

Deno.test("a song is 734 bits-bearing bytes of a 736-byte slot, and unpacks to 1092", () => {
  assertEquals(PLUS_SONG_BITS, 5872);
  assertEquals(PLUS_SONG_PACKED_BYTES, 734);
  assert(
    PLUS_SONG_PACKED_BYTES < PLUS_SONG_SIZE,
    "the slot has slack, the bits do not",
  );
  // 16 bars of a 4-byte header and 64 cell bytes, then the four tail bytes.
  assertEquals(PLUS_SONG_BAR_STRIDE, 4 + PLUS_SONG_CELLS * 2);
  assertEquals(
    PLUS_SONG_UNPACKED_SIZE,
    PLUS_SONG_BARS * PLUS_SONG_BAR_STRIDE + 4,
  );
  assertEquals(PLUS_SONG_UNPACKED_SIZE, 1092);
  // The 32 cells are two voices of sixteen steps, not 32 steps of one voice.
  assertEquals([PLUS_SONG_VOICES, PLUS_SONG_STEPS], [2, 16]);
  assertEquals(PLUS_SONG_CELLS, 32);
});

Deno.test("the 5+6 split is instrument first, note second — a swap fails here", () => {
  // Chosen so the two readings cannot be confused. As the instrument field 7
  // permutes to 16; read as the note field the same 7 becomes note byte 62,
  // which is a HOLE in the note table — low nibble 14, entry 0x0000, and a
  // byte that never occurs anywhere in the corpus (see NOTE_TABLE_HOLES and
  // the two tests below that assert both). That is what makes the swap
  // detectable from real saves and not just from this synthetic buffer. And 9
  // is note 64 as a note but instrument 9 as an instrument.
  const bytes = packSong({ cells: [[[7, 9]]] });
  const song = decodePlusSong(bytes);
  const cell = song.bars[0].voices[0][0];

  assertEquals([cell.raw5, cell.raw6], [7, 9]);
  assertEquals(cell.instrument, 16); // PLUS_INSTRUMENT_PERM[7]
  assertEquals(cell.note, 64); // plusNoteFromBits(9)

  // The same assertions stated as the swap they rule out. Reversed, this cell
  // would be instrument 9 — a perfectly legal instrument — and note byte 62,
  // which is not a legal note at all. Nothing downstream would flag the
  // instrument; only the note betrays the swap, which is why the direction has
  // to be pinned rather than eyeballed.
  assertNotEquals(cell.instrument, PLUS_INSTRUMENT_PERM[9]);
  assertNotEquals(cell.note, plusNoteFromBits(7));
  assertEquals(plusNoteFromBits(7), 62);
  // NOTE_TABLE_HOLES is a literal in this file, so asserting 62 is in it would
  // check the test against itself. plusNoteToMidi is the module, and returning
  // null for 62 is the claim that matters: widen the hole rule from `semi > 11`
  // to `semi > 14` and this goes red.
  assertEquals(plusNoteToMidi(62), null);
  // (A `62 !== PLUS_NOTE_TIE` check lived here. The tie is 125 and swapping
  // REST and TIE in the module leaves it 124 — still not 62 — so no module
  // change could move it.) Raw BITS 62 make

  // And the same order in the flat buffer the game builds: the melody
  // sequencer reads the instrument at +0 and the note at +1 of each pair.
  const flat = plusSongUnpacked(song);
  assertEquals(flat.length, PLUS_SONG_UNPACKED_SIZE);
  assertEquals(flat[4], 16);
  assertEquals(flat[5], 64);
});

Deno.test("the bar header is 4/2/4/4 and the tail 3/5/4/4, in that order", () => {
  // Values that cannot survive a reordering or a different width split: the
  // 2-bit field is the only one that cannot hold 9.
  const bytes = packSong({ heads: [[13, 2, 9, 11]], tail: [5, 20, 3, 9] });
  const song = decodePlusSong(bytes);
  assertEquals(song.bars[0].head, [13, 2, 9, 11]);
  assertEquals(
    song.bars.slice(1).every((b) => b.head.every((v) => v === 0)),
    true,
  );
  assertEquals(song.tail, [5, 20, 3, 9]);
});

Deno.test("voice 1 is the second sixteen cells, 32 bytes further into the bar", () => {
  // Cell 16 is the first cell of voice 1.
  const cells = [[]];
  cells[0][16] = [1, 9];
  const song = decodePlusSong(packSong({ cells }));
  assertEquals(song.bars[0].voices[0][0].note, plusNoteFromBits(0));
  assertEquals(song.bars[0].voices[1][0].note, 64);
  assertEquals(song.bars[0].voices[1][0].instrument, 1);
  // Spelled through the constant, not as a literal 32, so PLUS_SONG_VOICE_STRIDE
  // is what the assertion rests on: 0x80057EE0 is where the game adds it.
  assertEquals(PLUS_SONG_VOICE_STRIDE, PLUS_SONG_STEPS * 2);
  const flat = plusSongUnpacked(song);
  assertEquals(flat[4 + PLUS_SONG_VOICE_STRIDE], 1);
  assertEquals(flat[4 + PLUS_SONG_VOICE_STRIDE + 1], 64);
  // And nothing at the stride the OTHER voice layout would put it at.
  assertEquals(flat[4], 0);
  assertEquals(flat[5], plusNoteFromBits(0));
});

// --- notes -------------------------------------------------------------------

Deno.test("plusNoteToMidi reproduces every non-zero entry of the real note table", () => {
  assertEquals(NOTE_TABLE.length, 33);
  for (const [byte, midi] of NOTE_TABLE) {
    assertEquals(plusNoteToMidi(byte), midi, `note ${byte}`);
  }
  // The holes and the out-of-range codes are null, not a plausible number.
  for (const byte of NOTE_TABLE_HOLES) {
    assertEquals(plusNoteToMidi(byte), null, `hole ${byte}`);
  }
  for (
    const byte of [
      0,
      54,
      PLUS_NOTE_MIN - 1,
      PLUS_NOTE_MAX + 1,
      116,
      PLUS_NOTE_REST,
      PLUS_NOTE_TIE,
      255,
    ]
  ) {
    assertEquals(plusNoteToMidi(byte), null, `out of range ${byte}`);
  }
  // 33 entries + 12 holes is the whole 55..99 window the sequencer admits.
  assertEquals(
    NOTE_TABLE.length + NOTE_TABLE_HOLES.length,
    PLUS_NOTE_MAX - PLUS_NOTE_MIN + 1,
  );
  assertEquals(plusNoteName(60), "C4");
  assertEquals(plusNoteName(plusNoteToMidi(0x40)), "C4");
  assertEquals(plusNoteName(55), "G3");
});

Deno.test("the 6-bit field steps by 7 at 62, which is what makes REST and TIE", () => {
  assertEquals(plusNoteFromBits(0), 55);
  assertEquals(plusNoteFromBits(61), 116);
  assertEquals(plusNoteFromBits(62), PLUS_NOTE_REST);
  assertEquals(plusNoteFromBits(63), PLUS_NOTE_TIE);
  assertEquals(plusNoteFromBits(62) - plusNoteFromBits(61), 8);
  // Exact both ways over the whole domain — this is what the round trip needs.
  for (let v = 0; v < 64; v++) {
    assertEquals(plusNoteToBits(plusNoteFromBits(v)), v, `bits ${v}`);
  }
});

// --- instruments -------------------------------------------------------------

Deno.test("the 5-bit permutation is a true permutation and the alt map is its inverse", () => {
  // Entry for entry against the bytes in the executable, not just at the ends.
  assertEquals([...PLUS_INSTRUMENT_PERM], [...PERM_BYTES]);
  assertEquals([...PLUS_INSTRUMENT_UNPERM], [...UNPERM_BYTES]);
  assertEquals([...PLUS_INSTRUMENT_PROGRAMS], [...PROGRAM_MAP_BYTES]);
  assertEquals([...PLUS_INSTRUMENT_PROGRAMS_ALT], [...PROGRAM_MAP_ALT_BYTES]);

  assertEquals(PLUS_INSTRUMENT_PERM.length, 32);
  assertEquals(new Set(PLUS_INSTRUMENT_PERM).size, 32);
  assertEquals([...PLUS_INSTRUMENT_PERM].sort((a, b) => a - b), [
    ...Array(32).keys(),
  ]);
  for (let i = 0; i < 32; i++) {
    assertEquals(
      PLUS_INSTRUMENT_UNPERM[PLUS_INSTRUMENT_PERM[i]],
      i,
      `round trip ${i}`,
    );
  }
  // With the 0x8014E844 flag set the driver reads 0x800F03E8, which IS the
  // inverse table — so the permutation cancels and the program is the raw bits.
  assertEquals([...PLUS_INSTRUMENT_PROGRAMS_ALT], [...PROGRAM_MAP_ALT_BYTES]);
  // And the claim the comment above makes — that the flag's map IS the packer's
  // inverse — is now a comparison of two separately transcribed ROM runs
  // rather than an array spread against itself.
  assertEquals([...PROGRAM_MAP_ALT_BYTES], [...UNPERM_BYTES]);
  for (let raw = 0; raw < 32; raw++) {
    assertEquals(
      plusVoiceProgram(PLUS_INSTRUMENT_PERM[raw], 0, { alt: true }),
      raw + 1,
    );
  }
  // The default map is not a permutation: it reaches 32 and 33, and 7 is
  // duplicated by index 16 mapping to 7 while index 7 maps to 32.
  assertEquals(PLUS_INSTRUMENT_PROGRAMS.length, 32);
  assertEquals(PLUS_INSTRUMENT_PROGRAMS[7], 32);
  assertEquals(PLUS_INSTRUMENT_PROGRAMS[16], 7);
  assertEquals(plusVoiceProgram(0, 0), 1);
  assertEquals(plusVoiceProgram(0, 1), 91);
  assertEquals(plusVoiceProgram(7, 1), 32 + 91);

  // The two voices between them reach programs 1-34 and 91-124 and nothing
  // else. Those are the exact two runs the disc's own sample bank reserves for
  // melody — see the ALLBGMSE.VH test at the bottom.
  const reach = (voice) => {
    const all = [...Array(32).keys()].map((i) => plusVoiceProgram(i, voice));
    return [Math.min(...all), Math.max(...all)];
  };
  assertEquals(reach(0), [1, 34]);
  assertEquals(reach(1), [91, 124]);
});

// --- the tail ----------------------------------------------------------------

Deno.test("songSettings names the four tail bytes and turns the tempo index into BPM", () => {
  // The two tables entry for entry against the executable, before any lookup
  // through them is checked: sampling the endpoints would pass a typo in the
  // middle, and every index is in range by construction so the CORPUS test
  // cannot see one either.
  assertEquals([...PLUS_TEMPO_TABLE], [...TEMPO_BYTES]);
  assertEquals([...PLUS_VOLUME_TABLE], [...VOLUME_BYTES]);
  // The BPM numerator is derived from the two constants that document it, so
  // neither can drift from the formula unnoticed. 60 s x 60 fps x 4 ticks / 4
  // steps-per-beat = 3600.
  // Only the value, not the formula: restating the module's own expression
  // here would hold for every value of the three constants and could never be
  // the assertion that fails. Each constant is pinned individually by the BPM
  // expectations below — 4 -> 7 ticks, 4 -> 3 steps and 60 -> 50 fps each turn
  // this test red on its own. A ratio-preserving joint move (ticks and steps
  // both doubled) is the one hole left, and no check of the numerator can
  // close it.
  assertEquals(PLUS_BPM_NUMERATOR, 3600);
  // The three constants behind it, each against what the disassembly says
  // rather than against the formula they feed: 0x80058F20 is `addiu v0,v0,4`,
  // the machine is NTSC, and the sixteenth is the assumption the module's own
  // comment flags. Pinning the values is a transcription check; pinning the
  // formula would have been a restatement.
  assertEquals(PLUS_TEMPO_TICKS_PER_FRAME, 4);
  assertEquals(PLUS_FRAMES_PER_SECOND, 60);
  assertEquals(PLUS_STEPS_PER_BEAT, 4);

  assertEquals(plusSongSettings([7, 0, 0, 15]), {
    volumeIndex: 7,
    volume: 56,
    tempoIndex: 0,
    stepPeriod: 92,
    bpm: 3600 / 92,
    loopBar: 0,
    lastBar: 15,
    bars: 16,
  });
  const fast = plusSongSettings([0, 31, 3, 7]);
  assertEquals([fast.volume, fast.stepPeriod, fast.bpm], [0, 16, 225]);
  assertEquals([fast.loopBar, fast.lastBar, fast.bars], [3, 7, 8]);
  // The tempo index is five bits and the table has exactly 32 rows, so it can
  // never miss; the volume index is three bits against eight rows, likewise.
  assertEquals(plusSongSettings([7, 31, 0, 0]).stepPeriod, 16);
  assertAlmostEquals(plusSongSettings([0, 15, 0, 0]).bpm, 112.5, 1e-9);
});

// --- the bar header: the backing pattern -------------------------------------

Deno.test("barAccompaniment names the header fields, applies the clamps, and stays inside the ROM", () => {
  assertEquals(plusBarAccompaniment([8, 3, 9, 11]), {
    patternA: 8,
    patternB: 3,
    patternC: 4,
    extraTrack: true,
    transpose: 11,
    romOffset: 8 * 10240 + 3 * 2560 + 4 * 512,
  });
  // Out of range reads as 0, not as the nearest legal value.
  assertEquals(plusBarAccompaniment([9, 3, 10, 0]).patternA, 0);
  assertEquals(plusBarAccompaniment([15, 0, 15, 0]), {
    patternA: 0,
    patternB: 0,
    patternC: 0,
    extraTrack: false,
    transpose: 0,
    romOffset: 0,
  });
  // patternC's low bit is the gate on track 4, and is not part of the index.
  assertEquals(plusBarAccompaniment([0, 0, 8, 0]).patternC, 4);
  assertEquals(plusBarAccompaniment([0, 0, 9, 0]).patternC, 4);
  assertEquals(plusBarAccompaniment([0, 0, 8, 0]).extraTrack, false);
  assertEquals(plusBarAccompaniment([0, 0, 9, 0]).extraTrack, true);

  // Each inner stride, stated as the arithmetic that produces it rather than
  // as a literal. The last-byte check below constrains only the SUM
  // 7*track + 15*step + half = 510, which 66/3/3 satisfies just as well as
  // 64/4/2 — so on its own it pins nothing. Built up from the shape
  // (8 tracks x 16 steps x 2 half-steps x an (instrument, note) pair,
  // plus-song.js's PLUS_ACCOMP_ROM.shape) each one is nailed down.
  assertEquals(PLUS_ACCOMP_ROM.halfStride, 2); // the (instrument, note) pair
  assertEquals(PLUS_ACCOMP_ROM.stepStride, 2 * PLUS_ACCOMP_ROM.halfStride);
  assertEquals(PLUS_ACCOMP_ROM.trackStride, 16 * PLUS_ACCOMP_ROM.stepStride);
  assertEquals(
    PLUS_ACCOMP_ROM.patternCStride,
    PLUS_ACCOMP_TRACKS * PLUS_ACCOMP_ROM.trackStride,
  );
  assertEquals(
    PLUS_ACCOMP_ROM.patternBStride,
    5 * PLUS_ACCOMP_ROM.patternCStride,
  );
  assertEquals(
    PLUS_ACCOMP_ROM.patternAStride,
    4 * PLUS_ACCOMP_ROM.patternBStride,
  );

  // The widest legal record is the last half-step of the last step of the last
  // track of the last pattern — it must be the ROM's final byte pair. This is
  // the cross-check on the six strides above, not the definition of them.
  const last = plusBarAccompaniment([8, 3, 9, 0]).romOffset +
    (PLUS_ACCOMP_TRACKS - 1) * PLUS_ACCOMP_ROM.trackStride +
    15 * PLUS_ACCOMP_ROM.stepStride + PLUS_ACCOMP_ROM.halfStride;
  assertEquals(last + 2, PLUS_ACCOMP_ROM.bytes);
  assertEquals(9 * PLUS_ACCOMP_ROM.patternAStride, PLUS_ACCOMP_ROM.bytes);
});

Deno.test("the accompaniment octave fold is the two branches, with exclusive bounds", () => {
  for (
    const table of [
      PLUS_ACCOMP_FOLD_LO,
      PLUS_ACCOMP_FOLD_MID,
      PLUS_ACCOMP_FOLD_HI,
    ]
  ) {
    assertEquals(table.length, PLUS_ACCOMP_PITCHED_TRACKS);
  }
  // WRITTEN OUT, like every other ROM run this file transcribes. Exercising
  // the fold through plusFoldAccompanimentNote() only ever reached rows 0 and
  // 4 — the endpoints — which left ten of these fifteen values free to be
  // anything at all with the suite still green. A per-track bound is exactly
  // the kind of number a transcription slip lands on silently, because a wrong
  // bound still folds SOMETHING and the result still looks like music.
  assertEquals([...PLUS_ACCOMP_FOLD_LO], [56, 32, 44, 44, 15]);
  assertEquals([...PLUS_ACCOMP_FOLD_MID], [81, 57, 69, 69, 255]);
  assertEquals([...PLUS_ACCOMP_FOLD_HI], [92, 68, 80, 80, 255]);
  // Rows 1..3 were unreachable before, so each gets the same three probes
  // track 0 gets: above HI folds, inside (LO, MID) folds, at LO does not.
  assertEquals(plusFoldAccompanimentNote(69, 1), 57); // track 1 HI 68
  assertEquals(plusFoldAccompanimentNote(33, 1), 21); // inside (32, 57)
  assertEquals(plusFoldAccompanimentNote(32, 1), 32); // at LO
  assertEquals(plusFoldAccompanimentNote(81, 2), 69); // track 2 HI 80
  assertEquals(plusFoldAccompanimentNote(45, 2), 33); // inside (44, 69)
  assertEquals(plusFoldAccompanimentNote(44, 2), 44); // at LO
  assertEquals(plusFoldAccompanimentNote(81, 3), 69); // track 3 mirrors track 2
  assertEquals(plusFoldAccompanimentNote(45, 3), 33);
  assertEquals(plusFoldAccompanimentNote(44, 3), 44);
  // Track 0: LO 56, MID 81, HI 92.
  assertEquals(plusFoldAccompanimentNote(93, 0), 81); // above HI
  assertEquals(plusFoldAccompanimentNote(92, 0), 92); // AT HI: the test is >, not >=
  assertEquals(plusFoldAccompanimentNote(57, 0), 45); // inside (LO, MID)
  assertEquals(plusFoldAccompanimentNote(80, 0), 68);
  assertEquals(plusFoldAccompanimentNote(56, 0), 56); // AT LO: not inside
  assertEquals(plusFoldAccompanimentNote(81, 0), 81); // AT MID: not inside
  assertEquals(plusFoldAccompanimentNote(55, 0), 55); // below LO and below HI
  assertEquals(plusFoldAccompanimentNote(82, 0), 82); // between MID and HI
  // The subtraction happens once, never in a loop: 200 is far above HI and
  // still only drops twelve.
  assertEquals(plusFoldAccompanimentNote(200, 0), 188);

  // Track 4's row folds everything above 15, because MID is 255.
  assertEquals(PLUS_ACCOMP_EXTRA_TRACK, 4);
  assertEquals(plusFoldAccompanimentNote(16, 4), 4);
  assertEquals(plusFoldAccompanimentNote(100, 4), 88);
  assertEquals(plusFoldAccompanimentNote(15, 4), 15);
  assertEquals(plusFoldAccompanimentNote(255, 4), 255); // AT both MID and HI

  // Tracks 5..7 never reach the fold — 0x80058258's `slti s3, 5` skips the
  // transpose and the fold together — so asking for a folded note on one is a
  // caller error and THROWS. Asserting "returns 100 unchanged" here would be
  // vacuous: the tables have five entries, so PLUS_ACCOMP_FOLD_HI[5] is
  // undefined and `100 > undefined` is false whether the guard is there or
  // not. The throw is what makes this line able to go red.
  for (let t = PLUS_ACCOMP_PITCHED_TRACKS; t < PLUS_ACCOMP_TRACKS; t++) {
    assertThrows(
      () => plusFoldAccompanimentNote(100, t),
      RangeError,
      "not pitched",
      `track ${t}`,
    );
  }
  // And the guard is the only thing standing between this and reading LO[5]
  // off the end: the three tables are laid end to end in the binary, so a
  // hardware read for track 5 would come back with MID[0], not "unchanged".
  assertEquals(PLUS_ACCOMP_FOLD_MID[0], 81);
});

// --- events ------------------------------------------------------------------

Deno.test("a tie extends a note, a rest closes it, and an open note runs to the end", () => {
  const song = restSong();
  const set = (voice, step, note, instrument = 3) => {
    song.bars[step >> 4].voices[voice][step & 15] = {
      instrument,
      note,
      raw5: PLUS_INSTRUMENT_UNPERM[instrument],
      raw6: plusNoteToBits(note),
    };
  };
  set(0, 0, 64); // C4, held by three ties, then a rest at step 4
  set(0, 1, PLUS_NOTE_TIE);
  set(0, 2, PLUS_NOTE_TIE);
  set(0, 3, PLUS_NOTE_TIE);
  set(0, 8, 65); // a note immediately replaced by the next one
  set(0, 9, 67);
  set(0, 250, 72); // never closed: ties carry it past the last step
  for (let s = 251; s < 256; s++) set(0, s, PLUS_NOTE_TIE);

  const events = plusVoiceEvents(song, 0);
  assertEquals(events.length, 4);
  assertEquals(events[0], {
    step: 0,
    bar: 0,
    stepInBar: 0,
    noteByte: 64,
    midi: 60,
    name: "C4",
    instrument: 3,
    program: plusVoiceProgram(3, 0),
    durationSteps: 4,
  });
  assertEquals(events.map((e) => [e.step, e.durationSteps]), [[0, 4], [8, 1], [
    9,
    1,
  ], [250, 6]]);
  // The other voice is all rests, so it produces nothing at all.
  assertEquals(plusVoiceEvents(song, 1), []);
  // Voice 1's program bias is the +91 one.
  set(1, 0, 64, 0);
  assertEquals(plusVoiceEvents(song, 1)[0].program, 91);
});

// --- the community collection ------------------------------------------------
//
// dev-fixtures/ is gitignored; these skip without it. Partitioned by CONTENT
// rather than by folder, for the reason psx-fixtures.test.js sets out at
// length: 20 of the dumps filed under "Dezaemon Kids!/" are Dezaemon+ saves.

const DEV_FIXTURES = new URL("../../../dev-fixtures/", import.meta.url);

function savesUnder(folder) {
  const root = new URL(`${encodeURIComponent(folder)}/`, DEV_FIXTURES);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const url = new URL(
        `${encodeURIComponent(e.name)}${e.isDirectory ? "/" : ""}`,
        dir,
      );
      if (e.isDirectory) walk(url);
      else if (
        !e.name.startsWith("._") && e.name.toLowerCase().endsWith(".sav")
      ) out.push(url);
    }
  };
  walk(root);
  return out.sort((a, b) => a.href.localeCompare(b.href));
}

function plusBlockOf(url) {
  const located = locateSaves(Deno.readFileSync(url));
  const save = located.saves[0];
  if (!save || identifyGame(save.data, save.filename) !== "plus") return null;
  return save.data;
}

const PLUS_BLOCKS = [
  ...savesUnder("Dezaemon+"),
  ...savesUnder("Dezaemon Kids!"),
]
  .map((url) => ({ label: fromFileUrl(url), block: plusBlockOf(url) }))
  .filter((r) => r.block !== null);

// What this proves: decode and encode are MUTUAL INVERSES over every song
// anyone has written, and every slot's two slack bytes are zero. What it does
// NOT prove, and must not be read as proving, is that the bit layout is right
// — see the note at the top of this file. The CORPUS test below is the one
// that can go red on a wrong layout.
Deno.test({
  name:
    "ROUND TRIP: decode and encode are mutual inverses over the whole collection",
  ignore: PLUS_BLOCKS.length === 0,
  fn() {
    let songs = 0;
    for (const { label, block } of PLUS_BLOCKS) {
      for (let i = 0; i < PLUS_SONG_COUNT; i++) {
        const at = PLUS_SOUND_OFFSET + i * PLUS_SONG_SIZE;
        const original = block.subarray(at, at + PLUS_SONG_SIZE);
        const again = encodePlusSong(decodePlusSong(block, at));
        // Compared as whole slots, not just the 734 bits-bearing bytes: the two
        // slack bytes are zero in every song anyone has written, so the
        // re-encode is exact over the container as well as over the format.
        // This part IS data-backed — flipping a bit in byte 734 or 735 of a
        // real song is the one mutation this test catches on its own.
        assertEquals(again, original, `${label} song ${i}`);
        songs++;
      }
    }
    // `songs` is the loop-trip count, so comparing it to
    // PLUS_BLOCKS.length * PLUS_SONG_COUNT is an identity and cannot fail. The
    // guard that is actually wanted here — the one psx-fixtures.test.js states
    // as "a loop that silently walked nothing" — has to bound the COLLECTION,
    // because everything downstream of a shrunken corpus stays green: slicing
    // PLUS_BLOCKS to a single save leaves this file 15/15. 60 is well under the
    // 67 blocks present and well over anything a partial discovery would find.
    assert(
      PLUS_BLOCKS.length >= 60,
      `only ${PLUS_BLOCKS.length} save blocks were discovered`,
    );
    assertEquals(songs, PLUS_BLOCKS.length * PLUS_SONG_COUNT);
  },
});

// THE TEST THE LAYOUT RESTS ON. Unlike the round trip this is falsifiable
// from data the decoder had no hand in: 1,072 songs written by people who
// never saw it, against a note table with twelve holes inside its own 55..99
// window. A reversed 5+6 split, a moved note base, a note step off by one and
// a rewidened bar header all push real bytes into those holes.
Deno.test({
  name:
    "CORPUS: the only note bytes that occur are the table's 33 entries, plus REST and TIE",
  ignore: PLUS_BLOCKS.length === 0,
  fn() {
    const entries = new Set(NOTE_TABLE.map(([byte]) => byte));
    const seen = new Set();
    for (const { label, block } of PLUS_BLOCKS) {
      for (const song of decodePlusSongs(block)) {
        for (const bar of song.bars) {
          for (const voice of bar.voices) {
            for (const cell of voice) {
              seen.add(cell.note);
              assert(
                entries.has(cell.note) || cell.note === PLUS_NOTE_REST ||
                  cell.note === PLUS_NOTE_TIE,
                `${label} song ${song.index}: note byte ${cell.note} is neither a table entry nor REST/TIE`,
              );
              assert(
                cell.instrument < 32,
                `${label} song ${song.index}: instrument ${cell.instrument}`,
              );
            }
          }
        }
      }
    }
    // Not one table hole and nothing above 99 in the whole collection, which is
    // what says the 55..99 window and its twelve gaps are real and not an
    // artefact of how the table happens to be laid out in the binary.
    for (const hole of NOTE_TABLE_HOLES) {
      assert(!seen.has(hole), `hole ${hole} occurs`);
    }
    assert(seen.size > 1, "the walk found nothing");
  },
});

Deno.test({
  name:
    "CORPUS: the header and tail fields stay inside the clamps and the tables",
  ignore: PLUS_BLOCKS.length === 0,
  fn() {
    for (const { label, block } of PLUS_BLOCKS) {
      for (const song of decodePlusSongs(block)) {
        const where = `${label} song ${song.index}`;
        for (const bar of song.bars) {
          const acc = plusBarAccompaniment(bar.head);
          // No real save trips a clamp, so the clamped value always equals the
          // stored one — a decoder that mis-split the header would break this
          // long before it produced an out-of-range pattern index.
          assertEquals(acc.patternA, bar.head[0], `${where}: patternA`);
          assertEquals(acc.patternB, bar.head[1], `${where}: patternB`);
          assert(bar.head[2] < 10, `${where}: patternC ${bar.head[2]}`);
          assert(
            acc.romOffset + PLUS_ACCOMP_ROM.patternCStride <=
              PLUS_ACCOMP_ROM.bytes,
            `${where}: romOffset`,
          );
          assert(bar.head[3] <= 11, `${where}: transpose ${bar.head[3]}`);
        }
        const settings = plusSongSettings(song.tail);
        assert(
          settings.volume !== null,
          `${where}: volume index ${song.tail[0]}`,
        );
        assert(
          settings.stepPeriod !== null,
          `${where}: tempo index ${song.tail[1]}`,
        );
        assert(
          settings.loopBar < PLUS_SONG_BARS,
          `${where}: loopBar ${settings.loopBar}`,
        );
        assert(
          settings.lastBar < PLUS_SONG_BARS,
          `${where}: lastBar ${settings.lastBar}`,
        );
      }
    }
  },
});

// --- the disc's own sample bank ----------------------------------------------
//
// ALLBGMSE.VH is disc content, not in this repo — hasDiscFile finds it inside a
// disc image dropped in dev-fixtures/, the same way the Saturn tone-bank tests
// find SNDPAC.BIN, and this skips without one.

Deno.test({
  name:
    "ALLBGMSE.VH samples the melody programs over exactly the note table's output range",
  ignore: !hasDiscFile("ALLBGMSE.VH"),
  fn() {
    const vh = loadDiscFile("ALLBGMSE.VH");
    // A VAB header: 32 bytes, then 128 program attributes of 16 (byte 0 is the
    // tone count), then 128 groups of 16 tone attributes of 32 (min key at +6,
    // max key at +7). The size check is what makes the offsets self-proving.
    assertEquals(new TextDecoder().decode(vh.subarray(0, 4)), "pBAV");
    const PROGRAMS = 128,
      TONES = 16,
      TONE_SIZE = 32,
      TONE_BASE = 32 + PROGRAMS * 16;
    assertEquals(vh.length, TONE_BASE + PROGRAMS * TONES * TONE_SIZE);

    const range = (program) => {
      const count = vh[32 + program * 16];
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < count; t++) {
        const at = TONE_BASE + program * TONES * TONE_SIZE + t * TONE_SIZE;
        lo = Math.min(lo, vh[at + 6]);
        hi = Math.max(hi, vh[at + 7]);
      }
      return count === 0 ? null : [lo, hi];
    };

    // Every program either voice can name is multisampled over 55..87 — and
    // 55..87 is precisely what the note table emits, since its high bytes for
    // note codes 55 and 99 are 55 and 87. A note table read one byte off, or a
    // program bias one off, would leave this range somewhere else entirely.
    const expected = [
      plusNoteToMidi(PLUS_NOTE_MIN),
      plusNoteToMidi(PLUS_NOTE_MAX),
    ];
    assertEquals(expected, [55, 87]);
    for (const voice of [0, 1]) {
      for (let i = 0; i < 32; i++) {
        const program = plusVoiceProgram(i, voice);
        assertEquals(
          range(program),
          expected,
          `voice ${voice} instrument ${i} -> program ${program}`,
        );
      }
    }
    // And the run stops there: the programs on either side are something else.
    assertNotEquals(range(35), expected);
    assertNotEquals(range(90), expected);
    assertNotEquals(range(125), expected);
  },
});
