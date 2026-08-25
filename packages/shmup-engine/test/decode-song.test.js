// BGM decoder tests — sec6's 24 song slots, 4 parts x 32 measures.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeSong,
  decodeSongs,
  isNote,
  isOnset,
  isSustain,
  MEASURE_HEADER,
  MEASURE_SIZE,
  MEASURES,
  PART_BLOCK,
  PARTS,
  PITCH_OFFSET,
  SONG_HEADER,
  SONG_SIZE,
  SONG_SLOTS,
  STEPS_PER_MEASURE,
  TEMPO_TABLE,
  TRANSPOSE_TABLE,
  VOICE_OFFSET,
} from "../src/decode/decode-song.js";
import { SECTION_SIZES } from "../src/decompress.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

Deno.test("song geometry accounts for every byte of a slot and of sec6", () => {
  assertStrictEquals(SONG_HEADER + MEASURES * MEASURE_SIZE, SONG_SIZE);
  assertStrictEquals(4 + PARTS * PART_BLOCK, MEASURE_SIZE);
  assertStrictEquals(PART_BLOCK, 2 * STEPS_PER_MEASURE); // voice column + pitch column
  assertStrictEquals(SONG_SLOTS * SONG_SIZE, SECTION_SIZES[6]);
});

Deno.test("step classification: onsets, ties and rests are disjoint", () => {
  assert(isNote(0x01) && isNote(0x3b));
  assert(!isNote(0x00) && !isNote(0x3c) && !isNote(0x80));
  // only bit 7 marks a tie — that is all the engine tests
  assert(isSustain(0x80) && isSustain(0x88) && isSustain(0xff));
  assert(!isSustain(0x7f) && !isSustain(0x00));
  assert(isOnset(0x08) && !isOnset(0x00) && !isOnset(0x80));
});

Deno.test("a note takes its pitch from the pitch column and holds through ties", () => {
  const bytes = new Uint8Array(SONG_SIZE);
  const part2 = SONG_HEADER + 3 * MEASURE_SIZE + MEASURE_HEADER +
    2 * PART_BLOCK;
  // measure 3, part 2: onset at step 5 on instrument 0x08, pitch 0x1a,
  // held through steps 6 and 7 (the composer repeats the pitch byte).
  bytes[part2 + VOICE_OFFSET + 5] = 0x08;
  bytes[part2 + PITCH_OFFSET + 5] = 0x1a;
  bytes[part2 + VOICE_OFFSET + 6] = 0x80;
  bytes[part2 + PITCH_OFFSET + 6] = 0x1a;
  bytes[part2 + VOICE_OFFSET + 7] = 0x80;
  bytes[part2 + PITCH_OFFSET + 7] = 0x1a;
  const song = decodeSong(bytes);
  assertStrictEquals(song.measures.length, MEASURES);
  assertStrictEquals(song.measures[3].parts.length, PARTS);

  const events = song.events[2];
  assertStrictEquals(events.length, 1, "a held note is one event, not three");
  assertEquals(events[0], {
    step: 3 * STEPS_PER_MEASURE + 5,
    note: 0x1a,
    instrument: 0x08,
    len: 3,
  });
  assertStrictEquals(song.onsetCount, 1);
  assertStrictEquals(song.noteCount, 3); // three sounding steps
  assertStrictEquals(song.empty, false);
  assert(decodeSong(new Uint8Array(SONG_SIZE)).empty);
});

Deno.test("a voice byte with no pitch beside it sounds nothing", () => {
  const bytes = new Uint8Array(SONG_SIZE);
  const part0 = SONG_HEADER + MEASURE_HEADER;
  bytes[part0 + VOICE_OFFSET + 2] = 0x10; // instrument, but pitch column empty
  assertStrictEquals(decodeSong(bytes).events[0].length, 0);
});

Deno.test({
  name: "ramsie's BGM bank decodes with the expected number of live songs",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const save = bup.parse(data).find((s) => s.payload);
    const decoded = decodeSave(save.payload.buffer);
    assertStrictEquals(decoded.confidence.songs, "confirmed");
    assertStrictEquals(decoded.songs.length, SONG_SLOTS);
    assertStrictEquals(decoded.songCount, 14);
    assert(decoded.regions[6].decoded);
    // the first slot is a real arrangement: notes spread over several parts
    const first = decoded.songs[0];
    assert(first.noteCount > 100);
    assert(
      first.events.filter((e) => e.length).length >= 3,
      "a real song uses multiple parts",
    );
  },
});

Deno.test({
  name:
    "the pitch column carries the melody and the voice column the instrument",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const d = decodeSave(bup.parse(data).find((s) => s.payload).payload.buffer);
    // Ramsie's stage-0 main song. The engine reading is falsifiable here:
    // a part draws on a handful of instruments but many pitches, and every
    // sounding note lands in the pitch column's range.
    const song = d.songs[4];
    for (const events of song.events) {
      if (events.length < 20) continue;
      const instruments = new Set(events.map((e) => e.instrument));
      const pitches = new Set(events.map((e) => e.note));
      assert(
        instruments.size <= 4,
        `part uses few instruments (${instruments.size})`,
      );
      assert(pitches.size > instruments.size, "but many pitches");
      for (const e of events) assert(isNote(e.note));
    }
    // Held notes exist and are single events, not one per step.
    const held = song.events.flat().filter((e) => e.len > 1);
    assert(held.length > 20, "a real song holds notes across steps");
    assert(song.onsetCount < song.noteCount, "sounding steps outnumber onsets");
  },
});

Deno.test("every measure of every song slot stays inside the slot", () => {
  const sec6 = new Uint8Array(SECTION_SIZES[6]);
  const { songs } = decodeSongs(sec6);
  assertStrictEquals(songs.length, SONG_SLOTS);
  assert(songs.every((s) => s.measures.length === MEASURES));
  assert(songs.every((s) => s.empty));
});

Deno.test({
  name: "each song carries the header's tempo index, step seconds and echo",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const d = decodeSave(bup.parse(data).find((s) => s.payload).payload.buffer);
    const live = d.songs.filter((s) => s.noteCount);
    assert(live.length > 5);
    for (const song of live) {
      assert(
        song.tempoIndex >= 0 && song.tempoIndex <= 31,
        `song ${song.slot} tempoIndex ${song.tempoIndex} in range`,
      );
      assertStrictEquals(song.tempoIndex, song.header[3] & 31);
      assertStrictEquals(song.stepSeconds, TEMPO_TABLE[song.tempoIndex] / 240);
      assertStrictEquals(song.echoLevel, song.header[2] & 7);
    }
    // ramsie uses several different tempos, so the field is not constant
    assert(new Set(live.map((s) => s.tempoIndex)).size > 1);
    // the kernel divisor table is monotonic: higher index = faster song
    for (let i = 1; i < TEMPO_TABLE.length; i++) {
      assert(TEMPO_TABLE[i] < TEMPO_TABLE[i - 1]);
    }
  },
});

Deno.test("per-measure control byte 3 is the accompaniment's semitone transpose", () => {
  const bytes = new Uint8Array(SONG_SIZE);
  bytes[SONG_HEADER + 2 * MEASURE_SIZE + 3] = 5; // table entry 5 = +2
  // an onset in measure 2 whose pitch must NOT be shifted: the engine
  // transposes only the accompaniment channels, never the composed parts
  const part0 = SONG_HEADER + 2 * MEASURE_SIZE + MEASURE_HEADER;
  bytes[part0 + VOICE_OFFSET] = 0x08;
  bytes[part0 + PITCH_OFFSET] = 0x1a;
  const song = decodeSong(bytes);
  assertStrictEquals(song.measures[2].transpose, 2);
  assertStrictEquals(song.measures[0].transpose, -3); // ctrl3=0 -> -3
  assertStrictEquals(TRANSPOSE_TABLE[3], 0); // editor default
  assertStrictEquals(
    song.events[0][0].note,
    0x1a,
    "the melody is not transposed",
  );
});

Deno.test({
  name: "header bytes 0/1 are loop points the kernel's walker uses",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const d = decodeSave(bup.parse(data).find((s) => s.payload).payload.buffer);
    for (const song of d.songs.filter((s) => s.noteCount)) {
      assert(song.loopEnd <= 31, `song ${song.slot} loopEnd ${song.loopEnd}`);
      assert(
        song.loopStart <= song.loopEnd,
        `song ${song.slot} loop ${song.loopStart}..${song.loopEnd}`,
      );
    }
  },
});
