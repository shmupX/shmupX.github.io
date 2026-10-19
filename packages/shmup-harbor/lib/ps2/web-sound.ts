// AthenaEnv's `Sound` module for the browser build, over WebAudio.
//
// main.js talks to audsrv through runtime-sound.ts, which uses exactly four
// things: `Sound.setVolume`, `Sound.findChannel`, `Sound.Sfx(path)` for the
// ADPCM one-shots (and their `playing(channel)`, which holds one effect to a
// few voices) and `Sound.Stream(path)` for the WAV music. This answers
// those from the build's own files — the `.adp` effects are decoded with the
// SPU2 decoder in ./adpcm.ts, the music by the browser — so the page plays
// what the disc carries, not a set of web twins.
//
// Two things make it differ from audsrv, both on purpose:
//
//   * `Sfx(path)` must hand back an effect synchronously, but fetching and
//     decoding are not. lib/ps2/web-host.ts therefore decodes the effects up
//     front (`preload`), before main.js runs, and anything else is decoded on
//     first use — a play that arrives before its decode is dropped, the way a
//     voice the IOP had no room for is.
//   * Browsers keep an AudioContext suspended until the page is touched. Every
//     play still happens (and is logged); it is simply inaudible until then.
//
// A silent build never gets here: runtime-sound.ts sees the preamble's
// `__PS2_AUDSRV__ = false` and never touches `Sound`, and the host builds no
// AudioContext for a build with no audio files.

import { decodeAdp, type DecodedAdp } from "./adpcm.ts";

/** One `Sound.Sfx` / `Sound.Stream` request, for the bot and the debug HUD. */
export interface SoundEvent {
  /** The effect's or track's name: the file's basename, no extension. */
  key: string;
  path: string;
  kind: "sfx" | "stream";
  /**
   * Whether it reached the speakers: false when the effect had not decoded
   * yet, or the browser still held the AudioContext suspended.
   */
  audible: boolean;
  /** `performance.now()` when it was asked for. */
  at: number;
}

/** AthenaEnv's `Sound.Sfx` object. */
export interface WebSfx {
  volume: number;
  pan: number;
  pitch: number;
  play(channel?: number): number;
  playing(channel?: number): boolean;
  free(): void;
}

/** AthenaEnv's `Sound.Stream` object. */
export interface WebStream {
  volume: number;
  loop: boolean;
  readonly position: number;
  readonly length: number;
  play(): void;
  pause(): void;
  playing(): boolean;
  rewind(): void;
  free(): void;
}

/** AthenaEnv's `Sound` module, as much of it as main.js reaches for. */
export interface WebSoundModule {
  setVolume(volume: number): void;
  findChannel(): number;
  Sfx(path: string): WebSfx;
  Stream(path: string): WebStream;
}

export interface WebSound {
  /** Installed as the `Sound` global. */
  module: WebSoundModule;
  /** Decode these effects now, so the first `Sfx` of each can play. */
  preload(paths: readonly string[]): Promise<void>;
  /** Every request so far, newest last (capped). */
  readonly log: readonly SoundEvent[];
  /** The AudioContext's state, or "none" for a silent page. */
  readonly state: AudioContextState | "none";
  /** Try to leave the browser's autoplay suspension. */
  resume(): void;
}

export interface WebSoundOptions {
  /** null: keep every request (and the log) but make no sound. */
  context: AudioContext | null;
  /** A build file's bytes, or null when the build does not carry it. */
  load: (path: string) => Promise<Uint8Array | null>;
  /** Called with each request as it is logged. */
  onEvent?: (event: SoundEvent) => void;
  /** How many requests the log keeps. */
  logLimit?: number;
}

/**
 * audsrv has 24 voices. findChannel hands out the lowest one not sounding, and
 * a play on one that is sounding is refused, as on a console.
 */
export const AUDSRV_CHANNELS = 24;

/** The name runtime-sound.ts knows an effect by: the basename, no extension. */
export function soundKey(path: string): string {
  return path.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
}

/** audsrv's 0-100 as a gain. */
export function audsrvGain(volume: number): number {
  return Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
}

/** AthenaEnv's -100..100 pan as a StereoPanner's -1..1. */
export function audsrvPan(pan: number): number {
  return Math.max(-100, Math.min(100, Number(pan) || 0)) / 100;
}

/** Decoded ADPCM as an AudioBuffer, loop points included. */
function toBuffer(
  context: AudioContext,
  decoded: DecodedAdp,
): { buffer: AudioBuffer; loop: boolean; loopStart: number } {
  const rate = Math.round(decoded.rate);
  const buffer = context.createBuffer(1, Math.max(1, decoded.pcm.length), rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < decoded.pcm.length; i++) {
    channel[i] = decoded.pcm[i] / 32768;
  }
  return {
    buffer,
    loop: decoded.loop,
    loopStart: decoded.loopStartSample / rate,
  };
}

export function createWebSound(options: WebSoundOptions): WebSound {
  const { context, load } = options;
  const limit = options.logLimit ?? 64;
  const log: SoundEvent[] = [];
  const master = context ? context.createGain() : null;
  if (context && master) master.connect(context.destination);

  const note = (path: string, kind: SoundEvent["kind"], playable: boolean) => {
    const event: SoundEvent = {
      key: soundKey(path),
      path,
      kind,
      audible: playable && context?.state === "running",
      at: typeof performance !== "undefined" ? performance.now() : Date.now(),
    };
    log.push(event);
    if (log.length > limit) log.splice(0, log.length - limit);
    options.onEvent?.(event);
  };

  const resume = () => {
    if (context && context.state === "suspended") {
      context.resume().catch(() => {});
    }
  };

  // Effects decode once and are shared by every Sfx made from the same path.
  type Effect = { buffer: AudioBuffer; loop: boolean; loopStart: number };
  const effects = new Map<string, Effect>();
  const decoding = new Map<string, Promise<void>>();
  const decodeEffect = (path: string): Promise<void> => {
    if (!context) return Promise.resolve();
    let pending = decoding.get(path);
    if (!pending) {
      pending = load(path).then((bytes) => {
        if (bytes) effects.set(path, toBuffer(context, decodeAdp(bytes)));
      }).catch((error) => {
        console.warn(`[ps2 sound] ${path}: ${(error as Error).message}`);
      });
      decoding.set(path, pending);
    }
    return pending;
  };

  // audsrv's 24 voices: the effect each is sounding, or null. A channel is
  // busy until its sample ends, as the SPU2's ENDX bit says on a console.
  const voices: ({ owner: WebSfx; source: AudioBufferSourceNode } | null)[] =
    new Array(AUDSRV_CHANNELS).fill(null);

  const module: WebSoundModule = {
    setVolume(volume) {
      if (master) master.gain.value = audsrvGain(volume);
    },

    // AthenaEnv's sound_sfx_find_channel: the lowest channel not sounding,
    // and -1 when none is.
    findChannel() {
      return voices.indexOf(null);
    },

    Sfx(path) {
      void decodeEffect(path);
      const live = new Set<AudioBufferSourceNode>();
      const sfx: WebSfx = {
        volume: 100,
        pan: 0,
        pitch: 0,
        play(channel = -1) {
          const ch = channel >= 0 && channel < AUDSRV_CHANNELS
            ? channel
            : module.findChannel();
          const effect = effects.get(path);
          // audsrv_ch_play_adpcm refuses a channel that is still sounding.
          const free = ch >= 0 && voices[ch] === null;
          note(path, "sfx", !!(context && master && effect) && free);
          if (!free || !context || !master || !effect) return ch;
          resume();
          const source = context.createBufferSource();
          source.buffer = effect.buffer;
          if (effect.loop) {
            source.loop = true;
            source.loopStart = effect.loopStart;
            source.loopEnd = effect.buffer.duration;
          }
          const gain = context.createGain();
          gain.gain.value = audsrvGain(sfx.volume);
          const panner = context.createStereoPanner();
          panner.pan.value = audsrvPan(sfx.pan);
          source.connect(gain).connect(panner).connect(master);
          const ended = () => {
            live.delete(source);
            if (voices[ch]?.source === source) voices[ch] = null;
          };
          source.onended = ended;
          live.add(source);
          voices[ch] = { owner: sfx, source };
          source.start();
          return ch;
        },
        // audsrv_is_adpcm_playing: this effect, still sounding on `channel`.
        // With no channel, whether it is sounding anywhere.
        playing(channel?: number) {
          if (channel === undefined) return live.size > 0;
          return voices[channel]?.owner === sfx;
        },
        free() {
          for (const source of live) {
            try {
              source.stop();
            } catch {
              // Already ended.
            }
          }
          live.clear();
          for (let ch = 0; ch < AUDSRV_CHANNELS; ch++) {
            if (voices[ch]?.owner === sfx) voices[ch] = null;
          }
        },
      };
      return sfx;
    },

    Stream(path) {
      // A track is a live decoder on a console and one at a time here too:
      // fetched and decoded when first played, dropped by free().
      let buffer: AudioBuffer | null = null;
      let loading: Promise<void> | null = null;
      let source: AudioBufferSourceNode | null = null;
      let gain: GainNode | null = null;
      let volume = 100;
      let wanted = false;
      let freed = false;
      let offset = 0; // seconds into the track when not running
      let startedAt = 0; // context time the running source began at `offset`

      const position = () =>
        source && context ? offset + (context.currentTime - startedAt) : offset;

      const stopSource = () => {
        if (!source) return;
        const going = source;
        source = null;
        going.onended = null;
        try {
          going.stop();
        } catch {
          // Never started, or already ended.
        }
      };

      const start = () => {
        if (!context || !master || !buffer || freed) return;
        stopSource();
        if (offset >= buffer.duration) offset = 0;
        gain = context.createGain();
        gain.gain.value = audsrvGain(volume);
        const next = context.createBufferSource();
        next.buffer = buffer;
        next.loop = stream.loop;
        next.connect(gain).connect(master);
        next.onended = () => {
          if (source !== next) return;
          source = null;
          offset = buffer ? buffer.duration : 0;
        };
        source = next;
        startedAt = context.currentTime;
        next.start(0, offset);
      };

      const fetchTrack = () => {
        if (!context || loading) return;
        loading = load(path).then(async (bytes) => {
          if (!bytes || freed) return;
          // decodeAudioData detaches what it is given; hand it a copy.
          buffer = await context.decodeAudioData(bytes.slice().buffer);
          if (wanted) start();
        }).catch((error) => {
          console.warn(`[ps2 sound] ${path}: ${(error as Error).message}`);
        });
      };

      const stream: WebStream = {
        get volume() {
          return volume;
        },
        set volume(v: number) {
          volume = v;
          if (gain) gain.gain.value = audsrvGain(v);
        },
        loop: false,
        get position() {
          return Math.round(position() * 1000);
        },
        get length() {
          return buffer ? Math.round(buffer.duration * 1000) : 0;
        },
        play() {
          note(path, "stream", !!(context && master));
          wanted = true;
          resume();
          if (buffer) start();
          else fetchTrack();
        },
        pause() {
          wanted = false;
          offset = position();
          stopSource();
        },
        playing() {
          return source !== null;
        },
        rewind() {
          offset = 0;
          if (source) start();
        },
        free() {
          freed = true;
          wanted = false;
          stopSource();
          buffer = null;
        },
      };
      return stream;
    },
  };

  return {
    module,
    preload: async (paths) => {
      await Promise.all(paths.map(decodeEffect));
    },
    log,
    get state() {
      return context ? context.state : "none";
    },
    resume,
  };
}
