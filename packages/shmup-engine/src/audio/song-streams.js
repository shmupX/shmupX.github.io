// A song slot as the note streams the runtime plays: the four composed parts
// and the seven auto-accompaniment channels.
//
// This is game.bundle.js's parseBgmSong (:7572) and buildAccompParts (:7507)
// over raw bytes instead of base64, kept to the same rules line for line so
// the editor hears what the game plays (tests/music_song_parity_test.ts lifts
// the bundle's functions and holds the two equal). A stream event is
// `{step 0-511, note, len, inst}`: a composed part's `note` is its pitch byte
// (driver scale = note + 54), an accompaniment channel's is already in the
// driver scale.
//
// Environment-neutral ESM (Node + browser).

import { MEASURES, STEPS_PER_MEASURE, TEMPO_TABLE, TRANSPOSE_TABLE } from "../decode/decode-song.js";
import { ACCOMP_TABLE_B64 } from "./bgm-tables.js";

export const ACCOMP_CHANNELS = 7;
/** Channels 0-3 of the accompaniment are pitched (three chord voices and a bass); 4-6 are drums. */
export const ACCOMP_PITCHED = 4;
/** Every accompaniment channel plays tone-bank instrument 60 + ctrl0. */
export const ACCOMP_INSTRUMENT_BASE = 60;
/** The kernel keys accompaniment two frames after the composed parts. */
export const ACCOMP_DELAY = 2 / 60;

let table = null;
function accompTable() {
    if (!table) table = Uint8Array.from(atob(ACCOMP_TABLE_B64), (c) => c.charCodeAt(0));
    return table;
}

/** The kernel pattern-table row a measure's control bytes select for one channel. */
export function accompRow(ctrl, channel) {
    return ctrl[0] * 140 + (ctrl[1] * 5 + ((ctrl[2] & 127) >> 1)) * 7 + channel;
}

/** One pattern row's 16 step bytes, or null when the row is off the table. */
export function accompSteps(row) {
    const tab = accompTable();
    if (row < 0 || row >= tab.length / 16) return null;
    return tab.subarray(row * 16, row * 16 + 16);
}

/** The seven accompaniment channels of a whole song (control = 32 x [4 bytes]). */
export function accompStreams(control) {
    const chans = [[], [], [], [], [], [], []];
    const tab = accompTable();
    const rows = (tab.length / 16) | 0;
    for (let m = 0; m < control.length; m++) {
        const c = control[m];
        const base = c[0] * 140 + (c[1] * 5 + ((c[2] & 127) >> 1)) * 7;
        const tr = TRANSPOSE_TABLE[c[3]] || 0;
        for (let ch = 0; ch < ACCOMP_CHANNELS; ch++) {
            const row = base + ch;
            if (row < 0 || row >= rows) continue;
            const at = row * 16;
            let cur = null;
            for (let st = 0; st < 16; st++) {
                const v = tab[at + st];
                const abs = m * 16 + st;
                if (v === 0) {
                    cur = null;
                } else if (v & 128) {
                    // A tie with nothing sounding is a no-op — which is how the
                    // editor's default control bytes come out silent.
                    if (cur) cur.len = abs - cur.step + 1;
                } else {
                    cur = { step: abs, note: v + (ch < ACCOMP_PITCHED ? tr : 0), len: 1, inst: ACCOMP_INSTRUMENT_BASE + c[0] };
                    chans[ch].push(cur);
                }
            }
        }
    }
    return chans;
}

/**
 * Everything the runtime's scheduler needs from one slot:
 * `{parts[4], control[32], accomp[7], loopStartStep, loopEndStep,
 *   stepSeconds, echoLevel}`.
 */
export function songStreams(raw) {
    const parts = [[], [], [], []];
    for (let p = 0; p < 4; p++) {
        const stream = parts[p];
        let current = null;
        for (let m = 0; m < MEASURES; m++) {
            const base = 4 + m * 132 + 4 + p * 32;
            for (let st = 0; st < STEPS_PER_MEASURE; st++) {
                const voice = raw[base + st];
                const pitch = raw[base + 16 + st];
                const abs = m * 16 + st;
                if (voice & 128) {
                    if (current) current.len = abs - current.step + 1;
                } else if (pitch >= 1 && pitch <= 59) {
                    current = { step: abs, note: pitch, len: 1, inst: voice & 127 };
                    stream.push(current);
                } else {
                    current = null;
                }
            }
        }
    }
    let loopStartStep = Math.min(raw[0], 31) * 16;
    let loopEndStep = (Math.min(raw[1], 31) + 1) * 16;
    if (loopEndStep <= loopStartStep) {
        loopStartStep = 0;
        loopEndStep = 32 * 16;
    }
    const control = [];
    for (let m = 0; m < MEASURES; m++) {
        const cb = 4 + m * 132;
        control.push([raw[cb], raw[cb + 1], raw[cb + 2], raw[cb + 3]]);
    }
    return {
        parts,
        control,
        accomp: accompStreams(control),
        loopStartStep,
        loopEndStep,
        stepSeconds: TEMPO_TABLE[raw[3] & 31] / 240,
        echoLevel: raw[2] & 7,
    };
}

/** True when anything — a composed note or the accompaniment — sounds before the loop end. */
export function isAudible(raw) {
    const s = songStreams(raw);
    return [...s.parts, ...s.accomp].some((stream) => stream.some((e) => e.step < s.loopEndStep));
}

/**
 * What one accompaniment choice plays over a measure, for the RHYTHM lane:
 * the seven rows' steps, whether it is silent, and which halves it has.
 */
export function describeAccomp(bank, pattern, chord) {
    const ctrl = [bank, pattern, chord << 1, 3];
    const rows = [];
    for (let ch = 0; ch < ACCOMP_CHANNELS; ch++) {
        const steps = accompSteps(accompRow(ctrl, ch));
        rows.push(steps ? [...steps] : null);
    }
    const sounding = (steps) => {
        if (!steps) return false;
        // A row sounds when it strikes a note (non-zero, bit 7 clear).
        return steps.some((v) => v !== 0 && (v & 128) === 0);
    };
    const pitched = rows.slice(0, ACCOMP_PITCHED).some(sounding);
    const drums = rows.slice(ACCOMP_PITCHED).some(sounding);
    return { rows, pitched, drums, silent: !pitched && !drums };
}
