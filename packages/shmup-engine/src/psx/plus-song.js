// Dezaemon+ SOUND — what the sixteen bit-packed songs in the save actually
// say, as a transcription of the game's own code.
//
// WHICH BINARY. Every RAM address in this file is a DEZA.EXE address, read
// off `dev-fixtures/Dezaemon Plus (Japan).bin` — SLPS-00335, whose boot
// executable SLPS_003.35 loads DEZA.EXE at 0x80010000. gp = 0x8014E140, set at
// DEZA.EXE 0x80013B40, which is what makes the `N(gp)` globals below resolve.
//
// This matters because plus.js and FORMAT-PSX.md's older notes cite MAIN.EXE
// addresses, and MAIN.EXE is the SLPS-01504 (_Dezaemon Plus Select 100_) build:
// a DIFFERENT binary, with everything at different addresses. The same
// scatter/gather table is MAIN.EXE 0x8005A380 and DEZA.EXE 0x800DE2B8; the same
// song unpacker is MAIN.EXE 0x8002E49C and DEZA.EXE 0x80057760. An address
// without its binary named is worse than no address, so every one here carries
// the DEZA.EXE label by way of this paragraph. No Select 100 image is in
// dev-fixtures — the only PlayStation Dezaemon disc there is SLPS-00335.
//
// WHY THIS FILE EXISTS. FORMAT-PSX.md already had the BIT LAYOUT — 16 bars of a
// 14-bit header and 32 cells of 11 bits as 5+6, then a 16-bit tail — and listed
// the MEANING as unresolved. The meaning is in three routines:
//
//   0x80057760  the unpacker. Reads the bit stream into a flat 1092-byte
//               buffer at 0x801F05F4 (16 bars x 68 bytes, then 4 tail bytes).
//   0x80057E70  the melody sequencer, called once per step. It is what says
//               the 32 cells are TWO 16-STEP VOICES, that the SECOND byte of a
//               cell is a note with 0x7C and 0x7D as key-off and tie, and that
//               the FIRST is an instrument.
//   0x80058130  the accompaniment player, called twice per step. It is what
//               says the four bar-header fields are a backing-pattern index
//               and a transpose.
//
// The sound calls at the bottom of both are libsnd: 0x800C79F4 unpacks its two
// words into SsUtKeyOn(vabId, prog, note, fine, volL, volR) and 0x800D0864 into
// the matching key-off. That is the fact that pins the note table — the value
// fed to SsUtKeyOn's `note` is the table entry's HIGH byte, and the
// accompaniment path reaches the same argument by `a1 = note << 8`
// (0x800582E8), which is only consistent if the table's high byte is a key
// number in the same space as a raw accompaniment note.
//
// CORROBORATION FROM OUTSIDE THE CODE. Two checks, and it matters which is
// which, because only these two could have come back negative.
//
// The note bytes. Across the 67 Dezaemon+ saves in the local corpus (1,072
// songs, 949 of them carrying a note at all) the ONLY note bytes that ever
// occur are the 33 non-zero table entries plus 124 and 125 — no table holes,
// nothing above 99. That is the strongest thing here, because the corpus was
// written by people who never saw this decoder: a reversed 5+6 split, a moved
// note base or a rewidened bar header all push bytes into the holes, and the
// check goes red.
//
// The sample bank. The two melody biases below reach programs 1-34 and 91-124,
// and those are exactly the two runs in ALLBGMSE.VH multisampled over keys
// 55..87, the note table's whole output range. On the backing side the pattern
// ROM names programs 35-43 (and 0, only ever in cells whose note is already
// key-off or tie), with no bias applied — 0x8005824C loads the ROM byte and
// 0x800582F8 hands it to SsUtKeyOn as the program. The full set of instrument
// bytes that occur with a real note is 35..43 AND 125, ten programs, not nine:
// 125 is track 5's alone. Every one of the ten is sampled over a key range
// containing the untransposed notes the ROM plays under it. Three are exact
// rather than merely containing — 35 is 4..51 against ROM notes 4..51, 40 is
// 4..105 against 4..105, and 125 is 100..107 against exactly eight tones
// spanning 100..107 — and the other seven are strict containments. Program 43
// is one of those seven: its VH range is 4..105 but the lowest note the ROM
// ever plays under it is 7.
//
// NOT corroboration from outside the code: the round trip. Every song in the
// corpus re-encodes to its original bytes, which proves decodePlusSong and
// encodePlusSong are mutual inverses and that each slot's two slack bytes are
// zero — nothing more. A round trip is symmetric by construction, so any
// re-slicing of the bit stream applied to BOTH sides survives it; a 15-bit bar
// header that leaves the 736-byte slot with no slack at all was tried against
// all 1,072 songs and re-encoded byte for byte. It checks the decoder against
// its own twin, not against the format.
//
// STILL UNSETTLED: whether a Dezaemon+ key number is CONCERT-ABSOLUTE — whether
// key 60 really is middle C. That needs the recorded pitch of the VAGs measured
// against each tone's centre note, which nothing here does. The key space is at
// least internally consistent, in that the ranges above line up, and a wrong
// anchor shifts every note by one constant rather than distorting the music.
// `plusNoteToMidi` is written on the assumption and says so.
//
// plus.js owns the save's geometry (PLUS_SOUND_OFFSET, PLUS_SONG_SIZE,
// PLUS_SONG_COUNT, PLUS_BGM_SLOTS and the BGM assignment table that names which
// song plays where) and is imported rather than duplicated here.
// Environment-neutral ESM (Node + browser).

import { PLUS_SONG_COUNT, PLUS_SONG_SIZE, PLUS_SOUND_OFFSET } from "./plus.js";

// --- the bit stream ----------------------------------------------------------

/**
 * The reader at 0x80057650 (the plain one) and 0x800576CC (the note one) are
 * the same loop: MSB first out of a one-byte shift register refilled from the
 * source, with the result masked to eight bits on the way out. Nothing asks
 * for more than six bits, so the mask never bites.
 *
 * @param {Uint8Array} bytes
 * @param {number} start  byte offset to begin at
 * @returns {(n: number) => number}  read the next `n` bits
 */
export function plusBitReader(bytes, start = 0) {
    let p = start, reg = 0, left = 0;
    return (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            if (left === 0) {
                reg = bytes[p++] ?? 0;
                left = 8;
            }
            v = ((v << 1) | (reg >> 7)) & 0xff;
            reg = (reg << 1) & 0xff;
            left--;
        }
        return v;
    };
}

export const PLUS_SONG_BARS = 16; // 0x80057894: the unpacker's outer loop runs s6 < 16
/**
 * 0x8005801C: the melody loop runs s3 < 2 (`slti v0,s3,2`; 0x80058020 is the
 * branch that acts on it). The 32 cells are two voices, not 32 steps.
 */
export const PLUS_SONG_VOICES = 2;
/** 0x80057ECC: the sequencer indexes the step as `pos & 0xF`. */
export const PLUS_SONG_STEPS = 16;
/** 0x80057884: the unpacker's inner loop runs s3 < 32 — VOICES * STEPS cells a bar. */
export const PLUS_SONG_CELLS = PLUS_SONG_VOICES * PLUS_SONG_STEPS;
/** 0x80057EBC: the bar's base is `bar * (16 + 1) * 4` — a 4-byte header, then 64 cell bytes. */
export const PLUS_SONG_BAR_STRIDE = 68;
/** 0x80057EE0: voice 1 sits 32 bytes (16 cell pairs) further into the bar. */
export const PLUS_SONG_VOICE_STRIDE = 32;
/** The flat buffer the unpacker fills, at 0x801F05F4. Its tail sits at 0x801F0A34. */
export const PLUS_SONG_UNPACKED_SIZE = PLUS_SONG_BARS * PLUS_SONG_BAR_STRIDE + 4; // 1092
export const PLUS_SONG_UNPACKED_RAM = 0x801f05f4;
/** 16 * (14 + 32 * 11) + 16 bits. The remaining 2 of the slot's 0x2E0 bytes are slack. */
export const PLUS_SONG_BITS = PLUS_SONG_BARS * (14 + PLUS_SONG_CELLS * 11) + 16; // 5872
export const PLUS_SONG_PACKED_BYTES = PLUS_SONG_BITS / 8; // 734

/**
 * 0x800F03A8, applied to the 5-bit field on the way out of the stream
 * (0x80057860). Its inverse at 0x800F03C8 is what the packer 0x80057B04
 * applies on the way in, so the byte in the unpacked buffer is the EDITOR's
 * instrument number and the raw 5 bits are the driver's.
 */
export const PLUS_INSTRUMENT_PERM = Object.freeze([
    0, 1, 2, 3, 4, 5, 6, 16, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 17, 18, 19, 20, 21, 22, 23, 31, 24, 28, 27, 25, 29, 26, 30,
]);
/** 0x800F03C8: the packer's side of the same permutation. */
export const PLUS_INSTRUMENT_UNPERM = Object.freeze((() => {
    const a = new Array(32);
    PLUS_INSTRUMENT_PERM.forEach((v, i) => a[v] = i);
    return a;
})());

export const PLUS_NOTE_REST = 0x7c; // 124 — key off (0x80057EF8, and 0x800581D4 in the backing)
export const PLUS_NOTE_TIE = 0x7d; // 125 — do nothing, let the note ring (0x80057F18 / 0x800581F4)

/** The tail of the note reader 0x800576CC: `v + 55`, and 7 more once v reaches 62. */
export function plusNoteFromBits(v) {
    return v >= 62 ? v + 62 : v + 55;
}
/** The inverse, exact over the whole 0..63 domain — 62 and 63 are what become REST and TIE. */
export function plusNoteToBits(noteByte) {
    return noteByte >= PLUS_NOTE_REST ? noteByte - 62 : noteByte - 55;
}

/**
 * Unpack one 0x2E0-byte song exactly as 0x80057760 does.
 *
 * Per bar the unpacker reads 4, 2, 4 and 4 bits into header bytes 0..3
 * (0x800577A0..0x8005781C), then 32 cells of a 5-bit field and a 6-bit field
 * (0x80057828..0x8005788C), then after the sixteenth bar 3, 5, 4 and 4 bits
 * into the tail (0x800578A0..0x80057918).
 *
 * `bars[b].voices[v][s]` is the {instrument, note} pair the game stores, in
 * that order because that is the order the bytes land in and the order both
 * players read them back (instrument at +0, note at +1). `raw5`/`raw6` keep
 * the pre-translation values so a re-encode can be checked against them.
 *
 * @param {Uint8Array} bytes
 * @param {number} at  byte offset of the song within `bytes`
 */
export function decodePlusSong(bytes, at = 0) {
    const read = plusBitReader(bytes, at);
    const bars = [];
    for (let b = 0; b < PLUS_SONG_BARS; b++) {
        const head = [read(4), read(2), read(4), read(4)];
        const flat = [];
        for (let c = 0; c < PLUS_SONG_CELLS; c++) {
            const raw5 = read(5), raw6 = read(6);
            flat.push({
                instrument: PLUS_INSTRUMENT_PERM[raw5],
                note: plusNoteFromBits(raw6),
                raw5,
                raw6,
            });
        }
        bars.push({
            head,
            voices: [flat.slice(0, PLUS_SONG_STEPS), flat.slice(PLUS_SONG_STEPS)],
        });
    }
    const tail = [read(3), read(5), read(4), read(4)];
    return { bars, tail };
}

/**
 * The flat 1092-byte buffer the game builds at 0x801F05F4, for byte checks
 * against a memory dump. Header, then the 64 cell bytes of the bar with
 * voice 0's sixteen pairs first, then the four tail bytes.
 */
export function plusSongUnpacked(song) {
    const out = new Uint8Array(PLUS_SONG_UNPACKED_SIZE);
    let at = 0;
    for (const bar of song.bars) {
        out.set(bar.head, at);
        at += 4;
        for (const voice of bar.voices) {
            for (const cell of voice) {
                out[at++] = cell.instrument;
                out[at++] = cell.note;
            }
        }
    }
    out.set(song.tail, at);
    return out;
}

/**
 * Re-pack a decoded song, so a decode can be proved lossless against the
 * original bytes. The result is the full 0x2E0-byte slot: the 734 bits-bearing
 * bytes plus two zero bytes of slack, which is byte-exact against every one of
 * the 1,072 songs in the local corpus (their slack is always zero too).
 */
export function encodePlusSong(song) {
    const out = new Uint8Array(PLUS_SONG_SIZE);
    let bit = 0;
    const put = (v, n) => {
        for (let i = n - 1; i >= 0; i--) {
            if ((v >> i) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
            bit++;
        }
    };
    for (const bar of song.bars) {
        [4, 2, 4, 4].forEach((n, i) => put(bar.head[i], n));
        for (const voice of bar.voices) {
            for (const cell of voice) {
                put(PLUS_INSTRUMENT_UNPERM[cell.instrument], 5);
                put(plusNoteToBits(cell.note), 6);
            }
        }
    }
    [3, 5, 4, 4].forEach((n, i) => put(song.tail[i], n));
    return out;
}

// --- notes -------------------------------------------------------------------

/**
 * 0x800F03BA + noteByte*2, read as a u16 (0x80057F64): the HIGH byte is
 * SsUtKeyOn's `note`, the low byte its `fine` and always zero. Only 55..99
 * have entries, which is the same range 0x80057F20's `note - 55 < 45` admits;
 * the twelve holes are the codes whose low nibble would be 12..15, and the
 * table's own bytes run out at 0x800F0482 — two zero bytes short of the tempo
 * table at 0x800F0484, which hold what would be code 100's entry.
 */
export const PLUS_NOTE_TABLE_RAM = 0x800f03ba;
export const PLUS_NOTE_MIN = 55;
export const PLUS_NOTE_MAX = 99;

/**
 * A note byte as a MIDI key number. The closed form reproduces all 33
 * non-zero entries of the real table exactly: the byte is a packed
 * octave/semitone pair, `(b >> 4)` octaves and `(b & 15)` semitones.
 *
 * null for a rest, a tie, a table hole (low nibble 12..15) or anything out of
 * range — the sequencer's own guard drops the same values.
 *
 * The +12 itself is MEASURED, not assumed: the real table's high byte is 55
 * for code 55 and 60 for code 0x40, so the closed form including its constant
 * is read straight off the data. What is assumed is one step further out —
 * that the driver's key space is CONCERT-ABSOLUTE, i.e. that a key of 60 is
 * actually middle C. See the header. Every key number this returns is in the
 * driver's space; whether that space is concert pitch is the open question.
 */
export function plusNoteToMidi(noteByte) {
    if (noteByte < PLUS_NOTE_MIN || noteByte > PLUS_NOTE_MAX) return null;
    const semi = noteByte & 0x0f;
    if (semi > 11) return null; // a hole in the table: the entry is 0x0000
    return (noteByte >> 4) * 12 + semi + 12;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** A MIDI key number as a name, on the same middle-C-is-60 assumption. */
export function plusNoteName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// --- instruments -------------------------------------------------------------

/**
 * What the instrument byte becomes before the +1 / +91 bias. 0x80057F50 reads
 * a flag byte at 0x8014E844 and picks the table: clear takes 0x800F0408,
 * set takes 0x800F03E8. The second is exactly PLUS_INSTRUMENT_UNPERM, so with
 * the flag set the driver program is the raw 5-bit field straight out of the
 * stream — the permutation cancels.
 */
export const PLUS_INSTRUMENT_PROGRAMS = Object.freeze([
    0, 1, 2, 3, 4, 5, 6, 32, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 17, 18, 19, 20, 21, 22, 23, 25, 28, 30, 27, 33, 29, 31, 24,
]);
export const PLUS_INSTRUMENT_PROGRAMS_ALT = PLUS_INSTRUMENT_UNPERM;
/**
 * 0x80057FF0 (voice 0, map[i] + 1) and 0x80057FDC (voice 1, map[i] + 91).
 *
 * 0x80057FE8, which this used to cite, is where the voice-0 path BEGINS — the
 * target of the `bne s3,v0` at 0x80057FCC — and holds the `lw`, not the add.
 * The two addresses here are the two `addiu`s themselves, so the pair is
 * symmetric the way it reads.
 */
export const PLUS_VOICE_PROGRAM_BIAS = Object.freeze([1, 91]);

/** The libsnd program number a cell plays, for one of the two melody voices. */
export function plusVoiceProgram(instrument, voice, { alt = false } = {}) {
    const map = alt ? PLUS_INSTRUMENT_PROGRAMS_ALT : PLUS_INSTRUMENT_PROGRAMS;
    return map[instrument] + PLUS_VOICE_PROGRAM_BIAS[voice];
}

// --- the tail: tempo, volume and the loop ------------------------------------

/**
 * 0x800F0484, indexed by tail[1] (0x8005845C). The value is a step period in
 * counter units, and the counter at gp+2292 gains 4 every frame (0x80058F20)
 * and fires a step when it passes the period (0x80058FD8). So a step lasts
 * `period / 4` frames; at 60 Hz and four steps to a beat that is 3600 / period
 * BPM. The accompaniment gets a second call at half the period (0x80058F38's
 * rounded `period >> 1`), which is the half-step the ROM's pairs supply.
 */
export const PLUS_TEMPO_TABLE = Object.freeze([
    92, 82, 73, 67, 61, 56, 52, 49, 46, 43, 41, 38, 36, 35, 33, 32,
    31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
]);
/** The counter's gain per frame, 0x80058F20's `addiu v0,v0,4`. */
export const PLUS_TEMPO_TICKS_PER_FRAME = 4;
/**
 * A step is a sixteenth, so four of them make a beat.
 *
 * ASSUMED, NOT TRACED — the one number in this tempo chain that is. Everything
 * else is read off the driver: the +4 per frame at 0x80058F20, the compare
 * against the table period at 0x80058FD8, the table itself at 0x800F0484.
 * Nothing in the driver names a beat at all. 16 steps to a bar makes 4/4
 * overwhelming, and every BPM this module reports scales with this constant,
 * so a wrong value would misreport every tempo by the same ratio.
 */
export const PLUS_STEPS_PER_BEAT = 4;
/** NTSC PlayStation. The driver's tick is the vertical blank. */
export const PLUS_FRAMES_PER_SECOND = 60;
/**
 * The BPM numerator, 3600. Derived rather than written out so the three
 * constants above stay load-bearing: a step lasts `period / TICKS_PER_FRAME`
 * frames, so beats per minute is `60 * FPS * TICKS_PER_FRAME / STEPS_PER_BEAT`
 * over the period.
 */
export const PLUS_BPM_NUMERATOR = 60 * PLUS_FRAMES_PER_SECOND *
    PLUS_TEMPO_TICKS_PER_FRAME / PLUS_STEPS_PER_BEAT;

/**
 * 0x800F04A4, indexed by tail[0] (0x8005849C). The byte goes to 0x800C73A8 as
 * both left and right master volume, which computes `level * 32767 / 127`
 * (0x800C73B8's `level << 15` minus `level`, times the reciprocal of 127) —
 * so it is a 0..127 level, of which the eight settings use 0..56 in steps of 8.
 */
export const PLUS_VOLUME_TABLE = Object.freeze([0, 8, 16, 24, 32, 40, 48, 56]);

/**
 * The four tail bytes, named from where 0x800583E4 puts them and what the tick
 * from 0x80058F18 does with them. tail[2] and tail[3] are the loop: 0x80058FB4
 * compares the bar against `lastBar + 1` and 0x80058FC4 sets the position back
 * to `loopBar * 16`.
 */
export function plusSongSettings(tail) {
    const [vol, tempo, loopBar, lastBar] = tail;
    const period = PLUS_TEMPO_TABLE[tempo] ?? null;
    return {
        volumeIndex: vol,
        volume: PLUS_VOLUME_TABLE[vol] ?? null, // 0..127 for the driver
        tempoIndex: tempo,
        stepPeriod: period, // counter units, four added a frame
        bpm: period === null ? null : PLUS_BPM_NUMERATOR / period,
        loopBar, // gp+1652: the position resets to loopBar * 16
        lastBar, // gp+912: the song loops once it passes this bar
        bars: lastBar + 1,
    };
}

// --- the bar header: the backing pattern -------------------------------------

/**
 * The 92,160-byte pattern ROM at 0x800F4BAC, addressed by 0x80058174..0x800581BC
 * as `patternA * 10240 + patternB * 2560 + patternC * 512 + track * 64 +
 * step * 4 + half * 2`, with the instrument at +0 and the note at +1 — the same
 * pair order as a melody cell. The strides multiply out to exactly 92,160.
 */
export const PLUS_ACCOMP_ROM = Object.freeze({
    address: 0x800f4bac,
    bytes: 92160,
    patternAStride: 10240,
    patternBStride: 2560,
    patternCStride: 512,
    trackStride: 64,
    stepStride: 4,
    halfStride: 2,
    shape: "9 patternA x 4 patternB x 5 patternC x 8 tracks x 16 steps x 2 half-steps x (instrument, note)",
});
/** 0x8005830C: the accompaniment loop runs s3 < 8. */
export const PLUS_ACCOMP_TRACKS = 8;
/** 0x80058258: only tracks 0..4 are transposed and octave-folded. */
export const PLUS_ACCOMP_PITCHED_TRACKS = 5;
/** 0x800581FC: track 4 plays only when patternC's low bit is set (0x8005820C). */
export const PLUS_ACCOMP_EXTRA_TRACK = 4;

/**
 * The four bar-header fields, named from 0x80058130 and the clamps at
 * 0x800580C4. The three pattern fields pick a backing pattern out of the ROM;
 * the fourth is a transpose added to every ROM note (0x80058270).
 *
 * The clamps replace an out-of-range value with 0 rather than saturating:
 * patternA >= 9 (0x800580CC), patternB >= 4 (0x800580E4) and patternC >= 10
 * (0x800580FC) all read as 0. patternB's is dead code — the field is only two
 * bits — and no save in the local corpus trips any of the three. patternC is
 * then halved (0x80058198) to index the ROM, with its low bit left over as the
 * gate on track 4.
 */
export function plusBarAccompaniment(head) {
    const [a, b, c, key] = head;
    const patternA = a < 9 ? a : 0;
    const patternB = b < 4 ? b : 0;
    const patternC = c < 10 ? c : 0;
    return {
        patternA,
        patternB,
        patternC: patternC >> 1,
        extraTrack: (patternC & 1) === 1,
        transpose: key, // 0..15, added to every ROM note of tracks 0..4
        romOffset: patternA * PLUS_ACCOMP_ROM.patternAStride +
            patternB * PLUS_ACCOMP_ROM.patternBStride +
            (patternC >> 1) * PLUS_ACCOMP_ROM.patternCStride,
    };
}

/**
 * The three per-track u32 tables the octave fold reads, at 0x800F0504,
 * 0x800F0518 and 0x800F052C — five entries each, one per pitched track, laid
 * end to end in that order.
 */
export const PLUS_ACCOMP_FOLD_LO = Object.freeze([56, 32, 44, 44, 15]);
export const PLUS_ACCOMP_FOLD_MID = Object.freeze([81, 57, 69, 69, 255]);
export const PLUS_ACCOMP_FOLD_HI = Object.freeze([92, 68, 80, 80, 255]);

/**
 * After the transpose, a backing note is folded down an octave under one of two
 * conditions. This is the branch sequence at 0x80058278-0x800582D8, in its own
 * order, and it is deliberately NOT tidied into a range test — the two clauses
 * overlap differently from how a single "fold into [LO, MID]" rule would:
 *
 *   0x8005828C  sltu HI[t], note      -> if note > HI[t], note -= 12   (done)
 *   0x800582AC  sltu LO[t], note      -> if note <= LO[t], unchanged
 *   0x800582CC  sltu note, MID[t]     -> if note >= MID[t], unchanged
 *                                        otherwise note -= 12
 *
 * so: `note > HI` folds; else `LO < note < MID` folds; else nothing. Both
 * comparisons are unsigned, both bounds are exclusive, and the subtraction
 * happens at most once — a note far above HI is not folded repeatedly.
 *
 * Track 4's row is LO=15, MID=255, HI=255, which by that rule folds every note
 * above 15 down an octave unconditionally.
 *
 * TRACKS 5..7 NEVER REACH HERE, and the guard for them THROWS rather than
 * returning the note unchanged. 0x80058258's `slti s3, 5` jumps to 0x800582DC,
 * past the transpose at 0x80058270 and past the whole fold, so for those three
 * tracks "the folded note" is not a thing the game ever computes — a caller
 * asking for one has the track wrong, and silently handing back the input
 * would hide that. The guard also has to be explicit because the three tables
 * are five-entry and laid END TO END at 0x800F0504 / 0x800F0518 / 0x800F052C:
 * the hardware read for track 5 would walk off LO into MID and get LO[5] = 81,
 * so "unchanged" is not what dropping the guard would even mean.
 */
export function plusFoldAccompanimentNote(note, track) {
    if (track >= PLUS_ACCOMP_PITCHED_TRACKS) {
        throw new RangeError(
            `track ${track} is not pitched: 0x80058258 skips the transpose and the fold for tracks ${PLUS_ACCOMP_PITCHED_TRACKS}..${
                PLUS_ACCOMP_TRACKS - 1
            }`,
        );
    }
    if (note > PLUS_ACCOMP_FOLD_HI[track]) return note - 12;
    if (note > PLUS_ACCOMP_FOLD_LO[track] && note < PLUS_ACCOMP_FOLD_MID[track]) return note - 12;
    return note;
}

// --- turning a decoded song into events --------------------------------------

/**
 * One melody voice as note events. There is no duration field anywhere in the
 * format: a note rings until the next note byte, the next REST or the end of
 * the song, and TIE steps are what extend it — 0x80057F18 simply skips the
 * step, leaving whatever is sounding alone.
 *
 * @param {{bars: object[]}} song  a decodePlusSong() result
 * @param {number} voice  0 or 1
 */
export function plusVoiceEvents(song, voice) {
    const out = [];
    const total = PLUS_SONG_BARS * PLUS_SONG_STEPS;
    let open = null;
    const close = (at) => {
        if (open) {
            open.durationSteps = at - open.step;
            out.push(open);
            open = null;
        }
    };
    for (let i = 0; i < total; i++) {
        const cell = song.bars[i >> 4].voices[voice][i & 15];
        if (cell.note === PLUS_NOTE_TIE) continue;
        close(i);
        if (cell.note === PLUS_NOTE_REST) continue;
        const midi = plusNoteToMidi(cell.note);
        open = {
            step: i,
            bar: i >> 4,
            stepInBar: i & 15,
            noteByte: cell.note,
            midi,
            name: midi === null ? null : plusNoteName(midi),
            instrument: cell.instrument,
            program: plusVoiceProgram(cell.instrument, voice),
            durationSteps: 0,
        };
    }
    close(total);
    return out;
}

// --- reading a save ----------------------------------------------------------

/**
 * The sixteen songs of a Dezaemon+ save block, decoded. plus.js's
 * decodePlusSound() hands back the same sixteen slots as raw views; this is the
 * same walk with the bit stream unpacked. Which song plays where is the BGM
 * assignment table, also plus.js's — decodePlusGlobals().bgm.
 *
 * @param {Uint8Array} block  a 0x1E000-byte Dezaemon+ save block
 */
export function decodePlusSongs(block) {
    const songs = [];
    for (let i = 0; i < PLUS_SONG_COUNT; i++) {
        const at = PLUS_SOUND_OFFSET + i * PLUS_SONG_SIZE;
        songs.push({ index: i, offset: at, ...decodePlusSong(block, at) });
    }
    return songs;
}
