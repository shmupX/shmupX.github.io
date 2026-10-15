// Writing 音まろ songs: note events in, a 4228-byte sec6 slot out.
//
// The inverse of decode/decode-song.js, byte for byte. A song is a 4-byte
// header and 32 measures of 132 bytes; a measure is 4 control bytes and 4
// parts of 32 — the VOICE column (16 bytes) then the PITCH column (16 bytes).
// Only the PITCH byte decides whether a step sounds (0 = rest, 1..59 = key-on,
// MIDI = byte + 35); the VOICE byte carries the instrument in bits 0-6 and the
// TIE in bit 7. A tie repeats the pitch byte beside it, as every song in the
// corpus does (decode-song.js:40-42), so a decoder that reads pitch alone
// still sees the held note.
//
// The control bytes are always the editor default `00 00 80 03`: rows 0-6 of
// the kernel's accompaniment table are silent, so a song written here plays
// its four composed parts and nothing it did not say. Anything else would
// add the kernel's own chords under a transcription.
//
// This is what a converter that has decided WHAT to play (bgm-transcribe)
// calls to say it in the cart's words; it decides nothing musical itself.

import {
    MEASURE_HEADER,
    MEASURE_SIZE,
    MEASURES,
    NOTE_MAX,
    NOTE_MIN,
    PART_BLOCK,
    PARTS,
    PITCH_OFFSET,
    SONG_ECHO_OFFSET,
    SONG_HEADER,
    SONG_LOOP_END_OFFSET,
    SONG_LOOP_START_OFFSET,
    SONG_SIZE,
    SONG_SLOTS,
    SONG_TEMPO_OFFSET,
    STEPS_PER_MEASURE,
    TEMPO_TABLE,
    VOICE_OFFSET,
} from "../decode/decode-song.js";

/** Sixteenth steps in one slot: 32 measures of 16. */
export const SONG_STEPS = MEASURES * STEPS_PER_MEASURE;
/** The editor default; silent accompaniment, no transpose. */
export const CONTROL_DEFAULT = Object.freeze([0x00, 0x00, 0x80, 0x03]);
/** MIDI note number = pitch byte + this; pitch 25 is C4 (middle C), 34 is A4 (scale 34 + 54 = 88 = 440 Hz in the runtime). */
export const PITCH_TO_MIDI = 35;
export const MIDI_MIN = NOTE_MIN + PITCH_TO_MIDI; // 36 = C2
export const MIDI_MAX = NOTE_MAX + PITCH_TO_MIDI; // 94 = Bb6
/** Voice bits 0-6 address 128 instruments; the bank defines 116 (0-115). */
export const INSTRUMENT_MAX = 127;
export const TIE = 0x80;

/** The pitch byte for a MIDI note, or null outside C2..Bb6. */
export function midiToPitch(midi) {
    const m = Math.round(midi);
    if (m < MIDI_MIN || m > MIDI_MAX) return null;
    return m - PITCH_TO_MIDI;
}

/** The pitch byte for a MIDI note, octave-shifted into C2..Bb6 when it is outside. */
export function foldMidiToPitch(midi) {
    let m = Math.round(midi);
    if (!Number.isFinite(m)) return null;
    while (m < MIDI_MIN) m += 12;
    while (m > MIDI_MAX) m -= 12;
    return m - PITCH_TO_MIDI;
}

export function pitchToMidi(pitch) {
    return pitch + PITCH_TO_MIDI;
}

/** How long a sixteenth step lasts at a tempo index (kernel divisor / 240). */
export function stepSecondsOf(tempoIndex) {
    return TEMPO_TABLE[tempoIndex & 31] / 240;
}

/**
 * The tempo index whose step is nearest `stepSeconds`. The table runs
 * 0.275 s (index 0, 54.5 BPM) down to 0.075 s (index 31, 200 BPM) — a
 * step outside that is pinned to the nearer end.
 */
export function tempoIndexForStepSeconds(stepSeconds) {
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < TEMPO_TABLE.length; i++) {
        const err = Math.abs(Math.log(stepSecondsOf(i) / stepSeconds));
        if (err < bestErr) {
            bestErr = err;
            best = i;
        }
    }
    return best;
}

/** The tempo index nearest a quarter-note BPM (four sixteenths to the beat). */
export function tempoIndexForBpm(bpm) {
    return tempoIndexForStepSeconds(60 / bpm / 4);
}

/** Quarter-note BPM of a tempo index. */
export function bpmOfTempoIndex(tempoIndex) {
    return 60 / (stepSecondsOf(tempoIndex) * 4);
}

function fail(what) {
    throw new RangeError(`song-write: ${what}`);
}

function checkInt(v, lo, hi, what) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
        fail(`${what} must be an integer ${lo}..${hi}, got ${v}`);
    }
    return v;
}

/**
 * Where a part's step lives: [voice byte offset, pitch byte offset].
 */
function stepOffsets(part, step) {
    const m = Math.floor(step / STEPS_PER_MEASURE);
    const st = step % STEPS_PER_MEASURE;
    const base = SONG_HEADER + m * MEASURE_SIZE + MEASURE_HEADER + part * PART_BLOCK;
    return [base + VOICE_OFFSET + st, base + PITCH_OFFSET + st];
}

/**
 * One slot's bytes.
 *
 *   song.tempoIndex  0..31 (see TEMPO_TABLE / tempoIndexForBpm); default 15
 *   song.echo        0..7 reverb send; default 3
 *   song.loopStart   first measure of the loop, 0..31; default 0
 *   song.loopEnd     last measure of the loop (inclusive), 0..31; default 31
 *   song.parts       up to 4 arrays of events {step 0..511, note 1..59,
 *                    instrument 0..127, len ≥ 1}; `pitch` is accepted for
 *                    `note`, `inst` for `instrument`. A missing or empty part
 *                    is silent.
 *
 * Events in a part are written in step order. A note runs `len` steps —
 * onset then ties — and stops early where the next event starts, so a
 * sequence of touching notes needs no rests between them. Two events on one
 * step is an error: a part is monophonic.
 */
export function encodeDezaSong(song = {}) {
    const bytes = new Uint8Array(SONG_SIZE);
    const tempoIndex = checkInt(song.tempoIndex ?? 15, 0, 31, "tempoIndex");
    const echo = checkInt(song.echo ?? 3, 0, 7, "echo");
    const loopStart = checkInt(song.loopStart ?? 0, 0, MEASURES - 1, "loopStart");
    const loopEnd = checkInt(song.loopEnd ?? MEASURES - 1, 0, MEASURES - 1, "loopEnd");
    if (loopEnd < loopStart) fail(`loopEnd ${loopEnd} is before loopStart ${loopStart}`);
    bytes[SONG_LOOP_START_OFFSET] = loopStart;
    bytes[SONG_LOOP_END_OFFSET] = loopEnd;
    bytes[SONG_ECHO_OFFSET] = echo;
    bytes[SONG_TEMPO_OFFSET] = tempoIndex;
    for (let m = 0; m < MEASURES; m++) {
        bytes.set(CONTROL_DEFAULT, SONG_HEADER + m * MEASURE_SIZE);
    }

    const parts = Array.isArray(song.parts) ? song.parts : [];
    if (parts.length > PARTS) fail(`${parts.length} parts; a song has ${PARTS}`);
    for (let p = 0; p < parts.length; p++) {
        const events = parts[p] || [];
        if (!Array.isArray(events)) fail(`part ${p} is not an array of events`);
        const sorted = events.slice().sort((a, b) => a.step - b.step);
        for (let i = 0; i < sorted.length; i++) {
            const e = sorted[i];
            const step = checkInt(e.step, 0, SONG_STEPS - 1, `part ${p} event ${i} step`);
            const note = checkInt(e.note ?? e.pitch, NOTE_MIN, NOTE_MAX, `part ${p} step ${step} note`);
            const instrument = checkInt(
                e.instrument ?? e.inst ?? 0,
                0,
                INSTRUMENT_MAX,
                `part ${p} step ${step} instrument`,
            );
            const len = checkInt(e.len ?? 1, 1, SONG_STEPS, `part ${p} step ${step} len`);
            if (i > 0 && sorted[i - 1].step === step) {
                fail(`part ${p} has two events on step ${step}`);
            }
            const next = i + 1 < sorted.length ? sorted[i + 1].step : SONG_STEPS;
            const end = Math.min(step + len, next, SONG_STEPS);
            const [v0, p0] = stepOffsets(p, step);
            bytes[v0] = instrument;
            bytes[p0] = note;
            for (let s = step + 1; s < end; s++) {
                const [v, q] = stepOffsets(p, s);
                bytes[v] = TIE;
                bytes[q] = note;
            }
        }
    }
    return bytes;
}

/**
 * Per-step cells to events: `cells[step]` is null for a rest, or
 * `{note, instrument, tie}` — `tie` true continues the previous cell's note
 * (its note is taken from that cell). Adjacent cells of the same note
 * without `tie` are re-struck. Handy for a transcriber that decides step by
 * step; encodeDezaSong takes the result.
 */
export function cellsToEvents(cells) {
    const events = [];
    let current = null;
    for (let step = 0; step < cells.length && step < SONG_STEPS; step++) {
        const c = cells[step];
        if (!c) {
            current = null;
            continue;
        }
        if (c.tie && current) {
            current.len = step - current.step + 1;
            continue;
        }
        current = {
            step,
            note: c.note ?? c.pitch,
            instrument: c.instrument ?? c.inst ?? 0,
            len: 1,
        };
        events.push(current);
    }
    return events;
}

function bytesToB64(bytes) {
    if (typeof btoa === "function") {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(s);
    }
    // deno-lint-ignore no-undef
    return Buffer.from(bytes).toString("base64");
}

/**
 * The level record's `dezaemonBgm`, out of encoded slots.
 *
 *   songs      Uint8Array slots (4228 bytes each) in playing order, at most 24
 *   stages     [[main, boss], …] slot pairs per stage; default: the stages
 *              are spread evenly along the sequence — stage r of S plays
 *              songs[floor(r·n/S)] through its waves and the slot after it
 *              against its boss — so a cart whose kernel restarts a slot at
 *              every stage still walks the whole piece over a game. With
 *              2S slots that is simply pairs in order.
 *   stageCount S for that default; default ceil(n/2), at most 10
 *   special    [title, gameover, clear, ending] slots; default: the first song
 *              for the title, the last for the ending, and for game over and
 *              stage clear an unused slot — silent on the cart, and in the web
 *              runtime a missing slot falls back to the game's own music
 *   sfxSet     1..3 (real / comic / sf), default 1
 *   sequence   true (default) writes `sequence`: the slots in order, which the
 *              web runtime plays end to end as one piece that pauses at a
 *              stage clear and resumes where it left off (the cart restarts
 *              its slot on every stage, as the kernel does)
 *   tempos     informational per-slot stepSeconds, written as the mapper does
 *
 * Returns `{ sfxSet, special, stages, songs: {slot: base64}, tempos, sequence }`.
 */
export function buildDezaemonBgm(options = {}) {
    const slots = (options.songs || []).map((s, i) => {
        if (!(s instanceof Uint8Array) || s.length !== SONG_SIZE) {
            fail(`songs[${i}] is not a ${SONG_SIZE}-byte slot`);
        }
        return s;
    });
    if (!slots.length) fail("no songs");
    if (slots.length > SONG_SLOTS) fail(`${slots.length} songs; a bank holds ${SONG_SLOTS}`);
    const n = slots.length;
    const last = n - 1;
    // The first slot the bank does not use, or the last slot of the bank —
    // a full bank has nowhere silent to point, so the ending's slot stands in.
    const silent = n < SONG_SLOTS ? n : last;

    const songs = {};
    const tempos = {};
    slots.forEach((s, i) => {
        songs[String(i)] = bytesToB64(s);
        tempos[String(i)] = stepSecondsOf(s[SONG_TEMPO_OFFSET]);
    });

    let stages = options.stages;
    if (!Array.isArray(stages)) {
        const stageCount = Math.max(1, Math.min(10, options.stageCount || Math.ceil(n / 2)));
        stages = [];
        for (let r = 0; r < stageCount; r++) {
            const main = Math.min(Math.floor((r * n) / stageCount), last);
            stages.push([main, Math.min(main + 1, last)]);
        }
    }
    stages.forEach((pair, r) => {
        if (!Array.isArray(pair) || pair.length !== 2) fail(`stages[${r}] is not a [main, boss] pair`);
        pair.forEach((slot, k) => checkInt(slot, 0, SONG_SLOTS - 1, `stages[${r}][${k}]`));
    });
    if (stages.length > 10) fail(`${stages.length} stage pairs; the table holds 10`);

    const special = Array.isArray(options.special) ? options.special : [0, silent, silent, last];
    if (special.length !== 4) fail("special must be [title, gameover, clear, ending]");
    special.forEach((slot, k) => checkInt(slot, 0, SONG_SLOTS - 1, `special[${k}]`));

    const out = {
        sfxSet: checkInt(options.sfxSet ?? 1, 1, 3, "sfxSet"),
        special: special.slice(),
        stages: stages.map((p) => p.slice()),
        songs,
        tempos,
    };
    if (options.sequence !== false) {
        out.sequence = Array.isArray(options.sequence)
            ? options.sequence.map((slot, k) => {
                checkInt(slot, 0, SONG_SLOTS - 1, `sequence[${k}]`);
                if (!(String(slot) in songs)) fail(`sequence[${k}] names slot ${slot}, which songs does not carry`);
                return slot;
            })
            : slots.map((_, i) => i);
    }
    return out;
}
