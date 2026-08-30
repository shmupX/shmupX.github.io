// Cut real Saturn timbres out of SNDPAC.BIN.
//
// The tone bank map (src/audio/tone-bank-table.js, extracted from the retail
// binaries) says where every instrument's PCM lives inside SNDPAC.BIN, how it
// loops, and what note it was sampled at. SNDPAC.BIN itself is disc content
// and is not in this repo: the caller hands it in, from a Dezaemon 2 disc
// image via src/cd/iso9660-read.js or from a file on disk.
//
// Sample formats, both confirmed against the retail bank by measuring the mean
// absolute first difference of each decode (a wrong endianness turns a smooth
// waveform into noise, 4-8x the step size):
//
//   format 16  signed 16-bit BIG-endian  (SH-2/68000 side is big-endian)
//   format  8  signed 8-bit
//
// Everything is normalised to Int16 here, which is lossless for both (8-bit
// scales by 256) and is what both consumers want: Web Audio divides it to
// floats, the PS2 ADPCM encoder takes it as-is.
//
// LOOPS. The SCSP has four loop modes and the bank uses all of them, but every
// looping layer in all 590 of them loops to the LAST sample — there is no
// mid-sample loop end (asserted by scripts/build-tone-bank-table.ts). So a
// loop is always the tail [loopStart, lengthSamples). The reverse and
// alternating modes are baked into the returned PCM here, so every consumer
// downstream only ever has to implement a plain forward loop.
//
// Environment-neutral ESM (Deno + browser).

import {
    INSTRUMENT,
    INSTRUMENT_FIELDS,
    LAYER,
    LAYER_FIELDS,
    TONE_INSTRUMENTS,
    TONE_LAYERS,
} from "./tone-bank-table.js";

/**
 * Rate a bank sample plays back at when it is sounding its own rootPitch —
 * i.e. the rate that makes `playbackRate` of 1.0 correct.
 *
 * MEASURED, not assumed. A looped instrument sample is built so its loop is a
 * whole number of pitch periods, so for base rate R the cycle count
 *
 *     k = loopLength * 440 * 2^((rootPitch - 88) / 12) / R
 *
 * has to come out an integer for every layer (88 is the scale note that sounds
 * concert A — the anchor the runtime's own BGM has always used). Fitting R over
 * the 34 distinct short loops in the bank lands on 14,842 Hz, where 31 of them
 * are a whole number of cycles within 2% and the residuals are unbiased; the
 * shortest loops come out at exactly one cycle, which is what fixes the octave
 * the fit is otherwise blind to. 44,100 scores ZERO of 34 and would play every
 * sampled note about 18.9 semitones sharp of the periodic-wave voices the
 * runtime plays today.
 *
 * 14,848 is 29*512, within 0.04% of the fit and the value used here. Note this
 * is a calibration of the bank against the sequencer's note scale, not a claim
 * about the SCSP's DAC clock: what it guarantees is that a sampled note and the
 * analysed periodic-wave voice for the same instrument sound the same pitch.
 */
export const SCSP_BASE_RATE = 14848;

export const INSTRUMENT_COUNT = TONE_INSTRUMENTS.length / INSTRUMENT_FIELDS;
export const LAYER_COUNT = TONE_LAYERS.length / LAYER_FIELDS;

// SCSP LPCTL.
export const LOOP_OFF = 0;
export const LOOP_FORWARD = 1;
export const LOOP_REVERSE = 2;
export const LOOP_ALTERNATE = 3;

function field(index, key) {
    return TONE_LAYERS[index * LAYER_FIELDS + key];
}

/** One layer as a plain object. `index` is its position in the flat table. */
export function layerAt(index) {
    if (!(index >= 0 && index < LAYER_COUNT)) return null;
    return {
        index,
        noteLo: field(index, LAYER.NOTE_LO),
        noteHi: field(index, LAYER.NOTE_HI),
        offset: field(index, LAYER.OFFSET),
        format: field(index, LAYER.FORMAT),
        lengthSamples: field(index, LAYER.LENGTH_SAMPLES),
        loopMode: field(index, LAYER.LOOP_MODE),
        loopStart: field(index, LAYER.LOOP_START),
        rootPitch: field(index, LAYER.ROOT_PITCH),
        fineTune: field(index, LAYER.FINE_TUNE),
        level: field(index, LAYER.LEVEL),
        pan: field(index, LAYER.PAN),
        velCurve: field(index, LAYER.VEL_CURVE),
        eg: {
            AR: field(index, LAYER.EG_AR),
            D1R: field(index, LAYER.EG_D1R),
            D2R: field(index, LAYER.EG_D2R),
            RR: field(index, LAYER.EG_RR),
            DL: field(index, LAYER.EG_DL),
            KRS: field(index, LAYER.EG_KRS),
            EGHOLD: field(index, LAYER.EG_EGHOLD),
            LPSLNK: field(index, LAYER.EG_LPSLNK),
        },
    };
}

/** `{ flags, volAdj, firstLayer, layerCount }` for one instrument number. */
export function instrumentAt(instrument) {
    const i = instrument | 0;
    if (!(i >= 0 && i < INSTRUMENT_COUNT)) return null;
    const base = i * INSTRUMENT_FIELDS;
    return {
        instrument: i,
        flags: TONE_INSTRUMENTS[base + INSTRUMENT.FLAGS],
        volAdj: TONE_INSTRUMENTS[base + INSTRUMENT.VOL_ADJ],
        firstLayer: TONE_INSTRUMENTS[base + INSTRUMENT.FIRST_LAYER],
        layerCount: TONE_INSTRUMENTS[base + INSTRUMENT.LAYER_COUNT],
    };
}

/**
 * EVERY layer of `instrument` whose note range contains `note` — a note-on
 * strikes all of them, which is how the detune/chorus pairs (two layers over
 * one range with opposite fineTune) get their beating. Falls back to the
 * instrument's first layer if the note lands outside every range, so a note
 * always sounds.
 */
export function pickLayers(instrument, note) {
    const inst = instrumentAt(instrument);
    if (!inst || !inst.layerCount) return [];
    const hits = [];
    for (let k = 0; k < inst.layerCount; k++) {
        const index = inst.firstLayer + k;
        if (
            note >= field(index, LAYER.NOTE_LO) &&
            note <= field(index, LAYER.NOTE_HI)
        ) {
            hits.push(layerAt(index));
        }
    }
    return hits.length ? hits : [layerAt(inst.firstLayer)];
}

/**
 * Sounding rate multiplier for a layer at a note, in the driver's own note
 * scale (composed parts add 54 to their pitch-column byte before calling).
 */
export function playbackRate(layer, note, transpose = 0) {
    const semis = note - layer.rootPitch + layer.fineTune / 256 + transpose;
    return Math.pow(2, semis / 12);
}

/** Attenuation `level` (~0.375 dB/step) as a linear gain in (0, 1]. */
export function levelGain(level) {
    return Math.pow(10, -level * 0.375 / 20);
}

/** SCSP pan byte to a -1..1 stereo position. */
export function panPosition(pan) {
    // 0x00-0x1F pans right, 0x10-0x1F is the left half of the register's
    // two-sided encoding; the bank only ever uses a handful of values and the
    // driver treats the high bit as "left".
    const side = pan & 0x0f;
    return (pan & 0x10 ? -side : side) / 15;
}

function readPcm(sndpac, layer) {
    const { offset, format, lengthSamples } = layer;
    const bytes = format === 16 ? lengthSamples * 2 : lengthSamples;
    if (offset < 0 || offset + bytes > sndpac.length) return null;
    const out = new Int16Array(lengthSamples);
    if (format === 16) {
        // Big-endian: high byte first.
        for (let i = 0; i < lengthSamples; i++) {
            const at = offset + i * 2;
            out[i] = (sndpac[at] << 8) | sndpac[at + 1];
        }
    } else {
        for (let i = 0; i < lengthSamples; i++) {
            out[i] = ((sndpac[offset + i] << 24) >> 24) * 256;
        }
    }
    return out;
}

/**
 * Cut one layer's PCM out of a SNDPAC.BIN image, with its loop baked into a
 * plain forward loop. Returns null when the layer points outside the bank
 * (a truncated or wrong file) rather than throwing, so a caller can skip it.
 *
 *   { pcm, sampleRate, loop, loopStart, loopEnd, ...layer fields }
 *
 * `loopEnd` is exclusive and always equals `pcm.length` — the whole tail loops.
 */
export function cutLayer(sndpac, layer) {
    const raw = readPcm(sndpac, layer);
    if (!raw) return null;

    const len = layer.lengthSamples;
    const mode = layer.loopMode;
    const start = Math.min(Math.max(layer.loopStart | 0, 0), len);
    let pcm = raw;
    let loopStart = start;

    if (mode === LOOP_REVERSE) {
        // The SCSP walks the loop region backwards forever. Reversing it once
        // turns that into an ordinary forward loop.
        pcm = Int16Array.from(raw);
        for (let a = start, b = len - 1; a < b; a++, b--) {
            const t = pcm[a];
            pcm[a] = pcm[b];
            pcm[b] = t;
        }
    } else if (mode === LOOP_ALTERNATE && len - start >= 3) {
        // Ping-pong: append the loop region mirrored, minus both endpoints so
        // neither is played twice per cycle, and loop the doubled span.
        const mirror = len - start - 2;
        pcm = new Int16Array(len + mirror);
        pcm.set(raw, 0);
        for (let i = 0; i < mirror; i++) pcm[len + i] = raw[len - 2 - i];
    }

    return {
        pcm,
        sampleRate: SCSP_BASE_RATE,
        loop: mode !== LOOP_OFF,
        loopStart: mode === LOOP_OFF ? 0 : loopStart,
        loopEnd: pcm.length,
        loopMode: mode,
        rootPitch: layer.rootPitch,
        fineTune: layer.fineTune,
        level: layer.level,
        pan: layer.pan,
        velCurve: layer.velCurve,
        eg: layer.eg,
    };
}

/** Int16 PCM as Float32 in [-1, 1), for Web Audio. */
export function toFloat32(pcm) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
}

/**
 * The distinct sample cuts the whole bank needs — 590 layers share far fewer
 * slices. Keyed by everything that changes the bytes, so an offline renderer
 * writes each file once and the layers point at it.
 *
 * Returns `[{ key, layerIndexes, offset, format, lengthSamples, loopMode,
 * loopStart }]` in first-use order.
 */
export function uniqueSlices() {
    const byKey = new Map();
    for (let index = 0; index < LAYER_COUNT; index++) {
        const l = layerAt(index);
        const key = `${l.offset}:${l.lengthSamples}:${l.format}:${l.loopMode}:${l.loopStart}`;
        let slice = byKey.get(key);
        if (!slice) {
            slice = {
                key,
                layerIndexes: [],
                offset: l.offset,
                format: l.format,
                lengthSamples: l.lengthSamples,
                loopMode: l.loopMode,
                loopStart: l.loopStart,
            };
            byKey.set(key, slice);
        }
        slice.layerIndexes.push(index);
    }
    return [...byKey.values()];
}
