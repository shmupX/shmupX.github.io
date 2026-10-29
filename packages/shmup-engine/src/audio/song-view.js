// Reading a 音まろ song slot without changing a byte of it.
//
// The music maker's document IS the 4,228 bytes (see song-edit.js): every
// view is derived from them and nothing here masks, clamps or normalises, so
// a song that is only looked at goes back to the cart exactly as it came.
//
// What the bytes are (decode-song.js has the kernel trace):
//
//   header   +0 loop-start measure, +1 loop-end measure, +2 echo 0-7,
//            +3 tempo index 0-31
//   measure  4 control bytes, then 4 parts x 32 bytes: a VOICE column of 16
//            steps (bits 0-6 instrument, bit 7 tie) and a PITCH column of the
//            same 16 steps (0 = key off, 1-59 = note)
//   control  ctrl0 accompaniment bank 0-8, ctrl1 pattern 0-3, ctrl2 bits 1-3
//            chord variant 0-4 (bits 7 and 0 are kept but not understood),
//            ctrl3 key 0-11 (TRANSPOSE_TABLE)
//
// A cart carries plenty that 音まろ's own data never shows in a preset, all
// of it kept: rest steps whose voice byte still names an instrument, ties whose
// pitch byte is not the held note ("bends"), ties with nothing sounding,
// pitch bytes above 59, control bytes far outside the pattern table and whole
// measures of 0xFF. songShape() lists them; song-corpus-census.test.js counts
// them over every cart. The definitions here and in the census are the same.
//
// Environment-neutral ESM (Node + browser).

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
    SONG_TEMPO_OFFSET,
    STEPS_PER_MEASURE,
    TEMPO_TABLE,
    TRANSPOSE_TABLE,
    VOICE_OFFSET,
} from "../decode/decode-song.js";

export const SONG_STEPS = MEASURES * STEPS_PER_MEASURE;
export const TIE = 0x80;

/** The ranges 音まろ authors in, from the census of its presets and every cart. */
export const NATIVE = Object.freeze({
    PARTS,
    MEASURES,
    STEPS: SONG_STEPS,
    INST_MAX: 59, // composed parts use instruments 0-59; 60+ are the accompaniment's and the sound effects'
    PITCH_MIN: NOTE_MIN,
    PITCH_MAX: NOTE_MAX,
    BANKS: 9, // ctrl0
    PATTERNS: 4, // ctrl1
    CHORDS: 5, // (ctrl2 & 0x7F) >> 1
    KEYS: TRANSPOSE_TABLE.length, // ctrl3
    LOOP_MAX: MEASURES - 1,
    ECHO_MAX: 7,
    TEMPO_MAX: TEMPO_TABLE.length - 1,
});

/** Byte offset of control byte k of measure m. */
export function controlOffset(m, k = 0) {
    return SONG_HEADER + m * MEASURE_SIZE + k;
}

/** [voice offset, pitch offset] of a part's step (0..511). */
export function stepOffsets(part, step) {
    const m = Math.floor(step / STEPS_PER_MEASURE);
    const st = step % STEPS_PER_MEASURE;
    const base = SONG_HEADER + m * MEASURE_SIZE + MEASURE_HEADER + part * PART_BLOCK;
    return [base + VOICE_OFFSET + st, base + PITCH_OFFSET + st];
}

function checkSong(b) {
    if (!(b instanceof Uint8Array) || b.length !== SONG_SIZE) {
        throw new TypeError(`song-view: a song is a ${SONG_SIZE}-byte Uint8Array`);
    }
}

/** Quarter-note BPM of a tempo index (four sixteenth steps to the beat). */
export function bpmOf(tempoIndex) {
    return 3600 / TEMPO_TABLE[tempoIndex & 31];
}

export function headerOf(b) {
    checkSong(b);
    const raw = [...b.subarray(0, SONG_HEADER)];
    const tempoIndex = raw[SONG_TEMPO_OFFSET];
    return {
        loopStart: raw[SONG_LOOP_START_OFFSET],
        loopEnd: raw[SONG_LOOP_END_OFFSET],
        echo: raw[SONG_ECHO_OFFSET],
        tempoIndex,
        bpm: tempoIndex <= NATIVE.TEMPO_MAX ? bpmOf(tempoIndex) : null,
        raw,
        valid: raw[SONG_LOOP_START_OFFSET] <= NATIVE.LOOP_MAX &&
            raw[SONG_LOOP_END_OFFSET] <= NATIVE.LOOP_MAX &&
            raw[SONG_LOOP_END_OFFSET] >= raw[SONG_LOOP_START_OFFSET] &&
            raw[SONG_ECHO_OFFSET] <= NATIVE.ECHO_MAX &&
            tempoIndex <= NATIVE.TEMPO_MAX,
    };
}

export function isFfMeasure(b, m) {
    const at = controlOffset(m);
    return b[at] === 0xff && b[at + 1] === 0xff && b[at + 2] === 0xff && b[at + 3] === 0xff;
}

/** One measure's accompaniment choice, read straight off its four control bytes. */
export function controlAt(b, m) {
    checkSong(b);
    const at = controlOffset(m);
    const [c0, c1, c2, c3] = b.subarray(at, at + MEASURE_HEADER);
    const chord = (c2 & 0x7f) >> 1;
    return {
        raw: [c0, c1, c2, c3],
        bank: c0,
        pattern: c1,
        chord,
        flag7: (c2 & 0x80) !== 0,
        low1: (c2 & 1) !== 0,
        key: c3,
        transpose: c3 < TRANSPOSE_TABLE.length ? TRANSPOSE_TABLE[c3] : null,
        ff: c0 === 0xff && c1 === 0xff && c2 === 0xff && c3 === 0xff,
        valid: c0 < NATIVE.BANKS && c1 < NATIVE.PATTERNS && chord < NATIVE.CHORDS &&
            c3 < NATIVE.KEYS,
    };
}

export function cellAt(b, part, step) {
    const [v, q] = stepOffsets(part, step);
    return { voice: b[v], pitch: b[q] };
}

/**
 * A part's notes, with the same boundaries the kernel and readPartEvents
 * (decode-song.js:91) give them: a tie extends whatever is sounding, a pitch
 * byte 1-59 on a non-tie step strikes a note, anything else is a rest.
 *
 *   [{ step, len, pitch, inst, bends: [{ step, pitch }] }]
 *
 * `bends` are the tie steps whose pitch byte is not the onset's pitch.
 */
export function partNotes(b, part) {
    checkSong(b);
    const notes = [];
    let current = null;
    for (let step = 0; step < SONG_STEPS; step++) {
        const [vo, po] = stepOffsets(part, step);
        const voice = b[vo];
        const pitch = b[po];
        if (voice & TIE) {
            if (current) {
                current.len = step - current.step + 1;
                if (pitch !== current.pitch) current.bends.push({ step, pitch });
            }
        } else if (pitch >= NOTE_MIN && pitch <= NOTE_MAX) {
            current = { step, len: 1, pitch, inst: voice, bends: [] };
            notes.push(current);
        } else {
            current = null;
        }
    }
    return notes;
}

/** The note sounding at a step (onset or tail), or null. */
export function noteAt(b, part, step) {
    for (const n of partNotes(b, part)) {
        if (step >= n.step && step < n.step + n.len) return n;
        if (n.step > step) break;
    }
    return null;
}

/**
 * Per-step kinds for one part: "rest", "onset", "tie", "orphan-tie",
 * "rest-voice" (a rest whose voice byte is not 0) or "pitch-range" (a
 * non-tie pitch byte above 59, which the kernel would key on but the editor's
 * keyboard cannot reach).
 */
export function partCells(b, part) {
    const kinds = new Array(SONG_STEPS);
    let sounding = false;
    for (let step = 0; step < SONG_STEPS; step++) {
        const [vo, po] = stepOffsets(part, step);
        const voice = b[vo];
        const pitch = b[po];
        if (voice & TIE) {
            kinds[step] = sounding ? "tie" : "orphan-tie";
        } else if (pitch >= NOTE_MIN && pitch <= NOTE_MAX) {
            kinds[step] = "onset";
            sounding = true;
        } else {
            sounding = false;
            kinds[step] = pitch > NOTE_MAX ? "pitch-range" : voice !== 0 ? "rest-voice" : "rest";
        }
    }
    return kinds;
}

/**
 * Everything in a slot that the music maker would not itself write. A song
 * with no issues is CANONICAL: rebuilding it note by note through
 * song-edit.js gives the same bytes. Issues are never repaired behind the
 * user's back — they are kept, and shown.
 *
 * kinds: header-range, ff-measure, control-range, control-bit0, bend,
 * orphan-tie, tie-voice (a tie byte other than 0x80), rest-voice,
 * pitch-range, onset-instrument (an onset above instrument 59).
 */
export function songShape(b) {
    checkSong(b);
    const issues = [];
    const header = headerOf(b);
    if (!header.valid) issues.push({ kind: "header-range" });
    let onsets = 0;
    const ff = new Set();
    for (let m = 0; m < MEASURES; m++) {
        const c = controlAt(b, m);
        if (c.ff) {
            issues.push({ kind: "ff-measure", measure: m });
            ff.add(m);
        } else {
            if (!c.valid) issues.push({ kind: "control-range", measure: m });
            if (c.low1) issues.push({ kind: "control-bit0", measure: m });
        }
    }
    for (let part = 0; part < PARTS; part++) {
        const kinds = partCells(b, part);
        let held = 0;
        for (let step = 0; step < SONG_STEPS; step++) {
            const kind = kinds[step];
            const measure = Math.floor(step / STEPS_PER_MEASURE);
            const { voice, pitch } = cellAt(b, part, step);
            // An 0xFF measure is one issue, not 64 bent ties.
            if (ff.has(measure)) {
                if (kind === "onset") onsets++;
                held = kind === "onset" ? pitch : kind === "tie" ? held : 0;
                continue;
            }
            if (kind === "onset") {
                onsets++;
                held = pitch;
                if (voice > NATIVE.INST_MAX) {
                    issues.push({ kind: "onset-instrument", measure, part, step });
                }
            } else if (kind === "tie") {
                if (voice !== TIE) issues.push({ kind: "tie-voice", measure, part, step });
                if (pitch !== held) issues.push({ kind: "bend", measure, part, step });
            } else {
                held = 0;
                if (kind === "orphan-tie") {
                    issues.push({ kind: "orphan-tie", measure, part, step });
                } else if (kind === "rest-voice") {
                    issues.push({ kind: "rest-voice", measure, part, step });
                } else if (kind === "pitch-range") {
                    issues.push({ kind: "pitch-range", measure, part, step });
                }
            }
        }
    }
    return { onsets, canonical: issues.length === 0, issues };
}

/** Issue counts by kind, for a one-line summary ("3 bends, 1 odd measure"). */
export function issueCounts(shape) {
    const out = {};
    for (const i of shape.issues) out[i.kind] = (out[i.kind] || 0) + 1;
    return out;
}
