// The music maker's song model: views that never normalise, and edits that
// write only the cells they are about, in values 音まろ itself writes.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { readPartEvents, SONG_SIZE } from "../src/decode/decode-song.js";
import { emptySong } from "../src/audio/bgm-record.js";
import { encodeDezaSong } from "../src/audio/song-write.js";
import {
  cellAt,
  controlAt,
  controlOffset,
  headerOf,
  partCells,
  partNotes,
  songShape,
  stepOffsets,
} from "../src/audio/song-view.js";
import {
  clearRhythm,
  copyMeasures,
  deleteMeasures,
  eraseNote,
  insertMeasures,
  moveNote,
  paintInstrument,
  pasteMeasures,
  placeNote,
  placeNotes,
  resizeNote,
  setHeader,
  setRhythm,
  tidyMeasures,
  transposeMeasures,
} from "../src/audio/song-edit.js";
import { songStreams } from "../src/audio/song-streams.js";

/** Offsets where two songs differ. */
function diff(a, b) {
  const out = [];
  for (let i = 0; i < SONG_SIZE; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

function cellOffsets(part, from, to) {
  const out = [];
  for (let s = from; s < to; s++) out.push(...stepOffsets(part, s));
  return out.sort((x, y) => x - y);
}

Deno.test("placeNote writes the onset and its ties, and nothing else", () => {
  const blank = emptySong();
  const one = placeNote(blank, { part: 1, step: 20, len: 3, pitch: 30, inst: 7 });
  assertEquals(diff(blank, one), cellOffsets(1, 20, 23));
  assertEquals(cellAt(one, 1, 20), { voice: 7, pitch: 30 });
  assertEquals(cellAt(one, 1, 21), { voice: 0x80, pitch: 30 });
  assertEquals(cellAt(one, 1, 22), { voice: 0x80, pitch: 30 });
  assertEquals(partNotes(one, 1), [{ step: 20, len: 3, pitch: 30, inst: 7, bends: [] }]);
  assertEquals(blank, emptySong(), "the input is never mutated");
});

Deno.test("a note stops at the next onset, and a note struck inside a tail cuts it cleanly", () => {
  let s = placeNote(emptySong(), { part: 0, step: 0, len: 8, pitch: 20, inst: 1 });
  s = placeNote(s, { part: 0, step: 10, len: 2, pitch: 22, inst: 1 });
  // Asking for 16 steps from 4 stops at the onset on 10.
  s = placeNote(s, { part: 0, step: 4, len: 16, pitch: 24, inst: 2 });
  assertEquals(partNotes(s, 0).map((n) => [n.step, n.len, n.pitch]), [[0, 4, 20], [4, 6, 24], [10, 2, 22]]);
  // A short note inside a long one: the long one's leftover tail is rest,
  // not a tie that would hold the new note on.
  let t = placeNote(emptySong(), { part: 2, step: 0, len: 16, pitch: 40, inst: 3 });
  t = placeNote(t, { part: 2, step: 4, len: 2, pitch: 41, inst: 3 });
  assertEquals(partNotes(t, 2).map((n) => [n.step, n.len]), [[0, 4], [4, 2]]);
  for (let st = 6; st < 16; st++) assertEquals(cellAt(t, 2, st), { voice: 0, pitch: 0 });
  assertEquals(songShape(t).canonical, true);
});

Deno.test("eraseNote clears a whole note from any of its steps; on a stray cell it clears that cell", () => {
  const s = placeNote(emptySong(), { part: 3, step: 32, len: 5, pitch: 12, inst: 40 });
  assertEquals(eraseNote(s, 3, 35), emptySong());
  // A rest whose voice byte names an instrument (carts carry 128,894 of them).
  const stray = emptySong();
  stray[stepOffsets(0, 7)[0]] = 28;
  assertEquals(songShape(stray).issues.map((i) => i.kind), ["rest-voice"]);
  assertEquals(eraseNote(stray, 0, 7), emptySong());
});

Deno.test("resizeNote stretches with held-pitch ties and shrinks back to rest", () => {
  const s = placeNote(emptySong(), { part: 0, step: 16, len: 2, pitch: 33, inst: 5 });
  const long = resizeNote(s, 0, 16, 6);
  assertEquals(partNotes(long, 0)[0].len, 6);
  assertEquals(diff(s, long), cellOffsets(0, 18, 22));
  assertEquals(resizeNote(long, 0, 16, 2), s);
  assertThrows(() => resizeNote(s, 0, 17, 3), RangeError, "no note starting");
});

Deno.test("moveNote keeps length and instrument; paintInstrument touches only the onset byte", () => {
  const s = placeNote(emptySong(), { part: 1, step: 0, len: 4, pitch: 25, inst: 9 });
  const moved = moveNote(s, 1, 0, { step: 64, pitch: 27, part: 2 });
  assertEquals(partNotes(moved, 1), []);
  assertEquals(partNotes(moved, 2), [{ step: 64, len: 4, pitch: 27, inst: 9, bends: [] }]);
  const painted = paintInstrument(s, 1, 2, 44);
  assertEquals(diff(s, painted), [stepOffsets(1, 0)[0]]);
  assertEquals(partNotes(painted, 1)[0].inst, 44);
});

Deno.test("setRhythm writes the four control bytes and keeps ctrl2's bits 7 and 0", () => {
  const s = setRhythm(emptySong(), 5, { bank: 3, pattern: 2, chord: 4, key: 7 });
  assertEquals(controlAt(s, 5).raw, [3, 2, (4 << 1) | 0x80, 7]);
  assertEquals(diff(emptySong(), s), [controlOffset(5, 0), controlOffset(5, 1), controlOffset(5, 2), controlOffset(5, 3)]);
  const odd = emptySong();
  odd[controlOffset(2, 2)] = 0x01; // bit 0 set, bit 7 clear (cart data)
  assertEquals(controlAt(setRhythm(odd, 2, { chord: 2 }), 2).raw[2], (2 << 1) | 0x01);
  assertEquals(clearRhythm(s, 5), emptySong());
});

Deno.test("setHeader writes only the fields it is given", () => {
  const s = setHeader(emptySong(), { tempoIndex: 20, echo: 5 });
  assertEquals(diff(emptySong(), s), [2, 3]);
  assertEquals(headerOf(s).bpm, 3600 / 0x1d);
  assertThrows(() => setHeader(s, { loopStart: 10, loopEnd: 4 }), RangeError, "before loopStart");
});

Deno.test("edits refuse values 音まろ does not write", () => {
  const s = emptySong();
  assertThrows(() => placeNote(s, { part: 0, step: 0, pitch: 60, inst: 0 }), RangeError);
  assertThrows(() => placeNote(s, { part: 0, step: 0, pitch: 0, inst: 0 }), RangeError);
  assertThrows(() => placeNote(s, { part: 0, step: 0, pitch: 10, inst: 60 }), RangeError);
  assertThrows(() => placeNote(s, { part: 4, step: 0, pitch: 10, inst: 0 }), RangeError);
  assertThrows(() => placeNote(s, { part: 0, step: 512, pitch: 10, inst: 0 }), RangeError);
  assertThrows(() => setRhythm(s, 0, { bank: 9 }), RangeError);
  assertThrows(() => setRhythm(s, 0, { pattern: 4 }), RangeError);
  assertThrows(() => setRhythm(s, 0, { chord: 5 }), RangeError);
  assertThrows(() => setRhythm(s, 0, { key: 12 }), RangeError);
  assertThrows(() => setHeader(s, { echo: 8 }), RangeError);
  assertThrows(() => setHeader(s, { tempoIndex: 32 }), RangeError);
});

Deno.test("an 0xFF measure refuses edits until tidied", () => {
  const s = emptySong();
  s.fill(0xff, controlOffset(3), controlOffset(4));
  assertEquals(songShape(s).issues.map((i) => i.kind), ["ff-measure"]);
  assertThrows(() => placeNote(s, { part: 0, step: 50, pitch: 10, inst: 0 }), RangeError, "tidy");
  assertThrows(() => setRhythm(s, 3, { bank: 1 }), RangeError, "tidy");
  const tidy = tidyMeasures(s, 3);
  assertEquals(tidy, emptySong());
  assertEquals(placeNote(tidy, { part: 0, step: 50, pitch: 10, inst: 0 })[stepOffsets(0, 50)[1]], 10);
});

Deno.test("placeNotes onto the blank slot equals encodeDezaSong of the same events", () => {
  const parts = [
    [{ step: 0, len: 4, note: 25, instrument: 13 }, { step: 4, len: 2, note: 27, instrument: 13 }],
    [{ step: 0, len: 16, note: 1, instrument: 18 }],
    [],
    [{ step: 3, len: 1, note: 50, instrument: 48 }, { step: 511, len: 1, note: 3, instrument: 41 }],
  ];
  let s = emptySong();
  parts.forEach((events, p) => {
    s = placeNotes(s, p, events);
  });
  // encodeDezaSong's header defaults are the blank slot's.
  assertEquals(s, encodeDezaSong({ parts }));
  for (let p = 0; p < 4; p++) {
    assertEquals(
      partNotes(s, p).map(({ step, len, pitch, inst }) => ({ step, note: pitch, instrument: inst, len })),
      readPartEvents(s, p),
    );
  }
});

Deno.test("copy and paste: a measure pasted back in place is the identity; parts and rhythm can be picked", () => {
  let s = placeNote(emptySong(), { part: 0, step: 16, len: 8, pitch: 30, inst: 2 });
  s = setRhythm(s, 1, { bank: 2, pattern: 1 });
  const clip = copyMeasures(s, 1);
  assertEquals(pasteMeasures(s, 1, clip), s);
  const melodyOnly = pasteMeasures(emptySong(), 7, clip, { rhythm: false });
  assertEquals(partNotes(melodyOnly, 0).map((n) => n.step), [7 * 16]);
  assertEquals(controlAt(melodyOnly, 7).raw, [0, 0, 0x80, 3]);
  const all = copyMeasures(s, 0, 32);
  assertEquals(pasteMeasures(emptySong(), 0, all), s);
});

Deno.test("insert and delete measures shift whole measures and never leave a tail hanging", () => {
  let s = placeNote(emptySong(), { part: 0, step: 8, len: 16, pitch: 20, inst: 1 }); // 8..23, across 0|1
  s = placeNote(s, { part: 1, step: 32, len: 4, pitch: 22, inst: 1 });
  const ins = insertMeasures(s, 1);
  assertEquals(partNotes(ins, 0).map((n) => [n.step, n.len]), [[8, 8]]); // cut at the gap
  assertEquals(partNotes(ins, 1).map((n) => n.step), [48]);
  assertEquals(songShape(ins).canonical, true);
  const del = deleteMeasures(s, 1);
  assertEquals(partNotes(del, 0).map((n) => [n.step, n.len]), [[8, 8]]);
  assertEquals(partNotes(del, 1).map((n) => n.step), [16]);
  // Deleting the measure an onset sits in drops its tail too.
  const del0 = deleteMeasures(s, 0);
  assertEquals(partNotes(del0, 0), []);
  assertEquals(songShape(del0).canonical, true);
});

Deno.test("transposeMeasures moves notes and keys, refusing notes it would push off the keyboard", () => {
  let s = placeNote(emptySong(), { part: 0, step: 0, len: 2, pitch: 58, inst: 1 });
  s = placeNote(s, { part: 1, step: 0, len: 2, pitch: 10, inst: 1 });
  s = setRhythm(s, 0, { bank: 3, key: 3 }); // key index 3 = 0 semitones
  const { bytes, refused } = transposeMeasures(s, 0, 0, 2, { rhythm: true });
  assertEquals(refused, [{ part: 0, step: 0 }]);
  assertEquals(partNotes(bytes, 0)[0].pitch, 58);
  assertEquals(partNotes(bytes, 1)[0].pitch, 12);
  assertEquals(cellAt(bytes, 1, 1).pitch, 12);
  assertEquals(controlAt(bytes, 0).transpose, 2);
  // +7 from 0 wraps to -5 (the table spans -5..+6).
  assertEquals(controlAt(transposeMeasures(s, 0, 0, 7, { rhythm: true, parts: [] }).bytes, 0).transpose, -5);
});

Deno.test("views keep what carts carry: bends, orphan ties and stray pitches are listed, not fixed", () => {
  const s = placeNote(emptySong(), { part: 0, step: 0, len: 4, pitch: 16, inst: 0 });
  s[stepOffsets(0, 3)[1]] = 13; // a bent tie (cart data)
  s[stepOffsets(1, 5)[0]] = 0x80; // a tie with nothing sounding
  s[stepOffsets(2, 9)[1]] = 83; // a pitch byte above the keyboard
  assertEquals(partNotes(s, 0)[0].bends, [{ step: 3, pitch: 13 }]);
  assertEquals(partCells(s, 1)[5], "orphan-tie");
  assertEquals(partCells(s, 2)[9], "pitch-range");
  assertEquals(songShape(s).issues.map((i) => i.kind).sort(), ["bend", "orphan-tie", "pitch-range"]);
  // An edit elsewhere leaves them exactly as they were.
  const t = placeNote(s, { part: 3, step: 100, pitch: 20, inst: 1 });
  assertEquals(diff(s, t), [stepOffsets(3, 100)[0], stepOffsets(3, 100)[1]]);
});

/** A blank song whose measure `m` is cart garbage: four 0xFF control bytes and every cell a tie. */
function withFfMeasure(s, m) {
  const out = s.slice();
  out.fill(0xff, controlOffset(m), controlOffset(m) + 132);
  return out;
}

Deno.test("a note may not run on into an 0xFF measure, and one that already does can still be erased", () => {
  const s = withFfMeasure(emptySong(), 3); // steps 48-63
  // Ending right where the garbage begins would pick up its ties.
  assertThrows(() => placeNote(s, { part: 0, step: 47, len: 1, pitch: 30, inst: 0 }), RangeError, "0xFF");
  const short = placeNote(s, { part: 0, step: 44, len: 1, pitch: 30, inst: 0 });
  assertThrows(() => resizeNote(short, 0, 44, 4), RangeError, "0xFF");
  assertEquals(partNotes(resizeNote(short, 0, 44, 3), 0)[0].len, 3);
  // A cart note tied on into the garbage (its cells were written by hand).
  const cart = s.slice();
  cart[stepOffsets(0, 46)[0]] = 7;
  cart[stepOffsets(0, 46)[1]] = 20;
  cart[stepOffsets(0, 47)[0]] = 0x80;
  cart[stepOffsets(0, 47)[1]] = 20;
  assertEquals(partNotes(cart, 0)[0].len, 18);
  const erased = eraseNote(cart, 0, 50);
  assertEquals(partNotes(erased, 0), []);
  assertEquals([...erased.subarray(controlOffset(3), controlOffset(3) + 132)], new Array(132).fill(0xff), "the garbage is left alone");
  // Transposing such a note would write into the garbage: refused instead.
  const t = transposeMeasures(cart, 2, 2, 5);
  assertEquals(t.refused, [{ part: 0, step: 46 }]);
  assertEquals(t.bytes, cart);
});

Deno.test("pasting mends its joins: a cut note loses its old tail, a pasted tie holds only its own pitch", () => {
  // The song holds a note across bars 1|2; paste a different bar over bar 1.
  let s = placeNote(emptySong(), { part: 0, step: 20, len: 16, pitch: 30, inst: 1 }); // 20..35
  const other = placeNote(emptySong(), { part: 0, step: 0, len: 2, pitch: 40, inst: 2 });
  const pasted = pasteMeasures(s, 1, copyMeasures(other, 0), { rhythm: false });
  assertEquals(partNotes(pasted, 0).map((n) => [n.step, n.len, n.pitch]), [[16, 2, 40]]);
  assertEquals(songShape(pasted).canonical, true);
  // A clip that opens on a tie lands after a note of another pitch: rest, not a held note.
  const tieClip = placeNote(emptySong(), { part: 1, step: 8, len: 16, pitch: 22, inst: 3 }); // into bar 1
  s = placeNote(emptySong(), { part: 1, step: 60, len: 4, pitch: 10, inst: 3 }); // sounding at the end of bar 3
  const p2 = pasteMeasures(s, 4, copyMeasures(tieClip, 1), { rhythm: false });
  assertEquals(partNotes(p2, 1).map((n) => [n.step, n.len]), [[60, 4]]);
  assertEquals(songShape(p2).canonical, true);
  // Pasted back in place: the identity, ties and all.
  assertEquals(pasteMeasures(tieClip, 1, copyMeasures(tieClip, 1)), tieClip);
});

Deno.test("0xFF garbage moves only as a whole measure", () => {
  const ff = withFfMeasure(emptySong(), 2);
  const clip = copyMeasures(ff, 2);
  assertThrows(() => pasteMeasures(emptySong(), 5, clip, { parts: [true, false, false, false] }), RangeError, "0xFF");
  assertThrows(() => pasteMeasures(emptySong(), 5, clip, { parts: [] }), RangeError, "0xFF");
  assertThrows(() => pasteMeasures(ff, 2, copyMeasures(emptySong(), 0), { parts: [true] }), RangeError, "0xFF");
  // Whole: allowed, in place it is the identity.
  assertEquals(pasteMeasures(ff, 2, clip), ff);
});

Deno.test("setRhythm and setHeader write only what they are given, on cart bytes that are off the table", () => {
  const odd = emptySong();
  odd.set([0xd1, 0x02, 0x2b, 0xff], controlOffset(4)); // a cart measure's garbage control bytes
  const s = setRhythm(odd, 4, { bank: 2 });
  assertEquals(controlAt(s, 4).raw, [2, 0x02, 0x2b, 0xff]);
  const h = emptySong();
  h[3] = 0x3f; // a tempo byte past the table
  assertEquals([...setHeader(h, { echo: 6 }).subarray(0, 4)], [0, 31, 6, 0x3f]);
});

Deno.test("measure joins go by notes, not by ties: orphan ties stay orphans, and never latch onto a note", () => {
  // An orphan tie run at the start of bar 2 (cart data), a note in bar 0.
  let s = placeNote(emptySong(), { part: 0, step: 4, len: 2, pitch: 30, inst: 1 });
  s[stepOffsets(0, 32)[0]] = 0x80;
  s[stepOffsets(0, 32)[1]] = 30;
  // Inserting before it moves it along untouched.
  const ins = insertMeasures(s, 1);
  assertEquals(partCells(ins, 0)[48], "orphan-tie");
  // Deleting bar 1 brings it next to bar 0's end — where nothing sounds, so it stays.
  assertEquals(partCells(deleteMeasures(s, 1), 0)[16], "orphan-tie");
  // But if a note sounds at the join, the orphan would hold it on: it goes.
  const held = placeNote(s, { part: 0, step: 8, len: 8, pitch: 30, inst: 1 }); // sounding to step 15
  const del = deleteMeasures(held, 1);
  assertEquals(partNotes(del, 0).map((n) => [n.step, n.len]), [[4, 2], [8, 8]]);
});

// A small deterministic PRNG, so a failure names its seed.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

Deno.test("1,000 random edits keep a song canonical, and its streams agree with its notes", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed);
    const pick = (n) => Math.floor(r() * n);
    let s = emptySong();
    for (let i = 0; i < 100; i++) {
      const part = pick(4);
      const notes = partNotes(s, part);
      const any = notes.length ? notes[pick(notes.length)] : null;
      switch (pick(11)) {
        case 0:
        case 1:
        case 2:
          s = placeNote(s, { part, step: pick(512), len: 1 + pick(24), pitch: 1 + pick(59), inst: pick(60) });
          break;
        case 3:
          s = eraseNote(s, part, pick(512));
          break;
        case 4:
          if (any) s = resizeNote(s, part, any.step, 1 + pick(32));
          break;
        case 5:
          if (any) s = moveNote(s, part, any.step, { step: pick(512), pitch: 1 + pick(59), part: pick(4) });
          break;
        case 6:
          if (any) s = paintInstrument(s, part, any.step, pick(60));
          break;
        case 7:
          s = setRhythm(s, pick(32), { bank: pick(9), pattern: pick(4), chord: pick(5), key: pick(12) });
          break;
        case 8:
          s = setHeader(s, { tempoIndex: pick(32), echo: pick(8) });
          break;
        case 9:
          s = pick(2) ? insertMeasures(s, pick(32)) : deleteMeasures(s, pick(32));
          break;
        case 10:
          s = transposeMeasures(s, 0, 31, pick(5) - 2, { rhythm: true }).bytes;
          break;
      }
      const shape = songShape(s);
      assert(shape.canonical, `seed ${seed} op ${i}: ${JSON.stringify(shape.issues.slice(0, 3))}`);
    }
    const streams = songStreams(s);
    for (let p = 0; p < 4; p++) {
      assertEquals(
        streams.parts[p],
        partNotes(s, p).map(({ step, len, pitch, inst }) => ({ step, note: pitch, len, inst })),
        `seed ${seed} part ${p}`,
      );
    }
  }
});
