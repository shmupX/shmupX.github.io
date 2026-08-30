// The game's own audio, rendered as PS2 audio.
//
// Two packs, because audsrv plays the two kinds differently. Effects and
// voices are one-shots, which the SPU2 takes only as PS2 ADPCM (`Sound.Sfx`);
// music is streamed, which AthenaEnv decodes with the libVorbis it links, so
// it stays Ogg (`Sound.Stream`). The ADPCM encoder is ours (adpcm.ts, a
// transliteration of ps2sdk's adpenc); the MP3 decode and the Vorbis encode
// are ffmpeg's, because shipping either codec to run once at build time is not
// a trade worth making. No ffmpeg on the host means no packs and a silent
// export, exactly like a missing SNDPAC.BIN — see findFfmpeg().
//
// Output, mirroring the paths the ps2-sp port asks for:
//
//   assets/sounds/se_shoot.adp
//   assets/sounds/scene_continue/voice_countdown0.adp
//   assets/sounds/boss_sagat_bgm.ogg
//   …
//
// The port calls `loadSfx(key, "assets/sounds/<key>.wav")` and
// `loadStream(key, "assets/sounds/<key>.ogg")` with paths baked into the
// bundle, and those paths do not match the base game's own layout
// (`se_decision` lives in `ui/`, `bgm_continue` in `scene_continue/`). So the
// key lists here are the port's, the search is over the game's tree, and what
// lands on the disc is the port's path — runtime-sound.ts swaps the effects'
// extension to `.adp` and nothing else has to agree.

import { basename, dirname, extname, join } from "@std/path";
import { encodeAdp, fitToHeadroom } from "./adpcm.ts";
import type { StagedFile } from "./assets.ts";

/**
 * Rate the effects are resampled to. The SPU2 tops out at 48 kHz and these are
 * short voice and impact samples that were already lossy at source, so 22.05
 * kHz costs nothing audible and halves the disc space: ADPCM is 16 bytes per
 * 28 samples, i.e. ~12.6 KB per second.
 */
export const SFX_RATE = 22_050;

/**
 * Music is streamed rather than sampled, so it keeps its own rate and both
 * channels: the SPU2 is not decoding it, the EE is.
 */
export const BGM_RATE = 44_100;

/**
 * Vorbis quality for the music. This Homebrew ffmpeg has no libvorbis, so the
 * encoder is ffmpeg's own — weaker at a given bitrate, and behind `-strict -2`.
 * q=3 lands around 117 kbps, which is honest for sources that were already
 * ~128 kbps MP3: q=1 (46 kbps) audibly swims, and q=5 buys nothing a
 * transcode can recover.
 */
export const BGM_QUALITY = 3;

/** Extensions worth looking for, best source first. */
const SOURCE_EXTENSIONS = [".wav", ".mp3", ".ogg"];

/**
 * Every key the ps2-sp port loads, with the path it loads it from. Kept in the
 * order and shape the port builds them so the two lists can be diffed by eye
 * against `loadAllAssets` in @easierbycode/svelte-ps2/ps2-sp.
 */
export function sfxRequests(): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = [];
  const at = (key: string, dir = "") =>
    out.push({
      key,
      path: `assets/sounds/${dir}${key}.wav`,
    });

  for (
    const key of [
      "se_shoot",
      "se_shoot_b",
      "se_explosion",
      "se_damage",
      "se_guard",
      "se_sp",
      "se_sp_explosion",
      "se_barrier_start",
      "se_barrier_end",
      "se_decision",
      "se_correct",
      "se_cursor",
      "se_over",
    ]
  ) at(key);

  for (
    const key of [
      "voice_titlecall",
      "voice_fight",
      "voice_ko",
      "voice_another_fighter",
      "voice_congra",
      "voice_gameover",
      "voice_round0",
      "voice_round1",
      "voice_round2",
      "voice_round3",
      "g_damage_voice",
      "g_powerup_voice",
      "g_sp_voice",
      "g_adbenture_voice0",
      "voice_thankyou",
    ]
  ) at(key);

  for (let i = 0; i <= 9; i++) at(`voice_countdown${i}`, "scene_continue/");
  for (let i = 0; i < 3; i++) at(`g_continue_yes_voice${i}`, "scene_continue/");
  for (let i = 0; i < 2; i++) at(`g_continue_no_voice${i}`, "scene_continue/");
  for (let i = 0; i < 5; i++) at(`g_stage_voice_${i}`, "scene_game/");

  for (
    const boss of ["bison", "barlog", "sagat", "vega", "goki", "fang"]
  ) {
    at(`boss_${boss}_voice_add`);
    at(`boss_${boss}_voice_ko`);
  }
  return out;
}

/**
 * Every music key the port streams. `playBgm` loops these; `playSound` fires
 * one of them (`bgm_gameover`) as a jingle — see runtime-sound.ts.
 */
export function bgmRequests(): { key: string; path: string }[] {
  return [
    "adventure_bgm",
    "boss_bison_bgm",
    "boss_barlog_bgm",
    "boss_sagat_bgm",
    "boss_vega_bgm",
    "boss_goki_bgm",
    "boss_fang_bgm",
    "bgm_continue",
    "bgm_gameover",
  ].map((key) => ({ key, path: `assets/sounds/${key}.ogg` }));
}

export interface SoundPack {
  /** Files to stage on the disc. */
  files: StagedFile[];
  notes: string[];
}

/**
 * ffmpeg, or null. Looked up rather than assumed: it is a build-host tool, not
 * a dependency of this repo, and everything degrades to silence without it.
 */
export async function findFfmpeg(): Promise<string | null> {
  for (
    const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"]
  ) {
    try {
      const cmd = new Deno.Command(candidate, {
        args: ["-version"],
        stdout: "null",
        stderr: "null",
      });
      if ((await cmd.output()).success) return candidate;
    } catch {
      // Not on PATH, or not executable. Try the next one.
    }
  }
  return null;
}

/**
 * Index the game's sound tree by basename. The port's paths and the game's
 * layout disagree, so the only thing they share is the file's own name.
 */
async function indexSources(
  soundsDir: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const rank = (path: string) => {
    const at = SOURCE_EXTENSIONS.indexOf(extname(path).toLowerCase());
    return at === -1 ? SOURCE_EXTENSIONS.length : at;
  };
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.includes(ext)) continue;
      const stem = basename(entry.name, extname(entry.name));
      const have = found.get(stem);
      if (have === undefined || rank(path) < rank(have)) found.set(stem, path);
    }
  };
  try {
    await walk(soundsDir);
  } catch {
    // No sound tree at all; the caller reports it as an empty pack.
  }
  return found;
}

/** Decode anything ffmpeg reads into mono s16 PCM at `SFX_RATE`. */
async function decodeMono(
  ffmpeg: string,
  path: string,
): Promise<Int16Array | null> {
  const cmd = new Deno.Command(ffmpeg, {
    args: [
      "-v",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      String(SFX_RATE),
      "-f",
      "s16le",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success || out.stdout.length < 2) return null;
  // ffmpeg writes native-endian s16le; every host this builds on is LE, and a
  // BE host would produce noise rather than a wrong length, so assert nothing.
  const even = out.stdout.length - (out.stdout.length % 2);
  return new Int16Array(out.stdout.buffer.slice(0, even));
}

/**
 * Encode every effect the port asks for. Returns null when there is no ffmpeg
 * to decode with — the caller then builds silent, as it always could.
 */
export async function buildSfxPack(
  gameDir: string,
  options: { ffmpeg?: string | null } = {},
): Promise<SoundPack | null> {
  const ffmpeg = options.ffmpeg === undefined
    ? await findFfmpeg()
    : options.ffmpeg;
  if (!ffmpeg) return null;

  const sources = await indexSources(join(gameDir, "assets", "sounds"));
  const files: StagedFile[] = [];
  const missing: string[] = [];
  let bytes = 0;
  let seconds = 0;
  let attenuated = 0;

  for (const { key, path } of sfxRequests()) {
    const source = sources.get(key);
    if (!source) {
      missing.push(key);
      continue;
    }
    const pcm = await decodeMono(ffmpeg, source);
    if (!pcm) {
      missing.push(key);
      continue;
    }
    const fitted = fitToHeadroom(pcm);
    if (fitted.scale !== 1) attenuated++;
    const adp = encodeAdp(fitted.pcm, { rate: SFX_RATE });
    bytes += adp.length;
    seconds += pcm.length / SFX_RATE;
    files.push({
      path: `${dirname(path)}/${key}.adp`,
      data: adp,
    });
  }

  const notes = [
    `sound effects: ${files.length} of ${sfxRequests().length} keys, ${
      seconds.toFixed(0)
    }s as ${(bytes / 1024).toFixed(0)} KB of ADPCM`,
  ];
  if (attenuated) {
    notes.push(
      `sound effects: ${attenuated} pulled under the SPU2 encoder's headroom`,
    );
  }
  if (missing.length) {
    notes.push(
      `sound effects: no source for ${missing.length} key(s) — ${
        missing.slice(0, 4).join(", ")
      }${missing.length > 4 ? ", …" : ""}`,
    );
  }
  return { files, notes };
}

/** Transcode to the Ogg Vorbis AthenaEnv's streamer decodes. */
async function encodeOgg(
  ffmpeg: string,
  path: string,
): Promise<Uint8Array | null> {
  const cmd = new Deno.Command(ffmpeg, {
    args: [
      "-v",
      "error",
      "-i",
      path,
      "-c:a",
      "vorbis",
      // ffmpeg's own Vorbis encoder is marked experimental; it is the only one
      // in this build, and libVorbis on the console decodes what it writes.
      "-strict",
      "-2",
      "-q:a",
      String(BGM_QUALITY),
      "-ar",
      String(BGM_RATE),
      "-ac",
      "2",
      "-f",
      "ogg",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  // Ogg is a streaming container, so this comes back down the pipe whole.
  if (!out.success || out.stdout.length < 4) return null;
  return out.stdout;
}

/**
 * Transcode the music. Separate from the effects because it is streamed, not
 * sampled: it stays compressed, keeps both channels, and is decoded on the EE.
 */
export async function buildBgmPack(
  gameDir: string,
  options: { ffmpeg?: string | null } = {},
): Promise<SoundPack | null> {
  const ffmpeg = options.ffmpeg === undefined
    ? await findFfmpeg()
    : options.ffmpeg;
  if (!ffmpeg) return null;

  const sources = await indexSources(join(gameDir, "assets", "sounds"));
  const files: StagedFile[] = [];
  const missing: string[] = [];
  let bytes = 0;

  for (const { key, path } of bgmRequests()) {
    const source = sources.get(key);
    if (!source) {
      missing.push(key);
      continue;
    }
    const ogg = await encodeOgg(ffmpeg, source);
    if (!ogg) {
      missing.push(key);
      continue;
    }
    bytes += ogg.length;
    files.push({ path, data: ogg });
  }

  const notes = [
    `music: ${files.length} of ${bgmRequests().length} tracks, ${
      (bytes / 1048576).toFixed(1)
    } MB of Vorbis`,
  ];
  if (missing.length) {
    notes.push(`music: no source for ${missing.join(", ")}`);
  }
  return { files, notes };
}
