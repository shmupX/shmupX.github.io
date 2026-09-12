// Dezaemon 2 BGM decoder — sec6 is the 音まろ music editor's 24 song slots.
//
// Layout (proven against the disc's 73 M_DATA*.BIN preset songs, which are
// byte-identical to the song slots of games that use them, and against the
// kernel's own song pointer arithmetic songIndex * 0x1084 + sec6base):
//
//   song  = 4-byte header + 32 measures of 132 bytes             = 4228
//   measure = 4 control bytes + 4 parts x 32 bytes               = 132
//
// The 32-measure / 4-part grid is exactly the editor's documented model.
// Measure boundaries are visible in the raw data: in an otherwise empty
// measure the control bytes remain non-zero, leaving 2-byte islands spaced
// exactly 132 bytes apart. The control default is `00 00 80 03` (1254 of
// 2336 preset measures).
//
// A measure is SIXTEEN time steps, and a part's 32 bytes are TWO COLUMNS of
// those 16 steps, not 32 successive steps. The kernel's walker (0KERNEL
// +0x1bfc) advances a 0..15 cursor and reads, per part, byte [cursor] and
// byte [cursor + 16]; its note sender (+0x15bc) shows what each column is:
//
//   bytes 16-31 = PITCH column, and IT ALONE decides whether a step sounds.
//                 The sender tests this byte: non-zero -> gate 1, key on, and
//                 the value goes to the per-part note register 0x601F418
//                 (+0x36, a constant bank offset); zero -> gate 0x40, key off.
//   bytes 0-15  = VOICE column, which selects an INSTRUMENT and nothing else.
//                 Bit 7 set = tie (gate 0x10, the pitch register untouched),
//                 and the rest of the byte lands on the companion channel
//                 bank 4-7 as command 4. Byte 0 is INSTRUMENT 0, a real
//                 tone-bank voice — it is not a rest.
//
// Order matters, and it is the sender's: the tie bit is tested first
// (0x06005696), then the pitch byte's zero-ness picks gate 1 or gate 0x40
// (0x060056a2). This file read the gate off the VOICE column until
// 2026-09-12, which is not a subtle difference — over the 258-save corpus it
// dropped 72,282 sounding steps and rendered 25 songs completely silent,
// because a part whose composer left the instrument column at 0 throughout
// is perfectly ordinary. `game.bundle.js` always read the pitch column, so
// the editor's preview was the one that disagreed with the hardware.
//
// What the save data DOES show is that the two columns are not two melodies:
// across Ramsie's 14 songs a tie is accompanied by a pitch byte 6427/6427
// times and that pitch is the identical value 6401/6427 times, the voice
// column carries only a handful of distinct values per song, and the pitch
// column lands on a diatonic scale with five near-empty pitch classes.
//
// Environment-neutral ESM (Node + browser).

export const SONG_SIZE = 4228;
export const SONG_SLOTS = 24;
export const SONG_HEADER = 4;
export const MEASURES = 32;
export const MEASURE_SIZE = 132;
export const MEASURE_HEADER = 4;
export const PARTS = 4;
export const STEPS_PER_MEASURE = 16;
export const PART_BLOCK = 32;              // voice column + pitch column
export const VOICE_OFFSET = 0;
export const PITCH_OFFSET = 16;

export const STEP_EMPTY = 0x00;
export const NOTE_MIN = 0x01;
export const NOTE_MAX = 0x3b;

// A pitch-column byte that sounds. The ENGINE only tests non-zero; the upper
// bound is ours. 0x3b is the top of the editor's keyboard, and the 951 bytes
// above it in the whole corpus (83, 127 and a tail of 231-255) all sit in
// 0xFF-filled garbage measures, so clamping keeps those from shrieking.
export function isNote(step) {
    return step >= NOTE_MIN && step <= NOTE_MAX;
}

// A voice-column byte that holds the note already sounding. Only bit 7 is
// tested by the engine, and in practice only 0x80 ever appears: across every
// non-empty song in the 258-save corpus the bit-7 voice values are 0x80
// (2,357,850) and 0xFF (732), every 0xFF sitting inside a measure whose
// control bytes are 0xFF garbage. The 0x80-0x88 range this file used to
// claim does not occur.
export function isSustain(step) {
    return (step & 0x80) !== 0;
}

// A voice-column byte that carries an instrument rather than a tie. It does
// NOT decide whether the step sounds — the pitch column does that — so this
// is only useful for reading the instrument stream on its own.
export function isInstrument(step) {
    return (step & 0x80) === 0;
}

// One part's 16 steps of a measure -> [{step, note, instrument, len}].
// `len` runs on through following measures' ties, so callers get whole notes.
export function readPartEvents(bytes, part) {
    const events = [];
    let current = null;
    for (let m = 0; m < MEASURES; m++) {
        const base = SONG_HEADER + m * MEASURE_SIZE + MEASURE_HEADER + part * PART_BLOCK;
        for (let st = 0; st < STEPS_PER_MEASURE; st++) {
            const voice = bytes[base + VOICE_OFFSET + st];
            const pitch = bytes[base + PITCH_OFFSET + st];
            const at = m * STEPS_PER_MEASURE + st;
            // The sender's own order: tie first, then the PITCH column
            // alone decides key-on against key-off. A zero VOICE byte is
            // instrument 0, not a rest.
            if (isSustain(voice)) {
                if (current) current.len = at - current.step + 1;
            } else if (isNote(pitch)) {
                current = { step: at, note: pitch, instrument: voice, len: 1 };
                events.push(current);
            } else {
                current = null;
            }
        }
    }
    return events;
}

// The 4-byte song header, traced through the kernel's own sequencer
// (0KERNEL.BIN +0x1bfc walker, +0x1db8 tick, +0x1498 per-measure dispatch):
//   +0  loop-START measure (on reaching the end, playback rewinds here)
//   +1  loop-END measure   (the walker compares its cursor against +1, +1)
//   +2  ECHO send 0-7      (sent as driver command 0x88 whenever it changes:
//       (echo << 5) | 0x1F lands in SCSP slot 16/17 register +0x17 —
//       EFSDL|EFPAN, the effect/reverb send of the BGM output pair)
//   +3  TEMPO index 0-31   (indexes the kernel divisor table at 0x601F3A8;
//       the frame tick adds 4 to an accumulator and fires one step when it
//       reaches the divisor, so stepSeconds = divisor / 240 at 60 Hz)
export const SONG_LOOP_START_OFFSET = 0;
export const SONG_LOOP_END_OFFSET = 1;
export const SONG_ECHO_OFFSET = 2;
export const SONG_TEMPO_OFFSET = 3;

// The kernel's tempo divisor table (0KERNEL.BIN file +0x1B3A8, loaded flat
// at 0x601F3A8). stepsPerSecond = 240 / divisor; a 4-step beat makes the
// editor's 32 tempo positions run 54.5 - 200 BPM.
export const TEMPO_TABLE = [
    0x42, 0x3c, 0x39, 0x36, 0x34, 0x31, 0x2f, 0x2d,
    0x2b, 0x2a, 0x28, 0x27, 0x26, 0x24, 0x23, 0x22,
    0x21, 0x20, 0x1f, 0x1e, 0x1d, 0x1c, 0x1b, 0x1a,
    0x19, 0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12,
];

// Per-measure transpose in semitones (measure control byte 3 indexes the
// signed table at 0x601F3C8). It applies to the AUTO-ACCOMPANIMENT only:
// the sender adds it at +0x16fc to the seven pattern channels the measure
// selects out of the kernel table at 0x601F490 (row = ctrl0, ctrl1 and
// ctrl2 pick the pattern), never to the four composed parts. The editor
// default control `00 00 80 03` selects entry 3 = no transpose.
export const TRANSPOSE_TABLE = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, -5, -4];

export function songStepSeconds(tempoIndex) {
    return TEMPO_TABLE[tempoIndex & 31] / 240;
}

// Decode one 4228-byte song image.
export function decodeSong(bytes, slot = 0) {
    if (bytes.length < SONG_SIZE) throw new Error(`song too small: ${bytes.length}`);
    const measures = [];
    let soundingSteps = 0;
    for (let m = 0; m < MEASURES; m++) {
        const base = SONG_HEADER + m * MEASURE_SIZE;
        const parts = [];
        for (let p = 0; p < PARTS; p++) {
            const at = base + MEASURE_HEADER + p * PART_BLOCK;
            // 32 bytes: the voice column (0-15) then the pitch column (16-31)
            const steps = bytes.subarray(at, at + PART_BLOCK);
            for (let st = 0; st < STEPS_PER_MEASURE; st++) {
                // A step sounds when its PITCH byte is non-zero, whatever
                // the voice column says (see readPartEvents).
                if (steps[PITCH_OFFSET + st] !== STEP_EMPTY) soundingSteps++;
            }
            parts.push(steps);
        }
        const control = bytes.subarray(base, base + MEASURE_HEADER);
        measures.push({
            index: m,
            control,
            // accompaniment transpose — see TRANSPOSE_TABLE
            transpose: TRANSPOSE_TABLE[control[3]] || 0,
            parts,
        });
    }
    const events = [];
    for (let p = 0; p < PARTS; p++) events.push(readPartEvents(bytes, p));
    const tempoIndex = bytes[SONG_TEMPO_OFFSET] & 31;
    return {
        slot,
        header: bytes.subarray(0, SONG_HEADER),
        tempoIndex,
        stepSeconds: songStepSeconds(tempoIndex),
        echoLevel: bytes[SONG_ECHO_OFFSET] & 7,
        loopStart: bytes[SONG_LOOP_START_OFFSET],
        loopEnd: bytes[SONG_LOOP_END_OFFSET],
        measures,
        events,
        noteCount: soundingSteps,
        onsetCount: events.reduce((n, e) => n + e.length, 0),
        empty: soundingSteps === 0,
    };
}

// sec6 -> the game's 24 song slots.
export function decodeSongs(sec6) {
    const songs = [];
    for (let i = 0; i < SONG_SLOTS; i++) {
        songs.push(decodeSong(sec6.subarray(i * SONG_SIZE, (i + 1) * SONG_SIZE), i));
    }
    return { songs, usedCount: songs.filter((s) => !s.empty).length };
}
