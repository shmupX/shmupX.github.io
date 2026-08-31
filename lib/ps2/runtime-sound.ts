// The console-side sound backend. Runs under QuickJS, not Deno.
//
// `deno task build:ps2` bundles this into main.js along with runtime-entry.ts.
// It implements the ps2-sp port's SoundPlayer over AthenaEnv's `Sound` global,
// which is audsrv: PS2 ADPCM one-shots via `Sound.Sfx`, streamed music via
// `Sound.Stream`. The API is not documented anywhere — it is what AthenaEnv's
// own pong.js and sound.js sample scripts use, in the release tarball
// lib/ps2/athena.ts already downloads.
//
//   Sound.setVolume(100)            global, 0-100
//   const ch = Sound.findChannel()  a free one-shot channel
//   Sound.Sfx("x.adp").play(ch)     ADPCM only, and NO playback-rate control
//   Sound.Stream("x.wav")           play/pause/playing/rewind/free, position
//
// `Sound` exists only when athena.ini says `audsrv = true`, which lib/ps2/
// build.ts writes only when the export actually carries audio. Everything here
// degrades to silence rather than throwing: a build with no sound pack, an
// older AthenaEnv, or a single track that failed to encode all end up as a
// backend whose methods do nothing, which is exactly the port's default.
//
// STREAMS. Two things about `Sound.Stream` shape the code below.
//
// It does not loop. sound.js watches its own track and rewinds it, so a
// looping BGM needs somebody to look every frame — which is what `pump()` is
// for, and why runtime-entry.ts runs its own loop instead of the package's
// `runNativeLoop`.
//
// It is a live decoder, not a buffer: nine of them open at once is nine
// Vorbis decoders and their threads for the eight tracks nobody is playing.
// So `loadStream` only remembers the path, and the stream itself is built at
// `playBgm` and freed when the next one starts, exactly as sound.js does when
// it changes track.

/** The subset of AthenaEnv's `Sound` this uses. */
interface AthenaSfx {
  play(channel: number): void;
  volume?: number;
}

interface AthenaStream {
  play(): void;
  pause(): void;
  playing(): boolean;
  rewind(): void;
  free(): void;
  volume?: number;
}

interface AthenaSound {
  setVolume(volume: number): void;
  findChannel(): number;
  Sfx(path: string): AthenaSfx;
  Stream(path: string): AthenaStream;
}

/** QuickJS's std, which AthenaEnv publishes as a global. */
interface QuickJsStd {
  open(path: string, mode: string): { close(): void } | null;
}

/** The port's audio interface, restated so this file stands alone. */
export interface SoundPlayer {
  init(): void;
  loadSfx(key: string, path: string): void;
  loadStream(key: string, path: string): void;
  playSfx(key: string, volume?: number): void;
  playSound(key: string, volume?: number): void;
  playBgm(key: string, volume?: number): void;
  stopBgm(): void;
  stopAllSounds(): void;
}

/** What runtime-entry.ts drives once a frame. */
export interface PumpedSoundPlayer extends SoundPlayer {
  /** Restart a looping track that has run out. Cheap, and never throws. */
  pump(): void;
}

/**
 * Where the disc actually carries the effect the port just asked for.
 *
 * Two rewrites. The extension, because ADPCM is the only one-shot format the
 * SPU2 plays. And the directory: the port asks for things like
 * `assets/sounds/scene_continue/voice_countdown0.wav`, but the pack stages
 * every effect flat under `assets/sounds/`. Effect keys are unique, so
 * flattening loses nothing, and it means a disc never asks a PS2's cdfs to
 * walk a path deeper than the images already do. Music needs no rewrite: it
 * is staged as the `.ogg` the port already asks for.
 */
function adpPath(path: string): string {
  return soundPath(path, ".adp");
}

/**
 * Where the disc carries the music the port just asked for.
 *
 * The port asks for `.ogg`, and AthenaEnv does link libVorbis — but decoding
 * Vorbis happens inside audsrv's fill-buffer callback (`ov_read` in
 * `sound_ogg_fillbuf_handler`), and an Ogg that libvorbis reads perfectly well
 * on a desktop still took the console down the moment the adventure scene
 * started the music. The WAV path's handler is a bare `fread` into audsrv's
 * buffer with no decoder anywhere near it, so the music is staged as WAV and
 * the extension rewritten here.
 */
function wavPath(path: string): string {
  return soundPath(path, ".wav");
}

/**
 * The port's paths are baked into its bundle and name subdirectories the pack
 * does not use, so only the basename is kept.
 */
function soundPath(path: string, extension: string): string {
  const stem = path.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
  return "assets/sounds/" + stem + extension;
}

/**
 * Does this path open at all?
 *
 * It has to be asked before every `Sound.Sfx` and `Sound.Stream`, because
 * AthenaEnv's loaders do not ask. `sound_sfx_load()` runs
 * `fopen(path); fseek(f, 0, SEEK_END);` with no NULL check in between, so a
 * path cdfs cannot open is not an exception this file could catch — it is a
 * null dereference that takes the console down. Same shape in
 * `sound_stream_load()`. One probe up front turns that into silence.
 */
function canOpen(path: string): boolean {
  const std = (globalThis as { std?: QuickJsStd }).std;
  if (!std || typeof std.open !== "function") return true; // nothing to ask
  try {
    const file = std.open(path, "rb");
    if (!file) return false;
    file.close();
    return true;
  } catch {
    return false;
  }
}

/** audsrv's 0-100 from the port's 0..1, when the port bothers to pass one. */
function toAudsrvVolume(volume: number): number {
  return Math.max(0, Math.min(100, Math.round(volume * 100)));
}

/**
 * A SoundPlayer over audsrv, or a silent one when this build has no audio.
 */
export function createAthenaSound(): PumpedSoundPlayer {
  const Sound = (globalThis as { Sound?: AthenaSound }).Sound;

  const silent: PumpedSoundPlayer = {
    init() {},
    loadSfx() {},
    loadStream() {},
    playSfx() {},
    playSound() {},
    playBgm() {},
    stopBgm() {},
    stopAllSounds() {},
    pump() {},
  };
  if (!Sound || typeof Sound.Sfx !== "function") return silent;

  const canStream = typeof Sound.Stream === "function";

  // Keys that failed to load stay out of these, so every play is a lookup that
  // can simply miss. One missing effect never costs more than itself.
  const sfx: Record<string, AthenaSfx> = {};
  const streamPaths: Record<string, string> = {};

  // The one track that is open. `loop` is what tells pump() to restart it;
  // `running` keeps pump() from restarting a track that has not started yet.
  let track: AthenaStream | null = null;
  let trackLoops = false;
  let trackRunning = false;

  // audsrv hands out a free voice per call; pong.js reuses one channel for
  // everything, which cuts the previous effect off. Asking per play lets
  // overlapping shots and explosions actually overlap.
  const channel = (): number => {
    try {
      const ch = Sound.findChannel();
      return typeof ch === "number" && ch >= 0 ? ch : 0;
    } catch {
      return 0;
    }
  };

  const dropTrack = (): void => {
    if (!track) return;
    const going = track;
    track = null;
    trackLoops = false;
    trackRunning = false;
    try {
      going.pause();
      going.free();
    } catch {
      // A decoder that will not shut down cleanly is still one we are done
      // with; holding the reference would only leak it.
    }
  };

  const startTrack = (key: string, loop: boolean, volume?: number): void => {
    const path = streamPaths[key];
    if (!canStream || !path) return;
    dropTrack();
    if (!canOpen(path)) return;
    try {
      const next = Sound.Stream(path);
      if (volume !== undefined && typeof next.volume === "number") {
        next.volume = toAudsrvVolume(volume);
      }
      next.play();
      track = next;
      trackLoops = loop;
      trackRunning = false;
    } catch {
      // Not staged, or not decodable. The game plays on in silence.
    }
  };

  const fireSfx = (key: string, volume?: number): void => {
    const s = sfx[key];
    if (!s) return;
    try {
      if (volume !== undefined && typeof s.volume === "number") {
        s.volume = toAudsrvVolume(volume);
      }
      s.play(channel());
    } catch {
      // A voice that will not start is not worth taking the frame down for.
    }
  };

  return {
    init() {
      try {
        Sound.setVolume(100);
      } catch {
        // Older builds without the setter still play at their default.
      }
    },

    loadSfx(key, path) {
      const file = adpPath(path);
      if (!canOpen(file)) return;
      try {
        sfx[key] = Sound.Sfx(file);
      } catch {
        // Not staged, or not encodable. Stays absent; plays become no-ops.
      }
    },

    // Just the path: nothing is opened until something plays it.
    loadStream(key, path) {
      streamPaths[key] = wavPath(path);
    },

    playSfx: fireSfx,

    // The port fires `bgm_gameover` — a stream — through playSound, so this
    // has to serve both. A track reached this way is a jingle and plays once;
    // only playBgm loops.
    playSound(key, volume) {
      if (streamPaths[key] !== undefined) startTrack(key, false, volume);
      else fireSfx(key, volume);
    },

    playBgm(key, volume) {
      startTrack(key, true, volume);
    },

    stopBgm: dropTrack,

    stopAllSounds() {
      // audsrv exposes no stop for a one-shot voice — they are all short
      // enough to run out — so this is the music and nothing else.
      dropTrack();
    },

    pump() {
      if (!track || !trackLoops) return;
      try {
        if (!trackRunning) {
          // Give the decoder its first frames before believing `playing()`.
          if (track.playing()) trackRunning = true;
          return;
        }
        if (!track.playing()) {
          track.rewind();
          track.play();
        }
      } catch {
        // A stream that cannot be asked about is a stream to stop asking
        // about; leaving it alone is quieter than a throw every frame.
        trackLoops = false;
      }
    },
  };
}
