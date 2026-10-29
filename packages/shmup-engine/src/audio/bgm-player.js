// Playing a 音まろ song slot in Web Audio, the way the game plays it.
//
// A port of game.bundle.js's song player — dezaVoice (:7539), the tone-bank
// sample path (dezaSampleBuffer :7709, dezaSamples :7725), applyBgmEcho
// (:7794), scheduleBgm (:7911) and playBgmNote (:8023) — with the same names,
// constants and envelope, so the editor's MUSIC mode sounds like the stage
// (tests/music_player_parity_test.ts holds the per-note node graphs equal).
// What the runtime does not need and the editor does is added around it, not
// inside it: an AudioContext handed in instead of a Phaser scene, a song that
// can be swapped while it plays without losing its place, per-part mute and
// solo, a looping region, single-note and one-measure auditions, and an
// offline render.
//
// The real Saturn samples come from the published web tone bank (see
// TONE_BANK_PATH and packages/shmup-harbor/lib/sndpac.ts buildWebToneBank).
// Until it has loaded — or wherever it cannot be — every instrument plays its
// analysed periodic wave (bgm-tables.js BGM_VOICE_ROWS), exactly as the
// runtime falls back.
//
// Environment-neutral ESM; needs a Web Audio context only when it plays.

import { ACCOMP_DELAY, accompStreams, songStreams } from "./song-streams.js";
import { BGM_VOICE_ROWS } from "./bgm-tables.js";

export const TONE_BANK_PATH = "/games/2028-ai/assets/tone-bank/";
export const BGM_LOOKAHEAD = 0.35;
export const BGM_TICK_MS = 90;
export const BGM_GAIN = 0.1;
export const DEZA_NOTE_A = 88;
/** The kernel pans composed parts 3 and 4 only, at 55 and 72 of 127. */
export const PART_VOICES = Object.freeze([
    Object.freeze({ gain: 1, pan: 0 }),
    Object.freeze({ gain: 0.8, pan: 0 }),
    Object.freeze({ gain: 1.2, pan: (55 - 64) / 64 }),
    Object.freeze({ gain: 0.5, pan: (72 - 64) / 64 }),
]);
export const ACCOMP_VOICE = Object.freeze({ gain: 0.85, pan: 0 });
/** Streams the mixer can mute: the four parts, then the whole accompaniment. */
export const MIX_STREAMS = 5;

export function dezaNoteFreq(scaleNote) {
    return 440 * Math.pow(2, (scaleNote - DEZA_NOTE_A) / 12);
}

/**
 * The published bank: `{sampleRate, slices, instruments, pcm: Int16Array}`,
 * or null when it is not there. `bases` are tried in order.
 */
export async function loadToneBank(bases = [TONE_BANK_PATH], fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") return null;
    for (const base of Array.isArray(bases) ? bases : [bases]) {
        try {
            const [index, pcm] = await Promise.all([
                fetchImpl(base + "tone-bank.json").then((r) => (r.ok ? r.json() : null)),
                fetchImpl(base + "tone-bank.pcm").then((r) => (r.ok ? r.arrayBuffer() : null)),
            ]);
            if (index && pcm && Array.isArray(index.slices) && Array.isArray(index.instruments)) {
                return { ...index, pcm: new Int16Array(pcm) };
            }
        } catch {
            // try the next base
        }
    }
    return null;
}

// ---- the runtime's voice machinery, kept to its shape ----------------------

// One tone-bank voice for a given instrument AND note, built lazily.
function dezaVoice(st, instrument, note) {
    let idx = instrument | 0;
    if (idx < 0 || idx >= BGM_VOICE_ROWS.length) idx = 0;
    const layers = BGM_VOICE_ROWS[idx];
    if (!layers || !layers.length) return null;
    let li = 0;
    for (let k = 0; k < layers.length; k++) {
        if (note >= layers[k][0] && note <= layers[k][1]) {
            li = k;
            break;
        }
    }
    const cache = st.voices || (st.voices = {});
    const ck = idx + ":" + li;
    if (cache[ck]) return cache[ck];
    const L = layers[li];
    const harm = L.slice(8);
    const voice = {
        level: L[2],
        attack: L[3],
        decay: L[4],
        sustain: L[5],
        release: L[6],
        noise: L[7],
        wave: null,
    };
    if (voice.noise < 0.75) {
        const n = harm.length + 1;
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let h = 0; h < harm.length; h++) imag[h + 1] = harm[h] / 255;
        try {
            voice.wave = st.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
        } catch {
            voice.wave = null;
        }
    }
    cache[ck] = voice;
    return voice;
}

// One slice as an AudioBuffer, cached across every instrument using it. The
// buffer keeps the bank's own rate (14,848 Hz); Web Audio folds that into
// playbackRate. Older WebKit refuses a buffer below 22,050 Hz, so there the
// slice is doubled once (linear) and created at twice the rate.
function dezaSampleBuffer(st, sliceIndex) {
    const cache = st.buffers || (st.buffers = {});
    if (cache[sliceIndex]) return cache[sliceIndex];
    const bank = st.bank;
    const slice = bank.slices[sliceIndex];
    let buf;
    try {
        buf = st.ctx.createBuffer(1, slice.samples, bank.sampleRate);
        const out = buf.getChannelData(0);
        for (let i = 0; i < slice.samples; i++) out[i] = bank.pcm[slice.at + i] / 32768;
    } catch {
        buf = st.ctx.createBuffer(1, slice.samples * 2, bank.sampleRate * 2);
        const out = buf.getChannelData(0);
        for (let i = 0; i < slice.samples; i++) {
            const a = bank.pcm[slice.at + i] / 32768;
            const b = i + 1 < slice.samples ? bank.pcm[slice.at + i + 1] / 32768 : a;
            out[i * 2] = a;
            out[i * 2 + 1] = (a + b) / 2;
        }
    }
    cache[sliceIndex] = buf;
    return buf;
}

// The sample layers a note-on strikes: EVERY layer whose range contains the
// note (the bank's detune pairs), or the first when none does. Null with no
// bank — the caller then plays the periodic wave.
function dezaSamples(st, instrument, note) {
    const bank = st.bank;
    if (!bank) return null;
    const inst = bank.instruments[instrument | 0];
    if (!inst || !inst.layers.length) return null;
    const cache = st.samples || (st.samples = {});
    const key = instrument + ":" + note;
    if (cache[key] !== undefined) return cache[key];
    let hits = [];
    for (let i = 0; i < inst.layers.length; i++) {
        const l = inst.layers[i];
        if (note >= l.noteLo && note <= l.noteHi) hits.push(l);
    }
    if (!hits.length) hits = [inst.layers[0]];
    const voices = [];
    for (let h = 0; h < hits.length; h++) {
        const layer = hits[h];
        const slice = bank.slices[layer.slice];
        if (!slice) continue;
        voices.push({
            buffer: dezaSampleBuffer(st, layer.slice),
            loop: !!slice.loop,
            loopStart: slice.loopStart / bank.sampleRate,
            loopEnd: slice.samples / bank.sampleRate,
            rate: Math.pow(2, (note - layer.rootPitch + layer.fineTune / 256) / 12),
            level: layer.level,
        });
    }
    cache[key] = voices.length ? voices : null;
    return cache[key];
}

// The editor stops a song mid-note; the sources still sounding are kept here
// until they end on their own.
function trackLive(st, node) {
    if (!st.live) return;
    st.live.push(node);
    node.onended = () => {
        const i = st.live.indexOf(node);
        if (i >= 0) st.live.splice(i, 1);
    };
}

function makeNoiseBuffer(ctx) {
    const len = (ctx.sampleRate * 0.25) | 0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
}

// One note, as the runtime plays it. `mix` is a PART_VOICES/ACCOMP_VOICE
// entry plus the bus it lands on.
function playBgmNote(st, mix, e, t, scaleNote) {
    const ctx = st.ctx;
    const dur = Math.max(0.05, e.len * st.stepSeconds * 0.95);
    const inst = e.inst || 0;
    const v = dezaVoice(st, inst, scaleNote);
    if (!v) return;
    const samples = dezaSamples(st, inst, scaleNote);
    const g = ctx.createGain();
    let peak;
    if (samples) {
        peak = mix.gain * 0.5;
        g.gain.setValueAtTime(1e-4, t);
        g.gain.linearRampToValueAtTime(peak, t + 15e-4);
    } else {
        peak = mix.gain * 0.5 * Math.max(0.15, Math.pow(10, -v.level * 0.375 / 20));
        const atk = Math.min(v.attack, dur * 0.5);
        g.gain.setValueAtTime(1e-4, t);
        if (atk > 0.001) g.gain.linearRampToValueAtTime(peak, t + atk);
        else g.gain.setValueAtTime(peak, t + 0.001);
        const sus = Math.max(0.02, peak * v.sustain);
        if (v.decay < 4 && sus < peak) {
            g.gain.setTargetAtTime(sus, t + atk, Math.max(0.01, v.decay * 0.4));
        }
    }
    g.gain.setTargetAtTime(1e-4, t + dur, Math.max(0.02, v.release * 0.5));
    let out = g;
    if (ctx.createStereoPanner && mix.pan) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = mix.pan;
        g.connect(pan);
        out = pan;
    }
    out.connect(mix.bus || st.master);
    const stop = t + dur + Math.min(1.5, v.release * 2) + 0.05;
    if (samples) {
        const share = 1 / Math.sqrt(samples.length);
        for (let si = 0; si < samples.length; si++) {
            const s = samples[si];
            const lg = ctx.createGain();
            lg.gain.value = share * Math.max(0.15, Math.pow(10, -s.level * 0.375 / 20));
            lg.connect(g);
            const bsrc = ctx.createBufferSource();
            bsrc.buffer = s.buffer;
            bsrc.playbackRate.value = Math.max(0.03, Math.min(32, s.rate));
            if (s.loop) {
                bsrc.loop = true;
                bsrc.loopStart = s.loopStart;
                bsrc.loopEnd = s.loopEnd;
            }
            bsrc.connect(lg);
            bsrc.start(t);
            bsrc.stop(stop);
            trackLive(st, bsrc);
        }
    } else if (v.wave) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(v.wave);
        osc.frequency.value = dezaNoteFreq(scaleNote);
        osc.connect(g);
        osc.start(t);
        osc.stop(stop);
        trackLive(st, osc);
    } else {
        const src = ctx.createBufferSource();
        src.buffer = st.noise;
        src.playbackRate.value = Math.max(0.15, dezaNoteFreq(scaleNote) / 440);
        src.connect(g);
        src.start(t);
        src.stop(t + Math.min(dur + 0.1, 0.6));
        trackLive(st, src);
    }
}

/** The runtime's echo: one feedback delay tap whose wet level follows the slot's echo send. */
function applyBgmEcho(st) {
    const level = st.song ? st.song.echoLevel : 0;
    st.echoBase = 0.45 * (level / 7);
    if (!st.echo) {
        if (level <= 0) return;
        const ctx = st.ctx;
        const delay = ctx.createDelay(0.5);
        delay.delayTime.value = 0.18;
        const fb = ctx.createGain();
        fb.gain.value = 0.3;
        const wet = ctx.createGain();
        st.master.connect(delay);
        delay.connect(fb);
        fb.connect(delay);
        delay.connect(wet);
        wet.connect(st.destination);
        st.echo = wet;
    }
    st.echo.gain.value = st.echoBase * st.volume;
}

// ---- the editor's player ---------------------------------------------------

/**
 * Song position -> song step. Pass 0 plays from step 0 to the loop end; every
 * later pass plays the loop, as the runtime's scheduleBgm does. A region
 * (`[fromStep, toStep)`) loops that span instead.
 */
function stepAt(song, region, pos) {
    if (region) {
        const span = region[1] - region[0];
        return region[0] + (pos % span);
    }
    if (pos < song.loopEndStep) return pos;
    const span = song.loopEndStep - song.loopStartStep;
    return song.loopStartStep + ((pos - song.loopEndStep) % span);
}

function indexOnsets(song) {
    // byStep[step] = [[streamIndex, event], …] for the eleven streams: four
    // composed parts, then the seven accompaniment channels.
    const streams = song.parts.concat(song.accomp);
    const byStep = new Array(512);
    streams.forEach((events, p) => {
        for (const e of events) {
            if (e.step >= song.loopEndStep) continue; // never reached, as in the runtime
            (byStep[e.step] || (byStep[e.step] = [])).push([p, e]);
        }
    });
    return byStep;
}

/**
 * A player on a Web Audio context.
 *
 *   load(bytes)        the slot to play (again any time; a playing song keeps
 *                      its place and the next notes are the new bytes')
 *   play({fromStep, region: [m0, m1]})   from a step, optionally looping
 *                      measures m0..m1 instead of the song's own loop
 *   stop(), playing(), position() -> {step, pos} | null
 *   setMute(i, on), setSolo(i, on)       i = part 0-3, or 4 = accompaniment
 *   setBank(bank)      swap the samples in (or null for the periodic voices)
 *   audition(inst, pitch, {part, len})   one composed-part note, now
 *   auditionRhythm([c0,c1,c2,c3], stepSeconds)  one measure of accompaniment
 *   dispose()
 */
export function createBgmPlayer(ctx, options = {}) {
    const destination = options.destination || ctx.destination;
    const timers = options.timers || globalThis;
    const trace = typeof options.trace === "function" ? options.trace : null;
    const st = {
        ctx,
        bank: options.bank || null,
        destination,
        volume: options.volume ?? 1,
        master: ctx.createGain(),
        noise: makeNoiseBuffer(ctx),
        voices: {},
        buffers: {},
        samples: {},
        echo: null,
        song: null,
        stepSeconds: 0.1,
        live: [],
    };
    st.master.gain.value = BGM_GAIN * st.volume;
    st.master.connect(destination);
    const buses = [];
    for (let i = 0; i < MIX_STREAMS; i++) {
        const bus = ctx.createGain();
        bus.connect(st.master);
        buses.push(bus);
    }
    const mixes = [
        ...PART_VOICES.map((v, i) => ({ ...v, bus: buses[i] })),
        { ...ACCOMP_VOICE, bus: buses[4] },
    ];
    const muted = new Array(MIX_STREAMS).fill(false);
    const soloed = new Array(MIX_STREAMS).fill(false);
    let onsets = null;
    let run = null; // {startTime, nextPos, region, timer}

    function applyMix() {
        const anySolo = soloed.some(Boolean);
        buses.forEach((bus, i) => {
            bus.gain.value = muted[i] || (anySolo && !soloed[i]) ? 0 : 1;
        });
    }

    function schedule(until) {
        if (!run || !st.song) return;
        const song = st.song;
        for (;;) {
            const t = run.startTime + run.nextPos * st.stepSeconds;
            if (t > until) break;
            const step = stepAt(song, run.region, run.nextPos);
            const hits = onsets[step];
            if (hits && t >= ctx.currentTime - 0.02) {
                for (const [p, e] of hits) {
                    const mix = p < 4 ? mixes[p] : mixes[4];
                    const at = p < 4 ? t : t + ACCOMP_DELAY;
                    const scaleNote = p < 4 ? e.note + 54 : e.note;
                    if (trace) trace({ stream: p, t: at, scaleNote, e, mix });
                    playBgmNote(st, mix, e, at, scaleNote);
                }
            }
            run.nextPos++;
        }
    }

    function pump() {
        schedule(ctx.currentTime + BGM_LOOKAHEAD);
    }

    const player = {
        load(bytes) {
            const song = songStreams(bytes);
            if (run && st.song && song.stepSeconds !== st.stepSeconds) {
                // A tempo change while playing: keep the song position under
                // the playhead, so the beat continues from where it is.
                const pos = (ctx.currentTime - run.startTime) / st.stepSeconds;
                run.startTime = ctx.currentTime - pos * song.stepSeconds;
            }
            st.song = song;
            st.stepSeconds = song.stepSeconds;
            onsets = indexOnsets(song);
            applyBgmEcho(st);
            return player;
        },
        play({ fromStep = 0, region = null } = {}) {
            if (!st.song) throw new Error("bgm-player: load a song first");
            player.stop();
            const span = region ? [region[0] * 16, (region[1] + 1) * 16] : null;
            const start = span ? Math.max(span[0], Math.min(fromStep, span[1] - 1)) - span[0] : fromStep;
            run = {
                startTime: ctx.currentTime + 0.05 - start * st.stepSeconds,
                nextPos: start,
                region: span,
                timer: null,
            };
            pump();
            run.timer = timers.setInterval(pump, BGM_TICK_MS);
            return player;
        },
        stop() {
            if (!run) return player;
            timers.clearInterval(run.timer);
            run = null;
            const now = ctx.currentTime;
            for (const node of st.live.splice(0)) {
                try {
                    node.stop(now);
                } catch {
                    // already stopped
                }
            }
            return player;
        },
        playing() {
            return !!run;
        },
        position() {
            if (!run || !st.song) return null;
            const pos = Math.max(0, Math.floor((ctx.currentTime - run.startTime) / st.stepSeconds));
            return { pos, step: stepAt(st.song, run.region, pos) };
        },
        setMute(i, on) {
            muted[i] = !!on;
            applyMix();
            return player;
        },
        setSolo(i, on) {
            soloed[i] = !!on;
            applyMix();
            return player;
        },
        mix() {
            return { muted: muted.slice(), soloed: soloed.slice() };
        },
        setBank(bank) {
            st.bank = bank || null;
            st.buffers = {};
            st.samples = {};
            return player;
        },
        hasBank() {
            return !!st.bank;
        },
        audition(inst, pitch, { part = 0, len = 2, stepSeconds } = {}) {
            const prev = st.stepSeconds;
            if (stepSeconds) st.stepSeconds = stepSeconds;
            playBgmNote(st, mixes[part] || mixes[0], { step: 0, note: pitch, len, inst }, ctx.currentTime + 0.01, pitch + 54);
            st.stepSeconds = prev;
            return player;
        },
        auditionRhythm(ctrl, stepSeconds = st.stepSeconds) {
            const prev = st.stepSeconds;
            st.stepSeconds = stepSeconds;
            const t0 = ctx.currentTime + 0.05;
            accompStreams([ctrl]).forEach((events) => {
                for (const e of events) playBgmNote(st, mixes[4], e, t0 + e.step * stepSeconds + ACCOMP_DELAY, e.note);
            });
            st.stepSeconds = prev;
            return player;
        },
        setVolume(v) {
            st.volume = v;
            st.master.gain.value = BGM_GAIN * v;
            if (st.echo) st.echo.gain.value = st.echoBase * v;
            return player;
        },
        dispose() {
            player.stop();
            try {
                st.master.disconnect();
                if (st.echo) st.echo.disconnect();
            } catch {
                // already gone
            }
        },
        /** Schedule the whole run up to `seconds` at once (offline rendering). */
        renderAhead(seconds) {
            schedule(seconds);
            return player;
        },
    };
    applyMix();
    return player;
}

/**
 * Render a slot offline: `seconds` of it from step 0 through its loop, as an
 * AudioBuffer. `OfflineCtor` is OfflineAudioContext (or webkitOfflineAudioContext).
 */
export async function renderSongOffline(OfflineCtor, bytes, { seconds = 30, bank = null, sampleRate = 44100, region = null } = {}) {
    const ctx = new OfflineCtor(2, Math.ceil(seconds * sampleRate), sampleRate);
    const timers = { setInterval: () => 0, clearInterval: () => {} };
    const player = createBgmPlayer(ctx, { bank, timers });
    player.load(bytes).play({ region });
    player.renderAhead(seconds);
    return await ctx.startRendering();
}

/** The per-note functions, for tests/music_player_parity_test.ts to hold against the runtime's. */
export const __runtimePort = Object.freeze({ dezaVoice, dezaSamples, dezaSampleBuffer, playBgmNote, applyBgmEcho });
