// Editing a 音まろ song slot: every edit is the bytes in, new bytes out.
//
// The document is the 4,228-byte slot itself, never an event list that is
// re-encoded on save. An edit writes the cells it is about and nothing else,
// so a song imported from a cart and touched in one measure goes back with
// every other byte as the console wrote it — rest-step voice bytes, bent
// ties, out-of-range control bytes and all (song-view.js lists those).
//
// What an edit WRITES is limited to values 音まろ itself writes (NATIVE in
// song-view.js, measured over the disc's presets and every cart):
//
//   onset   voice = instrument 0-59, pitch = 1-59
//   tie     voice = 0x80, pitch = the held note's pitch (as encodeDezaSong
//           and 6,401 of Ramsie's 6,427 ties write it)
//   rest    voice = 0, pitch = 0 (the state of an untouched cell)
//   control ctrl0 bank 0-8, ctrl1 pattern 0-3, ctrl2 = chord 0-4 << 1 with
//           bits 7 and 0 kept as found, ctrl3 key 0-11
//   header  loop 0-31 with start <= end, echo 0-7, tempo 0-31
//
// Anything else throws a RangeError. A measure whose four control bytes are
// 0xFF (cart garbage: its cells are all ties) refuses edits until
// tidyMeasures() resets it, so a stray note never lands in noise.
//
// A part is monophonic: a note runs from its onset through its ties and stops
// at the next onset, exactly as the kernel's walker plays it. Placing a note
// inside another's tail cuts that note short, and a tail left over past the
// new note becomes rest — it would otherwise hold the new note on.
//
// Environment-neutral ESM (Node + browser).

import {
    MEASURE_HEADER,
    MEASURE_SIZE,
    MEASURES,
    PART_BLOCK,
    PARTS,
    SONG_HEADER,
    SONG_SIZE,
    STEPS_PER_MEASURE,
    TRANSPOSE_TABLE,
} from "../decode/decode-song.js";
import { CONTROL_DEFAULT } from "./song-write.js";
import {
    controlAt,
    controlOffset,
    headerOf,
    isFfMeasure,
    NATIVE,
    noteAt,
    partNotes,
    SONG_STEPS,
    stepOffsets,
    TIE,
} from "./song-view.js";

function fail(what) {
    throw new RangeError(`song-edit: ${what}`);
}

function int(v, lo, hi, what) {
    if (!Number.isInteger(v) || v < lo || v > hi) fail(`${what} must be an integer ${lo}..${hi}, got ${v}`);
    return v;
}

function copyOf(b) {
    if (!(b instanceof Uint8Array) || b.length !== SONG_SIZE) {
        throw new TypeError(`song-edit: a song is a ${SONG_SIZE}-byte Uint8Array`);
    }
    return b.slice();
}

function setCell(out, part, step, voice, pitch) {
    const [v, q] = stepOffsets(part, step);
    out[v] = voice;
    out[q] = pitch;
}

function isTieAt(b, part, step) {
    return (b[stepOffsets(part, step)[0]] & TIE) !== 0;
}

function isOnsetAt(b, part, step) {
    const [v, q] = stepOffsets(part, step);
    return (b[v] & TIE) === 0 && b[q] >= NATIVE.PITCH_MIN && b[q] <= NATIVE.PITCH_MAX;
}

const measureOf = (step) => Math.floor(step / STEPS_PER_MEASURE);

function assertUnlocked(b, fromStep, toStep) {
    for (let m = measureOf(fromStep); m <= measureOf(Math.max(fromStep, toStep - 1)); m++) {
        if (isFfMeasure(b, m)) fail(`measure ${m} is 0xFF garbage; tidy it first`);
    }
}

/** Turn the tie run that starts at `step` into rest, stopping at a locked measure. */
function clearTiesFrom(out, part, step) {
    while (step < SONG_STEPS && isTieAt(out, part, step) && !isFfMeasure(out, measureOf(step))) {
        setCell(out, part, step, 0, 0);
        step++;
    }
}

/** Where a note placed at `step` asking for `len` steps really ends: at the next onset. */
function noteEnd(b, part, step, len) {
    const limit = Math.min(step + len, SONG_STEPS);
    let end = step + 1;
    while (end < limit && !isOnsetAt(b, part, end)) end++;
    return end;
}

/**
 * A note that ends right where an 0xFF measure begins would pick up that
 * measure's ties (all of its cells are ties) and sound on through the noise —
 * and then be stuck there, since nothing may write into the measure. Refuse it.
 */
function assertEndsClear(out, part, end) {
    if (end < SONG_STEPS && isFfMeasure(out, measureOf(end)) && isTieAt(out, part, end)) {
        fail(`the note would run on into measure ${measureOf(end)}, which is 0xFF garbage; tidy it first`);
    }
}

function writeNote(b, part, step, len, pitch, inst) {
    const end = noteEnd(b, part, step, len);
    assertUnlocked(b, step, end);
    const out = copyOf(b);
    setCell(out, part, step, inst, pitch);
    for (let s = step + 1; s < end; s++) setCell(out, part, s, TIE, pitch);
    clearTiesFrom(out, part, end);
    assertEndsClear(out, part, end);
    return out;
}

/** Turn a note's cells to rest, leaving any 0xFF measure it runs through as it is (its ties go silent with the onset gone). */
function clearNote(out, part, from, to) {
    for (let s = from; s < to; s++) {
        if (!isFfMeasure(out, measureOf(s))) setCell(out, part, s, 0, 0);
    }
}

function checkPart(part) {
    return int(part, 0, PARTS - 1, "part");
}

function checkStep(step) {
    return int(step, 0, SONG_STEPS - 1, "step");
}

function onsetAt(b, part, step) {
    const n = noteAt(b, part, step);
    if (!n || n.step !== step) fail(`part ${part} has no note starting at step ${step}`);
    return n;
}

/** Strike a note: `{part, step, len = 1, pitch 1-59, inst 0-59}`. */
export function placeNote(b, { part, step, len = 1, pitch, inst = 0 }) {
    checkPart(part);
    checkStep(step);
    int(len, 1, SONG_STEPS, "len");
    int(pitch, NATIVE.PITCH_MIN, NATIVE.PITCH_MAX, "pitch");
    int(inst, 0, NATIVE.INST_MAX, "instrument");
    return writeNote(b, part, step, len, pitch, inst);
}

/**
 * Erase the note sounding at `step` (onset or any step of its tail) back to
 * rest. On a step with no note — an orphan tie, a rest whose voice byte still
 * names an instrument, a stray pitch above 59 — the one cell is cleared.
 */
export function eraseNote(b, part, step) {
    checkPart(part);
    checkStep(step);
    const n = noteAt(b, part, step);
    if (n) {
        // An onset never sits in an 0xFF measure (its cells are all ties); a
        // cart note whose tail runs into one is cleared up to it.
        const out = copyOf(b);
        clearNote(out, part, n.step, n.step + n.len);
        return out;
    }
    assertUnlocked(b, step, step + 1);
    const out = copyOf(b);
    setCell(out, part, step, 0, 0);
    return out;
}

/** Hold the note starting at `step` for `len` steps (stopping at the next onset). */
export function resizeNote(b, part, step, len) {
    checkPart(part);
    checkStep(step);
    int(len, 1, SONG_STEPS, "len");
    const n = onsetAt(b, part, step);
    const oldEnd = n.step + n.len;
    const end = noteEnd(b, part, step, len);
    const out = copyOf(b);
    if (end > oldEnd) {
        assertUnlocked(b, oldEnd, end);
        for (let s = oldEnd; s < end; s++) setCell(out, part, s, TIE, n.pitch);
        clearTiesFrom(out, part, end);
        assertEndsClear(out, part, end);
    } else {
        clearNote(out, part, end, oldEnd);
        assertEndsClear(out, part, end);
    }
    return out;
}

/**
 * Move the note starting at `step` — to another step, pitch and/or part —
 * keeping its length and instrument. Its bends, if it had any, are not kept.
 */
export function moveNote(b, part, step, to = {}) {
    checkPart(part);
    checkStep(step);
    const n = onsetAt(b, part, step);
    const toPart = checkPart(to.part ?? part);
    const toStep = checkStep(to.step ?? step);
    const pitch = int(to.pitch ?? n.pitch, NATIVE.PITCH_MIN, NATIVE.PITCH_MAX, "pitch");
    const erased = eraseNote(b, part, step);
    // The note's own instrument byte travels with it, even one above 59.
    return writeNote(erased, toPart, toStep, n.len, pitch, n.inst);
}

/** Repaint the instrument of the note sounding at `step` (the console's brush). */
export function paintInstrument(b, part, step, inst) {
    checkPart(part);
    checkStep(step);
    int(inst, 0, NATIVE.INST_MAX, "instrument");
    const n = noteAt(b, part, step);
    if (!n) fail(`part ${part} has no note at step ${step}`);
    assertUnlocked(b, n.step, n.step + 1);
    const out = copyOf(b);
    out[stepOffsets(part, n.step)[0]] = inst;
    return out;
}

/**
 * A measure's auto-accompaniment: `{bank 0-8, pattern 0-3, chord 0-4, key
 * 0-11}`, any subset — only the bytes named are written, so a cart measure
 * whose other control bytes are off the table keeps them. ctrl2's bits 7 and
 * 0 are kept as found — what they do is not yet known (FORMAT.md, S2), and
 * 音まろ's own data sets bit 7 in most measures.
 */
export function setRhythm(b, m, fields = {}) {
    int(m, 0, MEASURES - 1, "measure");
    if (isFfMeasure(b, m)) fail(`measure ${m} is 0xFF garbage; tidy it first`);
    const c = controlAt(b, m);
    const has = (k) => fields[k] !== undefined && fields[k] !== null;
    if (has("bank")) int(fields.bank, 0, NATIVE.BANKS - 1, `measure ${m} bank`);
    if (has("pattern")) int(fields.pattern, 0, NATIVE.PATTERNS - 1, `measure ${m} pattern`);
    if (has("chord")) int(fields.chord, 0, NATIVE.CHORDS - 1, `measure ${m} chord`);
    if (has("key")) int(fields.key, 0, NATIVE.KEYS - 1, `measure ${m} key`);
    const out = copyOf(b);
    const at = controlOffset(m);
    if (has("bank")) out[at] = fields.bank;
    if (has("pattern")) out[at + 1] = fields.pattern;
    if (has("chord")) out[at + 2] = (fields.chord << 1) | (c.raw[2] & 0x81);
    if (has("key")) out[at + 3] = fields.key;
    return out;
}

/** No accompaniment in this measure: bank 0, pattern 0, chord 0, no transpose. */
export function clearRhythm(b, m) {
    return setRhythm(b, m, { bank: 0, pattern: 0, chord: 0, key: CONTROL_DEFAULT[3] });
}

/** `{loopStart, loopEnd, echo, tempoIndex}`, any subset; only those bytes are written. */
export function setHeader(b, fields = {}) {
    const h = headerOf(b);
    const has = (k) => fields[k] !== undefined && fields[k] !== null;
    if (has("loopStart")) int(fields.loopStart, 0, NATIVE.LOOP_MAX, "loopStart");
    if (has("loopEnd")) int(fields.loopEnd, 0, NATIVE.LOOP_MAX, "loopEnd");
    if (has("echo")) int(fields.echo, 0, NATIVE.ECHO_MAX, "echo");
    if (has("tempoIndex")) int(fields.tempoIndex, 0, NATIVE.TEMPO_MAX, "tempoIndex");
    if (has("loopStart") || has("loopEnd")) {
        // Against the partner as found only when the partner is a real measure.
        const start = has("loopStart") ? fields.loopStart : h.loopStart;
        const end = has("loopEnd") ? fields.loopEnd : h.loopEnd;
        if (start <= NATIVE.LOOP_MAX && end <= NATIVE.LOOP_MAX && end < start) {
            fail(`loopEnd ${end} is before loopStart ${start}`);
        }
    }
    const out = copyOf(b);
    if (has("loopStart")) out[0] = fields.loopStart;
    if (has("loopEnd")) out[1] = fields.loopEnd;
    if (has("echo")) out[2] = fields.echo;
    if (has("tempoIndex")) out[3] = fields.tempoIndex;
    return out;
}

function blankMeasure(out, m) {
    const at = controlOffset(m);
    out.set(CONTROL_DEFAULT, at);
    out.fill(0, at + MEASURE_HEADER, at + MEASURE_SIZE);
}

/**
 * Reset measures to the editor's blank: default control bytes, every part
 * at rest. The one edit an 0xFF measure accepts. A note tied into the first
 * measure after the range from inside it is cut there.
 */
export function tidyMeasures(b, m0, count = 1) {
    int(m0, 0, MEASURES - 1, "measure");
    int(count, 1, MEASURES - m0, "count");
    const out = copyOf(b);
    for (let m = m0; m < m0 + count; m++) blankMeasure(out, m);
    if (m0 + count < MEASURES) cutTails(b, out, (m0 + count) * STEPS_PER_MEASURE);
    return out;
}

/**
 * A note that sounded across `step` in `b` has had its cells before `step`
 * changed under it: what is left of its tail from `step` on would now be ties
 * with nothing sounding (or would hold on whatever sounds there now). Ties
 * that were already orphans stay as they were.
 */
function cutTails(b, out, step) {
    for (let p = 0; p < PARTS; p++) {
        const n = noteAt(b, p, step);
        if (n && n.step < step) clearTiesFrom(out, p, step);
    }
}

/** Measures as raw bytes (control + four parts), the clipboard's format. */
export function copyMeasures(b, m0, count = 1) {
    int(m0, 0, MEASURES - 1, "measure");
    int(count, 1, MEASURES - m0, "count");
    copyOf(b);
    const from = SONG_HEADER + m0 * MEASURE_SIZE;
    return b.slice(from, from + count * MEASURE_SIZE);
}

/**
 * Paste clipboard measures at `at` — a measure copied and pasted back in
 * place is the identity. `parts` picks which of the four parts land and
 * `rhythm` whether the control bytes do. Measures past 31 fall off.
 *
 * The pasted cells land verbatim; only the two joins are mended, as the other
 * measure edits mend theirs: a note of the song that was cut by the paste
 * loses the tail it had past the pasted measures, and pasted ties that open
 * the clip are kept only where they carry on a note of the same pitch.
 * Replacing an 0xFF measure takes a whole measure (all four parts and the
 * rhythm); a part of one cannot go in, and a clip measure's 0xFF control
 * bytes cannot go in on their own.
 */
export function pasteMeasures(b, at, clip, { parts = [true, true, true, true], rhythm = true } = {}) {
    int(at, 0, MEASURES - 1, "measure");
    if (!(clip instanceof Uint8Array) || clip.length === 0 || clip.length % MEASURE_SIZE) {
        fail(`a clip is whole ${MEASURE_SIZE}-byte measures`);
    }
    const pick = [0, 1, 2, 3].map((p) => parts[p] === true);
    const whole = rhythm && pick.every(Boolean);
    const out = copyOf(b);
    const n = clip.length / MEASURE_SIZE;
    let landed = 0;
    for (let i = 0; i < n && at + i < MEASURES; i++, landed++) {
        const m = at + i;
        const src = i * MEASURE_SIZE;
        const ffClip = clip[src] === 0xff && clip[src + 1] === 0xff && clip[src + 2] === 0xff && clip[src + 3] === 0xff;
        if (!whole && (isFfMeasure(b, m) || (rhythm && ffClip))) fail(`measure ${m}: 0xFF garbage only moves as a whole measure; tidy it first`);
        const dst = SONG_HEADER + m * MEASURE_SIZE;
        if (rhythm) out.set(clip.subarray(src, src + MEASURE_HEADER), dst);
        for (let p = 0; p < PARTS; p++) {
            if (!pick[p]) continue;
            const o = MEASURE_HEADER + p * PART_BLOCK;
            out.set(clip.subarray(src + o, src + o + PART_BLOCK), dst + o);
        }
    }
    const join = at * STEPS_PER_MEASURE;
    const end = (at + landed) * STEPS_PER_MEASURE;
    for (let p = 0; p < PARTS; p++) {
        if (!pick[p]) continue;
        let same = true;
        for (let s = join; s < end && same; s++) {
            const [v, q] = stepOffsets(p, s);
            same = out[v] === b[v] && out[q] === b[q];
        }
        if (same) continue; // nothing in this part changed: nothing to mend
        // Leading join: pasted ties carry on a note only of the same pitch.
        if (isTieAt(out, p, join) && !isFfMeasure(out, measureOf(join))) {
            const prev = join > 0 ? noteAt(out, p, join - 1) : null;
            if (!prev || prev.pitch !== out[stepOffsets(p, join)[1]]) clearTiesFrom(out, p, join);
        }
        // Trailing join: the song's own tail past the paste stays only if the
        // note it belongs to came through the paste unchanged.
        if (end < SONG_STEPS && isTieAt(out, p, end)) {
            const old = noteAt(b, p, end);
            let intact = !!old;
            for (let s = old ? old.step : end; intact && s < end; s++) {
                const [v, q] = stepOffsets(p, s);
                intact = out[v] === b[v] && out[q] === b[q];
            }
            if (!intact) clearTiesFrom(out, p, end);
        }
    }
    return out;
}

function shiftMeasures(out, b, fromM, toM, count) {
    for (let i = 0; i < count; i++) {
        const src = SONG_HEADER + (fromM + i) * MEASURE_SIZE;
        out.set(b.subarray(src, src + MEASURE_SIZE), SONG_HEADER + (toM + i) * MEASURE_SIZE);
    }
}

/** Open `count` blank measures at `at`; the last `count` measures fall off the end. */
export function insertMeasures(b, at, count = 1) {
    int(at, 0, MEASURES - 1, "measure");
    int(count, 1, MEASURES - at, "count");
    const out = copyOf(b);
    shiftMeasures(out, b, at, at + count, MEASURES - at - count);
    for (let m = at; m < at + count; m++) blankMeasure(out, m);
    // A note that ran across `at` is cut there; its tail, now past the gap,
    // would be ties with nothing sounding. Ties that were orphans already
    // moved with their measure, as they were.
    if (at + count < MEASURES) {
        const gapEnd = (at + count) * STEPS_PER_MEASURE;
        for (let p = 0; p < PARTS; p++) {
            const n = noteAt(b, p, at * STEPS_PER_MEASURE);
            if (n && n.step < at * STEPS_PER_MEASURE) clearTiesFrom(out, p, gapEnd);
        }
    }
    return out;
}

/** Remove `count` measures at `at`; blank measures fill in at the end. */
export function deleteMeasures(b, at, count = 1) {
    int(at, 0, MEASURES - 1, "measure");
    int(count, 1, MEASURES - at, "count");
    const out = copyOf(b);
    shiftMeasures(out, b, at + count, at, MEASURES - at - count);
    for (let m = MEASURES - count; m < MEASURES; m++) blankMeasure(out, m);
    // A note held across the cut keeps sounding, shorter. A tail whose onset
    // was deleted must not attach itself to whatever sounds before `at`.
    const join = at * STEPS_PER_MEASURE;
    const after = (at + count) * STEPS_PER_MEASURE;
    if (after < SONG_STEPS) {
        for (let p = 0; p < PARTS; p++) {
            const n = noteAt(b, p, after);
            if (n && n.step >= join) clearTiesFrom(out, p, join);
            // An orphan tie that now follows a sounding note would hold it on.
            else if (!n && isTieAt(b, p, after) && join > 0 && noteAt(out, p, join - 1)) clearTiesFrom(out, p, join);
        }
    }
    return out;
}

/**
 * Transpose measures m0..m1 (inclusive) by `semis`. `parts` picks the composed
 * parts; `rhythm` also moves each measure's accompaniment key (ctrl3 indexes a
 * table that spans -5..+6, so a key wraps by octaves). A note that would leave
 * pitch 1-59, or that runs on through an 0xFF measure, is left where it is and
 * reported in `refused`.
 */
export function transposeMeasures(b, m0, m1, semis, { parts = [true, true, true, true], rhythm = false } = {}) {
    int(m0, 0, MEASURES - 1, "from measure");
    int(m1, m0, MEASURES - 1, "to measure");
    int(semis, -48, 48, "semitones");
    const out = copyOf(b);
    const refused = [];
    const lo = m0 * STEPS_PER_MEASURE;
    const hi = (m1 + 1) * STEPS_PER_MEASURE;
    const inRange = (p) => p >= NATIVE.PITCH_MIN && p <= NATIVE.PITCH_MAX;
    for (let p = 0; p < PARTS; p++) {
        if (!parts[p]) continue;
        for (const n of partNotes(b, p)) {
            if (n.step < lo || n.step >= hi) continue;
            const np = n.pitch + semis;
            let locked = false;
            for (let s = n.step; s < n.step + n.len && !locked; s += 1) locked = isFfMeasure(b, measureOf(s));
            if (!inRange(np) || locked) {
                refused.push({ part: p, step: n.step });
                continue;
            }
            out[stepOffsets(p, n.step)[1]] = np;
            for (let s = n.step + 1; s < n.step + n.len; s++) {
                const q = stepOffsets(p, s)[1];
                if (b[q] === n.pitch) out[q] = np;
                else if (inRange(b[q] + semis)) out[q] = b[q] + semis;
            }
        }
    }
    if (rhythm) {
        for (let m = m0; m <= m1; m++) {
            const c = controlAt(b, m);
            if (c.ff || c.transpose === null) continue;
            const v = ((((c.transpose + semis + 5) % 12) + 12) % 12) - 5;
            out[controlOffset(m, 3)] = TRANSPOSE_TABLE.indexOf(v);
        }
    }
    return { bytes: out, refused };
}

/** Write a list of `{step, len, pitch, inst}` notes into a part, in step order. */
export function placeNotes(b, part, notes) {
    let out = b;
    for (const n of [...notes].sort((x, y) => x.step - y.step)) {
        out = placeNote(out, { part, step: n.step, len: n.len ?? 1, pitch: n.pitch ?? n.note, inst: n.inst ?? n.instrument ?? 0 });
    }
    return out;
}
