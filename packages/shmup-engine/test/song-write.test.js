// The song encoder, read back through the decoder it mirrors.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  decodeSong,
  readPartEvents,
  SONG_SIZE,
  TEMPO_TABLE,
} from "../src/decode/decode-song.js";
import { emptySong } from "../src/write/game-to-save.js";
import {
  bpmOfTempoIndex,
  buildDezaemonBgm,
  cellsToEvents,
  encodeDezaSong,
  foldMidiToPitch,
  midiToPitch,
  pitchToMidi,
  SONG_STEPS,
  stepSecondsOf,
  tempoIndexForBpm,
  tempoIndexForStepSeconds,
} from "../src/audio/song-write.js";

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

Deno.test("a song with no events is the writer's empty slot but for the header", () => {
  const bytes = encodeDezaSong({
    tempoIndex: 15,
    echo: 3,
    loopStart: 0,
    loopEnd: 31,
  });
  const empty = emptySong();
  assertEquals(bytes.length, SONG_SIZE);
  assertEquals(bytes, empty);
  const song = decodeSong(bytes);
  assert(song.empty);
  assertEquals(song.tempoIndex, 15);
});

Deno.test("the header lands where decodeSong reads it", () => {
  const song = decodeSong(
    encodeDezaSong({ tempoIndex: 18, echo: 5, loopStart: 4, loopEnd: 20 }),
  );
  assertEquals(
    [song.tempoIndex, song.echoLevel, song.loopStart, song.loopEnd],
    [18, 5, 4, 20],
  );
  assertEquals(song.stepSeconds, TEMPO_TABLE[18] / 240);
  assertEquals(
    song.measures[0].transpose,
    0,
    "control byte 3 = 3 = no transpose",
  );
  for (const m of song.measures) {
    assertEquals(Array.from(m.control), [0, 0, 0x80, 3]);
  }
});

Deno.test("events round-trip through readPartEvents, instrument and length intact", () => {
  const parts = [
    [{ step: 0, note: 25, instrument: 16, len: 4 }, {
      step: 4,
      note: 32,
      instrument: 16,
      len: 2,
    }, {
      step: 511,
      note: 1,
      instrument: 0,
      len: 1,
    }],
    [{ step: 16, note: 13, instrument: 18, len: 32 }],
    [],
    [{ step: 3, note: 59, instrument: 48, len: 1 }, {
      step: 5,
      note: 10,
      instrument: 20,
      len: 1,
    }],
  ];
  const bytes = encodeDezaSong({ tempoIndex: 18, parts });
  for (let p = 0; p < 4; p++) {
    assertEquals(readPartEvents(bytes, p), parts[p], `part ${p}`);
  }
  const song = decodeSong(bytes);
  assertEquals(song.onsetCount, 6);
  // 4+2+1 + 32 + 0 + 1+1 sounding steps: ties repeat the pitch byte
  assertEquals(song.noteCount, 7 + 32 + 2);
});

Deno.test("a tie repeats the pitch byte beside it and carries 0x80 in the voice column", () => {
  const bytes = encodeDezaSong({
    parts: [[{ step: 14, note: 30, instrument: 9, len: 4 }]],
  });
  // measure 0, part 0: voice at 4+4+0..15, pitch at 4+4+16..31
  assertEquals(bytes[8 + 14], 9);
  assertEquals(bytes[8 + 16 + 14], 30);
  assertEquals(bytes[8 + 15], 0x80);
  assertEquals(bytes[8 + 16 + 15], 30);
  // measure 1 steps 0,1 continue the tie across the measure boundary
  const m1 = 4 + 132 + 4;
  assertEquals([bytes[m1], bytes[m1 + 16], bytes[m1 + 1], bytes[m1 + 17]], [
    0x80,
    30,
    0x80,
    30,
  ]);
  assertEquals([bytes[m1 + 2], bytes[m1 + 18]], [0, 0], "step 18 is a rest");
});

Deno.test("a note stops where the next one starts, so touching notes need no rests", () => {
  const parts = [[{ step: 0, note: 20, instrument: 1, len: 16 }, {
    step: 4,
    note: 22,
    instrument: 1,
    len: 16,
  }]];
  const events = readPartEvents(encodeDezaSong({ parts }), 0);
  assertEquals(events, [
    { step: 0, note: 20, instrument: 1, len: 4 },
    { step: 4, note: 22, instrument: 1, len: 16 },
  ]);
});

Deno.test("events come in any order, and `pitch`/`inst` are accepted", () => {
  const a = encodeDezaSong({
    parts: [[{ step: 8, pitch: 3, inst: 2 }, {
      step: 0,
      pitch: 5,
      inst: 2,
      len: 2,
    }]],
  });
  const b = encodeDezaSong({
    parts: [[{ step: 0, note: 5, instrument: 2, len: 2 }, {
      step: 8,
      note: 3,
      instrument: 2,
      len: 1,
    }]],
  });
  assertEquals(a, b);
});

Deno.test("out-of-range input is refused, not clamped", () => {
  assertThrows(
    () => encodeDezaSong({ tempoIndex: 32 }),
    RangeError,
    "tempoIndex",
  );
  assertThrows(() => encodeDezaSong({ echo: 8 }), RangeError, "echo");
  assertThrows(
    () => encodeDezaSong({ loopStart: 5, loopEnd: 4 }),
    RangeError,
    "loopEnd",
  );
  assertThrows(
    () => encodeDezaSong({ parts: [[{ step: 512, note: 1 }]] }),
    RangeError,
    "step",
  );
  assertThrows(
    () => encodeDezaSong({ parts: [[{ step: 0, note: 60 }]] }),
    RangeError,
    "note",
  );
  assertThrows(
    () => encodeDezaSong({ parts: [[{ step: 0, note: 0 }]] }),
    RangeError,
    "note",
  );
  assertThrows(
    () => encodeDezaSong({ parts: [[{ step: 0, note: 1, instrument: 128 }]] }),
    RangeError,
    "instrument",
  );
  assertThrows(
    () =>
      encodeDezaSong({ parts: [[{ step: 0, note: 1 }, { step: 0, note: 2 }]] }),
    RangeError,
    "two events",
  );
  assertThrows(
    () => encodeDezaSong({ parts: [[], [], [], [], []] }),
    RangeError,
    "parts",
  );
});

Deno.test("pitch bytes are MIDI minus 35; folding brings outliers in by octaves", () => {
  assertEquals(midiToPitch(60), 25, "middle C");
  assertEquals(midiToPitch(69), 34, "A4 = scale 88 = 440 Hz");
  assertEquals(pitchToMidi(25), 60);
  assertEquals(midiToPitch(36), 1);
  assertEquals(midiToPitch(94), 59);
  assertEquals(midiToPitch(35), null);
  assertEquals(midiToPitch(95), null);
  assertEquals(foldMidiToPitch(24), 1, "C1 → C2");
  assertEquals(foldMidiToPitch(108), 49, "C8 → C6");
  assertEquals(foldMidiToPitch(95), 48, "B6 → B5");
  assertEquals(foldMidiToPitch(NaN), null);
});

Deno.test("tempo indices: nearest step, BPM both ways", () => {
  assertEquals(stepSecondsOf(0), 66 / 240);
  assertEquals(stepSecondsOf(31), 18 / 240);
  assertEquals(tempoIndexForStepSeconds(31 / 240), 18);
  assertEquals(tempoIndexForBpm(114.7), 18, "divisor 31.4 → 31");
  assertEquals(tempoIndexForBpm(86), 9, "divisor 41.9 → 42");
  assertEquals(tempoIndexForBpm(80), 7, "divisor 45 exactly");
  assertEquals(tempoIndexForBpm(20), 0, "pinned slow");
  assertEquals(tempoIndexForBpm(400), 31, "pinned fast");
  assert(Math.abs(bpmOfTempoIndex(18) - 116.13) < 0.01);
});

Deno.test("cellsToEvents turns per-step cells into onsets and ties", () => {
  const cells = new Array(SONG_STEPS).fill(null);
  cells[0] = { note: 25, instrument: 16 };
  cells[1] = { note: 25, instrument: 16, tie: true };
  cells[2] = { note: 25, instrument: 16, tie: true };
  cells[3] = { note: 25, instrument: 16 }; // re-struck
  cells[5] = { note: 30, instrument: 16, tie: true }; // a tie after a rest is an onset
  cells[511] = { pitch: 1, inst: 3 };
  assertEquals(cellsToEvents(cells), [
    { step: 0, note: 25, instrument: 16, len: 3 },
    { step: 3, note: 25, instrument: 16, len: 1 },
    { step: 5, note: 30, instrument: 16, len: 1 },
    { step: 511, note: 1, instrument: 3, len: 1 },
  ]);
});

Deno.test("buildDezaemonBgm lays slots out for the cart and the web runtime", () => {
  const slots = [];
  for (let i = 0; i < 6; i++) {
    slots.push(
      encodeDezaSong({
        tempoIndex: 10 + i,
        parts: [[{ step: 0, note: 1 + i, instrument: 1 }]],
      }),
    );
  }
  const bgm = buildDezaemonBgm({ songs: slots });
  assertEquals(bgm.sfxSet, 1);
  assertEquals(bgm.stages, [[0, 1], [2, 3], [4, 5]]);
  assertEquals(
    bgm.special,
    [0, 6, 6, 5],
    "title first, game over / clear an unused slot, ending last",
  );
  assertEquals(bgm.sequence, [0, 1, 2, 3, 4, 5]);
  assertEquals(Object.keys(bgm.songs), ["0", "1", "2", "3", "4", "5"]);
  for (let i = 0; i < 6; i++) {
    const bytes = b64ToBytes(bgm.songs[String(i)]);
    assertEquals(bytes, slots[i]);
    assertEquals(bgm.tempos[String(i)], TEMPO_TABLE[10 + i] / 240);
    assertEquals(decodeSong(bytes).events[0][0].note, 1 + i);
  }
});

Deno.test("buildDezaemonBgm: more slots than stages, explicit tables, and the limits", () => {
  const slot = encodeDezaSong({});
  const twenty = new Array(20).fill(slot);
  const bgm = buildDezaemonBgm({ songs: twenty, stageCount: 5 });
  assertEquals(
    bgm.stages,
    [[0, 1], [4, 5], [8, 9], [12, 13], [16, 17]],
    "five stages walk twenty slots",
  );
  assertEquals(
    buildDezaemonBgm({ songs: twenty.slice(0, 3), stageCount: 5 }).stages,
    [[0, 1], [0, 1], [1, 2], [1, 2], [2, 2]],
  );
  assertEquals(bgm.special, [0, 20, 20, 19]);
  assertEquals(bgm.sequence.length, 20);

  const custom = buildDezaemonBgm({
    songs: twenty,
    stages: [[0, 4], [8, 12], [16, 19]],
    special: [1, 2, 3, 4],
    sfxSet: 3,
    sequence: false,
  });
  assertEquals(custom.stages, [[0, 4], [8, 12], [16, 19]]);
  assertEquals(custom.special, [1, 2, 3, 4]);
  assertEquals(custom.sfxSet, 3);
  assertEquals("sequence" in custom, false);

  const full = buildDezaemonBgm({ songs: new Array(24).fill(slot) });
  assertEquals(
    full.special,
    [0, 23, 23, 23],
    "a full bank has no silent slot to point at",
  );
  assertEquals(full.stages.length, 10, "the table holds ten stage pairs");

  assertThrows(() => buildDezaemonBgm({ songs: [] }), RangeError, "no songs");
  assertThrows(
    () => buildDezaemonBgm({ songs: new Array(25).fill(slot) }),
    RangeError,
    "25 songs",
  );
  assertThrows(
    () => buildDezaemonBgm({ songs: [new Uint8Array(10)] }),
    RangeError,
    "4228",
  );
  assertThrows(
    () => buildDezaemonBgm({ songs: [slot], stages: [[0, 24]] }),
    RangeError,
    "stages[0][1]",
  );
  assertThrows(
    () => buildDezaemonBgm({ songs: [slot], sfxSet: 0 }),
    RangeError,
    "sfxSet",
  );
  assertThrows(
    () => buildDezaemonBgm({ songs: [slot, slot], sequence: [1, 5] }),
    RangeError,
    "sequence[1] names slot 5",
  );
});
